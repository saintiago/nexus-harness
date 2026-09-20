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
 * than that it names a directory: the id must be a usable workspace id (a
 * generated run name, or the key a source preferred for the workspace), its
 * resolved path — junctions and symbolic links followed, both for the clone and
 * for the ledger beside it — must stay under the workspaces root, and the ledger
 * must record the external item and the repository the workspace was created
 * for. A pointer on the wrong item, site, or repository is refused instead of
 * continued
 * (docs/implement-workspace-continuation.md).
 */
import { statSync } from 'node:fs';
import { messageOf } from '../shared/errors.js';
import { WorkspaceError } from './errors.js';
import { gitFailure, runGit } from './git.js';
import type { GitRunBounds } from './git.js';
import { outsideWorkspacesProblem, workspaceIdProblem, workspacePathFor } from './run-directory.js';
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
  // Where the id's own name points is checked first, and on the resolved path:
  // a generated id whose directory is a junction or symbolic link out of the
  // workspaces root is refused here, before anything is read through it and
  // before anything is reserved or claimed.
  let workspacePath: string;
  try {
    workspacePath = workspacePathFor(workDir, workspaceId);
  } catch (cause) {
    return {
      ok: false,
      problem:
        `its workspace pointer names workspace ${workspaceId}, whose directory is not where this ` +
        `harness keeps workspaces: ${messageOf(cause)}. Move the workspace's real directory ` +
        'where the layout says it lives, or remove the label and handle the issue by hand',
    };
  }
  if (!isDirectory(workspacePath)) {
    return {
      ok: false,
      problem:
        `its workspace pointer names ${workspaceId}, and this machine has no workspace at ` +
        `"${workspacePath}"`,
    };
  }
  // The ledger read is the other half of the same check: the clone is where the
  // layout puts it, but the record beside it can still be a link out of the
  // workspaces root, and a continuation reads only what resolves inside it.
  const ledgerPath = workspaceStatePath(workDir, workspaceId);
  const ledgerOutside = outsideWorkspacesProblem(workDir, ledgerPath);
  if (ledgerOutside !== null) {
    return {
      ok: false,
      problem:
        `its workspace pointer names workspace ${workspaceId}, and the ledger beside it is not one ` +
        `this harness will read: ${ledgerOutside}. Put the workspace's own ledger back at ` +
        `"${ledgerPath}", or remove the label and handle the issue by hand`,
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
    'external id), and "key". A source-backed run recorded it in ' +
    `${evidence}; a workspace created by a run that did not come from a source has no such record, ` +
    'and the identity has to be written deliberately. The harness never adopts or migrates a ' +
    'workspace on its own'
  );
}

/**
 * Why a fresh attempt cannot use this name for the workspace it would create,
 * or `null` when nothing holds the name.
 *
 * A source may prefer a human-readable name for a new workspace — the canonical
 * key of the item, for example `HARN-23` — and that name is a claim on one
 * directory in the workspaces root, with its ledger beside it. Whatever already
 * holds it is never adopted and never overwritten, whether it is another item's
 * workspace, this item's own workspace with no pointer label saying so, or a
 * record the harness cannot read as one of its own. The checks are the pointer
 * checks seen from the other side — the id, the resolved path of the directory
 * and of the ledger beside it, and the item and repository the ledger records —
 * because a name a source prefers is trusted no more than a label is.
 *
 * Every refusal says what is there and what an operator can do about it.
 * `continueLabel` is the pointer label that would continue the workspace when it
 * turns out to hold this item's work; the caller owns that label, so this module
 * needs to know nothing about pointer labels themselves.
 */
