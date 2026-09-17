/**
 * Command line entry point: arguments, help, exit codes, top-level wiring.
 *
 * The exported `runCli` takes its working directory and its output functions as
 * parameters, so argument handling and exit codes are testable in-process, and
 * the `import.meta.url` check at the bottom only runs when this file is the
 * process entry point.
 *
 * The commands, and none of them holds any logic of its own:
 *
 * - `check-config` loads the configuration and, when one is given, a task file.
 *   It is static: it creates nothing, runs nothing, and needs no credentials.
 * - `run` loads the same two files through the same loader, resolves what the
 *   command line asked for, and hands the loop's own collaborators to
 *   {@link runTask} — the preflight, the run directory, the working copy, the
 *   configured checks, the coding turn, and the report (docs/architecture.md
 *   §2). The order those happen in, the repair policy, and the runtime protocol
 *   are not decided here.
 * - `source list`, `source run`, and `source watch` put the one serial intake
 *   coordinator in front of that same `runTask`: the connector is selected
 *   here by a plain branch on `source.type`, and the coordinator is handed
 *   ordinary functions. Only a source command constructs a connector, resolves
 *   a credential, or touches Jira (docs/architecture.md §7).
 *
 * What this module does own is the terminal: the path rules, the progress, the
 * final outcome, and the exit code. And one rule above all: a run is reported as
 * finished only once its report really exists, so a report that could not be
 * written is a failure the user sees rather than a completion they were told.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCodexTurn, selectedCodexRuntime } from './agent.js';
import { runCheckRound } from './checks.js';
import { ConfigError, loadHarnessConfig, loadTask, resolveWorkDir } from './config.js';
import { createJiraSource, resolveJiraToken } from './jira.js';
import { ReportError, appendRunLog, openAgentLog, writeRunReport } from './report.js';
import { RunCancelledError, RunTimeoutError, runTask } from './runner.js';
import type { RunnerDependencies, RunTaskRequest, RunTaskResult } from './runner.js';
import { SourceError, listSource, runSource, watchSource } from './source.js';
import type {
  SourceListEntry,
  SourceContext,
  SourceSummary,
  SourceWatchOptions,
} from './source.js';
import type {
  AgentSelection,
  Command,
  HarnessConfig,
  JiraSourceConfig,
  RunStatus,
  Task,
} from './types.js';
import {
  WorkspaceError,
  allocateRunDirectory,
  prepareWorkspace,
  preflightSource,
  recordWorkspaceAttempt,
} from './workspace.js';
import type { RunDirectory } from './workspace.js';

export const EXIT_OK = 0;
/**
 * The run failed, or the CLI could not get as far as a result: an input file
 * that could not be read or validated, a source or output path preflight
 * refused, or a report that could not be written.
 */
export const EXIT_INPUT_ERROR = 1;
/** The command line itself is wrong: an unknown command or option, a missing value. */
export const EXIT_USAGE = 2;
/**
 * The run was stopped by the user's interrupt. `130` is the conventional shell
 * code for a process ended by `SIGINT`, and the run is finalized — its report
 * written — before the CLI exits with it.
 */
export const EXIT_CANCELLED = 130;

/** Where the CLI writes. Tests pass a recorder instead of the console. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/**
 * How a `run` hears that the user wants it stopped, and how it lets go again.
 *
 * It is the host's own interrupt signals behind an interface, so an interrupt
 * can be delivered in a test without a real signal, and so the two things that
 * matter about it are checkable: that a `run` installs a way to be stopped, and
 * that nothing is left installed once it has ended.
 */
export interface InterruptSignals {
  /**
   * Asks to be told when the user interrupts, and returns the function that
   * releases the request again. A caller releases it when the run is over: an
   * invocation installs nothing that outlives it.
   */
  onInterrupt(handler: () => void): () => void;
}

