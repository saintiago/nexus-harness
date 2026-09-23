/**
 * Who owns one supervised queue, and what an activation must be sure of first.
 *
 * Two facts decide whether a `supervise` invocation may start a worker at all:
 *
 * - the supervisor's own claim, so a restart of the supervisor adopts
 *   the state it left instead of starting a second worker beside a live one —
 *   a live claim is refused by name, and a claim whose process is gone is
 *   ignored and cleared away, which is what makes a plain restart safe;
 * - the connected project's intake lock, so activating the supervisor over an
 *   existing raw `queue` consumer is refused while that consumer is really
 *   running. Nothing here breaks a lock: the queue's own exclusivity rules are
 *   untouched, and an owner that is gone leaves the harness's own recovery
 *   judgment to the incident (docs/WORKFLOW.md §12).
 *
 * Ownership is held by a claim: one small file per invocation under the
 * supervision's own root, named by the rank the claim was published under. The
 * rank is the order of publication, and the filesystem decides it: a contender
 * reads the highest rank any claim file carries and creates the next one
 * exclusively, so exactly one invocation can hold a rank, and a claim published
 * later always outranks — never overtakes — every claim already there. Nothing
 * here renames, replaces, or removes a record another invocation may hold: the
 * only claim a contender ever takes away is one whose process is gone, and a
 * live holder's claim is never touched by anyone but its holder.
 *
 * A rank read from the directory is only an order while it stands above every
 * claim really there: a claim that has since been cleared away — its holder
 * released it, or its process was gone and the invocation that won took it
 * away — would otherwise let a contender publish *below* a claim published
 * afterwards, which may already have decided the ownership, and both would own
 * the queue. A claim therefore never decides while one stands above its own:
 * it awaits that claim for a bounded moment — a contender above resolves itself
 * by refusing, a holder keeps its claim and is then refused by name — and the
 * claims whose process is gone are cleared away while it waits, exactly as they
 * are everywhere else.
 *
 * The lowest-ranking live claim owns the queue. A contender that is not that
 * claim refuses by name, and a claim whose process is gone cannot own anything:
 * it is ignored while ownership is decided and cleared away by the invocation
 * that wins, so a crash between publishing and deciding leaves nothing that
 * blocks the next start and nothing that could be read as a second owner.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import { intakeLockPath } from '../sources/receipts.js';

/** The record one supervisor invocation holds under its project's root. */
export interface OwnerRecord {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
  readonly intent: string;
  readonly repoPath: string;
  /** The rank this claim was published under: the order of publication. */
  readonly rank: number;
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

/** The directory one supervision's own claims live in. */
export function holdersDir(root: string): string {
  return path.join(root, 'holders');
}

/** The file one claim lives in, named by the rank it was published under. */
export function holderFilePath(root: string, rank: number): string {
  return path.join(holdersDir(root), `holder-${String(rank).padStart(6, '0')}.json`);
}

/** One claim file's name, and the rank it carries. */
const HOLDER_NAME = /^holder-([0-9]{1,18})\.json$/;

/** How many ranks one acquisition tries before it gives up. */
const MAX_PUBLISH_ATTEMPTS = 8;

/**
 * How long a claim waits for the claims above it to resolve themselves, and how
 * often that wait looks at the directory again.
 *
 * A claim above this one was published after this one's rank was read, and it
 * is either a contender that is still deciding — its own decision sees this
 * claim below it and refuses, which takes a handful of file operations — or a
 * holder that already owns the queue and keeps its claim for its whole run.
 * The bound only has to cover the first kind; what is left after it is decided
 * by the ordinary rules.
 */
const CLAIM_SETTLE_MS = 1_000;
const CLAIM_SETTLE_POLL_MS = 20;

/** The rank a claim file's own name carries, or `null` when it carries none. */
function rankOfName(file: string): number | null {
  const match = HOLDER_NAME.exec(path.basename(file));
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** One claim, as it was read back from its own file. */
interface HeldClaim {
  readonly rank: number;
  readonly file: string;
  readonly record: OwnerRecord;
}

/** One claim file, as reading it went. */
type ClaimRead =
  | { readonly kind: 'held'; readonly record: OwnerRecord }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly problem: string };

/**
 * One claim, as read back from its own file. A claim file that cannot be read
 * as a whole is never treated as an absent claim — another invocation may be
 * publishing exactly that claim right now — and nothing here deletes what it
 * could not read.
 */
async function readClaim(file: string): Promise<ClaimRead> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      // The claim was cleared away between the listing and this read: it is
      // gone, which is not the same as unreadable.
      return { kind: 'absent' };
    }
    // A claim being published, or one being cleared away, is not readable for
    // a moment — on Windows a name whose file is being deleted refuses the
    // open outright. Nothing here guesses at a claim it could not read: the
    // caller decides what it can still own, and nobody deletes what it could
    // not read.
    return { kind: 'unreadable', problem: messageOf(cause) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A claim that is being written is not readable yet.
    return { kind: 'unreadable', problem: 'it is published but holds no record yet' };
  }
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    typeof value['pid'] !== 'number' ||
    typeof value['token'] !== 'string'
  ) {
    return { kind: 'unreadable', problem: 'it is published but is not a claim this harness wrote' };
  }
  return { kind: 'held', record: value as unknown as OwnerRecord };
}

