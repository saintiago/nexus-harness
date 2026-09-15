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
 * ## Limits, and stopping what a command started
 *
 * Every invocation is bounded. It runs under the smaller of the configured
 * command limit and the run's remaining task time, and when that limit expires
 * the harness stops the invocation — and everything the invocation started —
 * rather than waiting for it (docs/spec.md §3). The invocation is recorded as
 * `timed-out`, with the limit it ran under and whether the stop was confirmed.
 *
 * A command that runs `npm test` is a tree, not a process: the interpreter, the
 * shim, and whatever they spawn all have to end, or the working copy stays
 * open and the next round reads a half-written checkout. On Windows the tree is
 * ended by PID with `taskkill /PID <pid> /T /F`: `/T` is what reaches the
 * children the invocation started, and a bare `child.kill()` ends only the
 * direct process and leaves them running. Elsewhere the invocation is started as
 * its own process-group leader, so the whole group is signalled at once. Only a
 * PID this module recorded for an invocation it started is ever named, so no
 * other process on the host can be selected by a stop. Termination is confirmed
 * only when the stop request reached the operating system *and* the invocation
 * was seen to end; anything else is recorded as unconfirmed rather than assumed.
 *
 * {@link runCheckRound} composes this helper into one reusable setup/check
 * round: the configured setup commands run first, in order, and only when every
 * one of them succeeded do all configured checks run, in order, one at a time.
 * An ordinary failing check does not skip the checks after it — that is the red
 * round the repair loop works from — while a failing setup command, a command
 * that could not be started, and a command killed by a signal end the round as
 * an execution error. The result says which of the two happened, and a check
 * that never ran has no result at all.
 *
 * A limit that expires is one of those endings, and never a red round: the
 * command that was stopped did not fail a check, so the round stops as an
 * execution error and reports what was stopped and what could not be confirmed.
 * The round recomputes what is left of the task time before every command it
 * starts, so a round that has used up the run's time starts nothing at all.
 *
 * Cancellation is not implemented here: it belongs to T09, which reuses this
 * same stop path.
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { openCommandLog } from './report.js';
import type {
  CheckRoundResult,
  Command,
  CommandOutcome,
  CommandResult,
  TerminationOutcome,
} from './types.js';

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
}

/** What one setup/check round is asked to do. */
export interface CheckRoundRequest {
  /** Setup commands, run in this order before the checks. May be empty. */
  readonly setup: readonly Command[];
  /** Checks, run in this order once setup has succeeded. */
  readonly checks: readonly Command[];
  /** Working directory every command of the round runs in. */
  readonly cwd: string;
  /** `<runDir>/logs`, where each invocation's output files are created. */
  readonly logsDir: string;
  /**
   * Names this round, and with it every invocation's log files:
   * `<name>-setup-1`, `<name>-check-2`. A later round in the same run needs a
   * different name, because log files are created exclusively and the output of
   * an earlier round is never overwritten.
   */
  readonly name: string;
  /**
   * The configured per-command limit, in milliseconds. An invocation runs under
   * the smaller of this and the task time that is left when it starts.
   */
  readonly commandTimeoutMs: number;
  /**
   * The run's task deadline, in epoch milliseconds: established once, before
   * preparation, and carried through every phase. It is compared against the
   * remaining time here and never recomputed from a new limit, so a round — and
   * with it a repair — cannot hand the run time it has already spent.
   */
  readonly deadlineMs: number;
  /**
   * The clock the deadline was taken from, and the one the remaining task time
   * is read with. The same clock the run itself uses: there is deliberately no
   * second notion of time in the harness.
   */
  readonly now: () => Date;
}

/**
 * How long the harness waits for an invocation it stopped to actually end
 * before recording the stop as unconfirmed. `taskkill /F` and a group `SIGKILL`
 * both end what they name before returning, so this only elapses when the stop
 * did not reach it — and an invocation that ends by itself in that window is
 * still confirmed, so the wait is never skipped.
 */
const STOP_GRACE_MS = 5000;

/** Waits for `work`, but no longer than `ms`; says whether it finished in time. */
function within(work: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void work.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Runs one host utility to completion and reports why it failed, if it did. */
function runHostUtility(executable: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (problem: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(problem);
      }
    };

    let utility;
    try {
      utility = spawn(executable, [...args], { stdio: 'ignore', windowsHide: true });
    } catch (cause) {
      done(`"${executable}" could not be run: ${messageOf(cause)}`);
      return;
    }

    // A utility that cannot even be started — no `taskkill` on this host's
    // PATH, say — is a failed stop, never a silent one.
    utility.on('error', (cause) => done(`"${executable}" could not be run: ${messageOf(cause)}`));
    utility.on('close', (code) => {
      done(code === 0 ? null : `"${executable}" exited with code ${String(code)}`);
    });
  });
}

/**
 * Asks the operating system to end one process tree this module started, and
 * says what the request itself did: `null` when it succeeded, otherwise why it
 * did not. Only the recorded PID of an owned invocation is ever named, so no
 * other process on the host can be selected here.
 */
