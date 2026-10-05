import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { messageOf, type ArtifactRef } from '../../result.js';
import { artifactRefSchema, readAssignedReport } from './agent-reports.js';
import { describeIssues, parseDocument, readDocumentText } from './documents.js';

/**
 * The shared report-feedback plumbing: the runtime-validated rejection and correction
 * declarations one report owner retains under its area's report-feedback/ directory, the
 * outstanding-feedback derivation that retires a rejection only through a valid matching
 * correction, and the invocation-context rendering that hands a rejected report back to its
 * responsible producer. The helpers choose no verdict, route nothing and add no invocation,
 * allowance, escalation or retry policy; the validating caller owns each evidence write and the
 * responsible producer owns validation of the replacement. See the action architecture's
 * rejection evidence and continuation section.
 */

/** The directory one owning area retains its rejection and correction records under. */
export const reportFeedbackDirectory = 'report-feedback';

/** The report responsibility one rejection or correction belongs to. */
export const reportScopeSchema = z.strictObject({
  project: z.string().trim().min(1),
  workId: z.string().trim().min(1),
  area: z.string().trim().min(1).describe('The absolute owning area, not the repository checkout.'),
  role: z.string().trim().min(1),
  reportKind: z
    .string()
    .trim()
    .min(1)
    .describe('Distinguishes incompatible response contracts of one role.'),
});

export type ReportScope = z.infer<typeof reportScopeSchema>;

/**
 * One rejected report's immutable evidence: the exact returned bytes when available, the specific
 * violated rule and the invocation, operation, profile and original-round attribution. `source`
 * names a malformed saved record whose readable bytes are the rejected output. `report` is an
 * immutable copy of the available rejected Markdown; `assignedReport` is the attempted path, even
 * when the report is unreadable or missing. `invocationId` is null only when importing
 * unattributed retained evidence.
 */
const reportRejectionFields = {
  kind: z.literal('rejection'),
  scope: reportScopeSchema,
  invocationId: z.string().trim().min(1).nullable(),
  operation: z.string().trim().min(1),
  profile: z.string().trim().min(1).nullable(),
  context: z.string().trim().min(1).describe('The original round, cycle or request and revision.'),
  source: artifactRefSchema.nullable(),
  output: z.string().nullable(),
  reason: z.string().trim().min(1),
};

export const reportRejectionSchema = z.strictObject({
  ...reportRejectionFields,
  report: artifactRefSchema
    .nullable()
    .describe('The immutable copy of the available rejected Markdown, or null.'),
  assignedReport: artifactRefSchema
    .nullable()
    .describe('The attempted report path, even when the report is unreadable or missing.'),
});

export type ReportRejection = z.infer<typeof reportRejectionSchema>;

/**
 * A former rejection record from before Markdown references existed. The two reference fields may
 * be absent; they read as explicitly unavailable without rewriting the retained bytes. The strict
 * current declaration above still governs every record a writer creates now.
 */
const compatibleReportRejectionSchema = z
  .strictObject({
    ...reportRejectionFields,
    report: artifactRefSchema
      .nullable()
      .optional()
      .describe('The immutable copy of the available rejected Markdown, or null.'),
    assignedReport: artifactRefSchema
      .nullable()
      .optional()
      .describe('The attempted report path, even when the report is unreadable or missing.'),
  })
  .transform((record): ReportRejection => ({
    ...record,
    report: record.report ?? null,
    assignedReport: record.assignedReport ?? null,
  }));

/**
 * One recorded correction: the usable replacement a producer validated and saved, its complete
 * saved identity and the exact rejection records it resolves. A correction is evidence of report
 * usability, not stage acceptance, review approval or task completion.
 */
export const reportCorrectionSchema = z.strictObject({
  kind: z.literal('correction'),
  scope: reportScopeSchema,
  rejections: z.array(artifactRefSchema).min(1),
  artifact: artifactRefSchema,
  artifactIdentity: z.string().trim().min(1),
  invocationId: z.string().trim().min(1).nullable(),
});

export type ReportCorrection = z.infer<typeof reportCorrectionSchema>;

