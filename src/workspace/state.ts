/**
 * The workspace ledger: what a clone was cloned from, and every attempt made in
 * it, at `<workDir>/workspaces/<workspaceId>.json`.
 *
 * It lives beside the clone rather than inside it, so it never shows up as a
 * change in the working copy. It is derived state: a run's own report stays the
 * authority on what that run did, and the ledger is only what the next attempt
 * reads. Nothing rewrites a report.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { messageOf } from '../shared/errors.js';
import type { RunStatus, SourceRef } from '../shared/types.js';
import { WorkspaceError } from './errors.js';
import { workspacePathFor } from './run-directory.js';

/** One attempt recorded against a workspace. */
export interface WorkspaceAttempt {
  readonly runId: string;
  readonly outcome: RunStatus;
  /** The escalation tier that ran it, when a source named one. */
  readonly tier?: string;
  /** Why the run ended as it did, in one sentence, as its report records it. */
  readonly reason?: string;
  readonly endedAt: string;
  readonly reportPath: string;
}

/**
 * The external item a workspace was created for, as its ledger records it.
 * Identity is the connector type, the site, and the immutable external id; the
 * key is display only, because the key can change and the id cannot.
 */
export interface WorkspaceSourceItem {
  readonly type: string;
  readonly scope: string;
  readonly id: string;
  readonly key: string;
}

/** The identity fields of one prepared item, as a ledger records them. */
export function sourceItemFor(ref: SourceRef): WorkspaceSourceItem {
  return { type: ref.type, scope: ref.scope, id: ref.id, key: ref.key };
}

/**
 * One workspace's local state: what it was cloned from, and the attempts made in
 * it. It lives beside the clone (`<workDir>/workspaces/<workspaceId>.json`) rather
 * than inside it, so it never shows up as a change in the working copy, and it is
 * derived state: a run's own report stays the authority on what that run did.
 */
export interface WorkspaceState {
  readonly version: 1;
  readonly workspaceId: string;
  readonly sourceRoot: string;
  readonly baseCommit: string;
  readonly branch: string;
  readonly createdAt: string;
  /**
   * The external item this workspace was created for; `null` for a workspace a
   * run created without one (a file-task run) and for a ledger written before
   * identities were recorded. A continuation refuses a `null`: it cannot tell
   * whether the workspace is that item's work
   * (docs/implement-workspace-continuation.md).
   */
  readonly sourceItem: WorkspaceSourceItem | null;
  readonly attempts: readonly WorkspaceAttempt[];
}
/** Where one workspace's ledger lives: `<workDir>/workspaces/<workspaceId>.json`. */
export function workspaceStatePath(workDir: string, workspaceId: string): string {
  // The same validated id the clone's own path uses, so a ledger can never be
  // read from or written to a path the id was not allowed to name.
  return `${workspacePathFor(workDir, workspaceId)}.json`;
}

/**
 * A string the ledger records: the field is present and holds something other
 * than whitespace. The harness writes only such values, so a ledger holding
 * anything else was not written by this harness and is refused rather than
 * coerced (docs/implement-workspace-continuation.md).
 */
function ledgerText(field: string): z.ZodString {
  return z
    .string({ error: `${field} must be a string` })
    .refine((value) => value.trim().length > 0, { error: `${field} must not be blank` });
}

/**
 * The item identity a ledger records, when it has one. The four fields are the
 * identity and the display key a continuation checks; an object missing one of
 * them was not written by this harness, and is refused rather than read as an
 * identity it does not hold (`sourceItem: null` is the recorded absence).
 */
const workspaceSourceItemSchema = z.strictObject({
  type: ledgerText('sourceItem.type'),
  scope: ledgerText('sourceItem.scope'),
  id: ledgerText('sourceItem.id'),
  key: ledgerText('sourceItem.key'),
});

/**
 * One recorded attempt, as a continuation and its guidance consume it: the run's
 * id, how it ended and why, the tier that ran it, when it ended, and where its
 * report is. An entry of another shape is refused, never read as a partial one.
 */
