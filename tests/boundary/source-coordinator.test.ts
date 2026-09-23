/**
 * The intake coordinator's retained state and the decisions it makes over one
 * run's own ending, as real files under one output directory: the receipt that
 * reserves an item before anything remote or paid happens, the per-project lock
 * that admits one consumer at a time, the delivery of a passed attempt before
 * its result is published, the escalation ladder one claim climbs, the pending
 * pre-delivery diagnosis a later invocation finishes before it discovers
 * anything, and the watch cadence over that state — the poll interval, a retry
 * that waits out the delay the source asked for, and a failure that stops the
 * loop instead.
 *
 * The item, the agent turn, the reviewer turn, the delivery step and the service
 * answers are the case's stand-ins — the coordinator starts no runtime and no
 * configured command here — while the receipt file, its exclusive creation, its
 * atomic replacement and the lock directory are the harness's own code, on a
 * real temporary filesystem. What is asserted is the documented intake behavior
 * (docs/spec.md §6, docs/WORKFLOW.md §8 and §11): an item is never attempted
 * twice from one output directory, an uncertain claim keeps the receipt it just
 * created and stops intake for a person, a rejected claim releases only the
 * reservation this process made, a failed publication keeps the local result and
 * stops, a run whose own stop could not be confirmed — before any run result
 * exists, at the item's own preflight, wrapped by the run preflight, and while a
 * retained workspace is verified for a continuation, as well as after one —
 * publishes nothing and keeps its receipt and the lock, a confirmed stop still
 * gets its one bounded feedback under a deadline of its own, a pending diagnosis
 * whose reviewer was not confirmed stopped stops discovery and polling alike
 * while a diagnosis that stopped cleanly is reported and stepped past, a
 * completed red baseline is handed to the configured diagnosis — an actionable
 * finding returns the ticket for the repair its next claim continues with
 * nothing else about the attempt published or delivered, and a finding with
 * nothing actionable stops intake — a workspace returned for a baseline repair
 * is told the complete recorded finding whatever the item's own thread
 * supplies, and starts no developer, records the problem and tells the claimed
 * ticket when that required finding cannot be read back, a passed
 * attempt is delivered before its result is published and failed or cancelled
 * work never reaches delivery, a delivery failure is published beside the
 * outcome the run produced before intake stops, one claim climbs the configured
 * ladder in the same retained workspace while a ticket that came back to work
 * starts at the first rung again, and a lock is never broken, adopted, or removed
 * by a process that does not own it.
 *
 * Two cases reach the workspace boundary itself. The one that reopens a retained
 * workspace is handed what the Git read the verification makes reported — a stop
 * the harness could not confirm — at the process boundary that read belongs to,
 * exactly as a stand-in `git` would report it; the one that continues a retained
 * workspace after a finished cycle lets the harness read a real temporary
 * checkout, because the state that verification reads is the host's, never the
 * case's.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveredPullRequest, Delivery, DeliveryRequest } from '../../src/delivery/github.js';
import { DeliveryError } from '../../src/delivery/github.js';
import type { InvocationResult } from '../../src/process/invocation.js';
import * as invocation from '../../src/process/invocation.js';
import { RunCancelledError, RunTimeoutError } from '../../src/runs/contracts.js';
import type { RunTaskResult } from '../../src/runs/contracts.js';
import { summarizeChanges } from '../../src/reporting/changes.js';
import type {
  AttemptEvidence,
  AttemptKind,
  CheckRoundResult,
  EscalationTier,
  RoundOutcome,
  SourceRef,
  Task,
  TerminationOutcome,
} from '../../src/shared/types.js';
import type {
  BaselineDiagnosis,
  BaselineDiagnosisOutcome,
  BaselineDiagnosisRequest,
  BaselineFinding,
  BaselineReviewedFinding,
  PublishedComment,
  SourceCandidate,
  SourceComment,
  SourceRunOutcome,
  SourceRunRequest,
  SourceTask,
  SourceContext,
  TaskSource,
} from '../../src/sources/contract.js';
import { SourceError, SourceFeedbackError } from '../../src/sources/contract.js';
import {
  runSource,
  takeOneItem,
  WATCH_BACKOFF_BASE_MS,
  watchSource,
} from '../../src/sources/coordinator.js';
import type { SourceWatchOptions } from '../../src/sources/coordinator.js';
import type { SourceReceipt } from '../../src/sources/receipts.js';
import {
  acquireIntakeLock,
  intakeLockPath,
  readReceipt,
  receiptFilePath,
  reserveReceipt,
} from '../../src/sources/receipts.js';
import { WorkspaceError } from '../../src/workspace/errors.js';
import { workspacePathFor } from '../../src/workspace/run-directory.js';
import { readWorkspaceState, writeWorkspaceState } from '../../src/workspace/state.js';
import type { WorkspaceAttempt, WorkspaceState } from '../../src/workspace/state.js';
import { createTempDir, gitOrFail, useIsolatedGitEnvironment } from './integration-support.js';

useIsolatedGitEnvironment();

const SITE = 'https://example.atlassian.net';
const REF: SourceRef = {
  type: 'jira',
  scope: SITE,
  id: '10011',
  key: 'HARN-11',
  url: `${SITE}/browse/HARN-11`,
  updatedAt: '2026-09-23T10:00:00.000Z',
};
const TASK: Task = {
  id: 'HARN-11',
  title: 'Add a greeting function',
  description: 'Implement the greeting the ticket describes.',
  acceptanceCriteria: ['The greeting is implemented.'],
};
const BASE = 'a'.repeat(40);
const NAMESPACE = 'connected-project';

function candidate(id = REF.id, key = REF.key): SourceCandidate {
  return { ref: { ...REF, id, key, url: `${SITE}/browse/${key}` }, title: TASK.title };
}

function prepared(source: SourceCandidate): SourceTask {
  return { ref: source.ref, task: { ...TASK, id: source.ref.key }, pointers: [] };
}

/** The stop evidence one run's own report carries, when it carries any. */
interface RunEnding {
  readonly timeout?: RunTaskResult['timeout'];
  readonly cancellation?: RunTaskResult['cancellation'];
}

/** The run one case's stand-in agent turn produced. */
function runResult(
  workDir: string,
  status: RunTaskResult['status'] = 'passed',
  ending: RunEnding = {},
): RunTaskResult {
  const runId = 'run-1';
  const runDir = path.join(workDir, 'runs', runId);
  const workspaceId = REF.key;
  const workspacePath = path.join(workDir, 'workspaces', workspaceId);
  const logsDir = path.join(runDir, 'logs');
  return {
    run: { workDir, runId, runDir, workspaceId, workspacePath, logsDir },
    workspace: {
      workDir,
      runId,
      runDir,
      workspaceId,
      workspacePath,
      logsDir,
      continued: false,
      attempt: 1,
      sourceRoot: path.join(workDir, 'source'),
      baseCommit: BASE,
      branch: `harness/${workspaceId}`,
    },
    status,
    reason:
      status === 'passed'
        ? 'every configured check passed'
        : status === 'cancelled'
          ? 'the caller stopped the run'
          : 'the checks after the implementation turn did not pass',
    baseline: null,
    attempts: [],
    repairsUsed: 0,
    timeout: ending.timeout ?? null,
    cancellation: ending.cancellation ?? null,
    changes: summarizeChanges({ baseCommit: BASE, paths: [] }),
    workspaceLedgerProblem: null,
    reportPath: path.join(runDir, 'result.json'),
  };
}

/**
 * A run the caller stopped, with the evidence its own report carries:
 * `termination` says whether everything the run started was seen to end, which
 * is what decides whether its result may be published at all (docs/spec.md §6).
 */
function stoppedRun(
  workDir: string,
  termination: TerminationOutcome,
  problem: string | null = null,
): RunTaskResult {
  return runResult(workDir, 'cancelled', {
    cancellation: {
      phase: 'the implementation turn',
      elapsedMs: 1_000,
      termination,
      problem,
    },
  });
}

/** A run whose own configured command ran out of time. */
function timedOutRun(
  workDir: string,
  termination: TerminationOutcome,
  problem: string | null = null,
): RunTaskResult {
  return runResult(workDir, 'failed', {
    timeout: {
      limit: 'command',
      phase: 'the checks after the implementation turn',
      limitMs: 600_000,
      elapsedMs: 600_000,
      termination,
      problem,
    },
  });
}

