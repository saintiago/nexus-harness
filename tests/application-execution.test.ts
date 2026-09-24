/**
 * Component tests: the real Application loads installation and project configuration and the
 * configured workflow module, launches a controlled worker and drives the documented recovery
 * lifecycle over a controlled recovery runtime — the allowance, the operational workspace and
 * context, the report and its publication, resumption and the needs-attention decisions. No child
 * process beyond the controlled launch, service, credential or agent turn is involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentResult } from '../src/agent-runtime/index.js';
import {
  createApplication,
  type Application,
  type ApplicationSettings,
  type ExecutionEvent,
  type WorkerCompletion,
  type WorkerLaunch,
  type WorkerLaunchRequest,
} from '../src/application/index.js';
import {
  recoveryExecutionSchema,
  type RecoveryInvocationRequest,
  type RecoveryNotifier,
  type RecoveryRuntime,
} from '../src/application/recovery.js';
import { installationConfigSetting } from '../src/application/installation.js';
import { fault, ok } from '../src/result.js';
import { completionArtifact } from '../src/task-engine/actions/complete-task/artifacts.js';
import { deliveryArtifact } from '../src/task-engine/actions/deliver/artifacts.js';
import { devArtifact } from '../src/task-engine/actions/develop/artifacts.js';
import { preparedWorkspaceDeclaration } from '../src/task-engine/actions/prepare-workspace/artifacts.js';
import { reviewArtifact } from '../src/task-engine/actions/review/artifacts.js';
import { repairArtifact } from '../src/task-engine/actions/select-repair/artifacts.js';
import { selectionDeclaration } from '../src/task-engine/actions/select-task/artifacts.js';
import { currentRoundDeclaration } from '../src/task-engine/actions/start-round/artifacts.js';
import { verificationArtifact } from '../src/task-engine/actions/verify/artifacts.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

const workflowModule = fileURLToPath(
  new URL('./fixtures/workflow/start-round.mjs', import.meta.url),
);

/** One recovery report serialized as the agent returns it. */
function report(summary: string, kind: 'resume' | 'needs-attention'): string {
  return JSON.stringify({ summary, decision: { kind } });
}

/** One blocked worker completion carrying the supplied diagnostics. */
function stopped(diagnostics: string): WorkerCompletion {
  return {
    result: { ok: true, value: 'blocked' },
    exitCode: 0,
    problem: null,
    diagnostics,
  };
}

const successful: WorkerCompletion = {
  result: { ok: true, value: 'started' },
  exitCode: 0,
  problem: null,
  diagnostics: '',
};

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

/** What one controlled Application run observed. */
type Harness = {
  readonly application: Application;
  readonly projectConfigPath: string;
  readonly executionDirectory: string;
  readonly events: ExecutionEvent[];
  /** The worker launches and recovery invocations, interleaved in the order they happened. */
  readonly timeline: string[];
  readonly launches: WorkerLaunchRequest[];
  readonly invocations: RecoveryInvocationRequest[];
  readonly notifications: { readonly subject: string; readonly body: string }[];
};