export async function takenWorkspaceNameProblem(
  workDir: string,
  workspaceId: string,
  expected: WorkspaceExpectation,
  continueLabel: string,
): Promise<string | null> {
  const idProblem = workspaceIdProblem(workspaceId);
  if (idProblem !== null) {
    return (
      `the name it would give its new workspace cannot be used: ${idProblem}. A workspace id is a ` +
      'generated name or an item key, and a name is never read as a path'
    );
  }
  let workspacePath: string;
  let ledgerPath: string;
  try {
    workspacePath = workspacePathFor(workDir, workspaceId);
    ledgerPath = workspaceStatePath(workDir, workspaceId);
  } catch (cause) {
    return (
      `the name it would give its new workspace, ${workspaceId}, cannot be resolved to a place ` +
      `this harness keeps workspaces: ${messageOf(cause)}. Move the workspace's real directory ` +
      'where the layout says it lives, or move it aside, and scan again'
    );
  }
  // As for a pointer label: a ledger whose resolved path leaves the workspaces
  // root is refused before anything is read through it.
  const ledgerOutside = outsideWorkspacesProblem(workDir, ledgerPath);
  const directory = isDirectory(workspacePath);
  const ledger = ledgerOutside === null && pathExists(ledgerPath);
  if (!directory && !ledger && ledgerOutside === null) {
    return null;
  }

  const holds =
    directory && ledger
      ? `the workspace directory "${workspacePath}" and the ledger beside it ("${ledgerPath}")`
      : directory
        ? `a directory at "${workspacePath}"`
        : `a ledger at "${ledgerPath}"`;
  const opening =
    `its new workspace would be named ${workspaceId}, and ${holds} already exists, so the harness ` +
    'will not create that workspace and will not touch what is there';

  if (ledgerOutside !== null) {
    return (
      `${opening}: ${ledgerOutside}. A pointer label is never followed through a junction or a ` +
      `symbolic link, and the name cannot be used until the ledger is where the layout says it ` +
      `lives: put the workspace's own ledger back at "${ledgerPath}", or move it aside, and scan ` +
      'again'
    );
  }
  let state: WorkspaceState | null;
  try {
    state = ledger ? await readWorkspaceState(workDir, workspaceId) : null;
  } catch (cause) {
    return (
      `${opening}: the ledger read beside it is not one this harness wrote — ${messageOf(cause)}. ` +
      'Nothing here adopts or overwrites a workspace whose record it cannot read: repair that ' +
      'file by hand, or move the workspace and its ledger aside, and scan again'
    );
  }
  if (state === null) {
    return (
      `${opening}: that directory has no ledger at "${ledgerPath}", so there is no record of what ` +
      'it was cloned from and whose work it is. The harness never adopts or overwrites a ' +
      `workspace on its own: if it holds this item's work, restore its ledger and add the ` +
      `"${continueLabel}" label, then scan again; otherwise move it aside`
    );
  }
  if (state.workspaceId !== workspaceId) {
    return (
      `${opening}: its ledger names workspace "${state.workspaceId}", not "${workspaceId}", and ` +
      "another workspace's record is never read as this name's. Repair the file by hand, or move " +
      'the directory and its ledger aside, and scan again'
    );
  }
  if (state.sourceItem === null) {
    return (
      `${opening}: ${missingIdentityProblem(workDir, state)}. If it holds this item's work, add ` +
      `the "${continueLabel}" label once that is repaired, then scan again`
    );
  }
  const recorded = state.sourceItem;
  const claimed = expected.sourceItem;
  if (
    recorded.type !== claimed.type ||
    recorded.scope !== claimed.scope ||
    recorded.id !== claimed.id
  ) {
    return (
      `${opening}: it was created for ${describeItem(recorded)}, not for this item ` +
      `(${describeItem(claimed)}). A workspace belongs to what created it, and the harness never ` +
      "overwrites another item's workspace or adopts it for this one: move it aside, or continue " +
      'it from the item it belongs to, and scan again'
    );
  }
  if (expected.sourceRoot !== null && state.sourceRoot !== expected.sourceRoot) {
    return (
      `${opening}: it is this item's workspace, but it was cloned from "${state.sourceRoot}", and ` +
      `this run's source repository is "${expected.sourceRoot}". A workspace is continued only ` +
      'for the repository it was cloned from: fix the ledger\'s "sourceRoot" if the repository ' +
      'really moved, or move the workspace aside, and scan again'
    );
  }
  return (
    `${opening}: its ledger records that it is this item's work, but no "${continueLabel}" label ` +
    'points at it, and the harness never adopts a workspace on its own. Add that label and scan ' +
    'again to continue that workspace, or move it aside to start a new one'
  );
}

/**
 * Resolves and verifies a workspace's checkout for a run that continues it. A
 * workspace's turns may have committed their work, so a `HEAD` ahead of the
 * recorded base is ordinary: the branch is what identifies the checkout, and a
 * workspace that is not on the branch its ledger records is refused rather than
 * continued. The recorded base travels back with the workspace so every attempt
 * keeps comparing against it. The reading of the branch is bounded and
 * stoppable like every other Git invocation: a caller that already has a stop
 * request hands it over, and a reading the harness had to stop is reported as
 * the stop it was rather than as a statement about the checkout.
 */
export async function reopenWorkspace(
  workDir: string,
  workspaceId: string,
  expected: WorkspaceExpectation,
  bounds: GitRunBounds = {},
): Promise<ContinuedWorkspace> {
  const resolution = await resolveWorkspace(workDir, workspaceId, expected);
  if (!resolution.ok) {
    throw new WorkspaceError(`workspace ${workspaceId} cannot be continued: ${resolution.problem}`);
  }
  const workspace = resolution.workspace;

  const symbolic = await runGit(
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    workspace.workspacePath,
    bounds,
  );
  const branch = symbolic.stdout.trim();
  if (symbolic.outcome !== 'exited') {
    // A reading the harness stopped is not a statement about the checkout: it
    // says nothing about which branch the workspace is on.
    throw gitFailure(`the branch of workspace ${workspaceId} could not be read`, symbolic);
  }
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

/** Whether anything — a directory, a file, or a link — exists at one path. */
function pathExists(candidate: string): boolean {
  try {
    statSync(candidate);
    return true;
  } catch {
    return false;
  }
}
