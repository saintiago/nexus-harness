/**
 * Command execution, setup/check rounds, and log tests.
 *
 * Every command here is a real, harmless child process started in a temporary
 * fixture directory: no network, no credentials, and nothing outside those
 * temporary directories is written or removed. The fixture programs report the
 * arguments, working directory, and environment they actually received, so these
 * tests assert what the operating system delivered rather than what the harness
 * intended to send. See docs/tasks.md T03 and T04 for the acceptance criteria.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandSucceeded, runCheckRound, runCommand } from '../src/checks.js';
import { ReportError, appendRunLog, openCommandLog, runLogPath } from '../src/report.js';
import type { CheckRoundResult, Command, CommandResult } from '../src/types.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

/**
 * The fixture processes of the timeout tests, by PID: a stop that a test means
 * to prove is stopped here too, so a test that fails half-way cannot leave a
 * hanging fixture behind for the rest of the run. See {@link registerFixture}.
 */
const fixtureProcesses = new Set<number>();

/**
 * Ends the recorded fixture processes, by PID and with the host's own utility
 * named by absolute path, so the cleanup does not depend on the PATH a test left
 * behind. Only PIDs the fixtures recorded for themselves are ever named.
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
  // Awaited, so the removal really finishes before the next test starts and
  // nothing is left in the temporary directory at the end of a run.
  await cleanupTempDirectories();
});

/**
 * Remembers fixture PIDs for the end of the test. Called as soon as a fixture
 * has recorded them, before any assertion, so an assertion that fails still
 * leaves nothing running.
 */
function registerFixture(parts: { readonly pid: number; readonly child: number | null }): void {
  fixtureProcesses.add(parts.pid);
  if (parts.child !== null) {
    fixtureProcesses.add(parts.child);
  }
}

/**
 * The limit an ordinary command test runs its fixture under: ten minutes, so it
 * never expires during an assertion. Every invocation in this file is bounded by
 * something, exactly as a configured command is, and the tests about the limit
 * itself supply their own short one instead.
 */
const TEST_LIMIT_MS = 10 * 60_000;

/** The task deadline the ordinary round tests hand `runCheckRound`. */
function roundBounds(): { commandTimeoutMs: number; deadlineMs: number; now: () => Date } {
  return {
    commandTimeoutMs: TEST_LIMIT_MS,
    deadlineMs: Date.now() + 60 * 60_000,
    now: () => new Date(),
  };
}

/**
 * The fixture program: it prints what it received, so a test can tell the
 * configured argument array apart from anything an interpreter, a shell, or an
 * environment expansion might have made of it.
 */
const DUMP_SOURCE = [
  'const report = {',
  '  argv: process.argv.slice(2),',
  '  cwd: process.cwd(),',
  '  secret: process.env.NEXUS_TEST_SECRET ?? null,',
  '};',
  'process.stdout.write(`${JSON.stringify(report)}\\n`);',
  'process.stderr.write(`stderr:${JSON.stringify(report.argv)}\\n`);',
  '',
].join('\n');

/** A program that exists only to prove that an injected command never ran. */
const INJECTED_SOURCE = "require('node:fs').writeFileSync(process.argv[2], 'ran');\n";

interface Fixture {
  /** Temporary directory holding the whole fixture. */
  readonly root: string;
  /** Parent of the workspace and the log directory. */
  readonly base: string;
  /** The command working directory, standing in for a task working copy. */
  readonly workspace: string;
  /** The output directory for command logs, standing in for `<runDir>/logs`. */
  readonly logsDir: string;
  /** The fixture program that reports its own arguments. */
  readonly dump: string;
  /** Created only if a shell-like argument is executed instead of passed on. */
  readonly sentinel: string;
  /** An argument that would create {@link sentinel} if any shell interpreted it. */
  readonly injection: string;
}

/**
 * A temporary workspace, log directory, and fixture programs. `spaced` puts the
 * whole fixture under a directory whose name contains spaces, which is the
 * normal case for a real checkout on Windows.
 */
