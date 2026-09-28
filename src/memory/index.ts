import type {
  Embedder,
  EmbeddingSpace,
  LanguageModel,
  NoteStore,
  SearchResult,
} from 'agentic-memory';
import { messageOf } from '../result.js';
import { writeJsonFile } from './files.js';
import type { JsonValue } from './json.js';
import { acquireWriterLock } from './lock.js';
import { defaultMemoryProviders } from './providers.js';
import { composeRetrievalBlock, type RetrievalCandidate } from './recall.js';
import { createReceiptStore, type Receipt, type ReceiptStore } from './receipts.js';

/**
 * Memory makes experience from completed hand-offs available to later agent invocations. It owns
 * bounded retrieval, context presentation, ingestion receipts and the coordination of writes, and
 * it consumes the public exports of the standalone agentic-memory package through its provider
 * contracts. Memory supplements the current request and its direct artifacts; it decides no
 * workflow outcome, and every failure is an explicit result the caller reports without changing
 * the business outcome it accompanies.
 */

/** The identity of the agent work one invocation belongs to, used as retrieval scope. */
export type RecallScope = {
  readonly project: string;
  readonly workflow: string;
  readonly role: string;
};

/** One caller-prepared retrieval: its invocation identity, query and evidence location. */
export type RecallRequest = {
  /** The invocation's caller-assigned identity; the evidence file is named after it. */
  readonly invocationId: string;
  /** The deterministic query the caller prepared from current information. */
  readonly query: string;
  /** The absolute retrieval-evidence file the caller supplies for this invocation. */
  readonly evidenceFile: string;
  readonly scope: RecallScope;
};

/** What one recall supplied: the block, an explicit empty result, or no capability. */
export type RecallResult =
  | { readonly kind: 'context'; readonly context: string; readonly evidenceFile: string }
  | { readonly kind: 'empty'; readonly evidenceFile: string }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** One explicit source observation the integration mapping extracted. */
export type Observation = {
  /** The stable source key: artifact path, observation selector and content digest. */
  readonly sourceKey: string;
  /** The observation's content, including the source envelope and referenced material. */
  readonly content: string;
  /** The observation time, or absent to fix it at first capture. */
  readonly timestamp?: string;
  /** Project, issue, workflow, role, artifact, element and iteration provenance. */
  readonly provenance: Readonly<Record<string, JsonValue>>;
};

/** What one remembered observation observed. Never an uncertain write reported as success. */
export type RememberResult =
  | {
      readonly kind: 'stored';
      readonly noteId: string;
      readonly receipt: string;
    }
  | {
      readonly kind: 'already-recorded';
      readonly noteId: string;
      readonly receipt: string;
    }
  | { readonly kind: 'deferred'; readonly receipt: string; readonly reason: string }
  | {
      readonly kind: 'uncertain';
      readonly receipt: string;
      readonly reason: string;
      readonly noteId: string | null;
      readonly affectedNoteIds: readonly string[];
    }
  | { readonly kind: 'failed'; readonly receipt: string | null; readonly reason: string }
  | { readonly kind: 'disabled' };

/** The Memory capability: bounded recall, explicit observation and lifecycle settlement. */
export type Memory = {
  recall(request: RecallRequest): Promise<RecallResult>;
  remember(observation: Observation): Promise<RememberResult>;
  /** Settle active operations and release owned resources. */
  close(): Promise<void>;
};

/** The embedding cache and download permission the pinned reference encoder uses. */
export type MemoryEmbeddingSettings = {
  readonly cacheDir: string;
  readonly allowDownloads: boolean;
};

/** The Qdrant endpoint, collection and declared embedding space of one note store. */
export type MemoryStoreSettings = {
  readonly url: string;
  readonly collection: string;
  readonly apiKey?: string;
  readonly space: EmbeddingSpace;
  readonly timeoutMs: number;
};

/** The explicit model endpoint, provider model, credential, output bound and timeout. */
export type MemoryModelSettings = {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
};

