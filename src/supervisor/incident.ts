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
 * Two things the record keeps are what make a supervisor restart safe. An
 * attempt is written down as `pending` before its turn is ever launched, so a
 * replacement invocation sees that a turn is in flight, reconciles that
 * process and any judgment it left behind, and counts the interrupted attempt
 * toward the bound instead of starting the same work twice. And a concluded
 * incident carries the {@link ResumePlan} it still owes the queue, so a blocker
 * ranked ahead of the interrupted work really runs first and the resumption is
 * recorded only when the interrupted work is really started again.
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
   * How the worker's ending was seen, which an exit code and a signal alone
   * cannot say: a worker that never started a process and a worker whose ending
   * no invocation ever observed both carry neither. `unobserved` is the ending
   * a restart finds when it reads a launch whose worker is gone and no incident
   * recorded its stop — the queue was interrupted, not completed.
   */
  readonly ending: 'exited' | 'signalled' | 'launch-failed' | 'unobserved';
  /**
   * The launch the worker was started under, when it was a supervised launch.
   * It is what ties a stop to the launch it observed, so a restart can tell
   * "this ending was recorded" from "this launch ended unobserved".
   */
  readonly launch: string | null;
  /**
   * The failure's identity, for "the same failure again": the intent, the
   * scope, and the exit code or signal. Nothing about timing or a path takes
   * part, so an identical stop compares equal across restarts.
   */
  readonly signature: string;
}

/** What one recovery turn concluded. */
export type RecoveryDisposition = 'repaired' | 'blocked' | 'unrecoverable';

/**
 * Where one stop came from: the incident whose resumed work the worker that
 * stopped was carrying out, and whether that work left any new run evidence
 * behind before it ended. A fresh worker the operator asked for carries out
 * nobody's plan, and an incident opened for its stop has no origin.
 *
 * This is the durable half of "the same failure again". A failure that ends a
 * worker which was already resuming, without the queue having done anything at
 * all in between, is a repetition whichever exit code it wears — and a chain of
 * them, each of which a recovery turn really investigated, is what ends in an
 * actionable request for human help rather than an unbounded series of turns.
 */
export interface StopOrigin {
  /** The incident whose resumed work the stopped worker was carrying out. */
  readonly incident: string | null;
  /** Whether the queue left new run evidence behind before it stopped. */
  readonly progress: boolean;
}

/**
 * One recovery turn this supervisor started and has not finished recording.
 *
 * The attempt is written down before the turn is launched and cleared only
 * once its result is recorded, so a restart can see that a turn was in flight.
 * `supervisorPid` is the invocation that launched it; `turnPid` is the runtime
 * process itself, once it was started, because that process — not the
 * supervisor — is what may still be repairing a workspace. A `turnPid` that was
 * never recorded is not a turn that produced nothing: the runtime is handed its
 * prompt only once it is recorded, so nothing of that attempt ever ran, and
 * nothing about it can be reconciled — which is exactly why a restart refuses
 * it instead of starting another turn beside a process it cannot name.
 */
export interface PendingRecovery {
  /** Counted from 1 within one incident. */
  readonly attempt: number;
  readonly startedAt: string;
  readonly supervisorPid: number | null;
  readonly turnPid: number | null;
  /** The turn's own working directory under the incident's. */
  readonly dir: string;
  /** The turn's own log, once it was opened. */
  readonly logPath: string | null;
  /**
   * Why this attempt was left in flight, when the invocation that spent it
   * learned something a restart has to read: a runtime it could not confirm
   * stopped, chiefly. `null` for an attempt an invocation simply died inside of.
   */
  readonly problem: string | null;
  /**
   * The stop that invocation asked of the attempt's runtime and could not
   * confirm, or `null` when the attempt is in flight for another reason.
   *
   * It is the evidence a restart decides on, and it is kept structured rather
   * than only as prose: the runtime's recorded tree is what has to be shown
   * ended — a missing root PID is not that proof — before the attempt's
   * judgment is adopted or anything else starts beside it.
   */
  readonly unconfirmedStop: UnconfirmedStop | null;
}

/** One stop of an attempt's runtime that could not be confirmed. */
export interface UnconfirmedStop {
  /** When the stop was recorded as unconfirmed. */
  readonly at: string;
  /** The tree's recorded root, or `null` when none could be recorded. */
  readonly pid: number | null;
  /** What could not be confirmed, as the invocation that stopped it saw it. */
  readonly problem: string;
}

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

