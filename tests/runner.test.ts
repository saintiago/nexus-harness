/**
 * Runner tests: one task through the loop, with a fake coding agent.
 *
 * Every run here is real — a temporary Git repository is cloned, the configured
 * setup and check commands are real child processes started in that clone, and
 * the report and logs are read back from disk. The only stand-in is the coding
 * turn, because no coding runtime exists yet; it is a real child process too, so
 * "the checks run after the turn" is asserted from what the processes observed
 * rather than from what the runner intended. There is no network, no provider,
 * and no credentials, and nothing outside the temporary directories is touched.
 * See docs/tasks.md T06 for the acceptance criteria.
 */

import { spawn } from 'node:child_process';
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheckRound } from '../src/checks.js';
import type { CheckRoundRequest } from '../src/checks.js';
import { agentLogPath, appendRunLog, openAgentLog, writeRunReport } from '../src/report.js';
import type { RunReportRequest } from '../src/report.js';
import { runTask } from '../src/runner.js';
import type { AgentTurnRequest, AgentTurnResult, RunnerDependencies } from '../src/runner.js';
import {
  WorkspaceError,
  allocateRunDirectory,
  prepareWorkspace,
  preflightSource,
} from '../src/workspace.js';
import type {
  PreparedWorkspace,
  PreflightRequest,
  RunDirectory,
  SourcePreflight,
} from '../src/workspace.js';
import type { CheckRoundResult, Command, HarnessConfig, RunReport, Task } from '../src/types.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

afterEach(cleanupTempDirectories);

/**
 * A private Git environment for the fixtures: the developer's own hooks,
 * signing, ignore rules, and identity must not change what the tests observe.
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

/**
 * One configured setup/check command. It records when it started and ended,
 * reports whether the coding turn held its lock file at that moment, and decides
 * its own exit code from the mode it was given: `ok` always succeeds, `fail`
 * always fails, and `need` succeeds when `file` in the current directory
 * contains `text` — which is how a check observes what a turn really did.
 */
const RECORD_SOURCE = [
  "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
  '',
  'const [, , id, eventsFile, agentLock, mode, file, text] = process.argv;',
  'const record = (event, extra = {}) =>',
  "  appendFileSync(eventsFile, `${JSON.stringify({ event, id, at: Date.now(), ...extra })}\\n`, 'utf8');",
  '',
  "record('start', { agentActive: existsSync(agentLock) });",
  'process.stdout.write(`ran ${id}\\n`);',
  'process.stderr.write(`err ${id}\\n`);',
  '',
  'let passed = true;',
  'if (mode === "fail") {',
  '  passed = false;',
  '}',
  'if (mode === "need") {',
  '  let content = "";',
  '  try {',
  '    content = readFileSync(file, "utf8");',
  '  } catch {',
  '    content = "";',
  '  }',
  '  passed = content.includes(text);',
  '}',
  '',
  "record('end', { passed });",
  'process.exit(passed ? 0 : 1);',
  '',
].join('\n');

/**
 * The stand-in coding runtime: a real child process that edits the working copy,
 * records its own lifetime, and stays alive for the interval it was given. The
 * lock it is guarded by is held by the turn that started it, so a configured
 * command started during this process finds the lock held and records that it
 * did — which is the signal the ordering assertions read.
 */
const TURN_SOURCE = [
  "import { appendFileSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  '',
  'const [, , id, eventsFile, workspace, holdMs, mode, file, text] = process.argv;',
  'const record = (event) =>',
  "  appendFileSync(eventsFile, `${JSON.stringify({ event, id, at: Date.now() })}\\n`, 'utf8');",
  '',
  "record('turn-start');",
  'process.stdout.write(`turn ${id}: working in ${workspace}\\n`);',
  'writeFileSync(path.join(workspace, file), text, mode === "append" ? { flag: "a" } : {});',
  'process.stderr.write(`turn ${id}: wrote ${file}\\n`);',
  '',
  'setTimeout(() => {',
  "  record('turn-end');",
  '  process.stdout.write(`turn ${id}: finished\\n`);',
  '  process.exit(0);',
  '}, Number(holdMs));',
  '',
].join('\n');

