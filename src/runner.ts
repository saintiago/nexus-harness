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
 * ## A run its caller stops
 *
 * The run's own stop request arrives through the ordinary execution context: one
 * abort signal on the request, handed to every phase that can be stopped, and
 * read between the operations that cannot. There is no second way to stop a run,
 * and no second path to stop a command tree: a stopped invocation, a stopped
 * round, and a stopped coding turn are all stopped by the same mechanism their
 * own limit uses, and the run then awaits what it stopped before it finalizes.
 *
 * A stopped run ends as `cancelled`, which is neither a pass nor a failure: the
 * task was not decided, and an expired limit is not what happened. The run keeps
 * the evidence it already has, writes its report where it can, and starts
 * nothing further — no later command, no check round, no repair turn.
 *
 * **The first stop reason observed is the one kept.** Every stop is recorded
 * once, at the point it is observed, and the run ends there: a command that exits
 * `0` after it was stopped, a limit that expires while a stop is already being
 * carried out, and a coding turn that answers after it was stopped all arrive at
 * a run that has already ended, and none of them replaces the reason it ended
 * for. Where the two triggers really do race — the deadline and the caller's stop
 * reaching the same signal — the signal keeps the first of them, and the run
 * reports that one.
 *
 * A stop the harness cannot confirm is a limitation the report carries, not a
 * detail it rounds down: the working copy may still be written to by something
 * the harness could not end, so it is kept for inspection and is not reused —
 * not by a later round of the same run, which no stop leaves any room for, and
 * not by a run after it. The harness never claims to have stopped anything it
 * does not own: only a process tree it started itself is ever stopped, and a
 * process something else started is left alone.
 *
 * ## What the run left behind
 *
 * Once the run has stopped writing to its working copy — after the last coding
 * turn has returned and been awaited, or after a stop has been carried out — the
 * working copy is read one last time and compared with the base the run recorded.
 * Nothing is committed, checked out, or cleaned to make that comparison easier:
 * the run has already stopped, and the working copy is evidence. The comparison
 * covers what the turns committed as well as what they left staged, unstaged, or
 * untracked, because a run is judged on what it leaves behind rather than on
 * what it happened to commit (see {@link inspectWorkspaceChanges}).
 *
 * That summary is recorded in the run's timeline and in its report, and it
 * carries two statements with it: what the run's status proves, and which of the
 * changed paths touch tests, tooling, or configuration. The harness points at
 * those paths and stops there — it is not a code auditor, and it does not decide
 * whether a change is a weakening. A run whose working copy cannot be read at all
 * records why, which is never the same as a working copy with nothing to show.
 *
 * Everything the runner needs from outside is a function it was given: the
 * working copy, the checks, the coding turn, the report files, and the clock
 * (see {@link RunnerDependencies}). Only the order is decided here — the helper
 * modules keep their own responsibilities (docs/architecture.md §§2, 3, 5), and
 * the runner does not parse arguments, build commands, or talk to a runtime.
 *
 * The coding turn is provided by `src/agent.ts`, which runs the host's own Codex
 * CLI in the working copy and reports back a summary and, when it stopped what
 * it had started, how that stop went. Everything else about a runtime is that
 * module's business: this one knows nothing about a vendor, an executable, or a
 * flag. Wiring the adapter to a `run` command is the CLI's work, and the runner
 * does not parse arguments, build commands, or talk to a runtime itself.
 *
 * The loaded configuration carries the run's agent selection, and the runner
 * records it — in the report and once in the timeline — without interpreting it:
 * it is launch information, and the runner is not the place that decides what a
 * profile or a model ID means (docs/architecture.md §2).
 */

