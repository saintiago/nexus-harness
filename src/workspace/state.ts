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
import type { RunStatus } from '../shared/types.js';
import { WorkspaceError } from './errors.js';

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
  readonly attempts: readonly WorkspaceAttempt[];
}
/** Where one workspace's ledger lives: `<workDir>/workspaces/<workspaceId>.json`. */
export function workspaceStatePath(workDir: string, workspaceId: string): string {
  return path.join(path.resolve(workDir), 'workspaces', `${workspaceId}.json`);
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