/** One engine insertion request: the remembered content, its time and its provenance. */
export type MemoryEngineAddInput = {
  readonly content: string;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
};

/** What one engine insertion observed, classified by the package's persistence contract. */
export type MemoryEngineAddResult =
  | { readonly kind: 'stored'; readonly noteId: string }
  | { readonly kind: 'unchanged-failure'; readonly stage: string; readonly reason: string }
  | {
      readonly kind: 'uncertain';
      readonly stage: string;
      readonly reason: string;
      readonly noteId: string | null;
      readonly affectedNoteIds: readonly string[];
    };

/** The package-backed engine boundary Memory uses; providers supply the implementations. */
export type MemoryEngine = {
  add(input: MemoryEngineAddInput): Promise<MemoryEngineAddResult>;
  search(
    query: string,
    options: { readonly limit: number; readonly linkedLimit: number },
  ): Promise<SearchResult[]>;
};

/** The provider construction Memory composes; tests substitute controlled providers. */
export type MemoryProviders = {
  openEmbedder(settings: MemoryEmbeddingSettings): Promise<Embedder>;
  openNoteStore(settings: MemoryStoreSettings): Promise<NoteStore>;
  createLanguageModel(settings: MemoryModelSettings): LanguageModel;
  createEngine(settings: {
    readonly store: NoteStore;
    readonly embedder: Embedder;
    readonly model: LanguageModel;
    readonly neighbors: number;
  }): Promise<MemoryEngine>;
};

/** Resolved Memory settings: Nexus configuration with its credential references resolved. */
export type MemorySettings = {
  readonly storeId: string;
  /** The Nexus storage root; receipts and writer coordination live under its memory directory. */
  readonly storageRoot: string;
  readonly qdrant: {
    readonly url: string;
    readonly collection: string;
    readonly apiKey?: string;
  };
  readonly embedding: MemoryEmbeddingSettings;
  readonly model: {
    readonly endpoint: string;
    readonly model: string;
    readonly apiKey?: string;
  };
  readonly neighbors: number;
  readonly searchLimit: number;
  readonly linkedLimit: number;
  readonly contextMaxChars: number;
  readonly lockWaitMs: number;
  readonly providerTimeoutMs: number;
  readonly modelMaxOutputTokens: number;
  /** The provider construction; omitted uses the standalone package and the host transport. */
  readonly providers?: Partial<MemoryProviders>;
  /** The clock retrieval evidence and receipt timestamps come from. */
  readonly now?: () => Date;
};

/** One invocation's saved retrieval evidence: what was searched, returned and actually supplied. */
type RetrievalEvidence = {
  readonly invocationId: string;
  readonly scope: RecallScope;
  readonly query: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly route: 'direct' | 'direct-and-linked';
  readonly outcome: 'context' | 'empty' | 'unavailable';
  readonly reason: string | null;
  readonly candidates: readonly RetrievalCandidate[];
  readonly included: readonly string[];
  readonly omitted: readonly string[];
  readonly block: string | null;
};

/** A memory that performs nothing: disabled Memory makes no provider call and writes nothing. */
export function disabledMemory(): Memory {
  return {
    recall: () => Promise.resolve({ kind: 'disabled' }),
    remember: () => Promise.resolve({ kind: 'disabled' }),
    close: () => Promise.resolve(),
  };
}

/**
 * A memory whose providers are not usable. Every call reports the reason; business actions
 * continue without supplemental context. An observation it receives is still captured as a
 * pending receipt when a receipt store is supplied, so a hand-off produced while the providers are
 * unavailable survives with its snapshot and its failed disposition instead of being lost.
 */
