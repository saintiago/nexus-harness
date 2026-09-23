import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/** CompleteTask's artifact contract: the merge and post-merge check evidence for one task. */

/** The completion evidence: the reviewed head, its merge revision and the successful checks. */
export const completionOutputSchema = z.object({
  taskKey: z.string(),
  pullRequestUrl: z.string(),
  reviewedHead: z.string(),
  mergeRevision: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      producer: z.string(),
      revision: z.string(),
      result: z.literal('passed'),
    }),
  ),
});

export type CompletionOutput = z.infer<typeof completionOutputSchema>;

export const completionArtifact = {
  pathFromArtifactsRoot: 'completion.json',
  schema: completionOutputSchema,
} satisfies ArtifactDeclaration<typeof completionOutputSchema>;
