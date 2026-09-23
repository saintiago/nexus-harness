/**
 * Finding identity and the developer's answer to it: what a finding is called
 * for as long as it is outstanding, and which answers the harness reads as
 * complete — and which it keeps incomplete instead of rounding up.
 *
 * Both are decisions over text: no file, no process and no connector is touched
 * here (docs/testing.md).
 */
import { describe, expect, it } from 'vitest';
import type { HistoryBrief, HistoryFinding } from '../../src/history/contract.js';
import type { SourceRef, Task } from '../../src/shared/types.js';
import {
  FINDING_ANSWER_FIELDS,
  findingIdOf,
  identifyFindings,
  outstandingFindingIds,
  parseFindingAnswers,
  unresolvedRounds,
} from '../../src/history/findings.js';

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

/** One answer section, as the developer's own summary states it. */
function answer(finding: string, overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    Cause: 'the greeting ignored its argument',
    'Affected scope': 'src/greeting.ts and src/salutation.ts share the same helper',
    Repair: 'the helper now returns the greeting it was given',
    Verification: 'exercised greet("hi") through the exported function',
    'Remaining uncertainty': 'none',
    ...overrides,
  };
  return [`### Finding ${finding}`, ...Object.entries(fields).map(([k, v]) => `- ${k}: ${v}`)].join(
    '\n',
  );
}

describe('the identity one finding keeps', () => {
  it('names a finding by the round that raised it and its position there', () => {
    expect(findingIdOf(2, 0)).toBe('R2-F1');
    expect(findingIdOf(2, 4)).toBe('R2-F5');
    // A round whose number is not known — a legacy record — keeps a position.
    expect(findingIdOf(null, 2)).toBe('F3');
  });

  it('scopes an unnumbered review by its own identity, so two cannot collide', () => {
    // A review this harness kept no round number for — a native review, or a
    // baseline diagnosis — scopes its findings by the review's own identity.
    expect(findingIdOf(null, 0, '77')).toBe('N77-F1');
    expect(findingIdOf(null, 1, 'baseline-nexus-lens-8f3a')).toBe('NBASELINE-NEXUS-LENS-8F3A-F2');
    // Anything that is not a letter or digit is a separator, and the token is
    // bounded, so an identity stays readable in a prompt.
    expect(findingIdOf(null, 0, 'a / b')).toBe('NA-B-F1');
    expect(findingIdOf(null, 0, 'x'.repeat(40))).toBe(`N${'X'.repeat(24)}-F1`);
    expect(identifyFindings([{ path: 'a', line: null, body: 'b' }], null, '77')).toEqual([
      { id: 'N77-F1', path: 'a', line: null, body: 'b' },
    ]);
  });

  it('assigns the identity once, keeping one a caller already supplied', () => {
    expect(
      identifyFindings(
        [
          { path: 'src/greeting.ts', line: 2, body: 'wrong greeting' },
          { id: 'R1-F9', path: 'src/salutation.ts', line: null, body: 'same cause' },
        ],
        3,
      ),
    ).toEqual([
      { id: 'R3-F1', path: 'src/greeting.ts', line: 2, body: 'wrong greeting' },
      { id: 'R1-F9', path: 'src/salutation.ts', line: null, body: 'same cause' },
    ]);
    // A blank identity is no identity: the round's own name stands.
    expect(identifyFindings([{ id: '  ', path: 'a', line: null, body: 'b' }], 1)).toEqual([
      { id: 'R1-F1', path: 'a', line: null, body: 'b' },
    ]);
  });

  it('lists the outstanding identities of a brief, plural list first', () => {
    const finding = (id: string): HistoryFinding => ({ id, path: 'a', line: null, body: 'b' });
    const summary = (ids: readonly string[]) => ({
      entryId: 'harness:reviewer-report:review-1',
      kind: 'reviewer-report' as const,
      round: 2,
      author: 'Nexus Lens',
      createdAt: '2026-09-16T10:00:00.000Z',
      sourceId: 'review-1',
      complete: true,
      problem: null,
      status: null,
      reason: null,
      head: null,
      nativeReviewId: null,
      decision: 'request_changes',
      summary: null,
      findings: ids.map(finding),
      pullRequest: null,
    });
    const legacy: HistoryBrief = {
      ref: REF,
      task: TASK,
      latestDelivery: null,
      unresolved: summary(['R1-F1']),
      responses: [],
      newHumanFeedback: [],
    };
    expect(unresolvedRounds(legacy).map((round) => round.sourceId)).toEqual(['review-1']);
    expect(outstandingFindingIds(unresolvedRounds(legacy))).toEqual(['R1-F1']);

    const plural: HistoryBrief = {
      ...legacy,
      unresolved: summary(['R1-F1']),
      unresolvedReviews: [summary(['R1-F1']), summary(['R2-F1', 'R2-F2'])],
    };
    expect(outstandingFindingIds(unresolvedRounds(plural))).toEqual(['R1-F1', 'R2-F1', 'R2-F2']);
  });
});

