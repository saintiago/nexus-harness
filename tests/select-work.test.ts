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
import { createTaskEngine } from '../src/task-engine/index.js';
import { preparation } from '../workflows/preparation.js';
import { createStartStageRound } from '../src/task-engine/actions/preparation/start-stage-round/index.js';
import {
  authoredIdentity,
  sourceInputIdentity,
} from '../src/task-engine/actions/preparation/evaluation-content.js';
import { stageAuthorArtifact } from '../src/task-engine/actions/preparation/artifacts.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import { createPublishPreparation } from '../src/task-engine/actions/project/publish-preparation/index.js';
import { scriptedGit, repositoryState } from './support/git.js';
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
  readonly selectionFile?: string;
  readonly replays?: number;
  readonly retained?: { readonly task: JiraIssue; readonly workspace: string };
}): Promise<{
  readonly result: string;
  readonly selectionFile: string;
  readonly workspaceRoot: string;
  readonly jira: SelectWorkSettings['jira'];
  readonly calls: readonly string[];
  readonly failures: readonly string[];
  readonly transitions: readonly string[];
  readonly selection: { readonly stage?: string; readonly taskKey?: string } | null;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-select-work-'));
  temporaryDirectories.push(directory);
  const selectionFile = options.selectionFile ?? path.join(directory, 'selection.json');
  if (options.retained) {
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: options.retained.task.key,
        source: { kind: 'jira', issueId: options.retained.task.id },
        task: options.retained.task,
        conversation: [],
        workspace: { root: options.retained.workspace },
        stage: 'delivery',
      }),
    );
  }
  const byId = new Map(options.issues.map((candidate) => [candidate.id, candidate]));
  const transitions: string[] = [];
  const failures: string[] = [];
  const available: JiraTransition[] = [
    { id: '11', name: 'Start work', to: { id: '2', name: 'In Progress' } },
    { id: '12', name: 'Refine', to: { id: '2', name: 'Idea Refinement' } },
    { id: '13', name: 'Analyze', to: { id: '3', name: 'Requirements' } },
    { id: '14', name: 'Propose UX', to: { id: '4', name: 'UX Proposal' } },
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
    addComment: (_issueId, body) => ok({ id: 'comment-1', body }),
    updateFields: () => ok(undefined),
    transitionIssue: (issueId, transitionId) => {
      const current = byId.get(issueId);
      const transition = available.find((candidate) => candidate.id === transitionId);
      if (current && transition)
        byId.set(issueId, { ...current, fields: { ...current.fields, status: transition.to } });
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
  let result = await action();
  for (let replay = 0; replay < (options.replays ?? 0); replay += 1) {
    expect(result).toBe('selected');
    result = await action();
  }
  let selection: { readonly stage?: string; readonly taskKey?: string } | null = null;
  try {
    selection = JSON.parse(await readFile(selectionFile, 'utf8')) as typeof selection;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return {
    result,
    calls,
    failures,
    transitions,
    selection,
    selectionFile,
    workspaceRoot: path.join(settings.workspaceRoot, 'NEX', 'NEX-1'),
    jira,
  };
}

describe('SelectWork admission and routing', () => {
  it('admits the distinct Draft status to Requirements', async () => {
    const selected = await select({
      preparation: true,
      issues: [issue('1', 'NEX-1', 'Draft')],
    });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ taskKey: 'NEX-1', stage: 'requirements' });
    expect(selected.transitions).toEqual(['13']);
  });

  it('admits Draft through real child completion and publication using distinct configured statuses', async () => {
    const selected = await select({ preparation: true, issues: [issue('1', 'NEX-1', 'Draft')] });
    const { selectionFile, workspaceRoot: root, jira } = selected;
    const artifacts = path.join(root, 'requirements/artifacts/1');
    const engine = createTaskEngine({
      workflow: preparation,
      input: { stage: 'requirements' },
      stateFile: path.join(root, 'child.json'),
      bindActions: () => ({
        PrepareStage: async () => 'prepared',
        RecordStageReturn: async () => 'return',
        ReviewPreparationPublication: async () => 'approved',
        StartStageRound: createStartStageRound({
          selectionFile,
          stage: 'requirements',
          profiles: { authors: ['a'], evaluator: 'e' },
          maxRounds: 1,
          publish: () => undefined,
        }),
        StageAuthor: async () => {
          await writeFile(
            path.join(artifacts, 'author.json'),
            JSON.stringify({
              stage: 'requirements',
              revision: 1,
              outcome: 'skip-proposed',
              summary: 'Existing requirements suffice.',
              documents: [],
              sourcePaths: [],
              plan: [],
              skip: {
                reason: 'Existing requirements suffice.',
                references: ['source requirements'],
              },
              question: null,
              upstream: null,
              findingResponses: [],
            }),
          );
          return 'skip-proposed';
        },
        StageEvaluator: async () => {
          const authorFile = path.join(artifacts, 'author.json');
          const author = stageAuthorArtifact.schema.parse(
            JSON.parse(await readFile(authorFile, 'utf8')),
          );
          await writeFile(
            path.join(artifacts, 'evaluation.json'),
            JSON.stringify({
              basis: {
                author: { path: authorFile },
                authorIdentity: authoredIdentity(author),
                sourceIdentity: sourceInputIdentity(selected.selection as never),
                upstream: [],
                content: [],
              },
              assessedRevision: 1,
              verdict: 'accepted-skip',
              reason: 'Examples are covered.',
              findings: [],
              priorFindings: [],
              upstream: null,
            }),
          );
          return 'accepted-skip';
        },
        StageResult: createStageResult({
          selectionFile,
          stage: 'requirements',
          git: scriptedGit([repositoryState()]).git,
          publish: () => undefined,
        }),
      }),
    });
    expect(await engine.run()).toEqual({ ok: true, value: 'skipped' });
    const publication = createPublishPreparation({
      selectionFile,
      statuses: {
        requirements: 'Requirements',
        uxProposal: 'UX Proposal',
        storybookRefinement: 'Storybook Refinement',
        architecture: 'Architecture',
      },
      waitingForFeedback: 'Waiting for Feedback',
      ideaActive: 'Idea Refinement',
      git: scriptedGit([repositoryState()]).git,
      jira,
      publish: () => undefined,
    });
    await expect(publication({ stage: 'requirements' })).resolves.toBe('advanced');
    expect(selected.transitions).toEqual(['13', '14']);
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
    await writeFile(
      path.join(workspace, 'state/prepared-workspace.json'),
      JSON.stringify({
        taskKey: 'NEX-1',
        repository: '/repo',
        branch: 'task/NEX-1',
        baseRevision: 'base',
      }),
    );
    await writeFile(
      path.join(workspace, 'state/current-round.json'),
      JSON.stringify({ number: 1, profile: 'nexus-sol', reason: 'initial' }),
    );
    await mkdir(path.join(workspace, 'artifacts/1'), { recursive: true });
    await writeFile(
      path.join(workspace, 'artifacts/1/delivery.json'),
      JSON.stringify({
        repository: 'owner/repo',
        pullRequestNumber: 1,
        pullRequestUrl: 'https://example.com/pr/1',
        headRevision: 'head',
      }),
    );
    await writeFile(
      path.join(workspace, 'artifacts/1/development.json'),
      JSON.stringify({
        taskKey: 'NEX-1',
        profile: 'nexus-sol',
        status: 'completed',
        baseRevision: 'base',
        headRevision: 'head',
        summary: 'Complete.',
        findingResponses: [],
      }),
    );
    await writeFile(
      path.join(workspace, 'artifacts/1/verification.json'),
      JSON.stringify({ headRevision: 'head', status: 'passed', checks: [] }),
    );
    const selected = await select({
      issues: [issue('1', 'NEX-1', 'In Review', { [pointerField]: workspace })],
    });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ stage: 'delivery' });
    expect(selected.transitions).toEqual([]);
  });

  it.each([
    { retained: false, prepared: false },
    { retained: true, prepared: false },
    { retained: false, prepared: true },
    { retained: true, prepared: true },
  ])(
    'refuses incomplete In Review evidence (retained=$retained, prepared=$prepared)',
    async ({ retained, prepared }) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'nexus-review-evidence-'));
      temporaryDirectories.push(workspace);
      await mkdir(path.join(workspace, 'state'), { recursive: true });
      await writeFile(
        path.join(workspace, 'state/attempt.json'),
        JSON.stringify({ attemptId: 'initial-claim' }),
      );
      if (prepared)
        await writeFile(
          path.join(workspace, 'state/prepared-workspace.json'),
          JSON.stringify({
            taskKey: 'NEX-1',
            repository: '/repo',
            branch: 'task/NEX-1',
            baseRevision: 'base',
          }),
        );
      const candidate = issue('1', 'NEX-1', 'In Review', { [pointerField]: workspace });
      const selected = await select({
        issues: [candidate],
        ...(retained ? { retained: { task: candidate, workspace } } : {}),
      });
      expect(selected.result).toBe('failed');
      expect(selected.failures[0]).toMatch(/prepared finite-delivery|verification evidence/);
      expect(selected.transitions).toEqual([]);
    },
  );

  it('allows an interrupted initial claim only from its retained ready selection', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'nexus-initial-claim-'));
    temporaryDirectories.push(workspace);
    const candidate = issue('1', 'NEX-1', 'In Progress', { [pointerField]: workspace });
    const selected = await select({
      issues: [candidate],
      retained: { task: issue('1', 'NEX-1', 'To Do'), workspace },
      replays: 3,
    });
    expect(selected.result).toBe('selected');
    expect(selected.transitions).toEqual([]);
    expect(JSON.parse(await readFile(selected.selectionFile, 'utf8')).initialClaim).toBe(true);
    await mkdir(path.join(workspace, 'state'), { recursive: true });
    const preparedFile = path.join(workspace, 'state/prepared-workspace.json');
    await writeFile(
      preparedFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        repository: '/repo.git',
        branch: 'task/NEX-1',
        baseRevision: '1'.repeat(40),
      }),
    );
    expect(
      (await select({ issues: [candidate], selectionFile: selected.selectionFile })).result,
    ).toBe('selected');
    expect(JSON.parse(await readFile(selected.selectionFile, 'utf8')).initialClaim).toBe(false);
    await rm(preparedFile);
    expect(
      (await select({ issues: [candidate], selectionFile: selected.selectionFile })).result,
    ).toBe('failed');
    const review = await select({
      issues: [issue('1', 'NEX-1', 'In Review', { [pointerField]: workspace })],
      selectionFile: selected.selectionFile,
    });
    expect(review.result).toBe('failed');
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
