/**
 * The Nexus Lens review path: the reviewer's verdict, the pull request it
 * belongs to, and what one scan publishes.
 *
 * The scan tests drive the real coordinator with a fake queue, a fake
 * repository, a fake repository-view source, and a fake reviewer turn, so
 * eligibility, deduplication, stale results, failures, and limits are asserted
 * from what really happened: which calls arrived in which order, and which
 * native review and check were published. The last block is the whole path
 * through the CLI: the real Jira connector and the real GitHub App client
 * against a fake HTTP boundary, the Git-backed repository view against a real
 * retained workspace, the real Codex adapter against the stand-in runtime, and
 * a real generated RSA key — nothing there contacts a network, and the key is a
 * disposable test key.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_INPUT_ERROR, EXIT_OK } from '../src/cli/context.js';
import type { CliContext, InterruptSignals } from '../src/cli/context.js';
import { loadConfiguration } from '../src/config/load.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../src/config/paths.js';
import type {
  AppCheckRun,
  OpenPullRequest,
  PullRequestReview,
  ReviewEvidence,
  ReviewQueue,
  ReviewRepository,
  ReviewerTurn,
  ReviewScanContext,
  ReviewVerdict,
  ReviewView,
  ReviewViewSource,
  PublishedCheck,
  PublishedReview,
} from '../src/reviews/contract.js';
import { ReviewError } from '../src/reviews/contract.js';
import { diffPosition, positionFindings } from '../src/reviews/diff.js';
import { appJwt, resolveAppPrivateKey } from '../src/reviews/github.js';
import { parseVerdict, reviewPrompt } from '../src/reviews/reviewer.js';
import { allocateReviewDirectory, scanReviews, watchReviews } from '../src/reviews/scan.js';
import {
  REVIEW_VIEW_DIRECTORY,
  prepareReviewView,
  reviewViewProblem,
} from '../src/reviews/view.js';
import { SourceError } from '../src/sources/contract.js';
import type { SourceCandidate, SourceTask } from '../src/sources/contract.js';
import { receiptFilePath, reserveReceipt } from '../src/sources/receipts.js';
import type { SourceRef, Task } from '../src/shared/types.js';
import { canonicalPath } from '../src/workspace/git.js';
import { sourceItemFor, workspaceStatePath } from '../src/workspace/state.js';
import type { WorkspaceState } from '../src/workspace/state.js';
import { fakeEvents, fakeTurns, git, installFakeRuntime } from './fixtures/local-target.js';
import type { FakePlan, FakeState } from './fixtures/local-target.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedHarnessConfig,
  documentedProjectConfig,
  fakeConsole,
  screenAfter,
  writeJsonFile,
} from './support.js';

afterEach(async () => {
  await cleanupTempDirectories();
});

const SCOPE = 'https://example.atlassian.net';
const REPOSITORY = 'example-owner/example-repo';
const LOGIN = 'nexus-lens[bot]';
const CHECK_NAME = 'Nexus Lens review';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const WORKSPACE_ID = 'run-20260919100148-e48a9ab0';
/** The one pointer label the fixtures use to name the ticket's workspace. */
const WORKSPACE_LABEL = `harness-ws-${WORKSPACE_ID}`;
const BRANCH = `harness/${WORKSPACE_ID}`;

function refFor(key = 'HARN-3', id = '10003'): SourceRef {
  return {
    type: 'jira',
    scope: SCOPE,
    id,
    key,
    url: `${SCOPE}/browse/${key}`,
    updatedAt: '2026-09-19T12:00:00.000Z',
  };
}

function taskFor(key = 'HARN-3'): Task {
  return {
    id: key,
    title: 'Add the greeting feature',
    description: 'Implement the greeting the ticket describes.',
    acceptanceCriteria: ['The greeting is implemented.', 'The tests cover it.'],
  };
}

function candidateFor(key = 'HARN-3'): SourceCandidate {
  return { ref: refFor(key), title: taskFor(key).title };
}

function preparedFor(
  key = 'HARN-3',
  pointers: readonly string[] = ['run-20260919100148-e48a9ab0'],
): SourceTask {
  return { ref: refFor(key), task: taskFor(key), pointers };
}

/** The ownership record intake leaves beside a retained workspace. */
async function writeReviewLedger(
  workDir: string,
  overrides: Partial<WorkspaceState> = {},
): Promise<void> {
  const state: WorkspaceState = {
    version: 1,
    workspaceId: WORKSPACE_ID,
    sourceRoot: canonicalPath(path.dirname(workDir)),
    baseCommit: BASE,
    branch: BRANCH,
    createdAt: '2026-09-19T12:00:00.000Z',
    sourceItem: sourceItemFor(refFor()),
    attempts: [],
    ...overrides,
  };
  await mkdir(path.join(workDir, 'workspaces', WORKSPACE_ID), { recursive: true });
  await writeFile(workspaceStatePath(workDir, WORKSPACE_ID), JSON.stringify(state), 'utf8');
}

function pullFor(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    number: 27,
    url: `https://github.com/${REPOSITORY}/pull/27`,
    title: 'HARN-3: Add the greeting feature',
    headSha: HEAD,
    headBranch: BRANCH,
    baseBranch: 'main',
    baseSha: BASE,
    draft: false,
    author: 'example-owner',
    ...overrides,
  };
}

/** The one file patch every evidence fixture carries. */
const PATCH = [
  '@@ -0,0 +1,3 @@',
  '+export function greetAll(names) {',
  '+  return names;',
  '+}',
].join('\n');

function evidenceFor(pullRequest: OpenPullRequest = pullFor()): ReviewEvidence {
  return {
    ref: refFor(),
    task: taskFor(),
    pullRequest,
    files: [
      { path: 'src/greet-all.mjs', patch: PATCH, additions: 3, deletions: 0 },
      { path: 'src/greet.mjs', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 },
    ],
    truncated: false,
    checks: [{ name: 'validate', status: 'completed', conclusion: 'success' }],
    combinedStatus: 'success',
    fetchedAt: '2026-09-19T12:00:00.000Z',
  };
}

/** The repository view one review of the fixtures inspects. */
function viewFor(dir = '/evidence/review-20260919120000-12345678'): ReviewView {
  return { path: path.join(dir, REVIEW_VIEW_DIRECTORY), head: HEAD, base: BASE };
}

const APPROVE: ReviewVerdict = {
  decision: 'approve',
  summary: 'The change implements the ticket and its tests.',
  findings: [],
};

const REQUEST_CHANGES: ReviewVerdict = {
  decision: 'request_changes',
  summary: 'The feature is incomplete.',
  findings: [
    { path: 'src/greet-all.mjs', line: 1, body: 'The exported function ignores the names.' },
    { path: 'src/other.mjs', line: 2, body: 'This file was not part of the change.' },
  ],
};

/** A verdict as the reviewer's file carries it: `verdict` is its own word. */
function verdictFile(verdict: ReviewVerdict): string {
  return JSON.stringify({
    verdict: verdict.decision,
    summary: verdict.summary,
    findings: verdict.findings,
  });
}

// ---------------------------------------------------------------------------
// The diff and the verdict
// ---------------------------------------------------------------------------

describe('the reviewer evidence', () => {
  it('positions a finding on a line the patch really shows', () => {
    expect(diffPosition(PATCH, 1)).toBe(1);
    expect(diffPosition(PATCH, 3)).toBe(3);
    // A line the patch does not show has no position: it stays a body finding.
    expect(diffPosition(PATCH, 9)).toBeNull();
    expect(diffPosition('@@ -1 +1 @@', 5)).toBeNull();
  });

  it('positions what it can and keeps every other finding for the body', () => {
    const positioned = positionFindings(REQUEST_CHANGES.findings, evidenceFor().files);
    expect(positioned.comments).toEqual([
      { path: 'src/greet-all.mjs', position: 1, body: 'The exported function ignores the names.' },
    ]);
    expect(positioned.unpositioned).toEqual([
      { path: 'src/other.mjs', line: 2, body: 'This file was not part of the change.' },
    ]);
  });

  it('counts deletions, later hunk headers and newline markers without resetting positions', () => {
    const patch = [
      '@@ -3,2 +3,2 @@',
      ' context',
      '-old',
      '+new',
      '@@ -20 +20,2 @@',
      '-before',
      '+after',
      '+last',
      '\\ No newline at end of file',
    ].join('\n');
    expect(diffPosition(patch, 3)).toBe(1);
    expect(diffPosition(patch, 4)).toBe(3);
    expect(diffPosition(patch, 20)).toBe(6);
    expect(diffPosition(patch, 21)).toBe(7);
    expect(diffPosition(patch, 22)).toBeNull();
    expect(diffPosition('@@ -1 +1 @@\n-old\n+new\n', 1)).toBe(2);
  });

  it('accepts an explicit evidence-unavailable result and refuses contradictory approvals', () => {
    expect(
      parseVerdict(
        JSON.stringify({
          verdict: 'inconclusive',
          summary: 'Need the caller source.',
          findings: [],
        }),
        'v',
      ),
    ).toMatchObject({ decision: 'inconclusive', summary: 'Need the caller source.' });
    expect(() =>
      parseVerdict(JSON.stringify({ verdict: 'approve', summary: 'Fine.' }), 'v'),
    ).toThrow(/not a list/);
    expect(() =>
      parseVerdict(verdictFile({ ...APPROVE, findings: REQUEST_CHANGES.findings }), 'v'),
    ).toThrow(/blocking findings/);
  });

  it('positions nothing from a patch GitHub could not report completely', () => {
    // A binary or oversized file has no patch, and a patch whose line counts
    // disagree with GitHub's own change counts is equally unusable as a
    // position: both findings are reported in the review body instead.
    for (const files of [
      [{ path: 'image.png', patch: null, additions: 0, deletions: 0 }],
      [{ path: 'src/greet-all.mjs', patch: PATCH, additions: 4, deletions: 0 }],
    ]) {
      const positioned = positionFindings(
        [{ path: files[0]?.path ?? '', line: 1, body: 'Something is wrong here.' }],
        files,
      );
      expect(positioned.comments).toEqual([]);
      expect(positioned.unpositioned).toHaveLength(1);
    }
  });

  it('validates the reviewer verdict by name', () => {
    expect(parseVerdict(verdictFile(APPROVE), 'verdict.json')).toEqual(APPROVE);
    expect(parseVerdict(verdictFile(REQUEST_CHANGES), 'verdict.json')).toEqual(REQUEST_CHANGES);
    // Findings are blocking; a request for changes must name a reason.
    expect(() =>
      parseVerdict(
        JSON.stringify({ verdict: 'request_changes', summary: 'No.', findings: [] }),
        'verdict.json',
      ),
    ).toThrow(/names no finding/);
    expect(() => parseVerdict('{not json', 'verdict.json')).toThrow(/not valid JSON/);
    expect(() => parseVerdict(JSON.stringify({ verdict: 'maybe', summary: 'x' }), 'v')).toThrow(
      /instead of "approve" or "request_changes"/,
    );
    expect(() => parseVerdict(JSON.stringify({ verdict: 'approve', summary: '  ' }), 'v')).toThrow(
      /no "summary"/,
    );
  });

  it('tells the reviewer the ticket, its view and the CI, without carrying the change', () => {
    const view = viewFor('/tmp/reviews/review-20260919120000-12345678');
    const prompt = reviewPrompt(evidenceFor(), view, '/tmp/reviews/review-20260919120000-12345678');
    expect(prompt).toContain('HARN-3');
    expect(prompt).toContain(`${SCOPE}/browse/HARN-3`);
    expect(prompt).toContain('The greeting is implemented.');
    // The change itself is not in the prompt: it is in the pinned view, and the
    // prompt names that view, its head and the base the diff starts from.
    expect(prompt).toContain('repo');
    expect(prompt).toContain(view.head);
    expect(prompt).toContain(view.base);
    expect(prompt).toContain(`Head: ${BRANCH} at ${HEAD}`);
    expect(prompt).toContain(`Base: main at ${BASE}`);
    expect(prompt).toContain(`git -C . diff ${BASE}...${HEAD}`);
    expect(prompt).toContain('AGENTS.md');
    expect(prompt).not.toContain('+export function greetAll(names) {');
    expect(prompt).toContain('validate: completed/success');
    expect(prompt).toContain('Combined commit status: success');
    expect(prompt).toContain('Do not change the repository view');
    expect(prompt).toContain('verdict.json');
    expect(prompt).toContain(`At most 20 findings`);
  });
});

// ---------------------------------------------------------------------------
// A scan around the real coordinator
// ---------------------------------------------------------------------------

interface RecordedCalls {
  readonly findPullRequests: string[];
  readonly reviews: number[];
  readonly checks: string[];
  readonly evidence: number;
  readonly readPullRequests: number;
  readonly publishedReviews: Array<Parameters<ReviewRepository['publishReview']>[0]>;
  readonly publishedChecks: Array<Parameters<ReviewRepository['publishCheck']>[0]>;
}

