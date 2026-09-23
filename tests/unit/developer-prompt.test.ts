/**
 * What one coding turn is told about itself: the rules that separate a passing
 * check from the task being done, the build/test change the task may authorize,
 * the integration point a repair is verified at, and the answer every
 * outstanding finding receives by its own identity.
 *
 * The prompt is built from ordinary data — no runtime, no workspace and no
 * connector is touched here (docs/testing.md).
 */
import { describe, expect, it } from 'vitest';
import { promptFor } from '../../src/agents/codex/prompt.js';
import type {
  HistoryFinding,
  HistoryReportSummary,
  HistorySnapshot,
} from '../../src/history/contract.js';
import type { AgentTurnRequest } from '../../src/runs/contracts.js';
import type { SourceRef, Task } from '../../src/shared/types.js';

const REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'HARN-11',
  url: 'https://example.atlassian.net/browse/HARN-11',
  updatedAt: '2026-09-16T09:00:00.000Z',
};

const TASK: Task = {
  id: 'HARN-11',
  title: 'Add a greeting function',
  description: 'Implement the greeting the ticket describes.',
  acceptanceCriteria: ['The greeting is implemented.'],
};

const HEAD = 'b'.repeat(40);

/** The one finding this ticket's review left outstanding. */
const FINDING: HistoryFinding = {
  id: 'R2-F1',
  path: 'src/greeting.ts',
  line: 2,
  body: 'the greeting ignores the argument it is given',
};

/** One history snapshot, with the findings a case names outstanding. */
function snapshot(findings: readonly HistoryFinding[]): HistorySnapshot {
  const review: HistoryReportSummary = {
    entryId: 'harness:reviewer-report:review-2',
    kind: 'reviewer-report',
    round: 2,
    author: 'Nexus Lens',
    createdAt: '2026-09-16T10:00:00.000Z',
    sourceId: 'review-2',
    complete: true,
    problem: null,
    status: null,
    reason: null,
    head: HEAD,
    nativeReviewId: null,
    decision: 'request_changes',
    summary: 'the greeting is wrong',
    findings: [...findings],
    pullRequest: null,
  };
  const dir = '/work/workspaces/HARN-11.history/snapshots/snapshot-1';
  return {
    version: 1,
    id: 'snapshot-1',
    role: 'developer',
    round: 3,
    takenAt: '2026-09-16T11:00:00.000Z',
    root: '/work/workspaces/HARN-11.history',
    dir,
    indexPath: `${dir}/index.md`,
    indexJsonPath: `${dir}/index.json`,
    entriesPath: `${dir}/entries.jsonl`,
    reportsDir: '/work/workspaces/HARN-11.history/reports',
    brief: {
      ref: REF,
      task: TASK,
      latestDelivery: null,
      unresolved: review,
      unresolvedReviews: findings.length === 0 ? [] : [review],
      responses: [],
      newHumanFeedback: [],
    },
    entries: [],
    reports: [review],
    gaps: [],
    mirrors: [],
    sources: [{ source: 'jira', problem: null }],
  };
}

/** One coding turn's request, as the runner composes it. */
function request(history?: HistorySnapshot): AgentTurnRequest {
  return {
    kind: 'repair',
    turn: 2,
    task: TASK,
    workspacePath: 'E:/work/workspace',
    sourceRoot: 'E:/source',
    baseCommit: HEAD,
    agentLog: {
      path: 'E:/work/logs/turn-2.log',
      write: () => undefined,
      close: async () => undefined,
    },
    repair: null,
    ...(history === undefined ? {} : { history }),
    stop: new AbortController().signal,
  };
}

describe('what one coding turn is told', () => {
  it('separates a passing check from the task, and bounds what it may change', () => {
    const prompt = promptFor(request());

    expect(prompt).toContain('## How this turn is judged');
    expect(prompt).toContain('a green round is not completion');
    expect(prompt).toContain(
      'If this task explicitly asks for a change to the project’s build or test',
    );
    expect(prompt).toContain('Otherwise leave how');
    expect(prompt).toContain('the project is built and checked as you found it');
    expect(prompt).toContain('Verify the change at the integration point it affects');
    expect(prompt).toContain('Do not re-run the project’s whole expensive test matrix');
    // The blanket rule still holds where the task authorized nothing.
    expect(prompt).toContain(
      'Do not change how the project is built or checked except where this task explicitly asks',
    );
  });

  it('asks for one answer per outstanding finding, by identity, when there are any', () => {
    const prompt = promptFor(request(snapshot([FINDING])));

    expect(prompt).toContain('## Answer every outstanding finding');
    expect(prompt).toContain('### Finding R2-F1');
    expect(prompt).toContain('- Cause: ');
    expect(prompt).toContain('- Affected scope: ');
    expect(prompt).toContain('- Repair: ');
    expect(prompt).toContain('- Verification: ');
    expect(prompt).toContain('- Remaining uncertainty: ');
    expect(prompt).toContain('Outstanding identities: R2-F1.');
    expect(prompt).toContain('recorded as no complete response');
    // The finding itself, with its identity, is in the history section too.
    expect(prompt).toContain('R2-F1');
    expect(prompt).toContain('the greeting ignores the argument it is given');
  });

  it('does not ask for answers when no change request is outstanding', () => {
    const prompt = promptFor(request(snapshot([])));

    expect(prompt).not.toContain('## Answer every outstanding finding');
    // The judging rules stand for every turn.
    expect(prompt).toContain('a green round is not completion');
  });
});
