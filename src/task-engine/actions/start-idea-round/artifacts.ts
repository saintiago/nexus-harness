import { z } from 'zod';
import { ideaRoles } from '../../../agent-runtime/index.js';
import type { RecordDeclaration } from '../records.js';

/**
 * StartIdeaRound's current-round record: the active submission, the open council cycle, the route
 * that opened it and the role profiles that cycle uses. The record selects the submission's
 * artifact directory, so it sits in the refinement area's state directory beside the retained
 * submission history and can be read before any cycle artifact is resolved.
 */

/** The record's fixed location, relative to the refinement area root. */
export const ideaRoundPlanFile = 'state/current-round.json';

/** The routes XState supplies when it enters StartIdeaRound. */
export const ideaRoutes = ['new', 'minor', 'major'] as const;

export type IdeaRoute = (typeof ideaRoutes)[number];

/** The record's shape: submission and cycle are positive integers starting at 1. */
export const ideaRoundPlanSchema = z.object({
  submission: z.number().int().positive(),
  cycle: z.number().int().positive(),
  route: z.enum(ideaRoutes),
  profiles: z.partialRecord(z.enum(ideaRoles), z.string().trim().min(1)),
});

export type IdeaRoundPlan = z.infer<typeof ideaRoundPlanSchema>;

/** The record declaration consumers import instead of restating its file or shape. */
export const ideaRoundPlanDeclaration = {
  file: ideaRoundPlanFile,
  schema: ideaRoundPlanSchema,
} satisfies RecordDeclaration<typeof ideaRoundPlanSchema>;
