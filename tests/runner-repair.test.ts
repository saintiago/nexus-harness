/**
 * The repair loop, the task deadline and the caller stop.
 *
 * The bounded repair allowance, the task clock and the stop: what a run does when a round is red, when it runs out of task time, and when the caller cancels it. The implementation, the checks and the cancellation are real; the clock and the runtime are substituted where a case needs a controlled one.
 */

import { getEventListeners } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runTask } from './fixtures/runner.js';
import { RunCancelledError, RunTimeoutError } from '../src/runs/contracts.js';
import { WorkspaceError } from '../src/workspace/errors.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import type { PreflightRequest } from '../src/workspace/preflight.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import { agentLogPath, appendRunLog } from '../src/reporting/logs.js';
import { writeRunReport } from '../src/reporting/report.js';
import type { RunReportRequest } from '../src/reporting/report.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';
import {
  BASELINE_TEXT,
  IMPLEMENTED_TEXT,
  createFixture,
  configuration,
  request,
  dependencies,
  fakeAgent,
  recordedEvents,
  eventOrder,
  readReport,
  readText,
  timelineMessages,
  lifecyclePhases,
  CLOCK_START,
  testClock,
  minutes,
  standInCommand,
  passedRound,
  redRound,
  stoppedRound,
  standInRounds,
  standInTurns,
  awaitStop,
  spyTimers,
  expectNoPendingTimers,
  beginRunnerFixtureEnvironment,
} from './fixtures/runner.js';

useFixtureLifecycle();

beforeEach(beginRunnerFixtureEnvironment);

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
        // The turn commits what it leaves: the run goes on to repair it, and a
        // repair turn only follows a committed working copy (HARN-35).
        commit: 'tiny-001: the implementation, as it stands',
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
});

/**
 * A clock a test moves by hand. The run reads the time from it, so its one
 * deadline is fixed the moment the run starts and a stand-in for a phase that
 * takes time moves the clock forward by the time it would have taken. Nothing in
 * this block waits for a configured limit: an hour of budget is spent by saying so.
 */

describe('a run that runs out of task time', () => {
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

  it('carries a stop preparation could not confirm into the cancellation it reports', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const agent = fakeAgent(fixture);
    const reason = 'the clone was still running 5000 ms after it was stopped';

    const result = await runTask(
      { ...request(fixture, configuration(fixture)), stop: controller.signal },
      dependencies(agent.turn, {
        // Preparation was stopped because the run was, and the Git step it was
        // stopped with could not be confirmed stopped: the run reports that
        // limitation instead of a clean cancellation, because what the step was
        // writing may still be written to and must not be reused.
        prepareWorkspace: async () => {
          controller.abort();
          throw new WorkspaceError('the clone did not finish', {
            stop: { termination: 'unconfirmed', problem: reason },
          });
        },
      }),
    );

    expect(result.status).toBe('cancelled');
    expect(result.workspace).toBeNull();
    expect(result.cancellation?.phase).toBe('preparation of the working copy');
    expect(result.cancellation?.termination).toBe('unconfirmed');
    expect(result.cancellation?.problem).toBe(reason);
    expect(agent.requests).toEqual([]);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.cancellation).toEqual(result.cancellation);
    expect(report.workspace.prepared).toBe(false);
    const timeline = timelineMessages(await readText(report.runLog));
    expect(
      timeline.some(
        (message) =>
          message.startsWith('cancelled: ') &&
          message.includes(`termination unconfirmed: ${reason}`),
      ),
    ).toBe(true);
  }, 60_000);

  it('carries an unconfirmed deadline stop from preparation into the timeout it reports', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 1 });
    const agent = fakeAgent(fixture);
    const reason = 'the clone had not ended 5000 ms after it was stopped';

    const result = await runTask(
      request(fixture, config),
      dependencies(agent.turn, {
        now: clock.now,
        // Preparation spent the whole minute and was stopped at the deadline,
        // without the harness confirming that the Git it stopped had ended.
        prepareWorkspace: async () => {
          clock.advance(minutes(1));
          throw new WorkspaceError('the clone did not finish', {
            stop: { termination: 'unconfirmed', problem: reason },
          });
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.workspace).toBeNull();
    expect(result.timeout?.phase).toBe('preparation of the working copy');
    expect(result.timeout?.termination).toBe('unconfirmed');
    expect(result.timeout?.problem).toBe(reason);
    expect(agent.requests).toEqual([]);

    const report = await readReport(result.reportPath);
    expect(report.timeout).toEqual(result.timeout);
    const timeline = timelineMessages(await readText(report.runLog));
    expect(
      timeline.some(
        (message) =>
          message.startsWith('timeout: ') && message.includes(`termination unconfirmed: ${reason}`),
      ),
    ).toBe(true);
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
    // The check is the run's own: it is given the task deadline and the clock
    // each reading's limit is read from, so a stalled reading cannot outlive
    // the run's deadline. The stop it also carries is the fixture's own — the
    // test's lifecycle stop, which stands behind every run a fixture starts —
    // and it is live for the whole run.
    expect(preflights).toHaveLength(1);
    expect(preflights[0]?.repoPath).toBe(fixture.repo);
    expect(preflights[0]?.workDir).toBe(fixture.workDir);
    expect(preflights[0]?.bounds?.deadlineMs).toBe(CLOCK_START.getTime() + minutes(1));
    expect(preflights[0]?.bounds?.now).toBe(clock.now);
    expect(preflights[0]?.bounds?.stop?.aborted).toBe(false);
    expect(agent.requests).toEqual([]);
    // Refused rather than reported: no run directory was made, so no report was
    // invented for a run that never started.
    expect(existsSync(fixture.workDir)).toBe(false);
  }, 60_000);
});

