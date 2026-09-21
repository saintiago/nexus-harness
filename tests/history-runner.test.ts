/** Offline runner policy tests: no Git, check process, or coding runtime is launched. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTicketHistory } from '../src/history/sync.js';
import type { HistoryReaders } from '../src/history/contract.js';
import { promptFor } from '../src/agents/codex/prompt.js';
import { guidanceFrom } from '../src/sources/guidance.js';
import { BASELINE_GUIDANCE_PREFIX } from '../src/runs/contracts.js';
import { runTask } from '../src/runs/runner.js';
import type { RunnerDependencies, RunTaskRequest } from '../src/runs/contracts.js';
import { HistoryError } from '../src/history/contract.js';
import { writeRunReport } from '../src/reporting/report.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import * as changes from '../src/workspace/changes.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupTempDirectories();
});

/** Real history/report files, with all process boundaries replaced by ordinary functions. */
async function historyRunner(
  jiraThread: HistoryReaders['jiraThread'] = async () => ({ comments: [], truncated: false }),
) {
  const workDir = await createTempDir();
  const history = createTicketHistory({
    workDir,
    readers: {
      jiraThread,
      pullRequestConversation: async () => null,
    },
  });
  const checks = vi.fn<RunnerDependencies['runCheckRound']>().mockResolvedValue({
    outcome: 'passed',
    setup: [],
    checks: [],
    problem: null,
  });
  const agent = vi.fn<RunnerDependencies['runAgentTurn']>().mockResolvedValue({
    summary: 'Complete developer report',
    shutdown: null,
  });
  vi.spyOn(changes, 'inspectWorkspaceChanges').mockResolvedValue([]);
  const dependencies: RunnerDependencies = {
    preflight: async () => ({ sourceRoot: workDir, baseCommit: 'a'.repeat(40) }),
    allocateRunDirectory,
    prepareWorkspace: async (run, source) => ({
      ...run,
      ...source,
      branch: 'harness/test',
      continued: false,
      attempt: 1,
    }),
    configureWorkspaceIdentity: async () => undefined,
    returnToRecordedBranch: async () => ({ changed: false }),
    recordWorkspaceAttempt: async () => undefined,
    runCheckRound: checks,
    runAgentTurn: agent,
    openAgentLog: async () => ({
      path: 'unused.log',
      write: () => undefined,
      close: async () => undefined,
    }),
    appendRunLog: async () => undefined,
    writeRunReport,
    now: () => new Date('2026-09-21T10:00:00Z'),
  };
  const request: RunTaskRequest = {
    task: { id: 'test', title: 'test', description: 'test', acceptanceCriteria: ['test'] },
    sourceRef: {
      type: 'jira',
      scope: 'offline',
      id: '1',
      key: 'TEST-1',
      url: 'https://example.test/1',
      updatedAt: '2026-09-21T10:00:00Z',
    },
    config: {
      workDir,
      setup: [],
      checks: [['unused']],
      maxRepairs: 1,
      taskTimeoutMinutes: 1,
      commandTimeoutMinutes: 1,
      agent: { runtime: 'codex', command: ['unused'] },
    },
    repoPath: path.join(workDir, 'unused-source'),
    workDir,
    stop: new AbortController().signal,
    history,
  };
  return { request, dependencies, history, agent, checks };
}

