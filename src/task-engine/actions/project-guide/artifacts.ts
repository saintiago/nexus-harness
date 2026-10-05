import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * ProjectGuide's artifact contract: the short contribution the editor reads, how the idea could
 * fit this project's purpose, the steering that would improve it and the real constraints it
 * faces, with the documents, files and commits each material claim rests on. A contribution that
 * rests on direction inferred from code and commits is labelled provisional, and its uncertainty
 * is stated.
 */

/** The provider response: the short contribution with the project evidence behind it. */
export const projectGuideResponseSchema = z.strictObject({
  contribution: z.string().trim().min(1).describe('The short contribution the editor reads.'),
  /** How the idea could fit the project's purpose and direction. */
  fit: z
    .string()
    .trim()
    .min(1)
    .describe('How the idea could fit the project\u2019s purpose and long-term direction.'),
  /** The smallest steering that would improve the idea's fit. */
  steering: z
    .array(z.string().trim().min(1))
    .describe('The smallest steering that would improve the idea\u2019s fit.'),
  /** The real constraints that matter to this idea. */
  constraints: z
    .array(z.string().trim().min(1))
    .describe('The real constraints that matter to this idea.'),
  /** The purpose documents, files and commits each material claim rests on. */
  evidence: z
    .array(z.string().trim().min(1))
    .describe('The purpose documents, files and commits each material claim rests on.'),
  /** True when the contribution rests on direction inferred from code and commits. */
  provisional: z
    .boolean()
    .describe('True when the contribution rests on direction inferred from code and commits.'),
  uncertainty: z
    .array(z.string().trim().min(1))
    .describe('What the contribution could not establish and how that limits it.'),
});

export type ProjectGuideResponse = z.infer<typeof projectGuideResponseSchema>;

/** The stored contribution: the response bound to the role and the question it addresses. */
export const projectGuideContributionSchema = projectGuideResponseSchema.extend({
  role: z.literal('project-guide'),
  /** The focused question this contribution answers, or null for the cycle's initial contribution. */
  question: z.string().trim().min(1).nullable(),
});

export type ProjectGuideContribution = z.infer<typeof projectGuideContributionSchema>;

/** The cycle's initial project guidance contribution. */
export const projectGuideArtifact = {
  pathFromArtifactsRoot: 'project-guide.json',
  schema: projectGuideContributionSchema,
} satisfies ArtifactDeclaration<typeof projectGuideContributionSchema>;

/** The focused contribution answering the editor's help request in the same cycle. */
export const projectGuideFollowUpArtifact = {
  pathFromArtifactsRoot: 'project-guide-follow-up.json',
  schema: projectGuideContributionSchema,
} satisfies ArtifactDeclaration<typeof projectGuideContributionSchema>;
