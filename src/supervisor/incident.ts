/**
 * One supervised incident: what stopped the worker, what the recovery agent
 * concluded about it, and whether its report was published.
 *
 * The record is the supervisor's only state, and it is deliberately small: it
 * holds the observed stop evidence (never the worker's stream, which stays in
 * the run directories the worker itself wrote), one entry per recovery attempt
 * with the agent's own outcome file behind it, and the publication identities
 * of the concise report. Everything else — the ticket's status, the workspace
 * pointer, the receipts — stays where it already lives, and the recovery agent
 * reads it there (docs/WORKFLOW.md §12).
 *
 * A record is written atomically through a same-directory temporary file, so a
 * reader never sees half of one, and a record that no longer parses is refused
 * rather than replaced: a corrupt incident is exactly the state a restart must
 * not round into "nothing happened".
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';

/** Which supervision an invocation was asked for (docs/WORKFLOW.md §12). */
export type SupervisorIntent = 'run' | 'watch' | 'ticket';

/** One worker invocation's observed ending. */
export interface WorkerStop {
  /** When the worker was confirmed ended. */
  readonly at: string;
  /** The intent the supervisor ran the worker with. */
  readonly intent: SupervisorIntent;
  /** The ticket a scoped intent named, or `null`. */
  readonly scope: string | null;
  /** The worker's exit code, or `null` when a signal ended it. */
  readonly exitCode: number | null;
  /** The signal that ended the worker, or `null` when it exited. */
  readonly signal: string | null;
  /**
   * The failure's identity, for "the same failure again": the intent, the
   * scope, and the exit code or signal. Nothing about timing or a path takes
   * part, so an identical stop compares equal across restarts.
   */
  readonly signature: string;
}

/** What one recovery turn concluded. */
export type RecoveryDisposition = 'repaired' | 'blocked' | 'unrecoverable';

/** One recovery attempt, as the agent's own outcome file describes it. */
export interface RecoveryAttempt {
  /** Counted from 1 within one incident. */
  readonly attempt: number;
  readonly startedAt: string;
  readonly endedAt: string;
  /** The agent's disposition, or `failed` when the turn produced none. */
  readonly outcome: RecoveryDisposition | 'failed';
  /** One short paragraph for the report: what happened and what it did. */
  readonly summary: string | null;
  /** What it found to be the cause. */
  readonly cause: string | null;
  /** What it repaired or reconciled. */
  readonly resolution: string | null;
  /** The committed and uncommitted work it preserved. */
  readonly preserved: readonly string[];
  /** The work that resumes after this incident, when it named one. */
  readonly resume: string | null;
  /** A blocker it ranked ahead of the interrupted task, when it named one. */
  readonly blocker: { readonly key: string; readonly reason: string } | null;
  /** What a person must do, when it could not repair the situation. */
  readonly help: string | null;
  /** Why the turn produced no disposition, when it produced none. */
  readonly problem: string | null;
  /** The turn's own working directory under the incident's. */
  readonly dir: string | null;
  /** The turn's own log, when one was opened. */
  readonly logPath: string | null;
}

/** Where one incident's concise report was published. */
export interface IncidentReport {
  /** When the Jira report was acknowledged; `null` until it was. */
  readonly publishedAt: string | null;
  /** The comment's immutable Jira id, as the answer acknowledged it. */
  readonly commentId: string | null;
  /** The exact text published, so a restart can see what was said. */
  readonly commentText: string | null;
  /**
   * The email summary. `state` says whether it was sent, is still pending, or
   * failed; a failed or pending notification is the only thing a restart
   * retries, because a successful recovery is never repeated to send it.
   */
  readonly notification: {
    readonly topicArn: string;
    readonly email: string;
    readonly state: 'pending' | 'sent' | 'failed';
    readonly messageId: string | null;
    readonly problem: string | null;
  } | null;
  /** What a person must fix about the report itself, when anything. */
  readonly problem: string | null;
}

/** How the incident ended, when it has ended. */
export interface IncidentConclusion {
  readonly outcome: 'repaired' | 'blocked' | 'help';
  readonly detail: string;
  readonly at: string;
}

/** The complete state of one supervised incident. */
export interface IncidentRecord {
  readonly version: 1;
  /** A fresh identity, so two episodes are never one record. */
  readonly id: string;
  /** The connected project's stable lock namespace, as the queue derives it. */
  readonly namespace: string;
  readonly intent: SupervisorIntent;
  readonly scope: string | null;
  /** The recovery bound this incident runs under, as configured. */
  readonly maxAttempts: number;
  readonly createdAt: string;
  updatedAt: string;
  /**
   * When the queue really resumed after this incident's recovery, or `null`
   * while it has not. A blocker ranked ahead of the interrupted work keeps this
   * `null` until the interrupted work is started again, which is how the
   * subsequent resumption is recorded rather than assumed.
   */
  resumedAt: string | null;
  /** `open` while it is being handled; `settled` or `help` once concluded. */
  stage: 'open' | 'settled' | 'help';
  /** Every worker stop this incident observed, oldest first. */
  readonly stops: WorkerStop[];
  /** Every recovery attempt this incident spent, oldest first. */
  readonly attempts: RecoveryAttempt[];
  /** The ticket the report names, when one is known. */
  ticket: { readonly key: string; readonly url: string | null } | null;
  report: IncidentReport;
  conclusion: IncidentConclusion | null;
}

