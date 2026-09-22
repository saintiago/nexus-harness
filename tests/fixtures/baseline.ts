/**
 * The diagnosis fixtures both baseline suites share: the fake Jira records, the
 * scripted reviewer, the request one diagnosis is asked with, the coordinator
 * calls and retained-workspace helpers a test reads back, and the finding and
 * comment builders. Nothing here needs a live Jira site or a provider.
 */
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

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import path from 'node:path';

import type { Delivery } from '../../src/delivery/github.js';

import { summarizeChanges } from '../../src/reporting/changes.js';
import type { RunTaskResult } from '../../src/runs/contracts.js';
import type { TicketHistory } from '../../src/history/contract.js';
import { baselineFindingPath } from '../../src/reviews/baseline.js';
import { createBaselineReviewer } from './boundary-operations.js';
import { ownFixtureOperation } from './lifecycle.js';
import type {
  BaselineDiagnosis,
  BaselineDiagnosisOutcome,
  BaselineDiagnosisRequest,
  BaselineFinding,
  BaselineRecord,
  BaselineReview,
  BaselineReviewResult,
  BaselineReviewedFinding,
  SourceContext,
  SourceNote,
  SourceRunOutcome,
  SourceRunRequest,
  SourceTake,
  SourceTask,
  TaskSource,
} from '../../src/sources/contract.js';
import { BASELINE_MARKER_PREFIX } from '../../src/sources/baseline.js';
import { createBaselineDiagnosis } from './operations.js';

import { takeOneItem } from './operations.js';

import type { CheckRoundResult, CommandResult } from '../../src/shared/types.js';
import type { SourceRef, Task } from '../../src/shared/types.js';
import type { PreparedWorkspace } from '../../src/workspace/prepare.js';
import { writeWorkspaceState } from '../../src/workspace/state.js';
import type { WorkspaceAttempt } from '../../src/workspace/state.js';
import { fakeTurns, git } from './local-target.js';
import type { LocalTarget } from './local-target.js';
import { createTempDir, publishedComment, writeJsonFile } from '../support.js';

export const SCOPE = 'https://example.atlassian.net';
export const ISSUE_ID = '10011';
export const ISSUE_KEY = 'HARN-38';
export const BASE = 'a'.repeat(40);
/**
 * The connected project every fixture here diagnoses under. It stands where
 * production puts the composed connection identity's own namespace
 * (`projectLockNamespace`), and it is what scopes one project's evidence
 * directories away from another's under one shared `workDir`.
 */
export const PROJECT = 'baseline-project';

export function refFor(id = ISSUE_ID, key = ISSUE_KEY): SourceRef {
  return {
    type: 'jira',
    scope: SCOPE,
    id,
    key,
    url: `${SCOPE}/browse/${key}`,
    updatedAt: '2026-09-21T10:00:00.000Z',
  };
}

export function taskFor(ref = refFor()): Task {
  return {
    id: ref.key,
    title: 'Repair the failing baseline and finish the ticket',
    description: 'The ticket the baseline failed under.',
    acceptanceCriteria: ['The configured checks pass.', 'The ticket work is done.'],
  };
}

