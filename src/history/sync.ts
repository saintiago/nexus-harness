/**
 * Synchronization: the one deterministic step that reads the ticket's remote
 * conversation and this machine's own reports and writes the snapshot a turn is
 * given.
 *
 * Remote text is read here and nowhere else; a turn reads the local snapshot
 * with its ordinary tools and never needs a Jira or GitHub connector call. An
 * entry keeps the source's own identity, so a later read that reports an edit
 * updates that entry instead of adding a second one, and a published rendering
 * of a complete local report is recognized by the publication identity this
 * machine recorded — never by its wording alone — and recorded as a mirror
 * rather than duplicated as conversation.
 */
import type { HistoryReaders, TicketHistory } from './contract.js';
import { HistoryError } from './contract.js';
import { messageOf } from '../shared/errors.js';
import type { SourceRef } from '../shared/types.js';
import {
  type DeveloperReportRequest,
  type HistoryBrief,
  type HistoryDelivery,
  type HistoryEntry,
  type HistoryFinding,
  type HistoryFindingResponse,
  type HistoryMirror,
  type HistoryReportSummary,
  type ReviewerReportRequest,
  type ReadComment,
} from './contract.js';
import { findingIdOf, parseFindingAnswers } from './findings.js';
import { historyMarkerOf } from './marker.js';
import { compareHistoryTime } from './time.js';
import { workspaceHistoryRoot } from './paths.js';
import {
  notePublishedDeveloperReport,
  readLocalReports,
  recordDeveloperReport,
  recordReviewerReport,
  reportSummaryOf,
  textSha256,
} from './reports.js';
import type { LocalReport } from './reports.js';
import { insideRecoveryWindow, readRecoveryHistory } from './recoveries.js';
import {
  readConsumedEntries,
  readLatestEntries,
  recordConsumedSnapshot,
  writeSnapshot,
} from './store.js';
import type { SnapshotContent } from './store.js';

/** What one ticket history is built from. */
export interface TicketHistoryParts {
  readonly workDir: string;
  readonly readers: HistoryReaders;
  /**
   * The author names that are this harness itself rather than a person — the
   * configured reviewer login, for example. An entry by one of them is the
   * harness's own publication, never human feedback.
   */
  readonly harnessAuthors?: readonly string[];
  readonly now?: () => Date;
}

/** The run id a legacy harness result comment names, when it names one. */
function legacyRunIdOf(text: string): string | null {
  const match = /Harness run ([A-Za-z0-9][A-Za-z0-9_-]{0,127}) for /.exec(text);
  return match?.[1] ?? null;
}

/**
 * Wording cannot establish authorship: a person may quote a complete harness
 * rendering and add actionable feedback. Only configured authors identify
 * harness text; recorded publication identities authenticate mirrors below.
 */
function isHarnessAuthor(author: string, harnessAuthors: readonly string[]): boolean {
  return harnessAuthors.some((name) => name !== '' && name === author);
}

/** One external comment as an entry, before deduplication and mirroring. */
function entryOfComment(
  comment: ReadComment,
  parts: {
    readonly source: 'jira' | 'github';
    readonly kind: 'jira-comment' | 'pr-comment' | 'pr-review' | 'pr-review-comment';
    readonly role: HistoryEntry['role'];
    readonly commit: string | null;
  },
): HistoryEntry {
  return {
    id: `${parts.source}:${parts.kind}:${comment.sourceId}`,
    source: parts.source,
    kind: parts.kind,
    role: parts.role,
    author: comment.author,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    round: null,
    commit: comment.commit ?? parts.commit,
    state: comment.state ?? null,
    url: comment.url,
    sourceId: comment.sourceId,
    text: comment.text,
    edited:
      comment.updatedAt !== null &&
      !Number.isNaN(Date.parse(comment.updatedAt)) &&
      !Number.isNaN(Date.parse(comment.createdAt)) &&
      Date.parse(comment.updatedAt) > Date.parse(comment.createdAt),
    complete: true,
    problem: null,
    file: null,
  };
}

