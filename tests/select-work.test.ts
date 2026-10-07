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
import { developmentReportScope } from '../src/task-engine/actions/develop/artifacts.js';
import { readValidationErrorHistory } from '../src/task-engine/actions/report-feedback.js';
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
  readonly workspaceRoot?: string;
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
    searchIssues: (query) => {
      // The linked-implementation eligibility check resolves recorded prerequisite keys.
      if (query.query.includes('key in (')) {
        const keys = [...query.query.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
        return ok(
          options.issues
            .filter((candidate) => keys.includes(candidate.key))
            .map(({ id, key }) => ({
              id,
              key,
            })),
        );
      }
      return ok(options.issues.map(({ id, key }) => ({ id, key })));
    },
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
    workspaceRoot: options.workspaceRoot ?? path.join(directory, 'workspaces'),
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
                references: [selectionFile],
              },
              question: null,
              upstream: null,
              observation: null,
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
                repositoryRevision: repositoryState().headRevision,
                content: [],
              },
              assessedRevision: 1,
              verdict: 'accepted-skip',
              reason: 'Examples are covered.',
              observation: null,
              findings: [],
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

  it.each(['legacy', 'bound', 'missing Markdown', 'foreign task', 'schema'])(
    'validates retained In Review development evidence: %s',
    async (kind) => {
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
        }),
      );
      await writeFile(
        path.join(workspace, 'artifacts/1/verification.json'),
        JSON.stringify({ headRevision: 'head', status: 'passed', checks: [] }),
      );
      const file = path.join(workspace, 'artifacts/1/development.json');
      const reportFile = path.join(workspace, 'artifacts/1/developer.md');
      const markdown = 'Complete.';
      if (kind !== 'legacy') {
        const outcome: Record<string, unknown> = {
          taskKey: kind === 'foreign task' ? 'OTHER-1' : 'NEX-1',
          profile: 'nexus-sol',
          status: 'completed',
          baseRevision: 'base',
          headRevision: 'head',
          role: 'developer',
          invocationId: 'dev-1',
          report: { path: reportFile },
          readinessFailure: null,
        };
        if (kind === 'schema') delete outcome['invocationId'];
        await writeFile(file, JSON.stringify(outcome));
        if (kind !== 'missing Markdown') await writeFile(reportFile, markdown);
      }
      if (!['legacy', 'bound'].includes(kind)) {
        await expect(
          select({
            issues: [issue('1', 'NEX-1', 'In Review', { [pointerField]: workspace })],
          }),
        ).rejects.toThrow();
        const records = await readValidationErrorHistory(workspace);
        expect(records).toHaveLength(1);
        const rejection = records[0]!.record;
        expect(rejection).toMatchObject({
          kind: 'validation-error',
          scope: developmentReportScope(workspace, 'NEX-1'),
          output: await readFile(file, 'utf8'),
          assignedReport: { path: reportFile },
        });
        if (kind === 'missing Markdown') expect(rejection.report).toBeNull();
        else expect(await readFile(rejection.report!.path, 'utf8')).toBe(markdown);
        return;
      }
      const selected = await select({
        issues: [issue('1', 'NEX-1', 'In Review', { [pointerField]: workspace })],
      });

      expect(selected.result).toBe('selected');
      expect(selected.selection).toMatchObject({ stage: 'delivery' });
      expect(selected.transitions).toEqual([]);
    },
  );

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

  /** Write one implementation ticket's workspace and its recorded implementation input. */
  async function linkedImplementation(
    workspaces: string,
    ticketKey: string,
    prerequisite: string,
    prerequisiteRoot = path.join(workspaces, 'NEX', prerequisite),
  ): Promise<string> {
    const root = path.join(workspaces, 'NEX', ticketKey);
    await mkdir(path.join(root, 'parent'), { recursive: true });
    await writeFile(
      path.join(root, 'parent/implementation-input.json'),
      JSON.stringify({
        sourceKey: 'NEX-1',
        sourceWorkspace: { root: path.join(workspaces, 'NEX', 'NEX-1') },
        architectureResult: { path: 'architecture/artifacts/1/result.json' },
        planIdentity: 'plan-identity',
        plannedTask: 1,
        prerequisites: [{ key: prerequisite, workspace: { root: prerequisiteRoot } }],
        continuation: null,
      }),
    );
    return root;
  }

  /** Retain one prerequisite's confirmed completion evidence in its own workspace. */
  async function retainCompletion(
    workspaces: string,
    ticketKey: string,
    mergeRevision: string,
    root = path.join(workspaces, 'NEX', ticketKey),
  ): Promise<void> {
    await mkdir(path.join(root, 'state'), { recursive: true });
    await mkdir(path.join(root, 'artifacts', '1'), { recursive: true });
    await writeFile(
      path.join(root, 'state/current-round.json'),
      JSON.stringify({ number: 1, profile: 'nexus-flash', reason: 'The initial implementation.' }),
    );
    await writeFile(
      path.join(root, 'artifacts/1/completion.json'),
      JSON.stringify({
        taskKey: ticketKey,
        pullRequestUrl: `https://github.com/owner/repository/pull/1`,
        reviewedHead: mergeRevision,
        mergeRevision,
        checks: [],
      }),
    );
  }

  it('defers a dependent implementation while its prerequisite lacks completion evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-defer-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    const linked = await linkedImplementation(workspaces, 'NEX-2', 'NEX-1');
    // The prerequisite is Done in the source but retains no merge/check completion evidence.
    const deferred = await select({
      issues: [
        issue('2', 'NEX-2', 'To Do', { [pointerField]: linked }),
        issue('1', 'NEX-1', 'Done'),
        issue('3', 'NEX-3', 'To Do'),
      ],
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
    });
    // Source Done alone is insufficient: the dependent is deferred and the next eligible item is
    // selected from the ranked queue.
    expect(deferred.result).toBe('selected');
    expect(deferred.selection).toMatchObject({ taskKey: 'NEX-3' });
  });

  it('selects available implementation ahead of preparation in the ranked queue', async () => {
    const selected = await select({
      preparation: true,
      issues: [issue('1', 'NEX-1', 'To Do'), issue('2', 'NEX-2', 'Requirements')],
    });

    // The handoff's completed ranking places implementation first; selection claims it before
    // the preparation ticket that follows.
    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ taskKey: 'NEX-1', stage: 'delivery' });
  });

  it('lets eligible preparation proceed while prerequisite completion defers implementation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-defer-preparation-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    const linked = await linkedImplementation(workspaces, 'NEX-2', 'NEX-1');
    const selected = await select({
      preparation: true,
      issues: [
        issue('2', 'NEX-2', 'To Do', { [pointerField]: linked }),
        issue('1', 'NEX-1', 'Done'),
        issue('3', 'NEX-3', 'Requirements'),
      ],
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
    });

    // The unavailable implementation ticket is deferred, not completed, and the ranked queue
    // proceeds to the eligible preparation ticket.
    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ taskKey: 'NEX-3', stage: 'requirements' });
  });

  it('skips a waiting ticket and selects the eligible preparation that follows it', async () => {
    const selected = await select({
      preparation: true,
      issues: [issue('1', 'NEX-1', 'Waiting for Feedback'), issue('2', 'NEX-2', 'Requirements')],
    });

    // A waiting item is not selectable and does not block the eligible preparation behind it.
    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ taskKey: 'NEX-2', stage: 'requirements' });
  });

  it('admits a dependent implementation once its prerequisite holds completion evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-admit-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    const linked = await linkedImplementation(workspaces, 'NEX-2', 'NEX-1');
    await retainCompletion(workspaces, 'NEX-1', 'f'.repeat(40));
    const selected = await select({
      issues: [
        issue('2', 'NEX-2', 'To Do', { [pointerField]: linked }),
        issue('1', 'NEX-1', 'Done'),
      ],
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
    });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ taskKey: 'NEX-2', stage: 'delivery' });
  });

  it('requests attention for an unreadable implementation input instead of treating it as empty', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-bad-input-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    const root = path.join(workspaces, 'NEX', 'NEX-2');
    await mkdir(path.join(root, 'parent'), { recursive: true });
    await writeFile(path.join(root, 'parent/implementation-input.json'), '{ not json');
    const selected = await select({
      issues: [issue('2', 'NEX-2', 'To Do', { [pointerField]: root })],
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
    });

    expect(selected.result).toBe('failed');
    expect(selected.failures.at(-1)).toContain('unreadable implementation input');
  });

  /** Write one source handoff record's retained implementation ticket. */
  async function writeSourceHandoff(
    workspaces: string,
    sourceKey: string,
    ticket: Record<string, unknown>,
    basis: Record<string, unknown> | null = null,
  ): Promise<string> {
    const parent = path.join(workspaces, 'NEX', sourceKey, 'parent');
    await mkdir(parent, { recursive: true });
    const file = path.join(parent, 'handoff.json');
    await writeFile(
      file,
      JSON.stringify({
        stage: 'architecture',
        upstreamReturns: 0,
        feedback: null,
        return: null,
        awaitingStages: [],
        tickets: [ticket],
        basis,
        publications: [],
      }),
    );
    return file;
  }

  it('defers a handoff ticket whose source handoff has not retained its input yet', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-partial-handoff-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    // The ticket was created straight into the ready status, but the handoff has not yet written
    // its input or recorded its link. It never competes as ordinary delivery work.
    await writeSourceHandoff(workspaces, 'NEX-1', {
      key: 'NEX-2',
      issueId: '2',
      plannedTask: 1,
      summary: 'Work for NEX-2',
      linked: false,
      ranked: false,
      admission: { initialStatus: 'To Do', completed: false },
    });
    const selected = await select({
      issues: [
        issue('1', 'NEX-1', 'Done'),
        issue('2', 'NEX-2', 'To Do', {
          labels: ['implementation', 'nexus-source-NEX-1-1'],
        }),
        issue('3', 'NEX-3', 'To Do'),
      ],
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
    });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ taskKey: 'NEX-3' });
    expect(selected.transitions).toEqual(['11']);
    expect(selected.calls.filter((call) => call.startsWith('transition:2:'))).toEqual([]);
  });

  it('requests attention when no source handoff record names the labelled ticket', async () => {
    const selected = await select({
      issues: [
        issue('1', 'NEX-1', 'Done'),
        issue('2', 'NEX-2', 'To Do', {
          labels: ['implementation', 'nexus-source-NEX-1-1'],
        }),
      ],
    });

    expect(selected.result).toBe('failed');
    expect(selected.failures.at(-1)).toContain("implementation handoff's source identity");
    expect(selected.failures.at(-1)).toContain('does not name issue NEX-2');
  });

  it('selects an earlier-contract handoff ticket that never carried an input', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-legacy-handoff-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    // The earlier handoff contract created tickets without implementation inputs; a source record
    // that already finished the ticket's link and admission keeps its ordinary delivery path.
    await writeSourceHandoff(workspaces, 'NEX-1', {
      key: 'NEX-2',
      issueId: '2',
      plannedTask: 1,
      summary: 'Work for NEX-2',
      linked: true,
      ranked: true,
      admission: { initialStatus: 'To Do', completed: true },
    });
    const selected = await select({
      issues: [
        issue('1', 'NEX-1', 'Done'),
        issue('2', 'NEX-2', 'To Do', {
          labels: ['implementation', 'nexus-source-NEX-1-1'],
        }),
      ],
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
    });

    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({ taskKey: 'NEX-2', stage: 'delivery' });
    expect(selected.transitions).toEqual(['11']);
  });

  it('requests reconciliation for a current-contract handoff with missing input despite finished effects', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-current-handoff-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    await writeSourceHandoff(
      workspaces,
      'NEX-1',
      {
        key: 'NEX-2',
        issueId: '2',
        plannedTask: 1,
        summary: 'Work for NEX-2',
        linked: true,
        ranked: true,
        admission: { initialStatus: 'To Do', completed: true },
      },
      { planIdentity: 'current-plan', taskCount: 1, continuationHead: 'f'.repeat(40) },
    );
    const selected = await select({
      issues: [
        issue('1', 'NEX-1', 'Done'),
        issue('2', 'NEX-2', 'To Do', {
          labels: ['nexus-source-NEX-1-1'],
        }),
      ],
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
    });
    expect(selected.result).toBe('failed');
    expect(selected.failures.at(-1)).toContain('current-contract handoff');
    expect(selected.transitions).toEqual([]);
  });

  it.each([null, '', 'matching'])(
    'uses carried prerequisite evidence with source pointer %s',
    async (pointer) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-carried-prerequisite-'));
      temporaryDirectories.push(directory);
      const workspaces = path.join(directory, 'workspaces');
      const recorded = path.join(directory, 'recorded-prerequisite');
      const linked = await linkedImplementation(workspaces, 'NEX-2', 'NEX-1', recorded);
      await retainCompletion(workspaces, 'NEX-1', 'f'.repeat(40), recorded);
      const selected = await select({
        issues: [
          issue('2', 'NEX-2', 'To Do', { [pointerField]: linked }),
          issue('1', 'NEX-1', 'Done', {
            [pointerField]: pointer === 'matching' ? recorded : pointer,
          }),
        ],
        selectionFile: path.join(directory, 'selection.json'),
        workspaceRoot: workspaces,
      });
      expect(selected.result).toBe('selected');
      expect(selected.selection).toMatchObject({ taskKey: 'NEX-2' });
    },
  );

  it('requires reconciliation when the prerequisite pointer conflicts with the carried workspace', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-pointer-conflict-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    const recorded = path.join(directory, 'recorded-prerequisite');
    const linked = await linkedImplementation(workspaces, 'NEX-2', 'NEX-1', recorded);
    await retainCompletion(workspaces, 'NEX-1', 'f'.repeat(40), recorded);
    const selected = await select({
      issues: [
        issue('2', 'NEX-2', 'To Do', { [pointerField]: linked }),
        issue('1', 'NEX-1', 'Done', { [pointerField]: path.join(directory, 'another-workspace') }),
      ],
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
    });
    expect(selected.result).toBe('failed');
    expect(selected.failures.at(-1)).toContain('conflicting');
    expect(selected.transitions).toEqual([]);
  });

  it('retains an alternate source handoff workspace for the input-less ticket', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-alternate-source-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    const ticketRoot = path.join(workspaces, 'NEX', 'NEX-2');
    await mkdir(ticketRoot, { recursive: true });
    const sourceRoot = path.join(directory, 'alternate', 'NEX', 'NEX-1');
    await writeSourceHandoff(path.join(directory, 'alternate'), 'NEX-1', {
      key: 'NEX-2',
      issueId: '2',
      summary: 'Work for NEX-2',
      linked: true,
      admission: { initialStatus: 'To Do', completed: true },
    });
    const selected = await select({
      issues: [
        issue('2', 'NEX-2', 'To Do', {
          labels: ['nexus-source-NEX-1-1'],
          [pointerField]: ticketRoot,
        }),
        issue('1', 'NEX-1', 'Done', { [pointerField]: sourceRoot }),
      ],
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
      replays: 2,
    });
    expect(selected.result).toBe('selected');
    expect(selected.selection).toMatchObject({
      taskKey: 'NEX-2',
      handoffSourceWorkspace: { root: sourceRoot },
    });
    const resumed = await select({
      issues: [
        issue('2', 'NEX-2', 'In Progress', {
          labels: ['nexus-source-NEX-1-1'],
          [pointerField]: ticketRoot,
        }),
        issue('1', 'NEX-1', 'Done', { [pointerField]: null }),
      ],
      selectionFile: selected.selectionFile,
      workspaceRoot: workspaces,
    });
    expect(resumed.result).toBe('selected');
    expect(resumed.selection).toMatchObject({ handoffSourceWorkspace: { root: sourceRoot } });
    const conflicting = await select({
      issues: [
        issue('2', 'NEX-2', 'In Progress', {
          labels: ['nexus-source-NEX-1-1'],
          [pointerField]: ticketRoot,
        }),
        issue('1', 'NEX-1', 'Done', { [pointerField]: path.join(directory, 'other-source') }),
      ],
      selectionFile: selected.selectionFile,
      workspaceRoot: workspaces,
    });
    expect(conflicting.result).toBe('failed');
    expect(conflicting.failures.at(-1)).toContain('conflicting');
  });

  it('defers a handoff ticket whose recorded handoff effects are unfinished', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-partial-handoff-'));
    temporaryDirectories.push(directory);
    const workspaces = path.join(directory, 'workspaces');
    const linked = await linkedImplementation(workspaces, 'NEX-2', 'NEX-1');
    await retainCompletion(workspaces, 'NEX-1', 'f'.repeat(40));
    const sourceRoot = path.join(workspaces, 'NEX', 'NEX-1');
    const handoffFile = path.join(sourceRoot, 'parent', 'handoff.json');
    const sourceHandoff = {
      stage: 'architecture',
      upstreamReturns: 0,
      feedback: null,
      return: null,
      awaitingStages: [],
      tickets: [
        {
          key: 'NEX-2',
          issueId: '2',
          plannedTask: 1,
          summary: 'Work for NEX-2',
          linked: false,
          ranked: false,
        },
      ],
      basis: null,
      publications: [],
    };
    await mkdir(path.dirname(handoffFile), { recursive: true });
    await writeFile(handoffFile, JSON.stringify(sourceHandoff));
    const candidates = [
      issue('2', 'NEX-2', 'To Do', { [pointerField]: linked }),
      issue('1', 'NEX-1', 'Done'),
      issue('3', 'NEX-3', 'To Do'),
    ];

    // The retained input exists, but the handoff has not recorded this ticket's link yet: the
    // ticket stays ineligible and the queue continues with other eligible work.
    const deferred = await select({
      issues: candidates,
      selectionFile: path.join(directory, 'selection.json'),
      workspaceRoot: workspaces,
    });
    expect(deferred.result).toBe('selected');
    expect(deferred.selection).toMatchObject({ taskKey: 'NEX-3' });
    expect(deferred.calls.filter((call) => call.startsWith('transition:2:'))).toEqual([]);

    // Once the handoff records the finished admission, the ticket is admitted normally.
    await writeFile(
      handoffFile,
      JSON.stringify({
        ...sourceHandoff,
        tickets: [
          {
            ...sourceHandoff.tickets[0],
            linked: true,
            ranked: true,
            admission: { initialStatus: 'To Do', completed: true },
          },
        ],
      }),
    );
    const admitted = await select({
      issues: candidates,
      selectionFile: path.join(directory, 'selection-later.json'),
      workspaceRoot: workspaces,
    });
    expect(admitted.result).toBe('selected');
    expect(admitted.selection).toMatchObject({ taskKey: 'NEX-2' });
  });
});
