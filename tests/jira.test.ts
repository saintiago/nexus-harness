/**
 * Component tests: the real Jira adapter drives a controlled HTTP transport, establishing the
 * requests it makes, its interpretation of provider responses, complete collection handling and
 * provider errors. No live Jira access is involved.
 */

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import {
  createJiraAdapter,
  type JiraHttpRequest,
  type JiraHttpResponse,
  type JiraHttpTransport,
  type JiraSettings,
} from '../src/adapters/jira.js';

const cloudId = '9337c4da-7d33-4c1d-b03c-db207e537f88';
const apiBase = `https://api.atlassian.com/ex/jira/${cloudId}`;
const apiToken = 'operator-api-token';

const settings: JiraSettings = {
  connection: { apiBase, apiToken },
  project: 'NEX',
  fields: { workspacePointer: 'customfield_10042', pullRequest: 'customfield_10043' },
};

/** One controlled provider answer, or a transport failure. */
type Answer = JiraHttpResponse | Error;

/** A transport answering the supplied responses in order and recording every request. */
function createScriptedServer(answers: readonly Answer[]): {
  readonly requests: JiraHttpRequest[];
  readonly transport: JiraHttpTransport;
} {
  const requests: JiraHttpRequest[] = [];
  let index = 0;
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      const answer = answers[index];
      index += 1;
      if (answer === undefined) {
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
}

/** An adapter over a controlled server, with the requests it received. */
function adapterOver(answers: readonly Answer[]): {
  readonly adapter: ReturnType<typeof createJiraAdapter>;
  readonly requests: JiraHttpRequest[];
} {
  const { requests, transport } = createScriptedServer(answers);
  return { adapter: createJiraAdapter(settings, transport), requests };
}

/** One provider response with a JSON body. */
function json(value: unknown, status = 200): JiraHttpResponse {
  return { status, body: JSON.stringify(value) };
}

/** One provider response without a body. */
function empty(status: number): JiraHttpResponse {
  return { status, body: '' };
}

/** Parse one recorded request body. */
function bodyOf(request: { readonly body?: string } | undefined): unknown {
  return JSON.parse(request?.body ?? 'null') as unknown;
}

/** One request a controlled local HTTP server received. */
type ServedRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly body: string;
};

/**
 * A controlled HTTP server answering every request with the supplied response. The default
 * transport is exercised over a real socket, without reaching a live Jira site.
 */
