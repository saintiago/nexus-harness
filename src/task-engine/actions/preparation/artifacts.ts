import { z } from 'zod';
import { preparationStages, type PreparationStage } from '../../../configuration/index.js';
import type { ArtifactDeclaration } from '../artifacts.js';
import type { RecordDeclaration } from '../records.js';
import { findingResponseSchema } from '../develop/artifacts.js';
import { findingDispositionSchema, findingSchema } from '../review/artifacts.js';
import { terminalReasonSchema } from '../terminal-reason.js';

/**
 * The evaluated preparation stages' shared artifact contract: each stage area keeps its round
 * plan, the author's proposal or revision, the evaluator's assessment of that exact revision and
 * the terminal result the parent publication consumes. Schema ownership follows the preparation
 * stage operations; the project workflow owns routing and publication.
 */

export { preparationStages, type PreparationStage };

/** The directory each stage owns under the shared issue workspace root. */
export const stageAreas: Readonly<Record<PreparationStage, string>> = {
  requirements: 'requirements',
  ux: 'ux',
  prototype: 'prototype',
  architecture: 'architecture',
};

/**
 * The shared preparation repository record: the configured repository, the workspace reference
 * whose worktree/ holds the one checkout every stage edits, the retained preparation branch and
 * the comparison base preparation started from. PrepareStage owns it under the preparation issue
 * workspace's parent area.
 */
export const preparationRepositoryFile = 'parent/prepared-repository.json';

export const preparationWorkspaceSchema = z.object({
  repository: z.string().min(1),
  repositoryWorkspace: z.object({ root: z.string().min(1) }),
  branch: z.string().min(1),
  baseRevision: z.string().min(1),
});

export type PreparationWorkspace = z.infer<typeof preparationWorkspaceSchema>;

export const preparationWorkspaceDeclaration = {
  file: preparationRepositoryFile,
  schema: preparationWorkspaceSchema,
} satisfies RecordDeclaration<typeof preparationWorkspaceSchema>;

/** The earlier stages a preparation result may return work to. */
export const upstreamStages = ['idea', 'requirements', 'ux', 'prototype'] as const;

export type UpstreamStage = (typeof upstreamStages)[number];

/** The stage-round plan: the open round, the route that opened it and the selected profiles. */
export const stageRoundPlanFile = 'state/current-round.json';

export const stageRoundPlanSchema = z.object({
  stage: z.enum(preparationStages),
  round: z.number().int().positive(),
  route: z.enum(['new', 'next', 'reassess']),
  profiles: z.object({
    author: z.string().trim().min(1),
    evaluator: z.string().trim().min(1),
  }),
});

export type StageRoundPlan = z.infer<typeof stageRoundPlanSchema>;

export const stageRoundPlanDeclaration = {
  file: stageRoundPlanFile,
  schema: stageRoundPlanSchema,
} satisfies RecordDeclaration<typeof stageRoundPlanSchema>;

/** The reason RecordStageReturn stated for its exhausted outcome. */
export const stageReturnExhaustionFile = 'state/return-exhaustion.json';

export const stageReturnExhaustionDeclaration = {
  file: stageReturnExhaustionFile,
  schema: terminalReasonSchema,
} satisfies RecordDeclaration<typeof terminalReasonSchema>;

/** The reason StartStageRound stated when the configured stage-round allowance was reached. */
export const stageRoundExhaustionFile = 'state/round-exhaustion.json';

export const stageRoundExhaustionDeclaration = {
  file: stageRoundExhaustionFile,
  schema: terminalReasonSchema,
} satisfies RecordDeclaration<typeof terminalReasonSchema>;

