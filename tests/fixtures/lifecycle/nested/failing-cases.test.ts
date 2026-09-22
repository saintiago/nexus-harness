/**
 * The cases the fixture-lifecycle proof runs on purpose. Each one must end the
 * way a real gate can end — a timeout with work still pending, a failed
 * assertion beside a running command tree, a cancelled command, a setup failure
 * after a directory was registered, a stop the host would not carry out, and a
 * continuation that resumes after its test timed out and tries to start another
 * command — and each writes what it started to `$NEXUS_LIFECYCLE_REPORT`, so the
 * proof can ask afterwards whether the fixture's own beacon fell silent and
 * whether its directory was removed.
 *
 * `tests/fixture-lifecycle.test.ts` runs this suite through
 * `vitest.lifecycle.config.ts` and this file's own hook is the subject. The
 * ordinary gate never runs it, because a suite that must fail cannot be part of
 * the gate it proves.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  beaconModuleUrl,
  createLocalTarget,
  ensureBuiltCli,
  fakeEvents,
  fakeTurns,
  startCli,
  waitFor,
} from '../../local-target.js';
import type { LocalTarget } from '../../local-target.js';
import { createTempDir } from '../../../support.js';
import {
  ownFixtureOperation,
  ownFixtureProcess,
  runProcess,
  useFixtureLifecycle,
} from '../../lifecycle.js';

useFixtureLifecycle();

const REPORT = process.env['NEXUS_LIFECYCLE_REPORT'] ?? '';
const PIDS = process.env['NEXUS_LIFECYCLE_PIDS'] ?? '';

/** What one case started, as the proof reads it back after the run. */
interface Started {
  readonly case: string;
  readonly directory: string;
  readonly pid: number | null;
  readonly token: string | null;
  readonly grandchild: number | null;
  /** The directory the recorded beacon answers from, when it is not `directory`. */
  readonly beaconDirectory?: string;
  /** The beacon token of the recorded child, when it recorded one. */
  readonly childToken?: string | null;
  /** What the case itself reported about what happened to it afterwards. */
  readonly outcome?: string;
}

async function record(started: Started): Promise<void> {
  await appendFile(REPORT, `${JSON.stringify(started)}\n`, 'utf8');
}

/** A process that answers on its own beacon and never ends by itself. */
async function startBeaconProcess(directory: string): Promise<{ pid: number; token: string }> {
  const file = path.join(directory, 'beacon-process.mjs');
  await writeFile(
    file,
    [
      `import { randomToken, startBeacon } from ${JSON.stringify(beaconModuleUrl)};`,
      'const token = randomToken();',
      'await startBeacon(process.argv[2], token);',
      'process.stdout.write(`${JSON.stringify({ pid: process.pid, token })}\\n`);',
      'setInterval(() => undefined, 1000);',
    ].join('\n'),
    'utf8',
  );
  return await new Promise<{ pid: number; token: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [file, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    let output = '';
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const [line = ''] = output.split('\n');
      if (line.includes('token')) {
        resolve(JSON.parse(line) as { pid: number; token: string });
      }
    });
    child.on('error', reject);
  });
}

/**
 * One command this case owns through the shared runner, which starts a child of
 * its own and writes both PIDs where the proof can read them, because the
 * fixture's own directory is removed by the cleanup being proved.
 */
