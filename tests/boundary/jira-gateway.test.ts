/**
 * The Jira gateway adapter, against real HTTP answers from a stand-in service on
 * this host's loopback.
 *
 * The adapter is the boundary that holds the service-account credential and
 * translates the gateway protocol: what a request carries, how a refused answer
 * is classified for the coordinator, and what a diagnostic may repeat. The
 * service is a real HTTP server answering what a case wrote, so no live account
 * or credential is involved, and the adapter's own URL, headers, redirect
 * policy, and signal are exactly what they are in production (only the host the
 * request reaches is local).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JiraSourceConfig } from '../../src/shared/types.js';
import { SourceError } from '../../src/sources/contract.js';
import { createHttpClient, resolveJiraToken } from '../../src/sources/jira/http.js';
import type { HttpClient } from '../../src/sources/jira/http.js';
import { startLocalService, serviceFetch } from './integration-support.js';
import type { LocalService } from './integration-support.js';

/** The site one service account is configured for. */
const CONFIG: JiraSourceConfig = {
  type: 'jira',
  siteUrl: 'https://example.atlassian.net',
  cloudId: 'cloud-123',
  projectKey: 'HARN',
  issueType: 'Task',
  label: 'nexus',
  readyStatus: 'To Do',
  runningStatus: 'In Progress',
  reviewStatus: 'In Review',
  ordering: 'priority',
  pollIntervalSeconds: 15,
  tokenEnv: 'NEXUS_JIRA_TOKEN',
};

/** The credential the environment holds, and no diagnostic may repeat. */
const TOKEN = 'service-account-token-that-must-not-leak';

/** The services a case started, closed when the case ends. */
const started: LocalService[] = [];

afterEach(async () => {
  const services = started.splice(0);
  await Promise.all(services.map((service) => service.close()));
});

