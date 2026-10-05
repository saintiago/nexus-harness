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
import type { CheckObservation, GitHubReview } from '../src/adapters/github.js';
import { createPrepareStage } from '../src/task-engine/actions/preparation/prepare-stage/index.js';
import { readAcceptedDocuments } from '../src/task-engine/actions/preparation/accepted-content.js';
import {
  preparationStages,
  stageAuthorArtifact,
  stageEvaluationArtifact,
} from '../src/task-engine/actions/preparation/artifacts.js';
import {
  readCurrentDecision,
  readStagePlan,
  requireCurrentAcceptance,
} from '../src/task-engine/actions/preparation/storage.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createPublishPreparation } from '../src/task-engine/actions/project/publish-preparation/index.js';
import { createCompleteDelivery } from '../src/task-engine/actions/project/complete-delivery/index.js';
import { createPublishDeliveryReport } from '../src/task-engine/actions/project/source-boundaries/index.js';
import { createCompleteTask } from '../src/task-engine/actions/complete-task/index.js';
import { createDeliver } from '../src/task-engine/actions/deliver/index.js';
import { createDevelop } from '../src/task-engine/actions/develop/index.js';
import { createPrepareWorkspace } from '../src/task-engine/actions/prepare-workspace/index.js';
import { createReview } from '../src/task-engine/actions/review/index.js';
import { createStartRound } from '../src/task-engine/actions/start-round/index.js';
import { createVerify } from '../src/task-engine/actions/verify/index.js';
import { fault, ok } from '../src/result.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import { run, type ProcessOutput } from '../src/adapters/processes.js';
import type { AgentRoleRunner } from '../src/task-engine/index.js';
import { scriptedJira } from './support/jira.js';
import { scriptedGitHub } from './support/github.js';
import { savePrototypeObservation } from './support/prototype-observation.js';
import { writeAssignedReport } from './support/agent-runner.js';
import { createStartStageRound } from '../src/task-engine/actions/preparation/start-stage-round/index.js';
import { createImplementationHandoff } from '../src/task-engine/actions/project/implementation-handoff/index.js';
import { reportIdentityOf } from '../src/task-engine/actions/agent-reports.js';

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

/** One bounded implementation task, the plan an Architecture report always carries. */
const architecturePlan = [
  {
    summary: 'Implement the accepted architecture',
    scope: 'Carry the accepted design into the implementation tickets.',
    completionCriteria: ['The accepted design is implemented and verified.'],
    prerequisites: [],
  },
];

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

