import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Review's artifact contract: the findings still present in the reviewed revision, the disposition
 * of every finding supplied from earlier rounds, and the verdict they support.
 */

/** One defect finding, identified by a task-stable ID. */
export const findingSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(['blocking', 'non-blocking']),
  basis: z.string(),
  evidence: z.string(),
  impact: z.string(),
  repairGuidance: z.string(),
  locations: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive().optional(),
    }),
  ),
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
  profile: z.string(),
  headRevision: z.string(),
  verdict: z.enum(['approved', 'changesRequested', 'inconclusive']),
  summary: z.string(),
  findings: z.array(findingSchema),
  priorFindings: z.array(findingDispositionSchema),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const reviewArtifact = {
  pathFromArtifactsRoot: 'review.json',
  schema: reviewOutputSchema,
} satisfies ArtifactDeclaration<typeof reviewOutputSchema>;
