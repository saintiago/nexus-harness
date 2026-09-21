/**
 * What a run records, the collaborators it is given, and the history it is handed.
 *
 * The run collaborators a caller may substitute, the report a run writes about the working copy it left, and the ticket conversation snapshot a coding turn is given before it starts.
 */

import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CheckRoundRequest } from '../src/checks/round.js';
import { HistoryError } from '../src/history/contract.js';
import { createTicketHistory } from '../src/history/sync.js';
import type {
  HistoryPrepareRequest,
  HistorySnapshot,
  TicketHistory,
} from '../src/history/contract.js';
import { runTask } from '../src/runs/runner.js';
import type { AgentTurnRequest } from '../src/runs/contracts.js';
import type { CheckRoundResult, HarnessConfig, Task } from '../src/shared/types.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import type { PreflightRequest, SourcePreflight } from '../src/workspace/preflight.js';
import type { RunDirectory } from '../src/workspace/run-directory.js';
import { agentLogPath } from '../src/reporting/logs.js';
import type { RunReportRequest } from '../src/reporting/report.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';
import { createTempDir } from './support.js';
import {
  TASK,
  createFixture,
  command,
  configuration,
  request,
  SOURCE_REF,
  dependencies,
  fakeAgent,
  readReport,
  readText,
  timelineMessages,
  testClock,
  minutes,
  standInCommand,
  passedRound,
  stoppedRound,
  standInRounds,
  beginRunnerFixtureEnvironment,
} from './fixtures/runner.js';

useFixtureLifecycle();

beforeEach(beginRunnerFixtureEnvironment);

