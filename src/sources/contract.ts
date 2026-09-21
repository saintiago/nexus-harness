/**
 * The task-input boundary: what a source is, the ordinary data it exchanges,
 * and the failures the coordinator acts on.
 *
 * A source lists the external items that are eligible, prepares one of them as
 * the existing four-field `Task`, claims it, publishes the local result, and
 * records where an item's work lives. Everything else about intake is ordinary
 * coordination around the unchanged runner, and it lives in coordinator.ts.
 * This module declares data and shapes; it performs no I/O and imports no
 * connector.
 */
import type { DeliveredPullRequest, Delivery } from '../delivery/github.js';
import type { RunTaskResult } from '../runs/contracts.js';
import type {
  CheckRoundResult,
  EscalationTier,
  RunStatus,
  SourceRef,
  Task,
} from '../shared/types.js';
import type { PreflightRequest, SourcePreflight } from '../workspace/preflight.js';
import type { ContinuedWorkspace } from '../workspace/reopen.js';

/** How a source failed, in the few categories the coordinator acts on. */
export type SourceProblemKind =
  /** The external item is real but cannot be mapped to a valid task. */
  | 'invalid-task'
  /** The item is no longer eligible: moved, relabelled, retitled away, or edited. */
  | 'stale'
  /** A read that a later scan may succeed at: network, timeout, 429, 5xx. */
  | 'retryable-read'
  /** Nothing a retry can fix: configuration, authentication, malformed answers. */
  | 'fatal'
  /** A write whose outcome is unknown or refused: never replayed automatically. */
  | 'uncertain-write';

/** A source failure, classified so the coordinator can act on it. */
export class SourceError extends Error {
  readonly kind: SourceProblemKind;
  /**
   * A server-directed minimum wait, in milliseconds, when the failure carried
   * one (HTTP `Retry-After`). `null` when the source did not ask for a wait.
   */
  readonly retryAfterMs: number | null;

  constructor(
    kind: SourceProblemKind,
    message: string,
    parts: { readonly retryAfterMs?: number | null; readonly cause?: unknown } = {},
  ) {
    super(message, parts.cause === undefined ? undefined : { cause: parts.cause });
    this.name = 'SourceError';
    this.kind = kind;
    this.retryAfterMs = parts.retryAfterMs ?? null;
  }
}

/**
 * A result that could not be published. It says how far delivery got, so a
 * receipt can record an acknowledged comment even when the status change after
 * it failed (docs/spec.md §6, "Jira feedback and completion").
 */
export class SourceFeedbackError extends Error {
  /** Which step failed. */
  readonly stage: 'comment' | 'transition';
  /** The acknowledged comment, when the failure happened after it. */
  readonly commentId: string | null;

  constructor(stage: 'comment' | 'transition', message: string, commentId: string | null = null) {
    super(message);
    this.name = 'SourceFeedbackError';
    this.stage = stage;
    this.commentId = commentId;
  }
}

/** One eligible external item, before its content has been read. */
export interface SourceCandidate {
  readonly ref: SourceRef;
  /**
   * The item's title as the source lists it; a preview, not the task. A search
   * result can lag, so nothing else about the item is carried here: what the item
   * says now, including the workspace pointers it carries, is read by `prepare`.
   */
  readonly title: string;
}

/**
 * The label that names where an issue's work lives: `harness-ws-<workspaceId>`.
 * It is written exactly once, by the run that creates the workspace, and a later
 * attempt only ever reads it.
 */
export const WORKSPACE_POINTER_PREFIX = 'harness-ws-';

/** The pointer label for one workspace. */
export function workspacePointerLabel(workspaceId: string): string {
  return `${WORKSPACE_POINTER_PREFIX}${workspaceId}`;
}

/** The workspace ids a set of labels names, in the order the labels came. */
export function parseWorkspacePointers(labels: readonly string[]): readonly string[] {
  return labels
    .filter((label) => label.startsWith(WORKSPACE_POINTER_PREFIX))
    .map((label) => label.slice(WORKSPACE_POINTER_PREFIX.length))
    .filter((id) => id !== '');
}

