import { z } from 'zod';
import type { RecordDeclaration } from '../records.js';

/**
 * SelectWork's selection record: the chosen task, its complete source input and the workspace
 * reference the workflow retains. The record sits beside the queue's workflow-state file, outside
 * every task workspace, and consumers read it directly instead of through the round helpers.
 */

/** The record's file name; Application binds its directory beside the workflow-state file. */
export const selectionFile = 'selection.json';

/**
 * The project stages the parent routes a selected issue to. The stage is captured with the
 * selection so an interrupted parent restores the active child instead of re-reading Jira.
 */
export const workflowStages = [
  'idea',
  'requirements',
  'ux',
  'prototype',
  'architecture',
  'delivery',
] as const;

export type WorkflowStage = (typeof workflowStages)[number];

/** The selection document. Task and conversation keep the source's native structures. */
export const selectionSchema = z.object({
  taskKey: z.string().min(1),
  source: z.object({ kind: z.literal('jira'), issueId: z.string().min(1) }),
  task: z.unknown(),
  conversation: z.array(z.unknown()),
  workspace: z.object({ root: z.string().min(1) }),
  /** The stage this selection entered; the parent invokes that stage's child. */
  stage: z.enum(workflowStages),
});

/** The selected task, complete source input and retained workspace reference. */
export type Selection = z.infer<typeof selectionSchema>;

export const selectionDeclaration = {
  file: selectionFile,
  schema: selectionSchema,
} satisfies RecordDeclaration<typeof selectionSchema>;
