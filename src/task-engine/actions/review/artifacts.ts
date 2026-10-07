import { z } from 'zod';
import { readBoundReport, retainedReportBindingFields } from '../agent-reports.js';
import { roundArtifactPath, type ArtifactDeclaration } from '../artifacts.js';
import { readRecord } from '../records.js';
import { projectOfWorkspace, rejectUnusableRecord, type ReportScope } from '../report-feedback.js';

/**
 * Review's artifact contract: the saved Markdown review and the verdict it supports, bound to the
 * revision actually reviewed. Findings live in the Markdown report and have no machine contract;
 * the agent returns only the verdict its workflow consumes.
 */

const reviewFields = {
  /** Task subject captured for this report; older reports may omit it. */
  taskSubject: z.string().optional(),
  profile: z.string().min(1).describe('The reviewer profile that produced this verdict.'),
  headRevision: z.string().min(1).describe('The exact revision this verdict reviews.'),
  verdict: z
    .enum(['approved', 'changesRequested'])
    .describe(
      'Approved requires sufficient evidence and no current blocking finding; changesRequested ' +
        'requires at least one.',
    ),
};

/** The saved review outcome: the assigned Markdown review bound to the reviewed revision. */
export const reviewOutputSchema = z.strictObject({
  ...reviewFields,
  taskKey: z.string().min(1).describe('The task key this review belongs to.'),
  role: z.literal('reviewer'),
  ...retainedReportBindingFields,
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/**
 * A retained combined review from before the narrative/outcome separation: its former narrative
 * and finding arrays stay readable history without their removed lifecycle or consistency rules.
 */
export const legacyReviewOutputSchema = z.strictObject({
  ...reviewFields,
  taskKey: z.string().optional(),
  summary: z.string().describe('The former combined narrative this review used to carry.'),
  findings: z.array(z.unknown()).describe('The former structured findings, kept as history.'),
  priorFindings: z.unknown().optional(),
});

export type LegacyReviewOutput = z.infer<typeof legacyReviewOutputSchema>;

/**
 * The producer-owned reader: a current outcome requires its report binding, while a retained
 * combined review stays readable as history. A record carrying any binding field must satisfy the
 * current schema; a damaged new record never falls back to legacy parsing.
 */
export const retainedReviewOutputSchema = z.union([reviewOutputSchema, legacyReviewOutputSchema]);

export type RetainedReviewOutput = z.infer<typeof retainedReviewOutputSchema>;

/** True when one retained review outcome carries the current report binding. */
export function isBoundReviewOutput(outcome: RetainedReviewOutput): outcome is ReviewOutput {
  return 'report' in outcome;
}

/** The review's readable Markdown text, or the former combined narrative. */
export async function reviewReportText(outcome: RetainedReviewOutput): Promise<string> {
  return isBoundReviewOutput(outcome)
    ? (await readBoundReport(outcome, 'Review report')).text
    : outcome.summary;
}

export const reviewArtifact = {
  pathFromArtifactsRoot: 'review.json',
  schema: retainedReviewOutputSchema,
} satisfies ArtifactDeclaration<typeof retainedReviewOutputSchema>;

/** The reviewer report responsibility of one owning area and the task it answers for. */
export function reviewReportScope(areaRoot: string, taskKey: string): ReportScope {
  return {
    project: projectOfWorkspace(areaRoot),
    workId: taskKey,
    area: areaRoot,
    role: 'reviewer',
    reportKind: 'review',
  };
}

/**
 * Require one retained review outcome to be usable for a workflow decision: it must describe the
 * expected task (when the retained record names one) and, when it carries the current report
 * binding, its assigned Markdown must be readable. An unusable outcome is preserved under the
 * reviewer's report responsibility as attributable validation-error evidence before the read
 * fails. A retained combined review stays readable history. This shared validation serves history
 * and other consumers; clearing pending context belongs to the owner's current-round reader and
 * save paths.
 */
export async function requireUsableReviewOutcome(settings: {
  readonly areaRoot: string;
  readonly taskKey: string;
  readonly file: string;
  readonly outcome: RetainedReviewOutput;
  readonly invocationId: string | null;
  readonly context: string;
}): Promise<void> {
  try {
    if (settings.outcome.taskKey !== undefined && settings.outcome.taskKey !== settings.taskKey) {
      throw new Error(
        `The review result at "${settings.file}" is for task ` +
          `"${settings.outcome.taskKey}", not "${settings.taskKey}".`,
      );
    }
    if (isBoundReviewOutput(settings.outcome)) {
      await readBoundReport(settings.outcome, 'Review report');
    }
  } catch (error) {
    return await rejectUnusableRecord({
      areaRoot: settings.areaRoot,
      scope: reviewReportScope(settings.areaRoot, settings.taskKey),
      invocationId: settings.invocationId,
      operation: 'review',
      profile: settings.outcome.profile,
      context: settings.context,
      file: settings.file,
      assignedReport: isBoundReviewOutput(settings.outcome) ? settings.outcome.report : null,
      error,
    });
  }
}

/**
 * Read the current round's saved review outcome for a decision outside Review. An absent record
 * is null; an unusable record is preserved as the reviewer's validation-error evidence before the
 * read fails; a returned outcome has already passed its task and report-binding checks. Because
 * the caller names the owner's current round, the returned outcome is the current round's record.
 * Reading validates evidence; it never clears the responsibility's pending context. The caller
 * that established the saved outcome as the usable replacement for its own current basis clears
 * it, so a caller whose revision or input checks fail keeps the actionable error for the next
 * responsible invocation.
 */
export async function readUsableReviewOutcome(settings: {
  readonly areaRoot: string;
  readonly taskKey: string;
  readonly round: number;
  readonly context: string;
}): Promise<RetainedReviewOutput | null> {
  const file = roundArtifactPath(
    settings.areaRoot,
    settings.round,
    reviewArtifact.pathFromArtifactsRoot,
  );
  let outcome: RetainedReviewOutput | null;
  try {
    outcome = await readRecord(file, {
      file: reviewArtifact.pathFromArtifactsRoot,
      schema: reviewArtifact.schema,
    });
  } catch (error) {
    return await rejectUnusableRecord({
      areaRoot: settings.areaRoot,
      scope: reviewReportScope(settings.areaRoot, settings.taskKey),
      invocationId: null,
      operation: 'review',
      profile: null,
      context: settings.context,
      file,
      error,
    });
  }
  if (outcome !== null) {
    await requireUsableReviewOutcome({
      areaRoot: settings.areaRoot,
      taskKey: settings.taskKey,
      file,
      outcome,
      invocationId: null,
      context: settings.context,
    });
  }
  return outcome;
}

/** The agent's response: only the verdict its workflow consumes. */
export const reviewResponseSchema = z.strictObject({
  verdict: reviewFields.verdict,
});

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;
