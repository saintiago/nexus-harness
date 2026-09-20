/**
 * Command line entry point and dispatch; the commands live in `cli/`.
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
import { pathToFileURL } from 'node:url';
import { checkConfig } from './cli/check-config.js';
import { EXIT_INPUT_ERROR, EXIT_OK, EXIT_USAGE } from './cli/context.js';
import type { CliContext, CliTerminal } from './cli/context.js';
import { HELP, USAGE_HINT } from './cli/help.js';
import { CHECK_CONFIG_OPTIONS, parseOptions, RUN_OPTIONS } from './cli/options.js';
import { queueCli } from './cli/queue-command.js';
import { reviewCli } from './cli/review-command.js';
import { runCommand } from './cli/run-command.js';
import { sourceCli } from './cli/source-command.js';

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

  if (command === 'review') {
    return reviewCli(argv.slice(1), context);
  }

  if (command === 'queue') {
    return queueCli(argv.slice(1), context);
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
      terminal: consoleTerminal(),
    },
  };
}

/**
 * The process's own standard output as the pane needs it, when it is really an
 * interactive terminal. A redirected stream — piped to a file, a test's own
 * recorder, a process that reads it — is not one: it gets ordinary lines, and
 * never a cursor sequence.
 */
function consoleTerminal(): CliTerminal | undefined {
  if (process.stdout.isTTY !== true) {
    return undefined;
  }
  const columns = process.stdout.columns;
  const rows = process.stdout.rows;
  return {
    write: (text) => process.stdout.write(text),
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows }),
    color: colorAllowed(process.env),
  };
}

/**
 * Whether the pane may color the terminal. The `NO_COLOR` convention — set to
 * anything but the empty string — asks for none: the timeline uses plain output
 * without cursor or color sequences.
 */
export function colorAllowed(environment: NodeJS.ProcessEnv): boolean {
  const requested = environment['NO_COLOR'];
  return requested === undefined || requested === '';
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
