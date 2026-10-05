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
import { createJiraAdapter, type JiraComment, type JiraTransition } from '../src/adapters/jira.js';
import type { CheckObservation, GitHubReview } from '../src/adapters/github.js';
import type { CodingRuntime, CodingRuntimeRequest } from '../src/adapters/coding-runtime.js';
import { ok } from '../src/result.js';
import {
  createActionBinding,
  type ActionBindingSettings,
} from '../src/application/action-bindings.js';
import { parseNexusConfiguration, parseProjectConfiguration } from '../src/configuration/index.js';
import type { BoundAction } from '../src/task-engine/index.js';
import { createTaskEngine, type EngineEvent } from '../src/task-engine/index.js';
import { createReviewPreparationPublication } from '../src/task-engine/actions/preparation/review-publication/index.js';
import { documentationReviewsDirectory } from '../src/task-engine/actions/preparation/review-publication/artifacts.js';
import { stageAuthorArtifact } from '../src/task-engine/actions/preparation/artifacts.js';
import { createImplementationHandoff } from '../src/task-engine/actions/project/implementation-handoff/index.js';
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
import { scriptedGitHub } from './support/github.js';
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
    ReviewPreparationPublication: 'approved',
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

  it('assesses the assembled documentation inside Architecture before returning its handoff', async () => {
    const result = await runPreparation({}, 'architecture');
    expect(result.result).toEqual({ ok: true, value: 'accepted' });
    expect(result.calls.slice(-2)).toEqual(['StageResult', 'ReviewPreparationPublication']);
    const blocked = await runPreparation(
      { ReviewPreparationPublication: async () => 'failed' },
      'architecture',
    );
    expect(blocked.result).toEqual({ ok: true, value: 'blocked' });
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
    const publicationHead = 'b'.repeat(40);
    const baseRevision = 'c'.repeat(40);
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
    await writeFile(path.join(worktree, 'docs', 'architecture.md'), '# Architecture\n');
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
    // Architecture retains an accepted document with its basis, so publication reviews it.
    await mkdir(path.join(root, 'architecture', 'state'), { recursive: true });
    await writeFile(
      path.join(root, 'architecture', 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'architecture',
        round: 1,
        route: 'new',
        profiles: { author: 'nexus-astra', evaluator: 'nexus-review' },
      }),
    );
    await mkdir(path.join(root, 'architecture', 'artifacts', '1'), { recursive: true });
    const architectureAuthor = {
      stage: 'architecture',
      revision: 1,
      outcome: 'authored',
      summary: 'The architecture revision.',
      documents: [{ path: 'docs/architecture.md', description: 'the architecture' }],
      sourcePaths: [],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      findingResponses: [],
    };
    const architectureAuthorFile = path.join(root, 'architecture', 'artifacts', '1', 'author.json');
    await writeFile(architectureAuthorFile, JSON.stringify(architectureAuthor));
    await writeFile(
      path.join(root, 'architecture', 'artifacts', '1', 'evaluation.json'),
      JSON.stringify({
        basis: {
          author: { path: architectureAuthorFile },
          authorIdentity: authoredIdentity(stageAuthorArtifact.schema.parse(architectureAuthor)),
          sourceIdentity: sourceInputIdentity(selection as never),
          upstream: [],
          content: [{ path: 'docs/architecture.md', revision: contentRevision, exists: true }],
        },
        assessedRevision: 1,
        verdict: 'accepted',
        reason: 'Accepted.',
        findings: [],
        priorFindings: [],
        upstream: null,
      }),
    );
    await writeFile(
      path.join(root, 'architecture', 'artifacts', '1', 'result.json'),
      JSON.stringify({
        stage: 'architecture',
        outcome: 'accepted',
        authoredRevision: 1,
        // StageResult retains each accepted document by its absolute checkout path.
        documents: [
          { path: path.join(worktree, 'docs', 'architecture.md'), revision: contentRevision },
        ],
        sourcePaths: [],
        outputs: [],
        evaluation: { path: path.join(root, 'architecture', 'artifacts', '1', 'evaluation.json') },
        reason: 'Accepted.',
        returnStage: null,
        returnFinding: null,
        prototype: null,
      }),
    );
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
        findingResponses: [],
      },
      {
        assessedRevision: 1,
        verdict: 'accepted',
        reason: 'The revision is adequate.',
        findings: [],
        priorFindings: [],
        upstream: null,
      },
      {
        verdict: 'approved',
        summary: 'Assessed the exact assembled documentation revision.',
        findings: [],
        priorFindings: [],
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
          headRevision: publicationHead,
        }),
      ],
      {
        commitPaths: () => ok({ branch: 'task/NEX-1', headRevision: contentRevision }),
        readFileAtRevision: async (repository, _revision, file) =>
          ok(await readFile(path.join(repository, file), 'utf8')),
        fetchRevision: () => ok(baseRevision),
        readMergeBase: () => ok(baseRevision),
        readChangedPaths: () => ok(['docs/architecture.md']),
        readDiff: () => ok('diff --git a/docs/architecture.md b/docs/architecture.md'),
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
    await expect(actions['ReviewPreparationPublication']?.()).resolves.toBe('approved');

    // The real AgentRuntime appends worktree/ to the supplied area root: every provider runs in
    // the one shared preparation checkout, never in a second worktree/ level under it.
    expect(requests.map((request) => request.directory)).toEqual([worktree, worktree, worktree]);
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

/** The Architecture handoff over a controlled repository and source. */
async function handoff(options: {
  readonly documents: boolean;
  readonly prototype?: { readonly branch: string; readonly revision: string } | null;
  readonly failLinkOnce?: boolean;
  readonly loseCreateResponse?: boolean;
  readonly baseBranch?: boolean;
  readonly mergedAtAnotherRevision?: boolean;
  readonly retry?: boolean;
  readonly sourceStatus?: string;
  readonly negativeReview?: boolean;
  readonly negativeCheck?: boolean;
  readonly reviewerVerdict?: 'approved' | 'changesRequested';
  readonly retainedRemovedVerdict?: boolean;
  readonly extraPublishedPath?: string;
  readonly tasks?: readonly {
    summary: string;
    scope: string;
    completionCriteria: string[];
    prerequisites: number[];
  }[];
  readonly initialRankOrder?: readonly string[];
  readonly skipped?: boolean;
  readonly omitAssessment?: boolean;
  readonly emptyPublication?: boolean;
  readonly emptyAfterMerge?: boolean;
  readonly failPostMergeOnce?: boolean;
  readonly implementationStatus?: string;
  readonly ticketStatusAfterFirst?: string;
}): Promise<{
  readonly outcome: string;
  readonly firstOutcome: string;
  readonly ticketStatus: () => string | undefined;
  readonly tickets: readonly { readonly key: string; readonly summary: string }[];
  readonly status: () => string;
  readonly links: readonly string[];
  readonly ranked: readonly string[];
  readonly rankOrder: readonly string[];
  readonly comments: readonly JiraComment[];
  readonly committedPaths: readonly string[];
  readonly createdFields: readonly Readonly<Record<string, unknown>>[];
  readonly failures: readonly string[];
  readonly jiraCalls: readonly string[];
  readonly published: {
    readonly reviews: number;
    readonly checks: number;
    readonly autoMerge: boolean;
    readonly pullRequests: number;
  };
}> {
  const directory = await temporaryDirectory();
  const root = path.join(directory, 'NEX-1');
  const stage = stageRoot(root, 'architecture');
  const worktree = path.join(root, 'worktree');
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
    readonly sourcePaths?: readonly string[];
    readonly existing?: readonly { readonly path: string; readonly revision: string }[];
    readonly skipReferences?: readonly string[];
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
      sourcePaths: [...(settings.sourcePaths ?? [])],
      plan: [],
      skip:
        settings.outcome === 'skipped'
          ? {
              reason: 'Existing input suffices.',
              references: [...(settings.skipReferences ?? [])],
            }
          : null,
      question: null,
      upstream: null,
      findingResponses: [],
    };
    const authorFile = path.join(artifacts, 'author.json');
    await writeFile(authorFile, JSON.stringify(author));
    const content = [
      ...settings.documents
        .filter((document) => document.revision !== null)
        .map((document) => ({
          path: document.path,
          revision: document.revision as string,
          exists: true,
        })),
      ...(settings.existing ?? []).map((document) => ({
        path: document.path,
        revision: document.revision,
        exists: true,
      })),
    ];
    await writeFile(
      path.join(artifacts, 'evaluation.json'),
      JSON.stringify({
        basis: {
          author: { path: authorFile },
          authorIdentity: authoredIdentity(stageAuthorArtifact.schema.parse(author)),
          sourceIdentity: sourceInputIdentity(fixtureSelection as never),
          upstream: [...upstream],
          content,
        },
        assessedRevision: 1,
        verdict: settings.outcome === 'skipped' ? 'accepted-skip' : 'accepted',
        reason: 'Assessed the exact retained content.',
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
      existingDocuments: (settings.existing ?? []).map((document) => ({
        path: path.join(worktree, document.path),
        revision: document.revision,
      })),
      sourcePaths: [...(settings.sourcePaths ?? [])],
      skipReferences: [...(settings.skipReferences ?? [])],
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

  if (options.documents) {
    // An accepted earlier stage's changed document lives in the same shared publication.
    await writeStageDecision({
      stage: 'requirements',
      outcome: 'accepted',
      documents: [{ path: 'docs/requirements.md', revision: 'a'.repeat(40) }],
    });
    await writeFile(path.join(worktree, 'docs/requirements.md'), '# Requirements\n');
  }
  if (options.prototype !== undefined && options.prototype !== null) {
    // The Storybook Refinement stage retained a prototype revision implementation tickets reuse.
    await writeStageDecision({
      stage: 'prototype',
      outcome: 'accepted',
      documents: [],
      prototype: options.prototype,
    });
  }
  await writeStageDecision({
    stage: 'architecture',
    outcome: options.skipped ? 'skipped' : 'accepted',
    documents:
      options.documents && !options.skipped
        ? [{ path: 'docs/architecture.md', revision: 'b'.repeat(40) }]
        : [],
    existing: options.skipped ? [{ path: 'docs/existing.md', revision: 'f'.repeat(40) }] : [],
    skipReferences: options.skipped ? ['docs/existing.md'] : [],
  });
  if (options.documents && !options.skipped) {
    await writeFile(path.join(worktree, 'docs/architecture.md'), '# Architecture\n');
  }
  if (options.skipped) {
    await writeFile(path.join(worktree, 'docs/existing.md'), '# Existing design\n');
  }
  await writeFile(
    path.join(stage, 'artifacts/1/plan.json'),
    JSON.stringify(
      options.tasks ?? [
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
      ],
    ),
  );
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(selectionFile, JSON.stringify(fixtureSelection));

  let status = options.sourceStatus ?? 'Architecture';
  const transitions: JiraTransition[] = [
    { id: '41', name: 'Finish', to: { id: '5', name: 'Done' } },
    { id: '42', name: 'Admit', to: { id: '6', name: options.implementationStatus ?? 'To Do' } },
  ];
  const ticketStatuses = new Map<string, string>();
  const comments: JiraComment[] = [];
  const links: string[] = [];
  const ranked: string[] = [];
  const createdFields: Record<string, unknown>[] = [];
  let linkAttempts = 0;
  let created = 0;
  let rankOrder = [...(options.initialRankOrder ?? [])];
  const { jira, calls: jiraCalls } = scriptedJira({
    readIssue: (issueId) => {
      const index = Number(issueId.slice(2)) - 1;
      return ok({
        id: issueId,
        key: issueId === '1' ? 'NEX-1' : `NEX-${String(index + 2)}`,
        fields:
          issueId === '1'
            ? {
                summary: 'Add a lint gate',
                description: { type: 'doc', content: [] },
                status: { id: '4', name: status },
              }
            : {
                ...createdFields[index],
                status: { id: '2', name: ticketStatuses.get(issueId) ?? 'To Do' },
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
    updateFields: () => ok(undefined),
    transitionIssue: (issueId, transitionId) => {
      if (transitionId === '41') {
        status = 'Done';
      } else if (transitionId === '42') {
        ticketStatuses.set(issueId, options.implementationStatus ?? 'To Do');
      }
      return ok(undefined);
    },
    createIssue: (fields) => {
      createdFields.push(fields);
      const newKey = `NEX-${String(created + 2)}`;
      if (!rankOrder.includes(newKey)) rankOrder.push(newKey);
      if (options.loseCreateResponse && created === 0) {
        // The provider accepted the creation but its response never reached Nexus.
        created += 1;
        return { ok: false, fault: { message: 'the response was lost' } };
      }
      created += 1;
      return ok({ id: `10${String(created)}`, key: `NEX-${String(created + 1)}` });
    },
    searchIssues: (query) => {
      if (!query.query.includes('labels =')) {
        return ok(
          rankOrder
            .filter((key) => key.startsWith('OTHER-') || Number(key.split('-')[1]) <= created + 1)
            .map((key) => ({ key, id: `10${String(Number(key.split('-')[1]) - 1)}` })),
        );
      }
      if (query.query.includes('summary ='))
        throw new Error('Summary equality is not supported by JQL');
      // Only the planned task whose source-side identity the query names is reconciled.
      const label = /labels = "([^"]+)"$/.exec(query.query)?.[1];
      const matches = createdFields.flatMap((fields, index) =>
        Array.isArray(fields.labels) && fields.labels.includes(label)
          ? [{ id: `10${String(index + 1)}`, key: `NEX-${String(index + 2)}` }]
          : [],
      );
      return ok(matches);
    },
    linkIssues: (fromIssueId, toIssueId, linkType) => {
      linkAttempts += 1;
      if (options.failLinkOnce && linkAttempts === 1) {
        return { ok: false, fault: { message: 'the link could not be written' } };
      }
      links.push(`${fromIssueId}->${toIssueId} (${linkType})`);
      return ok(undefined);
    },
    rankIssue: (issueId, target) => {
      ranked.push(`${issueId} after ${'after' in target ? target.after : target.before}`);
      const key = `NEX-${String(Number(issueId.slice(2)) + 1)}`;
      rankOrder = rankOrder.filter((candidate) => candidate !== key);
      if ('after' in target) rankOrder.splice(rankOrder.indexOf(target.after) + 1, 0, key);
      return ok(undefined);
    },
  });
  const committedPaths: string[] = [];
  const failures: string[] = [];
  const head = '2'.repeat(40);
  const mergeRevision = '3'.repeat(40);
  const { git } = scriptedGit(
    [
      repositoryState({
        branch: options.baseBranch ? 'main' : 'task/NEX-1-architecture',
        headRevision: head,
        trackedChanges: true,
      }),
    ],
    {
      readFileAtRevision: async (_repository, _revision, file) =>
        ok(await readFile(path.join(worktree, file), 'utf8')),
      fetchRevision: () => ok('1'.repeat(40)),
      readMergeBase: () => ok('1'.repeat(40)),
      readChangedPaths: () =>
        options.emptyPublication || (options.emptyAfterMerge && merged)
          ? ok([])
          : ok([
              'docs/architecture.md',
              'docs/requirements.md',
              ...(options.extraPublishedPath ? [options.extraPublishedPath] : []),
            ]),
      readDiff: () =>
        ok('diff --git a/docs/architecture.md b/docs/architecture.md\n+Accepted architecture'),
      commitPaths: (_repository, paths) => {
        committedPaths.push(...paths);
        return ok({ branch: 'task/NEX-1-architecture', headRevision: head });
      },
      pushBranch: () => ok({ branch: 'task/NEX-1-architecture', headRevision: head }),
    },
  );
  let merged = false;
  let autoMerge = false;
  let pullRequests = 0;
  const reviews: GitHubReview[] = options.negativeReview
    ? [
        {
          id: 1,
          author: 'nexus-lens',
          commit_id: head,
          state: 'CHANGES_REQUESTED',
          body: 'Repair inconsistent requirements.',
        },
      ]
    : [];
  const checks: CheckObservation[] = options.negativeCheck
    ? [
        {
          id: 1,
          revision: head,
          name: 'Nexus Lens review',
          producer: { id: 777, slug: null, name: 'Nexus Lens' },
          status: 'completed',
          conclusion: 'failure',
        },
      ]
    : [];
  const pullRequestUrl = 'https://github.com/owner/repository/pull/9';
  const pullRequestState = () => ({
    number: 9,
    url: pullRequestUrl,
    state: merged ? ('closed' as const) : ('open' as const),
    merged,
    headBranch: 'task/NEX-1-architecture',
    baseBranch: 'main',
    headRevision: options.mergedAtAnotherRevision ? 'e'.repeat(40) : head,
    mergeRevision: merged ? mergeRevision : null,
    autoMergeEnabled: autoMerge,
  });
  let postMergeObservations = 0;
  const { github } = scriptedGitHub({
    findPullRequests: () => ok(pullRequests > 0 ? [{ number: 9, url: pullRequestUrl }] : []),
    createPullRequest: () => {
      pullRequests += 1;
      return ok({ number: 9, url: pullRequestUrl, headRevision: head });
    },
    readPullRequest: () => ok(pullRequestState()),
    readConversation: () => ok({ comments: [], reviews: [...reviews], reviewComments: [] }),
    publishReview: (_repository, review) => {
      reviews.push({
        id: reviews.length + 1,
        state: 'APPROVED',
        body: review.body,
        commit_id: review.revision,
        author: 'nexus-lens',
      });
      return ok({ id: reviews.length, url: `${pullRequestUrl}#review` });
    },
    readChecks: () => ok([...checks]),
    publishReviewCheck: (_repository, publication) => {
      checks.push({
        id: checks.length + 1,
        revision: publication.revision,
        name: publication.name,
        producer: { id: 777, slug: null, name: 'Nexus Lens' },
        status: 'completed',
        conclusion: publication.result,
      });
      return ok({ id: checks.length });
    },
    requestAutoMerge: () => {
      autoMerge = true;
      merged = true;
      return ok(undefined);
    },
    readRequiredChecks: () =>
      ok({
        revision: head,
        checks: [
          {
            name: 'Nexus Lens review',
            status: 'completed',
            conclusion: 'success',
            evidenceUrl: `${pullRequestUrl}#checks`,
          },
        ],
      }),
    readWorkflowRuns: (_repository, revision) => {
      postMergeObservations += 1;
      return ok([
        {
          id: 5,
          name: 'validate.yml',
          path: 'validate.yml',
          revision,
          status: 'completed',
          conclusion:
            options.failPostMergeOnce && postMergeObservations === 1 ? 'failure' : 'success',
          jobs: [],
        },
      ]);
    },
  });
  // Reconciliation and rank searches pass through the actual adapter request. The controlled
  // transport enforces Jira's supported Summary operators rather than accepting summary equality.
  const protocolJira = createJiraAdapter(
    {
      connection: { apiBase: 'https://jira.example.test', apiToken: 'test-token' },
      project: 'NEX',
      fields: { workspacePointer: 'workspace', pullRequest: 'pr' },
    },
    async (request) => {
      const body = JSON.parse(request.body ?? '{}') as { jql: string };
      expect(body.jql).not.toMatch(/summary\s*=/i);
      expect(body.jql).toMatch(/ORDER BY Rank ASC$/i);
      const found = await jira.searchIssues({
        query: body.jql.replace(/ ORDER BY Rank ASC$/i, ''),
        orderBy: 'Rank ASC',
      });
      return found.ok
        ? { status: 200, body: JSON.stringify({ issues: found.value, isLast: true }) }
        : { status: 400, body: JSON.stringify({ errorMessages: [found.fault.message] }) };
    },
  );
  const handoffAction = createImplementationHandoff({
    selectionFile,
    project: 'NEX',
    repository: 'owner/repository',
    baseBranch: 'main',
    reviewCheck: 'Nexus Lens review',
    nexusLens: { appId: 777, login: 'nexus-lens' },
    postMergeChecks: [{ name: 'validate', workflow: 'validate.yml' }],
    architectureStatus: 'Architecture',
    implementation: {
      issueType: 'Task',
      labels: ['implementation'],
      status: options.implementationStatus ?? 'To Do',
      linkType: 'Relates',
    },
    doneStatus: 'Done',
    completion: { pollIntervalSeconds: 1, waitLimitSeconds: 30 },
    git,
    github,
    jira: { ...jira, searchIssues: protocolJira.searchIssues },
    publish: (event) => {
      const data = event.data as { readonly reason?: unknown };
      if (event.type === 'failed' && typeof data.reason === 'string') {
        failures.push(data.reason);
      }
    },
    wait: () => Promise.resolve(),
  });
  if (
    options.documents &&
    (options.sourceStatus === undefined || options.sourceStatus === 'Architecture') &&
    !options.baseBranch &&
    !options.extraPublishedPath &&
    !options.omitAssessment
  ) {
    if (options.retainedRemovedVerdict === true) {
      // A retained assessment carrying the removed verdict is not an approval, a rejection or an
      // absent report; its read fails validation instead of being translated.
      const reportFile = path.join(root, documentationReviewsDirectory, `${head}.json`);
      await mkdir(path.dirname(reportFile), { recursive: true });
      await writeFile(
        reportFile,
        `${JSON.stringify(
          {
            profile: 'nexus-astra',
            headRevision: head,
            verdict: 'inconclusive',
            summary: 'The available evidence could not settle the assessment.',
            findings: [],
            priorFindings: [],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
    await createReviewPreparationPublication({
      selectionFile,
      baseBranch: 'main',
      git,
      reviewerProfile: 'nexus-astra',
      reviewer: {
        run: async () =>
          ok({
            output: JSON.stringify({
              verdict: options.reviewerVerdict ?? 'approved',
              summary: 'Assessed the exact assembled documentation revision.',
              findings:
                options.reviewerVerdict === 'changesRequested'
                  ? [
                      {
                        id: 'NEX-1-doc-finding-1',
                        title: 'The publication contradicts the accepted requirements',
                        severity: 'blocking',
                        basis: 'The publication must match the accepted requirements revision.',
                        evidence: 'The Architecture document restates a rejected requirement.',
                        impact: 'Implementation tickets would be created from a contradiction.',
                        repairGuidance:
                          'Align the Architecture document with the accepted requirement.',
                        locations: [{ path: 'docs/architecture.md', line: 1 }],
                      },
                    ]
                  : [],
              priorFindings: [],
            }),
          }),
      },
      publish: () => undefined,
    })();
    committedPaths.length = 0; // Count the parent publication commit request separately.
  }
  const firstOutcome = await handoffAction();
  if (options.ticketStatusAfterFirst) ticketStatuses.set('101', options.ticketStatusAfterFirst);
  // A second invocation over the same retained state exercises repetition and reconciliation.
  const outcome = options.retry === true ? await handoffAction() : firstOutcome;
  // A handoff that failed before retaining identities wrote no record.
  let handoffRecord: {
    readonly tickets?: readonly { readonly key: string; readonly summary: string }[];
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
  return {
    outcome,
    firstOutcome,
    ticketStatus: () => ticketStatuses.get('101'),
    tickets: handoffRecord.tickets ?? [],
    status: () => status,
    links,
    ranked,
    rankOrder,
    comments,
    committedPaths,
    createdFields,
    failures,
    jiraCalls,
    published: { reviews: reviews.length, checks: checks.length, autoMerge, pullRequests },
  };
}

describe('architecture implementation handoff', () => {
  it('creates the linked tickets, ranks the dependent and closes the original', async () => {
    const handedOff = await handoff({ documents: false });

    expect(handedOff.failures).toEqual([]);
    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.tickets.map((ticket) => ticket.summary)).toEqual([
      'Add the lint gate',
      'Document the gate',
    ]);
    expect(handedOff.links).toEqual(['101->1 (Relates)', '102->1 (Relates)']);
    expect(handedOff.status()).toBe('Done');
    expect(handedOff.comments).toHaveLength(1);
    // A skip whose only output is the implementation plan publishes no empty documentation PR.
    expect(handedOff.committedPaths).toEqual([]);
    expect(handedOff.published.reviews).toBe(0);
    expect(handedOff.published.checks).toBe(0);
    expect(handedOff.published.pullRequests).toBe(0);
  });

  it('publishes changed documents as a documentation-only pull request first', async () => {
    const handedOff = await handoff({ documents: true });

    expect(handedOff.failures).toEqual([]);
    // The PR merged with its required checks before any ticket was created and linked.
    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.tickets).toHaveLength(2);
    expect(handedOff.status()).toBe('Done');
  });

  it('publishes the accepted document set of every stage from the shared branch', async () => {
    const handedOff = await handoff({ documents: true });

    // The requirements stage's changed document is published together with the architecture one,
    // and the shared branch already carries exactly the accepted set: the publication commits no
    // second copy and never absorbs the whole worktree.
    expect(handedOff.committedPaths).toEqual([]);
    expect(handedOff.failures).toEqual([]);
    expect(handedOff.published.reviews).toBe(1);
    expect(handedOff.published.checks).toBe(1);
    expect(handedOff.published.autoMerge).toBe(true);
  });

  it('carries the merged revision and the retained prototype into every ticket', async () => {
    const handedOff = await handoff({
      documents: true,
      prototype: { branch: 'task/NEX-1-prototype', revision: 'c'.repeat(40) },
    });

    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.comments).toHaveLength(1);
    const description = JSON.stringify(handedOff.createdFields[0]?.description);
    const labels = handedOff.createdFields[0]?.labels as readonly string[];
    expect(description).toContain('Source: NEX-1 (planned task 1 of 2)');
    expect(description).toContain('docs/requirements.md (requirements revision ' + 'a'.repeat(40));
    expect(description).toContain('docs/architecture.md (architecture revision ' + 'b'.repeat(40));
    expect(description).toContain(`Documentation merge revision: ${'3'.repeat(40)}`);
    expect(description).toContain(
      `Retained prototype: branch task/NEX-1-prototype, revision ${'c'.repeat(40)}`,
    );
    // The source-side identity label ties the created ticket to its planned task.
    expect(labels).toEqual(['implementation', 'nexus-source-NEX-1-1']);
    const dependentDescription = JSON.stringify(handedOff.createdFields[1]?.description);
    expect(dependentDescription).toContain('Prerequisites: NEX-2');
  });

  it('refuses to publish from the configured base branch', async () => {
    const handedOff = await handoff({ documents: true, baseBranch: true });

    expect(handedOff.outcome).toBe('failed');
    expect(handedOff.tickets).toHaveLength(0);
    expect(handedOff.status()).toBe('Architecture');
  });

  it('does not transfer a merge observed at another revision', async () => {
    const handedOff = await handoff({ documents: true, mergedAtAnotherRevision: true });

    expect(handedOff.outcome).toBe('failed');
    expect(handedOff.tickets).toHaveLength(0);
    expect(handedOff.status()).toBe('Architecture');
  });

  it('requires a saved child assessment for the published revision instead of inventing approval', async () => {
    const result = await handoff({ documents: true, omitAssessment: true });
    expect(result.outcome).toBe('failed');
    expect(result.published.reviews).toBe(0);
    expect(result.published.checks).toBe(0);
    expect(result.published.autoMerge).toBe(false);
    expect(result.createdFields).toEqual([]);
    expect(result.failures[0]).toContain('no retained Architecture-child review');
  });

  it.each(['negativeReview', 'negativeCheck'] as const)(
    'preserves %s for the publication head instead of manufacturing approval',
    async (negative) => {
      const result = await handoff({ documents: true, [negative]: true });
      expect(result.outcome).toBe('failed');
      expect(result.createdFields).toEqual([]);
      expect(result.published.autoMerge).toBe(false);
      expect(result.published.reviews).toBe(negative === 'negativeReview' ? 1 : 0);
      expect(result.published.checks).toBe(negative === 'negativeCheck' ? 1 : 0);
      expect(result.failures[0]).toContain('negative review evidence');
    },
  );

  it('preserves a changes-requested documentation assessment without authorizing merge or tickets', async () => {
    const result = await handoff({ documents: true, reviewerVerdict: 'changesRequested' });
    expect(result.outcome).toBe('failed');
    expect(result.published.reviews).toBe(1);
    expect(result.published.checks).toBe(1);
    expect(result.published.autoMerge).toBe(false);
    expect(result.createdFields).toEqual([]);
    expect(result.failures[0]).toContain('Documentation review changesRequested');
  });

  it('fails a retained documentation review carrying the removed inconclusive verdict', async () => {
    await expect(handoff({ documents: true, retainedRemovedVerdict: true })).rejects.toThrow(
      /does not match its declared content type/,
    );
  });

  it('checks the whole publication diff for previously committed unrelated paths', async () => {
    const result = await handoff({ documents: true, extraPublishedPath: 'code.js' });
    expect(result.outcome).toBe('failed');
    expect(result.published.pullRequests).toBe(0);
    expect(result.createdFields).toEqual([]);
  });

  it.each([false, true])(
    'honors a human pause before documentation or ticket effects (documents=%s)',
    async (documents) => {
      const result = await handoff({ documents, sourceStatus: 'Waiting for Feedback' });
      expect(result.outcome).toBe('failed');
      expect(result.committedPaths).toEqual([]);
      expect(result.createdFields).toEqual([]);
      expect(result.published.pullRequests).toBe(0);
      expect(result.status()).toBe('Waiting for Feedback');
    },
  );

  it('carries concrete accepted existing-document and skip references through a no-change handoff', async () => {
    const result = await handoff({ documents: false, skipped: true });
    expect(result.outcome).toBe('handed-off');
    const description = JSON.stringify(result.createdFields[0]?.description);
    expect(description).toContain(
      `docs/existing.md (architecture existing document revision ${'f'.repeat(40)})`,
    );
    expect(description).toContain('architecture/artifacts/1/result.json');
    expect(description).toContain('architecture/artifacts/1/evaluation.json');
    expect(result.published.pullRequests).toBe(0);
  });

  it('ranks a branching dependent after every prerequisite in actual source order', async () => {
    const tasks = [[], [], [0], [1, 2]].map((prerequisites, index) => ({
      summary: String.fromCharCode(65 + index),
      scope: 'bounded',
      completionCriteria: ['completed'],
      prerequisites,
    }));
    const result = await handoff({
      documents: false,
      tasks,
      initialRankOrder: ['NEX-2', 'OTHER-9', 'NEX-4', 'NEX-5', 'NEX-3'],
    });
    expect(result.outcome).toBe('handed-off');
    expect(result.rankOrder).toEqual(['NEX-2', 'OTHER-9', 'NEX-4', 'NEX-3', 'NEX-5']);
    expect(result.ranked).toEqual(['104 after NEX-3']);
    expect(JSON.stringify(result.createdFields[3]?.description)).toContain(
      'Prerequisites: NEX-3, NEX-4',
    );
  });

  it('resolves forward prerequisite identities through topological creation and retains their planned indexes', async () => {
    const tasks = [[1], []].map((prerequisites, index) => ({
      summary: String.fromCharCode(65 + index),
      scope: 'bounded',
      completionCriteria: ['complete'],
      prerequisites,
    }));
    const result = await handoff({ documents: false, tasks, retry: true });
    expect(result.outcome).toBe('handed-off');
    expect(result.createdFields.map((fields) => fields.summary)).toEqual(['B', 'A']);
    expect(result.tickets.map((ticket) => ticket.summary)).toEqual(['A', 'B']);
    expect(JSON.stringify(result.createdFields[1]?.description)).toContain('Prerequisites: NEX-2');
  });

  it('rejects a cyclic dependency graph before publication or ticket creation', async () => {
    const tasks = [[1], [0]].map((prerequisites, index) => ({
      summary: String.fromCharCode(65 + index),
      scope: 'bounded',
      completionCriteria: ['complete'],
      prerequisites,
    }));
    const result = await handoff({ documents: true, tasks });
    expect(result.outcome).toBe('failed');
    expect(result.committedPaths).toEqual([]);
    expect(result.createdFields).toEqual([]);
  });

  it.each([[[1]], [[4]], [[0]], [[0, 0]]])(
    'rejects invalid or unordered prerequisite identities %j before publication',
    async (prerequisites) => {
      const tasks = [
        { summary: 'A', scope: 'bounded', completionCriteria: ['complete'], prerequisites },
      ];
      const result = await handoff({ documents: true, tasks });
      expect(result.outcome).toBe('failed');
      expect(result.committedPaths).toEqual([]);
      expect(result.createdFields).toEqual([]);
    },
  );

  it('hands off accepted references without publishing an empty documentation diff', async () => {
    const result = await handoff({ documents: true, emptyPublication: true });
    expect(result.outcome).toBe('handed-off');
    expect(result.published).toEqual({ reviews: 0, checks: 0, autoMerge: false, pullRequests: 0 });
    expect(JSON.stringify(result.createdFields)).toContain('docs/requirements.md');
  });

  it('finishes an existing publication’s checks when the merge has made the diff empty', async () => {
    const result = await handoff({
      documents: true,
      emptyAfterMerge: true,
      failPostMergeOnce: true,
      retry: true,
    });
    expect(result.firstOutcome).toBe('failed');
    expect(result.outcome).toBe('handed-off');
    expect(result.published.pullRequests).toBe(1);
    expect(JSON.stringify(result.createdFields)).toContain(
      `Documentation merge revision: ${'3'.repeat(40)}`,
    );
    expect(result.failures).toEqual([expect.stringContaining('post-merge check')]);
  });

  it('finishes interrupted initial ticket admission', async () => {
    const result = await handoff({
      documents: false,
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
        documents: false,
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
      documents: false,
      implementationStatus: 'Implementation',
      retry: true,
      ticketStatusAfterFirst: 'Waiting for Feedback',
    });
    expect(result.firstOutcome).toBe('handed-off');
    expect(result.outcome).toBe('failed');
    expect(result.ticketStatus()).toBe('Waiting for Feedback');
  });

  it('finishes a missing link for a retained ticket before handing off', async () => {
    const handedOff = await handoff({ documents: false, failLinkOnce: true, retry: true });

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
    const handedOff = await handoff({ documents: false, loseCreateResponse: true, retry: true });

    expect(handedOff.firstOutcome).toBe('failed');
    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.tickets.map((ticket) => ticket.key)).toEqual(['NEX-2', 'NEX-3']);
    expect(handedOff.links).toEqual(['101->1 (Relates)', '102->1 (Relates)']);
    // The retry searched for the planned task's source-side identity instead of creating again.
    expect(
      handedOff.jiraCalls.some(
        (call) => call.includes('labels = "nexus-source-NEX-1-1"') && !call.includes('summary ='),
      ),
    ).toBe(true);
  });
});
