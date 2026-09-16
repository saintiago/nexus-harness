/**
 * Cancellation and confirmed process shutdown, with real processes.
 *
 * Every run here is real: a temporary Git repository is cloned into a run
 * directory, the configured commands are real child processes started in that
 * clone, and the report and the logs are read back from disk. The fixture
 * programs say what they are doing as they do it — they record their own PIDs as
 * soon as they are running, and a timestamped beat while they run — so these
 * tests assert what the operating system did from what the fixture processes left
 * behind, rather than from what the harness intended.
 *
 * The stop in each test is the one a caller gives a run: an abort signal on the
 * run's ordinary execution context. What is asserted afterwards is that the work
 * the run owned really ended, that the run awaited it before it finalized, that
 * the reason it recorded is the one it observed first, and that nothing was
 * started after it — no later command, no later check round, no later coding
 * turn. A stop the harness cannot confirm is asserted as the limitation it is:
 * the fixture processes really are still running, the report says so, and nothing
 * claims the working copy is safe to reuse.
 *
 * Only PIDs a fixture recorded for itself are ever terminated, and each is
 * registered for cleanup as soon as it is known, so a test that fails half-way
 * leaves nothing running. See docs/tasks.md T09.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheckRound, runCommand } from '../src/checks.js';
import { appendRunLog, openAgentLog, writeRunReport } from '../src/report.js';
import { runTask } from '../src/runner.js';
import type { AgentTurnResult, RunnerDependencies } from '../src/runner.js';
import { allocateRunDirectory, prepareWorkspace, preflightSource } from '../src/workspace.js';
import type { Command, HarnessConfig, RunReport, Task } from '../src/types.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

/**
 * The fixture processes of these tests, by PID: a stop a test means to prove is
 * stopped here too, so a test that fails half-way cannot leave a hanging fixture
 * behind for the rest of the run. See {@link registerFixture}.
 */
const fixtureProcesses = new Set<number>();

/**
 * Ends the recorded fixture processes, by PID and with the host's own utility
 * named by absolute path, so the cleanup does not depend on the PATH a test may
 * have left behind. Only PIDs the fixtures recorded for themselves are named.
 */
function stopFixtureProcesses(): void {
  for (const pid of fixtureProcesses) {
    if (process.platform === 'win32') {
      const taskkill = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'taskkill.exe',
      );
      if (existsSync(taskkill)) {
        spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        continue;
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone: nothing to clean up.
    }
  }
  fixtureProcesses.clear();
}

afterEach(async () => {
  stopFixtureProcesses();
  await cleanupTempDirectories();
});

/**
 * Remembers fixture PIDs for the end of the test. Called as soon as a fixture has
 * recorded them, before any assertion, so an assertion that fails still leaves
 * nothing running.
 */
function registerFixture(parts: { readonly pid: number; readonly child: number | null }): void {
  fixtureProcesses.add(parts.pid);
  if (parts.child !== null) {
    fixtureProcesses.add(parts.child);
  }
}

/** A private Git environment, so the developer's own Git settings cannot decide a test. */
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

