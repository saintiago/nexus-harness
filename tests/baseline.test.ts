/**
 * The pre-delivery baseline diagnosis, offline.
 *
 * The phase and the queue are driven with ordinary fakes — a scripted reviewer,
 * an in-memory record, scripted consumer steps — so the ordering and the
 * outcomes the acceptance criteria are about can be asserted from what really
 * happened. The reviewer turn and the Jira record are then exercised against the
 * real modules: a disposable Git repository whose failing baseline is real, the
 * stand-in runtime on disk, and a fake HTTP boundary that speaks Jira REST API
 * v3. Nothing here contacts Jira, GitHub, or a coding provider.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { EXIT_INPUT_ERROR } from '../src/cli/context.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../src/config/paths.js';
import type { Delivery } from '../src/delivery/github.js';
import type { QueueLoopContext } from '../src/queue/loop.js';
import { runQueue } from '../src/queue/loop.js';
import { summarizeChanges } from '../src/reporting/changes.js';
import type { RunTaskResult } from '../src/runs/contracts.js';
import {
  baselineFailures,
  baselineFindingPath,
  createBaselineReviewer,
  parseBaselineFinding,
  readBaselineOutcome,
} from '../src/reviews/baseline.js';
import type {
  BaselineDiagnosis,
  BaselineDiagnosisOutcome,
  BaselineDiagnosisRequest,
  BaselineFinding,
  BaselineRecord,
  BaselineReview,
  BaselineReviewResult,
  BaselineReviewedFinding,
  QueueTicket,
  SourceContext,
  SourceNote,
  SourceRunOutcome,
  SourceRunRequest,
  SourceTake,
  SourceTask,
  TaskSource,
} from '../src/sources/contract.js';
import {
  BASELINE_MARKER_PREFIX,
  baselineCommentFinding,
  baselineEvidenceId,
  baselineFindingGuidanceLines,
  createBaselineDiagnosis,
} from '../src/sources/baseline.js';
import { guidanceFrom } from '../src/sources/guidance.js';
import { runSource, takeOneItem, watchSource } from '../src/sources/coordinator.js';
import { intakeLockPath, readReceipt, receiptFilePath } from '../src/sources/receipts.js';
import type { CheckRoundResult, CommandResult } from '../src/shared/types.js';
import type { SourceRef, Task } from '../src/shared/types.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { recordWorkspaceAttempt, writeWorkspaceState } from '../src/workspace/state.js';
import type { WorkspaceAttempt } from '../src/workspace/state.js';
import { createLocalTarget, endFixtureTree, fakeTurns, git } from './fixtures/local-target.js';
import type { LocalTarget } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir, writeJsonFile } from './support.js';
import { createHttpClient } from '../src/sources/jira/http.js';
import { createJiraBaselineRecord } from '../src/sources/jira/baseline.js';

afterEach(async () => {
  await cleanupTempDirectories();
});

const SCOPE = 'https://example.atlassian.net';
const ISSUE_ID = '10011';
const ISSUE_KEY = 'HARN-38';
const BASE = 'a'.repeat(40);
/**
 * The connected project every fixture here diagnoses under. It stands where
 * production puts the composed connection identity's own namespace
 * (`projectLockNamespace`), and it is what scopes one project's evidence
 * directories away from another's under one shared `workDir`.
 */
const PROJECT = 'baseline-project';

function refFor(id = ISSUE_ID, key = ISSUE_KEY): SourceRef {
  return {
    type: 'jira',
    scope: SCOPE,
    id,
    key,
    url: `${SCOPE}/browse/${key}`,
    updatedAt: '2026-09-21T10:00:00.000Z',
  };
}

function taskFor(ref = refFor()): Task {
  return {
    id: ref.key,
    title: 'Repair the failing baseline and finish the ticket',
    description: 'The ticket the baseline failed under.',
    acceptanceCriteria: ['The configured checks pass.', 'The ticket work is done.'],
  };
}

function commandFor(
  overrides: {
    readonly command?: readonly string[];
    readonly exitCode?: number | null;
    readonly outcome?: CommandResult['outcome'];
    readonly stdoutPath?: string;
    readonly stderrPath?: string;
  } = {},
): CommandResult {
  return {
    command: overrides.command ?? ['npm', 'run', 'validate'],
    cwd: '/workspace',
    startedAt: '2026-09-21T10:00:00.000Z',
    endedAt: '2026-09-21T10:01:00.000Z',
    outcome: overrides.outcome ?? 'exited',
    exitCode: overrides.exitCode === undefined ? 1 : overrides.exitCode,
    signal: null,
    launchError: null,
    timeoutMs: 600_000,
    termination: null,
    terminationProblem: null,
    stdoutPath: overrides.stdoutPath ?? '/logs/baseline-check-1.stdout.log',
    stderrPath: overrides.stderrPath ?? '/logs/baseline-check-1.stderr.log',
  };
}

/** A completed red baseline: setup ran green, and the check exited nonzero. */
function redBaseline(overrides: Partial<CheckRoundResult> = {}): CheckRoundResult {
  return {
    outcome: 'failed',
    setup: [commandFor({ command: ['npm', 'ci'], exitCode: 0 })],
    checks: [
      commandFor({ command: ['npm', 'run', 'validate'] }),
      commandFor({ command: ['npm', 'test'], exitCode: 0 }),
    ],
    problem: null,
    ...overrides,
  };
}

/**
 * A completed red baseline whose failing check really wrote its output: the
 * log files exist, so the evidence the diagnosis reads is whole. The plain
 * `redBaseline()` names log paths nothing wrote, which is the incomplete
 * evidence the diagnosis refuses rather than hands to a reviewer.
 */
async function baselineWithLogs(): Promise<CheckRoundResult> {
  const dir = await createTempDir();
  const stdoutPath = path.join(dir, 'baseline-check-1.stdout.log');
  const stderrPath = path.join(dir, 'baseline-check-1.stderr.log');
  await writeFile(stdoutPath, 'running test/load.test.mjs\nFAILED test/load.test.mjs\n', 'utf8');
  await writeFile(stderrPath, 'the load test timed out after 30s\n', 'utf8');
  return redBaseline({
    checks: [commandFor({ command: ['npm', 'run', 'validate'], stdoutPath, stderrPath })],
  });
}

// ---------------------------------------------------------------------------
// The phase, against an in-memory thread and a scripted reviewer
// ---------------------------------------------------------------------------

interface FakeRecord extends BaselineRecord {
  readonly notes: SourceNote[];
  readonly posted: string[][];
  readonly moves: { readonly target: string; readonly from: string }[];
  status: string;
  commentFailure: string | null;
  moveFailure: string | null;
  threadFailure: string | null;
  runningFailure: string | null;
}

/**
 * What the real Jira record answers once its caller's own stop aborted: the
 * HTTP layer never sends the request, so the caller sees the request fail
 * immediately rather than a write that happened.
 */
function stoppedByCaller(): Error {
  return new Error('the request was stopped by the caller before it answered');
}

function fakeRecord(status = 'In Progress'): FakeRecord {
  const record: FakeRecord = {
    notes: [],
    posted: [],
    moves: [],
    status,
    commentFailure: null,
    moveFailure: null,
    threadFailure: null,
    runningFailure: null,
    listComments: async (_id, stop) => {
      if (stop.aborted) {
        throw stoppedByCaller();
      }
      if (record.threadFailure !== null) {
        throw new Error(record.threadFailure);
      }
      return record.notes;
    },
    isRunning: async (_id, stop) => {
      if (stop.aborted) {
        throw stoppedByCaller();
      }
      if (record.runningFailure !== null) {
        throw new Error(record.runningFailure);
      }
      return record.status === 'In Progress';
    },
    postComment: async (_id, paragraphs, stop) => {
      if (stop.aborted) {
        throw stoppedByCaller();
      }
      if (record.commentFailure !== null) {
        throw new Error(record.commentFailure);
      }
      record.posted.push([...paragraphs]);
      const id = `c${String(record.notes.length + 1)}`;
      record.notes.push({ id, createdAt: '2026-09-21T10:05:00.000Z', text: paragraphs.join('\n') });
      return id;
    },
    moveFromRunning: async (_id, target, stop) => {
      if (stop.aborted) {
        throw stoppedByCaller();
      }
      if (record.moveFailure !== null) {
        throw new Error(record.moveFailure);
      }
      if (record.status !== 'In Progress') {
        return 'left-alone';
      }
      record.moves.push({ target, from: record.status });
      record.status = target;
      return 'moved';
    },
  };
  return record;
}

interface ScriptedReviewer {
  readonly review: BaselineReview;
  readonly requests: { readonly dir: string; readonly base: string }[];
}

/**
 * A reviewer that answers with one finding, and records what it was asked. A
 * stop it could not confirm is passed through the way the real reviewer turn
 * reports one.
 */
function scriptedReviewer(
  answer: BaselineFinding | null,
  problem: string | null = null,
  shutdown: BaselineReviewResult['shutdown'] = null,
): ScriptedReviewer {
  const requests: ScriptedReviewer['requests'] = [];
  return {
    requests,
    review: async (request) => {
      requests.push({ dir: request.dir, base: request.workspace.baseCommit });
      return {
        summary: 'the reviewer is done',
        finding: answer,
        problem,
        logPath: path.join(request.dir, 'reviewer.log'),
        shutdown,
      };
    },
  };
}

/**
 * One reviewer turn a test interrupts while it is really running: it starts,
 * waits for the turn's own stop, and answers the way the real reviewer answers
 * a stop that lands mid-turn — a rejected result carrying the turn's own stop.
 */
function interruptibleReviewer(shutdown: BaselineReviewResult['shutdown']): {
  readonly review: BaselineReview;
  readonly started: Promise<void>;
} {
  let started: () => void = () => undefined;
  const startedTurn = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    started: startedTurn,
    review: async (request) => {
      started();
      await new Promise<void>((resolve) => {
        if (request.stop.aborted) {
          resolve();
          return;
        }
        request.stop.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        summary: null,
        finding: null,
        problem:
          `the baseline reviewer turn for ${request.item.ref.key} was stopped before it produced ` +
          'a finding — its time limit expired, or the intake was interrupted — so nothing is ' +
          'published',
        logPath: path.join(request.dir, 'reviewer.log'),
        shutdown,
      };
    },
  };
}

function phaseFor(parts: {
  readonly record: FakeRecord;
  /** A scripted answer, or a reviewer function a test drives itself. */
  readonly reviewer: ScriptedReviewer | BaselineReview;
  readonly workDir: string;
  readonly readyStatus?: string;
  readonly reviewStatus?: string;
  readonly project?: string;
}): { readonly diagnosis: ReturnType<typeof createBaselineDiagnosis>; readonly out: string[] } {
  const out: string[] = [];
  const reviewer = typeof parts.reviewer === 'function' ? parts.reviewer : parts.reviewer.review;
  return {
    out,
    diagnosis: createBaselineDiagnosis({
      reviewer,
      record: parts.record,
      readyStatus: parts.readyStatus ?? 'To Do',
      reviewStatus: parts.reviewStatus ?? 'In Review',
      reviewerTimeoutMs: 60_000,
      project: parts.project ?? PROJECT,
      workDir: parts.workDir,
      io: { out: (text) => out.push(text), err: (text) => out.push(text) },
    }),
  };
}

/** The real pre-delivery reviewer turn over the stand-in runtime. */
function reviewerFor(target: LocalTarget, plans: readonly unknown[]): BaselineReview {
  return createBaselineReviewer({
    selection: { runtime: 'codex', command: [target.runtimePath] },
    environment: {
      ...process.env,
      FAKE_CODEX: JSON.stringify({ stateDir: target.state.dir, plans }),
    },
  });
}

/**
 * Waits until the stand-in runtime has recorded its turn, so a test can stop a
 * reviewer turn while it is really running.
 */
async function waitForTurnRecorded(state: LocalTarget['state']): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await fakeTurns(state)).length > 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('the stand-in runtime never recorded a turn');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function requestFor(baseline: CheckRoundResult = redBaseline()): {
  readonly item: {
    readonly ref: SourceRef;
    readonly task: Task;
    readonly pointers: readonly string[];
  };
  readonly workspace: {
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly branch: string;
    readonly baseCommit: string;
  };
  readonly baseline: CheckRoundResult;
  readonly stop: AbortSignal;
} {
  const ref = refFor();
  return {
    item: { ref, task: taskFor(ref), pointers: [] },
    workspace: {
      workspaceId: ref.key,
      workspacePath: `/workspaces/${ref.key}`,
      branch: `harness/${ref.key}`,
      baseCommit: BASE,
    },
    baseline,
    stop: new AbortController().signal,
  };
}

const REPAIR_FINDING: BaselineFinding = {
  outcome: 'repair',
  failingCheck: '["npm","run","validate"]',
  evidence: 'the load test timed out on the shared machine',
  likelyCause: 'the fixture waits for a fixed 30 seconds',
  repairGuidance: 'make the fixture wait for the condition instead of the clock',
};

const INCONCLUSIVE_FINDING: BaselineFinding = {
  outcome: 'inconclusive',
  reason: 'the check fails because the host has no docker daemon',
  requiredAction: 'provide a host with docker, or move the check to the CI workflow',
};

/**
 * The outcome the real reviewer turn records before anything is published:
 * `outcome.json` beside the evidence, holding the finding that turn validated.
 * A fixture whose reviewer is scripted has to leave it too — a marker on the
 * thread may return the item for repair only when this record holds the
 * actionable finding the marker names, and the finding a continuation is handed
 * comes from it rather than from the turn's own finding file.
 */
async function writeTurnFinding(
  workDir: string,
  evidenceId: string,
  finding: BaselineFinding = REPAIR_FINDING,
  project: string = PROJECT,
): Promise<void> {
  await writeJsonFile(path.join(workDir, 'baseline', project, evidenceId), 'outcome.json', {
    version: 1,
    state: 'finding',
    finding,
  });
}

