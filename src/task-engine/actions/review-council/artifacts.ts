import { z } from 'zod';
import type { IdeaRole } from '../../../agent-runtime/index.js';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * The three council reviewers' artifact contract. Each reviewer emits exactly one verdict, names
 * the immutable brief revision it reviewed, and names the criterion, evidence and correction of
 * every objection. The verdict precedence is shared by routing and publication.
 */

/** The three independent council reviewers. */
export const councilReviewers = ['purpose', 'evidence', 'simplicity'] as const;

export type CouncilReviewer = (typeof councilReviewers)[number];

/** The verdict one reviewer may choose. */
export const councilVerdicts = [
  'approve',
  'minor_corrections',
  'major_rework',
  'idea_not_working',
] as const;

export type CouncilVerdict = (typeof councilVerdicts)[number];

/** The idea role each reviewer's invocation carries. */
export const councilRoles: Readonly<Record<CouncilReviewer, IdeaRole>> = {
  purpose: 'purpose-council',
  evidence: 'evidence-council',
  simplicity: 'simplicity-council',
};

/** One objection: the failed criterion, the evidence and the actionable correction. */
export const councilFindingSchema = z.object({
  criterion: z.string().trim().min(1),
  evidence: z.string().trim().min(1),
  correction: z.string().trim().min(1),
});

export type CouncilFinding = z.infer<typeof councilFindingSchema>;

/** The reviewer's response: its verdict, a short summary and its findings. */
export const councilResponseSchema = z.object({
  verdict: z.enum(councilVerdicts),
  summary: z.string().trim().min(1),
  findings: z.array(councilFindingSchema),
});

export type CouncilResponse = z.infer<typeof councilResponseSchema>;

/** The stored council result: the response bound to its reviewer and the brief it reviewed. */
export const councilReportSchema = councilResponseSchema.extend({
  reviewer: z.enum(councilReviewers),
  /** The absolute path of the immutable brief artifact this result reviewed. */
  brief: z.string().trim().min(1),
  revision: z.number().int().positive(),
});

export type CouncilReport = z.infer<typeof councilReportSchema>;

/** Each reviewer's distinct artifact path under the cycle directory. */
export const councilArtifacts: Readonly<
  Record<CouncilReviewer, ArtifactDeclaration<typeof councilReportSchema>>
> = {
  purpose: { pathFromArtifactsRoot: 'council/purpose.json', schema: councilReportSchema },
  evidence: { pathFromArtifactsRoot: 'council/evidence.json', schema: councilReportSchema },
  simplicity: { pathFromArtifactsRoot: 'council/simplicity.json', schema: councilReportSchema },
};

export const purposeCouncilArtifact = councilArtifacts.purpose;
export const evidenceCouncilArtifact = councilArtifacts.evidence;
export const simplicityCouncilArtifact = councilArtifacts.simplicity;

/** The verdict precedence the workflow applies: strongest first. */
const verdictStrength: Readonly<Record<CouncilVerdict, number>> = {
  approve: 0,
  minor_corrections: 1,
  major_rework: 2,
  idea_not_working: 3,
};

/** The strongest verdict of a complete council set. */
export function strongestVerdict(verdicts: readonly CouncilVerdict[]): CouncilVerdict {
  let strongest: CouncilVerdict = 'approve';
  for (const verdict of verdicts) {
    if (verdictStrength[verdict] > verdictStrength[strongest]) {
      strongest = verdict;
    }
  }
  return strongest;
}