/** One local report as an entry, with the round and commit its digest names. */
function entryOfReport(report: LocalReport): HistoryEntry {
  if (report.kind === 'missing-report') {
    return {
      id: `harness:${report.role}-report:${report.sourceId}`,
      source: 'harness',
      kind: 'missing-report',
      role: report.role,
      author: report.role === 'developer' ? 'Nexus Agent' : 'Nexus Lens',
      createdAt: report.createdAt,
      updatedAt: null,
      round: report.round,
      commit: null,
      state: null,
      url: null,
      sourceId: report.sourceId,
      text: report.text,
      edited: false,
      complete: false,
      problem: report.problem,
      file: null,
    };
  }
  const digest = report.digest;
  if (digest.kind === 'developer-report') {
    return {
      id: `harness:developer-report:${digest.runId}`,
      source: 'harness',
      kind: 'developer-report',
      role: 'developer',
      author: 'Nexus Agent',
      createdAt: digest.createdAt,
      updatedAt: null,
      round: digest.round,
      commit: digest.pullRequest?.head ?? null,
      state: null,
      url: digest.pullRequest?.url ?? null,
      sourceId: digest.runId,
      text: report.text,
      edited: false,
      complete: report.complete,
      problem: report.problem,
      file: null,
    };
  }
  return {
    id: `harness:reviewer-report:${digest.reviewId}`,
    source: 'harness',
    kind: 'reviewer-report',
    role: 'reviewer',
    author: 'Nexus Lens',
    createdAt: digest.createdAt,
    updatedAt: null,
    round: digest.round,
    commit: digest.head,
    state: null,
    url: digest.published?.url ?? null,
    sourceId: digest.reviewId,
    text: report.text,
    edited: false,
    complete: report.complete,
    problem: report.problem,
    file: null,
  };
}

/** The previous snapshot's version of one entry, when it had one. */
function previousOf(previous: readonly HistoryEntry[], id: string): HistoryEntry | undefined {
  return previous.find((entry) => entry.id === id);
}

/**
 * Whether one entry is new to this snapshot: it was not in the previous
 * snapshot at all, or its text or edit instant changed since. A comment that
 * arrived while the previous turn was running was absent from the immutable
 * input that turn held, and an edited comment carries wording that input never
 * had; both are feedback the next turn has to see.
 */
function unseenInPrevious(entry: HistoryEntry, previous: readonly HistoryEntry[] | null): boolean {
  if (previous === null) {
    return true;
  }
  const before = previousOf(previous, entry.id);
  if (before === undefined) {
    return true;
  }
  return before.text !== entry.text || before.updatedAt !== entry.updatedAt;
}

/** Whether one review decision or state asked for changes. */
function requestsChanges(value: string | null | undefined): boolean {
  return (
    value !== null && value !== undefined && /changes[_ ]requested|request[_ ]changes/i.test(value)
  );
}

/**
 * The publication identities this machine recorded for the retained reports:
 * the Jira comment each developer report was published as, and the native
 * review each reviewer report was published as. A mirror is only ever
 * recognized through one of these, never through wording alone.
 */
interface PublicationIndex {
  /** Every retained developer report by the Jira comment it was published as. */
  readonly jiraByComment: ReadonlyMap<
    string,
    { readonly entryId: string; readonly textSha256: string | null; readonly contextText?: string }
  >;
  /** Every retained developer report by the run it reports, for the legacy shape check. */
  readonly developerByRun: ReadonlyMap<string, string>;
  /** Every retained reviewer report by the native review it was published as. */
  readonly reviewById: ReadonlyMap<
    number,
    {
      readonly entryId: string;
      readonly bodySha256: string | null;
      readonly findings: readonly HistoryFinding[];
    }
  >;
  /** Every retained reviewer report by its own review id. */
  readonly reviewByLocalId: ReadonlyMap<string, string>;
}

/** What one set of local reports recorded about its own publications. */
function publicationIndexOf(reports: readonly LocalReport[]): PublicationIndex {
  const jiraByComment = new Map<
    string,
    { entryId: string; textSha256: string | null; contextText?: string }
  >();
  const developerByRun = new Map<string, string>();
  const reviewById = new Map<
    number,
    { entryId: string; bodySha256: string | null; findings: readonly HistoryFinding[] }
  >();
  const reviewByLocalId = new Map<string, string>();
  for (const report of reports) {
    if (report.kind === 'developer-report') {
      const entryId = `harness:developer-report:${report.digest.runId}`;
      developerByRun.set(report.digest.runId, entryId);
      if (report.digest.published !== null) {
        jiraByComment.set(report.digest.published.commentId, {
          entryId,
          textSha256:
            report.digest.published.textSha256 === '' ? null : report.digest.published.textSha256,
        });
      }
      continue;
    }
    if (report.kind === 'reviewer-report') {
      const entryId = `harness:reviewer-report:${report.digest.reviewId}`;
      reviewByLocalId.set(report.digest.reviewId, entryId);
      const jira = report.digest.jiraPublication;
      if (jira !== undefined) {
        jiraByComment.set(jira.commentId, {
          entryId,
          textSha256: jira.textSha256,
          ...(jira.contextText === undefined ? {} : { contextText: jira.contextText }),
        });
      }
      if (report.digest.published !== null) {
        reviewById.set(report.digest.published.id, {
          entryId,
          bodySha256: report.digest.published.bodySha256,
          findings: report.digest.findings,
        });
      }
    }
  }
  return { jiraByComment, developerByRun, reviewById, reviewByLocalId };
}

