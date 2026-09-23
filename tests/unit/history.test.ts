/**
 * The conversation-history rules: what one entry keeps of its source, how a
 * published rendering is recognized as a mirror of the complete report it
 * renders, which review round is still outstanding and which approvals clear it,
 * what feedback a role has consumed, and how a gap is reported instead of being
 * filled in.
 *
 * The readers are stand-ins and the store is a temporary directory: no Jira,
 * GitHub, or agent call happens here (docs/testing.md).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  HistorySnapshot,
  PullRequestConversationRead,
  ReadComment,
  TicketHistory,
} from '../../src/history/contract.js';
import { HistoryError } from '../../src/history/contract.js';
import { historyMarkerOf } from '../../src/history/marker.js';
import { workspaceHistoryRoot } from '../../src/history/paths.js';
import { compareHistoryTime } from '../../src/history/time.js';
import {
  listSnapshots,
  readConsumedEntries,
  readCurrent,
  recordConsumedSnapshot,
  snapshotIdOf,
  writeSnapshot,
} from '../../src/history/store.js';
import type { SnapshotContent } from '../../src/history/store.js';
import { createTicketHistory } from '../../src/history/sync.js';
import {
  latestCodingTurnText,
  notePublishedReview,
  textSha256,
} from '../../src/history/reports.js';
import { renderHistorySection } from '../../src/history/prompt.js';
import {
  outstandingFindingIds,
  retainedFindingIds,
  unresolvedRounds,
} from '../../src/history/findings.js';
import { parseVerdict } from '../../src/reviews/reviewer.js';
import { baselineEvidenceId } from '../../src/sources/baseline.js';
import {
  incidentFilePath,
  openIncident,
  supervisorRoot,
  writeIncident,
} from '../../src/supervisor/incident.js';
import { sourceItemFor, writeWorkspaceState } from '../../src/workspace/state.js';
import type { CheckRoundResult, SourceRef, Task } from '../../src/shared/types.js';
import { createTempDir } from '../support.js';

const REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'HARN-11',
  url: 'https://example.atlassian.net/browse/HARN-11',
  updatedAt: '2026-09-16T09:00:00.000Z',
};

const TASK: Task = {
  id: 'HARN-11',
  title: 'Add a greeting function',
  description: 'Implement the greeting the ticket describes.',
  acceptanceCriteria: ['The greeting is implemented.'],
};

const HEAD = 'b'.repeat(40);

/** One ticket history over the readers a case scripts. */
function history(
  workDir: string,
  parts: {
    readonly jira?: (
      ref: SourceRef,
    ) => Promise<{ readonly comments: readonly ReadComment[]; readonly truncated: boolean }>;
    readonly pull?: (
      ref: SourceRef,
      workspaceId: string,
    ) => Promise<PullRequestConversationRead | null>;
    readonly currentTask?: (
      ref: SourceRef,
    ) => Promise<{ readonly ref: SourceRef; readonly task: Task }>;
  } = {},
): TicketHistory {
  return createTicketHistory({
    workDir,
    harnessAuthors: ['nexus-lens[bot]', 'Nexus Lens'],
    now: () => new Date('2026-09-16T12:00:00.000Z'),
    readers: {
      currentTask: async (ref) =>
        parts.currentTask === undefined ? { ref, task: TASK } : await parts.currentTask(ref),
      jiraThread: async (ref) =>
        parts.jira === undefined ? { comments: [], truncated: false } : await parts.jira(ref),
      pullRequestConversation: async (ref, workspaceId) =>
        parts.pull === undefined ? null : await parts.pull(ref, workspaceId),
    },
  });
}

/** One Jira comment, as the reader returns it. */
function jiraComment(overrides: Partial<ReadComment> = {}): ReadComment {
  return {
    sourceId: 'comment-1',
    author: 'A person',
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: null,
    text: 'a comment about the work',
    url: 'https://example.atlassian.net/browse/HARN-11?focusedCommentId=comment-1',
    ...overrides,
  };
}

/** One pull request conversation with the comments a case names. */
function pullConversation(comments: readonly ReadComment[]): PullRequestConversationRead {
  return {
    pullRequest: {
      number: 7,
      url: 'https://github.com/owner/name/pull/7',
      title: 'HARN-11: add a greeting function',
      headBranch: 'harness/HARN-11',
      baseBranch: 'main',
      headSha: HEAD,
      observedAt: '2026-09-16T11:00:00.000Z',
    },
    comments,
    truncated: false,
  };
}

/** Prepares one snapshot for one workspace. */
function prepare(
  ticketHistory: TicketHistory,
  role: 'developer' | 'reviewer' = 'developer',
  round: number | null = 1,
): Promise<HistorySnapshot> {
  return ticketHistory.prepare({
    ref: REF,
    task: TASK,
    workspace: {
      workspaceId: 'HARN-11',
      workspacePath: 'unused-workspace',
      branch: 'harness/HARN-11',
      baseCommit: HEAD,
    },
    role,
    round,
    stop: new AbortController().signal,
  });
}

describe('the entry marker', () => {
  it('recognizes one developer or reviewer marker and nothing else', () => {
    expect(historyMarkerOf('nexus-history: developer run-1')).toEqual({
      kind: 'developer',
      id: 'run-1',
    });
    expect(historyMarkerOf('a comment\nnexus-history: reviewer review-7\nmore')).toEqual({
      kind: 'reviewer',
      id: 'review-7',
    });
    expect(
      historyMarkerOf(
        'the first one wins: nexus-history: developer a then nexus-history: developer b',
      ),
    ).toEqual({ kind: 'developer', id: 'a' });
    expect(historyMarkerOf('nexus-history: someone else')).toBeNull();
    expect(historyMarkerOf('an ordinary comment')).toBeNull();
  });
});

describe('comparing timestamps', () => {
  it('orders instants across timezone offsets and UTC spellings', () => {
    expect(compareHistoryTime('2026-09-16T12:00:00.000+02:00', '2026-09-16T10:00:00.000Z')).toBe(0);
    expect(compareHistoryTime('2026-09-16T09:00:00.000Z', '2026-09-16T10:00:00.000Z')).toBeLessThan(
      0,
    );
    // An unknown legacy time ties conservatively instead of ordering wrongly.
    expect(compareHistoryTime('not-a-time', '2026-09-16T10:00:00.000Z')).toBe(0);
  });
});

describe('the supervised recoveries a ticket’s history carries', () => {
  it('keeps one incident whole, with the account’s own comments, for both roles', async () => {
    const workDir = await createTempDir();
    const root = supervisorRoot(workDir, 'namespace');
    const seeded = openIncident(
      'namespace',
      'ticket',
      REF.key,
      2,
      () => new Date('2026-09-16T10:00:00.000Z'),
    );
    await writeIncident(incidentFilePath(root, seeded.id), {
      ...seeded,
      updatedAt: '2026-09-16T11:00:00.000Z',
      stage: 'settled',
      ticket: { key: REF.key, url: REF.url },
      conclusion: {
        outcome: 'repaired',
        detail: 'the workspace was returned to its recorded branch',
        at: '2026-09-16T11:00:00.000Z',
      },
      stops: [
        {
          at: '2026-09-16T10:05:00.000Z',
          intent: 'ticket',
          scope: REF.key,
          exitCode: 1,
          signal: null,
          ending: 'exited',
          launch: null,
          signature: 'signature',
        },
      ],
      attempts: [
        {
          attempt: 1,
          startedAt: '2026-09-16T10:10:00.000Z',
          endedAt: '2026-09-16T11:00:00.000Z',
          outcome: 'repaired',
          summary: 'the consumer was killed mid-run',
          cause: 'a stale intake lock',
          resolution: 'the lock was explained and the ticket returned to its ready status',
          preserved: ['committed work on harness/HARN-11'],
          resume: 'HARN-11 resumes from its retained workspace',
          blocker: null,
          help: null,
          problem: null,
          dir: null,
          logPath: null,
        },
      ],
      report: {
        publishedAt: '2026-09-16T11:00:00.000Z',
        commentId: 'comment-report',
        commentText: 'Harness recovery report (incident seeded).',
        conclusion: { outcome: 'repaired', at: '2026-09-16T11:00:00.000Z' },
        superseded: [],
        notification: null,
        problem: null,
      },
    });
    // A comment the same service account wrote while the recovery ran: it is
    // that incident's own comment, not a person's feedback — and the incident's
    // published report is recognized by the identity the record kept, whatever
    // display name the account carries.
    const comments = [
      jiraComment({
        sourceId: 'comment-report',
        author: 'Nexus Service Account',
        createdAt: '2026-09-16T10:20:00.000Z',
        text: 'Harness recovery report (incident seeded). The supervised queue stopped.',
      }),
      jiraComment({
        sourceId: 'comment-recovery',
        author: 'nexus-lens[bot]',
        createdAt: '2026-09-16T10:30:00.000Z',
        text: 'the lock was explained and the ticket returned to its ready status',
      }),
    ];
    const ticketHistory = history(workDir, {
      jira: async () => ({ comments, truncated: false }),
    });
    // Both roles read the same recovery context: it is the account's own record
    // of what happened to the ticket, not one role's private view.
    const reviewer = await prepare(ticketHistory, 'reviewer');
    const developer = await prepare(ticketHistory, 'developer');
    const snapshot = reviewer;

    const entry = snapshot.entries.find((candidate) => candidate.kind === 'recovery-report');
    const developerEntry = developer.entries.find(
      (candidate) => candidate.kind === 'recovery-report',
    );
    expect(entry?.complete).toBe(true);
    expect(developerEntry?.text).toBe(entry?.text);
    expect(entry?.text).toContain('a stale intake lock');
    expect(entry?.text).toContain('the lock was explained');
    expect(entry?.text).toContain('committed work on harness/HARN-11');
    expect(snapshot.brief.recovery?.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([
        entry?.id,
        'jira:jira-comment:comment-recovery',
        'jira:jira-comment:comment-report',
      ]),
    );
    // Neither the incident nor the account's comment was offered to the
    // reviewer as a person's feedback.
    expect(snapshot.brief.newHumanFeedback).toEqual([]);
    // The report the incident published is the harness's own text, whatever the
    // service account is called in the thread.
    expect(
      snapshot.entries.find((candidate) => candidate.id === 'jira:jira-comment:comment-report')
        ?.role,
    ).toBe('harness');

    // Both roles read the same recovery section, and it says what it is.
    const prompt = renderHistorySection(snapshot, 'reviewer');
    expect(prompt).toContain('### Recovery context');
    expect(prompt).toContain('never an approval');
    expect(prompt).toContain('a stale intake lock');
  });
});

