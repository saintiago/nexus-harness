/**
 * The Jira half of the review-to-completion path: the In Review items that may
 * be completed, their existing thread, and the two writes it makes — one comment
 * and one native transition, each chosen by target status.
 *
 * It reads an item freshly every time. The status a search result carried is
 * never acted on: an item that left In Review — a person moved it, a later
 * intake claimed it, this harness already finished it — is not touched. A
 * comment carries a marker, so a repeated pass or a restart finds the comment it
 * already wrote instead of writing a second one, and every status move is made
 * only while the item really is in the review status.
 */
import { SourceError } from '../contract.js';
import type { SourceCandidate } from '../contract.js';
import { parseWorkspacePointers } from '../contract.js';
import type { JiraSourceConfig, SourceRef } from '../../shared/types.js';
import { parseDescription } from './adf.js';
import { buildCommentDocument, renderDescription } from './adf-text.js';
import { diagnosticOf } from './http.js';
import type { HttpClient } from './http.js';
import { malformed, readIssue, refFor, sameName } from './issue.js';
import { isRecord, stringField } from './json.js';
import { postTransition, readTransitions, selectTransition } from './transitions.js';

/** How many comments of one thread are read looking for a marker. */
const COMMENT_PAGE_SIZE = 100;
const COMMENT_PAGE_LIMIT = 3;
/** How many issues one In Review scan may follow before it stops. */
const SEARCH_PAGE_SIZE = 100;
const SEARCH_PAGE_LIMIT = 20;

/** One comment on the item's thread, as far as the completion path reads it. */
export interface IssueNote {
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
}

/**
 * The In Review queue's JQL: the same boundary as the ready queue, one status
 * over. It keeps this fixed deterministic order of its own — completing an item
 * is not intake, so `source.ordering` (the ready queue's Rank or Priority
 * choice) is deliberately not read here (docs/WORKFLOW.md §5).
 */
export function reviewQueueJql(config: JiraSourceConfig): string {
  const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    `project = ${quote(config.projectKey)}`,
    `AND issuetype = ${quote(config.issueType)}`,
    `AND labels = ${quote(config.label)}`,
    `AND status = ${quote(config.reviewStatus)}`,
    'ORDER BY priority DESC, created ASC, key ASC',
  ].join(' ');
}

/**
 * Every In Review item of the configured queue, across every page, as candidates.
 * Candidates, not claims: each one is re-read before anything is decided.
 */
export async function listReviewCandidates(
  config: JiraSourceConfig,
  http: HttpClient,
  stop: AbortSignal,
): Promise<readonly SourceCandidate[]> {
  const jql = reviewQueueJql(config);
  const candidates: SourceCandidate[] = [];
  const seen = new Set<string>();
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;

  for (let page = 0; page < SEARCH_PAGE_LIMIT; page += 1) {
    const answer = await http.request({
      method: 'POST',
      path: '/rest/api/3/search/jql',
      body: {
        jql,
        maxResults: SEARCH_PAGE_SIZE,
        fields: ['summary', 'status', 'updated', 'labels', 'project', 'issuetype'],
        ...(pageToken === null ? {} : { nextPageToken: pageToken }),
      },
      signal: stop,
    });
    if (!isRecord(answer) || !Array.isArray(answer['issues'])) {
      throw malformed('the review search answer', 'no issues array');
    }
    for (const raw of answer['issues']) {
      const candidate = parseCandidate(config, raw);
      if (seen.has(candidate.ref.id)) {
        continue;
      }
      seen.add(candidate.ref.id);
      candidates.push(candidate);
    }
    if (answer['isLast'] === true) {
      return candidates;
    }
    const next = answer['nextPageToken'];
    if (typeof next !== 'string' || next.trim() === '' || seenTokens.has(next)) {
      throw malformed('the review search answer', 'a nonfinal page carried no usable token');
    }
    seenTokens.add(next);
    pageToken = next;
  }
  throw malformed('the review search answer', 'more pages than this connector will follow');
}

/** One search result, validated as far as a candidate needs. */
function parseCandidate(config: JiraSourceConfig, value: unknown): SourceCandidate {
  if (!isRecord(value)) {
    throw malformed('a review search result', 'not an object');
  }
  const id = stringField(value, 'id');
  const key = stringField(value, 'key');
  const fields = value['fields'];
  if (id === null || key === null || !isRecord(fields)) {
    throw malformed('a review search result', 'no id, key, or fields');
  }
  const summary = stringField(fields, 'summary');
  const status = fields['status'];
  const statusName = isRecord(status) ? stringField(status, 'name') : null;
  const updated = stringField(fields, 'updated');
  if (summary === null || statusName === null || updated === null) {
    throw malformed('a review search result', 'a field the completion path depends on is missing');
  }
  return {
    ref: {
      type: 'jira',
      scope: config.siteUrl,
      id,
      key,
      url: `${config.siteUrl}/browse/${key}`,
      updatedAt: updated,
    },
    title: summary,
  };
}

