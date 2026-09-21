/**
 * The issue's own thread and the comments the harness posts: the compact result
 * comment, the refusal that takes an unclaimed item out of the queue, and the
 * attention record for an item that was claimed and could not be started.
 *
 * A comment carries no transcript, diff, environment, or credential. A result
 * is published before the issue is moved, and an acknowledged comment is
 * recorded even when the status change after it fails. What a turn is told of
 * the thread is bounded by the coordinator.
 */
import type { JiraSourceConfig, SourceRef } from '../../shared/types.js';
import { SourceFeedbackError } from '../contract.js';
import type { SourceComment, SourceRunOutcome, SourceTask } from '../contract.js';
import { parseDescription } from './adf.js';
import { buildCommentDocument, renderDescription } from './adf-text.js';
import { diagnosticOf } from './http.js';
import type { HttpClient } from './http.js';
import { malformed, readIssue, sameName } from './issue.js';
import type { JiraIssue } from './issue.js';
import { isRecord, nested, stringField } from './json.js';
import { developerHistoryMarker } from '../../history/marker.js';
import { postTransition, readTransitions, selectTransition } from './transitions.js';

/** How many comments one request may return, and how many pages are followed. */
const COMMENT_PAGE_SIZE = 100;
/**
 * How many pages the history read follows. It is higher than the guidance
 * read's bound because the history is the complete local record, and a page
 * limit that is reached is reported rather than presented as the whole thread.
 */
const THREAD_PAGE_LIMIT = 50;

/** One comment of the issue's own thread, with the identity a later read matches. */
export interface JiraThreadComment {
  readonly id: string;
  readonly author: string;
  readonly createdAt: string;
  /** When the comment was last edited; Jira reports the write time either way. */
  readonly updatedAt: string | null;
  readonly text: string;
}

/** One whole thread read: the comments, and whether more pages remained. */
export interface JiraCommentThread {
  readonly comments: readonly JiraThreadComment[];
  readonly truncated: boolean;
}

/**
 * Every comment of one issue's thread, oldest first, whole and with its own
 * identity. Pagination follows `startAt`/`total` as the connector always has,
 * and a page limit that is reached is reported by `truncated`: a partial thread
 * is never handed back as if it were the whole conversation.
 */
export async function readCommentThread(
  http: HttpClient,
  token: string,
  id: string,
  key: string,
  stop: AbortSignal,
): Promise<JiraCommentThread> {
  const comments: JiraThreadComment[] = [];
  let startAt = 0;
  let truncated = false;

  for (let page = 0; page < THREAD_PAGE_LIMIT; page += 1) {
    const answer = await http.request({
      method: 'GET',
      path:
        `/rest/api/3/issue/${encodeURIComponent(id)}/comment` +
        `?startAt=${String(startAt)}&maxResults=${String(COMMENT_PAGE_SIZE)}`,
      signal: stop,
    });
    if (!isRecord(answer) || !Array.isArray(answer['comments'])) {
      throw malformed(`the comments of issue ${id}`, 'no comments array');
    }
    const raw = answer['comments'];
    for (const value of raw) {
      if (!isRecord(value)) {
        throw malformed(`the comments of issue ${id}`, 'a comment is not an object');
      }
      const commentId = stringField(value, 'id');
      if (commentId === null) {
        throw malformed(`the comments of issue ${id}`, 'a comment carries no id');
      }
      const created = stringField(value, 'created');
      if (created === null) {
        throw malformed(
          `the comments of issue ${id}`,
          `comment ${commentId} carries no created instant`,
        );
      }
      const author = nested(value, 'author');
      const updated = stringField(value, 'updated');
      comments.push({
        id: commentId,
        author: (author === null ? null : stringField(author, 'displayName')) ?? 'unknown',
        createdAt: created,
        updatedAt: updated !== null && updated !== created ? updated : null,
        text: renderCommentBody(value['body'], key, token),
      });
    }
    const total = typeof answer['total'] === 'number' ? answer['total'] : startAt + raw.length;
    startAt += raw.length;
    if (raw.length === 0 || startAt >= total) {
      truncated = startAt < total;
      break;
    }
    if (page === THREAD_PAGE_LIMIT - 1) {
      truncated = true;
    }
  }

  return { comments, truncated };
}
/** One comment, posted as ordinary ADF paragraphs. */
async function postComment(
  http: HttpClient,
  id: string,
  paragraphs: readonly string[],
  stop: AbortSignal,
): Promise<string> {
  const answer = await http.request({
    method: 'POST',
    path: `/rest/api/3/issue/${encodeURIComponent(id)}/comment`,
    body: { body: buildCommentDocument(paragraphs) },
    signal: stop,
    mutation: true,
  });
  const commentId = isRecord(answer) ? stringField(answer, 'id') : null;
  if (commentId === null) {
    throw new SourceFeedbackError(
      'comment',
      `issue ${id}: the result comment was sent, but its answer did not acknowledge a comment ID, ` +
        'so this connector will not claim it was delivered',
    );
  }
  return commentId;
}

