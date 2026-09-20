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
 *
 * The return itself is asked not to write over a local file that only the
 * checkout knows about: the checkout and the fast-forward refuse to overwrite
 * an ignored file, and that refusal stops the run with the path named rather
 * than destroying it. What the two commands did is also read back rather than
 * assumed — they inherit Git configuration and run hooks, and a fast-forward
 * that a branch's `mergeOptions` turns into a squash exits successfully without
 * moving the recorded branch or committing what it staged — so a return that
 * does not end on the recorded branch, at the commit the checkout held, and
 * clean is reported as the failure it is.
 */
import { WorkspaceError } from './errors.js';
import { firstLine, gitFailure, listPaths, runGit } from './git.js';
import type { GitResult, GitRunBounds } from './git.js';
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
 *
 * Both commands are asked not to overwrite an ignored file, and their result is
 * read back before it is reported: Git configuration and hooks are inherited,
 * so what the two commands did is measured — the recorded branch really at the
 * checkout's commit, checked out, and clean — rather than assumed from an exit
 * code. A return that would write over a local file, and one that ends anywhere
 * else, is refused with what was observed and what an operator can do by hand.
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

  // `--no-overwrite-ignore`: Git overwrites an ignored local file by default
  // when a checkout would write at its path, and this harness never destroys a
  // file a checkout only knows about. The refusal that option produces leaves
  // the working copy where it is, so it is reported instead of retried.
  const checkedOut = await runGit(
    ['checkout', '--quiet', '--no-overwrite-ignore', branch],
    workspacePath,
    bounds,
  );
  if (checkedOut.outcome !== 'exited') {
    throw gitFailure(
      `the recorded branch "${branch}" could not be checked out in "${workspacePath}"`,
      checkedOut,
    );
  }
  if (checkedOut.code !== 0) {
    throw new WorkspaceError(
      `the recorded branch "${branch}" could not be checked out in "${workspacePath}": ` +
        `${gitDiagnostic(checkedOut)}. The checkout is still on "${standing.currentBranch}" at ` +
        `${standing.revision}, so nothing was moved and nothing local was written over — an ` +
        'ignored file included, because Git is asked not to overwrite one and the harness never ' +
        `forces it. Finish what Git named by hand in the retained workspace (move, commit, or ` +
        `regenerate it), then continue the work on "${branch}", or move the workspace aside`,
    );
  }

  // `--no-squash`: `branch.<name>.mergeOptions` is inherited configuration, and
  // `--ff-only` does not cancel a configured `--squash`: Git would exit 0 after
  // staging the descendant without moving the recorded branch. `--no-overwrite-ignore`
  // is the same protection the checkout above carries.
  const fastForwarded = await runGit(
    ['merge', '--ff-only', '--no-squash', '--no-overwrite-ignore', '--quiet', standing.revision],
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
        `${gitDiagnostic(fastForwarded)}. The checkout is on its recorded branch at the tip it ` +
        `had, the commit ${standing.revision} is still on "${standing.currentBranch}", and nothing ` +
        'was reset, discarded, or written over — no local file, an ignored one included: ' +
        `fast-forward "${branch}" to ${standing.revision} by hand when that is the work to keep, ` +
        'or move the workspace aside',
    );
  }

  const unsettled = await unsettledReturnProblem(workspacePath, branch, standing, bounds);
  if (unsettled !== null) {
    throw new WorkspaceError(unsettled);
  }
  return { changed: true, from: standing.currentBranch, revision: standing.revision };
}

/**
 * Git's own refusal as one line. A refusal that would write over local files
 * names them on their own lines, so the whole diagnostic is kept — the paths an
 * operator has to deal with are the point of it — rather than its first line.
 */
function gitDiagnostic(result: GitResult): string {
  const lines = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length === 0 ? 'no diagnostic output' : lines.join('; ');
}

/**
 * Why the checkout a return left behind is not what the return promises, or
 * `null` when it is: on the recorded branch, at the commit the checkout held,
 * and clean. The two commands inherit Git configuration and run hooks, so their
 * result is read back rather than assumed — a `branch.<name>.mergeOptions` that
 * squashes, for example, makes `git merge --ff-only` exit successfully after
 * staging the descendant without moving the recorded branch — and a caller
 * about to start a coding turn must not be handed that staged working copy as a
 * returned branch (HARN-35).
 */
async function unsettledReturnProblem(
  workspacePath: string,
  branch: string,
  standing: { readonly currentBranch: string; readonly revision: string },
  bounds: GitRunBounds,
): Promise<string | null> {
  const symbolic = await runGit(
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    workspacePath,
    bounds,
  );
  if (symbolic.outcome !== 'exited') {
    throw gitFailure(`the branch of "${workspacePath}" could not be read`, symbolic);
  }
  const onBranch = symbolic.code === 0 && symbolic.stdout.trim() === branch;
  const head = await readCommit(
    workspacePath,
    'HEAD^{commit}',
    `the commit of "${workspacePath}"`,
    bounds,
  );
  const tip = await readCommit(
    workspacePath,
    `refs/heads/${branch}`,
    `the recorded branch "${branch}" of "${workspacePath}"`,
    bounds,
  );
  const leftovers = await leftoversOf(workspacePath, bounds);
  if (
    onBranch &&
    head === standing.revision &&
    tip === standing.revision &&
    leftovers.length === 0
  ) {
    return null;
  }

  const commit = (revision: string): string =>
    revision === '' ? 'a commit that cannot be read' : revision;
  const where = onBranch
    ? `on its recorded branch at ${commit(head)}`
    : symbolic.code === 0
      ? `on branch "${symbolic.stdout.trim()}" at ${commit(head)}`
      : `on no branch (a detached HEAD) at ${commit(head)}`;
  return (
    `the checkout of "${workspacePath}" was not returned to its recorded branch "${branch}" at ` +
    `${standing.revision}: after the checkout and the fast-forward, it is ${where}, and ` +
    `"${branch}" is at ${commit(tip)}` +
    (leftovers.length === 0 ? '' : `, with uncommitted changes (${listPaths(leftovers)})`) +
    '. Git configuration and hooks are inherited, so what those commands did is read back rather ' +
    'than assumed, and no coding turn is started on a state the harness did not ask for. Nothing ' +
    `was reset, force-updated, or discarded: the commit ${standing.revision} is still on ` +
    `"${standing.currentBranch}". Read the state by hand — "${branch}" fast-forwarded to ` +
    `${standing.revision} and checked out clean — then continue the work, or move the workspace aside`
  );
}