/** The committed content of the target project's only source file. */
const BASELINE_TEXT = 'the committed baseline\n';

/** What the stand-in turn appends to that file unless a test says otherwise. */
const IMPLEMENTED_TEXT = 'a line from the implementation\n';

/** The task every fixture run is asked to complete. */
const TASK: Task = {
  id: 'tiny-001',
  title: 'Append a line to app.txt',
  description: 'Add one line to the target project using its existing conventions.',
  acceptanceCriteria: ['app.txt keeps its committed content.', 'app.txt holds the new line.'],
};

interface Fixture {
  /** Temporary directory holding the repository and the fixture programs. */
  readonly parent: string;
  /** The source repository: one commit, and a clean checkout of it. */
  readonly repo: string;
  /** Output directory for run directories, a sibling of the repository. */
  readonly workDir: string;
  /** The command program a configured setup/check command runs. */
  readonly record: string;
  /** The program the stand-in coding turn runs. */
  readonly turn: string;
  /** One JSON record per line, appended by every fixture process. */
  readonly eventsFile: string;
  /** Held for as long as the stand-in coding turn is running. */
  readonly agentLock: string;
  /** The task the run is asked to complete. */
  readonly task: Task;
}

/** A temporary target repository with a clean committed baseline. */
async function createFixture(): Promise<Fixture> {
  const parent = await createTempDir();
  const repo = path.join(parent, 'repo');
  await mkdir(repo);
  await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
  // The target project's bytes are what the fixture wrote, on any host: without
  // this, the host's own Git line-ending configuration would rewrite the
  // working copy at checkout and the committed contents would not be what the
  // checks and the assertions are about.
  await writeFile(path.join(repo, '.gitattributes'), '* -text\n', 'utf8');
  await writeFile(path.join(repo, 'app.txt'), BASELINE_TEXT, 'utf8');
  await writeFile(path.join(repo, 'README.md'), 'a tiny target project\n', 'utf8');
  await gitOrFail(['add', '--all'], repo);
  await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);

  const record = path.join(parent, 'record.mjs');
  await writeFile(record, RECORD_SOURCE, 'utf8');
  const turn = path.join(parent, 'turn.mjs');
  await writeFile(turn, TURN_SOURCE, 'utf8');

  return {
    parent,
    repo,
    workDir: path.join(parent, 'runs'),
    record,
    turn,
    eventsFile: path.join(parent, 'events.jsonl'),
    agentLock: path.join(parent, 'agent.lock'),
    task: TASK,
  };
}

/** How a configured command decides its own exit code. */
type Mode = 'ok' | 'fail' | 'need';

/** One configured command: the recording program in one of its modes. */
function command(fixture: Fixture, id: string, mode: Mode = 'ok', file = '', text = ''): Command {
  return [
    process.execPath,
    fixture.record,
    id,
    fixture.eventsFile,
    fixture.agentLock,
    mode,
    file,
    text,
  ];
}

/**
 * The configuration a run is given. The default plan is green against the
 * committed baseline: the check needs the text the baseline really has.
 */
function configuration(fixture: Fixture, parts: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    workDir: fixture.workDir,
    maxRepairs: 2,
    taskTimeoutMinutes: 60,
    commandTimeoutMinutes: 10,
    setup: [command(fixture, 'setup-1')],
    checks: [command(fixture, 'check-1', 'need', 'app.txt', 'committed baseline')],
    ...parts,
  };
}

/** What one run is asked to do: the loaded task, the loaded plan, and the paths. */
function request(fixture: Fixture, config: HarnessConfig): Parameters<typeof runTask>[0] {
  return { task: fixture.task, config, repoPath: fixture.repo, workDir: fixture.workDir };
}

/**
 * The runner's real collaborators, with the coding turn — and anything else a
 * test names — replaced by that test's own.
 */
