import { z } from 'zod';
import type { ReportScope } from '../report-feedback.js';
import { preparationStages, type PreparationStage } from '../../../configuration/index.js';
import type { ArtifactDeclaration } from '../artifacts.js';
import type { RecordDeclaration } from '../records.js';
import { reportedFindingSchema, retainedFindingSchema, type Finding } from '../review/artifacts.js';
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
export const authoredDocumentSchema = z.strictObject({
  path: z.string().trim().min(1).describe('The document path inside the shared checkout.'),
  description: z.string().trim().min(1).describe('Why this document changed.'),
});

/** One bounded implementation task the Architect planned. */
export const plannedTaskSchema = z.strictObject({
  summary: z.string().trim().min(1).describe('The task in one short line.'),
  scope: z.string().trim().min(1).describe('What the task covers and what it leaves out.'),
  completionCriteria: z
    .array(z.string().trim().min(1))
    .min(1)
    .describe('The observable results that make the task complete.'),
  prerequisites: z
    .array(z.number().int().nonnegative())
    .describe('The zero-based indexes of the earlier tasks in this plan that must finish first.'),
});

export type PlannedTask = z.infer<typeof plannedTaskSchema>;

/** One upstream return: the problematic input, its consequence and the correction needed. */
export const upstreamRequestSchema = z.strictObject({
  stage: z.enum(upstreamStages).describe('The earlier stage whose input needs correction.'),
  problem: z.string().trim().min(1).describe('The problematic input.'),
  consequence: z.string().trim().min(1).describe('What the input prevents or contradicts.'),
  correction: z.string().trim().min(1).describe('The concrete correction that is needed.'),
});

export type UpstreamRequest = z.infer<typeof upstreamRequestSchema>;

/** One applicability skip the author proposes, with an optional reason and optional evidence. */
export const skipProposalSchema = z.strictObject({
  reason: z.string().trim().min(1).describe('Why the stage is irrelevant.'),
  references: z
    .array(z.string().trim().min(1))
    .describe(
      'Optional evidence supporting the reason: each reference cites a readable file in the shared checkout (a path, or a path#section citation) or an existing retained file. Explanations belong in reason; an unreadable reference is rejected and an empty list is valid. They stay evidence: a reference neither commits nor excludes anything from evaluation and creates no document binding.',
    ),
});

/** One reference to a saved artifact file, such as a prototype observation record or screenshot. */
export const artifactReferenceSchema = z.strictObject({
  path: z.string().trim().min(1).describe('The saved record path inside the round artifact area.'),
});

/**
 * The author's report: the proposal or revision plus its documents, skip proposal, question or
 * upstream request. Repairs, disagreements and remaining problems belong in the narrative summary.
 */
export const stageAuthorResponseSchema = z.strictObject({
  outcome: z
    .enum(['authored', 'skip-proposed', 'needs-input', 'return-upstream'])
    .describe(
      'What this round did: authored the stage work, proposed an evaluated skip, needs an author decision, or returns the work to an earlier stage.',
    ),
  summary: z.string().describe('What was authored, proposed or found, in one short account.'),
  documents: z
    .array(authoredDocumentSchema)
    .describe(
      'The authoritative documents this revision changed, each with why it changed. Unchanged adequate documents need no entry: the evaluator inspects the current worktree regardless of authorship.',
    ),
  /**
   * Additional non-document paths the stage owns and commits in the shared checkout, such as the
   * prototype's Storybook stories. They are stage-owned work, never authoritative documents.
   */
  sourcePaths: z
    .array(z.string().trim().min(1))
    .describe(
      'Additional stage-owned authored files this revision commits in the shared checkout, such as Storybook sources. Never files that were merely read, and empty unless the outcome is authored.',
    ),
  /**
   * The Storybook Refinement author's saved prototype observation record, or null for every other
   * stage and outcome. The record is validated against the producer-owned observation contract
   * before the round can be evaluated; an applicable prototype cannot be accepted without it.
   */
  observation: artifactReferenceSchema
    .nullable()
    .describe(
      'The Storybook Refinement author\u2019s own saved browser observation record inside the round artifact area, or null. Only authored prototype work declares one.',
    ),
  plan: z
    .array(plannedTaskSchema)
    .describe(
      'The Architecture author\u2019s bounded implementation tasks, nonempty for an authored or skip-proposed Architecture report even when an existing adequate design permits the skip; empty for every other stage and outcome.',
    ),
  skip: skipProposalSchema
    .nullable()
    .describe(
      'The applicability skip proposal, or null unless the outcome is skip-proposed. A revision round cannot propose a skip.',
    ),
  question: z
    .string()
    .nullable()
    .describe('The specific author decision needed, or null unless the outcome is needs-input.'),
  upstream: upstreamRequestSchema
    .nullable()
    .describe(
      'The problematic input, its consequence and the required correction, or null unless the outcome is return-upstream.',
    ),
});