export interface CliContext {
  /** Directory that relative file arguments resolve from. */
  cwd: string;
  io: CliIo;
  /**
   * The host's interrupt signals; the process's own when a caller gives none.
   */
  signals?: InterruptSignals;
  /**
   * The loop's collaborators, when a caller needs to stand in for one. Merged
   * over the real ones, so a partial set keeps every other collaborator real.
   * A test stands in for the coding turn, because it is the only one that talks
   * to a runtime.
   */
  dependencies?: Partial<RunnerDependencies>;
  /**
   * The HTTP boundary a source command asks Jira through. The process's own
   * `fetch` when a caller gives none: nothing in production substitutes it. A
   * test hands a fake so a preview, a finite run, and a watch cycle can be
   * exercised end to end through the CLI without a live Jira site.
   */
  fetch?: typeof fetch;
}

const HELP = `nexus harness — local-first development harness

Usage: <command> [options]

Commands:
  check-config   Read and validate a configuration file, and a task file when given.
  run            Run a task file through the workspace/check/repair loop.
  source list    Preview the configured task source. Read-only: contacts the source,
                 claims nothing, starts no run, and costs no coding turns.
  source run     Take one finite batch of eligible source tasks and run each one.
  source watch   Do that once, then keep polling for new eligible tasks until stopped.

Options:
  --repo <path>     Source repository to task (run, source run, source watch).
  --config <path>   Configuration file, resolved from the current directory.
  --task <path>     Task file (run; optional for check-config).
  --limit <count>   Most new source tasks one \`source run\` attempts (source run only).
  -h, --help        Show this help.

Examples:
  npm run dev -- --help
  npm run dev -- check-config --config harness.config.json --task examples/task.json
  npm run dev -- run --repo ../target-project --config harness.config.json --task examples/task.json
  npm run dev -- source list --config harness.jira.config.json
  npm run dev -- source run --repo ../target-project --config harness.jira.config.json --limit 1
  npm run dev -- source watch --repo ../target-project --config harness.jira.config.json

Paths given on the command line resolve from the directory the command was invoked
in, exactly as the shell would read them. \`workDir\` resolves from the configuration
file's own directory instead, so the same config names the same output wherever the
command is run from.

check-config is static: it creates nothing, runs no configured command, contacts no
provider or source, resolves no credential, and needs none. With \`--task\` it also
validates that file; without one it validates the configuration alone.

run prepares a working copy of the source repository, runs the configured setup and
checks, asks the coding runtime to implement the task, reruns the checks, and gives
the runtime the observed failures to repair within maxRepairs. Progress and the
outcome are printed; the working copy and the report are always kept. Nothing is
committed, pushed, or published. The run ends at the first of: a green round, a red
round with no repair allowance left, a failure it cannot repair away, the task
deadline, or a user interrupt (Ctrl+C, or Ctrl+Break on Windows), which stops
the run and waits for it to finalize.

source list, source run and source watch are the intake commands. They need a
\`source\` object in the configuration and the credential its \`tokenEnv\` names in the
environment; a source run or watch also needs \`--repo\`. \`source list\` only reads: it
claims nothing and starts nothing. A source run claims each eligible issue it finds,
runs it through the same loop, and posts the result back. source watch does that for
every scan and keeps polling until you stop it. Runs stay sequential, and one local
receipt per issue prevents attempting the same issue twice.

Exit codes:
  0    the run passed
  1    the run failed, or an input, preflight, or reporting error stopped the CLI
  2    usage error (unknown command or option, missing value)
  130  the run was stopped by the user (Ctrl+C, or Ctrl+Break on Windows), and
       was finalized first

Input contract: docs/WORKFLOW.md. Behaviour: docs/spec.md.`;

const USAGE_HINT = 'Run "npm run dev -- --help" for usage.';

interface ParsedOptions {
  readonly repo: string | undefined;
  readonly config: string | undefined;
  readonly task: string | undefined;
  readonly limit: string | undefined;
}

type OptionParse =
  | { readonly ok: true; readonly options: ParsedOptions }
  | { readonly ok: false; readonly message: string };

/**
 * The value options each command accepts, mapped to what a value is. `--repo` is
 * a `run`/`source` option and nothing else: `check-config` reads files and has no
 * source repository, so it reports `--repo` as the unknown option it is for that
 * command. `--limit` belongs to `source run` alone, and `--task` is refused on
 * every source command: a source task comes from the source, not from a file.
 */
