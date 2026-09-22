/**
 * The bounded fixture lifecycle every process-starting suite shares.
 *
 * A test owns processes, work and directories from the moment it starts them.
 * The lifecycle is one scope per test:
 *
 * - Everything a fixture starts goes through the scope: `runProcess` keeps the
 *   child it spawned, `ownFixtureProcess` keeps a fixture process by the token
 *   only that process recorded, and `ownFixtureOperation` keeps the asynchronous
 *   work itself — a completion pass, a task run, a built CLI — by its promise.
 * - The scope carries the test's own stop. A fixture that runs something with a
 *   stop signal takes that signal, so the end of the test cancels the work the
 *   test was still doing instead of leaving it to race the directory removal.
 * - Once the test ends the scope closes: work started after that is refused
 *   outright rather than left for a hook that has already finished, and the hook
 *   waits (bounded) for every registered operation to settle, after stopping the
 *   trees it owns.
 * - Only then are the temporary directories removed, and only the ones no
 *   unconfirmed owner might still hold: a stop that could not be confirmed keeps
 *   its directory and is reported as a problem, so a leaked process fails the
 *   test that leaked it instead of being quietly removed with its tree.
 * - A fixture call belongs to the *context it is first made from*: the first call
 *   from a test body binds that body's context to the test's scope, and every
 *   continuation the body creates afterwards carries the same binding. Work that
 *   outlives its test therefore resumes holding the closed scope it started in
 *   and is refused, rather than finding whatever test is running by then and
 *   registering itself as that test's.
 *
 * The wait is bounded and proven: a fixture process is asked through its own
 * beacon, so a PID this host has already handed to another process is never
 * signalled (notes/windows-fixture-flakes.md), and a command is stopped by the
 * production tree stop and awaited. Nothing here kills a process it did not
 * start, nothing here retries forever, and no stop is read as confirmed just
 * because the directory could be removed.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterEach } from 'vitest';
import { STOP_GRACE_MS, requestTreeStop, within } from '../../src/process/stop.js';
import { messageOf } from '../../src/shared/errors.js';
import { cleanupTempDirectories } from '../support.js';
import { endFixtureTree, fixtureProcessGone } from './local-target.js';
import type { FixtureProcessRecord } from './local-target.js';

/** What one real command did, as the process itself reported it. */
export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** What one test tells the shared command runner about one command. */
export interface ProcessOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * How long this one command may run before its tree is stopped. Absent means
   * the test's own lifetime bounds it.
   */
  readonly timeoutMs?: number;
  /** The test's own stop: aborting it stops the command's tree and rejects. */
  readonly stop?: AbortSignal;
}

/**
 * One process this suite started and has not seen end, with the directory it
 * runs in: the directory is what is preserved when its stop cannot be confirmed.
 */
interface OwnedProcess {
  /** What started it, as a failure message names it. */
  readonly what: string;
  readonly pid: number | undefined;
  readonly cwd: string;
  /** Resolves when the process is really gone, never before. */
  readonly ended: Promise<void>;
  /** Whether the host has already reported this process ending. */
  hasEnded(): boolean;
}

/** One asynchronous operation a test started and the scope is waiting for. */
interface OwnedWork {
  readonly what: string;
  /** Resolves when the operation settles, either way. */
  readonly settled: Promise<void>;
  /** Whether it has settled. A settled operation holds no directory any more. */
  hasSettled(): boolean;
}

/**
 * One registered fixture process: the PID, the token the process itself
 * recorded, and the directory its beacon answers from. A fixture that started a
 * child of its own registers that child on the child's own token, because the
 * parent's tree stop may miss it when the parent dies first.
 */
export interface OwnedFixture extends FixtureProcessRecord {
  readonly child?: number | null;
  readonly childToken?: string | null;
}

/** One test's fixture scope: its own stop, its processes and its work. */
interface FixtureScope {
  readonly stop: AbortController;
  readonly processes: Set<OwnedProcess>;
  readonly fixtures: FixtureProcessRecord[];
  readonly work: Set<OwnedWork>;
  disposing: boolean;
  disposed: boolean;
}

function newScope(): FixtureScope {
  return {
    stop: new AbortController(),
    processes: new Set(),
    fixtures: [],
    work: new Set(),
    disposing: false,
    disposed: false,
  };
}

/**
 * The scope of the test that is running. It is replaced as soon as one test's
 * disposal finishes.
 */
let scope: FixtureScope = newScope();

