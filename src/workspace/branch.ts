/**
 * Keeping a retained checkout on the branch its workspace ledger records.
 *
 * A coding turn has write access to its clone, Git metadata included, so it can
 * leave the checkout on a branch of its own with its work committed there. What
 * the harness reads, checks and delivers is the workspace's recorded branch:
 * the delivery step publishes that branch's own tip and refuses one the checks
 * never validated (HARN-17), and a continuation reopens the branch its ledger
 * records. So before another turn starts, and before the round that judges the
 * turn reads the working copy, the checkout is returned to that branch when
 * that can be done without losing anything: the checkout is clean and its own
 * commit descends from the recorded branch's tip, which is fast-forwarded to it
 * and checked out.
 *
 * A turn is also asked to work from the workspace's own committed state, not
 * from leftovers an earlier turn never committed: what a turn starts from is
 * the revision the checks judge and a delivery publishes, so a caller that is
 * about to start one requires the checkout to be clean as well
 * ({@link BranchRead}), on the recorded branch included, and stops with the
 * branch and the paths when it is not. The round that judges a turn still reads
 * what the turn left, uncommitted work included — that is what the attempt is
 * being judged on, and the delivery step's own clean-checkout refusal is the
 * boundary for publishing it.
 *
 * Everything else stops instead of being forced. A checkout holding uncommitted
 * changes, a detached HEAD, a commit the recorded branch does not descend
 * from, and a recorded branch the workspace does not hold are each refused with
 * the branch names and what an operator can do by hand. Nothing here resets,
 * force-updates, or discards a commit, and no branch is adopted because of what
 * it is called (HARN-35).
 */
import { WorkspaceError } from './errors.js';
import { firstLine, gitFailure, listPaths, runGit } from './git.js';
import type { GitRunBounds } from './git.js';
import { statusEntries } from './status.js';

/** How a retained checkout stands relative to the branch its ledger records. */
export type BranchStanding =
  /** The checkout is on the recorded branch; nothing has to move. */
  | { readonly kind: 'on-branch' }
  /**
   * The checkout is clean, on another branch, and its commit descends from the
   * recorded branch's tip: that branch can be fast-forwarded to the checkout
   * and checked out again without losing a commit.
   */
  | {
      readonly kind: 'recoverable';
      /** The branch the checkout is on instead of the recorded one. */
      readonly currentBranch: string;
      /** The commit the checkout is at: what the recorded branch would take. */
      readonly revision: string;
      /** The recorded branch's own tip, which `revision` descends from. */
      readonly recorded: string;
    }
  /**
   * The checkout may not be moved; `problem` says why, names the branches, and
   * says what an operator can do by hand.
   */
  | { readonly kind: 'refused'; readonly problem: string };

/** What returning a checkout to its recorded branch did. */
export type BranchReturn =
  | { readonly changed: false }
  | {
      readonly changed: true;
      /** The branch the checkout was on before it was returned. */
      readonly from: string;
      /** The commit the recorded branch was fast-forwarded to. */
      readonly revision: string;
    };

/**
 * How strictly a caller needs the checkout read. A caller that is about to
 * start a coding turn passes `requireClean`, because a turn works from the
 * workspace's own committed state: uncommitted work — staged, unstaged, or
 * untracked — stops it there, on the recorded branch included, rather than
 * being handed on to another agent. A caller that is about to read what a turn
 * left leaves it out, because that working copy is what its round is there to
 * judge.
 */
export interface BranchRead {
  /**
   * Refuse a checkout that holds uncommitted work, even when it is on the
   * branch its ledger records. Off by default, because reading a working copy a
   * turn has just written is the ordinary case a check round is for.
   */
  readonly requireClean?: boolean;
}

/**
 * How a checkout's state is read: the working tree with the same reading the
 * delivery step makes, so a checkout this module calls clean is one delivery
 * would accept as clean too.
 */
const STATUS_ARGS = [
  'status',
  '--porcelain=v1',
  '-z',
  '--untracked-files=all',
  '--ignored=no',
  '--no-renames',
] as const;

