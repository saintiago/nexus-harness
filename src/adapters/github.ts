import { createSign } from 'node:crypto';
import { z } from 'zod';
import type { ProcessOutputObserver, ProcessResult } from './processes.js';
import { fault, messageOf, ok, type Result } from '../result.js';

/**
 * The GitHub adapter performs explicitly requested GitHub operations and returns observed
 * repository and pull-request data. It owns the operator's `gh` CLI invocation, the Nexus Lens
 * GitHub App installation token and provider error reporting. Decisions such as which pull
 * request to reuse or whether a gate is satisfied belong to the calling action.
 *
 * Operator operations run through the authenticated `gh` CLI, so the operator's login is used
 * for pull-request creation, updates and auto-merge requests. Review and review-check publication
 * use an installation token obtained from the Nexus Lens App private key. App credentials and
 * tokens stay inside this adapter; they are never returned, persisted or written to diagnostics.
 */

/** Run one `gh` command. The caller supplies the executable, environment and process handling. */
export type GhCommandExecution = (
  args: readonly string[],
  onOutput: ProcessOutputObserver,
) => Promise<ProcessResult>;

/** One HTTP request the adapter makes as the Nexus Lens App. The transport supplies the response. */
export type GitHubHttpRequest = {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
};

/** One HTTP response: the provider's status and raw body text. */
export type GitHubHttpResponse = {
  readonly status: number;
  readonly body: string;
};

/** The HTTP transport, supplied so tests can control provider responses. */
export type GitHubHttpTransport = (request: GitHubHttpRequest) => Promise<GitHubHttpResponse>;

/** The Nexus Lens GitHub App installation used for review publication. */
export type NexusLensApp = {
  readonly appId: number;
  readonly installationId: number;
  /** The App's PEM private key, used only to sign installation-token requests. */
  readonly privateKey: string;
};

/** Construction settings: the operator's authenticated CLI and the Nexus Lens App installation. */
export type GitHubSettings = {
  readonly gh: GhCommandExecution;
  readonly nexusLens: NexusLensApp;
};

/** A repository in `owner/name` form on the operator's GitHub host. */
export type GitHubRepository = string;

/** The identity of one pull request. */
export type PullRequestIdentity = {
  readonly number: number;
  readonly url: string;
};

/** The branch and base branch a pull request must match. */
export type PullRequestBranchFilter = {
  readonly branch: string;
  readonly baseBranch: string;
};

/** The observed state of one pull request. */
export type PullRequest = PullRequestIdentity & {
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly baseBranch: string;
  readonly headRevision: string;
  /** The merge commit, reported only after the provider reports the pull request merged. */
  readonly mergeRevision: string | null;
  readonly autoMergeEnabled: boolean;
};

/** The fields of one new pull request. */
export type PullRequestCreation = {
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
};

/** The pull request fields one update changes. */
export type PullRequestUpdates = {
  readonly title?: string;
  readonly body?: string;
};

/** The identity, URL and head of a created or updated pull request. */
export type PullRequestPublication = PullRequestIdentity & {
  readonly headRevision: string;
};

/** One conversation comment, preserved in the provider's structure. */
export type GitHubComment = {
  readonly id: number;
  readonly body: string;
  readonly [property: string]: unknown;
};

/** One submitted review with its state, body and the revision it reviewed. */
export type GitHubReview = {
  readonly id: number;
  readonly state: string;
  readonly body: string;
  readonly commit_id: string | null;
  readonly [property: string]: unknown;
};

/** One inline review comment; replies keep the provider's `in_reply_to_id` thread reference. */
export type GitHubReviewComment = {
  readonly id: number;
  readonly body: string;
  readonly [property: string]: unknown;
};

/** The complete conversation and reviews of one pull request. */
export type PullRequestConversation = {
  readonly comments: readonly GitHubComment[];
  readonly reviews: readonly GitHubReview[];
  readonly reviewComments: readonly GitHubReviewComment[];
};

