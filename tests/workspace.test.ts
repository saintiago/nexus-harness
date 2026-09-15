/**
 * Preflight tests. Fixtures are real local Git repositories in temporary
 * directories, inspected through real child processes: no network, no
 * credentials, and nothing outside those temporary directories is written or
 * removed. See docs/tasks.md T01 for the acceptance criteria.
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceError, preflightSource } from '../src/workspace.js';
import type { PreflightRequest, SourcePreflight } from '../src/workspace.js';
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

/** Runs preflight expecting a {@link WorkspaceError}, and returns it. */
async function expectRejected(
  request: PreflightRequest,
  ...problems: RegExp[]
): Promise<WorkspaceError> {
  const cause = await preflightSource(request).then(
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