export type StageAuthorResponse = z.infer<typeof stageAuthorResponseSchema>;

/**
 * The saved author artifact: the report bound to the stage and its authored revision. The
 * producer-owned reader preserves a former finding-response array as retained data without
 * validating or answering it.
 */
export const stageAuthorOutputSchema = z.object({
  ...stageAuthorResponseSchema.shape,
  findingResponses: z.unknown().optional(),
  stage: z.enum(preparationStages),
  revision: z.number().int().positive(),
});

export type StageAuthorOutput = z.infer<typeof stageAuthorOutputSchema>;

export const stageAuthorArtifact = {
  pathFromArtifactsRoot: 'author.json',
  schema: stageAuthorOutputSchema,
} satisfies ArtifactDeclaration<typeof stageAuthorOutputSchema>;

/**
 * The evaluator's report: the exact revision it assessed, its verdict, the findings present in
 * that revision and any upstream request. A skip may only be accepted when the author proposed
 * one.
 */
export const stageEvaluationResponseSchema = z.strictObject({
  assessedRevision: z
    .number()
    .int()
    .positive()
    .describe('The authored revision number this decision assesses.'),
  verdict: z
    .enum(['accepted', 'accepted-skip', 'changes-requested', 'return-upstream'])
    .describe(
      'Accepted for authored work, accepted-skip for the author\u2019s proposed skip, ' +
        'changes-requested or return-upstream.',
    ),
  reason: z.string().describe('Why the evidence and current findings support this verdict.'),
  /**
   * The Storybook Refinement evaluator's own saved prototype observation record, or null for every
   * other stage and for an evaluated applicability skip. Accepting applicable prototype work
   * requires it; a change request or upstream return retains it when the evaluator performed a
   * preview, so the observed defect evidence reaches the repair handoff.
   */
  observation: artifactReferenceSchema
    .nullable()
    .describe(
      'The Storybook Refinement evaluator\u2019s own saved browser observation record inside the round artifact area, or null. Accepting applicable prototype work needs it; an evaluated applicability skip carries none.',
    ),
  findings: z
    .array(reportedFindingSchema)
    .describe('The findings present in the assessed revision, including newly discovered ones.'),
  upstream: upstreamRequestSchema
    .nullable()
    .describe(
      'The problematic input, its consequence and the required correction, or null unless the verdict is return-upstream.',
    ),
});

export type StageEvaluationResponse = z.infer<typeof stageEvaluationResponseSchema>;

/** Acceptance preserves the author's distinction between authored work and a proposed skip. */
export function acceptanceVerdictProblem(
  outcome: StageAuthorOutput['outcome'],
  verdict: StageEvaluationResponse['verdict'],
): string | null {
  if (verdict === 'accepted-skip' && outcome !== 'skip-proposed') {
    return 'the evaluator accepted a skip the author did not propose';
  }
  if (verdict === 'accepted' && outcome !== 'authored') {
    return outcome === 'skip-proposed'
      ? 'accepting a skip proposal requires an accepted-skip verdict'
      : 'an accepted verdict requires authored work';
  }
  return null;
}

/** One repository path the evaluator assessed or relied on: its observed revision and existence. */
export const assessedContentSchema = z.strictObject({
  /** The canonical checkout-relative path of the assessed repository content. */
  path: z.string().min(1).describe('The canonical checkout-relative path of the assessed content.'),
  /** The revision at which the content was observed; it must stay readable while retained. */
  revision: z.string().min(1).describe('The revision the content was observed at.'),
  /** False when the assessed revision deletes the path; a deletion is retained, not replaced. */
  exists: z.boolean().describe('False when the assessed revision deletes the path.'),
});

export type AssessedContent = z.infer<typeof assessedContentSchema>;

/**
 * The evaluation's acceptance basis, observed by the stage action rather than trusted from an
 * agent: the complete authored report, the captured source input, the relied-on upstream results,
 * the repository revision the evaluation observed and the applicable prototype content it
 * assessed. A changed author report or captured input needs a current evaluator decision; later
 * document edits below the same finalization do not bind it. Document stages keep `content`
 * empty: they write no per-document bindings, and completed verdicts are not compared with
 * historical file revisions.
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
  /** The commit revision the action observed for the evaluation; absent on former saved records. */
  repositoryRevision: z.string().min(1).optional(),
  content: z.array(assessedContentSchema),
});

