/**
 * The review-to-completion path, offline: a real completion step, a real bounded
 * command runner, and a stand-in `gh` on disk for GitHub; the real Jira
 * completion reader, its transition discovery, and its comment writer, against a
 * fake HTTP boundary that speaks Jira REST API v3.
 *
 * Nothing here contacts GitHub or Jira, and nothing needs a credential. The
 * stand-in `gh` refuses an invocation made with the wrong credential, so the
 * separation between the reviewer's token and the operator's is a property these
 * tests check rather than a claim the code makes.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitHubCompletion } from '../src/delivery/completion.js';
import {
  completionLogsDir,
  createCompletionPass,
  createCompletionRun,
} from '../src/sources/completion.js';
import type { ArmOutcome, CompletionOutcome } from '../src/sources/completion.js';
import { createHttpClient } from '../src/sources/jira/http.js';
import { createJiraCompletionSource } from '../src/sources/jira/completion.js';
import { SourceError } from '../src/sources/contract.js';
import type { CompletionConfig, JiraSourceConfig } from '../src/shared/types.js';
import { fakeCompletionCalls, installFakeGhCompletion } from './fixtures/local-target.js';
import type { FakeCompletionState } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

afterEach(cleanupTempDirectories);

// ---------------------------------------------------------------------------
// The configuration and the GitHub state the tests drive
// ---------------------------------------------------------------------------

const CLOUD_ID = '9337c4da-7d33-4c1d-b03c-db207e537f88';
const SITE = 'https://example.atlassian.net';
const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;
const JIRA_TOKEN = 'service-account-token-value';
const REVIEWER_TOKEN = 'nexus-lens-reviewer-token';
const OPERATOR_TOKEN = 'operator-github-token';
const REPOSITORY = 'saintiago/nexus-harness';
const BASE_BRANCH = 'main';
const WORKSPACE_ID = 'run-20260101000000-abcdef01';
const WORKSPACE_POINTER = `harness-ws-${WORKSPACE_ID}`;
const BRANCH = `harness/${WORKSPACE_ID}`;
const ISSUE_ID = '10011';
const ISSUE_KEY = 'HARN-15';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);
const THIRD_HEAD = 'd'.repeat(40);
const PR_URL = `https://github.com/${REPOSITORY}/pull/29`;
const REVIEW_URL = `${PR_URL}#pullrequestreview-555`;
const LENS_CHECK_URL = 'https://github.com/saintiago/nexus-harness/runs/9001';
const WORKFLOW_URL = 'https://github.com/saintiago/nexus-harness/actions/runs/4242';

const COMPLETION: CompletionConfig = {
  lensApp: 'nexus-lens',
  lensAppId: 123,
  lensCheckName: 'Nexus Lens',
  reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
  postMergeWorkflows: ['ci.yml'],
  toDoStatus: 'To Do',
  doneStatus: 'Done',
  pollIntervalSeconds: 5,
  deadlineSeconds: 30,
};

const SOURCE: JiraSourceConfig = {
  type: 'jira',
  siteUrl: SITE,
  cloudId: CLOUD_ID,
  projectKey: 'HARN',
  issueType: 'Task',
  label: 'harness-task',
  readyStatus: 'To Do',
  runningStatus: 'In Progress',
  reviewStatus: 'In Review',
  ordering: 'priority',
  pollIntervalSeconds: 30,
  tokenEnv: 'JIRA_API_TOKEN',
};

const ONE_PULL_REQUEST = {
  number: 29,
  url: PR_URL,
  repo: REPOSITORY,
  state: 'OPEN',
  isDraft: false,
  headRefName: BRANCH,
  baseRefName: BASE_BRANCH,
  headRefOid: HEAD,
  mergeCommit: null,
};

const APPROVED_REVIEW = {
  id: 555,
  url: REVIEW_URL,
  author: { login: 'nexus-lens' },
  state: 'APPROVED',
  body: 'Reviewed the change: the fixture ownership check is correct.',
  commitId: HEAD,
};

const LENS_CHECK_PASSED = {
  name: 'Nexus Lens',
  state: 'SUCCESS',
  conclusion: 'SUCCESS',
  link: LENS_CHECK_URL,
};

function workflowRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseId: 4242,
    workflowId: 17,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    headSha: MERGE_COMMIT,
    headBranch: BASE_BRANCH,
    url: WORKFLOW_URL,
    ...overrides,
  };
}

/**
 * A merged pull request, as `gh pr view` answers for one. The list of open pull
 * requests still holds the unmerged record: GitHub is the one that moved it on,
 * and the fixture moves it too when a test asks for that.
 */
function mergedPullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...ONE_PULL_REQUEST,
    repo: REPOSITORY,
    state: 'MERGED',
    mergeCommit: { oid: MERGE_COMMIT },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The fake Jira boundary
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** One comment Jira holds on the issue. */
interface HeldComment {
  readonly id: string;
  readonly createdAt: string;
  readonly body: unknown;
  readonly text: string;
}

/** What the fake Jira site holds, and every request it received. */
interface FakeJira {
  readonly calls: FetchCall[];
  readonly comments: HeldComment[];
  readonly history: Record<string, unknown>[];
  /** The issue's current status name, as a transition changes it. */
  status: string;
  /** The labels the issue carries. */
  labels: string[];
  /** Whether every read of the issue fails, as an unreachable site would. */
  readFailure: boolean;
  /** Whether posting a comment fails. */
  commentFailure: boolean;
  /** Whether a status transition fails. */
  transitionFailure: boolean;
  /** The statuses the workflow offers transitions to, and the names they carry. */
  readonly targets: readonly string[];
  fetch: typeof fetch;
}

/** An ADF document of plain paragraphs, as `buildCommentDocument` writes one. */
function adfParagraphs(paragraphs: readonly string[]): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })),
  };
}

/** The text one ADF document carries, flattened: what the test reads back. */
function textOfAdf(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const document = value as Record<string, unknown>;
  const walk = (node: unknown): string[] => {
    if (typeof node !== 'object' || node === null) {
      return [];
    }
    const entry = node as Record<string, unknown>;
    const text = typeof entry['text'] === 'string' ? [entry['text']] : [];
    const children = Array.isArray(entry['content']) ? entry['content'].flatMap(walk) : [];
    return [...text, ...children];
  };
  return walk(document).join('\n');
}

function issueBody(state: FakeJira): Record<string, unknown> {
  return {
    id: ISSUE_ID,
    key: ISSUE_KEY,
    fields: {
      summary: 'Complete approved Nexus work',
      description: adfParagraphs(['## Acceptance criteria', '- It works.']),
      status: { name: state.status },
      labels: state.labels,
      project: { key: 'HARN' },
      issuetype: { name: 'Task' },
      updated: '2026-09-20T10:00:00.000Z',
    },
  };
}

