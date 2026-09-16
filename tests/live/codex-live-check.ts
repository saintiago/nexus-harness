/**
 * The opt-in live check: the real coding runtime, in a disposable project.
 *
 * `npm run test:live` runs this file. It is the only thing in this repository
 * that contacts a coding runtime, it is deliberately outside `npm test`,
 * `npm run validate`, and CI, and it is not evidence that the harness works in
 * general — it is evidence that the built CLI, the selected Codex invocation, a
 * real repository, and the project's own checks work together on this host, once,
 * with the account and configuration this machine is using.
 *
 * ## Selecting the runtime
 *
 * `npm run test:live -- --config harness.config.json` runs the exercises with the
 * agent, repair allowance, and numeric limits that file selects, loaded through
 * the harness's own schema and path rules. The fixture keeps the repository, the
 * output directory, the task, the setup, and the checks its own: a supplied
 * configuration's real-project commands are never run and its `workDir` is never
 * written to. Without `--config` the documented defaults are used, including the
 * ordinary Codex launch. A configuration that allows no repair turn is refused
 * before any paid work, because this verifier has to exercise a real repair.
 *
 * ## What it does
 *
 * It builds two disposable target repositories under the system temporary
 * directory, each with a committed, green baseline, and drives the built CLI
 * (`node dist/cli.js run …`) against them exactly as a user would — same
 * argument parsing, same Git, same configured commands, same report writing,
 * same production runtime adapter, no stand-in and no flag. Everything it
 * asserts afterwards is read from what those runs left behind: `result.json`,
 * `logs/run.log`, the per-turn agent logs, the per-command output logs, the
 * retained working copy, and the CLI's own exit code.
 *
 * 1. **Implementation exercise.** The task asks for a small helper the
 *    disposable project does not have yet. A real coding turn implements it, the
 *    project's own checks run afterwards, and the run must end `passed` with a
 *    complete green post-agent round.
 * 2. **Repair exercise.** The same shape, except that the disposable project
 *    carries one **injected** failure at its own test-only boundary
 *    (`tools/live-repair-fixture.mjs`): after the baseline is green and the
 *    implementation turn has returned, the project's own check breaks a
 *    committed module and fails on its real assertion, and the arm file that
 *    lets it do so is written by *this* file, after that turn has ended. The
 *    repair turn therefore gets real observed failure output, and the run must
 *    end `passed` with `repairsUsed: 1`. The injection is stated here, in the
 *    fixture, and in the check output it produces; it is never described as a
 *    defect the coding turn caused.
 *
 * ## Prerequisites, and why they are checked first
 *
 * A live check that cannot run must not look like one that passed. The
 * prerequisite gate below stops with its own exit code when the selected launcher
 * cannot be started, and it says plainly that nothing was verified. See
 * `docs/WORKFLOW.md` and README "Coding runtime" for the runtime's own setup and
 * authentication. Nothing here reads, prints, or writes a credential, and no
 * credential *source* is required: whether the selected runtime can really
 * authenticate and speak its protocol is what the bounded invocation inside each
 * exercise establishes, and a failure there is a failed check, never a pass.
 *
 * Exit codes: `0` every assertion held; `1` the check ran and something it
 * asserts did not hold; `2` a prerequisite was missing, so nothing ran at all.
 *
 * ## What it leaves behind
 *
 * The disposable directories are **kept**, like every run directory the harness
 * makes: they hold the reports, the logs, and the working copies this check
 * asserts on, and deleting them would delete the evidence. Remove them by hand
 * when you are done with them. Nothing is committed, pushed, or published, and
 * the source repository of a live check is a temporary repository this file
 * created — never a real project.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEX_EXECUTABLE } from '../../src/agent.js';
import { planLaunch } from '../../src/checks.js';
import { ConfigError, loadHarnessConfig } from '../../src/config.js';
import type {
  AgentSelection,
  AttemptEvidence,
  CheckRoundResult,
  CommandResult,
  RunReport,
} from '../../src/types.js';

/** Every assertion held. */
export const EXIT_OK = 0;
/** The check ran and something it asserts did not hold. */
export const EXIT_FAILED = 1;
/** A prerequisite was missing: nothing ran, and nothing was verified. */
export const EXIT_PREREQUISITES = 2;

/** The environment variable the repair fixture's check reads the arm file from. */
export const REPAIR_ARM_VARIABLE = 'LIVE_REPAIR_ARM';

/** The line the runner writes to `logs/run.log` when the implementation turns returns. */
const IMPLEMENTATION_DONE = 'implementation turn result: completed';

/** The label the injected failure carries wherever it appears. */
export const INJECTED_FAILURE_LABEL =
  'INJECTED FAILURE (live repair fixture, tests/live/codex-live-check.ts)';

/** How long `--version` is given before the runtime is called unreachable. */
const RUNTIME_PROBE_TIMEOUT_MS = 30_000;

/** How often the arming watcher looks for the end of the implementation turn. */
const POLL_MS = 25;

/** The built artifact this check drives: the file `npm start` runs. */
export function builtCli(): string {
  return path.join(repoRoot(), 'dist', 'cli.js');
}

function repoRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The first `max` characters of `text`, flattened onto one line. */
function excerpt(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)} [truncated]`;
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

export interface PrerequisiteOptions {
  /**
   * The launch prefix to look for: the executable, then any literal prefix
   * arguments, exactly as the configuration selected them. `['codex']` by
   * default, which is what an ordinary run starts.
   */
  readonly command?: readonly string[];
  /**
   * The built artifact the exercises drive. The repository's own `dist/cli.js`
   * by default; a caller may name another file to exercise the gate itself.
   */
  readonly cli?: string;
  /**
   * The environment the runtime is *started* with. This process's own by
   * default. The runtime's name is resolved the way the harness resolves any
   * command — from this process's `PATH`, with `PATHEXT` on Windows — so an
   * injected `env` does not redirect that lookup.
   */
  readonly env?: NodeJS.ProcessEnv;
}

export interface PrerequisiteReport {
  /** Whether everything needed to attempt a live check is present. */
  readonly ok: boolean;
  /** What was found, one line each, for the terminal. */
  readonly evidence: readonly string[];
  /** What is missing, one actionable sentence each. */
  readonly problems: readonly string[];
}

/**
 * Starts the selected launcher once, to see whether this host can start it at
 * all. It is the only prerequisite this check can establish for itself: whether
 * the selected profile, key, endpoint, and protocol really work is what the
 * bounded invocation inside each exercise establishes, and no reading of a
 * credential store is offered instead of it.
 */
function runtimeVersion(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): { readonly text: string | null; readonly problem: string | null } {
  const [executable = '', ...prefix] = command;
  const plan = planLaunch(executable, [...prefix, '--version'], process.cwd());
  if (!plan.ok) {
    return { text: null, problem: plan.problem };
  }
  const { file, args, verbatim } = plan.launcher;

  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(file, [...args], {
      env,
      encoding: 'utf8',
      timeout: RUNTIME_PROBE_TIMEOUT_MS,
      windowsVerbatimArguments: verbatim,
      windowsHide: true,
    });
  } catch (cause) {
    return { text: null, problem: `the coding runtime could not be started: ${messageOf(cause)}` };
  }

  if (result.error !== undefined) {
    return {
      text: null,
      problem: `the coding runtime could not be started: ${messageOf(result.error)}`,
    };
  }
  if (result.status !== 0) {
    const said = excerpt(`${result.stdout ?? ''} ${result.stderr ?? ''}`);
    return {
      text: null,
      problem:
        `"${[...command, '--version'].join(' ')}" exited with code ${String(result.status)}` +
        (said === '' ? '' : `: ${said}`),
    };
  }

  const [first = ''] = (result.stdout ?? '').split('\n');
  const version = first.trim();
  return { text: version === '' ? 'reported no version' : version, problem: null };
}

/**
 * Everything a live check needs before it may start one: a launcher this host
 * can start, and the built CLI the check drives. Every problem is reported, not
 * just the first, so a machine that is missing two things says so once.
 *
 * There is deliberately no account prerequisite. A runtime can authenticate in
 * ways that looking at a file cannot see — a variable the child process gets, a
 * helper, a gateway, or an account the CLI keeps elsewhere — and requiring one
 * particular credential source would refuse a selection that works. Whether the
 * selected runtime really can do the work is established by the bounded
 * invocation each exercise makes, which either works or reports its own failure.
 */
export function checkPrerequisites(options: PrerequisiteOptions = {}): PrerequisiteReport {
  const env = options.env ?? process.env;
  const command = options.command ?? [CODEX_EXECUTABLE];
  const evidence: string[] = [];
  const problems: string[] = [];

  const cli = options.cli ?? builtCli();
  if (existsSync(cli)) {
    evidence.push(`built CLI  ${cli}`);
  } else {
    problems.push(
      `the built CLI is missing (${cli}): run \`npm run build\` first, or use \`npm run test:live\`, which builds before it runs.`,
    );
  }

  const version = runtimeVersion(command, env);
  if (version.problem === null) {
    evidence.push(
      `runtime    ${command.join(' ')}: ${version.text ?? 'reported no version'} ` +
        '(whether its selection works is established by the exercises)',
    );
  } else {
    problems.push(
      `${version.problem} Install or select a runtime this host can start; README "Coding ` +
        'runtime" records the interface this was written against and how a native profile is ' +
        'selected.',
    );
  }

  return { ok: problems.length === 0, evidence, problems };
}

// ---------------------------------------------------------------------------
// The disposable project
// ---------------------------------------------------------------------------

/** The baseline greeting: the project is green before any run starts. */
export const GREET_SOURCE = [
  'export function greet(name) {',
  '  return `Hello, ${name}!`;',
  '}',
  '',
].join('\n');

/** The same module with the comma missing: what the repair fixture injects. */
export const BROKEN_GREET_SOURCE = [
  'export function greet(name) {',
  '  return `Hello ${name}!`;',
  '}',
  '',
].join('\n');

/** The project's own test of what it already has: green before any run starts. */
const GREET_TEST_SOURCE = [
  "import assert from 'node:assert/strict';",
  "import { greet } from '../src/greet.mjs';",
  '',
  "assert.equal(greet('Ada'), 'Hello, Ada!');",
  "assert.equal(greet('Grace'), 'Hello, Grace!');",
  "console.log('greet: ok');",
  '',
].join('\n');

/**
 * The acceptance test of the feature the task asks for, committed with the
 * baseline. While `src/greet-all.mjs` is absent it reports the feature as a skip
 * and passes, which is what makes the committed baseline green; once a coding
 * turn writes the module, this test imports it and asserts the acceptance
 * criteria, in the project's own runner, on its own assertions.
 */
const GREET_ALL_TEST_SOURCE = [
  "import assert from 'node:assert/strict';",
  "import { existsSync } from 'node:fs';",
  '',
  "const location = new URL('../src/greet-all.mjs', import.meta.url);",
  '',
  'if (!existsSync(location)) {',
  "  console.log('greet-all: skipped, the feature is not in this working copy yet');",
  '} else {',
  '  const { greetAll } = await import(location.href);',
  "  assert.equal(greetAll(['Ada']), 'Hello, Ada!');",
  "  assert.equal(greetAll(['Ada', 'Grace']), 'Hello, Ada and Grace!');",
  "  assert.equal(greetAll([]), 'Hello, nobody!');",
  "  console.log('greet-all: ok');",
  '}',
  '',
].join('\n');

