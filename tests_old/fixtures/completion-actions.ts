/**
 * The in-memory completion boundary: an ordinary `CompletionActions` and
 * `CompletionSource` that answer from scripted state instead of starting a
 * command.
 *
 * The audit found the completion policy paying a real `gh` process for every
 * answer — including the pending checks a deadline case polls for thirty
 * seconds — so a decision that only needs a reading was starting processes that
 * a loaded host could not always finish inside the suite's own bound. What the
 * command boundary uniquely proves (the exact arguments, the credential split,
 * the evidence files on disk) stays on the real boundary in
 * tests/completion-github.test.ts and tests/completion-arm.test.ts; the policy
 * about deadlines, repetition and idempotency is decided here, where the
 * answers are values and the clock is the test's own.
 */

import type {
  AutoMergeStatus,
  CompletionActions,
  CompletionRequest,
  GateVerdict,
  MergeVerdict,
  PullRequestSnapshot,
} from '../../src/delivery/completion.js';
import { DeliveryError } from '../../src/delivery/github.js';
import type { WorkflowOutcome } from '../../src/delivery/gate.js';
import type { CompletionSource, IssueNote, ReviewItem } from '../../src/sources/jira/completion.js';
import type { SourceCandidate } from '../../src/sources/contract.js';
import { SourceError } from '../../src/sources/contract.js';
import type { SourceRef } from '../../src/shared/types.js';

/** One pull request as the in-memory GitHub reports it. */
export interface InMemoryPull {
  readonly number: number;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly branch: string;
  /** Whether it is still open; a merged pull request is not. */
  open: boolean;
  /** The merge GitHub has recorded, when it merged it. */
  mergeCommit: string | null;
  /** The native auto-merge request GitHub records for the head, when armed. */
  armedAt: string | null;
}

/** What one in-memory completion pair answers with, and what it recorded. */
export interface InMemoryCompletion {
  readonly actions: CompletionActions;
  readonly source: CompletionSource;
  /** Every request the pass made, in order, named by the call. */
  readonly githubCalls: string[];
  readonly jiraCalls: string[];
  /** The item the pass reads and writes. */
  readonly item: {
    status: string;
    readonly comments: { readonly id: string; readonly text: string }[];
    readonly pointers: readonly string[];
  };
  /** How many times one named call has been made so far. */
  calls(call: CompletionCall): number;
  /** What the gate answers next; the last answer repeats. */
  gates(gates: readonly GateVerdict[]): void;
  /** What GitHub reports about the merge. */
  merge(verdict: MergeVerdict): void;
  /**
   * What the item's own changelog says: whether it left the review status after
   * a comment. A person reopening a completed item is a new cycle, not a retry.
   */
  leftReviewSince(value: boolean): void;
  /**
   * Makes one named call fail from now on: `times` says how many consecutive
   * calls fail (every one of them when it is absent), `retryable` says whether
   * the failure is one a fresh read could still settle — a `5xx`, a rate limit, a
   * timeout — rather than a refusal GitHub meant. For `postComment`, `lands`
   * says the write arrived even though its answer did not.
   */
  fail(call: CompletionCall, failure?: Failure): void;
}

/** Every call the in-memory boundary answers. */
export type CompletionCall =
  | 'findPullRequest'
  | 'findMergedPullRequest'
  | 'readGate'
  | 'readApprovedHead'
  | 'readMerge'
  | 'enableAutoMerge'
  | 'listReview'
  | 'readItem'
  | 'listComments'
  | 'postComment'
  | 'moveTo';

/** One scripted failure, as the pass meets it. */
export interface Failure {
  /** How many of the next calls fail. Absent means every call until cleared. */
  readonly times?: number;
  /** How many calls answer normally before the failures begin. */
  readonly after?: number;
  /** Whether a fresh read could still settle it, as a `5xx` could. */
  readonly retryable?: boolean;
  readonly message?: string;
  /** For `postComment`: whether the write arrived although the answer did not. */
  readonly lands?: boolean;
}

