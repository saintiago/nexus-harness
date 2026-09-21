/**
 * Preflight, run-directory, and working-copy tests. Fixtures are real local Git
 * repositories in temporary directories, inspected through real child
 * processes: no network, no credentials, and nothing outside those temporary
 * directories is written or removed. See docs/tasks.md T01, T02, and T08 for the
 * acceptance criteria.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { taskSchema } from '../src/config/schema.js';
import { inspectBranchStanding, returnToRecordedBranch } from '../src/workspace/branch.js';
import { inspectWorkspaceChanges } from '../src/workspace/changes.js';
import { WorkspaceError } from '../src/workspace/errors.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import type { PreparedWorkspace, PrepareWorkspaceBounds } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import type { PreflightRequest, SourcePreflight } from '../src/workspace/preflight.js';
import { reopenWorkspace, resolveWorkspace } from '../src/workspace/reopen.js';
import { allocateRunDirectory, workspacePathFor } from '../src/workspace/run-directory.js';
import type { WorkspaceSourceItem } from '../src/workspace/state.js';
import { readWorkspaceState, workspaceStatePath } from '../src/workspace/state.js';
import { createTempDir, repoRoot } from './support.js';
import { runProcess, useFixtureLifecycle } from './fixtures/lifecycle.js';
import type { ProcessResult } from './fixtures/lifecycle.js';

useFixtureLifecycle();

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
 * on Windows, so its test skips where the alias cannot be created. A `file`
 * symlink needs that same privilege on Windows.
 */
async function createAlias(
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
  return prepareWorkspace(
    await allocateRunDirectory(fixture.workDir),
    source,
    taskBounds(),
    FIXTURE_SOURCE_ITEM,
  );
}

/**
 * The item every fixture workspace is created for, as its ledger records it: a
 * later continuation must name this same item, site, and repository.
 */
const FIXTURE_SOURCE_ITEM: WorkspaceSourceItem = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'SAM1-11',
};