/**
 * What one concluded incident still owes the queue.
 *
 * A `repaired` conclusion resumes the very work the stop interrupted. A
 * `blocked` conclusion ranks another ticket ahead of it, and both steps are
 * carried here so they are executed rather than promised: the blocker runs
 * first — as its own scoped worker, whatever intent this incident began with —
 * and only then does the interrupted work run again.
 *
 * The plan advances on a confirmed result, never on a start: a blocker that was
 * started but never observed to settle is a step the queue still owes, and a
 * restart carries it out again rather than skipping it. `blockerSettledAt` is
 * that confirmed result, and `resumedAt` on the incident is the same evidence
 * for the interrupted work.
 */
export interface ResumePlan {
  /** The interrupted work, as the worker runs it again. */
  readonly intent: SupervisorIntent;
  readonly scope: string | null;
  /** The ticket ranked ahead of it, when the judgment named one. */
  readonly blocker: { readonly key: string; readonly reason: string } | null;
  /** When the blocker's own worker really started, or `null` while it has not. */
  readonly blockerStartedAt: string | null;
  /**
   * When the blocker's own worker was seen to settle — its confirmed result —
   * or `null` while the plan has not got one. Only this advances the plan to
   * the interrupted work: a start whose worker never settled, a crash included,
   * leaves the blocker owed and it runs again.
   */
  readonly blockerSettledAt: string | null;
}

/** The conclusion one recorded publication describes. */
export interface PublishedConclusion {
  readonly outcome: 'repaired' | 'blocked' | 'help';
  readonly at: string;
}

/**
 * One publication state an incident's report superseded: what was published for
 * a conclusion the incident has since replaced, kept so the history still shows
 * it.
 *
 * An incident concludes once and keeps one report; a conclusion that changes
 * afterwards — a blocker whose own ticket never reached the status that resumes
 * the interrupted work, chiefly — is published on its own, in Jira and by email,
 * and what the earlier conclusion published is recorded here as what it was.
 */