/** One external item, prepared as exactly the existing `Task`. */
export interface SourceTask {
  readonly ref: SourceRef;
  readonly task: Task;
  /**
   * The workspace ids the item's pointer labels name, in the order they were
   * read, as the read that produced this task observed them. The fresh, continue,
   * or refuse decision is made from these, never from what a search result said
   * earlier: a search can lag behind the item
   * (docs/implement-workspace-continuation.md).
   */
  readonly pointers: readonly string[];
  /**
   * The name this source prefers for the workspace a first attempt creates,
   * when it has one: the item's canonical key, for example `HARN-23`, so
   * retained work is recognizable as the item it belongs to. It is a
   * preference, never a path — the naming layer validates it like a pointer
   * label and falls back to the run's own generated id — and a source that
   * names none (or a task file, which has no source at all) keeps that
   * generated name (docs/implement-workspace-continuation.md).
   */
  readonly preferredWorkspaceId?: string;
}

/**
 * The local outcome of one run, projected for publication: the facts a result
 * comment states, and no transcript, environment, or diff.
 */
export interface SourceRunOutcome {
  /** Whether a separately configured pass may finish a delivered attempt. */
  readonly completionEnabled?: boolean;
  readonly runId: string;
  readonly status: RunStatus;
  readonly reason: string;
  readonly repairsUsed: number;
  /** One line about the checks that decided the run. */
  readonly checks: string;
  /** Where the run was kept, marked as a local path by whoever prints it. */
  readonly runDir: string;
  /** The run's own `result.json`. */
  readonly reportPath: string;
  /**
   * Which rung of this cycle's ladder this run was, and the tier that ran it:
   * present when more than one attempt is possible, so the published result says
   * so. The number is the attempt's position in the cycle the item was claimed
   * for; the run's own report and the workspace ledger keep the workspace's
   * attempt count, which is separate and stays truthful
   * (docs/implement-workspace-continuation.md).
   */
  readonly attempt?: {
    readonly number: number;
    readonly of: number;
    readonly tier: string;
  };
  /**
   * The pull request this attempt's work was delivered as, when a delivery step
   * is configured and the attempt produced one. Absent when delivery is
   * disabled, the run did not pass, or a passed attempt had nothing to deliver
   * (docs/WORKFLOW.md §8).
   */
  readonly pullRequest?: DeliveredPullRequest;
  /**
   * Why the configured delivery step failed, when it did: the run's own outcome
   * above is still what happened, and this is the publication failure reported
   * beside it. Absent when delivery is disabled, the run did not pass, or the
   * delivery step completed (docs/WORKFLOW.md §8).
   */
  readonly deliveryFailure?: string;
}

/**
 * One comment on a source item, rendered and attributed: what a person or
 * another agent added since the attempt that is being continued. It is context
 * for a turn, never a command, a path, or a limit.
 */
export interface SourceComment {
  /** Who wrote it, as the source names them. */
  readonly author: string;
  /** When it was written, as an ISO timestamp. */
  readonly createdAt: string;
  /** Its text, rendered as readable plain text. */
  readonly text: string;
}

/**
 * A concrete task source. Four ordinary async functions:
 *
 * - `listEligible` consumes every page and returns a finite, ordered,
 *   de-duplicated batch. A cursor is not part of the contract.
 * - `prepare` re-reads the item, tests eligibility again, maps and validates the
 *   four-field task, and returns `null` for an item that no longer qualifies. An
 *   item that is real but unusable throws a {@link SourceError} of kind
 *   `invalid-task`. The prepared item carries the pointer labels that read
 *   observed, so the continuation decision never uses a stale search result.
 * - `claim` rechecks the captured revision and the eligibility rules, then
 *   requests the transition to the running status. `false` means it sent **no**
 *   mutation request and the coordinator may release the receipt it just
 *   created. Once a request was sent, an error throws and retains the receipt.
 * - `progress` publishes one attempt's bounded summary while the item stays in
 *   the running status: an escalation ladder that has more rungs to climb has
 *   not finished with the item yet.
 * - `complete` publishes a bounded summary and moves the item to review: the
 *   ladder's last word, whether it passed, failed terminally, or ran out of
 *   rungs. It throws {@link SourceFeedbackError} when delivery fails.
 */
