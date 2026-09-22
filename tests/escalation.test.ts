/**
 * The escalation and baseline-repair decisions, as ordinary functions: what a
 * finished run's own evidence says about climbing the ladder or entering the
 * pre-delivery diagnosis, how one finding file and the comment that renders it
 * are read back, and what a later attempt is told to repair first.
 *
 * Nothing here starts a reviewer turn, a repository, or a command: the reviewer
 * turn and its workspace evidence stay the boundary and workflow layers'
 * (docs/testing.md).
 */
import { describe, expect, it } from 'vitest';
import type { RunTaskResult } from '../src/runs/contracts.js';
import type { BaselineFinding } from '../src/sources/contract.js';
import {
  BASELINE_MARKER_PREFIX,
  baselineCommentFinding,
  baselineEvidenceId,
  baselineFindingGuidanceLines,
  baselineThreadFinding,
} from '../src/sources/baseline.js';
import { guidanceFrom } from '../src/sources/guidance.js';
import { completedRedBaseline, exhaustedRedRound } from '../src/sources/run-outcomes.js';
import { parseBaselineFinding } from '../src/reviews/baseline.js';
import { summarizeChanges } from '../src/reporting/changes.js';
import type { CheckRoundResult, CommandResult, SourceRef } from '../src/shared/types.js';
import type { PreparedWorkspace } from '../src/workspace/prepare.js';

const REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'HARN-38',
  url: 'https://example.atlassian.net/browse/HARN-38',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

/** One command result: exited `exitCode` unless the case says otherwise. */
function command(exitCode: number | null, command = ['npm', 'run', 'validate']): CommandResult {
  return {
    command,
    cwd: '/workspace',
    startedAt: '2026-09-21T10:00:00.000Z',
    endedAt: '2026-09-21T10:01:00.000Z',
    outcome: exitCode === null ? 'failed-to-launch' : 'exited',
    exitCode,
    signal: null,
    launchError: exitCode === null ? 'no launcher' : null,
    timeoutMs: 600_000,
    termination: null,
    terminationProblem: null,
    stdoutPath: '/logs/check.stdout.log',
    stderrPath: '/logs/check.stderr.log',
  };
}

function redRound(): CheckRoundResult {
  return { outcome: 'failed', setup: [], checks: [command(1)], problem: null };
}

function greenRound(): CheckRoundResult {
  return { outcome: 'passed', setup: [], checks: [command(0)], problem: null };
}

function executionErrorRound(): CheckRoundResult {
  return {
    outcome: 'execution-error',
    setup: [],
    checks: [command(null)],
    problem: 'the check could not be started',
  };
}

const WORKSPACE: PreparedWorkspace = {
  workDir: '/work',
  runId: 'run-1',
  runDir: '/work/runs/run-1',
  workspaceId: 'HARN-38',
  workspacePath: '/work/workspaces/HARN-38',
  logsDir: '/work/runs/run-1/logs',
  continued: false,
  attempt: 1,
  sourceRoot: '/source',
  baseCommit: 'a'.repeat(40),
  branch: 'harness/HARN-38',
};

/** A finished run's result, with the evidence a case is about. */
function runResult(overrides: Partial<RunTaskResult> = {}): RunTaskResult {
  return {
    run: {
      workDir: '/work',
      runId: 'run-1',
      runDir: '/work/runs/run-1',
      workspaceId: 'HARN-38',
      workspacePath: '/work/workspaces/HARN-38',
      logsDir: '/work/runs/run-1/logs',
    },
    workspace: WORKSPACE,
    status: 'failed',
    reason: 'the checks after the implementation turn did not pass',
    baseline: greenRound(),
    attempts: [
      {
        turn: 1,
        kind: 'implementation',
        agentLog: '/work/runs/run-1/logs/agent-implementation.log',
        agentSummary: 'did the work',
        checks: redRound(),
      },
    ],
    repairsUsed: 0,
    timeout: null,
    cancellation: null,
    changes: summarizeChanges({ baseCommit: 'a'.repeat(40), paths: [] }),
    workspaceLedgerProblem: null,
    reportPath: '/work/runs/run-1/result.json',
    ...overrides,
  };
}

