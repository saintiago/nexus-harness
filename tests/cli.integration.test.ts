/**
 * The built CLI, end to end.
 *
 * Every test here spawns `node dist/cli.js` — the artifact `npm start` runs, not
 * a module import — against a disposable repository, and every test reads what
 * the run left behind: the working copy, the logs, and `result.json`. Git, the
 * target's own commands, the filesystem, reporting, argument parsing and the
 * production Codex adapter are the real ones; the single substituted boundary is
 * the executable named `codex` on the CLI's `PATH` (tests/fixtures/fake-codex.mjs
 * behind a `codex.cmd` shim), which is the lowest runtime boundary a CLI process
 * has. Nothing in `src/` knows the substitute exists, and no flag reaches it.
 *
 * See tests/fixtures/local-target.ts for the target project, the runtime
 * stand-in, and the process plumbing.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILT_CLI,
  FEATURE_IMPLEMENTED,
  FEATURE_MISSING,
  GREET_ALL_SOURCE,
  checkoutState,
  createLocalTarget,
  ensureBuiltCli,
  fakeEvents,
  fakeRuntimeUsed,
  fakeTurns,
  fixtureProcessGone,
  git,
  interruptCli,
  processGone,
  removeDirectory,
  runCli,
  waitFor,
} from './fixtures/local-target.js';
import type { LocalTarget } from './fixtures/local-target.js';
import { cleanupTempDirectories, writeJsonFile } from './support.js';
import type { AttemptEvidence, CommandResult, RunReport } from '../src/shared/types.js';

/** Every fixture created by this file, so that all of them are removed after it. */
const targets: LocalTarget[] = [];

/** How long one end-to-end run may take before the test that started it fails. */
const RUN_TIMEOUT_MS = 120_000;

async function track(created: Promise<LocalTarget>): Promise<LocalTarget> {
  const target = await created;
  targets.push(target);
  return target;
}

/** `run <repo> <config> <task>`: the only command that touches anything. */
function runArguments(target: LocalTarget): readonly string[] {
  return ['run', '--repo', target.repo, '--config', target.configPath, '--task', target.taskPath];
}

/**
 * One line of the outcome block the CLI prints for a run that reached a status.
 * The row carries the time it reached the terminal, and then its indent and its
 * label — the indent is what separates it from a progress line that happens to
 * begin with the same word.
 */
function outcomeLine(stdout: string, label: string): string {
  const match = new RegExp(`^\\d{2}:\\d{2}:\\d{2}\\s{2,}${label}\\s+(\\S.*)$`, 'm').exec(stdout);
  if (match?.[1] === undefined) {
    throw new Error(`the CLI printed no "${label}" line:\n${stdout}`);
  }
  return match[1].trim();
}

/** Every run directory under a target's configured output directory. */
async function runDirectories(target: LocalTarget): Promise<readonly string[]> {
  const runsRoot = path.join(target.workDir, 'runs');
  if (!existsSync(runsRoot)) {
    return [];
  }
  const entries = await readdir(runsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsRoot, entry.name));
}

/**
 * Where a run's workspace lives, derived from the run's own evidence path: the
 * two are siblings under whichever output directory the configuration selected.
 */
function workspaceOf(runDir: string): string {
  return path.join(path.dirname(path.dirname(runDir)), 'workspaces', path.basename(runDir));
}

/** The one run directory a single-run test left behind. */
async function onlyRunDirectory(target: LocalTarget): Promise<string> {
  const directories = await runDirectories(target);
  expect(directories).toHaveLength(1);
  const [only] = directories;
  if (only === undefined) {
    throw new Error('no run directory was created');
  }
  return only;
}

/** The final report of a run, as a reader of `result.json` sees it. */
async function readReport(runDir: string): Promise<RunReport> {
  const file = path.join(runDir, 'result.json');
  expect(existsSync(file)).toBe(true);
  return JSON.parse(await readFile(file, 'utf8')) as RunReport;
}

/** A value the report must carry, named in the failure when it does not. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`the report carries no ${what}`);
  }
  return value;
}

/** The text of a file, asserting that it is there at all. */
async function readText(file: string): Promise<string> {
  expect(existsSync(file), file).toBe(true);
  return await readFile(file, 'utf8');
}