export interface TaskSource {
  listEligible(stop: AbortSignal): Promise<readonly SourceCandidate[]>;
  prepare(candidate: SourceCandidate, stop: AbortSignal): Promise<SourceTask | null>;
  claim(item: SourceTask, stop: AbortSignal): Promise<boolean>;
  /**
   * Publishes one attempt's compact result comment **without** moving the item:
   * the attempt is over, but the item's intake is not — another rung of the
   * ladder will run in the same retained workspace — so the item stays in the
   * running status and this comment is how the item's own thread holds the
   * attempt's outcome (docs/implement-workspace-continuation.md). Throws
   * {@link SourceFeedbackError} when the comment cannot be published.
   */
  progress(item: SourceTask, outcome: SourceRunOutcome, stop: AbortSignal): Promise<void>;
  complete(item: SourceTask, outcome: SourceRunOutcome, stop: AbortSignal): Promise<void>;
  /**
   * Records where the item's work lives, as the pointer label naming its
   * workspace. Called once, for the run that creates a workspace, after that
   * workspace exists and before any coding turn runs.
   */
  recordWorkspace(item: SourceTask, workspaceId: string, stop: AbortSignal): Promise<void>;
  /**
   * Publishes a refusal: one comment naming why the harness will not act on the
   * item, and the item taken out of the queue. Nothing was claimed and nothing
   * ran. Throws {@link SourceFeedbackError} when delivery fails.
   */
  refuse(item: SourceTask, reason: string, stop: AbortSignal): Promise<void>;
  /**
   * The comments added after one instant, oldest first: what the item's own
   * thread says since the attempt being continued. A source that has no such
   * thread returns none.
   */
  commentsSince(
    item: SourceTask,
    since: string,
    stop: AbortSignal,
  ): Promise<readonly SourceComment[]>;
}

/** Where the coordinator writes progress. Tests pass a recorder. */
export interface SourceIo {
  out(text: string): void;
  err(text: string): void;
}

/** What one run of one prepared item is asked to do. */
export interface SourceRunRequest {
  readonly task: Task;
  readonly sourceRef: SourceRef;
  readonly stop: AbortSignal;
  /** The rung this attempt runs, or nothing when no ladder was read. */
  readonly tier?: EscalationTier;
  /**
   * Context for a continued attempt: what earlier attempts in this workspace did
   * and what the item's thread said since. Bounded, and context only
   * (docs/implement-workspace-continuation.md).
   */
  readonly guidance?: readonly string[];
  /**
   * A workspace this run continues, resolved and verified by the coordinator, or
   * nothing for a run that creates one.
   */
  readonly continuedWorkspace?: ContinuedWorkspace;
  /**
   * The name the item's source prefers for the workspace a first attempt
   * creates, when it has one; ignored for a continued attempt, whose workspace
   * the pointer already names.
   */
  readonly preferredWorkspaceId?: string;
  /**
   * Called once, after a fresh workspace exists and before any coding turn: where
   * the work lives, so the source can record it on the item it came from.
   */
  readonly onWorkspaceReady?: (workspace: { readonly workspaceId: string }) => Promise<void>;
}

/**
 * The finding one pre-delivery baseline diagnosis produced, as the reviewer
 * turn wrote it down: either the concrete repair the next coding turn can make
 * in the working copy, or why no repair may be made automatically. It is data:
 * nothing here is a command, a path, or a limit of its own, and none of it
 * changes the acceptance criteria or the checks that decide the run
 * (docs/WORKFLOW.md §11).
 */
export type BaselineFinding =
  | {
      /** The baseline failure has a cause the next coding turn can repair. */
      readonly outcome: 'repair';
      /** The check that failed, as the configuration spells it. */
      readonly failingCheck: string;
      /** What the check's own output shows: the evidence of the failure. */
      readonly evidence: string;
      /** The most likely cause, named concretely. */
      readonly likelyCause: string;
      /** What the next coding turn should change to repair the baseline. */
      readonly repairGuidance: string;
    }
  | {
      /** No repair may be attempted: evidence is missing, the cause is environmental, or a repair is unsafe. */
      readonly outcome: 'inconclusive';
      /** Why the baseline failure is not actionable. */
      readonly reason: string;
      /** What a person must supply, do, or decide before another attempt. */
      readonly requiredAction: string;
    };

/**
 * The part of one prepared item a pre-delivery diagnosis reads: the immutable
 * identity it is keyed by, and the task the baseline failed under. Nothing here
 * is a command, a path, or a limit of its own, and a diagnosis publishes nothing
 * about the item's pointer labels, so it is handed this and not a whole source
 * task.
 */
export interface BaselineItem {
  readonly ref: SourceRef;
  readonly task: Task;
}

/**
 * What one pre-delivery baseline diagnosis is handed: the item the workspace
 * belongs to, the fresh retained workspace the baseline ran in, and the
 * completed red round itself — the configured commands and bounded output
 * evidence. The workspace is the immutable source snapshot: no coding turn ran
 * in it, so it is still at its recorded base.
 */
export interface BaselineDiagnosisRequest {
  readonly item: BaselineItem;
  readonly workspace: {
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly branch: string;
    readonly baseCommit: string;
  };
  readonly baseline: CheckRoundResult;
  readonly stop: AbortSignal;
}

