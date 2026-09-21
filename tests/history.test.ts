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

describe('the ticket conversation snapshot', () => {
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
      expect(prompt).toContain('### New human feedback since the last harness report');
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

  it('does not add a second entry for a local report mirrored back through Jira or GitHub', async () => {
    const workDir = await createTempDir();
    const history = createTicketHistory({
      workDir,
      readers: readers({
        jira: {
          comments: [
            jiraComment(
              '9300',
              [
                'Harness run run-20260921-0001 for HARN-41 finished: passed.',
                'Harness record: nexus-history: developer run-20260921-0001 — the complete developer report is kept beside the workspace.',
              ].join('\n'),
              { author: 'Nexus Agent' },
            ),
          ],
          truncated: false,
        },
        pull: pullConversation([
          {
            sourceId: '555',
            author: 'nexus-lens[bot]',
            createdAt: '2026-09-21T08:00:00.000Z',
            updatedAt: null,
            text: 'Nexus Lens review — HARN-41\n\nHarness record: nexus-history: reviewer review-20260921-0003 — complete report kept locally.',
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
});
