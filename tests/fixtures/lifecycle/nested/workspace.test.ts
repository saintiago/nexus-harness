/** Remaining restored callers, with their actual Git/runtime work pending at teardown. */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, it } from 'vitest';
import {
  HARNESS_CONFIG_FILE_NAME,
  PROJECT_CONFIG_FILE_NAME,
} from '../../../../src/config/paths.js';
import { createTempDir, writeJsonFile } from '../../../support.js';
import { prepareRun } from '../../workspace.js';
import { prepareReviewView, withFixtureEnvironment } from '../../boundary-operations.js';
import {
  baselineWithLogs,
  fakeJira,
  refFor,
  reviewerFor,
  SOURCE_CONFIG,
  taskFor,
} from '../../baseline.js';
import { runCli } from '../../operations.js';
import { createLocalTarget, fakeTurns, git, installFakeGit, waitFor } from '../../local-target.js';
import { useFixtureLifecycle } from '../../lifecycle.js';

useFixtureLifecycle();
const report = process.env['NEXUS_LIFECYCLE_REPORT'] ?? '';
const entries = ['workspace', 'review-view', 'baseline-reviewer', 'baseline-cli'] as const;
type Entry = (typeof entries)[number];
async function startPending(entry: Entry, ending: string): Promise<Promise<void>[]> {
  const name = `restored-${entry}-${ending}`;
  const directory = await createTempDir();
  const caller = new AbortController();
  const previous = {
    PATH: process.env.PATH,
    FAKE_GIT: process.env.FAKE_GIT,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
    FAKE_CODEX: process.env.FAKE_CODEX,
  };
  let beaconDirectory: string;
  let record: () => Promise<{
    pid: number;
    pidToken: string | null;
    child: number | null;
    childToken: string | null;
  }>;
  let running: Promise<unknown>;
  let site: ReturnType<typeof fakeJira> | undefined;
  if (entry === 'workspace' || entry === 'review-view') {
    const fake = await installFakeGit(directory);
    beaconDirectory = fake.state.dir;
    record = async () =>
      JSON.parse(await readFile(path.join(beaconDirectory, `${name}.json`), 'utf8'));
    const repo = path.join(directory, 'repo');
    await mkdir(repo);
    const environment = {
      PATH: `${fake.bin}${path.delimiter}${previous.PATH ?? ''}`,
      FAKE_GIT: JSON.stringify({
        stateDir: fake.state.dir,
        id: name,
        mode: 'hang',
        holdMs: 600_000,
      }),
    };
    running = withFixtureEnvironment(environment, () =>
      entry === 'workspace'
        ? prepareRun({ parent: directory, repo, workDir: path.join(directory, 'runs') })
        : prepareReviewView(
            { dir: directory, workspacePath: repo, head: 'a'.repeat(40), base: 'b'.repeat(40) },
            caller.signal,
          ),
    );
  } else {
    const target = await createLocalTarget({ brokenBaseline: true });
    beaconDirectory = target.state.dir;
    record = async () => {
      const [first] = await fakeTurns(target.state);
      if (first === undefined) throw new Error('reviewer has not started');
      return first;
    };
    if (entry === 'baseline-reviewer') {
      const baseline = await baselineWithLogs();
      const baseCommit = git(target.repo, 'rev-parse', 'HEAD').trim();
      running = reviewerFor(target, [{ holdMs: 600_000 }])({
        dir: directory,
        item: { ref: refFor(), task: taskFor() },
        workspace: { path: target.repo, baseCommit },
        baseline,
        stop: caller.signal,
      });
    } else {
      await writeJsonFile(target.repo, PROJECT_CONFIG_FILE_NAME, {
        setup: [[process.execPath, 'tools/prepare.mjs']],
        checks: [[process.execPath, 'tools/run-checks.mjs']],
        source: { ...SOURCE_CONFIG },
        delivery: { type: 'github', repository: 'offline/test', baseBranch: 'main' },
      });
      git(target.repo, 'add', '--all');
      git(target.repo, 'commit', '--quiet', '-m', 'offline baseline diagnosis');
      await writeJsonFile(target.configDir, HARNESS_CONFIG_FILE_NAME, {
        workDir: './runs',
        maxRepairs: 0,
        taskTimeoutMinutes: 60,
        commandTimeoutMinutes: 10,
        agent: { runtime: 'codex', command: [target.runtimePath] },
        reviewer: {
          app: {
            appId: 123,
            installationId: 456,
            privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
            login: 'nexus-lens',
          },
          reviewer: { runtime: 'codex', command: [target.runtimePath] },
          checkName: 'Nexus Lens review',
        },
      });
      site = fakeJira('To Do');
      const jira = site;
      running = withFixtureEnvironment(
        {
          JIRA_API_TOKEN: 'test-token',
          FAKE_CODEX: JSON.stringify({ stateDir: target.state.dir, plans: [{ holdMs: 600_000 }] }),
        },
        () =>
          runCli(['source', 'run', '--repo', target.repo, '--config', target.configPath], {
            cwd: target.parent,
            io: { out: () => undefined, err: () => undefined },
            fetch: jira.fetch,
          }),
      );
    }
  }
  // No extra operation owner: exercise the same helpers their restored suites use.
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
          environmentRestored: Object.entries(previous).every(
            ([key, value]) => process.env[key] === value,
          ),
          callerAborted: caller.signal.aborted,
          sourceStatus: site?.status,
          sourceComments: JSON.stringify(site?.comments),
          allocatedAfterStop: entry === 'workspace' && existsSync(path.join(directory, 'runs')),
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
  }, `${name} tree`);
  const tree = await record();
  await appendFile(
    report,
    `${JSON.stringify({ case: name, directory, pid: tree.pid, token: tree.pidToken, grandchild: tree.child, childToken: tree.childToken, beaconDirectory })}\n`,
  );
  return [settled];
}
for (const entry of entries) {
  it(`times out with ${entry} pending`, async () => {
    const [settled] = await startPending(entry, 'timeout');
    await settled;
  }, 5_000);
  describe(`setup failure with ${entry} pending`, () => {
    beforeEach(async () => {
      await startPending(entry, 'setup');
      throw new Error(`setup failed with ${entry} pending`);
    });
    it('never reaches the body', () => {
      throw new Error('setup must fail first');
    });
  });
}
