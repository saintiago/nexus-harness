/**
 * The run loop's own decisions — its repair allowance, its one task deadline and
 * what it does with a turn or a round that fails — decided with in-memory
 * collaborators and a clock the test moves by hand.
 *
 * These cases used to run against a real repository: every policy variation
 * cloned one, ran real setup and check commands and started a real stand-in
 * coding turn, so the suite paid for Git and for a process per case to assert
 * what the loop itself decided. What the loop decides is what this file asserts:
 * which turn it asks for next, what it hands that turn, what it records in the
 * report and the timeline, and which limit ended the run. The run's collaborators
 * are the ones it is composed of (`RunnerDependencies`): a checkout that is a
 * directory and a stand-in round, no command and no repository.
 *
 * What needs real Git — a turn's own commits surviving, the branch the run
 * records, the real check commands — stays in tests/runner.test.ts,
 * tests/runner-repair.test.ts, tests/runner-records.test.ts and
 * tests/local-run.integration.test.ts, which still run real commands.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckRoundRequest } from '../src/checks/round.js';
import { agentLogPath, appendRunLog, openAgentLog } from '../src/reporting/logs.js';
import { writeRunReport } from '../src/reporting/report.js';
import type { AgentTurnRequest, RunnerDependencies } from '../src/runs/contracts.js';
import { runTask } from '../src/runs/runner.js';
import type { CheckRoundResult, HarnessConfig, RunReport, Task } from '../src/shared/types.js';
import { recordWorkspaceAttempt, writeWorkspaceState } from '../src/workspace/state.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';
import {
  CLOCK_START,
  passedRound,
  redRound,
  standInCommand,
  standInRounds,
  standInTurns,
  stoppedRound,
  testClock,
  timelineMessages,
  lifecyclePhases,
} from './fixtures/runner.js';
import type { TestClock } from './fixtures/runner.js';
import { createTempDir } from './support.js';

useFixtureLifecycle();

const BASE_COMMIT = 'a'.repeat(40);
const BASELINE_TEXT = 'the committed baseline\n';

/** A configured limit, in the unit the configuration names it in. */
function minutes(count: number): number {
  return count * 60_000;
}

const TASK: Task = {
  id: 'example-001',
  title: 'Add a greeting function',
  description: 'Implement the greeting the ticket describes.',
  acceptanceCriteria: ['The greeting is implemented.', 'The tests cover it.'],
};

/** What one in-memory run is composed of, and what it recorded. */
interface MemoryRun {
  readonly workDir: string;
  readonly task: Task;
  readonly config: HarnessConfig;
  readonly clock: TestClock;
  readonly deps: RunnerDependencies;
  readonly rounds: {
    readonly requests: CheckRoundRequest[];
    readonly run: RunnerDependencies['runCheckRound'];
  };
  readonly turns: {
    readonly requests: AgentTurnRequest[];
    readonly run: RunnerDependencies['runAgentTurn'];
  };
}

/**
 * One run whose collaborators are the fixtures' own stand-ins: the checkout is
 * a directory the run is handed, the configured commands are never started (the
 * round is scripted), and the coding turn is scripted too. Everything else — the
 * run directory, the logs, the report, the ledger and the clock — is the
 * production code, so the assertions are about what the loop really did.
 */
