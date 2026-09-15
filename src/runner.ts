/**
 * The task loop: the order the work happens in, and nothing else.
 *
 * {@link runTask} is an ordinary async function that takes one loaded task and
 * one loaded configuration through the bounded loop:
 *
 * ```text
 * prepare → baseline checks → implementation turn → post-agent checks
 *                                    ↑                     |
 *                                    └──── repair turn ←───┘
 *                                       (while maxRepairs allows, and only
 *                                        for a completed red round)
 * ```
 *
 * The task and the command plan come from the caller and stay in memory: the
 * runner never re-reads them, so nothing the working copy, the coding turn, or
 * the target project writes can change which commands decide the run. The
 * working copy is the only place the runner's work is placed, and the plan lives
 * outside it. A red baseline stops the run before any coding turn: a baseline
 * that does not pass says the task's starting point is not the one the run was
 * approved against, and a coding turn cannot fix that.
 *
 * After each coding turn the configured checks are rerun — setup first, then
 * every check — and what they observed decides what happens next:
 *
 * - a completed green round ends the run as `passed`, immediately, with no
 *   further turn;
 * - a completed red round is repair feedback, and a repair turn is spent on it
 *   only while `maxRepairs` allows one. The repair turn is given the commands
 *   that failed, the output they wrote, and the log files that hold it, along
 *   with the same task context the implementation got;
 * - a round that could not be executed, and a turn that failed, are terminal.
 *   The harness could not run the task's own commands or could not finish the
 *   coding turn, and another coding turn cannot change either. No repair is spent
 *   on an infrastructure failure, and nothing outside this loop retries.
 *
 * `maxRepairs` counts additional top-level coding turns and nothing else: not the
 * checks, not the configured commands, and not the tool calls or other internal
 * events a runtime reports inside one turn (docs/spec.md §3). Every attempt, and
 * with it the agent's own summary of it, is kept in the result; the agent's
 * account of a turn is never what decides the status.
 *
 * ## One deadline, spent by every phase
 *
 * The run's total task time is turned into one absolute deadline before
 * preparation and is never recomputed: preparation, setup, coding turns, and
 * checks all spend that same budget, and a repair turn is not given a fresh one.
 * Each configured command runs under the smaller of its configured limit and the
 * time that is left, and each phase reads what is left before it starts anything.
 *
 * When a limit expires the run is over. It stops there — no later command, no
 * further round, no repair turn — records what it stopped and whether that stop
 * could be confirmed, and ends as `failed`: an expired limit is not a red check
 * round to repair, and the exit code of a command that was cut short says nothing
 * about the task (docs/spec.md §3). An unconfirmed stop is stated rather than
 * assumed, because a working copy that something may still be writing to must
 * not be reused. A run that runs out of time before a run directory exists has
 * nothing to report and is refused instead.
 *
 * Everything the runner needs from outside is a function it was given: the
 * working copy, the checks, the coding turn, the report files, and the clock
 * (see {@link RunnerDependencies}). Only the order is decided here — the helper
 * modules keep their own responsibilities (docs/architecture.md §§2, 3, 5), and
 * the runner does not parse arguments, build commands, or talk to a runtime.
 *
 * The coding runtime is still absent, so `runAgentTurn` has no production
 * implementation and the public `run` command stays unavailable; cancellation is
 * the following task's work, and reuses the stop path this one establishes.
 */

import { commandSucceeded } from './checks.js';
import type { CheckRoundRequest } from './checks.js';
import { readCommandOutput, runLogPath } from './report.js';
import type { AgentLog, RunReportRequest } from './report.js';
import type {
  AttemptEvidence,
  AttemptKind,
  CheckRoundResult,
  FailedCommand,
  HarnessConfig,
  RepairFeedback,
  RunStatus,
  Task,
  TerminationOutcome,
  TimeoutEvidence,
  TimeoutLimit,
} from './types.js';
import type {
  PreparedWorkspace,
  PreflightRequest,
  RunDirectory,
  SourcePreflight,
} from './workspace.js';