/** The one record declaration consumers and evidence-importing roles share. */
export const reportFeedbackSchema = z.discriminatedUnion('kind', [
  reportRejectionSchema,
  reportCorrectionSchema,
]);

/** The record declaration readers accept: current records plus former rejections without refs. */
const retainedReportFeedbackSchema = z.union([
  reportFeedbackSchema,
  compatibleReportRejectionSchema,
]);

export type ReportFeedbackRecord = z.infer<typeof reportFeedbackSchema>;

/** One retained feedback record with the file that holds it. */
export type RetainedReportFeedback<Record extends ReportFeedbackRecord = ReportFeedbackRecord> = {
  readonly record: Record;
  readonly path: string;
};

/** The feedback directory of one owning area. */
export function reportFeedbackRoot(areaRoot: string): string {
  return path.join(areaRoot, reportFeedbackDirectory);
}

/** One feedback record's file under its owning area. */
export function reportFeedbackRecordFile(areaRoot: string, recordId: string): string {
  return path.join(reportFeedbackRoot(areaRoot), `${recordId}.json`);
}

/** The stable identity of one complete saved record's content. */
export function recordIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * The configured project identity implied by the Workspace layout
 * `<storage root>/workspaces/<project>/<issue>/`: the issue root's parent directory. Records are
 * stored inside their owning area, so the project names attribution rather than access.
 */
export function projectOfWorkspace(issueWorkspaceRoot: string): string {
  return path.basename(path.dirname(path.resolve(issueWorkspaceRoot)));
}

/** A record ID that sorts chronologically and stays unique within one owning area. */
function nextRecordId(): string {
  return `${Date.now().toString(36).padStart(9, '0')}-${randomUUID()}`;
}

/** The feedback record declaration text for a role that must write one itself (recovery). */
export function reportFeedbackDeclarationText(): string {
  return [
    'Report feedback records (the report owner writes one immutable JSON file per record under ' +
      `${reportFeedbackDirectory}/<record-id>.json in the owning area; use a unique record ID):`,
    'Report rejection record:',
    JSON.stringify(z.toJSONSchema(reportRejectionSchema), null, 2),
    'Report correction record:',
    JSON.stringify(z.toJSONSchema(reportCorrectionSchema), null, 2),
  ].join('\n');
}

/**
 * Write one rejection or correction record completely: the JSON lands in a temporary file that
 * atomically replaces the target, so an interrupted write cannot leave a half-written record that
 * would make the feedback set unusable. A unique record ID keeps every rejection immutable.
 */
