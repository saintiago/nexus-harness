/**
 * The run loop's own state transitions and repair decisions, exercised with the
 * in-memory kit: a fresh or continued workspace, a baseline, an implementation
 * turn, a check round, and the repair turns `maxRepairs` allows.
 *
 * What is asserted is what the loop decided — which turn it asked for next, what
 * that turn was told, what the report would have recorded, and which limit ended
 * the run. No Git command, no configured command and no coding runtime is
 * started here; the process and repository contracts stay the boundary layer's.
 */
import { describe, expect, it } from 'vitest';
import type { CheckRoundRequest } from '../../src/checks/round.js';
import { HistoryError } from '../../src/history/contract.js';
import type {
  DeveloperReportRequest,
  HistorySnapshot,
  TicketHistory,
} from '../../src/history/contract.js';
import type { AgentTurnResult, RunTaskResult } from '../../src/runs/contracts.js';
import { BASELINE_GUIDANCE_PREFIX } from '../../src/runs/contracts.js';
import type { CheckRoundResult, CommandResult, SourceRef } from '../../src/shared/types.js';
import type { ContinuedWorkspace } from '../../src/workspace/reopen.js';
import {
  BASE_COMMIT,
  executionErrorRound,
  memoryRun,
  minutes,
  passedRound,
  redRound,
  runMemoryTask,
  standInCommand,
  testClock,
  TASK,
} from './runner-kit.js';

const SOURCE_REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'HARN-11',
  url: 'https://example.atlassian.net/browse/HARN-11',
  updatedAt: '2026-09-16T11:00:00.000Z',
};

/** The failure the report-retention step reports in the cases below. */
const LOST_REPORT = 'the reports directory is not writable';

/** What a turn that could not confirm the stop of its own runtime reports. */
const UNSETTLED_RUNTIME = 'the runtime child may still be writing';

/** What a stopped command that could not confirm its own end reports. */
const UNSETTLED_COMMAND = 'the command tree may still be running';

/** One red round whose only check exited nonzero, with its output written. */
function redAfter(asked: CheckRoundRequest): Promise<CheckRoundResult> {
  return standInCommand(
    { cwd: asked.cwd, logsDir: asked.logsDir },
    { label: `${asked.name}-check-1`, exitCode: 3 },
  ).then(redRound);
}

/** A red round that never started a command: enough for a baseline decision. */
function redRoundWithoutCommands(): CheckRoundResult {
  const result: CommandResult = {
    command: ['a-stand-in-command'],
    cwd: '',
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(0).toISOString(),
    outcome: 'exited',
    exitCode: 1,
    signal: null,
    launchError: null,
    timeoutMs: minutes(1),
    termination: null,
    terminationProblem: null,
    stdoutPath: '',
    stderrPath: '',
  };
  return redRound(result);
}

/** A snapshot a run with history is handed; nothing here reads the files. */
function snapshotFor(ref: SourceRef): HistorySnapshot {
  return {
    version: 1,
    id: 'b'.repeat(32),
    role: 'developer',
    round: 1,
    takenAt: new Date(0).toISOString(),
    root: 'unused-root',
    dir: 'unused-dir',
    indexPath: 'unused-index',
    indexJsonPath: 'unused-index-json',
    entriesPath: 'unused-entries',
    reportsDir: 'unused-reports',
    brief: {
      ref,
      task: TASK,
      latestDelivery: null,
      unresolved: null,
      responses: [],
      newHumanFeedback: [],
    },
    entries: [],
    reports: [],
    gaps: [],
    mirrors: [],
    sources: [],
  };
}

/**
 * The history collaboration of a run whose complete turn report cannot be
 * retained: the write that follows a turn always fails, and every
 * acknowledgement the run might make is counted.
 */
function historyWithLostReport(): {
  readonly history: TicketHistory;
  readonly acknowledgements: () => number;
} {
  let acknowledged = 0;
  return {
    history: {
      prepare: async () => snapshotFor(SOURCE_REF),
      recordDeveloperReport: async () => {
        throw new HistoryError('write', LOST_REPORT);
      },
      consumed: async () => {
        acknowledged += 1;
      },
    },
    acknowledgements: () => acknowledged,
  };
}

