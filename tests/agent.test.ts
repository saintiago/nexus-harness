/**
 * Coding-runtime adapter tests: one turn through the Codex CLI, against a fake
 * runtime process.
 *
 * The boundary these tests fake is the runtime process itself — a stand-in
 * executable that speaks the documented `codex exec --json` interface, started by
 * the adapter exactly as the real one is started, in temporary directories, with
 * no network and no credentials. What it received (its arguments, its working
 * directory, its prompt on standard input, whether a key was in its environment)
 * is recorded by the stand-in itself, so these tests assert what the operating
 * system delivered rather than what the adapter intended to send. On Windows the
 * stand-in is a `.cmd` shim, because that is what an installed `codex` is there.
 *
 * The last section runs the real runner, the real checks, and the real adapter
 * together, so what a runtime reports is seen beside what the harness observed
 * rather than in place of it. A stand-in runtime proves the harness's side of the
 * contract, and says nothing about how the real CLI behaves: no live call is made
 * here, and none of this is evidence about a real account or a real model. See
 * README.md, "Coding runtime", and docs/tasks.md T12/T16.
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentError, runCodexTurn } from '../src/agents/codex/adapter.js';
import { CODEX_EXECUTABLE, codexRuntime } from '../src/agents/codex/runtime.js';
import type { CodexRuntime } from '../src/agents/codex/runtime.js';
import { runCheckRound } from '../src/checks/round.js';
import { requestTreeStop } from '../src/process/stop.js';
import { appendRunLog, openAgentLog } from '../src/reporting/logs.js';
import { writeRunReport } from '../src/reporting/report.js';
import { runTask } from '../src/runs/runner.js';
import type { AgentTurnRequest, RunnerDependencies } from '../src/runs/contracts.js';
import type { CommandResult, HarnessConfig, RunReport, Task } from '../src/shared/types.js';
import { configureWorkspaceIdentity } from '../src/workspace/git.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import { recordWorkspaceAttempt } from '../src/workspace/state.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

/**
 * The stand-in runtime processes this file has started, by the PID a stand-in
 * recorded for itself, and the release file that asks each of them to end. A
 * test that leaves one running (because stopping it is what the test is about)
 * registers it here, so a failed test cannot leave it behind.
 */
const standInProcesses = new Map<number, string>();

/** The file whose appearance asks this fixture's stand-in runtimes to end. */
function releasePathFor(fixture: Fixture): string {
  return path.join(fixture.parent, 'release');
}

/** Whether the process with this PID is still there, as the host reports it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits, bounded, for a PID to be gone, and says whether it is. */
async function waitUntilGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * Every stand-in runtime still running is asked to end by itself, and waited
 * for, before the temporary directories are removed: a process that still holds
 * its working directory open would keep the directory from being removed, and
 * would outlive the test that started it.
 *
 * A recorded PID is released rather than stopped, and a stop is only the last
 * resort for one that did not answer. The operating system hands PID numbers
 * out again once they are free, and by this point in a run many of them are
 * already dead — a stand-in the harness itself stopped, or one that ended by
 * itself — so stopping them again would risk ending whatever process holds the
 * number now, in this file or in another suite running beside it.
 */
afterEach(async () => {
  const registered = [...standInProcesses];
  standInProcesses.clear();

  for (const [, release] of registered) {
    try {
      await writeFile(release, 'release\n', 'utf8');
    } catch {
      // The fixture's own directory is gone already: there is nothing left to
      // release, and the waits below decide what is still running.
    }
  }

  for (const [pid] of registered) {
    if (await waitUntilGone(pid, 5_000)) {
      continue;
    }
    await requestTreeStop(pid);
    await waitUntilGone(pid);
  }
  await cleanupTempDirectories();
});

/**
 * A private Git environment for the fixtures: the developer's own hooks, signing,
 * ignore rules, and identity must not change what these tests observe.
 */
let fixtureEnvironment: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  const directory = await createTempDir();
  const emptyConfig = path.join(directory, 'empty.gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  fixtureEnvironment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: 'Harness Test',
    GIT_AUTHOR_EMAIL: 'harness@example.test',
    GIT_COMMITTER_NAME: 'Harness Test',
    GIT_COMMITTER_EMAIL: 'harness@example.test',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
});

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Runs `git` with literal arguments in the fixture environment. */
function git(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return runProcess('git', args, { cwd, env: fixtureEnvironment });
}

