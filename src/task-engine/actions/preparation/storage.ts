import path from 'node:path';
import { z } from 'zod';
import type { GitAdapter } from '../../../adapters/git.js';
import { readBoundReport, type ReportBinding } from '../agent-reports.js';
import { roundArtifactPath, type ArtifactDeclaration } from '../artifacts.js';
import { readRecord, writeRecord, type RecordDeclaration } from '../records.js';
import type { Selection } from '../select-task/artifacts.js';
import {
  ensureRoundDirectory,
  readCurrentPlan,
  saveCurrentPlan,
  listNumberedHistory,
} from '../round-storage.js';
import { handoffSchema, ideaHandoffFile } from '../publish-decision/artifacts.js';
import {
  acceptanceVerdictProblem,
  isBoundStageAuthorOutput,
  isBoundStageEvaluationOutput,
  preparationStages,
  preparationWorkspaceDeclaration,
  stageAreas,
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stageResultArtifact,
  stageTerminalDeclaration,
  stageRoundPlanDeclaration,
  stageReportScope,
  type AcceptanceBasis,
  type PreparationWorkspace,
  type ReturnReport,
  type PreparationStage,
  type RetainedStageAuthorOutput,
  type RetainedStageEvaluationOutput,
  type StageRoundPlan,
  type PreparationResult,
} from './artifacts.js';
import {
  clearPendingValidationError,
  projectOfWorkspace,
  rejectUnusableRecord,
} from '../report-feedback.js';
import {
  authoredIdentity,
  recordIdentity,
  requireDeclaredWork,
  sourceInputIdentity,
} from './evaluation-content.js';
import { requireRetainedPrototypeEvidence } from './observation.js';

/**
 * The evaluated preparation stages' shared storage: one checkout and branch under the preparation
 * issue root's worktree/, with each stage area retaining its own current-round plan and numbered
 * rounds under artifacts/. The helpers read and write the producer declarations; they choose no
 * roles, count no rounds and route nothing.
 */

/** The stage area root under the shared issue workspace root. */
export function stageRoot(issueWorkspaceRoot: string, stage: PreparationStage): string {
  return path.join(issueWorkspaceRoot, stageAreas[stage]);
}

/**
 * The one preparation checkout every stage role and Git operation works in. The stage areas are
 * artifact storage, never separate checkouts.
 */
export function preparationWorktree(issueWorkspaceRoot: string): string {
  return path.join(issueWorkspaceRoot, 'worktree');
}

/** Read the retained shared preparation repository record; null before preparation starts. */
export async function readPreparationWorkspace(
  issueWorkspaceRoot: string,
): Promise<PreparationWorkspace | null> {
  return readRecord(
    path.join(issueWorkspaceRoot, preparationWorkspaceDeclaration.file),
    preparationWorkspaceDeclaration,
  );
}

/** Persist the shared preparation repository record. */
export async function writePreparationWorkspace(
  issueWorkspaceRoot: string,
  workspace: PreparationWorkspace,
): Promise<void> {
  await writeRecord(path.join(issueWorkspaceRoot, preparationWorkspaceDeclaration.file), workspace);
}

/** Read the stage's current-round plan; null before the first round exists. */
export async function readStagePlan(root: string): Promise<StageRoundPlan | null> {
  return readCurrentPlan(
    path.join(root, stageRoundPlanDeclaration.file),
    stageRoundPlanDeclaration,
  );
}

/** Persist the stage's current-round plan. */
export async function writeStagePlan(root: string, plan: StageRoundPlan): Promise<void> {
  await saveCurrentPlan(path.join(root, stageRoundPlanDeclaration.file), plan);
}

/** Create the stage's numbered round directory. */
export async function ensureStageRound(root: string, round: number): Promise<string> {
  return ensureRoundDirectory(path.join(root, 'artifacts'), round);
}

/** The stage's retained round numbers, in ascending order. */
export async function stageRounds(root: string): Promise<number[]> {
  return listNumberedHistory(path.join(root, 'artifacts'));
}

/** Read one stage round's declared artifact, or null when it does not exist yet. */
export async function readStageArtifact<Declaration extends ArtifactDeclaration>(
  root: string,
  round: number,
  declaration: Declaration,
): Promise<z.output<Declaration['schema']> | null> {
  const content = await readRecord(
    roundArtifactPath(root, round, declaration.pathFromArtifactsRoot),
    { file: declaration.pathFromArtifactsRoot, schema: declaration.schema },
  );
  return content as z.output<Declaration['schema']> | null;
}

