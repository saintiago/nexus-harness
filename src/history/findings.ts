/**
 * One finding's stable identity, and the one shape a developer's answer to it
 * takes.
 *
 * A finding keeps the same identity for as long as it is outstanding: it is
 * derived from the round that raised it and its position in that round's
 * findings, so every snapshot, prompt and report names the same finding the same
 * way without storing a second name anywhere. A finding a native review stated
 * as one of its own inline comments has no retained report to be identified
 * from, and is named by the review that stated it and the comment's own source
 * identity, so deleting a sibling comment cannot rename the defects that
 * remain. A later review that finds the same defect again classifies its own
 * finding as `unresolved` or `regression` and
 * names the earlier identity it continues; that earlier identity is the one the
 * defect keeps, and the later review's own occurrence is recorded beside it, so
 * one defect is followed across rounds instead of being renamed or raised as an
 * unconnected new finding (docs/WORKFLOW.md §9).
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
import { createHash } from 'node:crypto';
import type {
  FindingAnswer,
  HistoryBrief,
  HistoryFinding,
  HistoryReportSummary,
  HistorySnapshot,
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
 * and `N77-F3` is the third finding of a report whose round number is not known
 * (a baseline diagnosis, or a report this harness kept no round number for) —
 * its own identity scopes the identity, so two reports that cannot be numbered
 * apart do not name two different findings the same way. A finding a native
 * review stated as one of its own inline comments is named by the comment's own
 * source identity instead ({@link nativeFindingIdOf}), because the position
 * among the comments one read returned does not survive a deleted sibling. The
 * identity is derived, never invented per snapshot, so a finding carries the
 * same name in the brief, in the developer's answer and in the reviewer's
 * verification.
 */
export function findingIdOf(round: number | null, index: number, scope?: string): string {
  if (round !== null) {
    return `R${String(round)}-F${String(index + 1)}`;
  }
  const token = scope === undefined ? '' : scopeToken(scope);
  return token === '' ? `F${String(index + 1)}` : `N${token}-F${String(index + 1)}`;
}

/**
 * The stable identity of one finding a native review stated as one of its own
 * inline comments: the review that stated it, and the comment's own source
 * identity.
 *
 * A native review the harness kept no complete report for has no report to
 * assign its findings' identities from; it is reconstructed from the review's
 * own entry and the inline comments that carry it. A position among the
 * comments GitHub returns in this snapshot cannot name one of them: deleting an
 * earlier sibling moves every later comment, so the defects that remain would
 * be renamed — an answer or a verification written against one identity would
 * then settle a different finding. Deriving the identity from the comment's own
 * source identity keeps it the same one for as long as the review holds that
 * comment, whatever happens to its siblings (docs/WORKFLOW.md §9).
 */
export function nativeFindingIdOf(reviewScope: string, commentId: string): string {
  return `N${scopeToken(reviewScope)}-C${scopeToken(commentId)}`;
}

/** How long a readable scope token may grow before it is shortened. */
const SCOPE_TOKEN_CHARS = 24;
/** How much of a long scope stays readable in front of its digest. */
const SCOPE_PREFIX_CHARS = 16;
/** How many hexadecimal characters of the scope's digest distinguish it. */
const SCOPE_DIGEST_CHARS = 8;

/** A bounded, readable token for the review one unnumbered finding came from. */
function scopeToken(scope: string): string {
  const token = scope
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  if (token.length <= SCOPE_TOKEN_CHARS) {
    return token;
  }
  // A scope this harness cannot number apart is often long because it carries
  // the evidence that distinguishes it — a baseline diagnosis's project
  // namespace and its evidence identity, for example. Truncation would collapse
  // two such scopes into one token and give two different defects the same
  // identity, so a readable prefix is followed by a digest of the whole scope.
  const digest = createHash('sha256')
    .update(scope, 'utf8')
    .digest('hex')
    .slice(0, SCOPE_DIGEST_CHARS)
    .toUpperCase();
  return `${token.slice(0, SCOPE_PREFIX_CHARS)}-${digest}`;
}

/**
 * The findings as one report records them, each with an identity: a reviewer's
 * own identity is kept when it supplies one, and any other finding is named by
 * the round it was raised in and its position there. The identity is assigned
 * once, at recording time, so later snapshots, prompts and verifications read
 * the same name back from the report instead of deriving a new one.
 *
 * A finding that continues an earlier one is the exception, because the
 * identity a defect keeps is the identity it was first raised with: the
 * continuation keeps the identity it names in `continues` and records what
 * this round's own report stated it as — the round and position of its
 * occurrence — beside it. A later reviewer therefore verifies the same identity
 * it read in the brief, and `recordedAs` only says where this review raised the
 * defect again.
 */