describe('a workspace that outlives its run', () => {
  it('is recorded in a ledger beside the clone, and reopens by its id', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);

    // The ledger says what the clone is, and holds no attempts yet.
    const ledger = await readWorkspaceState(fixture.workDir, prepared.workspaceId);
    expect(ledger).toMatchObject({
      version: 1,
      workspaceId: prepared.workspaceId,
      branch: `harness/${prepared.runId}`,
      baseCommit: prepared.baseCommit,
      attempts: [],
    });
    expect(existsSync(workspaceStatePath(fixture.workDir, prepared.workspaceId))).toBe(true);

    // Resolving is a read: the clone, the ledger, and which attempt comes next.
    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.workspace.workspacePath).toBe(prepared.workspacePath);
      expect(resolved.workspace.attempt).toBe(1);
    }

    // Reopening reads the checkout and returns it for the next attempt.
    const reopened = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(reopened.workspacePath).toBe(prepared.workspacePath);
    expect(reopened.branch).toBe(prepared.branch);
    expect(reopened.attempt).toBe(1);
  });

  it('reopens a workspace whose earlier attempt committed in it', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // A coding turn commits its own work locally, so the branch is expected to
    // move forward from the recorded base; the recorded base is what stays.
    await writeFile(path.join(prepared.workspacePath, 'committed.txt'), 'a checkpoint\n', 'utf8');
    // The file is named rather than staged with `--all`: a host whose Git
    // rewrites line endings at checkout would otherwise renormalize the files
    // this fixture never touched.
    await gitOrFail(['add', 'committed.txt'], prepared.workspacePath);
    await gitOrFail(
      ['commit', '--quiet', '--message', 'a checkpoint an attempt made'],
      prepared.workspacePath,
    );
    expect(await headOf(prepared.workspacePath)).not.toBe(prepared.baseCommit);

    const reopened = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(reopened.workspacePath).toBe(prepared.workspacePath);
    expect(reopened.branch).toBe(prepared.branch);
    expect(reopened.baseCommit).toBe(prepared.baseCommit);
    expect(reopened.attempt).toBe(1);

    // The commit is visible against the recorded base, exactly as uncommitted
    // work is: reopening loses nothing.
    const changes = await inspectWorkspaceChanges(prepared);
    const committed = changes.find((change) => change.path === 'committed.txt');
    expect(committed?.kind).toBe('added');
    expect(committed?.states).toEqual(['committed']);
  });

  it('refuses a workspace on no branch, naming the branch it records and the manual action', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // A detached checkout names no branch, so which branch its commit belongs
    // on is a guess the harness does not make: it is refused rather than
    // continued or adopted (HARN-35).
    await gitOrFail(['checkout', '--quiet', '--detach'], prepared.workspacePath);

    await expect(
      reopenWorkspace(fixture.workDir, prepared.workspaceId, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      }),
    ).rejects.toThrow(
      new RegExp(
        `on no branch \\(a detached HEAD\\), not on its recorded branch ` +
          `"${prepared.branch}".*check out the recorded branch by hand`,
      ),
    );
  });

  it('refuses a workspace that is not where the layout puts it', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // One layout, and nothing else: a clone left in the pre-split location, with
    // its ledger beside the workspaces, is not adopted silently. A workDir from an
    // older harness is upgraded by moving its workspaces and runs into place
    // (docs/implement-workspace-continuation.md).
    const preSplit = path.join(fixture.workDir, prepared.workspaceId, 'workspace');
    await mkdir(path.dirname(preSplit), { recursive: true });
    await rename(prepared.workspacePath, preSplit);

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain(workspacePathFor(fixture.workDir, prepared.workspaceId));
    }
  });

  it('refuses a pointer whose workspace directory is a junction out of the workspaces root', async (context) => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // The id is generated and the name lies inside the workspaces root, but the
    // directory it names is a junction to one outside it: the label is followed
    // to where the directory really is, and a pointer is never followed out of
    // the workspaces root (docs/implement-workspace-continuation.md).
    const outside = path.join(fixture.parent, 'outside');
    await rename(prepared.workspacePath, outside);
    if (!(await createAlias(outside, prepared.workspacePath, 'junction'))) {
      // Junctions need no elevation on Windows; other hosts may lack them.
      if (process.platform === 'win32') {
        throw new Error(`could not create a junction at "${prepared.workspacePath}"`);
      }
      context.skip();
      return;
    }
    expect(realpathSync.native(prepared.workspacePath)).toBe(realpathSync.native(outside));

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });

    // A refusal, not an exception: a scan goes on to publish why, rather than
    // ending on a containment check it could not express.
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain(prepared.workspaceId);
      expect(resolved.problem).toContain(prepared.workspacePath);
      expect(resolved.problem).toContain(realpathSync.native(outside));
      expect(resolved.problem).toContain(
        realpathSync.native(path.join(fixture.workDir, 'workspaces')),
      );
      expect(resolved.problem).toMatch(/junction or symbolic link/);
      expect(resolved.problem).toMatch(/Move the workspace's real directory/);
    }
    // Nothing was opened through the alias: the directory it reaches is whole.
    expect(existsSync(path.join(outside, '.git'))).toBe(true);
  });

  it('refuses a pointer whose ledger is a link out of the workspaces root', async (context) => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    // The clone is a real workspace where the layout puts it; the record beside
    // it is a link to a file somewhere else, which a continuation will not read.
    const ledgerPath = workspaceStatePath(fixture.workDir, prepared.workspaceId);
    const outside = path.join(fixture.parent, 'outside-ledger.json');
    await rename(ledgerPath, outside);
    if (!(await createAlias(outside, ledgerPath, 'file'))) {
      // A file symlink needs elevation or developer mode on Windows; the
      // junction case above covers the alias behavior on that platform.
      expect(process.platform).toBe('win32');
      context.skip();
      return;
    }

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain('ledger');
      expect(resolved.problem).toContain(ledgerPath);
      expect(resolved.problem).toContain(realpathSync.native(outside));
      expect(resolved.problem).toMatch(/junction or symbolic link/);
      expect(resolved.problem).toMatch(/Put the workspace's own ledger back/);
    }
  });

  it('refuses a pointer that is not a generated workspace id, before using it as a path', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    const unusable = [
      '../evil',
      'a/b',
      'a\\b',
      '..',
      '.',
      '',
      'C:\\evil',
      'run.lock',
      'x'.repeat(65),
    ];

    for (const pointer of unusable) {
      const resolved = await resolveWorkspace(fixture.workDir, pointer, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      });
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.problem).toMatch(/not a usable workspace id/);
      }
      // The id never becomes a path: an unusable one throws before it is joined.
      expect(() => workspacePathFor(fixture.workDir, pointer)).toThrow(WorkspaceError);
    }
    // A generated id still resolves to its own workspace.
    expect(workspacePathFor(fixture.workDir, prepared.workspaceId)).toBe(prepared.workspacePath);
  });

  it('refuses a pointer on another item, and says which item the workspace belongs to', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: { ...FIXTURE_SOURCE_ITEM, id: '10012', key: 'SAM1-12' },
      sourceRoot: prepared.sourceRoot,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain('created for jira SAM1-11 (immutable id 10011)');
      expect(resolved.problem).toContain('not for this item (jira SAM1-12 (immutable id 10012)');
    }
  });

  it('refuses a pointer from another site, even for the same immutable id', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: { ...FIXTURE_SOURCE_ITEM, scope: 'https://other.atlassian.net' },
      sourceRoot: prepared.sourceRoot,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain('on https://example.atlassian.net');
      expect(resolved.problem).toContain('on https://other.atlassian.net');
    }
  });

  it('refuses a workspace cloned from another repository', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    const elsewhere = path.join(fixture.parent, 'somewhere-else');

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: elsewhere,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain(`cloned from "${prepared.sourceRoot}"`);
      expect(resolved.problem).toContain(`"${elsewhere}"`);
    }
  });

  it('refuses a ledger with no source item identity, and says how to repair it by hand', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    const ledger = await readWorkspaceState(fixture.workDir, prepared.workspaceId);
    if (ledger === null) {
      throw new Error('the fixture workspace has no ledger');
    }

    // A ledger written before identities were recorded: the same content without
    // the sourceItem field, which is the recorded absence of an identity.
    const firstAttempt = {
      runId: prepared.runId,
      outcome: 'failed',
      endedAt: '2026-01-01T00:00:00.000Z',
      reportPath: `/runs/${prepared.runId}/result.json`,
    };
    const withoutIdentity = {
      version: 1,
      workspaceId: ledger.workspaceId,
      sourceRoot: ledger.sourceRoot,
      baseCommit: ledger.baseCommit,
      branch: ledger.branch,
      createdAt: ledger.createdAt,
      attempts: [firstAttempt],
    };

    await writeFile(
      workspaceStatePath(fixture.workDir, prepared.workspaceId),
      `${JSON.stringify(withoutIdentity)}\n`,
      'utf8',
    );

    const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.problem).toContain('records no source item identity');
      expect(resolved.problem).toContain('"sourceItem"');
      expect(resolved.problem).toContain(firstAttempt.reportPath);
      expect(resolved.problem).toContain('never adopts or migrates');
    }

    // The repair the refusal names makes the same workspace continuable again.
    await writeFile(
      workspaceStatePath(fixture.workDir, prepared.workspaceId),
      `${JSON.stringify({ ...withoutIdentity, sourceItem: FIXTURE_SOURCE_ITEM })}\n`,
      'utf8',
    );
    const repaired = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(repaired.workspacePath).toBe(prepared.workspacePath);
  });

  it('refuses a ledger it did not write: unsupported versions, identities, and attempts are never reused', async () => {
    const fixture = await createRepository();
    const prepared = await prepareRun(fixture);
    const ledger = await readWorkspaceState(fixture.workDir, prepared.workspaceId);
    if (ledger === null) {
      throw new Error('the fixture workspace has no ledger');
    }
    const ledgerPath = workspaceStatePath(fixture.workDir, prepared.workspaceId);
    const attempt = {
      runId: prepared.runId,
      outcome: 'failed',
      endedAt: '2026-01-01T00:00:00.000Z',
      reportPath: `/runs/${prepared.runId}/result.json`,
    };
    const written = {
      version: 1,
      workspaceId: ledger.workspaceId,
      sourceRoot: ledger.sourceRoot,
      baseCommit: ledger.baseCommit,
      branch: ledger.branch,
      createdAt: ledger.createdAt,
      sourceItem: FIXTURE_SOURCE_ITEM,
      attempts: [attempt],
    };

    // Each record below is one this harness never writes: an unsupported
    // version, an identity of the wrong shape, and an attempt whose fields a
    // continuation and its guidance would read. None is cast into something
    // usable, and none is repaired or migrated automatically.
    const unreadable: readonly { readonly ledger: unknown; readonly problem: string }[] = [
      {
        ledger: { ...written, version: 2 },
        problem: 'version',
      },
      {
        ledger: { ...written, sourceItem: { type: 'jira', scope: FIXTURE_SOURCE_ITEM.scope } },
        problem: 'sourceItem.id',
      },
      {
        ledger: {
          ...written,
          attempts: [{ ...attempt, outcome: 'green' }],
        },
        problem: 'attempts.0.outcome',
      },
      {
        ledger: { ...written, attempts: [{ runId: prepared.runId }] },
        problem: 'attempts.0.endedAt',
      },
      {
        // A nonblank string is not enough for the end of an attempt: it is
        // parsed as the moment a continuation reads comments since, so a value
        // that is not an instant is refused rather than read as `NaN`.
        ledger: { ...written, attempts: [{ ...attempt, endedAt: 'not-a-date' }] },
        problem: 'attempts.0.endedAt',
      },
      {
        // Nor is a date `Date.parse` would quietly roll over: this harness
        // refuses a timestamp it did not write instead of coercing it into one.
        ledger: { ...written, attempts: [{ ...attempt, endedAt: '2026-02-30T00:00:00.000Z' }] },
        problem: 'attempts.0.endedAt',
      },
    ];

    for (const entry of unreadable) {
      await writeFile(ledgerPath, `${JSON.stringify(entry.ledger)}\n`, 'utf8');

      const resolved = await resolveWorkspace(fixture.workDir, prepared.workspaceId, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      });

      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        // The refusal names the file and the field, and never tells an operator
        // to add a value that is already there or to treat the record as absent.
        expect(resolved.problem).toContain(ledgerPath);
        expect(resolved.problem).toContain(entry.problem);
        expect(resolved.problem).not.toContain('records no source item identity');
      }
      await expect(
        reopenWorkspace(fixture.workDir, prepared.workspaceId, {
          sourceItem: FIXTURE_SOURCE_ITEM,
          sourceRoot: prepared.sourceRoot,
        }),
      ).rejects.toThrow(/cannot be continued/);
    }

    // A record this harness did write is read again, with the exact timestamp
    // form the harness writes: refusing the malformed ones above is a check on
    // their shape, not a refusal of the workspace.
    const now = new Date().toISOString();
    await writeFile(
      ledgerPath,
      `${JSON.stringify({ ...written, attempts: [{ ...attempt, endedAt: now }] })}\n`,
      'utf8',
    );
    const reopened = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(reopened.attempt).toBe(2);
    expect((await readWorkspaceState(fixture.workDir, prepared.workspaceId))?.attempts).toEqual([
      { ...attempt, endedAt: now },
    ]);
  });
});

