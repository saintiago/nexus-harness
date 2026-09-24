/**
 * Focused integration tests: SelectIdea over a controlled Jira source, a temporary workspace root
 * and a controlled Git adapter. They establish the single capture of an idea entering the
 * submitted status, the shared issue workspace pointer, the claim into the active status, the
 * prepared refinement worktree and retained-work continuation.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JiraIssue, JiraTransition } from '../src/adapters/jira.js';
import { fault, ok } from '../src/result.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import {
  ideaSelectionDeclaration,
  type IdeaSelection,
} from '../src/task-engine/actions/select-idea/artifacts.js';
import { createSelectIdea } from '../src/task-engine/actions/select-idea/index.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { decisionArtifact } from '../src/task-engine/actions/publish-decision/artifacts.js';
import { repositoryState, scriptedGit } from './support/git.js';
import { scriptedJira } from './support/jira.js';

const issueId = '10518';
const issueKey = 'NEX-1';
const source = '/origin/repository.git';
const workspacePointerField = 'customfield_10001';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-select-idea-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A controlled submitted idea whose status follows the transitions it is asked to apply. */
function controlledSource(options: { readonly pointerFailures?: number } = {}) {
  let status = 'Idea';
  let pointerFailures = options.pointerFailures ?? 0;
  const fields: Record<string, unknown> = {};
  const transitions: Readonly<Record<string, readonly JiraTransition[]>> = {
    Idea: [{ id: '11', name: 'Start refinement', to: { id: '2', name: 'Idea Refinement' } }],
    'Idea Refinement': [
      { id: '21', name: 'Approve', to: { id: '3', name: 'Draft' } },
      { id: '22', name: 'Request feedback', to: { id: '4', name: 'Waiting for Feedback' } },
    ],
  };
  const issue = (): JiraIssue => ({
    id: issueId,
    key: issueKey,
    fields: {
      ...fields,
      summary: 'Add a lint gate',
      description: { type: 'doc', version: 1, content: [] },
      status: { id: '1', name: status },
    },
  });
  const sourceCalls = scriptedJira({
    searchIssues: () => ok(status === 'Idea' ? [{ id: issueId, key: issueKey }] : []),
    readIssue: () => ok(issue()),
    readComments: () => ok([{ id: 'c1', body: { text: 'the author\u2019s idea' } }]),
    readTransitions: () => ok(transitions[status] ?? []),
    updateFields: (_id, updates) => {
      if (pointerFailures > 0) {
        pointerFailures -= 1;
        return fault('The workspace pointer could not be updated.');
      }
      if (updates.workspacePointer !== undefined) {
        fields[workspacePointerField] = updates.workspacePointer;
      }
      return ok(undefined);
    },
    transitionIssue: (_id, transitionId) => {
      const transition = (transitions[status] ?? []).find(
        (candidate) => candidate.id === transitionId,
      );
      if (transition === undefined) {
        throw new Error(`Transition "${transitionId}" is not permitted from "${status}".`);
      }
      status = transition.to.name;
      return ok(undefined);
    },
  });
  return {
    jira: sourceCalls.jira,
    calls: sourceCalls.calls,
    status: () => status,
    fields: () => fields,
    resubmit: () => {
      status = 'Idea';
    },
    setStatus: (value: string) => {
      status = value;
    },
  };
}

