/**
 * The ticket conversation history: one identified, locally available snapshot
 * of everything a developer or reviewer turn needs to see, and the complete
 * developer and reviewer reports it is built from.
 *
 * A snapshot is written beside the retained workspace
 * (`<workDir>/workspaces/<workspaceId>.history/`) and never rewritten: a later
 * refresh creates a new snapshot directory and moves `current.json` to it, so a
 * turn that is already running keeps the exact input it was started with. Every
 * entry keeps its original wording and its provenance — the source that said
 * it, who said it, when, which round, and which commit it was about when that
 * applies — and an entry that could not be obtained is marked as missing rather
 * than filled in.
 *
 * This module declares data and shapes; it performs no I/O and imports no
 * connector. `sync.ts` reads the sources, `store.ts` writes the snapshot, and
 * `prompt.ts` renders the one section both role prompts carry.
 */
import type { FindingKind, FindingVerificationState, SourceRef, Task } from '../shared/types.js';

/** Who produced one entry, as the index names it. */
export type HistoryRole = 'human' | 'developer' | 'reviewer' | 'harness';

/** Where one entry came from. */
export type HistorySourceKind = 'jira' | 'github' | 'harness';

/** What one entry is. */
export type HistoryEntryKind =
  /** One comment on the ticket's own thread. */
  | 'jira-comment'
  /** One comment on the pull request (the conversation endpoint). */
  | 'pr-comment'
  /** One native pull-request review, with its body and state. */
  | 'pr-review'
  /** One inline comment of a native pull-request review. */
  | 'pr-review-comment'
  /** One complete developer report the harness kept. */
  | 'developer-report'
  /** One complete reviewer report the harness kept. */
  | 'reviewer-report'
  /**
   * One supervised recovery incident, whole: the stop, every recovery attempt,
   * the conclusion, the resumption and the publication identities the
   * supervisor kept for it. It reaches both roles' briefs as recovery context.
   */
  | 'recovery-report'
  /**
   * A report the harness knows existed — a workspace attempt, or a review
   * record — whose complete content is no longer readable. It is kept as an
   * explicit marker, never as invented text.
   */
  | 'missing-report';

/**
 * One conversation entry: the original wording, and the provenance that makes
 * it attributable. Nothing here is a command, a path, a configuration value, or
 * a permission: external text is context for a turn, and nothing else.
 */
export interface HistoryEntry {
  /** Stable identity within one ticket: `<source>:<kind>:<sourceId>`. */
  readonly id: string;
  readonly source: HistorySourceKind;
  readonly kind: HistoryEntryKind;
  readonly role: HistoryRole;
  readonly author: string;
  readonly createdAt: string;
  /** When the source last edited it, or `null` when the source reports none. */
  readonly updatedAt: string | null;
  /** The attempt or review round this entry belongs to, when it is known. */
  readonly round: number | null;
  /** The reviewed or delivered commit this entry is about, when it has one. */
  readonly commit: string | null;
  /** A native review's state (`APPROVED`, `CHANGES_REQUESTED`, …), when it has one. */
  readonly state: string | null;
  /** A browser link to the source entry, when the source reports one. */
  readonly url: string | null;
  /** The source's own identifier: a Jira comment id, a GitHub review id, a run id. */
  readonly sourceId: string;
  /** The complete original wording. Never silently truncated. */
  readonly text: string;
  /** Whether the source reports this entry was edited after it was written. */
  readonly edited: boolean;
  /**
   * Whether this entry carries what it claims to carry in full. A report whose
   * complete content is missing is `false` and carries the reason; a comment a
   * source reported in full is `true`.
   */
  readonly complete: boolean;
  /** Why the entry is not complete; `null` when it is. */
  readonly problem: string | null;
  /** The file under the snapshot that holds this entry, set when it is written. */
  readonly file: string | null;
}