function fakeJira(): FakeJira {
  const state: FakeJira = {
    calls: [],
    comments: [],
    history: [],
    status: 'In Review',
    labels: ['harness-task', WORKSPACE_POINTER],
    readFailure: false,
    commentFailure: false,
    transitionFailure: false,
    targets: ['In Progress', 'In Review', 'To Do', 'Done'],
    fetch: (() => {
      throw new Error('the fake Jira fetch was not installed');
    }) as unknown as typeof fetch,
  };

  state.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    state.calls.push({ url, method: init.method ?? 'GET', body });
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.includes('/changelog?')) return json({ values: state.history, isLast: true });
    if (state.readFailure) {
      return json({ errorMessages: ['Jira is unavailable'] }, 503);
    }
    if (url === `${GATEWAY}/rest/api/3/search/jql`) {
      return json({
        issues: [
          {
            id: ISSUE_ID,
            key: ISSUE_KEY,
            fields: {
              summary: 'Complete approved Nexus work',
              status: { name: state.status },
              labels: state.labels,
              project: { key: 'HARN' },
              issuetype: { name: 'Task' },
              updated: '2026-09-20T10:00:00.000Z',
            },
          },
        ],
        isLast: true,
      });
    }
    if (url.startsWith(`${GATEWAY}/rest/api/3/issue/${ISSUE_ID}?`)) {
      return json(issueBody(state));
    }
    if (url === `${GATEWAY}/rest/api/3/issue/${ISSUE_ID}/transitions?expand=transitions.fields`) {
      return json({
        transitions: state.targets.map((target, index) => ({
          id: String(11 + index),
          name: `Move to ${target}`,
          to: { name: target },
          fields: {},
        })),
      });
    }
    if (url === `${GATEWAY}/rest/api/3/issue/${ISSUE_ID}/transitions` && init.method === 'POST') {
      if (state.transitionFailure) {
        return json({ errorMessages: ['Transition refused'] }, 400);
      }
      const wanted = (body as { transition?: { id?: string } } | undefined)?.transition?.id;
      const chosen = state.targets[Number(wanted ?? '') - 11];
      if (chosen !== undefined) {
        state.history.push({
          created: '2026-09-20T11:30:00.000Z',
          items: [{ field: 'status', fromString: state.status, toString: chosen }],
        });
        state.status = chosen;
      }
      return new Response(null, { status: 204 });
    }
    if (url === `${GATEWAY}/rest/api/3/issue/${ISSUE_ID}/comment` && init.method === 'POST') {
      if (state.commentFailure) {
        // The write never landed: nothing is stored.
        return json({ errorMessages: ['Comment refused'] }, 400);
      }
      const document = (body as { body?: unknown } | undefined)?.body;
      const comment: HeldComment = {
        id: String(900 + state.comments.length),
        createdAt: '2026-09-20T11:00:00.000Z',
        body: document,
        text: textOfAdf(document),
      };
      state.comments.push(comment);
      return json({ id: comment.id, body: comment.body });
    }
    if (url.startsWith(`${GATEWAY}/rest/api/3/issue/${ISSUE_ID}/comment?`)) {
      return json({
        comments: state.comments.map((comment) => ({
          id: comment.id,
          created: comment.createdAt,
          body: comment.body,
        })),
        total: state.comments.length,
      });
    }
    return json({ errorMessages: [`unsupported fake Jira route: ${url}`] }, 404);
  }) as unknown as typeof fetch;

  return state;
}

// ---------------------------------------------------------------------------
// The fixture: one retained workspace, one stand-in gh, one fake Jira
// ---------------------------------------------------------------------------

interface Fixture {
  readonly parent: string;
  readonly workDir: string;
  readonly logsDir: string;
  readonly gh: FakeCompletionState;
  readonly jira: FakeJira;
  readonly config: CompletionConfig;
}

interface FixtureOptions {
  readonly pulls?: readonly Record<string, unknown>[];
  /**
   * Whether GitHub has already merged the delivered pull request: the open list
   * no longer holds it, and the pull request read reports the merge.
   */
  readonly merged?: boolean;
  /**
   * Whether the pass starts with the per-issue evidence directory already
   * there. `false` is how production begins: no `completion-logs` directory at
   * all, so the pass itself has to create it before its first GitHub command.
   */
  readonly evidenceDir?: boolean;
  readonly reviews?: readonly Record<string, unknown>[];
  readonly checks?: readonly Record<string, unknown>[];
  readonly runs?: readonly Record<string, unknown>[];
  readonly config?: Partial<CompletionConfig>;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const parent = await createTempDir();
  const workDir = path.join(parent, 'harness');
  const logsDir = completionLogsDir(
    workDir,
    { type: 'jira', scope: SITE, id: ISSUE_ID },
    REPOSITORY,
  );
  if (options.evidenceDir === false) {
    if (options.merged === true)
      throw new Error(
        'a merged fixture seeds the admission a restart resumes from, so it needs its ' +
          'evidence directory to be created first',
      );
  } else {
    await mkdir(logsDir, { recursive: true });
  }
  await mkdir(path.join(workDir, 'workspaces', WORKSPACE_ID), { recursive: true });

