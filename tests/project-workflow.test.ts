/**
 * Focused integration tests: the project parent composes its invoked child machines, routes by
 * the retained stage and owns publication. The parent and child operations are supplied stubs
 * over temporary state files except where the real action under test is the subject; no live
 * service, provider or process is involved.
 */

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMachine } from 'xstate';
import type { JiraComment, JiraTransition } from '../src/adapters/jira.js';
import type { CodingRuntime, CodingRuntimeRequest } from '../src/adapters/coding-runtime.js';
import { ok } from '../src/result.js';
import {
  createActionBinding,
  type ActionBindingSettings,
} from '../src/application/action-bindings.js';
import { parseNexusConfiguration, parseProjectConfiguration } from '../src/configuration/index.js';
import type { BoundAction } from '../src/task-engine/index.js';
import { createTaskEngine, type EngineEvent } from '../src/task-engine/index.js';
import { stageAuthorArtifact } from '../src/task-engine/actions/preparation/artifacts.js';
import { createImplementationHandoff } from '../src/task-engine/actions/project/implementation-handoff/index.js';
import { implementationInputDeclaration } from '../src/task-engine/actions/project/implementation-handoff/artifacts.js';
import { createPublishPreparation } from '../src/task-engine/actions/project/publish-preparation/index.js';
import { parentAreaDirectory } from '../src/task-engine/actions/select-work/artifacts.js';
import {
  acceptedResultIdentity,
  preparationWorktree,
  stageRoot,
} from '../src/task-engine/actions/preparation/storage.js';
import {
  authoredIdentity,
  sourceInputIdentity,
} from '../src/task-engine/actions/preparation/evaluation-content.js';
import { project } from '../workflows/project.js';
import { preparation } from '../workflows/preparation.js';
import { repositoryState, scriptedGit } from './support/git.js';
import { scriptedJira } from './support/jira.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

type ActionStub = BoundAction;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-project-'));
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

/** The parent's own operations with scripted outcomes, recording every call. */
function parentActions(options: {
  readonly route: string;
  readonly preparation?: string;
  readonly publishPreparation?: string;
  readonly handoff?: string;
  readonly delivery?: string;
}): { readonly actions: Record<string, ActionStub>; readonly calls: string[] } {
  const calls: string[] = [];
  const stub =
    (name: string, outcome: string): ActionStub =>
    async () => {
      calls.push(name);
      return outcome;
    };
  let routed = 0;
  return {
    calls,
    actions: {
      SelectWork: async () => {
        calls.push('SelectWork');
        return calls.filter((call) => call === 'SelectWork').length === 1 ? 'selected' : 'empty';
      },
      // The first route is the selected stage; a later route would need a fresh selection, so the
      // stub reports the missing continuation as attention.
      RouteSelection: async () => {
        calls.push('RouteSelection');
        routed += 1;
        return routed === 1 ? options.route : 'failed';
      },
      PublishIdeaResult: stub('PublishIdeaResult', 'approved'),
      PublishPreparationResult: stub(
        'PublishPreparationResult',
        options.publishPreparation ?? 'waiting',
      ),
      HandoffImplementation: stub('HandoffImplementation', options.handoff ?? 'handed-off'),
      CompleteDelivery: stub('CompleteDelivery', 'completed'),
      AnalyzeExperience: stub('AnalyzeExperience', 'recorded'),
      IdeaStub: stub('IdeaStub', 'approved'),
      PreparationStub: stub('PreparationStub', options.preparation ?? 'accepted'),
      DeliveryStub: stub('DeliveryStub', options.delivery ?? 'completed'),
    },
  };
}

/** Run the real parent with stub children over one temporary state file. */
async function runParent(options: {
  readonly route: string;
  readonly preparation?: string;
  readonly publishPreparation?: string;
  readonly handoff?: string;
  readonly delivery?: string;
}): Promise<{
  readonly result: Awaited<ReturnType<ReturnType<typeof createTaskEngine>['run']>>;
  readonly calls: string[];
  readonly states: string[];
}> {
  const directory = await temporaryDirectory();
  const stateFile = path.join(directory, 'workflow.json');
  const { actions, calls } = parentActions(options);
  const engine = createTaskEngine({
    workflow: project,
    children: {
      IdeaRefinement: childMachine('IdeaStub', 'approved'),
      FiniteDelivery: childMachine('DeliveryStub', 'completed'),
      Preparation: childMachine('PreparationStub', options.preparation ?? 'accepted'),
    },
    stateFile,
    bindActions: () => actions,
  });
  const states: string[] = [];
  engine.subscribe((event: EngineEvent) => {
    if (event.source === 'execution-runner' && event.type === 'state') {
      states.push(String((event.data as { readonly value: unknown }).value));
    }
  });
  return { result: await engine.run(), calls, states };
}

describe('project parent composition', () => {
  it('invokes the stage child, publishes its result and drains when no work remains', async () => {
    const { result, calls, states } = await runParent({ route: 'requirements' });

    expect(result).toEqual({ ok: true, value: 'drained' });
    expect(calls).toEqual([
      'SelectWork',
      'RouteSelection',
      'PreparationStub',
      'PublishPreparationResult',
      'AnalyzeExperience',
      'SelectWork',
    ]);
    expect(states).toEqual([
      'select',
      'route',
      'requirements',
      'publishRequirements',
      'analyzePreparationWaiting',
      'select',
      'drained',
    ]);
  });

  it.each([
    ['idea', 'IdeaStub', 'PublishIdeaResult', 'publishIdeaApproved'],
    ['delivery', 'DeliveryStub', 'CompleteDelivery', 'completeDelivery'],
  ] as const)(
    'routes a %s-stage selection to its child and back to selection',
    async (route, childOperation, publication, publishState) => {
      const { result, calls, states } = await runParent({ route, preparation: 'accepted' });

      expect(result).toEqual({ ok: true, value: 'drained' });
      expect(calls).toContain(childOperation);
      expect(calls).toContain(publication);
      expect(states).toContain(publishState);
    },
  );

  it('hands an accepted architecture stage to the implementation handoff', async () => {
    const { result, calls, states } = await runParent({
      route: 'architecture',
      publishPreparation: 'handoff',
    });

    expect(result).toEqual({ ok: true, value: 'drained' });
    expect(calls).toEqual([
      'SelectWork',
      'RouteSelection',
      'PreparationStub',
      'PublishPreparationResult',
      'HandoffImplementation',
      'AnalyzeExperience',
      'SelectWork',
    ]);
    expect(states).toEqual([
      'select',
      'route',
      'architecture',
      'publishArchitecture',
      'handoff',
      'analyzePreparationHandoff',
      'select',
      'drained',
    ]);
  });

  it('returns an advanced preparation result to the next route and never hands off without architecture', async () => {
    const returned = await runParent({
      route: 'ux',
      preparation: 'returnUpstream',
      publishPreparation: 'advanced',
    });
    // The advanced publication routes again; the stub reports no further mapping for the same
    // selection, which the parent treats as attention.
    expect(returned.result).toEqual({ ok: true, value: 'blocked' });
    expect(returned.calls).not.toContain('HandoffImplementation');

    const waiting = await runParent({
      route: 'prototype',
      preparation: 'needsInput',
      publishPreparation: 'waiting',
    });
    expect(waiting.result).toEqual({ ok: true, value: 'drained' });
    expect(waiting.states).toContain('select');
  });

  it('restores an interrupted child from the composed snapshot and keeps its stage input', async () => {
    const directory = await temporaryDirectory();
    const stateFile = path.join(directory, 'workflow.json');
    const stageInputs: unknown[] = [];
    const failures = { evaluations: 0 };
    let selections = 0;
    const actions = (): Record<string, ActionStub> => ({
      SelectWork: async () => (selections++ === 0 ? 'selected' : 'empty'),
      RouteSelection: async () => 'requirements',
      PublishPreparationResult: async () => 'waiting',
      PublishIdeaResult: async () => 'approved',
      HandoffImplementation: async () => 'handed-off',
      CompleteDelivery: async () => 'completed',
      AnalyzeExperience: async () => 'recorded',
      PrepareStage: async () => 'prepared',
      StartStageRound: async (input) => {
        stageInputs.push(input);
        return 'opened';
      },
      StageAuthor: async (input) => {
        stageInputs.push(input);
        return 'authored';
      },
      StageEvaluator: async (input) => {
        stageInputs.push(input);
        failures.evaluations += 1;
        if (failures.evaluations === 1) {
          throw new Error('the evaluation service is unavailable');
        }
        return 'accepted';
      },
      RecordStageReturn: async () => 'return',
      StageResult: async (input) => {
        stageInputs.push(input);
        return 'saved';
      },
    });
    const first = await createTaskEngine({
      workflow: project,
      children: { IdeaRefinement: project, FiniteDelivery: project, Preparation: preparation },
      stateFile,
      bindActions: () => actions(),
    }).run();
    expect(first.ok).toBe(false);
    expect(first.ok ? '' : first.fault.message).toContain('evaluation service is unavailable');

    const second = await createTaskEngine({
      workflow: project,
      children: { IdeaRefinement: project, FiniteDelivery: project, Preparation: preparation },
      stateFile,
      bindActions: () => actions(),
    }).run();

    expect(second).toEqual({ ok: true, value: 'drained' });
    // The restored child continued with the stage its invocation carried.
    expect(
      stageInputs.filter((input) => (input as { stage?: unknown }).stage !== 'requirements'),
    ).toEqual([]);
    expect(stageInputs.length).toBeGreaterThan(0);
  });
});