async function startHangingTree(
  name: string,
  cwd = PIDS,
): Promise<{ grandchild: number; pid: number }> {
  const file = path.join(PIDS, `${name}-tree.mjs`);
  await writeFile(
    file,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {",
      "  stdio: 'ignore',",
      '  windowsHide: true,',
      '});',
      'writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, grandchild: child.pid }));',
      'setInterval(() => undefined, 1000);',
    ].join('\n'),
    'utf8',
  );
  const pidFile = path.join(PIDS, `${name}.json`);
  const running = runProcess(process.execPath, [file, pidFile], { cwd });
  // The promise the runner returns is awaited by the case that stops it; a case
  // that fails first leaves it to the lifecycle, which ends it without turning
  // its own stop into an unhandled rejection.
  void running.catch(() => undefined);
  for (;;) {
    try {
      return JSON.parse(await readFile(pidFile, 'utf8')) as { grandchild: number; pid: number };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** The marker the test after the late case writes, releasing its continuation. */
const NEXT_TEST_MARKER = path.join(PIDS, 'the-next-test-began');

/** The file the late continuation would write if its command were allowed to run. */
const LATE_COMMAND_RAN = path.join(PIDS, 'the-late-command-ran');

/** What the report says about one case so far, as the suite reads it back. */
async function reportedOutcome(name: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(REPORT, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }
    const entry = JSON.parse(line) as Started;
    if (entry.case === name && entry.outcome !== undefined) {
      return entry.outcome;
    }
  }
  return null;
}

/** The arguments that run one task of the built CLI against a fixture target. */
function runArguments(target: LocalTarget): readonly string[] {
  return ['run', '--repo', target.repo, '--config', target.configPath, '--task', target.taskPath];
}

/**
 * The built CLI, as the process a test owns. `npm start`'s artifact is the one
 * entry point that starts a whole run — Git, the target's own commands, the
 * coding runtime — so a test that times out or fails its setup holding one has
 * to leave nothing behind: the hook stops the CLI's tree, waits for the CLI
 * itself, and only then removes the target its run wrote into.
 */
describe('the built CLI a test had to stop', () => {
  beforeAll(() => {
    // `npm run validate` builds before it tests; the proof may be started on its
    // own, and a case that spawned a missing artifact would prove nothing.
    ensureBuiltCli();
  });

  it('times out while the CLI it started is holding a coding turn', async () => {
    const target = await createLocalTarget();
    const started = startCli({
      target,
      argv: runArguments(target),
      plans: [{ holdMs: 60_000, summary: 'still working on the implementation' }],
    });
    // The promise the fixture returns is owned work as well as the child: the
    // hook ends it, so its own rejection must not surface as an unhandled one.
    void started.done.catch(() => undefined);
    await waitFor(
      async () => (await fakeEvents(target.state)).some((event) => event.event === 'holding'),
      'the coding turn to be running and holding',
      60_000,
    );
    const [turn] = await fakeTurns(target.state);
    await record({
      case: 'cli-timeout',
      directory: target.parent,
      beaconDirectory: target.state.dir,
      pid: turn?.pid ?? null,
      token: turn?.pidToken ?? null,
      childToken: turn?.childToken ?? null,
      grandchild: turn?.child ?? null,
    });
    // Never settles: the suite's own deadline ends this test while the CLI is
    // holding a real coding turn of its own. The bound is this case's own work —
    // one real CLI run up to the turn's hold, plus the room a loaded host needs —
    // not a layer-wide deadline.
    await new Promise(() => undefined);
  }, 8_000);

  /**
   * A setup failure that leaves a real CLI running: the hook meets the same
   * state a timed-out case leaves, and the target directory must not be removed
   * before the CLI that holds it has been stopped and awaited.
   */
  describe('a setup failure with the built CLI still running', () => {
    beforeEach(async () => {
      const target = await createLocalTarget();
      const started = startCli({
        target,
        argv: runArguments(target),
        plans: [{ holdMs: 60_000, summary: 'still working on the implementation' }],
      });
      void started.done.catch(() => undefined);
      await record({
        case: 'cli-setup',
        directory: target.parent,
        beaconDirectory: target.state.dir,
        pid: started.child.pid ?? null,
        token: null,
        grandchild: null,
      });
      throw new Error('the setup failed while the built CLI was still running');
    });

    it('never runs its body', () => {
      throw new Error('the body of a test whose setup failed must not run');
    });
  });
});

describe('the failing cases the proof runs', () => {
  it('times out with a fixture process and a directory still owned', async () => {
    const directory = await createTempDir();
    const fixture = await startBeaconProcess(directory);
    ownFixtureProcess({
      pid: fixture.pid,
      token: fixture.token,
      beaconDirectory: directory,
      child: null,
    });
    await record({
      case: 'timeout',
      directory,
      pid: fixture.pid,
      token: fixture.token,
      grandchild: null,
    });
    // Never settles: the suite's own deadline ends this test with the fixture
    // process still running and its directory still registered.
    await new Promise(() => undefined);
  }, 1500);

  it('fails an assertion while a command tree it owns is still running', async () => {
    const directory = await createTempDir();
    const pids = await startHangingTree('assertion');
    await record({ case: 'assertion', directory, token: null, ...pids });
    expect('the assertion in this case').toBe('what the proof expects');
  }, 20_000);

  it('cancels its own command and never leaves that command running', async () => {
    const directory = await createTempDir();
    const pids = await startHangingTree('cancellation');
    await record({ case: 'cancellation', directory, token: null, ...pids });
    // The stop belongs to the test, not to the lifecycle hook: this case proves
    // that a cancelled command is gone before its caller is told it stopped.
    const controller = new AbortController();
    const running = runProcess(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      cwd: directory,
      stop: controller.signal,
      timeoutMs: 20_000,
    });
    setTimeout(() => controller.abort(), 150);
    await expect(running).rejects.toThrow(/was stopped while the test was still running/u);
  }, 30_000);

  /**
   * Work that never settles, and the test that follows it. The hook cannot say
   * which directory the unsettled work holds, so it keeps the directory it had
   * registered — and the hold it leaves has to keep the *next* test's cleanup
   * from removing it, because that test's own problems say nothing about the
   * owner this directory belongs to. The proof removes it itself, by name, once
   * it has seen that a later test did not.
   */
  it('times out while an operation it started never settles', async () => {
    const directory = await createTempDir();
    await record({ case: 'unsettled', directory, pid: null, token: null, grandchild: null });
    void ownFixtureOperation('the operation that never settles', async () => {
      await new Promise(() => undefined);
    }).catch(() => undefined);
    // Never settles: the suite's own deadline ends this test with the operation
    // still running and its directory still registered.
    await new Promise(() => undefined);
  }, 1500);

  /** The successful test the hold has to survive. */
  it('runs to its end while the previous test still holds a directory', async () => {
    expect(await reportedOutcome('unsettled')).toBeNull();
  }, 30_000);

  /**
   * The directory a stop could not be confirmed for. On Windows the harness
   * stops a command tree by running `taskkill`, so taking that utility off this
   * process's `PATH` leaves the tree running and the stop unconfirmed — exactly
   * the state the fixture lifecycle must not remove a directory in.
   */
  it.skipIf(process.platform !== 'win32')(
    'cannot confirm the stop of a command tree, and leaves its directory in place',
    async () => {
      const directory = await createTempDir();
      const pids = await startHangingTree('unconfirmed', directory);
      await record({ case: 'unconfirmed', directory, token: null, ...pids });
      // Narrowing `PATH` is not undone here: the cleanup hook has to meet the
      // same condition the test left behind, which is the whole point.
      process.env.PATH = path.dirname(process.execPath);
    },
    20_000,
  );

  /**
   * A continuation that outlives its own test. The body hands the scope work
   * that is still sleeping when the test times out; when it resumes it tries to
   * start another command, and the closed scope has to refuse it rather than let
   * it run while the hook removes the directory it would write into.
   */
  it('times out while a continuation still intends to start another command', async () => {
    const directory = await createTempDir();
    const pidFile = path.join(directory, 'late.json');
    await record({ case: 'continuation', directory, pid: null, token: null, grandchild: null });
    void ownFixtureOperation('the delayed continuation', async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      let outcome = 'the command was not refused';
      try {
        await runProcess(
          process.execPath,
          ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, 'ran')`],
          { cwd: directory },
        );
      } catch (cause) {
        outcome = `refused: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      await record({
        case: 'continuation',
        directory,
        pid: null,
        token: null,
        grandchild: null,
        outcome: `${outcome}; the command ran: ${String(existsSync(pidFile))}`,
      });
    });
    // Never settles: the suite's own deadline ends this test while the
    // continuation is still asleep.
    await new Promise(() => undefined);
  }, 1500);

  /**
   * A continuation that resumes *after* its own cleanup hook returned and the
   * next test began. It waits for a marker the following case writes — a marker
   * that can only appear once this test's hook has finished, because the suite
   * runs its cases one at a time — so the resume happens while a later test is
   * the running one. The command it then asks for belongs to this test's closed
   * scope and has to be refused there, never started in the scope of the test
   * that happens to be running by then.
   */
  it('times out while a continuation waits for the test that follows', async () => {
    const directory = await createTempDir();
    await record({ case: 'late', directory, pid: null, token: null, grandchild: null });
    void ownFixtureOperation('the continuation that waits for the next test', async () => {
      const deadline = Date.now() + 30_000;
      while (!existsSync(NEXT_TEST_MARKER) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      let outcome = 'the command was not refused';
      try {
        const ran = await runProcess(
          process.execPath,
          ['-e', `require('node:fs').writeFileSync(${JSON.stringify(LATE_COMMAND_RAN)}, 'ran')`],
          { cwd: directory },
        );
        outcome = `the command was not refused: it exited with ${String(ran.code)}`;
      } catch (cause) {
        outcome = `refused: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      await record({
        case: 'late',
        directory,
        pid: null,
        token: null,
        grandchild: null,
        outcome: `${outcome}; the command ran: ${String(existsSync(LATE_COMMAND_RAN))}`,
      });
    }).catch(() => undefined);
    // Never settles: the suite's own deadline ends this test while the
    // continuation is waiting for the case that follows. Its work is still
    // unsettled when the hook gives up, so the hook keeps the directory and the
    // hold it records is asked again by the hooks that follow.
    await new Promise(() => undefined);
  }, 1500);

  /**
   * The test the late continuation waits for. It releases the continuation and
   * stays alive until the continuation has recorded what it did, so the resume
   * provably happens while this case is the running one.
   */
  it('runs while the previous case continues in the background', async () => {
    await writeFile(NEXT_TEST_MARKER, 'the next test began\n', 'utf8');
    await waitFor(
      async () => (await reportedOutcome('late')) !== null,
      'the previous case to record what its continuation did',
      20_000,
    );
  }, 30_000);
});

describe('a setup failure', () => {
  beforeEach(async () => {
    const directory = await createTempDir();
    await writeFile(path.join(directory, 'left-behind.txt'), 'the setup failed here\n', 'utf8');
    await record({
      case: 'setup',
      directory,
      pid: null,
      token: null,
      grandchild: null,
    });
    throw new Error('the setup failed after the fixture was registered');
  });

  it('never runs its body', () => {
    throw new Error('the body of a test whose setup failed must not run');
  });
});