/**
 * The scope each async context's fixture calls belong to. A context is bound the
 * first time it asks for one, and never rebound: the test body's context is
 * bound to the test's scope, and every continuation that context creates — the
 * operation a fixture registered, the command it started — carries the binding,
 * so a continuation that resumes after its test ended still sees the *closed*
 * scope it started in instead of whatever test is running by then.
 *
 * A hook cannot make that binding for the body. Its own async context is not the
 * one a test body runs in (measured on vitest 5: a store entered by a
 * `beforeEach` is not visible in the body), so binding where the first call is
 * made is the only place the body and its continuations are both reachable.
 */
const contexts = new AsyncLocalStorage<FixtureScope>();

/**
 * One owner a finished test could not confirm ended, and how it is confirmed.
 * `directory` is `null` when the scope cannot say which directory the owner ran
 * in — an operation that was still unsettled — which is a hold on every
 * directory the test had registered. Whatever the shape, a hold outlives the
 * scope that made it: the hooks that follow keep preserving those directories,
 * so the next test's cleanup cannot remove what the previous test's unconfirmed
 * owner may still be writing into.
 */
interface UnconfirmedOwner {
  readonly directory: string | null;
  /** What the owner is, as a failure message names it. */
  readonly what: string;
  /** Whether every owner of this directory is now confirmed to have ended. */
  confirmedGone(): Promise<boolean>;
}

/** The holds the registry keeps: every one of them names its directory. */
interface HeldDirectory extends UnconfirmedOwner {
  readonly directory: string;
}

/** The holds earlier tests left behind, still keeping their directories. */
const heldDirectories: HeldDirectory[] = [];

/**
 * The scope a fixture call belongs to: the one its context was bound to, or —
 * for the first call a context makes — the scope of the test running now, which
 * that context is then bound to for good.
 */
function currentScope(): FixtureScope {
  const bound = contexts.getStore();
  if (bound !== undefined) {
    return bound;
  }
  contexts.enterWith(scope);
  return scope;
}

/** The stop of the test that is running, for a fixture that runs the thing itself. */
export function fixtureStop(): AbortSignal {
  return currentScope().stop.signal;
}

/** The stop of the test that is running, plus one a caller supplied itself. */
export function combineStop(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const supplied = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return supplied.length === 0 ? currentScope().stop.signal : AbortSignal.any(supplied);
}

/**
 * Registers one asynchronous operation as owned by the running test, hands it
 * the test's own stop, and refuses to start it once disposal has begun. The
 * returned promise is the operation's own: the caller awaits the same work the
 * lifecycle waits for, bounded, before any directory is removed.
 */
export function ownFixtureOperation<T>(
  what: string,
  run: (stop: AbortSignal) => Promise<T>,
): Promise<T> {
  const running = currentScope();
  if (running.disposing) {
    return Promise.reject(
      new Error(`${what} was refused: the test's fixtures are already being disposed`),
    );
  }
  let work: Promise<T>;
  try {
    work = run(running.stop.signal);
  } catch (cause) {
    work = Promise.reject(cause);
  }
  let settled = false;
  const owned: OwnedWork = {
    what,
    settled: work.then(
      () => undefined,
      () => undefined,
    ),
    hasSettled: () => settled,
  };
  running.work.add(owned);
  void owned.settled.then(() => {
    settled = true;
    running.work.delete(owned);
  });
  return work;
}

/**
 * Registers one child process a fixture started itself — the built CLI, a
 * stand-in runtime — so disposal stops its tree and waits for it to end. The
 * caller keeps its own promise over the same exit.
 */
export function ownChildProcess(what: string, child: ChildProcess, cwd: string): Promise<void> {
  const ended = new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
  const owned: OwnedProcess = {
    what,
    pid: child.pid,
    cwd,
    ended,
    hasEnded: () => child.exitCode !== null || child.signalCode !== null,
  };
  const running = currentScope();
  if (running.disposing) {
    // The caller has the child already; the scope still stops it, but nothing
    // may be registered as if it belonged to the next test.
    void stopProcess(owned);
    return ended;
  }
  running.processes.add(owned);
  void ended.then(() => running.processes.delete(owned));
  return ended;
}

/**
 * Remembers one fixture process, and the child it started, before any
 * assertion, so a failure or a timeout still cleans up.
 */
export function ownFixtureProcess(record: OwnedFixture): void {
  const running = currentScope();
  if (running.disposing) {
    // The test this record belongs to has already been disposed: the process is
    // stopped rather than pushed into a scope whose hook has already looked at
    // what it owned, and it is never registered as the next test's.
    stopLateFixture(record);
    return;
  }
  running.fixtures.push({
    pid: record.pid,
    token: record.token,
    beaconDirectory: record.beaconDirectory,
  });
  if (record.child !== undefined && record.child !== null && record.childToken != null) {
    running.fixtures.push({
      pid: record.child,
      token: record.childToken,
      beaconDirectory: record.beaconDirectory,
    });
  }
}

