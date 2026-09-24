/**
 * Focused integration tests: the real Deliver, Review and CompleteTask run one delivery cycle over
 * a real temporary repository, real Git and Processes adapters, real round storage and the
 * producer-owned artifact declarations of Develop, Verify, Deliver and Review. The agent runtimes
 * and the GitHub and Jira services are controlled, so no provider, network, push to a live remote
 * or paid turn is involved.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../src/agent-runtime/index.js';
import { createGitAdapter } from '../src/adapters/git.js';
import type { CheckObservation } from '../src/adapters/github.js';
import { run, type ProcessOutput } from '../src/adapters/processes.js';
import { ok } from '../src/result.js';
import { createCompleteTask } from '../src/task-engine/actions/complete-task/index.js';
import { type DeliveryOutput } from '../src/task-engine/actions/deliver/artifacts.js';
import { createDeliver } from '../src/task-engine/actions/deliver/index.js';
import { type DevelopmentOutput } from '../src/task-engine/actions/develop/artifacts.js';
import { createDevelop } from '../src/task-engine/actions/develop/index.js';
import { createReview } from '../src/task-engine/actions/review/index.js';
import { type ReviewOutput } from '../src/task-engine/actions/review/artifacts.js';
import { createStartRound } from '../src/task-engine/actions/start-round/index.js';
import { createVerify } from '../src/task-engine/actions/verify/index.js';
import type { CompletionOutput } from '../src/task-engine/actions/complete-task/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { scriptedGitHub } from './support/github.js';
import { scriptedJira } from './support/jira.js';

/** Git and check commands run with a supplied environment; host Git configuration is disabled. */
const environment = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Nexus Tests',
  GIT_AUTHOR_EMAIL: 'nexus@example.com',
  GIT_COMMITTER_NAME: 'Nexus Tests',
  GIT_COMMITTER_EMAIL: 'nexus@example.com',
};

const git = createGitAdapter((args, directory, onOutput) =>
  run({ executable: 'git', args, directory, environment }, onOutput),
);

const mergeRevision = '4'.repeat(40);
const repository = 'owner/repository';
const reviewCheck = 'Nexus Lens review';
const lensAppId = 5001141;
const pullRequestUrl = `https://github.com/${repository}/pull/7`;

let root = '';
let events: EngineEvent[] = [];
let workspaceRoot = '';
let worktree = '';
let origin = '';
let selectionFile = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-delivery-cycle-'));
  events = [];
  origin = path.join(root, 'origin.git');
  const source = path.join(root, 'source');
  await mkdir(root, { recursive: true });
  await gitCommand(['init', '--quiet', '--bare', '--initial-branch=main', origin], root);
  await gitCommand(['init', '--quiet', '--initial-branch=main', source], root);
  await writeFile(path.join(source, 'readme.md'), 'initial\n');
  await gitCommand(['add', 'readme.md'], source);
  await gitCommand(['commit', '--quiet', '--message', 'initial'], source);
  await gitCommand(['remote', 'add', 'origin', origin], source);
  await gitCommand(['push', '--quiet', 'origin', 'main'], source);
  const base = await headOf(source);

  workspaceRoot = path.join(root, 'workspace');
  worktree = path.join(workspaceRoot, 'worktree');
  await mkdir(workspaceRoot, { recursive: true });
  await gitCommand(['clone', '--quiet', origin, worktree], root);
  await gitCommand(['checkout', '--quiet', '-b', 'task/NEX-1', base], worktree);
  await mkdir(path.join(workspaceRoot, 'state'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'state', 'prepared-workspace.json'),
    `${JSON.stringify(
      { taskKey: 'NEX-1', repository: origin, branch: 'task/NEX-1', baseRevision: base },
      null,
      2,
    )}\n`,
    'utf8',
  );
  selectionFile = path.join(root, 'executions', 'selection.json');
  await mkdir(path.dirname(selectionFile), { recursive: true });
  await writeFile(
    selectionFile,
    `${JSON.stringify(
      {
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: { id: '1', key: 'NEX-1', fields: { summary: 'Implement the feature' } },
        conversation: [],
        workspace: { root: workspaceRoot },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Decode one stream's chunks as text. */
function text(outputs: readonly ProcessOutput[], stream: ProcessOutput['stream']): string {
  const chunks = outputs.filter((output) => output.stream === stream).map((output) => output.chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Run one git command as test setup and return its stdout. */
async function gitCommand(args: readonly string[], directory: string): Promise<string> {
  const outputs: ProcessOutput[] = [];
  const result = await run({ executable: 'git', args, directory, environment }, (output) => {
    outputs.push(output);
  });
  if (!result.ok || result.value.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${text(outputs, 'stderr')}`);
  }
  return text(outputs, 'stdout');
}