function dependencies(
  agent: RunnerDependencies['runAgentTurn'],
  parts: Partial<RunnerDependencies> = {},
): RunnerDependencies {
  return {
    preflight: preflightSource,
    allocateRunDirectory,
    prepareWorkspace,
    runCheckRound,
    openAgentLog,
    appendRunLog,
    writeRunReport,
    now: () => new Date(),
    runAgentTurn: agent,
    ...parts,
  };
}

/** What the stand-in coding turn does when the runner asks it to run. */
interface FakeTurn {
  /** The file it edits in the working copy, relative to the working copy. */
  readonly file?: string;
  /** What it writes there. */
  readonly text?: string;
  /** Whether it appends to that file or replaces it. */
  readonly mode?: 'append' | 'replace';
  /** Extra files it leaves in the working copy, standing in for its work. */
  readonly extras?: readonly { readonly file: string; readonly text: string }[];
  /** Text it writes to its agent log before its process starts. */
  readonly logText?: string;
  /** How long its process stays alive while it works, in milliseconds. */
  readonly holdMs?: number;
  /** Its own failure: the turn rejects after its process exited. */
  readonly failWith?: string;
}

interface FakeAgent {
  /** The coding turn the runner is given. */
  readonly turn: RunnerDependencies['runAgentTurn'];
  /** Every turn the runner asked for, in the order it asked for it. */
  readonly requests: AgentTurnRequest[];
}

/**
 * The stand-in coding turn. It takes its lock before its first `await`, so any
 * command the runner starts from that moment on finds the lock held, and it
 * holds the lock until the turn is over — however the turn ends.
 */
function fakeAgent(fixture: Fixture, script: FakeTurn = {}): FakeAgent {
  const { file = 'app.txt', text = IMPLEMENTED_TEXT, mode = 'append', holdMs = 150 } = script;
  const requests: AgentTurnRequest[] = [];

  return {
    requests,
    turn: async (agentRequest: AgentTurnRequest): Promise<AgentTurnResult> => {
      requests.push(agentRequest);
      writeFileSync(fixture.agentLock, 'the coding turn is active\n', 'utf8');
      try {
        for (const extra of script.extras ?? []) {
          await writeFile(path.join(agentRequest.workspacePath, extra.file), extra.text, 'utf8');
        }
        agentRequest.agentLog.write(
          script.logText ??
            `turn ${String(agentRequest.turn)}: working in ${agentRequest.workspacePath}\n`,
        );
        const id = `turn-${String(agentRequest.turn)}`;
        const result = await runProcess(
          process.execPath,
          [
            fixture.turn,
            id,
            fixture.eventsFile,
            agentRequest.workspacePath,
            String(holdMs),
            mode,
            file,
            text,
          ],
          { cwd: agentRequest.workspacePath },
        );
        agentRequest.agentLog.write(result.stdout);
        if (result.code !== 0) {
          throw new Error(`the coding turn's own process exited ${String(result.code)}`);
        }
        if (script.failWith !== undefined) {
          throw new Error(script.failWith);
        }
        return { summary: `the implementation turn edited ${file}` };
      } finally {
        rmSync(fixture.agentLock, { force: true });
      }
    },
  };
}

interface RecordedEvent {
  readonly event: 'start' | 'end' | 'turn-start' | 'turn-end';
  readonly id: string;
  /** Whether the coding turn's lock was held when a command started. */
  readonly agentActive?: boolean;
  /** Whether a command decided it passed. */
  readonly passed?: boolean;
}

/** Every record the fixture processes wrote, in the order they wrote them. */
async function recordedEvents(fixture: Fixture): Promise<RecordedEvent[]> {
  if (!existsSync(fixture.eventsFile)) {
    return [];
  }
  return (await readFile(fixture.eventsFile, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedEvent);
}

/** `event id` for every record: the whole run as one ordered list. */
function eventOrder(events: readonly RecordedEvent[]): string[] {
  return events.map((event) => `${event.event} ${event.id}`);
}

/**
 * Asserts that no configured command started while the coding turn was running.
 * The commands report the turn's lock file as they found it, so this reads what
 * the child processes observed, not what the runner intended.
 */
function expectNoTurnOverlap(events: readonly RecordedEvent[]): void {
  const starts = events.filter((event) => event.event === 'start');
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts) {
    expect(start.agentActive).toBe(false);
  }
}

