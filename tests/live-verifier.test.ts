/**
 * The opt-in live check, verified offline.
 *
 * `tests/live/codex-live-check.ts` is the one thing in this repository that is
 * allowed to contact a real coding runtime, and it is deliberately outside
 * `npm test`, `npm run validate`, and CI. This suite is what keeps that
 * arrangement honest without making a single provider call:
 *
 * - the prerequisite gate is exercised with environments that cannot reach a
 *   runtime or an account, in process and as a real process, so an unexecuted
 *   live check is shown to exit with its own "nothing was verified" code rather
 *   than reporting a pass;
 * - the disposable project is prepared and its own committed baseline is run, so
 *   the fixture is shown to be a real, green, self-contained repository before a
 *   live run depends on it;
 * - the injected failure of the repair exercise is exercised round by round, and
 *   then through the same built-CLI boundary the end-to-end suite uses — the
 *   stand-in `codex` on the CLI's `PATH` — so the whole repair sequence is shown
 *   to work offline: red round, repair turn given the observed failure, green
 *   round, `repairsUsed: 1`;
 * - and the live entry point is shown to be absent from default test discovery,
 *   from `npm run validate`, and from CI.
 *
 * Nothing here stands in for the live exercise itself. What a live run does with
 * a real account is only ever observed by running one, in T16.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadHarnessConfig, loadTask, resolveWorkDir } from '../src/config.js';
import {
  EXIT_FAILED,
  EXIT_PREREQUISITES,
  GREET_SOURCE,
  INJECTED_FAILURE_LABEL,
  REPAIR_ARM_VARIABLE,
  builtCli,
  checkPrerequisites,
  createLiveTarget,
  runLiveExercise,
  verifyImplementationExercise,
  verifyRepairExercise,
} from './live/codex-live-check.js';
import type { LiveTarget } from './live/codex-live-check.js';
import {
  FEATURE_IMPLEMENTED,
  FEATURE_MISSING,
  GREET_ALL_SOURCE,
  WRONG_GREET_ALL_SOURCE,
  checkoutState,
  ensureBuiltCli,
  fakeTurns,
  installFakeRuntime,
  removeDirectory,
} from './fixtures/local-target.js';
import type { FakePlan, FakeState } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir, repoRoot } from './support.js';

/** The opt-in entry point, as `npm run test:live` runs it. */
const LIVE_ENTRY = path.join(repoRoot, 'tests', 'live', 'codex-live-check.ts');

/** Every disposable project this file prepared, so all of them are removed after it. */
const targets: LiveTarget[] = [];

/** How long a test that spawns a whole run may take. */
const RUN_TIMEOUT_MS = 120_000;

async function track(created: Promise<LiveTarget>): Promise<LiveTarget> {
  const target = await created;
  targets.push(target);
  return target;
}

afterAll(async () => {
  for (const target of targets.splice(0)) {
    await removeDirectory(target.parent);
  }
  await cleanupTempDirectories();
});

/**
 * An environment that can reach no coding runtime and no account: an empty
 * `PATH`, a home directory of its own with no runtime credentials in it, and no
 * API key inherited from whoever is running this suite.
 */
async function isolatedEnvironment(overrides: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const home = await createTempDir();
  const emptyPath = path.join(home, 'nothing-is-installed-here');
  await mkdir(emptyPath, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: emptyPath,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    ...overrides,
  };
  delete env.CODEX_API_KEY;
  return { ...env, ...overrides };
}

/** One line of a report, or `''`: a failure message that shows what was found. */
function joined(lines: readonly string[]): string {
  return lines.join('\n');
}

/**
 * The environment that makes the production adapter's `codex` the stand-in
 * runtime: the same boundary the end-to-end suite uses, with the plans this
 * test's turns follow.
 */
async function installStandInRuntime(
  target: LiveTarget,
  plans: readonly FakePlan[],
): Promise<{ readonly state: FakeState; readonly env: NodeJS.ProcessEnv }> {
  const { bin, state } = await installFakeRuntime(target.parent);
  return {
    state,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_CODEX: JSON.stringify({ stateDir: state.dir, plans }),
    },
  };
}

