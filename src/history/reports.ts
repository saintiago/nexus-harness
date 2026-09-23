/**
 * The complete developer and reviewer reports, kept beside the workspace before
 * anything concise is published.
 *
 * A run's own `result.json` and a review's record already exist, and they are
 * reused where they do: a digest written here points at the complete rendering
 * and at the verbatim record, and synchronization turns both into conversation
 * entries. A report the harness knows existed but can no longer read — a ledger
 * attempt whose `result.json` is gone, or a review record whose verdict was
 * never kept — becomes an explicit missing marker carrying the record's own
 * words and the path that was looked for. Nothing here invents a report.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import type { SourceRef } from '../shared/types.js';
import { readWorkspaceState } from '../workspace/state.js';
import type {
  DeveloperReportRequest,
  HistoryFinding,
  HistoryDelivery,
  HistoryFindingVerification,
  HistoryReportSummary,
  HistoryOccurrence,
  PublishedDeveloperReport,
  RecordedReport,
  ReviewerReportRequest,
  UnidentifiedFinding,
} from './contract.js';
import { HistoryError } from './contract.js';
import { readBaselineReports } from './baseline.js';
import { identifyFindings } from './findings.js';
import { historyReportsDir } from './paths.js';
import { compareHistoryTime } from './time.js';

/**
 * The digest of one complete developer report, as `<root>/reports/developer-<runId>.json`
 * records it. It is the machine-readable half; the complete rendering is the
 * Markdown file it names, and the run's own report is copied verbatim beside it.
 */
export interface DeveloperReportDigest {
  readonly version: 1;
  readonly kind: 'developer-report';
  readonly runId: string;
  readonly ref: SourceRef;
  readonly workspaceId: string;
  readonly round: number;
  readonly task: { readonly id: string; readonly title: string };
  readonly status: string;
  readonly reason: string;
  readonly repairsUsed: number;
  readonly attempts: readonly {
    readonly turn: number;
    readonly kind: string;
    readonly agentSummary: string | null;
    readonly checks: string | null;
  }[];
  readonly pullRequest: HistoryDelivery | null;
  readonly deliveryFailure: string | null;
  readonly createdAt: string;
  /**
   * The comment this complete report was published as, once the source
   * acknowledged it. It is the recorded publication identity synchronization
   * authenticates a mirrored rendering against; a report saved but never
   * published carries `null`.
   */
  readonly published: DeveloperPublication | null;
  /** The complete rendering, relative to the reports directory. */
  readonly textFile: string;
  /** The verbatim `result.json`, relative to the reports directory; `null` when it could not be copied. */
  readonly recordFile: string | null;
  /** Why the verbatim record is absent, when it is. */
  readonly recordProblem: string | null;
}

/** The recorded publication of one complete developer report. */
export interface DeveloperPublication {
  /** The source's own identity for the comment: a Jira comment id. */
  readonly commentId: string;
  readonly url: string | null;
  /** The SHA-256 of the text that was published, so an edit is visible. */
  readonly textSha256: string;
}

/** The digest of one complete reviewer report. */
export interface ReviewerReportDigest {
  readonly version: 1;
  readonly kind: 'reviewer-report';
  readonly reviewId: string;
  readonly ref: SourceRef;
  readonly workspaceId: string;
  readonly round: number | null;
  readonly task: { readonly id: string; readonly title: string };
  readonly head: string;
  readonly decision: string;
  readonly summary: string;
  /**
   * The findings this report raises, each with the stable identity it keeps. A
   * record read back without identities is assigned them from the round and the
   * finding's position (`findingIdOf`).
   */
  readonly findings: readonly HistoryFinding[];
  /** What this review verified about the dispositions earlier rounds raised. */
  readonly verifications?: readonly HistoryFindingVerification[];
  readonly createdAt: string;
  readonly textFile: string;
  readonly recordFile: string | null;
  readonly recordProblem: string | null;
  /** An acknowledged Jira rendering, including separate completion context. */
  readonly jiraPublication?: DeveloperPublication & {
    readonly text?: string;
    readonly contextText?: string;
  };
  /** The native review GitHub published for this report, once it exists. */
  readonly published: {
    readonly id: number;
    readonly url: string;
    /**
     * The SHA-256 of the review body that was published, when it was recorded.
     * It is `null` for a publication recorded before the body was kept, which
     * is a publication identity that still authenticates the review itself.
     */
    readonly bodySha256: string | null;
  } | null;
}

/** One local report as synchronization reads it. */
export type LocalReport =
  | {
      readonly kind: 'developer-report';
      readonly digest: DeveloperReportDigest;
      readonly text: string;
      readonly complete: boolean;
      readonly problem: string | null;
      /** True when the digest was rebuilt from an existing run record. */
      readonly legacy: boolean;
    }
  | {
      readonly kind: 'reviewer-report';
      readonly digest: ReviewerReportDigest;
      readonly text: string;
      readonly complete: boolean;
      readonly problem: string | null;
      readonly legacy: boolean;
    }
  | {
      readonly kind: 'missing-report';
      readonly role: 'developer' | 'reviewer';
      readonly sourceId: string;
      readonly ref: SourceRef;
      readonly round: number | null;
      readonly createdAt: string;
      readonly text: string;
      readonly problem: string;
      readonly reportPath: string | null;
    };

/** Writes `text` atomically: a reader sees the old file, the new one, or none. */
async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, file);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** One report file inside the reports directory, refused when it escapes it. */
function reportFile(root: string, name: string): string {
  const dir = historyReportsDir(root);
  const file = path.join(dir, name);
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
    throw new HistoryError(
      'write',
      `"${name}" is not a report file name this harness writes, so it will not be used as one.`,
    );
  }
  return file;
}

/** One rendered line, so a report field cannot open a section of its own. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The SHA-256 of one published rendering. It is what tells a rendering the
 * harness published from one that was edited afterwards: the recorded identity
 * names the comment, and this digest says whether its text is still the text
 * the harness sent.
 */
