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

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { createGitHubCompletion } from '../../src/delivery/completion.js';
import { completionLogsDir, createCompletionPass } from '../../src/sources/completion.js';
import type { ArmOutcome, CompletionOutcome } from '../../src/sources/completion.js';
import { createHttpClient } from '../../src/sources/jira/http.js';
import { createJiraCompletionSource } from '../../src/sources/jira/completion.js';
import type { CompletionConfig, JiraSourceConfig } from '../../src/shared/types.js';
import { installFakeGhCompletion } from './local-target.js';
import type { FakeCompletionState } from './local-target.js';
import { combineStop, ownFixtureOperation } from './lifecycle.js';
import { createTempDir } from '../support.js';

/**
 * The bound one case states for itself when it makes two or more complete passes
 * — or arm calls — over the real command boundary: two fixtures' own `gh`
 * invocations, the polls between them, and the reads the pass makes on each
 * side. It is that case's own work, not a layer-wide deadline: every case that
 * makes a single pass keeps the default five seconds, and the layer's cap is a
 * scheduling policy that no case asserts on. `notes/test-layers.md` records the
 * rule and the budget it belongs to.
 */
export const TWO_PASSES_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// The configuration and the GitHub state the tests drive
// ---------------------------------------------------------------------------

export const CLOUD_ID = '9337c4da-7d33-4c1d-b03c-db207e537f88';
export const SITE = 'https://example.atlassian.net';
export const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;
export const JIRA_TOKEN = 'service-account-token-value';
export const REVIEWER_TOKEN = 'nexus-lens-reviewer-token';
export const OPERATOR_TOKEN = 'operator-github-token';
export const REPOSITORY = 'saintiago/nexus-harness';
export const BASE_BRANCH = 'main';
export const WORKSPACE_ID = 'run-20260101000000-abcdef01';
export const WORKSPACE_POINTER = `harness-ws-${WORKSPACE_ID}`;
export const BRANCH = `harness/${WORKSPACE_ID}`;
export const ISSUE_ID = '10011';
export const ISSUE_KEY = 'HARN-15';
export const HEAD = 'a'.repeat(40);
export const OTHER_HEAD = 'b'.repeat(40);
export const MERGE_COMMIT = 'c'.repeat(40);
export const THIRD_HEAD = 'd'.repeat(40);
export const PR_URL = `https://github.com/${REPOSITORY}/pull/29`;
export const REVIEW_URL = `${PR_URL}#pullrequestreview-555`;
export const LENS_CHECK_URL = 'https://github.com/saintiago/nexus-harness/runs/9001';
export const WORKFLOW_URL = 'https://github.com/saintiago/nexus-harness/actions/runs/4242';

