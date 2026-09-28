import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Review's artifact contract: the findings still present in the reviewed revision, the disposition
 * of every finding supplied from earlier rounds, and the verdict they support.
 */

/**
 * One affected location's fields: its file, and its line in the reviewed revision when the
 * location has one.
 */
const findingLocationFields = {
  path: z.string(),
  line: z.number().int().positive(),
};

/** One location in a saved Finding: a location without a line leaves the field out. */
const findingLocationSchema = z.object({
  ...findingLocationFields,
  line: findingLocationFields.line.optional(),
});

/**
 * One location as the agent reports it. The provider's strict structured-output schema requires
 * every property, so a location without a line reports null; the action turns that null back into
 * an absent line before saving the Finding.
 */
const reportedLocationSchema = z.object({
  ...findingLocationFields,
  line: findingLocationFields.line.nullable(),
});

/** One defect finding, identified by a task-stable ID. */
export const findingSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(['blocking', 'non-blocking']),
  basis: z.string(),
  evidence: z.string(),
  impact: z.string(),
  repairGuidance: z.string(),
  locations: z.array(findingLocationSchema),
});

export type Finding = z.infer<typeof findingSchema>;

/** The reviewer's disposition of one finding supplied from an earlier round. */
export const findingDispositionSchema = z.object({
  findingId: z.string(),
  disposition: z.enum(['resolved', 'open', 'withdrawn']),
  reason: z.string(),
});

export type FindingDisposition = z.infer<typeof findingDispositionSchema>;

/** The review result for one reviewed revision. */
export const reviewOutputSchema = z.object({
  /** Task subject captured for this report; older reports may omit it. */
  taskSubject: z.string().optional(),
  profile: z.string(),
  headRevision: z.string(),
  verdict: z.enum(['approved', 'changesRequested', 'inconclusive']),
  summary: z.string(),
  findings: z.array(findingSchema),
  priorFindings: z.array(findingDispositionSchema),
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

/** One current finding as the agent reports it. */
const reportedFindingSchema = findingSchema.extend({
  locations: z.array(reportedLocationSchema),
});

type ReportedFinding = z.infer<typeof reportedFindingSchema>;

/**
 * The agent's response fields: the same review fields with locations the strict provider schema
 * accepts. The action binds them to the configured profile and the observed reviewed head before
 * writing its output.
 */
export const reviewResponseSchema = reviewOutputSchema
  .pick({ verdict: true, summary: true, priorFindings: true })
  .extend({ findings: z.array(reportedFindingSchema) });

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

export const reviewArtifact = {
  pathFromArtifactsRoot: 'review.json',
  schema: reviewOutputSchema,
} satisfies ArtifactDeclaration<typeof reviewOutputSchema>;
