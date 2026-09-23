import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/** Verify's artifact contract: the configured checks' results for the verified revision. */

/** One check's exit code and its log paths within the round directory. */
export const verificationOutputSchema = z.object({
  headRevision: z.string(),
  status: z.enum(['passed', 'failed']),
  checks: z.array(
    z.object({
      name: z.string(),
      exitCode: z.number().int(),
      stdoutPath: z.string(),
      stderrPath: z.string(),
    }),
  ),
});

export type VerificationOutput = z.infer<typeof verificationOutputSchema>;

export const verificationArtifact = {
  pathFromArtifactsRoot: 'verification.json',
  schema: verificationOutputSchema,
} satisfies ArtifactDeclaration<typeof verificationOutputSchema>;