/**
 * A run refused because its task time ran out before a run directory existed.
 * It is thrown rather than reported: with no run directory there is no report to
 * write and no working copy to keep, and inventing one would describe a run that
 * never happened (docs/spec.md §3).
 */
export class RunTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunTimeoutError';
  }
}

/** What one run is asked to do: the loaded inputs, already validated and resolved. */
export interface RunTaskRequest {
  /** The task as it was loaded from its file, fixed for the whole run. */
  readonly task: Task;
  /** The configuration as it was loaded from its file, fixed for the whole run. */
  readonly config: HarnessConfig;
  /** Source repository, resolved from the invocation directory by the caller. */
  readonly repoPath: string;
  /**
   * Output directory for run directories, resolved from the configuration
   * file's directory by the caller. `config.workDir` is the configured value;
   * this is that value resolved, and it is the one a run writes to.
   */
  readonly workDir: string;
}

/**
 * Everything one coding turn is told, and where its output goes.
 *
 * The turn works in the run's own working copy — never in the source checkout —
 * and it is given the task as it was loaded, acceptance criteria included. What
 * a turn may do to the target project is between the turn and the task; what a
 * turn may not do is decide the run status, which only the harness's own checks
 * do (docs/spec.md §5).
 */
export interface AgentTurnRequest {
  /** Whether this turn implements the task or repairs a failed round. */
  readonly kind: AttemptKind;
  /** 1 for the implementation turn; the repair turns follow as 2, 3, … */
  readonly turn: number;
  /** The loaded task: its text, its description, and its acceptance criteria. */
  readonly task: Task;
  /** The working copy this turn works in: `<runDir>/workspace`. */
  readonly workspacePath: string;
  /** The repository the working copy was cloned from, for context. */
  readonly sourceRoot: string;
  /** The recorded base commit the working copy started from. */
  readonly baseCommit: string;
  /**
   * This turn's own log file, written as the turn produces output. A turn keeps
   * what it did here, and an earlier turn's file is never reused.
   */
  readonly agentLog: AgentLog;
  /**
   * What this turn repairs: the failures of the round that was red after the
   * previous coding turn, with the output they wrote and where it lives. `null`
   * for the implementation turn, which repairs no round. The task context above
   * is the same one the implementation turn received, so a repair turn has both
   * the original task and what was observed to go wrong.
   */
  readonly repair: RepairFeedback | null;
  /**
   * Asked to abort when the run's remaining task time is used up, and — from
   * T09 — when the user stops the run. A turn is not the only thing that spends
   * the run's budget, so this signal carries the same deadline every other phase
   * does, in the one form a runtime can honour: the turn stops working, stops
   * the processes it manages, and returns. The runner awaits it and then starts
   * nothing further, so a turn that ignores the signal delays the run's end but
   * can never add a check, a repair, or a status of its own.
   */
  readonly stop: AbortSignal;
}

/**
 * What a completed coding turn reports back. A turn that could not finish
 * rejects instead, and the runner then treats the run as failed: a turn that did
 * not complete has no checks observed after it, and none are invented.
 */
export interface AgentTurnResult {
  /** The agent's own short summary of the turn, or `null` when it gave none. */
  readonly summary: string | null;
}

/**
 * The concrete functions one run uses. Each has the signature of the helper it
 * stands for, so a real caller composes them directly and a test passes its own
 * for the one collaborator it is about — the working copy, the checks, the
 * coding turn, the report files, or the clock (docs/architecture.md §3).
 *
 * There is no default and no fake in this module: a run uses exactly the
 * functions its caller handed it. `runAgentTurn` is the one with no production
 * implementation yet; the coding runtime arrives with its own task.
 */
