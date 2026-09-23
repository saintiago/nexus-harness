/**
 * The configured setup/check round, with real child processes.
 *
 * `runCheckRound` is what decides what a run's configured `setup` and `checks`
 * mean: setup commands first, in order, and only when every one of them
 * succeeded do the checks run, in order, one at a time. An ordinary failing
 * check is a result like any other — the later checks still run, and the
 * completed round is red, which is what a repair turn reads — while a failing
 * setup command, a command that could not be started, and the round's own ending
 * conditions (a limit that expired, the run's stop request) end it as an
 * execution error with no result invented for a command that never ran.
 *
 * The commands here are real child processes of this host's own Node that record
 * themselves and serialize themselves, so the order and the one-at-a-time
 * property are asserted from what the children really did. Every one of them is
 * waited for before the case ends, and every file lives under a temporary
 * directory this suite removes.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandSucceeded, runCheckRound } from '../../src/checks/round.js';
import type { CheckRoundResult, Command } from '../../src/shared/types.js';
import { createTempDir, readText } from '../support.js';

/**
 * The step program: it names itself in the sequence the case reads back the
 * moment it starts and just before it exits, prints its own line for the check's
 * log file, and exits with the code it was given.
 */
const STEP_PROGRAM = [
  `import { appendFileSync } from 'node:fs';`,
  ``,
  `const [name, exitCode] = process.argv.slice(2);`,
  `const record = process.env.NEXUS_STEP_RECORD;`,
  `const mark = (phase) => appendFileSync(record, phase + ' ' + name + '\\n');`,
  `mark('start');`,
  `process.stdout.write('ran ' + name + '\\n');`,
  `mark('end');`,
  `process.exit(Number(exitCode));`,
  ``,
].join('\n');

/** One round case's working tree: where the commands run, log, and record. */
interface RoundFixture {
  readonly root: string;
  readonly logsDir: string;
  /** One step command: a real Node process that records and serializes itself. */
  step(name: string, exitCode?: number): Command;
}

async function createRoundFixture(): Promise<RoundFixture> {
  const root = await createTempDir();
  const logsDir = path.join(root, 'logs');
  await mkdir(logsDir, { recursive: true });
  const program = path.join(root, 'step.mjs');
  await writeFile(program, STEP_PROGRAM, 'utf8');
  return {
    root,
    logsDir,
    step: (name, exitCode = 0) => [process.execPath, program, name, String(exitCode)],
  };
}

/** Runs one round of the fixture, with the deadline a case's limit sits under. */
async function runRound(
  fixture: RoundFixture,
  request: {
    readonly name: string;
    readonly setup?: readonly Command[];
    readonly checks: readonly Command[];
  },
): Promise<CheckRoundResult> {
  return await runCheckRound({
    setup: request.setup ?? [],
    checks: request.checks,
    cwd: fixture.root,
    logsDir: fixture.logsDir,
    name: request.name,
    commandTimeoutMs: 30_000,
    deadlineMs: Date.now() + 60_000,
    now: () => new Date(),
    env: { ...process.env, NEXUS_STEP_RECORD: path.join(fixture.root, 'ran.txt') },
  });
}

/** The order the round's commands really started and ended in. */
async function ran(fixture: RoundFixture): Promise<readonly string[]> {
  const text = await readFile(path.join(fixture.root, 'ran.txt'), 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line !== '');
}

