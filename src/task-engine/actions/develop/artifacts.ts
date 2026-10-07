import { z } from 'zod';
import { readBoundReport, retainedReportBindingFields } from '../agent-reports.js';
import { roundArtifactPath, type ArtifactDeclaration } from '../artifacts.js';
import { readRecord } from '../records.js';
import {
  finishSuppliedCorrection,
  projectOfWorkspace,
  rejectUnusableRecord,
  type ReportScope,
} from '../report-feedback.js';

/**
 * Develop's artifact contract: the saved Markdown report bound to the observed repository
 * revisions. The agent returns only the status its workflow consumes; the action records the
 * profile, revisions and report association it observed.
 */

const developmentFields = {
  /** Task subject captured for this report; older reports may omit it. */
  taskSubject: z.string().optional(),
  taskKey: z.string().min(1).describe('The task key this report belongs to.'),
  profile: z.string().min(1).describe('The developer profile that produced the revision.'),
  status: z
    .enum(['completed', 'failed'])
    .describe(
      'Completed when the implementation is committed on the prepared branch and ready for ' +
        'verification; failed when it could not be completed.',
    ),
  baseRevision: z.string().min(1).describe('The comparison base the work started from.'),
  headRevision: z.string().min(1).describe('The committed revision this report describes.'),
};

/** The saved development outcome: the assigned Markdown report bound to observed revisions. */
export const developmentOutputSchema = z.strictObject({
  ...developmentFields,
  role: z.literal('developer'),
  ...retainedReportBindingFields,
  readinessFailure: z
    .string()
    .nullable()
    .describe('The action-observed condition that prevented ready committed work, or null.'),
});

export type DevelopmentOutput = z.infer<typeof developmentOutputSchema>;

/** A retained combined development report from before the narrative/outcome separation. */
export const legacyDevelopmentOutputSchema = z.strictObject({
  ...developmentFields,
  summary: z.string().describe('The former combined narrative this report used to carry.'),
  findingResponses: z.unknown().optional(),
});

export type LegacyDevelopmentOutput = z.infer<typeof legacyDevelopmentOutputSchema>;

/**
 * The producer-owned reader: a current outcome requires its report binding, while a retained
 * combined report stays readable as history. A record carrying any binding field must satisfy the
 * current schema; a damaged new record never falls back to legacy parsing.
 */
export const retainedDevelopmentOutputSchema = z.union([
  developmentOutputSchema,
  legacyDevelopmentOutputSchema,
]);

export type RetainedDevelopmentOutput = z.infer<typeof retainedDevelopmentOutputSchema>;

/** True when one retained development outcome carries the current report binding. */
export function isBoundDevelopmentOutput(
  outcome: RetainedDevelopmentOutput,
): outcome is DevelopmentOutput {
  return 'report' in outcome;
}

/** The developer report's readable text: the saved Markdown or the former combined summary. */
export async function developmentReportText(outcome: RetainedDevelopmentOutput): Promise<string> {
  return isBoundDevelopmentOutput(outcome)
    ? (await readBoundReport(outcome, 'Development report')).text
    : outcome.summary;
}

export const devArtifact = {
  pathFromArtifactsRoot: 'development.json',
  schema: retainedDevelopmentOutputSchema,
} satisfies ArtifactDeclaration<typeof retainedDevelopmentOutputSchema>;

/** The developer report responsibility of one owning area and the task it answers for. */
export function developmentReportScope(areaRoot: string, taskKey: string): ReportScope {
  return {
    project: projectOfWorkspace(areaRoot),
    workId: taskKey,
    area: areaRoot,
    role: 'developer',
    reportKind: 'development',
  };
}

/**
 * Require one retained development outcome to be usable for a workflow decision: it must describe
 * the expected task and, when it carries the current report binding, its assigned Markdown must be
 * readable. An unusable outcome is preserved under the developer's report responsibility as
 * attributable rejection evidence before the read fails. A retained combined report stays readable
 * history, and the check never makes a damaged outcome usable.
 * After validation, finish any interrupted correction attributed to this saved invocation, so
 * retained continuation also reconciles it when Develop itself is skipped.
 */
export async function requireUsableDevelopmentOutcome(settings: {
  readonly areaRoot: string;
  readonly taskKey: string;
  readonly file: string;
  readonly outcome: RetainedDevelopmentOutput;
  readonly invocationId: string | null;
  readonly context: string;
}): Promise<void> {
  try {
    if (settings.outcome.taskKey !== settings.taskKey) {
      throw new Error(
        `The development result at "${settings.file}" is for task ` +
          `"${settings.outcome.taskKey}", not "${settings.taskKey}".`,
      );
    }
    if (isBoundDevelopmentOutput(settings.outcome)) {
      await readBoundReport(settings.outcome, 'Development report');
    }
  } catch (error) {
    return await rejectUnusableRecord({
      areaRoot: settings.areaRoot,
      scope: developmentReportScope(settings.areaRoot, settings.taskKey),
      invocationId: settings.invocationId,
      operation: 'develop',
      profile: settings.outcome.profile,
      context: settings.context,
      file: settings.file,
      assignedReport: isBoundDevelopmentOutput(settings.outcome) ? settings.outcome.report : null,
      error,
    });
  }
  if (isBoundDevelopmentOutput(settings.outcome)) {
    await finishSuppliedCorrection({
      areaRoot: settings.areaRoot,
      scope: developmentReportScope(settings.areaRoot, settings.taskKey),
      invocationId: settings.outcome.invocationId,
      artifact: { path: settings.file },
      content: settings.outcome,
    });
  }
}

/**
 * Read the current round's saved development outcome for a decision outside Develop. An absent
 * record is null; an unusable record is preserved as the developer's rejection evidence before
 * the read fails; a returned outcome has already passed its task and report-binding checks.
 */
export async function readUsableDevelopmentOutcome(settings: {
  readonly areaRoot: string;
  readonly taskKey: string;
  readonly round: number;
  readonly context: string;
}): Promise<RetainedDevelopmentOutput | null> {
  const file = roundArtifactPath(
    settings.areaRoot,
    settings.round,
    devArtifact.pathFromArtifactsRoot,
  );
  let outcome: RetainedDevelopmentOutput | null;
  try {
    outcome = await readRecord(file, {
      file: devArtifact.pathFromArtifactsRoot,
      schema: devArtifact.schema,
    });
  } catch (error) {
    return await rejectUnusableRecord({
      areaRoot: settings.areaRoot,
      scope: developmentReportScope(settings.areaRoot, settings.taskKey),
      invocationId: null,
      operation: 'develop',
      profile: null,
      context: settings.context,
      file,
      error,
    });
  }
  if (outcome !== null) {
    await requireUsableDevelopmentOutcome({
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

/** The agent's response: only the status its workflow consumes. */
export const developmentResponseSchema = z.strictObject({
  status: developmentFields.status,
});

export type DevelopmentResponse = z.infer<typeof developmentResponseSchema>;
