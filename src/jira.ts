/**
 * The Jira Cloud connector: the only implemented task source.
 *
 * It is a direct REST API v3 client with the platform's own `fetch`, not an SDK,
 * not an MCP/Rovo session, and not a second harness. Everything it needs is the
 * validated `source` object and one service-account API token, which it keeps in
 * a private closure for the lifetime of the connector and never writes anywhere.
 *
 * ## Authentication and routing
 *
 * A dedicated Atlassian service account's scoped API token is presented as
 * `Authorization: Bearer <token>` and every call goes through the Atlassian API
 * gateway, `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...`. There is
 * no direct `*.atlassian.net/rest/api` route, no Basic authentication, and no
 * email address: a service-account token is not a personal account and the
 * gateway is where a scoped token works at all (docs/WORKFLOW.md §5).
 *
 * ## What one connector does
 *
 * - {@link TaskSource.listEligible} runs the configured queue JQL, consumes every
 *   `nextPageToken` page, and returns one finite, ordered, de-duplicated batch.
 *   Search results can lag, so they are candidates, not claims.
 * - {@link TaskSource.prepare} re-reads the issue, tests eligibility again, and
 *   maps summary and description onto the existing four-field `Task`. Only the
 *   documented description convention is understood; anything else is a typed
 *   per-issue error rather than an inferred task.
 * - {@link TaskSource.claim} rechecks the captured revision and requests the
 *   transition to the running status, choosing it by the target status it reaches
 *   (never by a hard-coded transition ID) and refusing a transition that needs
 *   fields the connector cannot supply.
 * - {@link TaskSource.complete} posts one compact ADF result comment and moves a
 *   still-running issue to the review status. It never sets Done.
 *
 * Issue text is input for a task and nothing else: no part of a description
 * becomes a command, a repository, an agent argument, or a limit.
 */

import { taskSchema } from './config.js';
import {
  AdfError,
  buildCommentDocument,
  extractAcceptanceCriteria,
  parseDescription,
  renderDescription,
} from './jira-format.js';
import {
  SourceError,
  SourceFeedbackError,
  parseWorkspacePointers,
  workspacePointerLabel,
} from './source.js';
import type { SourceCandidate, SourceRunOutcome, SourceTask, TaskSource } from './source.js';
import type { JiraSourceConfig, SourceRef, Task } from './types.js';

/** The Atlassian API gateway prefix every service-account call goes through. */
const GATEWAY_ORIGIN = 'https://api.atlassian.com/ex/jira';

/** How long one HTTP request may take, in milliseconds. */
export const JIRA_REQUEST_TIMEOUT_MS = 30_000;

/** The most issues one search page may return. */
const SEARCH_PAGE_SIZE = 100;

/** How much of a diagnostic this connector repeats; the rest is truncated. */
const MAX_DIAGNOSTIC_CHARS = 400;

/** The issue fields the connector asks for, and no others. */
const ISSUE_FIELDS = 'summary,description,status,labels,project,issuetype,updated';

/** The fields the enhanced search needs to build a candidate. */
const SEARCH_FIELDS = ['summary', 'status', 'updated', 'labels', 'project', 'issuetype'];

/**
 * The language every request asks Jira to answer in.
 *
 * Jira renders the names of its built-in statuses and issue types in the language
 * a request negotiates, while the queue's JQL resolves those same entities by
 * their canonical names. A client that leaves the choice to its HTTP library gets
 * neither reliably: JavaScript's `fetch` sends `accept-language: *`, which
 * resolves to the site's default language, so on a site whose default is not
 * English the connector would list an issue and then refuse it as no longer
 * eligible — the names it read back are not the names the queue matched. Asking
 * for one language explicitly makes both halves agree whatever the site's default
 * is, and names the operator authored are returned as authored in every language.
 */
const ACCEPT_LANGUAGE = 'en';

/** The gateway route of one configured site: where every call below is made. */
export function jiraApiBaseUrl(config: JiraSourceConfig): string {
  return `${GATEWAY_ORIGIN}/${config.cloudId}`;
}

/**
 * Resolves the API token from the environment variable the configuration names.
 *
 * The token never appears in a configuration file, a task, a report, or a log.
 * A missing or blank variable is refused before anything runs, with the variable
 * named and the value never echoed (docs/WORKFLOW.md §5).
 */
