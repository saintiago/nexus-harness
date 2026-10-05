import { z } from 'zod';
import type { ReportScope } from '../report-feedback.js';
import { preparationStages, type PreparationStage } from '../../../configuration/index.js';
import { reportBindingFields } from '../agent-reports.js';
import type { ArtifactDeclaration } from '../artifacts.js';
import type { RecordDeclaration } from '../records.js';
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

/** One upstream return: the earlier stage to correct and the concrete correction it needs. */
export const upstreamRequestSchema = z.strictObject({
  stage: z.enum(upstreamStages).describe('The earlier stage whose input needs correction.'),
  correction: z
    .string()
    .trim()
    .min(1)
    .describe('The concrete input correction handed to the earlier stage.'),
});

export type UpstreamRequest = z.infer<typeof upstreamRequestSchema>;

/** One applicability skip the author proposes, with optional supporting evidence. */
export const skipProposalSchema = z.strictObject({
  references: z
    .array(z.string().trim().min(1))
    .describe(
      'Optional evidence supporting the inapplicability explained in the Markdown report: each reference cites a readable file in the shared checkout (a path, or a path#section citation) or an existing retained file. An unreadable reference is rejected and an empty list is valid. They stay evidence: a reference neither commits nor excludes anything from evaluation and creates no document binding.',
    ),
});

/** One reference to a saved artifact file, such as a prototype observation record or screenshot. */
export const artifactReferenceSchema = z.strictObject({
  path: z.string().trim().min(1).describe('The saved record path inside the round artifact area.'),
});

/**
 * The author's response: the minimal outcome its workflow consumes, plus the functional
 * declarations, plan, observation, skip references, question or upstream request. What was
 * authored, declaration explanations, corrections, disagreements and remaining problems belong
 * in the assigned Markdown report.
 */
export const stageAuthorResponseSchema = z.strictObject({
  outcome: z
    .enum(['authored', 'skip-proposed', 'needs-input', 'return-upstream'])
    .describe(
      'What this round did: authored the stage work, proposed an evaluated skip, needs an author decision, or returns the work to an earlier stage.',
    ),
  documents: z
    .array(authoredDocumentSchema)
    .describe(
      'The authoritative documents this revision changed. Unchanged adequate documents need no entry and may leave the array empty: the evaluator inspects the current worktree regardless of authorship, without citations.',
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
      'The Architecture author\u2019s bounded implementation tasks, nonempty for an authored or skip-proposed Architecture response; empty for every other stage and outcome.',
    ),
  skip: skipProposalSchema
    .nullable()
    .describe(
      'The applicability skip proposal, or null unless the outcome is skip-proposed. Its rationale belongs in the Markdown report; a repair round may propose an applicability skip when the corrected scope makes the stage irrelevant, and evaluation decides its applicability.',
    ),
  question: z
    .string()
    .nullable()
    .describe('The specific author decision needed, or null unless the outcome is needs-input.'),
  upstream: upstreamRequestSchema
    .nullable()
    .describe(
      'The earlier stage to correct and the concrete correction it needs, or null unless the outcome is return-upstream. The problem and consequence belong in the Markdown report.',
    ),
});

export type StageAuthorResponse = z.infer<typeof stageAuthorResponseSchema>;

/**
 * The saved author artifact: the minimal response bound to its stage, authored revision, observed
 * task/profile identity and assigned Markdown report. The action observes the identity, revision
 * and report bytes; none of it is agent output.
 */
export const stageAuthorOutputSchema = z.strictObject({
  ...stageAuthorResponseSchema.shape,
  stage: z.enum(preparationStages),
  revision: z.number().int().positive(),
  taskKey: z.string().trim().min(1).describe('The selected issue or task key this report answers.'),
  profile: z.string().trim().min(1).describe('The author profile that produced this report.'),
  role: z.literal('author'),
  ...reportBindingFields,
});

export type StageAuthorOutput = z.infer<typeof stageAuthorOutputSchema>;

/**
 * One retained combined author report from before the narrative/outcome separation: its former
 * summary, declaration explanations and skip reason stay readable as history without their removed
 * rules. Declared in the former schema's field order so a retained record's identity is reproduced
 * for its existing evaluation association, and with the current binding fields declared as absent
 * so a damaged current record never falls back to legacy parsing.
 */
