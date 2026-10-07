import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { messageOf, type ArtifactRef } from '../../result.js';
import { artifactRefSchema, readAssignedReport } from './agent-reports.js';
import { describeIssues, parseDocument, readDocumentText } from './documents.js';

/**
 * The shared validation-error plumbing: the readable evidence history one owning area retains
 * under its area's report-feedback/ directory, the one pending validation-error context per
 * responsible work/role/response variant, the invocation-context rendering that hands a rejected
 * report back to its responsible producer, and the one-time conversion of a former
 * rejection/correction ledger into that simple context. The helpers choose no verdict, route
 * nothing and add no invocation, allowance, escalation or retry policy; the validating caller
 * owns each evidence write and the responsible producer owns validation of the replacement. See
 * the action architecture's rejection evidence and continuation section.
 */

/** The directory one owning area retains its validation-error history and pending context under. */
export const reportFeedbackDirectory = 'report-feedback';

/** The report responsibility one pending validation error belongs to. */
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

/** The observed attribution and available evidence of one rejected report. */
const validationErrorFields = {
  invocationId: z.string().trim().min(1).nullable(),
  operation: z.string().trim().min(1),
  profile: z.string().trim().min(1).nullable(),
  context: z.string().trim().min(1).describe('The original round, cycle or request and revision.'),
  source: artifactRefSchema.nullable(),
  output: z.string().nullable(),
  reason: z.string().trim().min(1),
};

/**
 * One rejected report's readable history record: the specific violated rule, the invocation,
 * operation, profile and original-round attribution, and the available rejected bytes. `source`
 * names a malformed saved record whose readable bytes are the rejected output. `report` is an
 * immutable copy of the available rejected Markdown; `assignedReport` is the attempted path, even
 * when the report is unreadable or missing. `invocationId` is null only when importing
 * unattributed retained evidence. Records are history: clearing pending context never removes or
 * rewrites them.
 */
export const reportValidationErrorSchema = z.strictObject({
  kind: z.literal('validation-error'),
  scope: reportScopeSchema,
  ...validationErrorFields,
  report: artifactRefSchema
    .nullable()
    .describe('The immutable copy of the available rejected Markdown, or null.'),
  assignedReport: artifactRefSchema
    .nullable()
    .describe('The attempted report path, even when the report is unreadable or missing.'),
});

export type ReportValidationError = z.infer<typeof reportValidationErrorSchema>;

/** One readable history record with the file that holds it. */
export type RetainedValidationError = {
  readonly record: ReportValidationError;
  readonly path: string;
};

/** One entry of a pending context: attribution, the violated rule and the available evidence. */
const pendingEntrySchema = z.strictObject({
  ...validationErrorFields,
  report: artifactRefSchema
    .nullable()
    .describe('The immutable copy of the available rejected Markdown, or null.'),
  assignedReport: artifactRefSchema
    .nullable()
    .describe('The attempted report path, even when the report is unreadable or missing.'),
  evidence: artifactRefSchema.describe('The readable history record this entry was retained as.'),
});

export type PendingValidationErrorEntry = z.infer<typeof pendingEntrySchema>;

/**
 * The one pending validation-error context of a responsible work/role/response variant. It names
 * the actionable reason, the original attribution and the available rejected output/report
 * evidence. A later invalid attempt updates it with its useful diagnosis while the earlier
 * evidence stays readable history; owner validation of a saved replacement clears it.
 */
export const pendingValidationErrorSchema = z.strictObject({
  kind: z.literal('pending-validation-error'),
  scope: reportScopeSchema,
  entries: z.array(pendingEntrySchema).min(1),
});

export type PendingValidationError = z.infer<typeof pendingValidationErrorSchema>;

/**
 * The stable identity of one complete saved record's content. Producer-owned decisions use it to
 * bind an accepted decision to the exact record it assessed; it is not a report-validation
 * mechanism and never hashes Markdown bytes.
 */
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

/** The feedback directory of one owning area. */
export function reportFeedbackRoot(areaRoot: string): string {
  return path.join(areaRoot, reportFeedbackDirectory);
}

/** The readable validation-error history of one owning area. */
export function reportFeedbackHistoryRoot(areaRoot: string): string {
  return path.join(reportFeedbackRoot(areaRoot), 'history');
}