/** Flattens one line of a comment paragraph, so a body cannot grow a transcript. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The compact result comment: the run ID, the exact local outcome and reason,
 * the check summary, the repairs used, and where the artifacts are on this
 * machine — plus the pull request when the attempt was delivered, or the
 * delivery failure beside the outcome it could not publish. It carries no
 * transcript, diff, environment, or credential; it never describes a failed
 * attempt as completed, and never a partial delivery as published
 * (docs/spec.md §6, docs/WORKFLOW.md §8).
 *
 * An attempt that another rung of the ladder follows gets the same comment with
 * a closing paragraph that says so, and the item is not moved: the issue stays in
 * the running status until the ladder's last attempt
 * (docs/implement-workspace-continuation.md).
 */
function commentParagraphs(
  ref: SourceRef,
  outcome: SourceRunOutcome,
  climbs: boolean,
): readonly string[] {
  const attempt = outcome.attempt;
  const pullRequest = outcome.pullRequest;
  const deliveryFailure = outcome.deliveryFailure;
  return [
    `Harness run ${outcome.runId} for ${ref.key} finished: ${outcome.status}.` +
      (attempt === undefined || attempt.of <= 1
        ? ''
        : ` Attempt ${String(attempt.number)} of ${String(attempt.of)} (tier ${attempt.tier}).`),
    `Reason: ${oneLine(outcome.reason)}`,
    `Checks: ${oneLine(outcome.checks)}`,
    ...(pullRequest === undefined ? [] : [`Pull request: ${oneLine(pullRequest.url)}`]),
    ...(deliveryFailure === undefined
      ? []
      : [
          `Delivery: the optional GitHub step failed, so this attempt may not have been ` +
            `published: ${oneLine(deliveryFailure)}`,
        ]),
    `Repairs used: ${String(outcome.repairsUsed)}`,
    `Local artifacts on the machine that ran this harness (local paths, not Jira attachments): ` +
      `run directory ${oneLine(outcome.runDir)}; report ${oneLine(outcome.reportPath)}`,
    `Harness record: ${developerHistoryMarker(outcome.runId)} — the complete developer report is ` +
      'kept beside the ticket’s retained workspace, before this comment was published.',
    closingParagraph(pullRequest?.url, deliveryFailure, climbs, outcome.completionEnabled === true),
  ];
}

/**
 * What the issue is told happens next. A failed delivery is never described as
 * "nothing was published": only the destination can say how far it got, so the
 * comment says to check it rather than claim a state the harness cannot know.
 * An attempt the ladder still climbs from is not the issue's last word, so its
 * closing paragraph says that instead of "a human decides what happens next".
 */
function closingParagraph(
  pullRequestUrl: string | undefined,
  deliveryFailure: string | undefined,
  climbs: boolean,
  completionEnabled: boolean,
): string {
  if (climbs) {
    return (
      "This attempt is not the issue's last word: the harness is still climbing its " +
      'escalation ladder, so the issue stays in the running status and the next tier ' +
      'continues the same retained workspace — the commits and uncommitted work above ' +
      'included. A human decides what happens next when the ladder ends; the harness never ' +
      'marks an issue Done.'
    );
  }
  if (pullRequestUrl !== undefined && completionEnabled)
    return 'The attempt was delivered for Nexus Lens review. The configured completion path can request native auto-merge and resolve this issue only after verified integration and successful post-merge workflows; coding and repair remain separate runs.';
  if (pullRequestUrl !== undefined) {
    return (
      "The harness pushed this attempt's branch and opened or updated the pull request above. " +
      'It does not merge it and never marks this issue Done: a human decides what happens next. ' +
      'Work a later attempt commits stays in the retained workspace until that attempt delivers it.'
    );
  }
  if (deliveryFailure !== undefined) {
    return (
      'Delivering this attempt failed, so its push or its pull request creation may have only ' +
      'partly happened: check the destination repository on GitHub before retrying the ' +
      'publication by hand. The harness never merges a pull request and never marks an issue ' +
      'Done; no coding turn is started to repair a publishing failure, and a human decides what ' +
      'happens next.'
    );
  }
  return (
    'A human decides what happens next; this connector never marks an issue Done, and neither ' +
    'it nor the harness pushes, merges, or publishes anything. Any commits a coding turn made ' +
    'are local to the retained working copy on this machine.'
  );
}
/** One comment's body, rendered as text: an empty body is an empty comment. */
function renderCommentBody(value: unknown, key: string, token: string): string {
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return renderDescription(parseDescription(value));
  } catch (cause) {
    throw malformed(`a comment on ${key}`, diagnosticOf(cause, token));
  }
}

