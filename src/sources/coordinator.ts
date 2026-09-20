/**
 * The one serial intake coordinator, over the unchanged runner: discover a
 * finite batch, then handle each item one at a time.
 *
 * ```text
 * discover (all pages) -> per item: receipt? -> prepare -> reserve -> claim
 *                                            -> existing runTask -> publish
 * ```
 *
 * It knows ordinary data and functions: it imports no connector, no JQL, no ADF,
 * and no credential, and the runner never sees any of them. A local receipt
 * prevents attempting the same item twice; a claim that was rejected before any
 * mutation request was sent releases only the receipt this process just created,
 * while an error or an uncertain answer after a mutation keeps it and stops
 * intake for a human. Local results are kept whatever the remote feedback does.
 */
import { rm } from 'node:fs/promises';
import type { DeliveredPullRequest, Delivery } from '../delivery/github.js';
import { DeliveryError } from '../delivery/github.js';
import type { RunTaskResult } from '../runs/contracts.js';
import { RunCancelledError, RunTimeoutError } from '../runs/contracts.js';
import { messageOf } from '../shared/errors.js';
import { workspaceStopOf } from '../workspace/errors.js';
import type { AttemptEvidence, SourceRef } from '../shared/types.js';
import type { ContinuedWorkspace } from '../workspace/reopen.js';
import { reopenWorkspace } from '../workspace/reopen.js';
import { readWorkspaceState, sourceItemFor } from '../workspace/state.js';
import type {
  CompletionRunSummary,
  SourceCandidate,
  SourceComment,
  SourceContext,
  SourceOutcome,
  SourceRunOutcome,
  SourceSummary,
  SourceTake,
  SourceTakeRun,
  SourceTask,
  QueueTicket,
} from './contract.js';
import { SourceError, SourceFeedbackError } from './contract.js';
import { decideAttempt } from './eligibility.js';
import { guidanceFrom } from './guidance.js';
import {
  acquireIntakeLock,
  readReceipt,
  receiptFilePath,
  receiptIdentity,
  reserveReceipt,
  updateReceipt,
} from './receipts.js';
import type { SourceReceipt } from './receipts.js';

/** What a source command needs to know about how one run ended. */
function runOutcome(
  result: RunTaskResult,
  attempt?: SourceRunOutcome['attempt'],
  pullRequest?: DeliveredPullRequest | null,
  deliveryFailure?: string | null,
  completionEnabled = false,
): SourceRunOutcome {
  return {
    ...(completionEnabled ? { completionEnabled: true } : {}),
    runId: result.run.runId,
    status: result.status,
    reason: result.reason,
    repairsUsed: result.repairsUsed,
    checks: checkSummary(result),
    runDir: result.run.runDir,
    reportPath: result.reportPath,
    ...(attempt === undefined ? {} : { attempt }),
    ...(pullRequest === null || pullRequest === undefined ? {} : { pullRequest }),
    ...(deliveryFailure === null || deliveryFailure === undefined ? {} : { deliveryFailure }),
  };
}

/** What a failed publication wrote into the receipt, and what it acknowledged. */
function feedbackFailure(cause: unknown): { problem: string; commentId: string | null } {
  return cause instanceof SourceFeedbackError
    ? { problem: cause.message, commentId: cause.commentId }
    : { problem: messageOf(cause), commentId: null };
}

/**
 * One line about the checks that decided a run, or that none were observed.
 *
 * A stopped run's last turn carries no round: it was stopped before any check
 * could run after it. Falling back to the baseline there describes the round the
 * run started with as if it were the one that decided it — a live run over HARN-1
 * (`run-20260916225121-f3d4a6e4`) reported `round: passed` for a run whose
 * post-agent round was red, because the stopped repair turn had no checks to
 * report — so this line names the last round that really ran, and says that
 * nothing ran after the turn that was stopped.
 */
function checkSummary(result: RunTaskResult): string {
  const lastTurn = result.attempts.at(-1);
  const observed =
    [...result.attempts].reverse().find((attempt) => attempt.checks !== null)?.checks ??
    result.baseline;
  const line =
    observed === null
      ? 'no check round was completed for this run'
      : `${String(
          observed.checks.filter((entry) => entry.outcome === 'exited' && entry.exitCode === 0)
            .length,
        )} of ${String(observed.checks.length)} configured checks exited 0 (round: ${observed.outcome})`;
  if (lastTurn === undefined || lastTurn.checks !== null) {
    return line;
  }
  return `${line}; no check round was observed after ${nameTurn(lastTurn)}`;
}
/** How the feedback names one top-level coding turn, as the run's reasons name it. */
function nameTurn(attempt: AttemptEvidence): string {
  return attempt.kind === 'implementation'
    ? 'the implementation turn'
    : `repair turn ${String(attempt.turn)}`;
}
/**
 * Reports a repeated per-issue diagnostic at most once, until what it says
 * changes. A watch loop re-scans the whole eligible queue, so an issue that is
 * still unusable would otherwise repeat the same line on every scan
 * (docs/spec.md §6).
 */
function reportOnce(
  diagnostics: Map<string, string> | null,
  key: string,
  marker: string,
  write: () => void,
): void {
  if (diagnostics === null) {
    write();
    return;
  }
  if (diagnostics.get(key) === marker) {
    return;
  }
  diagnostics.set(key, marker);
  write();
}
interface BatchState {
  attempted: number;
  passed: number;
  failed: number;
  cancelled: number;
  invalid: number;
  refused: number;
  skipped: number;
  problem: string | null;
  cleanupConfirmed: boolean;
  /** What the last review-to-completion pass did; `null` when it is off. */
  completion: CompletionRunSummary | null;
  /**
   * The one ticket a queue consumer step took and how its last run ended. The
   * finite batch and watch paths never read it; it is what one `queue` step
   * reports back to the serial loop (docs/WORKFLOW.md §11).
   */
  taken: QueueTicket | null;
  takenRun: SourceTakeRun | null;
}

