/**
 * One task through the loop, with a fake coding agent.
 *
 * Every run here is real — a temporary Git repository is cloned, the configured commands run as real children, and the report is the one the harness wrote — with only the coding turn substituted. This file owns the loop up to a green baseline and the working copy a turn leaves: what a run does before its first turn, how it continues a workspace, what it commits, and how it returns a checkout to the recorded branch.
 */

import { existsSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runTask } from './fixtures/runner.js';
import type { RunnerDependencies } from '../src/runs/contracts.js';
import { WorkspaceError } from '../src/workspace/errors.js';
import { prepareWorkspace } from './fixtures/boundary-operations.js';
import { reopenWorkspace } from './fixtures/boundary-operations.js';
import { readWorkspaceState, workspaceStatePath } from '../src/workspace/state.js';
import { agentLogPath } from '../src/reporting/logs.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';
import type { Command } from '../src/shared/types.js';
import {
  git,
  gitOrFail,
  BASELINE_TEXT,
  IMPLEMENTED_TEXT,
  TASK,
  createFixture,
  command,
  configuration,
  request,
  SOURCE_REF,
  expectationFor,
  dependencies,
  fakeAgent,
  recordedEvents,
  eventOrder,
  expectNoTurnOverlap,
  readReport,
  readText,
  timelineMessages,
  lifecyclePhases,
  testClock,
  minutes,
  runLogsDir,
  beginRunnerFixtureEnvironment,
} from './fixtures/runner.js';

useFixtureLifecycle();

beforeEach(beginRunnerFixtureEnvironment);

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

describe('a run that continues a workspace', () => {
  it('starts from the red working copy it was pointed at, reaches its turn, and records the attempt', async () => {
    const fixture = await createFixture();

    // The first attempt: a fresh workspace whose baseline is green, and whose turn
    // leaves something behind that only this clone has.
    const firstAgent = fakeAgent(fixture, {
      file: 'first-only.txt',
      text: 'from the first attempt\n',
      commit: 'tiny-001: a file only this clone has',
    });
    const first = await runTask(
      { ...request(fixture, configuration(fixture)), sourceRef: SOURCE_REF },
      dependencies(firstAgent.turn),
    );
    const workspaceId = first.workspace?.workspaceId ?? '';
    expect(workspaceId).not.toBe('');
    expect(first.workspace?.continued).toBe(false);
    expect(first.status).toBe('passed');

    // The second attempt is pointed at that workspace, and its own check is red
    // against the working copy as it stands: a continuation may start red.
    const agent = fakeAgent(fixture);
    const config = configuration(fixture, {
      checks: [command(fixture, 'check-1', 'need', 'app.txt', IMPLEMENTED_TEXT)],
    });
    const result = await runTask(
      {
        ...request(fixture, config),
        continuedWorkspace: await reopenWorkspace(
          fixture.workDir,
          workspaceId,
          await expectationFor(fixture, workspaceId),
        ),
      },
      dependencies(agent.turn),
    );

    // It ran: the red baseline did not stop the coding turn, and the round after
    // that turn is what decided the attempt.
    expect(result.status).toBe('passed');
    expect(firstAgent.requests).toHaveLength(1);
    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0]?.workspacePath).toBe(first.workspace?.workspacePath);
    expect(await readText(path.join(result.workspace?.workspacePath ?? '', 'app.txt'))).toBe(
      `${BASELINE_TEXT}${IMPLEMENTED_TEXT}`,
    );
    // The work of the earlier attempt is still there: the same clone, not a copy.
    expect(await readText(path.join(result.workspace?.workspacePath ?? '', 'first-only.txt'))).toBe(
      'from the first attempt\n',
    );

    const report = await readReport(result.reportPath);
    expect(report.workspace.continued).toBe(true);
    expect(report.workspace.attempt).toBe(2);
    expect(report.workspace.workspaceId).toBe(workspaceId);
    expect(report.workspace.path).toBe(first.workspace?.workspacePath);
    expect(report.baseline?.outcome).toBe('failed');
    const timelineText = await readText(report.runLog);
    expect(timelineText).toContain(`continuing workspace ${workspaceId} (attempt 2)`);
    expect(timelineText).toContain('this attempt continues a workspace that was already red');

    // Both attempts are recorded against the workspace, oldest first, so the next
    // one knows which attempt it is.
    const ledger = await readWorkspaceState(fixture.workDir, workspaceId);
    expect(ledger?.attempts.map((attempt) => attempt.outcome)).toEqual(['passed', 'passed']);
    expect(ledger?.attempts[1]?.runId).toBe(result.run.runId);
  }, 120_000);
});