async function createFixture(options: { spaced?: boolean } = {}): Promise<Fixture> {
  const root = await createTempDir();
  const base = options.spaced === true ? path.join(root, 'run directory with spaces') : root;
  const workspace = path.join(base, 'workspace');
  const logsDir = path.join(base, 'logs');
  await mkdir(workspace, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  const dump = path.join(base, 'dump.mjs');
  await writeFile(dump, DUMP_SOURCE, 'utf8');
  const injected = path.join(base, 'injected.cjs');
  await writeFile(injected, INJECTED_SOURCE, 'utf8');
  const sentinel = path.join(base, 'sentinel.txt');

  return {
    root,
    base,
    workspace,
    logsDir,
    dump,
    sentinel,
    injection: `&& "${process.execPath}" "${injected}" "${sentinel}"`,
  };
}

/** Runs the fixture program in a fixture workspace. */
function runFixture(
  fixture: Fixture,
  args: readonly string[],
  label = 'check-1',
): Promise<CommandResult> {
  return runCommand({
    command: [process.execPath, fixture.dump, ...args],
    cwd: fixture.workspace,
    logsDir: fixture.logsDir,
    label,
    timeoutMs: TEST_LIMIT_MS,
  });
}

interface DumpReport {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly secret: string | null;
}

/** The fixture program's own account of what it received. */
async function reportedBy(result: CommandResult): Promise<DumpReport> {
  const [line = ''] = (await readFile(result.stdoutPath, 'utf8')).split('\n');
  return JSON.parse(line) as DumpReport;
}

function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

/** Asserts that no configured argument was executed as shell syntax. */
function expectNothingInjected(fixture: Fixture): void {
  expect(existsSync(fixture.sentinel)).toBe(false);
  for (const directory of [fixture.workspace, fixture.base, fixture.root]) {
    expect(existsSync(path.join(directory, 'redirected.txt'))).toBe(false);
  }
}

/**
 * The recording fixture: every invocation appends its own `start` and `end`
 * record to one shared event file, so the order the commands ran in — and
 * whether any two were alive at the same time — is read from what the child
 * processes did rather than from what the harness intended. A lock file is held
 * for the whole life of an invocation: a second invocation running at the same
 * moment finds it and records an `overlap` instead of hiding the overlap.
 */
const RECORD_SOURCE = [
  "import { appendFileSync, rmSync, writeFileSync } from 'node:fs';",
  '',
  'const [, , id, eventsFile, lockFile, exitCode] = process.argv;',
  'const record = (event) =>',
  "  appendFileSync(eventsFile, `${JSON.stringify({ event, id, at: Date.now() })}\\n`, 'utf8');",
  '',
  'let holdsLock = true;',
  'try {',
  "  writeFileSync(lockFile, `${id}\\n`, { flag: 'wx' });",
  '} catch {',
  '  holdsLock = false;',
  '}',
  '',
  "record(holdsLock ? 'start' : 'overlap');",
  'process.stdout.write(`ran ${id}\\n`);',
  'process.stderr.write(`err ${id}\\n`);',
  'if (holdsLock) {',
  '  rmSync(lockFile);',
  '}',
  "record('end');",
  'process.exit(holdsLock ? Number(exitCode) : 97);',
  '',
].join('\n');

/** A fixture whose commands record their own execution. */
interface RoundFixture extends Fixture {
  /** The program that records what each invocation did. */
  readonly record: string;
  /** One JSON event record per line, appended by every invocation. */
  readonly eventsFile: string;
  /** Held by a running invocation, so a concurrent one records an overlap. */
  readonly lockFile: string;
}

/** A fixture with the recording program, on top of the usual temporary layout. */
async function createRoundFixture(options: { spaced?: boolean } = {}): Promise<RoundFixture> {
  const fixture = await createFixture(options);
  const record = path.join(fixture.base, 'record.mjs');
  await writeFile(record, RECORD_SOURCE, 'utf8');
  return {
    ...fixture,
    record,
    eventsFile: path.join(fixture.base, 'events.jsonl'),
    lockFile: path.join(fixture.base, 'record.lock'),
  };
}

/** One configured command that runs the recording fixture under `id`. */
function recorded(fixture: RoundFixture, id: string, exitCode = 0): Command {
  return [
    process.execPath,
    fixture.record,
    id,
    fixture.eventsFile,
    fixture.lockFile,
    String(exitCode),
  ];
}

/** Runs one setup/check round in the fixture workspace. */
function runRound(
  fixture: RoundFixture,
  parts: { name: string; setup?: readonly Command[]; checks: readonly Command[] },
): Promise<CheckRoundResult> {
  return runCheckRound({
    setup: parts.setup ?? [],
    checks: parts.checks,
    cwd: fixture.workspace,
    logsDir: fixture.logsDir,
    name: parts.name,
    ...roundBounds(),
  });
}

interface RecordedEvent {
  readonly event: 'start' | 'end' | 'overlap';
  readonly id: string;
  readonly at: number;
}

/** The events recorded so far, in the order the child processes wrote them. */
async function recordedEvents(fixture: RoundFixture): Promise<RecordedEvent[]> {
  if (!existsSync(fixture.eventsFile)) {
    return [];
  }
  return (await readText(fixture.eventsFile))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedEvent);
}

/**
 * Asserts that exactly these invocations started and finished, in this order,
 * one at a time. A second invocation alive at the same moment shows up either as
 * an `overlap` record or as an interleaved `start`/`end` pair.
 */
async function expectSequential(fixture: RoundFixture, ids: readonly string[]): Promise<void> {
  const events = await recordedEvents(fixture);
  expect(events.map((event) => event.event)).not.toContain('overlap');
  expect(events.map((event) => `${event.event} ${event.id}`)).toEqual(
    ids.flatMap((id) => [`start ${id}`, `end ${id}`]),
  );
}

