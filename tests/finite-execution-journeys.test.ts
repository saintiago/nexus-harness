/**
 * System journeys: the assembled operator command runs the real Application over the real finite
 * workflow (`workflows/finite-delivery.ts`), every documented action, the real TaskEngine and
 * ExecutionRunner, real round/record storage and a real local Git remote under temporary storage.
 *
 * Substituted: the worker process boundary (the launch composes the worker's real configuration
 * loading, workflow loading, TaskEngine and action binding in process — without spawning the child
 * process whose protocol has its own focused tests — and supplies the external capabilities to
 * that composition), the Jira and GitHub services (controlled capabilities at the adapter boundary
 * those actions depend on) and agent execution (a controlled coding runtime that performs the
 * repository work and returns the role's response). Everything else — workflow, action wiring,
 * artifacts, Git and command execution — is the real implementation.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentResult } from '../src/agent-runtime/index.js';
import type {
  CodingRuntime,
  CodingRuntimeRequest,
  CodingRuntimeResult,
} from '../src/adapters/coding-runtime.js';
import { createGitAdapter } from '../src/adapters/git.js';
import { reviewEncoding } from '../src/adapters/github.js';
import type {
  CheckObservation,
  GitHubAdapter,
  GitHubReview,
  PullRequest,
} from '../src/adapters/github.js';
import type { JiraAdapter, JiraComment, JiraIssue, JiraTransition } from '../src/adapters/jira.js';
import { run, type ProcessOutput } from '../src/adapters/processes.js';
import { createActionBinding } from '../src/application/action-bindings.js';
import { runOperatorCommand } from '../src/application/command.js';
import { executionPaths, toolEnvironment } from '../src/application/composition.js';
import {
  createApplication,
  type ApplicationSettings,
  type ExecutionEvent,
  type ExecutionResult,
  type RecoveryReport,
  type WorkerLaunch,
} from '../src/application/index.js';
import { installationConfigSetting } from '../src/application/installation.js';
import type {
  RecoveryInvocationRequest,
  RecoveryRuntimeFactory,
} from '../src/application/recovery.js';
import { loadProjectWorkflow } from '../src/application/workflow.js';
import { loadNexusConfiguration, loadProjectConfiguration } from '../src/configuration/index.js';
import { fault, ok } from '../src/result.js';
import {
  createTaskEngine,
  type AgentActivity,
  type EngineEvent,
} from '../src/task-engine/index.js';
import {
  experienceIdentity,
  experienceObservationSourceKey,
  type ExperienceHandoff,
} from '../src/task-engine/actions/analyze-experience/artifacts.js';
import type { ExperienceAnalystRequest } from '../src/task-engine/actions/analyze-experience/index.js';
import type { CompletionOutput } from '../src/task-engine/actions/complete-task/artifacts.js';
import type { DeliveryOutput } from '../src/task-engine/actions/deliver/artifacts.js';
import { developmentResponseSchema } from '../src/task-engine/actions/develop/artifacts.js';
import { attemptFile } from '../src/task-engine/actions/prepare-workspace/artifacts.js';
import type {
  DevelopmentOutput,
  DevelopmentResponse,
} from '../src/task-engine/actions/develop/artifacts.js';
import { reviewResponseSchema } from '../src/task-engine/actions/review/artifacts.js';
import type {
  Finding,
  ReviewOutput,
  ReviewResponse,
} from '../src/task-engine/actions/review/artifacts.js';
import type { VerificationOutput } from '../src/task-engine/actions/verify/artifacts.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';
import { scriptedGitHub } from './support/github.js';
import { scriptedJira } from './support/jira.js';
import { controlledMemoryService, type ControlledMemoryService } from './support/memory.js';
import { strictSchemaProblems } from './support/provider-schema.js';

/** The configured workflow is the real finite workflow module, loaded through Application. */
const workflowPath = fileURLToPath(new URL('../workflows/project.ts', import.meta.url));

/** Git runs against local temporary repositories with the host configuration disabled. */
const gitEnvironment = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Nexus Tests',
  GIT_AUTHOR_EMAIL: 'nexus@example.com',
  GIT_COMMITTER_NAME: 'Nexus Tests',
  GIT_COMMITTER_EMAIL: 'nexus@example.com',
};

const git = createGitAdapter((args, directory, onOutput) =>
  run({ executable: 'git', args, directory, environment: gitEnvironment }, onOutput),
);

/** The host settings the operator command and the worker start from; credentials are controlled. */
const hostEnvironment = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  JIRA_API_TOKEN: 'controlled-jira-token',
  NEXUS_LENS_PRIVATE_KEY: 'controlled-lens-key',
  AWS_ACCESS_KEY_ID: 'controlled-access-key',
  AWS_SECRET_ACCESS_KEY: 'controlled-secret-key',
};

/** The merge revision the controlled GitHub reports for an approved and auto-merged pull request. */
const mergeRevision = '4'.repeat(40);

const temporaryDirectories: string[] = [];
const memoryServices: ControlledMemoryService[] = [];

afterEach(async () => {
  await Promise.all([
    ...memoryServices.splice(0).map((service) => service.close()),
    ...temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  ]);
});

/** One controlled AMEM service closed after the test. */
async function controlledService(): Promise<ControlledMemoryService> {
  const service = await controlledMemoryService();
  memoryServices.push(service);
  return service;
}

