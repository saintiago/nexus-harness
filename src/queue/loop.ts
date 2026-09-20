/**
 * The serial queue control loop: one current ticket, one phase at a time.
 *
 * ```text
 * fresh scan -> take at most one ticket -> coding attempt -> delivery
 *      ^                                        |
 *      |                    review (Nexus Lens) v
 *      |                              completion (merge + post-merge CI)
 *      |                                   |            |
 *      |            Done: source readiness  |            |  To Do: repair the same ticket
 *      +-----------------------------------+            +--> back to the coding attempt
 * ```
 *
 * It owns sequencing and nothing else: every phase is an ordinary function the
 * CLI composed from the modules that already implement it (the Jira intake
 * coordinator, the GitHub delivery step, the Nexus Lens review scan, the
 * review-to-completion pass, and the source-readiness step). This module starts
 * no agent of its own, imports no connector, holds no state across invocations,
 * and never caches or pre-reserves a batch: after a ticket is confirmed Done it
 * asks for a fresh eligibility scan, and in watch mode it waits — visibly, as
 * the foreground process — for the next one.
 *
 * Everything that is not a confirmed completion stops the loop with an
 * actionable result: a failed coding attempt, a review or completion that needs
 * a person, a pending completion the pass's own deadline did not resolve, and a
 * source checkout that cannot be proven ready. The blocked ticket is never
 * skipped for another one, and an interrupt stops waiting or the active bounded
 * phase without starting anything new (docs/WORKFLOW.md §11).
 */
import type { RunStatus } from '../shared/types.js';
import { messageOf } from '../shared/errors.js';
import type { QueueTicket, SourceTake } from '../sources/contract.js';

export type { QueueTicket } from '../sources/contract.js';

/** Where the loop's own progress goes. Tests pass a recorder. */
export interface QueueIo {
  out(text: string): void;
  err(text: string): void;
}

/** What the review phase did with the current ticket. */
export type QueueReviewOutcome =
  /** The ticket's current head now carries the reviewer's completed verdict. */
  | { readonly state: 'clear'; readonly detail: string }
  /** The review could not be completed, or needs a person before it can be. */
  | { readonly state: 'attention'; readonly detail: string }
  | { readonly state: 'cancelled'; readonly detail: string };

/**
 * What the completion phase did with the current ticket.
 *
 * `done` and `to-do` are the pass's own confirmed status moves: a merge and
 * every configured post-merge workflow succeeded, or a conclusive finding
 * returned the item to the To Do status with its workspace pointer preserved.
 * `pending` means nothing was concluded yet and a later reading may conclude it.
 * `attention` is everything a person has to decide.
 */
export type QueueCompletionOutcome =
  | {
      readonly state: 'done';
      readonly detail: string;
      /** The merge commit the completion path verified; `null` when it named none. */
      readonly mergeCommit: string | null;
    }
  | { readonly state: 'to-do'; readonly detail: string }
  | { readonly state: 'pending'; readonly detail: string }
  | { readonly state: 'attention'; readonly detail: string }
  | { readonly state: 'cancelled'; readonly detail: string };

/**
 * Everything one queue invocation needs, as ordinary functions and values.
 *
 * `consume` is the existing source intake, narrowed to at most one ticket;
 * `review`, `complete` and `ready` are the existing Nexus Lens scan, the
 * existing review-to-completion pass, and the source-readiness step, each
 * narrowed to the one current ticket. The loop itself decides only the order.
 */
export interface QueueLoopContext {
  readonly io: QueueIo;
  /** The invocation's own stop request: the user's interrupt. */
  readonly stop: AbortSignal;
  /** An abortable wait; resolves early when the stop request arrives. */
  readonly sleep: (ms: number, stop: AbortSignal) => Promise<void>;
  /** How long watch waits between two fresh eligibility scans. */
  readonly pollIntervalMs: number;
  /** How long the loop waits between two readings of a pending completion. */
  readonly completionPollIntervalMs: number;
  /**
   * Take at most one ticket and carry it through the coding attempt and its
   * delivery. `only` names the ticket a repair must continue; `null` asks for a
   * fresh eligibility scan, in the source's own priority order.
   */
  readonly consume: (request: { readonly only: QueueTicket | null }) => Promise<SourceTake>;
  /** Review the current ticket's pull request with the configured reviewer. */
  readonly review: (request: { readonly ticket: QueueTicket }) => Promise<QueueReviewOutcome>;
  /** Carry the current ticket's delivered pull request to Done or back to To Do. */
  readonly complete: (request: { readonly ticket: QueueTicket }) => Promise<QueueCompletionOutcome>;
  /**
   * Prepare the local target repository for the next workspace: the configured
   * base branch, the expected delivery repository, a clean checkout, and only a
   * fast-forward to the verified merge commit. It throws with what to fix.
   */
  readonly ready: (request: {
    readonly ticket: QueueTicket;
    readonly mergeCommit: string;
  }) => Promise<void>;
}

