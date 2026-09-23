import { spawn, type ChildProcess } from 'node:child_process';
import type { Result } from '../result.js';

/** A supplied command with its working directory, environment and optional time limit. */
export type ProcessCommand = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly directory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeLimitMs?: number;
};

/** One chunk of output and the stream that produced it. */
export type ProcessOutput = {
  readonly stream: 'stdout' | 'stderr';
  readonly chunk: Uint8Array;
};

export type ProcessOutputObserver = (output: ProcessOutput) => void;

/** Command data: the exit code of a completed command. */
export type ProcessResult = Result<{ readonly exitCode: number }>;

/** Render a thrown value as a message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fault(message: string): ProcessResult {
  return { ok: false, fault: { message } };
}

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
 * A nonzero exit is a command result; a launch failure, a time limit or a signal termination
 * is a fault.
 */
export function run(
  command: ProcessCommand,
  onOutput: ProcessOutputObserver,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const { executable, timeLimitMs } = command;
    let child: ChildProcess;
    try {
      child = spawn(executable, [...command.args], {
        cwd: command.directory,
        env: command.environment,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(fault(`Cannot start "${executable}": ${messageOf(error)}`));
      return;
    }

    let settled = false;
    let timedOut = false;
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

    child.on('error', (error) => {
      finish(fault(`Cannot start "${executable}": ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish(fault(`Command "${executable}" exceeded its ${timeLimitMs} ms time limit`));
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
