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
import { readFile, rm, writeFile } from 'node:fs/promises';
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
import { notePublishedReview, textSha256 } from '../../src/history/reports.js';
import { renderHistorySection } from '../../src/history/prompt.js';
import { outstandingFindingIds, unresolvedRounds } from '../../src/history/findings.js';
import { parseVerdict } from '../../src/reviews/reviewer.js';
import {
  incidentFilePath,
  openIncident,
  supervisorRoot,
  writeIncident,
} from '../../src/supervisor/incident.js';
import { sourceItemFor, writeWorkspaceState } from '../../src/workspace/state.js';
import type { SourceRef, Task } from '../../src/shared/types.js';
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
    expect(round?.findings.map((finding) => [finding.id, finding.occurrence])).toEqual([
      ['R1-F1', 'R2-F1'],
    ]);
    expect(round?.findings.map((finding) => finding.continues)).toEqual(['R1-F1']);
    expect(outstandingFindingIds(unresolvedRounds(snapshot.brief))).toEqual(['R1-F1']);
    const prompt = renderHistorySection(snapshot, 'reviewer');
    expect(prompt).toContain(
      'This review recorded the occurrence at R2-F1; the defect keeps the identity R1-F1.',
    );
    // The complete report on disk names the same identity, so a restart reads
    // the same defect back rather than a renamed one.
    const report = await readFile(
      path.join(workspaceHistoryRoot(workDir, 'HARN-11'), 'reports', 'reviewer-review-2.md'),
      'utf8',
    );
    expect(report).toContain('### Finding R1-F1: src/greeting.ts:2');
    expect(report).toContain('- Occurrence: R2-F1');
    const restarted = await prepare(history(workDir), 'reviewer', 4);
    expect(restarted.brief.unresolvedReviews?.[0]?.findings.map((finding) => finding.id)).toEqual([
      'R1-F1',
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
});
