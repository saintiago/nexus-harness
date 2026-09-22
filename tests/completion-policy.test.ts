/**
 * The completion pass's own decisions — its deadline, its retries, its
 * repetition and its idempotency — decided against the in-memory boundary with
 * the test's own clock.
 *
 * These cases used to run on the real `gh` boundary, where a pending check the
 * pass polls for a whole deadline cost a process per reading, and where every
 * retry, every repetition and every "was this comment already written" question
 * started another command; a loaded host could not always finish one case inside
 * the suite's own bound even though nothing was hanging. What was really under
 * test is the decision, and that is what this file asserts: the deadline, the
 * bound on retries, and what a repeated pass may write. The command boundary
 * itself — the exact arguments, the credential split, the evidence and restart
 * files, and the classification of a command the harness had to stop — is
 * covered in tests/completion-github.test.ts and tests/completion-arm.test.ts,
 * which still run real commands.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { completionLogsDir, createCompletionPass } from '../src/sources/completion.js';
import type { CompletionOutcome } from '../src/sources/completion.js';
import type { GateVerdict, MergeVerdict } from '../src/delivery/completion.js';
import type { CompletionConfig, SourceRef } from '../src/shared/types.js';
import { approvedGate, inMemoryCompletion } from './fixtures/completion-actions.js';
import type { InMemoryCompletion, InMemoryPull } from './fixtures/completion-actions.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';
import { createTempDir } from './support.js';

useFixtureLifecycle();

const REPOSITORY = 'saintiago/nexus-harness';
const BASE_BRANCH = 'main';
const WORKSPACE_ID = 'run-20260101000000-abcdef01';
const BRANCH = `harness/${WORKSPACE_ID}`;
const HEAD = 'a'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);
const START = Date.parse('2026-09-20T12:00:00.000Z');

const REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'HARN-15',
  url: 'https://example.atlassian.net/browse/HARN-15',
  updatedAt: '2026-09-20T11:00:00.000Z',
};

const CONFIG: CompletionConfig = {
  lensApp: 'nexus-lens',
  lensAppId: 123,
  lensCheckName: 'Nexus Lens',
  reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
  postMergeWorkflows: ['ci.yml'],
  toDoStatus: 'To Do',
  doneStatus: 'Done',
  pollIntervalSeconds: 5,
  deadlineSeconds: 30,
};

const OPEN_PULL: InMemoryPull = {
  number: 29,
  url: `https://github.com/${REPOSITORY}/pull/29`,
  head: HEAD,
  base: BASE_BRANCH,
  branch: BRANCH,
  open: true,
  mergeCommit: null,
  armedAt: null,
};

/** A merge reading that verified one merge commit and its post-merge workflow. */
function completeMerge(mergeCommit = MERGE_COMMIT): MergeVerdict {
  return {
    status: 'complete',
    reason: `GitHub merged ${mergeCommit} and every configured workflow succeeded`,
    mergeCommit,
    workflows: [
      {
        identifier: 'ci.yml',
        state: 'success',
        conclusion: 'SUCCESS',
        run: {
          databaseId: 4242,
          workflowId: 17,
          workflowName: 'CI',
          path: '.github/workflows/ci.yml',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          headSha: mergeCommit,
          headBranch: BASE_BRANCH,
          url: 'https://github.com/saintiago/nexus-harness/actions/runs/4242',
        },
      },
    ],
  };
}

/** One in-memory boundary, and the work directory a pass over it needs. */
interface Scenario {
  readonly workDir: string;
  readonly logsDir: string;
  readonly boundary: InMemoryCompletion;
  readonly sleeps: { count: number };
  /** One pass over the boundary, with a clock that steps by its own interval. */
  pass(options?: {
    readonly startMs?: number;
    readonly stepMs?: number;
  }): {
    run: (stop: AbortSignal) => Promise<readonly CompletionOutcome[]>;
    arm: (stop: AbortSignal) => Promise<readonly { readonly status: string }[]>;
  };
}

/**
 * One item's in-memory scenario. `merged` is a pull request GitHub has already
 * merged, which the pass only reaches through the admission a restart resumes
 * from — exactly as the real fixture seeds it.
 */