export function commandFor(
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
export function redBaseline(overrides: Partial<CheckRoundResult> = {}): CheckRoundResult {
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
export async function baselineWithLogs(): Promise<CheckRoundResult> {
  return ownFixtureOperation('baselineWithLogs setup', async () => {
    const dir = await createTempDir();
    const stdoutPath = path.join(dir, 'baseline-check-1.stdout.log');
    const stderrPath = path.join(dir, 'baseline-check-1.stderr.log');
    await writeFile(stdoutPath, 'running test/load.test.mjs\nFAILED test/load.test.mjs\n', 'utf8');
    await writeFile(stderrPath, 'the load test timed out after 30s\n', 'utf8');
    return redBaseline({
      checks: [commandFor({ command: ['npm', 'run', 'validate'], stdoutPath, stderrPath })],
    });
  });
}

// ---------------------------------------------------------------------------
// The phase, against an in-memory thread and a scripted reviewer
// ---------------------------------------------------------------------------

export interface FakeRecord extends BaselineRecord {
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
export function stoppedByCaller(): Error {
  return new Error('the request was stopped by the caller before it answered');
}

export function fakeRecord(status = 'In Progress'): FakeRecord {
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

export interface ScriptedReviewer {
  readonly review: BaselineReview;
  readonly requests: { readonly dir: string; readonly base: string }[];
}

/**
 * A reviewer that answers with one finding, and records what it was asked. A
 * stop it could not confirm is passed through the way the real reviewer turn
 * reports one.
 */
export function scriptedReviewer(
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
export function interruptibleReviewer(shutdown: BaselineReviewResult['shutdown']): {
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

export function phaseFor(parts: {
  readonly record: FakeRecord;
  /** A scripted answer, or a reviewer function a test drives itself. */
  readonly reviewer: ScriptedReviewer | BaselineReview;
  readonly workDir: string;
  readonly readyStatus?: string;
  readonly reviewStatus?: string;
  readonly project?: string;
  /** The conversation history the diagnostic reviewer turn is given. */
  readonly history?: TicketHistory;
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
      ...(parts.history === undefined ? {} : { history: parts.history }),
    }),
  };
}

/** The real pre-delivery reviewer turn over the stand-in runtime. */
export function reviewerFor(target: LocalTarget, plans: readonly unknown[]): BaselineReview {
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
export async function waitForTurnRecorded(state: LocalTarget['state']): Promise<void> {
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

export function requestFor(baseline: CheckRoundResult = redBaseline()): {
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

/** The actionable arm of the finding union, as a fixture builds it. */
export type RepairFinding = Extract<BaselineFinding, { outcome: 'repair' }>;

export const REPAIR_FINDING: RepairFinding = {
  outcome: 'repair',
  failingCheck: '["npm","run","validate"]',
  evidence: 'the load test timed out on the shared machine',
  likelyCause: 'the fixture waits for a fixed 30 seconds',
  repairGuidance: 'make the fixture wait for the condition instead of the clock',
};

/**
 * Repair guidance longer than one Jira comment line and well inside the 2,000
 * characters a reviewer's field may have, whose last words are the concrete
 * instruction: a handoff that keeps only the bounded rendering a comment holds
 * loses exactly what the developer has to do.
 */
export const WIDE_GUIDANCE_TAIL =
  'and then give the load test a per-test timeout that reflects a loaded machine';
export const WIDE_REPAIR_GUIDANCE =
  'make the load test wait for the condition instead of the clock. '.repeat(12) +
  WIDE_GUIDANCE_TAIL;

/** The same finding, with guidance no single comment line can hold whole. */
export const WIDE_REPAIR_FINDING: RepairFinding = {
  ...REPAIR_FINDING,
  repairGuidance: WIDE_REPAIR_GUIDANCE,
};

/**
 * A valid actionable finding whose own fields run past the whole 4,000
 * characters the context beside it is bounded to — every field still inside the
 * 2,000 its turn was validated at. The finding is what the attempt must repair
 * first; the newest line the ticket carries since is the current repair
 * feedback, and the two have budgets of their own, so neither may spend the
 * other's (docs/WORKFLOW.md §11).
 */
export const WIDE_TOTAL_FINDING: RepairFinding = {
  ...REPAIR_FINDING,
  evidence: 'the load test spawned two hundred workers and timed out. '.repeat(40).slice(0, 1_900),
  likelyCause: 'the fixture waits for a fixed thirty seconds. '.repeat(40).slice(0, 1_900),
  repairGuidance: 'wait for the condition instead of the clock. '.repeat(40).slice(0, 1_900),
};

export const INCONCLUSIVE_FINDING: BaselineFinding = {
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
export async function writeTurnFinding(
  workDir: string,
  evidenceId: string,
  finding: BaselineFinding = REPAIR_FINDING,
  project: string = PROJECT,
): Promise<void> {
  return ownFixtureOperation('writeTurnFinding setup', async () => {
    await writeJsonFile(path.join(workDir, 'baseline', project, evidenceId), 'outcome.json', {
      version: 1,
      state: 'finding',
      finding,
    });
  });
}

// ---------------------------------------------------------------------------
// The coordinator: which ending enters the diagnosis, and what it publishes
// ---------------------------------------------------------------------------

export interface CoordinatorCalls {
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
export async function takeOne(parts: {
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
      return publishedComment();
    },
    complete: async (_item, outcome) => {
      calls.complete.push(outcome);
      return publishedComment();
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
export function workspaceFor(overrides: Partial<PreparedWorkspace> = {}): PreparedWorkspace {
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

export function runResultFor(overrides: Partial<RunTaskResult> = {}): RunTaskResult {
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

export function diagnosisFor(
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

/**
 * One retained workspace a red baseline was attempted in: the source repository,
 * the clone on the branch its ledger records, and the attempt history a next
 * claim reads. None of this belongs to the diagnosis: it is what the failed
 * baseline run itself left behind.
 */
export async function retainedWorkspace(
  workDir: string,
  attempts: readonly WorkspaceAttempt[],
): Promise<{
  readonly sourceRepo: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly base: string;
}> {
  return ownFixtureOperation('retained baseline workspace setup', async () => {
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
  });
}

/** The one failed baseline attempt a retained workspace starts from. */
export function baselineAttempt(): WorkspaceAttempt {
  return {
    runId: 'run-1',
    outcome: 'failed',
    reason: 'the baseline checks did not pass, so no coding turn was started',
    endedAt: '2026-09-21T10:04:00.000Z',
    reportPath: '/work/runs/run-1/result.json',
  };
}

/** One diagnosis comment, as the item's own thread renders it back. */
export function findingTextFor(evidenceId = 'abc123'): string {
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
export interface ContinuedIntake {
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
export function continuedIntake(parts: {
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
   * What the thread carries after the one comment this fixture renders for
   * `findingText`: someone writing on the ticket later — the review feedback a
   * repair turn has to be told beside the finding it repairs first.
   */
  readonly laterComments?: readonly {
    readonly author: string;
    readonly createdAt: string;
    readonly text: string;
  }[];
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
        return publishedComment();
      },
      complete: async (_item, outcome) => {
        published.push(outcome);
        return publishedComment();
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
          ...(parts.laterComments ?? []),
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

export async function evidenceRecordFor(
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
export async function writeReviewerFinding(
  workDir: string,
  finding: BaselineFinding = REPAIR_FINDING,
  project: string = PROJECT,
): Promise<void> {
  return ownFixtureOperation('writeReviewerFinding setup', async () => {
    const evidence = await evidenceRecordFor(workDir, project);
    const dir = path.dirname(evidence.file);
    const file = baselineFindingPath(dir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(finding)}\n`, 'utf8');
    await writeJsonFile(dir, 'outcome.json', { version: 1, state: 'finding', finding });
  });
}

/** The Jira side of the diagnosis fixtures: one fake site that speaks REST API v3. */
export const CLOUD_ID = '9337c4da-7d33-4c1d-b03c-db207e537f88';
export const TOKEN = 'service-account-token-value';

export const SOURCE_CONFIG = {
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

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

export interface FakeJira {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
  readonly comments: { id: string; created: string; author: string; body: unknown }[];
  readonly labels: string[];
  status: string;
}

/** A description in the supported convention: a goal and its acceptance criteria. */
export function adfTaskDescription(): Record<string, unknown> {
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
export function fakeJira(status = 'In Progress'): FakeJira {
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
