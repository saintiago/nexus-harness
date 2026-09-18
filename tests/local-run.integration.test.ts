/**
 * The offline local-loop milestone: `runTask` exercised end to end against a real
 * target project, with only the coding agent substituted.
 *
 * Everything a run does here is real. The source is a real temporary Git
 * repository with one commit; the working copy is a real clone made by the
 * harness's own Git code; the configured setup and check commands are real child
 * processes started by the harness, running the target project's own tools
 * through a real test runner; the logs are the harness's own log files; and the
 * report is the `result.json` the harness wrote, parsed back from disk. Nothing
 * about the loop itself is faked, and no provider, network, package download, or
 * real coding agent is involved: the tests never set a model name, a key, or an
 * endpoint.
 *
 * Two substitutions, and no more:
 *
 * - The coding agent. A turn is a real child process (the runtime stand-in) that
 *   reads a plan and writes the files the plan names into the actual clone, then
 *   returns a summary — so the harness really observes a changed working copy,
 *   and a plan that writes nothing really leaves the checks red. The summary is
 *   the only thing it contributes beyond the files: agent text, which the report
 *   keeps and the status never uses.
 * - The clock, in the one test where the target project's own check hangs for
 *   real. The run reads its deadline from a clock a test owns, and a turn
 *   advances it by 56 of the run's 60 seconds; the check that then hangs is a real
 *   process tree, stopped by the harness's real limit. No sleep decides anything:
 *   the clock moves only when a test moves it, and the harness stops the hanging
 *   tree by its own limit rather than by waiting.
 *
 * The target project is tiny and deterministic and was committed with a green
 * baseline. Its own test file reports the feature the task asks for as a skip
 * while the feature is absent, which is what the baseline round observes. One
 * honest limit follows from that, and is worth stating plainly: a baseline round
 * and a no-op coding turn observe the same working copy, so no deterministic
 * check can be green on the one and red on the other. What these tests prove
 * instead is checkable: that the configured checks really execute the agent's
 * implementation through the project's own runner, that a wrong, broken, or
 * hanging implementation genuinely fails, and that the run's own retained
 * evidence shows which of the two the checks observed. A passing run below
 * therefore asserts that the feature test *ran and passed* in the retained clone
 * (`greet-all: ok` in the check's own log), and the exhaustion and lying runs
 * assert the failure the checks really saw. A no-op turn is never a silent pass
 * anywhere in this file.
 *
 * Every scenario the milestone names is one test:
 *
 * 1. implementation then pass, with a complete green post-agent round
 * 2. a failed implementation, then a repair that is told what was observed
 * 3. repair exhaustion at the exact turn limit
 * 4. a lying coding turn that cannot turn a failing check into a pass
 * 5. a red baseline that stops the run before any turn touches the clone
 * 6. a setup failure after a turn: no repair, no check, artifacts kept
 * 7. a check that cannot be launched: no turn, report still written
 * 8. the run's own deadline stopping a real hanging check tree, confirmed
 * 9. a cancelled run stopping the turn's own tree, with artifacts preserved
 * 10. two runs of one task sharing neither a run directory nor a working copy
 *
 * Fixtures live in temporary directories of their own and are removed afterwards;
 * the repository, its configuration, and the developer's own Git settings are
 * never touched. Every fixture process is registered by PID and stopped in
 * `afterEach`, so a failing assertion cannot leave a hanging fixture behind.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCheckRound } from '../src/checks.js';
import {
  agentLogPath,
  appendRunLog,
  openAgentLog,
  runLogPath,
  writeRunReport,
} from '../src/report.js';
import { runTask } from '../src/runner.js';
import type {
  AgentTurnRequest,
  AgentTurnResult,
  RunnerDependencies,
  RunTaskRequest,
  RunTaskResult,
} from '../src/runner.js';
import type {
  AttemptEvidence,
  CheckRoundResult,
  CommandResult,
  HarnessConfig,
  RunReport,
  Task,
} from '../src/types.js';
import {
  allocateRunDirectory,
  prepareWorkspace,
  preflightSource,
  recordWorkspaceAttempt,
} from '../src/workspace.js';
import type { PreparedWorkspace } from '../src/workspace.js';
import { cleanupTempDirectories, createTempDir, writeJsonFile } from './support.js';

/**
 * The fixture processes of these tests, by PID, registered as soon as a fixture
 * has recorded them. A stop a test means to prove is stopped here too, so a test
 * that fails half-way cannot leave a running fixture behind for the rest of the
 * suite.
 */
const fixtureProcesses = new Set<number>();

/**
 * Ends the recorded fixture processes by PID, with the host's own utility named
 * by absolute path, so cleanup does not depend on the PATH a test may have left
 * behind. Only PIDs the fixtures recorded for themselves are ever named.
 */
function stopFixtureProcesses(): void {
  for (const pid of fixtureProcesses) {
    if (process.platform === 'win32') {
      const taskkill = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'taskkill.exe',
      );
      if (existsSync(taskkill)) {
        spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        continue;
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone: nothing to clean up.
    }
  }
  fixtureProcesses.clear();
}

/** Remembers fixture PIDs before any assertion, so a failure still cleans up. */
function registerFixture(record: PidRecord): void {
  fixtureProcesses.add(record.pid);
  if (record.child !== null) {
    fixtureProcesses.add(record.child);
  }
}

afterEach(async () => {
  stopFixtureProcesses();
  await cleanupTempDirectories();
});

/** A private Git environment, so the developer's own Git settings cannot decide a test. */
let fixtureEnvironment: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  const directory = await createTempDir();
  const emptyConfig = path.join(directory, 'empty.gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  fixtureEnvironment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: 'Harness Integration Test',
    GIT_AUTHOR_EMAIL: 'integration@example.test',
    GIT_COMMITTER_NAME: 'Harness Integration Test',
    GIT_COMMITTER_EMAIL: 'integration@example.test',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}, 30_000);

// ---------------------------------------------------------------------------
// The target project, as committed source
// ---------------------------------------------------------------------------

/**
 * The baseline greeting. The project is tiny on purpose: the checks that decide a
 * run have to be cheap enough to run as real processes on every round, and small
 * enough that a wrong implementation is obviously wrong.
 */
const GREET_SOURCE = ['export function greet(name) {', '  return `Hello, ${name}!`;', '}', ''].join(
  '\n',
);

/** The same module with the comma missing: the committed, red baseline of test 5. */
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
 * and passes, which is what makes the committed baseline green; once a coding turn
 * writes the module, the test imports it and asserts the acceptance criteria — so
 * a wrong implementation fails here for real, in the project's own runner, on its
 * own assertion.
 */
const GREET_ALL_TEST_SOURCE = [
  "import assert from 'node:assert/strict';",
  "import { existsSync } from 'node:fs';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  '',
  "const location = new URL('../src/greet-all.mjs', import.meta.url);",
  'const feature = pathToFileURL(fileURLToPath(location)).href;',
  '',
  'if (!existsSync(location)) {',
  "  console.log('greet-all: skipped, the feature is not implemented in this working copy');",
  '} else {',
  '  const { greetAll } = await import(feature);',
  "  assert.equal(greetAll(['Ada']), 'Hello, Ada!');",
  "  assert.equal(greetAll(['Ada', 'Grace']), 'Hello, Ada and Grace!');",
  "  assert.equal(greetAll([]), 'Hello, nobody!');",
  "  console.log('greet-all: ok');",
  '}',
  '',
].join('\n');