const stageRoleArtifacts = {
  author: stageAuthorArtifact,
  evaluator: stageEvaluationArtifact,
};

/**
 * Read a retained role outcome through its producer declaration. Invalid or required missing
 * records retain the available evidence under the producing role before the consumer fails or
 * routes stale. Evidence capture must not depend on a successfully parsed report binding.
 */
export async function readStageRoleArtifact<
  Role extends keyof typeof stageRoleArtifacts,
>(settings: {
  readonly issueRoot: string;
  readonly stage: PreparationStage;
  readonly workId: string;
  readonly round: number;
  readonly role: Role;
  readonly profile: string | null;
  readonly context: string;
  /** A consumer of a retained result requires this record; history may legitimately omit it. */
  readonly required?: boolean;
}): Promise<z.output<(typeof stageRoleArtifacts)[Role]['schema']> | null> {
  const root = stageRoot(settings.issueRoot, settings.stage);
  const declaration = stageRoleArtifacts[settings.role];
  const file = roundArtifactFile(root, settings.round, declaration.pathFromArtifactsRoot);
  try {
    const record = await readStageArtifact(root, settings.round, declaration);
    if (record === null && settings.required === true) {
      throw new Error(
        `Required retained ${settings.stage} ${settings.role} record at "${file}" does not exist.`,
      );
    }
    return record;
  } catch (error) {
    // Recover attribution independently of outcome validity; the invocation doing this read did
    // not produce the rejected record. Unrecoverable invocation metadata stays explicitly unknown.
    const producer = await readRecord(file, {
      file,
      schema: z.object({
        invocationId: z.string().trim().min(1).nullable().catch(null),
        profile: z.string().trim().min(1).nullable().catch(null),
      }),
    }).catch(() => null);
    return await rejectUnusableRecord({
      areaRoot: root,
      scope: stageReportScope({
        project: projectOfWorkspace(settings.issueRoot),
        workId: settings.workId,
        area: root,
        stage: settings.stage,
        role: settings.role,
      }),
      invocationId: producer?.invocationId ?? null,
      operation: `stage-${settings.role}`,
      profile: producer?.profile ?? settings.profile,
      context: settings.context,
      file,
      error,
    });
  }
}

/** Write one stage round's declared artifact. */
export async function writeStageArtifact<Declaration extends ArtifactDeclaration>(
  root: string,
  round: number,
  declaration: Declaration,
  content: z.output<Declaration['schema']>,
): Promise<void> {
  await writeRecord(roundArtifactPath(root, round, declaration.pathFromArtifactsRoot), content);
}

/** Read one stage round's terminal result, or null when that round has none yet. */
export async function readStageResult(
  root: string,
  round: number,
): Promise<PreparationResult | null> {
  return await readStageArtifact(root, round, stageResultArtifact);
}

/** The latest authored revision one round builds on. */
export type PrecedingStageWork = {
  /** The round that retained the preceding authored revision. */
  readonly round: number;
  /** The authored revision the next round revises or answers. */
  readonly author: RetainedStageAuthorOutput;
};

/** The upstream-return allowance file: how many returns the stage has stated so far. */
export const returnCountFile = 'state/returns.json';

/**
 * The retained return count and the round that stated the most recent return. The round binds the
 * record to its originating result, so replaying one interrupted return reuses the recorded
 * outcome instead of consuming another allowance.
 */
export const returnCountSchema = z.object({
  count: z.number().int().nonnegative(),
  round: z.number().int().positive().nullable(),
});

export const returnCountDeclaration = {
  file: returnCountFile,
  schema: returnCountSchema,
} satisfies RecordDeclaration<typeof returnCountSchema>;

/** The upstream returns this stage has stated, counted across restarts. */
export async function readReturnCount(
  root: string,
): Promise<{ readonly count: number; readonly round: number | null }> {
  const record = await readRecord(path.join(root, returnCountFile), returnCountDeclaration);
  return record ?? { count: 0, round: null };
}

/** Persist the updated upstream-return count and the round that stated the return. */
export async function writeReturnCount(
  root: string,
  count: number,
  round: number | null,
): Promise<void> {
  await writeRecord(path.join(root, returnCountFile), { count, round });
}