/** The verdict the calling action recorded for one reviewed revision. */
export type ReviewVerdict = 'approved' | 'changesRequested' | 'inconclusive';

/** One review to publish as the Nexus Lens App for an exact revision. */
export type ReviewPublicationRequest = {
  readonly pullRequestNumber: number;
  /** The reviewed head the review applies to. */
  readonly revision: string;
  readonly verdict: ReviewVerdict;
  readonly body: string;
};

/** The identity of one published review. */
export type ReviewIdentity = {
  readonly id: number;
  readonly url: string;
};

/** The App that produced one check run, when the provider names it. */
export type CheckProducer = {
  readonly id: number;
  readonly slug: string | null;
  readonly name: string;
};

/** One check run observed for a revision. */
export type CheckObservation = {
  readonly id: number;
  readonly revision: string;
  readonly name: string;
  readonly producer: CheckProducer | null;
  readonly status: string;
  readonly conclusion: string | null;
};

/** One review-check result to publish or update as the Nexus Lens App. */
export type ReviewCheckPublicationRequest = {
  readonly revision: string;
  /** The configured review check name the repository requires. */
  readonly name: string;
  readonly result: 'success' | 'failure';
};

/** The identity of the published check run. */
export type ReviewCheckIdentity = {
  readonly id: number;
};

/** One job of a workflow run. */
export type WorkflowJobObservation = {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly revision: string;
};

/** One run of a configured workflow for a revision. */
export type WorkflowRunObservation = {
  readonly id: number;
  readonly name: string | null;
  readonly path: string;
  readonly revision: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly jobs: readonly WorkflowJobObservation[];
};

/** The GitHub operations consumers request. */
export type GitHubAdapter = {
  findPullRequests(
    repository: GitHubRepository,
    filter: PullRequestBranchFilter,
  ): Promise<Result<readonly PullRequestIdentity[]>>;
  readPullRequest(
    repository: GitHubRepository,
    pullRequestNumber: number,
  ): Promise<Result<PullRequest>>;
  createPullRequest(
    repository: GitHubRepository,
    creation: PullRequestCreation,
  ): Promise<Result<PullRequestPublication>>;
  updatePullRequest(
    repository: GitHubRepository,
    pullRequestNumber: number,
    updates: PullRequestUpdates,
  ): Promise<Result<PullRequestPublication>>;
  readConversation(
    repository: GitHubRepository,
    pullRequestNumber: number,
  ): Promise<Result<PullRequestConversation>>;
  publishReview(
    repository: GitHubRepository,
    review: ReviewPublicationRequest,
  ): Promise<Result<ReviewIdentity>>;
  readChecks(
    repository: GitHubRepository,
    revision: string,
  ): Promise<Result<readonly CheckObservation[]>>;
  publishReviewCheck(
    repository: GitHubRepository,
    publication: ReviewCheckPublicationRequest,
  ): Promise<Result<ReviewCheckIdentity>>;
  requestAutoMerge(
    repository: GitHubRepository,
    pullRequestNumber: number,
    expectedHeadRevision: string,
  ): Promise<Result<void>>;
  readWorkflowRuns(
    repository: GitHubRepository,
    revision: string,
    workflows: readonly string[],
  ): Promise<Result<readonly WorkflowRunObservation[]>>;
};

/**
 * Provider response shapes, read with loose objects so every field GitHub returns is preserved.
 * Only the values the adapter or its consumers use are declared.
 */
const pullRequestIdentitySchema = z.looseObject({
  number: z.number().int(),
  html_url: z.string(),
});

