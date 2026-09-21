/**
 * Synchronization: the one deterministic step that reads the ticket's remote
 * conversation and this machine's own reports and writes the snapshot a turn is
 * given.
 *
 * Remote text is read here and nowhere else; a turn reads the local snapshot
 * with its ordinary tools and never needs a Jira or GitHub connector call. An
 * entry keeps the source's own identity, so a later read that reports an edit
 * updates that entry instead of adding a second one, and a published rendering
 * of a complete local report is recognized by its marker and recorded as a
 * mirror rather than duplicated as conversation.
 */
import type { HistoryReaders, TicketHistory } from './contract.js';
import { messageOf } from '../shared/errors.js';
import {
  type DeveloperReportRequest,
  type HistoryBrief,
  type HistoryDelivery,
  type HistoryEntry,
  type HistoryMirror,
  type HistoryReportSummary,
  type ReviewerReportRequest,
  type ReadComment,
} from './contract.js';
import { historyMarkerOf, markerEntryId } from './marker.js';
import { workspaceHistoryRoot } from './paths.js';
import {
  readLocalReports,
  recordDeveloperReport,
  recordReviewerReport,
  reportSummaryOf,
} from './reports.js';
import type { LocalReport } from './reports.js';
import { readLatestEntries, writeSnapshot } from './store.js';
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

/** One entry candidate before it has an identity. */
interface Candidate {
  readonly entry: HistoryEntry;
  /** The local complete report this rendering mirrors, when it is one. */
  readonly mirrorOf?: string;
}

/** The run id a legacy harness result comment names, when it names one. */
function legacyRunIdOf(text: string): string | null {
  const match = /Harness run ([A-Za-z0-9][A-Za-z0-9_-]{0,127}) for /.exec(text);
  return match?.[1] ?? null;
}