function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<{ readonly code: number | null; readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      // Each fixture process leads its own process group on POSIX, exactly as
      // the harness's own commands do, so a test can stop the whole tree by
      // addressing the negated PID. Without this the group does not exist and
      // the stop in these tests would silently reach nothing.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/** Runs `git` with literal arguments, in the fixture environment. */
function git(
  args: readonly string[],
  cwd: string,
): Promise<{ readonly code: number | null; readonly stdout: string }> {
  return runProcess('git', args, { cwd, env: fixtureEnvironment });
}

/** The source checkout's own state: its committed HEAD and what is uncommitted there. */
async function sourceState(
  repo: string,
): Promise<{ readonly head: string; readonly status: string }> {
  const head = await git(['rev-parse', 'HEAD'], repo);
  const status = await git(['status', '--porcelain'], repo);
  return { head: head.stdout.trim(), status: status.stdout.trim() };
}

function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

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

/** The two PIDs of one fixture, as they are asserted about once it is stopped. */
async function expectTreeGone(record: PidRecord): Promise<void> {
  await expectGone(record.pid);
  if (record.child !== null) {
    await expectGone(record.child);
  }
}

/**
 * The flag file whose presence in a working copy makes the configured checks
 * hang, and the one that makes them exit nonzero. A run's baseline is green while
 * both are absent; the run's own coding turns leave them behind, so the same
 * configured command is a passing check before a turn, a hanging one after the
 * turn that leaves the first, and a red one after the turn that leaves the second.
 */
const HANG_FLAG = 'hang-now.txt';
const RED_FLAG = 'red-now.txt';

/** How long a hanging fixture waits before it gives up and exits by itself. */
const BACKSTOP_MS = 30_000;

/**
 * The fixture program of a configured setup/check command. It records its own PID
 * and its child's as soon as it is running, says what it is doing through
 * timestamped beats, and hangs — with a child of its own, which is the difference
 * between stopping a process and stopping the tree behind it — while the hang flag
 * is present in the directory named by the `workspace` argument. `-` as that file
 * means "hang in any working copy", which is what a test about one command uses.
 * While the red flag is present instead it prints and exits nonzero, which is an
 * ordinary red check; with neither present it prints and exits `0`.
 */
const CHECK_SOURCE = [
  "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
  "import { spawn } from 'node:child_process';",
  "import path from 'node:path';",
  '',
  'const [, , id, pidFile, beatsFile, workspace, flagFile, redFile, holdsForMs] = process.argv;',
  "const record = (event) => appendFileSync(beatsFile, `${JSON.stringify({ event, id, at: Date.now() })}\\n`, 'utf8');",
  "const isChild = id.endsWith('-child');",
  "const hangs = isChild || flagFile === '-' || existsSync(path.join(workspace, flagFile));",
  'const red = !hangs && existsSync(path.join(workspace, redFile));',
  '',
  'if (!hangs) {',
  "  record('start');",
  '  // The exit code is set rather than forced, so what this wrote is flushed',
  '  // before the process ends: a red check is not a check with no output.',
  '  process.stdout.write(red ? `failed ${id}\\n` : `ran ${id}\\n`);',
  "  record('end');",
  '  process.exitCode = red ? 3 : 0;',
  '} else {',
  '  const child = isChild',
  '    ? null',
  "    : spawn(process.execPath, [process.argv[1], `${id}-child`, pidFile, beatsFile, workspace, flagFile, redFile, holdsForMs], { stdio: 'ignore' });",
  "  writeFileSync(`${pidFile}.${id}`, JSON.stringify({ pid: process.pid, child: child?.pid ?? null }), 'utf8');",
  "  record('start');",
  '  process.stdout.write(`ran ${id}\\n`);',
  "  record('hanging');",
  "  setInterval(() => record('beating'), 50);",
  '  // A backstop: a fixture that outlives its test still ends on its own.',
  '  setTimeout(() => process.exit(0), Number(holdsForMs));',
  '}',
  '',
].join('\n');

/**
 * The stand-in coding turn: a real process that leaves the implementation's mark
 * in the working copy and, while it works, manages a child of its own — so there
 * is a tree behind a running turn that a runtime has to stop before it returns. A
 * hold of zero posts the mark and returns at once, with no child and nothing
 * armed, which is what a turn that completes on its own looks like.
 */
const TURN_SOURCE = [
  "import { appendFileSync, writeFileSync } from 'node:fs';",
  "import { spawn } from 'node:child_process';",
  "import path from 'node:path';",
  '',
  'const [, , id, pidFile, beatsFile, workspace, flagFile, holdsForMs] = process.argv;',
  "const record = (event) => appendFileSync(beatsFile, `${JSON.stringify({ event, id, at: Date.now() })}\\n`, 'utf8');",
  'const hold = Number(holdsForMs);',
  "const isChild = id.endsWith('-child');",
  'const child =',
  '  isChild || hold <= 0',
  '    ? null',
  "    : spawn(process.execPath, [process.argv[1], `${id}-child`, pidFile, beatsFile, workspace, flagFile, holdsForMs], { stdio: 'ignore' });",
  "writeFileSync(`${pidFile}.${id}`, JSON.stringify({ pid: process.pid, child: child?.pid ?? null }), 'utf8');",
  "record('start');",
  'process.stdout.write(`turn ${id}: working in ${workspace}\\n`);',
  '// What the implementation leaves behind: the mark that makes the checks the',
  "// harness runs next hang, so a stop has something of the run's own to reach.",
  "if (!isChild && flagFile !== '-') writeFileSync(path.join(workspace, flagFile), 'the implementation turn made the checks hang\\n');",
  '',
  'if (hold > 0) {',
  "  setInterval(() => record('beating'), 50);",
  '  setTimeout(() => process.exit(0), hold);',
  '}',
  '',
].join('\n');

interface Beat {
  readonly event: 'start' | 'end' | 'hanging' | 'beating';
  readonly id: string;
  readonly at: number;
}

interface PidRecord {
  readonly pid: number;
  readonly child: number | null;
}

interface Fixture {
  /** Temporary directory holding the repository, the runs, and the programs. */
  readonly parent: string;
  /** The source repository: one commit, and a clean checkout of it. */
  readonly repo: string;
  /** Output directory for run directories, a sibling of the repository. */
  readonly workDir: string;
  /** The program a configured setup/check command runs. */
  readonly check: string;
  /** The program the stand-in coding turn runs. */
  readonly turn: string;
  /** Where a fixture records its own PID and its child's. */
  readonly pidFile: string;
  /** One JSON beat per line, with the time it was written. */
  readonly beatsFile: string;
  /** The task a run is asked to complete. */
  readonly task: Task;
}

/**
 * A temporary target repository with a clean committed baseline, and the two
 * fixture programs. `hangFromBase` commits the flag file, which is how a run's
 * own baseline is made to hang before any coding turn.
 */
async function createFixture(options: { readonly hangFromBase?: boolean } = {}): Promise<Fixture> {
  const parent = await createTempDir();
  const repo = path.join(parent, 'repo');
  await mkdir(repo);
  await runProcess('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: repo,
    env: fixtureEnvironment,
  });
  // The target project's bytes are the ones the fixture wrote, on any host.
  await writeFile(path.join(repo, '.gitattributes'), '* -text\n', 'utf8');
  await writeFile(path.join(repo, 'app.txt'), 'the committed baseline\n', 'utf8');
  await writeFile(path.join(repo, 'README.md'), 'a tiny target project\n', 'utf8');
  if (options.hangFromBase === true) {
    await writeFile(path.join(repo, HANG_FLAG), 'this project hangs its checks\n', 'utf8');
  }
  await git(['add', '--all'], repo);
  await git(['commit', '--quiet', '--message', 'baseline'], repo);

  const check = path.join(parent, 'check.mjs');
  await writeFile(check, CHECK_SOURCE, 'utf8');
  const turn = path.join(parent, 'turn.mjs');
  await writeFile(turn, TURN_SOURCE, 'utf8');

  return {
    parent,
    repo,
    workDir: path.join(parent, 'runs'),
    check,
    turn,
    pidFile: path.join(parent, 'pids'),
    beatsFile: path.join(parent, 'beats.jsonl'),
    task: {
      id: 'tiny-003',
      title: 'Append a line to app.txt',
      description: 'Add one line to the target project, using its existing conventions.',
      acceptanceCriteria: ['app.txt keeps its committed content.', 'app.txt holds the new line.'],
    },
  };
}

