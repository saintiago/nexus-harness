import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Researcher's artifact contract: the agent's enrichment of the stated idea's proposed change, why
 * it matters and the principle behind it, the idea-level options it found and how they could
 * strengthen that idea, its own suggestions kept apart from source facts, and the external sources
 * with their access dates.
 */

/** One cited source: its title, link and, for external sources, the date it was accessed. */
export const researchSourceSchema = z.object({
  title: z.string().trim().min(1),
  link: z.string().trim().min(1),
  accessed: z.string().trim().min(1).nullable(),
});

export const researchReportSchema = z.object({
  summary: z.string().trim().min(1),
  /** Source facts that enrich the idea, each naming the source it came from. */
  findings: z.array(z.string().trim().min(1)),
  /** The researcher's own suggestions, distinct from source facts and kept at idea level. */
  suggestions: z.array(z.string().trim().min(1)),
  /** Idea-level possibilities and how each could strengthen the submitted idea. */
  options: z.array(z.string().trim().min(1)),
  sources: z.array(researchSourceSchema),
});

export type ResearchReport = z.infer<typeof researchReportSchema>;

export const researchArtifact = {
  pathFromArtifactsRoot: 'research.json',
  schema: researchReportSchema,
} satisfies ArtifactDeclaration<typeof researchReportSchema>;
