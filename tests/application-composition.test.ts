/**
 * Composition tests: resolved project and Nexus configuration produce Application's execution
 * paths, the worker and tool environments that keep credentials isolated, and the worker's action
 * binding. Capabilities are supplied fakes and temp storage is controlled; no live service,
 * credential or agent turn is involved.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createActionBinding } from '../src/application/action-bindings.js';
import {
  createAgentRuntimeSettings,
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

describe('execution paths', () => {
  it('places execution state and task workspaces under the configured storage root', () => {
    const paths = executionPaths(nexus, project);

    expect(paths).toEqual({
      directory: path.join(nexus.storage.root, 'executions', 'NEX'),
      workflowStateFile: path.join(nexus.storage.root, 'executions', 'NEX', 'workflow.json'),
      selectionFile: path.join(nexus.storage.root, 'executions', 'NEX', 'selection.json'),
    });
    // Every stage child shares the composed parent's execution directory.
    expect(executionPaths(nexus, project)).toEqual({
      directory: path.join(nexus.storage.root, 'executions', 'NEX'),
      workflowStateFile: path.join(nexus.storage.root, 'executions', 'NEX', 'workflow.json'),
      selectionFile: path.join(nexus.storage.root, 'executions', 'NEX', 'selection.json'),
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

  it('runs the configured analysis profile with search-only memory tools and guidance', () => {
    const configured = memoryNexus('/srv/nexus/state');
    const settings = createAgentRuntimeSettings(
      configured,
      'analysis',
      unusedCapability<CodingRuntime>('coding runtime'),
    );

    // The configured analysis profile carries the AMEM server restricted to search: Nexus submits
    // the validated output itself, so the analyst cannot save directly. No other profile is
    // selected for the analysis role, so only the analyst gains those settings.
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

    // A disabled integration selects no analysis profile and exposes no memory guidance or tools.
    const disabled = createAgentRuntimeSettings(
      memoryNexus('/srv/nexus/state', false),
      'analysis',
      unusedCapability<CodingRuntime>('coding runtime'),
    );
    expect(disabled.profiles.every((profile) => profile.toolSettings['config'] === undefined)).toBe(
      true,
    );
    expect(disabled.baseInstructions).not.toContain(memoryAnalysisGuidance);
    expect(disabled.baseInstructions).not.toContain(memoryUseGuidance);
  });
});

describe('worker action binding', () => {
  const settings = async () => {
    const directory = await temporaryDirectory();
    return {
      directory,
      settings: {
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
        codingRuntime: unusedCapability<CodingRuntime>('coding runtime'),
        runCommand:
          unusedCapability<import('../src/application/action-bindings.js').CommandExecution>(
            'processes',
          ),
        commandEnvironment: {},
        activityDirectory: path.join(directory, 'logs', 'agents'),
        wait: () => Promise.resolve(),
      },
    };
  };

  it('binds every project parent and child operation', async () => {
    const { settings: binding } = await settings();
    const actions = createActionBinding(binding)(
      () => {},
      () => {},
    );

    expect(Object.keys(actions).sort()).toEqual(
      [
        'AnalyzeExperience',
        'Challenger',
        'CompleteDelivery',
        'CompleteTask',
        'Deliver',
        'Develop',
        'HandoffImplementation',
        'IdeaEditor',
        'PrepareIdeaWorkspace',
        'PrepareStage',
        'PrepareWorkspace',
        'ProjectGuide',
        'PublishDeliveryReport',
        'PublishIdeaResult',
        'PublishPreparationResult',
        'PublishReviewFeedback',
        'RecordIdeaDecision',
        'RecordStageReturn',
        'RefreshTaskInput',
        'Researcher',
        'Review',
        'RouteSelection',
        'SelectWork',
        'StageAuthor',
        'StageEvaluator',
        'StageResult',
        'StartIdeaRound',
        'StartRound',
        'StartStageRound',
        'Verify',
      ].sort(),
    );
  });

  it('resolves the parent stage from the retained selection on every invocation', async () => {
    const { directory, settings: binding } = await settings();
    const workspace = await temporaryDirectory();
    const selectionFile = binding.paths.selectionFile;
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10001' },
        task: { id: '10001', key: 'NEX-1', fields: {} },
        conversation: [],
        workspace: { root: workspace },
        stage: 'delivery',
      }),
    );
    const actions = createActionBinding(binding)(
      () => {},
      () => {},
    );

    await expect(actions['RouteSelection']?.()).resolves.toBe('delivery');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10001' },
        task: { id: '10001', key: 'NEX-1', fields: {} },
        conversation: [],
        workspace: { root: workspace },
        stage: 'ux',
      }),
    );
    await expect(actions['RouteSelection']?.()).resolves.toBe('ux');
    expect(directory).toBeTruthy();
  });
});
