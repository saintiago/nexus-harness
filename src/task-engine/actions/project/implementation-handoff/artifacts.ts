import { z } from 'zod';
import type { RecordDeclaration } from '../../records.js';
import { terminalReasonSchema } from '../../terminal-reason.js';

/** HandoffImplementation's selected-work failure, retained before returning failed. */
export const implementationHandoffFailureDeclaration = {
  file: 'parent/handoff-failure.json',
  schema: terminalReasonSchema,
} satisfies RecordDeclaration<typeof terminalReasonSchema>;

const handoffResultSchema = z.object({
  outcome: z.literal('handed-off'),
  tickets: z.array(z.string().min(1)),
  mergeRevision: z.string().nullable(),
});

/** The actual published handoff outcome, saved after documents, tickets and completion. */
export const implementationHandoffResultDeclaration = {
  file: 'parent/handoff-result.json',
  schema: handoffResultSchema,
} satisfies RecordDeclaration<typeof handoffResultSchema>;