export type AcceptanceBasis = z.infer<typeof acceptanceBasisSchema>;

/**
 * The saved evaluation artifact: reported findings with their absent lines normalized away. The
 * producer-owned reader preserves former finding IDs and dispositions as retained data without
 * matching or validating them, and rejects a report whose verdict contradicts its current
 * findings or upstream request, so continuation and downstream consumers see a consistent record.
 */
export const stageEvaluationOutputSchema = z
  .object({
    /** The exact authored report, captured input and assessed content this decision is bound to. */
    basis: acceptanceBasisSchema,
    assessedRevision: z.number().int().positive(),
    verdict: z.enum(['accepted', 'accepted-skip', 'changes-requested', 'return-upstream']),
    reason: z.string(),
    /** The evaluator's own saved prototype observation record the decision retains, if any. */
    observation: artifactReferenceSchema.nullable(),
    findings: z.array(retainedFindingSchema),
    priorFindings: z.unknown().optional(),
    upstream: upstreamRequestSchema.nullable(),
  })
  .superRefine((evaluation, context) => {
    const problem = evaluationVerdictProblem(
      evaluation.verdict,
      evaluation.findings,
      evaluation.upstream,
    );
    if (problem !== null) {
      context.addIssue({ code: 'custom', path: ['verdict'], message: problem });
    }
  });

export type StageEvaluationOutput = z.infer<typeof stageEvaluationOutputSchema>;

export const stageEvaluationArtifact = {
  pathFromArtifactsRoot: 'evaluation.json',
  schema: stageEvaluationOutputSchema,
} satisfies ArtifactDeclaration<typeof stageEvaluationOutputSchema>;

/**
 * Why one evaluation verdict is unsupported by the report it carries, or null. The evaluator's
 * response and a retained saved evaluation state a verdict their current findings and upstream
 * request support.
 */
export function evaluationVerdictProblem(
  verdict: StageEvaluationOutput['verdict'],
  findings: readonly { readonly severity: Finding['severity'] }[],
  upstream: UpstreamRequest | null,
): string | null {
  if (verdict === 'return-upstream' && upstream === null) {
    return 'a return-upstream verdict needs the problematic input, consequence and correction';
  }
  if (upstream !== null && verdict !== 'return-upstream') {
    return 'only a return-upstream verdict carries the upstream request';
  }
  const blockingCount = findings.filter((finding) => finding.severity === 'blocking').length;
  if ((verdict === 'accepted' || verdict === 'accepted-skip') && blockingCount > 0) {
    return 'the report accepts the revision while reporting a blocking finding';
  }
  if (verdict === 'changes-requested' && blockingCount === 0) {
    return 'a changes-requested verdict needs at least one current blocking finding';
  }
  return null;
}

/** The terminal result the parent publication reads and the child returns a reference to. */
export const preparationResultSchema = z.object({
  stage: z.enum(preparationStages),
  outcome: z.enum(['accepted', 'skipped', 'returnUpstream', 'needsInput', 'exhausted']),
  authoredRevision: z.number().int().positive(),
  /**
   * The changed authoritative documents this stage currently accepted with the revision that
   * produced them. An accepted submission may change nothing, and an evaluated skip never adds
   * documents: unchanged adequate documents need no citation and are not inferred from earlier
   * results. The parent's implementation handoff references exactly this set; the broader outputs
   * below stay available to consumers that need every artifact.
   */
  documents: z.array(
    z.object({
      path: z.string().min(1),
      revision: z.string().min(1).nullable(),
    }),
  ),
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
   * an authoritative document and never enters ticket admission as one.
   */
  prototype: z
    .object({ branch: z.string().min(1), revision: z.string().min(1) })
    .nullable()
    .default(null),
  /**
   * The prototype author's and evaluator's retained observation records, in role order. They stay
   * empty for every other stage, for an evaluated applicability skip and for a prototype result
   * that retained no evidence.
   */
  prototypeObservations: z
    .array(z.object({ role: z.enum(['author', 'evaluator']), path: z.string().min(1) }))
    .default([]),
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

/**
 * The report-feedback scope of one preparation stage's author or evaluator responsibility. The
 * area is the stage's own artifact area, so feedback never crosses stages, issues or roles.
 */
export function stageReportScope(settings: {
  readonly project: string;
  readonly workId: string;
  readonly area: string;
  readonly stage: PreparationStage;
  readonly role: 'author' | 'evaluator';
}): ReportScope {
  return {
    project: settings.project,
    workId: settings.workId,
    area: settings.area,
    role: `${settings.stage}-${settings.role}`,
    reportKind: settings.role === 'author' ? 'stage-author' : 'stage-evaluation',
  };
}
