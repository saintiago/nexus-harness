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
import { createPrepareArea } from '../src/task-engine/actions/preparation/prepare-stage/index.js';
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

  it.each([false, true])(
    'prepares the configured release base when the default branch differs (partial clone=%s)',
    async (partial) => {
      const { origin, source } = await repositoryWithOrigin();
      await gitCommand(['checkout', '-b', 'release'], source);
      const release = await commitFile(source, 'release.md', 'configured base\n');
      await gitCommand(['push', 'origin', 'release'], source);
      const directory = await temporaryDirectory();
      const root = path.join(directory, 'NEX-1');
      const worktree = path.join(root, 'requirements/worktree');
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
      if (partial) {
        await mkdir(path.dirname(worktree), { recursive: true });
        await git.cloneRepository(origin, worktree);
      }
      const prepare = createPrepareArea({
        selectionFile,
        area: 'requirements',
        repository: { source: origin, mainBranch: 'release' },
        git,
        publish: () => undefined,
      });
      await expect(prepare()).resolves.toBe('prepared');
      expect(await git.inspectRepository(worktree)).toMatchObject({
        ok: true,
        value: { branch: 'task/NEX-1-requirements', headRevision: release },
      });
      await writeFile(path.join(worktree, 'release.md'), 'retained stage work\n');
      await expect(prepare()).resolves.toBe('prepared');
      expect(await readFile(path.join(worktree, 'release.md'), 'utf8')).toBe(
        'retained stage work\n',
      );
    },
  );

  it.each(['requirements', 'prototype'] as const)(
    'retains an immutable %s revision containing uncommitted accepted content',
    async (stage) => {
      const { origin } = await repositoryWithOrigin();
      const directory = await temporaryDirectory();
      const root = path.join(directory, 'NEX-1');
      const area = path.join(root, stage);
      const worktree = path.join(area, 'worktree');
      const selectionFile = path.join(directory, 'selection.json');
      await mkdir(path.join(area, 'state'), { recursive: true });
      await mkdir(path.join(area, 'artifacts/1'), { recursive: true });
      await git.cloneRepository(origin, worktree);
      const base = await headOf(worktree);
      await git.createBranch(worktree, `task/NEX-1-${stage}`, base);
      await writeFile(path.join(worktree, 'readme.md'), 'accepted content\n');
      if (stage === 'prototype')
        await writeFile(path.join(worktree, 'stories.js'), 'accepted prototype\n');
      await writeFile(
        selectionFile,
        JSON.stringify({
          taskKey: 'NEX-1',
          source: { kind: 'jira', issueId: '1' },
          task: {},
          conversation: [],
          workspace: { root },
          stage,
        }),
      );
      await writeFile(
        path.join(area, 'state/current-round.json'),
        JSON.stringify({
          stage,
          round: 1,
          route: 'new',
          profiles: { author: 'a', evaluator: 'e' },
        }),
      );
      await writeFile(
        path.join(area, 'artifacts/1/author.json'),
        JSON.stringify({
          stage,
          revision: 1,
          outcome: 'authored',
          summary: 'Accepted work.',
          documents: [{ path: 'readme.md', description: 'accepted document' }],
          plan: [],
          skip: null,
          question: null,
          upstream: null,
          findingResponses: [],
        }),
      );
      await writeFile(
        path.join(area, 'artifacts/1/evaluation.json'),
        JSON.stringify({
          assessedRevision: 1,
          verdict: 'accepted',
          reason: 'Inspected exact content.',
          findings: [],
          priorFindings: [],
          upstream: null,
        }),
      );
      const finalize = createStageResult({ selectionFile, stage, git, publish: () => undefined });
      await expect(finalize({ outcome: 'accepted' })).resolves.toBe('saved');
      const result = JSON.parse(
        await readFile(path.join(area, 'artifacts/1/result.json'), 'utf8'),
      ) as {
        documents: { revision: string }[];
        prototype: { branch: string; revision: string } | null;
      };
      const revision = result.documents[0]?.revision;
      expect(revision).not.toBe(base);
      expect(await git.readFileAtRevision(worktree, revision as string, 'readme.md')).toEqual({
        ok: true,
        value: 'accepted content\n',
      });
      if (stage === 'prototype') {
        expect(result.prototype?.revision).toBe(revision);
        expect(await git.readFileAtRevision(worktree, revision as string, 'stories.js')).toEqual({
          ok: true,
          value: 'accepted prototype\n',
        });
      }
      await writeFile(path.join(worktree, 'readme.md'), 'later unaccepted content\n');
      await finalize({ outcome: 'accepted' });
      expect(await git.readFileAtRevision(worktree, revision as string, 'readme.md')).toEqual({
        ok: true,
        value: 'accepted content\n',
      });
    },
  );

  it('binds an evaluated skip to the existing document revision and refuses dirty evidence', async () => {
    const { origin, revision } = await repositoryWithOrigin();
    const directory = await temporaryDirectory();
    const root = path.join(directory, 'NEX-1');
    const area = path.join(root, 'architecture');
    const worktree = path.join(area, 'worktree');
    const selectionFile = path.join(directory, 'selection.json');
    await mkdir(path.join(area, 'state'), { recursive: true });
    await mkdir(path.join(area, 'artifacts/1'), { recursive: true });
    await git.cloneRepository(origin, worktree);
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
        plan: [],
        skip: { reason: 'Existing design suffices.', references: ['readme.md'] },
        question: null,
        upstream: null,
        findingResponses: [],
      }),
    );
    await writeFile(
      path.join(area, 'artifacts/1/evaluation.json'),
      JSON.stringify({
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
      'differs from its accepted repository revision',
    );
    await writeFile(path.join(worktree, 'readme.md'), 'initial\n');
    await expect(finalize({ outcome: 'skipped' })).resolves.toBe('saved');
    const result = JSON.parse(
      await readFile(path.join(area, 'artifacts/1/result.json'), 'utf8'),
    ) as { existingDocuments: unknown; skipReferences: unknown };
    expect(result.existingDocuments).toEqual([
      { path: path.join(worktree, 'readme.md'), revision },
    ]);
    expect(result.skipReferences).toEqual(['readme.md']);
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
