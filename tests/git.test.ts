/**
 * The Git boundary: the harness's own invocations, against the host's real Git
 * and — where a step has to be stopped mid-flight — a stand-in `git` that hangs
 * and records what it was handed.
 *
 * What is proved here is the contract every workspace module relies on: literal
 * arguments and no shell, inherited Git variables dropped so a reading cannot be
 * redirected at another repository, a failure that keeps Git's own diagnostic, a
 * workspace identity that is written locally and nowhere else, and a bound or a
 * caller's stop that ends the invocation and the whole tree it started. Which
 * workspace step runs is the workspace suite's; what a result means to a run is
 * the fast suites'.
 *
 * The stand-in is only reached while a case puts it first on `PATH`, so the real
 * Git is never mistaken for it. Every process a case starts is confirmed gone
 * before the case ends.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GIT_COMMAND_TIMEOUT_MS,
  configureWorkspaceIdentity,
  gitFailure,
  gitProblem,
  gitStopOf,
  runGit,
} from '../src/workspace/git.js';
import type { GitResult } from '../src/workspace/git.js';
import { WorkspaceError } from '../src/workspace/errors.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import {
  createRepository,
  createTempDir,
  fixtureGit,
  gitOrFail,
  installStandIn,
  readJsonWhenWritten,
  useIsolatedGitEnvironment,
  waitUntilGone,
  withPathPrefix,
} from './integration-support.js';

useIsolatedGitEnvironment();

/**
 * A stand-in `git`: it records the arguments, the working directory, its own
 * PID, and the PID of a child it starts, and then keeps running until something
 * ends the tree. The record is written only once the child exists, so a record
 * that exists names two live processes.
 */
const STAND_IN_GIT = [
  `const { spawn } = await import('node:child_process');`,
  `const { writeFileSync } = await import('node:fs');`,
  `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {`,
  `  stdio: 'ignore',`,
  `  windowsHide: true,`,
  `});`,
  `writeFileSync(process.env.NEXUS_GIT_RECORD, JSON.stringify({`,
  `  argv: process.argv.slice(2),`,
  `  cwd: process.cwd(),`,
  `  pid: process.pid,`,
  `  child: child.pid,`,
  `}));`,
  `setInterval(() => {}, 1000);`,
].join('\n');

/**
 * Runs `work` with a stand-in `git` first on `PATH`, and tells it where to write
 * its record. Both are put back afterwards, so the host's real Git is what every
 * other case sees.
 */
async function withStandInGit<T>(record: string, work: () => Promise<T>): Promise<T> {
  const standIn = await installStandIn('git', STAND_IN_GIT);
  const saved = process.env.NEXUS_GIT_RECORD;
  process.env.NEXUS_GIT_RECORD = record;
  try {
    return await withPathPrefix(standIn.bin, work);
  } finally {
    if (saved === undefined) {
      delete process.env.NEXUS_GIT_RECORD;
    } else {
      process.env.NEXUS_GIT_RECORD = saved;
    }
  }
}

/** One stand-in invocation's record, as the stand-in wrote it. */
interface StandInRecord {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly pid: number;
  readonly child: number | null;
}

async function readStandInRecord(file: string): Promise<StandInRecord> {
  const record = await readJsonWhenWritten(file);
  return {
    argv: record.argv as readonly string[],
    cwd: String(record.cwd),
    pid: Number(record.pid),
    child: record.child === null || record.child === undefined ? null : Number(record.child),
  };
}

/** The error a call that was expected to fail rejected with. */
async function failureOf(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('the call was expected to fail, and it did not');
}

