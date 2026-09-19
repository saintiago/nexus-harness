/**
 * How a run ends: the stop evidence its report keeps, the final change summary,
 * and the report itself.
 *
 * The first stop a run observes is the one it keeps, so every ending goes
 * through this one place: an expired limit and a stop by the caller are
 * different records and are never rounded into each other, and a stop the
 * harness could not confirm is stated rather than assumed. Everything here works
 * on a run that already has its run directory and its working copy; a run that
 * never allocated one is refused by the loop instead.
 */
import { summarizeChanges } from '../reporting/changes.js';
import { messageOf } from '../shared/errors.js';
import type {
  AttemptEvidence,
  CancellationEvidence,
  ChangeSummary,
  CheckRoundResult,
  HarnessConfig,
  RunStatus,
  Task,
  TerminationOutcome,
  TimeoutEvidence,
  TimeoutLimit,
} from '../shared/types.js';
import { inspectWorkspaceChanges } from '../workspace/changes.js';
import type { PreparedWorkspace } from '../workspace/prepare.js';
import type { SourcePreflight } from '../workspace/preflight.js';
import type { RunDirectory } from '../workspace/run-directory.js';
import type { RunTaskRequest, RunTaskResult, RunnerDependencies } from './contracts.js';
import {
  count,
  describeChangedPath,
  describeRoundCancelled,
  describeRoundTimeout,
  describeTimeoutLimit,
  NO_TERMINATION_REASON,
  oneLine,
  repairsSpent,
} from './progress.js';
import type { StopCause } from './stops.js';

/** Everything one run's ending needs, as the loop already knows it. */
export interface RunFinalizerContext {
  readonly request: RunTaskRequest;
  readonly dependencies: RunnerDependencies;
  readonly timeline: string;
  readonly run: RunDirectory;
  readonly task: Task;
  readonly config: HarnessConfig;
  readonly source: SourcePreflight;
  readonly workspace: PreparedWorkspace | null;
  readonly preparationProblem: string | null;
  readonly startedAt: string;
  readonly start: Date;
  readonly deadlineMs: number;
}

/**
 * Builds the endings of one run: the evidence factories, the final change
 * summary, and the one place a report is written. The loop calls these as it
 * ends; they never start anything.
 */
export function createRunFinalizer(context: RunFinalizerContext) {
  const {
    request,
    dependencies,
    timeline,
    run,
    task,
    config,
    source,
    workspace,
    preparationProblem,
    startedAt,
    start,
    deadlineMs,
  } = context;
  const callerStop = request.stop;
  const taskLimitMs = config.taskTimeoutMinutes * 60_000;
  const commandLimitMs = config.commandTimeoutMinutes * 60_000;
  const remainingMs = (): number => deadlineMs - dependencies.now().getTime();
  const stopped = (): boolean => callerStop?.aborted === true;

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

  return {
    timedOut,
    cancelled,
    endRun,
    endTimedOut,
    endCancelled,
    endStopped,
    callerStopped,
    roundStop,
  };
}