/** Read the latest terminal invocation; legacy results live in the current round. */
export async function readStageTerminal(root: string): Promise<PreparationResult | null> {
  const result = await readRecord(
    path.join(root, stageTerminalDeclaration.file),
    stageTerminalDeclaration,
  );
  if (result !== null) return result;
  const plan = await readStagePlan(root);
  return plan === null ? null : readStageResult(root, plan.round);
}

/** One immutable upstream result a later stage builds on, with its retained identity. */
export type UpstreamResultReference = {
  /** The producing idea or preparation stage. */
  readonly stage: string;
  /** The saved artifact file the consumer may read. */
  readonly resultFile: string;
  /** The identity of that complete saved report. */
  readonly identity: string;
};

/**
 * The identity of one stage's accepted work as a later stage relies on it: its outcome and the
 * exact content it retained, not the round that recorded it. Repeating an acceptance with
 * identical content therefore keeps the relied-on identity stable, while a changed document set
 * or outcome invalidates the decisions taken against it.
 */
export function acceptedResultIdentity(result: PreparationResult): string {
  return recordIdentity({
    stage: result.stage,
    outcome: result.outcome,
    documents: result.documents,
    sourcePaths: result.sourcePaths,
    skipReferences: result.skipReferences,
    prototype: result.prototype,
  });
}

/**
 * The retained upstream results one stage builds on, in route order: the approved idea handoff
 * and every earlier preparation stage's current terminal result. A stage's acceptance is bound to
 * these identities, so a corrected upstream report invalidates a decision taken against it.
 */
export async function upstreamResultReferences(
  issueRoot: string,
  stage: PreparationStage,
): Promise<UpstreamResultReference[]> {
  const references: UpstreamResultReference[] = [];
  const ideaHandoff = path.join(issueRoot, 'refinement', ideaHandoffFile);
  const approvedIdea = await readRecord(ideaHandoff, {
    file: ideaHandoffFile,
    schema: handoffSchema,
  });
  if (approvedIdea !== null) {
    references.push({
      stage: 'idea',
      resultFile: ideaHandoff,
      identity: recordIdentity(approvedIdea),
    });
  }
  for (const earlier of preparationStages) {
    if (earlier === stage) {
      break;
    }
    const root = stageRoot(issueRoot, earlier);
    const plan = await readStagePlan(root);
    if (plan === null) {
      continue;
    }
    // Read each retained result through its producer declaration: its outcome says whether the
    // stage accepted, skipped, returned or exhausted the work, so a consumer is never directed to
    // a result presented as accepted when it was not.
    const result = await readStageArtifact(root, plan.round, stageResultArtifact);
    if (result !== null) {
      references.push({
        stage: earlier,
        resultFile: roundArtifactFile(root, plan.round, stageResultArtifact.pathFromArtifactsRoot),
        identity: acceptedResultIdentity(result),
      });
    }
  }
  return references;
}

/** One stage round artifact's filepath. */
export function roundArtifactFile(root: string, round: number, relative: string): string {
  return path.join(roundArtifactDirectory(root, round), relative);
}

/** One stage round's artifact directory, which also holds that round's retained evidence. */
export function roundArtifactDirectory(root: string, round: number): string {
  return path.join(root, 'artifacts', String(round));
}

/** One stage's current, fully bound evaluator decision. */
export type CurrentStageDecision = {
  readonly round: number;
  readonly result: PreparationResult;
  readonly evaluation: RetainedStageEvaluationOutput;
  readonly author: RetainedStageAuthorOutput;
};

/** The state of one stage's current decision: current, missing, or stale against its basis. */
export type CurrentDecisionState =
  | { readonly kind: 'current'; readonly decision: CurrentStageDecision }
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'stale'; readonly reason: string };

/**
 * Read the current stage decision for the captured ticket. Later stages assess the current shared
 * checkout and return concrete input defects upstream; their document edits do not invalidate an
 * earlier verdict mechanically. An applicable prototype decision still requires both roles'
 * readable retained evidence, resolved through the producing outcomes.
 */
