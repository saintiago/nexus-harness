import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readRecord, readRequiredRecord, writeRecord } from '../records.js';
import {
  parentAreaDirectory,
  handoffFile,
  parentHandoffDeclaration,
  type StageReturn,
  type ParentHandoff,
} from '../select-work/artifacts.js';
import {
  selectionDeclaration,
  type Selection,
  type WorkflowStage,
} from '../select-task/artifacts.js';
import type { PreparationStage } from '../preparation/artifacts.js';

/**
 * The parent-owned state helpers shared by the project actions: the saved selection and the
 * handoff record under the issue workspace's parent area. They read and write the declared records;
 * routing and publication decisions stay with the calling actions.
 */

/** Read the parent's retained selection. */
export async function readSelection(selectionFile: string): Promise<Selection> {
  return readRequiredRecord(selectionFile, selectionDeclaration, 'Selection');
}

/** Save an updated selection record. */
export async function writeSelection(selectionFile: string, selection: Selection): Promise<void> {
  await mkdir(path.dirname(selectionFile), { recursive: true });
  await writeRecord(selectionFile, selection);
}

/** The parent handoff record's absolute path under one issue workspace root. */
export function handoffPath(issueWorkspaceRoot: string): string {
  return path.join(issueWorkspaceRoot, parentAreaDirectory, handoffFile);
}

/** Read the parent handoff record, or null when it does not exist yet. */
export async function readHandoff(issueWorkspaceRoot: string): Promise<ParentHandoff | null> {
  return readRecord(handoffPath(issueWorkspaceRoot), parentHandoffDeclaration);
}

/** Save the parent handoff record, creating its parent area. */
export async function writeHandoff(
  issueWorkspaceRoot: string,
  handoff: ParentHandoff,
): Promise<void> {
  await mkdir(path.join(issueWorkspaceRoot, parentAreaDirectory), { recursive: true });
  await writeRecord(handoffPath(issueWorkspaceRoot), handoff);
}

/**
 * Move the retained selection and handoff to the stage the parent now routes to. An upstream
 * return supplies the concrete finding the destination stage must correct; every other advance
 * clears a consumed return so a later stage never reads a stale correction.
 */
export async function advanceStage(
  selection: Selection,
  selectionFile: string,
  stage: WorkflowStage,
  returnFinding: StageReturn | null = null,
): Promise<Selection> {
  const updated: Selection = { ...selection, stage };
  await writeSelection(selectionFile, updated);
  const handoff = await readHandoff(selection.workspace.root);
  await writeHandoff(selection.workspace.root, {
    stage,
    upstreamReturns: handoff?.upstreamReturns ?? 0,
    feedback: null,
    return: returnFinding,
    awaitingStages: handoff?.awaitingStages ?? [],
    tickets: handoff?.tickets ?? [],
    basis: handoff?.basis ?? null,
    publications: handoff?.publications ?? [],
  });
  return updated;
}

/**
 * Retain the stages whose current decisions must be re-obtained after an upstream correction.
 * The list survives restarts and is consumed stage by stage as each current decision is reached.
 */
export async function writeAwaitingStages(
  issueWorkspaceRoot: string,
  stages: readonly PreparationStage[],
): Promise<void> {
  const handoff = await readHandoff(issueWorkspaceRoot);
  if (handoff === null) {
    throw new Error(`No parent handoff record exists under "${issueWorkspaceRoot}".`);
  }
  await writeHandoff(issueWorkspaceRoot, {
    ...handoff,
    awaitingStages: [...stages],
  });
}
