/**
 * Composition test: the worker entry loads real project and installation configuration files from
 * temporary storage, loads a configured workflow module, constructs the adapters, AgentRuntime and
 * TaskEngine and speaks the worker protocol. The configured workflow only runs StartRound, so no
 * external service, queue or agent is involved; credential values are controlled fakes.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkerLine } from '../src/application/protocol.js';
import { runWorker, type WorkerSettings } from '../src/application/worker.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

const workflowModule = fileURLToPath(
  new URL('./fixtures/workflow/start-round.mjs', import.meta.url),
);

/** The host credential values the worker resolves; each is a controlled fake. */
const credentials = {
  JIRA_API_TOKEN: 'controlled-jira-token',
  NEXUS_LENS_PRIVATE_KEY: 'controlled-lens-key',
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-worker-'));
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

/** Write one installation and project configuration pair plus the retained task selection. */
async function configuredWorker(options?: {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly workflowPath?: string;
}): Promise<{
  readonly settings: WorkerSettings;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly workspace: string;
}> {
  const root = await temporaryDirectory();
  const installationDirectory = path.join(root, 'installation');
  const projectDirectory = path.join(root, 'project');
  await mkdir(installationDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  const nexus = nexusConfiguration();
  nexus.workflow['finite-delivery'] = options?.workflowPath ?? workflowModule;
  nexus.storage.root = './state';
  const project = projectConfiguration();
  const installationConfigPath = path.join(installationDirectory, 'nexus.config.json');
  const projectConfigPath = path.join(projectDirectory, 'project.config.json');
  await writeFile(installationConfigPath, JSON.stringify(nexus));
  await writeFile(projectConfigPath, JSON.stringify(project));

  // Storage and workspace paths resolve against the installation configuration's directory.
  const storage = path.join(installationDirectory, 'state');
  const executionDirectory = path.join(storage, 'executions', project.taskSource.project);
  const workspace = path.join(storage, 'workspaces', project.taskSource.project, 'NEX-7');
  await mkdir(executionDirectory, { recursive: true });
  await writeFile(
    path.join(executionDirectory, 'selection.json'),
    JSON.stringify({
      taskKey: 'NEX-7',
      source: { kind: 'jira', issueId: '10001' },
      task: { id: '10001', key: 'NEX-7', fields: {} },
      conversation: [],
      workspace: { root: workspace },
    }),
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    workspace,
    settings: {
      projectConfigPath,
      workflow: 'finite-delivery',
      logDirectory: path.join(workspace, 'logs'),
      installationConfigPath,
      environment: { ...credentials, ...options?.environment },
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    },
  };
}

/** Decode the protocol messages one worker run wrote to standard output. */
function messagesOf(stdout: readonly string[]): ReturnType<typeof parseWorkerLine>[] {
  return stdout
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => parseWorkerLine(line));
}

describe('worker entry', () => {
  it('runs the configured workflow and reports its events and final result', async () => {
    const { settings, stdout, stderr, workspace } = await configuredWorker();

    const code = await runWorker(settings);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const messages = messagesOf(stdout);
    expect(messages.some((line) => line.kind === 'invalid')).toBe(false);
    expect(
      messages.filter((line) => line.kind === 'message' && line.message.kind === 'event').length,
    ).toBeGreaterThan(0);
    expect(messages.at(-1)).toEqual({
      kind: 'message',
      message: { kind: 'result', result: { ok: true, value: 'started' } },
    });
    expect(
      JSON.parse(await readFile(path.join(workspace, 'state/current-round.json'), 'utf8')),
    ).toEqual({
      number: 1,
      profile: 'nexus-flash',
      reason: expect.stringContaining('first profile "nexus-flash"'),
    });
    for (const value of Object.values(credentials)) {
      expect(stdout.join('')).not.toContain(value);
    }
  });

  it('fails initialization when a required credential is missing', async () => {
    const { settings, stdout, stderr } = await configuredWorker({
      environment: { JIRA_API_TOKEN: undefined },
    });

    const code = await runWorker(settings);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('initialization');
    expect(stderr.join('')).toContain('JIRA_API_TOKEN');
    expect(stderr.join('')).not.toContain('controlled-lens-key');
  });

  it('fails initialization when the configured workflow cannot be loaded', async () => {
    const { settings, stdout, stderr } = await configuredWorker({
      workflowPath: '/missing/workflow.js',
    });

    const code = await runWorker(settings);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('Cannot load the configured workflow');
  });
});
