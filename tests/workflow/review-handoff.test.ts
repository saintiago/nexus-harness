/**
 * The second workflow: the delivered attempt of a ticket is handed to the
 * reviewer, which inspects the retained workspace itself and whose verdict is
 * published against the exact head it was made on.
 *
 * A real run produces the retained workspace and its delivered revision, the
 * scan resolves that workspace from the ticket's pointer label, the view is the
 * real clone pinned at the reviewed head, and the reviewer turn is the real
 * adapter launching a stand-in runtime — the substitution `runtime.ts` names for
 * another runtime. Only the Jira queue and the GitHub repository are controlled
 * responses: the two live services this layer never contacts.
 *
 * The archived `reviews-cli.integration.test.ts` proved the handoff from the
 * ticket's own retained workspace through the CLI; this case is what carries
 * its required behavior now, at the layer that owns it
 * (tests_old/REFERENCE.txt).
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTask } from '../../src/config/load.js';
import type {
  AppCheckRun,
  OpenPullRequest,
  PublishCheckRequest,
  PublishReviewRequest,
  PublishedCheck,
  PublishedReview,
  PullRequestReview,
  ReviewEvidence,
  ReviewRepository,
} from '../../src/reviews/contract.js';
import { createReviewerTurn } from '../../src/reviews/reviewer.js';
import { scanReviews } from '../../src/reviews/scan.js';
import type { HistorySnapshot, TicketHistory } from '../../src/history/contract.js';
import { workspaceHistoryRoot } from '../../src/history/paths.js';
import { createTicketHistory } from '../../src/history/sync.js';
import { REVIEW_VIEW_DIRECTORY, reviewViews } from '../../src/reviews/view.js';
import type { SourceTask } from '../../src/sources/contract.js';
import type { SourceRef } from '../../src/shared/types.js';
import { canonicalPath } from '../../src/workspace/git.js';
import { gitOrFail, installStandIn, useOwnedProcesses } from '../boundary/integration-support.js';
import {
  TARGET_RESULT_DONE,
  TARGET_RESULT_FILE,
  WORKFLOW_CASE_TIMEOUT_MS,
  branchHead,
  createTargetProject,
  implementTurn,
  recordingIo,
  runTicket,
} from './support.js';

useOwnedProcesses();

/** The site and ticket every case of this suite works with. */
const SITE = 'https://example.atlassian.net';
const REF: SourceRef = {
  type: 'jira',
  scope: SITE,
  id: '10077',
  key: 'HARN-77',
  url: `${SITE}/browse/HARN-77`,
  updatedAt: '2026-03-01T10:00:00.000Z',
};
const WORKSPACE_ID = 'HARN-77';
const BASE_BRANCH = 'main';
const CHECK_NAME = 'Nexus Lens review';
const LOGIN = 'nexus-lens[bot]';

/**
 * A stand-in reviewer runtime: a real program the real adapter starts, exactly
 * as it starts the installed runtime. It reads the prompt from standard input,
 * writes the verdict into its own working root — the review's evidence
 * directory the turn was given — and reports a completed turn on the event
 * stream the adapter reads.
 */
const STAND_IN_REVIEWER = [
  `import { writeFileSync } from 'node:fs';`,
  `let prompt = '';`,
  `process.stdin.setEncoding('utf8');`,
  `process.stdin.on('data', (chunk) => { prompt += chunk; });`,
  `process.stdin.on('end', () => {`,
  `  const verdict =`,
  `    process.env.NEXUS_STAND_IN_VERDICT ??`,
  `    '{"verdict":"approve","summary":"the change does what the ticket asks","findings":[]}';`,
  `  writeFileSync('verdict.json', verdict + '\\n', 'utf8');`,
  `  process.stdout.write(`,
  `    JSON.stringify({ type: 'thread.started', thread_id: 'stand-in-reviewer' }) + '\\n',`,
  `  );`,
  `  process.stdout.write(`,
  `    JSON.stringify({`,
  `      type: 'item.completed',`,
  `      item: { type: 'agent_message', text: 'the stand-in reviewer read the change' },`,
  `    }) + '\\n',`,
  `  );`,
  `  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');`,
  `});`,
  '',
].join('\n');

/** What the controlled GitHub side of one review recorded. */
interface RecordedGitHub {
  readonly repository: ReviewRepository;
  readonly reviews: readonly PublishReviewRequest[];
  readonly checks: readonly PublishCheckRequest[];
}