describe('the collaborators a run is given', () => {
  it('runs the loaded plan through the functions it was handed', async () => {
    const workDir = path.join(await createTempDir(), 'runs');
    const run: RunDirectory = {
      workDir,
      runId: 'run-0001',
      runDir: path.join(workDir, 'run-0001'),
      workspaceId: 'run-0001',
      workspacePath: path.join(workDir, 'run-0001', 'workspace'),
      logsDir: path.join(workDir, 'run-0001', 'logs'),
    };
    const source: SourcePreflight = {
      sourceRoot: path.join(workDir, 'repo'),
      baseCommit: 'a'.repeat(40),
    };
    const workspace: PreparedWorkspace = {
      ...run,
      workspaceId: run.runId,
      continued: false,
      attempt: 1,
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
      agent: { runtime: 'codex', command: ['codex'] },
    };
    const repoPath = path.join('somewhere', 'repo');
    const clock = new Date('2026-01-01T00:00:00.000Z');

    const preflights: PreflightRequest[] = [];
    const allocations: string[] = [];
    const identities: string[] = [];
    const returned: string[] = [];
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
        configureWorkspaceIdentity: async (workspacePath) => {
          identities.push(workspacePath);
        },
        returnToRecordedBranch: async (workspacePath, branch) => {
          returned.push(`${workspacePath} ${branch}`);
          return { changed: false };
        },
        recordWorkspaceAttempt: async () => undefined,
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

    expect(preflights).toEqual([
      {
        repoPath,
        workDir,
        bounds: { deadlineMs: clock.getTime() + minutes(60), now: expect.any(Function) },
      },
    ]);
    expect(allocations).toEqual([workDir]);
    // The working copy was given its commit identity before the baseline ran.
    expect(identities).toEqual([workspace.workspacePath]);
    // Every turn and every round that judges one is preceded by returning the
    // checkout to the branch the workspace records (HARN-35).
    expect(returned).toEqual([
      `${workspace.workspacePath} ${workspace.branch}`,
      `${workspace.workspacePath} ${workspace.branch}`,
    ]);

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

describe('what a run records about the working copy it left', () => {
  it('lists and flags the changes a coding turn left, against the base it recorded', async () => {
    const fixture = await createFixture();
    const config = configuration(fixture, {
      checks: [command(fixture, 'check-1', 'need', 'app.txt', 'committed baseline')],
    });
    const agent = fakeAgent(fixture, {
      extras: [{ file: 'app.test.ts', text: 'export const test = 1;\n' }],
    });

    const result = await runTask(request(fixture, config), dependencies(agent.turn));

    expect(result.status).toBe('passed');

    const report = await readReport(result.reportPath);
    // Every path is a difference from the base the run recorded, and what the
    // turn left uncommitted is in the list: a run is judged on what it left
    // behind, not on what it happened to commit.
    expect(report.changes.baseCommit).toBe(report.source.baseCommit);
    expect(report.changes.inspected).toBe(true);
    expect(report.changes.problem).toBeNull();
    expect(report.changes.paths).toEqual([
      { path: 'app.test.ts', kind: 'added', states: ['untracked'], categories: ['tests'] },
      { path: 'app.txt', kind: 'modified', states: ['unstaged'], categories: [] },
    ]);
    // The new test file is the one a reviewer has to look at first; the ordinary
    // edit is listed without being flagged.
    expect(report.changes.highlighted.map((entry) => entry.path)).toEqual(['app.test.ts']);

    // The caller is handed the same summary, and the timeline records it before
    // the status the run ends with.
    expect(result.changes).toEqual(report.changes);
    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline).toContain(
      `changes: 2 paths differ from the recorded base ${report.source.baseCommit}`,
    );
    expect(timeline).toContain(
      'changed path: app.test.ts (added, untracked) - tests: review this change',
    );
    expect(timeline).toContain('changed path: app.txt (modified, unstaged)');
    expect(timeline).toContain(`review warning: ${report.changes.warnings.checks}`);
    expect(timeline).toContain(`review warning: ${report.changes.warnings.highlighted}`);
    expect(timeline.at(-1)).toMatch(/^final status: passed, /);
  }, 60_000);

  it('says why there is no summary when a stop could not be confirmed', async () => {
    const fixture = await createFixture();
    const clock = testClock();
    const config = configuration(fixture, { maxRepairs: 2 });
    const agent = fakeAgent(fixture);
    const reason = 'the invocation was still running 5000 ms after it was stopped';
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
                terminationProblem: reason,
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
    // The turn's edit is really there, and the working copy may still be written
    // to by something the harness could not stop: so nothing is compared, and the
    // reason is recorded instead of an empty list that would read as "no changes".
    expect(existsSync(path.join(result.run.workspacePath, 'app.txt'))).toBe(true);
    expect(result.changes.inspected).toBe(false);
    expect(result.changes.problem).toBe(
      'the run ended without confirming that everything it had started had stopped ' +
        `(${reason}), so the working copy may still be written to and is not a final record of ` +
        'what this run left behind',
    );
    expect(result.changes.paths).toEqual([]);
    expect(result.changes.highlighted).toEqual([]);
    // What the status means is still stated; only the comparison is missing.
    expect(result.changes.warnings.checks).toContain(
      '`passed` means the configured post-agent checks',
    );

    const report = await readReport(result.reportPath);
    expect(report.timeout?.termination).toBe('unconfirmed');
    expect(report.changes).toEqual(result.changes);

    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline).toContain(`changes: unavailable, ${result.changes.problem}`);
    expect(timeline.some((message) => message.startsWith('changed path:'))).toBe(false);
    expect(timeline.join('\n')).not.toContain('the working copy matches the recorded base');
    expect(timeline.at(-1)).toMatch(/^final status: failed, /);
  }, 60_000);

  it('records a diagnostic when the final comparison cannot be made', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(fixture);

    const result = await runTask(
      request(fixture, configuration(fixture)),
      dependencies(agent.turn, {
        // The working copy loses its repository once the round that decides the
        // run has passed: the comparison cannot be made, and the run records
        // that as a diagnostic rather than waiting for an answer or claiming no
        // changes. (The checkout is returned to its recorded branch before that
        // round, so the run reaches it and is decided by its checks.)
        runCheckRound: async (asked) => {
          if (asked.name !== 'baseline') {
            await rm(path.join(asked.cwd, '.git'), { recursive: true, force: true });
          }
          return { outcome: 'passed', setup: [], checks: [], problem: null };
        },
      }),
    );

    // The run itself is decided by its checks, which passed; the comparison is
    // what could not be made, and the report says so.
    expect(result.status).toBe('passed');
    expect(result.changes.inspected).toBe(false);
    expect(result.changes.problem).toMatch(/could not be compared with its recorded base/);
    expect(result.changes.paths).toEqual([]);

    const report = await readReport(result.reportPath);
    expect(report.changes).toEqual(result.changes);
    const timeline = timelineMessages(await readText(report.runLog));
    expect(timeline).toContain(`changes: unavailable, ${result.changes.problem}`);
    expect(timeline.join('\n')).not.toContain('the working copy matches the recorded base');
    expect(timeline.at(-1)).toMatch(/^final status: passed, /);
  }, 60_000);
});

describe('the ticket conversation history before a coding turn', () => {
  it('retains the full previous turn report before a repair and advances only consumed input', async () => {
    const fixture = await createFixture();
    const config = configuration(fixture, {
      maxRepairs: 1,
      checks: [command(fixture, 'check-1', 'need', 'app.txt', 'committed baseline')],
    });
    const summary = 'Implementation report\n' + 'Full details\n'.repeat(1_000);
    const agent = fakeAgent(
      fixture,
      { mode: 'replace', text: 'broken', summary, commit: 'implementation', holdMs: 0 },
      {
        2: {
          text: 'committed baseline\nrepaired',
          summary: 'Repaired the check.',
          commit: 'repair',
        },
      },
    );
    const history = createTicketHistory({
      workDir: fixture.workDir,
      readers: {
        jiraThread: async () => ({ comments: [], truncated: false }),
        pullRequestConversation: async () => null,
      },
    });
    const result = await runTask(
      { ...request(fixture, config), sourceRef: SOURCE_REF, history },
      dependencies(agent.turn),
    );
    expect(result.status).toBe('passed');
    expect(agent.requests).toHaveLength(2);
    const repair = agent.requests[1]?.history;
    expect(repair?.entries.find((entry) => entry.kind === 'developer-report')?.text).toContain(
      summary.trim(),
    );
    expect(repair?.reports[0]?.status).toBe('in-progress');
    const consumed = JSON.parse(
      await readFile(path.join(repair?.root ?? '', 'consumed-developer.json'), 'utf8'),
    ) as { snapshotId: string };
    expect(consumed.snapshotId).toBe(repair?.id);
    expect(existsSync(path.join(repair?.root ?? '', 'consumed-reviewer.json'))).toBe(false);
    expect(await readFile(repair?.entriesPath ?? '', 'utf8')).not.toContain('Repaired the check.');
  }, 60_000);

  /** One prepared snapshot, as the runner hands it to a turn. */
  const SNAPSHOT: HistorySnapshot = {
    version: 1,
    id: 'snapshot-1',
    role: 'developer',
    round: 1,
    takenAt: '2026-09-21T10:00:00.000Z',
    root: '/history',
    dir: '/history/snapshots/snapshot-1',
    indexPath: '/history/snapshots/snapshot-1/index.md',
    indexJsonPath: '/history/snapshots/snapshot-1/index.json',
    entriesPath: '/history/snapshots/snapshot-1/entries.jsonl',
    reportsDir: '/history/reports',
    brief: {
      ref: SOURCE_REF,
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

  it('prepares one snapshot before the turn and hands the turn its local paths', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(fixture, {
      file: 'app.txt',
      text: '\nnew line.',
      mode: 'append',
      commit: 'work',
    });
    const prepared: HistoryPrepareRequest[] = [];
    const history: TicketHistory = {
      prepare: async (asked) => {
        prepared.push(asked);
        return SNAPSHOT;
      },
    };

    const result = await runTask(
      { ...request(fixture, configuration(fixture)), sourceRef: SOURCE_REF, history },
      dependencies(agent.turn),
    );

    expect(result.status).toBe('passed');
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      role: 'developer',
      round: 1,
      ref: { id: SOURCE_REF.id },
      workspace: { workspaceId: result.workspace?.workspaceId },
    });
    expect(agent.requests[0]?.history).toBe(SNAPSHOT);
  }, 60_000);

  it('starts no coding turn when the snapshot cannot be prepared', async () => {
    const fixture = await createFixture();
    const agent = fakeAgent(fixture, {
      file: 'app.txt',
      text: 'changed',
      mode: 'replace',
      commit: 'work',
    });
    const history: TicketHistory = {
      prepare: async () => {
        throw new HistoryError(
          'essential',
          'the history directory could not be written beside the workspace',
        );
      },
    };

    const result = await runTask(
      { ...request(fixture, configuration(fixture)), sourceRef: SOURCE_REF, history },
      dependencies(agent.turn),
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('local conversation history could not be prepared');
    expect(result.reason).toContain('the history directory could not be written');
    expect(result.attempts).toHaveLength(0);
    expect(agent.requests).toHaveLength(0);
    // The run is still kept: its report says why the turn was not started.
    const report = await readReport(result.reportPath);
    expect(report.reason).toContain('local conversation history could not be prepared');
  }, 60_000);
});