/** The written report, parsed: these tests read what a run left on disk. */
async function readReport(file: string): Promise<RunReport> {
  return JSON.parse(await readFile(file, 'utf8')) as RunReport;
}

function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

/** The timeline's messages, without the timestamp each line starts with. */
function timelineMessages(text: string): string[] {
  return text
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^\S+ /, ''));
}

/** The lifecycle phases the timeline recorded, in the order it recorded them. */
function lifecyclePhases(messages: readonly string[]): string[] {
  const phases = [
    'baseline check-round',
    'implementation turn',
    'post-agent check-round',
    'final status',
  ];
  return messages
    .filter((message) => phases.some((phase) => message.startsWith(phase)))
    .map((message) => {
      const separator = message.indexOf(':');
      return separator === -1 ? message : message.slice(0, separator);
    });
}

describe('a run that stops before any coding turn', () => {
  it('stops as failed, keeps the evidence, and never calls the agent', async () => {
    const fixture = await createFixture();
    // The committed working copy cannot satisfy this check, so the baseline is
    // red before any coding turn could have run.
    const config = configuration(fixture, {
      checks: [command(fixture, 'check-1', 'need', 'app.txt', 'text the baseline does not have')],
    });
    const agent = fakeAgent(fixture);

    const result = await runTask(request(fixture, config), dependencies(agent.turn));

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/baseline checks did not pass/);
    expect(agent.requests).toEqual([]);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.baseline?.outcome).toBe('failed');
    expect(report.baseline?.checks.map((entry) => entry.exitCode)).toEqual([1]);
    expect(report.attempts).toEqual([]);
    expect(report.repairsUsed).toBe(0);

    // The evidence and the working copy are retained: the failed check's own
    // output is still on disk, in the file the report points at.
    const failed = report.baseline?.checks[0];
    expect(await readText(failed?.stdoutPath ?? '')).toBe('ran check-1\n');
    expect(await readText(failed?.stderrPath ?? '')).toBe('err check-1\n');
    expect(await readText(path.join(result.run.workspacePath, 'app.txt'))).toBe(BASELINE_TEXT);
    expect(existsSync(path.join(result.run.workspacePath, '.git'))).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);

    // One baseline round ran, and nothing else: the setup then the check.
    expect(eventOrder(await recordedEvents(fixture))).toEqual([
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
    ]);

    // The timeline records the baseline and the final status, and no turn.
    const timeline = timelineMessages(await readText(report.runLog));
    expect(lifecyclePhases(timeline)).toEqual([
      'baseline check-round started',
      'baseline check-round result',
      'final status',
    ]);
    expect(timeline.at(-1)).toMatch(/^final status: failed, /);
    expect(timeline.join('\n')).not.toContain('implementation turn');
  }, 60_000);

  it('stops as failed when the baseline setup cannot be executed', async () => {
    const fixture = await createFixture();
    const absent = path.join(fixture.parent, 'no-such-program-xyz');
    const agent = fakeAgent(fixture);

    const result = await runTask(
      request(fixture, configuration(fixture, { setup: [[absent, '--version']] })),
      dependencies(agent.turn),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/baseline could not be executed/);
    expect(agent.requests).toEqual([]);

    const report = await readReport(result.reportPath);
    expect(report.baseline?.outcome).toBe('execution-error');
    // No check ran at all: an unexecuted check has no result, and no green one.
    expect(report.baseline?.checks).toEqual([]);
    expect(report.baseline?.problem ?? '').toContain(absent);
    expect(report.attempts).toEqual([]);
    expect(await recordedEvents(fixture)).toEqual([]);

    // The run directory, its working copy, and the report survived the failure.
    expect(existsSync(path.join(result.run.workspacePath, '.git'))).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);
  }, 60_000);

  it('fails a run whose working copy cannot be prepared, and calls no agent', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(fixture);

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn, {
        prepareWorkspace: async () => {
          throw new WorkspaceError('the working copy could not be cloned');
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/preparing the working copy failed/);
    expect(result.workspace).toBeNull();
    expect(agent.requests).toEqual([]);
    expect(await recordedEvents(fixture)).toEqual([]);

    // The report says what is missing instead of describing a clone that was
    // never made, and the allocated run directory is still there.
    const report = await readReport(result.reportPath);
    expect(report.workspace.prepared).toBe(false);
    expect(report.workspace.branch).toBeNull();
    expect(report.workspace.problem).toBe('the working copy could not be cloned');
    expect(report.baseline).toBeNull();
    expect(report.attempts).toEqual([]);
    expect(existsSync(result.run.runDir)).toBe(true);
  }, 60_000);

  it('refuses a run whose source is not clean before allocating anything', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repo, 'uncommitted.txt'), 'not committed\n', 'utf8');
    const agent = fakeAgent(fixture);

    const failure = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    // A run refused before it has a directory has no run and no report: the
    // caller explains the problem instead of the harness inventing a report.
    expect(failure).toBeInstanceOf(WorkspaceError);
    expect((failure as WorkspaceError).message).toMatch(/not a clean checkout/);
    expect(existsSync(fixture.workDir)).toBe(false);
    expect(existsSync(fixture.eventsFile)).toBe(false);
    expect(agent.requests).toEqual([]);
  }, 60_000);
});

