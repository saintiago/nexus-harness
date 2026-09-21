/** Coordinator history policy with injected runner/delivery/source; no subprocesses or network. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeveloperReportDigest } from '../src/history/reports.js';
import { textSha256 } from '../src/history/reports.js';
import { workspaceHistoryRoot } from '../src/history/paths.js';
import { createTicketHistory } from '../src/history/sync.js';
import { summarizeChanges } from '../src/reporting/changes.js';
import { writeRunReport } from '../src/reporting/report.js';
import type { RunTaskResult } from '../src/runs/contracts.js';
import type { SourceContext, SourceTask, TaskSource } from '../src/sources/contract.js';
import { runSource } from '../src/sources/coordinator.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirectories();
});

async function sourceHistoryFixture() {
  const workDir = await createTempDir();
  const item: SourceTask = {
    ref: {
      type: 'jira',
      scope: 'offline',
      id: '1',
      key: 'TEST-1',
      url: 'https://example.test/1',
      updatedAt: '2026-09-21T10:00:00Z',
    },
    task: {
      id: 'TEST-1',
      title: 'History',
      description: 'Retain reports',
      acceptanceCriteria: ['Complete history'],
    },
    pointers: [],
  };
  const candidate = { ref: item.ref, title: item.task.title };
  const message = 'Complete developer explanation\n'.repeat(1_000) + 'END-DEVELOPER';
  const published = { commentId: 'comment-1', text: 'Concise external rendering' };
  const complete = vi.fn<TaskSource['complete']>().mockResolvedValue(published);
  const progress = vi.fn<TaskSource['progress']>().mockResolvedValue(published);
  const source: TaskSource = {
    listEligible: async () => [candidate],
    prepare: async () => item,
    claim: async () => true,
    complete,
    progress,
    recordWorkspace: async () => undefined,
    refuse: async () => undefined,
    attention: async () => undefined,
    commentsSince: async () => [],
  };
  const history = createTicketHistory({
    workDir,
    readers: {
      jiraThread: async () => ({ comments: [], truncated: false }),
      pullRequestConversation: async () => null,
    },
  });
  const events: string[] = [];
  const record = history.recordDeveloperReport!;
  vi.spyOn(history, 'recordDeveloperReport').mockImplementation(async (asked) => {
    const saved = await record(asked);
    events.push('saved');
    return saved;
  });
  const head = 'c'.repeat(40);
  const agent = { runtime: 'codex' as const, command: ['unused'] };
  const baseCommit = 'a'.repeat(40);
  const run = await allocateRunDirectory(workDir);
  const workspace = {
    ...run,
    sourceRoot: workDir,
    baseCommit,
    branch: `harness/${run.workspaceId}`,
    continued: false,
    attempt: 1,
  };
  const checks = { outcome: 'passed' as const, setup: [], checks: [], problem: null };
  const result: RunTaskResult = {
    run,
    workspace,
    status: 'passed',
    reason: 'configured checks passed',
    baseline: checks,
    attempts: [
      { turn: 1, kind: 'implementation', agentLog: 'unused.log', agentSummary: message, checks },
    ],
    repairsUsed: 0,
    timeout: null,
    cancellation: null,
    changes: summarizeChanges({ baseCommit, paths: [] }),
    workspaceLedgerProblem: null,
    reportPath: path.join(run.runDir, 'result.json'),
  };
  await writeRunReport({
    ...result,
    task: item.task,
    agent,
    source: { sourceRoot: workDir, baseCommit },
    preparationProblem: null,
    startedAt: '2026-09-21T10:00:00Z',
    endedAt: '2026-09-21T10:01:00Z',
  });
  const root = workspaceHistoryRoot(workDir, run.workspaceId);
  const digestPath = path.join(root, 'reports', `developer-${run.runId}.json`);
  const readDigest = async () =>
    JSON.parse(await readFile(digestPath, 'utf8')) as DeveloperReportDigest;
  const context: SourceContext = {
    source,
    workDir,
    lockNamespace: 'history-policy',
    tiers: [{ name: 'default', agent, maxRepairs: 0 }],
    repoPath: path.join(workDir, 'unused-source'),
    io: { out: () => undefined, err: () => undefined },
    stop: new AbortController().signal,
    preflight: async () => ({ sourceRoot: workDir, baseCommit }),
    run: async (asked) => {
      await asked.onWorkspaceReady?.({ workspaceId: run.workspaceId });
      return result;
    },
    delivery: {
      deliver: async () => ({
        number: 9,
        url: 'https://github.com/example/repo/pull/9',
        head,
        created: true,
      }),
    },
    history,
    now: () => new Date('2026-09-21T10:01:00Z'),
    sleep: async () => undefined,
  };
  return {
    context,
    item,
    history,
    root,
    result,
    message,
    events,
    head,
    complete,
    progress,
    published,
    readDigest,
  };
}

describe('developer report publication policy', () => {
  it('saves the complete report before publication and retains the delivered commit and acknowledged mirror', async () => {
    const fixture = await sourceHistoryFixture();
    fixture.complete.mockImplementation(async () => {
      expect(fixture.events).toEqual(['saved']);
      const digest = await fixture.readDigest();
      expect(digest.published).toBeNull();
      expect(digest.pullRequest?.head).toBe(fixture.head);
      expect(digest.attempts[0]?.agentSummary).toBe(fixture.message);
      expect(await readFile(path.join(fixture.root, 'reports', digest.textFile), 'utf8')).toContain(
        fixture.message,
      );
      expect(
        await readFile(path.join(fixture.root, 'reports', digest.recordFile ?? ''), 'utf8'),
      ).toBe(await readFile(fixture.result.reportPath, 'utf8'));
      fixture.events.push('published');
      return fixture.published;
    });
    const summary = await runSource(fixture.context, null);
    expect(summary).toMatchObject({ outcome: 'completed', passed: 1, problem: null });
    expect(fixture.events).toEqual(['saved', 'published']);
    const digest = await fixture.readDigest();
    expect(digest.published).toMatchObject({
      commentId: fixture.published.commentId,
      textSha256: textSha256(fixture.published.text),
    });
    const snapshot = await fixture.history.prepare({
      ref: fixture.item.ref,
      task: fixture.item.task,
      workspace: fixture.result.workspace!,
      role: 'developer',
      round: 2,
      stop: fixture.context.stop,
    });
    expect(snapshot.entries.find((entry) => entry.kind === 'developer-report')?.commit).toBe(
      fixture.head,
    );
    expect(snapshot.brief.latestDelivery?.head).toBe(fixture.head);
    expect(await readFile(snapshot.indexPath, 'utf8')).toContain(`commit ${fixture.head}`);
  });

  it('publishes no result rendering when retaining its full report fails', async () => {
    const fixture = await sourceHistoryFixture();
    vi.spyOn(fixture.history, 'recordDeveloperReport').mockRejectedValue(
      new Error('history disk unavailable'),
    );
    const summary = await runSource(fixture.context, null);
    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('history disk unavailable');
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.progress).not.toHaveBeenCalled();
    expect(await readFile(fixture.result.reportPath, 'utf8')).toContain('END-DEVELOPER');
  });
});