/** One adapter pointed at a stand-in service, and the service it reaches. */
async function gateway(
  answer: (
    request: { readonly url: string; readonly body: string },
    index: number,
  ) => {
    readonly status: number;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): Promise<{ readonly client: HttpClient; readonly service: LocalService }> {
  const service = await startLocalService(answer);
  started.push(service);
  return {
    client: createHttpClient(CONFIG, TOKEN, { fetch: serviceFetch(service.origin) }),
    service,
  };
}

/** The error a call that was expected to fail rejected with. */
async function failureOf(work: () => Promise<unknown>): Promise<SourceError> {
  try {
    await work();
  } catch (cause) {
    if (!(cause instanceof SourceError)) {
      throw new Error(`the call failed with something else: ${String(cause)}`, { cause });
    }
    return cause;
  }
  throw new Error('the call was expected to fail, and it did not');
}

describe('one request through the gateway', () => {
  it('carries the credential to the configured site and asks for one language', async () => {
    const { client, service } = await gateway(() => ({
      status: 200,
      body: JSON.stringify({ key: 'HARN-1', summary: 'the issue' }),
    }));

    const answer = await client.request({
      method: 'GET',
      path: '/rest/api/3/issue/HARN-1',
      signal: new AbortController().signal,
    });

    expect(answer).toEqual({ key: 'HARN-1', summary: 'the issue' });
    expect(service.requests).toHaveLength(1);
    const [sent] = service.requests;
    // The gateway route is keyed by the cloud id, never by the site host.
    expect(sent?.url).toBe('/ex/jira/cloud-123/rest/api/3/issue/HARN-1');
    expect(sent?.method).toBe('GET');
    expect(sent?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent?.headers.accept).toBe('application/json');
    // One language explicitly: the names the queue matches and the names an
    // answer returns have to agree.
    expect(sent?.headers['accept-language']).toBe('en');
  }, 60_000);

  it('sends one write as JSON, and reads an empty answer as no content', async () => {
    const { client, service } = await gateway(() => ({ status: 204 }));

    const answer = await client.request({
      method: 'POST',
      path: '/rest/api/3/issue/HARN-1/transitions',
      body: { transition: { id: '31' } },
      mutation: true,
      signal: new AbortController().signal,
    });

    expect(answer).toBeNull();
    expect(service.requests[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(service.requests[0]?.body ?? '')).toEqual({ transition: { id: '31' } });
  }, 60_000);
});

describe('what a refused answer is classified as', () => {
  it('is fatal for a credential the site does not accept, and says what to check', async () => {
    const { client } = await gateway(() => ({ status: 403, body: '{"error":"forbidden"}' }));

    const error = await failureOf(() =>
      client.request({
        method: 'GET',
        path: '/rest/api/3/search/jql',
        signal: new AbortController().signal,
      }),
    );

    expect(error.kind).toBe('fatal');
    expect(error.message).toContain('answered HTTP 403');
    expect(error.message).toContain('check the token');
    expect(error.message).toContain('forbidden');
    expect(error.retryAfterMs).toBeNull();
  }, 60_000);

  it('keeps the server-directed wait of a rate-limited read', async () => {
    const { client } = await gateway(() => ({
      status: 429,
      headers: { 'Retry-After': '30' },
      body: '{"error":"too many requests"}',
    }));

    const error = await failureOf(() =>
      client.request({
        method: 'GET',
        path: '/rest/api/3/search/jql',
        signal: new AbortController().signal,
      }),
    );

    expect(error.kind).toBe('retryable-read');
    expect(error.retryAfterMs).toBe(30_000);
  }, 60_000);

  it('is a retryable read for a server error, and an uncertain write for a write', async () => {
    const { client } = await gateway(() => ({ status: 500, body: '{"error":"boom"}' }));
    const signal = new AbortController().signal;

    const read = await failureOf(() =>
      client.request({ method: 'GET', path: '/rest/api/3/issue/HARN-1', signal }),
    );
    // A write whose answer was refused is never assumed not to have happened.
    const write = await failureOf(() =>
      client.request({
        method: 'POST',
        path: '/rest/api/3/issue/HARN-1/transitions',
        body: { transition: { id: '31' } },
        mutation: true,
        signal,
      }),
    );

    expect(read.kind).toBe('retryable-read');
    expect(write.kind).toBe('uncertain-write');
  }, 60_000);

  it('never puts the token in a diagnostic, even when the answer echoes it', async () => {
    const { client } = await gateway(() => ({
      status: 401,
      body: `{"error":"the credential ${TOKEN} was refused","authorization":"Bearer ${TOKEN}"}`,
    }));

    const error = await failureOf(() =>
      client.request({
        method: 'GET',
        path: '/rest/api/3/issue/HARN-1',
        signal: new AbortController().signal,
      }),
    );

    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('[redacted]');
  }, 60_000);

  it('reads an absent answer as none only when the caller said so', async () => {
    const { client } = await gateway(() => ({ status: 404, body: '{"error":"no issue"}' }));
    const signal = new AbortController().signal;

    const absent = await client.request({
      method: 'GET',
      path: '/rest/api/3/issue/HARN-404',
      absentOk: true,
      signal,
    });
    const error = await failureOf(() =>
      client.request({ method: 'GET', path: '/rest/api/3/issue/HARN-404', signal }),
    );

    expect(absent).toBeNull();
    expect(error.kind).toBe('fatal');
    expect(error.message).toContain('answered HTTP 404');
  }, 60_000);

  it('refuses a redirect instead of following the credential to another host', async () => {
    // The destination is a real service on this host, not an address that
    // cannot be dialled: it answers a request that reached it with a good
    // answer, so following the redirect would be observable here — the call
    // would succeed, and this service would have received the request — rather
    // than failing the same way the refusal does.
    const elsewhere = await startLocalService(() => ({
      status: 200,
      body: JSON.stringify({ key: 'HARN-1', summary: 'an answer from somewhere else' }),
    }));
    started.push(elsewhere);
    const { client, service } = await gateway(() => ({
      status: 302,
      headers: { Location: `${elsewhere.origin}/elsewhere` },
    }));

    const error = await failureOf(() =>
      client.request({
        method: 'GET',
        path: '/rest/api/3/issue/HARN-1',
        signal: new AbortController().signal,
      }),
    );

    expect(error.kind).toBe('retryable-read');
    expect(error.message).toContain('did not complete');
    // The redirect was refused, not followed: the configured site answered
    // once, and the other host was never asked — no request and no credential
    // was carried to it.
    expect(service.requests).toHaveLength(1);
    expect(elsewhere.requests).toHaveLength(0);
  }, 60_000);

  it('is a failure this connector will not guess about when the answer is not JSON', async () => {
    const { client } = await gateway(() => ({ status: 200, body: 'not json at all' }));

    const error = await failureOf(() =>
      client.request({
        method: 'GET',
        path: '/rest/api/3/issue/HARN-1',
        signal: new AbortController().signal,
      }),
    );

    expect(error.kind).toBe('fatal');
    expect(error.message).toContain('was not JSON');
  }, 60_000);

  it('distinguishes a stopped read from a stopped write', async () => {
    const { client, service } = await gateway(() => ({ status: 200, body: '{}' }));
    const controller = new AbortController();
    controller.abort();

    const read = await failureOf(() =>
      client.request({
        method: 'GET',
        path: '/rest/api/3/issue/HARN-1',
        signal: controller.signal,
      }),
    );
    const write = await failureOf(() =>
      client.request({
        method: 'POST',
        path: '/rest/api/3/issue/HARN-1/transitions',
        body: { transition: { id: '31' } },
        mutation: true,
        signal: controller.signal,
      }),
    );

    expect(read.kind).toBe('fatal');
    expect(read.message).toContain('was stopped by the caller');
    expect(write.kind).toBe('uncertain-write');
    // A request that was stopped before it was sent never reached the site.
    expect(service.requests).toHaveLength(0);
  }, 60_000);
});

describe('the service-account token', () => {
  it('is read only from the environment variable the configuration names', () => {
    const environment = { NEXUS_JIRA_TOKEN: '  the-token  ', OTHER_TOKEN: 'another' };

    expect(resolveJiraToken(CONFIG, environment)).toBe('the-token');
  });

  it('refuses a missing or blank variable, naming it and never a value', () => {
    for (const environment of [{}, { NEXUS_JIRA_TOKEN: '   ' }]) {
      let error: SourceError | null = null;
      try {
        resolveJiraToken(CONFIG, environment);
      } catch (cause) {
        error = cause as SourceError;
      }
      expect(error).toBeInstanceOf(SourceError);
      expect(error?.message).toContain('NEXUS_JIRA_TOKEN');
      expect(error?.message).toContain('missing or blank');
      expect(error?.message).not.toContain('the-token');
    }
  });
});
