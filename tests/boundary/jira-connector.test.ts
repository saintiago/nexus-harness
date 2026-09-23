/**
 * The Jira connector's queue, claim, pointer and publication behavior, against
 * real HTTP answers from a stand-in service on this host's loopback.
 *
 * The connector is the boundary that consumes the configured queue: it asks the
 * documented enhanced search with the configured JQL and follows its pages, maps
 * one issue's Atlassian Document Format description onto the existing four-field
 * `Task` — refusing content it cannot read rather than guessing — prepares a
 * candidate into the revision it observed, and claims it only while that
 * revision and the queue's status still hold: a claim that no longer does sends
 * no mutation at all. It also records the workspace pointer and publishes a
 * result, and neither moves an issue a human has already decided about.
 *
 * The service is a real HTTP server answering what a case wrote, so no live
 * account or credential is involved, while the connector's own URLs, headers and
 * signal are exactly what they are in production.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JiraSourceConfig } from '../../src/shared/types.js';
import {
  SourceError,
  workspacePointerLabel,
  WORKSPACE_POINTER_PREFIX,
} from '../../src/sources/contract.js';
import type {
  SourceCandidate,
  SourceRunOutcome,
  SourceTask,
  TaskSource,
} from '../../src/sources/contract.js';
import { createJiraSource } from '../../src/sources/jira/connector.js';
import { createHttpClient } from '../../src/sources/jira/http.js';
import type { HttpClient } from '../../src/sources/jira/http.js';
import { discoverQueueWork } from '../../src/sources/jira/queue.js';
import { queueJql } from '../../src/sources/jira/search.js';
import { startLocalService, serviceFetch } from './integration-support.js';
import type { LocalService, ReceivedRequest, ServiceAnswer } from './integration-support.js';

/** The site one service account is configured for. */
const SITE = 'https://example.atlassian.net';
const CLOUD_ID = 'cloud-123';
const GATEWAY = `/ex/jira/${CLOUD_ID}`;

const CONFIG: JiraSourceConfig = {
  type: 'jira',
  siteUrl: SITE,
  cloudId: CLOUD_ID,
  projectKey: 'SAM1',
  issueType: 'Task',
  label: 'harness-task',
  readyStatus: 'To Do',
  runningStatus: 'In Progress',
  reviewStatus: 'In Review',
  ordering: 'priority',
  pollIntervalSeconds: 30,
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

/** One issue as the documented REST API v3 shape, with the fields the queue reads. */
function issue(
  overrides: {
    readonly id?: string;
    readonly key?: string;
    readonly summary?: string;
    readonly description?: unknown;
    readonly status?: string;
    readonly labels?: readonly string[];
    readonly updated?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? '10011',
    key: overrides.key ?? 'SAM1-11',
    fields: {
      summary: overrides.summary ?? 'Create the smoke-test marker',
      description: 'description' in overrides ? overrides.description : description(),
      status: { name: overrides.status ?? 'To Do' },
      labels: overrides.labels ?? ['harness-task'],
      project: { key: 'SAM1' },
      issuetype: { name: 'Task' },
      updated: overrides.updated ?? '2026-09-16T11:00:00.000Z',
    },
  };
}

/** The documented description convention, with one acceptance criterion. */
function description(): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Goal' }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Do the thing the issue asks for.' }],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Acceptance criteria' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One criterion.' }] }],
          },
        ],
      },
    ],
  };
}

/** The candidates a queue search returns, with the revision they were listed at. */
function candidate(updatedAt = '2026-09-16T11:00:00.000Z'): SourceCandidate {
  return {
    ref: {
      type: 'jira',
      scope: SITE,
      id: '10011',
      key: 'SAM1-11',
      url: `${SITE}/browse/SAM1-11`,
      updatedAt,
    },
    title: 'Create the smoke-test marker',
  };
}

/** What one prepared attempt says about itself, for the publication cases. */
const PREPARED: SourceTask = {
  ref: candidate().ref,
  pointers: [],
  task: {
    id: 'SAM1-11',
    title: 'Create the smoke-test marker',
    description: '## Goal\n\nDo the thing the issue asks for.',
    acceptanceCriteria: ['One criterion.'],
  },
};

