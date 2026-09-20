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
import { takeOneItem } from '../src/sources/coordinator.js';
import { readReceipt, receiptFilePath } from '../src/sources/receipts.js';
import type { CheckRoundResult, CommandResult } from '../src/shared/types.js';
import type { SourceRef, Task } from '../src/shared/types.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';
import { writeWorkspaceState } from '../src/workspace/state.js';
import { createLocalTarget, fakeTurns, git } from './fixtures/local-target.js';
import type { LocalTarget } from './fixtures/local-target.js';
import { cleanupTempDirectories, createTempDir } from './support.js';
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
    listComments: async () => {
      if (record.threadFailure !== null) {
        throw new Error(record.threadFailure);
      }
      return record.notes;
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

  function reviewerFor(target: LocalTarget, plans: readonly unknown[]) {
    return createBaselineReviewer({
      selection: { runtime: 'codex', command: [target.runtimePath] },
      environment: {
        ...process.env,
        FAKE_CODEX: JSON.stringify({ stateDir: target.state.dir, plans }),
      },
    });
  }

  it('inspects a read-only snapshot of the workspace and validates the finding it wrote', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    await mkdir(dir, { recursive: true });
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const reviewer = reviewerFor(target, [{ finding: JSON.stringify(REPAIR_FINDING) }]);

    const result = await reviewer({
      dir,
      item: { ref: refFor(), task: taskFor(), pointers: [] },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    });

    expect(result.problem).toBeNull();
    expect(result.finding).toEqual(REPAIR_FINDING);
    // The turn really ran, in its own evidence directory, over a clone of the
    // workspace pinned at the snapshot — never over the retained workspace.
    const turns = await fakeTurns(target.state);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.cwd).toBe(dir);
    expect(turns[0]?.argv.at(-2)).toBe('--skip-git-repo-check');
    expect(existsSync(path.join(dir, 'repo', '.git'))).toBe(true);
    expect(git(path.join(dir, 'repo'), 'rev-parse', 'HEAD').trim()).toBe(base);

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
  });

  it('accepts an inconclusive finding and reports a turn that wrote none', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    await mkdir(dir, { recursive: true });
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const request = {
      dir,
      item: { ref: refFor(), task: taskFor(), pointers: [] },
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
    await mkdir(secondDir, { recursive: true });
    const missing = await reviewerFor(target, [{}])({ ...request, dir: secondDir });
    expect(missing.finding).toBeNull();
    expect(missing.problem).toContain('wrote no usable finding.json');
  });

  it('refuses a finding from a turn that changed the snapshot it was given', async () => {
    const target = await createLocalTarget({ brokenBaseline: true });
    const { dir, baseline } = await evidenceFor();
    await mkdir(dir, { recursive: true });
    const base = git(target.repo, 'rev-parse', 'HEAD').trim();
    const reviewer = reviewerFor(target, [
      {
        edits: [{ file: 'repo/NOTES.md', text: 'the reviewer wrote into the snapshot\n' }],
        finding: JSON.stringify(REPAIR_FINDING),
      },
    ]);

    const result = await reviewer({
      dir,
      item: { ref: refFor(), task: taskFor(), pointers: [] },
      workspace: { path: target.repo, baseCommit: base },
      baseline,
      stop: new AbortController().signal,
    });

    expect(result.finding).toBeNull();
    expect(result.problem).toContain('changed the snapshot');
    // The retained workspace is untouched: the turn never saw it.
    expect(git(target.repo, 'status', '--porcelain').trim()).toBe('');
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
  status: string;
}

function adfParagraphs(paragraphs: readonly string[]): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  };
}

