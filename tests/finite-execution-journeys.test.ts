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

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
import { loadWorkflow } from '../src/application/workflow.js';
import { loadNexusConfiguration, loadProjectConfiguration } from '../src/configuration/index.js';
import { fault, ok } from '../src/result.js';
import {
  createTaskEngine,
  type AgentActivity,
  type EngineEvent,
} from '../src/task-engine/index.js';
import type { CompletionOutput } from '../src/task-engine/actions/complete-task/artifacts.js';
import type { DeliveryOutput } from '../src/task-engine/actions/deliver/artifacts.js';
import type {
  DevelopmentOutput,
  DevelopmentResponse,
} from '../src/task-engine/actions/develop/artifacts.js';
import type {
  Finding,
  ReviewOutput,
  ReviewResponse,
} from '../src/task-engine/actions/review/artifacts.js';
import type { VerificationOutput } from '../src/task-engine/actions/verify/artifacts.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';
import { scriptedGitHub } from './support/github.js';
import { scriptedJira } from './support/jira.js';

/** The configured workflow is the real finite workflow module, loaded through Application. */
const workflowPath = fileURLToPath(new URL('../workflows/finite-delivery.ts', import.meta.url));

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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
function scriptedCodingRuntime(turns: readonly AgentTurn[], prompts: string[]): CodingRuntime {
  let index = 0;
  return {
    async execute(request, onActivity) {
      prompts.push(request.prompt);
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
    return ok({ output: JSON.stringify(await work(request)) });
  };
}

/** One review turn: it asserts its role and returns the agent's ReviewResponse. */
function reviewerTurn(work: (request: CodingRuntimeRequest) => Promise<ReviewResponse>): AgentTurn {
  return async (request) => {
    expect(request.prompt).toContain('You are the Nexus reviewer.');
    return ok({ output: JSON.stringify(await work(request)) });
  };
}

/** Recovery is unexpected in a journey that supplies no recovery turn. */
const unexpectedRecovery: RecoveryTurn = () =>
  Promise.resolve({
    summary: 'The journey expected no recovery invocation.',
    decision: { kind: 'needs-attention' },
  });

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
    const workflow = await loadWorkflow(nexus.workflow[request.workflow]);
    const paths = executionPaths(nexus, project, request.workflow);
    await mkdir(paths.directory, { recursive: true });
    const engine = createTaskEngine({
      workflow: workflow.machine,
      stateFile: paths.workflowStateFile,
      bindActions: createActionBinding({
        workflow: request.workflow,
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
  readonly recoveries: readonly RecoveryInvocationRequest[];
  readonly notifications: readonly { readonly subject: string; readonly body: string }[];
  readonly diagnostics: readonly string[];
  readonly presentation: readonly string[];
  readonly jiraCalls: readonly string[];
  readonly githubCalls: readonly string[];
  status(): string;
  comments(): readonly JiraComment[];
  checks(): readonly CheckObservation[];
  finished(): ExecutionResult;
  artifact<Value>(round: number, name: string): Promise<Value>;
  run(turns: readonly AgentTurn[], recovery?: RecoveryTurn): Promise<number>;
};

/**
 * Assemble one journey: a local remote with main, temporary installation and project
 * configuration, a controlled Jira source and GitHub service and the real operator command over
 * the real Application.
 */
async function finiteJourney(): Promise<Journey> {
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
  nexus.workflow['finite-delivery'] = workflowPath;
  nexus.storage.root = './state';
  nexus.executionPolicy.developerLadder = [{ profile: 'nexus-flash', repairAllowance: 2 }];
  const project = projectConfiguration();
  project.repository.source = origin;
  project.preparation = [{ executable: 'bash', args: ['-c', 'echo preparing'] }];
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
    recoveries,
    notifications,
    diagnostics,
    presentation,
    jiraCalls: source.calls,
    githubCalls: delivery.calls,
    status: () => status,
    comments: () => comments,
    checks: () => checks,
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
        codingRuntime: scriptedCodingRuntime(turns, prompts),
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
          const application = createApplication({ ...settings, launchWorker, recovery });
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
    expect(stateNames(journey.events)).toEqual([
      'select',
      'prepare',
      'startRound',
      'develop',
      'verify',
      'deliver',
      'review',
      'complete',
      'select',
      'finished',
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
      'search:project = NEX AND status = "To Do" order by Rank ASC',
    );
    expect(journey.jiraCalls).toContain('transition:10001:11');
    expect(journey.jiraCalls).toContain('transition:10001:41');
    expect(journey.presentation.join('')).toContain('NEX-1');

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
    expect(outcomes).toEqual([
      {
        source: 'select-task',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: null,
          outcome: 'selected',
          detail: null,
          artifact: { path: path.join(journey.executionDirectory, 'selection.json') },
        },
      },
      {
        source: 'prepare-workspace',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: null,
          outcome: 'prepared',
          detail: 'branch task/NEX-1',
          artifact: { path: path.join(journey.workspace, 'state', 'prepared-workspace.json') },
        },
      },
      {
        source: 'start-round',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: 1,
          outcome: 'started',
          detail: 'profile nexus-flash',
          artifact: { path: path.join(journey.workspace, 'state', 'current-round.json') },
        },
      },
      {
        source: 'develop',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: 1,
          outcome: 'completed',
          detail: 'profile nexus-flash',
          artifact: { path: path.join(journey.workspace, 'artifacts', '1', 'development.json') },
        },
      },
      {
        source: 'verify',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: 1,
          outcome: 'passed',
          detail: '1 check',
          artifact: { path: path.join(journey.workspace, 'artifacts', '1', 'verification.json') },
        },
      },
      {
        source: 'deliver',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: 1,
          outcome: 'published',
          detail: 'PR #7',
          artifact: { path: path.join(journey.workspace, 'artifacts', '1', 'delivery.json') },
        },
      },
      {
        source: 'review',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: 1,
          outcome: 'approved',
          detail: 'profile nexus-review',
          artifact: { path: path.join(journey.workspace, 'artifacts', '1', 'review.json') },
        },
      },
      {
        source: 'complete-task',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: 1,
          outcome: 'completed',
          detail: 'PR #7',
          artifact: { path: path.join(journey.workspace, 'artifacts', '1', 'completion.json') },
        },
      },
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
        findings: [finding],
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
      'prepare',
      'startRound',
      'develop',
      'verify',
      'deliver',
      'review',
      'startRound',
      'develop',
      'verify',
      'deliver',
      'review',
      'complete',
      'select',
      'finished',
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
        expect(request.context).toContain('Task NEX-1 retained the workspace at');
        expect(request.context).toContain(workflowPath);
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
    expect(journey.status()).toBe('Done');

    // The interrupted run persisted the active invocation of Develop; the restarted worker
    // restored it instead of selecting and preparing the task again.
    expect(interruptedSnapshot).toMatchObject({ status: 'active', value: 'develop' });
    expect(stateNames(journey.events)).toEqual([
      'select',
      'prepare',
      'startRound',
      'develop',
      'develop',
      'verify',
      'deliver',
      'review',
      'complete',
      'select',
      'finished',
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
});