export interface SupersededReport {
  /** The conclusion the superseded publications described, when one is known. */
  readonly conclusion: PublishedConclusion | null;
  readonly commentId: string | null;
  readonly notification: IncidentReport['notification'];
  readonly problem: string | null;
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
   * The conclusion this publication state describes, or `null` while nothing
   * has been written down for one.
   *
   * A report is written from the incident's conclusion and its own text says
   * which one it is, so a state that does not describe the conclusion the
   * incident now holds is not that conclusion's publication: the conclusion it
   * does not describe is published on its own, and the earlier one is kept as a
   * superseded publication rather than taken for the new one's.
   */
  readonly conclusion: PublishedConclusion | null;
  /** The publication states this one superseded, oldest first. */
  readonly superseded: readonly SupersededReport[];
  /**
   * The email summary, and how far its publication got. `pending` is written
   * down before the publisher runs and is never assumed either way: a restart
   * reconciles it against the publisher's own output. `sent` and `interrupted`
   * are terminal for this incident — an acknowledged summary is never published
   * again, and one whose acknowledgement was never found is never repeated
   * automatically either, because a duplicate email is worse than an
   * unconfirmed one. Only a `failed` publication is retried, and retrying it
   * never repeats the recovery that came before it.
   */
  readonly notification: {
    readonly topicArn: string;
    readonly email: string;
    readonly state: 'pending' | 'sent' | 'failed' | 'interrupted';
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
  /**
   * A person's acknowledgement of the request for human help this incident
   * ended in — or of the unconfirmed process-tree stop it held — or `null`
   * while nothing has been answered by hand.
   *
   * A `help` conclusion stops the supervision, and a restart is not an answer
   * to it: the incident keeps the queue stopped until a person says the thing it
   * asked for was really done. That acknowledgement is this field, written into
   * the record by hand — `{ "at": …, "note": … }` — because nothing here may
   * infer that a person acted. It answers the thing it is newer than and
   * nothing else: a hold or a request that was recorded after an acknowledgement
   * is not resolved by it, so one person's answer to one hold never lets a
   * restart start work beside a later request. It is `null` for every incident
   * that neither held on a process nor asked for help.
   */
  acknowledgement: { readonly at: string; readonly note: string | null } | null;
  /** Every worker stop this incident observed, oldest first. */
  readonly stops: WorkerStop[];
  /**
   * The work the stopped worker was carrying out, when it was carrying out an
   * incident's plan rather than the operator's own request.
   */
  origin: StopOrigin | null;
  /** Every recovery attempt this incident spent, oldest first. */
  readonly attempts: RecoveryAttempt[];
  /**
   * The attempt a supervisor started and has not finished recording, or `null`.
   * A restart reconciles it before it would ever spend another attempt.
   */
  pending: PendingRecovery | null;
  /**
   * What the queue still owes this incident after its conclusion, or `null`
   * while the incident is open or a person still has to act.
   */
  sequence: ResumePlan | null;
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

/**
 * One worker ending, as every reader of the record words it: the report the
 * incident publishes, the complete history it keeps, and the recovery prompt
 * that answers it. An ending that was never observed is said so there rather
 * than dressed as an exit code, and a worker that never started a process is
 * not reported as one that ran.
 */
export function describeWorkerStop(stop: WorkerStop): string {
  if (stop.ending === 'unobserved') {
    return (
      'without an observed ending: the invocation that started it stopped while it was still ' +
      'running, so nothing here knows what it did'
    );
  }
  if (stop.ending === 'launch-failed') {
    return (
      'without ever starting: the process could not be launched, so it produced no work and no ' +
      'exit of its own'
    );
  }
  return stop.signal === null
    ? `with exit code ${String(stop.exitCode)}`
    : `on signal ${stop.signal}`;
}

/** The directory one connected project's supervision state lives under. */
export function supervisorRoot(workDir: string, namespace: string): string {
  return path.join(workDir, '.supervisor', namespace);
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
    acknowledgement: null,
    stops: [],
    origin: null,
    attempts: [],
    pending: null,
    sequence: null,
    ticket: scope === null ? null : { key: scope, url: null },
    report: {
      publishedAt: null,
      commentId: null,
      commentText: null,
      conclusion: null,
      superseded: [],
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
 * One attempt's unconfirmed stop, as it was written down, or `null`. A record
 * written before the field existed has none: an attempt left in flight by such
 * an invocation carries only its own prose, and the restart still refuses it
 * for a person to reconcile.
 */
function unconfirmedStopOf(value: unknown): UnconfirmedStop | null {
  if (!isRecord(value) || typeof value['at'] !== 'string') {
    return null;
  }
  return {
    at: value['at'],
    pid: typeof value['pid'] === 'number' && Number.isInteger(value['pid']) ? value['pid'] : null,
    problem:
      typeof value['problem'] === 'string' ? value['problem'] : 'no reason was recorded for it',
  };
}

/** The conclusion one recorded publication state describes, or `null`. */
export function publishedConclusionOf(value: unknown): PublishedConclusion | null {
  if (!isRecord(value)) {
    return null;
  }
  const outcome = value['outcome'];
  const at = value['at'];
  if (
    (outcome !== 'repaired' && outcome !== 'blocked' && outcome !== 'help') ||
    typeof at !== 'string'
  ) {
    return null;
  }
  return { outcome, at };
}

/**
 * The superseded publications one report carries, as they were written down. A
 * record written before the field existed carries none — it never concluded
 * twice — and an entry this harness did not write is dropped rather than
 * guessed at.
 */
function supersededReportsOf(value: unknown): readonly SupersededReport[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: SupersededReport[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const notification = entry['notification'];
    kept.push({
      conclusion: publishedConclusionOf(entry['conclusion']),
      commentId: typeof entry['commentId'] === 'string' ? entry['commentId'] : null,
      notification: isRecord(notification)
        ? (notification as unknown as IncidentReport['notification'])
        : null,
      problem: typeof entry['problem'] === 'string' ? entry['problem'] : null,
    });
  }
  return kept;
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
  const record = value as unknown as IncidentRecord;
  // A record written before these fields existed is one with nothing in
  // flight and nothing owed: reading it as such keeps a restart's decisions
  // explicit rather than leaving `undefined` to spread through them.
  const pending = isRecord(value['pending']) ? (record.pending as PendingRecovery) : null;
  const sequence = isRecord(value['sequence']) ? (record.sequence as ResumePlan) : null;
  const acknowledgement = value['acknowledgement'];
  const conclusion = isRecord(value['conclusion'])
    ? (record.conclusion as IncidentConclusion)
    : null;
  const report = isRecord(value['report']) ? (record.report as IncidentReport) : record.report;
  return {
    ...record,
    conclusion,
    report: {
      ...report,
      commentText: typeof report.commentText === 'string' ? report.commentText : null,
      // A record written before this was kept described whatever conclusion it
      // held with the publication it recorded: reading it as such keeps that
      // publication from being made a second time.
      conclusion:
        publishedConclusionOf(report.conclusion) ??
        publishedConclusionOf(value['conclusion']) ??
        null,
      superseded: supersededReportsOf(report.superseded),
    },
    acknowledgement:
      isRecord(acknowledgement) && typeof acknowledgement['at'] === 'string'
        ? {
            at: acknowledgement['at'],
            note: typeof acknowledgement['note'] === 'string' ? acknowledgement['note'] : null,
          }
        : null,
    origin: isRecord(value['origin']) ? record.origin : null,
    // A stop written before these fields existed keeps the wording it always
    // had: an exit code says the worker exited, a signal says it was signalled,
    // and neither is read as an ending nobody observed.
    stops: record.stops.map((stop) => ({
      ...stop,
      ending:
        stop.ending === 'exited' ||
        stop.ending === 'signalled' ||
        stop.ending === 'launch-failed' ||
        stop.ending === 'unobserved'
          ? stop.ending
          : stop.signal === null
            ? ('exited' as const)
            : ('signalled' as const),
      launch: typeof stop.launch === 'string' ? stop.launch : null,
    })),
    pending:
      pending === null
        ? null
        : {
            ...pending,
            problem: typeof pending.problem === 'string' ? pending.problem : null,
            unconfirmedStop: unconfirmedStopOf(pending.unconfirmedStop),
          },
    sequence:
      sequence === null
        ? null
        : {
            ...sequence,
            blockerSettledAt:
              typeof sequence.blockerSettledAt === 'string' ? sequence.blockerSettledAt : null,
          },
  };
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
 *
 * The pointer is also the launch record of the worker that is being started:
 * the launch's own token is written before the child exists — with no PID yet —
 * and the PID is added once the child does. The child does not begin any work
 * until the record names it (`supervisor/launch.ts`), so a pointer that names a
 * launch and no PID is a launch whose child never did anything and whose
 * process cannot be reconciled: a restart refuses it rather than starting a
 * second worker beside it.
 *
 * The launch is kept until there is something durable to clear it: the worker's
 * own ending, written down here by the invocation that watched it, and then the
 * incident that ending owes — or the resumption the queue really owes — rather
 * than the other way round. Clearing the launch first would let an invocation
 * that stops in between erase the only record that a worker was ever
 * interrupted.
 */
export interface CurrentIncident {
  readonly version: 1;
  /** The incident being handled, or `null` while a fresh worker runs. */
  readonly id: string | null;
  readonly workerPid: number | null;
  /**
   * The launch in flight, or `null` when no worker is being started or run.
   * The token identifies one launch across its two writes; a restart reads it
   * back to tell "a worker is being started and cannot be reconciled" from
   * "no worker is running".
   *
   * It also carries the work the launch was started for, so a restart that
   * finds a worker gone without any incident recording its ending knows what
   * that worker was doing — the operator's own request, or the step of an
   * incident's plan — and opens the incident that ending deserves.
   */
  readonly launch: {
    readonly token: string;
    readonly at: string;
    /** The intent the worker ran under, or `null` for a pointer written before this was kept. */
    readonly intent: SupervisorIntent | null;
    /** The ticket that intent was scoped to, or `null`. */
    readonly scope: string | null;
  } | null;
  /**
   * The ending of the launch above, once the invocation that watched it wrote
   * it down, or `null` while the worker has not ended — or while nothing wrote
   * its ending down at all.
   *
   * The launch is the only record of a worker that is running right now, so it
   * is not cleared before the ending is durable: an invocation that stopped
   * between a worker's ending and the incident that ending may owe would
   * otherwise leave a restart with neither, and an interruption nothing
   * investigates. What the ending was is therefore kept here, in the words of
   * the invocation that watched it, until the record it owes (or the queue's
   * own resumption) makes it superfluous.
   */
  readonly ending: RecordedEnding | null;
}

/**
 * One ending of the launch a pointer registered, as the invocation that watched
 * it wrote it down: everything a restart needs to decide about that worker
 * exactly as the invocation itself would have decided.
 */
export interface RecordedEnding {
  /** The launch this ending belongs to. An ending of another launch is stale. */
  readonly launch: string;
  readonly at: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** How the worker ended, as the invocation that watched it saw it. */
  readonly ending: 'exited' | 'signalled' | 'launch-failed';
  /** Whether the operator had asked for this stop when the worker ended. */
  readonly stopRequested: boolean;
  /**
   * Whether the queue left new run evidence behind between the launch and this
   * ending, as the invocation that watched it computed it.
   */
  readonly progress: boolean;
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
  if (!isRecord(value) || (typeof value['id'] !== 'string' && value['id'] !== null)) {
    throw new Error(
      `the supervisor's current-incident pointer under "${root}" names no incident and no ` +
        'absence. Inspect it by hand.',
    );
  }
  const workerPid = value['workerPid'];
  const launch = value['launch'];
  return {
    version: 1,
    id: typeof value['id'] === 'string' ? value['id'] : null,
    workerPid: typeof workerPid === 'number' && Number.isInteger(workerPid) ? workerPid : null,
    ending: recordedEndingOf(value['ending']),
    launch:
      isRecord(launch) && typeof launch['token'] === 'string' && typeof launch['at'] === 'string'
        ? {
            token: launch['token'],
            at: launch['at'],
            intent:
              launch['intent'] === 'run' ||
              launch['intent'] === 'watch' ||
              launch['intent'] === 'ticket'
                ? launch['intent']
                : null,
            scope: typeof launch['scope'] === 'string' ? launch['scope'] : null,
          }
        : null,
  };
}

/**
 * One recorded ending, as it was written down, or `null`. A pointer written
 * before endings were kept, and one whose worker has not ended, both carry
 * none — and a record that is not an ending of a known shape is read as none
 * too, so a restart never decides from half of one.
 */
function recordedEndingOf(value: unknown): RecordedEnding | null {
  if (!isRecord(value)) {
    return null;
  }
  const ending = value['ending'];
  if (
    typeof value['launch'] !== 'string' ||
    typeof value['at'] !== 'string' ||
    (ending !== 'exited' && ending !== 'signalled' && ending !== 'launch-failed')
  ) {
    return null;
  }
  const exitCode = value['exitCode'];
  return {
    launch: value['launch'],
    at: value['at'],
    exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : null,
    signal: typeof value['signal'] === 'string' ? value['signal'] : null,
    ending,
    stopRequested: value['stopRequested'] === true,
    progress: value['progress'] === true,
  };
}

/**
 * Whether a resumed worker stopped again with the very failure the recovery it
 * followed reported repaired. That is the one repetition the supervisor does
 * not spend another recovery on — it ends in an actionable request for human
 * help instead, and the earlier ending is what it names (docs/WORKFLOW.md §12).
 *
 * The judgment is deliberately conservative, because "the same failure again"
 * is not something an exit code can say. A nonzero exit is conventional: an
 * unscoped `run` or `watch` failure could be a different ticket entirely, and
 * even a different failure on the very same ticket leaves the same ending
 * behind. So the repetition is only read as unchanged when all of it holds:
 *
 * - the incident before it concluded `repaired` or `blocked`, so the queue was
 *   really returned to work by a recovery;
 * - the interrupted work that recovery resumed is exactly the work that
 *   stopped again — same intent, same ticket — and the ticket is one this
 *   supervisor can name, which an unscoped worker cannot;
 * - the worker that stopped again left no new run evidence behind, so nothing
 *   progressed between the recovery and the repeated stop;
 * - the ending itself is the same one (same exit code, or the same signal).
 *
 * Anything else is a fresh incident: only a recovery turn's own investigation
 * can say what an unscoped failure was about, and spending one investigation
 * is the conservative answer there.
 */
export function unchangedAfterRecovery(
  previous: IncidentRecord,
  evidence: {
    readonly intent: SupervisorIntent;
    readonly scope: string | null;
    readonly exitCode: number | null;
    readonly signal: string | null;
    /** Whether the worker that stopped again left any new run evidence behind. */
    readonly progress: boolean;
  },
): boolean {
  const attempt = previous.attempts.at(-1);
  const stop = previous.stops.at(-1);
  if (previous.conclusion === null || previous.conclusion.outcome === 'help') {
    return false;
  }
  if (attempt === undefined || (attempt.outcome !== 'repaired' && attempt.outcome !== 'blocked')) {
    return false;
  }
  if (stop === undefined || evidence.progress) {
    return false;
  }
  // The ticket has to be one this supervisor can name: an unscoped failure is
  // the ending alone, and the ending alone cannot tell two tickets apart.
  const ticket = evidence.scope;
  if (ticket === null || previous.ticket?.key !== ticket || stop.scope !== ticket) {
    return false;
  }
  // The work that stopped again must be the work that recovery resumed.
  const plan = previous.sequence;
  if (plan === null || plan.intent !== evidence.intent || plan.scope !== evidence.scope) {
    return false;
  }
  return stop.exitCode === evidence.exitCode && stop.signal === evidence.signal;
}
