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
 * One recorded source item, or `null` when the ledger holds no usable identity:
 * absent, of the wrong shape, or missing one of the four fields. An unusable
 * value is never guessed at — the continuation refuses the ledger and says what
 * to write (docs/implement-workspace-continuation.md).
 */
function parseSourceItem(value: unknown): WorkspaceSourceItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  const text = (name: string): string | null => {
    const field = fields[name];
    return typeof field === 'string' && field.trim() !== '' ? field : null;
  };
  const type = text('type');
  const scope = text('scope');
  const id = text('id');
  const key = text('key');
  if (type === null || scope === null || id === null || key === null) {
    return null;
  }
  return { type, scope, id, key };
}

/** One ledger, validated: a file that is not one is reported, never guessed at. */
function parseWorkspaceState(value: unknown, where: string): WorkspaceState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceError(`"${where}" is not a workspace ledger object`);
  }
  const fields = value as Record<string, unknown>;
  const text = (name: string): string => {
    const field = fields[name];
    if (typeof field !== 'string' || field.trim() === '') {
      throw new WorkspaceError(`"${where}" has no usable "${name}"`);
    }
    return field;
  };
  const attempts = fields['attempts'];
  if (!Array.isArray(attempts)) {
    throw new WorkspaceError(`"${where}" has no attempts array`);
  }
  return {
    version: 1,
    workspaceId: text('workspaceId'),
    sourceRoot: text('sourceRoot'),
    baseCommit: text('baseCommit'),
    branch: text('branch'),
    createdAt: text('createdAt'),
    sourceItem: parseSourceItem(fields['sourceItem']),
    attempts: attempts as readonly WorkspaceAttempt[],
  };
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
