/**
 * The pre-delivery baseline diagnosis's own decisions, over its two stand-in
 * collaborators — the one reviewer turn and the item's thread — and the real
 * evidence files it keeps under a temporary output directory.
 *
 * What is asserted is what the diagnosis decides from what it is handed: a
 * finding a reviewer turn's own ending rejected is never published or handed to
 * a developer, a recorded finding already on the thread is finished by making
 * the missing status move and never by a second turn, and one connected
 * project's pending evidence is never read, finished, commented on, or closed
 * through another project sharing the same output directory (docs/WORKFLOW.md
 * §11). No runtime, repository or Jira connection is started here; the reviewer
 * turn's real launch and its record stay the boundary layer's.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckRoundResult, CommandResult, SourceRef, Task } from '../../src/shared/types.js';
import type {
  BaselineDiagnosis,
  BaselineDiagnosisRequest,
  BaselineFinding,
  BaselineRecord,
  BaselineReview,
  SourceNote,
} from '../../src/sources/contract.js';
import {
  BASELINE_EVIDENCE_FILE,
  BASELINE_MARKER_PREFIX,
  baselineEvidenceId,
  createBaselineDiagnosis,
} from '../../src/sources/baseline.js';
import { createTempDir } from '../support.js';

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
const WORKSPACE = {
  workspaceId: 'HARN-11',
  workspacePath: '/work/workspaces/HARN-11',
  branch: 'harness/HARN-11',
  baseCommit: BASE,
};
const PROJECT = 'connected-project';
const FOREIGN = 'another-connected-project';
const READY = 'To Do';
const REVIEW = 'In Review';
const FAILED_TURN = 'the baseline reviewer turn for HARN-11 did not complete: the turn failed';

/** The one command result a completed red baseline holds. */
function failedCheck(): CommandResult {
  return {
    command: ['npm', 'run', 'check'],
    cwd: '/work/workspaces/HARN-11',
    startedAt: '2026-09-23T10:00:00.000Z',
    endedAt: '2026-09-23T10:00:05.000Z',
    outcome: 'exited',
    exitCode: 1,
    signal: null,
    launchError: null,
    timeoutMs: 600_000,
    termination: null,
    terminationProblem: null,
    stdoutPath: '/work/runs/run-1/logs/check.stdout.log',
    stderrPath: '/work/runs/run-1/logs/check.stderr.log',
  };
}

const BASELINE: CheckRoundResult = {
  outcome: 'failed',
  setup: [],
  checks: [failedCheck()],
  problem: null,
};

const REPAIR_FINDING: BaselineFinding = {
  outcome: 'repair',
  failingCheck: '["npm", "run", "check"]',
  evidence: 'the check exits 1 because the fixture file is missing',
  likelyCause: 'the fixture file was never added',
  repairGuidance: 'add the fixture file the check reads',
};

function request(baseline: CheckRoundResult = BASELINE): BaselineDiagnosisRequest {
  return {
    item: { ref: REF, task: TASK },
    workspace: WORKSPACE,
    baseline,
    stop: new AbortController().signal,
  };
}

/** Where one piece of evidence lives under a project's own evidence root. */
function evidenceDirectory(workDir: string, project: string, evidenceId: string): string {
  return path.join(workDir, 'baseline', project, evidenceId);
}

/**
 * Records one diagnosis the way an invocation that stopped after its reviewer
 * turn wrote its record — the state a restart resumes from — and returns the
 * evidence directory.
 */
async function retainedEvidence(parts: {
  readonly workDir: string;
  readonly project?: string;
  readonly closed?: 'repair' | 'attention' | 'left-alone';
}): Promise<{ readonly dir: string; readonly evidenceId: string }> {
  const project = parts.project ?? PROJECT;
  const evidenceId = baselineEvidenceId(REF, BASE, BASELINE);
  const dir = evidenceDirectory(parts.workDir, project, evidenceId);
  const record = {
    version: 1,
    evidenceId,
    project,
    ref: REF,
    task: TASK,
    workspace: WORKSPACE,
    baseline: BASELINE,
    ...(parts.closed === undefined
      ? {}
      : { closed: parts.closed, closedAt: '2026-09-23T10:01:00.000Z' }),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, BASELINE_EVIDENCE_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
  return { dir, evidenceId };
}

/** What one evidence's reviewer turn really produced, as the harness records it. */
async function recordOutcome(
  dir: string,
  outcome:
    | { readonly state: 'finding'; readonly finding: BaselineFinding }
    | { readonly state: 'rejected'; readonly problem: string },
): Promise<void> {
  await writeFile(
    path.join(dir, 'outcome.json'),
    `${JSON.stringify({ version: 1, shutdown: null, ...outcome }, null, 2)}\n`,
    'utf8',
  );
}

/** The finding file an interrupted turn left behind, looking exactly like a completed turn's. */
async function leftoverFinding(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'turn'), { recursive: true });
  await writeFile(
    path.join(dir, 'turn', 'finding.json'),
    `${JSON.stringify(REPAIR_FINDING, null, 2)}\n`,
    'utf8',
  );
}