describe('the snapshot store', () => {
  /** The tracked content one snapshot is identified by. */
  function content(overrides: Partial<SnapshotContent> = {}): SnapshotContent {
    return {
      role: 'developer',
      round: 1,
      ref: REF,
      task: TASK,
      brief: {
        ref: REF,
        task: TASK,
        latestDelivery: null,
        unresolved: null,
        responses: [],
        newHumanFeedback: [],
      },
      sources: [{ source: 'jira', problem: null }],
      gaps: [],
      mirrors: [],
      entries: [],
      reports: [],
      ...overrides,
    };
  }

  it('identifies a snapshot by its content, not by its key order or its clock', () => {
    const left = content();
    const right = { ...left, task: { ...TASK } };
    expect(snapshotIdOf(left)).toBe(snapshotIdOf(right));
    expect(snapshotIdOf(content({ round: 2 }))).not.toBe(snapshotIdOf(left));
  });

  it('writes each snapshot once and reuses the one whose content is already stored', async () => {
    const root = await createTempDir();

    const first = await writeSnapshot(root, content(), new Date('2026-09-16T12:00:00.000Z'));
    const second = await writeSnapshot(root, content(), new Date('2026-09-16T13:00:00.000Z'));

    expect(second.id).toBe(first.id);
    expect(second.dir).toBe(first.dir);
    // The snapshot a turn holds is never rewritten: its taken time is the one it
    // was first written with.
    expect(second.takenAt).toBe(first.takenAt);
    expect(await listSnapshots(root)).toEqual([first.id]);
    expect(await readFile(first.indexPath, 'utf8')).toContain('(no conversation entry was read)');
    expect(await readFile(first.entriesPath, 'utf8')).toBe('');
    expect(await readFile(path.join(first.dir, 'task.json'), 'utf8')).toContain(TASK.title);

    const changed = await writeSnapshot(
      root,
      content({ round: 2 }),
      new Date('2026-09-16T14:00:00.000Z'),
    );
    expect(changed.id).not.toBe(first.id);
    expect((await readCurrent(root))?.snapshotId).toBe(changed.id);
    expect(await listSnapshots(root)).toEqual([first.id, changed.id].sort());
    // The earlier snapshot is still there, exactly as it was written.
    expect(await readFile(first.indexPath, 'utf8')).toContain(`Snapshot: ${first.id}`);
  });

  it('treats a missing, legacy, or unreadable cursor as nothing consumed', async () => {
    const root = await createTempDir();
    const snapshot = await writeSnapshot(root, content(), new Date('2026-09-16T12:00:00.000Z'));

    expect(await readConsumedEntries(root, 'developer')).toBeNull();

    await writeFile(path.join(root, 'consumed-developer.json'), '{ not json', 'utf8');
    expect(await readConsumedEntries(root, 'developer')).toBeNull();

    await recordConsumedSnapshot(snapshot);
    expect(await readConsumedEntries(root, 'developer')).toEqual([]);
    // Only the role that consumed it has it.
    expect(await readConsumedEntries(root, 'reviewer')).toBeNull();

    // A cursor naming a snapshot that is gone replays conservatively.
    await rm(snapshot.dir, { recursive: true, force: true });
    expect(await readConsumedEntries(root, 'developer')).toBeNull();
  });

  it('computes the history root beside the retained workspace', () => {
    expect(workspaceHistoryRoot('/work', 'HARN-11')).toBe(
      path.resolve('/work/workspaces/HARN-11') + '.history',
    );
  });
});