export async function writeReportFeedbackRecord(
  areaRoot: string,
  record: ReportFeedbackRecord,
  recordId: string = nextRecordId(),
): Promise<ArtifactRef> {
  const file = reportFeedbackRecordFile(areaRoot, recordId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(reportFeedbackRoot(areaRoot), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(`The report feedback at "${file}" could not be written: ${messageOf(error)}`, {
      cause: error,
    });
  }
  return { path: file };
}

/** Read every retained feedback record of one owning area, in record-ID order. */
export async function readReportFeedback(
  areaRoot: string,
): Promise<readonly RetainedReportFeedback[]> {
  const directory = reportFeedbackRoot(areaRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(`Report feedback at "${directory}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const records: RetainedReportFeedback[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const file = path.join(directory, entry);
    const text = await readDocumentText(file, 'Report feedback');
    if (text === null) {
      continue;
    }
    const parsed = parseDocument(text, retainedReportFeedbackSchema);
    if (parsed.kind === 'invalid-json') {
      throw new Error(
        `Report feedback at "${file}" is not valid JSON: ${messageOf(parsed.error)}`,
        {
          cause: parsed.error,
        },
      );
    }
    if (parsed.kind === 'invalid-content') {
      throw new Error(
        `Report feedback at "${file}" does not match its declared content type: ` +
          describeIssues(parsed.error, '<record>'),
        { cause: parsed.error },
      );
    }
    records.push({ record: parsed.content, path: file });
  }
  return records;
}

/** True when two report scopes name the same report responsibility. */
export function sameReportScope(left: ReportScope, right: ReportScope): boolean {
  return (
    left.project === right.project &&
    left.workId === right.workId &&
    left.area === right.area &&
    left.role === right.role &&
    left.reportKind === right.reportKind
  );
}

/**
 * The rejections of one report responsibility that remain outstanding: no retained correction
 * with the same scope references their exact record. Invalid correction declarations never retire
 * a rejection, and an unreadable feedback record is an explicit error rather than an empty set.
 */
export async function outstandingReportFeedback(settings: {
  readonly areaRoot: string;
  readonly scope: ReportScope;
}): Promise<readonly RetainedReportFeedback<ReportRejection>[]> {
  const records = await readReportFeedback(settings.areaRoot);
  const corrections = records
    .filter((entry): entry is RetainedReportFeedback<ReportCorrection> => {
      return (
        entry.record.kind === 'correction' && sameReportScope(entry.record.scope, settings.scope)
      );
    })
    .map((entry) => entry.record);
  return records.filter((entry): entry is RetainedReportFeedback<ReportRejection> => {
    if (entry.record.kind !== 'rejection' || !sameReportScope(entry.record.scope, settings.scope)) {
      return false;
    }
    return !corrections.some((correction) =>
      correction.rejections.some((reference) => reference.path === entry.path),
    );
  });
}

/** Retain one rejected report's exact evidence, then fail with its reason. */
export async function rejectReport(settings: {
  readonly areaRoot: string;
  readonly scope: ReportScope;
  readonly invocationId: string | null;
  readonly operation: string;
  readonly profile: string | null;
  readonly context: string;
  readonly source: ArtifactRef | null;
  readonly output: string | null;
  readonly reason: string;
  readonly assignedReport?: ArtifactRef | null;
  readonly cause?: unknown;
}): Promise<never> {
  const recordId = nextRecordId();
  const assignedReport = settings.assignedReport ?? null;
  let report: ArtifactRef | null = null;
  if (assignedReport !== null) {
    try {
      // Available rejected Markdown is copied byte-for-byte into the feedback area before the
      // error is raised; a missing or unreadable report stays explicitly unavailable with its
      // attempted path retained.
      const retained = await readAssignedReport(assignedReport.path, 'Rejected report');
      const copy = path.join(reportFeedbackRoot(settings.areaRoot), `${recordId}.md`);
      await mkdir(reportFeedbackRoot(settings.areaRoot), { recursive: true });
      await writeFile(copy, retained.bytes);
      report = { path: copy };
    } catch {
      report = null;
    }
  }
  try {
    await writeReportFeedbackRecord(
      settings.areaRoot,
      {
        kind: 'rejection',
        scope: settings.scope,
        invocationId: settings.invocationId,
        operation: settings.operation,
        profile: settings.profile,
        context: settings.context,
        source: settings.source,
        output: settings.output,
        reason: settings.reason,
        report,
        assignedReport,
      },
      recordId,
    );
  } catch (error) {
    throw new Error(
      `${settings.reason} The rejection evidence could not be saved: ${messageOf(error)}`,
      { cause: error },
    );
  }
  throw new Error(settings.reason, { cause: settings.cause });
}

/**
 * The report reference an unusable record's readable bytes name, recovered only so available
 * rejected Markdown can be copied as evidence. Recovery is structural: it neither accepts the
 * damaged record nor validates the outcome it holds.
 */
function recoverAssignedReport(output: string | null): ArtifactRef | null {
  if (output === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const report = (value as { report?: unknown }).report;
  if (typeof report !== 'object' || report === null) {
    return null;
  }
  const candidate = (report as { path?: unknown }).path;
  return typeof candidate === 'string' && candidate.trim() !== '' ? { path: candidate } : null;
}

/**
 * Retain an unusable retained record's readable bytes and path as rejection evidence, then fail
 * with the original read failure. Available Markdown referenced by the damaged record is copied
 * with its attempted path; unavailable bytes stay explicit.
 */
export async function rejectUnusableRecord(settings: {
  readonly areaRoot: string;
  readonly scope: ReportScope;
  readonly invocationId: string | null;
  readonly operation: string;
  readonly profile: string | null;
  readonly context: string;
  readonly file: string;
  readonly error: unknown;
  /** The record's attempted report path, when the unusable record carries a binding. */
  readonly assignedReport?: ArtifactRef | null;
}): Promise<never> {
  let output: string | null = null;
  let explanation = '';
  try {
    output = await readDocumentText(settings.file, 'Rejected record');
  } catch (error) {
    explanation = ` The record's bytes could not be read: ${messageOf(error)}`;
  }
  if (output === null) {
    explanation = explanation === '' ? ' The record has no readable bytes.' : explanation;
  }
  return rejectReport({
    areaRoot: settings.areaRoot,
    scope: settings.scope,
    invocationId: settings.invocationId,
    operation: settings.operation,
    profile: settings.profile,
    context: settings.context,
    source: { path: settings.file },
    output,
    reason: `${messageOf(settings.error)}${explanation}`,
    assignedReport: settings.assignedReport ?? recoverAssignedReport(output),
    cause: settings.error,
  });
}

/**
 * Record a correction after the owning action validated and saved the usable replacement. Every
 * named rejection must exist with the same scope; a correction that cannot name its exact
 * rejection evidence is an error, and no evidence is retired without one.
 */
export async function recordReportCorrection(settings: {
  readonly areaRoot: string;
  readonly scope: ReportScope;
  readonly rejections: readonly ArtifactRef[];
  readonly artifact: ArtifactRef;
  readonly content: unknown;
  readonly invocationId: string | null;
}): Promise<ArtifactRef> {
  const records = await readReportFeedback(settings.areaRoot);
  for (const reference of settings.rejections) {
    const found = records.find(
      (entry) => entry.path === reference.path && entry.record.kind === 'rejection',
    );
    if (found === undefined) {
      throw new Error(`The correction names no retained rejection record at "${reference.path}".`);
    }
    if (!sameReportScope(found.record.scope, settings.scope)) {
      throw new Error(
        `The rejection record at "${reference.path}" belongs to another report responsibility.`,
      );
    }
  }
  return writeReportFeedbackRecord(settings.areaRoot, {
    kind: 'correction',
    scope: settings.scope,
    rejections: settings.rejections.map((reference) => ({ path: reference.path })),
    artifact: { path: settings.artifact.path },
    artifactIdentity: recordIdentity(settings.content),
    invocationId: settings.invocationId,
  });
}

/**
 * The evidence that one invocation was supplied a set of outstanding rejections before it ran.
 * It attributes a saved replacement to the exact records that invocation answered, so an
 * interrupted correction write can finish on replay without retiring a later rejection.
 */
export const suppliedFeedbackSchema = z.strictObject({
  invocationId: z.string().trim().min(1),
  rejections: z.array(artifactRefSchema).min(1),
});

export type SuppliedFeedback = z.infer<typeof suppliedFeedbackSchema>;

/** One invocation's supplied-rejection evidence file under its owning area. */
export function suppliedFeedbackFile(areaRoot: string, invocationId: string): string {
  return path.join(reportFeedbackRoot(areaRoot), 'supplied', `${invocationId}.json`);
}

/** Retain which outstanding rejections one invocation is supplied before it runs. */
export async function retainSuppliedFeedback(settings: {
  readonly areaRoot: string;
  readonly invocationId: string;
  readonly rejections: readonly ArtifactRef[];
}): Promise<ArtifactRef> {
  const file = suppliedFeedbackFile(settings.areaRoot, settings.invocationId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          invocationId: settings.invocationId,
          rejections: settings.rejections.map((reference) => ({ path: reference.path })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(
      `The supplied-rejection evidence at "${file}" could not be written: ${messageOf(error)}`,
      { cause: error },
    );
  }
  return { path: file };
}

/** The rejections one invocation was supplied, or null when no evidence was retained. */
export async function readSuppliedFeedback(
  areaRoot: string,
  invocationId: string,
): Promise<SuppliedFeedback | null> {
  const file = suppliedFeedbackFile(areaRoot, invocationId);
  const text = await readDocumentText(file, 'Supplied-rejection evidence');
  if (text === null) {
    return null;
  }
  const parsed = parseDocument(text, suppliedFeedbackSchema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(
      `Supplied-rejection evidence at "${file}" is not valid JSON: ${messageOf(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `Supplied-rejection evidence at "${file}" does not match its declared content type: ` +
        describeIssues(parsed.error, '<evidence>'),
      { cause: parsed.error },
    );
  }
  if (parsed.content.invocationId !== invocationId) {
    throw new Error(
      `Supplied-rejection evidence at "${file}" belongs to invocation ` +
        `${parsed.content.invocationId}, not ${invocationId}.`,
    );
  }
  return parsed.content;
}

/**
 * Finish recording the correction a saved outcome's invocation owes: the rejections that
 * invocation was supplied and that no correction has resolved yet. Only the supplied records are
 * named, so a rejection created after that invocation stays outstanding. Returns whether a
 * correction was recorded.
 */
export async function finishSuppliedCorrection(settings: {
  readonly areaRoot: string;
  readonly scope: ReportScope;
  readonly invocationId: string;
  readonly artifact: ArtifactRef;
  readonly content: unknown;
}): Promise<boolean> {
  const supplied = await readSuppliedFeedback(settings.areaRoot, settings.invocationId);
  if (supplied === null) {
    return false;
  }
  const suppliedPaths = new Set(supplied.rejections.map((reference) => reference.path));
  const outstanding = await outstandingReportFeedback({
    areaRoot: settings.areaRoot,
    scope: settings.scope,
  });
  const addressed = outstanding.filter((entry) => suppliedPaths.has(entry.path));
  if (addressed.length === 0) {
    return false;
  }
  await recordReportCorrection({
    areaRoot: settings.areaRoot,
    scope: settings.scope,
    rejections: addressed.map((entry) => ({ path: entry.path })),
    artifact: settings.artifact,
    content: settings.content,
    invocationId: settings.invocationId,
  });
  return true;
}

/**
 * The invocation context one responsible producer receives: the outstanding rejection reason,
 * original invocation/operation/profile/round attribution and the exact rejected output, labelled
 * as rejected historical evidence. Current input, current response rules and finding obligations
 * remain authoritative.
 */
export function reportFeedbackContextText(
  entries: readonly RetainedReportFeedback<ReportRejection>[],
): string[] {
  if (entries.length === 0) {
    return [];
  }
  const lines = [
    `Outstanding report rejection${entries.length === 1 ? '' : 's'} of this report ` +
      'responsibility (rejected historical evidence, never approved work or governing intent; ' +
      'the current input, response rules and finding obligations remain authoritative):',
  ];
  for (const { record, path: file } of entries) {
    lines.push(
      `- Rejected ${record.operation} report (${record.scope.role}` +
        `${record.profile === null ? '' : `, profile ${record.profile}`})` +
        `${record.invocationId === null ? '' : `, invocation ${record.invocationId}`}.`,
      `  Violated rule: ${record.reason}`,
      `  Original attribution: ${record.context}`,
      `  Retained rejection evidence: ${file}`,
    );
    if (record.output === null) {
      lines.push('  The rejected output itself is unavailable; do not invent or reconstruct it.');
    } else {
      lines.push(
        '  Rejected output (exact returned bytes):',
        '  ---',
        ...record.output.split('\n').map((line) => `  ${line}`),
        '  ---',
      );
    }
    if (record.report === null) {
      lines.push(
        '  The rejected Markdown report itself is unavailable; do not invent or reconstruct it.',
      );
    } else {
      lines.push(`  Rejected Markdown report (exact copy): ${record.report.path}`);
    }
    if (record.assignedReport !== null) {
      lines.push(`  Assigned report path as attempted: ${record.assignedReport.path}`);
    }
    if (record.source !== null) {
      lines.push(`  Rejected source record: ${record.source.path}`);
    }
  }
  lines.push(
    'A usable replacement must be returned through this same role and response contract; ' +
      'saving it records the correction and retires this feedback.',
  );
  return [lines.join('\n')];
}
