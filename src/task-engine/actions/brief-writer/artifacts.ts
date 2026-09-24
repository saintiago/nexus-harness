import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * BriefWriter's artifact contract: the immutable brief revision one council cycle reviews. Each
 * cycle writes exactly one revision, so the revision number is the council cycle that produced it;
 * a later cycle writes a new revision at its own path, which invalidates every earlier approval.
 */

/** The brief's substance: the smallest coherent case the council decides on. */
export const briefContentSchema = z.object({
  problem: z.string().trim().min(1),
  value: z.string().trim().min(1),
  projectFit: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)),
  alternatives: z.array(z.string().trim().min(1)),
  scope: z.string().trim().min(1),
  assumptions: z.array(z.string().trim().min(1)),
  /** What changed from the preceding revision, or the initial summary for revision 1. */
  changeSummary: z.string().trim().min(1),
});

export type BriefContent = z.infer<typeof briefContentSchema>;

/** The stored brief revision: its substance bound to the submission and cycle that produced it. */
export const briefSchema = briefContentSchema.extend({
  revision: z.number().int().positive(),
  submission: z.number().int().positive(),
  cycle: z.number().int().positive(),
});

export type Brief = z.infer<typeof briefSchema>;

export const briefArtifact = {
  pathFromArtifactsRoot: 'brief.json',
  schema: briefSchema,
} satisfies ArtifactDeclaration<typeof briefSchema>;
