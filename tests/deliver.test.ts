/**
 * Component tests: the real Deliver publishes the verified revision over real temporary storage
 * with the Git, GitHub and Jira adapters controlled. The producer-owned artifact declarations carry
 * the development and verification results; no live service, push or paid work is involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepositoryState } from '../src/adapters/git.js';
import type { JiraDocument } from '../src/adapters/jira.js';
import { ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { deliveryArtifact } from '../src/task-engine/actions/deliver/artifacts.js';
import { createDeliver } from '../src/task-engine/actions/deliver/index.js';
import {
  devArtifact,
  type DevelopmentOutput,
} from '../src/task-engine/actions/develop/artifacts.js';
import {
  verificationArtifact,
  type VerificationOutput,
} from '../src/task-engine/actions/verify/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { repositoryState, scriptedGit } from './support/git.js';
import { scriptedGitHub } from './support/github.js';
import { scriptedJira } from './support/jira.js';

const baseRevision = '1'.repeat(40);
const headRevision = '2'.repeat(40);
const otherRevision = '3'.repeat(40);
const repository = 'owner/repository';
const taskBranch = 'task/NEX-1';
const pullRequestUrl = `https://github.com/${repository}/pull/7`;

let root = '';
let events: EngineEvent[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-deliver-'));
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One workspace with its prepared identity, current round and selection record. */
async function workspace(name = 'workspace'): Promise<{
  readonly workspaceRoot: string;
  readonly selectionFile: string;
}> {
  const workspaceRoot = path.join(root, name);
  await mkdir(path.join(workspaceRoot, 'state'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'artifacts', '1'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'worktree'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'state', 'current-round.json'),
    `${JSON.stringify({ number: 1 })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceRoot, 'state', 'prepared-workspace.json'),
    `${JSON.stringify(
      {
        taskKey: 'NEX-1',
        repository: '/origin/repository.git',
        branch: taskBranch,
        baseRevision,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const selectionFile = path.join(root, 'executions', 'selection.json');
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
  return { workspaceRoot, selectionFile };
}

/** Write the current round's verified development and verification results. */
async function writeVerifiedRound(
  workspaceRoot: string,
  overrides: {
    readonly development?: Partial<DevelopmentOutput>;
    readonly verification?: Partial<VerificationOutput>;
  } = {},
): Promise<void> {
  const helpers = createArtifactHelpers({ root: workspaceRoot });
  await helpers.writeOutputArtifact(devArtifact, {
    taskKey: 'NEX-1',
    profile: 'dev-a',
    status: 'completed',
    baseRevision,
    headRevision,
    summary: 'Implemented the retry guard.',
    findingResponses: [],
    ...overrides.development,
  });
  await helpers.writeOutputArtifact(verificationArtifact, {
    headRevision,
    status: 'passed',
    checks: [
      {
        name: 'validate',
        exitCode: 0,
        stdoutPath: 'checks/0/stdout.log',
        stderrPath: 'checks/0/stderr.log',
      },
    ],
    ...overrides.verification,
  });
}

/** Write one artifact document into a round, as that round's producer did. */
async function writeRoundArtifact(
  workspaceRoot: string,
  round: number,
  name: string,
  content: unknown,
): Promise<void> {
  const directory = path.join(workspaceRoot, 'artifacts', String(round));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

/** Read one round artifact document. */
async function readRoundArtifact(
  workspaceRoot: string,
  round: number,
  name: string,
): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(workspaceRoot, 'artifacts', String(round), name), 'utf8'),
  ) as unknown;
}

/** The single paragraph's text of one Nexus comment document. */
function commentText(document: JiraDocument): string {
  const content = document['content'] as readonly { readonly content?: unknown }[];
  const paragraph = content[0]?.content as readonly { readonly text?: unknown }[] | undefined;
  const text = paragraph?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

const taskIssue = {
  id: '1',
  key: 'NEX-1',
  fields: {
    summary: 'Implement the retry guard',
    status: { id: '2', name: 'In Progress' },
  },
};

describe('Deliver', () => {
  it('publishes the verified revision, requests auto-merge and reports the developer summary', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    const { git, calls: gitCalls } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    const { github, calls: githubCalls } = scriptedGitHub({
      findPullRequests: () => ok([]),
      createPullRequest: () => ok({ number: 7, url: pullRequestUrl, headRevision }),
      requestAutoMerge: () => ok(undefined),
    });
    let comment: JiraDocument | null = null;
    const { jira, calls: jiraCalls } = scriptedJira({
      readIssue: () => ok(taskIssue),
      readComments: () => ok([]),
      readTransitions: () => ok([{ id: '31', name: 'Review', to: { id: '4', name: 'In Review' } }]),
      updateFields: () => ok(undefined),
      transitionIssue: () => ok(undefined),
      addComment: (_issueId, body) => {
        comment = body;
        return ok({ id: 'c9', body });
      },
    });
    const deliver = createDeliver({
      selectionFile,
      repository,
      baseBranch: 'main',
      pullRequestField: 'customfield_10002',
      reviewStatus: 'In Review',
      git,
      github,
      jira,
      publish: (event) => events.push(event),
    });

    await expect(deliver()).resolves.toBe('published');

    expect(await readRoundArtifact(workspaceRoot, 1, 'delivery.json')).toEqual({
      repository,
      pullRequestNumber: 7,
      pullRequestUrl,
      headRevision,
    });
    expect(gitCalls).toEqual([
      path.join(workspaceRoot, 'worktree'),
      `push:${taskBranch}@${headRevision}`,
      `remote:/origin/repository.git:${taskBranch}`,
    ]);
    expect(githubCalls).toEqual([
      `find:${taskBranch}->main`,
      `create:${taskBranch}->main`,
      `autoMerge:7@${headRevision}`,
    ]);
    expect(jiraCalls).toEqual([
      'read:1',
      'comments:1',
      'transitions:1',
      `update:1:${JSON.stringify({ pullRequest: pullRequestUrl })}`,
      'transition:1:31',
      'addComment:1',
    ]);
    expect(comment).not.toBeNull();
    expect(commentText(comment ?? {})).toBe('profile: dev-a\nImplemented the retry guard.');
    expect(events).toEqual([]);
  });

  it('records a failed delivery when the verified revision cannot be published', async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly expected: RegExp;
      readonly prepare: (workspaceRoot: string) => Promise<RepositoryState>;
    }> = [
      {
        label: 'a failed verification',
        expected: /Verification status is "failed"/,
        prepare: async (workspaceRoot) => {
          await writeVerifiedRound(workspaceRoot, { verification: { status: 'failed' } });
          return repositoryState({ headRevision });
        },
      },
      {
        label: 'a verification of another revision',
        expected: /not the development result/,
        prepare: async (workspaceRoot) => {
          await writeVerifiedRound(workspaceRoot, {
            verification: { headRevision: otherRevision },
          });
          return repositoryState({ headRevision });
        },
      },
      {
        label: 'a worktree at another revision',
        expected: /not the verified/,
        prepare: async (workspaceRoot) => {
          await writeVerifiedRound(workspaceRoot);
          return repositoryState({ headRevision: otherRevision });
        },
      },
      {
        label: 'uncommitted tracked changes',
        expected: /tracked changes/,
        prepare: async (workspaceRoot) => {
          await writeVerifiedRound(workspaceRoot);
          return repositoryState({ headRevision, trackedChanges: true });
        },
      },
    ];

    for (const testCase of cases) {
      events = [];
      const { workspaceRoot, selectionFile } = await workspace();
      const observation = await testCase.prepare(workspaceRoot);
      const { git } = scriptedGit([observation]);
      const { github } = scriptedGitHub({});
      const { jira } = scriptedJira({});
      const deliver = createDeliver({
        selectionFile,
        repository,
        baseBranch: 'main',
        pullRequestField: 'customfield_10002',
        reviewStatus: 'In Review',
        git,
        github,
        jira,
        publish: (event) => events.push(event),
      });

      await expect(deliver(), testCase.label).resolves.toBe('failed');
      await expect(
        stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json')),
        testCase.label,
      ).rejects.toThrow(/ENOENT/);
      expect(events.at(-1), testCase.label).toEqual({
        source: 'deliver',
        type: 'failed',
        data: { reason: expect.stringMatching(testCase.expected) },
      });
    }
  });

  it('records a failed delivery when the remote branch does not carry the verified revision', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(otherRevision),
    });
    const { github } = scriptedGitHub({});
    const { jira } = scriptedJira({});
    const deliver = createDeliver({
      selectionFile,
      repository,
      baseBranch: 'main',
      pullRequestField: 'customfield_10002',
      reviewStatus: 'In Review',
      git,
      github,
      jira,
      publish: (event) => events.push(event),
    });

    await expect(deliver()).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'deliver',
      type: 'failed',
      data: { reason: expect.stringMatching(/remote branch.*not the verified/s) },
    });
    await expect(stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json'))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('does not reuse a closed or unrelated pull request', async () => {
    const closed = await workspace();
    await writeVerifiedRound(closed.workspaceRoot);
    const helpers = createArtifactHelpers({ root: closed.workspaceRoot });
    await helpers.writeOutputArtifact(deliveryArtifact, {
      repository,
      pullRequestNumber: 7,
      pullRequestUrl,
      headRevision,
    });
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    const closedHub = scriptedGitHub({
      readPullRequest: () =>
        ok({
          number: 7,
          url: pullRequestUrl,
          state: 'closed',
          merged: false,
          baseBranch: 'main',
          headRevision,
          mergeRevision: null,
          autoMergeEnabled: false,
        }),
    });
    const closedDeliver = createDeliver({
      selectionFile: closed.selectionFile,
      repository,
      baseBranch: 'main',
      pullRequestField: 'customfield_10002',
      reviewStatus: 'In Review',
      git,
      github: closedHub.github,
      jira: scriptedJira({}).jira,
      publish: (event) => events.push(event),
    });

    await expect(closedDeliver()).resolves.toBe('failed');
    expect(closedHub.calls).toEqual(['read:7']);
    expect(events.at(-1)).toEqual({
      source: 'deliver',
      type: 'failed',
      data: { reason: expect.stringMatching(/closed without being merged/) },
    });

    // An open pull request on the branch that carries another revision is unrelated, too.
    events = [];
    const unrelated = await workspace('unrelated');
    await writeVerifiedRound(unrelated.workspaceRoot);
    const unrelatedHub = scriptedGitHub({
      findPullRequests: () => ok([{ number: 8, url: pullRequestUrl }]),
      readPullRequest: () =>
        ok({
          number: 8,
          url: pullRequestUrl,
          state: 'open',
          merged: false,
          baseBranch: 'main',
          headRevision: otherRevision,
          mergeRevision: null,
          autoMergeEnabled: false,
        }),
    });
    const unrelatedDeliver = createDeliver({
      selectionFile: unrelated.selectionFile,
      repository,
      baseBranch: 'main',
      pullRequestField: 'customfield_10002',
      reviewStatus: 'In Review',
      git,
      github: unrelatedHub.github,
      jira: scriptedJira({}).jira,
      publish: (event) => events.push(event),
    });

    await expect(unrelatedDeliver()).resolves.toBe('failed');
    expect(unrelatedHub.calls).toEqual([`find:${taskBranch}->main`, 'read:8']);
    expect(events.at(-1)).toEqual({
      source: 'deliver',
      type: 'failed',
      data: { reason: expect.stringMatching(/not reused/) },
    });
  });

  it('finishes the publication of a recorded pull request without repeating completed steps', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    const helpers = createArtifactHelpers({ root: workspaceRoot });
    await helpers.writeOutputArtifact(deliveryArtifact, {
      repository,
      pullRequestNumber: 7,
      pullRequestUrl,
      headRevision,
    });
    const publishedComment: JiraDocument = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'profile: dev-a\nImplemented the retry guard.' }],
        },
      ],
    };
    const { git, calls: gitCalls } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    const { github, calls: githubCalls } = scriptedGitHub({
      readPullRequest: () =>
        ok({
          number: 7,
          url: pullRequestUrl,
          state: 'open',
          merged: false,
          baseBranch: 'main',
          headRevision,
          mergeRevision: null,
          autoMergeEnabled: true,
        }),
      updatePullRequest: () => ok({ number: 7, url: pullRequestUrl, headRevision }),
    });
    const { jira, calls: jiraCalls } = scriptedJira({
      readIssue: () =>
        ok({
          id: '1',
          key: 'NEX-1',
          fields: {
            summary: 'Implement the retry guard',
            status: { id: '4', name: 'In Review' },
            customfield_10002: pullRequestUrl,
          },
        }),
      readComments: () => ok([{ id: 'c1', body: publishedComment }]),
    });
    const deliver = createDeliver({
      selectionFile,
      repository,
      baseBranch: 'main',
      pullRequestField: 'customfield_10002',
      reviewStatus: 'In Review',
      git,
      github,
      jira,
      publish: (event) => events.push(event),
    });

    await expect(deliver()).resolves.toBe('published');

    expect(gitCalls).toEqual([
      path.join(workspaceRoot, 'worktree'),
      `push:${taskBranch}@${headRevision}`,
      `remote:/origin/repository.git:${taskBranch}`,
    ]);
    // The recorded pull request is updated, and auto-merge is not requested again.
    expect(githubCalls).toEqual(['read:7', 'update:7']);
    // The ticket already holds the pull request and review status, and the comment is not repeated.
    expect(jiraCalls).toEqual(['read:1', 'comments:1']);
    expect(await readRoundArtifact(workspaceRoot, 1, 'delivery.json')).toEqual({
      repository,
      pullRequestNumber: 7,
      pullRequestUrl,
      headRevision,
    });
  });

  it('reports the completed repair turns and the profile escalation', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeFile(
      path.join(workspaceRoot, 'state', 'current-round.json'),
      `${JSON.stringify({ number: 3 })}\n`,
      'utf8',
    );
    await mkdir(path.join(workspaceRoot, 'artifacts', '3'), { recursive: true });
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'First implementation.',
      findingResponses: [],
    });
    await writeRoundArtifact(workspaceRoot, 2, 'development.json', {
      taskKey: 'NEX-1',
      profile: 'dev-b',
      status: 'failed',
      baseRevision,
      headRevision: otherRevision,
      summary: 'Incomplete repair.',
      findingResponses: [],
    });
    await writeRoundArtifact(workspaceRoot, 2, 'repair.json', {
      decision: 'selected',
      profile: 'dev-b',
      repairsUsed: 1,
      reason: 'Profile "dev-a" has no allowance remaining; the repair escalates to "dev-b".',
    });
    await writeVerifiedRound(workspaceRoot, { development: { profile: 'dev-b' } });
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    const { github } = scriptedGitHub({
      findPullRequests: () => ok([]),
      createPullRequest: () => ok({ number: 7, url: pullRequestUrl, headRevision }),
      requestAutoMerge: () => ok(undefined),
    });
    let comment: JiraDocument | null = null;
    const { jira } = scriptedJira({
      readIssue: () => ok(taskIssue),
      readComments: () => ok([]),
      readTransitions: () => ok([{ id: '31', name: 'Review', to: { id: '4', name: 'In Review' } }]),
      updateFields: () => ok(undefined),
      transitionIssue: () => ok(undefined),
      addComment: (_issueId, body) => {
        comment = body;
        return ok({ id: 'c9', body });
      },
    });
    const deliver = createDeliver({
      selectionFile,
      repository,
      baseBranch: 'main',
      pullRequestField: 'customfield_10002',
      reviewStatus: 'In Review',
      git,
      github,
      jira,
      publish: (event) => events.push(event),
    });

    await expect(deliver()).resolves.toBe('published');

    expect(commentText(comment ?? {})).toBe(
      'profile: dev-b\nImplemented the retry guard.\n' +
        'Repairs used: 2, escalated from "dev-a" to "dev-b".',
    );
  });
});