/** A stand-in GitHub repository: one open pull request at `head`, nothing published yet. */
function standInGitHub(pullRequest: OpenPullRequest, evidence: ReviewEvidence): RecordedGitHub {
  const reviews: PublishReviewRequest[] = [];
  const checks: PublishCheckRequest[] = [];
  const repository: ReviewRepository = {
    findOpenPullRequest: async (branch) => (branch === pullRequest.headBranch ? pullRequest : null),
    readPullRequest: async (number) => (number === pullRequest.number ? pullRequest : null),
    listReviews: async (): Promise<readonly PullRequestReview[]> => [],
    readEvidence: async () => evidence,
    publishReview: async (request: PublishReviewRequest): Promise<PublishedReview> => {
      reviews.push(request);
      return {
        id: 9001,
        url: 'https://github.com/example/target/pull/42#pullrequestreview-9001',
        state: request.decision === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED',
      };
    },
    publishCheck: async (request: PublishCheckRequest): Promise<PublishedCheck> => {
      checks.push(request);
      return {
        id: 7001,
        url: 'https://github.com/example/target/checks/7001',
        conclusion: request.decision === 'approve' ? 'success' : 'failure',
      };
    },
    reviewChecks: async (): Promise<readonly AppCheckRun[]> => [],
  };
  return { repository, reviews, checks };
}

