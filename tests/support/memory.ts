import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { MemoryObservation, MemoryReceipt } from '../../src/memory/index.js';
import type { JsonValue } from '../../src/memory/json.js';

/**
 * A controlled AMEM service for contract tests: the documented `/v1` routes over one in-memory
 * collection, with per-path interception for failures, conflicts and a lost acknowledgement. It
 * records every request so a test can assert the contract the real client sends.
 */

/** One request the controlled service received. */
export type ServiceRequest = {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
};

/** What an interceptor does instead of the default route behavior. */
export type Interception =
  'pass' | 'accept-then-close' | { readonly status: number; readonly body: unknown };

/** One stored observation and its current receipt. */
type StoredObservation = {
  readonly observation: MemoryObservation;
  receipt: MemoryReceipt;
};

export type ControlledMemoryService = {
  readonly url: string;
  readonly requests: ServiceRequest[];
  readonly observations: Map<string, StoredObservation>;
  /** The results the next searches return. */
  results: readonly unknown[];
  /** Answer requests to one path instead of the default behavior; null passes. */
  intercept(path: string, handler: (request: ServiceRequest) => Interception | null): void;
  /** Advance one accepted observation's receipt to stored with its note identity. */
  store(sourceKey: string, noteId?: string): void;
  /** Report one accepted observation's receipt as blocked, as a queue awaiting reconciliation. */
  block(sourceKey: string, lastError?: string): void;
  close(): Promise<void>;
};

/** One error body the service documents. */
function errorBody(code: string, message: string, retryable: boolean): unknown {
  return { error: { code, message, retryable } };
}

/** Read the complete request body as text. */
async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Create one controlled service on a loopback port. The default behavior owns exactly the
 * documented semantics: durable acceptance with the existing receipt for an identical resubmission,
 * a conflict for the same source key with a different payload, receipt lookup, and search over the
 * scripted results.
 */
export async function controlledMemoryService(
  options: { readonly results?: readonly unknown[] } = {},
): Promise<ControlledMemoryService> {
  const requests: ServiceRequest[] = [];
  const observations = new Map<string, StoredObservation>();
  const interceptors = new Map<string, (request: ServiceRequest) => Interception | null>();
  let results: readonly unknown[] = options.results ?? [];
  let now = 0;

  const timestamp = (): string => {
    now += 1000;
    return new Date(Date.UTC(2026, 8, 29, 12, 0, 0) + now).toISOString();
  };

  const receiptOf = (id: string): MemoryReceipt | null => {
    for (const stored of observations.values()) {
      if (stored.receipt.id === id) {
        return stored.receipt;
      }
    }
    return null;
  };

  const createReceipt = (observation: MemoryObservation): MemoryReceipt => {
    const acceptedAt = timestamp();
    return {
      id: randomUUID(),
      sourceKey: observation.sourceKey,
      status: 'queued',
      acceptedAt,
      updatedAt: acceptedAt,
      attemptCount: 0,
    };
  };

  /** The default route behavior: the documented service semantics over the in-memory collection. */
  function handleDefault(request: ServiceRequest): { status: number; body: unknown } | null {
    if (request.method === 'POST' && request.path === '/v1/observations') {
      const observation = request.body as MemoryObservation;
      const existing = observations.get(observation.sourceKey);
      if (existing !== undefined) {
        const identical = JSON.stringify(existing.observation) === JSON.stringify(observation);
        if (!identical) {
          return {
            status: 409,
            body: errorBody(
              'conflict',
              'The source key is already accepted with a different observation.',
              false,
            ),
          };
        }
        return { status: 200, body: existing.receipt };
      }
      const receipt = createReceipt(observation);
      observations.set(observation.sourceKey, { observation, receipt });
      return { status: 202, body: receipt };
    }
    if (request.method === 'GET' && request.path.startsWith('/v1/receipts/')) {
      const id = decodeURIComponent(request.path.slice('/v1/receipts/'.length));
      const receipt = receiptOf(id);
      return receipt === null
        ? { status: 404, body: errorBody('missing', 'No such receipt.', false) }
        : { status: 200, body: receipt };
    }
    if (request.method === 'POST' && request.path === '/v1/search') {
      return { status: 200, body: { searchedAt: timestamp(), results } };
    }
    return { status: 404, body: errorBody('missing', 'No such route.', false) };
  }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const text = await bodyText(request);
      const path = request.url ?? '';
      const serviceRequest: ServiceRequest = {
        method: request.method ?? 'GET',
        path,
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
      };
      requests.push(serviceRequest);

      const interception = interceptors.get(path)?.(serviceRequest) ?? 'pass';
      if (interception !== 'pass' && typeof interception === 'object') {
        response.writeHead(interception.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(interception.body));
        return;
      }
      const handled = handleDefault(serviceRequest);
      if (handled === null) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify(errorBody('missing', 'No such route.', false)));
        return;
      }
      if (interception === 'accept-then-close') {
        // The durable acceptance happened; the acknowledgement never reaches the caller.
        response.destroy();
        return;
      }
      response.writeHead(handled.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(handled.body));
    })().catch(() => {
      response.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    observations,
    get results() {
      return results;
    },
    set results(next: readonly unknown[]) {
      results = next;
    },
    intercept(path, handler) {
      interceptors.set(path, handler);
    },
    store(sourceKey, noteId) {
      const stored = observations.get(sourceKey);
      if (stored === undefined) {
        throw new Error(`No observation was accepted for source key "${sourceKey}".`);
      }
      stored.receipt = {
        ...stored.receipt,
        status: 'stored',
        noteId: noteId ?? randomUUID(),
        updatedAt: timestamp(),
      };
    },
    block(sourceKey, lastError = 'The ingestion queue is blocked pending reconciliation.') {
      const stored = observations.get(sourceKey);
      if (stored === undefined) {
        throw new Error(`No observation was accepted for source key "${sourceKey}".`);
      }
      stored.receipt = {
        ...stored.receipt,
        status: 'blocked',
        lastError,
        updatedAt: timestamp(),
      };
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

/** One documented search result: a complete note plus its match classification. */
export function searchResult(
  note: {
    readonly id?: string;
    readonly content: string;
    readonly context?: string;
    readonly keywords?: readonly string[];
    readonly tags?: readonly string[];
    readonly links?: readonly string[];
    readonly metadata?: Readonly<Record<string, JsonValue>>;
  },
  via: { readonly score: number } | 'link' = { score: 0.87 },
): unknown {
  const complete = {
    id: note.id ?? randomUUID(),
    content: note.content,
    timestamp: '2026-09-29T10:00:00Z',
    context: note.context ?? 'Records one observation.',
    keywords: [...(note.keywords ?? ['observation'])],
    tags: [...(note.tags ?? ['development'])],
    links: [...(note.links ?? [])],
    ...(note.metadata === undefined ? {} : { metadata: note.metadata }),
  };
  return via === 'link'
    ? { note: complete, via: 'link' }
    : { note: complete, via: 'match', score: via.score };
}