export function textSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The complete developer report as Markdown: every field the run recorded. */
function developerReportText(
  request: Omit<DeveloperReportRequest, 'task'> & {
    readonly task: DeveloperReportDigest['task'];
  },
): string {
  const lines = [
    `# Developer report — ${request.ref.key}, round ${String(request.round)}`,
    '',
    `- Run: ${request.runId}`,
    `- Task: ${request.task.id} — ${oneLine(request.task.title)}`,
    `- Outcome: ${request.status}`,
    `- Reason: ${oneLine(request.reason)}`,
    `- Repairs used: ${String(request.repairsUsed)}`,
    `- Run report: ${request.reportPath}`,
  ];
  if (request.pullRequest !== null) {
    lines.push(
      `- Delivered to: ${request.pullRequest.url ?? '(no pull request URL was recorded)'}` +
        (request.pullRequest.head === null ? '' : ` at ${request.pullRequest.head}`),
    );
  }
  if (request.deliveryFailure !== null) {
    lines.push(`- Delivery failure: ${oneLine(request.deliveryFailure)}`);
  }
  lines.push('', '## Coding turns', '');
  if (request.attempts.length === 0) {
    lines.push('(no coding turn ran)');
  }
  for (const attempt of request.attempts) {
    lines.push(
      `### Turn ${String(attempt.turn)} (${attempt.kind})`,
      '',
      attempt.agentSummary === null ? 'The agent gave no summary.' : attempt.agentSummary.trim(),
      '',
      `Checks after the turn: ${attempt.checks ?? '(none ran)'}`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The heading one coding turn of a complete developer report opens. */
const TURN_HEADING = /^#{2,6}\s+Turn\s+\d+\s*\(/i;

/**
 * The newest coding turn's own summary of one complete developer report: the
 * text its last `Turn <n>` heading opens, and nothing above it.
 *
 * A run's report holds every coding turn it ran, in order, and each turn states
 * its own answers — or states none. The newest turn is what the developer
 * claims now, so an earlier turn's complete answer is history: it stays
 * readable in the report it was recorded in and is not read as an answer the
 * newest turn never gave (docs/WORKFLOW.md §9). A text that states no coding
 * turn at all is read whole, so a report this harness did not render itself is
 * still searched for the answers it holds.
 */
export function latestCodingTurnText(text: string): string {
  const lines = text.split(/\r?\n/);
  let start: number | null = null;
  for (const [index, line] of lines.entries()) {
    if (TURN_HEADING.test(line)) {
      start = index + 1;
    }
  }
  return start === null ? text : lines.slice(start).join('\n');
}

/**
 * The fields one complete reviewer report rendering is made of. A report this
 * harness recorded carries them directly; one recovered from a reviewer's own
 * retained verdict carries the same fields plus where it was recovered from.
 */
type ReviewerReportFields = {
  readonly ref: SourceRef;
  readonly round: number | null;
  readonly reviewId: string;
  readonly head: string;
  readonly decision: string;
  readonly summary: string;
  /** The findings, each with the identity it keeps. */
  readonly findings: readonly HistoryFinding[];
  /** What this review verified about earlier dispositions, if anything. */
  readonly verifications?: readonly HistoryFindingVerification[];
  /** Where the rendering was recovered from; `null` for a directly recorded report. */
  readonly recoveredFrom?: string | null;
  /** The round a recovered report was recorded with, and how it was read back. */
  readonly recoveredRound?: RecoveredRound | null;
  /** The published review URL, when the review record names one. */
  readonly publishedUrl?: string | null;
};

/** One place a grouped finding names, as the report rendering states it. */
function occurrenceLine(occurrence: HistoryOccurrence): string {
  return `  - also at ${occurrence.path}${
    occurrence.line === null ? '' : `:${String(occurrence.line)}`
  }`;
}

/** How one finding stands against the rounds before it, in the report's words. */
function findingKindLine(finding: HistoryFinding): string | null {
  const kind = finding.kind ?? 'new';
  switch (kind) {
    case 'new':
      return null;
    case 'unresolved':
      return `- Classified: unresolved defect continuing ${
        finding.continues ?? '(an earlier finding it does not name)'
      }`;
    case 'regression':
      return `- Classified: repair regression against ${
        finding.continues ?? '(an earlier finding it does not name)'
      }`;
  }
}

/** The complete reviewer report as Markdown: summary and every finding whole. */
function reviewerReportText(request: ReviewerReportFields): string {
  const lines = [
    `# Reviewer report — ${request.ref.key}, round ${String(request.round)}`,
    '',
    `- Review: ${request.reviewId}`,
    `- Reviewed head: ${request.head}`,
    `- Decision: ${request.decision}`,
  ];
  if (request.recoveredFrom !== undefined && request.recoveredFrom !== null) {
    lines.push(
      `- Recovered from: ${oneLine(request.recoveredFrom)}`,
      `- Original round: ${
        request.recoveredRound === undefined || request.recoveredRound === null
          ? String(request.round)
          : recoveredRoundLine(request.recoveredRound)
      }`,
      `- Publication: ${
        request.publishedUrl === undefined || request.publishedUrl === null
          ? 'this review published no native review'
          : oneLine(request.publishedUrl)
      }`,
    );
  }
  lines.push(
    '',
    '## Summary',
    '',
    request.summary.trim(),
    '',
    `## Findings (${String(request.findings.length)})`,
    '',
  );
  if (request.findings.length === 0) {
    lines.push('(no findings)');
  }
  for (const finding of request.findings) {
    const entries = [
      `### Finding ${finding.id}: ${finding.path}${
        finding.line === null ? '' : `:${String(finding.line)}`
      }`,
      '',
      `- Identity: ${finding.id} — name it by this in a response or a verification.`,
    ];
    if (finding.recordedAs !== undefined) {
      entries.push(
        `- Recorded as: ${finding.recordedAs} — where this review raised the defect again; ` +
          `the identity above (${finding.id}) is the one it keeps.`,
      );
    }
    const classified = findingKindLine(finding);
    if (classified !== null) {
      entries.push(classified);
    }
    entries.push('', finding.body.trim());
    if (finding.related !== undefined && finding.related.length > 0) {
      entries.push(
        '',
        'Confirmed occurrences grouped under this finding:',
        ...finding.related.map(occurrenceLine),
      );
    }
    entries.push('');
    lines.push(...entries);
  }
  const verifications = request.verifications ?? [];
  if (verifications.length > 0) {
    lines.push(
      `## Verification of earlier dispositions (${String(verifications.length)})`,
      '',
      'These are the reviewer’s own readings of the reviewed revision, made at the place each',
      'earlier defect lived. They are verification, not a developer claim: a disposition this',
      'section does not name as `verified` is still not verified.',
      '',
      ...verifications.map(
        (verification) =>
          `- ${verification.finding} — ${verification.state}: ${verification.evidence.trim()}`,
      ),
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Copies the run's own report verbatim. A record that already exists with the
 * same bytes is reused; a different one at a run id this harness already
 * recorded is refused rather than overwritten.
 */
async function copyVerbatim(
  file: string,
  sourcePath: string,
): Promise<{ readonly file: string | null; readonly problem: string | null }> {
  let text: string;
  try {
    text = await readFile(sourcePath, 'utf8');
  } catch (cause) {
    return {
      file: null,
      problem: `the run's own report "${sourcePath}" could not be read: ${messageOf(cause)}`,
    };
  }
  try {
    await writeFile(file, text, { flag: 'wx', encoding: 'utf8' });
    return { file, problem: null };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await readFile(file, 'utf8').catch(() => null);
      if (existing === text) {
        return { file, problem: null };
      }
      return {
        file: null,
        problem:
          `"${file}" already holds a different report for this run, so this harness will not ` +
          'overwrite it; inspect the file and the run directory',
      };
    }
    return { file: null, problem: `"${file}" could not be written: ${messageOf(cause)}` };
  }
}

/**
 * Saves one complete developer report under `<root>/reports`, before any
 * comment that renders it is published. The digest is written last, so a
 * half-finished save is never read as a complete one.
 */
export async function recordDeveloperReport(
  root: string,
  request: DeveloperReportRequest,
): Promise<RecordedReport> {
  const dir = historyReportsDir(root);
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new HistoryError(
      'essential',
      `the ticket history directory "${dir}" could not be created, so the developer report of ` +
        `run ${request.runId} was not saved and no comment rendering it may be published: ` +
        messageOf(cause),
      { cause },
    );
  }
  const textName = `developer-${request.runId}.md`;
  const recordName = `developer-${request.runId}.result.json`;
  const text = developerReportText(request);
  // During a run the complete turn summaries are already available, while the
  // final result does not exist yet. The coordinator enriches this same report
  // after finalization; immutable snapshots retain the earlier version.
  const copied =
    request.status === 'in-progress'
      ? { file: null, problem: null }
      : await copyVerbatim(reportFile(root, recordName), request.reportPath);
  const digest: DeveloperReportDigest = {
    version: 1,
    kind: 'developer-report',
    runId: request.runId,
    ref: request.ref,
    workspaceId: request.workspaceId,
    round: request.round,
    task: { id: request.task.id, title: request.task.title },
    status: request.status,
    reason: request.reason,
    repairsUsed: request.repairsUsed,
    attempts: request.attempts,
    pullRequest: request.pullRequest,
    deliveryFailure: request.deliveryFailure,
    createdAt: request.now.toISOString(),
    published: null,
    textFile: textName,
    recordFile: copied.file === null ? null : recordName,
    recordProblem: copied.problem,
  };
  try {
    await atomicWrite(reportFile(root, textName), text);
    await atomicWrite(
      reportFile(root, `developer-${request.runId}.json`),
      `${JSON.stringify(digest, null, 2)}\n`,
    );
  } catch (cause) {
    throw new HistoryError(
      'essential',
      `the complete developer report of run ${request.runId} could not be saved under "${dir}", ` +
        'so no comment rendering it may be published: ' +
        messageOf(cause),
      { cause },
    );
  }
  return {
    file: reportFile(root, `developer-${request.runId}.json`),
    completeFile: reportFile(root, textName),
    round: request.round,
  };
}

/**
 * Saves one complete reviewer report under `<root>/reports`, before the native
 * review that renders it is published. `published` is attached afterwards, when
 * GitHub acknowledged the review.
 */
export async function recordReviewerReport(
  root: string,
  request: ReviewerReportRequest,
): Promise<RecordedReport> {
  const dir = historyReportsDir(root);
  // The identity is fixed here, once: the round, its findings and every
  // response and verification that follows name the finding by it
  // (docs/WORKFLOW.md §9).
  const findings = identifyFindings(request.findings, request.round);
  const verifications = request.verifications ?? [];
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new HistoryError(
      'essential',
      `the ticket history directory "${dir}" could not be created, so the reviewer report of ` +
        `review ${request.reviewId} was not saved and no review may be published: ` +
        messageOf(cause),
      { cause },
    );
  }
  const textName = `reviewer-${request.reviewId}.md`;
  const recordName = `reviewer-${request.reviewId}.verdict.json`;
  const digest: ReviewerReportDigest = {
    version: 1,
    kind: 'reviewer-report',
    reviewId: request.reviewId,
    ref: request.ref,
    workspaceId: request.workspaceId,
    round: request.round,
    task: { id: request.task.id, title: request.task.title },
    head: request.head,
    decision: request.decision,
    summary: request.summary,
    findings,
    ...(verifications.length === 0 ? {} : { verifications }),
    createdAt: request.now.toISOString(),
    textFile: textName,
    recordFile: recordName,
    recordProblem: null,
    published: null,
  };
  try {
    await atomicWrite(
      reportFile(root, textName),
      reviewerReportText({ ...request, findings, verifications }),
    );
    await atomicWrite(
      reportFile(root, recordName),
      `${JSON.stringify(
        {
          version: 1,
          reviewId: request.reviewId,
          ref: request.ref,
          workspaceId: request.workspaceId,
          task: { id: request.task.id, title: request.task.title },
          head: request.head,
          decision: request.decision,
          summary: request.summary,
          findings,
          verifications,
          recordedAt: digest.createdAt,
        },
        null,
        2,
      )}\n`,
    );
    await atomicWrite(
      reportFile(root, `reviewer-${request.reviewId}.json`),
      `${JSON.stringify(digest, null, 2)}\n`,
    );
  } catch (cause) {
    throw new HistoryError(
      'essential',
      `the complete reviewer report of review ${request.reviewId} could not be saved under ` +
        `"${dir}", so no review may be published: ${messageOf(cause)}`,
      { cause },
    );
  }
  return {
    file: reportFile(root, `reviewer-${request.reviewId}.json`),
    completeFile: reportFile(root, textName),
    round: request.round,
  };
}

/**
 * Attaches the native review GitHub published to the complete report it
 * renders. It is enrichment after publication: the complete report already
 * exists, and a failure here never invalidates it.
 */
export async function notePublishedReview(
  root: string,
  reviewId: string,
  published: { readonly id: number; readonly url: string; readonly body: string },
): Promise<void> {
  const file = reportFile(root, `reviewer-${reviewId}.json`);
  let digest: ReviewerReportDigest;
  try {
    digest = JSON.parse(await readFile(file, 'utf8')) as ReviewerReportDigest;
  } catch {
    return;
  }
  await atomicWrite(
    file,
    `${JSON.stringify(
      {
        ...digest,
        published: {
          id: published.id,
          url: published.url,
          bodySha256: textSha256(published.body),
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** Associate only an acknowledged completion write with its exact native review.
 * The original rendering stays evidence; only its review excerpt is a mirror. */
export async function notePublishedReviewCompletion(
  root: string,
  request: {
    readonly ref: SourceRef;
    readonly nativeReviewId: string;
    readonly head: string;
    readonly commentId: string;
    readonly text: string;
    readonly contextText: string;
  },
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(historyReportsDir(root));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  for (const name of names) {
    if (!/^reviewer-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    const file = reportFile(root, name);
    const value = await readJson(file);
    if (typeof value !== 'object' || value === null) continue;
    const digest = value as ReviewerReportDigest;
    if (
      digest.kind !== 'reviewer-report' ||
      !sameTicket(digest.ref, request.ref) ||
      digest.head !== request.head ||
      String(digest.published?.id) !== request.nativeReviewId
    )
      continue;
    // Never replace the acknowledged original with a later edit/retry.
    if (digest.jiraPublication !== undefined) return;
    await atomicWrite(
      file,
      `${JSON.stringify(
        {
          ...digest,
          jiraPublication: {
            commentId: request.commentId,
            url: `${request.ref.url}?focusedCommentId=${request.commentId}`,
            textSha256: textSha256(request.text),
            text: request.text,
            contextText: request.contextText,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  // Legacy/unretained reports remain ordinary attributed remote evidence. No
  // marker or excerpt can prove a relationship to an unavailable local report.
}

/**
 * Attaches the comment a complete developer report was published as to the
 * report it renders. It is enrichment after publication, exactly like
 * {@link notePublishedReview}: the report and the comment already exist, this
 * records the identity a later synchronization authenticates the rendering by,
 * and a failure here invalidates neither.
 */
export async function notePublishedDeveloperReport(
  root: string,
  request: PublishedDeveloperReport,
): Promise<void> {
  const file = reportFile(root, `developer-${request.runId}.json`);
  let digest: DeveloperReportDigest;
  try {
    digest = JSON.parse(await readFile(file, 'utf8')) as DeveloperReportDigest;
  } catch {
    return;
  }
  const published: DeveloperPublication = {
    commentId: request.commentId,
    url: request.url,
    textSha256: textSha256(request.text),
  };
  await atomicWrite(file, `${JSON.stringify({ ...digest, published }, null, 2)}\n`);
}

/** One JSON object read from a file, or `null` when it is absent or unusable. */
async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Whether one digest names the ticket it is being read for. */
function sameTicket(ref: unknown, wanted: SourceRef): boolean {
  if (typeof ref !== 'object' || ref === null) {
    return false;
  }
  const other = ref as Partial<SourceRef>;
  return other.type === wanted.type && other.scope === wanted.scope && other.id === wanted.id;
}

/**
 * The recorded publication of one developer digest, normalized. A digest
 * written before publication identities were kept names none, and `null` is
 * then the honest answer: the rendering is not authenticated by anything this
 * machine recorded.
 */
function developerPublicationOf(value: unknown): DeveloperPublication | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const commentId = record['commentId'];
  if (typeof commentId !== 'string' || commentId === '') {
    return null;
  }
  return {
    commentId,
    url: typeof record['url'] === 'string' ? record['url'] : null,
    textSha256: typeof record['textSha256'] === 'string' ? record['textSha256'] : '',
  };
}

/** The recorded native review of one reviewer digest, normalized. */
function reviewerPublicationOf(
  value: unknown,
): { readonly id: number; readonly url: string; readonly bodySha256: string | null } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
    return null;
  }
  return {
    id,
    url: typeof record['url'] === 'string' ? record['url'] : '',
    bodySha256: typeof record['bodySha256'] === 'string' ? record['bodySha256'] : null,
  };
}

/** The report summaries a set of local reports contributes to the brief. */
export function reportSummaryOf(report: LocalReport): HistoryReportSummary | null {
  if (report.kind === 'missing-report') {
    return null;
  }
  const digest = report.digest;
  if (digest.kind === 'developer-report') {
    return {
      entryId: `harness:developer-report:${digest.runId}`,
      kind: 'developer-report',
      round: digest.round,
      author: 'Nexus Agent',
      createdAt: digest.createdAt,
      sourceId: digest.runId,
      complete: report.complete,
      problem: report.problem,
      status: digest.status,
      reason: digest.reason,
      head: digest.pullRequest?.head ?? null,
      nativeReviewId: null,
      decision: null,
      summary: null,
      findings: [],
      pullRequest: digest.pullRequest,
    };
  }
  return {
    entryId: `harness:reviewer-report:${digest.reviewId}`,
    kind: 'reviewer-report',
    round: digest.round,
    author: 'Nexus Lens',
    createdAt: digest.createdAt,
    sourceId: digest.reviewId,
    complete: report.complete,
    problem: report.problem,
    status: null,
    reason: null,
    head: digest.head,
    nativeReviewId: digest.published?.id ?? null,
    decision: digest.decision,
    summary: digest.summary,
    findings: identifyFindings(digest.findings, digest.round, digest.reviewId),
    ...(digest.verifications === undefined || digest.verifications.length === 0
      ? {}
      : { verifications: digest.verifications }),
    pullRequest: null,
  };
}

/**
 * The next review round's number for one ticket: one more than the reviewer
 * reports and review records this machine already holds, so the number a report
 * is recorded with is the position the brief and the index show.
 */
export async function nextReviewRound(parts: {
  readonly workDir: string;
  readonly root: string;
  readonly ref: SourceRef;
}): Promise<number> {
  const { workDir, root, ref } = parts;
  const rounds = new Set<string>();
  try {
    for (const name of await readdir(historyReportsDir(root))) {
      if (/^reviewer-[A-Za-z0-9_-]+\.json$/.test(name)) {
        rounds.add(name.slice('reviewer-'.length, -'.json'.length));
      }
    }
  } catch {
    // No reports directory yet: nothing was reviewed.
  }
  try {
    for (const name of await readdir(path.join(path.resolve(workDir), 'reviews'))) {
      const record = await readJson(
        path.join(path.resolve(workDir), 'reviews', name, 'review.json'),
      );
      if (record === null || typeof record !== 'object') {
        continue;
      }
      const value = record as Record<string, unknown>;
      if (sameTicket(value['ref'], ref) && typeof value['reviewId'] === 'string') {
        rounds.add(value['reviewId']);
      }
    }
  } catch {
    // No review directory yet: nothing was reviewed.
  }
  return rounds.size + 1;
}

/**
 * Every report this machine kept for one ticket, plus an explicit marker for
 * each record it knows existed but can no longer read in full. The readers are
 * the workspace's own ledger (one entry per finished attempt) and the review
 * records under `<workDir>/reviews` (one entry per reviewer attempt).
 */
export async function readLocalReports(parts: {
  readonly workDir: string;
  readonly root: string;
  readonly ref: SourceRef;
  readonly workspaceId: string;
  readonly now: Date;
}): Promise<{
  readonly reports: readonly LocalReport[];
  /**
   * The reviewer attempts whose own record names a native review GitHub
   * published, by the attempt's review id: the evidence that the verdict
   * reached the pull request. An attempt refused publication, and one whose
   * record was never written, are absent — nothing published either
   * (docs/spec.md §9).
   */
  readonly publishedReviews: readonly string[];
  readonly problems: readonly string[];
}> {
  const { workDir, root, ref, workspaceId } = parts;
  const reports: LocalReport[] = [];
  const problems: string[] = [];
  const dir = historyReportsDir(root);

  /** Every digest this history root holds, by the run or review it names. */
  const digests = new Map<string, string>();
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(
        `the history reports directory "${dir}" could not be listed: ${messageOf(cause)}`,
      );
    }
    names = [];
  }
  for (const name of names) {
    if (/^developer-[A-Za-z0-9_-]+\.json$/.test(name)) {
      digests.set(`developer:${name.slice('developer-'.length, -'.json'.length)}`, name);
    } else if (/^reviewer-[A-Za-z0-9_-]+\.json$/.test(name)) {
      digests.set(`reviewer:${name.slice('reviewer-'.length, -'.json'.length)}`, name);
    }
  }

  for (const [key, name] of digests) {
    const value = await readJson(reportFile(root, name));
    if (value === null || typeof value !== 'object') {
      problems.push(`the report "${reportFile(root, name)}" could not be read back as JSON`);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (!sameTicket(record['ref'], ref)) {
      continue;
    }
    const textName = typeof record['textFile'] === 'string' ? record['textFile'] : null;
    let text: string | null = null;
    let problem: string | null =
      typeof record['recordProblem'] === 'string' ? record['recordProblem'] : null;
    if (textName === null) {
      problem ??= 'the report digest names no complete text file';
    } else {
      try {
        text = await readFile(reportFile(root, textName), 'utf8');
      } catch (cause) {
        problem = `the complete report "${reportFile(root, textName)}" could not be read: ${messageOf(cause)}`;
      }
    }
    if (key.startsWith('developer:')) {
      const conversationProblem = truncatedDeveloperReport(record['attempts']);
      problem = conversationProblem ?? problem;
      if (typeof record['runId'] !== 'string') {
        problems.push(`the developer report digest "${reportFile(root, name)}" names no run`);
        continue;
      }
      reports.push({
        kind: 'developer-report',
        digest: {
          ...(record as unknown as DeveloperReportDigest),
          published: developerPublicationOf(record['published']),
        },
        text: text ?? '',
        complete: text !== null && conversationProblem === null,
        problem,
        legacy: false,
      });
    } else {
      if (typeof record['reviewId'] !== 'string') {
        problems.push(`the reviewer report digest "${reportFile(root, name)}" names no review`);
        continue;
      }
      reports.push({
        kind: 'reviewer-report',
        digest: {
          ...(record as unknown as ReviewerReportDigest),
          published: reviewerPublicationOf(record['published']),
        },
        text: text ?? '',
        complete: text !== null,
        problem,
        legacy: false,
      });
    }
  }

  /** The workspace's own record of its attempts, reused as developer reports. */
  let ledgerAttempts: readonly {
    readonly runId: string;
    readonly reportPath: string;
    readonly outcome: string;
    readonly reason?: string;
    readonly endedAt: string;
  }[] = [];
  try {
    const ledger = await readWorkspaceState(workDir, workspaceId);
    ledgerAttempts = ledger?.attempts ?? [];
  } catch (cause) {
    problems.push(
      `the workspace ledger of ${workspaceId} could not be read, so its earlier attempts are not ` +
        `represented in this snapshot: ${messageOf(cause)}`,
    );
  }
  const knownRuns = new Map(
    reports
      .filter(
        (report): report is Extract<LocalReport, { kind: 'developer-report' }> =>
          report.kind === 'developer-report',
      )
      .map((report) => [report.digest.runId, report]),
  );
  for (const [index, attempt] of ledgerAttempts.entries()) {
    const retained = knownRuns.get(attempt.runId);
    if (retained !== undefined && retained.digest.status !== 'in-progress') {
      continue;
    }
    const round = index + 1;
    let text: string;
    try {
      text = await readFile(attempt.reportPath, 'utf8');
    } catch {
      text = '';
    }
    if (retained !== undefined) {
      // A crash (or an early coordinator return) can leave the turn digest
      // behind after the runner finalized. Reconcile in this new snapshot;
      // neither the saved digest nor an already-running turn's input changes.
      const rebuilt = legacyDeveloperDigest(attempt.runId, ref, workspaceId, round, text, attempt);
      let problem = text === '' ? `the final report could not be read` : rebuilt.problem;
      if (problem === null && rebuilt.digest.status !== attempt.outcome) {
        problem = 'the final report outcome does not match the finished workspace attempt';
      }
      if (
        problem === null &&
        retained.digest.attempts.some(
          (turn) =>
            !rebuilt.digest.attempts.some(
              (final) =>
                final.turn === turn.turn &&
                final.kind === turn.kind &&
                final.agentSummary === turn.agentSummary,
            ),
        )
      ) {
        problem = 'the final report does not preserve every retained coding turn';
      }
      const recovery = `Recovered final evidence from "${attempt.reportPath}".`;
      const gap =
        problem === null
          ? null
          : `final evidence for run ${attempt.runId} at "${attempt.reportPath}" is unavailable: ${problem}`;
      const digest: DeveloperReportDigest = {
        ...retained.digest,
        status: attempt.outcome,
        reason:
          problem === null ? rebuilt.digest.reason : (attempt.reason ?? retained.digest.reason),
        createdAt: attempt.endedAt,
        attempts: problem === null ? rebuilt.digest.attempts : retained.digest.attempts,
        repairsUsed: problem === null ? rebuilt.digest.repairsUsed : retained.digest.repairsUsed,
        recordProblem: gap,
      };
      reports[reports.indexOf(retained)] = {
        ...retained,
        digest,
        text:
          problem === null
            ? `${developerReportText({ ...digest, reportPath: attempt.reportPath, now: parts.now })}\n${recovery}\n`
            : `${retained.text}\nINCOMPLETE: ${gap}\nThe workspace ledger records ${attempt.outcome}: ${attempt.reason ?? '(no reason recorded)'}.\n`,
        complete: problem === null,
        problem: gap,
      };
      continue;
    }
    if (text === '') {
      reports.push({
        kind: 'missing-report',
        role: 'developer',
        sourceId: attempt.runId,
        ref,
        round,
        createdAt: attempt.endedAt,
        text:
          `The complete developer report of attempt ${String(round)} (run ${attempt.runId}) is ` +
          `missing: "${attempt.reportPath}" could not be read. The workspace ledger records that ` +
          `this attempt ran and ended ${attempt.outcome}` +
          (attempt.reason === undefined ? '' : `: ${oneLine(attempt.reason)}`) +
          '. Its complete wording is not available on this machine; only what was published to ' +
          'Jira or GitHub is.',
        problem:
          `the complete developer report of attempt ${String(round)} (run ${attempt.runId}) is ` +
          `missing at "${attempt.reportPath}"`,
        reportPath: attempt.reportPath,
      });
      continue;
    }
    const rebuilt = legacyDeveloperDigest(attempt.runId, ref, workspaceId, round, text, attempt);
    reports.push({
      kind: 'developer-report',
      digest: rebuilt.digest,
      text: legacyDeveloperText(rebuilt.digest),
      complete: rebuilt.problem === null,
      problem: rebuilt.problem,
      legacy: true,
    });
  }

  /** The review records under `<workDir>/reviews`, one per reviewer attempt. */
  const reviewsRoot = path.join(path.resolve(workDir), 'reviews');
  let reviewNames: readonly string[];
  try {
    reviewNames = await readdir(reviewsRoot);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(
        `the review directory "${reviewsRoot}" could not be listed: ${messageOf(cause)}`,
      );
    }
    reviewNames = [];
  }
  const knownReviews = new Set(
    reports
      .filter(
        (report): report is Extract<LocalReport, { kind: 'reviewer-report' }> =>
          report.kind === 'reviewer-report',
      )
      .map((report) => report.digest.reviewId),
  );
  const records: {
    reviewId: string;
    dir: string;
    startedAt: string;
    endedAt: string | null;
    verdict: string | null;
    problem: string | null;
    published: { readonly id: number; readonly url: string } | null;
    head: string | null;
    url: string | null;
    history: string | null;
  }[] = [];
  for (const name of reviewNames) {
    const value = await readJson(path.join(reviewsRoot, name, 'review.json'));
    if (value === null || typeof value !== 'object') {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (!sameTicket(record['ref'], ref)) {
      continue;
    }
    const reviewed = record['pullRequest'];
    if (
      typeof reviewed === 'object' &&
      reviewed !== null &&
      typeof (reviewed as Record<string, unknown>)['headBranch'] === 'string' &&
      (reviewed as Record<string, unknown>)['headBranch'] !== `harness/${workspaceId}`
    ) {
      // A review of another workspace's draft is not this workspace's history.
      continue;
    }
    const reviewId = typeof record['reviewId'] === 'string' ? record['reviewId'] : null;
    if (reviewId === null) {
      continue;
    }
    const published = record['review'];
    const publishedRecord =
      typeof published === 'object' &&
      published !== null &&
      typeof (published as Record<string, unknown>)['id'] === 'number' &&
      typeof (published as Record<string, unknown>)['url'] === 'string'
        ? {
            id: (published as Record<string, unknown>)['id'] as number,
            url: (published as Record<string, unknown>)['url'] as string,
          }
        : null;
    const reviewedHead =
      typeof reviewed === 'object' && reviewed !== null
        ? ((reviewed as Record<string, unknown>)['headSha'] as unknown)
        : undefined;
    records.push({
      reviewId,
      dir: path.join(reviewsRoot, name),
      startedAt:
        typeof record['startedAt'] === 'string' ? record['startedAt'] : parts.now.toISOString(),
      endedAt: typeof record['endedAt'] === 'string' ? record['endedAt'] : null,
      verdict: typeof record['verdict'] === 'string' ? record['verdict'] : null,
      problem: typeof record['problem'] === 'string' ? record['problem'] : null,
      published: publishedRecord,
      head: typeof reviewedHead === 'string' ? reviewedHead : null,
      url: publishedRecord === null ? null : publishedRecord.url,
      history: typeof record['history'] === 'string' ? record['history'] : null,
    });
  }
  records.sort(
    (a, b) => compareHistoryTime(a.startedAt, b.startedAt) || a.reviewId.localeCompare(b.reviewId),
  );
  // An attempt's own record names the native review GitHub acknowledged for it.
  // When the enrichment that would have noted that same id on the retained
  // digest failed, the record is the remaining evidence of the publication:
  // carrying the recorded identity here matches the retained report to the
  // native review, so reconciliation reads that review's own state and does not
  // reconstruct one review as a second round with a second finding identity
  // (docs/WORKFLOW.md §9). The body hash stays unknown — the retained report is
  // still the complete one — and the rendering is authenticated by the recorded
  // review id alone.
  const publishedByReview = new Map<string, { readonly id: number; readonly url: string }>(
    records.flatMap((record) =>
      record.published === null ? [] : [[record.reviewId, record.published] as const],
    ),
  );
  for (const [index, report] of reports.entries()) {
    if (report.kind !== 'reviewer-report' || report.digest.published !== null) {
      continue;
    }
    const published = publishedByReview.get(report.digest.reviewId);
    if (published === undefined) {
      continue;
    }
    reports[index] = {
      ...report,
      digest: {
        ...report.digest,
        published: { id: published.id, url: published.url, bodySha256: null },
      },
    };
  }
  // The attempts a native review was really published for: the report digest
  // carries the publication identity once the scan recorded it, while the
  // attempt's own record names the review it published even when that note was
  // lost. Either is evidence a verdict became a review; neither is present for
  // a verdict the publication guards refused.
  const publishedReviews = records
    .filter((record) => record.published !== null)
    .map((record) => record.reviewId);

  /**
   * The review attempts this machine can still name, each dated by the earliest
   * evidence that places it: a retained report's own recording time and the
   * review record's start. A recovered report is placed among these only when
   * nothing of its own states its round — and counting them all is what keeps
   * the position it is placed at the position `nextReviewRound` counted, since
   * a retained report is an attempt too (docs/WORKFLOW.md §9).
   */
  const attempts = new Map<string, KnownReviewAttempt>();
  const rememberAttempt = (attempt: KnownReviewAttempt): void => {
    const held = attempts.get(attempt.reviewId);
    attempts.set(
      attempt.reviewId,
      held === undefined
        ? attempt
        : {
            reviewId: attempt.reviewId,
            round: held.round ?? attempt.round,
            at: compareHistoryTime(attempt.at, held.at) < 0 ? attempt.at : held.at,
          },
    );
  };
  for (const report of reports) {
    if (report.kind === 'reviewer-report') {
      rememberAttempt({
        reviewId: report.digest.reviewId,
        round: report.digest.round,
        at: report.digest.createdAt,
      });
    }
  }
  for (const record of records) {
    rememberAttempt({ reviewId: record.reviewId, round: null, at: record.startedAt });
  }
  /** The rounds the retained reports and the already recovered reports name. */
  const claimedRounds = new Set<number>();
  for (const attempt of attempts.values()) {
    if (attempt.round !== null) {
      claimedRounds.add(attempt.round);
    }
  }

  for (const record of records) {
    if (knownReviews.has(record.reviewId)) {
      continue;
    }
    // The reviewer's own verdict is the complete report, and it is retained
    // beside the review record. It is read back before this attempt is called
    // missing, so a review this machine ran is never reported as absent while
    // its findings sit on disk — and the round it was recorded with is read
    // back from the review's own evidence, so the findings keep the identities
    // they were raised with instead of being renamed onto another review's
    // (docs/WORKFLOW.md §9).
    const round = await recoveredReviewRound({
      root,
      record,
      attempts,
      claimed: claimedRounds,
    });
    const recovered = await readRetainedVerdict({
      dir: record.dir,
      record,
      ref,
      workspaceId,
      round,
    });
    if (recovered.report !== null) {
      if (round.round !== null) {
        claimedRounds.add(round.round);
      } else {
        problems.push(
          `the recovered reviewer report (review ${record.reviewId}) keeps the wording of the ` +
            `reviewer's own retained verdict, but the round it was recorded with could not be ` +
            `established: ${round.problem ?? 'no recorded round survived'}. Its findings are named ` +
            `by the review's own identity instead, so recovering it never renames another ` +
            `review's finding`,
        );
      }
      reports.push(recovered.report);
      continue;
    }
    const what =
      record.verdict === null
        ? `its reviewer attempt ended without a published verdict`
        : `it published a ${record.verdict} review`;
    const ofRound = round.round === null ? '' : ` of round ${String(round.round)}`;
    reports.push({
      kind: 'missing-report',
      role: 'reviewer',
      sourceId: record.reviewId,
      ref,
      round: round.round,
      createdAt: record.startedAt,
      text:
        `The complete reviewer report${ofRound} (review ${record.reviewId}) is ` +
        `missing on this machine: the review record says ${what}` +
        (record.url === null ? '' : ` (${record.url})`) +
        (record.problem === null ? '' : `; its recorded problem was: ${oneLine(record.problem)}`) +
        (recovered.problem === null ? '' : `; ${recovered.problem}`) +
        '. Only the published rendering, if any, is available; it may have been bounded for the ' +
        'destination it was published to.',
      problem:
        `the complete reviewer report${ofRound} (review ${record.reviewId}) ` +
        `could not be recovered from this machine` +
        (recovered.problem === null ? '' : `: ${recovered.problem}`) +
        (round.problem === null
          ? ''
          : `; the round it was recorded with could not be established either: ${round.problem}`),
      reportPath: null,
    });
  }

  const baseline = await readBaselineReports({ workDir, ref, workspaceId });
  reports.push(...baseline.reports);
  problems.push(...baseline.problems);
  return { reports, publishedReviews, problems };
}

/** One review record's identity, as the recovery of its verdict reads it. */
interface ReviewRecordIdentity {
  readonly reviewId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly verdict: string | null;
  readonly problem: string | null;
  readonly published: { readonly id: number; readonly url: string } | null;
  readonly head: string | null;
  /** The conversation snapshot this review's turn was prepared with, when the record names one. */
  readonly history: string | null;
}

/**
 * One review attempt this machine can still name: its own review id, the round
 * its retained report states when that report survives, and the earliest
 * evidence that places the attempt in time.
 */
interface KnownReviewAttempt {
  readonly reviewId: string;
  readonly round: number | null;
  readonly at: string;
}

/**
 * The round one recovered reviewer report was originally recorded with, and how
 * this machine read it back.
 *
 * A recovered report's findings keep the identities they were raised with only
 * when the round they were recorded under is restored, because an identity is
 * the round and the finding's position in it. The round is read back from the
 * review's own durable evidence — the conversation snapshot the attempt was
 * prepared with, or the report verdict saved beside its digest — and only when
 * none of it survived from the attempts this machine still holds, counted the
 * way `nextReviewRound` counts them, retained reports included. A round that
 * would name another review's findings the same way is never invented: the
 * findings are named by the review's own identity instead, and the gap is
 * reported (docs/WORKFLOW.md §9).
 */
interface RecoveredRound {
  /** The round the review was recorded with, or `null` when it cannot be established. */
  readonly round: number | null;
  /** Where the round was read back from, or `null` when it could not be established. */
  readonly from: string | null;
  /** Why the round could not be established, or `null` when it was. */
  readonly problem: string | null;
}

/** What one recovered report says about the round it was recorded with, in one line. */
function recoveredRoundNote(round: RecoveredRound): string {
  return round.round === null
    ? `the round it was recorded with could not be established (${
        round.problem ?? 'no recorded round survived'
      }), so its findings are named by the review's own identity instead`
    : `the round it was recorded with, ${String(round.round)}, was read back from ${
        round.from ?? 'its own evidence'
      }`;
}

/** The same reading, as the recovered report's own rendering states it. */
function recoveredRoundLine(round: RecoveredRound): string {
  return round.round === null
    ? `could not be established — its findings are named by the review's own identity; ${
        round.problem ?? 'no recorded round survived'
      }`
    : `${String(round.round)} — read back from ${round.from ?? 'its own evidence'}`;
}

/**
 * The round one saved report verdict was recorded under, read from the
 * identities its findings state. A verdict that carries no finding, or one
 * whose findings do not agree on a round, states none this machine can read,
 * and `null` is then the honest answer.
 */
function recordedRoundOf(saved: unknown): number | null {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
    return null;
  }
  const findings = (saved as Record<string, unknown>)['findings'];
  if (!Array.isArray(findings)) {
    return null;
  }
  let round: number | null = null;
  for (const raw of findings) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return null;
    }
    const finding = raw as Record<string, unknown>;
    // A finding the review raised here states its own round and position as its
    // identity; a continuation keeps the earlier identity it names, and the
    // occurrence this review recorded it as is beside it.
    const recordedAs = finding['recordedAs'];
    const stated = typeof recordedAs === 'string' ? recordedAs : finding['id'];
    if (typeof stated !== 'string') {
      return null;
    }
    const parsed = /^R(\d+)-F\d+$/.exec(stated.trim());
    if (parsed === null || parsed[1] === undefined) {
      return null;
    }
    const held = Number(parsed[1]);
    if (round === null) {
      round = held;
    } else if (round !== held) {
      return null;
    }
  }
  return round;
}

/**
 * Establishes one recovered reviewer report's original round from the review's
 * own durable evidence, never from its position among the review records that
 * remain. A round another review of this ticket already holds is a named gap,
 * not a second identity for one review's findings.
 */
async function recoveredReviewRound(parts: {
  readonly root: string;
  readonly record: ReviewRecordIdentity;
  readonly attempts: ReadonlyMap<string, KnownReviewAttempt>;
  readonly claimed: ReadonlySet<number>;
}): Promise<RecoveredRound> {
  const { record } = parts;
  const settled = (round: number, from: string): RecoveredRound =>
    parts.claimed.has(round)
      ? {
          round: null,
          from: null,
          problem:
            `${from} names round ${String(round)}, which another review of this ticket already ` +
            "holds, so recovering this report under that round would rename that review's finding",
        }
      : { round, from, problem: null };

  // The snapshot this review's own turn was prepared with states the round the
  // attempt was given, before anything was recorded from it.
  if (record.history !== null) {
    const file = path.join(record.history, 'index.json');
    const index = await readJson(file);
    const round =
      index !== null && typeof index === 'object' && !Array.isArray(index)
        ? (index as Record<string, unknown>)['round']
        : undefined;
    if (typeof round === 'number' && Number.isSafeInteger(round) && round >= 1) {
      return settled(round, `the history snapshot this review was prepared with ("${file}")`);
    }
  }

  // The report verdict the harness saved beside the digest states each
  // finding's own identity (`recordedAs`), and the round is the one they were
  // recorded under.
  const verdictFile = reportFile(parts.root, `reviewer-${record.reviewId}.verdict.json`);
  const recorded = recordedRoundOf(await readJson(verdictFile));
  if (recorded !== null) {
    return settled(recorded, `the report verdict saved beside its digest ("${verdictFile}")`);
  }

  // Nothing of the review's own states its round: place it among every attempt
  // this machine still holds, dated the way `nextReviewRound` counted them.
  let earlier = 0;
  for (const attempt of parts.attempts.values()) {
    if (
      attempt.reviewId !== record.reviewId &&
      compareHistoryTime(attempt.at, record.startedAt) < 0
    ) {
      earlier += 1;
    }
  }
  const placed = earlier + 1;
  if (!parts.claimed.has(placed)) {
    return {
      round: placed,
      from:
        `the ${String(earlier)} review attempt${earlier === 1 ? '' : 's'} of this ticket this ` +
        'machine still holds before it, retained reports and review records together',
      problem: null,
    };
  }
  return {
    round: null,
    from: null,
    problem:
      `the ${String(earlier)} review attempt${earlier === 1 ? '' : 's'} this machine still holds ` +
      `before it place it at round ${String(placed)}, which another review of this ticket already ` +
      'holds, so the round it was recorded with cannot be established without renaming a ' +
      "different review's finding",
  };
}

/**
 * The other occurrences one finding grouped, as a retained verdict states them,
 * or `null` when it states none this harness can read. A malformed entry is
 * dropped rather than invented: the finding itself stays whole either way.
 */
function relatedOccurrences(value: unknown): readonly HistoryOccurrence[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const occurrences: HistoryOccurrence[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      continue;
    }
    const occurrence = raw as Record<string, unknown>;
    const where = occurrence['path'];
    if (typeof where !== 'string' || where.trim() === '') {
      continue;
    }
    const line = occurrence['line'];
    occurrences.push({
      path: where.trim(),
      line: typeof line === 'number' && Number.isSafeInteger(line) && line >= 1 ? line : null,
    });
  }
  return occurrences.length === 0 ? null : occurrences;
}

