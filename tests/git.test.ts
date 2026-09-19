/**
 * The bounded Git invocations, against a stand-in `git` on the `PATH`.
 *
 * Everything above that boundary is the production one: the process runner, the
 * bound a caller passes, the stop that reaches the whole tree, the result the
 * harness reports, and — for the preparation and comparison cases — the
 * workspace modules that use it. The stand-in is a real program
 * (`tests/fixtures/fake-git.mjs`), so these tests observe what the operating
 * system delivered rather than what the harness intended.
 *
 * No network, no credentials, and nothing outside the temporary directories is
 * written or removed. Every fixture process is registered as soon as it records
 * itself, so a test that fails half-way still leaves nothing running
 * (notes/windows-fixture-flakes.md).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectWorkspaceChanges } from '../src/workspace/changes.js';
import { WorkspaceError } from '../src/workspace/errors.js';
import { GIT_COMMAND_TIMEOUT_MS, gitProblem, gitStopOf, runGit } from '../src/workspace/git.js';
import type { GitResult } from '../src/workspace/git.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import { endFixtureTree, installFakeGit } from './fixtures/local-target.js';
import type { FakeGitState, FixtureProcessRecord } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

/**
 * The fixture processes this file started, as each recorded itself: a stop a
 * test means to prove is stopped here too, so a failing assertion cannot leave a
 * hanging fixture behind for the rest of the suite.
 */
const fixtureProcesses: FixtureProcessRecord[] = [];

afterEach(async () => {
  for (const record of fixtureProcesses.splice(0)) {
    await endFixtureTree(record);
  }
  await cleanupTempDirectories();
});

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True while this host still reports a process with that PID. */
function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits, bounded, for a fixture process to be gone, then insists that it is. */
async function expectGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (stillRunning(pid) && Date.now() < deadline) {
    await pause(50);
  }
  expect(stillRunning(pid)).toBe(false);
}

/**
 * A private Git environment for the fixtures: the developer's own hooks,
 * signing, ignore rules, and identity must not change what these tests observe.
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

/** Runs the host's real `git`, which the stand-in is never confused with. */
async function gitOrFail(args: readonly string[], cwd: string): Promise<string> {
  const result = await runProcess('git', args, { cwd, env: fixtureEnvironment });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** A temporary source repository with one commit, and an output location. */
async function createSource(): Promise<{
  readonly parent: string;
  readonly repo: string;
  readonly workDir: string;
}> {
  const parent = await createTempDir();
  const repo = path.join(parent, 'repo');
  await mkdir(repo);
  await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
  await writeFile(path.join(repo, 'README.md'), 'baseline\n', 'utf8');
  await gitOrFail(['add', '--all'], repo);
  await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);
  return { parent, repo, workDir: path.join(parent, 'runs') };
}

/** A repository, its output location, and the working copy prepared from it. */
async function createPreparedWorkspace(): Promise<{
  readonly parent: string;
  readonly repo: string;
  readonly workspace: PreparedWorkspace;
}> {
  const source = await createSource();
  const preflight = await preflightSource({ repoPath: source.repo, workDir: source.workDir });
  const run = await allocateRunDirectory(source.workDir);
  const workspace = await prepareWorkspace(run, preflight, {
    deadlineMs: Date.now() + 60_000,
    now: () => new Date(),
  });
  return { parent: source.parent, repo: source.repo, workspace };
}

/** One invocation of the stand-in `git`, as it recorded itself. */
interface FakeGitRecord extends FixtureProcessRecord {
  /** The arguments the invocation actually received. */
  readonly argv: readonly string[];
  /** The working directory it actually ran in. */
  readonly cwd: string;
  /** The process the hanging invocation started, or `null` when it started none. */
  readonly child: number | null;
  /** The beacon token that child answers on, when it recorded one. */
  readonly childToken: string | null;
}

