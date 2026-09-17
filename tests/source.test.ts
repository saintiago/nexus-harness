/**
 * Task-source intake: one serial coordinator, its lock and receipts, and the
 * three CLI commands around it.
 *
 * The coordinator tests drive it with a fake source, a fake runner, real
 * temporary directories, and a controllable clock, so ordering, duplicate
 * prevention, refusal, and cancellation are asserted from what really happened:
 * which calls arrived in which order, which files exist afterwards, and what a
 * second scan of the same queue does.
 *
 * The last block is the whole path through the CLI: a disposable Git repository,
 * the real runner with a real clone and real commands, the real Jira connector —
 * and a fake HTTP boundary that speaks Jira REST API v3. Nothing there contacts a
 * network, and the only stand-in inside the harness is the coding turn.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK, runCli } from '../src/cli.js';
import type { CliContext, InterruptSignals } from '../src/cli.js';
import { ReportError, summarizeChanges } from '../src/report.js';
import type { RunTaskResult } from '../src/runner.js';
import { RunCancelledError } from '../src/runner.js';
import {
  SourceError,
  SourceFeedbackError,
  acquireIntakeLock,
  intakeLockPath,
  listSource,
  readReceipt,
  receiptFilePath,
  reserveReceipt,
  runSource,
  watchSource,
} from '../src/source.js';
import type {
  SourceCandidate,
  SourceContext,
  SourceRunOutcome,
  SourceTask,
  TaskSource,
} from '../src/source.js';
import {
  allocateRunDirectory,
  prepareWorkspace,
  preflightSource,
  workspaceStatePath,
} from '../src/workspace.js';
import type { RunDirectory } from '../src/workspace.js';
import type {
  AttemptEvidence,
  AttemptKind,
  CheckRoundResult,
  CommandOutcome,
  CommandResult,
  RoundOutcome,
  RunStatus,
  SourceRef,
  Task,
} from '../src/types.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedConfig,
  writeJsonFile,
} from './support.js';

afterEach(cleanupTempDirectories);

const SCOPE = 'https://example.atlassian.net';

function refFor(id: string, key = `SAM1-${id}`, updatedAt = '2026-09-16T11:00:00.000Z'): SourceRef {
  return {
    type: 'jira',
    scope: SCOPE,
    id,
    key,
    url: `${SCOPE}/browse/${key}`,
    updatedAt,
  };
}

function candidateFor(
  id: string,
  key = `SAM1-${id}`,
  pointers: readonly string[] = [],
): SourceCandidate {
  return { ref: refFor(id, key), title: `Task ${key}`, pointers };
}

function taskFor(candidate: SourceCandidate): Task {
  return {
    id: candidate.ref.key,
    title: `Task ${candidate.ref.key}`,
    description: '## Acceptance criteria\n- It works.',
    acceptanceCriteria: ['It works.'],
  };
}

function runDirectoryAt(runDir: string): RunDirectory {
  return {
    workDir: path.dirname(path.dirname(runDir)),
    runId: path.basename(runDir),
    runDir,
    // The real layout keeps a workspace beside its run's evidence; a fake run
    // directory keeps the same relationship for the code that reads it.
    workspacePath: path.join(path.dirname(runDir), 'workspaces', path.basename(runDir)),
    logsDir: path.join(runDir, 'logs'),
  };
}

/** One command result, as far as the checks line reads it. */
function commandFor(outcome: CommandOutcome, exitCode: number | null): CommandResult {
  return {
    command: ['npm', 'run', 'validate'],
    cwd: '/repo',
    startedAt: '2026-09-16T22:00:00.000Z',
    endedAt: '2026-09-16T22:01:00.000Z',
    outcome,
    exitCode,
    signal: null,
    launchError: null,
    timeoutMs: 600_000,
    termination: null,
    terminationProblem: null,
    stdoutPath: '/repo/logs/check.stdout.log',
    stderrPath: '/repo/logs/check.stderr.log',
  };
}

/** One completed round with a single check, as the checks line reads it. */
function roundFor(outcome: RoundOutcome, exitCode: number | null): CheckRoundResult {
  return { outcome, setup: [], checks: [commandFor('exited', exitCode)], problem: null };
}

/** One coding turn's evidence, as the runner records it. */
function attemptFor(
  turn: number,
  kind: AttemptKind,
  checks: CheckRoundResult | null,
): AttemptEvidence {
  return {
    turn,
    kind,
    agentLog: `/repo/logs/agent-${String(turn)}.log`,
    agentSummary: null,
    checks,
  };
}

/** A run result as the runner returns one, without running anything. */
function resultFor(
  runDir: string,
  status: RunStatus,
  reason = `the run ended ${status}`,
  cancellation: { termination: 'confirmed' | 'unconfirmed'; problem: string | null } | null = null,
): RunTaskResult {
  return {
    run: runDirectoryAt(runDir),
    workspace: null,
    status,
    reason,
    baseline: null,
    attempts: [],
    repairsUsed: status === 'failed' ? 2 : 0,
    timeout: null,
    cancellation:
      status === 'cancelled'
        ? {
            phase: 'the implementation turn',
            elapsedMs: 1000,
            termination: cancellation?.termination ?? 'confirmed',
            problem: cancellation?.problem ?? null,
          }
        : null,
    changes: summarizeChanges({ baseCommit: 'base', paths: [] }),
    reportPath: path.join(runDir, 'result.json'),
  };
}

// ---------------------------------------------------------------------------
// A fixture around the real coordinator
// ---------------------------------------------------------------------------

interface FixtureOptions {
  readonly workDir: string;
  /** What each scan returns; the last entry is reused once the list runs out. */
  readonly scans?: ReadonlyArray<readonly SourceCandidate[] | Error>;
  readonly prepare?: (
    candidate: SourceCandidate,
    call: number,
  ) => Promise<SourceTask | null> | SourceTask | null;
  readonly claim?: (item: SourceTask, call: number) => Promise<boolean> | boolean;
  readonly complete?: (
    item: SourceTask,
    outcome: SourceRunOutcome,
    call: number,
  ) => Promise<void> | void;
  readonly run?: (task: Task, call: number, runDir: string) => Promise<RunTaskResult>;
  readonly recordWorkspace?: (item: SourceTask, workspaceId: string) => Promise<void> | void;
  readonly refuse?: (item: SourceTask, reason: string) => Promise<void> | void;
  readonly preflight?: (call: number) => Promise<{ sourceRoot: string; baseCommit: string }>;
  readonly sleep?: (ms: number, stop: AbortSignal) => Promise<void>;
}

