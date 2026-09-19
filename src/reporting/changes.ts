/**
 * The final change summary of a run and the two statements a reader must not be
 * left to assume: what the run's status proves, and why a flagged path needs a
 * human look (docs/spec.md section 5).
 *
 * It summarizes what an inspection found, and records an inspection that could
 * not be made as such, never as an empty one.
 */
import type { ChangedPath, ChangeSummary } from '../shared/types.js';

/**
 * What a `passed` run means, and what it does not (docs/spec.md §5). It is
 * written once here so the run timeline and the report cannot drift into saying
 * different things, and so neither can be read as a stronger claim than the
 * checks the harness really ran: the configured post-agent checks exiting `0` is
 * evidence about those commands, not proof of the task and not a safety verdict.
 */
const CHECKS_WARNING = [
  '`passed` means the configured post-agent checks exited successfully for the retained working copy.',
  'It does not prove that every acceptance criterion is met, and it does not mean the change is safe to',
  'ship: review the diff before delivery.',
].join(' ');

/**
 * Why the flagged paths need a human look. The harness points at them; it does
 * not read them, and it does not enforce anything about them (docs/spec.md §5).
 */
const HIGHLIGHTED_WARNING = [
  'the flagged paths change tests, tooling, or configuration, so the checks that decided this run may',
  'not be the checks the task needed. The harness flags them; it does not judge them, and it does not',
  'enforce tamper-proof tests.',
].join(' ');

/**
 * What a change summary is built from: the paths a working-copy inspection found,
 * or why the inspection could not be made. Exactly one of the two, because a
 * summary that could not be taken has nothing to list and must not read as one
 * that found nothing (docs/spec.md §5).
 */
export type ChangeSummaryRequest =
  | {
      /** The recorded base commit the paths were compared against. */
      readonly baseCommit: string;
      /** Every path that differs from the base, as the inspection found it. */
      readonly paths: readonly ChangedPath[];
    }
  | {
      /** The recorded base commit the comparison would have been made against. */
      readonly baseCommit: string;
      /** Why the comparison was not made, in one sentence. Never blank. */
      readonly problem: string;
    };

/**
 * The final summary of what a run left in its working copy, with the two
 * statements a reader must not be left to assume: what the run's status proves,
 * and why the flagged paths need looking at.
 *
 * A comparison that was not made keeps the reason and lists nothing, which is the
 * one thing it must not be confused with: a working copy that really matched its
 * base. {@link ChangeSummary.inspected} is what tells the two apart, and it is
 * set only for a summary built from a real inspection.
 */
export function summarizeChanges(request: ChangeSummaryRequest): ChangeSummary {
  const problem = 'problem' in request ? request.problem : null;
  const paths = 'paths' in request ? request.paths : [];
  const highlighted = paths.filter((entry) => entry.categories.length > 0);

  return {
    baseCommit: request.baseCommit,
    inspected: problem === null,
    problem,
    paths,
    highlighted,
    warnings: {
      checks: CHECKS_WARNING,
      highlighted: highlighted.length === 0 ? null : HIGHLIGHTED_WARNING,
    },
  };
}