function emptyState(): BatchState {
  return {
    attempted: 0,
    passed: 0,
    failed: 0,
    cancelled: 0,
    invalid: 0,
    refused: 0,
    skipped: 0,
    problem: null,
    cleanupConfirmed: true,
    completion: null,
    taken: null,
    takenRun: null,
  };
}

/**
 * The optional review-to-completion pass: how an In Review item's delivered pull
 * request is carried to a verified finish or back for repair. It runs after the
 * batch, never changes what the batch itself did, and never starts a coding turn.
 * A failure is reported through the summary and the terminal; the intake's own
 * outcome stands, because a completion problem is not a coding one.
 */
async function runCompletion(context: SourceContext, state: BatchState): Promise<void> {
  const completion = context.completion;
  if (completion === undefined || context.stop.aborted) {
    return;
  }
  try {
    state.completion = await completion.run(context.stop);
  } catch (cause) {
    // The pass turns its own failures into a reported summary; anything that
    // escapes it is still not a reason to fail the intake that just ran.
    state.completion = {
      done: 0,
      toDo: 0,
      attention: 0,
      observed: 0,
      problem: messageOf(cause),
    };
  }
  if (state.completion.problem !== null) {
    context.io.err(`completion pass: ${state.completion.problem}`);
  }
}

function summarize(outcome: SourceOutcome, state: BatchState): SourceSummary {
  return {
    outcome,
    attempted: state.attempted,
    passed: state.passed,
    failed: state.failed,
    cancelled: state.cancelled,
    invalid: state.invalid,
    refused: state.refused,
    skipped: state.skipped,
    problem: state.problem,
    cleanupConfirmed: state.cleanupConfirmed,
    completion: state.completion,
  };
}

/** Stops intake with a problem a human has to look at. */
function stopWith(state: BatchState, problem: string, confirmed = true): 'stop' {
  state.problem = problem;
  state.cleanupConfirmed = state.cleanupConfirmed && confirmed;
  return 'stop';
}
/** What handling one candidate did, and whether the batch should go on. */
type Step = 'next' | 'stop' | 'cancelled';

/**
 * How one intake step is bounded. A finite batch or a watch scan processes the
 * whole discovered queue and skips what it will not act on; a `queue` step takes
 * at most one ticket, so an item it will not act on — a refusal, or a
 * description that cannot be mapped to a task — is the serial loop's own
 * actionable stop instead of a quiet skip (docs/WORKFLOW.md §11).
 */
type CoordinatorMode = 'batch' | 'single';

/** A failed Git cleanup is an intake stop, including before a run exists. */
function unconfirmedWorkspaceStop(
  state: BatchState,
  cause: unknown,
  phase: string,
  signal: AbortSignal,
): Step | null {
  const evidence =
    workspaceStopOf(cause) ??
    (cause instanceof RunCancelledError || cause instanceof RunTimeoutError
      ? workspaceStopOf(cause.cause)
      : null);
  if (evidence?.termination !== 'unconfirmed') return null;
  stopWith(
    state,
    `${phase}: ${messageOf(cause)}; termination unconfirmed: ` +
      `${evidence.problem ?? 'no reason was recorded'}. Intake stops; any existing intake lock is kept for inspection.`,
    false,
  );
  return signal.aborted || evidence.kind === 'cancelled' ? 'cancelled' : 'stop';
}
/**
 * Publishes a refusal and takes the item out of the queue, so a later scan does
 * not read it again and again. Nothing is claimed, nothing runs, and nothing
 * local is created: the item is re-read first, so a refusal is about the item as
 * it is now, and one that changed or left the queue is left alone.
 */
async function refuse(
  context: SourceContext,
  candidate: SourceCandidate,
  reason: string,
  state: BatchState,
  diagnostics: Map<string, string> | null,
  mode: CoordinatorMode,
): Promise<Step> {
  const { source, io, stop } = context;
  const identity = receiptIdentity(candidate.ref);

  let prepared: SourceTask | null;
  try {
    prepared = await source.prepare(candidate, stop);
  } catch (cause) {
    if (cause instanceof SourceError && cause.kind === 'invalid-task') {
      state.invalid += 1;
      reportOnce(
        diagnostics,
        identity,
        `invalid:${candidate.ref.updatedAt}:${cause.message}`,
        () => {
          io.err(
            `${candidate.ref.key} (${candidate.title}): skipped, not a usable task: ${cause.message}`,
          );
        },
      );
      return 'next';
    }
    if (stop.aborted) {
      return 'cancelled';
    }
    throw cause;
  }
  if (prepared === null) {
    state.skipped += 1;
    reportOnce(diagnostics, identity, `stale:${candidate.ref.updatedAt}`, () => {
      io.out(`${candidate.ref.key}: no longer eligible, so it was skipped without a claim`);
    });
    return 'next';
  }

  const item = prepared;
  io.err(`${item.ref.key}: refused, and the issue is told why: ${reason}`);
  const feedbackStop = stop.aborted ? AbortSignal.timeout(FEEDBACK_DEADLINE_MS) : stop;
  try {
    await source.refuse(item, reason, feedbackStop);
  } catch (cause) {
    return stopWith(
      state,
      `${item.ref.key}: the issue was refused, but publishing that refusal failed, so intake stops ` +
        `for inspection: ${messageOf(cause)}`,
    );
  }
  state.refused += 1;
  io.out(`${item.ref.key}: refusal published and the issue taken out of the queue`);
  if (mode === 'single') {
    // A queue does not skip the ticket it will not act on: the refusal is the
    // loop's actionable result, and a person decides what happens to the item
    // before any other ticket is considered (docs/WORKFLOW.md §11).
    return stopWith(
      state,
      `${item.ref.key}: the harness refused it and took it out of the queue: ${reason}`,
    );
  }
  return 'next';
}

/**
 * One passed attempt's delivery, or `null` when the configured step found
 * nothing to publish.
 *
 * The workspace the run left is what is delivered, on the branch it recorded:
 * a later attempt continues the same clone on the same branch, so committed
 * work from a later attempt updates that branch and the pull request it already
 * has instead of producing a second one (docs/WORKFLOW.md §8).
 */