import { commandSucceeded } from './checks.js';
import type { CheckRoundRequest } from './checks.js';
import {
  readCommandOutput,
  runLogPath,
  summarizeChanges,
  writeSourceTaskSnapshot,
} from './report.js';
import type { AgentLog, RunReportRequest } from './report.js';
import type {
  AttemptEvidence,
  AttemptKind,
  CancellationEvidence,
  ChangedPath,
  ChangeSummary,
  CheckRoundResult,
  FailedCommand,
  HarnessConfig,
  RepairFeedback,
  RunStatus,
  SourceRef,
  Task,
  TerminationOutcome,
  TimeoutEvidence,
  TimeoutLimit,
} from './types.js';
import { inspectWorkspaceChanges } from './workspace.js';
import type {
  ContinuedWorkspace,
  PreparedWorkspace,
  PrepareWorkspaceBounds,
  PreflightRequest,
  RunDirectory,
  SourcePreflight,
  WorkspaceAttempt,
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

/**
 * A run refused because its caller stopped it before a run directory existed.
 * Like {@link RunTimeoutError} it is thrown rather than reported: there is no run
 * directory to keep, no working copy, and no report to write, and a `cancelled`
 * report for a run that never started would describe a run that never happened.
 * A stop after this point is a run of its own, and ends `cancelled` with the
 * evidence it collected (docs/spec.md §3).
 */
export class RunCancelledError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunCancelledError';
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
  /**
   * The run's stop request: what the caller asks it to end with. It is the
   * ordinary execution context of the run, not a separate channel — the same
   * abort signal the phases and the commands are given, so stopping a command
   * tree and stopping the run that owns it are one mechanism (see the module
   * doc above). A request that has already arrived stops work from starting; one
   * that arrives during work stops what the run owns, is awaited, and ends the
   * run as `cancelled` with the reason observed first. Absent means the run has
   * nothing but its own deadline.
   */
  readonly stop?: AbortSignal;
  /**
   * Where a source-triggered run took its task from, or nothing for a run whose
   * task came from a task file. It is provenance: the runner writes it beside
   * the task before any configured command executes, records it once in the
   * timeline, and carries it into the report. The runner interprets none of it
   * and imports no connector (docs/architecture.md §7).
   */
  readonly sourceRef?: SourceRef;
  /**
   * A workspace to continue instead of creating one, already resolved and
   * verified by the caller (`reopenWorkspace`, `src/workspace.ts`). A continued
   * attempt works in the same clone, on the same branch, from the same recorded
   * base as the attempts before it, and its baseline round is allowed to be red:
   * continuing failed work is the point (docs/implement-workspace-continuation.md).
   */
  readonly continuedWorkspace?: ContinuedWorkspace;
  /**
   * Called once, after a run's own workspace exists and before any configured
   * command or coding turn runs, with where the work will live. A source uses it
   * to record the workspace on the issue it came from. A failure here is thrown
   * and ends the run before any paid work: the run directory and the working copy
   * are kept, and the caller decides what the failed record means.
   */
  readonly onWorkspaceReady?: (workspace: PreparedWorkspace) => Promise<void>;
  /**
   * Context for a continued attempt, passed to every coding turn of this run and
   * recorded nowhere else: what a source learned from the issue and from the
   * harness's own earlier attempts (docs/implement-workspace-continuation.md).
   */
  readonly guidance?: readonly string[];
  /**
   * The name of the escalation tier this attempt runs, for the workspace ledger:
   * a label the runner records and never interprets, like `sourceRef`.
   */
  readonly tierName?: string;
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
   * Context a source collected for a continued attempt: the comments added since
   * the previous attempt, and what the harness's own earlier attempts did. It is
   * context for the work, never a command, a path, a repository, or a limit
   * (docs/implement-workspace-continuation.md).
   */
  readonly guidance?: readonly string[];
  /**
   * Asked to abort when the run's remaining task time is used up, and when the
   * run's caller stops it: the same deadline every other phase carries, and the
   * caller's own stop request, in the one form a runtime can honour. Its reason
   * says which of the two arrived, and the first to arrive is the one it says: a
   * turn stopped for its deadline is never reported as stopped by the caller, or
   * the other way round. The turn stops working, stops the managed execution it
   * owns, and returns; the runner awaits it and then starts nothing further, so a
   * turn that ignores the signal delays the run's end but can never add a check,
   * a repair, or a status of its own.
   */
  readonly stop: AbortSignal;
}

/**
 * What a coding turn has to say about the execution it started and stopped,
 * when it stopped one: whether everything it started was seen to end.
 *
 * It is the turn's own record, in the same two parts a configured command's stop
 * is recorded in: `confirmed` only when the stop reached the operating system
 * *and* the execution was seen to end, and `unconfirmed` with what could not be
 * confirmed otherwise. A stop the harness cannot confirm is never rounded down
 * to a confirmed one: a working copy something may still be writing to must not
 * be declared safe to reuse (docs/spec.md §3).
 */
export interface AgentTurnShutdown {
  /** Whether everything the turn started was seen to end. */
  readonly termination: TerminationOutcome;
  /** What could not be confirmed, when {@link termination} is `unconfirmed`. */
  readonly problem: string | null;
}

/**
 * What a completed coding turn reports back. A turn that could not finish
 * rejects instead, and the runner then treats the run as failed: a turn that did
 * not complete has no checks observed after it, and none are invented.
 */
export interface AgentTurnResult {
  /** The agent's own short summary of the turn, or `null` when it gave none. */
  readonly summary: string | null;
  /**
   * How the turn's own stop of the execution it started went, or nothing at all
   * when the turn stopped nothing — a turn that started nothing, or one whose
   * runtime ended by itself, has no stop to report. Present with an
   * `unconfirmed` termination, the run does not go on to read the working copy:
   * it may still be written to.
   */
  readonly shutdown?: AgentTurnShutdown | null;
}

/**
 * The concrete functions one run uses. Each has the signature of the helper it
 * stands for, so a real caller composes them directly and a test passes its own
 * for the one collaborator it is about — the working copy, the checks, the
 * coding turn, the report files, or the clock (docs/architecture.md §3).
 *
 * There is no default and no fake in this module: a run uses exactly the
 * functions its caller handed it. `runAgentTurn` is `src/agent.ts`, which runs
 * the host's own Codex CLI in the run's working copy; a run composes it like any
 * other of these, and a test hands it its own instead.
 */
