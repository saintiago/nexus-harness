import { z } from 'zod';
import { retainedReportBindingFields } from '../agent-reports.js';
import type { IdeaReportDeclaration } from '../idea-context.js';

/**
 * Researcher's artifact contract: the completion its workflow joins on and the saved Markdown
 * report that carries the short contribution, the sourced knowledge, the idea-level possibilities
 * and the external sources with their access dates. The stored outcome names its role, the
 * focused question it answers and the report it retained, so a follow-up is distinguishable from
 * the cycle's initial enrichment.
 */

/** The provider response: the completion alone; every discovery belongs in the Markdown report. */
export const researchResponseSchema = z.strictObject({});

export type ResearchResponse = z.infer<typeof researchResponseSchema>;

/** One former combined contribution's cited source, kept readable as history. */
const legacyResearchSourceSchema = z.object({
  title: z.string().trim().min(1),
  link: z.string().trim().min(1),
  accessed: z.string().trim().min(1).nullable(),
});

/** The saved outcome the researcher action records: the report binding and observed attribution. */
export const researchContributionSchema = z.strictObject({
  taskKey: z.string().trim().min(1).describe('The selected issue or task key this report answers.'),
  role: z.literal('researcher'),
  profile: z.string().trim().min(1).describe('The researcher profile that produced this report.'),
  /** The focused question this contribution answers, or null for the cycle's initial enrichment. */
  question: z.string().trim().min(1).nullable(),
  ...retainedReportBindingFields,
});

export type ResearchContribution = z.infer<typeof researchContributionSchema>;

/** A retained combined contribution from before the narrative/outcome separation. */
export const legacyResearchContributionSchema = z.strictObject({
  role: z.literal('researcher'),
  question: z.string().trim().min(1).nullable(),
  contribution: z.string().trim().min(1),
  findings: z.array(z.string().trim().min(1)),
  options: z.array(z.string().trim().min(1)),
  sources: z.array(legacyResearchSourceSchema),
});

export type LegacyResearchContribution = z.infer<typeof legacyResearchContributionSchema>;

/** The producer-owned reader: a bound outcome, or a retained combined contribution. */
export const retainedResearchContributionSchema = z.union([
  researchContributionSchema,
  legacyResearchContributionSchema,
]);

export type RetainedResearchContribution = z.infer<typeof retainedResearchContributionSchema>;

/** True when one retained contribution carries the current report binding. */
export function isBoundResearchContribution(
  record: RetainedResearchContribution,
): record is ResearchContribution {
  return 'report' in record;
}

/** A former combined contribution's fields as the readable history its consumer opens. */
function legacyResearchNarrative(record: LegacyResearchContribution): string {
  return [
    `Contribution: ${record.contribution}`,
    ...(record.findings.length === 0
      ? []
      : ['Findings:', ...record.findings.map((finding) => `- ${finding}`)]),
    ...(record.options.length === 0
      ? []
      : ['Options:', ...record.options.map((option) => `- ${option}`)]),
    'Sources:',
    ...record.sources.map(
      (source) =>
        `- ${source.title}: ${source.link}` +
        `${source.accessed === null ? '' : ` (accessed ${source.accessed})`}`,
    ),
  ].join('\n');
}

/** The cycle's initial enrichment contribution. */
export const researchArtifact = {
  pathFromArtifactsRoot: 'researcher.json',
  schema: retainedResearchContributionSchema,
  legacyNarrative: legacyResearchNarrative,
  functionalData(record) {
    return { question: record.question };
  },
} satisfies IdeaReportDeclaration<
  typeof retainedResearchContributionSchema,
  LegacyResearchContribution
>;

/** The focused contribution answering the editor's help request in the same cycle. */
export const researchFollowUpArtifact = {
  pathFromArtifactsRoot: 'researcher-follow-up.json',
  schema: retainedResearchContributionSchema,
  legacyNarrative: legacyResearchNarrative,
  functionalData(record) {
    return { question: record.question };
  },
} satisfies IdeaReportDeclaration<
  typeof retainedResearchContributionSchema,
  LegacyResearchContribution
>;
