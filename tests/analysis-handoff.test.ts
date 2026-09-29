/**
 * Focused integration tests: Application's workflow bindings around AnalyzeExperience. They
 * establish the durable attempt identity a finite attempt records, the producer-owned reason
 * records the handoff reconstructs after a restart, the interrupted idea submission resolution and
 * the capture boundary that keeps a discovery failure from replacing a terminal outcome.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  ideaRefinementHandoff,
  operationalErrorHandoff,
} from '../src/application/analysis-handoff.js';
import type { NexusConfiguration } from '../src/configuration/index.js';
import type { IdeaSelection } from '../src/task-engine/actions/select-idea/artifacts.js';
import type { Selection } from '../src/task-engine/actions/select-task/artifacts.js';
import { ideaRoundPlanFile } from '../src/task-engine/actions/start-idea-round/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

const workId = 'NEX-7';
const submissionReason =
  'The configured maximum of 1 conversation cycle for this selection is reached; another cycle ' +
  'would exceed it.';

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
  };
}

/** One idea-refinement selection naming the supplied refinement area. */
function ideaSelectionFor(workspace: string, retainedSubmissions: number): IdeaSelection {
  return {
    taskKey: workId,
    source: { kind: 'jira', issueId: '10518' },
    issue: { id: '10518', key: workId, fields: {} },
    conversation: [],
    transitions: { toActive: {}, fromActive: [] },
    claimed: true,
    retainedSubmissions,
    workspace: { root: workspace },
    issueWorkspace: { root: path.dirname(workspace) },
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
    const selection = ideaSelectionFor(workspace, 1);

    const handoff = await ideaRefinementHandoff({ selection, terminal: 'publish-approved' });
    const operational = await operationalErrorHandoff({
      workflow: 'idea-refinement',
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

  it('states the exhaustion reason the idea round producer retained', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'refinement');
    await writeJson(path.join(workspace, 'artifacts', 'submissions', '1', 'input.json'), {
      taskKey: workId,
    });
    await writeJson(path.join(workspace, 'state', 'submission-exhaustion.json'), {
      reason: submissionReason,
    });

    const handoff = await ideaRefinementHandoff({
      selection: ideaSelectionFor(workspace, 0),
      terminal: 'start-submission-exhausted',
    });

    expect(handoff.reason).toBe(submissionReason);
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
    workflow: 'finite-delivery',
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
});
