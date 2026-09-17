/**
 * The Jira connector, through a fake HTTP boundary and nothing else.
 *
 * Every request in this file is answered by a `fetch` the test wrote, so the
 * suite needs no Jira site, no credential, and no network, and it can show
 * exactly what the connector sends: the gateway route, the Bearer header, the
 * queue JQL, the transition it selects, and the comment body. The responses are
 * shaped like Jira REST API v3 answers, not like a converted Markdown view of
 * one, because the connector parses Atlassian Document Format itself.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { loadHarnessConfig } from '../src/config.js';
import {
  JIRA_REQUEST_TIMEOUT_MS,
  createJiraSource,
  jiraApiBaseUrl,
  queueJql,
  resolveJiraToken,
} from '../src/jira.js';
import { SourceError, SourceFeedbackError } from '../src/source.js';
import type { SourceCandidate, SourceRunOutcome, SourceTask, TaskSource } from '../src/source.js';
import type { JiraSourceConfig } from '../src/types.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedConfig,
  writeJsonFile,
} from './support.js';

afterEach(cleanupTempDirectories);

const CLOUD_ID = '9337c4da-7d33-4c1d-b03c-db207e537f88';
const SITE = 'https://example.atlassian.net';
const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;
const TOKEN = 'service-account-token-value';

/** A validated source configuration, as the loader would produce it. */
function jiraConfig(overrides: Partial<JiraSourceConfig> = {}): JiraSourceConfig {
  return {
    type: 'jira',
    siteUrl: SITE,
    cloudId: CLOUD_ID,
    projectKey: 'SAM1',
    issueType: 'Task',
    label: 'harness-task',
    readyStatus: 'To Do',
    runningStatus: 'In Progress',
    reviewStatus: 'In Review',
    pollIntervalSeconds: 30,
    tokenEnv: 'JIRA_API_TOKEN',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A fake HTTP boundary
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
}

interface FakeHttp {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
}

function headerValue(headers: RequestInit['headers'], name: string): string | null {
  if (headers === undefined || headers === null || Array.isArray(headers)) {
    return null;
  }
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}

function fakeHttp(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
): FakeHttp {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call: FetchCall = {
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(
        (headerValue(init.headers, 'authorization') === null
          ? []
          : [['authorization', headerValue(init.headers, 'authorization') ?? '']]
        )
          .concat(
            headerValue(init.headers, 'accept') === null
              ? []
              : [['accept', headerValue(init.headers, 'accept') ?? '']],
          )
          .concat(
            headerValue(init.headers, 'accept-language') === null
              ? []
              : [['accept-language', headerValue(init.headers, 'accept-language') ?? '']],
          ),
      ),
      body,
      signal: init.signal,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** One issue as the API returns it, with only the fields the connector reads. */
function issue(
  overrides: {
    id?: string;
    key?: string;
    summary?: string;
    description?: unknown;
    status?: string;
    labels?: string[];
    projectKey?: string;
    issueType?: string;
    updated?: string;
  } = {},
): Record<string, unknown> {
  const description =
    'description' in overrides ? overrides.description : descriptionFor('one criterion');
  const summary = 'summary' in overrides ? overrides.summary : 'Create the smoke-test marker';
  return {
    id: overrides.id ?? '10011',
    key: overrides.key ?? 'SAM1-11',
    fields: {
      summary,
      description,
      status: { name: overrides.status ?? 'To Do' },
      labels: overrides.labels ?? ['harness-task'],
      project: { key: overrides.projectKey ?? 'SAM1' },
      issuetype: { name: overrides.issueType ?? 'Task' },
      updated: overrides.updated ?? '2026-09-16T11:00:00.000Z',
    },
  };
}

// ---------------------------------------------------------------------------
// The description convention, as test data
// ---------------------------------------------------------------------------

function text(value: string, marks?: unknown[]): Record<string, unknown> {
  return marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
}

function paragraph(...content: unknown[]): Record<string, unknown> {
  return { type: 'paragraph', content };
}

function heading(level: number, value: string): Record<string, unknown> {
  return { type: 'heading', attrs: { level }, content: [text(value)] };
}

function listItem(...content: unknown[]): Record<string, unknown> {
  return { type: 'listItem', content };
}

function bulletList(...items: unknown[]): Record<string, unknown> {
  return { type: 'bulletList', content: items };
}

function document(...content: unknown[]): Record<string, unknown> {
  return { type: 'doc', version: 1, content };
}

/** The documented description convention, with the criteria the test asks for. */
function descriptionFor(...criteria: string[]): Record<string, unknown> {
  return document(
    heading(2, 'Goal'),
    paragraph(text('Do the thing the issue asks for.')),
    heading(2, 'Acceptance criteria'),
    bulletList(...criteria.map((criterion) => listItem(paragraph(text(criterion))))),
    heading(2, 'Verification'),
    paragraph(text('Inspect the diff by hand.')),
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

async function loadSource(raw: Record<string, unknown>): Promise<JiraSourceConfig> {
  const directory = await createTempDir();
  const file = await writeJsonFile(directory, 'harness.config.json', {
    ...documentedConfig,
    source: raw,
  });
  const config = await loadHarnessConfig(file);
  if (config.source === undefined) {
    throw new Error('the configuration loaded without a source');
  }
  return config.source;
}

const minimalSource = {
  type: 'jira',
  siteUrl: SITE,
  cloudId: CLOUD_ID,
  projectKey: 'SAM1',
};

describe('the Jira source configuration', () => {
  it('applies the documented defaults and normalizes the site URL', async () => {
    const source = await loadSource({ ...minimalSource, siteUrl: `${SITE}/` });

    expect(source).toEqual({
      type: 'jira',
      siteUrl: SITE,
      cloudId: CLOUD_ID,
      projectKey: 'SAM1',
      issueType: 'Task',
      label: 'harness-task',
      readyStatus: 'To Do',
      runningStatus: 'In Progress',
      reviewStatus: 'In Review',
      pollIntervalSeconds: 30,
      tokenEnv: 'JIRA_API_TOKEN',
    });
  });

  it('does not give a configuration that names no source one', async () => {
    const directory = await createTempDir();
    const file = await writeJsonFile(directory, 'harness.config.json', documentedConfig);
    const config = await loadHarnessConfig(file);

    expect(config.source).toBeUndefined();
    expect('source' in config).toBe(false);
  });

  const rejections: Array<[name: string, raw: unknown, problem: RegExp]> = [
    ['a source with no type', { ...minimalSource, type: undefined }, /type/],
    ['an unsupported source type', { ...minimalSource, type: 'github' }, /must be "jira"/],
    ['a source that is null', null, /source/],
    ['an unknown source field', { ...minimalSource, queue: 'SAM1' }, /queue/],
    ['a missing siteUrl', { type: 'jira', cloudId: CLOUD_ID, projectKey: 'SAM1' }, /siteUrl/],
    [
      'a plain-HTTP siteUrl',
      { ...minimalSource, siteUrl: 'http://example.atlassian.net' },
      /https/,
    ],
    ['a siteUrl with a path', { ...minimalSource, siteUrl: `${SITE}/jira` }, /no path/],
    ['a siteUrl with a query', { ...minimalSource, siteUrl: `${SITE}/?x=1` }, /query/],
    [
      'a siteUrl with credentials',
      { ...minimalSource, siteUrl: 'https://user:pw@example.atlassian.net' },
      /credentials/,
    ],
    ['a missing cloudId', { type: 'jira', siteUrl: SITE, projectKey: 'SAM1' }, /cloudId/],
    ['a cloudId that is not a UUID', { ...minimalSource, cloudId: 'example' }, /cloudId/],
    ['a missing projectKey', { type: 'jira', siteUrl: SITE, cloudId: CLOUD_ID }, /projectKey/],
    ['a blank issueType', { ...minimalSource, issueType: '   ' }, /issueType/],
    ['a label with whitespace', { ...minimalSource, label: 'two words' }, /label/],
    ['a blank readyStatus', { ...minimalSource, readyStatus: '' }, /readyStatus/],
    ['two statuses the same', { ...minimalSource, reviewStatus: 'To Do' }, /distinct/],
    [
      'a poll interval below the minimum',
      { ...minimalSource, pollIntervalSeconds: 4 },
      /pollIntervalSeconds/,
    ],
    ['a fractional poll interval', { ...minimalSource, pollIntervalSeconds: 30.5 }, /integer/],
    [
      'a tokenEnv that is not an environment name',
      { ...minimalSource, tokenEnv: 'jira-token' },
      /tokenEnv/,
    ],
    ['a token in the configuration', { ...minimalSource, token: 'secret' }, /token/],
  ];

  for (const [name, raw, problem] of rejections) {
    it(`rejects ${name}`, async () => {
      await expect(loadSource(raw as Record<string, unknown>)).rejects.toThrow(problem);
    });
  }
});

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

describe('the service-account token', () => {
  it('is read only from the configured environment variable', () => {
    expect(resolveJiraToken(jiraConfig(), { JIRA_API_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
    expect(resolveJiraToken(jiraConfig({ tokenEnv: 'OTHER_TOKEN' }), { OTHER_TOKEN: TOKEN })).toBe(
      TOKEN,
    );
  });

  it('refuses a missing variable, naming it and never a value', () => {
    let thrown: unknown;
    try {
      resolveJiraToken(jiraConfig({ tokenEnv: 'MISSING_JIRA_TOKEN' }), {});
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(SourceError);
    const error = thrown as SourceError;
    expect(error.kind).toBe('fatal');
    expect(error.message).toContain('MISSING_JIRA_TOKEN');
    expect(error.message).not.toContain(TOKEN);
  });

  it('refuses a blank variable the same way', () => {
    expect(() => resolveJiraToken(jiraConfig(), { JIRA_API_TOKEN: '   ' })).toThrow(
      /JIRA_API_TOKEN is missing or blank/,
    );
  });
});

// ---------------------------------------------------------------------------
// Routing, search, and eligibility
// ---------------------------------------------------------------------------

describe('the gateway route and the queue', () => {
  it('builds every API URL from the cloud ID, never from the site host', () => {
    expect(jiraApiBaseUrl(jiraConfig())).toBe(GATEWAY);
    expect(jiraApiBaseUrl(jiraConfig())).not.toContain('example.atlassian.net');
  });

  it('quotes and escapes the configured JQL terms', () => {
    const jql = queueJql(jiraConfig({ projectKey: 'SAM"1', label: "harness' OR x" }));

    expect(jql).toBe(
      'project = "SAM\\"1" AND issuetype = "Task" AND labels = "harness\' OR x" AND ' +
        'status = "To Do" ORDER BY created ASC, key ASC',
    );
  });

  it('lists eligible issues with a Bearer token and the documented search call', async () => {
    const http = fakeHttp(() =>
      json({ issues: [issue(), issue({ id: '10012', key: 'SAM1-12' })], isLast: true }),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    const candidates = await source.listEligible(new AbortController().signal);

    expect(candidates.map((candidate) => candidate.ref.key)).toEqual(['SAM1-11', 'SAM1-12']);
    expect(candidates[0]?.ref).toEqual({
      type: 'jira',
      scope: SITE,
      id: '10011',
      key: 'SAM1-11',
      url: `${SITE}/browse/SAM1-11`,
      updatedAt: '2026-09-16T11:00:00.000Z',
    });

    const [call] = http.calls;
    expect(http.calls).toHaveLength(1);
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`${GATEWAY}/rest/api/3/search/jql`);
    expect(call?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(call?.body).toEqual({
      jql: queueJql(jiraConfig()),
      maxResults: 100,
      fields: ['summary', 'status', 'updated', 'labels', 'project', 'issuetype'],
    });
  });

  it('asks Jira for one language in every request, reads and writes alike', async () => {
    // Live evidence, 2026-09-17: on a site whose default language is not English
    // the queue matched an issue by its canonical names (`To Do`, `Task`) and the
    // connector then refused it as stale, because the answer carried the site's
    // own names (`待办`, `任务`). The language was never chosen here: JavaScript's
    // `fetch` sends `accept-language: *`, which resolves to the site's default. So
    // the connector asks explicitly, and this pins that it keeps doing so.
    let moves = 0;
    const http = fakeHttp((call) => {
      if (call.url.includes('/search/jql')) {
        return json({ issues: [issue()], isLast: true });
      }
      if (call.url.includes('/transitions') && call.method === 'GET') {
        return json(moves === 0 ? TRANSITIONS_TO_PROGRESS : TRANSITIONS_TO_REVIEW);
      }
      if (call.url.includes('/transitions')) {
        moves += 1;
        return new Response(null, { status: 204 });
      }
      if (call.url.includes('/comment')) {
        return json({ id: '50001' }, 201);
      }
      return json(issue({ status: moves === 0 ? 'To Do' : 'In Progress' }));
    });
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const stop = new AbortController().signal;

    const [candidate] = await source.listEligible(stop);
    if (candidate === undefined) {
      throw new Error('the fixture queue was empty, and this test needs one issue');
    }
    const prepared = await preparedFor(source, candidate);
    await expect(source.claim(prepared, stop)).resolves.toBe(true);
    await source.complete(prepared, outcome(), stop);

    // The whole cycle really ran: a search, an issue read, a transition, a
    // comment, and the two transitions the connector uses to claim and to finish.
    expect(http.calls.filter((call) => call.method === 'POST').length).toBeGreaterThanOrEqual(3);
    expect(http.calls.every((call) => call.method === 'GET')).toBe(false);
    expect(http.calls.map((call) => call.headers['accept-language'])).toEqual(
      http.calls.map(() => 'en'),
    );
  });

  it('consumes every page and de-duplicates immutable IDs', async () => {
    const pages = [
      {
        issues: [issue(), issue({ id: '10012', key: 'SAM1-12' })],
        isLast: false,
        nextPageToken: 'page-2',
      },
      {
        issues: [issue({ id: '10012', key: 'SAM1-12' }), issue({ id: '10013', key: 'SAM1-13' })],
        isLast: true,
      },
    ];
    const http = fakeHttp((_call, index) => json(pages[index] ?? { issues: [], isLast: true }));
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    const candidates = await source.listEligible(new AbortController().signal);

    expect(candidates.map((candidate) => candidate.ref.id)).toEqual(['10011', '10012', '10013']);
    expect(
      http.calls.map((call) => (call.body as { nextPageToken?: string }).nextPageToken),
    ).toEqual([undefined, 'page-2']);
    expect(http.calls.every((call) => call.method === 'POST')).toBe(true);
  });

  it('returns an empty batch for an empty queue', async () => {
    const http = fakeHttp(() => json({ issues: [], isLast: true }));
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    await expect(source.listEligible(new AbortController().signal)).resolves.toEqual([]);
  });

  it('refuses a nonfinal page with no continuation token', async () => {
    const http = fakeHttp(() => json({ issues: [issue()], isLast: false }));
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    await expect(source.listEligible(new AbortController().signal)).rejects.toThrow(
      /continuation token/,
    );
  });

  it('refuses a repeated continuation token rather than following it forever', async () => {
    const http = fakeHttp(() =>
      json({ issues: [issue()], isLast: false, nextPageToken: 'same-token' }),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    await expect(source.listEligible(new AbortController().signal)).rejects.toThrow(
      /repeated a continuation token/,
    );
    expect(http.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe('mapping an issue onto the existing four-field Task', () => {
  async function prepare(
    raw: Record<string, unknown>,
    config: JiraSourceConfig = jiraConfig(),
  ): Promise<SourceTask | null> {
    const http = fakeHttp(() => json(raw));
    const source = createJiraSource(config, TOKEN, { fetch: http.fetch });
    const candidate: SourceCandidate = {
      ref: {
        type: 'jira',
        scope: SITE,
        id: String(raw['id']),
        key: String(raw['key']),
        url: `${SITE}/browse/${String(raw['key'])}`,
        updatedAt: '2026-09-16T11:00:00.000Z',
      },
      pointers: [],
      title: 'Create the smoke-test marker',
    };
    return source.prepare(candidate, new AbortController().signal);
  }

  it('maps key, summary, description, and criteria', async () => {
    const description = document(
      heading(2, 'Goal'),
      paragraph(text('Create '), text('HARNESS_SMOKE_TEST.md', [{ type: 'code' }]), text('.')),
      heading(2, 'Acceptance criteria'),
      bulletList(
        listItem(paragraph(text('The file exists.'))),
        listItem(
          paragraph(text('Its bytes are exactly:')),
          bulletList(listItem(paragraph(text('the required text'), text(' plus one LF')))),
        ),
      ),
      heading(2, 'Verification'),
      paragraph(text('Inspect the diff.')),
    );

    const prepared = await prepare(issue({ description }));

    expect(prepared?.ref.id).toBe('10011');
    expect(prepared?.task).toEqual({
      id: 'SAM1-11',
      title: 'Create the smoke-test marker',
      description: [
        '## Goal',
        'Create `HARNESS_SMOKE_TEST.md`.',
        '## Acceptance criteria',
        '- The file exists.',
        '- Its bytes are exactly:',
        '  - the required text plus one LF',
        '## Verification',
        'Inspect the diff.',
      ].join('\n'),
      acceptanceCriteria: [
        'The file exists.',
        'Its bytes are exactly: the required text plus one LF',
      ],
    });
  });

  it('renders line breaks, ordered lists, code, and link destinations', async () => {
    const description = document(
      heading(2, 'Goal'),
      paragraph(
        text('See '),
        text('the guide', [{ type: 'link', attrs: { href: 'https://example.test/guide' } }]),
        { type: 'hardBreak' },
        text('and mind the '),
        text('emphasis', [{ type: 'em' }, { type: 'strong' }]),
      ),
      heading(3, 'Steps'),
      {
        type: 'orderedList',
        content: [listItem(paragraph(text('first'))), listItem(paragraph(text('second')))],
      },
      { type: 'codeBlock', content: [text('npm ci\nnpm test')] },
      heading(2, 'Acceptance criteria'),
      bulletList(listItem(paragraph(text('It works.')))),
    );

    const prepared = await prepare(issue({ description }));

    expect(prepared?.task.description).toBe(
      [
        '## Goal',
        'See [the guide](https://example.test/guide)',
        'and mind the ***emphasis***',
        '### Steps',
        '1. first',
        '2. second',
        '```',
        'npm ci',
        'npm test',
        '```',
        '## Acceptance criteria',
        '- It works.',
      ].join('\n'),
    );
  });

  it('finds the criteria heading by structure, not by flattened text', async () => {
    const description = document(
      heading(2, 'Goal'),
      {
        type: 'codeBlock',
        content: [text('## Acceptance criteria\n- not a real criterion')],
      },
      heading(2, 'Acceptance criteria'),
      bulletList(listItem(paragraph(text('A real criterion.')))),
    );

    const prepared = await prepare(issue({ description }));

    expect(prepared?.task.acceptanceCriteria).toEqual(['A real criterion.']);
    expect(prepared?.task.description).toContain('- not a real criterion');
  });

  it('accepts a trailing colon and different letter case in the heading', async () => {
    const description = document(
      heading(2, 'ACCEPTANCE CRITERIA:'),
      bulletList(listItem(paragraph(text('One.')))),
    );

    const prepared = await prepare(issue({ description }));

    expect(prepared?.task.acceptanceCriteria).toEqual(['One.']);
  });

  it('keeps a deeper subsection in the section and ends at the next same-level heading', async () => {
    const description = document(
      heading(2, 'Acceptance criteria'),
      bulletList(listItem(paragraph(text('One.')))),
      heading(3, 'Notes'),
      bulletList(listItem(paragraph(text('A deeper note.')))),
      heading(2, 'Constraints'),
      bulletList(listItem(paragraph(text('Out of the section.')))),
    );

    const prepared = await prepare(issue({ description }));

    // The section ends at the next heading of the same or higher level, so a
    // deeper subsection is part of it and its items are criteria too; the
    // same-level "Constraints" heading ends it.
    expect(prepared?.task.acceptanceCriteria).toEqual(['One.', 'A deeper note.']);
  });

  const invalid: Array<[name: string, raw: Record<string, unknown>, problem: RegExp]> = [
    ['a null description', issue({ description: null }), /no description/],
    [
      'a description that is not a document',
      issue({ description: 'Do the thing' }),
      /Atlassian document/,
    ],
    ['a blank summary', issue({ summary: '   ' }), /summary is blank/],
    [
      'no criteria heading',
      issue({ description: document(heading(2, 'Goal'), paragraph(text('Do it.'))) }),
      /no "Acceptance criteria" heading/,
    ],
    [
      'two criteria headings',
      issue({
        description: document(
          heading(2, 'Acceptance criteria'),
          bulletList(listItem(paragraph(text('One.')))),
          heading(2, 'Acceptance Criteria'),
          bulletList(listItem(paragraph(text('Two.')))),
        ),
      }),
      /ambiguous/,
    ],
    [
      'a criteria section with no list',
      issue({
        description: document(
          heading(2, 'Acceptance criteria'),
          paragraph(text('It should work.')),
        ),
      }),
      /holds no bullet or ordered list/,
    ],
    [
      'an empty criterion',
      issue({
        description: document(
          heading(2, 'Acceptance criteria'),
          bulletList(listItem(paragraph(text('   ')))),
        ),
      }),
      /empty list item/,
    ],
    [
      'an unsupported node',
      issue({
        description: document(
          heading(2, 'Acceptance criteria'),
          bulletList(listItem(paragraph(text('One.')))),
          { type: 'panel', content: [paragraph(text('A warning that could hide a requirement.'))] },
        ),
      }),
      /unsupported|not a node this harness reads/,
    ],
    [
      'an unsupported mark',
      issue({
        description: document(
          heading(2, 'Acceptance criteria'),
          bulletList(listItem(paragraph(text('One.', [{ type: 'strike' }])))),
        ),
      }),
      /unsupported mark/,
    ],
    [
      'a heading with no level',
      issue({
        description: document(
          { type: 'heading', content: [text('Acceptance criteria')] },
          bulletList(listItem(paragraph(text('One.')))),
        ),
      }),
      /heading level/,
    ],
    [
      'a mark link with no destination',
      issue({
        description: document(
          heading(2, 'Acceptance criteria'),
          bulletList(listItem(paragraph(text('One.', [{ type: 'link', attrs: {} }])))),
        ),
      }),
      /no destination/,
    ],
  ];

  for (const [name, raw, problem] of invalid) {
    it(`refuses ${name} as an input error`, async () => {
      let thrown: unknown;
      try {
        await prepare(raw);
      } catch (cause) {
        thrown = cause;
      }

      expect(thrown).toBeInstanceOf(SourceError);
      expect((thrown as SourceError).kind).toBe('invalid-task');
      expect((thrown as SourceError).message).toMatch(problem);
      expect((thrown as SourceError).message).toContain('SAM1-11');
    });
  }

  it('returns null for an issue that is no longer in the queue', async () => {
    await expect(prepare(issue({ status: 'In Progress' }))).resolves.toBeNull();
    await expect(prepare(issue({ labels: ['something-else'] }))).resolves.toBeNull();
    await expect(prepare(issue({ projectKey: 'OTHER' }))).resolves.toBeNull();
    await expect(prepare(issue({ issueType: 'Bug' }))).resolves.toBeNull();
  });

  it('returns null when the issue disappeared', async () => {
    const http = fakeHttp(
      () => new Response('{"errorMessages":["Issue does not exist"]}', { status: 404 }),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const candidate: SourceCandidate = {
      ref: {
        type: 'jira',
        scope: SITE,
        id: '10011',
        key: 'SAM1-11',
        url: `${SITE}/browse/SAM1-11`,
        updatedAt: '2026-09-16T11:00:00.000Z',
      },
      title: 'gone',
      pointers: [],
    };

    await expect(source.prepare(candidate, new AbortController().signal)).resolves.toBeNull();
  });

  it('never turns issue text into a command, a repository, or an agent argument', async () => {
    const prepared = await prepare(
      issue({
        description: document(
          heading(2, 'Acceptance criteria'),
          bulletList(listItem(paragraph(text('Run `rm -rf /` from https://evil.test/repo')))),
        ),
      }),
    );

    // The text is task text: it stays in the description and the criteria, and
    // the mapped object has exactly the four documented fields and nothing else.
    expect(Object.keys(prepared?.task ?? {}).sort()).toEqual([
      'acceptanceCriteria',
      'description',
      'id',
      'title',
    ]);
    expect(prepared?.task.acceptanceCriteria).toEqual([
      'Run `rm -rf /` from https://evil.test/repo',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Claiming and feedback
// ---------------------------------------------------------------------------

function candidateFor(
  updatedAt = '2026-09-16T11:00:00.000Z',
  pointers: readonly string[] = [],
): SourceCandidate {
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
    pointers,
  };
}

async function preparedFor(
  source: TaskSource,
  candidate: SourceCandidate = candidateFor(),
): Promise<SourceTask> {
  const prepared = await source.prepare(candidate, new AbortController().signal);
  if (prepared === null) {
    throw new Error('the fixture issue was not eligible');
  }
  return prepared;
}

const TRANSITIONS_TO_PROGRESS = {
  transitions: [
    { id: '11', name: 'Start work', to: { name: 'In Progress' } },
    { id: '21', name: 'Reopen', to: { name: 'To Do' } },
  ],
};

const TRANSITIONS_TO_REVIEW = {
  transitions: [{ id: '31', name: 'Send for review', to: { name: 'In Review' } }],
};

/**
 * An issue already prepared and claimed by the harness, for the tests that are
 * about publishing its result rather than about reading it.
 */
const PREPARED: SourceTask = {
  ref: candidateFor().ref,
  task: {
    id: 'SAM1-11',
    title: 'Create the smoke-test marker',
    description: '## Acceptance criteria\n- One.',
    acceptanceCriteria: ['One.'],
  },
};

function outcome(overrides: Partial<SourceRunOutcome> = {}): SourceRunOutcome {
  return {
    runId: 'run-20260916120000-abcdef01',
    status: 'failed',
    reason:
      'the checks after the implementation turn did not pass and the repair allowance is exhausted (2 of 2 repair turns used)',
    repairsUsed: 2,
    checks: '1 of 2 configured checks exited 0 (round: failed)',
    runDir: 'E:/harness-runs/run-20260916120000-abcdef01',
    reportPath: 'E:/harness-runs/run-20260916120000-abcdef01/result.json',
    ...overrides,
  };
}

describe('claiming an issue', () => {
  it('selects the transition by target status, not by transition name', async () => {
    const http = fakeHttp((call) =>
      call.url.includes('/transitions') ? json(TRANSITIONS_TO_PROGRESS) : json(issue()),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const prepared = await preparedFor(source, candidateFor());

    await expect(source.claim(prepared, new AbortController().signal)).resolves.toBe(true);

    const write = http.calls.at(-1);
    expect(write?.method).toBe('POST');
    expect(write?.url).toBe(`${GATEWAY}/rest/api/3/issue/10011/transitions`);
    expect(write?.body).toEqual({ transition: { id: '11' } });
  });

  it('sends no mutation when the issue changed revision first', async () => {
    // The first read is prepare's, which captures the revision it saw; the
    // issue is edited after that, so the claim's recheck no longer matches.
    const http = fakeHttp((_call, index) =>
      json(
        issue({ updated: index === 0 ? '2026-09-16T11:00:00.000Z' : '2026-09-16T11:30:00.000Z' }),
      ),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const prepared = await preparedFor(source, candidateFor());

    await expect(source.claim(prepared, new AbortController().signal)).resolves.toBe(false);
    expect(http.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('sends no mutation when the issue left the queue', async () => {
    const http = fakeHttp((_call, index) =>
      json(issue({ status: index === 0 ? 'To Do' : 'In Review' })),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const prepared = await preparedFor(source, candidateFor());

    await expect(source.claim(prepared, new AbortController().signal)).resolves.toBe(false);
    expect(http.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('reports a workflow with no transition to the running status', async () => {
    const http = fakeHttp((call) =>
      call.url.includes('/transitions')
        ? json({ transitions: [{ id: '21', name: 'Reopen', to: { name: 'To Do' } }] })
        : json(issue()),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const prepared = await preparedFor(source, candidateFor());

    await expect(source.claim(prepared, new AbortController().signal)).rejects.toThrow(
      /no transition to the status "In Progress"/,
    );
  });

  it('refuses an ambiguous transition to the running status', async () => {
    const http = fakeHttp((call) =>
      call.url.includes('/transitions')
        ? json({
            transitions: [
              { id: '11', name: 'Start work', to: { name: 'In Progress' } },
              { id: '12', name: 'Resume', to: { name: 'In Progress' } },
            ],
          })
        : json(issue()),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const prepared = await preparedFor(source, candidateFor());

    await expect(source.claim(prepared, new AbortController().signal)).rejects.toThrow(/ambiguous/);
  });

  it('refuses a transition that needs fields the harness cannot supply', async () => {
    const http = fakeHttp((call) =>
      call.url.includes('/transitions')
        ? json({
            transitions: [
              {
                id: '11',
                name: 'Start work',
                to: { name: 'In Progress' },
                fields: { assignee: { required: true } },
              },
            ],
          })
        : json(issue()),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const prepared = await preparedFor(source, candidateFor());

    await expect(source.claim(prepared, new AbortController().signal)).rejects.toThrow(
      /requires fields/,
    );
  });

  it('treats a failed write as uncertain rather than sending it again', async () => {
    const http = fakeHttp((call) =>
      call.method === 'POST'
        ? json({ errorMessages: ['oh no'] }, 500)
        : call.url.includes('/transitions')
          ? json(TRANSITIONS_TO_PROGRESS)
          : json(issue()),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const prepared = await preparedFor(source, candidateFor());

    let thrown: unknown;
    try {
      await source.claim(prepared, new AbortController().signal);
    } catch (cause) {
      thrown = cause;
    }
    expect((thrown as SourceError).kind).toBe('uncertain-write');
    expect(http.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

describe('a workspace pointer and a refusal', () => {
  it('reads the pointer labels an issue carries, and nothing else', async () => {
    const http = fakeHttp(() =>
      json({
        issues: [
          issue({
            labels: ['harness-task', 'harness-ws-run-a', 'harness-test', 'harness-ws-run-b'],
          }),
        ],
        isLast: true,
      }),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    const candidates = await source.listEligible(new AbortController().signal);

    expect(candidates[0]?.pointers).toEqual(['run-a', 'run-b']);
  });

  it('records a workspace by adding its pointer label to the issue', async () => {
    const http = fakeHttp((call) =>
      call.method === 'PUT' ? new Response(null, { status: 204 }) : json(issue()),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const prepared = await preparedFor(source, candidateFor());
    const workspaceId = 'run-20260916100000-aaaaaaaa';

    await source.recordWorkspace(prepared, workspaceId, new AbortController().signal);

    const write = http.calls.at(-1);
    expect(write?.method).toBe('PUT');
    expect(write?.url).toBe(`${GATEWAY}/rest/api/3/issue/10011`);
    expect(write?.body).toEqual({
      update: { labels: [{ add: `harness-ws-${workspaceId}` }] },
    });
  });

  it('publishes why it refused, and takes the issue out of the queue', async () => {
    const http = fakeHttp((call) => {
      if (call.url.includes('/comment')) {
        return json({ id: '50001' }, 201);
      }
      if (call.url.includes('/transitions') && call.method === 'GET') {
        return json(TRANSITIONS_TO_REVIEW);
      }
      return json(issue());
    });
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const prepared = await preparedFor(source, candidateFor());

    await source.refuse(
      prepared,
      'it names two workspaces, and which one to continue cannot be guessed',
      new AbortController().signal,
    );

    const comment = http.calls.find((call) => call.url.includes('/comment'));
    expect(JSON.stringify(comment?.body)).toContain('it did not run');
    expect(JSON.stringify(comment?.body)).toContain('names two workspaces');
    const write = http.calls.at(-1);
    expect(write?.method).toBe('POST');
    expect(write?.url).toBe(`${GATEWAY}/rest/api/3/issue/10011/transitions`);
    expect(write?.body).toEqual({ transition: { id: '31' } });
  });
});

describe('publishing the result', () => {
  it('posts a compact ADF comment and moves the issue to review', async () => {
    const http = fakeHttp((call) => {
      if (call.url.includes('/comment')) {
        return json({ id: '9001' });
      }
      if (call.url.includes('/transitions')) {
        return json(TRANSITIONS_TO_REVIEW);
      }
      return json(issue({ status: 'In Progress', description: descriptionFor('One.') }));
    });
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    await source.complete(PREPARED, outcome(), new AbortController().signal);

    const comment = http.calls.find((call) => call.url.includes('/comment'));
    expect(comment?.method).toBe('POST');
    expect(comment?.url).toBe(`${GATEWAY}/rest/api/3/issue/10011/comment`);
    const body = comment?.body as {
      body: {
        type: string;
        version: number;
        content: Array<{ content?: Array<{ text: string }> }>;
      };
    };
    expect(body.body.type).toBe('doc');
    expect(body.body.version).toBe(1);
    const paragraphs = body.body.content.map((node) => node.content?.[0]?.text ?? '');
    expect(paragraphs[0]).toBe(
      'Harness run run-20260916120000-abcdef01 for SAM1-11 finished: failed.',
    );
    expect(paragraphs[1]).toMatch(/^Reason: the checks after the implementation turn/);
    expect(paragraphs[2]).toBe('Checks: 1 of 2 configured checks exited 0 (round: failed)');
    expect(paragraphs[3]).toBe('Repairs used: 2');
    expect(paragraphs.join('\n')).toContain('E:/harness-runs/run-20260916120000-abcdef01');
    expect(paragraphs.join('\n')).toContain('local paths, not Jira attachments');

    const transition = http.calls.at(-1);
    expect(transition?.url).toBe(`${GATEWAY}/rest/api/3/issue/10011/transitions`);
    expect(transition?.body).toEqual({ transition: { id: '31' } });
  });

  it('never moves an issue to Done and never rewrites its description', async () => {
    const http = fakeHttp((call) => {
      if (call.url.includes('/comment')) {
        return json({ id: '9001' });
      }
      if (call.url.includes('/transitions')) {
        return json({
          transitions: [
            { id: '41', name: 'Approve', to: { name: 'Done' } },
            ...TRANSITIONS_TO_REVIEW.transitions,
          ],
        });
      }
      return json(issue({ status: 'In Progress' }));
    });
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    await source.complete(PREPARED, outcome({ status: 'passed' }), new AbortController().signal);

    // The only status change is the configured review transition. The workflow
    // also offers a transition to Done, and it is not the one that is used.
    const transitions = http.calls.filter((call) => call.url.endsWith('/transitions'));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.body).toEqual({ transition: { id: '31' } });
    // Nothing rewrote the issue's own description or any other field.
    expect(http.calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(http.calls.some((call) => call.url.includes('/field'))).toBe(false);
  });

  it('respects a status a human changed after the run', async () => {
    const http = fakeHttp((call) => {
      if (call.url.includes('/comment')) {
        return json({ id: '9001' });
      }
      return json(issue({ status: 'Blocked' }));
    });
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    await source.complete(PREPARED, outcome(), new AbortController().signal);

    expect(http.calls.filter((call) => call.url.includes('/transitions'))).toHaveLength(0);
  });

  it('reports a comment that failed before anything was acknowledged', async () => {
    const http = fakeHttp(() => json({ errorMessages: ['nope'] }, 500));
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    let thrown: unknown;
    try {
      await source.complete(PREPARED, outcome(), new AbortController().signal);
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(SourceFeedbackError);
    const error = thrown as SourceFeedbackError;
    expect(error.stage).toBe('comment');
    expect(error.commentId).toBeNull();
  });

  it('keeps the acknowledged comment ID when the later transition fails', async () => {
    const http = fakeHttp((call) => {
      if (call.url.includes('/comment')) {
        return json({ id: '9001' });
      }
      if (call.url.includes('/transitions')) {
        return json({ errorMessages: ['workflow refused'] }, 500);
      }
      return json(issue({ status: 'In Progress' }));
    });
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    let thrown: unknown;
    try {
      await source.complete(PREPARED, outcome(), new AbortController().signal);
    } catch (cause) {
      thrown = cause;
    }

    const error = thrown as SourceFeedbackError;
    expect(error.stage).toBe('transition');
    expect(error.commentId).toBe('9001');
  });
});

// ---------------------------------------------------------------------------
// Bounded network behavior and secret hygiene
// ---------------------------------------------------------------------------

describe('bounded network behavior', () => {
  async function listFailure(response: Response | (() => Promise<Response>)): Promise<SourceError> {
    const http = fakeHttp(typeof response === 'function' ? response : () => response);
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    let thrown: unknown;
    try {
      await source.listEligible(new AbortController().signal);
    } catch (cause) {
      thrown = cause;
    }
    if (!(thrown instanceof SourceError)) {
      throw new Error(`expected a SourceError, received ${String(thrown)}`);
    }
    return thrown;
  }

  it('classifies 401 and 403 as fatal, naming scopes and project access', async () => {
    const unauthorized = await listFailure(json({ errorMessages: ['unauthorized'] }, 401));
    const forbidden = await listFailure(json({ errorMessages: ['forbidden'] }, 403));

    expect(unauthorized.kind).toBe('fatal');
    expect(unauthorized.message).toMatch(/scopes|not accepted/);
    expect(forbidden.kind).toBe('fatal');
  });

  it('classifies 429 as retryable and keeps the server-directed wait', async () => {
    const limited = await listFailure(json({}, 429, { 'retry-after': '120' }));

    expect(limited.kind).toBe('retryable-read');
    expect(limited.retryAfterMs).toBe(120_000);
  });

  it('classifies a server error as retryable', async () => {
    expect((await listFailure(json({}, 503))).kind).toBe('retryable-read');
  });

  it('classifies a redirect as a failure instead of following it', async () => {
    const redirected = await listFailure(async () => {
      throw new TypeError('redirect mode is error');
    });

    expect(redirected.kind).toBe('retryable-read');
  });

  it('stops a request when the caller stops it', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const http = fakeHttp(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          seen.push(call.signal as AbortSignal);
          call.signal?.addEventListener('abort', () => reject(new Error('aborted by the caller')));
        }),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    const attempt = source.listEligible(controller.signal);
    controller.abort(new Error('interrupt'));

    let thrown: unknown;
    try {
      await attempt;
    } catch (cause) {
      thrown = cause;
    }

    expect(seen).toHaveLength(1);
    expect((thrown as SourceError).kind).toBe('fatal');
    expect((thrown as SourceError).message).toMatch(/stopped by the caller/);
  });

  it('links every request to a 30-second limit of its own', async () => {
    const http = fakeHttp(() => json({ issues: [], isLast: true }));
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });
    await source.listEligible(new AbortController().signal);

    expect(JIRA_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(http.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('never puts the token in a diagnostic, even when an answer echoes it', async () => {
    const http = fakeHttp(
      () =>
        new Response(`{"errorMessages":["bad token ${TOKEN}","Authorization: Bearer ${TOKEN}"]}`, {
          status: 400,
        }),
    );
    const source = createJiraSource(jiraConfig(), TOKEN, { fetch: http.fetch });

    let thrown: unknown;
    try {
      await source.listEligible(new AbortController().signal);
    } catch (cause) {
      thrown = cause;
    }

    const message = (thrown as SourceError).message;
    expect(message).not.toContain(TOKEN);
    expect(message).toContain('[redacted]');
  });
});
