import type { JevClient, JevData, JevJson, JevRequest, JevResult } from '@saintiago/jev';
import { JevError } from '@saintiago/jev';
import path from 'node:path';
import { z } from 'zod';
import type { GitAdapter } from '../../../adapters/git.js';
import { preparationRoleInstructions } from '../../../agent-runtime/index.js';
import { preparationStages, type PreparationStage } from '../../../configuration/index.js';
import { messageOf, type ArtifactRef } from '../../../result.js';
import { readBoundReport } from '../agent-reports.js';
import { readDocumentText, writeDocumentCompletely } from '../documents.js';
import { checkoutRelative, sourceInputIdentity } from './evaluation-content.js';
import { readRecord } from '../records.js';
import { projectOfWorkspace, recordIdentity } from '../report-feedback.js';
import type { Selection } from '../select-task/artifacts.js';
import {
  isBoundStageAuthorOutput,
  stageEvaluationReportText,
  type RetainedStageAuthorOutput,
  type RetainedStageEvaluationOutput,
  type StageRoundPlan,
} from './artifacts.js';
import { activeEvaluation, readParentHandoff } from './context.js';
import {
  readPreparationWorkspace,
  readUpstreamResults,
  roundArtifactDirectory,
  upstreamResultReferences,
} from './storage.js';

/**
 * Preparation's JEv applicability advice: StageAuthor's pre-invocation boundary supplies one
 * bounded applicability question, interprets the returned judgment with Nexus's conservative
 * policy and retains the attributable record under the stage's round artifact area. The delivered
 * package owns the provider request, schemas, transport and errors; this module owns the evidence
 * Nexus supplies, the fixed question, the decision and the retained record. It routes nothing and
 * grants no acceptance: every submission still runs the stage author and its independent evaluator.
 */

/** The fixed policy version that authorizes the boundary and fixes its question and thresholds. */
export const applicabilityPolicy = 'jev-v1';

/**
 * The optional JEv capability Application constructs: the public client restricted to `evaluate`,
 * or the unavailability category. `null` is a disabled or omitted integration.
 */
export type StageApplicabilityCapability =
  | { readonly kind: 'available'; readonly client: JevClient }
  | { readonly kind: 'missing-credential' }
  | { readonly kind: 'unavailable' };

/** The conservative advisory cutoffs a successful inapplicable judgment must reach. */
export const applicabilityThresholds = { probability: 0.9, confidence: 0.9 } as const;

/** The one choice question every applicability request asks, fixed by the policy version. */
export const applicabilityQuestion = {
  instructions: [
    'Judge whether the requested outcome needs this preparation stage’s own responsibility.',
    'Answer for this stage only; do not decide later stages, whose accepted inputs do not yet',
    'exist. Preserve explicit human scope and mandatory assessments.',
  ].join(' '),
  criteria: {
    applicable:
      'The requested outcome needs this stage’s responsibility, including independent assessment of adequate existing documents.',
    inapplicable:
      'This stage’s responsibility is outside the requested outcome; absence of new document edits alone does not establish this.',
    uncertain:
      'The available evidence is incomplete, contradictory or cannot establish applicability.',
  },
} as const;

/** Build the package request for one evidence state: the policy's single choice question. */
export function applicabilityRequest(state: JevData): JevRequest {
  return {
    state,
    questions: {
      stage_applicability: {
        type: 'choice',
        instructions: applicabilityQuestion.instructions,
        criteria: { ...applicabilityQuestion.criteria },
      },
    },
  };
}

const applicabilityQuestionSchema = z.strictObject({
  name: z.literal('stage_applicability'),
  instructions: z.string().trim().min(1),
  criteria: z.strictObject({
    applicable: z.string().trim().min(1),
    inapplicable: z.string().trim().min(1),
    uncertain: z.string().trim().min(1),
  }),
});

/**
 * What the boundary learned from the optional provider call: the package's returned judgment as
 * Nexus's own projection, a safe failure category, or the reason no request was made. No provider
 * explanation, thrown message or raw response body is retained.
 */
