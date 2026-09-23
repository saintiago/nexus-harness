/**
 * The review-to-completion decisions: which pull request check is a definitive
 * failure, what a post-merge workflow's latest attempt means, which credential
 * and workflow boundaries the GitHub completion refuses to construct without,
 * where one item's merge deadline is measured from and what keeps it across
 * passes, what one completion pass writes and moves over stand-in
 * collaborators, and which outstanding transition or reopened ticket a
 * repeated pass may act on.
 *
 * No `gh` command, no live GitHub and no agent runs here: the GitHub evidence
 * boundary is a fake, and the Jira side is a mutable fake too (docs/testing.md).
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubCompletion } from '../../src/delivery/completion.js';
import type { CompletionConfig } from '../../src/shared/types.js';
import { DeliveryError } from '../../src/delivery/github.js';
import {
  checkFailed,
  checkPassed,
  checkPending,
  workflowMatches,
  workflowOutcomes,
} from '../../src/delivery/gate.js';
import type { WorkflowRunSnapshot } from '../../src/delivery/gate.js';
import {
  completionLogsDir,
  createCompletionPass,
  createCompletionRun,
  mergeWaitDeadline,
} from '../../src/sources/completion.js';
import type {
  CompletionActions,
  GateVerdict,
  MergeVerdict,
  PullRequestSnapshot,
} from '../../src/delivery/completion.js';
import type { CompletionSource, IssueNote, ReviewItem } from '../../src/sources/jira/completion.js';
import { noteWithMarker, reviewQueueJql } from '../../src/sources/jira/completion.js';
import type { SourceCandidate } from '../../src/sources/contract.js';
import type { JiraSourceConfig, SourceRef } from '../../src/shared/types.js';
import { createTempDir, readText } from '../support.js';

const HEAD = 'b'.repeat(40);
const MERGE_COMMIT = 'e'.repeat(40);

const REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'HARN-11',
  url: 'https://example.atlassian.net/browse/HARN-11',
  updatedAt: '2026-09-16T11:00:00.000Z',
};

const CONFIG: CompletionConfig = {
  lensApp: 'nexus-lens[bot]',
  lensAppId: 7,
  lensCheckName: 'Nexus Lens review',
  reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
  postMergeWorkflows: ['ci.yml'],
  toDoStatus: 'To Do',
  doneStatus: 'Done',
  pollIntervalSeconds: 5,
  deadlineSeconds: 60,
};

describe('one pull request check', () => {
  it('is a definitive failure when it completed unsuccessfully', () => {
    for (const conclusion of [
      'FAILURE',
      'ERROR',
      'FAILED',
      'CANCELLED',
      'TIMED_OUT',
      'ACTION_REQUIRED',
      'STALE',
      'STARTUP_FAILURE',
    ]) {
      expect(checkFailed({ name: 'CI', state: 'COMPLETED', conclusion, link: null })).toBe(true);
      expect(checkPending({ name: 'CI', state: 'COMPLETED', conclusion, link: null })).toBe(false);
    }
  });

  it('is not a failure while it is still running, and not a pass either', () => {
    for (const state of ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']) {
      const check = { name: 'CI', state, conclusion: null, link: null };
      expect(checkFailed(check)).toBe(false);
      expect(checkPending(check)).toBe(true);
      expect(checkPassed(check)).toBe(false);
    }
  });

  it('is a pass only when it completed successfully', () => {
    expect(checkPassed({ name: 'CI', state: 'COMPLETED', conclusion: 'SUCCESS', link: null })).toBe(
      true,
    );
    expect(checkFailed({ name: 'CI', state: 'COMPLETED', conclusion: 'SUCCESS', link: null })).toBe(
      false,
    );
    // A check with no state and no conclusion has not reported anything.
    const silent = { name: 'CI', state: null, conclusion: null, link: null };
    expect(checkFailed(silent)).toBe(false);
    expect(checkPending(silent)).toBe(false);
    expect(checkPassed(silent)).toBe(false);
  });
});

/** One workflow run as GitHub's run list reports it. */
function run(overrides: Partial<WorkflowRunSnapshot>): WorkflowRunSnapshot {
  return {
    databaseId: 1,
    workflowId: 10,
    workflowName: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    headSha: MERGE_COMMIT,
    url: 'https://github.com/owner/name/actions/runs/1',
    ...overrides,
  };
}