/** What one pre-delivery baseline diagnosis did with the item. */
export type BaselineDiagnosisOutcome =
  /**
   * An actionable finding is on the item's thread (at most once) and the item
   * is back in the status it was claimed from, ready for the next claim.
   */
  | { readonly kind: 'repair'; readonly detail: string; readonly commentId: string | null }
  /**
   * Nothing actionable: the item carries what was observed and what a person
   * must do, and it stays in the review status. No coding turn is started.
   */
  | { readonly kind: 'attention'; readonly detail: string; readonly commentId: string | null }
  /** The intake was stopped while the diagnosis ran. */
  | { readonly kind: 'cancelled'; readonly detail: string };

/**
 * What finishing a pending pre-delivery diagnosis did, as the coordinator and
 * the serial queue read it. `problem` is reserved for the diagnosis's own
 * machinery: the retained evidence could not be read, or the item could not be
 * asked about at all, so a person looks before anything else is taken
 * (docs/WORKFLOW.md §11).
 */
export type BaselineResumeOutcome =
  /** An actionable finding is on the thread and the item is back in its ready status. */
  | { readonly kind: 'repair'; readonly detail: string; readonly commentId: string | null }
  /**
   * Nothing actionable: the item carries the evidence and what a person must
   * do, and it stays in the review status. No coding turn is started from it.
   */
  | { readonly kind: 'attention'; readonly detail: string; readonly commentId: string | null }
  /** The pending diagnosis could not be finished, so nothing else is taken. */
  | { readonly kind: 'problem'; readonly detail: string }
  /** The caller stopped the intake while the pending diagnosis was finished. */
  | { readonly kind: 'cancelled'; readonly detail: string };

/**
 * The one comment of an item's own thread the pre-delivery diagnosis reads:
 * what the record below answers, and where a marker is looked for. It carries
 * no runtime or repository data.
 */
export interface SourceNote {
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
}

/**
 * The item's own thread and status, as one pre-delivery diagnosis reads and
 * writes them. Production is the Jira connector's own small module; a test
 * hands a fake the same way it fakes the source itself.
 */
export interface BaselineRecord {
  /** Every comment of the item's thread, oldest first. */
  listComments(id: string, stop: AbortSignal): Promise<readonly SourceNote[]>;
  /** Posts one comment of plain paragraphs and acknowledges its ID. */
  postComment(id: string, paragraphs: readonly string[], stop: AbortSignal): Promise<string>;
  /**
   * Whether the item is still in the status the harness claims work into. A
   * pending diagnosis is finished only while the item is still there: one a
   * person has moved somewhere else is left exactly where that person left it.
   * `false` also covers an item that is gone.
   */
  isRunning(id: string, stop: AbortSignal): Promise<boolean>;
  /**
   * Moves the item to `target`, but only while it really is still in its
   * running status. `left-alone` means somebody moved it first: that is
   * respected, and no transition is sent.
   */
  moveFromRunning(id: string, target: string, stop: AbortSignal): Promise<'moved' | 'left-alone'>;
}

/** What one pre-delivery reviewer turn is given. */
export interface BaselineReviewRequest {
  /** The evidence directory the turn keeps its input, log and finding in. */
  readonly dir: string;
  /** The item: its immutable identity and the task the baseline failed under. */
  readonly item: BaselineItem;
  /**
   * The retained workspace the baseline ran in, and the snapshot the turn
   * inspects: a clone pinned at the recorded base commit.
   */
  readonly workspace: { readonly path: string; readonly baseCommit: string };
  /** The completed red baseline round: the configured commands and their evidence. */
  readonly baseline: CheckRoundResult;
  readonly stop: AbortSignal;
}

/**
 * What one pre-delivery reviewer turn produced. `finding` is `null` exactly
 * when `problem` is not: a turn that did not complete, or wrote nothing usable,
 * has no finding the diagnosis may publish.
 */
export interface BaselineReviewResult {
  /** The reviewer's own final message, or `null` when it gave none. */
  readonly summary: string | null;
  readonly finding: BaselineFinding | null;
  readonly problem: string | null;
  /** The turn's own log file, kept beside its evidence. */
  readonly logPath: string;
}

/**
 * The one bounded reviewer turn a pre-delivery diagnosis runs: a local turn
 * over a read-only snapshot of the workspace, answering with one finding file.
 * It receives no coding instruction, starts no coding turn, and changes no
 * working copy (docs/WORKFLOW.md §11).
 */
