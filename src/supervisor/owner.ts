/**
 * Who owns one supervised queue, and what an activation must be sure of first.
 *
 * Two facts decide whether a `supervise` invocation may start a worker at all:
 *
 * - the supervisor's own owner record, so a restart of the supervisor adopts
 *   the state it left instead of starting a second worker beside a live one —
 *   a live owner is refused by name, and a record whose process is gone is
 *   taken over with a fresh token, which is what makes a plain restart safe;
 * - the connected project's intake lock, so activating the supervisor over an
 *   existing raw `queue` consumer is refused while that consumer is really
 *   running. Nothing here breaks a lock: the queue's own exclusivity rules are
 *   untouched, and an owner that is gone leaves the harness's own recovery
 *   judgment to the incident (docs/WORKFLOW.md §12).
 *
 * The owner record is the lock itself, and it is never written by replace: the
 * file is created exclusively, so exactly one invocation can hold it, and
 * "read an absent record, then rename one over it" can never let two starts
 * both believe they own the queue. A record whose process is gone is taken
 * over by renaming it away first — an atomic step only one contender can win —
 * and then creating the record exclusively again, so two simultaneous
 * takeovers still leave exactly one owner.
 */
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import { intakeLockPath } from '../sources/receipts.js';
import { ownerFilePath } from './incident.js';

/** The record one supervisor invocation holds under its project's root. */
export interface OwnerRecord {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
  readonly intent: string;
  readonly repoPath: string;
}

/** Whether one recorded process is still running, as this host reports it. */
export type LivenessProbe = (pid: number) => boolean;

/** The host's own answer: a process that exists is alive unless nothing holds it. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists and belongs to someone else; ESRCH is the
    // only answer that says it is gone.
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the owner record; an unreadable one is refused, never ignored. */
async function readOwner(file: string): Promise<OwnerRecord | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `the supervisor's owner record "${file}" could not be read: ${messageOf(cause)}`,
      { cause },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `the supervisor's owner record "${file}" is not valid JSON (${messageOf(cause)}). Inspect ` +
        'it by hand before starting another supervisor.',
      { cause },
    );
  }
  if (!isRecord(value) || typeof value['pid'] !== 'number' || typeof value['token'] !== 'string') {
    throw new Error(
      `the supervisor's owner record "${file}" names no owning process, so this invocation will ` +
        'not take it over. Inspect it by hand.',
    );
  }
  return value as unknown as OwnerRecord;
}

/** The supervisor's own lock, which only its holder removes. */
export interface SupervisorOwnership {
  readonly root: string;
  readonly file: string;
  /** Removes the record only while this invocation still owns it. */
  release(): Promise<void>;
}

export type OwnershipTake =
  | { readonly ok: true; readonly ownership: SupervisorOwnership }
  | { readonly ok: false; readonly problem: string };

/** How many takeover races one acquisition loses before it gives up. */
const MAX_TAKEOVER_ROUNDS = 8;

/**
 * Takes the supervisor's own owner record: refused while a live supervisor
 * holds it, adopted when the recorded process is gone. Acquisition is the
 * exclusive creation of the record itself, so two starts can never both take
 * it: whichever creates the file owns the queue, and the other reads the
 * record it finds — a live owner, refused by name — instead of overwriting it.
 * The adopted record names its own invocation, so a person reading it can see
 * which one holds the queue now.
 */
