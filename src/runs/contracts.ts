/**
 * What one run is asked to do, what it left behind, and the ordinary functions
 * it is handed: the whole boundary between a caller and the loop.
 *
 * Every collaborator is a function of the module that owns it, so a real caller
 * composes them directly and a test substitutes the one collaborator it is
 * about. There is no default and no fake in these types.
 */
import type { CheckRoundRequest } from '../checks/round.js';
import type { AgentLog } from '../reporting/logs.js';
import type { RunReportRequest } from '../reporting/report.js';
import type {
  AttemptEvidence,
  AttemptKind,
  CancellationEvidence,
  ChangeSummary,
  CheckRoundResult,
  HarnessConfig,
  RepairFeedback,
  RunStatus,
  SourceRef,
  Task,
  TerminationOutcome,
  TimeoutEvidence,
} from '../shared/types.js';
import type { PreparedWorkspace, PrepareWorkspaceBounds } from '../workspace/prepare.js';
import type { PreflightRequest, SourcePreflight } from '../workspace/preflight.js';
import type { ContinuedWorkspace } from '../workspace/reopen.js';
import type { RunDirectory } from '../workspace/run-directory.js';
import type { WorkspaceAttempt, WorkspaceSourceItem } from '../workspace/state.js';

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
   * verified by the caller (`reopenWorkspace`, `src/workspace/reopen.ts`). A continued
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
 * functions its caller handed it. `runAgentTurn` is `src/agents/codex/adapter.ts`, which runs
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
   * by the run's remaining task time and by the run's own stop request. The
   * external item the workspace is created for travels with it into the ledger,
   * so a later continuation can check that the pointer label names this item.
   */
  readonly prepareWorkspace: (
    run: RunDirectory,
    source: SourcePreflight,
    bounds: PrepareWorkspaceBounds,
    sourceItem?: WorkspaceSourceItem,
  ) => Promise<PreparedWorkspace>;
  /**
   * Writes the working copy's repository-local commit identity
   * (`WORKSPACE_IDENTITY`, `src/workspace/git.ts`) before anything runs in it, so
   * the coding turns that follow can make small local commits without an ambient
   * Git identity. It touches that clone's own `.git/config` and never the
   * machine's global or system configuration. A failure is a
   * {@link WorkspaceError}-style rejection the runner reports as the failed run
   * it is, rather than proceeding with an unknown identity.
   */
  readonly configureWorkspaceIdentity: (workspacePath: string) => Promise<void>;
  /** Runs one setup/check round in the working copy. */
  readonly runCheckRound: (request: CheckRoundRequest) => Promise<CheckRoundResult>;
  /**
   * Runs one top-level coding turn and awaits its completion. The production
   * one is `runCodexTurn` from `src/agents/codex/adapter.ts`; it is the only collaborator that
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
   * workspace's ledger (`src/workspace/state.ts`). It is derived state: a run's own
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