export function unavailableMemory(reason: string, capture?: ReceiptStore): Memory {
  return {
    recall: () => Promise.resolve({ kind: 'unavailable', reason }),
    async remember(observation) {
      if (capture === undefined) {
        return { kind: 'failed', receipt: null, reason };
      }
      const timestamp = new Date().toISOString();
      try {
        const receipt = await capture.createIfAbsent({
          sourceKey: observation.sourceKey,
          content: observation.content,
          timestamp: observation.timestamp ?? timestamp,
          provenance: observation.provenance,
          state: 'pending',
          updatedAt: timestamp,
        });
        return { kind: 'failed', receipt: capture.fileOf(receipt.sourceKey), reason };
      } catch (error) {
        return {
          kind: 'failed',
          receipt: null,
          reason: `${reason}; the observation could not be captured: ${messageOf(error)}`,
        };
      }
    },
    close: () => Promise.resolve(),
  };
}

/** The configured providers with the supplied substitutions applied. */
function resolveProviders(overrides: Partial<MemoryProviders> | undefined): MemoryProviders {
  return {
    openEmbedder: overrides?.openEmbedder ?? defaultMemoryProviders.openEmbedder,
    openNoteStore: overrides?.openNoteStore ?? defaultMemoryProviders.openNoteStore,
    createLanguageModel:
      overrides?.createLanguageModel ?? defaultMemoryProviders.createLanguageModel,
    createEngine: overrides?.createEngine ?? defaultMemoryProviders.createEngine,
  };
}

/**
 * Construct Memory from resolved settings. Provider initialization happens here, only when the
 * integration is enabled; a failure rejects so the caller reports the unavailability and runs the
 * workflow without memory. The declared store identity binding is verified before any write.
 */
export async function createMemory(settings: MemorySettings): Promise<Memory> {
  try {
    return await createAvailableMemory(settings);
  } catch (error) {
    // Initialization errors cross into Application diagnostics and the unavailable fallback.
    // Never propagate the raw provider error (including its cause) across that boundary.
    // eslint-disable-next-line preserve-caught-error -- The cause may contain provider credentials.
    throw new Error(safeMemoryReason(error, settings));
  }
}