describe('one Git invocation against the real Git', () => {
  it('runs the literal arguments in the working directory it was given', async () => {
    const fixture = await createRepository();
    const head = (await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], fixture.repo)).trim();

    const result = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], fixture.repo);

    expect(result.outcome).toBe('exited');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(head);
    expect(result.termination).toBeNull();
    // A reading outside a run runs under the finite default bound, so a stalled
    // one can never hold the harness indefinitely.
    expect(result.timeoutMs).toBe(GIT_COMMAND_TIMEOUT_MS);
  }, 60_000);

  it('drops an inherited Git variable instead of letting it redirect the reading', async () => {
    const first = await createRepository();
    const second = await createRepository();
    // The two repositories have to be distinguishable: commit SHAs of the same
    // content made in the same second by the same fixture identity are equal.
    await writeFile(path.join(second.repo, 'second.txt'), 'a second repository\n', 'utf8');
    await gitOrFail(['add', '--all'], second.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'second'], second.repo);
    const firstHead = (
      await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], first.repo)
    ).trim();
    const secondHead = (
      await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], second.repo)
    ).trim();
    expect(firstHead).not.toBe(secondHead);

    const saved = process.env.GIT_DIR;
    // A caller's own environment names another repository. The harness's own
    // reading must still answer the repository it was given.
    process.env.GIT_DIR = path.join(second.repo, '.git');
    try {
      const result = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], first.repo);

      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(firstHead);
    } finally {
      if (saved === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = saved;
      }
    }
  }, 60_000);

  it('keeps Git’s own first error line, and never reports a failed reading as a success', async () => {
    // A repository with no commit yet: the reading the workspace modules make
    // before anything else is the one Git has to refuse.
    const parent = await createTempDir();
    const repository = path.join(parent, 'empty');
    await mkdir(repository);
    await gitOrFail(['init', '--quiet', '--initial-branch=main'], repository);

    const result = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], repository);

    expect(result.outcome).toBe('exited');
    expect(result.code).not.toBe(0);
    expect(gitProblem(result)).not.toBe('');
    expect(gitProblem(result)).not.toBe('no diagnostic output');
    expect(gitStopOf(result)).toBeNull();
    const error = gitFailure(`the committed HEAD of "${repository}" could not be read`, result);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toContain('could not be read');
    expect(error.message).toContain(gitProblem(result));
    expect(error.stop).toBeNull();
  }, 60_000);
});

describe('the identity a working copy commits with', () => {
  it('writes the working copy’s own settings, and no setting anywhere else', async () => {
    const fixture = await createRepository();
    const preflight = await preflightSource({
      repoPath: fixture.repo,
      workDir: fixture.workDir,
    });
    const run = await allocateRunDirectory(fixture.workDir);
    const workspace = await prepareWorkspace(run, preflight, {
      deadlineMs: Date.now() + 60_000,
      now: () => new Date(),
    });
    // The fixture commits with an identity of its own; what a coding turn does
    // is commit with none, exactly as a machine with no ambient identity would.
    const noIdentity = { identity: false };
    const before = await fixtureGit(
      ['commit', '--quiet', '--allow-empty', '--message', 'before'],
      workspace.workspacePath,
      noIdentity,
    );
    expect(before.code).not.toBe(0);

    await configureWorkspaceIdentity(workspace.workspacePath);
    await writeFile(path.join(workspace.workspacePath, 'work.txt'), 'work\n', 'utf8');
    await gitOrFail(['add', '--all'], workspace.workspacePath, noIdentity);
    await gitOrFail(
      ['commit', '--quiet', '--message', 'work'],
      workspace.workspacePath,
      noIdentity,
    );

    const message = (
      await gitOrFail(['log', '-1', '--pretty=%an <%ae>'], workspace.workspacePath)
    ).trim();
    expect(message).toBe('Nexus Agent <nexus@local>');
    expect(
      (
        await gitOrFail(['config', '--local', '--get', 'commit.gpgsign'], workspace.workspacePath)
      ).trim(),
    ).toBe('false');
    // The settings are that clone's own: the global file the suite runs with is
    // untouched, so nothing on this machine was changed.
    expect(await gitOrFail(['config', '--global', '--list'], fixture.repo)).toBe('');
  }, 90_000);
});