export async function readCurrentDecision(settings: {
  readonly issueRoot: string;
  readonly stage: PreparationStage;
  readonly selection: Selection;
  readonly git: GitAdapter;
}): Promise<CurrentDecisionState> {
  const { issueRoot, stage, selection, git } = settings;
  const root = stageRoot(issueRoot, stage);
  const plan = await readStagePlan(root);
  if (plan === null || plan.stage !== stage) {
    return { kind: 'missing', reason: `the ${stage} stage opened no round` };
  }
  const result = await readStageTerminal(root);
  if (result === null) {
    return { kind: 'missing', reason: `the ${stage} stage retained no terminal result` };
  }
  if (result.outcome !== 'accepted' && result.outcome !== 'skipped') {
    return {
      kind: 'missing',
      reason: `the ${stage} stage's current result is "${result.outcome}"`,
    };
  }
  try {
    const attribution = {
      issueRoot,
      stage,
      workId: selection.taskKey,
      round: plan.round,
      context: `Reading the retained ${stage} decision for task ${selection.taskKey}.`,
    };
    const evaluation = await readStageRoleArtifact({
      ...attribution,
      role: 'evaluator',
      profile: plan.profiles.evaluator,
    });
    const author = await readStageRoleArtifact({
      ...attribution,
      role: 'author',
      profile: plan.profiles.author,
    });
    if (evaluation === null || author === null) {
      return {
        kind: 'missing',
        reason: `the ${stage} stage's current round retains no evaluated authored revision`,
      };
    }
    const verdict = result.outcome === 'skipped' ? 'accepted-skip' : 'accepted';
    await requireRetainedDecision({
      issueRoot,
      stage,
      selection,
      round: plan.round,
      verdict,
      author,
      evaluation,
      git,
    });
    // The result's recorded attribution must identify the producing assessment before any
    // evidence is resolved through it; a mismatched revision, evaluation or prototype reference
    // is not the decision this round evaluated.
    requireRetainedResultAssociation({
      root,
      round: plan.round,
      result,
      author,
      evaluation,
    });
    // An applicable prototype decision also relies on the retained observation records; a record
    // deleted or edited after acceptance makes the decision stale for reuse and handoff alike.
    // Missing references are resolved from the producing outcomes, never searched or guessed.
    if (stage === 'prototype' && (result.outcome === 'accepted' || result.prototype !== null)) {
      await requireRetainedPrototypeEvidence({
        artifactsRoot: path.join(root, 'artifacts'),
        roundDirectory: roundArtifactDirectory(root, plan.round),
        observations: result.prototypeObservations,
        author,
        evaluation,
      });
    }
    return { kind: 'current', decision: { round: plan.round, result, evaluation, author } };
  } catch (error) {
    if (error instanceof Error) {
      return { kind: 'stale', reason: error.message };
    }
    throw error;
  }
}

/**
 * Require a retained result to identify the producing assessment it recorded, before a replay or
 * downstream read resolves evidence through it: the evaluation reference must name the round's
 * evaluated decision, the authored revision must be the revision that decision assessed and a
 * retained prototype revision must be the repository revision the evaluation observed. A legacy
 * evaluation that recorded no repository observation keeps its documented compatibility;
 * conflicting or unresolvable attribution requires normal recovery or reassessment.
 */
export function requireRetainedResultAssociation(settings: {
  readonly root: string;
  readonly round: number;
  readonly result: PreparationResult;
  readonly author: RetainedStageAuthorOutput;
  readonly evaluation: RetainedStageEvaluationOutput;
}): void {
  const { root, round, result, author, evaluation } = settings;
  const evaluationFile = roundArtifactFile(
    root,
    round,
    stageEvaluationArtifact.pathFromArtifactsRoot,
  );
  if (path.resolve(result.evaluation.path) !== evaluationFile) {
    throw new Error(
      `The retained ${result.stage} result names another evaluation than the round's evaluated ` +
        'decision.',
    );
  }
  if (result.authoredRevision !== author.revision) {
    throw new Error(
      `The retained ${result.stage} result reports another authored revision than the evaluated ` +
        'author.',
    );
  }
  const observed = evaluation.basis.repositoryRevision;
  if (
    result.prototype !== null &&
    observed !== undefined &&
    observed !== result.prototype.revision
  ) {
    throw new Error(
      `The retained ${result.stage} prototype revision does not match the repository revision ` +
        'its evaluation observed.',
    );
  }
}

