/** The CLI helpers used by cli-run, with work pending at timeout/setup failure. */
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, it } from 'vitest';
import { createTempDir } from '../../../support.js';
import {
  beginCliFixtureEnvironment,
  createRunFixture,
  recordingSignals,
  run,
  runArgv,
  runGit,
} from '../../cli.js';
import { useFixtureLifecycle } from '../../lifecycle.js';
import { waitFor } from '../../local-target.js';

useFixtureLifecycle();
const report = process.env['NEXUS_LIFECYCLE_REPORT'] ?? '';
const pids = process.env['NEXUS_LIFECYCLE_PIDS'] ?? '';

async function pendingCli(name: string): Promise<Promise<void>[]> {
  await beginCliFixtureEnvironment();
  const program = path.join(await createTempDir(), 'check.mjs');
  const pidFile = path.join(pids, `${name}.json`);
  await writeFile(
    program,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
      'writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, grandchild: child.pid }));',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const fixture = await createRunFixture({
    config: { checks: [[process.execPath, program, pidFile]] },
  });
  const signals = recordingSignals();
  const running = run(
    runArgv({ repo: fixture.source, config: fixture.configPath, task: fixture.taskPath }),
    { cwd: fixture.parent, signals, dependencies: fixture.dependencies },
  );
  // No extra owner or abort listener here: this is the actual helper's contract.
  const settled = running.then(async (result) => {
    await appendFile(
      report,
      `${JSON.stringify({
        case: `${name}-settled`,
        directory: fixture.parent,
        pid: null,
        token: null,
        grandchild: null,
        outcome: `directory exists at settlement: ${String(existsSync(fixture.parent))}`,
        code: result.code,
        registered: signals.registered,
        released: signals.released,
      })}\n`,
    );
  });
  void settled.catch(() => undefined);
  await waitFor(async () => existsSync(pidFile), 'the in-process CLI check tree');
  const tree = JSON.parse(await readFile(pidFile, 'utf8')) as { pid: number; grandchild: number };
  await appendFile(
    report,
    `${JSON.stringify({ case: name, directory: fixture.parent, token: null, ...tree })}\n`,
  );
  return [settled];
}

it('times out with the in-process CLI check still pending', async () => {
  const [settled] = await pendingCli('in-process-cli-timeout');
  await settled;
}, 4_000);

describe('setup with the in-process CLI still pending', () => {
  beforeEach(async () => {
    await pendingCli('in-process-cli-setup');
    throw new Error('setup failed with a real in-process CLI check pending');
  });
  it('never reaches the body', () => {
    throw new Error('setup must fail first');
  });
});

describe('setup with the CLI fixture Git helper still pending', () => {
  beforeEach(async () => {
    await beginCliFixtureEnvironment();
    const directory = await createTempDir();
    const program = path.join(directory, 'git-child.mjs');
    const pidFile = path.join(pids, 'cli-git-setup.json');
    await writeFile(
      program,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
        `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, grandchild: child.pid }));`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    // Git executes this alias through its shell on both platforms. The fixture
    // helper must own Git and its descendants before returning a promise.
    const quote = (value: string): string =>
      `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    const running = runGit(
      ['-c', `alias.fixture=!${quote(process.execPath)} ${quote(program)}`, 'fixture'],
      directory,
    );
    void running.catch(async (cause: unknown) => {
      await appendFile(
        report,
        `${JSON.stringify({
          case: 'cli-git-setup-settled',
          directory,
          pid: null,
          token: null,
          grandchild: null,
          outcome: `directory exists at settlement: ${String(existsSync(directory))}`,
          problem: String(cause),
        })}\n`,
      );
    });
    await waitFor(async () => existsSync(pidFile), 'Git setup to start its child tree');
    const tree = JSON.parse(await readFile(pidFile, 'utf8')) as { pid: number; grandchild: number };
    await appendFile(
      report,
      `${JSON.stringify({ case: 'cli-git-setup', directory, token: null, ...tree })}\n`,
    );
    throw new Error('setup failed with the CLI fixture Git helper pending');
  });
  it('never reaches the body', () => {
    throw new Error('setup must fail first');
  });
});