describe('the pre-delivery baseline diagnosis', () => {
  it('publishes one actionable comment and returns the same ticket to its ready status', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });
    const request = requestFor();

    const outcome = await diagnosis.diagnose(request);

    expect(outcome.kind).toBe('repair');
    expect(reviewer.requests).toEqual([
      {
        dir: path.join(
          workDir,
          'baseline',
          PROJECT,
          baselineEvidenceId(refFor(), BASE, request.baseline),
        ),
        base: BASE,
      },
    ]);
    expect(record.posted).toHaveLength(1);
    const comment = record.posted[0]?.join('\n') ?? '';
    // One concise comment: the failing check, the evidence, the likely cause
    // and the repair guidance, under a marker that makes it the dedup record.
    expect(comment).toContain(
      `(${BASELINE_MARKER_PREFIX}repair:${baselineEvidenceId(refFor(), BASE, request.baseline)}, written by the Nexus harness)`,
    );
    expect(comment).toContain('Failing check: ["npm","run","validate"]');
    expect(comment).toContain('Evidence: the load test timed out on the shared machine');
    expect(comment).toContain('Likely cause: the fixture waits for a fixed 30 seconds');
    expect(comment).toContain(
      'Repair guidance: make the fixture wait for the condition instead of the clock',
    );
    expect(comment).toContain('Returned to "To Do" with its workspace pointer preserved');
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'To Do' }]);
    expect(record.notes).toHaveLength(1);
  });

  it('leaves an inconclusive ticket In Review with the evidence and what a person must do', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const reviewer = scriptedReviewer(INCONCLUSIVE_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(requestFor());

    expect(outcome.kind).toBe('attention');
    const comment = record.posted[0]?.join('\n') ?? '';
    expect(comment).toContain('no repair is actionable');
    expect(comment).toContain(
      'Why no repair: the check fails because the host has no docker daemon',
    );
    expect(comment).toContain(
      'Required action: provide a host with docker, or move the check to the CI workflow',
    );
    expect(comment).toContain('stays in "In Review" for a person');
    expect(record.status).toBe('In Review');
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'In Review' }]);
  });

  it('turns a failed reviewer turn into an In Review record, never into a guessed repair', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const reviewer = scriptedReviewer(null, 'the reviewer launch was unavailable');
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(requestFor());

    expect(outcome.kind).toBe('attention');
    const comment = record.posted[0]?.join('\n') ?? '';
    expect(comment).toContain(`${BASELINE_MARKER_PREFIX}attention:`);
    expect(comment).toContain('the reviewer launch was unavailable');
    expect(comment).toContain('Required action:');
    expect(record.status).toBe('In Review');
  });

  it('refuses a reviewer launch that would widen its writable roots, and leaves the ticket In Review', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const target = await createLocalTarget({ brokenBaseline: true });
    const retained = await retainedWorkspace(workDir, [baselineAttempt()]);
    // The configured reviewer prefix grants a root covering the retained
    // working copy the later attempt continues and the harness's own evidence
    // directory: a write it let through could not be undone by the checks the
    // diagnosis makes after the turn, so no turn is started at all.
    const reviewer = createBaselineReviewer({
      selection: {
        runtime: 'codex',
        command: [target.runtimePath, '--add-dir', retained.workspacePath],
      },
      environment: {
        ...process.env,
        FAKE_CODEX: JSON.stringify({
          stateDir: target.state.dir,
          plans: [{ finding: JSON.stringify(REPAIR_FINDING) }],
        }),
      },
    });
    const diagnosis = createBaselineDiagnosis({
      reviewer,
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });
    const request = {
      item: { ref: refFor(), task: taskFor() },
      workspace: {
        workspaceId: retained.workspaceId,
        workspacePath: retained.workspacePath,
        branch: `harness/${retained.workspaceId}`,
        baseCommit: retained.base,
      },
      baseline: await baselineWithLogs(),
      stop: new AbortController().signal,
    };

    const outcome = await diagnosis.diagnose(request);

    expect(outcome.kind).toBe('attention');
    expect(record.status).toBe('In Review');
    const comment = record.posted[0]?.join('\n') ?? '';
    expect(comment).toContain(`${BASELINE_MARKER_PREFIX}attention:`);
    expect(comment).toContain('--add-dir');
    expect(comment).toContain('Required action:');
    // Nothing was started to receive the grant, and the retained workspace is
    // exactly what it was: a person decides what happens next.
    expect(await fakeTurns(target.state)).toEqual([]);
    expect(git(retained.workspacePath, 'status', '--porcelain').trim()).toBe('');

    // A restart resumes from the retained evidence and the ticket's own thread:
    // no second comment, no reviewer turn, and the item stays In Review.
    const resumed = await diagnosis.diagnose(request);
    expect(resumed.kind).toBe('attention');
    expect(record.posted).toHaveLength(1);
    expect(await fakeTurns(target.state)).toEqual([]);
  }, 60_000);

  it('does not repeat a comment or a reviewer turn for unchanged evidence', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const request = requestFor();
    const evidenceId = baselineEvidenceId(refFor(), BASE, request.baseline);
    // What the earlier invocation's turn recorded before it published this
    // evidence's comment: the accepted finding the marker is held against.
    await writeTurnFinding(workDir, evidenceId);
    record.notes.push({
      id: 'c7',
      createdAt: '2026-09-21T10:04:00.000Z',
      text:
        `HARN-38: the configured baseline checks failed (${BASELINE_MARKER_PREFIX}repair:${evidenceId}, ` +
        'written by the Nexus harness).',
    });
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(request);

    expect(outcome).toEqual({
      kind: 'repair',
      detail: expect.stringContaining('already diagnosed (comment c7)') as unknown as string,
      commentId: 'c7',
    });
    expect(reviewer.requests).toEqual([]);
    expect(record.posted).toEqual([]);
    // The item had not been moved yet: the resumed pass makes that one move.
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'To Do' }]);
    // The evidence is closed with the outcome its own record holds.
    expect((await evidenceRecordFor(workDir, PROJECT)).record['closed']).toBe('repair');
  });

  /**
   * What an interrupted invocation leaves behind when its reviewer turn was
   * rejected with an unconfirmed stop: the recorded outcome beside the
   * evidence, and the attention comment it published before the status move
   * failed or the coordinator was interrupted.
   */
  async function interruptedAttentionEvidence(
    workDir: string,
    record: FakeRecord,
    shutdown: BaselineReviewResult['shutdown'],
  ): Promise<ReturnType<typeof requestFor>> {
    const request = requestFor();
    const evidenceId = baselineEvidenceId(refFor(), BASE, request.baseline);
    const dir = path.join(workDir, 'baseline', PROJECT, evidenceId);
    await mkdir(dir, { recursive: true });
    await writeJsonFile(dir, 'outcome.json', {
      version: 1,
      state: 'rejected',
      problem: 'the reviewer turn was stopped before it produced a finding',
      shutdown,
    });
    record.notes.push({
      id: 'c7',
      createdAt: '2026-09-21T10:04:00.000Z',
      text: `(${BASELINE_MARKER_PREFIX}attention:${evidenceId}, written by the Nexus harness)`,
    });
    return request;
  }

  it('reads the recorded unconfirmed stop back when it resumes an existing comment', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const request = await interruptedAttentionEvidence(workDir, record, {
      termination: 'unconfirmed',
      problem: 'the host could not reach the process tree',
    });
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    // The status move this restart retries fails: the resume reports what the
    // record says instead of releasing the lock while something the reviewer
    // runtime started may still be writing.
    record.moveFailure = 'the transition was refused';
    const refused = await diagnosis.diagnose(request);
    expect(refused.kind).toBe('attention');
    expect((refused as { cleanupConfirmed: boolean }).cleanupConfirmed).toBe(false);
    expect(reviewer.requests).toEqual([]);
    expect(record.posted).toEqual([]);

    // And when the move succeeds, the same recorded stop travels with the
    // finding it deduplicates: one move, no second comment, no second turn.
    record.moveFailure = null;
    const resumed = await diagnosis.diagnose(request);
    expect(resumed.kind).toBe('attention');
    expect((resumed as { cleanupConfirmed: boolean }).cleanupConfirmed).toBe(false);
    expect((resumed as { detail: string }).detail).toContain('the intake lock is kept');
    expect(reviewer.requests).toEqual([]);
    expect(record.posted).toEqual([]);
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'In Review' }]);
    expect(record.status).toBe('In Review');
  });

  it('releases the lock when the recorded rejection confirmed its stop', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const request = await interruptedAttentionEvidence(workDir, record, {
      termination: 'confirmed',
      problem: null,
    });
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const resumed = await diagnosis.diagnose(request);

    expect(resumed.kind).toBe('attention');
    expect((resumed as { cleanupConfirmed: boolean }).cleanupConfirmed).toBe(true);
    expect(reviewer.requests).toEqual([]);
    expect(record.posted).toEqual([]);
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'In Review' }]);
  });

  it('never returns a rejected turn to the ready status, however its comment is marked', async () => {
    // The publication retry this rules out: the reviewer turn wrote a valid
    // finding and then failed, so the record beside its evidence is a rejection;
    // the attention comment it published is on the thread, and someone edited
    // that comment's marker into a repair marker. The marker names the evidence,
    // never the outcome, so the restart makes the move the recorded outcome
    // asks for — In Review — and no developer is ever started from the rejected
    // turn's own finding file.
    const workDir = await createTempDir();
    const record = fakeRecord();
    const request = requestFor();
    const evidenceId = baselineEvidenceId(refFor(), BASE, request.baseline);
    const dir = path.join(workDir, 'baseline', PROJECT, evidenceId);
    await writeJsonFile(dir, 'outcome.json', {
      version: 1,
      state: 'rejected',
      problem: 'the reviewer turn for HARN-38 failed after it wrote its finding',
      shutdown: { termination: 'confirmed', problem: null },
    });
    await mkdir(path.dirname(baselineFindingPath(dir)), { recursive: true });
    await writeFile(baselineFindingPath(dir), `${JSON.stringify(REPAIR_FINDING)}\n`, 'utf8');
    record.notes.push({
      id: 'c7',
      createdAt: '2026-09-21T10:04:00.000Z',
      text:
        `HARN-38: the configured baseline checks failed (${BASELINE_MARKER_PREFIX}repair:${evidenceId}, ` +
        'written by the Nexus harness).',
    });
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(request);

    expect(outcome.kind).toBe('attention');
    expect((outcome as { commentId: string | null }).commentId).toBe('c7');
    expect((outcome as { detail: string }).detail).toContain(
      'the outcome recorded for that evidence is not the actionable finding it names',
    );
    expect(reviewer.requests).toEqual([]);
    expect(record.posted).toEqual([]);
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'In Review' }]);
    expect(record.status).toBe('In Review');
    // The evidence is closed as what its own record really says, so the
    // workspace's next claim is never handed the rejected turn's finding file.
    expect((await evidenceRecordFor(workDir, PROJECT)).record['closed']).toBe('attention');
    expect(await diagnosis.reviewedFinding(refFor().key, new AbortController().signal)).toEqual({
      kind: 'none',
    });
  });

  it('hands no continuation the finding file of a turn whose own outcome rejected it', async () => {
    // The end state the marker used to be able to leave behind, planted
    // directly: the evidence is closed as a repair, the record beside it is a
    // rejection, and the failed turn's own finding file is still there. What a
    // developer would be handed used to be that file; it is the recorded
    // outcome that decides, and this record supplies no actionable finding, so
    // no developer is started from it.
    const workDir = await createTempDir();
    const request = requestFor();
    const evidenceId = baselineEvidenceId(refFor(), BASE, request.baseline);
    const dir = path.join(workDir, 'baseline', PROJECT, evidenceId);
    await writeJsonFile(dir, 'evidence.json', {
      version: 1,
      evidenceId,
      project: PROJECT,
      ref: refFor(),
      task: taskFor(),
      workspace: {
        workspaceId: refFor().key,
        workspacePath: `/workspaces/${refFor().key}`,
        branch: `harness/${refFor().key}`,
        baseCommit: BASE,
      },
      baseline: request.baseline,
      closed: 'repair',
      closedAt: '2026-09-21T10:06:00.000Z',
    });
    await writeJsonFile(dir, 'outcome.json', {
      version: 1,
      state: 'rejected',
      problem: 'the reviewer turn for HARN-38 was stopped before it produced a finding',
      shutdown: { termination: 'confirmed', problem: null },
    });
    await mkdir(path.dirname(baselineFindingPath(dir)), { recursive: true });
    await writeFile(baselineFindingPath(dir), `${JSON.stringify(REPAIR_FINDING)}\n`, 'utf8');
    const { diagnosis } = phaseFor({
      record: fakeRecord(),
      reviewer: scriptedReviewer(REPAIR_FINDING),
      workDir,
    });

    const recovered = await diagnosis.reviewedFinding(refFor().key, new AbortController().signal);

    expect(recovered.kind).toBe('unreadable');
    expect((recovered as { detail: string }).detail).toContain(
      'the outcome its reviewer turn recorded there cannot be read back: it is a rejection',
    );
    expect((recovered as { detail: string }).detail).toContain(
      'the reviewer turn for HARN-38 was stopped before it produced a finding',
    );
  });

  it('does not move an item a person already took out of the running status', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord('To Do');
    const request = requestFor();
    const evidenceId = baselineEvidenceId(refFor(), BASE, request.baseline);
    // The marker is real — the evidence's own record holds the actionable
    // finding it names — and the item is still exactly where the person put it.
    await writeTurnFinding(workDir, evidenceId);
    record.notes.push({
      id: 'c9',
      createdAt: '2026-09-21T10:04:00.000Z',
      text: `(${BASELINE_MARKER_PREFIX}repair:${evidenceId}, written by the Nexus harness)`,
    });
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(request);

    expect(outcome.kind).toBe('repair');
    expect(record.moves).toEqual([]);
    expect(record.status).toBe('To Do');
  });

  it('diagnoses changed evidence again', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const request = requestFor();
    // The same item, a different snapshot: new evidence, a new reviewer turn.
    const other = baselineEvidenceId(refFor(), 'b'.repeat(40), request.baseline);
    record.notes.push({
      id: 'c7',
      createdAt: '2026-09-21T10:04:00.000Z',
      text: `(${BASELINE_MARKER_PREFIX}repair:${other}, written by the Nexus harness)`,
    });
    const reviewer = scriptedReviewer(INCONCLUSIVE_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(request);

    expect(outcome.kind).toBe('attention');
    expect(reviewer.requests).toHaveLength(1);
    expect(record.posted).toHaveLength(1);
  });

  it('moves nothing when the comment cannot be confirmed on the issue', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    record.commentFailure = 'the connection dropped';
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(requestFor());

    expect(outcome.kind).toBe('attention');
    expect((outcome as { detail: string }).detail).toContain('the connection dropped');
    expect(record.moves).toEqual([]);
    expect(record.status).toBe('In Progress');
  });

  it('keeps the comment and stops when the status move fails', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    record.moveFailure = 'the transition was refused';
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(requestFor());

    expect(outcome.kind).toBe('attention');
    expect((outcome as { detail: string }).detail).toContain('the transition was refused');
    expect((outcome as { commentId: string | null }).commentId).toBe('c1');
    expect(record.posted).toHaveLength(1);
    expect(record.status).toBe('In Progress');
  });

  it('starts no reviewer turn when the thread cannot be read', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    record.threadFailure = 'the site refused the read';
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(requestFor());

    expect(outcome.kind).toBe('attention');
    expect(reviewer.requests).toEqual([]);
    expect(record.moves).toEqual([]);
  });

  it('reports a stop it was given instead of writing a diagnosis', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });
    const controller = new AbortController();
    controller.abort(new Error('the user interrupted intake'));

    const outcome = await diagnosis.diagnose({ ...requestFor(), stop: controller.signal });

    expect(outcome.kind).toBe('cancelled');
    expect(reviewer.requests).toEqual([]);
    expect(record.posted).toEqual([]);
  });

  it('records an interrupt that lands during the reviewer turn and leaves the item In Review', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const controller = new AbortController();
    const reviewer = interruptibleReviewer({ termination: 'confirmed', problem: null });
    const { diagnosis } = phaseFor({ record, reviewer: reviewer.review, workDir });

    const diagnosing = diagnosis.diagnose({
      ...requestFor(await baselineWithLogs()),
      stop: controller.signal,
    });
    // The turn really is running when the caller stops the intake, which is the
    // window an already-aborted request and a reviewer timeout do not cover.
    await reviewer.started;
    controller.abort(new Error('the user interrupted intake'));
    const outcome = await diagnosing;

    // The ticket the run claimed is not stranded in the running status: the
    // interruption is what this evidence's one comment records, and the item
    // waits In Review for a person. No repair is guessed at, and a confirmed
    // stop releases the intake lock as it always did.
    expect(outcome.kind).toBe('attention');
    if (outcome.kind === 'attention') {
      expect(outcome.cleanupConfirmed).toBe(true);
    }
    expect(record.status).toBe('In Review');
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'In Review' }]);
    expect(record.posted).toHaveLength(1);
    const comment = record.posted[0]?.join('\n') ?? '';
    expect(comment).toContain(`${BASELINE_MARKER_PREFIX}attention:`);
    expect(comment).toContain('the intake was stopped while the one baseline reviewer turn');
    expect(comment).toContain('no coding turn was started');
    // The evidence is settled: a restart neither runs the reviewer again nor
    // writes a second comment for unchanged evidence.
    expect((await evidenceRecordFor(workDir, PROJECT)).record['closed']).toBe('attention');
    const restartReviewer = scriptedReviewer(REPAIR_FINDING);
    const restart = phaseFor({ record, reviewer: restartReviewer, workDir });
    const again = await restart.diagnosis.diagnose({
      ...requestFor(await baselineWithLogs()),
      stop: new AbortController().signal,
    });
    expect(again.kind).toBe('attention');
    expect(record.posted).toHaveLength(1);
    expect(restartReviewer.requests).toEqual([]);
  });

  it('keeps the intake lock when an interrupted reviewer turn could not confirm its stop', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const controller = new AbortController();
    const reviewer = interruptibleReviewer({
      termination: 'unconfirmed',
      problem: 'the host could not reach the process tree',
    });
    const { diagnosis } = phaseFor({ record, reviewer: reviewer.review, workDir });

    const diagnosing = diagnosis.diagnose({
      ...requestFor(await baselineWithLogs()),
      stop: controller.signal,
    });
    await reviewer.started;
    controller.abort(new Error('the user interrupted intake'));
    const outcome = await diagnosing;

    // The interruption is recorded, and everything the reviewer runtime started
    // was not seen to end: the item is In Review and the intake lock is kept.
    expect(outcome.kind).toBe('attention');
    if (outcome.kind === 'attention') {
      expect(outcome.cleanupConfirmed).toBe(false);
    }
    expect(record.status).toBe('In Review');
    const comment = record.posted[0]?.join('\n') ?? '';
    expect(comment).toContain('was not seen to end');
    expect(comment).toContain('the intake lock is kept');
  });

  it('finishes the move when the interruption lands as the finding is published', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const controller = new AbortController();
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });
    // The caller stops the intake in the moment its own comment is published:
    // the reviewer turn itself already finished, so the finding is what the
    // issue is told, and the one move that still has to happen runs under the
    // same bounded deadline instead of the aborted signal.
    const posting = record.postComment.bind(record);
    record.postComment = async (id, paragraphs, stop) => {
      const commentId = await posting(id, paragraphs, stop);
      controller.abort(new Error('the user interrupted intake'));
      return commentId;
    };

    const outcome = await diagnosis.diagnose({
      ...requestFor(await baselineWithLogs()),
      stop: controller.signal,
    });

    expect(outcome.kind).toBe('repair');
    expect(record.status).toBe('To Do');
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'To Do' }]);
    expect(record.posted).toHaveLength(1);
  });

  it('bounds the one reviewer turn instead of waiting for it forever', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    let bounded = false;
    const reviewer: BaselineReview = async (request) => {
      await new Promise<void>((resolve) => {
        if (request.stop.aborted) {
          resolve();
          return;
        }
        request.stop.addEventListener('abort', () => resolve(), { once: true });
      });
      bounded = request.stop.aborted;
      return {
        summary: null,
        finding: null,
        problem: 'the turn was stopped before it produced a finding',
        logPath: path.join(request.dir, 'reviewer.log'),
        shutdown: { termination: 'confirmed', problem: null },
      };
    };
    const diagnosis = createBaselineDiagnosis({
      reviewer,
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 20,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    const outcome = await diagnosis.diagnose(requestFor());

    expect(bounded).toBe(true);
    expect(outcome.kind).toBe('attention');
    expect(record.status).toBe('In Review');
  });

  it('carries an unconfirmed reviewer stop to its caller with the evidence kept', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const reviewer = scriptedReviewer(null, 'the reviewer turn was stopped', {
      termination: 'unconfirmed',
      problem: 'the host could not reach the process tree',
    });
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const outcome = await diagnosis.diagnose(requestFor(await baselineWithLogs()));

    expect(outcome.kind).toBe('attention');
    if (outcome.kind === 'attention') {
      // The caller must not release its intake lock while the reviewer runtime
      // it started may still be running.
      expect(outcome.cleanupConfirmed).toBe(false);
    }
    expect(record.status).toBe('In Review');
    const comment = record.posted[0]?.join('\n') ?? '';
    expect(comment).toContain(`${BASELINE_MARKER_PREFIX}attention:`);
    expect(comment).toContain('was not seen to end');
    expect(comment).toContain('the intake lock is kept');
  });

  it('keeps the lock when the bounded reviewer timeout cannot confirm its stop', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const target = await createLocalTarget({ brokenBaseline: true });
    const retained = await retainedWorkspace(workDir, [baselineAttempt()]);
    const reviewer = createBaselineReviewer({
      selection: { runtime: 'codex', command: [target.runtimePath] },
      environment: {
        ...process.env,
        FAKE_CODEX: JSON.stringify({
          stateDir: target.state.dir,
          plans: [{ holdMs: 30_000, summary: 'still working' }],
        }),
      },
      // The turn's own limit ends it, and the host cannot carry the stop out:
      // nothing of the runtime was seen to end, so nothing is reported as ended.
      runtime: {
        stopTree: async () => 'the host could not reach the process tree',
        stopGraceMs: 60,
      },
    });
    const diagnosis = createBaselineDiagnosis({
      reviewer,
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 2_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    const diagnosing = diagnosis.diagnose({
      item: { ref: refFor(), task: taskFor() },
      workspace: {
        workspaceId: retained.workspaceId,
        workspacePath: retained.workspacePath,
        branch: `harness/${retained.workspaceId}`,
        baseCommit: retained.base,
      },
      baseline: await baselineWithLogs(),
      stop: new AbortController().signal,
    });
    await waitForTurnRecorded(target.state);
    const outcome = await diagnosing;

    // The runtime the harness could not stop is this test's own to release, and
    // it is released before anything is asserted: an assertion that fails must
    // not leave it holding its working directory for the suite's teardown.
    const [turn] = await fakeTurns(target.state);
    expect(
      await endFixtureTree({
        pid: turn?.pid ?? 0,
        token: turn?.pidToken ?? null,
        beaconDirectory: target.state.dir,
      }),
    ).toBe(true);

    expect(outcome.kind).toBe('attention');
    if (outcome.kind === 'attention') {
      expect(outcome.cleanupConfirmed).toBe(false);
    }
    expect(record.status).toBe('In Review');
    const comment = record.posted[0]?.join('\n') ?? '';
    expect(comment).toContain(`${BASELINE_MARKER_PREFIX}attention:`);
    expect(comment).toContain('time limit expired');
    expect(comment).toContain('the intake lock is kept');
  }, 60_000);
});

