/**
 * Focused integration tests: the real PrepareWorkspace drives real temporary repositories through
 * the real Git and Processes adapters, establishing new-attempt branching, retained-work
 * continuation, preparation output and failure reporting. Controlled Jira input covers the
 * producer-to-consumer path from SelectWork. No live service or existing workspace is involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../src/adapters/git.js';
import { run, type ProcessOutput } from '../src/adapters/processes.js';
import type { Command } from '../src/configuration/index.js';
import { ok } from '../src/result.js';
import type { PreparedWorkspace } from '../src/task-engine/actions/prepare-workspace/artifacts.js';
import {
  createPrepareWorkspace,
  type PrepareWorkspaceSettings,
} from '../src/task-engine/actions/prepare-workspace/index.js';
import { createSelectWork } from '../src/task-engine/actions/select-work/index.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { scriptedJira } from './support/jira.js';

/**
 * Git and preparation commands run with a supplied environment. Global and system Git
 * configuration are disabled so the operator's settings cannot change test behavior, and commit
 * identity comes from the environment.
 */
const environment = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Nexus Tests',
  GIT_AUTHOR_EMAIL: 'nexus@example.com',
  GIT_COMMITTER_NAME: 'Nexus Tests',
  GIT_COMMITTER_EMAIL: 'nexus@example.com',
};

const git = createGitAdapter((args, directory, onOutput) =>
  run({ executable: 'git', args, directory, environment }, onOutput),
);

let root = '';
let events: EngineEvent[] = [];
let repositoryCount = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-prepare-'));
  events = [];
  repositoryCount = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Decode one stream's chunks as text. */
