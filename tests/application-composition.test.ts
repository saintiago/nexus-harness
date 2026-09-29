/**
 * Composition tests: resolved project and Nexus configuration produce Application's execution
 * paths, the worker and tool environments that keep credentials isolated, and the worker's action
 * binding. Capabilities are supplied fakes and temp storage is controlled; no live service,
 * credential or agent turn is involved.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createActionBinding } from '../src/application/action-bindings.js';
import {
  createAnalysisAgentRuntimeSettings,
  createAgentRuntimeSettings,
  createConfiguredMemory,
  executionPaths,
  recoveryEnvironment,
  toolEnvironment,
  workerProcessEnvironment,
  workspaceRoot,
} from '../src/application/composition.js';
import { installationConfigSetting } from '../src/application/installation.js';
import type { CodingRuntime } from '../src/adapters/coding-runtime.js';
import type { GitHubAdapter } from '../src/adapters/github.js';
import type { GitAdapter } from '../src/adapters/git.js';
import type { JiraAdapter } from '../src/adapters/jira.js';
import {
  parseNexusConfiguration,
  parseProjectConfiguration,
  type NexusConfiguration,
} from '../src/configuration/index.js';
import { memoryAnalysisGuidance, memoryUseGuidance } from '../src/agent-runtime/index.js';
import { ok } from '../src/result.js';
import type { AgentActivity, EngineEvent } from '../src/task-engine/index.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

const installationDirectory = '/srv/nexus/installation';
const projectDirectory = '/srv/target-project';
const installationConfigPath = path.join(installationDirectory, 'nexus.config.json');

const nexus = parseNexusConfiguration(nexusConfiguration(), installationDirectory);
const project = parseProjectConfiguration(projectConfiguration(), projectDirectory);

/** The host environment the composition helpers see: every credential plus needed host settings. */
const hostEnvironment = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/operator',
  JIRA_API_TOKEN: 'host-jira-token',
  NEXUS_LENS_PRIVATE_KEY: 'host-lens-key',
  AWS_ACCESS_KEY_ID: 'host-access-key',
  AWS_SECRET_ACCESS_KEY: 'host-secret-key',
  AWS_SESSION_TOKEN: 'host-session-token',
  DEEPSEEK_API_KEY: 'provider-key',
  UNSET_SETTING: undefined,
};

