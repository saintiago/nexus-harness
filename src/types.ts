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
