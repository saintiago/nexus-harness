/**
 * The GitHub side of the review path: the App's installation identity, the
 * repository's pull requests, reviews, checks, and what a reviewer turn is told
 * about them.
 *
 * Every call is made as a GitHub App installation: a short-lived RS256 JWT
 * signed with the App's private key is exchanged for an installation access
 * token, and only that token reaches the repository. The key is read from the
 * PEM file the configured environment variable names; the key's contents, the
 * JWT, and the installation token are never written to a log, a record, a
 * report, or a message — a diagnostic that could carry one is redacted.
 *
 * The client is the repository boundary the scan uses, and nothing above it
 * knows a URL, a header, or a payload shape. It never merges, never changes an
 * issue, and never writes to a working copy: the only writes it makes are the
 * native review and the app-owned check run the scan decided.
 */
import { createPrivateKey, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { messageOf } from '../shared/errors.js';
import type { GitHubReviewConfig, SourceRef, Task } from '../shared/types.js';
import type {
  AppCheckRun,
  ChangedFile,
  CheckEvidence,
  OpenPullRequest,
  PublishCheckRequest,
  PublishReviewRequest,
  PublishedCheck,
  PublishedReview,
  PullRequestConversation,
  PullRequestConversationEntry,
  PullRequestReview,
  ReviewEvidence,
  ReviewRepository,
} from './contract.js';
import { ReviewError } from './contract.js';

/** The GitHub REST API origin used in production. */
export const GITHUB_API_BASE_URL = 'https://api.github.com';
/** How long one GitHub request may take, in milliseconds. */
export const REVIEW_REQUEST_TIMEOUT_MS = 30_000;
/** The API version every request asks for. */
export const GITHUB_API_VERSION = '2022-11-28';
/** How much of a GitHub answer a diagnostic repeats; the rest is truncated. */
const MAX_DIAGNOSTIC_CHARS = 400;
/** How many pages of one list endpoint a read follows, at 100 items a page. */
const MAX_LIST_PAGES = 3;
/**
 * How many pages the history's conversation read follows. It is higher than the
 * bounded list reads above because the history is the complete local record, and
 * a page limit that is reached is reported rather than passed off as the whole
 * conversation.
 */
const MAX_CONVERSATION_PAGES = 20;
/** The largest list a single read carries. */
const LIST_PAGE_SIZE = 100;
/** How many of the head's check runs the evidence keeps. */
const MAX_EVIDENCE_CHECKS = 30;

/** What a caller may substitute in the transport, for tests. */
export interface GitHubReviewParts {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  /** The API origin; production is {@link GITHUB_API_BASE_URL}. */
  readonly apiBaseUrl: string;
}

/**
 * Resolves the App's private key from the environment variable the
 * configuration names and the PEM file it points at. The value is validated as
 * an RSA private key before anything is signed with it; a missing variable, an
 * unreadable file, and a key of the wrong kind are all refused by name, and the
 * key's contents never appear in a message.
 */
export async function resolveAppPrivateKey(
  config: GitHubReviewConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const name = config.app.privateKeyPathEnv;
  const raw = environment[name];
  const file = typeof raw === 'string' ? raw.trim() : '';
  if (file === '') {
    throw new ReviewError(
      'credentials',
      `the environment variable ${name} is missing or blank. Put the path of the GitHub App's ` +
        'private key PEM file in it before running a review command; the key is never read from ' +
        'the configuration file, and its contents are never logged.',
    );
  }

  let pem: string;
  try {
    pem = await readKeyFile(file);
  } catch (cause) {
    throw new ReviewError(
      'credentials',
      `the GitHub App's private key file "${file}" could not be read: ${messageOf(cause)}. ` +
        `Check the path in ${name}.`,
      { cause },
    );
  }

  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(pem);
  } catch (cause) {
    throw new ReviewError(
      'credentials',
      `the file "${file}" is not a private key this harness can use: ${messageOf(cause)}. ` +
        'GitHub App keys are PEM-encoded RSA private keys.',
      { cause },
    );
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new ReviewError(
      'credentials',
      `the private key in "${file}" is ${key.asymmetricKeyType ?? 'of an unknown'} type. GitHub ` +
        'App tokens are signed with RS256, which needs an RSA private key.',
    );
  }
  return pem;
}

