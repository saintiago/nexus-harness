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
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as invocation from '../src/process/invocation.js';
import { appendRunLog } from '../src/reporting/logs.js';
import { writeRunReport } from '../src/reporting/report.js';
import { createRunFinalizer } from '../src/runs/finalize.js';
import { WorkspaceError } from '../src/workspace/errors.js';
import { configureWorkspaceIdentity, runGit } from '../src/workspace/git.js';
import { inspectWorkspaceChanges } from '../src/workspace/changes.js';
import { runCli } from '../src/cli.js';
import { EXIT_CANCELLED, EXIT_INPUT_ERROR, EXIT_OK } from '../src/cli/context.js';
import type { CliContext, InterruptSignals } from '../src/cli/context.js';
import type { Delivery, DeliveryRequest } from '../src/delivery/github.js';
import { DeliveryError } from '../src/delivery/github.js';
import { summarizeChanges } from '../src/reporting/changes.js';
import { ReportError } from '../src/reporting/errors.js';
import type { RunTaskResult } from '../src/runs/contracts.js';
import { RunCancelledError } from '../src/runs/contracts.js';
import type {
  SourceCandidate,
  SourceComment,
  SourceContext,
  SourceRunOutcome,
  SourceTask,
  TaskSource,
} from '../src/sources/contract.js';
import { SourceError, SourceFeedbackError } from '../src/sources/contract.js';
import { runSource, watchSource } from '../src/sources/coordinator.js';
import { listSource } from '../src/sources/list.js';
import {
  acquireIntakeLock,
  intakeLockPath,
  readReceipt,
  receiptFilePath,
  reserveReceipt,
} from '../src/sources/receipts.js';
import type {
  AttemptEvidence,
  AttemptKind,
  CheckRoundResult,
  CommandOutcome,
  CommandResult,
  EscalationTier,
  RoundOutcome,
  RunReport,
  RunStatus,
  SourceRef,
  Task,
} from '../src/shared/types.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { prepareWorkspace } from '../src/workspace/prepare.js';
import { preflightSource } from '../src/workspace/preflight.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import type { RunDirectory } from '../src/workspace/run-directory.js';
import type { WorkspaceSourceItem } from '../src/workspace/state.js';
import {
  readWorkspaceState,
  recordWorkspaceAttempt,
  sourceItemFor,
  workspaceStatePath,
} from '../src/workspace/state.js';
import {
  fakeGhCalls,
  fakeTurns,
  installFakeGh,
  installFakeRuntime,
} from './fixtures/local-target.js';
import type { FakeGhState, FakePlan } from './fixtures/local-target.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedConfig,
  documentedHarnessConfig,
  fakeConsole,
  screenAfter,
  writeJsonFile,
} from './support.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../src/config/paths.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirectories();
});

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

function candidateFor(id: string, key = `SAM1-${id}`): SourceCandidate {
  return { ref: refFor(id, key), title: `Task ${key}` };
}

function taskFor(candidate: SourceCandidate): Task {
  return {
    id: candidate.ref.key,
    title: `Task ${candidate.ref.key}`,
    description: '## Acceptance criteria\n- It works.',
    acceptanceCriteria: ['It works.'],
  };
}

/**
 * The item as the fresh read returns it: the same issue, with the pointer labels
 * that read observed. The decision is made from these, never from what a search
 * result said, so a test that wants a continuation puts the label here.
 */
function preparedFor(candidate: SourceCandidate, pointers: readonly string[] = []): SourceTask {
  return { ref: candidate.ref, task: taskFor(candidate), pointers };
}