describe('a setup/check round', () => {
  it('runs setup and every check in the configured order, one at a time', async () => {
    const fixture = await createRoundFixture();
    const setup: Command[] = [fixture.step('setup-1'), fixture.step('setup-2')];
    const checks: Command[] = [
      fixture.step('check-1'),
      fixture.step('check-2'),
      fixture.step('check-3'),
    ];

    const round = await runRound(fixture, { name: 'baseline', setup, checks });

    expect(round.outcome).toBe('passed');
    expect(round.problem).toBeNull();
    expect(round.setup.map((result) => result.command)).toEqual(setup);
    expect(round.checks.map((result) => result.command)).toEqual(checks);
    expect(round.checks.every(commandSucceeded)).toBe(true);
    // Each invocation has its own log files, holding that command's own output.
    expect(round.checks[1]?.stdoutPath).toBe(
      path.join(fixture.logsDir, 'baseline-check-2.stdout.log'),
    );
    expect(await readText(round.checks[1]?.stdoutPath ?? '')).toBe('ran check-2\n');
    // The commands really ran in this order, each finished before the next
    // started: no setup command overlaps a check or another setup command.
    expect(await ran(fixture)).toEqual([
      'start setup-1',
      'end setup-1',
      'start setup-2',
      'end setup-2',
      'start check-1',
      'end check-1',
      'start check-2',
      'end check-2',
      'start check-3',
      'end check-3',
    ]);
  }, 45_000);

  it('keeps running every check after one of them fails, and reports a red round', async () => {
    const fixture = await createRoundFixture();
    const checks: Command[] = [
      fixture.step('check-1', 3),
      fixture.step('check-2'),
      fixture.step('check-3', 7),
    ];

    const round = await runRound(fixture, { name: 'attempt-1', checks });

    // A completed red round: every configured check was attempted, and each
    // result is kept as its own evidence for a repair turn to read.
    expect(round.outcome).toBe('failed');
    expect(round.problem).toBeNull();
    expect(round.checks.map((result) => result.exitCode)).toEqual([3, 0, 7]);
    expect(round.checks.map(commandSucceeded)).toEqual([false, true, false]);
    expect(round.checks).toHaveLength(checks.length);
    expect(await ran(fixture)).toEqual([
      'start check-1',
      'end check-1',
      'start check-2',
      'end check-2',
      'start check-3',
      'end check-3',
    ]);
  }, 45_000);

  it('stops at a failing setup command, before the later setup command and all checks', async () => {
    const fixture = await createRoundFixture();

    const round = await runRound(fixture, {
      name: 'baseline',
      setup: [fixture.step('setup-1', 1), fixture.step('setup-2')],
      checks: [fixture.step('check-1'), fixture.step('check-2')],
    });

    expect(round.outcome).toBe('execution-error');
    expect(round.problem).toMatch(/setup command 1 of 2/);
    expect(round.problem).toMatch(/exited with code 1/);
    expect(round.setup).toHaveLength(1);
    expect(round.setup[0]?.exitCode).toBe(1);
    // No check has a result: none of them ran, and none is reported as a pass.
    expect(round.checks).toEqual([]);
    expect(await ran(fixture)).toEqual(['start setup-1', 'end setup-1']);
  }, 45_000);

  it('stops at a setup command that cannot start, and runs no check', async () => {
    const fixture = await createRoundFixture();
    const absent = path.join(fixture.root, 'nexus-no-such-program');

    const round = await runRound(fixture, {
      name: 'baseline',
      setup: [fixture.step('setup-1'), [absent]],
      checks: [fixture.step('check-1')],
    });

    expect(round.outcome).toBe('execution-error');
    expect(round.problem).toMatch(/setup command 2 of 2/);
    expect(round.problem).toContain(absent);
    expect(round.setup).toHaveLength(2);
    expect(round.setup[1]?.outcome).toBe('failed-to-launch');
    expect(round.checks).toEqual([]);
    expect(await ran(fixture)).toEqual(['start setup-1', 'end setup-1']);
  }, 45_000);

  it('stops at a check that cannot execute, and invents no result for the ones after it', async () => {
    const fixture = await createRoundFixture();
    const absent = path.join(fixture.root, 'nexus-no-such-program');

    const stopped = await runRound(fixture, {
      name: 'attempt-1',
      checks: [fixture.step('check-1'), [absent, 'argument'], fixture.step('check-3')],
    });

    // A command that could not run is an execution error, not a failed check,
    // and the one after it is not a success either: neither has a result.
    expect(stopped.outcome).toBe('execution-error');
    expect(stopped.problem).toMatch(/check 2 of 3/);
    expect(stopped.problem).toContain(absent);
    expect(stopped.checks).toHaveLength(2);
    expect(stopped.checks[1]?.outcome).toBe('failed-to-launch');
    expect(stopped.checks[1]?.exitCode).toBeNull();
    expect(stopped.checks.map(commandSucceeded)).toEqual([true, false]);
    expect(await ran(fixture)).toEqual(['start check-1', 'end check-1']);
  }, 45_000);

  it('runs the checks directly when setup is empty, and logs nothing for setup', async () => {
    const fixture = await createRoundFixture();
    const checks: Command[] = [fixture.step('check-1'), fixture.step('check-2')];

    const round = await runRound(fixture, { name: 'attempt-1', setup: [], checks });

    expect(round.outcome).toBe('passed');
    expect(round.setup).toEqual([]);
    expect(round.checks).toHaveLength(checks.length);
    expect(round.checks.every(commandSucceeded)).toBe(true);
    expect(await ran(fixture)).toEqual([
      'start check-1',
      'end check-1',
      'start check-2',
      'end check-2',
    ]);
    expect((await readdir(fixture.logsDir)).sort()).toEqual([
      'attempt-1-check-1.stderr.log',
      'attempt-1-check-1.stdout.log',
      'attempt-1-check-2.stderr.log',
      'attempt-1-check-2.stdout.log',
    ]);
  }, 45_000);
});