describe('matching a configured workflow', () => {
  it('matches a numeric id exactly, a bare file name wherever it lives, and a path', () => {
    expect(workflowMatches('10', run({}))).toBe(true);
    expect(workflowMatches('11', run({}))).toBe(false);
    expect(workflowMatches('ci.yml', run({}))).toBe(true);
    expect(workflowMatches('ci.yml', run({ path: '.github/workflows/release/ci.yml' }))).toBe(true);
    expect(workflowMatches('release/ci.yml', run({}))).toBe(false);
    expect(
      workflowMatches('.github/workflows/ci.yml', run({ path: '.github/workflows/ci.yml' })),
    ).toBe(true);
    expect(workflowMatches('', run({}))).toBe(false);
  });
});

describe('one configured workflow outcome', () => {
  it('is pending with no run, running until it completes, then success or unsuccessful', () => {
    expect(workflowOutcomes(['ci.yml'], [])[0]).toMatchObject({ state: 'pending', run: null });
    expect(workflowOutcomes(['ci.yml'], [run({ status: 'queued' })])[0]).toMatchObject({
      state: 'pending',
    });
    expect(workflowOutcomes(['ci.yml'], [run({ status: 'in_progress' })])[0]).toMatchObject({
      state: 'running',
    });
    expect(workflowOutcomes(['ci.yml'], [run({})])[0]).toMatchObject({
      state: 'success',
      conclusion: 'SUCCESS',
    });
    expect(workflowOutcomes(['ci.yml'], [run({ conclusion: 'failure' })])[0]).toMatchObject({
      state: 'unsuccessful',
      conclusion: 'FAILURE',
    });
  });

  it('reads only the latest attempt, so a superseded failure is not the state', () => {
    const outcomes = workflowOutcomes(
      ['ci.yml'],
      [
        run({ databaseId: 1, conclusion: 'failure' }),
        run({ databaseId: 2, conclusion: 'success' }),
      ],
    );
    expect(outcomes[0]).toMatchObject({ state: 'success' });

    // Two attempts of the same run id: the later attempt is the one read.
    const attempts = workflowOutcomes(
      ['ci.yml'],
      [
        run({ databaseId: 5, runAttempt: 1, conclusion: 'failure' }),
        run({ databaseId: 5, runAttempt: 2, conclusion: 'success' }),
      ],
    );
    expect(attempts[0]).toMatchObject({ state: 'success' });
  });

  it('keeps one outcome per configured workflow, in the configured order', () => {
    const outcomes = workflowOutcomes(
      ['ci.yml', 'release.yml'],
      [run({ path: '.github/workflows/release.yml', conclusion: 'failure' })],
    );
    expect(outcomes.map((outcome) => `${outcome.identifier}:${outcome.state}`)).toEqual([
      'ci.yml:pending',
      'release.yml:unsuccessful',
    ]);
  });
});

describe('the GitHub completion boundary', () => {
  it('refuses to be built without a separate reviewer credential or an expected workflow', () => {
    expect(() => createGitHubCompletion(CONFIG, '   ')).toThrow(DeliveryError);
    expect(() => createGitHubCompletion(CONFIG, 'reader-token')).not.toThrow();
    expect(() =>
      createGitHubCompletion({ ...CONFIG, postMergeWorkflows: [] }, 'reader-token'),
    ).toThrow(/At least one expected post-merge workflow is required/);
  });

  it('refuses a reviewer credential that is the operator credential', () => {
    expect(() =>
      createGitHubCompletion(CONFIG, 'the-same-token', { env: { GH_TOKEN: 'the-same-token' } }),
    ).toThrow(/Reviewer and operator credentials must be different/);
  });
});

describe('the merge wait deadline', () => {
  it('is measured from the moment the item began waiting, not from this pass', () => {
    const began = '2026-09-16T11:00:00.000Z';
    expect(mergeWaitDeadline(began, 60, Date.parse('2026-09-16T11:30:00.000Z'))).toBe(
      Date.parse(began) + 60_000,
    );
    // No recorded beginning means this reading starts the wait.
    const at = Date.parse('2026-09-16T11:30:00.000Z');
    expect(mergeWaitDeadline(null, 60, at)).toBe(at + 60_000);
    expect(mergeWaitDeadline('not-a-time', 60, at)).toBe(at + 60_000);
  });
});