const pullRequestSchema = z.looseObject({
  number: z.number().int(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merge_commit_sha: z.string().nullable(),
  head: z.looseObject({ sha: z.string() }),
  base: z.looseObject({ ref: z.string() }),
  auto_merge: z.record(z.string(), z.unknown()).nullable(),
});

const pullRequestPublicationSchema = z.looseObject({
  number: z.number().int(),
  html_url: z.string(),
  head: z.looseObject({ sha: z.string() }),
});

const pullRequestNodeSchema = z.looseObject({
  node_id: z.string(),
});

const commentSchema = z.looseObject({
  id: z.number().int(),
  body: z.string(),
});

const reviewSchema = z.looseObject({
  id: z.number().int(),
  state: z.string(),
  body: z.string(),
  commit_id: z.string().nullable(),
});

const reviewCommentSchema = z.looseObject({
  id: z.number().int(),
  body: z.string(),
});

const reviewIdentitySchema = z.looseObject({
  id: z.number().int(),
  html_url: z.string(),
});

const checkSchema = z.looseObject({
  id: z.number().int(),
  head_sha: z.string(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z
    .looseObject({
      id: z.number().int(),
      name: z.string(),
      slug: z.string().optional(),
    })
    .nullable(),
});

const checkPageSchema = z.looseObject({
  check_runs: z.array(checkSchema),
});

const checkIdentitySchema = z.looseObject({
  id: z.number().int(),
});

const existingCheckPageSchema = z.looseObject({
  check_runs: z.array(checkIdentitySchema),
});

const workflowRunSchema = z.looseObject({
  id: z.number().int(),
  name: z.string().nullable(),
  path: z.string(),
  head_sha: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
});

const jobSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_sha: z.string(),
});

const workflowRunPageSchema = z.looseObject({
  workflow_runs: z.array(workflowRunSchema),
});

const jobPageSchema = z.looseObject({
  jobs: z.array(jobSchema),
});

const installationTokenSchema = z.looseObject({
  token: z.string(),
  expires_at: z.string(),
});

const autoMergeAcceptanceSchema = z.looseObject({
  data: z.looseObject({
    enablePullRequestAutoMerge: z.record(z.string(), z.unknown()),
  }),
});

/** The provider's review event for each verdict Nexus publishes. */
const reviewEvents: Readonly<Record<ReviewVerdict, string>> = {
  approved: 'APPROVE',
  changesRequested: 'REQUEST_CHANGES',
  inconclusive: 'COMMENT',
};

/**
 * The operator's identity enables native auto-merge with the reviewed head as the provider's
 * precondition. Omitting the merge method leaves GitHub's documented default in force.
 */
const enableAutoMergeMutation = `mutation EnableAutoMerge($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid}) {
    pullRequest { number }
  }
}`;

/** The GitHub API the Nexus Lens App installation talks to. */
const githubApiBase = 'https://api.github.com';

/** The provider's page size for numbered collection reads. */
const pageSize = 100;

/** Renew the installation token this long before its reported expiry. */
const tokenRenewalMarginMs = 60_000;

/** Sign App JWTs for less than the provider's ten-minute limit. */
const jwtLifetimeSeconds = 540;

/** One completed `gh` command with its collected output. */
type CompletedCommand = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Perform the App request with Node's fetch implementation. */
async function fetchTransport(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  return { status: response.status, body: await response.text() };
}

/** Encode one JWT part as base64url. */
function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
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

/** The provider's error text, which never contains adapter credentials. */
function providerDetail(body: string): string {
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
  const { message, errors } = value as { message?: unknown; errors?: unknown };
  if (typeof message === 'string') {
    messages.push(message);
  }
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === 'string') {
        messages.push(entry);
      } else if (typeof entry === 'object' && entry !== null) {
        const detail = (entry as { message?: unknown }).message;
        if (typeof detail === 'string') {
          messages.push(detail);
        }
      }
    }
  }
  return messages.join('; ');
}