/** Decode one stream's chunks as text. */
function textOf(outputs: readonly ProcessOutput[], stream: ProcessOutput['stream']): string {
  const chunks = outputs.filter((output) => output.stream === stream).map((output) => output.chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Run one git command in a directory and return its stdout, failing the test on any error. */
async function gitCommand(args: readonly string[], directory: string): Promise<string> {
  const outputs: ProcessOutput[] = [];
  const result = await run(
    { executable: 'git', args, directory, environment: gitEnvironment },
    (output) => {
      outputs.push(output);
    },
  );
  if (!result.ok || result.value.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${textOf(outputs, 'stderr')}`);
  }
  return textOf(outputs, 'stdout');
}

/** Commit everything in a worktree the way a development turn leaves it. */
async function commitAll(worktree: string, message: string): Promise<void> {
  await gitCommand(['add', '--all'], worktree);
  await gitCommand(['commit', '--quiet', '--message', message], worktree);
}

/** The text of one published comment document. */
function commentText(document: unknown): string {
  const content =
    typeof document === 'object' && document !== null
      ? (document as { readonly content?: readonly { readonly content?: unknown }[] }).content
      : undefined;
  const paragraph = content?.[0]?.content as readonly { readonly text?: unknown }[] | undefined;
  const text = paragraph?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

/** One scripted agent turn: it inspects the invocation, acts and returns the provider result. */
type AgentTurn = (request: CodingRuntimeRequest) => Promise<CodingRuntimeResult>;

/** One scripted recovery invocation: it inspects the stop and returns the report to apply. */
type RecoveryTurn = (request: RecoveryInvocationRequest) => Promise<RecoveryReport>;

/** The coding runtime the scripted turns run through; AgentRuntime still assembles every prompt. */
function scriptedCodingRuntime(
  turns: readonly AgentTurn[],
  prompts: string[],
  requests: CodingRuntimeRequest[],
): CodingRuntime {
  let index = 0;
  return {
    async execute(request, onActivity) {
      prompts.push(request.prompt);
      requests.push(request);
      onActivity({ type: 'message', text: `controlled agent turn ${String(index + 1)}` });
      const turn = turns[index];
      index += 1;
      if (turn === undefined) {
        return fault(`The journey script supplies no agent turn for invocation ${String(index)}.`);
      }
      return turn(request);
    },
  };
}

/** One development turn: it asserts its role and returns the agent's DevelopmentResponse. */
function developerTurn(
  work: (request: CodingRuntimeRequest) => Promise<DevelopmentResponse>,
): AgentTurn {
  return async (request) => {
    expect(request.prompt).toContain('You are the Nexus development agent.');
    // Develop's own response schema crosses the real wiring to the provider capability and meets
    // the provider's strict structured-output requirements.
    expect(request.outputSchema).toEqual(z.toJSONSchema(developmentResponseSchema));
    expect(strictSchemaProblems(request.outputSchema)).toEqual([]);
    return ok({ output: JSON.stringify(await work(request)) });
  };
}

/** One review turn: it asserts its role and returns the agent's ReviewResponse. */
function reviewerTurn(work: (request: CodingRuntimeRequest) => Promise<ReviewResponse>): AgentTurn {
  return async (request) => {
    expect(request.prompt).toContain('You are the Nexus reviewer.');
    // Review's own response schema crosses the real wiring to the provider capability and meets
    // the provider's strict structured-output requirements.
    expect(request.outputSchema).toEqual(z.toJSONSchema(reviewResponseSchema));
    expect(strictSchemaProblems(request.outputSchema)).toEqual([]);
    return ok({ output: JSON.stringify(await work(request)) });
  };
}

/** Recovery is unexpected in a journey that supplies no recovery turn. */
const unexpectedRecovery: RecoveryTurn = () =>
  Promise.resolve({
    summary: 'The journey expected no recovery invocation.',
    decision: { kind: 'needs-attention' },
  });

/** The default analysis turn: the completed work holds no reusable lesson. */
const noLessons = (): Promise<AgentResult> =>
  Promise.resolve(ok({ output: JSON.stringify({ observations: [] }) }));

/**
 * The in-process worker launch: the real worker wiring (configuration loading, workflow loading,
 * TaskEngine over the real action binding), with the external service and agent capabilities
 * supplied by the journey instead of the process-boundary adapters.
 */
function inProcessWorkerLaunch(input: {
  readonly installationConfigPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly jira: JiraAdapter;
  readonly github: GitHubAdapter;
  readonly codingRuntime: CodingRuntime;
}): WorkerLaunch {
  return async (request, onEvent, onActivity) => {
    const nexus = await loadNexusConfiguration(input.installationConfigPath);
    const project = await loadProjectConfiguration(request.projectConfigPath);
    const workflow = await loadProjectWorkflow(nexus.workflow);
    const paths = executionPaths(nexus, project);
    await mkdir(paths.directory, { recursive: true });
    const engine = createTaskEngine({
      workflow: workflow.machine,
      children: workflow.children,
      stateFile: paths.workflowStateFile,
      bindActions: createActionBinding({
        project,
        nexus,
        paths,
        jira: input.jira,
        github: input.github,
        git,
        codingRuntime: input.codingRuntime,
        runCommand: run,
        commandEnvironment: toolEnvironment(project, nexus, input.environment),
        activityDirectory: path.join(request.logDirectory, 'agents'),
        wait: () => Promise.resolve(),
      }),
    });
    const unsubscribe = engine.subscribe((event: EngineEvent) => {
      onEvent(event);
    });
    const unsubscribeActivity = engine.subscribeActivity(onActivity);
    let result;
    try {
      result = await engine.run();
    } finally {
      unsubscribe();
      unsubscribeActivity();
    }
    // Exactly what the worker protocol reports for this execution: the result and its exit code.
    return { result, exitCode: result.ok ? 0 : 1, problem: null, diagnostics: '' };
  };
}

/** What one assembled journey observed and the handles its assertions use. */
type Journey = {
  readonly root: string;
  readonly origin: string;
  readonly installationConfigPath: string;
  readonly projectConfigPath: string;
  readonly executionDirectory: string;
  readonly workspace: string;
  readonly worktree: string;
  readonly events: readonly ExecutionEvent[];
  readonly activity: readonly AgentActivity[];
  readonly prompts: readonly string[];
  readonly requests: readonly CodingRuntimeRequest[];
  /** The parent's experience-analysis invocations, after terminal handoffs. */
  readonly analyses: readonly ExperienceAnalystRequest[];
  readonly recoveries: readonly RecoveryInvocationRequest[];
  readonly notifications: readonly { readonly subject: string; readonly body: string }[];
  readonly diagnostics: readonly string[];
  readonly presentation: readonly string[];
  readonly jiraCalls: readonly string[];
  readonly githubCalls: readonly string[];
  status(): string;
  comments(): readonly JiraComment[];
  checks(): readonly CheckObservation[];
  /** The attempt identity the journey's workspace recorded for its delivery attempt. */
  attemptId(): Promise<string>;
  finished(): ExecutionResult;
  artifact<Value>(round: number, name: string): Promise<Value>;
  run(turns: readonly AgentTurn[], recovery?: RecoveryTurn): Promise<number>;
};

/**
 * Assemble one journey: a local remote with main, temporary installation and project
 * configuration, a controlled Jira source and GitHub service and the real operator command over
 * the real Application.
 */
async function finiteJourney(
  options: {
    readonly memory?: boolean;
    readonly memoryServiceUrl?: string;
    /** The configured preparation commands; the default succeeds without effects. */
    readonly preparation?: readonly { readonly executable: string; readonly args: string[] }[];
    /** The controlled analyst turn; the default reports no reusable lesson. */
    readonly analysis?: (request: ExperienceAnalystRequest) => Promise<AgentResult>;
  } = {},
): Promise<Journey> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-journey-'));
  temporaryDirectories.push(root);

  // The local remote the prepared worktree clones from and publishes into.
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  await gitCommand(['init', '--quiet', '--bare', '--initial-branch=main', origin], root);
  await gitCommand(['init', '--quiet', '--initial-branch=main', seed], root);
  await writeFile(path.join(seed, 'readme.md'), 'the project\n');
  await gitCommand(['add', 'readme.md'], seed);
  await gitCommand(['commit', '--quiet', '--message', 'initial'], seed);
  await gitCommand(['remote', 'add', 'origin', origin], seed);
  await gitCommand(['push', '--quiet', 'origin', 'main'], seed);

  const installationDirectory = path.join(root, 'installation');
  const projectDirectory = path.join(root, 'project');
  await mkdir(installationDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  const nexus = nexusConfiguration();
  if (options.memory === true) {
    nexus.memory = {
      enabled: true,
      serviceUrl: options.memoryServiceUrl ?? 'http://127.0.0.1:4748',
      mcp: { command: 'npm', args: ['run', '--silent', 'mcp'], directory: './agentic-memory' },
      analysisProfile: 'nexus-astra',
    };
  }
  nexus.workflow.project = workflowPath;
  nexus.workflow.children['finite-delivery'] = fileURLToPath(
    new URL('../workflows/finite-delivery.ts', import.meta.url),
  );
  nexus.workflow.children['idea-refinement'] = fileURLToPath(
    new URL('../workflows/idea-refinement.ts', import.meta.url),
  );
  nexus.workflow.children.preparation = fileURLToPath(
    new URL('../workflows/preparation.ts', import.meta.url),
  );
  nexus.storage.root = './state';
  nexus.executionPolicy.developerLadder = [{ profile: 'nexus-flash', repairAllowance: 2 }];
  const project = projectConfiguration();
  project.repository.source = origin;
  project.preparation = [
    ...(options.preparation ?? [{ executable: 'bash', args: ['-c', 'echo preparing'] }]),
  ];
  project.checks = [
    { name: 'journey check', command: { executable: 'bash', args: ['-c', 'test -s feature.txt'] } },
  ];
  project.delivery.completion = { pollIntervalSeconds: 0, waitLimitSeconds: 30 };

  const installationConfigPath = path.join(installationDirectory, 'nexus.config.json');
  const projectConfigPath = path.join(projectDirectory, 'project.config.json');
  await writeFile(installationConfigPath, JSON.stringify(nexus));
  await writeFile(projectConfigPath, JSON.stringify(project));

  // Storage and workspace paths resolve against the installation configuration's directory.
  const storage = path.join(installationDirectory, 'state');
  const executionDirectory = path.join(storage, 'executions', project.taskSource.project);
  const workspace = path.join(storage, 'workspaces', project.taskSource.project, 'NEX-1');
  const worktree = path.join(workspace, 'worktree');

  // The controlled task source: one eligible issue whose status follows the configured workflow.
  const taskKey = 'NEX-1';
  const issueId = '10001';
  const workspacePointerField = project.taskSource.fields.workspacePointer;
  const pullRequestField = project.taskSource.fields.pullRequest;
  const statusIds: Record<string, string> = {
    'To Do': '1',
    'In Progress': '2',
    'In Review': '4',
    Done: '5',
  };
  let status = 'To Do';
  const fields: Record<string, unknown> = {};
  const comments: JiraComment[] = [];
  let nextCommentId = 1;
  const transitions: JiraTransition[] = [
    { id: '11', name: 'Start work', to: { id: '2', name: 'In Progress' } },
    { id: '31', name: 'Submit for review', to: { id: '4', name: 'In Review' } },
    { id: '41', name: 'Finish', to: { id: '5', name: 'Done' } },
  ];
  const issueOf = (): JiraIssue => ({
    id: issueId,
    key: taskKey,
    fields: {
      ...fields,
      summary: 'Ship the finite journey',
      description: { type: 'doc', version: 1, content: [] },
      status: { id: statusIds[status], name: status },
    },
  });
  const source = scriptedJira({
    searchIssues: () => ok(status === 'To Do' ? [{ id: issueId, key: taskKey }] : []),
    readIssue: () => ok(issueOf()),
    readComments: () => ok([...comments]),
    readTransitions: () => ok(transitions),
    updateFields: (_issueId, updates) => {
      if (updates.workspacePointer !== undefined) {
        fields[workspacePointerField] = updates.workspacePointer;
      }
      if (updates.pullRequest !== undefined) {
        fields[pullRequestField] = updates.pullRequest;
      }
      return ok(undefined);
    },
    transitionIssue: (_issueId, transitionId) => {
      const transition = transitions.find((candidate) => candidate.id === transitionId);
      if (transition === undefined) {
        return fault(`Unknown transition "${transitionId}".`);
      }
      status = transition.to.name;
      return ok(undefined);
    },
    addComment: (_issueId, body) => {
      const id = `c${String(nextCommentId)}`;
      nextCommentId += 1;
      comments.push({ id, body });
      return ok({ id, body });
    },
  });

  // The controlled delivery service: one pull request per task branch that auto-merges once the
  // approved Nexus Lens check exists for its head revision.
  const repository = project.delivery.repository;
  const baseBranch = project.delivery.baseBranch;
  const pullRequestNumber = 7;
  const pullRequestUrl = `https://github.com/${repository}/pull/${String(pullRequestNumber)}`;
  let pullRequestCreated = false;
  let autoMergeEnabled = false;
  const reviews: GitHubReview[] = [];
  const checks: CheckObservation[] = [];
  const pullRequestState = async (): Promise<PullRequest> => {
    const headRevision = (await gitCommand(['rev-parse', 'HEAD'], worktree)).trim();
    const merged =
      autoMergeEnabled &&
      checks.some((check) => check.revision === headRevision && check.conclusion === 'success');
    return {
      number: pullRequestNumber,
      url: pullRequestUrl,
      state: merged ? 'closed' : 'open',
      merged,
      headBranch: 'task/NEX-1',
      baseBranch,
      headRevision,
      mergeRevision: merged ? mergeRevision : null,
      autoMergeEnabled,
    };
  };
  const delivery = scriptedGitHub({
    findPullRequests: () =>
      ok(pullRequestCreated ? [{ number: pullRequestNumber, url: pullRequestUrl }] : []),
    readPullRequest: async () =>
      pullRequestCreated
        ? ok(await pullRequestState())
        : fault('No pull request exists for the task branch.'),
    createPullRequest: async () => {
      pullRequestCreated = true;
      return ok({
        number: pullRequestNumber,
        url: pullRequestUrl,
        headRevision: (await gitCommand(['rev-parse', 'HEAD'], worktree)).trim(),
      });
    },
    updatePullRequest: async () =>
      ok({
        number: pullRequestNumber,
        url: pullRequestUrl,
        headRevision: (await gitCommand(['rev-parse', 'HEAD'], worktree)).trim(),
      }),
    requestAutoMerge: () => {
      autoMergeEnabled = true;
      return ok(undefined);
    },
    readConversation: () => ok({ comments: [], reviews: [...reviews], reviewComments: [] }),
    publishReview: (_repository, review) => {
      const id = 11 + reviews.length;
      reviews.push({
        id,
        state: reviewEncoding[review.verdict].state,
        body: review.body,
        commit_id: review.revision,
        author: nexus.nexusLens.login,
        user: { login: nexus.nexusLens.login },
      });
      return ok({ id, url: `${pullRequestUrl}#review-${String(id)}` });
    },
    readChecks: (_repository, revision) =>
      ok(checks.filter((check) => check.revision === revision)),
    // This controlled provider enforces no pre-merge requirement beyond the Nexus Lens review.
    readRequiredChecks: async () =>
      ok({ revision: (await gitCommand(['rev-parse', 'HEAD'], worktree)).trim(), checks: [] }),
    publishReviewCheck: (_repository, publication) => {
      const id = 12 + checks.length;
      checks.push({
        id,
        revision: publication.revision,
        name: publication.name,
        producer: { id: nexus.nexusLens.appId, slug: 'nexus-lens', name: 'Nexus Lens' },
        status: 'completed',
        conclusion: publication.result,
      });
      return ok({ id });
    },
    readWorkflowRuns: (_repository, revision, workflows) =>
      ok(
        workflows.map((workflow, index) => ({
          id: index + 1,
          name: workflow,
          path: workflow,
          revision,
          status: 'completed',
          conclusion: 'success',
          jobs: [],
        })),
      ),
  });

  const events: ExecutionEvent[] = [];
  const activity: AgentActivity[] = [];
  const prompts: string[] = [];
  const requests: CodingRuntimeRequest[] = [];
  const analyses: ExperienceAnalystRequest[] = [];
  const recoveries: RecoveryInvocationRequest[] = [];
  const notifications: { readonly subject: string; readonly body: string }[] = [];
  const diagnostics: string[] = [];
  const presentation: string[] = [];

  return {
    root,
    origin,
    installationConfigPath,
    projectConfigPath,
    executionDirectory,
    workspace,
    worktree,
    events,
    activity,
    prompts,
    requests,
    analyses,
    recoveries,
    notifications,
    diagnostics,
    presentation,
    jiraCalls: source.calls,
    githubCalls: delivery.calls,
    status: () => status,
    comments: () => comments,
    checks: () => checks,
    async attemptId() {
      const record = JSON.parse(await readFile(path.join(workspace, attemptFile), 'utf8')) as {
        readonly attemptId: string;
      };
      return record.attemptId;
    },
    finished() {
      const finished = events
        .filter((event) => event.source === 'application' && event.type === 'finished')
        .at(-1);
      if (finished === undefined) {
        throw new Error(`The journey did not finish: ${diagnostics.join('')}`);
      }
      return finished.data as ExecutionResult;
    },
    async artifact<Value>(round: number, name: string): Promise<Value> {
      return JSON.parse(
        await readFile(path.join(workspace, 'artifacts', String(round), name), 'utf8'),
      ) as Value;
    },
    async run(turns: readonly AgentTurn[], recoveryTurn: RecoveryTurn = unexpectedRecovery) {
      const launchWorker = inProcessWorkerLaunch({
        installationConfigPath,
        environment: hostEnvironment,
        jira: source.jira,
        github: delivery.github,
        codingRuntime: scriptedCodingRuntime(turns, prompts, requests),
      });
      const recovery: RecoveryRuntimeFactory = () => ({
        async invoke(request) {
          recoveries.push(request);
          return ok({ output: JSON.stringify(await recoveryTurn(request)) });
        },
        async notify(subject, body) {
          notifications.push({ subject, body });
          return ok({ messageId: 'controlled-message-identity' });
        },
      });
      return runOperatorCommand({
        args: ['queue', 'run', '--project-config', projectConfigPath],
        workingDirectory: root,
        environment: { ...hostEnvironment, [installationConfigSetting]: installationConfigPath },
        output: {
          write: (text) => {
            presentation.push(text);
          },
        },
        diagnostics: {
          write: (text) => {
            diagnostics.push(text);
          },
        },
        application: (settings: ApplicationSettings) => {
          const application = createApplication({
            ...settings,
            launchWorker,
            recovery,
            analysis: () => (request) => {
              analyses.push(request);
              return (options.analysis ?? noLessons)(request);
            },
          });
          application.subscribe((event) => events.push(event));
          application.subscribeActivity((packet) => activity.push(packet));
          return application;
        },
      });
    },
  };
}

/** The runner state names one journey observed, in publication order. */
function stateNames(events: readonly ExecutionEvent[]): string[] {
  return events
    .filter((event) => event.source === 'execution-runner' && event.type === 'state')
    .map((event) => (event.data as { readonly value: unknown }).value)
    .filter((value): value is string => typeof value === 'string');
}

/** The saved JSONL execution-log entries of one journey, in receipt order. */
async function savedLogEntries(executionDirectory: string): Promise<readonly ExecutionEvent[]> {
  const logsRoot = path.join(executionDirectory, 'logs');
  const directories = await readdir(logsRoot);
  expect(directories).toHaveLength(1);
  const text = await readFile(path.join(logsRoot, directories[0]!, 'events.jsonl'), 'utf8');
  return text
    .trimEnd()
    .split('\n')
    .map((line) => (JSON.parse(line) as { readonly event: ExecutionEvent }).event);
}

/** The Application lifecycle event types one journey observed, in publication order. */
function lifecycleNames(events: readonly ExecutionEvent[]): string[] {
  return events
    .filter((event) => event.source === 'application')
    .map((event) => event.type)
    .filter((type) =>
      ['starting', 'running', 'recovering', 'recovered', 'finished'].includes(type),
    );
}

describe('finite execution journeys', () => {
  it('completes an eligible task and drains the queue', async () => {
    const journey = await finiteJourney();

    const exitCode = await journey.run([
      developerTurn(async (request) => {
        await writeFile(path.join(request.directory, 'feature.txt'), 'the feature\n');
        await commitAll(request.directory, 'add the feature');
        return {
          status: 'completed',
          summary: 'Added feature.txt with the guarded behavior.',
          findingResponses: [],
        };
      }),
      reviewerTurn(async () => ({
        verdict: 'approved',
        summary: 'The change fulfils the task and the configured check covers it.',
        findings: [],
        priorFindings: [],
      })),
    ]);

    const result = journey.finished();
    expect(exitCode, JSON.stringify(result)).toBe(0);
    expect(journey.diagnostics).toEqual([]);
    expect(journey.recoveries).toEqual([]);
    expect(result.outcome).toBe('completed');
    expect(result.reason).toContain('The workflow finished with the successful outcome "drained".');
    expect(result.report).toBeNull();

    // The queue selected, worked and completed the task, then found no further eligible work.
    expect(journey.status()).toBe('Done');
    // The runner publishes the composed parent's states; the invoked child owns its rounds.
    expect(stateNames(journey.events)).toEqual([
      'select',
      'route',
      'delivery',
      'completeDelivery',
      'select',
      'drained',
    ]);
    expect(lifecycleNames(journey.events)).toEqual(['starting', 'running', 'finished']);

    // Round 1 carries the real artifacts of every action.
    const development = await journey.artifact<DevelopmentOutput>(1, 'development.json');
    expect(development).toMatchObject({
      taskKey: 'NEX-1',
      profile: 'nexus-flash',
      status: 'completed',
      findingResponses: [],
    });
    const verification = await journey.artifact<VerificationOutput>(1, 'verification.json');
    expect(verification).toMatchObject({
      status: 'passed',
      headRevision: development.headRevision,
      checks: [{ name: 'journey check', exitCode: 0 }],
    });
    const delivery = await journey.artifact<DeliveryOutput>(1, 'delivery.json');
    expect(delivery).toEqual({
      repository: 'owner/repository',
      pullRequestNumber: 7,
      pullRequestUrl: 'https://github.com/owner/repository/pull/7',
      headRevision: development.headRevision,
    });
    const review = await journey.artifact<ReviewOutput>(1, 'review.json');
    expect(review).toMatchObject({
      profile: 'nexus-review',
      headRevision: development.headRevision,
      verdict: 'approved',
      findings: [],
    });
    const completion = await journey.artifact<CompletionOutput>(1, 'completion.json');
    expect(completion).toEqual({
      taskKey: 'NEX-1',
      pullRequestUrl: delivery.pullRequestUrl,
      reviewedHead: development.headRevision,
      mergeRevision,
      checks: [
        { name: 'validate', producer: 'validate.yml', revision: mergeRevision, result: 'passed' },
      ],
    });

    // The worktree is real: the prepared branch was pushed to and read from the local remote.
    const remoteHead = (
      await gitCommand(['ls-remote', journey.origin, 'refs/heads/task/NEX-1'], journey.root)
    )
      .trim()
      .split(/\s+/u)[0];
    expect(remoteHead).toBe(development.headRevision);
    expect(journey.githubCalls).toContain('create:task/NEX-1->main');
    expect(journey.githubCalls).toContain(`autoMerge:7@${development.headRevision}`);
    expect(journey.checks()).toHaveLength(1);
    // The source was queried for eligible work and the claim and completion used the configured
    // transitions; the operator presentation observed the same combined event stream.
    expect(journey.jiraCalls).toContain(
      'search:(project = NEX AND status = "To Do") OR (project = NEX AND status = "Idea") ' +
        'order by Rank ASC',
    );
    expect(journey.jiraCalls).toContain('transition:10001:11');
    expect(journey.jiraCalls).toContain('transition:10001:41');
    // Memory stays disabled for this configuration: no provider effect, receipt or evidence.
    expect(journey.events.filter((event) => event.type === 'memory')).toEqual([]);
    await expect(
      stat(path.join(path.dirname(journey.installationConfigPath), 'state', 'memory')),
    ).rejects.toThrow();
    expect(journey.presentation.join('')).toContain('NEX-1');
    // Every agent boundary names the ticket by its key with its Summary, in the operator's line.
    const boundaries = journey.events.filter((event) => event.type === 'agent-started');
    expect(
      boundaries.map((event) => {
        const data = event.data as {
          readonly agentName: string;
          readonly task: string;
          readonly summary: string;
        };
        return { agent: data.agentName, task: data.task, summary: data.summary };
      }),
    ).toEqual([
      { agent: 'developer', task: 'NEX-1', summary: 'Ship the finite journey' },
      { agent: 'reviewer', task: 'NEX-1', summary: 'Ship the finite journey' },
    ]);
    expect(journey.presentation.join('')).toContain('task NEX-1 "Ship the finite journey"');

    // Preparation ran the configured command once and its output is preserved.
    expect(
      await readFile(path.join(journey.workspace, 'state/preparation/0/stdout.log'), 'utf8'),
    ).toBe('preparing\n');
    // The developer and the reviewer each ran once with the configured profiles, and the ticket
    // carries both reports.
    expect(journey.prompts).toHaveLength(2);
    expect(journey.prompts[0]).toContain('No review findings are supplied for this round.');
    expect(journey.prompts[1]).toContain(`Reviewed revision: ${development.headRevision}`);
    expect(journey.comments()).toHaveLength(2);

    // Every action outcome survives the worker transport into the execution's JSONL log, and each
    // artifact reference names a file the action really saved.
    const outcomes = (await savedLogEntries(journey.executionDirectory)).filter(
      (event) => event.type === 'outcome',
    );
    expect(outcomes).toEqual(journey.events.filter((event) => event.type === 'outcome'));
    expect(
      outcomes.map(
        (event) => `${event.source}:${String((event.data as { outcome: string }).outcome)}`,
      ),
    ).toEqual([
      'select-work:selected',
      'prepare-workspace:prepared',
      'start-round:started',
      'develop:completed',
      'verify:passed',
      'deliver:published',
      'review:approved',
      'complete-task:completed',
    ]);
    for (const outcome of outcomes) {
      const { artifact } = outcome.data as { readonly artifact: { readonly path: string } };
      await expect(readFile(artifact.path)).resolves.toBeDefined();
    }
  });

  it('completes a review-requested repair with the complete finding handoff', async () => {
    const journey = await finiteJourney();
    const finding: Finding = {
      id: 'F1',
      title: 'The feature ships unguarded',
      severity: 'blocking',
      basis: 'The task requires the guarded behavior.',
      evidence: 'feature.txt declares the feature without its guard.',
      impact: 'The unguarded behavior reaches production.',
      repairGuidance: 'Add the guard to feature.txt and document the case it rejects.',
      locations: [{ path: 'feature.txt', line: 1 }],
    };
    // The reviewer's strict response shape carries every location's line, null when it has none.
    const reportedFinding: ReviewResponse['findings'][number] = {
      ...finding,
      locations: finding.locations.map((location) => ({
        path: location.path,
        line: location.line ?? null,
      })),
    };
    const repairResponse = 'Added the guard and documented the rejected case.';

    const exitCode = await journey.run([
      developerTurn(async (request) => {
        await writeFile(path.join(request.directory, 'feature.txt'), 'the feature without guard\n');
        await commitAll(request.directory, 'add the feature');
        return {
          status: 'completed',
          summary: 'Added the feature.',
          findingResponses: [],
        };
      }),
      reviewerTurn(async () => ({
        verdict: 'changesRequested',
        summary: 'The feature is missing its required guard.',
        findings: [reportedFinding],
        priorFindings: [],
      })),
      developerTurn(async (request) => {
        // The repair round receives the preceding review's complete Finding value.
        expect(request.prompt).toContain('Findings to respond to (complete values from the review');
        for (const value of [
          finding.id,
          finding.title,
          finding.basis,
          finding.evidence,
          finding.impact,
          finding.repairGuidance,
          finding.locations[0]?.path ?? '',
        ]) {
          expect(request.prompt).toContain(value);
        }
        await writeFile(path.join(request.directory, 'feature.txt'), 'the guarded feature\n');
        await commitAll(request.directory, 'add the guard');
        return {
          status: 'completed',
          summary: repairResponse,
          findingResponses: [
            { findingId: finding.id, status: 'addressed', response: repairResponse },
          ],
        };
      }),
      reviewerTurn(async (request) => {
        // The next review receives the same finding and the developer's actual response.
        expect(request.prompt).toContain(finding.id);
        expect(request.prompt).toContain(finding.repairGuidance);
        expect(request.prompt).toContain(repairResponse);
        return {
          verdict: 'approved',
          summary: 'The guard resolves the finding on the reviewed revision.',
          findings: [],
          priorFindings: [
            {
              findingId: finding.id,
              disposition: 'resolved',
              reason: 'The guard is present and the developer response matches the revision.',
            },
          ],
        };
      }),
    ]);

    const result = journey.finished();
    expect(exitCode, JSON.stringify(result)).toBe(0);
    expect(journey.recoveries).toEqual([]);
    expect(result.outcome).toBe('completed');
    expect(journey.status()).toBe('Done');
    expect(stateNames(journey.events)).toEqual([
      'select',
      'route',
      'delivery',
      'completeDelivery',
      'select',
      'drained',
    ]);

    // The rejection routed through StartRound, which continued the initial ladder profile.
    expect(
      JSON.parse(await readFile(path.join(journey.workspace, 'state/current-round.json'), 'utf8')),
    ).toEqual({
      number: 2,
      profile: 'nexus-flash',
      reason: expect.stringContaining('continues with the initial profile "nexus-flash"'),
    });
    // Round 1 recorded the requested repair and its complete finding.
    const firstReview = await journey.artifact<ReviewOutput>(1, 'review.json');
    expect(firstReview).toMatchObject({ verdict: 'changesRequested', findings: [finding] });
    // Round 2 carries the developer's response and its disposition through the same values.
    const repairDevelopment = await journey.artifact<DevelopmentOutput>(2, 'development.json');
    expect(repairDevelopment).toMatchObject({
      profile: 'nexus-flash',
      status: 'completed',
      findingResponses: [{ findingId: finding.id, status: 'addressed', response: repairResponse }],
    });
    expect(repairDevelopment.headRevision).not.toBe(firstReview.headRevision);
    const secondReview = await journey.artifact<ReviewOutput>(2, 'review.json');
    expect(secondReview).toMatchObject({
      verdict: 'approved',
      findings: [],
      priorFindings: [{ findingId: finding.id, disposition: 'resolved' }],
    });
    const completion = await journey.artifact<CompletionOutput>(2, 'completion.json');
    expect(completion.reviewedHead).toBe(repairDevelopment.headRevision);
    // The pull request was updated in place rather than created again.
    expect(journey.githubCalls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
    expect(journey.githubCalls.filter((call) => call.startsWith('update:'))).toHaveLength(1);
    // The round-2 delivery report counts the one executed repair turn from the development history.
    expect(commentText(journey.comments()[2]?.body)).toContain('Repairs used: 1.');
    expect(journey.comments()).toHaveLength(4);
  });

  it('recovers an interrupted worker and continues the retained execution', async () => {
    const journey = await finiteJourney();
    let interruptedSnapshot: Record<string, unknown> | null = null;
    const report: RecoveryReport = {
      summary: 'The provider ended the first attempt; the retained execution can continue.',
      decision: { kind: 'resume' },
    };

    const exitCode = await journey.run(
      [
        async (request) => {
          expect(request.prompt).toContain('You are the Nexus development agent.');
          // The interrupted attempt leaves uncommitted work behind and the provider ends.
          await writeFile(path.join(request.directory, 'notes.txt'), 'retained notes\n');
          return fault('The coding provider process ended unexpectedly.');
        },
        developerTurn(async (request) => {
          await writeFile(path.join(request.directory, 'feature.txt'), 'the retained feature\n');
          await commitAll(request.directory, 'add the feature after the interruption');
          return {
            status: 'completed',
            summary: 'Added the retained feature after the interruption.',
            findingResponses: [],
          };
        }),
        reviewerTurn(async () => ({
          verdict: 'approved',
          summary: 'The change fulfils the task.',
          findings: [],
          priorFindings: [],
        })),
      ],
      async (request) => {
        // The recovery invocation receives the failure, the retained selection and the real paths.
        expect(request.context).toContain('Execution fault:');
        expect(request.context).toContain('The coding provider process ended unexpectedly.');
        expect(request.context).toContain('Issue NEX-1 retained the stage "delivery"');
        expect(request.context).toContain(workflowPath);
        // Recovery works from the direct failure evidence; no retrieval block supplements it.
        expect(request.context).not.toContain(
          'Historical evidence from earlier Nexus hand-offs (agent memory).',
        );
        interruptedSnapshot = JSON.parse(
          await readFile(path.join(journey.executionDirectory, 'workflow.json'), 'utf8'),
        ) as Record<string, unknown>;
        return report;
      },
    );

    const result = journey.finished();
    expect(exitCode, JSON.stringify(result)).toBe(0);
    expect(journey.diagnostics).toEqual([]);
    expect(journey.recoveries).toHaveLength(1);
    expect(lifecycleNames(journey.events)).toEqual([
      'starting',
      'running',
      'recovering',
      'recovered',
      'running',
      'finished',
    ]);
    expect(result.outcome).toBe('completed');
    expect(result.report?.path).toMatch(/\/recovery\/reports\/[^/]+\/1\.json$/u);
    // The recovery invocation's boundary names the retained ticket by key and Summary.
    expect(
      journey.events.find((event) => event.source === 'Recovery' && event.type === 'agent-started')
        ?.data,
    ).toMatchObject({ task: 'NEX-1', summary: 'Ship the finite journey' });
    // The saved recovery report is published with its reference once it is written.
    expect(journey.events.find((event) => event.type === 'recovered')).toEqual({
      source: 'application',
      type: 'recovered',
      data: { decision: 'resume', report: { path: result.report!.path } },
    });
    expect(JSON.parse(await readFile(result.report?.path ?? '', 'utf8'))).toEqual(report);
    expect(journey.notifications).toHaveLength(1);
    expect(journey.notifications[0]?.subject).toContain('resume');
    expect(journey.notifications[0]?.body).toContain(report.summary);
    // The interrupted attempt keeps its direct artifacts; memory records no evidence for it.
    const logDirectories = await readdir(path.join(journey.executionDirectory, 'logs'));
    await expect(
      stat(path.join(journey.executionDirectory, 'logs', logDirectories[0]!, 'memory')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(journey.status()).toBe('Done');

    // The interrupted run persisted the parent's active delivery child; the restarted worker
    // restored it instead of selecting and preparing the task again.
    expect(interruptedSnapshot).toMatchObject({ status: 'active', value: 'delivery' });
    // The restarted worker restored the active delivery child, so the parent state is published
    // again before it advances to completion.
    expect(stateNames(journey.events)).toEqual([
      'select',
      'route',
      'delivery',
      'delivery',
      'completeDelivery',
      'select',
      'drained',
    ]);

    // The retained workspace and round continued; the preparation command did not run again.
    const development = await journey.artifact<DevelopmentOutput>(1, 'development.json');
    expect(development).toMatchObject({ taskKey: 'NEX-1', status: 'completed' });
    expect(
      JSON.parse(await readFile(path.join(journey.workspace, 'state/current-round.json'), 'utf8')),
    ).toEqual({
      number: 1,
      profile: 'nexus-flash',
      reason: expect.stringContaining(
        'initial implementation uses the first profile "nexus-flash"',
      ),
    });
    expect(await gitCommand(['ls-tree', '--name-only', 'HEAD'], journey.worktree)).toContain(
      'notes.txt',
    );
    expect(journey.prompts).toHaveLength(3);
    // Agent activity travels on the attributable channel, not the main event stream.
    expect(journey.events.filter((event) => event.type === 'agent-activity')).toEqual([]);
    const startedIds = journey.events
      .filter((event) => event.type === 'agent-started')
      .map((event) => (event.data as { readonly invocationId: string }).invocationId);
    // Every activity packet names an announced invocation, and no invocation is anonymous.
    expect(journey.activity).toHaveLength(3);
    for (const packet of journey.activity) {
      expect(startedIds).toContain(packet.invocationId);
    }
    expect(new Set(journey.activity.map((packet) => packet.invocationId)).size).toBe(3);
    // Each finish names the identity its start announced, including the recovery invocation.
    expect(
      journey.events
        .filter((event) => event.type === 'agent-finished')
        .map((event) => (event.data as { readonly invocationId: string }).invocationId),
    ).toEqual(startedIds);
  });

  it('exposes the memory tools without automatic recall or hand-off ingestion', async () => {
    const journey = await finiteJourney({ memory: true });

    const exitCode = await journey.run([
      developerTurn(async (request) => {
        await writeFile(path.join(request.directory, 'feature.txt'), 'the feature\n');
        await commitAll(request.directory, 'add the feature');
        return {
          status: 'completed',
          summary: 'Added feature.txt for the memory journey.',
          findingResponses: [],
        };
      }),
      reviewerTurn(async () => ({
        verdict: 'approved',
        summary: 'The change fulfils the task and the configured check covers it.',
        findings: [],
        priorFindings: [],
      })),
    ]);

    const result = journey.finished();
    expect(exitCode, JSON.stringify(result)).toBe(0);
    expect(result.outcome).toBe('completed');
    expect(journey.status()).toBe('Done');

    // Every invocation carries the configured AMEM MCP server and the shared memory guidance.
    expect(journey.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of journey.requests) {
      expect(request.toolSettings).toMatchObject({
        config: {
          'mcp_servers.amem.command': 'npm',
          'mcp_servers.amem.args': ['run', '--silent', 'mcp'],
          'mcp_servers.amem.cwd': path.join(
            path.dirname(journey.installationConfigPath),
            'agentic-memory',
          ),
          'mcp_servers.amem.env': { AMEM_MCP_SERVICE_URL: 'http://127.0.0.1:4748' },
        },
      });
      expect(request.prompt).toContain('Shared memory guidance');
    }

    // No invocation received a prepared retrieval block and no action ingested a hand-off.
    expect(
      journey.prompts.every(
        (prompt) => !prompt.includes('Historical evidence from earlier Nexus hand-offs'),
      ),
    ).toBe(true);
    expect(journey.events.filter((event) => event.type === 'memory')).toEqual([]);
    const logDirectories = await readdir(path.join(journey.executionDirectory, 'logs'));
    expect(logDirectories).toHaveLength(1);
    await expect(
      stat(path.join(journey.executionDirectory, 'logs', logDirectories[0]!, 'memory')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // The confirmed completion was recorded once by the terminal handoff and analyzed after the
    // queue drained; the controlled analyst reported no reusable lesson, so nothing was submitted.
    expect(journey.analyses).toHaveLength(1);
    // The analyst reads the request's retained copy of the handoff's evidence.
    expect(journey.analyses[0]?.context).toContain('Retained evidence root:');
    expect(journey.analyses[0]?.workspace.root).toContain(
      path.join('memory', 'evidence', 'NEX-1-complete-completed-'),
    );
    const requests = await readdir(path.join(journey.executionDirectory, 'memory', 'requests'));
    expect(requests).toHaveLength(1);
    expect(journey.diagnostics).toEqual([]);
  });

  it('records a blocked preparation failure with the reason and evidence its producer retained', async () => {
    const service = await controlledService();
    const journey = await finiteJourney({
      memory: true,
      memoryServiceUrl: service.url,
      preparation: [{ executable: 'bash', args: ['-c', 'echo cannot prepare >&2; exit 3'] }],
    });

    const exitCode = await journey.run([], async () => ({
      summary: 'The blocked preparation needs its own delivery attempt.',
      decision: { kind: 'resume' },
    }));

    const result = journey.finished();
    expect(exitCode, JSON.stringify(result)).toBe(1);
    expect(result.outcome).toBe('needs-attention');
    // The blocked outcome is the workflow's own verdict: recovery runs, an operational-error
    // handoff does not.
    expect(journey.recoveries.length).toBeGreaterThan(0);
    expect(result.reason).toContain('blocked');

    const requestsDirectory = path.join(journey.executionDirectory, 'memory', 'requests');
    const requestFiles = await readdir(requestsDirectory);
    expect(requestFiles).toHaveLength(1);
    const request = JSON.parse(
      await readFile(path.join(requestsDirectory, requestFiles[0]!), 'utf8'),
    ) as {
      readonly identity: string;
      readonly handoff: {
        readonly attemptId: string;
        readonly terminalId: string;
        readonly outcome: string;
        readonly reason: string | null;
        readonly artifacts: readonly { readonly path: string }[];
      };
      readonly evidenceRoot: string | null;
    };
    // The producer's stated reason and the attempt identity both survive in the durable record.
    expect(request.handoff.terminalId).toBe('prepare-failed');
    expect(request.handoff.outcome).toBe('failed');
    expect(request.handoff.reason).toContain('exit code 3');
    const attempt = JSON.parse(
      await readFile(path.join(journey.workspace, attemptFile), 'utf8'),
    ) as { readonly attemptId: string };
    expect(request.handoff.attemptId).toBe(attempt.attemptId);

    // The evidence is retained outside the attempt and still readable after the blocked execution.
    expect(request.evidenceRoot).not.toBeNull();
    const retainedRoot = request.evidenceRoot!;
    const retainedReason = JSON.parse(
      await readFile(path.join(retainedRoot, 'state', 'preparation-failure.json'), 'utf8'),
    ) as { readonly reason: string };
    expect(retainedReason.reason).toContain('exit code 3');
    expect(request.handoff.artifacts.map((artifact) => artifact.path)).toContain(
      path.join(journey.workspace, 'state', 'preparation-failure.json'),
    );
    // The terminal handoff reached the analyst with the producer's reason.
    expect(journey.analyses).toHaveLength(1);
    expect(journey.analyses[0]?.context).toContain('exit code 3');
    expect(journey.analyses[0]?.workspace.root).toBe(retainedRoot);
  });

  it('analyzes a confirmed completion and settles its submission after a restart', async () => {
    const service = await controlledService();
    let statusAtAnalysis = '';
    let journeyHandle: Journey | null = null;
    const journey = await finiteJourney({
      memory: true,
      memoryServiceUrl: service.url,
      analysis: (request) => {
        // The analyst runs only after the worker confirmed the merge, the checks and Done.
        statusAtAnalysis = journeyHandle?.status() ?? '';
        return Promise.resolve(
          ok({
            output: JSON.stringify({
              observations: [
                {
                  content: 'The completion artifact binds the merged revision to its checks.',
                  evidence: [
                    {
                      path: path.join(request.workspace.root, 'artifacts', '1', 'completion.json'),
                      revision: mergeRevision,
                      detail: 'The completion evidence of the merged revision.',
                    },
                  ],
                  relatedMemories: [],
                },
              ],
            }),
          }),
        );
      },
    });
    journeyHandle = journey;

    const exitCode = await journey.run([
      developerTurn(async (request) => {
        await writeFile(path.join(request.directory, 'feature.txt'), 'the feature\n');
        await commitAll(request.directory, 'add the feature');
        return {
          status: 'completed',
          summary: 'Added feature.txt for the analysis journey.',
          findingResponses: [],
        };
      }),
      reviewerTurn(async () => ({
        verdict: 'approved',
        summary: 'The change fulfils the task.',
        findings: [],
        priorFindings: [],
      })),
    ]);

    const result = journey.finished();
    expect(exitCode, JSON.stringify(result)).toBe(0);
    expect(result.outcome).toBe('completed');
    expect(journey.status()).toBe('Done');
    // Analysis ran only after the confirmed completion, and the outcome did not wait for memory.
    expect(statusAtAnalysis).toBe('Done');
    expect(journey.analyses).toHaveLength(1);
    const handoff: ExperienceHandoff = {
      workId: 'NEX-1',
      workflow: 'finite-delivery',
      attemptId: await journey.attemptId(),
      terminalId: 'complete-completed',
      outcome: 'completed',
      reason: null,
      workspaceRoot: journey.workspace,
      artifacts: [],
    };
    const identity = experienceIdentity(handoff);
    const submitted = service.requests.find((request) => request.path === '/v1/observations')
      ?.body as { readonly sourceKey: string; readonly content: string } | undefined;
    // The stable source key binds the captured request and the persisted observation.
    expect(submitted?.sourceKey).toBe(experienceObservationSourceKey(identity, '1'));
    expect(submitted?.content).toBe(
      'The completion artifact binds the merged revision to its checks.',
    );
    // Acceptance is queued durably, not stored: the outstanding submission is reported.
    expect(journey.diagnostics.join('')).toContain(
      'the submission of observation 1 of NEX-1 is outstanding',
    );

    // The stored receipt settles the submission on the next start without another analysis.
    service.store(experienceObservationSourceKey(identity, '1'));
    const reported = journey.diagnostics.length;
    const restarted = await journey.run([]);

    expect(restarted).toBe(0);
    expect(journey.analyses).toHaveLength(1);
    expect(journey.diagnostics.slice(reported)).toEqual([]);
    const submission = JSON.parse(
      await readFile(
        path.join(journey.executionDirectory, 'memory', 'submissions', identity, '1.json'),
        'utf8',
      ),
    ) as { readonly status: string; readonly noteId: string | null };
    expect(submission.status).toBe('stored');
    expect(submission.noteId).not.toBeNull();
  });

  it('keeps the business outcome when the configured memory service is unreachable', async () => {
    const journey = await finiteJourney({
      memory: true,
      memoryServiceUrl: 'http://127.0.0.1:1',
      analysis: (request) =>
        Promise.resolve(
          ok({
            output: JSON.stringify({
              observations: [
                {
                  content: 'A lesson the unreachable service cannot accept.',
                  evidence: [
                    {
                      path: path.join(request.workspace.root, 'artifacts', '1', 'completion.json'),
                      revision: mergeRevision,
                      detail: 'The completion evidence.',
                    },
                  ],
                  relatedMemories: [],
                },
              ],
            }),
          }),
        ),
    });

    const exitCode = await journey.run([
      developerTurn(async (request) => {
        await writeFile(path.join(request.directory, 'feature.txt'), 'the feature\n');
        await commitAll(request.directory, 'add the feature');
        return {
          status: 'completed',
          summary: 'Added feature.txt without reaching the memory service.',
          findingResponses: [],
        };
      }),
      reviewerTurn(async () => ({
        verdict: 'approved',
        summary: 'The change fulfils the task and the configured check covers it.',
        findings: [],
        priorFindings: [],
      })),
    ]);

    const result = journey.finished();
    expect(exitCode, JSON.stringify(result)).toBe(0);
    expect(result.outcome).toBe('completed');
    expect(journey.status()).toBe('Done');
    // Memory is supplemental: the outage is reported as outstanding work, no workflow event
    // changes and no business recovery runs for it.
    expect(journey.events.filter((event) => event.type === 'memory')).toEqual([]);
    expect(journey.recoveries).toEqual([]);
    expect(journey.diagnostics.join('')).toContain(
      'Nexus memory analysis: the submission of observation 1 of NEX-1 is outstanding',
    );
    expect(journey.diagnostics.join('')).toContain('could not be reached');
  });
});
