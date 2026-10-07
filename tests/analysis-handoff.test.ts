/**
 * Focused integration tests: Application's workflow bindings around AnalyzeExperience. They
 * establish the durable attempt identity a finite attempt records, the producer-owned reason
 * records the handoff reconstructs after a restart, the preparation attempt identity a published
 * stage or operational error names, the interrupted idea submission resolution and the capture
 * boundary that keeps a discovery failure from replacing a terminal outcome.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodingRuntime } from '../src/adapters/coding-runtime.js';
import type { GitAdapter } from '../src/adapters/git.js';
import type { GitHubAdapter } from '../src/adapters/github.js';
import type { JiraAdapter } from '../src/adapters/jira.js';
import {
  createActionBinding,
  type ActionBindingSettings,
} from '../src/application/action-bindings.js';
import {
  finiteDeliveryHandoff,
  ideaPublicationHandoff,
  operationalErrorHandoff,
  preparationHandoff,
  preparationSuccessIdentity,
} from '../src/application/analysis-handoff.js';
import type { NexusConfiguration, PreparationStage } from '../src/configuration/index.js';
import {
  experienceCaptureFile,
  experienceIdentity,
  experienceRequestFile,
  type ExperienceHandoff,
} from '../src/task-engine/actions/analyze-experience/artifacts.js';
import { createAnalyzeExperience } from '../src/task-engine/actions/analyze-experience/index.js';
import type { Selection } from '../src/task-engine/actions/select-task/artifacts.js';
import { ideaRoundPlanFile } from '../src/task-engine/actions/start-idea-round/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

const workId = 'NEX-7';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-handoff-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** Write one JSON document, creating its directory. */
async function writeJson(file: string, content: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

/** One finite-delivery selection naming the supplied workspace. */
function selectionFor(workspace: string): Selection {
  return {
    taskKey: workId,
    source: { kind: 'jira', issueId: '10518' },
    task: { id: '10518', key: workId, fields: {} },
    conversation: [],
    workspace: { root: workspace },
    stage: 'delivery',
  };
}

/** One idea-stage parent selection naming the issue root that owns the refinement area. */
function ideaSelectionFor(refinementArea: string): Selection {
  return {
    taskKey: workId,
    source: { kind: 'jira', issueId: '10518' },
    task: { id: '10518', key: workId, fields: {} },
    conversation: [],
    workspace: { root: path.dirname(refinementArea) },
    stage: 'idea',
  };
}

/** One preparation-stage selection naming the issue root that owns the stage area. */
function preparationSelectionFor(workspace: string, stage: PreparationStage): Selection {
  return {
    taskKey: workId,
    source: { kind: 'jira', issueId: '10518' },
    task: { id: '10518', key: workId, fields: {} },
    conversation: [],
    workspace: { root: workspace },
    stage,
  };
}

/**
 * Write one preparation stage area: its attempt identity when the record exists, and an open round
 * with the round's retained terminal result when a numbered round exists.
 */
async function writeStageArea(options: {
  readonly workspace: string;
  readonly stage: PreparationStage;
  readonly attemptId: string | null;
  readonly round: number | null;
}): Promise<void> {
  const root = path.join(options.workspace, options.stage);
  if (options.attemptId !== null) {
    await writeJson(path.join(root, 'state', 'attempt.json'), { attemptId: options.attemptId });
  }
  if (options.round !== null) {
    await writeJson(path.join(root, 'state', 'current-round.json'), {
      stage: options.stage,
      round: options.round,
      route: 'next',
      profiles: { author: 'nexus-flash', evaluator: 'nexus-sol' },
    });
    await writeJson(path.join(root, 'artifacts', String(options.round), 'result.json'), {
      stage: options.stage,
      outcome: 'accepted',
      authoredRevision: options.round,
      documents: [],
      outputs: [],
      evaluation: {
        path: path.join(root, 'artifacts', String(options.round), 'evaluation.json'),
      },
      reason: null,
      returnStage: null,
      returnFinding: null,
    });
  }
}

/** Enable the capture path of one Nexus configuration over the test's unreachable service. */
function enableMemory(nexus: NexusConfiguration): void {
  nexus.memory = {
    enabled: true,
    serviceUrl: 'http://127.0.0.1:1',
    mcp: { command: 'npm', args: ['run', '--silent', 'mcp'], directory: './agentic-memory' },
    analysisProfile: 'nexus-astra',
  };
}

describe('terminal handoffs', () => {
  it('names the attempt identity PrepareWorkspace retained, and a fresh attempt carries a new one', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeJson(path.join(workspace, 'state', 'attempt.json'), { attemptId: 'attempt-one' });

    const first = await finiteDeliveryHandoff({
      selection: selectionFor(workspace),
      terminal: 'prepare-failed',
    });
    expect(first.attemptId).toBe('attempt-one');

    // A fresh attempt's state directory carries its own identity, even on the same branch name.
    await writeJson(path.join(workspace, 'state', 'attempt.json'), { attemptId: 'attempt-two' });
    const second = await finiteDeliveryHandoff({
      selection: selectionFor(workspace),
      terminal: 'prepare-failed',
    });
    expect(second.attemptId).toBe('attempt-two');
    expect(second.attemptId).not.toBe(first.attemptId);
  });

  it('reads the reason its producer retained, and the reason survives a rebuilt binding', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    const failure = 'The repository condition prevents preparation.';
    await writeJson(path.join(workspace, 'state', 'preparation-failure.json'), {
      reason: failure,
    });

    // A rebuilt binding holds no memory of the producer's event; the record still states the reason.
    const handoff = await finiteDeliveryHandoff({
      selection: selectionFor(workspace),
      terminal: 'prepare-failed',
    });

    expect(handoff.reason).toBe(failure);
    expect(handoff.artifacts.map((artifact) => artifact.path)).toContain(
      path.join(workspace, 'state', 'preparation-failure.json'),
    );
  });

  it('reads the reason a round-scoped producer retained for its failed outcome', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    const failure = 'The approved head is not merged and the completion wait expired.';
    await writeJson(path.join(workspace, 'state', 'current-round.json'), {
      number: 2,
      profile: 'nexus-flash',
      reason: 'the repair round',
    });
    await writeJson(path.join(workspace, 'artifacts', '2', 'completion-failure.json'), {
      reason: failure,
    });

    const handoff = await finiteDeliveryHandoff({
      selection: selectionFor(workspace),
      terminal: 'complete-failed',
    });

    expect(handoff.reason).toBe(failure);
    expect(handoff.artifacts.map((artifact) => artifact.path)).toContain(
      path.join(workspace, 'artifacts', '2', 'completion-failure.json'),
    );
  });

  it('selects the Markdown report one retained producer outcome binds', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeJson(path.join(workspace, 'state', 'current-round.json'), {
      number: 1,
      profile: 'nexus-flash',
      reason: 'the implementation round',
    });
    // The producer's outcome is retained inside the round; the Markdown it binds sits outside
    // the area the round scan selects, so only its exported report declaration names it.
    const report = path.join(workspace, 'reports', 'invocation-1', 'developer.md');
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, 'The developer recorded its verification here.\n', 'utf8');
    await writeJson(path.join(workspace, 'artifacts', '1', 'development.json'), {
      taskKey: workId,
      status: 'completed',
      report: { path: report },
      // A retained record's former Markdown-byte hash is obsolete data; the report path binds it.
      reportIdentity: 'a'.repeat(64),
      invocationId: 'invocation-1',
    });

    const handoff = await finiteDeliveryHandoff({
      selection: selectionFor(workspace),
      terminal: 'deliver-failed',
    });

    const evidence = handoff.artifacts.map((artifact) => artifact.path);
    // The outcome stays selected at its original path with its original bytes.
    expect(evidence).toContain(path.join(workspace, 'artifacts', '1', 'development.json'));
    // The associated Markdown is selected with it, so capture retains the narrative too.
    expect(evidence).toContain(report);
  });

  it('retains the earlier rounds of the attempt as the handoff history', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeJson(path.join(workspace, 'state', 'current-round.json'), {
      number: 2,
      profile: 'nexus-flash',
      reason: 'the repair round',
    });
    await writeJson(path.join(workspace, 'artifacts', '1', 'development.json'), { round: 1 });
    await writeJson(path.join(workspace, 'artifacts', '2', 'development.json'), { round: 2 });

    const handoff = await finiteDeliveryHandoff({
      selection: selectionFor(workspace),
      terminal: 'deliver-failed',
    });

    const evidence = handoff.artifacts.map((artifact) => artifact.path);
    expect(evidence).toContain(path.join(workspace, 'artifacts', '1', 'development.json'));
    expect(evidence).toContain(path.join(workspace, 'artifacts', '2', 'development.json'));
  });

  it('attributes a partially initialized idea submission to the interrupted submission', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'refinement');
    await writeJson(path.join(workspace, ideaRoundPlanFile), {
      submission: 1,
      cycle: 1,
      route: 'next',
      profiles: { 'idea-editor': 'nexus-astra' },
    });
    await writeJson(path.join(workspace, 'artifacts', 'submissions', '1', 'input.json'), {
      taskKey: workId,
    });
    await writeJson(path.join(workspace, 'artifacts', 'submissions', '1', 'decision.json'), {
      decision: 'approved',
    });
    // StartIdeaRound wrote the next submission's input before replacing the retained plan.
    await writeJson(path.join(workspace, 'artifacts', 'submissions', '2', 'input.json'), {
      taskKey: workId,
    });
    const selection = ideaSelectionFor(workspace);

    const handoff = await ideaPublicationHandoff({ selection, terminal: 'idea-approved' });
    const operational = await operationalErrorHandoff({
      selection,
      failure: 'the worker stopped',
    });

    expect(handoff.attemptId).toBe('submission-2');
    expect(handoff.artifacts.map((artifact) => artifact.path)).toEqual([
      path.join(workspace, 'artifacts', 'submissions', '2', 'input.json'),
    ]);
    expect(operational.attemptId).toBe('submission-2');
    expect(operational.artifacts.map((artifact) => artifact.path)).toEqual([
      path.join(workspace, 'artifacts', 'submissions', '2', 'input.json'),
    ]);
  });

  it('carries the idea publication outcome and its retained submission artifacts', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'refinement');
    await writeJson(path.join(workspace, 'artifacts', 'submissions', '1', 'input.json'), {
      taskKey: workId,
    });
    await writeJson(path.join(workspace, 'artifacts', 'submissions', '1', 'decision.json'), {
      decision: 'attempts-exhausted',
    });

    const handoff = await ideaPublicationHandoff({
      selection: ideaSelectionFor(workspace),
      terminal: 'idea-feedback',
    });

    expect(handoff.outcome).toBe('waiting-for-feedback');
    expect(handoff.workflow).toBe('idea-refinement');
    expect(handoff.artifacts.map((artifact) => artifact.path)).toEqual([
      path.join(workspace, 'artifacts', 'submissions', '1', 'decision.json'),
      path.join(workspace, 'artifacts', 'submissions', '1', 'input.json'),
    ]);
  });
});