async function startServer(answer: JiraHttpResponse): Promise<{
  readonly apiBase: string;
  readonly requests: ServedRequest[];
  stop(): Promise<void>;
}> {
  const requests: ServedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The controlled server did not expose an address');
  }
  return {
    apiBase: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('Jira adapter', () => {
  it('performs the request over HTTP with the host connection bearer token', async () => {
    const server = await startServer(json({ issues: [], isLast: true }));
    try {
      const adapter = createJiraAdapter({
        ...settings,
        connection: { ...settings.connection, apiBase: server.apiBase },
      });

      const result = await adapter.searchIssues({ query: 'project = NEX', orderBy: 'Rank' });

      expect(result).toEqual({ ok: true, value: [] });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({
        method: 'POST',
        url: '/rest/api/3/search/jql',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
        },
      });
      expect(bodyOf(server.requests[0])).toEqual({ jql: 'project = NEX order by Rank' });
    } finally {
      await server.stop();
    }
  });

  it('reads one issue without its conversation through the configured API base', async () => {
    const issue = {
      id: '10001',
      key: 'NEX-1',
      self: 'https://example.atlassian.net/rest/api/3/issue/10001',
      fields: {
        summary: 'Add the feature',
        status: { id: '1', name: 'To Do' },
        customfield_10042: null,
      },
    };
    const { adapter, requests } = adapterOver([json(issue)]);

    const result = await adapter.readIssue('NEX-1');

    expect(result).toEqual({ ok: true, value: issue });
    expect(requests).toEqual([
      {
        method: 'GET',
        url: `${apiBase}/rest/api/3/issue/NEX-1?fields=*all%2C-comment`,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiToken}`,
        },
      },
    ]);
  });

  it('reads the complete candidate list in configured order across search pages', async () => {
    const { adapter, requests } = adapterOver([
      json({ issues: [{ id: '1', key: 'NEX-1' }], nextPageToken: 'page-2', isLast: false }),
      json({
        issues: [
          { id: '2', key: 'NEX-2' },
          { id: '3', key: 'NEX-3' },
        ],
        isLast: true,
      }),
    ]);

    const result = await adapter.searchIssues({
      query: 'project = NEX AND status = "To Do"',
      orderBy: 'Rank',
    });

    expect(result).toEqual({
      ok: true,
      value: [
        { id: '1', key: 'NEX-1' },
        { id: '2', key: 'NEX-2' },
        { id: '3', key: 'NEX-3' },
      ],
    });
    expect(bodyOf(requests[0])).toEqual({
      jql: 'project = NEX AND status = "To Do" order by Rank',
    });
    expect(bodyOf(requests[1])).toEqual({
      jql: 'project = NEX AND status = "To Do" order by Rank',
      nextPageToken: 'page-2',
    });
  });

  it('reports a search page that is not last but has no next page token', async () => {
    const { adapter, requests } = adapterOver([
      json({ issues: [{ id: '1', key: 'NEX-1' }], isLast: false }),
    ]);

    const result = await adapter.searchIssues({ query: 'project = NEX', orderBy: 'Rank' });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('without a next page token') },
    });
    expect(requests).toHaveLength(1);
  });

  it('reports a repeated search page token instead of returning an incomplete list', async () => {
    const { adapter, requests } = adapterOver([
      json({ issues: [], nextPageToken: 'page-2', isLast: false }),
      json({ issues: [], nextPageToken: 'page-2', isLast: false }),
    ]);

    const result = await adapter.searchIssues({ query: 'project = NEX', orderBy: 'Rank' });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('repeated page token "page-2"') },
    });
    expect(requests).toHaveLength(2);
  });

  it('reports a cyclic search page token instead of returning an incomplete list', async () => {
    const { adapter, requests } = adapterOver([
      json({ issues: [{ id: '1', key: 'NEX-1' }], nextPageToken: 'page-2', isLast: false }),
      json({ issues: [{ id: '2', key: 'NEX-2' }], nextPageToken: 'page-3', isLast: false }),
      json({ issues: [{ id: '3', key: 'NEX-3' }], nextPageToken: 'page-2', isLast: false }),
    ]);

    const result = await adapter.searchIssues({ query: 'project = NEX', orderBy: 'Rank' });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('repeated page token "page-2"') },
    });
    expect(requests).toHaveLength(3);
  });

  it('reports provider errors without leaking the API token', async () => {
    const { adapter } = adapterOver([
      {
        status: 400,
        body: JSON.stringify({
          errorMessages: ['Error in the JQL Query: missing project'],
          errors: { jql: 'Unexpected end of query' },
        }),
      },
    ]);

    const result = await adapter.searchIssues({ query: 'status = "To Do"', orderBy: 'Rank' });

    expect(result).toMatchObject({ ok: false, fault: { message: expect.any(String) } });
    if (result.ok) {
      throw new Error('expected a fault');
    }
    expect(result.fault.message).toContain(
      'Error in the JQL Query: missing project; jql: Unexpected end of query',
    );
    expect(result.fault.message).not.toContain(settings.connection.apiToken);
  });

  it('reports an unexpected response instead of accepting it', async () => {
    const { adapter } = adapterOver([json({ id: '10001' })]);

    const result = await adapter.readIssue('NEX-1');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('unexpected response') },
    });
  });

  it('reads every comment in the provider order', async () => {
    const first = {
      id: '10000',
      author: { displayName: 'Mia Krystof' },
      body: { version: 1, type: 'doc', content: [] },
      created: '2026-01-17T12:34:00.000+0000',
    };
    const second = {
      id: '10001',
      author: { displayName: 'Operator' },
      body: { version: 1, type: 'doc', content: [{ type: 'paragraph' }] },
      created: '2026-01-18T09:00:00.000+0000',
    };
    const { adapter, requests } = adapterOver([
      json({ startAt: 0, maxResults: 1, total: 2, comments: [first] }),
      json({ startAt: 1, maxResults: 1, total: 2, comments: [second] }),
    ]);

    const result = await adapter.readComments('NEX-1');

    expect(result).toEqual({ ok: true, value: [first, second] });
    expect(requests[1]?.url).toBe(`${apiBase}/rest/api/3/issue/NEX-1/comment?startAt=1`);
  });

  it('reports an incomplete comment collection instead of a partial page', async () => {
    const { adapter } = adapterOver([
      json({ startAt: 0, maxResults: 1, total: 2, comments: [{ id: '10000', body: {} }] }),
      json({ startAt: 1, maxResults: 1, total: 2, comments: [] }),
    ]);

    const result = await adapter.readComments('NEX-1');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('no comments at offset 1 while reporting 2') },
    });
  });

  it('returns the permitted transitions with their destinations', async () => {
    const transitions = [
      {
        id: '21',
        name: 'Start Progress',
        to: { id: '3', name: 'In Progress' },
        isAvailable: true,
        hasScreen: false,
      },
      { id: '31', name: 'Review', to: { id: '4', name: 'In Review' } },
    ];
    const { adapter } = adapterOver([json({ transitions })]);

    expect(await adapter.readTransitions('NEX-1')).toEqual({ ok: true, value: transitions });
  });

  it('transitions through the explicit transition its caller selected', async () => {
    const { adapter, requests } = adapterOver([empty(204)]);

    const result = await adapter.transitionIssue('NEX-1', '31');

    expect(result).toEqual({ ok: true, value: undefined });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: `${apiBase}/rest/api/3/issue/NEX-1/transitions`,
    });
    expect(bodyOf(requests[0])).toEqual({ transition: { id: '31' } });
  });

  it('reports a provider transition error', async () => {
    const { adapter } = adapterOver([
      { status: 400, body: JSON.stringify({ errorMessages: ['Transition is not valid'] }) },
    ]);

    const result = await adapter.transitionIssue('NEX-1', '31');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('Transition is not valid') },
    });
  });

  it('changes the requested fields through their configured identities', async () => {
    const { adapter, requests } = adapterOver([empty(204)]);

    const result = await adapter.updateFields('NEX-1', {
      pullRequest: 'https://github.com/acme/repository/pull/7',
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      url: `${apiBase}/rest/api/3/issue/NEX-1`,
    });
    expect(bodyOf(requests[0])).toEqual({
      fields: { customfield_10043: 'https://github.com/acme/repository/pull/7' },
    });
  });

  it('clears the mapped fields with null', async () => {
    const { adapter, requests } = adapterOver([empty(204)]);

    const result = await adapter.updateFields('NEX-1', {
      workspacePointer: null,
      pullRequest: null,
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(bodyOf(requests[0])).toEqual({
      fields: { customfield_10042: null, customfield_10043: null },
    });
  });

  it('reports provider field errors on a change', async () => {
    const { adapter } = adapterOver([
      {
        status: 400,
        body: JSON.stringify({
          errorMessages: [],
          errors: { customfield_10042: 'Field is not on the screen' },
        }),
      },
    ]);

    const result = await adapter.updateFields('NEX-1', { workspacePointer: '/workspace/NEX-1' });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('customfield_10042: Field is not on the screen') },
    });
  });

  it('adds a comment with the supplied document body and returns its identity', async () => {
    const body = {
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Published for review' }] }],
    };
    const created = { id: '10010', author: { displayName: 'Operator' }, body };
    const { adapter, requests } = adapterOver([json(created, 201)]);

    const result = await adapter.addComment('NEX-1', body);

    expect(result).toEqual({ ok: true, value: created });
    expect(bodyOf(requests[0])).toEqual({ body });
    expect(requests[0]?.url).toBe(`${apiBase}/rest/api/3/issue/NEX-1/comment`);
  });

  it('edits the identified comment', async () => {
    const body = { version: 1, type: 'doc', content: [{ type: 'paragraph' }] };
    const updated = { id: '10010', body };
    const { adapter, requests } = adapterOver([json(updated)]);

    expect(await adapter.editComment('NEX-1', '10010', body)).toEqual({ ok: true, value: updated });
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      url: `${apiBase}/rest/api/3/issue/NEX-1/comment/10010`,
    });
    expect(bodyOf(requests[0])).toEqual({ body });
  });

  it('creates an issue in the configured project with the requested fields', async () => {
    const { adapter, requests } = adapterOver([
      json(
        {
          id: '10010',
          key: 'NEX-10',
          self: 'https://nexus.atlassian.net/rest/api/3/issue/10010',
        },
        201,
      ),
    ]);

    const result = await adapter.createIssue({
      summary: 'Blocker: queue processing stalls',
      description: { version: 1, type: 'doc', content: [] },
      issuetype: { name: 'Task' },
    });

    expect(result).toEqual({ ok: true, value: { id: '10010', key: 'NEX-10' } });
    expect(bodyOf(requests[0])).toEqual({
      fields: {
        summary: 'Blocker: queue processing stalls',
        description: { version: 1, type: 'doc', content: [] },
        issuetype: { name: 'Task' },
        project: { key: 'NEX' },
      },
    });
  });

  it('ranks an issue before and after an existing issue', async () => {
    const { adapter, requests } = adapterOver([empty(204), empty(204)]);

    expect(await adapter.rankIssue('NEX-3', { before: 'NEX-1' })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await adapter.rankIssue('NEX-3', { after: 'NEX-2' })).toEqual({
      ok: true,
      value: undefined,
    });

    expect(requests.map((request) => request.url)).toEqual([
      `${apiBase}/rest/agile/1.0/issue/rank`,
      `${apiBase}/rest/agile/1.0/issue/rank`,
    ]);
    expect(bodyOf(requests[0])).toEqual({ issues: ['NEX-3'], rankBeforeIssue: 'NEX-1' });
    expect(bodyOf(requests[1])).toEqual({ issues: ['NEX-3'], rankAfterIssue: 'NEX-2' });
  });

  it('reports the provider outcome when a ranking does not take effect', async () => {
    const { adapter } = adapterOver([
      {
        status: 207,
        body: JSON.stringify({
          entries: [
            {
              issueId: 10003,
              issueKey: 'NEX-3',
              status: 503,
              errors: [
                'JIRA Agile cannot execute the rank operation at this time. Please try again later.',
              ],
            },
          ],
        }),
      },
    ]);

    const result = await adapter.rankIssue('NEX-3', { before: 'NEX-1' });

    expect(result).toMatchObject({
      ok: false,
      fault: {
        message: expect.stringContaining('JIRA Agile cannot execute the rank operation'),
      },
    });
  });

  it('reports a provider body that is not JSON', async () => {
    const { adapter } = adapterOver([{ status: 200, body: '<html>maintenance</html>' }]);

    const result = await adapter.readIssue('NEX-1');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('is not JSON') },
    });
  });

  it('reports a transport failure', async () => {
    const { adapter } = adapterOver([new Error('connect ECONNREFUSED 127.0.0.1:443')]);

    const result = await adapter.readIssue('NEX-1');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('ECONNREFUSED') },
    });
  });
});
