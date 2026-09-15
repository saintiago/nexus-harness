/**
 * Running one configured setup/check command in the task working copy.
 *
 * A command is an executable plus literal arguments (docs/WORKFLOW.md §1), and
 * it is launched as such: nothing here builds a command line out of text. No
 * task or configuration string is interpolated, no environment variable is
 * expanded implicitly, and argument boundaries survive — including intentional
 * empty arguments, spaces, quotes, and shell-looking text such as `&&`,
 * `$(...)`, `|`, or `*`, none of which the harness interprets.
 *
 * Every invocation is recorded: the configured arguments, the working
 * directory, start and end times, the exit code or signal, a launch error, and
 * the two log files its output went to. A command that never started is
 * reported as `failed-to-launch` with a `null` exit code, so it can never be
 * mistaken for a command that ran and succeeded.
 *
 * ## Supported platforms and launchers
 *
 * Everywhere: the configured executable is started directly with the argument
 * array exactly as configured. On POSIX hosts that is the whole story.
 *
 * Native Windows: `npm` and other installed commands are `.cmd` shims, which
 * `spawn` cannot execute without a shell (and Node rejects outright). A command
 * whose executable resolves to `.cmd`/`.bat` is therefore run through the
 * command interpreter as `cmd.exe /d /s /v:off /c "<line>"`, where the line
 * holds the resolved absolute path of the shim and each argument quoted by this
 * module. The interpreter does not get to interpret `&&`, `|`, `*`, quotes, or
 * `$(...)`, but three argument contents cannot survive it unchanged, and are
 * refused with an explanation instead of being silently altered:
 *
 * - a double quote, which the interpreter drops;
 * - a percent sign (`%NAME%` is expanded from the environment);
 * - a line break, which ends the command.
 *
 * A command that needs one of those must name a real executable rather than a
 * shim. On every platform the executable is resolved from `PATH` (and, on
 * Windows, `PATHEXT`); the working directory is never searched implicitly.
 *
 * Timeouts and cancellation are not implemented here yet: they belong to the
 * deadline and cancellation tasks, which wrap this helper.
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { openCommandLog } from './report.js';
import type { Command, CommandOutcome, CommandResult } from './types.js';

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
}

/** Extensions a Windows command interpreter has to start for the harness. */
const SHIM_EXTENSIONS = new Set(['.cmd', '.bat']);

/** Used to resolve an executable when the host defines no `PATHEXT`. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Argument contents a Windows command line cannot carry literally, and what to
 * call them when one is refused.
 */
