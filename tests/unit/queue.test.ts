/**
 * The serial queue loop's own state transitions, decided over the phase results
 * its caller hands it: a discovery, a take, an arm, a review, a completion, and
 * the source readiness that follows a confirmed Done.
 *
 * Every collaborator is a stand-in, so what is asserted is what the loop itself
 * decided — which phase it asked next, with which ticket, whether it scanned
 * again or continued the same ticket, and which result it stopped for. No
 * connector, command, or agent is started; those contracts stay the boundary
 * and workflow layers' (docs/testing.md).
 */
import { describe, expect, it } from 'vitest';
import { runQueue } from '../../src/queue/loop.js';
import type {
  QueueArmOutcome,
  QueueCompletionOutcome,
  QueueDiscoveryStop,
  QueueLoopContext,
  QueueRecovery,
  QueueReviewOutcome,
} from '../../src/queue/loop.js';
import type { QueueTicket, SourceTake } from '../../src/sources/contract.js';

const TICKET: QueueTicket = {
  ref: {
    type: 'jira',
    scope: 'https://example.atlassian.net',
    id: '10011',
    key: 'HARN-11',
    url: 'https://example.atlassian.net/browse/HARN-11',
    updatedAt: '2026-09-16T11:00:00.000Z',
  },
  title: 'Add a greeting function',
};

const OTHER_TICKET: QueueTicket = {
  ...TICKET,
  ref: { ...TICKET.ref, id: '10012', key: 'HARN-12' },
};

/** A take that carried one passed run all the way to delivery. */
function taken(ticket: QueueTicket = TICKET): SourceTake {
  return {
    outcome: 'taken',
    ticket,
    run: {
      status: 'passed',
      runId: 'run-1',
      reportPath: '/runs/run-1/result.json',
      reason: 'every configured check passed',
      pullRequest: {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        head: 'b'.repeat(40),
        created: true,
      },
    },
    skipped: 0,
    problem: null,
    cleanupConfirmed: true,
  };
}

/** A take that found nothing to claim. */
function emptyTake(): SourceTake {
  return {
    outcome: 'empty',
    ticket: null,
    run: null,
    skipped: 0,
    problem: null,
    cleanupConfirmed: true,
  };
}

/** What a case watches: the phase calls, in the order the loop made them. */
interface Recorder {
  readonly calls: string[];
  readonly outputs: string[];
  readonly waits: number[];
}

interface HarnessParts {
  readonly discover?: () => Promise<QueueRecovery | QueueDiscoveryStop | null>;
  readonly consume?: (request: { readonly only: QueueTicket | null }) => Promise<SourceTake>;
  readonly arm?: () => Promise<QueueArmOutcome>;
  readonly review?: () => Promise<QueueReviewOutcome>;
  readonly complete?: () => Promise<QueueCompletionOutcome>;
  readonly ready?: () => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly completionPollIntervalMs?: number;
  /** The idle wait the loop is handed; a case may end the watch from it. */
  readonly sleep?: (ms: number, stop: AbortSignal) => Promise<void>;
}

/** One queue invocation whose phases are the case's own stand-ins. */
function queueHarness(parts: HarnessParts = {}) {
  const recorder: Recorder = { calls: [], outputs: [], waits: [] };
  const stop = new AbortController();
  const context: QueueLoopContext = {
    io: {
      out: (text) => recorder.outputs.push(text),
      err: (text) => recorder.outputs.push(text),
    },
    stop: stop.signal,
    sleep:
      parts.sleep ??
      (async (ms) => {
        recorder.waits.push(ms);
      }),
    pollIntervalMs: parts.pollIntervalMs ?? 30_000,
    completionPollIntervalMs: parts.completionPollIntervalMs ?? 30_000,
    discover: async () => {
      recorder.calls.push('discover');
      return parts.discover === undefined ? null : await parts.discover();
    },
    consume: async (request) => {
      recorder.calls.push(
        request.only === null ? 'consume:fresh' : `consume:${request.only.ref.key}`,
      );
      return parts.consume === undefined ? emptyTake() : await parts.consume(request);
    },
    arm: async () => {
      recorder.calls.push('arm');
      return parts.arm === undefined
        ? { state: 'observed', detail: 'no pull request to arm' }
        : await parts.arm();
    },
    review: async () => {
      recorder.calls.push('review');
      return parts.review === undefined
        ? { state: 'clear', detail: 'reviewed' }
        : await parts.review();
    },
    complete: async () => {
      recorder.calls.push('complete');
      return parts.complete === undefined
        ? { state: 'done', detail: 'merged', mergeCommit: 'c'.repeat(40) }
        : await parts.complete();
    },
    ready: async (request) => {
      recorder.calls.push(`ready:${request.mergeCommit.slice(0, 7)}`);
      if (parts.ready !== undefined) {
        await parts.ready();
      }
    },
  };
  return { context, recorder, stop };
}

