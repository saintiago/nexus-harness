import { z } from 'zod';
import type { RecordDeclaration } from '../records.js';

/**
 * The captured idea input contract: source identity, the issue revision and the complete
 * conversation the parent selected. StartIdeaRound writes its retained copy into the submission it
 * opens, and every idea role reads that copy as the current captured idea.
 */

/** The retained submission input's file name under artifacts/submissions/<n>/. */
export const ideaInputFile = 'input.json';

/**
 * The parent's retained correction for one selection: the specific question an item waited on and
 * the concrete upstream return a later preparation stage stated. The parent supplies it with the
 * captured input; older submissions retain no correction.
 */
export const ideaParentInputSchema = z.object({
  /** The human question the item waited on, when the parent retained one for this stage. */
  question: z.string().min(1).nullable(),
  /** The upstream return a later stage stated for this idea, when one is in force. */
  returnFinding: z
    .object({
      from: z.enum(['requirements', 'ux', 'prototype', 'architecture']),
      problem: z.string().min(1),
      consequence: z.string().min(1),
      correction: z.string().min(1),
    })
    .nullable(),
});

export type IdeaParentInput = z.infer<typeof ideaParentInputSchema>;

/** The captured idea input: source identity, the issue revision and the complete conversation. */
export const ideaInputSchema = z.object({
  taskKey: z.string().min(1),
  source: z.object({ kind: z.literal('jira'), issueId: z.string().min(1) }),
  issue: z.unknown(),
  conversation: z.array(z.unknown()),
  parentInput: ideaParentInputSchema.optional(),
});

export type IdeaInput = z.infer<typeof ideaInputSchema>;

export const ideaInputDeclaration = {
  file: ideaInputFile,
  schema: ideaInputSchema,
} satisfies RecordDeclaration<typeof ideaInputSchema>;