async function requestTreeStop(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') {
    // Every invocation is started as its own process-group leader, so the group
    // is addressed by the negated PID and its members go with it.
    try {
      process.kill(-pid, 'SIGKILL');
      return null;
    } catch (cause) {
      // Nothing left in the group is the outcome this asked for.
      const code = (cause as NodeJS.ErrnoException).code;
      return code === 'ESRCH'
        ? null
        : `the process group of ${String(pid)} could not be signalled: ${messageOf(cause)}`;
    }
  }

  // `/T` reaches the children the invocation started, and `/F` ends them
  // instead of asking a window that may never answer.
  return runHostUtility('taskkill', ['/PID', String(pid), '/T', '/F']);
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
 *
 * The invocation is started in its own process group, so the whole tree it
 * becomes can be stopped as one, and it is stopped when `timeoutMs` expires.
 * The result then says it timed out, and whether that stop was confirmed.
 */
export async function runCommand(request: RunCommandRequest): Promise<CommandResult> {
  const { command, cwd, logsDir, label, timeoutMs } = request;
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
    let timedOut = false;
    let termination: TerminationOutcome | null = null;
    let terminationProblem: string | null = null;
    let lastCode: number | null = null;
    let lastSignal: string | null = null;
    let markEnded: () => void = () => undefined;
    const endedOnce = new Promise<void>((settleEnded) => {
      markEnded = settleEnded;
    });
    let timer: NodeJS.Timeout | null = null;

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      // A command that never started still reports a nonzero close code on
      // Windows, so the recorded launch error decides the outcome, never the code.
      const started = launchError === null;
      let outcome: CommandOutcome = 'failed-to-launch';
      if (started) {
        if (timedOut) {
          outcome = 'timed-out';
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
     * Ends the invocation and everything it started, once the limit has
     * expired. Confirmed means the stop request reached the operating system
     * *and* the invocation was seen to end: either half missing is recorded as
     * unconfirmed, because a tree that may still be running must never be
     * reported as stopped.
     */
    const stopAtLimit = async (): Promise<void> => {
      if (settled) {
        // It ended by itself just as its limit expired: there is nothing left
        // to stop, and its own ending is the result.
        return;
      }
      timedOut = true;
      const { pid } = child;
      if (pid === undefined) {
        // Nothing of this invocation ever started, so no tree of ours exists to
        // stop; the launch failure is the result, exactly as it would be
        // without a limit.
        finish(null, null);
        return;
      }

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
      if (timedOut) {
        // The stop path is waiting for exactly this end, and owns the result:
        // the invocation is recorded as timed out, with how it was stopped.
        return;
      }
      finish(code, signal);
    });

    if (!settled) {
      timer = setTimeout(() => {
        void stopAtLimit();
      }, timeoutMs);
    }
  });

  await log.close();
  return result;
}

/** How a round names one invocation when explaining why it stopped. */
function describeInvocation(
  kind: 'setup command' | 'check',
  position: number,
  total: number,
  command: Command,
): string {
  return `${kind} ${position} of ${total} (${JSON.stringify(command)})`;
}

/**
 * Why a command stopped a round, for a command that did not simply exit `0`.
 *
 * `taskBounded` says the invocation was given less than its configured limit
 * because the run was running out of task time: the two limits are different
 * facts about the same stop, and the one that expired is the useful one.
 */
function describeStop(where: string, result: CommandResult, taskBounded: boolean): string {
  if (result.outcome === 'failed-to-launch') {
    return `${where} could not be started: ${result.launchError ?? 'no launch error was recorded'}`;
  }
  if (result.outcome === 'signalled') {
    return (
      `${where} was killed by ${result.signal ?? 'a signal'}: a command that does not run to ` +
      'completion is an execution failure, not a failed check'
    );
  }
  if (result.outcome === 'timed-out') {
    const limit = taskBounded
      ? `the ${String(result.timeoutMs)} ms of task time that was left`
      : `its ${String(result.timeoutMs)} ms command limit`;
    return (
      `${where} was stopped because ${limit} expired, and ` +
      (result.termination === 'confirmed'
        ? 'the invocation and the process tree it started were stopped'
        : `that stop could not be confirmed: ${result.terminationProblem ?? 'no reason was recorded'}`)
    );
  }
  return `${where} exited with code ${String(result.exitCode)}`;
}

/** What an early stop costs the rest of the round, said once per stage. */
const SETUP_STOPPED =
  'The round stopped before the checks ran: no later setup command and no check was run. A ' +
  'setup problem is not a failed check to repair.';
const EXECUTION_STOPPED =
  'The round stopped there: no later check was run. A command that could not be executed is ' +
  'not a failed check to repair.';
const TIMEOUT_STOPPED =
  'The round stopped there: no later command was run. An expired limit is not a failed check ' +
  'to repair, and nothing else was started.';
const UNCONFIRMED_TERMINATION = [
  'The harness could not confirm that everything the stopped command started has ended, so the',
  'working copy may still be written to: it must not be reused, and nothing further was run.',
].join('\n');