/** Reads the key file, kept apart so the failure message names only the path. */
async function readKeyFile(file: string): Promise<string> {
  return await readFile(file, 'utf8');
}

/** One base64url-encoded JWT segment. */
function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * The installation JWT: the App ID is the issuer, the lifetime is short, and
 * the backdating absorbs a small clock skew. The signature is RS256 over the
 * two encoded segments, as GitHub documents it.
 */
export function appJwt(appId: number, privateKeyPem: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem).toString('base64url')}`;
}

/** A secret-free, bounded diagnostic built from anything an answer produced. */
function sanitize(text: string, secrets: readonly string[]): string {
  let clean = text.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret !== '') {
      clean = clean.split(secret).join('[redacted]');
    }
  }
  clean = clean.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  clean = clean.replace(/(private[_-]?key|token)=[^\s&]+/gi, '$1=[redacted]');
  return clean.length <= MAX_DIAGNOSTIC_CHARS
    ? clean
    : `${clean.slice(0, MAX_DIAGNOSTIC_CHARS)} [truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A required nonblank string field of one answer object. */
function stringField(value: Record<string, unknown>, field: string, what: string): string {
  const found = value[field];
  if (typeof found !== 'string' || found.trim() === '') {
    throw new ReviewError(
      'api',
      `${what} carried no "${field}", so this connector will not guess.`,
    );
  }
  return found;
}

/** A required positive integer field of one answer object. */
function numberField(value: Record<string, unknown>, field: string, what: string): number {
  const found = value[field];
  if (typeof found !== 'number' || !Number.isSafeInteger(found) || found < 0) {
    throw new ReviewError(
      'api',
      `${what} carried no usable "${field}", so this connector will not guess.`,
    );
  }
  return found;
}

/** One answer object, refused by name when it is not an object. */
function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ReviewError('api', `${what} was not an object, so this connector will not guess.`);
  }
  return value;
}

/** One pull request as the REST API reports it. */
function parsePullRequest(value: unknown, what: string): OpenPullRequest {
  const pull = recordOf(value, what);
  const head = recordOf(pull['head'], `${what} head`);
  const base = recordOf(pull['base'], `${what} base`);
  const user = isRecord(pull['user']) ? pull['user'] : null;
  const title = pull['title'];
  return {
    number: numberField(pull, 'number', what),
    url: stringField(pull, 'html_url', what),
    title: typeof title === 'string' ? title : '',
    headSha: stringField(head, 'sha', `${what} head`),
    headBranch: stringField(head, 'ref', `${what} head`),
    baseBranch: stringField(base, 'ref', `${what} base`),
    baseSha: stringField(base, 'sha', `${what} base`),
    draft: pull['draft'] === true,
    author:
      user === null ? 'unknown' : typeof user['login'] === 'string' ? user['login'] : 'unknown',
  };
}

/** One review as the REST API reports it. */
function parseReview(value: unknown, what: string): PullRequestReview {
  const review = recordOf(value, what);
  const user = isRecord(review['user']) ? review['user'] : null;
  const commitId = review['commit_id'];
  return {
    id: numberField(review, 'id', what),
    login: user === null ? '' : typeof user['login'] === 'string' ? user['login'] : '',
    state: stringField(review, 'state', what),
    commitId: typeof commitId === 'string' && commitId !== '' ? commitId : null,
    url: typeof review['html_url'] === 'string' ? review['html_url'] : '',
  };
}

/** One changed file of a pull request. */
function parseChangedFile(value: unknown, what: string): ChangedFile {
  const file = recordOf(value, what);
  const patch = file['patch'];
  const additions = file['additions'];
  const deletions = file['deletions'];
  return {
    path: stringField(file, 'filename', what),
    patch: typeof patch === 'string' ? patch : null,
    additions: typeof additions === 'number' && Number.isSafeInteger(additions) ? additions : 0,
    deletions: typeof deletions === 'number' && Number.isSafeInteger(deletions) ? deletions : 0,
  };
}

/** One check run of the head, as the evidence keeps it. */
function parseCheck(value: unknown, what: string): CheckEvidence {
  const check = recordOf(value, what);
  const conclusion = check['conclusion'];
  return {
    name: stringField(check, 'name', what),
    status: stringField(check, 'status', what),
    conclusion: typeof conclusion === 'string' ? conclusion : null,
  };
}

