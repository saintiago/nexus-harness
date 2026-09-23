import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Develop's artifact contract. Review owns the Finding values a response refers to; the developer
 * returns one response per supplied finding.
 */

/** One developer answer to a supplied review finding. */
export const findingResponseSchema = z.object({
  findingId: z.string(),
  status: z.enum(['addressed', 'disputed', 'unresolved']),
  response: z.string(),
});

export type FindingResponse = z.infer<typeof findingResponseSchema>;

/** The development result: the agent's report bound to the observed repository revisions. */
export const developmentOutputSchema = z.object({
  taskKey: z.string(),
  profile: z.string(),
  status: z.enum(['completed', 'failed']),
  baseRevision: z.string(),
  headRevision: z.string(),
  summary: z.string(),
  findingResponses: z.array(findingResponseSchema),
});

export type DevelopmentOutput = z.infer<typeof developmentOutputSchema>;

export const devArtifact = {
  pathFromArtifactsRoot: 'development.json',
  schema: developmentOutputSchema,
} satisfies ArtifactDeclaration<typeof developmentOutputSchema>;
