/**
 * The fixture lifecycle, proved rather than asserted.
 *
 * The audit that led to this change found the same defect on every process
 * suite: `afterEach` removed the temporary directory without cancelling or
 * awaiting the work the test had started, so a test that failed, timed out or
 * was cancelled could leave a process holding the tree. This file proves the
 * shared replacement: the work a test owns is stopped and awaited, and only then
 * is the directory removed — after a passing test, an assertion failure, a setup
 * failure, a cancellation, and a timeout with work still pending.
 *
 * The four failing cases run as a suite of their own through
 * `vitest.lifecycle.config.ts`, because a suite that must fail cannot be part of
 * the gate it proves. Each case writes what it started to a report file, and the
 * proof then asks the process's own beacon — never a bare PID — whether it is
 * really gone. Nothing here kills a process it did not start, and no wait is
 * unbounded.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureProcessGone, processGone, removeDirectory } from './fixtures/local-target.js';
import { beaconModuleUrl } from './fixtures/local-target.js';
import {
  disposeFixtures,
  ownFixtureProcess,
  runProcess,
  useFixtureLifecycle,
} from './fixtures/lifecycle.js';
import { STOP_GRACE_MS } from '../src/process/stop.js';
import { createTempDir, repoRoot } from './support.js';

useFixtureLifecycle();

/** What one failing case of the nested suite started. */
interface Started {
  readonly case: string;
  readonly directory: string;
  readonly pid: number | null;
  readonly token: string | null;
  readonly grandchild: number | null;
  /** What the case itself reported about what happened to it afterwards. */
  readonly outcome?: string;
}

/**
 * A program that starts a child of its own and never ends by itself, writing
 * both PIDs where the caller can read them. A stopped tree is only proved by
 * looking for the child too: stopping the command alone would not end it.
 */
