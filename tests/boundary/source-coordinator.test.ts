/**
 * The intake coordinator's retained state and the decisions it makes over one
 * run's own ending, as real files under one output directory: the receipt that
 * reserves an item before anything remote or paid happens, the per-project lock
 * that admits one consumer at a time, the delivery of a passed attempt before
 * its result is published, and the watch cadence over that state — the poll
 * interval, a retry that waits out the delay the source asked for, and a failure
 * that stops the loop instead.
 *
 * The item, the agent turn, the delivery step and the service answers are the
 * case's stand-ins — the coordinator starts no runtime, no command and no real
 * `git` here — while the receipt file, its exclusive creation, its atomic
 * replacement and the lock directory are the harness's own code, on a real
 * temporary filesystem. What is asserted is the documented intake behavior
 * (docs/spec.md §6, docs/WORKFLOW.md §8): an item is never attempted twice from
 * one output directory, an uncertain claim keeps the receipt it just created and
 * stops intake for a person, a rejected claim releases only the reservation this
 * process made, a failed publication keeps the local result and stops, a run
 * whose own stop could not be confirmed publishes nothing and keeps its receipt
 * and the lock, a confirmed stop still gets its one bounded feedback under a
 * deadline of its own, a passed attempt is delivered before its result is
 * published and failed or cancelled work never reaches delivery, a delivery
 * failure is published beside the outcome the run produced before intake stops,
 * and a lock is never broken, adopted, or removed by a process that does not own
 * it.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeliveredPullRequest, Delivery, DeliveryRequest } from '../../src/delivery/github.js';
import { DeliveryError } from '../../src/delivery/github.js';
import type { RunTaskResult } from '../../src/runs/contracts.js';
import { summarizeChanges } from '../../src/reporting/changes.js';
import type {
  CheckRoundResult,
  RoundOutcome,
  SourceRef,
  Task,
  TerminationOutcome,
} from '../../src/shared/types.js';
import type {
  SourceCandidate,
  SourceRunOutcome,
  SourceRunRequest,
  SourceTask,
  SourceContext,
  TaskSource,
} from '../../src/sources/contract.js';
import { SourceError, SourceFeedbackError } from '../../src/sources/contract.js';
import { runSource, WATCH_BACKOFF_BASE_MS, watchSource } from '../../src/sources/coordinator.js';
import type { SourceWatchOptions } from '../../src/sources/coordinator.js';
import type { SourceReceipt } from '../../src/sources/receipts.js';
import {
  acquireIntakeLock,
  intakeLockPath,
  readReceipt,
  receiptFilePath,
} from '../../src/sources/receipts.js';
import { createTempDir } from './integration-support.js';

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

/** What one coordinator case watches: the calls its stand-in source received. */
interface CoordinatorCalls {
  readonly lists: number;
  readonly prepared: string[];
  readonly claims: string[];
  readonly runs: string[];
  readonly refusals: string[];
  /** One entry per published result, with the outcome it was published as. */
  readonly completions: Array<{ readonly key: string; readonly outcome: SourceRunOutcome }>;
  readonly outputs: string[];
}

/** One intake over a temporary output directory, with every collaborator named. */
function coordinatorHarness(
  workDir: string,
  parts: {
    readonly candidates?: readonly SourceCandidate[];
    readonly claim?: (item: SourceTask) => Promise<boolean>;
    readonly complete?: (
      item: SourceTask,
      outcome: SourceRunOutcome,
    ) => Promise<{ readonly commentId: string; readonly text: string }>;
    /** The run each stand-in agent turn produced; a passed one when absent. */
    readonly run?: (request: SourceRunRequest) => Promise<RunTaskResult> | RunTaskResult;
    /** The delivery step the case configures; absent means delivery is off. */
    readonly delivery?: Delivery;
  } = {},
) {
  const recorder = {
    lists: 0,
    prepared: [] as string[],
    claims: [] as string[],
    runs: [] as string[],
    refusals: [] as string[],
    completions: [] as Array<{ key: string; outcome: SourceRunOutcome }>,
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
      return prepared(found);
    },
    claim: async (item) => {
      recorder.claims.push(item.ref.key);
      return parts.claim === undefined ? true : await parts.claim(item);
    },
    progress: async (item) => {
      throw new Error(`no ladder rung published a progress comment for ${item.ref.key}`);
    },
    complete: async (item, outcome) => {
      recorder.completions.push({ key: item.ref.key, outcome });
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
    commentsSince: async () => [],
  };
  const context: SourceContext = {
    source,
    workDir,
    lockNamespace: NAMESPACE,
    tiers: [{ name: 'default', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 }],
    repoPath: path.join(workDir, 'source'),
    io: {
      out: (text) => recorder.outputs.push(text),
      err: (text) => recorder.outputs.push(text),
    },
    stop: stop.signal,
    preflight: async () => ({ sourceRoot: path.join(workDir, 'source'), baseCommit: BASE }),
    ...(parts.delivery === undefined ? {} : { delivery: parts.delivery }),
    run: async (request) => {
      recorder.runs.push(request.sourceRef.key);
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
 * One source watch whose scans, reads and waits the case controls. The item and
 * the agent turn are the same stand-ins a finite batch is driven with; the
 * idle wait is where a case ends the watch.
 */
function watchHarness(parts: {
  readonly workDir: string;
  readonly list: (scan: number) => Promise<readonly SourceCandidate[]>;
  readonly prepare?: (found: SourceCandidate) => Promise<SourceTask | null>;
  readonly waits: number[];
  /** Called after each wait was recorded; the case may end the watch here. */
  readonly afterWait?: (count: number) => void;
}) {
  const harness = coordinatorHarness(parts.workDir, {});
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
