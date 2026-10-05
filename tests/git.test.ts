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
  requireCurrentAcceptance,
} from '../src/task-engine/actions/preparation/storage.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import {
  prepareDocumentationPublication,
  readAcceptedDocuments,
} from '../src/task-engine/actions/preparation/publication.js';
import { fault, ok } from '../src/result.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import { run, type ProcessOutput } from '../src/adapters/processes.js';

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

    /** Run one real author-declared round through the evaluator and the result writer. */
    async function acceptedRound(options: {
      readonly stage: 'requirements' | 'ux' | 'prototype' | 'architecture';
      readonly round: number;
      readonly author: Record<string, unknown>;
      readonly verdict?: 'accepted' | 'accepted-skip';
    }): Promise<Record<string, unknown>> {
      const stageRoot = path.join(root, options.stage);
      const artifacts = path.join(stageRoot, 'artifacts', String(options.round));
      await mkdir(path.join(stageRoot, 'state'), { recursive: true });
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        path.join(stageRoot, 'state', 'current-round.json'),
        JSON.stringify({
          stage: options.stage,
          round: options.round,
          route: 'new',
          profiles: { author: 'a', evaluator: 'e' },
        }),
      );
      await writeFile(
        path.join(artifacts, 'author.json'),
        JSON.stringify({ stage: options.stage, revision: options.round, ...options.author }),
      );
      const evaluator = createStageEvaluator({
        selectionFile,
        stage: options.stage,
        git,
        publish: () => undefined,
        runner: {
          run: async () =>
            ok({
              output: JSON.stringify({
                assessedRevision: options.round,
                verdict: options.verdict ?? 'accepted',
                reason: 'Inspected the exact retained content.',
                findings: [],
                priorFindings: [],
                upstream: null,
              }),
            }),
        },
      });
      await evaluator({ stage: options.stage });
      const finalize = createStageResult({
        selectionFile,
        stage: options.stage,
        git,
        publish: () => undefined,
      });
      await finalize({ outcome: options.verdict === 'accepted-skip' ? 'skipped' : 'accepted' });
      return JSON.parse(await readFile(path.join(artifacts, 'result.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    }

    // Requirements edits the tracked document; UX then edits the same document again, deletes the
    // base document and adds a stage-owned story, with unrelated work staged but uncommitted.
    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\n');
    const requirements = await acceptedRound({
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
      [],
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
