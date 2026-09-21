/**
 * The ticket conversation history: one identified local snapshot for both
 * roles, complete reports kept before their concise renderings, and the gaps
 * every source that could not be read is reported as.
 *
 * Everything here is offline: the remote readers are fakes, and the files are
 * written in temporary directories.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTurnRequest } from '../src/runs/contracts.js';
import type { AgentLog } from '../src/reporting/logs.js';
import { promptFor } from '../src/agents/codex/prompt.js';
import type {
  HistoryReaders,
  HistorySnapshot,
  JiraThreadRead,
  PullRequestConversationRead,
  ReadComment,
} from '../src/history/contract.js';
import { HistoryError } from '../src/history/contract.js';
import { workspaceHistoryRoot } from '../src/history/paths.js';
import { renderHistorySection } from '../src/history/prompt.js';
import { baselineEvidenceId, createBaselineDiagnosis } from '../src/sources/baseline.js';
import { createCompletionPass } from '../src/sources/completion.js';
import type { CompletionActions, PullRequestSnapshot } from '../src/delivery/completion.js';
import type { CompletionSource, IssueNote } from '../src/sources/jira/completion.js';
import type { BaselineEvidence } from '../src/sources/baseline.js';
import { notePublishedReview, textSha256 } from '../src/history/reports.js';
import { createTicketHistory } from '../src/history/sync.js';
import type { ReviewEvidence, ReviewView } from '../src/reviews/contract.js';
import { baselinePrompt } from '../src/reviews/baseline.js';
import { reviewPrompt } from '../src/reviews/reviewer.js';
import { readCommentThread } from '../src/sources/jira/comments.js';
import type { HttpClient } from '../src/sources/jira/http.js';
import type { SourceRef, Task } from '../src/shared/types.js';
import { workspaceStatePath } from '../src/workspace/state.js';
import type { WorkspaceState } from '../src/workspace/state.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

afterEach(cleanupTempDirectories);

const REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10041',
  key: 'HARN-41',
  url: 'https://example.atlassian.net/browse/HARN-41',
  updatedAt: '2026-09-21T09:00:00.000Z',
};

const TASK: Task = {
  id: 'HARN-41',
  title: 'Give developer and reviewer complete local conversation history',
  description: 'Prepare one complete, locally available ticket history for both roles.',
  acceptanceCriteria: [
    'Both roles receive the same history organization and explicit local paths.',
    'Required actionable content is never silently truncated.',
  ],
};

const WORKSPACE_ID = 'HARN-41';
const HEAD = 'a'.repeat(40);

/** One Jira comment, as the connector's own read returns it. */
function jiraComment(
  id: string,
  text: string,
  parts: {
    readonly author?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string | null;
  } = {},
): ReadComment {
  return {
    sourceId: id,
    author: parts.author ?? 'Jane Reviewer',
    createdAt: parts.createdAt ?? '2026-09-20T10:00:00.000Z',
    updatedAt: parts.updatedAt ?? null,
    text,
    url: `${REF.url}?focusedCommentId=${id}`,
  };
}

/** The remote readers a fixture uses: ordinary functions a test controls. */
function readers(
  parts: {
    readonly jira?: JiraThreadRead | (() => JiraThreadRead | Promise<JiraThreadRead>);
    readonly pull?:
      | PullRequestConversationRead
      | null
      | (() => PullRequestConversationRead | null | Promise<PullRequestConversationRead | null>);
  } = {},
): HistoryReaders {
  return {
    jiraThread: async () => {
      const value = parts.jira ?? { comments: [], truncated: false };
      return typeof value === 'function' ? await value() : value;
    },
    pullRequestConversation: async () => {
      const value = parts.pull ?? null;
      return typeof value === 'function' ? await value() : value;
    },
  };
}

/** One pull request conversation with the usual delivery identity. */
function pullConversation(comments: readonly ReadComment[] = []): PullRequestConversationRead {
  return {
    pullRequest: {
      number: 27,
      url: 'https://github.com/example/repo/pull/27',
      title: 'HARN-41: history',
      headBranch: `harness/${WORKSPACE_ID}`,
      baseBranch: 'main',
      headSha: HEAD,
      observedAt: '2026-09-21T09:30:00.000Z',
    },
    comments,
    truncated: false,
  };
}

/** The agent log a prompt fixture needs, writing nowhere. */
function fakeLog(): AgentLog {
  return { path: 'agent.log', write: () => undefined, close: async () => undefined };
}

/** A developer turn request carrying one prepared snapshot. */
function developerRequest(snapshot: HistorySnapshot): AgentTurnRequest {
  return {
    kind: 'implementation',
    turn: 1,
    task: TASK,
    workspacePath: '/work/workspaces/HARN-41',
    sourceRoot: '/work/source',
    baseCommit: HEAD,
    agentLog: fakeLog(),
    repair: null,
    history: snapshot,
    stop: new AbortController().signal,
  };
}

/** Minimal reviewer evidence: the prompt is about the history, not the diff. */
const EVIDENCE: ReviewEvidence = {
  ref: REF,
  task: TASK,
  pullRequest: {
    number: 27,
    url: 'https://github.com/example/repo/pull/27',
    title: 'HARN-41: history',
    headSha: HEAD,
    headBranch: `harness/${WORKSPACE_ID}`,
    baseBranch: 'main',
    baseSha: 'c'.repeat(40),
    draft: false,
    author: 'example-owner',
  },
  files: [{ path: 'src/example.ts', patch: '@@ -1 +1 @@\n-a\n+b\n', additions: 1, deletions: 1 }],
  truncated: false,
  checks: [],
  combinedStatus: null,
  fetchedAt: '2026-09-21T09:30:00.000Z',
};

const VIEW: ReviewView = {
  path: '/evidence/review-1/repo',
  head: HEAD,
  base: 'c'.repeat(40),
};

/** The one prepare request every test in this file uses, for one role. */
function prepareRequest(
  workDir: string,
  role: 'developer' | 'reviewer' = 'developer',
): Parameters<ReturnType<typeof createTicketHistory>['prepare']>[0] {
  return {
    ref: REF,
    task: TASK,
    workspace: {
      workspaceId: WORKSPACE_ID,
      workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
      branch: `harness/${WORKSPACE_ID}`,
      baseCommit: HEAD,
    },
    role,
    round: 1,
    stop: new AbortController().signal,
  };
}

