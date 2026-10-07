import { z } from 'zod';
import { retainedReportBindingFields } from '../agent-reports.js';
import type { IdeaReportDeclaration } from '../idea-context.js';

/**
 * Challenger's artifact contract: the verdict and the plain author-facing obstacle the workflow
 * and terminal publication consume, and the saved Markdown report that carries the decision
 * explanation, the consequential concerns with their consequences and resolutions, the assessment
 * of the editor's answers and any optional suggestions. The saved result is bound to the exact
 * refined idea revision, editor outcome and associated Markdown response it assessed.
 */

/** The Challenger's result: only a plausible way forward, or a discussion of real concerns. */
export const challengerVerdicts = ['approve', 'discuss'] as const;

export type ChallengerVerdict = (typeof challengerVerdicts)[number];

/** The provider response: the verdict and the applicable publication obstacle. */
export const challengerResponseSchema = z.strictObject({
  verdict: z
    .enum(challengerVerdicts)
    .describe('Approve when there is a plausible way forward; discuss to name the concerns.'),
  /**
   * What remains unresolved, stated in plain language for the idea's author: what stopped approval
   * and why it matters, understandable without the report. Null when the Challenger recommends
   * approval. The concerns themselves belong in the Markdown report.
   */
  obstacle: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe(
      'What remains unresolved, in plain language for the idea\u2019s author, or null when the Challenger recommends approval.',
    ),
});

export type ChallengerResponse = z.infer<typeof challengerResponseSchema>;

/** One former combined result's consequential concern, kept readable as history. */
const legacyChallengerConcernSchema = z.object({
  concern: z.string().trim().min(1),
  consequence: z.string().trim().min(1),
  resolution: z.string().trim().min(1),
});

/**
 * The saved result: the verdict and obstacle, the exact refined idea revision, editor outcome and
 * associated Markdown response assessed, and the report binding and observed attribution. A
 * revision, editor outcome or report saved at another identity is a different subject, so an
 * earlier approval never authorizes changed content.
 */
export const challengerReportSchema = z.strictObject({
  taskKey: z.string().trim().min(1).describe('The selected issue or task key this report answers.'),
  role: z.literal('challenger'),
  profile: z.string().trim().min(1).describe('The challenger profile that produced this verdict.'),
  verdict: z
    .enum(challengerVerdicts)
    .describe('Approve requires a plausible way forward; discuss names the concerns.'),
  obstacle: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe('The plain author-facing obstacle, or null when the Challenger recommends approval.'),
  /** The absolute path of the refined idea revision assessed. */
  refinedIdea: z.string().trim().min(1),
  /** The identity of the assessed revision's complete content. */
  refinedIdeaIdentity: z.string().trim().min(1),
  /** The absolute path of the editor outcome assessed, or null when the revision stood alone. */
  editorResponse: z.string().trim().min(1).nullable(),
  /** The identity of the assessed editor outcome's complete saved content, or null. */
  editorIdentity: z.string().trim().min(1).nullable(),
  revision: z.number().int().positive(),
  ...retainedReportBindingFields,
});

export type ChallengerReport = z.infer<typeof challengerReportSchema>;

/** A retained combined Challenger result from before the narrative/outcome separation. */
export const legacyChallengerReportSchema = z.strictObject({
  verdict: z.enum(challengerVerdicts),
  assessment: z.string().trim().min(1),
  obstacle: z.string().trim().min(1).nullable(),
  concerns: z.array(legacyChallengerConcernSchema),
  suggestions: z.array(z.string().trim().min(1)),
  refinedIdea: z.string().trim().min(1),
  editorResponse: z.string().trim().min(1).nullable(),
  revision: z.number().int().positive(),
});

export type LegacyChallengerReport = z.infer<typeof legacyChallengerReportSchema>;

/** The producer-owned reader: a bound result, or a retained combined result. */
export const retainedChallengerReportSchema = z.union([
  challengerReportSchema,
  legacyChallengerReportSchema,
]);

export type RetainedChallengerReport = z.infer<typeof retainedChallengerReportSchema>;

/** True when one retained result carries the current report binding. */
export function isBoundChallengerReport(
  record: RetainedChallengerReport,
): record is ChallengerReport {
  return 'report' in record;
}

/** A former combined result's fields as the readable history its consumer opens. */
function legacyChallengerNarrative(record: LegacyChallengerReport): string {
  return [
    `Assessment: ${record.assessment}`,
    ...(record.concerns.length === 0
      ? []
      : [
          'Concerns:',
          ...record.concerns.map(
            (concern) =>
              `- ${concern.concern} Consequence: ${concern.consequence} ` +
              `Resolution: ${concern.resolution}`,
          ),
        ]),
    ...(record.suggestions.length === 0
      ? []
      : ['Suggestions:', ...record.suggestions.map((suggestion) => `- ${suggestion}`)]),
    ...(record.obstacle === null ? [] : ['Remaining obstacle:', record.obstacle]),
  ].join('\n');
}

export const challengerArtifact = {
  pathFromArtifactsRoot: 'challenger.json',
  schema: retainedChallengerReportSchema,
  legacyNarrative: legacyChallengerNarrative,
  functionalData(record) {
    return { verdict: record.verdict, obstacle: record.obstacle, revision: record.revision };
  },
} satisfies IdeaReportDeclaration<typeof retainedChallengerReportSchema, LegacyChallengerReport>;

/** The untouched combined result retained before a fresh bound assessment replaces it. */
export const legacyChallengerArtifact = {
  ...challengerArtifact,
  pathFromArtifactsRoot: 'challenger-legacy.json',
  schema: legacyChallengerReportSchema,
} satisfies IdeaReportDeclaration<typeof legacyChallengerReportSchema, LegacyChallengerReport>;