describe('one ticket history', () => {
  it('records every source read, every entry, and the refreshed requirements', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir, {
      jira: async () => ({ comments: [jiraComment()], truncated: false }),
      pull: async () =>
        pullConversation([
          {
            sourceId: '998',
            author: 'owner',
            createdAt: '2026-09-16T10:30:00.000Z',
            updatedAt: null,
            text: 'a pull request comment',
            url: null,
          },
        ]),
      currentTask: async (ref) => ({
        ref: { ...ref, updatedAt: '2026-09-16T09:30:00.000Z' },
        task: TASK,
      }),
    });

    const snapshot = await prepare(ticketHistory);

    expect(snapshot.sources).toEqual([
      { source: 'jira', problem: null },
      { source: 'github', problem: null },
      { source: 'harness', problem: null },
    ]);
    expect(snapshot.gaps).toEqual([]);
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      'jira:jira-comment:comment-1',
      'github:pr-comment:998',
    ]);
    // The refreshed requirements are the snapshot's own, and the brief carries
    // the pull request GitHub reports now.
    expect(snapshot.brief.task).toEqual(TASK);
    expect(snapshot.brief.latestDelivery?.head).toBe(HEAD);
    expect(snapshot.brief.unresolvedReviews).toEqual([]);
    expect(snapshot.brief.newHumanFeedback.map((entry) => entry.sourceId)).toEqual([
      'comment-1',
      '998',
    ]);
    // The turn can read every entry from a file of its own.
    expect(
      await readFile(path.join(snapshot.dir, snapshot.entries[0]?.file ?? ''), 'utf8'),
    ).toContain('a comment about the work');
  });

  it('keeps one entry per source identity, marking an edited comment as edited', async () => {
    const workDir = await createTempDir();
    let text = 'the original wording';
    const ticketHistory = history(workDir, {
      jira: async () => ({
        comments: [jiraComment({ text, updatedAt: '2026-09-16T11:30:00.000Z' })],
        truncated: false,
      }),
    });

    const first = await prepare(ticketHistory);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]?.edited).toBe(true);

    text = 'the wording after the edit';
    const second = await prepare(ticketHistory, 'reviewer');
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.id).toBe(first.entries[0]?.id);
    expect(second.entries[0]?.text).toBe('the wording after the edit');
  });

  it('reports what could not be read as a gap instead of an empty thread', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir, {
      jira: async () => {
        throw new Error('the Jira read failed');
      },
      pull: async () => ({
        pullRequest: {
          number: 7,
          url: 'https://github.com/owner/name/pull/7',
          title: 'HARN-11',
          headBranch: 'harness/HARN-11',
          baseBranch: 'main',
          headSha: HEAD,
          observedAt: '2026-09-16T11:00:00.000Z',
        },
        comments: [],
        truncated: true,
      }),
    });

    const snapshot = await prepare(ticketHistory);

    expect(snapshot.sources[0]).toEqual({ source: 'jira', problem: 'the Jira read failed' });
    expect(snapshot.gaps.join('\n')).toMatch(/Jira discussion could not be read/);
    expect(snapshot.gaps.join('\n')).toMatch(/more entries than the harness read/);
  });

  it('stops the turn when the refreshed requirements name another ticket', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir, {
      currentTask: async (ref) => ({ ref: { ...ref, id: '10012', key: 'HARN-12' }, task: TASK }),
    });

    await expect(prepare(ticketHistory)).rejects.toThrow(HistoryError);
    await expect(prepare(ticketHistory)).rejects.toThrow(/different ticket identity/);
  });

  it('advances only the consuming role’s feedback cursor', async () => {
    const workDir = await createTempDir();
    let comments: readonly ReadComment[] = [jiraComment()];
    const ticketHistory = history(workDir, {
      jira: async () => ({ comments, truncated: false }),
    });

    const first = await prepare(ticketHistory, 'developer');
    expect(first.brief.newHumanFeedback.map((entry) => entry.sourceId)).toEqual(['comment-1']);
    await ticketHistory.consumed?.(first);

    comments = [
      jiraComment(),
      jiraComment({
        sourceId: 'comment-2',
        text: 'a newer comment',
        createdAt: '2026-09-16T11:00:00.000Z',
      }),
    ];
    const second = await prepare(ticketHistory, 'developer');
    expect(second.brief.newHumanFeedback.map((entry) => entry.sourceId)).toEqual(['comment-2']);

    // The reviewer has consumed nothing yet, so it sees the whole thread.
    const reviewer = await prepare(ticketHistory, 'reviewer');
    expect(reviewer.brief.newHumanFeedback.map((entry) => entry.sourceId)).toEqual([
      'comment-1',
      'comment-2',
    ]);
    // Preparing a snapshot consumes nothing for anyone: the developer's last
    // acknowledged input is still the first snapshot, so comment-2 stays new
    // until a developer turn consumes a snapshot that holds it.
    const again = await prepare(ticketHistory, 'developer');
    expect(again.brief.newHumanFeedback.map((entry) => entry.sourceId)).toEqual(['comment-2']);
    await ticketHistory.consumed?.(again);
    const settled = await prepare(ticketHistory, 'developer');
    expect(settled.brief.newHumanFeedback).toEqual([]);
    // What was said while that turn held its snapshot is still new to it.
    comments = [
      ...comments,
      jiraComment({
        sourceId: 'comment-3',
        text: 'said after the turn',
        createdAt: '2026-09-16T11:30:00.000Z',
      }),
    ];
    const next = await prepare(ticketHistory, 'developer');
    expect(next.brief.newHumanFeedback.map((entry) => entry.sourceId)).toEqual(['comment-3']);
  });

  it('recognizes a published rendering of a complete report as a mirror, never a second entry', async () => {
    const workDir = await createTempDir();
    const text = 'HARN-11: the run passed. nexus-history: developer run-1';
    await history(workDir).recordDeveloperReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      round: 1,
      runId: 'run-1',
      reportPath: '/work/runs/run-1/result.json',
      status: 'passed',
      reason: 'every configured check passed',
      repairsUsed: 0,
      attempts: [{ turn: 1, kind: 'implementation', agentSummary: 'done', checks: 'passed' }],
      pullRequest: {
        number: 7,
        url: 'https://github.com/owner/name/pull/7',
        title: 'HARN-11',
        branch: 'harness/HARN-11',
        baseBranch: 'main',
        head: HEAD,
        observedAt: null,
        round: 1,
        entryId: null,
      },
      deliveryFailure: null,
      now: new Date('2026-09-16T11:00:00.000Z'),
    });
    await history(workDir).notePublishedDeveloperReport?.({
      workspaceId: 'HARN-11',
      runId: 'run-1',
      commentId: 'comment-9',
      url: null,
      text,
    });

    const ticketHistory = history(workDir, {
      // The harness's own rendering comes back on the next read, by the id the
      // publication was acknowledged as.
      jira: async () => ({
        comments: [jiraComment({ sourceId: 'comment-9', author: 'Nexus harness', text })],
        truncated: false,
      }),
      pull: async () => pullConversation([]),
    });

    const mirrored = await prepare(ticketHistory);
    expect(mirrored.mirrors.map((mirror) => mirror.sourceId)).toEqual(['comment-9']);
    expect(mirrored.entries.map((entry) => entry.id)).toEqual(['harness:developer-report:run-1']);
    expect(mirrored.reports[0]?.entryId).toBe('harness:developer-report:run-1');

    // A rendering edited after publication is a distinct message again.
    const edited = history(workDir, {
      jira: async () => ({
        comments: [
          jiraComment({
            sourceId: 'comment-9',
            author: 'Nexus harness',
            text: `${text} and an edit`,
          }),
        ],
        truncated: false,
      }),
      pull: async () => pullConversation([]),
    });
    const afterEdit = await prepare(edited, 'reviewer');
    expect(afterEdit.mirrors).toEqual([]);
    expect(afterEdit.entries.map((entry) => entry.id)).toContain('jira:jira-comment:comment-9');
  });

  it('tracks the outstanding review round and what clears it', async () => {
    const workDir = await createTempDir();
    const review = (overrides: Partial<ReadComment>): ReadComment => ({
      sourceId: '77',
      author: 'a human reviewer',
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: null,
      text: 'please change the greeting',
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-77',
      state: 'CHANGES_REQUESTED',
      commit: HEAD,
      ...overrides,
    });
    let comments: readonly ReadComment[] = [review({})];

    const ticketHistory = history(workDir, {
      pull: async () => pullConversation(comments),
    });

    const asked = await prepare(ticketHistory);
    expect(asked.brief.unresolved?.decision).toBe('request_changes');
    expect(asked.brief.unresolved?.head).toBe(HEAD);
    expect(asked.brief.unresolvedReviews).toHaveLength(1);

    // A comment-only round decides nothing.
    comments = [review({}), review({ sourceId: '78', state: 'COMMENTED', text: 'a note' })];
    const commented = await prepare(ticketHistory, 'reviewer');
    expect(commented.brief.unresolved?.sourceId).toBe('77');

    // Another author's approval does not clear the request.
    comments = [review({}), review({ sourceId: '79', author: 'someone else', state: 'APPROVED' })];
    const otherAuthor = await prepare(ticketHistory);
    expect(otherAuthor.brief.unresolved?.sourceId).toBe('77');

    // Nor does an approval of an older head.
    comments = [review({}), review({ sourceId: '80', state: 'APPROVED', commit: 'c'.repeat(40) })];
    const oldHead = await prepare(ticketHistory);
    expect(oldHead.brief.unresolved?.sourceId).toBe('77');

    // The same reviewer's approval at the current head clears it.
    comments = [review({}), review({ sourceId: '81', state: 'APPROVED', commit: HEAD })];
    const approved = await prepare(ticketHistory);
    expect(approved.brief.unresolved).toBeNull();
    expect(approved.brief.unresolvedReviews).toEqual([]);
  });

  it('keeps every outstanding finding’s identity, answer and verification across refreshes', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-2',
      round: 2,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the repair did not hold',
      findings: [
        { path: 'src/greeting.ts', line: 2, body: 'the argument is still ignored' },
        { path: 'src/salutation.ts', line: null, body: 'the same helper is copied here' },
      ],
      // What this round verified of an earlier disposition: an unverified
      // claim is a fact of its own, not a reason to read the finding as closed.
      verifications: [
        { finding: 'R1-F1', state: 'unverified', evidence: 'the helper still ignores it' },
      ],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    await ticketHistory.recordDeveloperReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      round: 4,
      runId: 'run-4',
      reportPath: '/work/runs/run-4/result.json',
      status: 'in-progress',
      reason: 'Coding turn reports retained.',
      repairsUsed: 0,
      attempts: [
        {
          turn: 1,
          kind: 'repair',
          agentSummary: [
            'I repaired the greeting.',
            '',
            '### Finding R2-F1',
            '- Cause: the helper ignored the argument it was given.',
            '- Affected scope: src/greeting.ts and src/salutation.ts share the helper.',
            '- Repair: the helper now returns the greeting it was given.',
            '- Verification: exercised greet("hi") through the exported function.',
            '- Remaining uncertainty: none.',
          ].join('\n'),
          checks: 'passed',
        },
      ],
      pullRequest: null,
      deliveryFailure: null,
      now: new Date('2026-09-16T11:00:00.000Z'),
    });

    const snapshot = await prepare(ticketHistory, 'reviewer', 3);
    const round = snapshot.brief.unresolvedReviews?.[0];
    // The identity is the round's own, and it is what an answer names.
    expect(round?.findings.map((finding) => finding.id)).toEqual(['R2-F1', 'R2-F2']);
    expect(round?.verifications).toEqual([
      { finding: 'R1-F1', state: 'unverified', evidence: 'the helper still ignores it' },
    ]);
    const responses = round?.responses ?? [];
    expect(responses.map((response) => [response.finding, response.complete])).toEqual([
      ['R2-F1', true],
      ['R2-F2', false],
    ]);
    expect(responses[0]?.entryId).toBe('harness:developer-report:run-4');
    expect(responses[0]?.repair).toBe('the helper now returns the greeting it was given.');
    expect(responses[1]?.problem).toMatch(/no answer to this finding is recorded/);

    const prompt = renderHistorySection(snapshot, 'reviewer');
    expect(prompt).toContain('R2-F1');
    expect(prompt).toContain('R2-F2');
    expect(prompt).toContain('the helper now returns the greeting it was given.');
    expect(prompt).toContain('Developer response (a claim, not a verification');
    // The finding with no answer says exactly that, and the verification this
    // round recorded is rendered as verification rather than as a claim.
    expect(prompt).toMatch(/[Nn]othing here is complete remediation/);
    expect(prompt).toContain('R1-F1 — unverified: the helper still ignores it');

    // A restart reads the same exchange back from the retained reports.
    const restarted = await prepare(history(workDir), 'reviewer', 4);
    expect(restarted.brief.unresolvedReviews?.[0]?.responses?.[0]?.repair).toBe(
      'the helper now returns the greeting it was given.',
    );
    expect(restarted.brief.unresolvedReviews?.[0]?.findings.map((finding) => finding.id)).toEqual([
      'R2-F1',
      'R2-F2',
    ]);
  });

  it('carries an unverified disposition forward until a later review verifies it', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    /** One developer report whose repair turn answers `findings` in its summary. */
    const developerReport = async (parts: {
      readonly runId: string;
      readonly round: number;
      readonly at: string;
      readonly answers: readonly string[];
    }): Promise<void> => {
      await ticketHistory.recordDeveloperReport?.({
        ref: REF,
        workspaceId: 'HARN-11',
        task: TASK,
        round: parts.round,
        runId: parts.runId,
        reportPath: `/work/runs/${parts.runId}/result.json`,
        status: 'in-progress',
        reason: 'Coding turn reports retained.',
        repairsUsed: 0,
        attempts: [
          {
            turn: 1,
            kind: 'repair',
            agentSummary: ['I repaired the greeting.', '', ...parts.answers].join('\n'),
            checks: 'passed',
          },
        ],
        pullRequest: null,
        deliveryFailure: null,
        now: new Date(parts.at),
      });
    };
    /** One answer section for one identity, complete in every field. */
    const answer = (finding: string, repair: string): readonly string[] => [
      `### Finding ${finding}`,
      `- Cause: the shared helper ignored the argument it was given.`,
      '- Affected scope: src/greeting.ts and src/salutation.ts share the helper.',
      `- Repair: ${repair}`,
      '- Verification: exercised it through the exported function.',
      '- Remaining uncertainty: none.',
    ];

    // Round 1 raises one defect, and the next attempt answers it.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    expect(
      (await prepare(ticketHistory, 'reviewer', 2)).brief.unresolvedReviews?.map((round) =>
        round.findings.map((finding) => finding.id),
      ),
    ).toEqual([['R1-F1']]);
    await developerReport({
      runId: 'run-2',
      round: 2,
      at: '2026-09-16T10:30:00.000Z',
      answers: answer('R1-F1', 'the helper now returns the greeting it was given.'),
    });

    // Round 2 raises an independent defect and records its own reading of
    // R1-F1 as unverified: the new change request must not clear it.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-2',
      round: 2,
      head: HEAD,
      decision: 'request_changes',
      summary: 'one repair did not hold and another defect is new',
      findings: [{ path: 'src/salutation.ts', line: 3, body: 'the salutation is wrong' }],
      verifications: [
        { finding: 'R1-F1', state: 'unverified', evidence: 'the helper still ignores it' },
      ],
      now: new Date('2026-09-16T10:40:00.000Z'),
    });

    const carried = await prepare(ticketHistory, 'reviewer', 3);
    expect(
      carried.brief.unresolvedReviews?.map((round) => round.findings.map((one) => one.id)),
    ).toEqual([['R1-F1'], ['R2-F1']]);
    expect(outstandingFindingIds(unresolvedRounds(carried.brief))).toEqual(['R1-F1', 'R2-F1']);
    // The carried finding is rendered under the round that raised it, with the
    // answer the developer recorded afterwards.
    expect(carried.brief.unresolvedReviews?.[0]?.responses?.[0]).toMatchObject({
      finding: 'R1-F1',
      complete: true,
      repair: 'the helper now returns the greeting it was given.',
    });
    // The newer finding has no answer recorded after its own review yet, and
    // the prompt says exactly that instead of leaving the gap implicit.
    expect(carried.brief.unresolvedReviews?.[1]?.responses).toBeUndefined();
    const prompt = renderHistorySection(carried, 'reviewer');
    expect(prompt).toContain('R1-F1 — unverified: the helper still ignores it');
    expect(prompt).toContain('R2-F1 has no answer the harness can read as a complete response');

    // An approval that verifies only the newer identity leaves the carried
    // disposition unverified, so the next reviewer's verdict is refused.
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'approve',
          summary: 'the newer repair holds',
          findings: [],
          verifications: [
            { finding: 'R2-F1', state: 'verified', evidence: 'read src/salutation.ts:3' },
          ],
        }),
        'verdict.json',
        outstandingFindingIds(unresolvedRounds(carried.brief)),
      ),
    ).toThrow(/does not verify R1-F1/);

    // The next attempt answers both, and a review that verifies both
    // dispositions approves at the current head, which clears the request.
    await developerReport({
      runId: 'run-3',
      round: 3,
      at: '2026-09-16T11:00:00.000Z',
      answers: [
        ...answer('R1-F1', 'the helper now returns the greeting it was given.'),
        ...answer('R2-F1', 'the salutation now reads the greeting it is given.'),
      ],
    });
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-3',
      round: 3,
      head: HEAD,
      decision: 'approve',
      summary: 'both repairs hold and the change does what the ticket asks',
      findings: [],
      verifications: [
        { finding: 'R1-F1', state: 'verified', evidence: 'read src/greeting.ts:2' },
        { finding: 'R2-F1', state: 'verified', evidence: 'read src/salutation.ts:3' },
      ],
      now: new Date('2026-09-16T11:10:00.000Z'),
    });
    // The approval was published as a native review; only an approval that
    // really reached the pull request is evidence that the request was cleared.
    await notePublishedReview(workspaceHistoryRoot(workDir, 'HARN-11'), 'review-3', {
      id: 81,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-81',
      body: 'Nexus Lens review — HARN-11: both repairs hold',
    });

    const settled = await prepare(history(workDir), 'reviewer', 4);
    expect(settled.brief.unresolved).toBeNull();
    expect(settled.brief.unresolvedReviews).toEqual([]);
  });

  it('keeps a disposition a stale approval could not settle, and still requires it', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    const root = workspaceHistoryRoot(workDir, 'HARN-11');
    // The reviewed head, the head the approving review was made on, and the
    // head the pull request carries now: an approval of an older revision is
    // not an approval of this one.
    const approvedHead = 'c'.repeat(40);
    const currentHead = 'd'.repeat(40);
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-2',
      round: 2,
      head: approvedHead,
      decision: 'approve',
      summary: 'the repair holds at this revision',
      findings: [],
      verifications: [{ finding: 'R1-F1', state: 'verified', evidence: 'read src/greeting.ts:2' }],
      now: new Date('2026-09-16T10:30:00.000Z'),
    });
    // The approval really was published — at the head it was made on. A later
    // revision is a new head, and the disposition is not settled for it.
    await notePublishedReview(root, 'review-2', {
      id: 82,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-82',
      body: 'Nexus Lens review — HARN-11: the repair holds at this revision',
    });

    const snapshot = await prepare(
      history(workDir, {
        pull: async () => ({
          pullRequest: {
            number: 7,
            url: 'https://github.com/owner/name/pull/7',
            title: 'HARN-11: add a greeting function',
            headBranch: 'harness/HARN-11',
            baseBranch: 'main',
            headSha: currentHead,
            observedAt: '2026-09-16T11:00:00.000Z',
          },
          comments: [],
          truncated: false,
        }),
      }),
      'reviewer',
      3,
    );

    // The request survives, with the identity it still holds, and the next
    // verdict has to verify that disposition rather than read the request as
    // an empty one.
    expect(
      unresolvedRounds(snapshot.brief).map((one) => one.findings.map((finding) => finding.id)),
    ).toEqual([['R1-F1']]);
    const outstanding = outstandingFindingIds(unresolvedRounds(snapshot.brief));
    expect(outstanding).toEqual(['R1-F1']);
    expect(() =>
      parseVerdict(
        JSON.stringify({ verdict: 'approve', summary: 'the repair holds', findings: [] }),
        'verdict.json',
        outstanding,
        retainedFindingIds(snapshot),
      ),
    ).toThrow(/does not verify R1-F1/);
  });

  it('settles nothing from a review GitHub has dismissed', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    const root = workspaceHistoryRoot(workDir, 'HARN-11');
    const approvedHead = 'c'.repeat(40);
    const currentHead = 'd'.repeat(40);
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    await notePublishedReview(root, 'review-1', {
      id: 71,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-71',
      body: 'Nexus Lens review — HARN-11: the greeting ignores the argument',
    });
    // Round 2 approved at a revision and verified R1-F1 there, and GitHub
    // published that approval; it then dismissed it, as it does with an
    // approval that a later push made stale.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-2',
      round: 2,
      head: approvedHead,
      decision: 'approve',
      summary: 'the repair holds at this revision',
      findings: [],
      verifications: [{ finding: 'R1-F1', state: 'verified', evidence: 'read src/greeting.ts:2' }],
      now: new Date('2026-09-16T10:30:00.000Z'),
    });
    await notePublishedReview(root, 'review-2', {
      id: 82,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-82',
      body: 'Nexus Lens review — HARN-11: the repair holds at this revision',
    });

    // The dismissed approval decides nothing, whatever head the pull request
    // now carries: while a later revision has moved the head — the case the
    // dismissal is meant to notice — and while it still sits at the head the
    // approval was made on. R1-F1 is still outstanding either way, and the
    // next verdict has to state a reading of it rather than approve an empty
    // request.
    for (const head of [currentHead, approvedHead]) {
      const snapshot = await prepare(
        history(workDir, {
          pull: async () => ({
            pullRequest: {
              number: 7,
              url: 'https://github.com/owner/name/pull/7',
              title: 'HARN-11: add a greeting function',
              headBranch: 'harness/HARN-11',
              baseBranch: 'main',
              headSha: head,
              observedAt: '2026-09-16T11:00:00.000Z',
            },
            comments: [
              {
                sourceId: '82',
                author: 'nexus-lens[bot]',
                createdAt: '2026-09-16T10:30:00.000Z',
                updatedAt: null,
                text: 'Nexus Lens review — HARN-11: the repair holds at this revision',
                url: 'https://github.com/owner/name/pull/7#pullrequestreview-82',
                state: 'DISMISSED',
                commit: approvedHead,
              },
            ],
            truncated: false,
          }),
        }),
        'reviewer',
        3,
      );
      expect(
        unresolvedRounds(snapshot.brief).map((one) => one.findings.map((finding) => finding.id)),
      ).toEqual([['R1-F1']]);
      const outstanding = outstandingFindingIds(unresolvedRounds(snapshot.brief));
      expect(outstanding).toEqual(['R1-F1']);
      expect(() =>
        parseVerdict(
          JSON.stringify({ verdict: 'approve', summary: 'the repair holds', findings: [] }),
          'verdict.json',
          outstanding,
          retainedFindingIds(snapshot),
        ),
      ).toThrow(/does not verify R1-F1/);
    }
  });

  it('keeps a dismissed change request’s findings and settles none of its readings', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    const root = workspaceHistoryRoot(workDir, 'HARN-11');
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    await notePublishedReview(root, 'review-1', {
      id: 71,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-71',
      body: 'Nexus Lens review — HARN-11: the greeting ignores the argument',
    });
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-2',
      round: 2,
      head: HEAD,
      decision: 'request_changes',
      summary: 'one repair is verified and another defect is new',
      findings: [{ path: 'src/salutation.ts', line: 3, body: 'the salutation is wrong' }],
      verifications: [{ finding: 'R1-F1', state: 'verified', evidence: 'read src/greeting.ts:2' }],
      now: new Date('2026-09-16T10:40:00.000Z'),
    });
    await notePublishedReview(root, 'review-2', {
      id: 82,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-82',
      body: 'Nexus Lens review — HARN-11: one repair is verified and another defect is new',
    });

    const snapshot = await prepare(
      history(workDir, {
        pull: async () =>
          pullConversation([
            {
              sourceId: '82',
              author: 'nexus-lens[bot]',
              createdAt: '2026-09-16T10:40:00.000Z',
              updatedAt: null,
              text: 'Nexus Lens review — HARN-11: one repair is verified and another defect is new',
              url: 'https://github.com/owner/name/pull/7#pullrequestreview-82',
              state: 'DISMISSED',
              commit: HEAD,
            },
          ]),
      }),
      'reviewer',
      3,
    );

    // Dismissal withdraws GitHub's blocking state, not the defects the review
    // recorded: both identities still stand, and neither reading its report
    // stated settled anything.
    const rounds = unresolvedRounds(snapshot.brief);
    expect(rounds.map((one) => one.findings.map((finding) => finding.id))).toEqual([
      ['R1-F1'],
      ['R2-F1'],
    ]);
    const outstanding = outstandingFindingIds(rounds);
    expect(outstanding).toEqual(['R1-F1', 'R2-F1']);
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'approve',
          summary: 'both defects are gone',
          findings: [],
          verifications: [
            { finding: 'R1-F1', state: 'verified', evidence: 'read src/greeting.ts:2' },
          ],
        }),
        'verdict.json',
        outstanding,
        retainedFindingIds(snapshot),
      ),
    ).toThrow(/does not verify R2-F1/);
  });

  it('matches a retained report to the native review its record published without a note', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-2',
      round: 2,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the repair did not hold',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is still ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    // The review record — written when GitHub acknowledged the review — names
    // the native review this attempt published. The enrichment that would have
    // noted the same id on the report digest never arrived.
    const reviewDir = path.join(workDir, 'reviews', 'review-2');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, 'review.json'),
      JSON.stringify({
        version: 1,
        reviewId: 'review-2',
        ref: REF,
        startedAt: '2026-09-16T09:50:00.000Z',
        endedAt: '2026-09-16T10:00:00.000Z',
        disposition: 'reviewed',
        verdict: 'request_changes',
        problem: null,
        pullRequest: { headSha: HEAD, headBranch: 'harness/HARN-11' },
        review: {
          id: 72,
          url: 'https://github.com/owner/name/pull/7#pullrequestreview-72',
          state: 'CHANGES_REQUESTED',
        },
      }),
      'utf8',
    );

    const snapshot = await prepare(
      history(workDir, {
        // The published review and its inline finding come back on the next
        // read, exactly as GitHub reports the review the harness published.
        pull: async () =>
          pullConversation([
            {
              sourceId: '72',
              author: 'nexus-lens[bot]',
              createdAt: '2026-09-16T10:00:00.000Z',
              updatedAt: null,
              text: 'Nexus Lens review — HARN-11: the repair did not hold\n\nnexus-history: reviewer review-2',
              url: 'https://github.com/owner/name/pull/7#pullrequestreview-72',
              state: 'CHANGES_REQUESTED',
              commit: HEAD,
            },
            {
              sourceId: '9001',
              author: 'nexus-lens[bot]',
              createdAt: '2026-09-16T10:00:00.000Z',
              updatedAt: null,
              text: 'src/greeting.ts:2 — the argument is still ignored',
              url: 'https://github.com/owner/name/pull/7#discussion_r9001',
              path: 'src/greeting.ts',
              line: 2,
              body: 'the argument is still ignored',
              reviewId: 72,
              commit: HEAD,
            },
          ]),
      }),
      'reviewer',
      3,
    );

    // One defect keeps one identity: the retained report and the native review
    // it published are the same round, read at the native review's own state.
    const rounds = unresolvedRounds(snapshot.brief);
    expect(rounds.map((one) => one.findings.map((finding) => finding.id))).toEqual([['R2-F1']]);
    expect(rounds[0]?.nativeReviewId).toBe(72);
    expect(rounds[0]?.head).toBe(HEAD);
    expect(rounds[0]?.decision).toBe('request_changes');
    expect(snapshot.gaps.filter((gap) => gap.includes('no complete local report'))).toEqual([]);
  });

  it('reads a recovered verdict’s verification identities as the history names them', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    // Round 1 raises one finding and its native review was published.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    /** One review attempt's own record, as the scan writes it with its verdict. */
    const reviewRecord = async (
      reviewId: string,
      nativeId: number,
      at: string,
    ): Promise<string> => {
      const dir = path.join(workDir, 'reviews', reviewId);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'review.json'),
        JSON.stringify({
          version: 1,
          reviewId,
          ref: REF,
          startedAt: at,
          endedAt: at,
          disposition: 'reviewed',
          verdict: 'request_changes',
          problem: null,
          pullRequest: { headSha: HEAD, headBranch: 'harness/HARN-11' },
          review: {
            id: nativeId,
            url: `https://github.com/owner/name/pull/7#pullrequestreview-${String(nativeId)}`,
            state: 'CHANGES_REQUESTED',
          },
        }),
        'utf8',
      );
      return dir;
    };
    await reviewRecord('review-1', 71, '2026-09-16T09:50:00.000Z');
    // Round 2's complete report digest is gone — only the review record and the
    // reviewer's own retained verdict remain — and the reviewer wrote the
    // identity it verified in lower case, as the scan accepts.
    const reviewDir = await reviewRecord('review-2', 72, '2026-09-16T10:50:00.000Z');
    await writeFile(
      path.join(reviewDir, 'verdict.json'),
      JSON.stringify({
        version: 1,
        reviewId: 'review-2',
        ref: REF,
        workspaceId: 'HARN-11',
        task: { id: 'HARN-11', title: 'HARN-11' },
        head: HEAD,
        verdict: 'request_changes',
        summary: 'the repair did not hold and the salutation is wrong too',
        findings: [{ path: 'src/salutation.ts', line: 3, body: 'the salutation is wrong' }],
        verifications: [
          { finding: 'r1-f1', state: 'verified', evidence: 'read src/greeting.ts:2' },
        ],
        recordedAt: '2026-09-16T11:00:00.000Z',
      }),
      'utf8',
    );

    const recovered = await prepare(history(workDir), 'reviewer', 3);
    const rounds = unresolvedRounds(recovered.brief);
    // The published verification settled R1-F1 whatever case it was written
    // in; only the round-2 finding is still outstanding.
    expect(
      rounds.map((round) => [round.sourceId, round.findings.map((finding) => finding.id)]),
    ).toEqual([['review-2', ['R2-F1']]]);
    expect(rounds[0]?.verifications).toEqual([
      { finding: 'R1-F1', state: 'verified', evidence: 'read src/greeting.ts:2' },
    ]);
    expect(outstandingFindingIds(rounds)).toEqual(['R2-F1']);
    // The next verdict is held to the identities that still stand, which are
    // the same ones the recovered round states.
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'approve',
          summary: 'the salutation is fixed',
          findings: [],
          verifications: [
            { finding: 'r2-f1', state: 'verified', evidence: 'read src/salutation.ts:3' },
          ],
        }),
        'verdict.json',
        outstandingFindingIds(rounds),
        retainedFindingIds(recovered),
      ),
    ).not.toThrow();
  });

  it('does not let a request refused publication settle what it verified', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    const root = workspaceHistoryRoot(workDir, 'HARN-11');
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    await notePublishedReview(root, 'review-1', {
      id: 71,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-71',
      body: 'Nexus Lens review — HARN-11: the greeting ignores the argument',
    });
    // Recorded after the turn and retained before the publication guards, but
    // refused publication: no native review carries this verdict, so nothing
    // it read is settled and its own finding still stands beside the earlier
    // request.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-2',
      round: 2,
      head: HEAD,
      decision: 'request_changes',
      summary: 'one repair is verified and another defect is new',
      findings: [{ path: 'src/salutation.ts', line: 3, body: 'the salutation is wrong' }],
      verifications: [{ finding: 'R1-F1', state: 'verified', evidence: 'read src/greeting.ts:2' }],
      now: new Date('2026-09-16T10:40:00.000Z'),
    });

    const snapshot = await prepare(history(workDir), 'reviewer', 3);
    const rounds = unresolvedRounds(snapshot.brief);
    expect(rounds.map((round) => round.findings.map((finding) => finding.id))).toEqual([
      ['R1-F1'],
      ['R2-F1'],
    ]);
    // The reading is kept as what it was, and the identity it read is the next
    // verdict's to verify.
    expect(rounds[1]?.verifications).toEqual([
      { finding: 'R1-F1', state: 'verified', evidence: 'read src/greeting.ts:2' },
    ]);
    const outstanding = outstandingFindingIds(rounds);
    expect(outstanding).toEqual(['R1-F1', 'R2-F1']);
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'approve',
          summary: 'both defects are gone',
          findings: [],
          verifications: [
            { finding: 'R2-F1', state: 'verified', evidence: 'read src/salutation.ts:3' },
          ],
        }),
        'verdict.json',
        outstanding,
        retainedFindingIds(snapshot),
      ),
    ).toThrow(/does not verify R1-F1/);
  });

  it('keeps a repair regression under the identity an earlier review settled', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    const root = workspaceHistoryRoot(workDir, 'HARN-11');
    const repairedHead = 'c'.repeat(40);
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    await notePublishedReview(root, 'review-1', {
      id: 71,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-71',
      body: 'Nexus Lens review — HARN-11: the greeting ignores the argument',
    });
    // Round 2 verified R1-F1 at the repaired revision and requested changes for
    // an independent defect: reconciliation settles R1-F1, so it is no longer
    // one of the outstanding identities.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-2',
      round: 2,
      head: repairedHead,
      decision: 'request_changes',
      summary: 'one repair holds and another defect is new',
      findings: [{ path: 'src/salutation.ts', line: 3, body: 'the salutation is wrong' }],
      verifications: [{ finding: 'R1-F1', state: 'verified', evidence: 'read src/greeting.ts:2' }],
      now: new Date('2026-09-16T10:40:00.000Z'),
    });
    await notePublishedReview(root, 'review-2', {
      id: 72,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-72',
      body: 'Nexus Lens review — HARN-11: one repair holds and another defect is new',
    });

    const snapshot = await prepare(history(workDir), 'reviewer', 3);
    const outstanding = outstandingFindingIds(unresolvedRounds(snapshot.brief));
    expect(outstanding).toEqual(['R2-F1']);
    // The verified identity is not outstanding any more, but it is retained,
    // and that is what the repair regression of the third revision names.
    const retained = retainedFindingIds(snapshot);
    expect(retained).toEqual(['R1-F1', 'R2-F1']);
    const regression = parseVerdict(
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'repairing the salutation reintroduced the greeting defect',
        findings: [
          {
            path: 'src/greeting.ts',
            line: 2,
            body: 'the argument is ignored again',
            kind: 'regression',
            continues: 'R1-F1',
          },
        ],
        verifications: [
          { finding: 'R2-F1', state: 'verified', evidence: 'read src/salutation.ts:3' },
        ],
      }),
      'verdict.json',
      outstanding,
      retained,
    );
    expect(regression.findings).toEqual([
      {
        path: 'src/greeting.ts',
        line: 2,
        body: 'the argument is ignored again',
        kind: 'regression',
        continues: 'R1-F1',
      },
    ]);

    // Recording that verdict brings the identity back under the round that
    // raised it again, so the next verdict must verify it.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-3',
      round: 3,
      head: repairedHead,
      decision: regression.decision,
      summary: regression.summary,
      findings: regression.findings,
      ...(regression.verifications === undefined
        ? {}
        : { verifications: regression.verifications }),
      now: new Date('2026-09-16T11:00:00.000Z'),
    });
    await notePublishedReview(root, 'review-3', {
      id: 73,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-73',
      body: 'Nexus Lens review — HARN-11: repairing the salutation reintroduced the greeting defect',
    });
    const after = await prepare(history(workDir), 'reviewer', 4);
    const [round] = unresolvedRounds(after.brief);
    expect(round?.findings.map((finding) => [finding.id, finding.recordedAs])).toEqual([
      ['R1-F1', 'R3-F1'],
    ]);
    expect(round?.findings.map((finding) => finding.continues)).toEqual(['R1-F1']);
    expect(outstandingFindingIds(unresolvedRounds(after.brief))).toEqual(['R1-F1']);
  });

  it('keeps a settled native review’s identity nameable for a later regression', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    const root = workspaceHistoryRoot(workDir, 'HARN-11');
    /** One native review, as the pull request conversation reports it. */
    const nativeReview = (overrides: Partial<ReadComment>): ReadComment => ({
      sourceId: '91',
      author: 'a human reviewer',
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: null,
      text: 'the argument is ignored',
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-91',
      state: 'CHANGES_REQUESTED',
      commit: HEAD,
      ...overrides,
    });
    // An independent defect is still outstanding from a harness review round,
    // so the settled native identity is not one of the required readings.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-3',
      round: 3,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the salutation is wrong',
      findings: [{ path: 'src/salutation.ts', line: 3, body: 'the salutation is wrong' }],
      now: new Date('2026-09-16T11:00:00.000Z'),
    });
    await notePublishedReview(root, 'review-3', {
      id: 73,
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-73',
      body: 'Nexus Lens review — HARN-11: the salutation is wrong',
    });

    const snapshot = await prepare(
      history(workDir, {
        // The native reviewer's finding, and then that same reviewer's approval
        // at the current head: reconciliation settles the identity the finding
        // was raised with, and no local report ever held it.
        pull: async () =>
          pullConversation([
            nativeReview({}),
            {
              sourceId: '9001',
              author: 'a human reviewer',
              createdAt: '2026-09-16T10:00:00.000Z',
              updatedAt: null,
              text: 'src/greeting.ts:2 — the argument is ignored',
              url: 'https://github.com/owner/name/pull/7#discussion_r9001',
              path: 'src/greeting.ts',
              line: 2,
              body: 'the argument is ignored',
              reviewId: 91,
              commit: HEAD,
            },
            nativeReview({
              sourceId: '92',
              state: 'APPROVED',
              createdAt: '2026-09-16T10:30:00.000Z',
              text: 'the repair holds',
            }),
          ]),
      }),
      'reviewer',
      4,
    );

    const rounds = unresolvedRounds(snapshot.brief);
    const outstanding = outstandingFindingIds(rounds);
    expect(outstanding).toEqual(['R3-F1']);
    // The identity the settled native review raised is retained — the review and
    // its inline comment stay in the shared entries, named by the comment's own
    // source identity rather than its position — so a later revision that
    // brings the defect back names the same finding instead of a new one.
    const retained = retainedFindingIds(snapshot);
    expect(retained).toEqual(['R3-F1', 'N91-C9001']);
    const regression = parseVerdict(
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'repairing the salutation reintroduced the greeting defect',
        findings: [
          {
            path: 'src/greeting.ts',
            line: 2,
            body: 'the argument is ignored again',
            kind: 'regression',
            continues: 'N91-C9001',
          },
        ],
        verifications: [
          { finding: 'R3-F1', state: 'verified', evidence: 'read src/salutation.ts:3' },
        ],
      }),
      'verdict.json',
      outstanding,
      retained,
    );
    expect(regression.findings).toEqual([
      {
        path: 'src/greeting.ts',
        line: 2,
        body: 'the argument is ignored again',
        kind: 'regression',
        continues: 'N91-C9001',
      },
    ]);
  });

  it('keeps a native review’s finding identity when an earlier sibling comment is deleted', async () => {
    const workDir = await createTempDir();
    /** One native review of this pull request, as GitHub reports it. */
    const nativeReview = (): ReadComment => ({
      sourceId: '91',
      author: 'a human reviewer',
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: null,
      text: 'two places ignore the argument they are given',
      url: 'https://github.com/owner/name/pull/7#pullrequestreview-91',
      state: 'CHANGES_REQUESTED',
      commit: HEAD,
    });
    /** One inline comment of that review, at the line it names. */
    const inline = (sourceId: string, path: string, body: string): ReadComment => ({
      sourceId,
      author: 'a human reviewer',
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: null,
      text: `${path}:2 — ${body}`,
      url: `https://github.com/owner/name/pull/7#discussion_r${sourceId}`,
      path,
      line: 2,
      body,
      reviewId: 91,
      commit: HEAD,
    });
    // The review states two findings; the harness kept no complete report for
    // it, so both are reconstructed from the review and its inline comments.
    let comments: readonly ReadComment[] = [
      nativeReview(),
      inline('9001', 'src/greeting.ts', 'the greeting ignores its argument'),
      inline('9002', 'src/salutation.ts', 'the salutation ignores it too'),
    ];
    const ticketHistory = history(workDir, { pull: async () => pullConversation(comments) });

    const both = await prepare(ticketHistory, 'reviewer', 2);
    const [raised] = unresolvedRounds(both.brief);
    // A finding is named by the review and the comment's own source identity,
    // never by the position the comment currently holds.
    expect(raised?.findings.map((finding) => finding.id)).toEqual(['N91-C9001', 'N91-C9002']);

    // The next attempt answers the second occurrence.
    await ticketHistory.recordDeveloperReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      round: 2,
      runId: 'run-2',
      reportPath: '/work/runs/run-2/result.json',
      status: 'in-progress',
      reason: 'Coding turn reports retained.',
      repairsUsed: 0,
      attempts: [
        {
          turn: 1,
          kind: 'repair',
          agentSummary: [
            'I repaired both places that share the helper.',
            '',
            '### Finding N91-C9002',
            '- Cause: the shared helper ignored the argument it was given.',
            '- Affected scope: src/salutation.ts, reached through the same helper.',
            '- Repair: the helper now returns the greeting it was given.',
            '- Verification: exercised the salutation through its exported function.',
            '- Remaining uncertainty: none.',
          ].join('\n'),
          checks: 'passed',
        },
      ],
      pullRequest: null,
      deliveryFailure: null,
      now: new Date('2026-09-16T11:00:00.000Z'),
    });

    // GitHub no longer returns the first comment. The finding that remains
    // keeps the identity it was raised with — it is not renamed into the
    // position the deleted sibling held, and the sibling's old identity does
    // not come to stand for it.
    comments = [
      nativeReview(),
      inline('9002', 'src/salutation.ts', 'the salutation ignores it too'),
    ];
    const after = await prepare(ticketHistory, 'reviewer', 3);
    const [surviving] = unresolvedRounds(after.brief);
    expect(surviving?.findings.map((finding) => finding.id)).toEqual(['N91-C9002']);
    // The answer written against that identity is still that finding's answer.
    expect(surviving?.responses?.map((response) => [response.finding, response.complete])).toEqual([
      ['N91-C9002', true],
    ]);
    expect(surviving?.responses?.[0]?.repair).toBe(
      'the helper now returns the greeting it was given.',
    );
    expect(retainedFindingIds(after)).toEqual(['N91-C9002']);

    // A verification names the identity the finding keeps, and settles it.
    const outstanding = outstandingFindingIds(unresolvedRounds(after.brief));
    expect(outstanding).toEqual(['N91-C9002']);
    const verdict = parseVerdict(
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'the greeting still ignores its argument',
        findings: [{ path: 'src/greeting.ts', line: 2, body: 'still ignored' }],
        verifications: [
          { finding: 'n91-c9002', state: 'verified', evidence: 'read src/salutation.ts:2' },
        ],
      }),
      'verdict.json',
      outstanding,
      retainedFindingIds(after),
    );
    expect(verdict.verifications).toEqual([
      { finding: 'N91-C9002', state: 'verified', evidence: 'read src/salutation.ts:2' },
    ]);
  });

  it('keeps a continued defect’s identity through recording and the next prompt', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    // The same defect is found again by the next review: it is a continuation
    // of R1-F1, not a new finding, and the review's own occurrence is recorded
    // beside the identity the defect keeps.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-2',
      round: 2,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the repair did not hold',
      findings: [
        {
          path: 'src/greeting.ts',
          line: 2,
          body: 'the argument is still ignored',
          kind: 'unresolved',
          continues: 'R1-F1',
        },
      ],
      verifications: [
        { finding: 'R1-F1', state: 'unverified', evidence: 'the helper still ignores it' },
      ],
      now: new Date('2026-09-16T10:40:00.000Z'),
    });

    const snapshot = await prepare(ticketHistory, 'reviewer', 3);
    const [round] = snapshot.brief.unresolvedReviews ?? [];
    expect(round?.findings.map((finding) => [finding.id, finding.recordedAs])).toEqual([
      ['R1-F1', 'R2-F1'],
    ]);
    expect(round?.findings.map((finding) => finding.continues)).toEqual(['R1-F1']);
    expect(outstandingFindingIds(unresolvedRounds(snapshot.brief))).toEqual(['R1-F1']);
    const prompt = renderHistorySection(snapshot, 'reviewer');
    expect(prompt).toContain(
      'This review recorded it as R2-F1; the defect keeps the identity R1-F1.',
    );
    // The complete report on disk names the same identity, so a restart reads
    // the same defect back rather than a renamed one.
    const report = await readFile(
      path.join(workspaceHistoryRoot(workDir, 'HARN-11'), 'reports', 'reviewer-review-2.md'),
      'utf8',
    );
    expect(report).toContain('### Finding R1-F1: src/greeting.ts:2');
    expect(report).toContain('- Recorded as: R2-F1');
    const restarted = await prepare(history(workDir), 'reviewer', 4);
    expect(restarted.brief.unresolvedReviews?.[0]?.findings.map((finding) => finding.id)).toEqual([
      'R1-F1',
    ]);

    // Reviewing it again does not rename it a second time: the third round's
    // occurrence is recorded beside the same identity.
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-3',
      round: 3,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the repair still did not hold',
      findings: [
        {
          path: 'src/greeting.ts',
          line: 2,
          body: 'the argument is still ignored',
          kind: 'unresolved',
          continues: 'r1-f1',
        },
      ],
      verifications: [
        { finding: 'R1-F1', state: 'unverified', evidence: 'the helper still ignores it' },
      ],
      now: new Date('2026-09-16T11:10:00.000Z'),
    });
    const reviewedAgain = await prepare(history(workDir), 'reviewer', 5);
    const again = reviewedAgain.brief.unresolvedReviews ?? [];
    expect(again.map((round) => round.findings.map((finding) => finding.id))).toEqual([['R1-F1']]);
    expect(again[0]?.findings.map((finding) => finding.recordedAs)).toEqual(['R3-F1']);
    expect(again[0]?.verifications).toEqual([
      { finding: 'R1-F1', state: 'unverified', evidence: 'the helper still ignores it' },
    ]);
  });

  it('keeps a missing or incomplete developer report from reading as a complete response', async () => {
    const workDir = await createTempDir();
    const root = workspaceHistoryRoot(workDir, 'HARN-11');
    const ticketHistory = history(workDir);
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    const answer = [
      '### Finding R1-F1',
      '- Cause: the shared helper ignored the argument it was given.',
      '- Affected scope: src/greeting.ts.',
      '- Repair: the helper now returns the greeting it was given.',
      '- Verification: exercised it through the exported function.',
      '- Remaining uncertainty: none.',
    ];
    const report = async (runId: string, at: string): Promise<void> => {
      await ticketHistory.recordDeveloperReport?.({
        ref: REF,
        workspaceId: 'HARN-11',
        task: TASK,
        round: 2,
        runId,
        reportPath: `/work/runs/${runId}/result.json`,
        status: 'in-progress',
        reason: 'Coding turn reports retained.',
        repairsUsed: 0,
        attempts: [
          {
            turn: 1,
            kind: 'repair',
            agentSummary: ['I repaired the greeting.', '', ...answer].join('\n'),
            checks: 'passed',
          },
        ],
        pullRequest: null,
        deliveryFailure: null,
        now: new Date(at),
      });
    };

    await report('run-2', '2026-09-16T10:30:00.000Z');
    const answered = await prepare(ticketHistory, 'reviewer', 2);
    expect(answered.brief.unresolvedReviews?.[0]?.responses?.[0]).toMatchObject({
      finding: 'R1-F1',
      complete: true,
    });

    // A later attempt whose own complete text is gone: the older answer is not
    // the current claim, and the attempt that is missing states no answer.
    await report('run-3', '2026-09-16T11:00:00.000Z');
    await rm(path.join(root, 'reports', 'developer-run-3.md'), { force: true });
    const unreadable = await prepare(history(workDir), 'reviewer', 3);
    const [response] = unreadable.brief.unresolvedReviews?.[0]?.responses ?? [];
    expect(response?.finding).toBe('R1-F1');
    expect(response?.complete).toBe(false);
    expect(response?.problem).toMatch(/not complete/);
    expect(response?.problem).toMatch(/could not be read/);
    expect(response?.repair).toBeNull();
    expect(unreadable.brief.unresolvedReviews?.[0]?.responses?.[0]?.entryId).toBe(
      'harness:developer-report:run-3',
    );
    const prompt = renderHistorySection(unreadable, 'reviewer');
    expect(prompt).toMatch(/[Nn]othing here is complete remediation/);

    // An attempt the ledger records whose report is missing entirely is the
    // newest developer evidence too, and states no complete response either.
    await writeWorkspaceState(workDir, {
      version: 1,
      workspaceId: 'HARN-11',
      sourceRoot: workDir,
      baseCommit: HEAD,
      branch: 'harness/HARN-11',
      createdAt: '2026-09-16T10:00:00.000Z',
      sourceItem: sourceItemFor(REF),
      attempts: [
        {
          runId: 'run-4',
          reportPath: path.join(workDir, 'runs', 'run-4', 'result.json'),
          outcome: 'passed',
          reason: 'every configured check passed',
          endedAt: '2026-09-16T11:30:00.000Z',
        },
      ],
    });
    const missing = await prepare(history(workDir), 'reviewer', 4);
    const [unavailable] = missing.brief.unresolvedReviews?.[0]?.responses ?? [];
    expect(unavailable?.finding).toBe('R1-F1');
    expect(unavailable?.complete).toBe(false);
    expect(unavailable?.problem).toMatch(/not complete/);
    expect(unavailable?.entryId).toBe('harness:developer-report:run-4');
    expect(missing.entries.find((entry) => entry.sourceId === 'run-4')?.kind).toBe(
      'missing-report',
    );
    expect(missing.gaps.join('\n')).toMatch(/complete developer report/);

    // A restart that retained an earlier summary but can no longer read the
    // final evidence marks that attempt's report incomplete as well: the
    // summary it kept does not become a complete claim again.
    await report('run-5', '2026-09-16T11:45:00.000Z');
    await writeWorkspaceState(workDir, {
      version: 1,
      workspaceId: 'HARN-11',
      sourceRoot: workDir,
      baseCommit: HEAD,
      branch: 'harness/HARN-11',
      createdAt: '2026-09-16T10:00:00.000Z',
      sourceItem: sourceItemFor(REF),
      attempts: [
        {
          runId: 'run-5',
          reportPath: path.join(workDir, 'runs', 'run-5', 'result.json'),
          outcome: 'passed',
          reason: 'every configured check passed',
          endedAt: '2026-09-16T11:45:00.000Z',
        },
      ],
    });
    const reconciled = await prepare(history(workDir), 'reviewer', 5);
    const [reconciledResponse] = reconciled.brief.unresolvedReviews?.[0]?.responses ?? [];
    expect(reconciledResponse?.finding).toBe('R1-F1');
    expect(reconciledResponse?.complete).toBe(false);
    expect(reconciledResponse?.problem).toMatch(/not complete/);
    expect(reconciledResponse?.problem).toMatch(/final evidence/);
    expect(reconciledResponse?.entryId).toBe('harness:developer-report:run-5');
  });

  it('reads a later coding turn’s own answer, never an earlier turn’s complete one', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    /** One complete answer section, as a coding turn states it. */
    const answer = (repair: string): readonly string[] => [
      '### Finding R1-F1',
      '- Cause: the shared helper ignored the argument it was given.',
      '- Affected scope: src/greeting.ts.',
      `- Repair: ${repair}`,
      '- Verification: exercised it through the exported function.',
      '- Remaining uncertainty: none.',
    ];
    /** One attempt's report, with the coding turns a case names. */
    const report = async (
      runId: string,
      at: string,
      turns: readonly { readonly summary: string; readonly checks: string }[],
    ): Promise<void> => {
      await ticketHistory.recordDeveloperReport?.({
        ref: REF,
        workspaceId: 'HARN-11',
        task: TASK,
        round: 2,
        runId,
        reportPath: `/work/runs/${runId}/result.json`,
        status: 'in-progress',
        reason: 'Coding turn reports retained.',
        repairsUsed: turns.length - 1,
        attempts: turns.map((turn, index) => ({
          turn: index + 1,
          kind: index === 0 ? 'implementation' : 'repair',
          agentSummary: turn.summary,
          checks: turn.checks,
        })),
        pullRequest: null,
        deliveryFailure: null,
        now: new Date(at),
      });
    };

    // Turn 1 answered the finding completely, its checks failed, and turn 2
    // reverted that repair without answering anything: the newest turn is what
    // the developer claims now, and it claims no resolution.
    await report('run-2', '2026-09-16T11:00:00.000Z', [
      {
        summary: ['I repaired the greeting.', '', ...answer('the helper returns it now.')].join(
          '\n',
        ),
        checks: 'failed',
      },
      {
        summary: 'I reverted that repair; the helper ignores the argument again.',
        checks: 'passed',
      },
    ]);
    const reverted = await prepare(history(workDir), 'reviewer', 2);
    const [revertedResponse] = reverted.brief.unresolvedReviews?.[0]?.responses ?? [];
    expect(revertedResponse?.finding).toBe('R1-F1');
    expect(revertedResponse?.complete).toBe(false);
    expect(revertedResponse?.problem).toMatch(/no answer to this finding is recorded/);
    // Turn 1's answer is not read as the newest turn's claim, but it stays
    // readable in the report it was recorded in.
    expect(revertedResponse?.repair).toBeNull();
    expect(
      reverted.entries.find((entry) => entry.id === 'harness:developer-report:run-2')?.text,
    ).toContain('the helper returns it now.');
    expect(renderHistorySection(reverted, 'reviewer')).toMatch(
      /[Nn]othing here is complete remediation/,
    );

    // A newest turn that answers the finding only partly states that part of
    // the answer and stays incomplete, whatever the earlier turn said.
    await report('run-3', '2026-09-16T11:30:00.000Z', [
      {
        summary: ['I repaired the greeting.', '', ...answer('the helper returns it now.')].join(
          '\n',
        ),
        checks: 'failed',
      },
      {
        summary: [
          'I reverted that repair and looked at the related path again.',
          '',
          '### Finding R1-F1',
          '- Cause: the helper was reverted to the version that ignores its argument.',
          '- Affected scope: src/greeting.ts.',
        ].join('\n'),
        checks: 'passed',
      },
    ]);
    const partial = await prepare(history(workDir), 'reviewer', 3);
    const [partialResponse] = partial.brief.unresolvedReviews?.[0]?.responses ?? [];
    expect(partialResponse?.finding).toBe('R1-F1');
    expect(partialResponse?.complete).toBe(false);
    expect(partialResponse?.cause).toBe(
      'the helper was reverted to the version that ignores its argument.',
    );
    expect(partialResponse?.problem).toContain('“Repair”');
    expect(partialResponse?.repair).toBeNull();
    expect(partialResponse?.uncertainty).toBeNull();
  });

  it('reads the newest turn of a report rebuilt from a run’s own record', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir);
    await ticketHistory.recordReviewerReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      reviewId: 'review-1',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'the greeting ignores the argument it is given',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'the argument is ignored' }],
      now: new Date('2026-09-16T10:00:00.000Z'),
    });
    // An attempt whose complete report this machine recorded before complete
    // history retention: it is read back from the run's own `result.json`, and
    // rendered from the turns that record holds.
    const reportPath = path.join(workDir, 'runs', 'run-6', 'result.json');
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({
        status: 'passed',
        reason: 'every configured check passed after repair turn 2',
        endedAt: '2026-09-16T11:00:00.000Z',
        attempts: [
          {
            turn: 1,
            kind: 'repair',
            agentSummary: [
              'I repaired the greeting.',
              '',
              '### Finding R1-F1',
              '- Cause: the shared helper ignored the argument it was given.',
              '- Affected scope: src/greeting.ts.',
              '- Repair: the helper now returns the greeting it was given.',
              '- Verification: exercised it through the exported function.',
              '- Remaining uncertainty: none.',
            ].join('\n'),
            checks: { outcome: 'failed' },
          },
          {
            turn: 2,
            kind: 'repair',
            agentSummary: 'I reverted that repair; the helper ignores the argument again.',
            checks: { outcome: 'passed' },
          },
        ],
      }),
      'utf8',
    );
    await writeWorkspaceState(workDir, {
      version: 1,
      workspaceId: 'HARN-11',
      sourceRoot: workDir,
      baseCommit: HEAD,
      branch: 'harness/HARN-11',
      createdAt: '2026-09-16T10:00:00.000Z',
      sourceItem: sourceItemFor(REF),
      attempts: [
        {
          runId: 'run-6',
          reportPath,
          outcome: 'passed',
          reason: 'every configured check passed',
          endedAt: '2026-09-16T11:00:00.000Z',
        },
      ],
    });

    const rebuilt = await prepare(history(workDir), 'reviewer', 2);
    const report = rebuilt.entries.find((entry) => entry.sourceId === 'run-6');
    expect(report?.kind).toBe('developer-report');
    // The complete rendering keeps both turns, and the answer is read from the
    // newest one alone: turn 1's complete answer is history, not a claim turn 2
    // made when it reverted the repair.
    expect(report?.text).toContain('the helper now returns the greeting it was given.');
    const [response] = rebuilt.brief.unresolvedReviews?.[0]?.responses ?? [];
    expect(response?.finding).toBe('R1-F1');
    expect(response?.complete).toBe(false);
    expect(response?.problem).toMatch(/no answer to this finding is recorded/);
    expect(response?.repair).toBeNull();
  });

  it('gives two baseline diagnoses under one project different identities', async () => {
    const workDir = await createTempDir();
    // The project namespace is the lock identity this harness derives for one
    // connected project: a 64-character hash, whatever its content, so a token
    // that keeps only its first characters cannot tell two diagnoses apart.
    const project = 'f'.repeat(64);
    const baseCommit = 'c'.repeat(40);
    /** One completed red baseline round, as the evidence record holds it. */
    const round = (check: string): CheckRoundResult => ({
      outcome: 'failed',
      setup: [],
      checks: [
        {
          command: ['npm', check],
          cwd: '/work/workspaces/HARN-11',
          outcome: 'exited',
          exitCode: 1,
          signal: null,
          startedAt: '2026-09-16T09:59:00.000Z',
          endedAt: '2026-09-16T10:00:00.000Z',
          launchError: null,
          timeoutMs: 60_000,
          termination: null,
          terminationProblem: null,
          stdoutPath: '/work/runs/run-1/logs/check.out',
          stderrPath: '/work/runs/run-1/logs/check.err',
        },
      ],
      problem: null,
    });
    for (const check of ['test:a', 'test:b']) {
      const baseline = round(check);
      const evidenceId = baselineEvidenceId(REF, baseCommit, baseline);
      const dir = path.join(workDir, 'baseline', project, evidenceId);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'evidence.json'),
        `${JSON.stringify(
          {
            version: 1,
            evidenceId,
            project,
            ref: REF,
            task: TASK,
            workspace: {
              workspaceId: 'HARN-11',
              workspacePath: '/work/workspaces/HARN-11',
              branch: 'harness/HARN-11',
              baseCommit,
            },
            baseline,
            closed: 'repair',
            closedAt: '2026-09-16T10:00:00.000Z',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      await writeFile(
        path.join(dir, 'outcome.json'),
        `${JSON.stringify(
          {
            version: 1,
            state: 'finding',
            finding: {
              outcome: 'repair',
              failingCheck: check,
              evidence: 'the check exited 1',
              likelyCause: 'the greeting is unimplemented',
              repairGuidance: 'implement the greeting',
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }

    const snapshot = await prepare(history(workDir), 'reviewer', 2);
    // Both diagnoses are outstanding findings of this project, each with the
    // identity its own evidence keeps.
    const ids = (snapshot.brief.unresolvedReviews ?? []).flatMap((review) =>
      review.findings.map((finding) => finding.id),
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^NBASELINE-F{7}-[0-9A-F]{8}-F1$/);
    }
    expect(
      snapshot.reports
        .flatMap((report) => report.findings)
        .map((finding) => finding.id)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it('keeps a turn’s input stable while a later refresh moves on', async () => {
    const workDir = await createTempDir();
    const ticketHistory = history(workDir, {
      jira: async () => ({ comments: [jiraComment()], truncated: false }),
    });

    const first = await prepare(ticketHistory);
    const second = await prepare(ticketHistory, 'reviewer', 2);

    expect(second.id).not.toBe(first.id);
    expect((await readCurrent(workspaceHistoryRoot(workDir, 'HARN-11')))?.snapshotId).toBe(
      second.id,
    );
    // The first turn's own snapshot is untouched, whatever came later.
    expect(await readFile(first.indexPath, 'utf8')).toContain(`Snapshot: ${first.id}`);
  });
});

describe('one complete report', () => {
  it('is saved before anything renders it, and its digest names the delivery', async () => {
    const workDir = await createTempDir();
    const record = await history(workDir).recordDeveloperReport?.({
      ref: REF,
      workspaceId: 'HARN-11',
      task: TASK,
      round: 3,
      runId: 'run-9',
      reportPath: '/work/runs/run-9/result.json',
      status: 'passed',
      reason: 'every configured check passed after repair turn 2',
      repairsUsed: 1,
      attempts: [
        { turn: 1, kind: 'implementation', agentSummary: 'first attempt', checks: 'failed' },
        { turn: 2, kind: 'repair', agentSummary: 'fixed it', checks: 'passed' },
      ],
      pullRequest: {
        number: 7,
        url: 'https://github.com/owner/name/pull/7',
        title: 'HARN-11',
        branch: 'harness/HARN-11',
        baseBranch: 'main',
        head: HEAD,
        observedAt: null,
        round: 3,
        entryId: null,
      },
      deliveryFailure: null,
      now: new Date('2026-09-16T11:00:00.000Z'),
    });

    expect(record?.round).toBe(3);
    const digest = JSON.parse(await readFile(record?.file ?? '', 'utf8')) as {
      readonly round: number;
      readonly status: string;
      readonly pullRequest: { readonly head: string };
    };
    expect(digest.round).toBe(3);
    expect(digest.status).toBe('passed');
    expect(digest.pullRequest.head).toBe(HEAD);
    // The complete rendering holds every turn whole, not a summary of it.
    const complete = await readFile(record?.completeFile ?? '', 'utf8');
    expect(complete).toContain('first attempt');
    expect(complete).toContain('fixed it');

    const snapshot = await prepare(history(workDir));
    expect(snapshot.entries.map((entry) => entry.kind)).toContain('developer-report');
    expect(snapshot.brief.latestDelivery?.head).toBe(HEAD);
    expect(snapshot.brief.latestDelivery?.round).toBe(3);
  });

  it('keeps the acknowledged rendering it was published as, for a later edit to be a new message', async () => {
    const text = 'HARN-11: the run passed. nexus-history: developer run-1';
    expect(textSha256(text)).toMatch(/^[0-9a-f]{64}$/);
    // The digest is what tells a rendering apart from an edit of it: the same
    // text hashes the same, and any edit hashes differently.
    expect(textSha256(text)).toBe(textSha256(`${text}`));
    expect(textSha256(`${text} `)).not.toBe(textSha256(text));
  });

  it('reads the answers of the newest coding turn alone, not every turn at once', () => {
    const text = [
      '# Developer report — HARN-11, round 4',
      '',
      '- Outcome: passed',
      '',
      '## Coding turns',
      '',
      '### Turn 1 (implementation)',
      '',
      'I repaired the greeting.',
      '',
      '### Finding R1-F1',
      '- Cause: the helper ignored its argument.',
      '',
      'Checks after the turn: failed',
      '',
      '### Turn 2 (repair)',
      '',
      'I reverted that repair.',
      '',
      'Checks after the turn: passed',
    ].join('\n');
    // Only the turn that ran last states what the developer claims now: turn
    // 1's answer above it is history, not an answer turn 2 gave.
    const newest = latestCodingTurnText(text);
    expect(newest).not.toContain('the helper ignored its argument');
    expect(newest).toContain('I reverted that repair.');
    // A rendering that states no coding turn is read whole, so a report this
    // harness did not write is still searched for the answers it holds.
    const plain = '### Finding R1-F1\n- Cause: the helper ignored its argument.';
    expect(latestCodingTurnText(plain)).toBe(plain);
    // The legacy rendering's own turn headings are recognized as well.
    const legacy = [
      '# Developer report (recorded before complete history retention) — HARN-11, round 1',
      '',
      '## Turn 1 (repair)',
      '',
      'answered',
    ].join('\n');
    expect(latestCodingTurnText(legacy)).toBe('\nanswered');
  });
});