/**
 * A spy on the host's timers, installed for the length of one run: every timer
 * created while it is installed is remembered, and every one cleared is struck
 * off again. A run that arms a timer and does not release it leaves something in
 * {@link TimerSpy.pending} — which is the leak these tests are about.
 */

describe('a run the caller stops', () => {
  for (const phase of ['preflight', 'preparation', 'identity'] as const) {
    it.each(['timeout', 'cancelled'] as const)(
      `retains Git's %s and cleanup evidence from ${phase} without relying on the clock`,
      async (kind) => {
        const fixture = await createFixture();
        const agent = fakeAgent(fixture);
        const error = new WorkspaceError('Git stopped but its owned tree did not end', {
          stop: {
            kind,
            timeoutMs: 25,
            termination: 'unconfirmed',
            problem: 'owned Git tree still running',
          },
        });
        const fail = async (): Promise<never> => {
          throw error;
        };
        const parts =
          phase === 'preflight'
            ? { preflight: fail }
            : phase === 'preparation'
              ? { prepareWorkspace: fail }
              : { configureWorkspaceIdentity: fail };
        const pending = runTask(
          request(fixture, configuration(fixture)),
          dependencies(agent.turn, {
            ...parts,
            now: () => new Date('2026-09-19T12:00:00.000Z'),
          }),
        );
        if (phase === 'preflight') {
          await expect(pending).rejects.toBeInstanceOf(
            kind === 'timeout' ? RunTimeoutError : RunCancelledError,
          );
          await expect(pending).rejects.toMatchObject({ cause: error });
          expect(existsSync(fixture.workDir)).toBe(false);
        } else {
          const result = await pending;
          expect(result.status).toBe(kind === 'timeout' ? 'failed' : 'cancelled');
          expect(result.timeout ?? result.cancellation).toMatchObject({
            termination: 'unconfirmed',
            problem: 'owned Git tree still running',
          });
          const report = await readReport(result.reportPath);
          expect(report.timeout ?? report.cancellation).toEqual(
            result.timeout ?? result.cancellation,
          );
          expect(report.changes.inspected).toBe(false);
        }
        expect(agent.requests).toEqual([]);
      },
    );
  }

  it('refuses a run that was stopped before it started, and allocates nothing', async () => {
    const fixture = await createFixture();
    const config = configuration(fixture);
    const controller = new AbortController();
    const agent = fakeAgent(fixture);
    controller.abort();

    const allocations: string[] = [];
    const attempt = runTask(
      { ...request(fixture, config), stop: controller.signal },
      dependencies(agent.turn, {
        // Nothing is left to read: the run was over before it was asked for.
        preflight: async () => {
          throw new Error('the source repository must not be read for a stopped run');
        },
        allocateRunDirectory: async (workDir) => {
          allocations.push(workDir);
          return allocateRunDirectory(workDir);
        },
      }),
    );

    // Refused rather than reported, exactly as an expired task time is: there is
    // no run directory to keep and no report to write.
    await expect(attempt).rejects.toThrow(RunCancelledError);
    await expect(attempt).rejects.toThrow(/before the source repository was checked/);
    await expect(attempt).rejects.toThrow(/no command and no coding turn was started/);
    expect(allocations).toEqual([]);
    expect(agent.requests).toEqual([]);
    expect(existsSync(fixture.workDir)).toBe(false);
  }, 60_000);

  it('stops the repair turn the run was in, and runs no check round after it', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { maxRepairs: 2 });
    const controller = new AbortController();
    const rounds = standInRounds(async (asked) =>
      asked.name === 'baseline'
        ? passedRound()
        : redRound(
            await standInCommand(
              { cwd: asked.cwd, logsDir: asked.logsDir },
              { label: 'stand-in-check', exitCode: 1 },
            ),
          ),
    );
    let stoppedByRequest = false;
    const turns = standInTurns(async (asked) => {
      if (asked.turn === 1) {
        return { summary: 'the implementation turn did its work' };
      }
      await new Promise<void>((resolve) => {
        if (asked.stop.aborted) {
          resolve();
          return;
        }
        asked.stop.addEventListener('abort', () => resolve(), { once: true });
        // The caller stops the run while the repair turn is working.
        controller.abort();
      });
      asked.agentLog.write('the repair turn was asked to stop and stopped\n');
      stoppedByRequest = true;
      return { summary: 'the repair turn stopped when the run was stopped' };
    });

    const result = await runTask(
      { ...request(fixture, config), stop: controller.signal },
      dependencies(turns.run, { now: clock.now, runCheckRound: rounds.run }),
    );

    expect(stoppedByRequest).toBe(true);
    // The turn the run was in was asked to stop; the turn that had already
    // returned was not.
    expect(turns.requests.map((turn) => turn.stop.aborted)).toEqual([false, true]);
    expect(turns.requests[1]?.repair?.repairedTurn).toBe(1);

    expect(result.status).toBe('cancelled');
    expect(result.timeout).toBeNull();
    expect(result.cancellation).toEqual({
      phase: 'repair turn 2',
      elapsedMs: 0,
      termination: 'confirmed',
      problem: null,
    });
    expect(result.reason).toMatch(
      /repair turn 2 was stopped because the run was stopped by its caller, so no check was run after it and no further turn was started/,
    );

    // No later check round and no later turn: nothing was started after the stop.
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    expect(turns.requests).toHaveLength(2);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.timeout).toBeNull();
    expect(report.cancellation).toEqual(result.cancellation);
    expect(report.attempts.map((attempt) => [attempt.turn, attempt.checks === null])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(report.attempts[1]?.agentSummary).toBe(
      'the repair turn stopped when the run was stopped',
    );
    expect(report.repairsUsed).toBe(1);
    // The stopped turn's own log keeps what it wrote, and the timeline stops there.
    expect(await readText(report.attempts[1]?.agentLog ?? '')).toContain(
      'the repair turn was asked to stop and stopped',
    );
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
    expect(timeline).toContain('cancelled: the run was stopped by its caller during repair turn 2');
    expect(timeline.at(-1)).toMatch(/^final status: cancelled, repair turn 2 was stopped/);
    // The working copy is kept for inspection, as it is for every other ending.
    expect(existsSync(path.join(result.run.workspacePath, '.git'))).toBe(true);
  }, 60_000);

  it('stops at the boundary when the caller stops the run as a turn returns', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture);
    const controller = new AbortController();
    const rounds = standInRounds(() => passedRound());
    const turns = standInTurns((asked) => {
      asked.agentLog.write('the turn finished just as the run was stopped\n');
      return { summary: 'the implementation turn finished as the run was stopped' };
    });

    const result = await runTask(
      { ...request(fixture, config), stop: controller.signal },
      dependencies(turns.run, {
        now: clock.now,
        runCheckRound: rounds.run,
        // The turn has returned and its result is recorded; the caller stops the
        // run in that window — after the turn's own stop request was released,
        // and before anything could be observed after it.
        appendRunLog: async (runLog, message) => {
          if (message.startsWith('implementation turn result')) {
            controller.abort();
          }
          return appendRunLog(runLog, message);
        },
      }),
    );

    expect(result.status).toBe('cancelled');
    expect(result.cancellation).toEqual({
      phase: 'implementation turn',
      elapsedMs: 0,
      termination: 'confirmed',
      problem: null,
    });
    expect(result.reason).toMatch(
      /the implementation turn returned, and the run was stopped by its caller before any check could run after it, so no check and no further turn was started/,
    );

    // Nothing ran after the turn — not even the round that was about to start —
    // and what the turn said about itself is kept as agent text, not as evidence.
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.checks).toBeNull();
    expect(report.attempts[0]?.agentSummary).toBe(
      'the implementation turn finished as the run was stopped',
    );
    expect(await readText(report.attempts[0]?.agentLog ?? '')).toContain(
      'the turn finished just as the run was stopped',
    );
  }, 60_000);

  it('keeps the stop it observed when the turn that was stopped then failed', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { maxRepairs: 2 });
    const controller = new AbortController();
    // The baseline passes, the implementation turn leaves a red round behind, and
    // the repair turn is the one the caller stops.
    const rounds = standInRounds(async (asked) =>
      asked.name === 'baseline'
        ? passedRound()
        : redRound(
            await standInCommand(
              { cwd: asked.cwd, logsDir: asked.logsDir },
              { label: 'stand-in-check', exitCode: 1 },
            ),
          ),
    );
    const turns = standInTurns(async (asked) => {
      if (asked.turn === 1) {
        return { summary: 'the implementation turn did its work' };
      }
      // The turn is stopped, and then fails on its way out: a late failure of a
      // turn the run has already stopped for is not what the run ended for.
      await new Promise<void>((resolve) => {
        if (asked.stop.aborted) {
          resolve();
          return;
        }
        asked.stop.addEventListener('abort', () => resolve(), { once: true });
        controller.abort();
      });
      asked.agentLog.write('the repair turn was stopped and then failed on its way out\n');
      throw new Error('the runtime lost its connection while stopping the turn');
    });

    const result = await runTask(
      { ...request(fixture, config), stop: controller.signal },
      dependencies(turns.run, { now: clock.now, runCheckRound: rounds.run }),
    );

    // The stop is the reason, not the failure: `cancelled` rather than `failed`,
    // and the sentence names the stop the run observed first.
    expect(result.status).toBe('cancelled');
    expect(result.timeout).toBeNull();
    expect(result.cancellation?.phase).toBe('repair turn 2');
    expect(result.cancellation?.termination).toBe('confirmed');
    expect(result.reason).toMatch(
      /repair turn 2 was stopped because the run was stopped by its caller, so no check was run after it and no further turn was started/,
    );
    expect(result.reason).not.toMatch(/lost its connection/);

    // Nothing was started after the stop, and the turn's failure is kept where it
    // belongs: in the timeline and in the turn's own log, as a turn that failed,
    // not as the run's reason.
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    expect(turns.requests).toHaveLength(2);
    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.attempts.map((attempt) => [attempt.turn, attempt.checks === null])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(report.attempts[1]?.agentSummary).toBeNull();
    expect(await readText(report.attempts[1]?.agentLog ?? '')).toContain(
      'the repair turn was stopped and then failed on its way out',
    );
    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline).toContain(
      'repair turn 2 result: failed, the runtime lost its connection while stopping the turn',
    );
    expect(timeline.at(-1)).toMatch(/^final status: cancelled, repair turn 2 was stopped/);
  }, 60_000);

  it('ends the run when a round stopped between two commands because the run was stopped', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture);
    const controller = new AbortController();
    const turns = standInTurns(() => ({ summary: 'the implementation turn did its work' }));
    const rounds = standInRounds((asked) => {
      if (asked.name === 'baseline') {
        return passedRound();
      }
      // The round was stopped between two commands: nothing was left running,
      // and the command it was about to start was never started.
      controller.abort();
      return {
        outcome: 'execution-error',
        setup: [],
        checks: [],
        problem:
          'the run was stopped by its caller before check 1 could start, so it was not started.',
      };
    });

    const result = await runTask(
      { ...request(fixture, config), stop: controller.signal },
      dependencies(turns.run, { now: clock.now, runCheckRound: rounds.run }),
    );

    expect(result.status).toBe('cancelled');
    expect(result.cancellation).toEqual({
      phase: 'the checks after the implementation turn',
      elapsedMs: 0,
      termination: 'confirmed',
      problem: null,
    });
    expect(result.reason).toBe(
      'the run was stopped by its caller during the checks after the implementation turn: nothing further was started',
    );

    // The round that could not be run is kept as that turn's evidence, and no
    // further round and no repair turn followed it.
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
    expect(turns.requests).toHaveLength(1);
    const report = await readReport(result.reportPath);
    expect(report.attempts[0]?.checks?.outcome).toBe('execution-error');
    expect(report.attempts[0]?.checks?.problem).toContain('stopped by its caller');
    expect(report.cancellation).toEqual(result.cancellation);
  }, 60_000);

  it('keeps the timeout it observed first when the caller stops the run as well', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 1, maxRepairs: 2 });
    const controller = new AbortController();
    const rounds = standInRounds(() => {
      // The baseline spends all of the run's one minute but a moment.
      clock.advance(minutes(1) - 300);
      return passedRound();
    });
    const turns = standInTurns(async (asked) => {
      // The turn is asked to stop when the run's time runs out, and answers late:
      // by the time it returns, the caller has stopped the run too. The reason the
      // run recorded is the one it observed first, and neither of these replaces it.
      await awaitStop(asked);
      controller.abort();
      asked.agentLog.write('the turn answered after it was stopped\n');
      return { summary: 'the turn answered after it was stopped' };
    });

    const result = await runTask(
      { ...request(fixture, config), stop: controller.signal },
      dependencies(turns.run, { now: clock.now, runCheckRound: rounds.run }),
    );

    expect(result.status).toBe('failed');
    expect(result.timeout?.limit).toBe('task');
    expect(result.timeout?.phase).toBe('implementation turn');
    // A stop that arrives afterwards does not turn a recorded timeout into a
    // cancellation, and the late turn does not add a check round either.
    expect(result.cancellation).toBeNull();
    expect(result.reason).toMatch(
      /the implementation turn was stopped when the run's remaining task time ran out/,
    );
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    expect(turns.requests).toHaveLength(1);

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.timeout).toEqual(result.timeout);
    expect(report.cancellation).toBeNull();
    expect(report.attempts[0]?.checks).toBeNull();
    expect(report.attempts[0]?.agentSummary).toBe('the turn answered after it was stopped');
    expect(timelineMessages(await readText(report.runLog)).join('\n')).not.toContain('cancelled:');
  }, 60_000);

  it('finalizes a cancelled run once, with one reason, and leaves no listener or timer armed', async () => {
    const fixture = await createFixture();
    const config = configuration(fixture, { maxRepairs: 2 });
    const controller = new AbortController();
    const projects: RunReportRequest[] = [];
    const rounds = standInRounds(async (asked) =>
      asked.name === 'baseline'
        ? passedRound()
        : redRound(
            await standInCommand(
              { cwd: asked.cwd, logsDir: asked.logsDir },
              { label: 'stand-in-check', exitCode: 1 },
            ),
          ),
    );
    const turns = standInTurns((asked) => {
      if (asked.turn === 1) {
        return { summary: 'the implementation turn did its work' };
      }
      controller.abort();
      return { summary: 'the repair turn stopped when the run was stopped' };
    });

    const timers = spyTimers();
    let result;
    try {
      result = await runTask(
        { ...request(fixture, config), stop: controller.signal },
        dependencies(turns.run, {
          runCheckRound: rounds.run,
          writeRunReport: async (asked) => {
            projects.push(asked);
            return writeRunReport(asked);
          },
        }),
      );
    } finally {
      timers.restore();
    }

    // The caller asks again, twice, after the run has ended: a run finalizes once,
    // and a stop that arrives afterwards has nothing left to stop.
    controller.abort();
    controller.abort();

    expect(result.status).toBe('cancelled');
    expect(projects).toHaveLength(1);
    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.reason).toBe(result.reason);
    expect(report.cancellation).toEqual(result.cancellation);
    const finals = timelineMessages(await readText(report.runLog)).filter((message) =>
      message.startsWith('final status:'),
    );
    expect(finals).toHaveLength(1);

    // Nothing of the run is still listening for the caller's stop, and nothing it
    // armed for itself is still pending.
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    await expectNoPendingTimers(timers);
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline', 'attempt-1']);
  }, 60_000);

  it('releases the deadline of a phase that finished inside its budget', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 1 });
    const rounds = standInRounds((asked) => {
      // The baseline leaves the run 400 ms of its minute; the turn then returns
      // at once, well inside what is left.
      if (asked.name === 'baseline') {
        clock.advance(minutes(1) - 400);
      }
      return passedRound();
    });
    const turns = standInTurns(() => ({ summary: 'the implementation turn did its work' }));

    const result = await runTask(
      request(fixture, config),
      dependencies(turns.run, { now: clock.now, runCheckRound: rounds.run }),
    );

    expect(result.status).toBe('passed');
    expect(turns.requests[0]?.stop.aborted).toBe(false);
    // Long enough for the 400 ms that were left: a deadline the run no longer
    // needs is released rather than left armed for a turn that has returned.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(turns.requests[0]?.stop.aborted).toBe(false);
  }, 60_000);

  it('gives a turn only the task time the checkout before it left', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 1 });
    const rounds = standInRounds(() => passedRound());
    let waitedMs: number | null = null;
    const turns = standInTurns(async (asked) => {
      // The turn waits for the stop the run armed for it, so what it was given
      // is measured rather than inferred: the return below spends all but 300 ms
      // of the run's minute, so the stop has to arrive in a moment.
      const startedAt = Date.now();
      await awaitStop(asked);
      waitedMs = Date.now() - startedAt;
      return { summary: "the turn was stopped by the run's own deadline" };
    });

    const result = await runTask(
      request(fixture, config),
      dependencies(turns.run, {
        now: clock.now,
        runCheckRound: rounds.run,
        returnToRecordedBranch: async () => {
          // Returning the checkout is real Git work the run spends its own time
          // on: a turn is given what is left after it, not the budget the run
          // had before it started.
          clock.advance(minutes(1) - 300);
          return { changed: false };
        },
      }),
    );

    // The turn's stop was the run's deadline, and it reached the turn in the
    // 300 ms that were left rather than in the minute it was never given.
    expect(result.status).toBe('failed');
    expect(result.timeout).toMatchObject({ limit: 'task', phase: 'implementation turn' });
    expect(result.reason).toMatch(
      /the implementation turn was stopped when the run's remaining task time ran out/,
    );
    expect(waitedMs).not.toBeNull();
    // The budget that was left is 300 ms; the bound is generous because the
    // point is that it is not the minute the run had before the return.
    expect(waitedMs ?? Number.POSITIVE_INFINITY).toBeLessThan(10_000);
    // Nothing followed the stopped turn: the round that judges it never ran.
    expect(rounds.requests.map((round) => round.name)).toEqual(['baseline']);
    expect(turns.requests).toHaveLength(1);
  }, 60_000);
});