/**
 * What a stopped command costs the rest of the round. A limit that expired adds
 * the unconfirmed-stop limitation when the harness has one: an unconfirmed stop
 * is a fact the run's report has to carry, not a detail this round can round
 * down (docs/spec.md §3).
 */
function stopSuffix(result: CommandResult, ordinary: string): string {
  if (result.outcome !== 'timed-out') {
    return ordinary;
  }
  const unconfirmed = result.termination === 'confirmed' ? '' : `\n${UNCONFIRMED_TERMINATION}`;
  return `${TIMEOUT_STOPPED}${unconfirmed}`;
}

/** The result of a round that stopped before it had attempted every check. */
function incompleteRound(
  setup: readonly CommandResult[],
  checks: readonly CommandResult[],
  problem: string,
): CheckRoundResult {
  return { outcome: 'execution-error', setup, checks, problem };
}

/**
 * Why a round stopped without starting the command it was about to run: the
 * run's own task deadline had already passed. This is the task's limit, not the
 * command's, and the round hands the decision back rather than inventing time.
 */
function expiredDeadline(where: string, overdueMs: number): string {
  return [
    `the run's task deadline passed ${String(overdueMs)} ms before ${where} could start, so it was ` +
      'not started.',
    TIMEOUT_STOPPED,
  ].join('\n');
}

/**
 * Runs one setup/check round and reports what every invocation did.
 *
 * Setup runs first, in configured order, and an empty setup list is valid. Only
 * when every setup command exited `0` do the checks run, in configured order,
 * one at a time, and each is recorded whether it passes or fails: an ordinary
 * nonzero check exits and the later checks still run. Such a round is complete
 * and red (`'failed'`), which is what a repair turn is for.
 *
 * A setup command that does not exit `0`, and any command that cannot be
 * executed at all — one that never started, one killed by a signal, one stopped
 * because a limit expired — ends the round immediately as `'execution-error'`
 * with a `problem` explaining it. The commands after it did not run, so they
 * have no result: an unexecuted check is absent from `checks`, never reported as
 * a success.
 *
 * Each invocation runs under the smaller of `commandTimeoutMs` and what is left
 * of the task time, and both are read again before every command: a round that
 * has spent the run's time starts nothing, and no command ever runs past the
 * task deadline. A failure to create or write an invocation's log files is a
 * {@link ReportError}: the round stops with that error rather than returning a
 * result whose evidence was lost.
 */
export async function runCheckRound(request: CheckRoundRequest): Promise<CheckRoundResult> {
  const { setup, checks, cwd, logsDir, name, commandTimeoutMs, deadlineMs, now } = request;
  const setupResults: CommandResult[] = [];
  const checkResults: CommandResult[] = [];

  /**
   * What the next invocation runs under: the smaller of its configured command
   * limit and the task time this run has left. A limit of at least one
   * millisecond is always handed to `runCommand`, so a command that is started
   * is always bounded.
   */
  const nextLimit = (): { readonly remaining: number; readonly limitMs: number } => {
    const remaining = deadlineMs - now().getTime();
    return { remaining, limitMs: Math.max(1, Math.min(commandTimeoutMs, remaining)) };
  };

  for (const [index, command] of setup.entries()) {
    const where = describeInvocation('setup command', index + 1, setup.length, command);
    const { remaining, limitMs } = nextLimit();
    if (remaining <= 0) {
      return incompleteRound(setupResults, checkResults, expiredDeadline(where, -remaining));
    }

    const result = await runCommand({
      command,
      cwd,
      logsDir,
      label: `${name}-setup-${index + 1}`,
      timeoutMs: limitMs,
    });
    setupResults.push(result);
    if (!commandSucceeded(result)) {
      const problem = `${describeStop(where, result, limitMs < commandTimeoutMs)}.\n${stopSuffix(result, SETUP_STOPPED)}`;
      return incompleteRound(setupResults, checkResults, problem);
    }
  }

  for (const [index, command] of checks.entries()) {
    const where = describeInvocation('check', index + 1, checks.length, command);
    const { remaining, limitMs } = nextLimit();
    if (remaining <= 0) {
      return incompleteRound(setupResults, checkResults, expiredDeadline(where, -remaining));
    }

    const result = await runCommand({
      command,
      cwd,
      logsDir,
      label: `${name}-check-${index + 1}`,
      timeoutMs: limitMs,
    });
    checkResults.push(result);
    // A check that exited nonzero is a result like any other, and the remaining
    // checks still run. A check that could not run has no result to keep.
    if (result.outcome !== 'exited') {
      const problem = `${describeStop(where, result, limitMs < commandTimeoutMs)}.\n${stopSuffix(result, EXECUTION_STOPPED)}`;
      return incompleteRound(setupResults, checkResults, problem);
    }
  }

  return {
    outcome: checkResults.every(commandSucceeded) ? 'passed' : 'failed',
    setup: setupResults,
    checks: checkResults,
    problem: null,
  };
}