describe('the prerequisite gate', () => {
  it('refuses when nothing named like a coding runtime can be started', async () => {
    const report = checkPrerequisites({
      executable: 'nexus-no-such-runtime-9f3c',
      env: await isolatedEnvironment(),
    });

    expect(report.ok).toBe(false);
    expect(joined(report.problems)).toContain('nexus-no-such-runtime-9f3c');
    // The guidance a user needs, and no claim that anything was verified.
    expect(joined(report.problems)).toContain('Install the runtime');
    expect(joined(report.evidence)).not.toContain('runtime    ');
    expect(joined(report.evidence)).not.toContain('nexus-no-such-runtime-9f3c');
  });

  it('refuses when the runtime starts but no account evidence is present', async () => {
    // `node --version` stands in for the runtime's own version call: the gate is
    // about whether the runtime can be started at all, and a program that starts
    // and reports a version is exactly that case.
    const env = await isolatedEnvironment();
    const report = checkPrerequisites({ executable: process.execPath, env });

    expect(report.ok).toBe(false);
    expect(joined(report.evidence)).toContain(`runtime    ${process.execPath}`);
    expect(joined(report.evidence)).toContain(builtCli());
    expect(joined(report.problems)).toContain('no account evidence was found');
    expect(joined(report.problems)).toContain('codex login');
    expect(joined(report.problems)).toContain(String(env.CODEX_HOME));
  });

  it('accepts an API key as account evidence without ever reading its value', async () => {
    const secret = 'not-a-real-credential-nor-a-secret';
    const report = checkPrerequisites({
      executable: process.execPath,
      env: await isolatedEnvironment({ CODEX_API_KEY: secret }),
    });

    expect(report.ok).toBe(true);
    expect(joined(report.evidence)).toContain('CODEX_API_KEY is set');
    expect(joined(report.evidence)).not.toContain(secret);
  });

  it('accepts a runtime-owned auth file without opening it', async () => {
    // The file is deliberately not JSON: account evidence is whether a credential
    // source is there, and a gate that parsed the file would fail on this one.
    const authDir = path.join(await createTempDir(), '.codex');
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, 'auth.json'), 'not json, and never read\n', 'utf8');

    const report = checkPrerequisites({
      executable: process.execPath,
      env: await isolatedEnvironment({ CODEX_HOME: authDir }),
    });

    expect(report.ok).toBe(true);
    expect(joined(report.evidence)).toContain(path.join(authDir, 'auth.json'));
    expect(joined(report.evidence)).toContain('not opened');
  });

  it('reports every missing prerequisite, not just the first', async () => {
    const report = checkPrerequisites({
      executable: 'nexus-no-such-runtime-9f3c',
      env: await isolatedEnvironment(),
    });

    expect(report.problems.length).toBeGreaterThanOrEqual(2);
    expect(joined(report.problems)).toContain('nexus-no-such-runtime-9f3c');
    expect(joined(report.problems)).toContain('no account evidence was found');
  });
});