async function scenarioFor(
  parts: {
    readonly merged?: boolean;
    readonly gate?: GateVerdict;
    readonly merge?: MergeVerdict;
  } = {},
): Promise<Scenario> {
  const workDir = await createTempDir();
  const logsDir = completionLogsDir(workDir, REF, REPOSITORY);
  await mkdir(logsDir, { recursive: true });
  const boundary = inMemoryCompletion({
    ref: REF,
    pointers: [WORKSPACE_ID],
    pull: {
      ...OPEN_PULL,
      open: parts.merged !== true,
      mergeCommit: parts.merged === true ? MERGE_COMMIT : null,
    },
    gate: parts.gate ?? approvedGate(HEAD),
  });
  boundary.merge(parts.merge ?? completeMerge());
  if (parts.merged === true) {
    await writeFile(
      path.join(logsDir, 'completion-armed-head.json'),
      JSON.stringify({ head: HEAD, number: 29, waitingSince: null }),
      'utf8',
    );
  }
  const sleeps = { count: 0 };
  return {
    workDir,
    logsDir,
    boundary,
    sleeps,
    pass: (options = {}) => {
      let clock = options.startMs ?? START;
      const step = options.stepMs ?? 1_000;
      const now = (): Date => {
        clock += step;
        return new Date(clock);
      };
      return createCompletionPass({
        config: CONFIG,
        repository: REPOSITORY,
        baseBranch: BASE_BRANCH,
        source: boundary.source,
        actions: boundary.actions,
        workDir,
        io: { out: () => undefined, err: () => undefined },
        now,
        // The pass asks to wait between readings; the clock is what moves here,
        // so nothing waits and every reading after a wait is the next tick.
        sleep: async () => {
          sleeps.count += 1;
        },
      });
    },
  };
}

/** The one outcome a pass is expected to have produced. */
function only(outcomes: readonly CompletionOutcome[]): CompletionOutcome {
  expect(outcomes).toHaveLength(1);
  const [first] = outcomes;
  if (first === undefined) {
    throw new Error('the pass produced no outcome');
  }
  return first;
}

/** The armed-head record one scenario wrote, as the pass persists it. */
async function armedHead(logsDir: string): Promise<{ head?: string; waitingSince?: string | null }> {
  return JSON.parse(await readFile(path.join(logsDir, 'completion-armed-head.json'), 'utf8')) as {
    head?: string;
    waitingSince?: string | null;
  };
}

describe('the completion deadline', () => {
  it('bounds a merge that never finishes across passes, then reports attention once', async () => {
    const scenario = await scenarioFor({
      gate: approvedGate(HEAD),
      merge: {
        status: 'pending',
        reason: 'GitHub has not merged this pull request yet',
        mergeCommit: null,
        workflows: [],
      },
    });
    const { boundary } = scenario;

    const first = only(await scenario.pass().run(AbortSignal.timeout(30_000)));
    expect(first.status, first.detail).toBe('pending');
    expect(boundary.item.comments).toHaveLength(0);
    const armed = await armedHead(scenario.logsDir);
    expect(Date.parse(armed.waitingSince ?? '')).toBeGreaterThanOrEqual(START);
    expect(Date.parse(armed.waitingSince ?? '')).toBeLessThan(START + 5_000);

    // A later pass over the same still-pending item, still inside the deadline:
    // it reads the recorded wait back instead of starting the deadline again,
    // and it publishes nothing while GitHub has not merged anything.
    const second = only(
      await scenario.pass({ startMs: START + 5_000 }).run(AbortSignal.timeout(30_000)),
    );
    expect(second.status, second.detail).toBe('pending');
    expect(boundary.item.comments).toHaveLength(0);
    expect((await armedHead(scenario.logsDir)).waitingSince).toBe(armed.waitingSince);

    // A later pass, far past the deadline, reports the expiry once and leaves
    // the item In Review: no failure conclusion was ever observed.
    const third = only(
      await scenario.pass({ startMs: START + 120_000 }).run(AbortSignal.timeout(30_000)),
    );
    expect(third.status, third.detail).toBe('attention');
    expect(boundary.item.status).toBe('In Review');
    expect(boundary.item.comments).toHaveLength(1);
    expect(boundary.item.comments[0]?.text).toContain('nexus-completion:attention:');
    expect(boundary.item.comments[0]?.text).toContain('deadline expired');
    expect(boundary.jiraCalls.some((call) => call.startsWith('moveTo'))).toBe(false);

    const fourth = only(
      await scenario.pass({ startMs: START + 125_000 }).run(AbortSignal.timeout(30_000)),
    );
    expect(fourth.status).toBe('attention');
    expect(boundary.item.comments).toHaveLength(1);
  });
});