  const gh = await installFakeGhCompletion(parent);
  const pulls =
    options.merged === true ? [mergedPullRequest()] : (options.pulls ?? [ONE_PULL_REQUEST]);
  await writeFile(
    gh.pullRequestsFile,
    `${pulls.map((pull) => JSON.stringify(pull)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    gh.reviewsFile,
    `${JSON.stringify(options.reviews ?? [APPROVED_REVIEW])}\n`,
    'utf8',
  );
  await writeFile(
    gh.checksFile,
    `${JSON.stringify(options.checks ?? [LENS_CHECK_PASSED])}\n`,
    'utf8',
  );
  await writeFile(
    gh.runsFile,
    `${(options.runs ?? [workflowRun()]).map((run) => JSON.stringify(run)).join('\n')}\n`,
    'utf8',
  );

  if (options.merged === true)
    await writeFile(
      path.join(logsDir, 'completion-armed-head.json'),
      JSON.stringify({ head: HEAD, number: 29, waitingSince: null }),
    );
  const jira = fakeJira();
  const config: CompletionConfig = { ...COMPLETION, ...options.config };
  return { parent, workDir, logsDir, gh, jira, config };
}

/** The completion pass one fixture describes, with a stand-in clock. */
function passFor(
  fixture: Fixture,
  parts: {
    readonly source?: JiraSourceConfig;
    readonly repository?: string;
    readonly reader?: (stop: AbortSignal) => Promise<string>;
    readonly fail?: string;
    readonly mergeOnArm?: string;
    /** Whether the stand-in GitHub refuses to arm a pull request with green required checks. */
    readonly rejectArmWhenClean?: boolean;
    /** The required check names the stand-in GitHub uses to decide whether a head is clean. */
    readonly requiredChecks?: readonly string[];
    readonly reviewsUnknown?: boolean;
    readonly clockStepMs?: number;
    /** Where this pass's clock starts, so several passes can be ordered in time. */
    readonly clockStartMs?: number;
    readonly onSleep?: () => Promise<void>;
    readonly sleepCalls?: { count: number };
  } = {},
) {
  let clock = parts.clockStartMs ?? Date.parse('2026-09-20T12:00:00.000Z');
  const step = parts.clockStepMs ?? 15_000;
  const now = (): Date => {
    clock += step;
    return new Date(clock);
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_GH: JSON.stringify({
      stateDir: fixture.gh.dir,
      token: OPERATOR_TOKEN,
      ...(parts.fail === undefined ? {} : { fail: parts.fail }),
      ...(parts.mergeOnArm === undefined ? {} : { mergeOnArm: parts.mergeOnArm }),
      ...(parts.rejectArmWhenClean === true ? { rejectArmWhenClean: true } : {}),
      ...(parts.requiredChecks === undefined ? {} : { requiredChecks: [...parts.requiredChecks] }),
    }),
    GH_TOKEN: OPERATOR_TOKEN,
    NEXUS_LENS_TOKEN: REVIEWER_TOKEN,
  };
  const source = parts.source ?? SOURCE;
  const http = createHttpClient(source, JIRA_TOKEN, { fetch: fixture.jira.fetch });
  const actions = createGitHubCompletion(fixture.config, parts.reader ?? REVIEWER_TOKEN, {
    command: fixture.gh.command,
    env,
  });
  const io = { out: () => undefined, err: () => undefined };
  return createCompletionPass({
    config: fixture.config,
    repository: parts.repository ?? REPOSITORY,
    baseBranch: BASE_BRANCH,
    source: createJiraCompletionSource(source, http),
    actions,
    workDir: fixture.workDir,
    io,
    now,
    sleep: async () => {
      if (parts.sleepCalls !== undefined) {
        parts.sleepCalls.count += 1;
      }
      await parts.onSleep?.();
    },
  });
}

async function runPass(
  fixture: Fixture,
  parts: Parameters<typeof passFor>[1] = {},
): Promise<readonly CompletionOutcome[]> {
  return await passFor(fixture, parts).run(AbortSignal.timeout(30_000));
}

/** The single outcome one pass is expected to have produced. */
function only(outcomes: readonly CompletionOutcome[]): CompletionOutcome {
  expect(outcomes).toHaveLength(1);
  const [first] = outcomes;
  if (first === undefined) {
    throw new Error('the pass produced no outcome');
  }
  return first;
}

/** The single arm outcome one pass is expected to have produced. */
function onlyArm(outcomes: readonly ArmOutcome[]): ArmOutcome {
  expect(outcomes).toHaveLength(1);
  const [first] = outcomes;
  if (first === undefined) {
    throw new Error('the arm step produced no outcome');
  }
  return first;
}

/** The comment bodies the fake Jira holds, as flat text. */
function commentTexts(fixture: Fixture): readonly string[] {
  return fixture.jira.comments.map((comment) => comment.text);
}

/** The transitions the fake Jira was asked to make, in order. */
function transitions(fixture: Fixture): readonly string[] {
  return fixture.jira.calls
    .filter((call) => call.method === 'POST' && call.url.endsWith('/transitions'))
    .map((call) => String((call.body as { transition?: { id?: string } })?.transition?.id ?? ''));
}

// ---------------------------------------------------------------------------
// The path itself
// ---------------------------------------------------------------------------

describe('review-to-completion', () => {
  it('refreshes the reader credential for later evidence reads without changing the operator identity', async () => {
    const fixture = await createFixture({ merged: true });
    let readings = 0;
    const outcome = only(
      await runPass(fixture, {
        reader: async () => `installation-token-${String(++readings)}`,
      }),
    );
    expect(outcome.status, outcome.detail).toBe('done');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.map((call) => call.credential)).toEqual(
      calls.map((_, index) => `installation-token-${String(index + 1)}`),
    );
  });

  it('stops before GitHub commands or Jira writes when reader refresh fails', async () => {
    const fixture = await createFixture({ merged: true });
    const outcome = only(
      await runPass(fixture, {
        reader: async () => {
          throw new Error('App installation refresh denied');
        },
      }),
    );
    expect(outcome.status).toBe('attention');
    expect(outcome.detail).toContain('App installation refresh denied');
    expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
    expect(commentTexts(fixture)).toEqual([]);
    expect(transitions(fixture)).toEqual([]);
  });

  it('refuses a refreshed reader token that equals the operator credential', async () => {
    const fixture = await createFixture({ merged: true });
    const outcome = only(await runPass(fixture, { reader: async () => OPERATOR_TOKEN }));
    expect(outcome.status).toBe('attention');
    expect(outcome.detail).toContain('credentials must be different');
    expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
    expect(transitions(fixture)).toEqual([]);
  });

  it('finishes an approved pull request after its merge and main workflow succeeded', async () => {
    const fixture = await createFixture({ merged: true, runs: [workflowRun()] });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    const comment = commentTexts(fixture)[0] ?? '';
    expect(comment).toContain('nexus-completion:resolution:');
    expect(comment).toContain(MERGE_COMMIT);
    expect(comment).toContain(PR_URL);
    expect(comment).toContain(WORKFLOW_URL);
    // The resolution comment is one short, evidence-based note: at most 120
    // words, which is what the task asks the issue's thread to receive.
    expect(comment.split(/\s+/).filter((word) => word !== '').length).toBeLessThanOrEqual(120);

    const calls = await fakeCompletionCalls(fixture.gh);
    // A pull request that is already merged proves its reviewed head from the
    // approval alone: there is no open pull request left to gate, and the merge
    // and its workflows are what is read.
    expect(calls.some((call) => call.op === 'reviews')).toBe(true);
    expect(calls.some((call) => call.op === 'lens')).toBe(true);
    expect(calls.some((call) => call.op === 'runs')).toBe(true);
    expect(calls.every((call) => call.credential === REVIEWER_TOKEN)).toBe(true);
  });

  it('arms native auto-merge with the operator credential and waits for GitHub to merge', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      runs: [],
      config: { deadlineSeconds: 10 },
    });
    // The merge happens with the second reading of the pull request; the
    // workflow run appears only on the third poll, which is the delay this path
    // has to tolerate.
    let views = 0;
    let runPolls = 0;
    const originalRuns = fixture.gh.runsFile;
    await writeFile(originalRuns, '', 'utf8');

    const outcome = only(
      await runPass(fixture, {
        clockStepMs: 1_000,
        reader: async () => REVIEWER_TOKEN,
        onSleep: async () => {
          views += 1;
          if (views === 1) {
            await writeFile(
              fixture.gh.pullRequestsFile,
              `${JSON.stringify(mergedPullRequest())}\n`,
              'utf8',
            );
          }
          runPolls += 1;
          if (runPolls === 2) {
            await writeFile(fixture.gh.runsFile, `${JSON.stringify(workflowRun())}\n`, 'utf8');
          }
        },
      }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    const calls = await fakeCompletionCalls(fixture.gh);
    const merge = calls.find((call) => call.op === 'merge');
    expect(merge?.credential).toBe(OPERATOR_TOKEN);
    expect(
      calls
        .filter((call) => call.op !== 'merge')
        .every((call) => call.credential === REVIEWER_TOKEN),
    ).toBe(true);
    expect(merge?.auto).toBe(true);
    expect(merge?.squash).toBe(true);
    expect(merge?.argv.join(' ')).toContain('enablePullRequestAutoMerge');
    expect(merge?.argv.join(' ')).not.toContain('mergePullRequest(');
    // No direct merge: the completion path only ever asks GitHub to arm it.
    expect(calls.some((call) => call.argv.includes('--admin'))).toBe(false);
    expect(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ).toContain(HEAD);
  });

  it('creates the per-issue evidence directory before its first GitHub command', async () => {
    // The production start: nothing has created `completion-logs` yet, and the
    // first GitHub read is what has to write its output there.
    const fixture = await createFixture({ evidenceDir: false });

    const outcome = only(
      await runPass(fixture, {
        clockStepMs: 1_000,
        onSleep: async () => {
          await writeFile(
            fixture.gh.pullRequestsFile,
            `${JSON.stringify(mergedPullRequest())}\n`,
            'utf8',
          );
        },
      }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    // The directory the pass needed did not exist when it started, and every
    // command it ran wrote its own output into the one it created.
    const entries = await readdir(fixture.logsDir);
    const outputs = entries.filter((name) => name.endsWith('.stdout.log'));
    expect(outputs.length).toBeGreaterThan(0);
    const written = (
      await Promise.all(outputs.map((name) => readFile(path.join(fixture.logsDir, name), 'utf8')))
    ).join('\n');
    expect(written).toContain('"number":29');
    expect(entries).toContain('completion-armed-head.json');
  });

  it('stops for a person and names the location when its evidence directory cannot be created', async () => {
    const fixture = await createFixture({ evidenceDir: false });
    // A file where the per-issue directory belongs: creating the evidence
    // directory fails the way a path or permission problem would, before any
    // GitHub command has a log directory to write into.
    await writeFile(path.join(fixture.workDir, 'completion-logs'), 'not a directory\n', 'utf8');

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain(fixture.logsDir);
    expect(outcome.detail).toContain('could not be created');
    expect(outcome.detail).toContain('auto-merge was not armed');
    for (const credential of [OPERATOR_TOKEN, REVIEWER_TOKEN, JIRA_TOKEN])
      expect(outcome.detail).not.toContain(credential);
    // Nothing was read from GitHub, nothing was armed, and Jira was not touched.
    expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
    expect(commentTexts(fixture)).toEqual([]);
    expect(transitions(fixture)).toEqual([]);
    expect(fixture.jira.status).toBe('In Review');
  });

  it('bounds pending required pull request checks with an attention comment', async () => {
    const fixture = await createFixture({
      checks: [
        LENS_CHECK_PASSED,
        { name: 'validate', state: 'PENDING', conclusion: null, link: LENS_CHECK_URL },
      ],
    });

    const outcome = only(await runPass(fixture, { clockStepMs: 20_000 }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.filter((call) => call.op === 'merge')).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:attention:');
    expect(commentTexts(fixture)[0]).toContain('deadline');
  });

  it('returns a request-changes decision to the To Do status with the review link', async () => {
    const fixture = await createFixture({
      reviews: [
        {
          ...APPROVED_REVIEW,
          state: 'CHANGES_REQUESTED',
          body: 'The fixture ownership check is inverted; fix it and add a regression test.',
        },
      ],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain(REVIEW_URL);
    expect(commentTexts(fixture)[0]).toContain('fixture ownership check is inverted');
    // The workspace pointer is never removed: the repair continues there.
    expect(fixture.jira.labels).toContain(WORKSPACE_POINTER);
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('treats a failed Lens check associated with request changes as a finding', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, state: 'CHANGES_REQUESTED' }],
      checks: [
        { name: 'Nexus Lens', state: 'FAILURE', conclusion: 'FAILURE', link: LENS_CHECK_URL },
      ],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(commentTexts(fixture)[0]).toContain('Nexus Lens');
    expect(commentTexts(fixture)[0]).toContain(REVIEW_URL);
  });

  it('treats a failed required pull request check as a finding naming the check', async () => {
    const fixture = await createFixture({
      checks: [
        LENS_CHECK_PASSED,
        {
          name: 'validate',
          state: 'FAILURE',
          conclusion: 'FAILURE',
          link: 'https://github.com/saintiago/nexus-harness/actions/runs/7001',
        },
      ],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('validate');
    expect(commentTexts(fixture)[0]).toContain('actions/runs/7001');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('stays In Review with no comment when a stale head is the only approval', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, commitId: OTHER_HEAD }],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('observed');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('stays In Review when the approval has no app-owned Lens check behind it', async () => {
    const fixture = await createFixture({ checks: [] });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('observed');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it('never arms a pull request whose reviews are missing or unclear', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, state: 'COMMENTED' }],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('observed');
    expect(fixture.jira.status).toBe('In Review');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('stays In Review when the delivered pull request is closed rather than open', async () => {
    const fixture = await createFixture({ pulls: [{ ...ONE_PULL_REQUEST, state: 'CLOSED' }] });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('observed');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it('stays In Review when two open pull requests make the delivery ambiguous', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST, { ...ONE_PULL_REQUEST, number: 30, url: `${PR_URL}x` }],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('reports a branch-protection refusal and stays In Review', async () => {
    const fixture = await createFixture({});

    const outcome = only(await runPass(fixture, { fail: 'merge' }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:attention:');
    expect(commentTexts(fixture)[0]).toContain('operator attention');
  });

  it('reports an authentication failure and stays In Review', async () => {
    const fixture = await createFixture({});

    const outcome = only(await runPass(fixture, { fail: 'list' }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    // The list is what failed, so there is no pull request to point at yet: the
    // pass reports the failure and writes nothing.
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(outcome.detail).toContain('operator attention');
  });

  it('returns a post-merge workflow failure to To Do with its conclusion and link', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun({ status: 'completed', conclusion: 'failure', databaseId: 5001 })],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    const comment = commentTexts(fixture)[0] ?? '';
    expect(comment).toContain('ci.yml');
    expect(comment).toContain('FAILURE');
    expect(comment).toContain(WORKFLOW_URL);
    expect(comment).toContain(MERGE_COMMIT);
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['timed_out', 'TIMED_OUT'],
    ['action_required', 'ACTION_REQUIRED'],
    ['stale', 'STALE'],
    ['skipped', 'SKIPPED'],
    ['neutral', 'NEUTRAL'],
  ])('treats a latest workflow attempt of %s as unsuccessful', async (_, conclusion) => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun({ status: 'completed', conclusion })],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(commentTexts(fixture)[0]).toContain(String(conclusion).toUpperCase());
  });

  it('reads only the latest attempt of each configured workflow', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [
        workflowRun({ databaseId: 5001, status: 'completed', conclusion: 'failure' }),
        workflowRun({ databaseId: 5002, status: 'completed', conclusion: 'success' }),
      ],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
  });

  it('requires every configured workflow, not just one', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun()],
      config: { postMergeWorkflows: ['ci.yml', 'release.yml'] },
    });

    const outcome = only(await runPass(fixture, { clockStepMs: 20_000 }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)[0]).toContain('deadline');
    expect(commentTexts(fixture)[0]).toContain('release.yml');
  });

  it('matches a workflow by its numeric ID as well as its file', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun()],
      config: { postMergeWorkflows: ['17'] },
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
  });

  it('ignores a run for another event or branch when it looks like the workflow', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun({ event: 'pull_request' }), workflowRun({ headBranch: 'release' })],
    });

    const outcome = only(await runPass(fixture, { clockStepMs: 20_000 }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)[0]).toContain('no run yet');
  });

  it('bounds a merge that never finishes across passes, then reports attention once', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      config: { deadlineSeconds: 30 },
    });
    const start = Date.parse('2026-09-20T12:00:00.000Z');
    // Two passes with a one-second clock: auto-merge is armed by the first, the
    // item is left In Review waiting, and no comment claims anything about a
    // merge that has not happened.
    const first = only(await runPass(fixture, { clockStartMs: start, clockStepMs: 1_000 }));
    const second = only(
      await runPass(fixture, { clockStartMs: start + 5_000, clockStepMs: 1_000 }),
    );
    expect(first.status).toBe('pending');
    expect(second.status).toBe('pending');
    expect(commentTexts(fixture)).toHaveLength(0);
    // The moment the item began waiting is kept as the first pass recorded it:
    // a later pass reads it back instead of starting the deadline again.
    const armed = JSON.parse(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { waitingSince?: string };
    expect(Date.parse(armed.waitingSince ?? '')).toBeGreaterThanOrEqual(start);
    expect(Date.parse(armed.waitingSince ?? '')).toBeLessThan(start + 5_000);

    // A later pass over the same item, far past the deadline, reports the wait
    // once and leaves the item In Review: no failure conclusion was observed.
    const third = only(
      await runPass(fixture, { clockStartMs: start + 120_000, clockStepMs: 1_000 }),
    );
    expect(third.status).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:attention:');
    expect(commentTexts(fixture)[0]).toContain('deadline expired');

    const fourth = only(
      await runPass(fixture, { clockStartMs: start + 125_000, clockStepMs: 1_000 }),
    );
    expect(fourth.status).toBe('attention');
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(1);
  });

  it('writes one findings comment and one move when the pass is repeated', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, state: 'CHANGES_REQUESTED' }],
    });

    const first = only(await runPass(fixture));
    expect(first.status).toBe('to-do');
    // A person moved it back for repair: the second pass finds it no longer In
    // Review and touches nothing.
    fixture.jira.status = 'In Review';
    const second = only(await runPass(fixture));

    expect(second.status).toBe('observed');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
  });

  it('resumes a resolution comment whose Done move never arrived', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.transitionFailure = true;

    // The merge and its workflow succeed, the comment lands, and the move does
    // not: the item is still In Review with the resolution comment on it.
    const first = only(await runPass(fixture));
    expect(first.status).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(1);

    fixture.jira.transitionFailure = false;
    const second = only(await runPass(fixture));

    expect(second.status).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.filter((call) => call.op === 'merge')).toHaveLength(0);
  });

  it('does not duplicate the resolution comment when the move failed first', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.transitionFailure = true;

    // The merge and its workflow are verified, the resolution comment lands, and
    // the move does not: the item is still In Review with that comment on it.
    const first = only(await runPass(fixture));

    expect(first.status).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:resolution:');

    fixture.jira.transitionFailure = false;
    const second = only(await runPass(fixture));

    expect(second.status).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
  });

  it('follows a merge GitHub makes after auto-merge was armed', async () => {
    const fixture = await createFixture({ pulls: [ONE_PULL_REQUEST] });

    const first = only(await runPass(fixture, { clockStepMs: 1_000 }));
    expect(first.status).toBe('pending');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);

    // GitHub merges the armed pull request while nothing is polling.
    await writeFile(
      fixture.gh.pullRequestsFile,
      `${JSON.stringify(mergedPullRequest())}\n`,
      'utf8',
    );
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.filter((call) => call.op === 'merge')).toHaveLength(1);

    const second = only(await runPass(fixture));

    expect(second.status).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:resolution:');
  });

  it('stops without mutation when a person moved the ticket out of In Review', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.status = 'In Progress';

    const outcomes = await passFor(fixture).run(AbortSignal.timeout(30_000));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('observed');
    expect(outcomes[0]?.detail).toContain('no longer In Review');
    expect(fixture.jira.status).toBe('In Progress');
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it('reports a Jira read failure without moving anything', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.readFailure = true;

    await expect(passFor(fixture).run(AbortSignal.timeout(30_000))).rejects.toBeInstanceOf(
      SourceError,
    );
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it('does not write a second comment when the first write was uncertain', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, state: 'CHANGES_REQUESTED' }],
    });
    // The comment lands, but the answer is lost: the client cannot acknowledge it.
    fixture.jira.commentFailure = true;
    const failing = only(await runPass(fixture));
    expect(failing.status).toBe('attention');
    expect(commentTexts(fixture)).toHaveLength(0);

    // On the next pass the write succeeds and the item moves exactly once.
    fixture.jira.commentFailure = false;
    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
  });

  it.each([
    { appId: 999 },
    { headSha: OTHER_HEAD },
    { reviewUrl: `${PR_URL}#another-review` },
    { state: 'FAILURE', conclusion: 'FAILURE' },
  ])('refuses an unowned, stale, unrelated or contradictory Lens check: %j', async (override) => {
    const fixture = await createFixture({ checks: [{ ...LENS_CHECK_PASSED, ...override }] });
    const result = only(await runPass(fixture));
    expect(result.status).toBe('observed');
    expect(fixture.jira.comments).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
    expect((await fakeCompletionCalls(fixture.gh)).some((c) => c.op === 'merge')).toBe(false);
  });

  it('uses the latest review decision even when an older approval is present', async () => {
    const fixture = await createFixture({
      reviews: [
        APPROVED_REVIEW,
        {
          ...APPROVED_REVIEW,
          id: 556,
          state: 'CHANGES_REQUESTED',
          body: 'Fix the ownership race.',
        },
      ],
    });
    expect(only(await runPass(fixture)).status).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('ownership race');
  });

  it('does not arm twice across restart or an uncertain auto-merge response', async () => {
    const fixture = await createFixture();
    await runPass(fixture, { fail: 'merge-uncertain', clockStepMs: 1000 });
    await runPass(fixture, { clockStepMs: 1000 });
    expect((await fakeCompletionCalls(fixture.gh)).filter((c) => c.op === 'merge')).toHaveLength(1);
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('returns a failed required check observed after arming to To Do', async () => {
    const fixture = await createFixture();
    const result = only(
      await runPass(fixture, {
        clockStepMs: 1000,
        onSleep: async () => {
          await writeFile(
            fixture.gh.checksFile,
            JSON.stringify([
              LENS_CHECK_PASSED,
              { name: 'validate', state: 'FAILURE', link: WORKFLOW_URL },
            ]),
          );
        },
      }),
    );
    expect(result.status, result.detail).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('validate');
    expect(fixture.jira.labels).toContain(WORKSPACE_POINTER);
  });

  it('does not return an optional failed check for repair', async () => {
    const fixture = await createFixture({
      checks: [
        LENS_CHECK_PASSED,
        { name: 'optional', state: 'FAILURE', link: WORKFLOW_URL, required: false },
      ],
    });
    expect(only(await runPass(fixture, { clockStepMs: 1000 })).status).toBe('pending');
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('reports conflicts without established coding findings or auto-merge', async () => {
    const fixture = await createFixture({
      pulls: [{ ...ONE_PULL_REQUEST, mergeable: 'CONFLICTING' }],
    });
    expect(only(await runPass(fixture)).status).toBe('observed');
    expect(transitions(fixture)).toHaveLength(0);
    expect((await fakeCompletionCalls(fixture.gh)).some((c) => c.op === 'merge')).toBe(false);
  });

  it('stops when the PR head moves during polling', async () => {
    const fixture = await createFixture();
    const result = only(
      await runPass(fixture, {
        clockStepMs: 1000,
        onSleep: async () => {
          await writeFile(
            fixture.gh.pullRequestsFile,
            JSON.stringify({ ...ONE_PULL_REQUEST, headRefOid: OTHER_HEAD }) + '\n',
          );
        },
      }),
    );
    expect(result.status).toBe('attention');
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it.each(['base', 'head', 'missing-merge', 'wrong-sha'])(
    'does not resolve mismatched merge evidence: %s',
    async (dimension) => {
      const fixture = await createFixture({ merged: true });
      if (dimension === 'wrong-sha')
        await writeFile(
          fixture.gh.runsFile,
          JSON.stringify(workflowRun({ headSha: OTHER_HEAD })) + '\n',
        );
      else
        await writeFile(
          fixture.gh.pullRequestsFile,
          JSON.stringify(
            mergedPullRequest(
              dimension === 'base'
                ? { baseRefName: 'release' }
                : dimension === 'head'
                  ? { headRefOid: OTHER_HEAD }
                  : { mergeCommit: null },
            ),
          ) + '\n',
        );
      await runPass(fixture, { clockStepMs: 20000 });
      expect(fixture.jira.status).toBe('In Review');
      expect(transitions(fixture)).toHaveLength(0);
      expect(commentTexts(fixture).some((c) => c.includes('nexus-completion:resolution'))).toBe(
        false,
      );
    },
  );

  it.each(['queued', 'in_progress'])(
    'waits for a post-merge workflow %s without fabricating failure',
    async (status) => {
      const fixture = await createFixture({
        merged: true,
        runs: [workflowRun({ status, conclusion: null })],
      });
      expect(only(await runPass(fixture, { clockStepMs: 1000 })).status).toBe('pending');
      expect(commentTexts(fixture)).toHaveLength(0);
      expect(transitions(fixture)).toHaveLength(0);
    },
  );

  it('selects the latest attempt of the same run ID', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [
        workflowRun({ runAttempt: 2, conclusion: 'failure' }),
        workflowRun({ runAttempt: 1, conclusion: 'success' }),
      ],
    });
    expect(only(await runPass(fixture)).status).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('FAILURE');
  });

  it('names every unsuccessful configured workflow in one concise comment', async () => {
    const fixture = await createFixture({
      merged: true,
      config: { postMergeWorkflows: ['ci.yml', 'release.yml'] },
      runs: [
        workflowRun({ conclusion: 'failure' }),
        workflowRun({
          databaseId: 4243,
          workflowId: 18,
          path: '.github/workflows/release.yml',
          conclusion: 'cancelled',
        }),
      ],
    });
    expect(only(await runPass(fixture)).status).toBe('to-do');
    const comments = commentTexts(fixture);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('ci.yml');
    expect(comments[0]).toContain('release.yml');
    expect(comments[0]).toContain('CANCELLED');
    expect(comments[0]?.split(/\s+/).length).toBeLessThan(120);
  });

  it('requires workflow health again even when an old resolution comment exists', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.transitionFailure = true;
    await runPass(fixture);
    fixture.jira.transitionFailure = false;
    await writeFile(
      fixture.gh.runsFile,
      JSON.stringify(workflowRun({ runAttempt: 2, status: 'queued', conclusion: null })) + '\n',
    );
    const before = transitions(fixture).length;
    expect(only(await runPass(fixture, { clockStepMs: 1000 })).status).toBe('pending');
    expect(transitions(fixture)).toHaveLength(before);
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(1);
  });

  it('does not backfill a historical merged PR without an admission', async () => {
    const fixture = await createFixture({ pulls: [mergedPullRequest()] });
    expect(only(await runPass(fixture)).status).toBe('observed');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('respects a human reopening the same resolved merge', async () => {
    const fixture = await createFixture({ merged: true });
    expect(only(await runPass(fixture)).status).toBe('done');
    fixture.jira.status = 'In Review';
    expect(only(await runPass(fixture)).status).toBe('observed');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
  });

  it('can resolve a reopened ticket only for a later different merged result', async () => {
    const fixture = await createFixture({ merged: true });
    await runPass(fixture);
    fixture.jira.status = 'In Review';
    await writeFile(
      fixture.gh.pullRequestsFile,
      JSON.stringify(mergedPullRequest({ mergeCommit: { oid: 'd'.repeat(40) } })) + '\n',
    );
    await writeFile(
      fixture.gh.runsFile,
      JSON.stringify(workflowRun({ headSha: 'd'.repeat(40) })) + '\n',
    );
    expect(only(await runPass(fixture)).status).toBe('done');
    expect(commentTexts(fixture)).toHaveLength(2);
  });

  it('recovers a comment accepted by Jira whose response was lost', async () => {
    const fixture = await createFixture({ merged: true });
    const original = fixture.jira.fetch;
    fixture.jira.transitionFailure = true;
    fixture.jira.fetch = (async (input, init) => {
      const result = await original(input, init);
      return init?.method === 'POST' && String(input).endsWith('/comment')
        ? new Response('{}', { status: 200 })
        : result;
    }) as typeof fetch;
    expect(only(await runPass(fixture)).status).toBe('attention');
    fixture.jira.fetch = original;
    fixture.jira.transitionFailure = false;
    expect(only(await runPass(fixture)).status).toBe('done');
    expect(commentTexts(fixture)).toHaveLength(1);
  });

  it('does not repeat a transition that Jira accepted with a lost response', async () => {
    const fixture = await createFixture({ merged: true });
    const original = fixture.jira.fetch;
    fixture.jira.fetch = (async (input, init) => {
      const result = await original(input, init);
      return init?.method === 'POST' && String(input).endsWith('/transitions')
        ? new Response('{}', { status: 503 })
        : result;
    }) as typeof fetch;
    await runPass(fixture);
    fixture.jira.fetch = original;
    await runPass(fixture);
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
  });

  it.each(['comment', 'transition'])('respects a human status change before %s', async (stage) => {
    const fixture = await createFixture({ merged: true });
    const original = fixture.jira.fetch;
    fixture.jira.fetch = (async (input, init) => {
      const result = await original(input, init);
      if (
        (stage === 'comment' && String(input).includes('/comment?')) ||
        (stage === 'transition' && init?.method === 'POST' && String(input).endsWith('/comment'))
      )
        fixture.jira.status = 'In Progress';
      return result;
    }) as typeof fetch;
    await runPass(fixture);
    expect(fixture.jira.status).toBe('In Progress');
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(stage === 'comment' ? 0 : 1);
  });

  it('includes actionable inline Lens findings in the repair comment', async () => {
    const fixture = await createFixture({
      reviews: [
        {
          ...APPROVED_REVIEW,
          state: 'CHANGES_REQUESTED',
          body: 'See inline findings.',
          inlineComments: [
            {
              path: 'src/ownership.ts',
              body: 'Reverse the ownership comparison before releasing the lock.',
            },
          ],
        },
      ],
    });
    expect(only(await runPass(fixture)).status).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('Reverse the ownership comparison');
  });

  it('does not treat a completed workflow without a conclusion as failure', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun({ conclusion: null })],
    });
    expect(only(await runPass(fixture, { clockStepMs: 1000 })).status).toBe('pending');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('never duplicates a comment when Jira returns an incomplete comment listing', async () => {
    const fixture = await createFixture({ merged: true });
    const original = fixture.jira.fetch;
    fixture.jira.fetch = (async (input, init) =>
      String(input).includes('/comment?')
        ? new Response(JSON.stringify({ comments: [], total: 1000 }), { status: 200 })
        : original(input, init)) as typeof fetch;
    await runPass(fixture);
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('runs only GitHub commands: no coding runtime is installed or started', async () => {
    const fixture = await createFixture({ merged: true });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('done');
    const calls = await fakeCompletionCalls(fixture.gh);
    // Every command the completion path ran was the stand-in `gh`, which records
    // only the `gh` invocations it speaks; nothing here started a runtime.
    expect(calls.every((call) => ['pr', 'api'].includes(call.argv[0] ?? ''))).toBe(true);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Arming before the final required gate
// ---------------------------------------------------------------------------

/**
 * The race the queue's arm step closes: a delivered pull request can become
 * clean — every required check green — before the completion phase runs. The
 * stand-in GitHub refuses to arm such a pull request exactly as production does,
 * so these tests can tell an early arm from one attempted at completion time.
 */
describe('arming native auto-merge before the final gate', () => {
  it.each(['site', 'repository'])(
    'keeps concurrent completion admissions separate across %s identities and restarts',
    async (difference) => {
      const first = await createFixture();
      const source =
        difference === 'site' ? { ...SOURCE, siteUrl: 'https://other.atlassian.net' } : SOURCE;
      const repository = difference === 'repository' ? 'owner/other' : REPOSITORY;
      const second = {
        ...(await createFixture({
          pulls: [{ ...ONE_PULL_REQUEST, repo: repository, headRefOid: OTHER_HEAD }],
        })),
        workDir: first.workDir,
        logsDir: completionLogsDir(
          first.workDir,
          { type: source.type, scope: source.siteUrl, id: ISSUE_ID },
          repository,
        ),
      };
      expect(second.logsDir).not.toBe(first.logsDir);
      expect(
        completionLogsDir(
          first.workDir,
          { type: SOURCE.type, scope: SITE, id: ISSUE_ID },
          REPOSITORY.toUpperCase(),
        ),
      ).toBe(first.logsDir);
      const results = await Promise.all([
        passFor(first).arm(AbortSignal.timeout(30_000)),
        passFor(second, { source, repository }).arm(AbortSignal.timeout(30_000)),
      ]);
      for (const result of results) expect(onlyArm(result).status).toBe('armed');
      const firstFile = path.join(first.logsDir, 'completion-armed-head.json');
      const secondFile = path.join(second.logsDir, 'completion-armed-head.json');
      const firstRecord = await readFile(firstFile, 'utf8');
      const secondRecord = await readFile(secondFile, 'utf8');
      expect(JSON.parse(firstRecord)).toMatchObject({ head: HEAD, number: 29 });
      expect(JSON.parse(secondRecord)).toMatchObject({ head: OTHER_HEAD, number: 29 });
      // Restart both consumers: each finds its own admission and verifies the
      // existing arm without rewriting it or repeating the remote mutation.
      const restarted = await Promise.all([
        passFor(first).arm(AbortSignal.timeout(30_000)),
        passFor(second, { source, repository }).arm(AbortSignal.timeout(30_000)),
      ]);
      for (const result of restarted) expect(onlyArm(result).status).toBe('armed');
      expect(await readFile(firstFile, 'utf8')).toBe(firstRecord);
      expect(await readFile(secondFile, 'utf8')).toBe(secondRecord);
      for (const fixture of [first, second]) {
        expect(
          (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
        ).toHaveLength(1);
      }
    },
  );

  it.each(['arm', 'run'] as const)(
    'refuses unidentified legacy completion evidence before %s',
    async (phase) => {
      const fixture = await createFixture({ evidenceDir: false });
      const legacy = path.join(fixture.workDir, 'completion-logs', ISSUE_ID);
      await mkdir(legacy, { recursive: true });
      const file = path.join(legacy, 'completion-armed-head.json');
      const contents = JSON.stringify({
        head: OTHER_HEAD,
        number: 29,
        waitingSince: '2020-01-01T00:00:00.000Z',
      });
      await writeFile(file, contents);
      const outcomes = await passFor(fixture)[phase](AbortSignal.timeout(30_000));
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.status).toBe('attention');
      expect(outcomes[0]?.detail).toContain(legacy);
      expect(outcomes[0]?.detail).toContain('records no source or repository identity');
      expect(await readFile(file, 'utf8')).toBe(contents);
      expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
      expect(transitions(fixture)).toEqual([]);
      expect(commentTexts(fixture)).toEqual([]);
    },
  );

  it.each([
    ['merge-uncertain', false],
    ['merge-uncertain', true],
    ['view-after-arm', false],
  ])('recovers a native merge after %s (repair: %s)', async (fail, repair) => {
    const fixture = await createFixture({ runs: [] });
    const head = repair ? OTHER_HEAD : HEAD;
    if (repair) {
      expect(onlyArm(await passFor(fixture).arm(AbortSignal.timeout(30_000))).status).toBe('armed');
      await writeFile(
        fixture.gh.pullRequestsFile,
        `${JSON.stringify({ ...ONE_PULL_REQUEST, headRefOid: head, autoMergeRequest: null })}\n`,
      );
      await writeFile(
        fixture.gh.reviewsFile,
        JSON.stringify([{ ...APPROVED_REVIEW, commitId: head }]),
      );
      await writeFile(
        fixture.gh.checksFile,
        JSON.stringify([{ ...LENS_CHECK_PASSED, headSha: head }]),
      );
    }

    const failed = onlyArm(
      await passFor(fixture, { fail, mergeOnArm: MERGE_COMMIT }).arm(AbortSignal.timeout(30_000)),
    );
    expect(failed.status, failed.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
    expect(
      JSON.parse(await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8')),
    ).toMatchObject({ head, number: 29, waitingSince: null });

    // GitHub accepted the request and merged, but neither a lost mutation
    // response nor a failed verification read acknowledged the arm locally.
    // A fresh pass must recover by number and still wait for post-merge CI.
    expect(onlyArm(await passFor(fixture).arm(AbortSignal.timeout(30_000))).status).toBe(
      'observed',
    );
    const pending = only(await runPass(fixture, { clockStepMs: 1_000 }));
    expect(pending.status, pending.detail).toBe('pending');
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
    await writeFile(fixture.gh.runsFile, `${JSON.stringify(workflowRun())}\n`);
    const done = only(await runPass(fixture, { clockStepMs: 1_000 }));
    expect(done.status, done.detail).toBe('done');
    expect(done.mergeCommit).toBe(MERGE_COMMIT);
    await runPass(fixture);
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect((await fakeCompletionCalls(fixture.gh)).filter((c) => c.op === 'merge')).toHaveLength(
      repair ? 2 : 1,
    );
  });

  it('does not request auto-merge when its admission cannot be persisted', async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.logsDir, 'completion-armed-head.json'));
    const outcome = onlyArm(await passFor(fixture).arm(AbortSignal.timeout(30_000)));
    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('record could not be written');
    expect((await fakeCompletionCalls(fixture.gh)).filter((c) => c.op === 'merge')).toHaveLength(0);
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('arms while the final required check is pending, then the green gate uses that arm', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      // CI is already green; the reviewer has not published the Lens check, so
      // the pull request is not yet clean and GitHub can accept the arm.
      checks: [{ name: 'validate', state: 'SUCCESS', link: WORKFLOW_URL }],
      reviews: [],
      runs: [],
    });
    const options = {
      rejectArmWhenClean: true,
      requiredChecks: ['validate', 'Nexus Lens'],
      clockStepMs: 1_000,
    };

    const armed = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(armed.status, armed.detail).toBe('armed');
    expect(armed.head).toBe(HEAD);
    expect(armed.number).toBe(29);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
    const record = JSON.parse(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { head?: string; number?: number; waitingSince?: string | null };
    // Arming is not yet waiting for the merge: the reviewer has not run, and
    // the merge deadline must not start until completion sees a pending merge.
    expect(record).toMatchObject({ head: HEAD, number: 29, waitingSince: null });

    // The review phase now publishes the final required check. The old
    // completion ordering would arm here and be refused with "clean status";
    // this pass verifies the recorded arm instead.
    await writeFile(fixture.gh.reviewsFile, `${JSON.stringify([APPROVED_REVIEW])}\n`, 'utf8');
    await writeFile(
      fixture.gh.checksFile,
      `${JSON.stringify([
        { name: 'validate', state: 'SUCCESS', link: WORKFLOW_URL },
        LENS_CHECK_PASSED,
      ])}\n`,
      'utf8',
    );

    const pending = only(await passFor(fixture, options).run(AbortSignal.timeout(30_000)));
    expect(pending.status, pending.detail).toBe('pending');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
    const waited = JSON.parse(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { waitingSince?: string | null };
    expect(typeof waited.waitingSince).toBe('string');

    // GitHub merges natively. A restarted pass verifies that merge and its
    // post-merge workflow and writes the one resolution comment exactly once.
    await writeFile(
      fixture.gh.pullRequestsFile,
      `${JSON.stringify(mergedPullRequest())}\n`,
      'utf8',
    );
    await writeFile(fixture.gh.runsFile, `${JSON.stringify(workflowRun())}\n`, 'utf8');
    const done = only(await passFor(fixture, options).run(AbortSignal.timeout(30_000)));
    expect(done.status, done.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);

    const restarted = only(await passFor(fixture, options).run(AbortSignal.timeout(30_000)));
    expect(restarted.status).toBe('observed');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
  });

  it("re-arms and re-records a repair's new head, without a duplicate on restart", async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      checks: [{ name: 'validate', state: 'PENDING', link: WORKFLOW_URL }],
      reviews: [],
      runs: [],
    });
    const options = {
      rejectArmWhenClean: true,
      requiredChecks: ['validate', 'Nexus Lens'],
      clockStepMs: 1_000,
    };

    const first = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(first).toMatchObject({ status: 'armed', head: HEAD, number: 29 });

    // The repair pushed a new head and GitHub no longer holds the old arm.
    await writeFile(
      fixture.gh.pullRequestsFile,
      `${JSON.stringify({ ...ONE_PULL_REQUEST, headRefOid: OTHER_HEAD, autoMergeRequest: null })}\n`,
      'utf8',
    );

    const repaired = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(repaired).toMatchObject({ status: 'armed', head: OTHER_HEAD, number: 29 });
    const record = JSON.parse(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { head?: string; number?: number };
    expect(record).toMatchObject({ head: OTHER_HEAD, number: 29 });
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(2);

    // A restart against the armed repaired head is a verified no-op.
    const restarted = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(restarted).toMatchObject({ status: 'armed', head: OTHER_HEAD, number: 29 });
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(2);

    // GitHub can keep the request enabled across another head. The new head is
    // verified and re-recorded without a second mutation.
    await writeFile(
      fixture.gh.pullRequestsFile,
      `${JSON.stringify({
        ...ONE_PULL_REQUEST,
        headRefOid: THIRD_HEAD,
        autoMergeRequest: { enabledAt: '2026-09-20T12:05:00Z' },
      })}\n`,
      'utf8',
    );
    const carried = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(carried).toMatchObject({ status: 'armed', head: THIRD_HEAD, number: 29 });
    const carriedRecord = JSON.parse(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { head?: string; number?: number };
    expect(carriedRecord).toMatchObject({ head: THIRD_HEAD, number: 29 });
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(2);
  });

  it('keeps a clean pull request In Review with actionable evidence instead of assuming a merge', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      reviews: [APPROVED_REVIEW],
      checks: [{ name: 'validate', state: 'SUCCESS', link: WORKFLOW_URL }, LENS_CHECK_PASSED],
      runs: [],
    });

    const outcome = only(
      await runPass(fixture, {
        rejectArmWhenClean: true,
        requiredChecks: ['validate', 'Nexus Lens'],
        clockStepMs: 1_000,
      }),
    );

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('clean status');
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('clean status');
    expect(commentTexts(fixture)[0]).toContain(PR_URL);
    // The one attempted request was refused; nothing was merged.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
    expect(await readFile(fixture.gh.pullRequestsFile, 'utf8')).toContain('"state":"OPEN"');
  });

  it('returns an armed repair to To Do when the current-head Lens result requests changes', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      reviews: [
        { ...APPROVED_REVIEW, state: 'CHANGES_REQUESTED', body: 'Fix the ownership race.' },
      ],
      checks: [
        {
          name: 'Nexus Lens',
          state: 'FAILURE',
          conclusion: 'FAILURE',
          link: LENS_CHECK_URL,
          reviewUrl: REVIEW_URL,
        },
      ],
      runs: [],
    });
    const options = {
      rejectArmWhenClean: true,
      requiredChecks: ['validate', 'Nexus Lens'],
      clockStepMs: 1_000,
    };

    // The queue's arm step runs before the review publishes the failing check.
    const armed = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(armed).toMatchObject({ status: 'armed', head: HEAD, number: 29 });

    // The completion pass reads the armed record, sees the failed Lens verdict,
    // and returns the ticket to To Do with its workspace pointer untouched.
    const outcome = only(await passFor(fixture, options).run(AbortSignal.timeout(30_000)));
    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(fixture.jira.labels).toContain(WORKSPACE_POINTER);
    expect(transitions(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('ownership race');
    // The failed required check is what stops the native merge; the harness
    // never performs the merge itself.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The summary the coordinator and the CLI report
// ---------------------------------------------------------------------------

describe('the completion summary', () => {
  it('counts what each item ended as and prints it', async () => {
    const fixture = await createFixture({ merged: true });
    const lines: string[] = [];
    const run = createCompletionRun(passFor(fixture), {
      out: (text) => lines.push(text),
      err: (text) => lines.push(text),
    });

    const summary = await run.run(AbortSignal.timeout(30_000));

    expect(summary).toEqual({ done: 1, toDo: 0, attention: 0, observed: 0, problem: null });
    expect(lines.join('\n')).toContain(`${ISSUE_KEY}: completed`);
  });

  it('reports a discovery failure as a problem without throwing', async () => {
    const fixture = await createFixture({});
    fixture.jira.readFailure = true;
    const run = createCompletionRun(passFor(fixture), {
      out: () => undefined,
      err: () => undefined,
    });

    const summary = await run.run(AbortSignal.timeout(30_000));

    expect(summary.problem).toContain('HTTP 503');
    expect(summary.done).toBe(0);
  });
});
