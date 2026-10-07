/**
 * Component tests: the real CompleteTask confirms the merged revision and its configured
 * post-merge checks over real temporary storage with the GitHub and Jira adapters controlled and
 * time supplied by a controlled wait. The producer-owned delivery and review artifacts are written
 * through the real helpers; no live service or merge is involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckObservation, PullRequest } from '../src/adapters/github.js';
import { ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import {
  completionArtifact,
  type CompletionOutput,
} from '../src/task-engine/actions/complete-task/artifacts.js';
import { createCompleteTask } from '../src/task-engine/actions/complete-task/index.js';
import { deliveryArtifact } from '../src/task-engine/actions/deliver/artifacts.js';
import { readValidationErrorHistory } from '../src/task-engine/actions/report-feedback.js';
import { reviewReportScope } from '../src/task-engine/actions/review/artifacts.js';
import { reviewArtifact, type ReviewOutput } from '../src/task-engine/actions/review/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { scriptedGitHub } from './support/github.js';
import { createCompleteDelivery } from '../src/task-engine/actions/project/complete-delivery/index.js';
import { scriptedJira } from './support/jira.js';

const headRevision = '2'.repeat(40);
const otherRevision = '3'.repeat(40);
const mergeRevision = '4'.repeat(40);
const repository = 'owner/repository';
const reviewCheck = 'Nexus Lens review';
const lensAppId = 5001141;
const pullRequestUrl = `https://github.com/${repository}/pull/7`;

let root = '';
let events: EngineEvent[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-complete-task-'));
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One workspace with a completed round whose delivery and review approved the delivered head. */
async function workspace(
  options: { readonly name?: string } = {},
): Promise<{ readonly workspaceRoot: string; readonly selectionFile: string }> {
  const workspaceRoot = path.join(root, options.name ?? 'workspace');
  await mkdir(path.join(workspaceRoot, 'state'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'state', 'current-round.json'),
    `${JSON.stringify({ number: 1, profile: 'dev-a', reason: 'Planned.' })}\n`,
    'utf8',
  );
  const selectionFile = path.join(
    root,
    'executions',
    `${options.name ?? 'workspace'}-selection.json`,
  );
  await mkdir(path.dirname(selectionFile), { recursive: true });
  await writeFile(
    selectionFile,
    `${JSON.stringify(
      {
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: { id: '1', key: 'NEX-1', fields: { summary: 'Implement the retry guard' } },
        conversation: [],
        workspace: { root: workspaceRoot },
        stage: 'delivery',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const helpers = createArtifactHelpers({ root: workspaceRoot });
  await helpers.writeOutputArtifact(deliveryArtifact, {
    repository,
    pullRequestNumber: 7,
    pullRequestUrl,
    headRevision,
  });
  const reviewMarkdown = 'The change matches the task.';
  const reviewReport = path.join(
    workspaceRoot,
    'artifacts',
    '1',
    'reports',
    'rev-1',
    'reviewer.md',
  );
  await mkdir(path.dirname(reviewReport), { recursive: true });
  await writeFile(reviewReport, reviewMarkdown, 'utf8');
  const review: ReviewOutput = {
    taskSubject: 'Implement the retry guard',
    taskKey: 'NEX-1',
    profile: 'nexus-review',
    headRevision,
    verdict: 'approved',
    role: 'reviewer',
    report: { path: reviewReport },
    invocationId: 'rev-1',
  };
  await helpers.writeOutputArtifact(reviewArtifact, review);
  return { workspaceRoot, selectionFile };
}

/** Read one round artifact document. */
async function readRoundArtifact(workspaceRoot: string, name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(workspaceRoot, 'artifacts', '1', name), 'utf8'),
  ) as unknown;
}

/** One pull-request observation. */
function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    url: pullRequestUrl,
    state: 'open',
    merged: false,
    headBranch: 'task/NEX-1',
    baseBranch: 'main',
    headRevision,
    mergeRevision: null,
    autoMergeEnabled: true,
    ...overrides,
  };
}

/** The successful Nexus Lens review check for the delivered head. */
const reviewCheckObservation: CheckObservation = {
  id: 12,
  revision: headRevision,
  name: reviewCheck,
  producer: { id: 5001141, slug: 'nexus-lens', name: 'Nexus Lens' },
  status: 'completed',
  conclusion: 'success',
};

/** One workflow run observation for the merge revision. */
function workflowRun(
  overrides: Partial<{
    readonly id: number;
    readonly name: string | null;
    readonly path: string;
    readonly status: string | null;
    readonly conclusion: string | null;
  }> = {},
): {
  readonly id: number;
  readonly name: string | null;
  readonly path: string;
  readonly revision: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly jobs: readonly [];
} {
  return {
    id: 5,
    name: 'Validate',
    path: 'validate.yml',
    revision: mergeRevision,
    status: 'completed',
    conclusion: 'success',
    jobs: [],
    ...overrides,
  };
}

/** A controlled wait that records the requested durations and resolves immediately. */
function scriptedWait(): {
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    wait: async (milliseconds) => {
      calls.push(milliseconds);
    },
  };
}

const inReviewIssue = {
  id: '1',
  key: 'NEX-1',
  fields: { summary: 'Implement the retry guard', status: { id: '4', name: 'In Review' } },
};

/** The outcome event CompleteTask publishes for one workspace's saved completion evidence. */
function completionOutcome(workspaceRoot: string, outcome: 'completed' | 'failed'): EngineEvent {
  return {
    source: 'complete-task',
    type: 'outcome',
    data: {
      task: 'NEX-1',
      round: 1,
      outcome,
      detail: 'PR #7',
      artifact: { path: path.join(workspaceRoot, 'artifacts', '1', 'completion.json') },
    },
  };
}

/** The action under test, bound to the configured post-merge checks and controlled adapters. */
/** The parent-owned completion over the same selection and controlled source. */
function completeDeliveryAction(options: {
  readonly selectionFile: string;
  readonly jira: ReturnType<typeof scriptedJira>['jira'];
}): ReturnType<typeof createCompleteDelivery> {
  return createCompleteDelivery({
    selectionFile: options.selectionFile,
    doneStatus: 'Done',
    reviewStatus: 'In Review',
    jira: options.jira,
    publish: (event) => events.push(event),
  });
}

function completeTaskAction(options: {
  readonly selectionFile: string;
  readonly github: ReturnType<typeof scriptedGitHub>['github'];
  readonly jira: ReturnType<typeof scriptedJira>['jira'];
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly waitLimitSeconds?: number;
}): ReturnType<typeof createCompleteTask> {
  return createCompleteTask({
    selectionFile: options.selectionFile,
    repository,
    reviewCheck,
    nexusLens: { appId: lensAppId },
    postMergeChecks: [{ name: 'validate', workflow: 'validate.yml' }],
    completion: {
      pollIntervalSeconds: 5,
      waitLimitSeconds: options.waitLimitSeconds ?? 1800,
    },
    github: options.github,
    publish: (event) => events.push(event),
    wait: options.wait,
  });
}

describe('CompleteTask', () => {
  it('completes only after the merge and every configured post-merge check passed', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    const order: string[] = [];
    const { github, calls: githubCalls } = scriptedGitHub({
      readPullRequest: () => ok(pullRequest({ state: 'closed', merged: true, mergeRevision })),
      readChecks: () => {
        order.push('checks');
        return ok([reviewCheckObservation]);
      },
      readWorkflowRuns: () => {
        order.push('workflow');
        return ok([workflowRun()]);
      },
    });
    const { jira, calls: jiraCalls } = scriptedJira({
      readIssue: () => ok(inReviewIssue),
      readTransitions: () => ok([{ id: '41', name: 'Done', to: { id: '5', name: 'Done' } }]),
      transitionIssue: () => {
        order.push('done');
        return ok(undefined);
      },
    });
    const { wait, calls: waitCalls } = scriptedWait();
    const completeTask = completeTaskAction({ selectionFile, github, jira, wait });

    await expect(completeTask()).resolves.toBe('completed');
    // The child returns its evidence; the parent marks the ticket Done.
    await expect(completeDeliveryAction({ selectionFile, jira })()).resolves.toBe('completed');

    const completion = (await readRoundArtifact(
      workspaceRoot,
      'completion.json',
    )) as CompletionOutput;
    expect(completion).toEqual({
      taskKey: 'NEX-1',
      pullRequestUrl,
      reviewedHead: headRevision,
      mergeRevision,
      checks: [
        { name: 'validate', producer: 'validate.yml', revision: mergeRevision, result: 'passed' },
      ],
    });
    expect(githubCalls).toEqual([
      `readChecks:${headRevision}`,
      'read:7',
      `workflowRuns:${mergeRevision}:validate.yml`,
    ]);
    expect(jiraCalls).toEqual(['read:1', 'transitions:1', 'transition:1:41']);
    expect(waitCalls).toEqual([]);
    // The checks are confirmed before the parent marks the ticket Done.
    expect(order).toEqual(['checks', 'workflow', 'done']);
    // The saved evidence is what the child's completed outcome event references; the parent's
    // completion event follows it.
    expect(events[0]).toEqual(completionOutcome(workspaceRoot, 'completed'));
  });

  it.each([
    {
      label: 'a deleted review report',
      expected: /Review report at ".*" does not exist/,
      damage: async (_workspaceRoot: string, review: ReviewOutput) => {
        await rm(review.report.path);
      },
    },
    {
      label: 'a damaged review record',
      expected: /does not match its declared content type/,
      damage: async (workspaceRoot: string, review: ReviewOutput) => {
        const damaged: Record<string, unknown> = { ...review };
        delete damaged.invocationId;
        await writeFile(
          path.join(workspaceRoot, 'artifacts', '1', 'review.json'),
          `${JSON.stringify(damaged, null, 2)}\n`,
          'utf8',
        );
      },
    },
    {
      label: 'a review that belongs to another task',
      expected: /is for task "NEX-2", not "NEX-1"/,
      damage: async (workspaceRoot: string, review: ReviewOutput) => {
        await writeFile(
          path.join(workspaceRoot, 'artifacts', '1', 'review.json'),
          `${JSON.stringify({ ...review, taskKey: 'NEX-2' }, null, 2)}\n`,
          'utf8',
        );
      },
    },
  ])('does not complete from $label', async ({ expected, damage }) => {
    const { workspaceRoot, selectionFile } = await workspace({ name: 'unusable-review' });
    const review = (await readRoundArtifact(workspaceRoot, 'review.json')) as ReviewOutput;
    await damage(workspaceRoot, review);
    const { github, calls } = scriptedGitHub({});
    const { jira } = scriptedJira({});
    const { wait } = scriptedWait();
    const completeTask = completeTaskAction({ selectionFile, github, jira, wait });

    await expect(completeTask()).rejects.toThrow(expected);
    // The damaged approval authorizes nothing: no provider read, no completion evidence.
    expect(calls).toEqual([]);
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '1', 'completion.json')),
    ).rejects.toThrow(/ENOENT/);
    // The unavailable or foreign review stays attributable under the reviewer's responsibility.
    const rejection = (await readValidationErrorHistory(workspaceRoot))[0];
    expect(rejection?.record).toMatchObject({
      scope: reviewReportScope(workspaceRoot, 'NEX-1'),
      operation: 'review',
      assignedReport: { path: review.report.path },
    });
  });

  it('completes from an approval whose readable report was reworded', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ name: 'reworded-report' });
    const review = (await readRoundArtifact(workspaceRoot, 'review.json')) as ReviewOutput;
    await writeFile(
      review.report.path,
      'The change matches the task, restated after the review.\n',
      'utf8',
    );
    const { github } = scriptedGitHub({
      readPullRequest: () => ok(pullRequest({ state: 'closed', merged: true, mergeRevision })),
      readChecks: () => ok([reviewCheckObservation]),
      readWorkflowRuns: () => ok([workflowRun()]),
    });
    const { jira } = scriptedJira({
      readIssue: () => ok(inReviewIssue),
      readTransitions: () => ok([{ id: '41', name: 'Done', to: { id: '5', name: 'Done' } }]),
      transitionIssue: () => ok(undefined),
    });
    const completeTask = completeTaskAction({
      selectionFile,
      github,
      jira,
      wait: scriptedWait().wait,
    });

    // No Markdown-byte gate rejects the approval: its readable report and current revision bind it.
    await expect(completeTask()).resolves.toBe('completed');
    expect(await readValidationErrorHistory(workspaceRoot)).toEqual([]);
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '1', 'completion.json')),
    ).resolves.toBeTruthy();
  });

  it('requires a completed Nexus Lens check for the approved delivered head', async () => {
    const missing = await workspace({ name: 'missing-check' });
    const missingHub = scriptedGitHub({
      readChecks: () => ok([]),
    });
    await expect(
      completeTaskAction({
        selectionFile: missing.selectionFile,
        github: missingHub.github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/carries no "Nexus Lens review" check/) },
    });

    // A same-name success from another App, or without a producing App, is not the Lens gate.
    events = [];
    const foreign = await workspace({ name: 'foreign-check' });
    const foreignHub = scriptedGitHub({
      readChecks: () =>
        ok([
          {
            ...reviewCheckObservation,
            id: 21,
            producer: { id: 4242, slug: 'other-app', name: 'Other App' },
          },
          { ...reviewCheckObservation, id: 22, producer: null },
        ]),
    });
    await expect(
      completeTaskAction({
        selectionFile: foreign.selectionFile,
        github: foreignHub.github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/carries no "Nexus Lens review" check/) },
    });

    // A successful conclusion without a completed status is not a successful check.
    events = [];
    const incomplete = await workspace({ name: 'incomplete-check' });
    const incompleteHub = scriptedGitHub({
      readChecks: () => ok([{ ...reviewCheckObservation, status: 'in_progress' }]),
    });
    await expect(
      completeTaskAction({
        selectionFile: incomplete.selectionFile,
        github: incompleteHub.github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/not successful/) },
    });

    // A Lens check without a successful conclusion cannot confirm the approval.
    events = [];
    const unresolved = await workspace({ name: 'unresolved-check' });
    const unresolvedHub = scriptedGitHub({
      readChecks: () =>
        ok([{ ...reviewCheckObservation, status: 'in_progress', conclusion: null }]),
    });
    await expect(
      completeTaskAction({
        selectionFile: unresolved.selectionFile,
        github: unresolvedHub.github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/not successful/) },
    });

    // A completed Lens check that concluded unsuccessfully cannot confirm the approval.
    events = [];
    const failed = await workspace({ name: 'failed-lens-check' });
    const failedHub = scriptedGitHub({
      readChecks: () => ok([{ ...reviewCheckObservation, conclusion: 'failure' }]),
    });
    await expect(
      completeTaskAction({
        selectionFile: failed.selectionFile,
        github: failedHub.github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/not successful/) },
    });
  });

  it('does not transfer an approval when the review or the pull request head changed', async () => {
    const notApproved = await workspace({ name: 'not-approved' });
    const helpers = createArtifactHelpers({ root: notApproved.workspaceRoot });
    await helpers.writeOutputArtifact(reviewArtifact, {
      profile: 'nexus-review',
      headRevision,
      verdict: 'changesRequested',
      summary: 'A blocking finding remains.',
      findings: [
        {
          title: 'Missing retry',
          severity: 'blocking',
          basis: 'The design requires a retry.',
          evidence: 'No retry exists.',
          impact: 'Transient failures are lost.',
          repairGuidance: 'Add the retry.',
          locations: [],
        },
      ],
    });
    await expect(
      completeTaskAction({
        selectionFile: notApproved.selectionFile,
        github: scriptedGitHub({}).github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/only an approved review/) },
    });

    events = [];
    const laterHead = await workspace({ name: 'later-head' });
    const laterHelpers = createArtifactHelpers({ root: laterHead.workspaceRoot });
    await laterHelpers.writeOutputArtifact(reviewArtifact, {
      profile: 'nexus-review',
      headRevision: otherRevision,
      verdict: 'approved',
      summary: 'Approved another revision.',
      findings: [],
    });
    await expect(
      completeTaskAction({
        selectionFile: laterHead.selectionFile,
        github: scriptedGitHub({}).github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/approval is not transferred/) },
    });

    events = [];
    const changedHead = await workspace({ name: 'changed-head' });
    const changedHub = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      readPullRequest: () => ok(pullRequest({ headRevision: otherRevision })),
    });
    await expect(
      completeTaskAction({
        selectionFile: changedHead.selectionFile,
        github: changedHub.github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/approval is not transferred/) },
    });
  });

  it('consumes a retained combined approval without re-running its removed finding rule', async () => {
    const retained = await workspace({ name: 'retained-approval' });
    const helpers = createArtifactHelpers({ root: retained.workspaceRoot });
    // A retained report may record an approval beside its former blocking finding. The removed
    // consistency rule no longer rejects it, so the approval reaches the existing check
    // protection; the missing Nexus Lens check still fails completion.
    await helpers.writeOutputArtifact(reviewArtifact, {
      taskKey: 'NEX-1',
      profile: 'nexus-review',
      headRevision,
      verdict: 'approved',
      summary: 'The change matches the task.',
      findings: [
        {
          title: 'Missing retry',
          severity: 'blocking',
          basis: 'The design requires a retry.',
          evidence: 'No retry exists.',
          impact: 'Transient failures are lost.',
          repairGuidance: 'Add the retry.',
          locations: [],
        },
      ],
    });
    const { github, calls: githubCalls } = scriptedGitHub({ readChecks: () => ok([]) });
    await expect(
      completeTaskAction({
        selectionFile: retained.selectionFile,
        github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/carries no "Nexus Lens review" check/) },
    });
    // The failed gate records no completion evidence.
    await expect(
      stat(path.join(retained.workspaceRoot, 'artifacts', '1', 'completion.json')),
    ).rejects.toThrow(/ENOENT/);
    expect(githubCalls).toEqual([`readChecks:${headRevision}`]);
  });

  it('fails a closed pull request and a failed post-merge check', async () => {
    const closed = await workspace({ name: 'closed' });
    const closedHub = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      readPullRequest: () => ok(pullRequest({ state: 'closed', merged: false })),
    });
    await expect(
      completeTaskAction({
        selectionFile: closed.selectionFile,
        github: closedHub.github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/closed without being merged/) },
    });

    events = [];
    const failedCheck = await workspace({ name: 'failed-check' });
    const failedHub = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      readPullRequest: () => ok(pullRequest({ state: 'closed', merged: true, mergeRevision })),
      readWorkflowRuns: () => ok([workflowRun({ conclusion: 'failure' })]),
    });
    await expect(
      completeTaskAction({
        selectionFile: failedCheck.selectionFile,
        github: failedHub.github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/concluded "failure" for revision/) },
    });
    await expect(
      stat(path.join(failedCheck.workspaceRoot, 'artifacts', '1', 'completion.json')),
    ).rejects.toThrow(/ENOENT/);
    // The stated reason is retained for the terminal handoff, not only published.
    expect(
      JSON.parse(
        await readFile(
          path.join(failedCheck.workspaceRoot, 'artifacts', '1', 'completion-failure.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      reason: expect.stringMatching(/concluded "failure" for revision/),
    });
  });

  it('waits within the configured completion window and fails on expiry', async () => {
    const settled = await workspace({ name: 'settled' });
    let reads = 0;
    let runs = 0;
    const { github } = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      readRequiredChecks: () => ok({ revision: headRevision, checks: [] }),
      readPullRequest: () => {
        reads += 1;
        return reads === 1
          ? ok(pullRequest())
          : ok(pullRequest({ state: 'closed', merged: true, mergeRevision }));
      },
      readWorkflowRuns: () => {
        runs += 1;
        return runs === 1
          ? ok([workflowRun({ status: 'in_progress', conclusion: null })])
          : ok([workflowRun()]);
      },
    });
    const { jira, calls: jiraCalls } = scriptedJira({
      readIssue: () => ok(inReviewIssue),
      readTransitions: () => ok([{ id: '41', name: 'Done', to: { id: '5', name: 'Done' } }]),
      transitionIssue: () => ok(undefined),
    });
    const { wait, calls: waitCalls } = scriptedWait();

    await expect(
      completeTaskAction({ selectionFile: settled.selectionFile, github, jira, wait })(),
    ).resolves.toBe('completed');
    await expect(
      completeDeliveryAction({ selectionFile: settled.selectionFile, jira })(),
    ).resolves.toBe('completed');

    expect(waitCalls).toEqual([5000, 5000]);
    expect(jiraCalls).toContain('transition:1:41');

    // Expiry cannot produce completed: no wait fits in the configured window.
    events = [];
    const expired = await workspace({ name: 'expired' });
    const { wait: expiredWait, calls: expiredWaitCalls } = scriptedWait();
    const expiredHub = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      readRequiredChecks: () => ok({ revision: headRevision, checks: [] }),
      readPullRequest: () => ok(pullRequest()),
    });
    await expect(
      completeTaskAction({
        selectionFile: expired.selectionFile,
        github: expiredHub.github,
        jira: scriptedJira({}).jira,
        wait: expiredWait,
        waitLimitSeconds: 0,
      })(),
    ).resolves.toBe('failed');
    expect(expiredWaitCalls).toEqual([]);
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/completion wait of 0s expired/) },
    });
  });

  it('reports a failed required pre-merge check instead of waiting for the merge', async () => {
    const failed = await workspace({ name: 'required-check-failed' });
    const { github, calls: githubCalls } = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      readPullRequest: () => ok(pullRequest()),
      readRequiredChecks: () =>
        ok({
          revision: headRevision,
          checks: [
            {
              name: 'validate',
              status: 'completed',
              conclusion: 'failure',
              evidenceUrl: `${pullRequestUrl}/checks/1`,
            },
            { name: 'build', status: 'in_progress', conclusion: null, evidenceUrl: null },
          ],
        }),
    });
    const { jira, calls: jiraCalls } = scriptedJira({});
    const { wait, calls: waitCalls } = scriptedWait();

    await expect(
      completeTaskAction({ selectionFile: failed.selectionFile, github, jira, wait })(),
    ).resolves.toBe('failed');

    // The failing check is reported with its evidence, without waiting or touching the ticket.
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: {
        reason:
          'required pre-merge check "validate" concluded "failure" for revision ' +
          `${headRevision} (evidence: ${pullRequestUrl}/checks/1).`,
      },
    });
    expect(waitCalls).toEqual([]);
    expect(jiraCalls).toEqual([]);
    expect(githubCalls).toEqual([`readChecks:${headRevision}`, 'read:7', 'readRequiredChecks:7']);
    await expect(
      stat(path.join(failed.workspaceRoot, 'artifacts', '1', 'completion.json')),
    ).rejects.toThrow(/ENOENT/);

    // Required checks that have not reported or are still running stay pending within the wait;
    // a satisfied conclusion set still completes once the pull request merges.
    events = [];
    const pending = await workspace({ name: 'required-check-pending' });
    let requiredReads = 0;
    let mergeReads = 0;
    const pendingHub = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      readPullRequest: () => {
        mergeReads += 1;
        return mergeReads < 3
          ? ok(pullRequest())
          : ok(pullRequest({ state: 'closed', merged: true, mergeRevision }));
      },
      readRequiredChecks: () => {
        requiredReads += 1;
        return ok({
          revision: headRevision,
          checks: [
            requiredReads === 1
              ? { name: 'validate', status: 'in_progress', conclusion: null, evidenceUrl: null }
              : { name: 'validate', status: 'completed', conclusion: 'skipped', evidenceUrl: null },
          ],
        });
      },
      readWorkflowRuns: () => ok([workflowRun()]),
    });
    const { jira: pendingJira, calls: pendingJiraCalls } = scriptedJira({
      readIssue: () => ok(inReviewIssue),
      readTransitions: () => ok([{ id: '41', name: 'Done', to: { id: '5', name: 'Done' } }]),
      transitionIssue: () => ok(undefined),
    });
    const { wait: pendingWait, calls: pendingWaitCalls } = scriptedWait();

    await expect(
      completeTaskAction({
        selectionFile: pending.selectionFile,
        github: pendingHub.github,
        jira: pendingJira,
        wait: pendingWait,
      })(),
    ).resolves.toBe('completed');

    expect(requiredReads).toBe(2);
    expect(pendingWaitCalls).toEqual([5000, 5000]);
    await expect(
      completeDeliveryAction({ selectionFile: pending.selectionFile, jira: pendingJira })(),
    ).resolves.toBe('completed');
    expect(pendingJiraCalls).toContain('transition:1:41');

    // A required check that fails while the merge is pending is reported on that observation.
    events = [];
    const later = await workspace({ name: 'required-check-later' });
    let laterReads = 0;
    const laterHub = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      readPullRequest: () => ok(pullRequest()),
      readRequiredChecks: () => {
        laterReads += 1;
        return ok({
          revision: headRevision,
          checks: [
            laterReads === 1
              ? { name: 'validate', status: 'in_progress', conclusion: null, evidenceUrl: null }
              : {
                  name: 'validate',
                  status: 'completed',
                  conclusion: 'failure',
                  evidenceUrl: `${pullRequestUrl}/checks/2`,
                },
          ],
        });
      },
    });
    const { wait: laterWait, calls: laterWaitCalls } = scriptedWait();

    await expect(
      completeTaskAction({
        selectionFile: later.selectionFile,
        github: laterHub.github,
        jira: scriptedJira({}).jira,
        wait: laterWait,
      })(),
    ).resolves.toBe('failed');

    expect(laterWaitCalls).toEqual([5000]);
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: {
        reason: expect.stringMatching(
          /required pre-merge check "validate" concluded "failure" for revision/u,
        ),
      },
    });
  });

  it('reports a head change observed by the required-check read as a changed head', async () => {
    const changed = await workspace({ name: 'required-check-changed-head' });
    const { github } = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      // The merge observation still sees the delivered head; the required-check read then reports
      // the pull request at another revision carrying a failed required check.
      readPullRequest: () => ok(pullRequest()),
      readRequiredChecks: () =>
        ok({
          revision: otherRevision,
          checks: [
            {
              name: 'validate',
              status: 'completed',
              conclusion: 'failure',
              evidenceUrl: `${pullRequestUrl}/checks/3`,
            },
          ],
        }),
    });
    const { wait, calls: waitCalls } = scriptedWait();

    await expect(
      completeTaskAction({
        selectionFile: changed.selectionFile,
        github,
        jira: scriptedJira({}).jira,
        wait,
      })(),
    ).resolves.toBe('failed');

    // The failure names the observed revision as a changed head, not the delivered revision as a
    // failed check, and stops waiting immediately.
    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: {
        reason:
          `Pull request #7 is at revision ${otherRevision}, not the delivered ${headRevision}; ` +
          'the approval is not transferred.',
      },
    });
    expect(waitCalls).toEqual([]);
  });

  it('does not let a newer successful run supersede a failed matching run', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ name: 'superseded' });
    const { github } = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
      readPullRequest: () => ok(pullRequest({ state: 'closed', merged: true, mergeRevision })),
      // The provider lists the newest run first; every matching run must still succeed.
      readWorkflowRuns: () =>
        ok([workflowRun({ id: 6 }), workflowRun({ id: 5, conclusion: 'failure' })]),
    });

    await expect(
      completeTaskAction({
        selectionFile,
        github,
        jira: scriptedJira({}).jira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('failed');

    expect(events.at(-1)).toEqual({
      source: 'complete-task',
      type: 'failed',
      data: { reason: expect.stringMatching(/concluded "failure" for revision/) },
    });
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '1', 'completion.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('reuses confirmed evidence and finishes the outstanding completion step', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ name: 'reuse' });
    const helpers = createArtifactHelpers({ root: workspaceRoot });
    const completion: CompletionOutput = {
      taskKey: 'NEX-1',
      pullRequestUrl,
      reviewedHead: headRevision,
      mergeRevision,
      checks: [
        { name: 'validate', producer: 'validate.yml', revision: mergeRevision, result: 'passed' },
      ],
    };
    await helpers.writeOutputArtifact(completionArtifact, completion);
    const { github, calls: githubCalls } = scriptedGitHub({
      readPullRequest: () => ok(pullRequest({ state: 'closed', merged: true, mergeRevision })),
    });
    const { jira, calls: jiraCalls } = scriptedJira({
      readIssue: () => ok(inReviewIssue),
      readTransitions: () => ok([{ id: '41', name: 'Done', to: { id: '5', name: 'Done' } }]),
      transitionIssue: () => ok(undefined),
    });

    await expect(
      completeTaskAction({ selectionFile, github, jira, wait: scriptedWait().wait })(),
    ).resolves.toBe('completed');

    // The confirmed evidence is reused: no review check and no workflow run is read again.
    expect(githubCalls).toEqual(['read:7']);
    expect(jiraCalls).toEqual([]);
    await expect(completeDeliveryAction({ selectionFile, jira })()).resolves.toBe('completed');
    expect(jiraCalls).toEqual(['read:1', 'transitions:1', 'transition:1:41']);
    expect(await readRoundArtifact(workspaceRoot, 'completion.json')).toEqual(completion);
    // The reused evidence stays the saved file the child's outcome event references; the parent's
    // completion event follows it.
    expect(events[0]).toEqual(completionOutcome(workspaceRoot, 'completed'));

    // An already-completed ticket needs no further transition.
    events = [];
    const alreadyDone = await workspace({ name: 'already-done' });
    const doneHelpers = createArtifactHelpers({ root: alreadyDone.workspaceRoot });
    await doneHelpers.writeOutputArtifact(completionArtifact, completion);
    const doneHub = scriptedGitHub({
      readPullRequest: () => ok(pullRequest({ state: 'closed', merged: true, mergeRevision })),
    });
    const { jira: doneJira, calls: doneJiraCalls } = scriptedJira({
      readIssue: () =>
        ok({
          id: '1',
          key: 'NEX-1',
          fields: { summary: 'Implement the retry guard', status: { id: '5', name: 'Done' } },
        }),
    });
    await expect(
      completeTaskAction({
        selectionFile: alreadyDone.selectionFile,
        github: doneHub.github,
        jira: doneJira,
        wait: scriptedWait().wait,
      })(),
    ).resolves.toBe('completed');
    expect(doneJiraCalls).toEqual([]);
    // The parent sees the ticket is already Done and performs no further transition.
    await expect(
      completeDeliveryAction({ selectionFile: alreadyDone.selectionFile, jira: doneJira })(),
    ).resolves.toBe('completed');
    expect(doneJiraCalls).toEqual(['read:1']);
    expect(doneHub.calls).toEqual(['read:7']);
  });
});