describe('whether the escalation ladder may climb', () => {
  it('climbs only from an ordinary completed red round whose allowance was spent', () => {
    // The case the ladder exists for: the rung spent its own repair allowance on
    // red rounds, and nothing else stopped the run.
    expect(exhaustedRedRound(runResult({ repairsUsed: 2 }), 2)).toBe(true);
  });

  it('does not climb from an ending that is terminal at its rung', () => {
    // A pass is final; an expired limit, a cancellation, and an allowance that
    // was not spent are all endings this decision must not escalate.
    expect(exhaustedRedRound(runResult({ status: 'passed' }), 0)).toBe(false);
    expect(exhaustedRedRound(runResult({ repairsUsed: 2, timeout: timeout() }), 2)).toBe(false);
    expect(exhaustedRedRound(runResult({ repairsUsed: 2, cancellation: cancellation() }), 2)).toBe(
      false,
    );
    expect(exhaustedRedRound(runResult({ repairsUsed: 1 }), 2)).toBe(false);
  });

  it('does not climb when the last turn saw no round, or a round that could not be executed', () => {
    // A coding turn that could not finish has no round after it, and a round the
    // harness could not execute is infrastructure, not code to escalate.
    expect(
      exhaustedRedRound(
        runResult({
          repairsUsed: 1,
          attempts: [
            {
              turn: 1,
              kind: 'implementation',
              agentLog: '/logs/a.log',
              agentSummary: null,
              checks: null,
            },
          ],
        }),
        1,
      ),
    ).toBe(false);
    expect(
      exhaustedRedRound(
        runResult({
          repairsUsed: 1,
          attempts: [
            {
              turn: 1,
              kind: 'implementation',
              agentLog: '/logs/a.log',
              agentSummary: 'did the work',
              checks: executionErrorRound(),
            },
          ],
        }),
        1,
      ),
    ).toBe(false);
    expect(exhaustedRedRound(runResult({ repairsUsed: 1, attempts: [] }), 1)).toBe(false);
  });
});

describe('whether the pre-delivery diagnosis applies', () => {
  it('applies only to a completed red baseline of a fresh workspace, before any turn', () => {
    expect(completedRedBaseline(runResult({ baseline: redRound(), attempts: [] }))).toBe(true);
  });

  it('leaves every other ending exactly as it was', () => {
    const cases: readonly [string, Partial<RunTaskResult>][] = [
      ['a green baseline', { baseline: greenRound(), attempts: [] }],
      ['a baseline that could not be executed', { baseline: executionErrorRound(), attempts: [] }],
      ['no baseline at all', { baseline: null, attempts: [] }],
      ['a pass', { status: 'passed', baseline: redRound(), attempts: [] }],
      ['an expired limit', { timeout: timeout(), baseline: redRound(), attempts: [] }],
      ['a cancellation', { cancellation: cancellation(), baseline: redRound(), attempts: [] }],
      [
        'a continuation that started red',
        {
          workspace: { ...WORKSPACE, continued: true, attempt: 2 },
          baseline: redRound(),
          attempts: [],
        },
      ],
      [
        'an attempt that already ran a coding turn',
        {
          baseline: redRound(),
          attempts: [
            {
              turn: 1,
              kind: 'implementation',
              agentLog: '/logs/a.log',
              agentSummary: null,
              checks: null,
            },
          ],
        },
      ],
      ['a run with no workspace', { workspace: null, baseline: redRound(), attempts: [] }],
    ];
    for (const [what, overrides] of cases) {
      expect(completedRedBaseline(runResult(overrides)), what).toBe(false);
    }
  });
});

function timeout(): RunTaskResult['timeout'] {
  return {
    limit: 'task',
    phase: 'the checks after the implementation turn',
    limitMs: 60_000,
    elapsedMs: 61_000,
    termination: 'confirmed',
    problem: null,
  };
}