/** Remove both provider credentials before normalizing or bounding a failure diagnostic. */
function safeMemoryReason(error: unknown, settings: MemorySettings): string {
  let text = messageOf(error);
  for (const secret of [settings.qdrant.apiKey, settings.model.apiKey]) {
    if (secret !== undefined && secret !== '') {
      text = text
        .replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]')
        .replaceAll(secret, '[redacted]');
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** Initialize the providers and expose operations with safe failure diagnostics. */
async function createAvailableMemory(settings: MemorySettings): Promise<Memory> {
  const providers = resolveProviders(settings.providers);
  const store = createReceiptStore({ root: settings.storageRoot, storeId: settings.storeId });
  await store.ensureBinding({
    url: settings.qdrant.url,
    collection: settings.qdrant.collection,
  });
  const embedder = await providers.openEmbedder(settings.embedding);
  const noteStore = await providers.openNoteStore({
    url: settings.qdrant.url,
    collection: settings.qdrant.collection,
    ...(settings.qdrant.apiKey === undefined ? {} : { apiKey: settings.qdrant.apiKey }),
    space: embedder.space,
    timeoutMs: settings.providerTimeoutMs,
  });
  const model = providers.createLanguageModel({
    endpoint: settings.model.endpoint,
    model: settings.model.model,
    ...(settings.model.apiKey === undefined ? {} : { apiKey: settings.model.apiKey }),
    maxOutputTokens: settings.modelMaxOutputTokens,
    timeoutMs: settings.providerTimeoutMs,
  });
  const engine = await providers.createEngine({
    store: noteStore,
    embedder,
    model,
    neighbors: settings.neighbors,
  });

  const now = settings.now ?? (() => new Date());
  const active = new Set<Promise<unknown>>();
  const safeReason = (error: unknown): string => safeMemoryReason(error, settings);

  /** Run one operation while `close` waits for it. */
  async function track<Value>(operation: () => Promise<Value>): Promise<Value> {
    const pending = operation();
    active.add(pending);
    try {
      return await pending;
    } finally {
      active.delete(pending);
    }
  }

  /** Save one invocation's retrieval evidence, reporting a failure as an unavailable recall. */
  async function writeRetrievalEvidence(
    request: RecallRequest,
    evidence: RetrievalEvidence,
  ): Promise<void> {
    try {
      await writeJsonFile(request.evidenceFile, evidence);
    } catch {
      // The failure that made the retrieval unavailable is the reported reason; a further failure
      // to save evidence changes nothing about the agent's continuation without memory.
    }
  }

  return {
    recall: (request) => track(() => recall(request)),
    remember: (observation) => track(() => remember(observation)),
    async close() {
      while (active.size > 0) {
        await Promise.allSettled([...active]);
      }
    },
  };

  /** One bounded retrieval: search, compose the block, and save its evidence. */
  async function recall(request: RecallRequest): Promise<RecallResult> {
    const startedAt = now();
    const route = settings.linkedLimit === 0 ? 'direct' : 'direct-and-linked';
    let results: SearchResult[];
    try {
      results = await engine.search(request.query, {
        limit: settings.searchLimit,
        linkedLimit: settings.linkedLimit,
      });
    } catch (error) {
      const reason = safeReason(error);
      await writeRetrievalEvidence(request, {
        invocationId: request.invocationId,
        scope: request.scope,
        query: request.query,
        startedAt: startedAt.toISOString(),
        durationMs: now().getTime() - startedAt.getTime(),
        route,
        outcome: 'unavailable',
        reason,
        candidates: [],
        included: [],
        omitted: [],
        block: null,
      });
      return { kind: 'unavailable', reason };
    }

    const composed = composeRetrievalBlock(results, settings.contextMaxChars);
    const evidence: RetrievalEvidence = {
      invocationId: request.invocationId,
      scope: request.scope,
      query: request.query,
      startedAt: startedAt.toISOString(),
      durationMs: now().getTime() - startedAt.getTime(),
      route,
      outcome: composed.block === null ? 'empty' : 'context',
      reason: null,
      candidates: composed.candidates,
      included: composed.candidates.filter((entry) => entry.included).map((entry) => entry.noteId),
      omitted: composed.candidates.filter((entry) => !entry.included).map((entry) => entry.noteId),
      block: composed.block,
    };
    try {
      await writeJsonFile(request.evidenceFile, evidence);
    } catch (error) {
      // A block whose evidence cannot be saved is not supplied: the agent runs without memory.
      return {
        kind: 'unavailable',
        reason: `the retrieval evidence could not be saved: ${safeReason(error)}`,
      };
    }
    return composed.block === null
      ? { kind: 'empty', evidenceFile: request.evidenceFile }
      : { kind: 'context', context: composed.block, evidenceFile: request.evidenceFile };
  }

  /** One explicit observation: capture it, insert it at most once and keep its receipt. */
  async function remember(observation: Observation): Promise<RememberResult> {
    const timestamp = now();
    const captured: Receipt = {
      sourceKey: observation.sourceKey,
      content: observation.content,
      timestamp: observation.timestamp ?? timestamp.toISOString(),
      provenance: observation.provenance,
      state: 'pending',
      updatedAt: timestamp.toISOString(),
    };
    // The source observation is captured before the lock, so contention leaves a pending
    // observation a later attempt observes instead of losing it.
    try {
      await store.createIfAbsent(captured);
    } catch (error) {
      return { kind: 'failed', receipt: null, reason: safeReason(error) };
    }
    const receiptFile = store.fileOf(observation.sourceKey);

    const acquisition = await acquireWriterLock(store.lockFile, settings.lockWaitMs);
    if (acquisition.kind === 'contended') {
      return {
        kind: 'deferred',
        receipt: receiptFile,
        reason:
          'another insertion holds the collection writer lock; the pending observation stays ' +
          'for the next attempt',
      };
    }
    if (acquisition.kind === 'unavailable') {
      return { kind: 'failed', receipt: receiptFile, reason: acquisition.reason };
    }

    try {
      const current = await store.read(observation.sourceKey);
      if (current === null) {
        return {
          kind: 'failed',
          receipt: receiptFile,
          reason: 'the captured source observation disappeared before insertion',
        };
      }
      if (current.state === 'stored') {
        return {
          kind: 'already-recorded',
          noteId: current.noteId ?? '',
          receipt: receiptFile,
        };
      }
      if (current.state === 'uncertain') {
        return {
          kind: 'uncertain',
          receipt: receiptFile,
          reason: current.reason ?? 'a previous attempt left an uncertain outcome',
          noteId: current.noteId ?? null,
          affectedNoteIds: current.affectedNoteIds ?? [],
        };
      }
      if (current.state === 'in-flight') {
        // An in-flight receipt surviving its owning operation is uncertain: the crash may have
        // happened after storage but before the success receipt was saved.
        const uncertain: Receipt = {
          ...current,
          state: 'uncertain',
          reason:
            'an interrupted insertion left this observation in flight; its outcome is ' +
            'uncertain and it is not repeated automatically',
          updatedAt: now().toISOString(),
        };
        // The uncertain receipt is itself the collection's unresolved insertion, so persisting it
        // is what makes every other source's later write defer until reconciliation.
        await store.write(uncertain);
        return {
          kind: 'uncertain',
          receipt: receiptFile,
          reason: uncertain.reason ?? 'an interrupted insertion is uncertain',
          noteId: uncertain.noteId ?? null,
          affectedNoteIds: uncertain.affectedNoteIds ?? [],
        };
      }
      // Any other collection write stays deferred while an unresolved insertion — this
      // collection's in-flight or uncertain receipt — remains; this pending observation is
      // preserved for after the operator reconciles that receipt.
      const unresolved = await store.readUnresolved();
      if (unresolved !== null && unresolved.sourceKey !== current.sourceKey) {
        return {
          kind: 'deferred',
          receipt: receiptFile,
          reason:
            `the collection defers further writes until the unresolved insertion at ` +
            `"${unresolved.receipt}" is reconciled: ${unresolved.reason}`,
        };
      }

      await store.write({
        ...current,
        state: 'in-flight',
        updatedAt: now().toISOString(),
      });
      const result = await engine.add({
        content: current.content,
        timestamp: current.timestamp,
        metadata: { sourceKey: current.sourceKey, provenance: current.provenance },
      });
      if (result.kind === 'stored') {
        await store.write({
          ...current,
          state: 'stored',
          noteId: result.noteId,
          updatedAt: now().toISOString(),
        });
        return { kind: 'stored', noteId: result.noteId, receipt: receiptFile };
      }
      if (result.kind === 'uncertain') {
        await store.write({
          ...current,
          state: 'uncertain',
          stage: result.stage,
          reason: safeReason(result.reason),
          ...(result.noteId === null ? {} : { noteId: result.noteId }),
          ...(result.affectedNoteIds.length === 0
            ? {}
            : { affectedNoteIds: [...result.affectedNoteIds] }),
          updatedAt: now().toISOString(),
        });
        return {
          kind: 'uncertain',
          receipt: receiptFile,
          reason: safeReason(result.reason),
          noteId: result.noteId,
          affectedNoteIds: result.affectedNoteIds,
        };
      }
      // A known unchanged failure returns the observation to pending with its stage and reason,
      // so re-observing that hand-off may try it again.
      await store.write({
        ...current,
        state: 'pending',
        stage: result.stage,
        reason: safeReason(result.reason),
        updatedAt: now().toISOString(),
      });
      return { kind: 'failed', receipt: receiptFile, reason: safeReason(result.reason) };
    } catch (error) {
      return { kind: 'failed', receipt: receiptFile, reason: safeReason(error) };
    } finally {
      await acquisition.lock.release();
    }
  }
}

export { canonicalJson, type JsonValue, jsonValueSchema } from './json.js';
export { defaultMemoryProviders } from './providers.js';
export { retrievalFraming } from './recall.js';
export {
  createReceiptStore,
  receiptStates,
  type Receipt,
  type ReceiptState,
  type ReceiptStore,
  type UnresolvedWrite,
} from './receipts.js';