describe('preparation attempt identities', () => {
  it('derives the final success identity from the retained attempt, stage and round', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeStageArea({ workspace, stage: 'architecture', attemptId: 'attempt-one', round: 2 });

    const handoff = await preparationHandoff({
      selection: preparationSelectionFor(workspace, 'architecture'),
      terminal: 'preparation-handoff',
      stage: 'architecture',
    });

    expect(handoff).toMatchObject({
      workId,
      workflow: 'preparation',
      attemptId: 'attempt-one:architecture:round-2',
      terminalId: 'preparation-handoff',
      outcome: 'handed-off',
    });

    // The identity derivation the binding replays for the final success is the same one.
    expect(
      await preparationSuccessIdentity({
        selection: preparationSelectionFor(workspace, 'architecture'),
        stage: 'architecture',
      }),
    ).toEqual({
      workId,
      workflow: 'preparation',
      attemptId: handoff.attemptId,
      terminalId: 'preparation-handoff',
    });

    // The publication/handoff failures share the attempt's derivation.
    const publicationFailed = await preparationHandoff({
      selection: preparationSelectionFor(workspace, 'architecture'),
      terminal: 'preparation-publication-failed',
      stage: 'architecture',
    });
    const handoffFailed = await preparationHandoff({
      selection: preparationSelectionFor(workspace, 'architecture'),
      terminal: 'handoff-failed',
      stage: 'architecture',
    });
    expect(publicationFailed.attemptId).toBe(handoff.attemptId);
    expect(handoffFailed.attemptId).toBe(handoff.attemptId);
  });

  it('gives a fresh attempt a distinct request identity for a repeated stage, round and terminal', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeStageArea({ workspace, stage: 'ux', attemptId: 'attempt-one', round: 2 });
    const selection = preparationSelectionFor(workspace, 'ux');

    const first = await preparationHandoff({
      selection,
      terminal: 'preparation-waiting',
      stage: 'ux',
    });
    // Reconstructing the retained attempt's handoff after a restart reuses its request identity.
    const replay = await preparationHandoff({
      selection,
      terminal: 'preparation-waiting',
      stage: 'ux',
    });
    expect(experienceIdentity(replay)).toBe(experienceIdentity(first));

    // A fresh attempt repeats the ticket, stage, round and terminal yet forms its own request.
    await writeJson(path.join(workspace, 'ux', 'state', 'attempt.json'), {
      attemptId: 'attempt-two',
    });
    const fresh = await preparationHandoff({
      selection,
      terminal: 'preparation-waiting',
      stage: 'ux',
    });

    expect(fresh.attemptId).toBe('attempt-two:ux:round-2');
    expect(experienceIdentity(fresh)).not.toBe(experienceIdentity(first));
  });

  it('distinguishes a failure before a numbered round for each attempt', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeStageArea({
      workspace,
      stage: 'requirements',
      attemptId: 'attempt-one',
      round: null,
    });
    const selection = preparationSelectionFor(workspace, 'requirements');

    const first = await preparationHandoff({
      selection,
      terminal: 'preparation-failed',
      stage: 'requirements',
    });
    await writeJson(path.join(workspace, 'requirements', 'state', 'attempt.json'), {
      attemptId: 'attempt-two',
    });
    const second = await preparationHandoff({
      selection,
      terminal: 'preparation-failed',
      stage: 'requirements',
    });

    expect(first.attemptId).toBe('attempt-one:requirements:no-round');
    expect(second.attemptId).toBe('attempt-two:requirements:no-round');
    expect(experienceIdentity(second)).not.toBe(experienceIdentity(first));
  });

  it('keeps the former identities for a pre-upgrade area with retained current-attempt state', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeStageArea({ workspace, stage: 'ux', attemptId: null, round: 2 });
    const selection = preparationSelectionFor(workspace, 'ux');

    const terminal = await preparationHandoff({
      selection,
      terminal: 'preparation-waiting',
      stage: 'ux',
    });
    const error = await operationalErrorHandoff({ selection, failure: 'the worker stopped' });

    expect(terminal.attemptId).toBe('ux-round-2');
    expect(error).toMatchObject({ workflow: 'ux', attemptId: 'round-2' });

    // A pre-upgrade attempt that failed before its first round keeps its former no-round value.
    const legacy = path.join(root, 'workspaces', 'NEX-8');
    await writeJson(path.join(legacy, 'requirements', 'state', 'failure.json'), {
      reason: 'the repository condition prevents preparation',
    });
    const legacySelection = preparationSelectionFor(legacy, 'requirements');
    const failed = await preparationHandoff({
      selection: legacySelection,
      terminal: 'preparation-failed',
      stage: 'requirements',
    });
    const failedError = await operationalErrorHandoff({
      selection: legacySelection,
      failure: 'the worker stopped',
    });

    expect(failed.attemptId).toBe('unprepared');
    expect(failedError).toMatchObject({ workflow: 'requirements', attemptId: 'unprepared' });
  });

  it('uses one derivation for a published terminal and the selected operational error of an attempt', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeStageArea({ workspace, stage: 'architecture', attemptId: 'attempt-one', round: 2 });
    const selection = preparationSelectionFor(workspace, 'architecture');

    const terminal = await preparationHandoff({
      selection,
      terminal: 'preparation-handoff',
      stage: 'architecture',
    });
    const error = await operationalErrorHandoff({ selection, failure: 'the worker stopped' });

    expect(terminal.attemptId).toBe('attempt-one:architecture:round-2');
    expect(error).toMatchObject({
      workflow: 'architecture',
      attemptId: terminal.attemptId,
      terminalId: 'operational-error',
      outcome: 'error',
    });
  });
});

