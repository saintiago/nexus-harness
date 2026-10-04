import path from 'node:path';
import { z } from 'zod';
import { roundArtifactPath, type ArtifactDeclaration } from '../artifacts.js';
import { readRecord, writeRecord, type RecordDeclaration } from '../records.js';
import {
  ensureRoundDirectory,
  readCurrentPlan,
  saveCurrentPlan,
  listNumberedHistory,
} from '../round-storage.js';
import {
  stageAreas,
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stageResultArtifact,
  stageTerminalDeclaration,
  stageRoundPlanDeclaration,
  type PreparationStage,
  type StageAuthorOutput,
  type StageEvaluationOutput,
  type StageRoundPlan,
  type PreparationResult,
} from './artifacts.js';

/**
 * The evaluated preparation stages' round storage: each stage area keeps a worktree, its
 * current-round plan and numbered rounds under artifacts/. The helpers read and write the stage's
 * own declarations; they choose no roles, count no rounds and route nothing.
 */

/** The stage area root under the shared issue workspace root. */
export function stageRoot(issueWorkspaceRoot: string, stage: PreparationStage): string {
  return path.join(issueWorkspaceRoot, stageAreas[stage]);
}

/** The stage's project worktree the roles read and revise documents in. */
export function stageWorktree(issueWorkspaceRoot: string, stage: PreparationStage): string {
  return path.join(stageRoot(issueWorkspaceRoot, stage), 'worktree');
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

/** The authored revision and evaluation one round builds on. */
export type PrecedingStageWork = {
  /** The round that retained the preceding authored revision. */
  readonly round: number;
  /** The authored revision the next round revises or answers. */
  readonly author: StageAuthorOutput;
  /** The evaluation of that revision, when the round retained one. */
  readonly evaluation: StageEvaluationOutput | null;
};

/**
 * The most recent authored revision retained before one round, with the evaluation of it. A
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
        evaluation: await readStageArtifact(root, earlier, stageEvaluationArtifact),
      };
    }
  }
  return null;
}

/**
 * The prior findings one round must answer and dispose of: the findings of the evaluation the
 * current response round revises. A "new" route opens a fresh stage visit whose input is the
 * parent's retained correction rather than an earlier round's findings, so it supplies none.
 */
export async function priorStageFindings(
  root: string,
  plan: StageRoundPlan,
): Promise<StageEvaluationOutput['findings']> {
  if (plan.route !== 'next') {
    return [];
  }
  const preceding = await precedingStageWork(root, plan.round);
  return preceding?.evaluation?.findings ?? [];
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
