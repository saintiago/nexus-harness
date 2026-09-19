/**
 * Running one configured command in the task working copy, and recording what
 * happened.
 *
 * A command is an executable plus literal arguments (docs/WORKFLOW.md section
 * 1), and it is launched as such: nothing here builds a command line out of
 * text, no task or configuration string is interpolated, and argument
 * boundaries survive. Every invocation is recorded: the configured arguments,
 * the working directory, start and end times, the exit code or signal, a launch
 * error, and the two log files its output went to. A command that never
 * started is reported as `failed-to-launch` with a `null` exit code, so it can
 * never be mistaken for a command that ran and succeeded.
 *
 * Every invocation is bounded, and when its limit expires, or the run is
 * stopped by its caller, the invocation and the process tree it started are
 * stopped rather than waited for. Limits and stops belong to the caller; the
 * meaning of a result belongs to checks/round.ts.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { openCommandLog } from '../reporting/logs.js';
import { messageOf } from '../shared/errors.js';
import type {
  Command,
  CommandOutcome,
  CommandResult,
  TerminationOutcome,
} from '../shared/types.js';
import { planLaunch } from './launch.js';
import { requestTreeStop, within, STOP_GRACE_MS } from './stop.js';

/** What one command invocation is asked to do. */
export interface RunCommandRequest {
  /** Executable plus literal arguments. Used exactly as configured. */
  readonly command: Command;
  /** Working directory to run in: the task's working copy. */
  readonly cwd: string;
  /** `<runDir>/logs`, where this invocation's output files are created. */
  readonly logsDir: string;
  /** Names this invocation's two log files, for example `check-2`. */
  readonly label: string;
  /**
   * The limit this invocation runs under, in milliseconds, as a positive
   * number: the smaller of the configured command limit and the remaining task
   * time. The harness stops the invocation and its process tree when the limit
   * expires — it never leaves an invocation running past it — and the result is
   * then recorded as `timed-out`.
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
   * process's own environment, which is what a file-task run uses. A source run
   * passes a copy of it with the Jira credential variable removed, so target
   * commands inherit everything they need and not the token (docs/WORKFLOW.md
   * §7). The environment is never logged, and it is only read here to pass on.
   */
  readonly env?: NodeJS.ProcessEnv;
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
 * Runs one configured command in `cwd`, writes its standard output and standard
 * error to their own log files under `logsDir`, and returns what happened. A
 * failure to start the command is part of that result, not an exception; a
 * failure to persist its output is a {@link ReportError}.
 *
 * The invocation is started in its own process group, so the whole tree it
 * becomes can be stopped as one, and it is stopped when `timeoutMs` expires.
 * The result then says it timed out, and whether that stop was confirmed.
 */
export async function runCommand(request: RunCommandRequest): Promise<CommandResult> {
  const { command, cwd, logsDir, label, timeoutMs, stop, env } = request;
  const executable = command[0] ?? '';
  const args = command.slice(1);

  const log = await openCommandLog(logsDir, label);
  const startedAt = new Date().toISOString();

  const notStarted = (problem: string): CommandResult => ({
    command: [...command],
    cwd,
    startedAt,
    endedAt: new Date().toISOString(),
    outcome: 'failed-to-launch',
    exitCode: null,
    signal: null,
    launchError: problem,
    timeoutMs,
    termination: null,
    terminationProblem: null,
    stdoutPath: log.stdoutPath,
    stderrPath: log.stderrPath,
  });

  /**
   * The run was stopped before this invocation started. Nothing of it ran, so
   * nothing of it is left running: the omission is recorded as the stop it is,
   * never as a launch failure or as an exit.
   */
  const stoppedBeforeStart = (): CommandResult => ({
    command: [...command],
    cwd,
    startedAt,
    endedAt: new Date().toISOString(),
    outcome: 'stopped',
    exitCode: null,
    signal: null,
    launchError: null,
    timeoutMs,
    termination: 'confirmed',
    terminationProblem: null,
    stdoutPath: log.stdoutPath,
    stderrPath: log.stderrPath,
  });

  const directoryProblem = workingDirectoryProblem(cwd);
  if (directoryProblem !== undefined) {
    await log.close();
    return notStarted(directoryProblem);
  }

  const plan = planLaunch(executable, args, cwd);
  if (!plan.ok) {
    await log.close();
    return notStarted(plan.problem);
  }

  if (stop?.aborted === true) {
    // Creating this invocation's log files took a moment, and the run was
    // stopped in it: starting the command now would be starting work after the
    // run that asked for it was already over.
    await log.close();
    return stoppedBeforeStart();
  }

  const { file, args: launcherArgs, verbatim } = plan.launcher;

  const result = await new Promise<CommandResult>((resolve) => {
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
        command: [...command],
        cwd,
        startedAt,
        endedAt: new Date().toISOString(),
        outcome,
        exitCode: started ? code : null,
        signal: started ? signal : null,
        launchError,
        timeoutMs,
        termination,
        terminationProblem,
        stdoutPath: log.stdoutPath,
        stderrPath: log.stderrPath,
      });
    };

    let child;
    try {
      child = spawn(file, [...launcherArgs], {
        cwd,
        // The invocation inherits this process's environment unless the caller
        // supplied one; a source run supplies a copy without the Jira token.
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
    child.stdout.on('data', (chunk: string) => log.writeStdout(chunk));
    child.stderr.on('data', (chunk: string) => log.writeStderr(chunk));

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

  await log.close();
  return result;
}