/** Which operation one invocation is: `queue run` or `queue watch`. */
export type QueueRunMode = 'run' | 'watch';

/** What one queue invocation did. */
export interface QueueSummary {
  readonly outcome: 'completed' | 'stopped' | 'cancelled';
  /** Tickets carried all the way to the configured Done status. */
  readonly completed: number;
  /** Coding attempts this invocation started, repairs included. */
  readonly attempts: number;
  /** Why a person is needed, when the loop stopped for one; `null` otherwise. */
  readonly problem: string | null;
  /** The ticket the loop stopped, was cancelled, or is idle behind. */
  readonly ticket: QueueTicket | null;
  /**
   * Whether everything this invocation started was confirmed stopped. `false`
   * means a working copy may still be written to, so the caller leaves the
   * intake lock in place for inspection instead of releasing it
   * (docs/spec.md §6).
   */
  readonly cleanupConfirmed: boolean;
}

/** One phrase for how a consumer step ended without taking a usable ticket. */
function describeTake(take: SourceTake): string {
  if (take.problem !== null) {
    return take.problem;
  }
  if (take.outcome === 'empty') {
    return 'there was no eligible ticket';
  }
  return 'the consumer stopped without reporting why';
}

/** How a run that is not a pass is reported, with the evidence it kept. */
function describeRun(ticket: QueueTicket, status: RunStatus, run: SourceTakeRunView): string {
  return (
    `${ticket.ref.key}: the coding attempt ended ${status} (${run.reason}) and needs a person ` +
    `before the queue continues. Its evidence is kept: report ${run.reportPath}` +
    (run.pullRequest === null ? '' : `, pull request ${run.pullRequest.url}`) +
    '. The queue does not skip the ticket for another one.'
  );
}

/** The parts of a taken run this module reads, named once for readability. */
type SourceTakeRunView = NonNullable<SourceTake['run']>;

/**
 * One serial queue invocation: `run` drains the queue the way a finite batch
 * does, and `watch` stays a foreground process that waits for the next eligible
 * ticket. Neither starts a second consumer, and neither starts an agent while it
 * is waiting.
 */