/**
 * Every comment of one issue's thread, oldest first, as plain text. Read for one
 * purpose here: a repeated pass finds the marker of the comment it already wrote
 * rather than writing a second one.
 */
export async function listIssueNotes(
  http: HttpClient,
  id: string,
  stop: AbortSignal,
  token: string,
): Promise<readonly IssueNote[]> {
  const notes: IssueNote[] = [];
  let startAt = 0;
  for (let page = 0; page < COMMENT_PAGE_LIMIT; page += 1) {
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
    const comments = answer['comments'];
    for (const raw of comments) {
      if (!isRecord(raw)) {
        throw malformed(`the comments of issue ${id}`, 'a comment is not an object');
      }
      const commentId = stringField(raw, 'id');
      const created = stringField(raw, 'created');
      if (commentId === null) {
        continue;
      }
      notes.push({
        id: commentId,
        createdAt: created ?? '',
        text: commentText(raw['body'], id, token),
      });
    }
    const total = typeof answer['total'] === 'number' ? answer['total'] : startAt + comments.length;
    startAt += comments.length;
    if (startAt >= total) return notes;
    if (comments.length === 0) throw malformed('the comment list', 'incomplete page');
  }
  throw malformed('the comment list', 'bounded pagination exhausted');
}

/** One comment body as flat text: the same ADF reader the description uses. */
function commentText(value: unknown, key: string, token: string): string {
  try {
    return renderDescription(parseDescription(value));
  } catch (cause) {
    throw malformed(`a comment on ${key}`, diagnosticOf(cause, token));
  }
}

/** The first comment carrying `marker`, or `null` when the thread has none. */
export function noteWithMarker(notes: readonly IssueNote[], marker: string): IssueNote | null {
  return (
    notes.find((note) => note.text.includes(`${marker}, written by the Nexus harness)`)) ?? null
  );
}

/** A completed transition followed by a human reopening is a new cycle, not a retry. */
async function leftReviewSince(
  config: JiraSourceConfig,
  http: HttpClient,
  id: string,
  since: string,
  stop: AbortSignal,
): Promise<boolean> {
  const timestamp = Date.parse(since);
  if (!Number.isFinite(timestamp)) throw malformed('completion comment', 'missing creation time');
  let startAt = 0;
  for (let page = 0; page < 20; page++) {
    const answer = await http.request({
      method: 'GET',
      path: `/rest/api/3/issue/${encodeURIComponent(id)}/changelog?startAt=${String(startAt)}&maxResults=100`,
      signal: stop,
    });
    if (!isRecord(answer) || !Array.isArray(answer['values']))
      throw malformed('issue changelog', 'no values');
    const values = answer['values'];
    for (const value of values) {
      if (
        !isRecord(value) ||
        typeof value['created'] !== 'string' ||
        !Array.isArray(value['items'])
      )
        throw malformed('issue changelog', 'missing change fields');
      if (
        Date.parse(value['created']) >= timestamp &&
        value['items'].some(
          (item) =>
            isRecord(item) &&
            item['field'] === 'status' &&
            typeof item['fromString'] === 'string' &&
            sameName(item['fromString'], config.reviewStatus) &&
            item['toString'] !== item['fromString'],
        )
      )
        return true;
    }
    startAt += values.length;
    if (
      answer['isLast'] === true ||
      (typeof answer['total'] === 'number' && startAt >= answer['total'])
    )
      return false;
    if (values.length === 0) break;
  }
  throw malformed('issue changelog', 'incomplete history');
}

/** Posts one comment of plain paragraphs and returns the acknowledged comment ID. */
export async function postIssueComment(
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
    throw new SourceError(
      'uncertain-write',
      `issue ${id}: the completion comment was sent, but its answer did not acknowledge a ` +
        'comment ID, so this connector will not claim it was delivered',
    );
  }
  return commentId;
}

/**
 * Moves one item to `target`, but only while it is really still in the review
 * status. `null` means a human (or another process) moved it first: that is
 * respected, and no transition is sent.
 */
