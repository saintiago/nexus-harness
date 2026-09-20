/**
 * The issue's own thread and the two comments the harness posts: the compact
 * result comment, and the refusal that takes an item out of the queue.
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
import { postTransition, readTransitions, selectTransition } from './transitions.js';

/** How many comments one request may return, and how many pages are followed. */
const COMMENT_PAGE_SIZE = 100;
const COMMENT_PAGE_LIMIT = 10;
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
  try {
    return await postComment(http, item.ref.id, commentParagraphs(item.ref, outcome, climbs), stop);
  } catch (cause) {
    if (cause instanceof SourceFeedbackError) {
      throw cause;
    }
    throw new SourceFeedbackError('comment', diagnosticOf(cause, token));
  }
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
  let commentId: string;
  try {
    commentId = await postComment(http, item.ref.id, refusalParagraphs(item.ref, reason), stop);
  } catch (cause) {
    if (cause instanceof SourceFeedbackError) {
      throw cause;
    }
    throw new SourceFeedbackError('comment', diagnosticOf(cause, token));
  }

  let current: JiraIssue | null;
  try {
    current = await readIssue(http, item.ref.id, stop);
  } catch (cause) {
    throw new SourceFeedbackError(
      'transition',
      `issue ${item.ref.key}: the refusal comment ${commentId} was posted, but the issue could ` +
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
      `issue ${item.ref.key}: taking it out of the queue after a refusal`,
    );
    await postTransition(http, item.ref.id, chosen.id, stop);
  } catch (cause) {
    throw new SourceFeedbackError(
      'transition',
      `issue ${item.ref.key}: the refusal comment ${commentId} was posted, but moving the issue ` +
        `to "${config.reviewStatus}" failed (${diagnosticOf(cause, token)})`,
      commentId,
    );
  }
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
  const comments: SourceComment[] = [];
  let startAt = 0;

  for (let page = 0; page < COMMENT_PAGE_LIMIT; page += 1) {
    const answer = await http.request({
      method: 'GET',
      path:
        `/rest/api/3/issue/${encodeURIComponent(item.ref.id)}/comment` +
        `?startAt=${String(startAt)}&maxResults=${String(COMMENT_PAGE_SIZE)}`,
      signal: stop,
    });
    if (!isRecord(answer) || !Array.isArray(answer['comments'])) {
      throw malformed(`the comments of issue ${item.ref.id}`, 'no comments array');
    }
    for (const raw of answer['comments']) {
      if (!isRecord(raw)) {
        throw malformed(`the comments of issue ${item.ref.id}`, 'a comment is not an object');
      }
      const created = stringField(raw, 'created');
      if (created === null || Date.parse(created) <= moment) {
        continue;
      }
      const author = nested(raw, 'author');
      comments.push({
        author: (author === null ? null : stringField(author, 'displayName')) ?? 'unknown',
        createdAt: created,
        text: renderCommentBody(raw['body'], item.ref.key, token),
      });
    }

    const total = typeof answer['total'] === 'number' ? answer['total'] : comments.length;
    startAt += Array.isArray(answer['comments']) ? answer['comments'].length : 0;
    if (startAt >= total) {
      break;
    }
  }

  return comments;
}