/**
 * Whether one Jira comment carries this harness's own rendering of a retained
 * developer report: the run's result line, the marker naming that same report,
 * and the artifacts and repairs lines every result comment has carried. It is
 * the compatibility path for renderings published before their comment
 * identity was recorded. A comment that merely quotes a marker does not match,
 * and stays a comment.
 */
function isDeveloperRenderingShape(text: string, ref: SourceRef, runId: string): boolean {
  const marker = historyMarkerOf(text);
  if (marker === null || marker.kind !== 'developer' || marker.id !== runId) {
    return false;
  }
  const lines = text.split('\n').map((line) => line.trim());
  return (
    lines.some((line) => line.startsWith(`Harness run ${runId} for ${ref.key} finished: `)) &&
    lines.some((line) => line.startsWith('Repairs used: ')) &&
    lines.some((line) => line.startsWith('Local artifacts on the machine that ran this harness'))
  );
}

/** One external comment as a candidate entry, with the read that produced it. */
interface Candidate {
  readonly entry: HistoryEntry;
  /**
   * The raw comment, for the fields an entry does not keep: an inline
   * comment's own body and the native review it belongs to.
   */
  readonly comment: ReadComment | null;
}

/** Whether one inline review comment published one of a report's findings. */
function isPublishedFinding(findings: readonly HistoryFinding[], comment: ReadComment): boolean {
  const body = (comment.body ?? comment.text).trim();
  return findings.some(
    (finding) =>
      finding.body.trim() === body &&
      (comment.path === undefined || comment.path === null || finding.path === comment.path),
  );
}

/**
 * Whether an entry an earlier snapshot already recognized as a rendering no
 * longer reads as the same text. A mirror tracked by a recorded publication
 * identity is checked against that record; one recognized only by its shape is
 * checked against the snapshot that recognized it, so an edit to a legacy
 * rendering becomes a distinct message rather than a silent duplicate.
 */
function editedSinceMirrored(
  entry: HistoryEntry,
  mirroredBefore: ReadonlyMap<string, string>,
): boolean {
  const seen = mirroredBefore.get(`${entry.source}:${entry.sourceId}`);
  return seen !== undefined && seen !== textSha256(entry.text);
}

/**
 * The retained report one external entry is the published rendering of, or
 * `null` when no recorded publication identity authenticates it. An entry
 * whose text no longer matches what was published is not a mirror: it is an
 * edited or distinct message, and it stays attributed conversation.
 */
function mirroredEntryId(
  candidate: Candidate,
  parts: {
    readonly index: PublicationIndex;
    readonly ref: SourceRef;
    readonly harnessAuthors: readonly string[];
    /** The renderings an earlier snapshot already recognized, by source identity. */
    readonly mirroredBefore: ReadonlyMap<string, string>;
    /** A legacy rendering already retained as edited must not become a mirror again. */
    readonly editedBefore: boolean;
  },
): string | null {
  const entry = candidate.entry;
  const comment = candidate.comment;
  if (entry.source === 'jira' && entry.kind === 'jira-comment') {
    const recorded = parts.index.jiraByComment.get(entry.sourceId);
    if (recorded !== undefined) {
      const changed =
        recorded.textSha256 === null
          ? parts.editedBefore || editedSinceMirrored(entry, parts.mirroredBefore)
          : textSha256(entry.text) !== recorded.textSha256;
      return changed ? null : recorded.entryId;
    }
    const marker = historyMarkerOf(entry.text);
    const runId = marker?.kind === 'developer' ? marker.id : legacyRunIdOf(entry.text);
    const retained = runId === null ? undefined : parts.index.developerByRun.get(runId);
    if (
      retained !== undefined &&
      runId !== null &&
      isHarnessAuthor(entry.author, parts.harnessAuthors) &&
      isDeveloperRenderingShape(entry.text, parts.ref, runId)
    ) {
      return parts.editedBefore || editedSinceMirrored(entry, parts.mirroredBefore)
        ? null
        : retained;
    }
    return null;
  }
  if (entry.source !== 'github') {
    return null;
  }
  if (entry.kind === 'pr-review') {
    const numeric = Number(entry.sourceId);
    const recorded = Number.isSafeInteger(numeric)
      ? parts.index.reviewById.get(numeric)
      : undefined;
    if (recorded !== undefined) {
      const changed =
        recorded.bodySha256 === null
          ? parts.editedBefore || editedSinceMirrored(entry, parts.mirroredBefore)
          : textSha256(entry.text) !== recorded.bodySha256;
      return changed ? null : recorded.entryId;
    }
    // A rendering published before the publication id was recorded: the App's
    // own review, carrying the marker for a retained report. Only the login the
    // harness publishes as can have written it.
    const marker = historyMarkerOf(entry.text);
    const authored = parts.harnessAuthors.some((name) => name !== '' && name === entry.author);
    if (!authored || marker?.kind !== 'reviewer') {
      return null;
    }
    const retained = parts.index.reviewByLocalId.get(marker.id) ?? null;
    return retained !== null &&
      (parts.editedBefore || editedSinceMirrored(entry, parts.mirroredBefore))
      ? null
      : retained;
  }
  if (entry.kind === 'pr-review-comment' && comment !== null && comment !== undefined) {
    // A reply is its own conversational entry, never a mirrored finding.
    if (comment.inReplyToId !== undefined && comment.inReplyToId !== null) {
      return null;
    }
    const parent =
      comment.reviewId === undefined || comment.reviewId === null
        ? undefined
        : parts.index.reviewById.get(comment.reviewId);
    if (parent !== undefined && isPublishedFinding(parent.findings, comment)) {
      return parent.entryId;
    }
    // The same association for a review published before its inline comments
    // carried a parent identity: only the App's own login, with a body that is
    // one of a retained report's findings, is such a rendering.
    if (!parts.harnessAuthors.some((name) => name !== '' && name === entry.author)) {
      return null;
    }
    for (const published of parts.index.reviewById.values()) {
      if (isPublishedFinding(published.findings, comment)) {
        return editedSinceMirrored(entry, parts.mirroredBefore) ? null : published.entryId;
      }
    }
    return null;
  }
  return null;
}

