/**
 * The task-input boundary: what a source is, and the one serial coordinator that
 * takes work from one.
 *
 * A source does four things and nothing else (see {@link TaskSource}): it lists
 * the external items that are eligible, prepares one of them as the existing
 * four-field `Task`, claims it, and publishes the local result. Everything else
 * here is ordinary coordination code around the unchanged runner:
 *
 * ```text
 * discover (all pages) â†’ per item: receipt? â†’ prepare â†’ reserve â†’ claim
 *                                            â†’ existing runTask â†’ publish
 * ```

 * The coordinator knows ordinary data and functions. It imports no connector, no
 * JQL, no ADF, and no credential, and the runner never sees any of them: a
 * second source is a concrete adapter plus configuration and CLI wiring, not a
 * change to the task, the loop, or this module.
 *
 * ## What it guarantees, and what it does not
 *
 * - One finite, ordered, de-duplicated batch is discovered before any external
 *   status changes, and items are handled one at a time, strictly sequentially.
 * - A local receipt, keyed by the external item's immutable identity, is created
 *   exclusively before any remote mutation or agent work, so the same item is
 *   not attempted twice by this consumer â€” across repeated scans, a restart, a
 *   reopened issue, or an edited description.
 * - A claim that was rejected before any mutation request was sent releases only
 *   the receipt this process just created. After a mutation was attempted, an
 *   error or an uncertain answer keeps the receipt and stops intake for a human.
 * - Local results are kept whatever the remote feedback does, and a delivery
 *   failure is recorded as such: it never turns into another coding attempt.
 *
 * It does not promise exactly-once execution, and it is not a distributed lock:
 * Jira status transitions are not a lease, and consumers using different output
 * directories or machines are unsupported (docs/spec.md Â§6).
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunCancelledError } from './runner.js';
import type { RunTaskResult } from './runner.js';
import type { AttemptEvidence, RunStatus, SourceRef, Task } from './types.js';
import type { PreflightRequest, SourcePreflight } from './workspace.js';

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
 * it failed (docs/spec.md Â§6, "Jira feedback and completion").
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
  /** The item's title as the source lists it; a preview, not the task. */
  readonly title: string;
}

/** One external item, prepared as exactly the existing `Task`. */
export interface SourceTask {
  readonly ref: SourceRef;
  readonly task: Task;
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
}

/**
 * A concrete task source. Four ordinary async functions:
 *
 * - `listEligible` consumes every page and returns a finite, ordered,
 *   de-duplicated batch. A cursor is not part of the contract.
 * - `prepare` re-reads the item, tests eligibility again, maps and validates the
 *   four-field task, and returns `null` for an item that no longer qualifies. An
 *   item that is real but unusable throws a {@link SourceError} of kind
 *   `invalid-task`.
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
  /** The target repository every fetched task is bound to. */
  readonly repoPath: string;
  readonly io: SourceIo;
  /** The intake's own stop request: the caller's interrupt. */
  readonly stop: AbortSignal;
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
  /** Issues skipped because a receipt existed or they were no longer eligible. */
  readonly skipped: number;
  /** Why intake stopped, when it did; `null` for a batch that ran to its end. */
  readonly problem: string | null;
  /**
   * Whether everything this batch started was confirmed stopped. `false` means
   * the working copies may still be written to: the caller leaves the intake
   * lock for manual inspection instead of releasing it (docs/spec.md Â§6).
   */
  readonly cleanupConfirmed: boolean;
}

/** The stored form of one attempted external item. */
export interface SourceReceipt {
  readonly version: 1;
  readonly source: SourceRef;
  readonly reservedAt: string;
  readonly runId?: string;
  readonly resultPath?: string;
  readonly outcome?: RunStatus;
  readonly feedback?: 'pending' | 'sent' | 'failed';
  readonly commentId?: string;
  readonly problem?: string;
}

/** The directory holding the exclusive consumer lock, under `workDir`. */
export function intakeLockPath(workDir: string): string {
  return path.join(workDir, '.intake', 'lock');
}

/** The directory holding the per-item receipts, under `workDir`. */
export function intakeReceiptsDir(workDir: string): string {
  return path.join(workDir, '.intake', 'receipts');
}