/** One history record's file under its owning area. */
export function reportFeedbackRecordFile(areaRoot: string, recordId: string): string {
  return path.join(reportFeedbackHistoryRoot(areaRoot), `${recordId}.json`);
}

/** One path segment that keeps a work/role/variant readable without escaping its directory. */
function variantSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The one pending-context file of one responsible work/role/response variant. Distinct variants
 * never share a file, so unrelated work items, roles and response contracts stay isolated.
 */
export function pendingValidationErrorFile(areaRoot: string, scope: ReportScope): string {
  return path.join(
    reportFeedbackRoot(areaRoot),
    'pending',
    variantSegment(scope.workId),
    variantSegment(scope.role),
    variantSegment(scope.reportKind),
    'pending.json',
  );
}

/** Write one document completely: a temporary file atomically replaces the target. */
async function writeComplete(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** One readable rejection record of the former rejection/correction ledger. */
const legacyRejectionFields = {
  kind: z.literal('rejection'),
  scope: reportScopeSchema,
  invocationId: z.string().trim().min(1).nullable(),
  operation: z.string().trim().min(1),
  profile: z.string().trim().min(1).nullable(),
  context: z.string().trim().min(1),
  source: artifactRefSchema.nullable(),
  output: z.string().nullable(),
  reason: z.string().trim().min(1),
};

/** A former rejection record, without or with the Markdown references report separation added. */
const legacyRejectionSchema = z.union([
  z.strictObject({
    ...legacyRejectionFields,
    report: artifactRefSchema.nullable(),
    assignedReport: artifactRefSchema.nullable(),
  }),
  z.strictObject(legacyRejectionFields),
]);

/** A former correction record: a rejection-reference list matched by complete record identity. */
const legacyCorrectionSchema = z.strictObject({
  kind: z.literal('correction'),
  scope: reportScopeSchema,
  rejections: z.array(artifactRefSchema).min(1),
  artifact: artifactRefSchema,
  artifactIdentity: z.string().trim().min(1),
  invocationId: z.string().trim().min(1).nullable(),
});

/** The former feedback declarations a moved ledger may retain. */
const legacyFeedbackSchema = z.union([legacyRejectionSchema, legacyCorrectionSchema]);

type LegacyFeedback = z.infer<typeof legacyFeedbackSchema>;

/** A former rejection record read back as the readable validation-error history it now is. */
function legacyRejectionAsValidationError(
  record: z.infer<typeof legacyRejectionSchema>,
): ReportValidationError {
  return {
    kind: 'validation-error',
    scope: record.scope,
    invocationId: record.invocationId,
    operation: record.operation,
    profile: record.profile,
    context: record.context,
    source: record.source,
    output: record.output,
    reason: record.reason,
    report: 'report' in record ? record.report : null,
    assignedReport: 'assignedReport' in record ? record.assignedReport : null,
  };
}

/**
 * One history file as the readable record it holds: a current validation-error record, or a
 * former rejection record whose bytes the conversion preserved as readable history.
 */
const readableHistorySchema = z.union([reportValidationErrorSchema, legacyRejectionSchema]);

/** True when two report scopes name the same report responsibility. */
function sameReportScope(left: ReportScope, right: ReportScope): boolean {
  return (
    left.project === right.project &&
    left.workId === right.workId &&
    left.area === right.area &&
    left.role === right.role &&
    left.reportKind === right.reportKind
  );
}

/**
 * Move one former ledger file into readable history, keeping its bytes and its recorded ID so
 * retained references stay meaningful. Historical files are evidence only: no reader of the
 * pending context or of new evidence consults them, so clearing context cannot reimport them.
 */
async function moveToHistory(file: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await rename(file, target).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw new Error(
      `The former report feedback at "${file}" could not be moved into readable history: ` +
        `${messageOf(error)}`,
      { cause: error },
    );
  });
}

/**
 * Convert a former rejection/correction ledger into the simple pending contexts and readable
 * history: the still-actionable unresolved rejections of every responsibility become that
 * responsibility's pending context, previously resolved diagnostics stay history, and the former
 * ledger and supplied-feedback files move into history so a later clear cannot reimport them. A
 * former correction resolves only the rejections of its own responsibility, and rejections retire
 * before the corrections that resolve them so an interruption between moves cannot reopen
 * resolved history. No migration marker or journal is introduced; an interrupted conversion
 * retries from the remaining original diagnostics, and an existing pending context is never
 * overwritten.
 */
