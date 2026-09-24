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
  executionPaths,
  toolEnvironment,
  workerProcessEnvironment,
  workspaceRoot,
} from '../src/application/composition.js';
import { installationConfigSetting } from '../src/application/installation.js';
import type { GitHubAdapter } from '../src/adapters/github.js';
import type { GitAdapter } from '../src/adapters/git.js';
import type { JiraAdapter } from '../src/adapters/jira.js';
import { parseNexusConfiguration, parseProjectConfiguration } from '../src/configuration/index.js';
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
    const paths = executionPaths(nexus, project);

    expect(paths).toEqual({
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
});

describe('worker action binding', () => {
  it('binds every workflow operation', async () => {
    const directory = await temporaryDirectory();
    const bind = createActionBinding({
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
      wait: () => Promise.resolve(),
    });

    expect(Object.keys(bind(() => {})).sort()).toEqual(
      [
        'CompleteTask',
        'Deliver',
        'Develop',
        'PrepareWorkspace',
        'Review',
        'SelectRepair',
        'SelectTask',
        'StartRound',
        'Verify',
      ].sort(),
    );
  });

  it('runs workspace-scoped actions in the workspace of the current selection', async () => {
    const directory = await temporaryDirectory();
    const firstWorkspace = await temporaryDirectory();
    const secondWorkspace = await temporaryDirectory();
    const selectionFile = path.join(directory, 'selection.json');
    await writeFile(selectionFile, JSON.stringify(selectionDocument(firstWorkspace)));
    const actions = createActionBinding({
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
      wait: () => Promise.resolve(),
    })(() => {});

    await expect(actions['StartRound']?.()).resolves.toBe('started');
    await writeFile(selectionFile, JSON.stringify(selectionDocument(secondWorkspace)));
    await expect(actions['StartRound']?.()).resolves.toBe('started');

    expect(
      JSON.parse(await readFile(path.join(firstWorkspace, 'state/current-round.json'), 'utf8')),
    ).toEqual({ number: 1 });
    expect(
      JSON.parse(await readFile(path.join(secondWorkspace, 'state/current-round.json'), 'utf8')),
    ).toEqual({ number: 1 });
  });
});