async function memoryRun(parts: {
  readonly rounds: (asked: CheckRoundRequest) => Promise<CheckRoundResult> | CheckRoundResult;
  readonly turns: (
    asked: AgentTurnRequest,
  ) => Promise<{ summary: string | null }> | { summary: string | null };
  readonly config?: Partial<HarnessConfig>;
  readonly clock?: TestClock;
}): Promise<MemoryRun> {
  const workDir = await createTempDir();
  const repoPath = path.join(workDir, 'source');
  await mkdir(repoPath, { recursive: true });
  const clock = parts.clock ?? testClock();
  const rounds = standInRounds(parts.rounds);
  const turns = standInTurns(parts.turns);
  const config: HarnessConfig = {
    workDir,
    maxRepairs: 2,
    taskTimeoutMinutes: 60,
    commandTimeoutMinutes: 10,
    setup: [['a-stand-in-command', 'setup-1']],
    checks: [['a-stand-in-command', 'check-1']],
    agent: { runtime: 'codex', command: ['codex'] },
    ...parts.config,
  };
  const deps: RunnerDependencies = {
    preflight: async () => ({ sourceRoot: repoPath, baseCommit: BASE_COMMIT }),
    allocateRunDirectory: async (where, placement) => {
      const runId = 'run-20260301000000-00000000';
      const workspaceId =
        placement !== undefined && placement.kind === 'reopen'
          ? placement.workspaceId
          : (placement?.preferredWorkspaceId ?? 'example-001');
      const runDir = path.join(where, 'runs', runId);
      const logsDir = path.join(runDir, 'logs');
      await mkdir(logsDir, { recursive: true });
      return {
        workDir: where,
        runId,
        runDir,
        workspaceId,
        workspacePath: path.join(where, 'workspaces', workspaceId),
        logsDir,
      };
    },
    prepareWorkspace: async (run, source) => {
      await mkdir(run.workspacePath, { recursive: true });
      await writeFile(path.join(run.workspacePath, 'app.txt'), BASELINE_TEXT, 'utf8');
      const branch = `harness/${run.workspaceId}`;
      // The ledger is written before anything can run in the workspace, as the
      // production preparation writes it: a later attempt resolves the
      // workspace through it, and this run records its own attempt against it.
      await writeWorkspaceState(run.workDir, {
        version: 1,
        workspaceId: run.workspaceId,
        sourceRoot: source.sourceRoot,
        baseCommit: source.baseCommit,
        branch,
        createdAt: new Date(CLOCK_START).toISOString(),
        sourceItem: null,
        attempts: [],
      });
      return {
        ...run,
        continued: false,
        attempt: 1,
        sourceRoot: source.sourceRoot,
        baseCommit: source.baseCommit,
        branch,
      };
    },
    configureWorkspaceIdentity: async () => undefined,
    returnToRecordedBranch: async () => ({ changed: false }),
    recordWorkspaceAttempt,
    runCheckRound: rounds.run,
    openAgentLog,
    appendRunLog,
    writeRunReport,
    now: clock.now,
    runAgentTurn: turns.run,
  };
  return { workDir, task: TASK, config, clock, deps, rounds, turns };
}

/** The request one in-memory run is given: no source item, no continuation. */
function requestFor(run: MemoryRun): Parameters<typeof runTask>[0] {
  return {
    task: run.task,
    config: run.config,
    repoPath: path.join(run.workDir, 'source'),
    workDir: run.workDir,
  };
}

async function reportOf(result: Awaited<ReturnType<typeof runTask>>): Promise<RunReport> {
  return JSON.parse(await readFile(result.reportPath, 'utf8')) as RunReport;
}

