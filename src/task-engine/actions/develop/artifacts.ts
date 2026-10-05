import { z } from 'zod';
import { readBoundReport, reportBindingFields } from '../agent-reports.js';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Develop's artifact contract: the saved Markdown report bound to the observed repository
 * revisions. The agent returns only the status its workflow consumes; the action records the
 * profile, revisions and report association it observed.
 */

const developmentFields = {
  /** Task subject captured for this report; older reports may omit it. */
  taskSubject: z.string().optional(),
  taskKey: z.string().min(1).describe('The task key this report belongs to.'),
  profile: z.string().min(1).describe('The developer profile that produced the revision.'),
  status: z
    .enum(['completed', 'failed'])
    .describe(
      'Completed when the implementation is committed on the prepared branch and ready for ' +
        'verification; failed when it could not be completed.',
    ),
  baseRevision: z.string().min(1).describe('The comparison base the work started from.'),
  headRevision: z.string().min(1).describe('The committed revision this report describes.'),
};

/** The saved development outcome: the assigned Markdown report bound to observed revisions. */
export const developmentOutputSchema = z.strictObject({
  ...developmentFields,
  role: z.literal('developer'),
  ...reportBindingFields,
  readinessFailure: z
    .string()
    .nullable()
    .describe('The action-observed condition that prevented ready committed work, or null.'),
});

export type DevelopmentOutput = z.infer<typeof developmentOutputSchema>;

/** A retained combined development report from before the narrative/outcome separation. */
export const legacyDevelopmentOutputSchema = z.strictObject({
  ...developmentFields,
  summary: z.string().describe('The former combined narrative this report used to carry.'),
  findingResponses: z.unknown().optional(),
});

export type LegacyDevelopmentOutput = z.infer<typeof legacyDevelopmentOutputSchema>;

/**
 * The producer-owned reader: a current outcome requires its report binding, while a retained
 * combined report stays readable as history. A record carrying any binding field must satisfy the
 * current schema; a damaged new record never falls back to legacy parsing.
 */
export const retainedDevelopmentOutputSchema = z.union([
  developmentOutputSchema,
  legacyDevelopmentOutputSchema,
]);

export type RetainedDevelopmentOutput = z.infer<typeof retainedDevelopmentOutputSchema>;

/** True when one retained development outcome carries the current report binding. */
export function isBoundDevelopmentOutput(
  outcome: RetainedDevelopmentOutput,
): outcome is DevelopmentOutput {
  return 'report' in outcome;
}

/** The developer report's readable text: the saved Markdown or the former combined summary. */
export async function developmentReportText(outcome: RetainedDevelopmentOutput): Promise<string> {
  return isBoundDevelopmentOutput(outcome)
    ? (await readBoundReport(outcome, 'Development report')).text
    : outcome.summary;
}

export const devArtifact = {
  pathFromArtifactsRoot: 'development.json',
  schema: retainedDevelopmentOutputSchema,
} satisfies ArtifactDeclaration<typeof retainedDevelopmentOutputSchema>;

/** The agent's response: only the status its workflow consumes. */
export const developmentResponseSchema = z.strictObject({
  status: developmentFields.status,
});

export type DevelopmentResponse = z.infer<typeof developmentResponseSchema>;