/** Runs `git` and fails the test when it does not succeed. */
async function gitOrFail(args: readonly string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** What the stand-in runtime is told to do, through its own environment. */
interface StandInConfig {
  /** `ok` completes; the others are the ways a real runtime does not. */
  readonly mode?: 'ok' | 'fail' | 'auth' | 'malformed' | 'contradictory' | 'incomplete';
  /** The final message, or the failure's own words for the failing modes. */
  readonly summary?: string;
  /** A file the stand-in writes in its working copy, standing in for its work. */
  readonly file?: string;
  /** What it writes there. */
  readonly text?: string;
  /** Whether that write replaces the file or appends to it. */
  readonly write?: 'append' | 'replace';
  /** How long it stays alive after reporting, in milliseconds. */
  readonly holdMs?: number;
  /** The session it reports having opened. */
  readonly session?: string;
}

/**
 * The stand-in runtime: a real child process that speaks the documented event
 * interface, records everything it was given, and then does what its own
 * configuration says. It contacts nothing: the only writes it makes are its
 * records, its event stream, and the working copy it was pointed at. It ends by
 * setting an exit code rather than exiting outright, so nothing it wrote is lost
 * on the way out.
 */
const STAND_IN_SOURCE = [
  "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  '',
  "const config = JSON.parse(process.env.FAKE_CODEX ?? '{}');",
  'const record = (event, extra = {}) =>',
  "  appendFileSync(config.events, `${JSON.stringify({ event, ...extra })}\\n`, 'utf8');",
  'const event = (one) => process.stdout.write(`${JSON.stringify(one)}\\n`);',
  '',
  "let prompt = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  '  prompt += chunk;',
  '});',
  '',
  "process.stdin.on('end', () => {",
  "  record('start', {",
  '    pid: process.pid,',
  '    cwd: process.cwd(),',
  '    argv: process.argv.slice(2),',
  "    key: process.env.CODEX_API_KEY ? 'present' : 'absent',",
  '    prompt,',
  '  });',
  '',
  '  if (config.file) {',
  '    writeFileSync(',
  '      path.join(process.cwd(), config.file),',
  "      config.text ?? '',",
  "      config.write === 'replace' ? {} : { flag: 'a' },",
  '    );',
  '  }',
  '',
  "  event({ type: 'thread.started', thread_id: config.session ?? 'session-1' });",
  "  event({ type: 'turn.started' });",
  '  process.stderr.write(`progress: working in ${process.cwd()}\\n`);',
  '',
  '  const holdMs = Number(config.holdMs ?? 0);',
  '  if (holdMs > 0) {',
  '    // A runtime that takes its time: it reports a message, keeps working, and',
  '    // ends when its own timer says so, when the test that started it asks it to',
  '    // end, or when something stops it first.',
  '    event({',
  "      type: 'item.completed',",
  "      item: { id: 'item-1', type: 'agent_message', text: config.summary ?? 'still working' },",
  '    });',
  '    const until = Date.now() + holdMs;',
  '    const finish = () => {',
  "      record('end');",
  "      event({ type: 'turn.completed', usage: {} });",
  '      process.exitCode = 0;',
  '    };',
  '    const waiting = setInterval(() => {',
  '      if (Date.now() >= until || (config.release && existsSync(config.release))) {',
  '        clearInterval(waiting);',
  '        finish();',
  '      }',
  '    }, 25);',
  '    return;',
  '  }',
  '',
  "  const mode = config.mode ?? 'ok';",
  "  if (mode === 'ok') {",
  '    event({',
  "      type: 'item.started',",
  "      item: { id: 'item-1', type: 'command_execution', command: 'npm test', status: 'in_progress' },",
  '    });',
  '    event({',
  "      type: 'item.completed',",
  "      item: { id: 'item-2', type: 'agent_message', text: config.summary ?? 'I changed the file.' },",
  '    });',
  "    event({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } });",
  "    record('end');",
  '    process.exitCode = 0;',
  '    return;',
  '  }',
  "  if (mode === 'fail') {",
  '    event({',
  "      type: 'turn.failed',",
  "      error: { message: config.summary ?? 'the model could not complete the request' },",
  '    });',
  "    record('end');",
  '    process.exitCode = 1;',
  '    return;',
  '  }',
  "  if (mode === 'auth') {",
  '    process.stderr.write(',
  "      config.summary ?? 'not logged in: run `codex login` to authenticate\\n',",
  '    );',
  "    record('end');",
  '    process.exitCode = 1;',
  '    return;',
  '  }',
  "  if (mode === 'malformed') {",
  '    // Not an event at all: a runtime whose interface is not the one this',
  '    // adapter was written for.',
  "    process.stdout.write('thinking about the task, no events here\\n');",
  "    record('end');",
  '    process.exitCode = 0;',
  '    return;',
  '  }',
  "  if (mode === 'contradictory') {",
  "    event({ type: 'turn.failed', error: { message: 'the turn failed after all' } });",
  "    event({ type: 'turn.completed', usage: {} });",
  "    record('end');",
  '    process.exitCode = 0;',
  '    return;',
  '  }',
  "  if (mode === 'incomplete') {",
  '    event({',
  "      type: 'item.completed',",
  "      item: { id: 'item-1', type: 'agent_message', text: config.summary ?? 'looks done to me' },",
  '    });',
  "    record('end');",
  '    process.exitCode = 0;',
  '    return;',
  '  }',
  '',
  '  process.stderr.write(`unknown stand-in mode ${mode}\\n`);',
  '  process.exitCode = 2;',
  '});',
  '',
].join('\n');

/** The stand-in check: it passes while `file` still contains `text`. */
const CHECK_SOURCE = [
  "import { readFileSync } from 'node:fs';",
  '',
  'const [, , file, text] = process.argv;',
  "let content = '';",
  'try {',
  "  content = readFileSync(file, 'utf8');",
  '} catch {',
  "  content = '';",
  '}',
  'process.stdout.write(`checked ${file}\\n`);',
  'process.exit(content.includes(text) ? 0 : 1);',
  '',
].join('\n');

/** The committed content of the target project's only source file. */
const BASELINE_TEXT = 'the committed baseline\n';

/** What a stand-in runtime writes when a test wants the check to go red. */
const REWRITTEN_TEXT = 'the runtime rewrote this file\n';

/** The task every fixture turn is asked to complete. */
const TASK: Task = {
  id: 'tiny-001',
  title: 'Append a line to app.txt',
  description: 'Add one line to the target project using its existing conventions.',
  acceptanceCriteria: ['app.txt keeps its committed content.', 'app.txt holds the new line.'],
};

interface Fixture {
  /** Temporary directory holding the repository, the programs, and the logs. */
  readonly parent: string;
  /** The source repository: one commit, and a clean checkout of it. */
  readonly repo: string;
  /** Output directory for run directories, a sibling of the repository. */
  readonly workDir: string;
  /** A directory a standalone turn works in. */
  readonly workspace: string;
  /** `<parent>/logs`: where a standalone turn's agent log is created. */
  readonly logsDir: string;
  /** The program a configured check runs. */
  readonly check: string;
  /** The stand-in runtime, as an executable the adapter starts like `codex`. */
  readonly executable: string;
  /** One JSON record per line, appended by the stand-in runtime. */
  readonly recordsFile: string;
  readonly task: Task;
}

/**
 * The stand-in runtime as an executable on this host. Where an installed `codex`
 * is a shim — Windows — the stand-in is one too, started through the same
 * launcher a real one would be; elsewhere it is a small shell script.
 */
async function writeStandInRuntime(directory: string): Promise<string> {
  const script = path.join(directory, 'stand-in-codex.mjs');
  await writeFile(script, STAND_IN_SOURCE, 'utf8');

  if (process.platform !== 'win32') {
    const shim = path.join(directory, CODEX_EXECUTABLE);
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
    await chmod(shim, 0o755);
    return shim;
  }

  const shim = path.join(directory, `${CODEX_EXECUTABLE}.cmd`);
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  return shim;
}

/** A temporary target repository, a stand-in runtime, and a place to work in. */
async function createFixture(parts: { readonly instructionFile?: boolean } = {}): Promise<Fixture> {
  const parent = await createTempDir();
  const repo = path.join(parent, 'repo');
  const workspace = path.join(parent, 'workspace');
  const logsDir = path.join(parent, 'logs');
  const bin = path.join(parent, 'bin');
  await mkdir(repo);
  await mkdir(workspace);
  await mkdir(logsDir);
  await mkdir(bin);
  await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
  // The target project's bytes are what the fixture wrote, on any host: without
  // this, the host's own Git line-ending configuration would rewrite the working
  // copy at checkout, and the committed contents would not be what the checks and
  // the assertions are about.
  await writeFile(path.join(repo, '.gitattributes'), '* -text\n', 'utf8');
  await writeFile(path.join(repo, 'app.txt'), BASELINE_TEXT, 'utf8');
  await writeFile(path.join(repo, 'README.md'), 'a tiny target project\n', 'utf8');
  if (parts.instructionFile === true) {
    const instructions = 'Keep the committed line.\n';
    // The project's own instructions are in the source repository, and in the
    // directory a standalone turn works in: a turn here is given a directory and
    // not a clone, and a working copy that has them is what a prompt can name.
    await writeFile(path.join(repo, 'AGENTS.md'), instructions, 'utf8');
    await writeFile(path.join(workspace, 'AGENTS.md'), instructions, 'utf8');
  }
  await gitOrFail(['add', '--all'], repo);
  await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);

  const check = path.join(parent, 'check.mjs');
  await writeFile(check, CHECK_SOURCE, 'utf8');

  return {
    parent,
    repo,
    workDir: path.join(parent, 'runs'),
    workspace,
    logsDir,
    check,
    executable: await writeStandInRuntime(bin),
    recordsFile: path.join(parent, 'records.jsonl'),
    task: TASK,
  };
}

