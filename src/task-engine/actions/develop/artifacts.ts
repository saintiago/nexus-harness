import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Develop's artifact contract: the agent's narrative report bound to the observed repository
 * revisions. Review owns the Finding values previous reports carry.
 */

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
});

export type DevelopmentOutput = z.infer<typeof developmentOutputSchema>;

export const devArtifact = {
  pathFromArtifactsRoot: 'development.json',
  schema: developmentOutputSchema,
} satisfies ArtifactDeclaration<typeof developmentOutputSchema>;

/**
 * The agent's response fields: status and a narrative summary covering changes, verification,
 * answers to earlier reviews, disagreements and remaining problems. The action binds them to the
 * observed task, profile and revisions before writing its output. A retained report's former
 * finding-response field is ignored by the saved-record reader.
 */
export const developmentResponseSchema = z.strictObject(
  developmentOutputSchema.pick({ status: true, summary: true }).shape,
);

export type DevelopmentResponse = z.infer<typeof developmentResponseSchema>;
