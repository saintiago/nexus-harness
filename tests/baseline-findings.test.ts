/**
 * What a baseline finding is, as text: the two documented shapes the finding
 * file may carry, and the whole finding one continued attempt is given.
 *
 * Both are decisions over strings — no reviewer turn, no repository and no
 * child process — so they live in the fast layer. The reviewer turn itself, the
 * evidence it reads and the Jira record it publishes stay in
 * tests/baseline.test.ts, which runs the real stand-in reviewer and its
 * workspaces.
 */

import { describe, expect, it } from 'vitest';
import type { BaselineFinding } from '../src/sources/contract.js';
import {
  BASELINE_MARKER_PREFIX,
  baselineCommentFinding,
  baselineEvidenceId,
  baselineFindingGuidanceLines,
} from '../src/sources/baseline.js';
import { parseBaselineFinding } from '../src/reviews/baseline.js';
import { guidanceFrom } from '../src/sources/guidance.js';
import {
  BASE,
  INCONCLUSIVE_FINDING,
  ISSUE_KEY,
  REPAIR_FINDING,
  WIDE_GUIDANCE_TAIL,
  WIDE_REPAIR_FINDING,
  WIDE_REPAIR_GUIDANCE,
  baselineAttempt,
  redBaseline,
  refFor,
} from './fixtures/baseline.js';
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
    // A field at the documented bound is the finding; one past it is not cut to
    // fit. Cutting used to accept an actionable finding with the end of its
    // repair already removed — and the end of a repair can be the change or the
    // qualification the developer has to act on — while the harness keeps no
    // second copy of what the turn wrote, so neither the comment nor the
    // continuation could recover it.
    const atBound = 'x'.repeat(2_000);
    expect(
      parseBaselineFinding(
        JSON.stringify({ ...REPAIR_FINDING, repairGuidance: atBound }),
        'finding.json',
      ),
    ).toEqual({ ...REPAIR_FINDING, repairGuidance: atBound });

    const longRepair = `${'make the load test wait for the condition. '.repeat(60)}`;
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

    // Both oversized fields of one finding are refused together, and the
    // refusal says what a usable finding is: nothing is published from this one.
    expect(() =>
      parseBaselineFinding(
        JSON.stringify({ ...REPAIR_FINDING, evidence: longRepair, repairGuidance: longAction }),
        'finding.json',
      ),
    ).toThrow(/"evidence" and "repairGuidance" longer than the 2000 characters/);
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

  it('accepts only the whole comment, and reads every field of it as written', () => {
    const comment = commentFor();

    const finding = baselineCommentFinding(comment);

    // The comment is this evidence's finding, and every field comes back as the
    // comment wrote it: that is what a caller holds against the finding the
    // retained record validated, because the marker names the evidence, never
    // the text.
    expect(finding?.evidenceId).toBe(EVIDENCE_ID);
    const lines = comment.split('\n');
    const written = (label: string): string =>
      lines.find((line) => line.startsWith(`${label}: `))?.slice(label.length + 2) ?? '';
    expect(finding?.fields).toEqual([
      written('Failing check'),
      written('Evidence'),
      written('Likely cause'),
      written('Repair guidance'),
    ]);
    expect(finding?.fields.join('\n')).not.toContain('…');

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
    // What the coordinator establishes for this workspace: the finding its
    // retained evidence holds, as the guidance lines a later attempt reads.
    const finding = baselineFindingGuidanceLines(REPAIR_FINDING);
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

  it('hands over a field longer than one comment line in full', () => {
    // A valid field runs to the reviewer's own per-field bound, and the
    // instruction that matters can sit past the 600 characters one comment line
    // holds: the comment is the concise record, and the developer is handed the
    // field the outcome record validated — with its last words included.
    expect(WIDE_REPAIR_GUIDANCE.length).toBeGreaterThan(600);
    expect(WIDE_REPAIR_GUIDANCE.length).toBeLessThanOrEqual(2_000);
    expect(WIDE_REPAIR_GUIDANCE.indexOf(WIDE_GUIDANCE_TAIL)).toBeGreaterThan(600);

    const lines = baselineFindingGuidanceLines(WIDE_REPAIR_FINDING);

    expect(lines[0]).toBe(
      'reviewed baseline finding — repair the baseline before continuing the original task',
    );
    expect(lines).toContain(`reviewed baseline finding — repair guidance: ${WIDE_REPAIR_GUIDANCE}`);
    // Nothing in the guidance is cut, and nothing carries a truncation mark.
    expect(lines.join('\n')).not.toContain('…');

    // The whole field is within the brief the prompt budget keeps: the finding
    // is carried ahead of the rest and none of it is dropped for the context
    // beside it.
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
    expect(guidance.join('\n')).toContain(WIDE_GUIDANCE_TAIL);
  });

  it('keeps the newest context beside a finding wider than the whole context budget', () => {
    // One valid finding can exceed the 4,000 characters the context beside it
    // is bounded to: up to 2,000 per field, and a repair carries four of them on
    // lines of their own. The finding is what the attempt must repair first, and
    // the newest line beside it is what happened since — after the baseline
    // passed, that is the review feedback a later repair turn has to act on.
    // Charging the finding against the context budget dropped exactly that line.
    const nearBound = (text: string): string =>
      text.repeat(Math.ceil(1_900 / text.length)).slice(0, 1_900);
    const wide: BaselineFinding = {
      ...REPAIR_FINDING,
      evidence: nearBound('the load test spawned two hundred workers and timed out. '),
      likelyCause: nearBound('the fixture waits for a fixed thirty seconds. '),
      repairGuidance: nearBound('wait for the condition instead of the clock. '),
    };
    const finding = baselineFindingGuidanceLines(wide);
    expect(finding.join('\n').length).toBeGreaterThan(4_000);

    const review =
      'the delivered pull request needs repair: the repair turn left the fixed wait in place';
    const guidance = guidanceFrom(
      [baselineAttempt()],
      [
        { author: 'Nexus Agent', createdAt: '2026-09-21T10:05:00.000Z', text: commentFor() },
        { author: 'Nexus Lens', createdAt: '2026-09-21T13:00:00.000Z', text: review },
      ],
      finding,
    );

    // The finding is carried whole and first, and the context budget beside it
    // is spent on the newest line there is — the review feedback, not the
    // finding's own length.
    expect(guidance.slice(0, finding.length)).toEqual(finding);
    expect(guidance.some((line) => line.includes(review))).toBe(true);
    expect(guidance.length).toBeLessThanOrEqual(12);
  });
});
