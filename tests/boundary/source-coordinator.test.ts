/**
 * The intake coordinator's retained state, as real files under one output
 * directory: the receipt that reserves an item before anything remote or paid
 * happens, and the per-project lock that admits one consumer at a time.
 *
 * The item, the agent turn and the service answers are the case's stand-ins —
 * the coordinator starts no runtime and no command here — while the receipt
 * file, its exclusive creation, its atomic replacement and the lock directory
 * are the harness's own code, on a real temporary filesystem. What is asserted
 * is the documented intake behavior (docs/spec.md §6): an item is never
 * attempted twice from one output directory, an uncertain claim keeps the
 * receipt it just created and stops intake for a person, a rejected claim
 * releases only the reservation this process made, a failed publication keeps
 * the local result and stops, and a lock is never broken, adopted, or removed
 * by a process that does not own it.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunTaskResult } from '../../src/runs/contracts.js';
import { summarizeChanges } from '../../src/reporting/changes.js';
import type { SourceRef, Task } from '../../src/shared/types.js';
import type {
  SourceCandidate,
  SourceTask,
  SourceContext,
  TaskSource,
} from '../../src/sources/contract.js';
import { SourceError, SourceFeedbackError } from '../../src/sources/contract.js';
import { runSource } from '../../src/sources/coordinator.js';
import type { SourceReceipt } from '../../src/sources/receipts.js';
import {
  acquireIntakeLock,
  intakeLockPath,
  readReceipt,
  receiptFilePath,
} from '../../src/sources/receipts.js';
import { createTempDir } from './integration-support.js';

const SITE = 'https://example.atlassian.net';
const REF: SourceRef = {
  type: 'jira',
  scope: SITE,
  id: '10011',
  key: 'HARN-11',
  url: `${SITE}/browse/HARN-11`,
  updatedAt: '2026-09-23T10:00:00.000Z',
};
const TASK: Task = {
  id: 'HARN-11',
  title: 'Add a greeting function',
  description: 'Implement the greeting the ticket describes.',
  acceptanceCriteria: ['The greeting is implemented.'],
};
const BASE = 'a'.repeat(40);
const NAMESPACE = 'connected-project';

function candidate(id = REF.id, key = REF.key): SourceCandidate {
  return { ref: { ...REF, id, key, url: `${SITE}/browse/${key}` }, title: TASK.title };
}

function prepared(source: SourceCandidate): SourceTask {
  return { ref: source.ref, task: { ...TASK, id: source.ref.key }, pointers: [] };
}

/** The run one case's stand-in agent turn produced. */
function runResult(workDir: string, status: RunTaskResult['status'] = 'passed'): RunTaskResult {
  const runId = 'run-1';
  const runDir = path.join(workDir, 'runs', runId);
  const workspaceId = REF.key;
  const workspacePath = path.join(workDir, 'workspaces', workspaceId);
  const logsDir = path.join(runDir, 'logs');
  return {
    run: { workDir, runId, runDir, workspaceId, workspacePath, logsDir },
    workspace: {
      workDir,
      runId,
      runDir,
      workspaceId,
      workspacePath,
      logsDir,
      continued: false,
      attempt: 1,
      sourceRoot: path.join(workDir, 'source'),
      baseCommit: BASE,
      branch: `harness/${workspaceId}`,
    },
    status,
    reason:
      status === 'passed'
        ? 'every configured check passed'
        : 'the checks after the implementation turn did not pass',
    baseline: null,
    attempts: [],
    repairsUsed: 0,
    timeout: null,
    cancellation: null,
    changes: summarizeChanges({ baseCommit: BASE, paths: [] }),
    workspaceLedgerProblem: null,
    reportPath: path.join(runDir, 'result.json'),
  };
}

/** What one coordinator case watches: the calls its stand-in source received. */
interface CoordinatorCalls {
  readonly lists: number;
  readonly prepared: string[];
  readonly claims: string[];
  readonly runs: string[];
  readonly refusals: string[];
  readonly completions: string[];
  readonly outputs: string[];
}

