/**
 * One finding's stable identity, and the one shape a developer's answer to it
 * takes.
 *
 * A finding keeps the same identity for as long as it is outstanding: it is
 * derived from the round that raised it and its position in that round's
 * findings, so every snapshot, prompt and report names the same finding the same
 * way without storing a second name anywhere. A later review that finds the same
 * defect again classifies its own finding as `unresolved` or `regression` and
 * names the earlier identity it continues, which is how one defect is followed
 * across rounds instead of being raised as an unconnected new finding
 * (docs/WORKFLOW.md §9).
 *
 * The answer shape is what the harness reads from the developer's own complete
 * report — never from prose a person would have to interpret — and it is the
 * same for every finding: the cause, the affected scope, the repair, the
 * verification of that repair, and what remains uncertain. A finding whose
 * answer is missing, or whose answer leaves out a field, is recorded as no
 * complete response; it never appears as complete remediation.
 *
 * This module is pure: it reads text, decides, and writes nothing.
 */
import type { FindingAnswer } from './contract.js';
import type {
  HistoryBrief,
  HistoryFinding,
  HistoryReportSummary,
  UnidentifiedFinding,
} from './contract.js';

/** The five fields one developer answer carries, in the order it states them. */
export const FINDING_ANSWER_FIELDS = [
  { key: 'cause', label: 'Cause' },
  { key: 'scope', label: 'Affected scope' },
  { key: 'repair', label: 'Repair' },
  { key: 'verification', label: 'Verification' },
  { key: 'uncertainty', label: 'Remaining uncertainty' },
] as const;

/** One label of {@link FINDING_ANSWER_FIELDS}. */
export type FindingAnswerField = (typeof FINDING_ANSWER_FIELDS)[number]['key'];

/**
 * The stable identity of one finding: `R2-F3` is the third finding of round 2,
 * and `F3` is the third finding of a round whose number is not known (a legacy
 * record). The identity is derived, never invented per snapshot, so a finding
 * carries the same name in the brief, in the developer's answer and in the
 * reviewer's verification.
 */
export function findingIdOf(round: number | null, index: number): string {
  return round === null ? `F${String(index + 1)}` : `R${String(round)}-F${String(index + 1)}`;
}

/**
 * The findings as one report records them, each with an identity: a reviewer's
 * own identity is kept when it supplies one, and any other finding is named by
 * the round it was raised in and its position there. The identity is assigned
 * once, at recording time, so later snapshots, prompts and verifications read
 * the same name back from the report instead of deriving a new one.
 */
export function identifyFindings(
  findings: readonly UnidentifiedFinding[],
  round: number | null,
): readonly HistoryFinding[] {
  return findings.map((finding, index) => ({
    ...finding,
    id:
      finding.id === undefined || finding.id.trim() === ''
        ? findingIdOf(round, index)
        : finding.id.trim(),
  }));
}

/**
 * Every finding identity that is still outstanding, in the order the rounds
 * state them. Both roles name these identities — the developer answers them,
 * and the reviewer verifies them — so the set is derived from the one snapshot
 * both roles were handed rather than assembled twice.
 */
export function outstandingFindingIds(
  rounds: readonly { readonly findings: readonly HistoryFinding[] }[],
): readonly string[] {
  return rounds.flatMap((round) => round.findings.map((finding) => finding.id));
}

/**
 * The review rounds a brief still holds as outstanding, in the order it states
 * them. The brief's plural list is the contract; the single legacy field stands
 * in for a caller that only has it.
 */
export function unresolvedRounds(brief: HistoryBrief): readonly HistoryReportSummary[] {
  return brief.unresolvedReviews ?? (brief.unresolved === null ? [] : [brief.unresolved]);
}

/** One `### Finding <id>` section a developer's report may open. */
const SECTION_PATTERN = /^#{1,6}\s+finding\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/i;
/** Any heading ends the section it appears in. */
const HEADING_PATTERN = /^#{1,6}\s+\S/;
/** One `- Label: value` line, for one of the five answer labels. */
const FIELD_PATTERN = new RegExp(
  `^\\s*[-*]\\s*(${FINDING_ANSWER_FIELDS.map((field) => field.label).join('|')})\\s*:\\s*(.*)$`,
  'i',
);