/** The project's setup step: run before the baseline and before every round after a turn. */
const PREPARE_SOURCE = [
  "import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';",
  '',
  "const required = ['src/greet.mjs', 'test/greet.test.mjs', 'tools/run-checks.mjs'];",
  'const missing = required.filter((file) => !existsSync(file));',
  '',
  'if (missing.length > 0) {',
  '  console.log(`prepare: missing ${missing.join(", ")}`);',
  '  process.exitCode = 1;',
  '} else {',
  "  mkdirSync('build', { recursive: true });",
  "  const sources = readdirSync('src').sort();",
  "  const tests = readdirSync('test').sort();",
  '  writeFileSync(',
  "    'build/prepared.json',",
  '    `${JSON.stringify({ sources, tests }, null, 2)}\\n`,',
  "    'utf8',",
  '  );',
  '  console.log(`prepare: ok, ${sources.length} source files, ${tests.length} test files`);',
  '}',
  '',
].join('\n');

/**
 * The project's check runner: every `test/*.test.mjs` as its own child process,
 * one at a time, nonzero if any of them failed. The repair fixture's arm call
 * goes at the top, so an injected failure is an ordinary failing assertion in an
 * ordinary check — never a launch error, a timeout, or a stop.
 */
function runChecksSource(repairFixture: boolean): string {
  return [
    "import { spawn } from 'node:child_process';",
    "import { readdirSync } from 'node:fs';",
    "import path from 'node:path';",
    ...(repairFixture
      ? [
          "import { injectFailureOnce } from './live-repair-fixture.mjs';",
          '',
          '// The repair exercise only: one injected failure at this project’s own',
          '// test-only boundary, armed from outside the working copy. Inert otherwise.',
          'await injectFailureOnce();',
        ]
      : []),
    '',
    "const files = readdirSync('test')",
    "  .filter((name) => name.endsWith('.test.mjs'))",
    '  .sort();',
    '',
    'if (files.length === 0) {',
    "  console.log('run-checks: no test files were found, so nothing was checked');",
    '  process.exitCode = 2;',
    '} else {',
    '  const failed = [];',
    '  for (const file of files) {',
    "    const child = spawn(process.execPath, [path.join('test', file)], { stdio: 'inherit' });",
    '    console.log(`running ${file} (pid ${child.pid})`);',
    "    const code = await new Promise((resolve) => child.on('close', resolve));",
    '    if (code === 0) {',
    '      console.log(`ok ${file}`);',
    '    } else {',
    '      console.log(`FAILED ${file} (exit code ${code})`);',
    '      failed.push(file);',
    '    }',
    '  }',
    '  const passed = files.length - failed.length;',
    '  console.log(`run-checks: ${passed} of ${files.length} test files passed`);',
    '  process.exitCode = failed.length === 0 ? 0 : 1;',
    '}',
    '',
  ].join('\n');
}

/**
 * The injected failure, as fixture code. It lives in the disposable project, is
 * part of the project's committed check, and does three things: it stays inert
 * unless the environment names an arm file, it waits briefly for that file to
 * appear rather than racing the run that writes it, and it injects exactly once,
 * by breaking a committed module so the project's own test fails on its real
 * assertion. What the repair turn then sees is ordinary check output; what the
 * verifier asserts is that the module was repaired, not the test.
 */
const REPAIR_FIXTURE_SOURCE = [
  '/**',
  ` * ${INJECTED_FAILURE_LABEL}.`,
  ' *',
  ' * This file exists only in the disposable project the opt-in live check',
  ' * prepares, and only in its repair exercise. It is fixture code, not harness',
  ' * code: nothing in src/ knows it exists, and a normal run of the harness never',
  ' * sees it. It is armed from outside the working copy, after the implementation',
  ' * turn has ended (tests/live/codex-live-check.ts writes the file named by the',
  ' * environment), and it injects one failure, once.',
  ' */',
  "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  '',
  `const LABEL = '${INJECTED_FAILURE_LABEL}';`,
  `const ARM_VARIABLE = '${REPAIR_ARM_VARIABLE}';`,
  "const MARKER = path.join('build', 'live-repair-injected');",
  '/** Long enough to cover the gap between the turn ending and this check starting. */',
  'const WAIT_MS = 5000;',
  '',
  'const BROKEN = [',
  "  'export function greet(name) {',",
  "  '  return `Hello ${name}!`;',",
  "  '}',",
  "  '',",
  "].join('\\n');",
  '',
  'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
  '',
  '/**',
  ' * Breaks one committed module so the project’s own test fails, and says so',
  ' * loudly. Returns whether it injected anything this time.',
  ' */',
  'export async function injectFailureOnce() {',
  '  const arm = process.env[ARM_VARIABLE];',
  "  if (arm === undefined || arm.trim() === '') {",
  '    return false;',
  '  }',
  '  if (existsSync(MARKER)) {',
  '    return false;',
  '  }',
  '',
  '  const deadline = Date.now() + WAIT_MS;',
  '  while (!existsSync(arm)) {',
  '    if (Date.now() >= deadline) {',
  '      return false;',
  '    }',
  '    await sleep(25);',
  '  }',
  '',
  '  mkdirSync(path.dirname(MARKER), { recursive: true });',
  "  writeFileSync(MARKER, 'injected once\\n', 'utf8');",
  "  writeFileSync('src/greet.mjs', BROKEN, 'utf8');",
  '  console.log(',
  '    `${LABEL}: src/greet.mjs was broken on purpose so a real repair turn can be ` +',
  "      'exercised. This is not a defect the coding turn caused, and no harness check ' +",
  "      'discovered it. Restore the module\\'s committed behaviour and the project\\'s own checks pass again.',",
  '  );',
  '  return true;',
  '}',
  '',
].join('\n');

/** The instructions a working copy carries, which the adapter names in its prompt. */
const AGENTS_SOURCE = [
  '# tiny-live-target',
  '',
  "A small deterministic project used by the nexus harness's opt-in live check.",
  'It has no dependencies and no build step.',
  '',
  '- The project is checked by `node tools/run-checks.mjs`, which runs every file in `test/`.',
  '- Setup is `node tools/prepare.mjs`.',
  '- Keep the tests as they are: fix the code, never the check.',
  '',
].join('\n');

