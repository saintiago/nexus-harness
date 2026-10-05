/** Real composed parent/child and action storage; source, Git and agent responses are controlled. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ok } from '../src/result.js';
import {
  createTaskEngine,
  type AgentRoleRunner,
  type BoundAction,
} from '../src/task-engine/index.js';
import { createStartStageRound } from '../src/task-engine/actions/preparation/start-stage-round/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import { createRecordStageReturn } from '../src/task-engine/actions/preparation/record-stage-return/index.js';
import { createPublishPreparation } from '../src/task-engine/actions/project/publish-preparation/index.js';
import { preparationStages } from '../src/task-engine/actions/preparation/artifacts.js';
import { readStagePlan, stageRoot } from '../src/task-engine/actions/preparation/storage.js';
import { readHandoff } from '../src/task-engine/actions/project/state.js';
import { project } from '../workflows/project.js';
import { preparation } from '../workflows/preparation.js';
import { scriptedGit, repositoryState } from './support/git.js';
import { scriptedJira } from './support/jira.js';

it('keeps nested returns and finding obligations through composed restarts and final reassessment', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-corrections-'));
  try {
    const root = path.join(directory, 'NEX-1');
    const selectionFile = path.join(directory, 'selection.json');
    const stateFile = path.join(directory, 'workflow.json');
    await mkdir(path.join(root, 'worktree'), { recursive: true });
    await writeFile(path.join(root, 'worktree', 'readme.md'), 'Current preparation content\n');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: {},
        conversation: [],
        workspace: { root },
        stage: 'architecture',
      }),
    );
    const statuses = {
      requirements: 'Draft',
      ux: 'UX Proposal',
      prototype: 'Storybook Refinement',
      architecture: 'Architecture',
    };
    let status: string = statuses.architecture;
    const { jira } = scriptedJira({
      readIssue: () => ok({ id: '1', key: 'NEX-1', fields: { status: { name: status } } }),
      readComments: () => ok([]),
      readTransitions: () =>
        ok(Object.values(statuses).map((name) => ({ id: name, name, to: { id: name, name } }))),
      transitionIssue: (_id, transition) => {
        status = transition;
        return ok(undefined);
      },
      addComment: () => ok({ id: 'comment', body: {} }),
    });
    const { git } = scriptedGit([repositoryState()], {
      readFileAtRevision: async (repository, _revision, file) =>
        ok(await readFile(path.join(repository, file), 'utf8')),
    });
    const finding = (id: string) => ({
      id,
      title: 'An upstream input needs correction',
      severity: 'blocking',
      basis: 'Preparation must honor the corrected input.',
      evidence: 'The input contradicts the intended journey.',
      impact: 'The current work cannot be accepted.',
      repairGuidance: 'Correct the input and reassess.',
      locations: [],
    });
    let authorResponds = false;
    let evaluatorDisposes = false;
    let primingRequirements = true;
    const routes: string[] = [];
    const runner: AgentRoleRunner = {
      async run(request) {
        const stage = (
          JSON.parse(await readFile(selectionFile, 'utf8')) as { stage: keyof typeof statuses }
        ).stage;
        const plan = await readStagePlan(stageRoot(root, stage));
        if (plan === null) throw new Error('Missing plan');
        const returning = plan.round === 1 && (stage === 'architecture' || stage === 'prototype');
        const id = stage === 'architecture' ? 'F1' : stage === 'prototype' ? 'F2' : 'R1';
        const resolving =
          !returning &&
          (stage === 'architecture' ||
            stage === 'prototype' ||
            (stage === 'requirements' && !primingRequirements));
        if (request.operation === 'stage-author') {
          routes.push(`${stage}:${String(plan.round)}:${plan.route}`);
          if (resolving) expect(request.context).toContain(`Eligible prior finding IDs: "${id}"`);
          return ok({
            output: JSON.stringify({
              outcome: 'skip-proposed',
              summary: 'Assess the existing work against the current input.',
              documents: [],
              sourcePaths: [],
              plan: [],
              skip: {
                reason: 'The existing work suffices after correction.',
                references: ['readme.md'],
              },
              question: null,
              upstream: null,
              findingResponses:
                resolving && (stage !== 'architecture' || authorResponds)
                  ? [
                      {
                        findingId: id,
                        status: 'addressed',
                        response: 'The input correction resolves the contradiction.',
                      },
                    ]
                  : [],
            }),
          });
        }
        if (resolving) expect(request.context).toContain(`Eligible prior finding IDs: "${id}"`);
        return ok({
          output: JSON.stringify({
            assessedRevision: plan.round,
            verdict: primingRequirements
              ? 'changes-requested'
              : returning
                ? 'return-upstream'
                : 'accepted-skip',
            reason: returning
              ? 'Correct the upstream input.'
              : 'The corrected input makes this work adequate.',
            findings: returning || primingRequirements ? [finding(id)] : [],
            priorFindings:
              resolving && (stage !== 'architecture' || evaluatorDisposes)
                ? [
                    {
                      findingId: id,
                      disposition: 'resolved',
                      reason: 'The corrected input resolves it.',
                    },
                  ]
                : [],
            upstream: returning
              ? {
                  stage: stage === 'architecture' ? 'prototype' : 'requirements',
                  problem: 'The input contradicts the journey.',
                  consequence: 'The work cannot be accepted.',
                  correction: 'Correct the input.',
                }
              : null,
          }),
        });
      },
    };
    // The direct correction destination has its own retained proposal and unresolved finding.
    const selection = JSON.parse(await readFile(selectionFile, 'utf8')) as Record<string, unknown>;
    await writeFile(selectionFile, JSON.stringify({ ...selection, stage: 'requirements' }));
    const common = { selectionFile, stage: 'requirements' as const, publish: () => undefined };
    await createStartStageRound({
      ...common,
      profiles: { authors: ['a'], evaluator: 'e' },
      maxRounds: 2,
    })({ route: 'new' });
    await createStageAuthor({ ...common, git, runner })({ task: 'propose' });
    await createStageEvaluator({ ...common, git, runner })();
    primingRequirements = false;
    await writeFile(selectionFile, JSON.stringify(selection));
    let selected = false;
    let interruptNestedReturn = true;
    let handoffs = 0;
    const publishedPending: { stage: string; pending: readonly string[] }[] = [];
    const run = () =>
      createTaskEngine({
        workflow: project,
        children: { Preparation: preparation },
        stateFile,
        bindActions: (publish) => {
          const actionsByStage = Object.fromEntries(
            preparationStages.map((stage) => [
              stage,
              {
                StartStageRound: createStartStageRound({
                  selectionFile,
                  stage,
                  profiles: { authors: ['a'], evaluator: 'e' },
                  maxRounds: 2,
                  publish,
                }),
                StageAuthor: createStageAuthor({ selectionFile, stage, git, runner, publish }),
                StageEvaluator: createStageEvaluator({
                  selectionFile,
                  stage,
                  git,
                  runner,
                  publish,
                }),
                StageResult: createStageResult({ selectionFile, stage, git, publish }),
                RecordStageReturn: createRecordStageReturn({
                  selectionFile,
                  stage,
                  maxUpstreamReturns: 1,
                  publish,
                }),
              },
            ]),
          );
          const dispatch =
            (operation: string): BoundAction =>
            async (input) => {
              const stage = (input as { stage: string }).stage;
              const action = (actionsByStage[stage] as Record<string, BoundAction>)[operation];
              if (action === undefined) throw new Error(`Missing ${operation}`);
              return action(input);
            };
          const publishPreparation = createPublishPreparation({
            selectionFile,
            statuses: {
              requirements: statuses.requirements,
              uxProposal: statuses.ux,
              storybookRefinement: statuses.prototype,
              architecture: statuses.architecture,
            },
            waitingForFeedback: 'Waiting',
            ideaActive: 'Idea Refinement',
            jira,
            git,
            publish,
          });
          const unused: BoundAction = async () => {
            throw new Error('Unexpected non-preparation operation');
          };
          return {
            IdeaRefinement: unused,
            FiniteDelivery: unused,
            PublishIdeaResult: unused,
            CompleteDelivery: unused,
            SelectWork: async () => {
              if (selected) return 'empty';
              selected = true;
              return 'selected';
            },
            RouteSelection: async () =>
              (JSON.parse(await readFile(selectionFile, 'utf8')) as { stage: string }).stage,
            PrepareStage: async () => 'prepared',
            StartStageRound: dispatch('StartStageRound'),
            StageAuthor: dispatch('StageAuthor'),
            StageEvaluator: dispatch('StageEvaluator'),
            StageResult: dispatch('StageResult'),
            RecordStageReturn: dispatch('RecordStageReturn'),
            PublishPreparationResult: async (input) => {
              const stage = (input as { stage: string }).stage;
              const outcome = await publishPreparation(input);
              const pending = (await readHandoff(root))?.awaitingStages ?? [];
              publishedPending.push({ stage, pending });
              if (
                stage === 'prototype' &&
                pending.includes('requirements') &&
                interruptNestedReturn
              ) {
                interruptNestedReturn = false;
                throw new Error('Interrupted after nested correction publication');
              }
              return outcome;
            },
            AnalyzeExperience: async () => 'recorded',
            HandoffImplementation: async () => {
              handoffs += 1;
              return 'handed-off';
            },
          };
        },
      }).run();

    const first = await run();
    expect(first.ok ? '' : first.fault.message).toContain('Interrupted after nested correction');
    expect((await readHandoff(root))?.awaitingStages).toEqual([
      'requirements',
      'ux',
      'prototype',
      'architecture',
    ]);
    const second = await run();
    expect(second.ok ? '' : second.fault.message).toContain('did not respond to finding "F1"');
    expect((await readHandoff(root))?.awaitingStages).toEqual(['architecture']);
    expect(handoffs).toBe(0);
    authorResponds = true;
    const third = await run();
    expect(third.ok ? '' : third.fault.message).toContain('does not dispose of prior finding "F1"');
    expect(handoffs).toBe(0);
    evaluatorDisposes = true;
    await expect(run()).resolves.toEqual({ ok: true, value: 'drained' });
    expect(handoffs).toBe(1);
    expect((await readHandoff(root))?.awaitingStages).toEqual([]);
    expect(routes).toEqual([
      'requirements:1:new',
      'architecture:1:new',
      'prototype:1:reassess',
      'requirements:2:reassess',
      'ux:1:reassess',
      'prototype:2:reassess',
      'architecture:2:reassess',
      'architecture:2:reassess',
    ]);
    expect(publishedPending).toEqual(
      expect.arrayContaining([
        { stage: 'architecture', pending: ['prototype', 'architecture'] },
        { stage: 'requirements', pending: ['ux', 'prototype', 'architecture'] },
        { stage: 'ux', pending: ['prototype', 'architecture'] },
        { stage: 'prototype', pending: ['architecture'] },
      ]),
    );
    for (const stage of ['prototype', 'architecture']) {
      expect(
        JSON.parse(await readFile(path.join(root, stage, 'state/returns.json'), 'utf8')),
      ).toEqual({ count: 1, round: 1 });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
