/**
 * Data contracts shared by the harness.
 *
 * This module is deliberately declaration-only: it has no imports and no
 * runtime behaviour, so any other module can depend on it without creating a
 * cycle or dragging in I/O. Keep it that way (see docs/architecture.md §2).
 */

/**
 * A command as an executable plus literal arguments, for example
 * `['npm', 'ci']`. Nothing is interpolated or shell-expanded.
 */
export type Command = readonly string[];

/** Validated contents of a harness configuration file. */
export interface HarnessConfig {
  /** Output directory for run directories, resolved relative to the config file. */
  readonly workDir: string;
  /** Additional coding turns allowed after the initial implementation. */
  readonly maxRepairs: number;
  /** Total run time limit, in minutes. */
  readonly taskTimeoutMinutes: number;
  /** Per setup/check command limit, in minutes; capped by remaining task time. */
  readonly commandTimeoutMinutes: number;
  /** Commands run before the baseline and before each post-agent check round. */
  readonly setup: readonly Command[];
  /** Commands that decide the run status. Never empty. */
  readonly checks: readonly Command[];
}

/**
 * How one configured command ended. Only `exited` with exit code `0` is a
 * success: a command that could not be started is never reported as an exit,
 * and a signalled command is an execution failure, not repair feedback.
 */
export type CommandOutcome = 'exited' | 'signalled' | 'failed-to-launch';

/** What one configured command invocation did, and where its output went. */
export interface CommandResult {
  /** The configured command, unchanged: executable plus literal arguments. */
  readonly command: Command;
  /** Working directory the command ran in: the task's working copy. */
  readonly cwd: string;
  /** Start of the invocation, as an ISO timestamp. */
  readonly startedAt: string;
  /** End of the invocation, as an ISO timestamp. */
  readonly endedAt: string;
  /** How the invocation ended; see {@link CommandOutcome}. */
  readonly outcome: CommandOutcome;
  /** Exit code of a command that ran and exited; `null` otherwise. */
  readonly exitCode: number | null;
  /** Terminating signal of a command that was killed; `null` otherwise. */
  readonly signal: string | null;
  /** Why the command could not be started; `null` when it did run. */
  readonly launchError: string | null;
  /** Log file holding this invocation's standard output. */
  readonly stdoutPath: string;
  /** Log file holding this invocation's standard error. */
  readonly stderrPath: string;
}

/**
 * How one setup/check round ended.
 *
 * `passed` and `failed` are completed rounds: every configured check was
 * attempted, and each has a result. `failed` means at least one of them exited
 * nonzero, which is an ordinary red round: repair feedback. `execution-error`
 * is an incomplete round — a setup command failed, or a command could not be
 * executed — so the round stopped early and the commands after it have no
 * result at all.
 */
export type RoundOutcome = 'passed' | 'failed' | 'execution-error';

/** What one setup/check round did, and how it ended. */
export interface CheckRoundResult {
  /** How the round ended; see {@link RoundOutcome}. */
  readonly outcome: RoundOutcome;
  /** Setup invocations that ran, in configured order. Empty for an empty setup list. */
  readonly setup: readonly CommandResult[];
  /**
   * Check invocations that ran, in configured order. A completed round holds one
   * result per configured check; a round that stopped early holds only the ones
   * that ran. A check that never ran is absent, never a successful result.
   */
  readonly checks: readonly CommandResult[];
  /**
   * Why the round stopped before running every configured check, or `null` for a
   * completed round. A red round is completed: its failed checks are results,
   * not a problem to explain.
   */
  readonly problem: string | null;
}

/** Validated contents of a task file. */
export interface Task {
  /** Label used in reports and logs. Never a path and never a shell argument. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Nonempty list of nonblank statements guiding implementation and review. */
  readonly acceptanceCriteria: readonly string[];
}

/** How a run ended. These three are the only final statuses (docs/spec.md §3). */
export type RunStatus = 'passed' | 'failed' | 'cancelled';

/**
 * Which top-level coding turn an attempt was: the initial implementation, or one
 * of the repair turns that follow it. Internal tool calls and runtime events are
 * not turns.
 */
export type AttemptKind = 'implementation' | 'repair';

/**
 * What one top-level coding turn left behind: the agent's own account of it, and
 * the checks the harness observed for itself afterwards.
 *
 * The two stay separate on purpose. `agentSummary` is agent text: it is kept for
 * review and never decides the run status, because a claim that the work is done
 * is not a check result. `checks` is the observed evidence, or `null` when no
 * round ran after that turn — the turn failed, the run was stopped, or the
 * allowance had already run out.
 */
export interface AttemptEvidence {
  /** 1 for the implementation turn; the repair turns follow as 2, 3, … */
  readonly turn: number;
  /** Whether this turn was the implementation or a repair. */
  readonly kind: AttemptKind;
  /**
   * File holding this turn's useful agent output. A reference: a report never
   * copies the transcript into itself.
   */
  readonly agentLog: string;
  /** The agent's own summary of the turn, or `null` when it gave none. */
  readonly agentSummary: string | null;
  /** The setup/check round observed after this turn; `null` when none ran. */
  readonly checks: CheckRoundResult | null;
}

/**
 * The working copy a run used, as a report records it. A run directory can exist
 * without this being a working copy: preparation can fail after the directory was
 * created, and the report then says so instead of describing a clone that was
 * never made.
 */
export interface WorkspaceReport {
  /** `<runDir>/workspace`: where the working copy is, or would have been. */
  readonly path: string;
  /** True only for a working copy that was really prepared and verified. */
  readonly prepared: boolean;
  /** The run's dedicated branch; `null` when no working copy was prepared. */
  readonly branch: string | null;
  /** Why there is no usable working copy; `null` when there is one. */
  readonly problem: string | null;
}

/** The final report of one run: the contents of `<runDir>/result.json`. */
export interface RunReport {
  /** Generated run ID: the run's name in logs, reports, and its branch. */
  readonly runId: string;
  /** The task the run was asked to complete, as a label. */
  readonly task: { readonly id: string; readonly title: string };
  /** The repository the run started from, and the committed base it recorded. */
  readonly source: { readonly path: string; readonly baseCommit: string };
  /** The working copy of this run; see {@link WorkspaceReport}. */
  readonly workspace: WorkspaceReport;
  /** Start of the run, as an ISO timestamp. */
  readonly startedAt: string;
  /** End of the run, as an ISO timestamp. */
  readonly endedAt: string;
  /** How the run ended; see {@link RunStatus}. */
  readonly status: RunStatus;
  /** Why it ended that way, in one sentence a reader can act on. */
  readonly reason: string;
  /**
   * Additional top-level coding turns the run spent, counted from `attempts`.
   * Never a number the caller supplies alongside the evidence it contradicts.
   */
  readonly repairsUsed: number;
  /** Check evidence from before any coding turn; `null` when none was observed. */
  readonly baseline: CheckRoundResult | null;
  /** One entry per top-level coding turn, oldest first. */
  readonly attempts: readonly AttemptEvidence[];
  /** The run's compact lifecycle timeline: `<runDir>/logs/run.log`. */
  readonly runLog: string;
}