/** What reading one retained reviewer verdict produced. */
interface RetainedVerdictRead {
  readonly report: LocalReport | null;
  /** Why the retained verdict is not a complete report, when it is not. */
  readonly problem: string | null;
}

/**
 * The identity one verification of a retained verdict names, in the spelling
 * the history uses.
 *
 * A verdict is written with the identities the snapshot named, and a reviewer
 * may spell one in any case: `parseVerdict` accepts that by resolving the
 * identity against the history, so `r1-f1` becomes `R1-F1` before anything is
 * published. A verdict read back from disk is read without that history, so the
 * same normalization is applied here — the report's own finding keeps its
 * spelling, and any other identity is read as the one this harness names, which
 * is upper case. Without it, a recovery would keep the reviewer's spelling
 * verbatim and settle nothing the published verdict settled, so a valid
 * verification would change meaning after a restart (docs/WORKFLOW.md §9).
 */
function recoveredVerificationIdentity(
  stated: string,
  findings: readonly HistoryFinding[],
): string {
  const named = stated.trim();
  const own = findings.find((finding) => finding.id.toUpperCase() === named.toUpperCase());
  return own?.id ?? named.toUpperCase();
}

/**
 * Reads back the complete reviewer report one review record left: the verdict
 * the reviewer turn wrote beside its own evidence. The retained verdict is the
 * reviewer's own wording, whole, and it is validated here before it is
 * presented as a complete report — a file that is missing, unreadable, or not
 * a usable verdict becomes an explicit problem instead of an empty report.
 */