/**
 * Stops a fixture process whose own test has ended. Only a process whose own
 * beacon still answers is signalled, exactly as in disposal: a bare PID is never
 * enough to end anything by, and the stop is the best the disposed scope can do
 * for work that arrived too late to be awaited by its hook.
 */
function stopLateFixture(record: OwnedFixture): void {
  const recorded: FixtureProcessRecord[] = [
    { pid: record.pid, token: record.token, beaconDirectory: record.beaconDirectory },
  ];
  if (record.child !== undefined && record.child !== null && record.childToken != null) {
    recorded.push({
      pid: record.child,
      token: record.childToken,
      beaconDirectory: record.beaconDirectory,
    });
  }
  for (const one of recorded) {
    void endFixtureTree(one);
  }
}

/** Whether one owned fixture process is still answering through its own beacon. */
export async function ownedFixtureAnswers(record: FixtureProcessRecord): Promise<boolean> {
  return !(await fixtureProcessGone({ dir: record.beaconDirectory }, record.token ?? ''));
}

/** How long a stop is given to become visible through a process's own beacon. */
const GONE_POLL_MS = 100;
const GONE_BOUND_MS = STOP_GRACE_MS;

/** Waits, bounded, for one fixture's beacon to fall silent. */
async function awaitFixtureGone(record: FixtureProcessRecord): Promise<boolean> {
  if (record.token === null) {
    return true;
  }
  const deadline = Date.now() + GONE_BOUND_MS;
  for (;;) {
    if (await fixtureProcessGone({ dir: record.beaconDirectory }, record.token)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, GONE_POLL_MS));
  }
}

/**
 * Stops every registered fixture process and waits, bounded, for the stop to be
 * confirmed through the process's own beacon. Only a process whose beacon
 * answers is signalled, and a fixture that no longer answers is simply gone.
 * Returns what could not be confirmed, so a caller reports it rather than
 * removing the directory a live process still holds.
 */
async function stopOwnedFixtures(running: FixtureScope): Promise<DisposalProblems> {
  const problems = new DisposalProblems();
  for (const record of running.fixtures.splice(0)) {
    const stopped = await endFixtureTree(record);
    const gone = stopped ? await awaitFixtureGone(record) : !(await ownedFixtureAnswers(record));
    if (!gone) {
      const what = `fixture process ${String(record.pid)}`;
      problems.push(
        stopped
          ? `${what} still answers on its own beacon after its stop`
          : `${what} could not be stopped and still answers on its beacon`,
        {
          directory: record.beaconDirectory,
          what,
          // Asked again by the hooks that follow, and released only on the
          // process's own answer: a silent beacon is the one proof it is gone.
          confirmedGone: async () =>
            record.token === null ||
            (await fixtureProcessGone({ dir: record.beaconDirectory }, record.token)),
        },
      );
    }
  }
  return problems;
}

/**
 * Stops one process's tree, reporting why the request itself failed when it did.
 * Only a PID this suite recorded is ever named, and a process the host already
 * reported ending is not signalled at all.
 */
async function stopProcess(owned: OwnedProcess): Promise<string | null> {
  const { pid } = owned;
  if (pid === undefined || owned.hasEnded()) {
    return null;
  }
  return await requestTreeStop(pid);
}

/** Stops every process still running, waiting for each to end within the bound. */
async function stopOwnedProcesses(running: FixtureScope): Promise<DisposalProblems> {
  const problems = new DisposalProblems();
  for (const owned of [...running.processes]) {
    await stopProcess(owned).catch((cause: unknown) => {
      problems.push(`${owned.what} could not be stopped: ${messageOf(cause)}`);
    });
    if (owned.hasEnded() || (await within(owned.ended, STOP_GRACE_MS))) {
      running.processes.delete(owned);
      continue;
    }
    problems.push(`${owned.what} (${String(owned.pid ?? '')}) did not end after its stop`, {
      directory: owned.cwd,
      what: owned.what,
      // Deliberately cheap: a later hook asks again, and a stop that is still
      // being confirmed is never waited out twice.
      confirmedGone: async () => owned.hasEnded(),
    });
  }
  return problems;
}

/** What a disposal found: the failures, and the directories it must not remove. */
class DisposalProblems {
  readonly messages: string[] = [];
  /** The owners of this test that could not be confirmed ended. */
  readonly held: UnconfirmedOwner[] = [];
  /** Set when the scope cannot say which directory the unfinished work holds. */
  preserveEverything = false;