describe('a configured command', () => {
  it('receives the exact argument array and the workspace directory', async () => {
    const fixture = await createFixture();
    const argumentsToPass: readonly string[] = [
      // An intentional empty argument is a value, not a missing one.
      '',
      'plain',
      'two words',
      '"quoted"',
      "single'quote",
      fixture.injection,
      '$(echo injected)',
      '`echo injected`',
      '|',
      '*',
      '> redirected.txt',
      '%PATH%',
      'C:\\Windows\\system32',
      'café 中文',
    ];
    const command: Command = [process.execPath, fixture.dump, ...argumentsToPass];

    const result = await runCommand({
      command,
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      label: 'check-1',
      timeoutMs: TEST_LIMIT_MS,
    });

    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.command).toEqual(command);

    const report = await reportedBy(result);
    // Exactly the configured arguments: nothing joined, split, expanded,
    // interpreted, or dropped on the way to the child process.
    expect(report.argv).toEqual(argumentsToPass);
    expect(report.argv[0]).toBe('');
    expect(report.cwd).toBe(fixture.workspace);
    expectNothingInjected(fixture);
  }, 30_000);

  it('never executes shell syntax from an argument', async () => {
    const fixture = await createFixture();

    const result = await runFixture(fixture, [fixture.injection, '$(echo injected)', '|']);

    expect(commandSucceeded(result)).toBe(true);
    // The argument arrived as text: the child process read it in one piece...
    expect((await reportedBy(result)).argv).toContain(fixture.injection);
    // ...and the command that text names was never run.
    expectNothingInjected(fixture);
  }, 30_000);

  it('records the command, its times, and the log files of the invocation', async () => {
    const fixture = await createFixture();
    const command: Command = [process.execPath, fixture.dump, 'ok'];

    const result = await runCommand({
      command,
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      label: 'check-3',
      timeoutMs: TEST_LIMIT_MS,
    });

    expect(result.command).toEqual(command);
    expect(result.cwd).toBe(fixture.workspace);
    expect(result.stdoutPath).toBe(path.join(fixture.logsDir, 'check-3.stdout.log'));
    expect(result.stderrPath).toBe(path.join(fixture.logsDir, 'check-3.stderr.log'));
    expect(new Date(result.startedAt).toISOString()).toBe(result.startedAt);
    expect(new Date(result.endedAt).toISOString()).toBe(result.endedAt);
    expect(Date.parse(result.endedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    expect(result.launchError).toBeNull();
    expect(result.signal).toBeNull();
  }, 30_000);
});

describe('how a command ended', () => {
  it('reports a successful exit as a success', async () => {
    const fixture = await createFixture();

    const result = await runFixture(fixture, ['fine']);

    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.launchError).toBeNull();
    expect(commandSucceeded(result)).toBe(true);
  }, 30_000);

  it('reports an ordinary nonzero exit as a command that ran', async () => {
    const fixture = await createFixture();

    const result = await runCommand({
      command: [process.execPath, '-e', 'process.stdout.write("red\\n"); process.exit(3)'],
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      label: 'check-1',
      timeoutMs: TEST_LIMIT_MS,
    });

    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(3);
    expect(result.launchError).toBeNull();
    expect(commandSucceeded(result)).toBe(false);
    expect(await readText(result.stdoutPath)).toBe('red\n');
  }, 30_000);

  it('reports an executable that does not exist as a launch failure', async () => {
    const fixture = await createFixture();
    const absent = path.join(fixture.root, 'no-such-program-xyz');

    const result = await runCommand({
      command: [absent, 'arg'],
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      label: 'check-1',
      timeoutMs: TEST_LIMIT_MS,
    });

    expect(result.outcome).toBe('failed-to-launch');
    // A command that never ran is not an exit at all: it cannot be mistaken for
    // a success, and it cannot be mistaken for an ordinary nonzero exit either.
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(commandSucceeded(result)).toBe(false);
    expect(result.launchError ?? '').toContain(absent);
    // The evidence files exist even when nothing ran.
    expect(existsSync(result.stdoutPath)).toBe(true);
    expect(existsSync(result.stderrPath)).toBe(true);
  }, 30_000);

  it('reports a name that is not on PATH as a launch failure', async () => {
    const fixture = await createFixture();

    const result = await runCommand({
      command: ['nexus-no-such-program-xyz', 'arg'],
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      label: 'check-1',
      timeoutMs: TEST_LIMIT_MS,
    });

    expect(result.outcome).toBe('failed-to-launch');
    expect(result.exitCode).toBeNull();
    expect(result.launchError).toMatch(/nexus-no-such-program-xyz/);
    expect(commandSucceeded(result)).toBe(false);
  }, 30_000);

  it('reports a working directory that is not there as a launch failure', async () => {
    const fixture = await createFixture();
    const absent = path.join(fixture.root, 'no-such-workspace');

    const result = await runCommand({
      command: [process.execPath, '-e', 'process.exit(0)'],
      cwd: absent,
      logsDir: fixture.logsDir,
      label: 'check-1',
      timeoutMs: TEST_LIMIT_MS,
    });

    expect(result.outcome).toBe('failed-to-launch');
    expect(result.exitCode).toBeNull();
    expect(result.launchError ?? '').toContain(absent);
    expect(commandSucceeded(result)).toBe(false);
  }, 30_000);
});

