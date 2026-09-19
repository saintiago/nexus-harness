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
import type { EscalationTier, RunStatus, SourceRef, Task } from '../shared/types.js';
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
}

/**
 * The local outcome of one run, projected for publication: the facts a result
 * comment states, and no transcript, environment, or diff.
 */
export interface SourceRunOutcome {
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
   * Which attempt of how many this run was, and the tier that ran it: present
   * when more than one attempt is possible, so the published result says so
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
 * - `complete` publishes a bounded summary and moves the item to review. It
 *   throws {@link SourceFeedbackError} when delivery fails.
 */
export interface TaskSource {
  listEligible(stop: AbortSignal): Promise<readonly SourceCandidate[]>;
  prepare(candidate: SourceCandidate, stop: AbortSignal): Promise<SourceTask | null>;
  claim(item: SourceTask, stop: AbortSignal): Promise<boolean>;
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
   * Called once, after a fresh workspace exists and before any coding turn: where
   * the work lives, so the source can record it on the item it came from.
   */
  readonly onWorkspaceReady?: (workspace: { readonly workspaceId: string }) => Promise<void>;
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
   * The escalation ladder, at least one rung: attempt N of a workspace runs
   * rung N, clamped to the last. `escalationTiers(config)` is how the CLI reads
   * it (docs/implement-workspace-continuation.md).
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
  /** The existing source/output preflight, re-run before each reservation. */
  readonly preflight: (request: PreflightRequest) => Promise<SourcePreflight>;
  /** The existing runner, as one ordinary function. */
  readonly run: (request: SourceRunRequest) => Promise<RunTaskResult>;
  readonly now: () => Date;
  /** An abortable wait; resolves early when the stop request arrives. */
  readonly sleep: (ms: number, stop: AbortSignal) => Promise<void>;
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
}