describe('the review handoff', () => {
  it(
    'hands the delivered revision to a reviewer and publishes its verdict against that head',
    { timeout: WORKFLOW_CASE_TIMEOUT_MS },
    async () => {
      const project = await createTargetProject();
      const run = await runTicket({
        project,
        ref: REF,
        workspaceId: WORKSPACE_ID,
        turn: implementTurn,
      });
      const workspace = run.workspace;
      expect(workspace).not.toBeNull();
      const workspacePath = workspace?.workspacePath ?? '';
      const head = await branchHead(workspacePath, workspace?.branch ?? '');
      expect(run.status).toBe('passed');
      expect(run.reportPath.startsWith(project.workDir)).toBe(true);

      const pullRequest: OpenPullRequest = {
        number: 42,
        url: 'https://github.com/example/target/pull/42',
        title: 'HARN-77: Finish the greeting',
        headSha: head,
        headBranch: `harness/${WORKSPACE_ID}`,
        baseBranch: BASE_BRANCH,
        baseSha: workspace?.baseCommit ?? '',
        draft: false,
        author: 'nexus-agent',
      };
      const task = await loadTask(project.taskPath);
      const github = standInGitHub(pullRequest, {
        ref: REF,
        task,
        pullRequest,
        files: [
          {
            path: TARGET_RESULT_FILE,
            patch: `@@ -0,0 +1 @@\n+implemented\n`,
            additions: 1,
            deletions: 0,
          },
        ],
        truncated: false,
        checks: [],
        combinedStatus: null,
        fetchedAt: '2026-03-01T11:00:00.000Z',
      });

      const standIn = await installStandIn('reviewer-runtime', STAND_IN_REVIEWER);
      const item: SourceTask = { ref: REF, task, pointers: [WORKSPACE_ID] };
      const recorded = recordingIo();
      const summary = await scanReviews({
        queue: {
          list: async () => [{ ref: REF, title: task.title }],
          prepare: async () => item,
        },
        repository: github.repository,
        reviewer: createReviewerTurn({
          selection: { runtime: 'codex', command: [process.execPath, standIn.scriptPath] },
          environment: process.env,
        }),
        views: reviewViews(),
        workDir: project.workDir,
        sourceRoot: canonicalPath(project.repo),
        login: LOGIN,
        checkName: CHECK_NAME,
        reviewerTimeoutMs: 60_000,
        io: recorded.io,
        stop: new AbortController().signal,
        now: () => new Date('2026-03-01T11:05:00.000Z'),
        sleep: async () => undefined,
      });

      expect(recorded.err).toEqual([]);
      expect(summary.outcome).toBe('completed');
      expect(summary.items.map((entry) => entry.disposition)).toEqual(['reviewed']);
      expect(summary.approved).toBe(1);
      expect(summary.reviewerRuns).toBe(1);

      // The verdict was published against the delivered head and nothing else.
      expect(github.reviews).toHaveLength(1);
      expect(github.reviews[0]?.head).toBe(head);
      expect(github.reviews[0]?.decision).toBe('approve');
      expect(github.reviews[0]?.body).toContain(REF.key);
      expect(github.checks).toEqual([expect.objectContaining({ head, decision: 'approve' })]);

      // The reviewer inspected a real clone of the retained workspace, pinned at
      // the reviewed head and holding the delivered change — not an assembled
      // patch, and not the workspace itself.
      const [reviewId] = (await readdir(path.join(project.workDir, 'reviews'))).filter((entry) =>
        entry.startsWith('review-'),
      );
      const reviewDir = path.join(project.workDir, 'reviews', reviewId ?? '');
      const viewPath = path.join(reviewDir, REVIEW_VIEW_DIRECTORY);
      expect((await gitOrFail(['rev-parse', 'HEAD'], viewPath)).trim()).toBe(head);
      // Git materializes the committed content for this host, so the line ending
      // the clone writes is the host's; the file's own text is what the view holds.
      expect((await readFile(path.join(viewPath, TARGET_RESULT_FILE), 'utf8')).trim()).toBe(
        TARGET_RESULT_DONE.trim(),
      );

      // The turn's own evidence is kept beside the view: the prompt it was given,
      // the verdict it wrote, its log, and the scan's record of the attempt.
      const prompt = await readFile(path.join(reviewDir, 'input.md'), 'utf8');
      expect(prompt).toContain(REF.key);
      expect(prompt).toContain(viewPath);
      expect(
        JSON.parse(await readFile(path.join(reviewDir, 'verdict.json'), 'utf8')),
      ).toMatchObject({
        verdict: 'approve',
      });
      expect(await readFile(path.join(reviewDir, 'reviewer.log'), 'utf8')).toContain(
        '# completed: exit code 0',
      );
      const record = JSON.parse(await readFile(path.join(reviewDir, 'review.json'), 'utf8')) as {
        readonly verdict: string;
        readonly disposition: string;
        readonly view: string;
        readonly check: { readonly conclusion: string } | null;
      };
      expect(record).toMatchObject({
        disposition: 'reviewed',
        verdict: 'approve',
        view: viewPath,
        check: { conclusion: 'success' },
      });

      // The workspace the ticket's pointer names is still the delivered revision:
      // a review reads it through a clone and changes nothing.
      expect(await branchHead(workspacePath, workspace?.branch ?? '')).toBe(head);
    },
  );

  it(
    'refuses to publish a verdict that leaves an outstanding disposition unverified',
    { timeout: WORKFLOW_CASE_TIMEOUT_MS },
    async () => {
      const project = await createTargetProject();
      const run = await runTicket({
        project,
        ref: REF,
        workspaceId: WORKSPACE_ID,
        turn: implementTurn,
      });
      const workspace = run.workspace;
      const head = await branchHead(workspace?.workspacePath ?? '', workspace?.branch ?? '');
      expect(run.status).toBe('passed');

      const pullRequest: OpenPullRequest = {
        number: 42,
        url: 'https://github.com/example/target/pull/42',
        title: 'HARN-77: Finish the greeting',
        headSha: head,
        headBranch: `harness/${WORKSPACE_ID}`,
        baseBranch: BASE_BRANCH,
        baseSha: workspace?.baseCommit ?? '',
        draft: false,
        author: 'nexus-agent',
      };
      const task = await loadTask(project.taskPath);
      const github = standInGitHub(pullRequest, {
        ref: REF,
        task,
        pullRequest,
        files: [
          {
            path: TARGET_RESULT_FILE,
            patch: `@@ -0,0 +1 @@\n+implemented\n`,
            additions: 1,
            deletions: 0,
          },
        ],
        truncated: false,
        checks: [],
        combinedStatus: null,
        fetchedAt: '2026-03-01T11:00:00.000Z',
      });
      // The ticket history this revision's review starts from: one change
      // request is outstanding, so the verdict has to verify its disposition or
      // nothing is published.
      const history = historyWithOutstandingFinding();
      const standIn = await installStandIn('reviewer-runtime-unverified', STAND_IN_REVIEWER);
      const recorded = recordingIo();
      const summary = await scanReviews({
        queue: {
          list: async () => [{ ref: REF, title: task.title }],
          prepare: async () => ({ ref: REF, task, pointers: [WORKSPACE_ID] }),
        },
        repository: github.repository,
        reviewer: createReviewerTurn({
          selection: { runtime: 'codex', command: [process.execPath, standIn.scriptPath] },
          // The verdict the stand-in writes asks for changes and verifies
          // nothing: the claimed repair is not a verified one.
          environment: {
            ...process.env,
            NEXUS_STAND_IN_VERDICT: JSON.stringify({
              verdict: 'request_changes',
              summary: 'the same defect is still there',
              findings: [{ path: TARGET_RESULT_FILE, line: 1, body: 'still missing' }],
            }),
          },
        }),
        history,
        views: reviewViews(),
        workDir: project.workDir,
        sourceRoot: canonicalPath(project.repo),
        login: LOGIN,
        checkName: CHECK_NAME,
        reviewerTimeoutMs: 60_000,
        io: recorded.io,
        stop: new AbortController().signal,
        now: () => new Date('2026-03-01T11:05:00.000Z'),
        sleep: async () => undefined,
      });

      // Nothing was published: an unverified disposition is not a published
      // verdict, and the report is retained as the incomplete exchange it is.
      expect(summary.items.map((entry) => entry.disposition)).toEqual(['attention']);
      expect(summary.attention).toBe(1);
      expect(github.reviews).toEqual([]);
      expect(github.checks).toEqual([]);
      expect(recorded.text()).toMatch(/does not verify R2-F1/);
      expect(history.recorded).toEqual([]);
      // The refusal is kept with the turn's own evidence for the coordinator.
      const [reviewId] = (await readdir(path.join(project.workDir, 'reviews'))).filter((entry) =>
        entry.startsWith('review-'),
      );
      const reviewDir = path.join(project.workDir, 'reviews', reviewId ?? '');
      expect(
        JSON.parse(await readFile(path.join(reviewDir, 'verdict.json'), 'utf8')),
      ).toMatchObject({ verdict: 'request_changes' });
    },
  );

  it(
    'publishes a verified disposition as a verification, never as the developer’s claim',
    { timeout: WORKFLOW_CASE_TIMEOUT_MS },
    async () => {
      const project = await createTargetProject();
      const run = await runTicket({
        project,
        ref: REF,
        workspaceId: WORKSPACE_ID,
        turn: implementTurn,
      });
      const workspace = run.workspace;
      const head = await branchHead(workspace?.workspacePath ?? '', workspace?.branch ?? '');
      expect(run.status).toBe('passed');

      const pullRequest: OpenPullRequest = {
        number: 42,
        url: 'https://github.com/example/target/pull/42',
        title: 'HARN-77: Finish the greeting',
        headSha: head,
        headBranch: `harness/${WORKSPACE_ID}`,
        baseBranch: BASE_BRANCH,
        baseSha: workspace?.baseCommit ?? '',
        draft: false,
        author: 'nexus-agent',
      };
      const task = await loadTask(project.taskPath);
      const github = standInGitHub(pullRequest, {
        ref: REF,
        task,
        pullRequest,
        files: [
          {
            path: TARGET_RESULT_FILE,
            patch: `@@ -0,0 +1 @@\n+implemented\n`,
            additions: 1,
            deletions: 0,
          },
        ],
        truncated: false,
        checks: [],
        combinedStatus: null,
        fetchedAt: '2026-03-01T11:00:00.000Z',
      });
      const history = historyWithOutstandingFinding();
      const standIn = await installStandIn('reviewer-runtime-verified', STAND_IN_REVIEWER);
      const recorded = recordingIo();
      const summary = await scanReviews({
        queue: {
          list: async () => [{ ref: REF, title: task.title }],
          prepare: async () => ({ ref: REF, task, pointers: [WORKSPACE_ID] }),
        },
        repository: github.repository,
        reviewer: createReviewerTurn({
          selection: { runtime: 'codex', command: [process.execPath, standIn.scriptPath] },
          environment: {
            ...process.env,
            NEXUS_STAND_IN_VERDICT: JSON.stringify({
              verdict: 'approve',
              summary: 'the repair holds and the change does what the ticket asks',
              findings: [],
              verifications: [
                {
                  finding: 'R2-F1',
                  state: 'verified',
                  evidence: `read ${TARGET_RESULT_FILE} at the reviewed head`,
                },
              ],
            }),
          },
        }),
        history,
        views: reviewViews(),
        workDir: project.workDir,
        sourceRoot: canonicalPath(project.repo),
        login: LOGIN,
        checkName: CHECK_NAME,
        reviewerTimeoutMs: 60_000,
        io: recorded.io,
        stop: new AbortController().signal,
        now: () => new Date('2026-03-01T11:05:00.000Z'),
        sleep: async () => undefined,
      });

      expect(summary.items.map((entry) => entry.disposition)).toEqual(['reviewed']);
      expect(summary.approved).toBe(1);
      // The published review says what the reviewer verified itself, so the
      // claim and the verification are not the same sentence on GitHub either.
      const body = github.reviews[0]?.body ?? '';
      expect(body).toContain('Dispositions of earlier findings, as verified by this review:');
      expect(body).toContain(`R2-F1 — verified: read ${TARGET_RESULT_FILE} at the reviewed head`);
      // The review record keeps the recorded verification with the attempt.
      const [reviewId] = (await readdir(path.join(project.workDir, 'reviews'))).filter((entry) =>
        entry.startsWith('review-'),
      );
      const record = JSON.parse(
        await readFile(
          path.join(project.workDir, 'reviews', reviewId ?? '', 'review.json'),
          'utf8',
        ),
      ) as { readonly verifications: readonly { readonly finding: string }[] };
      expect(record.verifications.map((verification) => verification.finding)).toEqual(['R2-F1']);
    },
  );

  it(
    'requires a verdict to verify a finding carried forward from an earlier round',
    { timeout: WORKFLOW_CASE_TIMEOUT_MS },
    async () => {
      const project = await createTargetProject();
      const run = await runTicket({
        project,
        ref: REF,
        workspaceId: WORKSPACE_ID,
        turn: implementTurn,
      });
      const workspace = run.workspace;
      const head = await branchHead(workspace?.workspacePath ?? '', workspace?.branch ?? '');
      expect(run.status).toBe('passed');

      const pullRequest: OpenPullRequest = {
        number: 42,
        url: 'https://github.com/example/target/pull/42',
        title: 'HARN-77: Finish the greeting',
        headSha: head,
        headBranch: `harness/${WORKSPACE_ID}`,
        baseBranch: BASE_BRANCH,
        baseSha: workspace?.baseCommit ?? '',
        draft: false,
        author: 'nexus-agent',
      };
      const task = await loadTask(project.taskPath);
      const github = standInGitHub(pullRequest, {
        ref: REF,
        task,
        pullRequest,
        files: [
          {
            path: TARGET_RESULT_FILE,
            patch: `@@ -0,0 +1 @@\n+implemented\n`,
            additions: 1,
            deletions: 0,
          },
        ],
        truncated: false,
        checks: [],
        combinedStatus: null,
        fetchedAt: '2026-03-01T11:00:00.000Z',
      });

      // The ticket's retained history, read back by the real synchronization:
      // round 1 raised R1-F1 and the next attempt answered it, and round 2
      // asked for changes over an independent defect while recording R1-F1 as
      // still unverified. The second change request must not clear it.
      const history = createTicketHistory({
        workDir: project.workDir,
        harnessAuthors: [LOGIN],
        now: () => new Date('2026-03-01T10:00:00.000Z'),
        readers: {
          jiraThread: async () => ({ comments: [], truncated: false }),
          pullRequestConversation: async () => null,
        },
      });
      await history.recordReviewerReport?.({
        ref: REF,
        workspaceId: WORKSPACE_ID,
        task,
        reviewId: 'review-1',
        round: 1,
        head,
        decision: 'request_changes',
        summary: 'the greeting ignores the argument it is given',
        findings: [
          {
            path: TARGET_RESULT_FILE,
            line: 1,
            body: 'the greeting ignores the argument it is given',
          },
        ],
        now: new Date('2026-03-01T09:00:00.000Z'),
      });
      await history.recordDeveloperReport?.({
        ref: REF,
        workspaceId: WORKSPACE_ID,
        task,
        round: 2,
        runId: 'run-2',
        reportPath: path.join(project.workDir, 'runs', 'run-2', 'result.json'),
        status: 'in-progress',
        reason: 'Coding turn reports retained.',
        repairsUsed: 0,
        attempts: [
          {
            turn: 1,
            kind: 'repair',
            agentSummary: [
              'I repaired the greeting.',
              '',
              '### Finding R1-F1',
              '- Cause: the shared helper ignored the argument it was given.',
              `- Affected scope: ${TARGET_RESULT_FILE}.`,
              '- Repair: the helper now returns the greeting it was given.',
              '- Verification: exercised it through the exported function.',
              '- Remaining uncertainty: none.',
            ].join('\n'),
            checks: 'passed',
          },
        ],
        pullRequest: null,
        deliveryFailure: null,
        now: new Date('2026-03-01T09:30:00.000Z'),
      });
      await history.recordReviewerReport?.({
        ref: REF,
        workspaceId: WORKSPACE_ID,
        task,
        reviewId: 'review-2',
        round: 2,
        head,
        decision: 'request_changes',
        summary: 'one repair did not hold and another defect is new',
        findings: [{ path: TARGET_RESULT_FILE, line: 1, body: 'the result file is still wrong' }],
        verifications: [
          {
            finding: 'R1-F1',
            state: 'unverified',
            evidence: `read ${TARGET_RESULT_FILE} at the reviewed head`,
          },
        ],
        now: new Date('2026-03-01T09:45:00.000Z'),
      });

      const standIn = await installStandIn('reviewer-runtime-carried', STAND_IN_REVIEWER);
      const recorded = recordingIo();
      const summary = await scanReviews({
        queue: {
          list: async () => [{ ref: REF, title: task.title }],
          prepare: async () => ({ ref: REF, task, pointers: [WORKSPACE_ID] }),
        },
        repository: github.repository,
        reviewer: createReviewerTurn({
          selection: { runtime: 'codex', command: [process.execPath, standIn.scriptPath] },
          // The verdict verifies the newer identity and ignores the one
          // carried forward: nothing may be published for it.
          environment: {
            ...process.env,
            NEXUS_STAND_IN_VERDICT: JSON.stringify({
              verdict: 'approve',
              summary: 'the newer defect is gone',
              findings: [],
              verifications: [
                {
                  finding: 'R2-F1',
                  state: 'verified',
                  evidence: `read ${TARGET_RESULT_FILE} at the reviewed head`,
                },
              ],
            }),
          },
        }),
        history,
        views: reviewViews(),
        workDir: project.workDir,
        sourceRoot: canonicalPath(project.repo),
        login: LOGIN,
        checkName: CHECK_NAME,
        reviewerTimeoutMs: 60_000,
        io: recorded.io,
        stop: new AbortController().signal,
        now: () => new Date('2026-03-01T11:05:00.000Z'),
        sleep: async () => undefined,
      });

      // The carried finding was still outstanding in the brief, so the verdict
      // that leaves it unverified publishes nothing at all.
      expect(summary.items.map((entry) => entry.disposition)).toEqual(['attention']);
      expect(github.reviews).toEqual([]);
      expect(github.checks).toEqual([]);
      expect(recorded.text()).toMatch(/does not verify R1-F1/);
      const [reviewId] = (await readdir(path.join(project.workDir, 'reviews'))).filter((entry) =>
        entry.startsWith('review-'),
      );
      const prompt = await readFile(
        path.join(project.workDir, 'reviews', reviewId ?? '', 'input.md'),
        'utf8',
      );
      expect(prompt).toContain('Outstanding identities you must verify: R1-F1, R2-F1.');
      expect(prompt).toContain(
        'The ticket history above lists every review round whose change request is still',
      );
    },
  );

  it(
    'keeps a finding a refused review read as verified, and still requires the next verdict',
    { timeout: WORKFLOW_CASE_TIMEOUT_MS },
    async () => {
      const project = await createTargetProject();
      const run = await runTicket({
        project,
        ref: REF,
        workspaceId: WORKSPACE_ID,
        turn: implementTurn,
      });
      const workspace = run.workspace;
      const head = await branchHead(workspace?.workspacePath ?? '', workspace?.branch ?? '');
      expect(run.status).toBe('passed');

      const pullRequest: OpenPullRequest = {
        number: 42,
        url: 'https://github.com/example/target/pull/42',
        title: 'HARN-77: Finish the greeting',
        headSha: head,
        headBranch: `harness/${WORKSPACE_ID}`,
        baseBranch: BASE_BRANCH,
        baseSha: workspace?.baseCommit ?? '',
        draft: false,
        author: 'nexus-agent',
      };
      const task = await loadTask(project.taskPath);
      const github = standInGitHub(pullRequest, {
        ref: REF,
        task,
        pullRequest,
        files: [
          {
            path: TARGET_RESULT_FILE,
            patch: `@@ -0,0 +1 @@\n+implemented\n`,
            additions: 1,
            deletions: 0,
          },
        ],
        truncated: false,
        checks: [],
        combinedStatus: null,
        fetchedAt: '2026-03-01T11:00:00.000Z',
      });
      // The ticket's retained history: round 1 raised R1-F1 and its change
      // request is outstanding.
      const history = createTicketHistory({
        workDir: project.workDir,
        harnessAuthors: [LOGIN],
        now: () => new Date('2026-03-01T10:00:00.000Z'),
        readers: {
          jiraThread: async () => ({ comments: [], truncated: false }),
          pullRequestConversation: async () => null,
        },
      });
      await history.recordReviewerReport?.({
        ref: REF,
        workspaceId: WORKSPACE_ID,
        task,
        reviewId: 'review-1',
        round: 1,
        head,
        decision: 'request_changes',
        summary: 'the greeting ignores the argument it is given',
        findings: [
          {
            path: TARGET_RESULT_FILE,
            line: 1,
            body: 'the greeting ignores the argument it is given',
          },
        ],
        now: new Date('2026-03-01T09:00:00.000Z'),
      });

      // The first review reads R1-F1 as verified and asks for changes over a
      // second defect, but the ticket changed while the turn ran: the verdict is
      // refused publication. Its complete report was recorded before that
      // guard, and a verdict GitHub never carried settles nothing.
      const refused = await installStandIn('reviewer-runtime-refused', STAND_IN_REVIEWER);
      const first = recordingIo();
      let prepares = 0;
      const firstSummary = await scanReviews({
        queue: {
          list: async () => [{ ref: REF, title: task.title }],
          prepare: async () => {
            prepares += 1;
            return prepares === 1
              ? { ref: REF, task, pointers: [WORKSPACE_ID] }
              : {
                  ref: { ...REF, updatedAt: '2026-03-01T10:30:00.000Z' },
                  task,
                  pointers: [WORKSPACE_ID],
                };
          },
        },
        repository: github.repository,
        reviewer: createReviewerTurn({
          selection: { runtime: 'codex', command: [process.execPath, refused.scriptPath] },
          environment: {
            ...process.env,
            NEXUS_STAND_IN_VERDICT: JSON.stringify({
              verdict: 'request_changes',
              summary: 'one repair is verified and another defect is new',
              findings: [{ path: TARGET_RESULT_FILE, line: 1, body: 'the salutation is wrong' }],
              verifications: [
                {
                  finding: 'R1-F1',
                  state: 'verified',
                  evidence: `read ${TARGET_RESULT_FILE} at the reviewed head`,
                },
              ],
            }),
          },
        }),
        history,
        views: reviewViews(),
        workDir: project.workDir,
        sourceRoot: canonicalPath(project.repo),
        login: LOGIN,
        checkName: CHECK_NAME,
        reviewerTimeoutMs: 60_000,
        io: first.io,
        stop: new AbortController().signal,
        now: () => new Date('2026-03-01T11:05:00.000Z'),
        sleep: async () => undefined,
      });

      expect(firstSummary.items.map((entry) => entry.disposition)).toEqual(['attention']);
      expect(first.text()).toMatch(/changed or is no longer in the configured review status/);
      expect(github.reviews).toEqual([]);
      expect(github.checks).toEqual([]);
      // The refused verdict is kept whole beside the ticket, with its reading of
      // R1-F1, and the review record says nothing was published for it.
      const reportsDir = path.join(workspaceHistoryRoot(project.workDir, WORKSPACE_ID), 'reports');
      const refusedDigests: {
        readonly round?: number;
        readonly findings: readonly { readonly id: string }[];
        readonly verifications: readonly { readonly finding: string; readonly state: string }[];
        readonly published: unknown;
      }[] = [];
      for (const name of await readdir(reportsDir)) {
        if (/^reviewer-.*\.json$/.test(name)) {
          refusedDigests.push(JSON.parse(await readFile(path.join(reportsDir, name), 'utf8')));
        }
      }
      const refusedDigest = refusedDigests.find((digest) => digest.round === 2);
      if (refusedDigest === undefined) {
        throw new Error('the refused verdict of round 2 was retained beside the ticket');
      }
      expect(refusedDigest.findings.map((finding) => finding.id)).toEqual(['R2-F1']);
      expect(refusedDigest.verifications).toEqual([
        {
          finding: 'R1-F1',
          state: 'verified',
          evidence: `read ${TARGET_RESULT_FILE} at the reviewed head`,
        },
      ]);
      expect(refusedDigest.published).toBeNull();

      // The next scan reviews the same head again. Its verdict verifies only the
      // identity the refused review raised, so the disposition it never settled
      // would be published unverified: nothing is published instead.
      const before = new Set(
        (await readdir(path.join(project.workDir, 'reviews'))).filter((entry) =>
          entry.startsWith('review-'),
        ),
      );
      const approving = await installStandIn('reviewer-runtime-partial', STAND_IN_REVIEWER);
      const second = recordingIo();
      const secondSummary = await scanReviews({
        queue: {
          list: async () => [{ ref: REF, title: task.title }],
          prepare: async () => ({ ref: REF, task, pointers: [WORKSPACE_ID] }),
        },
        repository: github.repository,
        reviewer: createReviewerTurn({
          selection: { runtime: 'codex', command: [process.execPath, approving.scriptPath] },
          environment: {
            ...process.env,
            NEXUS_STAND_IN_VERDICT: JSON.stringify({
              verdict: 'approve',
              summary: 'the newer defect is gone',
              findings: [],
              verifications: [
                {
                  finding: 'R2-F1',
                  state: 'verified',
                  evidence: `read ${TARGET_RESULT_FILE} at the reviewed head`,
                },
              ],
            }),
          },
        }),
        history,
        views: reviewViews(),
        workDir: project.workDir,
        sourceRoot: canonicalPath(project.repo),
        login: LOGIN,
        checkName: CHECK_NAME,
        reviewerTimeoutMs: 60_000,
        io: second.io,
        stop: new AbortController().signal,
        now: () => new Date('2026-03-01T11:20:00.000Z'),
        sleep: async () => undefined,
      });

      expect(secondSummary.items.map((entry) => entry.disposition)).toEqual(['attention']);
      expect(github.reviews).toEqual([]);
      expect(second.text()).toMatch(/does not verify R1-F1/);
      const [nextReviewId] = (await readdir(path.join(project.workDir, 'reviews'))).filter(
        (entry) => entry.startsWith('review-') && !before.has(entry),
      );
      const prompt = await readFile(
        path.join(project.workDir, 'reviews', nextReviewId ?? '', 'input.md'),
        'utf8',
      );
      expect(prompt).toContain('Outstanding identities you must verify: R1-F1, R2-F1.');
    },
  );
});