const CHECK_CONFIG_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--config', 'a path value'],
  ['--task', 'a path value'],
]);
const RUN_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--repo', 'a path value'],
  ['--config', 'a path value'],
  ['--task', 'a path value'],
]);
const SOURCE_LIST_OPTIONS: ReadonlyMap<string, string> = new Map([['--config', 'a path value']]);
const SOURCE_RUN_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--repo', 'a path value'],
  ['--config', 'a path value'],
  ['--limit', 'a positive integer value'],
]);
const SOURCE_WATCH_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['--repo', 'a path value'],
  ['--config', 'a path value'],
]);

function parseOptions(args: readonly string[], allowed: ReadonlyMap<string, string>): OptionParse {
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);

    if (name === '-h' || name === '--help') {
      // Bare help flags are handled before dispatch; reaching here means "--help=x".
      return { ok: false, message: `option "${name}" does not take a value` };
    }

    const wanted = allowed.get(name);
    if (wanted === undefined) {
      return { ok: false, message: `unknown option "${name}"` };
    }

    if (values.has(name)) {
      return { ok: false, message: `option "${name}" was given more than once` };
    }

    if (inlineValue !== undefined) {
      if (inlineValue === '') {
        return { ok: false, message: `option "${name}" requires ${wanted}` };
      }
      values.set(name, inlineValue);
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      return { ok: false, message: `option "${name}" requires ${wanted}` };
    }
    values.set(name, value);
    index += 1;
  }

  return {
    ok: true,
    options: {
      repo: values.get('--repo'),
      config: values.get('--config'),
      task: values.get('--task'),
      limit: values.get('--limit'),
    },
  };
}