export interface RunnerDependencies {
  /** Reads the source repository and the output location; allocates nothing. */
  readonly preflight: (request: PreflightRequest) => Promise<SourcePreflight>;
  /** Allocates `<workDir>/<runId>` with its `workspace` and `logs` directories. */
  readonly allocateRunDirectory: (workDir: string) => Promise<RunDirectory>;
  /**
   * Fills an allocated run directory with a clone of the recorded base, bounded
   * by the run's remaining task time.
   */
  readonly prepareWorkspace: (
    run: RunDirectory,
    source: SourcePreflight,
    bounds: { readonly deadlineMs: number; readonly now: () => Date },
  ) => Promise<PreparedWorkspace>;
  /** Runs one setup/check round in the working copy. */
  readonly runCheckRound: (request: CheckRoundRequest) => Promise<CheckRoundResult>;
  /** Runs one top-level coding turn and awaits its completion. */
  readonly runAgentTurn: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
  /** Creates one coding turn's own log file. */
  readonly openAgentLog: (logsDir: string, turn: number) => Promise<AgentLog>;
  /** Appends one line to the run's lifecycle timeline. */
  readonly appendRunLog: (runLog: string, message: string) => Promise<void>;
  /** Writes the final report and returns the file it wrote. */
  readonly writeRunReport: (request: RunReportRequest) => Promise<string>;
  /** The current time, as the report's start and end of run. */
  readonly now: () => Date;
}

/** What one run left behind for its caller to print or inspect. */
export interface RunTaskResult {
  /** The allocated run directory: the run ID, its layout, and its logs. */
  readonly run: RunDirectory;
  /** The prepared working copy, or `null` when preparation failed. */
  readonly workspace: PreparedWorkspace | null;
  /** How the run ended; see {@link RunStatus}. */
  readonly status: RunStatus;
  /** Why it ended that way, in one sentence. */
  readonly reason: string;
  /**
   * What stopped the run when its time ran out, as the report records it;
   * `null` for a run that ended for any other reason.
   */
  readonly timeout: TimeoutEvidence | null;
  /** The written final report: `<runDir>/result.json`. */
  readonly reportPath: string;
}

/**
 * A stop request that fires when the run's remaining task time is used up, with
 * the way to release it. The signal carries a reason, so a runtime that stops a
 * turn can say why without a second channel for the run's deadline.
 */
function deadlineSignal(remainingMs: number): { readonly signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort(
        new Error(`the run's remaining task time (${String(remainingMs)} ms) is used up`),
      );
    },
    Math.max(0, remainingMs),
  );
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A problem, or any other text, as the single line the timeline holds. Problems
 * from the helpers can span several lines; the timeline keeps the first line,
 * which is the one naming what went wrong, and the report keeps the full text.
 */
function oneLine(text: string): string {
  const [first = ''] = text.split('\n');
  const trimmed = first.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? text.replace(/\s+/g, ' ').trim() : trimmed;
}

/** `1 check`, `2 checks`: a count in the timeline and the reasons reads as prose. */
function count(amount: number, singular: string): string {
  return `${amount} ${amount === 1 ? singular : `${singular}s`}`;
}

/** The plan a round is about to run, as the timeline names it. */
function describePlan(config: HarnessConfig): string {
  return `${count(config.setup.length, 'setup command')}, ${count(config.checks.length, 'check')}`;
}

/** How many checks were observed not to succeed, out of those that were run. */
function describeFailedChecks(round: CheckRoundResult): string {
  const failed = round.checks.filter((result) => !commandSucceeded(result)).length;
  return `${failed} of ${count(round.checks.length, 'check')} did not pass`;
}

/** How the timeline names one top-level coding turn. */
function nameTurn(kind: AttemptKind, turn: number): string {
  return kind === 'implementation' ? 'implementation turn' : `repair turn ${String(turn)}`;
}

/** How the reasons name one top-level coding turn, in a sentence. */
function describeTurn(kind: AttemptKind, turn: number): string {
  return kind === 'implementation' ? 'the implementation turn' : nameTurn(kind, turn);
}