export interface RunnerDependencies {
  /** Reads the source repository and the output location; allocates nothing. */
  readonly preflight: (request: PreflightRequest) => Promise<SourcePreflight>;
  /** Allocates `<workDir>/<runId>` with its `workspace` and `logs` directories. */
  readonly allocateRunDirectory: (workDir: string) => Promise<RunDirectory>;
  /**
   * Fills an allocated run directory with a clone of the recorded base, bounded
   * by the run's remaining task time and by the run's own stop request.
   */
  readonly prepareWorkspace: (
    run: RunDirectory,
    source: SourcePreflight,
    bounds: PrepareWorkspaceBounds,
  ) => Promise<PreparedWorkspace>;
  /** Runs one setup/check round in the working copy. */
  readonly runCheckRound: (request: CheckRoundRequest) => Promise<CheckRoundResult>;
  /**
   * Runs one top-level coding turn and awaits its completion. The production
   * one is `runCodexTurn` from `src/agent.ts`; it is the only collaborator that
   * talks to a coding runtime, so it is the one a fake stands in for.
   */
  readonly runAgentTurn: (request: AgentTurnRequest) => Promise<AgentTurnResult>;
  /** Creates one coding turn's own log file. */
  readonly openAgentLog: (logsDir: string, turn: number) => Promise<AgentLog>;
  /** Appends one line to the run's lifecycle timeline. */
  readonly appendRunLog: (runLog: string, message: string) => Promise<void>;
  /** Writes the final report and returns the file it wrote. */
  readonly writeRunReport: (request: RunReportRequest) => Promise<string>;
  /**
   * Records one finished attempt against the workspace it ran in, in that
   * workspace's ledger (`src/workspace.ts`). It is derived state: a run's own
   * report stays the authority on what the run did.
   */
  readonly recordWorkspaceAttempt: (
    workDir: string,
    workspaceId: string,
    attempt: WorkspaceAttempt,
  ) => Promise<void>;
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
   * The check evidence the report carries: the baseline round, or `null` when
   * none was observed. A caller that has to summarize the checks for something
   * outside the run — a source command publishing a result comment — reads it
   * here rather than re-reading a report file.
   */
  readonly baseline: CheckRoundResult | null;
  /** One entry per top-level coding turn, oldest first: the report's own list. */
  readonly attempts: readonly AttemptEvidence[];
  /**
   * Additional top-level coding turns the run spent, counted from its own
   * attempts — the same number its report records, so a caller prints the run's
   * own count rather than its own tally of what it watched happen.
   */
  readonly repairsUsed: number;
  /**
   * What stopped the run when its time ran out, as the report records it;
   * `null` for a run that ended for any other reason.
   */
  readonly timeout: TimeoutEvidence | null;
  /**
   * What stopped a run its caller cancelled, as the report records it; `null`
   * for a run that ended for any other reason. Present exactly when the run was
   * stopped by its caller, with whether that stop was confirmed.
   */
  readonly cancellation: CancellationEvidence | null;
  /**
   * What the retained working copy differs from its recorded base by, what a
   * reader must not conclude from the status, and — when the comparison could not
   * be made — why; see {@link ChangeSummary}. A caller prints this rather than
   * summarizing the working copy again.
   */
  readonly changes: ChangeSummary;
  /** The written final report: `<runDir>/result.json`. */
  readonly reportPath: string;
}

/** Which of the two triggers stopped a run: its own deadline, or its caller. */
type StopKind = 'timeout' | 'cancelled';

/**
 * The reason a stop request carries. The signal is what a runtime honours; the
 * kind is how the run reads back which trigger arrived, so the reason it reports
 * is the one that happened rather than the other one.
 */
class RunStopReason extends Error {
  readonly kind: StopKind;

  constructor(kind: StopKind, message: string) {
    super(message);
    this.name = 'RunStopReason';
    this.kind = kind;
  }
}

/** What one phase is given to stop with, and how the run reads it back. */
interface PhaseStop {
  /** Aborts when the run's deadline expires or its caller stops it, and only then. */
  readonly signal: AbortSignal;
  /**
   * Why it aborted: the first of the two triggers to arrive, or `null` when
   * neither has. Read after the phase returns, this is what the run stopped for.
   */
  kind(): StopKind | null;
  /**
   * Releases both triggers: the deadline timer is cleared and the caller's stop
   * request is no longer listened to. A phase that has returned leaves nothing
   * armed behind it, and the signal it handed out is left un-aborted by this —
   * releasing a phase's stop ends the phase's interest in it, it does not stop
   * the phase.
   */
  cancel(): void;
}

/**
 * The stop request one phase of a run works under: the run's remaining task
 * time, and the caller's own stop request, in the one form a phase can honour.
 *
 * Both triggers abort the same signal, so a phase has one thing to watch, and
 * `AbortController` keeps the first of them: the reason the phase stopped for is
 * the first that arrived, and a second trigger reaching an already-stopped phase
 * changes nothing.
 */
