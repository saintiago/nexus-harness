/** Settlement and late-entry races complement the nested real-process proofs. */
import { existsSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentLog } from '../src/reporting/logs.js';
import {
  createGitHubDelivery,
  runCodexPrompt,
  runCodexTurn,
  runGit,
  withFixtureEnvironment,
} from './fixtures/boundary-operations.js';
import { disposeFixtures, useFixtureLifecycle } from './fixtures/lifecycle.js';
import { fixtureContexts, newScope } from './fixtures/scope.js';
import { createTempDir } from './support.js';

const boundary = vi.hoisted(() => vi.fn<(request: { stop: AbortSignal }) => Promise<unknown>>());
vi.mock('../src/agents/codex/adapter.js', () => ({
  runCodexPrompt: boundary,
  runCodexTurn: boundary,
}));
vi.mock('../src/workspace/git.js', () => ({
  runGit: (_args: unknown, _cwd: unknown, bounds: { stop: AbortSignal }) => boundary(bounds),
}));
vi.mock('../src/delivery/github.js', () => ({
  createGitHubDelivery: () => ({
    deliver: (_request: unknown, stop: AbortSignal) => boundary({ stop }),
  }),
}));
useFixtureLifecycle();
beforeEach(() => {
  boundary.mockReset();
});

type Entry = 'git' | 'delivery' | 'prompt' | 'turn';
const delivery = createGitHubDelivery({
  type: 'github',
  repository: 'offline/test',
  baseBranch: 'main',
});
function invoke(entry: Entry, stop: AbortSignal, log: AgentLog): Promise<unknown> {
  const common = { workspacePath: '.', stop, agentLog: log };
  switch (entry) {
    case 'git':
      return runGit(['status'], '.', { stop });
    case 'delivery':
      return delivery.deliver(
        {
          workspacePath: '.',
          branch: 'main',
          baseCommit: 'a'.repeat(40),
          logsDir: '.',
          runId: 'test',
          reportPath: 'report.json',
          task: { id: 'TEST-1', title: 'offline' },
          checks: 'passed',
        },
        stop,
      );
    case 'prompt':
      return runCodexPrompt({ ...common, prompt: 'offline', label: 'test' });
    case 'turn':
      return runCodexTurn({
        ...common,
        kind: 'implementation',
        turn: 1,
        task: { id: 'TEST-1', title: 'offline', description: 'offline', acceptanceCriteria: [] },
        sourceRoot: '.',
        baseCommit: 'a'.repeat(40),
        repair: null,
      });
  }
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const emptyLog = { path: 'unused', write: () => undefined, close: async () => undefined };

it.each(['git', 'delivery', 'prompt', 'turn'] as const)(
  'preserves caller cancellation for standalone %s',
  async (entry) => {
    const entered = deferred();
    let signal!: AbortSignal;
    boundary.mockImplementation(async (request) => {
      signal = request.stop;
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    const caller = new AbortController();
    const running = invoke(entry, caller.signal, emptyLog);
    expect(fixtureContexts.getStore()?.work.size).toBe(1);
    await entered.promise;
    caller.abort();
    await running;
    expect(signal.aborted).toBe(true);
    expect(fixtureContexts.getStore()?.stop.signal.aborted).toBe(false);
  },
);

it.each(['prompt', 'turn'] as const)(
  'waits for %s log closure and environment restoration before removal',
  async (entry) => {
    const directory = await createTempDir();
    const closing = deferred();
    const flush = deferred();
    boundary.mockResolvedValue(undefined);
    const log = {
      ...emptyLog,
      close: async () => {
        closing.resolve();
        await flush.promise;
      },
    };
    const previous = process.env['NEXUS_BOUNDARY_TEST'];
    const running = withFixtureEnvironment({ NEXUS_BOUNDARY_TEST: 'held' }, () =>
      invoke(entry, new AbortController().signal, log),
    );
    await closing.promise;
    const disposal = disposeFixtures();
    expect(existsSync(directory)).toBe(true);
    expect(process.env['NEXUS_BOUNDARY_TEST']).toBe('held');
    flush.resolve();
    await running;
    await disposal;
    expect(process.env['NEXUS_BOUNDARY_TEST']).toBe(previous);
    expect(existsSync(directory)).toBe(false);
  },
);

it('refuses late boundary calls and environment changes in their original disposed scope', async () => {
  const old = newScope();
  const resume = deferred();
  const previous = process.env['NEXUS_BOUNDARY_TEST'];
  const late = fixtureContexts.run(old, async () => {
    await resume.promise;
    for (const entry of ['git', 'delivery', 'prompt', 'turn'] as const) {
      await expect(invoke(entry, new AbortController().signal, emptyLog)).rejects.toThrow(
        'already being disposed',
      );
    }
    await expect(
      withFixtureEnvironment({ NEXUS_BOUNDARY_TEST: 'late' }, async () => undefined),
    ).rejects.toThrow('already being disposed');
  });
  await disposeFixtures(old);
  const next = newScope();
  await fixtureContexts.run(next, async () => {
    resume.resolve();
    await late;
    expect(next.work.size).toBe(0);
    expect(process.env['NEXUS_BOUNDARY_TEST']).toBe(previous);
    await disposeFixtures(next);
  });
  expect(boundary).not.toHaveBeenCalled();
});