/** Every claim file under one supervision's root, by the rank in its name. */
async function claimFiles(root: string): Promise<readonly { rank: number; file: string }[]> {
  const dir = holdersDir(root);
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(
      `the supervisor's own claims under "${dir}" could not be read: ${messageOf(cause)}`,
      { cause },
    );
  }
  const ranked: { rank: number; file: string }[] = [];
  for (const name of names) {
    const match = HOLDER_NAME.exec(name);
    if (match?.[1] === undefined) {
      continue;
    }
    ranked.push({ rank: Number(match[1]), file: path.join(dir, name) });
  }
  return ranked.sort((left, right) => left.rank - right.rank);
}

/** Every claim the root holds, whole, oldest rank first. */
async function readHeldClaims(root: string): Promise<{
  readonly held: readonly HeldClaim[];
  readonly unreadable: readonly { readonly file: string; readonly problem: string }[];
}> {
  const held: HeldClaim[] = [];
  const unreadable: { file: string; problem: string }[] = [];
  for (const candidate of await claimFiles(root)) {
    const read = await readClaim(candidate.file);
    if (read.kind === 'held') {
      held.push({ rank: candidate.rank, file: candidate.file, record: read.record });
    } else if (read.kind === 'unreadable') {
      unreadable.push({ file: candidate.file, problem: read.problem });
    }
  }
  return { held, unreadable };
}

/** The highest rank any claim file carries, or `0` when none is held. */
async function highestHeldRank(root: string): Promise<number> {
  let highest = 0;
  for (const candidate of await claimFiles(root)) {
    highest = Math.max(highest, candidate.rank);
  }
  return highest;
}

/** The supervisor's own lock, which only its holder removes. */
export interface SupervisorOwnership {
  readonly root: string;
  /** The claim file this invocation holds. */
  readonly file: string;
  /** The rank the claim was published under. */
  readonly rank: number;
  /** The record this invocation published. */
  readonly record: OwnerRecord;
  /** Removes the claim only while this invocation still owns it. */
  release(): Promise<void>;
}

export type OwnershipTake =
  | { readonly ok: true; readonly ownership: SupervisorOwnership }
  | { readonly ok: false; readonly problem: string };

/** Everything one acquisition is asked for. */
export interface OwnershipRequest {
  readonly root: string;
  readonly intent: string;
  readonly repoPath: string;
  readonly now: () => Date;
  readonly isAlive?: LivenessProbe;
  /**
   * Reported with the rank one attempt is about to publish, before the
   * exclusive create. Acquisition itself never passes one: like
   * {@link OwnershipRequest.onClaimPublished} it is the seam that lets a test
   * interleave the schedule ownership is really exposed to — a contender
   * delayed between reading the directory and publishing its claim, chiefly —
   * with no filesystem substitute.
   */
  readonly beforeClaimPublish?: (rank: number) => Promise<void> | void;
  /**
   * Reported once this invocation's own claim is published and before the
   * ownership is decided, with the claim it published. Acquisition itself never
   * passes one: it is the seam that lets a test interleave a second contender
   * with this one — the schedule ownership is really exposed to — and drive
   * that interleaving directly, with no filesystem substitute.
   */
  readonly onClaimPublished?: (claim: {
    readonly rank: number;
    readonly file: string;
    readonly record: OwnerRecord;
  }) => Promise<void> | void;
}