export const applicabilityJudgmentSchema = z.union([
  z.strictObject({
    kind: z.literal('answered'),
    model: z.string().trim().min(1),
    choice: z.string().trim().min(1),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.strictObject({
    kind: z.literal('failed'),
    category: z.string().trim().min(1),
    status: z.number().int().optional(),
  }),
  z.strictObject({ kind: z.literal('not-requested'), reason: z.string().trim().min(1) }),
]);

export type ApplicabilityJudgment = z.infer<typeof applicabilityJudgmentSchema>;

/** The observed basis the advice was taken against: identities and control values, no secrets. */
export const applicabilityBasisSchema = z.strictObject({
  sourceIdentity: z.string().min(1),
  upstream: z.array(z.strictObject({ result: z.string().min(1), identity: z.string().min(1) })),
  repository: z.strictObject({
    project: z.string().min(1),
    repository: z.string().min(1).nullable(),
    branch: z.string().min(1).nullable(),
    revision: z.string().min(1).nullable(),
  }),
  route: z.enum(['new', 'next', 'reassess']),
  task: z.enum(['propose', 'respond']),
  corrections: z.strictObject({
    pendingFeedback: z.boolean(),
    pendingReturn: z.boolean(),
    humanQuestion: z.boolean(),
    activeEvaluation: z.boolean(),
  }),
});

export type ApplicabilityBasis = z.infer<typeof applicabilityBasisSchema>;

/** One retained applicability advice record: basis, supplied evidence, judgment and decision. */
export const applicabilityRecordSchema = z.strictObject({
  kind: z.literal('jev-applicability-advice'),
  policy: z.literal(applicabilityPolicy),
  stage: z.enum(preparationStages),
  taskKey: z.string().trim().min(1),
  round: z.number().int().positive(),
  basisIdentity: z.string().trim().min(1),
  basis: applicabilityBasisSchema,
  question: applicabilityQuestionSchema,
  evidence: z.strictObject({ state: z.json().nullable() }),
  judgment: applicabilityJudgmentSchema,
  decision: z.enum(['consider-skip', 'full-path']),
  reason: z.string().trim().min(1),
});

export type ApplicabilityRecord = z.infer<typeof applicabilityRecordSchema>;

/** One stage round's applicability record directory. */
export function applicabilityDirectory(stageRoot: string, round: number): string {
  return path.join(roundArtifactDirectory(stageRoot, round), 'applicability');
}

/** One basis's immutable applicability record file. */
export function applicabilityRecordFile(
  stageRoot: string,
  round: number,
  basisIdentity: string,
): string {
  return path.join(applicabilityDirectory(stageRoot, round), `${basisIdentity}.json`);
}

/**
 * The deterministic identity of one advisory request: the nonsecret basis, the fixed
 * question/criteria, the policy version and the enabled setting. The host key's presence and
 * value are excluded, so restoring a credential cannot replace a retained fallback for unchanged
 * inputs. It identifies the advisory request, never stage acceptance.
 */
export function applicabilityBasisIdentity(basis: ApplicabilityBasis): string {
  return recordIdentity({
    policy: applicabilityPolicy,
    enabled: true,
    basis,
    question: applicabilityQuestion,
  });
}

/**
 * Read one declared applicability record and validate its association and self-identity, or null
 * when the file does not exist. Invalid content, a foreign stage/task/round or a mismatched
 * identity is an error; callers preserve it as the owner's rejection evidence instead of minting a
 * replacement judgment.
 */
export async function readStageApplicabilityRecord(settings: {
  readonly declared: ArtifactRef;
  readonly stageRoot: string;
  readonly stage: PreparationStage;
  readonly taskKey: string;
  readonly round: number;
}): Promise<ApplicabilityRecord | null> {
  const { declared } = settings;
  const directory = applicabilityDirectory(settings.stageRoot, settings.round);
  const relative = path.relative(directory, path.resolve(declared.path));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `The declared applicability record "${declared.path}" is not inside the round's ` +
        'applicability area.',
    );
  }
  const record = await readRecord(declared.path, {
    file: path.basename(declared.path),
    schema: applicabilityRecordSchema,
  });
  if (record === null) {
    return null;
  }
  if (
    record.stage !== settings.stage ||
    record.taskKey !== settings.taskKey ||
    record.round !== settings.round
  ) {
    throw new Error(
      `The applicability record "${declared.path}" belongs to another stage, task or round.`,
    );
  }
  if (relative !== `${record.basisIdentity}.json`) {
    throw new Error(
      `The applicability record "${declared.path}" does not name its own basis identity.`,
    );
  }
  if (applicabilityBasisIdentity(record.basis) !== record.basisIdentity) {
    throw new Error(
      `The applicability record "${declared.path}" does not reproduce its recorded basis.`,
    );
  }
  return record;
}