/** The failure's identity: the same stop again compares equal. */
export function stopSignature(
  intent: SupervisorIntent,
  scope: string | null,
  exitCode: number | null,
  signal: string | null,
): string {
  const ended = signal === null ? `exit:${String(exitCode ?? 'unknown')}` : `signal:${signal}`;
  return createHash('sha256')
    .update(JSON.stringify([intent, scope ?? '', ended]), 'utf8')
    .digest('hex');
}

/** The directory one connected project's supervision state lives under. */
export function supervisorRoot(workDir: string, namespace: string): string {
  return path.join(workDir, '.supervisor', namespace);
}

/** The owner record one supervisor invocation holds while it runs. */
export function ownerFilePath(root: string): string {
  return path.join(root, 'owner.json');
}

/** The pointer at the incident this supervisor is handling. */
export function currentIncidentPath(root: string): string {
  return path.join(root, 'current.json');
}

/** One incident's own directory. */
export function incidentDir(root: string, id: string): string {
  return path.join(root, 'incidents', id);
}

/** One incident's record. */
export function incidentFilePath(root: string, id: string): string {
  return path.join(incidentDir(root, id), 'incident.json');
}

/** A fresh incident for one unexpected stop. */
export function openIncident(
  namespace: string,
  intent: SupervisorIntent,
  scope: string | null,
  maxAttempts: number,
  now: () => Date,
): IncidentRecord {
  const at = now().toISOString();
  return {
    version: 1,
    id: `${at.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    namespace,
    intent,
    scope,
    maxAttempts,
    createdAt: at,
    updatedAt: at,
    resumedAt: null,
    stage: 'open',
    stops: [],
    attempts: [],
    ticket: scope === null ? null : { key: scope, url: null },
    report: {
      publishedAt: null,
      commentId: null,
      commentText: null,
      notification: null,
      problem: null,
    },
    conclusion: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one incident record. A missing file is an absence; a file that is not
 * a record this harness wrote is a refusal by name, never an absence: treating
 * corruption as "no incident" is how a restart starts a second recovery for
 * work that may still be running.
 */
export async function readIncident(file: string): Promise<IncidentRecord | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`the incident record "${file}" could not be read: ${messageOf(cause)}`, {
      cause,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `the incident record "${file}" is not valid JSON (${messageOf(cause)}), so this harness ` +
        'cannot tell what the incident already spent. Inspect it by hand; do not delete it to ' +
        'make the supervisor start again.',
      { cause },
    );
  }
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    typeof value['id'] !== 'string' ||
    !Array.isArray(value['stops']) ||
    !Array.isArray(value['attempts']) ||
    !isRecord(value['report'])
  ) {
    throw new Error(
      `the incident record "${file}" is not a record this harness wrote (expected version 1 ` +
        'with stops, attempts and a report). Inspect it by hand.',
    );
  }
  return value as unknown as IncidentRecord;
}

/** Writes one incident record atomically, so a reader never sees half of one. */
export async function writeIncident(file: string, incident: IncidentRecord): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `incident.json.tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(incident, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw new Error(`the incident record "${file}" could not be written: ${messageOf(cause)}`, {
      cause,
    });
  }
}

/**
 * The pointer the supervisor keeps while it works: the incident it is handling,
 * and the worker it started for it. The worker's PID is what makes a restart
 * able to tell that a worker is still running rather than start a second one.
 */
export interface CurrentIncident {
  readonly version: 1;
  readonly id: string;
  readonly workerPid: number | null;
}

/** Points the supervisor at the incident it is handling; `null` clears it. */
export async function writeCurrentIncident(
  root: string,
  value: CurrentIncident | null,
): Promise<void> {
  const file = currentIncidentPath(root);
  await mkdir(root, { recursive: true });
  if (value === null) {
    await rm(file, { force: true });
    return;
  }
  const temporary = `${file}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

/** The pointer the supervisor was holding, or `null` when it held none. */
export async function readCurrentIncident(root: string): Promise<CurrentIncident | null> {
  let text: string;
  try {
    text = await readFile(currentIncidentPath(root), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `the supervisor's current-incident pointer under "${root}" could not be read: ${messageOf(cause)}`,
      { cause },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `the supervisor's current-incident pointer under "${root}" is not valid JSON ` +
        `(${messageOf(cause)}). Inspect it by hand.`,
      { cause },
    );
  }
  if (!isRecord(value) || typeof value['id'] !== 'string') {
    throw new Error(
      `the supervisor's current-incident pointer under "${root}" names no incident. Inspect it ` +
        'by hand.',
    );
  }
  const workerPid = value['workerPid'];
  return {
    version: 1,
    id: value['id'],
    workerPid: typeof workerPid === 'number' && Number.isInteger(workerPid) ? workerPid : null,
  };
}

/**
 * Whether the newest stop is the same failure the last recovery attempt
 * answered, unchanged: the attempt claimed a repair, and the worker stopped
 * again with the identical signature. That is the one repetition the supervisor
 * does not spend another attempt on — it ends in an actionable request for
 * human help instead (docs/WORKFLOW.md §12).
 */
export function unchangedFailure(incident: IncidentRecord): boolean {
  if (incident.stops.length < 2 || incident.attempts.length === 0) {
    return false;
  }
  const last = incident.stops.at(-1);
  const previous = incident.stops.at(-2);
  const attempt = incident.attempts.at(-1);
  if (last === undefined || previous === undefined || attempt === undefined) {
    return false;
  }
  if (attempt.outcome !== 'repaired' && attempt.outcome !== 'blocked') {
    return false;
  }
  return last.signature === previous.signature;
}