/** What a refusal says: why the harness will not act, and what would change that. */
function refusalParagraphs(ref: SourceRef, reason: string): readonly string[] {
  return [
    `Harness refused ${ref.key}: it did not run.`,
    `Reason: ${oneLine(reason)}`,
    'Nothing was claimed and no coding turn was started. The issue was moved out of the queue so ' +
      'a later scan does not read it again and again.',
  ];
}

/**
 * What an attention record says: why the item the harness claimed was not
 * started, and that a person decides what happens next. It never claims an
 * attempt ran, and never describes the item as unclaimed: the harness did claim
 * it, and then found something it will not start a developer without.
 */
function attentionParagraphs(ref: SourceRef, reason: string): readonly string[] {
  return [
    `Harness held ${ref.key} for attention: no coding turn was started.`,
    `Reason: ${oneLine(reason)}`,
    'The ticket had already been claimed for the workspace its pointer names, and no attempt was ' +
      'published for it. The harness will not start a developer without what the claim was made ' +
      'for; the issue was moved out of the queue so a later scan does not read it again and ' +
      'again, and a person decides what happens next.',
  ];
}

/**
 * Posts one comment of plain paragraphs, as every publication path here does.
 * A comment whose answer acknowledged no ID is never reported as delivered.
 */
async function publishComment(
  http: HttpClient,
  token: string,
  item: SourceTask,
  paragraphs: readonly string[],
  stop: AbortSignal,
): Promise<string> {
  try {
    return await postComment(http, item.ref.id, paragraphs, stop);
  } catch (cause) {
    if (cause instanceof SourceFeedbackError) {
      throw cause;
    }
    throw new SourceFeedbackError('comment', diagnosticOf(cause, token));
  }
}

/**
 * Posts one run's compact result comment, as the two publication paths below
 * send it: the ladder's intermediate attempt comments and its final result are
 * the same comment, and only the closing paragraph and the status move after it
 * tell them apart. A comment whose answer acknowledged no ID is never reported
 * as delivered.
 */
async function resultComment(
  http: HttpClient,
  token: string,
  item: SourceTask,
  outcome: SourceRunOutcome,
  climbs: boolean,
  stop: AbortSignal,
): Promise<string> {
  return await publishComment(
    http,
    token,
    item,
    commentParagraphs(item.ref, outcome, climbs),
    stop,
  );
}

/**
 * Publishes one attempt's result comment while the item stays in the running
 * status: another rung of the ladder follows, so the issue is not moved to
 * review yet. Only the comment is a remote write here, and a failure is the
 * feedback failure the caller stops on.
 */
export async function progressItem(
  http: HttpClient,
  token: string,
  item: SourceTask,
  outcome: SourceRunOutcome,
  stop: AbortSignal,
): Promise<void> {
  await resultComment(http, token, item, outcome, true, stop);
}

/**
 * Publishes one run's result: the compact comment, then the move to review while
 * the issue is still in the running status, so a later human decision stands. A
 * delivery failure says how far it got, so an acknowledged comment is kept even
 * when the status change after it failed.
 */
export async function completeItem(
  config: JiraSourceConfig,
  http: HttpClient,
  token: string,
  item: SourceTask,
  outcome: SourceRunOutcome,
  stop: AbortSignal,
): Promise<void> {
  const commentId = await resultComment(http, token, item, outcome, false, stop);

  // The result was published; the status change happens only while the issue is
  // still in the running status, so a later human decision stands.
  let current: JiraIssue | null;
  try {
    current = await readIssue(http, item.ref.id, stop);
  } catch (cause) {
    throw new SourceFeedbackError(
      'transition',
      `issue ${item.ref.key}: the result comment ${commentId} was posted, but the issue could ` +
        `not be re-read to move it to "${config.reviewStatus}" (${diagnosticOf(cause, token)})`,
      commentId,
    );
  }
  if (current === null || !sameName(current.fields.status, config.runningStatus)) {
    return;
  }

  try {
    const chosen = selectTransition(
      await readTransitions(http, item.ref.id, stop),
      config.reviewStatus,
      `issue ${item.ref.key}: moving it to review`,
    );
    await postTransition(http, item.ref.id, chosen.id, stop);
  } catch (cause) {
    throw new SourceFeedbackError(
      'transition',
      `issue ${item.ref.key}: the result comment ${commentId} was posted, but moving the issue ` +
        `to "${config.reviewStatus}" failed (${diagnosticOf(cause, token)})`,
      commentId,
    );
  }
}

