/**
 * The Nexus Lens review path as decisions: the reviewer's verdict, the pull
 * request it belongs to, and what one scan publishes.
 *
 * The scan tests drive the real coordinator with a fake queue, a fake
 * repository, a fake repository-view source, and a fake reviewer turn, so
 * eligibility, deduplication, stale results, failures, and limits are asserted
 * from what really happened: which calls arrived in which order, and which
 * native review and check were published. Nothing here starts a child process:
 * the scan, the watch, the configuration and the App key are decided against
 * stand-in collaborators and files. What needs a real repository, a real
 * retained workspace or the built CLI is in
 * `tests/reviews-cli.integration.test.ts`, and the fixtures both halves share
 * are in `tests/reviews-shared.ts`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfiguration } from '../src/config/load.js';
import type { TicketHistory } from '../src/history/contract.js';
import { workspaceHistoryRoot } from '../src/history/paths.js';
import { textSha256 } from '../src/history/reports.js';
import { createTicketHistory } from '../src/history/sync.js';
import type {
  AppCheckRun,
  OpenPullRequest,
  PullRequestReview,
  ReviewEvidence,
  ReviewQueue,
  ReviewRepository,
  ReviewerTurn,
  ReviewerTurnRequest,
  ReviewScanContext,
  ReviewViewSource,
  PublishedCheck,
  PublishedReview,
} from '../src/reviews/contract.js';
import { ReviewError } from '../src/reviews/contract.js';
import { diffPosition, positionFindings } from '../src/reviews/diff.js';
import { appJwt, resolveAppPrivateKey } from '../src/reviews/github.js';
import { parseVerdict, reviewPrompt } from '../src/reviews/reviewer.js';
import { scanReviews, watchReviews } from '../src/reviews/scan.js';
import { REVIEW_VIEW_DIRECTORY } from '../src/reviews/view.js';
import { SourceError } from '../src/sources/contract.js';
import type { SourceCandidate, SourceTask } from '../src/sources/contract.js';
import { receiptFilePath, reserveReceipt } from '../src/sources/receipts.js';
import { canonicalPath } from '../src/workspace/git.js';
import { sourceItemFor, workspaceStatePath } from '../src/workspace/state.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

import {
  APPROVE,
  BASE,
  BRANCH,
  CHECK_NAME,
  HEAD,
  LOGIN,
  OTHER_HEAD,
  PATCH,
  REQUEST_CHANGES,
  REPOSITORY,
  REVIEWED_FILE,
  SCOPE,
  WORKSPACE_ID,
  candidateFor,
  evidenceFor,
  fixtureReviewer,
  preparedFor,
  projectConfig,
  pullFor,
  refFor,
  reviewDirectories,
  taskFor,
  verdictFile,
  viewFor,
  writeFixtureConfig,
  writeReviewLedger,
} from './reviews-shared.js';

afterEach(async () => {
  await cleanupTempDirectories();
});


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
    expect(prompt).toContain(`git -C repo diff ${BASE}...${HEAD}`);
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
  /** The conversation snapshot each reviewer turn was handed, in order. */
  readonly histories: Array<ReviewerTurnRequest['history']>;
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
    readonly history?: TicketHistory;
    /** A caller-owned output directory, when the test prepared one itself. */
    readonly workDir?: string;
    readonly stop?: AbortSignal;
  } = {},
): Promise<ScanFixture> {
  const workDir = options.workDir ?? (await createTempDir());
  await writeReviewLedger(workDir);
  const output: string[] = [];
  const errors: string[] = [];
  const reviewerRuns: ReviewEvidence[] = [];
  const histories: Array<ReviewerTurnRequest['history']> = [];
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
      histories.push(request.history);
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
    ...(options.history === undefined ? {} : { history: options.history }),
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
  return { context, output, errors, workDir, reviewerRuns, histories, views };
}

