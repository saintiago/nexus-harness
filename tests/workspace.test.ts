/**
 * The workspace boundary, against real local Git repositories in temporary
 * directories: the source a run may start from, the run directory it reserves,
 * the separate clone it prepares, and the change report it leaves behind.
 *
 * What is proved here is the contract of that boundary — read-only preflight,
 * exclusive allocation, a clone that inherits committed content only, a failure
 * that keeps what it wrote and names it, and a comparison that is never reported
 * as one that found nothing. What a run does with the result is the fast
 * suites'; the branch a retained workspace is continued on is
 * `tests/workspace-continuation.test.ts`.
 *
 * Nothing is written outside the temporary directories a case owns, and the Git
 * environment is the suite's private one, so no developer configuration, hook,
 * or identity can change what these cases observe.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../src/workspace/errors.js';
import { inspectWorkspaceChanges } from '../src/workspace/changes.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import type { SourcePreflight } from '../src/workspace/preflight.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import type { RunDirectory, WorkspacePlacement } from '../src/workspace/run-directory.js';
import {
  createRepository,
  createTempDir,
  gitOrFail,
  useIsolatedGitEnvironment,
} from './integration-support.js';
import type { RepositoryFixture } from './integration-support.js';

useIsolatedGitEnvironment();

/** The committed HEAD of a repository or working copy. */
async function headOf(repository: string): Promise<string> {
  return (await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], repository)).trim();
}

/** Everything a read-only step must not change about a repository. */
async function snapshotRepository(repository: string): Promise<{
  readonly head: string;
  readonly status: string;
  readonly index: string;
}> {
  return {
    head: await headOf(repository),
    status: await gitOrFail(['status', '--porcelain=v1', '--untracked-files=all'], repository),
    index: await gitOrFail(['ls-files', '--stage'], repository),
  };
}

/** The committed content a working copy checks out, by path. */
async function readCheckedOutTree(repository: string): Promise<Record<string, string>> {
  const listed = await gitOrFail(['ls-files', '--cached', '-z'], repository);
  const files = listed.split('\0').filter((file) => file !== '');
  const tree: Record<string, string> = {};
  for (const file of files) {
    tree[file] = await readFile(path.join(repository, file), 'utf8');
  }
  return tree;
}

/** The error a call that was expected to fail rejected with, or a failure. */
async function failureOf(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('the call was expected to fail, and it did not');
}

/** The bounds a fixture uses when the deadline is not itself the subject. */
function generousBounds(): { readonly deadlineMs: number; readonly now: () => Date } {
  const start = Date.now();
  return { deadlineMs: start + 120_000, now: () => new Date() };
}

/** The facts preflight records for one repository, refusing a broken one. */
async function preflight(fixture: RepositoryFixture): Promise<SourcePreflight> {
  return await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
}

/** A working copy prepared from one repository's recorded base. */
async function prepareRun(
  fixture: RepositoryFixture,
  placement?: WorkspacePlacement,
): Promise<PreparedWorkspace> {
  const source = await preflight(fixture);
  const run = await allocateRunDirectory(fixture.workDir, placement);
  return await prepareWorkspace(run, source, generousBounds());
}

describe('a clean source repository', () => {
  it('resolves the real repository root and the exact committed HEAD, wherever it is pointed', async () => {
    const fixture = await createRepository();
    const nested = path.join(fixture.repo, 'src', 'nested');
    await mkdir(nested, { recursive: true });
    const head = await headOf(fixture.repo);

    const atRoot = await preflight(fixture);
    const inside = await preflightSource({ repoPath: nested, workDir: fixture.workDir });

    for (const result of [atRoot, inside]) {
      expect(result.sourceRoot).toBe(realpathSync.native(fixture.repo));
      expect(result.baseCommit).toBe(head);
      expect(result.baseCommit).toMatch(/^[0-9a-f]{40,64}$/);
    }
  }, 60_000);

  it('accepts ignored local noise, and allocates nothing', async () => {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, '.gitignore'), 'ignored.txt\n', 'utf8');
    await writeFile(path.join(fixture.repo, 'ignored.txt'), 'local noise\n', 'utf8');
    await gitOrFail(['add', '.gitignore'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'ignore local noise'], fixture.repo);
    const before = await snapshotRepository(fixture.repo);
    const parentBefore = (await readdir(fixture.parent)).sort();

    const result = await preflight(fixture);

    expect(result.baseCommit).toBe(before.head);
    expect(await snapshotRepository(fixture.repo)).toEqual(before);
    // The output location is only checked: nothing is created for a run yet.
    expect(existsSync(fixture.workDir)).toBe(false);
    expect((await readdir(fixture.parent)).sort()).toEqual(parentBefore);
  }, 60_000);
});

