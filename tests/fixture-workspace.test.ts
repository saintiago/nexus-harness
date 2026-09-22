/** The actual restored helpers keep late continuations in their original owner. */
import { existsSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceError } from '../src/workspace/errors.js';
import type { LocalTarget } from './fixtures/local-target.js';
import { accepted, expectRejected, prepareRun } from './fixtures/workspace.js';
import {
  reviewerFor,
  refFor,
  taskFor,
  redBaseline,
  phaseFor,
  fakeRecord,
  scriptedReviewer,
  baselineWithLogs,
  requestFor,
} from './fixtures/baseline.js';
import {
  inspectBranchStanding,
  returnToRecordedBranch,
  reopenWorkspace,
  prepareReviewView,
  reviewViewProblem,
} from './fixtures/boundary-operations.js';
import { disposeFixtures, useFixtureLifecycle } from './fixtures/lifecycle.js';
import { fixtureContexts, newScope } from './fixtures/scope.js';
import { createTempDir } from './support.js';

const mocks = vi.hoisted(() => ({
  boundary: vi.fn<(stop: AbortSignal) => Promise<unknown>>(),
  allocate: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock('../src/workspace/preflight.js', () => ({
  preflightSource: (request: { bounds: { stop: AbortSignal } }) =>
    mocks.boundary(request.bounds.stop),
}));
vi.mock('../src/workspace/prepare.js', () => ({ prepareWorkspace: mocks.prepare }));
vi.mock('../src/workspace/run-directory.js', async (original) => ({
  ...(await original<object>()),
  allocateRunDirectory: mocks.allocate,
}));
vi.mock('../src/workspace/branch.js', () => ({
  inspectBranchStanding: (_path: string, _branch: string, bounds: { stop: AbortSignal }) =>
    mocks.boundary(bounds.stop),
  returnToRecordedBranch: (_path: string, _branch: string, bounds: { stop: AbortSignal }) =>
    mocks.boundary(bounds.stop),
}));
vi.mock('../src/workspace/reopen.js', () => ({
  reopenWorkspace: (_dir: string, _id: string, _expected: unknown, bounds: { stop: AbortSignal }) =>
    mocks.boundary(bounds.stop),
}));
vi.mock('../src/reviews/view.js', () => ({
  prepareReviewView: (_request: unknown, stop: AbortSignal) => mocks.boundary(stop),
  reviewViewProblem: (_request: unknown, stop: AbortSignal) => mocks.boundary(stop),
}));
vi.mock('../src/reviews/baseline.js', async (original) => ({
  ...(await original<object>()),
  createBaselineReviewer: () => (request: { stop: AbortSignal }) => mocks.boundary(request.stop),
}));
useFixtureLifecycle();
beforeEach(() => {
  vi.clearAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const entries = [
  'accepted',
  'rejected',
  'prepareRun',
  'branch',
  'return',
  'reopen',
  'view',
  'verify',
  'reviewer',
] as const;
type Entry = (typeof entries)[number];
function invoke(entry: Entry, directory: string, stop: AbortSignal): Promise<unknown> {
  const source = { repoPath: directory, workDir: directory, bounds: { stop } };
  const identity = {
    sourceRoot: directory,
    sourceItem: { type: 'jira' as const, scope: 'offline', id: '1', key: 'TEST-1' },
  };
  switch (entry) {
    case 'accepted':
      return accepted(source);
    case 'rejected':
      return expectRejected(source, /stopped/);
    case 'prepareRun':
      return prepareRun({ parent: directory, repo: directory, workDir: directory });
    case 'branch':
      return inspectBranchStanding(directory, 'main', { stop });
    case 'return':
      return returnToRecordedBranch(directory, 'main', { stop });
    case 'reopen':
      return reopenWorkspace(directory, 'test', identity, { stop });
    case 'view':
      return prepareReviewView(
        { dir: directory, workspacePath: directory, head: 'a'.repeat(40), base: 'b'.repeat(40) },
        stop,
      );
    case 'verify':
      return reviewViewProblem(
        { path: directory, head: 'a'.repeat(40), base: 'b'.repeat(40) },
        stop,
      );
    case 'reviewer':
      return reviewerFor(
        { runtimePath: 'unused', state: { dir: directory } } as LocalTarget,
        [],
      )({
        dir: directory,
        item: { ref: refFor(), task: taskFor() },
        workspace: { path: directory, baseCommit: 'a'.repeat(40) },
        baseline: redBaseline(),
        stop,
      });
  }
}

it.each(entries)('awaits pending %s settlement before removing its directory', async (entry) => {
  const directory = await createTempDir();
  const entered = deferred();
  const aborted = deferred();
  const release = deferred();
  const caller = new AbortController();
  mocks.boundary.mockImplementation(async (stop) => {
    entered.resolve();
    stop.addEventListener('abort', aborted.resolve, { once: true });
    await release.promise;
    expect(stop.aborted).toBe(true);
    throw new WorkspaceError('stopped');
  });
  const running = invoke(entry, directory, caller.signal).catch((cause: unknown) => cause);
  await entered.promise;
  expect(fixtureContexts.getStore()?.work.size).toBeGreaterThan(0);
  let disposed = false;
  const disposal = disposeFixtures().then(() => {
    disposed = true;
  });
  await aborted.promise;
  expect(disposed).toBe(false);
  expect(existsSync(directory)).toBe(true);
  expect(caller.signal.aborted).toBe(false);
  release.resolve();
  expect(await running).toBeInstanceOf(WorkspaceError);
  await disposal;
  expect(existsSync(directory)).toBe(false);
  expect(mocks.allocate).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it('does not allocate after a pending preflight returns success during disposal', async () => {
  const directory = await createTempDir();
  const entered = deferred();
  const release = deferred();
  mocks.boundary.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return { sourceRoot: directory, baseCommit: 'a'.repeat(40) };
  });
  const running = prepareRun({ parent: directory, repo: directory, workDir: directory }).catch(
    (cause: unknown) => cause,
  );
  await entered.promise;
  const disposal = disposeFixtures();
  expect(existsSync(directory)).toBe(true);
  release.resolve();
  expect(String(await running)).toContain('AbortError');
  await disposal;
  expect(mocks.allocate).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(existsSync(directory)).toBe(false);
});

it('awaits a pending prepareRun allocation and refuses preparation after disposal', async () => {
  const directory = await createTempDir();
  const allocating = deferred();
  const release = deferred();
  mocks.boundary.mockResolvedValue({ sourceRoot: directory, baseCommit: 'a'.repeat(40) });
  mocks.allocate.mockImplementation(async () => {
    allocating.resolve();
    await release.promise;
    return {};
  });
  const running = prepareRun({ parent: directory, repo: directory, workDir: directory }).catch(
    (cause: unknown) => cause,
  );
  await allocating.promise;
  const disposal = disposeFixtures();
  expect(existsSync(directory)).toBe(true);
  release.resolve();
  expect(String(await running)).toContain('already being disposed');
  await disposal;
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(existsSync(directory)).toBe(false);
});

it('refuses each late helper in its disposed scope after the next test has started', async () => {
  const old = newScope();
  const release = deferred();
  const late = fixtureContexts.run(old, async () => {
    await release.promise;
    for (const entry of entries) {
      await expect(invoke(entry, 'unused', new AbortController().signal)).rejects.toThrow(
        /already being disposed/,
      );
    }
  });
  await disposeFixtures(old);
  const next = newScope();
  await fixtureContexts.run(next, async () => {
    release.resolve();
    await late;
    expect(next.work.size).toBe(0);
    await disposeFixtures(next);
  });
  expect(mocks.boundary).not.toHaveBeenCalled();
  expect(mocks.allocate).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it('awaits diagnosis publication and persistence after the reviewer has already returned', async () => {
  const workDir = await createTempDir();
  const record = fakeRecord();
  const reviewer = scriptedReviewer(null, 'the reviewer was stopped');
  const publishing = deferred();
  const release = deferred();
  record.postComment = async () => {
    publishing.resolve();
    await release.promise;
    expect(existsSync(workDir)).toBe(true);
    return 'held-comment';
  };
  const { diagnosis } = phaseFor({ workDir, record, reviewer });
  const request = requestFor(await baselineWithLogs());
  const running = diagnosis.diagnose(request);
  await publishing.promise;
  expect(reviewer.requests).toHaveLength(1);
  let disposed = false;
  const disposal = disposeFixtures().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  expect(existsSync(workDir)).toBe(true);
  release.resolve();
  expect((await running).kind).toBe('attention');
  await disposal;
  expect(existsSync(workDir)).toBe(false);
});