/** Resolves once the stop request the run handed a turn reaches that turn. */
function stopReached(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

describe('the run loop from a green baseline', () => {
  it('runs one implementation turn and ends passed on its green round', async () => {
    const run = await memoryRun({
      rounds: () => passedRound(),
      turns: () => ({ summary: 'the implementation is done' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('passed');
    expect(result.repairsUsed).toBe(0);
    expect(result.baseline?.outcome).toBe('passed');
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    expect(run.turns.requests.map((turn) => `${turn.kind} ${String(turn.turn)}`)).toEqual([
      'implementation 1',
    ]);
    // The turn is told the task and the workspace, and repairs nothing.
    expect(run.turns.requests[0]?.repair).toBeNull();
    expect(run.turns.requests[0]?.task).toEqual(TASK);
    expect(run.turns.requests[0]?.workspacePath).toContain('example-001');
    // The post-agent round is the configured plan, under the run's one deadline.
    const postRound = run.rounds.requests[1];
    expect(postRound?.deadlineMs).toBe(Date.parse('2026-03-01T00:00:00.000Z') + minutes(60));
    expect(postRound?.commandTimeoutMs).toBe(minutes(10));
    expect(postRound?.setup).toEqual(run.config.setup);
    expect(postRound?.checks).toEqual(run.config.checks);

    // The report and the workspace ledger record the attempt that happened, and
    // the working copy was read once, as the final comparison.
    const report = run.reports.at(-1);
    expect(report?.status).toBe('passed');
    expect(report?.attempts.map((attempt) => attempt.agentSummary)).toEqual([
      'the implementation is done',
    ]);
    expect(report?.attempts.map((attempt) => attempt.checks?.outcome)).toEqual(['passed']);
    expect(run.ledger.map((attempt) => attempt.outcome)).toEqual(['passed']);
    expect(run.inspected).toHaveLength(1);
    expect(run.timeline.at(-1)).toMatch(/^final status: passed, /);
  });
});

describe('the baseline decision', () => {
  it('stops a fresh run on a red baseline before any coding turn', async () => {
    const run = await memoryRun({
      rounds: (asked) => (asked.name === 'baseline' ? redAfter(asked) : passedRound()),
      turns: () => ({ summary: 'never asked' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/baseline checks did not pass/);
    expect(result.attempts).toEqual([]);
    expect(run.turns.requests).toEqual([]);
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    expect(result.baseline?.outcome).toBe('failed');
    // The run still kept its evidence: a report was written from the facts it has.
    expect(run.reports.at(-1)?.status).toBe('failed');
    expect(run.reports.at(-1)?.attempts).toEqual([]);
    expect(run.ledger.map((attempt) => attempt.outcome)).toEqual(['failed']);
  });

  it('lets a continuation start from a red baseline and decide on its own round', async () => {
    const continued: ContinuedWorkspace = {
      workspaceId: 'HARN-11',
      workspacePath: 'a-continued-workspace',
      branch: 'harness/HARN-11',
      baseCommit: BASE_COMMIT,
      attempt: 2,
    };
    const run = await memoryRun({
      continuedWorkspace: continued,
      rounds: (asked) => (asked.name === 'baseline' ? redRoundWithoutCommands() : passedRound()),
      turns: () => ({ summary: 'repaired the baseline' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('passed');
    expect(run.turns.requests).toHaveLength(1);
    expect(
      run.timeline.some((line) => line.includes('continues a workspace that was already red')),
    ).toBe(true);
    // The continued workspace keeps its own recorded base and attempt number,
    // and the report says it continued rather than created one.
    expect(result.workspace?.baseCommit).toBe(BASE_COMMIT);
    expect(result.workspace?.attempt).toBe(2);
    expect(run.reports.at(-1)?.workspace?.continued).toBe(true);
  });
});

describe('the repair decision', () => {
  it('stops after a red round when the allowance is already zero', async () => {
    const run = await memoryRun({
      config: { maxRepairs: 0 },
      rounds: (asked) => (asked.name === 'baseline' ? passedRound() : redAfter(asked)),
      turns: () => ({ summary: 'did the work' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/repair allowance is exhausted \(0 of 0 repair turns used\)/);
    expect(run.turns.requests).toHaveLength(1);
    expect(run.timeline).toContain('repair allowance exhausted: 0 of 0 repair turns used');
  });

  it('spends a positive allowance exactly to its end, then reports it exhausted', async () => {
    // A green baseline and a round that never goes green: what ends the run is
    // the allowance, not the baseline and not an execution failure.
    const run = await memoryRun({
      config: { maxRepairs: 2 },
      rounds: (asked) => (asked.name === 'baseline' ? passedRound() : redAfter(asked)),
      turns: (asked) => ({ summary: `turn ${String(asked.turn)} is still red` }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.repairsUsed).toBe(2);
    expect(result.reason).toMatch(/repair allowance is exhausted \(2 of 2 repair turns used\)/);
    // Three coding turns in total — one implementation and two repairs — and no
    // fourth attempt once the allowance is gone.
    expect(run.turns.requests.map((turn) => `${turn.kind} ${String(turn.turn)}`)).toEqual([
      'implementation 1',
      'repair 2',
      'repair 3',
    ]);
    // Four rounds in all: the baseline and one after each turn, and none after
    // the allowance ran out.
    expect(run.rounds.requests.map((round) => round.name)).toEqual([
      'baseline',
      'attempt-1',
      'attempt-2',
      'attempt-3',
    ]);
    // Each repair was handed the round that failed immediately before it, whole:
    // its invocation, its exit code, where it wrote, and what it wrote.
    const [, firstRepair, secondRepair] = run.turns.requests;
    expect(firstRepair?.kind).toBe('repair');
    expect(firstRepair?.repair?.repairedTurn).toBe(1);
    expect(firstRepair?.repair?.failures.map((failure) => failure.result.command)).toEqual([
      ['a-stand-in-command', 'attempt-1-check-1'],
    ]);
    expect(firstRepair?.repair?.failures[0]?.result.exitCode).toBe(3);
    expect(secondRepair?.repair?.repairedTurn).toBe(2);
    expect(secondRepair?.repair?.failures.map((failure) => failure.result.command)).toEqual([
      ['a-stand-in-command', 'attempt-2-check-1'],
    ]);
    expect(secondRepair?.repair?.failures[0]?.result.stdoutPath).toContain(
      'attempt-2-check-1.stdout.log',
    );
    expect(secondRepair?.repair?.failures[0]?.output).toContain('attempt-2-check-1 wrote this');

    // The report and the ledger keep every turn and every red round, and the
    // timeline says which limit ended the run.
    const report = run.reports.at(-1);
    expect(report?.status).toBe('failed');
    expect(report?.attempts.map((attempt) => attempt.kind)).toEqual([
      'implementation',
      'repair',
      'repair',
    ]);
    expect(report?.attempts.map((attempt) => attempt.checks?.outcome)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    // The workspace's ledger records this one attempt and how it ended.
    expect(run.ledger.map((attempt) => attempt.outcome)).toEqual(['failed']);
    expect(run.ledger[0]?.reason).toMatch(/the repair allowance is exhausted \(2 of 2/);
    expect(run.timeline).toContain('repair allowance exhausted: 2 of 2 repair turns used');
    expect(run.timeline.at(-1)).toMatch(/^final status: failed, /);
  });

  it('sends a completed red round to the next turn as its repair feedback', async () => {
    const run = await memoryRun({
      config: { maxRepairs: 1 },
      rounds: (asked) =>
        asked.name === 'baseline' || asked.name === 'attempt-2' ? passedRound() : redAfter(asked),
      turns: (asked) => ({ summary: `turn ${String(asked.turn)} done` }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('passed');
    expect(result.repairsUsed).toBe(1);
    expect(run.rounds.requests.map((round) => round.name)).toEqual([
      'baseline',
      'attempt-1',
      'attempt-2',
    ]);
    const repair = run.turns.requests[1];
    expect(repair?.kind).toBe('repair');
    expect(repair?.turn).toBe(2);
    expect(repair?.repair?.repairedTurn).toBe(1);
    // The failed command travels whole: its invocation, its exit code, its logs.
    const failure = repair?.repair?.failures[0];
    expect(repair?.repair?.failures).toHaveLength(1);
    expect(failure?.result.exitCode).toBe(3);
    expect(failure?.result.command).toEqual(['a-stand-in-command', 'attempt-1-check-1']);
    expect(failure?.result.stdoutPath).toContain('attempt-1-check-1.stdout.log');
    expect(failure?.output).toContain('attempt-1-check-1 wrote this');
    expect(result.reason).toMatch(
      /every configured check passed after repair turn 2 \(1 of 1 repair turns used\)/,
    );
  });

  it('stops without another turn when a repair turn itself fails', async () => {
    const run = await memoryRun({
      config: { maxRepairs: 3 },
      rounds: (asked) => (asked.name === 'baseline' ? passedRound() : redAfter(asked)),
      turns: (asked) => {
        if (asked.turn === 2) {
          throw new Error('the coding runtime exited unexpectedly');
        }
        return { summary: `turn ${String(asked.turn)} done` };
      },
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/repair turn 2 failed, so no check was run after it/);
    expect(run.turns.requests).toHaveLength(2);
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    const report = run.reports.at(-1);
    expect(report?.attempts).toHaveLength(2);
    expect(report?.attempts[1]?.agentSummary).toBeNull();
    expect(report?.attempts[1]?.checks).toBeNull();
  });

  it('does not spend a repair turn on a round that could not be executed', async () => {
    const run = await memoryRun({
      config: { maxRepairs: 5 },
      rounds: async (asked) => {
        if (asked.name === 'baseline') {
          return passedRound();
        }
        const unlaunched = await standInCommand(
          { cwd: asked.cwd, logsDir: asked.logsDir },
          {
            label: `${asked.name}-check-1`,
            outcome: 'failed-to-launch',
            launchError: 'no host tool',
          },
        );
        return executionErrorRound(unlaunched, {
          as: 'check',
          problem: 'the check could not be started',
        });
      },
      turns: () => ({ summary: 'did the work' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/could not be executed/);
    expect(run.turns.requests).toHaveLength(1);
    expect(result.attempts[0]?.checks?.outcome).toBe('execution-error');
  });
});

describe('the stops a run observes', () => {
  it('ends cancelled when the caller stopped the round, before any repair', async () => {
    const controller = new AbortController();
    const run = await memoryRun({
      stop: controller.signal,
      rounds: async (asked) => {
        if (asked.name === 'baseline') {
          return passedRound();
        }
        // The stop arrives while the round is running: its own command reports
        // the stop, and the round comes back as an execution error.
        controller.abort();
        const stopped = await standInCommand(
          { cwd: asked.cwd, logsDir: asked.logsDir },
          { label: `${asked.name}-check-1`, outcome: 'stopped', termination: 'confirmed' },
        );
        return executionErrorRound(stopped, { as: 'check', problem: 'the command was stopped' });
      },
      turns: () => ({ summary: 'did the work' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('cancelled');
    expect(result.cancellation?.termination).toBe('confirmed');
    expect(result.cancellation?.phase).toMatch(/checks after the implementation turn/);
    expect(result.timeout).toBeNull();
    expect(run.turns.requests).toHaveLength(1);
  });

  it('ends failed without a check when a turn could not confirm its own stop', async () => {
    const run = await memoryRun({
      rounds: () => passedRound(),
      turns: (): AgentTurnResult => ({
        summary: 'the turn ran',
        shutdown: { termination: 'unconfirmed', problem: 'a process may still be writing' },
      }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/could not confirm that it had ended/);
    // Only the baseline ran; the round that would have judged the turn never did.
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    expect(run.inspected).toEqual([]);
    expect(result.changes.inspected).toBe(false);
    expect(result.changes.problem).toMatch(/may still be written to/);
  });

  it('ends timed out before the next turn when the task deadline has passed', async () => {
    const clock = testClock();
    const run = await memoryRun({
      clock,
      config: { maxRepairs: 3, taskTimeoutMinutes: 2 },
      rounds: (asked) => {
        // Each round spends a minute of the run's two.
        clock.advance(minutes(1));
        return asked.name === 'baseline' ? passedRound() : redAfter(asked);
      },
      turns: () => ({ summary: 'did the work' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.timeout?.limit).toBe('task');
    expect(result.timeout?.phase).toBe('repair turn 2');
    expect(result.timeout?.limitMs).toBe(minutes(2));
    expect(run.turns.requests).toHaveLength(1);
    expect(result.reason).toMatch(/task deadline expired before repair turn 2 was started/);
  });

  it('stops the baseline at the task time that was left, before any coding turn', async () => {
    const run = await memoryRun({
      rounds: async (asked) =>
        executionErrorRound(
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

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    // Four minutes is less than the configured ten, so the task time that was
    // left is the limit that expired — and the record names that limit, not the
    // command's own.
    expect(result.timeout).toEqual({
      limit: 'task',
      phase: 'the baseline checks',
      limitMs: minutes(4),
      elapsedMs: 0,
      termination: 'confirmed',
      problem: null,
    });
    expect(result.reason).toMatch(
      /the run's task deadline expired during the baseline checks: nothing further was started/,
    );
    // A stopped command is an execution failure, not a red round to repair, and
    // nothing at all follows it: no coding turn and no second round.
    expect(run.turns.requests).toEqual([]);
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    // The report keeps the round's own evidence beside the limit that ended it.
    const report = run.reports.at(-1);
    expect(report?.status).toBe('failed');
    expect(report?.timeout).toEqual(result.timeout);
    expect(report?.baseline?.outcome).toBe('execution-error');
    expect(report?.baseline?.setup[0]?.outcome).toBe('timed-out');
    expect(report?.attempts).toEqual([]);
    expect(run.timeline).toContain(
      "timeout: the run's task deadline (240000 ms) expired during the baseline checks",
    );
    expect(run.timeline.at(-1)).toMatch(/^final status: failed, the run's task deadline expired/);
  });

  it('stops a post-agent round at its command limit, before any repair', async () => {
    const run = await memoryRun({
      config: { maxRepairs: 2 },
      rounds: async (asked) => {
        if (asked.name === 'baseline') {
          return passedRound();
        }
        return executionErrorRound(
          await standInCommand(
            { cwd: asked.cwd, logsDir: asked.logsDir },
            {
              label: `${asked.name}-check-1`,
              outcome: 'timed-out',
              timeoutMs: minutes(10),
              termination: 'confirmed',
            },
          ),
          { as: 'check', problem: 'the check was stopped at its command limit' },
        );
      },
      turns: () => ({ summary: 'did the work' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    // The command ran under its full configured limit, so that limit — not the
    // task time — is the one the record names.
    expect(result.timeout?.limit).toBe('command');
    expect(result.timeout?.phase).toBe('the checks after the implementation turn');
    expect(result.timeout?.limitMs).toBe(minutes(10));
    expect(result.timeout?.termination).toBe('confirmed');
    expect(result.timeout?.problem).toBeNull();
    expect(result.reason).toMatch(
      /a configured command was stopped at its limit during the checks after the implementation turn: nothing further was started/,
    );
    // The round that hit the limit is not repair feedback and spends no repair
    // turn: no second round and no further coding turn follows it.
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    expect(run.turns.requests.map((turn) => `${turn.kind} ${String(turn.turn)}`)).toEqual([
      'implementation 1',
    ]);
    expect(run.reports.at(-1)?.attempts.map((attempt) => attempt.checks?.outcome)).toEqual([
      'execution-error',
    ]);
    expect(run.timeline).toContain(
      'timeout: a configured command limit (600000 ms) expired during the checks after the ' +
        'implementation turn',
    );
  });

  it('carries a command stop it could not confirm, and reads no final changes', async () => {
    const run = await memoryRun({
      config: { maxRepairs: 1 },
      rounds: async (asked) => {
        if (asked.name === 'baseline') {
          return passedRound();
        }
        return executionErrorRound(
          await standInCommand(
            { cwd: asked.cwd, logsDir: asked.logsDir },
            {
              label: `${asked.name}-check-1`,
              outcome: 'timed-out',
              timeoutMs: minutes(10),
              termination: 'unconfirmed',
              terminationProblem: UNSETTLED_COMMAND,
            },
          ),
          { as: 'check', problem: 'the check was stopped without confirming its end' },
        );
      },
      turns: () => ({ summary: 'did the work' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    // The command's own record of the stop travels whole into the run's
    // evidence: the limit that expired, and what could not be confirmed.
    expect(result.timeout?.limit).toBe('command');
    expect(result.timeout?.phase).toBe('the checks after the implementation turn');
    expect(result.timeout?.limitMs).toBe(minutes(10));
    expect(result.timeout?.termination).toBe('unconfirmed');
    expect(result.timeout?.problem).toBe(UNSETTLED_COMMAND);
    expect(result.reason).toMatch(
      /the stop could not be confirmed, so the working copy must not be reused and nothing further was started/,
    );
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    expect(run.turns.requests).toHaveLength(1);
    // A working copy something may still be writing to is never read as the
    // run's final record.
    expect(run.inspected).toEqual([]);
    expect(result.changes.inspected).toBe(false);
    expect(result.changes.problem).toMatch(/may still be written to/);
    expect(run.timeline).toContain(
      'timeout: a configured command limit (600000 ms) expired during the checks after the ' +
        `implementation turn; termination unconfirmed: ${UNSETTLED_COMMAND}`,
    );
  });

  it('ends cancelled before a repair turn the caller stopped the run ahead of', async () => {
    const controller = new AbortController();
    const run = await memoryRun({
      stop: controller.signal,
      rounds: (asked) => {
        if (asked.name === 'attempt-1') {
          // The stop arrives after the red round completed and before the loop
          // decides on a repair turn.
          controller.abort();
        }
        return asked.name === 'baseline' ? passedRound() : redAfter(asked);
      },
      turns: () => ({ summary: 'did the work' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('cancelled');
    expect(result.reason).toMatch(/stopped by its caller before repair turn 2 was started/);
    expect(run.turns.requests).toHaveLength(1);
    expect(result.attempts).toHaveLength(1);
  });
});

describe('the ticket history a turn is given', () => {
  it('stops the turn, with a report, when the snapshot cannot be prepared', async () => {
    const run = await memoryRun({
      sourceRef: SOURCE_REF,
      history: {
        prepare: async () => {
          throw new HistoryError('essential', 'the snapshot pointer could not be written');
        },
      },
      rounds: () => passedRound(),
      turns: () => ({ summary: 'never asked' }),
    });

    const result: RunTaskResult = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/conversation history could not be prepared/);
    expect(run.turns.requests).toEqual([]);
    expect(run.reports.at(-1)?.status).toBe('failed');
  });

  it('hands a turn with a snapshot only the separately validated baseline guidance', async () => {
    let prepared = 0;
    const run = await memoryRun({
      sourceRef: SOURCE_REF,
      guidance: [
        `${BASELINE_GUIDANCE_PREFIX}repair the baseline before the original task continues.`,
        'a comment from the thread that the snapshot now holds instead',
      ],
      history: {
        prepare: async () => {
          prepared += 1;
          return snapshotFor(SOURCE_REF);
        },
      },
      rounds: () => passedRound(),
      turns: () => ({ summary: 'did the work' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('passed');
    expect(prepared).toBe(1);
    const asked = run.turns.requests[0];
    expect(asked?.history?.id).toBe('b'.repeat(32));
    // Ordinary thread context comes only from the snapshot; the reviewed
    // baseline requirement survives on its own.
    expect(asked?.guidance).toEqual([
      `${BASELINE_GUIDANCE_PREFIX}repair the baseline before the original task continues.`,
    ]);
  });

  it('hands a turn without a snapshot every guidance line, unchanged', async () => {
    const run = await memoryRun({
      guidance: ['attempt 1 failed: the baseline is red'],
      rounds: () => passedRound(),
      turns: () => ({ summary: 'did the work' }),
    });

    await runMemoryTask(run);

    expect(run.turns.requests[0]?.guidance).toEqual(['attempt 1 failed: the baseline is red']);
  });

  it('prepares a fresh snapshot before every repair turn, and never replays old excerpts', async () => {
    const prepared: { readonly role: string; readonly round: number | null }[] = [];
    const run = await memoryRun({
      sourceRef: SOURCE_REF,
      config: { maxRepairs: 1 },
      guidance: [
        `${BASELINE_GUIDANCE_PREFIX}repair the baseline before the original task continues.`,
        'an intake excerpt the snapshot has replaced',
      ],
      history: {
        prepare: async (request) => {
          prepared.push({ role: request.role, round: request.round });
          return {
            ...snapshotFor(SOURCE_REF),
            id: prepared.length.toString(16).padStart(32, '0'),
            round: request.round,
          };
        },
      },
      rounds: (asked) => (asked.name === 'attempt-1' ? redAfter(asked) : passedRound()),
      turns: () => ({ summary: 'did the work' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('passed');
    expect(run.turns.requests).toHaveLength(2);
    expect(prepared).toEqual([
      { role: 'developer', round: 1 },
      { role: 'developer', round: 1 },
    ]);
    for (const [index, asked] of run.turns.requests.entries()) {
      // Every turn — the implementation and the repair alike — is handed its own
      // refreshed snapshot and only the separately validated baseline guidance.
      expect(asked.history).not.toBeUndefined();
      expect(asked.history?.id).toBe((index + 1).toString(16).padStart(32, '0'));
      expect(asked.guidance).toEqual([
        `${BASELINE_GUIDANCE_PREFIX}repair the baseline before the original task continues.`,
      ]);
    }
  });

  it('retains the complete developer report of every turn before publication', async () => {
    const recorded: DeveloperReportRequest[] = [];
    let consumed = 0;
    const run = await memoryRun({
      sourceRef: SOURCE_REF,
      history: {
        prepare: async () => snapshotFor(SOURCE_REF),
        recordDeveloperReport: async (request) => {
          recorded.push(request);
          return { file: 'digest.json', completeFile: 'report.md', round: request.round };
        },
        consumed: async () => {
          consumed += 1;
        },
      },
      rounds: () => passedRound(),
      turns: () => ({ summary: 'the implementation is done' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('passed');
    expect(recorded).toHaveLength(1);
    // The interim report is saved while the run is still going: the turn's own
    // summary is retained whole, and its round has not been observed yet.
    expect(recorded[0]?.status).toBe('in-progress');
    expect(recorded[0]?.runId).toBe(result.run.runId);
    expect(recorded[0]?.attempts).toEqual([
      { turn: 1, kind: 'implementation', agentSummary: 'the implementation is done', checks: null },
    ]);
    // The snapshot is consumed only after the turn returned usable output.
    expect(consumed).toBe(1);
  });

  it('ends the run before the check round when the complete report cannot be retained', async () => {
    const run = await memoryRun({
      sourceRef: SOURCE_REF,
      history: {
        prepare: async () => snapshotFor(SOURCE_REF),
        recordDeveloperReport: async () => {
          throw new HistoryError('write', 'the reports directory is not writable');
        },
      },
      rounds: () => passedRound(),
      turns: () => ({ summary: 'the implementation is done' }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/complete developer turn report could not be retained/);
    // Only the baseline ran: a turn whose report was lost is not judged by a
    // check round, and no repair is spent on it.
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline']);
  });
});

/**
 * The precedence docs/spec.md §3 states in one sentence: "A failure to retain
 * the developer report never replaces cancellation or timeout evidence." The
 * report write is attempted after a turn returns, and the stop the turn reported
 * about its own runtime is read after that write has been processed, so these
 * cases hand the run both failures at once and read which ending — and which
 * evidence — it kept.
 */
describe('a report that could not be retained beside an unconfirmed stop', () => {
  it('keeps the caller stop and its unconfirmed termination', async () => {
    const controller = new AbortController();
    const lost = historyWithLostReport();
    const run = await memoryRun({
      sourceRef: SOURCE_REF,
      stop: controller.signal,
      history: lost.history,
      rounds: () => passedRound(),
      turns: async () => {
        // The caller stops the run while the turn is running, and the turn
        // returns what it could not confirm about the runtime it stopped.
        controller.abort();
        return {
          summary: 'the implementation is done',
          shutdown: { termination: 'unconfirmed', problem: UNSETTLED_RUNTIME },
        };
      },
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('cancelled');
    expect(result.timeout).toBeNull();
    expect(result.cancellation?.termination).toBe('unconfirmed');
    expect(result.cancellation?.problem).toBe(UNSETTLED_RUNTIME);
    // The ending carries both failures: the lost report is stated beside the
    // stop the run actually observed, and replaces neither part of it.
    expect(result.reason).toContain(LOST_REPORT);
    expect(result.reason).toContain(UNSETTLED_RUNTIME);
    expect(result.reason).toMatch(/stopped by its caller/);
    // Nothing ran after the turn, and no working copy the runtime may still be
    // writing to was read as a final record.
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    expect(run.inspected).toEqual([]);
    expect(result.changes.inspected).toBe(false);
    expect(result.changes.problem).toMatch(/may still be written to/);
    expect(result.attempts[0]?.agentSummary).toBe('the implementation is done');
    expect(run.reports.at(-1)?.cancellation?.termination).toBe('unconfirmed');
    // The snapshot of a turn whose report was lost is never acknowledged.
    expect(lost.acknowledgements()).toBe(0);
  });

  it('keeps the expired task deadline and its unconfirmed termination', async () => {
    const clock = testClock();
    const lost = historyWithLostReport();
    const run = await memoryRun({
      clock,
      config: { taskTimeoutMinutes: 1 },
      sourceRef: SOURCE_REF,
      history: lost.history,
      rounds: (asked) => {
        if (asked.name === 'baseline') {
          // The baseline spends all but a moment of the run's single minute, so
          // the deadline is reached while the turn below is awaited.
          clock.advance(minutes(1) - 50);
        }
        return passedRound();
      },
      turns: async (asked) => {
        // The turn runs until the run's own remaining task time reaches it.
        await stopReached(asked.stop);
        return {
          summary: 'the implementation is done',
          shutdown: { termination: 'unconfirmed', problem: UNSETTLED_RUNTIME },
        };
      },
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.cancellation).toBeNull();
    expect(result.timeout?.limit).toBe('task');
    expect(result.timeout?.phase).toBe('implementation turn');
    expect(result.timeout?.limitMs).toBe(minutes(1));
    expect(result.timeout?.termination).toBe('unconfirmed');
    expect(result.timeout?.problem).toBe(UNSETTLED_RUNTIME);
    expect(result.reason).toContain(LOST_REPORT);
    expect(result.reason).toContain(UNSETTLED_RUNTIME);
    expect(result.reason).toMatch(/remaining task time ran out/);
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    expect(run.inspected).toEqual([]);
    expect(result.changes.inspected).toBe(false);
    expect(result.changes.problem).toMatch(/may still be written to/);
    expect(result.attempts[0]?.agentSummary).toBe('the implementation is done');
    expect(run.reports.at(-1)?.timeout?.termination).toBe('unconfirmed');
    expect(lost.acknowledgements()).toBe(0);
  });

  it('keeps a runtime-only turn that could not confirm its own stop', async () => {
    const lost = historyWithLostReport();
    const run = await memoryRun({
      sourceRef: SOURCE_REF,
      history: lost.history,
      rounds: () => passedRound(),
      turns: () => ({
        summary: 'the implementation is done',
        shutdown: { termination: 'unconfirmed', problem: UNSETTLED_RUNTIME },
      }),
    });

    const result = await runMemoryTask(run);

    expect(result.status).toBe('failed');
    expect(result.timeout).toBeNull();
    expect(result.cancellation).toBeNull();
    expect(result.reason).toContain(LOST_REPORT);
    expect(result.reason).toContain(UNSETTLED_RUNTIME);
    expect(result.reason).toMatch(/could not confirm that it had ended/);
    expect(run.rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    expect(run.inspected).toEqual([]);
    expect(result.changes.inspected).toBe(false);
    expect(result.changes.problem).toMatch(/may still be written to/);
    expect(result.attempts[0]?.agentSummary).toBe('the implementation is done');
    expect(lost.acknowledgements()).toBe(0);
  });
});