async function deliverPassed(
  delivery: Delivery,
  item: SourceTask,
  run: RunTaskResult,
  stop: AbortSignal,
): Promise<DeliveredPullRequest | null> {
  const workspace = run.workspace;
  if (workspace === null) {
    throw new DeliveryError(
      `the run passed but kept no working copy (report ${run.reportPath}), so there was nothing to ` +
        'deliver',
    );
  }

  return await delivery.deliver(
    {
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      baseCommit: workspace.baseCommit,
      logsDir: run.run.logsDir,
      runId: run.run.runId,
      reportPath: run.reportPath,
      task: { id: item.task.id, title: item.task.title },
      // The same line the issue's comment carries, so the pull request and the
      // issue never disagree about which checks decided the attempt.
      checks: checkSummary(run),
      sourceRef: item.ref,
    },
    stop,
  );
}

/**
 * A passed attempt whose delivery failed: the issue is still told the outcome
 * the run produced, with the publication failure beside it, so a finished task
 * is not left in the running status where a Jira-only coordinator would never
 * see it. Then intake stops for a human.
 *
 * Ordering is the point: the delivery problem is recorded first, so a Jira
 * failure here cannot cost the run its local evidence. The feedback itself is
 * the same bounded, best-effort path a stopped run's result takes.
 *
 * Retrying the publication is an operator step with ordinary `git` and `gh` in
 * the retained workspace — not another attempt. Moving the issue back to the
 * ready status starts a new coding run, which is rework, never a delivery retry
 * (docs/WORKFLOW.md §8).
 */
async function reportDeliveryFailure(
  context: SourceContext,
  file: string,
  item: SourceTask,
  run: RunTaskResult,
  attempt: SourceRunOutcome['attempt'],
  problem: string,
  state: BatchState,
): Promise<Step> {
  const { source, io, stop } = context;
  const key = item.ref.key;

  await updateReceipt(file, { problem: `delivery: ${problem}` });
  const feedbackStop = stop.aborted ? AbortSignal.timeout(FEEDBACK_DEADLINE_MS) : stop;
  try {
    await source.complete(item, runOutcome(run, attempt, null, problem), feedbackStop);
  } catch (cause) {
    const failure = feedbackFailure(cause);
    await updateReceipt(file, {
      feedback: 'failed',
      problem: `delivery: ${problem}; feedback: ${failure.problem}`,
      ...(failure.commentId === null ? {} : { commentId: failure.commentId }),
    });
    return stopWith(
      state,
      `${key}: the run is kept as passed (report ${run.reportPath}), but delivering it failed ` +
        `and the issue could not be told either, so intake stops for inspection. The delivery ` +
        `failed with: ${problem} Publishing that failed with: ${failure.problem} The local ` +
        'report, logs, and receipt are kept as they were written; retrying the publication is ' +
        'an operator step with git and gh in the retained workspace, never another attempt.',
    );
  }

  await updateReceipt(file, { feedback: 'sent' });
  io.out(`${key}: result published and moved to review, carrying its delivery failure`);
  const workspace = run.workspace;
  return stopWith(
    state,
    `${key}: the run is kept as passed (report ${run.reportPath}) and the issue was told that ` +
      `outcome, with the delivery failure, so it is not left in the running status. Intake ` +
      `stops because delivering it failed: ${problem} Retrying the publication is an operator ` +
      'step, not another attempt: check the destination repository first (a push or a pull ' +
      'request creation that failed may already have taken effect), then push the branch and ' +
      'open or update the pull request by hand with git and gh from ' +
      (workspace === null
        ? 'the retained workspace.'
        : `the retained workspace ${workspace.workspacePath} (branch ${workspace.branch}).`) +
      ' Moving the issue back to the ready status is not that retry: it starts a new coding run ' +
      'in the same workspace.',
  );
}

/**
 * Whether a run's own evidence says the escalation ladder may climb from it:
 * the attempt ended on an ordinary completed red check round whose repair
 * allowance was spent, and nothing else stopped it.
 *
 * Every other ending is terminal at the rung that produced it — a coding turn
 * that could not finish (a launch, authentication, or protocol error), a round
 * that could not be executed (a setup failure, a check that could not be
 * launched), an expired limit, a cancellation, or a stop that was not confirmed
 * — and escalating those would spend a stronger launch on infrastructure rather
 * than on code. The fields below are what says which ending a run had: the
 * status, the stop evidence, the repair turns the rung's own run really spent,
 * and the last turn's own round. No reason string is read, so rewording a run's
 * sentence can never change where the ladder goes
 * (docs/implement-workspace-continuation.md).
 */
function exhaustedRedRound(run: RunTaskResult, allowance: number): boolean {
  if (run.status !== 'failed' || run.timeout !== null || run.cancellation !== null) {
    return false;
  }
  if (run.repairsUsed < allowance) {
    // The tier's own allowance was not spent: the rung has not exhausted the
    // repair turns it was given, so a stronger launch is not spent here yet.
    return false;
  }
  const lastTurn = run.attempts.at(-1);
  return lastTurn !== undefined && lastTurn.checks?.outcome === 'failed';
}

/**
 * One item, through the documented reservation sequence: receipt first, a fresh
 * read of the item and a decision from that read, eligibility and revision
 * rechecked, an unambiguous claim, the unchanged runner, the real local result,
 * and then remote feedback.
 */
