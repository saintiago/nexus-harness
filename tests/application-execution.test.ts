/**
 * Component tests: the real Application loads installation and project configuration and the
 * configured workflow module, launches a controlled worker and drives the documented recovery
 * lifecycle over a controlled recovery runtime — the allowance, the operational workspace and
 * context, the report and its publication, resumption and the needs-attention decisions. The
 * operational worktree's Git initialization is the only child process besides the controlled
 * launch; no live service, credential or agent turn is involved.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
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
  type RecoveryReport,
  type RecoveryRuntime,
} from '../src/application/recovery.js';
import { installationConfigSetting } from '../src/application/installation.js';
import { fault, ok } from '../src/result.js';
import type { AgentActivity } from '../src/task-engine/index.js';
import {
  experienceEvidenceRoot,
  experienceIdentity,
  experienceObservationSourceKey,
  type ExperienceHandoff,
} from '../src/task-engine/actions/analyze-experience/artifacts.js';
import {
  createAnalyzeExperience,
  type ExperienceAnalystRequest,
} from '../src/task-engine/actions/analyze-experience/index.js';
import {
  readPendingValidationError,
  readValidationErrorHistory,
  type ReportScope,
} from '../src/task-engine/actions/report-feedback.js';
import { completionArtifact } from '../src/task-engine/actions/complete-task/artifacts.js';
import { deliveryArtifact } from '../src/task-engine/actions/deliver/artifacts.js';
import { devArtifact } from '../src/task-engine/actions/develop/artifacts.js';
import { preparedWorkspaceDeclaration } from '../src/task-engine/actions/prepare-workspace/artifacts.js';
import { implementationInputDeclaration } from '../src/task-engine/actions/project/implementation-handoff/artifacts.js';
import { reviewArtifact } from '../src/task-engine/actions/review/artifacts.js';
import { selectionDeclaration } from '../src/task-engine/actions/select-task/artifacts.js';
import { currentRoundDeclaration } from '../src/task-engine/actions/start-round/artifacts.js';
import { verificationArtifact } from '../src/task-engine/actions/verify/artifacts.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';
import { controlledMemoryService, type ControlledMemoryService } from './support/memory.js';

const workflowModule = fileURLToPath(
  new URL('./fixtures/workflow/start-round.mjs', import.meta.url),
);

/** Run one Git command to observe the operational worktree the provider receives. */
const execFileAsync = promisify(execFile);

/** One recovery decision serialized as the agent returns it; narrative belongs in Markdown. */
function decision(kind: 'resume' | 'needs-attention'): string {
  return JSON.stringify({ decision: { kind } });
}

/** One controlled recovery turn: it writes the assigned Markdown and returns the decision. */
function recoveringTurn(
  kind: 'resume' | 'needs-attention',
  markdown: string,
): (request: RecoveryInvocationRequest) => Promise<AgentResult> {
  return async (request) => {
    await writeFile(request.reportPath, markdown, 'utf8');
    return ok({ output: decision(kind) });
  };
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
const memoryServices: ControlledMemoryService[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-execution-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** One controlled AMEM service closed after the test. */
async function controlledService(): Promise<ControlledMemoryService> {
  const service = await controlledMemoryService();
  memoryServices.push(service);
  return service;
}

afterEach(async () => {
  await Promise.all([
    ...memoryServices.splice(0).map((service) => service.close()),
    ...temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  ]);
});

/** What one controlled Application run observed. */
type Harness = {
  readonly application: Application;
  readonly projectConfigPath: string;
  readonly executionDirectory: string;
  readonly events: ExecutionEvent[];
  /** The attributable activity packets Application forwarded while it ran. */
  readonly activity: AgentActivity[];
  /** The worker launches and recovery invocations, interleaved in the order they happened. */
  readonly timeline: string[];
  readonly launches: WorkerLaunchRequest[];
  readonly invocations: RecoveryInvocationRequest[];
  readonly notifications: { readonly subject: string; readonly body: string }[];
  readonly diagnostics: string[];
};

/** What one controlled worker reports through the protocol boundaries Application supplies. */
type ControlledWorker = {
  readonly logDirectory: string;
  event(event: ExecutionEvent): void;
  activity(activity: AgentActivity): void;
};

/** One execution harness: a real Application over temp configuration and controlled capabilities. */
async function harness(options: {
  /** The completions the worker launches report, in launch order; the last one repeats. */
  readonly completions: readonly WorkerCompletion[];
  /** Use the shipped state definitions when testing ownership across restoration. */
  readonly realWorkflows?: boolean;
  /** What the controlled worker reports: events, activity and its execution log directory. */
  readonly emit?: (worker: ControlledWorker) => void;
  readonly agent?: (request: RecoveryInvocationRequest) => Promise<AgentResult>;
  readonly notify?: RecoveryNotifier;
  readonly maxRecoveryAttempts?: number;
  /** Whether the configured memory integration is enabled for the execution. */
  readonly memory?: boolean;
  /** The memory service transport; a controlled one proves no service call is made. */
  readonly memoryTransport?: typeof globalThis.fetch;
  /** The memory service URL the configured integration points at. */
  readonly memoryServiceUrl?: string;
  /** The controlled experience analyst; it runs in the parent, after the worker exits. */
  readonly analysis?: (request: ExperienceAnalystRequest) => Promise<AgentResult>;
}): Promise<Harness> {
  const root = await temporaryDirectory();
  const installationDirectory = path.join(root, 'installation');
  const projectDirectory = path.join(root, 'project');
  await mkdir(installationDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  const nexus = nexusConfiguration();
  nexus.workflow.project = workflowModule;
  if (options.realWorkflows) {
    nexus.workflow.project = fileURLToPath(new URL('../workflows/project.ts', import.meta.url));
    nexus.workflow.children['finite-delivery'] = fileURLToPath(
      new URL('../workflows/finite-delivery.ts', import.meta.url),
    );
    nexus.workflow.children['idea-refinement'] = fileURLToPath(
      new URL('../workflows/idea-refinement.ts', import.meta.url),
    );
    nexus.workflow.children.preparation = fileURLToPath(
      new URL('../workflows/preparation.ts', import.meta.url),
    );
  }
  nexus.storage.root = './state';
  nexus.executionPolicy.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 1;
  if (options.memory === true) {
    nexus.memory = {
      enabled: true,
      serviceUrl: options.memoryServiceUrl ?? 'http://127.0.0.1:1',
      mcp: { command: 'npm', args: ['run', '--silent', 'mcp'], directory: './agentic-memory' },
      analysisProfile: 'nexus-astra',
    };
  }
  const project = projectConfiguration();
  const installationConfigPath = path.join(installationDirectory, 'nexus.config.json');
  const projectConfigPath = path.join(projectDirectory, 'project.config.json');
  await writeFile(installationConfigPath, JSON.stringify(nexus));
  await writeFile(projectConfigPath, JSON.stringify(project));

  const events: ExecutionEvent[] = [];
  const activity: AgentActivity[] = [];
  const timeline: string[] = [];
  const launches: WorkerLaunchRequest[] = [];
  const invocations: RecoveryInvocationRequest[] = [];
  const notifications: { subject: string; body: string }[] = [];
  const diagnostics: string[] = [];
  const agent = options.agent ?? recoveringTurn('resume', 'Recovery resumed the queue.');
  const notify =
    options.notify ?? (() => Promise.resolve(ok({ messageId: 'controlled-message-identity' })));
  const launchWorker: WorkerLaunch = (request, onEvent, onActivity) => {
    launches.push(request);
    timeline.push('worker');
    options.emit?.({ logDirectory: request.logDirectory, event: onEvent, activity: onActivity });
    return Promise.resolve(options.completions[launches.length - 1] ?? stopped('no completion'));
  };
  const settings: ApplicationSettings = {
    installationConfigPath,
    environment: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      AWS_ACCESS_KEY_ID: 'host-access-key',
      AWS_SECRET_ACCESS_KEY: 'host-secret-key',
      AWS_SESSION_TOKEN: 'host-session-token',
      JIRA_API_TOKEN: 'host-jira-token',
      NEXUS_LENS_PRIVATE_KEY: 'host-lens-key',
    },
    launchWorker,
    ...(options.memoryTransport === undefined ? {} : { memoryTransport: options.memoryTransport }),
    diagnostics: {
      write: (text) => {
        diagnostics.push(text);
      },
    },
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
    ...(options.analysis === undefined ? {} : { analysis: () => options.analysis! }),
  };
  const application = createApplication(settings);
  application.subscribe((event) => events.push(event));
  application.subscribeActivity((packet) => activity.push(packet));
  return {
    application,
    projectConfigPath,
    executionDirectory: path.join(installationDirectory, 'state', 'executions', 'NEX'),
    events,
    activity,
    timeline,
    launches,
    invocations,
    notifications,
    diagnostics,
  };
}

/** The application lifecycle types one execution emitted, in order. */
function lifecycleOf(events: readonly ExecutionEvent[]): string[] {
  const lifecycle = new Set(['starting', 'running', 'recovering', 'recovered', 'finished']);
  return events
    .filter((event) => event.source === 'application' && lifecycle.has(event.type))
    .map((event) => event.type);
}

/**
 * Record one terminal handoff in the execution's durable store, as the worker's bound
 * AnalyzeExperience action does when a workflow reaches a terminal state.
 */
async function recordHandoff(
  executionDirectory: string,
  handoff: ExperienceHandoff,
): Promise<void> {
  const owner = createAnalyzeExperience({
    directory: path.join(executionDirectory, 'memory'),
    project: 'NEX',
    profile: 'nexus-astra',
    // Capturing never contacts the service, so an unreachable URL is sufficient here.
    memory: { url: 'http://127.0.0.1:1' },
    analyze: null,
  });
  const captured = await owner.capture(handoff);
  expect(captured.outcome).toBe('recorded');
}

/** The saved recovery execution record. */
async function executionRecord(directory: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(directory, 'recovery', 'execution.json'), 'utf8'));
}

