/**
 * Focused integration tests: the project parent composes its invoked child machines, routes by
 * the retained stage and owns publication. The parent and child operations are supplied stubs
 * over temporary state files except where the real action under test is the subject; no live
 * service, provider or process is involved.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMachine } from 'xstate';
import type { JiraComment, JiraTransition } from '../src/adapters/jira.js';
import { ok } from '../src/result.js';
import {
  createActionBinding,
  type ActionBindingSettings,
} from '../src/application/action-bindings.js';
import { parseNexusConfiguration, parseProjectConfiguration } from '../src/configuration/index.js';
import type { BoundAction } from '../src/task-engine/index.js';
import { createTaskEngine, type EngineEvent } from '../src/task-engine/index.js';
import { createImplementationHandoff } from '../src/task-engine/actions/project/implementation-handoff/index.js';
import { createPublishPreparation } from '../src/task-engine/actions/project/publish-preparation/index.js';
import { parentAreaDirectory } from '../src/task-engine/actions/select-work/artifacts.js';
import { stageRoot } from '../src/task-engine/actions/preparation/storage.js';
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
      'SelectWork',
    ]);
    expect(states).toEqual([
      'select',
      'route',
      'requirements',
      'publishRequirements',
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
      'SelectWork',
    ]);
    expect(states).toEqual([
      'select',
      'route',
      'architecture',
      'publishArchitecture',
      'handoff',
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
});

/** The real preparation child over supplied stage operations. */
async function runPreparation(overrides: Readonly<Record<string, ActionStub>>): Promise<{
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
    input: { stage: 'ux' },
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
    const { git } = scriptedGit([], {
      cloneRepository: (source) =>
        ok({ remoteUrl: source, branch: 'main', headRevision: '1'.repeat(40) }),
    });
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
    // The ux stage area received its own worktree, not another stage's.
    await expect(
      readFile(path.join(root, 'ux', 'state', 'current-round.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(path.join(root, 'requirements', 'state', 'current-round.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/** One published preparation result over a controlled source. */
async function publishPreparation(options: {
  readonly result: Record<string, unknown>;
  readonly status: string;
}): Promise<{
  readonly outcome: string;
  readonly status: () => string;
  readonly comments: readonly JiraComment[];
  readonly calls: string[];
  readonly stage: () => string | undefined;
  readonly feedback: () => unknown;
}> {
  const directory = await temporaryDirectory();
  const root = path.join(directory, 'NEX-1');
  const stage = stageRoot(root, 'ux');
  await mkdir(path.join(stage, 'state'), { recursive: true });
  await mkdir(path.join(stage, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(stage, 'state', 'current-round.json'),
    JSON.stringify({
      stage: 'ux',
      round: 1,
      route: 'new',
      profiles: { author: 'a', evaluator: 'e' },
    }),
  );
  await writeFile(path.join(stage, 'artifacts/1/result.json'), JSON.stringify(options.result));
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

  let status = options.status;
  const comments: JiraComment[] = [];
  const transitionsByStatus: Record<string, JiraTransition[]> = {
    'UX Proposal': [
      { id: '31', name: 'Design', to: { id: '4', name: 'Storybook Refinement' } },
      { id: '32', name: 'Wait', to: { id: '5', name: 'Waiting for Feedback' } },
      { id: '33', name: 'Back to requirements', to: { id: '2', name: 'Draft' } },
    ],
    Draft: [],
    'Storybook Refinement': [],
    Architecture: [],
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

  const publish = createPublishPreparation({
    selectionFile,
    statuses: {
      requirements: 'Draft',
      uxProposal: 'UX Proposal',
      storybookRefinement: 'Storybook Refinement',
      architecture: 'Architecture',
    },
    waitingForFeedback: 'Waiting for Feedback',
    ideaSubmitted: 'Idea',
    jira,
    publish: () => undefined,
  });
  const outcome = await publish({ stage: 'ux' });
  const saved = JSON.parse(await readFile(selectionFile, 'utf8')) as {
    readonly stage: string;
  };
  const handoff = JSON.parse(
    await readFile(path.join(root, parentAreaDirectory, 'handoff.json'), 'utf8'),
  ) as { readonly feedback: unknown };
  return {
    outcome,
    status: () => status,
    comments,
    calls,
    stage: () => saved.stage,
    feedback: () => handoff.feedback,
  };
}

describe('parent preparation publication', () => {
  const accepted = {
    stage: 'ux',
    outcome: 'accepted',
    authoredRevision: 1,
    outputs: [],
    evaluation: { path: '/evaluation.json' },
    reason: 'The journey covers the acceptance examples.',
    returnStage: null,
  } as const;

  it('advances an accepted stage to its next status and stage', async () => {
    const published = await publishPreparation({ result: accepted, status: 'UX Proposal' });

    expect(published.outcome).toBe('advanced');
    expect(published.status()).toBe('Storybook Refinement');
    expect(published.stage()).toBe('prototype');
    expect(published.comments).toHaveLength(1);
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
});

/** The Architecture handoff over a controlled repository and source. */
async function handoff(options: { readonly documents: boolean }): Promise<{
  readonly outcome: string;
  readonly tickets: readonly { readonly key: string; readonly summary: string }[];
  readonly status: () => string;
  readonly links: readonly string[];
  readonly comments: readonly JiraComment[];
}> {
  const directory = await temporaryDirectory();
  const root = path.join(directory, 'NEX-1');
  const stage = stageRoot(root, 'architecture');
  await mkdir(path.join(stage, 'state'), { recursive: true });
  await mkdir(path.join(stage, 'artifacts', '1'), { recursive: true });
  await mkdir(path.join(stage, 'worktree'), { recursive: true });
  await writeFile(
    path.join(stage, 'state/current-round.json'),
    JSON.stringify({
      stage: 'architecture',
      round: 1,
      route: 'new',
      profiles: { author: 'a', evaluator: 'e' },
    }),
  );
  await writeFile(
    path.join(stage, 'artifacts/1/result.json'),
    JSON.stringify({
      stage: 'architecture',
      outcome: 'accepted',
      authoredRevision: 1,
      outputs: options.documents
        ? [{ path: path.join(stage, 'worktree', 'docs/architecture.md') }]
        : [],
      evaluation: { path: '/evaluation.json' },
      reason: 'The design and plan cover the accepted outcome.',
      returnStage: null,
    }),
  );
  await writeFile(
    path.join(stage, 'artifacts/1/plan.json'),
    JSON.stringify([
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
    ]),
  );
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: { id: '1', key: 'NEX-1', fields: {} },
      conversation: [],
      workspace: { root },
      stage: 'architecture',
    }),
  );

  let status = 'Architecture';
  const transitions: JiraTransition[] = [
    { id: '41', name: 'Finish', to: { id: '5', name: 'Done' } },
  ];
  const comments: JiraComment[] = [];
  const links: string[] = [];
  let created = 0;
  const { jira } = scriptedJira({
    readIssue: (issueId) =>
      ok({
        id: issueId,
        key: issueId === '1' ? 'NEX-1' : `NEX-${String(created + 1)}`,
        fields: {
          summary: 'Add a lint gate',
          description: { type: 'doc', content: [] },
          status: { id: '4', name: issueId === '1' ? status : 'To Do' },
        },
      }),
    readComments: () => ok([...comments]),
    readTransitions: () => ok(transitions),
    addComment: (_issueId, body) => {
      const comment = { id: `c${String(comments.length + 1)}`, body };
      comments.push(comment);
      return ok(comment);
    },
    updateFields: () => ok(undefined),
    transitionIssue: (_issueId, transitionId) => {
      if (transitionId === '41') {
        status = 'Done';
      }
      return ok(undefined);
    },
    createIssue: () => {
      created += 1;
      return ok({ id: `10${String(created)}`, key: `NEX-${String(created + 1)}` });
    },
    linkIssues: (fromIssueId, toIssueId, linkType) => {
      links.push(`${fromIssueId}->${toIssueId} (${linkType})`);
      return ok(undefined);
    },
    rankIssue: () => ok(undefined),
  });
  const { git } = scriptedGit(
    [repositoryState({ branch: 'task/NEX-1-architecture', trackedChanges: true })],
    {
      commitAll: () => ok({ branch: 'task/NEX-1-architecture', headRevision: '2'.repeat(40) }),
      pushBranch: () => ok({ branch: 'task/NEX-1-architecture', headRevision: '2'.repeat(40) }),
    },
  );
  const { github } = scriptedGitHub({
    findPullRequests: () => ok([]),
    createPullRequest: () =>
      ok({
        number: 9,
        url: 'https://github.com/owner/repository/pull/9',
        headRevision: '2'.repeat(40),
      }),
    readPullRequest: () =>
      ok({
        number: 9,
        url: 'https://github.com/owner/repository/pull/9',
        state: 'closed' as const,
        merged: true,
        headBranch: 'task/NEX-1-architecture',
        baseBranch: 'main',
        headRevision: '2'.repeat(40),
        mergeRevision: '3'.repeat(40),
        autoMergeEnabled: false,
      }),
    readRequiredChecks: () => ok({ revision: '2'.repeat(40), checks: [] }),
  });
  const handoffAction = createImplementationHandoff({
    selectionFile,
    repository: 'owner/repository',
    baseBranch: 'main',
    implementation: {
      issueType: 'Task',
      labels: ['implementation'],
      status: 'To Do',
      linkType: 'Relates',
    },
    doneStatus: 'Done',
    completion: { pollIntervalSeconds: 1, waitLimitSeconds: 30 },
    git,
    github,
    jira,
    publish: () => undefined,
    wait: () => Promise.resolve(),
  });
  const outcome = await handoffAction();
  const handoffRecord = JSON.parse(
    await readFile(path.join(root, parentAreaDirectory, 'handoff.json'), 'utf8'),
  ) as { readonly tickets: readonly { readonly key: string; readonly summary: string }[] };
  return {
    outcome,
    tickets: handoffRecord.tickets,
    status: () => status,
    links,
    comments,
  };
}

describe('architecture implementation handoff', () => {
  it('creates the linked tickets, ranks the dependent and closes the original', async () => {
    const handedOff = await handoff({ documents: false });

    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.tickets.map((ticket) => ticket.summary)).toEqual([
      'Add the lint gate',
      'Document the gate',
    ]);
    expect(handedOff.links).toEqual(['101->1 (Relates)', '102->1 (Relates)']);
    expect(handedOff.status()).toBe('Done');
    expect(handedOff.comments).toHaveLength(1);
  });

  it('publishes changed documents as a documentation-only pull request first', async () => {
    const handedOff = await handoff({ documents: true });

    // The PR merged with its required checks before any ticket was created and linked.
    expect(handedOff.outcome).toBe('handed-off');
    expect(handedOff.tickets).toHaveLength(2);
    expect(handedOff.status()).toBe('Done');
  });
});
