import { z } from 'zod';
import { reportBindingFields } from '../agent-reports.js';
import type { IdeaReportDeclaration } from '../idea-context.js';

/**
 * ProjectGuide's artifact contract: the completion its workflow joins on and the saved Markdown
 * report that explains how the idea could fit this project's purpose, the steering that would
 * improve it, the real constraints it faces and the documents, files and commits each material
 * claim rests on. A contribution that rests on direction inferred from code and commits is
 * labelled provisional in the report, and its uncertainty is stated there.
 */

/** The provider response: the completion alone; the assessment belongs in the Markdown report. */
export const projectGuideResponseSchema = z.strictObject({});

export type ProjectGuideResponse = z.infer<typeof projectGuideResponseSchema>;

/** The saved outcome the guide action records: the report binding and observed attribution. */
export const projectGuideContributionSchema = z.strictObject({
  taskKey: z.string().trim().min(1).describe('The selected issue or task key this report answers.'),
  role: z.literal('project-guide'),
  profile: z.string().trim().min(1).describe('The guide profile that produced this report.'),
  /** The focused question this contribution answers, or null for the cycle's initial guidance. */
  question: z.string().trim().min(1).nullable(),
  ...reportBindingFields,
});

export type ProjectGuideContribution = z.infer<typeof projectGuideContributionSchema>;

/** A retained combined contribution from before the narrative/outcome separation. */
export const legacyProjectGuideContributionSchema = z.strictObject({
  role: z.literal('project-guide'),
  question: z.string().trim().min(1).nullable(),
  contribution: z.string().trim().min(1),
  fit: z.string().trim().min(1),
  steering: z.array(z.string().trim().min(1)),
  constraints: z.array(z.string().trim().min(1)),
  evidence: z.array(z.string().trim().min(1)),
  provisional: z.boolean(),
  uncertainty: z.array(z.string().trim().min(1)),
});

export type LegacyProjectGuideContribution = z.infer<typeof legacyProjectGuideContributionSchema>;

/** The producer-owned reader: a bound outcome, or a retained combined contribution. */
export const retainedProjectGuideContributionSchema = z.union([
  projectGuideContributionSchema,
  legacyProjectGuideContributionSchema,
]);

export type RetainedProjectGuideContribution = z.infer<
  typeof retainedProjectGuideContributionSchema
>;

/** True when one retained contribution carries the current report binding. */
export function isBoundProjectGuideContribution(
  record: RetainedProjectGuideContribution,
): record is ProjectGuideContribution {
  return 'report' in record;
}

/** A former combined contribution's fields as the readable history its consumer opens. */
function legacyProjectGuideNarrative(record: LegacyProjectGuideContribution): string {
  return [
    `Contribution: ${record.contribution}`,
    `Project fit: ${record.fit}`,
    ...(record.steering.length === 0
      ? []
      : ['Steering:', ...record.steering.map((item) => `- ${item}`)]),
    ...(record.constraints.length === 0
      ? []
      : ['Constraints:', ...record.constraints.map((item) => `- ${item}`)]),
    ...(record.evidence.length === 0
      ? []
      : ['Evidence:', ...record.evidence.map((item) => `- ${item}`)]),
    ...(record.uncertainty.length === 0
      ? []
      : ['Uncertainty:', ...record.uncertainty.map((item) => `- ${item}`)]),
    `Direction inferred provisionally: ${record.provisional ? 'yes' : 'no'}.`,
  ].join('\n');
}

/** The cycle's initial project guidance contribution. */
export const projectGuideArtifact = {
  pathFromArtifactsRoot: 'project-guide.json',
  schema: retainedProjectGuideContributionSchema,
  legacyNarrative: legacyProjectGuideNarrative,
} satisfies IdeaReportDeclaration<
  typeof retainedProjectGuideContributionSchema,
  LegacyProjectGuideContribution
>;

/** The focused contribution answering the editor's help request in the same cycle. */
export const projectGuideFollowUpArtifact = {
  pathFromArtifactsRoot: 'project-guide-follow-up.json',
  schema: retainedProjectGuideContributionSchema,
  legacyNarrative: legacyProjectGuideNarrative,
} satisfies IdeaReportDeclaration<
  typeof retainedProjectGuideContributionSchema,
  LegacyProjectGuideContribution
>;