  push(message: string, owner?: UnconfirmedOwner): void {
    this.messages.push(message);
    if (owner !== undefined) {
      this.held.push(owner);
    }
  }

  merge(other: DisposalProblems): void {
    this.messages.push(...other.messages);
    this.held.push(...other.held);
    this.preserveEverything = this.preserveEverything || other.preserveEverything;
  }
}

/**
 * Waits, bounded, for every registered operation to settle. An operation that
 * has not settled when the bound expires is reported, and nothing is removed:
 * the scope cannot say which directory that work still holds.
 */
async function settleOwnedWork(running: FixtureScope): Promise<DisposalProblems> {
  const problems = new DisposalProblems();
  const pending = [...running.work];
  if (pending.length === 0) {
    return problems;
  }
  const settled = await within(
    Promise.all(pending.map((owned) => owned.settled)).then(() => undefined),
    STOP_GRACE_MS,
  );
  if (settled) {
    return problems;
  }
  for (const owned of pending) {
    problems.push(`${owned.what} was still running when the test's fixtures were disposed`, {
      // Which directory a still-running operation holds is exactly what is
      // unknown, so its hold covers everything this test registered until the
      // operation itself says it has settled.
      directory: null,
      what: owned.what,
      confirmedGone: async () => owned.hasSettled(),
    });
  }
  // So nothing this test registered is removed while it is unsettled.
  problems.preserveEverything = true;
  return problems;
}

/**
 * The holds whose owners are still unconfirmed. A hold whose owner has answered
 * that it is gone is dropped here, and dropping it is what lets the directory it
 * kept be removed: nothing is released on a guess, only on the owner's answer.
 */
async function unresolvedHolds(): Promise<readonly HeldDirectory[]> {
  const remaining: HeldDirectory[] = [];
  for (const one of heldDirectories.splice(0)) {
    if (!(await one.confirmedGone())) {
      remaining.push(one);
    }
  }
  return remaining;
}

/**
 * Ends the fixture lifecycle of one test. The test's own stop is aborted first,
 * so the work that took it cancels itself; then every owned process is stopped
 * and awaited; then the hook waits, bounded, for each registered operation to
 * settle. Only after all of that are the temporary directories removed — and a
 * directory an unconfirmed owner might still hold is kept and reported, so a
 * leaked process fails the test that leaked it instead of being quietly removed
 * with its tree. A hold an earlier test left is asked again first and released
 * only if its owner now answers that it is gone, so what one hook had to keep is
 * never removed by the next one on the strength of the current test's problems
 * alone.
 *
 * The hook runs after a passing test, after an assertion failure, after a setup
 * failure and after a timeout, which is what makes the lifecycle the same in
 * each case. It is idempotent, so a test that disposed its own fixtures is not
 * disposed twice.
 */
export async function disposeFixtures(running: FixtureScope = currentScope()): Promise<void> {
  if (running.disposing) {
    return;
  }
  running.disposing = true;
  running.stop.abort();
  const problems = await stopOwnedFixtures(running);
  problems.merge(await stopOwnedProcesses(running));
  problems.merge(await settleOwnedWork(running));

  // A directory an earlier test's unconfirmed owner may still hold stays out of
  // automatic cleanup until that owner answers: the hook of the next test must
  // not remove what the previous one kept. The holds that follow name their
  // directories, so a test whose work never settled does not wall off the
  // directories later tests create.
  const stillHeld = await unresolvedHolds();
  const seen: string[] = [];
  const kept = await cleanupTempDirectories({
    preserve: (directory) => {
      seen.push(directory);
      return (
        problems.preserveEverything ||
        names(stillHeld, directory) ||
        names(problems.held, directory)
      );
    },
  });
  heldDirectories.push(...stillHeld, ...named(problems.held, seen));
  if (problems.messages.length > 0) {
    const preserved =
      kept.length === 0 ? '' : `; kept ${kept.join(', ')} for the owner that may still hold it`;
    throw new Error(`${problems.messages.join('; ')}${preserved}`);
  }
}

/** Whether one of these owners names, or is held inside, this directory. */
function names(owners: readonly UnconfirmedOwner[], directory: string): boolean {
  return owners.some((one) => one.directory !== null && holds(directory, one.directory));
}

/**
 * The holds to keep for owners whose directory the scope could not name: the
 * directories that existed when the owner was still unsettled, which are exactly
 * the ones the work could have been holding.
 */
function named(owners: readonly UnconfirmedOwner[], seen: readonly string[]): HeldDirectory[] {
  return owners.flatMap((one) =>
    one.directory === null
      ? seen.map((directory) => ({ directory, what: one.what, confirmedGone: one.confirmedGone }))
      : [{ directory: one.directory, what: one.what, confirmedGone: one.confirmedGone }],
  );
}