describe('successful preparation evidence', () => {
  it('selects the whole retained preparation in stable stage, round and path order', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeJson(path.join(workspace, 'parent', 'handoff-result.json'), {
      outcome: 'handed-off',
      tickets: ['NEX-8'],
    });
    await writeStageArea({ workspace, stage: 'requirements', attemptId: 'attempt-one', round: 1 });
    await writeJson(path.join(workspace, 'requirements', 'artifacts', '2', 'result.json'), {
      stage: 'requirements',
      outcome: 'accepted',
      authoredRevision: 2,
    });
    await writeStageArea({ workspace, stage: 'ux', attemptId: 'attempt-one', round: 1 });
    await writeJson(path.join(workspace, 'ux', 'report-feedback', 'history', '1.json'), {
      kind: 'validation-error',
    });
    // The Architecture outcome binds its Markdown outside the round tree the scan selects.
    const narrative = path.join(workspace, 'reports', 'invocation-2', 'architecture-author.md');
    await mkdir(path.dirname(narrative), { recursive: true });
    await writeFile(narrative, 'The architect recorded the implementation plan here.\n', 'utf8');
    await writeJson(path.join(workspace, 'architecture', 'state', 'attempt.json'), {
      attemptId: 'attempt-one',
    });
    await writeJson(path.join(workspace, 'architecture', 'artifacts', '1', 'author.json'), {
      report: { path: narrative },
      invocationId: 'invocation-2',
    });

    const handoff = await preparationHandoff({
      selection: preparationSelectionFor(workspace, 'architecture'),
      terminal: 'preparation-handoff',
      stage: 'architecture',
    });

    expect(handoff).toMatchObject({
      workId,
      workflow: 'preparation',
      attemptId: 'attempt-one:architecture:no-round',
      terminalId: 'preparation-handoff',
      outcome: 'handed-off',
    });
    expect(handoff.artifacts.map((artifact) => artifact.path)).toEqual([
      path.join(workspace, 'parent', 'handoff-result.json'),
      path.join(workspace, 'requirements', 'state', 'attempt.json'),
      path.join(workspace, 'requirements', 'state', 'current-round.json'),
      path.join(workspace, 'requirements', 'artifacts', '1', 'result.json'),
      path.join(workspace, 'requirements', 'artifacts', '2', 'result.json'),
      path.join(workspace, 'ux', 'state', 'attempt.json'),
      path.join(workspace, 'ux', 'state', 'current-round.json'),
      path.join(workspace, 'ux', 'report-feedback', 'history', '1.json'),
      path.join(workspace, 'ux', 'artifacts', '1', 'result.json'),
      path.join(workspace, 'architecture', 'state', 'attempt.json'),
      path.join(workspace, 'architecture', 'artifacts', '1', 'author.json'),
      narrative,
    ]);
  });

  it('keeps the former identity for a pre-upgrade architecture area', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'workspaces', workId);
    await writeStageArea({ workspace, stage: 'architecture', attemptId: null, round: 2 });
    const selection = preparationSelectionFor(workspace, 'architecture');

    const identity = await preparationSuccessIdentity({ selection, stage: 'architecture' });
    const handoff = await preparationHandoff({
      selection,
      terminal: 'preparation-handoff',
      stage: 'architecture',
    });

    expect(identity.attemptId).toBe('architecture-round-2');
    expect(handoff.attemptId).toBe(identity.attemptId);
  });
});