/** What one stand-in `git` invocation is told to do. */
interface FakeGitCall {
  /** Names this invocation's record, and the child a hang starts. */
  readonly id: string;
  readonly mode?: 'ok' | 'hang';
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

/**
 * Runs `work` with the stand-in `git` first on `PATH`, under one call's
 * configuration. Both are put back afterwards; a test that has to clear `PATH`
 * while the invocation runs does that itself.
 */
async function withFakeGit<T>(
  fake: { readonly bin: string; readonly state: FakeGitState },
  call: FakeGitCall,
  work: () => Promise<T>,
): Promise<T> {
  const previousPath = process.env.PATH;
  const previousConfig = process.env.FAKE_GIT;
  process.env.PATH = `${fake.bin}${path.delimiter}${previousPath ?? ''}`;
  process.env.FAKE_GIT = JSON.stringify({ stateDir: fake.state.dir, mode: 'ok', ...call });
  try {
    return await work();
  } finally {
    putBack('PATH', previousPath);
    putBack('FAKE_GIT', previousConfig);
  }
}

/** Puts one environment variable back the way it was found. */
function putBack(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

/**
 * The record one invocation wrote, waiting for it to appear: it is written once
 * every beacon in that invocation's tree answers, so a record that exists names
 * processes that really ran.
 */
async function readFakeGitRecord(state: FakeGitState, id: string): Promise<FakeGitRecord> {
  const file = path.join(state.dir, `${id}.json`);
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const record = JSON.parse(await readFile(file, 'utf8')) as {
        argv: readonly string[];
        cwd: string;
        pid: number;
        pidToken: string;
        child: number | null;
        childToken: string | null;
      };
      return {
        argv: record.argv,
        cwd: record.cwd,
        pid: record.pid,
        token: record.pidToken,
        beaconDirectory: state.dir,
        child: record.child,
        childToken: record.childToken,
      };
    } catch (cause) {
      if (Date.now() >= deadline) {
        throw new Error(`the stand-in git never recorded "${id}": ${String(cause)}`, { cause });
      }
      await pause(25);
    }
  }
}

/**
 * Remembers a fixture process, and the child it started, for the end of the
 * test. The child is registered on its own token: the parent's tree stop may
 * miss it when the parent dies first.
 */