/** One candidate and item for the same ticket. */
export function inMemoryCompletion(options: {
  readonly ref: SourceRef;
  readonly title?: string;
  readonly pointers?: readonly string[];
  readonly status?: string;
  readonly pull: InMemoryPull;
  readonly gate: GateVerdict;
  readonly reviewedHeads?: readonly (string | null)[];
}): InMemoryCompletion {
  const item = {
    status: options.status ?? 'In Review',
    comments: [] as { id: string; text: string }[],
    pointers: options.pointers ?? ['run-1'],
  };
  const pull = options.pull;
  const candidate: SourceCandidate = { ref: options.ref, title: options.title ?? 'a ticket' };
  const githubCalls: string[] = [];
  const jiraCalls: string[] = [];

  let gates: readonly GateVerdict[] = [options.gate];
  let gateIndex = 0;
  let mergeVerdict: MergeVerdict = {
    status: 'pending',
    reason: 'GitHub has not merged this pull request yet',
    mergeCommit: null,
    workflows: [],
  };
  let reviewedHeads: readonly (string | null)[] = options.reviewedHeads ?? [pull.head];
  let reviewedIndex = 0;
  let nextComment = 1;
  let leftReview = false;
  const counts = new Map<CompletionCall, number>();
  const failures = new Map<CompletionCall, { left: number; skip: number; failure: Failure }>();

  /** Counts one call, then answers whether the script makes it fail instead. */
  const met = (call: CompletionCall): Failure | null => {
    counts.set(call, (counts.get(call) ?? 0) + 1);
    const scripted = failures.get(call);
    if (scripted === undefined) {
      return null;
    }
    if (scripted.skip > 0) {
      scripted.skip -= 1;
      return null;
    }
    scripted.left -= 1;
    if (scripted.left <= 0) {
      failures.delete(call);
    }
    return scripted.failure;
  };

  const refuse = (call: CompletionCall, failure: Failure): never => {
    throw new DeliveryError(failure.message ?? `${call} is unavailable (HTTP 503)`, {
      retryable: failure.retryable === true,
    });
  };

  const snapshot = (): PullRequestSnapshot => ({
    number: pull.number,
    url: pull.url,
    state: pull.open ? 'OPEN' : pull.mergeCommit === null ? 'CLOSED' : 'MERGED',
    isDraft: false,
    headRefName: pull.branch,
    baseRefName: pull.base,
    headRefOid: pull.head,
    autoMergeRequest: pull.armedAt === null ? null : { enabledAt: pull.armedAt },
    mergeable: 'MERGEABLE',
    title: 'the delivered change',
    body: 'what the change does',
    mergeCommit: pull.mergeCommit === null ? null : { oid: pull.mergeCommit },
  });

  const actions: CompletionActions = {
    findPullRequest: async (request: CompletionRequest): Promise<PullRequestSnapshot | null> => {
      githubCalls.push(`findPullRequest:${request.branch}`);
      const failed = met('findPullRequest');
      if (failed !== null) refuse('findPullRequest', failed);
      return pull.open ? snapshot() : null;
    },
    findMergedPullRequest: async (): Promise<PullRequestSnapshot> => {
      githubCalls.push('findMergedPullRequest');
      const failed = met('findMergedPullRequest');
      if (failed !== null) refuse('findMergedPullRequest', failed);
      return snapshot();
    },
    readGate: async (): Promise<GateVerdict> => {
      githubCalls.push('readGate');
      const failed = met('readGate');
      if (failed !== null) refuse('readGate', failed);
      const answer = gates[Math.min(gateIndex, gates.length - 1)] ?? options.gate;
      gateIndex += 1;
      return answer;
    },
    readApprovedHead: async (): Promise<string | null> => {
      githubCalls.push('readApprovedHead');
      const failed = met('readApprovedHead');
      if (failed !== null) refuse('readApprovedHead', failed);
      const answer = reviewedHeads[Math.min(reviewedIndex, reviewedHeads.length - 1)] ?? null;
      reviewedIndex += 1;
      return answer;
    },
    readMerge: async (): Promise<MergeVerdict> => {
      githubCalls.push('readMerge');
      const failed = met('readMerge');
      if (failed !== null) refuse('readMerge', failed);
      return mergeVerdict;
    },
    enableAutoMerge: async (): Promise<AutoMergeStatus> => {
      githubCalls.push('enableAutoMerge');
      const failed = met('enableAutoMerge');
      const already = pull.armedAt !== null;
      if (failed === null || failed.lands === true) {
        pull.armedAt = pull.armedAt ?? '2026-09-20T12:00:00.000Z';
      }
      if (failed !== null) refuse('enableAutoMerge', failed);
      return already ? 'already-enabled' : 'enabled';
    },
  };

  const source: CompletionSource = {
    listReview: async (): Promise<readonly SourceCandidate[]> => {
      jiraCalls.push('listReview');
      const failed = met('listReview');
      if (failed !== null) refuse('listReview', failed);
      return item.status === 'In Review' ? [candidate] : [];
    },
    readItem: async (): Promise<ReviewItem | null> => {
      jiraCalls.push('readItem');
      const failed = met('readItem');
      if (failed !== null) refuse('readItem', failed);
      if (item.status !== 'In Review') {
        return null;
      }
      return {
        ref: options.ref,
        title: candidate.title,
        statusName: item.status,
        pointers: item.pointers,
      };
    },
    listComments: async (): Promise<readonly IssueNote[]> => {
      jiraCalls.push('listComments');
      const failed = met('listComments');
      if (failed !== null) refuse('listComments', failed);
      return item.comments.map((comment, index) => ({
        id: comment.id,
        createdAt: new Date(Date.parse('2026-09-20T12:00:00.000Z') + index * 1_000).toISOString(),
        text: comment.text,
      }));
    },
    leftReviewSince: async (): Promise<boolean> => {
      jiraCalls.push('leftReviewSince');
      return leftReview;
    },
    postComment: async (_id: string, paragraphs: readonly string[]): Promise<string> => {
      jiraCalls.push('postComment');
      const failed = met('postComment');
      const id = `comment-${String(nextComment++)}`;
      if (failed === null || failed.lands === true) {
        item.comments.push({ id, text: paragraphs.join('\n\n') });
      }
      if (failed !== null) refuse('postComment', failed);
      return id;
    },
    moveTo: async (
      _id: string,
      target: string,
      _stop?: AbortSignal,
      beforeWrite?: () => Promise<boolean>,
    ): Promise<'moved' | 'left-alone'> => {
      jiraCalls.push(`moveTo:${target}`);
      // The guard the caller hands the move is part of the move: it re-reads
      // the live state, and a failure of its own is the move's failure.
      if (beforeWrite !== undefined && !(await beforeWrite())) {
        return 'left-alone';
      }
      const failed = met('moveTo');
      // A write whose answer was lost may still have landed: `lands` says Jira
      // performed the transition and the answer never arrived.
      if (failed !== null && failed.lands !== true) refuse('moveTo', failed);
      if (item.status !== 'In Review') {
        return 'left-alone';
      }
      item.status = target;
      if (failed !== null) refuse('moveTo', failed);
      return 'moved';
    },
  };

  return {
    actions,
    source,
    githubCalls,
    jiraCalls,
    item,
    calls: (call) => counts.get(call) ?? 0,
    fail: (call, failure = {}) => {
      failures.set(call, {
        left: failure.times ?? Number.POSITIVE_INFINITY,
        skip: failure.after ?? 0,
        failure,
      });
    },
    gates: (answers) => {
      gates = answers;
      gateIndex = 0;
    },
    merge: (verdict) => {
      mergeVerdict = verdict;
    },
    leftReviewSince: (value) => {
      leftReview = value;
    },
  };
}

