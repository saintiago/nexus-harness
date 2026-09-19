/**
 * `run`: resolve and load everything the user asked for, install the stop, hand
 * the loop its collaborators, and print the outcome.
 *
 * The loaded documents stay as they are for the whole run, and the run answers a
 * user interrupt through the run's own stop request rather than exiting over
 * what it started. What this module does own is the terminal and the exit code,
 * and one rule above all: a run is reported as finished only once its report
 * really exists.
 */
import path from 'node:path';
import { ConfigError, loadHarnessConfig, loadTask, resolveWorkDir } from '../config/load.js';
import { ReportError } from '../reporting/errors.js';
import { RunCancelledError, RunTimeoutError } from '../runs/contracts.js';
import type { RunTaskRequest, RunTaskResult } from '../runs/contracts.js';
import { runTask } from '../runs/runner.js';
import type { HarnessConfig, RunStatus, Task } from '../shared/types.js';
import { WorkspaceError } from '../workspace/errors.js';
import type { RunDirectory } from '../workspace/run-directory.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from './context.js';
import type { CliContext, CliIo } from './context.js';
import { composeDependencies } from './dependencies.js';
import { USAGE_HINT } from './help.js';
import { listOptions } from './options.js';
import type { ParsedOptions } from './options.js';
import { hostSignals } from './signals.js';

/** How the terminal is told a completed run ended, and where it left things. */
function describeOutcome(result: RunTaskResult, maxRepairs: number): string {
  const { run, workspace, status, reason } = result;
  const lines = [
    `run ${run.runId}: ${status}`,
    `  reason     ${reason}`,
    `  repairs    ${String(result.repairsUsed)} of ${String(maxRepairs)} repair turns used`,
    `  run dir    ${run.runDir}`,
    workspace === null
      ? '  workspace  no working copy was prepared (see the reason above)'
      : `  workspace  ${workspace.workspacePath} (branch ${workspace.branch})`,
    `  report     ${result.reportPath}`,
  ];
  // A required save that failed is named here rather than left in the timeline:
  // the run's own evidence is kept, and the ledger a later attempt would read
  // does not hold this attempt.
  if (result.workspaceLedgerProblem !== null) {
    lines.push(`  ledger     ${result.workspaceLedgerProblem}`);
  }
  return lines.join('\n');
}

/** The documented exit code of a run that reached a status. */
function exitCodeFor(status: RunStatus): number {
  if (status === 'passed') {
    return EXIT_OK;
  }
  return status === 'cancelled' ? EXIT_CANCELLED : EXIT_INPUT_ERROR;
}

/**
 * How a run that never reached a result is reported, and with which exit code.
 *
 * These are the failures that end the CLI rather than a run: a stop the runner
 * refused because it arrived before any run directory existed, a deadline that
 * expired in the same window, a preflight that would not accept the source or
 * the output location, and a report that could not be written. None of them is
 * a success, and none of them claims a report: the run directory is named when
 * there is one — a report-write failure keeps everything the run produced
 * except the report itself — and a run that never allocated one says so.
 */
function reportRunFailure(cause: unknown, io: CliIo, allocated: RunDirectory | null): number {
  const retained =
    allocated === null
      ? 'No run directory was allocated: nothing of this run was created.'
      : `The run directory was kept for inspection: "${allocated.runDir}"`;

  if (cause instanceof RunCancelledError) {
    io.err(`cancelled: ${cause.message}`);
    return EXIT_CANCELLED;
  }

  if (cause instanceof ReportError) {
    // The run itself may have ended any way at all — this is the reporting
    // failing, not the task — so nothing is said about the status here, and
    // nothing anywhere says the report exists.
    io.err([`error: the run could not be reported: ${cause.message}`, retained].join('\n'));
    return EXIT_INPUT_ERROR;
  }

  if (cause instanceof WorkspaceError || cause instanceof RunTimeoutError) {
    io.err(
      [cause.message, allocated === null ? null : retained]
        .filter((line) => line !== null)
        .join('\n'),
    );
    return EXIT_INPUT_ERROR;
  }

  throw cause;
}

/**
 * Runs one task: the only command that touches anything.
 *
 * Everything the user asked for is resolved and loaded before a single thing
 * runs, and the loaded documents stay as they are for the whole run: the source
 * repository, the two files, and the plan they hold are fixed before the first
 * command or coding turn, and nothing the working copy, the runtime, or the
 * target project writes can change which commands decide the run.
 *
 * A run that answers a user interrupt does so through the run's own stop
 * request — the same one the phases and the commands are given — and the CLI
 * waits for the run to finalize rather than exiting over what it started. The
 * signal handlers are released as soon as it has, so nothing this call installs
 * outlives it.
 */
export async function runCommand(options: ParsedOptions, context: CliContext): Promise<number> {
  const { cwd, io } = context;
  const { repo: repoArgument, config: configArgument, task: taskArgument } = options;

  if (repoArgument === undefined || configArgument === undefined || taskArgument === undefined) {
    const missing = [
      repoArgument === undefined ? '--repo' : undefined,
      configArgument === undefined ? '--config' : undefined,
      taskArgument === undefined ? '--task' : undefined,
    ].filter((name) => name !== undefined);
    io.err(`error: run requires ${listOptions(missing)}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  // CLI paths resolve from the invocation directory; workDir resolves from the
  // configuration file instead (see resolveWorkDir).
  const repoPath = path.resolve(cwd, repoArgument);
  const configPath = path.resolve(cwd, configArgument);
  const taskPath = path.resolve(cwd, taskArgument);

  let config: HarnessConfig;
  let task: Task;
  try {
    config = await loadHarnessConfig(configPath);
    task = await loadTask(taskPath);
  } catch (cause) {
    if (cause instanceof ConfigError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }

  const stop = new AbortController();
  const release = (context.signals ?? hostSignals()).onInterrupt(() => {
    if (stop.signal.aborted) {
      io.err(
        'interrupt received again: the run is already stopping, and this CLI is still waiting for it to finalize.',
      );
      return;
    }
    io.err(
      [
        'interrupt received: asking the run to stop, and waiting for it to finalize before this',
        'command exits. The run records what it stopped and whether that stop was confirmed.',
      ].join('\n'),
    );
    stop.abort(new Error('the user interrupted the run'));
  });

  /** The run directory the runner allocated, as soon as it has one. */
  const allocation: { run: RunDirectory | null } = { run: null };
  const dependencies = composeDependencies(
    context,
    io,
    (run) => {
      allocation.run = run;
    },
    config.agent,
  );

  const request: RunTaskRequest = {
    task,
    config,
    repoPath,
    workDir: resolveWorkDir(config, configPath),
    stop: stop.signal,
  };

  try {
    const result = await runTask(request, dependencies);
    io.out(describeOutcome(result, config.maxRepairs));
    return exitCodeFor(result.status);
  } catch (cause) {
    return reportRunFailure(cause, io, allocation.run);
  } finally {
    // The run is over, one way or another: nothing is left listening for an
    // interrupt on its behalf.
    release();
  }
}

/**
 * An abortable wait: it resolves when the time is up, or as soon as the stop
 * request arrives. Watch uses it for its poll interval and for the delay after a
 * failed scan, so an interrupt never waits for either to elapse.
 */