async function attempt(
  context: SourceContext,
  candidate: SourceCandidate,
  state: BatchState,
  diagnostics: Map<string, string> | null,
  mode: CoordinatorMode,
): Promise<Step> {
  const { source, workDir, io, stop, now } = context;
  const file = receiptFilePath(workDir, candidate.ref);
  const identity = receiptIdentity(candidate.ref);

  const existing = await readReceipt(file);

  if (stop.aborted) {
    return 'cancelled';
  }

  // The source checkout is rechecked before the reservation, not after it: a
  // checkout that cannot be used must not leave a receipt on an issue the
  // harness would not have been allowed to run.
  let sourceRoot: string;
  try {
    sourceRoot = (
      await context.preflight({
        repoPath: context.repoPath,
        workDir,
        // The check's Git readings are bounded: the finite default, and the
        // intake's own stop request, so an interrupt ends one that is running.
        bounds: { stop },
      })
    ).sourceRoot;
  } catch (cause) {
    const cleanup = unconfirmedWorkspaceStop(
      state,
      cause,
      `${candidate.ref.key}: source preflight`,
      stop,
    );
    if (cleanup !== null) return cleanup;
    if (stop.aborted) {
      // The reading was stopped because the intake was, not because of what the
      // source checkout is: nothing is claimed and no receipt is touched.
      return 'cancelled';
    }
    return stopWith(
      state,
      `${candidate.ref.key}: the source checkout was refused before the issue was reserved: ${messageOf(cause)}`,
    );
  }

  // The item is re-read before anything is decided: a search result can lag, so
  // the fresh, continue, or refuse decision below is made from the pointer labels
  // this read observed, never from the ones discovery returned.
  let prepared: SourceTask | null;
  try {
    prepared = await source.prepare(candidate, stop);
  } catch (cause) {
    if (cause instanceof SourceError && cause.kind === 'invalid-task') {
      state.invalid += 1;
      if (mode === 'single') {
        // A queue step does not skip past a ticket the operator put in the
        // queue: the unusable description is its own actionable result, and
        // the item is left in the ready status for a person to fix.
        return stopWith(
          state,
          `${candidate.ref.key} (${candidate.title}) is not a usable task, so the queue stops ` +
            `instead of taking another ticket: ${cause.message}`,
        );
      }
      // Suppressed until what the source reports about the issue changes: an
      // edited issue is diagnosed again (docs/spec.md §6).
      reportOnce(
        diagnostics,
        identity,
        `invalid:${candidate.ref.updatedAt}:${cause.message}`,
        () => {
          io.err(
            `${candidate.ref.key} (${candidate.title}): skipped, not a usable task: ${cause.message}`,
          );
        },
      );
      return 'next';
    }
    if (stop.aborted) {
      return 'cancelled';
    }
    throw cause;
  }

  if (prepared === null) {
    state.skipped += 1;
    reportOnce(diagnostics, identity, `stale:${candidate.ref.updatedAt}`, () => {
      io.out(`${candidate.ref.key}: no longer eligible, so it was skipped without a claim`);
    });
    return 'next';
  }

  const item = prepared;
  const decision = await decideAttempt(workDir, item, existing, sourceRoot);
  if (decision.kind === 'refuse') {
    return await refuse(context, candidate, decision.reason, state, diagnostics, mode);
  }

  // A continuation's checkout is read before anything is reserved: one that is
  // not on the branch its ledger records, or whose ledger records another item or
  // another repository, is refused while nothing has been claimed and nothing has
  // been created.
  let continuedWorkspace: ContinuedWorkspace | undefined;
  if (decision.kind === 'continue') {
    try {
      continuedWorkspace = await reopenWorkspace(
        workDir,
        decision.workspace.workspaceId,
        {
          sourceItem: sourceItemFor(item.ref),
          sourceRoot,
        },
        { stop },
      );
    } catch (cause) {
      const cleanup = unconfirmedWorkspaceStop(
        state,
        cause,
        `${candidate.ref.key}: continuation verification`,
        stop,
      );
      if (cleanup !== null) return cleanup;
      if (stop.aborted) {
        // The verification of the checkout was stopped because the intake was:
        // that is not a refusal of the item, and nothing has been claimed yet.
        return 'cancelled';
      }
      return await refuse(context, candidate, messageOf(cause), state, diagnostics, mode);
    }
  }

  // A first attempt reserves its own receipt. A continuation has one from the
  // attempt it continues; one whose pointer a person added by hand does not, and
  // it needs one all the same, because this attempt's outcome is recorded there.
  if (existing === null) {
    const receipt: SourceReceipt = {
      version: 1,
      source: item.ref,
      reservedAt: now().toISOString(),
    };
    if (!(await reserveReceipt(file, receipt))) {
      state.skipped += 1;
      const detail =
        `${candidate.ref.key}: another reservation already existed, so it was not attempted ` +
        `(${file})`;
      if (mode === 'single') {
        // Another consumer's reservation is not something a serial queue may
        // step over: a person has to settle which process owns the ticket.
        return stopWith(state, `${detail}; the queue stops instead of taking another ticket`);
      }
      io.out(detail);
      return 'next';
    }
  } else if (existing.problem !== undefined) {
    // What went wrong last time is not what this attempt is doing: cleared here,
    // and anything this attempt observes is written again below.
    await updateReceipt(file, { problem: undefined });
  }
  state.attempted += 1;
  // The ticket this step is now working. A `queue` step reports it back to the
  // serial loop as soon as it is reserved, so even an attempt that produces no
  // run of its own is named by the result (docs/WORKFLOW.md §11).
  state.taken = { ref: item.ref, title: candidate.title };
  io.out(
    continuedWorkspace !== undefined
      ? `${item.ref.key}: reserved (${file}); continuing workspace ` +
          `${continuedWorkspace.workspaceId} (attempt ${String(continuedWorkspace.attempt)}); ` +
          `claiming ${item.ref.id}`
      : `${item.ref.key}: reserved (${file}); claiming ${item.ref.id}`,
  );

  let claimed: boolean;
  try {
    claimed = await source.claim(item, stop);
  } catch (cause) {
    const problem = messageOf(cause);
    await updateReceipt(file, { problem: `claim: ${problem}` });
    return stopWith(
      state,
      `${prepared.ref.key}: the claim did not complete, so its receipt is kept and intake stops for ` +
        `inspection: ${problem}`,
    );
  }
  if (!claimed) {
    // No mutation request was sent, so only this process's own new reservation
    // is released; the issue is skipped and a later scan may try again.
    if (existing === null) {
      await rm(file, { force: true });
    }
    state.skipped += 1;
    io.out(
      `${item.ref.key}: no longer eligible or its revision changed before any claim was sent, ` +
        'so the reservation was released',
    );
    return 'next';
  }

  // The ladder: one attempt per rung, and this claim starts it at the first
  // rung. Escalation is local to one coding cycle — every claim is one, whether
  // it creates a workspace or continues the one a reviewer's findings, a failed
  // required check, a delivery failure, or a failed post-merge workflow returned
  // to the ready status — so a ticket coming back to work is repaired by the
  // first tier again, never by the rung the workspace's attempt count has
  // reached. That count stays the history its reports and its ledger record.
  // Every attempt is its own run — its own directory, report, comment, and repair
  // allowance — and the issue stays in the running status until the climb ends:
  // only a rung whose own run exhausted its allowance with an ordinary red check
  // round climbs, and a pass, a terminal failure, or the last rung publishes the
  // result and moves the issue to review
  // (docs/implement-workspace-continuation.md).
  const ladder = context.tiers;
  /** Which rung of this cycle's ladder the next attempt runs; 0 is its first. */
  let rung = 0;
  let resume = continuedWorkspace;
  let result: RunTaskResult | undefined;

  for (;;) {
    const tier = ladder[rung];
    if (tier === undefined) {
      return stopWith(
        state,
        `${item.ref.key}: the configuration declares no agent tier, so no attempt was started`,
      );
    }
    /** The rung's own position in this cycle's ladder: 1 for its first tier. */
    const rungNumber = rung + 1;
    /** Which attempt this is for the workspace, as its own ledger counts them. */
    const attempt = resume?.attempt ?? 1;

    let run: RunTaskResult;
    // The rung's own brief: what the item's thread says, and what the earlier
    // attempts in this workspace did (recorded as they finished). A first attempt
    // of a first workspace has only the thread, which is enough to carry what a
    // previous ticket, a restart, or another agent wrote down.
    const workspaceId =
      resume?.workspaceId ??
      (decision.kind === 'continue' ? decision.workspace.workspaceId : undefined);
    const earlier =
      workspaceId === undefined
        ? []
        : ((await readWorkspaceState(workDir, workspaceId))?.attempts ?? []);
    // What the item's own thread says since the previous attempt ended: for a
    // first attempt of a workspace, the whole thread, and for a later rung of the
    // same climb, the harness's own comment for the attempt before it. A read
    // that fails is said out loud and does not stop the attempt: it is context,
    // and the run's own evidence is not.
    let comments: readonly SourceComment[] = [];
    try {
      comments = await source.commentsSince(
        item,
        earlier.at(-1)?.endedAt ?? new Date(0).toISOString(),
        stop,
      );
    } catch (cause) {
      io.err(
        `${item.ref.key}: its comments could not be read, so this attempt runs without them: ` +
          messageOf(cause),
      );
    }
    const guidance = guidanceFrom(earlier, comments);
    try {
      run = await context.run({
        task: item.task,
        sourceRef: item.ref,
        stop,
        tier,
        ...(guidance.length === 0 ? {} : { guidance }),
        ...(resume === undefined ? {} : { continuedWorkspace: resume }),
        // A first attempt of a fresh claim creates the workspace, so it is told
        // the name the item's source prefers for it — a Jira ticket key — and a
        // continuation is not: its workspace is the one the pointer names
        // (docs/implement-workspace-continuation.md).
        ...(decision.kind === 'fresh' && attempt === 1 && item.preferredWorkspaceId !== undefined
          ? { preferredWorkspaceId: item.preferredWorkspaceId }
          : {}),
        ...(decision.kind === 'fresh' && attempt === 1
          ? {
              // Where this attempt's work lives is recorded on the issue before
              // any coding turn runs, so a later attempt can find the workspace
              // even if this one dies. A write that fails throws, and the caller
              // treats the attempt as producing no local result: the receipt is
              // kept and intake stops for inspection.
              onWorkspaceReady: (workspace: { readonly workspaceId: string }) =>
                source.recordWorkspace(item, workspace.workspaceId, stop),
            }
          : {}),
      });
    } catch (cause) {
      const problem = messageOf(cause);
      await updateReceipt(file, { problem: `run: ${problem}` });
      const cleanup = unconfirmedWorkspaceStop(
        state,
        cause,
        `${item.ref.key}: run preflight`,
        stop,
      );
      if (cleanup !== null) return cleanup;
      if (cause instanceof RunCancelledError) {
        return 'cancelled';
      }
      return stopWith(
        state,
        `${item.ref.key}: the run ending this attempt produced no local result, so its receipt is ` +
          `kept and intake stops for inspection: ${problem}`,
      );
    }
    result = run;

    await updateReceipt(file, {
      runId: run.run.runId,
      resultPath: run.reportPath,
      outcome: run.status,
      feedback: 'pending',
    });
    io.out(
      `run ${run.run.runId}: ${run.status} for ${item.ref.key} (${run.reason}), ` +
        `report ${run.reportPath}` +
        ` (attempt ${String(rungNumber)} of ${String(ladder.length)}, tier ${tier.name})`,
    );

    // Whether the run's own execution was confirmed stopped: an expired limit and
    // a stop by the caller both record it, and only `confirmed` lets the next
    // issue run. A handled failed run may be followed by the next issue, but only
    // while the harness knows nothing of the run's own is still running
    // (docs/spec.md §6).
    const stopEvidence = run.timeout ?? run.cancellation;
    const stoppedCleanly = stopEvidence === null || stopEvidence.termination === 'confirmed';
    if (!stoppedCleanly) {
      // Something the run started may still be writing. A result is not published
      // from that position, the next issue is not taken, and the lock is left for
      // a human to inspect.
      await updateReceipt(file, {
        feedback: 'pending',
        problem:
          `feedback: not attempted, because the run's termination was not confirmed (` +
          `${stopEvidence.problem ?? 'no reason was recorded'})`,
      });
      stopWith(
        state,
        `${item.ref.key}: the run ended without confirming that everything it started had ` +
          `stopped (${stopEvidence.problem ?? 'no reason was recorded'}), so intake stops and the lock is kept for inspection`,
        false,
      );
      io.err(
        `${item.ref.key}: the run was stopped without a confirmed termination, so no result was ` +
          'posted and the intake lock is kept for inspection',
      );
      return run.status === 'cancelled' ? 'cancelled' : 'stop';
    }

    // The workspace's own ledger is what the next attempt reads for its attempt
    // number and its guidance — which tier ran each attempt before it included.
    // A record that could not be written is not a detail to log and climb past:
    // this attempt keeps its report, its logs, and its working copy, and intake
    // stops here rather than starting another automatic attempt against a ledger
    // that does not hold this one (docs/spec.md §6: local persistence failures
    // stop intake).
    if (run.workspaceLedgerProblem !== null) {
      await updateReceipt(file, { problem: `workspace ledger: ${run.workspaceLedgerProblem}` });
      return stopWith(
        state,
        `${item.ref.key}: the attempt's own report, logs, and working copy are kept (report ` +
          `${run.reportPath}), but its workspace ledger could not be updated with this attempt, ` +
          `so its result was not published and no further automatic attempt is started against ` +
          `it: ${run.workspaceLedgerProblem} Fix the ledger by hand ` +
          '(docs/implement-workspace-continuation.md), then move the issue back to the ready ' +
          'status to continue the same workspace.',
      );
    }

    // What a passed attempt produced is delivered before the issue is told it
    // passed, so the published result can carry the pull request it produced. A
    // delivery failure is not a coding failure: the run's own report and logs
    // stay exactly as they were written, the issue is still told the outcome
    // the run produced with the failure beside it, the receipt records what
    // failed, and intake stops for a human instead of starting another attempt
    // (docs/WORKFLOW.md §8).
    let pullRequest: DeliveredPullRequest | null = null;
    if (run.status === 'passed' && context.delivery !== undefined) {
      if (stop.aborted) {
        io.err(
          `${item.ref.key}: intake is stopping, so the passed attempt was not delivered; its work ` +
            'stays in the retained workspace',
        );
      } else {
        try {
          pullRequest = await deliverPassed(context.delivery, item, run, stop);
        } catch (cause) {
          return await reportDeliveryFailure(
            context,
            file,
            item,
            run,
            {
              number: rungNumber,
              of: ladder.length,
              tier: tier.name,
            },
            messageOf(cause),
            state,
          );
        }
        io.out(
          pullRequest === null
            ? `${item.ref.key}: the attempt committed nothing beyond its recorded base, so there ` +
                'was nothing to deliver'
            : `${item.ref.key}: pull request ${pullRequest.created ? 'created' : 'updated'}: ` +
                pullRequest.url,
        );
      }
    }

    const outcome = runOutcome(
      run,
      { number: rungNumber, of: ladder.length, tier: tier.name },
      pullRequest,
      undefined,
      context.completion !== undefined,
    );
    // What one `queue` step reports back to the serial loop: the ticket it took,
    // and how the run that ended the climb so far went. A later rung overwrites
    // it, so what the loop sees is the last run this intake ended the item with.
    state.takenRun = {
      status: run.status,
      runId: run.run.runId,
      reportPath: run.reportPath,
      reason: run.reason,
      pullRequest,
    };

    // Whether another rung follows this attempt. Only an exhausted ordinary red
    // check round of a rung that actually spent its repair allowance climbs; the
    // cycle's remaining rungs are the configured ones, so nothing here can add an
    // attempt the configuration did not allow.
    const climbs = exhaustedRedRound(run, tier.maxRepairs) && rung + 1 < ladder.length;

    // A run the caller stopped still gets one bounded, best-effort feedback
    // sequence of its own, so the issue does not sit in the running status.
    const feedbackStop =
      run.status === 'cancelled' ? AbortSignal.timeout(FEEDBACK_DEADLINE_MS) : stop;
    try {
      if (climbs) {
        // The attempt's own comment, published while the issue stays in the
        // running status: the next rung works in the same retained workspace,
        // and the ladder's end is what publishes the result and moves the issue
        // to review (docs/implement-workspace-continuation.md). The receipt stays
        // `pending`: the issue has not been given this intake's last word yet.
        await source.progress(item, outcome, feedbackStop);
        io.out(
          `${item.ref.key}: attempt ${String(rungNumber)} of ${String(ladder.length)} (tier ` +
            `${tier.name}) published; the issue stays in the running status`,
        );
      } else {
        await source.complete(item, outcome, feedbackStop);
        await updateReceipt(file, { feedback: 'sent' });
        io.out(`${item.ref.key}: result published and moved to review`);
      }
    } catch (cause) {
      const failure = feedbackFailure(cause);
      await updateReceipt(file, {
        feedback: 'failed',
        problem: `feedback: ${failure.problem}`,
        ...(failure.commentId === null ? {} : { commentId: failure.commentId }),
      });
      return stopWith(
        state,
        `${item.ref.key}: the local run is kept, but publishing its result failed, so intake ` +
          `stops for inspection: ${failure.problem}`,
      );
    }

    // When nothing may follow — a pass, a terminal failure, or no rung left —
    // the climb is over and the result above was the issue's last word.
    if (!climbs) {
      break;
    }

    // The next rung works in the workspace this attempt just used: the run's own
    // record of it, so nothing is resolved twice, and its next attempt number.
    const workspace = run.workspace;
    if (workspace === null) {
      return stopWith(
        state,
        `${item.ref.key}: the run left no workspace to continue, so no further tier was started`,
      );
    }
    resume = {
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      baseCommit: workspace.baseCommit,
      // The workspace's own history moves on; the escalation index above is not
      // derived from it.
      attempt: workspace.attempt + 1,
    };
    rung += 1;
    const next = ladder[rung];
    io.out(
      `${item.ref.key}: escalating to tier ${next?.name ?? 'unknown'} ` +
        `(attempt ${String(rung + 1)} of ${String(ladder.length)})`,
    );
  }

  // The counters describe what the issue's intake ended as, one entry per issue:
  // the attempts it took are in the ledger, and in the comments it published.
  if (result === undefined) {
    return stopWith(state, `${item.ref.key}: no attempt was made`);
  }
  if (result.status === 'passed') {
    state.passed += 1;
  } else if (result.status === 'cancelled') {
    state.cancelled += 1;
  } else {
    state.failed += 1;
  }

  return result.status === 'cancelled' ? 'cancelled' : 'next';
}

