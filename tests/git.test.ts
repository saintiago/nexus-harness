/**
 * Focused tests: the real Git adapter drives real temporary repositories through the real
 * Processes adapter, establishing inspection, clone, fetch, pull, branch, diff and push behavior,
 * including conflicting work and genuine absence that must be reported instead of overwritten.
 * Injected command results cover operational failures a real repository cannot produce.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitAdapter, type GitAdapter } from '../src/adapters/git.js';
import { createPrepareStage } from '../src/task-engine/actions/preparation/prepare-stage/index.js';
import { createReviewPreparationPublication } from '../src/task-engine/actions/preparation/review-publication/index.js';
import {
  authoredIdentity,
  sourceInputIdentity,
} from '../src/task-engine/actions/preparation/evaluation-content.js';
import {
  stageAuthorArtifact,
  stageEvaluationArtifact,
} from '../src/task-engine/actions/preparation/artifacts.js';
import {
  decisionContentChanged,
  readCurrentDecision,
  requireCurrentAcceptance,
} from '../src/task-engine/actions/preparation/storage.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createPublishPreparation } from '../src/task-engine/actions/project/publish-preparation/index.js';
import {
  prepareDocumentationPublication,
  readAcceptedDocuments,
} from '../src/task-engine/actions/preparation/publication.js';
import { fault, ok } from '../src/result.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import { run, type ProcessOutput } from '../src/adapters/processes.js';
import { scriptedJira } from './support/jira.js';

/**
 * Git runs with a supplied environment. Global and system configuration are disabled so the
 * operator's settings cannot change test behavior, and commit identity comes from the environment.
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

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-git-'));
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

/**
 * Create a bare origin repository, a source working copy with one commit on main, and the commit
 * that main points to.
 */
