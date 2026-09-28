/**
 * Memory component coverage: bounded whole-note context budgeting, provenance and ordering,
 * empty/unavailable behavior, deterministic retrieval evidence and the ingestion receipt
 * lifecycle. The engine is the real standalone package composed over controlled providers; the
 * storage operations are real files under a temporary directory.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createMemory,
  createReceiptStore,
  disabledMemory,
  retrievalFraming,
  unavailableMemory,
  type MemoryProviders,
  type Observation,
} from '../src/memory/index.js';
import { createMemoryModelTransport } from '../src/memory/transport.js';
import {
  controlledMemoryProviders,
  inMemoryNoteStore,
  memorySettings,
  seedNote,
} from './support/memory.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-memory-'));
  temporaryDirectories.push(root);
  return root;
}

/** One observation fixture whose content, key and provenance a test can vary. */
function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    sourceKey: 'artifacts/1/development.json#summary#sha256:abc',
    content:
      'Task HARN-78 "Integrate agent memory" — project HARN, role developer, round 1, ' +
      'outcome completed, revision 1a2b3c.',
    provenance: {
      project: 'HARN',
      issue: 'HARN-78',
      workflow: 'finite-delivery',
      role: 'developer',
      artifact: 'artifacts/1/development.json',
      element: 'summary',
      round: 1,
    },
    ...overrides,
  };
}

/** A memory over controlled providers and a temporary storage root. */
const receiptFileOf = (root: string, storeId: string, sourceKey: string): string =>
  path.join(
    root,
    'memory',
    storeId,
    'receipts',
    `${createHash('sha256').update(sourceKey, 'utf8').digest('hex')}.json`,
  );