/** One place a grouped finding names: the file, and the line when it has one. */
export interface HistoryOccurrence {
  readonly path: string;
  readonly line: number | null;
}

/**
 * One finding of a reviewer report, whole, with the identity it keeps.
 *
 * The identity is stable for as long as the finding is outstanding: it is
 * derived from the review round and the finding's position in it
 * (`findingIdOf`, `findings.ts`), and both roles name the finding by it — the
 * developer answers it, and a later reviewer verifies that answer or groups a
 * related occurrence under it (docs/WORKFLOW.md §9).
 */
export interface HistoryFinding {
  /** Stable identity within the ticket, for example `R2-F3`. */
  readonly id: string;
  /**
   * What this review's own report recorded the finding as, when that is not the
   * identity above: the round and position (`R2-F1`) this review states the
   * occurrence at. A finding that continues an earlier one keeps the earlier
   * identity — one defect, one identity — and this records where the review
   * raised it again, so the review's own position is not lost and is not
   * mistaken for a second defect.
   */
  readonly recordedAs?: string;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
  /**
   * How this round classified the finding against the rounds before it. Absent
   * on a report recorded before this classification existed, which is read as
   * `new`.
   */
  readonly kind?: FindingKind;
  /**
   * The earlier finding identity this one continues, stated with `unresolved`
   * and `regression`. A continuation never leaves the earlier identity implied:
   * it is what ties the rounds together.
   */
  readonly continues?: string | null;
  /**
   * Other confirmed occurrences of the same defect this finding groups, so a
   * reviewer reports one defect with every place it reached instead of one
   * finding per example.
   */
  readonly related?: readonly HistoryOccurrence[];
}

/**
 * One developer answer to one outstanding finding, as the harness read it from
 * the developer's own complete report. It is a claim, never a verification: the
 * reviewer is the one who verifies it, and the two are kept apart
 * (docs/WORKFLOW.md §9).
 */
export interface FindingAnswer {
  /** The finding identity the answer names. */
  readonly finding: string;
  /** Whether every one of the five fields was stated and nonblank. */
  readonly complete: boolean;
  /** Why the answer is not complete; `null` when it is. */
  readonly problem: string | null;
  readonly cause: string | null;
  readonly scope: string | null;
  readonly repair: string | null;
  readonly verification: string | null;
  readonly uncertainty: string | null;
}

/** One developer answer with the report it was recorded in. */
export interface HistoryFindingResponse extends FindingAnswer {
  /** The complete developer report entry the answer was read from. */
  readonly entryId: string;
  readonly runId: string;
  /** The attempt round the report belongs to, when it has one. */
  readonly round: number | null;
  readonly createdAt: string;
}

/**
 * One reviewer verification of an earlier finding's disposition: the reviewer's
 * own reading of the repaired revision, which is what makes a claimed fix a
 * verified one — or records that it is still not verified.
 */
export interface HistoryFindingVerification {
  /** The earlier finding identity this verifies. */
  readonly finding: string;
  readonly state: FindingVerificationState;
  /** What the reviewer itself observed, at the place the defect lived. */
  readonly evidence: string;
}

/** One pull request as the history records the latest delivery. */
export interface HistoryDelivery {
  readonly number: number | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  /** The delivered or reviewed commit GitHub reports now. */
  readonly head: string | null;
  /** When this delivery was observed; the source reports no update instant. */
  readonly observedAt: string | null;
  /** The round of the attempt that delivered it, when that is known. */
  readonly round: number | null;
  /** Where the full record of the delivery is in the snapshot. */
  readonly entryId: string | null;
}

/**
 * One developer or reviewer report, structured for the brief. The complete
 * report is an entry of its own; this is what the prompt renders, and it carries
 * every finding whole.
 */