/**
 * Why a branch name cannot be used, or `null` when it can. A name that begins
 * with `-` would be read as an option by the command that checks it out; this
 * harness never writes such a name, so a ledger that holds one is repaired by
 * hand rather than passed on to Git.
 */
function unusableBranchName(branch: string): string | null {
  if (!branch.startsWith('-')) {
    return null;
  }
  return (
    `the branch this workspace's ledger records, ${JSON.stringify(branch)}, cannot be used as a ` +
    'branch name: Git would read a name that begins with "-" as an option. Repair the ledger\'s ' +
    '"branch" field by hand, or move the workspace aside'
  );
}

/**
 * Reads one commit, or `''` when the revision is not in the working copy. An
 * invocation the harness had to stop is the stop it was, never a statement
 * about the checkout.
 */
async function readCommit(
  workspacePath: string,
  revision: string,
  describe: string,
  bounds: GitRunBounds,
): Promise<string> {
  const result = await runGit(['rev-parse', '--verify', revision], workspacePath, bounds);
  if (result.outcome !== 'exited') {
    throw gitFailure(`${describe} could not be read`, result);
  }
  return result.code === 0 ? result.stdout.trim() : '';
}

/**
 * How the checkout of `workspacePath` stands relative to the branch its ledger
 * records. This is the reading half: it changes nothing, so a caller that only
 * has to decide whether a workspace may be continued — resolving a pointer, for
 * example — can use it without opening the checkout for a turn. A checkout that
 * is not on the recorded branch but could be returned to it is reported as
 * recoverable rather than refused; {@link returnToRecordedBranch} is what does
 * the fast-forward and the checkout.
 *
 * Every reading is bounded like the harness's other Git steps, and a reading
 * the harness had to stop is reported as the stop it was rather than as a
 * statement about the checkout. `read` says how strictly the checkout has to
 * stand: a caller about to start a coding turn requires a clean one
 * ({@link BranchRead}), and a caller about to read what a turn left does not.
 */
export async function inspectBranchStanding(
  workspacePath: string,
  branch: string,
  bounds: GitRunBounds = {},
  read: BranchRead = {},
): Promise<BranchStanding> {
  const unusable = unusableBranchName(branch);
  if (unusable !== null) {
    return { kind: 'refused', problem: unusable };
  }

  const symbolic = await runGit(
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    workspacePath,
    bounds,
  );
  if (symbolic.outcome !== 'exited') {
    throw gitFailure(`the branch of "${workspacePath}" could not be read`, symbolic);
  }
  const current = symbolic.stdout.trim();
  if (symbolic.code === 0) {
    if (current !== branch) {
      return await inspectOtherBranch(workspacePath, branch, current, bounds);
    }
    if (read.requireClean !== true) {
      return { kind: 'on-branch' };
    }
    return await inspectRecordedBranch(workspacePath, branch, bounds);
  }

  // A detached HEAD names no branch, so which branch the work belongs on is a
  // guess this harness does not make: it is refused like any other state that
  // cannot be returned to the recorded branch by fast-forwarding a named one.
  return {
    kind: 'refused',
    problem:
      `the retained workspace "${workspacePath}" is on no branch (a detached HEAD), not on its ` +
      `recorded branch "${branch}". The harness never adopts, switches, resets, or force-updates ` +
      'a detached checkout on its own: check out the recorded branch by hand once the detached ' +
      'commit is the work to keep, or move the workspace aside',
  };
}

/**
 * The standing of a checkout that is on the branch its ledger records, for a
 * caller that needs the state a coding turn starts from: the workspace's own
 * committed state, so staged, unstaged, or untracked work stops the run here
 * rather than being handed to another agent.
 */
