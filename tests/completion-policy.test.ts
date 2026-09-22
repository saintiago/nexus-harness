/**
 * The completion pass's own decisions — its deadline, its repetition and its
 * idempotency — decided against the in-memory boundary with the test's own
 * clock.
 *
 * These cases used to run on the real `gh` boundary, where a pending check the
 * pass polls for a whole deadline cost a process per reading; a loaded host
 * could not always finish one case inside the suite's five-second bound even
 * though nothing was hanging. What was really under test is the decision, and
 * that is what this file asserts. The command boundary itself (the exact
 * arguments, the credential split and the evidence and restart files) is
 * covered in tests/completion-github.test.ts and tests/completion-arm.test.ts,
 * which still run real commands.
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { completionLogsDir, createCompletionPass } from '../src/sources/completion.js';
import type { CompletionConfig, SourceRef } from '../src/shared/types.js';
import { approvedGate, inMemoryCompletion } from './fixtures/completion-actions.js';
import type { InMemoryPull } from './fixtures/completion-actions.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';
import { createTempDir } from './support.js';

useFixtureLifecycle();

const REPOSITORY = 'saintiago/nexus-harness';
const BASE_BRANCH = 'main';
const WORKSPACE_ID = 'run-20260101000000-abcdef01';
const BRANCH = `harness/${WORKSPACE_ID}`;
const HEAD = 'a'.repeat(40);

const REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'HARN-15',
  url: 'https://example.atlassian.net/browse/HARN-15',
  updatedAt: '2026-09-20T11:00:00.000Z',
};

const CONFIG: CompletionConfig = {
  lensApp: 'nexus-lens',
  lensAppId: 123,
  lensCheckName: 'Nexus Lens',
  reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
  postMergeWorkflows: ['ci.yml'],
  toDoStatus: 'To Do',
  doneStatus: 'Done',
  pollIntervalSeconds: 5,
  deadlineSeconds: 30,
};

const OPEN_PULL: InMemoryPull = {
  number: 29,
  url: `https://github.com/${REPOSITORY}/pull/29`,
  head: HEAD,
  base: BASE_BRANCH,
  branch: BRANCH,
  open: true,
  mergeCommit: null,
  armedAt: null,
};

/** One pass over the in-memory boundary, with a clock that steps by a second. */
function passFor(
  boundary: ReturnType<typeof inMemoryCompletion>,
  workDir: string,
  startMs: number,
): { run: (stop: AbortSignal) => Promise<readonly unknown[]> } {
  let clock = startMs;
  const now = (): Date => {
    clock += 1_000;
    return new Date(clock);
  };
  return createCompletionPass({
    config: CONFIG,
    repository: REPOSITORY,
    baseBranch: BASE_BRANCH,
    source: boundary.source,
    actions: boundary.actions,
    workDir,
    io: { out: () => undefined, err: () => undefined },
    now,
    // The pass asks to wait between readings; the clock is what moves here, so
    // nothing waits.
    sleep: async () => undefined,
  });
}

describe('the completion deadline', () => {
  it('bounds a merge that never finishes across passes, then reports attention once', async () => {
    const workDir = await createTempDir();
    const boundary = inMemoryCompletion({
      ref: REF,
      pointers: [WORKSPACE_ID],
      pull: { ...OPEN_PULL },
      gate: approvedGate(HEAD),
    });
    const start = Date.parse('2026-09-20T12:00:00.000Z');
    const logsDir = completionLogsDir(workDir, REF, REPOSITORY);
    // Production begins with no evidence directory at all.
    await mkdir(logsDir, { recursive: true });

    const first = await passFor(boundary, workDir, start).run(AbortSignal.timeout(30_000));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'pending' });
    expect(boundary.item.comments).toHaveLength(0);
    // The moment the item began waiting is recorded once, and a later pass reads
    // it back instead of starting the deadline again.
    const armed = JSON.parse(
      await readFile(path.join(logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { waitingSince?: string };
    expect(Date.parse(armed.waitingSince ?? '')).toBeGreaterThanOrEqual(start);
    expect(Date.parse(armed.waitingSince ?? '')).toBeLessThan(start + 5_000);

    // A later pass, far past the deadline, reports the expiry once and leaves
    // the item In Review: no failure conclusion was ever observed.
    const third = await passFor(boundary, workDir, start + 120_000).run(
      AbortSignal.timeout(30_000),
    );
    expect(third[0]).toMatchObject({ status: 'attention' });
    expect(boundary.item.status).toBe('In Review');
    expect(boundary.item.comments).toHaveLength(1);
    expect(boundary.item.comments[0]?.text).toContain('nexus-completion:attention:');
    expect(boundary.item.comments[0]?.text).toContain('deadline expired');
    expect(boundary.jiraCalls.some((call) => call.startsWith('moveTo'))).toBe(false);

    const fourth = await passFor(boundary, workDir, start + 125_000).run(
      AbortSignal.timeout(30_000),
    );
    expect(fourth[0]).toMatchObject({ status: 'attention' });
    expect(boundary.item.comments).toHaveLength(1);
  });
});