/** The current round's report, ticket and repository context. */
type AcceptanceSettings = {
  readonly issueRoot: string;
  readonly stage: PreparationStage;
  readonly selection: Selection;
  readonly round: number;
  readonly verdict: 'accepted' | 'accepted-skip';
  readonly author: RetainedStageAuthorOutput;
  readonly evaluation: RetainedStageEvaluationOutput | null;
  readonly git: GitAdapter;
};

/**
 * Validate the report and ticket association of a retained accepted or skipped decision, without
 * treating later document edits or upstream report replacements as new findings. Completion and
 * downstream reads use this check: a producer-owned saved record keeps working, including a
 * legacy record that carries no repository observation or per-document binding.
 */
export async function requireRetainedDecision(
  settings: AcceptanceSettings,
): Promise<RetainedStageEvaluationOutput> {
  const { issueRoot, stage, selection, round, verdict, author, evaluation } = settings;
  const root = stageRoot(issueRoot, stage);
  // Validate producer bindings before association checks can route changed records as stale and
  // bypass rejection retention. Legacy combined records need no retroactive Markdown binding.
  if (evaluation !== null && isBoundStageEvaluationOutput(evaluation)) {
    await requireStageReport({
      issueRoot,
      stage,
      workId: selection.taskKey,
      role: 'evaluator',
      binding: evaluation,
      profile: evaluation.profile,
      file: roundArtifactFile(root, round, stageEvaluationArtifact.pathFromArtifactsRoot),
      context: `Validating retained ${stage} acceptance of round ${String(round)} for task ${selection.taskKey}.`,
    });
  }
  if (isBoundStageAuthorOutput(author)) {
    await requireStageReport({
      issueRoot,
      stage,
      workId: selection.taskKey,
      role: 'author',
      binding: author,
      profile: author.profile,
      file: roundArtifactFile(root, round, stageAuthorArtifact.pathFromArtifactsRoot),
      context: `Validating retained ${stage} acceptance of round ${String(round)} for task ${selection.taskKey}.`,
    });
  }
  if (evaluation === null || evaluation.assessedRevision !== author.revision) {
    throw new Error('Acceptance requires evaluation of the exact authored revision.');
  }
  if (evaluation.verdict !== verdict) {
    throw new Error('Acceptance requires the evaluator\u2019s applicability decision.');
  }
  const acceptanceProblem = acceptanceVerdictProblem(author.outcome, verdict);
  if (acceptanceProblem !== null) {
    throw new Error(`Acceptance is unusable: ${acceptanceProblem}.`);
  }
  const basis: AcceptanceBasis = evaluation.basis;
  if (basis.author.path !== roundArtifactFile(root, round, 'author.json')) {
    throw new Error('The evaluation does not name the authored report it assessed.');
  }
  if (basis.authorIdentity !== authoredIdentity(author)) {
    throw new Error(
      'The authored report changed since evaluation; a current decision is required.',
    );
  }
  if (basis.sourceIdentity !== sourceInputIdentity(selection)) {
    throw new Error(
      'The captured issue input changed since evaluation; a current decision is required.',
    );
  }
  return evaluation;
}

/**
 * Finalize a fresh evaluation before its stage advances. The exact authored report, captured input
 * and relied-on upstream results must still be current, the evaluated repository revision must
 * still be the checkout's revision and the declared stage work must still commit the bytes the
 * evaluator assessed. An unobservable legacy evaluation receives normal reassessment instead.
 */
export async function requireCurrentAcceptance(settings: AcceptanceSettings): Promise<void> {
  const evaluation = await requireRetainedDecision(settings);
  const { issueRoot, stage, author, git } = settings;
  const worktree = preparationWorktree(issueRoot);
  const basis = evaluation.basis;
  const upstream = await upstreamResultReferences(issueRoot, stage);
  const reliedOn = upstream.map((reference) => ({
    result: { path: reference.resultFile },
    identity: reference.identity,
  }));
  if (JSON.stringify(reliedOn) !== JSON.stringify(basis.upstream)) {
    throw new Error(
      'A relied-on upstream result changed since evaluation; a current decision is required.',
    );
  }
  // The evaluation is only current while the exactly observed repository revision is still the
  // checkout's revision: a later commit moved the assessment basis and needs a fresh decision.
  // Legacy evaluations that saved no observation receive normal reassessment instead of inventing
  // one from current content.
  if (basis.repositoryRevision === undefined) {
    throw new Error(
      'The retained evaluation carries no repository observation; a current decision is required.',
    );
  }
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) {
    throw new Error(inspection.fault.message);
  }
  if (inspection.value.headRevision !== basis.repositoryRevision) {
    throw new Error(
      'The repository revision changed since evaluation; a current decision is required.',
    );
  }
  // The declared stage work must still be the committed bytes the evaluator assessed: an
  // uncommitted edit after the observation is not covered by the saved decision.
  await requireDeclaredWork({ git, worktree, author, revision: basis.repositoryRevision });
}

