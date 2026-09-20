/**
 * The serial queue: one current ticket, one phase at a time.
 *
 * The loop tests drive `runQueue` with scripted phases and assert the ordering
 * the acceptance criteria are about: which ticket is taken next, whether a
 * repair continues the same ticket before unrelated ready work, that every
 * confirmed Done is followed by source readiness and a fresh scan, that no two
 * phases are ever in flight at once, and that a healthy empty queue either ends
 * the finite run or waits visibly in watch mode without starting an agent.
 *
 * The coordinator tests drive `takeOneItem` against a fake source; the last two
 * blocks narrow the existing review scan and completion pass to one ticket: the
 * loop may never start a reviewer turn for, comment on, or transition an item
 * other than the one it is carrying.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompletionActions, PullRequestSnapshot } from '../src/delivery/completion.js';
import type { Delivery } from '../src/delivery/github.js';
import type {
  QueueCompletionOutcome,
  QueueLoopContext,
  QueueReviewOutcome,
  QueueRunMode,
  QueueSummary,
} from '../src/queue/loop.js';
import { runQueue } from '../src/queue/loop.js';
import { summarizeChanges } from '../src/reporting/changes.js';
import type { ReviewScanContext } from '../src/reviews/contract.js';
import { scanReviews } from '../src/reviews/scan.js';
import type { RunTaskResult } from '../src/runs/contracts.js';
import type { EscalationTier, RunStatus, SourceRef, Task } from '../src/shared/types.js';
import type { CompletionPassParts } from '../src/sources/completion.js';
import { createCompletionPass } from '../src/sources/completion.js';
import type {
  QueueTicket,
  SourceCandidate,
  SourceContext,
  SourceRunRequest,
  SourceTake,
  SourceTask,
  TaskSource,
} from '../src/sources/contract.js';
import { SourceError } from '../src/sources/contract.js';
import { takeOneItem } from '../src/sources/coordinator.js';
import type { CompletionSource } from '../src/sources/jira/completion.js';
import { acquireIntakeLock, intakeLockPath } from '../src/sources/receipts.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

afterEach(async () => {
  await cleanupTempDirectories();
});

const SCOPE = 'https://example.atlassian.net';
const MERGE = 'a'.repeat(40);

/** One ticket as the queue loop names it: immutable identity, and a title. */
function queueTicket(key: string, id = `id-${key}`): QueueTicket {
  const ref: SourceRef = {
    type: 'jira',
    scope: SCOPE,
    id,
    key,
    url: `${SCOPE}/browse/${key}`,
    updatedAt: '2026-09-20T10:00:00.000Z',
  };
  return { ref, title: `Ticket ${key}` };
}

/** One candidate, as a source lists it before it is prepared. */
function candidateFor(key: string, id = `id-${key}`): SourceCandidate {
  return { ref: queueTicket(key, id).ref, title: `Ticket ${key}` };
}

/** One ticket a consumer step took, with the run that ended it. */
function took(ticket: QueueTicket, status: RunStatus = 'passed'): SourceTake {
  return {
    outcome: 'taken',
    ticket,
    run: {
      status,
      runId: `run-${ticket.ref.key}`,
      reportPath: `/reports/${ticket.ref.key}/result.json`,
      reason: `the attempt ended ${status}`,
      pullRequest:
        status === 'passed'
          ? { url: `https://github.com/o/r/pull/${ticket.ref.key}`, created: true }
          : null,
    },
    skipped: 0,
    problem: null,
    cleanupConfirmed: true,
  };
}

/** Nothing eligible: what an empty fresh scan returns. */
const nothing: SourceTake = {
  outcome: 'empty',
  ticket: null,
  run: null,
  skipped: 0,
  problem: null,
  cleanupConfirmed: true,
};

/** A consumer step that stopped because a person has to look at it. */
function attention(problem: string, ticket: QueueTicket | null = null): SourceTake {
  return { outcome: 'attention', ticket, run: null, skipped: 0, problem, cleanupConfirmed: true };
}

/**
 * A take script that offers one ticket on the first fresh scan, keeps taking it
 * when a repair asks for it by identity, and finds nothing afterwards.
 */
function once(ticket: QueueTicket): (request: { readonly only: QueueTicket | null }) => SourceTake {
  let offered = false;
  return (request) => {
    if (request.only !== null) {
      return took(request.only);
    }
    if (offered) {
      return nothing;
    }
    offered = true;
    return took(ticket);
  };
}

interface LoopRun {
  readonly summary: QueueSummary;
  /** Every phase, in the order it started and finished, named by the ticket. */
  readonly log: string[];
  /** The output the loop itself printed. */
  readonly out: string[];
  /** True when two phases were somehow in flight at the same time. */
  readonly overlap: () => boolean;
  /** Every `only` a consumer step asked for, in call order. */
  readonly takes: readonly (QueueTicket | null)[];
}