/** One SelectIdea invocation over the supplied controlled capabilities. */
async function harness(options?: {
  readonly clone?: boolean;
  readonly cloneRemote?: string;
  readonly observations?: readonly (ReturnType<typeof repositoryState> | Error)[];
  /** The number of initial clone attempts that fail before the clone succeeds. */
  readonly cloneFailures?: number;
  /** The number of initial workspace-pointer updates that fail. */
  readonly pointerFailures?: number;
}) {
  const root = await temporaryDirectory();
  const storage = path.join(root, 'storage');
  const selectionFile = path.join(root, 'execution', 'selection.json');
  const controlled = controlledSource({ pointerFailures: options?.pointerFailures });
  const clone = options?.clone ?? true;
  let cloneFailures = options?.cloneFailures ?? 0;
  const git = scriptedGit(options?.observations ?? [repositoryState({ branch: 'main' })], {
    cloneRepository: async (_source, destination) => {
      if (cloneFailures > 0) {
        cloneFailures -= 1;
        return fault('The repository could not be cloned.');
      }
      await mkdir(destination, { recursive: true });
      return ok({
        remoteUrl: options?.cloneRemote ?? source,
        branch: 'main',
        headRevision: 'a'.repeat(40),
      });
    },
    pullBranch: () => ok({ branch: 'main', headRevision: 'b'.repeat(40) }),
  });
  const events: EngineEvent[] = [];
  const action = createSelectIdea({
    selectionFile,
    workspaceRoot: storage,
    project: 'NEX',
    selection: { query: 'project = NEX AND status = Idea', orderBy: 'Rank ASC' },
    statuses: { submitted: 'Idea', active: 'Idea Refinement' },
    workspacePointerField,
    repository: { source, mainBranch: 'main' },
    jira: controlled.jira,
    git: git.git,
    publish: (event) => events.push(event),
  });
  const selection = async (): Promise<IdeaSelection | null> =>
    JSON.parse(await readFile(selectionFile, 'utf8').catch(() => 'null')) as IdeaSelection | null;
  return {
    root,
    storage,
    selectionFile,
    source: controlled,
    git,
    events,
    action,
    selection,
    issueWorkspace: path.join(storage, 'NEX', issueKey),
    refinement: path.join(storage, 'NEX', issueKey, 'refinement'),
    clone: () => clone,
    /** Make the next attempts fail before a repository clone is prepared. */
    failClones: (count: number) => {
      cloneFailures = count;
    },
  };
}