/** Create the GitHub adapter over the supplied operator CLI and Nexus Lens App installation. */
export function createGitHubAdapter(
  settings: GitHubSettings,
  transport: GitHubHttpTransport = fetchTransport,
): GitHubAdapter {
  const { appId, installationId, privateKey } = settings.nexusLens;
  let cachedToken: { readonly value: string; readonly expiresAtMs: number } | undefined;

  /** Run the operator's gh CLI and collect its complete output. */
  async function attempt(args: readonly string[]): Promise<Result<CompletedCommand>> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const result = await settings.gh(args, (output) => {
      (output.stream === 'stdout' ? stdout : stderr).push(output.chunk);
    });
    if (!result.ok) {
      return result;
    }
    return ok({
      exitCode: result.value.exitCode,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });
  }

  /**
   * Perform one request through the operator's gh CLI and return its parsed body. The operator's
   * gh authentication is the only credential involved.
   */
  async function cliRequest(
    method: GitHubHttpRequest['method'],
    path: string,
    fields?: Readonly<Record<string, string>>,
  ): Promise<Result<unknown>> {
    const args = [
      'api',
      '--method',
      method,
      path,
      ...Object.entries(fields ?? {}).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
    ];
    const command = await attempt(args);
    if (!command.ok) {
      return command;
    }
    if (command.value.exitCode !== 0) {
      const diagnostics =
        command.value.stderr.trim() || command.value.stdout.trim() || 'no diagnostics';
      return fault(
        `gh api ${method} ${path} failed with exit code ${command.value.exitCode}: ${diagnostics}`,
      );
    }
    const text = command.value.stdout.trim();
    if (text === '') {
      return ok(undefined);
    }
    try {
      return ok(JSON.parse(text) as unknown);
    } catch {
      return fault(`gh api ${method} ${path} returned a body that is not JSON`);
    }
  }

  /** Perform one CLI request and validate its body with the supplied provider schema. */
  async function cliValue<Value>(
    method: GitHubHttpRequest['method'],
    path: string,
    schema: z.ZodType<Value>,
    fields?: Readonly<Record<string, string>>,
  ): Promise<Result<Value>> {
    const response = await cliRequest(method, path, fields);
    if (!response.ok) {
      return response;
    }
    const parsed = schema.safeParse(response.value);
    if (!parsed.success) {
      return fault(
        `gh api ${method} ${path} returned an unexpected response: ${describe(parsed.error)}`,
      );
    }
    return ok(parsed.data);
  }

  /** Read every page of one numbered provider collection. */
  async function readPages<Page, Entry>(
    path: (page: number) => string,
    schema: z.ZodType<Page>,
    entriesOf: (page: Page) => readonly Entry[],
  ): Promise<Result<readonly Entry[]>> {
    const all: Entry[] = [];
    for (let page = 1; ; page += 1) {
      const result = await cliValue('GET', path(page), schema);
      if (!result.ok) {
        return result;
      }
      const entries = entriesOf(result.value);
      all.push(...entries);
      if (entries.length < pageSize) {
        return ok(all);
      }
    }
  }

  /** The repository's API path and owner, or a fault for an identity outside owner/name form. */
  function repositoryApiPath(
    repository: GitHubRepository,
  ): Result<{ readonly owner: string; readonly path: string }> {
    const segments = repository.split('/');
    const [owner, name] = segments;
    if (
      segments.length !== 2 ||
      owner === undefined ||
      name === undefined ||
      owner.trim() === '' ||
      name.trim() === ''
    ) {
      return fault(`"${repository}" is not a GitHub repository in owner/name form`);
    }
    return ok({ owner, path: `${encodeURIComponent(owner)}/${encodeURIComponent(name)}` });
  }

  /** Sign one short-lived Nexus Lens App JWT. */
  function appJwt(now: number): string {
    // The provider requires iat in the past for clock drift and exp within ten minutes.
    const issuedAt = Math.floor(now / 1000) - 60;
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(
      JSON.stringify({ iat: issuedAt, exp: issuedAt + 60 + jwtLifetimeSeconds, iss: appId }),
    );
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
    return `${header}.${payload}.${base64Url(signature)}`;
  }

  /**
   * Obtain the installation token, reusing it while it is valid and renewing it when it expires
   * or the provider rejects it. The operator's gh login is untouched.
   */
  async function installationAccessToken(
    forceRenewal: boolean,
  ): Promise<Result<{ readonly value: string; readonly reused: boolean }>> {
    const now = Date.now();
    if (
      !forceRenewal &&
      cachedToken !== undefined &&
      now < cachedToken.expiresAtMs - tokenRenewalMarginMs
    ) {
      return ok({ value: cachedToken.value, reused: true });
    }
    let jwt: string;
    try {
      jwt = appJwt(now);
    } catch (error) {
      return fault(`Cannot sign the Nexus Lens App JWT: ${messageOf(error)}`);
    }
    let response: GitHubHttpResponse;
    try {
      response = await transport({
        method: 'POST',
        url: `${githubApiBase}/app/installations/${installationId}/access_tokens`,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'x-github-api-version': '2022-11-28',
        },
      });
    } catch (error) {
      return fault(`Cannot request a Nexus Lens installation token: ${messageOf(error)}`);
    }
    if (response.status < 200 || response.status > 299) {
      const detail = providerDetail(response.body);
      const suffix = detail === '' ? '' : `: ${detail}`;
      return fault(
        `Cannot request a Nexus Lens installation token: status ${response.status}${suffix}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(response.body.trim()) as unknown;
    } catch {
      return fault('The Nexus Lens installation token response is not JSON');
    }
    const parsed = installationTokenSchema.safeParse(value);
    if (!parsed.success) {
      return fault(
        `The Nexus Lens installation token response was unexpected: ${describe(parsed.error)}`,
      );
    }
    const expiresAtMs = Date.parse(parsed.data.expires_at);
    if (Number.isNaN(expiresAtMs)) {
      return fault('The Nexus Lens installation token response has no usable expiry');
    }
    cachedToken = { value: parsed.data.token, expiresAtMs };
    return ok({ value: parsed.data.token, reused: false });
  }

  /** Send one App-authenticated request. */
  async function appSend(
    token: string,
    method: GitHubHttpRequest['method'],
    path: string,
    body?: unknown,
  ): Promise<Result<GitHubHttpResponse>> {
    try {
      const response = await transport({
        method,
        url: `${githubApiBase}${path}`,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return ok(response);
    } catch (error) {
      return fault(`GitHub ${method} ${path} failed: ${messageOf(error)}`);
    }
  }

  /**
   * Perform one request as the Nexus Lens App and validate its body. A cached token the provider
   * rejects is renewed once before the response is reported.
   */
  async function appValue<Value>(
    method: GitHubHttpRequest['method'],
    path: string,
    schema: z.ZodType<Value>,
    body?: unknown,
  ): Promise<Result<Value>> {
    const token = await installationAccessToken(false);
    if (!token.ok) {
      return token;
    }
    let response = await appSend(token.value.value, method, path, body);
    if (!response.ok) {
      return response;
    }
    if (response.value.status === 401 && token.value.reused) {
      const renewed = await installationAccessToken(true);
      if (!renewed.ok) {
        return renewed;
      }
      response = await appSend(renewed.value.value, method, path, body);
      if (!response.ok) {
        return response;
      }
    }
    const { status, body: text } = response.value;
    if (status < 200 || status > 299) {
      const detail = providerDetail(text);
      const suffix = detail === '' ? '' : `: ${detail}`;
      return fault(`GitHub ${method} ${path} failed with status ${status}${suffix}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text.trim()) as unknown;
    } catch {
      return fault(`GitHub ${method} ${path} returned a body that is not JSON`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return fault(
        `GitHub ${method} ${path} returned an unexpected response: ${describe(parsed.error)}`,
      );
    }
    return ok(parsed.data);
  }

  return {
    /** Find matching pull requests in the provider's order, including closed ones. */
    async findPullRequests(repository, filter) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const found = await readPages(
        (page) =>
          `/repos/${target.value.path}/pulls?${new URLSearchParams({
            state: 'all',
            head: `${target.value.owner}:${filter.branch}`,
            base: filter.baseBranch,
            per_page: String(pageSize),
            page: String(page),
          }).toString()}`,
        z.array(pullRequestIdentitySchema),
        (page) => page,
      );
      if (!found.ok) {
        return found;
      }
      return ok(found.value.map((pull) => ({ number: pull.number, url: pull.html_url })));
    },

    async readPullRequest(repository, pullRequestNumber) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const pull = await cliValue(
        'GET',
        `/repos/${target.value.path}/pulls/${pullRequestNumber}`,
        pullRequestSchema,
      );
      if (!pull.ok) {
        return pull;
      }
      const { value } = pull;
      if (value.merged && value.merge_commit_sha === null) {
        // A merge without its revision cannot be reported as the actual merge state.
        return fault(
          `GitHub reported pull request ${pullRequestNumber} merged without a merge revision`,
        );
      }
      return ok({
        number: value.number,
        url: value.html_url,
        state: value.state,
        merged: value.merged,
        baseBranch: value.base.ref,
        headRevision: value.head.sha,
        // Before merging, merge_commit_sha names the provider's test merge commit.
        mergeRevision: value.merged ? value.merge_commit_sha : null,
        autoMergeEnabled: value.auto_merge !== null,
      });
    },

    async createPullRequest(repository, creation) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const created = await cliValue(
        'POST',
        `/repos/${target.value.path}/pulls`,
        pullRequestPublicationSchema,
        {
          title: creation.title,
          head: creation.headBranch,
          base: creation.baseBranch,
          body: creation.body,
        },
      );
      return created.ok
        ? ok({
            number: created.value.number,
            url: created.value.html_url,
            headRevision: created.value.head.sha,
          })
        : created;
    },

    async updatePullRequest(repository, pullRequestNumber, updates) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const fields: Record<string, string> = {};
      if (updates.title !== undefined) {
        fields['title'] = updates.title;
      }
      if (updates.body !== undefined) {
        fields['body'] = updates.body;
      }
      const updated = await cliValue(
        'PATCH',
        `/repos/${target.value.path}/pulls/${pullRequestNumber}`,
        pullRequestPublicationSchema,
        fields,
      );
      return updated.ok
        ? ok({
            number: updated.value.number,
            url: updated.value.html_url,
            headRevision: updated.value.head.sha,
          })
        : updated;
    },

    async readConversation(repository, pullRequestNumber) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const path = target.value.path;
      const pageQuery = (page: number): string =>
        new URLSearchParams({ per_page: String(pageSize), page: String(page) }).toString();
      const comments = await readPages(
        (page) => `/repos/${path}/issues/${pullRequestNumber}/comments?${pageQuery(page)}`,
        z.array(commentSchema),
        (page) => page,
      );
      if (!comments.ok) {
        return comments;
      }
      const reviews = await readPages(
        (page) => `/repos/${path}/pulls/${pullRequestNumber}/reviews?${pageQuery(page)}`,
        z.array(reviewSchema),
        (page) => page,
      );
      if (!reviews.ok) {
        return reviews;
      }
      const reviewComments = await readPages(
        (page) => `/repos/${path}/pulls/${pullRequestNumber}/comments?${pageQuery(page)}`,
        z.array(reviewCommentSchema),
        (page) => page,
      );
      if (!reviewComments.ok) {
        return reviewComments;
      }
      return ok({
        comments: comments.value,
        reviews: reviews.value,
        reviewComments: reviewComments.value,
      });
    },

    async publishReview(repository, review) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const published = await appValue(
        'POST',
        `/repos/${target.value.path}/pulls/${review.pullRequestNumber}/reviews`,
        reviewIdentitySchema,
        {
          commit_id: review.revision,
          body: review.body,
          event: reviewEvents[review.verdict],
        },
      );
      return published.ok
        ? ok({ id: published.value.id, url: published.value.html_url })
        : published;
    },

    async readChecks(repository, revision) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const checks = await readPages(
        (page) =>
          `/repos/${target.value.path}/commits/${encodeURIComponent(revision)}/check-runs?${new URLSearchParams(
            { per_page: String(pageSize), page: String(page) },
          ).toString()}`,
        checkPageSchema,
        (page) => page.check_runs,
      );
      if (!checks.ok) {
        return checks;
      }
      return ok(
        checks.value.map((check) => ({
          id: check.id,
          revision: check.head_sha,
          name: check.name,
          producer:
            check.app === null
              ? null
              : { id: check.app.id, slug: check.app.slug ?? null, name: check.app.name },
          status: check.status,
          conclusion: check.conclusion,
        })),
      );
    },

    async publishReviewCheck(repository, publication) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const path = target.value.path;
      // The configured check for this revision is updated when the App published it before.
      const existing = await appValue(
        'GET',
        `/repos/${path}/commits/${encodeURIComponent(publication.revision)}/check-runs?${new URLSearchParams(
          { check_name: publication.name, app_id: String(appId), per_page: '1' },
        ).toString()}`,
        existingCheckPageSchema,
      );
      if (!existing.ok) {
        return existing;
      }
      const [found] = existing.value.check_runs;
      const result = { status: 'completed', conclusion: publication.result };
      const written =
        found === undefined
          ? await appValue('POST', `/repos/${path}/check-runs`, checkIdentitySchema, {
              name: publication.name,
              head_sha: publication.revision,
              ...result,
            })
          : await appValue(
              'PATCH',
              `/repos/${path}/check-runs/${found.id}`,
              checkIdentitySchema,
              result,
            );
      return written.ok ? ok({ id: written.value.id }) : written;
    },

    async requestAutoMerge(repository, pullRequestNumber, expectedHeadRevision) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const pull = await cliValue(
        'GET',
        `/repos/${target.value.path}/pulls/${pullRequestNumber}`,
        pullRequestNodeSchema,
      );
      if (!pull.ok) {
        return pull;
      }
      const acceptance = await cliRequest('POST', 'graphql', {
        query: enableAutoMergeMutation,
        pullRequestId: pull.value.node_id,
        expectedHeadOid: expectedHeadRevision,
      });
      if (!acceptance.ok) {
        return acceptance;
      }
      const parsed = autoMergeAcceptanceSchema.safeParse(acceptance.value);
      if (!parsed.success) {
        return fault(
          `GitHub reported no auto-merge acceptance for pull request ${pullRequestNumber}: ${describe(
            parsed.error,
          )}`,
        );
      }
      return ok(undefined);
    },

    /**
     * Read the runs of the configured workflows for one revision, with their jobs. A configured
     * workflow without a run for the revision is simply absent from the observation.
     */
    async readWorkflowRuns(repository, revision, workflows) {
      const target = repositoryApiPath(repository);
      if (!target.ok) {
        return target;
      }
      const path = target.value.path;
      const runs = await readPages(
        (page) =>
          `/repos/${path}/actions/runs?${new URLSearchParams({
            head_sha: revision,
            per_page: String(pageSize),
            page: String(page),
          }).toString()}`,
        workflowRunPageSchema,
        (page) => page.workflow_runs,
      );
      if (!runs.ok) {
        return runs;
      }
      const runsOfConfiguredWorkflows = runs.value.filter(
        (run) => workflows.includes(run.name ?? '') || workflows.includes(run.path),
      );
      const observations: WorkflowRunObservation[] = [];
      for (const run of runsOfConfiguredWorkflows) {
        const jobs = await readPages(
          (page) =>
            `/repos/${path}/actions/runs/${run.id}/jobs?${new URLSearchParams({
              per_page: String(pageSize),
              page: String(page),
            }).toString()}`,
          jobPageSchema,
          (page) => page.jobs,
        );
        if (!jobs.ok) {
          return jobs;
        }
        observations.push({
          id: run.id,
          name: run.name,
          path: run.path,
          revision: run.head_sha,
          status: run.status,
          conclusion: run.conclusion,
          jobs: jobs.value.map((job) => ({
            id: job.id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            revision: job.head_sha,
          })),
        });
      }
      return ok(observations);
    },
  };
}