describe('a finite queue run without work', () => {
  it('exits completed without claiming anything', async () => {
    const { context, recorder } = queueHarness();

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('completed');
    expect(summary.completed).toBe(0);
    expect(summary.attempts).toBe(0);
    expect(summary.ticket).toBeNull();
    expect(recorder.calls).toEqual(['discover', 'consume:fresh']);
    expect(recorder.outputs.join('\n')).toMatch(/no eligible ticket/);
  });
});

describe('one ticket carried through the serial lifecycle', () => {
  it('arms, reviews, completes and readies before scanning again', async () => {
    let scans = 0;
    const { context, recorder } = queueHarness({
      consume: async () => {
        scans += 1;
        return scans === 1 ? taken() : emptyTake();
      },
      arm: async () => ({ state: 'armed', detail: 'auto-merge armed for the current head' }),
      review: async () => ({ state: 'clear', detail: 'the reviewer approved the current head' }),
      complete: async () => ({
        state: 'done',
        detail: 'the merge and every post-merge workflow succeeded',
        mergeCommit: 'c'.repeat(40),
      }),
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('completed');
    expect(summary.completed).toBe(1);
    expect(summary.attempts).toBe(1);
    expect(recorder.calls).toEqual([
      'discover',
      'consume:fresh',
      'arm',
      'review',
      'complete',
      `ready:${'c'.repeat(7)}`,
      'discover',
      'consume:fresh',
    ]);
  });

  it('stops on a failed attempt instead of skipping to another ticket', async () => {
    const { context, recorder } = queueHarness({
      consume: async () => ({
        outcome: 'taken',
        ticket: TICKET,
        run: {
          status: 'failed',
          runId: 'run-1',
          reportPath: '/runs/run-1/result.json',
          reason: 'the checks after the implementation turn did not pass',
          pullRequest: null,
        },
        skipped: 0,
        problem: null,
        cleanupConfirmed: true,
      }),
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toMatch(/HARN-11: the coding attempt ended failed/);
    expect(summary.problem).toMatch(/does not skip the ticket for another one/);
    expect(recorder.calls).toEqual(['discover', 'consume:fresh']);
  });

  it('resumes a returned baseline repair with the same ticket, before any fresh scan', async () => {
    let scans = 0;
    const { context, recorder } = queueHarness({
      consume: async (request) => {
        scans += 1;
        if (scans === 1) {
          return {
            outcome: 'taken',
            ticket: TICKET,
            run: {
              status: 'failed',
              runId: 'run-1',
              reportPath: '/runs/run-1/result.json',
              reason: 'the baseline checks did not pass',
              pullRequest: null,
              returnedForBaselineRepair: { detail: 'the baseline failed for an actionable reason' },
            },
            skipped: 0,
            problem: null,
            cleanupConfirmed: true,
          };
        }
        if (scans === 2) {
          expect(request.only).toEqual(TICKET);
          return taken();
        }
        return emptyTake();
      },
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('completed');
    expect(summary.attempts).toBe(2);
    expect(recorder.calls).toEqual([
      'discover',
      'consume:fresh',
      'consume:HARN-11',
      'arm',
      'review',
      'complete',
      `ready:${'c'.repeat(7)}`,
      'discover',
      'consume:fresh',
    ]);
    expect(recorder.outputs.join('\n')).toMatch(/back for repair: the baseline failed/);
  });

  it('continues the same ticket when completion returned it for repair', async () => {
    const tickets: (QueueTicket | null)[] = [];
    const completions: QueueCompletionOutcome[] = [
      { state: 'to-do', detail: 'a required check failed on the reviewed head' },
      {
        state: 'done',
        detail: 'the merge and every post-merge workflow succeeded',
        mergeCommit: 'd'.repeat(40),
      },
    ];
    let scans = 0;
    const { context, recorder } = queueHarness({
      consume: async (request) => {
        tickets.push(request.only);
        scans += 1;
        return scans === 1 || scans === 2 ? taken() : emptyTake();
      },
      complete: async () => completions.shift() ?? { state: 'attention', detail: 'unexpected' },
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('completed');
    // The repair claim names the same ticket; no fresh scan happened between.
    expect(tickets).toEqual([null, TICKET, null]);
    expect(recorder.calls).toEqual([
      'discover',
      'consume:fresh',
      'arm',
      'review',
      'complete',
      'consume:HARN-11',
      'arm',
      'review',
      'complete',
      `ready:${'d'.repeat(7)}`,
      'discover',
      'consume:fresh',
    ]);
  });

  it('waits between two readings of a pending completion and then concludes', async () => {
    const completions: QueueCompletionOutcome[] = [
      { state: 'pending', detail: 'GitHub has not reported the merge yet' },
      { state: 'pending', detail: 'the post-merge workflows are still running' },
      {
        state: 'done',
        detail: 'the merge and every post-merge workflow succeeded',
        mergeCommit: 'e'.repeat(40),
      },
    ];
    let scans = 0;
    const { context, recorder } = queueHarness({
      completionPollIntervalMs: 7_000,
      consume: async () => {
        scans += 1;
        return scans === 1 ? taken() : emptyTake();
      },
      complete: async () => completions.shift() ?? { state: 'attention', detail: 'unexpected' },
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('completed');
    expect(recorder.waits).toEqual([7_000, 7_000]);
    expect(recorder.calls.filter((call) => call === 'complete')).toHaveLength(3);
  });

  it('stops for a person when a completion reports done without a merge commit', async () => {
    let scans = 0;
    const { context } = queueHarness({
      consume: async () => {
        scans += 1;
        return scans === 1 ? taken() : emptyTake();
      },
      complete: async () => ({ state: 'done', detail: 'merged', mergeCommit: null }),
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toMatch(/without naming the merge commit/);
  });
});

describe('the phases the loop stops for', () => {
  it('stops when the review returns attention', async () => {
    let scans = 0;
    const { context, recorder } = queueHarness({
      consume: async () => {
        scans += 1;
        return scans === 1 ? taken() : emptyTake();
      },
      review: async () => ({ state: 'attention', detail: 'no usable verdict was produced' }),
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toMatch(/the review needs a person: no usable verdict/);
    expect(recorder.calls).not.toContain('complete');
  });

  it('stops when arming auto-merge needs a person, before any review', async () => {
    let scans = 0;
    const { context, recorder } = queueHarness({
      consume: async () => {
        scans += 1;
        return scans === 1 ? taken() : emptyTake();
      },
      arm: async () => ({ state: 'attention', detail: 'branch protection refused the request' }),
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toMatch(/native auto-merge needs a person/);
    expect(recorder.calls).not.toContain('review');
  });

  it('carries an unconfirmed stop from discovery into the summary', async () => {
    const { context } = queueHarness({
      discover: async (): Promise<QueueDiscoveryStop> => ({
        problem: 'a pending diagnosis could not be finished',
        cleanupConfirmed: false,
      }),
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toMatch(/pending diagnosis could not be finished/);
    expect(summary.cleanupConfirmed).toBe(false);
  });

  it('resumes a recovered review without scanning or consuming anything', async () => {
    let discovered = 0;
    const { context, recorder } = queueHarness({
      discover: async () => {
        discovered += 1;
        return discovered === 1 ? { ticket: OTHER_TICKET, phase: 'review' } : null;
      },
      complete: async () => ({
        state: 'done',
        detail: 'the merge and every post-merge workflow succeeded',
        mergeCommit: 'f'.repeat(40),
      }),
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('completed');
    expect(summary.attempts).toBe(0);
    // The recovered ticket goes straight to its lifecycle; the fresh scan that
    // follows is the empty one after it completed.
    expect(recorder.calls).toEqual([
      'discover',
      'arm',
      'review',
      'complete',
      `ready:${'f'.repeat(7)}`,
      'discover',
      'consume:fresh',
    ]);
    expect(recorder.outputs.join('\n')).toMatch(/resuming the existing review and completion/);
  });

  it('stops when a recovered repair is no longer eligible', async () => {
    const { context } = queueHarness({
      discover: async () => ({ ticket: OTHER_TICKET, phase: 'repair' }),
      consume: async () => emptyTake(),
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toMatch(/HARN-12: the recovered repair is no longer eligible/);
  });
});

describe('the caller stopping the queue', () => {
  it('ends cancelled before anything is discovered', async () => {
    const { context, recorder, stop } = queueHarness();
    stop.abort();

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('cancelled');
    expect(recorder.calls).toEqual([]);
  });

  it('ends cancelled when the stop arrives during a phase, with what it observed', async () => {
    const { context, stop } = queueHarness({
      consume: async () => {
        stop.abort();
        return taken();
      },
    });

    const summary = await runQueue(context, 'run');

    expect(summary.outcome).toBe('cancelled');
    expect(summary.completed).toBe(0);
  });
});

describe('watch mode', () => {
  it('waits visibly with no agent running, then takes the ticket that appeared', async () => {
    const { context, recorder, stop } = queueHarness({
      pollIntervalMs: 5_000,
      consume: async () => emptyTake(),
      // The idle wait is the loop's own moment to notice the interrupt: this one
      // ends the watch after the first idle status was printed.
      sleep: async (ms, signal) => {
        recorder.waits.push(ms);
        expect(signal.aborted).toBe(false);
        stop.abort();
      },
    });

    const summary = await runQueue(context, 'watch');

    expect(summary.outcome).toBe('cancelled');
    expect(recorder.waits).toEqual([5_000]);
    expect(recorder.outputs.join('\n')).toMatch(/queue idle: no eligible ticket/);
    expect(recorder.outputs.join('\n')).toMatch(/no agent runs while the queue is idle/);
  });
});