interface FakeRepositoryOptions {
  readonly evidence?: Partial<ReviewEvidence>;
  readonly pullRequest?: OpenPullRequest | null;
  readonly reviews?: readonly PullRequestReview[];
  readonly checks?: readonly AppCheckRun[];
  readonly findError?: ReviewError;
  readonly evidenceError?: ReviewError;
  readonly readPullRequestError?: Error;
  readonly publishReviewError?: ReviewError;
  readonly publishCheckError?: ReviewError;
  /** The head the pull request carries when it is re-read before publishing. */
  readonly headAfterReview?: string;
  /** Whether the pull request is still open when it is re-read before publishing. */
  readonly openAfterReview?: boolean;
}

interface FakeRepository {
  readonly repository: ReviewRepository;
  readonly calls: RecordedCalls;
}

function fakeRepository(options: FakeRepositoryOptions = {}): FakeRepository {
  const calls: {
    findPullRequests: string[];
    reviews: number[];
    checks: string[];
    evidence: number;
    readPullRequests: number;
    publishedReviews: Array<Parameters<ReviewRepository['publishReview']>[0]>;
    publishedChecks: Array<Parameters<ReviewRepository['publishCheck']>[0]>;
  } = {
    findPullRequests: [],
    reviews: [],
    checks: [],
    evidence: 0,
    readPullRequests: 0,
    publishedReviews: [],
    publishedChecks: [],
  };
  const pullRequest = options.pullRequest === undefined ? pullFor() : options.pullRequest;

  const repository: ReviewRepository = {
    findOpenPullRequest: async (branch) => {
      calls.findPullRequests.push(branch);
      if (options.findError !== undefined) {
        throw options.findError;
      }
      return pullRequest;
    },
    readPullRequest: async () => {
      calls.readPullRequests += 1;
      if (options.readPullRequestError !== undefined) {
        throw options.readPullRequestError;
      }
      if (pullRequest === null) {
        return null;
      }
      if (options.openAfterReview === false) {
        return null;
      }
      return { ...pullRequest, headSha: options.headAfterReview ?? pullRequest.headSha };
    },
    listReviews: async (number) => {
      calls.reviews.push(number);
      return options.reviews ?? [];
    },
    readEvidence: async (request) => {
      calls.evidence += 1;
      if (options.evidenceError !== undefined) {
        throw options.evidenceError;
      }
      return {
        ...evidenceFor(request.pullRequest),
        ...options.evidence,
        ref: request.ref,
        task: request.task,
      };
    },
    publishReview: async (request): Promise<PublishedReview> => {
      if (options.publishReviewError !== undefined) {
        throw options.publishReviewError;
      }
      calls.publishedReviews.push(request);
      return {
        id: 5256006204,
        url: `${request.pullRequest.url}#review`,
        state: request.decision === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED',
      };
    },
    publishCheck: async (request): Promise<PublishedCheck> => {
      if (options.publishCheckError !== undefined) {
        throw options.publishCheckError;
      }
      calls.publishedChecks.push(request);
      return {
        id: 105912854704,
        url: `https://github.com/${REPOSITORY}/runs/105912854704`,
        conclusion: request.decision === 'approve' ? 'success' : 'failure',
      };
    },
    reviewChecks: async (head) => {
      calls.checks.push(head);
      return options.checks ?? [];
    },
  };
  return { repository, calls };
}

interface ScanFixture {
  readonly context: ReviewScanContext;
  readonly output: string[];
  readonly errors: string[];
  readonly workDir: string;
  readonly reviewerRuns: ReviewEvidence[];
  readonly views: FakeViews;
}

/** What a fake view source recorded, and the problem it reports, if any. */
interface FakeViews {
  readonly source: ReviewViewSource;
  readonly prepared: Array<{ readonly dir: string; readonly workspacePath: string }>;
  /** How many times the scan checked the view after a turn. */
  readonly checks: { count: number };
}

/**
 * The scan's repository-view boundary as a test double: it prepares a view the
 * way the Git-backed one does (a path inside the review's evidence directory,
 * pinned at the head it was asked for) and reports the problem a test planted,
 * or none. The real Git-backed source has its own tests below and the whole
 * path is exercised again through the CLI.
 */
function fakeViews(
  options: { readonly prepareError?: ReviewError; readonly problem?: string } = {},
): FakeViews {
  const prepared: Array<{ readonly dir: string; readonly workspacePath: string }> = [];
  const checks = { count: 0 };
  const source: ReviewViewSource = {
    prepare: async (request) => {
      prepared.push({ dir: request.dir, workspacePath: request.workspacePath });
      if (options.prepareError !== undefined) {
        throw options.prepareError;
      }
      return {
        path: path.join(request.dir, REVIEW_VIEW_DIRECTORY),
        head: request.head,
        base: request.base,
      };
    },
    problem: async () => {
      checks.count += 1;
      return options.problem ?? null;
    },
  };
  return { source, prepared, checks };
}

async function scanFixture(
  options: {
    readonly repository?: FakeRepository;
    readonly reviewer?: ReviewerTurn;
    readonly views?: FakeViews;
    readonly items?: readonly SourceTask[];
    readonly candidates?: readonly SourceCandidate[];
    readonly prepare?: (
      candidate: SourceCandidate,
      call: number,
    ) => Promise<SourceTask | null> | SourceTask | null;
    readonly stop?: AbortSignal;
  } = {},
): Promise<ScanFixture> {
  const workDir = await createTempDir();
  await writeReviewLedger(workDir);
  const output: string[] = [];
  const errors: string[] = [];
  const reviewerRuns: ReviewEvidence[] = [];
  const repository = options.repository ?? fakeRepository();
  const views = options.views ?? fakeViews();
  const items = options.items ?? [preparedFor()];
  const candidates = options.candidates ?? [candidateFor()];
  let prepared = 0;

  const queue: ReviewQueue = {
    list: async () => candidates,
    prepare: async (candidate) => {
      prepared += 1;
      if (options.prepare !== undefined) {
        return await options.prepare(candidate, prepared);
      }
      return items.find((item) => item.ref.id === candidate.ref.id) ?? null;
    },
  };

  const reviewer: ReviewerTurn =
    options.reviewer ??
    (async (request) => {
      reviewerRuns.push(request.evidence);
      return {
        summary: 'approved',
        verdict: APPROVE,
        problem: null,
        logPath: path.join(request.dir, 'reviewer.log'),
      };
    });

  const context: ReviewScanContext = {
    queue,
    repository: repository.repository,
    reviewer,
    views: views.source,
    workDir,
    sourceRoot: canonicalPath(path.dirname(workDir)),
    login: LOGIN,
    checkName: CHECK_NAME,
    reviewerTimeoutMs: 60_000,
    io: {
      out: (text) => output.push(text),
      err: (text) => errors.push(text),
    },
    stop: options.stop ?? new AbortController().signal,
    now: () => new Date('2026-09-19T12:00:00.000Z'),
    sleep: async () => undefined,
  };
  return { context, output, errors, workDir, reviewerRuns, views };
}

/** The one review directory a scan left, when it left one. */
async function reviewDirectories(workDir: string): Promise<string[]> {
  const root = path.join(workDir, 'reviews');
  if (!existsSync(root)) {
    return [];
  }
  return (await readdir(root)).filter((name) => name.startsWith('review-'));
}

