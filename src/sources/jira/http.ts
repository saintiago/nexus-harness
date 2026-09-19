/**
 * The Atlassian API gateway client: routing, authentication, timeouts, and the
 * classification of a failed answer for the coordinator.
 *
 * A dedicated service account's scoped API token is presented as
 * `Authorization: Bearer <token>` and every call goes through
 * `https://api.atlassian.com/ex/jira/<cloudId>/...`. There is no direct
 * `*.atlassian.net/rest/api` route, no Basic authentication, and no email
 * address. The token lives in a private closure, is never written anywhere, and
 * is redacted from every diagnostic this module builds. A refused answer to a
 * write is never retried and never assumed not to have happened.
 */
import type { JiraSourceConfig } from '../../shared/types.js';
import { SourceError } from '../contract.js';

/** What a caller may substitute in the transport, for tests. */
export interface JiraSourceParts {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

/** The Atlassian API gateway prefix every service-account call goes through. */
const GATEWAY_ORIGIN = 'https://api.atlassian.com/ex/jira';

/** How long one HTTP request may take, in milliseconds. */
export const JIRA_REQUEST_TIMEOUT_MS = 30_000;
/** How much of a diagnostic this connector repeats; the rest is truncated. */
const MAX_DIAGNOSTIC_CHARS = 400;
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

export function diagnosticOf(cause: unknown, token: string): string {
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

export interface HttpClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  request(request: JiraRequest): Promise<unknown | null>;
}

export function createHttpClient(
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
    // The status alone decides the classification; a body that could not be
    // read is reported as exactly that rather than silently dropped.
    const detail = await response.text().then(
      (body) => sanitize(body, token),
      (cause) => `the answer's body could not be read (${diagnosticOf(cause, token)})`,
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
        const detail = diagnosticOf(cause, token);
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

      // A body that could not be read is never an empty one: reporting no
      // content here would be read as a missing issue by a read and as an
      // acknowledged answer by a write. The failure is carried through the same
      // classification a request that never answered gets: a stopped caller is
      // over, a failed read may be retried, and a write whose answer was lost is
      // uncertain and is never sent again.
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        if (request.signal.aborted) {
          throw new SourceError(
            request.mutation === true ? 'uncertain-write' : 'fatal',
            `the request to ${url} was stopped by the caller before its answer was read`,
          );
        }
        throw new SourceError(
          request.mutation === true ? 'uncertain-write' : 'retryable-read',
          `the answer from ${url} could not be read: ${diagnosticOf(cause, token)}`,
        );
      }
      try {
        return text.trim() === '' ? null : (JSON.parse(text) as unknown);
      } catch {
        const message = `the answer from ${url} was not JSON, so this connector will not guess what it said`;
        throw new SourceError(request.mutation === true ? 'uncertain-write' : 'fatal', message);
      }
    },
  };
}