/** Whether one piece of external text is this harness's own publication. */
function isHarnessText(text: string, author: string, harnessAuthors: readonly string[]): boolean {
  if (historyMarkerOf(text) !== null || legacyRunIdOf(text) !== null) {
    return true;
  }
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

/** Where the last report sits in time, or `null` when there is none. */
function lastReportAt(reports: readonly HistoryReportSummary[]): string | null {
  let latest: string | null = null;
  for (const report of reports) {
    if (latest === null || report.createdAt > latest) {
      latest = report.createdAt;
    }
  }
  return latest;
}

/**
 * The latest reviewer round whose decision requested changes, when the newest
 * reviewer report still does. A published native review is used when no complete
 * local report was kept for it; the caller records the gap.
 */
function unresolvedRound(
  reports: readonly HistoryReportSummary[],
  entries: readonly HistoryEntry[],
): { readonly round: HistoryReportSummary; readonly reconstructed: boolean } | null {
  const reviewer = reports
    .filter((report) => report.kind === 'reviewer-report')
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = reviewer.at(-1);
  if (latest !== undefined) {
    const decision = (latest.decision ?? '').toLowerCase();
    return decision.includes('change') ? { round: latest, reconstructed: !latest.complete } : null;
  }
  // No local reviewer report at all: fall back to the native review the App
  // published, and to its inline comments, which are complete external text.
  const reviews = entries
    .filter((entry) => entry.kind === 'pr-review' && entry.role !== 'human')
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = reviews.at(-1);
  if (last === undefined) {
    return null;
  }
  const requested = /changes[_ ]requested|request_changes/i.test(
    `${last.state ?? ''} ${last.problem ?? ''} ${last.text}`,
  );
  if (!requested) {
    return null;
  }
  const findings = entries
    .filter(
      (entry) =>
        entry.kind === 'pr-review-comment' &&
        entry.author === last.author &&
        entry.createdAt >= last.createdAt,
    )
    .map((entry) => ({
      path: entry.url ?? '(inline review comment)',
      line: null,
      body: entry.text,
    }));
  return {
    round: {
      entryId: last.id,
      kind: 'reviewer-report',
      round: null,
      author: last.author,
      createdAt: last.createdAt,
      sourceId: last.sourceId,
      complete: false,
      problem:
        'the complete reviewer report was not kept on this machine; this round is reconstructed ' +
        'from the published native review and its inline comments',
      status: null,
      reason: null,
      head: last.commit,
      decision: 'request_changes',
      summary: last.text,
      findings,
      pullRequest: null,
    },
    reconstructed: true,
  };
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
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
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
      sources.push({
        source: 'harness',
        problem: local.problems.length === 0 ? null : local.problems.join('; '),
      });
      gaps.push(...local.problems);

      const candidates: Candidate[] = [];
      for (const comment of jiraComments) {
        const role = isHarnessText(comment.text, comment.author, harnessAuthors)
          ? 'harness'
          : 'human';
        candidates.push({
          entry: entryOfComment(comment, {
            source: 'jira',
            kind: 'jira-comment',
            role,
            commit: null,
          }),
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
          const role = isHarnessText(comment.text, comment.author, harnessAuthors)
            ? 'harness'
            : 'human';
          candidates.push({
            entry: entryOfComment(comment, {
              source: 'github',
              kind,
              role,
              commit: comment.commit ?? null,
            }),
          });
        }
      }
      for (const report of local.reports) {
        candidates.push({ entry: entryOfReport(report) });
      }

      // Deduplicate by source identity: the newest read of one identity wins,
      // and an entry whose wording changed is marked edited rather than
      // duplicated. A complete local report is never replaced by its rendering.
      const byId = new Map<string, HistoryEntry>();
      for (const candidate of candidates) {
        const existing = byId.get(candidate.entry.id);
        if (existing === undefined) {
          byId.set(candidate.entry.id, candidate.entry);
        } else if (existing.source === 'harness' && candidate.entry.source !== 'harness') {
          continue;
        } else {
          byId.set(candidate.entry.id, candidate.entry);
        }
      }

      // A rendering of a complete report is a mirror, not a second entry: the
      // marker names the report, and a legacy result comment names its run.
      const mirrors: HistoryMirror[] = [];
      const localReportIds = new Set(
        [...byId.values()]
          .filter((entry) => entry.source === 'harness' && entry.kind !== 'missing-report')
          .map((entry) => entry.id),
      );
      for (const entry of [...byId.values()]) {
        if (entry.source === 'harness') {
          continue;
        }
        const marker = historyMarkerOf(entry.text);
        const legacyRunId = entry.kind === 'jira-comment' ? legacyRunIdOf(entry.text) : null;
        const mirrored =
          marker !== null && localReportIds.has(markerEntryId(marker))
            ? markerEntryId(marker)
            : legacyRunId !== null && localReportIds.has(`harness:developer-report:${legacyRunId}`)
              ? `harness:developer-report:${legacyRunId}`
              : null;
        if (mirrored !== null) {
          mirrors.push({ sourceId: entry.sourceId, source: entry.source, ofEntryId: mirrored });
          byId.delete(entry.id);
        }
      }

      const entries = [...byId.values()]
        .map((entry) => {
          const before = previous === null ? undefined : previousOf(previous.entries, entry.id);
          const edited =
            entry.edited ||
            (before !== undefined && before.source !== 'harness' && before.text !== entry.text);
          return { ...entry, edited };
        })
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

      const reports: HistoryReportSummary[] = local.reports
        .map(reportSummaryOf)
        .filter((report): report is HistoryReportSummary => report !== null)
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
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

      const unresolved = unresolvedRound(reports, entries);
      const reconstructedGap =
        unresolved !== null && unresolved.reconstructed
          ? 'the latest review that requested changes has no complete local report; its findings ' +
            'are the published text, which may have been bounded for the destination it was ' +
            'published to'
          : null;
      if (reconstructedGap !== null) {
        gaps.push(reconstructedGap);
      }
      const round = unresolved?.round ?? null;
      const responses =
        round === null
          ? []
          : entries.filter(
              (entry) =>
                entry.id !== round.entryId &&
                entry.createdAt >= round.createdAt &&
                entry.role !== 'harness',
            );
      const lastReport = lastReportAt(reports);
      const newHumanFeedback = entries.filter(
        (entry) =>
          entry.role === 'human' && (lastReport === null ? true : entry.createdAt > lastReport),
      );

      const brief: HistoryBrief = {
        ref: request.ref,
        task: request.task,
        latestDelivery: latestDelivery(pullRequest?.pullRequest ?? null, reports),
        unresolved: round,
        responses,
        newHumanFeedback,
      };
      const content: SnapshotContent = {
        role: request.role,
        round: request.round,
        ref: request.ref,
        task: request.task,
        brief,
        sources,
        gaps,
        mirrors,
        entries,
        reports,
      };
      return await writeSnapshot(root, content, now());
    },

    async recordDeveloperReport(request: DeveloperReportRequest) {
      const root = workspaceHistoryRoot(parts.workDir, request.workspaceId);
      return await recordDeveloperReport(root, request);
    },

    async recordReviewerReport(request: ReviewerReportRequest) {
      const root = workspaceHistoryRoot(parts.workDir, request.workspaceId);
      return await recordReviewerReport(root, request);
    },
  };
}
