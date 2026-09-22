/** An allocation that completes after its scope's bounded disposal. */
import { existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDirectories, tempDirectories } from './support.js';
import { disposeFixtures, ownFixtureOperation } from './fixtures/lifecycle.js';
import { fixtureContexts, newScope } from './fixtures/scope.js';
import { STOP_GRACE_MS } from '../src/process/stop.js';

const delayed = vi.hoisted(() => ({ allocation: undefined as Promise<void> | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    mkdtemp: async (prefix: string) => {
      await delayed.allocation;
      return await fs.mkdtemp(prefix);
    },
  };
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('refuses a late allocation and preserves its original pending owner across later disposals', async () => {
  const allocation = deferred<void>();
  const setupFinished = deferred<void>();
  const allocationRefused = deferred<unknown>();
  delayed.allocation = allocation.promise;
  const oldScope = newScope();
  let returnedToSetup = false;
  const setup = fixtureContexts.run(oldScope, () =>
    ownFixtureOperation('delayed setup', async () => {
      try {
        await createTempDir();
        returnedToSetup = true;
      } catch (cause) {
        allocationRefused.resolve(cause);
      }
      await setupFinished.promise;
    }),
  );
  try {
    // Both setup and allocation are registered before disposal. The real OS
    // allocation itself does not finish until *after* the bounded wait returns.
    await Promise.resolve();
    await Promise.resolve();
    expect(oldScope.work.size).toBe(2);
    vi.useFakeTimers();
    const disposed = expect(disposeFixtures(oldScope)).rejects.toThrow('still running');
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 1);
    await disposed;
    vi.useRealTimers();
    expect(tempDirectories()).toEqual([]);

    allocation.resolve();
    expect(await allocationRefused.promise).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('allocation was refused'),
      }),
    );
    const [directory] = tempDirectories();
    expect(directory).toBeDefined();
    expect(existsSync(directory!)).toBe(true);
    expect(returnedToSetup).toBe(false);
    expect(oldScope.work.size).toBe(1);

    // Successful newer tests cannot release an older test's unfinished setup,
    // even though its directory did not exist when its own hook took inventory.
    await disposeFixtures(newScope());
    await disposeFixtures(newScope());
    expect(tempDirectories()).toEqual([directory]);
    expect(existsSync(directory!)).toBe(true);
    setupFinished.resolve();
    await setup;
    await disposeFixtures(newScope());
    expect(tempDirectories()).toEqual([]);
    expect(existsSync(directory!)).toBe(false);
  } finally {
    vi.useRealTimers();
    allocation.resolve();
    setupFinished.resolve();
    await setup;
    delayed.allocation = undefined;
    await cleanupTempDirectories();
  }
});