describe('the entry point, as a process', () => {
  it(
    'stops with its prerequisite exit code, and starts no exercise, when nothing it needs is there',
    async () => {
      const result = await spawnLiveEntry(await isolatedEnvironment());

      expect(result.status).toBe(EXIT_PREREQUISITES);
      expect(result.stderr).toContain('prerequisite:');
      expect(result.stderr).toContain('Nothing was verified');
      expect(result.stderr).toContain('This is not a pass.');
      // No exercise was attempted, so no runtime was invoked and nothing was
      // reported as passing.
      expect(result.stdout).not.toContain('live exercise');
      expect(result.stdout).not.toContain('live check passed');
      expect(result.stdout).not.toContain('run dir');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'refuses on the runtime alone: an account with no runtime to use it is not enough',
    async () => {
      // Everything is present except a runtime this host can start — and the
      // account evidence is there, so the only thing that can refuse is the
      // runtime. If this ever passed the gate, it would go on to start a live
      // exercise, which is exactly what must not happen on a host without one.
      const result = await spawnLiveEntry(
        await isolatedEnvironment({ CODEX_API_KEY: 'not-a-real-credential' }),
      );

      expect(result.status).toBe(EXIT_PREREQUISITES);
      expect(result.stderr).toContain('prerequisite:');
      expect(result.stderr).toContain('Install the runtime');
      expect(result.stderr).toContain('Nothing was verified');
      expect(result.stdout).not.toContain('live exercise');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'refuses on the account alone: a runtime with nothing to authenticate it is not enough',
    async () => {
      // Here the runtime is one this host can start: the same stand-in the
      // end-to-end suite puts first on the CLI's `PATH`, so nothing real is
      // reached even if this gate were wrong. Only the account is missing, and
      // the rest of the `PATH` is left alone so that the runtime can be started
      // at all — a shim that cannot be started would make this case about the
      // runtime instead of about the account.
      const parent = await createTempDir();
      const { bin, state } = await installFakeRuntime(parent);
      const result = await spawnLiveEntry({
        ...(await isolatedEnvironment()),
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_CODEX: JSON.stringify({ stateDir: state.dir, plans: [] }),
      });

      expect(result.status).toBe(EXIT_PREREQUISITES);
      expect(result.stderr).toContain('no account evidence was found');
      expect(result.stderr).toContain('codex login');
      expect(result.stderr).toContain('Nothing was verified');
      expect(result.stdout).toContain('runtime    codex');
      expect(result.stdout).not.toContain('live exercise');
    },
    RUN_TIMEOUT_MS,
  );

  it('is not named like a test, so default discovery cannot pick it up', () => {
    expect(path.basename(LIVE_ENTRY)).toBe('codex-live-check.ts');
    expect(LIVE_ENTRY.endsWith('.test.ts')).toBe(false);
  });

  it(
    'is absent from default test discovery',
    async () => {
      const vitest = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
      const listed = spawnSync(process.execPath, [vitest, 'list'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
      });

      expect(listed.status).toBe(0);
      expect(listed.stderr).toBe('');

      // The files discovery found, without their test names. A listing that named
      // nothing would prove nothing, so the files this suite belongs to are checked
      // for first: the default suites are discovered, and the opt-in entry point is
      // not among them.
      const files = new Set(
        listed.stdout
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => line.split(' > ')[0] ?? ''),
      );
      expect(files).toContain('tests/cli.integration.test.ts');
      expect(files).toContain('tests/live-verifier.test.ts');
      expect(files).not.toContain('tests/live/codex-live-check.ts');
      expect(listed.stdout).not.toContain('codex-live-check');
    },
    RUN_TIMEOUT_MS,
  );

  it('is not part of the validation gate or of CI', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:live']).toContain('tests/live/codex-live-check.ts');
    expect(pkg.scripts.validate).not.toContain('test:live');
    expect(pkg.scripts.validate).not.toContain('tests/live');
    expect(pkg.scripts.test).not.toContain('tests/live');

    const workflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow).toContain('npm run validate');
    expect(workflow).not.toContain('test:live');
    expect(workflow).not.toContain('tests/live');
  });
});

