import { z } from 'zod';
import { readBoundReport, reportBindingFields } from '../agent-reports.js';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Review's artifact contract: the saved Markdown review and the verdict it supports, bound to the
 * revision actually reviewed. Findings live in the Markdown report and have no machine contract;
 * the agent returns only the verdict its workflow consumes.
 */

const reviewFields = {
  /** Task subject captured for this report; older reports may omit it. */
  taskSubject: z.string().optional(),
  profile: z.string().min(1).describe('The reviewer profile that produced this verdict.'),
  headRevision: z.string().min(1).describe('The exact revision this verdict reviews.'),
  verdict: z
    .enum(['approved', 'changesRequested'])
    .describe(
      'Approved requires sufficient evidence and no current blocking finding; changesRequested ' +
        'requires at least one.',
    ),
};

/** The saved review outcome: the assigned Markdown review bound to the reviewed revision. */
export const reviewOutputSchema = z.strictObject({
  ...reviewFields,
  taskKey: z.string().min(1).describe('The task key this review belongs to.'),
  role: z.literal('reviewer'),
  ...reportBindingFields,
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/**
 * A retained combined review from before the narrative/outcome separation: its former narrative
 * and finding arrays stay readable history without their removed lifecycle or consistency rules.
 */
export const legacyReviewOutputSchema = z.strictObject({
  ...reviewFields,
  taskKey: z.string().optional(),
  summary: z.string().describe('The former combined narrative this review used to carry.'),
  findings: z.array(z.unknown()).describe('The former structured findings, kept as history.'),
  priorFindings: z.unknown().optional(),
});

export type LegacyReviewOutput = z.infer<typeof legacyReviewOutputSchema>;

/**
 * The producer-owned reader: a current outcome requires its report binding, while a retained
 * combined review stays readable as history. A record carrying any binding field must satisfy the
 * current schema; a damaged new record never falls back to legacy parsing.
 */
export const retainedReviewOutputSchema = z.union([reviewOutputSchema, legacyReviewOutputSchema]);

export type RetainedReviewOutput = z.infer<typeof retainedReviewOutputSchema>;

/** True when one retained review outcome carries the current report binding. */
export function isBoundReviewOutput(outcome: RetainedReviewOutput): outcome is ReviewOutput {
  return 'report' in outcome;
}

/** The review's readable Markdown text, or the former combined narrative. */
export async function reviewReportText(outcome: RetainedReviewOutput): Promise<string> {
  return isBoundReviewOutput(outcome)
    ? (await readBoundReport(outcome, 'Review report')).text
    : outcome.summary;
}

export const reviewArtifact = {
  pathFromArtifactsRoot: 'review.json',
  schema: retainedReviewOutputSchema,
} satisfies ArtifactDeclaration<typeof retainedReviewOutputSchema>;

/** The agent's response: only the verdict its workflow consumes. */
export const reviewResponseSchema = z.strictObject({
  verdict: reviewFields.verdict,
});

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;
