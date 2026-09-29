import { z } from 'zod';
import type { RecordDeclaration } from '../records.js';
import { terminalReasonSchema } from '../terminal-reason.js';

/**
 * PrepareWorkspace's record: the task, repository, development branch and comparison base the
 * workspace retains. The record lives in the workspace state directory, outside the round artifact
 * roots, and is written only when preparation is ready.
 */

/** The record's fixed location, relative to the workspace root. */
export const preparedWorkspaceFile = 'state/prepared-workspace.json';

/** The prepared identity. The base revision is a comparison base, not a reset target. */
export const preparedWorkspaceSchema = z.object({
  taskKey: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  baseRevision: z.string().min(1),
});

export type PreparedWorkspace = z.infer<typeof preparedWorkspaceSchema>;

export const preparedWorkspaceDeclaration = {
  file: preparedWorkspaceFile,
  schema: preparedWorkspaceSchema,
} satisfies RecordDeclaration<typeof preparedWorkspaceSchema>;

/**
 * The identity of one finite delivery attempt. PrepareWorkspace owns the record and writes it
 * before it touches the repository, so every terminal handoff of the attempt, including a failure
 * before preparation, names the same attempt. Recovery discards the attempt's state directory on a
 * fresh restart, so the next attempt carries a new identity even when it reuses the branch name.
 */
export const attemptFile = 'state/attempt.json';

export const attemptSchema = z.object({
  attemptId: z.string().trim().min(1),
});

export type Attempt = z.infer<typeof attemptSchema>;

export const attemptDeclaration = {
  file: attemptFile,
  schema: attemptSchema,
} satisfies RecordDeclaration<typeof attemptSchema>;

/**
 * The reason PrepareWorkspace stated for its failed outcome, retained in the attempt for the
 * terminal handoff. The record exists only when preparation failed.
 */
export const preparationFailureFile = 'state/preparation-failure.json';

export const preparationFailureDeclaration = {
  file: preparationFailureFile,
  schema: terminalReasonSchema,
} satisfies RecordDeclaration<typeof terminalReasonSchema>;
