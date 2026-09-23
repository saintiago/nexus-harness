import { z } from 'zod';
import type { Result } from '../result.js';

/**
 * The Jira adapter performs explicitly requested Jira operations and returns provider data. It owns
 * authentication, REST protocol details and provider error reporting. Eligibility, claiming, status
 * policy and publication decisions belong to the calling action. Jira documents, comments and issue
 * fields stay in the provider's own structure.
 */

/** Render a thrown value as a message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ok<Value>(value: Value): Result<Value> {
  return { ok: true, value };
}

function fault(message: string): Result<never> {
  return { ok: false, fault: { message } };
}

/** A Jira rich-text document in Atlassian Document Format, preserved unchanged. */
export type JiraDocument = Readonly<Record<string, unknown>>;

/** The identity of one Jira issue. */
export type JiraIssueIdentity = {
  readonly id: string;
  readonly key: string;
};

/** One issue's current fields. The conversation is read separately from the task. */
export type JiraIssue = JiraIssueIdentity & {
  readonly fields: Readonly<Record<string, unknown>>;
};

/** The status a transition leads to. */
export type JiraStatusDetails = {
  readonly id: string;
  readonly name: string;
};

/** One transition currently permitted from an issue's status. */
export type JiraTransition = {
  readonly id: string;
  readonly name: string;
  readonly to: JiraStatusDetails;
};

/** One comment with its identity, attribution and complete provider document body. */
export type JiraComment = {
  readonly id: string;
  readonly author?: unknown;
  readonly body: unknown;
  readonly [property: string]: unknown;
};

/** The configured query and ordering of the source candidate list. */
export type JiraIssueQuery = {
  readonly query: string;
  readonly orderBy: string;
};

/** Configured mapping from the task fields Nexus sets to their Jira field identities. */
export type JiraFieldMapping = {
  readonly workspacePointer: string;
  readonly pullRequest: string;
};

export type JiraFieldName = keyof JiraFieldMapping;

/** The mapped fields one update changes. A null value clears the field. */
export type JiraFieldUpdates = Partial<Record<JiraFieldName, string | null>>;

/** Where one issue is ranked relative to an existing issue. */
export type JiraRankTarget = { readonly before: string } | { readonly after: string };

/**
 * The operator's Jira host connection. The API base is used verbatim, so a cloud connection's
 * gateway prefix (`https://api.atlassian.com/ex/jira/<cloudId>`) is preserved; the operator's API
 * token authenticates every request as a bearer token.
 */
export type JiraConnection = {
  readonly apiBase: string;
  readonly apiToken: string;
};

/** Construction settings: the host connection, the project and the configured field mapping. */
export type JiraSettings = {
  readonly connection: JiraConnection;
  readonly project: string;
  readonly fields: JiraFieldMapping;
};

/** One HTTP request the adapter makes. The transport supplies the response. */
export type JiraHttpRequest = {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
};

/** One HTTP response: the provider's status and raw body text. */
export type JiraHttpResponse = {
  readonly status: number;
  readonly body: string;
};

/** The HTTP transport, supplied so tests can control provider responses. */
export type JiraHttpTransport = (request: JiraHttpRequest) => Promise<JiraHttpResponse>;

/** The Jira operations consumers request. */
export type JiraAdapter = {
  searchIssues(selection: JiraIssueQuery): Promise<Result<readonly JiraIssueIdentity[]>>;
  readIssue(issueId: string): Promise<Result<JiraIssue>>;
  readComments(issueId: string): Promise<Result<readonly JiraComment[]>>;
  readTransitions(issueId: string): Promise<Result<readonly JiraTransition[]>>;
  updateFields(issueId: string, fields: JiraFieldUpdates): Promise<Result<void>>;
  transitionIssue(issueId: string, transitionId: string): Promise<Result<void>>;
  addComment(issueId: string, body: JiraDocument): Promise<Result<JiraComment>>;
  editComment(issueId: string, commentId: string, body: JiraDocument): Promise<Result<JiraComment>>;
  createIssue(fields: Readonly<Record<string, unknown>>): Promise<Result<JiraIssueIdentity>>;
  rankIssue(issueId: string, target: JiraRankTarget): Promise<Result<void>>;
};

/**
 * Provider response shapes, read with loose objects so every field Jira returns is preserved.
 * Only the values the adapter or its consumers use are declared.
 */
const identitySchema = z.looseObject({
  id: z.string(),
  key: z.string(),
});

const issueSchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  fields: z.record(z.string(), z.unknown()),
});

const commentSchema = z.looseObject({
  id: z.string(),
  body: z.unknown(),
});

const searchPageSchema = z.looseObject({
  issues: z.array(identitySchema),
  isLast: z.boolean().optional(),
  nextPageToken: z.string().nullish(),
});