describe('reading GitHub again inside the deadline', () => {
  it('reads a transient merge failure again instead of stopping for a person', async () => {
    const scenario = await scenarioFor({ merged: true });
    scenario.boundary.fail('readMerge', { retryable: true, times: 1 });

    const outcome = only(await scenario.pass().run(AbortSignal.timeout(30_000)));

    expect(outcome.status, outcome.detail).toBe('done');
    expect(scenario.boundary.item.status).toBe('Done');
    expect(scenario.boundary.item.comments).toHaveLength(1);
    // The reading that failed, the repeat that settled it, and the two guards'
    // own readings before the comment and before the move.
    expect(scenario.boundary.calls('readMerge')).toBe(4);
    expect(scenario.sleeps.count).toBeGreaterThan(0);
    expect(scenario.boundary.jiraCalls).toContain('moveTo:Done');
  });

  it('reads a transient check failure again rather than turning it into a finding', async () => {
    const scenario = await scenarioFor({ merged: true });
    scenario.boundary.fail('readGate', { retryable: true, times: 1 });

    const outcome = only(await scenario.pass().run(AbortSignal.timeout(30_000)));

    // The unreadable answer was repeated exactly once, and no coding finding,
    // person or merge was invented from it.
    expect(outcome.status, outcome.detail).toBe('done');
    expect(scenario.boundary.calls('readGate')).toBe(2);
    expect(scenario.boundary.item.comments).toHaveLength(1);
    expect(scenario.sleeps.count).toBeGreaterThan(0);
  });

  it('stops a transient failure at the deadline instead of retrying forever', async () => {
    const scenario = await scenarioFor({ merged: true });
    scenario.boundary.fail('readMerge', { retryable: true, message: 'GitHub returned HTTP 503' });

    const outcome = only(await scenario.pass({ stepMs: 5_000 }).run(AbortSignal.timeout(30_000)));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('503');
    expect(scenario.boundary.item.status).toBe('In Review');
    expect(scenario.boundary.item.comments).toHaveLength(0);
    expect(scenario.boundary.jiraCalls.some((call) => call.startsWith('moveTo'))).toBe(false);
    expect(scenario.sleeps.count).toBeGreaterThanOrEqual(1);
  });

  it('reads a transient failure of the pull request again while arming', async () => {
    const scenario = await scenarioFor();
    scenario.boundary.fail('findMergedPullRequest', { retryable: true, times: 1 });

    const outcomes = await scenario.pass().arm(AbortSignal.timeout(30_000));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'armed', head: HEAD, number: 29 });
    // The failed reading, the repeated one that settles it, and the verification
    // read that follows the request: three readings, one request.
    expect(scenario.boundary.calls('findMergedPullRequest')).toBe(3);
    expect(scenario.boundary.calls('enableAutoMerge')).toBe(1);
    expect(scenario.sleeps.count).toBeGreaterThan(0);
  });

  it('does not mint a fresh deadline for the guard before the resolution comment', async () => {
    const scenario = await scenarioFor({ merged: true });
    // The first read of the guard's own approval, after the item's budget has
    // been spent by the clock, is unavailable once. A pass that has spent its
    // budget does not get a new one: the read is not repeated, and nothing is
    // written from a state it could not re-verify.
    scenario.boundary.fail('readApprovedHead', {
      after: 1,
      retryable: true,
      message: 'GitHub returned HTTP 503',
    });

    const outcome = only(await scenario.pass({ stepMs: 15_000 }).run(AbortSignal.timeout(30_000)));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('503');
    expect(scenario.boundary.calls('readApprovedHead')).toBe(2);
    expect(scenario.sleeps.count).toBe(0);
    expect(scenario.boundary.item.comments).toHaveLength(0);
    expect(scenario.boundary.item.status).toBe('In Review');
  });

  it('does not mint a fresh deadline for the guard before the status move', async () => {
    const scenario = await scenarioFor({ merged: true });
    // The same bound covers the move's own guard: the second guard read is
    // unavailable once after the item budget is spent, so the comment is
    // published, the move is left to the next pass, and no fresh deadline is
    // minted to retry it here.
    scenario.boundary.fail('readApprovedHead', {
      after: 2,
      retryable: true,
      message: 'GitHub returned HTTP 503',
    });

    const outcome = only(await scenario.pass({ stepMs: 15_000 }).run(AbortSignal.timeout(30_000)));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('moving it to "Done" failed');
    expect(outcome.detail).toContain('503');
    expect(scenario.boundary.calls('readApprovedHead')).toBe(3);
    expect(scenario.sleeps.count).toBe(0);
    expect(scenario.boundary.item.comments).toHaveLength(1);
    expect(scenario.boundary.item.comments[0]?.text).toContain('nexus-completion:resolution:');
    expect(scenario.boundary.item.status).toBe('In Review');
  });
});