const workspaceAttemptSchema = z.strictObject({
  runId: ledgerText('runId'),
  outcome: z.enum(['passed', 'failed', 'cancelled'], {
    error: 'outcome must be "passed", "failed", or "cancelled"',
  }),
  tier: ledgerText('tier').optional(),
  reason: ledgerText('reason').optional(),
  endedAt: ledgerText('endedAt'),
  reportPath: ledgerText('reportPath'),
});

/**
 * One ledger, as this harness writes it and reads it. The version is fixed: an
 * unsupported one is refused instead of migrated into this shape, and every
 * field a continuation or its guidance reads is validated here rather than cast.
 */
const workspaceStateSchema = z.strictObject({
  version: z.literal(1, {
    error:
      'version must be 1: this harness writes and reads only version 1 of the workspace ledger, ' +
      'and it never migrates one by itself',
  }),
  workspaceId: ledgerText('workspaceId'),
  sourceRoot: ledgerText('sourceRoot'),
  baseCommit: ledgerText('baseCommit'),
  branch: ledgerText('branch'),
  createdAt: ledgerText('createdAt'),
  sourceItem: workspaceSourceItemSchema.nullish(),
  attempts: z.array(workspaceAttemptSchema, { error: 'attempts must be an array' }),
});

/**
 * How a ledger this harness did not write is reported: the file, what about it
 * does not match, and the fact that nothing here guesses at it. The harness
 * never adopts, repairs, or migrates a ledger on its own, so a record it cannot
 * read as its own is refused before anything is read through it.
 */
function ledgerShapeProblem(where: string, error: z.ZodError): WorkspaceError {
  const details = error.issues
    .map((issue) => {
      const at = issue.path.length === 0 ? 'the ledger' : issue.path.map(String).join('.');
      return `${at}: ${issue.message}`;
    })
    .join('; ');
  return new WorkspaceError(
    `"${where}" is not a workspace ledger this harness wrote: ${details}. The harness refuses a ` +
      'ledger it cannot read as its own rather than guessing at it: repair the file by hand, or ' +
      'handle the issue without continuing this workspace',
  );
}

/** One ledger, validated: a file that is not one is reported, never guessed at. */
function parseWorkspaceState(value: unknown, where: string): WorkspaceState {
  const parsed = workspaceStateSchema.safeParse(value);
  if (!parsed.success) {
    throw ledgerShapeProblem(where, parsed.error);
  }
  const { sourceItem, ...fields } = parsed.data;
  return { ...fields, sourceItem: sourceItem ?? null };
}

/** Reads one workspace's ledger, or `null` when there is none. */
export async function readWorkspaceState(
  workDir: string,
  workspaceId: string,
): Promise<WorkspaceState | null> {
  const file = workspaceStatePath(workDir, workspaceId);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new WorkspaceError(`"${file}" cannot be read: ${messageOf(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new WorkspaceError(`"${file}" is not valid JSON: ${messageOf(cause)}`);
  }
  return parseWorkspaceState(parsed, file);
}

/** Writes one ledger atomically: a reader sees the old file or the new one. */
export async function writeWorkspaceState(workDir: string, state: WorkspaceState): Promise<void> {
  const file = workspaceStatePath(workDir, state.workspaceId);
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new WorkspaceError(`"${file}" cannot be written: ${messageOf(cause)}`);
  }
}

/** Records one finished attempt in a workspace's ledger. */
export async function recordWorkspaceAttempt(
  workDir: string,
  workspaceId: string,
  attempt: WorkspaceAttempt,
): Promise<void> {
  const state = await readWorkspaceState(workDir, workspaceId);
  if (state === null) {
    throw new WorkspaceError(
      `workspace ${workspaceId} has no ledger at "${workspaceStatePath(workDir, workspaceId)}", ` +
        'so this attempt cannot be recorded against it',
    );
  }
  await writeWorkspaceState(workDir, { ...state, attempts: [...state.attempts, attempt] });
}