/** One binding over a temporary execution directory and the supplied memory configuration. */
function bindingOver(options: {
  readonly nexus: NexusConfiguration;
  readonly selectionFile: string;
  readonly events: EngineEvent[];
}) {
  const directory = path.dirname(options.selectionFile);
  const settings: ActionBindingSettings = {
    project: projectConfiguration(),
    nexus: options.nexus,
    paths: {
      directory,
      workflowStateFile: path.join(directory, 'workflow.json'),
      selectionFile: options.selectionFile,
    },
    // The capture path under test reads records and the durable store only.
    jira: {} as JiraAdapter,
    github: {} as GitHubAdapter,
    git: {} as GitAdapter,
    codingRuntime: {} as CodingRuntime,
    runCommand: () => Promise.reject(new Error('no configured command runs during capture')),
    commandEnvironment: {},
    activityDirectory: path.join(directory, 'agents'),
    wait: () => Promise.resolve(),
  };
  return createActionBinding(settings)(
    (event) => options.events.push(event),
    () => undefined,
  );
}

describe('capture boundary', () => {
  it('reports a discovery failure as unavailable instead of replacing the terminal outcome', async () => {
    const directory = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    // A malformed producer record is exactly what discovery must contain.
    await writeFile(selectionFile, '{"taskKey":\n', 'utf8');
    const nexus = nexusConfiguration();
    nexus.memory = {
      enabled: true,
      serviceUrl: 'http://127.0.0.1:1',
      mcp: { command: 'npm', args: ['run', '--silent', 'mcp'], directory: './agentic-memory' },
      analysisProfile: 'nexus-astra',
    };
    const events: EngineEvent[] = [];
    const binding = bindingOver({ nexus, selectionFile, events });

    await expect(binding.AnalyzeExperience!({ terminal: 'prepare-failed' })).resolves.toBe(
      'unavailable',
    );

    expect(events).toEqual([
      {
        source: 'analyze-experience',
        type: 'unavailable',
        data: { terminal: 'prepare-failed', reason: expect.stringContaining('is not valid JSON') },
      },
    ]);
  });

  it('records nothing and discovers nothing when the integration is disabled', async () => {
    const directory = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    // The selection file does not exist: disabled memory must not look for it.
    const events: EngineEvent[] = [];
    const binding = bindingOver({ nexus: nexusConfiguration(), selectionFile, events });

    await expect(binding.AnalyzeExperience!({ terminal: 'prepare-failed' })).resolves.toBe(
      'skipped',
    );

    expect(events).toEqual([]);
  });

  it('skips the retained intermediate-success terminal without evidence discovery', async () => {
    const directory = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    // Neither the selection record nor any stage area exists, so any evidence discovery would
    // fail; the legacy compatibility binding must return before reading either.
    const nexus = nexusConfiguration();
    enableMemory(nexus);
    const events: EngineEvent[] = [];
    const binding = bindingOver({ nexus, selectionFile, events });

    await expect(
      binding.AnalyzeExperience!({ terminal: 'preparation-advanced', stage: 'ux' }),
    ).resolves.toBe('skipped');

    expect(events).toEqual([]);
    await expect(stat(path.join(directory, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records a fresh final attempt as its own request while the retained attempt keeps its capture', async () => {
    const directory = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    const workspace = path.join(directory, 'workspaces', workId);
    await writeJson(path.join(workspace, 'parent', 'handoff-result.json'), {
      outcome: 'handed-off',
    });
    await writeStageArea({ workspace, stage: 'architecture', attemptId: 'attempt-one', round: 2 });
    await writeJson(path.join(workspace, 'ux', 'state', 'attempt.json'), {
      attemptId: 'attempt-one',
    });
    await writeJson(selectionFile, preparationSelectionFor(workspace, 'architecture'));
    const nexus = nexusConfiguration();
    enableMemory(nexus);
    const events: EngineEvent[] = [];
    const binding = bindingOver({ nexus, selectionFile, events });

    await expect(
      binding.AnalyzeExperience!({ terminal: 'preparation-handoff', stage: 'architecture' }),
    ).resolves.toBe('recorded');
    const requests = path.join(directory, 'memory', 'requests');
    const retainedRequests = await readdir(requests);
    expect(retainedRequests).toHaveLength(1);
    const retainedRequest = await readFile(path.join(requests, retainedRequests[0]!), 'utf8');
    // A miss selected the complete preparation evidence, not just Architecture's current round.
    const captured = JSON.parse(retainedRequest) as {
      readonly handoff: { readonly artifacts: readonly { readonly path: string }[] };
    };
    expect(captured.handoff.artifacts.map((artifact) => artifact.path)).toContain(
      path.join(workspace, 'parent', 'handoff-result.json'),
    );
    expect(captured.handoff.artifacts.map((artifact) => artifact.path)).toContain(
      path.join(workspace, 'ux', 'state', 'attempt.json'),
    );

    // Replaying the same retained final handoff reuses its request without touching its bytes.
    await expect(
      binding.AnalyzeExperience!({ terminal: 'preparation-handoff', stage: 'architecture' }),
    ).resolves.toBe('recorded');
    expect(await readdir(requests)).toHaveLength(1);
    expect(await readFile(path.join(requests, retainedRequests[0]!), 'utf8')).toBe(retainedRequest);

    // The fresh attempt repeats the ticket, stage, round and terminal yet forms its own request.
    await writeJson(path.join(workspace, 'architecture', 'state', 'attempt.json'), {
      attemptId: 'attempt-two',
    });
    await expect(
      binding.AnalyzeExperience!({ terminal: 'preparation-handoff', stage: 'architecture' }),
    ).resolves.toBe('recorded');

    expect(await readdir(requests)).toHaveLength(2);
    // The retained attempt's request keeps its exact bytes.
    expect(await readFile(path.join(requests, retainedRequests[0]!), 'utf8')).toBe(retainedRequest);
  });

  it('reuses a recorded final request instead of expanding its narrower handoff', async () => {
    const directory = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    const workspace = path.join(directory, 'workspaces', workId);
    await writeJson(path.join(workspace, 'parent', 'handoff-result.json'), {
      outcome: 'handed-off',
    });
    await writeStageArea({ workspace, stage: 'architecture', attemptId: 'attempt-one', round: 2 });
    await writeJson(path.join(workspace, 'ux', 'state', 'attempt.json'), {
      attemptId: 'attempt-one',
    });
    // The earlier capture selected only Architecture's current round; the complete selection now
    // reaches evidence the recorded handoff never named.
    const narrow: ExperienceHandoff = {
      workId,
      workflow: 'preparation',
      attemptId: 'attempt-one:architecture:round-2',
      terminalId: 'preparation-handoff',
      outcome: 'handed-off',
      reason: null,
      workspaceRoot: workspace,
      artifacts: [{ path: path.join(workspace, 'architecture', 'state', 'attempt.json') }],
    };
    const recorder = createAnalyzeExperience({
      directory: path.join(directory, 'memory'),
      project: projectConfiguration().taskSource.project,
      profile: 'nexus-astra',
      memory: { url: 'http://127.0.0.1:1' },
      analyze: null,
    });
    await expect(recorder.capture(narrow)).resolves.toMatchObject({ outcome: 'recorded' });
    const requestFile = experienceRequestFile(
      path.join(directory, 'memory'),
      experienceIdentity(narrow),
    );
    const retained = await readFile(requestFile, 'utf8');
    const captureFile = experienceCaptureFile(
      path.join(directory, 'memory'),
      experienceIdentity(narrow),
    );
    const captured = await readFile(captureFile, 'utf8');

    await writeJson(selectionFile, preparationSelectionFor(workspace, 'architecture'));
    const nexus = nexusConfiguration();
    enableMemory(nexus);
    const events: EngineEvent[] = [];
    const binding = bindingOver({ nexus, selectionFile, events });

    await expect(
      binding.AnalyzeExperience!({ terminal: 'preparation-handoff', stage: 'architecture' }),
    ).resolves.toBe('recorded');
    // Replay keeps the immutable handoff: the request still names only its original evidence and
    // no source file is reselected or copied; the original capture evidence is reused as recorded.
    expect(await readFile(requestFile, 'utf8')).toBe(retained);
    expect(await readFile(captureFile, 'utf8')).toBe(captured);
    expect(await readdir(path.join(directory, 'memory', 'requests'))).toHaveLength(1);
  });

  it('reports a damaged recorded final request as unavailable without replacement', async () => {
    const directory = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    const workspace = path.join(directory, 'workspaces', workId);
    await writeStageArea({ workspace, stage: 'architecture', attemptId: 'attempt-one', round: 2 });
    const identity = experienceIdentity({
      workId,
      workflow: 'preparation',
      attemptId: 'attempt-one:architecture:round-2',
      terminalId: 'preparation-handoff',
    });
    const requestFile = experienceRequestFile(path.join(directory, 'memory'), identity);
    await mkdir(path.dirname(requestFile), { recursive: true });
    await writeFile(requestFile, '{"identity":\n', 'utf8');
    await writeJson(selectionFile, preparationSelectionFor(workspace, 'architecture'));
    const nexus = nexusConfiguration();
    enableMemory(nexus);
    const events: EngineEvent[] = [];
    const binding = bindingOver({ nexus, selectionFile, events });

    await expect(
      binding.AnalyzeExperience!({ terminal: 'preparation-handoff', stage: 'architecture' }),
    ).resolves.toBe('unavailable');

    // The unreadable record is never replaced by newly selected evidence.
    expect(await readFile(requestFile, 'utf8')).toBe('{"identity":\n');
    expect(await readdir(path.join(directory, 'memory', 'requests'))).toHaveLength(1);
    expect(events).toEqual([
      {
        source: 'analyze-experience',
        type: 'unavailable',
        data: {
          terminal: 'preparation-handoff',
          reason: expect.stringContaining('is not valid JSON'),
        },
      },
    ]);
  });
});
