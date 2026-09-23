import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/** SelectRepair's artifact contract: the repair allowance decision for the failed round. */

/** The recorded decision: a further round with a profile, or the exhausted allowance. */
export const repairOutputSchema = z.object({
  decision: z.enum(['selected', 'exhausted']),
  profile: z.string().nullable(),
  repairsUsed: z.number().int().nonnegative(),
  reason: z.string(),
});

export type RepairOutput = z.infer<typeof repairOutputSchema>;

export const repairArtifact = {
  pathFromArtifactsRoot: 'repair.json',
  schema: repairOutputSchema,
} satisfies ArtifactDeclaration<typeof repairOutputSchema>;