export interface HistoryReportSummary {
  /** The entry id of the report's own complete text. */
  readonly entryId: string;
  readonly kind: 'developer-report' | 'reviewer-report';
  readonly round: number | null;
  readonly author: string;
  readonly createdAt: string;
  /** The run or review the report belongs to. */
  readonly sourceId: string;
  /** Whether the complete report is present, or only its published rendering. */
  readonly complete: boolean;
  /** Why the complete report is missing; `null` when it is present. */
  readonly problem: string | null;
  /** The run outcome, for a developer report. */
  readonly status: string | null;
  readonly reason: string | null;
  /** The reviewed head, for a reviewer report. */
  readonly head: string | null;
  /**
   * The native review this report was published as, when the harness recorded
   * that publication. It is the identity synchronization authenticates a
   * mirrored review rendering against.
   */
  readonly nativeReviewId: number | null;
  /** The review decision, for a reviewer report. */
  readonly decision: string | null;
  readonly summary: string | null;
  readonly findings: readonly HistoryFinding[];
  /**
   * What this review verified about the dispositions earlier reviews raised:
   * a claimed fix and a verified fix are different facts, and only this records
   * the second (docs/WORKFLOW.md §9).
   */
  readonly verifications?: readonly HistoryFindingVerification[];
  /**
   * The developer's answers to this round's own findings, recorded after the
   * round and read from the complete developer reports. A finding with no
   * complete answer says so; it never appears as complete remediation.
   */
  readonly responses?: readonly HistoryFindingResponse[];
  readonly pullRequest: HistoryDelivery | null;
}

/**
 * The current brief a turn is started with: the ticket's requirements, the
 * latest delivery, the complete unresolved review findings and the discussion
 * that answered them, and feedback unseen by this role’s last completed turn.
 */
export interface HistoryBrief {
  readonly ref: SourceRef;
  readonly task: Task;
  readonly latestDelivery: HistoryDelivery | null;
  /**
   * The latest review round whose findings are still unresolved, with every
   * finding whole. `null` when no outstanding request remains. For all reviewers use
   * `unresolvedReviews`; this single latest entry supports legacy consumers.
   */
  readonly unresolved: HistoryReportSummary | null;
  /** All outstanding review rounds, independently tracked by reviewer. */
  readonly unresolvedReviews?: readonly HistoryReportSummary[];
  /** What the ticket or the pull request said after that unresolved review. */
  readonly responses: readonly HistoryEntry[];
  /** Human feedback new or edited since this role’s last consumed snapshot. */
  readonly newHumanFeedback: readonly HistoryEntry[];
  /**
   * Recovery context for both roles, whole: the complete incident records of
   * this ticket's supervised recoveries, and the comments the same service
   * account made while handling them. A recovery report says what stopped, what
   * was investigated and repaired, and what resumes; it is context for the work
   * and never an approval, a verification, or a finished state.
   */
  readonly recovery?: readonly HistoryEntry[];
}

/** One entry whose text is a published rendering of a local complete report. */
export interface HistoryMirror {
  /** A completion rendering whose distinct context remains an entry. Kept
   * whole with source provenance, so splitting off a mirror loses no wording. */
  readonly originalEntry?: HistoryEntry;
  /** The external entry that was not added again. */
  readonly sourceId: string;
  readonly source: HistorySourceKind;
  /** The complete local entry it mirrors. */
  readonly ofEntryId: string;
  /**
   * The SHA-256 of the rendering that was recognized as this report's own. A
   * later read whose text no longer hashes to it is a rendering that was edited
   * after publication: it is kept as an entry, never folded away again.
   */
  readonly textSha256: string;
}

/** What one source read produced, and why it may be incomplete. */
export interface HistorySourceRead {
  readonly source: 'jira' | 'github' | 'harness';
  /** Why the read is incomplete; `null` when the source was read in full. */
  readonly problem: string | null;
}

/**
 * One identified snapshot: the directory a turn can read and search with its
 * ordinary tools, the brief it is given, and the gaps the harness knows about.
 */
