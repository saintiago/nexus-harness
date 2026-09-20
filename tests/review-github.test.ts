import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGitHubReviewClient } from '../src/reviews/github.js';
import type { OpenPullRequest } from '../src/reviews/contract.js';

const HEAD = 'a'.repeat(40);
const APP = 5001141;
const LOGIN = 'nexus-lens[bot]';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const stop = new AbortController().signal;
const pull: OpenPullRequest = {
  number: 1,
  url: 'https://github.com/owner/repo/pull/1',
  title: 'Feature',
  headSha: HEAD,
  headBranch: 'harness/work',
  baseBranch: 'main',
  draft: false,
  author: 'author',
};

function clientFixture(
  answer: (url: URL, method: string, body: Record<string, unknown>) => unknown,
) {
  const calls: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
  const client = createGitHubReviewClient(
    {
      type: 'github',
      repository: 'owner/repo',
      checkName: 'Nexus Lens review',
      app: { appId: APP, installationId: 123, privateKeyPathEnv: 'TEST_KEY', login: LOGIN },
      reviewer: { runtime: 'codex', command: ['codex', '--profile', 'nexus-astra'] },
    },
    pem,
    {
      fetch: (async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const body =
          init?.body === undefined
            ? {}
            : (JSON.parse(String(init.body)) as Record<string, unknown>);
        calls.push({ url, method, body });
        const result = url.pathname.endsWith('/access_tokens')
          ? { token: 'test-installation-token', expires_at: '2099-01-01T00:00:00Z' }
          : answer(url, method, body);
        return result instanceof Response ? result : new Response(JSON.stringify(result));
      }) as typeof fetch,
    },
  );
  return { client, calls };
}

