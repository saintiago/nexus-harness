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

/**
 * How much of a host utility's own words a failed stop repeats, per stream.
 * `taskkill` says why it failed — `ERROR: The process "1234" not found.` for a
 * PID nothing holds — and that reason is what tells a stop that reached nothing
 * because the process had already ended apart from one that was refused for
 * another cause. `taskkill /T` also reports a failure only after naming every
 * child it ended, so the two streams are kept apart and each is bounded as it
 * arrives: a long success prefix on standard output must not crowd the failure's
 * own explanation out of the record.
 */
const MAX_UTILITY_DIAGNOSTIC_CHARS = 200;

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

/** One stream of a host utility's words, kept only up to the bound as it arrives. */
class BoundedWords {
  private kept = '';
  private lost = false;

  /** Keeps what fits of one chunk the utility wrote, and notes that more came. */
  note(chunk: string): void {
    const room = MAX_UTILITY_DIAGNOSTIC_CHARS - this.kept.length;
    if (room <= 0) {
      this.lost = this.lost || chunk.trim() !== '';
      return;
    }
    this.kept += chunk.slice(0, room);
    this.lost = this.lost || chunk.slice(room).trim() !== '';
  }

  /** What it said, flattened onto one line, saying so when it kept only part. */
  said(): string {
    const flat = this.kept.replace(/\s+/g, ' ').trim();
    if (flat === '') {
      return '';
    }
    return this.lost ? `${flat} [truncated]` : flat;
  }
}

/**
 * The bounded words of one host utility run, per stream. A failed stop repeats
 * what the utility wrote to standard error — its own explanation of the failure
 * — and falls back to standard output for a utility that explained itself there
 * instead.
 */
export interface HostUtilityWords {
  /** Notes one chunk the utility wrote to standard output. */
  noteStdout(chunk: string): void;
  /** Notes one chunk the utility wrote to standard error. */
  noteStderr(chunk: string): void;
  /** What a failed run repeats: `: <its own words>`, or nothing when it said none. */
  failureDetail(): string;
}

/**
 * Collects one host utility run's words, each stream bounded as it arrives.
 * Exported for the regression that drives a failure after a long success prefix
 * directly, so the case is deterministic without starting a system process.
 */
export function collectHostUtilityWords(): HostUtilityWords {
  const stdout = new BoundedWords();
  const stderr = new BoundedWords();
  return {
    noteStdout: (chunk) => {
      stdout.note(chunk);
    },
    noteStderr: (chunk) => {
      stderr.note(chunk);
    },
    failureDetail: () => {
      const failure = stderr.said();
      const said = failure === '' ? stdout.said() : failure;
      return said === '' ? '' : `: ${said}`;
    },
  };
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
      utility = spawn(executable, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      done(`"${executable}" could not be run: ${messageOf(cause)}`);
      return;
    }

    const words = collectHostUtilityWords();
    utility.stdout?.setEncoding('utf8');
    utility.stdout?.on('data', (chunk: string) => words.noteStdout(chunk));
    utility.stderr?.setEncoding('utf8');
    utility.stderr?.on('data', (chunk: string) => words.noteStderr(chunk));

    // A utility that cannot even be started — no `taskkill` on this host's
    // PATH, say — is a failed stop, never a silent one.
    utility.on('error', (cause) => done(`"${executable}" could not be run: ${messageOf(cause)}`));
    utility.on('close', (code) => {
      done(
        code === 0
          ? null
          : `"${executable}" exited with code ${String(code)}${words.failureDetail()}`,
      );
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
