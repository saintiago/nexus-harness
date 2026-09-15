/**
 * Command line entry point: arguments, help, exit codes, top-level wiring.
 *
 * The exported `runCli` takes its working directory and its output functions as
 * parameters, so argument handling and exit codes are testable in-process. The
 * `import.meta.url` check at the bottom only runs when this file is the process
 * entry point.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadHarnessConfig, loadTask, resolveWorkDir } from './config.js';
import type { Command, HarnessConfig, Task } from './types.js';

export const EXIT_OK = 0;
/** Input could not be read, parsed, or validated. */
export const EXIT_INPUT_ERROR = 1;
/** The command line itself is wrong, or asks for something not built yet. */
export const EXIT_USAGE = 2;

/** Where the CLI writes. Tests pass a recorder instead of the console. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CliContext {
  /** Directory that relative file arguments resolve from. */
  cwd: string;
  io: CliIo;
}

const HELP = `nexus harness — local-first development harness (scaffold)

Usage: <command> [options]

Commands:
  check-config   Read and validate a configuration file and a task file.
  run            Run a task through the workspace/check/repair loop. Not implemented yet.

Options:
  --config <path>   Configuration file, resolved from the current directory.
  --task <path>     Task file, resolved from the current directory.
  -h, --help        Show this help.

Examples:
  npm run dev -- --help
  npm run dev -- check-config --config harness.config.json --task examples/task.json

check-config is static: it creates nothing, runs no configured command, contacts
no provider, and needs no credentials. It validates both JSON documents, resolves
workDir, and reports every problem it finds.

Exit codes:
  0  success
  1  input error (unreadable file, invalid JSON, or a field that failed validation)
  2  usage error (unknown command or option, missing value, or an unimplemented command)

Input contract: docs/WORKFLOW.md. Behaviour: docs/spec.md.`;

const USAGE_HINT = 'Run "npm run dev -- --help" for usage.';

interface ParsedOptions {
  readonly config: string | undefined;
  readonly task: string | undefined;
}

type OptionParse =
  | { readonly ok: true; readonly options: ParsedOptions }
  | { readonly ok: false; readonly message: string };

/** Options taking a value. Kept small: the CLI has two of them. */
const VALUE_OPTIONS = new Set(['--config', '--task']);

function parseOptions(args: readonly string[]): OptionParse {
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

    if (!VALUE_OPTIONS.has(name)) {
      return { ok: false, message: `unknown option "${name}"` };
    }

    if (values.has(name)) {
      return { ok: false, message: `option "${name}" was given more than once` };
    }

    if (inlineValue !== undefined) {
      if (inlineValue === '') {
        return { ok: false, message: `option "${name}" requires a path value` };
      }
      values.set(name, inlineValue);
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      return { ok: false, message: `option "${name}" requires a path value` };
    }
    values.set(name, value);
    index += 1;
  }

  return { ok: true, options: { config: values.get('--config'), task: values.get('--task') } };
}

function commandCount(commands: readonly Command[]): string {
  return `${commands.length} ${commands.length === 1 ? 'command' : 'commands'}`;
}

function describeConfig(config: HarnessConfig, configPath: string, workDir: string): string {
  return [
    `check-config: ${configPath} is valid`,
    `  workDir                ${workDir} (resolved from this file)`,
    `  maxRepairs             ${config.maxRepairs}`,
    `  taskTimeoutMinutes     ${config.taskTimeoutMinutes}`,
    `  commandTimeoutMinutes  ${config.commandTimeoutMinutes}`,
    `  setup                  ${commandCount(config.setup)}`,
    `  checks                 ${commandCount(config.checks)}`,
  ].join('\n');
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

  if (configArgument === undefined || taskArgument === undefined) {
    const missing = [
      configArgument === undefined ? '--config' : undefined,
      taskArgument === undefined ? '--task' : undefined,
    ].filter((name) => name !== undefined);
    io.err(`error: check-config requires ${missing.join(' and ')}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  // CLI paths resolve from the invocation directory; workDir resolves from the
  // configuration file instead (see resolveWorkDir).
  const configPath = path.resolve(cwd, configArgument);
  const taskPath = path.resolve(cwd, taskArgument);

  try {
    const config = await loadHarnessConfig(configPath);
    const task = await loadTask(taskPath);
    io.out(describeConfig(config, configPath, resolveWorkDir(config, configPath)));
    io.out(describeTask(task, taskPath));
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

  // Rejected before its options are parsed: the command itself does not exist yet,
  // so "unknown option --repo" would be a misleading complaint.
  if (command === 'run') {
    io.err(
      [
        'error: the "run" command is not implemented yet.',
        'This scaffold validates inputs only. The workspace/check/repair loop described',
        'in docs/spec.md §2 is the next task.',
      ].join('\n'),
    );
    return EXIT_USAGE;
  }

  if (command !== 'check-config') {
    io.err(`error: unknown command "${command}"\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  const parsed = parseOptions(argv.slice(1));
  if (!parsed.ok) {
    io.err(`error: ${parsed.message}\n${USAGE_HINT}`);
    return EXIT_USAGE;
  }

  return checkConfig(parsed.options, context);
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
