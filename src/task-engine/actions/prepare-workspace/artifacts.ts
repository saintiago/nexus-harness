import { z } from 'zod';
import type { RecordDeclaration } from '../records.js';

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
