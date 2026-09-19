/**
 * How one command is started: an executable plus literal arguments, never a
 * shell string, and the one platform case that needs an interpreter.
 *
 * On POSIX the configured executable is started directly. On Windows an
 * installed `npm` is a `.cmd` shim, which `spawn` cannot execute without a
 * shell, so a command whose executable resolves to `.cmd`/`.bat` is run through
 * the command interpreter with every argument quoted here, and the argument
 * contents the interpreter cannot pass on unchanged are refused with an
 * explanation instead of being silently altered.
 *
 * The coding runtime adapter starts the runtime through this too, so a `codex`
 * that is an installed `.cmd` shim is launched exactly as an installed `npm` is.
 */
import { statSync } from 'node:fs';
import path from 'node:path';

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
export interface Launcher {
  /** Executable handed to `spawn`. On Windows, a resolved absolute path. */
  readonly file: string;
  /** Complete argument list for `spawn`, including any interpreter switches. */
  readonly args: readonly string[];
  /** True when the arguments have to reach the process exactly as written. */
  readonly verbatim: boolean;
}

export type LaunchPlan =
  | { readonly ok: true; readonly launcher: Launcher }
  | { readonly ok: false; readonly problem: string };

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
 *
 * The coding runtime adapter starts the runtime through this too, so a `codex`
 * that is an installed `.cmd` shim is launched exactly as an installed `npm` is.
 */
export function planLaunch(executable: string, args: readonly string[], cwd: string): LaunchPlan {
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