describe('developer history turn policy without subprocesses', () => {
  it('uses refreshed conversation guidance across an edit and multiple repairs, retaining the validated baseline requirement', async () => {
    const original = 'Use the old pagination rule.';
    const correction = 'Correction: follow every page and preserve edited comments.';
    let comment = {
      sourceId: 'comment-1',
      author: 'Human reviewer',
      createdAt: '2026-09-21T09:00:00Z',
      updatedAt: '2026-09-21T09:00:00Z',
      text: original,
      url: 'https://example.test/1?focusedCommentId=comment-1',
    };
    const fixture = await historyRunner(async () => ({ comments: [comment], truncated: false }));
    const baseline = `${BASELINE_GUIDANCE_PREFIX}repair the accepted baseline failure first`;
    // Like intake, collect legacy excerpts once before any turn starts.
    const guidance = guidanceFrom([], [comment], [baseline]);
    fixture.checks
      .mockResolvedValueOnce({ outcome: 'passed', setup: [], checks: [], problem: null })
      .mockResolvedValueOnce({ outcome: 'failed', setup: [], checks: [], problem: 'repair one' })
      .mockResolvedValueOnce({ outcome: 'failed', setup: [], checks: [], problem: 'repair two' });
    fixture.agent.mockImplementation(async (asked) => {
      const prompt = promptFor(asked);
      expect(asked.guidance).toEqual([baseline]);
      expect(prompt).toContain('## Repair the baseline before the task');
      expect(prompt).toContain(baseline);
      expect(prompt).not.toContain('## Guidance for this attempt');
      expect(asked.history?.brief.unresolved).toBeNull();
      if (asked.turn === 1) {
        expect(prompt).toContain(original);
        comment = { ...comment, text: correction, updatedAt: '2026-09-21T10:01:00Z' };
      } else {
        expect(asked.kind).toBe('repair');
        expect(prompt).not.toContain(original);
        expect(
          asked.history?.entries.find((entry) => entry.sourceId === comment.sourceId)?.text,
        ).toBe(correction);
        if (asked.turn === 2) {
          expect(prompt).toContain(correction);
          expect(asked.history?.brief.newHumanFeedback.map((entry) => entry.text)).toEqual([
            correction,
          ]);
        } else {
          // The previous repair consumed the correction. No obsolete excerpt
          // may reappear now that the corrected entry is local history only.
          expect(asked.history?.brief.newHumanFeedback).toEqual([]);
          expect(prompt).not.toContain(correction);
          expect(await readFile(asked.history?.entriesPath ?? '', 'utf8')).toContain(correction);
        }
      }
      return { summary: `Turn ${String(asked.turn)} completed`, shutdown: null };
    });
    const result = await runTask(
      { ...fixture.request, guidance, config: { ...fixture.request.config, maxRepairs: 2 } },
      fixture.dependencies,
    );
    expect(result.status, result.reason).toBe('passed');
    expect(fixture.agent).toHaveBeenCalledTimes(3);
    const first = fixture.agent.mock.calls[0]?.[0].history;
    expect(await readFile(first?.entriesPath ?? '', 'utf8')).toContain(original);
    expect(await readFile(first?.entriesPath ?? '', 'utf8')).not.toContain(correction);
  });

  it('keeps legacy conversation guidance when no history snapshot is configured', async () => {
    const fixture = await historyRunner();
    const request = { ...fixture.request };
    delete request.history;
    const baseline = `${BASELINE_GUIDANCE_PREFIX}repair the accepted baseline failure first`;
    const guidance = guidanceFrom(
      [],
      [{ author: 'Human reviewer', createdAt: '2026-09-21T09:00:00Z', text: 'Legacy feedback' }],
      [baseline],
    );
    const result = await runTask({ ...request, guidance }, fixture.dependencies);
    expect(result.status).toBe('passed');
    const asked = fixture.agent.mock.calls[0]?.[0];
    expect(asked?.guidance).toEqual(guidance);
    expect(asked?.history).toBeUndefined();
    if (asked === undefined) throw new Error('No coding turn');
    expect(promptFor(asked)).toContain('Legacy feedback');
    expect(promptFor(asked)).toContain(baseline);
  });

  it('prepares readable immutable input before the coding turn and acknowledges that exact input', async () => {
    const fixture = await historyRunner();
    const prepare = vi.spyOn(fixture.history, 'prepare');
    const consumed = vi.spyOn(fixture.history, 'consumed');
    fixture.agent.mockImplementation(async (asked) => {
      expect(prepare).toHaveBeenCalledOnce();
      expect(consumed).not.toHaveBeenCalled();
      expect(asked.history?.role).toBe('developer');
      expect(await readFile(asked.history?.indexPath ?? '', 'utf8')).toContain(asked.history?.id);
      expect(await readFile(asked.history?.entriesPath ?? '', 'utf8')).toBe('');
      return { summary: 'Done', shutdown: null };
    });
    const result = await runTask(fixture.request, fixture.dependencies);
    expect(result.status).toBe('passed');
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      role: 'developer',
      round: 1,
      ref: fixture.request.sourceRef,
      workspace: { workspaceId: result.workspace?.workspaceId },
    });
    expect(consumed).toHaveBeenCalledWith(fixture.agent.mock.calls[0]?.[0].history);
  });

  it('starts no coding turn when required local input cannot be prepared and retains the reason', async () => {
    const fixture = await historyRunner();
    vi.spyOn(fixture.history, 'prepare').mockRejectedValue(
      new HistoryError('essential', 'the history directory could not be written'),
    );
    const consumed = vi.spyOn(fixture.history, 'consumed');
    const result = await runTask(fixture.request, fixture.dependencies);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('local conversation history could not be prepared');
    expect(result.reason).toContain('the history directory could not be written');
    expect(result.attempts).toEqual([]);
    expect(fixture.agent).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
    expect(fixture.checks).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(result.reportPath, 'utf8'))).toMatchObject({
      reason: result.reason,
    });
  });

  it('retains the entire previous message before preparing a repair and preserves the repair input', async () => {
    const fixture = await historyRunner();
    const summary = 'Full implementation details\n'.repeat(1_000) + 'END-REPORT';
    fixture.checks
      .mockResolvedValueOnce({ outcome: 'passed', setup: [], checks: [], problem: null })
      .mockResolvedValueOnce({
        outcome: 'failed',
        setup: [],
        checks: [],
        problem: 'repair needed',
      });
    fixture.agent.mockResolvedValueOnce({ summary, shutdown: null });
    fixture.agent.mockImplementationOnce(async (asked) => {
      expect(asked.kind).toBe('repair');
      expect(
        asked.history?.entries.find((entry) => entry.kind === 'developer-report')?.text,
      ).toContain(summary);
      expect(asked.history?.reports[0]?.status).toBe('in-progress');
      expect(await readFile(asked.history?.entriesPath ?? '', 'utf8')).toContain('END-REPORT');
      return { summary: 'Repair completed.', shutdown: null };
    });
    const result = await runTask(fixture.request, fixture.dependencies);
    expect(result.status).toBe('passed');
    expect(fixture.agent).toHaveBeenCalledTimes(2);
    const repair = fixture.agent.mock.calls[1]?.[0].history;
    expect(
      JSON.parse(await readFile(path.join(repair?.root ?? '', 'consumed-developer.json'), 'utf8')),
    ).toMatchObject({ snapshotId: repair?.id });
    expect(existsSync(path.join(repair?.root ?? '', 'consumed-reviewer.json'))).toBe(false);
    expect(await readFile(repair?.entriesPath ?? '', 'utf8')).not.toContain('Repair completed.');
    expect(result.attempts[0]?.agentSummary).toBe(summary);
  });
});