const UNSUPPORTED_IN_COMMAND_LINE: ReadonlyArray<readonly [RegExp, string]> = [
  [/"/, 'a double quote'],
  [/%/, 'a percent sign, which cmd.exe expands as an environment reference'],
  [/[\r\n]/, 'a line break'],
];

/** How one command will actually be started. */
interface Launcher {
  /** Executable handed to `spawn`. On Windows, a resolved absolute path. */
  readonly file: string;
  /** Complete argument list for `spawn`, including any interpreter switches. */
  readonly args: readonly string[];
  /** True when the arguments have to reach the process exactly as written. */
  readonly verbatim: boolean;
}

type LaunchPlan =
  | { readonly ok: true; readonly launcher: Launcher }
  | { readonly ok: false; readonly problem: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a command name the way the command interpreter would: an explicit
 * path is used as given, and a bare name is looked up in `PATH` with each
 * `PATHEXT` extension. The working directory is deliberately not searched, so a
 * file in the task's working copy cannot stand in for an installed command by
 * accident.
 */
function resolveWindowsExecutable(name: string, cwd: string): string | undefined {
  if (name.includes('/') || name.includes('\\')) {
    const explicit = path.resolve(cwd, name);
    return isFile(explicit) ? explicit : undefined;
  }

  const directories = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((directory) => directory !== '');
  const extensions = (process.env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(';')
    .filter((extension) => extension !== '');
  // A name that already ends in an extension may be the file itself; a bare
  // name may not, so an extensionless `npm` shell script beside the installed
  // `npm.cmd` never becomes the executable, just as it never does for cmd.exe.
  const suffixes = path.extname(name) === '' ? extensions : ['', ...extensions];

  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * One argument as it appears on a `cmd.exe` command line. The interpreter
 * removes the quotes, so a trailing run of backslashes is doubled to stop it
 * from escaping the closing quote on the way to the target program.
 */
function quoteArgument(argument: string): string {
  return `"${argument.replace(/(\\+)$/, '$1$1')}"`;
}

/** The reason an argument cannot be handed to a `.cmd`/`.bat` shim, if any. */
function unsupportedArgument(argument: string): string | undefined {
  for (const [pattern, description] of UNSUPPORTED_IN_COMMAND_LINE) {
    if (pattern.test(argument)) {
      return description;
    }
  }
  return undefined;
}

/**
 * Decides how the configured command is started. A `.cmd`/`.bat` executable on
 * Windows is the only case that needs an interpreter; everything else is
 * started directly, so its arguments are passed through untouched.
 */
function planLaunch(executable: string, args: readonly string[], cwd: string): LaunchPlan {
  if (executable.trim() === '') {
    return { ok: false, problem: 'the command has no executable as its first item' };
  }

  if (process.platform !== 'win32') {
    return { ok: true, launcher: { file: executable, args, verbatim: false } };
  }

  const resolved = resolveWindowsExecutable(executable, cwd);
  if (resolved === undefined) {
    return {
      ok: false,
      problem:
        `"${executable}" was not found: no "${executable}" file (or one with a PATHEXT extension) ` +
        `exists in the directories on PATH.`,
    };
  }

  if (!SHIM_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return { ok: true, launcher: { file: resolved, args, verbatim: false } };
  }

  for (const argument of args) {
    const unsupported = unsupportedArgument(argument);
    if (unsupported !== undefined) {
      return {
        ok: false,
        problem:
          `the argument ${JSON.stringify(argument)} contains ${unsupported}, which a Windows ` +
          `command interpreter cannot pass on unchanged. "${executable}" is a ${path.extname(resolved)} ` +
          'shim, so it has to be started through cmd.exe. Name a real executable instead, or run ' +
          'this command without that argument.',
      };
    }
  }

  // The interpreter strips the outer quotes of this line and runs what remains
  // with the arguments as quoted here; `windowsVerbatimArguments` keeps the
  // line from being re-quoted on the way in.
  const line = [resolved, ...args].map(quoteArgument).join(' ');
  return {
    ok: true,
    launcher: {
      file: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/v:off', '/c', `"${line}"`],
      verbatim: true,
    },
  };
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
 * True only for a command that ran to completion and exited `0`. A command that
 * could not be started, or that was killed by a signal, is never a success.
 */
export function commandSucceeded(result: CommandResult): boolean {
  return result.outcome === 'exited' && result.exitCode === 0;
}

/**
 * Runs one configured command in `cwd`, writes its standard output and standard
 * error to their own log files under `logsDir`, and returns what happened. A
 * failure to start the command is part of that result, not an exception; a
 * failure to persist its output is a {@link ReportError}.
 */
export async function runCommand(request: RunCommandRequest): Promise<CommandResult> {
  const { command, cwd, logsDir, label } = request;
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

  const { file, args: launcherArgs, verbatim } = plan.launcher;

  const result = await new Promise<CommandResult>((resolve) => {
    let launchError: string | null = null;
    let settled = false;

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      // A command that never started still reports a nonzero close code on
      // Windows, so the recorded launch error decides the outcome, never the code.
      const started = launchError === null;
      let outcome: CommandOutcome = 'failed-to-launch';
      if (started) {
        outcome = signal === null ? 'exited' : 'signalled';
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
        stdoutPath: log.stdoutPath,
        stderrPath: log.stderrPath,
      });
    };

    let child;
    try {
      child = spawn(file, [...launcherArgs], {
        cwd,
        // No interactive input: configured commands must not wait for a terminal.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: verbatim,
        windowsHide: true,
      });
    } catch (cause) {
      launchError = messageOf(cause);
      finish(null, null);
      return;
    }

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

    child.on('close', (code, signal) => finish(code, signal));
  });

  await log.close();
  return result;
}