async function convertLegacyReportFeedback(areaRoot: string): Promise<void> {
  const root = reportFeedbackRoot(areaRoot);
  const historyRoot = reportFeedbackHistoryRoot(areaRoot);
  const historyTargetFor = (file: string): string => path.join(historyRoot, path.basename(file));
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw new Error(`Report feedback at "${root}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const files = entries
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(root, name));
  const legacy: { readonly record: LegacyFeedback; readonly path: string }[] = [];
  for (const file of files) {
    const text = await readDocumentText(file, 'Report feedback');
    if (text === null) {
      continue;
    }
    const parsed = parseDocument(text, legacyFeedbackSchema);
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
    legacy.push({ record: parsed.content, path: file });
  }
  if (legacy.length === 0) {
    return;
  }
  // A former correction resolved exactly the rejections of its own responsibility, so a
  // correction of another work/role/variant never retires this one's diagnostic.
  const resolved = new Set<string>();
  for (const entry of legacy) {
    if (entry.record.kind !== 'correction') {
      continue;
    }
    for (const reference of entry.record.rejections) {
      const candidate = legacy.find((other) => other.path === reference.path);
      if (
        candidate !== undefined &&
        candidate.record.kind === 'rejection' &&
        sameReportScope(entry.record.scope, candidate.record.scope)
      ) {
        resolved.add(reference.path);
      }
    }
  }
  const unresolved = legacy.filter(
    (entry) => entry.record.kind === 'rejection' && !resolved.has(entry.path),
  );
  const scopes: ReportScope[] = [];
  for (const entry of unresolved) {
    const scope = entry.record.scope;
    if (!scopes.some((candidate) => sameReportScope(candidate, scope))) {
      scopes.push(scope);
    }
  }
  for (const scope of scopes) {
    const file = pendingValidationErrorFile(areaRoot, scope);
    if ((await readDocumentText(file, 'Pending validation-error context')) !== null) {
      continue;
    }
    const records = unresolved
      .filter((entry) => sameReportScope(entry.record.scope, scope))
      .map((entry): PendingValidationErrorEntry => {
        const record = entry.record as z.infer<typeof legacyRejectionSchema>;
        return {
          invocationId: record.invocationId,
          operation: record.operation,
          profile: record.profile,
          context: record.context,
          source: record.source,
          output: record.output,
          reason: record.reason,
          report: 'report' in record ? record.report : null,
          assignedReport: 'assignedReport' in record ? record.assignedReport : null,
          evidence: { path: historyTargetFor(entry.path) },
        };
      });
    const pending: PendingValidationError = {
      kind: 'pending-validation-error',
      scope,
      entries: records,
    };
    try {
      await writeComplete(file, `${JSON.stringify(pending, null, 2)}\n`);
    } catch (error) {
      throw new Error(
        `The pending validation-error context at "${file}" could not be written: ` +
          `${messageOf(error)}`,
        { cause: error },
      );
    }
  }
  // Retire the rejections before the corrections that resolve them: an interruption between moves
  // must never leave a rejection active without the resolution evidence a later conversion needs,
  // or an already resolved diagnostic would reopen as pending context.
  for (const entry of legacy) {
    if (entry.record.kind === 'rejection') {
      await moveToHistory(entry.path, historyTargetFor(entry.path));
    }
  }
  for (const entry of legacy) {
    if (entry.record.kind === 'correction') {
      await moveToHistory(entry.path, path.join(historyRoot, 'legacy', path.basename(entry.path)));
    }
  }
  const supplied = path.join(root, 'supplied');
  let suppliedEntries: string[];
  try {
    suppliedEntries = await readdir(supplied);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    suppliedEntries = [];
  }
  for (const name of suppliedEntries) {
    await moveToHistory(path.join(supplied, name), path.join(historyRoot, 'supplied', name));
  }
  await rm(supplied, { recursive: true, force: true });
}

/** Read every readable validation-error history record of one owning area, in file order. */
export async function readValidationErrorHistory(
  areaRoot: string,
): Promise<readonly RetainedValidationError[]> {
  const directory = reportFeedbackHistoryRoot(areaRoot);
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
  const records: RetainedValidationError[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    const file = path.join(directory, entry);
    const text = await readDocumentText(file, 'Report feedback');
    if (text === null) {
      continue;
    }
    const parsed = parseDocument(text, readableHistorySchema);
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
    records.push({
      record:
        parsed.content.kind === 'validation-error'
          ? parsed.content
          : legacyRejectionAsValidationError(parsed.content),
      path: file,
    });
  }
  return records;
}

/**
 * The pending validation-error context of one responsible work/role/response variant, or null
 * when none is pending. A former ledger is converted first, so an owner always continues from the
 * simple context before it invokes or clears. A missing file means no pending context; an
 * unreadable or foreign one is an explicit storage error rather than an empty context.
 */
export async function readPendingValidationError(settings: {
  readonly areaRoot: string;
  readonly scope: ReportScope;
}): Promise<PendingValidationError | null> {
  await convertLegacyReportFeedback(settings.areaRoot);
  const file = pendingValidationErrorFile(settings.areaRoot, settings.scope);
  const text = await readDocumentText(file, 'Pending validation-error context');
  if (text === null) {
    return null;
  }
  const parsed = parseDocument(text, pendingValidationErrorSchema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(
      `The pending validation-error context at "${file}" is not valid JSON: ` +
        `${messageOf(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `The pending validation-error context at "${file}" does not match its declared content ` +
        `type: ${describeIssues(parsed.error, '<context>')}`,
      { cause: parsed.error },
    );
  }
  if (!sameReportScope(parsed.content.scope, settings.scope)) {
    throw new Error(
      `The pending validation-error context at "${file}" belongs to another report ` +
        'responsibility.',
    );
  }
  return parsed.content;
}

/**
 * Clear one responsibility's pending context after its owner validated and saved a replacement
 * under the owner's normal functional, readable-report and applicable input/revision checks. This
 * includes valid negative business outcomes and a replay of an interrupted save/clear: mere edits
 * or the existence of a historical file are insufficient, and no proof that the replacement's
 * invocation received particular errors is required. The readable history is never removed.
 * A retention interrupted between its context and its readable record completes that record here,
 * so clearing never discards a diagnosis the context promised as retained evidence. Returns
 * whether a pending context existed.
 */
export async function clearPendingValidationError(settings: {
  readonly areaRoot: string;
  readonly scope: ReportScope;
}): Promise<boolean> {
  const pending = await readPendingValidationError(settings);
  if (pending === null) {
    return false;
  }
  for (const entry of pending.entries) {
    await completeRetainedEvidence(pending.scope, entry);
  }
  const file = pendingValidationErrorFile(settings.areaRoot, settings.scope);
  try {
    await rm(file, { force: true });
  } catch (error) {
    throw new Error(
      `The pending validation-error context at "${file}" could not be cleared: ${messageOf(error)}`,
      { cause: error },
    );
  }
  return true;
}

/**
 * Complete one evidence record the pending context promises but an interrupted retention did not
 * write. The context carries the complete record, so the readable history gains nothing new; an
 * existing record is left untouched.
 */
async function completeRetainedEvidence(
  scope: ReportScope,
  entry: PendingValidationErrorEntry,
): Promise<void> {
  if (
    (await readDocumentText(entry.evidence.path, 'Retained validation-error evidence')) !== null
  ) {
    return;
  }
  try {
    await writeComplete(
      entry.evidence.path,
      `${JSON.stringify(
        {
          kind: 'validation-error',
          scope,
          invocationId: entry.invocationId,
          operation: entry.operation,
          profile: entry.profile,
          context: entry.context,
          source: entry.source,
          output: entry.output,
          reason: entry.reason,
          report: entry.report,
          assignedReport: entry.assignedReport,
        } satisfies ReportValidationError,
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    throw new Error(
      `The retained validation-error evidence at "${entry.evidence.path}" could not be saved: ` +
        `${messageOf(error)}`,
      { cause: error },
    );
  }
}

/**
 * Retain one rejected report's pending context and readable history, then fail with its reason.
 * The context is written first: an interruption between the two writes still reaches the next
 * responsible invocation with the actionable rule. Before replacing that context or clearing it,
 * complete any readable records it alone retains. An unusable area reports the original problem
 * together with the storage failure and grants no acceptance.
 */
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
      // Available rejected Markdown is copied byte-for-byte into the history area before the
      // error is raised; a missing or unreadable report stays explicitly unavailable with its
      // attempted path retained.
      const retained = await readAssignedReport(assignedReport.path, 'Rejected report');
      const copy = path.join(reportFeedbackHistoryRoot(settings.areaRoot), `${recordId}.md`);
      await mkdir(reportFeedbackHistoryRoot(settings.areaRoot), { recursive: true });
      await writeFile(copy, retained.bytes);
      report = { path: copy };
    } catch {
      report = null;
    }
  }
  const file = reportFeedbackRecordFile(settings.areaRoot, recordId);
  const pendingFile = pendingValidationErrorFile(settings.areaRoot, settings.scope);
  const pending: PendingValidationError = {
    kind: 'pending-validation-error',
    scope: settings.scope,
    entries: [
      {
        invocationId: settings.invocationId,
        operation: settings.operation,
        profile: settings.profile,
        context: settings.context,
        source: settings.source,
        output: settings.output,
        reason: settings.reason,
        report,
        assignedReport,
        evidence: { path: file },
      },
    ],
  };
  try {
    const previous = await readPendingValidationError(settings);
    if (previous !== null) {
      for (const entry of previous.entries) {
        await completeRetainedEvidence(previous.scope, entry);
      }
    }
    await writeComplete(pendingFile, `${JSON.stringify(pending, null, 2)}\n`);
  } catch (error) {
    throw new Error(
      `${settings.reason} The pending validation-error context could not be saved: ` +
        `${messageOf(error)}`,
      { cause: error },
    );
  }
  try {
    await writeComplete(
      file,
      `${JSON.stringify(
        {
          kind: 'validation-error',
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
        } satisfies ReportValidationError,
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    throw new Error(
      `${settings.reason} The validation-error evidence could not be saved; its pending context ` +
        `is retained: ${messageOf(error)}`,
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
 * Retain an unusable retained record's readable bytes and path as validation-error evidence, then
 * fail with the original read failure. Available Markdown referenced by the damaged record is
 * copied with its attempted path; unavailable bytes stay explicit.
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
 * The invocation context one responsible producer receives: the pending actionable reason, the
 * original invocation/operation/profile/round attribution and the available rejected
 * output/report evidence, labelled as rejected historical evidence. Current input, current
 * response rules and finding obligations remain authoritative.
 */
export function validationErrorContextText(pending: PendingValidationError | null): string[] {
  if (pending === null) {
    return [];
  }
  const lines = [
    `Pending validation error${pending.entries.length === 1 ? '' : 's'} of this report ` +
      'responsibility (rejected historical evidence, never approved work or governing intent; ' +
      'the current input, response rules and finding obligations remain authoritative):',
  ];
  for (const entry of pending.entries) {
    lines.push(
      `- Rejected ${entry.operation} report (${pending.scope.role}` +
        `${entry.profile === null ? '' : `, profile ${entry.profile}`})` +
        `${entry.invocationId === null ? '' : `, invocation ${entry.invocationId}`}.`,
      `  Violated rule: ${entry.reason}`,
      `  Original attribution: ${entry.context}`,
      `  Retained validation-error evidence: ${entry.evidence.path}`,
    );
    if (entry.output === null) {
      lines.push('  The rejected output itself is unavailable; do not invent or reconstruct it.');
    } else {
      lines.push(
        '  Rejected output (exact returned bytes):',
        '  ---',
        ...entry.output.split('\n').map((line) => `  ${line}`),
        '  ---',
      );
    }
    if (entry.report === null) {
      lines.push(
        '  The rejected Markdown report itself is unavailable; do not invent or reconstruct it.',
      );
    } else {
      lines.push(`  Rejected Markdown report (exact copy): ${entry.report.path}`);
    }
    if (entry.assignedReport !== null) {
      lines.push(`  Assigned report path as attempted: ${entry.assignedReport.path}`);
    }
    if (entry.source !== null) {
      lines.push(`  Rejected source record: ${entry.source.path}`);
    }
  }
  lines.push(
    'A usable replacement must be returned through this same role and response contract; the ' +
      'owner validates and saves it, then clears this pending context.',
  );
  return [lines.join('\n')];
}
