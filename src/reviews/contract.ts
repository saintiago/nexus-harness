/**
 * The review boundary: the ordinary data the review path exchanges, and the
 * failures it acts on.
 *
 * A review scans the tickets one Jira connection reports as being in review,
 * identifies the one open pull request the ticket's workspace branch names, asks
 * the configured reviewer for a verdict, and publishes that verdict as a native
 * GitHub review plus one app-owned check run. Nothing here implements that: this
 * module declares data and shapes, performs no I/O, and imports no client beyond
 * type-only contracts.
 */
import type { SourceCandidate, SourceOutcome, SourceTask } from '../sources/contract.js';
import type { HistorySnapshot, TicketHistory } from '../history/contract.js';
import type { SourceRef, Task } from '../shared/types.js';

/**
 * How the review path failed, in the few categories the scan acts on.
 *
 * `credentials` and `auth` stop a batch: every ticket would fail the same way,
 * and no reviewer turn is worth starting. The others are per-ticket: the ticket
 * stays in review, nothing is published, and the next scan may succeed.
 */
export type ReviewProblemKind =
  /** The App's key path or key is missing, unreadable, or unusable. */
  | 'credentials'
  /** GitHub refused the App installation credentials. */
  | 'auth'
  /** The ticket names no pull request this scan can identify. */
  | 'missing-pr'
  /** More than one open pull request matches the ticket's branch. */
  | 'ambiguous-pr'
  /** The ticket or the pull request changed while it was being reviewed. */
  | 'stale'
  /** The reviewer turn failed, or its verdict was missing or unusable. */
  | 'inconclusive'
  /** A GitHub answer that was not usable, or a local evidence write that failed. */
  | 'api'
  /** Local evidence could not be written, or nothing could make progress. */
  | 'fatal';

/** A review that could not be completed. Nothing is published when one is thrown. */
export class ReviewError extends Error {
  readonly kind: ReviewProblemKind;
  /** A server-directed wait, in milliseconds, when the answer carried one. */
  readonly retryAfterMs: number | null;

  constructor(
    kind: ReviewProblemKind,
    message: string,
    parts: { readonly retryAfterMs?: number | null; readonly cause?: unknown } = {},
  ) {
    super(message, parts.cause === undefined ? undefined : { cause: parts.cause });
    this.name = 'ReviewError';
    this.kind = kind;
    this.retryAfterMs = parts.retryAfterMs ?? null;
  }
}

/** One open pull request, as the review path reads it. */
export interface OpenPullRequest {
  readonly number: number;
  /** Browser URL: what a review, a check run and a record link to. */
  readonly url: string;
  readonly title: string;
  /** The commit the review is made against, and what a later scan compares. */
  readonly headSha: string;
  /** The branch the head is on: the ticket's `harness/<workspaceId>` branch. */
  readonly headBranch: string;
  readonly baseBranch: string;
  /** The base branch's commit when GitHub last computed the pull request. */
  readonly baseSha: string;
  readonly draft: boolean;
  readonly author: string;
}

/** One native review of a pull request, as the list endpoint reports it. */
export interface PullRequestReview {
  readonly id: number;
  /** The login the review is authored as; a completed review by the App's login counts. */
  readonly login: string;
  /** GitHub's state: `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`, … */
  readonly state: string;
  /** The commit the review was made against; `null` when GitHub reports none. */
  readonly commitId: string | null;
  readonly url: string;
}

/** One entry of a pull request's whole conversation, as GitHub reports it. */
export interface PullRequestConversationEntry {
  readonly id: number;
  readonly kind: 'review' | 'comment' | 'review-comment';
  /** The login the entry is authored under. */
  readonly login: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly body: string;
  readonly url: string | null;
  /** A native review's state, or `null` for comments. */
  readonly state: string | null;
  /** The commit a review or an inline comment was made against, when GitHub reports one. */
  readonly commitId: string | null;
  /** The file an inline comment is positioned in, when it is one. */
  readonly path: string | null;
  /** The line in the new version of the file, when GitHub reports one. */
  readonly line: number | null;
  /**
   * The native review an inline comment belongs to, as GitHub reports its
   * `pull_request_review_id`. It maps the comment to the review the harness
   * published, so its finding is not kept twice.
   */
  readonly reviewId: number | null;
  /**
   * The inline comment this comment replies to, when it is a reply. A reply is
   * its own conversation and is never a mirrored finding.
   */
  readonly inReplyToId: number | null;
}

