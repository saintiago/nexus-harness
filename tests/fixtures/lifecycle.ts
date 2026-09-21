/**
 * The bounded fixture lifecycle every process-starting suite shares.
 *
 * A test owns processes and directories from the moment it starts them: the
 * command runner keeps the child it started, the registry keeps a fixture
 * process by the token only that process recorded, and the cleanup hook stops
 * what is still running, waits for it to be gone, and only then removes the
 * temporary directories. The wait is bounded and proven: a fixture process is
 * asked through its own beacon, so a PID this host has already handed to
 * another process is never signalled (notes/windows-fixture-flakes.md), and a
 * command is stopped by the production tree stop and awaited.
 *
 * Nothing here kills a process it did not start, and nothing retries forever:
 * a stop that cannot be confirmed within the bound is reported as a problem
 * after every owner has been given its chance, never silently removed.
 */

import { spawn, type ChildProcess } from 'node:child_process';
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

/** One command this suite started and has not seen end. */
interface OwnedCommand {
  readonly child: ChildProcess;
  /** Resolves when the process is really gone, never before. */
  readonly ended: Promise<void>;
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

const ownedCommands = new Set<OwnedCommand>();
const ownedFixtures: FixtureProcessRecord[] = [];

/**
 * Remembers one fixture process, and the child it started, before any
 * assertion, so a failure or a timeout still cleans up.
 */
export function ownFixtureProcess(record: OwnedFixture): void {
  ownedFixtures.push({
    pid: record.pid,
    token: record.token,
    beaconDirectory: record.beaconDirectory,
  });
  if (record.child !== undefined && record.child !== null && record.childToken != null) {
    ownedFixtures.push({
      pid: record.child,
      token: record.childToken,
      beaconDirectory: record.beaconDirectory,
    });
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
async function stopOwnedFixtures(): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const record of ownedFixtures.splice(0)) {
    const stopped = await endFixtureTree(record);
    if (stopped && !(await awaitFixtureGone(record))) {
      problems.push(
        `fixture process ${String(record.pid)} still answers on its own beacon after its stop`,
      );
    }
  }
  return problems;
}

/** Stops one command's tree and waits, bounded, for the process itself to end. */
async function stopCommand(owned: OwnedCommand): Promise<void> {
  const pid = owned.child.pid;
  if (pid === undefined) {
    return;
  }
  if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
    return;
  }
  await requestTreeStop(pid);
}

/** Stops every command still running, waiting for each to end within the bound. */
async function stopOwnedCommands(): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const owned of [...ownedCommands]) {
    await stopCommand(owned).catch((cause: unknown) => {
      problems.push(`an owned command could not be stopped: ${messageOf(cause)}`);
    });
    if (!(await within(owned.ended, STOP_GRACE_MS))) {
      problems.push(`owned command ${String(owned.child.pid ?? '')} did not end after its stop`);
      continue;
    }
    ownedCommands.delete(owned);
  }
  return problems;
}

/**
 * Ends the fixture lifecycle of one test: every owned process is stopped and
 * awaited, and only then are the temporary directories removed. A stop that
 * could not be confirmed is reported as an error after all owners had their
 * chance, so a leaked process fails the test that leaked it instead of being
 * quietly removed with its directory.
 */
export async function disposeFixtures(): Promise<void> {
  const problems = [...(await stopOwnedFixtures()), ...(await stopOwnedCommands())];
  await cleanupTempDirectories();
  if (problems.length > 0) {
    throw new Error(problems.join('; '));
  }
}

/**
 * Registers the one cleanup hook a fixture suite uses. It runs after a passing
 * test, after an assertion failure, after a setup failure and after a timeout,
 * which is what makes the lifecycle the same in each case.
 */
export function useFixtureLifecycle(): void {
  afterEach(disposeFixtures);
}

/**
 * Runs one real command and waits for it to end: its stdout, its stderr, and
 * the code or signal it ended with. The child is owned from the moment it is
 * spawned, so the cleanup hook can wait for it; a command given a deadline or a
 * stop is killed as a tree, and the promise rejects only once the process is
 * gone (an unconfirmed stop is reported instead of being raced against).
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
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
    const owned: OwnedCommand = { child, ended };
    ownedCommands.add(owned);
    void ended.then(() => ownedCommands.delete(owned));

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
      void stopCommand(owned)
        .then(async () => {
          // The rejection waits for the process itself, bounded: a killed
          // command that does not end is reported rather than raced.
          if (await within(ended, STOP_GRACE_MS)) {
            ownedCommands.delete(owned);
            fail(reason);
          } else {
            fail(`${reason}; the process did not end after it was stopped`);
          }
        })
        .catch((cause: unknown) => {
          fail(`${reason}; stopping it failed: ${messageOf(cause)}`);
        });
    };

    if (options.stop !== undefined) {
      const onAbort = (): void => {
        stopNow(`"${command}" was stopped while the test was still running`);
      };
      if (options.stop.aborted) {
        onAbort();
      } else {
        options.stop.addEventListener('abort', onAbort, { once: true });
      }
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
}