/**
 * Moves one issue to review while it is still in the queue the harness found it
 * in — either the ready status or the running status it claimed it into — so a
 * later scan does not read it again and again and a later decision by anyone
 * else stands. The acknowledged comment is carried in any failure, so a comment
 * that was posted is never lost. `what` names that comment in the failures, and
 * `reason` is what the transition itself reports it is being sent for.
 */
async function takeOutOfQueue(
  config: JiraSourceConfig,
  http: HttpClient,
  token: string,
  item: SourceTask,
  commentId: string,
  stop: AbortSignal,
  what: string,
  reason: string,
): Promise<void> {
  let current: JiraIssue | null;
  try {
    current = await readIssue(http, item.ref.id, stop);
  } catch (cause) {
    throw new SourceFeedbackError(
      'transition',
      `issue ${item.ref.key}: the ${what} comment ${commentId} was posted, but the issue could ` +
        `not be re-read to take it out of the queue (${diagnosticOf(cause, token)})`,
      commentId,
    );
  }
  if (current === null) {
    return;
  }
  const stillQueued =
    sameName(current.fields.status, config.readyStatus) ||
    sameName(current.fields.status, config.runningStatus);
  if (!stillQueued) {
    return;
  }

  try {
    const chosen = selectTransition(
      await readTransitions(http, item.ref.id, stop),
      config.reviewStatus,
      `issue ${item.ref.key}: ${reason}`,
    );
    await postTransition(http, item.ref.id, chosen.id, stop);
  } catch (cause) {
    throw new SourceFeedbackError(
      'transition',
      `issue ${item.ref.key}: the ${what} comment ${commentId} was posted, but moving the issue ` +
        `to "${config.reviewStatus}" failed (${diagnosticOf(cause, token)})`,
      commentId,
    );
  }
}

/**
 * Publishes a refusal: one comment naming why the harness will not act on the
 * item, and the item taken out of the queue, so a later scan does not read it
 * again and again. Nothing was claimed and nothing ran. It moves only while the
 * issue is still in the queue it was found in — a later decision by anyone else
 * stands.
 */
export async function refuseItem(
  config: JiraSourceConfig,
  http: HttpClient,
  token: string,
  item: SourceTask,
  reason: string,
  stop: AbortSignal,
): Promise<void> {
  const commentId = await publishComment(
    http,
    token,
    item,
    refusalParagraphs(item.ref, reason),
    stop,
  );
  await takeOutOfQueue(
    config,
    http,
    token,
    item,
    commentId,
    stop,
    'refusal',
    'taking it out of the queue after a refusal',
  );
}

/**
 * Publishes one attention record: the comment naming why the claimed item was
 * not started, and the item taken out of the running status so it is not left
 * claimed with nothing looking for it. It moves only while the issue is still
 * in the queue the harness found it in — a later decision by anyone else stands
 * — and it touches neither the workspace pointer nor the acceptance criteria.
 */
export async function attentionItem(
  config: JiraSourceConfig,
  http: HttpClient,
  token: string,
  item: SourceTask,
  reason: string,
  stop: AbortSignal,
): Promise<void> {
  const commentId = await publishComment(
    http,
    token,
    item,
    attentionParagraphs(item.ref, reason),
    stop,
  );
  await takeOutOfQueue(
    config,
    http,
    token,
    item,
    commentId,
    stop,
    'attention',
    'moving the claimed issue out of the running status after an attention stop',
  );
}

/**
 * What the issue's own thread says since an attempt ended. Read-only, and
 * bounded: the coordinator decides how much of it a turn is given.
 */
export async function commentsSince(
  http: HttpClient,
  token: string,
  item: SourceTask,
  since: string,
  stop: AbortSignal,
): Promise<readonly SourceComment[]> {
  const moment = Date.parse(since);
  const thread = await readCommentThread(http, token, item.ref.id, item.ref.key, stop);
  const comments: SourceComment[] = [];
  for (const comment of thread.comments) {
    const created = comment.createdAt;
    if (Date.parse(created) <= moment) {
      continue;
    }
    comments.push({ author: comment.author, createdAt: created, text: comment.text });
  }
  return comments;
}