export const COMPLETION: CompletionConfig = {
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

export const SOURCE: JiraSourceConfig = {
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

export const ONE_PULL_REQUEST = {
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

export const APPROVED_REVIEW = {
  id: 555,
  url: REVIEW_URL,
  author: { login: 'nexus-lens' },
  state: 'APPROVED',
  body: 'Reviewed the change: the fixture ownership check is correct.',
  commitId: HEAD,
};

export const LENS_CHECK_PASSED = {
  name: 'Nexus Lens',
  state: 'SUCCESS',
  conclusion: 'SUCCESS',
  link: LENS_CHECK_URL,
};

export function workflowRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
export function mergedPullRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** One comment Jira holds on the issue. */
export interface HeldComment {
  readonly id: string;
  readonly createdAt: string;
  readonly body: unknown;
  readonly text: string;
}

/** What the fake Jira site holds, and every request it received. */
export interface FakeJira {
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
export function adfParagraphs(paragraphs: readonly string[]): Record<string, unknown> {
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
export function textOfAdf(value: unknown): string {
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

export function issueBody(state: FakeJira): Record<string, unknown> {
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

export function fakeJira(): FakeJira {
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

export interface Fixture {
  readonly parent: string;
  readonly workDir: string;
  readonly logsDir: string;
  readonly gh: FakeCompletionState;
  readonly jira: FakeJira;
  readonly config: CompletionConfig;
}

export interface FixtureOptions {
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

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
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

/**
 * The completion pass one fixture describes, with a stand-in clock.
 *
 * The pass is wrapped in the fixture lifecycle: each `run` and `arm` is owned
 * work of the test that asked for it, it takes the test's own stop alongside
 * whatever bound the caller gave it, and disposal waits for it (bounded) after
 * stopping the command trees it started. A production command invocation is
 * therefore never still running when the fixture directory it writes into is
 * removed, and a continuation that outlives its test cannot start one.
 */
export function passFor(
  fixture: Fixture,
  parts: {
    readonly source?: JiraSourceConfig;
    readonly repository?: string;
    readonly reader?: (stop: AbortSignal) => Promise<string>;
    readonly fail?: string;
    readonly mergeOnArm?: string;
    /** The merge GitHub performs while the auto-merge request is in flight. */
    readonly mergeBeforeArm?: string;
    /** The `pr view` read whose answer is the merge GitHub performs between reads. */
    readonly mergeOnView?: number;
    readonly mergeOnViewSha?: string;
    /** Whether the stand-in GitHub refuses to arm a pull request with green required checks. */
    readonly rejectArmWhenClean?: boolean;
    /** The required check names the stand-in GitHub uses to decide whether a head is clean. */
    readonly requiredChecks?: readonly string[];
    readonly reviewsUnknown?: boolean;
    readonly clockStepMs?: number;
    /** Where this pass's clock starts, so several passes can be ordered in time. */
    readonly clockStartMs?: number;
    /** How long one stand-in `gh` command may run before the harness stops it. */
    readonly commandTimeoutMs?: number;
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
      ...(parts.mergeBeforeArm === undefined ? {} : { mergeBeforeArm: parts.mergeBeforeArm }),
      ...(parts.mergeOnView === undefined ? {} : { mergeOnView: parts.mergeOnView }),
      ...(parts.mergeOnViewSha === undefined ? {} : { mergeOnViewSha: parts.mergeOnViewSha }),
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
    ...(parts.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: parts.commandTimeoutMs }),
  });
  const io = { out: () => undefined, err: () => undefined };
  const pass = createCompletionPass({
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
  const wrapper: {
    run: (stop: AbortSignal) => Promise<readonly CompletionOutcome[]>;
    arm: (stop: AbortSignal) => Promise<readonly ArmOutcome[]>;
  } = {
    run: async (stop: AbortSignal) =>
      await ownFixtureOperation(
        'a completion pass',
        async (own) => await pass.run(combineStop(own, stop)),
      ),
    arm: async (stop: AbortSignal) =>
      await ownFixtureOperation(
        'the arm step',
        async (own) => await pass.arm(combineStop(own, stop)),
      ),
  };
  return wrapper;
}

export async function runPass(
  fixture: Fixture,
  parts: Parameters<typeof passFor>[1] = {},
): Promise<readonly CompletionOutcome[]> {
  return await passFor(fixture, parts).run(AbortSignal.timeout(30_000));
}

/** The single outcome one pass is expected to have produced. */
export function only(outcomes: readonly CompletionOutcome[]): CompletionOutcome {
  expect(outcomes).toHaveLength(1);
  const [first] = outcomes;
  if (first === undefined) {
    throw new Error('the pass produced no outcome');
  }
  return first;
}

/** The single arm outcome one pass is expected to have produced. */
export function onlyArm(outcomes: readonly ArmOutcome[]): ArmOutcome {
  expect(outcomes).toHaveLength(1);
  const [first] = outcomes;
  if (first === undefined) {
    throw new Error('the arm step produced no outcome');
  }
  return first;
}

/** The comment bodies the fake Jira holds, as flat text. */
export function commentTexts(fixture: Fixture): readonly string[] {
  return fixture.jira.comments.map((comment) => comment.text);
}

/** The transitions the fake Jira was asked to make, in order. */
export function transitions(fixture: Fixture): readonly string[] {
  return fixture.jira.calls
    .filter((call) => call.method === 'POST' && call.url.endsWith('/transitions'))
    .map((call) => String((call.body as { transition?: { id?: string } })?.transition?.id ?? ''));
}

// ---------------------------------------------------------------------------
// The path itself
// ---------------------------------------------------------------------------