/**
 * The project's setup step, run as a configured setup command before the baseline
 * and before every post-agent round. It is a real check of the project's own shape
 * — a missing source file fails it — and it refreshes an ignored build artifact,
 * so the harness's change summary has something it must not report.
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
  '  const manifest = `${JSON.stringify({ sources, tests }, null, 2)}\\n`;',
  "  writeFileSync('build/prepared.json', manifest, 'utf8');",
  '  console.log(`prepare: ok, ${sources.length} source files, ${tests.length} test files`);',
  '}',
  '',
].join('\n');

/**
 * The project's test runner, run as a configured check command. It is a real
 * runner: it starts every `test/*.test.mjs` file as its own child process, one at a
 * time, and exits nonzero if any of them did. It prints the PID of each child
 * before awaiting it, which is what lets a test read a hanging check's process back
 * out of the run's own log and insist that the harness stopped it.
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
  '    // The PID is printed before the child is awaited, so a test file that never',
  "    // ends still leaves the process a stop has to reach in this run's own log.",
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

/**
 * The runtime stand-in: the one thing that stands in for a coding agent. It is a
 * real child process that reads a plan and writes the files the plan names into
 * the working copy it is given — so a turn's work is real work in the real clone,
 * not a reported success with nothing behind it. With a hold it also starts a
 * child of its own and stays alive, which is what gives a cancelled turn a tree of
 * its own to stop before it returns.
 */
const RUNTIME_SOURCE = [
  "import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
  "import { spawn } from 'node:child_process';",
  "import path from 'node:path';",
  '',
  '// Two modes: `--turn` is a coding turn, `--child` is the process one holds.',
  'const [, , mode, planFile, workspace, eventsFile] = process.argv;',
  'const record = (event, extra = {}) =>',
  "  appendFileSync(eventsFile, `${JSON.stringify({ event, at: Date.now(), ...extra })}\\n`, 'utf8');",
  '',
  "if (mode === '--child') {",
  '  // The process a working turn manages: it never ends on its own, so a stop that',
  '  // did not reach it is visible as a live PID after the run has ended.',
  "  record('child-start', { pid: process.pid });",
  '  setInterval(() => {}, 250);',
  '  setTimeout(() => process.exit(0), 60_000);',
  '} else {',
  "  const plan = JSON.parse(readFileSync(planFile, 'utf8'));",
  '  const holds = Number(plan.holdMs ?? 0);',
  '  const child =',
  '    holds > 0',
  "      ? spawn(process.execPath, [process.argv[1], '--child', planFile, workspace, eventsFile], {",
  "          stdio: 'ignore',",
  '        })',
  '      : null;',
  '  // A child this host refuses to start must not take this process down: an',
  '  // unhandled error event would end a fixture that is meant to keep running.',
  '  if (child !== null) child.on("error", () => {});',
  "  record('start', { pid: process.pid, child: child === null ? null : child.pid });",
  '',
  '  const written = [];',
  '  for (const edit of plan.edits ?? []) {',
  '    const file = path.join(workspace, edit.file);',
  '    mkdirSync(path.dirname(file), { recursive: true });',
  "    writeFileSync(file, edit.text, 'utf8');",
  '    written.push(edit.file);',
  '  }',
  '  for (const file of plan.removes ?? []) {',
  '    rmSync(path.join(workspace, file), { force: true });',
  '    written.push(`removed ${file}`);',
  '  }',
  "  record('edits-written', { files: written });",
  '',
  '  if (holds > 0) {',
  '    setInterval(() => {}, 250);',
  '    // A backstop: a fixture that outlives its test still ends on its own.',
  '    setTimeout(() => process.exit(0), holds + 10_000);',
  '  } else {',
  "    record('end', {});",
  '  }',
  '}',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Processes, files, and time
// ---------------------------------------------------------------------------

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      // As in the other lifecycle fixtures: its own process group on POSIX, so
      // the test can stop the tree it started the way the harness stops one.
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
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Runs `git` with literal arguments, in the fixture environment. */
function git(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return runProcess('git', args, { cwd, env: fixtureEnvironment });
}

/** Runs `git` and insists it succeeded, so a setup failure is not read as an empty answer. */
async function gitOrThrow(args: readonly string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} in ${cwd} exited ${String(result.code)}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/** A checkout's own state: its committed HEAD and what is uncommitted there. */
async function checkoutState(repo: string): Promise<{ head: string; status: string }> {
  return {
    head: (await gitOrThrow(['rev-parse', 'HEAD'], repo)).trim(),
    status: (await gitOrThrow(['status', '--porcelain', '--untracked-files=all'], repo)).trim(),
  };
}

function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True while this host still reports a process with that PID. */
function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits, bounded, for a process to be gone, then insists that it is. */
async function expectGone(pid: number, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (stillRunning(pid) && Date.now() < deadline) {
    await pause(50);
  }
  expect(stillRunning(pid), `${what} (pid ${String(pid)}) was still running`).toBe(false);
}

/** The two PIDs of one fixture, as they are asserted about once it is stopped. */
async function expectTreeGone(record: PidRecord, what: string): Promise<void> {
  await expectGone(record.pid, what);
  if (record.child !== null) {
    await expectGone(record.child, `the child of ${what}`);
  }
}

/**
 * Ends one process tree a test started itself. Only a PID this test recorded for a
 * process it started is named here, and nothing outside the fixture is touched.
 */
function stopOwnTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone: nothing left to stop.
  }
}

/** Waits, bounded, for a stop request to arrive at a signal a turn was given. */
function stopRequested(signal: AbortSignal, timeoutMs = 30_000): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the run's stop request never arrived within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Waits, bounded, for a readiness signal: the value a reader returns once the thing
 * being awaited has really happened. Nothing here sleeps for a guessed duration — a
 * signal that never arrives fails the test that waited for it.
 */
async function waitFor<T>(
  read: () => Promise<T | null> | T | null,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`the test waited ${String(timeoutMs)} ms for ${what}, and it never happened`);
    }
    await pause(25);
  }
}

/**
 * Waits, bounded, for a child this test started to exit. A child that has already
 * ended is answered from its own recorded state, because the one event that says
 * so has already been emitted by then and would never arrive again.
 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`a fixture process did not exit within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    child.once('error', (cause: unknown) => {
      clearTimeout(timer);
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * The clock a run reads its deadline and its timestamps from. These tests use the
 * system clock unless a test needs to own it; an owned clock moves only when the
 * test moves it.
 */
interface RunClock {
  readonly now: () => Date;
  readonly advance: (ms: number) => void;
}

function systemClock(): RunClock {
  return { now: () => new Date(), advance: () => undefined };
}