describe('SelectIdea', () => {
  it('captures one idea, retains the shared issue root, claims it and prepares the worktree', async () => {
    const harnessed = await harness();

    await expect(harnessed.action()).resolves.toBe('selected');

    expect(harnessed.source.status()).toBe('Idea Refinement');
    expect(harnessed.source.fields()[workspacePointerField]).toBe(harnessed.issueWorkspace);
    const selection = await harnessed.selection();
    expect(selection).toMatchObject({
      taskKey: issueKey,
      claimed: true,
      workspace: { root: harnessed.refinement },
      issueWorkspace: { root: harnessed.issueWorkspace },
    });
    expect(selection?.conversation).toHaveLength(1);
    expect(selection?.transitions.fromActive).toHaveLength(2);
    // The issue, its conversation and the transitions each read once; claiming reads them again
    // only after the move into the active status.
    expect(harnessed.source.calls).toEqual([
      'search:project = NEX AND status = Idea order by Rank ASC',
      `read:${issueId}`,
      `comments:${issueId}`,
      `transitions:${issueId}`,
      `update:${issueId}:{"workspacePointer":"${harnessed.issueWorkspace}"}`,
      'transition:10518:11',
      'transitions:10518',
    ]);
    expect(harnessed.git.calls).toEqual([
      `clone:${source}:${path.join(harnessed.refinement, 'worktree')}`,
    ]);
    expect(harnessed.events.at(-1)).toMatchObject({
      source: 'select-idea',
      type: 'outcome',
      data: { outcome: 'selected', artifact: { path: harnessed.selectionFile } },
    });
  });

  it('continues a retained unfinished selection without reading the issue again', async () => {
    const harnessed = await harness();
    await harnessed.action();
    const reads = harnessed.source.calls.length;

    await expect(harnessed.action()).resolves.toBe('selected');

    // The captured input stays authoritative and no source read is repeated.
    expect(harnessed.source.calls).toHaveLength(reads);
    // The retained worktree is refreshed on its clean main branch.
    expect(harnessed.git.calls.at(-1)).toContain('pull:');
  });

  it('finishes a claim the selection recorded but never applied', async () => {
    const harnessed = await harness();
    await mkdir(path.dirname(harnessed.selectionFile), { recursive: true });
    await writeFile(
      harnessed.selectionFile,
      JSON.stringify({
        taskKey: issueKey,
        source: { kind: 'jira', issueId },
        issue: { id: issueId, key: issueKey, fields: {} },
        conversation: [],
        transitions: {
          toActive: {
            id: '11',
            name: 'Start refinement',
            to: { id: '2', name: 'Idea Refinement' },
          },
          fromActive: [],
        },
        claimed: false,
        retainedSubmissions: 0,
        workspace: { root: harnessed.refinement },
        issueWorkspace: { root: harnessed.issueWorkspace },
      }),
    );

    await expect(harnessed.action()).resolves.toBe('selected');

    expect(harnessed.source.status()).toBe('Idea Refinement');
    expect((await harnessed.selection())?.claimed).toBe(true);
    expect(harnessed.source.fields()[workspacePointerField]).toBe(harnessed.issueWorkspace);
    // The actual status and pointer are read before completing the claim; no conversation reread.
    expect(harnessed.source.calls).toEqual([
      `read:${issueId}`,
      `update:${issueId}:{"workspacePointer":"${harnessed.issueWorkspace}"}`,
      `transition:${issueId}:11`,
      `transitions:${issueId}`,
    ]);
  });

  it('does not repeat a move an interrupted attempt already applied', async () => {
    const harnessed = await harness();
    await mkdir(path.dirname(harnessed.selectionFile), { recursive: true });
    await writeFile(
      harnessed.selectionFile,
      JSON.stringify({
        taskKey: issueKey,
        source: { kind: 'jira', issueId },
        issue: { id: issueId, key: issueKey, fields: {} },
        conversation: [],
        transitions: {
          toActive: {
            id: '11',
            name: 'Start refinement',
            to: { id: '2', name: 'Idea Refinement' },
          },
          fromActive: [],
        },
        claimed: false,
        retainedSubmissions: 0,
        workspace: { root: harnessed.refinement },
        issueWorkspace: { root: harnessed.issueWorkspace },
      }),
    );
    // The interrupted attempt moved the item before it recorded the claim.
    harnessed.source.setStatus('Idea Refinement');

    await expect(harnessed.action()).resolves.toBe('selected');

    expect(harnessed.source.calls.some((call) => call.startsWith('transition:'))).toBe(false);
    expect(harnessed.source.calls).toContain(`transitions:${issueId}`);
    expect((await harnessed.selection())?.claimed).toBe(true);
    // The unrecorded claim finishes its pointer update even though the move already happened.
    expect(harnessed.source.fields()[workspacePointerField]).toBe(harnessed.issueWorkspace);
  });

  it('selects again when the retained refinement already reached a decision', async () => {
    const harnessed = await harness();
    await harnessed.action();
    const submission = path.join(harnessed.refinement, 'artifacts/submissions/1');
    await mkdir(submission, { recursive: true });
    await writeFile(
      path.join(submission, decisionArtifact.pathFromArtifactsRoot),
      JSON.stringify({
        decision: 'returned-to-author',
        strongestVerdict: 'idea_not_working',
        brief: 'brief.json',
        revision: 1,
        feedback: [],
        comment: null,
        source: {
          transition: { id: '22', to: 'Waiting for Feedback' },
          status: 'Waiting for Feedback',
          commentId: null,
        },
      }),
    );
    harnessed.source.resubmit();
    harnessed.source.calls.length = 0;

    await expect(harnessed.action()).resolves.toBe('selected');

    expect(harnessed.source.calls).toContain(
      'search:project = NEX AND status = Idea order by Rank ASC',
    );
    expect(harnessed.source.calls.filter((call) => call.startsWith('read:'))).toHaveLength(1);
  });

  it('continues a claimed resubmission whose own submission has no decision yet', async () => {
    const harnessed = await harness();
    // The previous entry's submission already reached a decision and the author resubmitted.
    await harnessed.action();
    harnessed.source.resubmit();
    const previous = path.join(harnessed.refinement, 'artifacts/submissions/1');
    await mkdir(previous, { recursive: true });
    await writeFile(
      path.join(previous, decisionArtifact.pathFromArtifactsRoot),
      JSON.stringify({
        decision: 'returned-to-author',
        strongestVerdict: 'idea_not_working',
        brief: 'brief.json',
        revision: 1,
        feedback: [],
        comment: null,
        source: {
          transition: { id: '22', to: 'Waiting for Feedback' },
          status: 'Waiting for Feedback',
          commentId: null,
        },
      }),
    );

    // The fresh selection claims the item, then the interrupted worktree preparation fails (no
    // checkout was retained from the previous entry).
    await rm(path.join(harnessed.refinement, 'worktree'), { recursive: true, force: true });
    harnessed.failClones(1);
    await expect(harnessed.action()).resolves.toBe('failed');
    const captured = await harnessed.selection();
    expect(captured).toMatchObject({ claimed: true, retainedSubmissions: 1 });
    expect(harnessed.source.status()).toBe('Idea Refinement');

    // A retry continues this selection instead of treating the earlier decision as its own.
    await expect(harnessed.action()).resolves.toBe('selected');
    expect((await harnessed.selection())?.taskKey).toBe(issueKey);
    // The retried preparation cloned the worktree the interrupted attempt never produced.
    expect(harnessed.git.calls.filter((call) => call.startsWith('clone:'))).toHaveLength(3);
  });

  it('retries an interrupted workspace-pointer update before claiming the idea', async () => {
    const harnessed = await harness({ pointerFailures: 1 });

    // The pointer update fails after the selection record was saved, so no claim was attempted.
    await expect(harnessed.action()).rejects.toThrow('workspace pointer could not be updated');
    const captured = await harnessed.selection();
    expect(captured).toMatchObject({ claimed: false });
    expect(harnessed.source.status()).toBe('Idea');
    expect(harnessed.source.fields()[workspacePointerField]).toBeUndefined();

    await expect(harnessed.action()).resolves.toBe('selected');

    expect(harnessed.source.fields()[workspacePointerField]).toBe(harnessed.issueWorkspace);
    expect(harnessed.source.status()).toBe('Idea Refinement');
    expect(harnessed.source.calls.filter((call) => call.startsWith('update:'))).toHaveLength(2);
    expect((await harnessed.selection())?.claimed).toBe(true);
  });

  it('reuses a recorded shared issue workspace', async () => {
    const harnessed = await harness();
    const recorded = path.join(harnessed.root, 'recorded-issue-workspace');
    await mkdir(recorded, { recursive: true });
    harnessed.source.fields()[workspacePointerField] = recorded;

    await expect(harnessed.action()).resolves.toBe('selected');

    expect((await harnessed.selection())?.issueWorkspace.root).toBe(recorded);
    expect(harnessed.source.fields()[workspacePointerField]).toBe(recorded);
    expect(harnessed.source.calls.some((call) => call.startsWith('update:'))).toBe(false);
  });

  it('drains when no submitted idea is eligible', async () => {
    const harnessed = await harness();
    harnessed.source.status = () => 'Idea Refinement';
    // A source whose query returns nothing.
    const empty = scriptedJira({ searchIssues: () => ok([]) });
    const action = createSelectIdea({
      selectionFile: harnessed.selectionFile,
      workspaceRoot: harnessed.storage,
      project: 'NEX',
      selection: { query: 'project = NEX AND status = Idea', orderBy: 'Rank ASC' },
      statuses: { submitted: 'Idea', active: 'Idea Refinement' },
      workspacePointerField,
      repository: { source, mainBranch: 'main' },
      jira: empty.jira,
      git: harnessed.git.git,
      publish: (event) => harnessed.events.push(event),
    });

    await expect(action()).resolves.toBe('empty');
    await expect(harnessed.selection()).resolves.toBeNull();
  });

  it('reports a worktree from another repository as a failed selection', async () => {
    const harnessed = await harness({ cloneRemote: '/origin/other.git' });

    await expect(harnessed.action()).resolves.toBe('failed');

    expect(harnessed.events.at(-1)).toMatchObject({
      source: 'select-idea',
      type: 'failed',
      data: { reason: expect.stringContaining('/origin/other.git') },
    });
    // The source update is retained, so a retry continues the same claim.
    expect(harnessed.source.status()).toBe('Idea Refinement');
  });

  it('leaves a selection record that its declaration accepts', async () => {
    const harnessed = await harness();
    await harnessed.action();
    const document = JSON.parse(await readFile(harnessed.selectionFile, 'utf8')) as unknown;

    expect(ideaSelectionDeclaration.schema.safeParse(document).success).toBe(true);
    // The artifact helpers remain bound to finite delivery's layout; the idea area is separate.
    expect(typeof createArtifactHelpers({ root: harnessed.refinement })).toBe('object');
  });
});
