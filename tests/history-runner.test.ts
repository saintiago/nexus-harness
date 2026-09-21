/** Offline runner policy tests: no Git, check process, or coding runtime is launched. */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTicketHistory } from '../src/history/sync.js';
import { runTask } from '../src/runs/runner.js';
import type { RunnerDependencies } from '../src/runs/contracts.js';
import { writeRunReport } from '../src/reporting/report.js';
import { allocateRunDirectory } from '../src/workspace/run-directory.js';
import * as changes from '../src/workspace/changes.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupTempDirectories();
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