/** The log files a command invocation recorded, both of which must exist. */
function commandIsGreen(result: CommandResult, expected: readonly string[]): void {
  expect(result.command).toEqual([...expected]);
  expect(result.outcome).toBe('exited');
  expect(result.exitCode).toBe(0);
  expect(result.terminationProblem).toBeNull();
  expect(existsSync(result.stdoutPath), result.stdoutPath).toBe(true);
  expect(existsSync(result.stderrPath), result.stderrPath).toBe(true);
}

function attemptOf(report: RunReport, index: number): AttemptEvidence {
  const attempt = report.attempts[index];
  if (attempt === undefined) {
    throw new Error(
      `the report carries ${String(report.attempts.length)} attempts, not ${String(index + 1)}`,
    );
  }
  return attempt;
}

beforeAll(() => {
  // `npm run validate` builds before it tests; a bare `npm test` may not have.
  ensureBuiltCli();
  expect(existsSync(BUILT_CLI), BUILT_CLI).toBe(true);
});

/**
 * A fixture's recorded beacon token, or `null` when the record carries none — a
 * record written before the beacon existed, say. A process without a token is
 * still checked, by PID, rather than skipped.
 */
function recordedBeaconToken(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

afterAll(async () => {
  // A run stops what it started; a fixture process still alive here is a defect
  // worth failing for, not something to clean up quietly. Each process is asked
  // itself, through the beacon it recorded, rather than asked for by PID: a PID
  // is reused long before a suite this size ends. A record whose beacon never
  // answered is still checked by PID.
  const leftovers: string[] = [];
  for (const target of targets) {
    for (const turn of await fakeTurns(target.state)) {
      const recorded: readonly (readonly [number | null, string | null])[] = [
        [turn.pid, recordedBeaconToken(turn.pidToken)],
        [turn.child, recordedBeaconToken(turn.childToken)],
      ];
      for (const [pid, token] of recorded) {
        if (pid === null) {
          continue;
        }
        const gone =
          token === null ? processGone(pid) : await fixtureProcessGone(target.state, token);
        if (!gone) {
          leftovers.push(
            `pid ${String(pid)} of a fixture runtime recorded in ${target.state.turnsFile} ` +
              `(asked at ${token === null ? 'its PID' : 'its beacon'})`,
          );
        }
      }
    }
  }

  for (const target of targets) {
    await removeDirectory(target.parent);
  }
  await cleanupTempDirectories();

  expect(leftovers, 'fixture processes still running after the suite').toEqual([]);
});

describe('the built CLI, end to end', () => {
  it(
    'runs a task to a pass, keeping real changes and a parseable report',
    async () => {
      const target = await track(createLocalTarget());
      const before = checkoutState(target.repo);

      const result = await runCli({
        target,
        argv: runArguments(target),
        plans: [
          {
            edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }],
            summary: 'implemented greetAll in src/greet-all.mjs',
          },
        ],
      });

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(': passed');

      // The CLI's own account of where it left things must be the truth.
      const runDir = outcomeLine(result.stdout, 'run dir');
      const reportPath = outcomeLine(result.stdout, 'report');
      expect(runDir).toBe(await onlyRunDirectory(target));
      expect(existsSync(runDir)).toBe(true);
      expect(existsSync(reportPath)).toBe(true);
      expect(existsSync(path.join(runDir, 'logs', 'run.log'))).toBe(true);

      const report = await readReport(runDir);
      expect(report.status).toBe('passed');
      expect(report.repairsUsed).toBe(0);
      expect(report.timeout).toBeNull();
      expect(report.cancellation).toBeNull();
      expect(report.source.path).toBe(target.repo);
      expect(report.source.baseCommit).toBe(before.head);
      expect(report.workspace.prepared).toBe(true);

      // The turn ran through the production adapter, in the run's own clone.
      const turns = await fakeTurns(target.state);
      expect(turns).toHaveLength(1);
      const [turn] = turns;
      expect(turn?.argv).toEqual([
        '--ask-for-approval',
        'never',
        'exec',
        '--sandbox',
        'danger-full-access',
        '--json',
        '-',
      ]);
      expect(turn?.cwd).toBe(workspaceOf(runDir));
      expect(turn?.prompt).toContain('## Task greet-all: Add a greetAll helper to tiny-target');
      expect(turn?.prompt).toContain("- greetAll([]) is 'Hello, nobody!'.");
      expect(turn?.prompt).not.toContain('## Why this turn exists');

      // The change is real: it is in the retained working copy, on disk.
      const workspace = workspaceOf(runDir);
      expect(await readText(path.join(workspace, 'src', 'greet-all.mjs'))).toBe(GREET_ALL_SOURCE);
      expect(git(workspace, 'status', '--porcelain')).toContain('src/greet-all.mjs');

      // The baseline was observed before the turn and the checks after it are
      // complete: one setup invocation and one result per configured check.
      const baseline = required(report.baseline, 'baseline round');
      expect(baseline.outcome).toBe('passed');
      expect(baseline.setup).toHaveLength(1);
      expect(baseline.checks).toHaveLength(1);
      commandIsGreen(required(baseline.checks[0], 'baseline check'), [
        process.execPath,
        'tools/run-checks.mjs',
      ]);
      expect(await readText(required(baseline.checks[0], 'baseline check').stdoutPath)).toContain(
        FEATURE_MISSING,
      );

      const attempt = attemptOf(report, 0);
      expect(attempt.kind).toBe('implementation');
      expect(attempt.agentSummary).toContain('greetAll');
      const observed = required(attempt.checks, 'round after the implementation turn');
      expect(observed.outcome).toBe('passed');
      expect(observed.problem).toBeNull();
      expect(observed.setup).toHaveLength(1);
      expect(observed.checks).toHaveLength(1);
      commandIsGreen(required(observed.checks[0], 'check after the implementation turn'), [
        process.execPath,
        'tools/run-checks.mjs',
      ]);
      expect(
        await readText(
          required(observed.checks[0], 'check after the implementation turn').stdoutPath,
        ),
      ).toContain(FEATURE_IMPLEMENTED);
      expect(existsSync(attempt.agentLog), attempt.agentLog).toBe(true);

      // The change summary is an inspection of the clone, and it says what the
      // status does and does not prove. The ignored build artifact the project's
      // own setup step rewrites is not a change.
      expect(report.changes.inspected).toBe(true);
      expect(report.changes.problem).toBeNull();
      expect(report.changes.baseCommit).toBe(before.head);
      expect(report.changes.paths.map((changed) => changed.path)).toEqual(['src/greet-all.mjs']);
      expect(report.changes.highlighted).toEqual([]);
      expect(report.changes.warnings.checks).toContain('passed');

      // The source repository is exactly as it was.
      expect(checkoutState(target.repo)).toEqual(before);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'launches the configured prefix, literally, and records it in the report and timeline',
    async () => {
      const target = await track(createLocalTarget());
      const prefix = [target.runtimePath, '--profile', 'deepseek', '--model', 'deepseek-flash'];
      // A second configuration file for the same disposable project: only the
      // agent selection differs from the fixture's own, and it names the
      // stand-in runtime by path, as an operator names an installed CLI.
      const configPath = await writeJsonFile(target.configDir, 'selected.config.json', {
        workDir: './runs-selected',
        maxRepairs: 0,
        taskTimeoutMinutes: 60,
        commandTimeoutMinutes: 10,
        agent: { runtime: 'codex', command: prefix },
      });

      const result = await runCli({
        target,
        argv: ['run', '--repo', target.repo, '--config', configPath, '--task', target.taskPath],
        plans: [
          {
            edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }],
            summary: 'implemented greetAll',
          },
        ],
      });

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const runDir = outcomeLine(result.stdout, 'run dir');
      const report = await readReport(runDir);

      // The report names the launch the run used, and the timeline names it once.
      expect(report.agent).toEqual({ runtime: 'codex', command: prefix });
      const timeline = await readText(path.join(runDir, 'logs', 'run.log'));
      expect(timeline.match(/agent selected:/g)).toHaveLength(1);
      expect(timeline).toContain(JSON.stringify(prefix));

      // What really started is the configured prefix and then the adapter's own
      // arguments: the selection is not decorative, and nothing is reordered.
      const turns = await fakeTurns(target.state);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.argv).toEqual([
        '--profile',
        'deepseek',
        '--model',
        'deepseek-flash',
        '--ask-for-approval',
        'never',
        'exec',
        '--sandbox',
        'danger-full-access',
        '--json',
        '-',
      ]);
      expect(turns[0]?.cwd).toBe(workspaceOf(runDir));
    },
    RUN_TIMEOUT_MS,
  );


  it(
    'refuses invalid input with a nonzero exit and creates no run artifacts',
    async () => {
      const target = await track(createLocalTarget());
      const before = checkoutState(target.repo);
      const badTask = await writeJsonFile(target.configDir, 'invalid-task.json', {
        id: 'greet-all',
        title: 'Add a greetAll helper to tiny-target',
        description: 'This task file is missing its acceptance criteria and must be refused.',
      });

      const invalid = await runCli({
        target,
        argv: ['run', '--repo', target.repo, '--config', target.configPath, '--task', badTask],
        plans: [{ summary: 'a turn that must never run' }],
      });
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain('error:');
      expect(invalid.stdout).not.toContain(': passed');

      const unknownOption = await runCli({
        target,
        argv: ['run', '--repo', target.repo, '--config', target.configPath, '--nonsense', 'x'],
      });
      expect(unknownOption.code).toBe(2);
      expect(unknownOption.stderr).toContain('unknown option');

      const missingOption = await runCli({
        target,
        argv: ['run', '--repo', target.repo, '--config', target.configPath],
      });
      expect(missingOption.code).toBe(2);
      expect(missingOption.stderr).toContain('run requires --task');

      // Nothing was allocated, nothing ran, and the source is untouched.
      expect(await runDirectories(target)).toEqual([]);
      expect(fakeRuntimeUsed(target.state)).toBe(false);
      expect(checkoutState(target.repo)).toEqual(before);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'interrupts a running turn: the CLI stops, its fixture processes stop, and the run is cancelled',
    async () => {
      const target = await track(createLocalTarget());

      const result = await interruptCli({
        target,
        argv: runArguments(target),
        // A turn that is still working when the interrupt arrives, and that owns
        // a process of its own. Only a stop that really reaches it ends it.
        plans: [{ holdMs: 60_000, summary: 'still working on the implementation' }],
        started: async () => {
          await waitFor(async () => {
            const events = await fakeEvents(target.state);
            return events.some((event) => event.event === 'holding');
          }, 'the coding turn to be running and holding');
        },
      });

      // The interrupt was delivered by the operating system, not simulated, and
      // the CLI ended long before the turn it was holding would have finished.
      expect(result.delivered, result.detail).toBe(true);
      expect(result.elapsedMs).toBeLessThan(30_000);
      expect(result.code).toBe(130);

      const runDir = await onlyRunDirectory(target);
      const report = await readReport(runDir);
      expect(report.status).toBe('cancelled');
      expect(report.status).not.toBe('passed');
      const cancellation = required(report.cancellation, 'cancellation record');
      expect(cancellation.phase).toContain('turn');
      expect(cancellation.termination).toBe('confirmed');
      expect(cancellation.problem).toBeNull();
      expect(report.timeout).toBeNull();
      expect(report.reason).toContain('stopped by its caller');

      // No check round was invented for the turn that never finished.
      expect(report.attempts).toHaveLength(1);
      expect(attemptOf(report, 0).checks).toBeNull();

      // The run's own timeline says it was stopped, and never that it passed.
      const timeline = await readText(path.join(runDir, 'logs', 'run.log'));
      expect(timeline).toContain('cancelled: the run was stopped by its caller');
      expect(timeline).toContain('final status: cancelled');
      expect(timeline).not.toContain('final status: passed');
      if (process.platform !== 'win32') {
        // On Windows the CLI writes this to the console it owns; elsewhere its
        // standard error is a pipe this test holds.
        expect(result.stderr).toContain('interrupt received');
      }

      // Everything the turn started is gone, including the process the runtime
      // held open — nothing but the harness's own stop could have ended it, since
      // the stand-in runtime ignores the interrupt it is sent.
      const turns = await fakeTurns(target.state);
      expect(turns).toHaveLength(1);
      const turn = turns[0];
      expect(turn?.child).not.toBeNull();
      // Each process is asked itself, through the token it recorded: the answer
      // must be about these processes, not about whatever holds their PIDs now.
      expect(turn?.pidToken).toBeTruthy();
      expect(turn?.childToken).toBeTruthy();
      expect(
        await fixtureProcessGone(target.state, turn?.pidToken ?? ''),
        `the runtime process ${String(turn?.pid)}`,
      ).toBe(true);
      expect(
        await fixtureProcessGone(target.state, turn?.childToken ?? ''),
        `the runtime's own process ${String(turn?.child)}`,
      ).toBe(true);

      // The interrupt reaches the CLI and nothing else it started, on either
      // platform: the CLI is the console's own process, and the runtime it owns
      // is started without a console on Windows and in a process group of its own
      // elsewhere. So the stand-in runtime never observed a signal at all, and
      // what ended it was the harness's own stop, not the interrupt. That is
      // measured here rather than assumed — it is why the runtime's handlers do
      // not have to save it from an interrupt meant for the CLI.
      const signals = (await fakeEvents(target.state)).filter((event) => event.event === 'signal');
      expect(signals).toEqual([]);

      // The working copy and the evidence are retained, as they are for any run.
      expect(existsSync(workspaceOf(runDir))).toBe(true);
      expect(existsSync(attemptOf(report, 0).agentLog)).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'works with spaces in the config, task, source and output paths',
    async () => {
      const target = await track(
        createLocalTarget({
          repoName: 'tiny target repo',
          configDirName: 'harness inputs',
          workDirName: 'run outputs',
        }),
      );
      const before = checkoutState(target.repo);
      expect(target.configPath).toContain(' ');

      const result = await runCli({
        target,
        argv: runArguments(target),
        plans: [
          {
            edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }],
            summary: 'implemented greetAll',
          },
        ],
      });

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);

      // Every path the CLI printed is a real artifact with spaces in its name.
      const runDir = outcomeLine(result.stdout, 'run dir');
      const reportPath = outcomeLine(result.stdout, 'report');
      const workspace = outcomeLine(result.stdout, 'workspace').split(' (branch ')[0] ?? '';
      for (const artifact of [runDir, reportPath, workspace]) {
        expect(artifact).toContain(' ');
        expect(existsSync(artifact), artifact).toBe(true);
      }
      expect(runDir).toBe(path.join(target.workDir, 'runs', path.basename(runDir)));

      const report = await readReport(runDir);
      expect(report.status).toBe('passed');
      expect(report.source.path).toBe(target.repo);
      expect(report.workspace.path).toBe(workspace);
      const observed = required(attemptOf(report, 0).checks, 'round after the implementation turn');
      expect(observed.outcome).toBe('passed');

      // The logs and the check output the report names are all there.
      expect(existsSync(report.runLog)).toBe(true);
      for (const name of ['stdoutPath', 'stderrPath'] as const) {
        for (const invocation of [...observed.setup, ...observed.checks]) {
          expect(existsSync(invocation[name]), invocation[name]).toBe(true);
        }
      }
      const after = checkoutState(target.repo);
      expect(after).toEqual(before);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'touches neither the runtime nor the source for help and check-config',
    async () => {
      const target = await track(createLocalTarget());
      const before = checkoutState(target.repo);

      const help = await runCli({ target, argv: ['--help'] });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('Usage: <command> [options]');
      expect(help.stdout).toContain('check-config');

      const checked = await runCli({
        target,
        argv: [
          'check-config',
          '--config',
          target.configPath,
          '--project',
          target.repo,
          '--task',
          target.taskPath,
        ],
      });
      expect(checked.code).toBe(0);
      expect(checked.stderr).toBe('');
      expect(checked.stdout).toContain(`${target.configPath} is valid`);
      expect(checked.stdout).toContain(target.workDir);
      expect(checked.stdout).toContain('greet-all');

      // Neither command created a run, ran a configured command, or reached the
      // runtime: `check-config` is static.
      expect(await runDirectories(target)).toEqual([]);
      expect(existsSync(target.workDir)).toBe(false);
      expect(fakeRuntimeUsed(target.state)).toBe(false);
      expect(await fakeTurns(target.state)).toEqual([]);
      expect(existsSync(path.join(target.repo, 'build'))).toBe(false);
      expect(checkoutState(target.repo)).toEqual(before);

      // And it reads no native Codex configuration and no credential file:
      // `CODEX_HOME` points at a file rather than a directory, and both
      // credential variables hold a sentinel. A `check-config` that consulted
      // either would fail on the first or print the second.
      const notADirectory = path.join(target.parent, 'a-file-called-codex-home');
      await writeFile(notADirectory, 'not a directory, and never read\n', 'utf8');
      const sentinel = 'sentinel-credential-6c1f9a-never-read';
      const poisoned = await runCli({
        target,
        argv: [
          'check-config',
          '--config',
          target.configPath,
          '--project',
          target.repo,
          '--task',
          target.taskPath,
        ],
        env: {
          CODEX_HOME: notADirectory,
          CODEX_API_KEY: sentinel,
          DEEPSEEK_API_KEY: sentinel,
        },
      });
      expect(poisoned.code).toBe(0);
      expect(`${poisoned.stdout}${poisoned.stderr}`).not.toContain(sentinel);
      expect(await readText(notADirectory)).toBe('not a directory, and never read\n');
      expect(await runDirectories(target)).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );
});