/** The longest a best-effort feedback sequence may take after an interrupt. */
export const FEEDBACK_DEADLINE_MS = 10_000;

/**
 * One finite batch: every candidate, in the order the source returned them, one
 * at a time. It stops early only for the conditions the specification names:
 * an unconfirmed stop, an uncertain claim, a local persistence failure, or a
 * failed publication.
 */
async function processBatch(
  context: SourceContext,
  candidates: readonly SourceCandidate[],
  limit: number | null,
  state: BatchState,
  seenDiagnostics: Map<string, string> | null,
  mode: CoordinatorMode,
): Promise<Step> {
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (context.stop.aborted) {
      return 'cancelled';
    }
    const identity = receiptIdentity(candidate.ref);
    if (seen.has(identity)) {
      // The source contract asks for a de-duplicated batch; a source that
      // returns the same immutable ID twice must still not run it twice.
      continue;
    }
    seen.add(identity);
    if (limit !== null && state.attempted >= limit) {
      if (mode === 'batch') {
        context.io.out(
          `limit of ${String(limit)} new attempt(s) reached; the rest of the batch was left for the next scan`,
        );
      }
      return 'next';
    }

    const step = await attempt(context, candidate, state, seenDiagnostics, mode);
    if (step !== 'next') {
      return step;
    }
  }
  return 'next';
}

