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
import { reviewArtifact, type ReviewOutput } from '../src/task-engine/actions/review/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { scriptedGitHub } from './support/github.js';
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
  const review: ReviewOutput = {
    profile: 'nexus-review',
    headRevision,
    verdict: 'approved',
    summary: 'The change matches the task.',
    findings: [],
    priorFindings: [],
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

/** The action under test, bound to the configured post-merge checks and controlled adapters. */
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
    doneStatus: 'Done',
    github: options.github,
    jira: options.jira,
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
    // The checks are confirmed before the ticket is marked Done.
    expect(order).toEqual(['checks', 'workflow', 'done']);
    expect(events).toEqual([]);
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
          id: 'NEX-1-finding-1',
          title: 'Missing retry',
          severity: 'blocking',
          basis: 'The design requires a retry.',
          evidence: 'No retry exists.',
          impact: 'Transient failures are lost.',
          repairGuidance: 'Add the retry.',
          locations: [],
        },
      ],
      priorFindings: [],
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
      priorFindings: [],
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
  });

  it('waits within the configured completion window and fails on expiry', async () => {
    const settled = await workspace({ name: 'settled' });
    let reads = 0;
    let runs = 0;
    const { github } = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
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

    expect(waitCalls).toEqual([5000, 5000]);
    expect(jiraCalls).toContain('transition:1:41');

    // Expiry cannot produce completed: no wait fits in the configured window.
    events = [];
    const expired = await workspace({ name: 'expired' });
    const { wait: expiredWait, calls: expiredWaitCalls } = scriptedWait();
    const expiredHub = scriptedGitHub({
      readChecks: () => ok([reviewCheckObservation]),
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
    expect(jiraCalls).toEqual(['read:1', 'transitions:1', 'transition:1:41']);
    expect(await readRoundArtifact(workspaceRoot, 'completion.json')).toEqual(completion);

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
    expect(doneJiraCalls).toEqual(['read:1']);
    expect(doneHub.calls).toEqual(['read:7']);
  });
});
