/**
 * Writer coordination coverage: two writers sharing one collection exclude each other through the
 * process-scoped OS lock, contention defers the pending observation instead of stealing the lock,
 * the lock is released when its holder exits, and receipts survive worker and workspace
 * replacement because they live outside issue workspaces.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemory, type Observation } from '../src/memory/index.js';
import {
  controlledMemoryProviders,
  inMemoryNoteStore,
  memorySettings,
  type ControlledStore,
} from './support/memory.js';

const temporaryDirectories: string[] = [];
const holders: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    holder.kill('SIGKILL');
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A foreign writer holding the collection's OS lock until its process exits. */
async function holdWriterLock(lockFile: string): Promise<void> {
  // `--no-fork` makes the sleeping process itself the lock holder, so killing it releases the lock.
  const holder = spawn('flock', ['--exclusive', '--no-fork', lockFile, 'sleep', '30'], {
    stdio: 'ignore',
  });
  holders.push(holder);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    sourceKey: 'artifacts/1/development.json#summary#sha256:one',
    content: 'Task HARN-78 — project HARN, role developer, round 1: the repair is committed.',
    provenance: { project: 'HARN', issue: 'HARN-78', role: 'developer' },
    ...overrides,
  };
}

describe('memory writer coordination', () => {
  it('defers a pending observation under contention and stores it once the holder exits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-memory-lock-'));
    temporaryDirectories.push(root);
    const store: ControlledStore = inMemoryNoteStore();
    const memory = await createMemory(
      memorySettings({
        storageRoot: root,
        lockWaitMs: 100,
        providers: controlledMemoryProviders({ store }),
      }),
    );
    const lockFile = path.join(root, 'memory', 'test-collection', 'writer.lock');
    await holdWriterLock(lockFile);

    const started = Date.now();
    const deferred = await memory.remember(observation());
    expect(deferred.kind).toBe('deferred');
    expect(Date.now() - started).toBeLessThan(2000);
    if (deferred.kind !== 'deferred') {
      return;
    }
    // The source observation is preserved before the lock, so the deferral loses nothing.
    const pending = JSON.parse(await readFile(deferred.receipt, 'utf8')) as {
      readonly state: string;
      readonly content: string;
    };
    expect(pending.state).toBe('pending');
    expect(pending.content).toBe(observation().content);
    expect(store.calls.put).toBe(0);

    // A later attempt after the holder exits acquires the lock and stores the observation.
    for (const holder of holders.splice(0)) {
      holder.kill('SIGKILL');
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stored = await memory.remember(observation());
    expect(stored.kind).toBe('stored');
    expect(store.calls.put).toBe(1);

    // The lock is free again: another writer acquires it immediately after the operation.
    await holdWriterLock(lockFile);
    const contended = await memory.remember(observation({ sourceKey: 'other#summary#sha256:x' }));
    expect(contended.kind).toBe('deferred');
    await memory.close();
  });

  it('keeps receipts outside issue workspaces so worker and workspace replacement can replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-memory-survive-'));
    temporaryDirectories.push(root);
    const store = inMemoryNoteStore();
    const firstWorker = await createMemory(
      memorySettings({
        storageRoot: root,
        providers: controlledMemoryProviders({ store }),
      }),
    );
    const stored = await firstWorker.remember(observation());
    expect(stored.kind).toBe('stored');
    if (stored.kind !== 'stored') {
      return;
    }
    await firstWorker.close();

    // Recovery cleanup removes the issue workspace; the receipt lives under the storage root.
    const issueWorkspace = path.join(root, 'workspaces', 'HARN-78');
    await rm(issueWorkspace, { recursive: true, force: true });
    await expect(stat(stored.receipt)).resolves.toBeDefined();

    // A replacement worker replays the same observation from the retained receipt.
    const secondWorker = await createMemory(
      memorySettings({
        storageRoot: root,
        providers: controlledMemoryProviders({ store }),
      }),
    );
    const replay = await secondWorker.remember(observation());
    expect(replay.kind).toBe('already-recorded');
    if (replay.kind === 'already-recorded') {
      expect(replay.noteId).toBe(stored.noteId);
    }
    expect(store.calls.put).toBe(1);
    await secondWorker.close();
  });

  it('refuses to reuse one store identity for another Qdrant endpoint or collection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-memory-binding-'));
    temporaryDirectories.push(root);
    const providers = controlledMemoryProviders({ store: inMemoryNoteStore() });
    const memory = await createMemory(memorySettings({ storageRoot: root, providers }));
    await memory.close();

    await expect(
      createMemory(
        memorySettings({
          storageRoot: root,
          providers,
          qdrant: { url: 'http://127.0.0.1:6333', collection: 'another-collection' },
        }),
      ),
    ).rejects.toThrow(/bound to Qdrant collection/);
  });

  it('lets only one of two concurrent conflicting initializers bind a fresh store identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-memory-binding-race-'));
    temporaryDirectories.push(root);
    const embedderCalls = { count: 0 };
    const providers = controlledMemoryProviders({
      store: inMemoryNoteStore(),
      embedderCalls,
    });
    // Both initializers start against the same fresh storeId; only the binding they race to create
    // decides which collection the identity names, and the other must reject before provider use.
    const outcomes = await Promise.allSettled([
      createMemory(
        memorySettings({
          storageRoot: root,
          providers,
          qdrant: { url: 'http://127.0.0.1:6333', collection: 'first-collection' },
        }),
      ),
      createMemory(
        memorySettings({
          storageRoot: root,
          providers,
          qdrant: { url: 'http://127.0.0.1:6333', collection: 'second-collection' },
        }),
      ),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser = rejected[0];
    if (loser?.status === 'rejected') {
      expect(String(loser.reason)).toMatch(/bound to Qdrant collection/);
    }
    // Only the initializer that created the binding reached provider construction.
    expect(embedderCalls.count).toBe(1);
  });
});