/** One intake over a temporary output directory, with every collaborator named. */
function coordinatorHarness(
  workDir: string,
  parts: {
    readonly candidates?: readonly SourceCandidate[];
    readonly claim?: (item: SourceTask) => Promise<boolean>;
    readonly complete?: (
      item: SourceTask,
    ) => Promise<{ readonly commentId: string; readonly text: string }>;
  } = {},
) {
  const recorder = {
    lists: 0,
    prepared: [] as string[],
    claims: [] as string[],
    runs: [] as string[],
    refusals: [] as string[],
    completions: [] as string[],
    outputs: [] as string[],
  };
  const source: TaskSource = {
    listEligible: async () => {
      recorder.lists += 1;
      return parts.candidates ?? [candidate()];
    },
    prepare: async (found) => {
      recorder.prepared.push(found.ref.key);
      return prepared(found);
    },
    claim: async (item) => {
      recorder.claims.push(item.ref.key);
      return parts.claim === undefined ? true : await parts.claim(item);
    },
    progress: async (item) => {
      throw new Error(`no ladder rung published a progress comment for ${item.ref.key}`);
    },
    complete: async (item) => {
      recorder.completions.push(item.ref.key);
      return parts.complete === undefined
        ? await Promise.resolve({ commentId: '9001', text: 'published' })
        : await parts.complete(item);
    },
    recordWorkspace: async () => undefined,
    refuse: async (item, reason) => {
      recorder.refusals.push(`${item.ref.key}: ${reason}`);
    },
    attention: async (item, reason) => {
      recorder.refusals.push(`${item.ref.key}: attention: ${reason}`);
    },
    commentsSince: async () => [],
  };
  const context: SourceContext = {
    source,
    workDir,
    lockNamespace: NAMESPACE,
    tiers: [{ name: 'default', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 }],
    repoPath: path.join(workDir, 'source'),
    io: {
      out: (text) => recorder.outputs.push(text),
      err: (text) => recorder.outputs.push(text),
    },
    stop: new AbortController().signal,
    preflight: async () => ({ sourceRoot: path.join(workDir, 'source'), baseCommit: BASE }),
    run: async () => {
      recorder.runs.push(REF.key);
      return runResult(workDir);
    },
    now: () => new Date('2026-09-23T10:00:00.000Z'),
    sleep: async () => undefined,
  };
  return { context, calls: recorder as CoordinatorCalls };
}

/** One receipt, read back as the file really holds it. */
async function receipt(workDir: string): Promise<SourceReceipt | null> {
  return await readReceipt(receiptFilePath(workDir, REF));
}