/**
 * One configured command that runs the check program under `id`. `where` is the
 * directory the program looks in for the flag file: the command's own working
 * directory by default, or a named one for a test about a single command.
 */
function checkCommand(fixture: Fixture, id: string, where = '.'): Command {
  return [
    process.execPath,
    fixture.check,
    id,
    fixture.pidFile,
    fixture.beatsFile,
    where,
    HANG_FLAG,
    RED_FLAG,
    String(BACKSTOP_MS),
  ];
}

/** The configuration a run is given: one command, in setup or in the checks. */
function configuration(fixture: Fixture, parts: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    workDir: fixture.workDir,
    maxRepairs: 2,
    taskTimeoutMinutes: 60,
    commandTimeoutMinutes: 10,
    setup: [],
    checks: [checkCommand(fixture, 'check-one')],
    // The coding turn is stood in for in this suite, so the selection is the
    // documented default: the runner records it and never starts it.
    agent: { runtime: 'codex', command: ['codex'] },
    ...parts,
  };
}

/** The runner's real collaborators, with the stand-in coding turn the given one. */
function dependencies(
  turn: RunnerDependencies['runAgentTurn'],
  parts: Partial<RunnerDependencies> = {},
): RunnerDependencies {
  return {
    preflight: preflightSource,
    allocateRunDirectory,
    prepareWorkspace,
    runCheckRound,
    openAgentLog,
    appendRunLog,
    writeRunReport,
    now: () => new Date(),
    runAgentTurn: turn,
    ...parts,
  };
}

/** Every beat the fixture processes recorded so far, in the order they wrote them. */
async function beats(fixture: Fixture): Promise<Beat[]> {
  if (!existsSync(fixture.beatsFile)) {
    return [];
  }
  return (await readText(fixture.beatsFile))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Beat);
}

/** The beats one fixture process recorded, by the ID it was given. */
async function beatsOf(fixture: Fixture, id: string): Promise<Beat[]> {
  return (await beats(fixture)).filter((beat) => beat.id === id);
}

/**
 * Waits, bounded, for a fixture to record its own PIDs: that record is the
 * readiness signal these tests coordinate on, so nothing here waits a fixed time
 * hoping that a process has started. The PIDs are registered for cleanup before
 * they are returned, which is before any assertion about them.
 *
 * What is waited for is the complete record, not the file: the file appears when
 * it is opened, and a reader that arrives between the open and the write sees a
 * name with nothing in it. A record that never becomes readable still fails this
 * test, with the same explanation as one that never appears.
 */
