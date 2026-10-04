import { z } from 'zod';
import type { RecordDeclaration } from '../records.js';

/**
 * The captured idea input contract: source identity, the issue revision and the complete
 * conversation the parent selected. StartIdeaRound writes its retained copy into the submission it
 * opens, and every idea role reads that copy as the current captured idea.
 */

/** The retained submission input's file name under artifacts/submissions/<n>/. */
export const ideaInputFile = 'input.json';

/** The captured idea input: source identity, the issue revision and the complete conversation. */
export const ideaInputSchema = z.object({
  taskKey: z.string().min(1),
  source: z.object({ kind: z.literal('jira'), issueId: z.string().min(1) }),
  issue: z.unknown(),
  conversation: z.array(z.unknown()),
});

export type IdeaInput = z.infer<typeof ideaInputSchema>;

export const ideaInputDeclaration = {
  file: ideaInputFile,
  schema: ideaInputSchema,
} satisfies RecordDeclaration<typeof ideaInputSchema>;
