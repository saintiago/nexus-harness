/**
 * One setup/check round: the configured setup commands first, in order, and only
 * when every one of them succeeded do all configured checks run, in order, one
 * at a time. It also owns the one reading of a command result every other
 * module uses.
 *
 * An ordinary failing check does not skip the checks after it â€” that is the red
 * round the repair loop works from â€” while a failing setup command, a command
 * that could not be started, and a command killed by a signal end the round as
 * an execution error. A limit that expires is one of those endings, never a red
 * round: the command that was stopped did not fail a check.
 */
import { runCommand } from '../process/command.js';
import type { CheckRoundResult, Command, CommandResult } from '../shared/types.js';

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
  /**
   * Asked to stop the round when the run is stopped by its caller. Every
   * invocation of the round runs with it, so a command that is running is
   * stopped with the tree it started, and a round that is already stopped —
   * between two commands — starts nothing further.
   */
  readonly stop?: AbortSignal;
  /**
   * The environment every invocation of the round is started with. Omitted
   * means this process's own environment; a source run passes a copy without
   * the Jira credential variable (docs/WORKFLOW.md §7). It is passed on as it
   * is and never recorded.
   */
  readonly env?: NodeJS.ProcessEnv;
}
/**
 * True only for a command that ran to completion and exited `0`. A command that
 * could not be started, or that was killed by a signal, is never a success.
 */
export function commandSucceeded(result: CommandResult): boolean {
  return result.outcome === 'exited' && result.exitCode === 0;
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
  if (result.outcome === 'stopped') {
    return (
      `${where} was stopped because the run was stopped by its caller, and ` +
      (result.termination === 'confirmed'
        ? 'nothing of it was left running'
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
const CANCELLED_STOPPED =
  'The round stopped there: no later command was run. The run was stopped by its caller, and a ' +
  'stopped run is not a failed check to repair.';
const UNCONFIRMED_TERMINATION = [
  'The harness could not confirm that everything the stopped command started has ended, so the',
  'working copy may still be written to: it must not be reused, and nothing further was run.',
].join('\n');

/**
 * What a stopped command costs the rest of the round. Either stop adds the
 * unconfirmed-stop limitation when the harness has one: an unconfirmed stop is a
 * fact the run's report has to carry, not a detail this round can round down
 * (docs/spec.md §3).
 */
function stopSuffix(result: CommandResult, ordinary: string): string {
  if (result.outcome !== 'timed-out' && result.outcome !== 'stopped') {
    return ordinary;
  }
  const stopped = result.outcome === 'timed-out' ? TIMEOUT_STOPPED : CANCELLED_STOPPED;
  const unconfirmed = result.termination === 'confirmed' ? '' : `\n${UNCONFIRMED_TERMINATION}`;
  return `${stopped}${unconfirmed}`;
}

/**
 * Why a round stopped without starting the command it was about to run: the run
 * it belongs to was stopped by its caller. This is the run's own stop request,
 * not a limit, and the round hands the decision back rather than starting work
 * the run no longer wants.
 */
function stoppedBeforeNext(where: string): string {
  return [
    `the run was stopped by its caller before ${where} could start, so it was not started.`,
    CANCELLED_STOPPED,
  ].join('\n');
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
  const { setup, checks, cwd, logsDir, name, commandTimeoutMs, deadlineMs, now, stop, env } =
    request;
  const setupResults: CommandResult[] = [];
  const checkResults: CommandResult[] = [];

  /** Whether the run this round belongs to has been stopped by its caller. */
  const stopped = (): boolean => stop?.aborted === true;

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
    if (stopped()) {
      // The run was stopped while the round was between two commands: this one
      // is not started, and neither is anything after it.
      return incompleteRound(setupResults, checkResults, stoppedBeforeNext(where));
    }
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
      stop,
      ...(env === undefined ? {} : { env }),
    });
    setupResults.push(result);
    if (!commandSucceeded(result)) {
      const problem = `${describeStop(where, result, limitMs < commandTimeoutMs)}.\n${stopSuffix(result, SETUP_STOPPED)}`;
      return incompleteRound(setupResults, checkResults, problem);
    }
  }

  for (const [index, command] of checks.entries()) {
    const where = describeInvocation('check', index + 1, checks.length, command);
    if (stopped()) {
      return incompleteRound(setupResults, checkResults, stoppedBeforeNext(where));
    }
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
      stop,
      ...(env === undefined ? {} : { env }),
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