/** A gate answer that is still pending, as one check list reports it. */
export function pendingGate(reason = 'the required check Nexus Lens is pending'): GateVerdict {
  return { status: 'pending', reason, review: null, findings: [] };
}

/** A gate answer that passed, with the approval that let the path proceed. */
export function approvedGate(head: string): GateVerdict {
  return {
    status: 'approved',
    reason: 'GitHub reports the current head approved',
    review: {
      id: '555',
      author: 'nexus-lens',
      state: 'APPROVED',
      body: 'Nexus Lens review\n\nlooks right to me',
      commitId: head,
      url: `${head}#pullrequestreview-555`,
    },
    findings: [],
  };
}

/** A merge reading with every configured workflow still running. */
export function workflowsPending(
  mergeCommit: string,
  workflows: readonly WorkflowOutcome[],
): MergeVerdict {
  return {
    status: 'workflows-pending',
    reason: 'the configured post-merge workflows have not finished',
    mergeCommit,
    workflows,
  };
}

/** A source that cannot read its own item, as a Jira outage reports it. */
export function unreadableSource(reason = 'Jira returned HTTP 503'): CompletionSource {
  return {
    listReview: async () => {
      throw new SourceError('retryable-read', reason);
    },
    readItem: async () => {
      throw new SourceError('retryable-read', reason);
    },
    listComments: async () => {
      throw new SourceError('retryable-read', reason);
    },
    leftReviewSince: async () => {
      throw new SourceError('retryable-read', reason);
    },
    postComment: async () => {
      throw new SourceError('retryable-read', reason);
    },
    moveTo: async () => {
      throw new SourceError('retryable-read', reason);
    },
  };
}