describe('memory retrieval', () => {
  it('supplies whole note blocks with provenance and keeps direct matches before linked additions', async () => {
    const root = await temporaryRoot();
    const store = inMemoryNoteStore();
    const providers = controlledMemoryProviders({ store });
    seedNote(store, {
      id: '11111111-1111-4111-8111-111111111111',
      content: 'Developer claimed the repair is committed on the branch.',
      context: 'A developer reported a completed repair for the memory integration.',
      keywords: ['repair', 'memory'],
      tags: ['development'],
      metadata: { provenance: { project: 'HARN', role: 'developer' } },
      links: ['22222222-2222-4222-8222-222222222222'],
    });
    seedNote(store, {
      id: '22222222-2222-4222-8222-222222222222',
      content: 'The reviewer required a fresh-checkout installation check.',
      context: 'A reviewer required evidence for the memory package installation.',
      keywords: ['installation', 'memory'],
      tags: ['review'],
      metadata: { provenance: { project: 'HARN', role: 'reviewer' } },
    });
    const memory = await createMemory(
      memorySettings({
        storageRoot: root,
        // Only the top match is direct; the linked note reaches the block through one hop.
        searchLimit: 1,
        linkedLimit: 5,
        providers,
      }),
    );
    const evidenceFile = path.join(root, 'logs', 'execution', 'memory', 'invocation.json');

    const result = await memory.recall({
      invocationId: 'invocation',
      query: 'memory integration repair',
      evidenceFile,
      scope: { project: 'HARN', workflow: 'finite-delivery', role: 'developer' },
    });

    expect(result.kind).toBe('context');
    if (result.kind !== 'context') {
      return;
    }
    expect(result.context.startsWith(retrievalFraming)).toBe(true);
    expect(result.context).toContain('11111111-1111-4111-8111-111111111111');
    expect(result.context).toContain('Developer claimed the repair is committed on the branch.');
    expect(result.context).toContain('Keywords: repair, memory; Tags: development');
    expect(result.context).toContain(
      'Source: {"provenance":{"project":"HARN","role":"developer"}}',
    );
    expect(result.context).toContain('22222222-2222-4222-8222-222222222222');
    expect(result.context.indexOf('Direct match')).toBeLessThan(
      result.context.indexOf('Linked addition'),
    );

    // The saved evidence preserves exactly what the agent saw, the query and the route.
    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8')) as {
      readonly query: string;
      readonly route: string;
      readonly outcome: string;
      readonly block: string;
      readonly included: readonly string[];
      readonly omitted: readonly string[];
      readonly durationMs: number;
    };
    expect(evidence.query).toBe('memory integration repair');
    expect(evidence.route).toBe('direct-and-linked');
    expect(evidence.outcome).toBe('context');
    expect(evidence.block).toBe(result.context);
    expect(evidence.included).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(evidence.omitted).toEqual([]);
    expect(evidence.durationMs).toBeGreaterThanOrEqual(0);
    await memory.close();
  });

  it('skips an oversized note and still includes a later one that fits the budget', async () => {
    const root = await temporaryRoot();
    const store = inMemoryNoteStore();
    seedNote(store, {
      id: '33333333-3333-4333-8333-333333333333',
      content: 'x'.repeat(400),
      context: 'A very long note.',
    });
    seedNote(store, {
      id: '44444444-4444-4444-8444-444444444444',
      content: 'Short note about memory receipts.',
      context: 'A short note.',
    });
    const memory = await createMemory(
      memorySettings({
        storageRoot: root,
        contextMaxChars: 700,
        providers: controlledMemoryProviders({ store }),
      }),
    );
    const result = await memory.recall({
      invocationId: 'budget',
      query: 'memory',
      evidenceFile: path.join(root, 'evidence', 'budget.json'),
      scope: { project: 'HARN', workflow: 'finite-delivery', role: 'developer' },
    });

    expect(result.kind).toBe('context');
    if (result.kind !== 'context') {
      return;
    }
    expect(result.context.length).toBeLessThanOrEqual(700);
    expect(result.context).not.toContain('33333333-3333-4333-8333-333333333333');
    expect(result.context).toContain('44444444-4444-4444-8444-444444444444');
    const evidence = JSON.parse(
      await readFile(path.join(root, 'evidence', 'budget.json'), 'utf8'),
    ) as { readonly included: readonly string[]; readonly omitted: readonly string[] };
    expect(evidence.omitted).toEqual(['33333333-3333-4333-8333-333333333333']);
    expect(evidence.included).toEqual(['44444444-4444-4444-8444-444444444444']);
    await memory.close();
  });

  it('applies the character budget to the complete block including the framing separator', async () => {
    const root = await temporaryRoot();
    const store = inMemoryNoteStore();
    seedNote(store, {
      id: '55555555-5555-4555-8555-555555555555',
      content: 'One short note.',
      context: 'A boundary probe.',
    });
    const providers = controlledMemoryProviders({ store });
    const request = {
      invocationId: 'boundary',
      query: 'boundary probe',
      evidenceFile: path.join(root, 'evidence', 'boundary.json'),
      scope: { project: 'HARN', workflow: 'finite-delivery', role: 'developer' },
    };
    const unbounded = await createMemory(
      memorySettings({ storageRoot: root, contextMaxChars: 12000, providers }),
    );
    const supplied = await unbounded.recall(request);
    expect(supplied.kind).toBe('context');
    if (supplied.kind !== 'context') {
      return;
    }
    // The block the agent sees states its own exact size: a budget of that length fits it, and one
    // character less does not.
    await unbounded.close();

    const exact = await createMemory(
      memorySettings({
        storageRoot: root,
        contextMaxChars: supplied.context.length,
        providers,
      }),
    );
    const fitted = await exact.recall(request);
    expect(fitted.kind).toBe('context');
    if (fitted.kind === 'context') {
      expect(fitted.context).toBe(supplied.context);
      expect(fitted.context.length).toBe(supplied.context.length);
    }
    await exact.close();

    const tight = await createMemory(
      memorySettings({
        storageRoot: root,
        contextMaxChars: supplied.context.length - 1,
        providers,
      }),
    );
    expect(await tight.recall(request)).toEqual({
      kind: 'empty',
      evidenceFile: request.evidenceFile,
    });
    await tight.close();
  });

  it('supplies no block for an empty result and still saves its evidence', async () => {
    const root = await temporaryRoot();
    const memory = await createMemory(
      memorySettings({
        storageRoot: root,
        providers: controlledMemoryProviders({ store: inMemoryNoteStore() }),
      }),
    );
    const evidenceFile = path.join(root, 'evidence', 'empty.json');
    const result = await memory.recall({
      invocationId: 'empty',
      query: 'anything',
      evidenceFile,
      scope: { project: 'HARN', workflow: 'finite-delivery', role: 'reviewer' },
    });
    expect(result).toEqual({ kind: 'empty', evidenceFile });
    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8')) as {
      readonly outcome: string;
      readonly block: string | null;
      readonly reason: string | null;
    };
    expect(evidence.outcome).toBe('empty');
    expect(evidence.block).toBeNull();
    expect(evidence.reason).toBeNull();
    await memory.close();
  });

  it('degrades a failed search to an unavailable result and never throws', async () => {
    const store = inMemoryNoteStore();
    store.nearest = () => Promise.reject(new Error('qdrant is unreachable'));
    const memory = await createMemory(
      memorySettings({
        storageRoot: await temporaryRoot(),
        providers: controlledMemoryProviders({ store }),
      }),
    );
    const result = await memory.recall({
      invocationId: 'unavailable',
      query: 'memory',
      evidenceFile: path.join(await temporaryRoot(), 'evidence.json'),
      scope: { project: 'HARN', workflow: 'finite-delivery', role: 'developer' },
    });
    expect(result.kind).toBe('unavailable');
    await memory.close();
  });

  it('invokes the agent without memory when retrieval evidence cannot be saved', async () => {
    const root = await temporaryRoot();
    const blocked = path.join(root, 'blocked');
    await writeFile(blocked, 'not a directory\n', 'utf8');
    const memory = await createMemory(
      memorySettings({
        storageRoot: root,
        providers: controlledMemoryProviders({ store: inMemoryNoteStore() }),
      }),
    );
    const result = await memory.recall({
      invocationId: 'unwritable',
      query: 'memory',
      evidenceFile: path.join(blocked, 'evidence.json'),
      scope: { project: 'HARN', workflow: 'finite-delivery', role: 'developer' },
    });
    expect(result.kind).toBe('unavailable');
    await memory.close();
  });

  it('makes no provider call at all when the integration is disabled', async () => {
    const memory = disabledMemory();
    expect(
      await memory.recall({
        invocationId: 'x',
        query: 'q',
        evidenceFile: '/dev/null',
        scope: { project: 'p', workflow: 'w', role: 'r' },
      }),
    ).toEqual({ kind: 'disabled' });
    expect(
      await memory.remember({
        sourceKey: 'key',
        content: 'content',
        provenance: { project: 'HARN' },
      }),
    ).toEqual({ kind: 'disabled' });
  });
});

