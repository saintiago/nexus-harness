import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * PurposeVerifier's artifact contract: the agent's purpose assessment with the project's
 * discovered direction, the conflicts it found, the steering it suggests, the documents, files and
 * commits it cites and the uncertainty it could not resolve.
 */

export const purposeReportSchema = z.object({
  summary: z.string().trim().min(1),
  conflicts: z.array(z.string().trim().min(1)),
  steering: z.array(z.string().trim().min(1)),
  sources: z.array(z.string().trim().min(1)),
  /** True when the assessment rests on direction inferred from code and commits. */
  provisional: z.boolean(),
  uncertainty: z.array(z.string().trim().min(1)),
});

export type PurposeReport = z.infer<typeof purposeReportSchema>;

export const purposeArtifact = {
  pathFromArtifactsRoot: 'purpose.json',
  schema: purposeReportSchema,
} satisfies ArtifactDeclaration<typeof purposeReportSchema>;