describe('command logs', () => {
  it('persists both output streams and keeps them with their own command', async () => {
    const fixture = await createFixture();

    const result = await runFixture(fixture, ['streamed']);

    const stdout = await readText(result.stdoutPath);
    const stderr = await readText(result.stderrPath);
    expect((JSON.parse(stdout.split('\n')[0] ?? '') as DumpReport).argv).toEqual(['streamed']);
    expect(stderr).toBe('stderr:["streamed"]\n');
    // Each stream stays in its own file.
    expect(stdout).not.toContain('stderr:');
    expect(stderr).not.toContain('"cwd"');
  }, 30_000);

  it('does not overwrite the logs of an earlier invocation', async () => {
    const fixture = await createFixture();

    const first = await runFixture(fixture, ['first'], 'check-1');
    const second = await runFixture(fixture, ['second'], 'check-2');

    expect(first.stdoutPath).not.toBe(second.stdoutPath);
    expect(await readText(first.stdoutPath)).toContain('"first"');
    expect(await readText(second.stdoutPath)).toContain('"second"');

    // An invocation name is used once: reusing it is refused rather than
    // truncating evidence that is already there.
    const reused = await runFixture(fixture, ['third'], 'check-1').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(reused).toBeInstanceOf(ReportError);
    expect(await readText(first.stdoutPath)).toContain('"first"');
    expect(await readText(second.stdoutPath)).toContain('"second"');
  }, 30_000);

  it('refuses an invocation name that could name a path, and creates nothing', async () => {
    const fixture = await createFixture();
    const before = (await readdir(fixture.logsDir)).sort();

    for (const label of ['../escape', 'a/b', 'a\\b', '', 'check 1']) {
      await expect(openCommandLog(fixture.logsDir, label)).rejects.toThrow(ReportError);
    }

    expect((await readdir(fixture.logsDir)).sort()).toEqual(before);
    expect(existsSync(path.join(fixture.root, 'escape.stdout.log'))).toBe(false);
  });

  it('flushes everything it was given by the time it is closed', async () => {
    const fixture = await createFixture();
    const log = await openCommandLog(fixture.logsDir, 'check-1');

    log.writeStdout('first\n');
    log.writeStdout('second\n');
    log.writeStderr('problem\n');
    await log.close();

    expect(await readText(log.stdoutPath)).toBe('first\nsecond\n');
    expect(await readText(log.stderrPath)).toBe('problem\n');
  });

  it('refuses to create its files outside a directory that exists', async () => {
    const fixture = await createFixture();
    const absent = path.join(fixture.root, 'no-such-logs');

    await expect(openCommandLog(absent, 'check-1')).rejects.toThrow(ReportError);

    expect(existsSync(absent)).toBe(false);
  });
});

describe('the run timeline', () => {
  const lifecycle = [
    'run prepared: run-20260101-000000-abcdef01',
    'baseline check-round started: 2 checks',
    'baseline check-round result: 2 of 2 checks passed',
    'implementation turn 1 started',
    'check-round 1 result: 1 of 2 checks passed',
    'repair turn 1 started',
    'final status: failed (checks exhausted the repair allowance)',
  ];

  it('is append-only, timestamped, and in chronological order', async () => {
    const fixture = await createFixture();
    const timeline = runLogPath(fixture.logsDir);

    for (const message of lifecycle) {
      await appendRunLog(timeline, message);
    }
    const before = await readText(timeline);

    const lines = before.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(lifecycle.length);
    const stamps: number[] = [];
    lines.forEach((line, index) => {
      const [stamp = '', ...rest] = line.split(' ');
      expect(new Date(stamp).toISOString()).toBe(stamp);
      expect(rest.join(' ')).toBe(lifecycle[index]);
      stamps.push(Date.parse(stamp));
    });
    expect([...stamps].sort((left, right) => left - right)).toEqual(stamps);

    // A later state change is added; earlier ones are still there, unchanged.
    await appendRunLog(timeline, 'final status: cancelled by the user');
    const after = await readText(timeline);

    expect(after.startsWith(before)).toBe(true);
    expect(after.split('\n').filter((line) => line !== '')).toHaveLength(lifecycle.length + 1);
  });

  it('holds no command output, no environment dump, and no secret value', async () => {
    const fixture = await createFixture();
    const timeline = runLogPath(fixture.logsDir);
    const secret = 'nexus-t03-sentinel-5f3a91c2';
    const previous = process.env.NEXUS_TEST_SECRET;
    const hostPath = process.env.PATH ?? '';
    process.env.NEXUS_TEST_SECRET = secret;

    try {
      const result = await runFixture(fixture, ['quiet']);
      await appendRunLog(timeline, 'baseline check-round started: 1 check');
      await appendRunLog(timeline, 'baseline check-round result: 1 of 1 checks passed');

      // The command really did inherit the environment and print the value:
      // only the timeline has to stay clear of it.
      expect((await reportedBy(result)).secret).toBe(secret);
      expect(await readText(result.stdoutPath)).toContain(secret);

      const text = await readText(timeline);
      expect(text).not.toContain(secret);
      expect(text).not.toContain('"cwd"');
      expect(text).not.toContain('stderr:');
      if (hostPath !== '') {
        expect(text).not.toContain(hostPath);
      }
      for (const line of text.split('\n').filter((entry) => entry !== '')) {
        // Every line is a timestamp and a message: never an environment entry.
        expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \S/);
        expect(line).not.toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.NEXUS_TEST_SECRET;
      } else {
        process.env.NEXUS_TEST_SECRET = previous;
      }
    }
  }, 30_000);

  it('refuses a message that is not one nonblank line', async () => {
    const fixture = await createFixture();
    const timeline = runLogPath(fixture.logsDir);

    await expect(appendRunLog(timeline, 'two\nlines')).rejects.toThrow(ReportError);
    await expect(appendRunLog(timeline, '   ')).rejects.toThrow(ReportError);

    expect(existsSync(timeline)).toBe(false);
  });
});

describe('a workspace path containing spaces', () => {
  it('runs the command there and reports that exact directory', async () => {
    const fixture = await createFixture({ spaced: true });

    const result = await runFixture(fixture, ['spaced workspace']);

    expect(fixture.workspace).toContain(' ');
    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect((await reportedBy(result)).cwd).toBe(fixture.workspace);
    expect(existsSync(path.join(fixture.logsDir, 'check-1.stdout.log'))).toBe(true);
  }, 30_000);
});

