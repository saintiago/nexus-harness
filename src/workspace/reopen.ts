/**
 * Resolving a workspace an issue's pointer names, and verifying the checkout of
 * one a run will continue.
 *
 * A coding turn may commit its work locally, so the checkout is expected to move
 * forward from the recorded base; the branch it is on is the identity that must
 * still hold, and the attempt refuses a workspace that is not on the branch its
 * ledger records.
 *
 * A pointer label is untrusted text on the issue, so resolving it checks more
 * than that it names a directory: the id must be a generated workspace id, its
 * resolved path must stay under the workspaces root, and the ledger must record
 * the external item and the repository the workspace was created for. A pointer
 * on the wrong item, site, or repository is refused instead of continued
 * (docs/implement-workspace-continuation.md).
 */
import { statSync } from 'node:fs';
import { messageOf } from '../shared/errors.js';
import { WorkspaceError } from './errors.js';
import { runGit } from './git.js';
import { workspaceIdProblem, workspacePathFor } from './run-directory.js';
import type { WorkspaceSourceItem } from './state.js';
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
 * What a continuation must match: the item that points at the workspace, and the
 * repository the run targets.
 */
export interface WorkspaceExpectation {
  /**
   * The external item the workspace must have been created for, read freshly.
   * Identity is the connector type, the site, and the immutable external id; the
   * key is display only.
   */
  readonly sourceItem: WorkspaceSourceItem;
  /**
   * The real root of the repository this run targets, or `null` when the caller
   * has none (the read-only preview takes no `--repo`). Whenever it is given, the
   * ledger must record the same repository: a workspace cloned from one
   * repository is never continued against another.
   */
  readonly sourceRoot: string | null;
}

/** One item, as a refusal names it: its type, key, immutable id, and site. */
function describeItem(item: WorkspaceSourceItem): string {
  return `${item.type} ${item.key} (immutable id ${item.id}) on ${item.scope}`;
}
/**
 * Resolves the workspace an issue's pointer names, without touching it: the clone
 * where the layout puts it, and the ledger that says what it was cloned from.
 * Whether the checkout is still usable is decided by {@link reopenWorkspace},
 * which reads it.
 *
 * The pointer label is untrusted, so the id, the path it resolves to, and the
 * item and repository the ledger records are all checked here; every refusal
 * says what is wrong with the label and what an operator can do about it.
 */
export async function resolveWorkspace(
  workDir: string,
  workspaceId: string,
  expected: WorkspaceExpectation,
): Promise<WorkspaceResolution> {
  const idProblem = workspaceIdProblem(workspaceId);
  if (idProblem !== null) {
    return {
      ok: false,
      problem:
        `its pointer label does not name a usable workspace: ${idProblem}. Fix the label to name ` +
        "the workspace that holds this issue's work, or remove it and handle the issue by hand",
    };
  }
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
  if (state.sourceItem === null) {
    return { ok: false, problem: missingIdentityProblem(workDir, state) };
  }
  const recorded = state.sourceItem;
  const claimed = expected.sourceItem;
  if (
    recorded.type !== claimed.type ||
    recorded.scope !== claimed.scope ||
    recorded.id !== claimed.id
  ) {
    return {
      ok: false,
      problem:
        `its workspace pointer names workspace ${workspaceId}, which was created for ` +
        `${describeItem(recorded)}, not for this item (${describeItem(claimed)}). A workspace is ` +
        'continued only by the item it was created for: remove the label, or label this item with ' +
        'the workspace that holds its own work',
    };
  }
  if (expected.sourceRoot !== null && state.sourceRoot !== expected.sourceRoot) {
    return {
      ok: false,
      problem:
        `its workspace pointer names workspace ${workspaceId}, which was cloned from ` +
        `"${state.sourceRoot}", and this run's source repository is "${expected.sourceRoot}". A ` +
        "workspace is continued only for the repository it was cloned from: fix the ledger's " +
        '"sourceRoot" if the repository really moved, or label this item with the workspace for ' +
        'this repository',
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
 * Why a ledger with no usable source item identity cannot be continued, and what
 * an operator can do about it. The harness performs no adoption or migration:
 * the repair is deliberate, by hand, from the evidence the workspace already
 * holds.
 */
function missingIdentityProblem(workDir: string, state: WorkspaceState): string {
  const firstReport = state.attempts[0]?.reportPath;
  const evidence =
    firstReport === undefined
      ? "the workspace's first attempt report"
      : `the workspace's first attempt report ("${firstReport}")`;
  return (
    `its workspace ledger ("${workspaceStatePath(workDir, state.workspaceId)}") records no source ` +
    'item identity, so the harness cannot tell which item the workspace was created for and will ' +
    'not continue it. A ledger written before identities were recorded, or by a run that did not ' +
    'come from a source, is like this. To continue the work by hand, add a "sourceItem" object to ' +
    'that ledger with this item\'s identity — "type", "scope" (the site), "id" (the immutable ' +
    'external id), and "key" — taking the values from ' +
    `${evidence}; its sourceRef records them. The harness never adopts or migrates a workspace on ` +
    'its own'
  );
}

/**
 * Resolves and verifies a workspace's checkout for a run that continues it. A
 * workspace's turns may have committed their work, so a `HEAD` ahead of the
 * recorded base is ordinary: the branch is what identifies the checkout, and a
 * workspace that is not on the branch its ledger records is refused rather than
 * continued. The recorded base travels back with the workspace so every attempt
 * keeps comparing against it.
 */
export async function reopenWorkspace(
  workDir: string,
  workspaceId: string,
  expected: WorkspaceExpectation,
): Promise<ContinuedWorkspace> {
  const resolution = await resolveWorkspace(workDir, workspaceId, expected);
  if (!resolution.ok) {
    throw new WorkspaceError(`workspace ${workspaceId} cannot be continued: ${resolution.problem}`);
  }
  const workspace = resolution.workspace;

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