/** What the Git steps the cases below supply could not confirm about their own stop. */
const CLEANUP = 'the stand-in Git tree did not stop';

/**
 * The failure a Git step records when the harness stopped it and could not
 * confirm that everything it started had ended — the evidence a caller that
 * reports why a run ended has to carry rather than round down.
 */
function unconfirmedGitStop(kind: 'timeout' | 'cancelled' = 'timeout'): WorkspaceError {
  return new WorkspaceError('the Git inspection did not finish', {
    stop: { termination: 'unconfirmed', problem: CLEANUP, kind, timeoutMs: 25 },
  });
}

/** One completed round holding a single check, as the published checks line reads it. */
function checkRound(outcome: RoundOutcome, exitCode: number | null): CheckRoundResult {
  return {
    outcome,
    setup: [],
    checks: [
      {
        command: ['node', 'check.mjs'],
        cwd: '/work/workspaces/HARN-11',
        startedAt: '2026-09-23T10:00:00.000Z',
        endedAt: '2026-09-23T10:00:01.000Z',
        outcome: 'exited',
        exitCode,
        signal: null,
        launchError: null,
        timeoutMs: 300_000,
        termination: null,
        terminationProblem: null,
        stdoutPath: '/work/runs/run-1/logs/check.stdout.log',
        stderrPath: '/work/runs/run-1/logs/check.stderr.log',
      },
    ],
    problem: null,
  };
}

/** One coding turn of a run's own evidence, with the round observed after it. */
function attemptTurn(
  turn: number,
  kind: AttemptKind,
  checks: CheckRoundResult | null,
): AttemptEvidence {
  return {
    turn,
    kind,
    agentLog: `/work/runs/run-1/logs/agent-${String(turn)}.log`,
    agentSummary: `turn ${String(turn)} ended`,
    checks,
  };
}

/**
 * The run one rung of the ladder produced when it spent its whole repair
 * allowance on ordinary completed red check rounds: the one ending that climbs
 * to the next configured tier (src/sources/run-outcomes.ts).
 */
function exhaustedRung(workDir: string, allowance: number): RunTaskResult {
  const turns: AttemptEvidence[] = [attemptTurn(1, 'implementation', checkRound('failed', 1))];
  for (let turn = 2; turn <= allowance + 1; turn += 1) {
    turns.push(attemptTurn(turn, 'repair', checkRound('failed', 1)));
  }
  return { ...runResult(workDir, 'failed'), attempts: turns, repairsUsed: allowance };
}

/**
 * What one Git invocation the harness had to stop reports when its own stop
 * could not be confirmed: the same evidence {@link unconfirmedGitStop} stands in
 * for where a case never reaches the process boundary.
 */
function unconfirmedGitInvocation(): InvocationResult {
  return {
    outcome: 'timed-out',
    exitCode: 0,
    signal: null,
    launchError: null,
    timeoutMs: 25,
    termination: 'unconfirmed',
    terminationProblem: CLEANUP,
  };
}

/**
 * One retained workspace on disk, as a finished cycle leaves it: a real checkout
 * on the branch its ledger records, and that ledger beside it.
 */
async function retainedWorkspace(
  workDir: string,
  attempts: readonly WorkspaceAttempt[] = [],
): Promise<{
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly sourceRoot: string;
  readonly state: WorkspaceState;
}> {
  const workspaceId = REF.key;
  const branch = `harness/${workspaceId}`;
  const sourceRoot = path.join(workDir, 'source');
  const workspacePath = workspacePathFor(workDir, workspaceId);
  await mkdir(workspacePath, { recursive: true });
  await gitOrFail(['init', '--quiet', '--initial-branch=main'], workspacePath);
  await writeFile(path.join(workspacePath, 'README.md'), 'the item’s own baseline\n', 'utf8');
  await gitOrFail(['add', '--all'], workspacePath);
  await gitOrFail(['commit', '--quiet', '--message', 'baseline'], workspacePath);
  await gitOrFail(['checkout', '--quiet', '-b', branch], workspacePath);
  const state: WorkspaceState = {
    version: 1,
    workspaceId,
    sourceRoot,
    baseCommit: BASE,
    branch,
    createdAt: '2026-09-22T09:00:00.000Z',
    sourceItem: { type: 'jira', scope: SITE, id: REF.id, key: REF.key },
    attempts,
  };
  await writeWorkspaceState(workDir, state);
  return {
    workspaceId,
    workspacePath,
    branch,
    baseCommit: state.baseCommit,
    sourceRoot,
    state,
  };
}

/** What one coordinator case watches: the calls its stand-in source received. */
interface CoordinatorCalls {
  readonly lists: number;
  readonly prepared: string[];
  readonly claims: string[];
  readonly runs: string[];
  /** Every run the ladder asked for, in the order it asked. */
  readonly requests: SourceRunRequest[];
  readonly refusals: string[];
  /** One entry per published result, with the outcome it was published as. */
  readonly completions: Array<{ readonly key: string; readonly outcome: SourceRunOutcome }>;
  /** One entry per published intermediate rung, in the order it was published. */
  readonly progresses: Array<{ readonly key: string; readonly outcome: SourceRunOutcome }>;
  /** Every publication, progress and result alike, in the order it happened. */
  readonly publications: string[];
  readonly outputs: string[];
}

/** One intake over a temporary output directory, with every collaborator named. */
function coordinatorHarness(
  workDir: string,
  parts: {
    readonly candidates?: readonly SourceCandidate[];
    /** The item each fresh read returns; the fixture's own when absent. */
    readonly prepare?: (found: SourceCandidate) => Promise<SourceTask> | SourceTask;
    readonly claim?: (item: SourceTask) => Promise<boolean>;
    /** One rung's own intermediate comment; absent means no rung may publish one. */
    readonly progress?: (item: SourceTask, outcome: SourceRunOutcome) => Promise<PublishedComment>;
    readonly complete?: (
      item: SourceTask,
      outcome: SourceRunOutcome,
    ) => Promise<{ readonly commentId: string; readonly text: string }>;
    /** What the item's own thread carries since its last attempt; nothing when absent. */
    readonly commentsSince?: (item: SourceTask) => Promise<readonly SourceComment[]>;
    /** The run each stand-in agent turn produced; a passed one when absent. */
    readonly run?: (request: SourceRunRequest) => Promise<RunTaskResult> | RunTaskResult;
    /** The configured escalation ladder; one tier when absent. */
    readonly tiers?: readonly EscalationTier[];
    /** The delivery step the case configures; absent means delivery is off. */
    readonly delivery?: Delivery;
    /** The pending diagnosis the case supplies; absent means the phase is off. */
    readonly baselineDiagnosis?: SourceContext['baselineDiagnosis'];
    /** The source/output preflight re-run before each reservation; a passing one when absent. */
    readonly preflight?: SourceContext['preflight'];
  } = {},
) {
  const recorder = {
    lists: 0,
    prepared: [] as string[],
    claims: [] as string[],
    runs: [] as string[],
    requests: [] as SourceRunRequest[],
    refusals: [] as string[],
    completions: [] as Array<{ key: string; outcome: SourceRunOutcome }>,
    progresses: [] as Array<{ key: string; outcome: SourceRunOutcome }>,
    publications: [] as string[],
    outputs: [] as string[],
  };
  const stop = new AbortController();
  const source: TaskSource = {
    listEligible: async () => {
      recorder.lists += 1;
      return parts.candidates ?? [candidate()];
    },
    prepare: async (found) => {
      recorder.prepared.push(found.ref.key);
      return parts.prepare === undefined ? prepared(found) : await parts.prepare(found);
    },
    claim: async (item) => {
      recorder.claims.push(item.ref.key);
      return parts.claim === undefined ? true : await parts.claim(item);
    },
    progress: async (item, outcome) => {
      recorder.progresses.push({ key: item.ref.key, outcome });
      recorder.publications.push(`progress:${item.ref.key}:${outcome.status}`);
      if (parts.progress === undefined) {
        throw new Error(`no ladder rung published a progress comment for ${item.ref.key}`);
      }
      return await parts.progress(item, outcome);
    },
    complete: async (item, outcome) => {
      recorder.completions.push({ key: item.ref.key, outcome });
      recorder.publications.push(`complete:${item.ref.key}:${outcome.status}`);
      return parts.complete === undefined
        ? await Promise.resolve({ commentId: '9001', text: 'published' })
        : await parts.complete(item, outcome);
    },
    recordWorkspace: async () => undefined,
    refuse: async (item, reason) => {
      recorder.refusals.push(`${item.ref.key}: ${reason}`);
    },
    attention: async (item, reason) => {
      recorder.refusals.push(`${item.ref.key}: attention: ${reason}`);
    },
    commentsSince: async (item) =>
      parts.commentsSince === undefined ? [] : await parts.commentsSince(item),
  };
  const context: SourceContext = {
    source,
    workDir,
    lockNamespace: NAMESPACE,
    tiers: parts.tiers ?? [
      { name: 'default', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 },
    ],
    repoPath: path.join(workDir, 'source'),
    io: {
      out: (text) => recorder.outputs.push(text),
      err: (text) => recorder.outputs.push(text),
    },
    stop: stop.signal,
    preflight:
      parts.preflight ??
      (async () => ({ sourceRoot: path.join(workDir, 'source'), baseCommit: BASE })),
    ...(parts.delivery === undefined ? {} : { delivery: parts.delivery }),
    ...(parts.baselineDiagnosis === undefined
      ? {}
      : { baselineDiagnosis: parts.baselineDiagnosis }),
    run: async (request) => {
      recorder.runs.push(request.sourceRef.key);
      recorder.requests.push(request);
      return parts.run === undefined ? runResult(workDir) : await parts.run(request);
    },
    now: () => new Date('2026-09-23T10:00:00.000Z'),
    sleep: async () => undefined,
  };
  return { context, calls: recorder as CoordinatorCalls, stop };
}

