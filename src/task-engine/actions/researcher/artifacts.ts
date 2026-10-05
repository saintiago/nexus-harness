import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Researcher's artifact contract: the short contribution the editor reads, the sourced knowledge
 * and idea-level possibilities behind it, and the external sources with their access dates. The
 * stored contribution names its role and the focused question it answers, so a follow-up is
 * distinguishable from the cycle's initial enrichment.
 */

/** One cited source: its title, link and, for external sources, the date it was accessed. */
export const researchSourceSchema = z.strictObject({
  title: z.string().trim().min(1).describe('The source\u2019s title.'),
  link: z.string().trim().min(1).describe('The source\u2019s link or document location.'),
  accessed: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe('The date an external source was accessed, or null for a project source.'),
});

/** The provider response: the short contribution with the knowledge and options behind it. */
export const researchResponseSchema = z.strictObject({
  contribution: z
    .string()
    .trim()
    .min(1)
    .describe('The short contribution the editor reads, with the most useful discoveries.'),
  /** Source facts that enrich the idea, each naming the source it came from. */
  findings: z
    .array(z.string().trim().min(1))
    .describe('Source facts that enrich the idea, each naming the source it came from.'),
  /** Idea-level possibilities and how each could strengthen the submitted idea. */
  options: z
    .array(z.string().trim().min(1))
    .describe('Idea-level possibilities and how each could strengthen the submitted idea.'),
  sources: z.array(researchSourceSchema).describe('Every source the findings rely on.'),
});

export type ResearchResponse = z.infer<typeof researchResponseSchema>;

/** The stored contribution: the response bound to the role and the question it addresses. */
export const researchContributionSchema = researchResponseSchema.extend({
  role: z.literal('researcher'),
  /** The focused question this contribution answers, or null for the cycle's initial enrichment. */
  question: z.string().trim().min(1).nullable(),
});

export type ResearchContribution = z.infer<typeof researchContributionSchema>;

/** The cycle's initial enrichment contribution. */
export const researchArtifact = {
  pathFromArtifactsRoot: 'researcher.json',
  schema: researchContributionSchema,
} satisfies ArtifactDeclaration<typeof researchContributionSchema>;

/** The focused contribution answering the editor's help request in the same cycle. */
export const researchFollowUpArtifact = {
  pathFromArtifactsRoot: 'researcher-follow-up.json',
  schema: researchContributionSchema,
} satisfies ArtifactDeclaration<typeof researchContributionSchema>;
