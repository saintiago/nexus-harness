/**
 * The controlled fixtures of the built-CLI end-to-end suite.
 *
 * Three things live here, and nothing that decides a test:
 *
 * 1. The target project, as committed source — a tiny deterministic project with
 *    a committed greeting, a committed test, an acceptance test of the feature
 *    the task asks for, a setup step, and a check runner. It is written here
 *    rather than shared with the local-loop milestone's suite because this suite
 *    drives the same shape through a different boundary, and neither suite
 *    should have to change when the other does.
 * 2. The coding runtime: an executable named `codex` in a directory this module
 *    puts first on the `PATH` of the CLI it starts. The production adapter
 *    resolves `codex` from `PATH` and starts it with the adapter's own arguments
 *    — `--ask-for-approval never exec --sandbox danger-full-access --json -` (or
 *    with the target's own configured prefix in front of them) — so the only
 *    thing that is not the real runtime is the program that name resolves to: a
 *    real process that reads the real prompt from standard input, works in the
 *    real working copy, and writes the documented event stream. Nothing in
 *    `src/` knows it exists: there is no flag to reach it, and a CLI invocation
 *    that would not have run a runtime runs nothing.
 * 3. The built CLI, as a process: `node dist/cli.js`, the file `npm start` runs,
 *    started with its own environment and working directory.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempDir, removeWithRetry, repoRoot, writeJsonFile } from '../support.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../../src/config/paths.js';
import { ownChildProcess, ownFixtureOperation } from './lifecycle.js';

/**
 * The shared fixture beacon module, as a URL a fixture program written into a
 * temporary directory can import: fixtures record a beacon token, and a suite
 * names their PID again only while that beacon answers.
 */
export const beaconModuleUrl = pathToFileURL(
  path.join(repoRoot, 'tests', 'fixtures', 'beacon.mjs'),
).href;

// ---------------------------------------------------------------------------
// The target project, as committed source
// ---------------------------------------------------------------------------

/** The baseline greeting: the project is green before any run starts. */
const GREET_SOURCE = ['export function greet(name) {', '  return `Hello, ${name}!`;', '}', ''].join(
  '\n',
);