describe('developer report persistence and shutdown evidence', () => {
  it.each(['cancelled', 'timeout', 'runtime-only'] as const)(
    'keeps an unconfirmed %s stop when report retention also fails',
    async (ending) => {
      const workDir = await createTempDir();
      const caller = new AbortController();
      const inspect = vi
        .spyOn(changes, 'inspectWorkspaceChanges')
        .mockRejectedValue(new Error('must not inspect'));
      const history = createTicketHistory({
        workDir,
        readers: {
          jiraThread: async () => ({ comments: [], truncated: false }),
          pullRequestConversation: async () => null,
        },
      });
      const checks = vi
        .fn<RunnerDependencies['runCheckRound']>()
        .mockResolvedValue({ outcome: 'passed', setup: [], checks: [], problem: null });
      const consumed = vi.fn(async () => undefined);
      const retained = vi.fn(async () => {
        throw new Error('report disk unavailable');
      });
      if (ending === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const dependencies: RunnerDependencies = {
        preflight: async () => ({ sourceRoot: workDir, baseCommit: 'a'.repeat(40) }),
        allocateRunDirectory,
        prepareWorkspace: async (run, source) => ({
          ...run,
          ...source,
          branch: 'harness/test',
          continued: false,
          attempt: 1,
        }),
        configureWorkspaceIdentity: async () => undefined,
        returnToRecordedBranch: async () => ({ changed: false }),
        recordWorkspaceAttempt: async () => undefined,
        runCheckRound: checks,
        runAgentTurn: async () => {
          if (ending === 'cancelled') caller.abort();
          if (ending === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
          return {
            summary: 'Complete developer report',
            shutdown: { termination: 'unconfirmed', problem: 'runtime child may still write' },
          };
        },
        openAgentLog: async () => ({
          path: 'unused.log',
          write: () => undefined,
          close: async () => undefined,
        }),
        appendRunLog: async () => undefined,
        writeRunReport,
        now: () => new Date('2026-09-21T10:00:00Z'),
      };
      const result = await runTask(
        {
          task: { id: 'test', title: 'test', description: 'test', acceptanceCriteria: ['test'] },
          sourceRef: {
            type: 'jira',
            scope: 'offline',
            id: '1',
            key: 'TEST-1',
            url: 'https://example.test/1',
            updatedAt: '2026-09-21T10:00:00Z',
          },
          config: {
            workDir,
            setup: [],
            checks: [['unused']],
            maxRepairs: 0,
            taskTimeoutMinutes: 1,
            commandTimeoutMinutes: 1,
            agent: { runtime: 'codex', command: ['unused'] },
          },
          repoPath: path.join(workDir, 'unused-source'),
          workDir,
          stop: caller.signal,
          history: { ...history, consumed, recordDeveloperReport: retained },
        },
        dependencies,
      );
      expect(retained).toHaveBeenCalledOnce();
      expect(consumed).not.toHaveBeenCalled();
      expect(checks).toHaveBeenCalledOnce(); // baseline only
      expect(inspect).not.toHaveBeenCalled();
      expect(result.reason).toContain('report disk unavailable');
      expect(result.reason).toContain('runtime child may still write');
      expect(result.attempts[0]?.agentSummary).toBe('Complete developer report');
      if (ending === 'cancelled') {
        expect(result.status).toBe('cancelled');
        expect(result.cancellation?.termination).toBe('unconfirmed');
      } else if (ending === 'timeout') {
        expect(result.timeout?.termination).toBe('unconfirmed');
      } else {
        expect(result.status).toBe('failed');
        expect(result.changes.problem).toContain('may still be written to');
      }
    },
  );
});