const commentPageSchema = z.looseObject({
  comments: z.array(commentSchema),
  total: z.number(),
});

const transitionSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  to: z.looseObject({ id: z.string(), name: z.string() }),
});

const transitionsSchema = z.looseObject({
  transitions: z.array(transitionSchema),
});

const rankReportSchema = z.looseObject({
  entries: z.array(z.looseObject({ errors: z.array(z.string()).optional() })),
});

/** Perform the request with Node's fetch implementation. */
async function fetchTransport(request: JiraHttpRequest): Promise<JiraHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  return { status: response.status, body: await response.text() };
}

/** The REST path of one issue, encoding the supplied identity. */
function issuePath(issueId: string): string {
  return `/rest/api/3/issue/${encodeURIComponent(issueId)}`;
}

/** The provider's error text, which never contains connection secrets. */
function errorDetail(body: string): string {
  const text = body.trim();
  if (text === '') {
    return '';
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return '';
  }
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const messages: string[] = [];
  const { errorMessages, errors } = value as { errorMessages?: unknown; errors?: unknown };
  if (Array.isArray(errorMessages)) {
    messages.push(
      ...errorMessages.filter((message): message is string => typeof message === 'string'),
    );
  }
  if (typeof errors === 'object' && errors !== null) {
    for (const [field, message] of Object.entries(errors)) {
      if (typeof message === 'string') {
        messages.push(`${field}: ${message}`);
      }
    }
  }
  return messages.join('; ');
}

/** Describe a schema mismatch with the location of each issue. */
function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join('.') : '<response>';
      return `${location}: ${issue.message}`;
    })
    .join('; ');
}