/** `"--repo, --config and --task"`: the options one command was not given. */
function listOptions(names: readonly string[]): string {
  const [only] = names;
  if (names.length === 1 && only !== undefined) {
    return only;
  }
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function commandCount(commands: readonly Command[]): string {
  return `${commands.length} ${commands.length === 1 ? 'command' : 'commands'}`;
}

function describeConfig(config: HarnessConfig, configPath: string, workDir: string): string {
  const lines = [
    `check-config: ${configPath} is valid`,
    `  workDir                ${workDir} (resolved from this file)`,
    `  maxRepairs             ${config.maxRepairs}`,
    `  taskTimeoutMinutes     ${config.taskTimeoutMinutes}`,
    `  commandTimeoutMinutes  ${config.commandTimeoutMinutes}`,
    `  setup                  ${commandCount(config.setup)}`,
    `  checks                 ${commandCount(config.checks)}`,
  ];
  const { source } = config;
  if (source !== undefined) {
    lines.push(
      `  source                 jira ${source.siteUrl} project ${source.projectKey}`,
      `  source queue           issuetype ${source.issueType}, label ${source.label}, ` +
        `${source.readyStatus} -> ${source.runningStatus} -> ${source.reviewStatus}`,
      `  source polling         ${String(source.pollIntervalSeconds)}s, token environment variable ${source.tokenEnv}`,
    );
  }
  return lines.join('\n');
}

function describeTask(task: Task, taskPath: string): string {
  return [
    `check-config: ${taskPath} is valid`,
    `  id                     ${task.id}`,
    `  title                  ${task.title}`,
    `  acceptanceCriteria     ${task.acceptanceCriteria.length} item(s)`,
  ].join('\n');
}

async function checkConfig(options: ParsedOptions, context: CliContext): Promise<number> {
  const { cwd, io } = context;
  const { config: configArgument, task: taskArgument } = options;

  if (configArgument === undefined) {
    io.err(`error: check-config requires --config\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  // CLI paths resolve from the invocation directory; workDir resolves from the
  // configuration file instead (see resolveWorkDir). A task file is optional:
  // without one this validates the configuration alone, and still creates
  // nothing, starts nothing, and resolves no credential.
  const configPath = path.resolve(cwd, configArgument);

  try {
    const config = await loadHarnessConfig(configPath);
    io.out(describeConfig(config, configPath, resolveWorkDir(config, configPath)));
    if (taskArgument !== undefined) {
      const taskPath = path.resolve(cwd, taskArgument);
      const task = await loadTask(taskPath);
      io.out(describeTask(task, taskPath));
    }
    return EXIT_OK;
  } catch (cause) {
    if (cause instanceof ConfigError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }
}

/**
 * The loop's real collaborators, and nothing else: every one of them is an
 * ordinary function of the module that owns it (docs/architecture.md §3). The
 * CLI composes them; it does not implement any part of the loop.
 *
 * The one piece of composition the selection needs is here: the adapter is
 * handed the effective agent selection, so every top-level turn of the run — the
 * implementation and every repair — starts the same configured launch prefix.
 * The runner never sees the prefix except as the value it records
 * (docs/architecture.md §2).
 */
function realDependencies(
  agent: AgentSelection,
  childEnvironment?: NodeJS.ProcessEnv,
): RunnerDependencies {
  return {
    preflight: preflightSource,
    allocateRunDirectory,
    prepareWorkspace,
    // A file-task run passes no environment: its commands and its runtime
    // inherit this process's own, exactly as before. A source run passes a copy
    // with the Jira credential variable removed, so a token this harness
    // resolved is not handed to project code or to the coding runtime
    // (docs/architecture.md §9). Nothing here touches `process.env` itself.
    runCheckRound:
      childEnvironment === undefined
        ? runCheckRound
        : (request) => runCheckRound({ ...request, env: childEnvironment }),
    runAgentTurn: (request) =>
      runCodexTurn(
        request,
        selectedCodexRuntime(
          agent,
          childEnvironment === undefined ? {} : { env: childEnvironment },
        ),
      ),
    openAgentLog,
    appendRunLog,
    writeRunReport,
    recordWorkspaceAttempt,
    now: () => new Date(),
  };
}

/**
 * The one timeline line that is not progress. The runner records its final
 * status in the timeline before it writes the report, and the terminal must not
 * be told how the run ended any earlier than the report exists: the CLI prints
 * the outcome itself, from the result, once the report is really written.
 */
const FINAL_STATUS_PREFIX = 'final status:';

/**
 * The loop's collaborators as this invocation will use them: the real ones,
 * with any substitution the caller made, and two wrapped so the terminal can be
 * told what the run is doing.
 *
 * - `allocateRunDirectory` is wrapped to remember the run directory as soon as
 *   one exists, so that a failure afterwards — a report that cannot be written
 *   above all — can name the location the run was kept in.
 * - `appendRunLog` is wrapped to echo the run's own timeline as the runner
 *   writes it, which is what the progress the user sees is made of. The line is
 *   echoed only after it was appended, and the runner's final status is left to
 *   the outcome block.
 */
function composeDependencies(
  context: CliContext,
  io: CliIo,
  onAllocated: (run: RunDirectory) => void,
  agent: AgentSelection,
  childEnvironment?: NodeJS.ProcessEnv,
): RunnerDependencies {
  const real = realDependencies(agent, childEnvironment);
  const replaced = context.dependencies ?? {};
  const allocate = replaced.allocateRunDirectory ?? real.allocateRunDirectory;
  const append = replaced.appendRunLog ?? real.appendRunLog;

  return {
    preflight: replaced.preflight ?? real.preflight,
    allocateRunDirectory: async (workDir: string) => {
      const run = await allocate(workDir);
      onAllocated(run);
      return run;
    },
    prepareWorkspace: replaced.prepareWorkspace ?? real.prepareWorkspace,
    runCheckRound: replaced.runCheckRound ?? real.runCheckRound,
    runAgentTurn: replaced.runAgentTurn ?? real.runAgentTurn,
    openAgentLog: replaced.openAgentLog ?? real.openAgentLog,
    appendRunLog: async (runLog: string, message: string) => {
      await append(runLog, message);
      if (!message.startsWith(FINAL_STATUS_PREFIX)) {
        io.out(message);
      }
    },
    writeRunReport: replaced.writeRunReport ?? real.writeRunReport,
    recordWorkspaceAttempt: replaced.recordWorkspaceAttempt ?? real.recordWorkspaceAttempt,
    now: replaced.now ?? real.now,
  };
}

/**
 * The host's own interrupt signals, and nothing else. `SIGINT` is what Ctrl+C
 * sends on every supported platform — Node delivers it on Windows too — and
 * `SIGTERM` is the ordinary way a Unix supervisor asks a process to stop.
 *
 * Windows has a second one, and the CLI would be wrong to ignore it. Ctrl+C is
 * delivered to a process the console considers its own: it is disabled for a
 * process started in a new process group, which is exactly how a supervisor, an
 * IDE, or another program starts one. Ctrl+Break reaches those processes, and
 * Node reports it as `SIGBREAK`, which is not a signal the default handler
 * cancels on — a Windows CLI listening only for `SIGINT` would be ended where it
 * wanted to stop, leaving the working copy, the runtime it started, and the
 * report behind. It is installed on Windows alone, where Node sends it; the
 * name is not a signal the other platforms have.
 *
 * A listener replaces Node's default handling of these signals, and it is
 * installed only for the duration of a `run`: it is released the moment the run
 * has finalized, and nothing else this CLI does installs one at all. A `--help`
 * call, and any module that imports this one, leaves the process's signals alone.
 */
const INTERRUPT_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];

function hostSignals(): InterruptSignals {
  return {
    onInterrupt: (handler) => {
      for (const name of INTERRUPT_SIGNALS) {
        process.on(name, handler);
      }
      return () => {
        for (const name of INTERRUPT_SIGNALS) {
          process.off(name, handler);
        }
      };
    },
  };
}

/** How the terminal is told a completed run ended, and where it left things. */
function describeOutcome(result: RunTaskResult, maxRepairs: number): string {
  const { run, workspace, status, reason } = result;
  return [
    `run ${run.runId}: ${status}`,
    `  reason     ${reason}`,
    `  repairs    ${String(result.repairsUsed)} of ${String(maxRepairs)} repair turns used`,
    `  run dir    ${run.runDir}`,
    workspace === null
      ? '  workspace  no working copy was prepared (see the reason above)'
      : `  workspace  ${workspace.workspacePath} (branch ${workspace.branch})`,
    `  report     ${result.reportPath}`,
  ].join('\n');
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
async function runCommand(options: ParsedOptions, context: CliContext): Promise<number> {
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
export function abortableSleep(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (stop.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      stop.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    stop.addEventListener('abort', finish, { once: true });
  });
}

/**
 * The environment a source run's child processes inherit: the same one, with the
 * variable that holds the Jira credential removed. The token is never handed to
 * project code or to the coding runtime, and `process.env` itself is not
 * modified (docs/architecture.md §9).
 */
function environmentWithout(environment: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...environment };
  delete copy[name];
  return copy;
}

/** A `--limit` value: a positive integer, or nothing this command accepts. */
function parseLimit(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) {
    return null;
  }
  const limit = Number(value);
  return Number.isSafeInteger(limit) ? limit : null;
}

/** How a source command's own failure is reported, and with which exit code. */
function exitCodeForSource(summary: SourceSummary): number {
  if (summary.outcome === 'cancelled') {
    return EXIT_CANCELLED;
  }
  if (summary.outcome === 'stopped') {
    return EXIT_INPUT_ERROR;
  }
  return summary.failed > 0 || summary.cancelled > 0 || summary.invalid > 0
    ? EXIT_INPUT_ERROR
    : EXIT_OK;
}

/** A compact count of what one source batch did, and anything it could not. */
function describeSourceSummary(summary: SourceSummary): string {
  const lines = [
    `source ${summary.outcome}`,
    `  attempts   ${String(summary.attempted)} reserved: ${String(summary.passed)} passed, ` +
      `${String(summary.failed)} failed, ${String(summary.cancelled)} cancelled`,
    `  skipped    ${String(summary.skipped)} already attempted or no longer eligible, ` +
      `${String(summary.invalid)} invalid task description(s), ` +
      `${String(summary.refused)} refused and told why`,
  ];
  if (summary.problem !== null) {
    lines.push(`  problem    ${summary.problem}`);
  }
  if (!summary.cleanupConfirmed) {
    lines.push('  cleanup    not confirmed: the intake lock was left for manual inspection');
  }
  return lines.join('\n');
}

type SourceSubcommand = 'list' | 'run' | 'watch';

/**
 * One `source` invocation: load the configuration, resolve the credential the
 * configuration names (and nothing else), build the one connector the `source`
 * type selects, and hand ordinary functions to the coordinator.
 *
 * This is the only place in the harness that constructs a source, so no other
 * command reads a Jira credential, contacts Jira, or creates intake state
 * (docs/architecture.md §7).
 */
async function sourceCommand(
  subcommand: SourceSubcommand,
  options: ParsedOptions,
  context: CliContext,
): Promise<number> {
  const { cwd, io } = context;
  const { config: configArgument, repo: repoArgument, limit: limitArgument } = options;

  const missing = [
    configArgument === undefined ? '--config' : undefined,
    subcommand !== 'list' && repoArgument === undefined ? '--repo' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    io.err(`error: source ${subcommand} requires ${listOptions(missing)}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  let limit: number | null = null;
  if (limitArgument !== undefined) {
    limit = parseLimit(limitArgument);
    if (limit === null) {
      io.err(
        `error: option "--limit" takes a positive integer; received "${limitArgument}"\n${USAGE_HINT}`,
      );
      return EXIT_USAGE;
    }
  }

  const configPath = path.resolve(cwd, configArgument ?? '');
  let config: HarnessConfig;
  try {
    config = await loadHarnessConfig(configPath);
  } catch (cause) {
    if (cause instanceof ConfigError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }

  const sourceConfig: JiraSourceConfig | undefined = config.source;
  if (sourceConfig === undefined) {
    io.err(
      [
        `error: ${configPath} has no "source" object, so there is nothing to take tasks from.`,
        'A source command needs one; docs/WORKFLOW.md section 5 defines it.',
      ].join('\n'),
    );
    return EXIT_INPUT_ERROR;
  }

  // The credential is resolved here, for a source command only, from the one
  // environment variable the configuration names. It is never a configuration
  // value, never a task field, and never printed: the message a missing token
  // produces names the variable and not a value.
  let token: string;
  try {
    token = resolveJiraToken(sourceConfig, process.env);
  } catch (cause) {
    if (cause instanceof SourceError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  }

  const workDir = resolveWorkDir(config, configPath);
  const connector = createJiraSource(
    sourceConfig,
    token,
    context.fetch === undefined ? {} : { fetch: context.fetch },
  );

  const stop = new AbortController();
  const release = (context.signals ?? hostSignals()).onInterrupt(() => {
    if (stop.signal.aborted) {
      io.err(
        'interrupt received again: intake is already stopping, and this CLI is still waiting for it to finish.',
      );
      return;
    }
    io.err(
      [
        'interrupt received: asking intake to stop, and waiting for the active run to finalize before',
        'this command exits. Artifacts and receipts are kept; nothing new is claimed.',
      ].join('\n'),
    );
    stop.abort(new Error('the user interrupted intake'));
  });

  try {
    if (subcommand === 'list') {
      let entries: readonly SourceListEntry[];
      try {
        entries = await listSource({ source: connector, workDir, stop: stop.signal });
      } catch (cause) {
        io.err(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
        return stop.signal.aborted ? EXIT_CANCELLED : EXIT_INPUT_ERROR;
      }
      for (const entry of entries) {
        io.out(`${entry.disposition.padEnd(9)} ${entry.ref.key}  ${entry.title}`);
        io.out(`          ${entry.ref.url}`);
        io.out(`          ${entry.detail}`);
      }
      io.out(
        `source list: ${String(entries.length)} eligible issue(s); nothing was claimed, no run was ` +
          'started, and no directory was created',
      );
      return EXIT_OK;
    }

    // A source run's commands and coding runtime inherit everything except the
    // Jira credential variable, and the same effective agent selection a
    // file-task run would use.
    const repoPath = path.resolve(cwd, repoArgument ?? '');
    const childEnvironment = environmentWithout(process.env, sourceConfig.tokenEnv);
    const dependencies = composeDependencies(
      context,
      io,
      () => undefined,
      config.agent,
      childEnvironment,
    );

    const intake: SourceContext = {
      source: connector,
      workDir,
      repoPath,
      io,
      stop: stop.signal,
      preflight: preflightSource,
      run: ({ task, sourceRef, stop: runStop, continuedWorkspace, onWorkspaceReady }) =>
        runTask(
          {
            task,
            config,
            repoPath,
            workDir,
            stop: runStop,
            sourceRef,
            ...(continuedWorkspace === undefined ? {} : { continuedWorkspace }),
            ...(onWorkspaceReady === undefined ? {} : { onWorkspaceReady }),
          },
          dependencies,
        ),
      now: () => new Date(),
      sleep: abortableSleep,
    };

    const summary =
      subcommand === 'run'
        ? await runSource(intake, limit)
        : await watchSource({
            ...intake,
            pollIntervalMs: sourceConfig.pollIntervalSeconds * 1000,
          } satisfies SourceWatchOptions);

    io.out(describeSourceSummary(summary));
    return exitCodeForSource(summary);
  } catch (cause) {
    if (cause instanceof SourceError || cause instanceof WorkspaceError) {
      io.err(`error: ${cause.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw cause;
  } finally {
    release();
  }
}

/** `source list`, `source run` and `source watch`: the intake subcommands. */
async function sourceCli(args: readonly string[], context: CliContext): Promise<number> {
  const { io } = context;
  const [subcommand, ...rest] = args;

  if (subcommand === undefined) {
    io.err(`error: source requires one of: list, run, watch\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand.startsWith('-')) {
    io.err(`error: unknown option "${subcommand}"\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  if (subcommand !== 'list' && subcommand !== 'run' && subcommand !== 'watch') {
    io.err(
      `error: unknown source command "${subcommand}"; expected "list", "run", or "watch"\n${USAGE_HINT}`,
    );
    return EXIT_USAGE;
  }

  const allowed =
    subcommand === 'list'
      ? SOURCE_LIST_OPTIONS
      : subcommand === 'run'
        ? SOURCE_RUN_OPTIONS
        : SOURCE_WATCH_OPTIONS;
  const parsed = parseOptions(rest, allowed);
  if (!parsed.ok) {
    io.err(`error: ${parsed.message}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }
  return sourceCommand(subcommand, parsed.options, context);
}

/**
 * Runs one CLI invocation and returns its exit code. Never throws for bad
 * input; only unexpected internal failures propagate.
 */
export async function runCli(
  argv: readonly string[],
  context: CliContext = consoleContext(),
): Promise<number> {
  const { io } = context;
  const command = argv[0];

  if (command === undefined) {
    io.out(HELP);
    return EXIT_OK;
  }

  if (argv.includes('-h') || argv.includes('--help')) {
    io.out(HELP);
    return EXIT_OK;
  }

  if (command.startsWith('-')) {
    io.err(`error: unknown option "${command}"\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  if (command === 'source') {
    return sourceCli(argv.slice(1), context);
  }

  if (command !== 'check-config' && command !== 'run') {
    io.err(`error: unknown command "${command}"\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  const parsed = parseOptions(
    argv.slice(1),
    command === 'run' ? RUN_OPTIONS : CHECK_CONFIG_OPTIONS,
  );
  if (!parsed.ok) {
    io.err(`error: ${parsed.message}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  return command === 'run'
    ? runCommand(parsed.options, context)
    : checkConfig(parsed.options, context);
}

/** The real console, reading the current working directory at call time. */
export function consoleContext(): CliContext {
  return {
    cwd: process.cwd(),
    io: {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
    },
  };
}

/** True when this module is the process entry point, not an import. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const entryUrl = pathToFileURL(entry).href;
  if (entryUrl === import.meta.url) {
    return true;
  }
  // Windows path casing can differ between argv and import.meta.url.
  return process.platform === 'win32' && entryUrl.toLowerCase() === import.meta.url.toLowerCase();
}

if (isEntryPoint()) {
  try {
    process.exitCode = await runCli(process.argv.slice(2), consoleContext());
  } catch (cause) {
    process.stderr.write(`error: unexpected failure: ${String(cause)}\n`);
    process.exitCode = EXIT_INPUT_ERROR;
  }
}
