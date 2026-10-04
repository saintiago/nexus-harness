import { z } from 'zod';
import { selectionSchema } from '../select-task/artifacts.js';
import type { RecordDeclaration } from '../records.js';

/**
 * SelectWork's source-side declaration files: the parent handoff record retained under the issue
 * workspace's `parent/` area and the stage feedback entry it carries. The record keeps the current
 * stage, the feedback destination and publication identities the parent reuses when a run repeats.
 */

/** The parent handoff area's directory under an issue workspace root. */
export const parentAreaDirectory = 'parent';

/** The parent handoff record's file name under the parent area. */
export const handoffFile = 'handoff.json';

/** Publication identities the parent retained so a repeated write finishes only what is missing. */
export const parentPublicationSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
});

/**
 * One created implementation ticket and the effects the parent already finished for it: the link
 * to the original and the rank relative to its prerequisite. An effect recorded as not yet
 * finished is completed on the next handoff invocation before the ticket counts as handed off.
 */
export const handoffTicketSchema = z.object({
  key: z.string().min(1),
  issueId: z.string().min(1),
  plannedTask: z.number().int().nonnegative().optional(),
  summary: z.string().min(1),
  linked: z.boolean().optional(),
  ranked: z.boolean().optional(),
  admission: z.object({ initialStatus: z.string().min(1), completed: z.boolean() }).optional(),
});

export type HandoffTicket = z.infer<typeof handoffTicketSchema>;

/**
 * One upstream return the parent published: the stage that returned the work, the earlier stage
 * that must correct the named input and the concrete problem, consequence and needed correction.
 * The destination stage reads it as a required input until its own publication clears it.
 */
export const stageReturnSchema = z.object({
  from: z.enum(['requirements', 'ux', 'prototype', 'architecture']),
  to: z.enum(['idea', 'requirements', 'ux', 'prototype']),
  problem: z.string().min(1),
  consequence: z.string().min(1),
  correction: z.string().min(1),
});

export type StageReturn = z.infer<typeof stageReturnSchema>;

/**
 * The parent-owned handoff record: the current stage, the retained upstream-return count, the
 * feedback destination a Waiting for Feedback publication retains, the return finding the
 * destination stage must correct, the created implementation tickets and the publication
 * identities the parent already finished.
 */
export const parentHandoffSchema = z.object({
  /** The stage the selected issue currently runs; the parent's route input on restore. */
  stage: z.enum(['idea', 'requirements', 'ux', 'prototype', 'architecture', 'delivery']),
  /** Upstream-return allowances consumed by the selected issue, counted across restarts. */
  upstreamReturns: z.number().int().nonnegative(),
  /** The stage and specific question retained when the issue waits for human feedback. */
  feedback: z
    .object({
      stage: z.enum(['idea', 'requirements', 'ux', 'prototype', 'architecture']),
      question: z.string().min(1),
    })
    .nullable(),
  /** The upstream return the parent published; the destination stage reads it, its own clears it. */
  return: stageReturnSchema.nullable(),
  /** Implementation tickets the Architecture handoff created for this issue. */
  tickets: z.array(handoffTicketSchema),
  /** Publication identities the parent observed, such as a comment or documentation pull request. */
  publications: z.array(parentPublicationSchema),
});

export type ParentHandoff = z.infer<typeof parentHandoffSchema>;

/** The record declaration the parent actions import instead of restating the file or shape. */
export const parentHandoffDeclaration = {
  file: handoffFile,
  schema: parentHandoffSchema,
} satisfies RecordDeclaration<typeof parentHandoffSchema>;

/** The record's initial value for a freshly selected issue. */
export function initialHandoff(stage: ParentHandoff['stage']): ParentHandoff {
  return {
    stage,
    upstreamReturns: 0,
    feedback: null,
    return: null,
    tickets: [],
    publications: [],
  };
}

/** SelectWork's failed candidate, independent of any earlier selection. */
export const selectionFailureDeclaration = {
  file: 'selection-failure.json',
  schema: z.object({
    taskKey: z.string().min(1),
    source: z.object({ kind: z.literal('jira'), issueId: z.string().min(1) }),
    reason: z.string().min(1),
    selection: selectionSchema.nullable(),
  }),
} satisfies RecordDeclaration;

export type SelectionFailure = z.infer<typeof selectionFailureDeclaration.schema>;