/**
 * A ticket history that hands one review turn the same brief organization the
 * real one does: a round whose change request is outstanding, one finding with
 * the identity it keeps, and the developer's answer to it. The record it keeps
 * is exposed for the case to assert what a refusal did — and did not — save.
 */
function historyWithOutstandingFinding(): TicketHistory & { readonly recorded: unknown[] } {
  const recorded: unknown[] = [];
  const dir = '/work/workspaces/HARN-77.history/snapshots/snapshot-1';
  const review = {
    entryId: 'harness:reviewer-report:review-2',
    kind: 'reviewer-report' as const,
    round: 2,
    author: 'Nexus Lens',
    createdAt: '2026-03-01T10:00:00.000Z',
    sourceId: 'review-2',
    complete: true,
    problem: null,
    status: null,
    reason: null,
    head: 'a'.repeat(40),
    nativeReviewId: null,
    decision: 'request_changes',
    summary: 'the greeting is wrong',
    findings: [
      {
        id: 'R2-F1',
        path: TARGET_RESULT_FILE,
        line: 1,
        body: 'the greeting ignores the argument it is given',
      },
    ],
    responses: [
      {
        finding: 'R2-F1',
        complete: true,
        problem: null,
        cause: 'the helper ignored its argument',
        scope: TARGET_RESULT_FILE,
        repair: 'the helper returns what it was given',
        verification: 'exercised it through the exported function',
        uncertainty: 'none',
        entryId: 'harness:developer-report:run-4',
        runId: 'run-4',
        round: 4,
        createdAt: '2026-03-01T10:30:00.000Z',
      },
    ],
    pullRequest: null,
  };
  const snapshot: HistorySnapshot = {
    version: 1,
    id: 'snapshot-1',
    role: 'reviewer',
    round: 3,
    takenAt: '2026-03-01T11:00:00.000Z',
    root: '/work/workspaces/HARN-77.history',
    dir,
    indexPath: `${dir}/index.md`,
    indexJsonPath: `${dir}/index.json`,
    entriesPath: `${dir}/entries.jsonl`,
    reportsDir: '/work/workspaces/HARN-77.history/reports',
    brief: {
      ref: REF,
      task: { id: REF.key, title: REF.key, description: '', acceptanceCriteria: [] },
      latestDelivery: null,
      unresolved: review,
      unresolvedReviews: [review],
      responses: [],
      newHumanFeedback: [],
    },
    entries: [],
    reports: [review],
    gaps: [],
    mirrors: [],
    sources: [{ source: 'jira', problem: null }],
  };
  return {
    recorded,
    prepare: async () => snapshot,
    recordReviewerReport: async (request) => {
      recorded.push(request);
      return { file: 'digest.json', completeFile: 'report.md', round: request.round };
    },
  };
}