async function inspectRecordedBranch(
  workspacePath: string,
  branch: string,
  bounds: GitRunBounds,
): Promise<BranchStanding> {
  const leftovers = await leftoversOf(workspacePath, bounds);
  if (leftovers.length === 0) {
    return { kind: 'on-branch' };
  }
  const revision = await readCommit(
    workspacePath,
    'HEAD^{commit}',
    `the commit of "${workspacePath}"`,
    bounds,
  );
  return {
    kind: 'refused',
    problem:
      `the retained workspace "${workspacePath}" is on the branch its ledger records, "${branch}"` +
      (revision === '' ? '' : ` (at ${revision})`) +
      `, and it holds uncommitted changes (${listPaths(leftovers)}), so no coding turn is started ` +
      "on it: a turn is asked to work from the workspace's own committed state, and the harness " +
      "never commits, stashes, or discards a checkout's leftovers. Commit or remove those paths by " +
      `hand in the retained workspace, then continue the work on "${branch}" again, or move the ` +
      'workspace aside',
  };
}

/**
 * The paths a checkout holds uncommitted, read exactly as the delivery step
 * reads them, so a checkout this module calls clean is one delivery would accept
 * as clean too.
 */
async function leftoversOf(
  workspacePath: string,
  bounds: GitRunBounds,
): Promise<readonly string[]> {
  const status = await runGit([...STATUS_ARGS], workspacePath, bounds);
  if (status.outcome !== 'exited') {
    throw gitFailure(`the state of "${workspacePath}" could not be read`, status);
  }
  if (status.code !== 0) {
    throw new WorkspaceError(
      `the state of "${workspacePath}" cannot be read: ${firstLine(status.stderr)}`,
    );
  }
  return statusEntries(status.stdout).map((entry) => entry.path);
}

/**
 * The standing of a checkout that is on some other branch: returnable only when
 * it is clean and its own commit descends from the recorded branch's tip, so
 * that fast-forwarding that branch to it keeps every commit both sides hold.
 */
async function inspectOtherBranch(
  workspacePath: string,
  branch: string,
  current: string,
  bounds: GitRunBounds,
): Promise<BranchStanding> {
  const revision = await readCommit(
    workspacePath,
    'HEAD^{commit}',
    `the commit of "${workspacePath}"`,
    bounds,
  );
  if (revision === '') {
    return {
      kind: 'refused',
      problem:
        `the retained workspace "${workspacePath}" is on branch "${current}", not on its ` +
        `recorded branch "${branch}", and the commit it is at cannot be read, so nothing can be ` +
        'returned or compared by hand either. Inspect the workspace by hand and move it aside, or ' +
        'repair it and scan again',
    };
  }

  const leftovers = await leftoversOf(workspacePath, bounds);
  if (leftovers.length > 0) {
    return {
      kind: 'refused',
      problem:
        `the retained workspace "${workspacePath}" is on branch "${current}", not on its recorded ` +
        `branch "${branch}", and it holds uncommitted changes (${listPaths(leftovers)}), so the ` +
        "harness has no clean checkout to switch: it never commits or discards a checkout's " +
        'leftovers, and never switches or force-updates a dirty one. Commit or remove those paths ' +
        `by hand in the retained workspace, then return the checkout to "${branch}" — the commit ` +
        `it is at (${revision}) stays on branch "${current}" and nothing is lost — or move the ` +
        'workspace aside',
    };
  }

  const recorded = await readCommit(
    workspacePath,
    `refs/heads/${branch}`,
    `the recorded branch "${branch}" of "${workspacePath}"`,
    bounds,
  );
  if (recorded === '') {
    return {
      kind: 'refused',
      problem:
        `the retained workspace "${workspacePath}" is on branch "${current}", and it holds no ` +
        `branch named "${branch}", the branch its ledger records, so there is nothing to return ` +
        'the checkout to. The harness never recreates, renames, or adopts a branch on its own: ' +
        `recreate "${branch}" at the commit the workspace's work belongs on by hand and check it ` +
        'out, or move the workspace aside',
    };
  }

  const ancestor = await runGit(
    ['merge-base', '--is-ancestor', recorded, revision],
    workspacePath,
    bounds,
  );
  if (ancestor.outcome !== 'exited') {
    throw gitFailure(
      `whether "${branch}" is an ancestor of ${revision} in "${workspacePath}" could not be read`,
      ancestor,
    );
  }
  if (ancestor.code === 1) {
    return {
      kind: 'refused',
      problem:
        `the retained workspace "${workspacePath}" is on branch "${current}" at ${revision}, and ` +
        `its recorded branch "${branch}" is at ${recorded}, which is not an ancestor of it: ` +
        `returning the checkout to "${branch}" would leave this work behind, and fast-forwarding ` +
        `"${branch}" to ${revision} would drop the commits "${branch}" holds. Nothing was ` +
        'switched, reset, or force-updated, and no commit was discarded: reconcile the two by hand ' +
        `in the retained workspace (merge or rebase ${revision} onto "${branch}", keeping both ` +
        `histories), then check out "${branch}", or move the workspace aside`,
    };
  }
  if (ancestor.code !== 0) {
    throw new WorkspaceError(
      `the relationship between "${branch}" (${recorded}) and ${revision} cannot be read in ` +
        `"${workspacePath}": ${firstLine(ancestor.stderr)}`,
    );
  }
  return { kind: 'recoverable', currentBranch: current, revision, recorded };
}

