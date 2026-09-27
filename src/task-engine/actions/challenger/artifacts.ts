import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Challenger's artifact contract: the exact refined idea revision and editor response it assessed,
 * its recommend-approval-or-discuss result and its short explanation. A discuss result names only
 * the few consequential concerns, each with its consequence and what would resolve it; optional
 * suggestions accompany either result and never block approval.
 */

/** The Challenger's result: only a plausible way forward, or a discussion of real concerns. */
export const challengerVerdicts = ['approve', 'discuss'] as const;

export type ChallengerVerdict = (typeof challengerVerdicts)[number];

/** One consequential concern: what it is, why it matters and what would resolve it. */
export const challengerConcernSchema = z.object({
  concern: z.string().trim().min(1),
  consequence: z.string().trim().min(1),
  resolution: z.string().trim().min(1),
});

export type ChallengerConcern = z.infer<typeof challengerConcernSchema>;

/** The provider response: the verdict, a short explanation and the concerns or suggestions. */
export const challengerResponseSchema = z.object({
  verdict: z.enum(challengerVerdicts),
  assessment: z.string().trim().min(1),
  concerns: z.array(challengerConcernSchema),
  suggestions: z.array(z.string().trim().min(1)),
});

export type ChallengerResponse = z.infer<typeof challengerResponseSchema>;

/**
 * The stored result: the response bound to the exact refined idea revision and editor response it
 * assessed. A revision or response saved at another path is a different subject, so an earlier
 * approval never authorizes changed content.
 */
export const challengerReportSchema = challengerResponseSchema.extend({
  /** The absolute path of the refined idea revision assessed. */
  refinedIdea: z.string().trim().min(1),
  /** The absolute path of the editor response assessed, or null when the revision stood alone. */
  editorResponse: z.string().trim().min(1).nullable(),
  revision: z.number().int().positive(),
});

export type ChallengerReport = z.infer<typeof challengerReportSchema>;

export const challengerArtifact = {
  pathFromArtifactsRoot: 'challenger.json',
  schema: challengerReportSchema,
} satisfies ArtifactDeclaration<typeof challengerReportSchema>;