/** Persist one applicability record completely under its basis identity. */
export async function writeStageApplicabilityRecord(settings: {
  readonly stageRoot: string;
  readonly round: number;
  readonly record: ApplicabilityRecord;
}): Promise<ArtifactRef> {
  const file = applicabilityRecordFile(
    settings.stageRoot,
    settings.round,
    settings.record.basisIdentity,
  );
  await writeDocumentCompletely(file, `${JSON.stringify(settings.record, null, 2)}\n`);
  return { path: file };
}

/** The provider's returned judgment as the owned projection. */
function answeredJudgment(result: JevResult): ApplicabilityJudgment {
  const answer = result.answers.stage_applicability;
  if (answer === undefined || answer.type !== 'choice') {
    return { kind: 'failed', category: 'unavailable' };
  }
  return {
    kind: 'answered',
    model: result.model,
    choice: answer.choice,
    probabilities: { ...answer.probabilities },
    confidence: answer.confidence,
  };
}

/** The safe failure projection of one optional-call error: category and HTTP status only. */
function failedJudgment(error: unknown): ApplicabilityJudgment {
  if (error instanceof JevError) {
    return {
      kind: 'failed',
      category: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return { kind: 'failed', category: 'unavailable' };
}

/** The Nexus decision and policy reason for one judgment, before any role assessment. */
export function applicabilityDecision(judgment: ApplicabilityJudgment): {
  readonly decision: ApplicabilityRecord['decision'];
  readonly reason: string;
} {
  if (judgment.kind === 'failed') {
    return {
      decision: 'full-path',
      reason: `the JEv call failed with a ${judgment.category} category; the full path applies`,
    };
  }
  if (judgment.kind === 'not-requested') {
    return {
      decision: 'full-path',
      reason: `no JEv request was made: ${judgment.reason}`,
    };
  }
  if (judgment.choice === 'applicable') {
    return {
      decision: 'full-path',
      reason: 'the provider judged this stage applicable to the requested outcome',
    };
  }
  if (judgment.choice === 'uncertain') {
    return {
      decision: 'full-path',
      reason: 'the provider was uncertain whether the requested outcome needs this stage',
    };
  }
  if (judgment.choice !== 'inapplicable') {
    return {
      decision: 'full-path',
      reason: `the provider chose the unsupported "${judgment.choice}" label`,
    };
  }
  const probability = judgment.probabilities.inapplicable;
  if (
    probability === undefined ||
    probability < applicabilityThresholds.probability ||
    judgment.confidence < applicabilityThresholds.confidence
  ) {
    return {
      decision: 'full-path',
      reason:
        'the provider’s inapplicable judgment is below the advisory probability or confidence ' +
        'threshold; the full path applies',
    };
  }
  return {
    decision: 'consider-skip',
    reason:
      'the provider judged this stage inapplicable above the advisory thresholds; the author may ' +
      'consider a skip, which independent evaluation must still accept',
  };
}

/** The retained advice one stage role receives: its record reference and policy statement. */
export type StageApplicabilityAdvice = {
  readonly record: ArtifactRef;
  readonly decision: ApplicabilityRecord['decision'];
  readonly reason: string;
  readonly judgment: ApplicabilityJudgment;
};

/** One retained record as the advice a stage role receives. */
export function applicabilityAdviceOf(
  record: ApplicabilityRecord,
  recordFile: string,
): StageApplicabilityAdvice {
  return {
    record: { path: recordFile },
    decision: record.decision,
    reason: record.reason,
    judgment: record.judgment,
  };
}

/**
 * The readable applicability section one stage role receives: the record reference, the Nexus
 * decision and reason, the judgment or fallback, and what the role owes it. Advisory evidence,
 * never stage acceptance.
 */
export function applicabilityAdviceText(
  advice: StageApplicabilityAdvice,
  role: 'author' | 'evaluator',
): string {
  const { judgment } = advice;
  const provider =
    judgment.kind === 'answered'
      ? `the model ${judgment.model} chose "${judgment.choice}" ` +
        `(probabilities ${JSON.stringify(judgment.probabilities)}, confidence ` +
        `${String(judgment.confidence)})`
      : judgment.kind === 'failed'
        ? `the provider call failed with the ${judgment.category} category` +
          (judgment.status === undefined ? '' : ` (HTTP ${String(judgment.status)})`)
        : `no provider request was made: ${judgment.reason}`;
  return [
    `JEv applicability advice (policy ${applicabilityPolicy}; Nexus-owned advisory evidence, never ` +
      'stage acceptance):',
    `- Retained record: ${advice.record.path}`,
    `- Nexus decision: ${advice.decision}; reason: ${advice.reason}.`,
    `- Provider judgment: ${provider}.`,
    role === 'author'
      ? 'Check this advice against the captured intent and the current repository evidence before ' +
        'proposing work or a skip: a known contradiction or explicit obligation defeats it, and any ' +
        'disagreement belongs in the assigned Markdown report. A proposed skip still needs the ' +
        'evaluator’s independent current-revision decision.'
      : 'Judge the current revision and the author’s proposal yourself against the captured intent; ' +
        'the recorded advice neither authorizes a skip nor replaces the independent assessment, and ' +
        'its exact evidence is readable at the retained record.',
  ].join('\n');
}

/** One workspace file's text as explicit evidence, or null when it is not readable there. */
async function fileEvidence(
  worktree: string,
  declared: string,
): Promise<{ readonly relative: string; readonly content: string | null } | null> {
  const relative = checkoutRelative(worktree, declared);
  if (relative === null) {
    return null;
  }
  return { relative, content: await readDocumentText(path.join(worktree, relative), 'Document') };
}

/** The upstream evidence one request supplies, read from the current checkout and reports. */
async function upstreamState(settings: {
  readonly selection: Selection;
  readonly stage: PreparationStage;
  readonly worktree: string;
  readonly missing: string[];
}): Promise<JevJson> {
  const readings = await readUpstreamResults({
    issueRoot: settings.selection.workspace.root,
    workId: settings.selection.taskKey,
    stage: settings.stage,
  });
  const upstream: JevJson[] = [];
  for (const reading of readings) {
    if (reading.stage === 'idea') {
      const handoff = await readDocumentText(reading.resultFile, 'Approved idea handoff');
      if (handoff === null) {
        settings.missing.push('the approved idea refinement handoff is absent');
      }
      upstream.push({ stage: 'idea', handoff });
      continue;
    }
    const documents: JevJson[] = [];
    for (const document of reading.author?.documents ?? []) {
      const evidence = await fileEvidence(settings.worktree, document.path);
      if (evidence === null) {
        settings.missing.push(
          `the ${reading.stage} document "${document.path}" lies outside the checkout`,
        );
        documents.push({ path: document.path, content: null });
        continue;
      }
      if (evidence.content === null) {
        settings.missing.push(
          `the ${reading.stage} document "${evidence.relative}" is absent from the checkout`,
        );
      }
      documents.push({ path: evidence.relative, content: evidence.content });
    }
    const authorReport =
      reading.author !== null && isBoundStageAuthorOutput(reading.author)
        ? (await readBoundReport(reading.author, 'Stage author report')).text
        : null;
    upstream.push({
      stage: reading.stage,
      result: (reading.result ?? null) as JevJson,
      authorReport,
      evaluationReport:
        reading.evaluation === null ? null : await stageEvaluationReportText(reading.evaluation),
      documents,
    });
  }
  return upstream;
}

/** The evidence snapshot one applicability request supplies, with explicit gaps. */
async function applicabilityState(settings: {
  readonly selection: Selection;
  readonly stage: PreparationStage;
  readonly worktree: string;
  readonly repository: ApplicabilityBasis['repository'];
  readonly baseRevision: string | null;
  readonly changedPaths: readonly string[] | null;
}): Promise<JevData> {
  const missing: string[] = [];
  const instructions = await readDocumentText(
    path.join(settings.worktree, 'AGENTS.md'),
    'Repository instructions',
  );
  if (instructions === null) {
    missing.push('the repository root instruction file is absent');
  }
  if (settings.baseRevision === null || settings.changedPaths === null) {
    missing.push('the preparation base revision or its changed paths are unavailable');
  }
  return {
    stage: {
      name: settings.stage,
      responsibility: preparationRoleInstructions[`${settings.stage}-author`].join('\n'),
    },
    task: settings.selection.task as JevJson,
    conversation: settings.selection.conversation as JevJson,
    upstream: await upstreamState({
      selection: settings.selection,
      stage: settings.stage,
      worktree: settings.worktree,
      missing,
    }),
    repository: { ...settings.repository, baseRevision: settings.baseRevision },
    changedPaths: settings.changedPaths === null ? null : [...settings.changedPaths],
    instructions: { root: instructions },
    missing,
  };
}

/**
 * True when the captured source supplies at least one scope input. With no captured task content
 * and no attributed conversation, Nexus cannot establish applicability and falls back instead of
 * asking the provider to guess.
 */
function capturedScopeAvailable(selection: Selection): boolean {
  const task = selection.task;
  if (typeof task === 'string' ? task.trim() !== '' : Object.keys(task ?? {}).length > 0) {
    return true;
  }
  return selection.conversation.length > 0;
}

/** Why this round makes no provider request, or null when the boundary may ask. */
function applicabilityGuard(
  settings: ApplicabilityBoundarySettings,
  repository: { readonly revision: string | null; readonly trackedChanges: boolean },
  corrections: ApplicabilityBasis['corrections'],
): string | null {
  if (settings.stage === 'requirements') {
    return 'Requirements always assesses requirements; the full path applies';
  }
  if (settings.stage === 'architecture') {
    return 'Architecture always submits its evaluated implementation plan; the full path applies';
  }
  if (settings.task !== 'propose' || settings.plan.route !== 'new') {
    return 'this round repairs or reassesses earlier work; the full path applies';
  }
  if (
    corrections.pendingFeedback ||
    corrections.pendingReturn ||
    corrections.humanQuestion ||
    corrections.activeEvaluation
  ) {
    return 'the stage has a pending correction or unresolved evaluation concern; the full path applies';
  }
  if (repository.trackedChanges) {
    return (
      'the checkout has uncommitted tracked changes, so its revision cannot identify the advice ' +
      'context; the full path applies'
    );
  }
  if (repository.revision === null) {
    return 'the checkout has no revision identifying the advice context; the full path applies';
  }
  return null;
}

/** Why an enabled integration supplies no provider request. */
function capabilityReason(capability: StageApplicabilityCapability): string {
  return capability.kind === 'missing-credential'
    ? 'the configured JEv credential has no value in the host environment'
    : 'the constructed JEv capability is unavailable';
}

/** What StageAuthor observes before the optional applicability request. */
export type ApplicabilityBoundarySettings = {
  readonly stage: PreparationStage;
  readonly task: 'propose' | 'respond';
  readonly selection: Selection;
  readonly plan: StageRoundPlan;
  readonly stageRoot: string;
  readonly worktree: string;
  readonly git: GitAdapter;
  /** The capability Application constructed, or null for a disabled or omitted integration. */
  readonly capability: StageApplicabilityCapability | null;
  /** The author outcome already saved for this round, when this invocation is a replay. */
  readonly retainedAuthor: RetainedStageAuthorOutput | null;
  /** The most recent preceding evaluation, which an unresolved concern is resolved from. */
  readonly precedingEvaluation: RetainedStageEvaluationOutput | null;
  /** Whether this stage's author carries a pending validation error. */
  readonly pendingFeedback: boolean;
  /** Re-read the inputs that can change while the provider call runs. */
  readonly recheck: () => Promise<{
    readonly sourceIdentity: string;
    readonly revision: string | null;
    readonly trackedChanges: boolean;
  }>;
  /** Preserve an unusable record as the owner's rejection evidence, then fail. */
  readonly rejectUnusable: (settings: {
    readonly file: string;
    readonly error: Error;
  }) => Promise<never>;
};

/** Read one record by path, handing its failure to the owner's rejection path. */
async function readRetainedAdvice(settings: {
  readonly boundary: ApplicabilityBoundarySettings;
  readonly file: string;
}): Promise<StageApplicabilityAdvice | null> {
  try {
    const record = await readStageApplicabilityRecord({
      declared: { path: settings.file },
      stageRoot: settings.boundary.stageRoot,
      stage: settings.boundary.stage,
      taskKey: settings.boundary.selection.taskKey,
      round: settings.boundary.plan.round,
    });
    return record === null ? null : applicabilityAdviceOf(record, settings.file);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(messageOf(error));
    return await settings.boundary.rejectUnusable({ file: settings.file, error: failure });
  }
}

/** The declared applicability reference of a current author outcome, or null. */
function declaredApplicability(author: RetainedStageAuthorOutput): ArtifactRef | null {
  return isBoundStageAuthorOutput(author) ? (author.applicability ?? null) : null;
}

/**
 * StageAuthor's applicability boundary: after the required source, upstream and correction
 * context is validated and before the role runs, retain or reuse one advisory record for the
 * current basis. Only an uncorrected new UX or prototype round of an enabled integration asks the
 * provider; every other case retains a deterministic full-path record without a request. The
 * record is saved before the author runs, so an interruption reuses it for the same basis.
 */
export async function stageApplicabilityAdvice(
  settings: ApplicabilityBoundarySettings,
): Promise<StageApplicabilityAdvice | null> {
  if (settings.plan.applicabilityPolicy !== applicabilityPolicy) {
    return null;
  }
  if (settings.capability === null) {
    return null;
  }
  // A saved author outcome continues the existing replay: its declared record is reused, or the
  // round ran without advice, and no new request is made.
  if (settings.retainedAuthor !== null) {
    const declared = declaredApplicability(settings.retainedAuthor);
    return declared === null
      ? null
      : await readRetainedAdvice({ boundary: settings, file: declared.path });
  }
  const inspection = await settings.git.inspectRepository(settings.worktree);
  if (!inspection.ok) {
    throw new Error(inspection.fault.message);
  }
  const handoff = await readParentHandoff(settings.selection);
  const corrections: ApplicabilityBasis['corrections'] = {
    pendingFeedback: settings.pendingFeedback,
    pendingReturn:
      handoff?.return !== null &&
      handoff?.return !== undefined &&
      handoff.return.to === settings.stage,
    humanQuestion: handoff?.feedback?.stage === settings.stage,
    activeEvaluation:
      settings.precedingEvaluation !== null &&
      activeEvaluation(settings.precedingEvaluation, handoff, settings.stage),
  };
  const prepared = await readPreparationWorkspace(settings.selection.workspace.root);
  const upstream = await upstreamResultReferences(
    settings.selection.workspace.root,
    settings.stage,
  );
  const basis: ApplicabilityBasis = {
    sourceIdentity: sourceInputIdentity(settings.selection),
    upstream: upstream.map((reference) => ({
      result: reference.resultFile,
      identity: reference.identity,
    })),
    repository: {
      project: projectOfWorkspace(settings.selection.workspace.root),
      repository: prepared?.repository ?? null,
      branch: inspection.value.branch,
      revision: inspection.value.headRevision,
    },
    route: settings.plan.route,
    task: settings.task,
    corrections,
  };
  const basisIdentity = applicabilityBasisIdentity(basis);
  const retained = await readRetainedAdvice({
    boundary: settings,
    file: applicabilityRecordFile(settings.stageRoot, settings.plan.round, basisIdentity),
  });
  if (retained !== null) {
    return retained;
  }
  const guard = applicabilityGuard(
    settings,
    { revision: inspection.value.headRevision, trackedChanges: inspection.value.trackedChanges },
    corrections,
  );
  const retain = async (judgment: ApplicabilityJudgment): Promise<StageApplicabilityAdvice> => {
    const decision = applicabilityDecision(judgment);
    const record: ApplicabilityRecord = {
      kind: 'jev-applicability-advice',
      policy: applicabilityPolicy,
      stage: settings.stage,
      taskKey: settings.selection.taskKey,
      round: settings.plan.round,
      basisIdentity,
      basis,
      question: {
        name: 'stage_applicability',
        instructions: applicabilityQuestion.instructions,
        criteria: { ...applicabilityQuestion.criteria },
      },
      evidence: { state: null },
      judgment,
      decision: decision.decision,
      reason: decision.reason,
    };
    const ref = await writeStageApplicabilityRecord({
      stageRoot: settings.stageRoot,
      round: settings.plan.round,
      record,
    });
    return { record: ref, decision: record.decision, reason: record.reason, judgment };
  };
  if (guard !== null) {
    return await retain({ kind: 'not-requested', reason: guard });
  }
  if (settings.capability.kind !== 'available') {
    return await retain({
      kind: 'not-requested',
      reason: capabilityReason(settings.capability),
    });
  }
  if (!capturedScopeAvailable(settings.selection)) {
    return await retain({
      kind: 'not-requested',
      reason:
        'the captured task and attributed conversation provide no scope evidence; the full path applies',
    });
  }
  const revision = inspection.value.headRevision;
  const changedPaths =
    prepared === null || revision === null
      ? null
      : await (async () => {
          const changed = await settings.git.readChangedPaths(
            settings.worktree,
            prepared.baseRevision,
            revision,
          );
          if (!changed.ok) {
            throw new Error(changed.fault.message);
          }
          return changed.value;
        })();
  const state = await applicabilityState({
    selection: settings.selection,
    stage: settings.stage,
    worktree: settings.worktree,
    repository: basis.repository,
    baseRevision: prepared?.baseRevision ?? null,
    changedPaths,
  });
  let judgment: ApplicabilityJudgment;
  try {
    judgment = answeredJudgment(
      await settings.capability.client.evaluate(applicabilityRequest(state)),
    );
  } catch (error) {
    judgment = failedJudgment(error);
  }
  const recheck = await settings.recheck();
  const unchanged =
    recheck.sourceIdentity === basis.sourceIdentity &&
    recheck.revision === basis.repository.revision &&
    !recheck.trackedChanges;
  const changedReason =
    'the captured input or repository changed while the judgment was being obtained; the full path applies';
  const decision = applicabilityDecision(judgment);
  const record: ApplicabilityRecord = {
    kind: 'jev-applicability-advice',
    policy: applicabilityPolicy,
    stage: settings.stage,
    taskKey: settings.selection.taskKey,
    round: settings.plan.round,
    basisIdentity,
    basis,
    question: {
      name: 'stage_applicability',
      instructions: applicabilityQuestion.instructions,
      criteria: { ...applicabilityQuestion.criteria },
    },
    evidence: { state },
    judgment,
    decision: unchanged ? decision.decision : 'full-path',
    reason: unchanged ? decision.reason : changedReason,
  };
  const ref = await writeStageApplicabilityRecord({
    stageRoot: settings.stageRoot,
    round: settings.plan.round,
    record,
  });
  return { record: ref, decision: record.decision, reason: record.reason, judgment };
}