describe('a run whose baseline passes', () => {
  it('runs one implementation turn, then setup and every check, and passes', async () => {
    const fixture = await createFixture();
    const config = configuration(fixture, {
      checks: [
        command(fixture, 'check-1', 'need', 'app.txt', 'committed baseline'),
        command(fixture, 'check-2'),
      ],
    });
    const agent = fakeAgent(fixture, { holdMs: 400 });

    const result = await runTask(request(fixture, config), dependencies(agent.turn));

    expect(result.status).toBe('passed');
    expect(result.reason).toMatch(/every configured check passed/);
    expect(result.workspace?.workspacePath).toBe(result.run.workspacePath);

    // Exactly one turn, and it was given the loaded task and the working copy.
    expect(agent.requests).toHaveLength(1);
    const turn = agent.requests[0];
    expect(turn?.kind).toBe('implementation');
    expect(turn?.turn).toBe(1);
    expect(turn?.task).toEqual(fixture.task);
    expect(turn?.task.acceptanceCriteria).toEqual(fixture.task.acceptanceCriteria);
    expect(turn?.workspacePath).toBe(result.run.workspacePath);
    expect(turn?.sourceRoot).toBe(realpathSync.native(fixture.repo));
    expect(turn?.baseCommit).toBe((await gitOrFail(['rev-parse', 'HEAD'], fixture.repo)).trim());

    // The turn really worked in the working copy: its edit is there.
    expect(await readText(path.join(result.run.workspacePath, 'app.txt'))).toBe(
      BASELINE_TEXT + IMPLEMENTED_TEXT,
    );
    // The source checkout is not where the run worked, and it is unchanged.
    expect(await readText(path.join(fixture.repo, 'app.txt'))).toBe(BASELINE_TEXT);
    expect(await gitOrFail(['status', '--porcelain'], fixture.repo)).toBe('');

    // The same plan ran twice, in order, with the turn between the rounds and
    // nothing of either round overlapping it.
    const events = await recordedEvents(fixture);
    expect(eventOrder(events)).toEqual([
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
      'start check-2',
      'end check-2',
      'turn-start turn-1',
      'turn-end turn-1',
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
      'start check-2',
      'end check-2',
    ]);
    expectNoTurnOverlap(events);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('passed');
    expect(report.repairsUsed).toBe(0);
    expect(report.task).toEqual({ id: fixture.task.id, title: fixture.task.title });
    expect(report.baseline?.outcome).toBe('passed');
    expect(report.baseline?.checks.map((entry) => entry.command)).toEqual(config.checks);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.kind).toBe('implementation');
    expect(report.attempts[0]?.agentSummary).toBe('the implementation turn edited app.txt');
    expect(report.attempts[0]?.checks?.outcome).toBe('passed');
    expect(report.attempts[0]?.checks?.checks.map((entry) => entry.command)).toEqual(config.checks);
    expect(report.attempts[0]?.checks?.checks.map((entry) => entry.exitCode)).toEqual([0, 0]);

    // The turn's useful output is in its own log, not in the report.
    expect(report.attempts[0]?.agentLog).toBe(agentLogPath(result.run.logsDir, 1));
    const agentLog = await readText(report.attempts[0]?.agentLog ?? '');
    expect(agentLog).toContain('turn 1: working in');
    expect(agentLog).toContain('turn turn-1: finished');

    // The timeline shows baseline, implementation, post-agent checks, and
    // finalization in that order...
    const timeline = timelineMessages(await readText(report.runLog));
    expect(lifecyclePhases(timeline)).toEqual([
      'baseline check-round started',
      'baseline check-round result',
      'implementation turn started',
      'implementation turn result',
      'post-agent check-round started',
      'post-agent check-round result',
      'final status',
    ]);
    // ...and holds no command output: the commands' own output stays in their
    // own files, and the agent's transcript stays in its own file.
    const text = timeline.join('\n');
    expect(text).not.toContain('ran check-1');
    expect(text).not.toContain('err check-1');
    expect(text).not.toContain('finished');
    expect(text).not.toContain('working in');
  }, 60_000);

  it('starts no post-agent command while the implementation turn is running', async () => {
    const fixture = await createFixture();
    // A turn that stays alive for a long moment: a command started while it is
    // running would find its lock held and record that it did.
    const agent = fakeAgent(fixture, { holdMs: 600 });
    const config = configuration(fixture, {
      setup: [],
      checks: [command(fixture, 'check-1')],
    });

    const result = await runTask(request(fixture, config), dependencies(agent.turn));

    expect(result.status).toBe('passed');
    const events = await recordedEvents(fixture);
    expectNoTurnOverlap(events);

    // The turn's own process recorded when it started and finished, and no
    // command of either round ran inside that window.
    const turnStart = events.findIndex((event) => event.event === 'turn-start');
    const turnEnd = events.findIndex((event) => event.event === 'turn-end');
    expect(turnStart).toBeGreaterThan(-1);
    expect(turnEnd).toBeGreaterThan(turnStart);
    expect(events.slice(turnStart, turnEnd).every((event) => event.id === 'turn-1')).toBe(true);
    expect(eventOrder(events)).toEqual([
      'start check-1',
      'end check-1',
      'turn-start turn-1',
      'turn-end turn-1',
      'start check-1',
      'end check-1',
    ]);
  }, 60_000);

  it('does not pass a run whose post-agent checks fail', async () => {
    const fixture = await createFixture();
    const config = configuration(fixture, {
      checks: [
        command(fixture, 'check-1', 'need', 'app.txt', 'committed baseline'),
        command(fixture, 'check-2'),
      ],
    });
    // The turn really breaks the committed state the check verifies, so the same
    // plan that was green before the turn is red after it.
    const agent = fakeAgent(fixture, { mode: 'replace', text: 'broken by the turn\n', holdMs: 0 });

    const result = await runTask(request(fixture, config), dependencies(agent.turn));

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/did not pass/);
    expect(agent.requests).toHaveLength(1);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.baseline?.outcome).toBe('passed');
    // The post-agent round is completed and red: every check ran, and each
    // result is kept as its own evidence.
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');
    expect(report.attempts[0]?.checks?.checks.map((entry) => entry.exitCode)).toEqual([1, 0]);
    expect(await readText(report.attempts[0]?.checks?.checks[0]?.stdoutPath ?? '')).toBe(
      'ran check-1\n',
    );
  }, 60_000);

  it('fails the run when the implementation turn fails, without inventing a round', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(fixture, {
      holdMs: 0,
      logText: 'turn 1: read the task and started working\n',
      failWith: 'the coding runtime exited unexpectedly',
    });

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/implementation turn failed/);

    const report = await readReport(result.reportPath);
    expect(report.baseline?.outcome).toBe('passed');
    expect(report.attempts).toHaveLength(1);
    // No round was observed after the turn, and none is invented for it.
    expect(report.attempts[0]?.checks).toBeNull();
    expect(report.attempts[0]?.agentSummary).toBeNull();
    expect(report.repairsUsed).toBe(0);

    // What the turn wrote before it failed is kept in its own log.
    const agentLog = report.attempts[0]?.agentLog ?? '';
    expect(agentLog).toBe(agentLogPath(runLogsDir(result.reportPath), 1));
    expect(await readText(agentLog)).toContain('read the task and started working');

    // Only the baseline's commands and the turn itself ran.
    expect(eventOrder(await recordedEvents(fixture))).toEqual([
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
      'turn-start turn-1',
      'turn-end turn-1',
    ]);

    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline).toContain(
      'implementation turn result: failed, the coding runtime exited unexpectedly',
    );
    expect(timeline.join('\n')).not.toContain('post-agent check-round');
  }, 60_000);

  it('keeps the loaded plan and task when the turn changes files in the working copy', async () => {
    const fixture = await createFixture();
    const config = configuration(fixture, {
      checks: [command(fixture, 'check-1', 'need', 'app.txt', 'committed baseline')],
    });
    // A configuration copy the turn leaves behind, naming a command that would
    // be visible in the same event file if the runner ever read it.
    const trap: Command = [
      process.execPath,
      fixture.record,
      'workspace-config-check',
      fixture.eventsFile,
      fixture.agentLock,
      'ok',
      '',
      '',
    ];
    const workspaceConfig = `${JSON.stringify({ ...config, checks: [trap] }, null, 2)}\n`;
    const workspaceTask = `${JSON.stringify({ ...TASK, id: 'a different task' }, null, 2)}\n`;
    const agent = fakeAgent(fixture, {
      holdMs: 0,
      logText: 'turn 1: rewriting the configuration it found in the working copy\n',
      extras: [
        { file: 'harness.config.json', text: workspaceConfig },
        { file: 'task.json', text: workspaceTask },
      ],
    });

    const result = await runTask(request(fixture, config), dependencies(agent.turn));

    expect(result.status).toBe('passed');
    // Only the loaded plan ran, twice: the copies the turn left decided nothing.
    const events = await recordedEvents(fixture);
    expect(eventOrder(events)).toEqual([
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
      'turn-start turn-1',
      'turn-end turn-1',
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
    ]);
    expect(events.map((event) => event.id)).not.toContain('workspace-config-check');

    // The turn was given the loaded task, and the report names the loaded plan.
    expect(agent.requests[0]?.task).toEqual(TASK);
    const report = await readReport(result.reportPath);
    expect(report.task).toEqual({ id: TASK.id, title: TASK.title });
    expect(report.baseline?.checks.map((entry) => entry.command)).toEqual(config.checks);
    expect(report.attempts[0]?.checks?.checks.map((entry) => entry.command)).toEqual(config.checks);

    // The copies are still in the working copy, exactly as the turn left them.
    expect(await readText(path.join(result.run.workspacePath, 'harness.config.json'))).toBe(
      workspaceConfig,
    );
    expect(await readText(path.join(result.run.workspacePath, 'task.json'))).toBe(workspaceTask);
  }, 60_000);
});

