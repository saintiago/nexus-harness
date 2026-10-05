import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { GitAdapter } from '../../../adapters/git.js';
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
  preparationStages,
  preparationWorkspaceDeclaration,
  stageAreas,
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stageResultArtifact,
  stageTerminalDeclaration,
  stageRoundPlanDeclaration,
  type AcceptanceBasis,
  type AssessedContent,
  type PreparationWorkspace,
  type PreparationStage,
  type StageAuthorOutput,
  type StageEvaluationOutput,
  type StageRoundPlan,
  type PreparationResult,
} from './artifacts.js';
import {
  authoredIdentity,
  checkoutRelative,
  recordIdentity,
  requireEvaluationContent,
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
  readonly author: StageAuthorOutput;
};

/**
 * The most recent authored revision retained before one round. A
 * response or later-stage-visit round reads the work it revises from history instead of expecting
 * the new round's own directory to carry it.
 */
export async function precedingStageWork(
  root: string,
  round: number,
): Promise<PrecedingStageWork | null> {
  for (let earlier = round - 1; earlier >= 1; earlier -= 1) {
    const author = await readStageArtifact(root, earlier, stageAuthorArtifact);
    if (author !== null) {
      return {
        round: earlier,
        author,
      };
    }
  }
  return null;
}

/**
 * The most recent evaluation before one round. Author-only returns and input requests carry no
 * evaluator dispositions, so its finding evidence remains applicable until a later evaluation
 * explicitly resolves or withdraws it. This lookup supplies evidence, never an acceptance to reuse.
 */
export async function precedingStageEvaluation(
  root: string,
  round: number,
): Promise<StageEvaluationOutput | null> {
  for (let earlier = round - 1; earlier >= 1; earlier -= 1) {
    const evaluation = await readStageArtifact(root, earlier, stageEvaluationArtifact);
    if (evaluation !== null) return evaluation;
  }
  return null;
}

/**
 * The prior findings one round must answer and dispose of: the findings of the evaluation the
 * current response or reassessment round revises. A "new" route opens a fresh stage visit whose
 * input is the parent's retained correction rather than an earlier round's findings, so it
 * supplies none; a re-entered stage keeps every finding its own earlier evaluation left open.
 */
export async function priorStageFindings(
  root: string,
  plan: StageRoundPlan,
): Promise<StageEvaluationOutput['findings']> {
  if (plan.route === 'new') {
    return [];
  }
  return (await precedingStageEvaluation(root, plan.round))?.findings ?? [];
}

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
    existingDocuments: result.existingDocuments,
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

/**
 * The retained content one evaluated skip reuses from the immediately preceding completed round
 * of the same stage: the result's changed and existing documents, stage-owned source paths, the
 * preceding acceptance's observations of those paths, and any retained prototype this stage owns.
 * Only that immediate acceptance may supply reused assets; a later rejection or upstream return
 * invalidates it, so reuse never searches past an intervening unfinished or invalid round. The
 * observations carry the recorded revision and existence, so a retained deletion is validated as
 * an absence rather than unreadable file bytes.
 */
export type ReusedPreparationContent = {
  /** The preceding result's changed documents the skip reuses, as the result recorded them. */
  readonly documents: readonly { readonly path: string; readonly revision: string }[];
  /** Existing authoritative documents the preceding skip relied on, without changed ownership. */
  readonly existingDocuments: PreparationResult['existingDocuments'];
  /** The preceding result's stage-owned source paths the skip reuses, checkout-relative. */
  readonly sourcePaths: readonly string[];
  /** Every reused checkout path in one ordered set. */
  readonly paths: readonly string[];
  /** The preceding acceptance's observation of each reused path. */
  readonly content: readonly AssessedContent[];
  /** The retained prototype the preceding result recorded, when this stage owns one. */
  readonly prototype: PreparationResult['prototype'];
  /** The retained prototype observations the preceding result recorded with that prototype. */
  readonly prototypeObservations: PreparationResult['prototypeObservations'];
};

const nothingReused: ReusedPreparationContent = {
  documents: [],
  existingDocuments: [],
  sourcePaths: [],
  paths: [],
  content: [],
  prototype: null,
  prototypeObservations: [],
};

