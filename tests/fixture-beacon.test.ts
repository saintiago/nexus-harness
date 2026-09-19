/**
 * The stand-in runtime's liveness beacon.
 *
 * The built-CLI suite has to ask whether a fixture process is still there, and it
 * cannot ask that of a PID: Windows hands a PID to a new process within seconds of
 * the process that held it ending, so a PID that looks alive is not evidence that
 * the process a turn recorded still is (see notes/windows-fixture-flakes.md).
 * Each invocation therefore answers, while it runs, at an address named by a
 * token only that process records in turns.jsonl. This suite proves the beacon is
 * that one process's own: it answers while the process runs, it falls silent once
 * the process is gone, and asking it is not a way to end the process being asked
 * about.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeTurns, fixtureProcessGone, stillRunning, waitFor } from './fixtures/local-target.js';
import type { FakeState, FakeTurn } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir, repoRoot } from './support.js';

/** The stand-in runtime: the file the fake `codex` on the CLI's `PATH` runs. */
const FIXTURE = path.join(repoRoot, 'tests', 'fixtures', 'fake-codex.mjs');

/** The adapter's own arguments, as the built-CLI suite sees them. */
const ADAPTER_ARGUMENTS = [
  '--ask-for-approval',
  'never',
  'exec',
  '--sandbox',
  'danger-full-access',
  '--json',
  '-',
];

/** A turn that never finishes by itself, and a child that does not either. */
const HOLDING_PLAN = [{ holdMs: 60_000, summary: 'still working' }];

/** One fixture this file started, so that none of them outlives the test. */
interface RunningFixture {
  readonly state: FakeState;
  readonly process: ChildProcess;
  /** Resolves when the process itself has ended, whenever that happens. */
  readonly closed: Promise<void>;
  /** The PIDs the fixture recorded for itself and its child, once it has. */
  readonly pids: number[];
}

/** Every fixture this file started, ended again after the test that started it. */
const started: RunningFixture[] = [];

/** Ends one process this file started, whatever state it is in by then. */
function endProcess(pid: number): void {
  if (pid <= 0) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone: nothing to end.
  }
}

/** Ends the tree of a fixture that never got as far as recording a turn. */
function endTree(fixture: RunningFixture): void {
  const pid = fixture.process.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // Started detached, so the negated PID names its own process group.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone: nothing to end.
  }
}

afterEach(async () => {
  for (const fixture of started.splice(0)) {
    for (const pid of fixture.pids) {
      endProcess(pid);
    }
    // The handle reaches the process even when no turn was recorded, and the
    // tree stop reaches a child the turn never named.
    fixture.process.kill('SIGKILL');
    endTree(fixture);
    // Bounded, so a fixture this host refuses to end cannot hang the suite.
    await Promise.race([
      fixture.closed,
      new Promise((resolve) => {
        setTimeout(resolve, 5000);
      }),
    ]);
  }
  await cleanupTempDirectories();
});

