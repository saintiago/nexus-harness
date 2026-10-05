import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { messageOf } from '../../../result.js';
import { readRecord, readRequiredRecord, writeRecord } from '../records.js';
import {
  parentAreaDirectory,
  handoffFile,
  parentHandoffDeclaration,
  type StageReturn,
  type ParentHandoff,
} from '../select-work/artifacts.js';
import { plannedTaskIdentityLabelPrefix } from './implementation-handoff/artifacts.js';
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

/**
 * The source issue key one handoff identity label names, or null for any other label. The handoff
 * labels an implementation ticket `nexus-source-<source key>-<planned task>`; the source key may
 * itself contain dashes, so the planned-task number is read from the end.
 */
export function handoffSourceKey(labels: unknown): string | null {
  if (!Array.isArray(labels)) {
    return null;
  }
  for (const label of labels) {
    if (typeof label !== 'string' || !label.startsWith(plannedTaskIdentityLabelPrefix)) {
      continue;
    }
    const remainder = label.slice(plannedTaskIdentityLabelPrefix.length);
    const separator = remainder.lastIndexOf('-');
    if (separator > 0 && /^\d+$/.test(remainder.slice(separator + 1))) {
      return remainder.slice(0, separator);
    }
  }
  return null;
}

/**
 * The disposition of one implementation ticket that carries the handoff's source identity but
 * retains no implementation input, classified through the source handoff record under the source
 * issue's stable workspace. The record owns the ticket's link, rank and admission
 * acknowledgements: a record that already finished its link and admission is an earlier-contract
 * ticket that never carried an input, a record that still owes them names a partially handed-off
 * ticket, and no record at all leaves the ticket unattributed.
 */
export type HandoffInputDisposition =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'unattributed'; readonly reason: string };

/** Classify one input-less ticket through the source handoff record its identity label names. */
export async function handoffInputDisposition(settings: {
  readonly workspaceRoot: string;
  readonly project: string;
  readonly labels: unknown;
  readonly ticketKey: string;
}): Promise<HandoffInputDisposition> {
  const sourceKey = handoffSourceKey(settings.labels);
  if (sourceKey === null) {
    return { kind: 'ordinary' };
  }
  const file = handoffPath(path.join(settings.workspaceRoot, settings.project, sourceKey));
  let source: ParentHandoff | null;
  try {
    source = await readRecord(file, parentHandoffDeclaration);
  } catch (error) {
    return {
      kind: 'unattributed',
      reason: `the source handoff record at "${file}" is unreadable: ${messageOf(error)}`,
    };
  }
  const ticket = source?.tickets.find((entry) => entry.key === settings.ticketKey);
  if (ticket === undefined) {
    return {
      kind: 'unattributed',
      reason:
        `the source handoff record at "${file}" does not name issue ${settings.ticketKey} as a ` +
        'created ticket',
    };
  }
  return ticket.linked === true && ticket.admission?.completed === true
    ? { kind: 'legacy' }
    : { kind: 'incomplete' };
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