/** The same module with the comma missing: a committed, red baseline. */
const BROKEN_GREET_SOURCE = [
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
 * and passes, which is what makes the committed baseline green. Once a coding
 * turn writes the module, this test imports it and asserts the acceptance
 * criteria, so a wrong implementation fails here for real, in the project's own
 * runner, on its own assertion.
 */
const GREET_ALL_TEST_SOURCE = [
  "import assert from 'node:assert/strict';",
  "import { existsSync } from 'node:fs';",
  '',
  "const location = new URL('../src/greet-all.mjs', import.meta.url);",
  '',
  'if (!existsSync(location)) {',
  "  console.log('greet-all: skipped, the feature is not implemented in this working copy');",
  '} else {',
  '  const { greetAll } = await import(location.href);',
  "  assert.equal(greetAll(['Ada']), 'Hello, Ada!');",
  "  assert.equal(greetAll(['Ada', 'Grace']), 'Hello, Ada and Grace!');",
  "  assert.equal(greetAll([]), 'Hello, nobody!');",
  "  console.log('greet-all: ok');",
  '}',
  '',
].join('\n');

/**
 * The project's setup step, run as a configured setup command before the baseline
 * and before every post-agent round. It is a real check of the project's own
 * shape — a missing source file fails it — and it rewrites an ignored build
 * artifact, so the harness's change summary has something real it must not
 * report as a change.
 */
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
 * The project's check runner, run as a configured check command. It is a real
 * runner: it starts every `test/*.test.mjs` as its own child process, one at a
 * time, and exits nonzero if any of them did. It prints the PID of each child
 * before awaiting it, so a run's own log holds the process a stop had to reach.
 */
const RUN_CHECKS_SOURCE = [
  "import { spawn } from 'node:child_process';",
  "import { readdirSync } from 'node:fs';",
  "import path from 'node:path';",
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

/** The feature test's own words, as a run's check log holds them. */
export const FEATURE_IMPLEMENTED = 'greet-all: ok';
export const FEATURE_MISSING = 'greet-all: skipped';

/** The implementation the task asks for: what a passing coding turn writes. */
export const GREET_ALL_SOURCE = [
  'export function greetAll(names) {',
  '  if (names.length === 0) {',
  "    return 'Hello, nobody!';",
  '  }',
  "  return `Hello, ${names.join(' and ')}!`;",
  '}',
  '',
].join('\n');

/** The same feature, written so the acceptance test fails on its own assertion. */
export const WRONG_GREET_ALL_SOURCE = [
  'export function greetAll(names) {',
  "  return `Hello, ${names.join(', ')}!`;",
  '}',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// The coding runtime, as an executable on the CLI's PATH
// ---------------------------------------------------------------------------

/** The stand-in runtime, kept as a real file so that it can be read and reviewed. */
const FAKE_RUNTIME = path.join(repoRoot, 'tests', 'fixtures', 'fake-codex.mjs');

/**
 * Where the stand-in runtime keeps its own records. A test reads them back to see
 * what the production adapter really did: how many turns ran, in which working
 * directory, with which arguments, and with what prompt.
 */
export interface FakeState {
  /** Directory holding both records. */
  readonly dir: string;
  /** One line per invocation, in order. */
  readonly turnsFile: string;
  /** One line per event the runtime observed or produced. */
  readonly eventsFile: string;
}

/**
 * Writes the executable shim named `name` into `bin`, running `script` with this
 * process's own `node`, and returns its path: a `.cmd` on Windows, which the
 * harness starts through the command interpreter exactly as it starts an
 * installed tool, and a small shell script elsewhere.
 */
async function writeShim(bin: string, name: string, script: string): Promise<string> {
  if (process.platform === 'win32') {
    const shim = path.join(bin, `${name}.cmd`);
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
    return shim;
  }
  const shim = path.join(bin, name);
  await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  await chmod(shim, 0o755);
  return shim;
}

/**
 * Puts an executable named `codex` in a directory of its own, backed by the
 * stand-in runtime above.
 */
export async function installFakeRuntime(
  parent: string,
): Promise<{ readonly bin: string; readonly shim: string; readonly state: FakeState }> {
  const bin = path.join(parent, 'fake-runtime-bin');
  const stateDir = path.join(parent, 'fake-runtime-state');
  await mkdir(bin, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const shim = await writeShim(bin, 'codex', FAKE_RUNTIME);

  return {
    bin,
    shim,
    state: {
      dir: stateDir,
      turnsFile: path.join(stateDir, 'turns.jsonl'),
      eventsFile: path.join(stateDir, 'runtime-events.jsonl'),
    },
  };
}

/**
 * The stand-in `git`, stored as a real file so that it can be read and reviewed:
 * the lowest boundary every Git invocation the harness makes has, exactly as the
 * stand-in `codex` is the lowest boundary of a coding turn. A test puts its
 * directory first on `PATH` to make the harness's own Git invocations reach it,
 * and reads the records it writes in {@link FakeGitState.dir}.
 */
const FAKE_GIT = path.join(repoRoot, 'tests', 'fixtures', 'fake-git.mjs');

/** Where the stand-in `git` keeps the record of what it was asked to do. */
export interface FakeGitState {
  /** The directory holding one record per invocation, named by its id. */
  readonly dir: string;
}

/**
 * Puts an executable named `git` in a directory of its own, backed by
 * tests/fixtures/fake-git.mjs. Nothing in `src/` knows it exists: the harness's
 * Git invocations resolve `git` from `PATH`, so a test decides what they run by
 * putting this directory there.
 */
export async function installFakeGit(parent: string): Promise<{
  readonly bin: string;
  readonly shim: string;
  readonly state: FakeGitState;
}> {
  const bin = path.join(parent, 'fake-git-bin');
  const stateDir = path.join(parent, 'fake-git-state');
  await mkdir(bin, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const shim = await writeShim(bin, 'git', FAKE_GIT);

  return { bin, shim, state: { dir: stateDir } };
}

/** Where the stand-in `gh` keeps its records and the pull requests it holds. */
export interface FakeGhState {
  /** Directory holding both records. */
  readonly dir: string;
  /** One line per invocation, in order. */
  readonly callsFile: string;
  /** The pull requests the stand-in GitHub holds, one JSON line each. */
  readonly pullRequestsFile: string;
}

/** One invocation of the stand-in `gh`, as it recorded it. */
export interface FakeGhCall {
  readonly op: 'list' | 'create' | 'edit';
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly repo: string | null;
  readonly head: string | null;
  readonly base: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly body: string | null;
}

/**
 * The stand-in GitHub CLI, stored as a real file so that it can be read and
 * reviewed: the lowest boundary the delivery step has, exactly as the stand-in
 * `codex` is the lowest boundary of a coding turn.
 */
const FAKE_GH = path.join(repoRoot, 'tests', 'fixtures', 'fake-gh.mjs');

/**
 * The stand-in GitHub CLI of the review-to-completion suites: the same idea, one
 * step further. It answers the reads and the one auto-merge request the
 * completion path makes, holds the pull request, its reviews, its checks, and
 * its workflow runs as seeded JSON files, and records the credential every
 * invocation was made with — which is how a test shows that the reviewer's
 * credential never became the operator's.
 */
const FAKE_GH_COMPLETION = path.join(repoRoot, 'tests', 'fixtures', 'fake-gh-completion.mjs');

/**
 * Puts an executable named `gh` in a directory of its own, backed by
 * tests/fixtures/fake-gh.mjs. It answers `gh pr list` from the pull requests it
 * has been asked to create, and records every invocation. Nothing in `src/`
 * knows it exists, and no flag reaches it.
 */
export async function installFakeGh(parent: string): Promise<{
  readonly bin: string;
  readonly shim: string;
  readonly state: FakeGhState;
}> {
  const bin = path.join(parent, 'fake-gh-bin');
  const stateDir = path.join(parent, 'fake-gh-state');
  await mkdir(bin, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const shim = await writeShim(bin, 'gh', FAKE_GH);

  return {
    bin,
    shim,
    state: {
      dir: stateDir,
      callsFile: path.join(stateDir, 'calls.jsonl'),
      pullRequestsFile: path.join(stateDir, 'pull-requests.json'),
    },
  };
}

/** Where the completion stand-in keeps its record and the state it was given. */
export interface FakeCompletionState {
  /** Directory holding the call record and every state file. */
  readonly dir: string;
  readonly callsFile: string;
  readonly pullRequestsFile: string;
  readonly reviewsFile: string;
  readonly checksFile: string;
  readonly runsFile: string;
  /** The GitHub CLI this stand-in is installed as. */
  readonly command: string;
}

/**
 * Puts an executable named `gh` in a directory of its own, backed by
 * tests/fixtures/fake-gh-completion.mjs.
 */
export async function installFakeGhCompletion(
  parent: string,
  name = 'completion-gh',
): Promise<FakeCompletionState> {
  const bin = path.join(parent, 'fake-gh-completion-bin');
  const stateDir = path.join(parent, 'fake-gh-completion-state');
  await mkdir(bin, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const command = await writeShim(bin, name, FAKE_GH_COMPLETION);
  return {
    dir: stateDir,
    callsFile: path.join(stateDir, 'calls.jsonl'),
    pullRequestsFile: path.join(stateDir, 'pull-requests.json'),
    reviewsFile: path.join(stateDir, 'pr-reviews.json'),
    checksFile: path.join(stateDir, 'pr-checks.json'),
    runsFile: path.join(stateDir, 'workflow-runs.json'),
    command,
  };
}

/** One invocation of the completion stand-in, in the order it happened. */
export interface FakeCompletionCall {
  readonly op: 'list' | 'view' | 'reviews' | 'checks' | 'lens' | 'findings' | 'merge' | 'runs';
  readonly argv: readonly string[];
  /** The credential this invocation was made with, as the environment had it. */
  readonly credential: string | null;
  readonly repo: string | null;
  readonly url?: string | null;
  readonly head?: string | null;
  readonly commit?: string | null;
  readonly event?: string | null;
  readonly branch?: string | null;
  readonly state?: string | null;
  readonly headRefOid?: string | null;
  readonly auto?: boolean;
  readonly squash?: boolean;
}

/** Every invocation the completion stand-in recorded, in order. */
export async function fakeCompletionCalls(
  state: FakeCompletionState,
): Promise<readonly FakeCompletionCall[]> {
  return await readJsonLines<FakeCompletionCall>(state.callsFile);
}

/** Every invocation the stand-in `gh` recorded, in order. */
export async function fakeGhCalls(state: FakeGhState): Promise<readonly FakeGhCall[]> {
  return await readJsonLines<FakeGhCall>(state.callsFile);
}

/** The pull requests the stand-in GitHub holds, in the order they were created. */
export async function fakePullRequests(
  state: FakeGhState,
): Promise<readonly { url: string; title: string; body: string }[]> {
  return await readJsonLines<{ url: string; title: string; body: string }>(state.pullRequestsFile);
}

/** One turn's plan, as the stand-in runtime reads it. */
export interface FakePlan {
  /** A deterministic reviewer whose verdict depends on real Git and file reads. */
  readonly reviewInspection?: {
    readonly file: string;
    readonly blockingText: string;
    readonly blockingVerdict: string;
    readonly clearVerdict: string;
  };
  /** Named variables whose presence (never values) the runtime records. */
  readonly inspectEnvironment?: readonly string[];
  /** Files to write into the working copy, relative to its root. */
  readonly edits?: readonly { readonly file: string; readonly text: string }[];
  /** Files to remove from the working copy, relative to its root. */
  readonly removes?: readonly string[];
  /**
   * A message the stand-in commits its whole working copy with, once it has made
   * its changes: the harness starts no coding turn from a working copy that still
   * holds uncommitted work (HARN-35), so a plan whose turn the run repairs names
   * this.
   */
  readonly commit?: string;
  /** How long the turn holds, keeping a child process of its own alive. */
  readonly holdMs?: number;
  /** How the runtime behaves; `ok` reports a completed turn. */
  readonly mode?: 'ok' | 'auth' | 'crashed' | 'malformed' | 'incomplete' | 'failed';
  /** The agent's own words for the turn. */
  readonly summary?: string;
}

/** One invocation of the stand-in runtime, as it recorded it. */
export interface FakeTurn {
  readonly environmentPresent: Readonly<Record<string, boolean>>;
  readonly index: number;
  readonly pid: number;
  /** The beacon token of the process itself: see {@link fixtureProcessGone}. */
  readonly pidToken: string | null;
  readonly child: number | null;
  /** The beacon token of the child the turn started, if it started one. */
  readonly childToken: string | null;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly prompt: string;
}

/** One event the stand-in runtime observed or produced. */
export interface FakeEvent {
  readonly event: string;
  readonly at: number;
  readonly pid?: number;
  readonly child?: number | null;
  readonly signal?: string;
  readonly index?: number;
  readonly mode?: string;
  readonly holdMs?: number;
  readonly files?: readonly string[];
  readonly cwd?: string;
}

/** Every invocation the stand-in runtime recorded, in order. */
export async function fakeTurns(state: FakeState): Promise<readonly FakeTurn[]> {
  return await readJsonLines<FakeTurn>(state.turnsFile);
}

/** Every event the stand-in runtime recorded, in order. */
export async function fakeEvents(state: FakeState): Promise<readonly FakeEvent[]> {
  return await readJsonLines<FakeEvent>(state.eventsFile);
}

/** Whether the stand-in runtime ran at all. */
export function fakeRuntimeUsed(state: FakeState): boolean {
  return existsSync(state.turnsFile);
}

async function readJsonLines<T>(file: string): Promise<readonly T[]> {
  if (!existsSync(file)) {
    return [];
  }
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

// ---------------------------------------------------------------------------
// The disposable repository, its inputs, and its outputs
// ---------------------------------------------------------------------------

export interface LocalTarget {
  /** Temporary directory holding the repository, the inputs, and the runs. */
  readonly parent: string;
  /** The source repository: one commit, and a clean checkout of it. */
  readonly repo: string;
  /** The directory the Nexus-wide configuration and the task file live in. */
  readonly configDir: string;
  /** The Nexus-wide `nexus.config.json`, naming this host's own node as the runner. */
  readonly configPath: string;
  /**
   * The project configuration the repository commits at its root: what `--repo`
   * (or `--project`) has the harness read for this target.
   */
  readonly projectPath: string;
  /** `task.json`: the task the run is asked to complete. */
  readonly taskPath: string;
  /** The configured output directory, resolved from the configuration file. */
  readonly workDir: string;
  /** The `codex` the CLI will resolve from its `PATH`. */
  readonly bin: string;
  /** The stand-in runtime itself, for a configuration that names it directly. */
  readonly runtimePath: string;
  /** Where the stand-in runtime records what it was asked to do. */
  readonly state: FakeState;
}

export interface LocalTargetOptions {
  /** Commit a baseline whose own test fails, so the baseline round is red. */
  readonly brokenBaseline?: boolean;
  /** Name of the repository directory; a test uses one with spaces in it. */
  readonly repoName?: string;
  /** Name of the directory holding the configuration and task files. */
  readonly configDirName?: string;
  /** Name of the configured output directory. */
  readonly workDirName?: string;
  /** How many repair turns the configuration allows. */
  readonly maxRepairs?: number;
}

/**
 * Creates the target project and commits its baseline, plus the inputs a run
 * reads and the runtime stand-in it will resolve. The repository really is a
 * repository: the CLI's own Git code clones it and inspects the clone.
 */
export async function createLocalTarget(options: LocalTargetOptions = {}): Promise<LocalTarget> {
  const parent = await createTempDir();
  const repo = path.join(parent, options.repoName ?? 'tiny-target');
  await mkdir(repo, { recursive: true });

  const files: Record<string, string> = {
    '.gitattributes': '* -text\n',
    '.gitignore': 'build/\n',
    'README.md': [
      '# tiny-target',
      '',
      'A tiny deterministic project used to exercise the local loop offline.',
      'Its checks are run by tools/run-checks.mjs; tools/prepare.mjs is its setup step.',
      '',
    ].join('\n'),
    'src/greet.mjs': options.brokenBaseline === true ? BROKEN_GREET_SOURCE : GREET_SOURCE,
    'test/greet.test.mjs': GREET_TEST_SOURCE,
    'test/greet-all.test.mjs': GREET_ALL_TEST_SOURCE,
    'tools/prepare.mjs': PREPARE_SOURCE,
    'tools/run-checks.mjs': RUN_CHECKS_SOURCE,
  };
  // The project configuration is part of the repository: a connected project
  // carries it committed at its root, and a run clones the repository it names.
  files[PROJECT_CONFIG_FILE_NAME] = `${JSON.stringify(
    {
      setup: [[process.execPath, 'tools/prepare.mjs']],
      checks: [[process.execPath, 'tools/run-checks.mjs']],
    },
    null,
    2,
  )}\n`;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(repo, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }

  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--message', 'tiny-target: baseline');

  const { bin, shim, state } = await installFakeRuntime(parent);

  const configDir = path.join(parent, options.configDirName ?? 'inputs');
  const workDirName = options.workDirName ?? 'runs';
  await mkdir(configDir, { recursive: true });
  // The output directory resolves from the configuration file's own directory,
  // so it is written relative to it, as docs/WORKFLOW.md §1 describes.
  const configPath = await writeJsonFile(configDir, HARNESS_CONFIG_FILE_NAME, {
    workDir: `./${workDirName}`,
    maxRepairs: options.maxRepairs ?? 2,
    taskTimeoutMinutes: 60,
    commandTimeoutMinutes: 10,
  });
  const taskPath = await writeJsonFile(configDir, 'task.json', {
    id: 'greet-all',
    title: 'Add a greetAll helper to tiny-target',
    description:
      'tiny-target needs a greetAll helper that greets several names in one sentence, ' +
      'following the conventions of src/greet.mjs.',
    acceptanceCriteria: [
      'src/greet-all.mjs exports greetAll(names).',
      "greetAll(['Ada']) is 'Hello, Ada!'.",
      "greetAll(['Ada', 'Grace']) is 'Hello, Ada and Grace!'.",
      "greetAll([]) is 'Hello, nobody!'.",
      "The project's own checks (tools/run-checks.mjs) exit 0.",
    ],
  });

  return {
    parent,
    repo,
    configDir,
    configPath,
    projectPath: path.join(repo, PROJECT_CONFIG_FILE_NAME),
    taskPath,
    workDir: path.join(configDir, workDirName),
    bin,
    runtimePath: shim,
    state,
  };
}

/**
 * A private Git environment, so the developer's own Git settings cannot decide
 * what a fixture commits or which branch it starts on.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(
      process.env.TEMP ?? process.env.TMPDIR ?? '.',
      'nonexistent-gitconfig',
    ),
    GIT_AUTHOR_NAME: 'Harness CLI Test',
    GIT_AUTHOR_EMAIL: 'cli@example.test',
    GIT_COMMITTER_NAME: 'Harness CLI Test',
    GIT_COMMITTER_EMAIL: 'cli@example.test',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/** Runs one Git command in a fixture repository and returns its output. */
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

/** What a repository is at: its commit, and whether its tree is clean. */
export function checkoutState(repo: string): { readonly head: string; readonly status: string } {
  return {
    head: git(repo, 'rev-parse', 'HEAD').trim(),
    status: git(repo, 'status', '--porcelain').trim(),
  };
}

// ---------------------------------------------------------------------------
// The built CLI, as a process
// ---------------------------------------------------------------------------

/** The built artifact: the file `npm start` runs, and nothing else. */
export const BUILT_CLI = path.join(repoRoot, 'dist', 'cli.js');

/**
 * Builds `dist/` when it is missing or older than the sources it is built from.
 *
 * `npm run validate` builds before it tests, so in the gate this does nothing. A
 * bare `npm test` on a fresh checkout has no artifact to spawn, and a suite that
 * quietly tested a stale one would be worse than one that failed: this runs the
 * same compiler the build script runs, directly, and fails loudly if the artifact
 * is still not there.
 *
 * Several test files run in parallel, and each of them may find the artifact
 * stale at the same moment; a compiler per worker writing into the same `dist/`
 * produces half-written files that the next worker spawns. One lock, taken
 * exclusively and re-checked once it is held, keeps exactly one build running.
 */
export function ensureBuiltCli(): void {
  if (builtCliIsCurrent()) {
    return;
  }

  const lock = acquireBuildLock();
  if (lock === null) {
    // Another worker's build produced the artifact while this one waited.
    return;
  }
  try {
    // Re-checked under the lock: a worker that built it while this one waited
    // leaves nothing to do.
    if (builtCliIsCurrent()) {
      return;
    }
    buildCli();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Whether the built artifact exists and is at least as new as the sources. */
function builtCliIsCurrent(): boolean {
  const built = existsSync(BUILT_CLI) ? statSync(BUILT_CLI).mtimeMs : -1;
  return built >= newestSourceMtime();
}

/** The lock one worker holds while it builds; `dist/` is shared by all of them. */
const BUILD_LOCK = path.join(repoRoot, 'dist', '.build.lock');

/** How long a worker waits for another worker's build before giving up. */
const BUILD_LOCK_TIMEOUT_MS = 120_000;

/** Sleeps without yielding the event loop: callers of this are synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Takes the build lock, waiting while another worker holds it, or returns `null`
 * when that worker's build made the artifact current. Only a caller that gets a
 * path owns the lock, and only it removes it.
 */
function acquireBuildLock(): string | null {
  const deadline = Date.now() + BUILD_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(path.dirname(BUILD_LOCK), { recursive: true });
      writeFileSync(BUILD_LOCK, `${String(process.pid)}\n`, { flag: 'wx' });
      return BUILD_LOCK;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw cause;
      }
    }
    // The holder is building the artifact this caller needs, so waiting is
    // enough; if its build finished, there is nothing left to do.
    if (builtCliIsCurrent()) {
      return null;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the built CLI is still being produced after ${String(BUILD_LOCK_TIMEOUT_MS)} ms ` +
          `(lock "${BUILD_LOCK}"); if no build is running, remove the lock and try again`,
      );
    }
    sleepSync(100);
  }
}

/** Runs the same compiler the build script runs, directly. */
function buildCli(): void {
  const require = createRequire(import.meta.url);
  const typescript = path.dirname(require.resolve('typescript/package.json'));
  const result = spawnSync(
    process.execPath,
    [path.join(typescript, 'bin', 'tsc'), '--project', 'tsconfig.build.json'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0 || !existsSync(BUILT_CLI)) {
    throw new Error(
      `the built CLI could not be produced (${BUILT_CLI}): ` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
}

/** The most recent modification time under `src/`, in milliseconds. */
function newestSourceMtime(): number {
  let newest = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  return newest;
}

/** How the built CLI is started: one invocation, one environment. */
export interface CliInvocation {
  /** The target whose fixture `PATH`, working directory, and outputs are used. */
  readonly target: LocalTarget;
  /** The command line, after `dist/cli.js`. */
  readonly argv: readonly string[];
  /** The turns the stand-in runtime is to run, in order. */
  readonly plans?: readonly FakePlan[];
  /** Directory the CLI is started in; the target's parent by default. */
  readonly cwd?: string;
  /**
   * Environment entries this invocation adds to the fixture's own. A test that
   * is about what the CLI must not read (a native configuration, a credential)
   * points those at something it can prove was never opened.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** What one invocation of the built CLI did. */
export interface CliRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The environment one invocation runs in: this process's own, with the runtime
 * stand-in first on `PATH` — so the production adapter's `codex` is the fixture
 * and no other `codex` on this host can be reached — and with the plans it is to
 * follow.
 */
export function cliEnvironment(invocation: CliInvocation): NodeJS.ProcessEnv {
  const { target } = invocation;
  return {
    ...process.env,
    PATH: `${target.bin}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_CODEX: JSON.stringify({ stateDir: target.state.dir, plans: invocation.plans ?? [] }),
    ...invocation.env,
  };
}

/** Starts the built CLI and collects everything it wrote. */
export function startCli(invocation: CliInvocation): {
  readonly child: ChildProcess;
  readonly done: Promise<CliRunResult>;
} {
  const child = spawn(process.execPath, [BUILT_CLI, ...invocation.argv], {
    cwd: invocation.cwd ?? invocation.target.parent,
    env: cliEnvironment(invocation),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // A group of its own on POSIX, exactly as `runProcess` starts a command: the
    // stop the lifecycle asks for is the production tree stop, which addresses a
    // POSIX tree by its negated group leader's PID. A CLI left in this worker's
    // own group would have no group of its own to stop, and the request would
    // reach nothing while the CLI kept running.
    detached: process.platform !== 'win32',
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

  const done = new Promise<CliRunResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  // The CLI is one of the processes the test owns: the fixture lifecycle stops
  // its tree and waits for this same promise before any directory it wrote into
  // is removed, so a test that times out, fails or is cancelled cannot leave a
  // half-run CLI holding its target.
  void ownChildProcess('the built CLI', child, invocation.cwd ?? invocation.target.parent);
  return { child, done };
}

/** Runs the built CLI to completion. */
export async function runCli(invocation: CliInvocation): Promise<CliRunResult> {
  return await ownFixtureOperation('the built CLI', async () => await startCli(invocation).done);
}

/** Waits for `check`, or fails the test that asked, naming what it waited for. */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Whether a process is still there, without signalling it. */
export function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a process is gone. A PID that cannot be signalled is not running. */
export function processGone(pid: number): boolean {
  return !stillRunning(pid);
}

/**
 * Where a fixture process's beacon answers, named by the directory the fixture
 * keeps its beacons in and the token it recorded.
 */
function beaconAddress(beaconDirectory: string, token: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\nexus-fixture-${token}`
    : path.join(beaconDirectory, 'beacons', `${token}.sock`);
}

/** What one question to a fixture's beacon answered. */
type BeaconAnswer = 'answers' | 'silent' | 'unknown';

/**
 * Asks one fixture process's beacon whether it is there.
 *
 * `answers` is the answer only a running process can give, and it is the one
 * answer that proves a recorded PID still belongs to the process that recorded
 * it. `silent` is a listener that is not there any more. Anything else — a
 * listener that does not answer in time, or a failure that is not "nothing is
 * listening" — is `unknown`, which is never read as either.
 */
async function askBeacon(
  beaconDirectory: string,
  token: string,
  timeoutMs: number,
): Promise<BeaconAnswer> {
  return await new Promise<BeaconAnswer>((resolve) => {
    const socket = connect(beaconAddress(beaconDirectory, token));
    let settled = false;
    const finish = (answer: BeaconAnswer): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => {
      finish('unknown');
    }, timeoutMs);
    socket.once('connect', () => {
      finish('answers');
    });
    socket.once('error', (cause) => {
      const code = (cause as NodeJS.ErrnoException).code;
      // Nothing is listening there any more. Any other failure is not an answer
      // that the process is gone, and is not read as one.
      finish(code === 'ENOENT' || code === 'ECONNREFUSED' ? 'silent' : 'unknown');
    });
  });
}

/**
 * Whether the fixture process that recorded this beacon token is gone.
 *
 * A recorded PID cannot answer that on this platform: Windows hands a PID to a
 * new process within seconds of the process that held it ending, so a PID that
 * looks alive is not evidence that the process a turn recorded still is. The
 * beacon is named by a token only that one process recorded, and the fixture
 * writes the token down only once its listener answers, so a recorded token
 * always names a listener that exists. A beacon that neither answers nor refuses
 * within the grace below counts as still there — a process that is there but not
 * answering is still there — so nothing is quietly reported as stopped.
 */
export async function fixtureProcessGone(
  state: { readonly dir: string },
  token: string,
): Promise<boolean> {
  return (await askBeacon(state.dir, token, 5000)) === 'silent';
}

/** One fixture process as a suite recorded it: the PID, and the token it recorded. */
export interface FixtureProcessRecord {
  readonly pid: number;
  /** The beacon token of the process itself, when it recorded one. */
  readonly token: string | null;
  /** The directory the fixture's beacons answer from: the fixture's own directory. */
  readonly beaconDirectory: string;
}

/**
 * Ends one fixture process tree, but only a process whose beacon answers: a
 * recorded PID is named only while the process that recorded it is proven to
 * still hold it, so a PID Windows has since handed to something else is never
 * signalled (notes/windows-fixture-flakes.md).
 *
 * The tree is what is stopped, so a child the fixture started goes with it. A
 * fixture that no longer answers is left alone: its own backstop ends it, and a
 * bare PID is not evidence enough to end anything by. Returns whether a stop
 * was sent.
 */
export async function endFixtureTree(record: FixtureProcessRecord): Promise<boolean> {
  if (
    record.token === null ||
    (await askBeacon(record.beaconDirectory, record.token, 1000)) !== 'answers'
  ) {
    return false;
  }

  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(record.pid), '/T', '/F'], { stdio: 'ignore' });
    return true;
  }

  // Every fixture leads its own process group, so the group is addressed by the
  // negated PID and the child the fixture started goes with it.
  try {
    process.kill(-record.pid, 'SIGKILL');
    return true;
  } catch {
    try {
      process.kill(record.pid, 'SIGKILL');
      return true;
    } catch {
      // Already gone between the answer and the signal: nothing left to stop.
      return false;
    }
  }
}

/** Removes a fixture directory, tolerating a file another process still holds. */
export async function removeDirectory(directory: string, attempts = 5): Promise<void> {
  await removeWithRetry(async () => rm(directory, { recursive: true, force: true }), attempts);
}

// ---------------------------------------------------------------------------
// The interrupt: a real one, delivered by the operating system
// ---------------------------------------------------------------------------

/** What one interrupted invocation did. */
export interface InterruptResult extends CliRunResult {
  /** Whether the operating system really delivered the interrupt. */
  readonly delivered: boolean;
  /**
   * How long the CLI took to end after the interrupt was sent, in milliseconds.
   * A run that was still holding a turn when it was interrupted has to end well
   * inside the hold, or nothing interrupted it.
   */
  readonly elapsedMs: number;
  /** What the helper reported, for a failure message. */
  readonly detail: string;
}

export interface InterruptInvocation extends CliInvocation {
  /**
   * Resolves when the run is provably in the middle of a coding turn. The
   * interrupt is sent then and not before: it has to arrive while the run is
   * doing something it must stop, and a sleep would only guess at that.
   */
  readonly started: () => Promise<void>;
}

/**
 * Starts the built CLI in a way that lets this test interrupt it the way the
 * platform really does, and interrupts it once `started()` says the run is in the
 * middle of a coding turn.
 *
 * The two platforms need different mechanisms, and neither is a shortcut:
 *
 * - Windows delivers an interrupt to a process only as a console control event.
 *   `child.kill('SIGINT')` does not send one — it terminates the process, and the
 *   CLI's own handler never runs, which was measured on this host rather than
 *   assumed. Ctrl+C cannot be delivered to a process another process started
 *   either: the console disables it for a process started in its own process
 *   group, and `GenerateConsoleCtrlEvent(CTRL_C_EVENT, …)` returns success
 *   without reaching it. Ctrl+Break is delivered, and Node reports it as
 *   `SIGBREAK`. So the CLI is started through `CreateProcess` with a console and
 *   a process group of its own, and `CTRL_BREAK_EVENT` is sent to that group: the
 *   same event this user's Ctrl+Break produces, arriving at the same handler.
 * - Everywhere else the CLI is an ordinary child process and `SIGINT` is
 *   delivered to it directly, exactly as Ctrl+C would be.
 */
export async function interruptCli(invocation: InterruptInvocation): Promise<InterruptResult> {
  return process.platform === 'win32'
    ? await interruptWithConsoleEvent(invocation)
    : await interruptWithSignal(invocation);
}

/** `SIGINT` to the CLI process itself: what Ctrl+C delivers on POSIX hosts. */
async function interruptWithSignal(invocation: InterruptInvocation): Promise<InterruptResult> {
  const { child, done } = startCli(invocation);
  await invocation.started();
  const sentAt = Date.now();
  const delivered = child.kill('SIGINT');
  const result = await done;
  return {
    ...result,
    delivered,
    elapsedMs: Date.now() - sentAt,
    detail: `SIGINT to pid ${String(child.pid)}`,
  };
}

/**
 * The Windows interrupt, as one PowerShell program:
 *
 * 1. `CreateProcess` the CLI with `CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP`,
 *    so it owns a console and leads a process group nothing else is in. Its window
 *    is hidden, the event is addressed to that group, and no other process — this
 *    test's runner included — can be reached by it.
 * 2. Wait for the marker file this test writes when the run is in a coding turn.
 * 3. `CTRL_BREAK_EVENT` to that process group: a real console control event from
 *    the operating system, delivered by the console.
 * 4. Wait for the CLI to exit and report its exit code. Waiting is the only way to
 *    read it back: a process in a console of its own writes to that console, so it
 *    is not a pipe this test holds. What the run did is read from the run
 *    directory it left behind, which is what a user would look at.
 */
async function interruptWithConsoleEvent(
  invocation: InterruptInvocation,
): Promise<InterruptResult> {
  const environment = cliEnvironment(invocation);
  const marker = path.join(invocation.target.state.dir, 'interrupt.marker');
  const command = [process.execPath, BUILT_CLI, ...invocation.argv]
    .map(quoteWindowsArgument)
    .join(' ');

  const script = [
    consoleInterop(marker),
    '$ErrorActionPreference = "Stop"',
    `$cwd = ${quotePowerShell(invocation.cwd ?? invocation.target.parent)}`,
    `$env:FAKE_CODEX = ${quotePowerShell(environment.FAKE_CODEX ?? '{}')}`,
    `$env:PATH = ${quotePowerShell(environment.PATH ?? '')}`,
    '$si = New-Object W.Nexus+SI',
    '$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)',
    '$si.dwFlags = 0x00000001',
    '$si.wShowWindow = 0',
    '$pi = New-Object W.Nexus+PI',
    `$command = ${quotePowerShell(command)}`,
    '$flags = 0x00000010 -bor 0x00000200',
    '$ok = [W.Nexus]::CreateProcess($node, $command, [IntPtr]::Zero, [IntPtr]::Zero, $false, [uint32]$flags, [IntPtr]::Zero, $cwd, [ref]$si, [ref]$pi)',
    'if (-not $ok) {',
    '  Write-Output "created=false"',
    '  Write-Output ("error=" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())',
    '  exit 0',
    '}',
    'Write-Output "created=true"',
    '$target = $pi.dwProcessId',
    'Write-Output "pid=$target"',
    '$deadline = (Get-Date).AddMilliseconds(90000)',
    'while (-not (Test-Path $marker)) {',
    '  if ((Get-Date) -ge $deadline) { break }',
    '  Start-Sleep -Milliseconds 25',
    '}',
    'Write-Output ("started=" + (Test-Path $marker))',
    '[void][W.Nexus]::FreeConsole()',
    '$attached = [W.Nexus]::AttachConsole([uint32]$target)',
    'Write-Output "attached=$attached"',
    '[void][W.Nexus]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)',
    '$sent = $false',
    'if ($attached) { $sent = [W.Nexus]::GenerateConsoleCtrlEvent(1, [uint32]$target) }',
    'Write-Output "sent=$sent"',
    'Write-Output ("sentAt=" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())',
    '[void][W.Nexus]::WaitForSingleObject($pi.hProcess, 180000)',
    '$code = [uint32]0',
    '[void][W.Nexus]::GetExitCodeProcess($pi.hProcess, [ref]$code)',
    'Write-Output "exit=$code"',
    'Write-Output ("exitAt=" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())',
    '[void][W.Nexus]::CloseHandle($pi.hThread)',
    '[void][W.Nexus]::CloseHandle($pi.hProcess)',
  ].join('\n');

  const helper = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  // The helper is a process this test started, and the CLI it creates through
  // `CreateProcess` is its child: registering it gives the lifecycle the one
  // handle this side has on a run that is still being interrupted when the test
  // ends, because a console control event cannot be reached by PID from here.
  void ownChildProcess('the console-interrupt helper', helper, repoRoot);

  let output = '';
  let errors = '';
  helper.stdout?.setEncoding('utf8');
  helper.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  helper.stderr?.setEncoding('utf8');
  helper.stderr?.on('data', (chunk: string) => {
    errors += chunk;
  });

  // The helper waits for the marker rather than sleeping, so the interrupt lands
  // while the run is holding a coding turn. It is written from here because only
  // this side can see the fixture's own records.
  let startedProblem: unknown = null;
  const started = invocation.started().then(
    async () => {
      await writeFile(marker, 'the run is in a coding turn\n', 'utf8');
    },
    async (cause: unknown) => {
      // The run never reached a turn: let the helper finish rather than wait, and
      // fail the test with the reason instead of interrupting nobody.
      startedProblem = cause;
      await writeFile(marker, 'the run never reached a coding turn\n', 'utf8');
    },
  );

  const helperExit = await new Promise<number | null>((resolve, reject) => {
    helper.on('error', reject);
    helper.on('close', (code) => {
      resolve(code);
    });
  });
  await started;
  if (startedProblem !== null) {
    throw startedProblem instanceof Error ? startedProblem : new Error(String(startedProblem));
  }

  const read = (name: string): string | null =>
    new RegExp(`^${name}=(.*)$`, 'm').exec(output)?.[1] ?? null;
  const exit = read('exit');
  if (helperExit !== 0 || exit === null) {
    throw new Error(
      `the console-interrupt helper did not report an exit code (helper exit ${String(helperExit)}): ` +
        `${output.trim()} ${errors.trim()}`,
    );
  }

  const sentAt = Number.parseInt(read('sentAt') ?? '', 10);
  const exitAt = Number.parseInt(read('exitAt') ?? '', 10);

  return {
    code: Number.parseInt(exit, 10),
    signal: null,
    // A CLI in a console of its own owns that console's output; nothing of it is
    // captured here, and the run directory is what this suite reads instead.
    stdout: '',
    stderr: '',
    delivered: read('sent') === 'True' && read('started') === 'True',
    elapsedMs: exitAt - sentAt,
    detail: output.trim().replaceAll('\n', ', '),
  };
}

/**
 * The Windows API surface the console helper needs, and nothing else: create the
 * CLI with a console of its own and a process group of its own, then address the
 * control event to that group.
 */
function consoleInterop(marker: string): string {
  return `Add-Type -Namespace W -Name Nexus -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct SI {
  public int cb;
  public string lpReserved;
  public string lpDesktop;
  public string lpTitle;
  public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
  public short wShowWindow, cbReserved2;
  public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
}
[StructLayout(LayoutKind.Sequential)]
public struct PI { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CreateProcess(string app, string cmd,
  IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd,
  ref SI si, out PI pi);
[DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
[DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint evt, uint group);
'@
$node = ${quotePowerShell(process.execPath)}
$marker = ${quotePowerShell(marker)}`;
}

/** Quotes a value as a single-quoted PowerShell string literal. */
function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Quotes one argument the way `CreateProcess` reads a command line, so a path
 * with spaces in it arrives as one argument.
 */
function quoteWindowsArgument(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) {
    return value;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${'\\'.repeat(backslashes * 2 + 1)}"`;
    } else {
      quoted += `${'\\'.repeat(backslashes)}${character}`;
    }
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}
