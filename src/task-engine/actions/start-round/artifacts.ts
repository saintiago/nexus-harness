import { z } from 'zod';

/**
 * StartRound's current-round record: it selects the artifact directory that receives this round's
 * outputs. The record sits beside the round directories so it can be read before they are resolved.
 */

/** The record's fixed location, relative to the workspace root. */
export const currentRoundFile = 'state/current-round.json';

/** The record's shape: a positive integer round number, starting at 1. */
export const currentRoundSchema = z.object({ number: z.number().int().positive() });

export type CurrentRound = z.infer<typeof currentRoundSchema>;
