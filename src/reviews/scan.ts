/**
 * One review scan, and the watch that repeats it: which tickets are eligible,
 * which pull request each ticket's branch names, whether its head was already
 * reviewed, and what the reviewer's verdict becomes on GitHub.
 *
 * The scan is a bounded, sequential read of the tickets one Jira connection
 * reports as being in review. It never claims a ticket, never moves one, never
 * posts a Jira comment, and never runs a coding turn: it starts at most one
 * reviewer turn per ticket whose head carries no completed review yet, and it
 * publishes that verdict only after re-reading both the pull request's head and
 * the ticket. A ticket it cannot review — no identifiable pull request, a
 * changed head, a failed or inconclusive reviewer turn, a GitHub answer it could
 * not use — is reported and left exactly where it is, with no review, no check,
 * and no approval. Nothing here merges, and nothing marks an issue Done.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SourceCandidate, SourceTask } from '../sources/contract.js';
import { SourceError } from '../sources/contract.js';
import { messageOf } from '../shared/errors.js';
import type { SourceRef, Task } from '../shared/types.js';
import { workspaceIdProblem } from '../workspace/run-directory.js';
import type {
  OpenPullRequest,
  PublishedCheck,
  PublishedReview,
  ReviewDecision,
  ReviewDisposition,
  ReviewEvidence,
  ReviewFinding,
  ReviewItemResult,
  ReviewScanContext,
  ReviewSummary,
  ReviewVerdict,
  ReviewWatchOptions,
} from './contract.js';
import { ReviewError } from './contract.js';
import { positionFindings } from './diff.js';

/** How many review-directory collisions one allocation may skip before giving up. */
const MAX_REVIEW_ID_ATTEMPTS = 5;
/** How much of one log line the review log keeps. */
const MAX_LOG_LINE_CHARS = 400;
/** The scan's own append-only log, under `<workDir>/reviews`. */
export const REVIEW_LOG_FILE = 'review.log';
/** The record every reviewer attempt writes beside its evidence. */
export const REVIEW_RECORD_FILE = 'review.json';
/** The reviewer turn's own log file, as `reviewer.ts` names it too. */
const REVIEWER_LOG_FILE = 'reviewer.log';
/** The evidence file every reviewer attempt is given. */
const REVIEW_INPUT_FILE = 'input.md';

/** One reviewer attempt's own evidence directory. */
export interface ReviewDirectory {
  readonly reviewId: string;
  readonly dir: string;
}

/** A generated review ID: a UTC timestamp plus random bits, never ticket text. */
function newReviewId(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `review-${stamp}-${randomBytes(4).toString('hex')}`;
}

/** `<workDir>/reviews/<reviewId>`, created exclusively and never reused. */
export async function allocateReviewDirectory(workDir: string): Promise<ReviewDirectory> {
  const root = path.join(path.resolve(workDir), 'reviews');
  try {
    await mkdir(root, { recursive: true });
  } catch (cause) {
    throw new ReviewError(
      'fatal',
      `the review directory "${root}" could not be created: ${messageOf(cause)}`,
      { cause },
    );
  }
  for (let attempt = 1; attempt <= MAX_REVIEW_ID_ATTEMPTS; attempt += 1) {
    const reviewId = newReviewId();
    const dir = path.join(root, reviewId);
    try {
      await mkdir(dir);
      return { reviewId, dir };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw new ReviewError(
        'fatal',
        `the review directory "${dir}" could not be created: ${messageOf(cause)}`,
        { cause },
      );
    }
  }
  throw new ReviewError(
    'fatal',
    `no free review directory could be allocated under "${root}": existing directories are never ` +
      'reused or overwritten. Remove the ones you no longer need, or choose a different workDir.',
  );
}

/** One line of text, so ticket or check text cannot become a second line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `text`, flattened onto one bounded line. */
function logLine(text: string): string {
  const flat = oneLine(text);
  return flat.length <= MAX_LOG_LINE_CHARS ? flat : `${flat.slice(0, MAX_LOG_LINE_CHARS)}…`;
}