/** A clock a test owns: see {@link RunClock}. */
function controlledClock(startMs: number): RunClock {
  let offset = 0;
  return {
    now: () => new Date(startMs + offset),
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

/** The one element a test expects to be there, named so a missing one reads clearly. */
function first<T>(items: readonly T[], what: string): T {
  const [value] = items;
  if (value === undefined) {
    throw new Error(`the test expected ${what}, and there was none`);
  }
  return value;
}

/** A run's written report, parsed back from disk: these tests read evidence. */
async function readReport(result: RunTaskResult): Promise<RunReport> {
  return JSON.parse(await readText(result.reportPath)) as RunReport;
}

/** The working copy of a run that this test needs to have one. */
function prepared(result: RunTaskResult): PreparedWorkspace {
  if (result.workspace === null) {
    throw new Error('the run prepared no working copy, and this test needs one to inspect');
  }
  return result.workspace;
}

/** One attempt's observed check round, which this test needs to have been run. */
function observed(attempt: AttemptEvidence, what: string): CheckRoundResult {
  if (attempt.checks === null) {
    throw new Error(
      `${what} was expected to have an observed check round, and the report holds none`,
    );
  }
  return attempt.checks;
}

/** What one command invocation wrote to its two log files, read back from disk. */
async function commandOutput(result: CommandResult): Promise<{ stdout: string; stderr: string }> {
  return { stdout: await readText(result.stdoutPath), stderr: await readText(result.stderrPath) };
}

/** The timeline's messages, without the timestamp each line starts with. */
function timelineMessages(text: string): string[] {
  return text
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^\S+ /, ''));
}

/**
 * Insists that the timeline holds the named steps in this order. A run that did the
 * right things in the wrong order is not the run these tests are about.
 */
function expectInOrder(messages: readonly string[], steps: readonly string[]): void {
  let from = 0;
  for (const step of steps) {
    const at = messages.findIndex((message, index) => index >= from && message.includes(step));
    expect(
      at,
      `the timeline never held "${step}" after step ${String(from)}:\n${messages.join('\n')}`,
    ).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

// ---------------------------------------------------------------------------
// The fixture: a real repository, a real run directory, and a stand-in agent
// ---------------------------------------------------------------------------

interface PidRecord {
  readonly pid: number;
  readonly child: number | null;
}

/** One event the runtime stand-in recorded, as the test reads it back. */
interface RuntimeEvent {
  readonly event: string;
  readonly at: number;
  readonly pid?: number;
  readonly child?: number | null;
  readonly files?: readonly string[];
}

/**
 * What one coding turn does. A plan is the whole of the substitute for a coding
 * agent: the files the runtime stand-in really writes into the clone, the summary
 * the turn reports back, and — where a test needs them — the hooks around them.
 */
interface Plan {
  /** Files the runtime writes into the working copy, relative to its root. */
  readonly edits?: readonly { readonly file: string; readonly text: string }[];
  /** Files the runtime deletes from the working copy. */
  readonly removes?: readonly string[];
  /** The turn's own account of what it did. A claim, and never check evidence. */
  readonly summary: string;
  /** How long the runtime keeps a child of its own alive while the turn works. */
  readonly holdMs?: number;
  /**
   * Called once the runtime is really running, with the PIDs it recorded. This is
   * where a test stops the run it started, so the stop arrives while the turn is
   * working rather than at a moment the test guessed.
   */
  readonly whenRunning?: (record: PidRecord) => void;
  /** Moves the run's clock this far forward before the turn returns. */
  readonly advanceClockMs?: number;
}

/** One coding turn the run asked for, as the test observed it. */
interface TurnRecord {
  readonly index: number;
  readonly request: AgentTurnRequest;
  readonly plan: Plan;
  readonly record: PidRecord;
  /** What the runtime recorded of the turn's work, in order. */
  readonly events: readonly RuntimeEvent[];
}

interface Target {
  /** Temporary directory holding the repository, the runs, and the programs. */
  readonly parent: string;
  /** The source repository: one commit, and a clean checkout of it. */
  readonly repo: string;
  /** Output directory for run directories, a sibling of the repository. */
  readonly workDir: string;
  /** The runtime stand-in a turn starts. */
  readonly runtime: string;
  /** Where a turn records its plan and its events; one file per turn. */
  readonly turnsDir: string;
  /** The task a run is asked to complete. */
  readonly task: Task;
}

async function writeSource(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }
}

/**
 * Creates the target project and commits its baseline, plus the programs the tests
 * themselves run. The repository really is a repository: the harness's own Git code
 * clones it and inspects the clone.
 */
async function createTarget(options: { readonly brokenBaseline?: boolean } = {}): Promise<Target> {
  const parent = await createTempDir();
  const repo = path.join(parent, 'tiny-target');
  await mkdir(repo, { recursive: true });

  await writeSource(repo, {
    '.gitattributes': '* -text\n',
    '.gitignore': 'build/\n',
    'README.md': [
      '# tiny-target',
      '',
      'A tiny deterministic project used to exercise the local loop offline.',
      'Its tests are run by tools/run-checks.mjs; tools/prepare.mjs is its setup step.',
      '',
    ].join('\n'),
    'src/greet.mjs': options.brokenBaseline === true ? BROKEN_GREET_SOURCE : GREET_SOURCE,
    'test/greet.test.mjs': GREET_TEST_SOURCE,
    'test/greet-all.test.mjs': GREET_ALL_TEST_SOURCE,
    'tools/prepare.mjs': PREPARE_SOURCE,
    'tools/run-checks.mjs': RUN_CHECKS_SOURCE,
  });
  await gitOrThrow(['init', '--quiet', '--initial-branch=main'], repo);
  await gitOrThrow(['add', '--all'], repo);
  await gitOrThrow(['commit', '--quiet', '--message', 'tiny-target: baseline'], repo);

  const workDir = path.join(parent, 'runs');
  await mkdir(workDir, { recursive: true });
  const turnsDir = path.join(parent, 'turns');
  await mkdir(turnsDir, { recursive: true });
  const runtime = path.join(parent, 'runtime-stand-in.mjs');
  await writeFile(runtime, RUNTIME_SOURCE, 'utf8');

  return {
    parent,
    repo,
    workDir,
    runtime,
    turnsDir,
    task: {
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
    },
  };
}

/** The configuration of these runs: the fixture's own tools, run as child processes. */
function configuration(target: Target, overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    workDir: target.workDir,
    maxRepairs: 2,
    taskTimeoutMinutes: 60,
    commandTimeoutMinutes: 10,
    setup: [[process.execPath, 'tools/prepare.mjs']],
    checks: [[process.execPath, 'tools/run-checks.mjs']],
    // The coding turn is a fixture in this suite; the selection is the
    // documented default, recorded by the runner and never started.
    agent: { runtime: 'codex', command: ['codex'] },
    ...overrides,
  };
}

/** The request one run is asked to complete. */
function request(target: Target, config: HarnessConfig, stop?: AbortSignal): RunTaskRequest {
  return {
    task: target.task,
    config,
    repoPath: target.repo,
    workDir: target.workDir,
    ...(stop === undefined ? {} : { stop }),
  };
}

/** The events a turn's runtime recorded, as JSON lines, read back from disk. */
async function readEvents(file: string): Promise<readonly RuntimeEvent[]> {
  if (!existsSync(file)) {
    return [];
  }
  const text = await readText(file);
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RuntimeEvent);
}

function pidRecord(event: RuntimeEvent): PidRecord {
  if (event.pid === undefined) {
    throw new Error(`the runtime recorded "${event.event}" without its own PID`);
  }
  return { pid: event.pid, child: event.child ?? null };
}

/**
 * How many times a test has built dependencies, so that the files one run's turns
 * record can never be read as another run's. A turn's plan and events are named
 * after both, and a run that is asked for a turn no plan covers fails the test that
 * did not plan for it.
 */
let fixtureRuns = 0;