interface Fixture {
  readonly context: SourceContext;
  readonly log: string[];
  readonly completions: Array<{ key: string; outcome: SourceRunOutcome }>;
  readonly refusals: Array<{ key: string; reason: string }>;
  readonly requests: Array<{
    readonly task: Task;
    readonly continuedWorkspace?: { readonly workspaceId: string; readonly attempt: number };
    readonly continued: boolean;
  }>;
  readonly output: string[];
  readonly errors: string[];
  readonly stop: AbortController;
  readonly scans: number;
}

/** The coordinator, wired to fakes that record exactly what happened. */
function createFixture(options: FixtureOptions): Fixture {
  const log: string[] = [];
  const completions: Fixture['completions'] = [];
  const refusals: Fixture['refusals'] = [];
  const requests: Fixture['requests'] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const stop = new AbortController();
  const scans = options.scans ?? [[candidateFor('1')]];
  let scanIndex = 0;
  let scanCount = 0;
  let prepareCount = 0;
  let claimCount = 0;
  let completeCount = 0;
  let runCount = 0;
  let preflightCount = 0;

  const source: TaskSource = {
    listEligible: async () => {
      log.push('list');
      scanCount += 1;
      const entry = scans[Math.min(scanIndex, scans.length - 1)] ?? [];
      scanIndex += 1;
      if (entry instanceof Error) {
        throw entry;
      }
      return entry;
    },
    prepare: async (candidate) => {
      prepareCount += 1;
      log.push(`prepare:${candidate.ref.key}`);
      const prepared = options.prepare?.(candidate, prepareCount);
      return prepared === undefined ? { ref: candidate.ref, task: taskFor(candidate) } : prepared;
    },
    claim: async (item) => {
      claimCount += 1;
      log.push(`claim:${item.ref.key}`);
      return options.claim?.(item, claimCount) ?? true;
    },
    complete: async (item, outcome) => {
      completeCount += 1;
      log.push(`complete:${item.ref.key}:${outcome.status}`);
      completions.push({ key: item.ref.key, outcome });
      await options.complete?.(item, outcome, completeCount);
    },
    recordWorkspace: async (item, workspaceId) => {
      log.push(`workspace:${item.ref.key}:${workspaceId}`);
      await options.recordWorkspace?.(item, workspaceId);
    },
    refuse: async (item, reason) => {
      log.push(`refuse:${item.ref.key}`);
      refusals.push({ key: item.ref.key, reason });
      await options.refuse?.(item, reason);
    },
  };

  const context: SourceContext = {
    source,
    workDir: options.workDir,
    repoPath: '/repo',
    io: { out: (text) => output.push(text), err: (text) => errors.push(text) },
    stop: stop.signal,
    preflight: async () => {
      preflightCount += 1;
      log.push(`preflight:${String(preflightCount)}`);
      return options.preflight?.(preflightCount) ?? { sourceRoot: '/repo', baseCommit: 'base' };
    },
    run: async (asked) => {
      runCount += 1;
      const runDir = path.join(options.workDir, `run-${String(runCount)}`);
      log.push(`run:${asked.task.id}`);
      requests.push({
        task: asked.task,
        continuedWorkspace: asked.continuedWorkspace,
        continued: asked.continuedWorkspace !== undefined,
      });
      // The production runner records where a fresh workspace lives before any
      // paid work; a fake that skipped it would hide the coordinator's own half
      // of that contract.
      if (asked.continuedWorkspace === undefined) {
        await asked.onWorkspaceReady?.({ workspaceId: path.basename(runDir) });
      }
      return options.run?.(asked.task, runCount, runDir) ?? resultFor(runDir, 'passed');
    },
    now: () => new Date('2026-09-16T12:00:00.000Z'),
    sleep:
      options.sleep ??
      ((ms) => {
        log.push(`sleep:${String(ms)}`);
        return Promise.resolve();
      }),
  };

  return {
    context,
    log,
    completions,
    refusals,
    requests,
    output,
    errors,
    stop,
    get scans() {
      return scanCount;
    },
  };
}

// ---------------------------------------------------------------------------
// One finite batch
// ---------------------------------------------------------------------------