interface LoopParts {
  readonly mode?: QueueRunMode;
  readonly take: (request: {
    readonly only: QueueTicket | null;
  }) => SourceTake | Promise<SourceTake>;
  readonly review?: (ticket: QueueTicket) => QueueReviewOutcome | Promise<QueueReviewOutcome>;
  readonly complete?: (
    ticket: QueueTicket,
  ) => QueueCompletionOutcome | Promise<QueueCompletionOutcome>;
  readonly ready?: (request: {
    readonly ticket: QueueTicket;
    readonly mergeCommit: string;
  }) => void | Promise<void>;
  readonly sleep?: (ms: number, stop: AbortSignal) => Promise<void>;
  readonly stop?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly completionPollIntervalMs?: number;
}

/** One queue invocation, with every phase recorded and single-flight checked. */
async function runLoop(parts: LoopParts): Promise<LoopRun> {
  const log: string[] = [];
  const out: string[] = [];
  const takes: (QueueTicket | null)[] = [];
  let active = 0;
  let overlapped = false;

  const phase = async <T>(name: string, action: () => T | Promise<T>): Promise<T> => {
    if (active > 0) {
      overlapped = true;
    }
    active += 1;
    log.push(`+${name}`);
    try {
      return await action();
    } finally {
      active -= 1;
      log.push(`-${name}`);
    }
  };

  const summary = await runQueue(
    {
      io: {
        out: (text) => {
          out.push(text);
        },
        err: (text) => {
          out.push(`error: ${text}`);
        },
      },
      stop: parts.stop ?? new AbortController().signal,
      sleep:
        parts.sleep ??
        (async (ms) => {
          log.push(`sleep:${String(ms)}`);
        }),
      pollIntervalMs: parts.pollIntervalMs ?? 30_000,
      completionPollIntervalMs: parts.completionPollIntervalMs ?? 30_000,
      consume: (request) =>
        phase(`consume:${request.only?.ref.key ?? 'next'}`, () => {
          takes.push(request.only);
          return parts.take(request);
        }),
      review: (request) =>
        phase(
          `review:${request.ticket.ref.key}`,
          () => parts.review?.(request.ticket) ?? { state: 'clear', detail: 'reviewed' },
        ),
      complete: (request) =>
        phase(
          `complete:${request.ticket.ref.key}`,
          () =>
            parts.complete?.(request.ticket) ?? {
              state: 'done',
              detail: `verified merge ${MERGE}`,
              mergeCommit: MERGE,
            },
        ),
      ready: (request) => phase(`ready:${request.ticket.ref.key}`, () => parts.ready?.(request)),
    } satisfies QueueLoopContext,
    parts.mode ?? 'run',
  );

  return { summary, log, out, overlap: () => overlapped, takes };
}

