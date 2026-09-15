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
 *
 * `timed-out` and `stopped` are the harness's own doing: the invocation was
 * still running when its limit expired, or when the run was stopped by its
 * caller, and the harness stopped it. Both are execution failures — never a
 * failed check to repair — and neither says anything about whether the command
 * would have passed given more time. They stay apart because a reader of the
 * report has to be able to tell a limit that expired from a run that was
 * stopped, and an exit code the harness cut short means nothing either way.
 */
export type CommandOutcome = 'exited' | 'signalled' | 'timed-out' | 'stopped' | 'failed-to-launch';

/**
 * Whether the harness established that a process tree it stopped really ended.
 *
 * `confirmed` means the stop was requested successfully *and* nothing of the
 * stopped invocation was left running. Anything else — the host has no usable
 * way to stop it, or it did not end in time — is `unconfirmed`, which is a
 * limitation a report must state rather than round down: a working copy that may
 * still be written to must not be declared safe to reuse (docs/spec.md §3).
 */
export type TerminationOutcome = 'confirmed' | 'unconfirmed';

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
  /**
   * The limit this invocation ran under, in milliseconds: the smaller of its
   * configured command limit and the task time that was left when it started
   * (docs/spec.md §3). The remaining task time always wins, so this is the
   * limit that expired for an invocation that ended as `timed-out`.
   */
  readonly timeoutMs: number;
  /**
   * How the process tree this invocation started was stopped when its limit
   * expired or when the run was stopped; `null` when the harness stopped
   * nothing, because the invocation had ended by itself. A stop this harness
   * cannot confirm is recorded as `unconfirmed` together with
   * {@link CommandResult.terminationProblem}.
   */
  readonly termination: TerminationOutcome | null;
  /** What could not be confirmed about the stop; `null` when it was confirmed. */
  readonly terminationProblem: string | null;
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
 * result at all. An expired limit is one of those ways to stop: a command that
 * was stopped for running too long is an execution error, never a red round.
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
 * One command a completed red round observed not to succeed, as a repair turn is
 * told about it: the invocation the harness recorded, and the output it wrote.
 */
export interface FailedCommand {
  /** The invocation: its configured arguments, its exit code, and its two logs. */
  readonly result: CommandResult;
  /**
   * What the command wrote, as far as it was recorded: a bounded excerpt of its
   * two log files, or `'(no output was written)'` when it wrote nothing. The log
   * files stay where they are — the excerpt is what a repair turn is given, not a
   * replacement for the evidence.
   */
  readonly output: string;
}

/**
 * What a repair turn is told about the round it repairs: the commands the harness
 * observed to fail, the output they wrote, and where that output lives, alongside
 * the task context every turn receives.
 *
 * Only a completed red round becomes feedback. A round that could not be executed
 * is an infrastructure failure, so no repair turn is given it (docs/spec.md §2).
 */
export interface RepairFeedback {
  /** The top-level coding turn whose post-agent round was red: the one repaired. */
  readonly repairedTurn: number;
  /** The checks that did not exit `0`, in the order the round ran them. */
  readonly failures: readonly FailedCommand[];
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

/** Which limit expired for a run: its total task time, or one command's own. */
export type TimeoutLimit = 'task' | 'command';

/**
 * What a run that stopped because time ran out has to say about it: which limit
 * expired, where in the run it expired, and whether the harness was able to
 * confirm that the execution it stopped really ended.
 *
 * A timeout is a `failed` run, never a red check round, and this is the record
 * of it — the run's report keeps exactly one, so a reader is never left to infer
 * from a bare "timed out" which limit was involved or whether anything of the
 * run's own work is still running (docs/spec.md §3).
 */
export interface TimeoutEvidence {
  /** Whether the run's total task time or one command's limit expired. */
  readonly limit: TimeoutLimit;
  /** The part of the run that was in progress, in a few words. */
  readonly phase: string;
  /** The limit that expired, in milliseconds. */
  readonly limitMs: number;
  /** How much of the run's total task time had been used, in milliseconds. */
  readonly elapsedMs: number;
  /**
   * Whether owned execution was confirmed to have stopped. `confirmed` when
   * nothing was left to stop, or when the harness stopped it and saw it end.
   */
  readonly termination: TerminationOutcome;
  /**
   * What could not be confirmed, when {@link TimeoutEvidence.termination} is
   * `unconfirmed`; `null` when termination was confirmed.
   */
  readonly problem: string | null;
}

/**
 * What a run that its caller stopped has to say about it: where it was stopped,
 * and whether the harness was able to confirm that the execution it stopped
 * really ended.
 *
 * A stopped run is a `cancelled` run, which is a status of its own and not a
 * timeout: no limit expired, and a report must not read as if one had. Like a
 * timeout, it keeps exactly one of these, and an unconfirmed stop is stated
 * rather than rounded down — a working copy that may still be written to must
 * not be declared safe to reuse.
 */
export interface CancellationEvidence {
  /** The part of the run that was in progress, in a few words. */
  readonly phase: string;
  /** How much of the run's total task time had been used, in milliseconds. */
  readonly elapsedMs: number;
  /**
   * Whether owned execution was confirmed to have stopped. `confirmed` when
   * nothing was left to stop, or when the harness stopped it and saw it end.
   */
  readonly termination: TerminationOutcome;
  /**
   * What could not be confirmed, when {@link CancellationEvidence.termination}
   * is `unconfirmed`; `null` when termination was confirmed.
   */
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
  /**
   * Why the run's time ran out; `null` for a run that ended for another reason.
   * Present exactly when the run stopped because a limit expired.
   */
  readonly timeout: TimeoutEvidence | null;
  /**
   * What stopped a run its caller cancelled, and whether that stop could be
   * confirmed; `null` for a run that ended for another reason. Present exactly
   * when the run stopped because it was cancelled.
   */
  readonly cancellation: CancellationEvidence | null;
  /** The run's compact lifecycle timeline: `<runDir>/logs/run.log`. */
  readonly runLog: string;
}