/**
 * Returns the checkout of `workspacePath` to the branch its ledger records,
 * without losing anything, or refuses with why and what an operator can do.
 *
 * The recorded branch is checked out and then fast-forwarded to the checkout's
 * own commit — checkout first, so a checkout Git refuses leaves the working copy
 * where it was. The branch only ever moves forward, to a commit that already
 * contains it; the commit the checkout was at stays on the branch it was made
 * on; and nothing is reset, force-updated, or discarded. A checkout that is
 * already on the recorded branch is left exactly as it is, uncommitted changes
 * included — that is the ordinary state a round reads after a turn
 * (docs/implement-workspace-continuation.md) — unless the caller requires a
 * clean checkout ({@link BranchRead}), which is how a coding turn is only ever
 * started from the workspace's own committed state.
 */
export async function returnToRecordedBranch(
  workspacePath: string,
  branch: string,
  bounds: GitRunBounds = {},
  read: BranchRead = {},
): Promise<BranchReturn> {
  const standing = await inspectBranchStanding(workspacePath, branch, bounds, read);
  if (standing.kind === 'refused') {
    throw new WorkspaceError(standing.problem);
  }
  if (standing.kind === 'on-branch') {
    return { changed: false };
  }

  const checkedOut = await runGit(['checkout', '--quiet', branch], workspacePath, bounds);
  if (checkedOut.outcome !== 'exited') {
    throw gitFailure(
      `the recorded branch "${branch}" could not be checked out in "${workspacePath}"`,
      checkedOut,
    );
  }
  if (checkedOut.code !== 0) {
    throw new WorkspaceError(
      `the recorded branch "${branch}" could not be checked out in "${workspacePath}": ` +
        `${firstLine(checkedOut.stderr)}. The checkout is still on "${standing.currentBranch}" at ` +
        `${standing.revision}, so nothing was moved or lost: resolve what Git refused by hand in ` +
        'the retained workspace, or move the workspace aside',
    );
  }

  const fastForwarded = await runGit(
    ['merge', '--ff-only', '--quiet', standing.revision],
    workspacePath,
    bounds,
  );
  if (fastForwarded.outcome !== 'exited') {
    throw gitFailure(
      `"${branch}" could not be fast-forwarded to ${standing.revision} in "${workspacePath}"`,
      fastForwarded,
    );
  }
  if (fastForwarded.code !== 0) {
    throw new WorkspaceError(
      `"${branch}" could not be fast-forwarded to ${standing.revision} in "${workspacePath}": ` +
        `${firstLine(fastForwarded.stderr)}. The checkout is on its recorded branch at the tip it ` +
        `had, the commit ${standing.revision} is still on "${standing.currentBranch}", and nothing ` +
        'was reset or discarded: fast-forward the branch by hand when that is the work to keep, or ' +
        'move the workspace aside',
    );
  }
  return { changed: true, from: standing.currentBranch, revision: standing.revision };
}