/**
 * A pull request's whole conversation: its native reviews, its conversation
 * comments, and its inline review comments, paginated and merged. `truncated`
 * says a page limit was reached; a partial conversation is never handed back as
 * if it were complete.
 */
export interface PullRequestConversation {
  readonly entries: readonly PullRequestConversationEntry[];
  readonly truncated: boolean;
}

/** The reviewer's decision. The two map to one native review event each. */
export type ReviewDecision = 'approve' | 'request_changes';

/** One finding the reviewer wrote: a path, an optional line, and the reason. */
export interface ReviewFinding {
  readonly path: string;
  /** Line in the new version of the file, or `null` for a whole-change finding. */
  readonly line: number | null;
  readonly body: string;
}

/** The verdict the reviewer turn must write, validated before anything is published. */
export interface ReviewVerdict {
  readonly decision: ReviewDecision;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

/** A completed turn can still lack the evidence needed for a native verdict. */
export interface InconclusiveReview {
  readonly decision: 'inconclusive';
  /** The missing evidence and what the coordinator needs to provide. */
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export type ReviewerVerdict = ReviewVerdict | InconclusiveReview;

/** One file of the pull request's diff, with the patch GitHub reports for it. */
export interface ChangedFile {
  readonly path: string;
  /** The unified patch, or `null` when GitHub reported none (binary or too large). */
  readonly patch: string | null;
  readonly additions: number;
  readonly deletions: number;
}

/** One check run or commit status observed at the reviewed head. */
export interface CheckEvidence {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/**
 * GitHub's own report of one pull request: the ticket, the pull request, the
 * changed files whose patches position a finding, and the CI evidence at the
 * reviewed head. It is what the reviewer turn is given about GitHub, and what
 * the record keeps; the change itself is read from the repository view below.
 */
export interface ReviewEvidence {
  readonly ref: SourceRef;
  readonly task: Task;
  readonly pullRequest: OpenPullRequest;
  /**
   * The changed files GitHub reports, bounded: each patch positions a finding
   * on the pull request's own diff. Empty means there is nothing to review.
   */
  readonly files: readonly ChangedFile[];
  /** True when the changed-file list was bounded; the scan must refuse a reviewer turn. */
  readonly truncated: boolean;
  /** Check runs reported for the reviewed head, bounded. */
  readonly checks: readonly CheckEvidence[];
  /** The combined commit status at the reviewed head, or `null` when none was read. */
  readonly combinedStatus: string | null;
  readonly fetchedAt: string;
}

/**
 * One review's repository view: a local clone of the ticket's retained
 * workspace, detached at the exact reviewed head and holding the change's base
 * commit, so a reviewer turn reads files, history and diffs with ordinary read
 * tools instead of receiving an assembled patch.
 */
export interface ReviewView {
  /** Where the view is checked out, inside the review's own evidence directory. */
  readonly path: string;
  /** The reviewed head the view is pinned at. */
  readonly head: string;
  /** The change's base commit, which the view holds so the change can be read. */
  readonly base: string;
}

/**
 * The scan's repository-view boundary: the local snapshot a reviewer turn
 * inspects. Production is the Git-backed `view.ts`, which reuses the workspace
 * module's bounded Git invocation; a test hands a fake the same way it fakes the
 * repository. The view is prepared from the retained workspace the ticket's
 * pointer names and never from a remote, so no App key and no publication token
 * enters it.
 */
export interface ReviewViewSource {
  /**
   * Prepares the view for one review inside its evidence directory, pinned at
   * `head` and holding `base`. Rejects with a {@link ReviewError} when no such
   * view can be prepared: an absent or unusable retained workspace, a head or
   * base commit that workspace does not hold, or a view that is not clean.
   */
  prepare(
    request: {
      readonly dir: string;
      readonly workspacePath: string;
      readonly head: string;
      readonly base: string;
    },
    stop: AbortSignal,
  ): Promise<ReviewView>;
  /**
   * Why the view is no longer a clean snapshot at the head it was pinned at, or
   * `null` when it still is. The scan checks this after the turn and publishes
   * nothing when it is not.
   */
  problem(view: ReviewView, stop: AbortSignal): Promise<string | null>;
}

/**
 * The read-only Jira side of one scan: the tickets the connection reports as
 * being in review, and one prepared ticket's task and pointer labels. It is the
 * existing `TaskSource` narrowed to what a review reads — a review claims
 * nothing, transitions nothing, and posts no comment.
 */
export interface ReviewQueue {
  list(stop: AbortSignal): Promise<readonly SourceCandidate[]>;
  prepare(candidate: SourceCandidate, stop: AbortSignal): Promise<SourceTask | null>;
}

/** One inline comment of a review, positioned in the pull request's diff. */
export interface ReviewComment {
  readonly path: string;
  /** Lines after the first hunk header: the first content line is position 1. */
  readonly position: number;
  readonly body: string;
}

/** What publishing one native review is asked for. */
export interface PublishReviewRequest {
  readonly pullRequest: OpenPullRequest;
  /** The reviewed head: the review is pinned to it, never to a later commit. */
  readonly head: string;
  readonly decision: ReviewDecision;
  readonly body: string;
  /** Comment lines that could be positioned in the diff; others stay in the body. */
  readonly comments: readonly ReviewComment[];
}

/** The native review GitHub recorded. */
export interface PublishedReview {
  readonly id: number;
  readonly url: string;
  readonly state: string;
}

/** What publishing the app-owned check run is asked for. */
export interface PublishCheckRequest {
  /** Update this existing app-owned check instead of creating a duplicate. */
  readonly checkRunId?: number;
  readonly head: string;
  readonly decision: ReviewDecision;
  readonly title: string;
  readonly summary: string;
  readonly detailsUrl: string | null;
}

/** The app-owned check run GitHub recorded. */
export interface PublishedCheck {
  readonly id: number;
  readonly url: string;
  readonly conclusion: string;
}

/** One app-owned check run at a head; pending runs have no conclusion. */
export interface AppCheckRun {
  readonly id: number;
  readonly conclusion: string | null;
  readonly url: string;
}

/**
 * Everything the review path needs from the configured repository. Production
 * is the GitHub App client; a test hands a fake the same way the Jira connector
 * is tested against a fake HTTP boundary.
 */
export interface ReviewRepository {
  /** The one open pull request whose head branch is `branch`, or `null`. */
  findOpenPullRequest(branch: string, stop: AbortSignal): Promise<OpenPullRequest | null>;
  /** The pull request as it is now: `null` when it is gone, closed, or merged. */
  readPullRequest(number: number, stop: AbortSignal): Promise<OpenPullRequest | null>;
  /** Every review of one pull request, oldest first. */
  listReviews(number: number, stop: AbortSignal): Promise<readonly PullRequestReview[]>;
  /**
   * The pull request's whole conversation, for the ticket history a turn reads
   * locally. It is optional so a caller without a configured App can still run
   * the other reads; a repository that cannot provide it leaves the history
   * with an explicit gap rather than an empty conversation.
   */
  readConversation?(number: number, stop: AbortSignal): Promise<PullRequestConversation>;
  /** The evidence a reviewer turn is given for one pull request. */
  readEvidence(
    request: {
      readonly ref: SourceRef;
      readonly task: Task;
      readonly pullRequest: OpenPullRequest;
    },
    stop: AbortSignal,
  ): Promise<ReviewEvidence>;
  publishReview(request: PublishReviewRequest, stop: AbortSignal): Promise<PublishedReview>;
  publishCheck(request: PublishCheckRequest, stop: AbortSignal): Promise<PublishedCheck>;
  /** The check runs this App published for one head, including pending runs. */
  reviewChecks(head: string, stop: AbortSignal): Promise<readonly AppCheckRun[]>;
}

/** What one reviewer turn is given: its own evidence directory and its view. */
export interface ReviewerTurnRequest {
  readonly dir: string;
  readonly evidence: ReviewEvidence;
  /** The repository view the turn inspects, prepared and checked by the scan. */
  readonly view: ReviewView;
  /**
   * The ticket's conversation snapshot, prepared by the scan before the turn:
   * the same organization and local paths a developer turn is given, so a
   * reviewer sees the ticket's own thread, earlier reviews, and the harness's
   * own reports without any connector call of its own.
   */
  readonly history?: HistorySnapshot;
  readonly stop: AbortSignal;
}

/**
 * What one reviewer turn produced. `verdict` is `null` exactly when `problem`
 * is not: a turn that did not complete, or whose verdict was missing or
 * unusable, has no verdict this scan may publish.
 */
export interface ReviewerTurnResult {
  /** The reviewer's own final message, or `null` when it gave none. */
  readonly summary: string | null;
  readonly verdict: ReviewerVerdict | null;
  readonly problem: string | null;
  /** The turn's own log file, kept beside its evidence. */
  readonly logPath: string;
}

/** The reviewer turn, as the scan uses it. Production runs the configured launch. */
export type ReviewerTurn = (request: ReviewerTurnRequest) => Promise<ReviewerTurnResult>;

/** What one scan did with one ticket. */
export type ReviewDisposition =
  /** The reviewer ran and its verdict was published as a review and a check. */
  | 'reviewed'
  /** The head already carries a completed review by the App; nothing ran. */
  | 'unchanged'
  /** Nothing was published and the ticket needs the coordinator's attention. */
  | 'attention'
  /** The ticket was no longer eligible when it was re-read. */
  | 'skipped';

/** What one candidate's review did, for the scan's own log and summary. */
export interface ReviewItemResult {
  readonly disposition: ReviewDisposition;
  readonly ref: SourceRef;
  readonly head: string | null;
  readonly decision: ReviewDecision | null;
  readonly reviewUrl: string | null;
  readonly checkUrl: string | null;
  /** Why the ticket needs attention, or what happened, in one line. */
  readonly detail: string;
  /** Set when the reviewer turn spent a paid launch. */
  readonly reviewerRun: boolean;
}

/** What one scan did, for the caller to print and to turn into an exit code. */
export interface ReviewSummary {
  readonly outcome: SourceOutcome;
  /**
   * What the scan did with each eligible ticket it considered, in the order it
   * considered them. A caller that narrowed the scan to one ticket — the serial
   * queue loop does — reads that ticket's own disposition and detail here
   * (docs/WORKFLOW.md §11).
   */
  readonly items: readonly ReviewItemResult[];
  /** Eligible tickets the scan considered. */
  readonly scanned: number;
  /** Tickets whose verdict was published as a review and a check. */
  readonly reviewed: number;
  readonly approved: number;
  readonly changesRequested: number;
  /** Tickets whose current head already carried a completed review. */
  readonly unchanged: number;
  /** Tickets that need the coordinator: no usable pull request, or no verdict. */
  readonly attention: number;
  /** Tickets that were no longer eligible when they were re-read. */
  readonly skipped: number;
  /** Paid reviewer turns the scan started. What one `--limit` counts. */
  readonly reviewerRuns: number;
  /** Why a scan or the watch stopped, when it did; `null` for a completed batch. */
  readonly problem: string | null;
}

/** Where one scan's io goes. A test passes a recorder. */
export interface ReviewIo {
  out(text: string): void;
  err(text: string): void;
}

/** Everything one scan or watch needs, as ordinary data and functions. */
export interface ReviewScanContext {
  readonly queue: ReviewQueue;
  readonly repository: ReviewRepository;
  readonly reviewer: ReviewerTurn;
  /**
   * The ticket conversation history this scan prepares before a reviewer turn,
   * when the caller configured one. A snapshot that cannot be prepared leaves
   * the ticket for attention instead of starting a turn whose promised local
   * history does not exist (docs/WORKFLOW.md §9 and §11).
   */
  readonly history?: TicketHistory;
  /**
   * How one review's repository view is prepared and checked afterwards: the
   * local snapshot, pinned at the reviewed head, that the reviewer inspects
   * instead of an assembled patch (`view.ts`).
   */
  readonly views: ReviewViewSource;
  /**
   * Scan only this ticket, when the caller named one. The serial queue loop
   * reviews exactly the ticket it is carrying, so a scan of the whole review
   * status can never start a reviewer turn for another one. Absent means every
   * ticket in the configured review status, exactly as before
   * (docs/WORKFLOW.md §11).
   */
  readonly only?: SourceRef;
  /** The output directory the review evidence and its log live under. */
  readonly workDir: string;
  /** Canonical connected project root, or null when the caller has no local project. */
  readonly sourceRoot: string | null;
  /** The App's review login: a completed review only counts when this login wrote it. */
  readonly login: string;
  /** The app-owned check run name the merge gate requires. */
  readonly checkName: string;
  /**
   * How long one reviewer turn may run before it is stopped, in milliseconds.
   * The reviewer launch is bounded like every other harness command.
   */
  readonly reviewerTimeoutMs: number;
  readonly io: ReviewIo;
  /** The caller's stop request: the interrupt that ends a watch. */
  readonly stop: AbortSignal;
  readonly now: () => Date;
  /** An abortable wait; resolves early when the stop request arrives. */
  readonly sleep: (ms: number, stop: AbortSignal) => Promise<void>;
}

/** One scan or watch with its poll interval. */
export interface ReviewWatchOptions extends ReviewScanContext {
  readonly pollIntervalMs: number;
}
