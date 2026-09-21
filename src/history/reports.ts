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
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import type { SourceRef } from '../shared/types.js';
import { readWorkspaceState } from '../workspace/state.js';
import type {
  DeveloperReportRequest,
  HistoryDelivery,
  HistoryFinding,
  HistoryReportSummary,
  RecordedReport,
  ReviewerReportRequest,
} from './contract.js';
import { HistoryError } from './contract.js';
import { historyReportsDir } from './paths.js';

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
  /** The complete rendering, relative to the reports directory. */
  readonly textFile: string;
  /** The verbatim `result.json`, relative to the reports directory; `null` when it could not be copied. */
  readonly recordFile: string | null;
  /** Why the verbatim record is absent, when it is. */
  readonly recordProblem: string | null;
}

/** The digest of one complete reviewer report. */
export interface ReviewerReportDigest {
  readonly version: 1;
  readonly kind: 'reviewer-report';
  readonly reviewId: string;
  readonly ref: SourceRef;
  readonly workspaceId: string;
  readonly round: number;
  readonly task: { readonly id: string; readonly title: string };
  readonly head: string;
  readonly decision: string;
  readonly summary: string;
  readonly findings: readonly HistoryFinding[];
  readonly createdAt: string;
  readonly textFile: string;
  readonly recordFile: string | null;
  readonly recordProblem: string | null;
  /** The native review GitHub published for this report, once it exists. */
  readonly published: { readonly id: number; readonly url: string } | null;
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

/** The complete developer report as Markdown: every field the run recorded. */
function developerReportText(request: DeveloperReportRequest): string {
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

/** The complete reviewer report as Markdown: summary and every finding whole. */
function reviewerReportText(request: ReviewerReportRequest): string {
  const lines = [
    `# Reviewer report — ${request.ref.key}, round ${String(request.round)}`,
    '',
    `- Review: ${request.reviewId}`,
    `- Reviewed head: ${request.head}`,
    `- Decision: ${request.decision}`,
    '',
    '## Summary',
    '',
    request.summary.trim(),
    '',
    `## Findings (${String(request.findings.length)})`,
    '',
  ];
  if (request.findings.length === 0) {
    lines.push('(no findings)');
  }
  for (const [index, finding] of request.findings.entries()) {
    lines.push(
      `### Finding ${String(index + 1)}: ${finding.path}${
        finding.line === null ? '' : `:${String(finding.line)}`
      }`,
      '',
      finding.body.trim(),
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
  const copied = await copyVerbatim(reportFile(root, recordName), request.reportPath);
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
    findings: request.findings,
    createdAt: request.now.toISOString(),
    textFile: textName,
    recordFile: recordName,
    recordProblem: null,
    published: null,
  };
  try {
    await atomicWrite(reportFile(root, textName), reviewerReportText(request));
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
          findings: request.findings,
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
  published: { readonly id: number; readonly url: string },
): Promise<void> {
  const file = reportFile(root, `reviewer-${reviewId}.json`);
  let digest: ReviewerReportDigest;
  try {
    digest = JSON.parse(await readFile(file, 'utf8')) as ReviewerReportDigest;
  } catch {
    return;
  }
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
    decision: digest.decision,
    summary: digest.summary,
    findings: digest.findings,
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
      if (typeof record['runId'] !== 'string') {
        problems.push(`the developer report digest "${reportFile(root, name)}" names no run`);
        continue;
      }
      reports.push({
        kind: 'developer-report',
        digest: record as unknown as DeveloperReportDigest,
        text: text ?? '',
        complete: text !== null,
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
        digest: record as unknown as ReviewerReportDigest,
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
  const knownRuns = new Set(
    reports
      .filter(
        (report): report is Extract<LocalReport, { kind: 'developer-report' }> =>
          report.kind === 'developer-report',
      )
      .map((report) => report.digest.runId),
  );
  for (const [index, attempt] of ledgerAttempts.entries()) {
    if (knownRuns.has(attempt.runId)) {
      continue;
    }
    const round = index + 1;
    let text: string;
    try {
      text = await readFile(attempt.reportPath, 'utf8');
    } catch {
      text = '';
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
    const digest = legacyDeveloperDigest(attempt.runId, ref, workspaceId, round, text, attempt);
    reports.push({
      kind: 'developer-report',
      digest,
      text: legacyDeveloperText(digest),
      complete: true,
      problem: null,
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
    startedAt: string;
    verdict: string | null;
    problem: string | null;
    url: string | null;
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
    records.push({
      reviewId,
      startedAt:
        typeof record['startedAt'] === 'string' ? record['startedAt'] : parts.now.toISOString(),
      verdict: typeof record['verdict'] === 'string' ? record['verdict'] : null,
      problem: typeof record['problem'] === 'string' ? record['problem'] : null,
      url:
        typeof published === 'object' &&
        published !== null &&
        typeof (published as Record<string, unknown>)['url'] === 'string'
          ? ((published as Record<string, unknown>)['url'] as string)
          : null,
    });
  }
  records.sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.reviewId.localeCompare(b.reviewId),
  );
  for (const [index, record] of records.entries()) {
    if (knownReviews.has(record.reviewId)) {
      continue;
    }
    const round = index + 1;
    const what =
      record.verdict === null
        ? `its reviewer attempt ended without a published verdict`
        : `it published a ${record.verdict} review`;
    reports.push({
      kind: 'missing-report',
      role: 'reviewer',
      sourceId: record.reviewId,
      ref,
      round,
      createdAt: record.startedAt,
      text:
        `The complete reviewer report of round ${String(round)} (review ${record.reviewId}) is ` +
        `missing on this machine: the review record says ${what}` +
        (record.url === null ? '' : ` (${record.url})`) +
        (record.problem === null ? '' : `; its recorded problem was: ${oneLine(record.problem)}`) +
        '. Only the published rendering, if any, is available; it may have been bounded for the ' +
        'destination it was published to.',
      problem:
        `the complete reviewer report of round ${String(round)} (review ${record.reviewId}) is ` +
        'missing from this machine',
      reportPath: null,
    });
  }

  return { reports, problems };
}

/** A developer report rebuilt from a run's own `result.json`, without a digest. */
function legacyDeveloperDigest(
  runId: string,
  ref: SourceRef,
  workspaceId: string,
  round: number,
  text: string,
  attempt: { readonly outcome: string; readonly reason?: string; readonly endedAt: string },
): DeveloperReportDigest {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
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
      if (typeof raw !== 'object' || raw === null) {
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
  return {
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
    textFile: '',
    recordFile: null,
    recordProblem:
      'this report was recorded before the harness kept a complete history copy; the text below ' +
      "was rebuilt from the run's own result.json",
  };
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