/** The one comment a diagnosis that already published would have posted. */
function diagnosisComment(evidenceId: string, kind: 'repair' | 'attention'): SourceNote {
  return {
    id: 'c1',
    createdAt: '2026-09-23T10:01:00.000Z',
    text: `${REF.key}: the diagnosis (${BASELINE_MARKER_PREFIX}${kind}:${evidenceId}, written by the Nexus harness)`,
  };
}

/** One item's own thread and status, as a diagnosis reads and writes them. */
function recordHarness(notes: readonly SourceNote[], running = true) {
  const thread = [...notes];
  const posted: string[][] = [];
  const moves: string[] = [];
  const reads: string[] = [];
  let inRunning = running;
  const record: BaselineRecord = {
    listComments: async (id) => {
      reads.push(id);
      return thread;
    },
    postComment: async (_id, paragraphs) => {
      const id = `c${String(thread.length + 1)}`;
      thread.push({ id, createdAt: '2026-09-23T10:02:00.000Z', text: paragraphs.join('\n') });
      posted.push([...paragraphs]);
      return id;
    },
    isRunning: async (id) => {
      reads.push(id);
      return inRunning;
    },
    moveFromRunning: async (_id, target) => {
      if (!inRunning) {
        return 'left-alone';
      }
      inRunning = false;
      moves.push(target);
      return 'moved';
    },
  };
  return { record, posted, moves, reads };
}

/** One diagnosis over a temporary output directory, with a rejected-search-immune turn. */
function diagnosisFor(parts: {
  readonly workDir: string;
  readonly reviewer: BaselineReview;
  readonly record: BaselineRecord;
  readonly project?: string;
}): BaselineDiagnosis {
  return createBaselineDiagnosis({
    reviewer: parts.reviewer,
    record: parts.record,
    readyStatus: READY,
    reviewStatus: REVIEW,
    reviewerTimeoutMs: 60_000,
    project: parts.project ?? PROJECT,
    workDir: parts.workDir,
    io: { out: () => undefined, err: () => undefined },
  });
}

/** A reviewer turn that must never be reached: any call is a failure. */
const noSecondTurn: BaselineReview = async () => {
  throw new Error('a second reviewer turn was started for the same evidence');
};

describe('what a restart does with the evidence one reviewer turn left', () => {
  it('never publishes the finding file of a turn its own record rejected', async () => {
    const workDir = await createTempDir();
    const { dir, evidenceId } = await retainedEvidence({ workDir });
    await leftoverFinding(dir);
    await recordOutcome(dir, { state: 'rejected', problem: FAILED_TURN });
    // The comment the marker is on claims a repair; the recorded outcome, not
    // the marker, is what a restart may act on.
    const thread = recordHarness([diagnosisComment(evidenceId, 'repair')]);
    const diagnosis = diagnosisFor({ workDir, reviewer: noSecondTurn, record: thread.record });

    const outcome = await diagnosis.diagnose(request());

    expect(outcome.kind).toBe('attention');
    expect(thread.moves).toEqual([REVIEW]);
    expect(thread.posted).toEqual([]);
    // The recorded rejection is what the next claim would read back, and it
    // requires nothing: no developer starts from the finding file the turn
    // wrote before it failed.
    expect(
      await diagnosis.reviewedFinding(WORKSPACE.workspaceId, new AbortController().signal),
    ).toMatchObject({ kind: 'none' });
    const evidence = JSON.parse(
      await readFile(path.join(dir, BASELINE_EVIDENCE_FILE), 'utf8'),
    ) as Record<string, unknown>;
    expect(evidence['closed']).toBe('attention');
  });

  it('finishes a recorded finding already on the thread by making only the missing move', async () => {
    const workDir = await createTempDir();
    const { dir, evidenceId } = await retainedEvidence({ workDir });
    await recordOutcome(dir, { state: 'finding', finding: REPAIR_FINDING });
    const thread = recordHarness([diagnosisComment(evidenceId, 'repair')]);
    const diagnosis = diagnosisFor({ workDir, reviewer: noSecondTurn, record: thread.record });

    const outcome = await diagnosis.diagnose(request());

    expect(outcome.kind).toBe('repair');
    expect(thread.posted).toEqual([]);
    expect(thread.moves).toEqual([READY]);
    // The finding the record holds is what a later claim of that workspace is
    // required to repair before anything else.
    expect(
      await diagnosis.reviewedFinding(WORKSPACE.workspaceId, new AbortController().signal),
    ).toEqual({ kind: 'finding', finding: REPAIR_FINDING, evidenceId });
    const evidence = JSON.parse(
      await readFile(path.join(dir, BASELINE_EVIDENCE_FILE), 'utf8'),
    ) as Record<string, unknown>;
    expect(evidence['closed']).toBe('repair');
  });

  it('refuses to hand a workspace a repair its own evidence never accepted', async () => {
    const workDir = await createTempDir();
    const { dir } = await retainedEvidence({ workDir, closed: 'repair' });
    await leftoverFinding(dir);
    await recordOutcome(dir, { state: 'rejected', problem: FAILED_TURN });
    const diagnosis = diagnosisFor({
      workDir,
      reviewer: noSecondTurn,
      record: recordHarness([]).record,
    });

    const recovered = await diagnosis.reviewedFinding(
      WORKSPACE.workspaceId,
      new AbortController().signal,
    );

    // The evidence says the workspace was returned for repair, and what the
    // turn itself recorded is a rejection: the finding file beside it is never
    // read as the actionable finding, so no developer may start from it.
    expect(recovered.kind).toBe('unreadable');
    if (recovered.kind === 'unreadable') {
      expect(recovered.detail).toContain('cannot be read back');
      expect(recovered.detail).not.toContain(REPAIR_FINDING.repairGuidance);
    }
  });
});