/** Create the Jira adapter over the supplied connection and configured mappings. */
export function createJiraAdapter(
  settings: JiraSettings,
  transport: JiraHttpTransport = fetchTransport,
): JiraAdapter {
  // REST paths are appended to the configured API base, preserving any gateway prefix.
  const base = settings.connection.apiBase.replace(/\/+$/u, '');
  // The host connection's token authenticates every request; only the header carries it.
  const authorization = `Bearer ${settings.connection.apiToken}`;

  /** Perform one request, reporting transport failures and provider errors as faults. */
  async function perform(
    method: JiraHttpRequest['method'],
    path: string,
    body?: unknown,
  ): Promise<Result<{ readonly status: number; readonly value: unknown }>> {
    let response: JiraHttpResponse;
    try {
      response = await transport({
        method,
        url: `${base}${path}`,
        headers: {
          accept: 'application/json',
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      return fault(`Jira ${method} ${path} failed: ${messageOf(error)}`);
    }
    if (response.status < 200 || response.status > 299) {
      const detail = errorDetail(response.body);
      const suffix = detail === '' ? '' : `: ${detail}`;
      return fault(`Jira ${method} ${path} failed with status ${response.status}${suffix}`);
    }
    const text = response.body.trim();
    if (text === '') {
      return ok({ status: response.status, value: undefined });
    }
    try {
      return ok({ status: response.status, value: JSON.parse(text) as unknown });
    } catch {
      return fault(`Jira ${method} ${path} returned a body that is not JSON`);
    }
  }

  /** Perform one request and validate its value with the supplied provider schema. */
  async function request<Value>(
    method: JiraHttpRequest['method'],
    path: string,
    schema: z.ZodType<Value>,
    body?: unknown,
  ): Promise<Result<Value>> {
    const response = await perform(method, path, body);
    if (!response.ok) {
      return response;
    }
    const parsed = schema.safeParse(response.value.value);
    if (!parsed.success) {
      return fault(
        `Jira ${method} ${path} returned an unexpected response: ${describe(parsed.error)}`,
      );
    }
    return ok(parsed.data);
  }

  /** Perform a write whose provider response body carries no data. */
  async function write(
    method: JiraHttpRequest['method'],
    path: string,
    body?: unknown,
  ): Promise<Result<void>> {
    const response = await perform(method, path, body);
    return response.ok ? ok(undefined) : response;
  }

  /** Read the candidate list in configured order, following every page. */
  async function searchIssues(
    selection: JiraIssueQuery,
  ): Promise<Result<readonly JiraIssueIdentity[]>> {
    const jql = `${selection.query} order by ${selection.orderBy}`;
    const identities: JiraIssueIdentity[] = [];
    const followedTokens = new Set<string>();
    let token: string | undefined;
    for (;;) {
      const page = await request(
        'POST',
        '/rest/api/3/search/jql',
        searchPageSchema,
        token === undefined ? { jql } : { jql, nextPageToken: token },
      );
      if (!page.ok) {
        return page;
      }
      identities.push(...page.value.issues.map((issue) => ({ id: issue.id, key: issue.key })));
      const next = page.value.nextPageToken ?? undefined;
      if (page.value.isLast === true) {
        return ok(identities);
      }
      if (next === undefined) {
        // Claiming more pages without a continuation token cannot produce the complete list.
        return fault('Jira search reported more pages without a next page token');
      }
      if (followedTokens.has(next)) {
        // A repeated token cannot advance the collection; report it instead of looping.
        return fault(`Jira search repeated page token "${next}"`);
      }
      followedTokens.add(next);
      token = next;
    }
  }

  /** Read one issue's current fields. The embedded conversation is excluded; read it separately. */
  async function readIssue(issueId: string): Promise<Result<JiraIssue>> {
    const fields = new URLSearchParams({ fields: '*all,-comment' });
    return request('GET', `${issuePath(issueId)}?${fields.toString()}`, issueSchema);
  }

  /** Read every comment on one issue, preserving the provider's order and attribution. */
  async function readComments(issueId: string): Promise<Result<readonly JiraComment[]>> {
    const comments: JiraComment[] = [];
    for (;;) {
      const startAt = new URLSearchParams({ startAt: String(comments.length) });
      const page = await request(
        'GET',
        `${issuePath(issueId)}/comment?${startAt.toString()}`,
        commentPageSchema,
      );
      if (!page.ok) {
        return page;
      }
      comments.push(...page.value.comments);
      if (comments.length >= page.value.total) {
        return ok(comments);
      }
      if (page.value.comments.length === 0) {
        return fault(
          `Jira returned no comments at offset ${comments.length} while reporting ${page.value.total} comments for issue ${issueId}`,
        );
      }
    }
  }

  /** Read the transitions currently permitted from one issue's status. */
  async function readTransitions(issueId: string): Promise<Result<readonly JiraTransition[]>> {
    const transitions = await request(
      'GET',
      `${issuePath(issueId)}/transitions`,
      transitionsSchema,
    );
    return transitions.ok ? ok(transitions.value.transitions) : transitions;
  }

  /** Change the mapped fields of one issue. */
  async function updateFields(issueId: string, fields: JiraFieldUpdates): Promise<Result<void>> {
    const translated: Record<string, string | null> = {};
    if (fields.workspacePointer !== undefined) {
      translated[settings.fields.workspacePointer] = fields.workspacePointer;
    }
    if (fields.pullRequest !== undefined) {
      translated[settings.fields.pullRequest] = fields.pullRequest;
    }
    return write('PUT', issuePath(issueId), { fields: translated });
  }

  /**
   * Transition one issue through the explicit transition its caller selected, typically after
   * reading the issue's permitted transitions.
   */
  async function transitionIssue(issueId: string, transitionId: string): Promise<Result<void>> {
    return write('POST', `${issuePath(issueId)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  /** Add one comment with the supplied document body. */
  async function addComment(issueId: string, body: JiraDocument): Promise<Result<JiraComment>> {
    return request('POST', `${issuePath(issueId)}/comment`, commentSchema, { body });
  }

  /** Replace the body of one existing comment. */
  async function editComment(
    issueId: string,
    commentId: string,
    body: JiraDocument,
  ): Promise<Result<JiraComment>> {
    const path = `${issuePath(issueId)}/comment/${encodeURIComponent(commentId)}`;
    return request('PUT', path, commentSchema, { body });
  }

  /** Create one issue in the configured project with the requested fields. */
  async function createIssue(
    fields: Readonly<Record<string, unknown>>,
  ): Promise<Result<JiraIssueIdentity>> {
    // The configured project owns the target; the caller supplies the remaining fields.
    const requested = { ...fields, project: { key: settings.project } };
    const created = await request('POST', '/rest/api/3/issue', identitySchema, {
      fields: requested,
    });
    return created.ok ? ok({ id: created.value.id, key: created.value.key }) : created;
  }

  /** Rank one issue before or after an existing issue. Priority is a separate field. */
  async function rankIssue(issueId: string, target: JiraRankTarget): Promise<Result<void>> {
    const placement =
      'before' in target ? { rankBeforeIssue: target.before } : { rankAfterIssue: target.after };
    const response = await perform('PUT', '/rest/agile/1.0/issue/rank', {
      issues: [issueId],
      ...placement,
    });
    if (!response.ok) {
      return response;
    }
    if (response.value.status === 204) {
      return ok(undefined);
    }
    // A multi-status answer reports per-issue outcomes; the requested ranking did not take effect.
    const report = rankReportSchema.safeParse(response.value.value);
    const details = report.success
      ? report.data.entries.flatMap((entry) => entry.errors ?? []).join('; ')
      : '';
    const suffix = details === '' ? '' : `: ${details}`;
    return fault(`Jira rank request reported status ${response.value.status}${suffix}`);
  }

  return {
    searchIssues,
    readIssue,
    readComments,
    readTransitions,
    updateFields,
    transitionIssue,
    addComment,
    editComment,
    createIssue,
    rankIssue,
  };
}