/** Why a live claim refuses a second invocation, by name. */
function liveOwnerProblem(claim: HeldClaim): string {
  return (
    `another supervisor already runs this connected project (pid ${String(claim.record.pid)}, ` +
    `started ${claim.record.startedAt}, claim "${claim.file}"). Only one supervisor may run a ` +
    'worker for one project and workDir at a time. Stop that supervisor, or let it finish, ' +
    'before starting another; a live owner is never taken over.'
  );
}

/**
 * Why a claim that cannot be read refuses the invocation: it outranks this one,
 * and nothing here takes over a claim it could not read. Another invocation may
 * be publishing exactly that claim right now.
 */
function unreadableClaimProblem(file: string, problem: string): string {
  return (
    `another invocation may be acquiring this supervision right now: its claim "${file}" is ` +
    `published and could not be read as a whole (${problem}), so nothing is taken over beside ` +
    'it. Run the supervisor again in a moment; if the claim is still unreadable then, inspect it ' +
    'by hand.'
  );
}

/**
 * Takes the supervisor's own claim: refused while a live claim outranks this
 * invocation's, and owned once nothing live does. Publishing is the exclusive
 * creation of a rank file, so two simultaneous starts can never hold one rank,
 * and a rank is read again before every publication, so a claim published from
 * the directory as it stands is above every claim already there. That is not
 * enough on its own: a rank whose file was cleared away between an earlier
 * listing and this publication can be published *below* a claim published
 * afterwards, which may have decided the ownership before this claim existed.
 * A claim therefore never decides while one stands above it: the claims above
 * are awaited, the ones whose process is gone are cleared away as usual, and
 * what remains after the wait refuses this invocation — because a claim above
 * it was published later than its rank was read, so it may already own the
 * queue. That is what makes "the lowest live claim owns the queue" a decision
 * every contender reaches alike: a claim that decides is never below a claim
 * that may already have decided.
 */
export async function acquireSupervisorOwnership(
  request: OwnershipRequest,
): Promise<OwnershipTake> {
  const { root, intent, repoPath, now } = request;
  const isAlive = request.isAlive ?? processIsAlive;
  await mkdir(holdersDir(root), { recursive: true });

  const token = randomUUID();
  const startedAt = now().toISOString();
  let claim: HeldClaim | null = null;
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS && claim === null; attempt += 1) {
    // The rank is read from the directory as it stands now, on every attempt:
    // a rank worked out from an older listing is not an order of publication,
    // and it can name a file another invocation has since cleared away.
    const rank = (await highestHeldRank(root)) + 1;
    const file = holderFilePath(root, rank);
    const record: OwnerRecord = {
      version: 1,
      pid: process.pid,
      token,
      startedAt,
      intent,
      repoPath,
      rank,
    };
    await request.beforeClaimPublish?.(rank);
    try {
      // The exclusive create is the lock: the creation itself decides the rank,
      // so two invocations that reach for the same rank cannot both hold it.
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        // Another contender published exactly this rank a moment ago: the next
        // attempt reads the directory again and publishes above it.
        continue;
      }
      return {
        ok: false,
        problem: `the supervisor's own claim "${file}" could not be written: ${messageOf(cause)}`,
      };
    }
    const published: HeldClaim = { rank, file, record };
    await request.onClaimPublished?.(published);
    const above = await unresolvedClaimsAbove(root, rank, isAlive);
    const holder = above.held[0];
    if (holder !== undefined) {
      await removeClaim(published);
      return { ok: false, problem: liveOwnerProblem(holder) };
    }
    const unreadable = above.unreadable[0];
    if (unreadable !== undefined) {
      await removeClaim(published);
      return { ok: false, problem: unreadableClaimProblem(unreadable.file, unreadable.problem) };
    }
    claim = published;
  }
  if (claim === null) {
    return {
      ok: false,
      problem:
        `the supervisor's own claim under "${holdersDir(root)}" could not be published: ` +
        `${String(MAX_PUBLISH_ATTEMPTS)} attempts lost the rank to another invocation. Only one ` +
        'supervisor runs one queue; run the supervisor again to take it over.',
    };
  }

  const claims = await readHeldClaims(root);
  const unreadableOutranking = claims.unreadable.filter((candidate) => {
    const rank = rankOfName(candidate.file);
    return rank !== null && rank < claim.rank;
  });
  if (unreadableOutranking.length > 0) {
    await removeClaim(claim);
    const contender = unreadableOutranking[0];
    if (contender === undefined) {
      throw new Error('unreachable: an unreadable claim was picked from an empty list');
    }
    return { ok: false, problem: unreadableClaimProblem(contender.file, contender.problem) };
  }
  const live = claims.held.filter(
    (candidate) => candidate.rank < claim.rank && isAlive(candidate.record.pid),
  );
  const holder = live[0];
  if (holder !== undefined) {
    await removeClaim(claim);
    return { ok: false, problem: liveOwnerProblem(holder) };
  }

  // This invocation owns the queue. Claims whose processes are gone cannot own
  // anything, and they are cleared away now rather than read again on every
  // later start: removing a claim of a process that is gone never takes a
  // record from a live holder, and never drops below the rank a live claim
  // holds, so the next acquisition still publishes above every live one.
  for (const stale of claims.held) {
    if (stale.rank !== claim.rank && !isAlive(stale.record.pid)) {
      await removeStaleClaim(stale);
    }
  }

  return {
    ok: true,
    ownership: {
      root,
      file: claim.file,
      rank: claim.rank,
      record: claim.record,
      release: async () => {
        await removeClaim(claim);
      },
    },
  };
}