/**
 * The run's dependencies: every one of them the harness's own implementation, so a
 * run really clones, really starts the configured commands, really writes its logs,
 * and really writes its report. Only `runAgentTurn` is a stand-in — and it is one
 * that starts a real child process to do the turn's work in the clone.
 */
function dependencies(
  target: Target,
  plans: readonly Plan[],
  clock: RunClock = systemClock(),
): { readonly deps: RunnerDependencies; readonly turns: TurnRecord[] } {
  const turns: TurnRecord[] = [];
  const tag = String((fixtureRuns += 1));
  let asked = 0;

  const deps: RunnerDependencies = {
    preflight: preflightSource,
    allocateRunDirectory,
    prepareWorkspace,
    recordWorkspaceAttempt,
    runCheckRound,
    appendRunLog,
    writeRunReport,
    now: clock.now,
    openAgentLog,
    runAgentTurn: async (turn: AgentTurnRequest): Promise<AgentTurnResult> => {
      const index = asked;
      asked += 1;
      const plan = plans[index];
      if (plan === undefined) {
        throw new Error(
          `the run asked for coding turn ${String(turn.turn)} and the test planned none`,
        );
      }

      const planFile = path.join(target.turnsDir, `run-${tag}-turn-${String(index + 1)}.plan.json`);
      const eventsFile = path.join(
        target.turnsDir,
        `run-${tag}-turn-${String(index + 1)}.events.jsonl`,
      );
      await rm(eventsFile, { force: true });
      await writeJsonFile(target.turnsDir, path.basename(planFile), {
        edits: plan.edits ?? [],
        removes: plan.removes ?? [],
        holdMs: plan.holdMs ?? 0,
      });

      const read = (event: string): Promise<RuntimeEvent> =>
        waitFor<RuntimeEvent>(
          async () => (await readEvents(eventsFile)).find((entry) => entry.event === event) ?? null,
          `the runtime stand-in of turn ${String(turn.turn)} to record "${event}"`,
          15_000,
        );

      turn.agentLog.write(
        `coding-agent stand-in: turn ${String(turn.turn)} (${turn.kind}) in ${turn.workspacePath}\n`,
      );
      const child = spawn(
        process.execPath,
        [target.runtime, '--turn', planFile, turn.workspacePath, eventsFile],
        {
          cwd: turn.workspacePath,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // A process group of its own on POSIX, as the harness starts a runtime:
          // a holding turn is stopped by killing that group, and a child left in
          // the test's own group could not be stopped by killing it.
          detached: process.platform !== 'win32',
        },
      );
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => turn.agentLog.write(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => turn.agentLog.write(`stderr: ${chunk}`));
      // Its end is awaited below, and the wait is set up here: a child that exits
      // while the turn is still reading its events would otherwise have emitted the
      // one event that says so before anything was listening for it.
      const exited = waitForExit(child, 45_000);
      void exited.catch(() => undefined);

      const started = pidRecord(await read('start'));
      registerFixture(started);
      turn.agentLog.write(
        `the runtime stand-in is pid ${String(started.pid)}` +
          (started.child === null ? '' : `, with child ${String(started.child)}`) +
          '\n',
      );
      plan.whenRunning?.(started);

      // The turn's work is really in the clone before the turn does anything else
      // about a stop: what a stopped run leaves behind is what it had written.
      const written = await read('edits-written');
      turn.agentLog.write(
        `the runtime stand-in wrote ${String(written.files?.length ?? 0)} entries\n`,
      );

      if ((plan.holdMs ?? 0) > 0) {
        // A turn that manages a child of its own: when the run is stopped, the turn
        // stops the tree it owns and waits for it to end before it returns.
        await stopRequested(turn.stop);
        turn.agentLog.write('the run was stopped; stopping the runtime this turn manages\n');
        stopOwnTree(started.pid);
        await expectTreeGone(started, 'the runtime this turn manages');
        const code = await exited;
        turn.agentLog.write(
          `the runtime and its child are gone (the runtime exited ${String(code)})\n`,
        );
      } else {
        const code = await exited;
        if (code !== 0) {
          throw new Error(
            `the runtime stand-in of turn ${String(turn.turn)} exited ${String(code)}`,
          );
        }
        turn.agentLog.write(`the runtime stand-in exited ${String(code)}\n`);
      }

      // The turn's own words go to the turn's own log, which is what the report
      // then points at: a claim kept where it was made, and never a result.
      turn.agentLog.write(`the turn reports: ${plan.summary}\n`);
      if (plan.advanceClockMs !== undefined) {
        clock.advance(plan.advanceClockMs);
      }
      turns.push({
        index,
        request: turn,
        plan,
        record: started,
        events: await readEvents(eventsFile),
      });
      return { summary: plan.summary };
    },
  };

  return { deps, turns };
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

/** The feature test's own words, as the run's check log holds them. */
const FEATURE_IMPLEMENTED = 'greet-all: ok';
const FEATURE_MISSING = 'greet-all: skipped';

/** The correct implementation of the feature, as a coding turn writes it. */
const GREET_ALL_SOURCE = [
  'export function greetAll(names) {',
  '  if (names.length === 0) {',
  "    return 'Hello, nobody!';",
  '  }',
  '  if (names.length === 1) {',
  '    return `Hello, ${names[0]}!`;',
  '  }',
  "  return `Hello, ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}!`;",
  '}',
  '',
].join('\n');

/** A wrong implementation: it greets everyone, but not the way the task asks. */
const WRONG_GREET_ALL_SOURCE = [
  'export function greetAll(names) {',
  "  return `Hello, ${names.join(', ')}!`;",
  '}',
  '',
].join('\n');

/**
 * An implementation that hangs the moment it is imported: a live handle and a
 * promise that never settles, so the project's own test of the feature never
 * finishes and the check that runs it really has to be stopped. The backstop means
 * nothing can be left behind even if a stop never reached it.
 */
const HANGING_GREET_ALL_SOURCE = [
  'setInterval(() => {}, 1000);',
  'await new Promise(() => {});',
  '',
  'setTimeout(() => process.exit(0), 60_000);',
  '',
  'export function greetAll(names) {',
  "  return `Hello, ${names.join(' and ')}!`;",
  '}',
  '',
].join('\n');

describe('the offline local loop, end to end', () => {
  it('passes a task whose implementation turn really implements it', async () => {
    const target = await createTarget();
    const before = await checkoutState(target.repo);
    const { deps, turns } = dependencies(target, [
      { edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }], summary: 'added greetAll' },
    ]);

    const result = await runTask(request(target, configuration(target)), deps);
    const report = await readReport(result);

    // The run's outcome, as the caller and the written report both state it.
    expect(result.status).toBe('passed');
    expect(report.status).toBe('passed');
    expect(report.runId).toBe(result.run.runId);
    expect(report.reason).toBe(result.reason);
    expect(report.reason).toContain('every configured check passed');
    expect(report.runLog).toBe(runLogPath(result.run.logsDir));
    expect(report.timeout).toBeNull();
    expect(report.cancellation).toBeNull();

    // The baseline was really run before any coding turn, and it was green.
    const baseline = report.baseline;
    if (baseline === null) {
      throw new Error('the report holds no baseline round, and this run must have one');
    }
    expect(baseline.outcome).toBe('passed');
    expect(baseline.problem).toBeNull();
    expect(baseline.setup).toHaveLength(1);
    expect(baseline.checks).toHaveLength(1);
    expect(first(baseline.setup, 'the baseline setup').outcome).toBe('exited');
    expect(first(baseline.checks, 'the baseline check').exitCode).toBe(0);
    expect((await commandOutput(first(baseline.checks, 'the baseline check'))).stdout).toContain(
      FEATURE_MISSING,
    );

    // Exactly one coding turn, and a complete green round observed after it.
    expect(report.repairsUsed).toBe(0);
    expect(report.attempts).toHaveLength(1);
    const attempt = first(report.attempts, 'the implementation attempt');
    expect(attempt.turn).toBe(1);
    expect(attempt.kind).toBe('implementation');
    expect(attempt.agentSummary).toBe('added greetAll');
    expect(attempt.agentLog).toBe(agentLogPath(result.run.logsDir, 1));
    const round = observed(attempt, 'the implementation attempt');
    expect(round.outcome).toBe('passed');
    expect(round.problem).toBeNull();
    expect(round.setup).toHaveLength(1);
    expect(round.checks).toHaveLength(1);
    const check = first(round.checks, 'the post-agent check');
    expect(check.outcome).toBe('exited');
    expect(check.exitCode).toBe(0);
    expect(check.termination).toBeNull();

    // The check really executed the implementation: its own log shows the feature
    // test running and passing in the retained clone, not skipping and not absent.
    const output = await commandOutput(check);
    expect(output.stdout).toContain(FEATURE_IMPLEMENTED);
    expect(output.stdout).toContain('run-checks: 2 of 2 test files passed');
    expect(output.stdout).not.toContain('FAILED');

    // The turn's own log is a file the run left behind, not a copy in the report.
    const agentLog = await readText(attempt.agentLog);
    expect(agentLog).toContain('coding-agent stand-in');
    expect(agentLog).toContain('the runtime stand-in wrote 1 entries');

    // What the run left in its working copy.
    const workspace = prepared(result);
    expect(workspace.baseCommit).toBe(before.head);
    expect(await readText(path.join(workspace.workspacePath, 'src', 'greet-all.mjs'))).toBe(
      GREET_ALL_SOURCE,
    );
    expect(report.changes).toEqual(result.changes);
    expect(report.changes.inspected).toBe(true);
    expect(report.changes.problem).toBeNull();
    expect(report.changes.baseCommit).toBe(before.head);
    expect(report.changes.paths.map((entry) => entry.path)).toContain('src/greet-all.mjs');
    expect(report.changes.paths.find((entry) => entry.path === 'src/greet-all.mjs')?.kind).toBe(
      'added',
    );
    // The setup step's own artifact is ignored, so it is not a change of this run.
    expect(report.changes.paths.map((entry) => entry.path)).not.toContain('build/prepared.json');
    expect(report.changes.warnings.checks).toContain(
      '`passed` means the configured post-agent checks',
    );
    expect(report.changes.warnings.highlighted).toBeNull();

    // The timeline reads as the loop ran, in order.
    const messages = timelineMessages(await readText(report.runLog));
    expectInOrder(messages, [
      `run ${result.run.runId} started: task "greet-all"`,
      'task deadline set for',
      'workspace prepared at',
      'baseline check-round started',
      'baseline check-round result: passed',
      'implementation turn started',
      'implementation turn result: completed',
      'post-agent check-round started',
      'post-agent check-round result: passed',
      'changed path: src/greet-all.mjs (added, untracked)',
      `final status: passed, ${result.reason}`,
    ]);

    // The source checkout the run started from is untouched, and holds no trace of
    // the change the run made in its own clone.
    expect(await checkoutState(target.repo)).toEqual(before);
    expect(existsSync(path.join(target.repo, 'src', 'greet-all.mjs'))).toBe(false);
    expect(turns).toHaveLength(1);
  }, 120_000);

  it('repairs a failed implementation, and tells the repair what was observed', async () => {
    const target = await createTarget();
    const { deps, turns } = dependencies(target, [
      {
        edits: [{ file: 'src/greet-all.mjs', text: WRONG_GREET_ALL_SOURCE }],
        summary: 'added greetAll and it looks right to me',
      },
      {
        edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }],
        summary: 'fixed the separator and the empty case',
      },
    ]);

    const result = await runTask(request(target, configuration(target)), deps);
    const report = await readReport(result);

    expect(result.status).toBe('passed');
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts).toHaveLength(2);
    expect(report.reason).toContain('every configured check passed after repair turn 2');
    expect(report.reason).toContain('(1 of 2 repair turns used)');

    // The first attempt is still in the report, red, with its own log beside it.
    const implementation = first(report.attempts, 'the implementation attempt');
    const red = observed(implementation, 'the implementation attempt');
    expect(implementation.kind).toBe('implementation');
    expect(red.outcome).toBe('failed');
    const failedCheck = first(red.checks, 'the failed check');
    expect(failedCheck.exitCode).toBe(1);
    const failure = await commandOutput(failedCheck);
    expect(failure.stdout).toContain('FAILED greet-all.test.mjs (exit code 1)');
    expect(failure.stderr).toContain('AssertionError');

    // What the repair turn was told: the failures the harness observed, and where
    // their output lives.
    expect(turns).toHaveLength(2);
    const feedback = first(turns, 'the implementation turn').request.repair;
    expect(feedback).toBeNull();
    const told = first(turns.slice(1), 'the repair turn').request.repair;
    if (told === null) {
      throw new Error('the repair turn was given no feedback about the round it repairs');
    }
    expect(told.repairedTurn).toBe(1);
    expect(told.failures).toHaveLength(1);
    const toldFailure = first(told.failures, 'the failure the repair turn was told about');
    expect(toldFailure.result.outcome).toBe('exited');
    expect(toldFailure.result.exitCode).toBe(1);
    expect(toldFailure.result.command).toEqual([process.execPath, 'tools/run-checks.mjs']);
    expect(toldFailure.result.stdoutPath).toBe(failedCheck.stdoutPath);
    expect(toldFailure.output).toContain('AssertionError');
    expect(toldFailure.output).toContain('FAILED greet-all.test.mjs (exit code 1)');

    // The repair turn really changed the clone, and the retained file is its work.
    const repaired = first(report.attempts.slice(1), 'the repair attempt');
    expect(repaired.kind).toBe('repair');
    expect(repaired.turn).toBe(2);
    expect(observed(repaired, 'the repair attempt').outcome).toBe('passed');
    expect(await readText(path.join(prepared(result).workspacePath, 'src', 'greet-all.mjs'))).toBe(
      GREET_ALL_SOURCE,
    );

    // Both turns' logs are still readable, and each holds what that turn did.
    const logs = [implementation.agentLog, repaired.agentLog];
    expect(logs[0]).toBe(agentLogPath(result.run.logsDir, 1));
    expect(logs[1]).toBe(agentLogPath(result.run.logsDir, 2));
    const [firstLog, secondLog] = await Promise.all(logs.map((file) => readText(file)));
    expect(firstLog).toContain('turn 1 (implementation)');
    expect(secondLog ?? '').toContain('turn 2 (repair)');
    expect(secondLog ?? '').toContain('the runtime stand-in wrote 1 entries');

    // The timeline records the repair as a turn of its own, after the red round.
    expectInOrder(timelineMessages(await readText(report.runLog)), [
      'baseline check-round result: passed',
      'implementation turn result: completed',
      'post-agent check-round result: failed, 0 of 1 check passed',
      'repair turn 2 started: repair 1 of 2 allowed',
      'repair turn 2 result: completed',
      'post-agent check-round result: passed',
      'final status: passed, every configured check passed after repair turn 2',
    ]);
  }, 120_000);

  it('spends the exact repair allowance and reports the last round red', async () => {
    const target = await createTarget();
    const { deps, turns } = dependencies(target, [
      {
        edits: [{ file: 'src/greet-all.mjs', text: WRONG_GREET_ALL_SOURCE }],
        summary: 'implemented greetAll',
      },
      {
        edits: [{ file: 'src/greet-all.mjs', text: WRONG_GREET_ALL_SOURCE.replace('Ada', 'name') }],
        summary: 'reworked the greeting',
      },
      // The last repair turn does nothing at all, and still claims success: agent
      // text is kept, and the checks the harness runs are what decide the run.
      { summary: 'nothing further to change: every configured check passes' },
    ]);

    const result = await runTask(request(target, configuration(target)), deps);
    const report = await readReport(result);

    expect(result.status).toBe('failed');
    expect(report.repairsUsed).toBe(2);
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual([
      'implementation',
      'repair',
      'repair',
    ]);
    expect(report.attempts.map((attempt) => observed(attempt, 'an attempt').outcome)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(report.reason).toContain('the repair allowance is exhausted (2 of 2 repair turns used)');
    expect(report.reason).toContain('1 of 1 check did not pass');

    // Three turns were spent, and no fourth was started.
    expect(turns).toHaveLength(3);
    const last = first(report.attempts.slice(2), 'the last repair attempt');
    expect(last.agentSummary).toBe('nothing further to change: every configured check passes');
    const lastRound = observed(last, 'the last repair attempt');

    // The last turn wrote nothing, so the failing implementation of the turn before
    // it is still what the clone holds and still what the checks see.
    expect(
      first(turns.slice(2), 'the no-op turn').events.find(
        (entry) => entry.event === 'edits-written',
      )?.files,
    ).toEqual([]);
    expect(await readText(path.join(prepared(result).workspacePath, 'src', 'greet-all.mjs'))).toBe(
      WRONG_GREET_ALL_SOURCE.replace('Ada', 'name'),
    );
    const lastFailure = await commandOutput(first(lastRound.checks, 'the last check'));
    expect(lastFailure.stdout).toContain('FAILED greet-all.test.mjs (exit code 1)');
    expect(lastFailure.stderr).toContain('AssertionError');

    // The run's own log and directory hold three post-agent rounds and no more.
    const messages = timelineMessages(await readText(report.runLog));
    expectInOrder(messages, [
      'repair turn 2 started: repair 1 of 2 allowed',
      'repair turn 3 started: repair 2 of 2 allowed',
      'post-agent check-round result: failed, 0 of 1 check passed',
      'repair allowance exhausted: 2 of 2 repair turns used',
      'final status: failed,',
    ]);
    expect(messages.filter((message) => message.includes('repair turn 4'))).toEqual([]);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-4-check-1.stdout.log'))).toBe(false);
    expect(existsSync(agentLogPath(result.run.logsDir, 4))).toBe(false);
    expect(existsSync(agentLogPath(result.run.logsDir, 3))).toBe(true);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-3-check-1.stdout.log'))).toBe(true);
  }, 120_000);

  it('does not let a coding turn that claims success turn a failing check into a pass', async () => {
    const target = await createTarget();
    const claim = 'done: every configured check passes now';
    const { deps, turns } = dependencies(target, [
      { edits: [{ file: 'src/greet-all.mjs', text: WRONG_GREET_ALL_SOURCE }], summary: claim },
    ]);

    const result = await runTask(request(target, configuration(target, { maxRepairs: 0 })), deps);
    const report = await readReport(result);

    // The claim is kept exactly as the turn made it, in the report and in the turn's
    // own log — and it is not what the run reports.
    expect(result.status).toBe('failed');
    expect(report.status).toBe('failed');
    expect(report.reason).not.toContain(claim);
    expect(report.reason).toContain('did not pass');
    const attempt = first(report.attempts, 'the implementation attempt');
    expect(attempt.agentSummary).toBe(claim);
    expect(await readText(attempt.agentLog)).toContain(claim);

    // The evidence beside the claim is the failing check the harness ran itself.
    const round = observed(attempt, 'the implementation attempt');
    expect(round.outcome).toBe('failed');
    const failed = first(round.checks, 'the failing check');
    expect(failed.exitCode).toBe(1);
    const output = await commandOutput(failed);
    expect(output.stdout).toContain('FAILED greet-all.test.mjs (exit code 1)');
    expect(output.stderr).toContain('AssertionError');
    // The allowance was zero, so the lie bought no repair turn either.
    expect(turns).toHaveLength(1);
    expect(report.repairsUsed).toBe(0);
    expect(report.reason).toContain('(0 of 0 repair turns used)');
  }, 120_000);

  it('stops before any coding turn when the committed baseline is red', async () => {
    const target = await createTarget({ brokenBaseline: true });
    const before = await checkoutState(target.repo);
    const { deps, turns } = dependencies(target, [
      { edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }], summary: 'added greetAll' },
    ]);

    const result = await runTask(request(target, configuration(target)), deps);
    const report = await readReport(result);

    expect(result.status).toBe('failed');
    expect(report.reason).toBe('the baseline checks did not pass, so no coding turn was started');
    const baseline = report.baseline;
    if (baseline === null) {
      throw new Error('the report holds no baseline round, and this run must have one');
    }
    expect(baseline.outcome).toBe('failed');
    const failed = first(baseline.checks, 'the failing baseline check');
    expect(failed.exitCode).toBe(1);
    const output = await commandOutput(failed);
    expect(output.stdout).toContain('FAILED greet.test.mjs (exit code 1)');
    expect(output.stderr).toContain('AssertionError');

    // No coding turn was started, and none left anything behind.
    expect(turns).toHaveLength(0);
    expect(report.attempts).toEqual([]);
    expect(report.repairsUsed).toBe(0);
    expect(existsSync(agentLogPath(result.run.logsDir, 1))).toBe(false);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-1-check-1.stdout.log'))).toBe(false);

    // The clone is exactly as the run found it: nothing of the run's own work, and
    // the setup step's ignored artifact is not a change of the run.
    const workspace = prepared(result);
    expect(workspace.baseCommit).toBe(before.head);
    const clone = await checkoutState(workspace.workspacePath);
    expect(clone.head).toBe(before.head);
    expect(clone.status).toBe('');
    expect(await readText(path.join(workspace.workspacePath, 'src', 'greet.mjs'))).toBe(
      BROKEN_GREET_SOURCE,
    );
    expect(existsSync(path.join(workspace.workspacePath, 'build', 'prepared.json'))).toBe(true);
    expect(report.changes.inspected).toBe(true);
    expect(report.changes.paths).toEqual([]);

    expectInOrder(timelineMessages(await readText(report.runLog)), [
      'baseline check-round result: failed, 0 of 1 check passed',
      `final status: failed, ${result.reason}`,
    ]);
    expect(await checkoutState(target.repo)).toEqual(before);
  }, 120_000);

  it('ends the run without a repair when a setup command fails after a turn', async () => {
    const target = await createTarget();
    const { deps, turns } = dependencies(target, [
      {
        edits: [
          { file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE },
          // The turn breaks the project's setup step on its way past it. The check
          // that would have decided the run is never reached.
          { file: 'tools/prepare.mjs', text: 'this is not JavaScript at all\n' },
        ],
        summary: 'implemented greetAll and tidied the tools up',
      },
    ]);

    const result = await runTask(request(target, configuration(target)), deps);
    const report = await readReport(result);

    expect(result.status).toBe('failed');
    expect(report.reason).toContain('could not be executed');
    expect(report.attempts).toHaveLength(1);
    const round = observed(first(report.attempts, 'the implementation attempt'), 'the turn');
    expect(round.outcome).toBe('execution-error');
    const setup = first(round.setup, 'the setup command of the round');
    expect(setup.outcome).toBe('exited');
    expect(setup.exitCode).toBe(1);
    expect(round.problem).toContain('setup command 1');
    expect(round.problem).toContain('A setup problem is not a failed check to repair');
    expect((await commandOutput(setup)).stderr).toContain('SyntaxError');

    // The check after the failing setup has no result at all, and never ran.
    expect(round.checks).toEqual([]);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-1-check-1.stdout.log'))).toBe(false);

    // A setup failure costs no repair turn: it is not a failed check to code around.
    expect(turns).toHaveLength(1);
    expect(report.repairsUsed).toBe(0);
    expect(existsSync(agentLogPath(result.run.logsDir, 2))).toBe(false);
    const messages = timelineMessages(await readText(report.runLog));
    expect(messages.filter((message) => message.includes('repair turn'))).toEqual([]);
    expectInOrder(messages, [
      'post-agent check-round result: execution-error, setup command 1',
      'final status: failed,',
    ]);

    // What the turn left is still reported: the harness's categories are read from
    // path names, and a `tools/` directory is not one of the names it flags.
    expect(report.changes.inspected).toBe(true);
    expect(report.changes.paths.map((entry) => entry.path)).toEqual([
      'src/greet-all.mjs',
      'tools/prepare.mjs',
    ]);
    expect(
      report.changes.paths.find((entry) => entry.path === 'tools/prepare.mjs')?.categories,
    ).toEqual([]);
    expect(report.changes.warnings.highlighted).toBeNull();
  }, 120_000);

  it('ends the baseline with no coding turn when a check cannot be launched', async () => {
    const target = await createTarget();
    const missing = path.join(target.parent, 'missing-check-tool.exe');
    const { deps, turns } = dependencies(target, [
      { edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }], summary: 'added greetAll' },
    ]);

    const result = await runTask(
      request(target, configuration(target, { checks: [[missing]] })),
      deps,
    );
    const report = await readReport(result);

    expect(result.status).toBe('failed');
    expect(report.reason).toContain('the baseline could not be executed');
    const baseline = report.baseline;
    if (baseline === null) {
      throw new Error('the report holds no baseline round, and this run must have one');
    }
    expect(baseline.outcome).toBe('execution-error');
    expect(first(baseline.setup, 'the baseline setup').exitCode).toBe(0);
    const check = first(baseline.checks, 'the check that could not be launched');
    expect(check.outcome).toBe('failed-to-launch');
    expect(check.exitCode).toBeNull();
    expect(check.launchError).toContain('missing-check-tool.exe');
    expect(baseline.problem).toContain('could not be started');

    // A command that could not be executed is not a red check: no turn was asked
    // for, and no repair either.
    expect(turns).toHaveLength(0);
    expect(report.attempts).toEqual([]);
    expect(existsSync(agentLogPath(result.run.logsDir, 1))).toBe(false);

    // The run directory, the working copy, and the report are all still there.
    expect(report.workspace.prepared).toBe(true);
    expect(report.changes.inspected).toBe(true);
    expect(report.changes.paths).toEqual([]);
    expect(report.timeout).toBeNull();
    expect(report.cancellation).toBeNull();
    expect(existsSync(result.reportPath)).toBe(true);
  }, 120_000);

  it("stops a real hanging check when the run's own deadline expires", async () => {
    const target = await createTarget();
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = controlledClock(start);
    const { deps, turns } = dependencies(
      target,
      [
        {
          // The turn implements the feature and the implementation hangs the moment
          // the project's own test imports it, so the check that runs that test
          // really has to be stopped. The clock moves as the turn returns: 56 of the
          // run's 60 seconds are spent, and the check that follows runs under the
          // 4 seconds that are left.
          edits: [{ file: 'src/greet-all.mjs', text: HANGING_GREET_ALL_SOURCE }],
          summary: 'implemented greetAll, it never returns but that is fine',
          advanceClockMs: 56_000,
        },
      ],
      clock,
    );

    const result = await runTask(
      request(target, configuration(target, { maxRepairs: 0, taskTimeoutMinutes: 1 })),
      deps,
    );
    const report = await readReport(result);

    expect(result.status).toBe('failed');
    // The limit that expired is the run's own, not a configured command limit, and
    // the run says so with the time it had left when it stopped the command.
    const timeout = report.timeout;
    if (timeout === null) {
      throw new Error('the report holds no timeout evidence, and this run must have one');
    }
    expect(timeout).toEqual(result.timeout);
    expect(timeout.limit).toBe('task');
    expect(timeout.limitMs).toBe(4000);
    expect(timeout.elapsedMs).toBe(56_000);
    expect(timeout.phase).toBe('the checks after the implementation turn');
    expect(timeout.termination).toBe('confirmed');
    expect(timeout.problem).toBeNull();
    expect(report.cancellation).toBeNull();
    expect(report.reason).toContain(
      "the run's task deadline expired during the checks after the implementation turn",
    );

    // The check that hung is recorded as stopped at that limit, not as a red check.
    expect(report.attempts).toHaveLength(1);
    const round = observed(first(report.attempts, 'the implementation attempt'), 'the turn');
    expect(round.outcome).toBe('execution-error');
    const check = first(round.checks, 'the hanging check');
    expect(check.outcome).toBe('timed-out');
    expect(check.timeoutMs).toBe(4000);
    expect(check.termination).toBe('confirmed');
    expect(check.terminationProblem).toBeNull();
    expect(round.problem).toContain('the 4000 ms of task time that was left expired');
    expect(round.problem).toContain('the invocation and the process tree it started were stopped');
    expect(round.problem).toContain('An expired limit is not a failed check to repair');

    // The hanging test process is really gone, read back from the run's own log of
    // what that check started.
    const output = await commandOutput(check);
    expect(output.stdout).toContain('running greet-all.test.mjs (pid ');
    const [, pid] = /running greet-all\.test\.mjs \(pid (\d+)\)/.exec(output.stdout) ?? [];
    if (pid === undefined) {
      throw new Error(`the check log holds no test PID:\n${output.stdout}`);
    }
    registerFixture({ pid: Number(pid), child: null });
    await expectGone(Number(pid), 'the hanging test process the harness stopped');

    // No repair turn followed the expired limit, and no round was started after it.
    expect(turns).toHaveLength(1);
    expect(report.repairsUsed).toBe(0);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-2-check-1.stdout.log'))).toBe(false);
    expectInOrder(timelineMessages(await readText(report.runLog)), [
      'implementation turn result: completed',
      `timeout: the run's task deadline (4000 ms) expired during the checks after the implementation turn`,
      'final status: failed,',
    ]);

    // The clock the run was given is the clock its report is written in, and what
    // the turn left in the clone is still reported.
    expect(report.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(report.endedAt).toBe('2026-01-01T00:00:56.000Z');
    expect(report.changes.inspected).toBe(true);
    expect(report.changes.paths.map((entry) => entry.path)).toContain('src/greet-all.mjs');
  }, 120_000);

  it('stops the tree a cancelled turn manages, and keeps what it had written', async () => {
    const target = await createTarget();
    const controller = new AbortController();
    const stopped: PidRecord[] = [];
    const { deps, turns } = dependencies(target, [
      {
        edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }],
        // The turn is still working, with a child of its own, when the test stops
        // the run: the stop arrives at the turn's own signal, and the turn stops the
        // tree it owns before it returns.
        holdMs: 30_000,
        summary: 'the turn was stopped while it was still working',
        whenRunning: (record) => {
          stopped.push(record);
          controller.abort();
        },
      },
    ]);

    const result = await runTask(request(target, configuration(target), controller.signal), deps);
    const report = await readReport(result);

    expect(result.status).toBe('cancelled');
    expect(report.status).toBe('cancelled');
    expect(report.timeout).toBeNull();
    const cancellation = report.cancellation;
    if (cancellation === null) {
      throw new Error('the report holds no cancellation evidence, and this run must have one');
    }
    expect(cancellation).toEqual(result.cancellation);
    expect(cancellation.phase).toBe('implementation turn');
    expect(cancellation.termination).toBe('confirmed');
    expect(cancellation.problem).toBeNull();
    expect(report.reason).toContain('was stopped because the run was stopped by its caller');
    expect(report.reason).toContain('no check was run after it');

    // The turn is in the report, with no round observed after it: the run was
    // stopped, and a stopped run invents no check and no repair.
    expect(report.attempts).toHaveLength(1);
    const attempt = first(report.attempts, 'the implementation attempt');
    expect(attempt.kind).toBe('implementation');
    expect(attempt.checks).toBeNull();
    expect(attempt.agentSummary).toBe('the turn was stopped while it was still working');
    expect(report.repairsUsed).toBe(0);
    expect(turns).toHaveLength(1);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-1-check-1.stdout.log'))).toBe(false);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-1-setup-1.stdout.log'))).toBe(false);

    // The turn's own log holds what it did before it stopped — including the work it
    // finished after the stop arrived, which is the evidence the stop was really
    // delivered to the turn rather than the run being abandoned.
    const log = await readText(attempt.agentLog);
    expect(log).toContain('coding-agent stand-in');
    expect(log).toContain('the run was stopped; stopping the runtime this turn manages');
    expect(log).toContain('the runtime and its child are gone');
    expect(log).toContain('the runtime stand-in wrote 1 entries');

    // The stop was confirmed in the only way that matters: nothing of the turn's own
    // is still running, and the file it had written is still in the clone.
    await expectTreeGone(first(stopped, 'the runtime the cancelled turn managed'), 'the runtime');
    expect(report.changes.inspected).toBe(true);
    expect(report.changes.paths.map((entry) => entry.path)).toContain('src/greet-all.mjs');
    expect(await readText(path.join(prepared(result).workspacePath, 'src', 'greet-all.mjs'))).toBe(
      GREET_ALL_SOURCE,
    );

    expectInOrder(timelineMessages(await readText(report.runLog)), [
      'implementation turn started',
      'implementation turn result: completed',
      'cancelled: the run was stopped by its caller during implementation turn',
      'final status: cancelled,',
    ]);
  }, 120_000);

  it('gives two runs of one task separate directories and separate clones', async () => {
    const target = await createTarget();
    const plan: Plan = {
      edits: [{ file: 'src/greet-all.mjs', text: GREET_ALL_SOURCE }],
      summary: 'added greetAll',
    };
    const config = configuration(target);

    const firstRun = dependencies(target, [plan]);
    const one = await runTask(request(target, config), firstRun.deps);
    const secondRun = dependencies(target, [plan]);
    const two = await runTask(request(target, config), secondRun.deps);

    // Two runs, two run directories, two run IDs, two branches.
    expect(two.run.runId).not.toBe(one.run.runId);
    expect(two.run.runDir).not.toBe(one.run.runDir);
    expect(existsSync(one.run.runDir)).toBe(true);
    expect(existsSync(two.run.runDir)).toBe(true);
    const oneReport = await readReport(one);
    const twoReport = await readReport(two);
    expect(oneReport.runId).toBe(one.run.runId);
    expect(twoReport.runId).toBe(two.run.runId);
    expect(oneReport.status).toBe('passed');
    expect(twoReport.status).toBe('passed');

    // The first run's own records are still there, unharmed, after the second ended.
    expect(existsSync(one.reportPath)).toBe(true);
    expect(existsSync(runLogPath(one.run.logsDir))).toBe(true);
    expect(existsSync(runLogPath(two.run.logsDir))).toBe(true);
    expect(runLogPath(one.run.logsDir)).not.toBe(runLogPath(two.run.logsDir));

    // Two working copies, from one base commit, on two different branches.
    const firstWorkspace = prepared(one);
    const secondWorkspace = prepared(two);
    expect(firstWorkspace.workspacePath).not.toBe(secondWorkspace.workspacePath);
    expect(firstWorkspace.baseCommit).toBe(secondWorkspace.baseCommit);
    expect(firstWorkspace.branch).toBe(`harness/${one.run.runId}`);
    expect(secondWorkspace.branch).toBe(`harness/${two.run.runId}`);
    expect(await checkoutState(firstWorkspace.workspacePath)).toEqual({
      head: firstWorkspace.baseCommit,
      status: '?? src/greet-all.mjs',
    });
    expect(await checkoutState(secondWorkspace.workspacePath)).toEqual({
      head: secondWorkspace.baseCommit,
      status: '?? src/greet-all.mjs',
    });

    // The second run cloned the source again rather than reusing the first run's
    // working copy: its own baseline observed the feature missing, and its own
    // post-agent round then observed it implemented.
    const secondBaseline = twoReport.baseline;
    if (secondBaseline === null) {
      throw new Error('the report holds no baseline round, and this run must have one');
    }
    const secondBaselineCheck = first(
      secondBaseline.checks,
      'the baseline check of the second run',
    );
    expect((await commandOutput(secondBaselineCheck)).stdout).toContain(FEATURE_MISSING);
    const secondRound = observed(
      first(twoReport.attempts, 'the attempt of the second run'),
      'the attempt of the second run',
    );
    const secondPostAgentCheck = first(
      secondRound.checks,
      'the post-agent check of the second run',
    );
    expect((await commandOutput(secondPostAgentCheck)).stdout).toContain(FEATURE_IMPLEMENTED);

    // Both runs left their own work in their own clone.
    expect(await readText(path.join(firstWorkspace.workspacePath, 'src', 'greet-all.mjs'))).toBe(
      GREET_ALL_SOURCE,
    );
    expect(await readText(path.join(secondWorkspace.workspacePath, 'src', 'greet-all.mjs'))).toBe(
      GREET_ALL_SOURCE,
    );
    expect(firstRun.turns).toHaveLength(1);
    expect(secondRun.turns).toHaveLength(1);
  }, 120_000);
});