/** One authoritative document the author produced or revised, relative to the stage worktree. */
export const authoredDocumentSchema = z.object({
  path: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

/** One bounded implementation task the Architect planned. */
export const plannedTaskSchema = z.object({
  summary: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  completionCriteria: z.array(z.string().trim().min(1)).min(1),
  prerequisites: z.array(z.number().int().nonnegative()),
});

export type PlannedTask = z.infer<typeof plannedTaskSchema>;

/** One upstream return: the problematic input, its consequence and the correction needed. */
export const upstreamRequestSchema = z.object({
  stage: z.enum(upstreamStages),
  problem: z.string().trim().min(1),
  consequence: z.string().trim().min(1),
  correction: z.string().trim().min(1),
});

export type UpstreamRequest = z.infer<typeof upstreamRequestSchema>;

/** One applicability skip the author proposes, with the existing inputs that satisfy the stage. */
export const skipProposalSchema = z.object({
  reason: z.string().trim().min(1),
  references: z.array(z.string().trim().min(1)).min(1),
});

/** One location as the evaluator reports it: an absent line is null for the strict schema. */
const reportedLocationSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().nullable(),
});

/** One evaluated finding as the evaluator reports it. */
const reportedFindingSchema = findingSchema.extend({
  locations: z.array(reportedLocationSchema),
});

/**
 * The author's report: the proposal or revision plus its documents, skip proposal, question or
 * upstream request. Finding responses use the shared findings contract.
 */
export const stageAuthorResponseSchema = z.object({
  outcome: z.enum(['authored', 'skip-proposed', 'needs-input', 'return-upstream']),
  summary: z.string(),
  documents: z.array(authoredDocumentSchema),
  /**
   * Additional non-document paths the stage owns and commits in the shared checkout, such as the
   * prototype's Storybook stories. They are stage-owned work, never authoritative documents.
   */
  sourcePaths: z.array(z.string().trim().min(1)),
  plan: z.array(plannedTaskSchema),
  skip: skipProposalSchema.nullable(),
  question: z.string().nullable(),
  upstream: upstreamRequestSchema.nullable(),
  findingResponses: z.array(findingResponseSchema),
});

export type StageAuthorResponse = z.infer<typeof stageAuthorResponseSchema>;

/** The saved author artifact: the report bound to the stage and its authored revision. */
export const stageAuthorOutputSchema = stageAuthorResponseSchema.extend({
  stage: z.enum(preparationStages),
  revision: z.number().int().positive(),
});

export type StageAuthorOutput = z.infer<typeof stageAuthorOutputSchema>;

export const stageAuthorArtifact = {
  pathFromArtifactsRoot: 'author.json',
  schema: stageAuthorOutputSchema,
} satisfies ArtifactDeclaration<typeof stageAuthorOutputSchema>;

/**
 * The evaluator's report: the exact revision it assessed, its verdict, its findings and any
 * upstream request, plus its disposition of every finding the response round inherited. A skip may
 * only be accepted when the author proposed one.
 */
export const stageEvaluationResponseSchema = z.object({
  assessedRevision: z.number().int().positive(),
  verdict: z.enum(['accepted', 'accepted-skip', 'changes-requested', 'return-upstream']),
  reason: z.string(),
  findings: z.array(reportedFindingSchema),
  priorFindings: z.array(findingDispositionSchema),
  upstream: upstreamRequestSchema.nullable(),
});

export type StageEvaluationResponse = z.infer<typeof stageEvaluationResponseSchema>;

/** One repository path the evaluator assessed or relied on: its observed revision and existence. */
export const assessedContentSchema = z.object({
  /** The canonical checkout-relative path of the assessed repository content. */
  path: z.string().min(1),
  /** The revision at which the content was observed; it must stay readable while retained. */
  revision: z.string().min(1),
  /** False when the assessed revision deletes the path; a deletion is retained, not replaced. */
  exists: z.boolean(),
});

export type AssessedContent = z.infer<typeof assessedContentSchema>;

/**
 * The evaluation's acceptance basis, observed by the stage action rather than trusted from an
 * agent: the complete authored report, the captured source input, the relied-on upstream results
 * and the exact repository content the evaluator assessed. A changed author report, input or
 * assessed content needs a current evaluator decision.
 */
export const acceptanceBasisSchema = z.object({
  author: z.object({ path: z.string().min(1) }),
  authorIdentity: z.string().min(1),
  sourceIdentity: z.string().min(1),
  upstream: z.array(
    z.object({
      result: z.object({ path: z.string().min(1) }),
      identity: z.string().min(1),
    }),
  ),
  content: z.array(assessedContentSchema),
});

