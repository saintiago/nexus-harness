/** Races around the real in-process fixture entry, before command dispatch. */
import { existsSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CliContext } from '../src/cli/context.js';
import { createTempDir } from './support.js';
import { recordingSignals, run } from './fixtures/cli.js';
import { disposeFixtures, useFixtureLifecycle } from './fixtures/lifecycle.js';
import { fixtureContexts, newScope } from './fixtures/scope.js';

const entry = vi.hoisted(() =>
  vi.fn<(argv: readonly string[], context: CliContext) => Promise<number>>(),
);
vi.mock('../src/cli.js', () => ({ runCli: entry }));
useFixtureLifecycle();
beforeEach(() => {
  entry.mockReset();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('waits for an invocation that registers its interrupt after disposal starts', async () => {
  const directory = await createTempDir();
  const reading = deferred();
  const loaded = deferred();
  const signals = recordingSignals();
  let existedAtSettlement = false;
  entry.mockImplementation(async (_argv, context) => {
    reading.resolve();
    await loaded.promise;
    await new Promise<void>((resolve) => {
      context.signals!.onInterrupt(resolve);
    });
    existedAtSettlement = existsSync(directory);
    return 130;
  });
  const running = run(['run'], { cwd: directory, signals });
  await reading.promise;
  const disposal = disposeFixtures();
  loaded.resolve();
  await disposal;
  expect((await running).code).toBe(130);
  expect(existedAtSettlement).toBe(true);
  expect(signals.registered).toBe(1);
  expect(signals.released).toBe(1);
  expect(existsSync(directory)).toBe(false);
});

it('releases signal registrations even when the entry point throws', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  entry.mockImplementation(async (_argv, context) => {
    context.signals!.onInterrupt(() => undefined);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(
      before.map((count) => count + 1),
    );
    throw new Error('dispatch failed');
  });
  await expect(run(['run'])).rejects.toThrow('dispatch failed');
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});

it('refuses a late CLI invocation in its original disposed scope while a newer scope is active', async () => {
  const old = newScope();
  const resume = deferred();
  const late = fixtureContexts.run(old, async () => {
    await resume.promise;
    return run(['run']);
  });
  const rejected = expect(late).rejects.toThrow('already being disposed');
  await disposeFixtures(old);
  const next = newScope();
  await fixtureContexts.run(next, async () => {
    resume.resolve();
    await rejected;
    expect(next.work.size).toBe(0);
    await disposeFixtures(next);
  });
  expect(entry).not.toHaveBeenCalled();
});