/**
 * One setup/check round: the configured setup commands first, then every
 * configured check. The commands are real child processes that record and
 * serialize themselves, so order and overlap are asserted from what the children
 * did. See docs/tasks.md T04.
 */
describe('a setup/check round', () => {
  it('runs setup and every check in the configured order, one at a time', async () => {
    const fixture = await createRoundFixture();
    const setup: Command[] = [recorded(fixture, 'setup-1'), recorded(fixture, 'setup-2')];
    const checks: Command[] = [
      recorded(fixture, 'check-1'),
      recorded(fixture, 'check-2'),
      recorded(fixture, 'check-3'),
    ];

    const round = await runRound(fixture, { name: 'baseline', setup, checks });

    expect(round.outcome).toBe('passed');
    expect(round.problem).toBeNull();
    expect(round.setup.map((result) => result.command)).toEqual(setup);
    expect(round.checks.map((result) => result.command)).toEqual(checks);
    // Exactly one successful observation per configured check, each with its own
    // log files holding that command's own output.
    expect(round.checks).toHaveLength(checks.length);
    expect(round.checks.every(commandSucceeded)).toBe(true);
    expect(new Set(round.checks.map((result) => result.stdoutPath)).size).toBe(checks.length);
    for (const [index, result] of round.checks.entries()) {
      const position = index + 1;
      expect(result.stdoutPath).toBe(
        path.join(fixture.logsDir, `baseline-check-${position}.stdout.log`),
      );
      expect(await readText(result.stdoutPath)).toBe(`ran check-${position}\n`);
    }
    await expectSequential(fixture, ['setup-1', 'setup-2', 'check-1', 'check-2', 'check-3']);
  }, 60_000);

  it('keeps running every check after one of them fails', async () => {
    const fixture = await createRoundFixture();
    const checks: Command[] = [
      recorded(fixture, 'check-1', 3),
      recorded(fixture, 'check-2'),
      recorded(fixture, 'check-3', 7),
    ];

    const round = await runRound(fixture, { name: 'attempt-1', checks });

    // A completed red round: every configured check was attempted, and each
    // result is kept as its own evidence for a repair turn to read.
    expect(round.outcome).toBe('failed');
    expect(round.problem).toBeNull();
    expect(round.checks).toHaveLength(checks.length);
    expect(round.checks.map((result) => result.exitCode)).toEqual([3, 0, 7]);
    expect(round.checks.map(commandSucceeded)).toEqual([false, true, false]);
    expect(await readText(round.checks[0]?.stdoutPath ?? '')).toBe('ran check-1\n');
    expect(await readText(round.checks[1]?.stdoutPath ?? '')).toBe('ran check-2\n');
    await expectSequential(fixture, ['check-1', 'check-2', 'check-3']);
  }, 60_000);

  it('stops at a failing setup command, before the later setup and all checks', async () => {
    const fixture = await createRoundFixture();
    const setup: Command[] = [recorded(fixture, 'setup-1', 1), recorded(fixture, 'setup-2')];
    const checks: Command[] = [recorded(fixture, 'check-1'), recorded(fixture, 'check-2')];

    const round = await runRound(fixture, { name: 'baseline', setup, checks });

    expect(round.outcome).toBe('execution-error');
    expect(round.problem).toMatch(/setup command 1 of 2/);
    expect(round.problem).toMatch(/exited with code 1/);
    expect(round.setup).toHaveLength(1);
    expect(round.setup[0]?.exitCode).toBe(1);
    // No check has a result: none of them ran.
    expect(round.checks).toEqual([]);
    await expectSequential(fixture, ['setup-1']);
  }, 60_000);

  it('stops at a setup command that cannot start, and runs no check', async () => {
    const fixture = await createRoundFixture();
    const absent = path.join(fixture.root, 'no-such-program-xyz');
    const setup: Command[] = [recorded(fixture, 'setup-1'), [absent]];
    const checks: Command[] = [recorded(fixture, 'check-1')];

    const round = await runRound(fixture, { name: 'baseline', setup, checks });

    expect(round.outcome).toBe('execution-error');
    expect(round.problem).toMatch(/setup command 2 of 2/);
    expect(round.problem).toContain(absent);
    expect(round.setup).toHaveLength(2);
    expect(round.setup[1]?.outcome).toBe('failed-to-launch');
    expect(round.checks).toEqual([]);
    await expectSequential(fixture, ['setup-1']);
  }, 60_000);

  it('stops at a check that cannot execute, and is not a red check round', async () => {
    const fixture = await createRoundFixture();
    const absent = path.join(fixture.root, 'no-such-program-xyz');
    const checks: Command[] = [
      recorded(fixture, 'check-1'),
      [absent, 'argument'],
      recorded(fixture, 'check-3'),
    ];

    const stopped = await runRound(fixture, { name: 'attempt-1', checks });

    expect(stopped.outcome).toBe('execution-error');
    expect(stopped.problem).toMatch(/check 2 of 3/);
    expect(stopped.problem).toContain(absent);
    // Only the checks that ran are results: the one that never started is not a
    // failed check, and the one after it is not a success either.
    expect(stopped.checks).toHaveLength(2);
    expect(stopped.checks[1]?.outcome).toBe('failed-to-launch');
    expect(stopped.checks[1]?.exitCode).toBeNull();
    expect(stopped.checks.map(commandSucceeded)).toEqual([true, false]);
    await expectSequential(fixture, ['check-1']);

    // A completed red round is a different thing in the same returned data:
    // every configured check has a result, the round is red, and the round has
    // nothing to explain.
    const red = await runRound(fixture, {
      name: 'attempt-2',
      checks: [recorded(fixture, 'red-1', 2)],
    });
    expect(red.outcome).toBe('failed');
    expect(red.problem).toBeNull();
    expect(red.checks).toHaveLength(1);
    expect(stopped.outcome).not.toBe(red.outcome);
    expect(stopped.problem).not.toBeNull();
  }, 60_000);

  it('runs the checks directly when setup is empty', async () => {
    const fixture = await createRoundFixture();
    const checks: Command[] = [recorded(fixture, 'check-1'), recorded(fixture, 'check-2')];

    const round = await runRound(fixture, { name: 'attempt-1', setup: [], checks });

    expect(round.outcome).toBe('passed');
    expect(round.setup).toEqual([]);
    expect(round.checks).toHaveLength(checks.length);
    expect(round.checks.every(commandSucceeded)).toBe(true);
    await expectSequential(fixture, ['check-1', 'check-2']);
    // Nothing ran before the checks, so nothing was logged for setup.
    expect((await readdir(fixture.logsDir)).sort()).toEqual([
      'attempt-1-check-1.stderr.log',
      'attempt-1-check-1.stdout.log',
      'attempt-1-check-2.stderr.log',
      'attempt-1-check-2.stdout.log',
    ]);
  }, 60_000);

  it('keeps the logs of an earlier round when the same checks run again', async () => {
    const fixture = await createRoundFixture();
    const checks: Command[] = [recorded(fixture, 'check-1', 4)];

    const baseline = await runRound(fixture, { name: 'baseline', checks });
    const attempt = await runRound(fixture, { name: 'attempt-1', checks });

    expect(baseline.checks[0]?.stdoutPath).not.toBe(attempt.checks[0]?.stdoutPath);
    expect(await readText(baseline.checks[0]?.stdoutPath ?? '')).toBe('ran check-1\n');
    expect(await readText(attempt.checks[0]?.stdoutPath ?? '')).toBe('ran check-1\n');
  }, 60_000);
});

