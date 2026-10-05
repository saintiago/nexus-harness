/**
 * Focused integration tests: the project parent's terminal handoffs. The parent runs over
 * temporary state files with stub children, and the AnalyzeExperience binding hands the parent's
 * terminal to the real handoff builders over a temporary issue workspace. No live service or
 * provider is involved.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMachine } from 'xstate';
import {
  finiteDeliveryTerminals,
  preparationHandoff,
  selectionFailureHandoff,
} from '../src/application/analysis-handoff.js';
import {
  parentAreaDirectory,
  initialHandoff,
} from '../src/task-engine/actions/select-work/artifacts.js';
import { stageRoundPlanDeclaration } from '../src/task-engine/actions/preparation/artifacts.js';
import { preparationWorktree, stageRoot } from '../src/task-engine/actions/preparation/storage.js';
import type { BoundAction } from '../src/task-engine/index.js';
import { createTaskEngine } from '../src/task-engine/index.js';
import { project } from '../workflows/project.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-terminals-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A trivial child machine whose single operation returns the supplied terminal outcome. */
function childMachine(operation: string, outcome: string) {
  return createMachine({
    id: `${operation}-child`,
    initial: 'run',
    output: ({ event }) => event.output,
    states: {
      run: { invoke: { src: operation, onDone: 'done' } },
      done: { type: 'final', output: outcome },
    },
  });
}

/** Run the real parent once with the supplied selection and publication outcomes. */
async function runParent(options: {
  readonly selection: string;
  readonly publication: string;
  readonly route?: string;
  readonly child?: string;
  readonly handoff?: string;
}): Promise<{
  readonly result: Awaited<ReturnType<ReturnType<typeof createTaskEngine>['run']>>;
  readonly handoffs: unknown[];
}> {
  const directory = await temporaryDirectory();
  const stateFile = path.join(directory, 'workflow.json');
  let selections = 0;
  let routes = 0;
  const actions: Record<string, BoundAction> = {
    SelectWork: async () => {
      selections += 1;
      // A published advance selects again; this controlled queue holds no further work.
      return selections === 1 ? options.selection : 'empty';
    },
    // The first route reaches the preparation child; a later route would need a fresh selection,
    // so the stub reports the missing continuation as attention.
    RouteSelection: async () => {
      routes += 1;
      return routes === 1 ? (options.route ?? 'requirements') : 'failed';
    },
    PublishPreparationResult: async () => options.publication,
    PublishIdeaResult: async () => 'approved',
    HandoffImplementation: async () => options.handoff ?? 'handed-off',
    CompleteDelivery: async () => 'completed',
    PrepareStage: async () => 'prepared',
    StartStageRound: async () => 'opened',
    StageAuthor: async () => 'authored',
    StageEvaluator: async () => 'accepted',
    RecordStageReturn: async () => 'return',
    StageResult: async () => 'saved',
    PreparationStub: async () => options.child ?? 'accepted',
    IdeaStub: async () => 'approved',
    DeliveryStub: async () => 'completed',
  };
  const handoffs: unknown[] = [];
  actions['AnalyzeExperience'] = async (input) => {
    handoffs.push(input);
    return 'recorded';
  };
  const engine = createTaskEngine({
    workflow: project,
    children: {
      IdeaRefinement: childMachine('IdeaStub', 'approved'),
      FiniteDelivery: childMachine('DeliveryStub', 'completed'),
      Preparation: childMachine('PreparationStub', options.child ?? 'accepted'),
    },
    stateFile,
    bindActions: () => actions,
  });
  return { result: await engine.run(), handoffs };
}

describe('project parent terminal capture', () => {
  it.each([
    ['advanced', 'preparation-advanced', 'blocked', 'requirements'],
    ['waiting', 'preparation-waiting', 'drained', 'requirements'],
    ['exhausted', 'preparation-exhausted', 'drained', 'requirements'],
    // Only the Architecture stage hands off; the other stages never return that outcome.
    ['handoff', 'preparation-handoff', 'drained', 'architecture'],
  ] as const)(
    'captures the %s publication as its own terminal before continuing',
    async (publication, terminal, expected, stage) => {
      const { result, handoffs } = await runParent({
        selection: 'selected',
        publication,
        route: stage,
      });

      expect(result).toEqual({ ok: true, value: expected });
      // The capture names the stage whose publication it records, not the advanced destination.
      expect(handoffs).toEqual([{ terminal, stage }]);
    },
  );

  it.each([
    { child: 'blocked', publication: 'advanced', terminal: 'preparation-failed' },
    { child: 'accepted', publication: 'failed', terminal: 'preparation-publication-failed' },
    { child: 'accepted', publication: 'handoff', handoff: 'failed', terminal: 'handoff-failed' },
  ])(
    'captures $terminal after the selected operation while preserving blocked',
    async (options) => {
      const result = await runParent({ ...options, route: 'architecture', selection: 'selected' });
      expect(result.result).toEqual({ ok: true, value: 'blocked' });
      expect(result.handoffs).toEqual([{ terminal: options.terminal, stage: 'architecture' }]);
    },
  );

  it('captures a selected-work failure before recovery, not an empty queue', async () => {
    const { result, handoffs } = await runParent({
      selection: 'failed',
      publication: 'waiting',
    });

    expect(result).toEqual({ ok: true, value: 'blocked' });
    expect(handoffs).toEqual([{ terminal: 'selection-failed' }]);

    const drained = await runParent({ selection: 'empty', publication: 'waiting' });
    expect(drained.result).toEqual({ ok: true, value: 'drained' });
    expect(drained.handoffs).toEqual([]);
  });

  it('names the review-publication failure as a finite-delivery terminal', () => {
    expect(finiteDeliveryTerminals['review-publication-failed']).toMatchObject({
      outcome: 'failed',
      evidence: 'round',
    });
  });
});