/** One app-owned check run, as the dedup read finds it. */
function parseAppCheck(value: unknown, what: string): AppCheckRun {
  const check = recordOf(value, what);
  const conclusion = check['conclusion'];
  return {
    id: numberField(check, 'id', what),
    conclusion: typeof conclusion === 'string' ? conclusion : null,
    url:
      typeof check['html_url'] === 'string'
        ? check['html_url']
        : typeof check['details_url'] === 'string'
          ? check['details_url']
          : '',
  };
}

/** One instant GitHub reports, or `null` when it reports none. */
function optionalInstant(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** One native review of the conversation read. */
function parseConversationReview(
  value: unknown,
  what: string,
): PullRequestConversationEntry | null {
  const review = recordOf(value, what);
  const submitted = optionalInstant(review['submitted_at']);
  if (submitted === null) {
    // A pending review has not been submitted: it is not conversation yet.
    return null;
  }
  const user = isRecord(review['user']) ? review['user'] : null;
  const body = typeof review['body'] === 'string' ? review['body'] : '';
  const state = typeof review['state'] === 'string' ? review['state'] : null;
  return {
    id: numberField(review, 'id', what),
    kind: 'review',
    login:
      user === null ? 'unknown' : typeof user['login'] === 'string' ? user['login'] : 'unknown',
    createdAt: submitted,
    updatedAt: optionalInstant(review['updated_at']),
    body:
      body.trim() === ''
        ? `(this review carried no body text; GitHub reports its state as ${state ?? 'unknown'})`
        : body,
    url: typeof review['html_url'] === 'string' ? review['html_url'] : null,
    state,
    commitId: typeof review['commit_id'] === 'string' ? review['commit_id'] : null,
    path: null,
    line: null,
    reviewId: null,
    inReplyToId: null,
  };
}

/** One conversation comment of a pull request. */
function parseConversationComment(
  value: unknown,
  what: string,
  kind: 'comment' | 'review-comment',
): PullRequestConversationEntry {
  const comment = recordOf(value, what);
  const user = isRecord(comment['user']) ? comment['user'] : null;
  const line = kind === 'review-comment' ? (comment['line'] ?? comment['original_line']) : null;
  const parent =
    kind === 'review-comment' && typeof comment['pull_request_review_id'] === 'number'
      ? comment['pull_request_review_id']
      : null;
  const reply =
    kind === 'review-comment' && typeof comment['in_reply_to_id'] === 'number'
      ? comment['in_reply_to_id']
      : null;
  return {
    id: numberField(comment, 'id', what),
    kind,
    login:
      user === null ? 'unknown' : typeof user['login'] === 'string' ? user['login'] : 'unknown',
    createdAt: stringField(comment, 'created_at', what),
    updatedAt: optionalInstant(comment['updated_at']),
    body: typeof comment['body'] === 'string' ? comment['body'] : '',
    url: typeof comment['html_url'] === 'string' ? comment['html_url'] : null,
    state: null,
    commitId:
      kind === 'review-comment' && typeof comment['commit_id'] === 'string'
        ? comment['commit_id']
        : null,
    path: kind === 'review-comment' && typeof comment['path'] === 'string' ? comment['path'] : null,
    line: typeof line === 'number' && Number.isSafeInteger(line) && line >= 1 ? line : null,
    reviewId: parent,
    inReplyToId: reply,
  };
}

/** A server-directed wait, as milliseconds, from an HTTP `Retry-After` header. */
function retryAfterMs(header: string | null, now: Date): number | null {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
}

/**
 * The GitHub App client: one installation token, cached until it is close to
 * expiring, and the repository reads and writes the scan needs. The conversation
 * read is part of this client even though the repository boundary keeps it
 * optional for callers that only fake the parts a scan itself uses.
 */
export type GitHubReviewClient = ReviewRepository & {
  installationToken(stop: AbortSignal): Promise<string>;
  readConversation(number: number, stop: AbortSignal): Promise<PullRequestConversation>;
};

export function createGitHubReviewClient(
  config: GitHubReviewConfig,
  privateKeyPem: string,
  parts: Partial<GitHubReviewParts> = {},
): GitHubReviewClient {
  const doFetch: typeof fetch =
    parts.fetch ?? ((input, init) => globalThis.fetch(input as string, init));
  const now = parts.now ?? ((): Date => new Date());
  const apiBaseUrl = (parts.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, '');
  const repository = config.repository;
  const [owner = '', repo = ''] = repository.split('/');
  const repoPath = `/repos/${repository}`;
  const secrets: string[] = [privateKeyPem];
  let cachedToken: { readonly value: string; readonly expiresAtMs: number } | null = null;

  interface SentAnswer {
    readonly status: number;
    readonly headers: Headers;
    readonly text: string;
  }

  interface Request {
    readonly method: 'GET' | 'POST' | 'PATCH';
    readonly path: string;
    readonly token: string;
    readonly stop: AbortSignal;
    readonly body?: unknown;
    readonly accept?: string;
    readonly mutation?: boolean;
    readonly absentOk?: boolean;
  }

  /** One request, classified for the scan. `null` is an absent answer (HTTP 404). */
  const send = async (request: Request): Promise<SentAnswer | null> => {
    const url = `${apiBaseUrl}${request.path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${request.token}`,
      Accept: request.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'nexus-harness',
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
        // A redirect would forward the App's token to another host, so it is
        // refused rather than followed.
        redirect: 'error',
        signal: AbortSignal.any([request.stop, AbortSignal.timeout(REVIEW_REQUEST_TIMEOUT_MS)]),
      });
    } catch (cause) {
      if (request.stop.aborted) {
        throw new ReviewError(
          'fatal',
          `the request to ${url} was stopped by the caller before it answered`,
        );
      }
      throw new ReviewError(
        'api',
        `the request to ${url} did not complete: ${sanitize(messageOf(cause), secrets)}`,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new ReviewError(
        'api',
        `the answer from ${url} could not be read: ${sanitize(messageOf(cause), secrets)}`,
      );
    }

    if (!response.ok) {
      if (request.absentOk === true && response.status === 404) {
        return null;
      }
      const detail = sanitize(text, secrets);
      const suffix = detail === '' ? '' : `: ${detail}`;
      const where = `the GitHub request to ${url} answered HTTP ${String(response.status)}`;
      if (response.status === 401 || response.status === 403) {
        throw new ReviewError(
          'auth',
          `${where}${suffix}. The App installation and its permissions are not accepted for this ` +
            'call: check the App ID, the installation ID, the private key, and that the ' +
            'installation grants the repository pull requests, checks, and contents access.',
        );
      }
      const wait = retryAfterMs(response.headers.get('retry-after'), now());
      const caution =
        request.mutation === true
          ? ' This request was a write: nothing is retried automatically, and a failure after it ' +
            'was sent may still have taken effect, so check the pull request before retrying.'
          : '';
      throw new ReviewError('api', `${where}${suffix}.${caution}`, { retryAfterMs: wait });
    }
    return { status: response.status, headers: response.headers, text };
  };

  /** One JSON answer. `null` is HTTP 404 with `absentOk`. */
  const json = async (request: Request): Promise<unknown | null> => {
    const answer = await send(request);
    if (answer === null) {
      return null;
    }
    if (answer.text.trim() === '') {
      return null;
    }
    try {
      return JSON.parse(answer.text) as unknown;
    } catch {
      throw new ReviewError(
        'api',
        `the answer from ${apiBaseUrl}${request.path} was not JSON, so this connector will not ` +
          'guess what it said.',
      );
    }
  };

  /** The App's installation token, refreshed only when it is close to expiring. */
  const installationToken = async (stop: AbortSignal): Promise<string> => {
    const moment = now();
    if (cachedToken !== null && moment.getTime() < cachedToken.expiresAtMs - 60_000) {
      return cachedToken.value;
    }
    const jwt = appJwt(config.app.appId, privateKeyPem, moment);
    secrets.push(jwt);
    const answer = await json({
      method: 'POST',
      path: `/app/installations/${String(config.app.installationId)}/access_tokens`,
      token: jwt,
      stop,
      mutation: true,
      body: {
        repositories: [repo],
        // Keep renewal within the installed Lens permission set. Queue
        // completion reads public workflow evidence with this same token;
        // requesting ungranted Actions access makes token issuance fail.
        permissions: {
          pull_requests: 'write',
          checks: 'write',
          contents: 'read',
          statuses: 'read',
          metadata: 'read',
        },
      },
    });
    const body = recordOf(answer, 'the installation token answer');
    const token = stringField(body, 'token', 'the installation token answer');
    secrets.push(token);
    const expiresAt = body['expires_at'];
    const expiresAtMs =
      typeof expiresAt === 'string' && !Number.isNaN(Date.parse(expiresAt))
        ? Date.parse(expiresAt)
        : moment.getTime() + 55 * 60_000;
    cachedToken = { value: token, expiresAtMs };
    return token;
  };

  /** Token-authenticated JSON. */
  const api = async (request: Omit<Request, 'token'>): Promise<unknown | null> => {
    const token = await installationToken(request.stop);
    return await json({ ...request, token });
  };

  /** Every page of one list endpoint, bounded. */
  const pages = async (
    basePath: string,
    what: string,
    stop: AbortSignal,
    entry: (value: unknown, index: number) => unknown,
    limit = MAX_LIST_PAGES,
  ): Promise<{ readonly entries: readonly unknown[]; readonly truncated: boolean }> => {
    const entries: unknown[] = [];
    for (let page = 1; page <= limit; page += 1) {
      const separator = basePath.includes('?') ? '&' : '?';
      const answer = await api({
        method: 'GET',
        path: `${basePath}${separator}per_page=${String(LIST_PAGE_SIZE)}&page=${String(page)}`,
        stop,
      });
      if (!Array.isArray(answer)) {
        throw new ReviewError(
          'api',
          `${what} was not a list, so this connector will not guess what it said.`,
        );
      }
      answer.forEach((value, index) => {
        entries.push(entry(value, index));
      });
      if (answer.length < LIST_PAGE_SIZE) {
        return { entries, truncated: false };
      }
    }
    return { entries, truncated: true };
  };

  return {
    installationToken,
    async findOpenPullRequest(branch: string, stop: AbortSignal): Promise<OpenPullRequest | null> {
      const head = `${owner}:${branch}`;
      const answer = await api({
        method: 'GET',
        path:
          `${repoPath}/pulls?state=open&head=${encodeURIComponent(head)}` +
          `&per_page=${String(LIST_PAGE_SIZE)}`,
        stop,
      });
      if (!Array.isArray(answer)) {
        throw new ReviewError('api', 'the open pull request list was not a list.');
      }
      const matches = answer
        .map((value, index) => parsePullRequest(value, `open pull request ${String(index + 1)}`))
        .filter((pull) => pull.headBranch === branch);
      if (matches.length === 0) {
        return null;
      }
      if (matches.length > 1) {
        const described = matches.map((pull) => `#${String(pull.number)}`).join(', ');
        throw new ReviewError(
          'ambiguous-pr',
          `${String(matches.length)} open pull requests in ${repository} have the head branch ` +
            `"${branch}" (${described}), so which one belongs to this ticket cannot be guessed. ` +
            'Close or retarget the extras, or rename the branch of the one that is this work.',
        );
      }
      return matches[0] ?? null;
    },

    async readPullRequest(number: number, stop: AbortSignal): Promise<OpenPullRequest | null> {
      const answer = await api({
        method: 'GET',
        path: `${repoPath}/pulls/${String(number)}`,
        stop,
        absentOk: true,
      });
      if (answer === null) {
        return null;
      }
      const pull = recordOf(answer, `pull request ${String(number)}`);
      if (
        pull['state'] !== 'open' ||
        (pull['merged_at'] !== undefined && pull['merged_at'] !== null)
      ) {
        return null;
      }
      return parsePullRequest(pull, `pull request ${String(number)}`);
    },

    async listReviews(number: number, stop: AbortSignal): Promise<readonly PullRequestReview[]> {
      const { entries, truncated } = await pages(
        `${repoPath}/pulls/${String(number)}/reviews`,
        `the review list of pull request ${String(number)}`,
        stop,
        (value, index) =>
          parseReview(value, `review ${String(index + 1)} of pull request ${String(number)}`),
      );
      if (truncated) {
        throw new ReviewError(
          'api',
          'the native review list is incomplete; no verdict can be inferred.',
        );
      }
      return entries as readonly PullRequestReview[];
    },

    async readConversation(number: number, stop: AbortSignal): Promise<PullRequestConversation> {
      const reviews = await pages(
        `${repoPath}/pulls/${String(number)}/reviews`,
        `the review list of pull request ${String(number)}`,
        stop,
        (value, index) =>
          parseConversationReview(
            value,
            `review ${String(index + 1)} of pull request ${String(number)}`,
          ),
        MAX_CONVERSATION_PAGES,
      );
      const comments = await pages(
        `${repoPath}/issues/${String(number)}/comments`,
        `the conversation of pull request ${String(number)}`,
        stop,
        (value, index) =>
          parseConversationComment(
            value,
            `comment ${String(index + 1)} of pull request ${String(number)}`,
            'comment',
          ),
        MAX_CONVERSATION_PAGES,
      );
      const reviewComments = await pages(
        `${repoPath}/pulls/${String(number)}/comments`,
        `the inline review comments of pull request ${String(number)}`,
        stop,
        (value, index) =>
          parseConversationComment(
            value,
            `inline review comment ${String(index + 1)} of pull request ${String(number)}`,
            'review-comment',
          ),
        MAX_CONVERSATION_PAGES,
      );
      const entries = [
        ...(reviews.entries as readonly (PullRequestConversationEntry | null)[]),
        ...(comments.entries as readonly PullRequestConversationEntry[]),
        ...(reviewComments.entries as readonly PullRequestConversationEntry[]),
      ].filter((entry): entry is PullRequestConversationEntry => entry !== null);
      return {
        entries: entries.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id),
        truncated: reviews.truncated || comments.truncated || reviewComments.truncated,
      };
    },

    async readEvidence(
      request: {
        readonly ref: SourceRef;
        readonly task: Task;
        readonly pullRequest: OpenPullRequest;
      },
      stop: AbortSignal,
    ): Promise<ReviewEvidence> {
      const { pullRequest } = request;
      const head = pullRequest.headSha;
      const { entries, truncated } = await pages(
        `${repoPath}/pulls/${String(pullRequest.number)}/files`,
        'the changed file list',
        stop,
        (value, index) =>
          parseChangedFile(value, `changed file ${String(index + 1)} of the pull request`),
      );
      const files = entries as readonly ChangedFile[];

      const checksAnswer = await api({
        method: 'GET',
        path: `${repoPath}/commits/${encodeURIComponent(head)}/check-runs?per_page=${String(
          LIST_PAGE_SIZE,
        )}`,
        stop,
      });
      const checksRecord = recordOf(checksAnswer, 'the check-run list');
      const checkRuns = checksRecord['check_runs'];
      if (!Array.isArray(checkRuns)) {
        throw new ReviewError('api', 'the check-run list carried no "check_runs" array.');
      }
      const checks = checkRuns
        .slice(0, MAX_EVIDENCE_CHECKS)
        .map((value, index) => parseCheck(value, `check run ${String(index + 1)}`));

      const statusAnswer = await api({
        method: 'GET',
        path: `${repoPath}/commits/${encodeURIComponent(head)}/status`,
        stop,
      });
      const statusRecord = recordOf(statusAnswer, 'the combined commit status');
      const combinedStatus =
        typeof statusRecord['state'] === 'string' ? statusRecord['state'] : null;

      return {
        ref: request.ref,
        task: request.task,
        pullRequest,
        files,
        truncated,
        checks,
        combinedStatus,
        fetchedAt: now().toISOString(),
      };
    },

    async publishReview(
      request: PublishReviewRequest,
      stop: AbortSignal,
    ): Promise<PublishedReview> {
      const answer = await api({
        method: 'POST',
        path: `${repoPath}/pulls/${String(request.pullRequest.number)}/reviews`,
        stop,
        mutation: true,
        body: {
          commit_id: request.head,
          event: request.decision === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
          body: request.body,
          ...(request.comments.length === 0
            ? {}
            : {
                comments: request.comments.map((comment) => ({
                  path: comment.path,
                  position: comment.position,
                  body: comment.body,
                })),
              }),
        },
      });
      const review = recordOf(answer, 'the published review');
      const commitId = review['commit_id'];
      if (commitId !== request.head) {
        throw new ReviewError(
          'stale',
          `GitHub did not confirm the review against the reviewed head ` +
            `${request.head}, so this scan will not claim the head was reviewed.`,
        );
      }
      const user = isRecord(review['user']) ? review['user'] : null;
      const publishedAs = user === null ? null : user['login'];
      if (publishedAs !== config.app.login) {
        throw new ReviewError(
          'api',
          `GitHub did not confirm the review as the configured App login ` +
            `${config.app.login}, so a later scan would not recognise it as this App's review. ` +
            'Check the installation, the App, and app.login, and treat this head as not reviewed.',
        );
      }
      const expectedState = request.decision === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED';
      if (review['state'] !== expectedState) {
        throw new ReviewError(
          'api',
          `GitHub did not confirm a completed ${expectedState} review; no check is published.`,
        );
      }
      return {
        id: numberField(review, 'id', 'the published review'),
        url: stringField(review, 'html_url', 'the published review'),
        state: stringField(review, 'state', 'the published review'),
      };
    },

    async publishCheck(request: PublishCheckRequest, stop: AbortSignal): Promise<PublishedCheck> {
      const answer = await api({
        method: request.checkRunId === undefined ? 'POST' : 'PATCH',
        path: `${repoPath}/check-runs${request.checkRunId === undefined ? '' : `/${String(request.checkRunId)}`}`,
        stop,
        mutation: true,
        body: {
          name: config.checkName,
          ...(request.checkRunId === undefined ? { head_sha: request.head } : {}),
          status: 'completed',
          conclusion: request.decision === 'approve' ? 'success' : 'failure',
          output: { title: request.title, summary: request.summary },
          ...(request.detailsUrl === null ? {} : { details_url: request.detailsUrl }),
        },
      });
      const check = recordOf(answer, 'the published check run');
      const headSha = check['head_sha'];
      if (headSha !== request.head) {
        throw new ReviewError(
          'stale',
          `GitHub did not confirm the check run against the reviewed head ` +
            `${request.head}, so this scan will not claim the head carries the check.`,
        );
      }
      const expectedConclusion = request.decision === 'approve' ? 'success' : 'failure';
      if (
        check['status'] !== 'completed' ||
        check['conclusion'] !== expectedConclusion ||
        !isRecord(check['app']) ||
        check['app']['id'] !== config.app.appId
      ) {
        throw new ReviewError(
          'api',
          'GitHub did not confirm the completed app-owned check and its conclusion.',
        );
      }
      return {
        id: numberField(check, 'id', 'the published check run'),
        url: typeof check['html_url'] === 'string' ? check['html_url'] : (request.detailsUrl ?? ''),
        conclusion: expectedConclusion,
      };
    },

    async reviewChecks(head: string, stop: AbortSignal): Promise<readonly AppCheckRun[]> {
      const answer = await api({
        method: 'GET',
        path: `${repoPath}/commits/${encodeURIComponent(head)}/check-runs?check_name=${encodeURIComponent(config.checkName)}&filter=latest&per_page=${String(
          LIST_PAGE_SIZE,
        )}`,
        stop,
      });
      const record = recordOf(answer, 'the check-run list');
      const checkRuns = record['check_runs'];
      if (!Array.isArray(checkRuns)) {
        throw new ReviewError('api', 'the check-run list carried no "check_runs" array.');
      }
      if (
        checkRuns.length >= LIST_PAGE_SIZE ||
        (typeof record['total_count'] === 'number' && record['total_count'] > checkRuns.length)
      ) {
        throw new ReviewError(
          'api',
          'the app check list is incomplete; no verdict can be inferred.',
        );
      }
      return checkRuns
        .map((value, index) => {
          const check = recordOf(value, `check run ${String(index + 1)}`);
          const app = check['app'];
          return { check, app, index };
        })
        .filter(
          ({ check, app }) =>
            check['name'] === config.checkName &&
            isRecord(app) &&
            typeof app['id'] === 'number' &&
            app['id'] === config.app.appId,
        )
        .map(({ check, index }) => parseAppCheck(check, `check run ${String(index + 1)}`));
    },
  };
}
