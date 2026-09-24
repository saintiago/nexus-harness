import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/** Deliver's artifact contract: the pull request that carries the verified revision. */

/** The published pull-request identity and the revision it contains. */
export const deliveryOutputSchema = z.object({
  repository: z.string(),
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.string(),
  headRevision: z.string(),
});

export type DeliveryOutput = z.infer<typeof deliveryOutputSchema>;

export const deliveryArtifact = {
  pathFromArtifactsRoot: 'delivery.json',
  schema: deliveryOutputSchema,
} satisfies ArtifactDeclaration<typeof deliveryOutputSchema>;