describe('one review scan', () => {
  it.each([
    { label: 'immutable issue id', sourceItem: { ...sourceItemFor(refFor()), id: '99999' } },
    { label: 'site', sourceItem: { ...sourceItemFor(refFor()), scope: 'https://other.test' } },
    { label: 'source type', sourceItem: { ...sourceItemFor(refFor()), type: 'other' } },
    { label: 'missing identity', sourceItem: null },
  ])('refuses a ledger with a different $label before using its PR', async ({ sourceItem }) => {
    // Even a native approval on this other workspace must not become this
    // ticket's successful check through the no-turn reconciliation path.
    const repository = fakeRepository({
      reviews: [{ id: 1, login: LOGIN, state: 'APPROVED', commitId: HEAD, url: 'review' }],
    });
    const fixture = await scanFixture({ repository });
    await writeReviewLedger(fixture.workDir, { sourceItem });
    const file = workspaceStatePath(fixture.workDir, WORKSPACE_ID);
    const before = await readFile(file, 'utf8');

    expect(await scanReviews(fixture.context)).toMatchObject({ attention: 1, reviewerRuns: 0 });
    expect(fixture.errors.join('\n')).toContain(
      sourceItem === null ? 'records no source item identity' : 'not for this item',
    );
    expect(repository.calls.findPullRequests).toEqual([]);
    expect(fixture.views.prepared).toEqual([]);
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it.each(['missing', 'malformed', 'different repository'] as const)(
    'refuses a %s ledger before a view or reviewer is started',
    async (problem) => {
      const repository = fakeRepository();
      const fixture = await scanFixture({ repository });
      const file = workspaceStatePath(fixture.workDir, WORKSPACE_ID);
      if (problem === 'missing') {
        await rm(file);
      } else if (problem === 'malformed') {
        await writeFile(file, '{broken', 'utf8');
      } else {
        await writeReviewLedger(fixture.workDir, { sourceRoot: '/another/repository' });
      }

      expect(await scanReviews(fixture.context)).toMatchObject({ attention: 1, reviewerRuns: 0 });
      expect(fixture.errors.join('\n')).toContain(
        problem === 'missing'
          ? 'has no ledger'
          : problem === 'malformed'
            ? 'ledger cannot be read'
            : 'was cloned from',
      );
      expect(repository.calls.findPullRequests).toEqual([]);
      expect(fixture.views.prepared).toEqual([]);
      expect(repository.calls.publishedReviews).toEqual([]);
      expect(repository.calls.publishedChecks).toEqual([]);
    },
  );

  it('accepts the same immutable item after its display key changes', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({ repository });
    await writeReviewLedger(fixture.workDir, {
      sourceItem: { ...sourceItemFor(refFor()), key: 'OLD-3' },
    });

    expect(await scanReviews(fixture.context)).toMatchObject({ reviewed: 1, reviewerRuns: 1 });
    expect(repository.calls.publishedReviews).toHaveLength(1);
    expect(repository.calls.publishedChecks).toHaveLength(1);
  });

  it.each([
    { state: 'CHANGES_REQUESTED', conclusion: 'success', decision: 'request_changes' },
    { state: 'APPROVED', conclusion: 'failure', decision: 'approve' },
    { state: 'APPROVED', conclusion: null, decision: 'approve' },
  ])(
    'reconciles the latest $state verdict with an existing $conclusion check',
    async ({ state, conclusion, decision }) => {
      const repository = fakeRepository({
        reviews: [
          { id: 1, login: LOGIN, state: 'APPROVED', commitId: HEAD, url: 'old-review' },
          { id: 2, login: LOGIN, state, commitId: HEAD, url: 'latest-review' },
        ],
        // Reverse API order: the greatest ID is the effective run, not the last entry.
        checks: [
          { id: 9, conclusion, url: 'new-check' },
          { id: 3, conclusion: 'failure', url: 'old-check' },
        ],
      });
      const fixture = await scanFixture({ repository });
      expect(await scanReviews(fixture.context)).toMatchObject({ unchanged: 1, reviewerRuns: 0 });
      expect(repository.calls.publishedReviews).toEqual([]);
      expect(repository.calls.publishedChecks).toEqual([
        expect.objectContaining({
          checkRunId: 9,
          head: HEAD,
          decision,
          detailsUrl: 'latest-review',
        }),
      ]);
    },
  );

  it('uses the latest matching check even when an older success is returned last', async () => {
    const repository = fakeRepository({
      reviews: [{ id: 2, login: LOGIN, state: 'CHANGES_REQUESTED', commitId: HEAD, url: 'review' }],
      checks: [
        { id: 9, conclusion: 'failure', url: 'latest' },
        { id: 3, conclusion: 'success', url: 'old' },
      ],
    });
    const fixture = await scanFixture({ repository });
    expect(await scanReviews(fixture.context)).toMatchObject({ unchanged: 1, reviewerRuns: 0 });
    expect(repository.calls.publishedChecks).toEqual([]);
  });

  it.each(['stale', 'api'] as const)(
    'reports %s check reconciliation without running a reviewer',
    async (failure) => {
      const repository = fakeRepository({
        reviews: [{ id: 2, login: LOGIN, state: 'APPROVED', commitId: HEAD, url: 'review' }],
        ...(failure === 'stale'
          ? { headAfterReview: OTHER_HEAD }
          : { publishCheckError: new ReviewError('api', 'write failed') }),
      });
      const fixture = await scanFixture({ repository });
      expect(await scanReviews(fixture.context)).toMatchObject({ attention: 1, reviewerRuns: 0 });
      expect(repository.calls.publishedChecks).toEqual([]);
      expect(repository.calls.publishedReviews).toEqual([]);
    },
  );

  it.each([
    {
      what: 'no textual patch for a binary file',
      files: [{ path: 'image.png', patch: null, additions: 0, deletions: 0 }],
    },
    {
      what: 'a patch that disagrees with GitHub’s change counts',
      files: [{ path: 'code.ts', patch: PATCH, additions: 4, deletions: 0 }],
    },
    {
      what: 'a rendered diff far beyond the old character guard',
      files: [
        {
          path: 'code.ts',
          patch: `@@ -0,0 +1,3 @@\n+a\n+b\n+${'x'.repeat(200_000)}`,
          additions: 3,
          deletions: 0,
        },
      ],
    },
  ])('lets $what reach the reviewer instead of refusing the change', async ({ files }) => {
    // GitHub's own report of a change can be unusable for positioning without
    // being a reason to refuse the review: the reviewer reads the change from
    // its repository view, and a finding the patch cannot position is reported
    // in the review body.
    const repository = fakeRepository({ evidence: { files } });
    const fixture = await scanFixture({ repository });

    expect(await scanReviews(fixture.context)).toMatchObject({ reviewed: 1, attention: 0 });
    expect(fixture.reviewerRuns).toHaveLength(1);
    expect(repository.calls.publishedReviews).toHaveLength(1);
    expect(repository.calls.publishedChecks).toHaveLength(1);
  });

  it('refuses a ticket too large to state compactly before a paid turn', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({ repository });
    fixture.context.queue.prepare = async () => ({
      ...preparedFor(),
      task: { ...taskFor(), description: 'x'.repeat(8_001) },
    });

    expect(await scanReviews(fixture.context)).toMatchObject({ attention: 1, reviewerRuns: 0 });
    expect(fixture.errors.join('\n')).toContain('incomplete review evidence');
    expect(repository.calls.publishedChecks).toEqual([]);
    expect(repository.calls.publishedReviews).toEqual([]);
  });

  it('starts no reviewer turn when its repository view cannot be prepared', async () => {
    const repository = fakeRepository();
    const views = fakeViews({
      prepareError: new ReviewError(
        'inconclusive',
        "the ticket's retained workspace does not hold the reviewed head",
      ),
    });
    const fixture = await scanFixture({ repository, views });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ attention: 1, reviewed: 0, reviewerRuns: 0 });
    expect(fixture.errors.join('\n')).toContain('repository view could not be prepared');
    expect(fixture.reviewerRuns).toEqual([]);
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
  });

  it('publishes nothing when the reviewer changed its repository view', async () => {
    const repository = fakeRepository();
    const views = fakeViews({
      problem: 'the repository view carries 1 changed path(s): "notes.txt"',
    });
    const fixture = await scanFixture({ repository, views });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ attention: 1, reviewed: 0, reviewerRuns: 1 });
    expect(views.checks.count).toBe(1);
    expect(fixture.errors.join('\n')).toContain('repository view for');
    expect(fixture.errors.join('\n')).toContain('notes.txt');
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
  });

  it('reports explicit inconclusive evidence without any native publication', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      reviewer: async () => ({
        verdict: {
          decision: 'inconclusive',
          summary: 'The caller source is unavailable.',
          findings: [],
        },
        summary: 'Evidence unavailable',
        problem: null,
        logPath: 'log',
      }),
    });
    expect(await scanReviews(fixture.context)).toMatchObject({ attention: 1, reviewerRuns: 1 });
    expect(fixture.errors.join('\n')).toContain('caller source is unavailable');
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
  });

  it('refuses an approval returned with a failed turn', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      reviewer: async () => ({
        verdict: APPROVE,
        summary: 'approved',
        problem: 'Turn interrupted',
        logPath: 'log',
      }),
    });
    expect(await scanReviews(fixture.context)).toMatchObject({ attention: 1, reviewerRuns: 1 });
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
  });

  it('does not publish a completed verdict after cancellation', async () => {
    const controller = new AbortController();
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      stop: controller.signal,
      reviewer: async () => {
        controller.abort();
        return { verdict: APPROVE, summary: 'approved', problem: null, logPath: 'log' };
      },
    });
    expect(await scanReviews(fixture.context)).toMatchObject({ attention: 1, reviewerRuns: 1 });
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
  });

  it('rejects a ticket whose requirements changed during the reviewer turn', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      prepare: (_candidate, call) => ({
        ...preparedFor(),
        ref: { ...refFor(), updatedAt: call === 1 ? refFor().updatedAt : 'later' },
      }),
    });
    expect(await scanReviews(fixture.context)).toMatchObject({ attention: 1, reviewerRuns: 1 });
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
  });
  it('approves an eligible ticket: one review, one successful check, one record', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({ repository });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({
      outcome: 'completed',
      scanned: 1,
      reviewed: 1,
      approved: 1,
      changesRequested: 0,
      unchanged: 0,
      attention: 0,
      reviewerRuns: 1,
    });
    expect(fixture.reviewerRuns).toHaveLength(1);
    expect(repository.calls.findPullRequests).toEqual([BRANCH]);
    expect(repository.calls.publishedReviews).toHaveLength(1);
    const [review] = repository.calls.publishedReviews;
    expect(review?.head).toBe(HEAD);
    expect(review?.decision).toBe('approve');
    expect(review?.body).toContain(`${SCOPE}/browse/HARN-3`);
    expect(review?.body).toContain('Reviewed head');
    expect(review?.comments).toEqual([]);
    const [check] = repository.calls.publishedChecks;
    expect(check).toMatchObject({ head: HEAD, decision: 'approve' });
    expect(check?.detailsUrl).toBe(review?.pullRequest.url + '#review');

    const directories = await reviewDirectories(fixture.workDir);
    expect(directories).toHaveLength(1);
    const record = JSON.parse(
      await readFile(
        path.join(fixture.workDir, 'reviews', directories[0] ?? '', 'review.json'),
        'utf8',
      ),
    ) as {
      disposition: string;
      verdict: string;
      review: { url: string };
      check: { conclusion: string };
      problem: string | null;
      reviewerLog: string | null;
      view: string | null;
    };
    expect(record.disposition).toBe('reviewed');
    expect(record.verdict).toBe('approve');
    expect(record.problem).toBeNull();
    expect(record.check.conclusion).toBe('success');
    expect(record.reviewerLog).not.toBeNull();
    // The view came from the workspace the ticket's pointer names, and the
    // record says where the reviewer inspected it.
    expect(fixture.views.prepared).toEqual([
      {
        dir: path.join(fixture.workDir, 'reviews', directories[0] ?? ''),
        workspacePath: path.join(fixture.workDir, 'workspaces', WORKSPACE_ID),
      },
    ]);
    expect(record.view).toBe(
      path.join(fixture.workDir, 'reviews', directories[0] ?? '', REVIEW_VIEW_DIRECTORY),
    );
    expect(await readFile(path.join(fixture.workDir, 'reviews', 'review.log'), 'utf8')).toContain(
      'HARN-3: approved',
    );
  });

  it('requests changes with concrete findings: an inline comment and the body finding', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      reviewer: async () => ({
        summary: 'incomplete',
        verdict: REQUEST_CHANGES,
        problem: null,
        logPath: 'log',
      }),
    });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ reviewed: 1, approved: 0, changesRequested: 1 });
    const [review] = repository.calls.publishedReviews;
    expect(review?.decision).toBe('request_changes');
    expect(review?.comments).toEqual([
      { path: 'src/greet-all.mjs', position: 1, body: 'The exported function ignores the names.' },
    ]);
    expect(review?.body).toContain('src/other.mjs:2');
    expect(review?.body).toContain('This file was not part of the change.');
    const [check] = repository.calls.publishedChecks;
    expect(check?.decision).toBe('request_changes');
  });

  it('does not start a reviewer turn for a head that already carries a completed review', async () => {
    const repository = fakeRepository({
      reviews: [{ id: 1, login: LOGIN, state: 'APPROVED', commitId: HEAD, url: 'review-url' }],
      checks: [{ id: 2, conclusion: 'success', url: 'check-url' }],
    });
    const fixture = await scanFixture({
      repository,
      reviewer: async () => {
        throw new Error('the reviewer must not run for an unchanged head');
      },
    });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ unchanged: 1, reviewed: 0, reviewerRuns: 0, attention: 0 });
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
    expect(fixture.output.join('\n')).toContain('already reviewed');
    // No review directory is created when nothing ran.
    expect(await reviewDirectories(fixture.workDir)).toEqual([]);
  });

  it('publishes the missing app-owned check from an existing review, without a reviewer turn', async () => {
    const repository = fakeRepository({
      reviews: [
        { id: 1, login: LOGIN, state: 'CHANGES_REQUESTED', commitId: HEAD, url: 'review-url' },
      ],
      checks: [],
    });
    const fixture = await scanFixture({
      repository,
      reviewer: async () => {
        throw new Error('the reviewer must not run for an already-reviewed head');
      },
    });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ unchanged: 1, reviewerRuns: 0 });
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toHaveLength(1);
    expect(repository.calls.publishedChecks[0]).toMatchObject({
      head: HEAD,
      decision: 'request_changes',
    });
    expect(fixture.output.join('\n')).toContain('published the missing');
  });

  it('reviews a new head again, and ignores another identity’s review', async () => {
    const repository = fakeRepository({
      reviews: [
        { id: 1, login: LOGIN, state: 'APPROVED', commitId: OTHER_HEAD, url: 'old' },
        { id: 2, login: 'someone-else', state: 'APPROVED', commitId: HEAD, url: 'other' },
      ],
      checks: [{ id: 3, conclusion: 'success', url: 'check-url' }],
    });
    const fixture = await scanFixture({ repository });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ reviewed: 1, unchanged: 0, reviewerRuns: 1 });
    expect(repository.calls.publishedReviews).toHaveLength(1);
    expect(repository.calls.publishedReviews[0]?.head).toBe(HEAD);
  });

  it('refuses to publish a verdict whose head moved while it was reviewed', async () => {
    const repository = fakeRepository({ headAfterReview: OTHER_HEAD });
    const fixture = await scanFixture({ repository });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ reviewed: 0, attention: 1, reviewerRuns: 1 });
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
    expect(fixture.errors.join('\n')).toContain(`moved from ${HEAD} to ${OTHER_HEAD}`);
  });

  it('publishes nothing when the ticket left the review status while the reviewer ran', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      prepare: (_candidate, call) => (call === 1 ? preparedFor() : null),
    });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ reviewed: 0, attention: 1, reviewerRuns: 1 });
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(fixture.errors.join('\n')).toContain('no longer in the configured review status');
  });

  it('reports a failed reviewer turn without publishing anything', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      reviewer: async () => ({
        summary: null,
        verdict: null,
        problem: 'the reviewer turn for HARN-3 did not complete: not logged in',
        logPath: 'log',
      }),
    });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ reviewed: 0, attention: 1, reviewerRuns: 1 });
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
    expect(fixture.errors.join('\n')).toContain('not logged in');
    const directories = await reviewDirectories(fixture.workDir);
    const record = JSON.parse(
      await readFile(
        path.join(fixture.workDir, 'reviews', directories[0] ?? '', 'review.json'),
        'utf8',
      ),
    ) as { disposition: string; problem: string };
    expect(record.disposition).toBe('attention');
    expect(record.problem).toContain('not logged in');
  });

  it('reports evidence and API failures without an approval', async () => {
    const evidenceFailure = await scanFixture({
      repository: fakeRepository({
        evidenceError: new ReviewError('api', 'the changed file list was not a list.'),
      }),
    });
    const first = await scanReviews(evidenceFailure.context);
    expect(first).toMatchObject({ attention: 1, reviewed: 0 });
    expect(evidenceFailure.errors.join('\n')).toContain('no reviewer turn was started');

    const publishFailure = await scanFixture({
      repository: fakeRepository({
        publishReviewError: new ReviewError('api', 'the GitHub request answered HTTP 422.'),
      }),
    });
    const second = await scanReviews(publishFailure.context);
    expect(second).toMatchObject({ attention: 1, reviewed: 0 });
    expect(publishFailure.errors.join('\n')).toContain('HTTP 422');
    expect(publishFailure.errors.join('\n')).not.toContain('approved');
  });

  it('stops the batch on a credential or installation failure', async () => {
    const repository = fakeRepository({
      findError: new ReviewError('auth', 'GitHub refused the App installation credentials.'),
    });
    const fixture = await scanFixture({ repository });

    await expect(scanReviews(fixture.context)).rejects.toThrow(/refused the App installation/);
  });

  it('reports a ticket with no pointer, no pull request, or an ambiguous match', async () => {
    const noPointer = await scanFixture({ items: [preparedFor('HARN-3', [])] });
    expect(await scanReviews(noPointer.context)).toMatchObject({ attention: 1, reviewerRuns: 0 });
    expect(noPointer.errors.join('\n')).toContain('no harness-ws-<workspaceId> pointer');

    const noPull = await scanFixture({ repository: fakeRepository({ pullRequest: null }) });
    expect(await scanReviews(noPull.context)).toMatchObject({ attention: 1, reviewerRuns: 0 });
    expect(noPull.errors.join('\n')).toContain(
      `no open pull request has the head branch "${BRANCH}"`,
    );

    const ambiguous = await scanFixture({
      repository: fakeRepository({
        findError: new ReviewError('ambiguous-pr', '2 open pull requests have the head branch.'),
      }),
    });
    expect(await scanReviews(ambiguous.context)).toMatchObject({ attention: 1, reviewerRuns: 0 });
    expect(ambiguous.errors.join('\n')).toContain('2 open pull requests');
  });

  it('does not review a ticket whose last local attempt did not pass', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      reviewer: async () => {
        throw new Error('a failed local attempt must not be reviewed');
      },
    });
    const receipt = receiptFilePath(fixture.workDir, refFor());
    await reserveReceipt(receipt, {
      version: 1,
      source: refFor(),
      reservedAt: '2026-09-19T11:00:00.000Z',
      runId: 'run-20260919110000-abcd1234',
      outcome: 'failed',
      problem: 'the post-agent check round never went green',
    });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ attention: 1, reviewed: 0, reviewerRuns: 0 });
    expect(fixture.errors.join('\n')).toContain('its last attempt on this machine ended failed');
    expect(repository.calls.publishedReviews).toEqual([]);
  });

  it('reviews a ticket whose local receipt records a passed attempt', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({ repository });
    const receipt = receiptFilePath(fixture.workDir, refFor());
    await reserveReceipt(receipt, {
      version: 1,
      source: refFor(),
      reservedAt: '2026-09-19T11:00:00.000Z',
      runId: 'run-20260919110000-abcd1234',
      outcome: 'passed',
    });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ reviewed: 1, attention: 0 });
  });

  it('reports a ticket with several pointers, and one whose pointer is not an id', async () => {
    const several = await scanFixture({ items: [preparedFor('HARN-3', ['one', 'two'])] });
    expect(await scanReviews(several.context)).toMatchObject({ attention: 1 });
    expect(several.errors.join('\n')).toContain('it names 2 workspaces');

    const malformed = await scanFixture({ items: [preparedFor('HARN-3', ['../elsewhere'])] });
    expect(await scanReviews(malformed.context)).toMatchObject({ attention: 1 });
    expect(malformed.errors.join('\n')).toContain('not a usable workspace id');
  });

  it('reports a ticket whose description is not a usable task', async () => {
    const fixture = await scanFixture({
      prepare: () => {
        throw new Error('invalid-task: no acceptance criteria');
      },
    });
    // A plain Error is not a source failure: the scan stops rather than
    // inventing a per-ticket report for a programming error.
    await expect(scanReviews(fixture.context)).rejects.toThrow(/invalid-task/);
  });

  it('bounds the paid reviewer turns one scan starts, and says so', async () => {
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      candidates: [candidateFor('HARN-3'), candidateFor('HARN-4')],
      items: [preparedFor('HARN-3'), preparedFor('HARN-4')],
    });

    const summary = await scanReviews(fixture.context, 1);

    expect(summary).toMatchObject({ scanned: 1, reviewed: 1, reviewerRuns: 1, attention: 0 });
    expect(fixture.output.join('\n')).toContain('--limit 1 reached');
    expect(repository.calls.publishedReviews).toHaveLength(1);
  });

  it.each(['source', 'pull request'] as const)(
    'counts the paid turn and keeps its record when the post-turn %s read fails',
    async (failedRead) => {
      const failure =
        failedRead === 'source'
          ? new SourceError('retryable-read', 'Jira re-read unavailable')
          : new ReviewError('api', 'GitHub re-read unavailable');
      const repository = fakeRepository({
        ...(failedRead === 'pull request' ? { readPullRequestError: failure } : {}),
      });
      const preparedKeys: string[] = [];
      const fixture = await scanFixture({
        repository,
        candidates: [candidateFor('HARN-3'), candidateFor('HARN-4')],
        prepare: (candidate, call) => {
          preparedKeys.push(candidate.ref.key);
          if (failedRead === 'source' && call === 2) {
            throw failure;
          }
          return preparedFor(candidate.ref.key);
        },
      });

      expect(await scanReviews(fixture.context, 1)).toMatchObject({
        outcome: 'completed',
        scanned: 1,
        reviewerRuns: 1,
        attention: 1,
        reviewed: 0,
        approved: 0,
      });
      expect(fixture.reviewerRuns).toHaveLength(1);
      expect(preparedKeys).toEqual(['HARN-3', 'HARN-3']);
      expect(repository.calls.readPullRequests).toBe(failedRead === 'source' ? 0 : 1);
      expect(repository.calls.publishedReviews).toEqual([]);
      expect(repository.calls.publishedChecks).toEqual([]);
      expect(fixture.output.join('\n')).toContain('--limit 1 reached');
      expect(fixture.errors.join('\n')).toContain(failure.message);
      const directories = await reviewDirectories(fixture.workDir);
      expect(directories).toHaveLength(1);
      const dir = path.join(fixture.workDir, 'reviews', directories[0]!);
      expect(JSON.parse(await readFile(path.join(dir, 'review.json'), 'utf8'))).toMatchObject({
        disposition: 'attention',
        verdict: null,
        review: null,
        check: null,
        problem: expect.stringContaining(failure.message),
        pullRequest: { headSha: HEAD },
        reviewerLog: path.join(dir, 'reviewer.log'),
        input: path.join(dir, 'input.md'),
      });
    },
  );

  it.each([
    ['source', new SourceError('fatal', 'Jira authentication failed')],
    ['pull request', new ReviewError('auth', 'GitHub authentication failed')],
    ['pull request', new ReviewError('fatal', 'GitHub client cannot proceed')],
    ['source', new Error('unexpected source error')],
    ['pull request', new Error('unexpected repository error')],
  ] as const)('still stops on a post-turn %s failure: %s', async (failedRead, failure) => {
    const repository = fakeRepository({
      ...(failedRead === 'pull request' ? { readPullRequestError: failure } : {}),
    });
    const fixture = await scanFixture({
      repository,
      candidates: [candidateFor('HARN-3'), candidateFor('HARN-4')],
      prepare: (candidate, call) => {
        if (failedRead === 'source' && call === 2) {
          throw failure;
        }
        return preparedFor(candidate.ref.key);
      },
    });

    await expect(scanReviews(fixture.context, 1)).rejects.toBe(failure);
    expect(fixture.reviewerRuns).toHaveLength(1);
    expect(repository.calls.publishedReviews).toEqual([]);
    expect(repository.calls.publishedChecks).toEqual([]);
  });

  it('reports no work for an empty queue', async () => {
    const fixture = await scanFixture({ candidates: [] });
    const summary = await scanReviews(fixture.context);
    expect(summary).toMatchObject({ outcome: 'completed', scanned: 0, reviewed: 0 });
  });

  it('treats a discovery stopped by the caller as the cancellation it is', async () => {
    const workDir = await createTempDir();
    const stop = new AbortController();
    const context: ReviewScanContext = {
      queue: {
        list: async () => {
          stop.abort(new Error('interrupt'));
          throw new SourceError(
            'fatal',
            'the request was stopped by the caller before it answered',
          );
        },
        prepare: async () => null,
      },
      repository: fakeRepository().repository,
      reviewer: async () => ({
        summary: null,
        verdict: null,
        problem: 'not used',
        logPath: 'log',
      }),
      views: fakeViews().source,
      workDir,
      sourceRoot: null,
      login: LOGIN,
      checkName: CHECK_NAME,
      reviewerTimeoutMs: 60_000,
      io: { out: () => undefined, err: () => undefined },
      stop: stop.signal,
      now: () => new Date(),
      sleep: async () => undefined,
    };

    await expect(scanReviews(context)).resolves.toMatchObject({ outcome: 'cancelled' });
  });
});

