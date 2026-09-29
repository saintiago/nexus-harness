import { z } from 'zod';
import {
  observationSchema,
  receiptSchema,
  searchResponseSchema,
  serviceErrorSchema,
  type MemoryObservation,
  type MemoryReceipt,
  type MemorySearchMatch,
} from './service.js';

/**
 * Memory gives explicit access to shared experience through the separately supervised AMEM
 * service: a bounded search, one observation submission and receipt inspection. It consumes the
 * provider's documented HTTP API and never imports provider internals, opens its own collection,
 * loads an encoder, takes a writer lock or duplicates the service's durable ingestion. Memory
 * supplements current work: it decides no workflow outcome, and every failure is an explicit
 * result the caller reports without changing the business outcome it accompanies.
 */

/** One bounded retrieval: the focused query and the public result limits. */
export type MemorySearchRequest = {
  readonly query: string;
  readonly limit?: number;
  readonly linkedLimit?: number;
};

/** What one search supplied: complete attributed results. */
export type MemorySearchSupply = {
  readonly kind: 'results';
  readonly searchedAt: string;
  readonly results: readonly MemorySearchMatch[];
};

/** The explicit state of a memory capability that could not answer. */
export type MemoryUnavailable = {
  readonly kind: 'unavailable';
  /** The safe reason, never a credential or a raw provider transport error. */
  readonly reason: string;
  /** Whether repeating the identical request can succeed. */
  readonly retryable: boolean;
};

/** What one search produced: complete results or an explicit unavailability. */
export type MemorySearchResult =
  MemorySearchSupply | MemoryUnavailable | { readonly kind: 'disabled' };

/**
 * What one submission produced: durable acceptance, a refusal or an explicit unavailability. A
 * refusal was decided before durable acceptance, so the observation is not queued.
 */
export type MemorySubmitResult =
  | { readonly kind: 'accepted'; readonly receipt: MemoryReceipt; readonly created: boolean }
  | { readonly kind: 'refused'; readonly reason: string; readonly retryable: boolean }
  | MemoryUnavailable
  | { readonly kind: 'disabled' };

/** What one receipt lookup produced: the current state or an explicit absence. */
export type MemoryReceiptResult =
  | { readonly kind: 'receipt'; readonly receipt: MemoryReceipt }
  | { readonly kind: 'missing' }
  | MemoryUnavailable
  | { readonly kind: 'disabled' };

/** The Memory capability: bounded search, one observation submission and receipt inspection. */
export type Memory = {
  search(request: MemorySearchRequest): Promise<MemorySearchResult>;
  submit(observation: MemoryObservation): Promise<MemorySubmitResult>;
  receipt(id: string): Promise<MemoryReceiptResult>;
  /** Settle active client operations and release owned resources. */
  close(): Promise<void>;
};

/** The host settings of the AMEM service client: the service URL and an optional transport. */
export type MemoryServiceSettings = {
  /** The base URL of the shared memory service. */
  readonly url: string;
  /** The fetch implementation; the global fetch by default. */
  readonly fetch?: typeof globalThis.fetch;
};

/** A memory that performs nothing: disabled Memory makes no service call and writes nothing. */
export function disabledMemory(): Memory {
  return {
    search: () => Promise.resolve({ kind: 'disabled' }),
    submit: () => Promise.resolve({ kind: 'disabled' }),
    receipt: () => Promise.resolve({ kind: 'disabled' }),
    close: () => Promise.resolve(),
  };
}

/** The default whole-request timeout; the service owns its own inference and ingestion timeouts. */
const defaultTimeoutMs = 120_000;

/** Provider diagnostics stay short and exclude transport detail the caller cannot act on. */
const maxDiagnosticLength = 300;

/** Shorten untrusted service text before it becomes a reported reason. */
function bounded(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxDiagnosticLength
    ? `${collapsed.slice(0, maxDiagnosticLength)}…`
    : collapsed;
}

/** The validated base URL of one client; a URL the service cannot serve is a construction error. */
function baseUrlOf(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!URL.canParse(trimmed)) {
    throw new Error('The memory service URL must be a valid absolute URL.');
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The memory service URL must use http or https.');
  }
  return trimmed;
}

/** One request's outcome: the parsed success body, the served failure, or an unavailability. */
type RequestOutcome<Value> =
  | { readonly kind: 'answer'; readonly status: number; readonly value: Value }
  | { readonly kind: 'missing' }
  /** The service answered outside the documented contract; the request's effect is unknown. */
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly retryable: boolean }
  | MemoryUnavailable;

/** The route a request addresses, the body it sends and the schema its success body must match. */
type RequestSettings<Value> = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly schema: z.ZodType<Value>;
  /** Whether a 404 is a normal absence rather than a failure. */
  readonly notFound?: boolean;
};

/**
 * Create the Memory capability over one configured service. Construction validates the service
 * URL; every call validates its response against the documented contract and reports a service or
 * transport failure as an explicit result. `close` cancels and settles in-flight requests; it
 * never stops the separately supervised service or its durable ingestion.
 */