export interface HistorySnapshot {
  readonly version: 1;
  /** The snapshot's identity: the content hash of everything below. */
  readonly id: string;
  readonly role: 'developer' | 'reviewer';
  /** The attempt or review round this snapshot was prepared for. */
  readonly round: number | null;
  /** When the snapshot was first written. */
  readonly takenAt: string;
  /** `<workDir>/workspaces/<workspaceId>.history`. */
  readonly root: string;
  /** `<root>/snapshots/<id>`. */
  readonly dir: string;
  /** `<dir>/index.md`: the concise index by role, author, time, round, source and commit. */
  readonly indexPath: string;
  /** `<dir>/index.json`: the same index, machine-readable. */
  readonly indexJsonPath: string;
  /** `<dir>/entries.jsonl`: one JSON object per entry, with its file. */
  readonly entriesPath: string;
  /** `<root>/reports`: the complete developer and reviewer reports, kept before publication. */
  readonly reportsDir: string;
  readonly brief: HistoryBrief;
  readonly entries: readonly HistoryEntry[];
  readonly reports: readonly HistoryReportSummary[];
  readonly gaps: readonly string[];
  readonly mirrors: readonly HistoryMirror[];
  readonly sources: readonly HistorySourceRead[];
}

/** One comment as a source reader returns it, before it becomes an entry. */
export interface ReadComment {
  readonly sourceId: string;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly text: string;
  readonly url: string | null;
  /** GitHub's review state, when the comment is a native review. */
  readonly state?: string | null;
  readonly commit?: string | null;
  readonly path?: string | null;
  readonly line?: number | null;
  /**
   * The comment's own body, without the path and line the reader composes into
   * {@link text} for an inline review comment. Used to match a published inline
   * finding against the complete report that holds the same finding.
   */
  readonly body?: string | null;
  /**
   * The native review an inline review comment belongs to, when the source
   * reports one. It is the parent identity that maps the comment to the report
   * the harness published as that review.
   */
  readonly reviewId?: number | null;
  /**
   * The inline comment this comment replies to, when the source reports one. A
   * reply is its own conversational entry and is never a mirrored finding.
   */
  readonly inReplyToId?: number | null;
}

/** What one Jira thread read produced. */
export interface JiraThreadRead {
  readonly comments: readonly ReadComment[];
  /** True when the source reported more pages than the reader followed. */
  readonly truncated: boolean;
}

/** One pull request's conversation as a reader returns it. */
export interface PullRequestConversationRead {
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headSha: string;
    /** When the pull request was read; GitHub reports no separate update instant here. */
    readonly observedAt: string;
  } | null;
  readonly comments: readonly ReadComment[];
  readonly truncated: boolean;
}

/** The remote readers one ticket history is built from. */
export interface HistoryReaders {
  /** Refresh requirements before each turn; absent only for caller-supplied offline input. */
  readonly currentTask?: (
    ref: SourceRef,
    stop: AbortSignal,
  ) => Promise<{ readonly ref: SourceRef; readonly task: Task }>;
  /**
   * Every comment of the ticket's own thread, whole, paginated by the reader.
   * Throws when the read cannot be made; the failure becomes a gap, so the turn
   * still starts with the gap named instead of an empty thread presented as one.
   */
  readonly jiraThread: (ref: SourceRef, stop: AbortSignal) => Promise<JiraThreadRead>;
  /**
   * The pull request conversation of the workspace's branch: the pull request
   * itself, its conversation comments, its native reviews, and its inline review
   * comments. A ticket with no pull request returns `null` for the pull request
   * and no comments; that is not a gap.
   */
  readonly pullRequestConversation: (
    ref: SourceRef,
    workspaceId: string,
    stop: AbortSignal,
  ) => Promise<PullRequestConversationRead | null>;
}