/**
 * Validate the current round's producing return before resumed consumption can clear its error.
 * Reading copied Markdown alone does not establish that the producing outcome still supplies
 * this revision, destination and correction. History/report readers remain non-clearing.
 */
export async function requireRetainedReturn(settings: {
  readonly issueRoot: string;
  readonly stage: PreparationStage;
  readonly workId: string;
  readonly round: number;
  readonly profiles: StageRoundPlan['profiles'];
  readonly result: PreparationResult;
  readonly context: string;
}): Promise<{ readonly role: 'author' | 'evaluator'; readonly profile: string | null }> {
  const root = stageRoot(settings.issueRoot, settings.stage);
  const author = await readStageRoleArtifact({
    ...settings,
    role: 'author',
    profile: settings.profiles.author,
    required: true,
  });
  const evaluation = await readStageRoleArtifact({
    ...settings,
    role: 'evaluator',
    profile: settings.profiles.evaluator,
    required:
      settings.result.returnFinding?.role === 'evaluator' ||
      path.resolve(settings.result.evaluation.path) ===
        roundArtifactFile(root, settings.round, stageEvaluationArtifact.pathFromArtifactsRoot),
  });
  if (author === null) {
    throw new Error('A retained return must keep its producing authored revision.');
  }
  const evaluatorReturn = evaluation !== null && evaluation.upstream !== null;
  const role = evaluatorReturn ? 'evaluator' : 'author';
  const producer = evaluatorReturn ? evaluation : author;
  const file = roundArtifactFile(
    root,
    settings.round,
    stageRoleArtifacts[role].pathFromArtifactsRoot,
  );
  const bound = producer.report !== undefined;
  if (producer.report !== undefined) {
    await requireStageReport({
      ...settings,
      role,
      binding: producer,
      profile: producer.profile ?? null,
      file,
    });
  }
  const { result } = settings;
  const upstream = producer.upstream;
  if (
    (evaluatorReturn
      ? evaluation.verdict !== 'return-upstream' || evaluation.assessedRevision !== author.revision
      : author.outcome !== 'return-upstream') ||
    author.revision !== result.authoredRevision ||
    result.stage !== settings.stage ||
    result.outcome !== 'returnUpstream' ||
    upstream === null ||
    upstream.stage !== result.returnStage ||
    upstream.stage !== result.returnFinding?.stage ||
    upstream.correction !== result.returnFinding.correction
  ) {
    throw new Error('A retained return must keep its producing upstream outcome.');
  }
  const report = result.returnFinding.report;
  if (
    (bound
      ? producer.taskKey !== settings.workId ||
        producer.stage !== settings.stage ||
        producer.role !== role ||
        result.returnFinding.role !== role ||
        report === null ||
        path.resolve(report.outcome.path) !== file ||
        report.profile !== producer.profile ||
        report.invocationId !== producer.invocationId ||
        report.report.path !== producer.report?.path
      : result.returnFinding.role !== null || report !== null) ||
    path.resolve(result.evaluation.path) !==
      roundArtifactFile(
        root,
        settings.round,
        evaluation === null
          ? stageAuthorArtifact.pathFromArtifactsRoot
          : stageEvaluationArtifact.pathFromArtifactsRoot,
      )
  ) {
    throw new Error('A retained return must keep its producing outcome and report association.');
  }
  return { role, profile: producer.profile ?? null };
}

/** One published upstream return's report association: the returning stage, role and binding. */
export type ReturnReportReference = {
  /** The stage whose round produced the return and owns the report. */
  readonly stage: PreparationStage;
  readonly role: 'author' | 'evaluator' | null;
  readonly report: ReturnReport | null;
};

