/**
 * The task loop: the order the work happens in, and nothing else.
 *
 * `runTask` is an ordinary async function that takes one loaded task and one
 * loaded configuration through the bounded loop:
 *
 * ```text
 * prepare -> baseline -> [recorded branch] implementation turn
 *                              |               ^              |
 *                              |               |              v
 *                              |               |     [recorded branch] checks
 *                              |               |              |
 *                              |               +--- repair <--+
 *                              +-> rejected state ends the run
 *                                 (while maxRepairs allows, and only for a
 *                                  completed red round)
 * ```
 *
 * The task and the command plan come from the caller and stay in memory: the
 * runner never re-reads them, so nothing the working copy, the coding turn, or
 * the target project writes can change which commands decide the run. A red
 * baseline stops the run before any coding turn; a completed red round is repair
 * feedback, and a round that could not be executed, and a turn that failed, are
 * terminal. Every attempt, and with it the agent's own summary of it, is kept in
 * the result; the agent's account of a turn is never what decides the status.
 *
 * Before every coding turn, and before the check round that judges it, the
 * checkout is returned to the branch its workspace records: a clean checkout on
 * a branch of its own whose commit descends from that branch is fast-forwarded
 * and checked out, and a dirty, detached, divergent, or branchless one ends the
 * run before the turn or the check instead (HARN-35).
 *
 * One deadline, established before preparation and never recomputed, is spent by
 * every phase. A run its caller stops ends as `cancelled` with the evidence it
 * already has. How a run ends is finalize.ts's; what every turn and round is
 * told, and what its outcome means for the loop, is here.
 *
 * The coding turn arrives as a function the caller composed (see
 * {@link RunnerDependencies}); the runner knows nothing about a vendor, an
 * executable, or a flag.
 */