export function resolveJiraToken(
  config: JiraSourceConfig,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const raw = environment[config.tokenEnv];
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (token === '') {
    throw new SourceError(
      'fatal',
      `the environment variable ${config.tokenEnv} is missing or blank. Put the Jira ` +
        'service-account API token in it before running a source command; the token is never ' +
        'read from the configuration file.',
    );
  }
  return token;
}

/** A JQL string literal, quoted and escaped rather than interpolated raw. */
function jqlLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The configured queue, as the documented JQL: the project, the issue type, the
 * label, and the ready status, with a deterministic order. No arbitrary JQL and
 * no timestamp cursor: the configured values are the whole queue definition
 * (docs/WORKFLOW.md §5).
 */
export function queueJql(config: JiraSourceConfig): string {
  return [
    `project = ${jqlLiteral(config.projectKey)}`,
    `AND issuetype = ${jqlLiteral(config.issueType)}`,
    `AND labels = ${jqlLiteral(config.label)}`,
    `AND status = ${jqlLiteral(config.readyStatus)}`,
    'ORDER BY created ASC, key ASC',
  ].join(' ');
}

/** A secret-free, bounded diagnostic built from anything a request produced. */
function sanitize(text: string, token: string): string {
  let clean = text.replace(/\s+/g, ' ').trim();
  if (token !== '') {
    clean = clean.split(token).join('[redacted]');
  }
  clean = clean.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return clean.length <= MAX_DIAGNOSTIC_CHARS
    ? clean
    : `${clean.slice(0, MAX_DIAGNOSTIC_CHARS)} [truncated]`;
}

function messageOf(cause: unknown, token: string): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return sanitize(text, token);
}

/** A server-directed wait, as milliseconds, from an HTTP `Retry-After` header. */
function retryAfterMs(header: string | null, now: () => Date): number | null {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now().getTime());
}

/** One JSON request to the gateway, already classified for the coordinator. */
interface JiraRequest {
  readonly method: 'GET' | 'POST' | 'PUT';
  /** The path after the gateway prefix, for example `/rest/api/3/search/jql`. */
  readonly path: string;
  readonly body?: unknown;
  readonly signal: AbortSignal;
  /** A write: its failures are never retried and never assumed not to have happened. */
  readonly mutation?: boolean;
  /** Treat HTTP 404 as an absent answer instead of a failure. */
  readonly absentOk?: boolean;
}

interface HttpClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  request(request: JiraRequest): Promise<unknown | null>;
}

