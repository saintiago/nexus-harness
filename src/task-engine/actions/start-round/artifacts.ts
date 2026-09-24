import { z } from 'zod';
import type { RecordDeclaration } from '../records.js';

/**
 * StartRound's current-round record: the planned round's number, the developer profile Develop must
 * use and the reason the profile was selected. The record selects the artifact directory that
 * receives this round's outputs, so it sits beside the round directories and can be read before
 * they are resolved.
 */

/** The record's fixed location, relative to the workspace root. */
export const currentRoundFile = 'state/current-round.json';

/** The record's shape: a positive integer round number starting at 1, its profile and its reason. */
export const currentRoundSchema = z.object({
  number: z.number().int().positive(),
  profile: z.string(),
  reason: z.string(),
});

export type CurrentRound = z.infer<typeof currentRoundSchema>;

/** The record declaration consumers import instead of restating its file or shape. */
export const currentRoundDeclaration = {
  file: currentRoundFile,
  schema: currentRoundSchema,
} satisfies RecordDeclaration<typeof currentRoundSchema>;