describe('the bounded repair loop', () => {
  it('spends at most maxRepairs additional turns and reports the exhausted allowance', async () => {
    // Every turn leaves the check red, so the allowance is what ends the run.
    const red = async (asked: CheckRoundRequest): Promise<CheckRoundResult> =>
      asked.name === 'baseline'
        ? passedRound()
        : redRound(
            await standInCommand(
              { cwd: asked.cwd, logsDir: asked.logsDir },
              { label: `${asked.name}-check-1`, exitCode: 1 },
            ),
          );
    const run = await memoryRun({
      rounds: red,
      turns: (asked) => ({ summary: `turn ${String(asked.turn)} still broken` }),
    });

    const result = await runTask(requestFor(run), run.deps);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/the repair allowance is exhausted \(2 of 2 repair turns used\)/);

    // Three coding turns in total — the implementation and two repairs — and no
    // fourth attempt once the allowance is gone.
    expect(run.turns.requests.map((asked) => `${asked.kind} ${String(asked.turn)}`)).toEqual([
      'implementation 1',
      'repair 2',
      'repair 3',
    ]);
    expect(run.turns.requests[1]?.repair?.repairedTurn).toBe(1);
    expect(run.turns.requests[2]?.repair?.repairedTurn).toBe(2);
    // Each repair was sent the round that failed just before it.
    expect(run.turns.requests[2]?.repair?.failures.map((entry) => entry.result.exitCode)).toEqual([
      1,
    ]);
    expect(run.turns.requests[2]?.repair?.failures[0]?.result.stdoutPath).toBe(
      path.join(result.run.logsDir, 'attempt-2-check-1.stdout.log'),
    );

    const report = await reportOf(result);
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
      expect(await readFile(attempt.checks?.checks[0]?.stdoutPath ?? '', 'utf8')).toContain(
        'check-1 wrote this',
      );
    }

    // Four rounds in all: the baseline and one after each turn, and none after
    // the allowance ran out.
    expect(run.rounds.requests.map((round) => round.name)).toEqual([
      'baseline',
      'attempt-1',
      'attempt-2',
      'attempt-3',
    ]);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-4-check-1.stdout.log'))).toBe(false);

    const timeline = timelineMessages(await readFile(report.runLog, 'utf8'));
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
  });

  it('stops without another turn when a repair turn itself fails', async () => {
    const run = await memoryRun({
      rounds: async (asked) =>
        asked.name === 'baseline'
          ? passedRound()
          : redRound(
              await standInCommand(
                { cwd: asked.cwd, logsDir: asked.logsDir },
                { label: `${asked.name}-check-1`, exitCode: 1 },
              ),
            ),
      turns: (asked) => {
        if (asked.turn === 2) {
          throw new Error('the coding runtime exited unexpectedly');
        }
        return { summary: `turn ${String(asked.turn)} did its work` };
      },
    });

    const result = await runTask(requestFor(run), run.deps);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/repair turn 2 failed, so no check was run after it/);
    // The failed repair was the last thing the run asked for.
    expect(run.turns.requests).toHaveLength(2);
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);

    const report = await reportOf(result);
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');
    // No round was observed after the failed turn, and none is invented for it.
    expect(report.attempts[1]?.checks).toBeNull();
    expect(report.attempts[1]?.agentSummary).toBeNull();
    expect(existsSync(path.join(result.run.logsDir, 'attempt-2-check-1.stdout.log'))).toBe(false);
    expect(existsSync(path.join(result.run.logsDir, 'attempt-3-check-1.stdout.log'))).toBe(false);

    const timeline = timelineMessages(await readFile(report.runLog, 'utf8'));
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
  });

  it('stops without another turn when the round after a repair cannot be executed', async () => {
    // The round after the repair stops on its setup command: an infrastructure
    // failure, which costs no further coding turn.
    const run = await memoryRun({
      rounds: async (asked) => {
        if (asked.name === 'baseline') {
          return passedRound();
        }
        if (asked.name === 'attempt-1') {
          return redRound(
            await standInCommand(
              { cwd: asked.cwd, logsDir: asked.logsDir },
              { label: `${asked.name}-check-1`, exitCode: 1 },
            ),
          );
        }
        return stoppedRound(
          await standInCommand(
            { cwd: asked.cwd, logsDir: asked.logsDir },
            {
              label: `${asked.name}-setup-1`,
              outcome: 'exited',
              exitCode: 1,
              termination: null,
            },
          ),
          {
            as: 'setup',
            problem: 'setup command 1 of 1 exited with code 1 (gate.txt says closed)',
          },
        );
      },
      turns: (asked) => ({ summary: `turn ${String(asked.turn)} did its work` }),
    });

    const result = await runTask(requestFor(run), run.deps);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/the checks after repair turn 2 could not be executed/);
    expect(run.turns.requests).toHaveLength(2);

    const report = await reportOf(result);
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts).toHaveLength(2);
    const observed = report.attempts[1]?.checks;
    expect(observed?.outcome).toBe('execution-error');
    // The check never ran, so it has no result — and the repair turn's claim
    // that it fixed everything stays agent text.
    expect(observed?.checks).toEqual([]);
    expect(observed?.setup.map((entry) => entry.exitCode)).toEqual([1]);
    expect(observed?.problem).toContain('gate.txt');
    expect(report.attempts[1]?.agentSummary).toBe('turn 2 did its work');
    // The failed setup kept its own output, and the round stopped there.
    expect(await readFile(observed?.setup[0]?.stdoutPath ?? '', 'utf8')).toBe(
      'attempt-2-setup-1 wrote this\n',
    );
    expect(existsSync(path.join(result.run.logsDir, 'attempt-3-check-1.stdout.log'))).toBe(false);

    const timeline = timelineMessages(await readFile(report.runLog, 'utf8'));
    expect(
      timeline.filter((message) => message.startsWith('post-agent check-round result')).at(-1),
    ).toMatch(/^post-agent check-round result: execution-error, setup command 1 of 1 /);
  });
});

