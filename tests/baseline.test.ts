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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { createBaselineReviewer, parseBaselineFinding } from '../src/reviews/baseline.js';
import type {
  BaselineDiagnosis,
  BaselineDiagnosisOutcome,
  BaselineDiagnosisRequest,
  BaselineFinding,
  BaselineRecord,
  BaselineReview,
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
  baselineEvidenceId,
  createBaselineDiagnosis,
} from '../src/sources/baseline.js';
import { guidanceFrom } from '../src/sources/guidance.js';
import { takeOneItem } from '../src/sources/coordinator.js';
import { readReceipt, receiptFilePath } from '../src/sources/receipts.js';
import type { CheckRoundResult, CommandResult } from '../src/shared/types.js';
import type { SourceRef, Task } from '../src/shared/types.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { recordWorkspaceAttempt, writeWorkspaceState } from '../src/workspace/state.js';
import type { WorkspaceAttempt } from '../src/workspace/state.js';
import { createLocalTarget, fakeTurns, git } from './fixtures/local-target.js';
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
    listComments: async () => {
      if (record.threadFailure !== null) {
        throw new Error(record.threadFailure);
      }
      return record.notes;
    },
    isRunning: async () => {
      if (record.runningFailure !== null) {
        throw new Error(record.runningFailure);
      }
      return record.status === 'In Progress';
    },
    postComment: async (_id, paragraphs) => {
      if (record.commentFailure !== null) {
        throw new Error(record.commentFailure);
      }
      record.posted.push([...paragraphs]);
      const id = `c${String(record.notes.length + 1)}`;
      record.notes.push({ id, createdAt: '2026-09-21T10:05:00.000Z', text: paragraphs.join('\n') });
      return id;
    },
    moveFromRunning: async (_id, target) => {
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

/** A reviewer that answers with one finding, and records what it was asked. */
function scriptedReviewer(
  answer: BaselineFinding | null,
  problem: string | null = null,
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
      };
    },
  };
}