function text(outputs: readonly ProcessOutput[], stream: ProcessOutput['stream']): string {
  const chunks = outputs.filter((output) => output.stream === stream).map((output) => output.chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Run one git command as test setup and return its stdout. */
async function gitCommand(args: readonly string[], directory: string): Promise<string> {
  const outputs: ProcessOutput[] = [];
  const result = await run({ executable: 'git', args, directory, environment }, (output) => {
    outputs.push(output);
  });
  if (!result.ok || result.value.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${text(outputs, 'stderr')}`);
  }
  return text(outputs, 'stdout');
}

/** The commit a repository's HEAD points to. */
async function headOf(repository: string): Promise<string> {
  return (await gitCommand(['rev-parse', 'HEAD'], repository)).trim();
}

/** A bare origin with one commit on main, plus a working copy that publishes to it. */
async function repositoryWithOrigin(): Promise<{
  origin: string;
  source: string;
  revision: string;
}> {
  repositoryCount += 1;
  const directory = path.join(root, `repository-${repositoryCount}`);
  const origin = path.join(directory, 'origin.git');
  const source = path.join(directory, 'source');
  await mkdir(directory, { recursive: true });
  await gitCommand(['init', '--quiet', '--bare', '--initial-branch=main', origin], directory);
  await gitCommand(['init', '--quiet', '--initial-branch=main', source], directory);
  await writeFile(path.join(source, 'readme.md'), 'initial\n');
  await gitCommand(['add', 'readme.md'], source);
  await gitCommand(['commit', '--quiet', '--message', 'initial'], source);
  await gitCommand(['remote', 'add', 'origin', origin], source);
  await gitCommand(['push', '--quiet', 'origin', 'main'], source);
  return { origin, source, revision: await headOf(source) };
}

/** Commit a new file in the source repository and publish it to origin's main. */
async function publish(
  source: string,
  name: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(path.join(source, name), content);
  await gitCommand(['add', name], source);
  await gitCommand(['commit', '--quiet', '--message', message], source);
  await gitCommand(['push', '--quiet', 'origin', 'main'], source);
  return headOf(source);
}

/** Write the selection SelectWork normally saves for one task. */
async function writeSelection(taskKey: string, workspaceRoot: string): Promise<string> {
  const file = path.join(root, 'executions', 'selection.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(
      {
        taskKey,
        source: { kind: 'jira', issueId: taskKey },
        task: { id: taskKey, key: taskKey, fields: {} },
        conversation: [],
        workspace: { root: workspaceRoot },
        stage: 'delivery',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return file;
}

/** PrepareWorkspace over the real Git adapter and the real Processes adapter. */
function prepareOver(options: {
  readonly selectionFile: string;
  readonly source: string;
  readonly preparation?: readonly Command[];
  readonly project?: string;
  readonly workspaceRoot?: string;
}) {
  const settings: PrepareWorkspaceSettings = {
    selectionFile: options.selectionFile,
    repository: { source: options.source, mainBranch: 'main' },
    preparation: options.preparation ?? [],
    environment,
    project: options.project ?? 'NEX',
    workspaceRoot: options.workspaceRoot ?? path.join(root, 'workspaces'),
    git,
    runCommand: run,
    publish: (event) => events.push(event),
  };
  return createPrepareWorkspace(settings);
}

/** Read the prepared-workspace record of one workspace. */
async function readPrepared(workspaceRoot: string): Promise<PreparedWorkspace> {
  return JSON.parse(
    await readFile(path.join(workspaceRoot, 'state', 'prepared-workspace.json'), 'utf8'),
  ) as PreparedWorkspace;
}

/** The worktree path of one workspace. */
function worktreeOf(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'worktree');
}

/** The attempt identity one workspace recorded for its current attempt. */
async function readAttempt(workspaceRoot: string): Promise<string> {
  const record = JSON.parse(
    await readFile(path.join(workspaceRoot, 'state', 'attempt.json'), 'utf8'),
  ) as { readonly attemptId: string };
  return record.attemptId;
}

/** The prepared outcome event referencing one workspace's saved record. */
function preparedOutcome(taskKey: string, workspaceRoot: string): EngineEvent {
  return {
    source: 'prepare-workspace',
    type: 'outcome',
    data: {
      task: taskKey,
      round: null,
      outcome: 'prepared',
      detail: `branch task/${taskKey}`,
      artifact: { path: path.join(workspaceRoot, 'state', 'prepared-workspace.json') },
    },
  };
}

describe('PrepareWorkspace', () => {
  it('obtains the repository, branches from main and records the prepared identity', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    const selectionFile = await writeSelection('NEX-1', workspace);
    const prepare = prepareOver({
      selectionFile,
      source: origin,
      preparation: [
        { executable: 'bash', args: ['-c', 'pwd > preparation-cwd.txt && echo prepared'] },
      ],
    });

    await expect(prepare()).resolves.toBe('prepared');
    expect(JSON.parse(await readFile(selectionFile, 'utf8')).initialClaim).toBe(false);

    expect(await readPrepared(workspace)).toEqual({
      taskKey: 'NEX-1',
      repository: origin,
      repositoryWorkspace: { root: workspace },
      branch: 'task/NEX-1',
      baseRevision: revision,
    });
    const worktree = worktreeOf(workspace);
    expect((await gitCommand(['symbolic-ref', '--short', 'HEAD'], worktree)).trim()).toBe(
      'task/NEX-1',
    );
    expect(await headOf(worktree)).toBe(revision);
    expect(await readFile(path.join(worktree, 'preparation-cwd.txt'), 'utf8')).toBe(
      `${worktree}\n`,
    );
    expect(
      await readFile(path.join(workspace, 'state', 'preparation', '0', 'stdout.log'), 'utf8'),
    ).toBe('prepared\n');
    expect(
      await readFile(path.join(workspace, 'state', 'preparation', '0', 'stderr.log'), 'utf8'),
    ).toBe('');
    // Preparation leaves the fixed workspace layout ready, including the artifact root.
    expect((await stat(path.join(workspace, 'artifacts'))).isDirectory()).toBe(true);
    // The recorded identity is what the outcome event references.
    expect(events).toEqual([preparedOutcome('NEX-1', workspace)]);
  });

  it('fast-forwards main before starting the task branch in an existing worktree', async () => {
    const { origin, source } = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    expect(await git.cloneRepository(origin, worktreeOf(workspace))).toMatchObject({ ok: true });
    const published = await publish(source, 'second.txt', 'second\n', 'second');
    const selectionFile = await writeSelection('NEX-2', workspace);

    await expect(prepareOver({ selectionFile, source: origin })()).resolves.toBe('prepared');

    const worktree = worktreeOf(workspace);
    expect(await headOf(worktree)).toBe(published);
    expect(await readFile(path.join(worktree, 'second.txt'), 'utf8')).toBe('second\n');
    expect((await readPrepared(workspace)).baseRevision).toBe(published);
  });

  it('continues a worktree whose task branch was created before its record', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    expect(await git.cloneRepository(origin, worktreeOf(workspace))).toMatchObject({ ok: true });
    expect(await git.createBranch(worktreeOf(workspace), 'task/NEX-3', revision)).toMatchObject({
      ok: true,
    });
    const selectionFile = await writeSelection('NEX-3', workspace);

    await expect(prepareOver({ selectionFile, source: origin })()).resolves.toBe('prepared');

    expect(await readPrepared(workspace)).toEqual({
      taskKey: 'NEX-3',
      repository: origin,
      repositoryWorkspace: { root: workspace },
      branch: 'task/NEX-3',
      baseRevision: revision,
    });
    expect(
      (await gitCommand(['symbolic-ref', '--short', 'HEAD'], worktreeOf(workspace))).trim(),
    ).toBe('task/NEX-3');
  });

  it('checks out the configured main branch when a clone lands on another default', async () => {
    const directory = path.join(root, 'other-default');
    const origin = path.join(directory, 'origin.git');
    const source = path.join(directory, 'source');
    await mkdir(directory, { recursive: true });
    await gitCommand(['init', '--quiet', '--bare', '--initial-branch=develop', origin], directory);
    await gitCommand(['init', '--quiet', '--initial-branch=develop', source], directory);
    await writeFile(path.join(source, 'readme.md'), 'develop\n');
    await gitCommand(['add', 'readme.md'], source);
    await gitCommand(['commit', '--quiet', '--message', 'develop'], source);
    await gitCommand(['remote', 'add', 'origin', origin], source);
    await gitCommand(['push', '--quiet', 'origin', 'develop'], source);
    await gitCommand(['checkout', '--quiet', '--orphan', 'main'], source);
    await gitCommand(['rm', '--quiet', '-rf', '.'], source);
    await writeFile(path.join(source, 'main.txt'), 'main\n');
    await gitCommand(['add', 'main.txt'], source);
    await gitCommand(['commit', '--quiet', '--message', 'main'], source);
    await gitCommand(['push', '--quiet', 'origin', 'main'], source);
    const mainRevision = await headOf(source);
    const workspace = path.join(root, 'workspace');
    const selectionFile = await writeSelection('NEX-10', workspace);

    await expect(prepareOver({ selectionFile, source: origin })()).resolves.toBe('prepared');

    const worktree = worktreeOf(workspace);
    expect(await readPrepared(workspace)).toEqual({
      taskKey: 'NEX-10',
      repository: origin,
      repositoryWorkspace: { root: workspace },
      branch: 'task/NEX-10',
      baseRevision: mainRevision,
    });
    expect(await headOf(worktree)).toBe(mainRevision);
    expect(await readFile(path.join(worktree, 'main.txt'), 'utf8')).toBe('main\n');
  });

  it('reports an existing worktree that is on an unrelated branch', async () => {
    const { origin } = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    expect(await git.cloneRepository(origin, worktreeOf(workspace))).toMatchObject({ ok: true });
    await gitCommand(['checkout', '--quiet', '-b', 'feature'], worktreeOf(workspace));
    const selectionFile = await writeSelection('NEX-11', workspace);

    await expect(prepareOver({ selectionFile, source: origin })()).resolves.toBe('failed');

    expect(events).toEqual([
      {
        source: 'prepare-workspace',
        type: 'failed',
        data: { reason: expect.stringContaining('"feature"') },
      },
    ]);
    // The unrelated branch and its work are preserved rather than adopted or reset.
    expect(
      (await gitCommand(['symbolic-ref', '--short', 'HEAD'], worktreeOf(workspace))).trim(),
    ).toBe('feature');
  });

  it("starts from a new branch name instead of a discarded attempt's remote branch", async () => {
    const { origin, source, revision } = await repositoryWithOrigin();
    await gitCommand(['branch', 'task/NEX-4'], source);
    await gitCommand(['push', '--quiet', 'origin', 'task/NEX-4'], source);
    const workspace = path.join(root, 'workspace');
    const selectionFile = await writeSelection('NEX-4', workspace);

    await expect(prepareOver({ selectionFile, source: origin })()).resolves.toBe('prepared');

    expect((await readPrepared(workspace)).branch).toBe('task/NEX-4-2');
    expect(await git.readRemoteBranchHead(origin, 'task/NEX-4')).toEqual({
      ok: true,
      value: revision,
    });
  });

  it('retains local commits and uncommitted changes on repetition', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    const selectionFile = await writeSelection('NEX-5', workspace);
    const preparation: Command[] = [
      { executable: 'bash', args: ['-c', 'echo run >> preparation-runs.txt'] },
    ];

    await expect(prepareOver({ selectionFile, source: origin, preparation })()).resolves.toBe(
      'prepared',
    );
    const worktree = worktreeOf(workspace);
    await writeFile(path.join(worktree, 'local.txt'), 'local commit\n');
    await gitCommand(['add', 'local.txt'], worktree);
    await gitCommand(['commit', '--quiet', '--message', 'local work'], worktree);
    const localHead = await headOf(worktree);
    await writeFile(path.join(worktree, 'readme.md'), 'uncommitted change\n');
    await writeFile(path.join(worktree, 'notes.txt'), 'untracked\n');

    await expect(prepareOver({ selectionFile, source: origin, preparation })()).resolves.toBe(
      'prepared',
    );

    expect(await readPrepared(workspace)).toEqual({
      taskKey: 'NEX-5',
      repository: origin,
      repositoryWorkspace: { root: workspace },
      branch: 'task/NEX-5',
      baseRevision: revision,
    });
    expect(await headOf(worktree)).toBe(localHead);
    expect(await readFile(path.join(worktree, 'readme.md'), 'utf8')).toBe('uncommitted change\n');
    expect(await readFile(path.join(worktree, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(await readFile(path.join(worktree, 'preparation-runs.txt'), 'utf8')).toBe('run\nrun\n');
    // The repeated invocation reuses the saved record and publishes the same reference.
    expect(events).toEqual([
      preparedOutcome('NEX-5', workspace),
      preparedOutcome('NEX-5', workspace),
    ]);
  });

  it('reports a retained worktree that belongs to another repository', async () => {
    const first = await repositoryWithOrigin();
    const second = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    await mkdir(path.join(workspace, 'state'), { recursive: true });
    expect(await git.cloneRepository(second.origin, worktreeOf(workspace))).toMatchObject({
      ok: true,
    });
    await writeFile(
      path.join(workspace, 'state', 'prepared-workspace.json'),
      `${JSON.stringify(
        {
          taskKey: 'NEX-1',
          repository: first.origin,
          branch: 'task/NEX-1',
          baseRevision: first.revision,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const selectionFile = await writeSelection('NEX-1', workspace);

    await expect(prepareOver({ selectionFile, source: first.origin })()).resolves.toBe('failed');

    expect(events).toEqual([
      {
        source: 'prepare-workspace',
        type: 'failed',
        data: { reason: expect.stringContaining(second.origin) },
      },
    ]);
    expect((await readPrepared(workspace)).repository).toBe(first.origin);
  });

  it('reports a retained workspace when the configured repository source changed', async () => {
    const first = await repositoryWithOrigin();
    const second = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    const selectionFile = await writeSelection('NEX-12', workspace);
    await expect(prepareOver({ selectionFile, source: first.origin })()).resolves.toBe('prepared');
    const worktree = worktreeOf(workspace);
    await writeFile(path.join(worktree, 'local.txt'), 'local commit\n');
    await gitCommand(['add', 'local.txt'], worktree);
    await gitCommand(['commit', '--quiet', '--message', 'local work'], worktree);
    const localHead = await headOf(worktree);
    await writeFile(path.join(worktree, 'notes.txt'), 'untracked\n');

    await expect(prepareOver({ selectionFile, source: second.origin })()).resolves.toBe('failed');

    expect(events).toEqual([
      preparedOutcome('NEX-12', workspace),
      {
        source: 'prepare-workspace',
        type: 'failed',
        data: {
          reason: expect.stringContaining(
            `retains repository "${first.origin}", not the configured "${second.origin}"`,
          ),
        },
      },
    ]);
    // The retained identity, branch, local commit and uncommitted work are untouched.
    expect(await readPrepared(workspace)).toEqual({
      taskKey: 'NEX-12',
      repository: first.origin,
      repositoryWorkspace: { root: workspace },
      branch: 'task/NEX-12',
      baseRevision: first.revision,
    });
    expect((await gitCommand(['symbolic-ref', '--short', 'HEAD'], worktree)).trim()).toBe(
      'task/NEX-12',
    );
    expect(await headOf(worktree)).toBe(localHead);
    expect(await readFile(path.join(worktree, 'notes.txt'), 'utf8')).toBe('untracked\n');
  });

  it('reports a retained worktree that is on another branch', async () => {
    const { origin } = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    const selectionFile = await writeSelection('NEX-6', workspace);
    await expect(prepareOver({ selectionFile, source: origin })()).resolves.toBe('prepared');
    await gitCommand(['checkout', '--quiet', '-b', 'other'], worktreeOf(workspace));

    await expect(prepareOver({ selectionFile, source: origin })()).resolves.toBe('failed');

    expect(events).toEqual([
      preparedOutcome('NEX-6', workspace),
      {
        source: 'prepare-workspace',
        type: 'failed',
        data: { reason: expect.stringContaining('"other"') },
      },
    ]);
    expect((await readPrepared(workspace)).branch).toBe('task/NEX-6');
  });

  it('reports a completed preparation command that fails and preserves its output', async () => {
    const { origin } = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    const selectionFile = await writeSelection('NEX-7', workspace);
    const preparation: Command[] = [
      { executable: 'bash', args: ['-c', 'echo first > first.txt'] },
      { executable: 'bash', args: ['-c', 'echo problem >&2; exit 3'] },
      { executable: 'bash', args: ['-c', 'echo third > third.txt'] },
    ];

    await expect(prepareOver({ selectionFile, source: origin, preparation })()).resolves.toBe(
      'failed',
    );

    expect(events).toEqual([
      {
        source: 'prepare-workspace',
        type: 'failed',
        data: { reason: expect.stringContaining('exit code 3') },
      },
    ]);
    const worktree = worktreeOf(workspace);
    expect(await readFile(path.join(worktree, 'first.txt'), 'utf8')).toBe('first\n');
    await expect(stat(path.join(worktree, 'third.txt'))).rejects.toThrow(/ENOENT/);
    expect(
      await readFile(path.join(workspace, 'state', 'preparation', '1', 'stderr.log'), 'utf8'),
    ).toBe('problem\n');
    // A failed preparation is not ready, so no prepared identity is recorded.
    await expect(stat(path.join(workspace, 'state', 'prepared-workspace.json'))).rejects.toThrow(
      /ENOENT/,
    );
    // The stated reason and the attempt identity are retained for the terminal handoff.
    expect(
      JSON.parse(await readFile(path.join(workspace, 'state', 'preparation-failure.json'), 'utf8')),
    ).toEqual({ reason: expect.stringContaining('exit code 3') });
    expect(
      JSON.parse(await readFile(path.join(workspace, 'state', 'attempt.json'), 'utf8')),
    ).toMatchObject({ attemptId: expect.any(String) });
  });

  it('keeps one attempt identity through repetition and mints a new one for a fresh attempt', async () => {
    const { origin } = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    const selectionFile = await writeSelection('NEX-9', workspace);
    const prepare = prepareOver({ selectionFile, source: origin });

    await expect(prepare()).resolves.toBe('prepared');
    const first = await readAttempt(workspace);
    // Repeating the invocation continues the same attempt.
    await expect(prepare()).resolves.toBe('prepared');
    expect(await readAttempt(workspace)).toBe(first);

    // Recovery discards the attempt's state; the fresh attempt carries its own identity.
    await rm(path.join(workspace, 'state'), { recursive: true, force: true });
    await rm(path.join(workspace, 'worktree'), { recursive: true, force: true });
    await rm(path.join(workspace, 'artifacts'), { recursive: true, force: true });
    await expect(prepare()).resolves.toBe('prepared');
    expect(await readAttempt(workspace)).not.toBe(first);
  });

  it('treats a preparation launch failure as an execution error', async () => {
    const { origin } = await repositoryWithOrigin();
    const workspace = path.join(root, 'workspace');
    const selectionFile = await writeSelection('NEX-8', workspace);
    const prepare = prepareOver({
      selectionFile,
      source: origin,
      preparation: [{ executable: path.join(root, 'absent-executable'), args: [] }],
    });

    await expect(prepare()).rejects.toThrow(/Cannot start/);
  });

  it('reports a missing selection record instead of preparing a guess', async () => {
    const { origin } = await repositoryWithOrigin();
    const prepare = prepareOver({
      selectionFile: path.join(root, 'executions', 'selection.json'),
      source: origin,
    });

    await expect(prepare()).rejects.toThrow(/does not exist/);
  });

  it('reports an invalid selection record instead of preparing a guess', async () => {
    const { origin } = await repositoryWithOrigin();
    const selectionFile = path.join(root, 'executions', 'selection.json');
    await mkdir(path.dirname(selectionFile), { recursive: true });
    await writeFile(selectionFile, '{ not json', 'utf8');

    await expect(prepareOver({ selectionFile, source: origin })()).rejects.toThrow(
      /is not valid JSON/,
    );
  });

  it('prepares the workspace that the real SelectWork selected', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const selected = {
      id: '1',
      key: 'NEX-9',
      fields: {
        summary: 'Prepare the workspace',
        description: { type: 'doc', content: [] },
        status: { id: '1', name: 'To Do' },
      },
    };
    const { jira } = scriptedJira({
      searchIssues: () => ok([{ id: '1', key: 'NEX-9' }]),
      readIssue: () => ok(selected),
      readComments: () => ok([]),
      readTransitions: () =>
        ok([{ id: '31', name: 'Start', to: { id: '2', name: 'In Progress' } }]),
      updateFields: () => ok(undefined),
      transitionIssue: () => ok(undefined),
    });
    const selectionFile = path.join(root, 'executions', 'selection.json');
    const select = createSelectWork({
      selectionFile,
      workspaceRoot: path.join(root, 'workspaces'),
      project: 'NEX',
      selection: { query: 'project = NEX', orderBy: 'Rank ASC' },
      ideas: { query: 'project = NEX AND status = Idea', orderBy: 'Rank ASC' },
      preparation: undefined,
      ideaStatuses: {
        submitted: 'Idea',
        active: 'Idea Refinement',
        approved: 'Draft',
        waitingForFeedback: 'Waiting for Feedback',
      },
      statuses: {
        ready: 'To Do',
        inProgress: 'In Progress',
        review: 'In Review',
        done: 'Done',
      },
      workspacePointerField: 'customfield_10042',
      jira,
      publish: (event) => events.push(event),
    });
    expect(await select()).toBe('selected');

    await expect(prepareOver({ selectionFile, source: origin })()).resolves.toBe('prepared');

    const workspace = path.join(root, 'workspaces', 'NEX', 'NEX-9');
    expect(await readPrepared(workspace)).toEqual({
      taskKey: 'NEX-9',
      repository: origin,
      repositoryWorkspace: { root: workspace },
      branch: 'task/NEX-9',
      baseRevision: revision,
    });
  });

  /** Write one implementation ticket's own workspace and its recorded implementation input. */
  async function writeImplementationInput(settings: {
    readonly ticketRoot: string;
    readonly sourceRoot: string;
    readonly prerequisites: readonly string[];
    readonly continuation: {
      readonly workspace: {
        readonly repository: string;
        readonly repositoryWorkspace: { readonly root: string };
        readonly branch: string;
        readonly baseRevision: string;
      };
      readonly headRevision: string;
    } | null;
  }): Promise<void> {
    await mkdir(path.join(settings.ticketRoot, 'parent'), { recursive: true });
    await writeFile(
      path.join(settings.ticketRoot, 'parent/implementation-input.json'),
      JSON.stringify({
        sourceKey: 'NEX-1',
        sourceWorkspace: { root: settings.sourceRoot },
        architectureResult: { path: 'architecture/artifacts/1/result.json' },
        planIdentity: 'plan-identity',
        plannedTask: 1,
        prerequisites: [...settings.prerequisites],
        continuation: settings.continuation,
      }),
    );
  }

  /** Retain one prerequisite ticket's confirmed completion evidence in its own workspace. */
  async function writeCompletion(
    workspaces: string,
    ticketKey: string,
    mergeRevision: string,
  ): Promise<void> {
    const workspace = path.join(workspaces, 'NEX', ticketKey);
    await mkdir(path.join(workspace, 'state'), { recursive: true });
    await mkdir(path.join(workspace, 'artifacts', '1'), { recursive: true });
    await writeFile(
      path.join(workspace, 'state/current-round.json'),
      JSON.stringify({ number: 1, profile: 'nexus-flash', reason: 'The initial implementation.' }),
    );
    await writeFile(
      path.join(workspace, 'artifacts/1/completion.json'),
      JSON.stringify({
        taskKey: ticketKey,
        pullRequestUrl: 'https://github.com/owner/repository/pull/1',
        reviewedHead: mergeRevision,
        mergeRevision,
        checks: [],
      }),
    );
  }

  it('continues the handed-off preparation checkout for the first implementation ticket', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const workspaces = path.join(root, 'workspaces');
    const preparationRoot = path.join(workspaces, 'NEX', 'NEX-1');
    const preparationWorktree = worktreeOf(preparationRoot);
    await mkdir(preparationRoot, { recursive: true });
    expect(await git.cloneRepository(origin, preparationWorktree)).toMatchObject({ ok: true });
    expect(await git.createBranch(preparationWorktree, 'task/NEX-1', revision)).toMatchObject({
      ok: true,
    });
    await mkdir(path.join(preparationWorktree, 'docs'), { recursive: true });
    await writeFile(path.join(preparationWorktree, 'docs', 'requirements.md'), '# Requirements\n');
    await gitCommand(['add', 'docs/requirements.md'], preparationWorktree);
    await gitCommand(['commit', '--quiet', '--message', 'the requirements'], preparationWorktree);
    const preparedRevision = await headOf(preparationWorktree);
    const ticketRoot = path.join(workspaces, 'NEX', 'NEX-2');
    await writeImplementationInput({
      ticketRoot,
      sourceRoot: preparationRoot,
      prerequisites: [],
      continuation: {
        workspace: {
          repository: origin,
          repositoryWorkspace: { root: preparationRoot },
          branch: 'task/NEX-1',
          baseRevision: revision,
        },
        headRevision: preparedRevision,
      },
    });
    const selectionFile = await writeSelection('NEX-2', ticketRoot);
    const prepare = prepareOver({
      selectionFile,
      source: origin,
      project: 'NEX',
      workspaceRoot: workspaces,
      preparation: [{ executable: 'bash', args: ['-c', 'pwd > preparation-cwd.txt'] }],
    });

    await expect(prepare()).resolves.toBe('prepared');

    // The recorded repository workspace is the preparation issue's checkout, with the retained
    // branch and the original comparison base; the implementation issue owns no worktree.
    expect(await readPrepared(ticketRoot)).toEqual({
      taskKey: 'NEX-2',
      repository: origin,
      repositoryWorkspace: { root: preparationRoot },
      branch: 'task/NEX-1',
      baseRevision: revision,
    });
    expect(await headOf(preparationWorktree)).toBe(preparedRevision);
    expect(await readFile(path.join(preparationWorktree, 'docs/requirements.md'), 'utf8')).toBe(
      '# Requirements\n',
    );
    expect(await readFile(path.join(preparationWorktree, 'preparation-cwd.txt'), 'utf8')).toBe(
      `${preparationWorktree}\n`,
    );
    await expect(stat(worktreeOf(ticketRoot))).rejects.toMatchObject({ code: 'ENOENT' });
    // A repetition reuses the same continuation instead of cloning a replacement.
    await expect(prepare()).resolves.toBe('prepared');
    expect(await readPrepared(ticketRoot)).toMatchObject({
      repositoryWorkspace: { root: preparationRoot },
      branch: 'task/NEX-1',
    });
  });

  it('refuses a preparation continuation whose frozen revision left the branch history', async () => {
    const { origin, source, revision } = await repositoryWithOrigin();
    const workspaces = path.join(root, 'workspaces');
    const preparationRoot = path.join(workspaces, 'NEX', 'NEX-1');
    const preparationWorktree = worktreeOf(preparationRoot);
    await mkdir(preparationRoot, { recursive: true });
    expect(await git.cloneRepository(origin, preparationWorktree)).toMatchObject({ ok: true });
    expect(await git.createBranch(preparationWorktree, 'task/NEX-1', revision)).toMatchObject({
      ok: true,
    });
    const preparedRevision = await headOf(preparationWorktree);
    // Another commit lands on main after the branch point; it is not in the branch history.
    const unrelated = await publish(source, 'later.txt', 'later\n', 'later main commit');
    // The local preparation clone must be able to read the revision Git is asked about.
    expect(await git.fetchRevision(preparationWorktree, 'origin', 'main')).toMatchObject({
      ok: true,
      value: unrelated,
    });
    const ticketRoot = path.join(workspaces, 'NEX', 'NEX-2');
    await writeImplementationInput({
      ticketRoot,
      sourceRoot: preparationRoot,
      prerequisites: [],
      continuation: {
        workspace: {
          repository: origin,
          repositoryWorkspace: { root: preparationRoot },
          branch: 'task/NEX-1',
          baseRevision: revision,
        },
        headRevision: unrelated,
      },
    });
    const selectionFile = await writeSelection('NEX-2', ticketRoot);

    await expect(
      prepareOver({ selectionFile, source: origin, project: 'NEX', workspaceRoot: workspaces })(),
    ).resolves.toBe('failed');

    expect(events.at(-1)).toMatchObject({
      source: 'prepare-workspace',
      type: 'failed',
      data: { reason: expect.stringContaining('no longer in the retained branch history') },
    });
    // The donor checkout is preserved exactly as preparation left it.
    expect(await headOf(preparationWorktree)).toBe(preparedRevision);
    await expect(
      readFile(path.join(ticketRoot, 'state/prepared-workspace.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('starts a later implementation ticket only from a base containing the prerequisite merge revisions', async () => {
    const { origin, source } = await repositoryWithOrigin();
    const workspaces = path.join(root, 'workspaces');
    const merged = await publish(source, 'feature.txt', 'feature\n', 'the prerequisite merge');
    const firstTicketRoot = path.join(workspaces, 'NEX', 'NEX-3');
    await writeImplementationInput({
      ticketRoot: firstTicketRoot,
      sourceRoot: path.join(workspaces, 'NEX', 'NEX-1'),
      prerequisites: ['NEX-2'],
      continuation: null,
    });
    await writeCompletion(workspaces, 'NEX-2', merged);
    const selectionFile = await writeSelection('NEX-3', firstTicketRoot);

    await expect(
      prepareOver({ selectionFile, source: origin, project: 'NEX', workspaceRoot: workspaces })(),
    ).resolves.toBe('prepared');

    expect(await readPrepared(firstTicketRoot)).toEqual({
      taskKey: 'NEX-3',
      repository: origin,
      repositoryWorkspace: { root: firstTicketRoot },
      branch: 'task/NEX-3',
      baseRevision: merged,
    });
    expect(await headOf(worktreeOf(firstTicketRoot))).toBe(merged);

    // A merge revision main has not received cannot start the dependent's prepared checkout.
    const clone = path.join(root, 'unmerged');
    expect(await git.cloneRepository(origin, clone)).toMatchObject({ ok: true });
    expect(await git.createBranch(clone, 'task/NEX-8', merged)).toMatchObject({ ok: true });
    await writeFile(path.join(clone, 'unmerged.txt'), 'unmerged\n');
    await gitCommand(['add', 'unmerged.txt'], clone);
    await gitCommand(['commit', '--quiet', '--message', 'an unmerged prerequisite'], clone);
    const unmerged = await headOf(clone);
    await gitCommand(['push', '--quiet', origin, 'task/NEX-8'], clone);
    const secondTicketRoot = path.join(workspaces, 'NEX', 'NEX-4');
    await writeImplementationInput({
      ticketRoot: secondTicketRoot,
      sourceRoot: path.join(workspaces, 'NEX', 'NEX-1'),
      prerequisites: ['NEX-8'],
      continuation: null,
    });
    await writeCompletion(workspaces, 'NEX-8', unmerged);
    const blockedSelection = await writeSelection('NEX-4', secondTicketRoot);

    await expect(
      prepareOver({
        selectionFile: blockedSelection,
        source: origin,
        project: 'NEX',
        workspaceRoot: workspaces,
      })(),
    ).resolves.toBe('failed');
    expect(events.at(-1)).toMatchObject({
      source: 'prepare-workspace',
      type: 'failed',
      data: { reason: expect.stringContaining('does not contain prerequisite NEX-8') },
    });
    await expect(
      readFile(path.join(secondTicketRoot, 'state/prepared-workspace.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