const OUTCOME: SourceRunOutcome = {
  runId: 'run-20260916120000-abcdef01',
  status: 'failed',
  reason:
    'the checks after the implementation turn did not pass and the repair allowance is exhausted (1 of 1 repair turn used)',
  repairsUsed: 1,
  checks: '1 of 2 configured checks exited 0 (round: failed)',
  runDir: 'E:/harness-runs/run-20260916120000-abcdef01',
  reportPath: 'E:/harness-runs/run-20260916120000-abcdef01/result.json',
};

const TRANSITIONS_TO_PROGRESS = {
  transitions: [
    { id: '11', name: 'Start work', to: { name: 'In Progress' } },
    { id: '21', name: 'Reopen', to: { name: 'To Do' } },
  ],
};

const TRANSITIONS_TO_REVIEW = {
  transitions: [{ id: '31', name: 'Send for review', to: { name: 'In Review' } }],
};

/** One connector pointed at a stand-in service, and the service it reaches. */
async function connect(
  answer: (request: ReceivedRequest, index: number) => ServiceAnswer,
): Promise<{ readonly source: TaskSource; readonly service: LocalService }> {
  const service = await startLocalService(answer);
  started.push(service);
  return {
    source: createJiraSource(CONFIG, TOKEN, { fetch: serviceFetch(service.origin) }),
    service,
  };
}

/** One gateway client pointed at a stand-in service, and the service it reaches. */
async function connectClient(
  answer: (request: ReceivedRequest, index: number) => ServiceAnswer,
): Promise<{ readonly client: HttpClient; readonly service: LocalService }> {
  const service = await startLocalService(answer);
  started.push(service);
  return {
    client: createHttpClient(CONFIG, TOKEN, { fetch: serviceFetch(service.origin) }),
    service,
  };
}

/** One JSON answer. */
function json(value: unknown, status = 200): ServiceAnswer {
  return { status, body: JSON.stringify(value) };
}

/** The one writes a case's service received, in order. */
function writes(service: LocalService): readonly ReceivedRequest[] {
  return service.requests.filter((request) => request.method !== 'GET');
}

/** The body of one request, as the JSON it was sent as. */
function sent(request: ReceivedRequest | undefined): Record<string, unknown> {
  return JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
}

/** The error one call that was expected to fail rejected with. */
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

describe('the configured queue', () => {
  it('asks the documented JQL, consumes its pages, and de-duplicates by immutable id', async () => {
    const { source, service } = await connect((request) => {
      const body = sent(request);
      return json(
        body['nextPageToken'] === undefined
          ? {
              issues: [
                issue({ id: '10011', key: 'SAM1-11' }),
                issue({ id: '10012', key: 'SAM1-12' }),
              ],
              nextPageToken: 'page-2',
            }
          : {
              issues: [
                issue({ id: '10012', key: 'SAM1-12' }),
                issue({ id: '10013', key: 'SAM1-13' }),
              ],
              isLast: true,
            },
      );
    });

    const candidates = await source.listEligible(new AbortController().signal);

    // The order the search returned, one candidate per issue, across both pages.
    expect(candidates.map((entry) => entry.ref.key)).toEqual(['SAM1-11', 'SAM1-12', 'SAM1-13']);
    expect(service.requests).toHaveLength(2);
    const [first, second] = service.requests;
    expect(first?.url).toBe(`${GATEWAY}/rest/api/3/search/jql`);
    expect(sent(first)['jql']).toBe(queueJql(CONFIG));
    expect(sent(first)['nextPageToken']).toBeUndefined();
    // A page that is not the last one is followed with the continuation token.
    expect(sent(second)['nextPageToken']).toBe('page-2');
    // The candidate carries the revision the search observed, so a claim can
    // refuse an issue that changed in between.
    expect(candidates[0]?.ref.updatedAt).toBe('2026-09-16T11:00:00.000Z');
  }, 45_000);

  it('re-reads an issue before preparing it, and refuses one that left the queue', async () => {
    const { source, service } = await connect(() => json(issue({ status: 'In Review' })));

    const prepared = await source.prepare(candidate(), new AbortController().signal);

    expect(prepared).toBeNull();
    // The re-read really happened: a search result is a candidate, not a claim.
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]?.url).toContain('/rest/api/3/issue/10011');
  }, 45_000);
});

