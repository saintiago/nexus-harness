/**
 * System journey: the assembled operator command runs the real idea refinement workflow through
 * the real Application, action binding, TaskEngine and storage over a temporary installation,
 * a real local Git remote and a controlled Jira source.
 *
 * Substituted: the worker process boundary (the launch composes the worker's real configuration
 * loading, workflow loading, TaskEngine and action binding in process), the Jira service and agent
 * execution (a controlled coding runtime that answers each role's invocation). Everything else —
 * workflow, actions, artifact storage, Git and the command line — is the real implementation.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import type { GitHubAdapter } from '../src/adapters/github.js';
import type { JiraComment, JiraIssue, JiraTransition } from '../src/adapters/jira.js';
import { run, type ProcessOutput } from '../src/adapters/processes.js';
import { createActionBinding } from '../src/application/action-bindings.js';
import { runOperatorCommand } from '../src/application/command.js';
import { executionPaths, toolEnvironment } from '../src/application/composition.js';
import {
  createApplication,
  type ApplicationSettings,
  type ExecutionEvent,
  type ExecutionResult,
  type WorkerLaunch,
} from '../src/application/index.js';
import { installationConfigSetting } from '../src/application/installation.js';
import type { RecoveryRuntimeFactory } from '../src/application/recovery.js';
import { loadWorkflow } from '../src/application/workflow.js';
import { loadNexusConfiguration, loadProjectConfiguration } from '../src/configuration/index.js';
import { fault, ok } from '../src/result.js';
import {
  createTaskEngine,
  type AgentActivity,
  type EngineEvent,
} from '../src/task-engine/index.js';
import type { IdeaRole } from '../src/agent-runtime/index.js';
import {
  editorResponseArtifact,
  framingArtifact,
  refinedIdeaArtifact,
  type RefinedIdeaContent,
} from '../src/task-engine/actions/idea-editor/artifacts.js';
import {
  ideaCommunicationText,
  ideaDefinitionText,
  ideaStageGuidanceText,
} from '../src/task-engine/actions/idea-context.js';
import {
  type IdeaDecisionRecord,
  type IdeaHandoff,
} from '../src/task-engine/actions/publish-decision/artifacts.js';
import type { IdeaRoundPlan } from '../src/task-engine/actions/start-idea-round/artifacts.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';
import { scriptedJira } from './support/jira.js';
import { strictSchemaProblems } from './support/provider-schema.js';

/** The configured workflow is the real idea refinement module, loaded through Application. */
const workflowPath = fileURLToPath(new URL('../workflows/idea-refinement.ts', import.meta.url));

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

/** The text of one published comment document. */
function commentText(document: unknown): string {
  const content =
    typeof document === 'object' && document !== null
      ? (document as { readonly content?: readonly { readonly content?: unknown }[] }).content
      : undefined;
  return (content ?? [])
    .flatMap((paragraph) => {
      const text = paragraph.content;
      return Array.isArray(text)
        ? text.flatMap((node) =>
            typeof (node as { readonly text?: unknown }).text === 'string'
              ? [(node as { readonly text: string }).text]
              : [],
          )
        : [];
    })
    .join('\n');
}

/** The role whose constant instructions the prompt carries, or null for another invocation. */
function roleOf(prompt: string): IdeaRole | null {
  if (prompt.includes('Be clear, perceptive and lightly witty')) return 'idea-editor';
  if (prompt.includes('Be idealistic, trusting and receptive')) return 'researcher';
  if (prompt.includes('Be wise and thoughtful about the project')) return 'project-guide';
  if (prompt.includes('Be pragmatic, precise and candid')) return 'challenger';
  return null;
}

/** The editor task the invocation context names. */
function editorTaskOf(prompt: string): string {
  if (prompt.includes('Frame the author\u2019s proposed change')) return 'frame';
  if (prompt.includes('Write the refined idea revision')) return 'edit';
  if (prompt.includes('Answer the Challenger with the focused help')) return 'respond-after-help';
  if (prompt.includes('Respond to the Challenger\u2019s concern')) return 'respond';
  return 'unknown';
}

/** One scripted role answer: its parsed response value. */
type RoleAnswer = (turn: number, request: CodingRuntimeRequest) => unknown;

/** What one assembled idea journey observed and the handles its assertions use. */
type IdeaJourney = {
  readonly root: string;
  readonly executionDirectory: string;
  readonly refinement: string;
  readonly worktree: string;
  readonly issueWorkspace: string;
  readonly events: readonly ExecutionEvent[];
  readonly activity: readonly AgentActivity[];
  readonly prompts: string[];
  readonly jiraCalls: readonly string[];
  readonly diagnostics: readonly string[];
  status(): string;
  comments(): readonly JiraComment[];
  resubmit(text: string): void;
  finished(): ExecutionResult;
  plan(): Promise<IdeaRoundPlan>;
  artifact<Value>(relative: string): Promise<Value>;
  exists(relative: string): Promise<boolean>;
  run(respond: RoleAnswer): Promise<number>;
};