describe('a source that cannot be used', () => {
  it('rejects a directory that is not a Git repository', async () => {
    const parent = await createTempDir();
    const plain = path.join(parent, 'plain');
    const workDir = path.join(parent, 'runs');
    await mkdir(plain);

    const error = await failureOf(() => preflightSource({ repoPath: plain, workDir }));

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toContain('not inside a Git repository');
    expect(error.message).toContain(plain);
    expect(existsSync(workDir)).toBe(false);
  }, 60_000);

  it('rejects a path that does not exist', async () => {
    const parent = await createTempDir();
    const absent = path.join(parent, 'absent');

    const error = await failureOf(() =>
      preflightSource({ repoPath: absent, workDir: path.join(parent, 'runs') }),
    );

    expect(error.message).toContain('cannot be read');
    expect(error.message).toContain(absent);
  }, 60_000);

  it('rejects a bare repository, which has no working checkout to clone', async () => {
    const fixture = await createRepository();
    const bare = path.join(fixture.parent, 'bare.git');
    await gitOrFail(['clone', '--quiet', '--bare', fixture.repo, bare], fixture.parent);

    const error = await failureOf(() =>
      preflightSource({ repoPath: bare, workDir: fixture.workDir }),
    );

    expect(error.message).toContain('bare repository');
    expect(error.message).toContain(bare);
  }, 60_000);

  it('rejects a repository with no commits yet', async () => {
    const parent = await createTempDir();
    const empty = path.join(parent, 'empty');
    await mkdir(empty);
    await gitOrFail(['init', '--quiet', '--initial-branch=main'], empty);

    const error = await failureOf(() =>
      preflightSource({ repoPath: empty, workDir: path.join(parent, 'runs') }),
    );

    expect(error.message).toContain('has no committed HEAD');
    expect(error.message).toContain(empty);
  }, 60_000);

  const dirt: ReadonlyArray<readonly [string, (repo: string) => Promise<void>, RegExp]> = [
    [
      'staged changes',
      async (repo) => {
        await writeFile(path.join(repo, 'staged.txt'), 'staged\n', 'utf8');
        await gitOrFail(['add', 'staged.txt'], repo);
      },
      /1 staged change: "staged\.txt"/,
    ],
    [
      'unstaged changes',
      async (repo) => {
        await writeFile(path.join(repo, 'README.md'), 'edited\n', 'utf8');
      },
      /1 unstaged change: "README\.md"/,
    ],
    [
      'untracked files that are not ignored',
      async (repo) => {
        await writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');
      },
      /1 untracked file that is not ignored: "untracked\.txt"/,
    ],
  ];

  for (const [name, prepareDirt, problem] of dirt) {
    it(`rejects ${name} instead of omitting them silently`, async () => {
      const fixture = await createRepository();
      await prepareDirt(fixture.repo);
      const before = await snapshotRepository(fixture.repo);

      const error = await failureOf(() => preflight(fixture));

      expect(error.message).toContain('not a clean checkout');
      expect(error.message).toMatch(problem);
      expect(error.message).toContain('never resets, stashes, cleans, or edits');
      expect(await snapshotRepository(fixture.repo)).toEqual(before);
      expect(existsSync(fixture.workDir)).toBe(false);
    }, 60_000);
  }

  it('rejects an output location that is the source repository or lies inside it', async () => {
    const fixture = await createRepository();
    const nested = path.join(fixture.repo, '.harness');

    for (const workDir of [fixture.repo, nested, path.join(fixture.repo, '..', 'repo')]) {
      const error = await failureOf(() => preflightSource({ repoPath: fixture.repo, workDir }));
      expect(error.message).toContain('is the source repository or lies inside it');
    }

    expect(existsSync(nested)).toBe(false);
    expect((await gitOrFail(['status', '--porcelain'], fixture.repo)).trim()).toBe('');
  }, 60_000);

  it('rejects an output location that contains the source repository', async () => {
    const fixture = await createRepository();

    const error = await failureOf(() =>
      preflightSource({ repoPath: fixture.repo, workDir: fixture.parent }),
    );

    expect(error.message).toContain('lies inside the output directory');
  }, 60_000);

  it('is not fooled by a junction or symbolic link alias of the repository', async (context) => {
    const fixture = await createRepository();
    const alias = path.join(fixture.parent, 'alias');
    try {
      // A junction needs no elevation on Windows; a directory symlink may, so a
      // host that refuses it is not this case's subject.
      await symlink(fixture.repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      context.skip();
      return;
    }
    expect(realpathSync.native(alias)).toBe(realpathSync.native(fixture.repo));

    const error = await failureOf(() =>
      preflightSource({ repoPath: fixture.repo, workDir: alias }),
    );
    expect(error.message).toContain('is the source repository or lies inside it');
    expect(error.message).toContain('resolved from');

    // A location that does not exist yet is judged by where it would be
    // created, so a name below the alias is refused as well.
    const below = await failureOf(() =>
      preflightSource({ repoPath: fixture.repo, workDir: path.join(alias, 'runs') }),
    );
    expect(below.message).toContain('is the source repository or lies inside it');
    expect(existsSync(path.join(fixture.repo, 'runs'))).toBe(false);
  }, 60_000);
});

describe('an allocated run directory', () => {
  it('is new for every run and holds a workspace beside its own evidence', async () => {
    const fixture = await createRepository();

    const first = await allocateRunDirectory(fixture.workDir);
    const second = await allocateRunDirectory(fixture.workDir);

    expect(first.runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    expect(second.runId).not.toBe(first.runId);
    for (const run of [first, second]) {
      expect(path.relative(fixture.workDir, run.runDir)).toBe(path.join('runs', run.runId));
      expect(run.workspaceId).toBe(run.runId);
      expect(run.workspacePath).toBe(path.join(fixture.workDir, 'workspaces', run.runId));
      expect(run.logsDir).toBe(path.join(run.runDir, 'logs'));
      expect(existsSync(run.logsDir)).toBe(true);
      // Allocating a directory clones nothing: that is preparation's step.
      expect(await readdir(run.workspacePath)).toEqual([]);
    }
    // The evidence and the work it came from are siblings, so a later attempt
    // can continue the workspace without moving this run's report.
    expect((await readdir(fixture.workDir)).sort()).toEqual(['runs', 'workspaces']);
  }, 60_000);

  it('never reuses a taken name, and gives up without touching anything', async () => {
    const fixture = await createRepository();
    const first = await allocateRunDirectory(fixture.workDir);
    const held = path.join(fixture.workDir, 'workspaces', first.workspaceId);
    const before = await readdir(fixture.workDir, { recursive: true });

    let generated = 0;
    const next = await allocateRunDirectory(fixture.workDir, { kind: 'create' }, () => {
      generated += 1;
      return generated === 1 ? first.runId : 'run-00000000000000-00000000';
    });
    expect(generated).toBe(2);
    expect(next.runId).toBe('run-00000000000000-00000000');
    // The directory that already existed was left exactly as it was.
    expect(await readdir(held)).toEqual([]);

    const error = await failureOf(() =>
      allocateRunDirectory(fixture.workDir, { kind: 'create' }, () => first.runId),
    );
    expect(error.message).toContain('no free run directory');
    expect(error.message).toContain('never reused, resumed, or overwritten');
    expect((await readdir(fixture.workDir)).sort()).toEqual(['runs', 'workspaces']);
    // Nothing that was already there was removed to make room.
    for (const kept of [runDirOf(first), runDirOf(next)]) {
      expect(existsSync(kept)).toBe(true);
    }
    expect(await readdir(held)).toEqual([]);
    expect((await readdir(path.join(fixture.workDir, 'workspaces'))).sort()).toEqual(
      [first.workspaceId, next.workspaceId].sort(),
    );
    expect(before.length).toBeGreaterThan(0);
  }, 60_000);

  it('refuses a generated name that is not a run ID, and creates nothing', async () => {
    const fixture = await createRepository();
    const unusable = [
      '../evil',
      'a/b',
      'a\\b',
      '$(rm -rf)',
      'run id',
      '..',
      '.',
      '',
      'x'.repeat(65),
    ];

    for (const runId of unusable) {
      const error = await failureOf(() =>
        allocateRunDirectory(fixture.workDir, { kind: 'create' }, () => runId),
      );
      expect(error.message).toContain('is not a usable run ID');
    }

    // Task text never decides where a run writes.
    expect(existsSync(fixture.workDir)).toBe(false);
  }, 60_000);

  it('names the workspace the way its caller prefers, and refuses a name that is held', async () => {
    const fixture = await createRepository();

    const run = await allocateRunDirectory(fixture.workDir, {
      kind: 'create',
      preferredWorkspaceId: 'HARN-23',
    });

    // The ticket key is the visible name; the run keeps its own generated id.
    expect(run.workspaceId).toBe('HARN-23');
    expect(run.workspacePath).toBe(path.join(fixture.workDir, 'workspaces', 'HARN-23'));
    expect(run.runId).not.toBe('HARN-23');
    expect(existsSync(run.workspacePath)).toBe(true);

    const error = await failureOf(() =>
      allocateRunDirectory(fixture.workDir, { kind: 'create', preferredWorkspaceId: 'HARN-23' }),
    );
    expect(error.message).toContain('already held');
    expect(error.message).toContain('never overwrites or adopts an existing workspace');

    // Nothing here is overwritten or renamed: the held directory is untouched.
    expect(await readdir(run.workspacePath)).toEqual([]);
  }, 60_000);

  it('refuses a name only a ledger holds, and keeps that record as it was', async () => {
    const parent = await createTempDir();
    const workDir = path.join(parent, 'runs');
    const workspacesRoot = path.join(workDir, 'workspaces');
    const ledgerPath = path.join(workspacesRoot, 'HARN-23.json');
    await mkdir(workspacesRoot, { recursive: true });
    await writeFile(ledgerPath, '{"version":1}\n', 'utf8');

    // The clone is gone but the record beside its name is not, so the name is
    // still held: allocation refuses it rather than replace a record that says
    // a workspace belongs here.
    const error = await failureOf(() =>
      allocateRunDirectory(workDir, { kind: 'create', preferredWorkspaceId: 'HARN-23' }),
    );

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toContain('already held');
    expect(error.message).toContain(ledgerPath);
    // The record keeps its bytes, and no workspace or run evidence was created
    // for the refused run.
    expect(await readFile(ledgerPath, 'utf8')).toBe('{"version":1}\n');
    expect(await readdir(workspacesRoot)).toEqual(['HARN-23.json']);
    expect(await readdir(path.join(workDir, 'runs'))).toEqual([]);
  }, 60_000);

  it.each(['HARN-23', 'HARN-23.json'])(
    'refuses a name a dangling link holds at %s, leaving the link alone',
    async (entry) => {
      const parent = await createTempDir();
      const workDir = path.join(parent, 'runs');
      const workspacesRoot = path.join(workDir, 'workspaces');
      await mkdir(workspacesRoot, { recursive: true });
      const held = path.join(workspacesRoot, entry);
      const target = path.join(workspacesRoot, 'missing-target');
      // A junction needs no privilege on Windows, and is an ordinary symbolic
      // link elsewhere; either way the link dangles. A link holds its name even
      // when its target is gone, so allocation checks the name itself rather
      // than what it points at.
      await symlink(target, held, 'junction');
      const linkTarget = await readlink(held);
      expect(existsSync(held)).toBe(false);

      const error = await failureOf(() =>
        allocateRunDirectory(workDir, { kind: 'create', preferredWorkspaceId: 'HARN-23' }),
      );

      expect(error).toBeInstanceOf(WorkspaceError);
      expect(error.message).toContain('already held');
      // The link is untouched — still a link, still pointing where it did — and
      // its missing target was not created to make room for a workspace.
      expect((await lstat(held)).isSymbolicLink()).toBe(true);
      expect(await readlink(held)).toBe(linkTarget);
      expect(existsSync(target)).toBe(false);
      expect(await readdir(workspacesRoot)).toEqual([entry]);
      expect(await readdir(path.join(workDir, 'runs'))).toEqual([]);
    },
    60_000,
  );

  it('creates no workspace for a run that continues one', async () => {
    const fixture = await createRepository();

    const run = await allocateRunDirectory(fixture.workDir, {
      kind: 'reopen',
      workspaceId: 'HARN-23',
    });

    expect(run.workspaceId).toBe('HARN-23');
    expect(run.workspacePath).toBe(path.join(fixture.workDir, 'workspaces', 'HARN-23'));
    // The clone already exists in this case; allocation only names it.
    expect(existsSync(run.workspacePath)).toBe(false);
    expect(existsSync(run.logsDir)).toBe(true);
  }, 60_000);

  it('refuses an output location that cannot hold a run, and leaves it as it was', async () => {
    const parent = await createTempDir();
    const file = path.join(parent, 'not-a-directory');
    await writeFile(file, 'a file, not an output location\n', 'utf8');

    const error = await failureOf(() => allocateRunDirectory(file));

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toContain('cannot be created');
    expect(error.message).toContain(file);
    expect(await readFile(file, 'utf8')).toBe('a file, not an output location\n');
    expect((await readdir(parent)).sort()).toEqual(['not-a-directory']);
  }, 60_000);
});

/** A run's own evidence directory, derived the way the layout defines it. */
function runDirOf(run: RunDirectory): string {
  return path.join(run.workDir, 'runs', run.runId);
}

describe('a prepared working copy', () => {
  it('is a separate clone of the recorded base, on the workspace’s own branch', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);

    expect(prepared.continued).toBe(false);
    expect(prepared.attempt).toBe(1);
    expect(prepared.branch).toBe(`harness/${prepared.runId}`);
    expect(prepared.sourceRoot).toBe(realpathSync.native(fixture.repo));
    expect(prepared.baseCommit).toBe(await headOf(fixture.repo));
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
    expect(
      (
        await gitOrFail(['symbolic-ref', '--quiet', '--short', 'HEAD'], prepared.workspacePath)
      ).trim(),
    ).toBe(prepared.branch);
    expect(await gitOrFail(['ls-files', '--stage'], prepared.workspacePath)).toBe(
      await gitOrFail(['ls-files', '--stage'], fixture.repo),
    );
    expect(await readCheckedOutTree(prepared.workspacePath)).toEqual(
      await readCheckedOutTree(fixture.repo),
    );
    // A snapshot, not a second checkout of the source: nothing to push to, and a
    // real `.git` directory where a linked worktree would leave a file.
    expect(await gitOrFail(['remote'], prepared.workspacePath)).toBe('');
    expect(statSync(path.join(prepared.workspacePath, '.git')).isDirectory()).toBe(true);
    // The ledger is written beside the clone before anything runs in it.
    expect(
      existsSync(path.join(fixture.workDir, 'workspaces', `${prepared.workspaceId}.json`)),
    ).toBe(true);
  }, 90_000);

  it('inherits committed content only, and leaves ignored local files in the source', async () => {
    const fixture = await createRepository();
    await mkdir(path.join(fixture.repo, 'ignored-tree'));
    await writeFile(path.join(fixture.repo, '.gitignore'), 'ignored.txt\nignored-tree/\n', 'utf8');
    await writeFile(path.join(fixture.repo, 'ignored.txt'), 'local noise\n', 'utf8');
    await writeFile(path.join(fixture.repo, 'ignored-tree', 'cache.bin'), 'noise\n', 'utf8');
    await gitOrFail(['add', '.gitignore'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'ignore local noise'], fixture.repo);

    const prepared = await prepareRun(fixture);

    expect(await readCheckedOutTree(prepared.workspacePath)).toEqual({
      '.gitignore': 'ignored.txt\nignored-tree/\n',
      'README.md': 'baseline\n',
    });
    expect(existsSync(path.join(prepared.workspacePath, 'ignored.txt'))).toBe(false);
    expect(existsSync(path.join(fixture.repo, 'ignored.txt'))).toBe(true);
  }, 90_000);

  it('keeps a turn’s edits and local commits inside the clone they were made in', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    const sourceBefore = await snapshotRepository(fixture.repo);

    await writeFile(path.join(prepared.workspacePath, 'added.txt'), 'new file\n', 'utf8');
    await gitOrFail(['add', '--all'], prepared.workspacePath);
    await gitOrFail(
      ['commit', '--quiet', '--message', 'the turn’s own commit'],
      prepared.workspacePath,
    );

    expect(await headOf(prepared.workspacePath)).not.toBe(prepared.baseCommit);
    expect(await snapshotRepository(fixture.repo)).toEqual(sourceBefore);
    expect(await gitOrFail(['remote'], prepared.workspacePath)).toBe('');
  }, 90_000);
});