export function createMemoryServiceClient(settings: MemoryServiceSettings): Memory {
  const base = baseUrlOf(settings.url);
  const send = settings.fetch ?? globalThis.fetch;
  const closed = new AbortController();
  const active = new Set<Promise<unknown>>();

  /** Run one operation while `close` waits for it. */
  function track<Value>(operation: () => Promise<Value>): Promise<Value> {
    const running = operation();
    active.add(running);
    running.then(
      () => active.delete(running),
      () => active.delete(running),
    );
    return running;
  }

  /** The explicit result one call reports once this client has been closed. */
  function closedResult(): MemoryUnavailable {
    return { kind: 'unavailable', reason: 'the memory client is closed', retryable: false };
  }

  async function requestService<Value>(
    requestSettings: RequestSettings<Value>,
  ): Promise<RequestOutcome<Value>> {
    const timeout = AbortSignal.timeout(defaultTimeoutMs);
    const abort = AbortSignal.any([timeout, closed.signal]);
    let response: Response;
    try {
      response = await send(`${base}${requestSettings.path}`, {
        method: requestSettings.method,
        headers: {
          accept: 'application/json',
          ...(requestSettings.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(requestSettings.body === undefined
          ? {}
          : { body: JSON.stringify(requestSettings.body) }),
        signal: abort,
      });
    } catch {
      return {
        kind: 'unavailable',
        reason:
          abort.aborted && !timeout.aborted
            ? 'the memory client was closed'
            : 'the memory service could not be reached',
        retryable: true,
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return {
        kind: 'unavailable',
        reason: 'the memory service response could not be received completely',
        retryable: true,
      };
    }
    if (response.status === 404 && requestSettings.notFound === true) {
      return { kind: 'missing' };
    }
    if (!response.ok) {
      let reason = `the memory service answered HTTP ${String(response.status)}`;
      let retryable = response.status >= 500;
      try {
        const parsed = serviceErrorSchema.safeParse(JSON.parse(text) as unknown);
        if (parsed.success) {
          reason = bounded(parsed.data.error.message);
          retryable = parsed.data.error.retryable;
        }
      } catch {
        // A failure body outside the contract keeps the generic status message.
      }
      return response.status >= 500
        ? { kind: 'unavailable', reason, retryable }
        : { kind: 'refused', reason, retryable };
    }

    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return {
        kind: 'invalid',
        reason: 'the memory service answered with a body that is not JSON',
      };
    }
    const parsed = requestSettings.schema.safeParse(body);
    if (!parsed.success) {
      return {
        kind: 'invalid',
        reason: 'the memory service answered outside its documented response contract',
      };
    }
    return { kind: 'answer', status: response.status, value: parsed.data };
  }

  return {
    search(searchRequest) {
      if (closed.signal.aborted) {
        return Promise.resolve(closedResult());
      }
      return track(async (): Promise<MemorySearchResult> => {
        const outcome = await requestService({
          method: 'POST',
          path: '/v1/search',
          body: {
            query: searchRequest.query,
            ...(searchRequest.limit === undefined ? {} : { limit: searchRequest.limit }),
            ...(searchRequest.linkedLimit === undefined
              ? {}
              : { linkedLimit: searchRequest.linkedLimit }),
          },
          schema: searchResponseSchema,
        });
        if (outcome.kind === 'answer') {
          return { kind: 'results', ...outcome.value };
        }
        if (outcome.kind === 'refused') {
          return { kind: 'unavailable', reason: outcome.reason, retryable: outcome.retryable };
        }
        if (outcome.kind === 'missing') {
          return {
            kind: 'unavailable',
            reason: 'the memory service did not answer the search request',
            retryable: false,
          };
        }
        if (outcome.kind === 'invalid') {
          return { kind: 'unavailable', reason: outcome.reason, retryable: false };
        }
        return outcome;
      });
    },

    submit(observation) {
      if (closed.signal.aborted) {
        return Promise.resolve(closedResult());
      }
      const parsedObservation = observationSchema.safeParse(observation);
      if (!parsedObservation.success) {
        const issue = parsedObservation.error.issues[0];
        const detail =
          issue === undefined
            ? 'the observation does not match the documented contract'
            : `${issue.path.join('.') || 'observation'}: ${issue.message}`;
        return Promise.resolve({ kind: 'refused', reason: detail, retryable: false });
      }
      return track(async (): Promise<MemorySubmitResult> => {
        const outcome = await requestService({
          method: 'POST',
          path: '/v1/observations',
          body: parsedObservation.data,
          schema: receiptSchema,
        });
        if (outcome.kind === 'answer') {
          return { kind: 'accepted', receipt: outcome.value, created: outcome.status === 202 };
        }
        if (outcome.kind === 'invalid') {
          // The acceptance outcome is unknown: resubmitting the identical observation resolves it.
          return { kind: 'unavailable', reason: outcome.reason, retryable: true };
        }
        if (outcome.kind === 'missing') {
          return {
            kind: 'unavailable',
            reason: 'the memory service did not answer the submission with a receipt',
            retryable: false,
          };
        }
        return outcome;
      });
    },

    receipt(id) {
      if (closed.signal.aborted) {
        return Promise.resolve(closedResult());
      }
      return track(async (): Promise<MemoryReceiptResult> => {
        const outcome = await requestService({
          method: 'GET',
          path: `/v1/receipts/${encodeURIComponent(id)}`,
          schema: receiptSchema,
          notFound: true,
        });
        if (outcome.kind === 'answer') {
          return { kind: 'receipt', receipt: outcome.value };
        }
        if (outcome.kind === 'missing') {
          return { kind: 'missing' };
        }
        if (outcome.kind === 'invalid') {
          return { kind: 'unavailable', reason: outcome.reason, retryable: false };
        }
        return outcome.kind === 'refused'
          ? { kind: 'unavailable', reason: outcome.reason, retryable: outcome.retryable }
          : outcome;
      });
    },

    async close() {
      closed.abort();
      while (active.size > 0) {
        await Promise.allSettled([...active]);
      }
    },
  };
}

export { jsonObjectSchema, jsonValueSchema, type JsonValue } from './json.js';
export {
  noteSchema,
  observationSchema,
  receiptSchema,
  receiptStatuses,
  searchResponseSchema,
  searchResultSchema,
  serviceErrorSchema,
  type MemoryNote,
  type MemoryObservation,
  type MemoryReceipt,
  type MemorySearchMatch,
} from './service.js';
