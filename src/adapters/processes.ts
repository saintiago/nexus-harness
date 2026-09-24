import { spawn, type ChildProcess } from 'node:child_process';
import { fault, messageOf, type Result } from '../result.js';

/** A supplied command with its working directory, environment and optional time limit. */
export type ProcessCommand = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly directory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeLimitMs?: number;
  /**
   * Text to deliver as UTF-8 on the command's standard input, which ends after it. Absent
   * leaves the command without standard input, as commands that read none require.
   */
  readonly input?: string;
};

/** One chunk of output and the stream that produced it. */
export type ProcessOutput = {
  readonly stream: 'stdout' | 'stderr';
  readonly chunk: Uint8Array;
};

export type ProcessOutputObserver = (output: ProcessOutput) => void;

/** Command data: the exit code of a completed command. */
export type ProcessResult = Result<{ readonly exitCode: number }>;

/**
 * End the command's process group. Children lead their own group because they are spawned
 * detached, so this also ends the processes they started.
 */
function endProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group ended before the signal could be delivered.
  }
}

/**
 * Run a supplied command, emit its stdout and stderr chunks and resolve with its exit code.
 * A nonzero exit is a command result; a launch failure, a time limit, a signal termination or
 * a command that did not consume its supplied standard input is a fault.
 */
export function run(
  command: ProcessCommand,
  onOutput: ProcessOutputObserver,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const { executable, timeLimitMs, input } = command;
    let child: ChildProcess;
    try {
      child = spawn(executable, [...command.args], {
        cwd: command.directory,
        env: command.environment,
        detached: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(fault(`Cannot start "${executable}": ${messageOf(error)}`));
      return;
    }

    let settled = false;
    let timedOut = false;
    let inputFailure: string | null = null;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const emit = (stream: ProcessOutput['stream'], chunk: Uint8Array): void => {
      try {
        onOutput({ stream, chunk });
      } catch {
        // Observer failures do not affect the command or its result.
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      emit('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      emit('stderr', chunk);
    });

    if (input !== undefined && child.stdin !== null) {
      // A command that ends before it reads its input breaks the pipe, and the pending write
      // reports that as an error event. Reading it here keeps an early exit a fault instead of
      // an unhandled exception, and the close handler reports it rather than a command result.
      child.stdin.on('error', (error) => {
        inputFailure ??= error.message;
      });
      try {
        child.stdin.end(input, 'utf8');
      } catch (error) {
        inputFailure ??= messageOf(error);
      }
    }

    child.on('error', (error) => {
      finish(fault(`Cannot start "${executable}": ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(fault(`Command "${executable}" exceeded its ${timeLimitMs} ms time limit`));
      } else if (inputFailure !== null) {
        finish(
          fault(
            `Command "${executable}" did not receive its complete standard input: ${inputFailure}`,
          ),
        );
      } else if (input !== undefined && child.stdin?.writableFinished === false) {
        finish(fault(`Command "${executable}" ended before consuming its supplied standard input`));
      } else if (code !== null) {
        finish({ ok: true, value: { exitCode: code } });
      } else {
        finish(fault(`Command "${executable}" ended by signal ${signal ?? 'unknown'}`));
      }
    });

    if (timeLimitMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        endProcessGroup(child.pid);
      }, timeLimitMs);
    }
  });
}
