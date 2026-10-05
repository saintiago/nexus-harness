import { z } from 'zod';
import { reportBindingSchema } from '../agent-reports.js';
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
 * to the original, the rank relative to its prerequisite and the recorded admission. An effect
 * recorded as not yet finished is completed on the next handoff invocation before the ticket
 * counts as handed off.
 */
export const handoffTicketSchema = z.object({
  key: z.string().min(1),
  issueId: z.string().min(1),
  plannedTask: z.number().int().nonnegative().optional(),
  summary: z.string().min(1),
  linked: z.boolean().optional(),
  ranked: z.boolean().optional(),
  /** The initial status observed at creation and whether the configured admission was applied. */
  admission: z.object({ initialStatus: z.string().min(1), completed: z.boolean() }).optional(),
});

export type HandoffTicket = z.infer<typeof handoffTicketSchema>;

/**
 * The immutable basis one handoff froze before its first source effect: the identity of the
 * evaluated plan it maps, the planned task count and the committed preparation revision the
 * first implementation continues. A changed plan or preparation history requests reconciliation
 * instead of applying changed positions to retained ticket identities.
 */
export const handoffBasisSchema = z.object({
  planIdentity: z.string().min(1),
  taskCount: z.number().int().positive(),
  continuationHead: z.string().min(1),
});

export type HandoffBasis = z.infer<typeof handoffBasisSchema>;

/**
 * One upstream return the parent published: the stage that returned the work, the earlier stage
 * that must correct the named input and the concrete correction it needs. The returning role's
 * saved Markdown report binding carries the problem and consequence and every reader validates the
 * bytes it names; former combined returns retain their problem and consequence text as history
 * instead. The destination stage reads the record as a required input until its own publication
 * clears it.
 */
export const stageReturnSchema = z.object({
  from: z.enum(['requirements', 'ux', 'prototype', 'architecture']),
  to: z.enum(['idea', 'requirements', 'ux', 'prototype']),
  role: z
    .enum(['author', 'evaluator'])
    .nullable()
    .default(null)
    .describe('The returning role whose saved Markdown report explains this return.'),
  problem: z.string().min(1).optional(),
  consequence: z.string().min(1).optional(),
  report: reportBindingSchema
    .nullable()
    .default(null)
    .describe("The returning role's saved Markdown report binding, or null on a former return."),
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
  /**
   * The preparation stages whose current decisions a correction invalidated: each must obtain a
   * current decision before the route advances past it. Retained across restarts so a pending
   * reassessment is never silently dropped or mistaken for the earlier acceptance.
   */
  awaitingStages: z.array(z.enum(['requirements', 'ux', 'prototype', 'architecture'])).default([]),
  /** Implementation tickets the Architecture handoff created for this issue. */
  tickets: z.array(handoffTicketSchema),
  /** The frozen plan/repository basis; null until the handoff's first source effect. */
  basis: handoffBasisSchema.nullable().default(null),
  /** Publication identities the parent observed, such as the preparation-handoff comment. */
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
    awaitingStages: [],
    tickets: [],
    basis: null,
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
