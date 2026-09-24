/**
 * Component tests: the real Application loads installation and project configuration and the
 * configured workflow module, launches a controlled worker and decides between completion and the
 * explicit recovery boundary from the worker's events, result, exit and protocol problem. Recovery
 * integration is a separate pending task, so the exercised boundary stops with needs-attention; no
 * child process, service or credential is involved.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApplication,
  type Application,
  type ApplicationSettings,
  type ExecutionEvent,
  type WorkerCompletion,
  type WorkerLaunch,
  type WorkerLaunchRequest,
} from '../src/application/index.js';
import type { RecoveryContext, RecoveryStop } from '../src/application/recovery.js';
import { installationConfigSetting } from '../src/application/installation.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

const workflowModule = fileURLToPath(
  new URL('./fixtures/workflow/start-round.mjs', import.meta.url),
);

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-execution-'));
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

/** One execution harness: a real Application over temp configuration and a controlled worker. */
async function harness(options: {
  readonly completion: WorkerCompletion;
  readonly emit?: (onEvent: (event: ExecutionEvent) => void) => void;
  readonly recovery?: (context: RecoveryContext) => Promise<RecoveryStop>;
}): Promise<{
  readonly application: Application;
  readonly projectConfigPath: string;
  readonly executionDirectory: string;
  readonly events: ExecutionEvent[];
  readonly requests: WorkerLaunchRequest[];
  readonly contexts: RecoveryContext[];
}> {
  const root = await temporaryDirectory();
  const installationDirectory = path.join(root, 'installation');
  const projectDirectory = path.join(root, 'project');
  await mkdir(installationDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  const nexus = nexusConfiguration();
  nexus.workflow.path = workflowModule;
  nexus.storage.root = './state';
  const project = projectConfiguration();
  const installationConfigPath = path.join(installationDirectory, 'nexus.config.json');
  const projectConfigPath = path.join(projectDirectory, 'project.config.json');
  await writeFile(installationConfigPath, JSON.stringify(nexus));
  await writeFile(projectConfigPath, JSON.stringify(project));

  const events: ExecutionEvent[] = [];
  const requests: WorkerLaunchRequest[] = [];
  const contexts: RecoveryContext[] = [];
  const launchWorker: WorkerLaunch = (request, onEvent) => {
    requests.push(request);
    options.emit?.(onEvent);
    return Promise.resolve(options.completion);
  };
  const settings: ApplicationSettings = {
    installationConfigPath,
    environment: {
      AWS_ACCESS_KEY_ID: 'host-access-key',
      AWS_SECRET_ACCESS_KEY: 'host-secret-key',
      JIRA_API_TOKEN: 'host-jira-token',
    },
    launchWorker,
    ...(options.recovery === undefined
      ? {}
      : {
          recovery: async (context: RecoveryContext) => {
            contexts.push(context);
            return options.recovery!(context);
          },
        }),
  };
  const application = createApplication(settings);
  application.subscribe((event) => events.push(event));
  return {
    application,
    projectConfigPath,
    executionDirectory: path.join(installationDirectory, 'state', 'executions', 'NEX'),
    events,
    requests,
    contexts,
  };
}

/** The application lifecycle types one execution emitted, in order. */
function lifecycleOf(events: readonly ExecutionEvent[]): string[] {
  return events.filter((event) => event.source === 'application').map((event) => event.type);
}

describe('Application execution', () => {
  it('completes on a successful terminal outcome and successful exit', async () => {
    const executed = await harness({
      completion: {
        result: { ok: true, value: 'started' },
        exitCode: 0,
        problem: null,
        diagnostics: '',
      },
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(result).toEqual({
      outcome: 'completed',
      reason: 'The workflow finished with the successful outcome "started".',
      report: null,
    });
    expect(lifecycleOf(executed.events)).toEqual(['starting', 'running', 'finished']);
    expect(executed.events.at(-1)?.data).toEqual(result);
    expect(executed.contexts).toEqual([]);
    const request = executed.requests[0];
    expect(request?.projectConfigPath).toBe(executed.projectConfigPath);
    expect(request?.environment[installationConfigSetting]).toBeDefined();
    expect(request?.environment['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(request?.environment['JIRA_API_TOKEN']).toBe('host-jira-token');
  });

  it('forwards worker events unchanged before the lifecycle result', async () => {
    const workerEvent: ExecutionEvent = {
      source: 'execution-runner',
      type: 'state',
      data: { name: 'start' },
    };
    const executed = await harness({
      completion: {
        result: { ok: true, value: 'started' },
        exitCode: 0,
        problem: null,
        diagnostics: '',
      },
      emit: (onEvent) => onEvent(workerEvent),
    });

    await executed.application.execute({ projectConfigPath: executed.projectConfigPath });

    expect(executed.events).toEqual([
      { source: 'application', type: 'starting', data: null },
      { source: 'application', type: 'running', data: null },
      workerEvent,
      {
        source: 'application',
        type: 'finished',
        data: {
          outcome: 'completed',
          reason: 'The workflow finished with the successful outcome "started".',
          report: null,
        },
      },
    ]);
  });

  it('stops with needs-attention at the recovery boundary for a blocked outcome', async () => {
    const executed = await harness({
      completion: {
        result: { ok: true, value: 'blocked' },
        exitCode: 0,
        problem: null,
        diagnostics: 'worker diagnostic\n',
      },
      recovery: () => Promise.resolve({ summary: 'Recovery was invoked.' }),
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(result.outcome).toBe('needs-attention');
    expect(result.report).toBeNull();
    expect(result.reason).toContain('The workflow reached outcome "blocked"');
    expect(result.reason).toContain('worker diagnostic');
    expect(result.reason).toContain('Recovery was invoked.');
    expect(lifecycleOf(executed.events)).toEqual(['starting', 'running', 'recovering', 'finished']);
    expect(executed.contexts).toHaveLength(1);
    expect(executed.contexts[0]?.request).toEqual({
      projectConfigPath: executed.projectConfigPath,
    });
    expect(executed.contexts[0]?.failure).toContain('blocked');
    expect(executed.contexts[0]?.output).toBe('worker diagnostic\n');
    expect(executed.contexts[0]?.execution.workflowStateFile).toMatch(/workflow\.json$/u);
    expect(executed.contexts[0]?.workspace).toBeNull();
  });

  it('reports the retained task workspace when the selection is readable', async () => {
    const executed = await harness({
      completion: {
        result: { ok: false, fault: { message: 'workflow state is invalid' } },
        exitCode: 1,
        problem: null,
        diagnostics: '',
      },
      recovery: () => Promise.resolve({ summary: 'Recovery was invoked.' }),
    });
    await mkdir(executed.executionDirectory, { recursive: true });
    await writeFile(
      path.join(executed.executionDirectory, 'selection.json'),
      JSON.stringify({
        taskKey: 'NEX-7',
        source: { kind: 'jira', issueId: '10001' },
        task: {},
        conversation: [],
        workspace: { root: '/srv/workspaces/NEX/NEX-7' },
      }),
    );

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(result.outcome).toBe('needs-attention');
    expect(result.reason).toContain('Execution fault: workflow state is invalid');
    expect(executed.contexts[0]?.execution.directory).toBe(executed.executionDirectory);
    expect(executed.contexts[0]?.workspace).toEqual({ root: '/srv/workspaces/NEX/NEX-7' });
  });

  it('treats a missing result, failed exit and protocol problem as needing attention', async () => {
    const cases: readonly WorkerCompletion[] = [
      { result: null, exitCode: 0, problem: null, diagnostics: '' },
      { result: { ok: true, value: 'started' }, exitCode: 1, problem: null, diagnostics: '' },
      { result: null, exitCode: null, problem: 'The worker could not start.', diagnostics: '' },
    ];
    for (const completion of cases) {
      const executed = await harness({
        completion,
        recovery: () => Promise.resolve({ summary: 'Recovery was invoked.' }),
      });

      const result = await executed.application.execute({
        projectConfigPath: executed.projectConfigPath,
      });

      expect(result.outcome, JSON.stringify(completion)).toBe('needs-attention');
      expect(executed.contexts).toHaveLength(1);
    }
  });

  it('uses the deferred recovery boundary until recovery integration lands', async () => {
    const executed = await harness({
      completion: {
        result: { ok: true, value: 'blocked' },
        exitCode: 0,
        problem: null,
        diagnostics: '',
      },
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(result.outcome).toBe('needs-attention');
    expect(result.reason).toContain('Recovery integration is not implemented yet');
  });

  it('does not let listener failures affect execution', async () => {
    const executed = await harness({
      completion: {
        result: { ok: true, value: 'started' },
        exitCode: 0,
        problem: null,
        diagnostics: '',
      },
    });
    executed.application.subscribe(() => {
      throw new Error('listener failure');
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(result.outcome).toBe('completed');
  });

  it('rejects an execution request that is not an absolute path', async () => {
    const executed = await harness({
      completion: {
        result: { ok: true, value: 'started' },
        exitCode: 0,
        problem: null,
        diagnostics: '',
      },
    });

    await expect(
      executed.application.execute({ projectConfigPath: 'project.config.json' }),
    ).rejects.toThrow(/is not absolute/u);
  });
});
