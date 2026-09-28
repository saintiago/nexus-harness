import { spawn } from 'node:child_process';
import { messageOf } from '../result.js';

/**
 * The single-writer lock of one memory collection. The lock is a process-scoped OS advisory lock
 * on a file (`flock`), held for the whole insertion — from receipt inspection through add
 * completion and receipt persistence — and released when the holder exits, including an abrupt
 * exit: the holder process reads this process's pipe and ends when the pipe closes. Waiting is
 * bounded by the configured acquisition limit; contention defers the observation instead of
 * stealing a lock, and no timer treats a live holder as stale.
 */

/** A held writer lock. Releasing it waits until the OS lock is actually gone. */
export type WriterLock = {
  release(): Promise<void>;
};

/** What one acquisition attempt observed. */
export type LockAcquisition =
  | { readonly kind: 'acquired'; readonly lock: WriterLock }
  | { readonly kind: 'contended' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** The exit code `flock` reports when the bounded wait elapsed without acquiring the lock. */
const conflictExitCode = '3';

/** The holder program: announce the acquired lock, then hold it until this process's pipe ends. */
const holderProgram = "printf 'locked\\n'; cat > /dev/null";

/**
 * Acquire the writer lock of the supplied lock file, waiting at most `waitMs`. An unavailable
 * `flock` or holder names the reason instead of reporting contention.
 */
export async function acquireWriterLock(file: string, waitMs: number): Promise<LockAcquisition> {
  const seconds = (waitMs / 1000).toFixed(3);
  const child = spawn(
    'flock',
    [
      '--exclusive',
      `--wait=${seconds}`,
      '--conflict-exit-code',
      conflictExitCode,
      file,
      'sh',
      '-c',
      holderProgram,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  // A holder whose reader is gone must not turn into an unhandled stream error.
  child.stdin.on('error', () => undefined);
  // The holder's exit is observed once, so releasing an already exited holder cannot wait for an
  // event that will never fire again.
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const outcome = await new Promise<'acquired' | 'contended' | 'failed'>((resolve) => {
    child.stdout.on('data', () => {
      if (stdout.includes('locked')) {
        resolve('acquired');
      }
    });
    child.once('error', (error) => {
      stderr = `${stderr}${messageOf(error)}`;
      resolve('failed');
    });
    child.once('exit', (code) => {
      resolve(code === Number(conflictExitCode) ? 'contended' : 'failed');
    });
  });

  if (outcome === 'acquired') {
    let released = false;
    return {
      kind: 'acquired',
      lock: {
        async release() {
          if (released) {
            return;
          }
          released = true;
          // End of the holder's input makes it exit, which drops the OS lock; waiting for the
          // exit keeps a later acquisition from racing an operation this lock still owns.
          child.stdin.end();
          await exited;
        },
      },
    };
  }
  if (outcome === 'contended') {
    return { kind: 'contended' };
  }
  const detail = stderr.trim() === '' ? 'no diagnostic' : stderr.trim();
  return {
    kind: 'unavailable',
    reason: `the writer lock at "${file}" could not be acquired: ${detail}`,
  };
}