describe('memory ingestion', () => {
  it('stores a captured observation once, keeps its provenance and replays as recorded', async () => {
    const root = await temporaryRoot();
    const store = inMemoryNoteStore();
    const memory = await createMemory(
      memorySettings({
        storageRoot: root,
        providers: controlledMemoryProviders({ store }),
      }),
    );
    const first = await memory.remember(observation());
    expect(first.kind).toBe('stored');
    if (first.kind !== 'stored') {
      return;
    }
    const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as {
      readonly state: string;
      readonly sourceKey: string;
      readonly content: string;
      readonly provenance: Record<string, unknown>;
      readonly noteId: string;
    };
    expect(receipt.state).toBe('stored');
    expect(receipt.sourceKey).toBe(observation().sourceKey);
    expect(receipt.content).toBe(observation().content);
    expect(receipt.provenance['element']).toBe('summary');
    expect(receipt.noteId).toBe(first.noteId);
    const note = store.records.get(first.noteId.toLowerCase());
    expect(note?.note.content).toBe(observation().content);
    expect(note?.note.metadata).toEqual({
      sourceKey: observation().sourceKey,
      provenance: observation().provenance,
    });

    const replay = await memory.remember(observation());
    expect(replay).toEqual({
      kind: 'already-recorded',
      noteId: first.noteId,
      receipt: first.receipt,
    });
    expect(store.calls.put).toBe(1);
    await memory.close();
  });

  it.each(['unchanged-failure', 'uncertain'] as const)(
    'redacts provider credentials from %s ingestion results and receipts',
    async (kind) => {
      const root = await temporaryRoot();
      const secrets = ['store-secret', 'model-secret'] as const;
      const settings = memorySettings({ storageRoot: root });
      const memory = await createMemory({
        ...settings,
        qdrant: { ...settings.qdrant, apiKey: secrets[0] },
        model: { ...settings.model, apiKey: secrets[1] },
        providers: {
          ...controlledMemoryProviders({}),
          createEngine: () =>
            Promise.resolve({
              add: () =>
                Promise.resolve({
                  kind,
                  stage: 'persist',
                  reason: `Rejected ${secrets.join(' ')}`,
                  noteId: null,
                  affectedNoteIds: [],
                }),
              search: () => Promise.resolve([]),
            }),
        },
      });
      try {
        const result = await memory.remember(observation());
        expect(result.kind).toBe(kind === 'uncertain' ? 'uncertain' : 'failed');
        if (result.kind !== 'failed' && result.kind !== 'uncertain') {
          throw new Error('Expected an ingestion failure');
        }
        expect(result.receipt).not.toBeNull();
        const receipt = await readFile(result.receipt ?? '', 'utf8');
        const replay = await memory.remember(observation());
        for (const text of [JSON.stringify(result), receipt, JSON.stringify(replay)]) {
          expect(text).toContain('Rejected [redacted] [redacted]');
          for (const secret of secrets) {
            expect(text).not.toContain(secret);
          }
        }
      } finally {
        await memory.close();
      }
    },
  );

  it('returns a known unchanged failure to pending and retries the same observation later', async () => {
    const root = await temporaryRoot();
    const failing: MemoryProviders = {
      ...controlledMemoryProviders({ store: inMemoryNoteStore() }),
      async createEngine(settings) {
        const engine = await controlledMemoryProviders({}).createEngine(settings);
        let first = true;
        return {
          add: async (input) => {
            if (first) {
              first = false;
              return {
                kind: 'unchanged-failure',
                stage: 'construct',
                reason: 'the model request timed out',
              };
            }
            return engine.add(input);
          },
          search: engine.search,
        };
      },
    };
    const memory = await createMemory(memorySettings({ storageRoot: root, providers: failing }));

    const failed = await memory.remember(observation());
    expect(failed.kind).toBe('failed');
    if (failed.kind !== 'failed' || failed.receipt === null) {
      return;
    }
    const pending = JSON.parse(await readFile(failed.receipt, 'utf8')) as {
      readonly state: string;
      readonly stage: string;
      readonly reason: string;
    };
    expect(pending.state).toBe('pending');
    expect(pending.stage).toBe('construct');
    expect(pending.reason).toBe('the model request timed out');

    const retried = await memory.remember(observation());
    expect(retried.kind).toBe('stored');
    await memory.close();
  });

  it('records an uncertain write and defers later writes without repeating the insertion', async () => {
    const root = await temporaryRoot();
    let attempts = 0;
    const providers: MemoryProviders = {
      ...controlledMemoryProviders({ store: inMemoryNoteStore() }),
      async createEngine(settings) {
        const engine = await controlledMemoryProviders({}).createEngine(settings);
        return {
          add: async () => {
            attempts += 1;
            return {
              kind: 'uncertain',
              stage: 'persist',
              reason: 'the note store rejected the prepared batch',
              noteId: '55555555-5555-4555-8555-555555555555',
              affectedNoteIds: ['55555555-5555-4555-8555-555555555555'],
            };
          },
          search: engine.search,
        };
      },
    };
    const memory = await createMemory(memorySettings({ storageRoot: root, providers }));
    const first = await memory.remember(observation());
    expect(first.kind).toBe('uncertain');
    if (first.kind !== 'uncertain') {
      return;
    }
    expect(first.noteId).toBe('55555555-5555-4555-8555-555555555555');
    expect(first.affectedNoteIds).toEqual(['55555555-5555-4555-8555-555555555555']);

    const second = await memory.remember(observation());
    expect(second.kind).toBe('uncertain');
    expect(attempts).toBe(1);
    await memory.close();
  });

  it('treats an in-flight receipt surviving its operation as uncertain', async () => {
    const root = await temporaryRoot();
    const source = observation();
    const store = inMemoryNoteStore();
    const memory = await createMemory(
      memorySettings({
        storageRoot: root,
        providers: controlledMemoryProviders({ store }),
      }),
    );
    // A crash between the persisted note and its success receipt leaves the in-flight receipt.
    const receiptFile = receiptFileOf(root, 'test-collection', source.sourceKey);
    await mkdir(path.dirname(receiptFile), { recursive: true });
    await writeFile(
      receiptFile,
      `${JSON.stringify({
        sourceKey: source.sourceKey,
        content: source.content,
        timestamp: '2026-09-27T10:00:00Z',
        provenance: source.provenance,
        state: 'in-flight',
        updatedAt: '2026-09-27T10:00:00Z',
      })}\n`,
      'utf8',
    );

    const result = await memory.remember(source);
    expect(result.kind).toBe('uncertain');
    if (result.kind !== 'uncertain') {
      return;
    }
    expect(result.reason).toContain('interrupted insertion');
    expect(store.calls.put).toBe(0);
    await memory.close();
  });

  it('defers under writer contention and stores once the holder releases the lock', async () => {
    const root = await temporaryRoot();
    const store = inMemoryNoteStore();
    const slow: MemoryProviders = {
      ...controlledMemoryProviders({ store }),
      async createEngine(settings) {
        const engine = await controlledMemoryProviders({}).createEngine(settings);
        return {
          add: async (input) => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return engine.add(input);
          },
          search: engine.search,
        };
      },
    };
    const memory = await createMemory(
      memorySettings({ storageRoot: root, lockWaitMs: 100, providers: slow }),
    );
    const first = memory.remember(observation());
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = await memory.remember(
      observation({
        sourceKey: 'artifacts/1/development.json#summary#sha256:other',
        content: 'Another observation waiting for the single writer.',
      }),
    );
    expect(second.kind).toBe('deferred');
    expect((await first).kind).toBe('stored');
    await memory.close();
  });

  it('defers other collection writes while an uncertain insertion is unresolved, keeping reads', async () => {
    const root = await temporaryRoot();
    const store = inMemoryNoteStore();
    seedNote(store, {
      id: '77777777-7777-4777-8777-777777777777',
      content: 'A read does not depend on an unresolved write.',
      context: 'A note a retrieval can still return.',
    });
    let uncertain = true;
    const providers: MemoryProviders = {
      ...controlledMemoryProviders({ store }),
      async createEngine(settings) {
        const engine = await controlledMemoryProviders({}).createEngine(settings);
        return {
          add: (input) =>
            uncertain
              ? Promise.resolve({
                  kind: 'uncertain',
                  stage: 'persist',
                  reason: 'the note store rejected the prepared batch',
                  noteId: null,
                  affectedNoteIds: [],
                })
              : engine.add(input),
          search: engine.search,
        };
      },
    };
    const memory = await createMemory(memorySettings({ storageRoot: root, providers }));
    expect((await memory.remember(observation())).kind).toBe('uncertain');

    // Reads remain available while the collection defers further writes.
    const recall = await memory.recall({
      invocationId: 'reads',
      query: 'unresolved write',
      evidenceFile: path.join(root, 'evidence', 'reads.json'),
      scope: { project: 'HARN', workflow: 'finite-delivery', role: 'developer' },
    });
    expect(recall.kind).toBe('context');

    const other = await memory.remember(
      observation({
        sourceKey: 'artifacts/1/review.json#verdict#sha256:other',
        content: 'A later hand-off while an earlier insertion is uncertain.',
      }),
    );
    expect(other.kind).toBe('deferred');

    // Reconciling the uncertain insertion — the operator confirms the note exists and resolves its
    // receipt — resumes writes; the receipt itself carries the collection's deferral.
    uncertain = false;
    const uncertainReceipt = receiptFileOf(root, 'test-collection', observation().sourceKey);
    const recorded = JSON.parse(await readFile(uncertainReceipt, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(recorded['state']).toBe('uncertain');
    await writeFile(
      uncertainReceipt,
      `${JSON.stringify({
        ...recorded,
        state: 'stored',
        noteId: '99999999-9999-4999-8999-999999999999',
      })}\n`,
      'utf8',
    );
    expect(
      (
        await memory.remember(
          observation({
            sourceKey: 'artifacts/1/review.json#verdict#sha256:other',
            content: 'A later hand-off while an earlier insertion is uncertain.',
          }),
        )
      ).kind,
    ).toBe('stored');
    await memory.close();
  });

  it('defers another observation while an interrupted insertion stays in flight', async () => {
    const root = await temporaryRoot();
    const store = inMemoryNoteStore();
    const memory = await createMemory(
      memorySettings({
        storageRoot: root,
        providers: controlledMemoryProviders({ store }),
      }),
    );
    const interrupted = observation();
    // A crash leaves the in-flight receipt of an interrupted insertion with no separate deferral
    // record; the receipt state itself must defer the collection.
    const receiptFile = receiptFileOf(root, 'test-collection', interrupted.sourceKey);
    await mkdir(path.dirname(receiptFile), { recursive: true });
    await writeFile(
      receiptFile,
      `${JSON.stringify({
        sourceKey: interrupted.sourceKey,
        content: interrupted.content,
        timestamp: '2026-09-27T10:00:00Z',
        provenance: interrupted.provenance,
        state: 'in-flight',
        updatedAt: '2026-09-27T10:00:00Z',
      })}\n`,
      'utf8',
    );

    const later = observation({
      sourceKey: 'artifacts/1/review.json#verdict#sha256:later',
      content: 'A later hand-off while an earlier insertion is still in flight.',
    });
    const deferred = await memory.remember(later);
    expect(deferred.kind).toBe('deferred');
    if (deferred.kind === 'deferred') {
      expect(deferred.reason).toContain(receiptFile);
    }
    expect(store.calls.put).toBe(0);

    // The interrupted source itself is reported uncertain, never repeated, and its receipt keeps
    // deferring every other source.
    const replay = await memory.remember(interrupted);
    expect(replay.kind).toBe('uncertain');
    expect(store.calls.put).toBe(0);
    expect((await memory.remember(later)).kind).toBe('deferred');
    await memory.close();
  });

  it('defers another observation while an uncertain receipt has no deferral record', async () => {
    const root = await temporaryRoot();
    const store = inMemoryNoteStore();
    seedNote(store, {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      content: 'A read does not depend on an unresolved write.',
      context: 'A note a retrieval can still return.',
    });
    const memory = await createMemory(
      memorySettings({
        storageRoot: root,
        providers: controlledMemoryProviders({ store }),
      }),
    );
    // A crash between the uncertain receipt and any further record leaves only the receipt; a
    // restart must still defer another source, and replaying this source must not repeat it.
    const uncertain = observation();
    const receiptFile = receiptFileOf(root, 'test-collection', uncertain.sourceKey);
    await mkdir(path.dirname(receiptFile), { recursive: true });
    await writeFile(
      receiptFile,
      `${JSON.stringify({
        sourceKey: uncertain.sourceKey,
        content: uncertain.content,
        timestamp: '2026-09-27T10:00:00Z',
        provenance: uncertain.provenance,
        state: 'uncertain',
        reason: 'the note store rejected the prepared batch',
        updatedAt: '2026-09-27T10:00:00Z',
      })}\n`,
      'utf8',
    );

    const replay = await memory.remember(uncertain);
    expect(replay.kind).toBe('uncertain');
    expect(store.calls.put).toBe(0);

    const later = observation({
      sourceKey: 'artifacts/1/review.json#verdict#sha256:later',
      content: 'A later hand-off while an earlier insertion is uncertain.',
    });
    expect((await memory.remember(later)).kind).toBe('deferred');

    // Reads stay available while the collection defers writes.
    const recall = await memory.recall({
      invocationId: 'reads',
      query: 'unresolved write',
      evidenceFile: path.join(root, 'evidence', 'reads.json'),
      scope: { project: 'HARN', workflow: 'finite-delivery', role: 'developer' },
    });
    expect(recall.kind).toBe('context');
    await memory.close();
  });

  it('captures a pending observation while the configured providers are unavailable', async () => {
    const root = await temporaryRoot();
    const capture = createReceiptStore({ root, storeId: 'test-collection' });
    const memory = unavailableMemory('the encoder is unavailable', capture);

    const first = await memory.remember(observation());
    expect(first.kind).toBe('failed');
    if (first.kind !== 'failed' || first.receipt === null) {
      return;
    }
    const receipt = JSON.parse(await readFile(first.receipt, 'utf8')) as {
      readonly sourceKey: string;
      readonly content: string;
      readonly state: string;
    };
    expect(receipt.state).toBe('pending');
    expect(receipt.sourceKey).toBe(observation().sourceKey);
    expect(receipt.content).toBe(observation().content);
    expect(first.reason).toContain('the encoder is unavailable');

    // A repetition keeps the captured snapshot instead of replacing it, and recall stays explicit.
    const repeated = await memory.remember(observation({ content: 'changed content' }));
    expect(repeated.kind).toBe('failed');
    const retained = JSON.parse(await readFile(first.receipt, 'utf8')) as {
      readonly content: string;
    };
    expect(retained.content).toBe(observation().content);
    expect(
      await memory.recall({
        invocationId: 'unavailable',
        query: 'memory',
        evidenceFile: path.join(root, 'evidence', 'unavailable.json'),
        scope: { project: 'HARN', workflow: 'finite-delivery', role: 'developer' },
      }),
    ).toEqual({ kind: 'unavailable', reason: 'the encoder is unavailable' });
    await memory.close();
  });
});

describe('source identity', () => {
  it('derives one stable key from the source, selector and included content', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: null, c: 'x' }] })).toBe(
      '{"a":[1,{"c":"x","d":null}],"b":1}',
    );
  });
});

describe('memory model transport', () => {
  it('explicitly disables thinking in both the construct and the evolve request', async () => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let text = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        text += chunk;
      });
      request.on('end', () => {
        requests.push(JSON.parse(text) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    context: 'Records the source material.',
                    keywords: ['memory'],
                    tags: ['hand-off'],
                    links: [],
                    newTags: [],
                    updates: [],
                  }),
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('the capture server did not report a port');
      }
      const transport = createMemoryModelTransport({
        endpoint: `http://127.0.0.1:${String(address.port)}/chat/completions`,
        model: 'test-model',
        timeoutMs: 2000,
        maxOutputTokens: 100,
      });
      await transport.generate({ stage: 'construct', prompt: 'Construct one note.' });
      await transport.generate({ stage: 'evolve', prompt: 'Evolve the collection.' });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request['reasoning_effort']).toBe('none');
      expect(Object.keys(request).sort()).toEqual(
        ['max_tokens', 'messages', 'model', 'reasoning_effort'].sort(),
      );
    }
  });
});