describe('the disposable project', () => {
  it('is a real repository on a committed, green baseline', async () => {
    const target = await track(createLiveTarget());
    const state = checkoutState(target.repo);

    expect(state.head).toBe(target.baseCommit);
    expect(state.status).toBe('');
    expect(existsSync(path.join(target.repo, 'src', 'greet-all.mjs'))).toBe(false);

    const prepared = runFixtureCommand(target, 'tools/prepare.mjs');
    expect(prepared.status).toBe(0);
    expect(prepared.stdout).toContain('prepare: ok');

    const checked = runFixtureCommand(target, 'tools/run-checks.mjs');
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain(FEATURE_MISSING);
    expect(checked.stdout).not.toContain(FEATURE_IMPLEMENTED);

    // The baseline is green because the feature is absent, not because anything
    // was skipped silently; and the project's own build artifacts are ignored, so
    // the baseline leaves the checkout clean.
    expect(checked.stdout).toContain('ok greet-all.test.mjs');
    expect(checked.stdout).toContain('run-checks: 2 of 2 test files passed');
    expect(checkoutState(target.repo).status).toBe('');
  });

  it('describes itself with the harness’s own configuration and task contracts', async () => {
    const target = await track(createLiveTarget());

    const config = await loadHarnessConfig(target.configPath);
    expect(resolveWorkDir(config, target.configPath)).toBe(target.workDir);
    expect(config.maxRepairs).toBe(2);
    expect(config.setup).toHaveLength(1);
    expect(config.checks).toHaveLength(1);
    // The output directory is outside the source repository the run is given.
    expect(target.workDir.startsWith(`${target.repo}${path.sep}`)).toBe(false);
    expect(target.workDir).toBe(path.join(target.parent, 'inputs', '.harness-runs'));

    const task = await loadTask(target.taskPath);
    expect(task.id).toBe('greet-all');
    expect(task.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it('carries the injected failure only in the repair fixture', async () => {
    const plain = await track(createLiveTarget());
    const repair = await track(createLiveTarget({ repairFixture: true }));

    // Nothing of the injected failure is in the plain fixture: not the file, not
    // its name in the check the project runs, not its words anywhere in the tree.
    expect(existsSync(path.join(plain.repo, 'tools', 'live-repair-fixture.mjs'))).toBe(false);
    const plainChecks = await readFile(path.join(plain.repo, 'tools', 'run-checks.mjs'), 'utf8');
    expect(plainChecks).not.toContain('injectFailureOnce');
    const plainText = await projectText(plain.repo);
    expect(plainText).not.toContain(INJECTED_FAILURE_LABEL);
    expect(plainText).not.toContain(REPAIR_ARM_VARIABLE);

    // The repair fixture carries it, and the project's own check is where it runs:
    // the check the harness is configured to run is the thing that injects.
    expect(existsSync(path.join(repair.repo, 'tools', 'live-repair-fixture.mjs'))).toBe(true);
    const repairChecks = await readFile(path.join(repair.repo, 'tools', 'run-checks.mjs'), 'utf8');
    expect(repairChecks).toContain('injectFailureOnce');
    expect(repairChecks).toContain('live-repair-fixture.mjs');
    const fixtureText = await readFile(
      path.join(repair.repo, 'tools', 'live-repair-fixture.mjs'),
      'utf8',
    );
    expect(fixtureText).toContain(INJECTED_FAILURE_LABEL);
    expect(fixtureText).toContain(REPAIR_ARM_VARIABLE);
    // The injected failure is committed in the fixture, before any run starts.
    expect(checkoutState(repair.repo).status).toBe('');
  });
});

describe('the repair fixture’s injected failure', () => {
  it(
    'waits for the arm file it is given, injects once, and never repairs itself',
    async () => {
      const target = await track(createLiveTarget({ repairFixture: true }));
      const greet = path.join(target.repo, 'src', 'greet.mjs');
      const marker = path.join(target.repo, 'build', 'live-repair-injected');
      const previouslyArmed = process.env[REPAIR_ARM_VARIABLE];

      // Every step below is the project's own check command, in the project, with
      // the arm variable set as the environment of the run would set it. That is
      // the same code path a live run uses.
      try {
        // Unarmed: the environment names no arm file, so the check is the check of
        // a project with no injected failure, and it is green.
        delete process.env[REPAIR_ARM_VARIABLE];
        const unarmed = runFixtureCommand(target, 'tools/run-checks.mjs');
        expect(unarmed.status).toBe(0);
        expect(unarmed.stdout).toContain(FEATURE_MISSING);
        expect(unarmed.stdout).not.toContain(INJECTED_FAILURE_LABEL);
        expect(await readFile(greet, 'utf8')).toBe(GREET_SOURCE);
        expect(existsSync(marker)).toBe(false);

        // Armed, but the file it waits for never appears — the run this fixture
        // belongs to never reached the point of arming it. The fixture gives up
        // instead of hanging the check it is part of, and injects nothing.
        process.env[REPAIR_ARM_VARIABLE] = path.join(
          target.parent,
          'an-arm-file-that-never-appears',
        );
        const startedAt = Date.now();
        const waiting = runFixtureCommand(target, 'tools/run-checks.mjs');
        expect(Date.now() - startedAt).toBeLessThan(30_000);
        expect(waiting.status).toBe(0);
        expect(waiting.stdout).not.toContain(INJECTED_FAILURE_LABEL);
        expect(await readFile(greet, 'utf8')).toBe(GREET_SOURCE);
        expect(existsSync(marker)).toBe(false);

        // Armed for real, as a live run arms it after its implementation turn has
        // ended: one failure, in a committed module, and the project's own test
        // fails on its own assertion rather than on anything the fixture says.
        process.env[REPAIR_ARM_VARIABLE] = target.armFile;
        await writeFile(target.armFile, '{}\n', 'utf8');
        const injected = runFixtureCommand(target, 'tools/run-checks.mjs');
        expect(injected.status).toBe(1);
        expect(injected.stdout).toContain(INJECTED_FAILURE_LABEL);
        expect(injected.stdout).toContain('FAILED greet.test.mjs');
        expect(await readFile(greet, 'utf8')).not.toBe(GREET_SOURCE);
        expect(existsSync(marker)).toBe(true);

        // A second check run is not a second injection: the fixture fires once, so
        // the red round that follows is the same failure and not a new one.
        const again = runFixtureCommand(target, 'tools/run-checks.mjs');
        expect(again.status).toBe(1);
        expect(again.stdout).not.toContain(INJECTED_FAILURE_LABEL);
        expect(await readFile(greet, 'utf8')).not.toBe(GREET_SOURCE);
      } finally {
        if (previouslyArmed === undefined) {
          delete process.env[REPAIR_ARM_VARIABLE];
        } else {
          process.env[REPAIR_ARM_VARIABLE] = previouslyArmed;
        }
      }
    },
    RUN_TIMEOUT_MS,
  );
});

describe('the exercises, through the stand-in runtime boundary', () => {
  beforeAll(() => {
    // The same artifact `npm run test:live` builds and starts; a bare `npm test`
    // on a fresh checkout has to produce it before the entry point can run.
    ensureBuiltCli();
  });

  it(
    'passes the implementation exercise when the turn does the work',
    async () => {
      const target = await track(createLiveTarget());
      const { state, env } = await installStandInRuntime(target, [
        {
          edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }],
          summary: 'added greetAll',
        },
      ]);

      const run = await runLiveExercise(target, { env });
      expect(run.runDir).not.toBeNull();

      expect(await verifyImplementationExercise(target, run)).toEqual([]);

      const turns = await fakeTurns(state);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.cwd).toBe(path.join(run.runDir ?? '', 'workspace'));
      // The turn the verifier asserted on was the adapter's own invocation, with
      // the documented arguments, in the working copy — the stand-in is only what
      // the name `codex` resolved to.
      expect(turns[0]?.argv).toEqual(['exec', '--sandbox', 'workspace-write', '--json', '-']);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'passes the repair exercise, and hands the injected failure to the repair turn',
    async () => {
      const target = await track(createLiveTarget({ repairFixture: true }));
      const { state, env } = await installStandInRuntime(target, [
        {
          edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }],
          summary: 'added greetAll',
        },
        {
          edits: [{ file: 'src/greet.mjs', text: GREET_SOURCE }],
          summary: 'restored the committed greeting',
        },
      ]);

      const run = await runLiveExercise(target, { env });
      expect(run.runDir).not.toBeNull();

      // The whole sequence, as the verifier sees it: baseline green, one injected
      // failure observed after the implementation turn, one repair turn, green.
      expect(await verifyRepairExercise(target, run)).toEqual([]);

      const turns = await fakeTurns(state);
      expect(turns).toHaveLength(2);
      // The repair turn was given the failure the harness observed, which is what
      // makes this a repair rather than a second attempt at the task.
      expect(turns[1]?.prompt).toContain(INJECTED_FAILURE_LABEL);
      expect(turns[1]?.prompt).toContain('FAILED greet.test.mjs');
      expect(turns[0]?.prompt).not.toContain(INJECTED_FAILURE_LABEL);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'reports what it found instead of passing a run that did not do the work',
    async () => {
      const target = await track(createLiveTarget({ maxRepairs: 1 }));
      const { env } = await installStandInRuntime(target, [
        {
          edits: [{ file: 'src/greet-all.mjs', text: WRONG_GREET_ALL_SOURCE }],
          summary: 'added greetAll',
        },
      ]);

      // The turn writes a feature the project's own acceptance test rejects, and
      // the single repair turn it is allowed writes nothing, so the run fails.
      const run = await runLiveExercise(target, { env });
      expect(run.code).toBe(EXIT_FAILED);

      const problems = await verifyImplementationExercise(target, run);
      expect(problems.length).toBeGreaterThan(0);
      expect(joined(problems)).toContain('"failed"');
      expect(joined(problems)).toContain('the round after the implementation turn');
      // The assertions above are not vacuous: the same verifier passes and fails
      // the same exercise depending on what the run really did.
      expect(joined(problems)).toContain("the project's own acceptance test");
    },
    RUN_TIMEOUT_MS,
  );
});

/**
 * Starts the opt-in entry point the way `npm run test:live` does — through tsx,
 * as a real process — and collects what it wrote. Only the prerequisite gate is
 * exercised with it: a run that got past the gate would be a live run, which
 * these tests never make.
 */
async function spawnLiveEntry(env: NodeJS.ProcessEnv): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return spawnSync(process.execPath, ['--import', 'tsx', LIVE_ENTRY], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
}

/** Runs one of the disposable project's own tools, in the project. */
function runFixtureCommand(
  target: LiveTarget,
  script: string,
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  return spawnSync(process.execPath, [script], {
    cwd: target.repo,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
}

/** Every file of a disposable project, joined, for an assertion about absence. */
async function projectText(repo: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'build') {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        parts.push(await readFile(full, 'utf8'));
      }
    }
  };
  await walk(repo);
  return parts.join('\n');
}