/** One review round the brief may name as the unresolved one. */
interface ReviewRoundCandidate {
  readonly at: string;
  readonly owner: string;
  /** The decision or native state, lower case. */
  readonly decision: string;
  readonly summary: HistoryReportSummary;
  /** The round's own entries: its review, and the findings it published. */
  readonly ownEntryIds: readonly string[];
}

/**
 * Reconciles retained and native reviews independently by reviewer. Only an
 * approval by that reviewer at the current head clears their outstanding
 * request; comment-only and inconclusive rounds decide nothing.
 */
function unresolvedRound(
  reports: readonly HistoryReportSummary[],
  candidates: readonly Candidate[],
  harnessAuthors: readonly string[],
  currentHead: string | null,
): readonly ReviewRoundCandidate[] {
  const rounds: ReviewRoundCandidate[] = [];
  const coveredReviews = new Set<string>();

  /** The inline comments one native review published, by the review's own id. */
  const inlineOf = (reviewId: string): readonly Candidate[] =>
    candidates.filter((candidate) => {
      if (candidate.entry.kind !== 'pr-review-comment') {
        return false;
      }
      const comment = candidate.comment;
      if (comment === null || comment.reviewId === undefined || comment.reviewId === null) {
        return false;
      }
      if (comment.inReplyToId !== undefined && comment.inReplyToId !== null) {
        // A reply is a response to a finding, not part of the review itself.
        return false;
      }
      return String(comment.reviewId) === reviewId;
    });

  for (const report of reports) {
    if (report.kind !== 'reviewer-report') {
      continue;
    }
    if (report.nativeReviewId !== null) {
      coveredReviews.add(String(report.nativeReviewId));
    }
    const native = candidates.find(
      (candidate) =>
        candidate.entry.kind === 'pr-review' &&
        candidate.entry.sourceId === String(report.nativeReviewId),
    );
    const decision = native?.entry.state?.toLowerCase() ?? (report.decision ?? '').toLowerCase();
    if (decision === 'approve' && report.nativeReviewId === null) {
      // Retain the report, but an approval refused by publication guards is
      // not evidence that earlier change requests were resolved.
      continue;
    }
    if (decision.includes('inconclusive')) {
      // A review that concluded nothing published nothing and decides nothing;
      // its own gap is still named in the incomplete-input list.
      continue;
    }
    const own = [report.entryId];
    for (const inline of inlineOf(String(report.nativeReviewId ?? ''))) {
      own.push(inline.entry.id);
    }
    if (report.nativeReviewId !== null) {
      own.push(`github:pr-review:${String(report.nativeReviewId)}`);
    }
    rounds.push({
      at: native?.entry.createdAt ?? report.createdAt,
      owner: 'harness',
      decision,
      summary: report,
      ownEntryIds: own,
    });
  }

  for (const candidate of candidates) {
    const entry = candidate.entry;
    if (entry.kind !== 'pr-review' || coveredReviews.has(entry.sourceId)) {
      continue;
    }
    const own = [entry.id];
    const findings: HistoryFinding[] = [];
    for (const [index, inline] of inlineOf(entry.sourceId).entries()) {
      own.push(inline.entry.id);
      const comment = inline.comment;
      if (comment === null) {
        continue;
      }
      findings.push({
        id: findingIdOf(null, index, entry.sourceId),
        path: comment.path ?? '(inline review comment)',
        line: comment.line ?? null,
        body: comment.body ?? comment.text,
      });
    }
    const requested = requestsChanges(entry.state);
    rounds.push({
      at: entry.createdAt,
      owner: harnessAuthors.includes(entry.author) ? 'harness' : `github:${entry.author}`,
      decision: requested ? 'request_changes' : (entry.state ?? 'commented').toLowerCase(),
      summary: {
        entryId: entry.id,
        kind: 'reviewer-report',
        round: null,
        author: entry.author,
        createdAt: entry.createdAt,
        sourceId: entry.sourceId,
        complete: false,
        problem:
          'the complete reviewer report was not kept on this machine; this round is ' +
          'reconstructed from the published native review and its inline comments',
        status: null,
        reason: null,
        head: entry.commit,
        nativeReviewId: Number.isSafeInteger(Number(entry.sourceId))
          ? Number(entry.sourceId)
          : null,
        decision: requested ? 'request_changes' : null,
        summary: entry.text,
        findings,
        pullRequest: null,
      },
      ownEntryIds: own,
    });
  }

  rounds.sort(
    (a, b) => compareHistoryTime(a.at, b.at) || a.summary.entryId.localeCompare(b.summary.entryId),
  );
  const outstanding = new Map<string, ReviewRoundCandidate>();
  for (const round of rounds) {
    if (requestsChanges(round.decision)) {
      outstanding.set(round.owner, round);
    } else if (
      (round.decision === 'approve' || round.decision === 'approved') &&
      round.summary.head === (currentHead ?? outstanding.get(round.owner)?.summary.head)
    ) {
      outstanding.delete(round.owner);
    }
    // COMMENTED and inconclusive rounds cannot resolve a change request.
    // DISMISSED reviews are not added as outstanding in the first place.
  }
  return [...outstanding.values()];
}