async function readRetainedVerdict(parts: {
  readonly dir: string;
  readonly record: ReviewRecordIdentity;
  readonly ref: SourceRef;
  readonly workspaceId: string;
  readonly round: RecoveredRound;
}): Promise<RetainedVerdictRead> {
  const file = path.join(parts.dir, 'verdict.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    return {
      report: null,
      problem: `the reviewer's own verdict "${file}" could not be read: ${messageOf(cause)}`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    return {
      report: null,
      problem: `the reviewer's own verdict "${file}" is not valid JSON: ${messageOf(cause)}`,
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      report: null,
      problem: `the reviewer's own verdict "${file}" is not a JSON object`,
    };
  }
  const record = value as Record<string, unknown>;
  const decision = record['verdict'];
  if (decision !== 'approve' && decision !== 'request_changes' && decision !== 'inconclusive') {
    return {
      report: null,
      problem:
        `the reviewer's own verdict "${file}" names no usable decision, so it was not read as a ` +
        'complete report',
    };
  }
  const summary = record['summary'];
  if (typeof summary !== 'string' || summary.trim() === '') {
    return {
      report: null,
      problem: `the reviewer's own verdict "${file}" carries no summary`,
    };
  }
  const rawFindings = record['findings'];
  if (!Array.isArray(rawFindings)) {
    return {
      report: null,
      problem: `the reviewer's own verdict "${file}" carries no list of findings`,
    };
  }
  const stated: UnidentifiedFinding[] = [];
  for (const [index, raw] of rawFindings.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return {
        report: null,
        problem: `finding ${String(index + 1)} of "${file}" is not an object`,
      };
    }
    const finding = raw as Record<string, unknown>;
    const body = finding['body'];
    const where = finding['path'];
    if (
      typeof body !== 'string' ||
      body.trim() === '' ||
      typeof where !== 'string' ||
      where.trim() === ''
    ) {
      return {
        report: null,
        problem:
          `finding ${String(index + 1)} of "${file}" carries no path and body, so the complete ` +
          'report cannot be read back',
      };
    }
    const line = finding['line'];
    if (
      line !== undefined &&
      line !== null &&
      (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1)
    ) {
      return {
        report: null,
        problem: `finding ${String(index + 1)} of "${file}" carries no usable line number`,
      };
    }
    const related = relatedOccurrences(finding['related']);
    stated.push({
      path: where.trim(),
      line: line === undefined || line === null ? null : line,
      body,
      ...(finding['kind'] === 'unresolved' || finding['kind'] === 'regression'
        ? {
            kind: finding['kind'],
            continues: typeof finding['continues'] === 'string' ? finding['continues'] : null,
          }
        : {}),
      ...(related === null ? {} : { related }),
    });
  }
  // The identity is assigned the same way a directly recorded report's is: a
  // continuation keeps the identity it names, so a restart reads the same
  // defects back under the same names the brief and the answers used. A round
  // this machine cannot establish names the findings by the review's own
  // identity instead — the same fallback a report kept without a round number
  // gets — so no other review's finding is renamed over (docs/WORKFLOW.md §9).
  const findings = identifyFindings(
    stated,
    parts.round.round,
    parts.round.round === null ? parts.record.reviewId : undefined,
  );
  const verifications: HistoryFindingVerification[] = [];
  const rawVerifications = record['verifications'];
  if (Array.isArray(rawVerifications)) {
    for (const raw of rawVerifications) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        continue;
      }
      const verification = raw as Record<string, unknown>;
      const finding = verification['finding'];
      const state = verification['state'];
      const evidence = verification['evidence'];
      if (
        typeof finding !== 'string' ||
        finding.trim() === '' ||
        (state !== 'verified' && state !== 'unverified' && state !== 'regressed') ||
        typeof evidence !== 'string' ||
        evidence.trim() === ''
      ) {
        continue;
      }
      verifications.push({
        finding: recoveredVerificationIdentity(finding, findings),
        state,
        evidence: evidence.trim(),
      });
    }
  }
  const head = parts.record.head ?? '(the review record names no reviewed head)';
  const digest: ReviewerReportDigest = {
    version: 1,
    kind: 'reviewer-report',
    reviewId: parts.record.reviewId,
    ref: parts.ref,
    workspaceId: parts.workspaceId,
    round: parts.round.round,
    task: { id: parts.ref.key, title: parts.ref.key },
    head,
    decision,
    summary: summary.trim(),
    findings,
    ...(verifications.length === 0 ? {} : { verifications }),
    createdAt: parts.record.endedAt ?? parts.record.startedAt,
    textFile: '',
    recordFile: null,
    recordProblem:
      `this report was recovered from the reviewer's own retained verdict at "${file}"; ` +
      recoveredRoundNote(parts.round),
    published:
      parts.record.published === null
        ? null
        : { id: parts.record.published.id, url: parts.record.published.url, bodySha256: null },
  };
  return {
    report: {
      kind: 'reviewer-report',
      digest,
      text: reviewerReportText({
        ref: parts.ref,
        round: parts.round.round,
        reviewId: parts.record.reviewId,
        head,
        decision,
        summary: summary.trim(),
        findings,
        verifications,
        recoveredFrom: file,
        recoveredRound: parts.round,
        publishedUrl: parts.record.published?.url ?? null,
      }),
      complete: true,
      problem: null,
      legacy: true,
    },
    problem: null,
  };
}