describe('the baseline reviewer turn', () => {
  /** One evidence directory with the check output the prompt quotes. */
  async function evidenceFor(): Promise<{
    readonly dir: string;
    readonly baseline: CheckRoundResult;
  }> {
    const dir = await createTempDir();
    const stdoutPath = path.join(dir, 'baseline-check-1.stdout.log');
    const stderrPath = path.join(dir, 'baseline-check-1.stderr.log');
    await writeFile(
      stdoutPath,
      'running test/greet.test.mjs (pid 1)\nFAILED test/greet.test.mjs (exit code 1)\n',
      'utf8',
    );
    await writeFile(stderrPath, 'greet: expected "Hello, Ada!", received "Hi"\n', 'utf8');
    return {
      dir: path.join(dir, 'baseline-diagnosis'),
      baseline: redBaseline({
        setup: [commandFor({ command: [process.execPath, 'tools/prepare.mjs'], exitCode: 0 })],
        checks: [
          commandFor({
            command: [process.execPath, 'tools/run-checks.mjs'],
            stdoutPath,
            stderrPath,
          }),
        ],
      }),
    };
  }

  it('inspects a read-only snapshot of the workspace and validates the finding it wrote', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const reviewer = reviewerFor(target, [
      {
        inspectEnvironment: ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'],
        finding: JSON.stringify(REPAIR_FINDING),
      },
    ]);

    const result = await reviewer({
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    });

    expect(result.problem).toBeNull();
    expect(result.finding).toEqual(REPAIR_FINDING);
    // The turn created its own writable working root, and the finding file it
    // was asked to write is still there.
    expect(existsSync(path.join(dir, 'turn', 'finding.json'))).toBe(true);
    // The turn really ran, in its own working root — outside the snapshot, and
    // outside the retained workspace — under the narrower filesystem policy, so
    // the launch itself is what makes what it inspects read-only.
    const turns = await fakeTurns(target.state);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.cwd).toBe(path.join(dir, 'turn'));
    const argv = turns[0]?.argv ?? [];
    const sandbox = argv.indexOf('--sandbox');
    expect(sandbox).toBeGreaterThanOrEqual(0);
    expect(argv[sandbox + 1]).toBe('workspace-write');
    expect(argv).not.toContain('danger-full-access');
    // The policy's writable roots are the turn's own working root: the
    // additional roots the launch would otherwise inherit are stated as none,
    // and the host's temporary roots are excluded, so neither a `workDir`
    // beneath one nor a root the configured launch grants can put the retained
    // working copy or the snapshot inside a writable root.
    expect(argv).toContain('sandbox_workspace_write.writable_roots=[]');
    expect(argv).toContain('sandbox_workspace_write.exclude_tmpdir_env_var=true');
    expect(argv).toContain('sandbox_workspace_write.exclude_slash_tmp=true');
    // This fixture is that supported configuration: its evidence directory —
    // with the snapshot, the turn's working root, and the retained workspace's
    // sibling evidence — really does sit beneath the host's temporary
    // directory, so the exclusion is what keeps the two inspected trees out of
    // the launch's writable roots here.
    expect(path.relative(os.tmpdir(), dir).startsWith('..')).toBe(false);
    expect(turns[0]?.argv.at(-2)).toBe('--skip-git-repo-check');
    // The turn's own environment tells git that the pinned snapshot is a
    // repository it may read: the sandbox runs its commands under another
    // identity on Windows, which git otherwise refuses outright.
    expect(turns[0]?.environmentPresent['GIT_CONFIG_KEY_0']).toBe(true);
    expect(turns[0]?.environmentPresent['GIT_CONFIG_VALUE_0']).toBe(true);
    expect(existsSync(path.join(dir, 'repo', '.git'))).toBe(true);
    expect(git(path.join(dir, 'repo'), 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(git(target.repo, 'status', '--porcelain').trim()).toBe('');

    // The prompt carries the commands, the bounded evidence, the snapshot, and
    // the finding contract — and no coding instruction.
    const prompt = turns[0]?.prompt ?? '';
    expect(prompt).toBe(await readFile(path.join(dir, 'input.md'), 'utf8'));
    expect(prompt).toContain(JSON.stringify([process.execPath, 'tools/run-checks.mjs']));
    expect(prompt).toContain('FAILED test/greet.test.mjs (exit code 1)');
    expect(prompt).toContain('greet: expected "Hello, Ada!", received "Hi"');
    expect(prompt).toContain(`detached at the exact commit the baseline ran against (${base})`);
    expect(prompt).toContain('do not implement the repair');
    expect(prompt).toContain('"repairGuidance"');
    expect(prompt).toContain('"requiredAction"');
    expect(prompt).toContain(path.join(dir, 'turn', 'finding.json'));
  });

  it('refuses a configured launch that would grant the turn a writable root', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    // The grant names the retained working copy's own directory: with that root
    // writable, the reviewer could change the working copy a later attempt
    // continues, and no check after the turn could undo it. The switch is
    // applied beside the policy rather than through one of its configuration
    // keys, so the launch's own overrides cannot take it back (probed against
    // the installed CLI with `codex debug prompt-input`).
    const reviewer = createBaselineReviewer({
      selection: {
        runtime: 'codex',
        command: [target.runtimePath, '--add-dir', path.dirname(target.repo)],
      },
      environment: {
        ...process.env,
        FAKE_CODEX: JSON.stringify({
          stateDir: target.state.dir,
          plans: [{ finding: JSON.stringify(REPAIR_FINDING) }],
        }),
      },
    });

    const result = await reviewer({
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    });

    // No reviewer turn was started at all: nothing received the grant, and the
    // finding the scripted plan would have written does not exist.
    expect(await fakeTurns(target.state)).toEqual([]);
    expect(existsSync(path.join(dir, 'turn', 'finding.json'))).toBe(false);
    expect(result.finding).toBeNull();
    expect(result.problem).toContain('--add-dir');
    expect(result.problem).toContain('was not started');
    // The rejection is the recorded outcome a restart reuses, so the same
    // evidence never spends a second turn and never publishes a finding.
    const recorded = await readBaselineOutcome(dir);
    expect(recorded?.state).toBe('rejected');
    if (recorded?.state === 'rejected') {
      expect(recorded.problem).toContain('--add-dir');
    }
    // Neither tree the turn must not change was touched.
    expect(git(path.join(dir, 'repo'), 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(git(target.repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('accepts an inconclusive finding and reports a turn that wrote none', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const request = {
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    };

    const inconclusive = await reviewerFor(target, [
      { finding: JSON.stringify(INCONCLUSIVE_FINDING) },
    ])(request);
    expect(inconclusive.problem).toBeNull();
    expect(inconclusive.finding).toEqual(INCONCLUSIVE_FINDING);

    const second = await createTempDir();
    const secondDir = path.join(second, 'diagnosis');
    const missing = await reviewerFor(target, [{}])({ ...request, dir: secondDir });
    expect(missing.finding).toBeNull();
    expect(missing.problem).toContain('wrote no usable finding.json');
  });

  it('refuses a finding from a turn that changed the snapshot it was given', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const reviewer = reviewerFor(target, [
      {
        edits: [{ file: '../repo/NOTES.md', text: 'the reviewer wrote into the snapshot\n' }],
        finding: JSON.stringify(REPAIR_FINDING),
      },
    ]);

    const result = await reviewer({
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    });

    expect(result.finding).toBeNull();
    expect(result.problem).toContain('changed the snapshot');
    // The retained workspace is untouched: the turn never saw it.
    expect(git(target.repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('reuses the finding an interrupted turn already wrote, without a second turn', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const request = {
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    };

    const first = await reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING) }])(request);
    expect(first.finding).toEqual(REPAIR_FINDING);

    // The invocation that ran that turn stopped before the finding reached the
    // ticket. The evidence is picked up again, and what it already holds is what
    // comes back: the same snapshot, the same commands, the same results, one
    // turn.
    const second = await reviewerFor(target, [])(request);

    expect(second.problem).toBeNull();
    expect(second.finding).toEqual(REPAIR_FINDING);
    expect(await fakeTurns(target.state)).toHaveLength(1);
  });

  it('never publishes a finding the turn itself failed to produce, even on a restart', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const request = {
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    };

    // A turn that writes a valid finding and *then* reports that it failed:
    // the finding file is left behind exactly as a completed turn would leave
    // it, and only the turn's own ending says which of the two it was.
    const first = await reviewerFor(target, [
      { finding: JSON.stringify(REPAIR_FINDING), mode: 'failed' },
    ])(request);

    expect(first.finding).toBeNull();
    expect(first.problem).toContain('the turn failed');
    expect(existsSync(path.join(dir, 'turn', 'finding.json'))).toBe(true);
    // What the turn produced is recorded: a rejection, not the file it left.
    const recorded = JSON.parse(await readFile(path.join(dir, 'outcome.json'), 'utf8')) as {
      state?: string;
    };
    expect(recorded.state).toBe('rejected');

    // The restart a failed publication runs: the same evidence, no second
    // turn, and the recorded rejection reused. The finding file the failed
    // turn left is never read as if the turn had produced it.
    const second = await reviewerFor(target, [])(request);

    expect(second.finding).toBeNull();
    expect(second.problem).toContain('the turn failed');
    expect(second.problem).toContain('no second reviewer turn');
    expect(await fakeTurns(target.state)).toHaveLength(1);
  });

  it('refuses an interrupted turn that left a finding but no recorded outcome', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    // What an invocation killed between the turn's own write and the record of
    // its outcome leaves: the finding, and nothing saying the turn completed.
    await mkdir(path.join(dir, 'turn'), { recursive: true });
    await writeFile(path.join(dir, 'turn', 'finding.json'), JSON.stringify(REPAIR_FINDING), 'utf8');

    const result = await reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING) }])({
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    });

    expect(result.finding).toBeNull();
    expect(result.problem).toContain('left no recorded outcome');
    expect(result.problem).toContain('no second reviewer turn');
    expect(await fakeTurns(target.state)).toEqual([]);
  });

  it('refuses an interrupted turn that wrote no finding instead of running it again', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    // What a turn stopped mid-flight leaves: its own log, and no finding.
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'reviewer.log'), '# the turn started\n', 'utf8');

    const result = await reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING) }])({
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    });

    expect(result.finding).toBeNull();
    expect(result.problem).toContain('no second reviewer turn');
    expect(await fakeTurns(target.state)).toEqual([]);
  });

  it('carries a recorded stop through a refusal reached before it re-reads the record', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const dir = await createTempDir();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const request = {
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      // The plain fixture's check logs were never written: this invocation
      // refuses the evidence as incomplete before it would re-read the record
      // the earlier one left.
      baseline: redBaseline(),
      stop: new AbortController().signal,
    };
    // What an earlier invocation recorded for this exact evidence: its reviewer
    // runtime was not seen to end. The refusal below must not round that down to
    // a confirmed stop — the intake lock is what would be released.
    await writeJsonFile(dir, 'outcome.json', {
      version: 1,
      state: 'rejected',
      problem: 'the reviewer turn was stopped before it produced a finding',
      shutdown: {
        termination: 'unconfirmed',
        problem: 'the host could not reach the process tree',
      },
    });

    const refused = await reviewerFor(target, [])(request);

    expect(refused.finding).toBeNull();
    expect(refused.problem).toContain('cannot be read');
    expect(refused.shutdown).toEqual({
      termination: 'unconfirmed',
      problem: 'the host could not reach the process tree',
    });
    expect(await fakeTurns(target.state)).toEqual([]);

    // A record that is there and cannot be read at all fails closed the same
    // way: whether the earlier invocation's runtime was seen to end cannot then
    // be established, so the refusal carries the unconfirmed stop by name.
    const unreadable = await createTempDir();
    await writeFile(path.join(unreadable, 'outcome.json'), '{ not json\n', 'utf8');

    const failed = await reviewerFor(target, [])({ ...request, dir: unreadable });

    expect(failed.finding).toBeNull();
    expect(failed.problem).toContain('cannot be read');
    expect(failed.shutdown?.termination).toBe('unconfirmed');
    expect(failed.shutdown?.problem).toContain('cannot be read');
    expect(await fakeTurns(target.state)).toEqual([]);
  });

  it('refuses to diagnose a working copy the configured commands changed', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    // A setup or check command rewrote a tracked file before the failing check
    // ran, so the committed snapshot is no longer the tree the failure came
    // from: the reviewer would be shown the old file while the ticket says the
    // snapshot did not change.
    await writeFile(
      path.join(target.repo, 'src', 'greet.mjs'),
      'export function greet() {}\n',
      'utf8',
    );

    const result = await reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING) }])({
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    });

    expect(result.finding).toBeNull();
    expect(result.problem).toContain('not the snapshot the baseline ran against');
    expect(result.problem).toContain('src/greet.mjs');
    // Nothing was spent on evidence that cannot be attributed to a snapshot.
    expect(await fakeTurns(target.state)).toEqual([]);
  });

  it('refuses a finding from a turn that wrote into the retained workspace', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    // The turn's own working root, and a path from there into the working copy
    // the ticket's later attempts really use.
    const reach = path.relative(path.join(dir, 'turn'), path.join(target.repo, 'NOTES.md'));

    const result = await reviewerFor(target, [
      {
        edits: [{ file: reach, text: 'the reviewer wrote into the retained workspace\n' }],
        finding: JSON.stringify(REPAIR_FINDING),
      },
    ])({
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    });

    // The turn wrote its finding, and the harness refuses it anyway: the
    // working copy a later attempt would use is not what the turn was given.
    expect(existsSync(path.join(dir, 'turn', 'finding.json'))).toBe(true);
    expect(result.finding).toBeNull();
    expect(result.problem).toContain('did not leave the retained workspace as it found it');
    expect(git(target.repo, 'status', '--porcelain').trim()).toContain('NOTES.md');
  });

  it('reports a reviewer stop it could not confirm instead of a clean one', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const controller = new AbortController();
    const reviewer = createBaselineReviewer({
      selection: { runtime: 'codex', command: [target.runtimePath] },
      environment: {
        ...process.env,
        FAKE_CODEX: JSON.stringify({
          stateDir: target.state.dir,
          plans: [{ holdMs: 30_000, summary: 'still working' }],
        }),
      },
      // The host cannot carry the stop out, and the runtime does not end by
      // itself, so nothing of it was seen to end — never rounded down to a
      // confirmed stop. The process this leaves is this test's own to release.
      runtime: {
        stopTree: async () => 'the host could not reach the process tree',
        stopGraceMs: 60,
      },
    });

    const running = reviewer({
      dir,
      item: { ref: refFor(), task: taskFor() },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: controller.signal,
    });
    await waitForTurnRecorded(target.state);
    controller.abort();
    const result = await running;

    // The runtime the harness could not stop is this test's own to release, and
    // it is released before anything is asserted: an assertion that fails must
    // not leave it holding its working directory for the suite's teardown.
    const [turn] = await fakeTurns(target.state);
    expect(
      await endFixtureTree({
        pid: turn?.pid ?? 0,
        token: turn?.pidToken ?? null,
        beaconDirectory: target.state.dir,
      }),
    ).toBe(true);

    expect(result.finding).toBeNull();
    expect(result.problem).toContain('stopped before it produced a finding');
    expect(result.problem).toContain('could not confirm');
    expect(result.shutdown).toEqual({
      termination: 'unconfirmed',
      problem: 'the host could not reach the process tree',
    });
    // The rejection is recorded with the stop, so the invocation that finishes
    // this evidence pays for no second turn and keeps its intake lock.
    const recorded = JSON.parse(await readFile(path.join(dir, 'outcome.json'), 'utf8')) as {
      shutdown?: { termination?: string };
    };
    expect(recorded.shutdown?.termination).toBe('unconfirmed');
  }, 60_000);
});

describe('the evidence a diagnosis reads', () => {
  it('tells a log it cannot read apart from one the command left empty', async () => {
    // The plain fixture's log paths name files nothing wrote: the evidence is
    // incomplete, and the failing check is named by the paths that are missing.
    const missing = await baselineFailures(redBaseline());

    expect(missing.kind).toBe('incomplete');
    if (missing.kind === 'incomplete') {
      expect(missing.problem).toContain('/logs/baseline-check-1.stdout.log');
      expect(missing.problem).toContain('/logs/baseline-check-1.stderr.log');
    }

    // A log that really was written and really is empty is different: the
    // command said nothing, and that is evidence the reviewer may read.
    const dir = await createTempDir();
    const stdoutPath = path.join(dir, 'baseline-check-1.stdout.log');
    const stderrPath = path.join(dir, 'baseline-check-1.stderr.log');
    await writeFile(stdoutPath, '', 'utf8');
    await writeFile(stderrPath, '', 'utf8');
    const empty = await baselineFailures(
      redBaseline({ checks: [commandFor({ stdoutPath, stderrPath })] }),
    );

    expect(empty.kind).toBe('failures');
    if (empty.kind === 'failures') {
      expect(empty.failures).toHaveLength(1);
      expect(empty.failures[0]?.output).toContain('(no output was written)');
      expect(empty.failures[0]?.output).toContain(stdoutPath);
    }
  });

  it('leaves the ticket In Review with the missing paths instead of starting a reviewer', async () => {
    const workDir = await createTempDir();
    const target = await createLocalTarget({ brokenBaseline: true });
    const record = fakeRecord();
    const diagnosis = createBaselineDiagnosis({
      reviewer: reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING) }]),
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    const outcome = await diagnosis.diagnose(requestFor());

    expect(outcome.kind).toBe('attention');
    const comment = record.posted[0]?.join('\n') ?? '';
    expect(comment).toContain(`${BASELINE_MARKER_PREFIX}attention:`);
    expect(comment).toContain('/logs/baseline-check-1.stdout.log');
    expect(comment).toContain('Required action:');
    expect(record.status).toBe('In Review');
    // The evidence was incomplete, so no reviewer turn was paid for at all.
    expect(await fakeTurns(target.state)).toEqual([]);
  });

  it('carries a recorded reviewer stop through a refusal reached before any turn', async () => {
    const workDir = await createTempDir();
    const target = await createLocalTarget({ brokenBaseline: true });
    const record = fakeRecord();
    const diagnosis = createBaselineDiagnosis({
      reviewer: reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING) }]),
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    // What an earlier invocation left for this exact evidence: its reviewer
    // runtime was not seen to end, and the publication that outcome belonged to
    // never happened. The check logs are gone now, so this invocation refuses
    // before it would re-read that record — and the stop it recorded still has
    // to travel, because the runtime it names may still be writing.
    const baseline = redBaseline();
    const dir = path.join(
      workDir,
      'baseline',
      PROJECT,
      baselineEvidenceId(refFor(), BASE, baseline),
    );
    await writeJsonFile(dir, 'outcome.json', {
      version: 1,
      state: 'rejected',
      problem: 'the reviewer turn was stopped before it produced a finding',
      shutdown: {
        termination: 'unconfirmed',
        problem: 'the host could not reach the process tree',
      },
    });

    const outcome = await diagnosis.diagnose({ ...requestFor(baseline) });

    expect(outcome.kind).toBe('attention');
    expect((outcome as { readonly cleanupConfirmed: boolean }).cleanupConfirmed).toBe(false);
    expect(record.status).toBe('In Review');
    const comment = record.posted[0]?.join('\n') ?? '';
    expect(comment).toContain(`${BASELINE_MARKER_PREFIX}attention:`);
    expect(comment).toContain('was not seen to end');
    expect(comment).toContain('the host could not reach the process tree');
    // The refusal is the evidence being incomplete, not a new turn: nothing was
    // launched for it, and no second reviewer turn was spent.
    expect(await fakeTurns(target.state)).toEqual([]);
  });
});

describe('the finding file', () => {
  it('validates both documented shapes and refuses anything else', () => {
    expect(parseBaselineFinding(JSON.stringify(REPAIR_FINDING), 'finding.json')).toEqual(
      REPAIR_FINDING,
    );
    expect(parseBaselineFinding(JSON.stringify(INCONCLUSIVE_FINDING), 'finding.json')).toEqual(
      INCONCLUSIVE_FINDING,
    );
    expect(() => parseBaselineFinding('not json', 'finding.json')).toThrow(/not valid JSON/);
    expect(() =>
      parseBaselineFinding(
        JSON.stringify({ outcome: 'repair', failingCheck: 'x' }),
        'finding.json',
      ),
    ).toThrow(/carries no usable "failingCheck" or "evidence"/);
    expect(() =>
      parseBaselineFinding(JSON.stringify({ outcome: 'approve', findings: [] }), 'finding.json'),
    ).toThrow(/instead of "repair" or "inconclusive"/);
  });
});

