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
  nativeFindingIdOf,
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
    expect(findingIdOf(null, 0, 'x'.repeat(40))).toMatch(/^NX{16}-[0-9A-F]{8}-F1$/);
    expect(identifyFindings([{ path: 'a', line: null, body: 'b' }], null, '77')).toEqual([
      { id: 'N77-F1', path: 'a', line: null, body: 'b' },
    ]);
  });

  it('names a native review’s inline finding by the comment’s own identity', () => {
    // A native review the harness kept no report for is reconstructed from its
    // own inline comments. A position among the comments GitHub returns in one
    // snapshot cannot name them: deleting an earlier sibling would move every
    // later comment, so an answer written for one finding would settle another.
    expect(nativeFindingIdOf('91', '9001')).toBe('N91-C9001');
    expect(nativeFindingIdOf('91', '9002')).toBe('N91-C9002');
    // The identity is derived, not generated per snapshot: the same review and
    // comment read back the same name.
    expect(nativeFindingIdOf('91', '9001')).toBe(nativeFindingIdOf('91', '9001'));
    // Two reviews this harness cannot number apart still name their comments
    // apart, and a comment identity is bounded like any other token.
    expect(nativeFindingIdOf('a / b', '7')).toBe('NA-B-C7');
    expect(nativeFindingIdOf('91', 'x'.repeat(40))).toMatch(/^N91-CX{16}-[0-9A-F]{8}$/);
  });

  it('keeps two unnumbered reviews of one project apart, whatever their evidence', () => {
    // A baseline diagnosis's identity is `baseline-<64-character project
    // namespace>-<32-character evidence id>`: the whole evidence identity is
    // what tells two diagnoses in one project apart, so a bounded token keeps a
    // digest of it rather than dropping it at the length bound.
    const project = 'f'.repeat(64);
    const one = findingIdOf(null, 0, `baseline-${project}-${'1'.repeat(32)}`);
    const two = findingIdOf(null, 0, `baseline-${project}-${'2'.repeat(32)}`);
    expect(one).not.toBe(two);
    // The readable prefix stays and the digest of the whole identity follows
    // it, so the identity is still short enough to name in a prompt.
    expect(one).toMatch(/^NBASELINE-F{7}-[0-9A-F]{8}-F1$/);
    // The same identity reads back the same way, so answers and verifications
    // written against it keep matching across snapshots and restarts.
    expect(findingIdOf(null, 0, `baseline-${project}-${'1'.repeat(32)}`)).toBe(one);
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

  it('keeps the earlier identity when a later review raises the same defect again', () => {
    // A continuation is not a new defect: the identity the defect keeps is the
    // one it was raised with, and this round's own position is recorded beside
    // it as the occurrence, so a developer answer and a reviewer verification
    // name the same finding they named in the round before.
    expect(
      identifyFindings(
        [
          {
            path: 'src/greeting.ts',
            line: 2,
            body: 'the argument is still ignored',
            kind: 'unresolved',
            continues: 'r1-f1',
            related: [{ path: 'src/salutation.ts', line: 4 }],
          },
        ],
        2,
      ),
    ).toEqual([
      {
        id: 'R1-F1',
        recordedAs: 'R2-F1',
        path: 'src/greeting.ts',
        line: 2,
        body: 'the argument is still ignored',
        kind: 'unresolved',
        continues: 'r1-f1',
        related: [{ path: 'src/salutation.ts', line: 4 }],
      },
    ]);
    // A new finding beside a continuation keeps the round's own identity, and
    // the continuation's own round position is not reused for it.
    expect(
      identifyFindings(
        [
          {
            path: 'a',
            line: 1,
            body: 'still broken',
            kind: 'regression',
            continues: 'R1-F1',
          },
          { path: 'b', line: 2, body: 'a defect found for the first time' },
        ],
        2,
      ).map((finding) => [finding.id, finding.recordedAs ?? null]),
    ).toEqual([
      ['R1-F1', 'R2-F1'],
      ['R2-F2', null],
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
    // One defect is one identity: the same identity stated again by a later
    // round is the one already listed, not a second entry to answer.
    const repeated: HistoryBrief = {
      ...legacy,
      unresolvedReviews: [summary(['R1-F1']), summary(['R1-F1', 'R2-F1'])],
    };
    expect(outstandingFindingIds(unresolvedRounds(repeated))).toEqual(['R1-F1', 'R2-F1']);
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
      answer('R3-F1', { Cause: 'still the shared helper' }),
    ].join('\n');
    const answers = parseFindingAnswers(text, ['R3-F1', 'R3-F2']);
    expect(answers.map((one) => one.finding)).toEqual(['R3-F1', 'R3-F2']);
    expect(answers.every((one) => one.complete)).toBe(true);
    // Within one turn's own text, the last section recorded for one identity is
    // the one that stands. Which turn's text is read is the caller's decision:
    // a report's answers are read from its newest coding turn alone, so an
    // earlier turn's answer never stands in for a later turn that gave none.
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