/** One complete developer report, recorded before its rendering is published. */
export interface DeveloperReportRequest {
  readonly ref: SourceRef;
  readonly workspaceId: string;
  readonly task: Task;
  /** Which attempt of the workspace this run was. */
  readonly round: number;
  readonly runId: string;
  /** `result.json`, the run's own complete report. */
  readonly reportPath: string;
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
  readonly now: Date;
}

/** One complete reviewer report, recorded before its native rendering is published. */
export interface ReviewerReportRequest {
  readonly ref: SourceRef;
  readonly workspaceId: string;
  readonly task: Task;
  readonly reviewId: string;
  readonly round: number;
  readonly head: string;
  readonly decision: string;
  readonly summary: string;
  /**
   * The findings this review raises. An identity the reviewer supplied is kept
   * when it is one this harness assigned; otherwise the harness assigns the
   * round's own identity from the finding's position (`findingIdOf`).
   */
  readonly findings: readonly UnidentifiedFinding[];
  /** What this review verified about earlier dispositions, if any. */
  readonly verifications?: readonly HistoryFindingVerification[];
  readonly now: Date;
}

/** One finding as a caller states it, before the harness fixes its identity. */
export type UnidentifiedFinding = Omit<HistoryFinding, 'id'> & { readonly id?: string };

/** What one recording wrote to the history root. */
export interface RecordedReport {
  /** The digest file: `<root>/reports/developer-<runId>.json` or the reviewer equivalent. */
  readonly file: string;
  /** Where the complete rendering is. */
  readonly completeFile: string | null;
  readonly round: number;
}

/** Why preparing a snapshot failed, and whether a turn may start without it. */
export class HistoryError extends Error {
  /**
   * `essential` means nothing usable could be written or read beside the
   * workspace, so the turn must not start: a turn without local history is not
   * the contract. Every other failure is a gap the prompt names.
   */
  readonly kind: 'essential' | 'read' | 'write';

  constructor(
    kind: 'essential' | 'read' | 'write',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HistoryError';
    this.kind = kind;
  }
}

/** What one snapshot preparation is asked for. */
export interface HistoryPrepareRequest {
  readonly ref: SourceRef;
  readonly task: Task;
  readonly workspace: {
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly branch: string;
    readonly baseCommit: string;
  };
  readonly role: 'developer' | 'reviewer';
  readonly round: number | null;
  readonly stop: AbortSignal;
}

/**
 * The ticket history as a run and a review use it: prepare one identified
 * snapshot before a turn, and record each complete report before its concise
 * external rendering is published.
 */
export interface TicketHistory {
  prepare(request: HistoryPrepareRequest): Promise<HistorySnapshot>;
  /** Advance only this role's feedback cursor after a turn returns usable output. */
  consumed?(snapshot: HistorySnapshot): Promise<void>;
  /**
   * Saves the complete developer report of one finished run under
   * `<root>/reports`, before any comment that renders it is published. Absent
   * when the caller has no history configured.
   */
  recordDeveloperReport?(request: DeveloperReportRequest): Promise<RecordedReport>;
  /** Saves the complete reviewer verdict before its native review is published. */
  recordReviewerReport?(request: ReviewerReportRequest): Promise<RecordedReport>;
  /**
   * Notes the comment a complete developer report was published as, once the
   * source acknowledged it. It is enrichment after publication: the report and
   * the comment already exist, the identity is what lets a later
   * synchronization recognize the rendering as a mirror instead of a second
   * conversational entry, and a failure here invalidates neither.
   */
  notePublishedDeveloperReport?(request: PublishedDeveloperReport): Promise<void>;
}

/** The acknowledged publication of one complete developer report. */
export interface PublishedDeveloperReport {
  readonly workspaceId: string;
  /** The run whose report was published. */
  readonly runId: string;
  /** The source's own identity for the comment: a Jira comment id. */
  readonly commentId: string;
  /** A browser link to the comment, when one is known. */
  readonly url: string | null;
  /** The complete text the comment was published with, exactly as it was sent. */
  readonly text: string;
}