/** Whether `directory` is, or contains, a path one unconfirmed owner holds. */
function holds(directory: string, held: string): boolean {
  const relative = path.relative(directory, held);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Registers the one cleanup hook a fixture suite uses, and resets the scope for
 * the next test once the hook finishes. The hook disposes the scope it started
 * with; a continuation that outlives its test still holds the closed scope it
 * was bound to, so it cannot start anything new.
 */
export function useFixtureLifecycle(): void {
  afterEach(async () => {
    const running = scope;
    try {
      await disposeFixtures(running);
    } finally {
      scope = newScope();
    }
  });
}

/**
 * Runs one real command and waits for it to end: its stdout, its stderr, and
 * the code or signal it ended with. The child is owned from the moment it is
 * spawned, so the cleanup hook can wait for it; a command given a deadline or a
 * stop — the test's own, or the one the fixture passed — is killed as a tree,
 * and the promise rejects only once the process is gone (an unconfirmed stop is
 * reported instead of being raced against). A command asked for after the test's
 * fixtures began to be disposed is refused outright, so a continuation that
 * resumes late cannot start one behind the hook's back.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const running = currentScope();
  if (running.disposing) {
    return Promise.reject(
      new Error(
        `"${command}" was refused: the test's fixtures are already being disposed, and ` +
          'nothing starts behind the cleanup hook',
      ),
    );
  }
  const work = new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      // A group of its own on POSIX, so a stop reaches what the command started.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const ended = new Promise<void>((endedResolve) => {
      child.on('close', () => endedResolve());
      child.on('error', () => endedResolve());
    });
    const owned: OwnedProcess = {
      what: `"${command}"`,
      pid: child.pid,
      cwd: options.cwd,
      ended,
      hasEnded: () => child.exitCode !== null || child.signalCode !== null,
    };
    running.processes.add(owned);
    void ended.then(() => running.processes.delete(owned));

    let settled = false;
    // A command whose stop was asked for is answered by the stop, never by the
    // close that the stop itself produced: on Windows a killed process reports
    // an exit code rather than a signal, and reading that as a natural end would
    // report a stopped command as a completed one.
    let stopping = false;
    const finish = (result: ProcessResult): void => {
      if (settled || stopping) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const fail = (problem: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new Error(problem));
    };

    let deadline: NodeJS.Timeout | undefined;
    const stopNow = (reason: string): void => {
      if (stopping) return;
      stopping = true;
      void stopProcess(owned)
        .then(async (refusal) => {
          // The rejection waits for the process itself, bounded: a killed
          // command that does not end is reported rather than raced.
          if (await within(ended, STOP_GRACE_MS)) {
            running.processes.delete(owned);
            fail(reason);
          } else if (refusal !== null) {
            fail(`${reason}; the stop could not be carried out: ${refusal}`);
          } else {
            fail(`${reason}; the process did not end after it was stopped`);
          }
        })
        .catch((cause: unknown) => {
          fail(`${reason}; stopping it failed: ${messageOf(cause)}`);
        });
    };

    const stoppedBy = (signal: AbortSignal, reason: string): void => {
      if (signal.aborted) {
        stopNow(reason);
      } else {
        signal.addEventListener('abort', () => stopNow(reason), { once: true });
      }
    };
    // The test's own end is a stop like any other: the hook aborts it before it
    // waits for this promise, so the command is gone before its directory is.
    stoppedBy(running.stop.signal, `"${command}" was stopped because the test ended`);
    if (options.stop !== undefined) {
      stoppedBy(options.stop, `"${command}" was stopped while the test was still running`);
    }
    if (options.timeoutMs !== undefined) {
      deadline = setTimeout(() => {
        stopNow(`"${command}" did not end within its ${String(options.timeoutMs)} ms bound`);
      }, options.timeoutMs);
      deadline.unref?.();
    }

    child.on('error', (cause) => {
      fail(`"${command}" could not be started: ${messageOf(cause)}`);
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr });
    });
  });
  // The command is owned work as well as an owned process: disposal waits,
  // bounded, for this promise to settle, so the caller is never told about a
  // directory that was removed while the command it started was still answering.
  let settledWork = false;
  const owned: OwnedWork = {
    what: `"${command}"`,
    settled: work.then(
      () => undefined,
      () => undefined,
    ),
    hasSettled: () => settledWork,
  };
  running.work.add(owned);
  void owned.settled.then(() => {
    settledWork = true;
    running.work.delete(owned);
  });
  return work;
}