/** One record the stand-in runtime wrote about itself. */
interface RecordedRun {
  readonly event: 'start' | 'end';
  readonly pid?: number;
  readonly cwd?: string;
  readonly argv?: readonly string[];
  readonly key?: string;
  readonly prompt?: string;
}

/** Every record the stand-in runtime wrote, in the order it wrote them. */
async function recordsOf(fixture: Fixture): Promise<RecordedRun[]> {
  if (!existsSync(fixture.recordsFile)) {
    return [];
  }
  return (await readFile(fixture.recordsFile, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedRun);
}

/** The events the stand-in recorded, in order: `start`, then maybe `end`. */
async function recordOrder(fixture: Fixture): Promise<string[]> {
  return (await recordsOf(fixture)).map((record) => record.event);
}

/** The one record of the run's start, or a failure saying it never started. */
async function startRecord(fixture: Fixture): Promise<RecordedRun> {
  const start = (await recordsOf(fixture)).find((record) => record.event === 'start');
  if (start === undefined) {
    throw new Error('the stand-in runtime never started');
  }
  return start;
}

/** Waits, bounded, until the stand-in runtime has recorded that it started. */
async function waitForStart(fixture: Fixture, timeoutMs = 10_000): Promise<RecordedRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const start = (await recordsOf(fixture)).find((record) => record.event === 'start');
    if (start !== undefined) {
      if (start.pid !== undefined) {
        standInProcesses.set(start.pid, releasePathFor(fixture));
      }
      return start;
    }
    if (Date.now() > deadline) {
      throw new Error('the stand-in runtime did not start in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * The runtime one turn is run with: the stand-in executable, configured through
 * its own environment. That environment is the boundary a host's own credentials
 * cross, so a test that names one replaces it here and nowhere else.
 */
function standInRuntime(
  fixture: Fixture,
  config: StandInConfig = {},
  parts: Partial<CodexRuntime> = {},
): CodexRuntime {
  const { env, ...rest } = parts;
  return codexRuntime({
    command: [fixture.executable],
    env: {
      ...process.env,
      FAKE_CODEX: JSON.stringify({
        events: fixture.recordsFile,
        release: releasePathFor(fixture),
        ...config,
      }),
      ...env,
    },
    ...rest,
  });
}

/** One turn as the runner hands it to the adapter, with a real agent log. */
interface OpenTurn {
  readonly request: AgentTurnRequest;
  readonly logPath: string;
  close(): Promise<void>;
}

/** Opens one turn of `fixture`, working in that fixture's own directory. */
async function openTurn(
  fixture: Fixture,
  parts: Partial<AgentTurnRequest> = {},
): Promise<OpenTurn> {
  const log = await openAgentLog(fixture.logsDir, parts.turn ?? 1);
  return {
    request: {
      kind: 'implementation',
      turn: 1,
      task: fixture.task,
      workspacePath: fixture.workspace,
      sourceRoot: fixture.repo,
      baseCommit: 'a'.repeat(40),
      agentLog: log,
      repair: null,
      stop: new AbortController().signal,
      ...parts,
    },
    logPath: log.path,
    close: async () => {
      await log.close();
    },
  };
}

/** Reads a turn's own log back, after the turn that wrote it has returned. */
function readTurnLog(turn: OpenTurn): Promise<string> {
  return readFile(turn.logPath, 'utf8');
}

/** One failed command, as a repair turn is given it by the runner. */
function failedCommand(parts: Partial<CommandResult> = {}): CommandResult {
  return {
    command: ['npm', 'test'],
    cwd: 'C:\\runs\\run-1\\workspace',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:05.000Z',
    outcome: 'exited',
    exitCode: 2,
    signal: null,
    launchError: null,
    timeoutMs: 600_000,
    termination: null,
    terminationProblem: null,
    stdoutPath: 'C:\\runs\\run-1\\logs\\attempt-1-check-1.stdout.log',
    stderrPath: 'C:\\runs\\run-1\\logs\\attempt-1-check-1.stderr.log',
    ...parts,
  };
}

describe('what one turn is told, and where it works', () => {
  it('starts the runtime in the working copy, with the task on its standard input', async () => {
    const fixture = await createFixture({ instructionFile: true });
    const turn = await openTurn(fixture);

    const result = await runCodexTurn(turn.request, standInRuntime(fixture));
    await turn.close();

    const start = await startRecord(fixture);
    // The invocation is the documented one: no approval prompt (a run is
    // unattended), `exec`, the sandbox the harness relies on, the event stream it
    // reads, and the prompt on standard input.
    expect(start.argv).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--sandbox',
      'workspace-write',
      '--json',
      '-',
    ]);
    // The working root is the working copy, which the harness never leaves: the
    // runtime is started *in* it rather than pointed at it from outside.
    expect(realpathSync(start.cwd ?? '')).toBe(realpathSync(turn.request.workspacePath));

    const prompt = start.prompt ?? '';
    expect(prompt).toContain(`## Task ${TASK.id}: ${TASK.title}`);
    expect(prompt).toContain(TASK.description);
    for (const criterion of TASK.acceptanceCriteria) {
      expect(prompt).toContain(`- ${criterion}`);
    }
    // It is told where it is and where the copy came from, and the instruction
    // file it can read for itself is named.
    expect(prompt).toContain(turn.request.workspacePath);
    expect(prompt).toContain(turn.request.sourceRoot);
    expect(prompt).toContain('AGENTS.md');

    // The constraints the harness puts on every turn.
    expect(prompt).toContain('Do not weaken, skip, delete, or loosen');
    expect(prompt).toContain('Do not modify the source checkout');
    expect(prompt).toContain('do not push, open pull requests, publish packages, deploy');
    expect(result.summary).toBe('I changed the file.');
    // Nothing was stopped, so there is no stop to report at all.
    expect(result.shutdown).toBeUndefined();
  }, 60_000);

  it('gives a continued turn the guidance it was handed, as context', async () => {
    const fixture = await createFixture();
    const turn = await openTurn(fixture, {
      guidance: [
        'attempt 1 (tier flash) failed: the checks after the implementation turn did not pass',
        'comment by An Investigator at 2026-09-17T09:00:00.000Z: keep the public API stable',
      ],
    });

    await runCodexTurn(turn.request, standInRuntime(fixture));
    await turn.close();

    const prompt = (await startRecord(fixture)).prompt ?? '';
    expect(prompt).toContain('## Guidance for this attempt');
    expect(prompt).toContain(
      '- attempt 1 (tier flash) failed: the checks after the implementation turn did not pass',
    );
    expect(prompt).toContain('- comment by An Investigator at 2026-09-17T09:00:00.000Z:');
    // Context, and nothing more: it does not become an acceptance criterion, and
    // the configured checks still decide the turn.
    expect(prompt).toContain('They do not change the acceptance criteria above');
    expect(prompt).toContain('the same configured checks still');
  }, 60_000);

  it('prepends the configured launch prefix to its own arguments, literally', async () => {
    const fixture = await createFixture();
    const turn = await openTurn(fixture);
    // A prefix like the documented one: the executable, then the native profile
    // and the model it selects. The empty and space-bearing arguments are there
    // because they are the ones a shortcut through a shell string would lose.
    const prefix = [fixture.executable, '--profile', 'deepseek', 'value with spaces', ''];

    await runCodexTurn(turn.request, standInRuntime(fixture, {}, { command: prefix }));
    await turn.close();

    const start = await startRecord(fixture);
    // The prefix, unchanged and in order, then the adapter's own arguments: a
    // configured launch never replaces or reorders the turn's interface.
    expect(start.argv).toEqual([
      '--profile',
      'deepseek',
      'value with spaces',
      '',
      '--ask-for-approval',
      'never',
      'exec',
      '--sandbox',
      'workspace-write',
      '--json',
      '-',
    ]);
    expect(realpathSync(start.cwd ?? '')).toBe(realpathSync(turn.request.workspacePath));
    // The task is still only on standard input, never an argument.
    expect(start.prompt).toContain(`## Task ${TASK.id}: ${TASK.title}`);
    expect(start.argv?.some((argument) => argument.includes('## Task'))).toBe(false);
  }, 60_000);

  it('reports a prefix that names no executable as a launch failure', async () => {
    const fixture = await createFixture();
    const turn = await openTurn(fixture);

    await expect(
      runCodexTurn(turn.request, standInRuntime(fixture, {}, { command: [] })),
    ).rejects.toThrow(/could not be started/);
    await turn.close();

    expect(await recordsOf(fixture)).toEqual([]);
    expect(await readTurnLog(turn)).toContain('could not be started');
  }, 60_000);

  it('names the project instructions it can really see in the working copy', async () => {
    const fixture = await createFixture({ instructionFile: true });
    // The instruction file is in the copy the turn works in — and not only in
    // the source it was cloned from, which the turn is told not to touch.
    const turn = await openTurn(fixture);

    await runCodexTurn(turn.request, standInRuntime(fixture));
    await turn.close();

    const prompt = (await startRecord(fixture)).prompt ?? '';
    expect(prompt).toContain(
      'This working copy has its own AGENTS.md at its root: read it and follow it',
    );
    // The instructions really are in the source, so naming them is not a claim
    // about a file that does not exist.
    expect(await readFile(path.join(fixture.repo, 'AGENTS.md'), 'utf8')).toContain(
      'Keep the committed line.',
    );
  }, 60_000);

  it('gives a repair turn the failures the harness observed, with their output', async () => {
    const fixture = await createFixture();
    const turn = await openTurn(fixture, {
      kind: 'repair',
      turn: 2,
      repair: {
        repairedTurn: 1,
        failures: [
          {
            result: failedCommand(),
            output:
              'stdout (C:\\runs\\run-1\\logs\\attempt-1-check-1.stdout.log):\n1 test failed\n',
          },
        ],
      },
    });

    await runCodexTurn(turn.request, standInRuntime(fixture));
    await turn.close();

    const prompt = (await startRecord(fixture)).prompt ?? '';
    expect(prompt).toContain('repair turn 2');
    expect(prompt).toContain('turn 1');
    // The invocation the harness recorded, not a paraphrase of it.
    expect(prompt).toContain('["npm","test"]');
    expect(prompt).toContain('exit code 2');
    expect(prompt).toContain('C:\\runs\\run-1\\logs\\attempt-1-check-1.stdout.log');
    expect(prompt).toContain('1 test failed');
    // The same task context the implementation turn had, and the commands that
    // decide the run are not the turn's to change.
    expect(prompt).toContain(`## Task ${TASK.id}: ${TASK.title}`);
    expect(prompt).toContain('not yours to change');
  }, 60_000);
});

describe('how a turn ends, and what it reports', () => {
  it('reports a completed turn as the agent’s own summary, and nothing more', async () => {
    const fixture = await createFixture();
    const turn = await openTurn(fixture);

    const result = await runCodexTurn(
      turn.request,
      standInRuntime(fixture, { summary: 'I appended the line.' }),
    );
    await turn.close();

    // Agent text, and only agent text: nothing here is a check result.
    expect(result).toEqual({ summary: 'I appended the line.' });
    // The runtime's own output is kept as the turn wrote it, events and all.
    const log = await readTurnLog(turn);
    expect(log).toContain('turn.completed');
    expect(log).toContain('progress: working in');
  }, 60_000);

  it('rejects a turn the runtime reports as failed, keeping what it wrote', async () => {
    const fixture = await createFixture();
    const turn = await openTurn(fixture);

    await expect(
      runCodexTurn(turn.request, standInRuntime(fixture, { mode: 'fail' })),
    ).rejects.toThrow(/reported that the turn failed: the model could not complete the request/);
    await turn.close();

    // What the runtime said before it failed is kept, so the failure can be read.
    expect(await readTurnLog(turn)).toContain('turn.failed');
  }, 60_000);

  it('rejects a runtime that exits without reporting a completed turn', async () => {
    const fixture = await createFixture();
    const turn = await openTurn(fixture);

    const failure = await runCodexTurn(
      turn.request,
      standInRuntime(fixture, { mode: 'auth' }),
    ).catch((cause: unknown) => cause);
    await turn.close();

    expect(failure).toBeInstanceOf(AgentError);
    const message = String((failure as Error).message);
    expect(message).toContain('exited with code 1 without reporting a completed turn');
    // An authentication failure is reported as what the runtime said, not as a
    // category this adapter invented for it.
    expect(message).toContain('not logged in: run `codex login` to authenticate');
    expect(await readTurnLog(turn)).toContain('codex login');
  }, 60_000);

  it('rejects a runtime that cannot be started, and starts nothing', async () => {
    const fixture = await createFixture();
    const turn = await openTurn(fixture);
    const missing = path.join(fixture.parent, 'no-such-codex');

    await expect(
      runCodexTurn(turn.request, standInRuntime(fixture, {}, { command: [missing] })),
    ).rejects.toThrow(/could not be started/);
    await turn.close();

    expect(await recordsOf(fixture)).toEqual([]);
    expect(await readTurnLog(turn)).toContain('could not be started');
  }, 60_000);

  it('rejects a stream that is not the completion of a turn', async () => {
    const malformed = await createFixture();
    const malformedTurn = await openTurn(malformed);
    await expect(
      runCodexTurn(malformedTurn.request, standInRuntime(malformed, { mode: 'malformed' })),
    ).rejects.toThrow(/without reporting that the turn completed; 1 of its output lines were not/);
    await malformedTurn.close();

    const contradictory = await createFixture();
    const contradictoryTurn = await openTurn(contradictory);
    await expect(
      runCodexTurn(
        contradictoryTurn.request,
        standInRuntime(contradictory, { mode: 'contradictory' }),
      ),
    ).rejects.toThrow(/failed turn and a completed turn, so the turn cannot be read as completed/);
    await contradictoryTurn.close();

    const incomplete = await createFixture();
    const incompleteTurn = await openTurn(incomplete);
    await expect(
      runCodexTurn(incompleteTurn.request, standInRuntime(incomplete, { mode: 'incomplete' })),
    ).rejects.toThrow(/exited with code 0 without reporting that the turn completed/);
    await incompleteTurn.close();
    // Nothing is invented for a turn that stopped short of completing, and what
    // it did say is kept where it said it.
    expect(await readTurnLog(incompleteTurn)).toContain('looks done to me');
  }, 60_000);
});

describe('stopping what a turn started', () => {
  it('stops the runtime it started, waits for it, and reports a confirmed stop', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const turn = await openTurn(fixture, { stop: controller.signal });
    const stopped: number[] = [];
    // The host's own stop, with the PID recorded on the way: what is stopped is
    // the tree the harness started, named by the PID it saw, and nothing else.
    const runtime = standInRuntime(
      fixture,
      { holdMs: 30_000, summary: 'still working' },
      {
        stopTree: async (pid) => {
          stopped.push(pid);
          return requestTreeStop(pid);
        },
      },
    );

    const running = runCodexTurn(turn.request, runtime);
    const start = await waitForStart(fixture);
    controller.abort();
    const result = await running;
    await turn.close();

    // Exactly one tree was stopped, and it is the one the harness started: the
    // runtime itself where it is started directly, and the shell that reaches a
    // `.cmd` shim where that is how the host's `codex` is installed. What is
    // stopped under either is the tree of that process, which is why the tree is
    // asked about as a whole below.
    expect(stopped).toHaveLength(1);
    const pid = start.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(stopped[0]).toBe(pid);
    }
    expect(result.shutdown).toEqual({ termination: 'confirmed', problem: null });
    // Confirmed means it really ended: the stand-in process is gone, and it
    // never got to its own ending.
    expect(await waitUntilGone(pid)).toBe(true);
    expect(await recordOrder(fixture)).toEqual(['start']);
    expect(result.summary).toBe('still working');
  }, 60_000);

  it('waits for a stopped runtime to end before the turn returns', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const turn = await openTurn(fixture, { stop: controller.signal });
    // A stop request that reached the operating system, and a runtime that ends
    // a moment later by itself: `confirmed` means it was *seen* to end, so the
    // turn cannot return before that end was observed.
    const runtime = standInRuntime(
      fixture,
      { holdMs: 400, summary: 'still working' },
      { stopTree: async () => null },
    );

    const running = runCodexTurn(turn.request, runtime);
    await waitForStart(fixture);
    controller.abort();
    const result = await running;
    await turn.close();

    expect(result.shutdown).toEqual({ termination: 'confirmed', problem: null });
    expect(await recordOrder(fixture)).toEqual(['start', 'end']);
  }, 60_000);

  it('reports a stop it could not confirm instead of claiming the runtime ended', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const turn = await openTurn(fixture, { stop: controller.signal });
    const runtime = standInRuntime(
      fixture,
      { holdMs: 30_000, summary: 'still working' },
      {
        // A stop the host cannot carry out is what this test is about, so it
        // does not happen here — and the tree the harness asked about is the one
        // this test's own teardown asks to end.
        stopTree: async (pid) => {
          standInProcesses.set(pid, releasePathFor(fixture));
          return 'the host could not reach the process tree';
        },
        stopGraceMs: 60,
      },
    );

    const running = runCodexTurn(turn.request, runtime);
    await waitForStart(fixture);
    controller.abort();
    const result = await running;
    await turn.close();

    // Nothing of it was seen to end, so nothing of it is reported as ended.
    expect(result.shutdown).toEqual({
      termination: 'unconfirmed',
      problem: 'the host could not reach the process tree',
    });
    expect(await recordOrder(fixture)).toEqual(['start']);
  }, 60_000);

  it('starts nothing when the run was already stopped', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    controller.abort();
    const turn = await openTurn(fixture, { stop: controller.signal });

    const result = await runCodexTurn(turn.request, standInRuntime(fixture, { holdMs: 30_000 }));
    await turn.close();

    expect(await recordsOf(fixture)).toEqual([]);
    // Nothing ran, so nothing is left running: nothing was started only to be
    // stopped again, and the stop is confirmed because there was nothing to stop.
    expect(result).toEqual({
      summary: null,
      shutdown: { termination: 'confirmed', problem: null },
    });
  }, 60_000);
});