export type AcceptanceBasis = z.infer<typeof acceptanceBasisSchema>;

/**
 * The saved evaluation artifact: reported findings with their absent lines normalized away, and
 * one disposition for every finding the assessed revision inherited.
 */
export const stageEvaluationOutputSchema = z.object({
  /** The exact authored report, captured input and assessed content this decision is bound to. */
  basis: acceptanceBasisSchema,
  assessedRevision: z.number().int().positive(),
  verdict: z.enum(['accepted', 'accepted-skip', 'changes-requested', 'return-upstream']),
  reason: z.string(),
  findings: z.array(findingSchema),
  priorFindings: z.array(findingDispositionSchema),
  upstream: upstreamRequestSchema.nullable(),
});

export type StageEvaluationOutput = z.infer<typeof stageEvaluationOutputSchema>;

export const stageEvaluationArtifact = {
  pathFromArtifactsRoot: 'evaluation.json',
  schema: stageEvaluationOutputSchema,
} satisfies ArtifactDeclaration<typeof stageEvaluationOutputSchema>;

/** The terminal result the parent publication reads and the child returns a reference to. */
export const preparationResultSchema = z.object({
  stage: z.enum(preparationStages),
  outcome: z.enum(['accepted', 'skipped', 'returnUpstream', 'needsInput', 'exhausted']),
  authoredRevision: z.number().int().positive(),
  /**
   * The accepted changed documents, including explicitly reused assets on a skip, with the revision that
   * produced them when one was observed. The parent's documentation handoff publishes exactly this
   * set; the broader output references below stay available to consumers that need every artifact.
   */
  documents: z.array(
    z.object({
      path: z.string().min(1),
      revision: z.string().min(1).nullable(),
    }),
  ),
  existingDocuments: z
    .array(z.object({ path: z.string().min(1), revision: z.string().min(1) }))
    .default([]),
  /**
   * Stage-owned paths outside the authoritative documents that stay on the retained preparation
   * branch for implementation reuse, relative to the shared checkout.
   */
  sourcePaths: z.array(z.string().min(1)).default([]),
  skipReferences: z.array(z.string().min(1)).default([]),
  outputs: z.array(z.object({ path: z.string().min(1) })),
  evaluation: z.object({ path: z.string().min(1) }),
  reason: z.string().nullable(),
  returnStage: z.enum(upstreamStages).nullable(),
  /** The concrete upstream problem, consequence and needed correction a return carries. */
  returnFinding: upstreamRequestSchema.nullable(),
  /**
   * The retained prototype the Storybook Refinement stage built, when it produced one: the
   * worktree branch and revision implementation tickets reference for reuse. Prototype code is not
   * an authoritative document and never enters the documentation publication.
   */
  prototype: z
    .object({ branch: z.string().min(1), revision: z.string().min(1) })
    .nullable()
    .default(null),
});

export type PreparationResult = z.infer<typeof preparationResultSchema>;

export const stageResultArtifact = {
  pathFromArtifactsRoot: 'result.json',
  schema: preparationResultSchema,
} satisfies ArtifactDeclaration<typeof preparationResultSchema>;

/** The nonempty implementation plans a stage author may produce. */
export const plannedTasksSchema = z.array(plannedTaskSchema);

/** The Architect's implementation plan, saved beside the author report when it is nonempty. */
export const stagePlanArtifact = {
  pathFromArtifactsRoot: 'plan.json',
  schema: plannedTasksSchema,
} satisfies ArtifactDeclaration<typeof plannedTasksSchema>;

/** Normalize the evaluator's reported findings into the shared saved Finding shape. */
export function toFindings(
  reported: StageEvaluationResponse['findings'],
): StageEvaluationOutput['findings'] {
  return reported.map((finding) => ({
    ...finding,
    locations: finding.locations.map(({ path, line }) =>
      line === null ? { path } : { path, line },
    ),
  }));
}

/** The most recent terminal invocation, separate from immutable completed-round history. */
export const stageTerminalDeclaration = {
  file: 'state/result.json',
  schema: preparationResultSchema,
} satisfies RecordDeclaration<typeof preparationResultSchema>;
