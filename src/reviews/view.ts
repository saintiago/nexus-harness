/**
 * The repository view one reviewer turn inspects.
 *
 * The reviewer sees the change the way a person would: a local clone of the
 * ticket's own retained workspace, detached at the exact reviewed head, holding
 * the pull request's base commit so the whole change can be read with ordinary
 * Git commands. It is a snapshot rather than a channel: the clone is made from
 * the local workspace and then loses its remote, so nothing in the view can
 * fetch from or push to anything, and no credential of any kind enters it — the
 * App's private key and the installation token stay with the scan, and the
 * reviewer is given neither.
 *
 * The scan prepares the view before the turn and checks it after: a view that
 * cannot be pinned at the reviewed head, that does not hold the base commit, or
 * that the turn left changed is a problem the scan reports. Nothing is published
 * for it, and no coding turn is started to repair it.
 */
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import { firstLine, listPaths, runGit } from '../workspace/git.js';
import type { GitResult } from '../workspace/git.js';
import { ReviewError } from './contract.js';
import type { ReviewView, ReviewViewSource } from './contract.js';

/**
 * The directory inside one review's evidence directory the view is checked out
 * in. The reviewer runs here; its verdict and logs stay in the parent directory.
 */
export const REVIEW_VIEW_DIRECTORY = 'repo';

/** The clone's remote name while it exists; it is removed before the turn runs. */
const VIEW_REMOTE = 'review-source';

/** A commit GitHub reported: a full object name, never an option or a path. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

/** Runs one Git step of the view, bounded and stoppable like every other step. */
async function viewGit(
  args: readonly string[],
  cwd: string,
  stop: AbortSignal,
): Promise<GitResult> {
  try {
    return await runGit(args, cwd, { stop });
  } catch (cause) {
    throw new ReviewError(
      'inconclusive',
      `Git could not be run for the review's repository view: ${messageOf(cause)}`,
    );
  }
}

/**
 * Prepares the view: clones the retained workspace into the review's evidence
 * directory, detaches the clone from it, checks the reviewed head out, and
 * verifies that the head and the change's base commit are both really there.
 */
export async function prepareReviewView(
  request: {
    readonly dir: string;
    readonly workspacePath: string;
    readonly head: string;
    readonly base: string;
  },
  stop: AbortSignal,
): Promise<ReviewView> {
  if (!COMMIT_PATTERN.test(request.head) || !COMMIT_PATTERN.test(request.base)) {
    throw new ReviewError(
      'inconclusive',
      'the pull request carries no full head and base commit, so no repository view can be pinned ' +
        'to it.',
    );
  }

  const viewPath = path.join(request.dir, REVIEW_VIEW_DIRECTORY);
  const cloned = await viewGit(
    [
      'clone',
      '--quiet',
      '--no-checkout',
      '--local',
      '--no-hardlinks',
      '--origin',
      VIEW_REMOTE,
      '--',
      request.workspacePath,
      viewPath,
    ],
    request.dir,
    stop,
  );
  if (cloned.code !== 0) {
    throw new ReviewError(
      'inconclusive',
      `the ticket's retained workspace "${request.workspacePath}" could not be cloned into a ` +
        `repository view: ${firstLine(cloned.stderr)}`,
    );
  }

  const detached = await viewGit(['remote', 'remove', VIEW_REMOTE], viewPath, stop);
  if (detached.code !== 0) {
    throw new ReviewError(
      'inconclusive',
      `the repository view could not be detached from "${request.workspacePath}": ` +
        `${firstLine(detached.stderr)}`,
    );
  }

  const checkedOut = await viewGit(
    ['checkout', '--quiet', '--detach', request.head],
    viewPath,
    stop,
  );
  if (checkedOut.code !== 0) {
    throw new ReviewError(
      'inconclusive',
      `the repository view could not be checked out at the reviewed head ${request.head}: ` +
        `${firstLine(checkedOut.stderr)}. The retained workspace must hold the commit the pull ` +
        'request head names.',
    );
  }

  const base = await viewGit(
    ['rev-parse', '--verify', '--quiet', `${request.base}^{commit}`],
    viewPath,
    stop,
  );
  if (base.code !== 0) {
    throw new ReviewError(
      'inconclusive',
      `the repository view does not hold the pull request's base commit ${request.base}, so the ` +
        "change cannot be read from it; the ticket's retained workspace predates that commit.",
    );
  }

  const view: ReviewView = { path: viewPath, head: request.head, base: request.base };
  const problem = await reviewViewProblem(view, stop);
  if (problem !== null) {
    throw new ReviewError('inconclusive', problem);
  }
  return view;
}

/**
 * Why the view is no longer a clean snapshot at the head it was pinned at, or
 * `null` when it still is. The head is read back and the working tree is
 * inspected for anything the turn wrote, staged, or committed, including ignored
 * files: scratch output is still a change to a review-only snapshot.
 */
export async function reviewViewProblem(
  view: ReviewView,
  stop: AbortSignal,
): Promise<string | null> {
  try {
    const head = await viewGit(['rev-parse', '--verify', 'HEAD^{commit}'], view.path, stop);
    if (head.code !== 0) {
      return `the repository view "${view.path}" can no longer be read: ${firstLine(head.stderr)}`;
    }
    const at = head.stdout.trim();
    if (at !== view.head) {
      return `the repository view is at ${at}, not at the reviewed head ${view.head}`;
    }

    const status = await viewGit(
      ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--no-renames'],
      view.path,
      stop,
    );
    if (status.code !== 0) {
      return `the state of the repository view "${view.path}" cannot be read: ${firstLine(status.stderr)}`;
    }
    const differing = status.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim() !== '')
      .map((line) => line.slice(3).trim());
    if (differing.length > 0) {
      return `the repository view carries ${String(differing.length)} changed path(s): ${listPaths(differing)}`;
    }
    return null;
  } catch (cause) {
    return `the repository view "${view.path}" could not be checked: ${messageOf(cause)}`;
  }
}

/** The Git-backed view source one review command runs. */
export function reviewViews(): ReviewViewSource {
  return { prepare: prepareReviewView, problem: reviewViewProblem };
}