describe('the runner, the real checks, and the real adapter together', () => {
  /** The runner's real collaborators, with the coding turn the one replaced. */
  function dependencies(
    turn: RunnerDependencies['runAgentTurn'],
    parts: Partial<RunnerDependencies> = {},
  ): RunnerDependencies {
    return {
      preflight: preflightSource,
      allocateRunDirectory,
      prepareWorkspace,
      configureWorkspaceIdentity,
      recordWorkspaceAttempt,
      runCheckRound,
      openAgentLog,
      appendRunLog,
      writeRunReport,
      now: () => new Date(),
      runAgentTurn: turn,
      ...parts,
    };
  }

  /** What one run is asked to do: the loaded task, the loaded plan, and the paths. */
  function request(fixture: Fixture, config: HarnessConfig): Parameters<typeof runTask>[0] {
    return { task: fixture.task, config, repoPath: fixture.repo, workDir: fixture.workDir };
  }

  /** A plan whose only check is green while `app.txt` holds the baseline. */
  function configuration(fixture: Fixture, parts: Partial<HarnessConfig> = {}): HarnessConfig {
    return {
      workDir: fixture.workDir,
      maxRepairs: 2,
      taskTimeoutMinutes: 60,
      commandTimeoutMinutes: 10,
      setup: [],
      checks: [[process.execPath, fixture.check, 'app.txt', BASELINE_TEXT.trim()]],
      agent: { runtime: 'codex', command: ['codex'] },
      ...parts,
    };
  }

  /** One run, with the adapter really started for every turn it asks for. */
  function runtimeByTurn(
    fixture: Fixture,
    configFor: (turn: number) => StandInConfig,
  ): RunnerDependencies['runAgentTurn'] {
    return async (asked: AgentTurnRequest) =>
      runCodexTurn(asked, standInRuntime(fixture, configFor(asked.turn)));
  }

  /** The report a run left behind, parsed: the evidence, not the returned object. */
  async function reportOf(result: { readonly reportPath: string }): Promise<RunReport> {
    return JSON.parse(await readFile(result.reportPath, 'utf8')) as RunReport;
  }

  it('keeps what the runtime claims as agent text and lets the checks decide', async () => {
    const fixture = await createFixture();
    // The runtime says the work is done and the tests pass, and it really did
    // break what the plan's own check verifies: the check decides the run.
    const result = await runTask(
      request(fixture, configuration(fixture, { maxRepairs: 0 })),
      dependencies(
        runtimeByTurn(fixture, () => ({
          file: 'app.txt',
          text: REWRITTEN_TEXT,
          write: 'replace',
          summary: 'All tests pass: npm test is green.',
        })),
      ),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('did not pass');
    const report = await reportOf(result);
    // The claim is kept as the turn's own account, beside the round that
    // contradicts it — never in place of one.
    expect(report.baseline?.outcome).toBe('passed');
    expect(report.attempts[0]?.agentSummary).toBe('All tests pass: npm test is green.');
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');
    expect(report.attempts[0]?.checks?.checks[0]?.exitCode).toBe(1);
    // What the turn really left is in the retained working copy.
    expect(await readFile(path.join(result.run.workspacePath, 'app.txt'), 'utf8')).toBe(
      REWRITTEN_TEXT,
    );
  }, 60_000);

  it('passes a run whose own checks exit 0, and keeps the runtime’s summary beside them', async () => {
    const fixture = await createFixture();
    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(
        runtimeByTurn(fixture, () => ({
          file: 'notes.txt',
          text: 'the runtime wrote its own file\n',
          summary: 'I recorded my work in notes.txt.',
        })),
      ),
    );

    expect(result.status).toBe('passed');
    const report = await reportOf(result);
    expect(report.attempts[0]?.agentSummary).toBe('I recorded my work in notes.txt.');
    expect(report.attempts[0]?.checks?.outcome).toBe('passed');
    expect(report.attempts[0]?.checks?.checks[0]?.exitCode).toBe(0);
    // The turn's transcript is in its own file, referenced by the report rather
    // than copied into it.
    expect(await readFile(report.attempts[0]?.agentLog ?? '', 'utf8')).toContain('turn.completed');
  }, 60_000);

  it('starts the implementation and every repair with the one configured prefix', async () => {
    const fixture = await createFixture();
    const prefix = [
      fixture.executable,
      '--profile',
      'deepseek',
      '--model',
      'deepseek-flash',
    ] as const;
    const result = await runTask(
      request(
        fixture,
        configuration(fixture, { maxRepairs: 1, agent: { runtime: 'codex', command: prefix } }),
      ),
      dependencies(async (asked: AgentTurnRequest) =>
        runCodexTurn(
          asked,
          standInRuntime(
            fixture,
            asked.turn === 1
              ? { file: 'app.txt', text: REWRITTEN_TEXT, write: 'replace' }
              : { file: 'app.txt', text: BASELINE_TEXT, write: 'replace' },
            {
              command: prefix,
            },
          ),
        ),
      ),
    );

    expect(result.status).toBe('passed');
    expect(result.repairsUsed).toBe(1);
    // Both turns went through the configured launch, and neither fell back to a
    // default: there is no second selection to fall back to.
    const starts = (await recordsOf(fixture)).filter((record) => record.event === 'start');
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(start.argv).toEqual([
        '--profile',
        'deepseek',
        '--model',
        'deepseek-flash',
        '--ask-for-approval',
        'never',
        'exec',
        '--sandbox',
        'workspace-write',
        '--json',
        '-',
      ]);
    }
    // The report names the launch the run really used, once, for the whole run.
    const report = await reportOf(result);
    expect(report.agent).toEqual({ runtime: 'codex', command: prefix });
    const timeline = await readFile(report.runLog, 'utf8');
    expect(timeline.match(/agent selected:/g)).toHaveLength(1);
    expect(timeline).toContain(JSON.stringify(prefix));
  }, 60_000);

  it('runs one invocation per top-level turn, and never continues a session', async () => {
    const fixture = await createFixture();
    const result = await runTask(
      request(fixture, configuration(fixture, { maxRepairs: 1 })),
      dependencies(
        runtimeByTurn(fixture, (turn) => ({
          // The implementation turn breaks the line the check needs, and the
          // repair turn puts it back. Each reports a session of its own.
          session: `session-${String(turn)}`,
          file: 'app.txt',
          text: turn === 1 ? REWRITTEN_TEXT : BASELINE_TEXT,
          write: 'replace',
          summary: `turn ${String(turn)} is done.`,
        })),
      ),
    );

    expect(result.status).toBe('passed');
    const report = await reportOf(result);
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['implementation', 'repair']);
    expect(report.repairsUsed).toBe(1);

    // One top-level turn, one invocation: continuing a session is not a way for
    // a runtime to be given work the run did not spend one of its turns on.
    const starts = (await recordsOf(fixture)).filter((record) => record.event === 'start');
    expect(starts.length).toBe(2);
    for (const start of starts) {
      expect(start.argv).not.toContain('resume');
    }
    // The repair turn is a fresh invocation carrying the failures the harness
    // observed for itself, and it is told what they were.
    expect(starts[0]?.prompt).not.toContain('exit code 1');
    expect(starts[1]?.prompt).toContain('exit code 1');
    expect(starts[1]?.prompt).toContain('app.txt');
    expect(starts[1]?.prompt).toContain('check.mjs');
  }, 60_000);

  it('refuses to check after a turn that could not confirm its own stop', async () => {
    const fixture = await createFixture();
    const rounds: string[] = [];
    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(
        async () => ({
          summary: 'I stopped early.',
          shutdown: {
            termination: 'unconfirmed' as const,
            problem: 'the coding runtime had not ended 5000 ms after it was stopped',
          },
        }),
        {
          runCheckRound: async (asked) => {
            rounds.push(asked.name);
            return runCheckRound(asked);
          },
        },
      ),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('could not confirm that it had ended');
    expect(result.reason).toContain('may still be written to');
    // Only the baseline ran: no check read a working copy something may still
    // have been writing to.
    expect(rounds).toEqual(['baseline']);
    // The working copy is kept without being read as a final record of the run:
    // an unavailable summary says so rather than listing nothing.
    expect(result.changes.inspected).toBe(false);
    expect(result.changes.problem).toContain('may still be written to');
    expect(result.changes.paths).toEqual([]);
  }, 60_000);

  it('stops the runtime when the run is cancelled, and reports the stop as it was observed', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const rounds: string[] = [];
    const runtime = standInRuntime(
      fixture,
      { holdMs: 30_000, summary: 'still working' },
      {
        // The stop the harness cannot confirm is the whole point here, so it
        // does not kill anything: the tree it asked about is what this test's
        // own teardown asks to end.
        stopTree: async (pid) => {
          standInProcesses.set(pid, releasePathFor(fixture));
          return 'the host could not reach the process tree';
        },
        stopGraceMs: 60,
      },
    );

    const running = runTask(
      { ...request(fixture, configuration(fixture)), stop: controller.signal },
      dependencies(async (asked: AgentTurnRequest) => runCodexTurn(asked, runtime), {
        runCheckRound: async (asked) => {
          rounds.push(asked.name);
          return runCheckRound(asked);
        },
      }),
    );
    // The stop arrives while the implementation turn is really running, and its
    // runtime is one the harness cannot confirm it ended.
    await waitForStart(fixture);
    controller.abort();
    const result = await running;

    expect(result.status).toBe('cancelled');
    expect(result.cancellation?.termination).toBe('unconfirmed');
    expect(result.cancellation?.problem).toBe('the host could not reach the process tree');
    expect(result.reason).toContain('the working copy may still be written to');
    // The turn was awaited, no check followed it, and the working copy is kept
    // without being read as a final record of what the run left behind.
    expect(rounds).toEqual(['baseline']);
    expect(result.changes.inspected).toBe(false);
    expect(result.changes.problem).toContain('may still be written to');
    const report = await reportOf(result);
    expect(report.attempts.map((attempt) => attempt.checks === null)).toEqual([true]);
  }, 60_000);

  it('never persists a credential it was given at its own boundary', async () => {
    const fixture = await createFixture();
    const sentinel = 'sentinel-credential-3f7a1c-never-persisted';
    const withKey = { CODEX_API_KEY: sentinel };

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(async (asked: AgentTurnRequest) =>
        runCodexTurn(
          asked,
          standInRuntime(fixture, { file: 'notes.txt', text: 'notes\n' }, { env: withKey }),
        ),
      ),
    );

    expect(result.status).toBe('passed');
    // The credential reached the runtime's own environment, which is where the
    // CLI expects it — and it stopped there.
    expect((await startRecord(fixture)).key).toBe('present');

    const report = await reportOf(result);
    const persisted = [
      ...report.attempts.map((attempt) => attempt.agentLog),
      report.runLog,
      result.reportPath,
    ];
    expect(persisted).toHaveLength(3);
    for (const file of persisted) {
      expect(await readFile(file, 'utf8')).not.toContain(sentinel);
    }

    // A turn that fails reports what the runtime said, not what it was given.
    const turn = await openTurn(fixture);
    const failure = await runCodexTurn(
      turn.request,
      standInRuntime(fixture, { mode: 'auth' }, { env: withKey }),
    ).catch((cause: unknown) => cause);
    await turn.close();
    expect(String((failure as Error).message)).not.toContain(sentinel);
  }, 60_000);
});