describe('the review watch', () => {
  it('waits out the poll interval, and a stop during the wait starts no further scan', async () => {
    const workDir = await createTempDir();
    const stop = new AbortController();
    let scans = 0;
    const waits: Array<() => void> = [];
    const context: ReviewScanContext = {
      queue: {
        list: async () => {
          scans += 1;
          return [];
        },
        prepare: async () => null,
      },
      repository: fakeRepository().repository,
      reviewer: async () => ({
        summary: null,
        verdict: null,
        problem: 'not used',
        logPath: 'log',
      }),
      views: fakeViews().source,
      workDir,
      sourceRoot: null,
      login: LOGIN,
      checkName: CHECK_NAME,
      reviewerTimeoutMs: 60_000,
      io: { out: () => undefined, err: () => undefined },
      stop: stop.signal,
      now: () => new Date(),
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          const finish = (): void => {
            signal.removeEventListener('abort', finish);
            resolve();
          };
          waits.push(() => {
            stop.abort(new Error('stop watching'));
            finish();
          });
          signal.addEventListener('abort', finish, { once: true });
        }),
    };

    const watching = watchReviews({ ...context, pollIntervalMs: 5_000 });
    while (waits.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    waits[0]?.();
    const summary = await watching;

    expect(scans).toBe(1);
    expect(summary.outcome).toBe('cancelled');
  });

  it('backs off after a failed scan, never shortens a server-directed wait, and resets on success', async () => {
    const workDir = await createTempDir();
    const stop = new AbortController();
    const waits: number[] = [];
    const errors: string[] = [];
    let scans = 0;
    const context: ReviewScanContext = {
      queue: {
        list: async () => {
          scans += 1;
          if (scans === 1) {
            throw new ReviewError('api', 'the search answered HTTP 429', {
              retryAfterMs: 120_000,
            });
          }
          return [];
        },
        prepare: async () => null,
      },
      repository: fakeRepository().repository,
      reviewer: async () => ({
        summary: null,
        verdict: null,
        problem: 'not used',
        logPath: 'log',
      }),
      views: fakeViews().source,
      workDir,
      sourceRoot: null,
      login: LOGIN,
      checkName: CHECK_NAME,
      reviewerTimeoutMs: 60_000,
      io: { out: () => undefined, err: (text) => errors.push(text) },
      stop: stop.signal,
      now: () => new Date(),
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 2) {
          stop.abort(new Error('stop watching'));
        }
      },
    };

    const summary = await watchReviews({ ...context, pollIntervalMs: 5_000 });

    expect(scans).toBe(2);
    expect(waits).toEqual([120_000, 5_000]);
    expect(errors.join('\n')).toContain('will try again in 120s');
    expect(summary.outcome).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// Configuration and the App key
// ---------------------------------------------------------------------------

/** The Nexus-wide reviewer integration of the fixture, before any override. */
function fixtureReviewer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: {
      appId: 5001141,
      installationId: 163007360,
      privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
      login: LOGIN,
    },
    reviewer: { runtime: 'codex', command: ['codex', '--profile', 'nexus-astra'] },
    ...overrides,
  };
}

/** The Nexus-wide harness configuration of the fixture, before any override. */
function harnessConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...documentedHarnessConfig,
    agent: { runtime: 'codex', command: ['codex'] },
    reviewer: fixtureReviewer(overrides['reviewer'] as Record<string, unknown> | undefined),
    ...(overrides['extra'] as Record<string, unknown> | undefined),
  };
}

/** The connected project's own configuration of the fixture, before any override. */
function projectConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    setup: [],
    checks: documentedProjectConfig.checks,
    source: {
      type: 'jira',
      siteUrl: SCOPE,
      cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
      projectKey: 'SAM1',
      tokenEnv: 'JIRA_API_TOKEN',
    },
    delivery: { type: 'github', repository: REPOSITORY, baseBranch: 'main' },
    ...(overrides['extra'] as Record<string, unknown> | undefined),
  };
}

/**
 * Writes the two configuration files the fixture is made of and returns their
 * paths: the Nexus-wide harness configuration, and the connected project's own
 * configuration in the directory a command reads it from.
 */
async function writeFixtureConfig(
  directory: string,
  harnessOverrides: Record<string, unknown> = {},
  project: Record<string, unknown> = projectConfig(),
): Promise<{ harnessPath: string; projectPath: string }> {
  return {
    harnessPath: await writeJsonFile(
      directory,
      HARNESS_CONFIG_FILE_NAME,
      harnessConfig(harnessOverrides),
    ),
    projectPath: await writeJsonFile(directory, PROJECT_CONFIG_FILE_NAME, project),
  };
}