describe('mapping one issue onto the task', () => {
  it('maps the documented description and the workspace pointers it names', async () => {
    const { source } = await connect(() =>
      json(issue({ labels: ['harness-task', workspacePointerLabel('HARN-54')] })),
    );

    const prepared = await source.prepare(candidate(), new AbortController().signal);

    expect(prepared?.task.id).toBe('SAM1-11');
    expect(prepared?.task.title).toBe('Create the smoke-test marker');
    expect(prepared?.task.acceptanceCriteria).toEqual(['One criterion.']);
    expect(prepared?.task.description).toContain('Do the thing the issue asks for.');
    expect(prepared?.ref.updatedAt).toBe('2026-09-16T11:00:00.000Z');
    // The pointers come from this reading, so a continuation decision never runs
    // on a search result that has since been overtaken.
    expect(prepared?.pointers).toEqual(['HARN-54']);
    expect(prepared?.preferredWorkspaceId).toBe('SAM1-11');
  }, 45_000);

  it('refuses description content this reader does not understand, naming the issue', async () => {
    const { source } = await connect(() =>
      json(
        issue({
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'table', content: [] }],
          },
        }),
      ),
    );

    const error = await failureOf(() => source.prepare(candidate(), new AbortController().signal));

    // A per-issue input error: nothing was claimed, and nothing was guessed.
    expect(error.kind).toBe('invalid-task');
    expect(error.message).toContain('SAM1-11');
    expect(error.message).toContain('table');
  }, 45_000);
});

describe('claiming an issue', () => {
  it('selects the transition by target status and sends exactly that one write', async () => {
    const { source, service } = await connect((request) => {
      if (request.url.includes('/transitions') && request.method === 'GET') {
        return json(TRANSITIONS_TO_PROGRESS);
      }
      if (request.method === 'POST') {
        return { status: 204 };
      }
      return json(issue());
    });
    const prepared = await source.prepare(candidate(), new AbortController().signal);

    const claimed = await source.claim(prepared as SourceTask, new AbortController().signal);

    expect(claimed).toBe(true);
    const written = writes(service);
    expect(written).toHaveLength(1);
    expect(written[0]?.method).toBe('POST');
    expect(written[0]?.url).toBe(`${GATEWAY}/rest/api/3/issue/10011/transitions`);
    expect(sent(written[0])).toEqual({ transition: { id: '11' } });
  }, 45_000);

  it('sends no mutation when the issue changed revision after it was prepared', async () => {
    // The first read is prepare's, which captures the revision it saw; the issue
    // is edited after that, so the claim's re-read no longer matches.
    const { source, service } = await connect((_request, index) =>
      json(
        issue({ updated: index === 0 ? '2026-09-16T11:00:00.000Z' : '2026-09-16T11:30:00.000Z' }),
      ),
    );
    const prepared = await source.prepare(candidate(), new AbortController().signal);

    const claimed = await source.claim(prepared as SourceTask, new AbortController().signal);

    expect(claimed).toBe(false);
    // Nothing was mutated: the coordinator may release the receipt it created.
    expect(writes(service)).toEqual([]);
  }, 45_000);

  it('sends no mutation when the issue left the queue after it was prepared', async () => {
    const { source, service } = await connect((_request, index) =>
      json(issue({ status: index === 0 ? 'To Do' : 'In Review' })),
    );
    const prepared = await source.prepare(candidate(), new AbortController().signal);

    const claimed = await source.claim(prepared as SourceTask, new AbortController().signal);

    expect(claimed).toBe(false);
    expect(writes(service)).toEqual([]);
  }, 45_000);

  it('refuses a workflow with no transition to the running status, and posts nothing', async () => {
    const { source, service } = await connect((request) =>
      request.url.includes('/transitions') && request.method === 'GET'
        ? json({ transitions: [{ id: '21', name: 'Reopen', to: { name: 'To Do' } }] })
        : json(issue()),
    );
    const prepared = await source.prepare(candidate(), new AbortController().signal);

    const error = await failureOf(() =>
      source.claim(prepared as SourceTask, new AbortController().signal),
    );

    expect(error.kind).toBe('fatal');
    expect(error.message).toContain('no transition to the status "In Progress"');
    expect(writes(service)).toEqual([]);
  }, 45_000);
});