/** One receipt, read back as the file really holds it. */
async function receipt(workDir: string): Promise<SourceReceipt | null> {
  return await readReceipt(receiptFilePath(workDir, REF));
}

describe('one item, one receipt, across invocations', () => {
  it('runs a fresh item once and refuses it when a later invocation scans again', async () => {
    const workDir = await createTempDir();
    const first = coordinatorHarness(workDir, { candidates: [candidate()] });

    const summary = await runSource(first.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 1, passed: 1, refused: 0 });
    expect(first.calls.claims).toEqual([REF.key]);
    expect(first.calls.runs).toEqual([REF.key]);
    expect(await receipt(workDir)).toMatchObject({
      outcome: 'passed',
      feedback: 'sent',
      runId: 'run-1',
    });

    // The restart a watcher's next invocation is: the receipt is the local
    // record that the item was attempted, and nothing claims, runs or publishes
    // it a second time.
    const second = coordinatorHarness(workDir, { candidates: [candidate()] });
    const again = await runSource(second.context, null);

    expect(again).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    expect(second.calls.claims).toEqual([]);
    expect(second.calls.runs).toEqual([]);
    expect(second.calls.refusals[0]).toContain('already attempted');
  });

  it('keeps the receipt and stops intake when the claim is uncertain', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      claim: async () => {
        throw new SourceError('uncertain-write', 'the transition request did not answer');
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('the claim did not complete');
    // Nothing ran after the uncertain claim, and nothing was published.
    expect(harness.calls.runs).toEqual([]);
    expect(harness.calls.completions).toEqual([]);
    const kept = await receipt(workDir);
    expect(kept?.runId).toBeUndefined();
    expect(kept?.problem).toContain('the transition request did not answer');

    // The kept receipt is the evidence a later invocation reads: the item is
    // refused, never claimed or run again.
    const restart = coordinatorHarness(workDir, { candidates: [candidate()] });
    const again = await runSource(restart.context, null);

    expect(again.refused).toBe(1);
    expect(restart.calls.claims).toEqual([]);
    expect(restart.calls.runs).toEqual([]);
  });

  it('does not make a merely edited or reopened item runnable again', async () => {
    const workDir = await createTempDir();
    await runSource(coordinatorHarness(workDir, { candidates: [candidate()] }).context, null);
    // The same immutable item, re-read after an edit or a reopen: a new key, a
    // new title, a new revision. The receipt is keyed by the connector type, the
    // canonical site and the immutable ID alone, so nothing mutable makes the
    // item look like new work.
    const edited: SourceCandidate = {
      ref: { ...REF, key: 'HARN-11-restated', updatedAt: '2026-09-24T09:00:00.000Z' },
      title: 'A completely different summary',
    };
    const again = coordinatorHarness(workDir, { candidates: [edited] });

    const summary = await runSource(again.context, null);

    expect(summary).toMatchObject({ attempted: 0, refused: 1 });
    // It is re-read to decide, and re-read again so the refusal is about the
    // item as it is now — then left alone: no claim, no run.
    expect(again.calls.prepared).toEqual(['HARN-11-restated', 'HARN-11-restated']);
    expect(again.calls.claims).toEqual([]);
    expect(again.calls.runs).toEqual([]);
    expect(again.calls.outputs.join('\n')).toContain('refused, and the issue is told why');
    expect(receiptFilePath(workDir, edited.ref)).toBe(receiptFilePath(workDir, REF));
    expect(receiptFilePath(workDir, { ...edited.ref, id: '10012' })).not.toBe(
      receiptFilePath(workDir, REF),
    );
    expect(
      receiptFilePath(workDir, { ...edited.ref, scope: 'https://other.atlassian.net' }),
    ).not.toBe(receiptFilePath(workDir, REF));
  });

  it('releases only the reservation it just made when the claim sent no mutation request', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate()],
      claim: async () => false,
    });

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', skipped: 1 });
    expect(harness.calls.runs).toEqual([]);
    // The item stayed eligible, and no mutation was sent, so the reservation
    // this invocation created is gone: a later scan may try the item again.
    expect(existsSync(receiptFilePath(workDir, REF))).toBe(false);
  });

  it('keeps the local result and the receipt, and stops, after a failed publication', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      complete: async () => {
        throw new SourceFeedbackError('transition', 'the transition failed', '9001');
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('publishing its result failed');
    // The second candidate was never started: a publication failure stops the
    // batch instead of moving to the next ticket.
    expect(harness.calls.runs).toEqual([REF.key]);
    expect(await receipt(workDir)).toMatchObject({
      outcome: 'passed',
      feedback: 'failed',
      commentId: '9001',
    });
    const kept = await receipt(workDir);
    expect(kept?.resultPath).toBe(path.join(workDir, 'runs', 'run-1', 'result.json'));
  });

  it('fails closed on a receipt it cannot trust instead of treating it as absence', async () => {
    const workDir = await createTempDir();
    const file = receiptFilePath(workDir, REF);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json', 'utf8');
    const harness = coordinatorHarness(workDir, { candidates: [candidate()] });

    const thrown = await runSource(harness.context, null).catch((cause: unknown) => cause);

    expect(thrown).toBeInstanceOf(SourceError);
    expect((thrown as Error).message).toContain(file);
    // Nothing was claimed or run on the strength of a record nobody can read.
    expect(harness.calls.claims).toEqual([]);
    expect(harness.calls.runs).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });
});