function createHttpClient(
  config: JiraSourceConfig,
  token: string,
  parts: Partial<JiraSourceParts>,
): HttpClient {
  const now = parts.now ?? ((): Date => new Date());
  const doFetch: typeof fetch =
    parts.fetch ?? ((input, init) => globalThis.fetch(input as string, init));
  const baseUrl = jiraApiBaseUrl(config);

  /**
   * Turns one non-success answer into the classified failure the coordinator
   * acts on. A refused answer to a write is never retried and never assumed not
   * to have happened (docs/architecture.md §9).
   */
  const classifyFailure = async (request: JiraRequest, response: Response): Promise<never> => {
    // The body may be unreadable; the status alone still says what happened.
    const detail = await response.text().then(
      (body) => sanitize(body, token),
      () => '',
    );
    const suffix = detail === '' ? '' : `: ${detail}`;
    const where = `the request to ${baseUrl}${request.path} answered HTTP ${String(response.status)}`;
    const hint =
      response.status === 401 || response.status === 403
        ? ". The service account and its scoped API token are not accepted for this call: check the token's Jira scopes and the service account's access to the project"
        : '';
    const text = `${where}${hint}${suffix}`;
    if (response.status >= 500 || response.status === 429) {
      const wait = retryAfterMs(response.headers.get('retry-after'), now);
      throw new SourceError(
        request.mutation === true ? 'uncertain-write' : 'retryable-read',
        text,
        {
          retryAfterMs: wait,
        },
      );
    }
    if (request.mutation === true) {
      throw new SourceError('uncertain-write', text);
    }
    throw new SourceError('fatal', text);
  };

  return {
    baseUrl,
    token,
    fetch: doFetch,
    now,
    request: async (request) => {
      const url = `${baseUrl}${request.path}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        // Never `*`, and never nothing: see {@link ACCEPT_LANGUAGE}.
        'Accept-Language': ACCEPT_LANGUAGE,
      };
      if (request.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      let response: Response;
      try {
        response = await doFetch(url, {
          method: request.method,
          headers,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          // A redirect would forward the credential to another host, so it is
          // refused rather than followed (docs/architecture.md §9).
          redirect: 'error',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(JIRA_REQUEST_TIMEOUT_MS)]),
        });
      } catch (cause) {
        const detail = messageOf(cause, token);
        if (request.signal.aborted) {
          throw new SourceError(
            // A stopped read is over; a stopped write is one whose outcome is
            // unknown, and it is never sent again.
            request.mutation === true ? 'uncertain-write' : 'fatal',
            `the request to ${url} was stopped by the caller before it answered`,
          );
        }
        const text = `the request to ${url} did not complete: ${detail}`;
        throw new SourceError(
          request.mutation === true ? 'uncertain-write' : 'retryable-read',
          text,
        );
      }

      if (!response.ok) {
        if (request.absentOk === true && response.status === 404) {
          return null;
        }
        await classifyFailure(request, response);
      }
      if (response.status === 204) {
        return null;
      }

      const text = await response.text().catch(() => '');
      try {
        return text.trim() === '' ? null : (JSON.parse(text) as unknown);
      } catch {
        const message = `the answer from ${url} was not JSON, so this connector will not guess what it said`;
        throw new SourceError(request.mutation === true ? 'uncertain-write' : 'fatal', message);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === 'string' ? value : null;
}

function nested(source: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = source[field];
  return isRecord(value) ? value : null;
}

/** The issue fields this connector reads. Everything is validated, not assumed. */
interface IssueFields {
  readonly summary: string;
  readonly description: unknown;
  readonly status: string;
  readonly labels: readonly string[];
  readonly projectKey: string;
  readonly issueType: string;
  readonly updated: string;
}

interface JiraIssue {
  readonly id: string;
  readonly key: string;
  readonly fields: IssueFields;
}

function malformed(where: string, problem: string): SourceError {
  return new SourceError(
    'fatal',
    `${where} was not the documented Jira REST API v3 shape (${problem}), so this connector will ` +
      'not guess what it said',
  );
}

/**
 * Parses one issue object. A search result carries no description and an issue
 * read carries one; both go through the same validation of the fields the queue
 * depends on.
 */
function parseIssue(value: unknown, where: string): JiraIssue {
  if (!isRecord(value)) {
    throw malformed(where, 'not an object');
  }
  const id = stringField(value, 'id');
  const key = stringField(value, 'key');
  const fields = nested(value, 'fields');
  if (id === null || key === null || fields === null) {
    throw malformed(where, 'no id, key, or fields');
  }
  const summary = stringField(fields, 'summary');
  const status = nested(fields, 'status');
  const project = nested(fields, 'project');
  const issueType = nested(fields, 'issuetype');
  const updated = stringField(fields, 'updated');
  const statusName = status === null ? null : stringField(status, 'name');
  const projectKey = project === null ? null : stringField(project, 'key');
  const issueTypeName = issueType === null ? null : stringField(issueType, 'name');
  const labelsValue = fields['labels'];
  const labels = Array.isArray(labelsValue)
    ? labelsValue.filter((label): label is string => typeof label === 'string')
    : null;
  if (
    summary === null ||
    statusName === null ||
    projectKey === null ||
    issueTypeName === null ||
    updated === null ||
    labels === null
  ) {
    throw malformed(where, 'a field the queue depends on is missing');
  }
  return {
    id,
    key,
    fields: {
      summary,
      description: fields['description'],
      status: statusName,
      labels,
      projectKey,
      issueType: issueTypeName,
      updated,
    },
  };
}

/** Names are compared as names: trimmed, and case-insensitively. */
function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Whether one issue is still in the configured queue. */
function isEligible(config: JiraSourceConfig, fields: IssueFields): boolean {
  return (
    fields.projectKey === config.projectKey &&
    sameName(fields.issueType, config.issueType) &&
    fields.labels.includes(config.label) &&
    sameName(fields.status, config.readyStatus)
  );
}

/** The source reference of one issue: immutable ID, browser link, revision. */
function refFor(config: JiraSourceConfig, issue: JiraIssue): SourceRef {
  return {
    type: 'jira',
    scope: config.siteUrl,
    id: issue.id,
    key: issue.key,
    url: `${config.siteUrl}/browse/${issue.key}`,
    updatedAt: issue.fields.updated,
  };
}

/**
 * Every eligible issue, across every page, in the order the search returned
 * them, with immutable IDs de-duplicated. `total` and the deprecated
 * `startAt` pagination are deliberately unused (docs/architecture.md §9).
 */
async function listEligible(
  config: JiraSourceConfig,
  http: HttpClient,
  stop: AbortSignal,
): Promise<readonly SourceCandidate[]> {
  const jql = queueJql(config);
  const candidates: SourceCandidate[] = [];
  const seen = new Set<string>();
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;

  for (;;) {
    const answer = await http.request({
      method: 'POST',
      path: '/rest/api/3/search/jql',
      body: {
        jql,
        maxResults: SEARCH_PAGE_SIZE,
        fields: SEARCH_FIELDS,
        ...(pageToken === null ? {} : { nextPageToken: pageToken }),
      },
      signal: stop,
    });
    if (!isRecord(answer)) {
      throw malformed('the search answer', 'not an object');
    }
    const issuesValue = answer['issues'];
    if (!Array.isArray(issuesValue)) {
      throw malformed('the search answer', 'no issues array');
    }

    for (const raw of issuesValue) {
      const issue = parseIssue(raw, 'a search result');
      if (seen.has(issue.id)) {
        continue;
      }
      seen.add(issue.id);
      candidates.push({
        ref: refFor(config, issue),
        title: issue.fields.summary,
        // The workspace pointers the issue carries now. A run only ever reads
        // them; the one that creates a workspace writes its own.
        pointers: parseWorkspacePointers(issue.fields.labels),
      });
    }

    if (answer['isLast'] === true) {
      return candidates;
    }
    const next = answer['nextPageToken'];
    if (typeof next !== 'string' || next.trim() === '') {
      throw malformed(
        'the search answer',
        'a page that is not the last one carried no continuation token',
      );
    }
    if (seenTokens.has(next)) {
      throw malformed(
        'the search answer',
        'a page repeated a continuation token, which would never end',
      );
    }
    seenTokens.add(next);
    pageToken = next;
  }
}

/** Reads one issue's current content. `null` means it is gone. */
async function readIssue(
  http: HttpClient,
  id: string,
  stop: AbortSignal,
): Promise<JiraIssue | null> {
  const raw = await http.request({
    method: 'GET',
    path: `/rest/api/3/issue/${encodeURIComponent(id)}?fields=${ISSUE_FIELDS}`,
    signal: stop,
    absentOk: true,
  });
  return raw === null ? null : parseIssue(raw, `issue ${id}`);
}

/** The one message a per-issue input error carries. */
function invalidTask(key: string, problem: string): SourceError {
  return new SourceError('invalid-task', `${key}: ${problem}`);
}

/**
 * Maps one issue onto the existing four-field `Task`, or refuses it.
 *
 * The key, the summary, and the supported description format are the only
 * inputs. Nothing is inferred, no attachment or comment is fetched, and the
 * mapped object is validated by the same task schema a task file goes through
 * (docs/WORKFLOW.md §6).
 */
function mapTask(issue: JiraIssue): Task {
  const key = issue.key;
  const title = issue.fields.summary.trim();
  if (title === '') {
    throw invalidTask(key, 'its summary is blank, so the task would have no title');
  }
  if (issue.fields.description === undefined || issue.fields.description === null) {
    throw invalidTask(
      key,
      'it has no description, so there is no task text and no acceptance criteria',
    );
  }

  let document;
  let description: string;
  let acceptanceCriteria: readonly string[];
  try {
    document = parseDescription(issue.fields.description);
    description = renderDescription(document);
    acceptanceCriteria = extractAcceptanceCriteria(document);
  } catch (cause) {
    if (cause instanceof AdfError) {
      throw invalidTask(key, cause.message);
    }
    throw cause;
  }

  if (description === '') {
    throw invalidTask(key, 'its description is empty');
  }

  const mapped = { id: key, title, description, acceptanceCriteria };
  const validated = taskSchema.safeParse(mapped);
  if (!validated.success) {
    const problems = validated.error.issues
      .map((issue) =>
        issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
      )
      .join('; ');
    throw invalidTask(key, `its description does not map to a valid task (${problems})`);
  }
  return validated.data;
}

/** One transition the workflow offers from the issue's current status. */
interface JiraTransition {
  readonly id: string;
  readonly name: string;
  readonly target: string;
  /** True when the workflow would require fields this connector cannot supply. */
  readonly needsFields: boolean;
}

async function readTransitions(
  http: HttpClient,
  id: string,
  stop: AbortSignal,
): Promise<readonly JiraTransition[]> {
  const raw = await http.request({
    method: 'GET',
    path: `/rest/api/3/issue/${encodeURIComponent(id)}/transitions?expand=transitions.fields`,
    signal: stop,
  });
  if (!isRecord(raw) || !Array.isArray(raw['transitions'])) {
    throw malformed(`the transitions of issue ${id}`, 'no transitions array');
  }
  return raw['transitions'].map((value) => {
    if (!isRecord(value)) {
      throw malformed(`the transitions of issue ${id}`, 'a transition is not an object');
    }
    const transitionId = stringField(value, 'id');
    const name = stringField(value, 'name');
    const to = nested(value, 'to');
    const target = to === null ? null : stringField(to, 'name');
    if (transitionId === null || name === null || target === null) {
      throw malformed(`the transitions of issue ${id}`, 'a transition has no id, name, or target');
    }
    const fields = value['fields'];
    const needsFields =
      isRecord(fields) &&
      Object.values(fields).some((field) => isRecord(field) && field['required'] === true);
    return { id: transitionId, name, target, needsFields };
  });
}

/**
 * The unique transition whose *target status* is `target`, selected by status
 * name rather than by a transition ID, which belongs to a workflow and not to a
 * status. A missing, ambiguous, or required-field transition is a limitation to
 * report, not something to guess around (docs/architecture.md §9).
 */
function selectTransition(
  transitions: readonly JiraTransition[],
  target: string,
  what: string,
): JiraTransition {
  const matches = transitions.filter((transition) => sameName(transition.target, target));
  if (matches.length === 0) {
    const available = transitions.map((transition) => `"${transition.target}"`).join(', ');
    throw new SourceError(
      'fatal',
      `${what}: the workflow offers no transition to the status "${target}"` +
        (transitions.length === 0 ? '' : `. Available targets: ${available}`),
    );
  }
  if (matches.length > 1) {
    throw new SourceError(
      'fatal',
      `${what}: ${String(matches.length)} transitions lead to the status "${target}", so which one ` +
        'to use is ambiguous',
    );
  }
  const [match] = matches;
  if (match === undefined) {
    throw new SourceError('fatal', `${what}: no transition to the status "${target}" was found`);
  }
  if (match.needsFields) {
    throw new SourceError(
      'fatal',
      `${what}: the transition "${match.name}" to the status "${target}" requires fields this ` +
        'harness cannot supply, so the workflow has to be changed or the issue moved by hand',
    );
  }
  return match;
}

async function postTransition(
  http: HttpClient,
  id: string,
  transitionId: string,
  stop: AbortSignal,
): Promise<void> {
  await http.request({
    method: 'POST',
    path: `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
    body: { transition: { id: transitionId } },
    signal: stop,
    mutation: true,
  });
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
 * machine. It carries no transcript, diff, environment, or credential, and it
 * never describes a failed attempt as completed (docs/spec.md §6).
 */
function commentParagraphs(ref: SourceRef, outcome: SourceRunOutcome): readonly string[] {
  return [
    `Harness run ${outcome.runId} for ${ref.key} finished: ${outcome.status}.`,
    `Reason: ${oneLine(outcome.reason)}`,
    `Checks: ${oneLine(outcome.checks)}`,
    `Repairs used: ${String(outcome.repairsUsed)}`,
    `Local artifacts on the machine that ran this harness (local paths, not Jira attachments): ` +
      `run directory ${oneLine(outcome.runDir)}; report ${oneLine(outcome.reportPath)}`,
    'A human decides what happens next; this connector never marks an issue Done and never ' +
      'publishes, merges, or commits anything.',
  ];
}

/** What {@link createJiraSource} may have substituted, for tests. */
export interface JiraSourceParts {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

/**
 * The Jira connector, built once per source command from the validated
 * configuration and the resolved token. The token lives in this closure: it is
 * not a property of the returned object, it is not written into a reference, and
 * it is stripped from the environment of anything the run starts.
 */
export function createJiraSource(
  config: JiraSourceConfig,
  token: string,
  parts: Partial<JiraSourceParts> = {},
): TaskSource {
  const http = createHttpClient(config, token, parts);

  return {
    listEligible: (stop) => listEligible(config, http, stop),

    prepare: async (candidate, stop) => {
      const issue = await readIssue(http, candidate.ref.id, stop);
      if (issue === null || !isEligible(config, issue.fields)) {
        return null;
      }
      const task = mapTask(issue);
      // The reference returned with the task carries the revision this reading
      // observed, so the claim can refuse an issue that changed again in between.
      return { ref: refFor(config, issue), task } satisfies SourceTask;
    },

    claim: async (item, stop) => {
      const issue = await readIssue(http, item.ref.id, stop);
      if (issue === null || !isEligible(config, issue.fields)) {
        return false;
      }
      if (issue.fields.updated !== item.ref.updatedAt) {
        return false;
      }
      const what = `${item.ref.key}: claiming it`;
      const chosen = selectTransition(
        await readTransitions(http, item.ref.id, stop),
        config.runningStatus,
        what,
      );
      await postTransition(http, item.ref.id, chosen.id, stop);
      return true;
    },

    complete: async (item, outcome, stop) => {
      let commentId: string;
      try {
        commentId = await postComment(
          http,
          item.ref.id,
          commentParagraphs(item.ref, outcome),
          stop,
        );
      } catch (cause) {
        if (cause instanceof SourceFeedbackError) {
          throw cause;
        }
        throw new SourceFeedbackError('comment', messageOf(cause, token));
      }

      // The result was published; the status change happens only while the issue
      // is still in the running status, so a later human decision stands.
      let current: JiraIssue | null;
      try {
        current = await readIssue(http, item.ref.id, stop);
      } catch (cause) {
        throw new SourceFeedbackError(
          'transition',
          `issue ${item.ref.key}: the result comment ${commentId} was posted, but the issue could ` +
            `not be re-read to move it to "${config.reviewStatus}" (${messageOf(cause, token)})`,
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
            `to "${config.reviewStatus}" failed (${messageOf(cause, token)})`,
          commentId,
        );
      }
    },

    // Where this attempt's work lives, written on the issue itself. One call,
    // never replayed: a write whose outcome is unknown is an uncertain-write and
    // stops intake rather than being sent again
    // (docs/implement-workspace-continuation.md).
    recordWorkspace: async (item, workspaceId, stop) => {
      await http.request({
        method: 'PUT',
        path: `/rest/api/3/issue/${encodeURIComponent(item.ref.id)}`,
        body: { update: { labels: [{ add: workspacePointerLabel(workspaceId) }] } },
        signal: stop,
        mutation: true,
      });
    },

    // A refusal is not a run: nothing was claimed and nothing ran. It still moves
    // the issue out of the queue, so the next scan does not read it again and
    // again, and it moves only while the issue is still in the queue it was found
    // in â€” a later decision by anyone else stands.
    refuse: async (item, reason, stop) => {
      let commentId: string;
      try {
        commentId = await postComment(http, item.ref.id, refusalParagraphs(item.ref, reason), stop);
      } catch (cause) {
        if (cause instanceof SourceFeedbackError) {
          throw cause;
        }
        throw new SourceFeedbackError('comment', messageOf(cause, token));
      }

      let current: JiraIssue | null;
      try {
        current = await readIssue(http, item.ref.id, stop);
      } catch (cause) {
        throw new SourceFeedbackError(
          'transition',
          `issue ${item.ref.key}: the refusal comment ${commentId} was posted, but the issue could ` +
            `not be re-read to take it out of the queue (${messageOf(cause, token)})`,
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
            `to "${config.reviewStatus}" failed (${messageOf(cause, token)})`,
          commentId,
        );
      }
    },
  };
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