/** The one review directory a scan left, when it left one. */

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

  it('carries the ticket conversation into the reviewer turn, whole, without a connector call', async () => {
    const workDir = await createTempDir();
    await writeReviewLedger(workDir);
    const longFinding = `A finding past the old per-comment budgets. ${'y'.repeat(4_000)}`;
    const history = createTicketHistory({
      workDir,
      readers: {
        jiraThread: async () => ({
          comments: [
            {
              sourceId: '7001',
              author: 'Jane Reviewer',
              createdAt: '2026-09-19T10:00:00.000Z',
              updatedAt: null,
              text: 'Please keep the complete wording locally.',
              url: null,
            },
          ],
          truncated: false,
        }),
        pullRequestConversation: async () => null,
      },
      now: () => new Date('2026-09-19T12:00:00.000Z'),
    });
    await history.recordReviewerReport?.({
      ref: refFor(),
      workspaceId: WORKSPACE_ID,
      task: taskFor(),
      reviewId: 'review-previous',
      round: 1,
      head: BASE,
      decision: 'request_changes',
      summary: 'One finding.',
      findings: [{ path: REVIEWED_FILE, line: 2, body: longFinding }],
      now: new Date('2026-09-19T11:00:00.000Z'),
    });
    const repository = fakeRepository();
    const fixture = await scanFixture({ repository, history, workDir });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ reviewed: 1, attention: 0 });
    const snapshot = fixture.histories[0];
    expect(snapshot).toBeDefined();
    expect(snapshot?.role).toBe('reviewer');
    expect(snapshot?.indexPath).toBe(
      path.join(
        workspaceHistoryRoot(workDir, WORKSPACE_ID),
        'snapshots',
        snapshot?.id ?? '',
        'index.md',
      ),
    );
    expect(snapshot?.brief.unresolved?.findings[0]?.body).toBe(longFinding);
    const prompt = reviewPrompt(
      evidenceFor(),
      { path: '/evidence/repo', head: HEAD, base: BASE },
      '/evidence',
      snapshot,
    );
    expect(prompt).toContain(snapshot?.indexPath ?? '');
    expect(prompt).toContain(longFinding);
    // The complete reviewer report was saved before the native rendering, and
    // the rendering names it so a later synchronization does not duplicate it.
    const reports = await readdir(
      path.join(workspaceHistoryRoot(workDir, WORKSPACE_ID), 'reports'),
    );
    expect(reports.some((name) => name.startsWith('reviewer-') && name.endsWith('.json'))).toBe(
      true,
    );
    expect(repository.calls.publishedReviews[0]?.body).toContain('nexus-history: reviewer review-');
    // The scan's own record names the snapshot the turn was given.
    const reviewDir = (await reviewDirectories(workDir))[0] ?? '';
    const record = JSON.parse(
      await readFile(path.join(workDir, 'reviews', reviewDir, 'review.json'), 'utf8'),
    ) as { history?: string | null };
    expect(record.history).toBe(snapshot?.dir);
  });

  it('leaves the ticket for attention, and starts no turn, when the conversation cannot be prepared', async () => {
    const history: TicketHistory = {
      prepare: async () => {
        throw new Error('the history directory could not be written beside the workspace');
      },
    };
    const repository = fakeRepository();
    const fixture = await scanFixture({ repository, history });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ attention: 1, reviewed: 0, reviewerRuns: 0 });
    expect(fixture.errors.join('\n')).toContain('local conversation history could not be prepared');
    expect(fixture.reviewerRuns).toEqual([]);
    expect(repository.calls.publishedReviews).toEqual([]);
  });

  it('retains an inconclusive reviewer report even though it publishes no review', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      readers: {
        jiraThread: async () => ({ comments: [], truncated: false }),
        pullRequestConversation: async () => null,
      },
    });
    const body = 'Unable to assess the change. ' + 'Full evidence\n'.repeat(800);
    const repository = fakeRepository();
    const fixture = await scanFixture({
      repository,
      workDir,
      history,
      reviewer: async (request) => ({
        summary: body,
        verdict: { decision: 'inconclusive', summary: body, findings: [] },
        problem: null,
        logPath: path.join(request.dir, 'reviewer.log'),
      }),
    });
    await scanReviews(fixture.context);
    expect(repository.calls.publishedReviews).toHaveLength(0);
    const root = workspaceHistoryRoot(workDir, WORKSPACE_ID);
    const files = await readdir(path.join(root, 'reports'));
    const report = files.find((file) => file.endsWith('.md'));
    expect(report).toBeDefined();
    expect(await readFile(path.join(root, 'reports', report ?? ''), 'utf8')).toContain(body.trim());
  });

  it('saves the complete reviewer report before the native review that renders it', async () => {
    const workDir = await createTempDir();
    await writeReviewLedger(workDir);
    const events: string[] = [];
    const real = createTicketHistory({
      workDir,
      readers: {
        jiraThread: async () => ({ comments: [], truncated: false }),
        pullRequestConversation: async () => null,
      },
      now: () => new Date('2026-09-19T12:00:00.000Z'),
    });
    const history: TicketHistory = {
      prepare: real.prepare,
      recordReviewerReport: async (request) => {
        events.push('record');
        return await real.recordReviewerReport!(request);
      },
    };
    const base = fakeRepository();
    const repository = {
      repository: {
        ...base.repository,
        publishReview: async (
          request: Parameters<ReviewRepository['publishReview']>[0],
          stop: AbortSignal,
        ) => {
          events.push('publish');
          return await base.repository.publishReview(request, stop);
        },
      } satisfies ReviewRepository,
      calls: base.calls,
    };
    const findingBody = `The complete finding, longer than an ordinary comment budget. ${'z'.repeat(3_000)}`;
    const fixture = await scanFixture({
      repository,
      history,
      workDir,
      reviewer: async (request) => ({
        summary: 'changes requested',
        verdict: {
          decision: 'request_changes',
          summary: 'One blocking finding.',
          findings: [{ path: REVIEWED_FILE, line: 2, body: findingBody }],
        },
        problem: null,
        logPath: path.join(request.dir, 'reviewer.log'),
      }),
    });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ reviewed: 1, changesRequested: 1 });
    expect(events).toEqual(['record', 'publish']);
    const reports = await readdir(
      path.join(workspaceHistoryRoot(workDir, WORKSPACE_ID), 'reports'),
    );
    const completeName = reports.find(
      (name) => name.startsWith('reviewer-') && name.endsWith('.md'),
    );
    expect(completeName).toBeDefined();
    const complete = await readFile(
      path.join(workspaceHistoryRoot(workDir, WORKSPACE_ID), 'reports', completeName ?? ''),
      'utf8',
    );
    expect(complete).toContain(findingBody);
    // The native review that rendered it is recorded as the report's
    // publication, with the body it published: a later synchronization
    // authenticates the review by that identity, not by the marker wording.
    const digestName = reports.find(
      (name) =>
        name.startsWith('reviewer-') && name.endsWith('.json') && !name.endsWith('.verdict.json'),
    );
    const digest = JSON.parse(
      await readFile(
        path.join(workspaceHistoryRoot(workDir, WORKSPACE_ID), 'reports', digestName ?? ''),
        'utf8',
      ),
    ) as {
      readonly published: {
        readonly id: number;
        readonly url: string;
        readonly bodySha256: string | null;
      } | null;
    };
    expect(digest.published?.id).toBe(5256006204);
    expect(digest.published?.url).toContain('#review');
    expect(digest.published?.bodySha256).toBe(
      textSha256(repository.calls.publishedReviews[0]?.body ?? ''),
    );
  });

  it('reviews a ticket description too large for the prompt when the history carries it whole', async () => {
    const workDir = await createTempDir();
    await writeReviewLedger(workDir);
    const history = createTicketHistory({
      workDir,
      readers: {
        jiraThread: async () => ({ comments: [], truncated: false }),
        pullRequestConversation: async () => null,
      },
      now: () => new Date('2026-09-19T12:00:00.000Z'),
    });
    const repository = fakeRepository();
    const fixture = await scanFixture({ repository, history, workDir });
    fixture.context.queue.prepare = async () => ({
      ...preparedFor(),
      task: { ...taskFor(), description: 'x'.repeat(8_001) },
    });

    const summary = await scanReviews(fixture.context);

    expect(summary).toMatchObject({ reviewed: 1, attention: 0 });
    expect(fixture.histories[0]?.brief.task.description).toHaveLength(8_001);
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