describe('the connected project a pending diagnosis belongs to', () => {
  it("never resumes, comments on, moves, or closes another project's pending evidence", async () => {
    const workDir = await createTempDir();
    const { dir: foreignDir, evidenceId } = await retainedEvidence({ workDir, project: PROJECT });
    const other = recordHarness([]);
    const otherDiagnosis = diagnosisFor({
      workDir,
      project: FOREIGN,
      reviewer: noSecondTurn,
      record: other.record,
    });

    const resumed = await otherDiagnosis.resume(new AbortController().signal);

    // The pending evidence belongs to the project that wrote it, and another
    // project sharing this output directory reads none of it: it asks nothing
    // of its own connection and writes nothing.
    expect(resumed).toBeNull();
    expect(other.reads).toEqual([]);
    expect(other.posted).toEqual([]);
    expect(other.moves).toEqual([]);
    const kept = JSON.parse(
      await readFile(path.join(foreignDir, BASELINE_EVIDENCE_FILE), 'utf8'),
    ) as Record<string, unknown>;
    expect(kept['project']).toBe(PROJECT);
    expect(kept['closed']).toBeUndefined();
    expect(evidenceId).toBe(baselineEvidenceId(REF, BASE, BASELINE));

    // Its own invocation then finishes exactly what it recorded: one comment
    // carrying the finding, and the item back in the status work is claimed from.
    const own = recordHarness([]);
    const ownDiagnosis = diagnosisFor({
      workDir,
      reviewer: async (asked) => ({
        summary: null,
        finding: REPAIR_FINDING,
        problem: null,
        logPath: path.join(asked.dir, 'reviewer.log'),
        shutdown: null,
      }),
      record: own.record,
    });

    const finished = await ownDiagnosis.resume(new AbortController().signal);

    expect(finished?.kind).toBe('repair');
    expect(own.posted).toHaveLength(1);
    expect(own.moves).toEqual([READY]);
    expect(
      (
        JSON.parse(await readFile(path.join(foreignDir, BASELINE_EVIDENCE_FILE), 'utf8')) as Record<
          string,
          unknown
        >
      )['closed'],
    ).toBe('repair');
  });

  it('refuses evidence another project wrote instead of acting on it through this one', async () => {
    const workDir = await createTempDir();
    const { dir: ownDir, evidenceId } = await retainedEvidence({ workDir, project: PROJECT });
    // The record is copied — or the directory moved by hand — into the wrong
    // project's evidence root. Its own `project` field still names the one that
    // wrote it, and that is refused by name before any comment or move.
    const foreignDir = evidenceDirectory(workDir, FOREIGN, evidenceId);
    await mkdir(foreignDir, { recursive: true });
    await writeFile(
      path.join(foreignDir, BASELINE_EVIDENCE_FILE),
      await readFile(path.join(ownDir, BASELINE_EVIDENCE_FILE), 'utf8'),
      'utf8',
    );
    const other = recordHarness([]);
    const otherDiagnosis = diagnosisFor({
      workDir,
      project: FOREIGN,
      reviewer: noSecondTurn,
      record: other.record,
    });

    const resumed = await otherDiagnosis.resume(new AbortController().signal);

    expect(resumed?.kind).toBe('problem');
    expect(resumed?.detail).toContain('another connected project');
    expect(other.posted).toEqual([]);
    expect(other.moves).toEqual([]);
    // The evidence it does not belong to is neither closed nor re-read through
    // the project that was handed the wrong path.
    expect(
      (
        JSON.parse(await readFile(path.join(ownDir, BASELINE_EVIDENCE_FILE), 'utf8')) as Record<
          string,
          unknown
        >
      )['closed'],
    ).toBeUndefined();
    expect((await readdir(path.join(workDir, 'baseline', PROJECT))).length).toBeGreaterThan(0);
  });
});