function registerFixture(record: FakeGitRecord): void {
  fixtureProcesses.push({
    pid: record.pid,
    token: record.token,
    beaconDirectory: record.beaconDirectory,
  });
  if (record.child !== null && record.childToken !== null) {
    fixtureProcesses.push({
      pid: record.child,
      token: record.childToken,
      beaconDirectory: record.beaconDirectory,
    });
  }
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

describe('a Git command under a bound', () => {
  it('runs to completion and returns what it wrote', async () => {
    const source = await createSource();
    const fake = await installFakeGit(source.parent);

    const result = await withFakeGit(
      fake,
      { id: 'ok', stdout: 'abc123\n', stderr: 'a note\n' },
      () => runGit(['rev-parse', '--verify', 'HEAD'], source.repo),
    );

    expect(result.outcome).toBe('exited');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('abc123\n');
    expect(result.stderr).toBe('a note\n');
    expect(result.termination).toBeNull();
    expect(result.terminationProblem).toBeNull();
    // A reading with no run deadline runs under the finite default bound, so a
    // stalled one cannot hold the harness indefinitely.
    expect(result.timeoutMs).toBe(GIT_COMMAND_TIMEOUT_MS);
    expect(gitStopOf(result)).toBeNull();

    // The invocation really was the stand-in, in the working directory it was
    // given, with the arguments as written and never through a shell.
    const record = await readFakeGitRecord(fake.state, 'ok');
    expect(record.argv).toEqual(['rev-parse', '--verify', 'HEAD']);
    expect(record.cwd).toBe(source.repo);
    await expectGone(record.pid);
  }, 60_000);

  it('stops a hanging command at its bound, and the child it started with it', async () => {
    const source = await createSource();
    const fake = await installFakeGit(source.parent);
    const started = Date.now();
    // A frozen clock keeps the bound the harness hands over exact.
    const clock = new Date();

    const result = await withFakeGit(fake, { id: 'hang', mode: 'hang' }, () =>
      runGit(['status'], source.repo, { deadlineMs: clock.getTime() + 3000, now: () => clock }),
    );
    const record = await readFakeGitRecord(fake.state, 'hang');
    registerFixture(record);

    // Both processes really were running: the record exists only once the child
    // answered on its own beacon.
    expect(record.child, JSON.stringify(record)).toBeTypeOf('number');
    expect(result.outcome).toBe('timed-out');
    // Stopped, never a success — whatever exit code the host reports for the
    // shim it ended.
    expect(result.code).not.toBe(0);
    expect(result.timeoutMs).toBe(3000);
    expect(result.termination).toBe('confirmed');
    expect(result.terminationProblem).toBeNull();
    expect(gitStopOf(result)).toEqual({ termination: 'confirmed', problem: null });
    expect(gitProblem(result)).toContain('it did not finish within the 3000 ms it was given');
    expect(gitProblem(result)).toContain('everything it started was stopped');
    expect(Date.now() - started).toBeLessThan(25_000);

    // What was stopped is the tree: the invocation and its child are both gone.
    await expectGone(record.pid);
    await expectGone(record.child ?? 0);
  }, 60_000);

  it('gives each reading what is left of the run, not the budget its step started with', async () => {
    const source = await createSource();
    const fake = await installFakeGit(source.parent);
    // The run's deadline is two seconds away, and a second and a half passes
    // between the two readings: the second runs under what is left of the
    // deadline — half a second — and not under the whole budget the first had.
    const clock = new Date();
    const bounds = { deadlineMs: clock.getTime() + 2000, now: () => clock };

    const first = await withFakeGit(fake, { id: 'first', mode: 'hang' }, () =>
      runGit(['status'], source.repo, bounds),
    );
    registerFixture(await readFakeGitRecord(fake.state, 'first'));
    clock.setTime(clock.getTime() + 1500);
    const second = await withFakeGit(fake, { id: 'second', mode: 'hang' }, () =>
      runGit(['status'], source.repo, bounds),
    );
    registerFixture(await readFakeGitRecord(fake.state, 'second'));

    expect(first.outcome).toBe('timed-out');
    expect(first.timeoutMs).toBe(2000);
    expect(second.outcome).toBe('timed-out');
    expect(second.timeoutMs).toBe(500);
  }, 60_000);

  it('stops a hanging command when the run is stopped, and says which stop it was', async () => {
    const source = await createSource();
    const fake = await installFakeGit(source.parent);
    const controller = new AbortController();
    const clock = new Date();

    const pending = withFakeGit(fake, { id: 'cancelled', mode: 'hang' }, () =>
      runGit(['status'], source.repo, {
        deadlineMs: clock.getTime() + 60_000,
        now: () => clock,
        stop: controller.signal,
      }),
    );
    const record = await readFakeGitRecord(fake.state, 'cancelled');
    registerFixture(record);
    controller.abort();
    const result = await pending;

    expect(result.outcome).toBe('stopped');
    expect(result.termination).toBe('confirmed');
    expect(result.terminationProblem).toBeNull();
    expect(gitProblem(result)).toBe(
      'it was stopped because the run was stopped by its caller, and everything it started was stopped',
    );
    await expectGone(record.pid);
    await expectGone(record.child ?? 0);
  }, 60_000);

  // Windows-only by construction: this scenario defeats the stop by emptying
  // PATH, so the harness cannot find `taskkill` — the utility Windows stops a
  // tree with. On POSIX the harness signals the invocation's process group
  // directly (`process.kill(-pid)`), which needs no utility to be found, so the
  // stop succeeds and there is no unconfirmed stop to report.
  it.skipIf(process.platform !== 'win32')(
    'reports a stop it could not confirm, which is what makes a copy unsafe to reuse',
    async () => {
      const source = await createSource();
      const fake = await installFakeGit(source.parent);
      const previousPath = process.env.PATH;
      const previousConfig = process.env.FAKE_GIT;
      const clock = new Date();
      process.env.PATH = `${fake.bin}${path.delimiter}${previousPath ?? ''}`;
      process.env.FAKE_GIT = JSON.stringify({
        stateDir: fake.state.dir,
        mode: 'hang',
        id: 'stubborn',
      });
      const pending = runGit(['status'], source.repo, {
        deadlineMs: clock.getTime() + 3000,
        now: () => clock,
      });
      const record = await readFakeGitRecord(fake.state, 'stubborn');
      registerFixture(record);

      // The stand-in is named and still starting; the harness cannot find the
      // utility it stops a tree with, so the stop does not happen at all.
      process.env.PATH = '';
      let result: GitResult;
      try {
        result = await pending;
        expect(stillRunning(record.pid)).toBe(true);
      } finally {
        putBack('PATH', previousPath);
        putBack('FAKE_GIT', previousConfig);
      }

      expect(result.outcome).toBe('timed-out');
      expect(result.termination).toBe('unconfirmed');
      expect(result.terminationProblem).not.toBeNull();
      expect(gitStopOf(result)).toEqual({
        termination: 'unconfirmed',
        problem: result.terminationProblem,
      });
      expect(gitProblem(result)).toContain('that stop could not be confirmed');
    },
    60_000,
  );
});

describe('workspace steps that use Git', () => {
  it('stops a hanging preparation step at the run deadline, and keeps the run', async () => {
    const source = await createSource();
    const preflight = await preflightSource({ repoPath: source.repo, workDir: source.workDir });
    const run = await allocateRunDirectory(source.workDir);
    const fake = await installFakeGit(source.parent);
    const started = Date.now();
    const clock = new Date();

    const error = await failureOf(() =>
      withFakeGit(fake, { id: 'prepare', mode: 'hang' }, () =>
        prepareWorkspace(run, preflight, {
          deadlineMs: clock.getTime() + 3000,
          now: () => clock,
        }),
      ),
    );
    const record = await readFakeGitRecord(fake.state, 'prepare');
    registerFixture(record);

    // The step was stopped at the run's own remaining time, and that stop is on
    // the error: the runner that reads it can carry an unconfirmed one into the
    // run's evidence instead of reporting a clean end.
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toContain('did not finish within');
    expect((error as WorkspaceError).stop).toEqual({ termination: 'confirmed', problem: null });
    expect(error.message).toContain(
      `The incomplete run directory was kept for inspection: "${run.runDir}"`,
    );

    // What preparation wrote is kept, and none of it is a usable working copy.
    expect(existsSync(run.runDir)).toBe(true);
    expect(existsSync(run.logsDir)).toBe(true);
    expect(existsSync(path.join(run.workspacePath, '.git'))).toBe(false);
    // The source checkout is untouched: the step ran there and was stopped.
    expect((await gitOrFail(['rev-parse', '--verify', 'HEAD'], source.repo)).trim()).toBe(
      preflight.baseCommit,
    );
    expect(Date.now() - started).toBeLessThan(25_000);
    await expectGone(record.pid);
  }, 60_000);

  it('ends a final comparison that hangs at its bound, with the stop it recorded', async () => {
    const prepared = await createPreparedWorkspace();
    const fake = await installFakeGit(prepared.parent);
    const clock = new Date();

    const error = await failureOf(() =>
      withFakeGit(fake, { id: 'inspect', mode: 'hang' }, () =>
        inspectWorkspaceChanges(prepared.workspace, {
          deadlineMs: clock.getTime() + 3000,
          now: () => clock,
        }),
      ),
    );
    const record = await readFakeGitRecord(fake.state, 'inspect');
    registerFixture(record);

    // The comparison could not be made, and it says which stop it was rather
    // than reporting an empty list — which is what the run's report records as
    // a diagnostic instead of never finishing.
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).toContain('could not be compared with its recorded base');
    expect(error.message).toContain('did not finish within the 3000 ms it was given');
    expect((error as WorkspaceError).stop).toEqual({
      termination: 'confirmed',
      problem: null,
    });
    await expectGone(record.pid);
  }, 60_000);
});