/**
 * Clears one claim that was read as one whose process is gone. Only the record
 * this invocation inspected is removed: the claim is read back first, and a
 * record somebody else put under that rank is left where it is, exactly as it
 * is when a takeover refuses a claim it could not read.
 */
async function removeStaleClaim(claim: HeldClaim): Promise<void> {
  const recorded = await readClaim(claim.file);
  if (recorded.kind !== 'held' || recorded.record.token !== claim.record.token) {
    return;
  }
  await rm(claim.file, { force: true }).catch(() => undefined);
}

/**
 * The claims above one rank that have not resolved themselves yet, awaited for
 * a bounded moment.
 *
 * A claim above this one was published after this claim's rank was read — the
 * rank named a directory state that claim has changed — so it is either a
 * contender that is still deciding, or a holder that may have decided the
 * ownership before this claim existed. Nothing is decided beside it either way:
 * this waits for it, and a contender resolves itself by refusing, which is what
 * makes a contended start still end with one owner. A claim whose process is
 * gone cannot own anything, exactly as everywhere else, and is cleared away
 * while the wait goes on; the files are read again before the answer is given,
 * so a claim that resolved itself away is never reported as still there.
 */
async function unresolvedClaimsAbove(
  root: string,
  rank: number,
  isAlive: LivenessProbe,
): Promise<{
  readonly held: readonly HeldClaim[];
  readonly unreadable: readonly { readonly file: string; readonly problem: string }[];
}> {
  const deadline = Date.now() + CLAIM_SETTLE_MS;
  for (;;) {
    const above = (await claimFiles(root)).filter((candidate) => candidate.rank > rank);
    if (above.length === 0) {
      return { held: [], unreadable: [] };
    }
    const held: HeldClaim[] = [];
    const unreadable: { file: string; problem: string }[] = [];
    for (const candidate of above) {
      const read = await readClaim(candidate.file);
      if (read.kind === 'absent') {
        // Resolved itself between the listing and the read: not a claim.
        continue;
      }
      if (read.kind === 'unreadable') {
        unreadable.push({ file: candidate.file, problem: read.problem });
        continue;
      }
      if (isAlive(read.record.pid)) {
        held.push({ rank: candidate.rank, file: candidate.file, record: read.record });
        continue;
      }
      await removeStaleClaim({ rank: candidate.rank, file: candidate.file, record: read.record });
    }
    if (held.length === 0 && unreadable.length === 0) {
      // Every claim above this one resolved itself away. The wait ends, and
      // the caller reads the directory again as part of its own decision.
      return { held, unreadable };
    }
    if (Date.now() >= deadline) {
      return { held, unreadable };
    }
    await new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_POLL_MS));
  }
}

/**
 * Removes one claim only while it is still the claim this invocation
 * published: a record somebody else put under that name is left alone, for a
 * person to inspect, rather than removed from under whoever holds it.
 */
async function removeClaim(claim: HeldClaim): Promise<void> {
  // A claim is never reused by another contender, so the record under this
  // name is either this invocation's own or evidence left for a person. A read
  // that fails for a moment — a name being cleared away, chiefly — is retried
  // before the claim is left where it is rather than removed unverified.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const recorded = await readClaim(claim.file);
    if (recorded.kind === 'absent') {
      return;
    }
    if (recorded.kind === 'held') {
      if (recorded.record.token === claim.record.token) {
        await rm(claim.file, { force: true });
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
  }
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