describe('the review configuration', () => {
  it('accepts the documented reviewer object and defaults the check name', async () => {
    const directory = await createTempDir();
    const { harnessPath, projectPath } = await writeFixtureConfig(directory);
    const { config } = await loadConfiguration(harnessPath, projectPath);
    expect(config.review).toMatchObject({
      type: 'github',
      repository: REPOSITORY,
      checkName: CHECK_NAME,
      app: { appId: 5001141, installationId: 163007360, login: LOGIN },
    });
    expect(config.review?.reviewer.command).toEqual(['codex', '--profile', 'nexus-astra']);
    expect(config.source?.reviewStatus).toBe('In Review');
  });

  it('resolves a relative reviewer executable against the configuration file', async () => {
    const directory = await createTempDir();
    const { harnessPath, projectPath } = await writeFixtureConfig(directory, {
      reviewer: fixtureReviewer({
        reviewer: { runtime: 'codex', command: ['./bin/astra', '--profile', 'x'] },
      }),
    });
    const { config } = await loadConfiguration(harnessPath, projectPath);
    expect(config.review?.reviewer.command[0]).toBe(path.join(directory, 'bin', 'astra'));
  });

  it('leaves review inactive without a source and still refuses invalid reviewer fields', async () => {
    const directory = await createTempDir();
    const withoutSource = { ...projectConfig() };
    delete withoutSource['source'];
    const first = await writeFixtureConfig(directory, {}, withoutSource);
    const loaded = await loadConfiguration(first.harnessPath, first.projectPath);
    expect(loaded.config.review).toBeUndefined();
    expect(loaded.config.delivery?.repository).toBe(REPOSITORY);

    const badApp = await writeFixtureConfig(directory, {
      reviewer: fixtureReviewer({ app: { appId: 0 } }),
    });
    await expect(loadConfiguration(badApp.harnessPath, badApp.projectPath)).rejects.toThrow(/app/);

    const unknown = await writeFixtureConfig(directory, {
      reviewer: fixtureReviewer({ token: 'secret' }),
    });
    await expect(loadConfiguration(unknown.harnessPath, unknown.projectPath)).rejects.toThrow(
      /unrecognized|Unrecognized|token/,
    );
  });
});

describe('the App private key', () => {
  it('refuses a missing variable, an unreadable file, and a non-RSA key', async () => {
    const directory = await createTempDir();
    const { harnessPath, projectPath } = await writeFixtureConfig(directory);
    const { config } = await loadConfiguration(harnessPath, projectPath);
    const review = config.review;
    if (review === undefined) {
      throw new Error('the fixture has no review object');
    }

    await expect(resolveAppPrivateKey(review, {})).rejects.toThrow(
      /NEXUS_LENS_KEY_PATH is missing or blank/,
    );
    await expect(
      resolveAppPrivateKey(review, { NEXUS_LENS_KEY_PATH: path.join(directory, 'missing.pem') }),
    ).rejects.toThrow(/could not be read/);

    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    const ecFile = path.join(directory, 'ec.pem');
    await writeFile(ecFile, String(ec), 'utf8');
    await expect(resolveAppPrivateKey(review, { NEXUS_LENS_KEY_PATH: ecFile })).rejects.toThrow(
      /RSA private key/,
    );
  });

  it('signs an installation JWT with the configured App ID', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const jwt = appJwt(5001141, pem, new Date('2026-09-19T12:00:00.000Z'));
    const [header, payload] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
      iss: number;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe(5001141);
    expect(claims.exp - claims.iat).toBe(600);
    expect(jwt.split('.')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The whole path through the CLI
// ---------------------------------------------------------------------------

interface FakeIssue {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
  status: string;
  updated: string;
  labels?: string[];
}

interface FakeWorld {
  readonly fetch: typeof fetch;
  readonly jiraCalls: Array<{ method: string; url: string }>;
  readonly githubCalls: Array<{
    method: string;
    url: string;
    body: unknown;
    authorization: string;
  }>;
  readonly publishedReviews: Array<Record<string, unknown>>;
  readonly publishedChecks: Array<Record<string, unknown>>;
  readonly issues: FakeIssue[];
  setHead(sha: string): void;
  setBase(sha: string): void;
  failReview(status: number): void;
}

/** A Jira site and a GitHub repository in memory, for the CLI end-to-end test. */
function fakeWorld(options: {
  readonly issues: FakeIssue[];
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly reviews?: Array<{ login: string; state: string; commitId: string }>;
  readonly files?: Array<{ filename: string; patch: string | null }>;
}): FakeWorld {
  const jiraCalls: FakeWorld['jiraCalls'] = [];
  const githubCalls: FakeWorld['githubCalls'] = [];
  const publishedReviews: Array<Record<string, unknown>> = [];
  const publishedChecks: Array<Record<string, unknown>> = [];
  /** The app-owned check runs this fake world now holds, as GitHub would. */
  const createdChecks: Array<{ name: string; headSha: string; conclusion: string }> = [];
  const issues = options.issues;
  const reviews: Array<{ login: string; state: string; commitId: string }> = [
    ...(options.reviews ?? []),
  ];
  const files = options.files ?? [{ filename: 'src/greet-all.mjs', patch: PATCH }];
  let headSha = options.headSha ?? HEAD;
  let baseSha = options.baseSha ?? BASE;
  let reviewStatus = 201;

  const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const document = (): Record<string, unknown> => ({
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Implement the greeting.' }] },
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
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'The greeting is implemented.' }],
              },
            ],
          },
        ],
      },
    ],
  });

  const jira = (url: URL): Response => {
    const path = url.pathname;
    if (path.endsWith('/search/jql')) {
      return json({
        issues: issues
          .filter((issue) => issue.status === 'In Review')
          .map((issue) => ({
            id: issue.id,
            key: issue.key,
            fields: {
              summary: issue.summary,
              status: { name: issue.status },
              labels: issue.labels ?? ['harness-task'],
              project: { key: 'SAM1' },
              issuetype: { name: 'Task' },
              updated: issue.updated,
            },
          })),
        isLast: true,
      });
    }
    const match = /\/issue\/(\d+)(?:$|\?)/.exec(path);
    const issue = issues.find((candidate) => candidate.id === match?.[1]);
    if (issue !== undefined) {
      return json({
        id: issue.id,
        key: issue.key,
        fields: {
          summary: issue.summary,
          description: document(),
          status: { name: issue.status },
          labels: issue.labels ?? ['harness-task'],
          project: { key: 'SAM1' },
          issuetype: { name: 'Task' },
          updated: issue.updated,
        },
      });
    }
    return json({ errorMessages: ['not found'] }, 404);
  };

  const github = (url: URL, init: RequestInit): Response => {
    const path = url.pathname;
    const method = init.method ?? 'GET';
    if (path === `/app/installations/163007360/access_tokens`) {
      return json({
        token: 'installation-token',
        expires_at: '2026-09-19T13:00:00.000Z',
      });
    }
    if (method === 'GET' && path === `/repos/${REPOSITORY}/pulls`) {
      const wanted = url.searchParams.get('head') ?? '';
      const branch = wanted.split(':')[1] ?? '';
      return json([
        {
          number: 27,
          html_url: `https://github.com/${REPOSITORY}/pull/27`,
          title: 'HARN-3: Add the greeting feature',
          draft: false,
          state: 'open',
          merged_at: null,
          user: { login: 'example-owner' },
          head: { sha: headSha, ref: branch },
          base: { ref: 'main', sha: baseSha },
        },
      ]);
    }
    if (method === 'GET' && path === `/repos/${REPOSITORY}/pulls/27`) {
      return json({
        number: 27,
        html_url: `https://github.com/${REPOSITORY}/pull/27`,
        title: 'HARN-3: Add the greeting feature',
        draft: false,
        state: 'open',
        merged_at: null,
        user: { login: 'example-owner' },
        head: { sha: headSha, ref: BRANCH },
        base: { ref: 'main', sha: baseSha },
      });
    }
    if (method === 'GET' && path === `/repos/${REPOSITORY}/pulls/27/reviews`) {
      return json(
        reviews.map((review, index) => ({
          id: index + 1,
          user: { login: review.login },
          state: review.state,
          commit_id: review.commitId,
          html_url: `https://github.com/${REPOSITORY}/pull/27#review-${String(index + 1)}`,
        })),
      );
    }
    if (method === 'GET' && path === `/repos/${REPOSITORY}/pulls/27/files`) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const size = Number(url.searchParams.get('per_page') ?? '100');
      return json(
        files.slice((page - 1) * size, page * size).map((file) => ({
          filename: file.filename,
          additions: 3,
          deletions: 0,
          patch: file.patch,
        })),
      );
    }
    if (method === 'GET' && path === `/repos/${REPOSITORY}/contents/AGENTS.md`) {
      return json({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('# AGENTS.md\nRun the checks.\n', 'utf8').toString('base64'),
      });
    }
    if (method === 'GET' && path === `/repos/${REPOSITORY}/commits/${headSha}/check-runs`) {
      return json({
        check_runs: [
          {
            id: 7,
            name: 'validate',
            status: 'completed',
            conclusion: 'success',
            app: { id: 15368 },
          },
          ...createdChecks
            .filter((check) => check.headSha === headSha)
            .map((check, index) => ({
              id: 100 + index,
              name: check.name,
              status: 'completed',
              conclusion: check.conclusion,
              app: { id: 5001141 },
            })),
        ],
      });
    }
    if (method === 'GET' && path === `/repos/${REPOSITORY}/commits/${headSha}/status`) {
      return json({ state: 'success', statuses: [] });
    }
    if (method === 'POST' && path === `/repos/${REPOSITORY}/pulls/27/reviews`) {
      if (reviewStatus !== 201) {
        return json({ message: 'Validation Failed' }, reviewStatus);
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      publishedReviews.push(body);
      // GitHub is the record: a published review is what a later scan reads.
      reviews.push({
        login: LOGIN,
        state: body['event'] === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
        commitId: String(body['commit_id']),
      });
      return json(
        {
          id: 5256006204,
          html_url: `https://github.com/${REPOSITORY}/pull/27#pullrequestreview-5256006204`,
          state: body['event'] === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
          commit_id: body['commit_id'],
          user: { login: LOGIN },
        },
        201,
      );
    }
    if (method === 'POST' && path === `/repos/${REPOSITORY}/check-runs`) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      publishedChecks.push(body);
      createdChecks.push({
        name: String(body['name']),
        headSha: String(body['head_sha']),
        conclusion: String(body['conclusion']),
      });
      return json(
        {
          id: 105912854704,
          html_url: `https://github.com/${REPOSITORY}/runs/105912854704`,
          conclusion: body['conclusion'],
          status: 'completed',
          app: { id: 5001141 },
          head_sha: body['head_sha'],
        },
        201,
      );
    }
    // An existing app-owned check for the head, when a test seeds one.
    if (path.endsWith('/check-runs')) {
      return json({ check_runs: [] });
    }
    return json({ message: `unexpected ${method} ${path}` }, 404);
  };

  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init.method ?? 'GET';
    const authorization = new Headers(init.headers).get('authorization') ?? '';
    if (url.hostname === 'api.atlassian.com') {
      jiraCalls.push({ method, url: url.href });
      return jira(url);
    }
    if (url.hostname === 'api.github.com') {
      githubCalls.push({ method, url: url.href, body: init.body ?? null, authorization });
      return github(url, init);
    }
    throw new Error(`the test's fake world refused ${url.href}`);
  };

  return {
    fetch: impl as unknown as typeof fetch,
    jiraCalls,
    githubCalls,
    publishedReviews,
    publishedChecks,
    issues,
    setHead: (sha: string) => {
      headSha = sha;
    },
    setBase: (sha: string) => {
      baseSha = sha;
    },
    failReview: (status: number) => {
      reviewStatus = status;
    },
  };
}

function sourceIssue(labels: string[]): FakeIssue {
  return {
    id: '10003',
    key: 'HARN-3',
    summary: 'Add the greeting feature',
    status: 'In Review',
    updated: '2026-09-19T12:00:00.000Z',
    labels: ['harness-task', ...labels],
  };
}

/**
 * The reviewed head's own content, as the retained workspace really holds it:
 * the three lines GitHub's patch for the fixture's file describes. A reviewer
 * reads this from the view, and the compact prompt never carries it.
 */
const REVIEWED_SOURCE = ['export function greetAll(names) {', '  return names;', '}', ''].join(
  '\n',
);
/** The one file the fixture's pull request changes. */
const REVIEWED_FILE = 'src/greet-all.mjs';

/** One file the reviewed head really carries, beyond the fixture's own. */
interface ReviewedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Creates the retained workspace the ticket's pointer names, as the coding run
 * and its delivery step would have left it: a clone on the branch
 * `harness/<workspaceId>`, whose head the pull request's head names and whose
 * history holds the change's base commit. Returns the two commits so the fake
 * world can report them.
 */