describe('the reviewed finding one continued attempt is given', () => {
  const EVIDENCE_ID = baselineEvidenceId(refFor(), BASE, redBaseline());

  /** One realistic diagnosis comment: the fields near the width a finding may have. */
  function commentFor(evidenceId = EVIDENCE_ID): string {
    return [
      `${ISSUE_KEY}: the configured baseline checks failed before any coding turn, and the ` +
        `diagnosis is actionable (${BASELINE_MARKER_PREFIX}repair:${evidenceId}, written by the ` +
        'Nexus harness).',
      'Failing check: ["npm","run","validate"]',
      `Evidence: ${'the load test spawned two hundred workers and timed out; '.repeat(10).slice(0, 520)}`,
      `Likely cause: ${'the fixture waits for a fixed thirty seconds on a machine that is shared. '.repeat(9).slice(0, 520)}`,
      `Repair guidance: ${'wait for the condition instead of the clock, and give the suite a per-test timeout that reflects a loaded machine. '.repeat(8).slice(0, 520)}`,
      'Returned to "To Do" with its workspace pointer preserved: the next claim continues the same ' +
        'retained workspace.',
    ].join('\n');
  }

  it('accepts only the whole comment, and carries every field of it whole', () => {
    const comment = commentFor();

    const finding = baselineCommentFinding(comment);

    // The comment is this evidence's finding, and the ordering requirement is
    // its first line: the baseline is repaired before the original task.
    expect(finding?.evidenceId).toBe(EVIDENCE_ID);
    expect(finding?.lines[0]).toBe(
      'reviewed baseline finding — repair the baseline before continuing the original task',
    );
    // Each field is its own line, at the width the comment itself wrote, so the
    // collapsed-comment truncation cannot eat the cause and the repair.
    for (const field of ['failing check', 'evidence', 'likely cause', 'repair guidance']) {
      const line = finding?.lines.find((entry) =>
        entry.startsWith(`reviewed baseline finding — ${field}: `),
      );
      expect(line, `the finding carries the ${field}`).toBeDefined();
      const written = comment
        .split('\n')
        .find((entry) => entry.startsWith(`${field.charAt(0).toUpperCase()}${field.slice(1)}: `));
      expect(line?.slice(`reviewed baseline finding — ${field}: `.length)).toBe(
        written?.slice(field.length + 2).trim(),
      );
    }
    expect(finding?.lines.join('\n')).not.toContain('…');

    // A partial quotation is not the finding: the marker without every field —
    // or a marker that names no evidence identity at all — produces nothing, so
    // it can never stand in for the reviewed outcome.
    const marker = `${BASELINE_MARKER_PREFIX}repair:${EVIDENCE_ID}`;
    expect(baselineCommentFinding(`${marker}\nFailing check: npm test`)).toBeNull();
    expect(
      baselineCommentFinding(
        `${BASELINE_MARKER_PREFIX}repair:abc\nFailing check: x\nEvidence: y\n` +
          'Likely cause: z\nRepair guidance: w',
      ),
    ).toBeNull();
    // Nor is a marker whose identity is only the prefix of a longer one: the
    // comment has to name this exact evidence, not start with its name.
    expect(baselineCommentFinding(commentFor(`${EVIDENCE_ID}ff`))).toBeNull();
    expect(baselineCommentFinding(`${BASELINE_MARKER_PREFIX}attention:${EVIDENCE_ID}`)).toBeNull();
    expect(baselineCommentFinding('a comment about something else')).toBeNull();
  });

  it('keeps the established finding even when the thread holds more recent chatter', () => {
    const comment = commentFor();
    const finding = baselineCommentFinding(comment)?.lines ?? [];
    const chatter = Array.from({ length: 12 }, (_entry, index) => ({
      author: 'Someone',
      createdAt: `2026-09-21T11:${String(index).padStart(2, '0')}:00.000Z`,
      text: `a note about something else, number ${String(index + 1)}`,
    }));

    const guidance = guidanceFrom(
      [],
      [{ author: 'Nexus Agent', createdAt: '2026-09-21T10:05:00.000Z', text: comment }, ...chatter],
      finding,
    );

    expect(guidance.slice(0, finding.length)).toEqual(finding);
    expect(
      guidance.some((line) => line.includes('reviewed baseline finding — repair guidance: ')),
    ).toBe(true);
    expect(guidance.length).toBeLessThanOrEqual(12);
  });

  it('never promotes a comment of the thread to the requirement on its own', () => {
    // Nothing established this comment as the workspace's reviewed outcome, and
    // a marker in a comment is not a reviewed outcome: it stays the context the
    // thread always was instead of becoming what the turn must repair first.
    const guidance = guidanceFrom(
      [],
      [{ author: 'Nexus Agent', createdAt: '2026-09-21T10:05:00.000Z', text: commentFor() }],
    );

    expect(guidance.some((line) => line.startsWith('reviewed baseline finding — '))).toBe(false);
    expect(guidance.some((line) => line.includes('comment by Nexus Agent'))).toBe(true);
  });

  it('renders the finding the retained evidence holds, ordering requirement included', () => {
    // The same actionable finding, read back from the evidence the diagnosis
    // kept beside the workspace: the requirement that the baseline comes first
    // is part of it either way, and it is never dropped from a finding a
    // developer is handed.
    const fromEvidence = baselineFindingGuidanceLines(REPAIR_FINDING);
    expect(fromEvidence[0]).toBe(
      'reviewed baseline finding — repair the baseline before continuing the original task',
    );
    expect(
      fromEvidence.some((line) => line.startsWith('reviewed baseline finding — repair guidance: ')),
    ).toBe(true);

    // A non-actionable diagnosis names no repair, so it carries no ordering
    // requirement: no developer is started from it in the first place.
    const inconclusive = baselineFindingGuidanceLines(INCONCLUSIVE_FINDING);
    expect(inconclusive.some((line) => line.includes('repair the baseline before'))).toBe(false);
    expect(inconclusive.some((line) => line.includes('required action: '))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Jira record, through a fake HTTP boundary
// ---------------------------------------------------------------------------

const CLOUD_ID = '9337c4da-7d33-4c1d-b03c-db207e537f88';
const TOKEN = 'service-account-token-value';

const SOURCE_CONFIG = {
  type: 'jira',
  siteUrl: SCOPE,
  cloudId: CLOUD_ID,
  projectKey: 'HARN',
  issueType: 'Task',
  label: 'harness-task',
  readyStatus: 'To Do',
  runningStatus: 'In Progress',
  reviewStatus: 'In Review',
  ordering: 'priority',
  pollIntervalSeconds: 30,
  tokenEnv: 'JIRA_API_TOKEN',
} as const;

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface FakeJira {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
  readonly comments: { id: string; created: string; author: string; body: unknown }[];
  readonly labels: string[];
  status: string;
}

/** A description in the supported convention: a goal and its acceptance criteria. */
function adfTaskDescription(): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Repair the failing baseline and finish the ticket.' }],
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Acceptance criteria' }],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: "src/greet.mjs greets with 'Hello, Ada!'." }],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** A Jira site holding one issue in the running status, as the API answers. */
function fakeJira(status = 'In Progress'): FakeJira {
  const calls: FetchCall[] = [];
  const comments: FakeJira['comments'] = [];
  const labels = ['harness-task'];
  const targets: Record<string, Record<string, Record<string, unknown>>> = {
    '11': { to: { name: 'To Do' }, fields: {} },
    '12': { to: { name: 'In Review' }, fields: {} },
    '21': { to: { name: 'In Progress' }, fields: {} },
  };
  const transitionsFor = (from: string): readonly Record<string, unknown>[] => {
    if (from === 'To Do') {
      return [{ id: '21', name: 'Start work', ...targets['21'] }];
    }
    if (from === 'In Progress') {
      return [
        { id: '11', name: 'Ready for work', ...targets['11'] },
        { id: '12', name: 'Send to review', ...targets['12'] },
      ];
    }
    return [{ id: '11', name: 'Ready for work', ...targets['11'] }];
  };
  const state: { status: string } = { status };
  const issue = (): Record<string, unknown> => ({
    id: ISSUE_ID,
    key: ISSUE_KEY,
    fields: {
      summary: 'Repair the failing baseline and finish the ticket',
      description: adfTaskDescription(),
      status: { name: state.status },
      labels: [...labels],
      project: { key: 'HARN' },
      issuetype: { name: 'Task' },
      updated: '2026-09-21T10:00:00.000Z',
    },
  });
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method, body });
    const answer = (value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/rest/api/3/search/jql')) {
      return answer({
        issues: state.status === 'To Do' ? [issue()] : [],
        isLast: true,
      });
    }
    if (url.includes('/comment')) {
      if (method === 'POST') {
        const id = String(comments.length + 1);
        const document = (body as { body?: unknown }).body;
        comments.push({
          id,
          // The moment it arrived, so a continuation's window (which begins at
          // the attempt that ended before it) really contains it.
          created: new Date().toISOString(),
          author: 'Nexus Agent',
          body: document,
        });
        return answer({ id });
      }
      return answer({
        startAt: 0,
        maxResults: 100,
        total: comments.length,
        comments: comments.map((comment) => ({
          id: comment.id,
          created: comment.created,
          author: { displayName: comment.author },
          body: comment.body,
        })),
      });
    }
    if (url.includes('/transitions')) {
      if (method === 'POST') {
        const id = String((body as { transition?: { id?: unknown } }).transition?.id ?? '');
        const target = targets[id];
        if (target === undefined) {
          return new Response('no such transition', { status: 400 });
        }
        state.status = String((target['to'] as { name?: string }).name);
        // Jira answers the transition with 204 and no body, exactly as the
        // client's own `null`-body handling expects.
        return new Response(null, { status: 204 });
      }
      return answer({ transitions: transitionsFor(state.status) });
    }
    if (method === 'PUT') {
      // The workspace pointer label: added once, as Jira would add it.
      const update = (body as { update?: { labels?: { add?: unknown }[] } }).update;
      for (const entry of update?.labels ?? []) {
        if (typeof entry.add === 'string' && !labels.includes(entry.add)) {
          labels.push(entry.add);
        }
      }
      return new Response(null, { status: 204 });
    }
    return answer(issue());
  };
  return {
    fetch: impl as unknown as typeof fetch,
    calls,
    comments,
    labels,
    get status() {
      return state.status;
    },
    set status(value: string) {
      state.status = value;
    },
  };
}

describe('the Jira record of one diagnosis', () => {
  /** The real Jira record and a scripted reviewer, as the phase is composed in production. */
  function jiraDiagnosis(record: BaselineRecord, reviewer: BaselineReview, workDir: string) {
    return createBaselineDiagnosis({
      reviewer,
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });
  }

  it('posts one marker comment and returns the issue to its ready status', async () => {
    const workDir = await createTempDir();
    const site = fakeJira();
    const http = createHttpClient(SOURCE_CONFIG, TOKEN, { fetch: site.fetch });
    const record = createJiraBaselineRecord(SOURCE_CONFIG, http);
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const diagnosis = jiraDiagnosis(record, reviewer.review, workDir);
    const request = requestFor();

    const outcome = await diagnosis.diagnose(request);

    expect(outcome.kind).toBe('repair');
    expect(site.status).toBe('To Do');
    expect(site.comments).toHaveLength(1);
    const comment = site.comments[0];
    expect(comment?.author).toBe('Nexus Agent');
    const evidenceId = baselineEvidenceId(refFor(), BASE, request.baseline);
    expect(JSON.stringify(comment?.body)).toContain(
      `${BASELINE_MARKER_PREFIX}repair:${evidenceId}`,
    );
    expect(JSON.stringify(comment?.body)).toContain('Repair guidance');
    // The move was made from the running status to the ready status, by target
    // status name, and the token went only to the gateway route.
    const transition = site.calls.find(
      (call) => call.method === 'POST' && call.url.includes('/transitions'),
    );
    expect(transition?.body).toEqual({ transition: { id: '11' } });
    expect(site.calls.every((call) => call.url.startsWith('https://api.atlassian.com/'))).toBe(
      true,
    );
  });

  it('does not comment again, or run the reviewer again, when the evidence is unchanged', async () => {
    const workDir = await createTempDir();
    const site = fakeJira();
    const http = createHttpClient(SOURCE_CONFIG, TOKEN, { fetch: site.fetch });
    const record = createJiraBaselineRecord(SOURCE_CONFIG, http);
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const diagnosis = jiraDiagnosis(record, reviewer.review, workDir);
    const request = requestFor();

    const first = await diagnosis.diagnose(request);
    expect(first.kind).toBe('repair');
    expect(site.comments).toHaveLength(1);
    // What that turn recorded before the comment was published: the accepted
    // finding a restart holds the marker against.
    await writeTurnFinding(workDir, baselineEvidenceId(refFor(), BASE, request.baseline));

    // The restart: the same issue, the same snapshot, the same results. The
    // thread holds the finding, so nothing is spent or written twice.
    site.status = 'In Progress';
    const second = await diagnosis.diagnose({ ...request, stop: new AbortController().signal });

    expect(second.kind).toBe('repair');
    expect(reviewer.requests).toHaveLength(1);
    expect(site.comments).toHaveLength(1);
    expect(site.status).toBe('To Do');
  });

  it('leaves a non-actionable diagnosis In Review with the required action', async () => {
    const workDir = await createTempDir();
    const site = fakeJira();
    const http = createHttpClient(SOURCE_CONFIG, TOKEN, { fetch: site.fetch });
    const record = createJiraBaselineRecord(SOURCE_CONFIG, http);
    const reviewer = scriptedReviewer(INCONCLUSIVE_FINDING);
    const diagnosis = jiraDiagnosis(record, reviewer.review, workDir);

    const outcome = await diagnosis.diagnose(requestFor());

    expect(outcome.kind).toBe('attention');
    expect(site.status).toBe('In Review');
    expect(site.comments).toHaveLength(1);
    expect(JSON.stringify(site.comments[0]?.body)).toContain('Required action');
  });

  it('finishes a pending diagnosis from the retained evidence: one comment, one move', async () => {
    const workDir = await createTempDir();
    const site = fakeJira();
    const http = createHttpClient(SOURCE_CONFIG, TOKEN, { fetch: site.fetch });
    const record = createJiraBaselineRecord(SOURCE_CONFIG, http);
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const diagnosis = jiraDiagnosis(record, reviewer.review, workDir);
    // The evidence a stopped invocation left: recorded, with nothing on the
    // issue's thread yet and the issue still in the running status.
    await pendingEvidence(workDir);

    const resumed = await diagnosis.resume(new AbortController().signal);

    expect(resumed?.kind).toBe('repair');
    expect(reviewer.requests).toHaveLength(1);
    expect(site.status).toBe('To Do');
    expect(site.comments).toHaveLength(1);
    expect(JSON.stringify(site.comments[0]?.body)).toContain('Repair guidance');
    const transitions = site.calls.filter(
      (call) => call.method === 'POST' && call.url.includes('/transitions'),
    );
    expect(transitions).toHaveLength(1);

    // The evidence is finished, so a later pass writes nothing at all.
    const again = await diagnosis.resume(new AbortController().signal);
    expect(again).toBeNull();
    expect(reviewer.requests).toHaveLength(1);
    expect(site.comments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Finishing what a stopped invocation left pending
// ---------------------------------------------------------------------------

/**
 * One piece of evidence a stopped invocation left behind: the diagnosis
 * recorded it, and the comment it would have published never arrived.
 */
async function pendingEvidence(workDir: string): Promise<FakeRecord> {
  const record = fakeRecord();
  record.commentFailure = 'the connection dropped';
  const settled = await phaseFor({
    record,
    reviewer: scriptedReviewer(REPAIR_FINDING),
    workDir,
  }).diagnosis.diagnose(requestFor());
  expect(settled.kind).toBe('attention');
  expect(record.notes).toEqual([]);
  record.commentFailure = null;
  return record;
}

/** The one evidence record a diagnosis kept for `project` under `workDir`, if any. */
async function evidenceRecordFor(
  workDir: string,
  project: string,
): Promise<{ readonly file: string; readonly record: Record<string, unknown> }> {
  const root = path.join(workDir, 'baseline', project);
  const entries = await readdir(root, { withFileTypes: true });
  const [entry] = entries.filter((candidate) => candidate.isDirectory());
  if (entry === undefined) {
    throw new Error(`no evidence directory was kept under "${root}"`);
  }
  const file = path.join(root, entry.name, 'evidence.json');
  return {
    file,
    record: JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>,
  };
}

/**
 * The records the real reviewer turn writes, put where it writes them: the
 * finding file itself, and the outcome beside the evidence that says the turn
 * completed with that finding. A fixture whose reviewer is scripted has to leave
 * both: a marker on the item's own thread returns the item for repair only while
 * that outcome holds the actionable finding the marker names, and a later claim
 * holds a comment of the thread against the finding the retained evidence holds —
 * so evidence with neither record is a diagnosis a person has to look at, not
 * one a developer starts from.
 */
async function writeReviewerFinding(
  workDir: string,
  finding: BaselineFinding = REPAIR_FINDING,
  project: string = PROJECT,
): Promise<void> {
  const evidence = await evidenceRecordFor(workDir, project);
  const dir = path.dirname(evidence.file);
  const file = baselineFindingPath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(finding)}\n`, 'utf8');
  await writeJsonFile(dir, 'outcome.json', { version: 1, state: 'finding', finding });
}

describe('finishing a diagnosis a stopped invocation left pending', () => {
  it('leaves an item a person moved alone, and never diagnoses it again', async () => {
    const workDir = await createTempDir();
    const record = await pendingEvidence(workDir);
    // A person moved the item before the restart: what they decided stands.
    record.status = 'To Do';
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis, out } = phaseFor({ record, reviewer, workDir });

    const resumed = await diagnosis.resume(new AbortController().signal);

    expect(resumed).toBeNull();
    expect(record.posted).toEqual([]);
    expect(record.moves).toEqual([]);
    expect(record.notes).toEqual([]);
    expect(reviewer.requests).toEqual([]);
    expect(out.some((line) => line.includes('left the running status'))).toBe(true);
    // Nothing is pending any more: the evidence was closed where the person left
    // the item, and a later pass writes nothing at all.
    expect(await diagnosis.resume(new AbortController().signal)).toBeNull();
    expect(record.posted).toEqual([]);
  });

  it('reports pending evidence it cannot finish instead of passing over it', async () => {
    const workDir = await createTempDir();
    const record = await pendingEvidence(workDir);
    record.runningFailure = 'the site refused the read';
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });

    const resumed = await diagnosis.resume(new AbortController().signal);

    expect(resumed?.kind).toBe('problem');
    expect(resumed?.detail).toContain('the site refused the read');
    expect(record.posted).toEqual([]);
    expect(reviewer.requests).toEqual([]);
  });

  it('records an interrupt that lands during a resumed reviewer turn', async () => {
    const workDir = await createTempDir();
    const record = await pendingEvidence(workDir);
    const reviewer = interruptibleReviewer({ termination: 'confirmed', problem: null });
    const { diagnosis } = phaseFor({ record, reviewer: reviewer.review, workDir });
    const controller = new AbortController();

    const resuming = diagnosis.resume(controller.signal);
    await reviewer.started;
    controller.abort(new Error('the user interrupted intake'));
    const outcome = await resuming;

    // The ticket is not the price of the interruption: the one comment records
    // it, the item waits In Review, the evidence is settled instead of being
    // left pending for the next invocation to publish, and the resume reports
    // that attention rather than cancelling silently.
    expect(outcome?.kind).toBe('attention');
    if (outcome?.kind === 'attention') {
      expect(outcome.cleanupConfirmed).toBe(true);
    }
    expect(record.status).toBe('In Review');
    expect(record.posted).toHaveLength(1);
    expect(record.posted[0]?.join('\n')).toContain(`${BASELINE_MARKER_PREFIX}attention:`);
    expect((await evidenceRecordFor(workDir, PROJECT)).record['closed']).toBe('attention');
  });

  it('publishes the finding an interrupted turn already wrote, without a second turn', async () => {
    const workDir = await createTempDir();
    const target = await createLocalTarget({ brokenBaseline: true });
    const { workspaceId, workspacePath, base } = await retainedWorkspace(workDir, [
      baselineAttempt(),
    ]);
    // The failing check's own output is part of the evidence the reviewer
    // reads, so this baseline really wrote it: a missing log is incomplete
    // evidence, not a check that said nothing.
    const baseline = await baselineWithLogs();
    const request = {
      item: { ref: refFor(), task: taskFor() },
      workspace: {
        workspaceId,
        workspacePath,
        branch: `harness/${workspaceId}`,
        baseCommit: base,
      },
      baseline,
      stop: new AbortController().signal,
    };

    // The reviewer turn really runs and really writes its finding; only the
    // comment that would have published it never arrived.
    const record = fakeRecord();
    record.commentFailure = 'the connection dropped';
    const diagnosis = createBaselineDiagnosis({
      reviewer: reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING) }]),
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });
    const stopped = await diagnosis.diagnose(request);
    expect(stopped.kind).toBe('attention');
    expect(record.notes).toEqual([]);
    expect(await fakeTurns(target.state)).toHaveLength(1);
    record.commentFailure = null;

    // The restart spends nothing: the finding the earlier turn wrote is
    // published as it is, and the ticket returns to its ready status.
    const reuse = createBaselineDiagnosis({
      reviewer: reviewerFor(target, []),
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    const resumed = await reuse.resume(new AbortController().signal);

    expect(resumed?.kind).toBe('repair');
    expect(await fakeTurns(target.state)).toHaveLength(1);
    expect(record.notes).toHaveLength(1);
    expect(record.notes[0]?.text).toContain('Repair guidance');
    expect(record.status).toBe('To Do');
  });

  it("reuses a failed turn's rejection, not the finding it left, when publication is retried", async () => {
    const workDir = await createTempDir();
    const target = await createLocalTarget({ brokenBaseline: true });
    const { workspaceId, workspacePath, base } = await retainedWorkspace(workDir, [
      baselineAttempt(),
    ]);
    const request = {
      item: { ref: refFor(), task: taskFor() },
      workspace: {
        workspaceId,
        workspacePath,
        branch: `harness/${workspaceId}`,
        baseCommit: base,
      },
      baseline: await baselineWithLogs(),
      stop: new AbortController().signal,
    };

    // The real reviewer turn writes a valid finding and then reports that it
    // failed; the inconclusive comment never arrives, so the evidence is left
    // pending with the failed turn's own finding file beside it.
    const record = fakeRecord();
    record.commentFailure = 'the connection dropped';
    const failed = createBaselineDiagnosis({
      reviewer: reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING), mode: 'failed' }]),
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });
    const stopped = await failed.diagnose(request);
    expect(stopped.kind).toBe('attention');
    expect(await fakeTurns(target.state)).toHaveLength(1);
    record.commentFailure = null;

    // The publication retry: the recorded rejection is reused, so the finding
    // the failed turn left is never published as a repair.
    const restart = createBaselineDiagnosis({
      reviewer: reviewerFor(target, []),
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    const resumed = await restart.resume(new AbortController().signal);

    expect(resumed?.kind).toBe('attention');
    expect(await fakeTurns(target.state)).toHaveLength(1);
    expect(record.notes).toHaveLength(1);
    expect(record.notes[0]?.text).toContain(`${BASELINE_MARKER_PREFIX}attention:`);
    expect(record.notes[0]?.text).not.toContain(`${BASELINE_MARKER_PREFIX}repair:`);
    expect(record.status).toBe('In Review');
  }, 60_000);

  it('reconciles a published finding before finishing evidence for an item that already moved', async () => {
    const workDir = await createTempDir();
    const target = await createLocalTarget({ brokenBaseline: true });
    const retained = await retainedWorkspace(workDir, [baselineAttempt()]);
    const record = fakeRecord();
    const diagnosis = createBaselineDiagnosis({
      reviewer: reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING) }]),
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });
    const outcome = await diagnosis.diagnose({
      item: { ref: refFor(), task: taskFor() },
      workspace: {
        workspaceId: retained.workspaceId,
        workspacePath: retained.workspacePath,
        branch: `harness/${retained.workspaceId}`,
        baseCommit: retained.base,
      },
      baseline: await baselineWithLogs(),
      stop: new AbortController().signal,
    });
    expect(outcome.kind).toBe('repair');
    expect(record.status).toBe('To Do');

    // The window this is about: the comment and the status move both arrived,
    // and the invocation stopped before its local record was finished. The
    // record is put back to exactly what that invocation left.
    const evidence = await evidenceRecordFor(workDir, PROJECT);
    const unfinished = { ...evidence.record };
    delete unfinished['closed'];
    delete unfinished['closedAt'];
    await writeFile(evidence.file, `${JSON.stringify(unfinished, null, 2)}\n`, 'utf8');

    // The restart: the item is not in the running status, and its own thread
    // carries the finding. Nothing is commented on or moved, and the record is
    // finished with the outcome the thread already holds.
    const restart = createBaselineDiagnosis({
      reviewer: reviewerFor(target, []),
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    const resumed = await restart.resume(new AbortController().signal);

    expect(resumed).toBeNull();
    expect(record.notes).toHaveLength(1);
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'To Do' }]);
    expect(await fakeTurns(target.state)).toHaveLength(1);
    const reconciled = await evidenceRecordFor(workDir, PROJECT);
    expect(reconciled.record['closed']).toBe('repair');

    // The workspace's next claim can still be told the finding.
    const recovered = await restart.reviewedFinding(
      retained.workspaceId,
      new AbortController().signal,
    );
    expect(recovered.kind).toBe('finding');
    if (recovered.kind === 'finding') {
      expect(recovered.finding).toEqual(REPAIR_FINDING);
    }

    // The same window, but the record beside the evidence says the reviewer
    // runtime was not seen to end. Reopening the record is what an invocation
    // that stopped before finishing it left, and the restart has to read that
    // stop before it settles anything: the item still is not moved, and the
    // unconfirmed stop keeps the intake lock instead of being skipped. A
    // recorded rejection is not the actionable finding the comment's marker
    // names, so that marker may not close the evidence as the repair it claims
    // either: the record is settled as a diagnosis that leaves a person the
    // next step, and no developer is started from the comment.
    const reopen = async (): Promise<void> => {
      const current = await evidenceRecordFor(workDir, PROJECT);
      const open = { ...current.record };
      delete open['closed'];
      delete open['closedAt'];
      await writeFile(current.file, `${JSON.stringify(open, null, 2)}\n`, 'utf8');
    };
    await reopen();
    await writeJsonFile(path.dirname(evidence.file), 'outcome.json', {
      version: 1,
      state: 'rejected',
      problem: 'the reviewer turn was not seen to end',
      shutdown: {
        termination: 'unconfirmed',
        problem: 'the host could not reach the process tree',
      },
    });

    const stopped = await restart.resume(new AbortController().signal);

    expect(stopped?.kind).toBe('attention');
    expect((stopped as { readonly cleanupConfirmed: boolean }).cleanupConfirmed).toBe(false);
    expect((stopped as { readonly detail: string }).detail).toContain('was not seen to end');
    // Reconciled where the item already stands: no second turn, no second
    // comment, and no move, with the finding still readable for a later claim.
    expect(record.notes).toHaveLength(1);
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'To Do' }]);
    expect(await fakeTurns(target.state)).toHaveLength(1);
    const settled = await evidenceRecordFor(workDir, PROJECT);
    expect(settled.record['closed']).toBe('attention');

    // A record that cannot be read is refused the same way, and stays pending
    // for the person who has to inspect it before anything is settled.
    await reopen();
    await writeFile(path.join(path.dirname(evidence.file), 'outcome.json'), '{ not json\n', 'utf8');

    const unreadable = await restart.resume(new AbortController().signal);

    expect(unreadable?.kind).toBe('attention');
    expect((unreadable as { readonly cleanupConfirmed: boolean }).cleanupConfirmed).toBe(false);
    expect((unreadable as { readonly detail: string }).detail).toContain('cannot be read');
    expect(record.notes).toHaveLength(1);
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'To Do' }]);
    const pending = await evidenceRecordFor(workDir, PROJECT);
    expect(pending.record['closed']).toBeUndefined();
  }, 60_000);

  it('stops a serial step for a person when the pending evidence cannot be finished', async () => {
    const workDir = await createTempDir();
    const { sourceRepo, workspaceId, base } = await retainedWorkspace(workDir, [baselineAttempt()]);
    const record = await pendingEvidence(workDir);
    record.runningFailure = 'the site refused the read';
    const { diagnosis } = phaseFor({
      record,
      reviewer: scriptedReviewer(REPAIR_FINDING),
      workDir,
    });
    const { context, runs } = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      findingText: findingTextFor(),
      diagnosis,
      run: async () => runResultFor(),
    });

    const take = await takeOneItem(context, {});

    expect(take.outcome).toBe('attention');
    expect(take.problem).toContain('the site refused the read');
    expect(runs).toEqual([]);
    expect(record.posted).toEqual([]);
  });
});

describe('the connected project a diagnosis belongs to', () => {
  it("never resumes, comments on, moves, or closes another project's pending evidence", async () => {
    // Two connected projects share one Nexus-wide `workDir`, exactly as the
    // intake lock and the queue already allow. Project A leaves a diagnosis
    // pending: its evidence is recorded, its comment never arrived, and its item
    // is still in the running status. Nothing about that may be acted on by
    // project B, whose own issues belong to another connected project.
    const workDir = await createTempDir();
    const recordA = await pendingEvidence(workDir);
    const evidenceA = await evidenceRecordFor(workDir, PROJECT);
    expect(evidenceA.record['project']).toBe(PROJECT);

    const recordB = fakeRecord();
    const reads: string[] = [];
    const isRunningB = recordB.isRunning;
    recordB.isRunning = async (id, stop) => {
      reads.push(id);
      return await isRunningB(id, stop);
    };
    const reviewerB = scriptedReviewer(REPAIR_FINDING);
    const projectB = phaseFor({
      record: recordB,
      reviewer: reviewerB,
      workDir,
      project: 'another-connected-project',
    });

    const resumedB = await projectB.diagnosis.resume(new AbortController().signal);

    // B found nothing pending of its own, and asked nothing of its own source:
    // A's issue id was never sent through B's connection, and A's evidence was
    // neither published nor closed.
    expect(resumedB).toBeNull();
    expect(reads).toEqual([]);
    expect(recordB.posted).toEqual([]);
    expect(recordB.moves).toEqual([]);
    expect(reviewerB.requests).toEqual([]);
    const afterB = await evidenceRecordFor(workDir, PROJECT);
    expect(afterB.file).toBe(evidenceA.file);
    expect(afterB.record['closed']).toBeUndefined();

    // A's own invocation then finishes exactly what it recorded: one comment,
    // one move back to the ready status, and the evidence closed.
    const reviewerA = scriptedReviewer(REPAIR_FINDING);
    const projectA = phaseFor({ record: recordA, reviewer: reviewerA, workDir });

    const resumedA = await projectA.diagnosis.resume(new AbortController().signal);

    expect(resumedA?.kind).toBe('repair');
    expect(recordA.posted).toHaveLength(1);
    expect(recordA.status).toBe('To Do');
    expect((await evidenceRecordFor(workDir, PROJECT)).record['closed']).toBe('repair');
  });

  it('refuses evidence another project wrote instead of acting on it through this one', async () => {
    // Evidence copied into the wrong project's directory — or a directory moved
    // between projects by hand — is not read as this project's own: the record
    // carries the project it was written for, and a mismatch is refused by name
    // before any comment, move, or closure.
    const workDir = await createTempDir();
    const recordA = await pendingEvidence(workDir);
    const evidenceA = await evidenceRecordFor(workDir, PROJECT);

    const foreign = 'another-connected-project';
    const foreignDir = path.join(
      workDir,
      'baseline',
      foreign,
      path.basename(path.dirname(evidenceA.file)),
    );
    await mkdir(foreignDir, { recursive: true });
    await writeFile(
      path.join(foreignDir, 'evidence.json'),
      `${JSON.stringify(evidenceA.record, null, 2)}\n`,
      'utf8',
    );

    const recordB = fakeRecord();
    const projectB = phaseFor({
      record: recordB,
      reviewer: scriptedReviewer(REPAIR_FINDING),
      workDir,
      project: foreign,
    });

    const resumed = await projectB.diagnosis.resume(new AbortController().signal);

    expect(resumed?.kind).toBe('problem');
    expect(resumed?.detail).toContain('another connected project');
    expect(recordB.posted).toEqual([]);
    expect(recordB.moves).toEqual([]);
    expect(recordB.notes).toEqual([]);
    // The evidence was not closed by the project it does not belong to, and the
    // item it names was never asked about through that project's connection.
    const keptA = JSON.parse(await readFile(evidenceA.file, 'utf8')) as Record<string, unknown>;
    expect(keptA['project']).toBe(PROJECT);
    expect(keptA['closed']).toBeUndefined();
    expect(recordA.status).toBe('In Progress');
  });
});

// ---------------------------------------------------------------------------
// The coordinator: which ending enters the diagnosis, and what it publishes
// ---------------------------------------------------------------------------

interface CoordinatorCalls {
  readonly complete: SourceRunOutcome[];
  readonly progress: SourceRunOutcome[];
  readonly diagnosed: BaselineDiagnosisRequest[];
  readonly delivered: string[];
  /** What the ticket was told when the coordinator took it out of the running status. */
  readonly attentions: string[];
}

/**
 * One `takeOneItem` step over a fake source and a scripted run, with the
 * diagnosis the test hands it. Everything the coordinator would publish is
 * recorded rather than sent, so what it does — and does not do — is readable.
 */
async function takeOne(parts: {
  readonly result: RunTaskResult;
  readonly diagnosis?: BaselineDiagnosis;
  /** Whether a recording delivery step is configured for this step. */
  readonly delivery?: boolean;
  /** A stop a test drives itself, e.g. one that lands as the run returns. */
  readonly stop?: AbortSignal;
  /** Whether telling the ticket also fails, as a refused transition does. */
  readonly attentionFailure?: string;
}): Promise<{
  readonly take: SourceTake;
  readonly calls: CoordinatorCalls;
  readonly workDir: string;
}> {
  const workDir = await createTempDir();
  const ref = refFor();
  const item: SourceTask = { ref, task: taskFor(ref), pointers: [] };
  const calls: CoordinatorCalls = {
    complete: [],
    progress: [],
    diagnosed: [],
    delivered: [],
    attentions: [],
  };
  const source: TaskSource = {
    listEligible: async () => [{ ref, title: 'Repair the failing baseline' }],
    prepare: async () => item,
    claim: async () => true,
    progress: async (_item, outcome) => {
      calls.progress.push(outcome);
    },
    complete: async (_item, outcome) => {
      calls.complete.push(outcome);
    },
    recordWorkspace: async () => undefined,
    refuse: async () => {
      throw new Error('the item was refused, which this fixture never expects');
    },
    attention: async (_item, reason) => {
      if (parts.attentionFailure !== undefined) {
        throw new Error(parts.attentionFailure);
      }
      calls.attentions.push(reason);
    },
    commentsSince: async () => [],
  };
  const context: SourceContext = {
    source,
    workDir,
    lockNamespace: 'baseline-fixture',
    tiers: [{ name: 'default', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 }],
    repoPath: '/repo',
    io: { out: () => undefined, err: () => undefined },
    stop: parts.stop ?? new AbortController().signal,
    preflight: async () => ({ sourceRoot: '/repo', baseCommit: BASE }),
    run: async (request) => {
      await request.onWorkspaceReady?.({ workspaceId: ref.key });
      return parts.result;
    },
    now: () => new Date('2026-09-21T10:00:00.000Z'),
    sleep: async () => undefined,
    ...(parts.diagnosis === undefined ? {} : { baselineDiagnosis: parts.diagnosis }),
    ...(parts.delivery !== true
      ? {}
      : {
          delivery: {
            deliver: async (request: { readonly workspacePath: string }) => {
              calls.delivered.push(request.workspacePath);
              return null;
            },
          } as Delivery,
        }),
  };
  const take = await takeOneItem(context, {});
  return { take, calls, workDir };
}

/** One prepared workspace, as the run result that created it records it. */
function workspaceFor(overrides: Partial<PreparedWorkspace> = {}): PreparedWorkspace {
  return {
    workDir: '/work',
    runId: 'run-1',
    runDir: '/work/runs/run-1',
    workspaceId: ISSUE_KEY,
    workspacePath: `/work/workspaces/${ISSUE_KEY}`,
    logsDir: '/work/runs/run-1/logs',
    continued: false,
    attempt: 1,
    sourceRoot: '/repo',
    baseCommit: BASE,
    branch: `harness/${ISSUE_KEY}`,
    ...overrides,
  };
}

function runResultFor(overrides: Partial<RunTaskResult> = {}): RunTaskResult {
  return {
    run: {
      workDir: '/work',
      runId: 'run-1',
      runDir: '/work/runs/run-1',
      workspaceId: ISSUE_KEY,
      workspacePath: `/work/workspaces/${ISSUE_KEY}`,
      logsDir: '/work/runs/run-1/logs',
    },
    workspace: workspaceFor(),
    status: 'failed',
    reason: 'the baseline checks did not pass, so no coding turn was started',
    baseline: redBaseline(),
    attempts: [],
    repairsUsed: 0,
    timeout: null,
    cancellation: null,
    changes: summarizeChanges({ baseCommit: BASE, paths: [] }),
    workspaceLedgerProblem: null,
    reportPath: '/work/runs/run-1/result.json',
    ...overrides,
  };
}

function diagnosisFor(
  outcome: BaselineDiagnosisOutcome,
  calls: BaselineDiagnosisRequest[],
  recovered: BaselineReviewedFinding = { kind: 'none' },
): BaselineDiagnosis {
  return {
    diagnose: async (request) => {
      calls.push(request);
      return outcome;
    },
    resume: async () => null,
    reviewedFinding: async () => recovered,
  };
}

describe('the coordinator around the diagnosis', () => {
  it('diagnoses a completed red baseline, publishes nothing else, and reports the repair', async () => {
    const diagnosed: BaselineDiagnosisRequest[] = [];
    const { take, calls, workDir } = await takeOne({
      result: runResultFor(),
      delivery: true,
      diagnosis: diagnosisFor(
        { kind: 'repair', detail: 'the finding is published; back in "To Do"', commentId: 'c1' },
        diagnosed,
      ),
    });

    expect(take.outcome).toBe('taken');
    expect(take.run?.returnedForBaselineRepair).toEqual({
      detail: 'the finding is published; back in "To Do"',
    });
    // The diagnosis saw the exact snapshot and the red round; the run's own
    // result was not published a second time, and nothing was delivered.
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]?.workspace).toEqual({
      workspaceId: ISSUE_KEY,
      workspacePath: `/work/workspaces/${ISSUE_KEY}`,
      branch: `harness/${ISSUE_KEY}`,
      baseCommit: BASE,
    });
    expect(diagnosed[0]?.baseline.outcome).toBe('failed');
    expect(calls.complete).toEqual([]);
    expect(calls.progress).toEqual([]);
    expect(calls.delivered).toEqual([]);
    // The receipt records that the issue was told, so a restart reads a sent
    // outcome rather than a pending one.
    const receipt = await readReceipt(receiptFilePath(workDir, refFor()));
    expect(receipt?.feedback).toBe('sent');
    expect(receipt?.commentId).toBe('c1');
  });

  it('stops for a person when nothing actionable was diagnosed', async () => {
    const { take, calls, workDir } = await takeOne({
      result: runResultFor(),
      diagnosis: diagnosisFor(
        {
          kind: 'attention',
          detail: 'no repair is actionable; the item is In Review (comment c1)',
          commentId: 'c1',
          cleanupConfirmed: true,
        },
        [],
      ),
    });

    expect(take.outcome).toBe('attention');
    expect(take.cleanupConfirmed).toBe(true);
    expect(take.ticket?.ref.key).toBe(ISSUE_KEY);
    expect(take.problem).toContain('no baseline repair is actionable');
    expect(calls.complete).toEqual([]);
    expect(calls.delivered).toEqual([]);
    expect(existsSync(intakeLockPath(workDir, 'baseline-fixture'))).toBe(false);
  });

  it('keeps its intake lock when the diagnosis reports an unconfirmed reviewer stop', async () => {
    const { take, calls, workDir } = await takeOne({
      result: runResultFor(),
      diagnosis: diagnosisFor(
        {
          kind: 'attention',
          detail: 'the reviewer runtime could not be confirmed stopped',
          commentId: 'c1',
          cleanupConfirmed: false,
        },
        [],
      ),
    });

    // The ticket is published exactly as an inconclusive diagnosis always is,
    // and the lock stays: something the diagnosis started may still be writing.
    expect(take.outcome).toBe('attention');
    expect(take.cleanupConfirmed).toBe(false);
    expect(take.problem).toContain('no baseline repair is actionable');
    expect(existsSync(intakeLockPath(workDir, 'baseline-fixture'))).toBe(true);
    expect(calls.complete).toEqual([]);
  });

  it('tells the claimed ticket and takes it out of the running status when the stop lands before the diagnosis', async () => {
    // The stop lands between the completed red run and the diagnosis — the
    // window in which the run's own result is never published. The ticket is
    // already claimed, so the cancellation may not leave it In Progress with
    // nothing looking for it: bounded feedback and a move out of the running
    // status are what the diagnosis never got to write.
    const diagnosed: BaselineDiagnosisRequest[] = [];
    const controller = new AbortController();
    const { take, calls, workDir } = await takeOne({
      result: runResultFor(),
      stop: controller.signal,
      diagnosis: {
        diagnose: async (request) => {
          diagnosed.push(request);
          controller.abort(new Error('the user interrupted intake'));
          return {
            kind: 'cancelled',
            detail: 'HARN-38: the intake was stopped before its red baseline could be diagnosed',
            commentId: null,
            cleanupConfirmed: true,
          };
        },
        resume: async () => null,
        reviewedFinding: async () => ({ kind: 'none' }),
      },
    });

    expect(diagnosed).toHaveLength(1);
    expect(take.outcome).toBe('cancelled');
    expect(calls.complete).toEqual([]);
    expect(calls.attentions).toHaveLength(1);
    expect(calls.attentions[0]).toContain('stopped before its red baseline could be diagnosed');
    expect(calls.attentions[0]).toContain('no coding turn was started');
    expect(calls.attentions[0]).toContain('the workspace pointer is preserved');
    // The receipt records the record the ticket really holds: it was told.
    const receipt = await readReceipt(receiptFilePath(workDir, refFor()));
    expect(receipt?.feedback).toBe('sent');
    expect(receipt?.problem).toContain('stopped before its red baseline could be diagnosed');
    // Nothing unconfirmed came out of this stop, so the lock is released as it
    // always is when the intake is stopped cleanly.
    expect(take.cleanupConfirmed).toBe(true);
    expect(existsSync(intakeLockPath(workDir, 'baseline-fixture'))).toBe(false);
  });

  it('writes no second record when the diagnosis already published its own comment', async () => {
    // The diagnosis published this evidence's one comment and stopped before
    // the status move. A second comment would be a second record for the same
    // evidence; the next invocation's own resume makes the missing move from
    // the retained evidence and that comment instead.
    const controller = new AbortController();
    const { take, calls, workDir } = await takeOne({
      result: runResultFor(),
      stop: controller.signal,
      diagnosis: {
        diagnose: async () => {
          controller.abort(new Error('the user interrupted intake'));
          return {
            kind: 'cancelled',
            detail: 'HARN-38: its comment is on the issue, but the status move did not happen',
            commentId: 'c1',
            cleanupConfirmed: true,
          };
        },
        resume: async () => null,
        reviewedFinding: async () => ({ kind: 'none' }),
      },
    });

    expect(take.outcome).toBe('cancelled');
    expect(calls.attentions).toEqual([]);
    const receipt = await readReceipt(receiptFilePath(workDir, refFor()));
    expect(receipt?.feedback).toBe('pending');
    expect(receipt?.problem).toContain('the status move did not happen');
  });

  it('adds nothing of its own when the interrupt landed inside the reviewer turn', async () => {
    // The other window a stop can reach: the turn really ran and was
    // interrupted, so its own attention comment is this evidence's one record
    // and the item is already In Review. The coordinator publishes no second
    // record for it and starts nothing else.
    const controller = new AbortController();
    const { take, calls, workDir } = await takeOne({
      result: runResultFor(),
      stop: controller.signal,
      diagnosis: {
        diagnose: async () => {
          controller.abort(new Error('the user interrupted intake'));
          return {
            kind: 'attention',
            detail:
              'HARN-38: the interruption is what this evidence’s one comment records (comment c1)',
            commentId: 'c1',
            cleanupConfirmed: true,
          };
        },
        resume: async () => null,
        reviewedFinding: async () => ({ kind: 'none' }),
      },
    });

    expect(take.outcome).toBe('attention');
    expect(take.problem).toContain('no baseline repair is actionable');
    expect(calls.attentions).toEqual([]);
    expect(calls.complete).toEqual([]);
    const receipt = await readReceipt(receiptFilePath(workDir, refFor()));
    expect(receipt?.feedback).toBe('sent');
    expect(receipt?.commentId).toBe('c1');
  });

  it('stops for inspection, with the lock kept, when the stopped diagnosis cannot tell the ticket', async () => {
    const controller = new AbortController();
    const { take, calls, workDir } = await takeOne({
      result: runResultFor(),
      stop: controller.signal,
      attentionFailure: 'the transition was refused',
      diagnosis: {
        diagnose: async () => {
          controller.abort(new Error('the user interrupted intake'));
          return {
            kind: 'cancelled',
            detail: 'HARN-38: the intake was stopped before its red baseline could be diagnosed',
            commentId: null,
            cleanupConfirmed: true,
          };
        },
        resume: async () => null,
        reviewedFinding: async () => ({ kind: 'none' }),
      },
    });

    expect(take.outcome).toBe('attention');
    expect(take.problem).toContain('still in the running status');
    expect(take.problem).toContain('the transition was refused');
    expect(calls.complete).toEqual([]);
    // Telling the ticket failed after the stop, and the receipt says both: the
    // claimed ticket is still In Progress, and intake stops for a person to put
    // it where the next invocation can see it.
    const receipt = await readReceipt(receiptFilePath(workDir, refFor()));
    expect(receipt?.problem).toContain('the transition was refused');
    expect(receipt?.problem).toContain('stopped before its red baseline could be diagnosed');
  });

  it('takes the ticket out of the running status when the stop lands as the pre-review thread is read', async () => {
    // The other pre-review window: the stop arrives while the item's own thread
    // is being read, after the evidence record was written and before anything
    // was published. The phase reports the cancellation; the claimed ticket is
    // still the coordinator's to take out of the running status.
    const workDir = await createTempDir();
    const record = fakeRecord();
    const controller = new AbortController();
    const listing = record.listComments.bind(record);
    record.listComments = async (id, stop) => {
      controller.abort(new Error('the user interrupted intake'));
      return listing(id, stop);
    };
    const reviewer = scriptedReviewer(REPAIR_FINDING);
    const { diagnosis } = phaseFor({ record, reviewer, workDir });
    const { take, calls } = await takeOne({
      result: runResultFor(),
      stop: controller.signal,
      diagnosis,
    });

    expect(take.outcome).toBe('cancelled');
    expect(reviewer.requests).toEqual([]);
    expect(record.posted).toEqual([]);
    expect(record.moves).toEqual([]);
    expect(record.status).toBe('In Progress');
    // The evidence the stop left is recorded, and the phase published nothing;
    // the ticket is told and taken out of the running status all the same.
    expect(calls.attentions).toHaveLength(1);
    expect(calls.attentions[0]).toContain('stopped before its red baseline could be diagnosed');
    expect(calls.attentions[0]).toContain('the request was stopped by the caller');
    expect((await evidenceRecordFor(workDir, PROJECT)).record['closed']).toBeUndefined();
  });

  it('publishes the run itself when the baseline could not be executed', async () => {
    const diagnosed: BaselineDiagnosisRequest[] = [];
    const { take, calls } = await takeOne({
      result: runResultFor({
        baseline: redBaseline({ outcome: 'execution-error', problem: 'setup command 1 failed' }),
        reason: 'the baseline could not be executed: setup command 1 failed',
      }),
      diagnosis: diagnosisFor({ kind: 'repair', detail: 'never', commentId: null }, diagnosed),
    });

    expect(diagnosed).toEqual([]);
    expect(calls.complete).toHaveLength(1);
    expect(take.run?.returnedForBaselineRepair).toBeUndefined();
  });

  it('publishes the run itself when the run was cancelled or timed out', async () => {
    const diagnosed: BaselineDiagnosisRequest[] = [];
    const cancelled = await takeOne({
      result: runResultFor({
        status: 'cancelled',
        cancellation: {
          phase: 'the baseline checks',
          elapsedMs: 100,
          termination: 'confirmed',
          problem: null,
        },
      }),
      diagnosis: diagnosisFor({ kind: 'repair', detail: 'never', commentId: null }, diagnosed),
    });
    const timedOut = await takeOne({
      result: runResultFor({
        timeout: {
          phase: 'the baseline checks',
          limit: 'task',
          limitMs: 1000,
          elapsedMs: 1000,
          termination: 'confirmed',
          problem: null,
        },
      }),
      diagnosis: diagnosisFor({ kind: 'repair', detail: 'never', commentId: null }, diagnosed),
    });

    expect(diagnosed).toEqual([]);
    expect(cancelled.calls.complete).toHaveLength(1);
    expect(timedOut.calls.complete).toHaveLength(1);
  });

  it('does not diagnose a continuation that starts red', async () => {
    // A continuation is expected to start red: its earlier attempts committed
    // work the checks judge, and only its post-turn round decides. The run below
    // is that continuation's own red baseline, which is not a fresh snapshot.
    const diagnosed: BaselineDiagnosisRequest[] = [];
    const { take, calls } = await takeOne({
      result: runResultFor({
        workspace: workspaceFor({ continued: true, attempt: 2 }),
        attempts: [
          {
            turn: 1,
            kind: 'implementation',
            agentLog: '/work/runs/run-1/logs/agent-implementation.log',
            agentSummary: null,
            checks: redBaseline(),
          },
        ],
        repairsUsed: 0,
      }),
      diagnosis: diagnosisFor({ kind: 'repair', detail: 'never', commentId: null }, diagnosed),
    });

    expect(diagnosed).toEqual([]);
    expect(calls.complete).toHaveLength(1);
    expect(take.run?.returnedForBaselineRepair).toBeUndefined();
  });

  it('keeps the existing publication when no diagnosis is configured', async () => {
    const { take, calls } = await takeOne({ result: runResultFor() });

    expect(take.run?.returnedForBaselineRepair).toBeUndefined();
    expect(calls.complete).toHaveLength(1);
    expect(calls.complete[0]?.status).toBe('failed');
  });

  it('never delivers a result that is still red', async () => {
    // A post-agent round that did not pass is an ordinary failed attempt: the
    // diagnosis does not apply (a coding turn ran), and the delivery step is not
    // reached — only a passed attempt is ever delivered, so a still-red result
    // stays local.
    const diagnosed: BaselineDiagnosisRequest[] = [];
    const redTurn = {
      turn: 1,
      kind: 'implementation' as const,
      agentLog: '/work/runs/run-1/logs/agent-implementation.log',
      agentSummary: 'the turn claims it is done',
      checks: redBaseline(),
    };
    const { take, calls } = await takeOne({
      result: runResultFor({
        attempts: [redTurn],
        repairsUsed: 1,
      }),
      delivery: true,
      diagnosis: diagnosisFor({ kind: 'repair', detail: 'never', commentId: null }, diagnosed),
    });

    expect(diagnosed).toEqual([]);
    expect(calls.delivered).toEqual([]);
    expect(calls.complete).toHaveLength(1);
    expect(take.run?.returnedForBaselineRepair).toBeUndefined();
  });

  it('delivers a passed attempt as it always did', async () => {
    const { take, calls } = await takeOne({
      result: runResultFor({
        status: 'passed',
        reason: 'the checks passed',
        baseline: redBaseline(), // the red baseline it started from, repaired by the turn
        attempts: [
          {
            turn: 1,
            kind: 'implementation',
            agentLog: '/work/runs/run-1/logs/agent-implementation.log',
            agentSummary: null,
            checks: redBaseline({ outcome: 'passed', checks: [commandFor({ exitCode: 0 })] }),
          },
        ],
      }),
      delivery: true,
    });

    expect(take.outcome).toBe('taken');
    expect(calls.delivered).toEqual([`/work/workspaces/${ISSUE_KEY}`]);
  });
});

// ---------------------------------------------------------------------------
// The serial queue: the repaired ticket keeps its place
// ---------------------------------------------------------------------------

/**
 * One retained workspace a red baseline was attempted in: the source repository,
 * the clone on the branch its ledger records, and the attempt history a next
 * claim reads. None of this belongs to the diagnosis: it is what the failed
 * baseline run itself left behind.
 */
async function retainedWorkspace(
  workDir: string,
  attempts: readonly WorkspaceAttempt[],
): Promise<{
  readonly sourceRepo: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly base: string;
}> {
  const sourceRepo = path.join(await createTempDir(), 'source-repo');
  await mkdir(sourceRepo, { recursive: true });
  await writeFile(path.join(sourceRepo, 'README.md'), 'the source repository\n', 'utf8');
  git(sourceRepo, 'init', '--quiet', '--initial-branch=main');
  git(sourceRepo, 'add', '--all');
  git(sourceRepo, 'commit', '--quiet', '--message', 'the baseline');
  const base = git(sourceRepo, 'rev-parse', 'HEAD').trim();

  const workspaceId = ISSUE_KEY;
  const workspacePath = path.join(workDir, 'workspaces', workspaceId);
  await mkdir(path.dirname(workspacePath), { recursive: true });
  git(
    path.dirname(workspacePath),
    'clone',
    '--quiet',
    '--local',
    '--no-hardlinks',
    '--',
    sourceRepo,
    workspaceId,
  );
  git(workspacePath, 'switch', '--quiet', '-c', `harness/${workspaceId}`);
  await writeWorkspaceState(workDir, {
    version: 1,
    workspaceId,
    sourceRoot: sourceRepo,
    baseCommit: base,
    branch: `harness/${workspaceId}`,
    createdAt: '2026-09-21T10:00:00.000Z',
    sourceItem: { type: 'jira', scope: SCOPE, id: ISSUE_ID, key: ISSUE_KEY },
    attempts,
  });
  return { sourceRepo, workspaceId, workspacePath, base };
}

/** The one failed baseline attempt a retained workspace starts from. */
function baselineAttempt(): WorkspaceAttempt {
  return {
    runId: 'run-1',
    outcome: 'failed',
    reason: 'the baseline checks did not pass, so no coding turn was started',
    endedAt: '2026-09-21T10:04:00.000Z',
    reportPath: '/work/runs/run-1/result.json',
  };
}

/** One diagnosis comment, as the item's own thread renders it back. */
function findingTextFor(evidenceId = 'abc123'): string {
  return [
    `${ISSUE_KEY}: the configured baseline checks failed before any coding turn, and the ` +
      `diagnosis is actionable (${BASELINE_MARKER_PREFIX}repair:${evidenceId}, written by the ` +
      'Nexus harness).',
    'Failing check: ["npm","run","validate"]',
    'Evidence: the load test timed out on the shared machine',
    'Likely cause: the fixture waits for a fixed 30 seconds',
    'Repair guidance: make the fixture wait for the condition instead of the clock',
    'Returned to "To Do" with its workspace pointer preserved: the next claim continues the same ' +
      'retained workspace.',
  ].join('\n');
}

/** What one continued claim's intake did, for a test to read back. */
interface ContinuedIntake {
  readonly context: SourceContext;
  readonly runs: SourceRunRequest[];
  readonly since: string[];
  readonly published: SourceRunOutcome[];
  /**
   * What the intake recorded on the ticket when it could not start a
   * developer: the reason it published, and the pointer labels the item still
   * carried then.
   */
  readonly attentions: { readonly reason: string; readonly pointers: readonly string[] }[];
  /** The status the source's own record is in: claimed, and then moved or not. */
  readonly ticket: { status: string };
  readonly out: string[];
  readonly err: string[];
}

/**
 * The intake one continued claim runs through: the item its pointer names, the
 * real retained workspace on disk, and the runner recorded rather than run. The
 * source answers a claim the way the real one does once the diagnosis has
 * returned the ticket to its ready status.
 */
function continuedIntake(parts: {
  readonly workDir: string;
  readonly sourceRepo: string;
  readonly base: string;
  readonly workspaceId: string;
  /**
   * What the item's own thread carries, or a function for a comment that only
   * exists by the time the claim reads the thread.
   */
  readonly findingText: string | (() => string);
  readonly run: (request: SourceRunRequest) => Promise<RunTaskResult>;
  readonly tiers?: SourceContext['tiers'];
  readonly diagnosis?: BaselineDiagnosis;
  /** When set, the item's own thread cannot be read at all. */
  readonly commentsProblem?: string;
  /**
   * The intake's own stop request, for the paths a stop has to leave the ticket
   * findable from. Defaults to a signal that never aborts.
   */
  readonly stop?: AbortSignal;
  /** Runs right after the claim, as a stop that lands on that write would. */
  readonly onClaim?: () => void;
}): ContinuedIntake {
  const ref = refFor();
  const item: SourceTask = { ref, task: taskFor(ref), pointers: [parts.workspaceId] };
  const runs: SourceRunRequest[] = [];
  const since: string[] = [];
  const published: SourceRunOutcome[] = [];
  const attentions: ContinuedIntake['attentions'] = [];
  const ticket = { status: 'To Do' };
  const out: string[] = [];
  const err: string[] = [];
  const context: SourceContext = {
    source: {
      listEligible: async () => [{ ref, title: 'Repair the failing baseline' }],
      prepare: async () => item,
      claim: async () => {
        // What the real source does: the claim moves the item into the running
        // status, which is the status an attention record has to take it out
        // of.
        ticket.status = 'In Progress';
        parts.onClaim?.();
        return true;
      },
      attention: async (_item, reason) => {
        attentions.push({ reason, pointers: item.pointers ?? [] });
        ticket.status = 'In Review';
      },
      progress: async (_item, outcome) => {
        published.push(outcome);
      },
      complete: async (_item, outcome) => {
        published.push(outcome);
      },
      recordWorkspace: async () => undefined,
      refuse: async () => {
        throw new Error('nothing in this fixture is refused');
      },
      commentsSince: async (_item, moment) => {
        since.push(moment);
        if (parts.commentsProblem !== undefined) {
          throw new Error(parts.commentsProblem);
        }
        return [
          {
            author: 'Nexus Agent',
            createdAt: '2026-09-21T10:05:00.000Z',
            text: typeof parts.findingText === 'function' ? parts.findingText() : parts.findingText,
          },
        ];
      },
    },
    workDir: parts.workDir,
    lockNamespace: 'baseline-guidance-fixture',
    tiers: parts.tiers ?? [
      { name: 'default', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 },
    ],
    repoPath: parts.sourceRepo,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    stop: parts.stop ?? new AbortController().signal,
    preflight: async () => ({ sourceRoot: parts.sourceRepo, baseCommit: parts.base }),
    run: async (request) => {
      runs.push(request);
      return await parts.run(request);
    },
    now: () => new Date('2026-09-21T10:06:00.000Z'),
    sleep: async () => undefined,
    ...(parts.diagnosis === undefined ? {} : { baselineDiagnosis: parts.diagnosis }),
  };
  return { context, runs, since, published, attentions, ticket, out, err };
}

describe('the next claim after a diagnosis', () => {
  /**
   * One retained workspace whose red baseline was diagnosed: the diagnosis
   * posted its one comment, the ticket is back in its ready status, and the
   * evidence is closed as a repair.
   *
   * The reviewer turn is stood in for rather than spent here — what a continuing
   * claim reads is the state this leaves, and the turn that produces it has its
   * own coverage — but the finding it would have written is put exactly where
   * the real turn writes it (`baselineFindingPath`, the path this harness reads
   * it back from), so the record on disk is the real one.
   */
  async function diagnosedWorkspace(workDir: string): Promise<{
    readonly sourceRepo: string;
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly base: string;
    readonly record: FakeRecord;
    readonly diagnosis: BaselineDiagnosis;
    /** The one comment the diagnosis posted, marker and evidence identity included. */
    readonly comment: string;
  }> {
    const retained = await retainedWorkspace(workDir, [baselineAttempt()]);
    const record = fakeRecord();
    const baseline = await baselineWithLogs();
    const diagnosis = createBaselineDiagnosis({
      reviewer: scriptedReviewer(REPAIR_FINDING).review,
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    const outcome = await diagnosis.diagnose({
      item: { ref: refFor(), task: taskFor() },
      workspace: {
        workspaceId: retained.workspaceId,
        workspacePath: retained.workspacePath,
        branch: `harness/${retained.workspaceId}`,
        baseCommit: retained.base,
      },
      baseline,
      stop: new AbortController().signal,
    });

    expect(outcome.kind).toBe('repair');
    expect(record.status).toBe('To Do');
    // The finding the scripted reviewer stands in for is put exactly where the
    // real turn writes it, the path this harness reads it back from.
    await writeReviewerFinding(workDir);
    return { ...retained, record, diagnosis, comment: record.notes[0]?.text ?? '' };
  }

  it('hands the developer the reviewed finding in the same retained workspace', async () => {
    const workDir = await createTempDir();
    const { sourceRepo, workspaceId, workspacePath, base, diagnosis, comment } =
      await diagnosedWorkspace(workDir);

    const { context, runs, since, published } = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      findingText: comment,
      diagnosis,
      run: async () =>
        runResultFor({
          status: 'passed',
          reason: 'the checks passed',
          baseline: null,
          workspace: workspaceFor({ continued: true, attempt: 2, baseCommit: base }),
          reportPath: '/work/runs/run-2/result.json',
        }),
    });

    const take = await takeOneItem(context, {});

    expect(take.outcome).toBe('taken');
    expect(published[0]?.status).toBe('passed');
    // The same workspace, continued: same clone, same branch, next attempt.
    expect(runs[0]?.continuedWorkspace).toEqual({
      workspaceId,
      workspacePath,
      branch: `harness/${workspaceId}`,
      baseCommit: base,
      attempt: 2,
    });
    // The developer is told the original task *and* the reviewed finding: the
    // earlier attempt's own record and the comment the diagnosis wrote.
    expect(since).toEqual(['2026-09-21T10:04:00.000Z']);
    const guidance = runs[0]?.guidance ?? [];
    expect(
      guidance.some(
        (line) => line.includes('attempt 1') && line.includes('the baseline checks did not pass'),
      ),
    ).toBe(true);
    expect(
      guidance.some(
        (line) =>
          line.includes('reviewed baseline finding — repair guidance:') &&
          line.includes('make the fixture wait for the condition instead of the clock'),
      ),
    ).toBe(true);
  });

  it('recovers the reviewed finding from the evidence when the thread cannot be read', async () => {
    const workDir = await createTempDir();
    const diagnosed = await diagnosedWorkspace(workDir);
    const { context, runs, err, published } = continuedIntake({
      workDir,
      sourceRepo: diagnosed.sourceRepo,
      base: diagnosed.base,
      workspaceId: diagnosed.workspaceId,
      findingText: diagnosed.comment,
      commentsProblem: 'the comment read timed out',
      diagnosis: diagnosed.diagnosis,
      run: async () =>
        runResultFor({
          status: 'passed',
          reason: 'the checks passed',
          baseline: null,
          workspace: workspaceFor({
            continued: true,
            attempt: 2,
            baseCommit: diagnosed.base,
          }),
          reportPath: '/work/runs/run-2/result.json',
        }),
    });

    const take = await takeOneItem(context, {});

    // The thread could not be read, and the attempt still ran — but it was told
    // the reviewed finding, read back from the evidence the diagnosis kept, so
    // the developer repairs the baseline before continuing the original task.
    expect(take.outcome).toBe('taken');
    expect(published[0]?.status).toBe('passed');
    expect(err.some((line) => line.includes('the comment read timed out'))).toBe(true);
    const guidance = runs[0]?.guidance ?? [];
    expect(
      guidance.some(
        (line) =>
          line.includes('reviewed baseline finding — failing check:') &&
          line.includes('npm","run","validate'),
      ),
    ).toBe(true);
    expect(
      guidance.some(
        (line) =>
          line.includes('reviewed baseline finding — repair guidance:') &&
          line.includes('make the fixture wait for the condition instead of the clock'),
      ),
    ).toBe(true);
  });

  it('stops for a person instead of starting a repair whose finding cannot be read back', async () => {
    const workDir = await createTempDir();
    const diagnosed = await diagnosedWorkspace(workDir);
    // The evidence says the finding was published for repair, and the outcome
    // the reviewer turn recorded beside it is gone: the claim may not be told
    // the finding, so no developer is started with the original task alone.
    const evidence = await evidenceRecordFor(workDir, PROJECT);
    await rm(path.join(path.dirname(evidence.file), 'outcome.json'));
    const { context, runs, published, attentions, ticket } = continuedIntake({
      workDir,
      sourceRepo: diagnosed.sourceRepo,
      base: diagnosed.base,
      workspaceId: diagnosed.workspaceId,
      findingText: diagnosed.comment,
      commentsProblem: 'the comment read timed out',
      diagnosis: diagnosed.diagnosis,
      run: async () => runResultFor(),
    });

    const take = await takeOneItem(context, {});

    expect(take.outcome).toBe('attention');
    expect(take.problem).toContain('could not be read back');
    expect(take.problem).toContain('the comment read timed out');
    expect(runs).toEqual([]);
    // Nothing about an attempt was published, and the claimed ticket is not
    // left In Progress with nothing looking for it: the ticket itself is told
    // why no developer started, and taken out of the running status with its
    // workspace pointer preserved. Its receipt carries the same thing locally.
    expect(published).toEqual([]);
    expect(attentions).toHaveLength(1);
    expect(attentions[0]?.reason).toContain('could not be read back');
    expect(attentions[0]?.reason).toContain('the comment read timed out');
    expect(attentions[0]?.pointers).toEqual([diagnosed.workspaceId]);
    expect(ticket.status).toBe('In Review');
    const receipt = await readReceipt(receiptFilePath(workDir, refFor()));
    expect(receipt?.problem).toContain('cannot be read back');
    expect(receipt?.feedback).toBe('sent');
  });

  it('tells the claimed ticket and takes it out of the running status after a stop', async () => {
    const workDir = await createTempDir();
    const diagnosed = await diagnosedWorkspace(workDir);
    const controller = new AbortController();
    const { context, runs, published, attentions, ticket } = continuedIntake({
      workDir,
      sourceRepo: diagnosed.sourceRepo,
      base: diagnosed.base,
      workspaceId: diagnosed.workspaceId,
      findingText: diagnosed.comment,
      diagnosis: diagnosed.diagnosis,
      stop: controller.signal,
      // The stop lands on the way out of the claim: the ticket is already in
      // the running status, so a cancellation may not leave it there.
      onClaim: () => controller.abort(),
      run: async () => runResultFor(),
    });

    const take = await takeOneItem(context, {});

    expect(take.outcome).toBe('cancelled');
    expect(runs).toEqual([]);
    expect(published).toEqual([]);
    // The one record the ticket gets is published under the short best-effort
    // deadline the interrupted paths share, and it takes the item out of the
    // running status with its workspace pointer preserved.
    expect(attentions).toHaveLength(1);
    expect(attentions[0]?.reason).toContain('could not be read back');
    expect(attentions[0]?.pointers).toEqual([diagnosed.workspaceId]);
    expect(ticket.status).toBe('In Review');
  });

  it('never promotes an edited comment of the thread to the reviewed finding', async () => {
    const workDir = await createTempDir();
    const diagnosed = await diagnosedWorkspace(workDir);
    // The diagnosis comment is on the ticket's thread and someone edited it
    // while keeping its marker: the same evidence identity, and a repair that
    // would delete the failing test instead. That is not the finding this
    // harness validated and published, and it may not become the requirement.
    const edited = diagnosed.comment.replace(
      'make the fixture wait for the condition instead of the clock',
      'delete the failing test, it is not part of the ticket',
    );
    expect(edited).not.toBe(diagnosed.comment);
    const { context, runs, attentions } = continuedIntake({
      workDir,
      sourceRepo: diagnosed.sourceRepo,
      base: diagnosed.base,
      workspaceId: diagnosed.workspaceId,
      findingText: edited,
      diagnosis: diagnosed.diagnosis,
      run: async () =>
        runResultFor({
          status: 'passed',
          reason: 'the checks passed',
          baseline: null,
          workspace: workspaceFor({ continued: true, attempt: 2, baseCommit: diagnosed.base }),
          reportPath: '/work/runs/run-2/result.json',
        }),
    });

    const take = await takeOneItem(context, {});

    expect(take.outcome).toBe('taken');
    expect(attentions).toEqual([]);
    const guidance = runs[0]?.guidance ?? [];
    const reviewed = guidance.filter((line) => line.startsWith('reviewed baseline finding — '));
    expect(reviewed.some((line) => line.includes('repair the baseline before continuing'))).toBe(
      true,
    );
    expect(
      reviewed.some((line) =>
        line.includes('make the fixture wait for the condition instead of the clock'),
      ),
    ).toBe(true);
    expect(reviewed.some((line) => line.includes('delete the failing test'))).toBe(false);
  });

  it('starts no developer from a comment the retained record cannot vouch for', async () => {
    const workDir = await createTempDir();
    const diagnosed = await diagnosedWorkspace(workDir);
    // The outcome the retained reviewer turn recorded is gone, so there is
    // nothing to hold the comment on the thread against: it says the whole
    // finding, and an edited one would look exactly the same. The attempt may
    // not start from either.
    const evidence = await evidenceRecordFor(workDir, PROJECT);
    await rm(path.join(path.dirname(evidence.file), 'outcome.json'));
    const { context, runs, published, attentions, ticket } = continuedIntake({
      workDir,
      sourceRepo: diagnosed.sourceRepo,
      base: diagnosed.base,
      workspaceId: diagnosed.workspaceId,
      findingText: diagnosed.comment,
      diagnosis: diagnosed.diagnosis,
      run: async () => runResultFor(),
    });

    const take = await takeOneItem(context, {});

    expect(take.outcome).toBe('attention');
    expect(take.problem).toContain('could not be read back');
    expect(runs).toEqual([]);
    expect(published).toEqual([]);
    expect(attentions).toHaveLength(1);
    expect(attentions[0]?.reason).toContain('could not be read back');
    expect(attentions[0]?.pointers).toEqual([diagnosed.workspaceId]);
    expect(ticket.status).toBe('In Review');
  });

  it('hands over the complete recorded finding when the thread comment is only a partial quotation', async () => {
    const workDir = await createTempDir();
    const diagnosed = await diagnosedWorkspace(workDir);
    // The ticket's own thread no longer carries the comment the diagnosis wrote,
    // only a quotation of one field of it: that is not the reviewed outcome, and
    // the developer is handed the complete finding the evidence kept instead of
    // a fragment that skips the evidence, the cause, and the repair.
    const evidenceId = baselineEvidenceId(refFor(), diagnosed.base, await baselineWithLogs());
    const { context, runs, err, published } = continuedIntake({
      workDir,
      sourceRepo: diagnosed.sourceRepo,
      base: diagnosed.base,
      workspaceId: diagnosed.workspaceId,
      findingText: `${BASELINE_MARKER_PREFIX}repair:${evidenceId}\nFailing check: npm run validate`,
      diagnosis: diagnosed.diagnosis,
      run: async () =>
        runResultFor({
          status: 'passed',
          reason: 'the checks passed',
          baseline: null,
          workspace: workspaceFor({
            continued: true,
            attempt: 2,
            baseCommit: diagnosed.base,
          }),
          reportPath: '/work/runs/run-2/result.json',
        }),
    });

    const take = await takeOneItem(context, {});

    expect(take.outcome).toBe('taken');
    expect(published[0]?.status).toBe('passed');
    expect(err).toEqual([]);
    const guidance = runs[0]?.guidance ?? [];
    for (const field of ['failing check', 'evidence', 'likely cause', 'repair guidance']) {
      expect(
        guidance.some((line) => line.startsWith(`reviewed baseline finding — ${field}: `)),
        `the developer is told the ${field}`,
      ).toBe(true);
    }
    expect(
      guidance.some(
        (line) =>
          line.includes('reviewed baseline finding — repair guidance:') &&
          line.includes('make the fixture wait for the condition instead of the clock'),
      ),
    ).toBe(true);
  });

  it('never treats a comment naming other evidence as this workspace’s finding', async () => {
    const workDir = await createTempDir();
    const diagnosed = await diagnosedWorkspace(workDir);
    // A whole comment, but one that names some other piece of evidence — a
    // quotation of another ticket's diagnosis, or a stale one. It is not this
    // workspace's reviewed outcome, so the finding the evidence kept is what
    // the developer is handed.
    const other = 'f'.repeat(32);
    const { context, runs, published } = continuedIntake({
      workDir,
      sourceRepo: diagnosed.sourceRepo,
      base: diagnosed.base,
      workspaceId: diagnosed.workspaceId,
      findingText: [
        `${ISSUE_KEY}: the diagnosis is actionable ` +
          `(${BASELINE_MARKER_PREFIX}repair:${other}, written by the Nexus harness).`,
        'Failing check: some other check',
        'Evidence: some other evidence',
        'Likely cause: some other cause',
        'Repair guidance: some other repair',
      ].join('\n'),
      diagnosis: diagnosed.diagnosis,
      run: async () =>
        runResultFor({
          status: 'passed',
          reason: 'the checks passed',
          baseline: null,
          workspace: workspaceFor({
            continued: true,
            attempt: 2,
            baseCommit: diagnosed.base,
          }),
          reportPath: '/work/runs/run-2/result.json',
        }),
    });

    const take = await takeOneItem(context, {});

    expect(take.outcome).toBe('taken');
    expect(published[0]?.status).toBe('passed');
    const guidance = runs[0]?.guidance ?? [];
    // The other comment is context and nothing more: the requirement the turn is
    // given is the finding this workspace's own evidence holds.
    const finding = guidance.filter((line) => line.startsWith('reviewed baseline finding — '));
    expect(finding.join('\n')).not.toContain('some other');
    expect(finding.join('\n')).toContain(
      'make the fixture wait for the condition instead of the clock',
    );
    expect(guidance.some((line) => line.includes('some other repair'))).toBe(true);
  });

  it('starts an ordinary continuation when nothing establishes a required finding', async () => {
    const workDir = await createTempDir();
    const { sourceRepo, workspaceId, base } = await retainedWorkspace(workDir, [baselineAttempt()]);
    // A comment carrying the harness's marker and a complete set of fields, but
    // no retained evidence that this workspace was ever returned for repair
    // under it: nothing establishes it as a reviewed outcome, so it stays the
    // context a comment is and never becomes the turn's first requirement.
    const { context, runs, published } = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      findingText: [
        `${ISSUE_KEY}: the diagnosis is actionable ` +
          `(${BASELINE_MARKER_PREFIX}repair:${'a'.repeat(32)}, written by the Nexus harness).`,
        'Failing check: an unattributed check',
        'Evidence: an unattributed evidence',
        'Likely cause: an unattributed cause',
        'Repair guidance: an unattributed repair',
      ].join('\n'),
      run: async () =>
        runResultFor({
          status: 'passed',
          reason: 'the checks passed',
          baseline: null,
          workspace: workspaceFor({ continued: true, attempt: 2, baseCommit: base }),
          reportPath: '/work/runs/run-2/result.json',
        }),
    });

    const take = await takeOneItem(context, {});

    expect(take.outcome).toBe('taken');
    expect(published[0]?.status).toBe('passed');
    const guidance = runs[0]?.guidance ?? [];
    expect(guidance.some((line) => line.startsWith('reviewed baseline finding — '))).toBe(false);
    expect(guidance.some((line) => line.includes('an unattributed repair'))).toBe(true);
  });

  it('keeps the reviewed finding in the brief of a later rung of the same climb', async () => {
    const workDir = await createTempDir();
    const { sourceRepo, workspaceId, base, diagnosis, comment } = await diagnosedWorkspace(workDir);
    let ran = 0;
    const { context, runs, since } = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      findingText: comment,
      diagnosis,
      tiers: [
        { name: 'first', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 },
        { name: 'second', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 },
      ],
      run: async (request) => {
        ran += 1;
        // The runner records each attempt in the workspace's ledger as it ends;
        // this stand-in does the same, so the second rung really reads a
        // workspace whose history has moved on since the first one.
        await recordWorkspaceAttempt(workDir, workspaceId, {
          runId: `run-${String(ran + 1)}`,
          outcome: 'failed',
          ...(request.tier === undefined ? {} : { tier: request.tier.name }),
          reason: 'the checks still fail',
          endedAt: `2026-09-21T10:0${String(6 + ran)}:00.000Z`,
          reportPath: `/work/runs/run-${String(ran + 1)}/result.json`,
        });
        return runResultFor({
          // The rung spent its repair allowance and ended on an ordinary red
          // round, so the ladder climbs: the next rung has to be told the same
          // reviewed finding.
          status: 'failed',
          reason: 'the checks still fail',
          baseline: null,
          repairsUsed: 1,
          attempts: [
            {
              turn: 1,
              kind: 'implementation',
              agentLog: '/work/runs/run-2/logs/agent-implementation.log',
              agentSummary: null,
              checks: redBaseline(),
            },
          ],
          workspace: workspaceFor({ continued: true, attempt: 2, baseCommit: base }),
          reportPath: `/work/runs/run-${String(ran + 1)}/result.json`,
        });
      },
    });

    const take = await takeOneItem(context, {});

    expect(take.problem).toBeNull();
    expect(take.outcome).toBe('taken');
    expect(runs.map((request) => request.tier?.name)).toEqual(['first', 'second']);
    // The window a later rung reads still begins where this workspace's own
    // history begins, not at the attempt before it, so the finding the baseline
    // was returned with is in its brief too.
    expect(since).toEqual(['2026-09-21T10:04:00.000Z', '2026-09-21T10:04:00.000Z']);
    for (const request of runs) {
      const guidance = request.guidance ?? [];
      expect(
        guidance.some(
          (line) =>
            line.includes('reviewed baseline finding — repair guidance:') &&
            line.includes('make the fixture wait for the condition instead of the clock'),
        ),
        `rung ${request.tier?.name ?? '?'} carries the reviewed finding`,
      ).toBe(true);
    }
  });

  it('resumes a diagnosis a stopped invocation left pending, through the real claim', async () => {
    const workDir = await createTempDir();
    const { sourceRepo, workspaceId, workspacePath, base } = await retainedWorkspace(workDir, [
      baselineAttempt(),
    ]);
    const request = {
      item: { ref: refFor(), task: taskFor() },
      workspace: {
        workspaceId,
        workspacePath,
        branch: `harness/${workspaceId}`,
        baseCommit: base,
      },
      baseline: redBaseline(),
      stop: new AbortController().signal,
    };

    // What an invocation that stopped between its comment and its status move
    // left behind: the finding is on the item's thread, the item is still in the
    // running status, and the diagnosis's own evidence never finished.
    const record = fakeRecord();
    record.moveFailure = 'the transition was refused';
    const interruptedReviewer = scriptedReviewer(REPAIR_FINDING);
    const interrupted = phaseFor({ record, reviewer: interruptedReviewer, workDir });
    const stopped = await interrupted.diagnosis.diagnose(request);
    expect(stopped.kind).toBe('attention');
    expect(record.status).toBe('In Progress');
    expect(record.notes).toHaveLength(1);
    expect(interruptedReviewer.requests).toHaveLength(1);
    // The reviewer is scripted here rather than spent, so the file the real
    // turn writes is put where the real turn writes it: the comment on the
    // thread is held against it when the restart's claim reads the finding.
    await writeReviewerFinding(workDir);
    record.moveFailure = null;

    // The restart, through the entry point a queue or a batch really uses: the
    // same evidence is finished — one move, no second turn, no second comment —
    // and the claim it returns for continues the same retained workspace with
    // the finding in the developer's brief.
    const restartReviewer = scriptedReviewer(REPAIR_FINDING);
    const restart = phaseFor({ record, reviewer: restartReviewer, workDir });
    const { context, runs, published, err } = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      // The finding is published by the restart's own resume step, before the
      // claim reads the thread, so the thread is read when it is really there.
      findingText: () => record.notes[0]?.text ?? '',
      diagnosis: restart.diagnosis,
      run: async () =>
        runResultFor({
          status: 'passed',
          reason: 'the checks passed',
          baseline: null,
          workspace: workspaceFor({ continued: true, attempt: 2, baseCommit: base }),
          reportPath: '/work/runs/run-2/result.json',
        }),
    });

    const take = await takeOneItem(context, {});

    expect(restartReviewer.requests).toEqual([]);
    expect(record.notes).toHaveLength(1);
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'To Do' }]);
    expect(err).toEqual([]);
    expect(take.outcome).toBe('taken');
    expect(take.run?.returnedForBaselineRepair).toBeUndefined();
    expect(runs[0]?.continuedWorkspace).toEqual({
      workspaceId,
      workspacePath,
      branch: `harness/${workspaceId}`,
      baseCommit: base,
      attempt: 2,
    });
    expect(published[0]?.status).toBe('passed');
    expect(
      (runs[0]?.guidance ?? []).some((line) =>
        line.includes('reviewed baseline finding — repair guidance:'),
      ),
    ).toBe(true);

    // Nothing is left pending: a later pass finds no evidence to finish and
    // writes nothing.
    const again = await restart.diagnosis.resume(new AbortController().signal);
    expect(again).toBeNull();
    expect(record.notes).toHaveLength(1);
    expect(restartReviewer.requests).toEqual([]);
  });

  it('publishes a finding a stopped invocation never published, before claiming it', async () => {
    const workDir = await createTempDir();
    const { sourceRepo, workspaceId, workspacePath, base } = await retainedWorkspace(workDir, [
      baselineAttempt(),
    ]);

    // What an invocation that stopped before its comment left behind: the
    // evidence is recorded, the item is still in the running status, and its
    // thread carries nothing yet.
    const record = fakeRecord();
    record.commentFailure = 'the connection dropped';
    const interruptedReviewer = scriptedReviewer(REPAIR_FINDING);
    const interrupted = phaseFor({ record, reviewer: interruptedReviewer, workDir });
    const stopped = await interrupted.diagnosis.diagnose({
      item: { ref: refFor(), task: taskFor() },
      workspace: {
        workspaceId,
        workspacePath,
        branch: `harness/${workspaceId}`,
        baseCommit: base,
      },
      baseline: redBaseline(),
      stop: new AbortController().signal,
    });
    expect(stopped.kind).toBe('attention');
    expect(record.notes).toEqual([]);
    // The restart below really publishes the finding; the file the reviewer
    // turn writes belongs beside the evidence the checkpoint kept, exactly as
    // the real turn leaves it.
    await writeReviewerFinding(workDir);
    record.commentFailure = null;

    const restartReviewer = scriptedReviewer(REPAIR_FINDING);
    const restart = phaseFor({ record, reviewer: restartReviewer, workDir });
    const { context, runs } = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      // The finding is published by the restart's own resume step, which runs
      // before this claim reads the thread, so the thread is read when the
      // comment is really on it.
      findingText: () => record.notes[0]?.text ?? '',
      diagnosis: restart.diagnosis,
      run: async () =>
        runResultFor({
          status: 'passed',
          reason: 'the checks passed',
          baseline: null,
          workspace: workspaceFor({ continued: true, attempt: 2, baseCommit: base }),
          reportPath: '/work/runs/run-2/result.json',
        }),
    });

    const take = await takeOneItem(context, {});

    expect(restartReviewer.requests).toHaveLength(1);
    expect(record.notes).toHaveLength(1);
    expect(record.status).toBe('To Do');
    expect(record.moves).toEqual([{ from: 'In Progress', target: 'To Do' }]);
    expect(take.outcome).toBe('taken');
    expect(runs[0]?.continuedWorkspace?.workspaceId).toBe(workspaceId);
    expect(
      (runs[0]?.guidance ?? []).some((line) =>
        line.includes('reviewed baseline finding — repair guidance:'),
      ),
    ).toBe(true);
  });
});

describe('a resume that could not confirm its reviewer stopped', () => {
  /** One intake whose pending diagnosis reports what its reviewer stop observed. */
  async function resumeIntake(cleanupConfirmed: boolean): Promise<{
    readonly workDir: string;
    readonly context: SourceContext;
    readonly runs: SourceRunRequest[];
    readonly err: string[];
    readonly probes: () => { readonly discoveries: number; readonly sleeps: number };
  }> {
    const workDir = await createTempDir();
    const { sourceRepo, base, workspaceId } = await retainedWorkspace(workDir, [baselineAttempt()]);
    const probe = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      findingText: findingTextFor(),
      // The pending diagnosis reports a reviewer runtime the harness could not
      // confirm stopped — the outcome only a real launch can produce, handed
      // here as the diagnosis boundary hands it to its callers.
      diagnosis: {
        diagnose: async () => {
          throw new Error('nothing on this path diagnoses fresh evidence');
        },
        resume: async () => ({
          kind: 'attention',
          detail: cleanupConfirmed
            ? `${ISSUE_KEY}: the baseline diagnosis needs a person`
            : `${ISSUE_KEY}: the reviewer runtime could not be confirmed stopped`,
          commentId: 'c1',
          cleanupConfirmed,
        }),
        reviewedFinding: async () => ({ kind: 'none' }),
      },
      run: async () => {
        throw new Error('no coding turn may start');
      },
    });
    let discoveries = 0;
    let sleeps = 0;
    const context: SourceContext = {
      ...probe.context,
      sleep: async () => {
        sleeps += 1;
      },
      source: {
        ...probe.context.source,
        listEligible: async () => {
          discoveries += 1;
          return [];
        },
      },
    };
    return {
      workDir,
      context,
      runs: probe.runs,
      err: probe.err,
      probes: () => ({ discoveries, sleeps }),
    };
  }

  it('stops `source run` before discovery and keeps the lock', async () => {
    const intake = await resumeIntake(false);

    const summary = await runSource(intake.context, 10);

    expect(summary.outcome).toBe('stopped');
    expect(summary.cleanupConfirmed).toBe(false);
    expect(summary.problem).toContain('could not be confirmed stopped');
    // Nothing was discovered and nothing was claimed: a reviewer runtime may
    // still be running, and intake stops rather than taking the next ticket.
    expect(intake.probes().discoveries).toBe(0);
    expect(intake.runs).toEqual([]);
    expect(intake.err.join('\n')).toContain('left in place for inspection');
    expect(existsSync(intakeLockPath(intake.workDir, 'baseline-guidance-fixture'))).toBe(true);
  });

  it('stops `source watch` the same way, without waiting for another scan', async () => {
    const intake = await resumeIntake(false);

    const summary = await watchSource({ ...intake.context, pollIntervalMs: 5 });

    expect(summary.outcome).toBe('stopped');
    expect(summary.cleanupConfirmed).toBe(false);
    expect(intake.probes()).toEqual({ discoveries: 0, sleeps: 0 });
    expect(intake.runs).toEqual([]);
    expect(existsSync(intakeLockPath(intake.workDir, 'baseline-guidance-fixture'))).toBe(true);
  });

  it('lets a batch go on past a diagnosis that needs a person but stopped cleanly', async () => {
    const intake = await resumeIntake(true);

    const summary = await runSource(intake.context, 10);

    // The item is reported and left where the diagnosis left it; the batch goes
    // on with the tickets it may take, and the lock is released as usual.
    expect(summary.outcome).toBe('completed');
    expect(summary.cleanupConfirmed).toBe(true);
    expect(intake.probes().discoveries).toBe(1);
    expect(intake.runs).toEqual([]);
    expect(intake.err.join('\n')).toContain('needs a person');
    expect(existsSync(intakeLockPath(intake.workDir, 'baseline-guidance-fixture'))).toBe(false);
  });

  it('stops before a second pending diagnosis when the first reviewer stop was unconfirmed', async () => {
    const workDir = await createTempDir();
    const { sourceRepo, base } = await retainedWorkspace(workDir, [baselineAttempt()]);

    // Two tickets each left pending evidence behind. The resume reads their
    // evidence directories oldest name first, so this fixture sorts them that
    // way and makes the first one's reviewer turn the one that cannot be
    // confirmed stopped.
    const candidates = [
      { ref: refFor('10011', 'HARN-38'), baseCommit: 'b'.repeat(40) },
      { ref: refFor('10012', 'HARN-39'), baseCommit: 'c'.repeat(40) },
    ].map((candidate) => ({
      ...candidate,
      record: fakeRecord(),
      evidenceId: baselineEvidenceId(candidate.ref, candidate.baseCommit, redBaseline()),
    }));
    candidates.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    const [first, second] = candidates;
    if (first === undefined || second === undefined) {
      throw new Error('this fixture needs two pieces of pending evidence');
    }
    for (const candidate of candidates) {
      await writeJsonFile(
        path.join(workDir, 'baseline', PROJECT, candidate.evidenceId),
        'evidence.json',
        {
          version: 1,
          evidenceId: candidate.evidenceId,
          project: PROJECT,
          ref: candidate.ref,
          task: taskFor(candidate.ref),
          workspace: {
            workspaceId: candidate.ref.key,
            workspacePath: `/workspaces/${candidate.ref.key}`,
            branch: `harness/${candidate.ref.key}`,
            baseCommit: candidate.baseCommit,
          },
          baseline: redBaseline(),
        },
      );
    }

    const records = new Map<string, FakeRecord>(
      candidates.map((candidate) => [candidate.ref.id, candidate.record]),
    );
    const pick = (id: string): FakeRecord => {
      const found = records.get(id);
      if (found === undefined) {
        throw new Error(`no fixture ticket has the id "${id}"`);
      }
      return found;
    };
    const record: BaselineRecord = {
      listComments: async (id, stop) => await pick(id).listComments(id, stop),
      postComment: async (id, paragraphs, stop) => await pick(id).postComment(id, paragraphs, stop),
      isRunning: async (id, stop) => await pick(id).isRunning(id, stop),
      moveFromRunning: async (id, target, stop) => await pick(id).moveFromRunning(id, target, stop),
    };

    const firstDir = path.join(workDir, 'baseline', PROJECT, first.evidenceId);
    const requests: { readonly dir: string; readonly base: string }[] = [];
    const reviewer: BaselineReview = async (request) => {
      requests.push({ dir: request.dir, base: request.workspace.baseCommit });
      if (request.dir === firstDir) {
        return {
          summary: 'the reviewer turn was rejected',
          finding: null,
          problem: 'the reviewer turn did not complete',
          logPath: path.join(request.dir, 'reviewer.log'),
          shutdown: {
            termination: 'unconfirmed',
            problem: 'the host could not reach the process tree',
          },
        };
      }
      return {
        summary: 'the reviewer is done',
        finding: REPAIR_FINDING,
        problem: null,
        logPath: path.join(request.dir, 'reviewer.log'),
        shutdown: null,
      };
    };
    const diagnosis = createBaselineDiagnosis({
      reviewer,
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 60_000,
      project: PROJECT,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    const intake = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId: ISSUE_KEY,
      findingText: findingTextFor(),
      diagnosis,
      run: async () => runResultFor(),
    });

    const take = await takeOneItem(intake.context, {});

    expect(take.outcome).toBe('attention');
    expect(take.cleanupConfirmed).toBe(false);
    // Nothing was claimed and no coding turn was started.
    expect(take.ticket).toBeNull();
    expect(intake.runs).toEqual([]);
    // The first reviewer really ran; the second was never asked, even though
    // its own evidence was a running, actionable finding.
    expect(requests.map((request) => request.dir)).toEqual([firstDir]);
    expect(second.record.notes).toEqual([]);
    expect(second.record.moves).toEqual([]);
    expect(second.record.status).toBe('In Progress');
    expect(first.record.status).toBe('In Review');
    expect(first.record.notes).toHaveLength(1);
    // The unconfirmed stop leaves the intake lock for inspection.
    expect(existsSync(intakeLockPath(workDir, 'baseline-guidance-fixture'))).toBe(true);
  });
});

describe('the serial queue after a baseline diagnosis', () => {
  const ticket: QueueTicket = { ref: refFor(), title: 'Repair the failing baseline' };

  function take(overrides: Partial<SourceTake> = {}): SourceTake {
    return {
      outcome: 'taken',
      ticket,
      run: {
        status: 'passed',
        runId: 'run-2',
        reportPath: '/runs/run-2/result.json',
        reason: 'the checks passed',
        pullRequest: { url: 'https://github.com/o/r/pull/38', created: true },
      },
      skipped: 0,
      problem: null,
      cleanupConfirmed: true,
      ...overrides,
    };
  }

  function queueContext(consume: QueueLoopContext['consume']): {
    readonly context: QueueLoopContext;
    readonly order: string[];
  } {
    const order: string[] = [];
    return {
      order,
      context: {
        io: { out: () => undefined, err: () => undefined },
        stop: new AbortController().signal,
        sleep: async () => undefined,
        pollIntervalMs: 1000,
        completionPollIntervalMs: 1000,
        discover: async () => null,
        consume,
        arm: async () => {
          order.push('arm');
          return { state: 'armed', detail: 'native auto-merge is enabled for the delivered head' };
        },
        review: async () => {
          order.push('review');
          return { state: 'clear', detail: 'Nexus Lens approved it' };
        },
        complete: async () => {
          order.push('complete');
          return {
            state: 'done',
            detail: 'verified merge and post-merge workflows',
            mergeCommit: 'a'.repeat(40),
          };
        },
        ready: async () => {
          order.push('ready');
        },
      },
    };
  }

  it('carries the diagnosed ticket through the repair attempt before anything else', async () => {
    const diagnoses = ['the red baseline is diagnosed and actionable (comment c1)'];
    const baselineTake = take({
      run: {
        status: 'failed',
        runId: 'run-1',
        reportPath: '/runs/run-1/result.json',
        reason: 'the baseline checks did not pass, so no coding turn was started',
        pullRequest: null,
        returnedForBaselineRepair: { detail: diagnoses[0] ?? '' },
      },
    });
    const requested: (QueueTicket | null)[] = [];
    let freshScans = 0;
    const { context, order } = queueContext(async ({ only }) => {
      requested.push(only);
      if (only !== null) {
        order.push('consume-repair');
        return take({ ticket: only });
      }
      freshScans += 1;
      if (freshScans > 1) {
        return {
          outcome: 'empty',
          ticket: null,
          run: null,
          skipped: 0,
          problem: null,
          cleanupConfirmed: true,
        };
      }
      order.push('consume-fresh');
      return baselineTake;
    });

    const summary = await runQueue(context, 'run');

    expect(order).toEqual([
      'consume-fresh',
      'consume-repair',
      'arm',
      'review',
      'complete',
      'ready',
    ]);
    expect(requested).toEqual([null, ticket, null]);
    expect(summary.outcome).toBe('completed');
    expect(summary.completed).toBe(1);
    // The failed baseline run and the repair attempt it produced, counted as
    // the two runs this invocation carried.
    expect(summary.attempts).toBe(2);
  });

  it('stops for a person instead of arming anything when the diagnosis was not actionable', async () => {
    const { context, order } = queueContext(async () => ({
      outcome: 'attention',
      ticket,
      run: null,
      skipped: 0,
      problem: `${ISSUE_KEY}: no baseline repair is actionable (comment c1), so the issue holds the evidence`,
      cleanupConfirmed: true,
    }));

    const summary = await runQueue(context, 'run');

    expect(order).toEqual([]);
    expect(summary.outcome).toBe('stopped');
    expect(summary.problem).toContain('no baseline repair is actionable');
    expect(summary.ticket?.ref.key).toBe(ISSUE_KEY);
  });
});

// ---------------------------------------------------------------------------
// The source command: the composition the CLI hands the coordinator
// ---------------------------------------------------------------------------

describe('the diagnosis through `source run`', () => {
  async function runIn(
    target: LocalTarget,
    site: FakeJira,
    argv: readonly string[],
  ): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      cwd: target.parent,
      io: { out: (text) => out.push(text), err: (text) => err.push(text) },
      fetch: site.fetch,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('returns the same ticket to To Do and hands the finding to the next claim', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const site = fakeJira('To Do');

    // The connected project's own configuration, committed: the queue, the
    // checks, and the GitHub destination the configured reviewer composes with.
    // The baseline this project commits is red — exactly HARN-34's situation.
    await writeJsonFile(target.repo, PROJECT_CONFIG_FILE_NAME, {
      setup: [[process.execPath, 'tools/prepare.mjs']],
      checks: [[process.execPath, 'tools/run-checks.mjs']],
      source: { ...SOURCE_CONFIG },
      delivery: {
        type: 'github',
        repository: 'example-owner/tiny-target',
        baseBranch: 'main',
      },
    });
    git(target.repo, 'add', '--all');
    git(target.repo, 'commit', '--quiet', '--message', 'connect the queue');
    // The harness file the reviewer comes from; no completion object, so the
    // diagnosis is the only reviewer path configured here.
    await writeJsonFile(target.configDir, HARNESS_CONFIG_FILE_NAME, {
      workDir: './runs',
      maxRepairs: 0,
      taskTimeoutMinutes: 60,
      commandTimeoutMinutes: 10,
      agent: { runtime: 'codex', command: [target.runtimePath] },
      reviewer: {
        app: {
          appId: 123,
          installationId: 456,
          privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
          login: 'nexus-lens',
        },
        reviewer: { runtime: 'codex', command: [target.runtimePath] },
        checkName: 'Nexus Lens review',
      },
    });

    const previousToken = process.env.JIRA_API_TOKEN;
    const previousPlan = process.env.FAKE_CODEX;
    process.env.JIRA_API_TOKEN = 'test-token';
    process.env.FAKE_CODEX = JSON.stringify({
      stateDir: target.state.dir,
      plans: [
        // The pre-delivery reviewer turn: one finding and nothing else.
        { finding: JSON.stringify(REPAIR_FINDING) },
        // The next claim's developer turn: it continues the ticket's own work
        // and does not repair the baseline it was told about, so the round that
        // judges it is still red.
        {
          edits: [{ file: 'WORK.md', text: 'the ticket work is next\n' }],
          commit: 'harn-38: start the ticket work',
          summary: 'the ticket work is next',
        },
      ],
    });
    const argv = ['source', 'run', '--repo', target.repo, '--config', target.configPath];
    try {
      // The first claim: the baseline is red, and the diagnosis returns the
      // ticket to To Do with one comment. No coding turn ran.
      const first = await runIn(target, site, argv);

      expect(first.err).toBe('');
      expect(first.code).toBe(EXIT_INPUT_ERROR);
      expect(site.status).toBe('To Do');
      expect(site.comments).toHaveLength(1);
      expect(site.labels).toContain(`harness-ws-${ISSUE_KEY}`);
      const diagnosisComment = JSON.stringify(site.comments[0]?.body);
      expect(diagnosisComment).toContain(`${BASELINE_MARKER_PREFIX}repair:`);
      expect(diagnosisComment).toContain('Repair guidance');
      const reviewerTurns = await fakeTurns(target.state);
      expect(reviewerTurns).toHaveLength(1);
      expect(reviewerTurns[0]?.prompt).toContain('You are Nexus Lens');
      expect(reviewerTurns[0]?.prompt).toContain('finding.json');

      // The next claim continues the same workspace and is told the finding:
      // the developer's own prompt carries the repair guidance.
      const second = await runIn(target, site, argv);

      const turns = await fakeTurns(target.state);
      expect(turns).toHaveLength(2);
      const developer = turns[1]?.prompt ?? '';
      expect(developer).toContain(`## Task ${ISSUE_KEY}`);
      // The finding is a requirement, not ordinary context: the prompt says the
      // baseline comes first, and carries the ordering line with its fields.
      expect(developer).toContain('## Repair the baseline before the task');
      expect(developer).toContain(
        'reviewed baseline finding — repair the baseline before continuing the original task',
      );
      expect(developer).toContain('may continue the original task only after it');
      expect(developer).toContain('## Guidance for this attempt');
      expect(developer).toContain('attempt 1');
      expect(developer).toContain('the baseline checks did not pass');
      // Every field of the reviewed finding, its own line: the developer is
      // told the check, the evidence, the cause, and the repair.
      expect(developer).toContain(
        `reviewed baseline finding — failing check: ${REPAIR_FINDING.failingCheck}`,
      );
      expect(developer).toContain(
        `reviewed baseline finding — evidence: ${REPAIR_FINDING.evidence}`,
      );
      expect(developer).toContain(
        `reviewed baseline finding — likely cause: ${REPAIR_FINDING.likelyCause}`,
      );
      expect(developer).toContain('reviewed baseline finding — repair guidance:');
      expect(developer).toContain(REPAIR_FINDING.repairGuidance);
      // The round that judged the turn is still red, so delivery is never
      // reached: the issue is told the failed attempt and waits In Review, and
      // the failed result carries no pull request.
      expect(site.status).toBe('In Review');
      expect(site.comments).toHaveLength(2);
      const resultComment = JSON.stringify(site.comments[1]?.body);
      expect(resultComment).toContain('finished: failed');
      expect(resultComment).not.toContain('Pull request:');
      expect(second.out).toContain('source completed');
      expect(second.out).toContain('1 failed');
      expect(second.out).not.toContain('source stopped');
      expect(second.code).toBe(EXIT_INPUT_ERROR);
      expect(existsSync(path.join(target.workDir, 'baseline'))).toBe(true);
    } finally {
      if (previousToken === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previousToken;
      }
      if (previousPlan === undefined) {
        delete process.env.FAKE_CODEX;
      } else {
        process.env.FAKE_CODEX = previousPlan;
      }
    }
  }, 60_000);
});
