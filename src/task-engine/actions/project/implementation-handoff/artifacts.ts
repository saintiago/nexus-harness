import { z } from 'zod';
import type { RecordDeclaration } from '../../records.js';
import { terminalReasonSchema } from '../../terminal-reason.js';
import { preparationWorkspaceSchema } from '../../preparation/artifacts.js';

/** HandoffImplementation's selected-work failure, retained before returning failed. */
export const implementationHandoffFailureDeclaration = {
  file: 'parent/handoff-failure.json',
  schema: terminalReasonSchema,
} satisfies RecordDeclaration<typeof terminalReasonSchema>;

/**
 * The implementation input the handoff writes under one implementation issue's parent area before
 * admitting it. Machine admission reads this record; nothing parses the ticket description.
 * PreparationWorkspace is the preparation producer's declaration, imported rather than restated.
 * The first planned task names the retained preparation repository it continues; every later task
 * carries no continuation and prepares its own checkout from the updated merged base.
 */
export const implementationInputFile = 'parent/implementation-input.json';

export const implementationInputSchema = z.object({
  sourceKey: z.string().min(1),
  sourceWorkspace: z.object({ root: z.string().min(1) }),
  architectureResult: z.object({ path: z.string().min(1) }),
  planIdentity: z.string().min(1),
  plannedTask: z.number().int().nonnegative(),
  /** The prerequisite ticket keys whose confirmed completion this ticket waits for. */
  prerequisites: z.array(z.string().min(1)),
  continuation: z
    .object({ workspace: preparationWorkspaceSchema, headRevision: z.string().min(1) })
    .nullable(),
});

export type ImplementationInput = z.infer<typeof implementationInputSchema>;

export const implementationInputDeclaration = {
  file: implementationInputFile,
  schema: implementationInputSchema,
} satisfies RecordDeclaration<typeof implementationInputSchema>;

const handoffResultSchema = z.object({
  outcome: z.literal('handed-off'),
  tickets: z.array(z.string().min(1)),
});

/** The actual published handoff outcome, saved after documents, tickets and completion. */
export const implementationHandoffResultDeclaration = {
  file: 'parent/handoff-result.json',
  schema: handoffResultSchema,
} satisfies RecordDeclaration<typeof handoffResultSchema>;