export async function runQueue(
  context: QueueLoopContext,
  mode: QueueRunMode,
): Promise<QueueSummary> {
  const { io, stop, sleep } = context;
  let completed = 0;
  let attempts = 0;
  let active: QueueTicket | null = null;
  let cleanupConfirmed = true;

  const cancelled = (): QueueSummary => ({
    outcome: 'cancelled',
    completed,
    attempts,
    problem: null,
    ticket: active,
    cleanupConfirmed,
  });
  const stopped = (problem: string): QueueSummary => ({
    outcome: 'stopped',
    completed,
    attempts,
    problem,
    ticket: active,
    cleanupConfirmed,
  });

  for (;;) {
    if (stop.aborted) {
      return cancelled();
    }

    // A fresh eligibility scan, in the source's own order. At most one ticket
    // comes out of it; nothing is cached and nothing is pre-reserved.
    const take = await context.consume({ only: null });
    cleanupConfirmed = cleanupConfirmed && take.cleanupConfirmed;
    if (stop.aborted || take.outcome === 'cancelled') {
      return cancelled();
    }
    if (take.outcome === 'attention') {
      active = take.ticket;
      return stopped(describeTake(take));
    }
    if (take.outcome === 'empty') {
      if (mode === 'run') {
        io.out(
          completed === 0
            ? 'queue run: no eligible ticket; nothing was claimed and no run was started'
            : `queue run: no further eligible ticket after ${String(completed)} completed; the ` +
                'queue is drained',
        );
        return {
          outcome: 'completed',
          completed,
          attempts,
          problem: null,
          ticket: null,
          cleanupConfirmed,
        };
      }
      io.out(
        `queue idle: no eligible ticket. Waiting ${String(pollSeconds(context.pollIntervalMs))}s ` +
          'and scanning again; no agent runs while the queue is idle.',
      );
      await sleep(context.pollIntervalMs, stop);
      continue;
    }

    const ticket = take.ticket;
    const run = take.run;
    active = ticket;
    if (ticket === null || run === null) {
      return stopped(
        'the consumer reported a ticket without saying how its attempt ended, so the queue cannot ' +
          'tell whether its work is finished',
      );
    }
    attempts += 1;
    io.out(
      `${ticket.ref.key}: reserved and run ${run.runId} ended ${run.status} (${run.reason})` +
        (run.pullRequest === null ? '' : `; delivered as ${run.pullRequest.url}`),
    );
    if (run.status === 'cancelled') {
      if (stop.aborted) {
        return cancelled();
      }
      return stopped(describeRun(ticket, run.status, run));
    }
    if (run.status !== 'passed') {
      return stopped(describeRun(ticket, run.status, run));
    }

    // The current ticket's serial lifecycle. Only a confirmed Done ends it; a
    // conclusive finding returns to this same ticket before any fresh scan.
    for (;;) {
      const review = await context.review({ ticket });
      if (stop.aborted || review.state === 'cancelled') {
        return cancelled();
      }
      if (review.state === 'attention') {
        return stopped(`${ticket.ref.key}: the review needs a person: ${review.detail}`);
      }
      io.out(`${ticket.ref.key}: ${review.detail}`);

      let completion = await context.complete({ ticket });
      while (completion.state === 'pending') {
        if (stop.aborted) {
          return cancelled();
        }
        io.out(
          `${ticket.ref.key}: ${completion.detail}; reading GitHub again in ` +
            `${String(pollSeconds(context.completionPollIntervalMs))}s`,
        );
        await sleep(context.completionPollIntervalMs, stop);
        if (stop.aborted) {
          return cancelled();
        }
        completion = await context.complete({ ticket });
      }
      if (stop.aborted || completion.state === 'cancelled') {
        return cancelled();
      }
      if (completion.state === 'attention') {
        return stopped(
          `${ticket.ref.key}: the completion path needs a person: ${completion.detail}`,
        );
      }

      if (completion.state === 'done') {
        if (completion.mergeCommit === null) {
          return stopped(
            `${ticket.ref.key}: the completion path reported the ticket done without naming the ` +
              'merge commit, so the local checkout cannot be shown to start from the completed ' +
              'work and the queue will not claim another ticket',
          );
        }
        try {
          await context.ready({ ticket, mergeCommit: completion.mergeCommit });
        } catch (cause) {
          if (stop.aborted) {
            return cancelled();
          }
          return stopped(
            `${ticket.ref.key}: the next workspace is not ready, so the queue stops before ` +
              `claiming another ticket: ${messageOf(cause)}`,
          );
        }
        if (stop.aborted) {
          return cancelled();
        }
        completed += 1;
        io.out(
          `${ticket.ref.key}: ${completion.detail}. The local base branch is ready for the next ` +
            'workspace; the queue scans again.',
        );
        break;
      }

      // To Do: this same ticket goes back through the bounded runner and the
      // escalation ladder in its preserved workspace, before any unrelated
      // ready work is considered.
      io.out(`${ticket.ref.key}: back for repair: ${completion.detail}`);
      const repair = await context.consume({ only: ticket });
      cleanupConfirmed = cleanupConfirmed && repair.cleanupConfirmed;
      if (stop.aborted || repair.outcome === 'cancelled') {
        return cancelled();
      }
      if (repair.outcome === 'attention') {
        return stopped(describeTake(repair));
      }
      if (repair.outcome === 'empty') {
        return stopped(
          `${ticket.ref.key}: it was returned for repair, but it is no longer eligible in the ready ` +
            `status, so the queue will not claim another ticket: ${describeTake(repair)}`,
        );
      }
      const repaired = repair.run;
      if (repaired === null) {
        return stopped(
          `${ticket.ref.key}: the repair attempt produced no run of its own, so nothing about it ` +
            'can be reported',
        );
      }
      attempts += 1;
      io.out(
        `${ticket.ref.key}: repair run ${repaired.runId} ended ${repaired.status} ` +
          `(${repaired.reason})` +
          (repaired.pullRequest === null ? '' : `; delivered as ${repaired.pullRequest.url}`),
      );
      if (repaired.status === 'cancelled') {
        if (stop.aborted) {
          return cancelled();
        }
        return stopped(describeRun(ticket, repaired.status, repaired));
      }
      if (repaired.status !== 'passed') {
        return stopped(describeRun(ticket, repaired.status, repaired));
      }
      // The repair delivered a new head: review that one, and so on until the
      // ticket is confirmed Done or something needs a person.
    }
  }
}

/** A configured wait, in whole seconds, for the loop's own status lines. */
function pollSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}