/** Starts the stand-in runtime in a turn that holds, and waits for its record. */
async function startHoldingTurn(): Promise<{ fixture: RunningFixture; turn: FakeTurn }> {
  const parent = await createTempDir();
  const stateDir = path.join(parent, 'state');
  await mkdir(stateDir, { recursive: true });
  const state: FakeState = {
    dir: stateDir,
    turnsFile: path.join(stateDir, 'turns.jsonl'),
    eventsFile: path.join(stateDir, 'runtime-events.jsonl'),
  };

  const runtime = spawn(process.execPath, [FIXTURE, ...ADAPTER_ARGUMENTS], {
    cwd: parent,
    env: {
      ...process.env,
      FAKE_CODEX: JSON.stringify({ stateDir, plans: HOLDING_PLAN }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own group elsewhere, so a stop reaches the child the turn starts too.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  runtime.stdin.end('the prompt\n');
  const closed = new Promise<void>((resolve) => {
    runtime.once('close', () => {
      resolve();
    });
  });
  const fixture: RunningFixture = { state, process: runtime, closed, pids: [] };
  started.push(fixture);

  await waitFor(async () => (await fakeTurns(state)).length === 1, 'the turn to be recorded');
  const turn = (await fakeTurns(state))[0];
  if (turn === undefined) {
    throw new Error('the turn was recorded and could not be read back');
  }
  fixture.pids.push(turn.pid);
  if (turn.child !== null) {
    fixture.pids.push(turn.child);
  }
  return { fixture, turn };
}

/** Waits, bounded, for one process's beacon to answer. */
async function waitForAnswer(state: FakeState, token: string, what: string): Promise<void> {
  await waitFor(async () => !(await fixtureProcessGone(state, token)), what);
}

/** Waits, bounded, for one process's beacon to stop answering. */
async function waitForSilence(state: FakeState, token: string, what: string): Promise<void> {
  await waitFor(async () => await fixtureProcessGone(state, token), what);
}

describe("the stand-in runtime's beacon", () => {
  it('answers while its process runs, and falls silent once that process is gone', async () => {
    const { fixture, turn } = await startHoldingTurn();
    const { state } = fixture;
    expect(turn.child).not.toBeNull();
    expect(turn.pidToken).not.toBe('');
    expect(turn.childToken).not.toBeNull();
    expect(turn.childToken).not.toBe(turn.pidToken);

    // Alive: the beacon answers, for this process and for its own child.
    await waitForAnswer(state, turn.pidToken ?? '', "the runtime's beacon to answer");
    await waitForAnswer(state, turn.childToken ?? '', "the child's beacon to answer");
    expect(await fixtureProcessGone(state, `${turn.pidToken ?? ''}-not-a-token`)).toBe(true);

    // Gone: each process ends, and its own beacon falls silent with it.
    endProcess(turn.pid);
    if (turn.child !== null) {
      endProcess(turn.child);
    }
    await waitForSilence(state, turn.pidToken ?? '', "the runtime's beacon to fall silent");
    await waitForSilence(state, turn.childToken ?? '', "the child's beacon to fall silent");
  }, 30_000);

  it('is not a way to end the process it asks about', async () => {
    const { fixture, turn } = await startHoldingTurn();
    const { state } = fixture;
    await waitForAnswer(state, turn.pidToken ?? '', "the runtime's beacon to answer");

    // A check connects and leaves the moment it has its answer; a turn that keeps
    // working through that is the whole point of asking instead of killing.
    for (let probe = 0; probe < 5; probe += 1) {
      expect(await fixtureProcessGone(state, turn.pidToken ?? '')).toBe(false);
    }
    expect(fixture.process.exitCode).toBeNull();
    expect(stillRunning(turn.pid)).toBe(true);
    expect(await fixtureProcessGone(state, turn.pidToken ?? '')).toBe(false);
  }, 30_000);

  it('answers for its own token alone, so a live process cannot stand in for a dead one', async () => {
    const first = await startHoldingTurn();
    const second = await startHoldingTurn();
    await waitForAnswer(first.fixture.state, first.turn.pidToken ?? '', 'the first beacon');
    await waitForAnswer(second.fixture.state, second.turn.pidToken ?? '', 'the second beacon');

    // The first turn ends; its beacon falls silent, and stays silent while the
    // second turn keeps answering. Nothing about the answering process can make
    // the dead one's token look alive — which is exactly what a reused PID would
    // have done to a check that asked a PID instead of a token.
    endProcess(first.turn.pid);
    if (first.turn.child !== null) {
      endProcess(first.turn.child);
    }
    await waitForSilence(first.fixture.state, first.turn.pidToken ?? '', 'the first beacon');
    expect(await fixtureProcessGone(first.fixture.state, first.turn.pidToken ?? '')).toBe(true);
    expect(await fixtureProcessGone(second.fixture.state, second.turn.pidToken ?? '')).toBe(false);
    expect(stillRunning(second.turn.pid)).toBe(true);
  }, 30_000);
});
