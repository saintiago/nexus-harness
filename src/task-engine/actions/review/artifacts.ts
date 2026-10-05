import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Review's artifact contract: the findings present in the reviewed revision and the verdict they
 * support. Findings carry no lifecycle identity; earlier reports remain readable evidence.
 */

/**
 * One affected location's fields: its file, and its line in the reviewed revision when the
 * location has one.
 */
const findingLocationFields = {
  path: z.string().describe('The affected file in the reviewed revision.'),
  line: z.number().int().positive().describe('The one-based line in the reviewed revision.'),
};

/** One location in a saved Finding: a location without a line leaves the field out. */
const findingLocationSchema = z.strictObject({
  ...findingLocationFields,
  line: findingLocationFields.line.optional(),
});

/**
 * One location as the agent reports it. The provider's strict structured-output schema requires
 * every property, so a location without a line reports null; the action turns that null back into
 * an absent line before saving the Finding.
 */
const reportedLocationSchema = z.strictObject({
  ...findingLocationFields,
  line: findingLocationFields.line
    .nullable()
    .describe('The reviewed revision\u2019s line, or null when the location has no line.'),
});

/** One defect finding present in the assessed revision. */
export const findingSchema = z.strictObject({
  title: z.string().describe('A short title for the defect.'),
  severity: z
    .enum(['blocking', 'non-blocking'])
    .describe('Whether the finding prevents acceptance.'),
  basis: z.string().describe('The requirement or expected behavior that is violated.'),
  evidence: z
    .string()
    .describe(
      'The observed or reproducible failure, related occurrences inspected and material uncertainty.',
    ),
  impact: z.string().describe('The consequence of the defect.'),
  repairGuidance: z.string().describe('The required correction.'),
  locations: z.array(findingLocationSchema).describe('The affected locations; may be empty.'),
});

export type Finding = z.infer<typeof findingSchema>;

/**
 * One finding as a retained report may still carry it: the current shape plus the removed stable
 * ID. The producer's saved-record reader preserves it as historical data, and no current rule
 * reads, matches or validates it.
 */
export const retainedFindingSchema = z.strictObject({
  id: z.string().optional(),
  ...findingSchema.shape,
});

/** The review result's fields; the exported schema adds the verdict-consistency check. */
const reviewOutputFieldsSchema = z.object({
  /** Task subject captured for this report; older reports may omit it. */
  taskSubject: z.string().optional(),
  profile: z.string().describe('The reviewer profile that produced this verdict.'),
  headRevision: z.string().describe('The exact revision this verdict reviews.'),
  verdict: z
    .enum(['approved', 'changesRequested'])
    .describe(
      'Approved requires sufficient evidence and no current blocking finding; changesRequested requires at least one.',
    ),
  summary: z
    .string()
    .describe('What was reviewed, the inspected scope and why this verdict is supported.'),
  findings: z
    .array(retainedFindingSchema)
    .describe('The findings present in the reviewed revision, including newly discovered ones.'),
  /**
   * The former prior-finding disposition array a retained report may still carry. It stays stored
   * as history and is never matched, validated or answered.
   */
  priorFindings: z.unknown().optional(),
});

/** Why one review verdict is unsupported by the findings it reports, or null. */
function verdictProblem(
  verdict: ReviewOutput['verdict'],
  findings: readonly { readonly severity: Finding['severity'] }[],
): string | null {
  const blockingCount = findings.filter((finding) => finding.severity === 'blocking').length;
  if (verdict === 'approved' && blockingCount > 0) {
    return 'approved the revision while reporting a blocking finding';
  }
  if (verdict === 'changesRequested' && blockingCount === 0) {
    return 'requested changes without a current blocking finding';
  }
  return null;
}

/**
 * The review result for one reviewed revision. The producer-owned reader rejects a report whose
 * verdict contradicts its current findings, so continuation, history and downstream consumers all
 * receive a consistent saved report; former fields stay permitted as retained data.
 */
export const reviewOutputSchema = reviewOutputFieldsSchema.superRefine((report, context) => {
  const problem = verdictProblem(report.verdict, report.findings);
  if (problem !== null) {
    context.addIssue({ code: 'custom', path: ['verdict'], message: `the review ${problem}` });
  }
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/**
 * The persisted Finding for one finding the agent reported: the response's explicit null line is
 * the Finding contract's absent line.
 */
export function toFinding(reported: ReportedFinding): Finding {
  return {
    ...reported,
    locations: reported.locations.map(({ path, line }) =>
      line === null ? { path } : { path, line },
    ),
  };
}

/** One current finding as the agent reports it: a location without a line reports null. */
export const reportedFindingSchema = findingSchema.extend({
  locations: z
    .array(reportedLocationSchema)
    .describe('The affected locations; may be empty. A location without a line reports null.'),
});

export type ReportedFinding = z.infer<typeof reportedFindingSchema>;

/**
 * The agent's response fields: the review fields with locations the strict provider schema
 * accepts. The action binds them to the configured profile and the observed reviewed head before
 * writing its output.
 */
export const reviewResponseSchema = z.strictObject({
  ...reviewOutputFieldsSchema.pick({ verdict: true, summary: true }).shape,
  findings: z
    .array(reportedFindingSchema)
    .describe('The findings present in the reviewed revision, including newly discovered ones.'),
});

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

export const reviewArtifact = {
  pathFromArtifactsRoot: 'review.json',
  schema: reviewOutputSchema,
} satisfies ArtifactDeclaration<typeof reviewOutputSchema>;

/** Validate one agent report's verdict against its current findings. */
export function validateReviewResponse(report: ReviewResponse): void {
  const problem = verdictProblem(report.verdict, report.findings);
  if (problem !== null) {
    throw new Error(`The reviewer ${problem}.`);
  }
}