describe('a run whose attempt cannot be recorded in its workspace ledger', () => {
  it('keeps the report and its check evidence, and names the ledger that did not record it', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(fixture);
    const failure = 'the ledger could not be replaced: the file is read-only';

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn, {
        recordWorkspaceAttempt: async () => {
          throw new WorkspaceError(failure);
        },
      }),
    );

    expect(result.status).toBe('passed');
    const workspaceId = result.workspace?.workspaceId ?? '';
    const ledgerPath = workspaceStatePath(fixture.workDir, workspaceId);
    expect(result.workspaceLedgerProblem).toContain(ledgerPath);
    expect(result.workspaceLedgerProblem).toContain(failure);

    // Nothing the run observed is lost to the failed save: the report, the check
    // round that decided the run, and the working copy are all where they were
    // written.
    const report = await readReport(result.reportPath);
    expect(report.status).toBe('passed');
    expect(report.attempts.at(-1)?.checks?.outcome).toBe('passed');
    expect(await readText(path.join(result.workspace?.workspacePath ?? '', 'app.txt'))).toBe(
      `${BASELINE_TEXT}${IMPLEMENTED_TEXT}`,
    );
    const timeline = await readText(report.runLog);
    expect(timeline).toContain('workspace ledger: this attempt could not be recorded');
    // And the ledger really does not hold the attempt: the failure is reported
    // rather than rounded into a save that succeeded.
    const ledger = await readWorkspaceState(fixture.workDir, workspaceId);
    expect(ledger?.attempts).toEqual([]);
  }, 120_000);

  it('records the attempt and reports no problem when the save succeeds', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(fixture);
    // A red baseline ends this run before any coding turn, so the assertion is
    // about the attempt record a normal ending writes.
    const config = configuration(fixture, {
      checks: [command(fixture, 'check-1', 'need', 'app.txt', 'text the baseline does not have')],
    });

    const result = await runTask(request(fixture, config), dependencies(agent.turn));

    expect(result.status).toBe('failed');
    expect(result.workspaceLedgerProblem).toBeNull();
    const ledger = await readWorkspaceState(fixture.workDir, result.workspace?.workspaceId ?? '');
    expect(ledger?.attempts).toHaveLength(1);
    expect(ledger?.attempts[0]).toMatchObject({
      runId: result.run.runId,
      outcome: 'failed',
      reportPath: result.reportPath,
    });
  }, 120_000);
});