/**
 * `source run`: one finite discovered batch, processed sequentially, with an
 * optional bound on fresh attempts.
 */
export async function runSource(
  context: SourceContext,
  limit: number | null,
): Promise<SourceSummary> {
  const state = emptyState();
  // The existing source/output preflight runs before any intake state exists: a
  // refused source checkout must leave no lock, no receipt, and no directory
  // (docs/architecture.md §8). Its Git readings are bounded by the finite
  // default and stopped when the intake is.
  try {
    await context.preflight({
      repoPath: context.repoPath,
      workDir: context.workDir,
      bounds: { stop: context.stop },
    });
  } catch (cause) {
    const cleanup = unconfirmedWorkspaceStop(state, cause, 'source preflight', context.stop);
    if (cleanup !== null)
      return summarize(cleanup === 'cancelled' ? 'cancelled' : 'stopped', state);
    if (context.stop.aborted) {
      return summarize('cancelled', state);
    }
    return summarize('stopped', {
      ...state,
      problem: `the source checkout was refused: ${messageOf(cause)}`,
    });
  }

  const lock = await acquireIntakeLock(context.workDir, context.lockNamespace, context.now);
  try {
    let candidates: readonly SourceCandidate[];
    try {
      candidates = await context.source.listEligible(context.stop);
    } catch (cause) {
      if (context.stop.aborted) {
        return summarize('cancelled', state);
      }
      return summarize('stopped', { ...state, problem: `discovery failed: ${messageOf(cause)}` });
    }

    const step = await processBatch(context, candidates, limit, state, null, 'batch');
    if (step === 'cancelled') {
      return summarize('cancelled', state);
    }
    // The batch is over; before the command reports it, the optional
    // review-to-completion pass reads the In Review items it may finish or
    // return. Its own outcome is reported beside the batch's and never replaces
    // it.
    await runCompletion(context, state);
    if (step === 'stop') {
      return summarize('stopped', state);
    }
    return summarize('completed', state);
  } finally {
    if (state.cleanupConfirmed) {
      await lock.release();
    } else {
      context.io.err(`the intake lock was left in place for inspection: ${lock.dir}`);
    }
  }
}