/** What one journey's captured issue and retained refinement area hold before it runs. */
type IdeaJourneySetup = {
  /** The captured issue's summary; the default is the lint-gate idea. */
  readonly summary?: string;
  /** The captured issue's description text, as one paragraph. */
  readonly description?: string;
  /** The captured conversation's author comments, in order. */
  readonly conversation?: readonly string[];
  /**
   * Retained refinement artifacts, by path relative to the refinement area, given with the
   * refinement area's absolute path so a retained record may reference its artifacts.
   */
  readonly retained?: (refinement: string) => Readonly<Record<string, unknown>>;
};

/** Assemble one journey: a local remote, temporary configuration and a controlled Jira source. */
async function ideaJourney(options: IdeaJourneySetup = {}): Promise<IdeaJourney> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-idea-journey-'));
  temporaryDirectories.push(root);

  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  await gitCommand(['init', '--quiet', '--bare', '--initial-branch=main', origin], root);
  await gitCommand(['init', '--quiet', '--initial-branch=main', seed], root);
  await writeFile(path.join(seed, 'readme.md'), 'the connected project\n');
  await writeFile(
    path.join(seed, 'AGENTS.md'),
    '# Project instructions\n\nPrefer the smallest change that fulfils the purpose.\n',
  );
  await mkdir(path.join(seed, 'docs'), { recursive: true });
  await writeFile(path.join(seed, 'docs', 'purpose.md'), '# Purpose\n\nServe operators.\n');
  await gitCommand(['add', '--all'], seed);
  await gitCommand(['commit', '--quiet', '--message', 'initial'], seed);
  await gitCommand(['remote', 'add', 'origin', origin], seed);
  await gitCommand(['push', '--quiet', 'origin', 'main'], seed);

  const installationDirectory = path.join(root, 'installation');
  const projectDirectory = path.join(root, 'project');
  await mkdir(installationDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  const nexus = nexusConfiguration();
  nexus.workflow['idea-refinement'] = workflowPath;
  nexus.storage.root = './state';
  const project = projectConfiguration();
  project.repository.source = origin;
  const installationConfigPath = path.join(installationDirectory, 'nexus.config.json');
  const projectConfigPath = path.join(projectDirectory, 'project.config.json');
  await writeFile(installationConfigPath, JSON.stringify(nexus));
  await writeFile(projectConfigPath, JSON.stringify(project));

  const storage = path.join(installationDirectory, 'state');
  const executionDirectory = path.join(storage, 'executions', 'NEX', 'idea-refinement');
  const issueWorkspace = path.join(storage, 'workspaces', 'NEX', 'NEX-1');
  const refinement = path.join(issueWorkspace, 'refinement');
  const worktree = path.join(refinement, 'worktree');

  const issueId = '10518';
  const issueKey = 'NEX-1';
  const workspacePointerField = project.taskSource.fields.workspacePointer;
  const statusIds: Record<string, string> = {
    Idea: '1',
    'Idea Refinement': '2',
    Draft: '3',
    'Waiting for Feedback': '4',
  };
  let status = 'Idea';
  const fields: Record<string, unknown> = {};
  const comments: JiraComment[] = (options.conversation ?? []).map((text, index) => ({
    id: `c${String(index + 1)}`,
    body: { text },
  }));
  let nextCommentId = comments.length + 1;
  const transitionsByStatus: Record<string, JiraTransition[]> = {
    Idea: [{ id: '11', name: 'Start refinement', to: { id: '2', name: 'Idea Refinement' } }],
    'Idea Refinement': [
      { id: '21', name: 'Approve', to: { id: '3', name: 'Draft' } },
      { id: '22', name: 'Request feedback', to: { id: '4', name: 'Waiting for Feedback' } },
    ],
    'Waiting for Feedback': [{ id: '31', name: 'Resubmit', to: { id: '1', name: 'Idea' } }],
    Draft: [],
  };
  const issueOf = (): JiraIssue => ({
    id: issueId,
    key: issueKey,
    fields: {
      ...fields,
      summary: options.summary ?? 'Add a lint gate',
      description:
        options.description === undefined
          ? { type: 'doc', version: 1, content: [] }
          : {
              type: 'doc',
              version: 1,
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: options.description }] },
              ],
            },
      status: { id: statusIds[status], name: status },
    },
  });

  // Retained artifacts of earlier submissions, saved before the run as the shared workspace's
  // history: a legacy plan, brief and decision, or artifacts this implementation wrote.
  for (const [relative, value] of Object.entries(options.retained?.(refinement) ?? {})) {
    const file = path.join(refinement, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }
  const source = scriptedJira({
    searchIssues: () => ok(status === 'Idea' ? [{ id: issueId, key: issueKey }] : []),
    readIssue: () => ok(issueOf()),
    readComments: () => ok([...comments]),
    readTransitions: () => ok(transitionsByStatus[status] ?? []),
    updateFields: (_issueId, updates) => {
      if (updates.workspacePointer !== undefined) {
        fields[workspacePointerField] = updates.workspacePointer;
      }
      return ok(undefined);
    },
    transitionIssue: (_issueId, transitionId) => {
      const transition = (transitionsByStatus[status] ?? []).find(
        (candidate) => candidate.id === transitionId,
      );
      if (transition === undefined) {
        return fault(`Transition "${transitionId}" is not permitted from "${status}".`);
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

  const events: ExecutionEvent[] = [];
  const activity: AgentActivity[] = [];
  const prompts: string[] = [];
  const diagnostics: string[] = [];
  const unusedGitHub = new Proxy({} as GitHubAdapter, {
    get: () => () => fault('GitHub is not used by idea refinement.'),
  });

  /** The in-process worker launch: the real worker wiring over the journey's capabilities. */
  const launchWorker: WorkerLaunch = async (request, onEvent, onActivity) => {
    const loaded = await loadNexusConfiguration(installationConfigPath);
    const loadedProject = await loadProjectConfiguration(request.projectConfigPath);
    const workflow = await loadWorkflow(loaded.workflow[request.workflow]);
    const paths = executionPaths(loaded, loadedProject, request.workflow);
    await mkdir(paths.directory, { recursive: true });
    const engine = createTaskEngine({
      workflow: workflow.machine,
      stateFile: paths.workflowStateFile,
      bindActions: createActionBinding({
        workflow: request.workflow,
        project: loadedProject,
        nexus: loaded,
        paths,
        jira: source.jira,
        github: unusedGitHub,
        git,
        codingRuntime: journeyRuntime,
        runCommand: run,
        commandEnvironment: toolEnvironment(loadedProject, loaded, hostEnvironment),
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
    return { result, exitCode: result.ok ? 0 : 1, problem: null, diagnostics: '' };
  };

  let journeyRuntime: CodingRuntime = {
    execute: () => Promise.resolve(fault('No scripted answer is available.')),
  };

  const recovery: RecoveryRuntimeFactory = () => ({
    invoke: () =>
      Promise.resolve(
        ok({
          output: JSON.stringify({ summary: 'unexpected', decision: { kind: 'needs-attention' } }),
        }),
      ),
    notify: () => Promise.resolve(ok({ messageId: 'controlled' })),
  });

  return {
    root,
    executionDirectory,
    refinement,
    worktree,
    issueWorkspace,
    events,
    activity,
    prompts,
    jiraCalls: source.calls,
    diagnostics,
    status: () => status,
    comments: () => comments,
    resubmit(text) {
      // The author replies and moves the item back to the submitted status.
      comments.push({ id: `a${String(nextCommentId)}`, body: { text } });
      nextCommentId += 1;
      status = 'Idea';
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
    async plan() {
      return JSON.parse(
        await readFile(path.join(refinement, 'state', 'current-round.json'), 'utf8'),
      ) as IdeaRoundPlan;
    },
    async artifact<Value>(relative: string): Promise<Value> {
      return JSON.parse(await readFile(path.join(refinement, relative), 'utf8')) as Value;
    },
    async exists(relative: string): Promise<boolean> {
      try {
        await stat(path.join(refinement, relative));
        return true;
      } catch {
        return false;
      }
    },
    async run(respond: RoleAnswer): Promise<number> {
      const turns = new Map<IdeaRole, number>();
      journeyRuntime = {
        async execute(request, onActivity): Promise<CodingRuntimeResult> {
          prompts.push(request.prompt);
          onActivity({ type: 'message', text: 'controlled idea turn' });
          const role = roleOf(request.prompt);
          if (role === null) {
            return fault('No idea refinement role matches the invoked prompt.');
          }
          // Every idea role produces JSON, so each invocation carries its own response schema.
          expect(request.outputSchema).toBeDefined();
          // The schema reaches the provider in its strict structured-output subset.
          expect(strictSchemaProblems(request.outputSchema)).toEqual([]);
          const turn = (turns.get(role) ?? 0) + 1;
          turns.set(role, turn);
          return ok({ output: JSON.stringify(respond(turn, request)) });
        },
      };
      return runOperatorCommand({
        args: ['ideas', 'refine', '--project-config', projectConfigPath],
        workingDirectory: root,
        environment: { ...hostEnvironment, [installationConfigSetting]: installationConfigPath },
        output: { write: () => undefined },
        diagnostics: { write: (text) => diagnostics.push(text) },
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

/** The project guidance contribution every journey's Project guide returns. */
const guidanceAnswer = {
  contribution: 'The idea serves the project purpose of serving operators.',
  fit: 'The project already enforces checks in CI.',
  steering: [],
  constraints: [],
  evidence: ['docs/purpose.md'],
  provisional: false,
  uncertainty: [],
};

/** The research contribution every journey's Researcher returns. */
const researchAnswer = {
  contribution: 'Linters are widely used to keep reviews focused.',
  findings: ['Teams use linters to catch style defects early.'],
  options: ['Adopt the smallest lint configuration that covers the current repository.'],
  sources: [{ title: 'Lint overview', link: 'https://example.com/lint', accessed: '2026-09-24' }],
};

/** The framing every journey's editor writes before the contributions. */
const framingAnswer = {
  framing: 'The author proposes a lint gate so reviews can stay on behaviour.',
  questions: ['Is generated code in scope?'],
  authorDecision: null,
};

/** The refined idea revision a journey's editor writes. */
function refinedIdeaParts(revision: number): RefinedIdeaContent {
  return {
    idea: 'Reviewers spend time on style defects; a lint gate keeps reviews on behaviour.',
    projectFit: 'The project already enforces checks in CI.',
    feasibility: `Enable the smallest lint gate first (revision ${String(revision)}).`,
    openQuestions: [`Is generated code in scope? (revision ${String(revision)})`],
    changeSummary: `Refined idea revision ${String(revision)}.`,
  };
}

/** One editor answer that writes the supplied revision. */
function editorRevision(revision: number): unknown {
  return {
    disposition: 'revised',
    response: `I wrote revision ${String(revision)}.`,
    reason: null,
    help: null,
    refinedIdea: refinedIdeaParts(revision),
  };
}

/** One Challenger answer with the supplied verdict. */
function challengerAnswer(verdict: 'approve' | 'discuss'): unknown {
  return {
    verdict,
    assessment:
      verdict === 'approve'
        ? 'There is a plausible way forward.'
        : 'The value claim still lacks evidence.',
    obstacle:
      verdict === 'approve'
        ? null
        : 'Nothing yet shows a lint gate is worth the change to the project.',
    concerns:
      verdict === 'approve'
        ? []
        : [
            {
              concern: 'No evidence links lint gates to shorter reviews.',
              consequence: 'The value claim is unsubstantiated.',
              resolution: 'Cite a comparable project or study.',
            },
          ],
    suggestions: [],
  };
}

/** A scripted answer set: the four roles approve unless a journey overrides one. */
function approvingAnswers(overrides: Partial<Record<IdeaRole, RoleAnswer>> = {}): RoleAnswer {
  return (turn, request) => {
    const role = roleOf(request.prompt);
    if (role === null) {
      throw new Error('No idea refinement role matches the invoked prompt.');
    }
    const override = overrides[role];
    if (override !== undefined) {
      return override(turn, request);
    }
    switch (role) {
      case 'researcher':
        return researchAnswer;
      case 'project-guide':
        return guidanceAnswer;
      case 'challenger':
        return challengerAnswer('approve');
      case 'idea-editor': {
        const task = editorTaskOf(request.prompt);
        if (task === 'frame') {
          return framingAnswer;
        }
        if (task === 'edit') {
          return editorRevision(1);
        }
        // An answer that keeps the current revision resolves a concern without rewriting it.
        return {
          disposition: 'answered',
          response: 'The answer resolves the concern.',
          reason: null,
          help: null,
          refinedIdea: null,
        };
      }
    }
  };
}

describe('idea refinement journeys', () => {
  it('refines an idea to the approved state with retained artifacts and one capture', async () => {
    const journey = await ideaJourney();

    const exitCode = await journey.run(approvingAnswers());

    expect(exitCode, JSON.stringify(journey.finished())).toBe(0);
    expect(journey.status()).toBe('Draft');
    expect(journey.diagnostics).toEqual([]);
    // One capture per run: the issue and its conversation are read once, at selection.
    expect(journey.jiraCalls.filter((call) => call.startsWith('read:'))).toHaveLength(1);
    expect(journey.jiraCalls.filter((call) => call.startsWith('comments:'))).toHaveLength(1);

    const plan = await journey.plan();
    expect(plan).toEqual({
      submission: 1,
      cycle: 1,
      route: 'new',
      profiles: {
        'idea-editor': 'nexus-astra',
        researcher: 'nexus-astra',
        'project-guide': 'nexus-astra',
        challenger: 'nexus-review',
      },
    });
    const refinedIdea = await journey.artifact<RefinedIdeaContent & { revision: number }>(
      'artifacts/submissions/1/cycles/1/refined-idea.json',
    );
    expect(refinedIdea.revision).toBe(1);
    expect(await journey.exists('artifacts/submissions/1/input.json')).toBe(true);
    expect(await journey.exists('artifacts/submissions/1/cycles/1/editor-framing.json')).toBe(true);
    expect(await journey.exists('artifacts/submissions/1/cycles/1/researcher.json')).toBe(true);
    expect(await journey.exists('artifacts/submissions/1/cycles/1/project-guide.json')).toBe(true);

    // The approved handoff references the retained artifacts a later workflow reads.
    const handoff = await journey.artifact<IdeaHandoff>('artifacts/handoff.json');
    expect(handoff.issueWorkspace).toBe(journey.issueWorkspace);
    expect(handoff.refinedIdea).toBe(
      path.join(journey.refinement, 'artifacts/submissions/1/cycles/1/refined-idea.json'),
    );
    expect(handoff.editorResponses).toEqual([
      path.join(
        journey.refinement,
        `artifacts/submissions/1/cycles/1/${editorResponseArtifact.pathFromArtifactsRoot}`,
      ),
    ]);
    expect(handoff.contributions).toHaveLength(2);
    expect(handoff.challengerResults).toEqual([
      path.join(journey.refinement, 'artifacts/submissions/1/cycles/1/challenger.json'),
    ]);
    expect(await journey.exists('artifacts/submissions/1/decision.json')).toBe(true);
    expect(
      await journey.artifact<IdeaDecisionRecord>('artifacts/submissions/1/decision.json'),
    ).toMatchObject({
      decision: 'approved',
      source: { transition: { to: 'Draft' }, status: 'Draft' },
    });

    // The approved refined idea is published for the next workflow; internal discussion stays in
    // artifacts.
    expect(journey.comments()).toHaveLength(1);
    const published = commentText(journey.comments()[0]?.body);
    expect(published).toContain('Approved refined idea (revision 1)');
    expect(published).toContain(
      'Idea: Reviewers spend time on style defects; a lint gate keeps reviews on behaviour.',
    );
    expect(published).toContain('Project fit: The project already enforces checks in CI.');
    expect(published).toContain('Feasibility: Enable the smallest lint gate first (revision 1).');
    expect(published).toContain('Open questions:');
    expect(published).toContain('- Is generated code in scope? (revision 1)');
    expect(published).toContain('Conversation cycles used: 1');
    expect(published).toContain('What refinement changed: Refined idea revision 1.');
    expect(published).not.toContain('There is a plausible way forward.');

    // Every role's activity is attributable to its own invocation, including the two roles that
    // run concurrently: each announcement carries a distinct identity and its own activity log.
    const started = journey.events.filter((event) => event.type === 'agent-started');
    expect(started).toHaveLength(5);
    // Every role's boundary names the captured ticket by its key with its Summary.
    for (const event of started) {
      expect(event.data).toMatchObject({ idea: 'NEX-1', summary: 'Add a lint gate' });
    }
    const identities = started.map(
      (event) => (event.data as { readonly invocationId: string }).invocationId,
    );
    expect(new Set(identities).size).toBe(5);
    expect(
      started.map((event) => (event.data as { readonly log: { readonly path: string } }).log.path),
    ).toEqual(identities.map((id) => expect.stringContaining(id)));
    expect(journey.activity).toHaveLength(5);
    expect(new Set(journey.activity.map((packet) => packet.invocationId)).size).toBe(5);
    expect(
      journey.events
        .filter((event) => event.type === 'agent-finished')
        .map((event) => (event.data as { readonly invocationId: string }).invocationId),
    ).toEqual(identities);

    // Every role ran in the prepared refinement worktree with the captured idea and AGENTS.md.
    expect(journey.prompts).toHaveLength(5);
    expect(new Set(journey.prompts.map((prompt) => roleOf(prompt))).size).toBe(4);
    for (const prompt of journey.prompts) {
      expect(prompt).toContain('Add a lint gate');
      expect(prompt).toContain('Prefer the smallest change that fulfils the purpose.');
      expect(prompt).toContain(path.join(journey.worktree));
      // The shared definition, the stage guidance and the communication rule arrive exactly once
      // each, ahead of the role's own context and duties.
      expect(prompt.split(ideaDefinitionText)).toHaveLength(2);
      expect(prompt.split(ideaStageGuidanceText)).toHaveLength(2);
      expect(prompt.split(ideaCommunicationText)).toHaveLength(2);
      expect(prompt.indexOf(ideaStageGuidanceText)).toBeLessThan(prompt.indexOf('Add a lint gate'));
      expect(prompt.indexOf(ideaCommunicationText)).toBeLessThan(prompt.indexOf('Add a lint gate'));
    }
    expect((await readFile(path.join(journey.worktree, 'readme.md'), 'utf8')).trim()).toBe(
      'the connected project',
    );
  });

  it('answers a concern without changing the idea and approves the revision it reviewed', async () => {
    const journey = await ideaJourney();
    const nexus = JSON.parse(
      await readFile(path.join(journey.root, 'installation', 'nexus.config.json'), 'utf8'),
    ) as { ideaRefinement: { maxCycles: number } };
    nexus.ideaRefinement.maxCycles = 2;
    await writeFile(
      path.join(journey.root, 'installation', 'nexus.config.json'),
      JSON.stringify(nexus),
    );
    let assessments = 0;

    const exitCode = await journey.run(
      approvingAnswers({
        challenger: () =>
          assessments++ === 0 ? challengerAnswer('discuss') : challengerAnswer('approve'),
      }),
    );

    expect(exitCode, JSON.stringify(journey.finished())).toBe(0);
    expect(journey.status()).toBe('Draft');
    const plan = await journey.plan();
    expect(plan).toMatchObject({ submission: 1, cycle: 2, route: 'next' });
    // The answer kept the revision: cycle 2 wrote an editor response, not a new revision.
    expect(await journey.exists('artifacts/submissions/1/cycles/2/refined-idea.json')).toBe(false);
    const response = await journey.artifact<{ disposition: string }>(
      `artifacts/submissions/1/cycles/2/${editorResponseArtifact.pathFromArtifactsRoot}`,
    );
    expect(response.disposition).toBe('answered');
    // The Challenger approved the revision cycle 1 wrote, and the publication reports both cycles.
    const published = commentText(journey.comments()[0]?.body);
    expect(published).toContain('Approved refined idea (revision 1)');
    expect(published).toContain('Conversation cycles used: 2');
    const decision = await journey.artifact<IdeaDecisionRecord>(
      'artifacts/submissions/1/decision.json',
    );
    expect(decision).toMatchObject({
      decision: 'approved',
      refinedIdea: path.join(
        journey.refinement,
        `artifacts/submissions/1/cycles/1/${refinedIdeaArtifact.pathFromArtifactsRoot}`,
      ),
    });
  });

  it('returns an unsuitable idea with human-facing feedback', async () => {
    const journey = await ideaJourney();

    const exitCode = await journey.run(
      approvingAnswers({
        'idea-editor': (_turn, request) => {
          const task = editorTaskOf(request.prompt);
          if (task === 'frame') {
            return framingAnswer;
          }
          return {
            disposition: 'unsuitable',
            response: 'This does not look worth pursuing.',
            reason: 'The project already checks style in its editor, so the gate adds little.',
            help: null,
            refinedIdea: null,
          };
        },
      }),
    );

    expect(exitCode, JSON.stringify(journey.finished())).toBe(0);
    expect(journey.status()).toBe('Waiting for Feedback');
    expect(journey.comments()).toHaveLength(1);
    const published = commentText(journey.comments()[0]?.body);
    expect(published).toContain('Returned for feedback: this idea does not look suitable');
    expect(published).toContain('Captured idea (no refined idea revision yet)');
    expect(published).toContain('Why it was returned:');
    expect(published).toContain('The project already checks style in its editor');
    expect(published).toContain('Conversation cycles used: 1');
    expect(published).toContain('to "Idea" to resubmit it');
    // The editor's internal turn and the contribution reports stay in artifacts.
    expect(published).not.toContain('This does not look worth pursuing.');
    expect(published).not.toContain('Linters are widely used');
    expect(await journey.exists('artifacts/handoff.json')).toBe(false);
    expect(
      await journey.artifact<IdeaDecisionRecord>('artifacts/submissions/1/decision.json'),
    ).toMatchObject({ decision: 'unsuitable', refinedIdea: null });
  });

  it('asks the author for the essential decision before gathering contributions', async () => {
    const journey = await ideaJourney();

    const exitCode = await journey.run(
      approvingAnswers({
        'idea-editor': () => ({
          framing: 'The author wants faster checks without saying how far they should reach.',
          questions: [],
          authorDecision: { question: 'Which repositories must the gate cover at launch?' },
        }),
      }),
    );

    expect(exitCode, JSON.stringify(journey.finished())).toBe(0);
    expect(journey.status()).toBe('Waiting for Feedback');
    // The workflow stopped at the framing: no contributor or Challenger invocation ran.
    expect(journey.prompts).toHaveLength(1);
    expect(new Set(journey.prompts.map((prompt) => roleOf(prompt)))).toEqual(
      new Set(['idea-editor']),
    );
    const published = commentText(journey.comments()[0]?.body);
    expect(published).toContain('Author decision needed');
    expect(published).toContain('Which repositories must the gate cover at launch?');
    expect(published).toContain('Conversation cycles used: 1');
    expect(published).toContain('to "Idea" to resubmit it');
    expect(
      await journey.artifact<{ source: { status: string } }>(
        'artifacts/submissions/1/decision.json',
      ),
    ).toMatchObject({ source: { status: 'Waiting for Feedback' } });
  });

  it('bounds the conversation and returns the idea when the cycles are exhausted', async () => {
    const journey = await ideaJourney();
    const nexus = JSON.parse(
      await readFile(path.join(journey.root, 'installation', 'nexus.config.json'), 'utf8'),
    ) as { ideaRefinement: { maxCycles: number } };
    nexus.ideaRefinement.maxCycles = 2;
    await writeFile(
      path.join(journey.root, 'installation', 'nexus.config.json'),
      JSON.stringify(nexus),
    );

    const exitCode = await journey.run(
      approvingAnswers({
        challenger: () => challengerAnswer('discuss'),
        'idea-editor': (_turn, request) => {
          const task = editorTaskOf(request.prompt);
          if (task === 'frame') {
            return framingAnswer;
          }
          if (task === 'edit') {
            return editorRevision(1);
          }
          return editorRevision(2);
        },
      }),
    );

    expect(exitCode, JSON.stringify(journey.finished())).toBe(0);
    expect(journey.status()).toBe('Waiting for Feedback');
    const plan = await journey.plan();
    expect(plan).toMatchObject({ submission: 1, cycle: 2, route: 'next' });
    expect(await journey.exists('artifacts/submissions/1/cycles/2/refined-idea.json')).toBe(true);
    const published = commentText(journey.comments()[0]?.body);
    expect(published).toContain('Attempts exhausted after 2 cycles');
    expect(published).toContain('Latest refined idea (revision 2)');
    expect(published).toContain('Conversation cycles used: 2');
    expect(published).toContain('What refinement changed: Refined idea revision 2.');
    // The author sees a plain statement of the remaining obstacle; the internal concern and its
    // editor-directed resolution stay in the Challenger artifact.
    expect(published).toContain(
      'Nothing yet shows a lint gate is worth the change to the project.',
    );
    expect(published).not.toContain('No evidence links lint gates to shorter reviews.');
    expect(published).not.toContain('Resolution: Cite a comparable project or study.');
    expect(published).not.toContain('The value claim still lacks evidence.');
    expect(
      await journey.artifact<IdeaDecisionRecord>('artifacts/submissions/1/decision.json'),
    ).toMatchObject({ decision: 'attempts-exhausted', revision: 2 });
  });

  it('reuses the issue workspace and opens a new submission after the author resubmits', async () => {
    const journey = await ideaJourney();
    expect(await journey.run(approvingAnswers())).toBe(0);
    expect(journey.status()).toBe('Draft');

    // The author replies with a revised idea and moves the item back to the submitted status.
    journey.resubmit('Please also cover generated files.');
    journey.prompts.length = 0;
    expect(await journey.run(approvingAnswers())).toBe(0);

    expect(journey.status()).toBe('Draft');
    const plan = await journey.plan();
    expect(plan).toMatchObject({ submission: 2, cycle: 1, route: 'new' });
    expect(await journey.exists('artifacts/submissions/1/cycles/1/refined-idea.json')).toBe(true);
    expect(await journey.exists('artifacts/submissions/2/cycles/1/refined-idea.json')).toBe(true);
    expect(
      await journey.exists(`artifacts/submissions/1/${framingArtifact.pathFromArtifactsRoot}`),
    ).toBe(false);
    // The resubmission is captured once and the new comment is the current proposal.
    expect(
      journey.prompts.every((prompt) => prompt.includes('Please also cover generated files.')),
    ).toBe(true);
    const handoff = await journey.artifact<IdeaHandoff>('artifacts/handoff.json');
    expect(handoff.capturedInput).toBe(
      path.join(journey.refinement, 'artifacts/submissions/2/input.json'),
    );
    expect(handoff.framing).toBe(
      path.join(journey.refinement, 'artifacts/submissions/2/cycles/1/editor-framing.json'),
    );
  });

  /**
   * A representative idea-stage scenario, end to end: the author resubmits an architectural
   * proposal the previous submission narrowed, with a human clarification that states the real
   * intent. The roles below return realistic decided outputs; this journey establishes what the
   * workflow does with such outputs — one selection path over the retained workspace, the
   * clarification as the current proposal, the earlier publication as history, and approval
   * publishing the proposal with an optional suggestion that did not block it. Whether a real
   * agent produces those outputs is a role-quality question, established separately by inspecting
   * actual exchanges (tests/fixtures/idea-refinement), not by a controlled journey.
   */
  it('keeps a clarified architectural proposal open and publishes it as proposed', async () => {
    const earlierInterpretation =
      'The model stays fixed per profile; the idea only asks for better defaults.';
    const clarification =
      'The earlier assessment misread the intent: the point is that the model choice can change.';
    const journey = await ideaJourney({
      summary: 'Let the configured model change per profile',
      description:
        'An operator should be able to change which model each agent profile runs without editing Nexus code.',
      conversation: [clarification],
      // The completed submission the six-role implementation refined before this one.
      retained: (refinement) => ({
        'state/current-round.json': {
          submission: 1,
          cycle: 2,
          route: 'minor',
          profiles: {
            'brief-writer': 'nexus-flash',
            'purpose-council': 'nexus-flash',
            'evidence-council': 'nexus-flash',
            'simplicity-council': 'nexus-flash',
          },
        },
        'artifacts/submissions/1/input.json': {
          taskKey: 'NEX-1',
          source: { kind: 'jira', issueId: '10518' },
          issue: { id: '10518', key: 'NEX-1' },
          conversation: [],
        },
        'artifacts/submissions/1/cycles/1/brief.json': {
          problem: 'Profiles fix one model.',
          value: 'Better defaults could save configuration time.',
          projectFit: 'Profiles already name a model.',
          scope: 'Change the default model constants.',
          changeSummary: earlierInterpretation,
          revision: 1,
          submission: 1,
          cycle: 1,
        },
        'artifacts/submissions/1/decision.json': {
          decision: 'approved',
          strongestVerdict: 'approve',
          brief: path.join(refinement, 'artifacts/submissions/1/cycles/1/brief.json'),
          revision: 1,
          feedback: [],
          comment: `Approved idea brief (revision 1)\n\n${earlierInterpretation}`,
          source: { transition: { id: '3', to: 'Draft' }, status: 'Draft', commentId: '11583' },
        },
      }),
    });

    const exitCode = await journey.run(
      approvingAnswers({
        researcher: () => ({
          contribution:
            'Other harnesses keep deployment details as data, so changing a model needs no code change.',
          findings: ['LiteLLM routes many providers from configuration.'],
          options: [
            'Read the model from the profile configuration, as LiteLLM reads its routing table.',
          ],
          sources: [
            {
              title: 'LiteLLM routing',
              link: 'https://example.com/litellm',
              accessed: '2026-09-27',
            },
          ],
        }),
        'project-guide': () => ({
          contribution:
            'Profiles currently name the model; that is a current choice, not the project purpose, and the shared vocabulary already treats a profile as configuration.',
          fit: 'The configuration design already owns profile settings.',
          steering: ['Keep the profile identity stable while its model changes.'],
          constraints: ['A changed model must not silently change an execution in flight.'],
          evidence: ['docs/configuration.md'],
          provisional: false,
          uncertainty: [],
        }),
        challenger: () => ({
          verdict: 'approve',
          assessment:
            'Changing a fixed choice is plausible here and the configuration boundary already exists.',
          obstacle: null,
          concerns: [],
          suggestions: ['Name the configuration key in Requirements and Design.'],
        }),
        'idea-editor': (_turn, request) => {
          if (editorTaskOf(request.prompt) === 'frame') {
            return {
              framing:
                'The author wants the model for each profile to be changeable configuration rather than a fixed constant.',
              questions: ['Does an in-flight execution keep its starting model?'],
              authorDecision: null,
            };
          }
          return {
            disposition: 'revised',
            response:
              'I kept the proposal as the author clarified it and used the contributions for fit.',
            reason: null,
            help: null,
            refinedIdea: {
              idea: 'Let an operator change the model each agent profile runs, so trying another model needs configuration rather than a code change.',
              projectFit: 'The configuration design already owns profile settings.',
              feasibility:
                'A plausible way forward is to resolve the model from the profile setting, keeping the profile identity and the in-flight execution stable.',
              openQuestions: ['Does an in-flight execution keep its starting model?'],
              changeSummary:
                'Framed the change as configuration, not a new default, and kept the in-flight question open.',
            },
          };
        },
      }),
    );

    expect(exitCode, JSON.stringify(journey.finished())).toBe(0);
    expect(journey.status()).toBe('Draft');
    // The new submission opens over the retained one; the earlier artifacts stay readable history.
    expect(await journey.plan()).toEqual({
      submission: 2,
      cycle: 1,
      route: 'new',
      profiles: {
        'idea-editor': 'nexus-astra',
        researcher: 'nexus-astra',
        'project-guide': 'nexus-astra',
        challenger: 'nexus-review',
      },
    });
    expect(await journey.exists('artifacts/submissions/1/cycles/1/brief.json')).toBe(true);

    // The author's clarification is the current proposal; the previous publication is history.
    for (const prompt of journey.prompts) {
      expect(prompt).toContain(clarification);
      expect(prompt).toContain('history, not the current proposal');
      expect(prompt).toContain(
        path.join(journey.refinement, 'artifacts/submissions/1/cycles/1/brief.json'),
      );
      expect(prompt).toContain(
        path.join(journey.refinement, 'artifacts/submissions/1/decision.json'),
      );
    }
    // The clarification governs: the editor's prompt carries it as the captured input, not the
    // previous submission's reading of the idea.
    const editorPrompt = journey.prompts.find(
      (prompt) => roleOf(prompt) === 'idea-editor' && editorTaskOf(prompt) === 'edit',
    );
    expect(editorPrompt).toContain('Current captured idea: NEX-1');
    expect(editorPrompt).toContain(clarification);
    // Nothing narrowed the architectural proposal: the shared stage guidance and the current
    // design choice both reach the editor, which is free to propose changing it.
    expect(editorPrompt).toContain('may propose changing those choices');
    expect(editorPrompt).toContain('Profiles currently name the model');

    // Approval publishes the proposal as the author clarified it, with the optional suggestion
    // left out of the decision: it did not block approval and demands nothing.
    // The captured author comment and the one publication the approval adds.
    expect(journey.comments()).toHaveLength(2);
    const published = commentText(journey.comments().at(-1)?.body);
    expect(published).toContain('Approved refined idea (revision 1)');
    expect(published).toContain('Idea: Let an operator change the model each agent profile runs');
    expect(published).toContain('Conversation cycles used: 1');
    expect(published).toContain(
      'What refinement changed: Framed the change as configuration, not a new default',
    );
    expect(published).not.toContain(earlierInterpretation);
    expect(published).not.toContain('Name the configuration key');
  });

  /**
   * A representative exploratory scenario: the author does not know yet whether the change is worth
   * it. The roles return realistic decided outputs; the journey establishes that approval does not
   * require resolved uncertainty or a benchmark plan, and that the published idea keeps its
   * uncertainty for the next workflow.
   */
  it('approves a plausible exploratory idea that carries uncertainty', async () => {
    const journey = await ideaJourney({
      summary: 'Explore caching Jira transitions',
      description:
        'Try caching transitions during a run to see whether the repeated reads matter; we do not know yet whether the complexity pays off.',
    });

    const exitCode = await journey.run(
      approvingAnswers({
        'idea-editor': (_turn, request) => {
          if (editorTaskOf(request.prompt) === 'frame') {
            return {
              framing:
                'The author wants to know whether caching transitions is worthwhile, without committing to it.',
              questions: ['How many transition reads does one run make?'],
              authorDecision: null,
            };
          }
          return {
            disposition: 'revised',
            response: 'I kept the exploration open and recorded the uncertainty.',
            reason: null,
            help: null,
            refinedIdea: {
              idea: 'Cache the Jira transitions one run reads, so repeated reads cost nothing, if the reads turn out to matter.',
              projectFit: 'The Jira adapter already reads transitions per candidate selection.',
              feasibility:
                'A time-boxed trial inside the adapter would show whether the reads matter, without committing to the cache.',
              openQuestions: ['How many transition reads does one run make?'],
              changeSummary: 'Framed the change as a trial and kept the read volume open.',
            },
          };
        },
        challenger: () => ({
          verdict: 'approve',
          assessment:
            'The trial is cheap and plausible, and the uncertainty is acknowledged rather than hidden.',
          obstacle: null,
          concerns: [],
          suggestions: ['Count the reads during the trial.'],
        }),
      }),
    );

    expect(exitCode, JSON.stringify(journey.finished())).toBe(0);
    expect(journey.status()).toBe('Draft');
    const published = commentText(journey.comments()[0]?.body);
    expect(published).toContain('Approved refined idea (revision 1)');
    expect(published).toContain('Idea: Cache the Jira transitions one run reads');
    expect(published).toContain('Feasibility: A time-boxed trial inside the adapter');
    expect(published).toContain('Open questions:');
    expect(published).toContain('- How many transition reads does one run make?');
    // No benchmark, proof or measurement was required to approve it.
    expect(published.toLowerCase()).not.toContain('benchmark');
    expect(published.toLowerCase()).not.toContain('before approval');
  });
});
