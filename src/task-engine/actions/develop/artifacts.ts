import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Develop's artifact contract. Review owns the Finding values a response refers to; the developer
 * returns one response per supplied finding.
 */

/** One developer answer to a supplied review finding. */
export const findingResponseSchema = z.strictObject({
  findingId: z.string().describe('The supplied finding ID this answer addresses.'),
  status: z
    .enum(['addressed', 'disputed', 'unresolved'])
    .describe('What happened to the finding in this revision.'),
  response: z
    .string()
    .describe('The change, disagreement or remaining problem, with supporting evidence.'),
});

export type FindingResponse = z.infer<typeof findingResponseSchema>;

/** The development result: the agent's report bound to the observed repository revisions. */
export const developmentOutputSchema = z.object({
  /** Task subject captured for this report; older reports may omit it. */
  taskSubject: z.string().optional(),
  taskKey: z.string().describe('The task key this report belongs to.'),
  profile: z.string().describe('The developer profile that produced the revision.'),
  status: z
    .enum(['completed', 'failed'])
    .describe(
      'Completed when the implementation is committed on the prepared branch and ready for verification; failed when it could not be completed.',
    ),
  baseRevision: z.string().describe('The comparison base the work started from.'),
  headRevision: z.string().describe('The committed revision this report describes.'),
  summary: z
    .string()
    .describe('What changed and why, or why the implementation could not be completed.'),
  findingResponses: z
    .array(findingResponseSchema)
    .describe(
      'One entry for every supplied finding ID and none for any other ID; empty when no findings were supplied.',
    ),
});

export type DevelopmentOutput = z.infer<typeof developmentOutputSchema>;

export const devArtifact = {
  pathFromArtifactsRoot: 'development.json',
  schema: developmentOutputSchema,
} satisfies ArtifactDeclaration<typeof developmentOutputSchema>;

/**
 * The agent's response fields. The action binds them to the observed task, profile and revisions
 * before writing its output.
 */
export const developmentResponseSchema = z.strictObject(
  developmentOutputSchema.pick({ status: true, summary: true, findingResponses: true }).shape,
);

export type DevelopmentResponse = z.infer<typeof developmentResponseSchema>;