/** A Jira site holding one issue in the running status, as the API answers. */
function fakeJira(status = 'In Progress'): FakeJira {
  const calls: FetchCall[] = [];
  const comments: FakeJira['comments'] = [];
  const targets: Record<string, Record<string, Record<string, unknown>>> = {
    '11': { to: { name: 'To Do' }, fields: {} },
    '12': { to: { name: 'In Review' }, fields: {} },
  };
  const state: { status: string } = { status };
  const issue = (): Record<string, unknown> => ({
    id: ISSUE_ID,
    key: ISSUE_KEY,
    fields: {
      summary: 'Repair the failing baseline and finish the ticket',
      description: adfParagraphs(['Do the thing.']),
      status: { name: state.status },
      labels: ['harness-task', `harness-ws-${ISSUE_KEY}`],
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

    if (url.includes('/comment')) {
      if (method === 'POST') {
        const id = String(comments.length + 1);
        const document = (body as { body?: unknown }).body;
        comments.push({
          id,
          created: `2026-09-21T10:0${id}:00.000Z`,
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
      const available =
        state.status === 'In Progress'
          ? [
              { id: '11', name: 'Ready for work', ...targets['11'] },
              { id: '12', name: 'Send to review', ...targets['12'] },
            ]
          : [{ id: '11', name: 'Ready for work', ...targets['11'] }];
      return answer({ transitions: available });
    }
    return answer(issue());
  };
  return {
    fetch: impl as unknown as typeof fetch,
    calls,
    comments,
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

describe('the next claim after a diagnosis', () => {
  it('hands the developer the reviewed finding in the same retained workspace', async () => {
    const workDir = await createTempDir();
    const sourceRepo = path.join(await createTempDir(), 'source-repo');
    await mkdir(sourceRepo, { recursive: true });
    await writeFile(path.join(sourceRepo, 'README.md'), 'the source repository\n', 'utf8');
    git(sourceRepo, 'init', '--quiet', '--initial-branch=main');
    git(sourceRepo, 'add', '--all');
    git(sourceRepo, 'commit', '--quiet', '--message', 'the baseline');
    const base = git(sourceRepo, 'rev-parse', 'HEAD').trim();

    // The retained workspace the red baseline was attempted in: the clone, its
    // recorded branch, and the ledger the diagnosis did not change.
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
      attempts: [
        {
          runId: 'run-1',
          outcome: 'failed',
          reason: 'the baseline checks did not pass, so no coding turn was started',
          endedAt: '2026-09-21T10:04:00.000Z',
          reportPath: '/work/runs/run-1/result.json',
        },
      ],
    });

    const ref = refFor();
    const item: SourceTask = { ref, task: taskFor(ref), pointers: [workspaceId] };
    const findingText =
      `${ISSUE_KEY}: the configured baseline checks failed before any coding turn, and the ` +
      `diagnosis is actionable (${BASELINE_MARKER_PREFIX}repair:abc123, written by the Nexus ` +
      'harness). Failing check: ["npm","run","validate"]. Evidence: the load test timed out. ' +
      'Likely cause: the fixture waits for a fixed 30 seconds. Repair guidance: make the fixture ' +
      'wait for the condition instead of the clock';
    const since: string[] = [];
    const runs: SourceRunRequest[] = [];
    const published: SourceRunOutcome[] = [];
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
          throw new Error('nothing in this test is refused');
        },
        commentsSince: async (_item, moment) => {
          since.push(moment);
          return [
            {
              author: 'Nexus Agent',
              createdAt: '2026-09-21T10:05:00.000Z',
              text: findingText,
            },
          ];
        },
      },
      workDir,
      lockNamespace: 'baseline-guidance-fixture',
      tiers: [{ name: 'default', agent: { runtime: 'codex', command: ['codex'] }, maxRepairs: 1 }],
      repoPath: sourceRepo,
      io: { out: () => undefined, err: () => undefined },
      stop: new AbortController().signal,
      preflight: async () => ({ sourceRoot: sourceRepo, baseCommit: base }),
      run: async (request) => {
        runs.push(request);
        return runResultFor({
          status: 'passed',
          reason: 'the checks passed',
          baseline: null,
          workspace: workspaceFor({ continued: true, attempt: 2, baseCommit: base }),
          reportPath: '/work/runs/run-2/result.json',
        });
      },
      now: () => new Date('2026-09-21T10:06:00.000Z'),
      sleep: async () => undefined,
    };

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
          line.includes('comment by Nexus Agent') &&
          line.includes('Repair guidance') &&
          line.includes('make the fixture wait for the condition instead of the clock'),
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