describe('a Git invocation with a bound', () => {
  it('stops a stalled invocation and its child at the bound, and says the stop was confirmed', async () => {
    const fixture = await createRepository();
    const recordFile = path.join(fixture.parent, 'stalled.json');
    // A frozen clock keeps the bound the harness hands over exact.
    const clock = new Date();

    const result = await withStandInGit(recordFile, () =>
      runGit(['status'], fixture.repo, {
        deadlineMs: clock.getTime() + 3000,
        now: () => clock,
      }),
    );
    const record = await readStandInRecord(recordFile);

    // What ran was the stand-in, in the working directory it was given, with the
    // arguments as written and never through a shell.
    expect(record.argv).toEqual(['status']);
    expect(record.cwd).toBe(fixture.repo);
    expect(record.child).toBeTypeOf('number');
    expect(result.outcome).toBe('timed-out');
    // Stopped, never a success, whatever exit code the host reports for the tree
    // it ended.
    expect(result.code).not.toBe(0);
    expect(result.timeoutMs).toBe(3000);
    expect(result.termination).toBe('confirmed');
    expect(result.terminationProblem).toBeNull();
    expect(gitStopOf(result)).toEqual({ termination: 'confirmed', problem: null });
    expect(gitProblem(result)).toContain('did not finish within the 3000 ms it was given');
    expect(gitProblem(result)).toContain('everything it started was stopped');

    expect(await waitUntilGone(record.pid)).toBe(true);
    expect(await waitUntilGone(record.child ?? 0)).toBe(true);
  }, 90_000);

  it('gives each reading what is left of the run, not the budget its step started with', async () => {
    const fixture = await createRepository();
    const clock = new Date();
    const bounds = { deadlineMs: clock.getTime() + 2000, now: (): Date => clock };

    const first = await withStandInGit(path.join(fixture.parent, 'first.json'), () =>
      runGit(['status'], fixture.repo, bounds),
    );
    const firstRecord = await readStandInRecord(path.join(fixture.parent, 'first.json'));
    clock.setTime(clock.getTime() + 1500);
    const second = await withStandInGit(path.join(fixture.parent, 'second.json'), () =>
      runGit(['status'], fixture.repo, bounds),
    );
    const secondRecord = await readStandInRecord(path.join(fixture.parent, 'second.json'));

    expect(first.timeoutMs).toBe(2000);
    expect(second.timeoutMs).toBe(500);
    expect(first.outcome).toBe('timed-out');
    expect(second.outcome).toBe('timed-out');
    expect(await waitUntilGone(firstRecord.pid)).toBe(true);
    expect(await waitUntilGone(firstRecord.child ?? 0)).toBe(true);
    expect(await waitUntilGone(secondRecord.pid)).toBe(true);
    expect(await waitUntilGone(secondRecord.child ?? 0)).toBe(true);
  }, 90_000);

  it('stops a stalled invocation when the run is stopped, and says which stop it was', async () => {
    const fixture = await createRepository();
    const recordFile = path.join(fixture.parent, 'cancelled.json');
    const controller = new AbortController();
    const clock = new Date();

    const pending = withStandInGit(recordFile, () =>
      runGit(['status'], fixture.repo, {
        deadlineMs: clock.getTime() + 60_000,
        now: () => clock,
        stop: controller.signal,
      }),
    );
    let record: StandInRecord;
    let result: GitResult;
    try {
      record = await readStandInRecord(recordFile);
      controller.abort();
      result = await pending;
    } catch (cause) {
      // Whatever happens, the invocation this case started is stopped and
      // awaited before the case ends.
      controller.abort();
      await pending.catch(() => undefined);
      throw cause;
    }

    expect(result.outcome).toBe('stopped');
    expect(result.termination).toBe('confirmed');
    expect(result.terminationProblem).toBeNull();
    expect(gitProblem(result)).toBe(
      'it was stopped because the run was stopped by its caller, and everything it started was stopped',
    );
    expect(await waitUntilGone(record.pid)).toBe(true);
    expect(await waitUntilGone(record.child ?? 0)).toBe(true);
  }, 90_000);
});

describe('a workspace step that has to be stopped', () => {
  it('keeps the run directory and carries the stop on the failure', async () => {
    const fixture = await createRepository();
    const preflight = await preflightSource({
      repoPath: fixture.repo,
      workDir: fixture.workDir,
    });
    const run = await allocateRunDirectory(fixture.workDir);
    const recordFile = path.join(fixture.parent, 'prepare.json');
    const clock = new Date();

    const error = await withStandInGit(recordFile, () =>
      failureOf(() =>
        prepareWorkspace(run, preflight, {
          deadlineMs: clock.getTime() + 3000,
          now: () => clock,
        }),
      ),
    );
    const record = await readStandInRecord(recordFile);

    // The step was stopped at the run's own remaining time, and that stop is on
    // the error: the runner that reads it can carry an unconfirmed stop into the
    // run's evidence instead of reporting a clean end.
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toContain('did not finish within');
    expect((error as WorkspaceError).stop).toEqual({
      termination: 'confirmed',
      problem: null,
      kind: 'timeout',
      timeoutMs: 3000,
    });
    expect(error.message).toContain(
      `The incomplete run directory was kept for inspection: "${run.runDir}"`,
    );

    // What preparation wrote is kept, and none of it is a usable working copy.
    expect(existsSync(run.runDir)).toBe(true);
    expect(existsSync(run.logsDir)).toBe(true);
    expect(existsSync(path.join(run.workspacePath, '.git'))).toBe(false);
    // The source checkout is untouched: the step ran there and was stopped.
    expect((await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], fixture.repo)).trim()).toBe(
      preflight.baseCommit,
    );
    expect(await waitUntilGone(record.pid)).toBe(true);
    expect(await waitUntilGone(record.child ?? 0)).toBe(true);
  }, 90_000);
});