const HANGING_TREE_SOURCE = [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {",
  "  stdio: 'ignore',",
  '  windowsHide: true,',
  '});',
  'writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, grandchild: child.pid }));',
  'setInterval(() => undefined, 1000);',
].join('\n');

/** Writes the hanging program into `directory` and returns its path. */
async function writeHangingTree(directory: string): Promise<string> {
  const file = path.join(directory, 'hanging-tree.mjs');
  await writeFile(file, HANGING_TREE_SOURCE, 'utf8');
  return file;
}

/** Waits, bounded, for a PID the host says is gone. */
async function gone(pid: number | null): Promise<boolean> {
  if (pid === null) {
    return true;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  for (;;) {
    if (processGone(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Ends a tree this proof deliberately left running. The unconfirmed case took
 * `taskkill` off its own `PATH`; the proof still reaches it by its absolute path,
 * because the tree has to be ended by whoever left it — nobody else will.
 */
function endLeftoverTree(pid: number | null, grandchild: number | null): void {
  if (process.platform !== 'win32') {
    return;
  }
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  for (const target of [grandchild, pid]) {
    if (target !== null) {
      spawnSync(taskkill, ['/PID', String(target), '/T', '/F'], { stdio: 'ignore' });
    }
  }
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

describe('the fixture lifecycle', () => {
  it('stops a command that outlives its own bound, and waits for it to go', async () => {
    const directory = await createTempDir();
    const pidFile = path.join(directory, 'tree.json');
    const file = await writeHangingTree(directory);

    const running = runProcess(process.execPath, [file, pidFile], {
      cwd: directory,
      timeoutMs: 750,
    });

    await expect(running).rejects.toThrow(/did not end within its 750 ms bound/u);
    const started = JSON.parse(await readFile(pidFile, 'utf8')) as {
      grandchild: number;
      pid: number;
    };
    // The rejection waited for the process itself: the command and the child it
    // started are both gone before the test ever sees the failure.
    expect(processGone(started.pid)).toBe(true);
    expect(processGone(started.grandchild)).toBe(true);
  }, 20_000);

  it("cancels a command when the test's own stop aborts, and waits for it to go", async () => {
    const directory = await createTempDir();
    const pidFile = path.join(directory, 'tree.json');
    const file = await writeHangingTree(directory);
    const stop = new AbortController();

    const running = runProcess(process.execPath, [file, pidFile], {
      cwd: directory,
      stop: stop.signal,
      timeoutMs: 20_000,
    });
    while (!existsSync(pidFile)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    stop.abort();

    await expect(running).rejects.toThrow(/was stopped while the test was still running/u);
    const started = JSON.parse(await readFile(pidFile, 'utf8')) as {
      grandchild: number;
      pid: number;
    };
    expect(processGone(started.pid)).toBe(true);
    expect(processGone(started.grandchild)).toBe(true);
  }, 30_000);

  it('stops and awaits a registered fixture process before removing its directory', async () => {
    const directory = await createTempDir();
    const started = await startBeaconProcess(directory);
    ownFixtureProcess({
      pid: started.pid,
      token: started.token,
      beaconDirectory: directory,
      child: null,
    });
    expect(await fixtureProcessGone({ dir: directory }, started.token)).toBe(false);

    await disposeFixtures();

    expect(await fixtureProcessGone({ dir: directory }, started.token)).toBe(true);
    expect(existsSync(directory)).toBe(false);
  }, 30_000);

  it('cleans up after the cases that must fail, time out or cancel', async () => {
    const reports = await createTempDir();
    const pids = await createTempDir();
    const report = path.join(reports, 'cases.jsonl');
    const vitest = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
    const config = path.join(repoRoot, 'vitest.lifecycle.config.ts');
    await mkdir(pids, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NEXUS_LIFECYCLE_REPORT: report,
      NEXUS_LIFECYCLE_PIDS: pids,
    };
    // The worker's own Vitest environment is not this run's: the cases must see
    // the config they are given, not the pool this file is running in.
    for (const name of Object.keys(env)) {
      if (name.startsWith('VITEST')) {
        delete env[name];
      }
    }

    const result = await runProcess(
      process.execPath,
      [vitest, 'run', '--config', config, '--reporter=dot'],
      { cwd: repoRoot, env, timeoutMs: 120_000 },
    );

    // The cases must really have failed: a proof whose cases passed proves
    // nothing about what the lifecycle does with a failure.
    expect(result.code).not.toBe(0);
    const started = (await readFile(report, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Started);
    const expected = ['assertion', 'cancellation', 'continuation', 'setup', 'timeout'];
    if (process.platform === 'win32') {
      // The unconfirmed stop needs a host utility the harness stops trees with,
      // which only the Windows path takes `PATH` for.
      expected.push('unconfirmed');
    }
    // The continuation writes a second record once it has resumed: that record
    // is how the proof sees that the closed scope refused its late command.
    const cases = new Set(started.map((entry) => entry.case));
    expect([...cases].sort()).toEqual(expected.sort());
    const first = new Map(started.map((entry) => [entry.case, entry]));

    for (const entry of started) {
      if (entry.case === 'unconfirmed') {
        // A stop the host would not carry out: the directory is preserved and
        // reported, and the tree is still running, which is why it was preserved.
        expect(existsSync(entry.directory), 'unconfirmed: directory').toBe(true);
        expect(
          `${result.stdout}${result.stderr}`,
          'unconfirmed: the failure names the kept directory',
        ).toContain('for the owner that may still hold it');
        // The proof ends what it left behind itself, using the host utility the
        // case took off `PATH`, and only then removes the preserved directory.
        endLeftoverTree(entry.pid, entry.grandchild);
        expect(await gone(entry.pid), 'unconfirmed: process').toBe(true);
        expect(await gone(entry.grandchild), 'unconfirmed: grandchild').toBe(true);
        await removeDirectory(entry.directory);
        expect(existsSync(entry.directory), 'unconfirmed: directory removed').toBe(false);
        continue;
      }
      // Every directory the case registered is gone: the hook removed it after
      // the work the case owned had been stopped and awaited.
      expect(existsSync(entry.directory), `${entry.case}: directory`).toBe(false);
      // Every process the case started is gone, including a child of a child.
      expect(await gone(entry.pid), `${entry.case}: process`).toBe(true);
      expect(await gone(entry.grandchild), `${entry.case}: grandchild`).toBe(true);
      if (entry.token !== null) {
        // A fixture process is proved gone through its own beacon: a PID this
        // host may already have handed on is never signalled, and never trusted.
        expect(
          await fixtureProcessGone({ dir: entry.directory }, entry.token),
          `${entry.case}: beacon`,
        ).toBe(true);
      }
    }

    // The continuation resumed after its test had timed out and been disposed:
    // the hook waited for it, its late command was refused rather than started,
    // and only then was the directory removed.
    const resumed = started.find((entry) => entry.outcome !== undefined);
    expect(resumed?.outcome).toContain('refused');
    expect(resumed?.outcome).toContain('the command ran: false');
    expect(existsSync(resumed?.directory ?? ''), 'continuation: directory').toBe(false);
    expect(existsSync(first.get('continuation')?.directory ?? '')).toBe(false);
  }, 180_000);
});