describe('the Jira side of completion', () => {
  const source: JiraSourceConfig = {
    type: 'jira',
    siteUrl: 'https://example.atlassian.net',
    cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
    projectKey: 'HARN',
    issueType: 'Task',
    label: 'harness-task',
    readyStatus: 'To Do',
    runningStatus: 'In Progress',
    reviewStatus: 'In Review',
    ordering: 'rank',
    pollIntervalSeconds: 30,
    tokenEnv: 'JIRA_API_TOKEN',
  };

  it('asks for the review queue in its own fixed order, with the configured boundary', () => {
    const jql = reviewQueueJql(source);
    expect(jql).toContain('project = "HARN"');
    expect(jql).toContain('issuetype = "Task"');
    expect(jql).toContain('labels = "harness-task"');
    expect(jql).toContain('status = "In Review"');
    // Completing an item is not intake: the ready queue's ordering choice is
    // deliberately not read here.
    expect(jql).toContain('ORDER BY priority DESC, created ASC, key ASC');
    expect(jql).not.toContain('Rank');
  });

  it('recognizes only the whole marker line this harness writes', () => {
    const notes: readonly IssueNote[] = [
      { id: '1', createdAt: '2026-09-16T10:00:00.000Z', text: 'an ordinary comment' },
      {
        id: '2',
        createdAt: '2026-09-16T11:00:00.000Z',
        text: 'the result (nexus-completion:resolution:abc, written by the Nexus harness)',
      },
    ];
    expect(noteWithMarker(notes, 'nexus-completion:resolution:abc')?.id).toBe('2');
    // A comment that merely mentions the marker is not the harness's own.
    expect(noteWithMarker(notes, 'nexus-completion:resolution:def')).toBeNull();
  });
});

/** One status move the pass may ask for: what Jira answers, and whether it lands first. */
type MoveAnswer = 'moved' | 'left-alone' | { readonly failure: string; readonly lands?: boolean };

/**
 * One completion pass over a scripted item, actions and thread. The Jira fake is
 * mutable: a move that lands changes the item's status, the queue lists only
 * what is still In Review, and the changelog remembers when the item left it —
 * so a repeated pass reads the state its own write left behind.
 */