function phaseStop(remainingMs: number, callerStop: AbortSignal | undefined): PhaseStop {
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort(
        new RunStopReason(
          'timeout',
          `the run's remaining task time (${String(remainingMs)} ms) is used up`,
        ),
      );
    },
    Math.max(0, remainingMs),
  );

  /** Held by the caller's stop request for exactly as long as this phase runs. */
  let onCallerStop: (() => void) | null = null;
  if (callerStop !== undefined) {
    onCallerStop = () => {
      controller.abort(new RunStopReason('cancelled', 'the run was stopped by its caller'));
    };
    callerStop.addEventListener('abort', onCallerStop, { once: true });
    if (callerStop.aborted) {
      // It arrived before this phase listened for it: the phase is stopped the
      // same way rather than started as if nothing had been asked.
      onCallerStop();
    }
  }

  return {
    signal: controller.signal,
    kind: () => {
      const { reason } = controller.signal;
      return controller.signal.aborted && reason instanceof RunStopReason ? reason.kind : null;
    },
    cancel: () => {
      clearTimeout(timer);
      if (onCallerStop !== null) {
        callerStop?.removeEventListener('abort', onCallerStop);
      }
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

/** Why a run whose caller stopped it during a round of checks ended there. */
function describeRoundCancelled(evidence: CancellationEvidence): string {
  const stopped =
    evidence.termination === 'confirmed'
      ? 'nothing further was started'
      : 'the stop could not be confirmed, so the working copy must not be reused and nothing further was started';
  return `the run was stopped by its caller during ${evidence.phase}: ${stopped}`;
}

/** What an unconfirmed stop is told the harness knows, when it recorded no reason. */
const NO_TERMINATION_REASON = 'the harness recorded no reason for the unconfirmed stop';

/**
 * Why a coding turn's own stop of the execution it started cannot be read as a
 * clean one, or `null` when that stop was confirmed or nothing was stopped.
 *
 * A turn that stopped what it had started and could not confirm the end of it
 * leaves a working copy that may still be written to. That is never rounded down
 * to a confirmed stop, in a report or in the reason a run ends with
 * (docs/spec.md §3).
 */
function unconfirmedShutdownProblem(shutdown: AgentTurnShutdown | null): string | null {
  return shutdown?.termination === 'unconfirmed'
    ? (shutdown.problem ?? NO_TERMINATION_REASON)
    : null;
}

/** The clause a reason carries for a turn whose own stop could not be confirmed. */
function shutdownNote(problem: string | null): string {
  return problem === null
    ? ''
    : `; the harness could not confirm that everything the coding runtime started had ended (${oneLine(problem)}), so the working copy may still be written to`;
}

/**
 * One changed path, as the run timeline lists it: what happened to it, where the
 * difference was seen, and — for the three categories a reviewer has to look at
 * first — why it is worth a look. The path is squeezed onto one line, because the
 * timeline holds one line per state change; the report keeps the path exactly as
 * Git reported it.
 */
function describeChangedPath(entry: ChangedPath): string {
  const file = entry.path.replace(/\s+/g, ' ').trim();
  const review =
    entry.categories.length === 0 ? '' : ` - ${entry.categories.join('/')}: review this change`;
  return `${file} (${entry.kind}, ${entry.states.join(', ')})${review}`;
}

/**
 * What stopped a run, and why it ended there. The run ends for exactly one of
 * these: the deadline it was given, or the stop its caller asked for. Each
 * carries the evidence its report keeps — the two are different records, because
 * an expired limit and a run its caller ended are different facts.
 */
type StopCause =
  | { readonly kind: 'timeout'; readonly reason: string; readonly evidence: TimeoutEvidence }
  | {
      readonly kind: 'cancelled';
      readonly reason: string;
      readonly evidence: CancellationEvidence;
    };

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
  const callerStop = request.stop;
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

  /** Whether the run's caller has asked for it to stop. */
  const stopped = (): boolean => callerStop?.aborted === true;

  /**
   * Refuses a run its caller stopped before a run directory existed, naming where
   * it was stopped. Nothing of the run was created and nothing of it ran, so the
   * refusal is thrown to the caller rather than reported as a run that happened —
   * exactly as an expired task time is, and for the same reason.
   */
  const refuseCancelled = (where: string): RunCancelledError =>
    new RunCancelledError(
      [
        `the run was stopped by its caller ${where}, before any run directory was allocated.`,
        'No run directory, no working copy, and no report were created: there is nothing to inspect and nothing to reuse, and no command and no coding turn was started.',
      ].join('\n'),
    );

  if (stopped()) {
    throw refuseCancelled('before the source repository was checked');
  }

  const source = await dependencies.preflight({
    repoPath: request.repoPath,
    workDir: request.workDir,
  });

  if (stopped()) {
    throw refuseCancelled('while the source repository was being checked');
  }

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
  // The selected launch, recorded once for the whole run: what the harness
  // starts, and nothing about the provider behind it. It is not rewritten per
  // turn, because the selection is fixed before the run begins and every turn
  // uses it (docs/spec.md §4).
  await dependencies.appendRunLog(
    timeline,
    `agent selected: runtime ${config.agent.runtime}, launch prefix ${JSON.stringify(config.agent.command)}`,
  );
  // A source-triggered run records what it took from its source before any
  // configured command executes: the normalized task snapshot in the run
  // directory, and one line of provenance in the timeline. A file-task run has
  // nothing here and writes neither (docs/architecture.md §5).
  if (request.sourceRef !== undefined) {
    const sourceRef = request.sourceRef;
    await writeSourceTaskSnapshot(run, task, sourceRef);
    await dependencies.appendRunLog(
      timeline,
      `source task: ${sourceRef.type} ${sourceRef.key} ${sourceRef.url} (immutable id ${sourceRef.id}, revision ${sourceRef.updatedAt})`,
    );
  }

  let workspace: PreparedWorkspace | null = null;
  let preparationProblem: string | null = null;
  const continued = request.continuedWorkspace;
  if (continued !== undefined) {
    // A continued attempt works in the workspace that already exists: the same
    // clone, on the same branch, from the same recorded base. Only the run
    // directory and its logs are this attempt's own.
    workspace = {
      ...run,
      workspaceId: continued.workspaceId,
      workspacePath: continued.workspacePath,
      branch: continued.branch,
      baseCommit: continued.baseCommit,
      sourceRoot: source.sourceRoot,
      continued: true,
      attempt: continued.attempt,
    };
    await dependencies.appendRunLog(
      timeline,
      `continuing workspace ${continued.workspaceId} (attempt ${String(continued.attempt)}) at ` +
        `${oneLine(continued.workspacePath)} on branch ${continued.branch} at ${continued.baseCommit}`,
    );
  } else {
    try {
      workspace = await dependencies.prepareWorkspace(run, source, {
        deadlineMs,
        now: dependencies.now,
        stop: callerStop,
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
  }
  if (workspace !== null && request.onWorkspaceReady !== undefined) {
    // The workspace exists, so the caller can record where the work lives before
    // anything paid happens in it. Deliberately outside the preparation catch: a
    // record that could not be written is not a preparation failure, and it is
    // thrown so its caller treats it as the failed write it is. The run
    // directory and the working copy are kept either way.
    await request.onWorkspaceReady(workspace);
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
    problem: parts.termination === 'unconfirmed' ? (parts.problem ?? NO_TERMINATION_REASON) : null,
  });

  /** The record of a stop by the caller, as the report keeps it. */
  const cancelled = (parts: {
    readonly phase: string;
    readonly termination?: TerminationOutcome;
    readonly problem?: string | null;
  }): CancellationEvidence => ({
    phase: parts.phase,
    elapsedMs: Math.max(0, dependencies.now().getTime() - start.getTime()),
    termination: parts.termination ?? 'confirmed',
    problem: parts.termination === 'unconfirmed' ? (parts.problem ?? NO_TERMINATION_REASON) : null,
  });

  /**
   * What the retained working copy differs from its recorded base by, read once
   * the run has stopped writing to it: everything every coding turn left behind,
   * whether it committed it, staged it, or only wrote the file (docs/spec.md §5).
   *
   * The comparison is made only when the run is in a state that can be summarized
   * as final. A stop the harness could not confirm leaves a working copy that
   * something may still be writing to, and a run that never had a working copy
   * has nothing to compare; both record why the summary is unavailable rather
   * than reporting a working copy that matches its base. A comparison that fails
   * is recorded the same way: the run is over either way, and a report must not
   * turn "could not be read" into "nothing changed".
   */
  const finalChanges = async (parts: {
    readonly timeout: TimeoutEvidence | null;
    readonly cancellation: CancellationEvidence | null;
    /**
     * Why the working copy cannot be read as a final record at all, when the run
     * already knows: a stop it could not confirm, recorded as a failure rather
     * than as a timeout or a cancellation. It is checked before anything else,
     * because such a copy may still be written to.
     */
    readonly changesProblem?: string | null;
  }): Promise<ChangeSummary> => {
    if (workspace === null) {
      return summarizeChanges({
        baseCommit: source.baseCommit,
        problem:
          'no working copy was prepared, so there was nothing to compare with the recorded base',
      });
    }

    if (parts.changesProblem !== undefined && parts.changesProblem !== null) {
      return summarizeChanges({
        baseCommit: workspace.baseCommit,
        problem: parts.changesProblem,
      });
    }

    const unconfirmed = parts.timeout ?? parts.cancellation;
    if (unconfirmed !== null && unconfirmed.termination !== 'confirmed') {
      return summarizeChanges({
        baseCommit: workspace.baseCommit,
        problem:
          'the run ended without confirming that everything it had started had stopped ' +
          `(${oneLine(unconfirmed.problem ?? NO_TERMINATION_REASON)}), so the working copy may still ` +
          'be written to and is not a final record of what this run left behind',
      });
    }

    try {
      return summarizeChanges({
        baseCommit: workspace.baseCommit,
        paths: await inspectWorkspaceChanges(workspace),
      });
    } catch (cause) {
      return summarizeChanges({
        baseCommit: workspace.baseCommit,
        problem: `the working copy could not be compared with its recorded base: ${oneLine(messageOf(cause))}`,
      });
    }
  };

  /**
   * What the run left in its working copy, as the timeline records it: the
   * complete list of differing paths, with the flagged ones marked where they
   * appear, and the two statements the report carries as well. The list is the
   * human-readable half of the summary; the report keeps the same list in full.
   */
  const changeLines = (changes: ChangeSummary): string[] => {
    const lines: string[] = [];
    if (!changes.inspected) {
      lines.push(`changes: unavailable, ${oneLine(changes.problem ?? NO_TERMINATION_REASON)}`);
    } else if (changes.paths.length === 0) {
      lines.push(`changes: the working copy matches the recorded base ${changes.baseCommit}`);
    } else {
      lines.push(
        `changes: ${count(changes.paths.length, 'path')} differ from the recorded base ${changes.baseCommit}`,
      );
      for (const entry of changes.paths) {
        lines.push(`changed path: ${describeChangedPath(entry)}`);
      }
    }
    lines.push(`review warning: ${changes.warnings.checks}`);
    if (changes.warnings.highlighted !== null) {
      lines.push(`review warning: ${changes.warnings.highlighted}`);
    }
    return lines;
  };

  /** Ends the run: the timeline records the status, then the report is written. */
  const endRun = async (parts: {
    readonly status: RunStatus;
    readonly reason: string;
    readonly baseline: CheckRoundResult | null;
    readonly attempts: readonly AttemptEvidence[];
    readonly timeout: TimeoutEvidence | null;
    readonly cancellation: CancellationEvidence | null;
    /**
     * Why the run's working copy cannot be summarized, for a run that ended for
     * something other than an expired limit or a stop by its caller; see
     * {@link finalChanges}. Left out, the working copy is read as usual.
     */
    readonly changesProblem?: string | null;
  }): Promise<RunTaskResult> => {
    // The run has stopped writing to its working copy, so this is the moment its
    // changes are read — before the status is recorded, so the timeline reads as
    // what the run left and then how it ended.
    const changes = await finalChanges(parts);
    for (const line of changeLines(changes)) {
      await dependencies.appendRunLog(timeline, line);
    }
    await dependencies.appendRunLog(
      timeline,
      `final status: ${parts.status}, ${oneLine(parts.reason)}`,
    );
    const reportPath = await dependencies.writeRunReport({
      run,
      task: { id: task.id, title: task.title },
      agent: config.agent,
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
      cancellation: parts.cancellation,
      changes,
      ...(request.sourceRef === undefined ? {} : { sourceRef: request.sourceRef }),
    });
    if (workspace !== null) {
      // The attempt is recorded against the workspace it happened in, so the next
      // attempt knows how many there have been and which tier comes next. The
      // report above stays the authority; this is derived state, and a failure to
      // record it is said out loud in the timeline rather than swallowed.
      try {
        await dependencies.recordWorkspaceAttempt(request.workDir, workspace.workspaceId, {
          runId: run.runId,
          outcome: parts.status,
          reason: parts.reason,
          ...(request.tierName === undefined ? {} : { tier: request.tierName }),
          endedAt: dependencies.now().toISOString(),
          reportPath,
        });
      } catch (cause) {
        await dependencies.appendRunLog(
          timeline,
          `workspace ledger: this attempt could not be recorded (${oneLine(messageOf(cause))})`,
        );
      }
    }
    return {
      run,
      workspace,
      status: parts.status,
      reason: parts.reason,
      baseline: parts.baseline,
      attempts: parts.attempts,
      repairsUsed: repairsSpent(parts.attempts),
      timeout: parts.timeout,
      cancellation: parts.cancellation,
      changes,
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
      cancellation: null,
    });
  };

  /**
   * Ends the run because its caller stopped it: the timeline records the stop,
   * then the run is finalized as `cancelled` from the evidence it already has.
   * Every stop leaves the loop here, so nothing is started after one, and the
   * status is never `passed`: the task was not decided, and a stopped run is not
   * a red check round either.
   */
  const endCancelled = async (parts: {
    readonly reason: string;
    readonly baseline: CheckRoundResult | null;
    readonly attempts: readonly AttemptEvidence[];
    readonly evidence: CancellationEvidence;
  }): Promise<RunTaskResult> => {
    const { evidence } = parts;
    await dependencies.appendRunLog(
      timeline,
      `cancelled: the run was stopped by its caller during ${evidence.phase}` +
        (evidence.termination === 'confirmed'
          ? ''
          : `; termination unconfirmed: ${evidence.problem ?? NO_TERMINATION_REASON}`),
    );
    return endRun({
      status: 'cancelled',
      reason: parts.reason,
      baseline: parts.baseline,
      attempts: parts.attempts,
      timeout: null,
      cancellation: evidence,
    });
  };

  /**
   * Ends the run for whichever stop it observed first. Every stop the run
   * observes goes through here, so a stop that is recognized later — by a phase
   * that was already finishing, or by a check the run makes on the way out —
   * cannot replace the reason the run ended for.
   */
  const endStopped = async (parts: {
    readonly cause: StopCause;
    readonly baseline: CheckRoundResult | null;
    readonly attempts: readonly AttemptEvidence[];
  }): Promise<RunTaskResult> => {
    const { cause } = parts;
    return cause.kind === 'timeout'
      ? endTimedOut({
          reason: cause.reason,
          baseline: parts.baseline,
          attempts: parts.attempts,
          evidence: cause.evidence,
        })
      : endCancelled({
          reason: cause.reason,
          baseline: parts.baseline,
          attempts: parts.attempts,
          evidence: cause.evidence,
        });
  };

  /** The run stopped by its caller, in the phase that was in progress. */
  const callerStopped = (
    phase: string,
    reason: string,
    unconfirmed?: {
      readonly termination: TerminationOutcome | null;
      readonly problem: string | null;
    },
  ): StopCause => ({
    kind: 'cancelled',
    reason,
    evidence: cancelled({
      phase,
      termination: unconfirmed?.termination ?? 'confirmed',
      problem: unconfirmed?.problem ?? null,
    }),
  });

  if (workspace === null) {
    if (stopped()) {
      // Preparation was stopped by the caller's request, not by Git: the report
      // keeps the preparation problem it has, and the cancellation says why the
      // run ended there. Nothing was checked and no turn was started.
      return endStopped({
        cause: callerStopped(
          'preparation of the working copy',
          'the run was stopped by its caller while the working copy was being prepared, so no check and no coding turn was started',
        ),
        baseline: null,
        attempts: [],
      });
    }
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
      cancellation: null,
    });
  }

  // Everything below works in the prepared working copy, and keeps it.
  const workspacePath = workspace.workspacePath;

  /**
   * One round of the configured plan in the working copy. Every invocation it
   * starts is bounded by the same deadline the run was given, and the round
   * reads what is left of the task time before each one. The run's own stop
   * request goes with it, so a round the caller stops — between two commands, or
   * during one — stops there rather than starting anything after it.
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
      stop: callerStop,
    });

  /**
   * What stopped a round, if anything did: an expired limit, or the run's own
   * stop request. Either reaches the runner as an execution error, so they are
   * recognized here, before that outcome can be read as an infrastructure
   * problem — and long before it could be mistaken for repair feedback.
   *
   * A round that completed is a result and never a stop: a check round that got
   * as far as running every configured check is evidence the run keeps, even if a
   * limit expires the moment after it returns.
   */
  const roundStop = (round: CheckRoundResult, phase: string): StopCause | null => {
    if (round.outcome !== 'execution-error') {
      return null;
    }
    const results = [...round.setup, ...round.checks];

    const stoppedCommand = results.find((result) => result.outcome === 'stopped');
    if (stoppedCommand !== undefined) {
      // The command was stopped because the run was, through the same stop path
      // its own limit uses. Whether that stop was confirmed is the command's own
      // record, and an unconfirmed one is carried into the run's report.
      const evidence = cancelled({
        phase,
        termination: stoppedCommand.termination ?? 'unconfirmed',
        problem: stoppedCommand.terminationProblem,
      });
      return { kind: 'cancelled', reason: describeRoundCancelled(evidence), evidence };
    }

    const stoppedAtLimit = results.find((result) => result.outcome === 'timed-out');
    if (stoppedAtLimit !== undefined) {
      // A command that ran under less than its configured limit was bounded by
      // the task time that was left: that is the limit which expired.
      const termination = stoppedAtLimit.termination ?? 'unconfirmed';
      const evidence = timedOut({
        limit: stoppedAtLimit.timeoutMs < commandLimitMs ? 'task' : 'command',
        phase,
        limitMs: stoppedAtLimit.timeoutMs,
        termination,
        problem: stoppedAtLimit.terminationProblem,
      });
      return { kind: 'timeout', reason: describeRoundTimeout(phase, evidence), evidence };
    }

    if (stopped()) {
      // Nothing ran to a stop: the round was stopped between two commands, and
      // the command it was about to start was never started. Nothing of the run's
      // own is left running either, so this stop is confirmed.
      const evidence = cancelled({ phase });
      return { kind: 'cancelled', reason: describeRoundCancelled(evidence), evidence };
    }

    if (remainingMs() <= 0) {
      // The round spent the run's time before it could start the command it was
      // about to start, and stopped there rather than starting it late.
      const evidence = timedOut({ limit: 'task', phase, limitMs: taskLimitMs });
      return { kind: 'timeout', reason: describeRoundTimeout(phase, evidence), evidence };
    }

    return null;
  };

  // The baseline: the configured plan, run in the working copy before any coding
  // turn. Only a completed green round lets the run continue.
  if (stopped()) {
    return endStopped({
      cause: callerStopped(
        'the baseline checks',
        'the run was stopped by its caller before the baseline checks started, so neither they nor any coding turn was started',
      ),
      baseline: null,
      attempts: [],
    });
  }
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
    return endStopped({ cause: baselineStop, baseline, attempts: [] });
  }

  if (baseline.outcome === 'execution-error') {
    return endRun({
      status: 'failed',
      reason: `the baseline could not be executed: ${oneLine(baseline.problem ?? 'no explanation was recorded')}`,
      baseline,
      attempts: [],
      timeout: null,
      cancellation: null,
    });
  }
  if (baseline.outcome === 'failed') {
    if (workspace?.continued !== true) {
      return endRun({
        status: 'failed',
        reason: 'the baseline checks did not pass, so no coding turn was started',
        baseline,
        attempts: [],
        timeout: null,
        cancellation: null,
      });
    }
    // A continuation of failed work starts red by definition. Refusing to start
    // would make continuation useless; what decides the attempt is still the
    // round after its coding turns. Recorded, so nobody reads the red baseline as
    // an ordinary failed attempt (docs/implement-workspace-continuation.md).
    await dependencies.appendRunLog(
      timeline,
      'baseline: red, and this attempt continues a workspace that was already red, so it proceeds',
    );
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
    // What the caller asked for is read before every coding turn, and so is the
    // task deadline: a turn is started only while the run is still wanted and has
    // the time to run it and to check the result.
    if (stopped()) {
      return endStopped({
        cause: callerStopped(
          nameTurn(kind, turn),
          `the run was stopped by its caller before ${describeTurn(kind, turn)} was started, so no further turn and no check was run`,
        ),
        baseline,
        attempts,
      });
    }
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
    const stop = phaseStop(left, callerStop);
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
        ...(request.guidance === undefined ? {} : { guidance: request.guidance }),
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

    // What the turn reported about the stop of its own runtime, when it made
    // one: nothing at all for a turn that stopped nothing, and for a turn that
    // stopped something, whether that stop was confirmed. A stop it could not
    // confirm is a limitation the run carries, not a detail to round down.
    const shutdown = completed?.shutdown ?? null;
    const shutdownProblem = unconfirmedShutdownProblem(shutdown);

    // Why the turn's stop request was set off, if it was: the first of the run's
    // deadline and the caller's stop to reach it. A turn that returned late — an
    // agent that answered after it was asked to stop — is read here, and what it
    // reported cannot replace the stop the run already observed.
    const endedBy = stop.kind();
    if (endedBy !== null) {
      // What the turn reported is not a check result and nothing follows it: no
      // round runs, no repair is spent, and a turn that failed at the same moment
      // does not replace the reason the run actually stopped for.
      attempts.push({
        turn,
        kind,
        agentLog: agentLog.path,
        agentSummary: completed?.summary ?? null,
        checks: null,
      });
      const phase = nameTurn(kind, turn);
      // How the turn stopped the runtime it owned is the turn's own record, and
      // it goes into the run's timeout or cancellation evidence as it stands. A
      // turn that was stopped without saying anything about that stop reports
      // nothing, and there is then nothing to record beyond the stop itself.
      const reported = shutdown === null ? undefined : shutdown;
      return endStopped({
        cause:
          endedBy === 'timeout'
            ? {
                kind: 'timeout',
                reason:
                  `${describeTurn(kind, turn)} was stopped when the run's remaining task time ran out, so no check was run after it and no further turn was started` +
                  shutdownNote(shutdownProblem),
                evidence: timedOut({
                  limit: 'task',
                  phase,
                  limitMs: taskLimitMs,
                  termination: reported?.termination,
                  problem: reported?.problem,
                }),
              }
            : callerStopped(
                phase,
                `${describeTurn(kind, turn)} was stopped because the run was stopped by its caller, so no check was run after it and no further turn was started` +
                  shutdownNote(shutdownProblem),
                reported,
              ),
        baseline,
        attempts,
      });
    }

    // The turn has returned and its stop request is released: this is the point
    // where the working copy stops being something else's to write to, and it is
    // where the run makes sure it is. A stop that arrived while the turn was
    // returning is still a stop, and nothing runs after it — not even the turn's
    // own failure, which is read below, because the run ended for what the caller
    // asked for rather than for what the turn did on its way out.
    if (stopped()) {
      attempts.push({
        turn,
        kind,
        agentLog: agentLog.path,
        agentSummary: completed?.summary ?? null,
        checks: null,
      });
      return endStopped({
        cause: callerStopped(
          nameTurn(kind, turn),
          `${describeTurn(kind, turn)} returned, and the run was stopped by its caller before any check could run after it, so no check and no further turn was started` +
            shutdownNote(shutdownProblem),
          shutdown === null ? undefined : shutdown,
        ),
        baseline,
        attempts,
      });
    }

    if (shutdownProblem !== null) {
      // The turn returned, and it reported that it stopped something without
      // seeing it end. Nothing reads the working copy after that: a check round
      // would be reading a copy something may still be writing to, and no later
      // turn may reuse it. The run ends here, as a failure — nothing about it
      // was decided by a check, and an unconfirmed stop is not a clean one — and
      // what it leaves is kept without being summarized as a final record.
      attempts.push({
        turn,
        kind,
        agentLog: agentLog.path,
        agentSummary: completed?.summary ?? null,
        checks: null,
      });
      return endRun({
        status: 'failed',
        reason:
          `${describeTurn(kind, turn)} stopped the coding runtime it started and could not confirm that it had ended ` +
          `(${oneLine(shutdownProblem)}), so no check was run on a working copy that may still be written to`,
        baseline,
        attempts,
        timeout: null,
        cancellation: null,
        changesProblem:
          `the run ended without confirming that everything the coding runtime of ${describeTurn(kind, turn)} ` +
          `had started had stopped (${oneLine(shutdownProblem)}), so the working copy may still be written to ` +
          'and is not a final record of what this run left behind',
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
        cancellation: null,
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
    const observedStop = roundStop(observed, phase);
    if (observedStop !== null) {
      return endStopped({ cause: observedStop, baseline, attempts });
    }

    if (observed.outcome === 'passed') {
      return endRun({
        status: 'passed',
        reason: describePassed(kind, turn, repairsSpent(attempts), config.maxRepairs),
        baseline,
        attempts,
        timeout: null,
        cancellation: null,
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
        cancellation: null,
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
        cancellation: null,
      });
    }

    turn += 1;
    kind = 'repair';
    repair = { repairedTurn: turn - 1, failures: await failedCommands(observed) };
  }
}