describe('the ending one run reports', () => {
  it('publishes a stopped run once, with a deadline of its own', async () => {
    const workDir = await createTempDir();
    const signals: AbortSignal[] = [];
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      run: () => {
        // The interrupt arrives while this run is in progress, which is what
        // the runner reports back as a cancelled run.
        harness.stop.abort(new Error('interrupt'));
        return stoppedRun(workDir, 'confirmed');
      },
    });
    const complete = harness.context.source.complete;
    harness.context.source.complete = async (item, outcome, stop) => {
      signals.push(stop);
      return await complete(item, outcome, stop);
    };

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({
      outcome: 'cancelled',
      attempted: 1,
      cancelled: 1,
      cleanupConfirmed: true,
    });
    // One feedback sequence, and one only. The run's own stop is what the
    // sequence is bounded by, not the already-aborted intake signal it would
    // fail instantly under — and it still ends the batch, so the second ticket
    // is never taken.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    // The sequence runs under a deadline of its own, not the intake's own
    // already-aborted signal.
    expect(signals[0]).not.toBe(harness.context.stop);
    expect(harness.context.stop.aborted).toBe(true);
    expect(harness.calls.completions.map((entry) => entry.outcome.status)).toEqual(['cancelled']);
    expect(harness.calls.runs).toEqual([REF.key]);
    // The stop was confirmed, so the result is published, the receipt says so
    // and the lock this invocation held is released.
    expect((await receipt(workDir))?.feedback).toBe('sent');
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(false);
  });

  it('posts nothing and keeps the lock when a cancelled run could not confirm its own termination', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      run: () => {
        harness.stop.abort(new Error('interrupt'));
        return stoppedRun(
          workDir,
          'unconfirmed',
          'the runtime had not ended 5000 ms after it was stopped',
        );
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary.outcome).toBe('cancelled');
    expect(summary.cleanupConfirmed).toBe(false);
    // Nothing was published and no second ticket was taken: something the run
    // started may still be writing.
    expect(harness.calls.completions).toEqual([]);
    expect(harness.calls.prepared).toEqual([REF.key]);
    expect(harness.calls.runs).toEqual([REF.key]);
    // The receipt stays, carrying the run's own evidence and why nothing was
    // posted; the lock is left behind deliberately, for a person to inspect.
    const kept = await receipt(workDir);
    expect(kept).toMatchObject({ outcome: 'cancelled', feedback: 'pending', runId: 'run-1' });
    expect(kept?.problem).toContain('termination was not confirmed');
    expect(kept?.resultPath).toBe(path.join(workDir, 'runs', 'run-1', 'result.json'));
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(true);
  });

  it('stops intake and keeps the lock when a timed-out run could not confirm its own termination', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      run: () =>
        timedOutRun(
          workDir,
          'unconfirmed',
          'the command had not ended 5000 ms after it was stopped',
        ),
    });

    const summary = await runSource(harness.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.cleanupConfirmed).toBe(false);
    expect(harness.calls.completions).toEqual([]);
    expect(harness.calls.runs).toEqual([REF.key]);
    const kept = await receipt(workDir);
    expect(kept).toMatchObject({ outcome: 'failed', feedback: 'pending', runId: 'run-1' });
    expect(kept?.problem).toContain('termination was not confirmed');
    expect(harness.calls.outputs.join('\n')).toContain('no result was posted');
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(true);
  });

  it('names the last round that ran, not the baseline, when the final turn was stopped', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      run: () => ({
        ...runResult(workDir, 'failed', {
          timeout: {
            limit: 'task',
            phase: 'repair turn 2',
            limitMs: 3_600_000,
            elapsedMs: 3_600_113,
            termination: 'confirmed',
            problem: null,
          },
        }),
        // A run that started green and had its repair turn cut off by the task
        // deadline: the last round that really ran is the red one after the
        // implementation turn, and the stopped turn has no round of its own.
        baseline: checkRound('passed', 0),
        attempts: [
          {
            turn: 1,
            kind: 'implementation',
            agentLog: '/work/runs/run-1/logs/agent-1.log',
            agentSummary: 'the implementation is done',
            checks: checkRound('failed', 1),
          },
          {
            turn: 2,
            kind: 'repair',
            agentLog: '/work/runs/run-1/logs/agent-2.log',
            agentSummary: null,
            checks: null,
          },
        ],
        repairsUsed: 1,
      }),
    });

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 1, failed: 1 });
    expect(harness.calls.completions).toHaveLength(1);
    // Describing the round the run started with as if it were the one that
    // decided it would tell a reader the opposite of what happened.
    expect(harness.calls.completions[0]?.outcome.checks).toBe(
      '0 of 1 configured checks exited 0 (round: failed); no check round was observed after ' +
        'repair turn 2',
    );
  });
});

/**
 * A Git step the harness had to stop and could not confirm stopped is an intake
 * stop before a run result exists exactly as much as after one — the item's own
 * preflight, the run preflight, and the verification of a retained workspace a
 * continuation would reopen alike: the working copy it was reading may still be
 * written to, so nothing is published, nothing later is read, and the receipt
 * and the lock stay for a person (docs/spec.md §6).
 */
describe('a Git stop the intake could not confirm before any run result exists', () => {
  it('keeps the lock, the receipt and every later reading when an item preflight fails this way', async () => {
    const workDir = await createTempDir();
    // An earlier attempt's receipt is this machine's evidence that the item was
    // already attempted: a failed preflight leaves it exactly as it is.
    const held: SourceReceipt = {
      version: 1,
      source: REF,
      reservedAt: '2026-09-22T09:00:00.000Z',
    };
    await reserveReceipt(receiptFilePath(workDir, REF), held);
    let readings = 0;
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      preflight: async () => {
        readings += 1;
        // The batch's own reading passes; the item's own recheck, before its
        // reservation, is the one that could not be stopped.
        if (readings === 1) {
          return { sourceRoot: path.join(workDir, 'source'), baseCommit: BASE };
        }
        throw unconfirmedGitStop();
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'stopped', attempted: 0, cleanupConfirmed: false });
    expect(summary.problem).toContain(`${REF.key}: source preflight`);
    expect(summary.problem).toContain(CLEANUP);
    // Nothing was claimed, run or published after the failed stop, and the
    // second candidate was never even prepared.
    expect(harness.calls.prepared).toEqual([]);
    expect(harness.calls.claims).toEqual([]);
    expect(harness.calls.runs).toEqual([]);
    expect(harness.calls.completions).toEqual([]);
    // The receipt and the lock are kept, and the terminal says why.
    expect(await receipt(workDir)).toEqual(held);
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(true);
    expect(harness.calls.outputs.join('\n')).toContain('left in place for inspection');
  });

  it('keeps the reservation and the lock when a stopped run preflight wraps this stop', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      run: () => {
        harness.stop.abort(new Error('interrupt'));
        throw new RunCancelledError('the run was stopped before its workspace was ready', {
          cause: unconfirmedGitStop('cancelled'),
        });
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'cancelled', attempted: 1, cleanupConfirmed: false });
    expect(summary.problem).toContain(`${REF.key}: run preflight`);
    expect(summary.problem).toContain(CLEANUP);
    // The claim reached the runner, and the run produced no result at all:
    // nothing is published and the second candidate is never taken.
    expect(harness.calls.claims).toEqual([REF.key]);
    expect(harness.calls.runs).toEqual([REF.key]);
    expect(harness.calls.completions).toEqual([]);
    const kept = await receipt(workDir);
    expect(kept?.runId).toBeUndefined();
    expect(kept?.problem).toBe('run: the run was stopped before its workspace was ready');
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(true);
  });

  it('stops intake when a timed-out run preflight wraps this stop', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      run: () => {
        throw new RunTimeoutError('the run deadline expired before its workspace was ready', {
          cause: unconfirmedGitStop(),
        });
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'stopped', attempted: 1, cleanupConfirmed: false });
    expect(summary.problem).toContain(`${REF.key}: run preflight`);
    expect(summary.problem).toContain(CLEANUP);
    expect(harness.calls.runs).toEqual([REF.key]);
    expect(harness.calls.completions).toEqual([]);
    // The claim's own reservation is what the next scan reads as "already
    // attempted" while a person settles the Git process; it names no run.
    const kept = await receipt(workDir);
    expect(kept?.runId).toBeUndefined();
    expect(kept?.problem).toContain('run: ');
    expect(kept?.problem).toContain('the run deadline expired');
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(true);
  });

  it('keeps the lock, the receipt and the retained workspace when reopening one fails this way', async () => {
    const workDir = await createTempDir();
    // The workspace a previous cycle retained, and the receipt its own earlier
    // attempt left: the item's pointer names it, so this claim would continue it.
    const workspace = await retainedWorkspace(workDir);
    await writeFile(path.join(workspace.workspacePath, 'partial.txt'), 'keep partial work', 'utf8');
    const held: SourceReceipt = {
      version: 1,
      source: REF,
      reservedAt: '2026-09-22T09:00:00.000Z',
    };
    await reserveReceipt(receiptFilePath(workDir, REF), held);
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      prepare: (found) => ({
        ref: found.ref,
        task: { ...TASK, id: found.ref.key },
        pointers: [workspace.workspaceId],
      }),
      preflight: async () => ({ sourceRoot: workspace.sourceRoot, baseCommit: BASE }),
    });
    // The verification reads the checkout with Git; this is what the read
    // reported — a stop the harness could not confirm, so the working copy may
    // still be written to. Any further read would reach the real Git and take
    // the case off this branch.
    const read = vi
      .spyOn(invocation, 'runInvocation')
      .mockResolvedValueOnce(unconfirmedGitInvocation());
    try {
      const summary = await runSource(harness.context, null);

      expect(summary).toMatchObject({ outcome: 'stopped', attempted: 0, cleanupConfirmed: false });
      expect(summary.problem).toContain(`${REF.key}: continuation verification`);
      expect(summary.problem).toContain('termination unconfirmed');
      expect(summary.problem).toContain(CLEANUP);
      // The one read the verification made is the one the case handed it.
      expect(read).toHaveBeenCalledTimes(1);
      // Nothing was claimed, run or published — not even a refusal, which would
      // take the item out of the queue on the strength of a failed reading — and
      // the second candidate was never read.
      expect(harness.calls.prepared).toEqual([REF.key]);
      expect(harness.calls.claims).toEqual([]);
      expect(harness.calls.runs).toEqual([]);
      expect(harness.calls.completions).toEqual([]);
      expect(harness.calls.refusals).toEqual([]);
      // The receipt, the ledger and the working copy are left exactly as they
      // were, and the lock stays for a person to inspect.
      expect(await receipt(workDir)).toEqual(held);
      expect(await readWorkspaceState(workDir, workspace.workspaceId)).toEqual(workspace.state);
      expect(await readFile(path.join(workspace.workspacePath, 'partial.txt'), 'utf8')).toBe(
        'keep partial work',
      );
      expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(true);
      expect(harness.calls.outputs.join('\n')).toContain('left in place for inspection');
    } finally {
      read.mockRestore();
    }
  });
});