describe('one item, one receipt, across invocations', () => {
  it('runs a fresh item once and refuses it when a later invocation scans again', async () => {
    const workDir = await createTempDir();
    const first = coordinatorHarness(workDir, { candidates: [candidate()] });

    const summary = await runSource(first.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', attempted: 1, passed: 1, refused: 0 });
    expect(first.calls.claims).toEqual([REF.key]);
    expect(first.calls.runs).toEqual([REF.key]);
    expect(await receipt(workDir)).toMatchObject({
      outcome: 'passed',
      feedback: 'sent',
      runId: 'run-1',
    });

    // The restart a watcher's next invocation is: the receipt is the local
    // record that the item was attempted, and nothing claims, runs or publishes
    // it a second time.
    const second = coordinatorHarness(workDir, { candidates: [candidate()] });
    const again = await runSource(second.context, null);

    expect(again).toMatchObject({ outcome: 'completed', attempted: 0, refused: 1 });
    expect(second.calls.claims).toEqual([]);
    expect(second.calls.runs).toEqual([]);
    expect(second.calls.refusals[0]).toContain('already attempted');
  });

  it('keeps the receipt and stops intake when the claim is uncertain', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      claim: async () => {
        throw new SourceError('uncertain-write', 'the transition request did not answer');
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('the claim did not complete');
    // Nothing ran after the uncertain claim, and nothing was published.
    expect(harness.calls.runs).toEqual([]);
    expect(harness.calls.completions).toEqual([]);
    const kept = await receipt(workDir);
    expect(kept?.runId).toBeUndefined();
    expect(kept?.problem).toContain('the transition request did not answer');

    // The kept receipt is the evidence a later invocation reads: the item is
    // refused, never claimed or run again.
    const restart = coordinatorHarness(workDir, { candidates: [candidate()] });
    const again = await runSource(restart.context, null);

    expect(again.refused).toBe(1);
    expect(restart.calls.claims).toEqual([]);
    expect(restart.calls.runs).toEqual([]);
  });

  it('does not make a merely edited or reopened item runnable again', async () => {
    const workDir = await createTempDir();
    await runSource(coordinatorHarness(workDir, { candidates: [candidate()] }).context, null);
    // The same immutable item, re-read after an edit or a reopen: a new key, a
    // new title, a new revision. The receipt is keyed by the connector type, the
    // canonical site and the immutable ID alone, so nothing mutable makes the
    // item look like new work.
    const edited: SourceCandidate = {
      ref: { ...REF, key: 'HARN-11-restated', updatedAt: '2026-09-24T09:00:00.000Z' },
      title: 'A completely different summary',
    };
    const again = coordinatorHarness(workDir, { candidates: [edited] });

    const summary = await runSource(again.context, null);

    expect(summary).toMatchObject({ attempted: 0, refused: 1 });
    // It is re-read to decide, and re-read again so the refusal is about the
    // item as it is now — then left alone: no claim, no run.
    expect(again.calls.prepared).toEqual(['HARN-11-restated', 'HARN-11-restated']);
    expect(again.calls.claims).toEqual([]);
    expect(again.calls.runs).toEqual([]);
    expect(receiptFilePath(workDir, edited.ref)).toBe(receiptFilePath(workDir, REF));
    expect(receiptFilePath(workDir, { ...edited.ref, id: '10012' })).not.toBe(
      receiptFilePath(workDir, REF),
    );
    expect(
      receiptFilePath(workDir, { ...edited.ref, scope: 'https://other.atlassian.net' }),
    ).not.toBe(receiptFilePath(workDir, REF));
  });

  it('releases only the reservation it just made when the claim sent no mutation request', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate()],
      claim: async () => false,
    });

    const summary = await runSource(harness.context, null);

    expect(summary).toMatchObject({ outcome: 'completed', skipped: 1 });
    expect(harness.calls.runs).toEqual([]);
    // The item stayed eligible, and no mutation was sent, so the reservation
    // this invocation created is gone: a later scan may try the item again.
    expect(existsSync(receiptFilePath(workDir, REF))).toBe(false);
  });

  it('keeps the local result and the receipt, and stops, after a failed publication', async () => {
    const workDir = await createTempDir();
    const harness = coordinatorHarness(workDir, {
      candidates: [candidate(), candidate('10012', 'HARN-12')],
      complete: async () => {
        throw new SourceFeedbackError('transition', 'the transition failed', '9001');
      },
    });

    const summary = await runSource(harness.context, null);

    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('publishing its result failed');
    // The second candidate was never started: a publication failure stops the
    // batch instead of moving to the next ticket.
    expect(harness.calls.runs).toEqual([REF.key]);
    expect(await receipt(workDir)).toMatchObject({
      outcome: 'passed',
      feedback: 'failed',
      commentId: '9001',
    });
    const kept = await receipt(workDir);
    expect(kept?.resultPath).toBe(path.join(workDir, 'runs', 'run-1', 'result.json'));
  });

  it('fails closed on a receipt it cannot trust instead of treating it as absence', async () => {
    const workDir = await createTempDir();
    const file = receiptFilePath(workDir, REF);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json', 'utf8');
    const harness = coordinatorHarness(workDir, { candidates: [candidate()] });

    const thrown = await runSource(harness.context, null).catch((cause: unknown) => cause);

    expect(thrown).toBeInstanceOf(SourceError);
    expect((thrown as Error).message).toContain(file);
    // Nothing was claimed or run on the strength of a record nobody can read.
    expect(harness.calls.claims).toEqual([]);
    expect(harness.calls.runs).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });
});

