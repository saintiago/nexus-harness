/** The standalone delivery/adapter/Git callers, with real work pending at teardown. */
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, it } from 'vitest';
import { openAgentLog } from '../../../../src/reporting/logs.js';
import { codexRuntime } from '../../../../src/agents/codex/runtime.js';
import { createTempDir } from '../../../support.js';
import {
  createGitHubDelivery,
  runCodexPrompt,
  runCodexTurn,
  runGit,
  withFixtureEnvironment,
} from '../../boundary-operations.js';
import { fakeTurns, git, installFakeGit, installFakeRuntime, waitFor } from '../../local-target.js';
import { useFixtureLifecycle } from '../../lifecycle.js';

useFixtureLifecycle();
const report = process.env['NEXUS_LIFECYCLE_REPORT'] ?? '';
type Entry = 'delivery' | 'git' | 'prompt' | 'turn';

async function startPending(entry: Entry, ending: string): Promise<Promise<void>[]> {
  const directory = await createTempDir();
  const name = `boundary-${entry}-${ending}`;
  const previousPath = process.env.PATH;
  const previousGit = process.env.FAKE_GIT;
  const caller = new AbortController(); // Teardown must add its stop to this unrelated one.
  let closed = entry === 'delivery' || entry === 'git';
  let record: () => Promise<{
    pid: number;
    pidToken: string | null;
    child: number | null;
    childToken: string | null;
  }>;
  let beaconDirectory: string;
  let running: Promise<unknown>;

  if (entry === 'delivery' || entry === 'git') {
    const fake = await installFakeGit(directory);
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    beaconDirectory = fake.state.dir;
    record = async () =>
      JSON.parse(await readFile(path.join(fake.state.dir, `${name}.json`), 'utf8'));
    let bin = fake.bin;
    if (entry === 'delivery') {
      // Reach gh after real revision validation and a real push to a local remote.
      // Only gh hangs; its executable is the beacon-capable Git stand-in renamed.
      bin = path.join(directory, 'gh-bin');
      await mkdir(bin);
      await copyFile(fake.shim, path.join(bin, process.platform === 'win32' ? 'gh.cmd' : 'gh'));
      git(workspace, 'init', '--quiet', '--initial-branch=main');
      await writeFile(path.join(workspace, 'baseline'), 'baseline');
      git(workspace, 'add', 'baseline');
      git(workspace, 'commit', '--quiet', '-m', 'baseline');
    }
    const environment = {
      PATH: `${bin}${path.delimiter}${previousPath ?? ''}`,
      FAKE_GIT: JSON.stringify({
        stateDir: fake.state.dir,
        id: name,
        mode: 'hang',
        holdMs: 600_000,
      }),
    };
    if (entry === 'git') {
      running = withFixtureEnvironment(environment, () =>
        runGit(['status'], directory, { stop: caller.signal }),
      );
    } else {
      const baseCommit = git(workspace, 'rev-parse', 'HEAD').trim();
      await writeFile(path.join(workspace, 'work'), 'work');
      git(workspace, 'add', 'work');
      git(workspace, 'commit', '--quiet', '-m', 'work');
      const remote = path.join(directory, 'remote.git');
      git(directory, 'init', '--quiet', '--bare', remote);
      const delivery = createGitHubDelivery(
        { type: 'github', repository: 'offline/test', baseBranch: 'main' },
        {
          pushUrl: remote,
          env: { ...process.env, ...environment },
        },
      );
      running = withFixtureEnvironment(environment, () =>
        delivery.deliver(
          {
            workspacePath: workspace,
            branch: 'main',
            baseCommit,
            logsDir: directory,
            runId: name,
            reportPath: path.join(directory, 'report.json'),
            task: { id: 'TEST-1', title: 'offline' },
            checks: 'passed',
          },
          caller.signal,
        ),
      );
    }
  } else {
    const fake = await installFakeRuntime(directory);
    beaconDirectory = fake.state.dir;
    record = async () => {
      const [first] = await fakeTurns(fake.state);
      if (first === undefined) throw new Error('runtime not started');
      return first;
    };
    const log = await openAgentLog(directory, 1);
    const runtime = codexRuntime({
      command: [fake.shim],
      env: {
        ...process.env,
        FAKE_CODEX: JSON.stringify({ stateDir: fake.state.dir, plans: [{ holdMs: 600_000 }] }),
      },
    });
    const common = {
      workspacePath: directory,
      stop: caller.signal,
      agentLog: {
        ...log,
        close: async () => {
          await log.close();
          closed = true;
        },
      },
    };
    running =
      entry === 'prompt'
        ? runCodexPrompt({ ...common, prompt: 'offline prompt', label: name }, runtime)
        : runCodexTurn(
            {
              ...common,
              kind: 'implementation',
              turn: 1,
              task: {
                id: 'TEST-1',
                title: 'offline',
                description: 'offline',
                acceptanceCriteria: [],
              },
              sourceRoot: directory,
              baseCommit: 'a'.repeat(40),
              repair: null,
            },
            runtime,
          );
  }

  // Observe the returned promise; do not add a second lifecycle owner in this proof.
  const settled = running
    .then(
      (result) => ({ result }),
      (cause: unknown) => ({ problem: String(cause) }),
    )
    .then(async (result) => {
      await appendFile(
        report,
        `${JSON.stringify({
          case: `${name}-settled`,
          directory,
          pid: null,
          token: null,
          grandchild: null,
          outcome: `directory exists at settlement: ${String(existsSync(directory))}`,
          environmentRestored:
            process.env.PATH === previousPath && process.env.FAKE_GIT === previousGit,
          closed,
          callerAborted: caller.signal.aborted,
          ...result,
        })}\n`,
      );
    });
  void settled.catch(() => undefined);
  await waitFor(async () => {
    try {
      await record();
      return true;
    } catch {
      return false;
    }
  }, `${name} to start its tree`);
  const tree = await record();
  await appendFile(
    report,
    `${JSON.stringify({
      case: name,
      directory,
      pid: tree.pid,
      token: tree.pidToken,
      grandchild: tree.child,
      childToken: tree.childToken,
      beaconDirectory,
    })}\n`,
  );
  return [settled];
}

for (const entry of ['delivery', 'git', 'prompt', 'turn'] as const) {
  it(`times out with standalone ${entry} pending`, async () => {
    const [settled] = await startPending(entry, 'timeout');
    await settled;
  }, 3_000);

  describe(`setup failure with standalone ${entry} pending`, () => {
    beforeEach(async () => {
      await startPending(entry, 'setup');
      throw new Error(`setup failed with ${entry} pending`);
    });
    it('never reaches the body', () => {
      throw new Error('setup must fail first');
    });
  });
}