describe('a finite source run', () => {
  it('discovers the whole batch before it claims anything, and runs in order', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2'), candidateFor('3')]],
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('completed');
    expect(summary.attempted).toBe(3);
    expect(summary.passed).toBe(3);
    expect(fixture.log).toEqual([
      'preflight:1',
      'list',
      'preflight:2',
      'prepare:SAM1-1',
      'claim:SAM1-1',
      'run:SAM1-1',
      'workspace:SAM1-1:run-1',
      'complete:SAM1-1:passed',
      'preflight:3',
      'prepare:SAM1-2',
      'claim:SAM1-2',
      'run:SAM1-2',
      'workspace:SAM1-2:run-2',
      'complete:SAM1-2:passed',
      'preflight:4',
      'prepare:SAM1-3',
      'claim:SAM1-3',
      'run:SAM1-3',
      'workspace:SAM1-3:run-3',
      'complete:SAM1-3:passed',
    ]);
  });

  it('bounds fresh attempts with --limit and leaves the rest for later', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2'), candidateFor('3')]],
    });

    const first = await runSource(fixture.context, 1);
    expect(first.attempted).toBe(1);
    expect(fixture.log.filter((entry) => entry.startsWith('run:'))).toEqual(['run:SAM1-1']);

    const second = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2'), candidateFor('3')]],
    });
    const again = await runSource(second.context, 1);

    // The receipted issue is skipped without counting against the limit; the
    // next unattempted issue is the one that runs.
    expect(again.attempted).toBe(1);
    // An attempted issue with nothing pointing at a workspace to continue is
    // refused and told so, rather than skipped in silence
    // (docs/implement-workspace-continuation.md).
    expect(again.refused).toBe(1);
    expect(again.skipped).toBe(0);
    expect(second.log.filter((entry) => entry.startsWith('run:'))).toEqual(['run:SAM1-2']);
  });

  it('skips an invalid description without a receipt, and keeps going', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2')]],
      prepare: (candidate) => {
        if (candidate.ref.id === '1') {
          throw new SourceError('invalid-task', 'SAM1-1: the description has no criteria heading');
        }
        return { ref: candidate.ref, task: taskFor(candidate) };
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', invalid: 1, attempted: 1, passed: 1 });
    expect(fixture.errors.join('\n')).toContain('not a usable task');
    expect(fixture.log).toContain('run:SAM1-2');
    expect(existsSync(receiptFilePath(workDir, refFor('1')))).toBe(false);
    expect(existsSync(receiptFilePath(workDir, refFor('2')))).toBe(true);
  });

  it('skips an issue that is no longer eligible, before any reservation', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1')]],
      prepare: () => null,
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, skipped: 1 });
    expect(fixture.log.some((entry) => entry.startsWith('claim:'))).toBe(false);
    expect(existsSync(receiptFilePath(workDir, refFor('1')))).toBe(false);
  });

  it('releases only its own new receipt when a claim was rejected before any mutation', async () => {
    const workDir = await createTempDir();
    const file = receiptFilePath(workDir, refFor('1'));
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2')]],
      claim: (item) => (item.ref.id === '1' ? false : true),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 2, skipped: 1, passed: 1 });
    expect(existsSync(file)).toBe(false);
    expect(fixture.log).toContain('run:SAM1-2');
  });

  it('continues after an ordinary failed run and reports it as a failure', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2')]],
      run: (_task, call, runDir) =>
        Promise.resolve(
          call === 1 ? resultFor(runDir, 'failed', 'checks were red') : resultFor(runDir, 'passed'),
        ),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 2, failed: 1, passed: 1 });
    expect(fixture.log).toContain('run:SAM1-2');
    // Both results were published; a failed run is not a failed delivery.
    expect(fixture.completions.map((entry) => entry.outcome.status)).toEqual(['failed', 'passed']);
  });

  it('keeps the receipt and stops intake when a claim is uncertain', async () => {
    const workDir = await createTempDir();
    const file = receiptFilePath(workDir, refFor('1'));
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2')]],
      claim: () => {
        throw new SourceError('uncertain-write', 'the transition request did not answer');
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('claim did not complete');
    expect(fixture.log.some((entry) => entry.startsWith('run:'))).toBe(false);
    const receipt = await readReceipt(file);
    expect(receipt?.runId).toBeUndefined();
    expect(receipt?.problem).toContain('the transition request did not answer');
  });

  it('keeps the reservation when the run produced no local result', async () => {
    const workDir = await createTempDir();
    const file = receiptFilePath(workDir, refFor('1'));
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2')]],
      run: () => Promise.reject(new ReportError('the report could not be written')),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('produced no local result');
    expect(fixture.completions).toEqual([]);
    const receipt = await readReceipt(file);
    expect(receipt?.problem).toContain('could not be written');
    expect(existsSync(intakeLockPath(workDir))).toBe(false);
  });

  it('stops after a failed publication, keeping the local result and the receipt', async () => {
    const workDir = await createTempDir();
    const file = receiptFilePath(workDir, refFor('1'));
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2')]],
      complete: () => {
        throw new SourceFeedbackError('transition', 'the transition failed', '9001');
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('publishing its result failed');
    expect(fixture.log).not.toContain('run:SAM1-2');
    const receipt = await readReceipt(file);
    expect(receipt?.outcome).toBe('passed');
    expect(receipt?.feedback).toBe('failed');
    expect(receipt?.commentId).toBe('9001');
  });

  it('publishes a stopped run once, with a deadline of its own', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2')]],
      run: (_task, _call, runDir) => {
        // The interrupt arrives while this run is in progress, which is what the
        // runner reports back as a cancelled run.
        fixture.stop.abort(new Error('interrupt'));
        return Promise.resolve(resultFor(runDir, 'cancelled', 'stopped'));
      },
      complete: (item, outcome) => {
        expect(outcome.status).toBe('cancelled');
        expect(fixture.context.stop.aborted).toBe(true);
        void item;
      },
    });
    // The run's own stop signal is what the runner sees; the feedback sequence
    // must not be handed the already-aborted intake signal, or it would fail
    // instantly.
    const feedbackSignals: Array<AbortSignal | undefined> = [];
    const originalComplete = fixture.context.source.complete;
    fixture.context.source.complete = async (item, outcome, signal) => {
      feedbackSignals.push(signal);
      await originalComplete(item, outcome, signal);
    };

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('cancelled');
    expect(summary.cancelled).toBe(1);
    expect(fixture.completions).toHaveLength(1);
    expect(feedbackSignals[0]?.aborted).toBe(false);
    expect(fixture.log).not.toContain('run:SAM1-2');
  });

  it('describes the last round that ran, not the baseline, when the final turn was stopped', async () => {
    // A live run over HARN-1 (run-20260916225121-f3d4a6e4) had its repair turn cut
    // off by the task deadline, and its published feedback reported the round the
    // run had started with: the stopped turn carried no checks, and the line fell
    // back to the baseline. A reader of a failed run needs the opposite.
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1')]],
      run: (_task, _call, runDir) =>
        Promise.resolve({
          ...resultFor(
            runDir,
            'failed',
            "repair turn 2 was stopped when the run's remaining task time ran out",
          ),
          baseline: roundFor('passed', 0),
          attempts: [
            attemptFor(1, 'implementation', roundFor('failed', 1)),
            attemptFor(2, 'repair', null),
          ],
          repairsUsed: 1,
          timeout: {
            limit: 'task',
            phase: 'repair turn 2',
            limitMs: 3_600_000,
            elapsedMs: 3_600_113,
            termination: 'confirmed',
            problem: null,
          },
        }),
    });

    await runSource(fixture.context, null);

    expect(fixture.completions).toHaveLength(1);
    expect(fixture.completions[0]?.outcome.checks).toBe(
      '0 of 1 configured checks exited 0 (round: failed); no check round was observed after repair turn 2',
    );
  });

  it('posts nothing when a stopped run could not confirm its own termination', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1')]],
      run: (_task, _call, runDir) => {
        fixture.stop.abort(new Error('interrupt'));
        return Promise.resolve(
          resultFor(runDir, 'cancelled', 'stopped without confirmation', {
            termination: 'unconfirmed',
            problem: 'the command had not ended 5000 ms after it was stopped',
          }),
        );
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('cancelled');
    expect(summary.cleanupConfirmed).toBe(false);
    expect(fixture.completions).toEqual([]);
    // The lock is left behind deliberately: something may still be writing.
    expect(existsSync(intakeLockPath(workDir))).toBe(true);
    const receipt = await readReceipt(receiptFilePath(workDir, refFor('1')));
    expect(receipt?.problem).toContain('termination was not confirmed');
  });

  it('stops intake when a failed run could not confirm its own termination', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2')]],
      run: (_task, _call, runDir) =>
        Promise.resolve({
          ...resultFor(runDir, 'failed', 'a command ran out of time'),
          timeout: {
            limit: 'command',
            phase: 'the checks after the implementation turn',
            limitMs: 600_000,
            elapsedMs: 600_000,
            termination: 'unconfirmed',
            problem: 'the command had not ended 5000 ms after it was stopped',
          },
        }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.cleanupConfirmed).toBe(false);
    expect(fixture.completions).toEqual([]);
    expect(fixture.log).not.toContain('run:SAM1-2');
    expect(existsSync(intakeLockPath(workDir))).toBe(true);
  });

  it('stops a fresh attempt when the caller stopped intake', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({ workDir, scans: [[candidateFor('1')]] });
    fixture.stop.abort(new Error('interrupt'));

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'cancelled', attempted: 0 });
    expect(fixture.log.some((entry) => entry.startsWith('prepare:'))).toBe(false);
  });

  it('treats a run cancelled before it started as a stop, not as a failure', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1')]],
      run: () => Promise.reject(new RunCancelledError('stopped before any run directory existed')),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('cancelled');
    expect(summary.cleanupConfirmed).toBe(true);
    expect(fixture.completions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Duplicate prevention and the retained state
// ---------------------------------------------------------------------------

describe('the local receipt', () => {
  it('identifies an issue by type, site, and immutable ID only', () => {
    const identity = receiptFilePath('/work', refFor('10011', 'SAM1-11'));
    const renamed = receiptFilePath(
      '/work',
      refFor('10011', 'SAM1-99', '2030-01-01T00:00:00.000Z'),
    );
    const otherSite = receiptFilePath('/work', {
      ...refFor('10011'),
      scope: 'https://other.atlassian.net',
    });
    const otherId = receiptFilePath('/work', refFor('10012'));

    expect(renamed).toBe(identity);
    expect(otherSite).not.toBe(identity);
    expect(otherId).not.toBe(identity);
    expect(path.basename(identity)).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('prevents a second run of the same issue, across a restart', async () => {
    const workDir = await createTempDir();
    const first = createFixture({ workDir, scans: [[candidateFor('1')]] });
    await runSource(first.context, null);

    const second = createFixture({ workDir, scans: [[candidateFor('1')]] });
    const summary = await runSource(second.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    expect(second.log).not.toContain('run:SAM1-1');
    expect(second.errors.join('\n')).toContain('already attempted');
    expect(second.refusals[0]?.reason).toContain('already attempted');
  });

  it('does not make a merely edited or reopened issue runnable again', async () => {
    const workDir = await createTempDir();
    const first = createFixture({ workDir, scans: [[candidateFor('1')]] });
    await runSource(first.context, null);

    const edited: SourceCandidate = {
      ref: refFor('1', 'SAM1-1', '2030-01-01T00:00:00.000Z'),
      title: 'A completely different issue body',
      pointers: [],
    };
    const second = createFixture({ workDir, scans: [[edited]] });
    const summary = await runSource(second.context, null);

    expect(summary.attempted).toBe(0);
    expect(summary.refused).toBe(1);
    // It is re-read to say why, and then left alone: no claim, no run, and no
    // receipt of its own.
    expect(second.log).toContain('prepare:SAM1-1');
    expect(second.log).not.toContain('claim:SAM1-1');
    expect(second.log).not.toContain('run:SAM1-1');
  });

  it('fails closed on a receipt it cannot trust', async () => {
    const workDir = await createTempDir();
    const file = receiptFilePath(workDir, refFor('1'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json', 'utf8');
    const fixture = createFixture({ workDir, scans: [[candidateFor('1')]] });

    let thrown: unknown;
    try {
      await runSource(fixture.context, null);
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(SourceError);
    expect((thrown as SourceError).message).toContain(file);
    expect(fixture.log.some((entry) => entry.startsWith('claim:'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The consumer lock
// ---------------------------------------------------------------------------

describe('the intake lock', () => {
  it('refuses a second consumer of the same output directory', async () => {
    const workDir = await createTempDir();
    const held = await acquireIntakeLock(workDir, () => new Date());
    const fixture = createFixture({ workDir, scans: [[candidateFor('1')]] });

    let thrown: unknown;
    try {
      await runSource(fixture.context, null);
    } catch (cause) {
      thrown = cause;
    }
    await held.release();

    expect(thrown).toBeInstanceOf(SourceError);
    expect((thrown as SourceError).message).toContain('another intake consumer holds');
    expect(fixture.log.some((entry) => entry.startsWith('list'))).toBe(false);
  });

  it('never removes a lock it does not own', async () => {
    const workDir = await createTempDir();
    const dir = intakeLockPath(workDir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'owner.json'),
      `${JSON.stringify({ version: 1, pid: 999999, startedAt: '2026-01-01T00:00:00.000Z', token: 'someone-else' })}\n`,
      'utf8',
    );

    let thrown: unknown;
    try {
      await acquireIntakeLock(workDir, () => new Date());
    } catch (cause) {
      thrown = cause;
    }

    expect((thrown as SourceError).message).toContain('another intake consumer holds');
    expect(existsSync(path.join(dir, 'owner.json'))).toBe(true);
  });

  it('refuses to release a lock that is no longer its own', async () => {
    const workDir = await createTempDir();
    const lock = await acquireIntakeLock(workDir, () => new Date());
    await writeFile(
      path.join(lock.dir, 'owner.json'),
      `${JSON.stringify({ version: 1, token: 'someone-else' })}\n`,
      'utf8',
    );

    await expect(lock.release()).rejects.toThrow(/no longer this process's lock/);
    expect(existsSync(lock.dir)).toBe(true);
  });

  it('refuses the source before any intake state exists', async () => {
    const parent = await createTempDir();
    const workDir = path.join(parent, 'runs');
    const fixture = createFixture({
      workDir,
      preflight: () => Promise.reject(new Error('the source checkout is not clean')),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('source checkout was refused');
    expect(existsSync(workDir)).toBe(false);
    expect(fixture.log).toEqual(['preflight:1']);
  });
});

// ---------------------------------------------------------------------------
// Continuation
// ---------------------------------------------------------------------------

/** A real workspace on disk, prepared the way a first attempt prepares one. */
async function preparedWorkspaceOnDisk(workDir: string): Promise<{ workspaceId: string }> {
  const repo = await createTempDir();
  const runGit = (...args: readonly string[]): void => {
    const result = spawnSync('git', [...args], {
      cwd: repo,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Source Test',
        GIT_AUTHOR_EMAIL: 'source@example.test',
        GIT_COMMITTER_NAME: 'Source Test',
        GIT_COMMITTER_EMAIL: 'source@example.test',
      },
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed`);
    }
  };
  runGit('init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(repo, 'app.txt'), 'baseline\n', 'utf8');
  runGit('add', '--all');
  runGit('commit', '--quiet', '--message', 'baseline');

  const source = await preflightSource({ repoPath: repo, workDir });
  const prepared = await prepareWorkspace(await allocateRunDirectory(workDir), source, {
    deadlineMs: Date.now() + 60_000,
    now: () => new Date(),
    stop: undefined,
  });
  return { workspaceId: prepared.workspaceId };
}

describe('an issue that points at a workspace', () => {
  it('records a fresh workspace on the issue, and the run is told to do it', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({ workDir, scans: [[candidateFor('1')]] });

    const summary = await runSource(fixture.context, null);

    expect(summary.passed).toBe(1);
    expect(fixture.requests[0]?.continued).toBe(false);
    // The coordinator's half of the contract: a fresh run is handed the hook that
    // records where its workspace lives, and the issue learns the id.
    expect(fixture.log.filter((entry) => entry.startsWith('workspace:'))).toEqual([
      'workspace:SAM1-1:run-1',
    ]);
  });

  it('continues that workspace instead of creating one, and never writes a second pointer', async () => {
    const workDir = await createTempDir();
    const { workspaceId } = await preparedWorkspaceOnDisk(workDir);
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2', [workspaceId])]],
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.attempted).toBe(1);
    expect(summary.passed).toBe(1);
    expect(fixture.requests[0]?.continued).toBe(true);
    expect(fixture.requests[0]?.continuedWorkspace).toMatchObject({ workspaceId, attempt: 1 });
    // A continuation reads the pointer and leaves it alone.
    expect(fixture.log.filter((entry) => entry.startsWith('workspace:'))).toEqual([]);
    // It still has a receipt: this attempt's outcome has to live somewhere.
    const receipt = await readReceipt(receiptFilePath(workDir, refFor('2', 'SAM1-2')));
    expect(receipt?.outcome).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

describe('source list', () => {
  it('shows valid, refused, continuable, invalid, and stale issues without changing anything', async () => {
    const workDir = await createTempDir();
    const attempted = candidateFor('9');
    await reserveReceipt(receiptFilePath(workDir, attempted.ref), {
      version: 1,
      source: attempted.ref,
      reservedAt: '2026-09-16T10:00:00.000Z',
      runId: 'run-20260916100000-aaaaaaaa',
      outcome: 'failed',
      feedback: 'sent',
    });
    // A workspace this machine has, named by an issue's pointer label: what a
    // continuation needs, and what the preview reports as continuable.
    const workspaceId = 'run-20260916100000-bbbbbbbb';
    const continued = candidateFor('4', 'SAM1-4', [workspaceId]);
    await mkdir(path.join(workDir, 'workspaces', workspaceId), { recursive: true });
    await writeFile(
      workspaceStatePath(workDir, workspaceId),
      `${JSON.stringify({
        version: 1,
        workspaceId,
        sourceRoot: '/repo',
        baseCommit: 'base',
        branch: `harness/${workspaceId}`,
        createdAt: '2026-09-16T10:00:00.000Z',
        attempts: [
          {
            runId: workspaceId,
            outcome: 'failed',
            endedAt: '2026-09-16T10:30:00.000Z',
            reportPath: `/runs/${workspaceId}/result.json`,
          },
        ],
      })}\n`,
      'utf8',
    );
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), attempted, continued, candidateFor('2'), candidateFor('3')]],
      prepare: (candidate) => {
        if (candidate.ref.id === '2') {
          throw new SourceError('invalid-task', 'SAM1-2: the description has no criteria heading');
        }
        return candidate.ref.id === '3' ? null : { ref: candidate.ref, task: taskFor(candidate) };
      },
    });
    const receipted = path.join(workDir, '.intake', 'receipts');
    const before = await readdir(receipted);

    const entries = await listSource({
      source: fixture.context.source,
      workDir,
      stop: fixture.context.stop,
    });

    expect(entries.map((entry) => [entry.ref.key, entry.disposition])).toEqual([
      ['SAM1-1', 'valid'],
      ['SAM1-9', 'refused'],
      ['SAM1-4', 'continuable'],
      ['SAM1-2', 'invalid'],
      ['SAM1-3', 'stale'],
    ]);
    expect(entries[1]?.detail).toContain('already attempted');
    expect(entries[2]?.detail).toContain(`continues workspace ${workspaceId}`);
    expect(entries[2]?.detail).toContain('attempt 2');
    expect(entries[3]?.detail).toMatch(/no criteria heading/);

    // A preview claims nothing, runs nothing, and writes nothing.
    expect(fixture.log.filter((entry) => entry !== 'list' && !entry.startsWith('prepare'))).toEqual(
      [],
    );
    expect(await readdir(receipted)).toEqual(before);
  });

  it('creates no output directory when the preview finds none', async () => {
    const parent = await createTempDir();
    const workDir = path.join(parent, 'runs');
    const fixture = createFixture({ workDir, scans: [[]] });

    await expect(
      listSource({ source: fixture.context.source, workDir, stop: fixture.context.stop }),
    ).resolves.toEqual([]);
    expect(existsSync(workDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

/** A sleep the test controls: it resolves only when the test says so. */
function controlledSleep(): {
  sleep: (ms: number, stop: AbortSignal) => Promise<void>;
  waits: Array<{ ms: number; wake: () => void }>;
} {
  const waits: Array<{ ms: number; wake: () => void }> = [];
  return {
    waits,
    sleep: (ms, stop) =>
      new Promise<void>((resolve) => {
        // Like the production wait, a stop that already arrived resolves at
        // once: a test that interrupts between two statements must not hang.
        if (stop.aborted) {
          resolve();
          return;
        }
        const wake = (): void => {
          stop.removeEventListener('abort', wake);
          resolve();
        };
        stop.addEventListener('abort', wake, { once: true });
        waits.push({ ms, wake });
      }),
  };
}

/** Waits, bounded, until the fixture has done what a test is waiting for. */
async function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`this test waited for ${what}, and it never happened`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('source watch', () => {
  it(
    'scans, processes a batch, waits the configured interval, and picks up later work',
    { timeout: 20_000 },
    async () => {
      const workDir = await createTempDir();
      const sleeps = controlledSleep();
      const fixture = createFixture({
        workDir,
        scans: [[], [candidateFor('1')]],
        sleep: sleeps.sleep,
      });

      const watching = watchSource({ ...fixture.context, pollIntervalMs: 30_000 });

      await until(
        () => fixture.log.filter((entry) => entry === 'list').length === 1,
        'the first scan',
      );
      expect(sleeps.waits.map((wait) => wait.ms)).toEqual([30_000]);
      sleeps.waits[0]?.wake();

      await until(() => fixture.log.includes('complete:SAM1-1:passed'), 'the later issue to run');
      // The second scan is followed by another wait, and then the watch is stopped.
      await until(() => sleeps.waits.length === 2, 'the second wait');
      fixture.stop.abort(new Error('stop watching'));

      const summary = await watching;

      expect(summary).toMatchObject({ outcome: 'cancelled', attempted: 1, passed: 1 });
      expect(fixture.log.indexOf('list')).toBeLessThan(fixture.log.indexOf('claim:SAM1-1'));
      expect(fixture.log.filter((entry) => entry === 'list')).toHaveLength(2);
      expect(fixture.output.join('\n')).toContain('no eligible issues');
      expect(existsSync(intakeLockPath(workDir))).toBe(false);
    },
  );

  it(
    'waits out a server-directed delay after a read failure, then keeps going',
    { timeout: 20_000 },
    async () => {
      const workDir = await createTempDir();
      const sleeps = controlledSleep();
      const fixture = createFixture({
        workDir,
        scans: [
          new SourceError('retryable-read', 'the search answered HTTP 429', {
            retryAfterMs: 600_000,
          }),
          [],
        ],
        sleep: sleeps.sleep,
      });

      const watching = watchSource({ ...fixture.context, pollIntervalMs: 30_000 });

      await until(() => sleeps.waits.length === 1, 'the retry wait');
      expect(sleeps.waits[0]?.ms).toBe(600_000);
      expect(fixture.errors.join('\n')).toContain('retrying in 600000 ms');
      sleeps.waits[0]?.wake();

      await until(
        () => fixture.log.filter((entry) => entry === 'list').length === 2,
        'the next scan',
      );
      await until(() => sleeps.waits.length === 2, 'the poll wait');
      expect(sleeps.waits[1]?.ms).toBe(30_000);
      fixture.stop.abort(new Error('stop watching'));

      await expect(watching).resolves.toMatchObject({ outcome: 'cancelled' });
    },
  );

  it(
    'backs off and retries a read failure that happened before any reservation',
    { timeout: 20_000 },
    async () => {
      const workDir = await createTempDir();
      const sleeps = controlledSleep();
      let preparations = 0;
      const fixture = createFixture({
        workDir,
        scans: [[candidateFor('1')]],
        sleep: sleeps.sleep,
        prepare: (candidate) => {
          preparations += 1;
          if (preparations === 1) {
            throw new SourceError('retryable-read', 'the issue read timed out');
          }
          return { ref: candidate.ref, task: taskFor(candidate) };
        },
      });

      const watching = watchSource({ ...fixture.context, pollIntervalMs: 30_000 });
      await until(() => sleeps.waits.length === 1, 'the retry wait');
      expect(sleeps.waits[0]?.ms).toBe(5_000);
      sleeps.waits[0]?.wake();

      await until(() => fixture.log.includes('complete:SAM1-1:passed'), 'the retried issue to run');
      fixture.stop.abort(new Error('stop watching'));

      await expect(watching).resolves.toMatchObject({ outcome: 'cancelled', passed: 1 });
      // No receipt was created for the failed read: it was retried, not reserved.
      const receipt = await readReceipt(receiptFilePath(workDir, refFor('1')));
      expect(receipt?.feedback).toBe('sent');
    },
  );

  it('stops on a fatal failure instead of retrying it', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [new SourceError('fatal', 'the API token was not accepted')],
    });

    const summary = await watchSource({ ...fixture.context, pollIntervalMs: 30_000 });

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('not accepted');
    expect(fixture.scans).toBe(1);
  });

  it(
    'stops without a second scan when the caller interrupts during the wait',
    { timeout: 20_000 },
    async () => {
      const workDir = await createTempDir();
      const sleeps = controlledSleep();
      const fixture = createFixture({ workDir, scans: [[]], sleep: sleeps.sleep });

      const watching = watchSource({ ...fixture.context, pollIntervalMs: 30_000 });
      await until(() => sleeps.waits.length === 1, 'the poll wait');
      fixture.stop.abort(new Error('interrupt'));

      const summary = await watching;

      expect(summary).toMatchObject({ outcome: 'cancelled', attempted: 0 });
      expect(fixture.scans).toBe(1);
      expect(existsSync(intakeLockPath(workDir))).toBe(false);
    },
  );

  it(
    'reports a repeated invalid description once, not on every scan',
    { timeout: 20_000 },
    async () => {
      const workDir = await createTempDir();
      const sleeps = controlledSleep();
      const fixture = createFixture({
        workDir,
        scans: [[candidateFor('1')]],
        sleep: sleeps.sleep,
        prepare: () => {
          throw new SourceError('invalid-task', 'SAM1-1: the description has no criteria heading');
        },
      });

      const watching = watchSource({ ...fixture.context, pollIntervalMs: 30_000 });
      for (let scan = 0; scan < 2; scan += 1) {
        await until(() => sleeps.waits.length > scan, `wait ${String(scan + 1)}`);
        sleeps.waits[scan]?.wake();
      }
      await until(
        () => fixture.log.filter((entry) => entry === 'list').length === 3,
        'three scans',
      );
      fixture.stop.abort(new Error('stop watching'));
      await watching;

      const reported = fixture.errors.filter((line) => line.includes('no criteria heading'));
      expect(reported).toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// The CLI, the coordinator, the connector, and the real runner
// ---------------------------------------------------------------------------

interface FakeIssue {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
  status: string;
  updated: string;
}

interface FakeJira {
  readonly fetch: typeof fetch;
  readonly calls: Array<{ method: string; url: string; body: unknown }>;
  readonly comments: string[];
  readonly issues: FakeIssue[];
}

function jiraDocument(): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Write the marker file the issue asks for.' }],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Acceptance criteria' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'The marker file exists.' }] },
            ],
          },
        ],
      },
    ],
  };
}

/** A Jira site in memory: search, reads, transitions, and comments. */
function fakeJira(issues: FakeIssue[]): FakeJira {
  const calls: FakeJira['calls'] = [];
  const comments: string[] = [];
  const transitionsFrom = (status: string): Array<Record<string, unknown>> => {
    if (status === 'To Do') {
      return [{ id: '11', name: 'Start work', to: { name: 'In Progress' } }];
    }
    if (status === 'In Progress') {
      return [{ id: '31', name: 'Send for review', to: { name: 'In Review' } }];
    }
    return [];
  };

  const jsonResponse = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init.method ?? 'GET';
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, url, body });

    if (url.endsWith('/search/jql')) {
      const eligible = issues.filter((issue) => issue.status === 'To Do');
      return jsonResponse({
        issues: eligible.map((issue) => ({
          id: issue.id,
          key: issue.key,
          fields: {
            summary: issue.summary,
            status: { name: issue.status },
            labels: ['harness-task'],
            project: { key: 'SAM1' },
            issuetype: { name: 'Task' },
            updated: issue.updated,
          },
        })),
        isLast: true,
      });
    }

    const issueMatch = /\/issue\/(\d+)(?:[/?]|$)/.exec(url);
    const issue = issues.find((candidate) => candidate.id === issueMatch?.[1]);
    if (issueMatch !== null && url.includes('/transitions')) {
      if (method === 'POST') {
        const wanted = (body?.['transition'] as { id?: string } | undefined)?.id;
        const chosen = transitionsFrom(issue?.status ?? '').find(
          (transition) => transition['id'] === wanted,
        );
        if (issue !== undefined && chosen !== undefined) {
          issue.status = String((chosen['to'] as { name: string }).name);
        }
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ transitions: transitionsFrom(issue?.status ?? '') });
    }
    if (issueMatch !== null && url.includes('/comment')) {
      comments.push(JSON.stringify(body?.['body']));
      return jsonResponse({ id: `comment-${String(comments.length)}` });
    }
    if (issue !== undefined) {
      return jsonResponse({
        id: issue.id,
        key: issue.key,
        fields: {
          summary: issue.summary,
          description: jiraDocument(),
          status: { name: issue.status },
          labels: ['harness-task'],
          project: { key: 'SAM1' },
          issuetype: { name: 'Task' },
          updated: issue.updated,
        },
      });
    }
    return jsonResponse({ errorMessages: ['not found'] }, 404);
  };

  return { fetch: impl as unknown as typeof fetch, calls, comments, issues };
}

interface CliRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

let fixtureEnvironment: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  const directory = await createTempDir();
  const emptyConfig = path.join(directory, 'empty.gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  fixtureEnvironment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: 'Nexus Source Test',
    GIT_AUTHOR_EMAIL: 'source@example.test',
    GIT_COMMITTER_NAME: 'Nexus Source Test',
    GIT_COMMITTER_EMAIL: 'source@example.test',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
});

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: fixtureEnvironment, windowsHide: true });
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

async function gitOrFail(args: readonly string[], cwd: string): Promise<void> {
  const result = await runProcess('git', args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

/** A clean repository with one commit and a config that points at a Jira queue. */
async function createTarget(): Promise<{
  directory: string;
  repo: string;
  configPath: string;
  workDir: string;
}> {
  const directory = await createTempDir();
  const repo = path.join(directory, 'target-project');
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, 'README.md'), '# target\n', 'utf8');
  await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
  await gitOrFail(['add', '--all'], repo);
  await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);

  const configPath = await writeJsonFile(directory, 'harness.jira.config.json', {
    ...documentedConfig,
    workDir: './runs',
    maxRepairs: 1,
    setup: [],
    checks: [[process.execPath, '-e', 'process.exit(0)']],
    source: {
      type: 'jira',
      siteUrl: SCOPE,
      cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
      projectKey: 'SAM1',
      pollIntervalSeconds: 5,
      tokenEnv: 'JIRA_API_TOKEN',
    },
  });

  return { directory, repo, configPath, workDir: path.join(directory, 'runs') };
}

interface CliOptions {
  readonly fetch: typeof fetch;
  readonly signals?: InterruptSignals;
  readonly dependencies?: CliContext['dependencies'];
}

async function runSourceCli(
  argv: readonly string[],
  cwd: string,
  options: CliOptions,
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = {
    cwd,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    fetch: options.fetch,
  };
  if (options.signals !== undefined) {
    context.signals = options.signals;
  }
  if (options.dependencies !== undefined) {
    context.dependencies = options.dependencies;
  }
  const code = await runCli(argv, context);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A recorded interrupt: the handler the CLI installed, called by the test. */
function recordingSignals(): InterruptSignals & { interrupt(): void; registered(): number } {
  const handlers: Array<() => void> = [];
  return {
    onInterrupt: (handler) => {
      handlers.push(handler);
      return () => {
        handlers.splice(handlers.indexOf(handler), 1);
      };
    },
    interrupt: () => {
      for (const handler of [...handlers]) {
        handler();
      }
    },
    registered: () => handlers.length,
  };
}

describe('the source commands through the CLI', () => {
  it('previews the queue, claims nothing, and writes nothing', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'list', '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch },
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('SAM1-11');
      expect(result.out).toContain('valid');
      expect(result.out).toContain('nothing was claimed');
      expect(
        jira.calls.every((call) => call.method === 'GET' || call.url.endsWith('/search/jql')),
      ).toBe(true);
      expect(existsSync(target.workDir)).toBe(false);
      expect(jira.issues[0]?.status).toBe('To Do');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('runs one eligible issue once, reports it, and refuses to repeat it', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker' };
        },
      };
      const first = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(first.err).toBe('');
      expect(first.code).toBe(EXIT_OK);
      expect(first.out).toContain('source completed');
      expect(first.out).toContain('1 passed');
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain('finished: passed');

      const runs = await readdir(path.join(target.workDir, 'runs'));
      const runDir = path.join(
        target.workDir,
        'runs',
        runs.find((name) => name.startsWith('run-')) ?? '',
      );
      expect(runs.filter((name) => name.startsWith('run-'))).toHaveLength(1);
      const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as {
        status: string;
        sourceRef?: { id: string; key: string };
      };
      expect(report.status).toBe('passed');
      expect(report.sourceRef).toMatchObject({ id: '10011', key: 'SAM1-11' });
      const snapshot = JSON.parse(
        await readFile(path.join(runDir, 'source-task.json'), 'utf8'),
      ) as {
        task: { id: string };
        source: { id: string };
      };
      expect(snapshot.task.id).toBe('SAM1-11');
      expect(snapshot.source.id).toBe('10011');

      const receiptPath = receiptFilePath(target.workDir, refFor('10011', 'SAM1-11'));
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
        runId?: string;
        feedback?: string;
      };
      expect(receipt.feedback).toBe('sent');
      expect(receipt.runId).toBe(path.basename(runDir));

      // A second scan of the same queue claimed nothing and started no run.
      const second = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );
      expect(second.code).toBe(EXIT_OK);
      expect(second.out).toContain('already attempted');
      expect(
        (await readdir(path.join(target.workDir, 'runs'))).filter((name) =>
          name.startsWith('run-'),
        ),
      ).toHaveLength(1);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('runs a failed attempt, reports it, and exits nonzero', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async () => {
          throw new Error('the runtime could not be started');
        },
      };
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath, '--limit', '1'],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.out).toContain('1 failed');
      // The issue still needs human attention; it is not left running, and it is
      // certainly not marked Done.
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments[0]).toContain('finished: failed');
      expect(jira.comments[0]).toContain('the runtime could not be started');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  // One real poll interval of five seconds has to elapse, so this test is given
  // more room than the default timeout rather than a shorter interval than the
  // documented minimum.
  it(
    'watch picks up an issue made eligible later, then stops on interrupt',
    { timeout: 30_000 },
    async () => {
      const target = await createTarget();
      const jira = fakeJira([
        {
          id: '10012',
          key: 'SAM1-12',
          summary: 'A later issue',
          status: 'Blocked',
          updated: '2026-09-16T12:00:00.000Z',
        },
      ]);
      const previous = process.env.JIRA_API_TOKEN;
      process.env.JIRA_API_TOKEN = 'test-token';
      const signals = recordingSignals();

      try {
        const dependencies: CliContext['dependencies'] = {
          runAgentTurn: async (request) => {
            await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
            return { summary: 'wrote the marker' };
          },
        };
        const watching = runSourceCli(
          ['source', 'watch', '--repo', target.repo, '--config', target.configPath],
          target.directory,
          { fetch: jira.fetch, signals, dependencies },
        );

        // The first scan finds nothing; the queue becomes ready while it waits.
        await until(
          () => jira.calls.some((call) => call.url.endsWith('/search/jql')),
          'the first scan',
        );
        await until(() => signals.registered() === 1, 'the interrupt handler');
        jira.issues[0]!.status = 'To Do';

        // The poll interval is 5 seconds; the run and its feedback follow the
        // second scan. The interrupt arrives once the result was published.
        await until(() => jira.comments.length === 1, 'the result comment', 20_000);
        signals.interrupt();
        const result = await watching;

        expect(result.code).toBe(EXIT_CANCELLED);
        expect(jira.issues[0]?.status).toBe('In Review');
        expect(
          jira.calls.filter((call) => call.url.endsWith('/search/jql')).length,
        ).toBeGreaterThanOrEqual(2);
        const runs = (await readdir(path.join(target.workDir, 'runs'))).filter((name) =>
          name.startsWith('run-'),
        );
        expect(runs).toHaveLength(1);
        expect(signals.registered()).toBe(0);
      } finally {
        if (previous === undefined) {
          delete process.env.JIRA_API_TOKEN;
        } else {
          process.env.JIRA_API_TOKEN = previous;
        }
      }
    },
  );

  it('refuses a source command without a source or a token, creating nothing', async () => {
    const target = await createTarget();
    const withoutSource = await writeJsonFile(target.directory, 'plain.json', documentedConfig);
    const previous = process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_API_TOKEN;

    try {
      const missingToken = await runSourceCli(
        ['source', 'list', '--config', target.configPath],
        target.directory,
        { fetch: fakeJira([]).fetch },
      );
      const missingSource = await runSourceCli(
        ['source', 'list', '--config', withoutSource],
        target.directory,
        { fetch: fakeJira([]).fetch },
      );

      expect(missingToken.code).toBe(EXIT_INPUT_ERROR);
      expect(missingToken.err).toContain('JIRA_API_TOKEN');
      expect(missingSource.code).toBe(EXIT_INPUT_ERROR);
      expect(missingSource.err).toContain('no "source" object');
      expect(existsSync(target.workDir)).toBe(false);
    } finally {
      if (previous !== undefined) {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });
});
