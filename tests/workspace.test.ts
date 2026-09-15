/**
 * Preflight, run-directory, and working-copy tests. Fixtures are real local Git
 * repositories in temporary directories, inspected through real child
 * processes: no network, no credentials, and nothing outside those temporary
 * directories is written or removed. See docs/tasks.md T01, T02, and T08 for the
 * acceptance criteria.
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskSchema } from '../src/config.js';
import {
  WorkspaceError,
  allocateRunDirectory,
  prepareWorkspace,
  preflightSource,
} from '../src/workspace.js';
import type {
  PreparedWorkspace,
  PreflightRequest,
  PrepareWorkspaceBounds,
  SourcePreflight,
} from '../src/workspace.js';
import { cleanupTempDirectories, createTempDir, repoRoot } from './support.js';

afterEach(cleanupTempDirectories);

/**
 * A private Git environment for the fixtures: the developer's own hooks,
 * signing, ignore rules, and identity must not change what the tests observe.
 */
let fixtureEnvironment: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  const directory = await createTempDir();
  const emptyConfig = path.join(directory, 'empty.gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  fixtureEnvironment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: 'Harness Test',
    GIT_AUTHOR_EMAIL: 'harness@example.test',
    GIT_COMMITTER_NAME: 'Harness Test',
    GIT_COMMITTER_EMAIL: 'harness@example.test',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
});

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Runs `git` with literal arguments in the fixture environment. */
function git(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return runProcess('git', args, { cwd, env: fixtureEnvironment });
}

/** Runs `git` and fails the test when it does not succeed. */
async function gitOrFail(args: readonly string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

interface Fixture {
  /** Temporary directory holding the repository and the output locations. */
  readonly parent: string;
  /** The source repository. */
  readonly repo: string;
  /** A safe output directory, which does not exist yet. */
  readonly workDir: string;
}

/** A temporary repository whose only commit is a clean baseline. */
async function createRepository(): Promise<Fixture> {
  const parent = await createTempDir();
  const repo = path.join(parent, 'repo');
  await mkdir(repo);
  await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
  await writeFile(path.join(repo, '.gitignore'), 'ignored.txt\nignored-tree/\n', 'utf8');
  await writeFile(path.join(repo, 'README.md'), 'baseline\n', 'utf8');
  await gitOrFail(['add', '--all'], repo);
  await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);
  return { parent, repo, workDir: path.join(parent, 'runs') };
}

async function headOf(repo: string): Promise<string> {
  return (await gitOrFail(['rev-parse', 'HEAD'], repo)).trim();
}

/** Contents of every file below `directory`, excluding `.git`. */
async function readTree(directory: string, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') {
      continue;
    }
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await readTree(absolute, relative));
    } else {
      files[relative] = await readFile(absolute, 'utf8');
    }
  }
  return files;
}

/** Everything preflight promises not to change. */
interface RepositorySnapshot {
  readonly head: string;
  readonly refs: string;
  readonly index: string;
  readonly status: string;
  readonly files: Readonly<Record<string, string>>;
}

async function snapshotRepository(repo: string): Promise<RepositorySnapshot> {
  return {
    head: await gitOrFail(['rev-parse', 'HEAD'], repo),
    refs: await gitOrFail(['for-each-ref'], repo),
    index: await gitOrFail(['ls-files', '--stage'], repo),
    status: await gitOrFail(['status', '--porcelain'], repo),
    files: await readTree(repo),
  };
}

/** Runs `operation` expecting a {@link WorkspaceError}, and returns it. */
async function expectWorkspaceError(
  operation: () => Promise<unknown>,
  ...problems: RegExp[]
): Promise<WorkspaceError> {
  const cause = await operation().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(cause instanceof WorkspaceError)) {
    throw new Error(`expected a WorkspaceError, received ${String(cause)}`);
  }
  for (const problem of problems) {
    expect(cause.message).toMatch(problem);
  }
  return cause;
}

/** Runs preflight expecting a {@link WorkspaceError}, and returns it. */
function expectRejected(request: PreflightRequest, ...problems: RegExp[]): Promise<WorkspaceError> {
  return expectWorkspaceError(() => preflightSource(request), ...problems);
}

/** Asserts that a rejected preflight left the output location untouched. */
function expectNoOutputLocation(workDir: string): void {
  expect(existsSync(workDir)).toBe(false);
}

async function accepted(request: PreflightRequest): Promise<SourcePreflight> {
  return preflightSource(request);
}