/** The real preparation child over supplied stage operations. */
async function runPreparation(
  overrides: Readonly<Record<string, ActionStub>>,
  stage: 'ux' | 'architecture' = 'ux',
): Promise<{
  readonly result: Awaited<ReturnType<ReturnType<typeof createTaskEngine>['run']>>;
  readonly calls: string[];
  readonly inputs: readonly unknown[];
}> {
  const directory = await temporaryDirectory();
  const stateFile = path.join(directory, 'workflow.json');
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const outcomes: Record<string, string> = {
    PrepareStage: 'prepared',
    StartStageRound: 'opened',
    StageAuthor: 'authored',
    StageEvaluator: 'accepted',
    RecordStageReturn: 'return',
    StageResult: 'saved',
  };
  const actions: Record<string, ActionStub> = {};
  for (const [name, outcome] of Object.entries(outcomes)) {
    const override = overrides[name];
    actions[name] = async (input?: unknown) => {
      calls.push(name);
      inputs.push(input);
      return override === undefined ? outcome : override();
    };
  }
  const engine = createTaskEngine({
    workflow: preparation,
    input: { stage },
    stateFile,
    bindActions: () => actions,
  });
  return { result: await engine.run(), calls, inputs };
}

describe('evaluated preparation child', () => {
  it('accepts an evaluated skip without manufacturing work', async () => {
    const { result, calls, inputs } = await runPreparation({
      StageAuthor: async () => 'skip-proposed',
      StageEvaluator: async () => 'accepted-skip',
    });

    expect(result).toEqual({ ok: true, value: 'skipped' });
    expect(calls).toEqual([
      'PrepareStage',
      'StartStageRound',
      'StageAuthor',
      'StageEvaluator',
      'StageResult',
    ]);
    // The parent's stage input reaches every invoked operation.
    for (const input of inputs) {
      expect((input as { readonly stage?: unknown }).stage).toBe('ux');
    }
  });

  it('returns an Architecture acceptance directly to the handoff without a publication step', async () => {
    const result = await runPreparation({}, 'architecture');
    expect(result.result).toEqual({ ok: true, value: 'accepted' });
    expect(result.calls.at(-1)).toBe('StageResult');
    expect(result.calls).not.toContain('ReviewPreparationPublication');

    const skipped = await runPreparation(
      {
        StageAuthor: async () => 'skip-proposed',
        StageEvaluator: async () => 'accepted-skip',
      },
      'architecture',
    );
    expect(skipped.result).toEqual({ ok: true, value: 'skipped' });
    expect(skipped.calls.at(-1)).toBe('StageResult');
  });

  it('returns upstream within the configured allowance', async () => {
    const { result, calls } = await runPreparation({
      StageEvaluator: async () => 'return-upstream',
    });

    expect(result).toEqual({ ok: true, value: 'returnUpstream' });
    expect(calls).toContain('RecordStageReturn');
  });

  it('requests attention when the upstream-return allowance is exhausted', async () => {
    const { result } = await runPreparation({
      StageEvaluator: async () => 'return-upstream',
      RecordStageReturn: async () => 'exhausted',
    });

    expect(result).toEqual({ ok: true, value: 'exhausted' });
  });

  it('opens a bounded round for the author response and stops at the allowance', async () => {
    let rounds = 0;
    const { result, calls } = await runPreparation({
      StartStageRound: async () => (rounds++ < 3 ? 'opened' : 'exhausted'),
      StageEvaluator: async () => 'changes-requested',
    });

    expect(result).toEqual({ ok: true, value: 'exhausted' });
    // Author response, evaluator, next round, response, evaluator, then the exhausted round.
    expect(calls.filter((call) => call === 'StageEvaluator')).toHaveLength(3);
    expect(calls).toContain('StageResult');
  });

  it('returns a retained question for human feedback', async () => {
    const { result } = await runPreparation({
      StageAuthor: async () => 'needs-input',
    });

    expect(result).toEqual({ ok: true, value: 'needsInput' });
  });
});

/** A capability that fails the test when an unexpected operation reaches it. */
function unusedCapability<Capability extends object>(name: string): Capability {
  return new Proxy({} as Capability, {
    get: () => () => {
      throw new Error(`The ${name} capability was used unexpectedly.`);
    },
  });
}

