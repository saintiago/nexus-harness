/**
 * Preflight, run directories and preparation.
 *
 * The source a run may start from, the run directory it reserves, the working
 * copy it prepares and the change report it leaves behind — all against real
 * local Git repositories in temporary directories. The retention and
 * branch-recovery guarantees live beside this file in
 * tests/workspace-branch.test.ts.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { taskSchema } from '../src/config/schema.js';
import { inspectWorkspaceChanges } from '../src/workspace/changes.js';

import { prepareWorkspace } from '../src/workspace/prepare.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import type { SourcePreflight } from '../src/workspace/preflight.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';

import { runProcess, useFixtureLifecycle } from './fixtures/lifecycle.js';
import { createTempDir, repoRoot } from './support.js';
import {
  gitOrFail,
  type Fixture,
  createRepository,
  headOf,
  readTree,
  snapshotRepository,
  expectWorkspaceError,
  expectRejected,
  expectNoOutputLocation,
  accepted,
  createAlias,
  tsxLoader,
  readCheckedOutTree,
  taskBounds,
  prepareRun,
} from './fixtures/workspace.js';
import { beginFixtureGitEnvironment } from './fixtures/workspace.js';

useFixtureLifecycle();

beforeEach(beginFixtureGitEnvironment);

describe('a clean source repository', () => {
  it('returns the real repository root and the exact committed HEAD', async () => {
    const fixture = await createRepository();

    const result = await accepted({ repoPath: fixture.repo, workDir: fixture.workDir });

    expect(result.sourceRoot).toBe(realpathSync.native(fixture.repo));
    expect(result.baseCommit).toBe(await headOf(fixture.repo));
    expect(result.baseCommit).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('resolves the repository root when pointed inside the repository', async () => {
    const fixture = await createRepository();
    const nested = path.join(fixture.repo, 'src', 'nested');
    await mkdir(nested, { recursive: true });

    const result = await accepted({ repoPath: nested, workDir: fixture.workDir });

    expect(result.sourceRoot).toBe(realpathSync.native(fixture.repo));
    expect(result.baseCommit).toBe(await headOf(fixture.repo));
  });

  it('accepts a clean detached checkout', async () => {
    const fixture = await createRepository();
    await gitOrFail(['checkout', '--quiet', '--detach'], fixture.repo);

    const result = await accepted({ repoPath: fixture.repo, workDir: fixture.workDir });

    expect(result.sourceRoot).toBe(realpathSync.native(fixture.repo));
    expect(result.baseCommit).toBe(await headOf(fixture.repo));
  });

  it('ignores files excluded by .gitignore', async () => {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, 'ignored.txt'), 'local noise\n', 'utf8');
    await mkdir(path.join(fixture.repo, 'ignored-tree'));
    await writeFile(path.join(fixture.repo, 'ignored-tree', 'cache.bin'), 'noise\n', 'utf8');

    const result = await accepted({ repoPath: fixture.repo, workDir: fixture.workDir });

    expect(result.baseCommit).toBe(await headOf(fixture.repo));
    expect((await gitOrFail(['status', '--porcelain'], fixture.repo)).trim()).toBe('');
  });

  it('allocates no run directory', async () => {
    const fixture = await createRepository();
    const before = (await readdir(fixture.parent)).sort();

    await accepted({ repoPath: fixture.repo, workDir: fixture.workDir });
    await expectRejected({ repoPath: fixture.repo, workDir: fixture.parent }, /inside/);

    expectNoOutputLocation(fixture.workDir);
    expect((await readdir(fixture.parent)).sort()).toEqual(before);
  });

  it('resolves relative paths from the invocation directory, not this one', async () => {
    const fixture = await createRepository();
    const moduleUrl = pathToFileURL(path.join(repoRoot, 'src', 'workspace', 'preflight.ts')).href;
    const script = [
      `const { preflightSource } = await import(${JSON.stringify(moduleUrl)});`,
      `const result = await preflightSource({ repoPath: 'repo', workDir: 'runs' });`,
      `process.stdout.write(JSON.stringify(result));`,
    ].join('\n');

    const result = await runProcess(
      process.execPath,
      ['--import', tsxLoader(), '--input-type=module', '--eval', script],
      { cwd: fixture.parent },
    );

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout) as SourcePreflight).toEqual({
      sourceRoot: realpathSync.native(fixture.repo),
      baseCommit: await headOf(fixture.repo),
    });
  });
});

describe('a source that cannot be used', () => {
  it('rejects a directory that is not a Git repository', async () => {
    const parent = await createTempDir();
    const plain = path.join(parent, 'plain');
    const workDir = path.join(parent, 'runs');
    await mkdir(plain);

    const error = await expectRejected({ repoPath: plain, workDir }, /not inside a Git repository/);

    expect(error.message).toContain(plain);
    expectNoOutputLocation(workDir);
  });

  it('rejects a path that does not exist', async () => {
    const parent = await createTempDir();
    const absent = path.join(parent, 'absent');
    const workDir = path.join(parent, 'runs');

    const error = await expectRejected({ repoPath: absent, workDir }, /cannot be read/);

    expect(error.message).toContain(absent);
    expectNoOutputLocation(workDir);
  });

  it('rejects a bare repository without a working checkout', async () => {
    const fixture = await createRepository();
    const bare = path.join(fixture.parent, 'bare.git');
    await gitOrFail(['clone', '--quiet', '--bare', fixture.repo, bare], fixture.parent);

    const error = await expectRejected(
      { repoPath: bare, workDir: fixture.workDir },
      /bare repository/,
    );

    expect(error.message).toContain(bare);
    expectNoOutputLocation(fixture.workDir);
  });

  it('rejects a repository with no commits yet', async () => {
    const parent = await createTempDir();
    const empty = path.join(parent, 'empty');
    const workDir = path.join(parent, 'runs');
    await mkdir(empty);
    await gitOrFail(['init', '--quiet', '--initial-branch=main'], empty);

    const error = await expectRejected({ repoPath: empty, workDir }, /no committed HEAD/);

    expect(error.message).toContain(empty);
    expectNoOutputLocation(workDir);
  });
});

describe('a dirty source repository', () => {
  const dirt: ReadonlyArray<
    readonly [name: string, prepare: (repo: string) => Promise<void>, problem: RegExp]
  > = [
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
      'untracked files',
      async (repo) => {
        await writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');
      },
      /1 untracked file that is not ignored: "untracked\.txt"/,
    ],
    [
      'a staged deletion',
      async (repo) => {
        await gitOrFail(['rm', '--quiet', 'README.md'], repo);
      },
      /1 staged change: "README\.md"/,
    ],
    [
      'every kind of dirt at once',
      async (repo) => {
        await writeFile(path.join(repo, 'README.md'), 'edited\n', 'utf8');
        await writeFile(path.join(repo, 'added.txt'), 'added\n', 'utf8');
        await gitOrFail(['add', 'added.txt'], repo);
        await writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');
      },
      /staged change[\s\S]*unstaged change[\s\S]*untracked file/,
    ],
  ];

  for (const [name, prepare, problem] of dirt) {
    it(`rejects ${name}`, async () => {
      const fixture = await createRepository();
      await prepare(fixture.repo);

      const error = await expectRejected(
        { repoPath: fixture.repo, workDir: fixture.workDir },
        /not a clean checkout/,
        problem,
      );

      expect(error.message).toContain(fixture.repo);
      expect(error.message).toMatch(/never resets, stashes, cleans, or edits/);
      expectNoOutputLocation(fixture.workDir);
    });
  }

  it('fails the dirty check before it inspects the output location', async () => {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, 'untracked.txt'), 'new\n', 'utf8');

    await expectRejected({ repoPath: fixture.repo, workDir: fixture.repo }, /not a clean checkout/);
  });
});

describe('unsafe output locations', () => {
  it('rejects a workDir equal to the repository root', async () => {
    const fixture = await createRepository();

    await expectRejected(
      { repoPath: fixture.repo, workDir: fixture.repo },
      /is the source repository or lies inside it/,
    );
    // The same location written in a way that only normalization reveals.
    await expectRejected(
      { repoPath: fixture.repo, workDir: path.join(fixture.repo, '..', 'repo') },
      /is the source repository or lies inside it/,
    );

    expectNoOutputLocation(fixture.workDir);
  });

  it('rejects a workDir nested inside the repository', async () => {
    const fixture = await createRepository();
    const nested = path.join(fixture.repo, '.harness');

    await expectRejected(
      { repoPath: fixture.repo, workDir: nested },
      /is the source repository or lies inside it/,
    );

    expectNoOutputLocation(nested);
    expect((await gitOrFail(['status', '--porcelain'], fixture.repo)).trim()).toBe('');
  });

  it('rejects a workDir that contains the repository', async () => {
    const fixture = await createRepository();

    await expectRejected(
      { repoPath: fixture.repo, workDir: fixture.parent },
      /lies inside the output directory/,
    );
  });

  it('is not fooled by a sibling directory whose name shares a prefix', async () => {
    const fixture = await createRepository();
    const sibling = path.join(fixture.parent, 'repo-other');
    await mkdir(sibling);

    const result = await accepted({ repoPath: fixture.repo, workDir: sibling });

    expect(result.sourceRoot).toBe(realpathSync.native(fixture.repo));
    // A sibling that shares the prefix but does not exist yet is equally fine.
    const future = path.join(fixture.parent, 'repo-other-elsewhere');
    await expect(accepted({ repoPath: fixture.repo, workDir: future })).resolves.toBeDefined();
  });

  it('rejects a junction alias of the repository', async (context) => {
    const fixture = await createRepository();
    const alias = path.join(fixture.parent, 'alias');
    const created = await createAlias(fixture.repo, alias, 'junction');
    if (!created) {
      // Junctions need no elevation on Windows; other hosts may lack them.
      if (process.platform === 'win32') {
        throw new Error(`could not create a junction at "${alias}"`);
      }
      context.skip();
      return;
    }
    expect(realpathSync.native(alias)).toBe(realpathSync.native(fixture.repo));

    await expectRejected(
      { repoPath: fixture.repo, workDir: alias },
      /is the source repository or lies inside it/,
      /resolved from/,
    );

    // The alias is the output location: nothing may be created through it.
    expect(existsSync(path.join(fixture.repo, 'runs'))).toBe(false);
    expect((await gitOrFail(['status', '--porcelain'], fixture.repo)).trim()).toBe('');
  });

  it('rejects a not-yet-created workDir beneath a junction alias', async (context) => {
    const fixture = await createRepository();
    const alias = path.join(fixture.parent, 'alias');
    if (!(await createAlias(fixture.repo, alias, 'junction'))) {
      context.skip();
      return;
    }
    const belowAlias = path.join(alias, 'runs');

    await expectRejected(
      { repoPath: fixture.repo, workDir: belowAlias },
      /is the source repository or lies inside it/,
    );

    expectNoOutputLocation(belowAlias);
    expect(existsSync(path.join(fixture.repo, 'runs'))).toBe(false);
  });

  it('resolves the repository when it is reached through a junction', async (context) => {
    const fixture = await createRepository();
    const alias = path.join(fixture.parent, 'alias');
    if (!(await createAlias(fixture.repo, alias, 'junction'))) {
      context.skip();
      return;
    }

    const result = await accepted({ repoPath: alias, workDir: fixture.workDir });

    expect(result.sourceRoot).toBe(realpathSync.native(fixture.repo));
    await expectRejected({ repoPath: alias, workDir: alias }, /is the source repository/);
  });

  it('rejects a directory symlink alias of the repository', async (context) => {
    const fixture = await createRepository();
    const link = path.join(fixture.parent, 'linked');
    if (!(await createAlias(fixture.repo, link, 'dir'))) {
      // Directory symlinks need elevation or developer mode on Windows; the
      // junction cases above cover the alias behavior on that platform.
      expect(process.platform).toBe('win32');
      context.skip();
      return;
    }
    expect(realpathSync.native(link)).toBe(realpathSync.native(fixture.repo));

    await expectRejected({ repoPath: fixture.repo, workDir: link }, /is the source repository/);
    await expectRejected(
      { repoPath: fixture.repo, workDir: path.join(link, 'runs') },
      /is the source repository or lies inside it/,
    );
  });
});

describe('read-only preflight', () => {
  it('leaves an accepted source unchanged', async () => {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, 'ignored.txt'), 'local noise\n', 'utf8');
    const before = await snapshotRepository(fixture.repo);

    await accepted({ repoPath: fixture.repo, workDir: fixture.workDir });

    expect(await snapshotRepository(fixture.repo)).toEqual(before);
  });

  it('leaves a rejected dirty source unchanged', async () => {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, 'README.md'), 'edited\n', 'utf8');
    await writeFile(path.join(fixture.repo, 'staged.txt'), 'staged\n', 'utf8');
    await gitOrFail(['add', 'staged.txt'], fixture.repo);
    await writeFile(path.join(fixture.repo, 'untracked.txt'), 'new\n', 'utf8');
    const before = await snapshotRepository(fixture.repo);

    await expectRejected({ repoPath: fixture.repo, workDir: fixture.workDir }, /not a clean/);

    expect(await snapshotRepository(fixture.repo)).toEqual(before);
  });

  it('leaves the source unchanged when the output location is unsafe', async () => {
    const fixture = await createRepository();
    const before = await snapshotRepository(fixture.repo);

    await expectRejected(
      { repoPath: fixture.repo, workDir: path.join(fixture.repo, '.harness') },
      /lies inside it/,
    );

    expect(await snapshotRepository(fixture.repo)).toEqual(before);
  });
});

describe('an allocated run directory', () => {
  it('is new for every run and holds a workspace and a logs directory', async () => {
    const fixture = await createRepository();

    const first = await allocateRunDirectory(fixture.workDir);
    const second = await allocateRunDirectory(fixture.workDir);

    expect(first.runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    expect(second.runId).not.toBe(first.runId);
    expect(second.runDir).not.toBe(first.runDir);
    for (const run of [first, second]) {
      expect(path.relative(fixture.workDir, run.runDir)).toBe(path.join('runs', run.runId));
      // A caller with no preference gets the generated name it always had:
      // the workspace the run creates is named after the run itself.
      expect(run.workspaceId).toBe(run.runId);
      expect(run.workspacePath).toBe(path.join(fixture.workDir, 'workspaces', run.runId));
      expect(run.logsDir).toBe(path.join(run.runDir, 'logs'));
      expect(existsSync(run.logsDir)).toBe(true);
      // Allocating a directory clones nothing: that is the next step.
      expect(await readdir(run.workspacePath)).toEqual([]);
    }
    // The evidence and the work it came from are siblings, so a later attempt can
    // continue the workspace without moving or rewriting this run's report.
    expect((await readdir(fixture.workDir)).sort()).toEqual(['runs', 'workspaces']);
  });

  it('leaves a run directory that already exists alone', async () => {
    const fixture = await createRepository();
    const taken = await prepareRun(fixture);
    const before = await snapshotRepository(taken.workspacePath);

    let generated = 0;
    const next = await allocateRunDirectory(fixture.workDir, { kind: 'create' }, () => {
      generated += 1;
      return generated === 1 ? taken.runId : 'run-00000000000000-00000000';
    });

    expect(generated).toBe(2);
    expect(next.runId).toBe('run-00000000000000-00000000');
    expect(await snapshotRepository(taken.workspacePath)).toEqual(before);
  });

  it('gives up without touching anything when every generated ID is taken', async () => {
    const fixture = await createRepository();
    const taken = await prepareRun(fixture);
    const before = await snapshotRepository(taken.workspacePath);

    const error = await expectWorkspaceError(
      () => allocateRunDirectory(fixture.workDir, { kind: 'create' }, () => taken.runId),
      /no free run directory/,
      /never reused, resumed, or overwritten/,
    );

    expect(error.message).toContain(path.join(fixture.workDir, 'runs', taken.runId));
    expect(await snapshotRepository(taken.workspacePath)).toEqual(before);
    expect((await readdir(fixture.workDir)).sort()).toEqual(['runs', 'workspaces']);
  });

  it('refuses a generated name that is not a run ID, and creates nothing', async () => {
    const fixture = await createRepository();
    const sentinel = path.join(fixture.parent, 'sentinel.txt');
    await writeFile(sentinel, 'untouched\n', 'utf8');
    const before = (await readdir(fixture.parent)).sort();

    const unusable = [
      '../evil',
      'a/b',
      'a\\b',
      '$(rm -rf)',
      '"quoted"',
      'run id',
      '..',
      '.',
      '',
      'C:\\evil',
      'run.lock',
      'x'.repeat(65),
    ];
    for (const runId of unusable) {
      await expectWorkspaceError(
        () => allocateRunDirectory(fixture.workDir, { kind: 'create' }, () => runId),
        /not a usable run ID/,
      );
    }

    expect(existsSync(fixture.workDir)).toBe(false);
    expect((await readdir(fixture.parent)).sort()).toEqual(before);
    expect(await readFile(sentinel, 'utf8')).toBe('untouched\n');
  });

  it('names the workspace the way its caller prefers, and not the run', async () => {
    const fixture = await createRepository();

    const run = await allocateRunDirectory(fixture.workDir, {
      kind: 'create',
      preferredWorkspaceId: 'HARN-23',
    });

    // The ticket key is the visible name; the run keeps its generated id for its
    // own evidence, and the two are different directories.
    expect(run.workspaceId).toBe('HARN-23');
    expect(run.workspacePath).toBe(path.join(fixture.workDir, 'workspaces', 'HARN-23'));
    expect(run.runId).not.toBe('HARN-23');
    expect(path.relative(fixture.workDir, run.runDir)).toBe(path.join('runs', run.runId));
    expect(run.logsDir).toBe(path.join(run.runDir, 'logs'));
    expect(existsSync(run.logsDir)).toBe(true);
    expect(existsSync(run.workspacePath)).toBe(true);
    expect(await readdir(run.workspacePath)).toEqual([]);
    expect((await readdir(fixture.workDir)).sort()).toEqual(['runs', 'workspaces']);
  });

  it('uses the generated name when the preferred one cannot name a workspace', async () => {
    const fixture = await createRepository();
    const unusable = [
      '../evil',
      'a/b',
      'a\\b',
      '$(rm -rf)',
      'run id',
      'HARN.23',
      '..',
      '',
      'x'.repeat(65),
    ];

    for (const preferredWorkspaceId of unusable) {
      const run = await allocateRunDirectory(fixture.workDir, {
        kind: 'create',
        preferredWorkspaceId,
      });

      // A preference is never a path: a name that cannot name a workspace is
      // not used, and the run falls back to the generated name it would have had.
      expect(run.workspaceId).toBe(run.runId);
      expect(run.workspacePath).toBe(path.join(fixture.workDir, 'workspaces', run.runId));
      expect(existsSync(run.workspacePath)).toBe(true);
    }

    expect((await readdir(fixture.workDir)).sort()).toEqual(['runs', 'workspaces']);
    // A preference is never followed out of the output directory: nothing but
    // the output location itself was created beside the source repository.
    expect((await readdir(fixture.parent)).sort()).toEqual(['repo', 'runs']);
  });

  it('refuses a preferred name a directory already holds, and creates nothing else', async () => {
    const fixture = await createRepository();
    const held = path.join(fixture.workDir, 'workspaces', 'HARN-23');
    await mkdir(held, { recursive: true });
    await writeFile(path.join(held, 'PRIVATE.txt'), 'another ticket\n', 'utf8');
    const runsRoot = path.join(fixture.workDir, 'runs');

    const error = await expectWorkspaceError(
      () =>
        allocateRunDirectory(fixture.workDir, {
          kind: 'create',
          preferredWorkspaceId: 'HARN-23',
        }),
      /is already held/,
      /never overwrites or adopts/,
      /move it aside/,
    );

    // The refusal names the name it could not use, and nothing was created for
    // the run: a preferred name is refused, never replaced by another one.
    expect(error.message).toContain(held);
    expect(await readFile(path.join(held, 'PRIVATE.txt'), 'utf8')).toBe('another ticket\n');
    expect(await readdir(runsRoot)).toEqual([]);
  });

  it('refuses a preferred name only a ledger holds', async () => {
    const fixture = await createRepository();
    const ledgerPath = path.join(fixture.workDir, 'workspaces', 'HARN-23.json');
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, '{"version":1}\n', 'utf8');

    const error = await expectWorkspaceError(
      () =>
        allocateRunDirectory(fixture.workDir, {
          kind: 'create',
          preferredWorkspaceId: 'HARN-23',
        }),
      /is already held/,
    );

    expect(error.message).toContain(ledgerPath);
    expect(await readFile(ledgerPath, 'utf8')).toBe('{"version":1}\n');
    expect(await readdir(path.join(fixture.workDir, 'runs'))).toEqual([]);
  });

  it.each(['HARN-23', 'HARN-23.json'])(
    'refuses a preferred name held by a dangling link at %s',
    async (entry) => {
      const fixture = await createRepository();
      const root = path.join(fixture.workDir, 'workspaces');
      await mkdir(root, { recursive: true });
      const held = path.join(root, entry);
      const target = path.join(root, 'missing-target');
      // Junctions exercise dangling links on Windows without symlink privileges.
      await symlink(target, held, 'junction');
      const originalLink = await readlink(held);
      expect(existsSync(held)).toBe(false);

      await expectWorkspaceError(
        () =>
          allocateRunDirectory(fixture.workDir, {
            kind: 'create',
            preferredWorkspaceId: 'HARN-23',
          }),
        /is already held/,
        /move it aside/,
      );

      expect((await lstat(held)).isSymbolicLink()).toBe(true);
      expect(await readlink(held)).toBe(originalLink);
      expect(await readdir(root)).toEqual([entry]);
      expect(existsSync(target)).toBe(false);
      expect(await readdir(path.join(fixture.workDir, 'runs'))).toEqual([]);
    },
  );

  it('creates no workspace directory for a run that continues one', async () => {
    const fixture = await createRepository();

    const run = await allocateRunDirectory(fixture.workDir, {
      kind: 'reopen',
      workspaceId: 'HARN-23',
    });

    // The clone the run reopens is not allocation's to create: it only names it,
    // so a continuation adds no second directory beside the one it works in.
    expect(run.workspaceId).toBe('HARN-23');
    expect(run.workspacePath).toBe(path.join(fixture.workDir, 'workspaces', 'HARN-23'));
    expect(existsSync(run.workspacePath)).toBe(false);
    expect(existsSync(run.logsDir)).toBe(true);
    expect(await readdir(path.join(fixture.workDir, 'workspaces'))).toEqual([]);
  });
});

describe('a prepared working copy', () => {
  it('starts from the recorded committed contents on its own branch', async () => {
    const fixture = await createRepository();
    const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });

    const first = await prepareWorkspace(
      await allocateRunDirectory(fixture.workDir),
      source,
      taskBounds(),
    );
    const second = await prepareWorkspace(
      await allocateRunDirectory(fixture.workDir),
      source,
      taskBounds(),
    );

    expect(second.runId).not.toBe(first.runId);
    expect(second.branch).not.toBe(first.branch);
    for (const prepared of [first, second]) {
      expect(prepared.sourceRoot).toBe(source.sourceRoot);
      expect(prepared.baseCommit).toBe(source.baseCommit);
      expect(prepared.branch).toBe(`harness/${prepared.runId}`);
      expect(await headOf(prepared.workspacePath)).toBe(source.baseCommit);
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
      // Whether the checked-out tree looks clean to `git status` depends on the
      // line-ending settings of whoever runs it, so this file leaves that check
      // to prepareWorkspace, which reads the checkout back in the same
      // environment that wrote it.
      // A snapshot, not a second checkout of the source: nothing to push to.
      expect(await gitOrFail(['remote'], prepared.workspacePath)).toBe('');
      // A separate clone, not a linked worktree: `.git` is a real directory
      // here, where a worktree would leave a file pointing into the source.
      expect(statSync(path.join(prepared.workspacePath, '.git')).isDirectory()).toBe(true);
    }
  }, 60_000);

  it('leaves ignored local files in the source checkout', async () => {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, 'ignored.txt'), 'local noise\n', 'utf8');
    await mkdir(path.join(fixture.repo, 'ignored-tree'));
    await writeFile(path.join(fixture.repo, 'ignored-tree', 'cache.bin'), 'noise\n', 'utf8');

    const prepared = await prepareRun(fixture);

    expect(await readCheckedOutTree(prepared.workspacePath)).toEqual({
      '.gitignore': 'ignored.txt\nignored-tree/\n',
      'README.md': 'baseline\n',
    });
    expect(existsSync(path.join(prepared.workspacePath, 'ignored.txt'))).toBe(false);
    expect(existsSync(path.join(fixture.repo, 'ignored.txt'))).toBe(true);
  });

  it('keeps edits and local commits inside the clone they were made in', async () => {
    const fixture = await createRepository();
    const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
    const first = await prepareWorkspace(
      await allocateRunDirectory(fixture.workDir),
      source,
      taskBounds(),
    );
    const second = await prepareWorkspace(
      await allocateRunDirectory(fixture.workDir),
      source,
      taskBounds(),
    );
    const sourceBefore = await snapshotRepository(fixture.repo);
    const secondBefore = await snapshotRepository(second.workspacePath);

    await writeFile(path.join(first.workspacePath, 'README.md'), 'edited in run one\n', 'utf8');
    await writeFile(path.join(first.workspacePath, 'added.txt'), 'new file\n', 'utf8');
    await gitOrFail(['add', '--all'], first.workspacePath);
    await gitOrFail(['commit', '--quiet', '--message', 'run one work'], first.workspacePath);

    expect(await headOf(first.workspacePath)).not.toBe(source.baseCommit);
    expect(await snapshotRepository(fixture.repo)).toEqual(sourceBefore);
    expect(await headOf(second.workspacePath)).toBe(source.baseCommit);
    expect(await snapshotRepository(second.workspacePath)).toEqual(secondBefore);
    expect(await gitOrFail(['remote'], first.workspacePath)).toBe('');
  }, 60_000);
});

describe('preparation that cannot finish', () => {
  it('refuses a destination that already holds work, and keeps it', async () => {
    const fixture = await createRepository();
    const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
    const prepared = await prepareWorkspace(
      await allocateRunDirectory(fixture.workDir),
      source,
      taskBounds(),
    );
    await writeFile(path.join(prepared.workspacePath, 'notes.txt'), 'earlier work\n', 'utf8');
    const before = await readCheckedOutTree(prepared.workspacePath);
    const headBefore = await headOf(prepared.workspacePath);

    const error = await expectWorkspaceError(
      () => prepareWorkspace(prepared, source, taskBounds()),
      /already holds work/,
      /never resumed or overwritten/,
    );

    expect(error.message).toContain(prepared.workspacePath);
    expect(error.message).toContain(prepared.runDir);
    expect(await headOf(prepared.workspacePath)).toBe(headBefore);
    expect(await readCheckedOutTree(prepared.workspacePath)).toEqual(before);
  });

  it('keeps the run directory and names it when the clone cannot reproduce the base', async () => {
    const fixture = await createRepository();
    const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
    const run = await allocateRunDirectory(fixture.workDir);
    // An incomplete source object store: the recorded commit still resolves,
    // but its contents can no longer be written. Git 2.53 exits 0 from that
    // checkout, so only checking the result notices that nothing was written.
    const blob = (await gitOrFail(['rev-parse', 'HEAD:README.md'], fixture.repo)).trim();
    await rm(path.join(fixture.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

    const error = await expectWorkspaceError(
      () => prepareWorkspace(run, source, taskBounds()),
      /could not be cloned|does not reproduce the recorded base/,
    );

    expect(error.message).toContain(run.runId);
    expect(error.message).toContain(run.runDir);
    expect(existsSync(run.workspacePath)).toBe(true);
    expect(existsSync(run.logsDir)).toBe(true);
    expect(existsSync(path.join(run.workspacePath, 'README.md'))).toBe(false);
  });

  it('refuses a source that moved after preflight', async () => {
    const fixture = await createRepository();
    const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
    const run = await allocateRunDirectory(fixture.workDir);
    await writeFile(path.join(fixture.repo, 'later.txt'), 'later work\n', 'utf8');
    await gitOrFail(['add', '--all'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'moved on'], fixture.repo);
    const moved = await headOf(fixture.repo);
    expect(moved).not.toBe(source.baseCommit);

    const error = await expectWorkspaceError(
      () => prepareWorkspace(run, source, taskBounds()),
      /has moved since preflight/,
      /never rebased onto a commit it did not record/,
    );

    expect(error.message).toContain(source.baseCommit);
    expect(error.message).toContain(moved);
    expect(error.message).toContain(run.runDir);
    // No working copy was produced, and the recorded base was not replaced.
    expect(existsSync(path.join(run.workspacePath, '.git'))).toBe(false);
    expect(await headOf(fixture.repo)).toBe(moved);
  });
});

describe('preparation that runs out of time', () => {
  it('stops at the run deadline and keeps what it had already written', async () => {
    const fixture = await createRepository();
    const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
    const run = await allocateRunDirectory(fixture.workDir);
    const sourceBefore = await snapshotRepository(fixture.repo);

    // The run's deadline is spent as preparation works: the clock is the run's
    // own, read before each step and again for every Git invocation a step makes
    // — the source's HEAD, the clone, and removing the clone's remote, before the
    // branch step — so the first steps run with time to spare and, by the branch
    // step, there is none: that step is not started, and what the clone wrote is
    // kept.
    const start = Date.now();
    let reads = 0;
    const error = await expectWorkspaceError(
      () =>
        prepareWorkspace(run, source, {
          deadlineMs: start + 5000,
          now: () => new Date(start + (reads++ < 6 ? 0 : 60_000)),
        }),
      /task deadline passed 55000 ms/,
      /must not be reused/,
    );

    // The failure names the run it belongs to, and the working copy it left is
    // not one: the clone exists, but it is not on the run's own branch.
    expect(error.message).toContain(run.runId);
    expect(error.message).toContain(run.runDir);
    expect(existsSync(path.join(run.workspacePath, '.git'))).toBe(true);
    const branch = await gitOrFail(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      run.workspacePath,
    );
    expect(branch.trim()).not.toBe(`harness/${run.runId}`);
    // The source checkout is untouched: preparation stopped, it did not retry.
    expect(await snapshotRepository(fixture.repo)).toEqual(sourceBefore);
  }, 30_000);

  it('refuses to start a step with no task time left, and clones nothing', async () => {
    const fixture = await createRepository();
    const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
    const run = await allocateRunDirectory(fixture.workDir);
    const now = Date.now();

    const error = await expectWorkspaceError(
      () => prepareWorkspace(run, source, { deadlineMs: now - 120, now: () => new Date(now) }),
      /task deadline passed 120 ms before the destination check/,
      /not a usable working copy/,
    );

    expect(error.message).toContain(run.runDir);
    // Nothing of the clone was made, and the run directory is still there.
    expect(existsSync(path.join(run.workspacePath, '.git'))).toBe(false);
    expect(existsSync(run.logsDir)).toBe(true);
  });
});

describe('task IDs as labels', () => {
  const taskIds = [
    '../evil',
    'a/b',
    '$(rm -rf)',
    '"; rm -rf /',
    'C:\\Windows\\system32',
    'run-../../escape',
    'task with spaces',
  ];

  it('cannot decide where a run writes or what its branch is called', async () => {
    const fixture = await createRepository();
    const sentinel = path.join(fixture.parent, 'sentinel.txt');
    await writeFile(sentinel, 'untouched\n', 'utf8');
    const before = (await readdir(fixture.parent)).sort();
    const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });

    const runs: PreparedWorkspace[] = [];
    for (const id of taskIds) {
      // Every one of these is accepted task input; it stays a label.
      expect(
        taskSchema.parse({
          id,
          title: 'Title',
          description: 'Description',
          acceptanceCriteria: ['A criterion'],
        }).id,
      ).toBe(id);

      const prepared = await prepareWorkspace(
        await allocateRunDirectory(fixture.workDir),
        source,
        taskBounds(),
      );
      runs.push(prepared);

      expect(prepared.runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
      expect(path.dirname(prepared.runDir)).toBe(path.join(path.resolve(fixture.workDir), 'runs'));
      expect(prepared.branch).toBe(`harness/${prepared.runId}`);
      expect(prepared.runDir).not.toContain('evil');
      expect(await headOf(prepared.workspacePath)).toBe(source.baseCommit);
    }

    expect((await readdir(path.join(fixture.workDir, 'runs'))).sort()).toEqual(
      runs.map((prepared) => prepared.runId).sort(),
    );
    // One clone and one ledger per workspace: the clone is what a later attempt
    // reopens, the ledger is what says what it was cloned from.
    expect((await readdir(path.join(fixture.workDir, 'workspaces'))).sort()).toEqual(
      runs.flatMap((prepared) => [prepared.runId, `${prepared.runId}.json`]).sort(),
    );
    expect((await readdir(fixture.parent)).sort()).toEqual([...before, 'runs'].sort());
    expect(existsSync(path.join(fixture.parent, 'evil'))).toBe(false);
    expect(await readFile(sentinel, 'utf8')).toBe('untouched\n');
  }, 60_000);
});

/**
 * A prepared working copy holding one of every kind of change a run can leave: a
 * local commit, an edit made after that commit, a staged file, a new file Git
 * never tracked, and a deletion. The base the run recorded is the fixture's
 * committed baseline, not the commit the task made.
 */