export type BaselineReview = (request: BaselineReviewRequest) => Promise<BaselineReviewResult>;

/**
 * The bounded pre-delivery diagnostic a completed red baseline on a fresh
 * workspace enters before any coding turn: one local reviewer turn over the
 * exact source snapshot, and one Jira record of what it found. It is composed
 * by the CLI from the configured reviewer, the source's own thread and
 * statuses, and the output directory; the coordinator only decides when it
 * runs (docs/WORKFLOW.md §11).
 */
export interface BaselineDiagnosis {
  diagnose(request: BaselineDiagnosisRequest): Promise<BaselineDiagnosisOutcome>;
  /**
   * Finish the diagnosis a previous invocation left pending, from the evidence
   * it retained and the item's own thread, before anything is discovered or
   * claimed. `null` means nothing was pending: every piece of retained evidence
   * already carries its finding or already left the running status, so nothing
   * was written, moved, or spent. The same snapshot, commands, and results are
   * never diagnosed twice, and a finding an earlier turn completed locally is
   * reused when the publication it belonged to was interrupted
   * (docs/WORKFLOW.md §11).
   */
  resume(stop: AbortSignal): Promise<BaselineResumeOutcome | null>;
}

/**
 * The pieces the coordinator needs, all ordinary functions. `run` is the
 * existing runner, composed by the CLI with the loaded configuration; the
 * coordinator never builds a runner, an agent, or a command plan.
 */
export interface SourceContext {
  readonly source: TaskSource;
  /** The retained output directory the receipts and runs live under. */
  readonly workDir: string;
  /**
   * The stable namespace the connected project's intake lock is named by, as
   * the composed configuration derives it (`projectLockNamespace` in
   * `src/config/load.ts`). Two consumers of the same connected project and
   * `workDir` share it; two different connected projects under one `workDir`
   * do not, so they may consume their own queues concurrently
   * (docs/spec.md §6).
   */
  readonly lockNamespace: string;
  /**
   * The escalation ladder, at least one rung. Every coding cycle — a first claim,
   * and a claim that continues the workspace a reviewer's findings, a failed
   * required check, a delivery failure, or a failed post-merge workflow returned
   * to the ready status — starts again at the first rung, in the same retained
   * workspace. Only a rung whose own run spent its repair allowance and ended on
   * an ordinary red check round climbs to the next, and the cycle ends at the
   * last rung. `escalationTiers(config)` is how the CLI reads it
   * (docs/implement-workspace-continuation.md).
   */
  readonly tiers: readonly EscalationTier[];
  /** The target repository every fetched task is bound to. */
  readonly repoPath: string;
  readonly io: SourceIo;
  /** The intake's own stop request: the caller's interrupt. */
  readonly stop: AbortSignal;
  /**
   * The optional delivery step: what a passed attempt's committed work is
   * published as, before its result is reported. Absent means the local-only
   * behavior — nothing is pushed and no pull request is opened. The coordinator
   * starts it only for a passed attempt, and a failure stops intake instead of
   * starting another attempt (docs/WORKFLOW.md §8).
   */
  readonly delivery?: Delivery;
  /**
   * The optional review-to-completion pass: what an In Review item's delivered
   * pull request is carried through once the Nexus Lens reviewer approved it.
   * Absent means an In Review item waits for a person, exactly as before. The
   * coordinator runs it after a finite batch and after each watch scan; it never
   * changes the intake's own outcome and never starts a coding turn
   * (docs/WORKFLOW.md §9).
   */
  readonly completion?: CompletionRun;
  /**
   * The optional pre-delivery baseline diagnosis: what a completed red
   * baseline on a fresh workspace is handed to before any coding turn, so an
   * actionable finding returns the same ticket to its ready status with
   * guidance instead of leaving it In Review with none. Absent means the
   * existing behaviour — the failed attempt is published and the item waits In
   * Review for a person (docs/WORKFLOW.md §11).
   */
  readonly baselineDiagnosis?: BaselineDiagnosis;
  /** The existing source/output preflight, re-run before each reservation. */
  readonly preflight: (request: PreflightRequest) => Promise<SourcePreflight>;
  /** The existing runner, as one ordinary function. */
  readonly run: (request: SourceRunRequest) => Promise<RunTaskResult>;
  readonly now: () => Date;
  /** An abortable wait; resolves early when the stop request arrives. */
  readonly sleep: (ms: number, stop: AbortSignal) => Promise<void>;
}