const legacyStageAuthorDocumentSchema = z.strictObject({
  path: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

const legacyUpstreamRequestSchema = z.strictObject({
  stage: z.enum(upstreamStages),
  problem: z.string().trim().min(1),
  consequence: z.string().trim().min(1),
  correction: z.string().trim().min(1),
});

const legacySkipProposalSchema = z.strictObject({
  reason: z.string().trim().min(1),
  references: z.array(z.string().trim().min(1)),
});

export const legacyStageAuthorOutputSchema = z.object({
  outcome: z.enum(['authored', 'skip-proposed', 'needs-input', 'return-upstream']),
  summary: z.string().describe('The former combined narrative this report used to carry.'),
  documents: z.array(legacyStageAuthorDocumentSchema),
  sourcePaths: z.array(z.string().trim().min(1)),
  observation: artifactReferenceSchema.nullable(),
  plan: z.array(plannedTaskSchema),
  skip: legacySkipProposalSchema.nullable(),
  question: z.string().nullable(),
  upstream: legacyUpstreamRequestSchema.nullable(),
  findingResponses: z.unknown().optional(),
  stage: z.enum(preparationStages),
  revision: z.number().int().positive(),
  report: z.never().optional(),
  reportIdentity: z.never().optional(),
  invocationId: z.never().optional(),
  taskKey: z.never().optional(),
  profile: z.never().optional(),
  role: z.never().optional(),
});

export type LegacyStageAuthorOutput = z.infer<typeof legacyStageAuthorOutputSchema>;

/**
 * The producer-owned reader: a current outcome requires its report binding, while a retained
 * combined report stays readable as history. A record carrying any binding field must satisfy the
 * current schema; a damaged new record never falls back to legacy parsing.
 */
export const retainedStageAuthorOutputSchema = z.union([
  stageAuthorOutputSchema,
  legacyStageAuthorOutputSchema,
]);

export type RetainedStageAuthorOutput = z.infer<typeof retainedStageAuthorOutputSchema>;

/** True when one retained author outcome carries the current report binding. */
export function isBoundStageAuthorOutput(
  author: RetainedStageAuthorOutput,
): author is StageAuthorOutput {
  return 'report' in author;
}

export const stageAuthorArtifact = {
  pathFromArtifactsRoot: 'author.json',
  schema: retainedStageAuthorOutputSchema,
} satisfies ArtifactDeclaration<typeof retainedStageAuthorOutputSchema>;

/**
 * One former combined finding a retained evaluation may still carry: the shape the removed
 * structured finding list used, including its former stable ID. It stays readable as history and
 * no current rule reads, matches or validates it.
 */
const legacyFindingLocationSchema = z.strictObject({
  path: z.string(),
  line: z.number().int().positive().optional(),
});

const legacyFindingSchema = z.strictObject({
  id: z.string().optional(),
  title: z.string(),
  severity: z.enum(['blocking', 'non-blocking']),
  basis: z.string(),
  evidence: z.string(),
  impact: z.string(),
  repairGuidance: z.string(),
  locations: z.array(legacyFindingLocationSchema),
});

/**
 * The evaluator's response: the minimal verdict its workflow consumes, plus the applicable
 * observation reference and concrete upstream correction. The assessment, current findings,
 * verdict explanation and evidence belong in the assigned Markdown report. A skip may only be
 * accepted when the author proposed one.
 */
export const stageEvaluationResponseSchema = z.strictObject({
  verdict: z
    .enum(['accepted', 'accepted-skip', 'changes-requested', 'return-upstream'])
    .describe(
      'Accepted for authored work, accepted-skip for the author\u2019s proposed skip, ' +
        'changes-requested or return-upstream.',
    ),
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
  upstream: upstreamRequestSchema
    .nullable()
    .describe(
      'The earlier stage to correct and the concrete correction it needs, or null unless the verdict is return-upstream. The problem and consequence belong in the Markdown report.',
    ),
});

export type StageEvaluationResponse = z.infer<typeof stageEvaluationResponseSchema>;

/** Acceptance preserves the author's distinction between authored work and a proposed skip. */
export function acceptanceVerdictProblem(
  outcome: RetainedStageAuthorOutput['outcome'],
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
 * The saved evaluation artifact: the observed acceptance basis, the assessed authored revision,
 * the verdict and the evaluator's applicable observation, bound to its stage, task/profile
 * identity and assigned Markdown report. The action observes the basis, revision and report
 * bytes; none of it is agent output.
 */
export const stageEvaluationOutputSchema = z.strictObject({
  /** The exact authored report, captured input and assessed content this decision is bound to. */
  basis: acceptanceBasisSchema,
  assessedRevision: z.number().int().positive(),
  verdict: z.enum(['accepted', 'accepted-skip', 'changes-requested', 'return-upstream']),
  /** The evaluator's own saved prototype observation record the decision retains, if any. */
  observation: artifactReferenceSchema.nullable(),
  upstream: upstreamRequestSchema.nullable(),
  stage: z.enum(preparationStages),
  taskKey: z.string().trim().min(1).describe('The selected issue or task key this report answers.'),
  profile: z.string().trim().min(1).describe('The evaluator profile that produced this verdict.'),
  role: z.literal('evaluator'),
  ...reportBindingFields,
});

export type StageEvaluationOutput = z.infer<typeof stageEvaluationOutputSchema>;

/**
 * One retained combined evaluation from before the narrative/outcome separation: its former
 * reason, finding list and prior-finding dispositions stay readable as history without their
 * removed matching or consistency rules. The current binding fields are declared absent so a
 * damaged current record never falls back to legacy parsing.
 */
export const legacyStageEvaluationOutputSchema = z.object({
  basis: acceptanceBasisSchema,
  assessedRevision: z.number().int().positive(),
  verdict: z.enum(['accepted', 'accepted-skip', 'changes-requested', 'return-upstream']),
  reason: z.string().describe('The former combined assessment this report used to carry.'),
  observation: artifactReferenceSchema.nullable(),
  findings: z.array(legacyFindingSchema),
  priorFindings: z.unknown().optional(),
  upstream: legacyUpstreamRequestSchema.nullable(),
  report: z.never().optional(),
  reportIdentity: z.never().optional(),
  invocationId: z.never().optional(),
  stage: z.never().optional(),
  taskKey: z.never().optional(),
  profile: z.never().optional(),
  role: z.never().optional(),
});

export type LegacyStageEvaluationOutput = z.infer<typeof legacyStageEvaluationOutputSchema>;

/**
 * The producer-owned reader: a current verdict requires its report binding, while a retained
 * combined evaluation stays readable as history. A record carrying any binding field must satisfy
 * the current schema; a damaged new record never falls back to legacy parsing.
 */
export const retainedStageEvaluationOutputSchema = z.union([
  stageEvaluationOutputSchema,
  legacyStageEvaluationOutputSchema,
]);

export type RetainedStageEvaluationOutput = z.infer<typeof retainedStageEvaluationOutputSchema>;

/** True when one retained evaluation carries the current report binding. */
export function isBoundStageEvaluationOutput(
  evaluation: RetainedStageEvaluationOutput,
): evaluation is StageEvaluationOutput {
  return 'report' in evaluation;
}

export const stageEvaluationArtifact = {
  pathFromArtifactsRoot: 'evaluation.json',
  schema: retainedStageEvaluationOutputSchema,
} satisfies ArtifactDeclaration<typeof retainedStageEvaluationOutputSchema>;

/**
 * Why one evaluation verdict is unsupported by the report it carries, or null. The evaluator's
 * response pairs the verdict with its concrete upstream request: a return needs an earlier stage
 * and correction, and only a return carries one.
 */
export function evaluationVerdictProblem(
  verdict: StageEvaluationResponse['verdict'],
  upstream: UpstreamRequest | null,
): string | null {
  if (verdict === 'return-upstream' && upstream === null) {
    return 'a return-upstream verdict needs the earlier stage and the concrete correction';
  }
  if (upstream !== null && verdict !== 'return-upstream') {
    return 'only a return-upstream verdict carries the upstream request';
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
  /**
   * The concrete upstream correction a return carries, with the returning role's Markdown report
   * that explains its problem and consequence. Former combined results retain their problem and
   * consequence fields as history; current returns carry the report reference instead.
   */
  returnFinding: z
    .object({
      stage: z.enum(upstreamStages),
      correction: z.string().min(1),
      report: z
        .object({ path: z.string().min(1) })
        .nullable()
        .default(null),
      problem: z.string().min(1).optional(),
      consequence: z.string().min(1).optional(),
    })
    .nullable(),
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