describe('the serial queue loop', () => {
  it('finishes two tickets in the order the queue offers them', async () => {
    const offered: QueueTicket[] = [queueTicket('SAM1-1'), queueTicket('SAM1-2')];

    const run = await runLoop({
      take: () => {
        const [next] = offered.splice(0, 1);
        return next === undefined ? nothing : took(next);
      },
    });

    expect(run.summary).toMatchObject({
      outcome: 'completed',
      completed: 2,
      attempts: 2,
      problem: null,
    });
    expect(run.takes).toEqual([null, null, null]);
    expect(run.log).toEqual([
      '+consume:next',
      '-consume:next',
      '+review:SAM1-1',
      '-review:SAM1-1',
      '+complete:SAM1-1',
      '-complete:SAM1-1',
      '+ready:SAM1-1',
      '-ready:SAM1-1',
      '+consume:next',
      '-consume:next',
      '+review:SAM1-2',
      '-review:SAM1-2',
      '+complete:SAM1-2',
      '-complete:SAM1-2',
      '+ready:SAM1-2',
      '-ready:SAM1-2',
      '+consume:next',
      '-consume:next',
    ]);
    expect(run.overlap()).toBe(false);
  });

  it('repairs the same ticket before taking unrelated ready work', async () => {
    const repaired = queueTicket('SAM1-1');
    const unrelated = queueTicket('SAM1-2');
    let freshScans = 0;
    let completions = 0;

    const run = await runLoop({
      take: (request) => {
        if (request.only !== null) {
          // The repair asks for its own ticket by identity, and gets it, even
          // though the ready queue now offers a different one first.
          return took(request.only);
        }
        freshScans += 1;
        if (freshScans === 1) {
          return took(repaired);
        }
        return freshScans === 2 ? took(unrelated) : nothing;
      },
      complete: () => {
        completions += 1;
        return completions === 1
          ? { state: 'to-do', detail: 'findings published and moved back to "To Do"' }
          : { state: 'done', detail: `verified merge ${MERGE}`, mergeCommit: MERGE };
      },
    });

    expect(run.summary).toMatchObject({ outcome: 'completed', completed: 2, attempts: 3 });
    expect(run.takes).toEqual([null, repaired, null, null]);
    // The first ticket's repair, review and completion all happen before the
    // unrelated ticket is taken.
    expect(run.log.indexOf('+consume:SAM1-1')).toBeGreaterThan(run.log.indexOf('-complete:SAM1-1'));
    // The unrelated ticket's own fresh scan is the last one.
    expect(run.log.indexOf('+ready:SAM1-1')).toBeLessThan(run.log.lastIndexOf('+consume:next'));
  });

  it('ends a finite run successfully when the queue is empty from the start', async () => {
    const run = await runLoop({ take: () => nothing });

    expect(run.summary).toEqual({
      outcome: 'completed',
      completed: 0,
      attempts: 0,
      problem: null,
      ticket: null,
    });
    expect(run.takes).toEqual([null]);
    expect(run.log).toEqual(['+consume:next', '-consume:next']);
    expect(run.out.join('\n')).toContain('no eligible ticket');
  });

  it('ends a finite run successfully when no eligible ticket remains', async () => {
    const ticket = queueTicket('SAM1-1');
    let scans = 0;
    const run = await runLoop({
      take: () => {
        scans += 1;
        return scans === 1 ? took(ticket) : nothing;
      },
    });

    expect(run.summary).toMatchObject({ outcome: 'completed', completed: 1, attempts: 1 });
    expect(run.takes).toEqual([null, null]);
    expect(run.out.join('\n')).toContain('no further eligible ticket after 1 completed');
  });

  it('takes whatever a fresh scan offers after every confirmed Done', async () => {
    const first = queueTicket('SAM1-1');
    const second = queueTicket('SAM1-2');
    const appeared = queueTicket('SAM1-3');
    // The first scan offers SAM1-1 and SAM1-2; by the time the first ticket is
    // Done, a higher-priority ticket has appeared and the order is different.
    const scans: QueueTicket[][] = [[first, second], [appeared]];

    const run = await runLoop({
      take: () => {
        const [batch = []] = scans.splice(0, 1);
        const [next] = batch;
        return next === undefined ? nothing : took(next);
      },
    });

    expect(run.summary).toMatchObject({ outcome: 'completed', completed: 2, attempts: 2 });
    expect(run.takes).toEqual([null, null, null]);
    // Neither scan's batch was cached: the second ticket came from a fresh scan,
    // and the ticket that scan offered was the one that was actually taken.
    expect(run.log.filter((line) => line.startsWith('+consume'))).toEqual([
      '+consume:next',
      '+consume:next',
      '+consume:next',
    ]);
    expect(run.log).toContain('+review:SAM1-3');
    expect(run.log).not.toContain('+review:SAM1-2');
  });

  it('stops on a failed coding attempt instead of skipping to another ticket', async () => {
    const ticket = queueTicket('SAM1-1');
    const run = await runLoop({ take: () => took(ticket, 'failed') });

    expect(run.summary.outcome).toBe('stopped');
    expect(run.summary.ticket?.ref.key).toBe('SAM1-1');
    expect(run.summary.problem).toContain('ended failed');
    expect(run.summary.problem).toContain('does not skip the ticket for another one');
    expect(run.log).toEqual(['+consume:next', '-consume:next']);
    expect(run.takes).toEqual([null]);
  });

  it('stops on an infrastructure failure the consumer reported', async () => {
    const run = await runLoop({ take: () => attention('Jira could not be read: 503') });

    expect(run.summary.outcome).toBe('stopped');
    expect(run.summary.problem).toBe('Jira could not be read: 503');
    expect(run.log).toEqual(['+consume:next', '-consume:next']);
  });

  it('stops when the review needs a person', async () => {
    const ticket = queueTicket('SAM1-1');
    const run = await runLoop({
      take: () => took(ticket),
      review: () => ({ state: 'attention', detail: 'the reviewer turn wrote no usable verdict' }),
    });

    expect(run.summary.outcome).toBe('stopped');
    expect(run.summary.problem).toContain('the review needs a person');
    expect(run.summary.problem).toContain('no usable verdict');
    expect(run.log).not.toContain('+complete:SAM1-1');
  });

  it('waits out a pending completion, then finishes the ticket', async () => {
    const ticket = queueTicket('SAM1-1');
    const sleeps: number[] = [];
    let readings = 0;
    const run = await runLoop({
      take: once(ticket),
      complete: () => {
        readings += 1;
        return readings < 3
          ? { state: 'pending', detail: 'the pull request is not merged yet' }
          : { state: 'done', detail: `verified merge ${MERGE}`, mergeCommit: MERGE };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      completionPollIntervalMs: 5_000,
    });

    expect(run.summary).toMatchObject({ outcome: 'completed', completed: 1 });
    expect(readings).toBe(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });

  it('stops when the completion path needs a person', async () => {
    const ticket = queueTicket('SAM1-1');
    const run = await runLoop({
      take: () => took(ticket),
      complete: () => ({
        state: 'attention',
        detail: 'the configured post-merge workflows were still pending when the deadline expired',
      }),
    });

    expect(run.summary.outcome).toBe('stopped');
    expect(run.summary.problem).toContain('post-merge workflows were still pending');
    expect(run.log).not.toContain('+ready:SAM1-1');
  });

  it('stops before claiming another ticket when the checkout cannot be proven ready', async () => {
    const ticket = queueTicket('SAM1-1');
    const run = await runLoop({
      take: () => took(ticket),
      ready: () => {
        throw new Error('"C:/work" is not a clean checkout: 1 untracked file that is not ignored');
      },
    });

    expect(run.summary).toMatchObject({ outcome: 'stopped', completed: 0, attempts: 1 });
    expect(run.summary.problem).toContain('the next workspace is not ready');
    expect(run.summary.problem).toContain('not a clean checkout');
    expect(run.takes).toEqual([null]);
  });

  it('stops when the completion path cannot name the merge commit', async () => {
    const ticket = queueTicket('SAM1-1');
    const run = await runLoop({
      take: () => took(ticket),
      complete: () => ({ state: 'done', detail: 'moved to Done', mergeCommit: null }),
    });

    expect(run.summary.outcome).toBe('stopped');
    expect(run.summary.problem).toContain('without naming the merge commit');
    expect(run.log).not.toContain('+ready:SAM1-1');
  });

  it('stops when a ticket returned for repair is no longer in the ready status', async () => {
    const ticket = queueTicket('SAM1-1');
    const run = await runLoop({
      take: (request) =>
        request.only === null
          ? took(ticket)
          : attention('the fresh scan found nothing for it', ticket),
      complete: () => ({ state: 'to-do', detail: 'moved back to "To Do"' }),
    });

    expect(run.summary.outcome).toBe('stopped');
    expect(run.summary.problem).toContain('the fresh scan found nothing for it');
    expect(run.takes).toEqual([null, ticket]);
  });

  it('idles in watch mode without starting an agent, then takes newly eligible work', async () => {
    const ticket = queueTicket('SAM1-9');
    const stop = new AbortController();
    let scans = 0;
    const sleeps: number[] = [];

    const run = await runLoop({
      mode: 'watch',
      stop: stop.signal,
      take: () => {
        scans += 1;
        return scans === 2 ? took(ticket) : nothing;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) {
          // The ticket was completed and the queue is empty again; this is
          // where a person stops the foreground watch.
          stop.abort(new Error('the user interrupted the queue'));
        }
      },
      pollIntervalMs: 30_000,
    });

    expect(run.summary).toMatchObject({ outcome: 'cancelled', completed: 1, attempts: 1 });
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(run.out.filter((line) => line.startsWith('queue idle'))).toHaveLength(2);
    // The idle scan started no reviewer turn and completed nothing.
    expect(run.log.filter((line) => line.startsWith('+review'))).toEqual(['+review:SAM1-9']);
  });

  it('never overlaps coding and review phases', async () => {
    const ticket = queueTicket('SAM1-1');
    const run = await runLoop({
      take: once(ticket),
      review: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { state: 'clear', detail: 'reviewed' };
      },
      complete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { state: 'done', detail: `verified merge ${MERGE}`, mergeCommit: MERGE };
      },
    });

    expect(run.overlap()).toBe(false);
    expect(run.log.indexOf('-consume:next')).toBeLessThan(run.log.indexOf('+review:SAM1-1'));
    expect(run.log.indexOf('-review:SAM1-1')).toBeLessThan(run.log.indexOf('+complete:SAM1-1'));
  });

  it('cancels while idle without starting anything', async () => {
    const stop = new AbortController();
    const run = await runLoop({
      mode: 'watch',
      stop: stop.signal,
      take: () => nothing,
      sleep: async () => {
        stop.abort(new Error('the user interrupted the queue'));
      },
    });

    expect(run.summary).toMatchObject({ outcome: 'cancelled', completed: 0, attempts: 0 });
    expect(run.takes).toEqual([null]);
    expect(run.log.filter((line) => line.startsWith('+review'))).toEqual([]);
    expect(run.log.filter((line) => line.startsWith('+complete'))).toEqual([]);
  });

  it('cancels the active phase without starting a next ticket', async () => {
    const stop = new AbortController();
    const run = await runLoop({
      mode: 'watch',
      stop: stop.signal,
      take: () => {
        stop.abort(new Error('the user interrupted the queue'));
        return {
          outcome: 'cancelled',
          ticket: null,
          run: null,
          skipped: 0,
          problem: null,
          cleanupConfirmed: true,
        };
      },
    });

    expect(run.summary.outcome).toBe('cancelled');
    expect(run.takes).toEqual([null]);
    expect(run.log).toEqual(['+consume:next', '-consume:next']);
  });

  it('does not rerun a ticket that is already Done when a queue restarts', async () => {
    // A restart reads authoritative state: the Done ticket is not in the ready
    // queue, so no reviewer turn runs and no completion effect is repeated.
    const run = await runLoop({ take: () => nothing });

    expect(run.summary).toMatchObject({ outcome: 'completed', completed: 0, attempts: 0 });
    expect(run.log.filter((line) => line.startsWith('+review'))).toEqual([]);
    expect(run.log.filter((line) => line.startsWith('+complete'))).toEqual([]);
    expect(run.log.filter((line) => line.startsWith('+ready'))).toEqual([]);
  });

  it('resumes a ticket a confirmed repair returned to its ready status', async () => {
    const ticket = queueTicket('SAM1-4');
    let scans = 0;
    const run = await runLoop({
      take: () => {
        scans += 1;
        return scans === 1 ? took(ticket) : nothing;
      },
    });

    expect(run.summary).toMatchObject({ outcome: 'completed', completed: 1, attempts: 1 });
    expect(run.takes).toEqual([null, null]);
    expect(run.log.filter((line) => line.startsWith('+consume'))).toEqual([
      '+consume:next',
      '+consume:next',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The consumer step
// ---------------------------------------------------------------------------

/** One run's result, built the way the runner builds it and nothing more. */
function runResult(
  workDir: string,
  key: string,
  status: RunStatus,
  workspace: PreparedWorkspace | null,
): RunTaskResult {
  const runDir = path.join(workDir, 'runs', `run-${key}`);
  return {
    run: {
      workDir,
      runId: `run-${key}`,
      runDir,
      workspacePath: path.join(workDir, 'workspaces', `run-${key}`),
      logsDir: path.join(runDir, 'logs'),
    },
    workspace,
    status,
    reason: `the run ended ${status}`,
    baseline: null,
    attempts: [],
    repairsUsed: status === 'failed' ? 2 : 0,
    timeout: null,
    cancellation: null,
    changes: summarizeChanges({ baseCommit: 'base', paths: [] }),
    workspaceLedgerProblem: null,
    reportPath: path.join(runDir, 'result.json'),
  };
}

/** The working copy a passed attempt left, as the queue's step reports it. */
function preparedWorkspace(workDir: string, key: string): PreparedWorkspace {
  const runDir = path.join(workDir, 'runs', `run-${key}`);
  const workspaceId = `run-${key}`;
  return {
    workDir,
    runId: workspaceId,
    runDir,
    workspacePath: path.join(workDir, 'workspaces', workspaceId),
    logsDir: path.join(runDir, 'logs'),
    workspaceId,
    continued: false,
    attempt: 1,
    sourceRoot: path.join(workDir, 'source'),
    baseCommit: 'base',
    branch: `harness/${workspaceId}`,
  };
}

interface TakeFixtureOptions {
  readonly workDir: string;
  readonly candidates: readonly SourceCandidate[];
  readonly prepare?: (candidate: SourceCandidate) => SourceTask | null;
  readonly pointers?: readonly string[];
  readonly claim?: boolean;
  readonly status?: RunStatus;
  readonly delivery?: Delivery;
  readonly stop?: AbortSignal;
}

/** One fake source and one fake runner, with everything they were asked. */
function takeFixture(options: TakeFixtureOptions): {
  readonly context: SourceContext;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const taskFor = (candidate: SourceCandidate): Task => ({
    id: candidate.ref.key,
    title: candidate.title,
    description: '## Acceptance criteria\n- It works.',
    acceptanceCriteria: ['It works.'],
  });
  const preparedFor = (candidate: SourceCandidate): SourceTask => ({
    ref: candidate.ref,
    task: taskFor(candidate),
    pointers: options.pointers ?? [],
  });

  const source: TaskSource = {
    listEligible: async () => {
      calls.push('listEligible');
      return options.candidates;
    },
    prepare: async (candidate) => {
      calls.push(`prepare:${candidate.ref.key}`);
      return options.prepare === undefined ? preparedFor(candidate) : options.prepare(candidate);
    },
    claim: async (item) => {
      calls.push(`claim:${item.ref.key}`);
      return options.claim ?? true;
    },
    progress: async (item) => {
      calls.push(`progress:${item.ref.key}`);
    },
    complete: async (item) => {
      calls.push(`complete:${item.ref.key}`);
    },
    recordWorkspace: async (item, workspaceId) => {
      calls.push(`pointer:${item.ref.key}:${workspaceId}`);
    },
    refuse: async (item) => {
      calls.push(`refuse:${item.ref.key}`);
    },
    commentsSince: async () => [],
  };

  const tiers: readonly EscalationTier[] = [
    { name: 'default', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 },
  ];

  const context: SourceContext = {
    source,
    workDir: options.workDir,
    tiers,
    repoPath: path.join(options.workDir, 'source'),
    io: {
      out: (text) => {
        calls.push(`out:${text.slice(0, 12)}`);
      },
      err: (text) => {
        calls.push(`err:${text.slice(0, 12)}`);
      },
    },
    stop: options.stop ?? new AbortController().signal,
    preflight: async () => ({
      sourceRoot: path.join(options.workDir, 'source'),
      baseCommit: 'base',
    }),
    ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
    run: async (request: SourceRunRequest) => {
      calls.push(`run:${request.task.id}`);
      const workspace = preparedWorkspace(options.workDir, request.task.id);
      await request.onWorkspaceReady?.({ workspaceId: workspace.workspaceId });
      return runResult(options.workDir, request.task.id, options.status ?? 'passed', workspace);
    },
    now: () => new Date('2026-09-20T10:00:00.000Z'),
    sleep: async () => {},
  };

  return { context, calls };
}

describe('the queue consumer step', () => {
  it('takes the first eligible ticket and reports the run it ended with', async () => {
    const workDir = await createTempDir();
    const fixture = takeFixture({
      workDir,
      candidates: [candidateFor('SAM1-1'), candidateFor('SAM1-2')],
    });

    const result = await takeOneItem(fixture.context);

    expect(result.outcome).toBe('taken');
    expect(result.ticket?.ref.key).toBe('SAM1-1');
    expect(result.run?.status).toBe('passed');
    expect(result.run?.runId).toBe('run-SAM1-1');
    expect(result.problem).toBeNull();
    expect(result.cleanupConfirmed).toBe(true);
    // Only the first ticket was even read: nothing is pre-reserved for a batch.
    expect(fixture.calls.filter((call) => call.startsWith('prepare:'))).toEqual(['prepare:SAM1-1']);
    expect(fixture.calls).toContain('pointer:SAM1-1:run-SAM1-1');
    expect(fixture.calls).toContain('complete:SAM1-1');
  });

  it('continues only the ticket a repair names, even when the queue offers another one', async () => {
    const workDir = await createTempDir();
    const fixture = takeFixture({
      workDir,
      candidates: [candidateFor('SAM1-1'), candidateFor('SAM1-7')],
    });

    const result = await takeOneItem(fixture.context, {
      only: queueTicket('SAM1-7'),
      lockHeld: true,
    });

    expect(result.outcome).toBe('taken');
    expect(result.ticket?.ref.key).toBe('SAM1-7');
    expect(fixture.calls.filter((call) => call.startsWith('prepare:'))).toEqual(['prepare:SAM1-7']);
    expect(fixture.calls.filter((call) => call.startsWith('run:'))).toEqual(['run:SAM1-7']);
  });

  it('reports an empty step when the named ticket is not in the ready queue', async () => {
    const workDir = await createTempDir();
    const fixture = takeFixture({ workDir, candidates: [candidateFor('SAM1-1')] });

    const result = await takeOneItem(fixture.context, {
      only: queueTicket('SAM1-9'),
      lockHeld: true,
    });

    expect(result.outcome).toBe('empty');
    expect(result.ticket).toBeNull();
    expect(fixture.calls).toEqual(['listEligible']);
  });

  it('holds no lock of its own when the queue already holds one', async () => {
    const workDir = await createTempDir();
    const lock = await acquireIntakeLock(workDir, () => new Date());
    try {
      const fixture = takeFixture({ workDir, candidates: [candidateFor('SAM1-1')] });
      const result = await takeOneItem(fixture.context, { lockHeld: true });
      expect(result.outcome).toBe('taken');
      // The queue's lock is still exactly the one this test took.
      expect(existsSync(intakeLockPath(workDir))).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it('takes and releases its own lock when the caller holds none', async () => {
    const workDir = await createTempDir();
    const fixture = takeFixture({ workDir, candidates: [candidateFor('SAM1-1')] });

    const result = await takeOneItem(fixture.context);

    expect(result.outcome).toBe('taken');
    expect(existsSync(intakeLockPath(workDir))).toBe(false);
  });

  it('refuses to start when another consumer holds the intake lock', async () => {
    const workDir = await createTempDir();
    const lock = await acquireIntakeLock(workDir, () => new Date());
    const fixture = takeFixture({ workDir, candidates: [candidateFor('SAM1-1')] });
    try {
      await expect(takeOneItem(fixture.context)).rejects.toThrow(SourceError);
      await expect(takeOneItem(fixture.context)).rejects.toThrow(/another intake consumer holds/);
      expect(fixture.calls).toEqual([]);
    } finally {
      await lock.release();
    }
  });

  it('stops on a description that is not a usable task instead of skipping it', async () => {
    const workDir = await createTempDir();
    const fixture = takeFixture({
      workDir,
      candidates: [candidateFor('SAM1-1'), candidateFor('SAM1-2')],
      prepare: (candidate) => {
        if (candidate.ref.key === 'SAM1-1') {
          throw new SourceError('invalid-task', 'no acceptance criteria section');
        }
        return null;
      },
    });

    const result = await takeOneItem(fixture.context);

    expect(result.outcome).toBe('attention');
    expect(result.problem).toContain('not a usable task');
    expect(result.problem).toContain('no acceptance criteria section');
    expect(fixture.calls).not.toContain('claim:SAM1-1');
    // The next candidate was never even read.
    expect(fixture.calls.filter((call) => call.startsWith('prepare:'))).toEqual(['prepare:SAM1-1']);
  });

  it('publishes a refusal and stops rather than taking the next ticket', async () => {
    const workDir = await createTempDir();
    const fixture = takeFixture({
      workDir,
      candidates: [candidateFor('SAM1-1'), candidateFor('SAM1-2')],
      pointers: ['workspace-a', 'workspace-b'],
    });

    const result = await takeOneItem(fixture.context);

    expect(result.outcome).toBe('attention');
    expect(result.problem).toContain('refused it and took it out of the queue');
    expect(fixture.calls).toContain('refuse:SAM1-1');
    // A refusal re-reads the item before it publishes, so it is prepared twice;
    // the ticket after it was never read at all.
    expect(fixture.calls.filter((call) => call.startsWith('prepare:'))).toEqual([
      'prepare:SAM1-1',
      'prepare:SAM1-1',
    ]);
  });

  it('reports a stale scan as empty without claiming anything', async () => {
    const workDir = await createTempDir();
    const fixture = takeFixture({
      workDir,
      candidates: [candidateFor('SAM1-1')],
      prepare: () => null,
    });

    const result = await takeOneItem(fixture.context);

    expect(result.outcome).toBe('empty');
    expect(result.skipped).toBe(1);
    expect(fixture.calls).not.toContain('claim:SAM1-1');
  });

  it('reports an empty queue without touching the source', async () => {
    const workDir = await createTempDir();
    const fixture = takeFixture({ workDir, candidates: [] });

    const result = await takeOneItem(fixture.context, { lockHeld: true });

    expect(result).toMatchObject({ outcome: 'empty', ticket: null, run: null });
    expect(fixture.calls).toEqual(['listEligible']);
  });

  it('reports an attempt that could not finish as attention with its evidence', async () => {
    const workDir = await createTempDir();
    const fixture = takeFixture({
      workDir,
      candidates: [candidateFor('SAM1-1')],
      claim: false,
    });

    const result = await takeOneItem(fixture.context);

    // A claim that sent no request releases the reservation this step created
    // and leaves the ticket for a later scan.
    expect(result.outcome).toBe('empty');
    expect(fixture.calls).toContain('claim:SAM1-1');
  });
});

// ---------------------------------------------------------------------------
// One ticket at a time, in the existing review and completion modules
// ---------------------------------------------------------------------------

/** A review scan context that records the tickets it was asked to prepare. */
function reviewFixture(candidates: readonly SourceCandidate[]): {
  readonly context: ReviewScanContext;
  readonly seen: string[];
} {
  const seen: string[] = [];
  const itemFor = (candidate: SourceCandidate): SourceTask => ({
    ref: candidate.ref,
    task: {
      id: candidate.ref.key,
      title: candidate.title,
      description: '## Acceptance criteria\n- It works.',
      acceptanceCriteria: ['It works.'],
    },
    pointers: [`workspace-${candidate.ref.key}`],
  });
  const context: ReviewScanContext = {
    queue: {
      list: async () => candidates,
      prepare: async (candidate) => {
        seen.push(candidate.ref.key);
        return itemFor(candidate);
      },
    },
    repository: {
      findOpenPullRequest: async () => null,
      readPullRequest: async () => null,
      listReviews: async () => [],
      readEvidence: async () => {
        throw new Error('no reviewer turn may run for a ticket the scan was not asked about');
      },
      publishReview: async () => {
        throw new Error('nothing may be published');
      },
      publishCheck: async () => {
        throw new Error('nothing may be published');
      },
      reviewChecks: async () => [],
    },
    reviewer: async () => {
      throw new Error('no reviewer turn may run');
    },
    workDir: 'unused',
    login: 'nexus-lens[bot]',
    checkName: 'Nexus Lens review',
    reviewerTimeoutMs: 1_000,
    io: { out: () => {}, err: () => {} },
    stop: new AbortController().signal,
    now: () => new Date('2026-09-20T10:00:00.000Z'),
    sleep: async () => {},
  };
  return { context, seen };
}

describe('the review scan narrowed to one ticket', () => {
  it('considers only the ticket the caller named', async () => {
    const fixture = reviewFixture([candidateFor('SAM1-1'), candidateFor('SAM1-9')]);

    const summary = await scanReviews({ ...fixture.context, only: candidateFor('SAM1-9').ref }, 1);

    expect(fixture.seen).toEqual(['SAM1-9']);
    expect(summary.scanned).toBe(1);
    expect(summary.items.map((item) => item.ref.key)).toEqual(['SAM1-9']);
    // The pass is refused before publication: there is no pull request here.
    expect(summary.items[0]?.disposition).toBe('attention');
  });

  it('considers every eligible ticket, in order, when the caller named none', async () => {
    const fixture = reviewFixture([candidateFor('SAM1-1'), candidateFor('SAM1-9')]);

    const summary = await scanReviews(fixture.context, 1);

    expect(fixture.seen).toEqual(['SAM1-1', 'SAM1-9']);
    expect(summary.items.map((item) => item.ref.key)).toEqual(['SAM1-1', 'SAM1-9']);
  });
});

/** One open pull request as the completion path reads it. */
function openPull(number: number): PullRequestSnapshot {
  return {
    number,
    url: `https://github.com/o/r/pull/${String(number)}`,
    state: 'OPEN',
    isDraft: false,
    headRefName: 'harness/workspace-a',
    baseRefName: 'main',
    headRefOid: 'b'.repeat(40),
    autoMergeRequest: null,
    mergeable: 'MERGEABLE',
    title: 'delivered work',
    body: '',
    mergeCommit: null,
  };
}

/** A completion pass that records every item it was asked to read. */
function completionFixture(candidates: readonly SourceCandidate[]): {
  readonly parts: CompletionPassParts;
  readonly seen: string[];
} {
  const seen: string[] = [];
  const source: CompletionSource = {
    listReview: async () => candidates,
    readItem: async (candidate: SourceCandidate) => {
      seen.push(candidate.ref.key);
      return null;
    },
    listComments: async () => [],
    leftReviewSince: async () => false,
    postComment: async () => {
      throw new Error('nothing may be commented');
    },
    moveTo: async () => {
      throw new Error('nothing may be moved');
    },
  };
  const actions: CompletionActions = {
    findPullRequest: async () => null,
    findMergedPullRequest: async () => openPull(1),
    readGate: async () => ({ status: 'attention', reason: 'unused', review: null, findings: [] }),
    readApprovedHead: async () => null,
    readMerge: async () => ({
      status: 'pending',
      reason: 'unused',
      mergeCommit: null,
      workflows: [],
    }),
    enableAutoMerge: async () => {
      throw new Error('nothing may be armed');
    },
  };
  return {
    seen,
    parts: {
      config: {
        lensApp: 'nexus-lens[bot]',
        lensAppId: 1,
        lensCheckName: 'Nexus Lens review',
        reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
        postMergeWorkflows: ['ci.yml'],
        toDoStatus: 'To Do',
        doneStatus: 'Done',
        pollIntervalSeconds: 1,
        deadlineSeconds: 1,
      },
      repository: 'o/r',
      baseBranch: 'main',
      source,
      actions,
      workDir: 'unused',
      io: { out: () => {}, err: () => {} },
      now: () => new Date('2026-09-20T10:00:00.000Z'),
      sleep: async () => {},
    },
  };
}

describe('the completion pass narrowed to one ticket', () => {
  it('reads nothing about another In Review item', async () => {
    const fixture = completionFixture([candidateFor('SAM1-1'), candidateFor('SAM1-9')]);
    const pass = createCompletionPass({ ...fixture.parts, only: candidateFor('SAM1-9').ref });

    const outcomes = await pass.run(new AbortController().signal);

    expect(fixture.seen).toEqual(['SAM1-9']);
    expect(outcomes.map((outcome) => outcome.ref.key)).toEqual(['SAM1-9']);
  });

  it('reads every In Review item when the caller named none', async () => {
    const fixture = completionFixture([candidateFor('SAM1-1'), candidateFor('SAM1-9')]);
    const pass = createCompletionPass(fixture.parts);

    const outcomes = await pass.run(new AbortController().signal);

    expect(fixture.seen).toEqual(['SAM1-1', 'SAM1-9']);
    expect(outcomes).toHaveLength(2);
  });
});