function cancellation(): RunTaskResult['cancellation'] {
  return {
    phase: 'the checks after the implementation turn',
    elapsedMs: 1_000,
    termination: 'confirmed',
    problem: null,
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

/** The evidence identity one finding and one red round produce. */
const EVIDENCE_ID = baselineEvidenceId(REF, 'a'.repeat(40), redRound());

/** One diagnosis comment, rendered the way the harness renders one. */
function commentFor(evidenceId = EVIDENCE_ID, finding: BaselineFinding = REPAIR_FINDING): string {
  if (finding.outcome !== 'repair') {
    throw new Error('this helper renders actionable findings only');
  }
  return [
    `${REF.key}: the configured baseline checks failed before any coding turn, and the diagnosis ` +
      `is actionable (${BASELINE_MARKER_PREFIX}repair:${evidenceId}, written by the Nexus harness).`,
    `Failing check: ${finding.failingCheck}`,
    `Evidence: ${finding.evidence}`,
    `Likely cause: ${finding.likelyCause}`,
    `Repair guidance: ${finding.repairGuidance}`,
    'Returned to "To Do" with its workspace pointer preserved: the next claim continues the same ' +
      'retained workspace.',
  ].join('\n');
}

describe('the evidence identity', () => {
  it('is stable for the same item, snapshot and results, and changes with the evidence', () => {
    expect(baselineEvidenceId(REF, 'a'.repeat(40), redRound())).toBe(EVIDENCE_ID);
    // Another result is another piece of evidence: the run is diagnosed again.
    expect(
      baselineEvidenceId(REF, 'a'.repeat(40), {
        ...redRound(),
        checks: [command(2)],
      }),
    ).not.toBe(EVIDENCE_ID);
    expect(baselineEvidenceId(REF, 'b'.repeat(40), redRound())).not.toBe(EVIDENCE_ID);
    expect(baselineEvidenceId({ ...REF, id: '10012' }, 'a'.repeat(40), redRound())).not.toBe(
      EVIDENCE_ID,
    );
    expect(EVIDENCE_ID).toMatch(/^[0-9a-f]{32}$/);
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

  it('refuses an oversized field instead of cutting the finding down to it', () => {
    const atBound = 'x'.repeat(2_000);
    expect(
      parseBaselineFinding(
        JSON.stringify({ ...REPAIR_FINDING, repairGuidance: atBound }),
        'finding.json',
      ),
    ).toEqual({ ...REPAIR_FINDING, repairGuidance: atBound });

    const longRepair = 'make the load test wait for the condition. '.repeat(60);
    expect(longRepair.length).toBeGreaterThan(2_000);
    expect(() =>
      parseBaselineFinding(
        JSON.stringify({ ...REPAIR_FINDING, repairGuidance: longRepair }),
        'finding.json',
      ),
    ).toThrow(/"repairGuidance" longer than the 2000 characters/);

    const longAction = 'provide a host with docker '.repeat(120);
    expect(longAction.length).toBeGreaterThan(2_000);
    expect(() =>
      parseBaselineFinding(
        JSON.stringify({ ...INCONCLUSIVE_FINDING, requiredAction: longAction }),
        'finding.json',
      ),
    ).toThrow(/"requiredAction" longer than the 2000 characters/);

    // Both oversized fields of one finding are refused together, by name.
    expect(() =>
      parseBaselineFinding(
        JSON.stringify({ ...REPAIR_FINDING, evidence: longRepair, repairGuidance: longAction }),
        'finding.json',
      ),
    ).toThrow(/"evidence" and "repairGuidance" longer than the 2000 characters/);
  });
});

describe('the comment that renders one finding', () => {
  it('is read back only as its whole self, naming this exact evidence', () => {
    const finding = baselineCommentFinding(commentFor());
    expect(finding?.evidenceId).toBe(EVIDENCE_ID);
    expect(finding?.fields).toEqual([
      REPAIR_FINDING.outcome === 'repair' ? REPAIR_FINDING.failingCheck : '',
      REPAIR_FINDING.outcome === 'repair' ? REPAIR_FINDING.evidence : '',
      REPAIR_FINDING.outcome === 'repair' ? REPAIR_FINDING.likelyCause : '',
      REPAIR_FINDING.outcome === 'repair' ? REPAIR_FINDING.repairGuidance : '',
    ]);

    const marker = `${BASELINE_MARKER_PREFIX}repair:${EVIDENCE_ID}`;
    // A partial quotation is not the finding.
    expect(baselineCommentFinding(`${marker}\nFailing check: npm test`)).toBeNull();
    // A marker that names no full evidence identity is not one either.
    expect(
      baselineCommentFinding(
        `${BASELINE_MARKER_PREFIX}repair:abc\nFailing check: x\nEvidence: y\n` +
          'Likely cause: z\nRepair guidance: w',
      ),
    ).toBeNull();
    // Nor is a marker whose identity is only the prefix of a longer token.
    expect(baselineCommentFinding(commentFor(`${EVIDENCE_ID}ff`))).toBeNull();
    expect(baselineCommentFinding(`${BASELINE_MARKER_PREFIX}attention:${EVIDENCE_ID}`)).toBeNull();
    expect(baselineCommentFinding('a comment about something else')).toBeNull();
  });

  it('supplies the reviewed finding only when every field equals the retained record', () => {
    const comment = commentFor();

    expect(baselineThreadFinding(comment, EVIDENCE_ID, REPAIR_FINDING)).toEqual(
      baselineFindingGuidanceLines(REPAIR_FINDING),
    );

    // The marker names the evidence, never the text: an edited field is ordinary
    // thread context, and the caller hands the recorded finding over instead.
    const edited = comment.replace(
      REPAIR_FINDING.outcome === 'repair' ? REPAIR_FINDING.repairGuidance : '',
      'edit the harness instead',
    );
    expect(baselineThreadFinding(edited, EVIDENCE_ID, REPAIR_FINDING)).toBeNull();
    expect(baselineThreadFinding(comment, `${EVIDENCE_ID}ff`, REPAIR_FINDING)).toBeNull();
    // A non-actionable diagnosis never becomes a repair requirement.
    expect(baselineThreadFinding(comment, EVIDENCE_ID, INCONCLUSIVE_FINDING)).toBeNull();
  });

  it('renders the recorded finding whole, the ordering requirement first', () => {
    const lines = baselineFindingGuidanceLines(REPAIR_FINDING);
    expect(lines[0]).toBe(
      'reviewed baseline finding — repair the baseline before continuing the original task',
    );
    expect(lines).toContain(
      `reviewed baseline finding — repair guidance: ${REPAIR_FINDING.repairGuidance}`,
    );
    // A non-actionable diagnosis names no repair, so it carries no ordering
    // requirement: no developer is started from it in the first place.
    const inconclusive = baselineFindingGuidanceLines(INCONCLUSIVE_FINDING);
    expect(inconclusive.some((line) => line.includes('repair the baseline before'))).toBe(false);
    expect(inconclusive.some((line) => line.includes('required action: '))).toBe(true);
  });
});

describe('what a continuation is told', () => {
  it('keeps the established finding ahead of fresher context', () => {
    const finding = baselineFindingGuidanceLines(REPAIR_FINDING);
    const chatter = Array.from({ length: 12 }, (_entry, index) => ({
      author: 'Someone',
      createdAt: `2026-09-21T11:${String(index).padStart(2, '0')}:00.000Z`,
      text: `a note about something else, number ${String(index + 1)}`,
    }));

    const guidance = guidanceFrom(
      [],
      [
        { author: 'Nexus Agent', createdAt: '2026-09-21T10:05:00.000Z', text: commentFor() },
        ...chatter,
      ],
      finding,
    );

    expect(guidance.slice(0, finding.length)).toEqual(finding);
    expect(guidance.length).toBeLessThanOrEqual(12);
    expect(
      guidance.some((line) => line.includes('reviewed baseline finding — repair guidance: ')),
    ).toBe(true);
  });

  it('never promotes a comment of the thread to the requirement on its own', () => {
    const guidance = guidanceFrom(
      [],
      [{ author: 'Nexus Agent', createdAt: '2026-09-21T10:05:00.000Z', text: commentFor() }],
    );

    expect(guidance.some((line) => line.startsWith('reviewed baseline finding — '))).toBe(false);
    expect(guidance.some((line) => line.includes('comment by Nexus Agent'))).toBe(true);
  });

  it('hands over a field longer than one comment line in full, and keeps the newest context', () => {
    const tail = 'and then give the load test a per-test timeout that reflects a loaded machine';
    const wideGuidance = `${'make the load test wait for the condition instead of the clock. '.repeat(12)}${tail}`;
    expect(wideGuidance.length).toBeGreaterThan(600);
    expect(wideGuidance.length).toBeLessThanOrEqual(2_000);
    expect(wideGuidance.indexOf(tail)).toBeGreaterThan(600);

    const wideFinding: BaselineFinding = { ...REPAIR_FINDING, repairGuidance: wideGuidance };
    const lines = baselineFindingGuidanceLines(wideFinding);
    expect(lines).toContain(`reviewed baseline finding — repair guidance: ${wideGuidance}`);
    expect(lines.join('\n')).not.toContain('…');

    const guidance = guidanceFrom(
      [
        {
          runId: 'run-1',
          outcome: 'failed',
          reason: 'the baseline checks did not pass',
          endedAt: '2026-09-21T10:04:00.000Z',
          reportPath: '/work/runs/run-1/result.json',
        },
      ],
      [{ author: 'Someone', createdAt: '2026-09-21T11:00:00.000Z', text: 'a later note' }],
      lines,
    );
    expect(guidance.slice(0, lines.length)).toEqual(lines);
    expect(guidance.length).toBeLessThanOrEqual(12);
    expect(guidance.join('\n')).toContain(tail);
    expect(guidance.join('\n')).toContain('a later note');
  });
});