async function prepareChangedRun(): Promise<{
  readonly fixture: Fixture;
  readonly prepared: PreparedWorkspace;
}> {
  const fixture = await createRepository();
  // A file the task removes, so the fixture has a deletion to report as well.
  await writeFile(path.join(fixture.repo, 'obsolete.txt'), 'to be removed\n', 'utf8');
  await gitOrFail(['add', '--all'], fixture.repo);
  await gitOrFail(['commit', '--quiet', '--message', 'a file the task removes'], fixture.repo);

  const prepared = await prepareRun(fixture);
  const { workspacePath } = prepared;

  // Committed by a coding turn. The two files it changed are named rather than
  // staged with `--all`: a host whose Git rewrites line endings when it checks
  // out would otherwise renormalize the files this fixture never touched, and
  // the inspection would report those honestly but distractingly as changes.
  await writeFile(path.join(workspacePath, 'committed.txt'), 'the turn committed this\n', 'utf8');
  await writeFile(path.join(workspacePath, 'README.md'), 'rewritten by the turn\n', 'utf8');
  await gitOrFail(['add', 'committed.txt', 'README.md'], workspacePath);
  await gitOrFail(['commit', '--quiet', '--message', 'the turn committed its work'], workspacePath);

  // ...then edited again, so one path carries two readings at once.
  await writeFile(path.join(workspacePath, 'README.md'), 'rewritten, then edited again\n', 'utf8');

  await writeFile(path.join(workspacePath, 'staged.txt'), 'staged, not committed\n', 'utf8');
  await gitOrFail(['add', 'staged.txt'], workspacePath);

  await writeFile(path.join(workspacePath, 'untracked.txt'), 'left behind\n', 'utf8');

  await rm(path.join(workspacePath, 'obsolete.txt'));

  return { fixture, prepared };
}

