/**
 * The runner fixture both loop suites share: one temporary Git repository the
 * run clones, a substitute coding agent that records every turn, the harness
 * configuration and request every case varies, the helpers that read a run back,
 * and the stand-in clock and rounds the repair, deadline and stop cases drive.
 * Nothing here starts a provider; the checks and Git commands are real.
 */
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

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import { runCheckRound } from '../../src/checks/round.js';
import type { CheckRoundRequest } from '../../src/checks/round.js';

import { appendRunLog, openAgentLog } from '../../src/reporting/logs.js';
import { writeRunReport } from '../../src/reporting/report.js';

import type {
  AgentTurnRequest,
  AgentTurnResult,
  RunnerDependencies,
} from '../../src/runs/contracts.js';
import { runTask as runTaskThrough } from '../../src/runs/runner.js';
import type {
  CheckRoundResult,
  Command,
  CommandOutcome,
  CommandResult,
  HarnessConfig,
  RunReport,
  SourceRef,
  Task,
  TerminationOutcome,
} from '../../src/shared/types.js';

import { returnToRecordedBranch } from '../../src/workspace/branch.js';
import { configureWorkspaceIdentity } from '../../src/workspace/git.js';
import { prepareWorkspace } from '../../src/workspace/prepare.js';

import { preflightSource } from '../../src/workspace/preflight.js';

import type { WorkspaceExpectation } from '../../src/workspace/reopen.js';

import { allocateRunDirectory } from '../../src/workspace/run-directory.js';

import { readWorkspaceState, recordWorkspaceAttempt } from '../../src/workspace/state.js';
import { createTempDir } from '../support.js';
import { gitFixtureEnvironment } from './git.js';
import { runProcess, useFixtureLifecycle } from './lifecycle.js';
import { combineStop, ownFixtureOperation } from './lifecycle.js';
import type { ProcessResult } from './lifecycle.js';

useFixtureLifecycle();

/**
 * One task through the runner, owned by the test that asked for it.
 *
 * The run is registered work of the test's fixture scope and takes the test's
 * own stop alongside the one the request carries: a run whose test times out,
 * fails or is cancelled is stopped and awaited before any directory it was
 * writing into is removed, and a run asked for after disposal began is refused
 * rather than started behind the cleanup hook. Everything else about the call is
 * the production runner's own.
 */
export function runTask(
  request: Parameters<typeof runTaskThrough>[0],
  dependencies: RunnerDependencies,
): ReturnType<typeof runTaskThrough> {
  return ownFixtureOperation(
    'the run',
    async (own) =>
      await runTaskThrough({ ...request, stop: combineStop(own, request.stop) }, dependencies),
  );
}

/**
 * A private Git environment for the fixtures: the developer's own hooks,
 * signing, ignore rules, and identity must not change what the tests observe.
 */
export let fixtureEnvironment: NodeJS.ProcessEnv = {};

/**
 * The fixture's empty global Git configuration, as a file: a commit made inside a
 * turn runs with this as `GIT_CONFIG_GLOBAL` and no author or committer variables,
 * so the only identity it can use is the one the run configured in the working
 * copy.
 */
export let emptyGlobalConfig = '';

/**
 * Prepares the private Git environment for one test, and the empty global Git
 * configuration a commit made inside a turn runs with.
 */
export async function beginRunnerFixtureEnvironment(): Promise<void> {
  const directory = await createTempDir();
  const emptyConfig = path.join(directory, 'empty.gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  emptyGlobalConfig = emptyConfig;
  fixtureEnvironment = await gitFixtureEnvironment();
}

/** Runs `git` with literal arguments in the fixture environment. */
export function git(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return runProcess('git', args, { cwd, env: fixtureEnvironment });
}

/** Runs `git` and fails the test when it does not succeed. */
export async function gitOrFail(args: readonly string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * The environment a commit made inside a fixture coding turn runs with: no
 * author or committer variables, and no system or global Git configuration. The
 * only identity such a commit can use is the repository-local one the run
 * configured in the working copy, so a commit that succeeds here is evidence of
 * that configuration rather than of this machine's own Git setup.
 */
export function workspaceCommitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ]) {
    delete environment[name];
  }
  return environment;
}

