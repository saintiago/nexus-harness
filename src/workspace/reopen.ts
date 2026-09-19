/**
 * Resolving a workspace an issue's pointer names, and verifying the checkout of
 * one a run will continue.
 *
 * The harness never commits in a workspace, so a branch that is not the recorded
 * one, or a `HEAD` that moved, means something else changed it: the attempt
 * refuses rather than building on a state it cannot account for.
 */
import { statSync } from 'node:fs';
import { messageOf } from '../shared/errors.js';
import { WorkspaceError } from './errors.js';
import { runGit } from './git.js';
import { workspacePathFor } from './run-directory.js';
import { readWorkspaceState, workspaceStatePath } from './state.js';
import type { WorkspaceState } from './state.js';

/** A workspace a run may continue, resolved and ready to be reopened. */
export interface ContinuedWorkspace {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  /** Which attempt this run is for the workspace, counting this one. */
  readonly attempt: number;
}

/** Whether an issue's pointer names a workspace this machine can continue. */
export type WorkspaceResolution =
  | { readonly ok: true; readonly workspace: ContinuedWorkspace }
  | { readonly ok: false; readonly problem: string };
/**
 * Resolves the workspace an issue's pointer names, without touching it: the clone
 * where the layout puts it, and the ledger that says what it was cloned from.
 * Whether the checkout is still usable is decided by {@link reopenWorkspace},
 * which reads it.
 */
export async function resolveWorkspace(
  workDir: string,
  workspaceId: string,
): Promise<WorkspaceResolution> {
  const workspacePath = workspacePathFor(workDir, workspaceId);
  if (!isDirectory(workspacePath)) {
    return {
      ok: false,
      problem:
        `its workspace pointer names ${workspaceId}, and this machine has no workspace at ` +
        `"${workspacePath}"`,
    };
  }

  let state: WorkspaceState | null;
  try {
    state = await readWorkspaceState(workDir, workspaceId);
  } catch (cause) {
    return { ok: false, problem: `its workspace ledger cannot be read: ${messageOf(cause)}` };
  }
  if (state === null) {
    return {
      ok: false,
      problem:
        `its workspace exists at "${workspacePath}" but has no ledger at ` +
        `"${workspaceStatePath(workDir, workspaceId)}", so there is no record of what it was ` +
        'cloned from and the harness will not continue it',
    };
  }
  if (state.workspaceId !== workspaceId) {
    return {
      ok: false,
      problem: `its workspace ledger names ${state.workspaceId}, not ${workspaceId}`,
    };
  }

  return {
    ok: true,
    workspace: {
      workspaceId,
      workspacePath,
      branch: state.branch,
      baseCommit: state.baseCommit,
      attempt: state.attempts.length + 1,
    },
  };
}

/**
 * Resolves and verifies a workspace's checkout for a run that continues it. The
 * harness never commits in a workspace, so a branch that is not the recorded one,
 * or a `HEAD` that moved, means something else changed it: the attempt refuses
 * rather than building on a state it cannot account for.
 */
export async function reopenWorkspace(
  workDir: string,
  workspaceId: string,
): Promise<ContinuedWorkspace> {
  const resolution = await resolveWorkspace(workDir, workspaceId);
  if (!resolution.ok) {
    throw new WorkspaceError(`workspace ${workspaceId} cannot be continued: ${resolution.problem}`);
  }
  const workspace = resolution.workspace;

  const head = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], workspace.workspacePath);
  const commit = head.stdout.trim();
  if (head.code !== 0 || commit !== workspace.baseCommit) {
    throw new WorkspaceError(
      `workspace ${workspaceId} is at ${commit === '' ? 'no commit' : commit}, not the base commit ` +
        `${workspace.baseCommit} it was cloned at: something committed in it, and the harness never ` +
        'does that, so it will not continue it',
    );
  }
  const symbolic = await runGit(
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    workspace.workspacePath,
  );
  const branch = symbolic.stdout.trim();
  if (symbolic.code !== 0 || branch !== workspace.branch) {
    throw new WorkspaceError(
      `workspace ${workspaceId} is on ${branch === '' ? 'no branch' : `branch "${branch}"`}, not ` +
        `its recorded "${workspace.branch}", so the harness will not continue it`,
    );
  }
  return workspace;
}

/** Whether a path is an existing directory. */
function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
