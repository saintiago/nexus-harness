/**
 * Component tests: the real GitHub adapter drives a controlled gh CLI and a controlled Nexus
 * Lens App transport, establishing the requests it makes, its interpretation of provider
 * responses, complete collection handling and provider errors. No live GitHub access is involved;
 * the App private key is generated for the test and the installation token is supplied.
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubAdapter,
  type GhCommandExecution,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  type GitHubHttpTransport,
} from '../src/adapters/github.js';
import type { Result } from '../src/result.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const nexusLens = { appId: 5001141, installationId: 163007360, privateKey };
const repository = 'acme/nexus';

/** The value of a successful result; a fault fails the test with its message. */
function valueOf<Value>(result: Result<Value>): Value {
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  return result.value;
}

/** One scripted gh command result. */
type GhAnswer =
  { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number } | Error;

/** A gh CLI answering the supplied results in order and recording every command. */
function createGh(answers: readonly GhAnswer[]): {
  readonly calls: string[][];
  readonly execute: GhCommandExecution;
} {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    execute: async (args, onOutput) => {
      calls.push([...args]);
      const answer = answers[index];
      index += 1;
      if (answer === undefined) {
        throw new Error(`Unexpected gh command: ${args.join(' ')}`);
      }
      if (answer instanceof Error) {
        throw answer;
      }
      if (answer.stdout !== undefined && answer.stdout !== '') {
        onOutput({ stream: 'stdout', chunk: Buffer.from(answer.stdout) });
      }
      if (answer.stderr !== undefined) {
        onOutput({ stream: 'stderr', chunk: Buffer.from(answer.stderr) });
      }
      return { ok: true, value: { exitCode: answer.exitCode ?? 0 } };
    },
  };
}

/** One scripted App API response, or a transport failure. */
type AppAnswer = GitHubHttpResponse | Error;

/** An App transport answering the supplied responses in order and recording every request. */
function createAppTransport(answers: readonly AppAnswer[]): {
  readonly requests: GitHubHttpRequest[];
  readonly transport: GitHubHttpTransport;
} {
  const requests: GitHubHttpRequest[] = [];
  let index = 0;
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      const answer = answers[index];
      index += 1;
      if (answer === undefined) {
        throw new Error(`Unexpected App request: ${request.method} ${request.url}`);
      }
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
}

/** One provider response with a JSON body. */
function appJson(value: unknown, status = 200): GitHubHttpResponse {
  return { status, body: JSON.stringify(value) };
}

/** A gh command answering with a JSON body. */
function ghJson(value: unknown): GhAnswer {
  return { stdout: JSON.stringify(value) };
}