describe('the developer answers the harness reads', () => {
  it('reads one complete answer for each outstanding finding, in that order', () => {
    const text = [
      '# Developer report — HARN-11, round 4',
      '',
      '## Coding turns',
      '',
      '### Turn 1 (repair)',
      '',
      answer('R3-F2'),
      '',
      answer('R3-F1', { Cause: 'the same helper ignored its argument' }),
      '',
      '### Turn 2 (repair)',
      '',
      answer('R3-F1', { Cause: 'still the shared helper' }),
    ].join('\n');
    const answers = parseFindingAnswers(text, ['R3-F1', 'R3-F2']);
    expect(answers.map((one) => one.finding)).toEqual(['R3-F1', 'R3-F2']);
    expect(answers.every((one) => one.complete)).toBe(true);
    // The last answer recorded for one identity is the one that stands.
    expect(answers[0]?.cause).toBe('still the shared helper');
    expect(answers[1]?.verification).toBe('exercised greet("hi") through the exported function');
  });

  it('keeps a finding the report never answers incomplete, naming the gap', () => {
    const answers = parseFindingAnswers(answer('R3-F1'), ['R3-F1', 'R3-F2']);
    expect(answers[1]).toMatchObject({ finding: 'R3-F2', complete: false });
    expect(answers[1]?.problem).toMatch(/no answer to this finding is recorded/);
    expect(answers[1]?.cause).toBeNull();
  });

  it('keeps an answer that leaves out a field incomplete, naming the field', () => {
    const stripped = answer('R3-F1')
      .split('\n')
      .filter((line) => !line.startsWith('- Remaining uncertainty'))
      .join('\n');
    const [incomplete] = parseFindingAnswers(stripped, ['R3-F1']);
    expect(incomplete?.complete).toBe(false);
    expect(incomplete?.problem).toContain('“Remaining uncertainty”');
    expect(incomplete?.cause).toBe('the greeting ignored its argument');
  });

  it('treats a field stated with no value as a field that was left out', () => {
    const text = ['### Finding R3-F1', '- Cause: ', '- Affected scope: src/greeting.ts'].join('\n');
    const [incomplete] = parseFindingAnswers(text, ['R3-F1']);
    expect(incomplete?.complete).toBe(false);
    expect(incomplete?.problem).toContain('“Cause”');
    expect(incomplete?.scope).toBe('src/greeting.ts');
  });

  it('matches an identity regardless of case, and lets a later heading end an answer', () => {
    const answers = parseFindingAnswers(
      [answer('r3-f1'), '', '## Checks after the turn', '- none ran'].join('\n'),
      ['R3-F1'],
    );
    expect(answers[0]?.complete).toBe(true);
    expect(answers[0]?.uncertainty).toBe('none');
    // A heading of its own ends the answer it follows: what is under it is no
    // field of the answer, and the answer stays incomplete.
    const [only] = parseFindingAnswers('### Finding R3-F1\n- Cause: a\n\n## Checks\n- x', [
      'R3-F1',
    ]);
    expect(only?.complete).toBe(false);
  });

  it('takes only a line the answer itself states, continuing it when it is indented', () => {
    const text = [
      '### Finding R3-F1',
      '- Cause: the helper ignored the argument',
      '  it was given.',
      '- Verification: exercised it',
      'Checks after the turn: passed',
      '- Repair: the helper returns what it was given.',
      '- Affected scope: src/greeting.ts',
      '- Remaining uncertainty: none',
    ].join('\n');
    const [complete] = parseFindingAnswers(text, ['R3-F1']);
    expect(complete?.complete).toBe(true);
    // The indented line continues its value, the check line ends it.
    expect(complete?.cause).toBe('the helper ignored the argument it was given.');
    expect(complete?.verification).toBe('exercised it');
  });

  it('states the five fields it reads, in the order it expects them', () => {
    expect(FINDING_ANSWER_FIELDS.map((field) => field.label)).toEqual([
      'Cause',
      'Affected scope',
      'Repair',
      'Verification',
      'Remaining uncertainty',
    ]);
  });
});