/** Whether one candidate's reference is the ticket a repair named. */
function sameTicket(ref: SourceRef, wanted: SourceRef): boolean {
  return ref.type === wanted.type && ref.scope === wanted.scope && ref.id === wanted.id;
}

/** What one `queue` consumer step asks for. */
export interface SourceTakeRequest {
  /**
   * The ticket a repair continues. Absent means a fresh eligibility scan, and
   * the first ticket the source's own configured order offers.
   */
  readonly only?: QueueTicket;
  /**
   * The caller already holds the intake lock. The serial queue holds one lock
   * for its whole invocation, so its steps must not take a second one for the
   * same output directory.
   */
  readonly lockHeld?: boolean;
}

/**
 * One `queue` consumer step: a fresh eligibility scan that takes **at most one**
 * ticket — the ticket `only` names, or the first one the source's own configured
 * order offers — and carries it through the coding attempt, the escalation
 * ladder, and the delivery step, exactly as a finite batch does.
 *
 * It is one step of a serial loop, so two things differ from a batch or a watch
 * scan. It never runs the review-to-completion pass: the queue loop owns the
 * order of the review and completion phases, and a pass run here would decide
 * them before that order exists. And it never skips past a ticket it will not
 * act on: a published refusal, a description that is not a usable task, a
 * reservation that already existed, an attempt that failed or whose stop was
 * not confirmed, a workspace ledger that could not be written, and a failed
 * delivery all come back as `attention` with what to fix, so the loop stops
 * instead of taking another ticket (docs/WORKFLOW.md §11).
 */