/** Resolve the content one skip proposal's references reuse from the preceding round. */
export async function reusedPreparationContent(settings: {
  readonly root: string;
  readonly round: number;
  readonly worktree: string;
  readonly stage: PreparationStage;
  readonly references: readonly string[];
}): Promise<ReusedPreparationContent> {
  const { root, round, worktree, stage, references } = settings;
  if (references.length === 0) {
    return nothingReused;
  }
  const previousRound = (await stageRounds(root)).filter((candidate) => candidate < round).at(-1);
  if (previousRound === undefined) {
    return nothingReused;
  }
  const result = await readStageArtifact(root, previousRound, stageResultArtifact);
  if (result === null || (result.outcome !== 'accepted' && result.outcome !== 'skipped')) {
    return nothingReused;
  }
  const previousFile = roundArtifactFile(
    root,
    previousRound,
    stageResultArtifact.pathFromArtifactsRoot,
  );
  const referencesPath = (reference: string, target: string): boolean =>
    path.resolve(worktree, reference) === target;
  const reusesResult = references.some((reference) => referencesPath(reference, previousFile));
  let documents = result.documents.filter(
    (document) =>
      reusesResult || references.some((reference) => referencesPath(reference, document.path)),
  );
  let existingDocuments = result.existingDocuments.filter(
    (document) =>
      reusesResult || references.some((reference) => referencesPath(reference, document.path)),
  );
  let sourcePaths = result.sourcePaths.filter(
    (source) =>
      reusesResult ||
      references.some((reference) => referencesPath(reference, path.join(worktree, source))),
  );
  const prototype = result.prototype;
  const reusesPrototype =
    stage === 'prototype' &&
    prototype !== null &&
    (reusesResult ||
      documents.length > 0 ||
      existingDocuments.length > 0 ||
      sourcePaths.length > 0 ||
      references.some(
        (reference) =>
          reference === prototype.revision ||
          reference === prototype.branch ||
          referencesPath(reference, worktree),
      ));
  // A retained prototype reference represents the complete assessed asset. Any supported
  // reference selecting it must keep all its evidence and source ownership, not just one file.
  if (reusesPrototype) {
    documents = result.documents;
    existingDocuments = result.existingDocuments;
    sourcePaths = result.sourcePaths;
  }
  for (const document of documents) {
    if (document.revision === null) {
      throw new Error('Reused accepted content has no immutable revision.');
    }
  }
  const paths: string[] = [];
  for (const document of [...documents, ...existingDocuments]) {
    const relative = checkoutRelative(worktree, document.path);
    if (relative === null) {
      throw new Error(`Reused document "${document.path}" lies outside the shared checkout.`);
    }
    if (!paths.includes(relative)) {
      paths.push(relative);
    }
  }
  for (const source of sourcePaths) {
    if (!paths.includes(source)) {
      paths.push(source);
    }
  }
  if (paths.length === 0) {
    return nothingReused;
  }
  const evaluation = await readStageArtifact(root, previousRound, stageEvaluationArtifact);
  const observed = new Map((evaluation?.basis.content ?? []).map((entry) => [entry.path, entry]));
  const content = paths.map((relative) => {
    const entry = observed.get(relative);
    if (entry === undefined) {
      throw new Error(
        `The preceding ${stage} acceptance does not bind the reused content "${relative}"; ` +
          'reuse needs a current decision.',
      );
    }
    return entry;
  });
  return {
    documents: documents.map((document) => ({
      path: document.path,
      revision: document.revision as string,
    })),
    existingDocuments,
    sourcePaths,
    paths,
    content,
    prototype: reusesPrototype ? prototype : null,
    prototypeObservations: reusesPrototype ? result.prototypeObservations : [],
  };
}

/** One stage's current, fully bound evaluator decision. */
export type CurrentStageDecision = {
  readonly round: number;
  readonly result: PreparationResult;
  readonly evaluation: StageEvaluationOutput;
  readonly author: StageAuthorOutput;
};

/** The state of one stage's current decision: current, missing, or stale against its basis. */
export type CurrentDecisionState =
  | { readonly kind: 'current'; readonly decision: CurrentStageDecision }
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'stale'; readonly reason: string };

