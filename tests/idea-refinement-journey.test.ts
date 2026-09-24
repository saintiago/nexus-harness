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
import { createTaskEngine, type EngineEvent } from '../src/task-engine/index.js';
import type { IdeaRole } from '../src/agent-runtime/index.js';
import type { Brief } from '../src/task-engine/actions/brief-writer/artifacts.js';
import type {
  IdeaDecisionRecord,
  IdeaHandoff,
} from '../src/task-engine/actions/publish-decision/artifacts.js';
import type { PurposeReport } from '../src/task-engine/actions/purpose-verifier/artifacts.js';
import type { ResearchReport } from '../src/task-engine/actions/researcher/artifacts.js';
import type { CouncilReport } from '../src/task-engine/actions/review-council/artifacts.js';
import type { IdeaRoundPlan } from '../src/task-engine/actions/start-idea-round/artifacts.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';
import { scriptedJira } from './support/jira.js';

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

/** The role whose constant instructions the prompt carries. */
function roleOf(prompt: string): IdeaRole | null {
  if (prompt.includes('Be wise and philosophical')) return 'purpose-verifier';
  if (prompt.includes('Be idealistic, trusting')) return 'researcher';
  if (prompt.includes('Write the smallest coherent idea brief')) return 'brief-writer';
  if (prompt.includes('Be unforgiving about material gaps')) return 'purpose-council';
  if (prompt.includes('Be unforgiving about unsupported claims')) return 'evidence-council';
  if (prompt.includes('Be unforgiving about avoidable complexity')) return 'simplicity-council';
  return null;
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

/** Assemble one journey: a local remote, temporary configuration and a controlled Jira source. */
async function ideaJourney(): Promise<IdeaJourney> {
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
  const comments: JiraComment[] = [];
  let nextCommentId = 1;
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
      summary: 'Add a lint gate',
      description: { type: 'doc', version: 1, content: [] },
      status: { id: statusIds[status], name: status },
    },
  });
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
  const prompts: string[] = [];
  const diagnostics: string[] = [];
  const unusedGitHub = new Proxy({} as GitHubAdapter, {
    get: () => () => fault('GitHub is not used by idea refinement.'),
  });

  /** The in-process worker launch: the real worker wiring over the journey's capabilities. */
  const launchWorker: WorkerLaunch = async (request, onEvent) => {
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
        wait: () => Promise.resolve(),
      }),
    });
    const unsubscribe = engine.subscribe((event: EngineEvent) => {
      onEvent(event);
    });
    let result;
    try {
      result = await engine.run();
    } finally {
      unsubscribe();
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
          return application;
        },
      });
    },
  };
}

/** The purpose assessment every journey's purpose verifier returns. */
const purposeReport: PurposeReport = {
  summary: 'The idea serves the project purpose of serving operators.',
  conflicts: [],
  steering: [],
  sources: ['docs/purpose.md'],
  provisional: false,
  uncertainty: [],
};

/** The enrichment report every journey's researcher returns. */
const researchReport: ResearchReport = {
  summary: 'Linters are widely used to keep reviews focused.',
  findings: ['Teams use linters to catch style defects early.'],
  suggestions: [],
  options: ['Adopt the smallest lint configuration that covers the current repository.'],
  sources: [{ title: 'Lint overview', link: 'https://example.com/lint', accessed: '2026-09-24' }],
};

/** The brief revision a journey's writer returns for the supplied cycle. */
function briefParts(cycle: number): Omit<Brief, 'revision' | 'submission' | 'cycle'> {
  return {
    problem: 'Reviewers spend time on style defects.',
    value: 'Reviews focus on behaviour.',
    projectFit: 'The project already enforces checks in CI.',
    evidence: ['docs/purpose.md'],
    alternatives: ['Keep reviewing style by eye.'],
    scope: `Enable the smallest lint gate (revision ${String(cycle)}).`,
    assumptions: [],
    changeSummary: `Brief revision ${String(cycle)}.`,
  };
}

/** One council result with the supplied verdict and a reviewer-specific finding. */
function councilAnswer(reviewer: CouncilReport['reviewer'], verdict: CouncilReport['verdict']) {
  return {
    verdict,
    summary: `${reviewer} review of the revision.`,
    findings:
      verdict === 'approve'
        ? []
        : [
            {
              criterion: `${reviewer} criterion`,
              evidence: `${reviewer} evidence`,
              correction: `${reviewer} correction`,
            },
          ],
  };
}