async function completionHarness(parts: {
  readonly item?: ReviewItem | null;
  readonly pullRequest?: PullRequestSnapshot | null;
  readonly gate?: () => Promise<GateVerdict> | GateVerdict;
  readonly merge?: () => Promise<MergeVerdict> | MergeVerdict;
  readonly approvedHead?: string | null;
  /** What each read of the reviewer's approval answers, in order; the last repeats. */
  readonly approvedHeadReads?: readonly (string | null | Error)[];
  readonly pullReads?: PullRequestSnapshot[];
  /** Whether GitHub already records auto-merge for the delivered head. */
  readonly armed?: boolean;
  readonly config?: Partial<CompletionConfig>;
  /** Whether the first comment write lands without answering. */
  readonly uncertainWrite?: boolean;
  /** What each status move answers, in order; a move the script does not name lands. */
  readonly moveAnswers?: readonly MoveAnswer[];
  /** The clock the pass reads; a case may move it past the item deadline. */
  readonly clockAt?: () => Date;
}) {
  const workDir = await createTempDir();
  const base: ReviewItem | null =
    parts.item === undefined
      ? {
          ref: REF,
          title: 'Add a greeting function',
          statusName: 'In Review',
          pointers: ['HARN-11'],
        }
      : parts.item;
  // The item's live status: a move that lands changes it, and a person may move
  // it back, exactly as Jira's own status would.
  let statusName = base?.statusName ?? 'In Review';
  const item = (): ReviewItem | null => (base === null ? null : { ...base, statusName });
  const ground =
    parts.armed === true
      ? { ...openPull(), autoMergeRequest: { enabledAt: 'earlier' } }
      : openPull();
  const pull = parts.pullRequest === undefined ? ground : parts.pullRequest;
  const clock = parts.clockAt ?? ((): Date => new Date('2026-09-16T11:10:00.000Z'));
  const comments: IssueNote[] = [];
  /** Jira's changelog: the moments this item left In Review. */
  const leftReviewAt: string[] = [];
  const calls = {
    posted: [] as { id: string; paragraphs: readonly string[] }[],
    moves: [] as { id: string; target: string }[],
    enableAutoMerge: 0,
    sleeps: 0,
    gates: 0,
    merges: 0,
    approvals: 0,
  };

  const readQueue = [...(parts.pullReads ?? [])];
  const actions: CompletionActions = {
    findPullRequest: async () => pull,
    findMergedPullRequest: async () => readQueue.shift() ?? pull ?? ground,
    readGate: async () => {
      calls.gates += 1;
      return parts.gate === undefined ? approvedGate() : await parts.gate();
    },
    readApprovedHead: async () => {
      calls.approvals += 1;
      const scripted = parts.approvedHeadReads;
      if (scripted !== undefined && scripted.length > 0) {
        const answer = scripted[Math.min(calls.approvals - 1, scripted.length - 1)];
        if (answer instanceof Error) throw answer;
        return answer ?? null;
      }
      return parts.approvedHead === undefined ? HEAD : parts.approvedHead;
    },
    readMerge: async () => {
      calls.merges += 1;
      return parts.merge === undefined ? verifiedMerge() : await parts.merge();
    },
    enableAutoMerge: async () => {
      calls.enableAutoMerge += 1;
      return 'enabled';
    },
  };

  const completionSource: CompletionSource = {
    listReview: async (): Promise<readonly SourceCandidate[]> =>
      base !== null && statusName === 'In Review' ? [{ ref: base.ref, title: base.title }] : [],
    readItem: async () => (statusName === 'In Review' ? item() : null),
    listComments: async () => comments,
    // Whatever left the item In Review at or after `since` is what a reopening
    // looks like: the item is In Review now only because a person moved it back.
    leftReviewSince: async (_id, since) =>
      leftReviewAt.some((at) => Date.parse(at) >= Date.parse(since)),
    postComment: async (id, paragraphs) => {
      calls.posted.push({ id, paragraphs });
      const note: IssueNote = {
        id: 'comment-1',
        createdAt: clock().toISOString(),
        text: paragraphs.join('\n'),
      };
      comments.push(note);
      if (parts.uncertainWrite === true && calls.posted.length === 1) {
        // The write landed; its answer never arrived.
        throw new Error('the connection dropped before the comment was acknowledged');
      }
      return note.id;
    },
    moveTo: async (id, target, _stop, beforeWrite) => {
      const attempt = calls.moves.length;
      calls.moves.push({ id, target });
      // The production move re-reads the item and its guards before it writes.
      if (beforeWrite !== undefined && !(await beforeWrite())) return 'left-alone';
      const answer = parts.moveAnswers?.[attempt];
      if (answer === 'left-alone') return 'left-alone';
      if (answer === undefined || answer === 'moved' || answer.lands === true) {
        statusName = target;
        leftReviewAt.push(clock().toISOString());
      }
      if (answer !== undefined && answer !== 'moved') {
        throw new Error(answer.failure);
      }
      return 'moved';
    },
  };

  const outputs: string[] = [];
  const pass = createCompletionPass({
    config: { ...CONFIG, ...parts.config },
    repository: 'owner/name',
    baseBranch: 'main',
    source: completionSource,
    actions,
    workDir,
    io: { out: (text) => outputs.push(text), err: (text) => outputs.push(text) },
    now: clock,
    sleep: async () => {
      calls.sleeps += 1;
    },
  });
  return {
    workDir,
    pass,
    calls,
    outputs,
    comments,
    /** The item's status right now, as Jira would report it. */
    itemStatus: (): string => statusName,
    /** A person moves the item back into the review status. */
    reopen: (): void => {
      statusName = 'In Review';
    },
  };
}

function openPull(): PullRequestSnapshot {
  return {
    number: 7,
    url: 'https://github.com/owner/name/pull/7',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'harness/HARN-11',
    baseRefName: 'main',
    headRefOid: HEAD,
    autoMergeRequest: null,
    mergeable: 'MERGEABLE',
    mergeCommit: null,
  };
}

/** The pull request GitHub has already merged at the reviewed head. */
function mergedPull(): PullRequestSnapshot {
  return {
    ...openPull(),
    state: 'MERGED',
    autoMergeRequest: { enabledAt: 'now' },
    mergeCommit: { oid: MERGE_COMMIT },
  };
}

/** A merge reading that verified one merge commit and its post-merge workflow. */
function verifiedMerge(): MergeVerdict {
  return {
    status: 'complete',
    reason: 'the merge and every post-merge workflow succeeded',
    mergeCommit: MERGE_COMMIT,
    workflows: [{ identifier: 'ci.yml', state: 'success', run: run({}), conclusion: 'SUCCESS' }],
  };
}