/**
 * A coding turn has write access to its clone, Git metadata included, so it can
 * commit its work on a branch of its own. The harness's own branch is what a
 * continuation reopens, what the checks judge and what a delivery step
 * publishes, so a clean checkout that descends from it is returned to it by
 * fast-forwarding, and a checkout that cannot be returned that way is refused
 * with the branch names and the manual action (HARN-35).
 */
describe('a retained checkout that left its recorded branch', () => {
  /** The failure one call rejects with, as a `WorkspaceError` to assert on. */
  async function refusalOf(call: () => Promise<unknown>): Promise<WorkspaceError> {
    const failure = await call().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceError);
    return failure as WorkspaceError;
  }

  /** The branch the checkout is on, or `''` when it is on no branch. */
  async function currentBranchOf(workspacePath: string): Promise<string> {
    return (await gitOrFail(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspacePath)).trim();
  }

  /**
   * A repository fixture whose bytes survive every checkout: this host's system
   * Git configuration rewrites line endings at checkout, the harness's own Git
   * invocations inherit it while the fixture's do not, and without this a file
   * the fixture committed would read as modified after the harness checked it
   * out. tests/runner.test.ts commits the same file for the same reason.
   */
  async function createExactByteRepository(): Promise<Fixture> {
    const fixture = await createRepository();
    await writeFile(path.join(fixture.repo, '.gitattributes'), '* -text\n', 'utf8');
    await gitOrFail(['add', '.gitattributes'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'exact bytes'], fixture.repo);
    return fixture;
  }

  /**
   * Leaves the prepared workspace the way a coding turn can: the checkout is on
   * `branch`, with the turn's work committed there and the recorded branch
   * still where the attempt started from. `dirty` adds a path the turn never
   * committed; `commit: false` leaves a branch at the recorded tip.
   */
  async function leaveOnBranch(
    prepared: PreparedWorkspace,
    branch: string,
    options: { readonly commit?: boolean; readonly dirty?: boolean } = {},
  ): Promise<string> {
    await gitOrFail(['checkout', '--quiet', '-b', branch], prepared.workspacePath);
    if (options.commit !== false) {
      await writeFile(
        path.join(prepared.workspacePath, 'side.txt'),
        'work on a branch of its own\n',
        'utf8',
      );
      await gitOrFail(['add', 'side.txt'], prepared.workspacePath);
      await gitOrFail(
        ['commit', '--quiet', '--message', 'the work of a coding turn'],
        prepared.workspacePath,
      );
    }
    if (options.dirty === true) {
      await writeFile(
        path.join(prepared.workspacePath, 'leftover.txt'),
        'work the turn never committed\n',
        'utf8',
      );
    }
    return await headOf(prepared.workspacePath);
  }

  it('is returned to the recorded branch by fast-forwarding it, losing no commit', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');

    // The reading names what would move and changes nothing.
    expect(await inspectBranchStanding(prepared.workspacePath, prepared.branch)).toEqual({
      kind: 'recoverable',
      currentBranch: 'task/side',
      revision,
      recorded: prepared.baseCommit,
    });
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');

    expect(await returnToRecordedBranch(prepared.workspacePath, prepared.branch)).toEqual({
      changed: true,
      from: 'task/side',
      revision,
    });
    // The checkout is on the recorded branch at the commit the turn made, and
    // the branch the turn used still holds that commit: nothing was reset,
    // force-updated, or discarded.
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(revision);
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/side'], prepared.workspacePath)).trim(),
    ).toBe(revision);
    expect((await gitOrFail(['status', '--porcelain'], prepared.workspacePath)).trim()).toBe('');

    // Nothing is left to do the next time the checkout is read.
    expect(await inspectBranchStanding(prepared.workspacePath, prepared.branch)).toEqual({
      kind: 'on-branch',
    });
    expect(await returnToRecordedBranch(prepared.workspacePath, prepared.branch)).toEqual({
      changed: false,
    });
  });

  it('returns a clean branch that is already at the recorded tip without moving either', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    await leaveOnBranch(prepared, 'task/ordinary', { commit: false });

    expect(await returnToRecordedBranch(prepared.workspacePath, prepared.branch)).toEqual({
      changed: true,
      from: 'task/ordinary',
      revision: prepared.baseCommit,
    });
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/ordinary'], prepared.workspacePath)).trim(),
    ).toBe(prepared.baseCommit);
  });

  it('fast-forwards the recorded branch even when Git configuration would squash the merge', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');

    // Git reads `branch.<name>.mergeOptions` when merging into that branch, and
    // `--ff-only` does not cancel a configured `--squash`: a plain fast-forward
    // exits 0 after staging the descendant without moving the recorded branch.
    // A return that reported that as a reconciliation would hand a coding turn
    // a staged working copy, so the merge has to cancel the squash and the
    // result has to be read back.
    await gitOrFail(
      ['config', `branch.${prepared.branch}.mergeOptions`, '--squash'],
      prepared.workspacePath,
    );

    expect(
      await returnToRecordedBranch(
        prepared.workspacePath,
        prepared.branch,
        {},
        {
          requireClean: true,
        },
      ),
    ).toEqual({ changed: true, from: 'task/side', revision });

    // The recorded branch really moved to the commit the checkout held, the
    // checkout is on it, and nothing was left staged for the next turn.
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(await headOf(prepared.workspacePath)).toBe(revision);
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(revision);
    expect((await gitOrFail(['status', '--porcelain'], prepared.workspacePath)).trim()).toBe('');
    expect(
      await inspectBranchStanding(
        prepared.workspacePath,
        prepared.branch,
        {},
        { requireClean: true },
      ),
    ).toEqual({ kind: 'on-branch' });
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/side'], prepared.workspacePath)).trim(),
    ).toBe(revision);
  });

  it('refuses a return that would write over an ignored local file, keeping its bytes', async () => {
    const fixture = await createExactByteRepository();
    await writeFile(path.join(fixture.repo, 'settings.json'), 'the committed settings\n', 'utf8');
    await gitOrFail(['add', 'settings.json'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'track the settings'], fixture.repo);
    const prepared = await prepareRun(fixture);

    // A turn of its own stops tracking the settings file, ignores it, and
    // leaves a locally regenerated copy. The harness's own reading calls that
    // checkout clean, because an ignored path never makes one dirty; checking
    // the recorded branch out would write the committed copy over the local
    // one, and the fast-forward would then delete it.
    await gitOrFail(['checkout', '--quiet', '-b', 'task/side'], prepared.workspacePath);
    await gitOrFail(['rm', '--quiet', '--cached', 'settings.json'], prepared.workspacePath);
    await writeFile(path.join(prepared.workspacePath, '.gitignore'), 'settings.json\n', 'utf8');
    await gitOrFail(['add', '.gitignore'], prepared.workspacePath);
    await gitOrFail(
      ['commit', '--quiet', '--message', 'stop tracking the settings'],
      prepared.workspacePath,
    );
    await writeFile(
      path.join(prepared.workspacePath, 'settings.json'),
      'regenerated locally\n',
      'utf8',
    );
    const revision = await headOf(prepared.workspacePath);

    expect(await inspectBranchStanding(prepared.workspacePath, prepared.branch)).toEqual({
      kind: 'recoverable',
      currentBranch: 'task/side',
      revision,
      recorded: prepared.baseCommit,
    });

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch),
    );

    // The refusal names both branches and the path Git would have written over,
    // and says the local file was left alone rather than destroyed.
    expect(failure.message).toContain('task/side');
    expect(failure.message).toContain(`"${prepared.branch}"`);
    expect(failure.message).toContain('settings.json');
    expect(failure.message).toMatch(/nothing local was written over/);

    // The file's own bytes survive, and nothing moved: the checkout is still on
    // the branch the turn made, at its commit, and the recorded branch is still
    // where the attempt started from.
    expect(await readFile(path.join(prepared.workspacePath, 'settings.json'), 'utf8')).toBe(
      'regenerated locally\n',
    );
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
    expect(await headOf(prepared.workspacePath)).toBe(revision);
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(prepared.baseCommit);
  });

  it('refuses a return that did not really move the branch, reading its own result back', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');

    // Git runs hooks after a merge, and a hook can leave the recorded branch
    // wherever it likes while the command still exits 0. The return reads its
    // own result back instead of trusting that exit code, so what it reports is
    // the state that really exists rather than the one it asked for. The hooks
    // path is pinned in the workspace's own configuration so a developer's
    // global setting cannot decide whether the fixture's hook runs.
    await gitOrFail(['config', 'core.hooksPath', '.git/hooks'], prepared.workspacePath);
    const hookPath = path.join(prepared.workspacePath, '.git', 'hooks', 'post-merge');
    await writeFile(
      hookPath,
      `#!/bin/sh\ngit update-ref refs/heads/${prepared.branch} ${prepared.baseCommit}\n` +
        'echo ran > .git/hook-ran.txt\n',
      'utf8',
    );
    // Git skips a hook that is not executable on a POSIX host, and runs one
    // either way on Windows: the bit is set so the fixture takes the same path
    // wherever the suite runs. The marker the hook leaves inside the Git
    // directory is checked before the refusal is, so a host that skipped the
    // hook anyway fails on that precondition — which names the reason — rather
    // than on a refusal the test expected and did not get.
    await chmod(hookPath, 0o755);
    const markerPath = path.join(prepared.workspacePath, '.git', 'hook-ran.txt');

    const settled = await returnToRecordedBranch(prepared.workspacePath, prepared.branch).then(
      () => null,
      (error: unknown) => error,
    );
    expect(existsSync(markerPath)).toBe(true);
    expect(settled).toBeInstanceOf(WorkspaceError);
    const failure = settled as WorkspaceError;

    // The refusal names the branch and the revisions it really found, and it
    // says nothing was reset or discarded.
    expect(failure.message).toContain(`"${prepared.branch}"`);
    expect(failure.message).toContain(prepared.baseCommit);
    expect(failure.message).toContain(revision);
    expect(failure.message).toMatch(/read back rather than assumed/);
    expect(failure.message).toMatch(/Nothing was reset, force-updated, or discarded/);

    // The commit the turn made is still on the branch it made it on.
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/side'], prepared.workspacePath)).trim(),
    ).toBe(revision);
  });

  it('leaves a checkout that is already on the recorded branch exactly as it is', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    // The round that judges a turn reads the working copy the turn left, so it
    // does not ask for a clean one: uncommitted work on the recorded branch is
    // ordinary there, it is not a reason to switch, and nothing about it is
    // touched.
    await writeFile(path.join(prepared.workspacePath, 'left.txt'), 'uncommitted\n', 'utf8');

    expect(await inspectBranchStanding(prepared.workspacePath, prepared.branch)).toEqual({
      kind: 'on-branch',
    });
    expect(await returnToRecordedBranch(prepared.workspacePath, prepared.branch)).toEqual({
      changed: false,
    });
    expect(await readFile(path.join(prepared.workspacePath, 'left.txt'), 'utf8')).toBe(
      'uncommitted\n',
    );
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
  });

  it('refuses a checkout that holds uncommitted work when a coding turn needs a clean one', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    await writeFile(path.join(prepared.workspacePath, 'left.txt'), 'uncommitted\n', 'utf8');

    // The strict reading is what a caller about to start a coding turn makes: a
    // turn works from the workspace's own committed state, so the checkout is
    // refused rather than handed on.
    const strict = { requireClean: true } as const;
    const standing = await inspectBranchStanding(
      prepared.workspacePath,
      prepared.branch,
      {},
      strict,
    );
    expect(standing.kind).toBe('refused');
    if (standing.kind !== 'refused') {
      return;
    }
    // Both names the criterion asks for: the branch the ledger records, the
    // commit it is at, and the paths that would have to be finished by hand.
    expect(standing.problem).toContain(`"${prepared.branch}"`);
    expect(standing.problem).toContain(prepared.baseCommit);
    expect(standing.problem).toContain('left.txt');
    expect(standing.problem).toMatch(/Commit or remove those paths by hand/);

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch, {}, strict),
    );
    expect(failure.message).toBe(standing.problem);

    // Nothing moved: the checkout is where the turn left it, with its commit and
    // its leftover.
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
    expect(await readFile(path.join(prepared.workspacePath, 'left.txt'), 'utf8')).toBe(
      'uncommitted\n',
    );
  });

  it('refuses a dirty branch of its own, naming both branches and the manual action', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side', { dirty: true });

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch),
    );

    // The refusal names what Git would have to move between, and what a person
    // can do instead: the harness never commits, discards, or force-switches a
    // dirty checkout.
    expect(failure.message).toContain('task/side');
    expect(failure.message).toContain(`"${prepared.branch}"`);
    expect(failure.message).toContain('leftover.txt');
    expect(failure.message).toMatch(/Commit or remove those paths by hand/);
    expect(failure.message).toContain(revision);

    // Nothing moved: the checkout, its commit, its leftover, and the recorded
    // branch are all exactly where the turn left them.
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
    expect(await headOf(prepared.workspacePath)).toBe(revision);
    expect(await readFile(path.join(prepared.workspacePath, 'leftover.txt'), 'utf8')).toBe(
      'work the turn never committed\n',
    );
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(prepared.baseCommit);
  });

  it('refuses a commit the recorded branch does not descend from, and names both revisions', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');
    // The recorded branch moves on as well, so neither side descends from the
    // other: fast-forwarding it to the checkout would drop the commit it holds.
    await gitOrFail(['checkout', '--quiet', prepared.branch], prepared.workspacePath);
    await writeFile(path.join(prepared.workspacePath, 'recorded.txt'), 'later work\n', 'utf8');
    await gitOrFail(['add', 'recorded.txt'], prepared.workspacePath);
    await gitOrFail(['commit', '--quiet', '--message', 'later work'], prepared.workspacePath);
    const recorded = await headOf(prepared.workspacePath);
    await gitOrFail(['checkout', '--quiet', 'task/side'], prepared.workspacePath);

    const standing = await inspectBranchStanding(prepared.workspacePath, prepared.branch);
    expect(standing.kind).toBe('refused');

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch),
    );
    expect(failure.message).toContain('task/side');
    expect(failure.message).toContain(`"${prepared.branch}"`);
    expect(failure.message).toContain(revision);
    expect(failure.message).toContain(recorded);
    expect(failure.message).toMatch(/reconcile the two by hand/);

    // Both branches and the checkout are untouched.
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
    expect(
      (await gitOrFail(['rev-parse', 'refs/heads/task/side'], prepared.workspacePath)).trim(),
    ).toBe(revision);
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(recorded);
  });

  it('refuses a checkout whose recorded branch the workspace does not hold', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    await leaveOnBranch(prepared, 'task/side');
    await gitOrFail(['branch', '--delete', '--force', prepared.branch], prepared.workspacePath);

    const failure = await refusalOf(() =>
      returnToRecordedBranch(prepared.workspacePath, prepared.branch),
    );

    expect(failure.message).toContain('task/side');
    expect(failure.message).toContain(`holds no branch named "${prepared.branch}"`);
    expect(failure.message).toMatch(/never recreates, renames, or adopts a branch/);
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
  });

  it('is accepted by a continuation when it can be returned, and left where it is', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    const revision = await leaveOnBranch(prepared, 'task/side');

    // Verification is a read: the run that follows is what returns the checkout
    // to the recorded branch, before its first coding turn.
    const reopened = await reopenWorkspace(fixture.workDir, prepared.workspaceId, {
      sourceItem: FIXTURE_SOURCE_ITEM,
      sourceRoot: prepared.sourceRoot,
    });
    expect(reopened.branch).toBe(prepared.branch);
    expect(reopened.attempt).toBe(1);
    expect(await currentBranchOf(prepared.workspacePath)).toBe('task/side');
    expect(
      (
        await gitOrFail(['rev-parse', `refs/heads/${prepared.branch}`], prepared.workspacePath)
      ).trim(),
    ).toBe(prepared.baseCommit);
    expect(await headOf(prepared.workspacePath)).toBe(revision);
  });

  it('is refused by a continuation when it cannot be returned, with the branch names', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    await leaveOnBranch(prepared, 'task/side', { dirty: true });

    await expect(
      reopenWorkspace(fixture.workDir, prepared.workspaceId, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      }),
    ).rejects.toThrow(
      /cannot be continued: .*task\/side.*recorded branch.*leftover\.txt.*Commit or remove/s,
    );
  });

  it('is refused by a continuation when its recorded branch holds uncommitted work', async () => {
    const fixture = await createExactByteRepository();
    const prepared = await prepareRun(fixture);
    // The earlier attempt left work it never committed, on the branch the ledger
    // records: the next attempt would start another agent on it, and the harness
    // starts no coding turn from a working copy like that (HARN-35).
    await writeFile(path.join(prepared.workspacePath, 'left.txt'), 'uncommitted\n', 'utf8');

    await expect(
      reopenWorkspace(fixture.workDir, prepared.workspaceId, {
        sourceItem: FIXTURE_SOURCE_ITEM,
        sourceRoot: prepared.sourceRoot,
      }),
    ).rejects.toThrow(
      new RegExp(
        `cannot be continued: .*"${prepared.branch}".*left\\.txt.*Commit or remove those paths by hand`,
        's',
      ),
    );

    // Verification is a read: the working copy is exactly where the earlier
    // attempt left it, so the work can be finished by hand.
    expect(await currentBranchOf(prepared.workspacePath)).toBe(prepared.branch);
    expect(await headOf(prepared.workspacePath)).toBe(prepared.baseCommit);
    expect(await readFile(path.join(prepared.workspacePath, 'left.txt'), 'utf8')).toBe(
      'uncommitted\n',
    );
  });
});

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