describe('the intake lock one consumer holds', () => {
  it('refuses a second consumer of the same connected project before anything is discovered', async () => {
    const workDir = await createTempDir();
    const held = await acquireIntakeLock(workDir, NAMESPACE, () => new Date());
    const harness = coordinatorHarness(workDir, { candidates: [candidate()] });

    const thrown = await runSource(harness.context, null).catch((cause: unknown) => cause);
    await held.release();

    expect(thrown).toBeInstanceOf(SourceError);
    expect((thrown as Error).message).toContain('another intake consumer holds');
    // Nothing was discovered, claimed or run under the held lock.
    expect(harness.calls.lists).toBe(0);
    expect(harness.calls.claims).toEqual([]);
    expect(harness.calls.runs).toEqual([]);
  });

  it('never removes or adopts a lock whose owner record is not this process', async () => {
    const workDir = await createTempDir();
    const dir = intakeLockPath(workDir, NAMESPACE);
    await mkdir(dir, { recursive: true });
    const owner = path.join(dir, 'owner.json');
    const contents = `${JSON.stringify({
      version: 1,
      pid: 999999,
      startedAt: '2026-01-01T00:00:00.000Z',
      token: 'someone-else',
    })}\n`;
    await writeFile(owner, contents, 'utf8');

    const thrown = await acquireIntakeLock(workDir, NAMESPACE, () => new Date()).catch(
      (cause: unknown) => cause,
    );

    expect(thrown).toBeInstanceOf(SourceError);
    expect((thrown as Error).message).toContain('another intake consumer holds');
    // The lock and the owner it names are left exactly as they were found.
    expect(await readFile(owner, 'utf8')).toBe(contents);
  });

  it('refuses to release a lock that is no longer its own', async () => {
    const workDir = await createTempDir();
    const lock = await acquireIntakeLock(workDir, NAMESPACE, () => new Date());
    await writeFile(
      path.join(lock.dir, 'owner.json'),
      `${JSON.stringify({ version: 1, token: 'someone-else' })}\n`,
      'utf8',
    );

    await expect(lock.release()).rejects.toThrow(/no longer this process's lock/);
    expect(existsSync(lock.dir)).toBe(true);
  });

  it.each(['stale', 'malformed', 'missing owner'])(
    'refuses the legacy whole-directory lock with %s metadata without changing it',
    async (state) => {
      const workDir = await createTempDir();
      const legacy = path.join(workDir, '.intake', 'lock');
      await mkdir(legacy, { recursive: true });
      const owner = path.join(legacy, 'owner.json');
      const contents =
        state === 'malformed'
          ? '{'
          : `${JSON.stringify({
              version: 1,
              pid: 999999,
              startedAt: '2020-01-01T00:00:00.000Z',
              token: 'legacy-owner',
            })}\n`;
      if (state !== 'missing owner') {
        await writeFile(owner, contents, 'utf8');
      }

      const thrown = await acquireIntakeLock(workDir, NAMESPACE, () => new Date()).catch(
        (cause: unknown) => cause,
      );

      expect(thrown).toBeInstanceOf(SourceError);
      expect((thrown as Error).message).toContain(
        'Inspect that lock and stop its owner before removing it by hand',
      );
      expect(existsSync(legacy)).toBe(true);
      if (state !== 'missing owner') {
        expect(await readFile(owner, 'utf8')).toBe(contents);
      }
    },
  );
});