/** A merge GitHub has not made yet: the item stays In Review and waits. */
function pendingMerge(): MergeVerdict {
  return {
    status: 'pending',
    reason: 'GitHub has not merged this pull request yet',
    mergeCommit: null,
    workflows: [],
  };
}

/** The wait start one pass recorded for the default item, as the next pass reads it. */
async function recordedWaitStart(workDir: string): Promise<string | null> {
  const file = path.join(
    completionLogsDir(workDir, REF, 'owner/name'),
    'completion-armed-head.json',
  );
  const record = JSON.parse(await readText(file)) as { waitingSince?: string | null };
  return record.waitingSince ?? null;
}

function approvedGate(): GateVerdict {
  return {
    status: 'approved',
    reason: 'the current head carries the Nexus Lens approval and its check',
    review: {
      id: '21',
      author: CONFIG.lensApp,
      state: 'APPROVED',
      body: 'the review body',
      commitId: HEAD,
      url: 'https://github.com/owner/name/pull/7#review-21',
    },
    findings: [],
  };
}

/** The gate reading that returns a pull request to To Do with its findings. */
function changesRequestedGate(): GateVerdict {
  return {
    status: 'failed',
    reason: 'the reviewer requested changes on the current head',
    review: {
      id: '21',
      author: CONFIG.lensApp,
      state: 'CHANGES_REQUESTED',
      body: 'please fix the greeting',
      commitId: HEAD,
      url: 'https://github.com/owner/name/pull/7#review-21',
    },
    findings: [
      {
        label: 'src/greeting.ts',
        detail: 'the greeting ignores the supplied name',
        link: 'https://github.com/owner/name/pull/7#discussion_r1',
      },
    ],
  };
}