describe('a working copy a coding turn commits in', () => {
  it('has its repository-local identity before the turn runs, and keeps the commit', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(fixture, {
      commits: [
        { file: 'checkpoint.txt', text: 'a completed piece\n', message: 'tiny-001: checkpoint' },
      ],
    });

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn),
    );

    expect(result.status).toBe('passed');
    const workspace = result.workspace?.workspacePath ?? '';
    // The identity is repository-local: it lives in the working copy's own
    // configuration, and it was written before the turn ran.
    expect((await gitOrFail(['config', '--local', 'user.name'], workspace)).trim()).toBe(
      'Nexus Agent',
    );
    expect((await gitOrFail(['config', '--local', 'user.email'], workspace)).trim()).toBe(
      'nexus@local',
    );
    expect((await gitOrFail(['config', '--local', 'commit.gpgsign'], workspace)).trim()).toBe(
      'false',
    );
    // The turn's commit ran with no author or committer variables and no global
    // Git configuration, so the workspace's own identity is what made it work,
    // and signing stayed off.
    expect(
      (await gitOrFail(['log', '--max-count=1', '--format=%an <%ae>'], workspace)).trim(),
    ).toBe('Nexus Agent <nexus@local>');
    expect(await gitOrFail(['cat-file', '-p', 'HEAD'], workspace)).not.toContain('gpgsig');
    // What the turn committed is recorded against the run's recorded base, like
    // any other work the run left behind.
    const report = await readReport(result.reportPath);
    expect(report.changes.paths.find((entry) => entry.path === 'checkpoint.txt')?.states).toEqual([
      'committed',
    ]);
  }, 60_000);

  it('configures the identity for a continuation that did not go through reopenWorkspace', async () => {
    const fixture = await createFixture();
    // The first attempt commits its own work: a coding turn is only ever started
    // from the workspace's own committed state (HARN-35).
    const first = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(fakeAgent(fixture, { commit: 'tiny-001: the implementation' }).turn),
    );
    const workspace = first.workspace;
    expect(workspace).not.toBeNull();
    if (workspace === null) {
      return;
    }

    // The escalation ladder hands the next run this record of the workspace it
    // just used, without reopening it first (sources/coordinator.ts). The
    // settings this run needs must not depend on the earlier attempt's.
    for (const key of ['user.name', 'user.email', 'commit.gpgsign']) {
      await gitOrFail(['config', '--local', '--unset-all', key], workspace.workspacePath);
    }
    const agent = fakeAgent(fixture, {
      commits: [
        {
          file: 'escalated.txt',
          text: 'the next tier committed this\n',
          message: 'tiny-001: tier two checkpoint',
        },
      ],
    });
    const second = await runTask(
      {
        ...request(
          fixture,
          configuration(fixture, {
            checks: [command(fixture, 'check-1', 'need', 'app.txt', IMPLEMENTED_TEXT)],
          }),
        ),
        continuedWorkspace: {
          workspaceId: workspace.workspaceId,
          workspacePath: workspace.workspacePath,
          branch: workspace.branch,
          baseCommit: workspace.baseCommit,
          attempt: workspace.attempt + 1,
        },
      },
      dependencies(agent.turn),
    );

    expect(second.status).toBe('passed');
    expect(
      (await gitOrFail(['config', '--local', 'user.name'], workspace.workspacePath)).trim(),
    ).toBe('Nexus Agent');
    expect(
      (
        await gitOrFail(['log', '--max-count=1', '--format=%an <%ae>'], workspace.workspacePath)
      ).trim(),
    ).toBe('Nexus Agent <nexus@local>');
  }, 120_000);

  it('ends the run, with a report, when the identity cannot be configured', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(fixture);
    const rounds: string[] = [];

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn, {
        configureWorkspaceIdentity: async (workspacePath) => {
          throw new WorkspaceError(
            `the working copy's local Git setting "user.name" could not be set in ` +
              `"${workspacePath}": a read-only .git/config`,
          );
        },
        runCheckRound: async (asked) => {
          rounds.push(asked.name);
          return { outcome: 'passed', setup: [], checks: [], problem: null };
        },
      }),
    );

    // Nothing runs with an unknown identity: no check round, no coding turn.
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('local Git identity could not be configured');
    expect(rounds).toEqual([]);
    expect(agent.requests).toEqual([]);

    // The run is still reported, keeps its working copy, and names what could
    // not be written.
    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.baseline).toBeNull();
    expect(report.attempts).toEqual([]);
    expect(report.workspace.prepared).toBe(true);
    expect(report.reason).toContain('user.name');
  }, 60_000);

  it('does not start the identity phase for a run stopped while its workspace was recorded', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const identities: string[] = [];
    const agent = fakeAgent(fixture);

    const result = await runTask(
      {
        ...request(fixture, configuration(fixture)),
        stop: controller.signal,
        // The caller stops the run in the hook a source uses to record where the
        // workspace lives: after preparation, before anything else starts.
        onWorkspaceReady: async () => {
          controller.abort();
        },
      },
      dependencies(agent.turn, {
        configureWorkspaceIdentity: async (workspacePath) => {
          identities.push(workspacePath);
        },
      }),
    );

    // The mutating phase was never started, and the run is reported as the stop
    // it was rather than as whatever the phase would have failed with.
    expect(identities).toEqual([]);
    expect(agent.requests).toEqual([]);
    expect(result.status).toBe('cancelled');
    expect(result.cancellation?.phase).toBe("the working copy's Git identity");
    expect(result.reason).toMatch(
      /stopped by its caller before the working copy's Git identity was configured/,
    );

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.baseline).toBeNull();
    expect(report.cancellation?.phase).toBe("the working copy's Git identity");
  }, 60_000);

  it('does not start the identity phase once preparation has spent the task time', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { taskTimeoutMinutes: 1 });
    const identities: string[] = [];
    const agent = fakeAgent(fixture);

    const result = await runTask(
      request(fixture, config),
      dependencies(agent.turn, {
        now: clock.now,
        // Preparation used up the run's whole minute.
        prepareWorkspace: async (run, source, bounds) => {
          const workspace = await prepareWorkspace(run, source, bounds);
          clock.advance(minutes(1));
          return workspace;
        },
        configureWorkspaceIdentity: async (workspacePath) => {
          identities.push(workspacePath);
        },
      }),
    );

    expect(identities).toEqual([]);
    expect(agent.requests).toEqual([]);
    expect(result.status).toBe('failed');
    expect(result.timeout).toEqual({
      limit: 'task',
      phase: "the working copy's Git identity",
      limitMs: minutes(1),
      elapsedMs: minutes(1),
      termination: 'confirmed',
      problem: null,
    });
    expect(result.reason).toMatch(
      /task deadline expired before the working copy's Git identity was configured/,
    );

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.timeout?.phase).toBe("the working copy's Git identity");
  }, 60_000);

  it('classifies a stop that arrives during a rejecting identity phase as a cancellation', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const agent = fakeAgent(fixture);

    const result = await runTask(
      { ...request(fixture, configuration(fixture)), stop: controller.signal },
      dependencies(agent.turn, {
        // The phase was started, the caller stopped the run while it ran, and it
        // rejected on the way out: the stop is what the run ended for.
        configureWorkspaceIdentity: async (workspacePath) => {
          controller.abort();
          throw new WorkspaceError(
            `the working copy's local Git setting "user.name" could not be set in ` +
              `"${workspacePath}": a read-only .git/config`,
          );
        },
      }),
    );

    expect(agent.requests).toEqual([]);
    expect(result.status).toBe('cancelled');
    expect(result.timeout).toBeNull();
    expect(result.cancellation?.phase).toBe("the working copy's Git identity");
    expect(result.reason).toMatch(
      /stopped by its caller while the working copy's Git identity was being configured/,
    );

    const report = await readReport(result.reportPath);
    expect(report.status).toBe('cancelled');
    expect(report.cancellation?.phase).toBe("the working copy's Git identity");
    // The rejection is not recorded as an ordinary configuration failure.
    expect(report.reason).not.toContain('could not be configured');
  }, 60_000);
});