describe('preparation binding dispatch', () => {
  it('dispatches each stage operation to the stage area the workflow supplied', async () => {
    const directory = await temporaryDirectory();
    const root = path.join(directory, 'NEX-1');
    const selectionFile = path.join(directory, 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: { id: '1', key: 'NEX-1', fields: {} },
        conversation: [],
        workspace: { root },
        stage: 'ux',
      }),
    );
    const { git, calls: gitCalls } = scriptedGit(
      [repositoryState({ remoteUrl: path.resolve(directory, 'repository.git'), branch: 'main' })],
      {
        fetchRevision: () => ok('1'.repeat(40)),
        cloneRepository: (source) =>
          ok({ remoteUrl: source, branch: 'main', headRevision: '1'.repeat(40) }),
        createBranch: (_repository, branch, startRevision) =>
          ok({ branch, headRevision: startRevision }),
        readRemoteBranchHead: () => ok(null),
      },
    );
    const settings: ActionBindingSettings = {
      project: parseProjectConfiguration(projectConfiguration(), directory),
      nexus: parseNexusConfiguration(nexusConfiguration(), directory),
      paths: {
        directory,
        workflowStateFile: path.join(directory, 'workflow.json'),
        selectionFile,
      },
      jira: unusedCapability('Jira'),
      github: unusedCapability('GitHub'),
      git,
      codingRuntime: unusedCapability('coding runtime'),
      runCommand: unusedCapability('processes'),
      commandEnvironment: {},
      activityDirectory: path.join(directory, 'agents'),
      wait: () => Promise.resolve(),
    };
    const actions = createActionBinding(settings)(
      () => undefined,
      () => undefined,
    );

    await expect(actions['PrepareStage']?.({ stage: 'ux' })).resolves.toBe('prepared');
    // The fresh clone probes the configured repository and creates the one preparation branch on
    // it, so first-time preparation never publishes from the base branch.
    expect(gitCalls).toContain(`remote:${path.resolve(directory, 'repository.git')}:task/NEX-1`);
    expect(
      gitCalls.some((call) => call.startsWith('create:') && call.includes('task/NEX-1@')),
    ).toBe(true);
    // Every stage shares the root-level checkout, and no stage area owns a worktree.
    await expect(
      readFile(path.join(root, 'parent', 'prepared-repository.json'), 'utf8'),
    ).resolves.toContain('"branch": "task/NEX-1"');
    expect(gitCalls).toContain(
      `clone:${path.resolve(directory, 'repository.git')}:${path.join(root, 'worktree')}`,
    );
    await expect(stat(path.join(root, 'ux', 'worktree'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(path.join(root, 'requirements', 'worktree'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('runs each preparation role in the one shared checkout resolved exactly once', async () => {
    const directory = await temporaryDirectory();
    const root = path.join(directory, 'NEX-1');
    const selectionFile = path.join(directory, 'selection.json');
    const worktree = preparationWorktree(root);
    const contentRevision = 'a'.repeat(40);
    const selection = {
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: { id: '1', key: 'NEX-1', fields: {} },
      conversation: [],
      workspace: { root },
      stage: 'ux',
    };
    await writeFile(selectionFile, JSON.stringify(selection));
    // The ux stage has an open round the author proposes into, over the shared checkout.
    await mkdir(path.join(worktree, 'docs'), { recursive: true });
    await writeFile(path.join(worktree, 'docs', 'ux.md'), '# UX\n');
    await mkdir(path.join(root, 'ux', 'state'), { recursive: true });
    await writeFile(
      path.join(root, 'ux', 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'ux',
        round: 1,
        route: 'new',
        profiles: { author: 'nexus-astra', evaluator: 'nexus-astra' },
      }),
    );
    await mkdir(path.join(root, 'ux', 'artifacts', '1'), { recursive: true });
    const outputs: unknown[] = [
      {
        outcome: 'authored',
        summary: 'The journey proposal.',
        documents: [{ path: 'docs/ux.md', description: 'The proposed journey.' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
        findingResponses: [],
      },
      {
        assessedRevision: 1,
        verdict: 'accepted',
        reason: 'The revision is adequate.',
        observation: null,
        findings: [],
        priorFindings: [],
        upstream: null,
      },
    ];
    const requests: CodingRuntimeRequest[] = [];
    const codingRuntime: CodingRuntime = {
      async execute(request) {
        requests.push(request);
        const output = outputs.shift();
        if (output === undefined) {
          throw new Error('No scripted provider output remains for this invocation.');
        }
        return ok({ output: JSON.stringify(output) });
      },
    };
    const { git } = scriptedGit(
      [
        repositoryState({
          remoteUrl: path.resolve(directory, 'repository.git'),
          branch: 'task/NEX-1',
          headRevision: contentRevision,
        }),
      ],
      {
        commitPaths: () => ok({ branch: 'task/NEX-1', headRevision: contentRevision }),
        readFileAtRevision: async (repository, _revision, file) =>
          ok(await readFile(path.join(repository, file), 'utf8')),
      },
    );
    const settings: ActionBindingSettings = {
      project: parseProjectConfiguration(projectConfiguration(), directory),
      nexus: parseNexusConfiguration(nexusConfiguration(), directory),
      paths: {
        directory,
        workflowStateFile: path.join(directory, 'workflow.json'),
        selectionFile,
      },
      jira: unusedCapability('Jira'),
      github: unusedCapability('GitHub'),
      git,
      codingRuntime,
      runCommand: unusedCapability('processes'),
      commandEnvironment: {},
      activityDirectory: path.join(directory, 'agents'),
      wait: () => Promise.resolve(),
    };
    const actions = createActionBinding(settings)(
      () => undefined,
      () => undefined,
    );

    await expect(actions['StageAuthor']?.({ stage: 'ux', task: 'propose' })).resolves.toBe(
      'authored',
    );
    await expect(actions['StageEvaluator']?.({ stage: 'ux' })).resolves.toBe('accepted');

    // The real AgentRuntime appends worktree/ to the supplied area root: every provider runs in
    // the one shared preparation checkout, never in a second worktree/ level under it.
    expect(requests.map((request) => request.directory)).toEqual([worktree, worktree]);
    await expect(stat(path.join(root, 'ux', 'worktree'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

/** One published preparation result over a controlled source. */
async function publishPreparation(options: {
  readonly result: Record<string, unknown>;
  readonly status: string;
  /** The parent handoff record the publication reads, when the case retains one. */
  readonly handoff?: Record<string, unknown>;
}): Promise<{
  readonly outcome: string;
  readonly status: () => string;
  readonly comments: readonly JiraComment[];
  readonly calls: string[];
  readonly stage: () => string | undefined;
  readonly failures: readonly string[];
  readonly feedback: () => unknown;
  readonly returnFinding: () => unknown;
  readonly awaiting: () => readonly string[];
  readonly captured: () => unknown;
}> {
  const directory = await temporaryDirectory();
  const root = path.join(directory, 'NEX-1');
  const selectedStage = String(options.result.stage ?? 'ux');
  const stage = stageRoot(root, selectedStage as 'ux' | 'architecture');
  await mkdir(path.join(stage, 'state'), { recursive: true });
  await mkdir(path.join(stage, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(stage, 'state', 'current-round.json'),
    JSON.stringify({
      stage: selectedStage,
      round: 1,
      route: 'new',
      profiles: { author: 'a', evaluator: 'e' },
    }),
  );
  await writeFile(path.join(stage, 'artifacts/1/result.json'), JSON.stringify(options.result));
  const selectionFile = path.join(directory, 'selection.json');
  const selection = {
    taskKey: 'NEX-1',
    source: { kind: 'jira', issueId: '1' },
    task: { id: '1', key: 'NEX-1', fields: {} },
    conversation: [],
    workspace: { root },
    stage: selectedStage,
  };
  await writeFile(selectionFile, JSON.stringify(selection));
  if (options.handoff !== undefined) {
    await mkdir(path.join(root, 'parent'), { recursive: true });
    await writeFile(path.join(root, 'parent', 'handoff.json'), JSON.stringify(options.handoff));
  }
  // The publication validates the current acceptance basis of every accepted or skipped result.
  const author = {
    stage: selectedStage,
    revision: Number(options.result.authoredRevision ?? 1),
    outcome: 'authored',
    summary: 'The proposed work.',
    documents: [],
    sourcePaths: [],
    plan: [],
    skip: null,
    question: null,
    upstream: null,
    observation: null,
    findingResponses: [],
  };
  const authorFile = path.join(stage, 'artifacts/1/author.json');
  await writeFile(authorFile, JSON.stringify(author));
  await writeFile(
    path.join(stage, 'artifacts/1/evaluation.json'),
    JSON.stringify({
      basis: {
        author: { path: authorFile },
        authorIdentity: authoredIdentity(stageAuthorArtifact.schema.parse(author)),
        sourceIdentity: sourceInputIdentity(selection as never),
        upstream: [],
        content: [],
      },
      assessedRevision: author.revision,
      verdict: options.result.outcome === 'skipped' ? 'accepted-skip' : 'accepted',
      reason: 'Accepted.',
      observation: null,
      findings: [],
      priorFindings: [],
      upstream: null,
    }),
  );

  let status = options.status;
  const comments: JiraComment[] = [];
  const transitionsByStatus: Record<string, JiraTransition[]> = {
    'UX Proposal': [
      { id: '31', name: 'Design', to: { id: '4', name: 'Storybook Refinement' } },
      { id: '32', name: 'Wait', to: { id: '5', name: 'Waiting for Feedback' } },
      { id: '33', name: 'Back to requirements', to: { id: '2', name: 'Draft' } },
      { id: '34', name: 'Correct idea', to: { id: '1', name: 'Idea Refinement' } },
    ],
    Draft: [],
    'Storybook Refinement': [],
    Architecture: [
      { id: '43', name: 'Return to UX', to: { id: '4', name: 'UX Proposal' } },
      { id: '44', name: 'Wait', to: { id: '5', name: 'Waiting for Feedback' } },
    ],
    'Waiting for Feedback': [],
  };
  const { jira, calls } = scriptedJira({
    readIssue: () =>
      ok({
        id: '1',
        key: 'NEX-1',
        fields: {
          summary: 'Add a lint gate',
          description: { type: 'doc', content: [] },
          status: { id: '3', name: status },
        },
      }),
    readComments: () => ok([...comments]),
    readTransitions: () => ok(transitionsByStatus[status] ?? []),
    addComment: (_issueId, body) => {
      const comment = { id: `c${String(comments.length + 1)}`, body };
      comments.push(comment);
      return ok(comment);
    },
    transitionIssue: (_issueId, transitionId) => {
      const transition = (transitionsByStatus[status] ?? []).find(
        (candidate) => candidate.id === transitionId,
      );
      if (transition === undefined) {
        throw new Error(`Unknown transition ${transitionId}`);
      }
      status = transition.to.name;
      return ok(undefined);
    },
  });

  const failures: string[] = [];
  const publish = createPublishPreparation({
    selectionFile,
    statuses: {
      requirements: 'Draft',
      uxProposal: 'UX Proposal',
      storybookRefinement: 'Storybook Refinement',
      architecture: 'Architecture',
    },
    waitingForFeedback: 'Waiting for Feedback',
    ideaActive: 'Idea Refinement',
    git: scriptedGit([repositoryState()]).git,
    jira,
    publish: (event) => {
      if (event.type === 'failed') {
        failures.push(String((event.data as { readonly reason?: unknown }).reason));
      }
    },
  });
  const outcome = await publish({ stage: selectedStage });
  const saved = JSON.parse(await readFile(selectionFile, 'utf8')) as {
    readonly stage: string;
    readonly task: unknown;
    readonly conversation: unknown;
  };
  // A failed publication writes no handoff, so the helper reads whichever record the outcome left.
  let handoff: {
    readonly feedback: unknown;
    readonly return: unknown;
    readonly awaitingStages: readonly string[];
  } | null = null;
  try {
    handoff = JSON.parse(
      await readFile(path.join(root, parentAreaDirectory, 'handoff.json'), 'utf8'),
    ) as {
      readonly feedback: unknown;
      readonly return: unknown;
      readonly awaitingStages: readonly string[];
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return {
    outcome,
    status: () => status,
    comments,
    calls,
    stage: () => saved.stage,
    failures,
    feedback: () => handoff?.feedback ?? null,
    returnFinding: () => handoff?.return ?? null,
    awaiting: () => handoff?.awaitingStages ?? [],
    captured: () => ({ task: saved.task, conversation: saved.conversation }),
  };
}

describe('parent preparation publication', () => {
  const accepted = {
    stage: 'ux',
    outcome: 'accepted',
    authoredRevision: 1,
    documents: [],
    outputs: [],
    evaluation: { path: '/evaluation.json' },
    reason: 'The journey covers the acceptance examples.',
    returnStage: null,
    returnFinding: null,
  } as const;

  it('advances an accepted stage to its next status and stage', async () => {
    const published = await publishPreparation({ result: accepted, status: 'UX Proposal' });

    expect(published.outcome).toBe('advanced');
    expect(published.status()).toBe('Storybook Refinement');
    expect(published.stage()).toBe('prototype');
    expect(published.comments).toHaveLength(1);
    // A publication acknowledgement never replaces the captured source input: the decision's
    // identity basis stays stable and the next stage reads the same captured conversation.
    expect(published.captured()).toEqual({
      task: { id: '1', key: 'NEX-1', fields: {} },
      conversation: [],
    });
    expect(published.awaiting()).toEqual([]);
  });

  it('returns an upstream result to the named earlier stage', async () => {
    const published = await publishPreparation({
      result: {
        ...accepted,
        outcome: 'returnUpstream',
        returnStage: 'requirements',
        reason: 'The acceptance example contradicts the requirement.',
      },
      status: 'UX Proposal',
    });

    expect(published.outcome).toBe('advanced');
    expect(published.status()).toBe('Draft');
    expect(published.stage()).toBe('requirements');
    // The correction invalidates the corrected stage and every later decision up to the returning
    // stage; the parent retains them as awaiting a current decision across restarts.
    expect(published.awaiting()).toEqual(['requirements', 'ux']);
  });

  it('retains every downstream stage awaiting reassessment when Architecture returns', async () => {
    const published = await publishPreparation({
      result: {
        ...accepted,
        stage: 'architecture',
        outcome: 'returnUpstream',
        returnStage: 'ux',
        reason: 'The proposed navigation cannot support the acceptance example.',
      },
      status: 'Architecture',
    });

    expect(published.outcome).toBe('advanced');
    expect(published.stage()).toBe('ux');
    expect(published.awaiting()).toEqual(['ux', 'prototype', 'architecture']);
  });

  it('establishes active Idea Refinement when returning directly to its child', async () => {
    const published = await publishPreparation({
      result: {
        ...accepted,
        outcome: 'returnUpstream',
        returnStage: 'idea',
        reason: 'Correct the idea.',
      },
      status: 'UX Proposal',
    });
    expect(published.outcome).toBe('advanced');
    expect(published.status()).toBe('Idea Refinement');
    expect(published.stage()).toBe('idea');
  });

  it('checks the Architecture source status before admitting the implementation handoff', async () => {
    const published = await publishPreparation({
      result: { ...accepted, stage: 'architecture' },
      status: 'Waiting for Feedback',
    });
    expect(published.outcome).toBe('failed');
    expect(published.comments).toEqual([]);
    expect(published.status()).toBe('Waiting for Feedback');
  });

  /** The parent handoff a returned-from Architecture preparation retains. */
  const architectureHandoff = (awaitingStages: readonly string[]) => ({
    stage: 'architecture',
    upstreamReturns: 1,
    feedback: null,
    return: {
      from: 'architecture',
      to: 'ux',
      problem: 'The proposed navigation cannot support the acceptance example.',
      consequence: 'The architecture cannot expose the required journey.',
      correction: 'Propose a navigation path that supports the example.',
    },
    awaitingStages,
    tickets: [],
    publications: [],
  });

  it('clears Architecture\u2019s completed reassessment before admitting the handoff', async () => {
    const published = await publishPreparation({
      result: { ...accepted, stage: 'architecture' },
      status: 'Architecture',
      handoff: architectureHandoff(['architecture']),
    });

    // Architecture's own completed reassessment leaves no pending stage behind, so the parent can
    // start the implementation handoff.
    expect(published.outcome).toBe('handoff');
    expect(published.awaiting()).toEqual([]);
  });

  it('preserves a genuinely pending reassessment instead of handing off', async () => {
    const published = await publishPreparation({
      result: { ...accepted, stage: 'architecture' },
      status: 'Architecture',
      handoff: architectureHandoff(['ux']),
    });

    expect(published.outcome).toBe('failed');
    expect(published.failures.join('\n')).toContain('ux');
    // The pending stage stays retained so the route can still obtain its current decision.
    expect(published.awaiting()).toEqual(['ux']);
  });

  it('retains a question with its stage while the item waits for feedback', async () => {
    const published = await publishPreparation({
      result: {
        ...accepted,
        outcome: 'needsInput',
        reason: 'Which user should this serve?',
      },
      status: 'UX Proposal',
    });

    expect(published.outcome).toBe('waiting');
    expect(published.status()).toBe('Waiting for Feedback');
    expect(published.stage()).toBe('ux');
    expect(published.feedback()).toEqual({
      stage: 'ux',
      question: 'Which user should this serve?',
    });
  });

  it('retains the concrete return finding for the destination stage', async () => {
    const published = await publishPreparation({
      result: {
        ...accepted,
        outcome: 'returnUpstream',
        returnStage: 'requirements',
        returnFinding: {
          stage: 'requirements',
          problem: 'The acceptance example contradicts the requirement.',
          consequence: 'UX cannot propose one consistent journey.',
          correction: 'Correct the acceptance example.',
        },
        reason: 'The acceptance example contradicts the requirement.',
      },
      status: 'UX Proposal',
    });

    expect(published.outcome).toBe('advanced');
    expect(published.stage()).toBe('requirements');
    expect(published.returnFinding()).toEqual({
      from: 'ux',
      to: 'requirements',
      problem: 'The acceptance example contradicts the requirement.',
      consequence: 'UX cannot propose one consistent journey.',
      correction: 'Correct the acceptance example.',
    });
  });

  it('preserves an unexpected human status change instead of overwriting it', async () => {
    const published = await publishPreparation({
      result: accepted,
      status: 'Waiting for Feedback',
    });

    expect(published.outcome).toBe('failed');
    expect(published.status()).toBe('Waiting for Feedback');
    expect(published.comments).toHaveLength(0);
  });
});

/**
 * The Architecture handoff over a controlled preparation checkout and source. The handoff has no
 * GitHub capability: its effects are the created tickets, their links, ranks, implementation
 * inputs and admission, and the original's preparation-handoff comment and completion.
 */
async function handoff(options: {
  readonly documents?: boolean;
  readonly prototype?: { readonly branch: string; readonly revision: string } | null;
  readonly skipped?: boolean;
  readonly tasks?: readonly {
    summary: string;
    scope: string;
    completionCriteria: string[];
    prerequisites: number[];
  }[];
  readonly failLinkOnce?: boolean;
  readonly loseCreateResponse?: boolean;
  readonly failCreateOnce?: boolean;
  readonly retry?: boolean;
  readonly sourceStatus?: string;
  readonly implementationStatus?: string;
  readonly initialTicketStatus?: string;
  readonly ticketStatusAfterFirst?: string;
  readonly initialRankOrder?: readonly string[];
  readonly missingPreparation?: boolean;
  readonly preparationBranch?: string;
  /** The branch the retained checkout actually sits on, when it differs from the record. */
  readonly checkoutBranch?: string;
  /** The retained checkout's head after the first invocation, for rewritten-history replay. */
  readonly headAfterFirst?: string;
  readonly rewrittenPreparation?: boolean;
  readonly changePlanOnRetry?: boolean;
  /** A preparation-only publication the removed handoff workflow retained before this change. */
  readonly legacyPublication?: { readonly kind: string; readonly id: string };
  /** A retained documentation review record of the removed preparation-only publication. */
  readonly legacyReview?: boolean;
  /** A workspace pointer the first created ticket already records, as a human-set root. */
  readonly firstTicketWorkspace?: string;
}): Promise<{
  readonly outcome: string;
  readonly firstOutcome: string;
  readonly workspaceRoot: string;
  readonly ticketStatus: (index?: number) => string | undefined;
  readonly tickets: readonly {
    readonly key: string;
    readonly summary: string;
    readonly admission?: { readonly initialStatus: string; readonly completed: boolean };
  }[];
  readonly status: () => string;
  readonly links: readonly string[];
  readonly ranked: readonly string[];
  readonly rankOrder: readonly string[];
  readonly comments: readonly JiraComment[];
  readonly createdFields: readonly Readonly<Record<string, unknown>>[];
  readonly failures: readonly string[];
  readonly jiraCalls: readonly string[];
  readonly inputs: readonly unknown[];
  readonly workspacePointers: readonly string[];
  readonly files: readonly string[];
}> {
  const directory = await temporaryDirectory();
  const workspaceRoot = path.join(directory, 'workspaces');
  const root = path.join(workspaceRoot, 'NEX', 'NEX-1');
  const stage = stageRoot(root, 'architecture');
  const worktree = path.join(root, 'worktree');
  const implementationStatus = options.implementationStatus ?? 'To Do';
  const initialTicketStatus = options.initialTicketStatus ?? implementationStatus;
  await mkdir(path.join(worktree, 'docs'), { recursive: true });
  /** The captured input the fixture's stage decisions are bound to. */
  const fixtureSelection = {
    taskKey: 'NEX-1',
    source: { kind: 'jira', issueId: '1' },
    task: { id: '1', key: 'NEX-1', fields: {} },
    conversation: [],
    workspace: { root },
    stage: 'architecture',
  };
  /** The earlier accepted results each later stage's decision binds, in route order. */
  const upstream: { readonly result: { readonly path: string }; readonly identity: string }[] = [];

  /** Write one stage's accepted or skipped decision with its complete acceptance basis. */
  async function writeStageDecision(settings: {
    readonly stage: 'requirements' | 'ux' | 'prototype' | 'architecture';
    readonly outcome: 'accepted' | 'skipped';
    readonly documents: readonly { readonly path: string; readonly revision: string | null }[];
    readonly prototype?: { readonly branch: string; readonly revision: string } | null;
  }): Promise<void> {
    const area = stageRoot(root, settings.stage);
    const artifacts = path.join(area, 'artifacts', '1');
    await mkdir(path.join(area, 'state'), { recursive: true });
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      path.join(area, 'state/current-round.json'),
      JSON.stringify({
        stage: settings.stage,
        round: 1,
        route: 'new',
        profiles: { author: 'a', evaluator: 'e' },
      }),
    );
    const author = {
      stage: settings.stage,
      revision: 1,
      outcome: settings.outcome === 'skipped' ? 'skip-proposed' : 'authored',
      summary: 'The evaluated stage work.',
      documents: settings.documents.map((document) => ({
        path: document.path,
        description: 'the changed document',
      })),
      sourcePaths: [],
      plan: [],
      skip:
        settings.outcome === 'skipped'
          ? { reason: 'Existing input suffices.', references: ['docs/existing.md'] }
          : null,
      question: null,
      upstream: null,
      observation: null,
      findingResponses: [],
    };
    const authorFile = path.join(artifacts, 'author.json');
    await writeFile(authorFile, JSON.stringify(author));
    await writeFile(
      path.join(artifacts, 'evaluation.json'),
      JSON.stringify({
        basis: {
          author: { path: authorFile },
          authorIdentity: authoredIdentity(stageAuthorArtifact.schema.parse(author)),
          sourceIdentity: sourceInputIdentity(fixtureSelection as never),
          upstream: [...upstream],
          content: [
            ...settings.documents
              .filter((document) => document.revision !== null)
              .map((document) => ({
                path: document.path,
                revision: document.revision as string,
                exists: true,
              })),
            ...(settings.outcome === 'skipped'
              ? [{ path: 'docs/existing.md', revision: 'f'.repeat(40), exists: true }]
              : []),
          ],
        },
        assessedRevision: 1,
        verdict: settings.outcome === 'skipped' ? 'accepted-skip' : 'accepted',
        reason: 'Assessed the exact retained content.',
        observation: null,
        findings: [],
        priorFindings: [],
        upstream: null,
      }),
    );
    const result = {
      stage: settings.stage,
      outcome: settings.outcome,
      authoredRevision: 1,
      documents: settings.documents.map((document) => ({
        path: path.join(worktree, document.path),
        revision: document.revision,
      })),
      existingDocuments:
        settings.outcome === 'skipped'
          ? [{ path: path.join(worktree, 'docs/existing.md'), revision: 'f'.repeat(40) }]
          : [],
      sourcePaths: [],
      skipReferences: settings.outcome === 'skipped' ? ['docs/existing.md'] : [],
      outputs: [],
      evaluation: { path: path.join(artifacts, 'evaluation.json') },
      reason: 'The design and plan cover the accepted outcome.',
      returnStage: null,
      returnFinding: null,
      prototype: settings.prototype ?? null,
    };
    await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result));
    upstream.push({
      result: { path: path.join(artifacts, 'result.json') },
      identity: acceptedResultIdentity(result as never),
    });
  }

  if (options.documents === true) {
    // An accepted earlier stage's changed document lives in the same shared checkout.
    await writeStageDecision({
      stage: 'requirements',
      outcome: 'accepted',
      documents: [{ path: 'docs/requirements.md', revision: 'a'.repeat(40) }],
    });
    await writeFile(path.join(worktree, 'docs/requirements.md'), '# Requirements\n');
  }
  if (options.prototype != null) {
    await writeStageDecision({
      stage: 'prototype',
      outcome: 'accepted',
      documents: [],
      prototype: options.prototype,
    });
  }
  await writeStageDecision({
    stage: 'architecture',
    outcome: options.skipped === true ? 'skipped' : 'accepted',
    documents:
      options.documents === true && options.skipped !== true
        ? [{ path: 'docs/architecture.md', revision: 'b'.repeat(40) }]
        : [],
  });
  if (options.documents === true && options.skipped !== true) {
    await writeFile(path.join(worktree, 'docs/architecture.md'), '# Architecture\n');
  }
  if (options.skipped === true) {
    await writeFile(path.join(worktree, 'docs/existing.md'), '# Existing design\n');
  }
  const tasks = options.tasks ?? [
    {
      summary: 'Add the lint gate',
      scope: 'Configure the lint gate and its check.',
      completionCriteria: ['The check runs in CI.'],
      prerequisites: [],
    },
    {
      summary: 'Document the gate',
      scope: 'Extend the contribution guide.',
      completionCriteria: ['The guide names the gate.'],
      prerequisites: [0],
    },
  ];
  await writeFile(path.join(stage, 'artifacts/1/plan.json'), JSON.stringify(tasks));

  // The retained preparation checkout the first implementation continues.
  const preparationHead = '1'.repeat(40);
  const preparationBranch = options.preparationBranch ?? 'task/NEX-1';
  if (options.missingPreparation !== true) {
    await mkdir(path.join(root, 'parent'), { recursive: true });
    await writeFile(
      path.join(root, 'parent/prepared-repository.json'),
      JSON.stringify({
        repository: '/origin/repository.git',
        repositoryWorkspace: { root },
        branch: preparationBranch,
        baseRevision: '0'.repeat(40),
      }),
    );
  }
  if (options.legacyPublication !== undefined || options.legacyReview === true) {
    await mkdir(path.join(root, 'parent'), { recursive: true });
    await writeFile(
      path.join(root, 'parent/handoff.json'),
      JSON.stringify({
        stage: 'architecture',
        upstreamReturns: 0,
        feedback: null,
        return: null,
        awaitingStages: [],
        tickets: [],
        basis: null,
        publications: options.legacyPublication === undefined ? [] : [options.legacyPublication],
      }),
    );
  }
  if (options.legacyReview === true) {
    const reviews = path.join(root, 'parent/documentation-reviews');
    await mkdir(reviews, { recursive: true });
    await writeFile(path.join(reviews, `${'a'.repeat(40)}.json`), JSON.stringify({}));
  }
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(selectionFile, JSON.stringify(fixtureSelection));

  let status = options.sourceStatus ?? 'Architecture';
  const transitions: JiraTransition[] = [
    { id: '41', name: 'Finish', to: { id: '5', name: 'Done' } },
    { id: '42', name: 'Admit', to: { id: '6', name: implementationStatus } },
  ];
  /** The created tickets in creation order: their identity and retained fields. */
  const createdTickets: { id: string; key: string; fields: Record<string, unknown> }[] = [];
  const ticketStatuses = new Map<string, string>();
  const comments: JiraComment[] = [];
  const links: string[] = [];
  const ranked: string[] = [];
  const createdFields: Record<string, unknown>[] = [];
  const workspacePointers: string[] = [];
  let linkAttempts = 0;
  let createAttempts = 0;
  let rankOrder = [...(options.initialRankOrder ?? [])];
  const { jira, calls: jiraCalls } = scriptedJira({
    readIssue: (issueId) => {
      if (issueId === '1') {
        return ok({
          id: issueId,
          key: 'NEX-1',
          fields: {
            summary: 'Add a lint gate',
            description: { type: 'doc', content: [] },
            status: { id: '4', name: status },
          },
        });
      }
      const ticket = createdTickets.find((candidate) => candidate.id === issueId);
      if (ticket === undefined) {
        return { ok: false, fault: { message: `Unknown issue "${issueId}".` } };
      }
      return ok({
        id: issueId,
        key: ticket.key,
        fields: {
          ...ticket.fields,
          status: {
            id: '2',
            name: ticketStatuses.get(issueId) ?? initialTicketStatus,
          },
        },
      });
    },
    readComments: () => ok([...comments]),
    readTransitions: () => ok(transitions),
    addComment: (_issueId, body) => {
      const comment = { id: `c${String(comments.length + 1)}`, body };
      comments.push(comment);
      return ok(comment);
    },
    updateFields: (issueId, updates) => {
      if (updates.workspacePointer !== undefined && updates.workspacePointer !== null) {
        workspacePointers.push(`${issueId}:${updates.workspacePointer}`);
        const ticket = createdTickets.find((candidate) => candidate.id === issueId);
        if (ticket !== undefined) ticket.fields['workspace'] = updates.workspacePointer;
      }
      return ok(undefined);
    },
    transitionIssue: (issueId, transitionId) => {
      if (transitionId === '41') {
        status = 'Done';
      } else if (transitionId === '42') {
        ticketStatuses.set(issueId, implementationStatus);
      }
      return ok(undefined);
    },
    createIssue: (fields) => {
      createAttempts += 1;
      if (options.failCreateOnce === true && createAttempts === 1) {
        return { ok: false, fault: { message: 'the create request was rejected' } };
      }
      const number = createdTickets.length + 1;
      const identity = { id: `10${String(number)}`, key: `NEX-${String(number + 1)}` };
      createdFields.push(fields);
      createdTickets.push({
        ...identity,
        fields: {
          summary: fields['summary'],
          description: fields['description'],
          labels: fields['labels'],
          ...(number === 1 && options.firstTicketWorkspace !== undefined
            ? { workspace: options.firstTicketWorkspace }
            : {}),
        },
      });
      ticketStatuses.set(identity.id, initialTicketStatus);
      if (!rankOrder.includes(identity.key)) rankOrder.push(identity.key);
      if (options.loseCreateResponse === true && createAttempts === 1) {
        // The provider accepted the creation but its response never reached Nexus.
        return { ok: false, fault: { message: 'the response was lost' } };
      }
      return ok(identity);
    },
    linkIssues: (fromIssueId, toIssueId, linkType) => {
      linkAttempts += 1;
      if (options.failLinkOnce === true && linkAttempts === 1) {
        return { ok: false, fault: { message: 'the link could not be written' } };
      }
      links.push(`${fromIssueId}->${toIssueId} (${linkType})`);
      return ok(undefined);
    },
    rankIssue: (issueId, target) => {
      ranked.push(`${issueId} after ${'after' in target ? target.after : target.before}`);
      const ticket = createdTickets.find((candidate) => candidate.id === issueId);
      if (ticket === undefined) {
        return { ok: false, fault: { message: `Unknown issue "${issueId}".` } };
      }
      rankOrder = rankOrder.filter((candidate) => candidate !== ticket.key);
      if ('after' in target) rankOrder.splice(rankOrder.indexOf(target.after) + 1, 0, ticket.key);
      return ok(undefined);
    },
    searchIssues: (query) => {
      if (query.query.includes('labels = ')) {
        const label = /labels = "([^"]+)"$/.exec(query.query)?.[1];
        return ok(
          createdTickets
            .filter(
              (ticket) =>
                Array.isArray(ticket.fields['labels']) &&
                (ticket.fields['labels'] as readonly string[]).includes(label ?? ''),
            )
            .map((ticket) => ({ id: ticket.id, key: ticket.key })),
        );
      }
      if (query.query.includes('key in (')) {
        const keys = [...query.query.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
        return ok(
          createdTickets
            .filter((ticket) => keys.includes(ticket.key))
            .map((ticket) => ({ id: ticket.id, key: ticket.key })),
        );
      }
      return ok(
        rankOrder.map((key) => ({
          key,
          id: createdTickets.find((ticket) => ticket.key === key)?.id ?? `9${key}`,
        })),
      );
    },
  });
  const failures: string[] = [];
  const checkoutState = (head: string) =>
    repositoryState({
      remoteUrl: '/origin/repository.git',
      branch: options.checkoutBranch ?? preparationBranch,
      headRevision: head,
    });
  const { git } = scriptedGit(
    [checkoutState(preparationHead), checkoutState(options.headAfterFirst ?? preparationHead)],
    {
      readFileAtRevision: async (_repository, _revision, file) => {
        const content = await readFile(path.join(worktree, file), 'utf8');
        return ok(content);
      },
      readMergeBase: (_repository, base) =>
        ok(options.rewrittenPreparation === true ? '9'.repeat(40) : base),
    },
  );
  const handoffAction = createImplementationHandoff({
    selectionFile,
    project: 'NEX',
    workspaceRoot,
    workspacePointerField: 'workspace',
    architectureStatus: 'Architecture',
    implementation: {
      issueType: 'Task',
      labels: ['implementation'],
      status: implementationStatus,
      linkType: 'Relates',
    },
    doneStatus: 'Done',
    git,
    jira,
    publish: (event) => {
      const data = event.data as { readonly reason?: unknown };
      if (event.type === 'failed' && typeof data.reason === 'string') {
        failures.push(data.reason);
      }
    },
  });
  const firstOutcome = await handoffAction();
  if (options.ticketStatusAfterFirst !== undefined) {
    ticketStatuses.set('101', options.ticketStatusAfterFirst);
  }
  if (options.changePlanOnRetry === true) {
    await writeFile(
      path.join(stage, 'artifacts/1/plan.json'),
      JSON.stringify([{ ...(tasks[0] as object), summary: 'Changed first task' }, tasks[1]]),
    );
  }
  // A second invocation over the same retained state exercises repetition and reconciliation.
  const outcome = options.retry === true ? await handoffAction() : firstOutcome;
  // A handoff that failed before retaining identities wrote no record.
  let handoffRecord: {
    readonly tickets?: readonly {
      readonly key: string;
      readonly summary: string;
      readonly admission?: { readonly initialStatus: string; readonly completed: boolean };
    }[];
  } = {};
  try {
    handoffRecord = JSON.parse(
      await readFile(path.join(root, parentAreaDirectory, 'handoff.json'), 'utf8'),
    ) as typeof handoffRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  /** Every retained implementation input, in the plan order the issues were handed off. */
  const inputs: unknown[] = [];
  for (const ticket of handoffRecord.tickets ?? []) {
    try {
      inputs.push(
        JSON.parse(
          await readFile(
            path.join(workspaceRoot, 'NEX', ticket.key, implementationInputDeclaration.file),
            'utf8',
          ),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const files: string[] = [];
  for (const ticket of createdTickets) {
    try {
      await stat(path.join(workspaceRoot, 'NEX', ticket.key, implementationInputDeclaration.file));
      files.push(ticket.key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return {
    outcome,
    firstOutcome,
    workspaceRoot,
    ticketStatus: (index = 0) => ticketStatuses.get(createdTickets[index]?.id ?? '101'),
    tickets: handoffRecord.tickets ?? [],
    status: () => status,
    links,
    ranked,
    rankOrder,
    comments,
    createdFields,
    failures,
    jiraCalls,
    inputs,
    workspacePointers,
    files,
  };
}

describe('architecture implementation handoff', () => {
  it('creates distinct linked tickets in dependency order and closes the original', async () => {
    const handedOff = await handoff({});

    expect(handedOff.failures).toEqual([]);
    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.tickets.map((ticket) => ticket.summary)).toEqual([
      'Add the lint gate',
      'Document the gate',
    ]);
    expect(handedOff.links).toEqual(['101->1 (Relates)', '102->1 (Relates)']);
    expect(handedOff.status()).toBe('Done');
    expect(handedOff.comments).toHaveLength(1);
    expect(JSON.stringify(handedOff.comments[0]?.body)).toContain('Preparation complete');
    expect(JSON.stringify(handedOff.comments[0]?.body)).not.toContain('Documentation PR');
    // Every ticket was admitted to the configured ready status.
    expect(handedOff.ticketStatus()).toBe('To Do');
    expect(handedOff.ticketStatus(1)).toBe('To Do');
    expect(handedOff.tickets[1]?.admission).toEqual({
      initialStatus: 'To Do',
      completed: true,
    });
  });

  it('writes each ticket an implementation input and continues preparation only in the first', async () => {
    const handedOff = await handoff({});

    expect(handedOff.files).toEqual(['NEX-2', 'NEX-3']);
    expect(handedOff.workspacePointers).toEqual([
      expect.stringContaining(path.join('NEX', 'NEX-2')),
      expect.stringContaining(path.join('NEX', 'NEX-3')),
    ]);
    const [first, second] = handedOff.inputs as readonly {
      readonly sourceKey: string;
      readonly plannedTask: number;
      readonly planIdentity: string;
      readonly prerequisites: readonly {
        readonly key: string;
        readonly workspace: { readonly root: string };
      }[];
      readonly continuation: {
        readonly workspace: { readonly branch: string };
        readonly headRevision: string;
      } | null;
    }[];
    expect(first).toMatchObject({
      sourceKey: 'NEX-1',
      plannedTask: 0,
      prerequisites: [],
    });
    expect(first?.planIdentity).toBe(second?.planIdentity);
    expect(first?.continuation).toMatchObject({
      workspace: { branch: 'task/NEX-1' },
      headRevision: '1'.repeat(40),
    });
    expect(second).toMatchObject({
      plannedTask: 1,
      prerequisites: [
        {
          key: 'NEX-2',
          workspace: { root: path.join(handedOff.workspaceRoot, 'NEX', 'NEX-2') },
        },
      ],
    });
    expect(second?.continuation).toBeNull();
  });

  it('records each prerequisite ticket workspace reference in its dependents input', async () => {
    // A ticket that already records its own workspace root keeps it; its dependents name that
    // recorded reference so preparation reads the prerequisite's evidence from the same place.
    const recorded = path.join(await temporaryDirectory(), 'recorded-first-ticket');
    const handedOff = await handoff({ firstTicketWorkspace: recorded });

    expect(handedOff.outcome).toBe('handed-off');
    const second = JSON.parse(
      await readFile(
        path.join(handedOff.workspaceRoot, 'NEX', 'NEX-3', implementationInputDeclaration.file),
        'utf8',
      ),
    ) as {
      readonly prerequisites: readonly {
        readonly key: string;
        readonly workspace: { readonly root: string };
      }[];
    };
    expect(second.prerequisites).toEqual([{ key: 'NEX-2', workspace: { root: recorded } }]);
    expect(
      JSON.parse(await readFile(path.join(recorded, implementationInputDeclaration.file), 'utf8')),
    ).toMatchObject({ sourceKey: 'NEX-1', plannedTask: 0 });
  });

  it('carries the accepted document and prototype references into every ticket', async () => {
    const handedOff = await handoff({
      documents: true,
      prototype: { branch: 'task/NEX-1-prototype', revision: 'c'.repeat(40) },
    });

    expect(handedOff.failures).toEqual([]);
    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.comments).toHaveLength(1);
    const description = JSON.stringify(handedOff.createdFields[0]?.description);
    const labels = handedOff.createdFields[0]?.['labels'] as readonly string[];
    expect(description).toContain('Source: NEX-1 (planned task 1 of 2)');
    expect(description).toContain('docs/requirements.md (requirements revision ' + 'a'.repeat(40));
    expect(description).toContain('docs/architecture.md (architecture revision ' + 'b'.repeat(40));
    expect(description).toContain(
      `Retained prototype: branch task/NEX-1-prototype, revision ${'c'.repeat(40)}`,
    );
    expect(description).not.toContain('Documentation merge revision');
    // The source-side identity label ties the created ticket to its planned task.
    expect(labels).toEqual(['implementation', 'nexus-source-NEX-1-1']);
    const dependentDescription = JSON.stringify(handedOff.createdFields[1]?.description);
    expect(dependentDescription).toContain('Prerequisites: NEX-2');
  });

  it('carries concrete accepted existing-document and skip references through a no-change handoff', async () => {
    const result = await handoff({ skipped: true });
    expect(result.failures).toEqual([]);
    expect(result.outcome).toBe('handed-off');
    const description = JSON.stringify(result.createdFields[0]?.['description']);
    expect(description).toContain(
      `docs/existing.md (architecture existing document revision ${'f'.repeat(40)})`,
    );
    expect(description).toContain('architecture/artifacts/1/result.json');
    expect(description).toContain('architecture/artifacts/1/evaluation.json');
  });

  it('honors a human pause before any ticket effect', async () => {
    const result = await handoff({ sourceStatus: 'Waiting for Feedback' });
    expect(result.outcome).toBe('failed');
    expect(result.createdFields).toEqual([]);
    expect(result.comments).toEqual([]);
    expect(result.status()).toBe('Waiting for Feedback');
  });

  it('ranks a branching dependent after every prerequisite in actual source order', async () => {
    const tasks = [[], [], [0], [1, 2]].map((prerequisites, index) => ({
      summary: String.fromCharCode(65 + index),
      scope: 'bounded',
      completionCriteria: ['completed'],
      prerequisites,
    }));
    const result = await handoff({
      tasks,
      initialRankOrder: ['NEX-2', 'OTHER-9', 'NEX-4', 'NEX-5', 'NEX-3'],
    });
    expect(result.outcome).toBe('handed-off');
    expect(result.rankOrder).toEqual(['NEX-2', 'OTHER-9', 'NEX-4', 'NEX-3', 'NEX-5']);
    expect(result.ranked).toEqual(['104 after NEX-3']);
    expect(JSON.stringify(result.createdFields[3]?.['description'])).toContain(
      'Prerequisites: NEX-3, NEX-4, NEX-2',
    );
  });

  it('resolves forward prerequisite identities through topological creation and retains their planned indexes', async () => {
    const tasks = [[1], []].map((prerequisites, index) => ({
      summary: String.fromCharCode(65 + index),
      scope: 'bounded',
      completionCriteria: ['complete'],
      prerequisites,
    }));
    const result = await handoff({ tasks, retry: true });
    expect(result.outcome).toBe('handed-off');
    expect(result.createdFields.map((fields) => fields['summary'])).toEqual(['B', 'A']);
    expect(result.tickets.map((ticket) => ticket.summary)).toEqual(['A', 'B']);
    expect(JSON.stringify(result.createdFields[1]?.['description'])).toContain(
      'Prerequisites: NEX-2',
    );
    const inputs = result.inputs as readonly {
      readonly plannedTask: number;
      readonly continuation: unknown;
    }[];
    // Task B stands first in stable topological order, so it carries the preparation continuation.
    expect(inputs[1]).toMatchObject({ plannedTask: 1 });
    expect(inputs[1]?.continuation).not.toBeNull();
    expect(inputs[0]).toMatchObject({ plannedTask: 0, continuation: null });
  });

  it('rejects a cyclic dependency graph before creating tickets', async () => {
    const tasks = [[1], [0]].map((prerequisites, index) => ({
      summary: String.fromCharCode(65 + index),
      scope: 'bounded',
      completionCriteria: ['complete'],
      prerequisites,
    }));
    const result = await handoff({ tasks });
    expect(result.outcome).toBe('failed');
    expect(result.createdFields).toEqual([]);
  });

  it.each([[[1]], [[4]], [[0]], [[0, 0]]])(
    'rejects invalid or unordered prerequisite identities %j before ticket creation',
    async (prerequisites) => {
      const tasks = [
        { summary: 'A', scope: 'bounded', completionCriteria: ['complete'], prerequisites },
      ];
      const result = await handoff({ tasks });
      expect(result.outcome).toBe('failed');
      expect(result.createdFields).toEqual([]);
    },
  );

  it('finishes interrupted initial ticket admission', async () => {
    const result = await handoff({
      implementationStatus: 'Implementation',
      failLinkOnce: true,
      retry: true,
    });
    expect(result.firstOutcome).toBe('failed');
    expect(result.outcome).toBe('handed-off');
    expect(result.ticketStatus()).toBe('Implementation');
  });

  it.each(['Waiting for Feedback', 'In Progress', 'In Review'])(
    'preserves retained ticket human status %s before admission replay',
    async (humanStatus) => {
      const result = await handoff({
        implementationStatus: 'Implementation',
        failLinkOnce: true,
        retry: true,
        ticketStatusAfterFirst: humanStatus,
      });
      expect(result.outcome).toBe('failed');
      expect(result.ticketStatus()).toBe(humanStatus);
      expect(result.status()).toBe('Architecture');
      expect(result.failures.at(-1)).toContain('human status is preserved');
    },
  );

  it('preserves a human change after ticket admission has already completed', async () => {
    const result = await handoff({
      implementationStatus: 'Implementation',
      retry: true,
      ticketStatusAfterFirst: 'Waiting for Feedback',
    });
    expect(result.firstOutcome).toBe('handed-off');
    expect(result.outcome).toBe('failed');
    expect(result.ticketStatus()).toBe('Waiting for Feedback');
  });

  it('finishes a missing link for a retained ticket before handing off', async () => {
    const handedOff = await handoff({ failLinkOnce: true, retry: true });

    expect(handedOff.firstOutcome).toBe('failed');
    // Only the first attempt failed; the retry finished the missing link without another failure.
    expect(handedOff.failures).toEqual(['the link could not be written']);
    expect(handedOff.status()).toBe('Done');
    expect(handedOff.tickets.map((ticket) => ticket.summary)).toEqual([
      'Add the lint gate',
      'Document the gate',
    ]);
    // The retained identities were reused, and each ticket was linked exactly once.
    expect(handedOff.links).toEqual(['101->1 (Relates)', '102->1 (Relates)']);
  });

  it('reconciles an uncertain creation instead of duplicating the ticket', async () => {
    const handedOff = await handoff({ loseCreateResponse: true, retry: true });

    expect(handedOff.firstOutcome).toBe('failed');
    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.tickets.map((ticket) => ticket.key)).toEqual(['NEX-2', 'NEX-3']);
    expect(handedOff.links).toEqual(['101->1 (Relates)', '102->1 (Relates)']);
    // The retry searched for the planned task's source-side identity instead of creating again.
    expect(
      handedOff.jiraCalls.some((call) => call.includes('labels = "nexus-source-NEX-1-1"')),
    ).toBe(true);
  });

  it('creates no duplicate when the first create request failed outright', async () => {
    const handedOff = await handoff({ failCreateOnce: true, retry: true });

    expect(handedOff.firstOutcome).toBe('failed');
    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.tickets.map((ticket) => ticket.key)).toEqual(['NEX-2', 'NEX-3']);
    expect(handedOff.links).toEqual(['101->1 (Relates)', '102->1 (Relates)']);
  });

  it('requests attention when the retained preparation checkout is missing', async () => {
    const result = await handoff({ missingPreparation: true });
    expect(result.outcome).toBe('failed');
    expect(result.createdFields).toEqual([]);
    expect(result.failures.at(-1)).toContain('No retained preparation repository');
  });

  it('requests attention when the preparation checkout moved to another branch', async () => {
    const result = await handoff({ checkoutBranch: 'task/somewhere-else' });
    expect(result.outcome).toBe('failed');
    expect(result.createdFields).toEqual([]);
    expect(result.failures.at(-1)).toContain('reconcile it instead of selecting another branch');
  });

  it('refuses a rewritten preparation history on replay', async () => {
    const result = await handoff({
      headAfterFirst: '8'.repeat(40),
      rewrittenPreparation: true,
      retry: true,
    });
    expect(result.firstOutcome).toBe('handed-off');
    expect(result.outcome).toBe('failed');
    expect(result.failures.at(-1)).toContain('no longer in the retained branch history');
  });

  it('refuses a changed plan after the handoff froze its basis', async () => {
    const result = await handoff({ failLinkOnce: true, changePlanOnRetry: true, retry: true });
    expect(result.firstOutcome).toBe('failed');
    expect(result.outcome).toBe('failed');
    expect(result.failures.at(-1)).toContain('changed after the handoff froze its basis');
  });

  it('requires reconciliation of a retained preparation publication before new tickets', async () => {
    const result = await handoff({
      legacyPublication: {
        kind: 'documentation-pr',
        id: 'https://github.com/owner/repository/pull/7',
      },
    });

    expect(result.outcome).toBe('failed');
    expect(result.createdFields).toEqual([]);
    expect(result.comments).toEqual([]);
    expect(result.status()).toBe('Architecture');
    expect(result.failures.at(-1)).toContain('preparation-only documentation publication');
    expect(result.failures.at(-1)).toContain('https://github.com/owner/repository/pull/7');
  });

  it('requires reconciliation of a retained documentation review before new tickets', async () => {
    const result = await handoff({ legacyReview: true });

    expect(result.outcome).toBe('failed');
    expect(result.createdFields).toEqual([]);
    expect(result.comments).toEqual([]);
    expect(result.status()).toBe('Architecture');
    expect(result.failures.at(-1)).toContain('documentation review');
  });
});