describe('one completion pass', () => {
  it('concludes a verified merge by writing one comment and moving the item to Done', async () => {
    const harness = await completionHarness({
      // The first read has no auto-merge request, and GitHub's own state shows
      // it enabled after the one request this path makes.
      pullReads: [openPull(), { ...openPull(), autoMergeRequest: { enabledAt: 'now' } }],
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('done');
    expect(outcomes[0]?.mergeCommit).toBe(MERGE_COMMIT);
    expect(harness.calls.enableAutoMerge).toBe(1);
    expect(harness.calls.posted).toHaveLength(1);
    expect(harness.calls.posted[0]?.paragraphs.join('\n')).toContain(
      'nexus-completion:resolution:',
    );
    expect(harness.calls.moves).toEqual([{ id: REF.id, target: 'Done' }]);
  });

  it('returns a failed gate to the To Do status with its findings, changing no merge', async () => {
    const harness = await completionHarness({
      gate: () => ({
        status: 'failed',
        reason: 'the reviewer requested changes on the current head',
        review: {
          id: '21',
          author: CONFIG.lensApp,
          state: 'CHANGES_REQUESTED',
          body: 'please fix the greeting',
          commitId: HEAD,
          url: 'https://github.com/owner/name/pull/7#review-21',
        },
        findings: [
          {
            label: 'src/greeting.ts',
            detail: 'the greeting ignores the supplied name',
            link: 'https://github.com/owner/name/pull/7#discussion_r1',
          },
        ],
      }),
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes[0]?.status).toBe('to-do');
    expect(outcomes[0]?.mergeCommit).toBeNull();
    expect(harness.calls.posted[0]?.paragraphs.join('\n')).toContain(
      'the greeting ignores the supplied name',
    );
    expect(harness.calls.moves).toEqual([{ id: REF.id, target: 'To Do' }]);
  });

  it('waits inside one pass while the gate is still pending, then concludes', async () => {
    let gate = 0;
    const harness = await completionHarness({
      gate: () => {
        gate += 1;
        return gate === 1
          ? { status: 'pending', reason: 'the check is still running', review: null, findings: [] }
          : approvedGate();
      },
      pullReads: [openPull(), { ...openPull(), autoMergeRequest: { enabledAt: 'now' } }],
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes[0]?.status).toBe('done');
    expect(harness.calls.sleeps).toBeGreaterThan(0);
  });

  it('needs a person when GitHub merged a head the reviewer did not approve', async () => {
    const harness = await completionHarness({
      pullRequest: mergedPull(),
      approvedHead: null,
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes[0]?.status).toBe('attention');
    expect(outcomes[0]?.detail).toMatch(/cannot be tied to the reviewed head/);
    expect(harness.calls.posted).toEqual([]);
    expect(harness.calls.moves).toEqual([]);
  });

  it('leaves an item alone when no open pull request matches its workspace branch', async () => {
    const harness = await completionHarness({ pullRequest: null });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes[0]?.status).toBe('observed');
    expect(harness.calls.posted).toEqual([]);
    expect(harness.calls.moves).toEqual([]);
  });

  it('does not touch an item without exactly one workspace pointer', async () => {
    const harness = await completionHarness({
      item: {
        ref: REF,
        title: 'Add a greeting function',
        statusName: 'In Review',
        pointers: [],
      },
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes[0]?.status).toBe('observed');
    expect(outcomes[0]?.detail).toMatch(/no workspace pointer/);
  });

  it('retries only the transition a verified comment left outstanding', async () => {
    const harness = await completionHarness({
      armed: true,
      // The comment lands and the transition does not: Jira refused it.
      moveAnswers: [{ failure: 'Jira refused the transition', lands: false }],
    });
    const stop = new AbortController().signal;

    const first = await harness.pass.run(stop);

    expect(first[0]?.status).toBe('attention');
    expect(first[0]?.detail).toMatch(/moving it to "Done" failed/);
    expect(first[0]?.commentId).toBe('comment-1');
    expect(harness.itemStatus()).toBe('In Review');
    expect(harness.calls.posted).toHaveLength(1);
    expect(harness.calls.moves).toHaveLength(1);

    // The next pass finds the resolution comment its own marker names and retries
    // only the outstanding transition: the outcome is not written twice.
    const second = await harness.pass.run(stop);

    expect(second[0]?.status).toBe('done');
    expect(second[0]?.commentId).toBe('comment-1');
    expect(harness.itemStatus()).toBe('Done');
    expect(harness.calls.posted).toHaveLength(1);
    expect(harness.calls.moves).toHaveLength(2);
  });

  it('does not ask again for a transition Jira accepted without answering', async () => {
    const harness = await completionHarness({
      armed: true,
      // The transition landed at Jira, and the answer to the request was lost.
      moveAnswers: [{ failure: 'the answer to the status move was lost', lands: true }],
    });
    const stop = new AbortController().signal;

    const first = await harness.pass.run(stop);

    expect(first[0]?.status).toBe('attention');
    expect(first[0]?.detail).toMatch(/moving it to "Done" failed/);
    expect(harness.itemStatus()).toBe('Done');
    expect(harness.calls.posted).toHaveLength(1);

    // The item left In Review, so the next pass has nothing to do — and no second
    // transition is ever asked for.
    const second = await harness.pass.run(stop);

    expect(second).toEqual([]);
    expect(harness.calls.moves).toHaveLength(1);
    expect(harness.calls.posted).toHaveLength(1);
  });

  it('does not replay an outcome a person reopened the ticket after', async () => {
    const harness = await completionHarness({
      gate: () => changesRequestedGate(),
    });
    const stop = new AbortController().signal;

    const first = await harness.pass.run(stop);

    expect(first[0]?.status).toBe('to-do');
    expect(harness.itemStatus()).toBe('To Do');
    expect(harness.calls.posted).toHaveLength(1);
    expect(harness.calls.moves).toEqual([{ id: REF.id, target: 'To Do' }]);

    // A person moves the item back into review. The item's own changelog says it
    // left review after this outcome, so the old one is not replayed: the next
    // pass only observes, and neither writes nor moves anything.
    harness.reopen();
    const second = await harness.pass.run(stop);

    expect(second[0]?.status).toBe('observed');
    expect(second[0]?.detail).toMatch(/reopened after this outcome/);
    expect(second[0]?.commentId).toBe('comment-1');
    expect(harness.calls.posted).toHaveLength(1);
    expect(harness.calls.moves).toHaveLength(1);
    expect(harness.itemStatus()).toBe('In Review');
  });

  it('reads a transient GitHub failure again inside the item deadline', async () => {
    let reads = 0;
    let refused = 0;
    const harness = await completionHarness({
      armed: true,
      gate: () => {
        reads += 1;
        if (reads === 1) {
          refused += 1;
          throw new DeliveryError('GitHub answered 503', { retryable: true });
        }
        return approvedGate();
      },
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes[0]?.status).toBe('done');
    // The refusal cost one extra read, not a stop for a person: the gate is read
    // again after the configured interval, here and for the merge it admits.
    expect(refused).toBe(1);
    expect(reads).toBeGreaterThan(1);
    expect(harness.calls.sleeps).toBe(1);
  });

  it('settles an uncertain comment write by reading the thread again', async () => {
    const harness = await completionHarness({
      uncertainWrite: true,
      gate: () => ({
        status: 'failed',
        reason: 'the reviewer requested changes on the current head',
        review: {
          id: '21',
          author: CONFIG.lensApp,
          state: 'CHANGES_REQUESTED',
          body: 'please fix the greeting',
          commitId: HEAD,
          url: 'https://github.com/owner/name/pull/7#review-21',
        },
        findings: [
          { label: 'src/greeting.ts', detail: 'wrong value', link: 'https://example.test' },
        ],
      }),
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    // The comment that landed is the one the pass concludes with: it is not
    // written a second time, and the item is still moved back for repair.
    expect(outcomes[0]?.status).toBe('to-do');
    expect(outcomes[0]?.commentId).toBe('comment-1');
    expect(harness.calls.posted).toHaveLength(1);
    expect(harness.calls.moves).toEqual([{ id: REF.id, target: 'To Do' }]);
  });

  it('stops a still-pending gate at the item deadline instead of polling forever', async () => {
    const start = Date.parse('2026-09-16T11:10:00.000Z');
    let readings = 0;
    const harness = await completionHarness({
      config: { deadlineSeconds: 60 },
      // The item's own budget is what expires: the first read establishes the
      // deadline, and the next one finds it already spent.
      clockAt: () => {
        readings += 1;
        return new Date(readings === 1 ? start : start + 120_000);
      },
      gate: () => ({
        status: 'pending',
        reason: 'the check is still running',
        review: null,
        findings: [],
      }),
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes[0]?.status).toBe('attention');
    expect(outcomes[0]?.detail).toMatch(/still pending when this item's deadline expired/);
    expect(harness.calls.sleeps).toBe(0);
  });

  it('keeps one item deadline across passes and reports its expiry once', async () => {
    const start = Date.parse('2026-09-16T11:10:00.000Z');
    let at = start;
    const harness = await completionHarness({
      armed: true,
      config: { deadlineSeconds: 60 },
      merge: () => pendingMerge(),
      clockAt: () => new Date(at),
    });
    const stop = new AbortController().signal;

    // One pass waits its bounded number of rounds, writes nothing, and records
    // the moment the item began waiting for GitHub.
    const first = await harness.pass.run(stop);

    expect(first[0]?.status).toBe('pending');
    expect(harness.calls.merges).toBe(3);
    expect(harness.calls.sleeps).toBe(2);
    expect(harness.calls.posted).toEqual([]);
    expect(harness.calls.moves).toEqual([]);
    const waitingSince = await recordedWaitStart(harness.workDir);
    expect(waitingSince).toBe(new Date(start).toISOString());

    // A later pass, still inside the deadline, reads that recorded start back
    // instead of beginning the wait again.
    at = start + 5_000;
    const readsSoFar = harness.calls.merges;
    const second = await harness.pass.run(stop);

    expect(second[0]?.status).toBe('pending');
    expect(harness.calls.merges - readsSoFar).toBe(3);
    expect(await recordedWaitStart(harness.workDir)).toBe(waitingSince);

    // Past the item's deadline the still-pending merge is reported once, and the
    // item stays In Review: no failure conclusion was ever observed.
    at = start + 120_000;
    const third = await harness.pass.run(stop);

    expect(third[0]?.status).toBe('attention');
    expect(third[0]?.detail).toMatch(/still pending when this item's deadline expired/);
    expect(harness.calls.posted).toHaveLength(1);
    expect(harness.calls.posted[0]?.paragraphs.join('\n')).toContain('nexus-completion:attention:');
    expect(harness.calls.moves).toEqual([]);
    expect(harness.itemStatus()).toBe('In Review');

    // A later pass reports the same expiry without a second notification.
    at = start + 125_000;
    const fourth = await harness.pass.run(stop);

    expect(fourth[0]?.status).toBe('attention');
    expect(fourth[0]?.commentId).toBe(third[0]?.commentId);
    expect(harness.calls.posted).toHaveLength(1);
  });

  it('does not mint a fresh deadline for the read guarding the resolution comment', async () => {
    const start = Date.parse('2026-09-16T11:10:00.000Z');
    let readings = 0;
    const harness = await completionHarness({
      pullRequest: mergedPull(),
      config: { deadlineSeconds: 60 },
      // Every reading of the clock is a step of its own, so by the time the
      // guard's read is refused the item's one budget has been spent. The read
      // after the refusal would have answered: a fresh budget would have written
      // the comment, moved the item, and concluded the merge.
      clockAt: () => {
        readings += 1;
        return new Date(start + readings * 30_000);
      },
      approvedHeadReads: [
        HEAD,
        new DeliveryError('GitHub returned HTTP 503', { retryable: true }),
        HEAD,
      ],
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes[0]?.status).toBe('attention');
    expect(outcomes[0]?.detail).toContain('503');
    // The unreadable answer was refused, not repeated: the first read and the
    // refusal are all the pass took, and nothing was written from a state it
    // could not verify.
    expect(harness.calls.approvals).toBe(2);
    expect(harness.calls.sleeps).toBe(0);
    expect(harness.calls.posted).toEqual([]);
    expect(harness.calls.moves).toEqual([]);
    expect(harness.itemStatus()).toBe('In Review');
  });

  it('does not mint a fresh deadline for the read guarding the status move', async () => {
    const start = Date.parse('2026-09-16T11:10:00.000Z');
    let readings = 0;
    const harness = await completionHarness({
      pullRequest: mergedPull(),
      config: { deadlineSeconds: 60 },
      clockAt: () => {
        readings += 1;
        return new Date(start + readings * 30_000);
      },
      approvedHeadReads: [
        HEAD,
        HEAD,
        new DeliveryError('GitHub returned HTTP 503', { retryable: true }),
        HEAD,
      ],
    });

    const outcomes = await harness.pass.run(new AbortController().signal);

    expect(outcomes[0]?.status).toBe('attention');
    expect(outcomes[0]?.detail).toMatch(/moving it to "Done" failed/);
    expect(outcomes[0]?.detail).toContain('503');
    // The same bound covers the move's own guard: the resolution comment is
    // published exactly once, the move is left outstanding, and no fresh
    // deadline is minted to retry it here.
    expect(harness.calls.approvals).toBe(3);
    expect(harness.calls.sleeps).toBe(0);
    expect(harness.calls.posted).toHaveLength(1);
    expect(harness.calls.posted[0]?.paragraphs.join('\n')).toContain(
      'nexus-completion:resolution:',
    );
    expect(harness.calls.moves).toHaveLength(1);
    expect(harness.itemStatus()).toBe('In Review');
  });
});

describe('one completion run', () => {
  it('counts what each item ended as and prints it', async () => {
    const lines: string[] = [];
    const run = createCompletionRun(
      {
        run: async () => [
          { ref: REF, status: 'done', detail: 'verified merge', commentId: 'comment-1' },
          {
            ref: { ...REF, key: 'HARN-12' },
            status: 'to-do',
            detail: 'findings published',
            commentId: 'comment-2',
          },
          {
            ref: { ...REF, key: 'HARN-13' },
            status: 'attention',
            detail: 'needs a decision',
            commentId: null,
          },
          {
            ref: { ...REF, key: 'HARN-14' },
            status: 'observed',
            detail: 'left In Review',
            commentId: null,
          },
        ],
        arm: async () => [],
      },
      { out: (text) => lines.push(text), err: (text) => lines.push(text) },
    );

    const summary = await run.run(new AbortController().signal);

    expect(summary).toEqual({ done: 1, toDo: 1, attention: 1, observed: 1, problem: null });
    expect(lines.join('\n')).toContain('HARN-11: completed: verified merge');
    expect(lines.join('\n')).toContain('HARN-12: returned for repair');
    expect(lines.join('\n')).toContain('HARN-13: needs a person');
  });

  it('reports a discovery failure as a problem instead of throwing', async () => {
    const run = createCompletionRun(
      {
        run: async () => {
          throw new DeliveryError('GitHub answered 503');
        },
        arm: async () => [],
      },
      { out: () => undefined, err: () => undefined },
    );

    const summary = await run.run(new AbortController().signal);

    expect(summary.problem).toContain('503');
    expect(summary.done).toBe(0);
  });
});