/**
 * The receipt identity: a hash of the connector type, the canonical site, and
 * the immutable external ID.
 *
 * Nothing mutable takes part in it â€” not the issue key, the summary, the status,
 * or the update timestamp â€” so renaming, relabelling, or reopening an external
 * item can never make it look like new work (docs/architecture.md Â§8).
 */
export function receiptIdentity(ref: SourceRef): string {
  return createHash('sha256')
    .update(JSON.stringify([ref.type, ref.scope, ref.id]), 'utf8')
    .digest('hex');
}

/** The receipt file for one external item: `<workDir>/.intake/receipts/<hash>.json`. */
export function receiptFilePath(workDir: string, ref: SourceRef): string {
  return path.join(intakeReceiptsDir(workDir), `${receiptIdentity(ref)}.json`);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one receipt. A missing file is an absence (`null`); a file that is not a
 * receipt this harness wrote is an error, never an absence: treating corruption
 * as "not attempted yet" is exactly how an issue gets run twice
 * (docs/spec.md Â§6).
 */
export async function readReceipt(file: string): Promise<SourceReceipt | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new SourceError('fatal', `the receipt "${file}" could not be read: ${messageOf(cause)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SourceError(
      'fatal',
      `the receipt "${file}" is not valid JSON, so this harness cannot tell whether the item ` +
        'was already attempted. Inspect it by hand; do not delete it to make the item run again.',
    );
  }
  if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['source'])) {
    throw new SourceError(
      'fatal',
      `the receipt "${file}" is not a receipt this harness wrote (expected version 1 with a ` +
        'source reference). Inspect it by hand; do not treat it as absence.',
    );
  }
  const source = value['source'];
  for (const field of ['type', 'scope', 'id', 'key', 'url', 'updatedAt']) {
    if (typeof source[field] !== 'string') {
      throw new SourceError(
        'fatal',
        `the receipt "${file}" records no "${field}", so it cannot be trusted as evidence of an ` +
          'attempt. Inspect it by hand.',
      );
    }
  }
  return value as unknown as SourceReceipt;
}

/**
 * Creates a receipt exclusively. `false` means another reservation already
 * exists â€” this process's own earlier attempt, a crashed one, or another
 * consumer using the same output directory â€” and the item is not attempted.
 */
export async function reserveReceipt(file: string, receipt: SourceReceipt): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx',
      encoding: 'utf8',
    });
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw new SourceError(
      'fatal',
      `the receipt "${file}" could not be created: ${messageOf(cause)}`,
    );
  }
}

/**
 * Replaces a receipt atomically, through a same-directory temporary file, so a
 * reader never sees half of one. The merge is read-modify-write on a file this
 * process created, and a receipt that no longer parses is refused rather than
 * overwritten.
 */
export async function updateReceipt(
  file: string,
  changes: Partial<Omit<SourceReceipt, 'version' | 'source' | 'reservedAt'>>,
): Promise<SourceReceipt> {
  const current = await readReceipt(file);
  if (current === null) {
    throw new SourceError('fatal', `the receipt "${file}" disappeared while it was being updated`);
  }
  const updated: SourceReceipt = { ...current, ...changes };
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw new SourceError(
      'fatal',
      `the receipt "${file}" could not be updated: ${messageOf(cause)}`,
    );
  }
  return updated;
}

/** The exclusive intake lock one consumer holds while it takes work. */
export interface IntakeLock {
  readonly dir: string;
  /** Removes only this process's own lock; refuses anything it does not own. */
  release(): Promise<void>;
}

/**
 * Takes the exclusive per-`workDir` lock by creating its directory. It is taken
 * after the source/output preflight and before discovery intended for execution,
 * and it is never broken automatically: an existing lock is reported with its
 * owner's recorded details so a human can look at it (docs/spec.md Â§6).
 */
export async function acquireIntakeLock(workDir: string, now: () => Date): Promise<IntakeLock> {
  const dir = intakeLockPath(workDir);
  const token = randomUUID();
  await mkdir(path.dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SourceError(
        'fatal',
        `another intake consumer holds "${dir}". Only one consumer may use this output directory ` +
          'at a time. Inspect that lock and stop its owner before removing it by hand; a lock is ' +
          'never broken automatically.',
      );
    }
    throw new SourceError(
      'fatal',
      `the intake lock "${dir}" could not be created: ${messageOf(cause)}`,
    );
  }

  const owner = path.join(dir, 'owner.json');
  try {
    await writeFile(
      owner,
      `${JSON.stringify(
        { version: 1, pid: process.pid, startedAt: now().toISOString(), token },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (cause) {
    throw new SourceError(
      'fatal',
      `the intake lock "${dir}" could not record its owner, so intake will not run under it: ${messageOf(cause)}`,
    );
  }

  return {
    dir,
    release: async () => {
      let recorded: unknown;
      try {
        recorded = JSON.parse(await readFile(owner, 'utf8'));
      } catch (cause) {
        throw new SourceError(
          'fatal',
          `the intake lock "${dir}" could not be read back (${messageOf(cause)}), so this ` +
            'process will not remove it. Inspect it by hand.',
        );
      }
      if (!isRecord(recorded) || recorded['token'] !== token) {
        throw new SourceError(
          'fatal',
          `the intake lock "${dir}" is no longer this process's lock, so it was left in place. ` +
            'Inspect it by hand.',
        );
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** What a source command needs to know about how one run ended. */
function runOutcome(result: RunTaskResult): SourceRunOutcome {
  return {
    runId: result.run.runId,
    status: result.status,
    reason: result.reason,
    repairsUsed: result.repairsUsed,
    checks: checkSummary(result),
    runDir: result.run.runDir,
    reportPath: result.reportPath,
  };
}

/**
 * One line about the checks that decided a run, or that none were observed.
 *
 * A stopped run's last turn carries no round: it was stopped before any check
 * could run after it. Falling back to the baseline there describes the round the
 * run started with as if it were the one that decided it — a live run over HARN-1
 * (`run-20260916225121-f3d4a6e4`) reported `round: passed` for a run whose
 * post-agent round was red, because the stopped repair turn had no checks to
 * report — so this line names the last round that really ran, and says that
 * nothing ran after the turn that was stopped.
 */
function checkSummary(result: RunTaskResult): string {
  const lastTurn = result.attempts.at(-1);
  const observed =
    [...result.attempts].reverse().find((attempt) => attempt.checks !== null)?.checks ??
    result.baseline;
  const line =
    observed === null
      ? 'no check round was completed for this run'
      : `${String(
          observed.checks.filter((entry) => entry.outcome === 'exited' && entry.exitCode === 0)
            .length,
        )} of ${String(observed.checks.length)} configured checks exited 0 (round: ${observed.outcome})`;
  if (lastTurn === undefined || lastTurn.checks !== null) {
    return line;
  }
  return `${line}; no check round was observed after ${nameTurn(lastTurn)}`;
}

/** How the feedback names one top-level coding turn, as the run's reasons name it. */
function nameTurn(attempt: AttemptEvidence): string {
  return attempt.kind === 'implementation'
    ? 'the implementation turn'
    : `repair turn ${String(attempt.turn)}`;
}

/** The receipt as a one-line summary for the terminal. */
function describeReceipt(receipt: SourceReceipt): string {
  const parts: string[] = [];
  parts.push(
    receipt.outcome === undefined ? 'reserved, no run recorded' : `run ${receipt.outcome}`,
  );
  if (receipt.runId !== undefined) {
    parts.push(receipt.runId);
  }
  if (receipt.feedback !== undefined) {
    parts.push(`feedback ${receipt.feedback}`);
  }
  if (receipt.problem !== undefined) {
    parts.push(receipt.problem);
  }
  return parts.join('; ');
}

/**
 * Reports a repeated per-issue diagnostic at most once, until what it says
 * changes. A watch loop re-scans the whole eligible queue, so an issue that is
 * still unusable would otherwise repeat the same line on every scan
 * (docs/spec.md §6).
 */
function reportOnce(
  diagnostics: Map<string, string> | null,
  key: string,
  marker: string,
  write: () => void,
): void {
  if (diagnostics === null) {
    write();
    return;
  }
  if (diagnostics.get(key) === marker) {
    return;
  }
  diagnostics.set(key, marker);
  write();
}

/** One entry of a read-only preview. */
export interface SourceListEntry {
  readonly disposition: 'valid' | 'attempted' | 'invalid' | 'stale';
  readonly ref: SourceRef;
  readonly title: string;
  /** The receipt path, the receipt's known result, or why the item was refused. */
  readonly detail: string;
}

/**
 * The read-only preview: eligible items, their disposition, and nothing else. It
 * reads existing receipts, but it does not create a directory, take a lock,
 * claim anything, or start a run, so an item it shows as valid is still waiting
 * (docs/WORKFLOW.md Â§7).
 */
export async function listSource(preview: SourcePreview): Promise<readonly SourceListEntry[]> {
  const candidates = await preview.source.listEligible(preview.stop);
  const entries: SourceListEntry[] = [];

  for (const candidate of candidates) {
    const file = receiptFilePath(preview.workDir, candidate.ref);
    const receipt = await readReceipt(file);
    if (receipt !== null) {
      entries.push({
        disposition: 'attempted',
        ref: candidate.ref,
        title: candidate.title,
        detail: `${describeReceipt(receipt)} (${file})`,
      });
      continue;
    }

    try {
      const prepared = await preview.source.prepare(candidate, preview.stop);
      entries.push(
        prepared === null
          ? {
              disposition: 'stale',
              ref: candidate.ref,
              title: candidate.title,
              detail: 'no longer eligible at the time of the preview',
            }
          : {
              disposition: 'valid',
              ref: prepared.ref,
              title: prepared.task.title,
              detail: 'valid and unattempted',
            },
      );
    } catch (cause) {
      if (cause instanceof SourceError && cause.kind === 'invalid-task') {
        entries.push({
          disposition: 'invalid',
          ref: candidate.ref,
          title: candidate.title,
          detail: cause.message,
        });
        continue;
      }
      throw cause;
    }
  }

  return entries;
}

interface BatchState {
  attempted: number;
  passed: number;
  failed: number;
  cancelled: number;
  invalid: number;
  skipped: number;
  problem: string | null;
  cleanupConfirmed: boolean;
}

function emptyState(): BatchState {
  return {
    attempted: 0,
    passed: 0,
    failed: 0,
    cancelled: 0,
    invalid: 0,
    skipped: 0,
    problem: null,
    cleanupConfirmed: true,
  };
}

function summarize(outcome: SourceOutcome, state: BatchState): SourceSummary {
  return {
    outcome,
    attempted: state.attempted,
    passed: state.passed,
    failed: state.failed,
    cancelled: state.cancelled,
    invalid: state.invalid,
    skipped: state.skipped,
    problem: state.problem,
    cleanupConfirmed: state.cleanupConfirmed,
  };
}

/** Stops intake with a problem a human has to look at. */
function stopWith(state: BatchState, problem: string, confirmed = true): 'stop' {
  state.problem = problem;
  state.cleanupConfirmed = state.cleanupConfirmed && confirmed;
  return 'stop';
}

/** What handling one candidate did, and whether the batch should go on. */
type Step = 'next' | 'stop' | 'cancelled';

/**
 * One item, through the documented reservation sequence: receipt first,
 * eligibility and revision rechecked, an unambiguous claim, the unchanged
 * runner, the real local result, and then remote feedback.
 */
async function attempt(
  context: SourceContext,
  candidate: SourceCandidate,
  state: BatchState,
  diagnostics: Map<string, string> | null,
): Promise<Step> {
  const { source, workDir, io, stop, now } = context;
  const file = receiptFilePath(workDir, candidate.ref);
  const identity = receiptIdentity(candidate.ref);

  const existing = await readReceipt(file);
  if (existing !== null) {
    state.skipped += 1;
    reportOnce(
      diagnostics,
      identity,
      `attempted:${existing.source.updatedAt}:${describeReceipt(existing)}`,
      () => {
        io.out(`${candidate.ref.key}: already attempted, so it was not run again (${file})`);
        io.out(`${candidate.ref.key}: ${describeReceipt(existing)}`);
      },
    );
    return 'next';
  }

  if (stop.aborted) {
    return 'cancelled';
  }

  // The source checkout is rechecked before the reservation, not after it: a
  // checkout that cannot be used must not leave a receipt on an issue the
  // harness would not have been allowed to run.
  try {
    await context.preflight({ repoPath: context.repoPath, workDir });
  } catch (cause) {
    return stopWith(
      state,
      `${candidate.ref.key}: the source checkout was refused before the issue was reserved: ${messageOf(cause)}`,
    );
  }

  let prepared: SourceTask | null;
  try {
    prepared = await source.prepare(candidate, stop);
  } catch (cause) {
    if (cause instanceof SourceError && cause.kind === 'invalid-task') {
      state.invalid += 1;
      // Suppressed until what the source reports about the issue changes: an
      // edited issue is diagnosed again (docs/spec.md §6).
      reportOnce(
        diagnostics,
        identity,
        `invalid:${candidate.ref.updatedAt}:${cause.message}`,
        () => {
          io.err(
            `${candidate.ref.key} (${candidate.title}): skipped, not a usable task: ${cause.message}`,
          );
        },
      );
      return 'next';
    }
    if (stop.aborted) {
      return 'cancelled';
    }
    throw cause;
  }

  if (prepared === null) {
    state.skipped += 1;
    reportOnce(diagnostics, identity, `stale:${candidate.ref.updatedAt}`, () => {
      io.out(`${candidate.ref.key}: no longer eligible, so it was skipped without a claim`);
    });
    return 'next';
  }

  const receipt: SourceReceipt = {
    version: 1,
    source: prepared.ref,
    reservedAt: now().toISOString(),
  };
  if (!(await reserveReceipt(file, receipt))) {
    state.skipped += 1;
    io.out(
      `${candidate.ref.key}: another reservation already existed, so it was not attempted (${file})`,
    );
    return 'next';
  }
  state.attempted += 1;
  io.out(`${prepared.ref.key}: reserved (${file}); claiming ${prepared.ref.id}`);

  let claimed: boolean;
  try {
    claimed = await source.claim(prepared, stop);
  } catch (cause) {
    const problem = messageOf(cause);
    await updateReceipt(file, { problem: `claim: ${problem}` });
    return stopWith(
      state,
      `${prepared.ref.key}: the claim did not complete, so its receipt is kept and intake stops for ` +
        `inspection: ${problem}`,
    );
  }
  if (!claimed) {
    // No mutation request was sent, so only this process's own new reservation
    // is released; the issue is skipped and a later scan may try again.
    await rm(file, { force: true });
    state.skipped += 1;
    io.out(
      `${prepared.ref.key}: no longer eligible or its revision changed before any claim was sent, ` +
        'so the reservation was released',
    );
    return 'next';
  }

  let result: RunTaskResult;
  try {
    result = await context.run({ task: prepared.task, sourceRef: prepared.ref, stop });
  } catch (cause) {
    const problem = messageOf(cause);
    await updateReceipt(file, { problem: `run: ${problem}` });
    if (cause instanceof RunCancelledError) {
      return 'cancelled';
    }
    return stopWith(
      state,
      `${prepared.ref.key}: the run ending this attempt produced no local result, so its receipt is ` +
        `kept and intake stops for inspection: ${problem}`,
    );
  }

  await updateReceipt(file, {
    runId: result.run.runId,
    resultPath: result.reportPath,
    outcome: result.status,
    feedback: 'pending',
  });
  if (result.status === 'passed') {
    state.passed += 1;
  } else if (result.status === 'cancelled') {
    state.cancelled += 1;
  } else {
    state.failed += 1;
  }
  io.out(
    `run ${result.run.runId}: ${result.status} for ${prepared.ref.key} (${result.reason}), ` +
      `report ${result.reportPath}`,
  );

  const outcome = runOutcome(result);
  // Whether the run's own execution was confirmed stopped: an expired limit and
  // a stop by the caller both record it, and only `confirmed` lets the next
  // issue run. A handled failed run may be followed by the next issue, but only
  // while the harness knows nothing of the run's own is still running
  // (docs/spec.md §6).
  const stopEvidence = result.timeout ?? result.cancellation;
  const stoppedCleanly = stopEvidence === null || stopEvidence.termination === 'confirmed';
  if (!stoppedCleanly) {
    // Something the run started may still be writing. A result is not published
    // from that position, the next issue is not taken, and the lock is left for
    // a human to inspect.
    await updateReceipt(file, {
      feedback: 'pending',
      problem:
        `feedback: not attempted, because the run's termination was not confirmed (` +
        `${stopEvidence.problem ?? 'no reason was recorded'})`,
    });
    state.cleanupConfirmed = false;
    io.err(
      `${prepared.ref.key}: the run was stopped without a confirmed termination, so no result was ` +
        'posted and the intake lock is kept for inspection',
    );
    return result.status === 'cancelled'
      ? 'cancelled'
      : stopWith(
          state,
          `${prepared.ref.key}: the run ended without confirming that everything it started had ` +
            'stopped, so intake stops and the lock is kept for inspection',
        );
  }

  // A run the caller stopped still gets one bounded, best-effort feedback
  // sequence of its own, so the issue does not sit in the running status.
  const feedbackStop =
    result.status === 'cancelled' ? AbortSignal.timeout(FEEDBACK_DEADLINE_MS) : stop;
  try {
    await source.complete(prepared, outcome, feedbackStop);
    await updateReceipt(file, { feedback: 'sent' });
    io.out(`${prepared.ref.key}: result published and moved to review`);
  } catch (cause) {
    const failure =
      cause instanceof SourceFeedbackError
        ? { problem: cause.message, commentId: cause.commentId }
        : { problem: messageOf(cause), commentId: null };
    await updateReceipt(file, {
      feedback: 'failed',
      problem: `feedback: ${failure.problem}`,
      ...(failure.commentId === null ? {} : { commentId: failure.commentId }),
    });
    return stopWith(
      state,
      `${prepared.ref.key}: the local run is kept, but publishing its result failed, so intake ` +
        `stops for inspection: ${failure.problem}`,
    );
  }

  return result.status === 'cancelled' ? 'cancelled' : 'next';
}

/** The longest a best-effort feedback sequence may take after an interrupt. */
export const FEEDBACK_DEADLINE_MS = 10_000;

/**
 * One finite batch: every candidate, in the order the source returned them, one
 * at a time. It stops early only for the conditions the specification names:
 * an unconfirmed stop, an uncertain claim, a local persistence failure, or a
 * failed publication.
 */
async function processBatch(
  context: SourceContext,
  candidates: readonly SourceCandidate[],
  limit: number | null,
  state: BatchState,
  seenDiagnostics: Map<string, string> | null,
): Promise<Step> {
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (context.stop.aborted) {
      return 'cancelled';
    }
    const identity = receiptIdentity(candidate.ref);
    if (seen.has(identity)) {
      // The source contract asks for a de-duplicated batch; a source that
      // returns the same immutable ID twice must still not run it twice.
      continue;
    }
    seen.add(identity);
    if (limit !== null && state.attempted >= limit) {
      context.io.out(
        `limit of ${String(limit)} new attempt(s) reached; the rest of the batch was left for the next scan`,
      );
      return 'next';
    }

    const step = await attempt(context, candidate, state, seenDiagnostics);
    if (step !== 'next') {
      return step;
    }
  }
  return 'next';
}

/**
 * `source run`: one finite discovered batch, processed sequentially, with an
 * optional bound on fresh attempts.
 */
export async function runSource(
  context: SourceContext,
  limit: number | null,
): Promise<SourceSummary> {
  const state = emptyState();
  // The existing source/output preflight runs before any intake state exists: a
  // refused source checkout must leave no lock, no receipt, and no directory
  // (docs/architecture.md §8).
  try {
    await context.preflight({ repoPath: context.repoPath, workDir: context.workDir });
  } catch (cause) {
    return summarize('stopped', {
      ...state,
      problem: `the source checkout was refused: ${messageOf(cause)}`,
    });
  }

  const lock = await acquireIntakeLock(context.workDir, context.now);
  try {
    let candidates: readonly SourceCandidate[];
    try {
      candidates = await context.source.listEligible(context.stop);
    } catch (cause) {
      if (context.stop.aborted) {
        return summarize('cancelled', state);
      }
      return summarize('stopped', { ...state, problem: `discovery failed: ${messageOf(cause)}` });
    }

    const step = await processBatch(context, candidates, limit, state, null);
    if (step === 'cancelled') {
      return summarize('cancelled', state);
    }
    return summarize(step === 'stop' ? 'stopped' : 'completed', state);
  } finally {
    if (state.cleanupConfirmed) {
      await lock.release();
    } else {
      context.io.err(`the intake lock was left in place for inspection: ${lock.dir}`);
    }
  }
}

/** The first backoff after a failed scan, in milliseconds. */
export const WATCH_BACKOFF_BASE_MS = 5_000;

/** The backoff cap, applied before any longer server-directed wait. */
export const WATCH_BACKOFF_CAP_MS = 5 * 60_000;

export interface SourceWatchOptions extends SourceContext {
  readonly pollIntervalMs: number;
}

/**
 * `source watch`: scan immediately, process that finite batch, wait, and repeat
 * until the caller stops it. New work waits in the source until the next scan,
 * and a scan never overlaps a batch: detection latency includes the active run
 * (docs/spec.md Â§6).
 *
 * Only read failures are retried, after an abortable wait that respects a
 * server-directed minimum. Authentication, authorization, malformed answers,
 * uncertain writes, and failed publication stop the loop instead.
 */
export async function watchSource(options: SourceWatchOptions): Promise<SourceSummary> {
  const { io, stop, sleep, pollIntervalMs } = options;
  const state = emptyState();
  const seenDiagnostics = new Map<string, string>();
  let backoffMs = WATCH_BACKOFF_BASE_MS;

  // As in a finite run, the preflight comes first: a refused source checkout
  // leaves no intake state behind.
  try {
    await options.preflight({ repoPath: options.repoPath, workDir: options.workDir });
  } catch (cause) {
    return summarize('stopped', {
      ...state,
      problem: `the source checkout was refused: ${messageOf(cause)}`,
    });
  }

  const lock = await acquireIntakeLock(options.workDir, options.now);
  try {
    for (;;) {
      if (stop.aborted) {
        return summarize('cancelled', state);
      }

      let candidates: readonly SourceCandidate[];
      try {
        candidates = await options.source.listEligible(stop);
        backoffMs = WATCH_BACKOFF_BASE_MS;
      } catch (cause) {
        if (stop.aborted) {
          return summarize('cancelled', state);
        }
        if (cause instanceof SourceError && cause.kind === 'retryable-read') {
          const delay = Math.max(backoffMs, cause.retryAfterMs ?? 0);
          io.err(`scan failed (${cause.message}); retrying in ${String(delay)} ms`);
          backoffMs = Math.min(WATCH_BACKOFF_CAP_MS, backoffMs * 2);
          await sleep(delay, stop);
          continue;
        }
        return summarize('stopped', { ...state, problem: `discovery failed: ${messageOf(cause)}` });
      }

      if (candidates.length === 0) {
        io.out('scan: no eligible issues');
      }

      // A read that failed before anything was reserved (an issue read during
      // prepare) may be retried with the same backoff as discovery: nothing was
      // claimed and no receipt exists. Once a receipt does exist, the failure is
      // reported by `attempt` as the stop it is, and never retried here.
      let step: Step;
      try {
        step = await processBatch(options, candidates, null, state, seenDiagnostics);
      } catch (cause) {
        if (stop.aborted) {
          return summarize('cancelled', state);
        }
        if (cause instanceof SourceError && cause.kind === 'retryable-read') {
          const delay = Math.max(backoffMs, cause.retryAfterMs ?? 0);
          io.err(`scan failed (${cause.message}); retrying in ${String(delay)} ms`);
          backoffMs = Math.min(WATCH_BACKOFF_CAP_MS, backoffMs * 2);
          await sleep(delay, stop);
          continue;
        }
        return summarize('stopped', { ...state, problem: `intake failed: ${messageOf(cause)}` });
      }
      if (step === 'cancelled') {
        return summarize('cancelled', state);
      }
      if (step === 'stop') {
        return summarize('stopped', state);
      }

      io.out(`scan complete; polling again in ${String(pollIntervalMs)} ms`);
      await sleep(pollIntervalMs, stop);
    }
  } finally {
    if (state.cleanupConfirmed) {
      await lock.release();
    } else {
      io.err(`the intake lock was left in place for inspection: ${lock.dir}`);
    }
  }
}