/** One installation token response expiring an hour from now. */
function installationToken(token = 'ghs_installation_token'): GitHubHttpResponse {
  return appJson({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
}

/** An adapter over a controlled CLI and App transport, with everything they observed. */
function harness(
  ghAnswers: readonly GhAnswer[],
  appAnswers: readonly AppAnswer[] = [],
): {
  readonly adapter: ReturnType<typeof createGitHubAdapter>;
  readonly gh: string[][];
  readonly app: GitHubHttpRequest[];
} {
  const gh = createGh(ghAnswers);
  const app = createAppTransport(appAnswers);
  return {
    adapter: createGitHubAdapter({ gh: gh.execute, nexusLens }, app.transport),
    gh: gh.calls,
    app: app.requests,
  };
}

/** The `-f key=value` fields of one recorded gh command. */
function ghFields(call: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 0; index < call.length; index += 1) {
    if (call[index] !== '-f') {
      continue;
    }
    const pair = call[index + 1];
    if (pair === undefined) {
      continue;
    }
    const separator = pair.indexOf('=');
    fields[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return fields;
}

/** The JSON body of one recorded App request. */
function appBody(request: GitHubHttpRequest | undefined): unknown {
  return JSON.parse(request?.body ?? 'null') as unknown;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GitHub adapter', () => {
  it('finds pull requests for the branch and base across every page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      html_url: `https://github.com/acme/nexus/pull/${index + 1}`,
    }));
    const { adapter, gh, app } = harness([
      ghJson(firstPage),
      ghJson([{ number: 101, html_url: 'https://github.com/acme/nexus/pull/101' }]),
    ]);

    const found = valueOf(
      await adapter.findPullRequests(repository, {
        branch: 'feature/task-7',
        baseBranch: 'main',
      }),
    );

    expect(found).toHaveLength(101);
    expect(found[0]).toEqual({ number: 1, url: 'https://github.com/acme/nexus/pull/1' });
    expect(found[100]).toEqual({ number: 101, url: 'https://github.com/acme/nexus/pull/101' });
    expect(gh).toHaveLength(2);
    expect(gh[0]?.slice(0, 4)).toEqual([
      'api',
      '--method',
      'GET',
      '/repos/acme/nexus/pulls?state=all&head=acme%3Afeature%2Ftask-7&base=main&per_page=100&page=1',
    ]);
    expect(gh[1]?.join(' ')).toContain('page=2');
    expect(app).toHaveLength(0);
  });

  it('reports a failed gh command with its diagnostics', async () => {
    const { adapter } = harness([{ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)\n' }]);

    const result = await adapter.readPullRequest(repository, 7);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('gh: Not Found (HTTP 404)') },
    });
  });

  it('reports a CLI response that is not JSON', async () => {
    const { adapter } = harness([{ stdout: 'not json' }]);

    const result = await adapter.readChecks(repository, 'head-revision');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('not JSON') },
    });
  });

  it('reports an unexpected provider response', async () => {
    const { adapter } = harness([ghJson({ number: 'seven' })]);

    const result = await adapter.readPullRequest(repository, 7);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('unexpected response') },
    });
  });

  it('rejects a repository identity outside owner/name form without calling the CLI', async () => {
    const { adapter, gh, app } = harness([]);

    const result = await adapter.findPullRequests('acme/nexus/extra', {
      branch: 'feature/task-7',
      baseBranch: 'main',
    });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('owner/name') },
    });
    expect(gh).toHaveLength(0);
    expect(app).toHaveLength(0);
  });

  it('reports head, base and auto-merge state without inventing a merge revision', async () => {
    const { adapter, app } = harness([
      ghJson({
        number: 7,
        html_url: 'https://github.com/acme/nexus/pull/7',
        state: 'open',
        merged: false,
        // Before merging, the provider reports its test merge commit here.
        merge_commit_sha: 'test-merge-commit',
        head: { sha: 'head-revision' },
        base: { ref: 'main' },
        auto_merge: null,
      }),
    ]);

    const pull = valueOf(await adapter.readPullRequest(repository, 7));

    expect(pull).toEqual({
      number: 7,
      url: 'https://github.com/acme/nexus/pull/7',
      state: 'open',
      merged: false,
      baseBranch: 'main',
      headRevision: 'head-revision',
      mergeRevision: null,
      autoMergeEnabled: false,
    });
    expect(app).toHaveLength(0);
  });

  it('reports the merge revision and auto-merge state of a merged pull request', async () => {
    const { adapter } = harness([
      ghJson({
        number: 7,
        html_url: 'https://github.com/acme/nexus/pull/7',
        state: 'closed',
        merged: true,
        merge_commit_sha: 'merge-revision',
        head: { sha: 'head-revision' },
        base: { ref: 'main' },
        auto_merge: { merge_method: 'squash' },
      }),
    ]);

    const pull = valueOf(await adapter.readPullRequest(repository, 7));

    expect(pull).toMatchObject({
      state: 'closed',
      merged: true,
      mergeRevision: 'merge-revision',
      autoMergeEnabled: true,
    });
  });

  it('reports a merged pull request without a merge revision', async () => {
    const { adapter } = harness([
      ghJson({
        number: 7,
        html_url: 'https://github.com/acme/nexus/pull/7',
        state: 'closed',
        merged: true,
        merge_commit_sha: null,
        head: { sha: 'head-revision' },
        base: { ref: 'main' },
        auto_merge: null,
      }),
    ]);

    const result = await adapter.readPullRequest(repository, 7);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('without a merge revision') },
    });
  });

  it('creates a pull request with explicit branch, base and content', async () => {
    const { adapter, gh } = harness([
      ghJson({
        number: 9,
        html_url: 'https://github.com/acme/nexus/pull/9',
        head: { sha: 'published-head' },
      }),
    ]);

    const publication = valueOf(
      await adapter.createPullRequest(repository, {
        baseBranch: 'main',
        headBranch: 'feature/task-7',
        title: 'NEX-7 Add the feature',
        body: 'What changed and why.',
      }),
    );

    expect(publication).toEqual({
      number: 9,
      url: 'https://github.com/acme/nexus/pull/9',
      headRevision: 'published-head',
    });
    expect(gh[0]?.slice(0, 4)).toEqual(['api', '--method', 'POST', '/repos/acme/nexus/pulls']);
    expect(ghFields(gh[0] ?? [])).toEqual({
      title: 'NEX-7 Add the feature',
      head: 'feature/task-7',
      base: 'main',
      body: 'What changed and why.',
    });
  });

  it('updates only the requested pull request fields', async () => {
    const { adapter, gh } = harness([
      ghJson({
        number: 9,
        html_url: 'https://github.com/acme/nexus/pull/9',
        head: { sha: 'updated-head' },
      }),
    ]);

    const publication = valueOf(
      await adapter.updatePullRequest(repository, 9, { body: 'Refreshed summary.' }),
    );

    expect(publication.headRevision).toBe('updated-head');
    expect(gh[0]?.slice(0, 4)).toEqual(['api', '--method', 'PATCH', '/repos/acme/nexus/pulls/9']);
    expect(ghFields(gh[0] ?? [])).toEqual({ body: 'Refreshed summary.' });
  });

  it('reads the complete conversation, reviews and review threads', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `comment ${index + 1}`,
    }));
    const { adapter, gh } = harness([
      ghJson(firstPage),
      ghJson([{ id: 101, body: 'comment 101' }]),
      ghJson([
        {
          id: 55,
          state: 'CHANGES_REQUESTED',
          body: 'Needs work',
          commit_id: 'reviewed-revision',
          user: { login: 'nexus-lens[bot]', type: 'Bot' },
        },
        { id: 56, state: 'COMMENTED', body: 'Note', commit_id: null, user: null },
      ]),
      ghJson([{ id: 77, body: 'Reply', path: 'src/index.ts', in_reply_to_id: 66 }]),
    ]);

    const conversation = valueOf(await adapter.readConversation(repository, 9));

    expect(conversation.comments).toHaveLength(101);
    expect(conversation.comments[100]).toEqual({ id: 101, body: 'comment 101' });
    expect(conversation.reviews).toEqual([
      {
        id: 55,
        state: 'CHANGES_REQUESTED',
        body: 'Needs work',
        commit_id: 'reviewed-revision',
        user: { login: 'nexus-lens[bot]', type: 'Bot' },
        author: 'nexus-lens[bot]',
      },
      { id: 56, state: 'COMMENTED', body: 'Note', commit_id: null, user: null, author: null },
    ]);
    expect(conversation.reviewComments[0]).toMatchObject({
      id: 77,
      path: 'src/index.ts',
      in_reply_to_id: 66,
    });
    expect(gh.map((call) => call[3])).toEqual([
      '/repos/acme/nexus/issues/9/comments?per_page=100&page=1',
      '/repos/acme/nexus/issues/9/comments?per_page=100&page=2',
      '/repos/acme/nexus/pulls/9/reviews?per_page=100&page=1',
      '/repos/acme/nexus/pulls/9/comments?per_page=100&page=1',
    ]);
  });

  it('reads checks with their producing app identity', async () => {
    const { adapter, gh, app } = harness([
      ghJson({
        total_count: 2,
        check_runs: [
          {
            id: 31,
            head_sha: 'merge-revision',
            name: 'Nexus Lens review',
            status: 'completed',
            conclusion: 'success',
            app: { id: 5001141, slug: 'nexus-lens', name: 'Nexus Lens' },
          },
          {
            id: 32,
            head_sha: 'merge-revision',
            name: 'ci',
            status: 'completed',
            conclusion: 'failure',
            app: null,
          },
        ],
      }),
    ]);

    const checks = valueOf(await adapter.readChecks(repository, 'merge-revision'));

    expect(checks).toEqual([
      {
        id: 31,
        revision: 'merge-revision',
        name: 'Nexus Lens review',
        producer: { id: 5001141, slug: 'nexus-lens', name: 'Nexus Lens' },
        status: 'completed',
        conclusion: 'success',
      },
      {
        id: 32,
        revision: 'merge-revision',
        name: 'ci',
        producer: null,
        status: 'completed',
        conclusion: 'failure',
      },
    ]);
    expect(gh[0]?.join(' ')).toContain(
      '/repos/acme/nexus/commits/merge-revision/check-runs?per_page=100&page=1',
    );
    expect(app).toHaveLength(0);
  });

  it.each([
    ['approved', 'APPROVE'],
    ['changesRequested', 'REQUEST_CHANGES'],
    ['inconclusive', 'COMMENT'],
  ] as const)('publishes a %s review as the Nexus Lens App', async (verdict, event) => {
    const { adapter, gh, app } = harness(
      [],
      [
        installationToken(),
        appJson({ id: 88, html_url: 'https://github.com/acme/nexus/pull/9#pullrequestreview-88' }),
      ],
    );

    const review = valueOf(
      await adapter.publishReview(repository, {
        pullRequestNumber: 9,
        revision: 'reviewed-head',
        verdict,
        body: 'Complete findings.',
      }),
    );

    expect(review).toEqual({
      id: 88,
      url: 'https://github.com/acme/nexus/pull/9#pullrequestreview-88',
    });
    expect(gh).toHaveLength(0);
    expect(app).toHaveLength(2);
    expect(app[1]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/repos/acme/nexus/pulls/9/reviews',
      headers: {
        authorization: 'Bearer ghs_installation_token',
        'content-type': 'application/json',
      },
    });
    expect(appBody(app[1])).toEqual({
      commit_id: 'reviewed-head',
      body: 'Complete findings.',
      event,
    });
  });

  it('signs short-lived App JWTs with the supplied private key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { adapter, app } = harness(
      [],
      [
        installationToken(),
        appJson({ id: 88, html_url: 'https://github.com/acme/nexus/pull/9#pullrequestreview-88' }),
      ],
    );

    await adapter.publishReview(repository, {
      pullRequestNumber: 9,
      revision: 'reviewed-head',
      verdict: 'approved',
      body: 'Approved.',
    });

    expect(app[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/app/installations/163007360/access_tokens',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    const authorization = app[0]?.headers['authorization'] ?? '';
    const [header, payload, signature] = authorization.replace(/^Bearer /u, '').split('.');
    if (header === undefined || payload === undefined || signature === undefined) {
      throw new Error('The installation request did not carry a JWT');
    }
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const now = Math.floor(Date.now() / 1000);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      readonly iat: number;
      readonly exp: number;
      readonly iss: number;
    };
    expect(claims.iss).toBe(nexusLens.appId);
    expect(claims.iat).toBe(now - 60);
    expect(claims.exp).toBeGreaterThan(now);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature, 'base64url')),
    ).toBe(true);
  });

  it('reuses the installation token until it expires, then renews it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const review = {
      pullRequestNumber: 9,
      revision: 'reviewed-head',
      verdict: 'approved',
      body: 'Approved.',
    } as const;
    const { adapter, app } = harness(
      [],
      [
        installationToken('ghs_first'),
        appJson({ id: 88, html_url: 'https://github.com/acme/nexus/pull/9#pullrequestreview-88' }),
        appJson({ id: 88, html_url: 'https://github.com/acme/nexus/pull/9#pullrequestreview-88' }),
        installationToken('ghs_second'),
        appJson({ id: 89, html_url: 'https://github.com/acme/nexus/pull/9#pullrequestreview-89' }),
      ],
    );
    const tokenRequests = (): number =>
      app.filter((request) => request.url.endsWith('/access_tokens')).length;

    await adapter.publishReview(repository, review);
    await adapter.publishReview(repository, review);
    expect(tokenRequests()).toBe(1);
    expect(app[1]?.headers['authorization']).toBe('Bearer ghs_first');
    expect(app[2]?.headers['authorization']).toBe('Bearer ghs_first');

    vi.setSystemTime(Date.now() + 3_600_000);
    const afterExpiry = valueOf(await adapter.publishReview(repository, review));

    expect(afterExpiry.id).toBe(89);
    expect(tokenRequests()).toBe(2);
    expect(app[3]?.url).toBe('https://api.github.com/app/installations/163007360/access_tokens');
    expect(app[4]?.headers['authorization']).toBe('Bearer ghs_second');
  });

  it('renews the installation token when the provider rejects it', async () => {
    const { adapter, app } = harness(
      [],
      [
        installationToken('ghs_first'),
        appJson({ id: 88, html_url: 'https://github.com/acme/nexus/pull/9#pullrequestreview-88' }),
        { status: 401, body: JSON.stringify({ message: 'Bad credentials' }) },
        installationToken('ghs_second'),
        appJson({ id: 89, html_url: 'https://github.com/acme/nexus/pull/9#pullrequestreview-89' }),
      ],
    );
    const review = {
      pullRequestNumber: 9,
      revision: 'reviewed-head',
      verdict: 'approved',
      body: 'Approved.',
    } as const;

    await adapter.publishReview(repository, review);
    const renewed = valueOf(await adapter.publishReview(repository, review));

    expect(renewed.id).toBe(89);
    expect(app).toHaveLength(5);
    expect(app[2]?.headers['authorization']).toBe('Bearer ghs_first');
    expect(app[3]?.url).toBe('https://api.github.com/app/installations/163007360/access_tokens');
    expect(app[4]?.headers['authorization']).toBe('Bearer ghs_second');
  });

  it('reports provider failures without exposing the installation token', async () => {
    const { adapter, app } = harness(
      [],
      [
        installationToken('ghs_secret_value'),
        {
          status: 403,
          body: JSON.stringify({
            message: 'Resource not accessible by integration',
            errors: [{ message: 'Checks write access is required' }],
          }),
        },
      ],
    );

    const result = await adapter.publishReviewCheck(repository, {
      revision: 'reviewed-head',
      name: 'Nexus Lens review',
      result: 'success',
    });

    expect(result).toMatchObject({
      ok: false,
      fault: {
        message: expect.stringContaining(
          'Resource not accessible by integration; Checks write access is required',
        ),
      },
    });
    if (result.ok) {
      throw new Error('Expected a fault');
    }
    expect(result.fault.message).not.toContain('ghs_secret_value');
    expect(app).toHaveLength(2);
  });

  it('publishes the configured review check under the App identity', async () => {
    const { adapter, gh, app } = harness(
      [],
      [installationToken(), appJson({ check_runs: [] }), appJson({ id: 44 }, 201)],
    );

    const check = valueOf(
      await adapter.publishReviewCheck(repository, {
        revision: 'reviewed-head',
        name: 'Nexus Lens review',
        result: 'failure',
      }),
    );

    expect(check).toEqual({ id: 44 });
    expect(gh).toHaveLength(0);
    expect(app[1]).toMatchObject({
      method: 'GET',
      url: 'https://api.github.com/repos/acme/nexus/commits/reviewed-head/check-runs?check_name=Nexus+Lens+review&app_id=5001141&per_page=1',
    });
    expect(app[2]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/repos/acme/nexus/check-runs',
    });
    expect(appBody(app[2])).toEqual({
      name: 'Nexus Lens review',
      head_sha: 'reviewed-head',
      status: 'completed',
      conclusion: 'failure',
    });
  });

  it('updates the existing App review check for the revision', async () => {
    const { adapter, app } = harness(
      [],
      [
        installationToken(),
        appJson({
          check_runs: [{ id: 41, head_sha: 'reviewed-head', name: 'Nexus Lens review' }],
        }),
        appJson({ id: 41, head_sha: 'reviewed-head', name: 'Nexus Lens review' }),
      ],
    );

    const check = valueOf(
      await adapter.publishReviewCheck(repository, {
        revision: 'reviewed-head',
        name: 'Nexus Lens review',
        result: 'success',
      }),
    );

    expect(check).toEqual({ id: 41 });
    expect(app[2]).toMatchObject({
      method: 'PATCH',
      url: 'https://api.github.com/repos/acme/nexus/check-runs/41',
    });
    expect(appBody(app[2])).toEqual({ status: 'completed', conclusion: 'success' });
  });

  it('requests auto-merge for the expected head through the operator identity', async () => {
    const { adapter, gh, app } = harness([
      ghJson({ node_id: 'PR_node_9' }),
      ghJson({ data: { enablePullRequestAutoMerge: { pullRequest: { number: 9 } } } }),
    ]);

    const result = await adapter.requestAutoMerge(repository, 9, 'reviewed-head');

    expect(result).toEqual({ ok: true, value: undefined });
    expect(app).toHaveLength(0);
    expect(gh[0]?.slice(0, 4)).toEqual(['api', '--method', 'GET', '/repos/acme/nexus/pulls/9']);
    expect(gh[1]?.slice(0, 4)).toEqual(['api', '--method', 'POST', 'graphql']);
    const graphql = ghFields(gh[1] ?? []);
    expect(graphql['pullRequestId']).toBe('PR_node_9');
    expect(graphql['expectedHeadOid']).toBe('reviewed-head');
    expect(graphql['query']).toContain('enablePullRequestAutoMerge');
  });

  it('reports a rejected auto-merge request', async () => {
    const { adapter } = harness([
      ghJson({ node_id: 'PR_node_9' }),
      {
        exitCode: 1,
        stderr: 'GraphQL: Head branch was modified. Review and try the merge again.\n',
      },
    ]);

    const result = await adapter.requestAutoMerge(repository, 9, 'stale-head');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('Head branch was modified') },
    });
  });

  it('reads runs and jobs of the configured workflows for a revision', async () => {
    const { adapter, gh } = harness([
      ghJson({
        total_count: 3,
        workflow_runs: [
          {
            id: 501,
            name: 'Post-merge checks',
            path: '.github/workflows/post-merge.yml',
            head_sha: 'merge-revision',
            status: 'completed',
            conclusion: 'success',
          },
          {
            id: 502,
            name: 'Unrelated workflow',
            path: '.github/workflows/other.yml',
            head_sha: 'merge-revision',
            status: 'completed',
            conclusion: 'failure',
          },
          {
            id: 503,
            name: 'Nightly checks',
            path: '.github/workflows/post-merge.yml',
            head_sha: 'merge-revision',
            status: 'in_progress',
            conclusion: null,
          },
        ],
      }),
      ghJson({
        total_count: 1,
        jobs: [
          {
            id: 900,
            name: 'verify',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'merge-revision',
          },
        ],
      }),
      ghJson({ total_count: 0, jobs: [] }),
    ]);

    const runs = valueOf(
      await adapter.readWorkflowRuns(repository, 'merge-revision', [
        'Post-merge checks',
        '.github/workflows/post-merge.yml',
      ]),
    );

    expect(runs).toEqual([
      {
        id: 501,
        name: 'Post-merge checks',
        path: '.github/workflows/post-merge.yml',
        revision: 'merge-revision',
        status: 'completed',
        conclusion: 'success',
        jobs: [
          {
            id: 900,
            name: 'verify',
            status: 'completed',
            conclusion: 'success',
            revision: 'merge-revision',
          },
        ],
      },
      {
        id: 503,
        name: 'Nightly checks',
        path: '.github/workflows/post-merge.yml',
        revision: 'merge-revision',
        status: 'in_progress',
        conclusion: null,
        jobs: [],
      },
    ]);
    expect(gh.map((call) => call[3])).toEqual([
      '/repos/acme/nexus/actions/runs?head_sha=merge-revision&per_page=100&page=1',
      '/repos/acme/nexus/actions/runs/501/jobs?per_page=100&page=1',
      '/repos/acme/nexus/actions/runs/503/jobs?per_page=100&page=1',
    ]);
  });

  it('performs App requests over the default HTTP transport', async () => {
    const calls: { readonly url: string; readonly init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        if (String(input).endsWith('/access_tokens')) {
          const body = {
            token: 'ghs_default',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          };
          return new Response(JSON.stringify(body), { status: 201 });
        }
        const body = {
          id: 88,
          html_url: 'https://github.com/acme/nexus/pull/9#pullrequestreview-88',
        };
        return new Response(JSON.stringify(body), { status: 201 });
      }),
    );
    const gh = createGh([]);
    const adapter = createGitHubAdapter({ gh: gh.execute, nexusLens });

    const review = valueOf(
      await adapter.publishReview(repository, {
        pullRequestNumber: 9,
        revision: 'reviewed-head',
        verdict: 'approved',
        body: 'Approved.',
      }),
    );

    expect(review.id).toBe(88);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/app/installations/163007360/access_tokens',
      'https://api.github.com/repos/acme/nexus/pulls/9/reviews',
    ]);
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { 'x-github-api-version': '2022-11-28' },
    });
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        commit_id: 'reviewed-head',
        body: 'Approved.',
        event: 'APPROVE',
      }),
    });
  });
});