export async function moveFromReview(
  config: JiraSourceConfig,
  http: HttpClient,
  id: string,
  target: string,
  stop: AbortSignal,
  beforeWrite?: () => Promise<boolean>,
): Promise<'moved' | 'left-alone'> {
  const current = await readIssue(http, id, stop);
  if (current === null || !sameName(current.fields.status, config.reviewStatus)) {
    return 'left-alone';
  }
  const chosen = selectTransition(
    await readTransitions(http, id, stop),
    target,
    `issue ${current.key}: moving it to "${target}"`,
  );
  const fresh = await readIssue(http, id, stop);
  if (
    fresh === null ||
    !sameName(fresh.fields.status, config.reviewStatus) ||
    (beforeWrite !== undefined && !(await beforeWrite()))
  )
    return 'left-alone';
  await postTransition(http, id, chosen.id, stop);
  const confirmed = await readIssue(http, id, stop);
  if (confirmed === null || !sameName(confirmed.fields.status, target))
    throw new SourceError('uncertain-write', 'Jira did not confirm the completion status');
  return 'moved';
}

/** What one In Review item looks like after a fresh read. */
export interface ReviewItem {
  readonly ref: SourceRef;
  readonly title: string;
  /** The status Jira reports for it right now. */
  readonly statusName: string;
  /** The workspace ids its pointer labels name, in the order they were read. */
  readonly pointers: readonly string[];
}

/** The Jira operations one review-to-completion pass needs, and nothing else. */
export interface CompletionSource {
  /** Every In Review item of the configured queue, as candidates. */
  listReview(stop: AbortSignal): Promise<readonly SourceCandidate[]>;
  /**
   * Re-reads one candidate. `null` means it is gone or no longer in the review
   * status, so nothing about it may be acted on.
   */
  readItem(candidate: SourceCandidate, stop: AbortSignal): Promise<ReviewItem | null>;
  /** Every comment of one item's thread, oldest first. */
  listComments(id: string, stop: AbortSignal): Promise<readonly IssueNote[]>;
  leftReviewSince(id: string, since: string, stop: AbortSignal): Promise<boolean>;
  /** Posts one comment of plain paragraphs and acknowledges its ID. */
  postComment(id: string, paragraphs: readonly string[], stop: AbortSignal): Promise<string>;
  /**
   * Moves one item to `target`, only while it is still in the review status.
   * `left-alone` means somebody moved it first: that is respected.
   */
  moveTo(
    id: string,
    target: string,
    stop: AbortSignal,
    beforeWrite?: () => Promise<boolean>,
  ): Promise<'moved' | 'left-alone'>;
}

/**
 * Re-reads one candidate as an item that may be completed. `null` means it is
 * no longer an item this path may touch: it has left In Review, it is gone, or
 * it carries no workspace pointer. A pointer that is not a generated workspace
 * id is a refusal to report, not a workspace to guess at.
 */
export async function readReviewItem(
  config: JiraSourceConfig,
  http: HttpClient,
  candidate: SourceCandidate,
  stop: AbortSignal,
): Promise<ReviewItem | null> {
  const issue = await readIssue(http, candidate.ref.id, stop);
  if (
    issue === null ||
    !sameName(issue.fields.status, config.reviewStatus) ||
    issue.fields.projectKey !== config.projectKey ||
    issue.fields.issueType !== config.issueType ||
    !issue.fields.labels.includes(config.label)
  ) {
    return null;
  }
  return {
    ref: refFor(config, issue),
    title: issue.fields.summary,
    statusName: issue.fields.status,
    pointers: parseWorkspacePointers(issue.fields.labels),
  };
}

/**
 * The Jira side of the completion path, built once per source command from the
 * validated configuration and the resolved token. The token is not a property of
 * the returned object: it lives in the closure of the client it was built with.
 */
export function createJiraCompletionSource(
  config: JiraSourceConfig,
  http: HttpClient,
): CompletionSource {
  return {
    listReview: (stop) => listReviewCandidates(config, http, stop),
    readItem: (candidate, stop) => readReviewItem(config, http, candidate, stop),
    leftReviewSince: (id, since, stop) => leftReviewSince(config, http, id, since, stop),
    listComments: (id, stop) => listIssueNotes(http, id, stop, http.token),
    postComment: (id, paragraphs, stop) => postIssueComment(http, id, paragraphs, stop),
    moveTo: (id, target, stop, beforeWrite) =>
      moveFromReview(config, http, id, target, stop, beforeWrite),
  };
}
