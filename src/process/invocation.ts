/**
 * One bounded invocation of an operating-system process, and the one place a
 * process tree the harness started is ended.
 *
 * An invocation is an executable plus literal arguments, launched as such:
 * nothing here builds a command line out of text, so argument boundaries
 * survive. It is always bounded — when its limit expires, or the run it belongs
 * to is stopped by its caller, the invocation and the process tree it started
 * are stopped rather than waited for — and it always says how it ended: the exit
 * code or signal, a launch error, and whether a stop it made was confirmed. A
 * command that never started is reported as `failed-to-launch`, so it can never
 * be mistaken for a command that ran and succeeded.
 *
 * This is the harness's one implementation of that behaviour. `command.ts` uses
 * it for the configured setup and check commands, whose output it writes to
 * their two log files; `workspace/git.ts` uses it for every Git invocation the
 * harness makes, which has to be bounded for exactly the same reason. Limits and
 * stops belong to the caller; the meaning of a result belongs to the caller's
 * own module.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { messageOf } from '../shared/errors.js';
import type { Command, CommandOutcome, TerminationOutcome } from '../shared/types.js';
import { planLaunch } from './launch.js';
import { requestTreeStop, within, STOP_GRACE_MS } from './stop.js';

/** What one invocation is asked to do. */
export interface InvocationRequest {
  /** Executable plus literal arguments. Used exactly as configured. */
  readonly command: Command;
  /** Working directory to run in. */
  readonly cwd: string;
  /**
   * The limit this invocation runs under, in milliseconds, as a positive
   * number: the harness stops the invocation and its process tree when the
   * limit expires — it never leaves an invocation running past it — and the
   * result is then recorded as `timed-out`.
   */
  readonly timeoutMs: number;
  /**
   * Asked to stop the invocation, and everything it started, when the run is
   * stopped by its caller. The invocation is stopped through the same path its
   * limit uses — the whole tree, named by a PID this module recorded — and the
   * result is recorded as `stopped`, with whether that stop was confirmed. A
   * request that has already arrived before the invocation starts stops it from
   * starting at all.
   */
  readonly stop?: AbortSignal;
  /**
   * The environment the invocation is started with. Omitted means this
   * process's own environment. The environment is only read here to pass on: it
   * is never recorded.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Receives each chunk of the invocation's standard output as it arrives. */
  readonly onStdout?: (chunk: string) => void;
  /** Receives each chunk of the invocation's standard error as it arrives. */
  readonly onStderr?: (chunk: string) => void;
}

/** What one invocation did. */
export interface InvocationResult {
  /** How the invocation ended; see {@link CommandOutcome}. */
  readonly outcome: CommandOutcome;
  /** Exit code of an invocation that ran and exited; `null` otherwise. */
  readonly exitCode: number | null;
  /** Terminating signal of an invocation that was killed; `null` otherwise. */
  readonly signal: string | null;
  /** Why the invocation could not be started; `null` when it did run. */
  readonly launchError: string | null;
  /** The limit this invocation ran under, in milliseconds. */
  readonly timeoutMs: number;
  /** Whether a stop the harness made was confirmed; `null` when none was made. */
  readonly termination: TerminationOutcome | null;
  /** What could not be confirmed about a stop; `null` when there was none. */
  readonly terminationProblem: string | null;
}

/** Why a command cannot run in this directory, if it cannot. */
function workingDirectoryProblem(cwd: string): string | undefined {
  try {
    if (statSync(cwd).isDirectory()) {
      return undefined;
    }
    return `"${cwd}" is not a directory`;
  } catch (cause) {
    return `"${cwd}" cannot be used as a working directory: ${messageOf(cause)}`;
  }
}

/**
 * Runs one invocation in `cwd` and returns what happened. A failure to start
 * the invocation is part of that result, not an exception.
 *
 * The invocation is started in its own process group, so the whole tree it
 * becomes can be stopped as one, and it is stopped when `timeoutMs` expires or
 * the caller's stop request arrives. The result then says which of the two
 * stopped it, and whether that stop was confirmed.
 */