describe('the collaborators a run is given', () => {
  it('runs the loaded plan through the functions it was handed', async () => {
    const workDir = path.join(await createTempDir(), 'runs');
    const run: RunDirectory = {
      runId: 'run-0001',
      runDir: path.join(workDir, 'run-0001'),
      workspacePath: path.join(workDir, 'run-0001', 'workspace'),
      logsDir: path.join(workDir, 'run-0001', 'logs'),
    };
    const source: SourcePreflight = {
      sourceRoot: path.join(workDir, 'repo'),
      baseCommit: 'a'.repeat(40),
    };
    const workspace: PreparedWorkspace = {
      ...run,
      sourceRoot: source.sourceRoot,
      baseCommit: source.baseCommit,
      branch: `harness/${run.runId}`,
    };
    const task: Task = {
      id: 'tiny-002',
      title: 'A task that never reaches a child process',
      description: 'Nothing here touches the filesystem.',
      acceptanceCriteria: ['The collaborator it was given is the one that ran.'],
    };
    const config: HarnessConfig = {
      workDir,
      maxRepairs: 2,
      taskTimeoutMinutes: 60,
      commandTimeoutMinutes: 10,
      setup: [['a-setup-command']],
      checks: [['a-check-command']],
    };
    const repoPath = path.join('somewhere', 'repo');
    const clock = new Date('2026-01-01T00:00:00.000Z');

    const preflights: PreflightRequest[] = [];
    const allocations: string[] = [];
    const rounds: CheckRoundRequest[] = [];
    const turns: AgentTurnRequest[] = [];
    const reports: RunReportRequest[] = [];
    const baseline: CheckRoundResult = { outcome: 'passed', setup: [], checks: [], problem: null };

    const result = await runTask(
      { task, config, repoPath, workDir },
      {
        preflight: async (asked) => {
          preflights.push(asked);
          return source;
        },
        allocateRunDirectory: async (outputDirectory) => {
          allocations.push(outputDirectory);
          return run;
        },
        prepareWorkspace: async () => workspace,
        runCheckRound: async (asked) => {
          rounds.push(asked);
          return baseline;
        },
        runAgentTurn: async (asked) => {
          turns.push(asked);
          return { summary: 'the stand-in turn is done' };
        },
        openAgentLog: async (logsDir, turn) => ({
          path: agentLogPath(logsDir, turn),
          write: () => undefined,
          close: async () => undefined,
        }),
        appendRunLog: async () => undefined,
        writeRunReport: async (asked) => {
          reports.push(asked);
          return path.join(run.runDir, 'result.json');
        },
        now: () => clock,
      },
    );

    expect(result.status).toBe('passed');
    expect(result.workspace).toBe(workspace);
    expect(result.reason).toBe('every configured check passed after the implementation turn');
    expect(result.reportPath).toBe(path.join(run.runDir, 'result.json'));

    expect(preflights).toEqual([{ repoPath, workDir }]);
    expect(allocations).toEqual([workDir]);

    // Both rounds got the loaded plan itself, in the working copy, with their
    // own log names.
    expect(rounds.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    for (const round of rounds) {
      expect(round.setup).toBe(config.setup);
      expect(round.checks).toBe(config.checks);
      expect(round.cwd).toBe(workspace.workspacePath);
      expect(round.logsDir).toBe(run.logsDir);
    }

    // The turn got the loaded task and the working copy, and its own log.
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn?.kind).toBe('implementation');
    expect(turn?.turn).toBe(1);
    expect(turn?.task).toBe(task);
    expect(turn?.workspacePath).toBe(workspace.workspacePath);
    expect(turn?.sourceRoot).toBe(source.sourceRoot);
    expect(turn?.baseCommit).toBe(source.baseCommit);
    expect(turn?.agentLog.path).toBe(agentLogPath(run.logsDir, 1));

    // The report was asked for with the run's own facts, and the clock it was
    // given decided the run's times.
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report?.run).toBe(run);
    expect(report?.task).toEqual({ id: task.id, title: task.title });
    expect(report?.source).toBe(source);
    expect(report?.workspace).toBe(workspace);
    expect(report?.preparationProblem).toBeNull();
    expect(report?.status).toBe('passed');
    expect(report?.startedAt).toBe(clock.toISOString());
    expect(report?.endedAt).toBe(clock.toISOString());
    expect(report?.baseline).toBe(baseline);
    expect(report?.attempts).toHaveLength(1);
    expect(report?.attempts[0]?.agentSummary).toBe('the stand-in turn is done');
    expect(report?.attempts[0]?.checks).toBe(baseline);
  });
});

/** `<runDir>/logs`, derived from the report path a run returned. */
function runLogsDir(reportPath: string): string {
  return path.join(path.dirname(reportPath), 'logs');
}