describe('preparation terminal handoffs', () => {
  it('reads the stage plan through its own declaration and retains the round evidence', async () => {
    const directory = await temporaryDirectory();
    const root = path.join(directory, 'NEX-1');
    const stage = stageRoot(root, 'ux');
    await mkdir(path.join(stage, 'state'), { recursive: true });
    await mkdir(path.join(stage, 'artifacts', '2'), { recursive: true });
    await mkdir(preparationWorktree(root), { recursive: true });
    await writeFile(
      path.join(stage, stageRoundPlanDeclaration.file),
      JSON.stringify({
        stage: 'ux',
        round: 2,
        route: 'next',
        priorRound: 1,
        profiles: { author: 'a', evaluator: 'e' },
      }),
    );
    await writeFile(path.join(stage, 'state/returns.json'), JSON.stringify({ count: 1 }));
    await writeFile(
      path.join(stage, 'artifacts/2/result.json'),
      JSON.stringify({
        stage: 'ux',
        outcome: 'needsInput',
        authoredRevision: 2,
        documents: [],
        outputs: [],
        evaluation: { path: path.join(stage, 'artifacts/2/evaluation.json') },
        reason: 'Which user should this serve?',
        returnStage: null,
        returnFinding: null,
      }),
    );
    const handoff = await preparationHandoff({
      selection: {
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: {},
        conversation: [],
        workspace: { root },
        stage: 'ux',
      },
      terminal: 'preparation-waiting',
      stage: 'ux',
    });

    expect(handoff).toMatchObject({
      workId: 'NEX-1',
      workflow: 'preparation',
      attemptId: 'ux-round-2',
      terminalId: 'preparation-waiting',
      outcome: 'needs-input',
      reason: 'Which user should this serve?',
    });
    const files = handoff.artifacts.map((artifact) => artifact.path);
    expect(files).toContain(path.join(stage, 'artifacts/2/result.json'));
    expect(files).toContain(path.join(stage, 'state/returns.json'));
  });

  it('includes actual handoff publication and ticket evidence captured after the operation', async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, 'parent'), { recursive: true });
    await writeFile(
      path.join(root, 'parent/handoff-result.json'),
      JSON.stringify({ outcome: 'handed-off', tickets: ['NEX-2'], mergeRevision: 'merged' }),
    );
    const result = await preparationHandoff({
      selection: {
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: {},
        conversation: [],
        workspace: { root },
        stage: 'architecture',
      },
      terminal: 'preparation-handoff',
      stage: 'architecture',
    });
    expect(result.outcome).toBe('handed-off');
    expect(result.artifacts.map((artifact) => artifact.path)).toContain(
      path.join(root, 'parent/handoff-result.json'),
    );
  });

  it('captures a selected-work failure from the retained parent area', async () => {
    const directory = await temporaryDirectory();
    const root = path.join(directory, 'NEX-1');
    const stage = stageRoot(root, 'requirements');
    await mkdir(path.join(root, parentAreaDirectory), { recursive: true });
    await mkdir(path.join(stage, 'state'), { recursive: true });
    await writeFile(
      path.join(root, parentAreaDirectory, 'handoff.json'),
      JSON.stringify(initialHandoff('requirements')),
    );
    await writeFile(path.join(stage, 'state/current-round.json'), JSON.stringify({}));
    await writeFile(
      path.join(root, parentAreaDirectory, 'selection-failure.json'),
      JSON.stringify({ reason: 'the mapped status is missing' }),
    );
    const handoff = await selectionFailureHandoff({
      failureFile: path.join(root, 'selection-failure.json'),
      failure: {
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        reason: 'the mapped status is missing',
        selection: {
          taskKey: 'NEX-1',
          source: { kind: 'jira', issueId: '1' },
          task: {},
          conversation: [],
          workspace: { root },
          stage: 'requirements',
        },
      },
    });

    expect(handoff).toMatchObject({
      workflow: 'selection',
      terminalId: 'selection-failed',
      outcome: 'failed',
      reason: 'the mapped status is missing',
      attemptId: 'requirements-selection',
    });
    expect(handoff.artifacts.map((artifact) => artifact.path)).toContain(
      path.join(stage, 'state/current-round.json'),
    );
  });
});
