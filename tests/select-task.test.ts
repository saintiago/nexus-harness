/**
 * Component tests: the real SelectTask runs over a controlled Jira adapter and real temporary
 * storage, establishing source ordering, eligibility, continuation, claiming order and the
 * records it retains. No live Jira access is involved.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  JiraComment,
  JiraIssue,
  JiraIssueIdentity,
  JiraTransition,
} from '../src/adapters/jira.js';
import { fault, ok } from '../src/result.js';
import type { Selection } from '../src/task-engine/actions/select-task/artifacts.js';
import { createSelectTask } from '../src/task-engine/actions/select-task/index.js';
import type { BoundAction, EngineEvent } from '../src/task-engine/index.js';
import { scriptedJira, type JiraOperations } from './support/jira.js';

const readyStatus = 'To Do';
const inProgressStatus = 'In Progress';
const reviewStatus = 'In Review';
const doneStatus = 'Done';
const workspacePointerField = 'customfield_10042';

const startTransition: JiraTransition = {
  id: '31',
  name: 'Start progress',
  to: { id: '2', name: inProgressStatus },
};

/** One issue with its default native fields, overridden where a test supplies other values. */
function issue(id: string, key: string, fields: Record<string, unknown> = {}): JiraIssue {
  return {
    id,
    key,
    fields: {
      summary: `Task ${key}`,
      description: { type: 'doc', content: [] },
      status: { id: '1', name: readyStatus },
      ...fields,
    },
  };
}

/** The identity the source search returns for one issue. */
function identityOf(source: JiraIssue): JiraIssueIdentity {
  return { id: source.id, key: source.key };
}

/** One provider comment. */
function comment(id: string, body: unknown): JiraComment {
  return { id, body };
}