function phaseFor(parts: {
  readonly record: FakeRecord;
  readonly reviewer: ScriptedReviewer;
  readonly workDir: string;
  readonly readyStatus?: string;
  readonly reviewStatus?: string;
}): { readonly diagnosis: ReturnType<typeof createBaselineDiagnosis>; readonly out: string[] } {
  const out: string[] = [];
  return {
    out,
    diagnosis: createBaselineDiagnosis({
      reviewer: parts.reviewer.review,
      record: parts.record,
      readyStatus: parts.readyStatus ?? 'To Do',
      reviewStatus: parts.reviewStatus ?? 'In Review',
      reviewerTimeoutMs: 60_000,
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
        dir: path.join(workDir, 'baseline', baselineEvidenceId(refFor(), BASE, request.baseline)),
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

  it('does not repeat a comment or a reviewer turn for unchanged evidence', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord();
    const request = requestFor();
    const evidenceId = baselineEvidenceId(refFor(), BASE, request.baseline);
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
  });

  it('does not move an item a person already took out of the running status', async () => {
    const workDir = await createTempDir();
    const record = fakeRecord('To Do');
    const request = requestFor();
    const evidenceId = baselineEvidenceId(refFor(), BASE, request.baseline);
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
      };
    };
    const diagnosis = createBaselineDiagnosis({
      reviewer,
      record,
      readyStatus: 'To Do',
      reviewStatus: 'In Review',
      reviewerTimeoutMs: 20,
      workDir,
      io: { out: () => undefined, err: () => undefined },
    });

    const outcome = await diagnosis.diagnose(requestFor());

    expect(bounded).toBe(true);
    expect(outcome.kind).toBe('attention');
    expect(record.status).toBe('In Review');
  });
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

describe('the guidance one continued attempt is given', () => {
  /** One realistic diagnosis comment: the fields near the width a finding may have. */
  function commentFor(): string {
    const evidenceId = baselineEvidenceId(refFor(), BASE, redBaseline());
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

  it('carries every field of a realistically sized finding whole', () => {
    const comment = commentFor();

    const guidance = guidanceFrom(
      [],
      [{ author: 'Nexus Agent', createdAt: '2026-09-21T10:05:00.000Z', text: comment }],
    );

    const joined = guidance.join('\n');
    // Each field is its own line, at the width the comment itself wrote, so the
    // collapsed-comment truncation cannot eat the cause and the repair.
    for (const field of ['failing check', 'evidence', 'likely cause', 'repair guidance']) {
      const line = guidance.find((entry) =>
        entry.startsWith(`reviewed baseline finding — ${field}: `),
      );
      expect(line, `guidance carries the ${field}`).toBeDefined();
      const written = comment
        .split('\n')
        .find((entry) => entry.startsWith(`${field.charAt(0).toUpperCase()}${field.slice(1)}: `));
      expect(line?.slice(`reviewed baseline finding — ${field}: `.length)).toBe(
        written?.slice(field.length + 2),
      );
    }
    expect(joined).not.toContain('…');
  });

  it('keeps the finding even when the thread holds more recent chatter', () => {
    const comment = commentFor();
    const chatter = Array.from({ length: 12 }, (_entry, index) => ({
      author: 'Someone',
      createdAt: `2026-09-21T11:${String(index).padStart(2, '0')}:00.000Z`,
      text: `a note about something else, number ${String(index + 1)}`,
    }));

    const guidance = guidanceFrom(
      [],
      [{ author: 'Nexus Agent', createdAt: '2026-09-21T10:05:00.000Z', text: comment }, ...chatter],
    );

    expect(
      guidance.some((line) => line.includes('reviewed baseline finding — repair guidance: ')),
    ).toBe(true);
    expect(guidance.length).toBeLessThanOrEqual(12);
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

  it('publishes the finding an interrupted turn already wrote, without a second turn', async () => {
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
      baseline: redBaseline(),
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

// ---------------------------------------------------------------------------
// The coordinator: which ending enters the diagnosis, and what it publishes
// ---------------------------------------------------------------------------

interface CoordinatorCalls {
  readonly complete: SourceRunOutcome[];
  readonly progress: SourceRunOutcome[];
  readonly diagnosed: BaselineDiagnosisRequest[];
  readonly delivered: string[];
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
}): Promise<{
  readonly take: SourceTake;
  readonly calls: CoordinatorCalls;
  readonly workDir: string;
}> {
  const workDir = await createTempDir();
  const ref = refFor();
  const item: SourceTask = { ref, task: taskFor(ref), pointers: [] };
  const calls: CoordinatorCalls = { complete: [], progress: [], diagnosed: [], delivered: [] };
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
    commentsSince: async () => [],
  };
  const context: SourceContext = {
    source,
    workDir,
    lockNamespace: 'baseline-fixture',
    tiers: [{ name: 'default', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 }],
    repoPath: '/repo',
    io: { out: () => undefined, err: () => undefined },
    stop: new AbortController().signal,
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
): BaselineDiagnosis {
  return {
    diagnose: async (request) => {
      calls.push(request);
      return outcome;
    },
    resume: async () => null,
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
    const { take, calls } = await takeOne({
      result: runResultFor(),
      diagnosis: diagnosisFor(
        {
          kind: 'attention',
          detail: 'no repair is actionable; the item is In Review (comment c1)',
          commentId: 'c1',
        },
        [],
      ),
    });

    expect(take.outcome).toBe('attention');
    expect(take.ticket?.ref.key).toBe(ISSUE_KEY);
    expect(take.problem).toContain('no baseline repair is actionable');
    expect(calls.complete).toEqual([]);
    expect(calls.delivered).toEqual([]);
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
  readonly findingText: string;
  readonly run: (request: SourceRunRequest) => Promise<RunTaskResult>;
  readonly tiers?: SourceContext['tiers'];
  readonly diagnosis?: BaselineDiagnosis;
}): ContinuedIntake {
  const ref = refFor();
  const item: SourceTask = { ref, task: taskFor(ref), pointers: [parts.workspaceId] };
  const runs: SourceRunRequest[] = [];
  const since: string[] = [];
  const published: SourceRunOutcome[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const context: SourceContext = {
    source: {
      listEligible: async () => [{ ref, title: 'Repair the failing baseline' }],
      prepare: async () => item,
      claim: async () => true,
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
        return [
          {
            author: 'Nexus Agent',
            createdAt: '2026-09-21T10:05:00.000Z',
            text: parts.findingText,
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
    stop: new AbortController().signal,
    preflight: async () => ({ sourceRoot: parts.sourceRepo, baseCommit: parts.base }),
    run: async (request) => {
      runs.push(request);
      return await parts.run(request);
    },
    now: () => new Date('2026-09-21T10:06:00.000Z'),
    sleep: async () => undefined,
    ...(parts.diagnosis === undefined ? {} : { baselineDiagnosis: parts.diagnosis }),
  };
  return { context, runs, since, published, out, err };
}

describe('the next claim after a diagnosis', () => {
  it('hands the developer the reviewed finding in the same retained workspace', async () => {
    const workDir = await createTempDir();
    const { sourceRepo, workspaceId, workspacePath, base } = await retainedWorkspace(workDir, [
      baselineAttempt(),
    ]);

    const { context, runs, since, published } = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      findingText: findingTextFor(),
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

  it('keeps the reviewed finding in the brief of a later rung of the same climb', async () => {
    const workDir = await createTempDir();
    const { sourceRepo, workspaceId, base } = await retainedWorkspace(workDir, [baselineAttempt()]);
    let ran = 0;
    const { context, runs, since } = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      findingText: findingTextFor(),
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
      findingText: findingTextFor(),
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
    record.commentFailure = null;

    const restartReviewer = scriptedReviewer(REPAIR_FINDING);
    const restart = phaseFor({ record, reviewer: restartReviewer, workDir });
    const { context, runs } = continuedIntake({
      workDir,
      sourceRepo,
      base,
      workspaceId,
      findingText: findingTextFor(),
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