describe('recording the workspace and publishing the result', () => {
  it('records the workspace pointer as one label add', async () => {
    const { source, service } = await connect(() => ({ status: 204 }));

    await source.recordWorkspace(PREPARED, 'HARN-54', new AbortController().signal);

    const written = writes(service);
    expect(written).toHaveLength(1);
    expect(written[0]?.method).toBe('PUT');
    expect(written[0]?.url).toBe(`${GATEWAY}/rest/api/3/issue/10011`);
    expect(sent(written[0])).toEqual({
      update: { labels: [{ add: `${WORKSPACE_POINTER_PREFIX}HARN-54` }] },
    });
  }, 45_000);

  it('publishes the result and moves the issue to review while it is still running', async () => {
    const { source, service } = await connect((request) => {
      if (request.method === 'POST' && request.url.endsWith('/comment')) {
        return json({ id: '9001' }, 201);
      }
      if (request.method === 'POST') {
        return { status: 204 };
      }
      if (request.url.includes('/transitions')) {
        return json(TRANSITIONS_TO_REVIEW);
      }
      return json(issue({ status: 'In Progress' }));
    });

    const published = await source.complete(PREPARED, OUTCOME, new AbortController().signal);

    expect(published.commentId).toBe('9001');
    const written = writes(service);
    expect(written.map((request) => request.method)).toEqual(['POST', 'POST']);
    const comment = sent(written[0]);
    const rendered = JSON.stringify(comment);
    expect(rendered).toContain(OUTCOME.runId);
    expect(rendered).toContain('the checks after the implementation turn did not pass');
    expect(sent(written[1])).toEqual({ transition: { id: '31' } });
  }, 45_000);

  it('does not move an issue a human has already decided about', async () => {
    const { source, service } = await connect((request) =>
      request.method === 'POST' && request.url.endsWith('/comment')
        ? json({ id: '9001' }, 201)
        : json(issue({ status: 'In Review' })),
    );

    const published = await source.complete(PREPARED, OUTCOME, new AbortController().signal);

    // The comment was published, but the later human decision stands: no
    // transition was sent for it.
    expect(published.commentId).toBe('9001');
    expect(writes(service).map((request) => request.url)).toEqual([
      `${GATEWAY}/rest/api/3/issue/10011/comment`,
    ]);
  }, 45_000);
});

/** One ADF document holding one paragraph, as a comment body is written. */
function document(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

describe('the ticket’s own conversation', () => {
  it('reads only the comments added since the previous attempt', async () => {
    const { source, service } = await connect(() =>
      json({
        comments: [
          {
            id: '1',
            author: { displayName: 'Ada' },
            created: '2026-09-15T10:00:00.000Z',
            body: document('The earlier note the harness already read.'),
          },
          {
            id: '2',
            author: { displayName: 'Ada' },
            created: '2026-09-16T10:00:00.000Z',
            body: document('What about the second case?'),
          },
          {
            id: '3',
            created: '2026-09-17T10:00:00.000Z',
            body: document('And one more thing.'),
          },
        ],
      }),
    );

    const comments = await source.commentsSince(
      PREPARED,
      '2026-09-15T12:00:00.000Z',
      new AbortController().signal,
    );

    // What was said after the previous attempt is the attempt's context: the
    // comment at or before the moment it already saw is not repeated.
    expect(comments.map((comment) => comment.text)).toEqual([
      'What about the second case?',
      'And one more thing.',
    ]);
    expect(comments[0]?.author).toBe('Ada');
    expect(comments[1]?.author).toBe('unknown');
    expect(comments[0]?.createdAt).toBe('2026-09-16T10:00:00.000Z');
    expect(service.requests[0]?.url).toContain('/rest/api/3/issue/10011/comment');
  }, 45_000);
});

/** One issue a recovery case lists, with the status and pointers it is given. */
function queueIssue(
  id: string,
  status: string,
  pointers: readonly string[] = [],
): Record<string, unknown> {
  return {
    id,
    key: `SAM1-${id}`,
    fields: {
      summary: `Task ${id}`,
      status: { name: status },
      labels: ['harness-task', ...pointers],
      project: { key: 'SAM1' },
      issuetype: { name: 'Task' },
      updated: '2026-09-20T00:00:00Z',
    },
  };
}

/** The status name one listed issue carries. */
function statusOf(entry: Record<string, unknown>): string | undefined {
  const fields = entry['fields'] as Record<string, unknown>;
  const status = fields['status'] as Record<string, unknown>;
  return status['name'] as string | undefined;
}

/**
 * A service that lists the queue by the status the JQL asks for and re-reads
 * every issue from `fresh`, so a case can show that ownership is decided from
 * the authoritative read rather than from what the search listed.
 */
function recoveryAnswer(
  listed: readonly Record<string, unknown>[],
  fresh: readonly Record<string, unknown>[] = listed,
): (request: ReceivedRequest) => ServiceAnswer {
  return (request) => {
    if (request.url.endsWith('/rest/api/3/search/jql')) {
      const status = /AND status = "([^"]+)"/.exec(String(sent(request)['jql']))?.[1];
      return json({ issues: listed.filter((entry) => statusOf(entry) === status), isLast: true });
    }
    const id = request.url.split('/').at(-1)?.split('?')[0];
    const found = fresh.find((entry) => entry['id'] === id);
    return found === undefined ? { status: 404, body: '{"error":"no issue"}' } : json(found);
  };
}