/**
 * The reviewed finding a claim that continues a returned workspace may not
 * start without: the retained evidence beside the workspace says whether a
 * repair is required and which finding it carries, so the complete recorded
 * finding reaches the run even when the item's own thread cannot supply it, and
 * a required finding that cannot be read back starts no developer — the claimed
 * ticket is told why and taken out of the running status, with the same problem
 * recorded in its receipt (docs/WORKFLOW.md §11).
 */
describe('the reviewed finding a continued workspace was returned for', () => {
  const FINDING: BaselineFinding = {
    outcome: 'repair',
    failingCheck: '["npm", "run", "check"]',
    evidence: 'the check exits 1 because the fixture file is missing',
    likelyCause: 'the fixture file was never added',
    repairGuidance: 'add the fixture file the check reads',
  };
  const EVIDENCE_ID = 'e'.repeat(32);

  /** The diagnosis boundary, with only the reviewed finding the case supplies. */
  function diagnosisReviewing(result: BaselineReviewedFinding | Error): BaselineDiagnosis {
    return {
      diagnose: async () => {
        throw new Error('nothing on this path diagnoses fresh evidence');
      },
      reviewedFinding: async () => {
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    };
  }

  /** One claim over the item's own retained workspace, as its pointer names it. */
  function continuationHarness(
    workDir: string,
    workspace: { readonly workspaceId: string; readonly sourceRoot: string },
    diagnosis: BaselineDiagnosis,
    commentsSince?: (item: SourceTask) => Promise<readonly SourceComment[]>,
  ) {
    return coordinatorHarness(workDir, {
      candidates: [candidate()],
      baselineDiagnosis: diagnosis,
      prepare: (found) => ({
        ref: found.ref,
        task: { ...TASK, id: found.ref.key },
        pointers: [workspace.workspaceId],
      }),
      preflight: async () => ({ sourceRoot: workspace.sourceRoot, baseCommit: BASE }),
      ...(commentsSince === undefined ? {} : { commentsSince }),
    });
  }

  it('tells the run the complete recorded finding when the thread cannot supply it', async () => {
    const workDir = await createTempDir();
    // The workspace the red baseline's own attempt left: its ledger records that
    // attempt, and its thread has nothing it could supply.
    const workspace = await retainedWorkspace(workDir, [
      {
        runId: 'run-1',
        outcome: 'failed',
        reason: 'the baseline checks did not pass',
        endedAt: '2026-09-22T09:00:00.000Z',
        reportPath: path.join(workDir, 'runs', 'run-1', 'result.json'),
      },
    ]);
    const harness = continuationHarness(
      workDir,
      workspace,
      diagnosisReviewing({ kind: 'finding', evidenceId: EVIDENCE_ID, finding: FINDING }),
      async () => {
        throw new Error('the comment read timed out');
      },
    );

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 1, passed: 1 });
    expect(harness.calls.requests).toHaveLength(1);
    expect(harness.calls.requests[0]?.continuedWorkspace).toMatchObject({
      workspaceId: workspace.workspaceId,
      attempt: 2,
    });
    // Nothing of the thread is available here, and the finding is the one the
    // retained record holds: each field whole, in the order it must be acted
    // on, with nothing cut and nothing replaced by ordinary thread context.
    expect(harness.calls.requests[0]?.guidance).toEqual([
      'reviewed baseline finding — repair the baseline before continuing the original task',
      'reviewed baseline finding — failing check: ["npm", "run", "check"]',
      'reviewed baseline finding — evidence: the check exits 1 because the fixture file is missing',
      'reviewed baseline finding — likely cause: the fixture file was never added',
      'reviewed baseline finding — repair guidance: add the fixture file the check reads',
      'attempt 1 failed: the baseline checks did not pass',
    ]);
    // The read that failed is said out loud; the attempt goes on anyway, because
    // the finding it may not start without came from the retained evidence.
    expect(harness.calls.outputs.join('\n')).toContain(
      'its comments could not be read: the comment read timed out',
    );
  });

  it('starts no developer and tells the claimed ticket when the required finding cannot be read back', async () => {
    const workDir = await createTempDir();
    const workspace = await retainedWorkspace(workDir);
    const detail =
      'the finding kept beside its evidence cannot be read back: it is not there at all';
    const harness = continuationHarness(
      workDir,
      workspace,
      diagnosisReviewing({ kind: 'unreadable', detail }),
      async () => {
        throw new Error('the comment read timed out');
      },
    );

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'stopped', attempted: 1, cleanupConfirmed: true });
    expect(summary.problem).toContain('could not be read back');
    // No developer was started and nothing was published. The claimed ticket is
    // told on its own thread why — the unreadable required finding, with the
    // thread problem beside it — and taken out of the running status; its
    // receipt keeps the same problem and answers that the ticket was told.
    expect(harness.calls.claims).toEqual([REF.key]);
    expect(harness.calls.runs).toEqual([]);
    expect(harness.calls.completions).toEqual([]);
    expect(harness.calls.refusals).toHaveLength(1);
    expect(harness.calls.refusals[0]).toContain(`${REF.key}: attention: `);
    expect(harness.calls.refusals[0]).toContain('could not be read back');
    expect(harness.calls.refusals[0]).toContain('the comment read timed out');
    const kept = await receipt(workDir);
    expect(kept?.problem).toBe(`baseline: ${detail}`);
    expect(kept?.feedback).toBe('sent');
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(false);
  });

  it('starts no developer and tells the claimed ticket when reading the required finding fails', async () => {
    const workDir = await createTempDir();
    const workspace = await retainedWorkspace(workDir);
    const harness = continuationHarness(
      workDir,
      workspace,
      diagnosisReviewing(new Error('the evidence record cannot be read')),
    );

    const summary = await runSource(harness.context, null);

    // The thread was read and supplied nothing; that is not what is missing —
    // the record that says a repair is required could not be read, so no
    // ordinary continuation may start with the original task alone.
    expect(summary).toMatchObject({ outcome: 'stopped', attempted: 1, cleanupConfirmed: true });
    expect(harness.calls.claims).toEqual([REF.key]);
    expect(harness.calls.runs).toEqual([]);
    expect(harness.calls.completions).toEqual([]);
    expect(harness.calls.refusals).toHaveLength(1);
    expect(harness.calls.refusals[0]).toContain(`${REF.key}: attention: `);
    expect(harness.calls.refusals[0]).toContain('the evidence record cannot be read');
    const kept = await receipt(workDir);
    expect(kept?.problem).toBe('baseline: the evidence record cannot be read');
    expect(kept?.feedback).toBe('sent');
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(false);
  });
});

/**
 * The pre-delivery diagnosis of one completed red baseline on a fresh
 * workspace: the run, the reviewer turn and the delivery step are the case's
 * stand-ins, and what is asserted is the coordinator's own handoff — the item,
 * the fresh workspace and the red round the configured diagnosis is handed, the
 * repair marker a serial step reports back so the now-ready ticket is claimed
 * again for its repair, that nothing else about the attempt is published or
 * delivered, and that a diagnosis with nothing actionable stops intake with the
 * claimed ticket named (docs/WORKFLOW.md §11).
 */