/**
 * The developer's answers to one outstanding round's findings, read from the
 * newest complete developer report recorded after that review. Identity ties an
 * answer to a finding: the report has to name the finding by the same identity
 * the brief renders, and an answer that leaves out a field, or a report that
 * answers nothing, is kept as the incomplete response it is — never rounded up
 * to complete remediation (docs/WORKFLOW.md §9).
 *
 * The newest report is the current claim: an earlier attempt's answer stays in
 * the snapshot as its own entry, but the work as it now stands is what the
 * latest attempt said about it. Deriving the answers from the retained reports
 * each time is what makes a complete exchange survive further turns and
 * restarts without a second store.
 */
function responsesOf(
  round: ReviewRoundCandidate,
  entries: readonly HistoryEntry[],
): readonly HistoryFindingResponse[] {
  const findings = round.summary.findings.map((finding) => finding.id);
  if (findings.length === 0) {
    return [];
  }
  const newest = entries
    .filter(
      (entry) =>
        entry.kind === 'developer-report' && compareHistoryTime(entry.createdAt, round.at) >= 0,
    )
    .toSorted(
      (a, b) => compareHistoryTime(b.createdAt, a.createdAt) || b.id.localeCompare(a.id),
    )[0];
  if (newest === undefined) {
    return [];
  }
  return parseFindingAnswers(newest.text, findings).map((answer) => ({
    ...answer,
    entryId: newest.id,
    runId: newest.sourceId,
    round: newest.round,
    createdAt: newest.createdAt,
  }));
}

/** The latest delivery the snapshot can prove: the pull request now, or the last report's. */
function latestDelivery(
  pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headSha: string;
    readonly observedAt: string;
  } | null,
  reports: readonly HistoryReportSummary[],
): HistoryDelivery | null {
  const delivered = reports
    .filter((report) => report.kind === 'developer-report' && report.pullRequest !== null)
    .toSorted((a, b) => compareHistoryTime(a.createdAt, b.createdAt))
    .at(-1);
  if (pullRequest !== null) {
    return {
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      branch: pullRequest.headBranch,
      baseBranch: pullRequest.baseBranch,
      head: pullRequest.headSha,
      observedAt: pullRequest.observedAt,
      round: delivered?.round ?? null,
      entryId: delivered?.entryId ?? null,
    };
  }
  return delivered?.pullRequest ?? null;
}

/**
 * Builds the ticket history a run and a review prepare their turns from. The
 * readers are injected by the caller; this module imports no connector, and the
 * only files it writes are the snapshot and the complete reports.
 */