/** One saved report's content. */
async function savedReport(reportPath: string): Promise<unknown> {
  return JSON.parse(await readFile(reportPath, 'utf8'));
}

/** One execution's saved log: its filepath and parsed entries, in file order. */
type SavedLog = {
  readonly file: string;
  readonly entries: readonly { readonly timestamp: string; readonly event: ExecutionEvent }[];
};

/** The execution's saved event logs, one per execute call. */
async function savedLogs(executionDirectory: string): Promise<SavedLog[]> {
  const directories = (await readdir(path.join(executionDirectory, 'logs'))).sort();
  return Promise.all(
    directories.map(async (directory) => {
      const file = path.join(executionDirectory, 'logs', directory, 'events.jsonl');
      return {
        file,
        entries: (await readFile(file, 'utf8'))
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line) as SavedLog['entries'][number]),
      };
    }),
  );
}

/** The round artifacts whose declared paths and generated shapes the recovery context must state. */
const roundArtifacts = [
  devArtifact,
  verificationArtifact,
  deliveryArtifact,
  reviewArtifact,
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
    {
      path: implementationInputDeclaration.file,
      schema: implementationInputDeclaration.schema,
    },
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
  it('runs the project parent in one execution directory', async () => {
    const executed = await harness({
      completions: [
        { result: { ok: true, value: 'started' }, exitCode: 0, problem: null, diagnostics: '' },
      ],
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(result).toEqual({
      outcome: 'completed',
      reason: 'The workflow finished with the successful outcome "started".',
      report: null,
    });
    // The parent and every stage child share one execution directory and log.
    expect(executed.launches[0]?.workflow).toBe('project');
    const logs = await readdir(path.join(executed.executionDirectory, 'logs'));
    expect(logs).toHaveLength(1);
    await expect(
      readFile(path.join(executed.executionDirectory, 'logs', logs[0]!, 'events.jsonl'), 'utf8'),
    ).resolves.toContain('"type":"finished"');
  });

  it('completes on a successful terminal outcome and successful exit', async () => {
    const executed = await harness({ completions: [successful] });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
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
      request: { projectConfigPath: executed.projectConfigPath, workflow: 'project' },
      invocations: 0,
      reports: [],
    });
    const request = executed.launches[0];
    expect(request?.projectConfigPath).toBe(executed.projectConfigPath);
    expect(request?.environment[installationConfigSetting]).toBeDefined();
    expect(request?.environment['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(request?.environment['JIRA_API_TOKEN']).toBe('host-jira-token');
  });

  it('completes with memory enabled without contacting the configured service', async () => {
    const executed = await harness({
      completions: [successful],
      memory: true,
      memoryTransport: () => {
        throw new Error('the execution lifecycle must not call the memory service');
      },
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(result).toEqual({
      outcome: 'completed',
      reason: 'The workflow finished with the successful outcome "started".',
      report: null,
    });
    // Memory is supplemental: an unreachable service changes no lifecycle event or diagnostic.
    expect(lifecycleOf(executed.events)).toEqual(['starting', 'running', 'finished']);
    expect(executed.diagnostics).toEqual([]);
  });

  it('settles a confirmed completion after the worker exits and resumes it on restart', async () => {
    const service = await controlledService();
    const workspace = path.join(await temporaryDirectory(), 'NEX-1');
    const evidence = path.join(workspace, 'artifacts', '1', 'completion.json');
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(evidence, '{"mergeRevision":"4444"}\n');
    const analyses: ExperienceAnalystRequest[] = [];
    const executed = await harness({
      completions: [successful, successful],
      memory: true,
      memoryServiceUrl: service.url,
      analysis: async (request) => {
        analyses.push(request);
        await writeFile(
          request.reportPath,
          'The completion evidence must be read after the Done transition.',
          'utf8',
        );
        return ok({
          output: JSON.stringify({
            observations: [
              {
                content: 'The completion evidence must be read after the Done transition.',
                evidence: [
                  {
                    path: evidence,
                    revision: '4'.repeat(40),
                    detail: 'The completion artifact.',
                  },
                ],
                relatedMemories: [],
              },
            ],
          }),
        });
      },
    });
    // The worker recorded the confirmed completion in the execution's durable store.
    const handoff: ExperienceHandoff = {
      workId: 'NEX-1',
      workflow: 'project',
      attemptId: 'task/NEX-1',
      terminalId: 'complete-completed',
      outcome: 'completed',
      reason: null,
      workspaceRoot: workspace,
      artifacts: [{ path: evidence }],
    };
    await recordHandoff(executed.executionDirectory, handoff);
    const identity = experienceIdentity(handoff);

    const first = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    // The business outcome is unchanged and the analysis ran after the worker exit.
    expect(first.outcome).toBe('completed');
    expect(executed.timeline).toEqual(['worker']);
    expect(analyses).toHaveLength(1);
    // The analyst reads the retained copy of the handoff's evidence, not the mutable workspace.
    expect(analyses[0]?.workspace.root).toBe(
      experienceEvidenceRoot(path.join(executed.executionDirectory, 'memory'), identity),
    );
    expect(analyses[0]?.outputSchema).toMatchObject({ type: 'object' });
    expect(service.observations.size).toBe(1);
    // Durable acceptance is reported as outstanding until the receipt is stored.
    expect(executed.diagnostics.join('')).toContain(
      'Nexus memory analysis: the submission of observation 1 of NEX-1 is outstanding',
    );

    // The next start reuses the persisted analysis output and settles the stored receipt.
    service.store(experienceObservationSourceKey(identity, '1'));
    const reported = executed.diagnostics.length;
    const second = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(second.outcome).toBe('completed');
    expect(analyses).toHaveLength(1);
    // The stored receipt produced no further outstanding analysis or submission.
    expect(executed.diagnostics.slice(reported)).toEqual([]);
    expect(service.requests.filter((request) => request.path === '/v1/observations')).toHaveLength(
      1,
    );
  });

  it('reports a failed analysis without changing the completed outcome', async () => {
    const service = await controlledService();
    const workspace = path.join(await temporaryDirectory(), 'NEX-1');
    const evidence = path.join(workspace, 'artifacts', '1', 'completion.json');
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(evidence, '{"mergeRevision":"4444"}\n');
    const executed = await harness({
      completions: [successful],
      memory: true,
      memoryServiceUrl: service.url,
      analysis: () => Promise.reject(new Error('The analysis provider is unavailable.')),
    });
    await recordHandoff(executed.executionDirectory, {
      workId: 'NEX-1',
      workflow: 'project',
      attemptId: 'task/NEX-1',
      terminalId: 'complete-completed',
      outcome: 'completed',
      reason: null,
      workspaceRoot: workspace,
      artifacts: [{ path: evidence }],
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(result.outcome).toBe('completed');
    expect(executed.invocations).toEqual([]);
    expect(service.requests).toEqual([]);
    expect(executed.diagnostics.join('')).toContain(
      'Nexus memory analysis: the experience analysis of NEX-1',
    );
    expect(executed.diagnostics.join('')).toContain('is outstanding');
  });

  it('records the stopped invocation before recovery and analyzes its retained fault', async () => {
    const service = await controlledService();
    const workspace = path.join(await temporaryDirectory(), 'NEX-1');
    const evidence = path.join(workspace, 'artifacts', '1', 'delivery.json');
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(evidence, '{"headRevision":"aaaa"}\n');
    await mkdir(path.join(workspace, 'state'), { recursive: true });
    await writeFile(
      path.join(workspace, 'state', 'current-round.json'),
      '{"number":1,"profile":"nexus-flash","reason":"the interrupted round"}\n',
    );
    const analyses: ExperienceAnalystRequest[] = [];
    const executed = await harness({
      completions: [
        {
          result: { ok: false, fault: { message: 'the provider invocation failed' } },
          exitCode: 1,
          problem: null,
          diagnostics: 'the worker died after selecting the item',
        },
        successful,
      ],
      memory: true,
      memoryServiceUrl: service.url,
      // The invocation's own events establish the attempt it worked on.
      emit: ({ event }) =>
        event({
          source: 'select-work',
          type: 'outcome',
          data: {
            task: 'NEX-1',
            round: null,
            outcome: 'selected',
            detail: null,
            artifact: { path: '/execution/selection.json' },
          },
        }),
      analysis: async (request) => {
        analyses.push(request);
        await writeFile(request.reportPath, 'No reusable lesson was found.', 'utf8');
        return ok({ output: JSON.stringify({ observations: [] }) });
      },
    });
    // The retained selection names the interrupted attempt Application records the fault for.
    await mkdir(executed.executionDirectory, { recursive: true });
    await writeFile(
      path.join(executed.executionDirectory, 'selection.json'),
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: { id: '10518', key: 'NEX-1', fields: { summary: 'Interrupted work' } },
        conversation: [],
        workspace: { root: workspace },
        stage: 'delivery',
      }),
    );

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    // The fault was recorded with its evidence and analyzed before recovery replaced the attempt;
    // the recovery destination and the resumed execution are unchanged.
    expect(result.outcome).toBe('completed');
    expect(executed.timeline).toEqual(['worker', 'recovery', 'worker']);
    expect(analyses).toHaveLength(1);
    expect(analyses[0]?.context).toContain('the provider invocation failed');
    expect(analyses[0]?.context).toContain(evidence);
    const requests = await readdir(path.join(executed.executionDirectory, 'memory', 'requests'));
    expect(requests).toHaveLength(1);
  });

  it('records no operational handoff for a declared blocked outcome or a failed selection', async () => {
    const workspace = path.join(await temporaryDirectory(), 'NEX-1');
    await mkdir(workspace, { recursive: true });
    const executed = await harness({
      completions: [stopped('the selection found no eligible item\n'), successful],
      memory: true,
      memoryServiceUrl: 'http://127.0.0.1:1',
      emit: ({ event }) =>
        event({
          source: 'select-work',
          type: 'failed',
          data: { reason: 'The task source is unavailable.' },
        }),
    });
    // An earlier attempt left its selection behind; the blocked outcome is not an operational fault.
    await mkdir(executed.executionDirectory, { recursive: true });
    await writeFile(
      path.join(executed.executionDirectory, 'selection.json'),
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: { id: '10518', key: 'NEX-1', fields: { summary: 'Interrupted work' } },
        conversation: [],
        workspace: { root: workspace },
        stage: 'delivery',
      }),
    );

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(result.outcome).toBe('completed');
    // Neither the failed selection nor the later stopped invocation recorded an operational fault.
    await expect(stat(path.join(executed.executionDirectory, 'memory'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // A blocked outcome that published no selection event of its own records nothing either: the
    // retained selection belongs to a previous attempt, whichever outcome that attempt reached.
    const silent = await harness({
      completions: [stopped('the workflow declared its blocked outcome\n'), successful],
      memory: true,
      memoryServiceUrl: 'http://127.0.0.1:1',
    });
    await mkdir(silent.executionDirectory, { recursive: true });
    await writeFile(
      path.join(silent.executionDirectory, 'selection.json'),
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: { id: '10518', key: 'NEX-1', fields: { summary: 'Interrupted work' } },
        conversation: [],
        workspace: { root: workspace },
        stage: 'delivery',
      }),
    );

    const silentResult = await silent.application.execute({
      projectConfigPath: silent.projectConfigPath,
      workflow: 'project',
    });

    expect(silentResult.outcome).toBe('completed');
    await expect(stat(path.join(silent.executionDirectory, 'memory'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('records no second operational handoff when the workflow already captured the attempt', async () => {
    const executed = await harness({
      completions: [
        {
          result: { ok: false, fault: { message: 'the provider invocation failed' } },
          exitCode: 1,
          problem: null,
          diagnostics: '',
        },
        successful,
      ],
      memory: true,
      memoryServiceUrl: 'http://127.0.0.1:1',
      emit: ({ event }) => {
        event({
          source: 'select-task',
          type: 'outcome',
          data: {
            task: 'NEX-1',
            round: null,
            outcome: 'selected',
            detail: null,
            artifact: { path: '/execution/selection.json' },
          },
        });
        event({
          source: 'analyze-experience',
          type: 'outcome',
          data: {
            task: 'NEX-1',
            round: null,
            outcome: 'recorded',
            detail: 'NEX-1 finite-delivery/task/NEX-1/complete-completed ("completed")',
            artifact: { path: '/execution/memory/captures/NEX-1.json' },
          },
        });
      },
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(result.outcome).toBe('completed');
    await expect(stat(path.join(executed.executionDirectory, 'memory'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['idea', 'delivery'] as const)(
    'requires current worker evidence of ownership for %s-stage faults',
    async (stage) => {
      const selectionSource = 'select-work';
      for (const scenario of [
        'initialization',
        'selection-throws',
        'restored-capture',
        'restored-unavailable',
        'restored-active',
        'after-recovery',
      ] as const) {
        const workspace = path.join(await temporaryDirectory(), 'NEX-1');
        await mkdir(workspace, { recursive: true });
        let launches = 0;
        const faulted: WorkerCompletion = {
          result: { ok: false, fault: { message: 'workflow persistence or source access failed' } },
          exitCode: 1,
          problem: null,
          diagnostics: '',
        };
        const executed = await harness({
          realWorkflows: true,
          completions: scenario === 'after-recovery' ? [stopped('blocked'), faulted] : [faulted],
          maxRecoveryAttempts: scenario === 'after-recovery' ? 2 : 1,
          memory: true,
          analysis: async (request) => {
            await writeFile(request.reportPath, 'No reusable lesson was found.', 'utf8');
            return ok({ output: JSON.stringify({ observations: [] }) });
          },
          agent: async (request) => {
            const kind =
              scenario === 'after-recovery' && launches === 1 ? 'resume' : 'needs-attention';
            await writeFile(
              request.reportPath,
              'The interrupted execution was reconciled.',
              'utf8',
            );
            return ok({ output: decision(kind) });
          },
          emit: ({ event }) => {
            launches += 1;
            if (scenario === 'selection-throws') {
              event({
                source: 'execution-runner',
                type: 'state',
                data: { value: 'select' },
              });
              // Source access throws before SelectWork can publish a failed outcome.
            } else if (scenario === 'restored-capture') {
              event({
                source: 'analyze-experience',
                type: 'outcome',
                data: {
                  task: 'NEX-1',
                  outcome: 'recorded',
                  round: null,
                  detail: null,
                  artifact: { path: '/memory/capture.json' },
                },
              });
            } else if (scenario === 'restored-unavailable') {
              event({
                source: 'analyze-experience',
                type: 'unavailable',
                data: {
                  terminal: 'complete-completed',
                  reason: 'The selection could not be read.',
                },
              });
            } else if (scenario === 'restored-active') {
              event({
                source: 'execution-runner',
                type: 'state',
                data: { value: stage },
              });
            } else if (scenario === 'after-recovery' && launches === 1) {
              event({
                source: selectionSource,
                type: 'outcome',
                data: {
                  task: 'NEX-1',
                  outcome: 'selected',
                  round: null,
                  detail: null,
                  artifact: { path: '/execution/selection.json' },
                },
              });
            }
            if (scenario === 'restored-capture' || scenario === 'restored-unavailable') {
              // A state observation can arrive after the restored action's own outcome.
              event({
                source: 'execution-runner',
                type: 'state',
                data: {
                  value: stage,
                },
              });
            }
          },
        });
        const directory = executed.executionDirectory;
        await mkdir(directory, { recursive: true });
        const issue = { id: '10518', key: 'NEX-1', fields: { summary: 'Retained work' } };
        await writeFile(
          path.join(directory, 'selection.json'),
          JSON.stringify({
            taskKey: 'NEX-1',
            source: { kind: 'jira', issueId: '10518' },
            task: issue,
            conversation: [],
            workspace: { root: workspace },
            stage,
          }),
        );
        await executed.application.execute({
          projectConfigPath: executed.projectConfigPath,
          workflow: 'project',
        });
        const requests = path.join(directory, 'memory', 'requests');
        if (scenario === 'restored-active') {
          expect(await readdir(requests), scenario).toHaveLength(1);
        } else {
          await expect(stat(requests), scenario).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
    },
  );

  it('records no operational handoff without a retained selection or when memory is disabled', async () => {
    const executed = await harness({
      completions: [stopped('the worker died before selecting'), successful],
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(result.outcome).toBe('completed');
    await expect(stat(path.join(executed.executionDirectory, 'memory'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(executed.diagnostics).toEqual([]);
  });

  it('forwards worker events unchanged before the lifecycle result', async () => {
    const workerEvent: ExecutionEvent = {
      source: 'execution-runner',
      type: 'state',
      data: { name: 'select' },
    };
    const executed = await harness({
      completions: [successful],
      emit: ({ event }) => event(workerEvent),
    });

    await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

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

  it('writes each invocation activity to its own file and keeps the main stream free of it', async () => {
    const workerEvent: ExecutionEvent = {
      source: 'execution-runner',
      type: 'state',
      data: { name: 'select', payload: { nested: ['complete', 1, true] } },
    };
    const invocationId = 'inv-1';
    const startedAt = 1_767_325_445_000;
    const entries = [
      { type: 'message' as const, text: `exploring ${'the repository '.repeat(30)}` },
      {
        type: 'diagnostic' as const,
        text: 'No agent activity for 2 minutes; the invocation is still running.',
      },
    ];
    let activityFile = '';
    const executed = await harness({
      completions: [successful],
      emit: ({ event, activity, logDirectory }) => {
        activityFile = path.join(
          logDirectory,
          'agents',
          `developer-${String(startedAt)}-${invocationId}.jsonl`,
        );
        const log = { path: activityFile };
        event({
          source: 'develop',
          type: 'agent-started',
          data: {
            agentName: 'developer',
            invocationId,
            startedAtUnixMs: startedAt,
            log,
            operation: 'Develop',
            profile: 'dev-a',
            task: 'NEX-1',
          },
        });
        event(workerEvent);
        for (const entry of entries) {
          activity({ invocationId, timestamp: new Date(startedAt).toISOString(), activity: entry });
        }
        event({
          source: 'develop',
          type: 'agent-finished',
          data: {
            agentName: 'developer',
            invocationId,
            startedAtUnixMs: startedAt,
            log,
            result: { outcome: 'finished' },
          },
        });
      },
    });

    await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    // The live subscription carries the activity with its invocation identity.
    expect(executed.activity).toEqual(
      entries.map((entry) => ({
        invocationId,
        timestamp: new Date(startedAt).toISOString(),
        activity: entry,
      })),
    );
    const logs = await savedLogs(executed.executionDirectory);
    expect(logs).toHaveLength(1);
    // Every received event is saved in order with its receipt timestamp and complete payload.
    expect(logs[0]!.entries.map((entry) => entry.event)).toEqual(executed.events);
    for (const saved of logs[0]!.entries) {
      expect(new Date(saved.timestamp).toISOString()).toBe(saved.timestamp);
    }
    // The invocation's complete activity is in its own file, not in the main event stream.
    const savedActivity = (await readFile(activityFile, 'utf8')).trimEnd().split('\n');
    expect(savedActivity).toHaveLength(2);
    expect(savedActivity.map((line) => JSON.parse(line))).toEqual(
      entries.map((entry) => ({
        timestamp: new Date(startedAt).toISOString(),
        activity: entry,
      })),
    );
    const mainLog = await readFile(logs[0]!.file, 'utf8');
    expect(mainLog).not.toContain('exploring');
    expect(mainLog).not.toContain('message');
    // Neither stream carries configuration or credential values.
    for (const text of [mainLog, savedActivity.join('\n')]) {
      for (const secret of [
        'host-access-key',
        'host-secret-key',
        'host-session-token',
        'host-jira-token',
        'host-lens-key',
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('keeps one log file across worker restarts and drains it before recovery reads it', async () => {
    const activity = { type: 'message' as const, text: 'investigating the state' };
    let logFile: string | null = null;
    let atRecovery = '';
    const executed = await harness({
      completions: [stopped('worker diagnostic\n'), successful],
      agent: async (request) => {
        // The context names the log, and pending writes were drained before this invocation.
        logFile = /Execution event log: (\S+)/u.exec(request.context)?.[1] ?? null;
        if (logFile !== null) {
          atRecovery = await readFile(logFile, 'utf8');
        }
        request.onActivity(activity);
        return recoveringTurn('resume', 'Reconciled and resumable.')(request);
      },
    });

    await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    const logs = await savedLogs(executed.executionDirectory);
    expect(logs).toHaveLength(1);
    expect(logFile).toBe(logs[0]!.file);
    expect(logs[0]!.entries.map((entry) => entry.event)).toEqual(executed.events);
    // Recovery saw the events published before it started.
    expect(atRecovery).toContain('"type":"starting"');
    expect(atRecovery).toContain('"type":"running"');
    expect(atRecovery).not.toContain('"type":"finished"');
    // The recovery invocation's activity is attributable and separately persisted.
    const started = executed.events.find(
      (event) => event.type === 'agent-started' && event.source === 'Recovery',
    );
    const recoveryLog = (started?.data as { readonly log: { readonly path: string } }).log.path;
    expect(executed.activity).toEqual([
      {
        invocationId: (started?.data as { readonly invocationId: string }).invocationId,
        timestamp: expect.any(String),
        activity,
      },
    ]);
    const savedRecoveryActivity = await readFile(recoveryLog, 'utf8');
    expect(savedRecoveryActivity).toContain('investigating the state');
    expect(logs[0]!.entries.some((entry) => entry.event.type === 'agent-activity')).toBe(false);
  });

  it('reports a log failure once to stderr and continues execution without recovery', async () => {
    const executed = await harness({ completions: [successful] });
    await mkdir(executed.executionDirectory, { recursive: true });
    // A file where the logs directory belongs makes this execution's log impossible to open.
    await writeFile(path.join(executed.executionDirectory, 'logs'), 'not a directory\n');

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(result.outcome).toBe('completed');
    expect(executed.timeline).toEqual(['worker']);
    expect(executed.invocations).toEqual([]);
    expect(executed.diagnostics).toHaveLength(1);
    expect(executed.diagnostics[0]).toContain('Nexus could not write the execution log');
  });

  it('starts a new log directory for each execute call', async () => {
    const executed = await harness({ completions: [successful, successful] });

    await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });
    await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    const logs = await savedLogs(executed.executionDirectory);
    expect(logs).toHaveLength(2);
    expect(logs[0]!.file).not.toBe(logs[1]!.file);
    for (const log of logs) {
      expect(log.entries.map((entry) => entry.event.type)).toEqual([
        'starting',
        'running',
        'finished',
      ]);
    }
  });

  it('runs recovery between the stopped worker and the resumed worker', async () => {
    const executed = await harness({
      completions: [stopped('worker diagnostic\n'), successful],
      agent: async (request) => {
        request.onActivity({ type: 'message', text: 'investigating the state' });
        await writeFile(request.reportPath, 'Reconciled and resumable.', 'utf8');
        return ok({ output: decision('resume') });
      },
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
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
      'recovered',
      'running',
      'finished',
    ]);
    // The recovery invocation's activity travels the attributable channel, not the event stream.
    expect(executed.events.some((event) => event.type === 'agent-activity')).toBe(false);
    expect(executed.activity).toEqual([
      {
        invocationId: expect.any(String),
        timestamp: expect.any(String),
        activity: { type: 'message', text: 'investigating the state' },
      },
    ]);
    const started = executed.events.find(
      (event) => event.type === 'agent-started' && event.source === 'Recovery',
    );
    expect(started?.data).toMatchObject({
      agentName: 'recovery',
      operation: 'Recovery',
      profile: 'nexus-recovery',
    });
    expect(executed.activity[0]?.invocationId).toBe(
      (started?.data as { readonly invocationId: string }).invocationId,
    );
    expect(
      executed.events.find(
        (event) => event.type === 'agent-finished' && event.source === 'Recovery',
      )?.data,
    ).toMatchObject({ result: { outcome: 'finished' } });
    expect(result.outcome).toBe('completed');
    expect(result.reason).toBe('The workflow finished with the successful outcome "started".');
    expect(await executionRecord(executed.executionDirectory)).toEqual({
      request: { projectConfigPath: executed.projectConfigPath, workflow: 'project' },
      invocations: 1,
      reports: [result.report!.path],
    });
    // The report lives in the execution's own directory, in this invocation's report directory.
    expect(result.report?.path).toMatch(/\/recovery\/reports\/[^/]+\/recovery\.json$/u);
    // The saved report is published with its reference once it is written.
    expect(executed.events.find((event) => event.type === 'recovered')).toEqual({
      source: 'application',
      type: 'recovered',
      data: { decision: 'resume', report: { path: result.report!.path } },
    });
    const saved = (await savedReport(result.report!.path)) as RecoveryReport;
    expect(saved).toMatchObject({
      project: 'NEX',
      role: 'recovery',
      profile: 'nexus-recovery',
      request: { projectConfigPath: executed.projectConfigPath, workflow: 'project' },
      recoveryAttempt: 1,
      decision: { kind: 'resume' },
    });
    expect(await readFile(saved.report.path, 'utf8')).toBe('Reconciled and resumable.');
    expect(executed.notifications).toHaveLength(1);
    expect(executed.notifications[0]?.subject).toContain('NEX');
    expect(executed.notifications[0]?.subject).toContain('resume');
    // The published body carries the Markdown narrative, its observed identity and the outcome.
    expect(executed.notifications[0]?.body).toContain('Reconciled and resumable.');
    expect(executed.notifications[0]?.body).toContain('invocation ' + saved.invocationId);
    expect(executed.notifications[0]?.body).toContain(result.report!.path);
  });

  it('ends with needs-attention when recovery reports it', async () => {
    const executed = await harness({
      completions: [stopped('worker diagnostic\n')],
      agent: recoveringTurn('needs-attention', 'A human must repair the project.'),
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(result.outcome).toBe('needs-attention');
    expect(result.reason).toContain('The workflow reached outcome "blocked"');
    expect(result.reason).toContain('worker diagnostic');
    expect(result.reason).toContain('A human must repair the project.');
    expect(executed.timeline).toEqual(['worker', 'recovery']);
    expect(lifecycleOf(executed.events)).toEqual([
      'starting',
      'running',
      'recovering',
      'recovered',
      'finished',
    ]);
    const saved = (await savedReport(result.report!.path)) as RecoveryReport;
    expect(saved).toMatchObject({ decision: { kind: 'needs-attention' }, recoveryAttempt: 1 });
    expect(await readFile(saved.report.path, 'utf8')).toBe('A human must repair the project.');
    expect(executed.notifications).toHaveLength(1);
    expect(executed.notifications[0]?.body).toContain('A human must repair the project.');
  });

  it('retains a malformed recovery report and supplies it to the next execution recovery', async () => {
    let invocations = 0;
    const executed = await harness({
      completions: [stopped('first stop\n'), stopped('second stop\n'), successful],
      agent: async (request) => {
        invocations += 1;
        if (invocations === 1) {
          return ok({ output: '{"summary":"No decision was returned."}' });
        }
        await writeFile(request.reportPath, 'Reconciled after the rejection.', 'utf8');
        return ok({ output: decision('resume') });
      },
    });
    const selectionFile = path.join(executed.executionDirectory, 'selection.json');
    const selection = (task: string): unknown => ({
      taskKey: task,
      source: { kind: 'jira', issueId: '10518' },
      task: { id: '10518', key: task, fields: { summary: 'Retained work' } },
      conversation: [],
      workspace: { root: path.join(executed.executionDirectory, 'workspaces', task) },
      stage: 'requirements',
    });
    await mkdir(path.dirname(selectionFile), { recursive: true });
    await writeFile(selectionFile, JSON.stringify(selection('NEX-1')));

    // The malformed recovery report stops the execution; its exact bytes, violated format rule
    // and invocation attribution stay retained under the stable project recovery area.
    const first = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });
    expect(first.outcome).toBe('needs-attention');
    expect(first.reason).toContain('does not match the response format');
    expect(invocations).toBe(1);
    const recoveryArea = path.join(executed.executionDirectory, 'recovery');
    const rejection = (await readValidationErrorHistory(recoveryArea))[0];
    expect(rejection?.record).toMatchObject({
      scope: {
        project: 'NEX',
        workId: 'NEX-1',
        area: recoveryArea,
        role: 'recovery',
        reportKind: 'recovery-report',
      },
      operation: 'Recovery',
      output: '{"summary":"No decision was returned."}',
      reason: expect.stringContaining('does not match the response format'),
    });

    // Recovery cleared the selection; a later execution reselects the same retained work, so the
    // next permitted invocation receives the pending context.
    await rm(selectionFile);
    await writeFile(selectionFile, JSON.stringify(selection('NEX-1')));
    const second = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });
    expect(second.outcome).toBe('completed');
    expect(invocations).toBe(2);
    const context = executed.invocations[1]?.context ?? '';
    expect(context).toContain('Violated rule:');
    expect(context).toContain('does not match the response format');
    expect(context).toContain('{"summary":"No decision was returned."}');
    expect(context).toContain('Rejected output (exact returned bytes):');

    // The producer-validated saved replacement clears the pending context; history remains.
    const scope: ReportScope = {
      project: 'NEX',
      workId: 'NEX-1',
      area: recoveryArea,
      role: 'recovery',
      reportKind: 'recovery-report',
    };
    await expect(readPendingValidationError({ areaRoot: recoveryArea, scope })).resolves.toBeNull();
    const records = await readValidationErrorHistory(recoveryArea);
    expect(records).toHaveLength(1);
    expect(records[0]?.record.kind).toBe('validation-error');
  });

  it('retains a missing recovery Markdown and stops for attention', async () => {
    let invocations = 0;
    const executed = await harness({
      completions: [stopped('first stop\n'), stopped('second stop\n'), successful],
      agent: async (request) => {
        invocations += 1;
        if (invocations === 1) {
          // The decision is valid but the assigned Markdown is absent: the invocation is rejected.
          return ok({ output: decision('resume') });
        }
        await writeFile(request.reportPath, 'Reconciled after the rejection.', 'utf8');
        return ok({ output: decision('resume') });
      },
    });

    const first = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(first.outcome).toBe('needs-attention');
    expect(first.reason).toContain('does not exist');
    expect(invocations).toBe(1);
    // The allowance stays consumed, no outcome is saved or published, and the exact reason and
    // assigned path stay retained under the stable project recovery area.
    expect(await executionRecord(executed.executionDirectory)).toMatchObject({
      invocations: 1,
      reports: [],
    });
    expect(executed.notifications).toHaveLength(0);
    const recoveryArea = path.join(executed.executionDirectory, 'recovery');
    const rejection = (await readValidationErrorHistory(recoveryArea))[0];
    expect(rejection?.record).toMatchObject({
      scope: {
        project: 'NEX',
        workId: 'no-selected-work',
        area: recoveryArea,
        role: 'recovery',
        reportKind: 'recovery-report',
      },
      operation: 'Recovery',
      reason: expect.stringContaining('does not exist'),
      assignedReport: {
        path: executed.invocations[0]!.reportPath,
      },
    });

    // The next execution's permitted invocation receives the pending context, writes its Markdown
    // and saves the replacement, so the context clears.
    const second = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });
    expect(second.outcome).toBe('completed');
    expect(invocations).toBe(2);
    const context = executed.invocations[1]?.context ?? '';
    expect(context).toContain('Violated rule:');
    expect(context).toContain('does not exist');
    const records = await readValidationErrorHistory(recoveryArea);
    expect(records).toHaveLength(1);
    expect(records[0]?.record.kind).toBe('validation-error');
  });

  it('stops for attention when the retained recovery feedback is unreadable', async () => {
    const executed = await harness({ completions: [stopped('first stop\n')] });
    const feedback = path.join(executed.executionDirectory, 'recovery', 'report-feedback');
    await mkdir(feedback, { recursive: true });
    await writeFile(path.join(feedback, 'broken.json'), '{"kind":"rejection"}');

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    // Missing or unusable evidence is an explicit error, never an empty context: the invocation
    // that cannot receive its required diagnosis does not run unawares.
    expect(result.outcome).toBe('needs-attention');
    expect(result.reason).toContain('could not read its pending validation-error context');
    expect(executed.invocations).toHaveLength(0);
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
      agent: recoveringTurn('needs-attention', 'Recovered.'),
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
        stage: 'delivery',
      }),
    );

    await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

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
    // A fresh finite delivery attempt never removes the retained idea refinement area.
    expect(context).toContain('refinement/ for idea refinement');
    // A first implementation may borrow another issue's preparation checkout; recovery preserves
    // that donor repository and its accepted history instead of deleting or replacing it.
    expect(context).toContain('preserve that donor checkout');
    // Reconciliation receives each producer-owned declaration's actual path and generated shape.
    for (const declaration of declaredFormats(executed.executionDirectory)) {
      expect(context, declaration.path).toContain(`Path: ${declaration.path}`);
      expect(context, declaration.path).toContain(
        JSON.stringify(z.toJSONSchema(declaration.schema), null, 2),
      );
    }
    // The response format, the assigned Markdown path and the current-project scope are part of
    // the context.
    expect(context).toContain('"const": "resume"');
    expect(context).toContain('"const": "needs-attention"');
    expect(context).toContain(`Assigned Markdown report: ${executed.invocations[0]!.reportPath}`);
    expect(context).toContain('Cross-project repair');
    // Credential values stay in host settings; the context carries references and no secrets.
    expect(context).not.toContain('host-access-key');
    expect(context).not.toContain('host-secret-key');
    expect(context).not.toContain('host-session-token');
    expect(context).not.toContain('host-jira-token');
    expect(context).not.toContain('host-lens-key');
  });

  it('gives recovery the project parent, its selection and the issue workspace', async () => {
    const refinement = '/srv/nexus/workspaces/NEX/NEX-1/refinement';
    const executed = await harness({
      completions: [
        {
          result: { ok: false, fault: { message: 'idea agent failed' } },
          exitCode: 1,
          problem: null,
          diagnostics: '',
        },
      ],
      agent: recoveringTurn('needs-attention', 'Recovered.'),
    });
    const ideaDirectory = executed.executionDirectory;
    await mkdir(ideaDirectory, { recursive: true });
    await writeFile(
      path.join(ideaDirectory, 'selection.json'),
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '10518' },
        task: { id: '10518', key: 'NEX-1', fields: { summary: 'Add a lint gate' } },
        conversation: [],
        workspace: { root: path.dirname(refinement) },
        stage: 'idea',
      }),
    );

    await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    const context = executed.invocations[0]?.context ?? '';
    expect(context).toContain('Name: project');
    expect(context).toContain(workflowModule);
    expect(context).toContain(`Selection file: ${path.join(ideaDirectory, 'selection.json')}`);
    expect(context).toContain('Project selection record (SelectWork)');
    expect(context).toContain('Idea refinement round plan (StartIdeaRound)');
    expect(context).toContain('artifacts/submissions/<submission>/cycles/<cycle>/');
    // The shared issue workspace is named with the stage the retained selection entered.
    expect(context).toContain('retained the stage "idea"');
    expect(context).toContain(path.dirname(refinement));
    // The retained selection's Summary reaches the recovery invocation's boundary.
    expect(
      executed.events.find((event) => event.source === 'Recovery' && event.type === 'agent-started')
        ?.data,
    ).toMatchObject({ task: 'NEX-1', summary: 'Add a lint gate' });
    expect(executed.invocations[0]?.workspace.root).toBe(
      path.join(executed.executionDirectory, 'recovery', 'workspace'),
    );
  });

  it('runs recovery with an operational worktree inside a Git repository', async () => {
    const executed = await harness({
      completions: [
        {
          result: { ok: false, fault: { message: 'workflow state is invalid' } },
          exitCode: 1,
          problem: null,
          diagnostics: 'worker diagnostic\n',
        },
      ],
      agent: recoveringTurn('needs-attention', 'Recovered.'),
    });

    await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    // The configured Codex provider refuses a working directory outside a Git repository, so the
    // operational worktree is initialized as one before the invocation starts.
    const worktree = path.join(executed.invocations[0]!.workspace.root, 'worktree');
    const observed = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: worktree,
    });
    expect(observed.stdout.trim()).toBe('true');
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
        workflow: 'project',
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
      workflow: 'project',
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
      workflow: 'project',
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
      request: { projectConfigPath: executed.projectConfigPath, workflow: 'project' },
      invocations: 1,
      reports: [result.report!.path],
    });
  });

  it('saves one report per invocation and stops at the invocation that needs attention', async () => {
    const turns = [
      { kind: 'resume', markdown: 'First attempt reconciled.' },
      { kind: 'needs-attention', markdown: 'Second attempt needs a human.' },
    ] as const;
    let invocations = 0;
    const executed = await harness({
      maxRecoveryAttempts: 2,
      completions: [stopped('first stop\n'), stopped('second stop\n')],
      agent: async (request) => {
        const turn = turns[invocations++]!;
        await writeFile(request.reportPath, turn.markdown, 'utf8');
        return ok({ output: decision(turn.kind) });
      },
    });

    const result = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    expect(executed.timeline).toEqual(['worker', 'recovery', 'worker', 'recovery']);
    expect(result.outcome).toBe('needs-attention');
    expect(result.reason).toContain('Second attempt needs a human.');
    // One execution retains both invocations' Markdown reports and saved outcomes in order.
    const record = (await executionRecord(executed.executionDirectory)) as {
      readonly request: unknown;
      readonly invocations: number;
      readonly reports: readonly string[];
    };
    expect(record.request).toEqual({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });
    expect(record.invocations).toBe(2);
    expect(record.reports).toHaveLength(2);
    expect(record.reports[1]).toBe(result.report!.path);
    expect(result.report?.path).toMatch(/\/recovery\/reports\/[^/]+\/recovery\.json$/u);
    const firstReport = (await savedReport(record.reports[0]!)) as RecoveryReport;
    expect(firstReport).toMatchObject({ recoveryAttempt: 1, decision: { kind: 'resume' } });
    expect(await readFile(firstReport.report.path, 'utf8')).toBe('First attempt reconciled.');
    expect(await readFile(path.dirname(result.report!.path) + '/recovery.md', 'utf8')).toBe(
      'Second attempt needs a human.',
    );
    // The second invocation is told about the report the first one saved.
    expect(executed.invocations[1]?.context).toContain(record.reports[0]!);
    expect(executed.invocations[1]?.context).toContain('First attempt reconciled.');
    expect(executed.notifications).toHaveLength(2);
  });

  it('preserves saved reports across execute calls on the same project storage', async () => {
    const turns = ['The first execution needs a human.', 'The second execution needs a human.'];
    let invocations = 0;
    const executed = await harness({
      completions: [stopped('first stop\n'), stopped('second stop\n')],
      agent: async (request) => {
        await writeFile(request.reportPath, turns[invocations++]!, 'utf8');
        return ok({ output: decision('needs-attention') });
      },
    });

    const first = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });
    const second = await executed.application.execute({
      projectConfigPath: executed.projectConfigPath,
      workflow: 'project',
    });

    // Each execute call resets the invocation numbering, but never the other execution's reports.
    expect(first.report?.path).toMatch(/\/recovery\/reports\/[^/]+\/recovery\.json$/u);
    expect(second.report?.path).toMatch(/\/recovery\/reports\/[^/]+\/recovery\.json$/u);
    expect(first.report?.path).not.toBe(second.report?.path);
    const firstSaved = (await savedReport(first.report!.path)) as RecoveryReport;
    expect(firstSaved).toMatchObject({ decision: { kind: 'needs-attention' }, recoveryAttempt: 1 });
    expect(await readFile(firstSaved.report.path, 'utf8')).toBe(
      'The first execution needs a human.',
    );
    const secondSaved = (await savedReport(second.report!.path)) as RecoveryReport;
    expect(secondSaved).toMatchObject({
      decision: { kind: 'needs-attention' },
      recoveryAttempt: 1,
    });
    expect(await readFile(secondSaved.report.path, 'utf8')).toBe(
      'The second execution needs a human.',
    );
    // The second execute call began a fresh allowance over the same execution directory.
    expect(await executionRecord(executed.executionDirectory)).toEqual({
      request: { projectConfigPath: executed.projectConfigPath, workflow: 'project' },
      invocations: 1,
      reports: [second.report!.path],
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
      workflow: 'project',
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
        agent: recoveringTurn('needs-attention', 'Needs the operator.'),
      });

      const result = await executed.application.execute({
        projectConfigPath: executed.projectConfigPath,
        workflow: 'project',
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
      workflow: 'project',
    });

    expect(result.outcome).toBe('completed');
  });

  it('rejects an execution request that is not an absolute path', async () => {
    const executed = await harness({ completions: [successful] });

    await expect(
      executed.application.execute({
        projectConfigPath: 'project.config.json',
        workflow: 'project',
      }),
    ).rejects.toThrow(/is not absolute/u);
  });
});
