/**
 * Memory component coverage: bounded whole-note context budgeting, provenance and ordering,
 * empty/unavailable behavior, deterministic retrieval evidence and the ingestion receipt
 * lifecycle. The engine is the real standalone package composed over controlled providers; the
 * storage operations are real files under a temporary directory.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createMemory,
  disabledMemory,
  retrievalFraming,
  type MemoryProviders,
  type Observation,
} from '../src/memory/index.js';
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

    // Reconciling the uncertain insertion (here: removing its deferral record) resumes writes.
    uncertain = false;
    await rm(path.join(root, 'memory', 'test-collection', 'uncertain.json'), { force: true });
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
});

describe('source identity', () => {
  it('derives one stable key from the source, selector and included content', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: null, c: 'x' }] })).toBe(
      '{"a":[1,{"c":"x","d":null}],"b":1}',
    );
  });
});