describe('what a run left in its working copy', () => {
  it('reports every kind of change against the base the run recorded', async () => {
    const { prepared } = await prepareChangedRun();

    const changes = await inspectWorkspaceChanges(prepared);
    const byPath = new Map(changes.map((entry) => [entry.path, entry]));

    // The task committed its own work, so the working copy is ahead of the base
    // the run recorded: a comparison with `HEAD` alone would report nothing here.
    expect(await headOf(prepared.workspacePath)).not.toBe(prepared.baseCommit);
    expect(prepared.baseCommit).toBe(await headOf(prepared.sourceRoot));

    // One entry per path, in path order, whatever reading saw it.
    expect(changes.map((entry) => entry.path)).toEqual([
      'README.md',
      'committed.txt',
      'obsolete.txt',
      'staged.txt',
      'untracked.txt',
    ]);

    // Committed by the turn, and only committed.
    expect(byPath.get('committed.txt')).toEqual({
      path: 'committed.txt',
      kind: 'added',
      states: ['committed'],
      categories: [],
    });
    // Committed and then edited again: both readings are kept, in reading order.
    expect(byPath.get('README.md')).toEqual({
      path: 'README.md',
      kind: 'modified',
      states: ['committed', 'unstaged'],
      categories: [],
    });
    // Staged, and not committed.
    expect(byPath.get('staged.txt')).toEqual({
      path: 'staged.txt',
      kind: 'added',
      states: ['staged'],
      categories: [],
    });
    // Never added to Git at all.
    expect(byPath.get('untracked.txt')).toEqual({
      path: 'untracked.txt',
      kind: 'added',
      states: ['untracked'],
      categories: [],
    });
    // A deletion is a change like any other, and it is not hidden by the edits.
    expect(byPath.get('obsolete.txt')).toEqual({
      path: 'obsolete.txt',
      kind: 'deleted',
      states: ['unstaged'],
      categories: [],
    });
  }, 60_000);

  it('flags test, tooling, and configuration paths and still lists the rest', async () => {
    const fixture = await createRepository();
    // Representative files of each kind a reviewer has to look at first: a CI
    // definition, an ordinary source file, a package manifest, and a build
    // configuration.
    await mkdir(path.join(fixture.repo, '.github', 'workflows'), { recursive: true });
    await writeFile(
      path.join(fixture.repo, '.github', 'workflows', 'ci.yml'),
      'on: push\n',
      'utf8',
    );
    await writeFile(path.join(fixture.repo, 'app.ts'), 'export const app = 1;\n', 'utf8');
    await writeFile(path.join(fixture.repo, 'package.json'), '{"name":"target"}\n', 'utf8');
    await writeFile(path.join(fixture.repo, 'vitest.config.ts'), 'export default {};\n', 'utf8');
    await gitOrFail(['add', '--all'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'the files the task edits'], fixture.repo);

    const prepared = await prepareRun(fixture);
    const { workspacePath } = prepared;
    await writeFile(
      path.join(workspacePath, '.github', 'workflows', 'ci.yml'),
      'on: [push, pull_request]\n',
      'utf8',
    );
    await writeFile(path.join(workspacePath, 'app.ts'), 'export const app = 2;\n', 'utf8');
    await writeFile(
      path.join(workspacePath, 'package.json'),
      '{"name":"target","version":"2"}\n',
      'utf8',
    );
    await mkdir(path.join(workspacePath, 'tests'));
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

    // The whole list is reported, flagged or not: a reviewer reads the complete
    // set of changes, and the flags only say where to start.
    expect(changes.map((entry) => [entry.path, [...entry.categories]])).toEqual([
      ['.github/workflows/ci.yml', ['tooling']],
      ['app.ts', []],
      ['package.json', ['tooling']],
      ['tests/app.test.ts', ['tests']],
      ['vitest.config.ts', ['configuration']],
    ]);
    expect(changes.filter((entry) => entry.categories.length > 0)).toHaveLength(4);
  }, 60_000);

  it('reads the working copy and the source without changing either', async () => {
    const { fixture, prepared } = await prepareChangedRun();
    const sourceBefore = await snapshotRepository(fixture.repo);
    const workspaceBefore = await snapshotRepository(prepared.workspacePath);
    const filesBefore = await readTree(prepared.workspacePath);

    const first = await inspectWorkspaceChanges(prepared);
    const second = await inspectWorkspaceChanges(prepared);

    // Reading twice says the same thing, and neither reading wrote anything: the
    // HEAD, the refs, the index, the status, and every file are as they were —
    // `git status` did not refresh the index on the way past, and the source was
    // not the one being read at all.
    expect(second).toEqual(first);
    expect(await snapshotRepository(prepared.workspacePath)).toEqual(workspaceBefore);
    expect(await readTree(prepared.workspacePath)).toEqual(filesBefore);
    expect(await snapshotRepository(fixture.repo)).toEqual(sourceBefore);
  }, 60_000);

  it('refuses to report a comparison it could not make', async () => {
    const { prepared } = await prepareChangedRun();

    // A base the working copy does not have: Git answers with an error, and an
    // empty list would claim the comparison found nothing.
    const unknownBase: PreparedWorkspace = { ...prepared, baseCommit: '0'.repeat(40) };
    const missing = await expectWorkspaceError(() => inspectWorkspaceChanges(unknownBase));
    expect(missing.message).toContain(prepared.workspacePath);
    expect(missing.message).toContain('0'.repeat(40));

    // A working copy with no repository behind it fails the same way, naming the
    // working copy and the base rather than reporting no changes.
    await rm(path.join(prepared.workspacePath, '.git'), { recursive: true, force: true });
    const gone = await expectWorkspaceError(() => inspectWorkspaceChanges(prepared));
    expect(gone.message).toContain(prepared.workspacePath);
    expect(gone.message).toContain(prepared.baseCommit);
  }, 60_000);
});