/** One section as the text states it, before it is judged complete. */
interface AnswerSection {
  readonly finding: string;
  readonly fields: Map<FindingAnswerField, string>;
}

/** The label a canonical field name belongs to, or `null` for another label. */
function fieldOfLabel(label: string): FindingAnswerField | null {
  const wanted = label.trim().toLowerCase();
  const field = FINDING_ANSWER_FIELDS.find((candidate) => candidate.label.toLowerCase() === wanted);
  return field?.key ?? null;
}

/** The canonical spelling of one identity, so `r2-f1` and `R2-F1` are one. */
function canonicalFindingId(id: string): string {
  return id.trim().toUpperCase();
}

/** Every answer section the text holds, latest last. */
function answerSections(text: string): readonly AnswerSection[] {
  const sections: AnswerSection[] = [];
  let current: AnswerSection | null = null;
  let field: FindingAnswerField | null = null;

  const closeSection = (): void => {
    if (current !== null) {
      sections.push(current);
      current = null;
    }
    field = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const section = SECTION_PATTERN.exec(line);
    if (section !== null) {
      closeSection();
      current = { finding: canonicalFindingId(section[1] ?? ''), fields: new Map() };
      continue;
    }
    if (HEADING_PATTERN.test(line)) {
      // Any other heading ends the answer it follows; the developer's report
      // opens one of its own per turn and per finding.
      closeSection();
      continue;
    }
    if (current === null) {
      continue;
    }
    const value = FIELD_PATTERN.exec(line);
    if (value !== null) {
      field = fieldOfLabel(value[1] ?? '');
      if (field !== null) {
        current.fields.set(field, (value[2] ?? '').trim());
      }
      continue;
    }
    // An indented line continues the value above it, so an answer may wrap and
    // the whole of it is kept. Anything else — a check line, a blank, the next
    // paragraph — ends the value: it is not part of the answer.
    if (field !== null && /^[ \t]+\S/.test(line)) {
      const held = current.fields.get(field) ?? '';
      current.fields.set(field, held === '' ? line.trim() : `${held} ${line.trim()}`);
      continue;
    }
    field = null;
  }
  closeSection();
  return sections;
}

/**
 * The developer's answers to the findings the caller names, in that order. The
 * last section for one identity wins: a later turn that answered the same
 * finding again is the answer this snapshot reads. A finding the report does not
 * answer, and one whose answer leaves out a field, is returned incomplete with
 * the problem named — it is never rounded up to a complete response.
 */
export function parseFindingAnswers(
  text: string,
  findings: readonly string[],
): readonly FindingAnswer[] {
  const sections = new Map<string, AnswerSection>();
  for (const section of answerSections(text)) {
    sections.set(section.finding, section);
  }
  return findings.map((finding) => {
    const wanted = canonicalFindingId(finding);
    const section = sections.get(wanted);
    const missing = (): readonly string[] => {
      const held = FINDING_ANSWER_FIELDS.filter(
        (field) => (section?.fields.get(field.key) ?? '').trim() === '',
      );
      return held.map((field) => field.label);
    };
    const fieldsMissing = section === undefined ? null : missing();
    const problem =
      section === undefined
        ? 'no answer to this finding is recorded in the developer’s own report, so nothing here ' +
          'is a complete response'
        : fieldsMissing !== null && fieldsMissing.length > 0
          ? `the answer in the developer’s own report leaves out ${fieldsMissing
              .map((label) => `“${label}”`)
              .join(', ')}, so it is not a complete response`
          : null;
    const value = (key: FindingAnswerField): string | null => {
      const held = section?.fields.get(key);
      return held === undefined || held.trim() === '' ? null : held.trim();
    };
    return {
      finding,
      complete: problem === null,
      problem,
      cause: value('cause'),
      scope: value('scope'),
      repair: value('repair'),
      verification: value('verification'),
      uncertainty: value('uncertainty'),
    };
  });
}