let root = '';
let events: EngineEvent[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-select-task-'));
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The selection-file path Application binds beside the workflow-state file. */
function selectionFile(): string {
  return path.join(root, 'executions', 'selection.json');
}

/** The stable workspace path under the configured root. */
function stableWorkspace(taskKey: string): string {
  return path.join(root, 'workspaces', 'NEX', taskKey);
}

/** SelectTask over a controlled adapter, with the Jira calls it made. */
function selectTask(operations: JiraOperations): {
  readonly select: BoundAction;
  readonly calls: string[];
} {
  const { jira, calls } = scriptedJira(operations);
  const select = createSelectTask({
    selectionFile: selectionFile(),
    workspaceRoot: path.join(root, 'workspaces'),
    project: 'NEX',
    selection: { query: 'project = NEX AND status = "To Do"', orderBy: 'Rank ASC' },
    statuses: {
      ready: readyStatus,
      inProgress: inProgressStatus,
      review: reviewStatus,
      done: doneStatus,
    },
    workspacePointerField,
    jira,
    publish: (event) => events.push(event),
  });
  return { select, calls };
}

/** Read the saved selection document. */
async function readSelection(): Promise<Selection> {
  return JSON.parse(await readFile(selectionFile(), 'utf8')) as Selection;
}

/** Write one retained selection, as an earlier SelectTask invocation saved it. */
async function writeSelection(selection: Selection): Promise<void> {
  await mkdir(path.dirname(selectionFile()), { recursive: true });
  await writeFile(selectionFile(), `${JSON.stringify(selection, null, 2)}\n`, 'utf8');
}

/** A retained selection for one task, pointing at that task's stable workspace. */
function retained(taskKey: string, issueId = taskKey): Selection {
  return {
    taskKey,
    source: { kind: 'jira', issueId },
    task: { id: issueId, key: taskKey, fields: {} },
    conversation: [],
    workspace: { root: stableWorkspace(taskKey) },
  };
}

describe('SelectTask', () => {
  it('selects the first eligible task in configured source order and claims it', async () => {
    const taken = issue('1', 'NEX-1', { status: { id: '2', name: inProgressStatus } });
    const eligible = issue('2', 'NEX-2');
    const current = issue('2', 'NEX-2', { summary: 'Refreshed title' });
    let reads = 0;
    const { select, calls } = selectTask({
      searchIssues: () => ok([identityOf(taken), identityOf(eligible)]),
      readIssue: (issueId) => {
        if (issueId === '1') {
          return ok(taken);
        }
        reads += 1;
        return ok(reads === 1 ? eligible : current);
      },
      readComments: () => ok([comment('c1', { type: 'doc' })]),
      readTransitions: () => ok([startTransition]),
      updateFields: () => ok(undefined),
      transitionIssue: () => ok(undefined),
    });

    await expect(select()).resolves.toBe('selected');

    expect(await readSelection()).toEqual({
      taskKey: 'NEX-2',
      source: { kind: 'jira', issueId: '2' },
      task: current,
      conversation: [comment('c1', { type: 'doc' })],
      workspace: { root: stableWorkspace('NEX-2') },
    });
    expect(calls).toEqual([
      'search:project = NEX AND status = "To Do" order by Rank ASC',
      'read:1',
      'read:2',
      'comments:2',
      'read:2',
      `update:2:${JSON.stringify({ workspacePointer: stableWorkspace('NEX-2') })}`,
      'transitions:2',
      'transition:2:31',
    ]);
    expect(events).toEqual([]);
  });

  it('holds an empty queue when no candidate is eligible', async () => {
    const untitled = issue('1', 'NEX-1', { summary: '' });
    const undocumented = issue('2', 'NEX-2', { description: null });
    const started = issue('3', 'NEX-3', { status: { id: '3', name: reviewStatus } });
    const claims: string[] = [];
    const { select, calls } = selectTask({
      searchIssues: () => ok([untitled, undocumented, started].map(identityOf)),
      readIssue: (issueId) =>
        ok([untitled, undocumented, started].find((entry) => entry.id === issueId)!),
      updateFields: () => {
        claims.push('update');
        return ok(undefined);
      },
      transitionIssue: () => {
        claims.push('transition');
        return ok(undefined);
      },
    });

    await expect(select()).resolves.toBe('empty');

    await expect(readFile(selectionFile(), 'utf8')).rejects.toThrow(/ENOENT/);
    expect(calls).toEqual([
      'search:project = NEX AND status = "To Do" order by Rank ASC',
      'read:1',
      'read:2',
      'read:3',
    ]);
    expect(claims).toEqual([]);
  });

  it('reuses a retained workspace that still exists without updating its pointer', async () => {
    const retainedRoot = path.join(root, 'retained', 'NEX-1');
    await mkdir(retainedRoot, { recursive: true });
    const eligible = issue('1', 'NEX-1', { [workspacePointerField]: retainedRoot });
    const { select } = selectTask({
      searchIssues: () => ok([identityOf(eligible)]),
      readIssue: () => ok(eligible),
      readComments: () => ok([]),
      readTransitions: () => ok([startTransition]),
      transitionIssue: () => ok(undefined),
    });

    await expect(select()).resolves.toBe('selected');

    expect((await readSelection()).workspace).toEqual({ root: retainedRoot });
  });

  it('uses the stable project/task path when the recorded workspace is gone', async () => {
    const gone = path.join(root, 'deleted', 'NEX-1');
    const eligible = issue('1', 'NEX-1', { [workspacePointerField]: gone });
    const updates: unknown[] = [];
    const { select } = selectTask({
      searchIssues: () => ok([identityOf(eligible)]),
      readIssue: () => ok(eligible),
      readComments: () => ok([]),
      readTransitions: () => ok([startTransition]),
      updateFields: (_issueId, fields) => {
        updates.push(fields);
        return ok(undefined);
      },
      transitionIssue: () => ok(undefined),
    });

    await expect(select()).resolves.toBe('selected');

    expect((await readSelection()).workspace).toEqual({ root: stableWorkspace('NEX-1') });
    expect(updates).toEqual([{ workspacePointer: stableWorkspace('NEX-1') }]);
  });

  it('saves the selection before claiming the task', async () => {
    const eligible = issue('1', 'NEX-1');
    const { select } = selectTask({
      searchIssues: () => ok([identityOf(eligible)]),
      readIssue: () => ok(eligible),
      readComments: () => ok([comment('c1', { type: 'doc' })]),
      readTransitions: () => ok([startTransition]),
      updateFields: async () => {
        const saved = await readSelection();
        expect(saved.taskKey).toBe('NEX-1');
        expect(saved.conversation).toHaveLength(1);
        return ok(undefined);
      },
      transitionIssue: () => ok(undefined),
    });

    await expect(select()).resolves.toBe('selected');
  });

  it('continues a retained unfinished task instead of selecting unrelated work', async () => {
    await writeSelection(retained('NEX-1'));
    const current = issue('NEX-1', 'NEX-1', {
      status: { id: '2', name: inProgressStatus },
      [workspacePointerField]: stableWorkspace('NEX-1'),
    });
    const { select } = selectTask({ readIssue: () => ok(current) });

    await expect(select()).resolves.toBe('selected');

    expect(await readSelection()).toEqual(retained('NEX-1'));
  });

  it('finishes an incomplete claim before selecting', async () => {
    await writeSelection(retained('NEX-1'));
    const current = issue('NEX-1', 'NEX-1');
    const updates: unknown[] = [];
    const { select } = selectTask({
      readIssue: () => ok(current),
      readTransitions: () => ok([startTransition]),
      updateFields: (_issueId, fields) => {
        updates.push(fields);
        return ok(undefined);
      },
      transitionIssue: () => ok(undefined),
    });

    await expect(select()).resolves.toBe('selected');

    expect(updates).toEqual([{ workspacePointer: stableWorkspace('NEX-1') }]);
  });

  it('starts fresh selection after the retained task completed', async () => {
    await writeSelection(retained('NEX-1'));
    const completed = issue('NEX-1', 'NEX-1', { status: { id: '4', name: doneStatus } });
    const next = issue('7', 'NEX-7');
    const { select } = selectTask({
      readIssue: (issueId) => ok(issueId === 'NEX-1' ? completed : next),
      searchIssues: () => ok([identityOf(next)]),
      readComments: () => ok([]),
      readTransitions: () => ok([startTransition]),
      updateFields: () => ok(undefined),
      transitionIssue: () => ok(undefined),
    });

    await expect(select()).resolves.toBe('selected');

    expect((await readSelection()).taskKey).toBe('NEX-7');
  });

  it('reports an unexpected retained status instead of overwriting it', async () => {
    await writeSelection(retained('NEX-1'));
    const blocked = issue('NEX-1', 'NEX-1', { status: { id: '5', name: 'Blocked' } });
    const { select } = selectTask({ readIssue: () => ok(blocked) });

    await expect(select()).resolves.toBe('failed');

    expect(events).toEqual([
      {
        source: 'select-task',
        type: 'failed',
        data: { reason: expect.stringContaining('"Blocked"') },
      },
    ]);
    expect(await readSelection()).toEqual(retained('NEX-1'));
  });

  it('reports an unexpected recorded workspace pointer instead of overwriting it', async () => {
    const odd = issue('1', 'NEX-1', { [workspacePointerField]: { path: '/somewhere' } });
    const { select } = selectTask({
      searchIssues: () => ok([identityOf(odd)]),
      readIssue: () => ok(odd),
      readComments: () => ok([]),
    });

    await expect(select()).resolves.toBe('failed');

    expect(events).toEqual([
      {
        source: 'select-task',
        type: 'failed',
        data: { reason: expect.stringContaining(workspacePointerField) },
      },
    ]);
    await expect(readFile(selectionFile(), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('reports a task that has no permitted transition to the in-progress status', async () => {
    const eligible = issue('1', 'NEX-1');
    const { select } = selectTask({
      searchIssues: () => ok([identityOf(eligible)]),
      readIssue: () => ok(eligible),
      readComments: () => ok([]),
      readTransitions: () => ok([]),
      updateFields: () => ok(undefined),
    });

    await expect(select()).resolves.toBe('failed');

    expect(events).toEqual([
      {
        source: 'select-task',
        type: 'failed',
        data: { reason: expect.stringContaining(inProgressStatus) },
      },
    ]);
    // The selection is saved before the claim, so the retained identity is not lost.
    expect((await readSelection()).taskKey).toBe('NEX-1');
  });

  it('preserves an intervening human change instead of claiming a moved task', async () => {
    const first = issue('1', 'NEX-1');
    const moved = issue('1', 'NEX-1', { status: { id: '2', name: inProgressStatus } });
    const second = issue('2', 'NEX-2');
    let reads = 0;
    const { select } = selectTask({
      searchIssues: () => ok([identityOf(first), identityOf(second)]),
      readIssue: (issueId) => {
        if (issueId === '1') {
          reads += 1;
          return ok(reads === 2 ? moved : first);
        }
        return ok(second);
      },
      readComments: () => ok([]),
      readTransitions: () => ok([startTransition]),
      updateFields: () => ok(undefined),
      transitionIssue: () => ok(undefined),
    });

    await expect(select()).resolves.toBe('selected');

    expect((await readSelection()).taskKey).toBe('NEX-2');
  });

  it('treats a source access failure as an execution error, not an empty queue', async () => {
    const { select } = selectTask({
      searchIssues: () => fault('Jira POST /rest/api/3/search/jql failed with status 503'),
    });

    await expect(select()).rejects.toThrow(/status 503/);
  });
});
