/**
 * Component tests: the real Deliver publishes the verified revision over real temporary storage
 * with the Git, GitHub and Jira adapters controlled. The producer-owned artifact declarations carry
 * the development and verification results; no live service, push or paid work is involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitAdapter, RepositoryState } from '../src/adapters/git.js';
import type { GitHubAdapter, PullRequest } from '../src/adapters/github.js';
import type { JiraAdapter, JiraDocument } from '../src/adapters/jira.js';
import { fault, ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { deliveryArtifact } from '../src/task-engine/actions/deliver/artifacts.js';
import { createDeliver } from '../src/task-engine/actions/deliver/index.js';
import { createPublishDeliveryReport } from '../src/task-engine/actions/project/source-boundaries/index.js';
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

/** The pull-request URL of one number in the configured repository. */
function pullRequestUrlOf(number: number): string {
  return `https://github.com/${repository}/pull/${String(number)}`;
}

const pullRequestUrl = pullRequestUrlOf(7);

let root = '';
let events: EngineEvent[] = [];
let clock = 0;
let wait: (milliseconds: number) => Promise<void>;
let waitCalls: number[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-deliver-'));
  events = [];
  // Controlled time: waiting advances the clock instead of the test passing time.
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  waitCalls = [];
  wait = async (milliseconds) => {
    waitCalls.push(milliseconds);
    clock += milliseconds;
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** Deliver bound to the configured repository, controlled adapters and controlled time. */
function deliverAction(options: {
  readonly selectionFile: string;
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  readonly jira?: JiraAdapter;
}): ReturnType<typeof createDeliver> {
  return createDeliver({
    selectionFile: options.selectionFile,
    repository,
    baseBranch: 'main',
    git: options.git,
    github: options.github,
    publish: (event) => events.push(event),
    wait,
  });
}

/** One pull-request observation for the task branch, open on the configured base by default. */
function pullRequestObservation(head: string, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    url: pullRequestUrl,
    state: 'open',
    merged: false,
    headBranch: taskBranch,
    baseBranch: 'main',
    headRevision: head,
    mergeRevision: null,
    autoMergeEnabled: false,
    ...overrides,
  };
}

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
    `${JSON.stringify({ number: 1, profile: 'dev-a', reason: 'Planned.' })}\n`,
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
        stage: 'delivery',
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

/** The parent-owned publication over the same selection and controlled source. */
function publishReport(
  selectionFile: string,
  jira: JiraAdapter,
): ReturnType<typeof createPublishDeliveryReport> {
  return createPublishDeliveryReport({
    selectionFile,
    pullRequestField: 'customfield_10002',
    reviewStatus: 'In Review',
    jira,
    publish: () => undefined,
  });
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

/** A controlled Jira source that accepts one publication into the configured review status. */
function publishingJira(): ReturnType<typeof scriptedJira> {
  return scriptedJira({
    readIssue: () => ok(taskIssue),
    readComments: () => ok([]),
    readTransitions: () => ok([{ id: '31', name: 'Review', to: { id: '4', name: 'In Review' } }]),
    updateFields: () => ok(undefined),
    transitionIssue: () => ok(undefined),
    addComment: (_issueId, body) => ok({ id: 'c9', body }),
  });
}

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
    const deliver = deliverAction({ selectionFile, git, github, jira });

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
    // The child has no Jira capability; the parent-owned boundary actor publishes the report.
    expect(jiraCalls).toEqual([]);
    await expect(publishReport(selectionFile, jira)()).resolves.toBe('published');
    expect(jiraCalls).toEqual([
      'read:1',
      'comments:1',
      `update:1:${JSON.stringify({ pullRequest: pullRequestUrl })}`,
      'transitions:1',
      'transition:1:31',
      'addComment:1',
    ]);
    expect(comment).not.toBeNull();
    expect(commentText(comment ?? {})).toBe(
      'profile: dev-a\nImplemented the retry guard.\nPull request: ' + pullRequestUrl,
    );
    // The saved delivery record is what the published outcome event references.
    expect(events).toEqual([
      {
        source: 'deliver',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: 1,
          outcome: 'published',
          detail: 'PR #7',
          artifact: { path: path.join(workspaceRoot, 'artifacts', '1', 'delivery.json') },
        },
      },
    ]);
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
      const deliver = deliverAction({ selectionFile, git, github, jira });

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
      // The stated reason is retained for the terminal handoff, not only published.
      expect(
        JSON.parse(
          await readFile(
            path.join(workspaceRoot, 'artifacts', '1', 'delivery-failure.json'),
            'utf8',
          ),
        ),
        testCase.label,
      ).toEqual({ reason: expect.stringMatching(testCase.expected) });
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
    const deliver = deliverAction({ selectionFile, git, github, jira });

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

  it('fails immediately on a closed, retargeted or merged-elsewhere target', async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly expected: RegExp;
      readonly observation: PullRequest;
    }> = [
      {
        label: 'a closed recorded pull request',
        expected: /closed without being merged/,
        observation: pullRequestObservation(headRevision, { state: 'closed' }),
      },
      {
        label: 'a recorded pull request for another base',
        expected: /targets "develop", not the configured "main"/,
        observation: pullRequestObservation(headRevision, { baseBranch: 'develop' }),
      },
      {
        label: 'a recorded pull request merged at another revision',
        expected: /Merged pull request #7 carries revision/,
        observation: pullRequestObservation(otherRevision, {
          state: 'closed',
          merged: true,
          mergeRevision: '4'.repeat(40),
        }),
      },
    ];

    for (const testCase of cases) {
      events = [];
      const { workspaceRoot, selectionFile } = await workspace();
      await writeVerifiedRound(workspaceRoot);
      const helpers = createArtifactHelpers({ root: workspaceRoot });
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
      const hub = scriptedGitHub({ readPullRequest: () => ok(testCase.observation) });
      const deliver = deliverAction({
        selectionFile,
        git,
        github: hub.github,
        jira: scriptedJira({}).jira,
      });

      await expect(deliver(), testCase.label).resolves.toBe('failed');
      expect(events.at(-1), testCase.label).toEqual({
        source: 'deliver',
        type: 'failed',
        data: { reason: expect.stringMatching(testCase.expected) },
      });
      // An unrelated target cannot catch up: the pull request is observed once, not polled.
      expect(hub.calls, testCase.label).toEqual(['read:7']);
      expect(waitCalls, testCase.label).toEqual([]);
      // The recorded publication is retained untouched.
      expect(await readRoundArtifact(workspaceRoot, 1, 'delivery.json'), testCase.label).toEqual({
        repository,
        pullRequestNumber: 7,
        pullRequestUrl,
        headRevision,
      });
    }
  });

  it('validates a discovered merged pull request before reusing it', async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly name: string;
      readonly expected: RegExp;
      readonly observation: PullRequest;
    }> = [
      {
        label: 'a merged pull request for another base',
        name: 'merged-other-base',
        expected: /targets "develop", not the configured "main"/,
        observation: pullRequestObservation(headRevision, {
          state: 'closed',
          merged: true,
          baseBranch: 'develop',
          mergeRevision: '4'.repeat(40),
        }),
      },
      {
        label: 'a merged pull request for another branch',
        name: 'merged-other-branch',
        expected: /is on branch "unrelated-branch", not the prepared/,
        observation: pullRequestObservation(headRevision, {
          state: 'closed',
          merged: true,
          headBranch: 'unrelated-branch',
          mergeRevision: '4'.repeat(40),
        }),
      },
    ];

    for (const testCase of cases) {
      events = [];
      waitCalls = [];
      const { workspaceRoot, selectionFile } = await workspace(testCase.name);
      await writeVerifiedRound(workspaceRoot);
      const { git } = scriptedGit([repositoryState({ headRevision })], {
        pushBranch: () => ok({ branch: taskBranch, headRevision }),
        readRemoteBranchHead: () => ok(headRevision),
      });
      // The branch search matches, but the full observation reports a different target; the
      // mismatched merge is judged once and no publication write follows.
      const hub = scriptedGitHub({
        findPullRequests: () => ok([{ number: 7, url: pullRequestUrl }]),
        readPullRequest: () => ok(testCase.observation),
      });
      const deliver = deliverAction({
        selectionFile,
        git,
        github: hub.github,
        jira: scriptedJira({}).jira,
      });

      await expect(deliver(), testCase.label).resolves.toBe('failed');
      expect(events.at(-1), testCase.label).toEqual({
        source: 'deliver',
        type: 'failed',
        data: { reason: expect.stringMatching(testCase.expected) },
      });
      expect(hub.calls, testCase.label).toEqual([`find:${taskBranch}->main`, 'read:7']);
      expect(waitCalls, testCase.label).toEqual([]);
      await expect(
        stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json')),
        testCase.label,
      ).rejects.toThrow(/ENOENT/);
    }
  });

  it('fails immediately on a pull request whose head branch is not the prepared branch', async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly name: string;
      readonly recorded: boolean;
    }> = [
      { label: 'a recorded pull request', name: 'recorded-branch', recorded: true },
      { label: 'a discovered open pull request', name: 'discovered-branch', recorded: false },
    ];

    for (const testCase of cases) {
      events = [];
      waitCalls = [];
      const { workspaceRoot, selectionFile } = await workspace(testCase.name);
      await writeVerifiedRound(workspaceRoot);
      if (testCase.recorded) {
        const helpers = createArtifactHelpers({ root: workspaceRoot });
        await helpers.writeOutputArtifact(deliveryArtifact, {
          repository,
          pullRequestNumber: 7,
          pullRequestUrl,
          headRevision,
        });
      }
      const { git } = scriptedGit([repositoryState({ headRevision })], {
        pushBranch: () => ok({ branch: taskBranch, headRevision }),
        readRemoteBranchHead: () => ok(headRevision),
      });
      // The verified revision and configured base match, but the pull request belongs to another
      // branch; it is not updated or reused.
      const hub = scriptedGitHub({
        findPullRequests: () => ok([{ number: 7, url: pullRequestUrl }]),
        readPullRequest: () =>
          ok(pullRequestObservation(headRevision, { headBranch: 'unrelated-branch' })),
      });
      const deliver = deliverAction({
        selectionFile,
        git,
        github: hub.github,
        jira: scriptedJira({}).jira,
      });

      await expect(deliver(), testCase.label).resolves.toBe('failed');
      expect(events.at(-1), testCase.label).toEqual({
        source: 'deliver',
        type: 'failed',
        data: {
          reason: expect.stringMatching(/is on branch "unrelated-branch", not the prepared/),
        },
      });
      expect(hub.calls, testCase.label).toEqual(
        testCase.recorded ? ['read:7'] : [`find:${taskBranch}->main`, 'read:7'],
      );
      expect(waitCalls, testCase.label).toEqual([]);
      const artifact = stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json'));
      if (testCase.recorded) {
        // The recorded publication is retained untouched.
        await expect(artifact, testCase.label).resolves.toBeDefined();
      } else {
        await expect(artifact, testCase.label).rejects.toThrow(/ENOENT/);
      }
    }
  });

  it('does not accept a branch change while confirming the verified revision', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    const helpers = createArtifactHelpers({ root: workspaceRoot });
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
    let reads = 0;
    const hub = scriptedGitHub({
      readPullRequest: () => {
        reads += 1;
        // The first observation is stale on the prepared branch; the catch-up reports the verified
        // revision on another branch.
        return ok(
          reads === 1
            ? pullRequestObservation(otherRevision)
            : pullRequestObservation(headRevision, { headBranch: 'unrelated-branch' }),
        );
      },
    });
    const deliver = deliverAction({
      selectionFile,
      git,
      github: hub.github,
      jira: scriptedJira({}).jira,
    });

    await expect(deliver()).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'deliver',
      type: 'failed',
      data: {
        reason: expect.stringMatching(/is on branch "unrelated-branch", not the prepared/),
      },
    });
    expect(hub.calls).toEqual(['read:7', 'read:7']);
    expect(waitCalls).toHaveLength(1);
    // The recorded publication is retained untouched.
    expect(await readRoundArtifact(workspaceRoot, 1, 'delivery.json')).toEqual({
      repository,
      pullRequestNumber: 7,
      pullRequestUrl,
      headRevision,
    });
  });

  it('does not silently choose among ambiguous matching pull requests', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    const hub = scriptedGitHub({
      findPullRequests: () =>
        ok([
          { number: 7, url: pullRequestUrl },
          { number: 8, url: pullRequestUrlOf(8) },
        ]),
      readPullRequest: (_repository, number) =>
        ok(pullRequestObservation(headRevision, { number })),
    });
    const deliver = deliverAction({
      selectionFile,
      git,
      github: hub.github,
      jira: scriptedJira({}).jira,
    });

    await expect(deliver()).resolves.toBe('failed');
    expect(events.at(-1)).toEqual({
      source: 'deliver',
      type: 'failed',
      data: { reason: expect.stringMatching(/More than one open pull request/) },
    });
    expect(hub.calls).toEqual([`find:${taskBranch}->main`, 'read:7', 'read:8']);
    expect(waitCalls).toEqual([]);
    await expect(stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json'))).rejects.toThrow(
      /ENOENT/,
    );
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
          headBranch: taskBranch,
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
    const deliver = deliverAction({ selectionFile, git, github, jira });

    await expect(deliver()).resolves.toBe('published');

    expect(gitCalls).toEqual([
      path.join(workspaceRoot, 'worktree'),
      `push:${taskBranch}@${headRevision}`,
      `remote:/origin/repository.git:${taskBranch}`,
    ]);
    // The recorded pull request is updated, and auto-merge is not requested again.
    expect(githubCalls).toEqual(['read:7', 'update:7']);
    // The child performs no source writes of its own.
    expect(jiraCalls).toEqual([]);
    expect(await readRoundArtifact(workspaceRoot, 1, 'delivery.json')).toEqual({
      repository,
      pullRequestNumber: 7,
      pullRequestUrl,
      headRevision,
    });
  });

  it('waits for a matching open pull request to report the verified revision', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    let reads = 0;
    const { git, calls: gitCalls } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    const { github, calls: githubCalls } = scriptedGitHub({
      findPullRequests: () => ok([{ number: 7, url: pullRequestUrl }]),
      // The provider first reports the previous head, then catches up with the verified revision.
      readPullRequest: () => {
        reads += 1;
        return ok(pullRequestObservation(reads === 1 ? otherRevision : headRevision));
      },
      updatePullRequest: () => ok({ number: 7, url: pullRequestUrl, headRevision }),
      requestAutoMerge: () => ok(undefined),
    });
    const deliver = deliverAction({
      selectionFile,
      git,
      github,
      jira: publishingJira().jira,
    });

    await expect(deliver()).resolves.toBe('published');

    expect(reads).toBe(2);
    expect(waitCalls).toHaveLength(1);
    expect(waitCalls[0]).toBeGreaterThan(0);
    // The stale observation is re-read, not published again: one push, one update and one
    // auto-merge request for the verified revision.
    expect(gitCalls).toEqual([
      path.join(workspaceRoot, 'worktree'),
      `push:${taskBranch}@${headRevision}`,
      `remote:/origin/repository.git:${taskBranch}`,
    ]);
    expect(githubCalls).toEqual([
      `find:${taskBranch}->main`,
      'read:7',
      'read:7',
      'update:7',
      `autoMerge:7@${headRevision}`,
    ]);
    expect(await readRoundArtifact(workspaceRoot, 1, 'delivery.json')).toEqual({
      repository,
      pullRequestNumber: 7,
      pullRequestUrl,
      headRevision,
    });
  });

  it('waits for a creation or update that reports the previous head', async () => {
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });

    // A creation that still reports the previous head is confirmed by re-reading the new pull
    // request, without creating another one.
    const created = await workspace();
    await writeVerifiedRound(created.workspaceRoot);
    let createdReads = 0;
    const createdHub = scriptedGitHub({
      findPullRequests: () => ok([]),
      createPullRequest: () => ok({ number: 7, url: pullRequestUrl, headRevision: otherRevision }),
      readPullRequest: () => {
        createdReads += 1;
        return ok(pullRequestObservation(createdReads === 1 ? otherRevision : headRevision));
      },
      requestAutoMerge: () => ok(undefined),
    });
    const deliverCreated = deliverAction({
      selectionFile: created.selectionFile,
      git,
      github: createdHub.github,
      jira: publishingJira().jira,
    });

    await expect(deliverCreated()).resolves.toBe('published');
    expect(createdHub.calls).toEqual([
      `find:${taskBranch}->main`,
      `create:${taskBranch}->main`,
      'read:7',
      'read:7',
      `autoMerge:7@${headRevision}`,
    ]);
    expect(waitCalls).toHaveLength(1);

    // An update that reports the previous head is confirmed the same way, without another write.
    events = [];
    waitCalls = [];
    const updated = await workspace('updated');
    await writeVerifiedRound(updated.workspaceRoot);
    const helpers = createArtifactHelpers({ root: updated.workspaceRoot });
    await helpers.writeOutputArtifact(deliveryArtifact, {
      repository,
      pullRequestNumber: 7,
      pullRequestUrl,
      headRevision,
    });
    let updatedReads = 0;
    const updatedHub = scriptedGitHub({
      readPullRequest: () => {
        updatedReads += 1;
        return ok(pullRequestObservation(updatedReads === 2 ? otherRevision : headRevision));
      },
      updatePullRequest: () => ok({ number: 7, url: pullRequestUrl, headRevision: otherRevision }),
      requestAutoMerge: () => ok(undefined),
    });
    const deliverUpdated = deliverAction({
      selectionFile: updated.selectionFile,
      git,
      github: updatedHub.github,
      jira: publishingJira().jira,
    });

    await expect(deliverUpdated()).resolves.toBe('published');
    expect(updatedHub.calls).toEqual([
      'read:7',
      'update:7',
      'read:7',
      'read:7',
      `autoMerge:7@${headRevision}`,
    ]);
    expect(waitCalls).toHaveLength(1);
  });

  it('uses the state observed while confirming a created pull request', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    let reads = 0;
    const hub = scriptedGitHub({
      findPullRequests: () => ok([]),
      createPullRequest: () => ok({ number: 7, url: pullRequestUrl, headRevision: otherRevision }),
      // The provider catches up with the verified revision, and by then auto-merge is already
      // enabled: the stale creation response needs no auto-merge request.
      readPullRequest: () => {
        reads += 1;
        return ok(
          pullRequestObservation(reads === 1 ? otherRevision : headRevision, {
            autoMergeEnabled: true,
          }),
        );
      },
    });
    const deliver = deliverAction({
      selectionFile,
      git,
      github: hub.github,
      jira: publishingJira().jira,
    });

    await expect(deliver()).resolves.toBe('published');

    expect(hub.calls).toEqual([
      `find:${taskBranch}->main`,
      `create:${taskBranch}->main`,
      'read:7',
      'read:7',
    ]);
    expect(waitCalls).toHaveLength(1);
    expect(await readRoundArtifact(workspaceRoot, 1, 'delivery.json')).toEqual({
      repository,
      pullRequestNumber: 7,
      pullRequestUrl,
      headRevision,
    });
  });

  it('uses the state observed while confirming an updated pull request', async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly name: string;
      readonly initialAutoMergeEnabled: boolean;
      readonly confirming: PullRequest;
      readonly expectedCalls: readonly string[];
    }> = [
      {
        label: 'auto-merge disabled while the update response was stale',
        name: 'auto-merge-disabled',
        initialAutoMergeEnabled: true,
        confirming: pullRequestObservation(headRevision, { autoMergeEnabled: false }),
        expectedCalls: ['read:7', 'update:7', 'read:7', 'read:7', `autoMerge:7@${headRevision}`],
      },
      {
        label: 'merged while the update response was stale',
        name: 'merged-while-confirming',
        initialAutoMergeEnabled: false,
        confirming: pullRequestObservation(headRevision, {
          state: 'closed',
          merged: true,
          mergeRevision: '4'.repeat(40),
        }),
        expectedCalls: ['read:7', 'update:7', 'read:7', 'read:7'],
      },
    ];

    for (const testCase of cases) {
      events = [];
      waitCalls = [];
      const { workspaceRoot, selectionFile } = await workspace(testCase.name);
      await writeVerifiedRound(workspaceRoot);
      const helpers = createArtifactHelpers({ root: workspaceRoot });
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
      let reads = 0;
      const hub = scriptedGitHub({
        readPullRequest: () => {
          reads += 1;
          if (reads === 1) {
            // The recorded target observation before the update.
            return ok(
              pullRequestObservation(headRevision, {
                autoMergeEnabled: testCase.initialAutoMergeEnabled,
              }),
            );
          }
          if (reads === 2) {
            // The observation following the update response still names the previous head.
            return ok(pullRequestObservation(otherRevision));
          }
          return ok(testCase.confirming);
        },
        updatePullRequest: () =>
          ok({ number: 7, url: pullRequestUrl, headRevision: otherRevision }),
        requestAutoMerge: () => ok(undefined),
      });
      const deliver = deliverAction({
        selectionFile,
        git,
        github: hub.github,
        jira: publishingJira().jira,
      });

      await expect(deliver(), testCase.label).resolves.toBe('published');
      // The confirming observation decides the auto-merge request, not the stale one.
      expect(hub.calls, testCase.label).toEqual(testCase.expectedCalls);
      expect(waitCalls, testCase.label).toHaveLength(1);
      expect(await readRoundArtifact(workspaceRoot, 1, 'delivery.json'), testCase.label).toEqual({
        repository,
        pullRequestNumber: 7,
        pullRequestUrl,
        headRevision,
      });
    }
  });

  it('fails when the pull request never reports the verified revision within the deadline', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    const { git, calls: gitCalls } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    const hub = scriptedGitHub({
      findPullRequests: () => ok([{ number: 7, url: pullRequestUrl }]),
      readPullRequest: () => ok(pullRequestObservation(otherRevision)),
    });
    const deliver = deliverAction({
      selectionFile,
      git,
      github: hub.github,
      jira: scriptedJira({}).jira,
    });

    await expect(deliver()).resolves.toBe('failed');

    // The failure reason retains the expected and last observed revisions.
    const reason = (events.at(-1)?.data as { readonly reason?: string }).reason ?? '';
    expect(reason).toContain(`reports revision ${otherRevision}`);
    expect(reason).toContain(`the verified ${headRevision}`);
    expect(reason).toMatch(/post-push confirmation deadline of \d+s expired/);
    // The re-reads are bounded and at one fixed interval; no publication write follows them.
    expect(new Set(waitCalls).size).toBe(1);
    expect(waitCalls.length).toBeGreaterThan(1);
    expect(hub.calls).toEqual([
      `find:${taskBranch}->main`,
      ...waitCalls.map(() => 'read:7'),
      'read:7',
    ]);
    expect(gitCalls).toEqual([
      path.join(workspaceRoot, 'worktree'),
      `push:${taskBranch}@${headRevision}`,
      `remote:/origin/repository.git:${taskBranch}`,
    ]);
    await expect(stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json'))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('ends the confirmation when the next read would land beyond the deadline', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    let reads = 0;
    const hub = scriptedGitHub({
      findPullRequests: () => ok([{ number: 7, url: pullRequestUrl }]),
      // The provider takes 19 of the 20 seconds to report the previous head, so the fixed re-read
      // interval would land beyond the deadline.
      readPullRequest: () => {
        reads += 1;
        clock += 19_000;
        return ok(pullRequestObservation(otherRevision));
      },
    });
    const deliver = deliverAction({
      selectionFile,
      git,
      github: hub.github,
      jira: scriptedJira({}).jira,
    });

    await expect(deliver()).resolves.toBe('failed');

    // The failure retains the expected and last observed revisions.
    const reason = (events.at(-1)?.data as { readonly reason?: string }).reason ?? '';
    expect(reason).toContain(`reports revision ${otherRevision}`);
    expect(reason).toContain(`the verified ${headRevision}`);
    expect(reason).toMatch(/post-push confirmation deadline of \d+s expired/);
    // No read and no wait follow the observation that used up the deadline.
    expect(reads).toBe(1);
    expect(hub.calls).toEqual([`find:${taskBranch}->main`, 'read:7']);
    expect(waitCalls).toEqual([]);
    await expect(stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json'))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('does not accept a confirmation observed after the deadline', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    let reads = 0;
    const hub = scriptedGitHub({
      findPullRequests: () => ok([{ number: 7, url: pullRequestUrl }]),
      readPullRequest: () => {
        reads += 1;
        if (reads === 1) {
          return ok(pullRequestObservation(otherRevision));
        }
        // The re-read is issued inside the deadline, but the provider only answers with the
        // verified revision after the deadline expired.
        clock += 25_000;
        return ok(pullRequestObservation(headRevision));
      },
    });
    const deliver = deliverAction({
      selectionFile,
      git,
      github: hub.github,
      jira: scriptedJira({}).jira,
    });

    await expect(deliver()).resolves.toBe('failed');

    // The late confirmation retains the expected and last observed revisions and publishes no
    // update or auto-merge request.
    const reason = (events.at(-1)?.data as { readonly reason?: string }).reason ?? '';
    expect(reason).toContain(headRevision);
    expect(reason).toMatch(/reported the verified revision .*, but only after /);
    expect(reason).toMatch(/post-push confirmation deadline of \d+s expired/);
    expect(hub.calls).toEqual([`find:${taskBranch}->main`, 'read:7', 'read:7']);
    expect(waitCalls).toHaveLength(1);
    await expect(stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json'))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it.each(['recorded', 'discovered'] as const)(
    'does not read a %s target after the final timer overruns the deadline',
    async (target) => {
      const { workspaceRoot, selectionFile } = await workspace();
      await writeVerifiedRound(workspaceRoot);
      if (target === 'recorded') {
        await createArtifactHelpers({ root: workspaceRoot }).writeOutputArtifact(deliveryArtifact, {
          repository,
          pullRequestNumber: 7,
          pullRequestUrl,
          headRevision,
        });
      }
      const { git, calls: gitCalls } = scriptedGit([repositoryState({ headRevision })], {
        pushBranch: () => ok({ branch: taskBranch, headRevision }),
        readRemoteBranchHead: () => ok(headRevision),
      });
      let reads = 0;
      const hub = scriptedGitHub({
        findPullRequests: () => ok([{ number: 7, url: pullRequestUrl }]),
        readPullRequest: () => {
          if (++reads > 1) return fault('A post-deadline read must not start.');
          clock += 18_000;
          return ok(pullRequestObservation(otherRevision));
        },
      });
      wait = async (milliseconds) => {
        waitCalls.push(milliseconds);
        clock += milliseconds + 100;
      };
      const jira = scriptedJira({});
      const deliver = deliverAction({ selectionFile, git, github: hub.github, jira: jira.jira });

      await expect(deliver()).resolves.toBe('failed');
      const reason = (events.at(-1)?.data as { reason: string }).reason;
      expect(reason).toContain(otherRevision);
      expect(reason).toContain(headRevision);
      expect(reason).toContain('confirmation deadline of 20s expired');
      expect(hub.calls).toEqual(
        target === 'recorded' ? ['read:7'] : [`find:${taskBranch}->main`, 'read:7'],
      );
      expect(waitCalls).toEqual([2_000]);
      expect(gitCalls.filter((call) => call.startsWith('push:'))).toHaveLength(1);
      expect(jira.calls).toEqual([]);
    },
  );

  it.each([
    { operation: 'create', revision: otherRevision },
    { operation: 'update', revision: otherRevision },
    { operation: 'create', revision: headRevision },
  ])(
    'rejects a late $operation response reporting $revision without further reads',
    async ({ operation, revision }) => {
      const { workspaceRoot, selectionFile } = await workspace();
      await writeVerifiedRound(workspaceRoot);
      const { git, calls: gitCalls } = scriptedGit([repositoryState({ headRevision })], {
        pushBranch: () => ok({ branch: taskBranch, headRevision }),
        readRemoteBranchHead: () => ok(headRevision),
      });
      const publication = () => {
        clock += 21_000;
        return ok({ number: 7, url: pullRequestUrl, headRevision: revision });
      };
      let reads = 0;
      const hub = scriptedGitHub({
        findPullRequests: () =>
          ok(operation === 'create' ? [] : [{ number: 7, url: pullRequestUrl }]),
        readPullRequest: () => {
          if (operation === 'create' || ++reads > 1)
            return fault('A post-deadline read must not start.');
          return ok(pullRequestObservation(headRevision));
        },
        createPullRequest: publication,
        updatePullRequest: publication,
        requestAutoMerge: () => ok(undefined),
      });
      const jira = publishingJira();
      const deliver = deliverAction({ selectionFile, git, github: hub.github, jira: jira.jira });

      await expect(deliver()).resolves.toBe('failed');
      const reason = (events.at(-1)?.data as { reason: string }).reason;
      expect(reason).toContain(revision);
      expect(reason).toContain(headRevision);
      expect(reason).toContain('confirmation deadline of 20s expired');
      expect(hub.calls).toEqual([
        `find:${taskBranch}->main`,
        ...(operation === 'create' ? [`create:${taskBranch}->main`] : ['read:7', 'update:7']),
      ]);
      expect(waitCalls).toEqual([]);
      expect(gitCalls.filter((call) => call.startsWith('push:'))).toHaveLength(1);
      expect(jira.calls).toEqual([]);
      await expect(
        stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json')),
      ).rejects.toThrow(/ENOENT/);
    },
  );

  it.each(['creation', 're-read'] as const)(
    'accepts a %s confirmation arriving exactly at the deadline',
    async (confirmation) => {
      const { workspaceRoot, selectionFile } = await workspace();
      await writeVerifiedRound(workspaceRoot);
      const { git } = scriptedGit([repositoryState({ headRevision })], {
        pushBranch: () => ok({ branch: taskBranch, headRevision }),
        readRemoteBranchHead: () => ok(headRevision),
      });
      let reads = 0;
      const hub = scriptedGitHub({
        findPullRequests: () =>
          ok(confirmation === 'creation' ? [] : [{ number: 7, url: pullRequestUrl }]),
        createPullRequest: () => {
          clock += 20_000;
          return ok({ number: 7, url: pullRequestUrl, headRevision });
        },
        readPullRequest: () => {
          if (++reads === 1) {
            clock += 18_000;
            return ok(pullRequestObservation(otherRevision));
          }
          return ok(pullRequestObservation(headRevision));
        },
        updatePullRequest: () => ok({ number: 7, url: pullRequestUrl, headRevision }),
        requestAutoMerge: () => ok(undefined),
      });
      const deliver = deliverAction({
        selectionFile,
        git,
        github: hub.github,
        jira: publishingJira().jira,
      });

      await expect(deliver()).resolves.toBe('published');
      expect(hub.calls).toEqual([
        `find:${taskBranch}->main`,
        ...(confirmation === 'creation'
          ? [`create:${taskBranch}->main`]
          : ['read:7', 'read:7', 'update:7']),
        `autoMerge:7@${headRevision}`,
      ]);
      expect(waitCalls).toEqual(confirmation === 'creation' ? [] : [2_000]);
      expect(await readRoundArtifact(workspaceRoot, 1, 'delivery.json')).toEqual({
        repository,
        pullRequestNumber: 7,
        pullRequestUrl,
        headRevision,
      });
    },
  );

  it.each(['search', 'observation'] as const)(
    'does not start further discovery reads after a slow %s exhausts the deadline',
    async (slowOperation) => {
      const { workspaceRoot, selectionFile } = await workspace();
      await writeVerifiedRound(workspaceRoot);
      const { git } = scriptedGit([repositoryState({ headRevision })], {
        pushBranch: () => ok({ branch: taskBranch, headRevision }),
        readRemoteBranchHead: () => ok(headRevision),
      });
      const hub = scriptedGitHub({
        findPullRequests: () => {
          if (slowOperation === 'search') clock += 21_000;
          return ok([
            { number: 7, url: pullRequestUrl },
            { number: 8, url: pullRequestUrlOf(8) },
          ]);
        },
        readPullRequest: (_repository, number) => {
          if (slowOperation === 'search' || number === 8)
            return fault('A post-deadline read must not start.');
          clock += 21_000;
          return ok(pullRequestObservation(otherRevision));
        },
      });
      const deliver = deliverAction({
        selectionFile,
        git,
        github: hub.github,
        jira: scriptedJira({}).jira,
      });

      await expect(deliver()).resolves.toBe('failed');
      const reason = (events.at(-1)?.data as { reason: string }).reason;
      expect(reason).toContain(headRevision);
      if (slowOperation === 'observation') expect(reason).toContain(otherRevision);
      expect(reason).toContain('confirmation deadline of 20s expired');
      expect(hub.calls).toEqual([
        `find:${taskBranch}->main`,
        ...(slowOperation === 'search' ? [] : ['read:7']),
      ]);
      expect(waitCalls).toEqual([]);
      await expect(
        stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json')),
      ).rejects.toThrow(/ENOENT/);
    },
  );

  it('keeps a provider fault during confirmation as an execution error', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeVerifiedRound(workspaceRoot);
    let reads = 0;
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      pushBranch: () => ok({ branch: taskBranch, headRevision }),
      readRemoteBranchHead: () => ok(headRevision),
    });
    const { github } = scriptedGitHub({
      findPullRequests: () => ok([{ number: 7, url: pullRequestUrl }]),
      readPullRequest: () => {
        reads += 1;
        return reads === 1
          ? ok(pullRequestObservation(otherRevision))
          : fault('GitHub read failed.');
      },
    });
    const deliver = deliverAction({
      selectionFile,
      git,
      github,
      jira: scriptedJira({}).jira,
    });

    await expect(deliver()).rejects.toThrow('GitHub read failed.');
    // A provider fault is an execution error: no failed outcome and no delivery record.
    expect(events).toEqual([]);
    expect(waitCalls).toHaveLength(1);
    await expect(stat(path.join(workspaceRoot, 'artifacts', '1', 'delivery.json'))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('reports the completed repair turns and the profile escalation', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    await writeFile(
      path.join(workspaceRoot, 'state', 'current-round.json'),
      `${JSON.stringify({ number: 3, profile: 'dev-b', reason: 'Planned.' })}\n`,
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
    const deliver = deliverAction({ selectionFile, git, github, jira });

    await expect(deliver()).resolves.toBe('published');
    await expect(publishReport(selectionFile, jira)()).resolves.toBe('published');

    expect(commentText(comment ?? {})).toBe(
      'profile: dev-b\nImplemented the retry guard.\n' +
        'Repairs used: 2, escalated from "dev-a" to "dev-b".\n' +
        `Pull request: ${pullRequestUrl}`,
    );
  });
});