/**
 * A fixture command that never finishes by itself, and starts a child of its own
 * that does not either: the two processes a stop has to reach are the one the
 * harness started and the one that process started. Both record their own PID
 * and a heartbeat, so a test proves they were running before the stop and that
 * neither is running afterwards — from what the fixture processes did, not from
 * what the harness says it did.
 */
const HANG_SOURCE = [
  "import { appendFileSync, writeFileSync } from 'node:fs';",
  "import { spawn } from 'node:child_process';",
  '',
  'const [, , id, pidFile, beatsFile, holdsForMs] = process.argv;',
  "const record = (line) => appendFileSync(beatsFile, `${line}\\n`, 'utf8');",
  '',
  '// The command starts one more process, which is what makes the difference',
  '// between stopping a process and stopping the tree it became visible: a stop',
  '// that reaches only the direct process leaves this one running and writing.',
  "const child = id.endsWith('-child')",
  '  ? null',
  '  : spawn(process.execPath, [process.argv[1], `${id}-child`, pidFile, beatsFile, holdsForMs], {',
  "      stdio: 'ignore',",
  '    });',
  '',
  "writeFileSync(`${pidFile}.${id}`, JSON.stringify({ pid: process.pid, child: child?.pid ?? null }), 'utf8');",
  'record(`${id} started`);',
  'setInterval(() => record(`${id} beating`), 100);',
  '',
  '// A backstop: a fixture that outlives its test still ends on its own.',
  'setTimeout(() => process.exit(0), Number(holdsForMs));',
  '',
].join('\n');

/** How long a hang fixture waits before it gives up and exits by itself. */
const HANG_HOLD_MS = 20_000;

interface HangFixture extends RoundFixture {
  /** The program that hangs, and starts a child that hangs. */
  readonly hang: string;
  /** Where every invocation writes its own PID and its child's. */
  readonly pidFile: string;
  /** One line per heartbeat, appended while a process is running. */
  readonly beatsFile: string;
}

/** A fixture with the hanging program and the recording one, over the same layout. */
async function createHangFixture(): Promise<HangFixture> {
  const fixture = await createRoundFixture();
  const hang = path.join(fixture.base, 'hang.mjs');
  await writeFile(hang, HANG_SOURCE, 'utf8');
  return {
    ...fixture,
    hang,
    pidFile: path.join(fixture.base, 'pids'),
    beatsFile: path.join(fixture.base, 'beats.txt'),
  };
}

/** One hanging invocation, as a configured command. */
function hangCommand(fixture: HangFixture, id: string): Command {
  return [
    process.execPath,
    fixture.hang,
    id,
    fixture.pidFile,
    fixture.beatsFile,
    String(HANG_HOLD_MS),
  ];
}

/** The PIDs one hanging invocation recorded for itself and for its child. */
async function hangPids(
  fixture: HangFixture,
  id: string,
): Promise<{ readonly pid: number; readonly child: number | null }> {
  const record = JSON.parse(await readText(`${fixture.pidFile}.${id}`)) as {
    pid: number;
    child: number | null;
  };
  return record;
}