/**
 * Read one stage's current terminal decision and validate the identities its acceptance basis
 * binds: the complete authored report, the captured source input, the relied-on upstream results
 * and the exact repository content it assessed or relied on. A changed author report, refreshed
 * input, corrected upstream result or changed assessed content — including a later stage's edit of
 * the same path or a rewritten revision — makes the decision stale and requires a current
 * evaluator decision.
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
  const evaluation = await readStageArtifact(root, plan.round, stageEvaluationArtifact);
  const author = await readStageArtifact(root, plan.round, stageAuthorArtifact);
  if (evaluation === null || author === null) {
    return {
      kind: 'missing',
      reason: `the ${stage} stage's current round retains no evaluated authored revision`,
    };
  }
  if (author.revision !== result.authoredRevision) {
    return { kind: 'stale', reason: `the ${stage} result reports another authored revision` };
  }
  try {
    const basis = evaluation.basis;
    const verdict = result.outcome === 'skipped' ? 'accepted-skip' : 'accepted';
    if (evaluation.assessedRevision !== author.revision || evaluation.verdict !== verdict) {
      throw new Error(`the ${stage} result does not match its saved evaluation`);
    }
    if (basis.author.path !== roundArtifactFile(root, plan.round, 'author.json')) {
      throw new Error(`the ${stage} evaluation does not name the authored report it assessed`);
    }
    if (basis.authorIdentity !== authoredIdentity(author)) {
      throw new Error(`the ${stage} authored report changed since evaluation`);
    }
    if (basis.sourceIdentity !== sourceInputIdentity(selection)) {
      throw new Error(`the captured issue input changed since the ${stage} evaluation`);
    }
    const upstream = await upstreamResultReferences(issueRoot, stage);
    const reliedOn = upstream.map((reference) => ({
      result: { path: reference.resultFile },
      identity: reference.identity,
    }));
    if (JSON.stringify(reliedOn) !== JSON.stringify(basis.upstream)) {
      throw new Error(`a relied-on upstream result changed since the ${stage} evaluation`);
    }
    await requireEvaluationContent({
      git,
      worktree: preparationWorktree(issueRoot),
      content: basis.content,
    });
    // An applicable prototype decision also relies on the retained observation records; a record
    // deleted or edited after acceptance makes the decision stale for reuse and handoff alike.
    if (
      stage === 'prototype' &&
      (result.outcome === 'accepted' || result.prototypeObservations.length > 0)
    ) {
      await requireRetainedPrototypeEvidence({
        git,
        worktree: preparationWorktree(issueRoot),
        artifactsRoot: path.join(root, 'artifacts'),
        observations: result.prototypeObservations,
        assessed: basis.content,
        observedPaths: result.sourcePaths,
      });
    }
  } catch (error) {
    if (error instanceof Error) {
      return { kind: 'stale', reason: error.message };
    }
    throw error;
  }
  return { kind: 'current', decision: { round: plan.round, result, evaluation, author } };
}

/**
 * Require a complete acceptance basis for one evaluated round: the exact authored report, the
 * captured source input, the relied-on upstream results and the assessed repository content. A
 * changed author report, refreshed input, corrected upstream result or changed path throws.
 */
export async function requireCurrentAcceptance(settings: {
  readonly issueRoot: string;
  readonly stage: PreparationStage;
  readonly selection: Selection;
  readonly round: number;
  readonly verdict: 'accepted' | 'accepted-skip';
  readonly author: StageAuthorOutput;
  readonly evaluation: StageEvaluationOutput | null;
  readonly git: GitAdapter;
}): Promise<void> {
  const { issueRoot, stage, selection, round, verdict, author, evaluation, git } = settings;
  const root = stageRoot(issueRoot, stage);
  if (evaluation === null || evaluation.assessedRevision !== author.revision) {
    throw new Error('Acceptance requires evaluation of the exact authored revision.');
  }
  if (evaluation.verdict !== verdict) {
    throw new Error('Acceptance requires the evaluator\u2019s applicability decision.');
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
  await requireEvaluationContent({
    git,
    worktree: preparationWorktree(issueRoot),
    content: basis.content,
  });
  // A document an evaluated skip relied on that appeared only after the assessment is a changed
  // relied-on input too: the skip was not taken against it.
  const checkout = preparationWorktree(issueRoot);
  for (const reference of author.skip?.references ?? []) {
    const relative = checkoutRelative(checkout, reference);
    if (relative === null) continue;
    let present = false;
    try {
      present = (await stat(path.join(checkout, relative))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (present && !basis.content.some((entry) => entry.path === relative)) {
      throw new Error(
        'A relied-on document appeared since evaluation; a current decision is required.',
      );
    }
  }
}