/** Commit the given nested files in one worktree commit, creating their directories. */
async function commitFiles(
  worktree: string,
  files: readonly string[],
  message: string,
): Promise<string> {
  for (const name of files) {
    const file = path.join(worktree, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `# ${name}\n\nRetained content.\n`);
  }
  await gitCommand(['add', ...files], worktree);
  await gitCommand(['commit', '--quiet', '--message', message], worktree);
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
    /** The evaluator's declared observation record for an accepted applicable prototype. */
    readonly evaluatorObservation?: string;
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
    const authorMarkdown = `# ${settings.stage} author report\n\nThe controlled narrative.\n`;
    const evaluatorMarkdown = `# ${settings.stage} evaluator report\n\nThe controlled assessment.\n`;
    if (settings.invokeAuthor) {
      await createStageAuthor({
        selectionFile: settings.selectionFile,
        stage: settings.stage,
        git,
        publish: () => undefined,
        runner: {
          run: async (request) => {
            await writeAssignedReport(request.context, authorMarkdown);
            return ok({ output: JSON.stringify(settings.author) });
          },
        },
      })({ task: settings.route === 'next' ? 'respond' : 'propose' });
    } else {
      const reportFile = path.join(artifacts, 'reports', 'fixture', 'author.md');
      await mkdir(path.dirname(reportFile), { recursive: true });
      await writeFile(reportFile, authorMarkdown);
      const selection = JSON.parse(await readFile(settings.selectionFile, 'utf8')) as {
        readonly taskKey: string;
      };
      await writeFile(
        path.join(artifacts, 'author.json'),
        JSON.stringify({
          stage: settings.stage,
          revision: settings.round,
          ...settings.author,
          taskKey: selection.taskKey,
          profile: 'a',
          role: 'author',
          report: { path: reportFile },
          reportIdentity: reportIdentityOf(Buffer.from(authorMarkdown, 'utf8')),
          invocationId: 'fixture',
        }),
      );
    }
    const evaluator = createStageEvaluator({
      selectionFile: settings.selectionFile,
      stage: settings.stage,
      git,
      publish: () => undefined,
      runner: {
        run: async (request) => {
          await writeAssignedReport(request.context, evaluatorMarkdown);
          return ok({
            output: JSON.stringify({
              verdict: settings.verdict ?? 'accepted',
              observation:
                settings.evaluatorObservation === undefined
                  ? null
                  : { path: settings.evaluatorObservation },
              upstream: null,
            }),
          });
        },
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
        documents: [{ path: 'readme.md' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
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
        documents: [{ path: 'readme.md' }, { path: 'legacy.md' }],
        sourcePaths: ['stories/ux.stories.ts'],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
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
    // A document stage keeps no per-document binding: its decision records the observed revision
    // and the changed set lives in the result, deletion included.
    const uxEvaluation = stageEvaluationArtifact.schema.parse(
      JSON.parse(await readFile(path.join(root, 'ux', 'artifacts/2/evaluation.json'), 'utf8')),
    );
    expect(uxEvaluation.basis.repositoryRevision).toBe(uxRevision);
    expect(uxEvaluation.basis.content).toEqual([]);
    expect(ux.documents).toEqual([
      { path: path.join(worktree, 'readme.md'), revision: uxRevision },
      { path: path.join(worktree, 'legacy.md'), revision: uxRevision },
    ]);
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

    // A later unrelated commit moves the checkout revision: neither stage can be freshly
    // finalized from its interrupted evaluation, yet both retained verdicts stay current for
    // consumers because a compatible later change does not invalidate a completed decision.
    await mkdir(path.join(worktree, 'docs'), { recursive: true });
    await writeFile(path.join(worktree, 'docs', 'architecture.md'), '# Architecture\n');
    await acceptedRound({
      selectionFile,
      root,
      stage: 'architecture',
      round: 3,
      author: {
        outcome: 'authored',
        documents: [{ path: 'docs/architecture.md' }],
        sourcePaths: [],
        plan: architecturePlan,
        skip: null,
        question: null,
        upstream: null,
        observation: null,
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
    ).rejects.toThrow(/current decision is required/);
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
    // A later stage's shared-document edit does not manufacture a Requirements finding.
    // Both completed decisions remain available; fresh finalization above still rejects edits
    // that happened during the evaluation/publication boundary.
    await expect(
      readCurrentDecision({
        issueRoot: root,
        stage: 'requirements',
        selection: JSON.parse(await readFile(selectionFile, 'utf8')),
        git,
      }),
    ).resolves.toMatchObject({ kind: 'current' });
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

  it.each([
    { resumed: 'ux' as const, input: 'conversation' },
    { resumed: 'architecture' as const, input: 'task' },
  ])(
    'reconciles refreshed $input on $resumed resumption before handoff',
    async ({ resumed, input }) => {
      const { origin, root, worktree, selectionFile } = await preparationWorkspace();
      await createPrepareStage({
        selectionFile,
        repository: { source: origin, mainBranch: 'main' },
        git,
        publish: () => undefined,
      })({ stage: 'requirements' });
      const statuses = {
        requirements: 'Draft',
        ux: 'UX Proposal',
        prototype: 'Storybook Refinement',
        architecture: 'Architecture',
      };
      const transitions = Object.values(statuses).flatMap((from) =>
        Object.values(statuses).map((to) => ({ from, to })),
      );
      const skip = (stage: string) => ({
        outcome: 'skip-proposed',
        documents: [],
        sourcePaths: [],
        plan:
          stage === 'architecture'
            ? [
                {
                  summary: 'Implement the requirement',
                  scope: 'The accepted requirement.',
                  completionCriteria: ['The requirement is implemented.'],
                  prerequisites: [],
                },
              ]
            : [],
        skip: { references: ['readme.md'] },
        question: null,
        upstream: null,
        observation: null,
      });
      // Retain earlier decisions as on feedback resumption. Later stages have not run yet.
      for (const stage of preparationStages.slice(0, preparationStages.indexOf(resumed))) {
        await acceptedRound({
          selectionFile,
          root,
          stage,
          round: 1,
          verdict: 'accepted-skip',
          invokeAuthor: true,
          author: skip(stage),
        });
      }
      const selection = JSON.parse(await readFile(selectionFile, 'utf8')) as Record<
        string,
        unknown
      >;
      await writeFile(
        selectionFile,
        JSON.stringify({
          ...selection,
          stage: resumed,
          [input]:
            input === 'conversation'
              ? [
                  {
                    id: 'clarification',
                    author: { displayName: 'Human' },
                    body: 'Clarified scope.',
                  },
                ]
              : { fields: { description: 'Clarified scope.' } },
        }),
      );
      await acceptedRound({
        selectionFile,
        root,
        stage: resumed,
        round: 1,
        verdict: 'accepted-skip',
        invokeAuthor: true,
        author: skip(resumed),
      });
      const decision = async (stage: (typeof preparationStages)[number]) =>
        readCurrentDecision({
          issueRoot: root,
          stage,
          selection: JSON.parse(await readFile(selectionFile, 'utf8')),
          git,
        });
      await expect(decision('requirements')).resolves.toMatchObject({ kind: 'stale' });
      const returned = await publishStage({
        selectionFile,
        root,
        stage: resumed,
        status: statuses[resumed],
        transitions,
      });
      expect(returned.outcome).toBe('advanced');
      expect(returned.stage()).toBe('requirements');
      expect(returned.awaiting()).toEqual(
        preparationStages.slice(0, preparationStages.indexOf(resumed) + 1),
      );
      expect(returned.returnFinding()).toMatchObject({ from: resumed, to: 'requirements' });
      expect(returned.failures).toEqual([]);

      // Recreate each action on re-entry; only the saved route and round history carry state.
      const head = await headOf(worktree);
      for (const stage of preparationStages) {
        const start = () =>
          createStartStageRound({
            selectionFile,
            stage,
            profiles: { authors: ['a'], evaluator: 'e' },
            maxRounds: 2,
            publish: () => undefined,
          })({ route: 'new' });
        await expect(start()).resolves.toBe('opened');
        const plan = await readStagePlan(path.join(root, stage));
        const retained = preparationStages.indexOf(stage) <= preparationStages.indexOf(resumed);
        expect(plan).toMatchObject({
          round: retained ? 2 : 1,
          route: retained ? 'reassess' : 'new',
        });
        // A restart before authoring must reuse the opened round, not consume another allowance.
        await expect(start()).resolves.toBe('opened');
        expect(await readStagePlan(path.join(root, stage))).toEqual(plan);
        await acceptedRound({
          selectionFile,
          root,
          stage,
          round: plan!.round,
          route: plan!.route,
          verdict: 'accepted-skip',
          invokeAuthor: true,
          author: skip(stage),
        });
        const publication = await publishStage({
          selectionFile,
          root,
          stage,
          status: statuses[stage],
          transitions,
        });
        expect(publication.failures).toEqual([]);
        expect(publication.outcome).toBe(stage === 'architecture' ? 'handoff' : 'advanced');
        expect(publication.awaiting()).not.toContain(stage);
        if (stage === 'requirements') {
          // An updated upstream report does not manufacture a new finding; the pending source correction still requires reassessment.
          await expect(decision(resumed)).resolves.toMatchObject({ kind: 'current' });
          expect(publication.awaiting()).toContain(resumed);
        }
        if (stage === 'architecture') expect(publication.awaiting()).toEqual([]);
      }
      expect(await headOf(worktree)).toBe(head);
      for (const stage of preparationStages) {
        await expect(decision(stage)).resolves.toMatchObject({ kind: 'current' });
      }
      await expect(
        createStartStageRound({
          selectionFile,
          stage: 'requirements',
          profiles: { authors: ['a'], evaluator: 'e' },
          maxRounds: 2,
          publish: () => undefined,
        })({ route: 'new' }),
      ).resolves.toBe('exhausted');

      // Exercise the final consumer too: it must create the planned ticket, not fail on stale input.
      let status = 'Architecture';
      const { jira, calls } = scriptedJira({
        readIssue: (id) =>
          ok({
            id,
            key: id === '1' ? 'NEX-1' : 'NEX-2',
            fields: {
              status: { name: id === '1' ? status : 'To Do' },
              summary: id === '1' ? 'Source' : 'Implement the requirement',
            },
          }),
        readComments: () => ok([]),
        searchIssues: () => ok([]),
        createIssue: () => ok({ id: '2', key: 'NEX-2' }),
        linkIssues: () => ok(undefined),
        updateFields: () => ok(undefined),
        readTransitions: () => ok([{ id: 'done', name: 'Done', to: { id: 'done', name: 'Done' } }]),
        transitionIssue: () => {
          status = 'Done';
          return ok(undefined);
        },
        addComment: () => ok({ id: 'handoff', body: {} }),
      });
      await expect(
        createImplementationHandoff({
          selectionFile,
          project: 'NEX',
          workspaceRoot: path.join(path.dirname(root), 'workspaces'),
          workspacePointerField: 'workspace',
          architectureStatus: 'Architecture',
          implementation: { issueType: 'Task', labels: [], status: 'To Do', linkType: 'Relates' },
          doneStatus: 'Done',
          git,
          jira,
          publish: () => undefined,
        })(),
      ).resolves.toBe('handed-off');
      expect(calls).toContain('createIssue');
      expect(status).toBe('Done');
    },
  );

  it('advances shared-document edits through Requirements, UX and Architecture without cycling', async () => {
    const { origin, root, worktree, selectionFile } = await preparationWorkspace();
    await expect(
      createPrepareStage({
        selectionFile,
        repository: { source: origin, mainBranch: 'main' },
        git,
        publish: () => undefined,
      })({ stage: 'requirements' }),
    ).resolves.toBe('prepared');
    const transitions = [
      { from: 'Draft', to: 'UX Proposal' },
      { from: 'UX Proposal', to: 'Storybook Refinement' },
      { from: 'Storybook Refinement', to: 'Architecture' },
    ];
    const authored = (plan: readonly unknown[] = []) => ({
      outcome: 'authored',
      documents: [{ path: 'readme.md' }],
      sourcePaths: [],
      plan,
      skip: null,
      question: null,
      upstream: null,
      observation: null,
    });
    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\n');
    const requirements = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 1,
      author: authored(),
    });
    const requirementsRevision = (requirements.documents as { revision: string }[])[0]!.revision;
    const requirementsAdvance = await publishStage({
      selectionFile,
      root,
      stage: 'requirements',
      status: 'Draft',
      transitions,
    });
    expect(requirementsAdvance.stage()).toBe('ux');

    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\nux revision\n');
    await acceptedRound({ selectionFile, root, stage: 'ux', round: 1, author: authored() });
    const uxAdvance = await publishStage({
      selectionFile,
      root,
      stage: 'ux',
      status: 'UX Proposal',
      transitions,
    });
    expect(uxAdvance.stage()).toBe('prototype');
    expect(uxAdvance.awaiting()).toEqual([]);
    expect(uxAdvance.returnFinding()).toBeNull();

    await acceptedRound({
      selectionFile,
      root,
      stage: 'prototype',
      round: 1,
      verdict: 'accepted-skip',
      author: {
        outcome: 'skip-proposed',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { references: ['readme.md'] },
        question: null,
        upstream: null,
        observation: null,
      },
    });
    const prototypeAdvance = await publishStage({
      selectionFile,
      root,
      stage: 'prototype',
      status: 'Storybook Refinement',
      transitions,
    });
    expect(prototypeAdvance.stage()).toBe('architecture');

    await writeFile(
      path.join(worktree, 'readme.md'),
      'requirements revision\nux revision\narchitecture revision\n',
    );
    await acceptedRound({
      selectionFile,
      root,
      stage: 'architecture',
      round: 1,
      author: authored(architecturePlan),
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
    expect(handedOff.returnFinding()).toBeNull();
    for (const stage of preparationStages) {
      expect((await readStagePlan(path.join(root, stage)))?.round).toBe(1);
      expect(
        (
          await readCurrentDecision({
            issueRoot: root,
            stage,
            selection: JSON.parse(await readFile(selectionFile, 'utf8')),
            git,
          })
        ).kind,
      ).toBe('current');
    }
    expect(await git.readFileAtRevision(worktree, requirementsRevision, 'readme.md')).toEqual({
      ok: true,
      value: 'requirements revision\n',
    });
  });

  it('evaluates the current worktree directly and never selects earlier prototype assets through skips', async () => {
    const { origin, root, worktree, selectionFile } = await preparationWorkspace();
    await createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: () => undefined,
    })({ stage: 'prototype' });
    await mkdir(path.join(worktree, 'docs'), { recursive: true });
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    await writeFile(path.join(worktree, 'docs', 'ux.md'), '# UX\n');
    const storyRevision = await commitFile(
      worktree,
      'stories/ux.stories.ts',
      'export const journey = 1;\n',
    );
    const artifacts = path.join(root, 'prototype', 'artifacts', '1');
    const authorObservation = await savePrototypeObservation({
      roundDirectory: artifacts,
      role: 'author',
      content: [{ path: 'stories/ux.stories.ts', revision: storyRevision }],
    });
    const evaluatorObservation = await savePrototypeObservation({
      roundDirectory: artifacts,
      role: 'evaluator',
      content: [{ path: 'stories/ux.stories.ts', revision: storyRevision }],
    });
    const first = await acceptedRound({
      selectionFile,
      root,
      stage: 'prototype',
      round: 1,
      author: {
        outcome: 'authored',
        documents: [{ path: 'docs/ux.md' }],
        sourcePaths: ['stories/ux.stories.ts'],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: { path: authorObservation },
      },
      evaluatorObservation,
    });
    expect(first.prototype).not.toBeNull();
    expect(first.prototypeObservations).toEqual([
      { role: 'author', path: authorObservation },
      { role: 'evaluator', path: evaluatorObservation },
    ]);

    // A reassessment skip may cite the earlier result and the story, but a citation stays readable
    // evidence: the skip neither adopts the earlier documents nor retains the prototype bundle.
    const resultReference = path.join(root, 'prototype', 'artifacts', '1', 'result.json');
    const skip = (references: readonly string[]) => ({
      outcome: 'skip-proposed',
      documents: [],
      sourcePaths: [],
      plan: [],
      skip: { references: [...references] },
      question: null,
      upstream: null,
      observation: null,
    });
    const second = await acceptedRound({
      selectionFile,
      root,
      stage: 'prototype',
      round: 2,
      route: 'reassess',
      verdict: 'accepted-skip',
      invokeAuthor: true,
      author: skip([resultReference, 'stories/ux.stories.ts#journey']),
    });
    expect(second).toMatchObject({
      outcome: 'skipped',
      documents: [],
      sourcePaths: [],
      skipReferences: [resultReference, 'stories/ux.stories.ts#journey'],
      prototype: null,
      prototypeObservations: [],
    });

    // A consecutive skip composes the same way: nothing from the earlier acceptance is inferred.
    const third = await acceptedRound({
      selectionFile,
      root,
      stage: 'prototype',
      round: 3,
      route: 'reassess',
      verdict: 'accepted-skip',
      invokeAuthor: true,
      author: skip(['docs/ux.md']),
    });
    expect(third).toMatchObject({
      outcome: 'skipped',
      documents: [],
      sourcePaths: [],
      skipReferences: ['docs/ux.md'],
      prototype: null,
      prototypeObservations: [],
    });
    await expect(
      readCurrentDecision({
        issueRoot: root,
        stage: 'prototype',
        selection: JSON.parse(await readFile(selectionFile, 'utf8')),
        git,
      }),
    ).resolves.toMatchObject({ kind: 'current' });

    // The earlier accepted revision and its evidence stay untouched in the shared checkout.
    expect(await git.readFileAtRevision(worktree, storyRevision, 'stories/ux.stories.ts')).toEqual({
      ok: true,
      value: 'export const journey = 1;\n',
    });
    await expect(readFile(authorObservation, 'utf8')).resolves.toContain('stories/ux.stories.ts');
    // The latest skip is the stage's terminal decision, so its own (empty) change set is what the
    // implementation handoff references; nothing from the earlier acceptance is inferred.
    await expect(readAcceptedDocuments(root)).resolves.toMatchObject({
      kind: 'documents',
      documents: [],
      retained: [],
    });
  });

  it('finalizes reason-only skips and treats references as readable evidence only', async () => {
    const { origin, root, worktree, selectionFile } = await preparationWorkspace();
    await createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: () => undefined,
    })({ stage: 'requirements' });
    const selection = JSON.parse(await readFile(selectionFile, 'utf8'));
    const skip = (references: readonly string[]) => ({
      outcome: 'skip-proposed',
      documents: [],
      sourcePaths: [],
      plan: [],
      skip: { references: [...references] },
      question: null,
      upstream: null,
      observation: null,
    });
    const finalize = createStageResult({
      selectionFile,
      stage: 'requirements',
      git,
      publish: () => undefined,
    });

    // A reason-only skip is valid: the reference list may be empty.
    const first = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 1,
      verdict: 'accepted-skip',
      invokeAuthor: true,
      author: skip([]),
    });
    expect(first).toMatchObject({
      outcome: 'skipped',
      documents: [],
      skipReferences: [],
      prototype: null,
    });
    await expect(
      readCurrentDecision({ issueRoot: root, stage: 'requirements', selection, git }),
    ).resolves.toMatchObject({ kind: 'current' });

    // Prose and paths naming no readable file are not evidence; the report is rejected before
    // evaluation so the author can repair it.
    await expect(
      acceptedRound({
        selectionFile,
        root,
        stage: 'requirements',
        round: 2,
        route: 'reassess',
        verdict: 'accepted-skip',
        invokeAuthor: true,
        author: skip(['docs/missing.md', 'the existing requirements suffice']),
      }),
    ).rejects.toThrow(/skip reference is unusable/);

    // A repaired skip may cite readable checkout and retained files; they stay evidence and create
    // no document binding.
    const retained = path.join(root, 'source-input.json');
    await writeFile(retained, '{}');
    const references = ['readme.md#purpose', path.join(worktree, 'readme.md'), retained];
    const second = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 2,
      route: 'reassess',
      verdict: 'accepted-skip',
      invokeAuthor: true,
      author: skip(references),
    });
    expect(second).toMatchObject({
      outcome: 'skipped',
      documents: [],
      sourcePaths: [],
      skipReferences: references,
      prototype: null,
      prototypeObservations: [],
    });
    // Uncommitted changes to cited evidence do not dirty the skip: nothing was bound to it.
    await writeFile(path.join(worktree, 'readme.md'), 'changed after the skip\n');
    await expect(
      readCurrentDecision({ issueRoot: root, stage: 'requirements', selection, git }),
    ).resolves.toMatchObject({ kind: 'current' });
    await expect(finalize({ outcome: 'skipped' })).resolves.toBe('saved');
  });

  it('finalizes the action-observed revision and reassesses a legacy evaluation', async () => {
    const { origin, root, worktree, selectionFile } = await preparationWorkspace();
    await createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: () => undefined,
    })({ stage: 'requirements' });
    const stageRoot = path.join(root, 'requirements');
    const artifacts = path.join(stageRoot, 'artifacts', '1');
    await mkdir(path.join(stageRoot, 'state'), { recursive: true });
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      path.join(stageRoot, 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'requirements',
        round: 1,
        route: 'new',
        profiles: { author: 'a', evaluator: 'e' },
      }),
    );
    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\n');
    const author = {
      outcome: 'authored',
      documents: [{ path: 'readme.md' }],
      sourcePaths: [],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      observation: null,
    };
    await createStageAuthor({
      selectionFile,
      stage: 'requirements',
      git,
      publish: () => undefined,
      runner: {
        run: async (request) => {
          await writeAssignedReport(request.context, '# requirements author report\n');
          return ok({ output: JSON.stringify(author) });
        },
      },
    })({ task: 'propose' });
    await createStageEvaluator({
      selectionFile,
      stage: 'requirements',
      git,
      publish: () => undefined,
      runner: {
        run: async (request) => {
          await writeAssignedReport(request.context, '# requirements evaluator report\n');
          return ok({
            output: JSON.stringify({
              verdict: 'accepted',
              observation: null,
              upstream: null,
            }),
          });
        },
      },
    })();
    const evaluation = stageEvaluationArtifact.schema.parse(
      JSON.parse(await readFile(path.join(artifacts, 'evaluation.json'), 'utf8')),
    );
    const observed = await headOf(worktree);
    expect(evaluation.basis.repositoryRevision).toBe(observed);

    // An unrelated commit between the observation and the finalization moves the checkout: the
    // interrupted finalization must obtain a current decision instead of publishing the stale one.
    await commitFile(worktree, 'unrelated.md', 'unrelated change\n');
    const finalize = createStageResult({
      selectionFile,
      stage: 'requirements',
      git,
      publish: () => undefined,
    });
    await expect(finalize({ outcome: 'accepted' })).rejects.toThrow(/current decision is required/);
    // The interrupted round retained no terminal result, so nothing is a current decision yet;
    // the route obtains a fresh evaluated revision before the stage can advance.
    await expect(
      readCurrentDecision({
        issueRoot: root,
        stage: 'requirements',
        selection: JSON.parse(await readFile(selectionFile, 'utf8')),
        git,
      }),
    ).resolves.toMatchObject({ kind: 'missing' });

    // A fresh reassessment records the current revision and finalizes normally.
    const reassessed = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 2,
      route: 'reassess',
      invokeAuthor: true,
      author,
    });
    expect((reassessed.documents as { revision: string }[])[0]!.revision).not.toBe(observed);

    // A legacy unfinished evaluation without the repository observation cannot be freshly
    // finalized: its required current evidence is missing, so the stage must reassess instead.
    const reassessedEvaluationFile = path.join(stageRoot, 'artifacts', '2', 'evaluation.json');
    const legacy = JSON.parse(await readFile(reassessedEvaluationFile, 'utf8')) as {
      basis: { repositoryRevision?: string };
    };
    delete legacy.basis.repositoryRevision;
    await writeFile(reassessedEvaluationFile, JSON.stringify(legacy));
    await rm(path.join(stageRoot, 'artifacts', '2', 'result.json'));
    await rm(path.join(stageRoot, 'state', 'result.json'));
    await expect(finalize({ outcome: 'accepted' })).rejects.toThrow(
      /carries no repository observation/,
    );
    await expect(
      readCurrentDecision({
        issueRoot: root,
        stage: 'requirements',
        selection: JSON.parse(await readFile(selectionFile, 'utf8')),
        git,
      }),
    ).resolves.toMatchObject({ kind: 'missing' });
  });

  it('retains declared deletions through evaluator replay and reassessment', async () => {
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
      documents: [{ path: 'readme.md' }, { path: 'legacy.md' }],
      sourcePaths: ['legacy.ts'],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      observation: null,
    };
    const first = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 1,
      author,
    });
    const revision = (first.documents as { readonly revision: string }[])[0]!.revision;
    expect(first.documents).toEqual([
      { path: path.join(worktree, 'readme.md'), revision },
      { path: path.join(worktree, 'legacy.md'), revision },
    ]);
    expect(first.sourcePaths).toEqual(['legacy.ts']);
    expect(await git.readFileAtRevision(worktree, revision, 'legacy.md')).toMatchObject({
      ok: false,
    });

    // Replaying the interrupted evaluation re-retains the already-committed deletion instead of
    // failing on the absent path.
    await expect(
      acceptedRound({ selectionFile, root, stage: 'requirements', round: 1, author }),
    ).resolves.toMatchObject({ documents: first.documents });

    // A following evaluated skip neither reuses the acceptance nor keeps the deletion: its result
    // is evidence-only and the stage's current change set is empty.
    const second = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 2,
      route: 'reassess',
      verdict: 'accepted-skip',
      invokeAuthor: true,
      author: {
        outcome: 'skip-proposed',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: {
          references: [path.join(root, 'requirements', 'artifacts', '1', 'result.json')],
        },
        question: null,
        upstream: null,
        observation: null,
      },
    });
    expect(second).toMatchObject({ documents: [], sourcePaths: [], prototype: null });
    await expect(readAcceptedDocuments(root)).resolves.toMatchObject({
      kind: 'documents',
      documents: [],
    });

    // Authored repair and reassessment keep deleting the legacy paths at each new revision.
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
      const assessed = (corrected.documents as { readonly revision: string }[])[0]!.revision;
      expect(corrected.documents).toEqual([
        { path: path.join(worktree, 'readme.md'), revision: assessed },
        { path: path.join(worktree, 'legacy.md'), revision: assessed },
      ]);
      expect(corrected.sourcePaths).toEqual(['legacy.ts']);
      expect(await git.readFileAtRevision(worktree, assessed, 'legacy.md')).toMatchObject({
        ok: false,
      });
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
          documents: [{ path: 'never-existed.md' }],
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

  it('rejects declared documents and sources deleted after evaluation', async () => {
    const { origin, source, root, worktree, selectionFile } = await preparationWorkspace();
    await publish(source, 'source.ts', 'export const value = 1;\n', 'add the stage source');
    await expect(
      createPrepareStage({
        selectionFile,
        repository: { source: origin, mainBranch: 'main' },
        git,
        publish: () => undefined,
      })({ stage: 'requirements' }),
    ).resolves.toBe('prepared');
    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\n');
    await writeFile(path.join(worktree, 'source.ts'), 'export const value = 2;\n');
    const author = {
      outcome: 'authored',
      documents: [{ path: 'readme.md' }],
      sourcePaths: ['source.ts'],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      observation: null,
    };
    await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 1,
      invokeAuthor: true,
      author,
    });
    // The saved terminal result is removed to reproduce an interrupted finalization; the
    // evaluation already observed both declared paths at its repository revision.
    await rm(path.join(root, 'requirements', 'artifacts', '1', 'result.json'));
    await rm(path.join(root, 'requirements', 'state', 'result.json'));

    // Both declarations disappear uncommitted: the evaluated revision still retains their bytes,
    // so finalization must obtain a current decision instead of accepting the deletion.
    await rm(path.join(worktree, 'readme.md'));
    await rm(path.join(worktree, 'source.ts'));
    const finalize = createStageResult({
      selectionFile,
      stage: 'requirements',
      git,
      publish: () => undefined,
    });
    await expect(finalize({ outcome: 'accepted' })).rejects.toThrow(/current decision is required/);
  });

  it('does not infer a stage\u2019s deletion ownership from another stage\u2019s deletion', async () => {
    const { origin, root, worktree, selectionFile } = await preparationWorkspace();
    await expect(
      createPrepareStage({
        selectionFile,
        repository: { source: origin, mainBranch: 'main' },
        git,
        publish: () => undefined,
      })({ stage: 'requirements' }),
    ).resolves.toBe('prepared');
    // Requirements records a modification of the tracked document and finalizes it.
    await writeFile(path.join(worktree, 'readme.md'), 'requirements revision\n');
    const requirements = {
      outcome: 'authored',
      documents: [{ path: 'readme.md' }],
      sourcePaths: [],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      observation: null,
    };
    await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 1,
      invokeAuthor: true,
      author: requirements,
    });
    // UX then deletes the same document and finalizes that deletion as its own work.
    await rm(path.join(worktree, 'readme.md'));
    await acceptedRound({
      selectionFile,
      root,
      stage: 'ux',
      round: 1,
      invokeAuthor: true,
      author: {
        ...requirements,
        documents: [{ path: 'readme.md' }],
      },
    });
    // Requirements redeclaring the absent path must not inherit UX's deletion: its retained
    // declaration recorded a file at the evaluated revision, never a deletion of its own.
    await expect(
      acceptedRound({
        selectionFile,
        root,
        stage: 'requirements',
        round: 2,
        route: 'reassess',
        invokeAuthor: true,
        author: requirements,
      }),
    ).rejects.toThrow(/was not tracked before this edit/);
  });

  it('binds an owned-document correction to the complete current file at its newly assessed revision', async () => {
    const { origin, root, worktree, selectionFile } = await preparationWorkspace();
    const prepare = createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: () => undefined,
    });
    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');
    const authored = (document: string) => ({
      outcome: 'authored',
      documents: [{ path: document }],
      sourcePaths: [],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      observation: null,
    });
    const selection = JSON.parse(await readFile(selectionFile, 'utf8'));
    const decision = (stage: 'requirements' | 'ux') =>
      readCurrentDecision({ issueRoot: root, stage, selection, git });

    // Requirements owns the document, and a downstream stage accepts its own work alongside it.
    await mkdir(path.join(worktree, 'docs'), { recursive: true });
    await writeFile(
      path.join(worktree, 'docs', 'requirements.md'),
      '# Requirements\n\nThe original scope.\n',
    );
    await gitCommand(['add', 'docs/requirements.md'], worktree);
    await gitCommand(['commit', '--quiet', '--message', 'add the requirements document'], worktree);
    await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 1,
      invokeAuthor: true,
      author: authored('docs/requirements.md'),
    });
    await writeFile(path.join(worktree, 'docs', 'ux.md'), '# UX\n\nThe accepted journey.\n');
    await gitCommand(['add', 'docs/ux.md'], worktree);
    await gitCommand(['commit', '--quiet', '--message', 'add the ux document'], worktree);
    await acceptedRound({
      selectionFile,
      root,
      stage: 'ux',
      round: 1,
      invokeAuthor: true,
      author: authored('docs/ux.md'),
    });

    // A later stage extends the earlier stage's owned document in the shared checkout.
    await writeFile(
      path.join(worktree, 'docs', 'requirements.md'),
      '# Requirements\n\nThe original scope.\n\nA later-stage addition.\n',
    );
    await gitCommand(['add', 'docs/requirements.md'], worktree);
    await gitCommand(['commit', '--quiet', '--message', 'extend the shared document'], worktree);

    // The owning stage corrects its authored work against the complete current file, preserving
    // the compatible later-stage addition; its result records the revision the new evaluation
    // assessed rather than the historical binding.
    const correctedContent =
      '# Requirements\n\nThe original scope.\n\nA later-stage addition.\n\nAn owned correction.\n';
    await writeFile(path.join(worktree, 'docs', 'requirements.md'), correctedContent);
    const corrected = await acceptedRound({
      selectionFile,
      root,
      stage: 'requirements',
      round: 2,
      route: 'reassess',
      invokeAuthor: true,
      author: authored('docs/requirements.md'),
    });
    const correctedRevision = (corrected.documents as { readonly revision: string }[])[0]!.revision;
    expect(corrected.documents).toEqual([
      { path: path.join(worktree, 'docs/requirements.md'), revision: correctedRevision },
    ]);
    expect(corrected.evaluation).toEqual({
      path: path.join(root, 'requirements', 'artifacts', '2', 'evaluation.json'),
    });
    expect(
      await git.readFileAtRevision(worktree, correctedRevision, 'docs/requirements.md'),
    ).toEqual({ ok: true, value: correctedContent });

    // The correction records a current decision without invalidating the downstream stage.
    await expect(decision('requirements')).resolves.toMatchObject({ kind: 'current' });
    await expect(decision('ux')).resolves.toMatchObject({ kind: 'current' });
  });

  it.each(['author', 'evaluator'] as const)(
    'requires fresh inspection when a document observed by the prototype %s changes',
    async (role) => {
      const { origin, root, worktree, selectionFile } = await preparationWorkspace();
      await createPrepareStage({
        selectionFile,
        repository: { source: origin, mainBranch: 'main' },
        git,
        publish: () => undefined,
      })({ stage: 'prototype' });
      await commitFiles(
        worktree,
        ['docs/journey.mdx', 'docs/shared.md'],
        'add prototype documents',
      );
      await mkdir(path.join(worktree, 'stories'), { recursive: true });
      await writeFile(path.join(worktree, 'stories/journey.ts'), 'export const journey = 1;\n');
      await gitCommand(['add', 'stories/journey.ts'], worktree);
      await gitCommand(['commit', '--quiet', '--message', 'add the story'], worktree);
      const revision = await headOf(worktree);
      const artifacts = path.join(root, 'prototype', 'artifacts', '1');
      const observation = async (observingRole: 'author' | 'evaluator') =>
        savePrototypeObservation({
          roundDirectory: artifacts,
          role: observingRole,
          content: [
            { path: 'stories/journey.ts', revision },
            ...(role === observingRole ? [{ path: 'docs/journey.mdx', revision }] : []),
          ],
        });
      await acceptedRound({
        selectionFile,
        root,
        stage: 'prototype',
        round: 1,
        author: {
          outcome: 'authored',
          documents: [{ path: 'docs/journey.mdx' }, { path: 'docs/shared.md' }],
          sourcePaths: ['stories/journey.ts'],
          plan: [],
          skip: null,
          question: null,
          upstream: null,
          observation: { path: await observation('author') },
        },
        evaluatorObservation: await observation('evaluator'),
      });
      const decision = async () =>
        readCurrentDecision({
          issueRoot: root,
          stage: 'prototype',
          selection: JSON.parse(await readFile(selectionFile, 'utf8')),
          git,
        });
      await writeFile(
        path.join(worktree, 'docs/shared.md'),
        'A compatible architecture addition.\n',
      );
      await expect(decision()).resolves.toMatchObject({ kind: 'current' });
      await writeFile(path.join(worktree, 'docs/journey.mdx'), 'A changed rendered journey.\n');
      await expect(decision()).resolves.toMatchObject({ kind: 'stale' });
    },
  );

  it('delivers two handed-off tickets through separate real-Git pull requests', async () => {
    const { origin } = await repositoryWithOrigin();
    const directory = await temporaryDirectory();
    const workspaces = path.join(directory, 'workspaces');
    const prepRoot = path.join(workspaces, 'NEX', 'NEX-1');
    const prepWorktree = path.join(prepRoot, 'worktree');
    const selectionFile = path.join(directory, 'selection.json');
    await writeFile(
      selectionFile,
      JSON.stringify({
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: { id: '1', key: 'NEX-1', fields: { summary: 'Deliver the feature' } },
        conversation: [],
        workspace: { root: prepRoot },
        stage: 'architecture',
      }),
    );

    // --- preparation: one evaluated document on the shared checkout and branch ---
    const prepareStage = createPrepareStage({
      selectionFile,
      repository: { source: origin, mainBranch: 'main' },
      git,
      publish: () => undefined,
    });
    await expect(prepareStage({ stage: 'requirements' })).resolves.toBe('prepared');
    await mkdir(path.join(prepWorktree, 'docs'), { recursive: true });
    await writeFile(
      path.join(prepWorktree, 'docs', 'requirements.md'),
      '# Requirements\n\nDeliver the feature.\n',
    );
    await gitCommand(['add', 'docs/requirements.md'], prepWorktree);
    await gitCommand(['commit', '--quiet', '--message', 'the requirements'], prepWorktree);
    await writeFile(
      path.join(prepWorktree, 'docs', 'architecture.md'),
      '# Architecture\n\nThe implementation plan.\n',
    );
    await gitCommand(['add', 'docs/architecture.md'], prepWorktree);
    await gitCommand(['commit', '--quiet', '--message', 'the architecture'], prepWorktree);
    await acceptedRound({
      selectionFile,
      root: prepRoot,
      stage: 'requirements',
      round: 1,
      invokeAuthor: true,
      author: {
        outcome: 'authored',
        documents: [{ path: 'docs/requirements.md' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
      },
    });
    await acceptedRound({
      selectionFile,
      root: prepRoot,
      stage: 'architecture',
      round: 1,
      invokeAuthor: true,
      author: {
        outcome: 'authored',
        documents: [{ path: 'docs/architecture.md' }],
        sourcePaths: [],
        plan: [
          {
            summary: 'Add the feature',
            scope: 'Implement the feature.',
            completionCriteria: ['The feature exists.'],
            prerequisites: [],
          },
          {
            summary: 'Extend the feature',
            scope: 'Extend the delivered feature.',
            completionCriteria: ['The extension exists.'],
            prerequisites: [0],
          },
        ],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
      },
    });
    const preparationBase = (
      JSON.parse(
        await readFile(path.join(prepRoot, 'parent/prepared-repository.json'), 'utf8'),
      ) as {
        readonly baseRevision: string;
      }
    ).baseRevision;

    // --- the controlled source and delivery service for the whole journey ---
    const issues = new Map<
      string,
      {
        readonly key: string;
        status: string;
        fields: Record<string, unknown>;
      }
    >();
    issues.set('1', { key: 'NEX-1', status: 'Architecture', fields: { summary: 'Source issue' } });
    const rankOrder: string[] = ['NEX-1'];
    const comments: unknown[] = [];
    const ticketIssues: { id: string; key: string }[] = [];
    const { jira } = scriptedJira({
      readIssue: (issueId) => {
        const issue = issues.get(issueId);
        if (issue === undefined) {
          return fault(`Unknown issue "${issueId}".`);
        }
        return ok({
          id: issueId,
          key: issue.key,
          fields: {
            ...issue.fields,
            status: { id: '9', name: issue.status },
          },
        });
      },
      readComments: () =>
        ok(comments as readonly { readonly id: string; readonly body: unknown }[]) as never,
      readTransitions: () =>
        ok([
          { id: 'admit', name: 'Admit', to: { id: '2', name: 'To Do' } },
          { id: 'review', name: 'Review', to: { id: '4', name: 'In Review' } },
          { id: 'done', name: 'Finish', to: { id: '5', name: 'Done' } },
        ]),
      transitionIssue: (issueId, transitionId) => {
        const issue = issues.get(issueId);
        if (issue === undefined) {
          return fault(`Unknown issue "${issueId}".`);
        }
        issue.status =
          transitionId === 'done' ? 'Done' : transitionId === 'review' ? 'In Review' : 'To Do';
        return ok(undefined);
      },
      updateFields: (issueId, updates) => {
        const issue = issues.get(issueId);
        if (issue === undefined) {
          return fault(`Unknown issue "${issueId}".`);
        }
        if (updates.workspacePointer != null) issue.fields['workspace'] = updates.workspacePointer;
        if (updates.pullRequest != null) issue.fields['pr'] = updates.pullRequest;
        return ok(undefined);
      },
      addComment: (_issueId, body) => {
        const comment = { id: `c${String(comments.length + 1)}`, body };
        comments.push(comment);
        return ok(comment);
      },
      createIssue: (fields) => {
        const number = ticketIssues.length + 2;
        const identity = { id: `10${String(number)}`, key: `NEX-${String(number)}` };
        ticketIssues.push(identity);
        issues.set(identity.id, {
          key: identity.key,
          status: 'To Do',
          fields: {
            summary: fields['summary'],
            description: fields['description'],
            labels: fields['labels'],
          },
        });
        rankOrder.push(identity.key);
        return ok(identity);
      },
      linkIssues: () => ok(undefined),
      rankIssue: () => ok(undefined),
      searchIssues: (query) => {
        if (query.query.includes('labels = ')) {
          const label = /labels = "([^"]+)"$/.exec(query.query)?.[1];
          return ok(
            [...issues.entries()]
              .filter(
                ([id, issue]) =>
                  id !== '1' &&
                  Array.isArray(issue.fields['labels']) &&
                  (issue.fields['labels'] as readonly string[]).includes(label ?? ''),
              )
              .map(([id, issue]) => ({ id, key: issue.key })),
          );
        }
        if (query.query.includes('key in (')) {
          const keys = [...query.query.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
          return ok(
            [...issues.entries()]
              .filter(([, issue]) => keys.includes(issue.key))
              .map(([id, issue]) => ({ id, key: issue.key })),
          );
        }
        return ok(
          rankOrder.map((key) => ({
            key,
            id: [...issues.entries()].find(([, issue]) => issue.key === key)?.[0] ?? '9',
          })),
        );
      },
    });

    // --- the handoff: two linked tickets, the first continuing preparation ---
    const handoff = createImplementationHandoff({
      selectionFile,
      project: 'NEX',
      workspaceRoot: workspaces,
      workspacePointerField: 'workspace',
      architectureStatus: 'Architecture',
      implementation: {
        issueType: 'Task',
        labels: ['implementation'],
        status: 'To Do',
        linkType: 'Relates',
      },
      doneStatus: 'Done',
      git,
      jira,
      publish: () => undefined,
    });
    await expect(handoff()).resolves.toBe('handed-off');
    expect(ticketIssues.map((issue) => issue.key)).toEqual(['NEX-2', 'NEX-3']);
    expect(issues.get('1')?.status).toBe('Done');
    expect(issues.get('102')?.fields['workspace']).toBe(path.join(workspaces, 'NEX', 'NEX-2'));
    expect(issues.get('103')?.fields['workspace']).toBe(path.join(workspaces, 'NEX', 'NEX-3'));

    // --- the controlled delivery service: one pull request per ticket branch, real merges ---
    const pullRequests: {
      number: number;
      url: string;
      headBranch: string;
      baseBranch: string;
      headRevision: string;
      merged: boolean;
      mergeRevision: string | null;
      autoMergeEnabled: boolean;
    }[] = [];
    const reviews: GitHubReview[] = [];
    const reviewChecks: CheckObservation[] = [];
    const branchWorktrees = new Map<string, string>();
    const repository = 'owner/repository';
    const nexusLens = { appId: 777, login: 'nexus-lens' };
    const branchHead = async (branch: string): Promise<string> =>
      headOf(branchWorktrees.get(branch) as string);
    const { github } = scriptedGitHub({
      findPullRequests: (_repository, filter) =>
        ok(
          pullRequests
            .filter((pull) => pull.headBranch === filter.branch)
            .map((pull) => ({ number: pull.number, url: pull.url })),
        ),
      readPullRequest: (_repository, number) => {
        const pull = pullRequests.find((candidate) => candidate.number === number);
        if (pull === undefined) {
          return fault(`No pull request #${String(number)} exists.`);
        }
        return ok({
          number: pull.number,
          url: pull.url,
          state: pull.merged ? 'closed' : 'open',
          merged: pull.merged,
          headBranch: pull.headBranch,
          baseBranch: pull.baseBranch,
          headRevision: pull.headRevision,
          mergeRevision: pull.mergeRevision,
          autoMergeEnabled: pull.autoMergeEnabled,
        });
      },
      createPullRequest: async (_repository, creation) => {
        const number = pullRequests.length + 1;
        const pull = {
          number,
          url: `https://github.com/${repository}/pull/${String(number)}`,
          headBranch: creation.headBranch,
          baseBranch: creation.baseBranch,
          headRevision: await branchHead(creation.headBranch),
          merged: false,
          mergeRevision: null,
          autoMergeEnabled: false,
        };
        pullRequests.push(pull);
        return ok({ number: pull.number, url: pull.url, headRevision: pull.headRevision });
      },
      updatePullRequest: async (_repository, number) => {
        const pull = pullRequests.find((candidate) => candidate.number === number);
        if (pull === undefined) {
          return fault(`No pull request #${String(number)} exists.`);
        }
        pull.headRevision = await branchHead(pull.headBranch);
        return ok({ number: pull.number, url: pull.url, headRevision: pull.headRevision });
      },
      requestAutoMerge: async (_repository, number) => {
        const pull = pullRequests.find((candidate) => candidate.number === number);
        if (pull === undefined) {
          return fault(`No pull request #${String(number)} exists.`);
        }
        pull.autoMergeEnabled = true;
        // The controlled repository performs the real fast-forward merge into main.
        await gitCommand(
          ['push', '--quiet', origin, `${pull.headBranch}:main`],
          branchWorktrees.get(pull.headBranch) as string,
        );
        pull.merged = true;
        pull.mergeRevision = (await gitCommand(['rev-parse', 'main'], origin)).trim();
        return ok(undefined);
      },
      readConversation: () => ok({ comments: [], reviews: [...reviews], reviewComments: [] }),
      publishReview: (_repository, review) => {
        const id = reviews.length + 1;
        reviews.push({
          id,
          author: nexusLens.login,
          user: { login: nexusLens.login },
          commit_id: review.revision,
          state: review.verdict === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED',
          body: review.body,
        });
        return ok({ id, url: `https://github.com/${repository}/pull/1#review` });
      },
      readChecks: (_repository, revision) =>
        ok(reviewChecks.filter((check) => check.revision === revision)),
      publishReviewCheck: (_repository, publication) => {
        const id = reviewChecks.length + 1;
        reviewChecks.push({
          id,
          revision: publication.revision,
          name: publication.name,
          producer: { id: nexusLens.appId, slug: 'nexus-lens', name: 'Nexus Lens' },
          status: 'completed',
          conclusion: publication.result,
        });
        return ok({ id });
      },
      readRequiredChecks: (_repository, number) => {
        const pull = pullRequests.find((candidate) => candidate.number === number);
        if (pull === undefined) {
          return fault(`No pull request #${String(number)} exists.`);
        }
        return ok({
          revision: pull.headRevision,
          checks: [
            {
              name: 'Nexus Lens review',
              status: 'completed',
              conclusion: 'success',
              evidenceUrl: null,
            },
          ],
        });
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

    /** Deliver one handed-off ticket through the real delivery actions and record its merge. */
    async function deliverTicket(settings: {
      readonly ticketKey: string;
      readonly issueId: string;
      readonly root: string;
      readonly expectedBranch: string;
      readonly expectedRepositoryRoot: string;
      readonly file: string;
    }): Promise<{ readonly mergeRevision: string; readonly baseRevision: string }> {
      const ticketSelectionFile = path.join(directory, `selection-${settings.ticketKey}.json`);
      await mkdir(settings.root, { recursive: true });
      await writeFile(
        ticketSelectionFile,
        JSON.stringify({
          taskKey: settings.ticketKey,
          source: { kind: 'jira', issueId: settings.issueId },
          task: {
            id: settings.issueId,
            key: settings.ticketKey,
            fields: { summary: `Ticket ${settings.ticketKey}` },
          },
          conversation: [],
          workspace: { root: settings.root },
          stage: 'delivery',
        }),
      );
      const publish = () => undefined;
      const prepare = createPrepareWorkspace({
        selectionFile: ticketSelectionFile,
        repository: { source: origin, mainBranch: 'main' },
        preparation: [],
        environment,
        git,
        runCommand: run,
        publish,
      });
      await expect(prepare()).resolves.toBe('prepared');
      const prepared = JSON.parse(
        await readFile(path.join(settings.root, 'state/prepared-workspace.json'), 'utf8'),
      ) as {
        readonly repositoryWorkspace: { readonly root: string };
        readonly branch: string;
        readonly baseRevision: string;
      };
      // Actual repository bindings: the action resolved the recorded repository workspace.
      expect(prepared.repositoryWorkspace.root).toBe(settings.expectedRepositoryRoot);
      expect(prepared.branch).toBe(settings.expectedBranch);
      const worktree = path.join(prepared.repositoryWorkspace.root, 'worktree');
      branchWorktrees.set(prepared.branch, worktree);

      await expect(
        createStartRound({
          taskKey: settings.ticketKey,
          workspace: { root: settings.root },
          developerLadder: [{ profile: 'nexus-flash', repairAllowance: 1 }],
          publish,
        })(),
      ).resolves.toBe('started');
      const developer: AgentRoleRunner = {
        async run(request) {
          expect(request.workspace.root).toBe(settings.expectedRepositoryRoot);
          await commitFile(path.join(request.workspace.root, 'worktree'), settings.file, 'work\n');
          await writeAssignedReport(request.context, `Implemented ${settings.file}.`);
          return ok({ output: JSON.stringify({ status: 'completed' }) });
        },
      };
      await expect(
        createDevelop({ selectionFile: ticketSelectionFile, runner: developer, git, publish })(),
      ).resolves.toBe('completed');
      await expect(
        createVerify({
          workspace: { root: settings.root },
          checks: [
            {
              name: 'journey check',
              command: { executable: 'bash', args: ['-c', `test -s ${settings.file}`] },
            },
          ],
          environment,
          git,
          runCommand: run,
          publish,
        })(),
      ).resolves.toBe('passed');
      await expect(
        createDeliver({
          selectionFile: ticketSelectionFile,
          repository,
          baseBranch: 'main',
          git,
          github,
          publish,
          wait: () => Promise.resolve(),
        })(),
      ).resolves.toBe('published');
      await expect(
        createPublishDeliveryReport({
          selectionFile: ticketSelectionFile,
          pullRequestField: 'pr',
          inProgressStatus: 'To Do',
          reviewStatus: 'In Review',
          jira,
          publish,
        })(),
      ).resolves.toBe('published');
      const reviewer: AgentRoleRunner = {
        async run(request) {
          expect(request.workspace.root).toBe(settings.expectedRepositoryRoot);
          await writeAssignedReport(request.context, 'The delivered revision is correct.');
          return ok({ output: JSON.stringify({ verdict: 'approved' }) });
        },
      };
      await expect(
        createReview({
          selectionFile: ticketSelectionFile,
          repository,
          reviewCheck: 'Nexus Lens review',
          nexusLens,
          reviewerProfile: 'nexus-astra',
          runner: reviewer,
          git,
          github,
          publish,
        })(),
      ).resolves.toBe('approved');
      await expect(
        createCompleteTask({
          selectionFile: ticketSelectionFile,
          repository,
          reviewCheck: 'Nexus Lens review',
          nexusLens: { appId: nexusLens.appId },
          postMergeChecks: [{ name: 'validate', workflow: 'validate.yml' }],
          completion: { pollIntervalSeconds: 0, waitLimitSeconds: 30 },
          github,
          publish,
          wait: () => Promise.resolve(),
        })(),
      ).resolves.toBe('completed');
      await expect(
        createCompleteDelivery({
          selectionFile: ticketSelectionFile,
          doneStatus: 'Done',
          reviewStatus: 'In Review',
          jira,
          publish,
        })(),
      ).resolves.toBe('completed');
      const completion = JSON.parse(
        await readFile(path.join(settings.root, 'artifacts/1/completion.json'), 'utf8'),
      ) as { readonly mergeRevision: string };
      return { mergeRevision: completion.mergeRevision, baseRevision: prepared.baseRevision };
    }

    const first = await deliverTicket({
      ticketKey: 'NEX-2',
      issueId: '102',
      root: path.join(workspaces, 'NEX', 'NEX-2'),
      expectedBranch: 'task/NEX-1',
      expectedRepositoryRoot: prepRoot,
      file: 'feature.txt',
    });
    // The first implementation continued the preparation branch and comparison base.
    expect(first.baseRevision).toBe(preparationBase);
    expect(issues.get('102')?.status).toBe('Done');

    const second = await deliverTicket({
      ticketKey: 'NEX-3',
      issueId: '103',
      root: path.join(workspaces, 'NEX', 'NEX-3'),
      expectedBranch: 'task/NEX-3',
      expectedRepositoryRoot: path.join(workspaces, 'NEX', 'NEX-3'),
      file: 'extension.txt',
    });
    expect(issues.get('103')?.status).toBe('Done');

    // Two separate pull requests, one per implementation ticket; no preparation-only or
    // aggregate publication exists.
    expect(pullRequests.map((pull) => pull.headBranch)).toEqual(['task/NEX-1', 'task/NEX-3']);
    const firstChanged = (
      await gitCommand(['diff', '--name-only', preparationBase, first.mergeRevision], prepWorktree)
    )
      .trim()
      .split('\n');
    // The first pull request publishes the preparation commits with its own implementation.
    expect(firstChanged).toContain('docs/requirements.md');
    expect(firstChanged).toContain('feature.txt');
    const secondChanged = (
      await gitCommand(
        ['diff', '--name-only', first.mergeRevision, second.mergeRevision],
        path.join(workspaces, 'NEX', 'NEX-3', 'worktree'),
      )
    )
      .trim()
      .split('\n');
    // The second pull request starts from the merged base and carries only its own work.
    expect(secondChanged).toEqual(['extension.txt']);
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