/** The supplied Nexus configuration with the optional memory integration configured. */
function memoryNexus(storageRoot: string, enabled = true): NexusConfiguration {
  const configuration = nexusConfiguration();
  configuration.storage.root = storageRoot;
  configuration.memory = {
    enabled: true,
    serviceUrl: 'http://127.0.0.1:4748',
    mcp: { command: 'npm', args: ['run', '--silent', 'mcp'], directory: './agentic-memory' },
    analysisProfile: 'nexus-astra',
  };
  // Disabling flips only the switch: the configured service settings stay and stay inert.
  const document = enabled
    ? configuration
    : { ...configuration, memory: { ...configuration.memory, enabled: false } };
  return parseNexusConfiguration(document, installationDirectory);
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-application-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A capability the exercised composition must not use. */
function unusedCapability<Capability extends object>(name: string): Capability {
  return new Proxy({} as Capability, {
    get: () => () => {
      throw new Error(`The ${name} capability was used unexpectedly.`);
    },
  });
}

/** One selection record for the supplied workspace root. */
function selectionDocument(workspace: string): Record<string, unknown> {
  return {
    taskKey: 'NEX-7',
    source: { kind: 'jira', issueId: '10001' },
    task: { id: '10001', key: 'NEX-7', fields: {} },
    conversation: [],
    workspace: { root: workspace },
  };
}

describe('execution paths', () => {
  it('places execution state and task workspaces under the configured storage root', () => {
    const paths = executionPaths(nexus, project, 'finite-delivery');

    expect(paths).toEqual({
      directory: path.join(nexus.storage.root, 'executions', 'NEX'),
      workflowStateFile: path.join(nexus.storage.root, 'executions', 'NEX', 'workflow.json'),
      selectionFile: path.join(nexus.storage.root, 'executions', 'NEX', 'selection.json'),
    });
    // Idea refinement keeps its own execution directory beside the finite delivery queue's.
    expect(executionPaths(nexus, project, 'idea-refinement')).toEqual({
      directory: path.join(nexus.storage.root, 'executions', 'NEX', 'idea-refinement'),
      workflowStateFile: path.join(
        nexus.storage.root,
        'executions',
        'NEX',
        'idea-refinement',
        'workflow.json',
      ),
      selectionFile: path.join(
        nexus.storage.root,
        'executions',
        'NEX',
        'idea-refinement',
        'selection.json',
      ),
    });
    expect(workspaceRoot(nexus)).toBe(path.join(nexus.storage.root, 'workspaces'));
  });
});

describe('credential isolation', () => {
  it('keeps notification credentials out of the worker process and sets its configuration path', () => {
    const environment = workerProcessEnvironment(nexus, hostEnvironment, installationConfigPath);

    expect(environment['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(environment['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(environment['AWS_SESSION_TOKEN']).toBeUndefined();
    expect(environment['UNSET_SETTING']).toBeUndefined();
    expect(environment['JIRA_API_TOKEN']).toBe('host-jira-token');
    expect(environment['NEXUS_LENS_PRIVATE_KEY']).toBe('host-lens-key');
    expect(environment['DEEPSEEK_API_KEY']).toBe('provider-key');
    expect(environment[installationConfigSetting]).toBe(installationConfigPath);
  });

  it('keeps every Nexus credential out of the environment commands and agents run with', () => {
    const environment = toolEnvironment(project, nexus, hostEnvironment);

    expect(environment['JIRA_API_TOKEN']).toBeUndefined();
    expect(environment['NEXUS_LENS_PRIVATE_KEY']).toBeUndefined();
    expect(environment['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(environment['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(environment['AWS_SESSION_TOKEN']).toBeUndefined();
    expect(environment['DEEPSEEK_API_KEY']).toBe('provider-key');
    expect(environment['PATH']).toBe('/usr/bin:/bin');
    expect(environment['HOME']).toBe('/home/operator');
  });

  it('gives the recovery agent the project credential and tool settings without Lens or SNS', () => {
    const environment = recoveryEnvironment(nexus, hostEnvironment);

    expect(environment['JIRA_API_TOKEN']).toBe('host-jira-token');
    expect(environment['DEEPSEEK_API_KEY']).toBe('provider-key');
    expect(environment['PATH']).toBe('/usr/bin:/bin');
    expect(environment['HOME']).toBe('/home/operator');
    expect(environment['NEXUS_LENS_PRIVATE_KEY']).toBeUndefined();
    expect(environment['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(environment['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(environment['AWS_SESSION_TOKEN']).toBeUndefined();
    expect(environment['UNSET_SETTING']).toBeUndefined();
  });
});

describe('memory composition', () => {
  it('constructs the service client from the configured URL and a no-op when disabled', async () => {
    const configured = memoryNexus('/srv/nexus/state');
    const calls: string[] = [];
    const transport: typeof globalThis.fetch = (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${input instanceof URL ? input.href : String(input)}`);
      return Promise.resolve(
        new Response(JSON.stringify({ searchedAt: '2026-09-29T10:00:00Z', results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };

    const memory = createConfiguredMemory(configured, transport);
    await expect(memory.search({ query: 'retry guard' })).resolves.toEqual({
      kind: 'results',
      searchedAt: '2026-09-29T10:00:00Z',
      results: [],
    });
    expect(calls).toEqual(['POST http://127.0.0.1:4748/v1/search']);

    // A configuration that omits memory or disables it constructs no service call at all.
    const disabled = createConfiguredMemory(nexus, transport);
    await expect(disabled.search({ query: 'retry guard' })).resolves.toEqual({ kind: 'disabled' });
    expect(calls).toHaveLength(1);
    await Promise.all([memory.close(), disabled.close()]);
  });

  it('adds the AMEM MCP settings and the shared guidance to memory-enabled roles', () => {
    const configured = memoryNexus('/srv/nexus/state');
    const settings = createAgentRuntimeSettings(
      configured,
      'developer',
      unusedCapability<CodingRuntime>('coding runtime'),
    );

    const developer = settings.profiles.find((profile) => profile.id === 'nexus-flash');
    expect(developer?.toolSettings).toEqual({
      profile: 'nexus-flash',
      config: {
        'mcp_servers.amem.command': 'npm',
        'mcp_servers.amem.args': ['run', '--silent', 'mcp'],
        'mcp_servers.amem.cwd': path.join(installationDirectory, 'agentic-memory'),
        'mcp_servers.amem.env': { AMEM_MCP_SERVICE_URL: 'http://127.0.0.1:4748' },
        'mcp_servers.amem.enabled': true,
      },
    });
    expect(settings.baseInstructions).toContain(memoryUseGuidance);

    // Disabled memory adds neither the tools nor their guidance.
    const disabled = createAgentRuntimeSettings(
      nexus,
      'developer',
      unusedCapability<CodingRuntime>('coding runtime'),
    );
    expect(disabled.profiles.every((profile) => profile.toolSettings['config'] === undefined)).toBe(
      true,
    );
    expect(disabled.baseInstructions).not.toContain(memoryUseGuidance);
  });

  it('keeps a disabled integration with retained service settings inert', async () => {
    const disabled = memoryNexus('/srv/nexus/state', false);
    const calls: string[] = [];
    const transport: typeof globalThis.fetch = (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${input instanceof URL ? input.href : String(input)}`);
      return Promise.reject(new Error('The disabled integration contacted the service.'));
    };

    const memory = createConfiguredMemory(disabled, transport);
    await expect(memory.search({ query: 'retry guard' })).resolves.toEqual({ kind: 'disabled' });
    await expect(
      memory.submit({ sourceKey: 'HARN-83:round-2', content: 'A reusable discovery.' }),
    ).resolves.toEqual({ kind: 'disabled' });
    await memory.close();
    expect(calls).toEqual([]);

    const settings = createAgentRuntimeSettings(
      disabled,
      'developer',
      unusedCapability<CodingRuntime>('coding runtime'),
    );
    expect(settings.profiles.every((profile) => profile.toolSettings['config'] === undefined)).toBe(
      true,
    );
    expect(settings.baseInstructions).not.toContain(memoryUseGuidance);
  });

  it('runs the configured analysis profile with search-only memory tools and guidance', () => {
    const configured = memoryNexus('/srv/nexus/state');
    const settings = createAnalysisAgentRuntimeSettings(
      configured,
      unusedCapability<CodingRuntime>('coding runtime'),
    );

    // The configured analysis profile carries the AMEM server restricted to search: Nexus submits
    // the validated output itself, so the analyst cannot save directly.
    const analyst = settings.profiles.find((profile) => profile.id === 'nexus-astra');
    expect(analyst?.toolSettings).toEqual({
      profile: 'nexus-astra',
      config: {
        'mcp_servers.amem.command': 'npm',
        'mcp_servers.amem.args': ['run', '--silent', 'mcp'],
        'mcp_servers.amem.cwd': path.join(installationDirectory, 'agentic-memory'),
        'mcp_servers.amem.env': { AMEM_MCP_SERVICE_URL: 'http://127.0.0.1:4748' },
        'mcp_servers.amem.enabled': true,
        'mcp_servers.amem.enabled_tools': ['memory_search'],
      },
    });
    expect(
      settings.profiles
        .filter((profile) => profile.id !== 'nexus-astra')
        .every((profile) => profile.toolSettings['config'] === undefined),
    ).toBe(true);
    expect(settings.baseInstructions).toContain(memoryAnalysisGuidance);
    expect(settings.baseInstructions).not.toContain(memoryUseGuidance);
  });
});

describe('worker action binding', () => {
  it('binds every workflow operation', async () => {
    const directory = await temporaryDirectory();
    const bind = createActionBinding({
      workflow: 'finite-delivery',
      project,
      nexus,
      paths: {
        directory,
        workflowStateFile: path.join(directory, 'workflow.json'),
        selectionFile: path.join(directory, 'selection.json'),
      },
      jira: unusedCapability<JiraAdapter>('Jira'),
      github: unusedCapability<GitHubAdapter>('GitHub'),
      git: unusedCapability<GitAdapter>('Git'),
      codingRuntime: unusedCapability('coding runtime'),
      runCommand: unusedCapability('processes'),
      commandEnvironment: {},
      activityDirectory: path.join(directory, 'logs', 'agents'),
      wait: () => Promise.resolve(),
    });

    expect(
      Object.keys(
        bind(
          () => {},
          () => {},
        ),
      ).sort(),
    ).toEqual(
      [
        'CompleteTask',
        'Deliver',
        'Develop',
        'PrepareWorkspace',
        'Review',
        'SelectTask',
        'StartRound',
        'Verify',
      ].sort(),
    );
  });

  it('binds the idea refinement workflow operations and its captured selection', async () => {
    const directory = await temporaryDirectory();
    const refinement = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        issue: { id: '10518', key: 'NEX-1', fields: {} },
        conversation: [],
        transitions: { toActive: null, fromActive: [] },
        claimed: true,

        retainedSubmissions: 0,
        workspace: { root: refinement },
        issueWorkspace: { root: path.dirname(refinement) },
      }),
    );
    const actions = createActionBinding({
      workflow: 'idea-refinement',
      project,
      nexus,
      paths: {
        directory,
        workflowStateFile: path.join(directory, 'workflow.json'),
        selectionFile,
      },
      jira: unusedCapability<JiraAdapter>('Jira'),
      github: unusedCapability<GitHubAdapter>('GitHub'),
      git: unusedCapability<GitAdapter>('Git'),
      codingRuntime: unusedCapability('coding runtime'),
      runCommand: unusedCapability('processes'),
      commandEnvironment: {},

      activityDirectory: path.join(directory, 'logs', 'agents'),
      wait: () => Promise.resolve(),
    })(
      () => {},
      () => {},
    );

    expect(Object.keys(actions).sort()).toEqual(
      [
        'Challenger',
        'IdeaEditor',
        'ProjectGuide',
        'PublishDecision',
        'Researcher',
        'SelectIdea',
        'StartIdeaRound',
      ].sort(),
    );
    // The bound planner carries the route XState supplied and the selection's captured input.
    await expect(actions['StartIdeaRound']?.({ route: 'new' })).resolves.toBe('opened');
    expect(
      JSON.parse(await readFile(path.join(refinement, 'state/current-round.json'), 'utf8')),
    ).toMatchObject({ submission: 1, cycle: 1, route: 'new' });
    expect(
      JSON.parse(
        await readFile(path.join(refinement, 'artifacts/submissions/1/input.json'), 'utf8'),
      ),
    ).toMatchObject({ taskKey: 'NEX-1', source: { issueId: '10518' } });
  });

  it('gives concurrent idea role invocations distinct identities and attributable activity', async () => {
    const directory = await temporaryDirectory();
    const refinement = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        issue: { id: '10518', key: 'NEX-1', fields: { summary: 'Add a lint gate' } },
        conversation: [],
        transitions: { toActive: null, fromActive: [] },
        claimed: true,
        retainedSubmissions: 0,
        workspace: { root: refinement },
        issueWorkspace: { root: path.dirname(refinement) },
      }),
    );
    // Both role invocations must overlap: neither provider call finishes before the other starts.
    let arrivals = 0;
    let releaseBoth: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const activityDirectory = path.join(directory, 'logs', 'agents');
    const codingRuntime: CodingRuntime = {
      async execute(request, onActivity) {
        arrivals += 1;
        if (arrivals === 2) {
          releaseBoth();
        }
        await bothStarted;
        const guidance = request.prompt.includes('Be wise and thoughtful');
        onActivity({ type: 'message', text: guidance ? 'guidance words' : 'research words' });
        return ok({
          output: JSON.stringify(
            guidance
              ? {
                  contribution: 'The idea serves the project purpose.',
                  fit: 'It serves operators.',
                  steering: ['Keep the scope small.'],
                  constraints: [],
                  evidence: ['docs/purpose.md'],
                  provisional: false,
                  uncertainty: [],
                }
              : {
                  contribution: 'Linters keep reviews focused.',
                  findings: ['Teams catch style defects early.'],
                  options: ['Adopt the smallest lint configuration.'],
                  sources: [],
                },
          ),
        });
      },
    };
    const events: EngineEvent[] = [];
    const activity: AgentActivity[] = [];
    const actions = createActionBinding({
      workflow: 'idea-refinement',
      project,
      nexus,
      paths: {
        directory,
        workflowStateFile: path.join(directory, 'workflow.json'),
        selectionFile,
      },
      jira: unusedCapability<JiraAdapter>('Jira'),
      github: unusedCapability<GitHubAdapter>('GitHub'),
      git: unusedCapability<GitAdapter>('Git'),
      codingRuntime,
      runCommand: unusedCapability('processes'),
      commandEnvironment: {},
      activityDirectory,
      wait: () => Promise.resolve(),
    })(
      (event) => events.push(event),
      (packet) => activity.push(packet),
    );
    await actions['StartIdeaRound']?.({ route: 'new' });

    await expect(
      Promise.all([
        actions['Researcher']?.({ phase: 'initial' }),
        actions['ProjectGuide']?.({ phase: 'initial' }),
      ]),
    ).resolves.toEqual(['contributed', 'contributed']);

    const started = events.filter((event) => event.type === 'agent-started');
    const boundaries = started.map(
      (event) =>
        event.data as {
          readonly agentName: string;
          readonly invocationId: string;
          readonly startedAtUnixMs: number;
          readonly log: { readonly path: string };
          readonly operation: string;
          readonly idea: string;
          readonly summary: string;
        },
    );
    expect(boundaries.map((boundary) => boundary.agentName).sort()).toEqual([
      'project-guide',
      'researcher',
    ]);
    // Each idea role's boundary names the captured ticket by its key and Summary.
    expect(
      boundaries.map((boundary) => ({ idea: boundary.idea, summary: boundary.summary })),
    ).toEqual([
      { idea: 'NEX-1', summary: 'Add a lint gate' },
      { idea: 'NEX-1', summary: 'Add a lint gate' },
    ]);
    // Each invocation has its own identity and its own log under the execution's agents directory.
    const ids = boundaries.map((boundary) => boundary.invocationId);
    expect(new Set(ids).size).toBe(2);
    for (const boundary of boundaries) {
      expect(boundary.log.path).toBe(
        path.join(
          activityDirectory,
          `${boundary.agentName}-${String(boundary.startedAtUnixMs)}-${boundary.invocationId}.jsonl`,
        ),
      );
    }
    // Every activity packet names the invocation of the role that reported it.
    const guideId = boundaries.find(
      (boundary) => boundary.agentName === 'project-guide',
    )?.invocationId;
    const researchId = boundaries.find(
      (boundary) => boundary.agentName === 'researcher',
    )?.invocationId;
    expect(activity).toHaveLength(2);
    expect(activity.find((packet) => packet.activity.text === 'guidance words')?.invocationId).toBe(
      guideId,
    );
    expect(activity.find((packet) => packet.activity.text === 'research words')?.invocationId).toBe(
      researchId,
    );
    // Each finish names the identity its start announced.
    expect(
      events
        .filter((event) => event.type === 'agent-finished')
        .map((event) => (event.data as { readonly invocationId: string }).invocationId)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it('runs workspace-scoped actions in the workspace of the current selection', async () => {
    const directory = await temporaryDirectory();
    const firstWorkspace = await temporaryDirectory();
    const secondWorkspace = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    await writeFile(selectionFile, JSON.stringify(selectionDocument(firstWorkspace)));
    const actions = createActionBinding({
      workflow: 'finite-delivery',
      project,
      nexus,
      paths: {
        directory,
        workflowStateFile: path.join(directory, 'workflow.json'),
        selectionFile,
      },
      jira: unusedCapability<JiraAdapter>('Jira'),
      github: unusedCapability<GitHubAdapter>('GitHub'),
      git: unusedCapability<GitAdapter>('Git'),
      codingRuntime: unusedCapability('coding runtime'),
      runCommand: unusedCapability('processes'),
      commandEnvironment: {},

      activityDirectory: path.join(directory, 'logs', 'agents'),
      wait: () => Promise.resolve(),
    })(
      () => {},
      () => {},
    );

    await expect(actions['StartRound']?.()).resolves.toBe('started');
    await writeFile(selectionFile, JSON.stringify(selectionDocument(secondWorkspace)));
    await expect(actions['StartRound']?.()).resolves.toBe('started');

    expect(
      JSON.parse(await readFile(path.join(firstWorkspace, 'state/current-round.json'), 'utf8')),
    ).toEqual({
      number: 1,
      profile: 'nexus-flash',
      reason: expect.stringContaining('first profile "nexus-flash"'),
    });
    expect(
      JSON.parse(await readFile(path.join(secondWorkspace, 'state/current-round.json'), 'utf8')),
    ).toEqual({
      number: 1,
      profile: 'nexus-flash',
      reason: expect.stringContaining('first profile "nexus-flash"'),
    });
  });
});