/** What one completion pass did, as a batch summary counts it. */
export interface CompletionRunSummary {
  readonly done: number;
  readonly toDo: number;
  readonly attention: number;
  readonly observed: number;
  /** Why the completion pass itself could not run; `null` when it did. */
  readonly problem: string | null;
}

/**
 * One completion pass, as the coordinator runs it: a bounded scan that reports
 * what it did. It is a function of the coordinator's own contract so the
 * coordinator never imports a connector, a repository, or a credential.
 */
export interface CompletionRun {
  run(stop: AbortSignal): Promise<CompletionRunSummary>;
}

/** What a read-only preview needs: no runner, no lock, no directories. */
export interface SourcePreview {
  readonly source: TaskSource;
  readonly workDir: string;
  readonly stop: AbortSignal;
}

/** How one batch ended. */
export type SourceOutcome =
  /** The batch was processed to its end. */
  | 'completed'
  /** Intake stopped: a fatal, uncertain, or unconfirmed condition needs a human. */
  | 'stopped'
  /** The caller stopped it. */
  | 'cancelled';

/** What one batch did, for the caller to print and to turn into an exit code. */
export interface SourceSummary {
  readonly outcome: SourceOutcome;
  /** Fresh reservations taken: what a `--limit` counts. */
  readonly attempted: number;
  readonly passed: number;
  readonly failed: number;
  readonly cancelled: number;
  /** Issues skipped because their description is not a usable task. */
  readonly invalid: number;
  /**
   * Issues the harness would not act on and said so: a pointer that is not a
   * workspace id, resolves nowhere here, or names another item's, site's, or
   * repository's workspace; two pointers; or an attempted issue with nothing
   * saying what to continue (docs/implement-workspace-continuation.md).
   */
  readonly refused: number;
  /** Issues skipped because a receipt existed or they were no longer eligible. */
  readonly skipped: number;
  /** Why intake stopped, when it did; `null` for a batch that ran to its end. */
  readonly problem: string | null;
  /**
   * Whether everything this batch started was confirmed stopped. `false` means
   * the working copies may still be written to: the caller leaves the intake
   * lock for manual inspection instead of releasing it (docs/spec.md §6).
   */
  readonly cleanupConfirmed: boolean;
  /** What the review-to-completion pass did after this batch; `null` when it is off. */
  readonly completion: CompletionRunSummary | null;
}

/**
 * The one ticket a queue consumer step took: the external identity the serial
 * queue loop follows it by, and the title it prints.
 */
export interface QueueTicket {
  readonly ref: SourceRef;
  readonly title: string;
}

/** How one taken ticket's coding attempt ended, as the queue loop reports it. */
export interface SourceTakeRun {
  readonly status: RunStatus;
  readonly runId: string;
  readonly reportPath: string;
  readonly reason: string;
  /**
   * The pull request this attempt's work was delivered as; `null` when delivery
   * is off, the attempt did not pass, or a passed attempt committed nothing to
   * deliver.
   */
  readonly pullRequest: DeliveredPullRequest | null;
  /**
   * Set when the attempt ended before any coding turn — a completed red
   * baseline on a fresh workspace — and the pre-delivery diagnosis published
   * its finding and returned the item to its ready status. The serial queue
   * continues this same ticket instead of stopping for a person
   * (docs/WORKFLOW.md §11).
   */
  readonly returnedForBaselineRepair?: { readonly detail: string };
}

/**
 * What one `queue` consumer step did: a fresh eligibility scan that takes at
 * most one ticket and carries it through the coding attempt and its delivery.
 *
 * `taken` is the only outcome that names a ticket, and its run says how the
 * attempt ended. `empty` means the scan found no ticket that could be taken at
 * all. `attention` is everything a person has to decide — a refusal this step
 * published, an item whose description is not a usable task, an attempt that
 * failed or could not be confirmed stopped, a ledger that could not be written,
 * or a delivery failure — and the serial queue loop stops on it instead of
 * skipping the ticket for another one. `cancelled` is the caller's interrupt.
 */
export interface SourceTake {
  readonly outcome: 'taken' | 'empty' | 'attention' | 'cancelled';
  readonly ticket: QueueTicket | null;
  readonly run: SourceTakeRun | null;
  /** Tickets the scan skipped because they were no longer eligible. */
  readonly skipped: number;
  /** Why a person is needed, when the step stopped for one; `null` otherwise. */
  readonly problem: string | null;
  /** Whether everything this step started is confirmed stopped. */
  readonly cleanupConfirmed: boolean;
}