export interface LiveTarget {
  /** The disposable directory: the repository, the inputs, the outputs, and the arm file. */
  readonly parent: string;
  /** The source repository the run is given: one commit, and a clean checkout of it. */
  readonly repo: string;
  /** The configuration file describing this project's own commands. */
  readonly configPath: string;
  /** The task file the run is asked to complete. */
  readonly taskPath: string;
  /** The configured output directory, resolved from the configuration file. Outside the repo. */
  readonly workDir: string;
  /** Where the repair exercise's arm file is written: outside the repository. */
  readonly armFile: string;
  /** The committed base commit the runs start from. */
  readonly baseCommit: string;
  /** Whether this fixture carries the repair exercise's injected failure. */
  readonly repairFixture: boolean;
}

export interface LiveTargetOptions {
  /** Prepare the repair exercise's fixture instead of the plain one. */
  readonly repairFixture?: boolean;
  /** How many repair turns the configuration allows. */
  readonly maxRepairs?: number;
  /** The run's total task-time limit, in minutes. */
  readonly taskTimeoutMinutes?: number;
  /** The per-command limit, in minutes. */
  readonly commandTimeoutMinutes?: number;
  /**
   * The launch the run selects. Left out, the fixture's configuration omits the
   * optional `agent` object, which is the documented ordinary Codex launch.
   */
  readonly agent?: AgentSelection;
}

/** A private Git environment: this machine's own Git settings decide nothing here. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'nexus-live-check-nonexistent-gitconfig'),
    GIT_AUTHOR_NAME: 'Live Check',
    GIT_AUTHOR_EMAIL: 'live-check@example.test',
    GIT_COMMITTER_NAME: 'Live Check',
    GIT_COMMITTER_EMAIL: 'live-check@example.test',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/** Runs one Git command in a repository and returns its standard output. */