import { runLogPath } from '../reporting/logs.js';
import { runReportPath, writeSourceTaskSnapshot } from '../reporting/report.js';
import type { HistorySnapshot } from '../history/contract.js';
import { messageOf } from '../shared/errors.js';
import type {
  AttemptEvidence,
  AttemptKind,
  CheckRoundResult,
  RepairFeedback,
} from '../shared/types.js';
import type { PreparedWorkspace } from '../workspace/prepare.js';
import type { WorkspaceStepStop } from '../workspace/errors.js';
import { workspaceStopOf } from '../workspace/errors.js';
import type { SourcePreflight } from '../workspace/preflight.js';
import type { WorkspacePlacement } from '../workspace/run-directory.js';
import { WORKSPACE_IDENTITY } from '../workspace/git.js';
import { sourceItemFor } from '../workspace/state.js';
import type {
  AgentTurnResult,
  RunTaskRequest,
  RunTaskResult,
  RunnerDependencies,
} from './contracts.js';
import { RunCancelledError, RunTimeoutError } from './contracts.js';
import { failedCommands } from './feedback.js';
import { createRunFinalizer } from './finalize.js';
import {
  describeFailedChecks,
  describePassed,
  describePlan,
  describeRound,
  describeTurn,
  nameTurn,
  oneLine,
  repairsSpent,
  shutdownNote,
  unconfirmedShutdownProblem,
} from './progress.js';
import { phaseStop } from './stops.js';

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
   * exactly as an expired task time is, and for the same reason. What stopped the
   * last check the run made is named when there is something to name: a Git
   * reading that was stopped there says so, with whether its stop was confirmed,
   * even though the run itself left nothing behind to report it in.
   */
  const refuseCancelled = (where: string, detail?: string, cause?: unknown): RunCancelledError =>
    new RunCancelledError(
      [
        `the run was stopped by its caller ${where}, before any run directory was allocated.`,
        ...(detail === undefined ? [] : [`What was running when it arrived: ${detail}`]),
        'No run directory, no working copy, and no report were created: there is nothing to inspect and nothing to reuse, and no command and no coding turn was started.',
      ].join('\n'),
      { cause },
    );

  if (stopped()) {
    throw refuseCancelled('before the source repository was checked');
  }

  /**
   * The source check's Git readings are bounded like everything else the run
   * spends its time on: each reading runs under what is left of the run's task
   * time when it starts, and the run's stop request stops one that is running. A
   * check stopped there is reported as the stop it is — a cancellation, or the
   * deadline — rather than as a refusal of the source it never finished reading.
   */
  let source: SourcePreflight;
  try {
    source = await dependencies.preflight({
      repoPath: request.repoPath,
      workDir: request.workDir,
      bounds: {
        deadlineMs,
        now: dependencies.now,
        ...(callerStop === undefined ? {} : { stop: callerStop }),
      },
    });
  } catch (cause) {
    const gitStop = workspaceStopOf(cause);
    if (gitStop?.kind === 'cancelled' || (gitStop?.kind === undefined && stopped())) {
      throw refuseCancelled(
        'while the source repository was being checked',
        workspaceStopOf(cause) === null ? undefined : oneLine(messageOf(cause)),
        cause,
      );
    }
    if (workspaceStopOf(cause) !== null) {
      // The reading was stopped at the limit it was given, which was the task
      // time that was left: that is the limit that expired, and nothing of the
      // run exists yet to report it in.
      throw new RunTimeoutError(
        [
          `the run's task time limit of ${String(taskLimitMs)} ms expired while the source repository was being checked, before any run directory was allocated.`,
          `The check was stopped there: ${oneLine(messageOf(cause))}`,
          'No run directory, no working copy, and no report were created: there is nothing to inspect and nothing to reuse, and no command and no coding turn was started.',
          `Run the task again with more than ${String(config.taskTimeoutMinutes)} minutes of task time available.`,
        ].join('\n'),
        { cause },
      );
    }
    throw cause;
  }

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

  // The workspace this attempt works in: the one it continues, when its caller
  // resolved one, or a new one named the way its source preferred it — the
  // canonical key of the item, for example `HARN-23` — so retained Jira work is
  // recognizable as the ticket it belongs to. A run whose caller has no
  // preference keeps the generated name it always had
  // (docs/implement-workspace-continuation.md).
  const placement: WorkspacePlacement =
    request.continuedWorkspace === undefined
      ? {
          kind: 'create',
          ...(request.preferredWorkspaceId === undefined
            ? {}
            : { preferredWorkspaceId: request.preferredWorkspaceId }),
        }
      : { kind: 'reopen', workspaceId: request.continuedWorkspace.workspaceId };
  const run = await dependencies.allocateRunDirectory(request.workDir, placement);
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
  /**
   * The stop preparation recorded, when it was a Git step the harness stopped:
   * the run's cancellation or its timeout then carries whether that stop was
   * confirmed, so an unconfirmed one stops automatic intake and reuse instead of
   * being rounded down to a clean end.
   */
  let preparationStop: WorkspaceStepStop | null = null;
  const continued = request.continuedWorkspace;
  if (continued !== undefined) {
    // A continued attempt works in the workspace that already exists: the same
    // clone, on the same branch, from the same recorded base. Only the run
    // directory and its logs are this attempt's own — and allocation created
    // none for the workspace, so a continuation adds no directory beside the
    // clone it reopens.
    workspace = {
      ...run,
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
      workspace = await dependencies.prepareWorkspace(
        run,
        source,
        {
          deadlineMs,
          now: dependencies.now,
          stop: callerStop,
        },
        // The item this workspace is created for, when the run came from a
        // source: what a later pointer label is checked against, so the clone is
        // never continued as another item's work.
        request.sourceRef === undefined ? undefined : sourceItemFor(request.sourceRef),
      );
      await dependencies.appendRunLog(
        timeline,
        `workspace prepared at ${oneLine(workspace.workspacePath)} on branch ${workspace.branch} at ${source.baseCommit}`,
      );
    } catch (cause) {
      // Preparation can fail after the run directory exists. The run is over, but
      // what was created is kept, and the report records the facts it has instead
      // of describing a working copy that was never made.
      preparationProblem = messageOf(cause);
      preparationStop = workspaceStopOf(cause);
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

  /**
   * The source provenance the report carries. A fresh run's base is the commit
   * preflight recorded; a continued workspace keeps the base its own ledger
   * recorded, so a source checkout that advanced since then never replaces the
   * comparison base the retained work is measured against.
   */
  const reportSource =
    workspace !== null && workspace.continued
      ? { ...source, baseCommit: workspace.baseCommit }
      : source;

  /**
   * How this run ends: the evidence factories, the final change summary, and the
   * report. The loop decides when a run ends; the finalizer decides what that
   * ending records, so every ending goes through one place.
   */
  const finalizer = createRunFinalizer({
    request,
    dependencies,
    timeline,
    run,
    task,
    config,
    source: reportSource,
    workspace,
    preparationProblem,
    startedAt,
    start,
    deadlineMs,
  });
  const { endRun, endTimedOut, endStopped, callerStopped, timedOut, roundStop } = finalizer;

  if (workspace === null) {
    if (
      preparationStop?.kind === 'cancelled' ||
      (preparationStop?.kind === undefined && stopped())
    ) {
      // Preparation was stopped by the caller's request, not by Git: the report
      // keeps the preparation problem it has, and the cancellation says why the
      // run ended there. Nothing was checked and no turn was started.
      return endStopped({
        cause: callerStopped(
          'preparation of the working copy',
          'the run was stopped by its caller while the working copy was being prepared, so no check and no coding turn was started',
          preparationStop ?? undefined,
        ),
        baseline: null,
        attempts: [],
      });
    }
    if (preparationStop !== null || remainingMs() <= 0) {
      // Preparation stopped because the run's own deadline had passed, not
      // because Git failed. The report keeps the preparation problem it has,
      // and the timeout says which limit was responsible.
      const evidence = timedOut({
        limit: 'task',
        phase: 'preparation of the working copy',
        limitMs: taskLimitMs,
        ...(preparationStop === null
          ? {}
          : { termination: preparationStop.termination, problem: preparationStop.problem }),
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

  /**
   * The working copy's own commit identity, written before any check or coding
   * turn runs in it: a turn is encouraged to make small local commits, and the
   * harness never writes the machine's global Git configuration. It is guarded
   * like every other phase: a stop or an expired deadline that has already
   * arrived means it is not started at all, and one that arrives while it runs
   * is what the run ends for — a rejection on the way out never replaces the
   * reason the run actually stopped. A setting that plainly cannot be written
   * ends the run here, with a report, rather than letting a turn run with an
   * unknown commit identity. Each setting is written by a Git invocation bounded
   * by what is left of the task time and stopped with the run, so a stalled Git
   * cannot hold this phase either, and a stop it could not confirm is carried
   * into the run's own evidence.
   */
  const identityPhase = "the working copy's Git identity";
  if (stopped()) {
    return endStopped({
      cause: callerStopped(
        identityPhase,
        "the run was stopped by its caller before the working copy's Git identity was configured, so no check and no coding turn was started",
      ),
      baseline: null,
      attempts: [],
    });
  }
  if (remainingMs() <= 0) {
    const evidence = timedOut({ limit: 'task', phase: identityPhase, limitMs: taskLimitMs });
    return endTimedOut({
      reason:
        "the run's task deadline expired before the working copy's Git identity was configured, so no check and no coding turn was started",
      baseline: null,
      attempts: [],
      evidence,
    });
  }

  let identityProblem: string | null = null;
  /** The stop the identity step recorded, when a Git invocation was stopped there. */
  let identityStop: WorkspaceStepStop | null = null;
  try {
    await dependencies.configureWorkspaceIdentity(workspace.workspacePath, {
      deadlineMs,
      now: dependencies.now,
      ...(callerStop === undefined ? {} : { stop: callerStop }),
    });
  } catch (cause) {
    identityProblem = messageOf(cause);
    identityStop = workspaceStopOf(cause);
  }
  // The stop the run observed while the phase ran is read first, then the
  // deadline: what it returned or rejected with does not decide the status.
  if (identityStop?.kind === 'cancelled' || (identityStop?.kind === undefined && stopped())) {
    return endStopped({
      cause: callerStopped(
        identityPhase,
        "the run was stopped by its caller while the working copy's Git identity was being configured, so no check and no coding turn was started",
        identityStop ?? undefined,
      ),
      baseline: null,
      attempts: [],
    });
  }
  if (identityStop !== null || remainingMs() <= 0) {
    const evidence = timedOut({
      limit: 'task',
      phase: identityPhase,
      limitMs: taskLimitMs,
      ...(identityStop === null
        ? {}
        : { termination: identityStop.termination, problem: identityStop.problem }),
    });
    return endTimedOut({
      reason:
        "the run's task deadline expired while the working copy's Git identity was being configured, so no check and no coding turn was started",
      baseline: null,
      attempts: [],
      evidence,
    });
  }
  if (identityProblem !== null) {
    return endRun({
      status: 'failed',
      reason:
        "the working copy's local Git identity could not be configured, so no check and no " +
        `coding turn was started: ${oneLine(identityProblem)}`,
      baseline: null,
      attempts: [],
      timeout: null,
      cancellation: null,
    });
  }
  await dependencies.appendRunLog(
    timeline,
    `workspace Git identity configured: ${WORKSPACE_IDENTITY.map(
      ([key, value]) => `${key}=${value}`,
    ).join(', ')}`,
  );

  // Everything below works in the prepared working copy, and keeps it.
  const workspacePath = workspace.workspacePath;
  /** The branch this workspace's ledger records: what its turns work on. */
  const workspaceBranch = workspace.branch;

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
   * Returns the checkout to the branch its workspace records before it is read
   * again (HARN-35). A coding turn has Git write access to its clone, so it can
   * leave the checkout on a branch of its own with its work committed there;
   * what the checks judge, and what a delivery step publishes, is the recorded
   * branch's own revision. A clean checkout whose commit descends from that
   * branch is fast-forwarded and checked out; a dirty, detached, divergent, or
   * branchless one ends the run here, with the branch names and the manual
   * action, rather than starting a turn or a check on a checkout the workspace
   * does not hold.
   *
   * `requireClean` is what a coding turn adds to that: it starts from the
   * workspace's own committed state, so uncommitted work — on the recorded
   * branch included — ends the run before the agent rather than being handed to
   * it. The round that judges a turn does not ask for it: what the turn left,
   * uncommitted work included, is what that round is for.
   *
   * `null` means the checkout is on its recorded branch and the caller may go
   * on. The reading and the return are bounded like the commit identity: what is
   * left of the run's task time, the run's clock, and the run's own stop
   * request, with a stop reported as the stop it was — never as a statement
   * about the checkout.
   */
  const settleBranch = async (parts: {
    /** The phase the reason and the timeline name, e.g. "the checkout before repair turn 2". */
    readonly phase: string;
    /** What the phase could not start, as the reason reads it. */
    readonly without: string;
    /** Whether the state the phase needs holds no uncommitted work. */
    readonly requireClean: boolean;
    readonly baseline: CheckRoundResult | null;
    readonly attempts: readonly AttemptEvidence[];
  }): Promise<RunTaskResult | null> => {
    let problem: string | null = null;
    let stop: WorkspaceStepStop | null = null;
    try {
      const returned = await dependencies.returnToRecordedBranch(
        workspacePath,
        workspaceBranch,
        {
          deadlineMs,
          now: dependencies.now,
          ...(callerStop === undefined ? {} : { stop: callerStop }),
        },
        { requireClean: parts.requireClean },
      );
      if (returned.changed) {
        await dependencies.appendRunLog(
          timeline,
          `checkout returned to branch ${workspaceBranch} at ${returned.revision}, from ${returned.from}`,
        );
      }
    } catch (cause) {
      problem = messageOf(cause);
      stop = workspaceStopOf(cause);
    }
    // The stop the return observed is read first, then the deadline: what it
    // rejected with does not decide why the run ended.
    if (stop?.kind === 'cancelled' || (stop?.kind === undefined && stopped())) {
      return endStopped({
        cause: callerStopped(
          parts.phase,
          `the run was stopped by its caller while ${parts.phase} was being returned to the ` +
            `workspace's recorded branch "${workspaceBranch}", so ${parts.without}`,
          stop ?? undefined,
        ),
        baseline: parts.baseline,
        attempts: parts.attempts,
      });
    }
    if (stop !== null || remainingMs() <= 0) {
      return endTimedOut({
        reason:
          `the run's task deadline expired while ${parts.phase} was being returned to the ` +
          `workspace's recorded branch "${workspaceBranch}", so ${parts.without}`,
        baseline: parts.baseline,
        attempts: parts.attempts,
        evidence: timedOut({
          limit: 'task',
          phase: parts.phase,
          limitMs: taskLimitMs,
          ...(stop === null ? {} : { termination: stop.termination, problem: stop.problem }),
        }),
      });
    }
    if (problem !== null) {
      // What the phase needed is named with the failure: the round that reads a
      // turn's work needs the recorded branch, and a coding turn needs that same
      // branch with no uncommitted work under it.
      return endRun({
        status: 'failed',
        reason: parts.requireClean
          ? `the working copy is not in the state a coding turn starts from — the branch this ` +
            `workspace records ("${workspaceBranch}"), with no uncommitted work — so ` +
            `${parts.without}: ${oneLine(problem)}`
          : `the checkout could not be returned to the branch this workspace records ` +
            `("${workspaceBranch}"), so ${parts.without}: ${oneLine(problem)}`,
        baseline: parts.baseline,
        attempts: parts.attempts,
        timeout: null,
        cancellation: null,
      });
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
    /**
     * The deadline expired before the turn this loop is at: no turn is started,
     * no check runs after one, and the evidence names the limit. Read here and
     * again after the checkout has been settled, because that step is part of
     * the same budget.
     */
    const expiredBeforeTurn = (): Promise<RunTaskResult> =>
      endTimedOut({
        reason: `the run's task deadline expired before ${describeTurn(kind, turn)} was started, so no further turn and no check was run`,
        baseline,
        attempts,
        evidence: timedOut({
          limit: 'task',
          phase: nameTurn(kind, turn),
          limitMs: taskLimitMs,
        }),
      });
    if (remainingMs() <= 0) {
      return expiredBeforeTurn();
    }

    // The turn starts on the branch its workspace records, and from the
    // workspace's own committed state. An earlier attempt, or an earlier rung of
    // this cycle, may have left the checkout on a branch of its own, or left
    // work it never committed, and settling that here is what makes every
    // continuation and every repair turn the recorded branch's own work
    // (HARN-35).
    const beforeTurn = await settleBranch({
      phase: `the checkout before ${describeTurn(kind, turn)}`,
      without: `${describeTurn(kind, turn)} was not started`,
      requireClean: true,
      baseline,
      attempts,
    });
    if (beforeTurn !== null) {
      return beforeTurn;
    }

    // The turn's own budget is read now, after the checkout was settled: the
    // return above is Git work the run spent its time on, and a turn that was
    // given a budget read before it would be handed time the run no longer has.
    const left = remainingMs();
    if (left <= 0) {
      return expiredBeforeTurn();
    }

    // The coding turn, awaited to completion: the checks that follow it must
    // observe a working copy nothing else is writing to. The turn is also given
    // the run's own remaining time as a stop request, so work that would run
    // past the deadline is asked to stop rather than left to.
    const stop = phaseStop(left, callerStop);
    // The ticket's own conversation history, prepared before every coding turn:
    // one identified local snapshot of the requirements, the Jira thread, the
    // pull request conversation, and the harness's own reports. A snapshot that
    // cannot be prepared stops the turn before it starts — a turn is not handed
    // a promised local history that does not exist — and the failure names the
    // ticket and the reason in the run's own report.
    let turnHistory: HistorySnapshot | undefined;
    if (request.history !== undefined && request.sourceRef !== undefined) {
      try {
        turnHistory = await request.history.prepare({
          ref: request.sourceRef,
          task,
          workspace: {
            workspaceId: workspace.workspaceId,
            workspacePath: workspace.workspacePath,
            branch: workspace.branch,
            baseCommit: workspace.baseCommit,
          },
          role: 'developer',
          round: workspace.attempt,
          stop: stop.signal,
        });
      } catch (cause) {
        stop.cancel();
        return endRun({
          status: 'failed',
          reason:
            `the ticket's local conversation history could not be prepared, so ` +
            `${describeTurn(kind, turn)} was not started: ${oneLine(messageOf(cause))}`,
          baseline,
          attempts,
          timeout: null,
          cancellation: null,
        });
      }
    }
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
        task: turnHistory?.brief.task ?? task,
        workspacePath,
        sourceRoot: workspace.sourceRoot,
        baseCommit: workspace.baseCommit,
        agentLog,
        repair,
        ...(request.guidance === undefined ? {} : { guidance: request.guidance }),
        ...(turnHistory === undefined ? {} : { history: turnHistory }),
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
    if (request.sourceRef !== undefined && request.history?.recordDeveloperReport !== undefined) {
      const recordedAttempts = [
        ...attempts,
        {
          turn,
          kind,
          agentLog: agentLog.path,
          agentSummary: completed?.summary ?? null,
          checks: null,
        },
      ];
      try {
        await request.history.recordDeveloperReport({
          ref: turnHistory?.brief.ref ?? request.sourceRef,
          workspaceId: workspace.workspaceId,
          task: turnHistory?.brief.task ?? task,
          round: workspace.attempt,
          runId: run.runId,
          reportPath: runReportPath(run.runDir),
          status: 'in-progress',
          reason: 'Coding turn reports retained; this run has not finished its checks or delivery.',
          repairsUsed: turn - 1,
          attempts: recordedAttempts.map((attempt) => ({
            turn: attempt.turn,
            kind: attempt.kind,
            agentSummary: attempt.agentSummary,
            checks: attempt.checks?.outcome ?? null,
          })),
          pullRequest: null,
          deliveryFailure: null,
          now: dependencies.now(),
        });
      } catch (cause) {
        return endRun({
          status: 'failed',
          reason: `the complete developer turn report could not be retained: ${messageOf(cause)}`,
          baseline,
          attempts: recordedAttempts,
          timeout: null,
          cancellation: null,
        });
      }
    }
    if (completed?.summary != null && turnHistory !== undefined) {
      // Failure to save a cursor only replays feedback; it must not lose a report.
      await request.history?.consumed?.(turnHistory).catch(() => undefined);
    }
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

    // The turn ran, so its own record starts here, without a round yet: a
    // checkout that cannot be read after it keeps the turn that happened rather
    // than losing it, and stays with no check round observed after it.
    const turnEntry: AttemptEvidence = {
      turn,
      kind,
      agentLog: agentLog.path,
      agentSummary: completed.summary,
      checks: null,
    };
    attempts.push(turnEntry);

    // The turn may have left the checkout on a branch of its own. The checks
    // that judge it, and a delivery of a passed attempt, are about the revision
    // the workspace's recorded branch holds, so the checkout is returned to that
    // branch before the round reads the working copy (HARN-35).
    const beforeRound = await settleBranch({
      phase: `the checkout before the checks after ${describeTurn(kind, turn)}`,
      without: `no check ran after ${describeTurn(kind, turn)}`,
      // The round reads what the turn left, uncommitted work included: that is
      // what the attempt is judged on, and the delivery step is what refuses to
      // publish a working copy that still holds it.
      requireClean: false,
      baseline,
      attempts,
    });
    if (beforeRound !== null) {
      return beforeRound;
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
    attempts[attempts.length - 1] = { ...turnEntry, checks: observed };

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