describe('the review GitHub boundary', () => {
  it('renews the App token after an hour idle and scopes completion workflow reads', async () => {
    let clock = Date.parse('2026-09-20T12:00:00Z');
    let issued = 0;
    const client = createGitHubReviewClient(
      {
        type: 'github',
        repository: 'owner/repo',
        checkName: 'Nexus Lens review',
        app: { appId: APP, installationId: 123, privateKeyPathEnv: 'TEST_KEY', login: LOGIN },
        reviewer: { runtime: 'codex', command: ['codex'] },
      },
      pem,
      {
        now: () => new Date(clock),
        completionReads: true,
        fetch: async (input, init) => {
          expect(String(input)).toContain('/app/installations/123/access_tokens');
          expect(JSON.parse(String(init?.body))).toMatchObject({
            repositories: ['repo'],
            permissions: { actions: 'read' },
          });
          return new Response(
            JSON.stringify({
              token: `installation-${String(++issued)}`,
              expires_at: new Date(clock + 3600000).toISOString(),
            }),
          );
        },
      },
    );
    expect(await client.installationToken(stop)).toBe('installation-1');
    expect(await client.installationToken(stop)).toBe('installation-1');
    clock += 3600000;
    expect(await client.installationToken(stop)).toBe('installation-2');
    expect(issued).toBe(2);
  });

  it('scopes the installation token and updates an existing app check in place', async () => {
    const { client, calls } = clientFixture(() => ({
      id: 9,
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'failure',
      app: { id: APP },
    }));
    expect(
      await client.publishCheck(
        {
          checkRunId: 9,
          head: HEAD,
          decision: 'request_changes',
          title: 'Changes requested',
          summary: 'Fix the boundary condition.',
          detailsUrl: pull.url,
        },
        stop,
      ),
    ).toMatchObject({ id: 9, conclusion: 'failure' });
    expect(calls[0]?.body).toEqual({
      repositories: ['repo'],
      permissions: {
        pull_requests: 'write',
        checks: 'write',
        contents: 'read',
        statuses: 'read',
        metadata: 'read',
      },
    });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      body: {
        name: 'Nexus Lens review',
        status: 'completed',
        conclusion: 'failure',
      },
    });
    expect(calls[1]?.url.pathname).toBe('/repos/owner/repo/check-runs/9');
    expect(calls[1]?.body).not.toHaveProperty('head_sha');
  });

  it('selects only the configured app check and keeps pending runs visible', async () => {
    const { client, calls } = clientFixture(() => ({
      check_runs: [
        {
          id: 1,
          name: 'Nexus Lens review',
          status: 'completed',
          conclusion: 'success',
          app: { id: 999 },
        },
        { id: 2, name: 'CI', status: 'completed', conclusion: 'success', app: { id: APP } },
        {
          id: 9,
          name: 'Nexus Lens review',
          status: 'in_progress',
          conclusion: null,
          app: { id: APP },
        },
      ],
    }));
    expect(await client.reviewChecks(HEAD, stop)).toEqual([{ id: 9, conclusion: null, url: '' }]);
    expect(calls[1]?.url.searchParams.get('filter')).toBe('latest');
    expect(calls[1]?.url.searchParams.get('check_name')).toBe('Nexus Lens review');
  });

  it.each([{ total_count: 101, check_runs: [] }, {}])(
    'refuses an incomplete check list',
    async (answer) => {
      const { client } = clientFixture(() => answer);
      await expect(client.reviewChecks(HEAD, stop)).rejects.toMatchObject({ kind: 'api' });
    },
  );

  it('refuses a bounded native review list instead of using an older verdict', async () => {
    const { client, calls } = clientFixture(() =>
      Array.from({ length: 100 }, (_, id) => ({
        id,
        user: { login: LOGIN },
        state: 'APPROVED',
        commit_id: HEAD,
        html_url: pull.url,
      })),
    );
    await expect(client.listReviews(1, stop)).rejects.toThrow('native review list is incomplete');
    expect(calls.filter((call) => call.url.pathname.endsWith('/reviews'))).toHaveLength(3);
  });

  it.each([
    { state: 'PENDING' },
    { commit_id: undefined },
    { commit_id: 'other' },
    { user: { login: 'operator' } },
    { user: undefined },
  ])('requires affirmative native review confirmation: %j', async (override) => {
    const { client } = clientFixture(() => ({
      id: 1,
      html_url: pull.url,
      state: 'APPROVED',
      commit_id: HEAD,
      user: { login: LOGIN },
      ...override,
    }));
    await expect(
      client.publishReview(
        {
          pullRequest: pull,
          head: HEAD,
          decision: 'approve',
          body: 'Reviewed.',
          comments: [],
        },
        stop,
      ),
    ).rejects.toThrow();
  });

  it.each([
    { head_sha: undefined },
    { conclusion: undefined },
    { status: 'in_progress' },
    { app: { id: 999 } },
  ])('requires affirmative app check confirmation: %j', async (override) => {
    const { client } = clientFixture(() => ({
      id: 1,
      head_sha: HEAD,
      status: 'completed',
      conclusion: 'success',
      app: { id: APP },
      ...override,
    }));
    await expect(
      client.publishCheck(
        {
          head: HEAD,
          decision: 'approve',
          title: 'Approved',
          summary: 'Reviewed.',
          detailsUrl: pull.url,
        },
        stop,
      ),
    ).rejects.toThrow();
  });

  it.each([false, true])(
    'reads nested instructions at the reviewed head, failing closed on unreadable content (%s)',
    async (unreadable) => {
      const { client, calls } = clientFixture((url) => {
        if (url.pathname.endsWith('/files'))
          return [
            {
              filename: 'src/feature/code.ts',
              patch: '@@ -0,0 +1 @@\n+code',
              additions: 1,
              deletions: 0,
            },
          ];
        if (url.pathname.includes('/contents/')) {
          if (url.pathname.endsWith('/src/AGENTS.md')) return new Response('', { status: 404 });
          if (unreadable) return { encoding: 'none', content: '' };
          return {
            encoding: 'base64',
            content: Buffer.from(`Instructions for ${url.pathname}`).toString('base64'),
          };
        }
        if (url.pathname.endsWith('/check-runs')) return { check_runs: [] };
        return { state: 'pending' };
      });
      const read = client.readEvidence(
        {
          pullRequest: pull,
          ref: {
            type: 'jira',
            scope: 'https://example.atlassian.net',
            id: '1',
            key: 'HARN-1',
            url: 'https://example.atlassian.net/browse/HARN-1',
            updatedAt: 'now',
          },
          task: {
            id: 'HARN-1',
            title: 'Feature',
            description: 'Implement feature.',
            acceptanceCriteria: ['Works.'],
          },
        },
        stop,
      );
      if (unreadable) {
        await expect(read).rejects.toThrow('could not be read completely');
      } else {
        expect((await read).instructions).toContain('src/feature/AGENTS.md');
        const contentCalls = calls.filter((call) => call.url.pathname.includes('/contents/'));
        expect(contentCalls).toHaveLength(3);
        expect(contentCalls.every((call) => call.url.searchParams.get('ref') === HEAD)).toBe(true);
      }
    },
  );
});