describe('the pre-delivery diagnosis of a completed red baseline', () => {
  /** The run one fresh attempt produced: its baseline is red before any coding turn. */
  function redBaselineRun(workDir: string): RunTaskResult {
    return { ...runResult(workDir, 'failed'), baseline: checkRound('failed', 1) };
  }

  /** The diagnosis boundary, with only the outcome the case supplies. */
  function diagnosisDeciding(
    outcome: BaselineDiagnosisOutcome,
    diagnosed: BaselineDiagnosisRequest[],
  ): BaselineDiagnosis {
    return {
      diagnose: async (request) => {
        diagnosed.push(request);
        return outcome;
      },
      reviewedFinding: async () => {
        throw new Error('nothing on this path reads a finding back');
      },
    };
  }

  it('returns the ticket for its baseline repair instead of publishing the red attempt', async () => {
    const workDir = await createTempDir();
    const diagnosed: BaselineDiagnosisRequest[] = [];
    const delivered: DeliveryRequest[] = [];
    const harness = coordinatorHarness(workDir, {
      delivery: {
        deliver: async (request) => {
          delivered.push(request);
          return null;
        },
      },
      baselineDiagnosis: diagnosisDeciding(
        {
          kind: 'repair',
          detail: 'the finding is published; back in "To Do"',
          commentId: 'c1',
        },
        diagnosed,
      ),
      run: () => redBaselineRun(workDir),
    });

    const take = await takeOneItem(harness.context);

    // The marker travels back to the serial loop as this ticket's own next work:
    // a queue resumes the same ticket for its baseline repair, before anything
    // else it could take.
    expect(take.outcome).toBe('taken');
    expect(take.ticket?.ref.key).toBe(REF.key);
    expect(take.run?.returnedForBaselineRepair).toEqual({
      detail: 'the finding is published; back in "To Do"',
    });
    // The configured diagnosis saw the item, the fresh retained workspace and
    // the red round itself: the configured commands and the results they
    // produced, which is what its finding was made from.
    expect(harness.calls.runs).toEqual([REF.key]);
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]?.item.ref.key).toBe(REF.key);
    expect(diagnosed[0]?.item.task).toEqual(TASK);
    expect(diagnosed[0]?.workspace).toEqual({
      workspaceId: REF.key,
      workspacePath: workspacePathFor(workDir, REF.key),
      branch: `harness/${REF.key}`,
      baseCommit: BASE,
    });
    expect(diagnosed[0]?.baseline).toEqual(checkRound('failed', 1));
    // Nothing else about the attempt happened: no ordinary result comment, no
    // rung's comment, and no delivery of a red baseline.
    expect(harness.calls.completions).toEqual([]);
    expect(harness.calls.progresses).toEqual([]);
    expect(delivered).toEqual([]);
    expect(harness.calls.outputs.join('\n')).toContain(
      'the issue holds the finding and is back in its ready status',
    );
    // The receipt records that the issue was told, so a restart reads a sent
    // outcome rather than a pending one.
    expect(await receipt(workDir)).toMatchObject({
      outcome: 'failed',
      runId: 'run-1',
      feedback: 'sent',
      commentId: 'c1',
    });
  });

  it('stops for a person when the diagnosis found nothing actionable', async () => {
    const workDir = await createTempDir();
    const diagnosed: BaselineDiagnosisRequest[] = [];
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate()],
      baselineDiagnosis: diagnosisDeciding(
        {
          kind: 'attention',
          detail: `${REF.key}: no baseline repair is actionable (comment c1), so the issue holds the evidence`,
          commentId: 'c1',
          cleanupConfirmed: true,
        },
        diagnosed,
      ),
      run: () => redBaselineRun(workDir),
    });

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'stopped', attempted: 1, cleanupConfirmed: true });
    expect(summary.problem).toContain('no baseline repair is actionable');
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]?.baseline).toEqual(checkRound('failed', 1));
    // The red attempt was not published as an ordinary failure, nothing was
    // delivered, and the item waits In Review with what a person must do.
    expect(harness.calls.completions).toEqual([]);
    expect(harness.calls.progresses).toEqual([]);
    const kept = await receipt(workDir);
    expect(kept).toMatchObject({
      outcome: 'failed',
      runId: 'run-1',
      feedback: 'sent',
      commentId: 'c1',
    });
    expect(kept?.problem).toContain('baseline: ');
    // The diagnosis stopped cleanly, so the lock is released as usual.
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(false);
  });
});

describe('delivering a passed attempt before its result is published', () => {
  /** The pull request a case's delivery stand-in answers with. */
  const PULL_REQUEST: DeliveredPullRequest = {
    url: 'https://github.com/example-owner/example-repo/pull/7',
    number: 7,
    head: 'b'.repeat(40),
    created: true,
  };

  it('delivers first and carries the pull request into the published result', async () => {
    const workDir = await createTempDir();
    const events: string[] = [];
    const requests: DeliveryRequest[] = [];
    const harness = coordinatorHarness(workDir, {
      delivery: {
        deliver: async (request) => {
          events.push('deliver');
          requests.push(request);
          return PULL_REQUEST;
        },
      },
    });
    const complete = harness.context.source.complete;
    harness.context.source.complete = async (item, outcome, stop) => {
      events.push('complete');
      return await complete(item, outcome, stop);
    };

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 1, passed: 1 });
    // Delivery comes first, and it is handed the working copy the run left:
    // the published result is what carries the pull request it produced.
    expect(events).toEqual(['deliver', 'complete']);
    expect(requests).toEqual([
      {
        workspacePath: path.join(workDir, 'workspaces', REF.key),
        branch: `harness/${REF.key}`,
        baseCommit: BASE,
        logsDir: path.join(workDir, 'runs', 'run-1', 'logs'),
        runId: 'run-1',
        reportPath: path.join(workDir, 'runs', 'run-1', 'result.json'),
        task: { id: REF.key, title: TASK.title },
        checks: 'no check round was completed for this run',
        sourceRef: REF,
      },
    ]);
    expect(harness.calls.completions).toHaveLength(1);
    expect(harness.calls.completions[0]?.outcome).toMatchObject({
      status: 'passed',
      pullRequest: PULL_REQUEST,
    });
    expect(await receipt(workDir)).toMatchObject({ outcome: 'passed', feedback: 'sent' });
    expect(harness.calls.outputs.join('\n')).toContain(`pull request created: ${PULL_REQUEST.url}`);
  });

  it('never asks the delivery step for a failed or cancelled attempt', async () => {
    const workDir = await createTempDir();
    const requests: DeliveryRequest[] = [];
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      run: (request) =>
        request.sourceRef.key === REF.key
          ? runResult(workDir, 'failed')
          : stoppedRun(workDir, 'confirmed'),
      delivery: {
        deliver: async (request) => {
          requests.push(request);
          return null;
        },
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary.failed).toBe(1);
    expect(summary.cancelled).toBe(1);
    // Both outcomes were published as they were; only a pass reaches delivery,
    // so the failed and cancelled work stayed local (docs/WORKFLOW.md §8).
    expect(requests).toEqual([]);
    expect(harness.calls.completions.map((entry) => entry.outcome.status)).toEqual([
      'failed',
      'cancelled',
    ]);
    expect(harness.calls.completions[0]?.outcome.pullRequest).toBeUndefined();
    expect(harness.calls.completions[1]?.outcome.pullRequest).toBeUndefined();
  });

  it('tells the issue the passed outcome with the delivery failure, then stops intake', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      delivery: {
        deliver: async () => {
          throw new DeliveryError('git push failed: authentication required');
        },
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('authentication required');
    // The retry advice is an operator step, never a return to the ready status
    // that would start a coding run to repair a publishing failure.
    expect(summary.problem).toContain('check the destination repository');
    expect(summary.problem).toContain('starts a new coding run');
    expect(summary.problem).not.toContain('ready status to retry');
    // The issue is still told the outcome the run produced, with the failure
    // beside it, and the next ticket is never taken.
    expect(harness.calls.runs).toEqual([REF.key]);
    expect(harness.calls.completions).toHaveLength(1);
    expect(harness.calls.completions[0]).toMatchObject({
      key: REF.key,
      outcome: {
        status: 'passed',
        deliveryFailure: 'git push failed: authentication required',
      },
    });
    expect(harness.calls.completions[0]?.outcome.pullRequest).toBeUndefined();
    // The run keeps its own evidence, and the receipt records what failed.
    expect(await receipt(workDir)).toMatchObject({
      outcome: 'passed',
      feedback: 'sent',
      resultPath: path.join(workDir, 'runs', 'run-1', 'result.json'),
      problem: 'delivery: git push failed: authentication required',
    });
  });

  it('keeps the run evidence when the delivery failure cannot be told to the issue either', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      delivery: {
        deliver: async () => {
          throw new DeliveryError('git push failed: authentication required');
        },
      },
      complete: async () => {
        throw new Error('Jira is unreachable');
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('git push failed: authentication required');
    expect(summary.problem).toContain('Jira is unreachable');
    // A Jira failure here costs the run nothing: its outcome, its report and
    // the delivery problem stay in the receipt exactly as they were written.
    expect(await receipt(workDir)).toMatchObject({
      outcome: 'passed',
      feedback: 'failed',
      resultPath: path.join(workDir, 'runs', 'run-1', 'result.json'),
      problem: 'delivery: git push failed: authentication required; feedback: Jira is unreachable',
    });
  });

  it('publishes a passed attempt normally when the configured step finds nothing to deliver', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      delivery: { deliver: async () => null },
    });

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 1, passed: 1 });
    expect(harness.calls.completions).toHaveLength(1);
    expect(harness.calls.completions[0]?.outcome.pullRequest).toBeUndefined();
    expect((await receipt(workDir))?.feedback).toBe('sent');
    expect(harness.calls.outputs.join('\n')).toContain('nothing to deliver');
  });
});