/** One execution harness: a real Application over temp configuration and controlled capabilities. */
async function harness(options: {
  /** The completions the worker launches report, in launch order; the last one repeats. */
  readonly completions: readonly WorkerCompletion[];
  readonly emit?: (onEvent: (event: ExecutionEvent) => void) => void;
  readonly agent?: (request: RecoveryInvocationRequest) => Promise<AgentResult>;
  readonly notify?: RecoveryNotifier;
  readonly maxRecoveryAttempts?: number;
}): Promise<Harness> {
  const root = await temporaryDirectory();
  const installationDirectory = path.join(root, 'installation');
  const projectDirectory = path.join(root, 'project');
  await mkdir(installationDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  const nexus = nexusConfiguration();
  nexus.workflow.path = workflowModule;
  nexus.storage.root = './state';
  nexus.executionPolicy.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 1;
  const project = projectConfiguration();
  const installationConfigPath = path.join(installationDirectory, 'nexus.config.json');
  const projectConfigPath = path.join(projectDirectory, 'project.config.json');
  await writeFile(installationConfigPath, JSON.stringify(nexus));
  await writeFile(projectConfigPath, JSON.stringify(project));

  const events: ExecutionEvent[] = [];
  const timeline: string[] = [];
  const launches: WorkerLaunchRequest[] = [];
  const invocations: RecoveryInvocationRequest[] = [];
  const notifications: { subject: string; body: string }[] = [];
  const agent =
    options.agent ??
    (() => Promise.resolve(ok({ output: report('Recovery resumed the queue.', 'resume') })));
  const notify =
    options.notify ?? (() => Promise.resolve(ok({ messageId: 'controlled-message-identity' })));
  const launchWorker: WorkerLaunch = (request, onEvent) => {
    launches.push(request);
    timeline.push('worker');
    options.emit?.(onEvent);
    return Promise.resolve(options.completions[launches.length - 1] ?? stopped('no completion'));
  };
  const settings: ApplicationSettings = {
    installationConfigPath,
    environment: {
      AWS_ACCESS_KEY_ID: 'host-access-key',
      AWS_SECRET_ACCESS_KEY: 'host-secret-key',
      AWS_SESSION_TOKEN: 'host-session-token',
      JIRA_API_TOKEN: 'host-jira-token',
      NEXUS_LENS_PRIVATE_KEY: 'host-lens-key',
    },
    launchWorker,
    recovery: (): RecoveryRuntime => ({
      async invoke(request) {
        invocations.push(request);
        timeline.push('recovery');
        return agent(request);
      },
      async notify(subject, body) {
        notifications.push({ subject, body });
        return notify(subject, body);
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
    timeline,
    launches,
    invocations,
    notifications,
  };
}

/** The application lifecycle types one execution emitted, in order. */
function lifecycleOf(events: readonly ExecutionEvent[]): string[] {
  const lifecycle = new Set(['starting', 'running', 'recovering', 'finished']);
  return events
    .filter((event) => event.source === 'application' && lifecycle.has(event.type))
    .map((event) => event.type);
}

/** The saved recovery execution record. */
async function executionRecord(directory: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(directory, 'recovery', 'execution.json'), 'utf8'));
}

/** One saved report's content. */
async function savedReport(reportPath: string): Promise<unknown> {
  return JSON.parse(await readFile(reportPath, 'utf8'));
}

/** The round artifacts whose declared paths and generated shapes the recovery context must state. */
const roundArtifacts = [
  devArtifact,
  verificationArtifact,
  deliveryArtifact,
  reviewArtifact,
  repairArtifact,
  completionArtifact,
];

/** The producer-owned declarations the context must state, with the path each declares. */
function declaredFormats(
  executionDirectory: string,
): { readonly path: string; readonly schema: z.ZodType }[] {
  return [
    {
      path: path.join(executionDirectory, selectionDeclaration.file),
      schema: selectionDeclaration.schema,
    },
    { path: preparedWorkspaceDeclaration.file, schema: preparedWorkspaceDeclaration.schema },
    { path: currentRoundDeclaration.file, schema: currentRoundDeclaration.schema },
    ...roundArtifacts.map((artifact) => ({
      path: `artifacts/<roundNumber>/${artifact.pathFromArtifactsRoot}`,
      schema: artifact.schema,
    })),
    {
      path: path.join(executionDirectory, 'recovery', 'execution.json'),
      schema: recoveryExecutionSchema,
    },
  ];
}

describe('Application execution', () => {
  it('completes on a successful terminal outcome and successful exit', async () => {
    const executed = await harness({ completions: [successful] });

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
    expect(executed.timeline).toEqual(['worker']);
    expect(executed.invocations).toEqual([]);
    expect(executed.notifications).toEqual([]);
    // The request and the unused allowance are retained even when recovery never runs.
    expect(await executionRecord(executed.executionDirectory)).toEqual({
      request: { projectConfigPath: executed.projectConfigPath },
      invocations: 0,
    });
    const request = executed.launches[0];
    expect(request?.projectConfigPath).toBe(executed.projectConfigPath);
    expect(request?.environment[installationConfigSetting]).toBeDefined();
    expect(request?.environment['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(request?.environment['JIRA_API_TOKEN']).toBe('host-jira-token');
  });

  it('forwards worker events unchanged before the lifecycle result', async () => {
    const workerEvent: ExecutionEvent = {
      source: 'execution-runner',
      type: 'state',
      data: { name: 'select' },
    };
    const executed = await harness({
      completions: [successful],
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

  it('runs recovery between the stopped worker and the resumed worker', async () => {
    const executed = await harness({
      completions: [stopped('worker diagnostic\n'), successful],
      agent: (request) => {
        request.onActivity({ type: 'message', text: 'investigating the state' });
        return Promise.resolve(ok({ output: report('Reconciled and resumable.', 'resume') }));
      },
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    // Work and recovery run sequentially, and the resumed worker gets the same request.
    expect(executed.timeline).toEqual(['worker', 'recovery', 'worker']);
    expect(executed.launches.map((request) => request.projectConfigPath)).toEqual([
      executed.projectConfigPath,
      executed.projectConfigPath,
    ]);
    expect(lifecycleOf(executed.events)).toEqual([
      'starting',
      'running',
      'recovering',
      'running',
      'finished',
    ]);
    expect(executed.events.filter((event) => event.type === 'agent-activity')).toEqual([
      {
        source: 'application',
        type: 'agent-activity',
        data: { type: 'message', text: 'investigating the state' },
      },
    ]);
    expect(executed.events.find((event) => event.type === 'agent-started')?.data).toMatchObject({
      role: 'recovery',
      operation: 'Recovery',
      profile: 'nexus-recovery',
    });
    expect(executed.events.find((event) => event.type === 'agent-finished')?.data).toBeNull();
    expect(result.outcome).toBe('completed');
    expect(result.reason).toBe('The workflow finished with the successful outcome "started".');
    expect(await executionRecord(executed.executionDirectory)).toEqual({
      request: { projectConfigPath: executed.projectConfigPath },
      invocations: 1,
    });
    // The report lives in the execution's own directory, numbered by invocation.
    expect(result.report?.path).toMatch(/\/recovery\/reports\/[^/]+\/1\.json$/u);
    expect(await savedReport(result.report!.path)).toEqual({
      summary: 'Reconciled and resumable.',
      decision: { kind: 'resume' },
    });
    expect(executed.notifications).toHaveLength(1);
    expect(executed.notifications[0]?.subject).toContain('NEX');
    expect(executed.notifications[0]?.subject).toContain('resume');
    expect(executed.notifications[0]?.body).toContain('Reconciled and resumable.');
    expect(executed.notifications[0]?.body).toContain(result.report!.path);
  });

  it('ends with needs-attention when recovery reports it', async () => {
    const executed = await harness({
      completions: [stopped('worker diagnostic\n')],
      agent: () =>
        Promise.resolve(
          ok({ output: report('A human must repair the project.', 'needs-attention') }),
        ),
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(result.outcome).toBe('needs-attention');
    expect(result.reason).toContain('The workflow reached outcome "blocked"');
    expect(result.reason).toContain('worker diagnostic');
    expect(result.reason).toContain('A human must repair the project.');
    expect(executed.timeline).toEqual(['worker', 'recovery']);
    expect(lifecycleOf(executed.events)).toEqual(['starting', 'running', 'recovering', 'finished']);
    expect(await savedReport(result.report!.path)).toEqual({
      summary: 'A human must repair the project.',
      decision: { kind: 'needs-attention' },
    });
    expect(executed.notifications).toHaveLength(1);
  });

  it('runs recovery in its own operational workspace with the complete context', async () => {
    const taskWorkspace = '/srv/nexus/workspaces/NEX/NEX-7';
    const executed = await harness({
      completions: [
        {
          result: { ok: false, fault: { message: 'workflow state is invalid' } },
          exitCode: 1,
          problem: null,
          diagnostics: 'worker diagnostic\n',
        },
      ],
      agent: () => Promise.resolve(ok({ output: report('Recovered.', 'needs-attention') })),
    });
    await mkdir(executed.executionDirectory, { recursive: true });
    await writeFile(
      path.join(executed.executionDirectory, 'selection.json'),
      JSON.stringify({
        taskKey: 'NEX-7',
        source: { kind: 'jira', issueId: '10001' },
        task: {},
        conversation: [],
        workspace: { root: taskWorkspace },
      }),
    );

    await executed.application.execute({ projectConfigPath: executed.projectConfigPath });

    const invocation = executed.invocations[0];
    expect(invocation?.workspace.root).toBe(
      path.join(executed.executionDirectory, 'recovery', 'workspace'),
    );
    expect(invocation?.workspace.root).not.toBe(taskWorkspace);
    // The operational workspace's working directory exists before the invocation starts.
    expect((await stat(path.join(invocation!.workspace.root, 'worktree'))).isDirectory()).toBe(
      true,
    );
    const context = invocation?.context ?? '';
    expect(context).toContain(executed.projectConfigPath);
    expect(context).toContain('Execution fault: workflow state is invalid');
    expect(context).toContain('worker diagnostic');
    expect(context).toContain(path.join(executed.executionDirectory, 'workflow.json'));
    expect(context).toContain(path.join(executed.executionDirectory, 'selection.json'));
    expect(context).toContain(path.join(executed.executionDirectory, 'recovery'));
    expect(context).toContain(workflowModule);
    expect(context).toContain('Successful terminal outcomes: started');
    // The selected workflow definition is included so reconciliation uses its actual states.
    expect(context).toContain('"id": "start-round"');
    expect(context).toContain('"src": "StartRound"');
    expect(context).toContain(taskWorkspace);
    expect(context).toContain('NEX-7');
    expect(context).toContain('recovery invocation 1 of 1');
    // Reconciliation receives each producer-owned declaration's actual path and generated shape.
    for (const declaration of declaredFormats(executed.executionDirectory)) {
      expect(context, declaration.path).toContain(`Path: ${declaration.path}`);
      expect(context, declaration.path).toContain(
        JSON.stringify(z.toJSONSchema(declaration.schema), null, 2),
      );
    }
    // The response format and the current-project scope are part of the context.
    expect(context).toContain('"decision": {"kind": "resume"}');
    expect(context).toContain('Cross-project repair');
    // Credential values stay in host settings; the context carries references and no secrets.
    expect(context).not.toContain('host-access-key');
    expect(context).not.toContain('host-secret-key');
    expect(context).not.toContain('host-session-token');
    expect(context).not.toContain('host-jira-token');
    expect(context).not.toContain('host-lens-key');
  });

  it('treats unusable recovery output as a failed invocation', async () => {
    const unusable = [
      'not JSON at all',
      '{"summary":"cause","decision":{"kind":"recover"}}',
      '{"summary":"cause"}',
      '{"summary":"   ","decision":{"kind":"resume"}}',
      '{"summary":"cause","decision":{"kind":"resume"},"extra":true}',
    ];
    for (const output of unusable) {
      const executed = await harness({
        completions: [stopped('')],
        agent: () => Promise.resolve(ok({ output })),
      });

      const result = await executed.application.execute({
        projectConfigPath: executed.projectConfigPath,
      });

      expect(result.outcome, output).toBe('needs-attention');
      expect(result.reason, output).toContain('The recovery invocation failed');
      expect(result.report, output).toBeNull();
      expect(executed.timeline, output).toEqual(['worker', 'recovery']);
      expect(executed.notifications, output).toEqual([]);
      expect(await executionRecord(executed.executionDirectory), output).toMatchObject({
        invocations: 1,
      });
    }
  });

  it('ends with needs-attention when the recovery invocation faults', async () => {
    const executed = await harness({
      completions: [stopped('')],
      agent: () => Promise.resolve({ ok: false, fault: { message: 'provider unavailable' } }),
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(result.outcome).toBe('needs-attention');
    expect(result.reason).toContain('The recovery invocation failed: provider unavailable');
    expect(result.report).toBeNull();
    expect(executed.notifications).toEqual([]);
  });

  it('consumes the persisted allowance across worker restarts', async () => {
    const executed = await harness({
      maxRecoveryAttempts: 1,
      completions: [stopped('first stop\n'), stopped('second stop\n')],
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    // The resumed worker's failure consumes no further allowance: recovery ran only once.
    expect(executed.timeline).toEqual(['worker', 'recovery', 'worker']);
    expect(executed.invocations).toHaveLength(1);
    expect(result.outcome).toBe('needs-attention');
    expect(result.reason).toContain('The workflow reached outcome "blocked"');
    expect(result.reason).toContain(
      'The configured recovery allowance of 1 invocation is exhausted.',
    );
    expect(executed.notifications).toHaveLength(1);
    expect(await executionRecord(executed.executionDirectory)).toEqual({
      request: { projectConfigPath: executed.projectConfigPath },
      invocations: 1,
    });
  });

  it('saves one report per invocation and stops at the invocation that needs attention', async () => {
    const outputs = [
      report('First attempt reconciled.', 'resume'),
      report('Second attempt needs a human.', 'needs-attention'),
    ];
    let invocations = 0;
    const executed = await harness({
      maxRecoveryAttempts: 2,
      completions: [stopped('first stop\n'), stopped('second stop\n')],
      agent: () => Promise.resolve(ok({ output: outputs[invocations++] ?? '' })),
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(executed.timeline).toEqual(['worker', 'recovery', 'worker', 'recovery']);
    expect(await executionRecord(executed.executionDirectory)).toEqual({
      request: { projectConfigPath: executed.projectConfigPath },
      invocations: 2,
    });
    expect(result.outcome).toBe('needs-attention');
    expect(result.reason).toContain('Second attempt needs a human.');
    // One execution keeps its sequential report numbering inside its own report directory.
    expect(result.report?.path).toMatch(/\/recovery\/reports\/[^/]+\/2\.json$/u);
    const reportDirectory = path.dirname(result.report!.path);
    expect(await savedReport(path.join(reportDirectory, '1.json'))).toEqual({
      summary: 'First attempt reconciled.',
      decision: { kind: 'resume' },
    });
    // The second invocation is told about the report the first one saved.
    expect(executed.invocations[1]?.context).toContain(path.join(reportDirectory, '1.json'));
    expect(executed.notifications).toHaveLength(2);
  });

  it('preserves saved reports across execute calls on the same project storage', async () => {
    const outputs = [
      report('The first execution needs a human.', 'needs-attention'),
      report('The second execution needs a human.', 'needs-attention'),
    ];
    let invocations = 0;
    const executed = await harness({
      completions: [stopped('first stop\n'), stopped('second stop\n')],
      agent: () => Promise.resolve(ok({ output: outputs[invocations++] ?? '' })),
    });

    const first = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });
    const second = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    // Each execute call resets the invocation numbering, but never the other execution's reports.
    expect(first.report?.path).toMatch(/\/recovery\/reports\/[^/]+\/1\.json$/u);
    expect(second.report?.path).toMatch(/\/recovery\/reports\/[^/]+\/1\.json$/u);
    expect(first.report?.path).not.toBe(second.report?.path);
    expect(await savedReport(first.report!.path)).toEqual({
      summary: 'The first execution needs a human.',
      decision: { kind: 'needs-attention' },
    });
    expect(await savedReport(second.report!.path)).toEqual({
      summary: 'The second execution needs a human.',
      decision: { kind: 'needs-attention' },
    });
    // The second execute call began a fresh allowance over the same execution directory.
    expect(await executionRecord(executed.executionDirectory)).toEqual({
      request: { projectConfigPath: executed.projectConfigPath },
      invocations: 1,
    });
  });

  it('reports notification failure separately without repeating recovery', async () => {
    const executed = await harness({
      completions: [stopped('controlled stop\n'), successful],
      notify: () =>
        Promise.resolve(fault('The SNS publication failed: InternalErrorException (HTTP 500)')),
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(result.outcome).toBe('completed');
    expect(result.reason).toContain('The workflow finished with the successful outcome "started".');
    expect(result.reason).toContain(
      'Recovery report delivery failed: The SNS publication failed: InternalErrorException (HTTP 500)',
    );
    expect(executed.invocations).toHaveLength(1);
    expect(executed.notifications).toHaveLength(1);
  });

  it('treats a missing result, failed exit and protocol problem as needing attention', async () => {
    const cases: readonly WorkerCompletion[] = [
      { result: null, exitCode: 0, problem: null, diagnostics: '' },
      { result: { ok: true, value: 'started' }, exitCode: 1, problem: null, diagnostics: '' },
      { result: null, exitCode: null, problem: 'The worker could not start.', diagnostics: '' },
    ];
    for (const completion of cases) {
      const executed = await harness({
        completions: [completion],
        agent: () =>
          Promise.resolve(ok({ output: report('Needs the operator.', 'needs-attention') })),
      });

      const result = await executed.application.execute({
        projectConfigPath: executed.projectConfigPath,
      });

      expect(result.outcome, JSON.stringify(completion)).toBe('needs-attention');
      expect(executed.invocations, JSON.stringify(completion)).toHaveLength(1);
    }
  });

  it('does not let listener failures affect execution', async () => {
    const executed = await harness({ completions: [successful] });
    executed.application.subscribe(() => {
      throw new Error('listener failure');
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
    });

    expect(result.outcome).toBe('completed');
  });

  it('rejects an execution request that is not an absolute path', async () => {
    const executed = await harness({ completions: [successful] });

    await expect(
      executed.application.execute({ projectConfigPath: 'project.config.json' }),
    ).rejects.toThrow(/is not absolute/u);
  });
});