export async function takeOneItem(
  context: SourceContext,
  request: SourceTakeRequest = {},
): Promise<SourceTake> {
  const state = emptyState();
  const step = (outcome: SourceTake['outcome']): SourceTake => ({
    outcome,
    ticket: state.taken,
    run: state.takenRun,
    skipped: state.skipped,
    problem: state.problem,
    cleanupConfirmed: state.cleanupConfirmed,
  });

  // The same source/output preflight a finite batch runs, before any intake
  // state exists: a refused checkout leaves no lock, no receipt, and nothing
  // claimed. Its Git readings are bounded by the finite default and stopped
  // when the queue is.
  try {
    await context.preflight({
      repoPath: context.repoPath,
      workDir: context.workDir,
      bounds: { stop: context.stop },
    });
  } catch (cause) {
    const cleanup = unconfirmedWorkspaceStop(state, cause, 'queue preflight', context.stop);
    if (cleanup !== null) return step(cleanup === 'cancelled' ? 'cancelled' : 'attention');
    if (context.stop.aborted) return step('cancelled');
    stopWith(state, `the source checkout was refused: ${messageOf(cause)}`);
    return step('attention');
  }

  const lock =
    request.lockHeld === true
      ? null
      : await acquireIntakeLock(context.workDir, context.lockNamespace, context.now);
  try {
    let candidates: readonly SourceCandidate[];
    try {
      candidates = await context.source.listEligible(context.stop);
    } catch (cause) {
      if (context.stop.aborted) {
        return step('cancelled');
      }
      stopWith(state, `discovery failed: ${messageOf(cause)}`);
      return step('attention');
    }

    const only = request.only;
    const selected =
      only === undefined
        ? candidates
        : candidates.filter((candidate) => sameTicket(candidate.ref, only.ref));
    if (selected.length === 0) {
      return step('empty');
    }

    const outcome = await processBatch(context, selected, 1, state, null, 'single');
    if (outcome === 'cancelled') {
      return step('cancelled');
    }
    if (outcome === 'stop') {
      return step('attention');
    }
    // Reaching here with nothing reserved means every candidate was skipped:
    // it left the queue, its revision changed before the claim was sent, or it
    // was already claimed by somebody else. Nothing was run.
    return state.takenRun === null ? step('empty') : step('taken');
  } finally {
    if (lock !== null) {
      if (state.cleanupConfirmed) {
        await lock.release();
      } else {
        context.io.err(`the intake lock was left in place for inspection: ${lock.dir}`);
      }
    }
  }
}

/** The first backoff after a failed scan, in milliseconds. */
export const WATCH_BACKOFF_BASE_MS = 5_000;

/** The backoff cap, applied before any longer server-directed wait. */
export const WATCH_BACKOFF_CAP_MS = 5 * 60_000;

export interface SourceWatchOptions extends SourceContext {
  readonly pollIntervalMs: number;
}

/**
 * `source watch`: scan immediately, process that finite batch, wait, and repeat
 * until the caller stops it. New work waits in the source until the next scan,
 * and a scan never overlaps a batch: detection latency includes the active run
 * (docs/spec.md §6).
 *
 * Only read failures are retried, after an abortable wait that respects a
 * server-directed minimum. Authentication, authorization, malformed answers,
 * uncertain writes, and failed publication stop the loop instead.
 */
export async function watchSource(options: SourceWatchOptions): Promise<SourceSummary> {
  const { io, stop, sleep, pollIntervalMs } = options;
  const state = emptyState();
  const seenDiagnostics = new Map<string, string>();
  let backoffMs = WATCH_BACKOFF_BASE_MS;

  // As in a finite run, the preflight comes first: a refused source checkout
  // leaves no intake state behind. Its Git readings are bounded by the finite
  // default and stopped when the intake is.
  try {
    await options.preflight({
      repoPath: options.repoPath,
      workDir: options.workDir,
      bounds: { stop },
    });
  } catch (cause) {
    const cleanup = unconfirmedWorkspaceStop(state, cause, 'source preflight', stop);
    if (cleanup !== null)
      return summarize(cleanup === 'cancelled' ? 'cancelled' : 'stopped', state);
    if (stop.aborted) {
      return summarize('cancelled', state);
    }
    return summarize('stopped', {
      ...state,
      problem: `the source checkout was refused: ${messageOf(cause)}`,
    });
  }

  const lock = await acquireIntakeLock(options.workDir, options.lockNamespace, options.now);
  try {
    for (;;) {
      if (stop.aborted) {
        return summarize('cancelled', state);
      }

      let candidates: readonly SourceCandidate[];
      try {
        candidates = await options.source.listEligible(stop);
        backoffMs = WATCH_BACKOFF_BASE_MS;
      } catch (cause) {
        if (stop.aborted) {
          return summarize('cancelled', state);
        }
        if (cause instanceof SourceError && cause.kind === 'retryable-read') {
          const delay = Math.max(backoffMs, cause.retryAfterMs ?? 0);
          io.err(`scan failed (${cause.message}); retrying in ${String(delay)} ms`);
          backoffMs = Math.min(WATCH_BACKOFF_CAP_MS, backoffMs * 2);
          await sleep(delay, stop);
          continue;
        }
        return summarize('stopped', { ...state, problem: `discovery failed: ${messageOf(cause)}` });
      }

      if (candidates.length === 0) {
        io.out('scan: no eligible issues');
      }

      // A read that failed before anything was reserved (an issue read during
      // prepare) may be retried with the same backoff as discovery: nothing was
      // claimed and no receipt exists. Once a receipt does exist, the failure is
      // reported by `attempt` as the stop it is, and never retried here.
      let step: Step;
      try {
        step = await processBatch(options, candidates, null, state, seenDiagnostics, 'batch');
      } catch (cause) {
        if (stop.aborted) {
          return summarize('cancelled', state);
        }
        if (cause instanceof SourceError && cause.kind === 'retryable-read') {
          const delay = Math.max(backoffMs, cause.retryAfterMs ?? 0);
          io.err(`scan failed (${cause.message}); retrying in ${String(delay)} ms`);
          backoffMs = Math.min(WATCH_BACKOFF_CAP_MS, backoffMs * 2);
          await sleep(delay, stop);
          continue;
        }
        return summarize('stopped', { ...state, problem: `intake failed: ${messageOf(cause)}` });
      }
      if (step === 'cancelled') {
        return summarize('cancelled', state);
      }
      if (step === 'stop') {
        return summarize('stopped', state);
      }

      await runCompletion(options, state);
      if (stop.aborted) {
        return summarize('cancelled', state);
      }
      io.out(`scan complete; polling again in ${String(pollIntervalMs)} ms`);
      await sleep(pollIntervalMs, stop);
    }
  } finally {
    if (state.cleanupConfirmed) {
      await lock.release();
    } else {
      io.err(`the intake lock was left in place for inspection: ${lock.dir}`);
    }
  }
}
