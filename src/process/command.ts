/**
 * Running one configured command in the task working copy, and recording what
 * happened.
 *
 * A command is an executable plus literal arguments (docs/WORKFLOW.md section
 * 1), and it is launched as such: nothing here builds a command line out of
 * text, no task or configuration string is interpolated, and argument
 * boundaries survive. The invocation itself — starting it, bounding it, and
 * stopping the tree it becomes — is `process/invocation.ts`; this module gives
 * it the two log files its output goes to and records the result: the configured
 * arguments, the working directory, start and end times, the exit code or
 * signal, a launch error, and where its output went. A command that never
 * started is reported as `failed-to-launch` with a `null` exit code, so it can
 * never be mistaken for a command that ran and succeeded.
 *
 * Every invocation is bounded, and when its limit expires, or the run is
 * stopped by its caller, the invocation and the process tree it started are
 * stopped rather than waited for. Limits and stops belong to the caller; the
 * meaning of a result belongs to checks/round.ts.
 */
import { openCommandLog } from '../reporting/logs.js';
import type { Command, CommandResult } from '../shared/types.js';
import { runInvocation } from './invocation.js';

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
/**
 * Runs one configured command in `cwd`, writes its standard output and standard
 * error to their own log files under `logsDir`, and returns what happened. A
 * failure to start the command is part of that result, not an exception; a
 * failure to persist its output is a {@link ReportError}.
 *
 * The invocation is bounded and stopable exactly as {@link runInvocation}
 * bounds and stops one: it is stopped when `timeoutMs` expires or the run's stop
 * request arrives, and the result says which, and whether that stop was
 * confirmed.
 */
export async function runCommand(request: RunCommandRequest): Promise<CommandResult> {
  const { command, cwd, logsDir, label, timeoutMs, stop, env } = request;

  const log = await openCommandLog(logsDir, label);
  const startedAt = new Date().toISOString();

  const result = await runInvocation({
    command,
    cwd,
    timeoutMs,
    // The invocation inherits this process's environment unless the caller
    // supplied one; a source run supplies a copy without the Jira token.
    ...(env === undefined ? {} : { env }),
    ...(stop === undefined ? {} : { stop }),
    onStdout: (chunk: string) => {
      log.writeStdout(chunk);
    },
    onStderr: (chunk: string) => {
      log.writeStderr(chunk);
    },
  });

  await log.close();
  return {
    command: [...command],
    cwd,
    startedAt,
    endedAt: new Date().toISOString(),
    outcome: result.outcome,
    exitCode: result.exitCode,
    signal: result.signal,
    launchError: result.launchError,
    timeoutMs: result.timeoutMs,
    termination: result.termination,
    terminationProblem: result.terminationProblem,
    stdoutPath: log.stdoutPath,
    stderrPath: log.stderrPath,
  };
}
