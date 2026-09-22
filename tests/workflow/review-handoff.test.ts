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
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeDependencies } from '../../src/cli/dependencies.js';
import type { CliContext } from '../../src/cli/context.js';
import { loadConfiguration, loadTask } from '../../src/config/load.js';
import { projectConfigFile } from '../../src/config/paths.js';
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
import { REVIEW_VIEW_DIRECTORY, reviewViews } from '../../src/reviews/view.js';
import type { AgentTurnRequest, RunTaskResult } from '../../src/runs/contracts.js';
import { runTask } from '../../src/runs/runner.js';
import type { SourceTask } from '../../src/sources/contract.js';
import type { SourceRef } from '../../src/shared/types.js';
import { canonicalPath } from '../../src/workspace/git.js';
import { gitOrFail, installStandIn, useOwnedProcesses } from '../boundary/integration-support.js';
import {
  TARGET_RESULT_DONE,
  TARGET_RESULT_FILE,
  branchHead,
  commitEverything,
  createTargetProject,
  recordingIo,
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
    publishReview: async (
      request: PublishReviewRequest,
    ): Promise<PublishedReview> => {
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

/** One run of the ticket, passed, in the retained workspace its pointer names. */
async function deliveredAttempt(
  project: Awaited<ReturnType<typeof createTargetProject>>,
): Promise<RunTaskResult> {
  const recorded = recordingIo();
  const context: CliContext = {
    cwd: project.parent,
    io: recorded.io,
    dependencies: {
      runAgentTurn: async (request: AgentTurnRequest) => {
        await writeFile(
          path.join(request.workspacePath, TARGET_RESULT_FILE),
          TARGET_RESULT_DONE,
          'utf8',
        );
        await commitEverything(request.workspacePath, 'implement the greeting');
        return { summary: 'implemented the greeting' };
      },
    },
  };
  const { config } = await loadConfiguration(
    project.configPath,
    projectConfigFile(project.repo),
  );
  const task = await loadTask(project.taskPath);
  return await runTask(
    {
      task,
      config,
      repoPath: project.repo,
      workDir: project.workDir,
      sourceRef: REF,
      preferredWorkspaceId: WORKSPACE_ID,
    },
    composeDependencies(context, recorded.io, () => undefined, { runtime: 'codex', command: ['codex'] }),
  );
}

describe('the review handoff', () => {
  it('hands the delivered revision to a reviewer and publishes its verdict against that head', async () => {
    const project = await createTargetProject();
    const run = await deliveredAttempt(project);
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
    expect(github.checks).toEqual([
      expect.objectContaining({ head, decision: 'approve' }),
    ]);

    // The reviewer inspected a real clone of the retained workspace, pinned at
    // the reviewed head and holding the delivered change — not an assembled
    // patch, and not the workspace itself.
    const [reviewId] = (await readdir(path.join(project.workDir, 'reviews'))).filter(
      (entry) => entry.startsWith('review-'),
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
    expect(JSON.parse(await readFile(path.join(reviewDir, 'verdict.json'), 'utf8'))).toMatchObject({
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
  });
});
