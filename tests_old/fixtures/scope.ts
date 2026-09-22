/** Async ownership shared by the lifecycle and temporary-directory allocator. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FixtureProcessRecord } from './local-target.js';

export interface OwnedProcess {
  readonly what: string;
  readonly pid: number | undefined;
  readonly cwd: string;
  readonly ended: Promise<void>;
  readonly requestStop?: () => Promise<string | null>;
  hasEnded(): boolean;
}

export interface OwnedWork {
  readonly what: string;
  readonly settled: Promise<void>;
  hasSettled(): boolean;
}

export interface FixtureScope {
  readonly stop: AbortController;
  readonly processes: Set<OwnedProcess>;
  readonly fixtures: FixtureProcessRecord[];
  readonly work: Set<OwnedWork>;
  disposing: boolean;
}

export function newScope(): FixtureScope {
  return {
    stop: new AbortController(),
    processes: new Set(),
    fixtures: [],
    work: new Set(),
    disposing: false,
  };
}

// Entered by aroundEach *before* setup or the test body creates continuations.
// A late first fixture call therefore still sees its original, closed scope.
export const fixtureContexts = new AsyncLocalStorage<FixtureScope>();

export function assertFixtureActive(scope: FixtureScope, what: string): void {
  if (scope.disposing) {
    throw new Error(`${what} was refused: the test's fixtures are already being disposed`);
  }
}

/** Register before starting work, including work that throws synchronously. */
export function ownWork<T>(scope: FixtureScope, what: string, run: () => Promise<T>): Promise<T> {
  try {
    assertFixtureActive(scope, what);
  } catch (cause) {
    return Promise.reject(cause);
  }
  let settled = false;
  const work = Promise.resolve().then(() => {
    assertFixtureActive(scope, what);
    return run();
  });
  const owned: OwnedWork = {
    what,
    settled: work.then(
      () => undefined,
      () => undefined,
    ),
    hasSettled: () => settled,
  };
  scope.work.add(owned);
  void owned.settled.then(() => {
    settled = true;
    scope.work.delete(owned);
  });
  return work;
}
