/**
 * Focused integration tests: the real SelectWork admission and routing over a controlled source.
 * Draft admits Requirements, a retained active idea continues Idea Refinement, an active delivery
 * status needs its retained attempt, the combined queue keeps one source rank order, and a
 * preparation stage never moves an active item backwards. No live Jira site is involved.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JiraIssue, JiraTransition } from '../src/adapters/jira.js';
import { ok } from '../src/result.js';
import {
  createSelectWork,
  type SelectWorkSettings,
} from '../src/task-engine/actions/select-work/index.js';
import type { BoundAction } from '../src/task-engine/index.js';
import { scriptedJira } from './support/jira.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const pointerField = 'customfield_10001';

/** One candidate issue with its current status. */
function issue(
  id: string,
  key: string,
  status: string,
  fields: Readonly<Record<string, unknown>> = {},
): JiraIssue {
  return {
    id,
    key,
    fields: {
      summary: `Work for ${key}`,
      description: { type: 'doc', version: 1, content: [] },
      status: { id: status, name: status },
      ...fields,
    },
  };
}

/** Run the real SelectWork over one controlled candidate list. */
async function select(options: {
  readonly issues: readonly JiraIssue[];
  readonly preparation?: boolean;
  readonly orderBy?: string;
}): Promise<{
  readonly result: string;
  readonly calls: readonly string[];
  readonly failures: readonly string[];
  readonly transitions: readonly string[];
  readonly selection: { readonly stage?: string; readonly taskKey?: string } | null;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-select-work-'));
  temporaryDirectories.push(directory);
  const selectionFile = path.join(directory, 'selection.json');
  const byId = new Map(options.issues.map((candidate) => [candidate.id, candidate]));
  const transitions: string[] = [];
  const failures: string[] = [];
  const available: JiraTransition[] = [
    { id: '11', name: 'Start work', to: { id: '2', name: 'In Progress' } },
    { id: '12', name: 'Refine', to: { id: '2', name: 'Idea Refinement' } },
  ];
  const { jira, calls } = scriptedJira({
    searchIssues: () => ok(options.issues.map(({ id, key }) => ({ id, key }))),
    readIssue: (issueId) => {
      const found = byId.get(issueId);
      return found === undefined
        ? { ok: false, fault: { message: `Unknown issue ${issueId}` } }
        : ok(found);
    },
    readComments: () => ok([]),
    readTransitions: () => ok(available),
    updateFields: () => ok(undefined),
    transitionIssue: (_issueId, transitionId) => {
      transitions.push(transitionId);
      return ok(undefined);
    },
  });
  const settings: SelectWorkSettings = {
    selectionFile,
    workspaceRoot: path.join(directory, 'workspaces'),
    project: 'NEX',
    selection: {
      query: 'project = NEX AND status = "To Do"',
      orderBy: options.orderBy ?? 'Rank ASC',
    },
    ideas: { query: 'project = NEX AND status = "Idea"', orderBy: 'Rank ASC' },
    statuses: {
      ready: 'To Do',
      inProgress: 'In Progress',
      review: 'In Review',
      done: 'Done',
    },
    preparation:
      options.preparation === true
        ? {
            statuses: {
              requirements: 'Requirements',
              uxProposal: 'UX Proposal',
              storybookRefinement: 'Storybook Refinement',
              architecture: 'Architecture',
            },
          }
        : undefined,
    ideaStatuses: {
      submitted: 'Idea',
      active: 'Idea Refinement',
      approved: 'Draft',
      waitingForFeedback: 'Waiting for Feedback',
    },
    workspacePointerField: pointerField,
    jira,
    publish: (event) => {
      const data = event.data as { readonly reason?: unknown };
      if (event.type === 'failed' && typeof data.reason === 'string') {
        failures.push(data.reason);
      }
    },
  };
  const action: BoundAction = createSelectWork(settings);
  const result = await action();
  let selection: { readonly stage?: string; readonly taskKey?: string } | null = null;
  try {
    selection = JSON.parse(await readFile(selectionFile, 'utf8')) as typeof selection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return { result, calls, failures, transitions, selection };
}

describe('SelectWork admission and routing', () => {
  it('admits the distinct Draft status to Requirements', async () => {
    const selected = await select({
      preparation: true,
      issues: [issue('1', 'NEX-1', 'Draft')],
    });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ taskKey: 'NEX-1', stage: 'requirements' });
    // Preparation work runs in its own mapped status; the admission writes no transition.
    expect(selected.transitions).toEqual([]);
  });

  it('routes the mapped Requirements status to Requirements as well', async () => {
    const selected = await select({
      preparation: true,
      issues: [issue('1', 'NEX-1', 'Requirements')],
    });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ stage: 'requirements' });
  });

  it('continues a retained Idea Refinement item', async () => {
    const selected = await select({ issues: [issue('1', 'NEX-1', 'Idea Refinement')] });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ stage: 'idea' });
    expect(selected.transitions).toEqual([]);
  });

  it('refuses an active delivery status without retained work', async () => {
    const selected = await select({ issues: [issue('1', 'NEX-1', 'In Review')] });

    expect(selected.result).toBe('failed');
    expect(selected.failures[0]).toContain('retained workspace');
    expect(selected.selection).toBeNull();
    expect(selected.transitions).toEqual([]);
  });

  it('continues a retained In Review delivery without moving it backwards', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-select-work-retained-'));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, 'NEX-1');
    await mkdir(path.join(workspace, 'state'), { recursive: true });
    await writeFile(
      path.join(workspace, 'state', 'attempt.json'),
      JSON.stringify({ attemptId: 'attempt-1' }),
    );
    const selected = await select({
      issues: [issue('1', 'NEX-1', 'In Review', { [pointerField]: workspace })],
    });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ stage: 'delivery' });
    expect(selected.transitions).toEqual([]);
  });

  it('claims a ready delivery item into its active status', async () => {
    const selected = await select({ issues: [issue('1', 'NEX-1', 'To Do')] });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ stage: 'delivery' });
    expect(selected.transitions).toEqual(['11']);
  });

  it('selects from one combined source-ranked queue', async () => {
    const selected = await select({
      preparation: true,
      issues: [issue('1', 'NEX-1', 'To Do'), issue('2', 'NEX-2', 'Idea')],
    });

    // One query carries both configured eligibility sets in the source's own order.
    expect(selected.calls.filter((call) => call.startsWith('search:'))).toEqual([
      'search:(project = NEX AND status = "To Do") OR (project = NEX AND status = "Idea") ' +
        'order by Rank ASC',
    ]);
    expect(selected.selection).toMatchObject({ taskKey: 'NEX-1', stage: 'delivery' });
  });

  it('reports a configuration whose queues cannot share one order', async () => {
    await expect(select({ issues: [], orderBy: 'Rank DESC' })).rejects.toThrow(
      /must share one source order/,
    );
  });
});