describe('the authoritative queue recovery', () => {
  it('resumes In Review ahead of an unrelated ready ticket and a retained repair', async () => {
    const { client } = await connectClient(
      recoveryAnswer([
        queueIssue('1', 'To Do'),
        queueIssue('2', 'In Review'),
        queueIssue('3', 'To Do', [workspacePointerLabel('work')]),
      ]),
    );

    const recovered = await discoverQueueWork(CONFIG, client, new AbortController().signal);

    expect(recovered).toMatchObject({ phase: 'review', ticket: { ref: { id: '2' } } });
  }, 45_000);

  it('refuses an issue that is still In Progress instead of claiming unrelated work', async () => {
    const { client } = await connectClient(
      recoveryAnswer([queueIssue('1', 'To Do'), queueIssue('2', 'In Progress')]),
    );

    const error = await failureOf(() =>
      discoverQueueWork(CONFIG, client, new AbortController().signal),
    );

    expect(error.kind).toBe('fatal');
    expect(error.message).toContain('still In Progress');
    expect(error.message).toContain('No unrelated ticket was claimed');
  }, 45_000);

  it('refuses ambiguous active ownership', async () => {
    const { client } = await connectClient(
      recoveryAnswer([queueIssue('1', 'In Review'), queueIssue('2', 'In Review')]),
    );

    const error = await failureOf(() =>
      discoverQueueWork(CONFIG, client, new AbortController().signal),
    );

    expect(error.message).toContain('Multiple In Review tickets');
  }, 45_000);

  it('uses a fresh read to recognize Done, and never reruns it', async () => {
    const { client } = await connectClient(
      recoveryAnswer([queueIssue('1', 'In Review')], [queueIssue('1', 'Done')]),
    );

    expect(await discoverQueueWork(CONFIG, client, new AbortController().signal)).toBeNull();
  }, 45_000);

  it('uses a fresh read to resume a To Do repair through its workspace pointer', async () => {
    const { client } = await connectClient(
      recoveryAnswer(
        [queueIssue('1', 'In Review')],
        [queueIssue('1', 'To Do', [workspacePointerLabel('work')])],
      ),
    );

    const recovered = await discoverQueueWork(CONFIG, client, new AbortController().signal);

    expect(recovered).toMatchObject({ phase: 'repair', ticket: { ref: { id: '1' } } });
  }, 45_000);

  it('keeps native order among retained repairs, and prefers none of them', async () => {
    const { client } = await connectClient(
      recoveryAnswer([
        queueIssue('1', 'To Do'),
        queueIssue('3', 'To Do', [workspacePointerLabel('work-3')]),
        queueIssue('2', 'To Do', [workspacePointerLabel('work-2')]),
      ]),
    );

    const recovered = await discoverQueueWork(CONFIG, client, new AbortController().signal);

    expect(recovered).toMatchObject({ phase: 'repair', ticket: { ref: { id: '3' } } });
  }, 45_000);

  it('refuses a missing authoritative read instead of claiming unrelated work', async () => {
    const { client } = await connectClient(recoveryAnswer([queueIssue('1', 'In Progress')], []));

    const error = await failureOf(() =>
      discoverQueueWork(CONFIG, client, new AbortController().signal),
    );

    expect(error.message).toContain('cannot read queue ownership');
  }, 45_000);

  it('does not resume an issue relabelled out of the configured queue', async () => {
    const changed = queueIssue('1', 'In Review');
    (changed['fields'] as Record<string, unknown>)['labels'] = [];
    const { client } = await connectClient(
      recoveryAnswer([queueIssue('1', 'In Review')], [changed]),
    );

    expect(await discoverQueueWork(CONFIG, client, new AbortController().signal)).toBeNull();
  }, 45_000);
});