/** The commit a repository's HEAD points to. */
async function headOf(repositoryPath: string): Promise<string> {
  return (await gitCommand(['rev-parse', 'HEAD'], repositoryPath)).trim();
}

/** Read one round artifact document. */
async function readArtifact<T>(round: number, name: string): Promise<T> {
  return JSON.parse(
    await readFile(path.join(workspaceRoot, 'artifacts', String(round), name), 'utf8'),
  ) as T;
}

describe('delivery cycle', () => {
  it('publishes, reviews and completes the same delivered revision', async () => {
    const developerRuntime: AgentRuntime = {
      async run() {
        await writeFile(path.join(worktree, 'feature.txt'), 'feature\n');
        await gitCommand(['add', '--all'], worktree);
        await gitCommand(['commit', '--quiet', '--message', 'add the feature'], worktree);
        return ok({
          output: JSON.stringify({
            status: 'completed',
            summary: 'Added the feature with its configured check.',
            findingResponses: [],
          }),
        });
      },
    };
    const reviewerContexts: string[] = [];
    const reviewerRuntime: AgentRuntime = {
      async run(_profile, _workspaceRef, additionalContext) {
        reviewerContexts.push(additionalContext);
        return ok({
          output: JSON.stringify({
            verdict: 'approved',
            summary: 'The change fulfils the task and the check covers it.',
            findings: [],
            priorFindings: [],
          }),
        });
      },
    };

    // The Jira source tracks the status through the configured transitions and retains comments.
    let status = 'In Progress';
    const comments: { readonly id: string; readonly body: unknown }[] = [];
    let commentCount = 0;
    const jiraSource = scriptedJira({
      readIssue: () =>
        ok({
          id: '1',
          key: 'NEX-1',
          fields: {
            summary: 'Implement the feature',
            description: { type: 'doc', content: [] },
            status: { id: '2', name: status },
          },
        }),
      readComments: () => ok([...comments]),
      readTransitions: () =>
        ok([
          { id: '31', name: 'Review', to: { id: '4', name: 'In Review' } },
          { id: '41', name: 'Done', to: { id: '5', name: 'Done' } },
        ]),
      updateFields: () => ok(undefined),
      transitionIssue: (_issueId, transitionId) => {
        status = transitionId === '31' ? 'In Review' : 'Done';
        return ok(undefined);
      },
      addComment: (_issueId, body) => {
        commentCount += 1;
        comments.push({ id: `c${commentCount}`, body });
        return ok({ id: `c${commentCount}`, body });
      },
    });

    // The GitHub state: one pull request, auto-merge, and the Nexus Lens review check.
    let reviewPublished = false;
    let autoMergeRequested = false;
    const githubSource = scriptedGitHub({
      findPullRequests: () => ok([]),
      createPullRequest: async () =>
        ok({ number: 7, url: pullRequestUrl, headRevision: await headOf(worktree) }),
      requestAutoMerge: () => {
        autoMergeRequested = true;
        return ok(undefined);
      },
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: async () => {
        if (!reviewPublished) {
          return ok([]);
        }
        const revision = await headOf(worktree);
        const check: CheckObservation = {
          id: 12,
          revision,
          name: reviewCheck,
          producer: { id: 5001141, slug: 'nexus-lens', name: 'Nexus Lens' },
          status: 'completed',
          conclusion: 'success',
        };
        return ok([check]);
      },
      publishReview: () => ok({ id: 11, url: `${pullRequestUrl}#review-11` }),
      publishReviewCheck: () => {
        reviewPublished = true;
        return ok({ id: 12 });
      },
      readPullRequest: async () =>
        ok({
          number: 7,
          url: pullRequestUrl,
          state: 'closed',
          merged: true,
          baseBranch: 'main',
          headRevision: await headOf(worktree),
          mergeRevision,
          autoMergeEnabled: true,
        }),
      readWorkflowRuns: () =>
        ok([
          {
            id: 5,
            name: 'Validate',
            path: 'validate.yml',
            revision: mergeRevision,
            status: 'completed',
            conclusion: 'success',
            jobs: [],
          },
        ]),
    });

    const startRound = createStartRound({
      workspace: { root: workspaceRoot },
      developerLadder: [{ profile: 'dev-a', repairAllowance: 1 }],
      publish: (event) => events.push(event),
    });
    const develop = createDevelop({
      selectionFile,
      runtime: developerRuntime,
      git,
      jira: jiraSource.jira,
      publish: (event) => events.push(event),
    });
    const verify = createVerify({
      workspace: { root: workspaceRoot },
      checks: [
        {
          name: 'feature-check',
          command: { executable: 'bash', args: ['-c', '[ -f feature.txt ] && echo checked'] },
        },
      ],
      environment,
      git,
      runCommand: run,
      publish: (event) => events.push(event),
    });
    const deliver = createDeliver({
      selectionFile,
      repository,
      baseBranch: 'main',
      pullRequestField: 'customfield_10002',
      reviewStatus: 'In Review',
      git,
      github: githubSource.github,
      jira: jiraSource.jira,
      publish: (event) => events.push(event),
    });
    const review = createReview({
      selectionFile,
      repository,
      reviewCheck,
      nexusLens: { appId: lensAppId, login: 'nexus-lens[bot]' },
      reviewerProfile: 'nexus-review',
      runtime: reviewerRuntime,
      git,
      github: githubSource.github,
      jira: jiraSource.jira,
      publish: (event) => events.push(event),
    });
    const completeTask = createCompleteTask({
      selectionFile,
      repository,
      reviewCheck,
      nexusLens: { appId: lensAppId },
      postMergeChecks: [{ name: 'validate', workflow: 'validate.yml' }],
      completion: { pollIntervalSeconds: 5, waitLimitSeconds: 1800 },
      doneStatus: 'Done',
      github: githubSource.github,
      jira: jiraSource.jira,
      publish: (event) => events.push(event),
      wait: async () => undefined,
    });

    // Develop and Verify produce the current round's real inputs.
    await expect(startRound()).resolves.toBe('started');
    await expect(develop()).resolves.toBe('completed');
    await expect(verify()).resolves.toBe('passed');

    // Deliver consumes them and records the publication.
    await expect(deliver()).resolves.toBe('published');
    const delivery = await readArtifact<DeliveryOutput>(1, 'delivery.json');
    const development = await readArtifact<DevelopmentOutput>(1, 'development.json');
    expect(delivery.headRevision).toBe(development.headRevision);
    expect(autoMergeRequested).toBe(true);
    expect(status).toBe('In Review');

    // Review consumes the delivered revision and publishes its verdict and check.
    await expect(review()).resolves.toBe('approved');
    const reviewed = await readArtifact<ReviewOutput>(1, 'review.json');
    expect(reviewed.profile).toBe('nexus-review');
    expect(reviewed.headRevision).toBe(delivery.headRevision);
    expect(reviewPublished).toBe(true);
    const context = reviewerContexts[0] ?? '';
    expect(context).toContain('Added the feature with its configured check.');
    expect(context).toContain(`Reviewed revision: ${delivery.headRevision}`);
    expect(context).toContain('+feature');
    expect(context).toContain('Implement the feature');

    // CompleteTask confirms the merge and the post-merge check, then marks the task Done.
    await expect(completeTask()).resolves.toBe('completed');
    const completion = await readArtifact<CompletionOutput>(1, 'completion.json');
    expect(completion).toEqual({
      taskKey: 'NEX-1',
      pullRequestUrl,
      reviewedHead: delivery.headRevision,
      mergeRevision,
      checks: [
        { name: 'validate', producer: 'validate.yml', revision: mergeRevision, result: 'passed' },
      ],
    });
    expect(status).toBe('Done');
    // The ticket carries the delivery report and the review comment, each beginning with its
    // profile; no failure event was published.
    expect(comments).toHaveLength(2);
    expect(events.some((event) => event.type === 'failed')).toBe(false);
  });
});