/** Old adapters explicitly marked shortened messages; a Markdown copy cannot restore them. */
function truncatedDeveloperReport(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return value.some(
    (attempt: unknown) =>
      typeof attempt === 'object' &&
      attempt !== null &&
      typeof (attempt as Record<string, unknown>)['agentSummary'] === 'string' &&
      ((attempt as Record<string, unknown>)['agentSummary'] as string).endsWith(
        " [truncated: this turn's log holds the full message]",
      ),
  )
    ? 'a legacy developer message was truncated before retention; the full conversation report is unavailable (raw logs are supporting evidence only)'
    : null;
}

/**
 * Why one legacy `result.json` cannot be read back as the conversation it
 * records, or `null` when it can. A record this harness wrote always carries
 * its own outcome and one entry per coding turn; anything else is reported as
 * incomplete rather than reconstructed into a report claiming completeness.
 */
function legacyRecordProblem(parsed: Record<string, unknown> | null): string | null {
  if (parsed === null) {
    return "the run's own report is not valid JSON";
  }
  if (typeof parsed['status'] !== 'string') {
    return "the run's own report carries no outcome";
  }
  const rawAttempts = parsed['attempts'];
  if (!Array.isArray(rawAttempts)) {
    return "the run's own report carries no list of coding turns";
  }
  for (const [index, raw] of rawAttempts.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return `turn ${String(index + 1)} of the run's own report is not an object`;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record['turn'] !== 'number' || typeof record['kind'] !== 'string') {
      return `turn ${String(index + 1)} of the run's own report names no turn and kind`;
    }
    const summary = record['agentSummary'];
    if (summary !== undefined && summary !== null && typeof summary !== 'string') {
      return `turn ${String(index + 1)} of the run's own report carries a summary that is not text`;
    }
  }
  return truncatedDeveloperReport(rawAttempts);
}

