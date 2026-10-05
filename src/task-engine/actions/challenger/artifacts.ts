import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Challenger's artifact contract: the exact refined idea revision and editor response it assessed,
 * its recommend-approval-or-discuss result and its short explanation. A discuss result names only
 * the few consequential concerns, each with its consequence and what would resolve it, and states
 * the remaining obstacle plainly for the idea's author; optional suggestions accompany either
 * result and never block approval.
 */

/** The Challenger's result: only a plausible way forward, or a discussion of real concerns. */
export const challengerVerdicts = ['approve', 'discuss'] as const;

export type ChallengerVerdict = (typeof challengerVerdicts)[number];

/** One consequential concern: what it is, why it matters and what would resolve it. */
export const challengerConcernSchema = z.strictObject({
  concern: z.string().trim().min(1).describe('The concern that changes the decision.'),
  consequence: z.string().trim().min(1).describe('What the concern puts at risk.'),
  resolution: z.string().trim().min(1).describe('What would resolve the concern.'),
});

export type ChallengerConcern = z.infer<typeof challengerConcernSchema>;

/** The provider response: the verdict, a short explanation and the concerns or suggestions. */
export const challengerResponseSchema = z.strictObject({
  verdict: z
    .enum(challengerVerdicts)
    .describe('Approve when there is a plausible way forward; discuss to name the concerns.'),
  /** The internal account of the decision, addressed to the editor. */
  assessment: z.string().trim().min(1).describe('The internal account, addressed to the editor.'),
  /**
   * What remains unresolved, stated in plain language for the idea's author: what stopped approval
   * and why it matters, understandable without the concerns below and free of internal paths, code
   * references and instructions meant for the editor. Null when the Challenger recommends approval.
   */
  obstacle: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe(
      'What remains unresolved, in plain language for the idea\u2019s author, or null when the Challenger recommends approval.',
    ),
  concerns: z
    .array(challengerConcernSchema)
    .describe('Only the few concerns that change the decision; empty when recommending approval.'),
  suggestions: z
    .array(z.string().trim().min(1))
    .describe('Optional suggestions that do not block approval and stay separate from concerns.'),
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