describe('the ticket conversation snapshot', () => {
  it('keeps mixed-offset responses after both roles consume them, ordering reviews by instant', async () => {
    const workDir = await createTempDir();
    const native = [
      {
        ...jiraComment('alice', 'Alice finding', {
          author: 'Alice',
          createdAt: '2026-09-21T12:00:00.000Z',
        }),
        state: 'CHANGES_REQUESTED',
        commit: HEAD,
      },
      {
        ...jiraComment('bob', 'Bob earlier finding', {
          author: 'Bob',
          createdAt: '2026-09-21T13:00:00.000+0200',
        }),
        state: 'CHANGES_REQUESTED',
        commit: HEAD,
      },
      {
        ...jiraComment('old-approval', 'Alice earlier approval', {
          author: 'Alice',
          createdAt: '2026-09-21T13:30:00.000+0200',
        }),
        state: 'APPROVED',
        commit: HEAD,
      },
    ];
    const comments = [
      jiraComment('latest', 'Latest response to Alice', {
        createdAt: '2026-09-21T08:30:00.000-0400',
      }),
      jiraComment('between', 'Response to Bob before Alice', {
        createdAt: '2026-09-21T07:15:00.000-0400',
      }),
      jiraComment('edited', 'Edited response to Alice', {
        createdAt: '2026-09-20T12:00:00.000Z',
        updatedAt: '2026-09-21T14:45:00.000+0200',
      }),
      jiraComment('before', 'Not a response', { createdAt: '2026-09-21T14:00:00.000+0400' }),
    ];
    const parts = {
      workDir,
      readers: readers({ jira: { comments, truncated: false }, pull: pullConversation(native) }),
    };
    for (const role of ['developer', 'reviewer'] as const) {
      const history = createTicketHistory(parts);
      await history.consumed?.(await history.prepare(prepareRequest(workDir, role)));
      const snapshot = await createTicketHistory(parts).prepare(prepareRequest(workDir, role));
      expect(snapshot.brief.newHumanFeedback).toHaveLength(0);
      expect(snapshot.brief.unresolvedReviews?.map((review) => review.author)).toEqual([
        'Bob',
        'Alice',
      ]);
      expect(snapshot.brief.responses.map((entry) => entry.sourceId)).toEqual([
        'edited',
        'between',
        'old-approval',
        'latest',
      ]);
      expect(snapshot.entries.map((entry) => entry.sourceId)).toEqual([
        'edited',
        'before',
        'bob',
        'between',
        'old-approval',
        'alice',
        'latest',
      ]);
      expect(snapshot.entries.find((entry) => entry.sourceId === 'latest')?.createdAt).toBe(
        '2026-09-21T08:30:00.000-0400',
      );
      const prompt =
        role === 'developer'
          ? promptFor(developerRequest(snapshot))
          : reviewPrompt(EVIDENCE, VIEW, '/evidence', snapshot);
      for (const text of [
        'Latest response to Alice',
        'Response to Bob before Alice',
        'Edited response to Alice',
      ])
        expect(prompt).toContain(text);
      expect(prompt).not.toContain('Not a response');
    }
  });

  it('retains responses with unknown timestamps conservatively and names the gap', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      readers: readers({
        pull: pullConversation([
          { ...jiraComment('review', 'Fix it'), state: 'CHANGES_REQUESTED', commit: HEAD },
        ]),
        jira: {
          comments: [jiraComment('unknown', 'Undated response', { createdAt: 'unavailable' })],
          truncated: false,
        },
      }),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));
    expect(snapshot.brief.responses.map((entry) => entry.sourceId)).toContain('unknown');
    expect(snapshot.gaps.join(' ')).toContain('timestamp of jira:jira-comment:unknown');
  });

  it('associates normal completion publication with its review, keeping context, restart and edits', async () => {
    const workDir = await createTempDir();
    const root = workspaceHistoryRoot(workDir, WORKSPACE_ID);
    const reviewUrl = `${EVIDENCE.pullRequest.url}#pullrequestreview-555`;
    const nativeBody = 'Native review excerpt';
    const notes: IssueNote[] = [];
    const makeHistory = () =>
      createTicketHistory({
        workDir,
        harnessAuthors: ['nexus-lens[bot]'],
        readers: readers({
          jira: () => ({
            comments: notes.map((note) =>
              jiraComment(note.id, note.text, {
                author: 'Jira Service Account',
                createdAt: note.createdAt,
              }),
            ),
            truncated: false,
          }),
          pull: pullConversation([
            {
              ...jiraComment('555', nativeBody, { author: 'nexus-lens[bot]' }),
              state: 'CHANGES_REQUESTED',
              commit: HEAD,
            },
          ]),
        }),
      });
    await makeHistory().recordReviewerReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      reviewId: 'completion-review',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'Complete local review',
      findings: [{ path: 'a.ts', line: 1, body: 'Full finding. '.repeat(600) + 'END-FINDING' }],
      now: new Date('2026-09-21T12:00:00Z'),
    });
    await notePublishedReview(root, 'completion-review', {
      id: 555,
      url: reviewUrl,
      body: nativeBody,
    });
    const pull: PullRequestSnapshot = {
      number: 27,
      url: EVIDENCE.pullRequest.url,
      state: 'OPEN',
      isDraft: false,
      headRefName: `harness/${WORKSPACE_ID}`,
      baseRefName: 'main',
      headRefOid: HEAD,
      mergeCommit: null,
    };
    const unexpected = async (): Promise<never> => {
      throw new Error('unexpected completion operation');
    };
    const actions: CompletionActions = {
      findPullRequest: async () => pull,
      findMergedPullRequest: async () => pull,
      readGate: async () => ({
        status: 'failed',
        reason: 'Changes requested',
        review: {
          id: '555',
          author: 'nexus-lens[bot]',
          state: 'CHANGES_REQUESTED',
          body: nativeBody,
          commitId: HEAD,
          url: reviewUrl,
        },
        findings: [
          { label: 'Nexus Lens review', detail: 'Concise mirrored finding', link: reviewUrl },
          {
            label: 'CI',
            detail: 'Distinct check failure',
            link: 'https://github.com/example/repo/actions/runs/1',
          },
        ],
      }),
      readApprovedHead: unexpected,
      readMerge: unexpected,
      enableAutoMerge: unexpected,
    };
    let moves = 0;
    const source: CompletionSource = {
      listReview: async () => [{ ref: REF, title: TASK.title }],
      readItem: async () => ({
        ref: REF,
        title: TASK.title,
        statusName: 'In Review',
        pointers: [WORKSPACE_ID],
      }),
      listComments: async () => notes,
      leftReviewSince: async () => false,
      postComment: async (_id, paragraphs) => {
        notes.push({
          id: 'completion-comment',
          text: paragraphs.join('\n'),
          createdAt: '2026-09-21T13:00:00Z',
        });
        return 'completion-comment';
      },
      moveTo: async () => {
        moves++;
        return 'moved';
      },
    };
    const parts = {
      workDir,
      repository: 'example/repo',
      baseBranch: 'main',
      source,
      actions,
      config: {
        lensApp: 'nexus-lens[bot]',
        lensAppId: 123,
        lensCheckName: 'Nexus Lens',
        reviewerTokenEnv: 'UNUSED',
        postMergeWorkflows: ['ci.yml'],
        toDoStatus: 'To Do',
        doneStatus: 'Done',
        pollIntervalSeconds: 1,
        deadlineSeconds: 30,
      },
      io: { out: () => undefined, err: () => undefined },
      now: () => new Date('2026-09-21T13:00:00Z'),
      sleep: unexpected,
    };
    expect((await createCompletionPass(parts).run(new AbortController().signal))[0]?.status).toBe(
      'to-do',
    );
    expect(moves).toBe(1);
    const original = notes[0]?.text ?? '';
    const first = await makeHistory().prepare(prepareRequest(workDir));
    expect(first.entries.filter((entry) => entry.kind === 'reviewer-report')).toHaveLength(1);
    const context = first.entries.find((entry) => entry.sourceId === 'completion-comment');
    expect(context?.role).toBe('harness');
    expect(context?.text).toContain('Distinct check failure');
    expect(context?.text).toContain('Returned to To Do');
    expect(context?.text).not.toContain('Concise mirrored finding');
    expect(first.brief.newHumanFeedback).toHaveLength(0);
    expect(
      first.mirrors.find((mirror) => mirror.sourceId === 'completion-comment')?.originalEntry?.text,
    ).toBe(original);
    expect(renderHistorySection(first, 'developer')).toContain('END-FINDING');
    const immutable = await readFile(first.indexJsonPath, 'utf8');
    await createCompletionPass(parts).run(new AbortController().signal);
    expect(notes).toHaveLength(1);
    expect((await makeHistory().prepare(prepareRequest(workDir))).id).toBe(first.id);
    notes[0] = {
      id: 'completion-comment',
      createdAt: '2026-09-21T13:00:00Z',
      text: original + '\nAdditional operator instruction',
    };
    await createCompletionPass(parts).run(new AbortController().signal);
    const edited = await makeHistory().prepare(prepareRequest(workDir));
    expect(edited.mirrors.map((mirror) => mirror.sourceId)).not.toContain('completion-comment');
    expect(edited.brief.newHumanFeedback.map((entry) => entry.text)).toContain(notes[0].text);
    expect(await readFile(first.indexJsonPath, 'utf8')).toBe(immutable);
  });

  /** One Jira answer per requested page, keyed by the `startAt` asked for. */
  function fakeJira(
    pages: Readonly<Record<number, readonly Record<string, unknown>[]>>,
    total: number,
  ): {
    readonly http: HttpClient;
    readonly starts: number[];
  } {
    const starts: number[] = [];
    const http: HttpClient = {
      baseUrl: 'https://api.atlassian.com/ex/jira/cloud',
      token: 'test-token',
      fetch: globalThis.fetch,
      now: () => new Date('2026-09-21T10:00:00.000Z'),
      request: async (request) => {
        const url = new URL(request.path, 'https://api.atlassian.com');
        const startAt = Number(url.searchParams.get('startAt') ?? '0');
        starts.push(startAt);
        return { comments: pages[startAt] ?? [], total };
      },
    };
    return { http, starts };
  }

  /** One raw Jira comment answer. */
  function rawComment(
    id: string,
    created: string,
    updated: string,
    text: string,
  ): Record<string, unknown> {
    return {
      id,
      author: { displayName: 'Jane Reviewer' },
      created,
      updated,
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      },
    };
  }

  it('reads every page of the ticket thread, with edited comments marked', async () => {
    const { http, starts } = fakeJira(
      {
        0: [
          rawComment('1', '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z', 'first'),
          rawComment('2', '2026-09-20T09:00:00.000Z', '2026-09-20T09:30:00.000Z', 'second, edited'),
        ],
        2: [rawComment('3', '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z', 'third')],
      },
      3,
    );

    const thread = await readCommentThread(
      http,
      'test-token',
      REF.id,
      REF.key,
      new AbortController().signal,
    );

    expect(starts).toEqual([0, 2]);
    expect(thread.truncated).toBe(false);
    expect(thread.comments.map((comment) => comment.id)).toEqual(['1', '2', '3']);
    expect(thread.comments[1]).toMatchObject({
      updatedAt: '2026-09-20T09:30:00.000Z',
      text: 'second, edited',
    });
    expect(thread.comments[0]?.updatedAt).toBeNull();
  });

  it('reports a thread it could not read past the pages it followed', async () => {
    const { http } = fakeJira(
      { 0: [rawComment('1', '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z', 'first')] },
      4,
    );

    const thread = await readCommentThread(
      http,
      'test-token',
      REF.id,
      REF.key,
      new AbortController().signal,
    );

    expect(thread.comments).toHaveLength(1);
    expect(thread.truncated).toBe(true);
  });

  it('carries the requirements, the complete unresolved findings and the human feedback', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      readers: readers({
        jira: {
          comments: [
            jiraComment('9001', 'Earlier design note.', {
              createdAt: '2026-09-21T09:30:00.000Z',
            }),
          ],
          truncated: false,
        },
        pull: pullConversation(),
      }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const longFinding = `The retry loop drops the second page. ${'detail '.repeat(300)}`.trim();
    await history.recordReviewerReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      reviewId: 'review-20260921-0001',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'Two findings.',
      findings: [
        { path: 'src/history/sync.ts', line: 42, body: longFinding },
        { path: 'src/history/store.ts', line: null, body: 'Keep the snapshot immutable.' },
      ],
      now: new Date('2026-09-21T09:00:00.000Z'),
    });
    const snapshot = await history.prepare({
      ref: REF,
      task: TASK,
      workspace: {
        workspaceId: WORKSPACE_ID,
        workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
        branch: `harness/${WORKSPACE_ID}`,
        baseCommit: HEAD,
      },
      role: 'developer',
      round: 2,
      stop: new AbortController().signal,
    });

    expect(snapshot.brief.task).toEqual(TASK);
    expect(snapshot.brief.latestDelivery?.url).toBe('https://github.com/example/repo/pull/27');
    expect(snapshot.brief.unresolved?.findings[0]?.body).toBe(longFinding);
    expect(snapshot.brief.unresolved?.findings[0]?.body.length).toBeGreaterThan(2_000);
    expect(snapshot.brief.unresolved?.complete).toBe(true);
    expect(snapshot.brief.newHumanFeedback.map((entry) => entry.sourceId)).toContain('9001');
    expect(snapshot.gaps).toEqual([]);

    // The complete report is recorded before anything renders it, and the
    // snapshot points at the report directory that holds it.
    const reports = await readdir(snapshot.reportsDir);
    expect(reports).toContain('reviewer-review-20260921-0001.json');
    expect(reports).toContain('reviewer-review-20260921-0001.md');
    const report = await readFile(
      path.join(snapshot.reportsDir, 'reviewer-review-20260921-0001.md'),
      'utf8',
    );
    expect(report).toContain(longFinding);
  });

  it('gives both roles the same organization, the same paths and the finding whole', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      readers: readers({ jira: { comments: [], truncated: false }, pull: pullConversation() }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const veryLongFinding = `A finding far past the old per-comment budgets. ${'x'.repeat(5_000)}`;
    await history.recordReviewerReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      reviewId: 'review-20260921-0002',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'One finding.',
      findings: [{ path: 'src/a.ts', line: 3, body: veryLongFinding }],
      now: new Date('2026-09-21T09:00:00.000Z'),
    });
    const snapshot = await history.prepare({
      ref: REF,
      task: TASK,
      workspace: {
        workspaceId: WORKSPACE_ID,
        workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
        branch: `harness/${WORKSPACE_ID}`,
        baseCommit: HEAD,
      },
      role: 'developer',
      round: 1,
      stop: new AbortController().signal,
    });

    const developer = promptFor(developerRequest(snapshot));
    const reviewer = reviewPrompt(EVIDENCE, VIEW, '/evidence/review-1', snapshot);
    const diagnostic = baselinePrompt({
      item: { ref: REF, task: TASK },
      baseline: { outcome: 'failed', setup: [], checks: [], problem: null },
      failures: [],
      view: VIEW,
      dir: '/evidence/baseline',
      history: snapshot,
    });
    for (const prompt of [developer, reviewer, diagnostic]) {
      expect(prompt).toContain(snapshot.indexPath);
      expect(prompt).toContain(snapshot.entriesPath);
      expect(prompt).toContain(snapshot.dir);
      expect(prompt).toContain(snapshot.reportsDir);
      expect(prompt).toContain(veryLongFinding);
      expect(prompt).toContain('Complete ticket requirements: ');
      expect(prompt).toContain('### Current brief');
      expect(prompt).toContain('### Complete unresolved review findings');
      expect(prompt).toContain('### New human feedback since this role’s last consumed snapshot');
      expect(prompt).toContain('### How to use the history');
      expect(prompt).toContain('Do not fetch Jira or GitHub yourself for this ticket');
      expect(prompt).not.toContain('truncated by the harness at 600');
      expect(prompt).not.toContain('truncated by the harness at 4,000');
    }
    // The organization is the same; only the sentence that opens it names the
    // role the snapshot was prepared for.
    const developerSection = renderHistorySection(snapshot, 'developer').split('\n\n');
    const reviewerSection = renderHistorySection(snapshot, 'reviewer').split('\n\n');
    expect(developerSection.slice(1)).toEqual(reviewerSection.slice(1));
  });

  it('keeps a long history whole and names what the brief could not inline', async () => {
    const workDir = await createTempDir();
    const comments: ReadComment[] = [];
    for (let index = 1; index <= 400; index += 1) {
      comments.push(
        jiraComment(String(10_000 + index), `${'human feedback '.repeat(40)}#${String(index)}`, {
          createdAt: `2026-09-20T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
        }),
      );
    }
    const history = createTicketHistory({
      workDir,
      readers: readers({ jira: { comments, truncated: false }, pull: pullConversation() }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const snapshot = await history.prepare({
      ref: REF,
      task: TASK,
      workspace: {
        workspaceId: WORKSPACE_ID,
        workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
        branch: `harness/${WORKSPACE_ID}`,
        baseCommit: HEAD,
      },
      role: 'developer',
      round: 1,
      stop: new AbortController().signal,
    });

    expect(snapshot.entries).toHaveLength(400);
    const index = await readFile(snapshot.indexPath, 'utf8');
    expect(index).toContain('jira:jira-comment:10001');
    expect(index).toContain('jira:jira-comment:10400');
    const lines = (await readFile(snapshot.entriesPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(400);
    const rendered = renderHistorySection(snapshot, 'developer');
    expect(rendered).toContain('not inlined here because this section is bounded by whole entries');
    // Every entry is still on disk in full.
    const entryFiles = await readdir(path.join(snapshot.dir, 'entries'));
    expect(entryFiles).toHaveLength(400);
  });

  it('updates an edited comment in a new snapshot and leaves the old one untouched', async () => {
    const workDir = await createTempDir();
    let text = 'First wording.';
    let updatedAt: string | null = null;
    const history = createTicketHistory({
      workDir,
      readers: readers({
        jira: () => ({
          comments: [jiraComment('9200', text, { updatedAt })],
          truncated: false,
        }),
      }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const request = {
      ref: REF,
      task: TASK,
      workspace: {
        workspaceId: WORKSPACE_ID,
        workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
        branch: `harness/${WORKSPACE_ID}`,
        baseCommit: HEAD,
      },
      role: 'developer' as const,
      round: 1,
      stop: new AbortController().signal,
    };
    const first = await history.prepare(request);
    text = 'Second wording, edited.';
    updatedAt = '2026-09-21T09:45:00.000Z';
    const second = await history.prepare(request);

    expect(second.id).not.toBe(first.id);
    const edited = second.entries.find((entry) => entry.sourceId === '9200');
    expect(edited?.text).toBe('Second wording, edited.');
    expect(edited?.edited).toBe(true);
    const firstFile = first.entries.find((entry) => entry.sourceId === '9200')?.file ?? '';
    expect(await readFile(path.join(first.dir, firstFile), 'utf8')).toContain('First wording.');
    expect(await readFile(path.join(first.dir, firstFile), 'utf8')).not.toContain('Second wording');
  });

  it('does not add a second entry for a report mirrored back through its recorded publication', async () => {
    const workDir = await createTempDir();
    const publishedCommentText = [
      'Harness run run-20260921-0001 for HARN-41 finished: passed.',
      'Reason: every configured check exited 0',
      'Checks: 1 of 1 configured checks exited 0',
      'Repairs used: 0',
      'Local artifacts on the machine that ran this harness (local paths, not Jira attachments): run directory /runs/run-20260921-0001; report /runs/run-20260921-0001/result.json',
      'Harness record: nexus-history: developer run-20260921-0001 — the complete developer report is kept beside the workspace.',
    ].join('\n');
    const publishedReviewText = [
      'Nexus Lens review — HARN-41: history',
      '',
      'One finding.',
      '',
      'See the inline findings on this review.',
      '',
      'Reviewed head ' + HEAD + ' of https://github.com/example/repo/pull/27.',
      '',
      'Harness record: nexus-history: reviewer review-20260921-0003 — complete report kept locally.',
    ].join('\n');
    const history = createTicketHistory({
      workDir,
      readers: readers({
        jira: {
          comments: [jiraComment('9300', publishedCommentText, { author: 'Nexus Harness' })],
          truncated: false,
        },
        pull: pullConversation([
          {
            sourceId: '555',
            author: 'nexus-lens[bot]',
            createdAt: '2026-09-21T08:00:00.000Z',
            updatedAt: null,
            text: publishedReviewText,
            url: 'https://github.com/example/repo/pull/27#review',
            state: 'CHANGES_REQUESTED',
            commit: HEAD,
          },
        ]),
      }),
      harnessAuthors: ['nexus-lens[bot]'],
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    await history.recordDeveloperReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      round: 1,
      runId: 'run-20260921-0001',
      reportPath: path.join(workDir, 'runs', 'run-20260921-0001', 'result.json'),
      status: 'passed',
      reason: 'every configured check exited 0',
      repairsUsed: 0,
      attempts: [],
      pullRequest: null,
      deliveryFailure: null,
      now: new Date('2026-09-21T07:30:00.000Z'),
    });
    await history.recordReviewerReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      reviewId: 'review-20260921-0003',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'One finding.',
      findings: [{ path: 'src/a.ts', line: 1, body: 'Fix this.' }],
      now: new Date('2026-09-21T07:45:00.000Z'),
    });
    // The harness recorded what it published: the acknowledged Jira comment
    // and the native review GitHub answered with. Those identities — never the
    // wording alone — are what authenticate the renderings read back.
    await history.notePublishedDeveloperReport?.({
      workspaceId: WORKSPACE_ID,
      runId: 'run-20260921-0001',
      commentId: '9300',
      url: `${REF.url}?focusedCommentId=9300`,
      text: publishedCommentText,
    });
    await notePublishedReview(workspaceHistoryRoot(workDir, WORKSPACE_ID), 'review-20260921-0003', {
      id: 555,
      url: 'https://github.com/example/repo/pull/27#review',
      body: publishedReviewText,
    });
    const snapshot = await history.prepare({
      ref: REF,
      task: TASK,
      workspace: {
        workspaceId: WORKSPACE_ID,
        workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
        branch: `harness/${WORKSPACE_ID}`,
        baseCommit: HEAD,
      },
      role: 'developer',
      round: 2,
      stop: new AbortController().signal,
    });

    expect(snapshot.entries.filter((entry) => entry.kind === 'developer-report')).toHaveLength(1);
    expect(snapshot.entries.filter((entry) => entry.kind === 'reviewer-report')).toHaveLength(1);
    expect(snapshot.entries.some((entry) => entry.sourceId === '9300')).toBe(false);
    expect(snapshot.mirrors.map((mirror) => mirror.sourceId).sort()).toEqual(['555', '9300']);
  });

  it('reuses the identical snapshot and never rewrites one a running turn holds', async () => {
    const workDir = await createTempDir();
    let extra = false;
    const history = createTicketHistory({
      workDir,
      readers: {
        jiraThread: async () => ({
          comments: extra ? [jiraComment('9500', 'New feedback.')] : [],
          truncated: false,
        }),
        pullRequestConversation: async () => null,
      },
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const request = {
      ref: REF,
      task: TASK,
      workspace: {
        workspaceId: WORKSPACE_ID,
        workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
        branch: `harness/${WORKSPACE_ID}`,
        baseCommit: HEAD,
      },
      role: 'reviewer' as const,
      round: 1,
      stop: new AbortController().signal,
    };
    const first = await history.prepare(request);
    const before = await stat(first.indexPath);
    const again = await history.prepare(request);
    expect(again.id).toBe(first.id);
    expect(again.dir).toBe(first.dir);
    expect((await stat(first.indexPath)).mtimeMs).toBe(before.mtimeMs);

    extra = true;
    const refreshed = await history.prepare(request);
    expect(refreshed.id).not.toBe(first.id);
    // The snapshot the first turn holds is still byte-for-byte what it was.
    expect(await readFile(first.indexPath, 'utf8')).not.toContain('9500');
    expect(
      await readFile(
        path.join(workDir, 'workspaces', `${WORKSPACE_ID}.history`, 'current.json'),
        'utf8',
      ),
    ).toContain(refreshed.id);
  });

  it('marks a report it knows existed but cannot read, and says so in the turn', async () => {
    const workDir = await createTempDir();
    const missing = path.join(workDir, 'runs', 'run-legacy-1', 'result.json');
    const state: WorkspaceState = {
      version: 1,
      workspaceId: WORKSPACE_ID,
      sourceRoot: path.join(workDir, 'source'),
      baseCommit: HEAD,
      branch: `harness/${WORKSPACE_ID}`,
      createdAt: '2026-09-20T08:00:00.000Z',
      sourceItem: { type: REF.type, scope: REF.scope, id: REF.id, key: REF.key },
      attempts: [
        {
          runId: 'run-legacy-1',
          outcome: 'failed',
          reason: 'the checks failed',
          endedAt: '2026-09-20T09:00:00.000Z',
          reportPath: missing,
        },
      ],
    };
    await mkdir(path.dirname(workspaceStatePath(workDir, WORKSPACE_ID)), { recursive: true });
    await writeFile(workspaceStatePath(workDir, WORKSPACE_ID), JSON.stringify(state), 'utf8');
    // A review record whose complete verdict was never kept.
    const reviewDir = path.join(workDir, 'reviews', 'review-legacy-9');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, 'review.json'),
      JSON.stringify({
        version: 1,
        reviewId: 'review-legacy-9',
        ref: REF,
        startedAt: '2026-09-20T09:30:00.000Z',
        verdict: 'request_changes',
        problem: null,
      }),
      'utf8',
    );
    const history = createTicketHistory({
      workDir,
      readers: readers(),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const snapshot = await history.prepare({
      ref: REF,
      task: TASK,
      workspace: {
        workspaceId: WORKSPACE_ID,
        workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
        branch: `harness/${WORKSPACE_ID}`,
        baseCommit: HEAD,
      },
      role: 'developer',
      round: 2,
      stop: new AbortController().signal,
    });

    const developerMissing = snapshot.entries.find((entry) => entry.sourceId === 'run-legacy-1');
    expect(developerMissing?.kind).toBe('missing-report');
    expect(developerMissing?.complete).toBe(false);
    expect(developerMissing?.problem).toContain(missing);
    const reviewerMissing = snapshot.entries.find((entry) => entry.sourceId === 'review-legacy-9');
    expect(reviewerMissing?.kind).toBe('missing-report');
    expect(snapshot.gaps.join('\n')).toContain(missing);
    const rendered = renderHistorySection(snapshot, 'developer');
    expect(rendered).toContain('### Incomplete input (read before starting)');
    expect(rendered).toContain(missing);
  });

  it('rebuilds a legacy workspace attempt from its own run report', async () => {
    const workDir = await createTempDir();
    const runDir = path.join(workDir, 'runs', 'run-legacy-2');
    const reportPath = path.join(runDir, 'result.json');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({
        runId: 'run-legacy-2',
        status: 'failed',
        reason: 'the checks after the implementation turn did not all exit 0',
        endedAt: '2026-09-20T11:00:00.000Z',
        attempts: [
          {
            turn: 1,
            kind: 'implementation',
            agentLog: path.join(runDir, 'logs', 'agent-1.log'),
            agentSummary: 'Implemented the first half.',
            checks: { outcome: 'failed', setup: [], checks: [], problem: null },
          },
        ],
      }),
      'utf8',
    );
    const state: WorkspaceState = {
      version: 1,
      workspaceId: WORKSPACE_ID,
      sourceRoot: path.join(workDir, 'source'),
      baseCommit: HEAD,
      branch: `harness/${WORKSPACE_ID}`,
      createdAt: '2026-09-20T10:00:00.000Z',
      sourceItem: { type: REF.type, scope: REF.scope, id: REF.id, key: REF.key },
      attempts: [
        {
          runId: 'run-legacy-2',
          outcome: 'failed',
          reason: 'the checks failed',
          endedAt: '2026-09-20T11:00:00.000Z',
          reportPath,
        },
      ],
    };
    await mkdir(path.dirname(workspaceStatePath(workDir, WORKSPACE_ID)), { recursive: true });
    await writeFile(workspaceStatePath(workDir, WORKSPACE_ID), JSON.stringify(state), 'utf8');
    const history = createTicketHistory({
      workDir,
      readers: readers(),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const snapshot = await history.prepare({
      ref: REF,
      task: TASK,
      workspace: {
        workspaceId: WORKSPACE_ID,
        workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
        branch: `harness/${WORKSPACE_ID}`,
        baseCommit: HEAD,
      },
      role: 'developer',
      round: 2,
      stop: new AbortController().signal,
    });

    const rebuilt = snapshot.entries.find((entry) => entry.sourceId === 'run-legacy-2');
    expect(rebuilt?.kind).toBe('developer-report');
    expect(rebuilt?.complete).toBe(true);
    expect(rebuilt?.text).toContain('Implemented the first half.');
    expect(rebuilt?.text).toContain('the checks after the implementation turn did not all exit 0');
    expect(snapshot.entries.some((entry) => entry.kind === 'missing-report')).toBe(false);
  });

  it('refuses to prepare a snapshot that cannot be written beside the workspace', async () => {
    const workDir = await createTempDir();
    await mkdir(path.join(workDir, 'workspaces'), { recursive: true });
    // Something that is not a directory holds the history root's name.
    await writeFile(workspaceHistoryRoot(workDir, WORKSPACE_ID), 'not a directory', 'utf8');
    const history = createTicketHistory({
      workDir,
      readers: readers(),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    await expect(
      history.prepare({
        ref: REF,
        task: TASK,
        workspace: {
          workspaceId: WORKSPACE_ID,
          workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
          branch: `harness/${WORKSPACE_ID}`,
          baseCommit: HEAD,
        },
        role: 'developer',
        round: 1,
        stop: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HistoryError);
  });

  it('reports a source read that failed rather than presenting an empty conversation', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      readers: {
        jiraThread: async () => {
          throw new Error('Jira answered HTTP 503');
        },
        pullRequestConversation: async () => {
          throw new Error('the pull request conversation is unavailable');
        },
      },
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const snapshot = await history.prepare({
      ref: REF,
      task: TASK,
      workspace: {
        workspaceId: WORKSPACE_ID,
        workspacePath: path.join(workDir, 'workspaces', WORKSPACE_ID),
        branch: `harness/${WORKSPACE_ID}`,
        baseCommit: HEAD,
      },
      role: 'reviewer',
      round: 1,
      stop: new AbortController().signal,
    });
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.gaps.join('\n')).toContain('Jira answered HTTP 503');
    expect(snapshot.gaps.join('\n')).toContain('pull request conversation is unavailable');
    const rendered = renderHistorySection(snapshot, 'reviewer');
    expect(rendered).toContain('Jira answered HTTP 503');
    expect(rendered).toContain('pull request conversation is unavailable');
  });

  it('tracks consumption independently for both roles across preparation, edits and restart', async () => {
    const workDir = await createTempDir();
    let text = 'Act on this human feedback.';
    const remote = readers({
      jira: () => ({ comments: [jiraComment('role-feedback', text)], truncated: false }),
    });
    const history = createTicketHistory({ workDir, readers: remote });
    const abandoned = await history.prepare(prepareRequest(workDir));
    const developer = await history.prepare(prepareRequest(workDir));
    expect(developer.brief.newHumanFeedback[0]?.text).toBe(text);
    expect(developer.id).toBe(abandoned.id);
    await history.consumed?.(developer);
    const reviewer = await history.prepare(prepareRequest(workDir, 'reviewer'));
    expect(reviewer.brief.newHumanFeedback[0]?.text).toBe(text);
    await history.consumed?.(reviewer);
    const restarted = createTicketHistory({ workDir, readers: remote });
    expect((await restarted.prepare(prepareRequest(workDir))).brief.newHumanFeedback).toEqual([]);
    text = 'Edited feedback without a changed timestamp.';
    const editedReview = await restarted.prepare(prepareRequest(workDir, 'reviewer'));
    expect(editedReview.brief.newHumanFeedback[0]?.text).toBe(text);
    await restarted.consumed?.(editedReview);
    const editedDeveloper = await restarted.prepare(prepareRequest(workDir));
    expect(editedDeveloper.brief.newHumanFeedback[0]?.text).toBe(text);
    expect(await readFile(developer.entriesPath, 'utf8')).not.toContain(text);
  });

  it('refreshes requirements for both prompts and refuses unreadable required input', async () => {
    const workDir = await createTempDir();
    let description = 'Current requirements, edited during the preceding turn.';
    const history = createTicketHistory({
      workDir,
      readers: {
        ...readers(),
        currentTask: async () => {
          if (description === '') throw new Error('requirements are unavailable');
          return {
            ref: { ...REF, updatedAt: '2026-09-21T12:00:00.000Z' },
            task: { ...TASK, description },
          };
        },
      },
    });
    const first = await history.prepare(prepareRequest(workDir));
    for (const prompt of [
      promptFor(developerRequest(first)),
      reviewPrompt(EVIDENCE, VIEW, '/review', first),
    ]) {
      expect(prompt).toContain(description);
      expect(prompt).not.toContain(TASK.description);
    }
    description = 'Requirements edited again before a repair turn.';
    const second = await history.prepare(prepareRequest(workDir));
    expect(second.brief.task.description).toBe(description);
    expect(await readFile(first.indexJsonPath, 'utf8')).not.toContain(description);
    description = '';
    await expect(history.prepare(prepareRequest(workDir))).rejects.toThrow(
      'current ticket requirements could not be obtained',
    );
  });

  it('keeps each reviewer’s findings and responses through unrelated approvals and comment-only reviews', async () => {
    const workDir = await createTempDir();
    const comments: ReadComment[] = [
      {
        ...jiraComment('1', 'Alice blocking finding'),
        author: 'Alice',
        state: 'CHANGES_REQUESTED',
        commit: HEAD,
      },
      {
        ...jiraComment('2', 'Bob blocking finding'),
        author: 'Bob',
        state: 'CHANGES_REQUESTED',
        commit: HEAD,
        createdAt: '2026-09-20T11:00:00.000Z',
      },
      {
        ...jiraComment('3', 'A comment, not approval'),
        author: 'Alice',
        state: 'COMMENTED',
        commit: HEAD,
        createdAt: '2026-09-20T12:00:00.000Z',
      },
      {
        ...jiraComment('4', 'Charlie approves'),
        author: 'Charlie',
        state: 'APPROVED',
        commit: HEAD,
        createdAt: '2026-09-20T13:00:00.000Z',
      },
    ];
    const response = 'Response to both findings. ' + 'Details\n'.repeat(1_000);
    const history = createTicketHistory({
      workDir,
      readers: readers({
        pull: () => pullConversation(comments),
        jira: {
          comments: [
            jiraComment('reply', response, {
              createdAt: '2026-09-19T09:00:00.000Z',
              updatedAt: '2026-09-21T09:00:00.000Z',
            }),
          ],
          truncated: false,
        },
      }),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));
    expect(snapshot.brief.unresolvedReviews?.map((review) => review.author)).toEqual([
      'Alice',
      'Bob',
    ]);
    for (const role of ['developer', 'reviewer'] as const) {
      const prompt = renderHistorySection(snapshot, role);
      expect(prompt).toContain('Alice blocking finding');
      expect(prompt).toContain('Bob blocking finding');
      expect(prompt).toContain(response.trim());
    }
    comments.push({
      ...jiraComment('5', 'Alice approves current head'),
      author: 'Alice',
      state: 'APPROVED',
      commit: HEAD,
      createdAt: '2026-09-20T14:00:00.000Z',
    });
    expect(
      (await history.prepare(prepareRequest(workDir))).brief.unresolvedReviews?.map(
        (review) => review.author,
      ),
    ).toEqual(['Bob']);
    comments.push({
      ...jiraComment('6', 'Bob approves an old head'),
      author: 'Bob',
      state: 'APPROVED',
      commit: 'b'.repeat(40),
      createdAt: '2026-09-20T15:00:00.000Z',
    });
    expect(
      (await history.prepare(prepareRequest(workDir))).brief.unresolvedReviews?.map(
        (review) => review.author,
      ),
    ).toEqual(['Bob']);
  });

  it('treats a comment edited after the last report as new feedback for the next turn', async () => {
    const workDir = await createTempDir();
    let text = 'Please keep the wording.';
    let updatedAt: string | null = null;
    const history = createTicketHistory({
      workDir,
      readers: readers({
        jira: () => ({
          comments: [
            jiraComment('9600', text, {
              createdAt: '2026-09-20T09:00:00.000Z',
              updatedAt,
            }),
          ],
          truncated: false,
        }),
      }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    // A report lands after the comment was first written, and only then does a
    // person edit it: its creation instant is older than every report, which is
    // exactly the case a creation-time cutoff loses.
    await history.recordDeveloperReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      round: 1,
      runId: 'run-20260921-0009',
      reportPath: path.join(workDir, 'runs', 'run-20260921-0009', 'result.json'),
      status: 'passed',
      reason: 'every configured check exited 0',
      repairsUsed: 0,
      attempts: [],
      pullRequest: null,
      deliveryFailure: null,
      now: new Date('2026-09-21T09:15:00.000Z'),
    });
    const first = await history.prepare(prepareRequest(workDir));
    text = 'Please keep the wording, and stop flattening it.';
    updatedAt = '2026-09-21T09:45:00.000Z';
    const second = await history.prepare(prepareRequest(workDir));

    expect(first.brief.newHumanFeedback.map((entry) => entry.sourceId)).toContain('9600');
    expect(second.brief.newHumanFeedback.map((entry) => entry.sourceId)).toContain('9600');
    const edited = second.brief.newHumanFeedback.find((entry) => entry.sourceId === '9600');
    expect(edited?.text).toBe('Please keep the wording, and stop flattening it.');
    expect(edited?.edited).toBe(true);
  });

  it('treats feedback that arrived while the previous turn ran as new, and does not repeat it', async () => {
    const workDir = await createTempDir();
    const comments: ReadComment[] = [];
    const history = createTicketHistory({
      workDir,
      readers: readers({ jira: () => ({ comments, truncated: false }) }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const first = await history.prepare(prepareRequest(workDir));
    expect(first.brief.newHumanFeedback).toEqual([]);

    // The comment is written while the first turn is running: it was absent
    // from that turn's snapshot, and it is older than the report the turn
    // finished with. Time alone cannot tell it apart from history.
    comments.push(
      jiraComment('9700', 'One more thing: keep the local paths stable.', {
        createdAt: '2026-09-21T09:30:00.000Z',
      }),
    );
    await history.recordDeveloperReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      round: 1,
      runId: 'run-20260921-0010',
      reportPath: path.join(workDir, 'runs', 'run-20260921-0010', 'result.json'),
      status: 'passed',
      reason: 'every configured check exited 0',
      repairsUsed: 0,
      attempts: [],
      pullRequest: null,
      deliveryFailure: null,
      now: new Date('2026-09-21T09:45:00.000Z'),
    });
    const second = await history.prepare(prepareRequest(workDir));
    expect(second.brief.newHumanFeedback.map((entry) => entry.sourceId)).toEqual(['9700']);
    await history.consumed?.(second);

    // A restart prepares from the store on disk, and the input the previous
    // turn already held is not handed over as new again.
    const restarted = createTicketHistory({
      workDir,
      readers: readers({ jira: () => ({ comments, truncated: false }) }),
      now: () => new Date('2026-09-21T10:05:00.000Z'),
    });
    const third = await restarted.prepare(prepareRequest(workDir));
    expect(third.brief.newHumanFeedback).toEqual([]);
  });

  it('keeps a comment that quotes a marker, and hands its feedback to the next turn', async () => {
    const workDir = await createTempDir();
    const quoted = [
      'Regarding nexus-history: reviewer review-20260921-0003, please fix B as well.',
      'The marker above is a quotation of the harness record, not a harness record.',
    ].join('\n');
    const history = createTicketHistory({
      workDir,
      harnessAuthors: ['nexus-lens[bot]'],
      readers: readers({
        jira: {
          comments: [jiraComment('9800', quoted, { author: 'Jane Reviewer' })],
          truncated: false,
        },
        pull: pullConversation([
          {
            sourceId: '556',
            author: 'Jane Reviewer',
            createdAt: '2026-09-21T09:00:00.000Z',
            updatedAt: null,
            text: 'Quoting nexus-history: reviewer review-20260921-0003 to ask a question.',
            url: 'https://github.com/example/repo/pull/27#review',
            state: 'COMMENTED',
            commit: HEAD,
          },
        ]),
      }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    await history.recordReviewerReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      reviewId: 'review-20260921-0003',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'One finding.',
      findings: [{ path: 'src/b.ts', line: 2, body: 'Fix B.' }],
      now: new Date('2026-09-21T07:45:00.000Z'),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    // Wording alone never removes another author's message: both the Jira
    // comment and the human review stay, attributed, and their feedback is
    // handed to the next turn.
    expect(snapshot.entries.some((entry) => entry.sourceId === '9800')).toBe(true);
    expect(snapshot.mirrors).toEqual([]);
    const kept = snapshot.brief.newHumanFeedback.find((entry) => entry.sourceId === '9800');
    expect(kept?.role).toBe('human');
    expect(kept?.text).toBe(quoted);
    expect(snapshot.entries.some((entry) => entry.sourceId === '556')).toBe(true);
  });

  it('still recognizes the harness’s own legacy rendering, and preserves an edited one', async () => {
    const workDir = await createTempDir();
    const rendering = [
      'Harness run run-20260921-0011 for HARN-41 finished: passed.',
      'Reason: every configured check exited 0',
      'Checks: 1 of 1 configured checks exited 0',
      'Repairs used: 0',
      'Local artifacts on the machine that ran this harness (local paths, not Jira attachments): run directory /runs/run-20260921-0011; report /runs/run-20260921-0011/result.json',
      'Harness record: nexus-history: developer run-20260921-0011 — the complete developer report is kept beside the workspace.',
    ].join('\n');
    let text = rendering;
    const history = createTicketHistory({
      workDir,
      harnessAuthors: ['Nexus Harness'],
      readers: readers({
        jira: () => ({
          comments: [
            jiraComment('9900', text, { author: 'Nexus Harness' }),
            jiraComment('9902', `${rendering}\nHuman correction: this is still broken.`),
            jiraComment(
              '9901',
              'Harness record: nexus-history: developer run-20260921-0011 — a partial quote.',
              {
                author: 'Jane Reviewer',
              },
            ),
          ],
          truncated: false,
        }),
      }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    await history.recordDeveloperReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      round: 1,
      runId: 'run-20260921-0011',
      reportPath: path.join(workDir, 'runs', 'run-20260921-0011', 'result.json'),
      status: 'passed',
      reason: 'every configured check exited 0',
      repairsUsed: 0,
      attempts: [],
      pullRequest: null,
      deliveryFailure: null,
      now: new Date('2026-09-21T07:30:00.000Z'),
    });
    const first = await history.prepare(prepareRequest(workDir));
    expect(first.mirrors.map((mirror) => mirror.sourceId)).toEqual(['9900']);
    expect(first.entries.some((entry) => entry.sourceId === '9900')).toBe(false);
    // The partial quote is not the harness's rendering: it stays a comment.
    expect(first.entries.some((entry) => entry.sourceId === '9901')).toBe(true);
    expect(first.brief.newHumanFeedback.find((entry) => entry.sourceId === '9902')?.text).toContain(
      'Human correction: this is still broken.',
    );

    // A rendering that was edited after it was first read is preserved as the
    // distinct message it now is.
    text = `${rendering}\nPlease also update the operator guide.`;
    const second = await history.prepare(prepareRequest(workDir));
    expect(second.mirrors.map((mirror) => mirror.sourceId)).toEqual([]);
    const kept = second.entries.find((entry) => entry.sourceId === '9900');
    expect(kept?.text).toBe(text);
  });

  it('never lets an older local approval hide a newer native review that requests changes', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      readers: readers({
        pull: pullConversation([
          {
            sourceId: '800',
            author: 'Jane Reviewer',
            createdAt: '2026-09-21T09:30:00.000Z',
            updatedAt: null,
            text: 'Nexus Lens review — HARN-41\n\nOne blocking finding.',
            url: 'https://github.com/example/repo/pull/27#review-800',
            state: 'CHANGES_REQUESTED',
            commit: HEAD,
          },
          {
            sourceId: '801',
            author: 'Jane Reviewer',
            createdAt: '2026-09-21T09:30:01.000Z',
            updatedAt: null,
            text: 'src/a.ts:3 — Fix the retry loop.',
            body: 'Fix the retry loop.',
            path: 'src/a.ts',
            line: 3,
            reviewId: 800,
            commit: HEAD,
            url: 'https://github.com/example/repo/pull/27#discussion_r801',
          },
        ]),
      }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    await history.recordReviewerReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      reviewId: 'review-20260921-0005',
      round: 1,
      head: HEAD,
      decision: 'approve',
      summary: 'Nothing blocking.',
      findings: [],
      now: new Date('2026-09-21T09:00:00.000Z'),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    const unresolved = snapshot.brief.unresolved;
    expect(unresolved).not.toBeNull();
    expect(unresolved?.entryId).toBe('github:pr-review:800');
    expect(unresolved?.decision).toBe('request_changes');
    expect(unresolved?.complete).toBe(false);
    expect(unresolved?.findings.map((finding) => finding.body)).toEqual(['Fix the retry loop.']);
    expect(snapshot.gaps.join('\n')).toContain('the latest review that requested changes');
  });

  it('keeps a person’s outstanding change request visible after a later harness report', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      readers: readers({
        pull: pullConversation([
          {
            sourceId: '850',
            author: 'Jane Reviewer',
            createdAt: '2026-09-21T09:00:00.000Z',
            updatedAt: null,
            text: 'I reviewed this by hand and it needs one change.',
            url: 'https://github.com/example/repo/pull/27#review-850',
            state: 'CHANGES_REQUESTED',
            commit: HEAD,
          },
          {
            sourceId: '851',
            author: 'Jane Reviewer',
            createdAt: '2026-09-21T09:00:01.000Z',
            updatedAt: null,
            text: 'src/b.ts:8 — This drops the second page.',
            body: 'This drops the second page.',
            path: 'src/b.ts',
            line: 8,
            reviewId: 850,
            commit: HEAD,
            url: 'https://github.com/example/repo/pull/27#discussion_r851',
          },
        ]),
      }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    // The harness's own report came later, but it never answered the human's
    // finding, and nothing approved the change since.
    await history.recordDeveloperReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      round: 1,
      runId: 'run-20260921-0012',
      reportPath: path.join(workDir, 'runs', 'run-20260921-0012', 'result.json'),
      status: 'passed',
      reason: 'every configured check exited 0',
      repairsUsed: 0,
      attempts: [],
      pullRequest: null,
      deliveryFailure: null,
      now: new Date('2026-09-21T09:30:00.000Z'),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    expect(snapshot.brief.unresolved?.entryId).toBe('github:pr-review:850');
    expect(snapshot.brief.unresolved?.findings.map((finding) => finding.body)).toEqual([
      'This drops the second page.',
    ]);
    expect(snapshot.brief.unresolved?.author).toBe('Jane Reviewer');
  });

  it('clears an older local request for changes when a later review approves the head', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      harnessAuthors: ['nexus-lens[bot]'],
      readers: readers({
        pull: pullConversation([
          {
            sourceId: '860',
            author: 'nexus-lens[bot]',
            createdAt: '2026-09-21T09:30:00.000Z',
            updatedAt: null,
            text: 'Nexus Lens review — HARN-41\n\nApproved at this head.',
            url: 'https://github.com/example/repo/pull/27#review-860',
            state: 'APPROVED',
            commit: HEAD,
          },
        ]),
      }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    await history.recordReviewerReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      reviewId: 'review-20260921-0006',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'One finding, since fixed.',
      findings: [{ path: 'src/a.ts', line: 1, body: 'Fix this.' }],
      now: new Date('2026-09-21T09:00:00.000Z'),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    expect(snapshot.brief.unresolved).toBeNull();
    expect(snapshot.entries.some((entry) => entry.sourceId === '860')).toBe(true);
  });

  it('keeps findings after an unpublished approval that did not pass publication guards', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      readers: readers({ pull: pullConversation() }),
    });
    for (const [round, decision] of [
      [1, 'request_changes'],
      [2, 'approve'],
    ] as const) {
      await history.recordReviewerReport?.({
        ref: REF,
        workspaceId: WORKSPACE_ID,
        task: TASK,
        reviewId: `review-unpublished-${String(round)}`,
        round,
        head: HEAD,
        decision,
        summary: decision,
        findings:
          decision === 'approve'
            ? []
            : [{ path: 'src/a.ts', line: 1, body: 'Retain this unresolved finding.' }],
        now: new Date(`2026-09-21T0${String(round)}:00:00.000Z`),
      });
    }
    const snapshot = await history.prepare(prepareRequest(workDir));
    expect(snapshot.brief.unresolved?.findings[0]?.body).toBe('Retain this unresolved finding.');
    expect(snapshot.entries.filter((entry) => entry.kind === 'reviewer-report')).toHaveLength(2);
  });

  it('recovers the complete reviewer report from the reviewer’s retained verdict', async () => {
    const workDir = await createTempDir();
    const reviewDir = path.join(workDir, 'reviews', 'review-legacy-7');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, 'review.json'),
      JSON.stringify({
        version: 1,
        reviewId: 'review-legacy-7',
        ref: REF,
        startedAt: '2026-09-20T08:00:00.000Z',
        endedAt: '2026-09-20T08:10:00.000Z',
        verdict: 'request_changes',
        problem: null,
        pullRequest: { headSha: HEAD, headBranch: `harness/${WORKSPACE_ID}` },
        review: {
          id: 900,
          url: 'https://github.com/example/repo/pull/27#review-900',
          state: 'CHANGES_REQUESTED',
        },
      }),
      'utf8',
    );
    const longBody = `The retry loop drops the second page. ${'detail '.repeat(200)}`.trim();
    await writeFile(
      path.join(reviewDir, 'verdict.json'),
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'One blocking finding.',
        findings: [{ path: 'src/history/sync.ts', line: 12, body: longBody }],
      }),
      'utf8',
    );
    const history = createTicketHistory({
      workDir,
      readers: readers(),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    const entry = snapshot.entries.find((item) => item.sourceId === 'review-legacy-7');
    expect(entry?.kind).toBe('reviewer-report');
    expect(entry?.complete).toBe(true);
    expect(entry?.round).toBe(1);
    expect(entry?.commit).toBe(HEAD);
    expect(entry?.text).toContain(longBody);
    expect(entry?.text).toContain(`Recovered from: ${path.join(reviewDir, 'verdict.json')}`);
    expect(entry?.text).toContain(
      'Publication: https://github.com/example/repo/pull/27#review-900',
    );
    expect(snapshot.entries.some((item) => item.kind === 'missing-report')).toBe(false);
    expect(snapshot.brief.unresolved?.decision).toBe('request_changes');
    expect(snapshot.brief.unresolved?.findings[0]?.body).toBe(longBody);
    expect(snapshot.brief.unresolved?.complete).toBe(true);
  });

  it('recovers an inconclusive verdict as the round it really was, with no review invented', async () => {
    const workDir = await createTempDir();
    const reviewDir = path.join(workDir, 'reviews', 'review-legacy-8');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, 'review.json'),
      JSON.stringify({
        version: 1,
        reviewId: 'review-legacy-8',
        ref: REF,
        startedAt: '2026-09-20T08:00:00.000Z',
        endedAt: '2026-09-20T08:10:00.000Z',
        verdict: null,
        problem: 'review inconclusive: the repository view was missing',
        pullRequest: { headSha: HEAD, headBranch: `harness/${WORKSPACE_ID}` },
        review: null,
      }),
      'utf8',
    );
    await writeFile(
      path.join(reviewDir, 'verdict.json'),
      JSON.stringify({
        verdict: 'inconclusive',
        summary: 'The repository view was missing, so nothing could be reviewed.',
        findings: [],
      }),
      'utf8',
    );
    const history = createTicketHistory({
      workDir,
      readers: readers(),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    const entry = snapshot.entries.find((item) => item.sourceId === 'review-legacy-8');
    expect(entry?.kind).toBe('reviewer-report');
    expect(entry?.complete).toBe(true);
    expect(entry?.text).toContain('The repository view was missing');
    expect(entry?.text).toContain('Publication: this review published no native review');
    // An inconclusive verdict decides nothing, so no unresolved finding is
    // fabricated from it, and no native review was published for it.
    expect(snapshot.brief.unresolved).toBeNull();
    expect(snapshot.mirrors).toEqual([]);
  });

  it('marks a retained verdict that cannot be read as missing, naming the file', async () => {
    const workDir = await createTempDir();
    const reviewDir = path.join(workDir, 'reviews', 'review-broken-1');
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, 'review.json'),
      JSON.stringify({
        version: 1,
        reviewId: 'review-broken-1',
        ref: REF,
        startedAt: '2026-09-20T08:00:00.000Z',
        verdict: 'request_changes',
        problem: null,
      }),
      'utf8',
    );
    await writeFile(
      path.join(reviewDir, 'verdict.json'),
      JSON.stringify({ verdict: 'request_changes', summary: 'x', findings: 'not a list' }),
      'utf8',
    );
    const history = createTicketHistory({
      workDir,
      readers: readers(),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    const entry = snapshot.entries.find((item) => item.sourceId === 'review-broken-1');
    expect(entry?.kind).toBe('missing-report');
    expect(entry?.complete).toBe(false);
    expect(entry?.problem).toContain('findings');
    expect(snapshot.gaps.join('\n')).toContain(path.join(reviewDir, 'verdict.json'));
  });

  it('marks a legacy run report it cannot read back as the conversation it claims to be', async () => {
    const workDir = await createTempDir();
    const runDir = path.join(workDir, 'runs', 'run-legacy-3');
    const reportPath = path.join(runDir, 'result.json');
    await mkdir(runDir, { recursive: true });
    await writeFile(reportPath, '{ this is not JSON', 'utf8');
    const state: WorkspaceState = {
      version: 1,
      workspaceId: WORKSPACE_ID,
      sourceRoot: path.join(workDir, 'source'),
      baseCommit: HEAD,
      branch: `harness/${WORKSPACE_ID}`,
      createdAt: '2026-09-20T08:00:00.000Z',
      sourceItem: { type: REF.type, scope: REF.scope, id: REF.id, key: REF.key },
      attempts: [
        {
          runId: 'run-legacy-3',
          outcome: 'failed',
          reason: 'the checks failed',
          endedAt: '2026-09-20T09:00:00.000Z',
          reportPath,
        },
      ],
    };
    await mkdir(path.dirname(workspaceStatePath(workDir, WORKSPACE_ID)), { recursive: true });
    await writeFile(workspaceStatePath(workDir, WORKSPACE_ID), JSON.stringify(state), 'utf8');
    const history = createTicketHistory({
      workDir,
      readers: readers(),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    const entry = snapshot.entries.find((item) => item.sourceId === 'run-legacy-3');
    expect(entry?.kind).toBe('developer-report');
    expect(entry?.complete).toBe(false);
    expect(entry?.problem).toContain('not valid JSON');
    expect(entry?.text).toContain('INCOMPLETE');
    expect(snapshot.gaps.join('\n')).toContain('run-legacy-3');
    // The run's own status is still recorded; the conversation that is missing
    // is named rather than invented.
    expect(entry?.text).toContain('the checks failed');
  });

  it('marks a legacy run report without its coding turns as incomplete', async () => {
    const workDir = await createTempDir();
    const runDir = path.join(workDir, 'runs', 'run-legacy-4');
    const reportPath = path.join(runDir, 'result.json');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({
        runId: 'run-legacy-4',
        status: 'passed',
        reason: 'every configured check exited 0',
        endedAt: '2026-09-20T11:00:00.000Z',
      }),
      'utf8',
    );
    const state: WorkspaceState = {
      version: 1,
      workspaceId: WORKSPACE_ID,
      sourceRoot: path.join(workDir, 'source'),
      baseCommit: HEAD,
      branch: `harness/${WORKSPACE_ID}`,
      createdAt: '2026-09-20T10:00:00.000Z',
      sourceItem: { type: REF.type, scope: REF.scope, id: REF.id, key: REF.key },
      attempts: [
        {
          runId: 'run-legacy-4',
          outcome: 'passed',
          reason: 'the checks passed',
          endedAt: '2026-09-20T11:00:00.000Z',
          reportPath,
        },
      ],
    };
    await mkdir(path.dirname(workspaceStatePath(workDir, WORKSPACE_ID)), { recursive: true });
    await writeFile(workspaceStatePath(workDir, WORKSPACE_ID), JSON.stringify(state), 'utf8');
    const history = createTicketHistory({
      workDir,
      readers: readers(),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    const entry = snapshot.entries.find((item) => item.sourceId === 'run-legacy-4');
    expect(entry?.kind).toBe('developer-report');
    expect(entry?.complete).toBe(false);
    expect(entry?.problem).toContain('no list of coding turns');
    expect(snapshot.gaps.join('\n')).toContain('no list of coding turns');
    const rendered = renderHistorySection(snapshot, 'developer');
    expect(rendered).toContain('### Incomplete input (read before starting)');
    expect(rendered).toContain('no list of coding turns');
  });

  it('keeps the inline findings of a published review out of the conversation twice', async () => {
    const workDir = await createTempDir();
    const body = [
      'Nexus Lens review — HARN-41: history',
      '',
      'Two findings.',
      '',
      'See the inline findings on this review.',
      '',
      `Harness record: nexus-history: reviewer review-20260921-0004 — the complete reviewer report is kept locally.`,
    ].join('\n');
    const history = createTicketHistory({
      workDir,
      harnessAuthors: ['nexus-lens[bot]'],
      readers: readers({
        pull: pullConversation([
          {
            sourceId: '600',
            author: 'nexus-lens[bot]',
            createdAt: '2026-09-21T08:00:00.000Z',
            updatedAt: null,
            text: body,
            url: 'https://github.com/example/repo/pull/27#review-600',
            state: 'CHANGES_REQUESTED',
            commit: HEAD,
          },
          {
            sourceId: '700',
            author: 'nexus-lens[bot]',
            createdAt: '2026-09-21T08:00:01.000Z',
            updatedAt: null,
            text: 'src/a.ts:4 — Fix A.',
            body: 'Fix A.',
            path: 'src/a.ts',
            line: 4,
            reviewId: 600,
            url: 'https://github.com/example/repo/pull/27#discussion_r700',
            commit: HEAD,
          },
          {
            sourceId: '701',
            author: 'Jane Reviewer',
            createdAt: '2026-09-21T08:10:00.000Z',
            updatedAt: null,
            text: 'src/a.ts:4 — Is A really broken?',
            body: 'Is A really broken?',
            path: 'src/a.ts',
            line: 4,
            reviewId: 600,
            inReplyToId: 700,
            url: 'https://github.com/example/repo/pull/27#discussion_r701',
            commit: HEAD,
          },
        ]),
      }),
      now: () => new Date('2026-09-21T10:00:00.000Z'),
    });
    await history.recordReviewerReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      reviewId: 'review-20260921-0004',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'Two findings.',
      findings: [
        { path: 'src/a.ts', line: 4, body: 'Fix A.' },
        { path: 'src/b.ts', line: null, body: 'Fix B.' },
      ],
      now: new Date('2026-09-21T07:59:00.000Z'),
    });
    await notePublishedReview(workspaceHistoryRoot(workDir, WORKSPACE_ID), 'review-20260921-0004', {
      id: 600,
      url: 'https://github.com/example/repo/pull/27#review-600',
      body,
    });
    const snapshot = await history.prepare(prepareRequest(workDir));

    // The published review and the inline finding it posted are the rendering
    // of the retained report; the reply is a person's own conversation.
    expect(snapshot.mirrors.map((mirror) => mirror.sourceId).sort()).toEqual(['600', '700']);
    expect(snapshot.entries.some((entry) => entry.sourceId === '700')).toBe(false);
    const reply = snapshot.entries.find((entry) => entry.sourceId === '701');
    expect(reply?.text).toBe('src/a.ts:4 — Is A really broken?');
    expect(snapshot.brief.unresolved?.complete).toBe(true);
    expect(snapshot.brief.unresolved?.findings).toHaveLength(2);
    expect(snapshot.brief.responses.some((entry) => entry.sourceId === '701')).toBe(true);
  });
});

describe('review follow-up retention regressions', () => {
  it('bounds consumed responses to an outstanding review in both prompts, with whole local overflow', async () => {
    const workDir = await createTempDir();
    const comments = Array.from({ length: 400 }, (_, i) =>
      jiraComment(String(i), `Comment ${String(i)}: ${'discussion '.repeat(900)}END-${String(i)}`),
    );
    const history = createTicketHistory({
      workDir,
      readers: readers({ jira: { comments, truncated: false } }),
    });
    await history.recordReviewerReport?.({
      ref: REF,
      workspaceId: WORKSPACE_ID,
      task: TASK,
      reviewId: 'long-discussion',
      round: 1,
      head: HEAD,
      decision: 'request_changes',
      summary: 'Outstanding request',
      findings: [{ path: 'a.ts', line: 1, body: 'Fix the original defect.' }],
      now: new Date('2026-09-19T10:00:00Z'),
    });
    for (const role of ['developer', 'reviewer'] as const) {
      await history.consumed?.(await history.prepare(prepareRequest(workDir, role)));
      const snapshot = await history.prepare(prepareRequest(workDir, role));
      expect(snapshot.brief.newHumanFeedback).toHaveLength(0);
      expect(snapshot.brief.responses).toHaveLength(400);
      const prompt = renderHistorySection(snapshot, role);
      expect(prompt.length).toBeLessThan(70_000);
      expect(prompt).toContain('Fix the original defect.');
      expect(prompt).toContain('REQUIRED: read the complete entries in brief.responses');
      expect(prompt).toContain(snapshot.indexJsonPath);
      const index = JSON.parse(await readFile(snapshot.indexJsonPath, 'utf8')) as {
        brief: { responses: { text: string }[] };
      };
      expect(index.brief.responses).toHaveLength(400);
      expect(index.brief.responses.some((entry) => entry.text === comments[0]?.text)).toBe(true);
    }
  });

  it.each(['digest', 'legacy'])(
    'marks previously truncated developer reports incomplete (%s)',
    async (kind) => {
      const workDir = await createTempDir();
      const history = createTicketHistory({ workDir, readers: readers() });
      const reportPath = path.join(workDir, 'result.json');
      const agentSummary = `${'x'.repeat(2000)} [truncated: this turn's log holds the full message]`;
      const attempts = [{ turn: 1, kind: 'implementation', agentSummary, checks: null }];
      await writeFile(reportPath, JSON.stringify({ status: 'passed', attempts }), 'utf8');
      if (kind === 'digest') {
        await history.recordDeveloperReport?.({
          ref: REF,
          workspaceId: WORKSPACE_ID,
          task: TASK,
          runId: 'old-truncated',
          round: 1,
          reportPath,
          status: 'passed',
          reason: 'checks passed',
          repairsUsed: 0,
          attempts,
          pullRequest: null,
          deliveryFailure: null,
          now: new Date(),
        });
      } else {
        await mkdir(path.dirname(workspaceStatePath(workDir, WORKSPACE_ID)), { recursive: true });
        await writeFile(
          workspaceStatePath(workDir, WORKSPACE_ID),
          JSON.stringify({
            version: 1,
            workspaceId: WORKSPACE_ID,
            sourceRoot: workDir,
            baseCommit: HEAD,
            branch: `harness/${WORKSPACE_ID}`,
            createdAt: REF.updatedAt,
            sourceItem: null,
            attempts: [
              { runId: 'old-truncated', outcome: 'passed', endedAt: REF.updatedAt, reportPath },
            ],
          }),
        );
      }
      const snapshot = await history.prepare(prepareRequest(workDir));
      expect(snapshot.entries.find((entry) => entry.sourceId === 'old-truncated')?.complete).toBe(
        false,
      );
      expect(snapshot.gaps.join('\n')).toContain('truncated before retention');
    },
  );

  it('records the actual baseline publication identity and preserves later edits', async () => {
    const workDir = await createTempDir();
    let published = '';
    const diagnosis = createBaselineDiagnosis({
      workDir,
      project: 'project',
      readyStatus: 'Ready',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 5000,
      io: { out: () => undefined, err: () => undefined },
      record: {
        listComments: async () => [],
        isRunning: async () => true,
        moveFromRunning: async () => 'moved',
        postComment: async (_id, paragraphs) => {
          published = paragraphs.join('\n');
          return 'baseline-publication';
        },
      },
      reviewer: async (asked) => {
        const finding = {
          outcome: 'repair' as const,
          failingCheck: 'test',
          evidence: 'failure',
          likelyCause: 'bug',
          repairGuidance: 'fix it',
        };
        await writeFile(
          path.join(asked.dir, 'outcome.json'),
          JSON.stringify({ version: 1, state: 'finding', finding }),
        );
        return {
          summary: 'Diagnosis retained',
          finding,
          problem: null,
          logPath: 'unused.log',
          shutdown: null,
        };
      },
    });
    const result = await diagnosis.diagnose({
      item: { ref: REF, task: TASK },
      workspace: prepareRequest(workDir).workspace,
      baseline: { outcome: 'failed', setup: [], checks: [], problem: null },
      stop: new AbortController().signal,
    });
    expect(result.kind).toBe('repair');
    const history = createTicketHistory({
      workDir,
      readers: readers({
        jira: () => ({
          comments: [jiraComment('baseline-publication', published, { author: 'Harness' })],
          truncated: false,
        }),
      }),
    });
    const first = await history.prepare(prepareRequest(workDir));
    expect(first.mirrors).toHaveLength(1);
    expect(first.entries).toHaveLength(1);
    published += '\nAdditional operator instructions';
    const edited = await history.prepare(prepareRequest(workDir, 'reviewer'));
    expect(edited.mirrors).toHaveLength(0);
    expect(edited.entries.some((entry) => entry.text === published)).toBe(true);
    expect(await readFile(first.entriesPath, 'utf8')).not.toContain(
      'Additional operator instructions',
    );
  });

  it.each(['accepted', 'missing', 'malformed', 'rejected'])(
    'includes baseline reviewer history after restart (%s)',
    async (state) => {
      const workDir = await createTempDir();
      const baseline = { outcome: 'failed' as const, setup: [], checks: [], problem: null };
      const evidenceId = baselineEvidenceId(REF, HEAD, baseline);
      const dir = path.join(workDir, 'baseline', 'project', evidenceId);
      await mkdir(dir, { recursive: true });
      const mirrorText = 'Concise published baseline diagnosis';
      const evidence: BaselineEvidence = {
        version: 1,
        evidenceId,
        project: 'project',
        ref: REF,
        task: TASK,
        workspace: {
          workspaceId: WORKSPACE_ID,
          workspacePath: '/workspace',
          branch: `harness/${WORKSPACE_ID}`,
          baseCommit: HEAD,
        },
        baseline,
        closed: 'repair',
        closedAt: REF.updatedAt,
        publication: { commentId: 'baseline-comment', textSha256: textSha256(mirrorText) },
      };
      await writeFile(path.join(dir, 'evidence.json'), JSON.stringify(evidence));
      const finding = {
        outcome: 'repair',
        failingCheck: 'npm test',
        evidence: 'Observed failure',
        likelyCause: 'A regression',
        repairGuidance: `${'Full repair details. '.repeat(60)}Required final fix.`,
      };
      const outcome =
        state === 'rejected'
          ? {
              version: 1,
              state: 'rejected',
              problem: 'shutdown unconfirmed',
              shutdown: { termination: 'unconfirmed', problem: 'child remains' },
            }
          : { version: 1, state: 'finding', finding };
      if (state !== 'missing')
        await writeFile(
          path.join(dir, 'outcome.json'),
          state === 'malformed' ? '{broken' : JSON.stringify(outcome),
        );
      // An unaccepted finding file must never substitute for the retained outcome.
      await writeFile(path.join(dir, 'finding.json'), JSON.stringify(finding));
      const remote = readers({
        jira: {
          comments: [jiraComment('baseline-comment', mirrorText, { author: 'Harness' })],
          truncated: false,
        },
      });
      for (const role of ['developer', 'reviewer'] as const) {
        const history = createTicketHistory({ workDir, readers: remote });
        const snapshot = await history.prepare(prepareRequest(workDir, role));
        const entry = snapshot.entries.find(
          (entry) => entry.sourceId === `baseline-project-${evidenceId}`,
        );
        expect(entry?.role).toBe('reviewer');
        if (state === 'accepted' || state === 'rejected') {
          expect(entry?.complete).toBe(true);
          expect(entry?.commit).toBe(HEAD);
          expect(entry?.text).toContain(JSON.stringify(outcome));
          expect(snapshot.mirrors).toHaveLength(1);
          if (state === 'accepted')
            expect(renderHistorySection(snapshot, role)).toContain(finding.repairGuidance);
          else expect(renderHistorySection(snapshot, role)).not.toContain(finding.repairGuidance);
        } else {
          expect(entry?.kind).toBe('missing-report');
          expect(snapshot.gaps.join('\n')).toContain('outcome.json');
          expect(renderHistorySection(snapshot, role)).not.toContain(finding.repairGuidance);
        }
      }
    },
  );
});