async function repositoryWithOrigin(): Promise<{
  origin: string;
  source: string;
  revision: string;
}> {
  const root = await temporaryDirectory();
  const origin = path.join(root, 'origin.git');
  const source = path.join(root, 'source');
  await gitCommand(['init', '--quiet', '--bare', '--initial-branch=main', origin], root);
  await gitCommand(['init', '--quiet', '--initial-branch=main', source], root);
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

/** Clone origin into a fresh worktree through the adapter. */
async function cloneTo(origin: string): Promise<string> {
  const destination = path.join(await temporaryDirectory(), 'worktree');
  const result = await git.cloneRepository(origin, destination);
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  return destination;
}

/** Commit a file in a worktree. */
async function commitFile(worktree: string, name: string, content: string): Promise<string> {
  await writeFile(path.join(worktree, name), content);
  await gitCommand(['add', name], worktree);
  await gitCommand(['commit', '--quiet', '--message', `add ${name}`], worktree);
  return headOf(worktree);
}

/** One scripted command answer: output with an exit code, or an execution fault. */
type InjectedAnswer = {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly fault?: string;
};

/**
 * An adapter whose commands are answered by the supplied script, for operational failures a real
 * repository cannot produce. A command the script does not expect fails the test.
 */
function injectedGit(script: (args: readonly string[]) => InjectedAnswer): GitAdapter {
  return createGitAdapter(async (args, _directory, onOutput) => {
    const answer = script(args);
    if (answer.stdout !== undefined) {
      onOutput({ stream: 'stdout', chunk: Buffer.from(answer.stdout) });
    }
    if (answer.stderr !== undefined) {
      onOutput({ stream: 'stderr', chunk: Buffer.from(answer.stderr) });
    }
    if (answer.fault !== undefined) {
      return { ok: false, fault: { message: answer.fault } };
    }
    return { ok: true, value: { exitCode: answer.exitCode ?? 0 } };
  });
}

describe('Git adapter', () => {
  it('clones a repository and reports the checkout identity', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const destination = path.join(await temporaryDirectory(), 'worktree');

    const result = await git.cloneRepository(origin, destination);

    expect(result).toEqual({
      ok: true,
      value: { remoteUrl: origin, branch: 'main', headRevision: revision },
    });
    expect(await readFile(path.join(destination, 'readme.md'), 'utf8')).toBe('initial\n');
  });

  it('reports tracked and untracked work while inspecting a worktree', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);

    expect(await git.inspectRepository(worktree)).toEqual({
      ok: true,
      value: {
        remoteUrl: origin,
        branch: 'main',
        headRevision: revision,
        trackedChanges: false,
        untrackedChanges: false,
      },
    });

    await writeFile(path.join(worktree, 'readme.md'), 'changed\n');
    await writeFile(path.join(worktree, 'notes.txt'), 'untracked\n');

    expect(await git.inspectRepository(worktree)).toEqual({
      ok: true,
      value: {
        remoteUrl: origin,
        branch: 'main',
        headRevision: revision,
        trackedChanges: true,
        untrackedChanges: true,
      },
    });
  });

  it('reports no branch for a detached head', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    await gitCommand(['checkout', '--quiet', '--detach', revision], worktree);

    expect(await git.inspectRepository(worktree)).toMatchObject({
      ok: true,
      value: { branch: null, headRevision: revision },
    });
  });

  it('reports an unborn repository without an origin remote as absent identity values', async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, 'fresh');
    await gitCommand(['init', '--quiet', '--initial-branch=main', repository], root);

    expect(await git.inspectRepository(repository)).toEqual({
      ok: true,
      value: {
        remoteUrl: null,
        branch: 'main',
        headRevision: null,
        trackedChanges: false,
        untrackedChanges: false,
      },
    });
  });

  it('reports a path that is not a worktree as a fault with Git diagnostics', async () => {
    const directory = await temporaryDirectory();

    const result = await git.inspectRepository(directory);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/not a git repository/i) },
    });
  });

  it.each<[string, (adapter: GitAdapter) => Promise<unknown>]>([
    ['inspect', (adapter) => adapter.inspectRepository('/worktree')],
    ['clone', (adapter) => adapter.cloneRepository('/source', '/worktree')],
    ['pull', (adapter) => adapter.pullBranch('/worktree', 'origin', 'main')],
    ['create', (adapter) => adapter.createBranch('/worktree', 'main', 'a'.repeat(40))],
  ])(
    'reports a fault when the head identity query for %s times out',
    async (_operation, perform) => {
      const adapter = injectedGit((args) => {
        switch (args[0]) {
          case 'status':
          case 'clone':
          case 'pull':
          case 'checkout':
            return {};
          case 'remote':
            return { stdout: 'https://example.com/repository.git\n' };
          case 'symbolic-ref':
            return { stdout: 'main\n' };
          case 'rev-parse':
            return { fault: 'Command "git" exceeded its 100 ms time limit' };
          default:
            throw new Error(`unexpected git command: git ${args.join(' ')}`);
        }
      });

      expect(await perform(adapter)).toMatchObject({
        ok: false,
        fault: { message: expect.stringMatching(/time limit/) },
      });
    },
  );

  it('reports a fault when a reference query fails instead of reporting absence', async () => {
    const adapter = injectedGit((args) => {
      switch (args[0]) {
        case 'status':
          return {};
        case 'remote':
          return { stdout: 'https://example.com/repository.git\n' };
        case 'symbolic-ref':
          // A corrupted reference fails with a fatal error rather than the absence exit code.
          return { exitCode: 128, stderr: 'fatal: No such ref: HEAD\n' };
        default:
          throw new Error(`unexpected git command: git ${args.join(' ')}`);
      }
    });

    expect(await adapter.inspectRepository('/worktree')).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/No such ref: HEAD/) },
    });
  });

  it('reports a fault when the origin query fails instead of reporting a missing remote', async () => {
    const adapter = injectedGit((args) => {
      switch (args[0]) {
        case 'status':
          return {};
        case 'remote':
          // Only a missing remote is absence; an unreadable configuration is a failure.
          return { exitCode: 128, stderr: "fatal: cannot open '.git/config': Permission denied\n" };
        default:
          throw new Error(`unexpected git command: git ${args.join(' ')}`);
      }
    });

    expect(await adapter.inspectRepository('/worktree')).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/Permission denied/) },
    });
  });

  it('reports a fault when the local branch query fails instead of reporting a missing branch', async () => {
    const adapter = injectedGit((args) => {
      if (args[0] !== 'rev-parse') {
        throw new Error(`unexpected git command: git ${args.join(' ')}`);
      }
      return { fault: 'Cannot start "git": spawn git ENOENT' };
    });

    expect(await adapter.pushBranch('/worktree', 'main', 'a'.repeat(40))).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/Cannot start "git"/) },
    });
  });

  it('reports a clone that cannot complete instead of touching the destination', async () => {
    const { origin } = await repositoryWithOrigin();
    const destination = await cloneTo(origin);

    const result = await git.cloneRepository(origin, destination);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/already exists/i) },
    });
    expect(await readFile(path.join(destination, 'readme.md'), 'utf8')).toBe('initial\n');
  });

  it('fetches and resolves a remote branch revision without moving the local branch', async () => {
    const { origin, source, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    const published = await publish(source, 'second.txt', 'second\n', 'second');
    expect(published).not.toBe(revision);

    const result = await git.fetchRevision(worktree, 'origin', 'main');

    expect(result).toEqual({ ok: true, value: published });
    expect(await git.inspectRepository(worktree)).toMatchObject({
      ok: true,
      value: { headRevision: revision },
    });
  });

  it('reports an unknown fetch reference as a fault with Git diagnostics', async () => {
    const { origin } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);

    const result = await git.fetchRevision(worktree, 'origin', 'missing-branch');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/missing-branch/) },
    });
  });

  it('resolves a fetched annotated tag to its commit', async () => {
    const { origin, source, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    await gitCommand(['tag', '--annotate', 'v1', '--message', 'v1'], source);
    await gitCommand(['push', '--quiet', 'origin', 'v1'], source);

    const result = await git.fetchRevision(worktree, 'origin', 'v1');

    expect(result).toEqual({ ok: true, value: revision });
  });

  it('pulls remote changes into the current branch with a fast-forward', async () => {
    const { origin, source } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    const published = await publish(source, 'second.txt', 'second\n', 'second');

    const result = await git.pullBranch(worktree, 'origin', 'main');

    expect(result).toEqual({ ok: true, value: { branch: 'main', headRevision: published } });
    expect(await readFile(path.join(worktree, 'second.txt'), 'utf8')).toBe('second\n');
  });

  it('reports a conflicting pull as a fault and preserves the local work', async () => {
    const { origin, source } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    await publish(source, 'readme.md', 'published\n', 'published');
    await writeFile(path.join(worktree, 'readme.md'), 'local work\n');

    const result = await git.pullBranch(worktree, 'origin', 'main');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/readme\.md/) },
    });
    expect(await readFile(path.join(worktree, 'readme.md'), 'utf8')).toBe('local work\n');
  });

  it('refuses a pull that is not a fast-forward', async () => {
    const { origin, source } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    const local = await commitFile(worktree, 'local.txt', 'local\n');
    await publish(source, 'published.txt', 'published\n', 'published');

    const result = await git.pullBranch(worktree, 'origin', 'main');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/fast-forward/i) },
    });
    expect(await git.inspectRepository(worktree)).toMatchObject({
      ok: true,
      value: { branch: 'main', headRevision: local },
    });
  });

  it('creates and checks out a branch from an explicit revision', async () => {
    const { origin, source, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    await publish(source, 'second.txt', 'second\n', 'second');
    await git.pullBranch(worktree, 'origin', 'main');

    const result = await git.createBranch(worktree, 'task/NEX-1', revision);

    expect(result).toEqual({ ok: true, value: { branch: 'task/NEX-1', headRevision: revision } });
    expect(await git.inspectRepository(worktree)).toMatchObject({
      ok: true,
      value: { branch: 'task/NEX-1', headRevision: revision },
    });
    expect(await readFile(path.join(worktree, 'readme.md'), 'utf8')).toBe('initial\n');
  });

  it('reports an existing branch instead of adopting it', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);

    const result = await git.createBranch(worktree, 'main', revision);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/already exists/) },
    });
  });

  it('commits exactly the accepted paths while preserving an independently staged index entry', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    await writeFile(path.join(worktree, 'readme.md'), 'accepted document\n');
    await writeFile(path.join(worktree, 'code.js'), 'unrelated staged code\n');
    await gitCommand(['add', 'code.js'], worktree);
    const committed = await git.commitPaths(worktree, ['readme.md'], 'publish accepted documents');
    expect(committed.ok).toBe(true);
    const head = await headOf(worktree);
    expect(await git.readChangedPaths(worktree, revision, head)).toEqual({
      ok: true,
      value: ['readme.md'],
    });
    expect(await git.readFileAtRevision(worktree, head, 'code.js')).toMatchObject({ ok: false });
    expect((await gitCommand(['diff', '--cached', '--name-only'], worktree)).trim()).toBe(
      'code.js',
    );
    // Repetition cannot turn the unrelated staged entry into an empty-publication commit.
    expect(await git.commitPaths(worktree, ['readme.md'], 'repeat')).toMatchObject({
      ok: true,
      value: { headRevision: head },
    });
  });

  /** One preparation issue workspace with its selection record over a temporary repository. */
  async function preparationWorkspace(): Promise<{
    readonly origin: string;
    readonly source: string;
    readonly directory: string;
    readonly root: string;
    readonly worktree: string;
    readonly selectionFile: string;
  }> {
    const { origin, source } = await repositoryWithOrigin();
    const directory = await temporaryDirectory();
    const root = path.join(directory, 'NEX-1');
    const selectionFile = path.join(directory, 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: {},
        conversation: [],
        workspace: { root },
        stage: 'requirements',
      }),
    );
    return {
      origin,
      source,
      directory,
      root,
      worktree: path.join(root, 'worktree'),
      selectionFile,
    };
  }

  /** The retained preparation repository record, or null when preparation did not record one. */
  async function preparationWorkspaceRecord(root: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path.join(root, 'parent/prepared-repository.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  it.each([false, true])(
    'prepares the configured release base on one shared checkout (partial clone=%s)',
    async (partial) => {
      const { origin, source } = await repositoryWithOrigin();
      await gitCommand(['checkout', '-b', 'release'], source);
      const release = await commitFile(source, 'release.md', 'configured base\n');
      await gitCommand(['push', 'origin', 'release'], source);
      const workspace = await preparationWorkspace();
      const { root, worktree, selectionFile } = workspace;
      if (partial) {
        await mkdir(path.dirname(worktree), { recursive: true });
        await git.cloneRepository(origin, worktree);
      }
      const prepare = createPrepareStage({
        selectionFile,
        repository: { source: origin, mainBranch: 'release' },
        git,
        publish: () => undefined,
      });
      await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');
      expect(await git.inspectRepository(worktree)).toMatchObject({
        ok: true,
        value: { branch: 'task/NEX-1', headRevision: release },
      });
      // The shared record retains the repository reference, branch and comparison base, and every
      // stage entry reuses the same actual checkout.
      expect(
        JSON.parse(await readFile(path.join(root, 'parent/prepared-repository.json'), 'utf8')),
      ).toEqual({
        repository: origin,
        repositoryWorkspace: { root },
        branch: 'task/NEX-1',
        baseRevision: release,
      });
      await writeFile(path.join(worktree, 'release.md'), 'retained preparation work\n');
      await expect(prepare({ stage: 'architecture' })).resolves.toBe('prepared');
      expect(await readFile(path.join(worktree, 'release.md'), 'utf8')).toBe(
        'retained preparation work\n',
      );
    },
  );

  it('requests reconciliation for a legacy divergent per-stage checkout instead of replacing it', async () => {
    const workspace = await preparationWorkspace();
    const { origin, root, selectionFile } = workspace;
    const legacy = path.join(root, 'ux', 'worktree');
    await git.cloneRepository(origin, legacy);
    const retained = await commitFile(legacy, 'retained.md', 'legacy stage work\n');
    const reasons: string[] = [];
    const preparePublish = createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: (event) => {
        if (event.type === 'failed')
          reasons.push(String((event.data as { reason?: unknown }).reason));
      },
    });
    await expect(preparePublish({ stage: 'ux' })).resolves.toBe('failed');
    expect(reasons.join('\n')).toContain(legacy);
    expect(reasons.join('\n')).toContain('reconciliation');
    // The legacy history and the untouched shared path are preserved.
    expect(await headOf(legacy)).toBe(retained);
    expect(await readFile(path.join(legacy, 'retained.md'), 'utf8')).toBe('legacy stage work\n');
    await expect(
      readFile(path.join(root, 'parent/prepared-repository.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requests reconciliation for a locally changed or incompatible preparation checkout', async () => {
    const workspace = await preparationWorkspace();
    const { origin, root, worktree, selectionFile } = workspace;
    const reasons: string[] = [];
    const prepare = createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: (event) => {
        if (event.type === 'failed') {
          reasons.push(String((event.data as { reason?: unknown }).reason));
        }
      },
    });
    await git.cloneRepository(origin, worktree);
    await writeFile(path.join(worktree, 'local-work.md'), 'uncommitted local work\n');
    await expect(prepare({ stage: 'requirements' })).resolves.toBe('failed');
    expect(reasons.join('\n')).toContain('reconciliation');
    expect(await readFile(path.join(worktree, 'local-work.md'), 'utf8')).toBe(
      'uncommitted local work\n',
    );
    await expect(preparationWorkspaceRecord(root)).resolves.toBeNull();

    // A retained checkout that moved to another branch is preserved and reported.
    await rm(path.join(worktree, 'local-work.md'));
    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');
    await gitCommand(['checkout', '-b', 'diverged'], worktree);
    const diverged = await commitFile(worktree, 'diverged.md', 'diverged history\n');
    await expect(prepare({ stage: 'ux' })).resolves.toBe('failed');
    expect(reasons.at(-1)).toContain('diverged');
    expect(reasons.at(-1)).toContain('reconciliation');
    expect(await git.inspectRepository(worktree)).toMatchObject({
      ok: true,
      value: { branch: 'diverged', headRevision: diverged },
    });
    expect(await readFile(path.join(worktree, 'diverged.md'), 'utf8')).toBe('diverged history\n');
  });

  it('requests reconciliation when the preparation checkout belongs to another repository', async () => {
    const workspace = await preparationWorkspace();
    const outsider = await preparationWorkspace();
    const { root, worktree, selectionFile } = workspace;
    await git.cloneRepository(outsider.origin, worktree);
    const retained = await commitFile(worktree, 'other.md', 'another repository\n');
    const reasons: string[] = [];
    const prepare = createPrepareStage({
      selectionFile,
      repository: { source: workspace.origin, mainBranch: 'main' },
      git,
      publish: (event) => {
        if (event.type === 'failed') {
          reasons.push(String((event.data as { reason?: unknown }).reason));
        }
      },
    });

    await expect(prepare({ stage: 'requirements' })).resolves.toBe('failed');
    expect(reasons.at(-1)).toContain('belongs to');
    expect(await git.inspectRepository(worktree)).toMatchObject({
      ok: true,
      value: { headRevision: retained },
    });
    expect(await readFile(path.join(worktree, 'other.md'), 'utf8')).toBe('another repository\n');
    await expect(preparationWorkspaceRecord(root)).resolves.toBeNull();
  });

  /** Run one real author-declared round through the evaluator, the result writer and the reuse. */
  async function acceptedRound(settings: {
    readonly selectionFile: string;
    readonly root: string;
    readonly stage: 'requirements' | 'ux' | 'prototype' | 'architecture';
    readonly round: number;
    readonly route?: 'new' | 'next' | 'reassess';
    readonly author: Record<string, unknown>;
    readonly verdict?: 'accepted' | 'accepted-skip';
    readonly invokeAuthor?: boolean;
  }): Promise<Record<string, unknown>> {
    const stageRoot = path.join(settings.root, settings.stage);
    const artifacts = path.join(stageRoot, 'artifacts', String(settings.round));
    await mkdir(path.join(stageRoot, 'state'), { recursive: true });
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      path.join(stageRoot, 'state', 'current-round.json'),
      JSON.stringify({
        stage: settings.stage,
        round: settings.round,
        route: settings.route ?? 'new',
        profiles: { author: 'a', evaluator: 'e' },
      }),
    );
    if (settings.invokeAuthor) {
      await createStageAuthor({
        selectionFile: settings.selectionFile,
        stage: settings.stage,
        git,
        publish: () => undefined,
        runner: { run: async () => ok({ output: JSON.stringify(settings.author) }) },
      })({ task: settings.route === 'next' ? 'respond' : 'propose' });
    } else {
      await writeFile(
        path.join(artifacts, 'author.json'),
        JSON.stringify({ stage: settings.stage, revision: settings.round, ...settings.author }),
      );
    }
    const evaluator = createStageEvaluator({
      selectionFile: settings.selectionFile,
      stage: settings.stage,
      git,
      publish: () => undefined,
      runner: {
        run: async () =>
          ok({
            output: JSON.stringify({
              assessedRevision: settings.round,
              verdict: settings.verdict ?? 'accepted',
              reason: 'Inspected the exact retained content.',
              findings: [],
              priorFindings: [],
              upstream: null,
            }),
          }),
      },
    });
    await evaluator({ stage: settings.stage });
    const finalize = createStageResult({
      selectionFile: settings.selectionFile,
      stage: settings.stage,
      git,
      publish: () => undefined,
    });
    await finalize({ outcome: settings.verdict === 'accepted-skip' ? 'skipped' : 'accepted' });
    return JSON.parse(await readFile(path.join(artifacts, 'result.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  it('preserves successive edits, a deletion and unrelated staged work in the shared checkout', async () => {
    const workspace = await preparationWorkspace();
    const { origin, source, root, worktree, selectionFile } = workspace;
    // The configured base already tracks a document a later stage deletes.
    await publish(source, 'legacy.md', 'legacy\n', 'add legacy');
    const prepare = createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: () => undefined,
    });
    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');

    // Requirements edits the tracked document; UX then edits the same document again, deletes the
    // base document and adds a stage-owned story, with unrelated work staged but uncommitted.
    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\n');
    const requirements = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 1,
      author: {
        outcome: 'authored',
        summary: 'The requirements revision.',
        documents: [{ path: 'readme.md', description: 'the requirements' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        findingResponses: [],
      },
    });
    const requirementsRevision = (requirements.documents as { revision: string }[])[0]!.revision;
    expect(await git.readFileAtRevision(worktree, requirementsRevision, 'readme.md')).toEqual({
      ok: true,
      value: 'requirements revision\n',
    });

    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\nux revision\n');
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    await writeFile(path.join(worktree, 'stories', 'ux.stories.ts'), 'export const ux = 1;\n');
    await rm(path.join(worktree, 'legacy.md'));
    await writeFile(path.join(worktree, 'unrelated.txt'), 'unrelated staged work\n');
    await gitCommand(['add', 'unrelated.txt'], worktree);
    const ux = await acceptedRound({
      selectionFile,
      root,
      stage: 'ux',
      round: 2,
      author: {
        outcome: 'authored',
        summary: 'The UX revision and cleanup.',
        documents: [
          { path: 'readme.md', description: 'the shared document' },
          { path: 'legacy.md', description: 'a removed document' },
        ],
        sourcePaths: ['stories/ux.stories.ts'],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        findingResponses: [],
      },
    });
    const uxRevision = (ux.documents as { revision: string }[])[0]!.revision;
    expect(uxRevision).not.toBe(requirementsRevision);
    // The successive edits are both preserved in the one branch's history.
    expect(await git.readFileAtRevision(worktree, requirementsRevision, 'readme.md')).toEqual({
      ok: true,
      value: 'requirements revision\n',
    });
    expect(await git.readFileAtRevision(worktree, uxRevision, 'readme.md')).toEqual({
      ok: true,
      value: 'requirements revision\nux revision\n',
    });
    // The deletion is a stage-owned change, not a manufactured replacement document.
    const uxBasis = JSON.parse(
      await readFile(path.join(root, 'ux', 'artifacts/2/evaluation.json'), 'utf8'),
    ) as { basis: { content: { path: string; exists: boolean }[] } };
    expect(uxBasis.basis.content).toEqual(
      expect.arrayContaining([
        { path: 'readme.md', revision: uxRevision, exists: true },
        { path: 'legacy.md', revision: uxRevision, exists: false },
        { path: 'stories/ux.stories.ts', revision: uxRevision, exists: true },
      ]),
    );
    // The named commit excluded the unrelated staged work.
    expect((await gitCommand(['diff', '--cached', '--name-only'], worktree)).trim()).toBe(
      'unrelated.txt',
    );
    expect(await git.readFileAtRevision(worktree, uxRevision, 'unrelated.txt')).toMatchObject({
      ok: false,
    });
    const accepted = await readAcceptedDocuments(root);
    expect(accepted).toMatchObject({
      kind: 'documents',
      retained: ['stories/ux.stories.ts'],
    });
    if (accepted.kind === 'documents') {
      expect(
        accepted.documents.map((document) => [document.path, Boolean(document.exists)]),
      ).toEqual([
        ['legacy.md', false],
        ['readme.md', true],
      ]);
    }

    // A later unrelated commit preserves the UX decision, while the requirements decision no
    // longer covers the edited document and needs a current decision.
    await mkdir(path.join(worktree, 'docs'), { recursive: true });
    await writeFile(path.join(worktree, 'docs', 'architecture.md'), '# Architecture\n');
    await acceptedRound({
      selectionFile,
      root,
      stage: 'architecture',
      round: 3,
      author: {
        outcome: 'authored',
        summary: 'The architecture revision.',
        documents: [{ path: 'docs/architecture.md', description: 'the architecture' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        findingResponses: [],
      },
    });
    await expect(
      requireCurrentAcceptance({
        issueRoot: root,
        stage: 'ux',
        selection: JSON.parse(await readFile(selectionFile, 'utf8')),
        round: 2,
        verdict: 'accepted',
        author: stageAuthorArtifact.schema.parse(
          JSON.parse(await readFile(path.join(root, 'ux', 'artifacts/2/author.json'), 'utf8')),
        ),
        evaluation: stageEvaluationArtifact.schema.parse(
          JSON.parse(await readFile(path.join(root, 'ux', 'artifacts/2/evaluation.json'), 'utf8')),
        ),
        git,
      }),
    ).resolves.toBeUndefined();
    await expect(
      requireCurrentAcceptance({
        issueRoot: root,
        stage: 'requirements',
        selection: JSON.parse(await readFile(selectionFile, 'utf8')),
        round: 1,
        verdict: 'accepted',
        author: stageAuthorArtifact.schema.parse(
          JSON.parse(
            await readFile(path.join(root, 'requirements', 'artifacts/1/author.json'), 'utf8'),
          ),
        ),
        evaluation: stageEvaluationArtifact.schema.parse(
          JSON.parse(
            await readFile(path.join(root, 'requirements', 'artifacts/1/evaluation.json'), 'utf8'),
          ),
        ),
        git,
      }),
    ).rejects.toThrow(/current decision is required/);
    expect(await decisionContentChanged({ issueRoot: root, stage: 'requirements', git })).toBe(
      true,
    );
    expect(await decisionContentChanged({ issueRoot: root, stage: 'ux', git })).toBe(false);
    // A current decision requires the assessed content to still match the checkout: the later UX
    // edit leaves Requirements stale even though its recorded revision stays readable, while UX's
    // own decision stays current.
    await expect(
      readCurrentDecision({
        issueRoot: root,
        stage: 'requirements',
        selection: JSON.parse(await readFile(selectionFile, 'utf8')),
        git,
      }),
    ).resolves.toMatchObject({ kind: 'stale' });
    await expect(
      readCurrentDecision({
        issueRoot: root,
        stage: 'ux',
        selection: JSON.parse(await readFile(selectionFile, 'utf8')),
        git,
      }),
    ).resolves.toMatchObject({ kind: 'current' });
  });

  /**
   * Publish one preparation stage through the real publication over a controlled source, so the
   * routing and the retained handoff record are exercised as the parent uses them.
   */
  async function publishStage(settings: {
    readonly selectionFile: string;
    readonly root: string;
    readonly stage: 'requirements' | 'ux' | 'prototype' | 'architecture';
    readonly status: string;
    readonly transitions: readonly { readonly from: string; readonly to: string }[];
  }): Promise<{
    readonly outcome: string;
    readonly status: () => string;
    readonly stage: () => string | undefined;
    readonly awaiting: () => readonly string[];
    readonly returnFinding: () => unknown;
    readonly failures: readonly string[];
  }> {
    let status = settings.status;
    const failures: string[] = [];
    let commentCount = 0;
    const transitions = settings.transitions.map((transition, index) => ({
      id: String(index + 1),
      name: `Move to ${transition.to}`,
      to: { id: String(index + 10), name: transition.to },
      from: transition.from,
    }));
    const { jira } = scriptedJira({
      readIssue: () =>
        ok({
          id: '1',
          key: 'NEX-1',
          fields: {
            summary: 'Add a lint gate',
            description: { type: 'doc', content: [] },
            status: { id: '3', name: status },
          },
        }),
      readComments: () => ok([]),
      readTransitions: () =>
        ok(
          transitions
            .filter((transition) => transition.from === status)
            .map(({ id, name, to }) => ({ id, name, to })),
        ),
      addComment: (_issueId, body) => {
        commentCount += 1;
        return ok({ id: `c${String(commentCount)}`, body });
      },
      transitionIssue: (_issueId, transitionId) => {
        const transition = transitions.find((candidate) => candidate.id === transitionId);
        if (transition === undefined) {
          throw new Error(`Unknown transition ${transitionId}`);
        }
        status = transition.to.name;
        return ok(undefined);
      },
    });
    const publish = createPublishPreparation({
      selectionFile: settings.selectionFile,
      statuses: {
        requirements: 'Draft',
        uxProposal: 'UX Proposal',
        storybookRefinement: 'Storybook Refinement',
        architecture: 'Architecture',
      },
      waitingForFeedback: 'Waiting for Feedback',
      ideaActive: 'Idea Refinement',
      git,
      jira,
      publish: (event) => {
        if (event.type === 'failed') {
          failures.push(String((event.data as { readonly reason?: unknown }).reason));
        }
      },
    });
    const outcome = await publish({ stage: settings.stage });
    const saved = JSON.parse(await readFile(settings.selectionFile, 'utf8')) as {
      readonly stage: string;
    };
    const handoff = JSON.parse(
      await readFile(path.join(settings.root, 'parent/handoff.json'), 'utf8'),
    ) as { readonly awaitingStages: string[]; readonly return: unknown };
    return {
      outcome,
      status: () => status,
      stage: () => saved.stage,
      awaiting: () => handoff.awaitingStages,
      returnFinding: () => handoff.return,
      failures,
    };
  }

  it('returns changed earlier content to its owning stage and hands off after the reassessment', async () => {
    const workspace = await preparationWorkspace();
    const { origin, root, worktree, selectionFile } = workspace;
    const prepare = createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: () => undefined,
    });
    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');
    const transitions = [
      { from: 'UX Proposal', to: 'Draft' },
      { from: 'Draft', to: 'UX Proposal' },
      { from: 'UX Proposal', to: 'Storybook Refinement' },
      { from: 'Storybook Refinement', to: 'Architecture' },
    ];
    /** One authored stage report declaring the supplied documents. */
    const authored = (documents: readonly string[]) => ({
      outcome: 'authored',
      summary: 'The stage revision.',
      documents: documents.map((document) => ({
        path: document,
        description: 'the changed document',
      })),
      sourcePaths: [],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      findingResponses: [],
    });

    // Requirements accepts the shared document and UX then edits and accepts the same document.
    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\n');
    const requirements = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 1,
      author: authored(['readme.md']),
    });
    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\nux revision\n');
    const ux = await acceptedRound({
      selectionFile,
      root,
      stage: 'ux',
      round: 1,
      author: authored(['readme.md']),
    });
    const requirementsRevision = (requirements.documents as { readonly revision: string }[])[0]!
      .revision;
    const uxRevision = (ux.documents as { readonly revision: string }[])[0]!.revision;

    // An outer correction remains pending while UX triggers another content-based return.
    await mkdir(path.join(root, 'parent'), { recursive: true });
    await writeFile(
      path.join(root, 'parent/handoff.json'),
      JSON.stringify({
        stage: 'ux',
        upstreamReturns: 1,
        feedback: null,
        return: null,
        awaitingStages: ['architecture'],
        tickets: [],
        publications: [],
      }),
    );
    // Publishing UX finds that the Requirements acceptance no longer covers the edited document:
    // the route returns to the earliest responsible stage instead of advancing on a stale
    // decision, and UX re-confirms its own decision afterwards.
    const returned = await publishStage({
      selectionFile,
      root,
      stage: 'ux',
      status: 'UX Proposal',
      transitions,
    });
    expect(returned.outcome).toBe('advanced');
    expect(returned.stage()).toBe('requirements');
    expect(returned.awaiting()).toEqual(['requirements', 'ux', 'architecture']);
    expect(returned.returnFinding()).toMatchObject({ from: 'ux', to: 'requirements' });

    // Requirements reassesses the current retained content; unchanged content keeps the revision
    // the checkout already holds, so the decision becomes current again without rewriting history.
    const reassessment = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 2,
      route: 'reassess',
      author: authored(['readme.md']),
    });
    expect((reassessment.documents as { readonly revision: string }[])[0]!.revision).toBe(
      uxRevision,
    );
    // The earlier Requirements revision stays readable in the branch history.
    expect(await git.readFileAtRevision(worktree, requirementsRevision, 'readme.md')).toEqual({
      ok: true,
      value: 'requirements revision\n',
    });
    const requirementAdvance = await publishStage({
      selectionFile,
      root,
      stage: 'requirements',
      status: 'Draft',
      transitions,
    });
    expect(requirementAdvance.outcome).toBe('advanced');
    expect(requirementAdvance.stage()).toBe('ux');
    expect(requirementAdvance.awaiting()).toEqual(['ux', 'architecture']);

    // UX reuses its unchanged acceptance; the outer Architecture reassessment remains pending.
    await acceptedRound({
      selectionFile,
      root,
      stage: 'ux',
      round: 2,
      route: 'reassess',
      verdict: 'accepted-skip',
      author: {
        outcome: 'skip-proposed',
        summary: 'The retained journey still matches the corrected input.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: {
          reason: 'The retained journey still matches.',
          references: [path.join(root, 'ux', 'artifacts', '1', 'result.json')],
        },
        question: null,
        upstream: null,
        findingResponses: [],
      },
    });
    const uxAdvance = await publishStage({
      selectionFile,
      root,
      stage: 'ux',
      status: 'UX Proposal',
      transitions,
    });
    expect(uxAdvance.outcome).toBe('advanced');
    expect(uxAdvance.stage()).toBe('prototype');
    expect(uxAdvance.awaiting()).toEqual(['architecture']);

    // Storybook Refinement concludes an evaluated skip on the existing documents and Architecture
    // accepts its design, so the handoff finds no pending reassessment and clears Architecture's.
    await acceptedRound({
      selectionFile,
      root,
      stage: 'prototype',
      round: 1,
      verdict: 'accepted-skip',
      author: {
        outcome: 'skip-proposed',
        summary: 'No useful prototype work applies.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { reason: 'No useful prototype work applies.', references: ['readme.md'] },
        question: null,
        upstream: null,
        findingResponses: [],
      },
    });
    const prototypeAdvance = await publishStage({
      selectionFile,
      root,
      stage: 'prototype',
      status: 'Storybook Refinement',
      transitions,
    });
    expect(prototypeAdvance.outcome).toBe('advanced');
    expect(prototypeAdvance.stage()).toBe('architecture');

    await mkdir(path.join(worktree, 'docs'), { recursive: true });
    await writeFile(path.join(worktree, 'docs', 'architecture.md'), '# Architecture\n');
    await acceptedRound({
      selectionFile,
      root,
      stage: 'architecture',
      round: 1,
      author: authored(['docs/architecture.md']),
    });
    const handedOff = await publishStage({
      selectionFile,
      root,
      stage: 'architecture',
      status: 'Architecture',
      transitions,
    });
    expect(handedOff.outcome).toBe('handoff');
    expect(handedOff.awaiting()).toEqual([]);
  });

  it.each(['result', 'document', 'source', 'revision', 'branch', 'checkout'])(
    'binds complete reused prototype content through a %s reference and consecutive skips',
    async (referenceKind) => {
      const workspace = await preparationWorkspace();
      const { origin, root, worktree, selectionFile } = workspace;
      const prepare = createPrepareStage({
        selectionFile,
        repository: { source: origin, mainBranch: 'main' },
        git,
        publish: () => undefined,
      });
      await expect(prepare({ stage: 'prototype' })).resolves.toBe('prepared');
      await mkdir(path.join(worktree, 'docs'), { recursive: true });
      await mkdir(path.join(worktree, 'stories'), { recursive: true });
      await writeFile(path.join(worktree, 'docs', 'ux.md'), '# UX\n');
      await writeFile(
        path.join(worktree, 'stories', 'ux.stories.ts'),
        'export const journey = 1;\n',
      );
      // Round 1 authors the changed document and the stage-owned Storybook story the prototype owns.
      const first = await acceptedRound({
        selectionFile,
        root,
        stage: 'prototype',
        round: 1,
        author: {
          outcome: 'authored',
          summary: 'The prototype journey.',
          documents: [{ path: 'docs/ux.md', description: 'the journey' }],
          sourcePaths: ['stories/ux.stories.ts'],
          plan: [],
          skip: null,
          question: null,
          upstream: null,
          findingResponses: [],
        },
      });
      const prototypeRevision = (first.prototype as { readonly revision: string }).revision;
      expect(
        await git.readFileAtRevision(worktree, prototypeRevision, 'stories/ux.stories.ts'),
      ).toEqual({ ok: true, value: 'export const journey = 1;\n' });
      await expect(readAcceptedDocuments(root)).resolves.toMatchObject({
        kind: 'documents',
        retained: ['stories/ux.stories.ts'],
      });
      await expect(
        prepareDocumentationPublication({ root, baseBranch: 'main', taskKey: 'NEX-1', git }),
      ).resolves.toMatchObject({ kind: 'prepared' });

      /** The result file one round's skip reuses. */
      const resultFile = (round: number) =>
        path.join(root, 'prototype', 'artifacts', String(round), 'result.json');
      /** One reuse skip report referencing the preceding round's retained result. */
      const reuseSkip = (round: number) => ({
        outcome: 'skip-proposed',
        summary: 'The retained prototype still suffices.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: {
          reason: 'The retained prototype still suffices.',
          references: [
            round !== 2 || referenceKind === 'result'
              ? resultFile(round - 1)
              : referenceKind === 'document'
                ? 'docs/ux.md'
                : referenceKind === 'source'
                  ? 'stories/ux.stories.ts'
                  : referenceKind === 'revision'
                    ? prototypeRevision
                    : referenceKind === 'branch'
                      ? (first.prototype as { branch: string }).branch
                      : worktree,
          ],
        },
        question: null,
        upstream: null,
        findingResponses: [],
      });

      // Round 2 resolves the result reference into the complete reused content: the new acceptance
      // binds the document and the story, and the result keeps the prototype and its source paths.
      const second = await acceptedRound({
        selectionFile,
        root,
        stage: 'prototype',
        round: 2,
        verdict: 'accepted-skip',
        author: reuseSkip(2),
      });
      expect(second.documents).toEqual(first.documents);
      expect(second.sourcePaths).toEqual(['stories/ux.stories.ts']);
      expect(second.prototype).toEqual(first.prototype);
      expect(
        (
          JSON.parse(
            await readFile(path.join(root, 'prototype', 'artifacts/2/evaluation.json'), 'utf8'),
          ) as { readonly basis: { readonly content: unknown } }
        ).basis.content,
      ).toEqual(
        expect.arrayContaining([
          { path: 'docs/ux.md', revision: prototypeRevision, exists: true },
          { path: 'stories/ux.stories.ts', revision: prototypeRevision, exists: true },
        ]),
      );
      // The unchanged story stays a declared stage-owned path of the reused acceptance.
      await expect(readAcceptedDocuments(root)).resolves.toMatchObject({
        kind: 'documents',
        retained: ['stories/ux.stories.ts'],
      });
      await expect(
        prepareDocumentationPublication({ root, baseBranch: 'main', taskKey: 'NEX-1', git }),
      ).resolves.toMatchObject({ kind: 'prepared' });

      // A consecutive reuse keeps the retained work and its ownership intact.
      const third = await acceptedRound({
        selectionFile,
        root,
        stage: 'prototype',
        round: 3,
        verdict: 'accepted-skip',
        author: reuseSkip(3),
      });
      expect(third).toMatchObject({
        documents: first.documents,
        sourcePaths: ['stories/ux.stories.ts'],
        prototype: first.prototype,
      });

      // A later change to the retained story invalidates the skip, and another reuse of the older
      // acceptance cannot authorize the changed content.
      await writeFile(
        path.join(worktree, 'stories', 'ux.stories.ts'),
        'export const journey = 2;\n',
      );
      await gitCommand(['add', 'stories/ux.stories.ts'], worktree);
      await gitCommand(['commit', '--quiet', '--message', 'change the story'], worktree);
      expect(await decisionContentChanged({ issueRoot: root, stage: 'prototype', git })).toBe(true);
      await expect(
        readCurrentDecision({
          issueRoot: root,
          stage: 'prototype',
          selection: JSON.parse(await readFile(selectionFile, 'utf8')),
          git,
        }),
      ).resolves.toMatchObject({ kind: 'stale' });
      await expect(
        acceptedRound({
          selectionFile,
          root,
          stage: 'prototype',
          round: 4,
          verdict: 'accepted-skip',
          author: reuseSkip(4),
        }),
      ).rejects.toThrow(/current decision is required/);
    },
  );

  it.each(['relative', 'absolute', 'normalized absolute'])(
    'preserves %s existing-document evidence through consecutive result-reference skips',
    async (referenceForm) => {
      const { origin, root, worktree, selectionFile } = await preparationWorkspace();
      await createPrepareStage({
        selectionFile,
        repository: { source: origin, mainBranch: 'main' },
        git,
        publish: () => undefined,
      })({ stage: 'requirements' });
      const skip = (references: string[]) => ({
        outcome: 'skip-proposed',
        summary: 'Existing requirements suffice.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { reason: 'Existing requirements suffice.', references },
        question: null,
        upstream: null,
        findingResponses: [],
      });
      const reference =
        referenceForm === 'relative'
          ? 'readme.md'
          : referenceForm === 'absolute'
            ? path.join(worktree, 'readme.md')
            : `${worktree}/../worktree/./readme.md`;
      const artifactReference = path.join(root, 'source-input.json');
      await writeFile(artifactReference, '{}');
      const first = await acceptedRound({
        selectionFile,
        root,
        stage: 'requirements',
        round: 1,
        verdict: 'accepted-skip',
        invokeAuthor: true,
        author: skip([reference, artifactReference]),
      });
      expect(first.existingDocuments).toEqual([
        { path: path.join(worktree, 'readme.md'), revision: await headOf(worktree) },
      ]);
      expect(first.skipReferences).toEqual([reference, artifactReference]);
      const currentDecision = () =>
        readCurrentDecision({
          issueRoot: root,
          stage: 'requirements',
          selection: JSON.parse(selectionText),
          git,
        });
      const selectionText = await readFile(selectionFile, 'utf8');
      await expect(currentDecision()).resolves.toMatchObject({ kind: 'current' });
      await writeFile(path.join(worktree, 'readme.md'), 'changed before reuse\n');
      await expect(currentDecision()).resolves.toMatchObject({ kind: 'stale' });
      await expect(
        decisionContentChanged({ issueRoot: root, stage: 'requirements', git }),
      ).resolves.toBe(true);
      await expect(
        acceptedRound({
          selectionFile,
          root,
          stage: 'requirements',
          round: 2,
          verdict: 'accepted-skip',
          author: skip([path.join(root, 'requirements', 'artifacts/1/result.json')]),
        }),
      ).rejects.toThrow(/current decision is required/);
      await writeFile(path.join(worktree, 'readme.md'), 'initial\n');
      await commitFile(worktree, 'unrelated.md', 'unrelated change\n');
      for (const round of [2, 3]) {
        const result = await acceptedRound({
          selectionFile,
          root,
          stage: 'requirements',
          round,
          verdict: 'accepted-skip',
          author: skip([
            path.join(root, 'requirements', 'artifacts', String(round - 1), 'result.json'),
          ]),
        });
        expect(result.existingDocuments).toEqual(first.existingDocuments);
        expect(result.documents).toEqual([]);
        expect(
          stageEvaluationArtifact.schema.parse(
            JSON.parse(
              await readFile(
                path.join(root, 'requirements', 'artifacts', String(round), 'evaluation.json'),
                'utf8',
              ),
            ),
          ).basis.content,
        ).toEqual([{ path: 'readme.md', revision: await headOf(worktree), exists: true }]);
      }
      await expect(currentDecision()).resolves.toMatchObject({ kind: 'current' });
      await writeFile(path.join(worktree, 'readme.md'), 'changed requirements\n');
      await expect(
        readCurrentDecision({
          issueRoot: root,
          stage: 'requirements',
          selection: JSON.parse(await readFile(selectionFile, 'utf8')),
          git,
        }),
      ).resolves.toMatchObject({ kind: 'stale' });
      await expect(
        acceptedRound({
          selectionFile,
          root,
          stage: 'requirements',
          round: 4,
          verdict: 'accepted-skip',
          author: skip([path.join(root, 'requirements', 'artifacts/3/result.json')]),
        }),
      ).rejects.toThrow(/current decision is required/);
    },
  );

  it('retains a declared deletion through evaluator replay and reuse', async () => {
    const workspace = await preparationWorkspace();
    const { origin, source, root, worktree, selectionFile } = workspace;
    await publish(source, 'legacy.md', 'legacy\n', 'add legacy');
    await publish(source, 'legacy.ts', 'export const legacy = true;\n', 'add legacy source');
    const prepare = createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: () => undefined,
    });
    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');
    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\n');
    await rm(path.join(worktree, 'legacy.md'));
    await rm(path.join(worktree, 'legacy.ts'));
    const author = {
      outcome: 'authored',
      summary: 'The requirements revision retires the legacy document.',
      documents: [
        { path: 'readme.md', description: 'the requirements' },
        { path: 'legacy.md', description: 'the retired document' },
      ],
      sourcePaths: ['legacy.ts'],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      findingResponses: [],
    };
    const first = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 1,
      author,
    });
    const revision = (first.documents as { readonly revision: string }[])[0]!.revision;
    expect(
      (
        JSON.parse(
          await readFile(path.join(root, 'requirements', 'artifacts/1/evaluation.json'), 'utf8'),
        ) as { readonly basis: { readonly content: unknown } }
      ).basis.content,
    ).toEqual(
      expect.arrayContaining([
        { path: 'readme.md', revision, exists: true },
        { path: 'legacy.md', revision, exists: false },
      ]),
    );

    // Replaying the interrupted evaluation re-retains the already-committed deletion instead of
    // failing on the absent path.
    await expect(
      acceptedRound({ selectionFile, root, stage: 'requirements', round: 1, author }),
    ).resolves.toMatchObject({ documents: first.documents });

    // A following skip reuses the acceptance, retained absence included, and keeps the deletion
    // as a consumed document rather than unreadable file bytes.
    const second = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 2,
      verdict: 'accepted-skip',
      author: {
        outcome: 'skip-proposed',
        summary: 'The retained requirements still suffice.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: {
          reason: 'The retained requirements still suffice.',
          references: [path.join(root, 'requirements', 'artifacts', '1', 'result.json')],
        },
        question: null,
        upstream: null,
        findingResponses: [],
      },
    });
    expect(second.documents).toEqual(first.documents);
    await expect(readAcceptedDocuments(root)).resolves.toMatchObject({
      kind: 'documents',
      documents: [
        { path: 'legacy.md', exists: false },
        { path: 'readme.md', exists: true },
      ],
    });
    await expect(
      prepareDocumentationPublication({ root, baseBranch: 'main', taskKey: 'NEX-1', git }),
    ).resolves.toMatchObject({ kind: 'prepared' });

    // Authored repair and reassessment keep deletions even after an intervening reuse round.
    for (const [round, route] of [
      [3, 'next'],
      [4, 'reassess'],
    ] as const) {
      await writeFile(path.join(worktree, 'readme.md'), `requirements revision ${String(round)}\n`);
      const corrected = await acceptedRound({
        selectionFile,
        root,
        stage: 'requirements',
        round,
        route,
        author,
        invokeAuthor: true,
      });
      expect(corrected.sourcePaths).toEqual(['legacy.ts']);
      expect(
        stageEvaluationArtifact.schema.parse(
          JSON.parse(
            await readFile(
              path.join(root, 'requirements', 'artifacts', String(round), 'evaluation.json'),
              'utf8',
            ),
          ),
        ).basis.content,
      ).toEqual(
        expect.arrayContaining([
          { path: 'legacy.md', revision: await headOf(worktree), exists: false },
          { path: 'legacy.ts', revision: await headOf(worktree), exists: false },
        ]),
      );
      await expect(
        prepareDocumentationPublication({ root, baseBranch: 'main', taskKey: 'NEX-1', git }),
      ).resolves.toMatchObject({ kind: 'prepared' });
    }
    // Historical stage ownership never permits arbitrary nonexistent or another stage's paths.
    await expect(
      acceptedRound({
        selectionFile,
        root,
        stage: 'requirements',
        round: 5,
        route: 'reassess',
        invokeAuthor: true,
        author: {
          ...author,
          documents: [{ path: 'never-existed.md', description: 'not tracked' }],
        },
      }),
    ).rejects.toThrow(/was not tracked before this edit/);
    await expect(
      acceptedRound({
        selectionFile,
        root,
        stage: 'ux',
        round: 1,
        invokeAuthor: true,
        author,
      }),
    ).rejects.toThrow(/was not tracked before this edit/);
  });

  it('binds an evaluated skip to the existing document revision and refuses dirty evidence', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const directory = await temporaryDirectory();
    const root = path.join(directory, 'NEX-1');
    const area = path.join(root, 'architecture');
    const worktree = path.join(root, 'worktree');
    const selectionFile = path.join(directory, 'selection.json');
    await mkdir(path.join(area, 'state'), { recursive: true });
    await mkdir(path.join(area, 'artifacts/1'), { recursive: true });
    await git.cloneRepository(origin, worktree);
    await git.createBranch(worktree, 'task/NEX-1', revision);
    const selection = {
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: {},
      conversation: [],
      workspace: { root },
      stage: 'architecture',
    };
    await writeFile(selectionFile, JSON.stringify(selection));
    await writeFile(
      path.join(area, 'state/current-round.json'),
      JSON.stringify({
        stage: 'architecture',
        round: 1,
        route: 'new',
        profiles: { author: 'a', evaluator: 'e' },
      }),
    );
    await writeFile(
      path.join(area, 'artifacts/1/author.json'),
      JSON.stringify({
        stage: 'architecture',
        revision: 1,
        outcome: 'skip-proposed',
        summary: 'Existing design suffices.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: {
          reason: 'Existing design suffices.',
          references: ['readme.md', 'source requirements'],
        },
        question: null,
        upstream: null,
        findingResponses: [],
      }),
    );
    await writeFile(
      path.join(area, 'artifacts/1/evaluation.json'),
      JSON.stringify({
        basis: {
          author: { path: path.join(area, 'artifacts/1/author.json') },
          authorIdentity: authoredIdentity(
            stageAuthorArtifact.schema.parse(
              JSON.parse(await readFile(path.join(area, 'artifacts/1/author.json'), 'utf8')),
            ),
          ),
          sourceIdentity: sourceInputIdentity(selection as never),
          upstream: [],
          content: [{ path: 'readme.md', revision, exists: true }],
        },
        assessedRevision: 1,
        verdict: 'accepted-skip',
        reason: 'Inspected existing design.',
        findings: [],
        priorFindings: [],
        upstream: null,
      }),
    );
    const finalize = createStageResult({
      selectionFile,
      stage: 'architecture',
      git,
      publish: () => undefined,
    });
    await writeFile(path.join(worktree, 'readme.md'), 'not in the referenced revision\n');
    await expect(finalize({ outcome: 'skipped' })).rejects.toThrow(
      'a current decision is required',
    );
    await rm(path.join(worktree, 'readme.md'));
    await expect(finalize({ outcome: 'skipped' })).rejects.toThrow(
      'a current decision is required',
    );
    await writeFile(path.join(worktree, 'readme.md'), 'initial\n');
    await writeFile(path.join(worktree, 'source requirements'), 'new unevaluated input\n');
    await expect(finalize({ outcome: 'skipped' })).rejects.toThrow(
      'a current decision is required',
    );
    await rm(path.join(worktree, 'source requirements'));
    await expect(finalize({ outcome: 'skipped' })).resolves.toBe('saved');
    const result = JSON.parse(
      await readFile(path.join(area, 'artifacts/1/result.json'), 'utf8'),
    ) as { existingDocuments: unknown; skipReferences: unknown };
    expect(result.existingDocuments).toEqual([
      { path: path.join(worktree, 'readme.md'), revision },
    ]);
    expect(result.skipReferences).toEqual(['readme.md', 'source requirements']);
  });

  it('reuses accepted assets only through the immediately preceding acceptance', async () => {
    const workspace = await preparationWorkspace();
    const { origin, root, worktree, selectionFile } = workspace;
    const prepare = createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: () => undefined,
    });
    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');
    const area = path.join(root, 'requirements');
    const selection = JSON.parse(await readFile(selectionFile, 'utf8'));
    const finalize = createStageResult({
      selectionFile,
      stage: 'requirements',
      git,
      publish: () => undefined,
    });

    /** Write one evaluated requirements round over the shared checkout. */
    async function round(
      number: number,
      author: Record<string, unknown>,
      basisContent: readonly { path: string; revision: string; exists: boolean }[],
      verdict: 'accepted' | 'accepted-skip',
    ): Promise<void> {
      const artifacts = path.join(area, 'artifacts', String(number));
      await mkdir(path.join(area, 'state'), { recursive: true });
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        path.join(area, 'state', 'current-round.json'),
        JSON.stringify({
          stage: 'requirements',
          round: number,
          route: number === 1 ? 'new' : 'next',
          profiles: { author: 'a', evaluator: 'e' },
        }),
      );
      const authorFile = path.join(artifacts, 'author.json');
      const report = { stage: 'requirements', revision: number, ...author };
      await writeFile(authorFile, JSON.stringify(report));
      await writeFile(
        path.join(artifacts, 'evaluation.json'),
        JSON.stringify({
          basis: {
            author: { path: authorFile },
            authorIdentity: authoredIdentity(stageAuthorArtifact.schema.parse(report)),
            sourceIdentity: sourceInputIdentity(selection),
            upstream: [],
            content: basisContent,
          },
          assessedRevision: number,
          verdict,
          reason: 'The retained work suffices.',
          findings: [],
          priorFindings: [],
          upstream: null,
        }),
      );
    }

    // Round 1 authors the accepted document; round 2 reuses it explicitly through a skip.
    await writeFile(path.join(worktree, 'readme.md'), 'accepted content\n');
    const committed = await git.commitPaths(
      worktree,
      ['readme.md'],
      'Retain authored preparation content for evaluation',
    );
    if (!committed.ok || committed.value.headRevision === null) {
      throw new Error('the fixture could not commit the accepted content');
    }
    const revision = committed.value.headRevision;
    await round(
      1,
      {
        outcome: 'authored',
        summary: 'The accepted requirements.',
        documents: [{ path: 'readme.md', description: 'the requirements' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        findingResponses: [],
      },
      [{ path: 'readme.md', revision, exists: true }],
      'accepted',
    );
    await expect(finalize({ outcome: 'accepted' })).resolves.toBe('saved');
    await round(
      2,
      {
        outcome: 'skip-proposed',
        summary: 'The retained requirements still suffice.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: {
          reason: 'Retained work still suffices.',
          references: [path.join(area, 'artifacts/1/result.json')],
        },
        question: null,
        upstream: null,
        findingResponses: [],
      },
      // The reuse binds the retained document's current observation, as the evaluator's capture
      // does, so the skip cannot authorize changed content.
      [{ path: 'readme.md', revision, exists: true }],
      'accepted-skip',
    );
    await expect(finalize({ outcome: 'skipped' })).resolves.toBe('saved');
    expect(await readAcceptedDocuments(root)).toMatchObject({
      kind: 'documents',
      documents: [{ path: 'readme.md', revision }],
    });

    // An intervening upstream return invalidates the acceptance: a later skip cannot resurrect
    // the older outputs by naming them.
    const prior = JSON.parse(
      await readFile(path.join(area, 'artifacts/2/result.json'), 'utf8'),
    ) as Record<string, unknown>;
    await mkdir(path.join(area, 'artifacts/3'), { recursive: true });
    await writeFile(
      path.join(area, 'artifacts/3/result.json'),
      JSON.stringify({ ...prior, outcome: 'returnUpstream', documents: [], returnStage: 'idea' }),
    );
    await round(
      4,
      {
        outcome: 'skip-proposed',
        summary: 'Old references.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { reason: 'Reuse?', references: [path.join(area, 'artifacts/2/result.json')] },
        question: null,
        upstream: null,
        findingResponses: [],
      },
      [],
      'accepted-skip',
    );
    await expect(finalize({ outcome: 'skipped' })).resolves.toBe('saved');
    expect(await readAcceptedDocuments(root)).toMatchObject({ kind: 'documents', documents: [] });
  });

  it.each([
    'no-documents',
    'already-landed',
    'advancing-base',
    'outside-documents',
    'changed-content',
  ] as const)('checks the actual publication contribution (%s)', async (scenario) => {
    const { origin, source, revision } = await repositoryWithOrigin();
    const directory = await temporaryDirectory();
    const root = path.join(directory, 'NEX-1');
    const area = path.join(root, 'architecture');
    const worktree = path.join(root, 'worktree');
    await mkdir(path.join(area, 'state'), { recursive: true });
    await mkdir(path.join(area, 'artifacts/1'), { recursive: true });
    await git.cloneRepository(origin, worktree);
    await git.createBranch(worktree, 'task/NEX-1', revision);
    if (scenario !== 'no-documents') await commitFile(worktree, 'readme.md', 'accepted content\n');
    const accepted = await headOf(worktree);
    if (scenario === 'outside-documents')
      await commitFile(worktree, 'implementation.js', 'unaccepted code\n');
    if (scenario === 'changed-content')
      await writeFile(path.join(worktree, 'readme.md'), 'later unaccepted content\n');
    if (scenario === 'already-landed')
      await publish(source, 'readme.md', 'accepted content\n', 'independent accepted change');
    if (scenario === 'advancing-base' || scenario === 'outside-documents')
      await publish(source, 'unrelated.txt', 'new upstream content\n', 'unrelated merge');
    await writeFile(
      path.join(area, 'state/current-round.json'),
      JSON.stringify({
        stage: 'architecture',
        round: 1,
        route: 'new',
        profiles: { author: 'a', evaluator: 'e' },
      }),
    );
    await writeFile(
      path.join(area, 'artifacts/1/result.json'),
      JSON.stringify({
        stage: 'architecture',
        outcome: 'accepted',
        authoredRevision: 1,
        documents:
          scenario === 'no-documents'
            ? []
            : [{ path: path.join(worktree, 'readme.md'), revision: accepted }],
        sourcePaths: [],
        outputs: [],
        evaluation: { path: path.join(area, 'artifacts/1/evaluation.json') },
        reason: 'Accepted.',
        returnStage: null,
        returnFinding: null,
        prototype: null,
      }),
    );
    const prepared = await prepareDocumentationPublication({
      root,
      baseBranch: 'main',
      taskKey: 'NEX-1',
      git,
    });
    expect(prepared.kind).toBe(
      scenario === 'outside-documents' || scenario === 'changed-content'
        ? 'failed'
        : scenario === 'advancing-base'
          ? 'prepared'
          : 'unchanged',
    );
    const selectionFile = path.join(directory, 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: {},
        conversation: [],
        workspace: { root },
        stage: 'architecture',
      }),
    );
    let reviews = 0;
    const review = createReviewPreparationPublication({
      selectionFile,
      baseBranch: 'main',
      git,
      reviewerProfile: 'e',
      publish: () => undefined,
      reviewer: {
        run: async (request) => {
          reviews += 1;
          // The reviewer's workspace is the preparation issue root whose one shared worktree/
          // child AgentRuntime resolves once.
          expect(request.workspace.root).toBe(root);
          expect(path.join(request.workspace.root, 'worktree')).toBe(worktree);
          expect(request.context).toContain('+accepted content');
          expect(request.context).not.toContain('diff --git a/unrelated.txt');
          return ok({
            output: JSON.stringify({
              verdict: 'approved',
              summary: 'Inspected exact contribution.',
              findings: [],
              priorFindings: [],
            }),
          });
        },
      },
    });
    expect(await review()).toBe(
      scenario === 'outside-documents' || scenario === 'changed-content'
        ? 'failed'
        : scenario === 'advancing-base'
          ? 'approved'
          : 'unchanged',
    );
    expect(reviews).toBe(scenario === 'advancing-base' ? 1 : 0);
    // Assembly/review repetition preserves the exact assessed head even while main advances.
    if (scenario === 'advancing-base') {
      await publish(source, 'another-upstream.txt', 'later upstream\n', 'another merge');
      const replay = await prepareDocumentationPublication({
        root,
        baseBranch: 'main',
        taskKey: 'NEX-1',
        git,
      });
      expect(replay).toMatchObject({ kind: 'prepared', head: accepted, baseRevision: revision });
      expect(await review()).toBe('approved');
      expect(reviews).toBe(1);
    }
  });

  it('rejects a preparation reviewer invocation fault before saving or publishing', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const directory = await temporaryDirectory();
    const root = path.join(directory, 'NEX-1');
    const area = path.join(root, 'architecture');
    const worktree = path.join(root, 'worktree');
    await mkdir(path.join(area, 'state'), { recursive: true });
    await mkdir(path.join(area, 'artifacts/1'), { recursive: true });
    await git.cloneRepository(origin, worktree);
    await git.createBranch(worktree, 'task/NEX-1', revision);
    await commitFile(worktree, 'readme.md', 'accepted content\n');
    const accepted = await headOf(worktree);
    await writeFile(
      path.join(area, 'state/current-round.json'),
      JSON.stringify({
        stage: 'architecture',
        round: 1,
        route: 'new',
        profiles: { author: 'a', evaluator: 'e' },
      }),
    );
    await writeFile(
      path.join(area, 'artifacts/1/result.json'),
      JSON.stringify({
        stage: 'architecture',
        outcome: 'accepted',
        authoredRevision: 1,
        documents: [{ path: path.join(worktree, 'readme.md'), revision: accepted }],
        outputs: [],
        evaluation: { path: path.join(area, 'artifacts/1/evaluation.json') },
        reason: 'Accepted.',
        returnStage: null,
        returnFinding: null,
        prototype: null,
      }),
    );
    const selectionFile = path.join(directory, 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: {},
        conversation: [],
        workspace: { root },
        stage: 'architecture',
      }),
    );
    const events: string[] = [];
    const review = createReviewPreparationPublication({
      selectionFile,
      baseBranch: 'main',
      git,
      reviewerProfile: 'e',
      publish: (event) => {
        events.push(event.type);
      },
      reviewer: { run: async () => fault('the reviewer service is unavailable') },
    });

    // An invocation fault is an execution error, not a repository condition the parent captures
    // as a preparation failure: it rejects without a failure publication or a saved report the
    // parent could publish a review or check from.
    await expect(review()).rejects.toThrow('the reviewer service is unavailable');
    expect(events).toEqual([]);
    await expect(
      readFile(path.join(root, 'parent/documentation-reviews', `${accepted}.json`), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('includes both sides of a rename when checking the complete publication path set', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    await gitCommand(['mv', 'readme.md', 'accepted.md'], worktree);
    await gitCommand(['commit', '--quiet', '--message', 'rename'], worktree);
    expect(await git.readChangedPaths(worktree, revision, await headOf(worktree))).toEqual({
      ok: true,
      value: ['accepted.md', 'readme.md'],
    });
  });

  it('reads the diff between two revisions', async () => {
    const { origin, source, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    const published = await publish(source, 'second.txt', 'second\n', 'second');
    await git.pullBranch(worktree, 'origin', 'main');

    const result = await git.readDiff(worktree, revision, published);

    expect(result).toMatchObject({
      ok: true,
      value: expect.stringContaining('+second'),
    });
  });

  it('pushes the branch to origin and reads the remote branch head', async () => {
    const { origin } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    const head = await commitFile(worktree, 'change.txt', 'change\n');

    const result = await git.pushBranch(worktree, 'main', head);

    expect(result).toEqual({ ok: true, value: { branch: 'main', headRevision: head } });
    expect(await git.readRemoteBranchHead(origin, 'main')).toEqual({ ok: true, value: head });
  });

  it('does not push a branch that is not at the expected head', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);

    const result = await git.pushBranch(worktree, 'main', '0'.repeat(40));

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining(revision) },
    });
    expect(await git.readRemoteBranchHead(origin, 'main')).toEqual({
      ok: true,
      value: revision,
    });
  });

  it('reports a missing local branch instead of pushing', async () => {
    const { origin } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);

    const result = await git.pushBranch(worktree, 'absent', await headOf(worktree));

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/absent/) },
    });
  });

  it('reports a rejected push as a fault and leaves the remote branch unchanged', async () => {
    const { origin, source } = await repositoryWithOrigin();
    const worktree = await cloneTo(origin);
    const head = await commitFile(worktree, 'local.txt', 'local\n');
    const published = await publish(source, 'published.txt', 'published\n', 'published');

    const result = await git.pushBranch(worktree, 'main', head);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/rejected|non-fast-forward|fetch first/i) },
    });
    expect(await git.readRemoteBranchHead(origin, 'main')).toEqual({
      ok: true,
      value: published,
    });
  });

  it('reports an absent remote branch as null', async () => {
    const { origin } = await repositoryWithOrigin();

    expect(await git.readRemoteBranchHead(origin, 'missing')).toEqual({ ok: true, value: null });
  });

  it('reports an unreadable remote as a fault with Git diagnostics', async () => {
    const absent = path.join(await temporaryDirectory(), 'absent.git');

    const result = await git.readRemoteBranchHead(absent, 'main');

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/does not appear to be a git repository/i) },
    });
  });
});