/** A scripted answer set: all six roles approve unless a journey overrides one. */
function approvingAnswers(overrides: Partial<Record<IdeaRole, RoleAnswer>> = {}): RoleAnswer {
  const answers: Record<IdeaRole, RoleAnswer> = {
    'purpose-verifier': () => purposeReport,
    researcher: () => researchReport,
    'brief-writer': (_turn, request) => {
      const cycle = Number(/revision (\d+)/u.exec(request.prompt)?.[1] ?? '1');
      return briefParts(cycle);
    },
    'purpose-council': () => councilAnswer('purpose', 'approve'),
    'evidence-council': () => councilAnswer('evidence', 'approve'),
    'simplicity-council': () => councilAnswer('simplicity', 'approve'),
  };
  return (turn, request) => {
    const role = roleOf(request.prompt);
    if (role === null) {
      throw new Error('No idea refinement role matches the invoked prompt.');
    }
    const override = overrides[role];
    if (override !== undefined) {
      return override(turn, request);
    }
    return answers[role](turn, request);
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
        'purpose-verifier': 'nexus-astra',
        researcher: 'nexus-astra',
        'brief-writer': 'nexus-astra',
        'purpose-council': 'nexus-review',
        'evidence-council': 'nexus-review',
        'simplicity-council': 'nexus-review',
      },
    });
    const brief = await journey.artifact<Brief>('artifacts/submissions/1/cycles/1/brief.json');
    expect(brief.revision).toBe(1);
    expect(await journey.exists('artifacts/submissions/1/input.json')).toBe(true);
    expect(await journey.exists('artifacts/submissions/1/cycles/1/purpose.json')).toBe(true);
    expect(await journey.exists('artifacts/submissions/1/cycles/1/research.json')).toBe(true);

    // The approved handoff references the retained artifacts a later workflow reads.
    const handoff = await journey.artifact<IdeaHandoff>('artifacts/handoff.json');
    expect(handoff.issueWorkspace).toBe(journey.issueWorkspace);
    expect(handoff.brief).toBe(
      path.join(journey.refinement, 'artifacts/submissions/1/cycles/1/brief.json'),
    );
    expect(await journey.exists('artifacts/submissions/1/decision.json')).toBe(true);
    expect(
      await journey.artifact<IdeaDecisionRecord>('artifacts/submissions/1/decision.json'),
    ).toMatchObject({
      decision: 'approved',
      strongestVerdict: 'approve',
      source: { transition: { to: 'Draft' }, status: 'Draft' },
    });

    // The approved brief is published for the next workflow; internal feedback stays in artifacts.
    expect(journey.comments()).toHaveLength(1);
    const published = commentText(journey.comments()[0]?.body);
    expect(published).toContain('Approved idea brief (revision 1)');
    expect(published).toContain('Enable the smallest lint gate');
    expect(published).not.toContain('purpose review of the revision');

    // Every role ran in the prepared refinement worktree with the captured idea and AGENTS.md.
    expect(journey.prompts).toHaveLength(6);
    expect(new Set(journey.prompts.map((prompt) => roleOf(prompt))).size).toBe(6);
    for (const prompt of journey.prompts) {
      expect(prompt).toContain('Add a lint gate');
      expect(prompt).toContain('Prefer the smallest change that fulfils the purpose.');
      expect(prompt).toContain(path.join(journey.worktree));
    }
    expect((await readFile(path.join(journey.worktree, 'readme.md'), 'utf8')).trim()).toBe(
      'the connected project',
    );
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
    expect(await journey.exists('artifacts/submissions/1/cycles/1/brief.json')).toBe(true);
    expect(await journey.exists('artifacts/submissions/2/cycles/1/brief.json')).toBe(true);
    // The resubmission is captured once and the new comment is the current proposal.
    expect(
      journey.prompts.every((prompt) => prompt.includes('Please also cover generated files.')),
    ).toBe(true);
    const handoff = await journey.artifact<IdeaHandoff>('artifacts/handoff.json');
    expect(handoff.capturedInput).toBe(
      path.join(journey.refinement, 'artifacts/submissions/2/input.json'),
    );
  });

  it('returns an unworkable idea to its author with human-facing feedback', async () => {
    const journey = await ideaJourney();

    const exitCode = await journey.run(
      approvingAnswers({
        'simplicity-council': () => councilAnswer('simplicity', 'idea_not_working'),
      }),
    );

    expect(exitCode, JSON.stringify(journey.finished())).toBe(0);
    expect(journey.status()).toBe('Waiting for Feedback');
    expect(journey.comments()).toHaveLength(1);
    const published = commentText(journey.comments()[0]?.body);
    expect(published).toContain('cannot move forward as submitted');
    expect(published).toContain('simplicity correction');
    expect(published).toContain('to "Idea" to resubmit it');
    // The internal reviewers' feedback stays in artifacts, not on the issue.
    expect(published).not.toContain('purpose criterion');
    expect(await journey.exists('artifacts/handoff.json')).toBe(false);
    expect(
      await journey.artifact<IdeaDecisionRecord>('artifacts/submissions/1/decision.json'),
    ).toMatchObject({ decision: 'returned-to-author', strongestVerdict: 'idea_not_working' });
  });

  it('bounds internal revision and returns the idea when the cycles are exhausted', async () => {
    const journey = await ideaJourney();
    const nexus = JSON.parse(
      await readFile(path.join(journey.root, 'installation', 'nexus.config.json'), 'utf8'),
    ) as { ideaRefinement: { maxCouncilCycles: number } };
    nexus.ideaRefinement.maxCouncilCycles = 2;
    await writeFile(
      path.join(journey.root, 'installation', 'nexus.config.json'),
      JSON.stringify(nexus),
    );

    const exitCode = await journey.run(
      approvingAnswers({
        'evidence-council': () => councilAnswer('evidence', 'minor_corrections'),
      }),
    );

    expect(exitCode, JSON.stringify(journey.finished())).toBe(0);
    expect(journey.status()).toBe('Waiting for Feedback');
    const plan = await journey.plan();
    expect(plan).toMatchObject({ submission: 1, cycle: 2, route: 'minor' });
    // Minor corrections repeat the writer and council, reusing the purpose and research reports.
    expect(journey.prompts.filter((prompt) => roleOf(prompt) === 'purpose-verifier')).toHaveLength(
      1,
    );
    expect(journey.prompts.filter((prompt) => roleOf(prompt) === 'brief-writer')).toHaveLength(2);
    const secondWriter = journey.prompts.filter((prompt) => roleOf(prompt) === 'brief-writer')[1];
    expect(secondWriter).toContain('Address each objection of the preceding council cycle');
    expect(await journey.exists('artifacts/submissions/1/cycles/1/brief.json')).toBe(true);
    expect(await journey.exists('artifacts/submissions/1/cycles/2/brief.json')).toBe(true);
    expect(
      await journey.artifact<IdeaDecisionRecord>('artifacts/submissions/1/decision.json'),
    ).toMatchObject({ decision: 'unable-to-converge', strongestVerdict: 'minor_corrections' });
  });
});