/**
 * One configured setup/check command. It records when it started and ended,
 * reports whether the coding turn held its lock file at that moment, and decides
 * its own exit code from the mode it was given: `ok` always succeeds, `fail`
 * always fails, and `need` succeeds when `file` in the current directory
 * contains `text` — which is how a check observes what a turn really did.
 */
export const RECORD_SOURCE = [
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
export const TURN_SOURCE = [
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
export const BASELINE_TEXT = 'the committed baseline\n';

/** What the stand-in turn appends to that file unless a test says otherwise. */
export const IMPLEMENTED_TEXT = 'a line from the implementation\n';

/** The task every fixture run is asked to complete. */
export const TASK: Task = {
  id: 'tiny-001',
  title: 'Append a line to app.txt',
  description: 'Add one line to the target project using its existing conventions.',
  acceptanceCriteria: ['app.txt keeps its committed content.', 'app.txt holds the new line.'],
};

export interface Fixture {
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
export interface FixtureFile {
  readonly file: string;
  readonly text: string;
}

/** A temporary target repository with a clean committed baseline. */
export async function createFixture(extraFiles: readonly FixtureFile[] = []): Promise<Fixture> {
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
export type Mode = 'ok' | 'fail' | 'need';

/** One configured command: the recording program in one of its modes. */
export function command(
  fixture: Fixture,
  id: string,
  mode: Mode = 'ok',
  file = '',
  text = '',
): Command {
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
export function configuration(fixture: Fixture, parts: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    workDir: fixture.workDir,
    maxRepairs: 2,
    taskTimeoutMinutes: 60,
    commandTimeoutMinutes: 10,
    setup: [command(fixture, 'setup-1')],
    checks: [command(fixture, 'check-1', 'need', 'app.txt', 'committed baseline')],
    // These runs stand in for the coding turn, so the launch the configuration
    // selected is the documented default: recorded, never started here.
    agent: { runtime: 'codex', command: ['codex'] },
    ...parts,
  };
}

/** What one run is asked to do: the loaded task, the loaded plan, and the paths. */
export function request(fixture: Fixture, config: HarnessConfig): Parameters<typeof runTask>[0] {
  return { task: fixture.task, config, repoPath: fixture.repo, workDir: fixture.workDir };
}

/** The source item the continuation tests' first attempt came from. */
export const SOURCE_REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'SAM1-11',
  url: 'https://example.atlassian.net/browse/SAM1-11',
  updatedAt: '2026-09-16T11:00:00.000Z',
};

/**
 * What a continuation of the fixture's own workspace must match, as its ledger
 * records it. These tests are about the runner's continuation mechanics; the
 * identity check itself has its own tests.
 */
export async function expectationFor(
  fixture: Fixture,
  workspaceId: string,
): Promise<WorkspaceExpectation> {
  const ledger = await readWorkspaceState(fixture.workDir, workspaceId);
  if (ledger === null || ledger.sourceItem === null) {
    throw new Error('the fixture workspace recorded no source item identity');
  }
  return { sourceItem: ledger.sourceItem, sourceRoot: ledger.sourceRoot };
}

/**
 * The runner's real collaborators, with the coding turn — and anything else a
 * test names — replaced by that test's own.
 */
export function dependencies(
  agent: RunnerDependencies['runAgentTurn'],
  parts: Partial<RunnerDependencies> = {},
): RunnerDependencies {
  return {
    preflight: preflightSource,
    allocateRunDirectory,
    prepareWorkspace,
    configureWorkspaceIdentity,
    returnToRecordedBranch,
    recordWorkspaceAttempt,
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
export interface FakeTurn {
  /** The file it edits in the working copy, relative to the working copy. */
  readonly file?: string;
  /** What it writes there. */
  readonly text?: string;
  /** Whether it appends to that file or replaces it. */
  readonly mode?: 'append' | 'replace';
  /** Extra files it leaves in the working copy, standing in for its work. */
  readonly extras?: readonly { readonly file: string; readonly text: string }[];
  /**
   * Pieces the turn commits in the working copy before it ends: each is written,
   * staged, and committed with no author/committer variables and no global Git
   * configuration, so it is a real local commit under the identity the run
   * configured in the workspace.
   */
  readonly commits?: readonly {
    readonly file: string;
    readonly text: string;
    readonly message: string;
  }[];
  /**
   * A message the turn commits its whole working copy with, once its own process
   * has finished: everything it changed is staged and committed, the way a real
   * turn finishes the work it wants the next turn to build on. A turn is followed
   * by another coding turn only from committed state (HARN-35), so a plan whose
   * turn the run repairs names this.
   */
  readonly commit?: string;
  /** Text it writes to its agent log before its process starts. */
  readonly logText?: string;
  /** How long its process stays alive while it works, in milliseconds. */
  readonly holdMs?: number;
  /** Its own failure: the turn rejects after its process exited. */
  readonly failWith?: string;
  /** What it says about the turn, in its own words. */
  readonly summary?: string;
}

export interface FakeAgent {
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
export function fakeAgent(
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
        for (const checkpoint of plan.commits ?? []) {
          await writeFile(
            path.join(agentRequest.workspacePath, checkpoint.file),
            checkpoint.text,
            'utf8',
          );
          const staged = await runProcess('git', ['add', '--', checkpoint.file], {
            cwd: agentRequest.workspacePath,
            env: workspaceCommitEnvironment(),
          });
          if (staged.code !== 0) {
            throw new Error(`the turn could not stage ${checkpoint.file}: ${staged.stderr.trim()}`);
          }
          const committed = await runProcess(
            'git',
            ['commit', '--quiet', '--message', checkpoint.message],
            { cwd: agentRequest.workspacePath, env: workspaceCommitEnvironment() },
          );
          if (committed.code !== 0) {
            throw new Error(
              `the turn could not commit ${checkpoint.file}: ${committed.stderr.trim()}`,
            );
          }
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
          // A turn that did not finish does not commit its work: what it left is
          // exactly what the run keeps for it.
          throw new Error(plan.failWith);
        }
        if (plan.commit !== undefined) {
          await commitEverything(agentRequest.workspacePath, plan.commit);
        }
        return { summary: plan.summary ?? `the implementation turn edited ${file}` };
      } finally {
        rmSync(fixture.agentLock, { force: true });
      }
    },
  };
}

export interface RecordedEvent {
  readonly event: 'start' | 'end' | 'turn-start' | 'turn-end';
  readonly id: string;
  /** Whether the coding turn's lock was held when a command started. */
  readonly agentActive?: boolean;
  /** Whether a command decided it passed. */
  readonly passed?: boolean;
}

/**
 * Commits everything a stand-in turn left in `workspacePath`, under the identity
 * the run configured there: the state a turn the run goes on to repair has to
 * look like (HARN-35). A turn whose working copy already matches what is
 * committed has nothing to add, and that is not a failure: the state it was asked
 * for already holds.
 */
export async function commitEverything(workspacePath: string, message: string): Promise<void> {
  const staged = await runProcess('git', ['add', '--all'], {
    cwd: workspacePath,
    env: workspaceCommitEnvironment(),
  });
  if (staged.code !== 0) {
    throw new Error(`the turn could not stage its work: ${staged.stderr.trim()}`);
  }
  const changed = await runProcess('git', ['diff', '--cached', '--quiet'], {
    cwd: workspacePath,
    env: workspaceCommitEnvironment(),
  });
  if (changed.code === 0) {
    return;
  }
  if (changed.code !== 1) {
    throw new Error(`the turn could not read its staged work: ${changed.stderr.trim()}`);
  }
  const committed = await runProcess('git', ['commit', '--quiet', '--message', message], {
    cwd: workspacePath,
    env: workspaceCommitEnvironment(),
  });
  if (committed.code !== 0) {
    throw new Error(`the turn could not commit its work: ${committed.stderr.trim()}`);
  }
}

/** Every record the fixture processes wrote, in the order they wrote them. */
export async function recordedEvents(fixture: Fixture): Promise<RecordedEvent[]> {
  if (!existsSync(fixture.eventsFile)) {
    return [];
  }
  return (await readFile(fixture.eventsFile, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedEvent);
}

/** `event id` for every record: the whole run as one ordered list. */
export function eventOrder(events: readonly RecordedEvent[]): string[] {
  return events.map((event) => `${event.event} ${event.id}`);
}

/**
 * Asserts that no configured command started while the coding turn was running.
 * The commands report the turn's lock file as they found it, so this reads what
 * the child processes observed, not what the runner intended.
 */
export function expectNoTurnOverlap(events: readonly RecordedEvent[]): void {
  const starts = events.filter((event) => event.event === 'start');
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts) {
    expect(start.agentActive).toBe(false);
  }
}

/** The written report, parsed: these tests read what a run left on disk. */
export async function readReport(file: string): Promise<RunReport> {
  return JSON.parse(await readFile(file, 'utf8')) as RunReport;
}

export function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

/** The timeline's messages, without the timestamp each line starts with. */
export function timelineMessages(text: string): string[] {
  return text
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^\S+ /, ''));
}

/** The lifecycle phases the timeline recorded, in the order it recorded them. */
export function lifecyclePhases(messages: readonly string[]): string[] {
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

export interface TestClock {
  /** The current time, as the runner reads it. */
  readonly now: () => Date;
  /** Moves the clock forward by what the phase that just ran would have taken. */
  advance(ms: number): void;
}

/** The moment every run in this block starts at. */
export const CLOCK_START = new Date('2026-03-01T00:00:00.000Z');

export function testClock(): TestClock {
  let offset = 0;
  return {
    now: () => new Date(CLOCK_START.getTime() + offset),
    advance: (ms: number): void => {
      offset += ms;
    },
  };
}

/** A configured limit, in the unit the configuration names it in. */
export function minutes(count: number): number {
  return count * 60_000;
}

/** How long a stand-in turn that was never asked to stop is waited for, in total. */
export const STOP_FALLBACK_MS = 15_000;

/** What a stand-in round reports about one command of it. */
export interface StandInCommand {
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
export async function standInCommand(
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
export function passedRound(): CheckRoundResult {
  return { outcome: 'passed', setup: [], checks: [], problem: null };
}

/** A completed red round: one check that exited nonzero, which is repair feedback. */
export function redRound(failed: CommandResult): CheckRoundResult {
  return { outcome: 'failed', setup: [], checks: [failed], problem: null };
}

/** A round that stopped early because one of its commands was stopped at its limit. */
export function stoppedRound(
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
export function standInRounds(
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
export function standInTurns(
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
export function awaitStop(request: AgentTurnRequest): Promise<void> {
  return new Promise((resolve) => {
    if (request.stop.aborted) {
      resolve();
      return;
    }
    request.stop.addEventListener('abort', () => resolve(), { once: true });
    setTimeout(resolve, STOP_FALLBACK_MS).unref();
  });
}

export interface TimerSpy {
  /** The timers created while the spy was installed that were not cleared. */
  pending(): NodeJS.Timeout[];
  /** Puts the host's own timers back. */
  restore(): void;
}

export function spyTimers(): TimerSpy {
  const created = new Set<NodeJS.Timeout>();
  const cleared = new Set<NodeJS.Timeout>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  const spiedSetTimeout = ((...args: unknown[]): NodeJS.Timeout => {
    const timer = (realSetTimeout as (...rest: unknown[]) => NodeJS.Timeout)(...args);
    created.add(timer);
    return timer;
  }) as typeof setTimeout;
  const spiedClearTimeout = ((timer?: NodeJS.Timeout): void => {
    if (timer !== undefined) {
      cleared.add(timer);
    }
    realClearTimeout(timer);
  }) as typeof clearTimeout;

  globalThis.setTimeout = spiedSetTimeout;
  globalThis.clearTimeout = spiedClearTimeout;

  return {
    pending: () => [...created].filter((timer) => !cleared.has(timer)),
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/** Waits, bounded, for everything the run armed to have been released. */
export async function expectNoPendingTimers(timers: TimerSpy): Promise<void> {
  const deadline = Date.now() + 2000;
  while (timers.pending().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(timers.pending()).toEqual([]);
}

/**
 * The run's own stop request. A caller stops a run by aborting the signal it
 * handed it — the one mechanism the run accepts — and these tests read what the
 * run then did: which work it stopped, what it awaited, which status it recorded
 * once, and what it refused to start afterwards. The real processes behind these
 * phases are covered in tests/lifecycle.test.ts; here the phases are stand-ins,
 * so a stop can be delivered at exactly the moment under test. See docs/tasks.md
 * T09.
 */

/** `<runDir>/logs`, derived from the report path a run returned. */
export function runLogsDir(reportPath: string): string {
  return path.join(path.dirname(reportPath), 'logs');
}
