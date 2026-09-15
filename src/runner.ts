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
 * Everything the runner needs from outside is a function it was given: the
 * working copy, the checks, the coding turn, the report files, and the clock
 * (see {@link RunnerDependencies}). Only the order is decided here — the helper
 * modules keep their own responsibilities (docs/architecture.md §§2, 3, 5), and
 * the runner does not parse arguments, build commands, or talk to a runtime.
 *
 * The coding runtime is still absent, so `runAgentTurn` has no production
 * implementation and the public `run` command stays unavailable; the deadline and
 * cancellation stop paths are the following tasks' work.
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
} from './types.js';
import type {
  PreparedWorkspace,
  PreflightRequest,
  RunDirectory,
  SourcePreflight,
} from './workspace.js';

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
  /** Fills an allocated run directory with a clone of the recorded base. */
  readonly prepareWorkspace: (
    run: RunDirectory,
    source: SourcePreflight,
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
  /** The written final report: `<runDir>/result.json`. */
  readonly reportPath: string;
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
 */
export async function runTask(
  request: RunTaskRequest,
  dependencies: RunnerDependencies,
): Promise<RunTaskResult> {
  const { task, config } = request;
  const startedAt = dependencies.now().toISOString();

  const source = await dependencies.preflight({
    repoPath: request.repoPath,
    workDir: request.workDir,
  });
  const run = await dependencies.allocateRunDirectory(request.workDir);
  const timeline = runLogPath(run.logsDir);
  await dependencies.appendRunLog(
    timeline,
    `run ${run.runId} started: task ${JSON.stringify(task.id)} (${oneLine(task.title)})`,
  );

  let workspace: PreparedWorkspace | null = null;
  let preparationProblem: string | null = null;
  try {
    workspace = await dependencies.prepareWorkspace(run, source);
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

  /** Ends the run: the timeline records the status, then the report is written. */
  const endRun = async (parts: {
    readonly status: RunStatus;
    readonly reason: string;
    readonly baseline: CheckRoundResult | null;
    readonly attempts: readonly AttemptEvidence[];
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
    });
    return {
      run,
      workspace,
      status: parts.status,
      reason: parts.reason,
      reportPath,
    };
  };

  if (workspace === null) {
    return endRun({
      status: 'failed',
      reason: 'preparing the working copy failed, so no check and no coding turn was started',
      baseline: null,
      attempts: [],
    });
  }

  // The baseline: the configured plan, run in the working copy before any coding
  // turn. Only a completed green round lets the run continue.
  await dependencies.appendRunLog(
    timeline,
    `baseline check-round started: ${describePlan(config)}`,
  );
  const baseline = await dependencies.runCheckRound({
    setup: config.setup,
    checks: config.checks,
    cwd: workspace.workspacePath,
    logsDir: run.logsDir,
    name: 'baseline',
  });
  await dependencies.appendRunLog(
    timeline,
    `baseline check-round result: ${describeRound(baseline)}`,
  );

  if (baseline.outcome === 'execution-error') {
    return endRun({
      status: 'failed',
      reason: `the baseline could not be executed: ${oneLine(baseline.problem ?? 'no explanation was recorded')}`,
      baseline,
      attempts: [],
    });
  }
  if (baseline.outcome === 'failed') {
    return endRun({
      status: 'failed',
      reason: 'the baseline checks did not pass, so no coding turn was started',
      baseline,
      attempts: [],
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
    // The coding turn, awaited to completion: the checks that follow it must
    // observe a working copy nothing else is writing to.
    await dependencies.appendRunLog(
      timeline,
      kind === 'implementation'
        ? `${nameTurn(kind, turn)} started`
        : `${nameTurn(kind, turn)} started: repair ${String(turn - 1)} of ${String(config.maxRepairs)} allowed`,
    );
    const agentLog = await dependencies.openAgentLog(run.logsDir, turn);
    let completed: AgentTurnResult | null = null;
    let turnProblem: string | null = null;
    try {
      completed = await dependencies.runAgentTurn({
        kind,
        turn,
        task,
        workspacePath: workspace.workspacePath,
        sourceRoot: workspace.sourceRoot,
        baseCommit: workspace.baseCommit,
        agentLog,
        repair,
      });
    } catch (cause) {
      turnProblem = messageOf(cause);
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
      });
    }

    // The post-agent round: setup again, then every configured check. The agent's
    // own account of the turn is kept beside these results, never in place of them.
    await dependencies.appendRunLog(
      timeline,
      `post-agent check-round started: ${describePlan(config)}`,
    );
    const observed = await dependencies.runCheckRound({
      setup: config.setup,
      checks: config.checks,
      cwd: workspace.workspacePath,
      logsDir: run.logsDir,
      name: `attempt-${String(turn)}`,
    });
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

    if (observed.outcome === 'passed') {
      return endRun({
        status: 'passed',
        reason: describePassed(kind, turn, repairsSpent(attempts), config.maxRepairs),
        baseline,
        attempts,
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
      });
    }

    turn += 1;
    kind = 'repair';
    repair = { repairedTurn: turn - 1, failures: await failedCommands(observed) };
  }
}