async function writeReviewWorkspace(
  workDir: string,
  extra: readonly ReviewedFile[] = [],
): Promise<{ readonly path: string; readonly base: string; readonly head: string }> {
  const workspace = path.join(workDir, 'workspaces', WORKSPACE_ID);
  await mkdir(workspace, { recursive: true });
  git(workspace, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(workspace, 'README.md'), '# The example project\n', 'utf8');
  git(workspace, 'add', '--all');
  git(workspace, 'commit', '--quiet', '--message', 'the example project');
  const base = git(workspace, 'rev-parse', 'HEAD').trim();

  git(workspace, 'checkout', '--quiet', '-b', BRANCH);
  await mkdir(path.dirname(path.join(workspace, REVIEWED_FILE)), { recursive: true });
  await writeFile(path.join(workspace, REVIEWED_FILE), REVIEWED_SOURCE, 'utf8');
  for (const file of extra) {
    await mkdir(path.dirname(path.join(workspace, file.path)), { recursive: true });
    await writeFile(path.join(workspace, file.path), file.content, 'utf8');
  }
  git(workspace, 'add', '--all');
  git(workspace, 'commit', '--quiet', '--message', 'add greetAll');
  const head = git(workspace, 'rev-parse', 'HEAD').trim();
  await writeReviewLedger(workDir, { baseCommit: base });
  return { path: workspace, base, head };
}

async function reviewCommandFixture(options: {
  readonly world: FakeWorld;
  readonly plans?: readonly FakePlan[];
  readonly key?: string | null;
  /** Whether the ticket's retained workspace is on this machine at all. */
  readonly workspace?: boolean;
  /** Files the reviewed head really carries, beyond the fixture's own. */
  readonly readFiles?: readonly ReviewedFile[];
  /** Nexus-wide harness configuration fields to replace. */
  readonly harness?: Record<string, unknown>;
  /** The connected project's own configuration, when a test replaces it. */
  readonly project?: Record<string, unknown>;
  /** An interactive terminal for the review to draw its reviewer pane on. */
  readonly terminal?: CliContext['io']['terminal'];
}): Promise<{
  readonly cwd: string;
  readonly configPath: string;
  /** The reviewed head the fake world and the retained workspace agree on. */
  readonly head: string | null;
  readonly base: string | null;
  readonly workspacePath: string;
  readonly runtime: { readonly bin: string; readonly state: FakeState };
  readonly run: () => Promise<{ code: number; out: string; err: string }>;
  readonly signals: InterruptSignals;
}> {
  const directory = await createTempDir();
  // The fixture's own output directory and limits: a review turn is bounded by
  // the harness configuration's task timeout, and keeps its evidence there.
  const configPath = await writeJsonFile(directory, HARNESS_CONFIG_FILE_NAME, {
    ...harnessConfig(options.harness ?? {}),
    workDir: './runs',
    maxRepairs: 0,
    taskTimeoutMinutes: 5,
  } as Record<string, unknown>);
  // The retained workspace the ticket's pointer label names: a review happens
  // in a repository view cloned from it, so it has to be really there.
  const workDir = path.join(directory, 'runs');
  const workspace =
    options.workspace === false
      ? null
      : await writeReviewWorkspace(workDir, options.readFiles ?? []);
  if (workspace !== null) {
    options.world.setHead(workspace.head);
    options.world.setBase(workspace.base);
  }
  const projectPath = await writeJsonFile(
    directory,
    PROJECT_CONFIG_FILE_NAME,
    options.project ?? projectConfig(),
  );
  const keyFile = path.join(directory, 'nexus-lens.pem');
  if (options.key !== null) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(
      keyFile,
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      'utf8',
    );
  }
  const runtime = await installFakeRuntime(directory);

  const handlers: Array<() => void> = [];
  const signals: InterruptSignals = {
    onInterrupt: (handler) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) {
          handlers.splice(index, 1);
        }
      };
    },
  };

  const run = async (): Promise<{ code: number; out: string; err: string }> => {
    const out: string[] = [];
    const err: string[] = [];
    const previous = {
      PATH: process.env.PATH,
      FAKE_CODEX: process.env.FAKE_CODEX,
      JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      NEXUS_LENS_KEY_PATH: process.env.NEXUS_LENS_KEY_PATH,
    };
    process.env.PATH = `${runtime.bin}${path.delimiter}${previous.PATH ?? ''}`;
    process.env.FAKE_CODEX = JSON.stringify({
      stateDir: runtime.state.dir,
      plans: options.plans ?? [],
    });
    process.env.JIRA_API_TOKEN = 'test-token';
    process.env.GH_TOKEN = 'operator-token';
    process.env.GITHUB_TOKEN = 'operator-alternate-token';
    if (options.key === null) {
      delete process.env.NEXUS_LENS_KEY_PATH;
    } else {
      process.env.NEXUS_LENS_KEY_PATH = keyFile;
    }
    const context: CliContext = {
      cwd: directory,
      io: {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      },
      fetch: options.world.fetch,
      signals,
    };
    try {
      const code = await runCli(
        ['review', 'scan', '--config', configPath, '--project', path.dirname(projectPath)],
        context,
      );
      // Child filtering must leave the operator's process environment intact.
      expect(process.env.JIRA_API_TOKEN).toBe('test-token');
      expect(process.env.NEXUS_LENS_KEY_PATH).toBe(options.key === null ? undefined : keyFile);
      return { code, out: out.join('\n'), err: err.join('\n') };
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  };

  return {
    cwd: directory,
    configPath,
    head: workspace?.head ?? null,
    base: workspace?.base ?? null,
    workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
    runtime,
    run,
    signals,
  };
}