export async function runInvocation(request: InvocationRequest): Promise<InvocationResult> {
  const { command, cwd, timeoutMs, stop, env, onStdout, onStderr } = request;
  const executable = command[0] ?? '';
  const args = command.slice(1);

  const notStarted = (problem: string): InvocationResult => ({
    outcome: 'failed-to-launch',
    exitCode: null,
    signal: null,
    launchError: problem,
    timeoutMs,
    termination: null,
    terminationProblem: null,
  });

  /**
   * The run was stopped before this invocation started. Nothing of it ran, so
   * nothing of it is left running: the omission is recorded as the stop it is,
   * never as a launch failure or as an exit.
   */
  const stoppedBeforeStart = (): InvocationResult => ({
    outcome: 'stopped',
    exitCode: null,
    signal: null,
    launchError: null,
    timeoutMs,
    termination: 'confirmed',
    terminationProblem: null,
  });

  const directoryProblem = workingDirectoryProblem(cwd);
  if (directoryProblem !== undefined) {
    return notStarted(directoryProblem);
  }

  const plan = planLaunch(executable, args, cwd);
  if (!plan.ok) {
    return notStarted(plan.problem);
  }

  if (stop?.aborted === true) {
    // The run was stopped in the moment before the invocation started: starting
    // the command now would be starting work after the run that asked for it was
    // already over.
    return stoppedBeforeStart();
  }

  const { file, args: launcherArgs, verbatim } = plan.launcher;

  return await new Promise<InvocationResult>((resolve) => {
    let launchError: string | null = null;
    let settled = false;
    /** Why the harness is stopping this invocation: its limit, or the run's stop. */
    let stopping: 'limit' | 'stop' | null = null;
    let termination: TerminationOutcome | null = null;
    let terminationProblem: string | null = null;
    let lastCode: number | null = null;
    let lastSignal: string | null = null;
    let markEnded: () => void = () => undefined;
    const endedOnce = new Promise<void>((settleEnded) => {
      markEnded = settleEnded;
    });
    let timer: NodeJS.Timeout | null = null;
    /** Held by the run's stop request for exactly as long as this invocation runs. */
    let onStop: (() => void) | null = null;

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (onStop !== null) {
        // The run's stop request outlives this invocation, so this invocation's
        // listener is released rather than left on it.
        stop?.removeEventListener('abort', onStop);
      }
      // A command that never started still reports a nonzero close code on
      // Windows, so the recorded launch error decides the outcome, never the code.
      const started = launchError === null;
      let outcome: CommandOutcome = 'failed-to-launch';
      if (started) {
        if (stopping === 'limit') {
          outcome = 'timed-out';
        } else if (stopping === 'stop') {
          outcome = 'stopped';
        } else {
          outcome = signal === null ? 'exited' : 'signalled';
        }
      }
      resolve({
        outcome,
        exitCode: started ? code : null,
        signal: started ? signal : null,
        launchError,
        timeoutMs,
        termination,
        terminationProblem,
      });
    };

    let child;
    try {
      child = spawn(file, [...launcherArgs], {
        cwd,
        // The invocation inherits this process's environment unless the caller
        // supplied one.
        ...(env === undefined ? {} : { env }),
        // No interactive input: configured commands must not wait for a terminal.
        stdio: ['ignore', 'pipe', 'pipe'],
        // On Windows the invocation is deliberately *not* detached: a detached
        // `cmd.exe` gets a console of its own, and everything the shim then runs
        // writes to that console instead of the pipes this harness captures, so
        // a `.cmd` command would be recorded with an empty output and a zero
        // exit code. The tree is stopped by PID there instead, which needs no
        // process group. Elsewhere the invocation leads its own group, which is
        // what lets the whole tree be signalled at once.
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: verbatim,
        windowsHide: true,
      });
    } catch (cause) {
      launchError = messageOf(cause);
      finish(null, null);
      return;
    }

    /**
     * Ends the invocation and everything it started, once the harness has to:
     * the limit expired, or the run was stopped. The first of those to arrive is
     * the one the result records, and a close event that lands afterwards cannot
     * replace it. Confirmed means the stop request reached the operating system
     * *and* the invocation was seen to end: either half missing is recorded as
     * unconfirmed, because a tree that may still be running must never be
     * reported as stopped.
     */
    const stopOwnedTree = async (why: 'limit' | 'stop'): Promise<void> => {
      if (settled || stopping !== null) {
        // It ended by itself just as the harness stopped it — its own ending is
        // the result — or it is already being stopped for the reason that
        // arrived first.
        return;
      }
      const { pid } = child;
      if (pid === undefined) {
        // Nothing of this invocation ever started, so no tree of ours exists to
        // stop; the launch failure is the result, exactly as it would be without
        // a limit and without a stop request.
        finish(null, null);
        return;
      }
      stopping = why;

      const stopProblem = await requestTreeStop(pid);
      const endedInTime = await within(endedOnce, STOP_GRACE_MS);
      termination = stopProblem === null && endedInTime ? 'confirmed' : 'unconfirmed';
      terminationProblem =
        termination === 'confirmed'
          ? null
          : (stopProblem ??
            `the invocation had not ended ${String(STOP_GRACE_MS)} ms after it was stopped`);
      finish(lastCode, lastSignal);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => onStdout?.(chunk));
    child.stderr.on('data', (chunk: string) => onStderr?.(chunk));

    child.on('error', (cause) => {
      // Only a child that never started is a launch failure; one that already
      // ran reports what happened through 'close'.
      if (child.pid === undefined) {
        launchError = `${messageOf(cause)} (working directory "${cwd}")`;
        finish(null, null);
      }
    });

    child.on('close', (code, signal) => {
      lastCode = code;
      lastSignal = signal;
      markEnded();
      if (stopping !== null) {
        // The stop path is waiting for exactly this end, and owns the result:
        // the invocation is recorded as stopped, with how it was stopped.
        return;
      }
      finish(code, signal);
    });

    if (!settled) {
      timer = setTimeout(() => {
        void stopOwnedTree('limit');
      }, timeoutMs);
    }

    if (stop !== undefined) {
      onStop = () => {
        void stopOwnedTree('stop');
      };
      stop.addEventListener('abort', onStop, { once: true });
      if (stop.aborted) {
        // It arrived between the check above and this listener: the invocation
        // is stopped the same way, rather than left running past the run.
        onStop();
      }
    }
  });
}