/**
 * A coding turn works with Git write access, so it can commit on a branch of its
 * own and leave the checkout there. What the checks judge, and what a delivery
 * step publishes, is the branch the workspace records: a clean checkout that
 * descends from it is returned to it — fast-forwarded, with every commit kept —
 * before the round reads the working copy, and a checkout that cannot be
 * returned that way ends the run before any check (HARN-35).
 */
describe('a working copy a turn leaves on a branch of its own', () => {
  /** The branch a checkout is on, or `''` when it is on no branch. */
  async function branchOf(workspacePath: string): Promise<string> {
    return (await gitOrFail(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspacePath)).trim();
  }

  /** The commit a ref points at in the fixture's own Git environment. */
  async function commitOf(workspacePath: string, ref: string): Promise<string> {
    return (await gitOrFail(['rev-parse', '--verify', ref], workspacePath)).trim();
  }

  it('returns a repair turn to the recorded branch, keeping the earlier commit', async () => {
    const fixture = await createFixture([{ file: 'target.txt', text: IMPLEMENTED_TEXT }]);
    const starts: string[] = [];
    const agent: RunnerDependencies['runAgentTurn'] = async (request) => {
      starts.push(await branchOf(request.workspacePath));
      if (request.turn === 1) {
        // The implementation turn breaks what the check verifies, commits that
        // on a branch of its own, and leaves the checkout there: the workspace's
        // recorded branch still points at the base, and the round after this
        // turn is red against the commit the branch takes from it.
        await gitOrFail(['checkout', '--quiet', '-b', 'task/side'], request.workspacePath);
        await writeFile(
          path.join(request.workspacePath, 'target.txt'),
          'broken by the implementation turn\n',
          'utf8',
        );
        await gitOrFail(['add', 'target.txt'], request.workspacePath);
        await gitOrFail(
          ['commit', '--quiet', '--message', 'the first turn'],
          request.workspacePath,
        );
      } else {
        // The repair turn works where the harness asked it to: the branch the
        // workspace records, which the commit above must already be on.
        await writeFile(path.join(request.workspacePath, 'target.txt'), IMPLEMENTED_TEXT, {
          flag: 'a',
        });
      }
      return { summary: `turn ${String(request.turn)}` };
    };

    const result = await runTask(
      request(
        fixture,
        configuration(fixture, {
          checks: [command(fixture, 'check-1', 'need', 'target.txt', IMPLEMENTED_TEXT)],
        }),
      ),
      dependencies(agent),
    );

    expect(result.status).toBe('passed');
    expect(starts).toHaveLength(2);
    // Every turn started on the branch the workspace records — the repair turn
    // after the implementation turn left a branch of its own.
    const workspacePath = result.workspace?.workspacePath ?? '';
    expect(starts[0]).toBe(result.workspace?.branch);
    expect(starts[1]).toBe(result.workspace?.branch);
    expect(await branchOf(workspacePath)).toBe(result.workspace?.branch);

    // The commit of the branch the first turn used is on the recorded branch,
    // and the branch itself still holds it: nothing was reset or discarded.
    const side = await commitOf(workspacePath, 'refs/heads/task/side');
    expect(await commitOf(workspacePath, `refs/heads/${result.workspace?.branch ?? ''}`)).toBe(
      side,
    );
    expect(await commitOf(workspacePath, 'HEAD')).toBe(side);
    expect((await git(['merge-base', '--is-ancestor', side, 'HEAD'], workspacePath)).code).toBe(0);
    // The repair turn's work is there too: the recorded branch holds the commit
    // the implementation turn made, and the repair turn added to it.
    expect(await readText(path.join(workspacePath, 'target.txt'))).toBe(
      `broken by the implementation turn\n${IMPLEMENTED_TEXT}`,
    );

    // What the rounds saw: the first was red, and the round that decided the run
    // passed on the recorded branch after the repair turn.
    const report = await readReport(result.reportPath);
    expect(report.attempts.map((entry) => entry.checks?.outcome)).toEqual(['failed', 'passed']);
    expect(report.changes.paths.map((entry) => entry.path)).toEqual(['target.txt']);
    const timeline = await readText(report.runLog);
    expect(timeline).toContain(
      `checkout returned to branch ${result.workspace?.branch ?? ''} at ${side}, from task/side`,
    );
  }, 120_000);

  it('fast-forwards before the repair turn even when Git configuration would squash the merge', async () => {
    const fixture = await createFixture([{ file: 'target.txt', text: IMPLEMENTED_TEXT }]);
    const starts: string[] = [];
    const agent: RunnerDependencies['runAgentTurn'] = async (request) => {
      starts.push(await branchOf(request.workspacePath));
      if (request.turn === 1) {
        // Git reads `branch.<name>.mergeOptions` when merging into that branch,
        // and `--ff-only` does not cancel a configured `--squash`: a return that
        // trusted the exit code would stage this commit without moving the
        // recorded branch, and the repair turn would then be refused a staged
        // working copy instead of starting on the commit the checks saw.
        const recorded = await branchOf(request.workspacePath);
        await gitOrFail(
          ['config', `branch.${recorded}.mergeOptions`, '--squash'],
          request.workspacePath,
        );
        await gitOrFail(['checkout', '--quiet', '-b', 'task/side'], request.workspacePath);
        await writeFile(
          path.join(request.workspacePath, 'target.txt'),
          'broken by the implementation turn\n',
          'utf8',
        );
        await gitOrFail(['add', 'target.txt'], request.workspacePath);
        await gitOrFail(
          ['commit', '--quiet', '--message', 'the first turn'],
          request.workspacePath,
        );
      } else {
        await writeFile(path.join(request.workspacePath, 'target.txt'), IMPLEMENTED_TEXT, {
          flag: 'a',
        });
      }
      return { summary: `turn ${String(request.turn)}` };
    };

    const result = await runTask(
      request(
        fixture,
        configuration(fixture, {
          checks: [command(fixture, 'check-1', 'need', 'target.txt', IMPLEMENTED_TEXT)],
        }),
      ),
      dependencies(agent),
    );

    expect(result.status).toBe('passed');
    expect(starts).toEqual([result.workspace?.branch, result.workspace?.branch]);
    // The repair turn really worked on the commit the implementation turn made:
    // the recorded branch took it, the checkout is on it and clean, and the
    // repair turn's work is committed there.
    const workspacePath = result.workspace?.workspacePath ?? '';
    const side = await commitOf(workspacePath, 'refs/heads/task/side');
    expect(await branchOf(workspacePath)).toBe(result.workspace?.branch);
    expect(await commitOf(workspacePath, `refs/heads/${result.workspace?.branch ?? ''}`)).toBe(
      side,
    );
    expect(await commitOf(workspacePath, 'HEAD')).toBe(side);
    expect(
      (
        await git(
          ['merge-base', '--is-ancestor', result.workspace?.baseCommit ?? '', side],
          workspacePath,
        )
      ).code,
    ).toBe(0);
    expect(await readText(path.join(workspacePath, 'target.txt'))).toBe(
      `broken by the implementation turn\n${IMPLEMENTED_TEXT}`,
    );

    const report = await readReport(result.reportPath);
    expect(report.attempts.map((entry) => entry.checks?.outcome)).toEqual(['failed', 'passed']);
    const timeline = await readText(report.runLog);
    expect(timeline).toContain(
      `checkout returned to branch ${result.workspace?.branch ?? ''} at ${side}, from task/side`,
    );
  }, 120_000);

  it('stops before the checks when the checkout cannot be returned, keeping its work', async () => {
    const fixture = await createFixture();
    const starts: string[] = [];
    const agent: RunnerDependencies['runAgentTurn'] = async (request) => {
      starts.push(await branchOf(request.workspacePath));
      await gitOrFail(['checkout', '--quiet', '-b', 'task/side'], request.workspacePath);
      await writeFile(path.join(request.workspacePath, 'side.txt'), 'the commit\n', 'utf8');
      await gitOrFail(['add', 'side.txt'], request.workspacePath);
      await gitOrFail(['commit', '--quiet', '--message', 'the commit'], request.workspacePath);
      // And the turn also leaves something it never committed, so checking the
      // recorded branch out would mean switching a dirty checkout.
      await writeFile(path.join(request.workspacePath, 'leftover.txt'), 'uncommitted\n', 'utf8');
      return { summary: 'left a dirty branch of its own' };
    };

    const result = await runTask(request(fixture, configuration(fixture)), dependencies(agent));

    expect(result.status).toBe('failed');
    expect(starts).toHaveLength(1);
    expect(result.reason).toMatch(/could not be returned to the branch this workspace records/);
    expect(result.reason).toContain('task/side');
    expect(result.reason).toContain(`"${result.workspace?.branch ?? ''}"`);
    expect(result.reason).toContain('leftover.txt');
    expect(result.reason).toMatch(/Commit or remove those paths by hand/);

    // The turn ran and is kept, with no check round observed after it: the
    // fixture processes only ever ran the baseline.
    const report = await readReport(result.reportPath);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.kind).toBe('implementation');
    expect(report.attempts[0]?.checks).toBeNull();
    expect(eventOrder(await recordedEvents(fixture))).toEqual([
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
    ]);

    // Nothing was switched, reset, or discarded: the commit, the leftover, and
    // the recorded branch are all where the turn left them.
    const workspacePath = result.workspace?.workspacePath ?? '';
    expect(await branchOf(workspacePath)).toBe('task/side');
    expect(await readText(path.join(workspacePath, 'leftover.txt'))).toBe('uncommitted\n');
    expect(await commitOf(workspacePath, `refs/heads/${result.workspace?.branch ?? ''}`)).toBe(
      result.workspace?.baseCommit,
    );
  }, 120_000);

  it('stops when the checkout and the recorded branch diverged, naming both revisions', async () => {
    const fixture = await createFixture();
    const starts: string[] = [];
    let side = '';
    let recorded = '';
    const agent: RunnerDependencies['runAgentTurn'] = async (request) => {
      starts.push(await branchOf(request.workspacePath));
      // The turn moves the recorded branch on, then commits on a branch of its
      // own started from the base, so neither side descends from the other.
      await writeFile(path.join(request.workspacePath, 'recorded.txt'), 'later work\n', 'utf8');
      await gitOrFail(['add', 'recorded.txt'], request.workspacePath);
      await gitOrFail(['commit', '--quiet', '--message', 'later work'], request.workspacePath);
      recorded = await commitOf(request.workspacePath, 'HEAD');
      await gitOrFail(
        ['checkout', '--quiet', '-b', 'task/side', request.baseCommit],
        request.workspacePath,
      );
      await writeFile(path.join(request.workspacePath, 'side.txt'), 'side work\n', 'utf8');
      await gitOrFail(['add', 'side.txt'], request.workspacePath);
      await gitOrFail(['commit', '--quiet', '--message', 'side work'], request.workspacePath);
      side = await commitOf(request.workspacePath, 'HEAD');
      return { summary: 'diverged from the recorded branch' };
    };

    const result = await runTask(request(fixture, configuration(fixture)), dependencies(agent));

    expect(result.status).toBe('failed');
    expect(starts).toHaveLength(1);
    expect(result.reason).toMatch(/could not be returned to the branch this workspace records/);
    expect(result.reason).toContain('task/side');
    expect(result.reason).toContain('not an ancestor');
    expect(result.reason).toContain(side);
    expect(result.reason).toContain(recorded);
    expect(result.reason).toMatch(/reconcile the two by hand/);

    // No check ran after the turn, and both branches are exactly where the turn
    // left them: nothing was reset or force-updated.
    const report = await readReport(result.reportPath);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.checks).toBeNull();
    const workspacePath = result.workspace?.workspacePath ?? '';
    expect(await branchOf(workspacePath)).toBe('task/side');
    expect(await commitOf(workspacePath, 'refs/heads/task/side')).toBe(side);
    expect(await commitOf(workspacePath, `refs/heads/${result.workspace?.branch ?? ''}`)).toBe(
      recorded,
    );
    expect(eventOrder(await recordedEvents(fixture))).toEqual([
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
    ]);
  });

  it('stops before the checks when the return would write over an ignored local file', async () => {
    const fixture = await createFixture([
      { file: 'settings.json', text: 'the committed settings\n' },
    ]);
    const starts: string[] = [];
    const agent: RunnerDependencies['runAgentTurn'] = async (request) => {
      starts.push(await branchOf(request.workspacePath));
      // The turn stops tracking the settings file, ignores it, and regenerates a
      // copy locally: the recorded branch still tracks it, so returning the
      // checkout to that branch would write the committed copy over the local
      // one and the fast-forward would then delete it. The harness refuses
      // instead of destroying it, before any check reads the working copy.
      await gitOrFail(['checkout', '--quiet', '-b', 'task/side'], request.workspacePath);
      await gitOrFail(['rm', '--quiet', '--cached', 'settings.json'], request.workspacePath);
      await writeFile(path.join(request.workspacePath, '.gitignore'), 'settings.json\n', 'utf8');
      await gitOrFail(['add', '.gitignore'], request.workspacePath);
      await gitOrFail(
        ['commit', '--quiet', '--message', 'stop tracking the settings'],
        request.workspacePath,
      );
      await writeFile(
        path.join(request.workspacePath, 'settings.json'),
        'regenerated locally\n',
        'utf8',
      );
      return { summary: 'left an ignored local file under a path the recorded branch tracks' };
    };

    const result = await runTask(request(fixture, configuration(fixture)), dependencies(agent));

    expect(result.status).toBe('failed');
    // The turn started on the branch the workspace records, and no further one
    // was started from the state the return refused to move.
    expect(starts).toEqual([result.workspace?.branch]);
    expect(result.reason).toMatch(/could not be returned to the branch this workspace records/);
    expect(result.reason).toContain('task/side');
    expect(result.reason).toContain(`"${result.workspace?.branch ?? ''}"`);
    expect(result.reason).toContain('settings.json');
    expect(result.reason).toMatch(/nothing local was written over/);

    // No check ran after the turn: the fixture processes only ever ran the
    // baseline, and the turn's own record is kept without a round.
    const report = await readReport(result.reportPath);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.checks).toBeNull();
    expect(eventOrder(await recordedEvents(fixture))).toEqual([
      'start setup-1',
      'end setup-1',
      'start check-1',
      'end check-1',
    ]);

    // The local file's bytes are still there, and neither branch moved.
    const workspacePath = result.workspace?.workspacePath ?? '';
    expect(await branchOf(workspacePath)).toBe('task/side');
    expect(await readText(path.join(workspacePath, 'settings.json'))).toBe('regenerated locally\n');
    expect(await commitOf(workspacePath, `refs/heads/${result.workspace?.branch ?? ''}`)).toBe(
      result.workspace?.baseCommit,
    );
  }, 120_000);

  it('stops before the repair turn when the working copy still holds uncommitted work', async () => {
    const fixture = await createFixture();
    // The implementation turn breaks what the check verifies and leaves its work
    // uncommitted, so the round after it is red and the run would repair. It
    // stops there instead: a repair turn is a coding turn, and no coding turn is
    // started from a working copy that still holds uncommitted work (HARN-35).
    const agent = fakeAgent(fixture, {
      mode: 'replace',
      text: 'broken, and never committed\n',
      holdMs: 0,
    });

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/the working copy is not in the state a coding turn starts from/);
    expect(result.reason).toContain(`("${result.workspace?.branch ?? ''}")`);
    expect(result.reason).toContain('with no uncommitted work');
    expect(result.reason).toContain('app.txt');
    expect(result.reason).toMatch(/Commit or remove those paths by hand/);

    // Only the implementation turn ran: the repair turn the red round earned was
    // never started, and no round ran after the refusal.
    expect(agent.requests.map((asked) => asked.kind)).toEqual(['implementation']);
    const report = await readReport(result.reportPath);
    expect(report.status).toBe('failed');
    expect(report.repairsUsed).toBe(0);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.kind).toBe('implementation');
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');

    // What the turn left is kept exactly as it was — nothing was committed,
    // stashed, or discarded, and the checkout never moved — so finishing it by
    // hand is what the message asks for.
    const workspacePath = result.workspace?.workspacePath ?? '';
    expect(await branchOf(workspacePath)).toBe(result.workspace?.branch);
    expect(await readText(path.join(workspacePath, 'app.txt'))).toContain(
      'broken, and never committed',
    );
    expect(
      eventOrder(await recordedEvents(fixture)).filter((event) => event === 'start check-1'),
    ).toHaveLength(2);
    expect(timelineMessages(await readText(report.runLog)).at(-1)).toMatch(
      /^final status: failed, the working copy is not in the state a coding turn starts from/,
    );
  }, 60_000);
});