/** One line of the scan's own append-only log. Losing it never loses an outcome. */
async function appendReviewLog(context: ReviewScanContext, line: string): Promise<void> {
  const file = path.join(path.resolve(context.workDir), 'reviews', REVIEW_LOG_FILE);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${context.now().toISOString()} ${logLine(line)}\n`, 'utf8');
  } catch (cause) {
    context.io.err(`review log "${file}" could not be written: ${messageOf(cause)}`);
  }
}

/** Whether a failure ends the batch rather than one ticket. */
function stopsBatch(cause: unknown): boolean {
  if (cause instanceof ReviewError) {
    return cause.kind === 'credentials' || cause.kind === 'auth' || cause.kind === 'fatal';
  }
  if (cause instanceof SourceError) {
    return cause.kind === 'fatal' || cause.kind === 'uncertain-write';
  }
  return false;
}

/** A ticket the scan will not review, and why. */
function attention(
  ref: SourceRef,
  detail: string,
  head: string | null = null,
  reviewerRun = false,
): ReviewItemResult {
  return {
    disposition: 'attention',
    ref,
    head,
    decision: null,
    reviewUrl: null,
    checkUrl: null,
    detail,
    reviewerRun,
  };
}

/** What the reviewer's verdict means for one head, as the review list reported it. */
function decisionOf(reviewState: string): ReviewDecision {
  return reviewState === 'APPROVED' ? 'approve' : 'request_changes';
}

/** What one review attempt left, as its own `review.json` records it. */
interface ReviewRecord {
  readonly version: 1;
  readonly reviewId: string;
  readonly ref: SourceRef;
  readonly checkName: string;
  readonly login: string;
  readonly pullRequest: OpenPullRequest;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly disposition: ReviewDisposition;
  readonly verdict: ReviewDecision | null;
  readonly review: PublishedReview | null;
  readonly check: PublishedCheck | null;
  readonly problem: string | null;
  readonly reviewerLog: string | null;
  readonly input: string | null;
}

/** The review's body: the ticket link, the summary, and the unpositioned findings. */
function reviewBody(
  ref: SourceRef,
  task: Task,
  pullRequest: OpenPullRequest,
  verdict: ReviewVerdict,
  unpositioned: readonly ReviewFinding[],
): string {
  const lines = [
    `Nexus Lens review — ${ref.key}: ${oneLine(task.title)}`,
    ref.url,
    '',
    verdict.summary,
  ];
  if (verdict.findings.length === 0) {
    lines.push('', 'No blocking findings.');
  } else if (unpositioned.length > 0) {
    lines.push('', verdict.decision === 'approve' ? 'Notes:' : 'Findings:');
    for (const finding of unpositioned) {
      lines.push(
        `- ${finding.path}${finding.line === null ? '' : `:${String(finding.line)}`} — ` +
          finding.body,
      );
    }
  } else {
    lines.push('', 'See the inline findings on this review.');
  }
  lines.push(
    '',
    `Reviewed head ${pullRequest.headSha} of ${pullRequest.url}. This is a review only: Nexus Lens`,
    'does not implement fixes, merge, or change the issue’s status, and CI and the required',
    'checks stay separate merge requirements.',
  );
  return lines.join('\n');
}

/** The check run's one-line summary, bounded and explicit about the verdict. */
function checkSummary(ref: SourceRef, verdict: ReviewVerdict): string {
  const prefix = verdict.decision === 'approve' ? 'Approved' : 'Changes requested';
  return `${prefix} for ${ref.key}: ${oneLine(verdict.summary)}`;
}

/**
 * Reviews one prepared ticket. Every ticket-level failure becomes an attention
 * result; only the failures that would repeat for every ticket — missing App
 * credentials, a refused installation, an unusable local write — are thrown for
 * the scan to stop on.
 */
async function reviewItem(context: ReviewScanContext, item: SourceTask): Promise<ReviewItemResult> {
  const { ref } = item;
  const pointers = item.pointers;
  if (pointers.length === 0) {
    return attention(
      ref,
      'no pull request can be identified: the ticket carries no harness-ws-<workspaceId> pointer ' +
        'label naming the workspace whose branch its pull request was opened from',
    );
  }
  if (pointers.length > 1) {
    return attention(
      ref,
      `it names ${String(pointers.length)} workspaces (${pointers.join(', ')}), so which one holds ` +
        'its pull request cannot be guessed',
    );
  }
  const [workspaceId = ''] = pointers;
  const pointerProblem = workspaceIdProblem(workspaceId);
  if (pointerProblem !== null) {
    return attention(ref, pointerProblem);
  }
  const branch = `harness/${workspaceId}`;

  let pullRequest: OpenPullRequest | null;
  try {
    pullRequest = await context.repository.findOpenPullRequest(branch, context.stop);
  } catch (cause) {
    if (stopsBatch(cause)) {
      throw cause;
    }
    return attention(ref, messageOf(cause));
  }
  if (pullRequest === null) {
    return attention(
      ref,
      `no open pull request has the head branch "${branch}": if the work was never delivered, or ` +
        'its pull request was merged or closed, the coordinator decides what happens next',
    );
  }
  const head = pullRequest.headSha;

  try {
    const unchanged = await reviewIfDecided(context, item, pullRequest);
    return unchanged ?? (await reviewWithTurn(context, item, pullRequest));
  } catch (cause) {
    // A recognized source or review failure is this ticket's problem; anything
    // else is a programming error, and the scan stops rather than reporting it
    // as one ticket's verdict.
    if (stopsBatch(cause) || !(cause instanceof SourceError || cause instanceof ReviewError)) {
      throw cause;
    }
    return attention(ref, messageOf(cause), head);
  }
}

/**
 * The head's own native record: a completed review by the App's login, pinned
 * to this commit, is the one thing that makes another reviewer turn
 * unnecessary. A head that carries none is reviewed again — a new head is a new
 * review — and a head whose review exists but whose app-owned check is missing
 * gets the check it should already have had.
 */
async function reviewIfDecided(
  context: ReviewScanContext,
  item: SourceTask,
  pullRequest: OpenPullRequest,
): Promise<ReviewItemResult | null> {
  const head = pullRequest.headSha;
  const reviews = await context.repository.listReviews(pullRequest.number, context.stop);
  const decided = reviews.filter(
    (review) =>
      review.login === context.login &&
      review.commitId === head &&
      (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED'),
  );
  const latest = decided.at(-1);
  if (latest === undefined) {
    return null;
  }

  const decision = decisionOf(latest.state);
  const checks = await context.repository.reviewChecks(head, context.stop);
  if (checks.length > 0) {
    return {
      disposition: 'unchanged',
      ref: item.ref,
      head,
      decision,
      reviewUrl: latest.url,
      checkUrl: checks.at(-1)?.url ?? null,
      detail:
        `already reviewed at ${head} (${latest.state.toLowerCase().replace('_', ' ')}); no ` +
        'reviewer turn was started',
      reviewerRun: false,
    };
  }

  // The review exists; its app-owned check does not. Publishing the check from
  // the native review is how a scan repairs a half-published verdict, and it
  // never turns an unapproved head into an approved one.
  const check = await context.repository.publishCheck(
    {
      head,
      decision,
      title:
        decision === 'approve'
          ? `${context.checkName}: approved`
          : `${context.checkName}: changes requested`,
      summary:
        `Published from the existing review ${latest.url} for ${item.ref.key}: the head ${head} ` +
        `carried no "${context.checkName}" check run.`,
      detailsUrl: latest.url,
    },
    context.stop,
  );
  return {
    disposition: 'unchanged',
    ref: item.ref,
    head,
    decision,
    reviewUrl: latest.url,
    checkUrl: check.url,
    detail:
      `already reviewed at ${head}; published the missing "${context.checkName}" check ` +
      `(${check.conclusion}) from that review`,
    reviewerRun: false,
  };
}

/** Runs the reviewer turn for one head and publishes its verdict, or says why not. */
async function reviewWithTurn(
  context: ReviewScanContext,
  item: SourceTask,
  pullRequest: OpenPullRequest,
): Promise<ReviewItemResult> {
  const { ref } = item;
  const head = pullRequest.headSha;
  const reviewDir = await allocateReviewDirectory(context.workDir);
  const startedAt = context.now().toISOString();

  /** Writes the attempt's own `review.json`. A record that cannot be written stops the scan. */
  const writeRecord = async (parts: {
    readonly disposition: ReviewDisposition;
    readonly decision: ReviewDecision | null;
    readonly review: PublishedReview | null;
    readonly check: PublishedCheck | null;
    readonly problem: string | null;
    readonly reviewerRun: boolean;
  }): Promise<void> => {
    const body: ReviewRecord = {
      version: 1,
      reviewId: reviewDir.reviewId,
      ref,
      checkName: context.checkName,
      login: context.login,
      pullRequest,
      startedAt,
      endedAt: context.now().toISOString(),
      disposition: parts.disposition,
      verdict: parts.decision,
      review: parts.review,
      check: parts.check,
      problem: parts.problem,
      reviewerLog: parts.reviewerRun ? path.join(reviewDir.dir, REVIEWER_LOG_FILE) : null,
      input: parts.reviewerRun ? path.join(reviewDir.dir, REVIEW_INPUT_FILE) : null,
    };
    const file = path.join(reviewDir.dir, REVIEW_RECORD_FILE);
    try {
      await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    } catch (cause) {
      throw new ReviewError(
        'fatal',
        `the review record "${file}" could not be written: ${messageOf(cause)}`,
        { cause },
      );
    }
  };

  /** Records and returns one attention result for this attempt. */
  const attentionResult = async (
    detail: string,
    reviewerRun: boolean,
  ): Promise<ReviewItemResult> => {
    await writeRecord({
      disposition: 'attention',
      decision: null,
      review: null,
      check: null,
      problem: detail,
      reviewerRun,
    });
    return attention(ref, detail, head, reviewerRun);
  };

  let evidence: ReviewEvidence;
  try {
    evidence = await context.repository.readEvidence(
      { ref, task: item.task, pullRequest },
      context.stop,
    );
  } catch (cause) {
    if (stopsBatch(cause)) {
      throw cause;
    }
    return await attentionResult(
      `the evidence for ${ref.key} could not be read, so no reviewer turn was started: ` +
        messageOf(cause),
      false,
    );
  }
  if (evidence.files.length === 0) {
    return await attentionResult(
      `the pull request ${pullRequest.url} changes no files, so there is no diff to review; the ` +
        'coordinator decides what happens next',
      false,
    );
  }

  const turn = await context.reviewer({
    dir: reviewDir.dir,
    evidence,
    stop: AbortSignal.any([context.stop, AbortSignal.timeout(context.reviewerTimeoutMs)]),
  });
  if (turn.verdict === null) {
    return await attentionResult(turn.problem ?? 'the reviewer turn produced no verdict', true);
  }
  const verdict = turn.verdict;

  // The verdict belongs to the head it was made against: both the pull request
  // and the ticket are re-read before anything is published, and a head that
  // moved — or a ticket that left review — is never approved by a stale result.
  const current = await context.repository.readPullRequest(pullRequest.number, context.stop);
  if (current === null) {
    return await attentionResult(
      `the pull request ${pullRequest.url} is no longer open, so the verdict for ${head} was not ` +
        'published',
      true,
    );
  }
  if (current.headSha !== head) {
    return await attentionResult(
      `the head of ${pullRequest.url} moved from ${head} to ${current.headSha} while it was being ` +
        'reviewed, so nothing was published; a later scan reviews the new head',
      true,
    );
  }
  const rechecked = await context.queue.prepare(
    { ref: item.ref, title: item.task.title } satisfies SourceCandidate,
    context.stop,
  );
  if (rechecked === null) {
    return await attentionResult(
      `${ref.key} is no longer in the configured review status, so the verdict for ${head} was not ` +
        'published',
      true,
    );
  }

  const positioned = positionFindings(verdict.findings, evidence.files);
  let review: PublishedReview;
  try {
    review = await context.repository.publishReview(
      {
        pullRequest,
        head,
        decision: verdict.decision,
        body: reviewBody(ref, item.task, pullRequest, verdict, positioned.unpositioned),
        comments: positioned.comments,
      },
      context.stop,
    );
  } catch (cause) {
    if (stopsBatch(cause)) {
      throw cause;
    }
    return await attentionResult(
      `the review for ${ref.key} at ${head} was not published: ${messageOf(cause)}`,
      true,
    );
  }

  let check: PublishedCheck | null = null;
  let checkProblem: string | null = null;
  try {
    check = await context.repository.publishCheck(
      {
        head,
        decision: verdict.decision,
        title:
          verdict.decision === 'approve'
            ? `${context.checkName}: approved`
            : `${context.checkName}: changes requested`,
        summary: checkSummary(ref, verdict),
        detailsUrl: review.url,
      },
      context.stop,
    );
  } catch (cause) {
    checkProblem = messageOf(cause);
  }

  const approved = verdict.decision === 'approve';
  const detail =
    `${approved ? 'approved' : 'requested changes on'} ${head} (review ${review.url})` +
    (check === null
      ? `; the "${context.checkName}" check could not be published: ${checkProblem ?? 'unknown'}`
      : `; check ${check.url}`);
  const result: ReviewItemResult = {
    disposition: checkProblem === null ? 'reviewed' : 'attention',
    ref,
    head,
    decision: verdict.decision,
    reviewUrl: review.url,
    checkUrl: check?.url ?? null,
    detail,
    reviewerRun: true,
  };
  await writeRecord({
    disposition: result.disposition,
    decision: result.decision,
    review,
    check,
    problem: checkProblem,
    reviewerRun: true,
  });
  return result;
}

/** A summary of one scan, mutable while the scan runs. */
type MutableSummary = { -readonly [Key in keyof ReviewSummary]: ReviewSummary[Key] };

/** An empty summary of one scan. */
function emptySummary(outcome: ReviewSummary['outcome']): MutableSummary {
  return {
    outcome,
    scanned: 0,
    reviewed: 0,
    approved: 0,
    changesRequested: 0,
    unchanged: 0,
    attention: 0,
    skipped: 0,
    reviewerRuns: 0,
    problem: null,
  };
}

/** Adds one candidate's result to the scan's running counts. */
function countResult(summary: MutableSummary, result: ReviewItemResult): void {
  summary.scanned += 1;
  if (result.reviewerRun) {
    summary.reviewerRuns += 1;
  }
  if (result.disposition === 'reviewed') {
    summary.reviewed += 1;
    if (result.decision === 'approve') {
      summary.approved += 1;
    } else {
      summary.changesRequested += 1;
    }
    return;
  }
  if (result.disposition === 'unchanged') {
    summary.unchanged += 1;
    return;
  }
  if (result.disposition === 'skipped') {
    summary.skipped += 1;
    return;
  }
  summary.attention += 1;
}

/** Reports one candidate's result where the operator is watching, and in the log. */
async function reportResult(context: ReviewScanContext, result: ReviewItemResult): Promise<void> {
  const line = `${result.ref.key}: ${result.detail}`;
  if (result.disposition === 'attention') {
    context.io.err(line);
  } else {
    context.io.out(line);
  }
  await appendReviewLog(context, line);
}

/**
 * One finite scan: list the configured review status, prepare every ticket, and
 * give each one the review it needs. A `--limit` bounds the paid reviewer turns
 * one scan starts; tickets after the limit are left for the next scan or batch.
 */
export async function scanReviews(
  context: ReviewScanContext,
  limit?: number,
): Promise<ReviewSummary> {
  const summary = emptySummary('completed');
  const candidates = await context.queue.list(context.stop);

  for (const candidate of candidates) {
    if (context.stop.aborted) {
      summary.outcome = 'cancelled';
      return summary;
    }
    if (limit !== undefined && summary.reviewerRuns >= limit) {
      context.io.out(
        `review scan: --limit ${String(limit)} reached; the remaining eligible tickets are left ` +
          'for the next scan',
      );
      return summary;
    }

    let item: SourceTask | null;
    try {
      item = await context.queue.prepare(candidate, context.stop);
    } catch (cause) {
      if (stopsBatch(cause) || !(cause instanceof SourceError || cause instanceof ReviewError)) {
        throw cause;
      }
      const result = attention(candidate.ref, messageOf(cause));
      countResult(summary, result);
      await reportResult(context, result);
      continue;
    }
    if (item === null) {
      const result: ReviewItemResult = {
        disposition: 'skipped',
        ref: candidate.ref,
        head: null,
        decision: null,
        reviewUrl: null,
        checkUrl: null,
        detail: 'no longer eligible at the time of the scan',
        reviewerRun: false,
      };
      countResult(summary, result);
      await reportResult(context, result);
      continue;
    }

    let result: ReviewItemResult;
    try {
      result = await reviewItem(context, item);
    } catch (cause) {
      if (stopsBatch(cause) || !(cause instanceof SourceError || cause instanceof ReviewError)) {
        throw cause;
      }
      result = attention(item.ref, messageOf(cause));
    }
    countResult(summary, result);
    await reportResult(context, result);
  }
  return summary;
}

/**
 * Watch: scan, wait, and scan again until the caller stops it. A scan that
 * could not be made at all — Jira or GitHub unreachable — is reported and
 * retried after the poll interval; a missing App credential or a refused
 * installation stops the watch instead, because every later scan would fail the
 * same way.
 */
export async function watchReviews(options: ReviewWatchOptions): Promise<ReviewSummary> {
  let last = emptySummary('completed');
  for (;;) {
    try {
      last = await scanReviews(options);
    } catch (cause) {
      if (stopsBatch(cause)) {
        throw cause;
      }
      options.io.err(
        `review scan failed: ${messageOf(cause)}; the next scan will try again after the poll ` +
          'interval',
      );
    }
    if (options.stop.aborted || last.outcome === 'cancelled') {
      return { ...last, outcome: 'cancelled' };
    }
    await options.sleep(options.pollIntervalMs, options.stop);
  }
}