/**
 * The escalation ladder one claim climbs: one attempt per rung, each its own run
 * in the same retained workspace, an intermediate rung's own comment published
 * while the item stays in the running status, and — when a ticket comes back to
 * work in a workspace whose attempts have already spent the ladder — the first
 * developer invocation of the new cycle is the first configured tier again, with
 * the guidance the workspace's own ledger and the item's thread carry
 * (docs/implement-workspace-continuation.md).
 */
describe('the escalation ladder one claim climbs', () => {
  const TIERS: readonly EscalationTier[] = [
    {
      name: 'flash',
      agent: { runtime: 'codex', command: ['codex', '--model', 'flash'] },
      maxRepairs: 1,
    },
    {
      name: 'pro',
      agent: { runtime: 'codex', command: ['codex', '--model', 'pro'] },
      maxRepairs: 2,
    },
  ];

  it('climbs to the configured next tier in the same workspace, publishing the rung before the result', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      tiers: TIERS,
      candidates: [candidate()],
      run: (request) =>
        request.tier?.name === 'flash' ? exhaustedRung(workDir, 1) : runResult(workDir),
      progress: async () => ({ commentId: '9001', text: 'published' }),
    });

    const summary = await runSource(harness.context, null);

    // One issue, two attempts, one entry in the counters: the climb ended at the
    // rung that passed.
    expect(summary).toMatchObject({ outcome: 'completed', attempted: 1, passed: 1, failed: 0 });
    expect(harness.calls.requests.map((request) => request.tier?.name)).toEqual(['flash', 'pro']);
    // The second rung works in the workspace the first attempt made — the record
    // its own run carried — as the workspace's next attempt.
    expect(harness.calls.requests[0]?.continuedWorkspace).toBeUndefined();
    expect(harness.calls.requests[1]?.continuedWorkspace).toEqual({
      workspaceId: REF.key,
      workspacePath: workspacePathFor(workDir, REF.key),
      branch: `harness/${REF.key}`,
      baseCommit: BASE,
      attempt: 2,
    });
    // The intermediate rung's own comment is published while the item stays in
    // the running status; only the last rung's result moves it to review.
    expect(harness.calls.progresses.map((entry) => entry.outcome.attempt)).toEqual([
      { number: 1, of: 2, tier: 'flash' },
    ]);
    expect(harness.calls.completions.map((entry) => entry.outcome.attempt)).toEqual([
      { number: 2, of: 2, tier: 'pro' },
    ]);
    expect(harness.calls.publications).toEqual([
      `progress:${REF.key}:failed`,
      `complete:${REF.key}:passed`,
    ]);
    expect(harness.calls.outputs.join('\n')).toContain('the issue stays in the running status');
    expect(harness.calls.outputs.join('\n')).toContain('escalating to tier pro (attempt 2 of 2)');
    expect(await receipt(workDir)).toMatchObject({
      outcome: 'passed',
      feedback: 'sent',
      runId: 'run-1',
    });
  });

  it('restarts a ticket that came back to work at the first tier of its retained workspace', async () => {
    const workDir = await createTempDir();
    // The workspace two attempts of an earlier cycle left, in the ledger and the
    // checkout the next claim continues.
    const workspace = await retainedWorkspace(workDir, [
      {
        runId: 'run-1',
        outcome: 'failed',
        tier: 'flash',
        reason: 'the first rung left the greeting missing',
        endedAt: '2026-09-22T09:00:00.000Z',
        reportPath: path.join(workDir, 'runs', 'run-1', 'result.json'),
      },
      {
        runId: 'run-2',
        outcome: 'failed',
        tier: 'pro',
        reason: 'the second rung left the greeting unpunctuated',
        endedAt: '2026-09-22T10:00:00.000Z',
        reportPath: path.join(workDir, 'runs', 'run-2', 'result.json'),
      },
    ]);
    const harness = coordinatorHarness(workDir, {
      tiers: TIERS,
      candidates: [candidate()],
      prepare: (found) => ({
        ref: found.ref,
        task: { ...TASK, id: found.ref.key },
        pointers: [workspace.workspaceId],
      }),
      preflight: async () => ({ sourceRoot: workspace.sourceRoot, baseCommit: BASE }),
      commentsSince: async () => [
        {
          author: 'Nexus Lens',
          createdAt: '2026-09-23T09:00:00.000Z',
          text: 'the reviewer asked for the greeting to end in a newline',
        },
      ],
    });

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 1, passed: 1 });
    // The cycle's first rung is the first configured tier, whatever the
    // workspace's own attempt count has reached — and it continues that same
    // workspace, at its next attempt.
    expect(harness.calls.requests.map((request) => request.tier?.name)).toEqual(['flash']);
    expect(harness.calls.requests[0]?.continuedWorkspace).toEqual({
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      baseCommit: workspace.baseCommit,
      attempt: 3,
    });
    // What the attempts before it did, and what the item's own thread said
    // since, travels with the attempt as its guidance.
    expect(harness.calls.requests[0]?.guidance).toEqual([
      'attempt 1 (tier flash) failed: the first rung left the greeting missing',
      'attempt 2 (tier pro) failed: the second rung left the greeting unpunctuated',
      'comment by Nexus Lens at 2026-09-23T09:00:00.000Z: ' +
        'the reviewer asked for the greeting to end in a newline',
    ]);
    // This cycle's own ladder may still climb; this attempt passed, so it did
    // not, and the issue is told the result once.
    expect(harness.calls.progresses).toEqual([]);
    expect(harness.calls.completions).toHaveLength(1);
    expect(harness.calls.completions[0]?.outcome.attempt).toEqual({
      number: 1,
      of: 2,
      tier: 'flash',
    });
  });
});

/**
 * One source watch whose scans, reads and waits the case controls. The item and
 * the agent turn are the same stand-ins a finite batch is driven with; the
 * idle wait is where a case ends the watch.
 */
function watchHarness(parts: {
  readonly workDir: string;
  readonly list: (scan: number) => Promise<readonly SourceCandidate[]>;
  readonly prepare?: (found: SourceCandidate) => Promise<SourceTask | null>;
  /** The source/output preflight the watch scans under; a passing one when absent. */
  readonly preflight?: SourceContext['preflight'];
  /** The pending diagnosis the case supplies; absent means the phase is off. */
  readonly baselineDiagnosis?: SourceContext['baselineDiagnosis'];
  readonly waits: number[];
  /** Called after each wait was recorded; the case may end the watch here. */
  readonly afterWait?: (count: number) => void;
}) {
  const harness = coordinatorHarness(parts.workDir, {
    ...(parts.preflight === undefined ? {} : { preflight: parts.preflight }),
    ...(parts.baselineDiagnosis === undefined
      ? {}
      : { baselineDiagnosis: parts.baselineDiagnosis }),
  });
  const stop = new AbortController();
  let scans = 0;
  const prepare = parts.prepare;
  const context: SourceWatchOptions = {
    ...harness.context,
    stop: stop.signal,
    pollIntervalMs: 30_000,
    source: {
      ...harness.context.source,
      listEligible: async () => {
        scans += 1;
        return await parts.list(scans);
      },
      ...(prepare === undefined
        ? {}
        : { prepare: async (found: SourceCandidate) => await prepare(found) }),
    },
    sleep: async (ms) => {
      parts.waits.push(ms);
      parts.afterWait?.(parts.waits.length);
    },
  };
  return { harness, stop, scans: () => scans, context };
}