describe('preparation that cannot finish', () => {
  it('refuses a destination that already holds work, and keeps it', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    await writeFile(path.join(prepared.workspacePath, 'notes.txt'), 'earlier work\n', 'utf8');
    const headBefore = await headOf(prepared.workspacePath);
    const source = await preflight(fixture);

    const error = await failureOf(() => prepareWorkspace(prepared, source, generousBounds()));

    expect(error.message).toContain('already holds work');
    expect(error.message).toContain('never resumed or overwritten');
    expect(error.message).toContain(prepared.workspacePath);
    expect(error.message).toContain(prepared.runDir);
    expect(await headOf(prepared.workspacePath)).toBe(headBefore);
    expect(await readFile(path.join(prepared.workspacePath, 'notes.txt'), 'utf8')).toBe(
      'earlier work\n',
    );
  }, 90_000);

  it('keeps the run directory and names it when the clone cannot reproduce the base', async () => {
    const fixture = await createRepository();
    const source = await preflight(fixture);
    const run = await allocateRunDirectory(fixture.workDir);
    // An incomplete source object store, damaged after preflight: the recorded
    // commit and its tree still resolve, but the blob they name can no longer be
    // written. This host's Git transfers it to the clone and then exits 0 from a
    // checkout that materializes nothing at all, so what refuses the clone is the
    // check of what the working copy really holds — a Git that notices the
    // missing blob while transferring the clone refuses it there instead.
    const blob = (await gitOrFail(['rev-parse', 'HEAD:README.md'], fixture.repo)).trim();
    await rm(path.join(fixture.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

    const error = await failureOf(() => prepareWorkspace(run, source, generousBounds()));

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toMatch(
      /does not reproduce the recorded base|could not be cloned|could not be created/,
    );
    // The refusal belongs to this run, and names the evidence it kept.
    expect(error.message).toContain(run.runId);
    expect(error.message).toContain(run.runDir);
    expect(existsSync(run.runDir)).toBe(true);
    expect(existsSync(run.logsDir)).toBe(true);
    // The incomplete clone is not a working copy: the base's file is not in it,
    // and no ledger adopts it as a workspace a later turn could continue.
    expect(existsSync(path.join(run.workspacePath, 'README.md'))).toBe(false);
    expect(existsSync(path.join(fixture.workDir, 'workspaces', `${run.workspaceId}.json`))).toBe(
      false,
    );
  }, 90_000);

  it('refuses a source that moved after preflight, instead of rebasing onto it', async () => {
    const fixture = await createRepository();
    const source = await preflight(fixture);
    const run = await allocateRunDirectory(fixture.workDir);
    await writeFile(path.join(fixture.repo, 'later.txt'), 'later work\n', 'utf8');
    await gitOrFail(['add', '--all'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'moved on'], fixture.repo);
    const moved = await headOf(fixture.repo);
    expect(moved).not.toBe(source.baseCommit);

    const error = await failureOf(() => prepareWorkspace(run, source, generousBounds()));

    expect(error.message).toContain('has moved since preflight');
    expect(error.message).toContain(source.baseCommit);
    expect(error.message).toContain(moved);
    expect(error.message).toContain(run.runDir);
    // No working copy was produced, and the recorded base was not replaced.
    expect(existsSync(path.join(run.workspacePath, '.git'))).toBe(false);
    expect(await headOf(fixture.repo)).toBe(moved);
  }, 90_000);

  it('refuses to start a step with no task time left, and clones nothing', async () => {
    const fixture = await createRepository();
    const source = await preflight(fixture);
    const run = await allocateRunDirectory(fixture.workDir);
    const now = Date.now();

    const error = await failureOf(() =>
      prepareWorkspace(run, source, { deadlineMs: now - 120, now: () => new Date(now) }),
    );

    expect(error.message).toContain('task deadline passed 120 ms before the destination check');
    expect(error.message).toContain(run.runDir);
    expect(error.message).toContain('must not be reused');
    expect(existsSync(path.join(run.workspacePath, '.git'))).toBe(false);
    expect(existsSync(run.logsDir)).toBe(true);
  }, 90_000);

  it('refuses to start a step once the run was stopped, and keeps what it wrote', async () => {
    const fixture = await createRepository();
    const source = await preflight(fixture);
    const run = await allocateRunDirectory(fixture.workDir);
    const controller = new AbortController();
    controller.abort();

    const error = await failureOf(() =>
      prepareWorkspace(run, source, {
        ...generousBounds(),
        stop: controller.signal,
      }),
    );

    expect(error.message).toContain('stopped by its caller before the destination check');
    expect(error.message).toContain('must not be reused');
    expect(existsSync(run.runDir)).toBe(true);
    expect(existsSync(path.join(run.workspacePath, '.git'))).toBe(false);
  }, 90_000);
});

describe('what a run left in its working copy', () => {
  /** One of every kind of change a run can leave, against the recorded base. */
  async function prepareChangedRun(): Promise<PreparedWorkspace> {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, 'obsolete.txt'), 'to be removed\n', 'utf8');
    await gitOrFail(['add', '--all'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'a file the task removes'], fixture.repo);

    const prepared = await prepareRun(fixture);
    const { workspacePath } = prepared;
    await writeFile(path.join(workspacePath, 'committed.txt'), 'the turn committed this\n', 'utf8');
    await writeFile(path.join(workspacePath, 'README.md'), 'rewritten by the turn\n', 'utf8');
    await gitOrFail(['add', 'committed.txt', 'README.md'], workspacePath);
    await gitOrFail(
      ['commit', '--quiet', '--message', 'the turn committed its work'],
      workspacePath,
    );
    await writeFile(
      path.join(workspacePath, 'README.md'),
      'rewritten, then edited again\n',
      'utf8',
    );
    await writeFile(path.join(workspacePath, 'staged.txt'), 'staged, not committed\n', 'utf8');
    await gitOrFail(['add', 'staged.txt'], workspacePath);
    await writeFile(path.join(workspacePath, 'untracked.txt'), 'left behind\n', 'utf8');
    await rm(path.join(workspacePath, 'obsolete.txt'));
    return prepared;
  }

  it('reports every kind of change against the base the run recorded', async () => {
    const prepared = await prepareChangedRun();

    const changes = await inspectWorkspaceChanges(prepared);
    const byPath = new Map(changes.map((entry) => [entry.path, entry]));

    // The turn committed its own work, so the working copy is ahead of the
    // recorded base: a comparison with HEAD alone would report nothing here.
    expect(await headOf(prepared.workspacePath)).not.toBe(prepared.baseCommit);
    expect(changes.map((entry) => entry.path)).toEqual([
      'README.md',
      'committed.txt',
      'obsolete.txt',
      'staged.txt',
      'untracked.txt',
    ]);
    expect(byPath.get('committed.txt')).toEqual({
      path: 'committed.txt',
      kind: 'added',
      states: ['committed'],
      categories: [],
    });
    expect(byPath.get('README.md')).toEqual({
      path: 'README.md',
      kind: 'modified',
      states: ['committed', 'unstaged'],
      categories: [],
    });
    expect(byPath.get('staged.txt')).toEqual({
      path: 'staged.txt',
      kind: 'added',
      states: ['staged'],
      categories: [],
    });
    expect(byPath.get('untracked.txt')).toEqual({
      path: 'untracked.txt',
      kind: 'added',
      states: ['untracked'],
      categories: [],
    });
    expect(byPath.get('obsolete.txt')).toEqual({
      path: 'obsolete.txt',
      kind: 'deleted',
      states: ['unstaged'],
      categories: [],
    });
  }, 90_000);

  it('flags the paths a reviewer has to look at first, and lists the rest', async () => {
    const fixture = await createRepository();
    await mkdir(path.join(fixture.repo, '.github', 'workflows'), { recursive: true });
    await writeFile(
      path.join(fixture.repo, '.github', 'workflows', 'ci.yml'),
      'on: push\n',
      'utf8',
    );
    await writeFile(path.join(fixture.repo, 'app.ts'), 'export const app = 1;\n', 'utf8');
    await writeFile(path.join(fixture.repo, 'vitest.config.ts'), 'export default {};\n', 'utf8');
    await gitOrFail(['add', '--all'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'the files the task edits'], fixture.repo);

    const prepared = await prepareRun(fixture);
    const { workspacePath } = prepared;
    await writeFile(
      path.join(workspacePath, '.github', 'workflows', 'ci.yml'),
      'on: [push]\n',
      'utf8',
    );
    await writeFile(path.join(workspacePath, 'app.ts'), 'export const app = 2;\n', 'utf8');
    await mkdir(path.join(workspacePath, 'tests'), { recursive: true });
    await writeFile(
      path.join(workspacePath, 'tests', 'app.test.ts'),
      'export const test = 1;\n',
      'utf8',
    );
    await writeFile(
      path.join(workspacePath, 'vitest.config.ts'),
      'export default { test: {} };\n',
      'utf8',
    );

    const changes = await inspectWorkspaceChanges(prepared);

    expect(changes.map((entry) => [entry.path, [...entry.categories]])).toEqual([
      ['.github/workflows/ci.yml', ['tooling']],
      ['app.ts', []],
      ['tests/app.test.ts', ['tests']],
      ['vitest.config.ts', ['configuration']],
    ]);
  }, 90_000);

  it('reads the working copy and the source without changing either', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    await writeFile(path.join(prepared.workspacePath, 'left.txt'), 'left behind\n', 'utf8');
    const sourceBefore = await snapshotRepository(fixture.repo);
    const workspaceBefore = await snapshotRepository(prepared.workspacePath);
    const filesBefore = await readCheckedOutTree(prepared.workspacePath);

    const first = await inspectWorkspaceChanges(prepared);
    const second = await inspectWorkspaceChanges(prepared);

    // Reading twice says the same thing, and neither reading wrote anything:
    // HEAD, the refs, the index, the status, and every file are as they were.
    expect(second).toEqual(first);
    expect(await snapshotRepository(prepared.workspacePath)).toEqual(workspaceBefore);
    expect(await readCheckedOutTree(prepared.workspacePath)).toEqual(filesBefore);
    expect(await snapshotRepository(fixture.repo)).toEqual(sourceBefore);
  }, 90_000);

  it('refuses to report a comparison it could not make', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);

    // A base the working copy does not have: an empty list would claim the
    // comparison found nothing.
    const missing = await failureOf(() =>
      inspectWorkspaceChanges({ ...prepared, baseCommit: '0'.repeat(40) }),
    );
    expect(missing.message).toContain(prepared.workspacePath);
    expect(missing.message).toContain('0'.repeat(40));

    // A working copy with no repository behind it fails the same way.
    await rm(path.join(prepared.workspacePath, '.git'), { recursive: true, force: true });
    const gone = await failureOf(() => inspectWorkspaceChanges(prepared));
    expect(gone.message).toContain(prepared.workspacePath);
    expect(gone.message).toContain(prepared.baseCommit);
  }, 90_000);
});