describe('repeating a pass', () => {
  it('writes one findings comment and one move when the pass is repeated', async () => {
    const scenario = await scenarioFor({
      gate: {
        status: 'failed',
        reason: 'the reviewer requested changes',
        review: {
          id: '555',
          author: 'nexus-lens',
          state: 'CHANGES_REQUESTED',
          body: 'Fix the ownership race.',
          commitId: HEAD,
          url: `${OPEN_PULL.url}#pullrequestreview-555`,
        },
        findings: [
          {
            label: 'Requested changes',
            detail: 'Fix the ownership race.',
            link: `${OPEN_PULL.url}#pullrequestreview-555`,
          },
        ],
      },
    });

    const first = only(await scenario.pass().run(AbortSignal.timeout(30_000)));
    expect(first.status, first.detail).toBe('to-do');
    // A person moved it back for repair, which the item's own changelog records:
    // the second pass finds it In Review again, and it neither publishes the
    // finding a second time nor moves the item a second time.
    scenario.boundary.item.status = 'In Review';
    scenario.boundary.leftReviewSince(true);
    const second = only(await scenario.pass().run(AbortSignal.timeout(30_000)));

    expect(second.status).toBe('observed');
    expect(scenario.boundary.item.comments).toHaveLength(1);
    expect(scenario.boundary.jiraCalls.filter((call) => call.startsWith('moveTo'))).toHaveLength(1);
  });

  it('does not write a second comment when the first write was uncertain', async () => {
    const scenario = await scenarioFor({
      gate: {
        status: 'failed',
        reason: 'the reviewer requested changes',
        review: null,
        findings: [{ label: 'Requested changes', detail: 'Fix the ownership race.', link: '' }],
      },
    });
    // The write never landed: Jira refused it, so nothing is stored.
    scenario.boundary.fail('postComment', { message: 'Jira returned HTTP 400', times: 1 });

    const failing = only(await scenario.pass().run(AbortSignal.timeout(30_000)));
    expect(failing.status, failing.detail).toBe('attention');
    expect(scenario.boundary.item.comments).toHaveLength(0);

    const outcome = only(await scenario.pass().run(AbortSignal.timeout(30_000)));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(scenario.boundary.item.status).toBe('To Do');
    expect(scenario.boundary.item.comments).toHaveLength(1);
    expect(scenario.boundary.jiraCalls.filter((call) => call.startsWith('moveTo'))).toHaveLength(1);
  });

  it('does not duplicate the resolution comment when the move failed first', async () => {
    const scenario = await scenarioFor({ merged: true });
    // The merge and its workflow are verified, the resolution comment lands,
    // and the status move does not: the item is still In Review with that
    // comment on it.
    scenario.boundary.fail('moveTo', { message: 'Jira refused the transition', times: 1 });

    const first = only(await scenario.pass().run(AbortSignal.timeout(30_000)));

    expect(first.status, first.detail).toBe('attention');
    expect(scenario.boundary.item.status).toBe('In Review');
    expect(scenario.boundary.item.comments).toHaveLength(1);
    expect(scenario.boundary.item.comments[0]?.text).toContain('nexus-completion:resolution:');

    const second = only(await scenario.pass().run(AbortSignal.timeout(30_000)));

    expect(second.status, second.detail).toBe('done');
    expect(scenario.boundary.item.status).toBe('Done');
    expect(scenario.boundary.item.comments).toHaveLength(1);
  });
});