async function fixtureRecorded(fixture: Fixture, id: string): Promise<PidRecord> {
  const file = `${fixture.pidFile}.${id}`;
  let read = '';
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (existsSync(file)) {
      read = await readText(file);
      try {
        const record = JSON.parse(read) as PidRecord;
        registerFixture(record);
        return record;
      } catch {
        // Half-written: the fixture is still writing its record.
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
    await pause(20);
  }
  throw new Error(
    `the fixture "${id}" never recorded its PIDs in ${file}` +
      (read === '' ? '' : `; it was left holding ${JSON.stringify(read)}`),
  );
}

/**
 * Waits, bounded, for one fixture process to record a beat, and returns it.
 *
 * The PID file is written before the beats that follow it, so it is a signal that
 * the process is running, not that a later beat exists yet: asserting on a beat
 * as soon as the PID file appears can read the beat file in the window between
 * the two, which a loaded machine widens. Waiting for the beat itself is waiting
 * on the condition the assertion is about, so a beat that really never arrives
 * fails this test rather than passing it by luck.
 */
async function fixtureBeat(fixture: Fixture, id: string, event: Beat['event']): Promise<Beat> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const beat = (await beatsOf(fixture, id)).find((one) => one.event === event);
    if (beat !== undefined) {
      return beat;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the fixture "${id}" never recorded a "${event}" beat in ${fixture.beatsFile}`,
      );
    }
    await pause(10);
  }
}

/** The written report, parsed: these tests read what the run left on disk. */
async function readReport(file: string): Promise<RunReport> {
  return JSON.parse(await readText(file)) as RunReport;
}

/** The timeline's messages, without the timestamp each line starts with. */
function timelineMessages(text: string): string[] {
  return text
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^\S+ /, ''));
}

/**
 * Waits for a stop request to arrive, so a test stops its own fixture only once
 * the harness has asked it to. The fallback bounds the test rather than the run:
 * a request that never arrives fails on the assertion that follows instead of
 * hanging.
 */
function stopRequested(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
    setTimeout(resolve, 15_000).unref();
  });
}

/**
 * Ends one process tree a test started itself. Only a PID this test recorded for
 * a process it started is named here, and nothing outside the fixture is touched.
 */
function stopOwnTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone: nothing left to stop.
  }
}

describe('a run its caller stops, for real', () => {
  it('stops a baseline command and the tree behind it, and starts nothing after it', async () => {
    const fixture = await createFixture({ hangFromBase: true });
    const controller = new AbortController();
    const before = await sourceState(fixture.repo);
    const turns: string[] = [];

    const running = runTask(
      {
        task: fixture.task,
        // The hanging command is the baseline's own setup, so the stop lands
        // there and no check is ever reached.
        config: configuration(fixture, { setup: [checkCommand(fixture, 'setup-one')] }),
        repoPath: fixture.repo,
        workDir: fixture.workDir,
        stop: controller.signal,
      },
      dependencies(async (asked) => {
        turns.push(asked.kind);
        return { summary: 'no coding turn was expected' };
      }),
    );

    // The command is running — it said so itself — and it started a child.
    const setup = await fixtureRecorded(fixture, 'setup-one');
    expect(stillRunning(setup.pid)).toBe(true);
    expect(setup.child).not.toBeNull();
    expect(await fixtureBeat(fixture, 'setup-one', 'hanging')).toEqual(
      expect.objectContaining({ id: 'setup-one', event: 'hanging' }),
    );

    controller.abort();
    const result = await running;

    // The invocation and the child it started are gone: the stop reached the
    // tree, and the run awaited that before it finalized.
    await expectTreeGone(setup);
    const lastBeat = (await beatsOf(fixture, 'setup-one')).at(-1);
    await pause(300);
    expect((await beatsOf(fixture, 'setup-one')).at(-1)).toEqual(lastBeat);

    expect(result.status).toBe('cancelled');
    expect(result.timeout).toBeNull();
    expect(result.cancellation).toEqual({
      phase: 'the baseline checks',
      elapsedMs: expect.any(Number),
      termination: 'confirmed',
      problem: null,
    });
    expect(result.reason).toBe(
      'the run was stopped by its caller during the baseline checks: nothing further was started',
    );

    // Nothing was started after the stop: no check, no coding turn, no repair.
    expect(turns).toEqual([]);
    expect(await beatsOf(fixture, 'check-one')).toEqual([]);
    expect(existsSync(path.join(result.run.logsDir, 'baseline-check-1.stdout.log'))).toBe(false);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.timeout).toBeNull();
    expect(report.cancellation).toEqual(result.cancellation);
    expect(report.attempts).toEqual([]);
    expect(report.repairsUsed).toBe(0);
    // The baseline that was stopped is kept as the evidence it is: the command
    // really ran, what it wrote is still on disk, and the round says what stopped
    // it rather than pretending a check failed.
    expect(report.baseline?.outcome).toBe('execution-error');
    expect(report.baseline?.setup[0]?.outcome).toBe('stopped');
    expect(report.baseline?.setup[0]?.termination).toBe('confirmed');
    expect(report.baseline?.checks).toEqual([]);
    expect(report.baseline?.problem).toContain(
      'was stopped because the run was stopped by its caller',
    );
    expect(report.baseline?.problem).toContain('not a failed check to repair');
    expect(await readText(report.baseline?.setup[0]?.stdoutPath ?? '')).toBe('ran setup-one\n');

    // The working copy is kept, and the source checkout was not touched by any of
    // it: the run's own clone is the only thing that changed.
    expect(existsSync(path.join(result.run.workspacePath, '.git'))).toBe(true);
    expect(existsSync(path.join(result.run.workspacePath, HANG_FLAG))).toBe(true);
    expect(await sourceState(fixture.repo)).toEqual(before);
    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline).toContain(
      'cancelled: the run was stopped by its caller during the baseline checks',
    );
    expect(timeline.at(-1)).toMatch(/^final status: cancelled, the run was stopped by its caller/);
  }, 90_000);

  it('stops the check a turn left hanging, and runs no further round or turn', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const before = await sourceState(fixture.repo);

    const running = runTask(
      {
        task: fixture.task,
        config: configuration(fixture),
        repoPath: fixture.repo,
        workDir: fixture.workDir,
        stop: controller.signal,
      },
      dependencies(async (asked) => {
        // The implementation: a real process that leaves the mark the checks hang
        // on behind it, then returns by itself with nothing armed.
        const spawned = await runProcess(
          process.execPath,
          [
            fixture.turn,
            `turn-${String(asked.turn)}`,
            fixture.pidFile,
            fixture.beatsFile,
            asked.workspacePath,
            HANG_FLAG,
            '0',
          ],
          { cwd: asked.workspacePath },
        );
        expect(spawned.code).toBe(0);
        return { summary: `the implementation turn edited ${HANG_FLAG}` };
      }),
    );

    // The check the implementation made hang is running, with a child of its own,
    // and it has beat at least once: the PID file precedes the beats, so the
    // heartbeat the assertion below reads is waited for here rather than assumed.
    const check = await fixtureRecorded(fixture, 'check-one');
    expect(stillRunning(check.pid)).toBe(true);
    expect(check.child).not.toBeNull();
    await fixtureBeat(fixture, 'check-one', 'beating');

    controller.abort();
    const result = await running;
    await expectTreeGone(check);

    // The last beat precedes the written report: the process that would have
    // written more was already gone when the run finalized, and nothing of it
    // wrote anything afterwards.
    const lastBeat = (await beatsOf(fixture, 'check-one')).at(-1);
    expect(lastBeat?.event).toBe('beating');
    await pause(300);
    expect((await beatsOf(fixture, 'check-one')).at(-1)).toEqual(lastBeat);
    expect(lastBeat?.at).toBeLessThanOrEqual(statSync(result.reportPath).mtimeMs);

    expect(result.status).toBe('cancelled');
    expect(result.timeout).toBeNull();
    expect(result.cancellation?.phase).toBe('the checks after the implementation turn');
    expect(result.cancellation?.termination).toBe('confirmed');
    expect(result.cancellation?.problem).toBeNull();
    expect(result.reason).toBe(
      'the run was stopped by its caller during the checks after the implementation turn: ' +
        'nothing further was started',
    );

    // The stopped round is kept as that turn's evidence, and nothing followed it:
    // no second check round, no repair turn, no later check command.
    expect(existsSync(path.join(result.run.logsDir, 'attempt-2-check-1.stdout.log'))).toBe(false);
    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.cancellation).toEqual(result.cancellation);
    expect(report.attempts).toHaveLength(1);
    const observed = report.attempts[0]?.checks;
    expect(observed?.outcome).toBe('execution-error');
    expect(observed?.checks[0]?.outcome).toBe('stopped');
    expect(observed?.checks[0]?.termination).toBe('confirmed');
    expect(await readText(observed?.checks[0]?.stdoutPath ?? '')).toBe('ran check-one\n');
    expect(report.attempts[0]?.agentSummary).toBe(`the implementation turn edited ${HANG_FLAG}`);
    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline.filter((line) => line.startsWith('post-agent check-round'))).toHaveLength(2);
    expect(timeline.join('\n')).not.toContain('repair turn');
    expect(timeline.at(-1)).toMatch(/^final status: cancelled, the run was stopped by its caller/);

    // The working copy keeps the implementation's own work, and the source
    // checkout has none of it.
    expect(existsSync(path.join(result.run.workspacePath, HANG_FLAG))).toBe(true);
    expect(existsSync(path.join(fixture.repo, HANG_FLAG))).toBe(false);
    expect(await sourceState(fixture.repo)).toEqual(before);
  }, 90_000);

  it('stops the implementation turn, awaits the tree behind it, and keeps what it did', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();

    const running = runTask(
      {
        task: fixture.task,
        config: configuration(fixture),
        repoPath: fixture.repo,
        workDir: fixture.workDir,
        stop: controller.signal,
      },
      dependencies(async (asked) => {
        const id = `turn-${String(asked.turn)}`;
        const spawned = runProcess(
          process.execPath,
          [
            fixture.turn,
            id,
            fixture.pidFile,
            fixture.beatsFile,
            asked.workspacePath,
            HANG_FLAG,
            String(BACKSTOP_MS),
          ],
          { cwd: asked.workspacePath },
        );
        asked.agentLog.write(`the implementation turn started as ${id}\n`);

        // The turn is working, with a child that is working too. The caller stops
        // the run while it is, and the runtime that owns this execution stops it
        // and waits until it is gone before it returns — which is the boundary a
        // check round may start after.
        const turn = await fixtureRecorded(fixture, id);
        expect(stillRunning(turn.pid)).toBe(true);
        // Only the baseline has run so far: one green check, before this turn.
        expect((await beatsOf(fixture, 'check-one')).map((beat) => beat.event)).toEqual([
          'start',
          'end',
        ]);
        controller.abort();
        await stopRequested(asked.stop);
        stopOwnTree(turn.pid);
        await expectTreeGone(turn);
        asked.agentLog.write('the turn stopped the tree it manages, and it is gone\n');
        const finished = await spawned;
        expect(finished.code).not.toBe(0);
        return {
          summary: 'the implementation turn stopped when the run was stopped',
        } satisfies AgentTurnResult;
      }),
    );

    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(result.timeout).toBeNull();
    expect(result.cancellation?.phase).toBe('implementation turn');
    expect(result.cancellation?.termination).toBe('confirmed');
    expect(result.reason).toBe(
      'the implementation turn was stopped because the run was stopped by its caller, so no ' +
        'check was run after it and no further turn was started',
    );

    // Nothing ran after the stopped turn. The only check beats are the baseline's
    // own green one, from before the turn, and no other command ever started.
    expect((await beatsOf(fixture, 'check-one')).map((beat) => beat.event)).toEqual([
      'start',
      'end',
    ]);
    expect(await beatsOf(fixture, 'setup-one')).toEqual([]);
    expect(await readdir(result.run.logsDir)).not.toContain('attempt-1-setup-1.stdout.log');
    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.checks).toBeNull();
    expect(report.attempts[0]?.agentSummary).toBe(
      'the implementation turn stopped when the run was stopped',
    );
    // The turn's own log says what happened and in what order: the execution it
    // manages was gone before the run finalized, not merely asked to stop.
    const transcript = await readText(report.attempts[0]?.agentLog ?? '');
    expect(transcript).toContain('the implementation turn started as turn-1');
    expect(transcript).toContain('the turn stopped the tree it manages, and it is gone');
    expect(transcript.indexOf('it is gone')).toBeGreaterThan(transcript.indexOf('started as'));
    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline.filter((line) => line.startsWith('post-agent'))).toEqual([]);
    expect(timeline.at(-1)).toMatch(
      /^final status: cancelled, the implementation turn was stopped/,
    );
    // The working copy is kept for inspection.
    expect(existsSync(path.join(result.run.workspacePath, '.git'))).toBe(true);
    expect(existsSync(path.join(result.run.workspacePath, HANG_FLAG))).toBe(true);
  }, 90_000);

  it('stops the repair turn of a red run, and runs no check round after it', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const before = await sourceState(fixture.repo);
    const phases: string[] = [];

    const running = runTask(
      {
        task: fixture.task,
        config: configuration(fixture),
        repoPath: fixture.repo,
        workDir: fixture.workDir,
        stop: controller.signal,
      },
      dependencies(async (asked) => {
        phases.push(`${asked.kind} ${String(asked.turn)}`);
        if (asked.kind === 'implementation') {
          // The implementation leaves the mark that makes the checks red — so the
          // run has a completed red round to repair — and returns by itself.
          const spawned = await runProcess(
            process.execPath,
            [
              fixture.turn,
              'turn-1',
              fixture.pidFile,
              fixture.beatsFile,
              asked.workspacePath,
              RED_FLAG,
              '0',
            ],
            { cwd: asked.workspacePath },
          );
          expect(spawned.code).toBe(0);
          return { summary: 'the implementation turn made the checks red' };
        }

        // The repair turn: it was given the red round to repair, and it is a real
        // process with a child of its own when the caller stops the run.
        expect(asked.repair?.failures).toHaveLength(1);
        const id = `turn-${String(asked.turn)}`;
        const spawned = runProcess(
          process.execPath,
          [
            fixture.turn,
            id,
            fixture.pidFile,
            fixture.beatsFile,
            asked.workspacePath,
            HANG_FLAG,
            String(BACKSTOP_MS),
          ],
          { cwd: asked.workspacePath },
        );
        asked.agentLog.write(`the repair turn started as ${id}\n`);
        const turn = await fixtureRecorded(fixture, id);
        expect(stillRunning(turn.pid)).toBe(true);
        controller.abort();
        await stopRequested(asked.stop);
        stopOwnTree(turn.pid);
        await expectTreeGone(turn);
        asked.agentLog.write('the repair turn stopped the tree it manages, and it is gone\n');
        expect((await spawned).code).not.toBe(0);
        return { summary: 'the repair turn stopped when the run was stopped' };
      }),
    );

    const result = await running;

    // Both turns really were spent, the repair last, and the run ends where it
    // stopped rather than at the red round it was repairing.
    expect(phases).toEqual(['implementation 1', 'repair 2']);
    expect(result.status).toBe('cancelled');
    expect(result.timeout).toBeNull();
    expect(result.cancellation?.phase).toBe('repair turn 2');
    expect(result.cancellation?.termination).toBe('confirmed');
    expect(result.reason).toBe(
      'repair turn 2 was stopped because the run was stopped by its caller, so no check was run ' +
        'after it and no further turn was started',
    );

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['implementation', 'repair']);
    // The red round the repair turn was given is kept as observed evidence, with
    // the output the failing check wrote; the stopped turn has no round at all.
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');
    expect(report.attempts[0]?.checks?.checks[0]?.exitCode).toBe(3);
    expect(await readText(report.attempts[0]?.checks?.checks[0]?.stdoutPath ?? '')).toBe(
      'failed check-one\n',
    );
    expect(report.attempts[1]?.checks).toBeNull();
    expect(report.attempts[1]?.agentSummary).toBe(
      'the repair turn stopped when the run was stopped',
    );
    // No round was started after the stopped turn: the second attempt's round
    // does not exist, and no command of it ever ran.
    const logs = await readdir(result.run.logsDir);
    expect(logs.filter((name) => name.startsWith('attempt-2-'))).toEqual([]);
    expect((await beatsOf(fixture, 'check-one')).map((beat) => beat.event)).toEqual([
      'start',
      'end',
      'start',
      'end',
    ]);
    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline.filter((line) => line.startsWith('post-agent check-round'))).toHaveLength(2);
    expect(timeline).toContain('repair turn 2 started: repair 1 of 2 allowed');
    expect(timeline.at(-1)).toMatch(/^final status: cancelled, repair turn 2 was stopped/);

    // What both turns wrote is kept for inspection, and none of it reached the
    // source checkout.
    expect(existsSync(path.join(result.run.workspacePath, RED_FLAG))).toBe(true);
    expect(existsSync(path.join(result.run.workspacePath, HANG_FLAG))).toBe(true);
    expect(existsSync(path.join(fixture.repo, RED_FLAG))).toBe(false);
    expect(existsSync(path.join(fixture.repo, HANG_FLAG))).toBe(false);
    expect(await sourceState(fixture.repo)).toEqual(before);
  }, 90_000);

  // Windows-only by construction: this scenario defeats the stop by emptying
  // PATH, so the harness cannot find `taskkill` â€” the utility Windows stops a
  // tree with. On POSIX the harness signals the invocation's process group
  // directly (`process.kill(-pid)`), which needs no utility to be found, so the
  // stop succeeds and there is nothing unconfirmed to report. The confirmed
  // stop every platform can reach is covered by the tests above.
  it.skipIf(process.platform !== 'win32')(
    'reports a stop it could not confirm, and never calls the copy safe to reuse',
    async () => {
      const fixture = await createFixture();
      const controller = new AbortController();
      const hostPath = process.env.PATH;

      const running = runTask(
        {
          task: fixture.task,
          config: configuration(fixture),
          repoPath: fixture.repo,
          workDir: fixture.workDir,
          stop: controller.signal,
        },
        dependencies(async (asked) => {
          // The implementation returns at once and leaves a host behind on which the
          // harness can no longer find the utility it stops a process tree with: the
          // stop is attempted, and cannot be carried out.
          await writeFile(
            path.join(asked.workspacePath, HANG_FLAG),
            'the checks will hang\n',
            'utf8',
          );
          process.env.PATH = '';
          return { summary: 'the implementation turn made the checks hang' };
        }),
      );

      let result: Awaited<typeof running>;
      try {
        const check = await fixtureRecorded(fixture, 'check-one');
        expect(stillRunning(check.pid)).toBe(true);
        controller.abort();
        result = await running;

        // The invocation and its child are still running: that is exactly why the
        // stop is unconfirmed, and why nothing may reuse the working copy.
        expect(stillRunning(check.pid)).toBe(true);
        if (check.child !== null) {
          expect(stillRunning(check.child)).toBe(true);
        }
      } finally {
        process.env.PATH = hostPath;
      }

      // The run did not pass, and did not claim a clean stop either.
      expect(result.status).toBe('cancelled');
      expect(result.status).not.toBe('passed');
      expect(result.timeout).toBeNull();
      expect(result.cancellation?.phase).toBe('the checks after the implementation turn');
      expect(result.cancellation?.termination).toBe('unconfirmed');
      expect(result.cancellation?.problem).not.toBeNull();
      expect(result.reason).toContain('the stop could not be confirmed');
      expect(result.reason).toContain('must not be reused');
      expect(result.reason).toContain('nothing further was started');

      const report = await readReport(result.reportPath);
      expect(report.status).toBe('cancelled');
      expect(report.cancellation).toEqual(result.cancellation);
      expect(report.cancellation?.problem).not.toBeNull();
      // The limitation is carried by the evidence as well as by the reason, and no
      // later round and no repair turn was started on a copy that may still be
      // written to.
      expect(report.attempts).toHaveLength(1);
      expect(report.attempts[0]?.checks?.outcome).toBe('execution-error');
      expect(report.attempts[0]?.checks?.checks[0]?.outcome).toBe('stopped');
      expect(report.attempts[0]?.checks?.checks[0]?.termination).toBe('unconfirmed');
      expect(report.attempts[0]?.checks?.problem).toContain('could not confirm');
      const timeline = timelineMessages(await readText(report.runLog));
      expect(timeline.join('\n')).toContain('termination unconfirmed');
      expect(timeline.filter((line) => line.startsWith('post-agent check-round'))).toHaveLength(2);
      expect(timeline.join('\n')).not.toContain('final status: passed');
    },
    90_000,
  );

  it('starts nothing at all when a round is handed a stop request that already arrived', async () => {
    const fixture = await createFixture({ hangFromBase: true });
    const base = await createTempDir();
    const workspace = path.join(base, 'workspace');
    const logsDir = path.join(base, 'logs');
    await mkdir(workspace, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    const controller = new AbortController();
    controller.abort();

    const round = await runCheckRound({
      setup: [checkCommand(fixture, 'setup-one')],
      checks: [checkCommand(fixture, 'check-one')],
      cwd: workspace,
      logsDir,
      name: 'attempt-1',
      commandTimeoutMs: 10 * 60_000,
      deadlineMs: Date.now() + 60 * 60_000,
      now: () => new Date(),
      stop: controller.signal,
    });

    expect(round.outcome).toBe('execution-error');
    expect(round.setup).toEqual([]);
    expect(round.checks).toEqual([]);
    expect(round.problem).toContain('stopped by its caller before setup command 1 of 1');
    expect(round.problem).toContain('not a failed check to repair');
    // Nothing was started: no process, no beat, and no log file to record it in.
    expect(await beats(fixture)).toEqual([]);
    expect(existsSync(fixture.beatsFile)).toBe(false);
    expect(await readdir(logsDir)).toEqual([]);
  }, 90_000);

  it('stops a single command that was already running when it was asked to stop', async () => {
    const fixture = await createFixture({ hangFromBase: true });
    const base = await createTempDir();
    const logsDir = path.join(base, 'logs');
    await mkdir(logsDir, { recursive: true });
    const controller = new AbortController();

    const running = runCommand({
      command: checkCommand(fixture, 'check-one', fixture.repo),
      cwd: base,
      logsDir,
      label: 'check-1',
      timeoutMs: 10 * 60_000,
      stop: controller.signal,
    });

    const command = await fixtureRecorded(fixture, 'check-one');
    controller.abort();
    const result = await running;

    expect(result.outcome).toBe('stopped');
    expect(result.termination).toBe('confirmed');
    expect(result.terminationProblem).toBeNull();
    await expectTreeGone(command);
    // An exit code the harness cut short says nothing about the command: what it
    // would have reported is not a check result, on any host.
    expect(result.exitCode).not.toBe(0);
    const lastBeat = (await beatsOf(fixture, 'check-one')).at(-1);
    await pause(300);
    expect((await beatsOf(fixture, 'check-one')).at(-1)).toEqual(lastBeat);
  }, 90_000);
});
