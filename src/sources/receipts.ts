/**
 * The only retained intake state: one exclusive lock per output directory, and
 * one receipt per attempted item, keyed by the item's immutable identity.
 *
 * A receipt is created exclusively before any remote mutation or agent work, so
 * the same item is not attempted twice by this consumer; a receipt that is not
 * one this harness wrote is an error rather than an absence. The lock is taken
 * after preflight and never broken automatically.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import type { RunStatus, SourceRef } from '../shared/types.js';
import { SourceError } from './contract.js';

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
 * Nothing mutable takes part in it — not the issue key, the summary, the status,
 * or the update timestamp — so renaming, relabelling, or reopening an external
 * item can never make it look like new work (docs/architecture.md §8).
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one receipt. A missing file is an absence (`null`); a file that is not a
 * receipt this harness wrote is an error, never an absence: treating corruption
 * as "not attempted yet" is exactly how an issue gets run twice
 * (docs/spec.md §6).
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
 * exists — this process's own earlier attempt, a crashed one, or another
 * consumer using the same output directory — and the item is not attempted.
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
 * owner's recorded details so a human can look at it (docs/spec.md §6).
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