/** Every heartbeat recorded so far, in the order the fixture processes wrote them. */
async function heartbeats(fixture: HangFixture): Promise<string[]> {
  if (!existsSync(fixture.beatsFile)) {
    return [];
  }
  return (await readText(fixture.beatsFile)).split('\n').filter((line) => line !== '');
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(stillRunning(pid)).toBe(false);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('a command that runs out of time', () => {
  it('is stopped with the child it started, and is not waited for', async () => {
    const fixture = await createHangFixture();
    const started = Date.now();

    const result = await runCommand({
      command: hangCommand(fixture, 'slow'),
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      label: 'check-1',
      timeoutMs: 500,
    });
    const recorded = await hangPids(fixture, 'slow');
    registerFixture(recorded);

    // Both processes really were running: each wrote its own start, and the
    // direct one recorded the PID of the child it started.
    expect(await heartbeats(fixture)).toContain('slow started');
    expect(await heartbeats(fixture)).toContain('slow-child started');
    expect(recorded.child).not.toBeNull();

    expect(result.outcome).toBe('timed-out');
    expect(result.timeoutMs).toBe(500);
    expect(result.termination).toBe('confirmed');
    expect(result.terminationProblem).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);

    // The command is gone, and so is the child it started: what was stopped is
    // the tree, not the one process the harness happened to spawn.
    await expectGone(recorded.pid);
    await expectGone(recorded.child ?? 0);

    const beat = (await heartbeats(fixture)).length;
    await pause(600);
    expect((await heartbeats(fixture)).length).toBe(beat);
  }, 30_000);

  it('runs under the task time that is left when that is the smaller limit', async () => {
    const fixture = await createHangFixture();
    // A frozen clock: the run has exactly 400 ms of task time left, whatever
    // the ten minutes each command is configured with.
    const now = Date.now();
    const started = Date.now();

    const round = await runCheckRound({
      setup: [],
      checks: [hangCommand(fixture, 'slow'), recorded(fixture, 'never-reached')],
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      name: 'baseline',
      commandTimeoutMs: 10 * 60_000,
      deadlineMs: now + 400,
      now: () => new Date(now),
    });
    registerFixture(await hangPids(fixture, 'slow'));

    expect(round.outcome).toBe('execution-error');
    expect(round.checks).toHaveLength(1);
    expect(round.checks[0]?.outcome).toBe('timed-out');
    expect(round.checks[0]?.timeoutMs).toBe(400);
    expect(round.checks[0]?.termination).toBe('confirmed');
    expect(round.problem).toContain('the 400 ms of task time that was left');
    // The check after it was never started: no result, no events, no logs.
    expect(await recordedEvents(fixture)).toEqual([]);
    expect(existsSync(path.join(fixture.logsDir, 'baseline-check-2.stdout.log'))).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('runs under its own command limit when that is the smaller one', async () => {
    const fixture = await createHangFixture();

    const round = await runCheckRound({
      setup: [hangCommand(fixture, 'slow')],
      checks: [recorded(fixture, 'never-reached')],
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      name: 'baseline',
      commandTimeoutMs: 400,
      // An hour of task time: here the command's own limit is what expires.
      deadlineMs: Date.now() + 60 * 60_000,
      now: () => new Date(),
    });
    registerFixture(await hangPids(fixture, 'slow'));

    expect(round.outcome).toBe('execution-error');
    expect(round.setup).toHaveLength(1);
    expect(round.setup[0]?.outcome).toBe('timed-out');
    expect(round.setup[0]?.timeoutMs).toBe(400);
    expect(round.problem).toContain('its 400 ms command limit');
    expect(round.checks).toEqual([]);
    expect(await recordedEvents(fixture)).toEqual([]);
  }, 30_000);

  it('starts nothing at all once the task deadline has passed', async () => {
    const fixture = await createRoundFixture();
    const now = Date.now();

    const round = await runCheckRound({
      setup: [recorded(fixture, 'setup-one')],
      checks: [recorded(fixture, 'check-one')],
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      name: 'baseline',
      commandTimeoutMs: 10 * 60_000,
      deadlineMs: now - 250,
      now: () => new Date(now),
    });

    expect(round.outcome).toBe('execution-error');
    expect(round.problem).toContain('task deadline passed 250 ms');
    expect(round.problem).toContain('not a failed check');
    // Nothing was started, so nothing has a result, an event, or a log file.
    expect(round.setup).toEqual([]);
    expect(round.checks).toEqual([]);
    expect(await recordedEvents(fixture)).toEqual([]);
    expect(await readdir(fixture.logsDir)).toEqual([]);
  });

  // Windows-only by construction: this scenario defeats the stop by emptying
  // PATH, so the harness cannot find `taskkill` — the utility Windows stops a
  // tree with. On POSIX the harness signals the invocation's process group
  // directly (`process.kill(-pid)`), which needs no utility to be found, so the
  // stop succeeds and there is no unconfirmed stop to report.
  it.skipIf(process.platform !== 'win32')(
    'reports a stop it could not confirm, and calls the copy unsafe to reuse',
    async () => {
      const fixture = await createHangFixture();
      const path = process.env.PATH;
      // The fixture is named by absolute path and still starts; the harness cannot
      // find the utility it stops a tree with, so the stop does not happen at all.
      process.env.PATH = '';
      let result: CommandResult;
      let round: CheckRoundResult;
      try {
        result = await runCommand({
          command: hangCommand(fixture, 'slow'),
          cwd: fixture.workspace,
          logsDir: fixture.logsDir,
          label: 'check-1',
          timeoutMs: 400,
        });
        registerFixture(await hangPids(fixture, 'slow'));

        // The round turns that into the limitation a reader has to act on.
        round = await runCheckRound({
          setup: [],
          checks: [hangCommand(fixture, 'second')],
          cwd: fixture.workspace,
          logsDir: fixture.logsDir,
          name: 'attempt-1',
          commandTimeoutMs: 400,
          deadlineMs: Date.now() + 60 * 60_000,
          now: () => new Date(),
        });
        registerFixture(await hangPids(fixture, 'second'));
      } finally {
        process.env.PATH = path;
      }

      expect(result.outcome).toBe('timed-out');
      expect(result.termination).toBe('unconfirmed');
      expect(result.terminationProblem).not.toBeNull();

      expect(round.outcome).toBe('execution-error');
      expect(round.problem).toContain('could not be confirmed');
      expect(round.problem).toContain('must not be reused');

      // Both commands really are still running: that is why nothing may be reused.
      const first = await hangPids(fixture, 'slow');
      const second = await hangPids(fixture, 'second');
      expect(stillRunning(first.pid)).toBe(true);
      expect(stillRunning(first.child ?? 0)).toBe(true);
      expect(stillRunning(second.pid)).toBe(true);
    },
    60_000,
  );
});

/**
 * The Windows launcher. `npm` and other installed commands are `.cmd` shims:
 * `spawn` cannot start them without a shell, so the harness starts them through
 * the command interpreter instead. See "Supported platforms and launchers" in
 * src/checks.ts. These tests run for real on Windows and skip elsewhere; the
 * tests above cover the direct launcher that every platform uses.
 */
describe.skipIf(process.platform !== 'win32')('the native Windows launcher', () => {
  /** A test-owned shim that forwards its arguments to the fixture program. */
  async function writeShim(fixture: Fixture, extension: string): Promise<string> {
    const shim = path.join(fixture.base, `fixture shim${extension}`);
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0dump.mjs" %*\r\n`, 'utf8');
    return shim;
  }

  it('runs npm, an installed .cmd shim found on PATH', async () => {
    const fixture = await createFixture();

    const result = await runCommand({
      command: ['npm', '--version'],
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      label: 'check-1',
      timeoutMs: TEST_LIMIT_MS,
    });

    expect(result.outcome).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.launchError).toBeNull();
    expect(commandSucceeded(result)).toBe(true);
    expect(await readText(result.stdoutPath)).toMatch(/\d+\.\d+\.\d+/);
  }, 60_000);

  for (const extension of ['.cmd', '.bat']) {
    it(`passes literal arguments through a ${extension} shim`, async () => {
      const fixture = await createFixture({ spaced: true });
      const shim = await writeShim(fixture, extension);
      const args: readonly string[] = [
        '',
        'two words',
        'x&y',
        '&& echo injected',
        '$(echo injected)',
        '|',
        '*',
        'C:\\dir\\',
        'café',
      ];

      const result = await runCommand({
        command: [shim, ...args],
        cwd: fixture.workspace,
        logsDir: fixture.logsDir,
        label: 'check-1',
        timeoutMs: TEST_LIMIT_MS,
      });

      expect(result.exitCode).toBe(0);
      expect(result.launchError).toBeNull();
      const report = await reportedBy(result);
      expect(report.argv).toEqual(args);
      expect(report.cwd).toBe(fixture.workspace);
      expectNothingInjected(fixture);
    }, 60_000);
  }

  it('refuses arguments a shim cannot receive unchanged, and runs nothing', async () => {
    const fixture = await createFixture();
    const shim = await writeShim(fixture, '.cmd');

    const unsupported: ReadonlyArray<readonly [string, RegExp]> = [
      ['100%', /percent/],
      ['say "hi"', /double quote/],
      ['two\nlines', /line break/],
    ];
    let invocation = 0;
    for (const [argument, problem] of unsupported) {
      invocation += 1;
      const result = await runCommand({
        command: [shim, argument],
        cwd: fixture.workspace,
        logsDir: fixture.logsDir,
        label: `check-${String(invocation)}`,
        timeoutMs: TEST_LIMIT_MS,
      });

      expect(result.outcome).toBe('failed-to-launch');
      expect(result.exitCode).toBeNull();
      expect(result.launchError).toMatch(problem);
      expect(commandSucceeded(result)).toBe(false);
      // Refused, not run: the shim never started the fixture program.
      expect(await readText(result.stdoutPath)).toBe('');
      expectNothingInjected(fixture);
    }
  }, 60_000);

  it('refuses only what the interpreter cannot carry, not merely odd arguments', async () => {
    const fixture = await createFixture();

    // The same shapes are ordinary literal arguments for a real executable:
    // only a command interpreter cannot pass them on. This is the documented
    // boundary of the shim launcher, not a property of the argument array.
    const result = await runCommand({
      command: [process.execPath, fixture.dump, '100%', 'say "hi"'],
      cwd: fixture.workspace,
      logsDir: fixture.logsDir,
      label: 'check-1',
      timeoutMs: TEST_LIMIT_MS,
    });

    expect(result.exitCode).toBe(0);
    expect((await reportedBy(result)).argv).toEqual(['100%', 'say "hi"']);
  }, 30_000);
});