describe('the source watch', () => {
  it('scans, processes a batch, waits the interval, and picks up later work', async () => {
    const workDir = await createTempDir();
    const waits: number[] = [];
    const stop = new AbortController();
    const watch = watchHarness({
      workDir,
      waits,
      list: async (scan) => (scan === 1 ? [] : [candidate()]),
      afterWait: (count) => {
        // The second wait follows the run the later scan found: the watch has
        // scanned again, run the ticket, and is idle once more.
        if (count === 2) {
          stop.abort(new Error('stop watching'));
        }
      },
    });

    const summary = await watchSource({
      ...watch.context,
      stop: stop.signal,
    });

    expect(watch.scans()).toBe(2);
    expect(waits).toEqual([30_000, 30_000]);
    expect(summary).toMatchObject({ outcome: 'cancelled', attempted: 1, passed: 1 });
    expect(watch.harness.calls.runs).toEqual([REF.key]);
    // Nothing outlives the watch: the lock it held is released.
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(false);
  });

  it('waits out a server-directed delay after a read failure, and never shortens it', async () => {
    const workDir = await createTempDir();
    const waits: number[] = [];
    const stop = new AbortController();
    const watch = watchHarness({
      workDir,
      waits,
      list: async (scan) => {
        if (scan === 1) {
          throw new SourceError('retryable-read', 'the search answered HTTP 429', {
            retryAfterMs: 600_000,
          });
        }
        return [];
      },
      afterWait: (count) => {
        if (count === 2) {
          stop.abort(new Error('stop watching'));
        }
      },
    });

    const summary = await watchSource({ ...watch.context, stop: stop.signal });

    expect(watch.scans()).toBe(2);
    expect(waits).toEqual([600_000, 30_000]);
    expect(watch.harness.calls.outputs.join('\n')).toContain('retrying in 600000 ms');
    expect(summary.outcome).toBe('cancelled');
  });

  it('retries a read that failed before any reservation with its own backoff', async () => {
    const workDir = await createTempDir();
    const waits: number[] = [];
    const stop = new AbortController();
    let reads = 0;
    const watch = watchHarness({
      workDir,
      waits,
      list: async () => [candidate()],
      prepare: async (found) => {
        reads += 1;
        if (reads === 1) {
          throw new SourceError('retryable-read', 'the issue read timed out');
        }
        return prepared(found);
      },
      afterWait: (count) => {
        if (count === 2) {
          stop.abort(new Error('stop watching'));
        }
      },
    });

    const summary = await watchSource({ ...watch.context, stop: stop.signal });

    // Nothing was claimed or reserved by the read that failed, so the watch
    // backs off by its own base and asks again instead of stopping.
    expect(waits).toEqual([WATCH_BACKOFF_BASE_MS, 30_000]);
    expect(summary).toMatchObject({ outcome: 'cancelled', passed: 1 });
    expect((await receipt(workDir))?.feedback).toBe('sent');
  });

  it('stops on a fatal failure instead of retrying it', async () => {
    const workDir = await createTempDir();
    const waits: number[] = [];
    const watch = watchHarness({
      workDir,
      waits,
      list: async () => {
        throw new SourceError('fatal', 'the configured token was not accepted');
      },
    });

    const summary = await watchSource(watch.context);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('the configured token was not accepted');
    expect(waits).toEqual([]);
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(false);
  });

  it('keeps the lock and polls no further when a scan stops on an unconfirmed Git stop', async () => {
    const workDir = await createTempDir();
    const waits: number[] = [];
    let readings = 0;
    const watch = watchHarness({
      workDir,
      waits,
      list: async () => [candidate()],
      preflight: async () => {
        readings += 1;
        // The watch's own reading passes; the item's own recheck, inside the
        // first scan, is the one that could not be stopped.
        if (readings === 1) {
          return { sourceRoot: path.join(workDir, 'source'), baseCommit: BASE };
        }
        throw unconfirmedGitStop();
      },
    });

    const summary = await watchSource(watch.context);

    expect(summary).toMatchObject({ outcome: 'stopped', attempted: 0, cleanupConfirmed: false });
    expect(summary.problem).toContain(CLEANUP);
    // The loop ends where the batch did: no wait, no second scan, and the lock
    // this watch was holding is left in place for inspection.
    expect(waits).toEqual([]);
    expect(watch.scans()).toBe(1);
    expect(existsSync(intakeLockPath(workDir, NAMESPACE))).toBe(true);
  });
});

describe('the intake lock one consumer holds', () => {
  it('refuses a second consumer of the same connected project before anything is discovered', async () => {
    const workDir = await createTempDir();
    const held = await acquireIntakeLock(workDir, NAMESPACE, () => new Date());
    const harness = coordinatorHarness(workDir, { candidates: [candidate()] });

    const thrown = await runSource(harness.context, null).catch((cause: unknown) => cause);
    await held.release();

    expect(thrown).toBeInstanceOf(SourceError);
    expect((thrown as Error).message).toContain('another intake consumer holds');
    // Nothing was discovered, claimed or run under the held lock.
    expect(harness.calls.lists).toBe(0);
    expect(harness.calls.claims).toEqual([]);
    expect(harness.calls.runs).toEqual([]);
  });

  it('never removes or adopts a lock whose owner record is not this process', async () => {
    const workDir = await createTempDir();
    const dir = intakeLockPath(workDir, NAMESPACE);
    await mkdir(dir, { recursive: true });
    const owner = path.join(dir, 'owner.json');
    const contents = `${JSON.stringify({
      version: 1,
      pid: 999999,
      startedAt: '2026-01-01T00:00:00.000Z',
      token: 'someone-else',
    })}\n`;
    await writeFile(owner, contents, 'utf8');

    const thrown = await acquireIntakeLock(workDir, NAMESPACE, () => new Date()).catch(
      (cause: unknown) => cause,
    );

    expect(thrown).toBeInstanceOf(SourceError);
    expect((thrown as Error).message).toContain('another intake consumer holds');
    // The lock and the owner it names are left exactly as they were found.
    expect(await readFile(owner, 'utf8')).toBe(contents);
  });

  it('refuses to release a lock that is no longer its own', async () => {
    const workDir = await createTempDir();
    const lock = await acquireIntakeLock(workDir, NAMESPACE, () => new Date());
    await writeFile(
      path.join(lock.dir, 'owner.json'),
      `${JSON.stringify({ version: 1, token: 'someone-else' })}\n`,
      'utf8',
    );

    await expect(lock.release()).rejects.toThrow(/no longer this process's lock/);
    expect(existsSync(lock.dir)).toBe(true);
  });

  it.each(['stale', 'malformed', 'missing owner'])(
    'refuses the legacy whole-directory lock with %s metadata without changing it',
    async (state) => {
      const workDir = await createTempDir();
      const legacy = path.join(workDir, '.intake', 'lock');
      await mkdir(legacy, { recursive: true });
      const owner = path.join(legacy, 'owner.json');
      const contents =
        state === 'malformed'
          ? '{'
          : `${JSON.stringify({
              version: 1,
              pid: 999999,
              startedAt: '2020-01-01T00:00:00.000Z',
              token: 'legacy-owner',
            })}\n`;
      if (state !== 'missing owner') {
        await writeFile(owner, contents, 'utf8');
      }

      const thrown = await acquireIntakeLock(workDir, NAMESPACE, () => new Date()).catch(
        (cause: unknown) => cause,
      );

      expect(thrown).toBeInstanceOf(SourceError);
      expect((thrown as Error).message).toContain(
        'Inspect that lock and stop its owner before removing it by hand',
      );
      expect(existsSync(legacy)).toBe(true);
      if (state !== 'missing owner') {
        expect(await readFile(owner, 'utf8')).toBe(contents);
      }
    },
  );
});
