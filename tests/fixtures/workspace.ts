/**
 * The Git fixtures both workspace suites share: a real repository, the helpers
 * that read one back, and the run-directory, preflight and preparation builders
 * every describe uses. Nothing here reaches the network, and every temporary
 * directory is removed by the lifecycle the test file registers.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WorkspaceError } from '../../src/workspace/errors.js';
import { prepareWorkspace } from './boundary-operations.js';
import type { PreparedWorkspace, PrepareWorkspaceBounds } from '../../src/workspace/prepare.js';
import { preflightSource } from './boundary-operations.js';
import type { PreflightRequest, SourcePreflight } from '../../src/workspace/preflight.js';
import { allocateRunDirectory } from './boundary-operations.js';
import type { WorkspaceSourceItem } from '../../src/workspace/state.js';
import { createTempDir } from '../support.js';
import { gitFixtureEnvironment } from './git.js';
import { ownFixtureOperation, runProcess } from './lifecycle.js';
import type { ProcessResult } from './lifecycle.js';

import { expect } from 'vitest';

/** The private Git environment every command in these fixtures runs in. */
let fixtureEnvironment: NodeJS.ProcessEnv = {};

/**
 * Prepares that environment for one test: the fixture's own commits use the
 * harness identity, and nothing on this machine's Git configuration can
 * decide what a test observes.
 */
export async function beginFixtureGitEnvironment(): Promise<void> {
  return ownFixtureOperation('workspace Git environment', async () => {
    fixtureEnvironment = await gitFixtureEnvironment({
      name: 'Harness Test',
      email: 'harness@example.test',
    });
  });
}
/** Runs `git` with literal arguments in the fixture environment. */
export function git(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return runProcess('git', args, { cwd, env: fixtureEnvironment });
}

/** Runs `git` and fails the test when it does not succeed. */
export async function gitOrFail(args: readonly string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export interface Fixture {
  /** Temporary directory holding the repository and the output locations. */
  readonly parent: string;
  /** The source repository. */
  readonly repo: string;
  /** A safe output directory, which does not exist yet. */
  readonly workDir: string;
}

/** A temporary repository whose only commit is a clean baseline. */
export async function createRepository(): Promise<Fixture> {
  return ownFixtureOperation('workspace repository setup', async () => {
    const parent = await createTempDir();
    const repo = path.join(parent, 'repo');
    await mkdir(repo);
    await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
    await writeFile(path.join(repo, '.gitignore'), 'ignored.txt\nignored-tree/\n', 'utf8');
    await writeFile(path.join(repo, 'README.md'), 'baseline\n', 'utf8');
    await gitOrFail(['add', '--all'], repo);
    await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);
    return { parent, repo, workDir: path.join(parent, 'runs') };
  });
}

export async function headOf(repo: string): Promise<string> {
  return (await gitOrFail(['rev-parse', 'HEAD'], repo)).trim();
}

/** Contents of every file below `directory`, excluding `.git`. */
export async function readTree(directory: string, prefix = ''): Promise<Record<string, string>> {
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
export interface RepositorySnapshot {
  readonly head: string;
  readonly refs: string;
  readonly index: string;
  readonly status: string;
  readonly files: Readonly<Record<string, string>>;
}

export async function snapshotRepository(repo: string): Promise<RepositorySnapshot> {
  return {
    head: await gitOrFail(['rev-parse', 'HEAD'], repo),
    refs: await gitOrFail(['for-each-ref'], repo),
    index: await gitOrFail(['ls-files', '--stage'], repo),
    status: await gitOrFail(['status', '--porcelain'], repo),
    files: await readTree(repo),
  };
}

/** Runs `operation` expecting a {@link WorkspaceError}, and returns it. */
export async function expectWorkspaceError(
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
export function expectRejected(
  request: PreflightRequest,
  ...problems: RegExp[]
): Promise<WorkspaceError> {
  return expectWorkspaceError(() => preflightSource(request), ...problems);
}

/** Asserts that a rejected preflight left the output location untouched. */
export function expectNoOutputLocation(workDir: string): void {
  expect(existsSync(workDir)).toBe(false);
}

export async function accepted(request: PreflightRequest): Promise<SourcePreflight> {
  return preflightSource(request);
}

/**
 * Creates a directory alias. A `junction` needs no elevation on Windows and is
 * a plain symlink elsewhere; a `dir` symlink needs a privileged developer mode
 * on Windows, so its test skips where the alias cannot be created. A `file`
 * symlink needs that same privilege on Windows.
 */
export async function createAlias(
  target: string,
  link: string,
  type: 'junction' | 'dir' | 'file',
): Promise<boolean> {
  try {
    await symlink(target, link, type);
    return true;
  } catch {
    return false;
  }
}

/** The `tsx` loader, resolved here so the child's own directory need not have it. */
export function tsxLoader(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
}

/** Contents of every checked-out file below `directory`, excluding `.git`. */
export async function readCheckedOutTree(directory: string): Promise<Record<string, string>> {
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
export function taskBounds(): PrepareWorkspaceBounds {
  return { deadlineMs: Date.now() + 10 * 60_000, now: () => new Date() };
}

/** Preflights a fixture, allocates a run, and prepares its working copy. */
export async function prepareRun(fixture: Fixture): Promise<PreparedWorkspace> {
  return ownFixtureOperation('prepareRun setup', async (stop) => {
    const source = await preflightSource({ repoPath: fixture.repo, workDir: fixture.workDir });
    stop.throwIfAborted();
    return prepareWorkspace(
      await allocateRunDirectory(fixture.workDir),
      source,
      taskBounds(),
      FIXTURE_SOURCE_ITEM,
    );
  });
}

/**
 * The item every fixture workspace is created for, as its ledger records it: a
 * later continuation must name this same item, site, and repository.
 */
export const FIXTURE_SOURCE_ITEM: WorkspaceSourceItem = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'SAM1-11',
};