/** How many repair turns the attempts so far have spent. */
function repairsSpent(attempts: readonly AttemptEvidence[]): number {
  return attempts.filter((attempt) => attempt.kind === 'repair').length;
}

/** Why a run that ends green ended where it did, with the allowance it spent. */
function describePassed(kind: AttemptKind, turn: number, spent: number, allowed: number): string {
  return kind === 'implementation'
    ? `every configured check passed after ${describeTurn(kind, turn)}`
    : `every configured check passed after ${describeTurn(kind, turn)} (${String(spent)} of ${String(allowed)} repair turns used)`;
}

/**
 * What a completed red round observed not to succeed, with the output each of
 * those commands wrote, as a repair turn is given it.
 *
 * Only a completed red round reaches a repair turn, and such a round ran every
 * check and every setup command successfully — a setup command that did not
 * succeed, and a command that could not be started, would have stopped the round
 * as an execution error instead — so the failures are the checks that did not
 * exit `0`.
 */
async function failedCommands(round: CheckRoundResult): Promise<FailedCommand[]> {
  const failures: FailedCommand[] = [];
  for (const result of round.checks) {
    if (!commandSucceeded(result)) {
      failures.push({ result, output: await readCommandOutput(result) });
    }
  }
  return failures;
}

/** What a completed round did, as the timeline records it. */
function describeRound(round: CheckRoundResult): string {
  if (round.outcome === 'passed') {
    return 'passed';
  }
  if (round.outcome === 'failed') {
    return `failed, ${round.checks.filter(commandSucceeded).length} of ${count(round.checks.length, 'check')} passed`;
  }
  return `execution-error, ${oneLine(round.problem ?? 'no explanation was recorded')}`;
}

/** How the timeline names the limit that expired. */
function describeTimeoutLimit(evidence: TimeoutEvidence): string {
  return evidence.limit === 'task'
    ? `the run's task deadline (${String(evidence.limitMs)} ms)`
    : `a configured command limit (${String(evidence.limitMs)} ms)`;
}

/** Why a run whose limit expired during a round of checks ended there. */
function describeRoundTimeout(phase: string, evidence: TimeoutEvidence): string {
  const what =
    evidence.limit === 'task'
      ? "the run's task deadline expired"
      : 'a configured command was stopped at its limit';
  const stopped =
    evidence.termination === 'confirmed'
      ? 'nothing further was started'
      : 'the stop could not be confirmed, so the working copy must not be reused and nothing further was started';
  return `${what} during ${phase}: ${stopped}`;
}

/**
 * Runs one task through the bounded loop and writes its final report.
 *
 * The source repository and the output location are checked before anything is
 * allocated: a run that is refused there has no run directory and therefore
 * nothing to report, so the refusal is thrown to the caller instead of becoming
 * a fictional run (docs/spec.md §3). Every failure after that point keeps the run
 * directory and its evidence, and ends the run as `failed` with a report naming
 * the reason — the loop stops at the first of those, and nothing retries a turn,
 * a round, or the run itself. A report that cannot be written is a thrown
 * `ReportError`: a run must never announce a report location that does not exist.
 *
 * The run's deadline is established here, before preparation, and is the one
 * budget every phase afterwards spends. A run that reaches the end of it is
 * finalized from the evidence it already has, with a {@link TimeoutEvidence}
 * naming the limit that expired and what could not be confirmed about the stop.
 */