function runDirectoryAt(runDir: string): RunDirectory {
  return {
    workDir: path.dirname(path.dirname(runDir)),
    runId: path.basename(runDir),
    runDir,
    workspaceId: path.basename(runDir),
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
  workspace: PreparedWorkspace | null = null,
  workspaceLedgerProblem: string | null = null,
): RunTaskResult {
  return {
    run: runDirectoryAt(runDir),
    workspace,
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
    workspaceLedgerProblem,
    reportPath: path.join(runDir, 'result.json'),
  };
}

/**
 * A prepared working copy as a run's result records the one it used. The
 * delivery step is handed the working copy a passed run left, so a fake run has
 * to carry one for a delivery to be possible at all.
 */
function preparedWorkspaceFor(runDir: string): PreparedWorkspace {
  const workspaceId = path.basename(runDir);
  return {
    ...runDirectoryAt(runDir),
    workspaceId,
    continued: false,
    attempt: 1,
    sourceRoot: '/repo',
    baseCommit: 'base-commit',
    branch: `harness/${workspaceId}`,
  };
}

// ---------------------------------------------------------------------------
// A fixture around the real coordinator
// ---------------------------------------------------------------------------

/**
 * The lock namespace every fixture in this file consumes under: one connected
 * project, as the composed configuration would name it. Tests that hold a lock
 * beside a fixture use this same namespace.
 */
const FIXTURE_LOCK_NAMESPACE = 'fixture-connected-project';

interface FixtureOptions {
  readonly workDir: string;
  /** The ladder this fixture's coordinator climbs; one rung by default. */
  readonly tiers?: readonly EscalationTier[];
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
  readonly progress?: (
    item: SourceTask,
    outcome: SourceRunOutcome,
    call: number,
  ) => Promise<void> | void;
  readonly run?: (task: Task, call: number, runDir: string) => Promise<RunTaskResult>;
  readonly recordWorkspace?: (item: SourceTask, workspaceId: string) => Promise<void> | void;
  readonly refuse?: (item: SourceTask, reason: string) => Promise<void> | void;
  readonly commentsSince?: (
    item: SourceTask,
    since: string,
  ) => Promise<readonly SourceComment[]> | readonly SourceComment[];
  readonly preflight?: (call: number) => Promise<{ sourceRoot: string; baseCommit: string }>;
  readonly sleep?: (ms: number, stop: AbortSignal) => Promise<void>;
  /** The delivery step this fixture's coordinator uses, when it has one. */
  readonly delivery?: Delivery;
  /**
   * The review-to-completion pass this fixture's coordinator runs, when it has
   * one. Absent means the path is off, which is the behavior every other test
   * here already relies on.
   */
  readonly completion?: {
    readonly run: (stop: AbortSignal) => Promise<{
      readonly done: number;
      readonly toDo: number;
      readonly attention: number;
      readonly observed: number;
      readonly problem: string | null;
    }>;
  };
}

interface Fixture {
  readonly context: SourceContext;
  readonly log: string[];
  /** One entry per intermediate attempt comment, in order. */
  readonly progresses: Array<{ key: string; outcome: SourceRunOutcome }>;
  readonly completions: Array<{ key: string; outcome: SourceRunOutcome }>;
  readonly refusals: Array<{ key: string; reason: string }>;
  /** One entry per completion pass the coordinator ran, in order. */
  readonly completionRuns: Array<{ readonly problem: string | null }>;
  readonly requests: Array<{
    readonly task: Task;
    readonly tier: string | null;
    readonly guidance: readonly string[];
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
  const progresses: Fixture['progresses'] = [];
  const completions: Fixture['completions'] = [];
  const refusals: Fixture['refusals'] = [];
  const completionRuns: Fixture['completionRuns'] = [];
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
  let progressCount = 0;
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
      return prepared === undefined ? preparedFor(candidate) : prepared;
    },
    claim: async (item) => {
      claimCount += 1;
      log.push(`claim:${item.ref.key}`);
      return options.claim?.(item, claimCount) ?? true;
    },
    progress: async (item, outcome) => {
      progressCount += 1;
      log.push(`progress:${item.ref.key}:${outcome.status}`);
      progresses.push({ key: item.ref.key, outcome });
      await options.progress?.(item, outcome, progressCount);
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
    commentsSince: async (item, since) => {
      log.push(`comments:${item.ref.key}`);
      return options.commentsSince?.(item, since) ?? [];
    },
  };

  const context: SourceContext = {
    source,
    workDir: options.workDir,
    lockNamespace: FIXTURE_LOCK_NAMESPACE,
    tiers: options.tiers ?? [
      {
        name: 'default',
        agent: { runtime: 'codex', command: ['codex'] },
        maxRepairs: 2,
      },
    ],
    repoPath: '/repo',
    io: { out: (text) => output.push(text), err: (text) => errors.push(text) },
    stop: stop.signal,
    ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
    ...(options.completion === undefined
      ? {}
      : {
          completion: {
            run: async (completionStop: AbortSignal) => {
              const summary = await options.completion?.run(completionStop);
              const recorded = summary ?? {
                done: 0,
                toDo: 0,
                attention: 0,
                observed: 0,
                problem: null,
              };
              completionRuns.push({ problem: recorded.problem });
              return recorded;
            },
          },
        }),
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
        tier: asked.tier?.name ?? null,
        guidance: asked.guidance ?? [],
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
    progresses,
    completions,
    refusals,
    completionRuns,
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

describe('review-to-completion coordination', () => {
  it('runs one completion pass after the batch and reports its counts', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      completion: {
        run: async () => ({ done: 1, toDo: 0, attention: 0, observed: 0, problem: null }),
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('completed');
    expect(summary.completion).toEqual({
      done: 1,
      toDo: 0,
      attention: 0,
      observed: 0,
      problem: null,
    });
    expect(fixture.completionRuns).toHaveLength(1);
  });

  it('keeps the intake outcome when the completion pass reports a problem', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      completion: {
        run: async () => ({
          done: 0,
          toDo: 0,
          attention: 0,
          observed: 0,
          problem: 'GitHub is unreachable',
        }),
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('completed');
    expect(summary.completion?.problem).toBe('GitHub is unreachable');
    expect(fixture.errors.join('\n')).toContain('completion pass: GitHub is unreachable');
  });

  it('leaves In Review behavior unchanged when completion is disabled', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({ workDir });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('completed');
    expect(summary.completion).toBeNull();
    expect(fixture.completionRuns).toHaveLength(0);
  });

  it('runs the completion pass after each watch scan', async () => {
    const workDir = await createTempDir();
    let passes = 0;
    const stop = new AbortController();
    const fixture = createFixture({
      workDir,
      completion: {
        run: async () => {
          passes += 1;
          if (passes >= 2) {
            stop.abort(new Error('two scans are enough'));
          }
          return { done: 0, toDo: 1, attention: 0, observed: 0, problem: null };
        },
      },
    });

    const summary = await watchSource({
      ...fixture.context,
      stop: stop.signal,
      pollIntervalMs: 1,
    });

    expect(passes).toBeGreaterThanOrEqual(2);
    expect(summary.outcome).toBe('cancelled');
    expect(fixture.completionRuns.length).toBeGreaterThanOrEqual(2);
  });
});
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
    // The item's thread is read after the claim, per attempt: a claim that was
    // rejected costs no read, and a later rung of a ladder reads the thread
    // again rather than reusing the previous rung's view of it.
    expect(fixture.log).toEqual([
      'preflight:1',
      'list',
      'preflight:2',
      'prepare:SAM1-1',
      'claim:SAM1-1',
      'comments:SAM1-1',
      'run:SAM1-1',
      'workspace:SAM1-1:run-1',
      'complete:SAM1-1:passed',
      'preflight:3',
      'prepare:SAM1-2',
      'claim:SAM1-2',
      'comments:SAM1-2',
      'run:SAM1-2',
      'workspace:SAM1-2:run-2',
      'complete:SAM1-2:passed',
      'preflight:4',
      'prepare:SAM1-3',
      'claim:SAM1-3',
      'comments:SAM1-3',
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
        return preparedFor(candidate);
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
    expect(existsSync(intakeLockPath(workDir, FIXTURE_LOCK_NAMESPACE))).toBe(false);
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
    expect(existsSync(intakeLockPath(workDir, FIXTURE_LOCK_NAMESPACE))).toBe(true);
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
    expect(existsSync(intakeLockPath(workDir, FIXTURE_LOCK_NAMESPACE))).toBe(true);
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
// The optional delivery step
// ---------------------------------------------------------------------------

describe('delivering a passed attempt', () => {
  /** A run that passed in a working copy the delivery step can be handed. */
  async function passedRun(_task: Task, _call: number, runDir: string): Promise<RunTaskResult> {
    return resultFor(
      runDir,
      'passed',
      'every configured check passed after the implementation turn',
      null,
      preparedWorkspaceFor(runDir),
    );
  }

  it('delivers before publishing, and carries the pull request into the result', async () => {
    const workDir = await createTempDir();
    const requests: DeliveryRequest[] = [];
    const fixture = createFixture({
      workDir,
      run: passedRun,
      delivery: {
        deliver: async (request) => {
          requests.push(request);
          return { url: 'https://github.com/example-owner/example-repo/pull/7', created: true };
        },
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('completed');
    expect(summary.passed).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      workspacePath: preparedWorkspaceFor(path.join(workDir, 'run-1')).workspacePath,
      branch: 'harness/run-1',
      baseCommit: 'base-commit',
      logsDir: path.join(workDir, 'run-1', 'logs'),
      runId: 'run-1',
      task: { id: 'SAM1-1', title: 'Task SAM1-1' },
      checks: 'no check round was completed for this run',
      sourceRef: { type: 'jira', id: '1', key: 'SAM1-1' },
    });
    expect(fixture.completions).toHaveLength(1);
    expect(fixture.completions[0]?.outcome.pullRequest).toEqual({
      url: 'https://github.com/example-owner/example-repo/pull/7',
      created: true,
    });
    expect(fixture.log).toContain('complete:SAM1-1:passed');
    expect(fixture.output.join('\n')).toContain(
      'pull request created: https://github.com/example-owner/example-repo/pull/7',
    );
  });

  it('keeps failed and cancelled work local: the delivery step is never asked', async () => {
    const workDir = await createTempDir();
    const requests: DeliveryRequest[] = [];
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1'), candidateFor('2')]],
      run: async (task, _call, runDir) =>
        resultFor(runDir, task.id === 'SAM1-1' ? 'failed' : 'cancelled'),
      delivery: {
        deliver: async (request) => {
          requests.push(request);
          return null;
        },
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.failed).toBe(1);
    expect(summary.cancelled).toBe(1);
    expect(requests).toEqual([]);
    expect(fixture.completions.map((entry) => entry.outcome.status)).toEqual([
      'failed',
      'cancelled',
    ]);
  });

  it('tells the issue the passed outcome and the delivery failure, then stops intake', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      run: passedRun,
      delivery: {
        deliver: async () => {
          throw new DeliveryError('git push failed: authentication required');
        },
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('authentication required');
    // The retry advice is an operator step, never a return to the ready status
    // that would start a coding run to repair a publishing failure.
    expect(summary.problem).toContain('check the destination repository');
    expect(summary.problem).toContain('starts a new coding run');
    expect(summary.problem).not.toContain('ready status to retry');

    // The run's own evidence is kept as it was written, and the issue is still
    // told the outcome that run produced, with the failure beside it, so a
    // finished passed task is not left in the running status.
    expect(fixture.completions).toHaveLength(1);
    expect(fixture.completions[0]?.outcome).toMatchObject({
      status: 'passed',
      reason: 'every configured check passed after the implementation turn',
      checks: 'no check round was completed for this run',
      reportPath: path.join(workDir, 'run-1', 'result.json'),
      runDir: path.join(workDir, 'run-1'),
      deliveryFailure: 'git push failed: authentication required',
    });
    expect(fixture.completions[0]?.outcome.pullRequest).toBeUndefined();
    const receipt = await readReceipt(receiptFilePath(workDir, refFor('1')));
    expect(receipt?.outcome).toBe('passed');
    expect(receipt?.resultPath).toBe(path.join(workDir, 'run-1', 'result.json'));
    expect(receipt?.feedback).toBe('sent');
    expect(receipt?.problem).toContain('delivery: git push failed: authentication required');
  });

  it('keeps the local evidence when the delivery failure cannot be told to the issue', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      run: passedRun,
      delivery: {
        deliver: async () => {
          throw new DeliveryError('git push failed: authentication required');
        },
      },
      complete: () => {
        throw new Error('Jira is unreachable');
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('git push failed: authentication required');
    expect(summary.problem).toContain('Jira is unreachable');
    // A Jira failure here costs the run nothing: its report, its outcome, and
    // the delivery problem stay in the receipt exactly as they were written.
    const receipt = await readReceipt(receiptFilePath(workDir, refFor('1')));
    expect(receipt?.outcome).toBe('passed');
    expect(receipt?.resultPath).toBe(path.join(workDir, 'run-1', 'result.json'));
    expect(receipt?.feedback).toBe('failed');
    expect(receipt?.problem).toContain('delivery: git push failed: authentication required');
    expect(receipt?.problem).toContain('feedback: Jira is unreachable');
  });

  it('publishes normally when the configured step finds nothing to deliver', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      run: passedRun,
      delivery: { deliver: async () => null },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('completed');
    expect(summary.passed).toBe(1);
    expect(fixture.completions).toHaveLength(1);
    expect(fixture.completions[0]?.outcome.pullRequest).toBeUndefined();
    expect(fixture.output.join('\n')).toContain('nothing to deliver');
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
    const held = await acquireIntakeLock(workDir, FIXTURE_LOCK_NAMESPACE, () => new Date());
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
    const dir = intakeLockPath(workDir, FIXTURE_LOCK_NAMESPACE);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'owner.json'),
      `${JSON.stringify({ version: 1, pid: 999999, startedAt: '2026-01-01T00:00:00.000Z', token: 'someone-else' })}\n`,
      'utf8',
    );

    let thrown: unknown;
    try {
      await acquireIntakeLock(workDir, FIXTURE_LOCK_NAMESPACE, () => new Date());
    } catch (cause) {
      thrown = cause;
    }

    expect((thrown as SourceError).message).toContain('another intake consumer holds');
    expect(existsSync(path.join(dir, 'owner.json'))).toBe(true);
  });

  it('refuses to release a lock that is no longer its own', async () => {
    const workDir = await createTempDir();
    const lock = await acquireIntakeLock(workDir, FIXTURE_LOCK_NAMESPACE, () => new Date());
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

describe('Git cleanup at intake boundaries', () => {
  const cleanupProblem = 'owned fake Git tree did not stop';
  const failure = () =>
    new WorkspaceError('Git inspection did not finish', {
      stop: { termination: 'unconfirmed', problem: cleanupProblem },
    });

  it.each(['timed-out', 'stopped'] as const)(
    'rejects zero-exit %s in identity and inspection callers',
    async (outcome) => {
      const invoke = vi.spyOn(invocation, 'runInvocation').mockResolvedValue({
        outcome,
        exitCode: 0,
        signal: null,
        launchError: null,
        timeoutMs: 25,
        termination: 'unconfirmed',
        terminationProblem: cleanupProblem,
      });
      expect((await runGit(['status'], '/mock')).code).toBe(-1);
      await expect(configureWorkspaceIdentity('/mock')).rejects.toMatchObject({
        stop: { termination: 'unconfirmed', problem: cleanupProblem },
      });
      await expect(
        inspectWorkspaceChanges(preparedWorkspaceFor('/mock/run-1')),
      ).rejects.toMatchObject({
        stop: { termination: 'unconfirmed', problem: cleanupProblem },
      });
      expect(invoke).toHaveBeenCalledTimes(3);
    },
  );

  for (const mode of ['run', 'watch'] as const) {
    for (const cancelled of [false, true]) {
      for (const phase of ['initial', 'candidate', 'reopen', 'runner'] as const) {
        it(`${mode} retains unconfirmed cleanup during ${phase}, cancelled=${String(cancelled)}`, async () => {
          const workDir = await createTempDir();
          const workspace = phase === 'reopen' ? await preparedWorkspaceOnDisk(workDir) : null;
          const existingLock =
            phase === 'initial'
              ? await acquireIntakeLock(workDir, FIXTURE_LOCK_NAMESPACE, () => new Date())
              : null;
          const previousOwner =
            existingLock === null
              ? null
              : await readFile(path.join(existingLock.dir, 'owner.json'), 'utf8');
          const retained =
            workspace === null
              ? null
              : path.join(workDir, 'workspaces', workspace.workspaceId, 'partial.txt');
          if (retained !== null) await writeFile(retained, 'keep partial work');
          if (workspace !== null)
            await reserveReceipt(receiptFilePath(workDir, refFor('2')), {
              version: 1,
              source: refFor('2'),
              reservedAt: new Date().toISOString(),
            });
          const oldReceipt =
            workspace === null ? null : await readReceipt(receiptFilePath(workDir, refFor('2')));
          const fixture = createFixture({
            workDir,
            scans: [[candidateFor('2'), candidateFor('3')]],
            prepare: (candidate) =>
              preparedFor(candidate, workspace === null ? [] : [workspace.workspaceId]),
            preflight: async (call) => {
              if ((phase === 'initial' && call === 1) || (phase === 'candidate' && call === 2)) {
                if (cancelled) fixture.stop.abort();
                throw failure();
              }
              return { sourceRoot: workspace?.sourceRoot ?? '/repo', baseCommit: 'base' };
            },
            run: async () => {
              if (cancelled) fixture.stop.abort();
              throw new RunCancelledError('runner preflight stopped', { cause: failure() });
            },
            sleep: async () => {
              throw new Error('must not poll again');
            },
          });
          if (phase === 'reopen')
            vi.spyOn(invocation, 'runInvocation').mockImplementation(async () => {
              if (cancelled) fixture.stop.abort();
              return {
                outcome: cancelled ? 'stopped' : 'timed-out',
                exitCode: 0,
                signal: null,
                launchError: null,
                timeoutMs: 25,
                termination: 'unconfirmed',
                terminationProblem: cleanupProblem,
              };
            });
          const summary =
            mode === 'run'
              ? await runSource(fixture.context, null)
              : await watchSource({ ...fixture.context, pollIntervalMs: 1 });
          expect(summary.outcome).toBe(cancelled ? 'cancelled' : 'stopped');
          expect(summary.cleanupConfirmed).toBe(false);
          expect(summary.problem).toContain(cleanupProblem);
          expect(existsSync(intakeLockPath(workDir, FIXTURE_LOCK_NAMESPACE))).toBe(true);
          expect(fixture.completions).toEqual([]);
          expect(fixture.progresses).toEqual([]);
          expect(fixture.refusals).toEqual([]);
          expect(fixture.requests).toHaveLength(phase === 'runner' ? 1 : 0);
          expect(fixture.log).not.toContain('prepare:SAM1-3');
          if (previousOwner !== null)
            expect(
              await readFile(
                path.join(intakeLockPath(workDir, FIXTURE_LOCK_NAMESPACE), 'owner.json'),
                'utf8',
              ),
            ).toBe(previousOwner);
          if (retained !== null) expect(await readFile(retained, 'utf8')).toBe('keep partial work');
          if (workspace !== null)
            expect(await readReceipt(receiptFilePath(workDir, refFor('2')))).toEqual(oldReceipt);
        });
      }
    }
  }

  it.each(
    (['timed-out', 'stopped'] as const).flatMap((outcome) =>
      (['passed', 'timeout', 'cancelled', 'confirmed'] as const).map((prior) => ({
        outcome,
        prior,
      })),
    ),
  )(
    'finalizer keeps cleanup and first-stop evidence after $outcome with exit 0, prior=$prior',
    async ({ outcome, prior }) => {
      const workDir = await createTempDir();
      const confirmed = prior === 'confirmed';
      const status = confirmed
        ? 'passed'
        : prior === 'cancelled'
          ? 'cancelled'
          : prior === 'timeout'
            ? 'failed'
            : outcome === 'stopped'
              ? 'cancelled'
              : 'failed';
      const delivery = { deliver: vi.fn<Delivery['deliver']>().mockResolvedValue(null) };
      const ledger = vi.fn().mockResolvedValue(undefined);
      const fixture = createFixture({
        workDir,
        scans: [confirmed ? [candidateFor('1')] : [candidateFor('1'), candidateFor('2')]],
        delivery,
        tiers: [
          { name: 'first', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 0 },
          { name: 'next', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 0 },
        ],
        run: async (task, _call, runDir) => {
          const run = runDirectoryAt(runDir);
          const workspace = preparedWorkspaceFor(runDir);
          await mkdir(run.logsDir, { recursive: true });
          await mkdir(workspace.workspacePath, { recursive: true });
          await writeFile(path.join(workspace.workspacePath, 'partial.txt'), 'retained');
          vi.spyOn(invocation, 'runInvocation').mockResolvedValue({
            outcome,
            exitCode: 0,
            signal: null,
            launchError: null,
            timeoutMs: 25,
            termination: confirmed ? 'confirmed' : 'unconfirmed',
            terminationProblem: confirmed ? null : cleanupProblem,
          });
          const unexpected = async (): Promise<never> => {
            throw new Error('unexpected finalizer dependency');
          };
          const config = {
            ...documentedConfig,
            agent: { runtime: 'codex' as const, command: ['codex'] },
          };
          const now = new Date();
          const finalizer = createRunFinalizer({
            request: { task, config, repoPath: '/repo', workDir },
            run,
            workspace,
            task,
            config,
            source: { sourceRoot: '/repo', baseCommit: workspace.baseCommit },
            preparationProblem: null,
            timeline: path.join(run.logsDir, 'run.log'),
            start: now,
            startedAt: now.toISOString(),
            deadlineMs: now.getTime() + 1000,
            dependencies: {
              preflight: unexpected,
              allocateRunDirectory: unexpected,
              prepareWorkspace: unexpected,
              configureWorkspaceIdentity: unexpected,
              runCheckRound: unexpected,
              runAgentTurn: unexpected,
              openAgentLog: unexpected,
              appendRunLog,
              writeRunReport,
              recordWorkspaceAttempt: ledger,
              now: () => now,
            },
          });
          return finalizer.endRun({
            status: prior === 'cancelled' ? 'cancelled' : prior === 'timeout' ? 'failed' : 'passed',
            reason: prior === 'timeout' || prior === 'cancelled' ? 'first stop' : 'checks passed',
            baseline: roundFor('passed', 0),
            attempts: [attemptFor(1, 'implementation', roundFor('passed', 0))],
            timeout:
              prior === 'timeout'
                ? {
                    phase: 'checks',
                    limit: 'task',
                    limitMs: 1000,
                    elapsedMs: 1000,
                    termination: 'confirmed',
                    problem: null,
                  }
                : null,
            cancellation:
              prior === 'cancelled'
                ? { phase: 'checks', elapsedMs: 1000, termination: 'confirmed', problem: null }
                : null,
          });
        },
      });
      const summary = await runSource(fixture.context, null);
      expect(summary.outcome).toBe(
        confirmed ? 'completed' : status === 'cancelled' ? 'cancelled' : 'stopped',
      );
      expect(summary.cleanupConfirmed).toBe(confirmed);
      expect(fixture.requests).toHaveLength(1);
      expect(delivery.deliver).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(fixture.completions).toHaveLength(confirmed ? 1 : 0);
      expect(fixture.progresses).toEqual([]);
      expect(fixture.log).toContain('workspace:SAM1-1:run-1');
      expect(existsSync(intakeLockPath(workDir, FIXTURE_LOCK_NAMESPACE))).toBe(!confirmed);
      const receipt = await readReceipt(receiptFilePath(workDir, refFor('1')));
      if (!confirmed) {
        expect(receipt?.feedback).toBe('pending');
        expect(receipt?.problem).toContain(cleanupProblem);
      }
      const report = JSON.parse(await readFile(receipt?.resultPath ?? '', 'utf8')) as RunReport;
      expect(report.status).toBe(status);
      if (confirmed) expect(report.timeout ?? report.cancellation).toBeNull();
      else
        expect(report.timeout ?? report.cancellation).toMatchObject({
          termination: 'unconfirmed',
          phase:
            prior === 'timeout' || prior === 'cancelled' ? 'checks' : 'final workspace inspection',
        });
      if (prior === 'timeout' || prior === 'cancelled') expect(report.reason).toBe('first stop');
      expect(report.changes.inspected).toBe(false);
      expect(report.changes.problem).toContain(
        confirmed ? 'could not be compared' : cleanupProblem,
      );
      expect(report.attempts[0]?.checks?.outcome).toBe('passed');
      expect(ledger).toHaveBeenCalledWith(
        workDir,
        'run-1',
        expect.objectContaining({ outcome: report.status }),
      );
      expect(
        await readFile(
          path.join(preparedWorkspaceFor(path.join(workDir, 'run-1')).workspacePath, 'partial.txt'),
          'utf8',
        ),
      ).toBe('retained');
    },
  );
});

/** A real workspace on disk, prepared the way a first attempt prepares one. */
async function preparedWorkspaceOnDisk(
  workDir: string,
  attempts: readonly {
    readonly outcome: RunStatus;
    readonly reason: string;
    readonly tier?: string;
  }[] = [],
  item: { readonly id: string; readonly key: string } = { id: '2', key: 'SAM1-2' },
): Promise<{
  readonly workspaceId: string;
  /** The item identity the ledger records, as a continuation must match it. */
  readonly sourceItem: WorkspaceSourceItem;
  /** The repository root the ledger records, as this run's preflight resolves it. */
  readonly sourceRoot: string;
}> {
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

  const sourceItem = sourceItemFor(refFor(item.id, item.key));
  const source = await preflightSource({ repoPath: repo, workDir });
  const prepared = await prepareWorkspace(
    await allocateRunDirectory(workDir),
    source,
    {
      deadlineMs: Date.now() + 60_000,
      now: () => new Date(),
      stop: undefined,
    },
    sourceItem,
  );
  if (attempts.length > 0) {
    // The ledger the runner writes as each attempt finishes, as this continuation
    // will read it.
    await writeFile(
      workspaceStatePath(workDir, prepared.workspaceId),
      `${JSON.stringify({
        version: 1,
        workspaceId: prepared.workspaceId,
        sourceRoot: repo,
        baseCommit: prepared.baseCommit,
        branch: prepared.branch,
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceItem,
        attempts: attempts.map((attempt, index) => ({
          runId: `run-${String(index + 1)}`,
          outcome: attempt.outcome,
          reason: attempt.reason,
          ...(attempt.tier === undefined ? {} : { tier: attempt.tier }),
          endedAt: `2026-01-0${String(index + 1)}T00:00:00.000Z`,
          reportPath: `/runs/run-${String(index + 1)}/result.json`,
        })),
      })}\n`,
      'utf8',
    );
  }
  return { workspaceId: prepared.workspaceId, sourceItem, sourceRoot: source.sourceRoot };
}

/**
 * A run result that carries the workspace it worked in, the way the runner's
 * does: the ladder reads the next attempt number from it. `attempts` is the
 * evidence its own turns left, which is what decides whether another rung may
 * follow it.
 */
function resultContinuing(
  runDir: string,
  workspace: { readonly workspaceId: string; readonly attempt: number },
  status: RunStatus,
  attempts: readonly AttemptEvidence[] = [],
): RunTaskResult {
  const workDir = path.dirname(runDir);
  return {
    ...resultFor(runDir, status, `attempt ${String(workspace.attempt)}`),
    attempts,
    repairsUsed: attempts.filter((attempt) => attempt.kind === 'repair').length,
    workspace: {
      workDir,
      runId: path.basename(runDir),
      runDir,
      workspacePath: path.join(workDir, 'workspaces', workspace.workspaceId),
      logsDir: path.join(runDir, 'logs'),
      workspaceId: workspace.workspaceId,
      continued: workspace.attempt > 1,
      attempt: workspace.attempt,
      sourceRoot: '/repo',
      baseCommit: 'base',
      branch: `harness/${workspace.workspaceId}`,
    },
  };
}

/**
 * The turns of a run that spent its repair allowance on ordinary completed red
 * check rounds — the one ending the escalation ladder climbs from.
 */
function redRoundAttempts(): readonly AttemptEvidence[] {
  return [
    attemptFor(1, 'implementation', roundFor('failed', 1)),
    attemptFor(2, 'repair', roundFor('failed', 1)),
  ];
}

describe('the escalation ladder', () => {
  const TIERS: readonly EscalationTier[] = [
    {
      name: 'flash',
      agent: { runtime: 'codex', command: ['codex', '--model', 'deepseek-flash'] },
      maxRepairs: 1,
    },
    {
      name: 'pro',
      agent: { runtime: 'codex', command: ['codex', '--model', 'deepseek-pro'] },
      maxRepairs: 2,
    },
  ];

  it('climbs to the next tier in the same workspace when an attempt fails', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      tiers: TIERS,
      scans: [[candidateFor('1')]],
      run: (_task, call, runDir) =>
        Promise.resolve(
          resultContinuing(
            runDir,
            { workspaceId: 'run-1', attempt: call },
            call === 1 ? 'failed' : 'passed',
            call === 1
              ? redRoundAttempts()
              : [attemptFor(1, 'implementation', roundFor('passed', 0))],
          ),
        ),
    });

    const summary = await runSource(fixture.context, null);

    // One issue, two attempts, one entry in the counters, and the second attempt
    // ran the stronger tier in the workspace the first one made.
    expect(summary.outcome).toBe('completed');
    expect(summary.attempted).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(fixture.requests.map((request) => request.tier)).toEqual(['flash', 'pro']);
    expect(fixture.requests[0]?.continued).toBe(false);
    expect(fixture.requests[1]?.continued).toBe(true);
    expect(fixture.requests[1]?.continuedWorkspace).toEqual({
      workspaceId: 'run-1',
      workspacePath: path.join(workDir, 'workspaces', 'run-1'),
      branch: 'harness/run-1',
      baseCommit: 'base',
      attempt: 2,
    });
    // Two runs, two comments, each saying which attempt it was: the first is the
    // intermediate attempt's own comment, published while the item stays in the
    // running status, and only the second moves it by completing the issue.
    expect(fixture.progresses.map((entry) => entry.outcome.attempt)).toEqual([
      { number: 1, of: 2, tier: 'flash' },
    ]);
    expect(fixture.completions.map((completion) => completion.outcome.attempt)).toEqual([
      { number: 2, of: 2, tier: 'pro' },
    ]);
    expect(fixture.log.indexOf('progress:SAM1-1:failed')).toBeGreaterThanOrEqual(0);
    expect(fixture.log.indexOf('progress:SAM1-1:failed')).toBeLessThan(
      fixture.log.indexOf('complete:SAM1-1:passed'),
    );
    expect(fixture.output.join('\n')).toContain('the issue stays in the running status');
    expect(fixture.output.join('\n')).toContain('escalating to tier pro (attempt 2 of 2)');
    // Every rung reads the item's thread for itself, so a later attempt is not
    // handed the previous rung's stale view of it.
    expect(fixture.log.filter((entry) => entry === 'comments:SAM1-1')).toHaveLength(2);
    // The pointer was written once, by the first attempt.
    expect(fixture.log.filter((entry) => entry.startsWith('workspace:'))).toHaveLength(1);
  });

  it('does not climb when the first tier passes', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({ workDir, tiers: TIERS, scans: [[candidateFor('1')]] });

    const summary = await runSource(fixture.context, null);

    expect(summary.passed).toBe(1);
    expect(fixture.requests.map((request) => request.tier)).toEqual(['flash']);
    expect(fixture.completions).toHaveLength(1);
  });

  it('does not climb when the attempt ended on a turn that failed', async () => {
    const workDir = await createTempDir();
    // A coding turn that could not finish — a launch, authentication, or
    // protocol error — leaves no round after it. That is not an ordinary failed
    // check: a stronger tier would be spent on the same infrastructure, so the
    // run is the ladder's last word at this rung.
    const fixture = createFixture({
      workDir,
      tiers: TIERS,
      scans: [[candidateFor('1')]],
      run: (_task, _call, runDir) =>
        Promise.resolve(
          resultContinuing(runDir, { workspaceId: 'run-1', attempt: 1 }, 'failed', [
            attemptFor(1, 'implementation', null),
          ]),
        ),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('completed');
    expect(summary.failed).toBe(1);
    expect(fixture.requests.map((request) => request.tier)).toEqual(['flash']);
    expect(fixture.progresses).toEqual([]);
    expect(fixture.completions).toHaveLength(1);
    expect(fixture.output.join('\n')).not.toContain('escalating to tier');
  });

  it('does not climb when the post-agent round could not be executed', async () => {
    const workDir = await createTempDir();
    // A setup command failed or a check could not be launched: the round is an
    // execution error, not a red check to code around, so it stays on the rung
    // it happened on.
    const fixture = createFixture({
      workDir,
      tiers: TIERS,
      scans: [[candidateFor('1')]],
      run: (_task, _call, runDir) =>
        Promise.resolve(
          resultContinuing(runDir, { workspaceId: 'run-1', attempt: 1 }, 'failed', [
            attemptFor(1, 'implementation', roundFor('execution-error', null)),
          ]),
        ),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('completed');
    expect(summary.failed).toBe(1);
    expect(fixture.requests.map((request) => request.tier)).toEqual(['flash']);
    expect(fixture.progresses).toEqual([]);
    expect(fixture.completions).toHaveLength(1);
  });

  it('does not climb when the caller stopped the attempt', async () => {
    const workDir = await createTempDir();
    // Even a stopped run whose last round was red is over: the caller asked for
    // it to end, so nothing follows it.
    const fixture = createFixture({
      workDir,
      tiers: TIERS,
      scans: [[candidateFor('1')]],
      run: (_task, _call, runDir) =>
        Promise.resolve(
          resultContinuing(
            runDir,
            { workspaceId: 'run-1', attempt: 1 },
            'cancelled',
            redRoundAttempts(),
          ),
        ),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.cancelled).toBe(1);
    expect(fixture.requests.map((request) => request.tier)).toEqual(['flash']);
    expect(fixture.progresses).toEqual([]);
    expect(fixture.completions).toHaveLength(1);
  });

  it('does not climb when the task deadline expired after a red round', async () => {
    const workDir = await createTempDir();
    // The red round would be an ordinary failure, but the run's own limit
    // expired before the repair turn: the run is failed with a timeout record,
    // and an expired limit is not repair feedback to escalate.
    const fixture = createFixture({
      workDir,
      tiers: TIERS,
      scans: [[candidateFor('1')]],
      run: (_task, _call, runDir) =>
        Promise.resolve({
          ...resultContinuing(
            runDir,
            { workspaceId: 'run-1', attempt: 1 },
            'failed',
            redRoundAttempts(),
          ),
          timeout: {
            limit: 'task',
            phase: 'repair turn 2',
            limitMs: 60_000,
            elapsedMs: 60_000,
            termination: 'confirmed',
            problem: null,
          },
        }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.outcome).toBe('completed');
    expect(summary.failed).toBe(1);
    expect(fixture.requests.map((request) => request.tier)).toEqual(['flash']);
    expect(fixture.progresses).toEqual([]);
    expect(fixture.completions).toHaveLength(1);
  });

  it('stops the climb when the attempt could not be recorded in its workspace ledger', async () => {
    const workDir = await createTempDir();
    const ledgerPath = workspaceStatePath(workDir, 'run-1');
    const fixture = createFixture({
      workDir,
      tiers: TIERS,
      scans: [[candidateFor('1')]],
      run: (_task, _call, runDir) =>
        Promise.resolve(
          resultFor(
            runDir,
            'failed',
            'the checks after the implementation turn did not pass',
            null,
            preparedWorkspaceFor(runDir),
            `the workspace ledger ("${ledgerPath}") could not be updated with this attempt: ` +
              'the file could not be replaced: the disk is read-only',
          ),
        ),
    });

    const summary = await runSource(fixture.context, null);

    // The ladder stops instead of climbing: the next attempt would read this
    // workspace's ledger for its number, its tier, and its guidance, and the
    // ledger does not hold the attempt that just ran.
    expect(summary.outcome).toBe('stopped');
    expect(summary.attempted).toBe(1);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.completions).toEqual([]);
    // The operator gets the failed path, what failed, and where the run's own
    // evidence was kept.
    expect(summary.problem).toContain(ledgerPath);
    expect(summary.problem).toContain('the disk is read-only');
    expect(summary.problem).toContain(path.join(workDir, 'run-1', 'result.json'));
    expect(summary.problem).toContain('no further automatic attempt');
    // The receipt keeps the real local result and records the failed save.
    const receipt = await readReceipt(receiptFilePath(workDir, refFor('1')));
    expect(receipt?.outcome).toBe('failed');
    expect(receipt?.resultPath).toBe(path.join(workDir, 'run-1', 'result.json'));
    expect(receipt?.feedback).toBe('pending');
    expect(receipt?.problem).toContain('workspace ledger:');
    expect(receipt?.problem).toContain(ledgerPath);
  });
});

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
    const { workspaceId, sourceRoot } = await preparedWorkspaceOnDisk(workDir);
    const fixture = createFixture({
      workDir,
      // The search result is a preview: the workspace label is on the issue when
      // the item is re-read, and that read is what decides.
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => preparedFor(candidate, [workspaceId]),
      preflight: () => Promise.resolve({ sourceRoot, baseCommit: 'base' }),
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

  it('tells a continued attempt what the earlier ones did, and what was said since', async () => {
    const workDir = await createTempDir();
    const { workspaceId, sourceRoot } = await preparedWorkspaceOnDisk(workDir, [
      {
        outcome: 'failed',
        reason: 'the baseline was red and the turn did not fix it',
        tier: 'flash',
      },
    ]);
    const asked: string[] = [];
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => preparedFor(candidate, [workspaceId]),
      preflight: () => Promise.resolve({ sourceRoot, baseCommit: 'base' }),
      commentsSince: (_item, since) => {
        asked.push(since);
        return [
          {
            author: 'An Investigator',
            createdAt: '2026-01-02T09:00:00.000Z',
            text: 'the task cannot pass the checks without a valid email address',
          },
        ];
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.passed).toBe(1);
    // Only what the previous attempt's own end says is new enough to matter.
    expect(asked).toEqual(['2026-01-01T00:00:00.000Z']);
    expect(fixture.requests[0]?.guidance).toEqual([
      'attempt 1 (tier flash) failed: the baseline was red and the turn did not fix it',
      'comment by An Investigator at 2026-01-02T09:00:00.000Z: ' +
        'the task cannot pass the checks without a valid email address',
    ]);
  });

  it('tells a first attempt what the ticket thread says, from the beginning', async () => {
    const workDir = await createTempDir();
    const asked: string[] = [];
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1')]],
      commentsSince: (_item, since) => {
        asked.push(since);
        return [
          {
            author: 'An Investigator',
            createdAt: '2026-01-01T00:00:00.000Z',
            text: 'read docs/module-structure.md before changing anything',
          },
        ];
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.passed).toBe(1);
    // A first attempt has no previous attempt to measure from, so the whole
    // thread is read: that is where a restarted ticket's own history lives, and
    // where another agent's reasoning lives.
    expect(asked).toEqual([new Date(0).toISOString()]);
    expect(fixture.requests[0]?.guidance).toEqual([
      'comment by An Investigator at 2026-01-01T00:00:00.000Z: ' +
        'read docs/module-structure.md before changing anything',
    ]);
  });

  it('decides from the item as it is now, not from the pointer the search result carried', async () => {
    const workDir = await createTempDir();
    const { workspaceId, sourceRoot } = await preparedWorkspaceOnDisk(workDir);
    // The search ran while the issue still carried the pointer label, so the
    // candidate object still holds what it said then; the label has since been
    // removed, and the fresh read says the issue names no workspace. The decision
    // follows the fresh read: a new workspace, not the old one.
    const staleSearchResult = Object.assign(candidateFor('2', 'SAM1-2'), {
      pointers: [workspaceId],
    });
    const fixture = createFixture({
      workDir,
      scans: [[staleSearchResult]],
      preflight: () => Promise.resolve({ sourceRoot, baseCommit: 'base' }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary.attempted).toBe(1);
    expect(summary.passed).toBe(1);
    expect(fixture.requests[0]?.continued).toBe(false);
    expect(fixture.log.filter((entry) => entry.startsWith('workspace:'))).toEqual([
      'workspace:SAM1-2:run-1',
    ]);
    // The workspace the stale result named was left exactly as it was.
    expect((await readWorkspaceState(workDir, workspaceId))?.attempts).toEqual([]);
  });

  it('refuses a pointer label that is not a workspace id, and publishes why', async () => {
    const workDir = await createTempDir();
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('1')]],
      prepare: (candidate) => preparedFor(candidate, ['../escape']),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    expect(fixture.refusals[0]?.reason).toMatch(/not a usable workspace id/);
    expect(fixture.log).not.toContain('claim:SAM1-1');
    expect(fixture.log).not.toContain('run:SAM1-1');
    expect(existsSync(receiptFilePath(workDir, refFor('1')))).toBe(false);
    expect(existsSync(path.join(workDir, 'workspaces'))).toBe(false);
  });

  it("refuses a pointer that names another item's workspace, and publishes why", async () => {
    const workDir = await createTempDir();
    // The workspace was created for SAM1-2; the pointer label sits on SAM1-3.
    const { workspaceId, sourceRoot } = await preparedWorkspaceOnDisk(workDir);
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('3', 'SAM1-3')]],
      prepare: (candidate) => preparedFor(candidate, [workspaceId]),
      preflight: () => Promise.resolve({ sourceRoot, baseCommit: 'base' }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    const reason = fixture.refusals[0]?.reason ?? '';
    expect(reason).toContain('created for jira SAM1-2 (immutable id 2)');
    expect(reason).toContain('not for this item (jira SAM1-3 (immutable id 3)');
    expect(fixture.log).not.toContain('claim:SAM1-3');
    expect(fixture.log).not.toContain('run:SAM1-3');
  });

  it('refuses a pointer whose workspace leaves the workspaces directory, before any claim', async (context) => {
    const workDir = await createTempDir();
    const { workspaceId, sourceRoot } = await preparedWorkspaceOnDisk(workDir);
    // The id is a generated one and its name lies inside the workspaces root, but
    // the directory that name reaches is a junction to one outside it. The check
    // is the pointer decision's, so it happens before the receipt, before the
    // claim, and before any run: a scan refuses the issue and goes on.
    const outside = path.join(workDir, 'outside');
    const workspacePath = path.join(workDir, 'workspaces', workspaceId);
    await rename(workspacePath, outside);
    try {
      await symlink(outside, workspacePath, 'junction');
    } catch (cause) {
      // Junctions need no elevation on Windows; a host that cannot make one
      // cannot show what this test is about.
      if (process.platform === 'win32') {
        throw cause;
      }
      context.skip();
      return;
    }
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => preparedFor(candidate, [workspaceId]),
      preflight: () => Promise.resolve({ sourceRoot, baseCommit: 'base' }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    const reason = fixture.refusals[0]?.reason ?? '';
    expect(reason).toContain(workspaceId);
    expect(reason).toMatch(/junction or symbolic link/);
    expect(reason).toMatch(/Move the workspace's real directory/);
    expect(fixture.log).not.toContain('claim:SAM1-2');
    expect(fixture.log).not.toContain('run:SAM1-2');
    expect(existsSync(receiptFilePath(workDir, refFor('2', 'SAM1-2')))).toBe(false);
  });

  it('refuses a workspace cloned from another repository, and publishes why', async () => {
    const workDir = await createTempDir();
    const { workspaceId } = await preparedWorkspaceOnDisk(workDir);
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => preparedFor(candidate, [workspaceId]),
      // The run targets a different repository than the one the workspace was
      // cloned from; the ledger's own sourceRoot is what it is checked against.
      preflight: () => Promise.resolve({ sourceRoot: '/other/repo', baseCommit: 'base' }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    expect(fixture.refusals[0]?.reason).toMatch(/cloned from .*and this run's source repository/);
    expect(fixture.log).not.toContain('claim:SAM1-2');
    expect(fixture.log).not.toContain('run:SAM1-2');
  });

  it('refuses a ledger that records no source item identity, with manual next steps', async () => {
    const workDir = await createTempDir();
    const { workspaceId, sourceRoot } = await preparedWorkspaceOnDisk(workDir);
    // A ledger written before identities were recorded: everything a continuation
    // needs except the item the workspace belongs to.
    const ledger = await readWorkspaceState(workDir, workspaceId);
    if (ledger === null) {
      throw new Error('the fixture workspace has no ledger');
    }
    await writeFile(
      workspaceStatePath(workDir, workspaceId),
      `${JSON.stringify({
        version: 1,
        workspaceId: ledger.workspaceId,
        sourceRoot: ledger.sourceRoot,
        baseCommit: ledger.baseCommit,
        branch: ledger.branch,
        createdAt: ledger.createdAt,
        attempts: [
          {
            runId: workspaceId,
            outcome: 'failed',
            endedAt: '2026-01-01T00:00:00.000Z',
            reportPath: `/runs/${workspaceId}/result.json`,
          },
        ],
      })}\n`,
      'utf8',
    );
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => preparedFor(candidate, [workspaceId]),
      preflight: () => Promise.resolve({ sourceRoot, baseCommit: 'base' }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    const reason = fixture.refusals[0]?.reason ?? '';
    expect(reason).toContain('records no source item identity');
    expect(reason).toContain('"sourceItem"');
    expect(reason).toContain(`/runs/${workspaceId}/result.json`);
    expect(reason).toContain('never adopts or migrates');
    expect(fixture.log).not.toContain('claim:SAM1-2');
    expect(fixture.log).not.toContain('run:SAM1-2');
  });

  it('refuses a ledger this harness did not write, before any claim', async () => {
    // Neither an unsupported version nor a partially written identity is read
    // as version 1, as absence, or as anything else it is not, and nothing is
    // migrated into place: the issue is refused with the file and the reason.
    const cases: readonly {
      readonly change: (ledger: Record<string, unknown>) => unknown;
      readonly problem: string;
    }[] = [
      { change: (ledger) => ({ ...ledger, version: 2 }), problem: 'version' },
      {
        change: (ledger) => ({ ...ledger, sourceItem: { type: 'jira', scope: SCOPE } }),
        problem: 'sourceItem.id',
      },
      {
        change: (ledger) => ({
          ...ledger,
          attempts: [
            {
              runId: 'run-20260916100000-aaaaaaaa',
              outcome: 'failed',
              endedAt: 'not-a-date',
              reportPath: '/runs/run-20260916100000-aaaaaaaa/result.json',
            },
          ],
        }),
        problem: 'attempts.0.endedAt',
      },
    ];

    for (const entry of cases) {
      const workDir = await createTempDir();
      const { workspaceId, sourceRoot } = await preparedWorkspaceOnDisk(workDir);
      const ledgerPath = workspaceStatePath(workDir, workspaceId);
      const written = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, unknown>;
      await writeFile(ledgerPath, `${JSON.stringify(entry.change(written))}\n`, 'utf8');
      const fixture = createFixture({
        workDir,
        scans: [[candidateFor('2', 'SAM1-2')]],
        prepare: (candidate) => preparedFor(candidate, [workspaceId]),
        preflight: () => Promise.resolve({ sourceRoot, baseCommit: 'base' }),
      });

      const summary = await runSource(fixture.context, null);

      expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
      const reason = fixture.refusals[0]?.reason ?? '';
      expect(reason).toContain('cannot be read');
      expect(reason).toContain(ledgerPath);
      expect(reason).toContain(entry.problem);
      expect(fixture.log).not.toContain('claim:SAM1-2');
      expect(fixture.log).not.toContain('run:SAM1-2');
    }
  });

  it('refuses an attempt whose recorded end is not a usable timestamp, and continues it once it is', async () => {
    // `attempts[].endedAt` is not free-form text: a continuation hands it to the
    // source as the moment it reads comments since, and a nonblank string that is
    // not an instant would be parsed as `NaN`, which lets every old comment
    // through. Such a record is refused with the ledger file and the field,
    // before the claim, and the same workspace with a timestamp this harness
    // writes is continued normally.
    const workDir = await createTempDir();
    const { workspaceId, sourceRoot } = await preparedWorkspaceOnDisk(workDir, [
      { outcome: 'failed', reason: 'the checks after the implementation turn did not pass' },
    ]);
    const ledgerPath = workspaceStatePath(workDir, workspaceId);
    const written = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      readonly attempts: readonly Record<string, unknown>[];
    };
    const attempt = written.attempts[0];
    expect(attempt?.endedAt).toBe('2026-01-01T00:00:00.000Z');
    await writeFile(
      ledgerPath,
      `${JSON.stringify({ ...written, attempts: [{ ...attempt, endedAt: 'not-a-date' }] })}\n`,
      'utf8',
    );

    const asked: string[] = [];
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => preparedFor(candidate, [workspaceId]),
      preflight: () => Promise.resolve({ sourceRoot, baseCommit: 'base' }),
      commentsSince: (_item, since) => {
        asked.push(since);
        return [];
      },
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    const reason = fixture.refusals[0]?.reason ?? '';
    // The operator gets the ledger that could not be read and the field that is
    // wrong with it.
    expect(reason).toContain(ledgerPath);
    expect(reason).toContain('attempts.0.endedAt');
    // Nothing was read through the record: no claim, no run, no receipt, and the
    // source was never asked to compare comments against the broken end.
    expect(fixture.log).not.toContain('claim:SAM1-2');
    expect(fixture.log).not.toContain('run:SAM1-2');
    expect(fixture.log).not.toContain('comments:SAM1-2');
    expect(asked).toEqual([]);
    expect(existsSync(receiptFilePath(workDir, refFor('2', 'SAM1-2')))).toBe(false);
    // The refused workspace itself is kept: the refusal is about the ledger
    // record, and the retained clone is what the repair continues.
    expect(existsSync(path.join(workDir, 'workspaces', workspaceId))).toBe(true);

    // The same workspace, with the end this harness recorded, is continued: the
    // recorded instant is what a continuation reads the item's comments since.
    await writeFile(ledgerPath, `${JSON.stringify(written)}\n`, 'utf8');
    const repaired = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => preparedFor(candidate, [workspaceId]),
      preflight: () => Promise.resolve({ sourceRoot, baseCommit: 'base' }),
      commentsSince: (_item, since) => {
        asked.push(since);
        return [];
      },
    });

    const continued = await runSource(repaired.context, null);

    expect(continued).toMatchObject({ outcome: 'completed', attempted: 1, passed: 1, refused: 0 });
    expect(repaired.requests[0]?.continued).toBe(true);
    expect(asked).toEqual(['2026-01-01T00:00:00.000Z']);
  });
});

// ---------------------------------------------------------------------------
// The name a fresh claim would use
// ---------------------------------------------------------------------------

describe('a workspace name a fresh claim would use', () => {
  it.each(['SAM1-2', 'SAM1-2.json'])(
    'refuses a dangling link at %s before claiming the issue',
    async (entry) => {
      const workDir = await createTempDir();
      const root = path.join(workDir, 'workspaces');
      await mkdir(root, { recursive: true });
      const held = path.join(root, entry);
      const target = path.join(root, 'missing-target');
      await symlink(target, held, 'junction');
      const originalLink = await readlink(held);
      expect(existsSync(held)).toBe(false);
      const fixture = createFixture({
        workDir,
        scans: [[candidateFor('2', 'SAM1-2')]],
        prepare: (candidate) => ({
          ...preparedFor(candidate),
          preferredWorkspaceId: 'SAM1-2',
        }),
      });

      const summary = await runSource(fixture.context, null);

      expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
      expect(fixture.refusals[0]?.reason).toContain(held);
      expect(fixture.refusals[0]?.reason).toContain('move it aside');
      expect(fixture.log).not.toContain('claim:SAM1-2');
      expect(fixture.requests).toEqual([]);
      expect(existsSync(receiptFilePath(workDir, refFor('2', 'SAM1-2')))).toBe(false);
      expect(existsSync(path.join(workDir, 'runs'))).toBe(false);
      expect((await lstat(held)).isSymbolicLink()).toBe(true);
      expect(await readlink(held)).toBe(originalLink);
      expect(await readdir(root)).toEqual([entry]);
      expect(existsSync(target)).toBe(false);
    },
  );

  it('refuses a regular file at the workspace path before claiming the issue', async () => {
    const workDir = await createTempDir();
    const held = path.join(workDir, 'workspaces', 'SAM1-2');
    await mkdir(path.dirname(held), { recursive: true });
    await writeFile(held, 'retained evidence\n', 'utf8');
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => ({ ...preparedFor(candidate), preferredWorkspaceId: 'SAM1-2' }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    expect(fixture.refusals[0]?.reason).toContain(held);
    expect(fixture.log).not.toContain('claim:SAM1-2');
    expect(fixture.requests).toEqual([]);
    expect(existsSync(receiptFilePath(workDir, refFor('2', 'SAM1-2')))).toBe(false);
    expect(existsSync(path.join(workDir, 'runs'))).toBe(false);
    expect(await readFile(held, 'utf8')).toBe('retained evidence\n');
  });

  it('refuses a name whose directory is a junction out of the workspaces directory', async (context) => {
    const workDir = await createTempDir();
    const outside = await createTempDir();
    // The name the ticket key prefers is held by a directory that only looks
    // like it is inside the workspaces root: a name is never followed through a
    // junction, exactly as a pointer label is not.
    const workspacePath = path.join(workDir, 'workspaces', 'SAM1-2');
    await mkdir(path.dirname(workspacePath), { recursive: true });
    try {
      await symlink(outside, workspacePath, 'junction');
    } catch (cause) {
      // Junctions need no elevation on Windows; a host that cannot make one
      // cannot show what this test is about.
      if (process.platform === 'win32') {
        throw cause;
      }
      context.skip();
      return;
    }
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => ({
        ...preparedFor(candidate),
        preferredWorkspaceId: 'SAM1-2',
      }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    const reason = fixture.refusals[0]?.reason ?? '';
    expect(reason).toContain('SAM1-2');
    expect(reason).toMatch(/junction or symbolic link/);
    expect(reason).toMatch(/Move the workspace's real directory/);
    expect(fixture.log).not.toContain('claim:SAM1-2');
    expect(fixture.log).not.toContain('run:SAM1-2');
    expect(existsSync(receiptFilePath(workDir, refFor('2', 'SAM1-2')))).toBe(false);
  });

  it('refuses a name a ledger holds without a directory, and creates nothing', async () => {
    const workDir = await createTempDir();
    // A ledger without its clone: no attempt may write over the record, and no
    // directory is created for the run that would have used the name.
    await mkdir(path.join(workDir, 'workspaces'), { recursive: true });
    await writeFile(workspaceStatePath(workDir, 'SAM1-2'), '{"version":1}\n', 'utf8');
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => ({
        ...preparedFor(candidate),
        preferredWorkspaceId: 'SAM1-2',
      }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    const reason = fixture.refusals[0]?.reason ?? '';
    expect(reason).toContain('a ledger at');
    expect(reason).toMatch(/is not one this harness wrote/);
    expect(await readFile(workspaceStatePath(workDir, 'SAM1-2'), 'utf8')).toBe('{"version":1}\n');
    expect(existsSync(path.join(workDir, 'runs'))).toBe(false);
    expect(fixture.log).not.toContain('claim:SAM1-2');
    expect(fixture.log).not.toContain('run:SAM1-2');
  });

  it('leaves a held name alone and the item refused, without a run', async () => {
    const workDir = await createTempDir();
    const held = path.join(workDir, 'workspaces', 'SAM1-2');
    await mkdir(held, { recursive: true });
    await writeFile(path.join(held, 'PRIVATE.txt'), 'someone else\n', 'utf8');
    const fixture = createFixture({
      workDir,
      scans: [[candidateFor('2', 'SAM1-2')]],
      prepare: (candidate) => ({
        ...preparedFor(candidate),
        preferredWorkspaceId: 'SAM1-2',
      }),
    });

    const summary = await runSource(fixture.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    expect(fixture.refusals[0]?.reason).toMatch(/no ledger/);
    expect(await readFile(path.join(held, 'PRIVATE.txt'), 'utf8')).toBe('someone else\n');
    expect(existsSync(path.join(workDir, 'runs'))).toBe(false);
    expect(fixture.requests).toEqual([]);
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
    const continued = candidateFor('4', 'SAM1-4');
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
        // The item the workspace was created for: the preview checks this before
        // it says the issue can be continued.
        sourceItem: sourceItemFor(refFor('4', 'SAM1-4')),
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
        if (candidate.ref.id === '3') {
          return null;
        }
        return preparedFor(candidate, candidate.ref.id === '4' ? [workspaceId] : []);
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
      expect(existsSync(intakeLockPath(workDir, FIXTURE_LOCK_NAMESPACE))).toBe(false);
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
          return preparedFor(candidate);
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
      expect(existsSync(intakeLockPath(workDir, FIXTURE_LOCK_NAMESPACE))).toBe(false);
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
  /** The display key; a site can rename an issue, and its id stays the same. */
  key: string;
  readonly summary: string;
  status: string;
  updated: string;
  /** The labels the site holds; the queue label is added when the site is built. */
  labels?: string[];
}

interface FakeJira {
  readonly fetch: typeof fetch;
  readonly calls: Array<{ method: string; url: string; body: unknown }>;
  readonly comments: string[];
  /** The issue thread as the site holds it: what the harness posted, plus seeds. */
  readonly thread: Array<{
    readonly id: string;
    readonly author: { readonly displayName: string };
    readonly created: string;
    readonly body: unknown;
  }>;
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
  const thread: FakeJira['thread'] = [];
  const transitionsFrom = (status: string): Array<Record<string, unknown>> => {
    if (status === 'To Do') {
      // Both the claim and the refusal move an issue out of the ready status: a
      // refusal publishes its reason and takes the issue straight to review.
      return [
        { id: '11', name: 'Start work', to: { name: 'In Progress' } },
        { id: '21', name: 'Take out of the queue', to: { name: 'In Review' } },
      ];
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

  /** The labels the site holds for one issue; every issue carries the queue label. */
  const labelsOf = (issue: FakeIssue): string[] => {
    issue.labels ??= ['harness-task'];
    return issue.labels;
  };

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
            labels: labelsOf(issue),
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
      if (method === 'GET') {
        // The connector reads the issue's thread before every attempt; what this
        // site holds is what the harness itself posted, in order.
        return jsonResponse({ comments: thread, total: thread.length });
      }
      comments.push(JSON.stringify(body?.['body']));
      const id = `comment-${String(comments.length)}`;
      thread.push({
        id,
        author: { displayName: 'Harness' },
        // Stamped on this process's own clock, one second apart, so the moment a
        // comment was posted is later than the ledger entry of the attempt that
        // ended just before it: a later attempt asking for what was added since
        // then really sees the harness's own comment for the attempt before it.
        created: new Date(Date.now() + thread.length * 1000).toISOString(),
        body: body?.['body'] ?? null,
      });
      return jsonResponse({ id });
    }
    if (issueMatch !== null && method === 'PUT' && issue !== undefined) {
      // The only write the connector makes to an issue is the pointer label.
      const update = body?.['update'] as { labels?: Array<{ add?: string }> } | undefined;
      for (const change of update?.labels ?? []) {
        const add = change.add;
        if (typeof add === 'string' && !labelsOf(issue).includes(add)) {
          labelsOf(issue).push(add);
        }
      }
      return new Response(null, { status: 204 });
    }
    if (issue !== undefined) {
      return jsonResponse({
        id: issue.id,
        key: issue.key,
        fields: {
          summary: issue.summary,
          description: jiraDocument(),
          status: { name: issue.status },
          labels: labelsOf(issue),
          project: { key: 'SAM1' },
          issuetype: { name: 'Task' },
          updated: issue.updated,
        },
      });
    }
    return jsonResponse({ errorMessages: ['not found'] }, 404);
  };

  return { fetch: impl as unknown as typeof fetch, calls, comments, thread, issues };
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
async function createTarget(
  options: {
    readonly delivery?: boolean;
    /** Commit a check that is green until the marker file holds anything else. */
    readonly markerCheck?: boolean;
    /** The escalation ladder the configuration declares, when a test wants one. */
    readonly escalation?: readonly EscalationTier[];
    /** The intake order the source configuration selects; the default when omitted. */
    readonly ordering?: 'priority' | 'rank';
  } = {},
): Promise<{
  directory: string;
  repo: string;
  configPath: string;
  workDir: string;
}> {
  const directory = await createTempDir();
  const repo = path.join(directory, 'target-project');
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, 'README.md'), '# target\n', 'utf8');
  if (options.markerCheck === true) {
    await mkdir(path.join(repo, 'tools'), { recursive: true });
    await writeFile(path.join(repo, 'tools', 'check.mjs'), MARKER_CHECK_SOURCE, 'utf8');
  }
  // The connected project's own configuration is committed with it: its Jira
  // queue, its check, and — when a test asks for one — its GitHub destination.
  await writeJsonFile(repo, PROJECT_CONFIG_FILE_NAME, {
    setup: [],
    checks:
      options.markerCheck === true
        ? [[process.execPath, 'tools/check.mjs']]
        : [[process.execPath, '-e', 'process.exit(0)']],
    source: {
      type: 'jira',
      siteUrl: SCOPE,
      cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
      projectKey: 'SAM1',
      ...(options.ordering === undefined ? {} : { ordering: options.ordering }),
      pollIntervalSeconds: 5,
      tokenEnv: 'JIRA_API_TOKEN',
    },
    ...(options.delivery === true
      ? {
          delivery: {
            type: 'github',
            repository: 'example-owner/example-repo',
            baseBranch: 'main',
          },
        }
      : {}),
  });
  await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
  await gitOrFail(['add', '--all'], repo);
  await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);

  const configPath = await writeJsonFile(directory, HARNESS_CONFIG_FILE_NAME, {
    ...documentedHarnessConfig,
    workDir: './runs',
    maxRepairs: 1,
    ...(options.escalation === undefined ? {} : { escalation: options.escalation }),
  });

  return { directory, repo, configPath, workDir: path.join(directory, 'runs') };
}

/**
 * The check a ladder test's project runs: no marker file is the feature not
 * implemented yet, which is what makes the committed baseline green; the awaited
 * text is the feature done; anything else is a real failed check, in the
 * project's own runner.
 */
const MARKER_CHECK_SOURCE = [
  "import { existsSync, readFileSync } from 'node:fs';",
  '',
  "if (!existsSync('MARKER.md')) {",
  "  console.log('marker: skipped, the feature is not implemented in this working copy');",
  '} else {',
  "  const text = readFileSync('MARKER.md', 'utf8').trim();",
  "  if (text === 'done') {",
  "    console.log('marker: ok');",
  '  } else {',
  '    console.log(`marker: wrong, it holds ${JSON.stringify(text)}`);',
  '    process.exitCode = 1;',
  '  }',
  '}',
  '',
].join('\n');

/**
 * A disposable destination for the delivery step: a bare repository the branch
 * can really be pushed into, and the stand-in `gh` the pull request commands
 * resolve to.
 */
async function createDeliveryDestination(directory: string): Promise<{
  readonly remote: string;
  readonly bin: string;
  readonly state: FakeGhState;
}> {
  const remote = path.join(directory, 'delivery-origin.git');
  await gitOrFail(['init', '--quiet', '--bare', remote], directory);
  const { bin, state } = await installFakeGh(directory);
  return { remote, bin, state };
}

/**
 * Runs `body` with the stand-in `gh` first on this process's own `PATH` and told
 * which state directory it keeps. The CLI builds both the child environment and
 * (on Windows) its own executable resolution from this process, so a suite that
 * wants the stand-in has to put it there and take it away again.
 */
async function withFakeGhOnPath<T>(
  bin: string,
  state: FakeGhState,
  body: () => Promise<T>,
): Promise<T> {
  const previousPath = process.env.PATH;
  const previousConfig = process.env.FAKE_GH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  process.env.FAKE_GH = JSON.stringify({ stateDir: state.dir });
  try {
    return await body();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousConfig === undefined) {
      delete process.env.FAKE_GH;
    } else {
      process.env.FAKE_GH = previousConfig;
    }
  }
}

/**
 * Runs `body` with the stand-in `codex` first on this process's own `PATH` and
 * told which plans its turns follow. The CLI builds both the child environment
 * and (on Windows) its own executable resolution from this process, so a suite
 * that wants the stand-in has to put it there and take it away again.
 */
async function withFakeRuntimeOnPath<T>(
  bin: string,
  state: { readonly dir: string },
  plans: readonly FakePlan[],
  body: () => Promise<T>,
): Promise<T> {
  const previousPath = process.env.PATH;
  const previousConfig = process.env.FAKE_CODEX;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  process.env.FAKE_CODEX = JSON.stringify({ stateDir: state.dir, plans });
  try {
    return await body();
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousConfig === undefined) {
      delete process.env.FAKE_CODEX;
    } else {
      process.env.FAKE_CODEX = previousConfig;
    }
  }
}

/** The single run directory one source batch left under a target's output. */
async function onlyRunDirectory(workDir: string): Promise<string> {
  const runs = (await readdir(path.join(workDir, 'runs'))).filter((name) =>
    name.startsWith('run-'),
  );
  expect(runs).toHaveLength(1);
  return path.join(workDir, 'runs', runs[0] ?? '');
}

/**
 * Every run's report one target's output holds, oldest attempt first. The
 * report itself says which attempt of its workspace it was, and that is what
 * orders them: a run ID carries a second-resolution timestamp plus random bits,
 * so two runs of one intake can share a second and sorting their directory
 * names is not the order the attempts happened in. The workspace a report names
 * is likewise read from the report, never guessed from the directories beside
 * it.
 */
async function reportsByAttempt(workDir: string): Promise<readonly RunReport[]> {
  const runsRoot = path.join(workDir, 'runs');
  const reports = await Promise.all(
    (await readdir(runsRoot))
      .filter((name) => name.startsWith('run-'))
      .map(
        async (name) =>
          JSON.parse(await readFile(path.join(runsRoot, name, 'result.json'), 'utf8')) as RunReport,
      ),
  );
  return reports.sort(
    (left, right) => (left.workspace.attempt ?? 0) - (right.workspace.attempt ?? 0),
  );
}

interface CliOptions {
  readonly fetch: typeof fetch;
  readonly signals?: InterruptSignals;
  readonly dependencies?: CliContext['dependencies'];
  readonly deliveryParts?: CliContext['deliveryParts'];
  /** An interactive terminal for the CLI to write to, instead of plain output. */
  readonly terminal?: CliContext['io']['terminal'];
  /** Called for every line the command prints, while it is printing. */
  readonly onOut?: (text: string) => void;
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
    io: {
      out: (text) => {
        out.push(text);
        options.onOut?.(text);
      },
      err: (text) => err.push(text),
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    },
    fetch: options.fetch,
  };
  if (options.signals !== undefined) {
    context.signals = options.signals;
  }
  if (options.dependencies !== undefined) {
    context.dependencies = options.dependencies;
  }
  if (options.deliveryParts !== undefined) {
    context.deliveryParts = options.deliveryParts;
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
        ['source', 'list', '--config', target.configPath, '--project', target.repo],
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

  it('draws a source run’s activity in the pane, and leaves the summary behind it', async () => {
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
          request.onActivity?.({ kind: 'message', text: 'writing the marker' });
          request.onActivity?.({ kind: 'change', text: 'add MARKER.md' });
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker' };
        },
      };
      const console = fakeConsole({ columns: 80, rows: 24 });

      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies, terminal: console.io.terminal },
      );

      expect(result.code).toBe(EXIT_OK);
      // The same pane the file-task command draws: what the turn reported was
      // drawn while it ran, by cursor moves over a bounded block.
      const raw = console.chunks.join('');
      expect(raw).toContain('agent: writing the marker');
      expect(raw).toContain('change: add MARKER.md');
      expect(raw).toContain('\u001b[');

      // And the batch's own summary is ordinary output, printed after the turn's
      // pane was finalized: the pane's boundary and rows stay in the timeline,
      // in order, above the batch's own lines.
      const screen = screenAfter(console.chunks);
      const shown = screen.join('\n');
      expect(shown).toMatch(
        /\d{2}:\d{2}:\d{2} ---- developer: SAM1-11 — implementation turn ----\n\d{2}:\d{2}:\d{2} agent: writing the marker\n\d{2}:\d{2}:\d{2} change: add MARKER\.md\n\d{2}:\d{2}:\d{2} implementation turn result: completed/,
      );
      // What the reservation said on the live terminal is the key and the act;
      // its receipt path and immutable ID stay in the run's own evidence.
      expect(screen.some((line) => line.endsWith(' SAM1-11: reserved; claiming'))).toBe(true);
      expect(shown).not.toContain('receipts');
      expect(shown).toMatch(/^\d{2}:\d{2}:\d{2} source completed$/m);
      expect(screen.at(-1)).toMatch(/^\d{2}:\d{2}:\d{2}\s{2,}skipped /);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('continues the workspace its pointer names when the issue is moved back, in the same clone', async () => {
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
      expect(first.code).toBe(EXIT_OK);
      const runNames = (): Promise<string[]> =>
        readdir(path.join(target.workDir, 'runs')).then((names) =>
          names.filter((name) => name.startsWith('run-')),
        );
      const [firstRun] = await runNames();

      // The run that created the workspace named it after the ticket key, so
      // retained work is recognizable without reading a label or a report, and
      // wrote the pointer label the next attempt is found by. A continuation
      // adds no second directory beside it.
      const workspaceId = 'SAM1-11';
      expect(workspaceId).toBe(jira.issues[0]?.key);
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json'),
        ),
      ).toEqual([workspaceId]);
      const ledgerPath = path.join(target.workDir, 'workspaces', `${workspaceId}.json`);
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
        workspaceId?: string;
        branch?: string;
        sourceItem?: unknown;
      };
      expect(ledger.workspaceId).toBe(workspaceId);
      expect(ledger.branch).toBe(`harness/${workspaceId}`);
      expect(ledger.sourceItem).toEqual({
        type: 'jira',
        scope: SCOPE,
        id: '10011',
        key: 'SAM1-11',
      });
      expect(jira.issues[0]?.labels).toContain(`harness-ws-${workspaceId}`);

      // The operator moves the issue back to the ready status; the pointer label
      // is still on it, so the next scan continues that clone.
      if (jira.issues[0] === undefined) {
        throw new Error('the fixture issue disappeared');
      }
      jira.issues[0].status = 'To Do';
      const second = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(second.err).toBe('');
      expect(second.code).toBe(EXIT_OK);
      expect(second.out).toContain('1 passed');
      const secondRun = (await runNames()).find((name) => name !== firstRun);
      expect(secondRun).toBeDefined();
      const report = JSON.parse(
        await readFile(
          path.join(target.workDir, 'runs', `${secondRun ?? ''}`, 'result.json'),
          'utf8',
        ),
      ) as {
        status: string;
        workspace: { workspaceId: string; continued: boolean; attempt: number };
      };
      expect(report.status).toBe('passed');
      expect(report.workspace).toMatchObject({
        workspaceId,
        continued: true,
        attempt: 2,
      });
      // The same clone: the file the first attempt left is still there, and the
      // continuation wrote no second pointer label and created no second
      // directory for the same ticket.
      expect(existsSync(path.join(target.workDir, 'workspaces', workspaceId, 'MARKER.md'))).toBe(
        true,
      );
      expect(
        (jira.issues[0].labels ?? []).filter((label) => label.startsWith('harness-ws-')),
      ).toEqual([`harness-ws-${workspaceId}`]);
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json'),
        ),
      ).toEqual([workspaceId]);
      const after = JSON.parse(await readFile(ledgerPath, 'utf8')) as { attempts?: unknown[] };
      expect(after.attempts).toHaveLength(2);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('names a new workspace after its ticket key, and points the next attempt at it', async () => {
    const target = await createTarget();
    const jira = fakeJira([
      {
        id: '10023',
        key: 'SAM1-23',
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
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      // The ticket key is what a person sees: the terminal names the workspace
      // it prepared, and the retained directory is named after the ticket.
      expect(result.out).toContain('SAM1-23');
      expect(result.out).toContain('harness/SAM1-23');
      const workspacePath = path.join(target.workDir, 'workspaces', 'SAM1-23');
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json'),
        ),
      ).toEqual(['SAM1-23']);
      // The attempt's own evidence keeps its generated run id, beside the
      // workspace rather than in its name.
      const runs = await readdir(path.join(target.workDir, 'runs'));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatch(/^run-/);
      const report = JSON.parse(
        await readFile(path.join(target.workDir, 'runs', runs[0] ?? '', 'result.json'), 'utf8'),
      ) as RunReport;
      expect(report.workspace).toMatchObject({
        workspaceId: 'SAM1-23',
        path: workspacePath,
        branch: 'harness/SAM1-23',
        continued: false,
        attempt: 1,
      });
      // The clone really is on the branch its id names.
      expect(
        (
          await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], workspacePath)
        ).stdout.trim(),
      ).toBe('harness/SAM1-23');
      // The pointer label names the same workspace, through the one mechanism
      // that already recorded it, and the ledger keeps the immutable issue id as
      // the ownership authority.
      expect(jira.issues[0]?.labels).toContain('harness-ws-SAM1-23');
      const ledger = await readWorkspaceState(target.workDir, 'SAM1-23');
      expect(ledger?.sourceItem).toEqual({
        type: 'jira',
        scope: SCOPE,
        id: '10023',
        key: 'SAM1-23',
      });
      expect(ledger?.branch).toBe('harness/SAM1-23');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('keeps the pointer-owned workspace when the ticket key changes under it', async () => {
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
      expect(first.code).toBe(EXIT_OK);
      expect(jira.issues[0]?.labels).toContain('harness-ws-SAM1-11');

      // The site renames the ticket. Its immutable id — the ownership authority —
      // does not change, and the pointer label still names the workspace the work
      // lives in.
      if (jira.issues[0] === undefined) {
        throw new Error('the fixture issue disappeared');
      }
      jira.issues[0].key = 'SAM1-99';
      jira.issues[0].updated = '2026-09-17T11:00:00.000Z';
      jira.issues[0].status = 'To Do';
      const second = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(second.err).toBe('');
      expect(second.code).toBe(EXIT_OK);
      expect(second.out).toContain('1 passed');
      // The exact directory the pointer names was reopened: the new key names
      // nothing, and nothing was renamed to it.
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json'),
        ),
      ).toEqual(['SAM1-11']);
      expect(existsSync(path.join(target.workDir, 'workspaces', 'SAM1-99'))).toBe(false);
      const reports = await reportsByAttempt(target.workDir);
      expect(reports).toHaveLength(2);
      expect(reports[1]?.workspace).toMatchObject({
        workspaceId: 'SAM1-11',
        branch: 'harness/SAM1-11',
        continued: true,
        attempt: 2,
      });
      // The ledger keeps the identity it recorded when the workspace was made:
      // the display key is not rewritten, and the immutable id still matches.
      const ledger = await readWorkspaceState(target.workDir, 'SAM1-11');
      expect(ledger?.sourceItem).toEqual({
        type: 'jira',
        scope: SCOPE,
        id: '10011',
        key: 'SAM1-11',
      });
      expect(
        (jira.issues[0].labels ?? []).filter((label) => label.startsWith('harness-ws-')),
      ).toEqual(['harness-ws-SAM1-11']);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('continues a run-* workspace its legacy pointer names, unchanged', async () => {
    const target = await createTarget();
    const legacyId = 'run-20260916100000-abcdef12';
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
        // The pointer an earlier, generated-name attempt wrote: it still decides
        // where this ticket's work lives.
        labels: ['harness-task', `harness-ws-${legacyId}`],
      },
    ]);
    // The workspace such an attempt left: the clone on its own branch, and the
    // ledger beside it recording that attempt.
    const source = await preflightSource({ repoPath: target.repo, workDir: target.workDir });
    const legacy = await prepareWorkspace(
      await allocateRunDirectory(target.workDir, {
        kind: 'create',
        preferredWorkspaceId: legacyId,
      }),
      source,
      { deadlineMs: Date.now() + 60_000, now: () => new Date() },
      sourceItemFor(refFor('10011', 'SAM1-11')),
    );
    await recordWorkspaceAttempt(target.workDir, legacyId, {
      runId: legacyId,
      outcome: 'failed',
      reason: 'the earlier attempt ended failed',
      endedAt: '2026-09-16T10:30:00.000Z',
      reportPath: path.join(target.workDir, 'runs', legacyId, 'result.json'),
    });
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker' };
        },
      };
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      // The legacy pointer reopened the exact directory it names; no workspace
      // was created for the ticket key, and nothing was migrated or renamed.
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json'),
        ),
      ).toEqual([legacyId]);
      expect(existsSync(path.join(target.workDir, 'workspaces', 'SAM1-11'))).toBe(false);
      // The one run of this intake wrote a report; the run directory the
      // fixture's own setup allocated kept none.
      const runNames = await readdir(path.join(target.workDir, 'runs'));
      const reportName = runNames.find((name) =>
        existsSync(path.join(target.workDir, 'runs', name, 'result.json')),
      );
      const report = JSON.parse(
        await readFile(path.join(target.workDir, 'runs', reportName ?? '', 'result.json'), 'utf8'),
      ) as RunReport;
      expect(report.workspace).toMatchObject({
        workspaceId: legacyId,
        path: legacy.workspacePath,
        branch: `harness/${legacyId}`,
        continued: true,
        attempt: 2,
      });
      expect(await readFile(path.join(legacy.workspacePath, 'MARKER.md'), 'utf8')).toBe('done\n');
      expect(
        (jira.issues[0]?.labels ?? []).filter((label) => label.startsWith('harness-ws-')),
      ).toEqual([`harness-ws-${legacyId}`]);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  /**
   * The workspace a name already holds, as an earlier attempt or an operator
   * would leave it: the directory with a file in it, and — when the test asks for
   * one — the ledger beside it recording whose work it is. What a fresh claim
   * finds when the name its ticket key prefers is already taken.
   */
  async function plantWorkspace(
    workDir: string,
    workspaceId: string,
    ledger:
      | {
          readonly kind: 'yes';
          readonly sourceRoot: string;
          readonly sourceItem: unknown;
        }
      | { readonly kind: 'no' },
  ): Promise<{ readonly workspacePath: string; readonly ledgerPath: string }> {
    const workspacePath = path.join(workDir, 'workspaces', workspaceId);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, 'PRIVATE.txt'), 'earlier work\n', 'utf8');
    const ledgerPath = workspaceStatePath(workDir, workspaceId);
    if (ledger.kind === 'yes') {
      await writeFile(
        ledgerPath,
        `${JSON.stringify({
          version: 1,
          workspaceId,
          sourceRoot: ledger.sourceRoot,
          baseCommit: 'a'.repeat(40),
          branch: `harness/${workspaceId}`,
          createdAt: '2026-09-16T10:00:00.000Z',
          sourceItem: ledger.sourceItem,
          attempts: [],
        })}\n`,
        'utf8',
      );
    }
    return { workspacePath, ledgerPath };
  }

  /** What a planted workspace holds, so a test can prove a refusal touched nothing. */
  async function snapshotPlantedWorkspace(planted: {
    readonly workspacePath: string;
    readonly ledgerPath: string;
  }): Promise<{ readonly file: string; readonly ledger: string | null }> {
    return {
      file: await readFile(path.join(planted.workspacePath, 'PRIVATE.txt'), 'utf8'),
      ledger: existsSync(planted.ledgerPath) ? await readFile(planted.ledgerPath, 'utf8') : null,
    };
  }

  /** A coding turn a refusal must never reach: the item is not claimed at all. */
  const refusedTurn: CliContext['dependencies'] = {
    runAgentTurn: async () => {
      throw new Error('a refused item must not start a coding turn');
    },
  };

  it("refuses a fresh ticket whose key names another item's workspace, and touches nothing", async () => {
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
    const source = await preflightSource({ repoPath: target.repo, workDir: target.workDir });
    const planted = await plantWorkspace(target.workDir, 'SAM1-11', {
      kind: 'yes',
      sourceRoot: source.sourceRoot,
      sourceItem: sourceItemFor(refFor('10099', 'SAM1-99')),
    });
    const before = await snapshotPlantedWorkspace(planted);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        {
          fetch: jira.fetch,
          dependencies: refusedTurn,
        },
      );

      // The refusal is reported on the terminal as well as in the issue's own
      // comment, and intake goes on with nothing claimed.
      expect(result.err).toContain('SAM1-11: refused');
      expect(result.err).toContain('never overwrites');
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('1 refused');
      // The issue is told why, and what an operator can do about it.
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(1);
      const refusal = jira.comments[0] ?? '';
      expect(refusal).toContain('SAM1-11');
      expect(refusal).toContain('SAM1-99');
      expect(refusal).toContain('never overwrites');
      expect(refusal).toContain('move it aside');
      // Nothing was claimed, no run was created, no pointer label was written,
      // and the other item's workspace is exactly as it was.
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(await snapshotPlantedWorkspace(planted)).toEqual(before);
      expect(jira.issues[0]?.labels).toEqual(['harness-task']);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('refuses a fresh ticket whose key names a directory with no ledger', async () => {
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
    const planted = await plantWorkspace(target.workDir, 'SAM1-11', { kind: 'no' });
    const before = await snapshotPlantedWorkspace(planted);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies: refusedTurn },
      );

      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('1 refused');
      expect(jira.issues[0]?.status).toBe('In Review');
      const refusal = jira.comments[0] ?? '';
      // Missing trustworthy ownership: the harness cannot tell whose work it is,
      // so it neither adopts it nor overwrites it, and says how to proceed.
      expect(refusal).toContain('no ledger');
      expect(refusal).toContain('harness-ws-SAM1-11');
      expect(refusal).toContain('move it aside');
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(await snapshotPlantedWorkspace(planted)).toEqual(before);
      expect(existsSync(planted.ledgerPath)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('refuses a fresh ticket whose key names a ledger with no item identity', async () => {
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
    const source = await preflightSource({ repoPath: target.repo, workDir: target.workDir });
    const planted = await plantWorkspace(target.workDir, 'SAM1-11', {
      kind: 'yes',
      sourceRoot: source.sourceRoot,
      sourceItem: null,
    });
    const before = await snapshotPlantedWorkspace(planted);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies: refusedTurn },
      );

      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('1 refused');
      const refusal = jira.comments[0] ?? '';
      expect(refusal).toContain('no source item identity');
      expect(refusal).toContain('never adopts or migrates a workspace on its own');
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(await snapshotPlantedWorkspace(planted)).toEqual(before);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it("refuses to adopt a fresh ticket's own workspace, with no pointer saying so", async () => {
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
    const source = await preflightSource({ repoPath: target.repo, workDir: target.workDir });
    const planted = await plantWorkspace(target.workDir, 'SAM1-11', {
      kind: 'yes',
      sourceRoot: source.sourceRoot,
      sourceItem: sourceItemFor(refFor('10011', 'SAM1-11')),
    });
    const before = await snapshotPlantedWorkspace(planted);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: jira.fetch, dependencies: refusedTurn },
      );

      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('1 refused');
      const refusal = jira.comments[0] ?? '';
      // The workspace is this item's, but nothing points at it: adoption is the
      // operator's deliberate step, and the refusal names the exact label.
      expect(refusal).toContain('its ledger records that it is this item');
      expect(refusal).toContain('never adopts a workspace on its own');
      expect(refusal).toContain('harness-ws-SAM1-11');
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(await snapshotPlantedWorkspace(planted)).toEqual(before);
      expect(jira.issues[0]?.labels).toEqual(['harness-task']);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('runs one attempt per ladder tier in the same workspace, keeping the issue running until the end', async () => {
    const ladder: readonly EscalationTier[] = [
      {
        name: 'flash',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-flash', '--model', 'deepseek-flash'],
        },
        // The requested Flash allowance: an implementation turn plus two
        // repairs. The first rung spends all three of its own turns before the
        // ladder climbs.
        maxRepairs: 2,
      },
      {
        name: 'astra',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-astra', '--model', 'gpt-6-astra'],
        },
        maxRepairs: 2,
      },
    ];
    const target = await createTarget({ markerCheck: true, escalation: ladder });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Write the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const runtime = await installFakeRuntime(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';
    /** The issue's status as the climb moved on, read while the ladder was running. */
    const statusWhenEscalating: string[] = [];

    try {
      const result = await withFakeRuntimeOnPath(
        runtime.bin,
        runtime.state,
        [
          // The flash attempt: an implementation turn and both repair turns its
          // allowance allows, every round red, so the allowance is spent on
          // ordinary failed checks and the ladder climbs. The notes file is work
          // nothing later touches, so the stronger attempt really inherits the
          // weaker one's dirty working copy.
          {
            edits: [
              { file: 'MARKER.md', text: 'not yet\n' },
              { file: 'NOTES.md', text: 'flash was here\n' },
            ],
            summary: 'flash: first try',
          },
          {
            edits: [{ file: 'MARKER.md', text: 'not yet\n' }],
            summary: 'flash: first repair, still wrong',
          },
          {
            edits: [{ file: 'MARKER.md', text: 'not yet\n' }],
            summary: 'flash: second repair, still wrong',
          },
          // The astra attempt continues the same clone and finishes it.
          { edits: [{ file: 'MARKER.md', text: 'done\n' }], summary: 'astra: finished the marker' },
        ],
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              onOut: (text) => {
                if (text.includes('escalating to tier')) {
                  statusWhenEscalating.push(jira.issues[0]?.status ?? 'gone');
                }
              },
            },
          ),
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      expect(result.out).toContain('source completed');
      expect(result.out).toContain('1 passed');
      // The tier each attempt reports is the launch that ran it: flash's
      // implementation and both repairs, then astra.
      expect(result.out).toContain('(attempt 1 of 2, tier flash)');
      expect(result.out).toContain('escalating to tier astra (attempt 2 of 2)');
      expect(result.out).toContain('(attempt 2 of 2, tier astra)');

      // Four real runtime invocations: flash's implementation and its two
      // allowed repairs, then astra's implementation. What was really launched
      // is the tier's own prefix, and it is the prefix each run's report records
      // — every attempt, the continuation included.
      const turns = await fakeTurns(runtime.state);
      expect(turns).toHaveLength(4);
      const flashPrefix = ['--profile', 'nexus-flash', '--model', 'deepseek-flash'];
      const astraPrefix = ['--profile', 'nexus-astra', '--model', 'gpt-6-astra'];
      expect(turns[0]?.argv.slice(0, flashPrefix.length)).toEqual(flashPrefix);
      expect(turns[1]?.argv.slice(0, flashPrefix.length)).toEqual(flashPrefix);
      expect(turns[2]?.argv.slice(0, flashPrefix.length)).toEqual(flashPrefix);
      expect(turns[3]?.argv.slice(0, astraPrefix.length)).toEqual(astraPrefix);
      expect(turns[3]?.argv.slice(astraPrefix.length)).toEqual([
        '--ask-for-approval',
        'never',
        'exec',
        '--sandbox',
        'danger-full-access',
        '--json',
        '-',
      ]);

      // Each attempt is its own run with its own report: the launch that ran it,
      // and the repair turns its own allowance let it spend. The reports are
      // ordered by the attempt each one records, and the workspace is read from
      // the report rather than from the directory listing: a continuation's own
      // run allocates a workspace directory the run never uses.
      const reports = await reportsByAttempt(target.workDir);
      expect(reports).toHaveLength(2);
      const [flash, astra] = reports;
      expect(flash?.status).toBe('failed');
      expect(flash?.repairsUsed).toBe(2);
      expect(flash?.agent.command).toEqual([
        'codex',
        '--profile',
        'nexus-flash',
        '--model',
        'deepseek-flash',
      ]);
      expect(astra?.status).toBe('passed');
      expect(astra?.repairsUsed).toBe(0);
      expect(astra?.agent.command).toEqual([
        'codex',
        '--profile',
        'nexus-astra',
        '--model',
        'gpt-6-astra',
      ]);
      expect(astra?.workspace.continued).toBe(true);
      expect(astra?.workspace.attempt).toBe(2);
      expect(reports.map((report) => report.workspace.attempt)).toEqual([1, 2]);
      // One workspace holds both attempts, named after the ticket key: the
      // continuation adds no directory of its own beside the clone it reopened.
      expect(
        (await readdir(path.join(target.workDir, 'workspaces'))).filter(
          (name) => !name.endsWith('.json'),
        ),
      ).toEqual(['SAM1-11']);
      // The pointer label records the workspace the reports name, and every turn
      // really worked in it.
      const workspaceId = astra?.workspace.workspaceId ?? '';
      const workspacePath = astra?.workspace.path ?? '';
      expect(workspaceId).toBe('SAM1-11');
      expect(flash?.workspace.workspaceId).toBe(workspaceId);
      expect(
        (jira.issues[0]?.labels ?? []).filter((label) => label.startsWith('harness-ws-')),
      ).toEqual([`harness-ws-${workspaceId}`]);
      expect(new Set(turns.map((turn) => turn.cwd))).toEqual(new Set([workspacePath]));
      // The workspace the flash attempt left is the one astra worked in: the file
      // nobody touched afterwards is still there, and astra's own report sees it
      // as part of the whole diff against the recorded base.
      expect(existsSync(path.join(workspacePath, 'NOTES.md'))).toBe(true);
      expect(astra?.changes.paths.map((entry) => entry.path)).toContain('NOTES.md');
      // Both attempts are recorded against that one workspace's ledger, with the
      // tier that ran each of them.
      const ladderLedger = JSON.parse(
        await readFile(path.join(target.workDir, 'workspaces', `${workspaceId}.json`), 'utf8'),
      ) as { attempts?: Array<{ tier?: string; outcome?: string }> };
      expect(ladderLedger.attempts?.map((attempt) => [attempt.tier, attempt.outcome])).toEqual([
        ['flash', 'failed'],
        ['astra', 'passed'],
      ]);

      // The stronger attempt is told what the weaker one did — its ledger line,
      // and the comment the harness published for it before the next rung ran.
      const strongerPrompt = turns[3]?.prompt ?? '';
      expect(strongerPrompt).toContain('attempt 1 (tier flash) failed');
      expect(strongerPrompt).toContain('comment by Harness');
      expect(strongerPrompt).toContain('finished: failed');

      // Jira: one comment per attempt, the issue still in the running status when
      // the climb moved on, and exactly one move to review, after both comments.
      expect(statusWhenEscalating).toEqual(['In Progress']);
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(2);
      expect(jira.comments[0]).toContain('finished: failed');
      expect(jira.comments[0]).toContain('Attempt 1 of 2 (tier flash)');
      // The flash comment names the repair allowance the first rung really spent.
      expect(jira.comments[0]).toContain('Repairs used: 2');
      expect(jira.comments[0]).toContain('still climbing its escalation ladder');
      expect(jira.comments[1]).toContain('finished: passed');
      expect(jira.comments[1]).toContain('Attempt 2 of 2 (tier astra)');
      const transitions = jira.calls.filter(
        (call) => call.method === 'POST' && call.url.includes('/transitions'),
      );
      expect(transitions).toHaveLength(2);
      expect(transitions[0]?.body).toMatchObject({ transition: { id: '11' } });
      expect(transitions[1]?.body).toMatchObject({ transition: { id: '31' } });
      const lastTransition = jira.calls.findLastIndex(
        (call) => call.method === 'POST' && call.url.includes('/transitions'),
      );
      const commentPosts = jira.calls
        .map((call, index) => ({ call, index }))
        .filter(({ call }) => call.method === 'POST' && call.url.includes('/comment'))
        .map(({ index }) => index);
      expect(commentPosts).toHaveLength(2);
      expect(commentPosts[1] ?? -1).toBeLessThan(lastTransition);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('runs a re-armed continuation at the rung its attempt count has reached', async () => {
    const ladder: readonly EscalationTier[] = [
      {
        name: 'flash',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-flash', '--model', 'deepseek-flash'],
        },
        maxRepairs: 1,
      },
      {
        name: 'astra',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-astra', '--model', 'gpt-6-astra'],
        },
        maxRepairs: 1,
      },
    ];
    const target = await createTarget({ markerCheck: true, escalation: ladder });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Write the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const runtime = await installFakeRuntime(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const argv = ['source', 'run', '--repo', target.repo, '--config', target.configPath];
      const run = await withFakeRuntimeOnPath(
        runtime.bin,
        runtime.state,
        [
          // The first intake spends the whole ladder without fixing the check:
          // flash's two turns, then astra's two.
          { edits: [{ file: 'MARKER.md', text: 'not yet\n' }], summary: 'flash: first try' },
          { edits: [{ file: 'MARKER.md', text: 'not yet\n' }], summary: 'flash: still wrong' },
          { edits: [{ file: 'MARKER.md', text: 'not yet\n' }], summary: 'astra: first try' },
          { edits: [{ file: 'MARKER.md', text: 'not yet\n' }], summary: 'astra: still wrong' },
          // The re-armed issue is continued at the ladder's top rung.
          { edits: [{ file: 'MARKER.md', text: 'done\n' }], summary: 'astra: finished it' },
        ],
        async () => {
          const first = await runSourceCli(argv, target.directory, { fetch: jira.fetch });
          expect(first.code).toBe(EXIT_INPUT_ERROR);
          expect(jira.issues[0]?.status).toBe('In Review');

          // The operator puts the issue back to work; its pointer label still
          // names the workspace, so the next intake continues it — at attempt 3
          // of the ladder, which is its top rung, Astra.
          if (jira.issues[0] === undefined) {
            throw new Error('the fixture issue disappeared');
          }
          jira.issues[0].status = 'To Do';
          const second = await runSourceCli(argv, target.directory, { fetch: jira.fetch });
          return { first, second };
        },
      );

      expect(run.second.err).toBe('');
      expect(run.second.code).toBe(EXIT_OK);
      expect(run.second.out).toContain('1 passed');
      // One attempt was made, in the same workspace, by the tier the attempt
      // count maps to: the stronger launch really is what Astra's comment says.
      const turns = await fakeTurns(runtime.state);
      expect(turns).toHaveLength(5);
      expect(turns[4]?.argv.slice(0, 2)).toEqual(['--profile', 'nexus-astra']);
      // The reports are ordered by the attempt each one records, not by their
      // directory names: run IDs have second resolution, so two runs of one
      // intake can share a second and sorting the names could reverse them.
      const reports = await reportsByAttempt(target.workDir);
      expect(reports.map((report) => report.status)).toEqual(['failed', 'failed', 'passed']);
      expect(reports.map((report) => report.workspace.attempt)).toEqual([1, 2, 3]);
      expect(new Set(reports.map((report) => report.workspace.workspaceId)).size).toBe(1);
      const continued = reports[2];
      expect(continued?.agent.command).toEqual([
        'codex',
        '--profile',
        'nexus-astra',
        '--model',
        'gpt-6-astra',
      ]);
      expect(continued?.workspace.continued).toBe(true);
      expect(continued?.workspace.attempt).toBe(3);
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(3);
      expect(jira.comments[2]).toContain('finished: passed');
      expect(jira.comments[2]).toContain('(tier astra)');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('does not spend the stronger tier on a runtime that could not finish the turn', async () => {
    const ladder: readonly EscalationTier[] = [
      {
        name: 'flash',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-flash', '--model', 'deepseek-flash'],
        },
        maxRepairs: 1,
      },
      {
        name: 'astra',
        agent: {
          runtime: 'codex',
          command: ['codex', '--profile', 'nexus-astra', '--model', 'gpt-6-astra'],
        },
        maxRepairs: 1,
      },
    ];
    const target = await createTarget({ markerCheck: true, escalation: ladder });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Write the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const runtime = await installFakeRuntime(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await withFakeRuntimeOnPath(
        runtime.bin,
        runtime.state,
        // A runtime that cannot authenticate or cannot finish its turn reports a
        // failed turn and ends without the event stream a completed one has. No
        // check ran after it, so this is not an ordinary red round.
        [{ mode: 'failed', summary: 'not logged in' }],
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            { fetch: jira.fetch },
          ),
      );

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.out).toContain('1 failed');
      // Only the first rung ran: a stronger tier would be spent on the same
      // infrastructure, not on the code.
      const turns = await fakeTurns(runtime.state);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.argv.slice(0, 2)).toEqual(['--profile', 'nexus-flash']);
      expect(result.out).not.toContain('escalating to tier');
      // The issue is told the exact outcome and moved out of the queue, so the
      // failure is visible to a human instead of sitting in the running status.
      expect(jira.issues[0]?.status).toBe('In Review');
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain('finished: failed');
      expect(jira.comments[0]).toContain('the coding runtime reported that the turn failed');
      expect(jira.comments[0]).not.toContain('escalation ladder');
      expect(
        jira.calls.filter((call) => call.method === 'POST' && call.url.includes('/transitions')),
      ).toHaveLength(2);
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

  it('delivers a passed attempt and puts the pull request on the issue', async () => {
    const target = await createTarget({ delivery: true });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const destination = await createDeliveryDestination(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          await gitOrFail(['add', '--all'], request.workspacePath);
          await gitOrFail(
            ['commit', '--quiet', '--message', 'write the marker'],
            request.workspacePath,
          );
          return { summary: 'wrote and committed the marker' };
        },
      };
      const result = await withFakeGhOnPath(
        destination.bin,
        destination.state,
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              dependencies,
              deliveryParts: { pushUrl: destination.remote },
            },
          ),
      );

      expect(result.err).toBe('');
      expect(result.code).toBe(EXIT_OK);
      const url = 'https://github.com/example-owner/example-repo/pull/1';
      expect(result.out).toContain(`pull request created: ${url}`);

      // Jira received the link, and the issue is not represented as merged or Done.
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain(`Pull request: ${url}`);
      expect(jira.comments[0]).toContain('never marks this issue Done');
      expect(jira.issues[0]?.status).toBe('In Review');

      // The destination really holds the attempt's branch, at the commit its
      // workspace holds: the delivery pushed work, not a stale copy of it.
      const runDir = await onlyRunDirectory(target.workDir);
      const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as {
        status: string;
        workspace: { path: string; branch: string };
      };
      expect(report.status).toBe('passed');
      const pushed = await runProcess(
        'git',
        ['--git-dir', destination.remote, 'rev-parse', `refs/heads/${report.workspace.branch}`],
        target.directory,
      );
      const local = await runProcess('git', ['rev-parse', 'HEAD'], report.workspace.path);
      expect(pushed.code).toBe(0);
      expect(pushed.stdout.trim()).toBe(local.stdout.trim());

      // GitHub was asked exactly once, and the pull request carries the issue
      // reference and the same check summary the issue's comment carries.
      const calls = await fakeGhCalls(destination.state);
      expect(calls.map((call) => call.op)).toEqual(['list', 'create']);
      expect(calls[1]?.repo).toBe('example-owner/example-repo');
      expect(calls[1]?.head).toBe(report.workspace.branch);
      expect(calls[1]?.base).toBe('main');
      expect(calls[1]?.body).toContain('SAM1-11');
      expect(calls[1]?.body).toContain('1 of 1 configured checks exited 0 (round: passed)');
      expect(existsSync(path.join(runDir, 'logs', 'delivery-pull-request-body.md'))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('refuses a passed attempt that left uncommitted work, and still tells the issue', async () => {
    const target = await createTarget({ delivery: true });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const destination = await createDeliveryDestination(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          // The turn passes the checks but leaves its work uncommitted.
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          return { summary: 'wrote the marker without committing it' };
        },
      };
      const result = await withFakeGhOnPath(
        destination.bin,
        destination.state,
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              dependencies,
              deliveryParts: { pushUrl: destination.remote },
            },
          ),
      );

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.out).toContain('uncommitted changes');
      expect(result.out).toContain('MARKER.md');
      expect(result.out).toContain('never commits or discards');
      // The retry is an operator step with git and gh, not a return to the
      // ready status, which would start a coding run instead.
      expect(result.out).toContain('starts a new coding run');

      // The run's own evidence is a passing run, exactly as it was written.
      const runDir = await onlyRunDirectory(target.workDir);
      const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as {
        status: string;
      };
      expect(report.status).toBe('passed');

      // The receipt carries the delivery failure into the next attempt.
      const receipt = await readReceipt(
        receiptFilePath(target.workDir, refFor('10011', 'SAM1-11')),
      );
      expect(receipt?.outcome).toBe('passed');
      expect(receipt?.problem).toContain('delivery:');
      expect(receipt?.problem).toContain('MARKER.md');

      // Nothing was pushed and GitHub was not asked, because the refusal comes
      // before the push; the issue is still told the passed outcome the run
      // produced, with the delivery failure beside it, so a passed task is not
      // left in the running status where a Jira-only coordinator cannot see it.
      expect(await fakeGhCalls(destination.state)).toEqual([]);
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain('finished: passed');
      expect(jira.comments[0]).toContain('Delivery:');
      expect(jira.comments[0]).toContain('MARKER.md');
      expect(jira.comments[0]).not.toContain('Pull request:');
      expect(jira.comments[0]).not.toContain('nor the harness pushes');
      expect(jira.issues[0]?.status).toBe('In Review');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('refuses to deliver a recorded branch a turn left behind, and still tells the issue', async () => {
    const target = await createTarget({ delivery: true });
    const jira = fakeJira([
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'Create the marker',
        status: 'To Do',
        updated: '2026-09-16T11:00:00.000Z',
      },
    ]);
    const destination = await createDeliveryDestination(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          // Ordinary local Git use during coding: the turn commits on a branch
          // of its own and leaves the workspace's recorded branch behind it.
          // The checks still pass, because they judge the working copy; what
          // delivery must not do is push the older recorded branch instead.
          await gitOrFail(
            ['checkout', '--quiet', '-b', 'task/harn-17-marker'],
            request.workspacePath,
          );
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          await gitOrFail(['add', '--all'], request.workspacePath);
          await gitOrFail(
            ['commit', '--quiet', '--message', 'write the marker'],
            request.workspacePath,
          );
          return { summary: 'wrote and committed the marker on a branch of its own' };
        },
      };
      const result = await withFakeGhOnPath(
        destination.bin,
        destination.state,
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              dependencies,
              deliveryParts: { pushUrl: destination.remote },
            },
          ),
      );

      const runDir = await onlyRunDirectory(target.workDir);
      const report = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as {
        status: string;
        workspace: { path: string; branch: string };
      };
      const validated = (
        await runProcess('git', ['rev-parse', 'HEAD'], report.workspace.path)
      ).stdout.trim();
      const recorded = (
        await runProcess(
          'git',
          ['rev-parse', `refs/heads/${report.workspace.branch}`],
          report.workspace.path,
        )
      ).stdout.trim();
      expect(recorded).not.toBe(validated);

      // The run itself passed; the delivery refused to publish the older
      // revision, named both of them, and intake stopped for a person.
      expect(report.status).toBe('passed');
      expect(result.code).toBe(EXIT_INPUT_ERROR);
      expect(result.out).toContain('checked out at');
      expect(result.out).toContain(validated);
      expect(result.out).toContain(recorded);
      expect(result.out).toContain(`branch this step would publish, ${report.workspace.branch}`);
      expect(result.out).toContain('never force-pushes');
      // The retry is an operator step with git and gh, not a return to the
      // ready status, which would start a coding run instead.
      expect(result.out).toContain('starts a new coding run');

      // Nothing left the machine: no push, no pull request, and GitHub was not
      // asked anything at all.
      expect(await fakeGhCalls(destination.state)).toEqual([]);
      const pushed = await runProcess(
        'git',
        ['--git-dir', destination.remote, 'rev-parse', `refs/heads/${report.workspace.branch}`],
        target.directory,
      );
      expect(pushed.code).not.toBe(0);

      // Every commit and branch the turn left is still there, the checkout was
      // not switched or adopted, and the tree is still clean.
      const taskBranch = (
        await runProcess(
          'git',
          ['rev-parse', 'refs/heads/task/harn-17-marker'],
          report.workspace.path,
        )
      ).stdout.trim();
      expect(taskBranch).toBe(validated);
      expect(
        (await runProcess('git', ['status', '--porcelain'], report.workspace.path)).stdout.trim(),
      ).toBe('');

      // The issue is told the passed outcome with the delivery failure, and it
      // stays in review: no coding turn was started to repair the publication.
      const receipt = await readReceipt(
        receiptFilePath(target.workDir, refFor('10011', 'SAM1-11')),
      );
      expect(receipt?.outcome).toBe('passed');
      expect(receipt?.problem).toContain('delivery:');
      expect(receipt?.problem).toContain(recorded);
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).toContain('finished: passed');
      expect(jira.comments[0]).toContain('Delivery:');
      expect(jira.comments[0]).not.toContain('Pull request:');
      expect(jira.issues[0]?.status).toBe('In Review');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('keeps a passed attempt local when no delivery step is configured', async () => {
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
    const destination = await createDeliveryDestination(target.directory);
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const dependencies: CliContext['dependencies'] = {
        runAgentTurn: async (request) => {
          await writeFile(path.join(request.workspacePath, 'MARKER.md'), 'done\n', 'utf8');
          await gitOrFail(['add', '--all'], request.workspacePath);
          await gitOrFail(
            ['commit', '--quiet', '--message', 'write the marker'],
            request.workspacePath,
          );
          return { summary: 'wrote and committed the marker' };
        },
      };
      // A stand-in gh and a reachable destination are configured for the
      // delivery step that this configuration does not ask for: they stay unused.
      const result = await withFakeGhOnPath(
        destination.bin,
        destination.state,
        async () =>
          await runSourceCli(
            ['source', 'run', '--repo', target.repo, '--config', target.configPath],
            target.directory,
            {
              fetch: jira.fetch,
              dependencies,
              deliveryParts: { pushUrl: destination.remote },
            },
          ),
      );

      expect(result.code).toBe(EXIT_OK);
      expect(await fakeGhCalls(destination.state)).toEqual([]);
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]).not.toContain('Pull request:');
      expect(jira.comments[0]).toContain('nor the harness pushes');
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
    // A harness configuration with no Nexus-wide extras, composed with a
    // project that has no Jira connection of its own: nothing to take tasks
    // from, which is what the source command has to say.
    const withoutSource = await writeJsonFile(
      target.directory,
      HARNESS_CONFIG_FILE_NAME,
      documentedHarnessConfig,
    );
    const plainProject = path.join(target.directory, 'plain-project');
    await writeJsonFile(plainProject, PROJECT_CONFIG_FILE_NAME, {
      setup: [],
      checks: [['node', '-e', 'process.exit(0)']],
    });
    const previous = process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_API_TOKEN;

    try {
      const missingToken = await runSourceCli(
        ['source', 'list', '--config', target.configPath, '--project', target.repo],
        target.directory,
        { fetch: fakeJira([]).fetch },
      );
      const missingSource = await runSourceCli(
        ['source', 'list', '--config', withoutSource, '--project', plainProject],
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

  it('takes the ticket Jira’s Rank order put first, not the smallest key', async () => {
    const target = await createTarget({ ordering: 'rank' });
    const jira = fakeJira([
      {
        id: '10013',
        key: 'SAM1-13',
        summary: 'The board’s first ready ticket',
        status: 'To Do',
        updated: '2026-09-19T11:00:00.000Z',
      },
      {
        id: '10011',
        key: 'SAM1-11',
        summary: 'The board’s second ready ticket',
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
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath, '--limit', '1'],
        target.directory,
        { fetch: jira.fetch, dependencies },
      );

      expect(result.code).toBe(EXIT_OK);
      // Rank mode asks Jira for the board's own order and takes the first ticket
      // of that answer as-is: the smaller key waits for a later scan instead.
      const search = jira.calls.find((call) => call.url.endsWith('/search/jql'));
      expect((search?.body as { jql: string }).jql).toContain(
        'ORDER BY Rank ASC, created ASC, key ASC',
      );
      expect(jira.issues.find((issue) => issue.status === 'In Review')?.key).toBe('SAM1-13');
      expect(jira.issues.find((issue) => issue.key === 'SAM1-11')?.status).toBe('To Do');
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });

  it('returns Jira’s refusal of Rank JQL and starts no task', async () => {
    const target = await createTarget({ ordering: 'rank' });
    const calls: Array<{ readonly method: string; readonly url: string }> = [];
    const refuseRank = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ method: init.method ?? 'GET', url });
      return new Response(
        JSON.stringify({
          errorMessages: ['Field Rank does not exist or you do not have permission to view it'],
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    };
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'test-token';

    try {
      const result = await runSourceCli(
        ['source', 'run', '--repo', target.repo, '--config', target.configPath],
        target.directory,
        { fetch: refuseRank as unknown as typeof fetch },
      );

      expect(result.code).toBe(EXIT_INPUT_ERROR);
      // The bounded answer Jira gave is reported, and nothing else happened: one
      // search was sent, no Priority scan was tried instead, no run directory or
      // workspace exists, and no issue was read, claimed, commented on, or moved.
      expect(result.out).toContain('source stopped');
      expect(result.out).toContain('discovery failed');
      expect(result.out).toContain('HTTP 400');
      expect(result.out).toContain('Field Rank does not exist');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain('/rest/api/3/search/jql');
      expect(existsSync(path.join(target.workDir, 'runs'))).toBe(false);
      expect(existsSync(path.join(target.workDir, 'workspaces'))).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
  });
});
