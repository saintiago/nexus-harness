/**
 * Stopping a process tree this harness started: the one supported way to end an
 * invocation and everything it started, and the grace it is given.
 *
 * The coding runtime adapter stops what it started the same way, so this is the
 * host's one stop for both. Only a PID this harness recorded for an invocation
 * it started is ever named, so no other process on the host can be selected.
 */
import { spawn } from 'node:child_process';
import { messageOf } from '../shared/errors.js';

/**
 * How long the harness waits for an invocation it stopped to actually end
 * before recording the stop as unconfirmed. `taskkill /F` and a group `SIGKILL`
 * both end what they name before returning, so this only elapses when the stop
 * did not reach it — and an invocation that ends by itself in that window is
 * still confirmed, so the wait is never skipped. The coding runtime adapter
 * gives a stopped runtime the same wait, so both stops are confirmed the same way.
 */
export const STOP_GRACE_MS = 5000;

/** Waits for `work`, but no longer than `ms`; says whether it finished in time. */
export function within(work: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void work.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Runs one host utility to completion and reports why it failed, if it did. */
function runHostUtility(executable: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (problem: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(problem);
      }
    };

    let utility;
    try {
      utility = spawn(executable, [...args], { stdio: 'ignore', windowsHide: true });
    } catch (cause) {
      done(`"${executable}" could not be run: ${messageOf(cause)}`);
      return;
    }

    // A utility that cannot even be started — no `taskkill` on this host's
    // PATH, say — is a failed stop, never a silent one.
    utility.on('error', (cause) => done(`"${executable}" could not be run: ${messageOf(cause)}`));
    utility.on('close', (code) => {
      done(code === 0 ? null : `"${executable}" exited with code ${String(code)}`);
    });
  });
}

/**
 * Asks the operating system to end one process tree this module started, and
 * says what the request itself did: `null` when it succeeded, otherwise why it
 * did not. Only the recorded PID of an owned invocation is ever named, so no
 * other process on the host can be selected here.
 *
 * The coding runtime adapter stops what it started the same way, so this is the
 * host's one supported stop for both (docs/architecture.md §2: the adapter owns
 * the runtime's calls, and the host's process plumbing is not a runtime's).
 */
export async function requestTreeStop(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') {
    // Every invocation is started as its own process-group leader, so the group
    // is addressed by the negated PID and its members go with it.
    try {
      process.kill(-pid, 'SIGKILL');
      return null;
    } catch (cause) {
      // Nothing left in the group is the outcome this asked for.
      const code = (cause as NodeJS.ErrnoException).code;
      return code === 'ESRCH'
        ? null
        : `the process group of ${String(pid)} could not be signalled: ${messageOf(cause)}`;
    }
  }

  // `/T` reaches the children the invocation started, and `/F` ends them
  // instead of asking a window that may never answer.
  return runHostUtility('taskkill', ['/PID', String(pid), '/T', '/F']);
}