/**
 * Require one published return's Markdown report to stay readable. The returning role's binding
 * names the report, so a missing or unreadable report is preserved under that role's rejection
 * evidence before the read fails. A former combined return carries no bound report and keeps its
 * problem and consequence text as history. Returns the report's Markdown text, or null when the
 * return binds no report.
 */
export async function requireReturnReport(settings: {
  readonly issueRoot: string;
  readonly workId: string;
  readonly returned: ReturnReportReference;
  readonly context: string;
}): Promise<string | null> {
  const { stage, role, report } = settings.returned;
  if (report === null) {
    if (role !== null) {
      throw new Error(`The retained ${stage} ${role} return is missing its report binding.`);
    }
    return null;
  }
  if (role === null) {
    throw new Error(
      `The retained ${stage} return binds a Markdown report without the role that produced it.`,
    );
  }
  return requireStageReport({
    issueRoot: settings.issueRoot,
    workId: settings.workId,
    stage,
    role,
    binding: report,
    profile: report.profile,
    file: report.outcome.path,
    context: settings.context,
  });
}

/** Read a producing role's bound report, retaining attributable evidence before any failure. */
export async function requireStageReport(settings: {
  readonly issueRoot: string;
  readonly workId: string;
  readonly stage: PreparationStage;
  readonly role: 'author' | 'evaluator';
  readonly binding: ReportBinding;
  readonly profile: string | null;
  readonly file: string;
  readonly context: string;
}): Promise<string> {
  const { stage, role, binding } = settings;
  try {
    return (await readBoundReport(binding, `Stage ${role} report`)).text;
  } catch (error) {
    const area = stageRoot(settings.issueRoot, stage);
    return await rejectUnusableRecord({
      areaRoot: area,
      scope: stageReportScope({
        project: projectOfWorkspace(settings.issueRoot),
        workId: settings.workId,
        area,
        stage,
        role,
      }),
      invocationId: binding.invocationId,
      operation: `stage-${role}`,
      profile: settings.profile,
      context: settings.context,
      file: settings.file,
      error,
      assignedReport: binding.report,
    });
  }
}

/**
 * Complete an interrupted save/clear for one stage role after the caller validated that role's
 * current-round saved outcome as the usable replacement for its decision. The caller names the
 * validated role; the producer-owned retained-decision validation accepted the record, bound or
 * under its documented compatibility rules, and opening a report or replaying a historical round
 * never clears by itself.
 */
export async function clearStageReportValidationError(settings: {
  readonly issueRoot: string;
  readonly stage: PreparationStage;
  readonly workId: string;
  readonly role: 'author' | 'evaluator';
}): Promise<void> {
  const area = stageRoot(settings.issueRoot, settings.stage);
  await clearPendingValidationError({
    areaRoot: area,
    scope: stageReportScope({
      project: projectOfWorkspace(settings.issueRoot),
      workId: settings.workId,
      area,
      stage: settings.stage,
      role: settings.role,
    }),
  });
}

/** A retained question needs its exact producing author and that author's usable report. */
export async function requireNeedsInputReport(settings: {
  readonly issueRoot: string;
  readonly stage: PreparationStage;
  readonly round: number;
  readonly workId: string;
  readonly authoredRevision: number;
}): Promise<void> {
  const { issueRoot, stage, round, workId } = settings;
  const root = stageRoot(issueRoot, stage);
  const plan = await readStagePlan(root);
  const author = await readStageRoleArtifact({
    issueRoot,
    stage,
    workId,
    round,
    role: 'author',
    profile: plan?.profiles.author ?? null,
    context: `Validating the ${stage} author question of round ${String(round)} for task ${workId}.`,
  });
  if (author === null) {
    throw new Error('A retained question must keep its exact producing author.');
  }
  if (isBoundStageAuthorOutput(author)) {
    await requireStageReport({
      issueRoot,
      stage,
      workId,
      role: 'author',
      binding: author,
      profile: author.profile,
      file: roundArtifactFile(root, round, stageAuthorArtifact.pathFromArtifactsRoot),
      context: `Validating the ${stage} author question of round ${String(round)} for task ${workId}.`,
    });
  }
  if (author.revision !== settings.authoredRevision) {
    throw new Error('A retained question must keep its exact producing author.');
  }
}