export async function acquireSupervisorOwnership(request: {
  readonly root: string;
  readonly intent: string;
  readonly repoPath: string;
  readonly now: () => Date;
  readonly isAlive?: LivenessProbe;
}): Promise<OwnershipTake> {
  const { root, intent, repoPath, now } = request;
  const isAlive = request.isAlive ?? processIsAlive;
  const file = ownerFilePath(root);
  await mkdir(root, { recursive: true });

  for (let round = 0; round < MAX_TAKEOVER_ROUNDS; round += 1) {
    const token = randomUUID();
    const record: OwnerRecord = {
      version: 1,
      pid: process.pid,
      token,
      startedAt: now().toISOString(),
      intent,
      repoPath,
    };
    // The exclusive create is the lock: the creation itself decides, so two
    // invocations reading the same absent record cannot both become the owner.
    try {
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
        return {
          ok: false,
          problem: `the supervisor's owner record "${file}" could not be written: ${messageOf(cause)}`,
        };
      }
      let existing: OwnerRecord | null;
      try {
        existing = await readOwner(file);
      } catch (cause0) {
        return { ok: false, problem: messageOf(cause0) };
      }
      // A live owner is refused whether or not it is this process: a second
      // invocation in one process is a second supervisor like any other.
      if (existing !== null && isAlive(existing.pid)) {
        return {
          ok: false,
          problem:
            `another supervisor already runs this connected project (pid ${String(existing.pid)}, ` +
            `started ${existing.startedAt}, record "${file}"). Only one supervisor may run a ` +
            'worker for one project and workDir at a time. Stop that supervisor, or let it ' +
            'finish, before starting another; a live owner is never taken over.',
        };
      }
      // The recorded process is gone. The stale record is renamed away first —
      // an atomic step exactly one contender wins — so the next round's
      // exclusive create decides between simultaneous takeovers.
      const stale = path.join(root, `owner.json.stale-${randomUUID()}`);
      try {
        await rename(file, stale);
      } catch (cause0) {
        if ((cause0 as NodeJS.ErrnoException).code === 'ENOENT') {
          // Another contender took the stale record first: read what it left.
          continue;
        }
        return {
          ok: false,
          problem:
            `the supervisor's owner record "${file}" could not be taken over after its process ` +
            `was gone: ${messageOf(cause0)}. Inspect it by hand.`,
        };
      }
      await rm(stale, { force: true }).catch(() => undefined);
      continue;
    }

    return {
      ok: true,
      ownership: {
        root,
        file,
        release: async () => {
          const recorded = await readOwner(file).catch(() => null);
          if (recorded === null || recorded.token !== token) {
            // Not this invocation's record any more: it is left in place for a
            // person rather than removed from under whoever holds it.
            return;
          }
          await rm(file, { force: true });
        },
      },
    };
  }

  return {
    ok: false,
    problem:
      `the supervisor's owner record "${file}" could not be acquired: ${String(MAX_TAKEOVER_ROUNDS)} ` +
      'attempts lost the takeover to another invocation. Only one supervisor runs one queue; ' +
      'inspect the record by hand before trying again.',
  };
}

/**
 * The activation check in front of one worker: a raw queue consumer that is
 * really running holds the connected project's intake lock, and starting a
 * supervised worker beside it would be a second consumer of one queue. The
 * lock is read, never touched: a live owner is refused by name, and an owner
 * that is gone is left exactly as it was for the recovery incident to explain.
 */
export async function intakeConsumerProblem(request: {
  readonly workDir: string;
  readonly namespace: string;
  readonly isAlive?: LivenessProbe;
}): Promise<string | null> {
  const isAlive = request.isAlive ?? processIsAlive;
  const lock = intakeLockPath(request.workDir, request.namespace);
  let recorded: unknown;
  try {
    recorded = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // The lock directory exists but its owner record could not be read: that is
    // exactly the state the queue refuses to break automatically, and this
    // activation will not guess either.
    return (
      `"${lock}" exists and its owner record could not be read (${messageOf(cause)}), so this ` +
      'invocation will not start a supervised worker beside it. Inspect the lock by hand; a lock ' +
      'is never broken automatically.'
    );
  }
  const pid = isRecord(recorded) && typeof recorded['pid'] === 'number' ? recorded['pid'] : null;
  if (pid === null || pid === process.pid || !isAlive(pid)) {
    // No live consumer: the lock is a leftover this invocation leaves to the
    // recovery incident, which is what investigates a stop that was never
    // confirmed. Nothing deletes it here.
    return null;
  }
  return (
    `a raw queue consumer already holds this connected project's intake lock "${lock}" ` +
    `(pid ${String(pid)}). Stop that consumer before activating the supervisor, so one queue ` +
    'has one worker; neither this invocation nor the recovery path takes a live lock over.'
  );
}