describe('the review command through the CLI', () => {
  it.each(['item', 'repository'] as const)(
    'refuses a real retained workspace owned by another %s before starting the runtime',
    async (mismatch) => {
      const world = fakeWorld({ issues: [sourceIssue([WORKSPACE_LABEL])] });
      const fixture = await reviewCommandFixture({
        world,
        plans: [{ edits: [{ file: '../verdict.json', text: verdictFile(APPROVE) }] }],
      });
      await writeReviewLedger(
        path.join(fixture.cwd, 'runs'),
        mismatch === 'item'
          ? { sourceItem: { ...sourceItemFor(refFor()), id: '99999' } }
          : { sourceRoot: '/another/repository' },
      );

      const result = await fixture.run();

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.err).toContain(mismatch === 'item' ? 'not for this item' : 'was cloned from');
      expect(await fakeTurns(fixture.runtime.state)).toHaveLength(0);
      expect(await reviewDirectories(path.join(fixture.cwd, 'runs'))).toEqual([]);
      expect(world.publishedReviews).toEqual([]);
      expect(world.publishedChecks).toEqual([]);
      expect(world.issues[0]?.status).toBe('In Review');
      expect(git(fixture.workspacePath, 'status', '--porcelain')).toBe('');
    },
  );

  it('draws the reviewer turn in its own pane, opened by its role and ticket', async () => {
    const world = fakeWorld({ issues: [sourceIssue([WORKSPACE_LABEL])] });
    const console = fakeConsole({ columns: 80, rows: 24 });
    const fixture = await reviewCommandFixture({
      world,
      terminal: console.io.terminal,
      plans: [
        {
          summary: 'the change matches the ticket',
          edits: [{ file: '../verdict.json', text: verdictFile(APPROVE) }],
        },
      ],
    });

    const result = await fixture.run();

    expect(result.code).toBe(EXIT_OK);
    // The pane was drawn in place, and what it kept is the reviewer's own rows:
    // the command the turn ran and the message it ended with.
    expect(console.chunks.join('')).toContain('\u001b[');
    const shown = screenAfter(console.chunks).join('\n');
    expect(shown).toMatch(
      /\d{2}:\d{2}:\d{2} ---- reviewer: HARN-3 — review ----\n\d{2}:\d{2}:\d{2} run: node tools\/run-checks\.mjs\n\d{2}:\d{2}:\d{2} agent: the change matches the ticket/,
    );
    // No coding pane is opened by a review: the reviewer role is the phase that
    // launched the turn, and it is the only role this command draws.
    expect(shown).not.toContain('---- developer:');
  });

  it('accepts a completed but explicitly inconclusive reviewer without publishing a verdict', async () => {
    const world = fakeWorld({ issues: [sourceIssue([WORKSPACE_LABEL])] });
    const fixture = await reviewCommandFixture({
      world,
      plans: [
        {
          edits: [
            {
              file: '../verdict.json',
              text: JSON.stringify({
                verdict: 'inconclusive',
                summary: 'Cannot inspect the dependency needed to judge this change.',
                findings: [],
              }),
            },
          ],
        },
      ],
    });
    const result = await fixture.run();
    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toContain('Cannot inspect the dependency');
    expect(await fakeTurns(fixture.runtime.state)).toHaveLength(1);
    expect(world.publishedReviews).toEqual([]);
    expect(world.publishedChecks).toEqual([]);
    expect(world.issues[0]?.status).toBe('In Review');
  });
  it('reviews inside the pinned checkout with publication credentials stripped', async () => {
    const world = fakeWorld({
      issues: [sourceIssue([WORKSPACE_LABEL])],
    });
    const fixture = await reviewCommandFixture({
      world,
      plans: [
        {
          inspectEnvironment: [
            'JIRA_API_TOKEN',
            'NEXUS_LENS_KEY_PATH',
            'GH_TOKEN',
            'GITHUB_TOKEN',
            'PATH',
            'FAKE_CODEX',
          ],
          edits: [{ file: '../verdict.json', text: verdictFile(APPROVE) }],
        },
      ],
    });

    const result = await fixture.run();

    expect(result.code).toBe(EXIT_OK);
    const turns = await fakeTurns(fixture.runtime.state);
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    // The turn runs inside the exact-head checkout; only its output lives outside it.
    expect(turn.cwd).toContain(path.join(fixture.cwd, 'runs', 'reviews'));
    expect(existsSync(path.join(turn.cwd, '.git'))).toBe(true);
    expect(existsSync(path.join(turn.cwd, '..', 'verdict.json'))).toBe(true);
    const view = turn.cwd;
    expect(git(view, 'rev-parse', 'HEAD').trim()).toBe(fixture.head);
    // The view the harness pinned is the one it checks: asking its own boundary
    // whether that snapshot still stands is what decides publication.
    expect(
      await reviewViewProblem(
        { path: view, head: fixture.head ?? '', base: fixture.base ?? '' },
        new AbortController().signal,
      ),
    ).toBeNull();
    // The view really holds the reviewed head's own content, and no path back
    // to the workspace it was cloned from.
    expect(git(view, 'show', `HEAD:${REVIEWED_FILE}`)).toBe(REVIEWED_SOURCE);
    expect(git(view, 'remote')).toBe('');
    expect(existsSync(path.join(fixture.cwd, '.git'))).toBe(false);
    expect(turn.argv).toEqual([
      '--profile',
      'nexus-astra',
      '--ask-for-approval',
      'never',
      'exec',
      '--sandbox',
      'danger-full-access',
      '--json',
      '-',
    ]);
    expect(turn.environmentPresent).toEqual({
      JIRA_API_TOKEN: false,
      GH_TOKEN: false,
      GITHUB_TOKEN: false,
      NEXUS_LENS_KEY_PATH: false,
      PATH: true,
      FAKE_CODEX: true,
    });
    // The parent resolved the key and still publishes as the App.
    expect(world.publishedReviews[0]).toMatchObject({ event: 'APPROVE', commit_id: fixture.head });
    expect(world.publishedChecks[0]).toMatchObject({ conclusion: 'success' });
  });

  it.each([
    { count: 101, truncated: false, pages: 2 },
    { count: 301, truncated: true, pages: 3 },
  ])(
    'handles $count changed files without approving a truncated list',
    async ({ count, truncated, pages }) => {
      const world = fakeWorld({
        issues: [sourceIssue([WORKSPACE_LABEL])],
        files: Array.from({ length: count }, (_, index) => ({
          filename: `src/file-${String(index)}.mjs`,
          patch: PATCH,
        })),
      });
      const fixture = await reviewCommandFixture({
        world,
        plans: [{ edits: [{ file: '../verdict.json', text: verdictFile(APPROVE) }] }],
      });

      const result = await fixture.run();

      expect(
        world.githubCalls.filter((call) => new URL(call.url).pathname.endsWith('/files')),
      ).toHaveLength(pages);
      expect(result.code).toBe(truncated ? EXIT_INPUT_ERROR : EXIT_OK);
      expect(await fakeTurns(fixture.runtime.state)).toHaveLength(truncated ? 0 : 1);
      expect(world.publishedReviews).toHaveLength(truncated ? 0 : 1);
      expect(world.publishedChecks).toHaveLength(truncated ? 0 : 1);
      expect(world.issues[0]?.status).toBe('In Review');
      if (truncated) {
        expect(result.out).toContain('attention  1');
        const log = await readFile(path.join(fixture.cwd, 'runs', 'reviews', 'review.log'), 'utf8');
        expect(log).toContain('changed-file list GitHub reports');
        expect(log).toContain('is truncated');
        expect(log).toContain('coordinator');
        expect(log).toContain('no reviewer turn');
      }
    },
  );

  it(
    'reviews an In Review ticket once, as the App, with a real JWT exchange and the configured profile',
    { timeout: 60_000 },
    async () => {
      const world = fakeWorld({
        issues: [sourceIssue([WORKSPACE_LABEL])],
      });
      const fixture = await reviewCommandFixture({
        world,
        plans: [
          {
            edits: [
              {
                file: '../verdict.json',
                text: JSON.stringify({
                  verdict: 'approve',
                  summary: 'The change implements the ticket.',
                  findings: [],
                }),
              },
            ],
            summary: 'approved the change',
          },
        ],
      });

      const result = await fixture.run();

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('review completed');
      expect(result.out).toContain('reviewed   1 (approved: 1, changes requested: 0)');

      // The App's identity really authenticated: a JWT was exchanged for an
      // installation token, and every repository call used that token.
      const tokenCall = world.githubCalls.find((call) =>
        call.url.includes('/app/installations/163007360/access_tokens'),
      );
      expect(tokenCall?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      const reviewCall = world.githubCalls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/pulls/27/reviews'),
      );
      expect(reviewCall?.authorization).toBe('Bearer installation-token');
      expect(world.publishedReviews[0]).toMatchObject({
        event: 'APPROVE',
        commit_id: fixture.head,
      });
      expect(String(world.publishedReviews[0]?.['body'])).toContain(`${SCOPE}/browse/HARN-3`);
      expect(world.publishedChecks[0]).toMatchObject({
        name: CHECK_NAME,
        head_sha: fixture.head,
        status: 'completed',
        conclusion: 'success',
      });
      // A review reads Jira and changes nothing there: no claim, no comment, no
      // transition, and the ticket stays In Review.
      expect(
        world.jiraCalls.every((call) => call.method === 'GET' || call.url.endsWith('/search/jql')),
      ).toBe(true);
      expect(world.issues[0]?.status).toBe('In Review');

      // The reviewer really went through the adapter, with the configured
      // reviewer profile, inside the pinned checkout, and its
      // prompt names the view rather than carrying the change.
      const turns = await fakeTurns(fixture.runtime.state);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.argv.slice(0, 4)).toEqual([
        '--profile',
        'nexus-astra',
        '--ask-for-approval',
        'never',
      ]);
      expect(turns[0]?.cwd).toContain(path.join('runs', 'reviews'));
      expect(turns[0]?.prompt).toContain('HARN-3');
      expect(turns[0]?.prompt).toContain(`Base: main at ${fixture.base}`);
      expect(turns[0]?.prompt).toContain(`Head: ${BRANCH} at ${fixture.head}`);
      expect(turns[0]?.prompt).not.toContain('export function greetAll(names) {');

      // A second scan of the same, unchanged head starts no reviewer turn and
      // publishes no second review: the native review is the record.
      const second = await fixture.run();
      expect(second.code).toBe(EXIT_OK);
      expect(second.out).toContain('unchanged  1');
      expect(world.publishedReviews).toHaveLength(1);
      expect(world.publishedChecks).toHaveLength(1);
      expect(await fakeTurns(fixture.runtime.state)).toHaveLength(1);
    },
  );

  it(
    'reviews a new head again and cannot approve it with a stale verdict',
    { timeout: 60_000 },
    async () => {
      const world = fakeWorld({
        issues: [sourceIssue([WORKSPACE_LABEL])],
        reviews: [{ login: LOGIN, state: 'APPROVED', commitId: OTHER_HEAD }],
      });
      const fixture = await reviewCommandFixture({
        world,
        plans: [
          {
            edits: [
              {
                file: '../verdict.json',
                text: JSON.stringify({
                  verdict: 'request_changes',
                  summary: 'The function ignores the names.',
                  findings: [
                    {
                      path: 'src/greet-all.mjs',
                      line: 1,
                      body: 'It returns the wrong thing.',
                    },
                  ],
                }),
              },
            ],
            summary: 'requested changes',
          },
        ],
      });

      const result = await fixture.run();

      expect(result.code).toBe(EXIT_OK);
      expect(world.publishedReviews[0]).toMatchObject({
        event: 'REQUEST_CHANGES',
        commit_id: fixture.head,
        comments: [{ path: 'src/greet-all.mjs', position: 1, body: 'It returns the wrong thing.' }],
      });
      expect(world.publishedChecks[0]).toMatchObject({ conclusion: 'failure' });
      expect(await fakeTurns(fixture.runtime.state)).toHaveLength(1);
    },
  );

  it(
    'reviews a change larger than the old rendered-diff guard reached',
    { timeout: 60_000 },
    async () => {
      // The observed case: a complete pull request whose rendered patch is far
      // past the 120,000-character prompt guard the harness used to refuse on.
      const padding = 'x'.repeat(150_000);
      const content = [
        'export const big = true;',
        `// ${padding}`,
        'export const after = 1;',
        '',
      ].join('\n');
      const patch = [
        '@@ -0,0 +1,3 @@',
        '+export const big = true;',
        `+// ${padding}`,
        '+export const after = 1;',
      ].join('\n');
      expect(patch.length).toBeGreaterThan(120_000);

      const world = fakeWorld({
        issues: [sourceIssue([WORKSPACE_LABEL])],
        files: [{ filename: 'src/big.mjs', patch }],
      });
      const fixture = await reviewCommandFixture({
        world,
        readFiles: [{ path: 'src/big.mjs', content }],
        plans: [
          {
            reviewInspection: {
              file: 'src/big.mjs',
              blockingText: 'export const after = 0;',
              blockingVerdict: verdictFile(REQUEST_CHANGES),
              clearVerdict: verdictFile(APPROVE),
            },
            summary: 'read the complete large file',
          },
        ],
      });

      const result = await fixture.run();

      expect(result.code).toBe(EXIT_OK);
      const turns = await fakeTurns(fixture.runtime.state);
      expect(turns).toHaveLength(1);
      expect(await fakeEvents(fixture.runtime.state)).toContainEqual(
        expect.objectContaining({
          event: 'review-inspection',
          file: 'src/big.mjs',
          blocking: false,
        }),
      );
      // The prompt stays compact: the change is not assembled into it.
      expect(turns[0]?.prompt).not.toContain(padding);
      expect(turns[0]?.prompt.length).toBeLessThan(20_000);
      // The reviewer's own view really holds the whole file at the reviewed head.
      const view = turns[0]?.cwd ?? '';
      expect(git(view, 'show', 'HEAD:src/big.mjs')).toBe(content);
      expect(world.publishedReviews).toHaveLength(1);
      expect(world.publishedChecks[0]).toMatchObject({
        head_sha: fixture.head,
        conclusion: 'success',
      });
    },
  );

  it.each(['blocking', 'corrected', 'inaccessible', 'missing-file'] as const)(
    'derives a %s result through actual runtime Git and file reads',
    { timeout: 60_000 },
    async (scenario) => {
      const world = fakeWorld({ issues: [sourceIssue([WORKSPACE_LABEL])] });
      const source =
        scenario === 'corrected'
          ? REVIEWED_SOURCE.replace(
              'return names;',
              'return names.map((name) => `Hello, ${name}!`);',
            )
          : REVIEWED_SOURCE;
      const fixture = await reviewCommandFixture({
        world,
        readFiles: [{ path: REVIEWED_FILE, content: source }],
        plans: [
          {
            removes: scenario === 'missing-file' ? [REVIEWED_FILE] : [],
            reviewInspection: {
              file: scenario === 'inaccessible' ? 'src/unavailable.mjs' : REVIEWED_FILE,
              blockingText: 'return names;',
              blockingVerdict: verdictFile({
                decision: 'request_changes',
                summary: 'The exported function throws the names away.',
                findings: [
                  {
                    path: REVIEWED_FILE,
                    line: 2,
                    body: 'It returns the input unchanged instead of greeting the names.',
                  },
                ],
              }),
              clearVerdict: verdictFile(APPROVE),
            },
            summary: 'inspected the repository with read tools',
          },
        ],
      });

      const result = await fixture.run();
      const turns = await fakeTurns(fixture.runtime.state);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.prompt).not.toContain('return names;');
      expect(turns[0]?.prompt).not.toContain(source);
      expect(turns[0]?.argv).not.toContain('--skip-git-repo-check');
      const events = await fakeEvents(fixture.runtime.state);
      if (scenario === 'inaccessible' || scenario === 'missing-file') {
        expect(result.code).toBe(EXIT_INPUT_ERROR);
        expect(result.err).toContain('Required file/tool access failed');
        expect(events).toContainEqual(
          expect.objectContaining({ event: 'review-inspection-failed' }),
        );
        expect(world.publishedReviews).toEqual([]);
        expect(world.publishedChecks).toEqual([]);
        return;
      }
      expect(result.code).toBe(EXIT_OK);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'review-inspection',
          file: REVIEWED_FILE,
          blocking: scenario === 'blocking',
        }),
      );
      expect(world.publishedReviews[0]).toMatchObject({
        event: scenario === 'blocking' ? 'REQUEST_CHANGES' : 'APPROVE',
        commit_id: fixture.head,
      });
      if (scenario === 'blocking') {
        expect(world.publishedReviews[0]).toMatchObject({
          comments: [
            {
              path: REVIEWED_FILE,
              position: 2,
              body: 'It returns the input unchanged instead of greeting the names.',
            },
          ],
        });
      }
      expect(world.publishedChecks[0]).toMatchObject({
        conclusion: scenario === 'blocking' ? 'failure' : 'success',
      });
    },
  );

  it.each(['notes.txt', 'scratch.log', 'cache/output.txt'])(
    'publishes nothing when the reviewer leaves %s in its repository view',
    { timeout: 60_000 },
    async (writtenPath) => {
      const world = fakeWorld({ issues: [sourceIssue([WORKSPACE_LABEL])] });
      const fixture = await reviewCommandFixture({
        world,
        readFiles: [{ path: '.gitignore', content: '*.log\ncache/\n' }],
        plans: [
          {
            // A turn that approves and also leaves a file in the view: the view
            // is no longer the snapshot the reviewed head names.
            edits: [
              { file: '../verdict.json', text: verdictFile(APPROVE) },
              { file: writtenPath, text: 'scratch\n' },
            ],
          },
        ],
      });

      const result = await fixture.run();

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.err).toContain('repository view');
      expect(result.err).toContain(writtenPath.split('/')[0]);
      expect(world.publishedReviews).toEqual([]);
      expect(world.publishedChecks).toEqual([]);
      expect(world.issues[0]?.status).toBe('In Review');
    },
  );

  it(
    'starts no reviewer turn when the retained workspace is not on this machine',
    { timeout: 60_000 },
    async () => {
      const world = fakeWorld({ issues: [sourceIssue([WORKSPACE_LABEL])] });
      const fixture = await reviewCommandFixture({
        world,
        workspace: false,
        plans: [{ edits: [{ file: '../verdict.json', text: verdictFile(APPROVE) }] }],
      });

      const result = await fixture.run();

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.err).toContain('this machine has no workspace');
      expect(await fakeTurns(fixture.runtime.state)).toHaveLength(0);
      expect(world.publishedReviews).toEqual([]);
      expect(world.publishedChecks).toEqual([]);
      expect(world.issues[0]?.status).toBe('In Review');
    },
  );

  it(
    'starts no reviewer turn when the workspace cannot be pinned at the reviewed head',
    { timeout: 60_000 },
    async () => {
      const world = fakeWorld({ issues: [sourceIssue([WORKSPACE_LABEL])] });
      const fixture = await reviewCommandFixture({
        world,
        plans: [{ edits: [{ file: '../verdict.json', text: verdictFile(APPROVE) }] }],
      });
      // The pull request advanced to a head this machine never held: the view
      // cannot be pinned at it, so nothing may be reviewed or published.
      world.setHead(OTHER_HEAD);

      const result = await fixture.run();

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.err).toContain(`reviewed head ${OTHER_HEAD}`);
      expect(await fakeTurns(fixture.runtime.state)).toHaveLength(0);
      expect(world.publishedReviews).toEqual([]);
      expect(world.publishedChecks).toEqual([]);
      expect(world.issues[0]?.status).toBe('In Review');
    },
  );

  it('reports a missing App key honestly, without contacting the repository', async () => {
    const world = fakeWorld({
      issues: [sourceIssue([WORKSPACE_LABEL])],
    });
    const fixture = await reviewCommandFixture({ world, key: null });

    const result = await fixture.run();

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toContain('NEXUS_LENS_KEY_PATH is missing or blank');
    expect(world.githubCalls).toEqual([]);
    expect(world.publishedReviews).toEqual([]);
    expect(world.publishedChecks).toEqual([]);
  });

  it('reports a missing Jira credential before it contacts anything', async () => {
    const directory = await createTempDir();
    const { harnessPath: configPath } = await writeFixtureConfig(directory);
    const out: string[] = [];
    const err: string[] = [];
    const world = fakeWorld({ issues: [] });
    const previous = process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_API_TOKEN;
    try {
      const code = await runCli(
        ['review', 'scan', '--config', configPath, '--project', directory],
        {
          cwd: directory,
          io: { out: (text) => out.push(text), err: (text) => err.push(text) },
          fetch: world.fetch,
        },
      );
      expect(code).toBe(EXIT_INPUT_ERROR);
    } finally {
      if (previous !== undefined) {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
    expect(err.join('\n')).toContain('JIRA_API_TOKEN is missing or blank');
    expect(world.jiraCalls).toEqual([]);
    expect(world.githubCalls).toEqual([]);
  });

  it('reports an unavailable reviewer launch as inconclusive, without approving', async () => {
    const world = fakeWorld({
      issues: [sourceIssue([WORKSPACE_LABEL])],
    });
    const fixture = await reviewCommandFixture({
      world,
      harness: {
        reviewer: fixtureReviewer({
          reviewer: { runtime: 'codex', command: ['definitely-not-a-real-codex-xyz'] },
        }),
      },
    });

    const result = await fixture.run();

    expect(result.code).toBe(EXIT_INPUT_ERROR);
    expect(result.err).toContain('could not be started');
    expect(result.err).not.toContain('approved');
    expect(world.publishedReviews).toEqual([]);
    expect(world.publishedChecks).toEqual([]);
    expect(world.issues[0]?.status).toBe('In Review');
  });

  it.each([401, 422])(
    'timestamps an HTTP %s failure after review without a coding rerun',
    async (status) => {
      const world = fakeWorld({
        issues: [sourceIssue([WORKSPACE_LABEL])],
      });
      world.failReview(status);
      const fixture = await reviewCommandFixture({
        world,
        plans: [
          {
            edits: [
              {
                file: '../verdict.json',
                text: JSON.stringify({ verdict: 'approve', summary: 'Fine.', findings: [] }),
              },
            ],
          },
        ],
      });

      const result = await fixture.run();

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.err).toContain(`HTTP ${String(status)}`);
      for (const line of result.err.split('\n')) {
        expect(line).toMatch(/^\d{2}:\d{2}:\d{2} /);
      }
      expect(result.out).toContain('---- reviewer: HARN-3 — review ----');
      expect(result.err).not.toContain('approved the');
      expect(world.publishedReviews).toEqual([]);
      expect(world.publishedChecks).toEqual([]);
      expect(await fakeTurns(fixture.runtime.state)).toHaveLength(1);
      expect(world.issues[0]?.status).toBe('In Review');
    },
  );

  it('refuses --repo and a bad --limit, the way every command does', async () => {
    const directory = await createTempDir();
    const { harnessPath: configPath } = await writeFixtureConfig(directory);
    const errors: string[] = [];
    const io = { out: () => undefined, err: (text: string) => errors.push(text) };

    const withRepo = await runCli(
      ['review', 'scan', '--config', configPath, '--project', directory, '--repo', directory],
      { cwd: directory, io },
    );
    expect(withRepo).toBe(2);
    expect(errors.join('\n')).toContain('unknown option "--repo"');

    const badLimit = await runCli(
      ['review', 'scan', '--config', configPath, '--project', directory, '--limit', 'lots'],
      { cwd: directory, io },
    );
    expect(badLimit).toBe(2);
    expect(errors.join('\n')).toContain('--limit');

    const watchLimit = await runCli(
      ['review', 'watch', '--config', configPath, '--project', directory, '--limit', '1'],
      { cwd: directory, io },
    );
    expect(watchLimit).toBe(2);
    expect(errors.join('\n')).toContain('unknown option "--limit"');
  });

  it.each(['source', 'delivery'])(
    'refuses a review command when the project has no %s',
    async (field) => {
      const directory = await createTempDir();
      const project = { ...projectConfig() };
      delete project[field];
      const { harnessPath: configPath } = await writeFixtureConfig(directory, {}, project);
      const err: string[] = [];
      const code = await runCli(
        ['review', 'scan', '--config', configPath, '--project', directory],
        {
          cwd: directory,
          io: { out: () => undefined, err: (text) => err.push(text) },
        },
      );
      expect(code).toBe(EXIT_INPUT_ERROR);
      expect(err.join('\n')).toContain('has no review path');
      expect(err.join('\n')).toContain(`"${field}"`);
      expect(err.join('\n')).toContain(configPath);
      expect(err.join('\n')).toContain(path.join(directory, PROJECT_CONFIG_FILE_NAME));
    },
  );

  it('prints the review selection in check-config, without resolving its key', async () => {
    const directory = await createTempDir();
    const { harnessPath: configPath } = await writeFixtureConfig(directory);
    const out: string[] = [];
    const previous = process.env.NEXUS_LENS_KEY_PATH;
    delete process.env.NEXUS_LENS_KEY_PATH;
    try {
      const code = await runCli(['check-config', '--config', configPath, '--project', directory], {
        cwd: directory,
        io: { out: (text) => out.push(text), err: () => undefined },
      });
      expect(code).toBe(EXIT_OK);
    } finally {
      if (previous !== undefined) {
        process.env.NEXUS_LENS_KEY_PATH = previous;
      }
    }
    const printed = out.join('\n');
    expect(printed).toContain(`review                 github ${REPOSITORY} as ${LOGIN}`);
    expect(printed).toContain('review scanning        In Review');
    expect(printed).toContain('check "Nexus Lens review"');
    expect(printed).toContain('review reviewer        codex codex --profile nexus-astra');
  });
});