export async function runTask(
  request: RunTaskRequest,
  dependencies: RunnerDependencies,
): Promise<RunTaskResult> {
  const { task, config } = request;
  const start = dependencies.now();
  const startedAt = start.toISOString();
  const taskLimitMs = config.taskTimeoutMinutes * 60_000;
  const commandLimitMs = config.commandTimeoutMinutes * 60_000;
  /**
   * The one deadline of this run, and what it has left. Every phase reads its
   * budget from here, and nothing recomputes the deadline from a new limit: a
   * later phase — a repair turn above all — cannot hand the run time it has
   * already spent.
   */
  const deadlineMs = start.getTime() + taskLimitMs;
  const remainingMs = (): number => deadlineMs - dependencies.now().getTime();

  const source = await dependencies.preflight({
    repoPath: request.repoPath,
    workDir: request.workDir,
  });

  if (remainingMs() <= 0) {
    // Nothing of the run exists yet: there is no run directory to keep, no
    // working copy, and no report, and saying so is the honest answer.
    throw new RunTimeoutError(
      [
        `the run's task time limit of ${String(taskLimitMs)} ms expired while the source repository was being checked, before any run directory was allocated.`,
        'No run directory, no working copy, and no report were created: there is nothing to inspect and nothing to reuse, and no command and no coding turn was started.',
        `Run the task again with more than ${String(config.taskTimeoutMinutes)} minutes of task time available.`,
      ].join('\n'),
    );
  }

  const run = await dependencies.allocateRunDirectory(request.workDir);
  const timeline = runLogPath(run.logsDir);
  await dependencies.appendRunLog(
    timeline,
    `run ${run.runId} started: task ${JSON.stringify(task.id)} (${oneLine(task.title)})`,
  );
  await dependencies.appendRunLog(
    timeline,
    `task deadline set for ${new Date(deadlineMs).toISOString()}: ${String(taskLimitMs)} ms of total task time, ${String(commandLimitMs)} ms per configured command`,
  );

  let workspace: PreparedWorkspace | null = null;
  let preparationProblem: string | null = null;
  try {
    workspace = await dependencies.prepareWorkspace(run, source, {
      deadlineMs,
      now: dependencies.now,
    });
    await dependencies.appendRunLog(
      timeline,
      `workspace prepared at ${oneLine(workspace.workspacePath)} on branch ${workspace.branch} at ${source.baseCommit}`,
    );
  } catch (cause) {
    // Preparation can fail after the run directory exists. The run is over, but
    // what was created is kept, and the report records the facts it has instead
    // of describing a working copy that was never made.
    preparationProblem = messageOf(cause);
    await dependencies.appendRunLog(
      timeline,
      `workspace preparation failed: ${oneLine(preparationProblem)}`,
    );
  }

  /** The record of a limit that expired, as the report keeps it. */
  const timedOut = (parts: {
    readonly limit: TimeoutLimit;
    readonly phase: string;
    readonly limitMs: number;
    readonly termination?: TerminationOutcome;
    readonly problem?: string | null;
  }): TimeoutEvidence => ({
    limit: parts.limit,
    phase: parts.phase,
    limitMs: parts.limitMs,
    elapsedMs: Math.max(0, dependencies.now().getTime() - start.getTime()),
    // A limit that expires between two commands leaves nothing of the run's own
    // running, so an unconfirmed stop is always one a command reported.
    termination: parts.termination ?? 'confirmed',
    problem:
      parts.termination === 'unconfirmed'
        ? (parts.problem ?? 'the harness recorded no reason for the unconfirmed stop')
        : null,
  });

  /** Ends the run: the timeline records the status, then the report is written. */
  const endRun = async (parts: {
    readonly status: RunStatus;
    readonly reason: string;
    readonly baseline: CheckRoundResult | null;
    readonly attempts: readonly AttemptEvidence[];
    readonly timeout: TimeoutEvidence | null;
  }): Promise<RunTaskResult> => {
    await dependencies.appendRunLog(
      timeline,
      `final status: ${parts.status}, ${oneLine(parts.reason)}`,
    );
    const reportPath = await dependencies.writeRunReport({
      run,
      task: { id: task.id, title: task.title },
      source,
      workspace,
      preparationProblem,
      startedAt,
      endedAt: dependencies.now().toISOString(),
      status: parts.status,
      reason: parts.reason,
      baseline: parts.baseline,
      attempts: parts.attempts,
      timeout: parts.timeout,
    });
    return {
      run,
      workspace,
      status: parts.status,
      reason: parts.reason,
      timeout: parts.timeout,
      reportPath,
    };
  };

  /**
   * Ends the run because its time ran out: the timeline records the limit, then
   * the run is finalized from the evidence it already has. Every timeout leaves
   * the loop here, so nothing else is started after one, and the status is always
   * `failed` — an expired limit is not a red check round, and it is not a pass.
   */
  const endTimedOut = async (parts: {
    readonly reason: string;
    readonly baseline: CheckRoundResult | null;
    readonly attempts: readonly AttemptEvidence[];
    readonly evidence: TimeoutEvidence;
  }): Promise<RunTaskResult> => {
    const { evidence } = parts;
    await dependencies.appendRunLog(
      timeline,
      `timeout: ${describeTimeoutLimit(evidence)} expired during ${evidence.phase}` +
        (evidence.termination === 'confirmed'
          ? ''
          : `; termination unconfirmed: ${evidence.problem ?? 'no reason was recorded'}`),
    );
    return endRun({
      status: 'failed',
      reason: parts.reason,
      baseline: parts.baseline,
      attempts: parts.attempts,
      timeout: evidence,
    });
  };

  if (workspace === null) {
    if (remainingMs() <= 0) {
      // Preparation stopped because the run's own deadline had passed, not
      // because Git failed. The report keeps the preparation problem it has,
      // and the timeout says which limit was responsible.
      const evidence = timedOut({
        limit: 'task',
        phase: 'preparation of the working copy',
        limitMs: taskLimitMs,
      });
      return endTimedOut({
        reason:
          "the run's task deadline expired while the working copy was being prepared, so no check and no coding turn was started",
        baseline: null,
        attempts: [],
        evidence,
      });
    }
    return endRun({
      status: 'failed',
      reason: 'preparing the working copy failed, so no check and no coding turn was started',
      baseline: null,
      attempts: [],
      timeout: null,
    });
  }

  // Everything below works in the prepared working copy, and keeps it.
  const workspacePath = workspace.workspacePath;

  /**
   * One round of the configured plan in the working copy. Every invocation it
   * starts is bounded by the same deadline the run was given, and the round
   * reads what is left of the task time before each one.
   */
  const runRound = (name: string): Promise<CheckRoundResult> =>
    dependencies.runCheckRound({
      setup: config.setup,
      checks: config.checks,
      cwd: workspacePath,
      logsDir: run.logsDir,
      name,
      commandTimeoutMs: commandLimitMs,
      deadlineMs,
      now: dependencies.now,
    });

  /**
   * What stopped a round because the run's time ran out, if that is what
   * happened. An expired limit reaches the runner as an execution error, so it
   * is recognized here, before that outcome can be read as an infrastructure
   * problem — and long before it could be mistaken for repair feedback.
   */
  const roundStop = (round: CheckRoundResult, phase: string): TimeoutEvidence | null => {
    const stopped = [...round.setup, ...round.checks].find(
      (result) => result.outcome === 'timed-out',
    );
    if (stopped !== undefined) {
      // A command that ran under less than its configured limit was bounded by
      // the task time that was left: that is the limit which expired.
      const termination = stopped.termination ?? 'unconfirmed';
      return timedOut({
        limit: stopped.timeoutMs < commandLimitMs ? 'task' : 'command',
        phase,
        limitMs: stopped.timeoutMs,
        termination,
        problem: stopped.terminationProblem,
      });
    }
    if (round.outcome === 'execution-error' && remainingMs() <= 0) {
      // The round spent the run's time before it could start the command it was
      // about to start, and stopped there rather than starting it late.
      return timedOut({ limit: 'task', phase, limitMs: taskLimitMs });
    }
    return null;
  };

  // The baseline: the configured plan, run in the working copy before any coding
  // turn. Only a completed green round lets the run continue.
  if (remainingMs() <= 0) {
    const evidence = timedOut({
      limit: 'task',
      phase: 'the baseline checks',
      limitMs: taskLimitMs,
    });
    return endTimedOut({
      reason:
        "the run's task deadline expired before the baseline checks started, so neither they nor any coding turn was started",
      baseline: null,
      attempts: [],
      evidence,
    });
  }

  await dependencies.appendRunLog(
    timeline,
    `baseline check-round started: ${describePlan(config)}`,
  );
  const baseline = await runRound('baseline');
  await dependencies.appendRunLog(
    timeline,
    `baseline check-round result: ${describeRound(baseline)}`,
  );

  const baselineStop = roundStop(baseline, 'the baseline checks');
  if (baselineStop !== null) {
    return endTimedOut({
      reason: describeRoundTimeout('the baseline checks', baselineStop),
      baseline,
      attempts: [],
      evidence: baselineStop,
    });
  }

  if (baseline.outcome === 'execution-error') {
    return endRun({
      status: 'failed',
      reason: `the baseline could not be executed: ${oneLine(baseline.problem ?? 'no explanation was recorded')}`,
      baseline,
      attempts: [],
      timeout: null,
    });
  }
  if (baseline.outcome === 'failed') {
    return endRun({
      status: 'failed',
      reason: 'the baseline checks did not pass, so no coding turn was started',
      baseline,
      attempts: [],
      timeout: null,
    });
  }

  // The coding turns: the implementation first, then one repair turn per
  // completed red round while `maxRepairs` allows one. Every way out of this loop
  // ends the run: green, red with no allowance left, a turn that failed, and a
  // round that could not be executed.
  const attempts: AttemptEvidence[] = [];
  let turn = 1;
  let kind: AttemptKind = 'implementation';
  let repair: RepairFeedback | null = null;

  for (;;) {
    // The task deadline is read before every coding turn, so a repair turn is
    // started only with time left to run it and to check the result.
    const left = remainingMs();
    if (left <= 0) {
      const evidence = timedOut({
        limit: 'task',
        phase: nameTurn(kind, turn),
        limitMs: taskLimitMs,
      });
      return endTimedOut({
        reason: `the run's task deadline expired before ${describeTurn(kind, turn)} was started, so no further turn and no check was run`,
        baseline,
        attempts,
        evidence,
      });
    }

    // The coding turn, awaited to completion: the checks that follow it must
    // observe a working copy nothing else is writing to. The turn is also given
    // the run's own remaining time as a stop request, so work that would run
    // past the deadline is asked to stop rather than left to.
    await dependencies.appendRunLog(
      timeline,
      kind === 'implementation'
        ? `${nameTurn(kind, turn)} started`
        : `${nameTurn(kind, turn)} started: repair ${String(turn - 1)} of ${String(config.maxRepairs)} allowed`,
    );
    const agentLog = await dependencies.openAgentLog(run.logsDir, turn);
    const stop = deadlineSignal(left);
    let completed: AgentTurnResult | null = null;
    let turnProblem: string | null = null;
    try {
      completed = await dependencies.runAgentTurn({
        kind,
        turn,
        task,
        workspacePath,
        sourceRoot: workspace.sourceRoot,
        baseCommit: workspace.baseCommit,
        agentLog,
        repair,
        stop: stop.signal,
      });
    } catch (cause) {
      turnProblem = messageOf(cause);
    } finally {
      // The turn has returned, so its stop request is released rather than left
      // armed for a turn that is no longer running.
      stop.cancel();
    }
    // The log is closed either way: a turn that failed keeps whatever it wrote
    // before the failure, and a log that cannot be flushed is a reporting failure.
    await agentLog.close();
    await dependencies.appendRunLog(
      timeline,
      completed === null
        ? `${nameTurn(kind, turn)} result: failed, ${oneLine(turnProblem ?? 'no explanation was recorded')}`
        : `${nameTurn(kind, turn)} result: completed`,
    );

    if (stop.signal.aborted) {
      // The run's time ran out while the turn was working. What the turn
      // reported is not a check result and nothing follows it: no round runs,
      // no repair is spent, and a turn that failed at the same moment does not
      // replace the reason the run actually stopped for.
      attempts.push({
        turn,
        kind,
        agentLog: agentLog.path,
        agentSummary: completed?.summary ?? null,
        checks: null,
      });
      const evidence = timedOut({
        limit: 'task',
        phase: nameTurn(kind, turn),
        limitMs: taskLimitMs,
      });
      return endTimedOut({
        reason: `${describeTurn(kind, turn)} was stopped when the run's remaining task time ran out, so no check was run after it and no further turn was started`,
        baseline,
        attempts,
        evidence,
      });
    }

    if (completed === null) {
      // A turn that could not finish is terminal: no round was observed after it,
      // none is invented, and the failure is not something another coding turn is
      // asked to repair.
      attempts.push({ turn, kind, agentLog: agentLog.path, agentSummary: null, checks: null });
      return endRun({
        status: 'failed',
        reason: `${describeTurn(kind, turn)} failed, so no check was run after it: ${oneLine(turnProblem ?? 'no explanation was recorded')}`,
        baseline,
        attempts,
        timeout: null,
      });
    }

    // The post-agent round: setup again, then every configured check. The agent's
    // own account of the turn is kept beside these results, never in place of them.
    await dependencies.appendRunLog(
      timeline,
      `post-agent check-round started: ${describePlan(config)}`,
    );
    const observed = await runRound(`attempt-${String(turn)}`);
    await dependencies.appendRunLog(
      timeline,
      `post-agent check-round result: ${describeRound(observed)}`,
    );
    attempts.push({
      turn,
      kind,
      agentLog: agentLog.path,
      agentSummary: completed.summary,
      checks: observed,
    });

    const phase = `the checks after ${describeTurn(kind, turn)}`;
    const roundTimeout = roundStop(observed, phase);
    if (roundTimeout !== null) {
      return endTimedOut({
        reason: describeRoundTimeout(phase, roundTimeout),
        baseline,
        attempts,
        evidence: roundTimeout,
      });
    }

    if (observed.outcome === 'passed') {
      return endRun({
        status: 'passed',
        reason: describePassed(kind, turn, repairsSpent(attempts), config.maxRepairs),
        baseline,
        attempts,
        timeout: null,
      });
    }

    if (observed.outcome === 'execution-error') {
      // The harness could not run the task's own commands. That is not a failed
      // check to code around, so it costs no repair turn and ends the run here.
      return endRun({
        status: 'failed',
        reason: `the checks after ${describeTurn(kind, turn)} could not be executed: ${oneLine(observed.problem ?? 'no explanation was recorded')}`,
        baseline,
        attempts,
        timeout: null,
      });
    }

    // A completed red round is repair feedback. It is sent back only while the
    // allowance lasts: `maxRepairs` counts these additional coding turns, so the
    // check is against the repairs already spent, not against the checks run.
    const spent = repairsSpent(attempts);
    if (spent >= config.maxRepairs) {
      await dependencies.appendRunLog(
        timeline,
        `repair allowance exhausted: ${String(spent)} of ${String(config.maxRepairs)} repair turns used`,
      );
      return endRun({
        status: 'failed',
        reason:
          `the checks after ${describeTurn(kind, turn)} did not pass and the repair allowance is ` +
          `exhausted (${String(spent)} of ${String(config.maxRepairs)} repair turns used): ` +
          describeFailedChecks(observed),
        baseline,
        attempts,
        timeout: null,
      });
    }

    turn += 1;
    kind = 'repair';
    repair = { repairedTurn: turn - 1, failures: await failedCommands(observed) };
  }
}