export function identifyFindings(
  findings: readonly UnidentifiedFinding[],
  round: number | null,
  scope?: string,
): readonly HistoryFinding[] {
  return findings.map((finding, index) => {
    const recordedAs = findingIdOf(round, index, scope);
    const stated = finding.id === undefined ? '' : finding.id.trim();
    const continued =
      finding.kind === 'unresolved' || finding.kind === 'regression'
        ? (finding.continues ?? '').trim()
        : '';
    if (continued !== '') {
      return { ...finding, id: continued.toUpperCase(), recordedAs };
    }
    return { ...finding, id: stated === '' ? recordedAs : stated };
  });
}

/**
 * Every finding identity that is still outstanding, in the order the rounds
 * state them. Both roles name these identities — the developer answers them,
 * and the reviewer verifies them — so the set is derived from the one snapshot
 * both roles were handed rather than assembled twice. One defect is one
 * identity however many rounds it reached: an identity a later round states
 * again is the one already listed, not a second entry.
 */
export function outstandingFindingIds(
  rounds: readonly { readonly findings: readonly HistoryFinding[] }[],
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const round of rounds) {
    for (const finding of round.findings) {
      if (!seen.has(finding.id)) {
        seen.add(finding.id);
        ids.push(finding.id);
      }
    }
  }
  return ids;
}

/**
 * The review rounds a brief still holds as outstanding, in the order it states
 * them. The brief's plural list is the contract; the single legacy field stands
 * in for a caller that only has it.
 */
export function unresolvedRounds(brief: HistoryBrief): readonly HistoryReportSummary[] {
  return brief.unresolvedReviews ?? (brief.unresolved === null ? [] : [brief.unresolved]);
}

/**
 * Every finding identity the history can resolve a continuation against, in
 * the order the reports state them: the findings of every reviewer report the
 * snapshot kept, whether or not they are still outstanding.
 *
 * A continuation — `unresolved` or `regression` — names the identity a defect
 * was raised with, and the outstanding identities above are what a verdict has
 * to verify. The two are not the same set: reconciliation settles an identity
 * as soon as a review verifies its disposition, so a repair regression of an
 * already-verified finding resolves against this retained set while the
 * verification requirement stays with the outstanding one (docs/WORKFLOW.md
 * §9). A round reconstructed from a native review has no retained report of its
 * own, so the outstanding identities are part of this set as well — and so are
 * the identities a native review an approval has already settled states in its
 * own entry and inline comments: a defect that returns keeps the name it was
 * raised with, whether or not a report was ever kept for it.
 */
export function retainedFindingIds(snapshot: HistorySnapshot): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  const coveredReviews = new Set<string>();
  for (const report of snapshot.reports) {
    if (report.kind !== 'reviewer-report') {
      continue;
    }
    // A retained report states its own findings' identities, so the native
    // review it was published as is never reconstructed from its entries.
    if (report.nativeReviewId !== null) {
      coveredReviews.add(String(report.nativeReviewId));
    }
    for (const finding of report.findings) {
      add(finding.id);
    }
  }
  // A round reconstructed from a native review has no retained report of its
  // own; its identities belong to this set as well.
  for (const round of unresolvedRounds(snapshot.brief)) {
    for (const finding of round.findings) {
      add(finding.id);
    }
  }
  // A native review this machine kept no report for is reconstructed from its
  // own entry and its inline comments, and a later approval can settle it: from
  // then on no outstanding round states those identities any more. Reproducing
  // them from the entries the snapshot keeps is what lets a later revision that
  // brings one of those defects back name the identity it was raised with
  // instead of raising an unconnected new finding (docs/WORKFLOW.md §9).
  for (const review of snapshot.entries) {
    if (review.kind !== 'pr-review' || coveredReviews.has(review.sourceId)) {
      continue;
    }
    const inline = snapshot.entries.filter(
      (entry) => entry.kind === 'pr-review-comment' && entry.reviewId === Number(review.sourceId),
    );
    for (const comment of inline) {
      add(nativeFindingIdOf(review.sourceId, comment.sourceId));
    }
  }
  return ids;
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
    const fieldsMissing = FINDING_ANSWER_FIELDS.filter(
      (field) => (section?.fields.get(field.key) ?? '').trim() === '',
    ).map((field) => field.label);
    const problem =
      section === undefined
        ? 'no answer to this finding is recorded in the developer’s own report, so nothing here ' +
          'is a complete response'
        : fieldsMissing.length > 0
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
