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
  stageRoundPlanDeclaration,
  type PreparationStage,
  type StageRoundPlan,
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

/** The upstream-return allowance file: how many returns the stage has stated so far. */
export const returnCountFile = 'state/returns.json';

export const returnCountSchema = z.object({ count: z.number().int().nonnegative() });

export const returnCountDeclaration = {
  file: returnCountFile,
  schema: returnCountSchema,
} satisfies RecordDeclaration<typeof returnCountSchema>;

/** The upstream returns this stage has stated, counted across restarts. */
export async function readReturnCount(root: string): Promise<number> {
  const record = await readRecord(path.join(root, returnCountFile), returnCountDeclaration);
  return record?.count ?? 0;
}

/** Persist the updated upstream-return count. */
export async function writeReturnCount(root: string, count: number): Promise<void> {
  await writeRecord(path.join(root, returnCountFile), { count });
}