// ---------------------------------------------------------------------------
// The pieces the tests above stand in for
// ---------------------------------------------------------------------------

/**
 * A retained workspace with the two commits one review needs: the recorded base
 * on the checkout's own branch, and the reviewed head on the ticket's
 * `harness/<workspaceId>` branch. It is a real Git repository, written the way a
 * run leaves one.
 */
async function viewWorkspace(): Promise<{
  readonly path: string;
  readonly base: string;
  readonly head: string;
}> {
  const root = await createTempDir();
  const workspacePath = path.join(root, 'workspaces', WORKSPACE_ID);
  await mkdir(workspacePath, { recursive: true });
  git(workspacePath, 'init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(workspacePath, 'README.md'), '# the example project\n', 'utf8');
  git(workspacePath, 'add', '--all');
  git(workspacePath, 'commit', '--quiet', '--message', 'the example project');
  const base = git(workspacePath, 'rev-parse', 'HEAD').trim();

  git(workspacePath, 'checkout', '--quiet', '-b', BRANCH);
  await writeFile(path.join(workspacePath, 'app.mjs'), 'export const ready = true;\n', 'utf8');
  git(workspacePath, 'add', '--all');
  git(workspacePath, 'commit', '--quiet', '--message', 'the reviewed change');
  const head = git(workspacePath, 'rev-parse', 'HEAD').trim();
  return { path: workspacePath, base, head };
}

/** An aborted-never signal: these steps are not the ones a stop races here. */
function neverStopped(): AbortSignal {
  return new AbortController().signal;
}

/**
 * The working-tree assertions read the view through the harness's own check
 * where cleanliness is what matters: the fixtures' Git runs with an isolated
 * configuration (`gitEnvironment`), while the harness runs with the host's, so
 * on a host that sets `core.autocrlf` a freshly checked-out view is clean for
 * the harness and rewritten for a fixture-only `git status`. The head, the
 * content and the missing-remote assertions do not depend on that difference.
 */
describe('the reviewer’s repository view', () => {
  it('pins a clean snapshot at the reviewed head, holding the base commit', async () => {
    const workspace = await viewWorkspace();
    const dir = await createTempDir();

    const view = await prepareReviewView(
      { dir, workspacePath: workspace.path, head: workspace.head, base: workspace.base },
      neverStopped(),
    );

    expect(view).toEqual({
      path: path.join(dir, REVIEW_VIEW_DIRECTORY),
      head: workspace.head,
      base: workspace.base,
    });
    expect(git(view.path, 'rev-parse', 'HEAD').trim()).toBe(workspace.head);
    expect(git(view.path, 'show', 'HEAD:app.mjs')).toBe('export const ready = true;\n');
    expect(git(view.path, 'rev-parse', `${workspace.base}^{commit}`).trim()).toBe(workspace.base);
    // A snapshot, not a channel: the clone keeps no remote at all, and reading
    // it never touches the workspace it came from.
    expect(git(view.path, 'remote')).toBe('');
    // The disposable view's object files must not share hard links with the
    // retained coding workspace, even though this is a local clone.
    expect(
      (
        await stat(
          path.join(
            view.path,
            '.git',
            'objects',
            workspace.head.slice(0, 2),
            workspace.head.slice(2),
          ),
        )
      ).nlink,
    ).toBe(1);
    expect(git(workspace.path, 'status', '--porcelain').trim()).toBe('');
    // The harness's own boundary agrees that nothing in the view changed.
    expect(await reviewViewProblem(view, neverStopped())).toBeNull();
  });

  it('refuses a workspace that is not a Git repository', async () => {
    const root = await createTempDir();
    const dir = await createTempDir();
    const workspacePath = path.join(root, 'workspaces', WORKSPACE_ID);
    await mkdir(workspacePath, { recursive: true });

    await expect(
      prepareReviewView({ dir, workspacePath, head: HEAD, base: BASE }, neverStopped()),
    ).rejects.toThrow(/could not be cloned into a repository view/);
  });

  it('refuses a head or a base the retained workspace does not hold', async () => {
    const workspace = await viewWorkspace();
    const headDir = await createTempDir();
    const baseDir = await createTempDir();

    await expect(
      prepareReviewView(
        { dir: headDir, workspacePath: workspace.path, head: OTHER_HEAD, base: workspace.base },
        neverStopped(),
      ),
    ).rejects.toThrow(new RegExp(`checked out at the reviewed head ${OTHER_HEAD}`));
    await expect(
      prepareReviewView(
        { dir: baseDir, workspacePath: workspace.path, head: workspace.head, base: OTHER_HEAD },
        neverStopped(),
      ),
    ).rejects.toThrow(new RegExp(`base commit ${OTHER_HEAD}`));
  });

  it('refuses a pull request that carries no full commit ids', async () => {
    const workspace = await viewWorkspace();
    const dir = await createTempDir();

    await expect(
      prepareReviewView(
        { dir, workspacePath: workspace.path, head: 'not-a-commit', base: workspace.base },
        neverStopped(),
      ),
    ).rejects.toThrow(/no full head and base commit/);
  });

  it('reports a view that was edited, one left with a new file, and a moved head', async () => {
    const workspace = await viewWorkspace();
    const dir = await createTempDir();
    const view = await prepareReviewView(
      { dir, workspacePath: workspace.path, head: workspace.head, base: workspace.base },
      neverStopped(),
    );

    await writeFile(path.join(view.path, 'app.mjs'), 'export const ready = false;\n', 'utf8');
    expect(await reviewViewProblem(view, neverStopped())).toMatch(/changed path/);
    expect(await reviewViewProblem(view, neverStopped())).toContain('app.mjs');

    git(view.path, 'checkout', '--', 'app.mjs');
    expect(await reviewViewProblem(view, neverStopped())).toBeNull();

    await writeFile(path.join(view.path, 'notes.txt'), 'scratch\n', 'utf8');
    expect(await reviewViewProblem(view, neverStopped())).toContain('notes.txt');
    await rm(path.join(view.path, 'notes.txt'));

    await writeFile(path.join(view.path, 'app.mjs'), 'export const ready = false;\n', 'utf8');
    git(view.path, 'commit', '--quiet', '--all', '--message', 'not the reviewed head');
    expect(await reviewViewProblem(view, neverStopped())).toMatch(/not at the reviewed head/);
  });
});

describe('the review evidence directory', () => {
  it('is generated, exclusive, and named by a timestamp', async () => {
    const workDir = await createTempDir();
    const first = await allocateReviewDirectory(workDir);
    const second = await allocateReviewDirectory(workDir);
    expect(first.reviewId).toMatch(/^review-\d{14}-[0-9a-f]{8}$/);
    expect(second.reviewId).not.toBe(first.reviewId);
    expect(existsSync(first.dir)).toBe(true);
    // A second allocation never reuses or overwrites an existing directory.
    await expect(mkdir(first.dir)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
