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
 * See docs/tasks.md T06 for the baseline and implementation path, T07 for the
 * bounded repair loop, and T08 for the run's one deadline and the timeout
 * shutdown.
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
import { RunTimeoutError, runTask } from '../src/runner.js';
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
import type {
  CheckRoundResult,
  Command,
  CommandOutcome,
  CommandResult,
  HarnessConfig,
  RunReport,
  Task,
  TerminationOutcome,
} from '../src/types.js';
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

/** A file the fixture's target project commits alongside its baseline. */
interface FixtureFile {
  readonly file: string;
  readonly text: string;
}

/** A temporary target repository with a clean committed baseline. */
async function createFixture(extraFiles: readonly FixtureFile[] = []): Promise<Fixture> {
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
  for (const extra of extraFiles) {
    await writeFile(path.join(repo, extra.file), extra.text, 'utf8');
  }
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
  /** What it says about the turn, in its own words. */
  readonly summary?: string;
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
 *
 * `script` is what every turn does. `byTurn` overrides it for the turns it names,
 * keyed by the top-level turn number — `1` is the implementation and the repairs
 * follow as `2`, `3`, … — which is how a test gives an implementation and a
 * repair different work to do.
 */
function fakeAgent(
  fixture: Fixture,
  script: FakeTurn = {},
  byTurn: Readonly<Record<number, FakeTurn>> = {},
): FakeAgent {
  const requests: AgentTurnRequest[] = [];

  return {
    requests,
    turn: async (agentRequest: AgentTurnRequest): Promise<AgentTurnResult> => {
      requests.push(agentRequest);
      const plan = { ...script, ...(byTurn[agentRequest.turn] ?? {}) };
      const { file = 'app.txt', text = IMPLEMENTED_TEXT, mode = 'append', holdMs = 150 } = plan;
      writeFileSync(fixture.agentLock, 'the coding turn is active\n', 'utf8');
      try {
        for (const extra of plan.extras ?? []) {
          await writeFile(path.join(agentRequest.workspacePath, extra.file), extra.text, 'utf8');
        }
        agentRequest.agentLog.write(
          plan.logText ??
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
        if (plan.failWith !== undefined) {
          throw new Error(plan.failWith);
        }
        return { summary: plan.summary ?? `the implementation turn edited ${file}` };
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
    'repair turn',
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

  it('does not pass a run whose post-agent checks fail, and spends no repair turn when none is allowed', async () => {
    const fixture = await createFixture();
    const config = configuration(fixture, {
      // No repair turn is allowed, so the red round ends the run: that is what
      // `maxRepairs: 0` means, and the repair loop itself is covered below.
      maxRepairs: 0,
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
    // One implementation turn, and no repair turn at all: the allowance was zero.
    expect(agent.requests).toHaveLength(1);
    expect(agent.requests.filter((asked) => asked.kind === 'repair')).toEqual([]);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.baseline?.outcome).toBe('passed');
    expect(report.repairsUsed).toBe(0);
    // The post-agent round is completed and red: every check ran, and each
    // result is kept as its own evidence.
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');
    expect(report.attempts[0]?.checks?.checks.map((entry) => entry.exitCode)).toEqual([1, 0]);
    expect(await readText(report.attempts[0]?.checks?.checks[0]?.stdoutPath ?? '')).toBe(
      'ran check-1\n',
    );

    // Nothing of the repair loop exists for this run: no repair turn in the
    // timeline, no round after the implementation's, and no repair log file.
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
    expect(timeline.some((message) => message.startsWith('repair turn'))).toBe(false);
    expect(existsSync(agentLogPath(result.run.logsDir, 2))).toBe(false);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-2-check-1.stdout.log'))).toBe(false);

    // Two rounds ran and one turn, in order, and nothing else.
    expect(eventOrder(await recordedEvents(fixture))).toEqual([
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

describe('the bounded repair loop', () => {
  it('repairs a red round once, stops at the first green one, and keeps both attempts', async () => {
    const fixture = await createFixture();
    const config = configuration(fixture);
    // The implementation turn really breaks the committed state the check
    // verifies while claiming it is done; the repair turn restores it. What it
    // says is agent text either way, and the checks decide the run.
    const agent = fakeAgent(
      fixture,
      {
        mode: 'replace',
        text: 'broken by the implementation turn\n',
        holdMs: 0,
        summary: 'done — every test passes',
      },
      {
        2: {
          mode: 'replace',
          text: BASELINE_TEXT + IMPLEMENTED_TEXT,
          holdMs: 0,
          summary: 'the repair restored the committed line',
        },
      },
    );

    const result = await runTask(request(fixture, config), dependencies(agent.turn));

    expect(result.status).toBe('passed');
    expect(result.reason).toBe(
      'every configured check passed after repair turn 2 (1 of 2 repair turns used)',
    );

    // Exactly two coding turns: the implementation and the one repair. The run
    // stopped at the green round instead of asking for anything further.
    expect(agent.requests).toHaveLength(2);
    const [implementation, repair] = agent.requests;
    expect(implementation?.kind).toBe('implementation');
    expect(implementation?.turn).toBe(1);
    expect(implementation?.repair).toBeNull();
    expect(repair?.kind).toBe('repair');
    expect(repair?.turn).toBe(2);

    // The repair turn gets the original task context...
    expect(repair?.task).toEqual(fixture.task);
    expect(repair?.task.acceptanceCriteria).toEqual(fixture.task.acceptanceCriteria);
    expect(repair?.workspacePath).toBe(result.run.workspacePath);
    expect(repair?.sourceRoot).toBe(implementation?.sourceRoot);
    expect(repair?.baseCommit).toBe(implementation?.baseCommit);

    // ...and the failures the harness observed for itself, with the output those
    // commands wrote and the log file each part of it is in.
    expect(repair?.repair?.repairedTurn).toBe(1);
    expect(repair?.repair?.failures).toHaveLength(1);
    const failure = repair?.repair?.failures[0];
    expect(failure?.result.command).toEqual(config.checks[0]);
    expect(failure?.result.outcome).toBe('exited');
    expect(failure?.result.exitCode).toBe(1);
    expect(failure?.result.stdoutPath).toBe(
      path.join(result.run.logsDir, 'attempt-1-check-1.stdout.log'),
    );
    expect(failure?.output).toContain(`stdout (${failure?.result.stdoutPath ?? ''}):`);
    expect(failure?.output).toContain(`stderr (${failure?.result.stderrPath ?? ''}):`);
    expect(failure?.output).toContain('ran check-1\n');
    expect(failure?.output).toContain('err check-1');

    // Both turns are in the report, each with its own log and its own summary,
    // and the lying summary of the failed turn sits beside the red round it did
    // not change.
    const report = await readReport(result.reportPath);
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]?.agentSummary).toBe('done — every test passes');
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');
    expect(report.attempts[1]?.agentSummary).toBe('the repair restored the committed line');
    expect(report.attempts[1]?.checks?.outcome).toBe('passed');
    expect(report.attempts[1]?.agentLog).toBe(agentLogPath(result.run.logsDir, 2));

    // The earlier attempt's evidence is still exactly where it was recorded.
    expect(await readText(failure?.result.stdoutPath ?? '')).toBe('ran check-1\n');
    expect(await readText(failure?.result.stderrPath ?? '')).toBe('err check-1\n');
    expect(await readText(report.attempts[0]?.agentLog ?? '')).toContain('turn 1: working in');

    // Two rounds ran after the implementation — setup, then the check, each one
    // after its own turn — and nothing ran after the round that came back green.
    expect(eventOrder(await recordedEvents(fixture))).toEqual([
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
      'turn-start turn-2',
      'turn-end turn-2',
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
    ]);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-3-check-1.stdout.log'))).toBe(false);
    expect(existsSync(agentLogPath(result.run.logsDir, 3))).toBe(false);

    const timeline = timelineMessages(await readText(report.runLog));
    expect(lifecyclePhases(timeline)).toEqual([
      'baseline check-round started',
      'baseline check-round result',
      'implementation turn started',
      'implementation turn result',
      'post-agent check-round started',
      'post-agent check-round result',
      'repair turn 2 started',
      'repair turn 2 result',
      'post-agent check-round started',
      'post-agent check-round result',
      'final status',
    ]);
    expect(timeline).toContain('repair turn 2 started: repair 1 of 2 allowed');
    expect(timeline.at(-1)).toMatch(/^final status: passed, /);
  }, 60_000);

  it('spends at most maxRepairs additional turns and reports the exhausted allowance', async () => {
    const fixture = await createFixture();
    // Every turn breaks what the check verifies, so every round is red and the
    // allowance is what ends the run.
    const agent = fakeAgent(fixture, { mode: 'replace', text: 'still broken\n', holdMs: 0 });

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/the repair allowance is exhausted \(2 of 2 repair turns used\)/);

    // Three coding turns in total — the implementation and two repairs — and no
    // fourth attempt once the allowance is gone.
    expect(agent.requests.map((asked) => `${asked.kind} ${String(asked.turn)}`)).toEqual([
      'implementation 1',
      'repair 2',
      'repair 3',
    ]);
    expect(agent.requests[1]?.repair?.repairedTurn).toBe(1);
    expect(agent.requests[2]?.repair?.repairedTurn).toBe(2);
    // Each repair was sent the round that failed just before it.
    expect(agent.requests[2]?.repair?.failures.map((entry) => entry.result.exitCode)).toEqual([1]);
    expect(agent.requests[2]?.repair?.failures[0]?.result.stdoutPath).toBe(
      path.join(result.run.logsDir, 'attempt-2-check-1.stdout.log'),
    );

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.repairsUsed).toBe(2);
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual([
      'implementation',
      'repair',
      'repair',
    ]);
    expect(report.attempts.map((attempt) => attempt.checks?.outcome)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    // Every turn kept its own log, and every round kept its own output.
    expect(report.attempts.map((attempt) => attempt.agentLog)).toEqual([
      agentLogPath(result.run.logsDir, 1),
      agentLogPath(result.run.logsDir, 2),
      agentLogPath(result.run.logsDir, 3),
    ]);
    for (const attempt of report.attempts) {
      expect(existsSync(attempt.agentLog)).toBe(true);
      expect(await readText(attempt.checks?.checks[0]?.stdoutPath ?? '')).toBe('ran check-1\n');
    }

    // Four rounds in all: the baseline and one after each turn, each running
    // setup and the check, and none after the allowance ran out.
    const events = eventOrder(await recordedEvents(fixture));
    expect(events.filter((event) => event === 'start setup-1')).toHaveLength(4);
    expect(events.filter((event) => event === 'end check-1')).toHaveLength(4);
    expect(events.filter((event) => event.startsWith('turn-start'))).toEqual([
      'turn-start turn-1',
      'turn-start turn-2',
      'turn-start turn-3',
    ]);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-4-check-1.stdout.log'))).toBe(false);

    const timeline = timelineMessages(await readText(report.runLog));
    expect(lifecyclePhases(timeline)).toEqual([
      'baseline check-round started',
      'baseline check-round result',
      'implementation turn started',
      'implementation turn result',
      'post-agent check-round started',
      'post-agent check-round result',
      'repair turn 2 started',
      'repair turn 2 result',
      'post-agent check-round started',
      'post-agent check-round result',
      'repair turn 3 started',
      'repair turn 3 result',
      'post-agent check-round started',
      'post-agent check-round result',
      'final status',
    ]);
    expect(timeline).toContain('repair allowance exhausted: 2 of 2 repair turns used');
    expect(timeline.at(-1)).toMatch(/^final status: failed, /);
  }, 60_000);

  it('stops without another turn when a repair turn itself fails', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(
      fixture,
      { mode: 'replace', text: 'broken by the implementation turn\n', holdMs: 0 },
      {
        2: {
          failWith: 'the coding runtime exited unexpectedly',
          logText: 'turn 2: read the failures, then the runtime died\n',
        },
      },
    );

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/repair turn 2 failed, so no check was run after it/);
    // The failed repair was the last thing the run asked for.
    expect(agent.requests).toHaveLength(2);

    const report = await readReport(result.reportPath);
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');
    // No round was observed after the failed turn, and none is invented for it.
    expect(report.attempts[1]?.checks).toBeNull();
    expect(report.attempts[1]?.agentSummary).toBeNull();
    // What the turn wrote before it failed is kept in its own log...
    expect(await readText(report.attempts[1]?.agentLog ?? '')).toContain('the runtime died');
    // ...and no check round of that attempt exists on disk.
    expect(existsSync(path.join(result.run.logsDir, 'attempt-2-check-1.stdout.log'))).toBe(false);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-3-check-1.stdout.log'))).toBe(false);

    expect(eventOrder(await recordedEvents(fixture))).toEqual([
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
      'turn-start turn-2',
      'turn-end turn-2',
    ]);

    const timeline = timelineMessages(await readText(report.runLog));
    expect(lifecyclePhases(timeline)).toEqual([
      'baseline check-round started',
      'baseline check-round result',
      'implementation turn started',
      'implementation turn result',
      'post-agent check-round started',
      'post-agent check-round result',
      'repair turn 2 started',
      'repair turn 2 result',
      'final status',
    ]);
    expect(timeline).toContain(
      'repair turn 2 result: failed, the coding runtime exited unexpectedly',
    );
  }, 60_000);

  it('stops without another turn when the round after a repair cannot be executed', async () => {
    // The setup command succeeds only while `gate.txt` says "open", which is how
    // a repair turn can break the round that follows it.
    const fixture = await createFixture([{ file: 'gate.txt', text: 'open\n' }]);
    const config = configuration(fixture, {
      setup: [command(fixture, 'setup-1', 'need', 'gate.txt', 'open')],
    });
    // The implementation turn breaks what the check verifies, so the first
    // post-agent round is a completed red one and this repair is sent back. That
    // repair closes the gate, so the round after it cannot run at all.
    const agent = fakeAgent(
      fixture,
      { mode: 'replace', text: 'broken by the implementation turn\n', holdMs: 0 },
      {
        2: {
          mode: 'replace',
          text: BASELINE_TEXT,
          holdMs: 0,
          extras: [{ file: 'gate.txt', text: 'closed\n' }],
          summary: 'the repair fixed the check and closed the gate',
        },
      },
    );

    const result = await runTask(request(fixture, config), dependencies(agent.turn));

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/the checks after repair turn 2 could not be executed/);
    // An infrastructure failure costs no further coding turn.
    expect(agent.requests).toHaveLength(2);

    const report = await readReport(result.reportPath);
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts).toHaveLength(2);
    const observed = report.attempts[1]?.checks;
    expect(observed?.outcome).toBe('execution-error');
    // The check never ran, so it has no result — and the repair turn's claim that
    // it fixed everything stays agent text, not a missing green check.
    expect(observed?.checks).toEqual([]);
    expect(observed?.setup.map((entry) => entry.exitCode)).toEqual([1]);
    expect(observed?.problem).toContain('gate.txt');
    expect(report.attempts[1]?.agentSummary).toBe('the repair fixed the check and closed the gate');
    // The failed setup kept its own output, and the round stopped there.
    expect(await readText(observed?.setup[0]?.stdoutPath ?? '')).toBe('ran setup-1\n');
    expect(await readText(observed?.setup[0]?.stderrPath ?? '')).toBe('err setup-1\n');

    expect(eventOrder(await recordedEvents(fixture))).toEqual([
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
      'turn-start turn-2',
      'turn-end turn-2',
      'start setup-1',
      'end setup-1',
    ]);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-3-check-1.stdout.log'))).toBe(false);

    const timeline = timelineMessages(await readText(report.runLog));
    expect(lifecyclePhases(timeline)).toEqual([
      'baseline check-round started',
      'baseline check-round result',
      'implementation turn started',
      'implementation turn result',
      'post-agent check-round started',
      'post-agent check-round result',
      'repair turn 2 started',
      'repair turn 2 result',
      'post-agent check-round started',
      'post-agent check-round result',
      'final status',
    ]);
    // The timeline says the round could not be executed, naming the command that
    // stopped it — the last post-agent result of the run is that one.
    expect(
      timeline.filter((message) => message.startsWith('post-agent check-round result')).at(-1),
    ).toMatch(/^post-agent check-round result: execution-error, setup command 1 of 1 /);
  }, 60_000);
});

/**
 * A clock a test moves by hand. The run reads the time from it, so its one
 * deadline is fixed the moment the run starts and a stand-in for a phase that
 * takes time moves the clock forward by the time it would have taken. Nothing in
 * this block waits for a configured limit: an hour of budget is spent by saying so.
 */
interface TestClock {
  /** The current time, as the runner reads it. */
  readonly now: () => Date;
  /** Moves the clock forward by what the phase that just ran would have taken. */
  advance(ms: number): void;
}

/** The moment every run in this block starts at. */
const CLOCK_START = new Date('2026-03-01T00:00:00.000Z');

function testClock(): TestClock {
  let offset = 0;
  return {
    now: () => new Date(CLOCK_START.getTime() + offset),
    advance: (ms: number): void => {
      offset += ms;
    },
  };
}

/** A configured limit, in the unit the configuration names it in. */
function minutes(count: number): number {
  return count * 60_000;
}

/** How long a stand-in turn that was never asked to stop is waited for, in total. */
const STOP_FALLBACK_MS = 15_000;

/** What a stand-in round reports about one command of it. */
interface StandInCommand {
  /** Named in its command and in the files its output was written to. */
  readonly label: string;
  /** How it ended; `exited`, which is the default, is how a check passes or fails. */
  readonly outcome?: CommandOutcome;
  /** The exit code of a command that ran, defaulting to the one its outcome implies. */
  readonly exitCode?: number | null;
  /** The limit it ran under: the smaller of its configured limit and the task time left. */
  readonly timeoutMs?: number;
  /** How anything it started was stopped; `null` when nothing was stopped. */
  readonly termination?: TerminationOutcome | null;
  /** What could not be confirmed about that stop, if anything. */
  readonly terminationProblem?: string | null;
}

/**
 * One command's result, with the output files it points at really written: a red
 * round's failures are read back from disk for the repair turn, so a stand-in
 * round that is red has to leave the output it claims behind.
 */
async function standInCommand(
  where: { readonly cwd: string; readonly logsDir: string },
  parts: StandInCommand,
): Promise<CommandResult> {
  const stdoutPath = path.join(where.logsDir, `${parts.label}.stdout.log`);
  const stderrPath = path.join(where.logsDir, `${parts.label}.stderr.log`);
  await writeFile(stdoutPath, `${parts.label} wrote this\n`, 'utf8');
  await writeFile(stderrPath, '', 'utf8');
  const outcome = parts.outcome ?? 'exited';
  return {
    command: ['a-stand-in-command', parts.label],
    cwd: where.cwd,
    startedAt: CLOCK_START.toISOString(),
    endedAt: CLOCK_START.toISOString(),
    outcome,
    exitCode: parts.exitCode ?? (outcome === 'exited' ? 0 : null),
    signal: null,
    launchError: null,
    timeoutMs: parts.timeoutMs ?? minutes(10),
    termination: parts.termination ?? null,
    terminationProblem: parts.terminationProblem ?? null,
    stdoutPath,
    stderrPath,
  };
}

/** A round that ran every configured check and passed. */
function passedRound(): CheckRoundResult {
  return { outcome: 'passed', setup: [], checks: [], problem: null };
}

/** A completed red round: one check that exited nonzero, which is repair feedback. */
function redRound(failed: CommandResult): CheckRoundResult {
  return { outcome: 'failed', setup: [], checks: [failed], problem: null };
}

/** A round that stopped early because one of its commands was stopped at its limit. */
function stoppedRound(
  stopped: CommandResult,
  parts: { readonly as: 'setup' | 'check'; readonly problem: string },
): CheckRoundResult {
  return {
    outcome: 'execution-error',
    setup: parts.as === 'setup' ? [stopped] : [],
    checks: parts.as === 'check' ? [stopped] : [],
    problem: parts.problem,
  };
}

/** A stand-in for the configured plan: it records what it was asked, and answers. */
function standInRounds(
  answer: (request: CheckRoundRequest) => Promise<CheckRoundResult> | CheckRoundResult,
): { readonly requests: CheckRoundRequest[]; readonly run: RunnerDependencies['runCheckRound'] } {
  const requests: CheckRoundRequest[] = [];
  return {
    requests,
    run: async (asked) => {
      requests.push(asked);
      return answer(asked);
    },
  };
}

/** A stand-in for the coding turn: it records what it was told, and answers. */
function standInTurns(
  answer: (request: AgentTurnRequest) => Promise<AgentTurnResult> | AgentTurnResult,
): { readonly requests: AgentTurnRequest[]; readonly run: RunnerDependencies['runAgentTurn'] } {
  const requests: AgentTurnRequest[] = [];
  return {
    requests,
    run: async (asked) => {
      requests.push(asked);
      return answer(asked);
    },
  };
}

/**
 * Waits for the runner's stop request, and for nothing else: a turn that only
 * stops when it is asked to. The fallback bounds the test rather than the run, so
 * a stop request that never arrives fails the assertions instead of hanging.
 */
function awaitStop(request: AgentTurnRequest): Promise<void> {
  return new Promise((resolve) => {
    if (request.stop.aborted) {
      resolve();
      return;
    }
    request.stop.addEventListener('abort', () => resolve(), { once: true });
    setTimeout(resolve, STOP_FALLBACK_MS).unref();
  });
}

describe('a run that runs out of task time', () => {
  it('spends one budget from preparation through the repair turns', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 60, maxRepairs: 2 });

    // What the run's one hour is spent on: ten minutes of baseline, fifteen of
    // implementation, ten more of checks that come back red, fifteen of repair,
    // and five of the checks that then pass.
    const leftAt: number[] = [];
    const rounds = standInRounds(async (asked) => {
      leftAt.push(asked.deadlineMs - asked.now().getTime());
      clock.advance(minutes(asked.name === 'attempt-2' ? 5 : 10));
      return asked.name === 'attempt-1'
        ? redRound(
            await standInCommand(
              { cwd: asked.cwd, logsDir: asked.logsDir },
              { label: 'stand-in-check', exitCode: 1 },
            ),
          )
        : passedRound();
    });
    const turns = standInTurns((asked) => {
      clock.advance(minutes(15));
      return { summary: `turn ${String(asked.turn)} did its work` };
    });
    const bounds: number[] = [];

    const result = await runTask(
      request(fixture, config),
      dependencies(turns.run, {
        now: clock.now,
        runCheckRound: rounds.run,
        prepareWorkspace: async (run, source, given) => {
          bounds.push(given.deadlineMs);
          return prepareWorkspace(run, source, given);
        },
      }),
    );

    expect(result.status).toBe('passed');
    expect(result.timeout).toBeNull();

    // One deadline, established before preparation and handed to every phase
    // afterwards — the repair turn included.
    const deadline = CLOCK_START.getTime() + minutes(60);
    expect(bounds).toEqual([deadline]);
    expect(rounds.requests.map((round) => round.name)).toEqual([
      'baseline',
      'attempt-1',
      'attempt-2',
    ]);
    expect(rounds.requests.map((round) => round.deadlineMs)).toEqual([
      deadline,
      deadline,
      deadline,
    ]);
    expect(rounds.requests.map((round) => round.commandTimeoutMs)).toEqual([
      minutes(10),
      minutes(10),
      minutes(10),
    ]);
    for (const round of rounds.requests) {
      expect(round.now).toBe(clock.now);
    }

    // What each round had left of that budget: less every time, because what
    // preparation and the turns spent is not handed back to a later round.
    expect(leftAt).toEqual([minutes(60), minutes(35), minutes(10)]);
    // No turn was stopped: everything fitted in the budget it was given.
    expect(turns.requests.map((turn) => turn.stop.aborted)).toEqual([false, false]);
    expect(turns.requests[1]?.kind).toBe('repair');

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('passed');
    expect(report.timeout).toBeNull();
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts.map((attempt) => attempt.checks?.outcome)).toEqual(['failed', 'passed']);
    expect(existsSync(path.join(result.run.workspacePath, '.git'))).toBe(true);
    expect(timelineMessages(await readText(report.runLog))).toContain(
      `task deadline set for ${new Date(deadline).toISOString()}: 3600000 ms of total task time, 600000 ms per configured command`,
    );
  }, 60_000);

  it('stops the baseline when the task time that was left is the smaller limit', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 60 });
    const turns = standInTurns(() => ({ summary: 'never reached' }));
    const rounds = standInRounds(async (asked) =>
      stoppedRound(
        await standInCommand(
          { cwd: asked.cwd, logsDir: asked.logsDir },
          {
            label: 'stand-in-setup',
            outcome: 'timed-out',
            timeoutMs: minutes(4),
            termination: 'confirmed',
          },
        ),
        { as: 'setup', problem: 'the setup command was stopped at the 4 minutes it was given' },
      ),
    );

    const result = await runTask(
      request(fixture, config),
      dependencies(turns.run, { now: clock.now, runCheckRound: rounds.run }),
    );

    expect(result.status).toBe('failed');
    // Four minutes is less than the configured ten, so the task time that was
    // left is the limit that expired — and the record names that, not the command's.
    expect(result.timeout).toEqual({
      limit: 'task',
      phase: 'the baseline checks',
      limitMs: minutes(4),
      elapsedMs: 0,
      termination: 'confirmed',
      problem: null,
    });
    expect(result.reason).toMatch(
      /task deadline expired during the baseline checks: nothing further was started/,
    );
    // A stopped command is an execution failure, not a red round to repair, and
    // nothing at all follows it.
    expect(turns.requests).toEqual([]);
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline']);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.timeout).toEqual(result.timeout);
    expect(report.baseline?.outcome).toBe('execution-error');
    expect(report.baseline?.setup[0]?.outcome).toBe('timed-out');
    expect(report.attempts).toEqual([]);
    // The evidence is kept: the stopped command's own output file is still there.
    expect(existsSync(report.baseline?.setup[0]?.stdoutPath ?? '')).toBe(true);
    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline).toContain(
      "timeout: the run's task deadline (240000 ms) expired during the baseline checks",
    );
    expect(timeline.at(-1)).toMatch(/^final status: failed, the run's task deadline expired/);
  }, 60_000);

  it('stops the run at a command limit without confirming the stop, and starts nothing further', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { maxRepairs: 2 });
    const agent = fakeAgent(fixture);
    const rounds = standInRounds(async (asked) =>
      asked.name === 'baseline'
        ? passedRound()
        : stoppedRound(
            await standInCommand(
              { cwd: asked.cwd, logsDir: asked.logsDir },
              {
                label: 'stand-in-check',
                outcome: 'timed-out',
                timeoutMs: minutes(10),
                termination: 'unconfirmed',
                terminationProblem: 'the invocation was still running 5000 ms after it was stopped',
              },
            ),
            {
              as: 'check',
              problem: 'the check was stopped at its limit and could not be confirmed',
            },
          ),
    );

    const result = await runTask(
      request(fixture, config),
      dependencies(agent.turn, { now: clock.now, runCheckRound: rounds.run }),
    );

    expect(result.status).toBe('failed');
    // Ten minutes is exactly the configured limit, so that is the limit that
    // expired — the task time left was not the smaller of the two.
    expect(result.timeout).toEqual({
      limit: 'command',
      phase: 'the checks after the implementation turn',
      limitMs: minutes(10),
      elapsedMs: 0,
      termination: 'unconfirmed',
      problem: 'the invocation was still running 5000 ms after it was stopped',
    });
    expect(result.reason).toMatch(
      /a configured command was stopped at its limit during the checks after the implementation turn/,
    );
    expect(result.reason).toMatch(
      /the stop could not be confirmed, so the working copy must not be reused/,
    );

    // No second round and no repair turn: a working copy something may still be
    // writing to is not checked again, and the red round is not handed to anyone.
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    expect(agent.requests.map((turn) => turn.turn)).toEqual([1]);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.timeout).toEqual(result.timeout);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.checks?.checks[0]?.termination).toBe('unconfirmed');
    expect(report.attempts[0]?.agentSummary).toBe('the implementation turn edited app.txt');
    // The working copy and the evidence it holds are retained, and the reason
    // above is what keeps them from being read as safe to reuse.
    expect(existsSync(path.join(result.run.workspacePath, '.git'))).toBe(true);
    expect(existsSync(report.attempts[0]?.agentLog ?? '')).toBe(true);
    expect(timelineMessages(await readText(report.runLog))).toContain(
      'timeout: a configured command limit (600000 ms) expired during the checks after the implementation turn' +
        '; termination unconfirmed: the invocation was still running 5000 ms after it was stopped',
    );
  }, 60_000);

  it('explains an unconfirmed stop it was given no reason for', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { maxRepairs: 2 });
    const agent = fakeAgent(fixture);
    const rounds = standInRounds(async (asked) =>
      asked.name === 'baseline'
        ? passedRound()
        : stoppedRound(
            await standInCommand(
              { cwd: asked.cwd, logsDir: asked.logsDir },
              {
                label: 'stand-in-check',
                outcome: 'timed-out',
                timeoutMs: minutes(10),
                termination: 'unconfirmed',
              },
            ),
            { as: 'check', problem: 'the check was stopped at its limit' },
          ),
    );

    const result = await runTask(
      request(fixture, config),
      dependencies(agent.turn, { now: clock.now, runCheckRound: rounds.run }),
    );

    // An unconfirmed stop is stated rather than left bare: the report cannot hold
    // one without a reason, so the runner supplies the one it has.
    expect(result.timeout?.termination).toBe('unconfirmed');
    expect(result.timeout?.problem).toBe('the harness recorded no reason for the unconfirmed stop');
    const report = await readReport(result.reportPath);
    expect(report.timeout).toEqual(result.timeout);
  }, 60_000);

  it('stops and awaits an implementation turn that is still running when the run is out of time', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 1, maxRepairs: 2 });
    let returned = false;
    const rounds = standInRounds(() => {
      // The baseline spends all of the run's one minute but a moment.
      clock.advance(minutes(1) - 300);
      return passedRound();
    });
    const turns = standInTurns(async (asked) => {
      await awaitStop(asked);
      asked.agentLog.write('the turn was asked to stop and stopped\n');
      returned = true;
      return { summary: 'stopped when the run ran out of time' };
    });

    const result = await runTask(
      request(fixture, config),
      dependencies(turns.run, { now: clock.now, runCheckRound: rounds.run }),
    );

    expect(result.status).toBe('failed');
    expect(turns.requests).toHaveLength(1);
    expect(turns.requests[0]?.stop.aborted).toBe(true);
    // The turn was awaited to its own return before the run was finalized, and
    // what it said about the stopped turn is kept as its evidence.
    expect(returned).toBe(true);

    expect(result.timeout).toEqual({
      limit: 'task',
      phase: 'implementation turn',
      limitMs: minutes(1),
      elapsedMs: minutes(1) - 300,
      termination: 'confirmed',
      problem: null,
    });
    expect(result.reason).toMatch(
      /implementation turn was stopped when the run's remaining task time ran out, so no check was run after it and no further turn was started/,
    );

    const report = await readReport(result.reportPath);
    expect(report.timeout).toEqual(result.timeout);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.checks).toBeNull();
    expect(report.attempts[0]?.agentSummary).toBe('stopped when the run ran out of time');
    // Neither a check round after the stopped turn nor a repair turn was started.
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline.join('\n')).not.toContain('post-agent check-round');
    expect(timeline.at(-1)).toMatch(/^final status: failed, the implementation turn was stopped/);
    // The turn's log is closed rather than lost, and keeps what it wrote.
    expect(await readText(report.attempts[0]?.agentLog ?? '')).toContain(
      'the turn was asked to stop and stopped',
    );
  }, 60_000);

  it('stops and awaits a repair turn that is still running when the run is out of time', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 1, maxRepairs: 2 });
    const rounds = standInRounds(async (asked) => {
      if (asked.name === 'baseline') {
        clock.advance(minutes(1) - 20_000);
        return passedRound();
      }
      // The round after the implementation is red, and leaves a moment of the run.
      clock.advance(19_750);
      return redRound(
        await standInCommand(
          { cwd: asked.cwd, logsDir: asked.logsDir },
          { label: 'stand-in-check', exitCode: 1 },
        ),
      );
    });
    const turns = standInTurns(async (asked) => {
      if (asked.turn === 1) {
        return { summary: 'the implementation turn did its work' };
      }
      await awaitStop(asked);
      return { summary: 'the repair turn stopped when the run ran out of time' };
    });

    const result = await runTask(
      request(fixture, config),
      dependencies(turns.run, { now: clock.now, runCheckRound: rounds.run }),
    );

    expect(result.status).toBe('failed');
    expect(turns.requests.map((turn) => [turn.turn, turn.kind])).toEqual([
      [1, 'implementation'],
      [2, 'repair'],
    ]);
    // The repair turn was given the red round it repairs, and was stopped by the
    // same deadline every other phase spends.
    expect(turns.requests[1]?.repair?.repairedTurn).toBe(1);
    expect(turns.requests[1]?.repair?.failures[0]?.output).toContain('stand-in-check wrote this');
    expect(turns.requests[0]?.stop.aborted).toBe(false);
    expect(turns.requests[1]?.stop.aborted).toBe(true);

    expect(result.timeout?.limit).toBe('task');
    expect(result.timeout?.phase).toBe('repair turn 2');
    expect(result.timeout?.limitMs).toBe(minutes(1));
    expect(result.reason).toMatch(
      /repair turn 2 was stopped when the run's remaining task time ran out, so no check was run after it and no further turn was started/,
    );
    // The red round the repair turn was repairing is kept as that turn's evidence,
    // even though no round was observed after it.
    const report = await readReport(result.reportPath);
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts.map((attempt) => [attempt.turn, attempt.checks === null])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    expect(report.timeout).toEqual(result.timeout);
  }, 60_000);

  it('stops a run whose preparation runs past the deadline, and keeps what was made', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 1 });
    const agent = fakeAgent(fixture);

    const result = await runTask(
      request(fixture, config),
      dependencies(agent.turn, {
        now: clock.now,
        prepareWorkspace: async (run, source, given) => {
          // The run's time is gone from the moment preparation starts, as if Git
          // had taken the whole budget: the real preparation stops itself on the
          // deadline the runner handed it, and the runner records why.
          clock.advance(minutes(1) + 5_000);
          return prepareWorkspace(run, source, given);
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.workspace).toBeNull();
    expect(result.timeout).toEqual({
      limit: 'task',
      phase: 'preparation of the working copy',
      limitMs: minutes(1),
      elapsedMs: minutes(1) + 5_000,
      termination: 'confirmed',
      problem: null,
    });
    expect(result.reason).toMatch(
      /task deadline expired while the working copy was being prepared, so no check and no coding turn was started/,
    );
    expect(agent.requests).toEqual([]);

    // The run directory that was made is kept, with the evidence of what stopped
    // preparation in it — and no working copy is claimed.
    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.timeout).toEqual(result.timeout);
    expect(report.workspace.prepared).toBe(false);
    expect(report.workspace.branch).toBeNull();
    expect(report.workspace.problem).toMatch(
      /task deadline passed 5000 ms before the destination check/,
    );
    expect(existsSync(result.run.runDir)).toBe(true);
    expect(existsSync(result.run.logsDir)).toBe(true);
    expect(await readText(report.runLog)).toMatch(
      /workspace preparation failed: .*task deadline passed 5000 ms before the destination check/,
    );
  }, 60_000);

  it('refuses a run whose task time is gone before a run directory exists', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 1 });
    const agent = fakeAgent(fixture);
    const preflights: PreflightRequest[] = [];

    const attempt = runTask(
      request(fixture, config),
      dependencies(agent.turn, {
        // Checking the source is what takes the whole minute. Nothing of the run
        // exists yet, so there is nothing to report and nothing to keep.
        preflight: async (asked) => {
          preflights.push(asked);
          clock.advance(minutes(1));
          return preflightSource(asked);
        },
        now: clock.now,
      }),
    );

    await expect(attempt).rejects.toThrow(RunTimeoutError);
    await expect(attempt).rejects.toThrow(/before any run directory was allocated/);
    await expect(attempt).rejects.toThrow(
      /No run directory, no working copy, and no report were created/,
    );
    expect(preflights).toEqual([{ repoPath: fixture.repo, workDir: fixture.workDir }]);
    expect(agent.requests).toEqual([]);
    // Refused rather than reported: no run directory was made, so no report was
    // invented for a run that never started.
    expect(existsSync(fixture.workDir)).toBe(false);
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
    expect(turn?.repair).toBeNull();

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