describe('a run that runs out of task time', () => {
  it('spends one budget from preparation through the repair turns', async () => {
    // What the run's one hour is spent on: ten minutes of baseline, fifteen of
    // implementation, ten more of checks that come back red, fifteen of repair,
    // and five of the checks that then pass.
    const leftAt: number[] = [];
    const clock = testClock();
    const run = await memoryRun({
      clock,
      rounds: async (asked) => {
        leftAt.push(asked.deadlineMs - asked.now().getTime());
        clock.advance(minutes(asked.name === 'attempt-2' ? 5 : 10));
        return asked.name === 'attempt-1'
          ? redRound(
              await standInCommand(
                { cwd: asked.cwd, logsDir: asked.logsDir },
                { label: `${asked.name}-check-1`, exitCode: 1 },
              ),
            )
          : passedRound();
      },
      turns: (asked) => {
        clock.advance(minutes(15));
        return { summary: `turn ${String(asked.turn)} did its work` };
      },
    });
    const bounds: number[] = [];
    const deps: RunnerDependencies = {
      ...run.deps,
      prepareWorkspace: async (directory, source, given) => {
        bounds.push(given.deadlineMs);
        return await run.deps.prepareWorkspace(directory, source, given);
      },
    };

    const result = await runTask(requestFor(run), deps);

    expect(result.status).toBe('passed');
    expect(result.timeout).toBeNull();

    // One deadline, established before preparation and handed to every phase
    // afterwards — the repair turn included.
    const deadline = CLOCK_START.getTime() + minutes(60);
    expect(bounds).toEqual([deadline]);
    expect(run.rounds.requests.map((round) => round.name)).toEqual([
      'baseline',
      'attempt-1',
      'attempt-2',
    ]);
    expect(run.rounds.requests.map((round) => round.deadlineMs)).toEqual([
      deadline,
      deadline,
      deadline,
    ]);
    expect(run.rounds.requests.map((round) => round.commandTimeoutMs)).toEqual([
      minutes(10),
      minutes(10),
      minutes(10),
    ]);

    // What each round had left of that budget: less every time, because what
    // preparation and the turns spent is not handed back to a later round.
    expect(leftAt).toEqual([minutes(60), minutes(35), minutes(10)]);
    // No turn was stopped: everything fitted in the budget it was given.
    expect(run.turns.requests.map((turn) => turn.stop.aborted)).toEqual([false, false]);
    expect(run.turns.requests[1]?.kind).toBe('repair');

    const report = await reportOf(result);
    expect(report.status).toBe('passed');
    expect(report.timeout).toBeNull();
    expect(report.repairsUsed).toBe(1);
    expect(report.attempts.map((attempt) => attempt.checks?.outcome)).toEqual(['failed', 'passed']);
    expect(timelineMessages(await readFile(report.runLog, 'utf8'))).toContain(
      `task deadline set for ${new Date(deadline).toISOString()}: 3600000 ms of total task time, 600000 ms per configured command`,
    );
  });

  it('stops the baseline when the task time that was left is the smaller limit', async () => {
    const run = await memoryRun({
      rounds: async (asked) =>
        stoppedRound(
          await standInCommand(
            { cwd: asked.cwd, logsDir: asked.logsDir },
            {
              label: `${asked.name}-setup-1`,
              outcome: 'timed-out',
              timeoutMs: minutes(4),
              termination: 'confirmed',
            },
          ),
          { as: 'setup', problem: 'the setup command was stopped at the 4 minutes it was given' },
        ),
      turns: () => ({ summary: 'never reached' }),
    });

    const result = await runTask(requestFor(run), run.deps);

    expect(result.status).toBe('failed');
    // Four minutes is less than the configured ten, so the task time that was
    // left is the limit that expired — and the record names that, not the
    // command's.
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
    expect(run.turns.requests).toEqual([]);
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline']);

    const report = await reportOf(result);
    expect(report.status).toBe('failed');
    expect(report.timeout).toEqual(result.timeout);
    expect(report.baseline?.outcome).toBe('execution-error');
    expect(report.baseline?.setup[0]?.outcome).toBe('timed-out');
    expect(report.attempts).toEqual([]);
    // The evidence is kept: the stopped command's own output file is still there.
    expect(existsSync(report.baseline?.setup[0]?.stdoutPath ?? '')).toBe(true);
    const timeline = timelineMessages(await readFile(report.runLog, 'utf8'));
    expect(timeline).toContain(
      "timeout: the run's task deadline (240000 ms) expired during the baseline checks",
    );
    expect(timeline.at(-1)).toMatch(/^final status: failed, the run's task deadline expired/);
  });
});