/**
 * A developer report rebuilt from a run's own `result.json`, without a digest.
 * The rebuilt report is complete only when the record really holds the
 * conversation — the outcome and one usable entry per coding turn; a record
 * that cannot be read that way keeps what it has and names what is missing.
 */
function legacyDeveloperDigest(
  runId: string,
  ref: SourceRef,
  workspaceId: string,
  round: number,
  text: string,
  attempt: {
    readonly outcome: string;
    readonly reason?: string;
    readonly endedAt: string;
    readonly reportPath: string;
  },
): { readonly digest: DeveloperReportDigest; readonly problem: string | null } {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  const problem = legacyRecordProblem(parsed);
  const status =
    typeof parsed?.['status'] === 'string' ? (parsed['status'] as string) : attempt.outcome;
  const reason =
    typeof parsed?.['reason'] === 'string'
      ? (parsed['reason'] as string)
      : (attempt.reason ?? 'no reason was recorded');
  const attempts: {
    turn: number;
    kind: string;
    agentSummary: string | null;
    checks: string | null;
  }[] = [];
  const rawAttempts = parsed?.['attempts'];
  if (Array.isArray(rawAttempts)) {
    for (const [index, raw] of rawAttempts.entries()) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        continue;
      }
      const record = raw as Record<string, unknown>;
      const checks = record['checks'];
      attempts.push({
        turn: typeof record['turn'] === 'number' ? record['turn'] : index + 1,
        kind: typeof record['kind'] === 'string' ? record['kind'] : 'implementation',
        agentSummary: typeof record['agentSummary'] === 'string' ? record['agentSummary'] : null,
        checks:
          typeof checks === 'object' &&
          checks !== null &&
          typeof (checks as Record<string, unknown>)['outcome'] === 'string'
            ? ((checks as Record<string, unknown>)['outcome'] as string)
            : null,
      });
    }
  }
  const digest: DeveloperReportDigest = {
    version: 1,
    kind: 'developer-report',
    runId,
    ref,
    workspaceId,
    round,
    task: { id: ref.key, title: ref.key },
    status,
    reason,
    repairsUsed: Math.max(0, attempts.filter((entry) => entry.kind === 'repair').length),
    attempts,
    pullRequest: null,
    deliveryFailure: null,
    createdAt:
      typeof parsed?.['endedAt'] === 'string' ? (parsed['endedAt'] as string) : attempt.endedAt,
    published: null,
    textFile: '',
    recordFile: null,
    recordProblem:
      problem === null
        ? 'this report was recorded before the harness kept a complete history copy; the text ' +
          "below was rebuilt from the run's own result.json"
        : `INCOMPLETE: the complete conversation of this attempt could not be read back from ` +
          `"${attempt.reportPath}": ${problem}. Only what the record holds is below; the missing ` +
          'turns are not reconstructed.',
  };
  return { digest, problem };
}

/** The readable rendering of a rebuilt legacy developer report. */
function legacyDeveloperText(digest: DeveloperReportDigest): string {
  const lines = [
    `# Developer report (recorded before complete history retention) — ${digest.ref.key}, round ` +
      `${String(digest.round)}`,
    '',
    `- Run: ${digest.runId}`,
    `- Outcome: ${digest.status}`,
    `- Reason: ${oneLine(digest.reason)}`,
    `- Repairs used: ${String(digest.repairsUsed)}`,
    '',
    digest.recordProblem ?? '',
  ];
  for (const attempt of digest.attempts) {
    lines.push(
      `## Turn ${String(attempt.turn)} (${attempt.kind})`,
      '',
      attempt.agentSummary?.trim() ?? 'The agent gave no summary.',
      '',
      `Checks after the turn: ${attempt.checks ?? '(none ran)'}`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