export function createTicketHistory(parts: TicketHistoryParts): TicketHistory {
  const now = parts.now ?? ((): Date => new Date());
  const harnessAuthors = parts.harnessAuthors ?? [];

  return {
    async prepare(request) {
      const root = workspaceHistoryRoot(parts.workDir, request.workspace.workspaceId);
      const previous = await readLatestEntries(root);
      const consumed = await readConsumedEntries(root, request.role);
      let current = { ref: request.ref, task: request.task };
      if (parts.readers.currentTask !== undefined) {
        try {
          current = await parts.readers.currentTask(request.ref, request.stop);
          if (
            current.ref.id !== request.ref.id ||
            current.ref.scope !== request.ref.scope ||
            current.ref.type !== request.ref.type
          ) {
            throw new Error('the requirements reader returned a different ticket identity');
          }
        } catch (cause) {
          throw new HistoryError(
            'essential',
            `current ticket requirements could not be obtained: ${messageOf(cause)}`,
            { cause },
          );
        }
      }
      const sources: { source: 'jira' | 'github' | 'harness'; problem: string | null }[] = [];
      const gaps: string[] = [];

      let jiraComments: readonly ReadComment[] = [];
      try {
        const read = await parts.readers.jiraThread(request.ref, request.stop);
        jiraComments = read.comments;
        sources.push({ source: 'jira', problem: null });
        if (read.truncated) {
          const gap =
            "the ticket's Jira discussion has more comments than the harness read; only the pages " +
            'it read are represented in this snapshot';
          sources[sources.length - 1] = { source: 'jira', problem: gap };
          gaps.push(gap);
        }
      } catch (cause) {
        const problem = messageOf(cause);
        sources.push({ source: 'jira', problem });
        gaps.push(
          `the ticket's Jira discussion could not be read, so it is not represented in this ` +
            `snapshot: ${problem}`,
        );
      }

      let pullRequest: Awaited<ReturnType<HistoryReaders['pullRequestConversation']>> = null;
      let pullRequestReadable = false;
      try {
        pullRequest = await parts.readers.pullRequestConversation(
          request.ref,
          request.workspace.workspaceId,
          request.stop,
        );
        if (pullRequest === null) {
          sources.push({ source: 'github', problem: null });
        } else {
          pullRequestReadable = true;
          sources.push({
            source: 'github',
            problem: pullRequest.truncated
              ? 'the pull request conversation has more entries than the harness read'
              : null,
          });
          if (pullRequest.truncated) {
            gaps.push(
              'the pull request conversation has more entries than the harness read; only the ' +
                'pages it read are represented in this snapshot',
            );
          }
        }
      } catch (cause) {
        const problem = messageOf(cause);
        sources.push({ source: 'github', problem });
        gaps.push(
          `the pull request conversation could not be read, so it is not represented in this ` +
            `snapshot: ${problem}`,
        );
      }

      const local = await readLocalReports({
        workDir: parts.workDir,
        root,
        ref: request.ref,
        workspaceId: request.workspace.workspaceId,
        now: now(),
      });
      // The supervisor's own incident records, whole: a recovery that happened
      // between two deliveries of this ticket is part of what a turn has to
      // read, and it is context like everything else (docs/WORKFLOW.md §12).
      const recoveries = await readRecoveryHistory({
        workDir: parts.workDir,
        ticketKey: request.ref.key,
      });
      const harnessProblems = [...local.problems, ...recoveries.problems];
      sources.push({
        source: 'harness',
        problem: harnessProblems.length === 0 ? null : harnessProblems.join('; '),
      });
      gaps.push(...local.problems);
      gaps.push(...recoveries.problems.map((problem) => `recovery history: ${problem}`));

      const candidates: Candidate[] = [];
      for (const comment of jiraComments) {
        const role = isHarnessAuthor(comment.author, harnessAuthors) ? 'harness' : 'human';
        candidates.push({
          entry: entryOfComment(comment, {
            source: 'jira',
            kind: 'jira-comment',
            role,
            commit: null,
          }),
          comment,
        });
      }
      if (pullRequest !== null) {
        for (const comment of pullRequest.comments) {
          const kind =
            comment.state !== undefined && comment.state !== null
              ? 'pr-review'
              : comment.path !== undefined && comment.path !== null
                ? 'pr-review-comment'
                : 'pr-comment';
          const role = isHarnessAuthor(comment.author, harnessAuthors) ? 'harness' : 'human';
          candidates.push({
            entry: entryOfComment(comment, {
              source: 'github',
              kind,
              role,
              commit: comment.commit ?? null,
            }),
            comment,
          });
        }
      }
      for (const report of local.reports) {
        candidates.push({ entry: entryOfReport(report), comment: null });
      }
      for (const entry of recoveries.entries) {
        candidates.push({ entry, comment: null });
      }

      // Deduplicate by source identity: the newest read of one identity wins,
      // and an entry whose wording changed is marked edited rather than
      // duplicated. A complete local report is never replaced by its rendering.
      const byId = new Map<string, Candidate>();
      for (const candidate of candidates) {
        const existing = byId.get(candidate.entry.id);
        if (existing === undefined) {
          byId.set(candidate.entry.id, candidate);
        } else if (existing.entry.source === 'harness' && candidate.entry.source !== 'harness') {
          continue;
        } else {
          byId.set(candidate.entry.id, candidate);
        }
      }

      // A rendering of a complete report is a mirror, not a second entry — but
      // only when a recorded publication identity authenticates it. Wording
      // alone never removes an entry, so a comment that quotes a marker stays
      // the comment its author wrote.
      const publications = publicationIndexOf(local.reports);
      const mirroredBefore = new Map<string, string>();
      for (const mirror of previous?.mirrors ?? []) {
        if (typeof mirror.textSha256 === 'string') {
          mirroredBefore.set(`${mirror.source}:${mirror.sourceId}`, mirror.textSha256);
        }
      }
      const reviewCandidates = [...byId.values()];
      const mirrors: HistoryMirror[] = [];
      for (const candidate of [...byId.values()]) {
        if (candidate.entry.source === 'harness') {
          continue;
        }
        const mirrored = mirroredEntryId(candidate, {
          index: publications,
          ref: request.ref,
          harnessAuthors,
          mirroredBefore,
          editedBefore:
            previous?.entries.some((entry) => entry.id === candidate.entry.id && entry.edited) ??
            false,
        });
        if (mirrored !== null) {
          const contextText =
            candidate.entry.source === 'jira'
              ? publications.jiraByComment.get(candidate.entry.sourceId)?.contextText
              : undefined;
          mirrors.push({
            sourceId: candidate.entry.sourceId,
            source: candidate.entry.source,
            ofEntryId: mirrored,
            textSha256: textSha256(candidate.entry.text),
            ...(contextText === undefined
              ? {}
              : { originalEntry: { ...candidate.entry, role: 'harness' as const } }),
          });
          if (contextText === undefined) {
            byId.delete(candidate.entry.id);
          } else {
            byId.set(candidate.entry.id, {
              ...candidate,
              entry: { ...candidate.entry, text: contextText, role: 'harness' },
            });
          }
        }
      }

      const publishedRecoveryComments = new Set(recoveries.commentIds);
      const entries = [...byId.values()]
        .map((candidate) => candidate.entry)
        .map((entry) => {
          // The concise report one incident published is the harness's own
          // text, whatever display name the service account carries: it is
          // recognized by the identity the incident recorded, never by its
          // wording or its author alone.
          const owned = entry.source === 'jira' && publishedRecoveryComments.has(entry.sourceId);
          // Completion mirrors keep separate context text in the conversation.
          // Its wording is intentionally different from the original rendering,
          // whose hash was already verified above; that is not a remote edit.
          if (
            mirrors.some(
              (mirror) => mirror.source === entry.source && mirror.sourceId === entry.sourceId,
            )
          ) {
            return entry;
          }
          const before = previous === null ? undefined : previousOf(previous.entries, entry.id);
          // Native GitHub reviews have no updated_at. Their recorded publication
          // hash is the baseline even when the preceding snapshot omitted the
          // unchanged mirror. Keep the edit flag across refreshes/restarts too.
          const publishedHash =
            entry.kind === 'pr-review'
              ? publications.reviewById.get(Number(entry.sourceId))?.bodySha256
              : entry.kind === 'jira-comment'
                ? publications.jiraByComment.get(entry.sourceId)?.textSha256
                : undefined;
          const edited =
            entry.edited ||
            (publishedHash != null && publishedHash !== textSha256(entry.text)) ||
            editedSinceMirrored(entry, mirroredBefore) ||
            (before !== undefined &&
              before.source !== 'harness' &&
              (before.edited || before.text !== entry.text));
          return { ...entry, ...(owned ? { role: 'harness' as const } : {}), edited };
        })
        .toSorted(
          (a, b) => compareHistoryTime(a.createdAt, b.createdAt) || a.id.localeCompare(b.id),
        );

      const reports: HistoryReportSummary[] = local.reports
        .map(reportSummaryOf)
        .filter((report): report is HistoryReportSummary => report !== null)
        .toSorted((a, b) => compareHistoryTime(a.createdAt, b.createdAt));
      for (const report of local.reports) {
        if (report.kind === 'missing-report') {
          gaps.push(
            `the complete ${report.role} report` +
              (report.round === null ? '' : ` of round ${String(report.round)}`) +
              ` (${report.sourceId}) is not available: ${report.problem}`,
          );
        }
      }
      for (const report of reports) {
        if (!report.complete && report.problem !== null) {
          gaps.push(
            `the complete ${report.kind === 'developer-report' ? 'developer' : 'reviewer'} ` +
              `report of round ${report.round === null ? '-' : String(report.round)} ` +
              `(${report.sourceId}) is not available: ${report.problem}`,
          );
        }
      }
      if (
        pullRequestReadable &&
        pullRequest?.pullRequest == null &&
        reports.some((report) => report.pullRequest !== null)
      ) {
        gaps.push(
          'a delivery is recorded for this ticket, but no open pull request matches its ' +
            'workspace now, so the pull request conversation is not represented in this snapshot',
        );
      }

      const unresolved = unresolvedRound(
        reports,
        reviewCandidates,
        harnessAuthors,
        pullRequest?.pullRequest?.headSha ?? null,
      );
      const reconstructedGap = unresolved.some((round) => !round.summary.complete)
        ? 'the latest review that requested changes has no complete local report; its findings ' +
          'are the published text, which may have been bounded for the destination it was ' +
          'published to'
        : null;
      if (reconstructedGap !== null) {
        gaps.push(reconstructedGap);
      }
      // The developer's answers to each outstanding round, read from the
      // complete developer reports recorded after it. A finding with no
      // complete answer is rendered as exactly that (docs/WORKFLOW.md §9).
      const unresolvedReviews: HistoryReportSummary[] = unresolved.map((candidate) => {
        const responses = responsesOf(candidate, entries);
        return responses.length === 0 ? candidate.summary : { ...candidate.summary, responses };
      });
      const round = unresolvedReviews.at(-1) ?? null;
      const ownEntryIds = new Set(unresolved.flatMap((round) => round.ownEntryIds));
      for (const { entry } of reviewCandidates) {
        if (
          [entry.createdAt, entry.updatedAt ?? entry.createdAt].some((at) =>
            Number.isNaN(Date.parse(at)),
          )
        ) {
          gaps.push(
            `the timestamp of ${entry.id} is unavailable or invalid; its chronological position is unknown and possible responses are retained conservatively`,
          );
        }
      }
      const earliest = unresolved.map((round) => round.at).sort(compareHistoryTime)[0];
      // Authenticated completion renderings can also carry distinct check
      // failures and repair dispositions. Their retained context is actionable
      // discussion, even though it is neither human-authored nor a remote edit.
      // Keep it with responses while a review is outstanding, independently of
      // either role's consumption cursor, and use the same whole-entry budget.
      const completionContextIds = new Set(
        mirrors.flatMap((mirror) =>
          mirror.originalEntry === undefined ? [] : [mirror.originalEntry.id],
        ),
      );
      const responses =
        earliest === undefined
          ? []
          : entries.filter(
              (entry) =>
                (!ownEntryIds.has(entry.id) || entry.edited) &&
                // A detected edit without an edit timestamp may postdate any
                // outstanding round, even when the review was submitted earlier.
                // Keep it actionable after consumption and restart rather than
                // treating the original submission time as the time of the edit.
                ((entry.edited && entry.updatedAt === null) ||
                  compareHistoryTime(entry.updatedAt ?? entry.createdAt, earliest) >= 0) &&
                (entry.role !== 'harness' || entry.edited || completionContextIds.has(entry.id)),
            );
      // Preparation alone consumes nothing. Compare with this role's last
      // acknowledged input, including when another role or a failed launch
      // prepared the newest snapshot since then.
      const newHumanFeedback = entries.filter(
        (entry) => entry.role === 'human' && unseenInPrevious(entry, consumed),
      );

      // Recovery context, for both roles and independently of either role's
      // cursor: the complete incident records of this ticket's supervised
      // recoveries, and the comments the same service account (the harness's
      // own author) made while those recoveries were being carried out. It is
      // context like every other entry — never an approval, a verification, or
      // a finished state of the work.
      const recovery = entries
        .filter(
          (entry) =>
            entry.kind === 'recovery-report' ||
            (entry.source === 'jira' && publishedRecoveryComments.has(entry.sourceId)) ||
            (isHarnessAuthor(entry.author, harnessAuthors) &&
              entry.source === 'jira' &&
              insideRecoveryWindow(recoveries.windows, entry.createdAt)),
        )
        .toSorted(
          (a, b) => compareHistoryTime(a.createdAt, b.createdAt) || a.id.localeCompare(b.id),
        );

      const brief: HistoryBrief = {
        ref: current.ref,
        task: current.task,
        latestDelivery: latestDelivery(pullRequest?.pullRequest ?? null, reports),
        unresolved: round,
        unresolvedReviews,
        responses,
        newHumanFeedback,
        ...(recovery.length === 0 ? {} : { recovery }),
      };
      const content: SnapshotContent = {
        role: request.role,
        round: request.round,
        ref: current.ref,
        task: current.task,
        brief,
        sources,
        gaps,
        mirrors,
        entries,
        reports,
      };
      return await writeSnapshot(root, content, now());
    },

    consumed: recordConsumedSnapshot,

    async recordDeveloperReport(request: DeveloperReportRequest) {
      const root = workspaceHistoryRoot(parts.workDir, request.workspaceId);
      return await recordDeveloperReport(root, request);
    },

    async recordReviewerReport(request: ReviewerReportRequest) {
      const root = workspaceHistoryRoot(parts.workDir, request.workspaceId);
      return await recordReviewerReport(root, request);
    },

    async notePublishedDeveloperReport(request) {
      const root = workspaceHistoryRoot(parts.workDir, request.workspaceId);
      await notePublishedDeveloperReport(root, request);
    },
  };
}
