import path from 'node:path';
import type { RecordDeclaration } from '../records.js';
import { retainTerminalReason, terminalReasonSchema } from '../terminal-reason.js';

/** The latest failed child operation, retained independently of earlier terminal round results. */
export const stageFailureDeclaration = {
  file: 'state/failure.json',
  schema: terminalReasonSchema,
} satisfies RecordDeclaration<typeof terminalReasonSchema>;

/** One writer owns the child failure path for every preparation operation that returns failed. */
export async function retainStageFailure(root: string, reason: string): Promise<void> {
  await retainTerminalReason(path.join(root, stageFailureDeclaration.file), reason);
}