export function git(repo: string, ...args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: repo,
    env: gitEnvironment(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in "${repo}": ${result.stderr || result.stdout || 'no output'}`,
    );
  }
  return result.stdout;
}

/** The file's text, as a caller that must have it reads it. */
export async function readText(file: string): Promise<string> {
  return await readFile(file, 'utf8');
}

/**
 * Prepares one disposable project: a real repository with a committed green
 * baseline, the configuration and task files that describe it, and — for the
 * repair exercise — the injected-failure fixture. Nothing outside the returned
 * directory is touched, and nothing here talks to a runtime.
 */
export async function createLiveTarget(options: LiveTargetOptions = {}): Promise<LiveTarget> {
  const repairFixture = options.repairFixture === true;
  const parent = await mkdtemp(path.join(os.tmpdir(), 'nexus-live-check-'));
  const repo = path.join(parent, 'tiny-live-target');
  await mkdir(repo, { recursive: true });

  const files: Record<string, string> = {
    '.gitattributes': '* -text\n',
    '.gitignore': 'build/\n',
    'AGENTS.md': AGENTS_SOURCE,
    'src/greet.mjs': GREET_SOURCE,
    'test/greet.test.mjs': GREET_TEST_SOURCE,
    'test/greet-all.test.mjs': GREET_ALL_TEST_SOURCE,
    'tools/prepare.mjs': PREPARE_SOURCE,
    'tools/run-checks.mjs': runChecksSource(repairFixture),
  };
  if (repairFixture) {
    files['tools/live-repair-fixture.mjs'] = REPAIR_FIXTURE_SOURCE;
  }
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(repo, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }

  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--message', 'tiny-live-target: baseline');
  const baseCommit = git(repo, 'rev-parse', 'HEAD').trim();

  const inputs = path.join(parent, 'inputs');
  await mkdir(inputs, { recursive: true });
  // The output directory resolves from the configuration file's own directory
  // and is deliberately outside the source repository (docs/WORKFLOW.md §1, §3).
  const configPath = path.join(inputs, 'harness.config.json');
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        workDir: './.harness-runs',
        maxRepairs: options.maxRepairs ?? 2,
        taskTimeoutMinutes: options.taskTimeoutMinutes ?? 15,
        commandTimeoutMinutes: options.commandTimeoutMinutes ?? 5,
        setup: [[process.execPath, 'tools/prepare.mjs']],
        checks: [[process.execPath, 'tools/run-checks.mjs']],
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const taskPath = path.join(inputs, 'task.json');
  await writeFile(
    taskPath,
    `${JSON.stringify(
      {
        id: 'greet-all',
        title: 'Add a greetAll helper to tiny-live-target',
        description:
          'tiny-live-target needs a greetAll helper that greets several names in one sentence, ' +
          'following the conventions of src/greet.mjs.',
        acceptanceCriteria: [
          'src/greet-all.mjs exports greetAll(names).',
          "greetAll(['Ada']) is 'Hello, Ada!'.",
          "greetAll(['Ada', 'Grace']) is 'Hello, Ada and Grace!'.",
          "greetAll([]) is 'Hello, nobody!'.",
          "The project's own checks (node tools/run-checks.mjs) exit 0.",
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    parent,
    repo,
    configPath,
    taskPath,
    workDir: path.join(inputs, '.harness-runs'),
    armFile: path.join(parent, 'repair-arm.json'),
    baseCommit,
    repairFixture,
  };
}

// ---------------------------------------------------------------------------
// Driving the built CLI
// ---------------------------------------------------------------------------

export interface ExerciseOptions {
  /** The environment the CLI is started in; this process's own by default. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface ExerciseRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The run directory the CLI itself named, or `null` when it named none. */
  readonly runDir: string | null;
}

/** One line of the outcome block the CLI prints for a run that reached a status. */
function outcomeLine(stdout: string, label: string): string | null {
  const match = new RegExp(`^\\s+${label}\\s+(\\S.*)$`, 'm').exec(stdout);
  return match?.[1]?.trim() ?? null;
}

/**
 * Arms the repair fixture's injected failure once the implementation turn has
 * ended, and never before: the run's own timeline is the signal, so the failure
 * cannot exist while the coding runtime is working, and the baseline — which
 * runs before that turn — is never armed. It gives up as soon as the run it
 * watches is over, so nothing of this check outlives the run.
 */
async function armWhenImplementationTurnEnds(target: LiveTarget, stop: AbortSignal): Promise<void> {
  while (!stop.aborted) {
    const runDir = await anyRunDirectory(target);
    if (runDir !== null) {
      const timeline = path.join(runDir, 'logs', 'run.log');
      if (existsSync(timeline)) {
        const text = await readFile(timeline, 'utf8');
        if (text.includes(IMPLEMENTATION_DONE)) {
          await writeFile(
            target.armFile,
            `${JSON.stringify({ armedAt: new Date().toISOString(), after: IMPLEMENTATION_DONE })}\n`,
            'utf8',
          );
          return;
        }
      }
    }
    await sleep(POLL_MS);
  }
}

/** The first run directory under the target's output directory, if one exists yet. */
async function anyRunDirectory(target: LiveTarget): Promise<string | null> {
  try {
    const entries = await readdir(target.workDir, { withFileTypes: true });
    const directory = entries.find((entry) => entry.isDirectory());
    return directory === undefined ? null : path.join(target.workDir, directory.name);
  } catch {
    return null;
  }
}

/**
 * Runs one live exercise: the built CLI, on a disposable repository, with the
 * real runtime and the project's own commands. The run's own configured deadline
 * is what bounds it; nothing here kills a run the harness owns.
 */
export async function runLiveExercise(
  target: LiveTarget,
  options: ExerciseOptions = {},
): Promise<ExerciseRun> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (target.repairFixture) {
    // The working copy's own check reads this; the harness passes the environment
    // it was started with on to every configured command, so the fixture sees it.
    env[REPAIR_ARM_VARIABLE] = target.armFile;
  }

  const argv = [
    'run',
    '--repo',
    target.repo,
    '--config',
    target.configPath,
    '--task',
    target.taskPath,
  ];
  const child = spawn(process.execPath, [builtCli(), ...argv], {
    cwd: target.parent,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const armingStop = new AbortController();
  const arming = target.repairFixture
    ? armWhenImplementationTurnEnds(target, armingStop.signal)
    : Promise.resolve();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => {
        resolve({ code, signal });
      });
    },
  );

  const { code, signal } = await closed;
  // The run is over, so the watcher is over with it: it is not left polling a
  // directory nothing will write to again.
  armingStop.abort();
  await arming;

  return { code, signal, stdout, stderr, runDir: outcomeLine(stdout, 'run dir') };
}

// ---------------------------------------------------------------------------
// What the runs left behind
// ---------------------------------------------------------------------------

/** The report of one run, as a reader of `result.json` sees it. */
async function readReport(runDir: string): Promise<RunReport> {
  const file = path.join(runDir, 'result.json');
  if (!existsSync(file)) {
    throw new Error(`the run left no report at ${file}`);
  }
  return JSON.parse(await readFile(file, 'utf8')) as RunReport;
}

/** Every stream a round's commands wrote, joined, for a text assertion. */
async function roundOutput(round: CheckRoundResult): Promise<string> {
  const parts: string[] = [];
  for (const result of [...round.setup, ...round.checks]) {
    for (const file of [result.stdoutPath, result.stderrPath]) {
      if (existsSync(file)) {
        parts.push(await readFile(file, 'utf8'));
      }
    }
  }
  return parts.join('\n');
}

function expectEqual<T>(problems: string[], what: string, actual: T, expected: T): void {
  if (actual !== expected) {
    problems.push(`${what}: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`);
  }
}

function expectTrue(problems: string[], what: string, value: boolean): void {
  if (!value) {
    problems.push(`${what}: expected it to hold, and it does not`);
  }
}

function attemptAt(problems: string[], report: RunReport, index: number): AttemptEvidence | null {
  const attempt = report.attempts[index];
  if (attempt === undefined) {
    problems.push(
      `the report records ${String(report.attempts.length)} coding turns, not ${String(index + 1)}`,
    );
    return null;
  }
  return attempt;
}

function failedCommands(round: CheckRoundResult): readonly CommandResult[] {
  return round.checks.filter((result) => !(result.outcome === 'exited' && result.exitCode === 0));
}

/** What the CLI printed, for a failure that has to explain itself. */
function cliEvidence(run: ExerciseRun): string {
  const lines = ["the CLI's own output:"];
  for (const [stream, text] of [
    ['out', run.stdout],
    ['err', run.stderr],
  ] as const) {
    for (const line of text
      .split('\n')
      .filter((one) => one.trim() !== '')
      .slice(-40)) {
      lines.push(`  ${stream}| ${line}`);
    }
  }
  return lines.join('\n');
}

/** The run directory the CLI named, or a refusal naming what it printed instead. */
function requireRunDir(run: ExerciseRun): string {
  if (run.runDir === null) {
    throw new Error(`the CLI named no run directory.\n${cliEvidence(run)}`);
  }
  return run.runDir;
}

/**
 * The implementation exercise: a green baseline, one real coding turn, the
 * project's own checks observed after it, and a retained working copy with the
 * change in it. Every assertion is read from the run's artifacts.
 */
export async function verifyImplementationExercise(
  target: LiveTarget,
  run: ExerciseRun,
): Promise<string[]> {
  const problems: string[] = [];
  if (run.code !== 0) {
    problems.push(`the CLI exited with code ${String(run.code)} instead of 0`);
  }

  const runDir = requireRunDir(run);
  const report = await readReport(runDir);

  expectEqual(problems, 'the final status', report.status, 'passed');
  expectEqual(problems, 'the repairs used', report.repairsUsed, 0);
  expectEqual(problems, 'the timeout record', report.timeout, null);
  expectEqual(problems, 'the cancellation record', report.cancellation, null);
  expectEqual(problems, 'the recorded source repository', report.source.path, target.repo);
  expectEqual(problems, 'the recorded base commit', report.source.baseCommit, target.baseCommit);
  expectEqual(problems, 'the selected agent runtime', report.agent.runtime, 'codex');
  expectTrue(
    problems,
    'the report records a nonempty launch prefix',
    report.agent.command.length > 0 && (report.agent.command[0] ?? '').trim() !== '',
  );
  expectTrue(problems, 'a working copy was prepared', report.workspace.prepared);
  expectTrue(problems, 'the run timeline exists', existsSync(report.runLog));

  const baseline = report.baseline;
  if (baseline === null) {
    problems.push('the report records no baseline round, so nothing shows the baseline was green');
  } else {
    expectEqual(problems, 'the baseline round outcome', baseline.outcome, 'passed');
  }

  expectEqual(problems, 'the number of coding turns', report.attempts.length, 1);
  const attempt = attemptAt(problems, report, 0);
  if (attempt !== null) {
    expectEqual(problems, 'the kind of the coding turn', attempt.kind, 'implementation');
    expectTrue(
      problems,
      'the implementation turn kept its own agent log',
      existsSync(attempt.agentLog),
    );
    if (existsSync(attempt.agentLog)) {
      const log = await readText(attempt.agentLog);
      // What the report says was launched, and then the adapter's own interface:
      // the log is the record of what really started, not of what was intended.
      expectTrue(
        problems,
        'the agent log names the launch prefix the report records',
        log.includes(`${report.agent.command.join(' ')} `),
      );
      expectTrue(
        problems,
        'the agent log names the interface the adapter used (--ask-for-approval never exec --sandbox workspace-write --json -)',
        log.includes('--ask-for-approval never exec --sandbox workspace-write --json -'),
      );
    }

    const round = attempt.checks;
    if (round === null) {
      problems.push('no check round was observed after the implementation turn');
    } else {
      expectEqual(problems, 'the round after the implementation turn', round.outcome, 'passed');
      expectEqual(
        problems,
        'the number of configured checks observed after the turn',
        round.checks.length,
        1,
      );
      for (const check of round.checks) {
        expectEqual(
          problems,
          `the exit code of ${JSON.stringify(check.command)}`,
          check.exitCode,
          0,
        );
      }
      const output = await roundOutput(round);
      expectTrue(
        problems,
        "the project's own acceptance test ran the written code ('greet-all: ok' in its output)",
        output.includes('greet-all: ok'),
      );
    }
  }

  const workspace = path.join(runDir, 'workspace');
  expectTrue(
    problems,
    'the change is in the retained working copy (workspace/src/greet-all.mjs exists)',
    existsSync(path.join(workspace, 'src', 'greet-all.mjs')),
  );

  // The source repository this run was given is exactly as it was.
  expectEqual(
    problems,
    'the source commit, afterwards',
    git(target.repo, 'rev-parse', 'HEAD').trim(),
    target.baseCommit,
  );
  expectEqual(
    problems,
    'the source status, afterwards',
    git(target.repo, 'status', '--porcelain').trim(),
    '',
  );

  return problems;
}

/**
 * The repair exercise: the same shape, with one injected failure at the
 * disposable project's own test-only boundary, and the repair it took to get
 * back to green. The injected failure is stated as such everywhere it appears,
 * and the assertions below read the earlier attempt's evidence back rather than
 * trusting the later outcome.
 */
export async function verifyRepairExercise(
  target: LiveTarget,
  run: ExerciseRun,
): Promise<string[]> {
  const problems: string[] = [];
  if (run.code !== 0) {
    problems.push(`the CLI exited with code ${String(run.code)} instead of 0`);
  }

  const runDir = requireRunDir(run);
  const report = await readReport(runDir);

  expectEqual(problems, 'the final status', report.status, 'passed');
  expectEqual(problems, 'the repairs used', report.repairsUsed, 1);
  expectEqual(problems, 'the number of coding turns', report.attempts.length, 2);
  expectEqual(problems, 'the timeout record', report.timeout, null);
  expectEqual(problems, 'the cancellation record', report.cancellation, null);
  expectEqual(problems, 'the recorded source repository', report.source.path, target.repo);
  expectEqual(problems, 'the selected agent runtime', report.agent.runtime, 'codex');

  // The first post-agent round really was red, and it was red because of the
  // injected failure — not because a command could not be executed.
  const first = attemptAt(problems, report, 0);
  if (first !== null) {
    expectEqual(problems, 'the kind of the first coding turn', first.kind, 'implementation');
    const round = first.checks;
    if (round === null) {
      problems.push('no check round was observed after the implementation turn');
    } else {
      expectEqual(problems, 'the round after the implementation turn', round.outcome, 'failed');
      const failed = failedCommands(round);
      expectTrue(problems, 'the round observed exactly one failing check', failed.length === 1);
      const output = await roundOutput(round);
      expectTrue(
        problems,
        'the failing check said it was the injected failure',
        output.includes(INJECTED_FAILURE_LABEL),
      );
      expectTrue(
        problems,
        "the project's own test failed on its real assertion (FAILED greet.test.mjs)",
        output.includes('FAILED greet.test.mjs'),
      );
      expectTrue(
        problems,
        'the failing check is an ordinary check failure, not a command that could not run',
        failed.every((result) => result.outcome === 'exited' && result.exitCode !== 0),
      );
      // The evidence of the red round is still readable after the repair.
      for (const result of failed) {
        expectTrue(
          problems,
          `the failed check's output was kept (${result.stdoutPath})`,
          existsSync(result.stdoutPath),
        );
        if (existsSync(result.stdoutPath)) {
          expectTrue(
            problems,
            "the failed check's log still holds the injected failure",
            (await readText(result.stdoutPath)).includes(INJECTED_FAILURE_LABEL),
          );
        }
      }
    }
    expectTrue(
      problems,
      'the first turn kept its own agent log, still readable after the repair',
      existsSync(first.agentLog),
    );
  }

  const second = attemptAt(problems, report, 1);
  if (second !== null) {
    expectEqual(problems, 'the kind of the second coding turn', second.kind, 'repair');
    expectEqual(problems, 'the repaired turn number', second.turn, 2);
    const round = second.checks;
    if (round === null) {
      problems.push('no check round was observed after the repair turn');
    } else {
      expectEqual(problems, 'the round after the repair turn', round.outcome, 'passed');
      const output = await roundOutput(round);
      expectTrue(
        problems,
        'the repaired round ran the project’s own acceptance test to a pass',
        output.includes('greet-all: ok'),
      );
      expectTrue(
        problems,
        'the repaired round no longer holds the injected failure',
        !output.includes(INJECTED_FAILURE_LABEL),
      );
    }
    expectTrue(
      problems,
      'the repair turn kept its own agent log, distinct from the first',
      existsSync(second.agentLog) && second.agentLog !== (first?.agentLog ?? ''),
    );
  }

  // The repair was a repair of the code, not of the check: the project's own
  // test is exactly as it was committed, and the injected defect is gone.
  const workspace = path.join(runDir, 'workspace');
  const testText = await readText(path.join(workspace, 'test', 'greet.test.mjs'));
  expectEqual(
    problems,
    "the project's own test file is unchanged from its committed content",
    testText,
    GREET_TEST_SOURCE,
  );
  const greetText = await readText(path.join(workspace, 'src', 'greet.mjs'));
  expectTrue(
    problems,
    'the injected defect is gone from src/greet.mjs (the broken module is not in the working copy)',
    !greetText.includes(BROKEN_GREET_SOURCE),
  );
  expectTrue(
    problems,
    'the repaired working copy still holds the implementation the first turn wrote',
    existsSync(path.join(workspace, 'src', 'greet-all.mjs')),
  );

  expectEqual(
    problems,
    'the source commit, afterwards',
    git(target.repo, 'rev-parse', 'HEAD').trim(),
    target.baseCommit,
  );
  expectEqual(
    problems,
    'the source status, afterwards',
    git(target.repo, 'status', '--porcelain').trim(),
    '',
  );

  return problems;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** Where the check writes; a caller may pass its own recorder. */
export interface LiveIo {
  out(text: string): void;
  err(text: string): void;
}

function consoleIo(): LiveIo {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
}

function describeRun(run: ExerciseRun, report: RunReport | null): readonly string[] {
  const lines = [`  exit code    ${String(run.code)}`];
  if (run.runDir !== null) {
    lines.push(`  run dir      ${run.runDir}`);
    lines.push(`  report       ${path.join(run.runDir, 'result.json')}`);
  }
  if (report !== null) {
    lines.push(
      `  turns        ${String(report.attempts.length)} coding turn(s), ${String(report.repairsUsed)} repair turn(s)`,
    );
    lines.push(`  status       ${report.status}`);
  }
  return lines;
}

/** How this check is told which configuration to select a runtime with. */
export type VerifierArguments =
  | { readonly ok: true; readonly configPath: string | null }
  | { readonly ok: false; readonly message: string };

const VERIFIER_USAGE = [
  'usage: npm run test:live [-- --config harness.config.json]',
  '',
  'Without --config the exercises use the documented default: the ordinary Codex launch',
  "(`codex`), 2 repair turns, and the fixture's own task and command limits.",
  "With --config they use that file's selected agent, repair allowance, and numeric limits;",
  "the repository, output directory, task, setup, and checks stay the fixture's own, and the",
  "configured project's commands are never run.",
].join('\n');

/**
 * Reads this check's own arguments. It is not the CLI's parser: the live check has
 * one optional option, and everything it reads from a configuration file goes
 * through the harness's own loader afterwards.
 */
export function parseVerifierArguments(argv: readonly string[]): VerifierArguments {
  let configPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument !== '--config') {
      return { ok: false, message: `unknown option "${argument}"` };
    }
    if (configPath !== null) {
      return { ok: false, message: 'option "--config" was given more than once' };
    }
    const value = argv[index + 1];
    if (value === undefined || value.trim() === '' || value.startsWith('-')) {
      return { ok: false, message: 'option "--config" requires a path value' };
    }
    configPath = value;
    index += 1;
  }

  return { ok: true, configPath };
}

/** The launch, limits, and repair allowance one verification run uses. */
interface VerificationSelection {
  readonly agent: AgentSelection;
  readonly maxRepairs: number;
  readonly taskTimeoutMinutes: number;
  readonly commandTimeoutMinutes: number;
}

/** The documented defaults of a live check that was given no configuration. */
const DEFAULT_SELECTION: VerificationSelection = {
  agent: { runtime: 'codex', command: [CODEX_EXECUTABLE] },
  maxRepairs: 2,
  taskTimeoutMinutes: 15,
  commandTimeoutMinutes: 5,
};

/**
 * What the check runs with: the selected configuration's agent, repair
 * allowance, and limits, or the documented defaults. The loaded configuration's
 * project fields are deliberately not returned: the exercises supply their own
 * repository, output directory, task, setup, and checks, and a verifier that ran
 * the configured project's commands would be a different, quieter thing than the
 * one this file documents (docs/WORKFLOW.md §3, "Opt-in live verification").
 */
async function selectionFrom(
  configPath: string | null,
): Promise<
  | { readonly ok: true; readonly selection: VerificationSelection }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  if (configPath === null) {
    return { ok: true, selection: DEFAULT_SELECTION };
  }

  let config;
  try {
    config = await loadHarnessConfig(path.resolve(configPath));
  } catch (cause) {
    const said = cause instanceof ConfigError ? cause.message : messageOf(cause);
    return {
      ok: false,
      problems: [
        `the configuration "${configPath}" could not be used: ${said}`,
        'Correct the file, or run without --config to use the documented defaults.',
      ],
    };
  }

  if (config.maxRepairs < 1) {
    return {
      ok: false,
      problems: [
        `the configuration allows ${String(config.maxRepairs)} repair turns, and this verifier has ` +
          'to exercise a real repair.',
        'Raise maxRepairs to at least 1 — it is not raised for you, because a verification that ' +
          'silently widened its own allowance would not be checking what the file says — or run ' +
          'without --config.',
      ],
    };
  }

  return {
    ok: true,
    selection: {
      agent: config.agent,
      maxRepairs: config.maxRepairs,
      taskTimeoutMinutes: config.taskTimeoutMinutes,
      commandTimeoutMinutes: config.commandTimeoutMinutes,
    },
  };
}

