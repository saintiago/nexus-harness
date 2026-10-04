import { terminalReasonSchema } from '../../terminal-reason.js';
import type { RecordDeclaration } from '../../records.js';

/** PublishPreparationResult's source-state or publication failure. */
export const preparationPublicationFailureDeclaration = {
  file: 'state/publication-failure.json',
  schema: terminalReasonSchema,
} satisfies RecordDeclaration<typeof terminalReasonSchema>;