describe('a continued run whose source checkout moved on', () => {
  it('keeps the recorded base for comparisons, with commits and leftovers both visible', async () => {
    const fixture = await createFixture();
    const firstAgent = fakeAgent(fixture, {
      commits: [
        {
          file: 'committed.txt',
          text: 'attempt one committed this\n',
          message: 'tiny-001: attempt one checkpoint',
        },
      ],
      // Everything the attempt left is committed, because the next run is only
      // started from the workspace's own committed state (HARN-35).
      commit: 'tiny-001: attempt one finishes what it wrote',
    });
    const first = await runTask(
      { ...request(fixture, configuration(fixture)), sourceRef: SOURCE_REF },
      dependencies(firstAgent.turn),
    );
    const workspace = first.workspace;
    expect(workspace).not.toBeNull();
    if (workspace === null) {
      return;
    }

    // The source checkout moves on the ordinary way. The workspace keeps the
    // base it was cloned at, and nothing follows the source forward.
    await writeFile(path.join(fixture.repo, 'later.txt'), 'the source moved on\n', 'utf8');
    await gitOrFail(['add', '--all'], fixture.repo);
    await gitOrFail(['commit', '--quiet', '--message', 'the source moves on'], fixture.repo);
    expect((await gitOrFail(['rev-parse', 'HEAD'], fixture.repo)).trim()).not.toBe(
      workspace.baseCommit,
    );

    const agent = fakeAgent(fixture);
    const second = await runTask(
      {
        ...request(
          fixture,
          configuration(fixture, {
            checks: [command(fixture, 'check-1', 'need', 'app.txt', IMPLEMENTED_TEXT)],
          }),
        ),
        continuedWorkspace: await reopenWorkspace(
          fixture.workDir,
          workspace.workspaceId,
          await expectationFor(fixture, workspace.workspaceId),
        ),
      },
      dependencies(agent.turn),
    );

    expect(second.status).toBe('passed');
    const report = await readReport(second.reportPath);
    // Provenance and comparison both keep the workspace's own recorded base, not
    // the source checkout's newer HEAD.
    expect(report.source.baseCommit).toBe(workspace.baseCommit);
    expect(report.changes.baseCommit).toBe(workspace.baseCommit);
    // The whole diff against that base: an earlier attempt's commit and a dirty
    // leftover are both visible — a path the earlier attempt committed and this
    // attempt added to again holds both states.
    const states = new Map(report.changes.paths.map((entry) => [entry.path, entry.states]));
    expect(states.get('committed.txt')).toEqual(['committed']);
    expect(states.get('app.txt')).toEqual(['committed', 'unstaged']);
  }, 120_000);
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
        { file: 'nexus.project.json', text: workspaceConfig },
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
    expect(await readText(path.join(result.run.workspacePath, 'nexus.project.json'))).toBe(
      workspaceConfig,
    );
    expect(await readText(path.join(result.run.workspacePath, 'task.json'))).toBe(workspaceTask);
  }, 60_000);
});