/** Runs the check and returns its exit code. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: LiveIo = consoleIo(),
): Promise<number> {
  io.out('== nexus live check ==');
  io.out('This makes real coding-runtime calls to the installed Codex CLI, in disposable');
  io.out('repositories under the system temporary directory. It is not part of `npm test`,');
  io.out('`npm run validate`, or CI, and it is not evidence that a change is safe to ship.');
  io.out('');

  const arguments_ = parseVerifierArguments(argv);
  if (!arguments_.ok) {
    io.err(`error: ${arguments_.message}`);
    io.err('');
    io.err(VERIFIER_USAGE);
    io.err('');
    io.err('Nothing was verified: no coding runtime was invoked and no run was attempted.');
    io.err('This is not a pass.');
    return EXIT_PREREQUISITES;
  }

  const selected = await selectionFrom(arguments_.configPath);
  if (!selected.ok) {
    io.err('');
    for (const problem of selected.problems) {
      io.err(`prerequisite: ${problem}`);
    }
    io.err('');
    io.err('Nothing was verified: no coding runtime was invoked and no run was attempted.');
    io.err('This is not a pass.');
    return EXIT_PREREQUISITES;
  }
  const { selection } = selected;
  if (arguments_.configPath !== null) {
    io.out(
      `configuration ${arguments_.configPath}: agent ${selection.agent.runtime.toLowerCase()} ` +
        `${selection.agent.command.join(' ')}, ${String(selection.maxRepairs)} repair turn(s)`,
    );
    io.out('');
  }

  const prerequisites = checkPrerequisites({ command: selection.agent.command });
  for (const line of prerequisites.evidence) {
    io.out(`  ${line}`);
  }
  if (!prerequisites.ok) {
    io.err('');
    for (const problem of prerequisites.problems) {
      io.err(`prerequisite: ${problem}`);
    }
    io.err('');
    io.err('Nothing was verified: no coding runtime was invoked and no run was attempted.');
    io.err('This is not a pass.');
    return EXIT_PREREQUISITES;
  }

  const problems: string[] = [];
  const kept: string[] = [];

  const exercises: ReadonlyArray<{
    readonly name: string;
    readonly repairFixture: boolean;
    readonly verify: (target: LiveTarget, run: ExerciseRun) => Promise<string[]>;
  }> = [
    { name: 'implementation', repairFixture: false, verify: verifyImplementationExercise },
    {
      name: 'repair (one injected failure at the fixture boundary)',
      repairFixture: true,
      verify: verifyRepairExercise,
    },
  ];

  for (const exercise of exercises) {
    io.out('');
    io.out(`== live exercise: ${exercise.name} ==`);
    try {
      const target = await createLiveTarget({
        repairFixture: exercise.repairFixture,
        agent: selection.agent,
        maxRepairs: selection.maxRepairs,
        taskTimeoutMinutes: selection.taskTimeoutMinutes,
        commandTimeoutMinutes: selection.commandTimeoutMinutes,
      });
      kept.push(target.parent);
      io.out(`  repository   ${target.repo}`);
      io.out(`  output       ${target.workDir}`);
      if (exercise.repairFixture) {
        io.out(
          '  injected     one failure, armed after the implementation turn (fixture boundary)',
        );
      }

      const run = await runLiveExercise(target);
      let report: RunReport | null = null;
      if (run.runDir !== null && existsSync(path.join(run.runDir, 'result.json'))) {
        report = await readReport(run.runDir);
      }
      for (const line of describeRun(run, report)) {
        io.out(line);
      }

      const found = await exercise.verify(target, run);
      problems.push(...found.map((problem) => `${exercise.name}: ${problem}`));
      io.out(
        `  result       ${found.length === 0 ? 'ok' : `failed, ${String(found.length)} problem(s)`}`,
      );
    } catch (cause) {
      problems.push(`${exercise.name}: ${messageOf(cause)}`);
      io.err(`  result       failed to run: ${messageOf(cause)}`);
    }
  }

  io.out('');
  if (problems.length > 0) {
    io.err('== live check failed ==');
    for (const problem of problems) {
      io.err(`- ${problem}`);
    }
    io.err('');
    io.err('The disposable directories are kept for inspection:');
    for (const directory of kept) {
      io.err(`  ${directory}`);
    }
    return EXIT_FAILED;
  }

  io.out('== live check passed ==');
  io.out('Both exercises ran the real runtime, and every assertion above was read from the');
  io.out('artifacts those runs left behind: reports, timelines, per-turn agent logs, command');
  io.out('output logs, and the retained working copies.');
  io.out('These disposable directories are kept for inspection; remove them by hand when done:');
  for (const directory of kept) {
    io.out(`  ${directory}`);
  }
  return EXIT_OK;
}

/** True when this module is the process entry point, not an import. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const entryUrl = pathToFileURL(entry).href;
  if (entryUrl === import.meta.url) {
    return true;
  }
  // Windows path casing can differ between argv and import.meta.url.
  return process.platform === 'win32' && entryUrl.toLowerCase() === import.meta.url.toLowerCase();
}

if (isEntryPoint()) {
  try {
    process.exitCode = await main();
  } catch (cause) {
    process.stderr.write(`error: the live check could not run: ${messageOf(cause)}\n`);
    process.exitCode = EXIT_FAILED;
  }
}