/**
 * Creates a directory alias. A `junction` needs no elevation on Windows and is
 * a plain symlink elsewhere; a `dir` symlink needs a privileged developer mode
 * on Windows, so its test skips where the alias cannot be created.
 */
async function createAlias(
  target: string,
  link: string,
  type: 'junction' | 'dir',
): Promise<boolean> {
  try {
    await symlink(target, link, type);
    return true;
  } catch {
    return false;
  }
}

/** The `tsx` loader, resolved here so the child's own directory need not have it. */
function tsxLoader(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
}

/** Contents of every checked-out file below `directory`, excluding `.git`. */
async function readCheckedOutTree(directory: string): Promise<Record<string, string>> {
  const files = await readTree(directory);
  return Object.fromEntries(
    // A host whose Git rewrites line endings on checkout would otherwise make
    // two identical trees look different; the commit they came from is what
    // these tests are about.
    Object.entries(files).map(([name, contents]) => [name, contents.replace(/\r\n/g, '\n')]),
  );
}

/**
 * The task-time bounds an ordinary preparation test runs under: a fresh,
 * generous deadline read from the real clock. These tests are about Git and the
 * run layout, not about the run's budget, so it never expires in them; the T08
 * tests below hand preparation a clock of their own when expiry is the subject.
 */
function taskBounds(): PrepareWorkspaceBounds {
  return { deadlineMs: Date.now() + 10 * 60_000, now: () => new Date() };
}

/** Preflights a fixture, allocates a run, and prepares its working copy. */
async function prepareRun(fixture: Fixture): Promise<PreparedWorkspace> {
  const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
  return prepareWorkspace(await allocateRunDirectory(fixture.workDir), source, taskBounds());
}

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
    const moduleUrl = pathToFileURL(path.join(repoRoot, 'src', 'workspace.ts')).href;
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
      expect(path.relative(fixture.workDir, run.runDir)).toBe(run.runId);
      expect(run.workspacePath).toBe(path.join(run.runDir, 'workspace'));
      expect(run.logsDir).toBe(path.join(run.runDir, 'logs'));
      expect(existsSync(run.logsDir)).toBe(true);
      // Allocating a directory clones nothing: that is the next step.
      expect(await readdir(run.workspacePath)).toEqual([]);
    }
    expect((await readdir(fixture.workDir)).sort()).toEqual([first.runId, second.runId].sort());
  });

  it('leaves a run directory that already exists alone', async () => {
    const fixture = await createRepository();
    const taken = await prepareRun(fixture);
    const before = await snapshotRepository(taken.workspacePath);

    let generated = 0;
    const next = await allocateRunDirectory(fixture.workDir, () => {
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
      () => allocateRunDirectory(fixture.workDir, () => taken.runId),
      /no free run directory/,
      /never reused, resumed, or overwritten/,
    );

    expect(error.message).toContain(path.join(fixture.workDir, taken.runId));
    expect(await snapshotRepository(taken.workspacePath)).toEqual(before);
    expect((await readdir(fixture.workDir)).sort()).toEqual([taken.runId]);
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
        () => allocateRunDirectory(fixture.workDir, () => runId),
        /not a usable run ID/,
      );
    }

    expect(existsSync(fixture.workDir)).toBe(false);
    expect((await readdir(fixture.parent)).sort()).toEqual(before);
    expect(await readFile(sentinel, 'utf8')).toBe('untouched\n');
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

    // The run's deadline is spent as preparation works: the first steps are
    // given the time that is left, and by the fourth there is none, so the step
    // is not started. The clock is the run's own, read the same way the runner
    // reads it.
    const start = Date.now();
    let reads = 0;
    const error = await expectWorkspaceError(
      () =>
        prepareWorkspace(run, source, {
          deadlineMs: start + 5000,
          now: () => new Date(start + (reads++ < 3 ? 0 : 60_000)),
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
      expect(path.dirname(prepared.runDir)).toBe(path.resolve(fixture.workDir));
      expect(prepared.branch).toBe(`harness/${prepared.runId}`);
      expect(prepared.runDir).not.toContain('evil');
      expect(await headOf(prepared.workspacePath)).toBe(source.baseCommit);
    }

    expect((await readdir(fixture.workDir)).sort()).toEqual(
      runs.map((prepared) => prepared.runId).sort(),
    );
    expect((await readdir(fixture.parent)).sort()).toEqual([...before, 'runs'].sort());
    expect(existsSync(path.join(fixture.parent, 'evil'))).toBe(false);
    expect(await readFile(sentinel, 'utf8')).toBe('untouched\n');
  }, 60_000);
});
