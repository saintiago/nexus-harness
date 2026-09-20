/**
 * Source readiness between two queue tickets: fetch, verify, fast-forward.
 *
 * The serial queue loop takes its next workspace from the operator's own
 * checkout, so that checkout has to hold the base a new clone may start from.
 * This step answers exactly one question — is the local checkout provably ready
 * for the next workspace? — and it only ever moves the checkout forward:
 *
 * - it must be a normal (non-bare) checkout, on the configured base branch, with
 *   no staged, unstaged, or non-ignored untracked work;
 * - it must have a remote that is the configured delivery repository (or the
 *   URL a caller substituted for it), and that remote is the one fetched from;
 * - the verified merge commit must be in the fetched base branch, and the local
 *   `HEAD` must be an ancestor of it, so the move is a fast-forward;
 * - the move itself is `git merge --ff-only` to that commit.
 *
 * Nothing here resets, forces, stashes, cleans, commits, rebases, or reconciles
 * anything: a checkout this step cannot prove ready is refused with what a
 * person has to fix, and the queue stops before claiming another ticket
 * (docs/WORKFLOW.md §11).
 */
import path from 'node:path';
import { WorkspaceError } from './errors.js';
import { assertExistingDirectory, canonicalPath, firstLine, gitFailure, runGit } from './git.js';
import type { GitRunBounds } from './git.js';
import { assertCleanCheckout } from './preflight.js';

/** What one source-readiness step is asked to prove and to do. */
export interface SourceRefreshRequest {
  /** The operator's checkout the next workspace will be cloned from. */
  readonly repoPath: string;
  /** The base branch the checkout must be on and be fast-forwarded on. */
  readonly baseBranch: string;
  /** The delivery repository, as `owner/name` on github.com. */
  readonly repository: string;
  /** The merge commit a completed ticket was verified at. */
  readonly mergedCommit: string;
  /** How the Git invocations are bounded; the caller passes its stop request. */
  readonly bounds?: GitRunBounds;
}

/**
 * The outward boundary a caller may substitute: the URL the delivery repository
 * is fetched from. Production derives it from `repository`; the self-tests point
 * it at a disposable local repository, the same way delivery substitutes the
 * push URL it would otherwise derive from the same configuration.
 */
export interface SourceRefreshParts {
  readonly fetchUrl?: string;
}

/** The facts one readiness step established, for the queue's own reporting. */
export interface SourceRefreshResult {
  /** Real repository root, with links and short names resolved. */
  readonly sourceRoot: string;
  /** The remote that was fetched; the one that names the expected repository. */
  readonly remote: string;
  /** The commit the base branch was at before the fetch, as `HEAD` reported it. */
  readonly previousHead: string;
  /** The base branch's head as the fetch reported it. */
  readonly fetchedHead: string;
  /** Whether the checkout was moved, or already at the verified commit. */
  readonly moved: boolean;
}

/** The HTTPS URL a delivery repository is pushed to and fetched from. */
export function repositoryUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

/**
 * The `owner/name` a Git remote URL names on github.com, lowercased for
 * comparison, or `null` when the URL is not a github.com repository URL. Every
 * shape Git may hold for the same repository is read: HTTPS, SSH's scp-like
 * form, `ssh://`, and an optional `.git` suffix.
 */
export function githubRepositoryOf(url: string): string | null {
  const value = url.trim().replace(/\/+$/, '');
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^ssh:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    const owner = match?.[1];
    const name = match?.[2];
    if (owner !== undefined && name !== undefined && owner !== '' && name !== '') {
      return `${owner}/${name}`.toLowerCase();
    }
  }
  return null;
}

/** Whether one remote URL is the expected repository, as the caller named it. */
function namesRepository(url: string, expectedUrl: string): boolean {
  if (url.trim() === expectedUrl.trim()) {
    return true;
  }
  const named = githubRepositoryOf(url);
  return named !== null && named === githubRepositoryOf(expectedUrl.trim());
}

/** The real root of the checkout, refused when it is missing or bare. */
async function resolveCheckoutRoot(requested: string, bounds: GitRunBounds): Promise<string> {
  const resolved = path.resolve(requested);
  assertExistingDirectory(resolved);

  const bare = await runGit(['rev-parse', '--is-bare-repository'], resolved, bounds);
  if (bare.outcome !== 'exited') {
    throw gitFailure(`the repository state of "${resolved}" could not be read`, bare);
  }
  if (bare.code !== 0) {
    throw new WorkspaceError(
      `"${resolved}" is not inside a Git repository (${firstLine(bare.stderr)}).\n` +
        'The queue clones its next workspace from this checkout, so it must be one.',
    );
  }
  if (bare.stdout.trim() === 'true') {
    throw new WorkspaceError(
      `"${resolved}" is a bare repository: there is no working checkout to prepare.\n` +
        'Point --repo at the normal checkout of the delivery repository.',
    );
  }

  const top = await runGit(['rev-parse', '--show-toplevel'], resolved, bounds);
  if (top.outcome !== 'exited') {
    throw gitFailure(`the repository root of "${resolved}" could not be read`, top);
  }
  if (top.code !== 0 || top.stdout.trim() === '') {
    throw new WorkspaceError(
      `could not find the repository root of "${resolved}": ${firstLine(top.stderr)}`,
    );
  }
  return canonicalPath(top.stdout.trim());
}

/** The branch name `HEAD` is on, or `null` for a detached, unborn, or unreadable one. */
async function readHeadBranch(sourceRoot: string, bounds: GitRunBounds): Promise<string | null> {
  const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceRoot, bounds);
  if (branch.outcome !== 'exited') {
    throw gitFailure(`the branch "${sourceRoot}" is on could not be read`, branch);
  }
  if (branch.code !== 0) {
    return null;
  }
  const name = branch.stdout.trim();
  return name === '' || name === 'HEAD' ? null : name;
}

/** The one remote whose URL names the expected repository. */
async function findRemote(
  sourceRoot: string,
  repository: string,
  expectedUrl: string,
  bounds: GitRunBounds,
): Promise<string> {
  const listed = await runGit(['remote'], sourceRoot, bounds);
  if (listed.outcome !== 'exited') {
    throw gitFailure(`the remotes of "${sourceRoot}" could not be read`, listed);
  }
  if (listed.code !== 0) {
    throw new WorkspaceError(
      `the remotes of "${sourceRoot}" could not be read: ${firstLine(listed.stderr)}`,
    );
  }
  const names = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name !== '');

  const matches: { readonly name: string; readonly url: string }[] = [];
  for (const name of names) {
    const url = await runGit(['remote', 'get-url', name], sourceRoot, bounds);
    if (url.outcome !== 'exited' || url.code !== 0) {
      continue;
    }
    const value = url.stdout.trim();
    if (value !== '' && namesRepository(value, expectedUrl)) {
      matches.push({ name, url: value });
    }
  }
  const [first] = matches;
  if (first === undefined) {
    throw new WorkspaceError(
      [
        `"${sourceRoot}" has no remote for the delivery repository "${repository}".`,
        names.length === 0 ? 'It has no remotes at all.' : `Its remotes are: ${names.join(', ')}.`,
        `The queue fetches and fast-forwards the configured base branch from "${expectedUrl}", so it`,
        'will not guess which remote is the delivery repository. Add the expected remote, or point',
        'the delivery configuration at the repository this checkout really tracks.',
      ].join('\n'),
    );
  }
  return (matches.find((match) => match.name === 'origin') ?? first).name;
}

/** One reading that must have exited successfully, or the step fails. */
async function read(
  describe: string,
  sourceRoot: string,
  args: readonly string[],
  bounds: GitRunBounds,
): Promise<string> {
  const result = await runGit(args, sourceRoot, bounds);
  if (result.outcome !== 'exited' || result.code !== 0) {
    throw gitFailure(describe, result);
  }
  return result.stdout.trim();
}

/**
 * Answers whether an ancestor relationship holds: `git merge-base --is-ancestor`
 * exits `0` when it does, `1` when it does not, and anything else is a failure
 * rather than an answer.
 */
async function isAncestor(
  describe: string,
  sourceRoot: string,
  ancestor: string,
  descendant: string,
  bounds: GitRunBounds,
): Promise<boolean> {
  const result = await runGit(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    sourceRoot,
    bounds,
  );
  if (result.outcome !== 'exited') {
    throw gitFailure(describe, result);
  }
  if (result.code === 0) {
    return true;
  }
  if (result.code === 1) {
    return false;
  }
  throw gitFailure(describe, result);
}

/**
 * Prepares the checkout the next workspace is cloned from: it must be on the
 * configured base branch, carry no uncommitted or untracked work, and have the
 * expected repository as a remote; then the verified merge commit must be in
 * that remote's base branch, and the local `HEAD` must be an ancestor of it, so
 * the only move this step can make is a fast-forward to it.
 *
 * Everything it reads is bounded and stoppable through the same process runner
 * the rest of the harness uses. A stop is reported as the stop it was, never as
 * Git's own error.
 */
export async function refreshSource(
  request: SourceRefreshRequest,
  parts: SourceRefreshParts = {},
): Promise<SourceRefreshResult> {
  const bounds = request.bounds ?? {};
  const expectedUrl = parts.fetchUrl ?? repositoryUrl(request.repository);
  const sourceRoot = await resolveCheckoutRoot(request.repoPath, bounds);

  const branch = await readHeadBranch(sourceRoot, bounds);
  if (branch !== request.baseBranch) {
    throw new WorkspaceError(
      [
        `"${sourceRoot}" is ${branch === null ? 'not on a branch' : `on "${branch}"`}, not on the`,
        `configured base branch "${request.baseBranch}".`,
        'The next workspace must be cloned from the base branch the delivery step merges into.',
        'Check out that branch by hand and run the queue again; the harness never switches, resets,',
        'or edits the source checkout itself.',
      ].join(' '),
    );
  }

  await assertCleanCheckout(sourceRoot, request.repoPath, bounds);
  const remote = await findRemote(sourceRoot, request.repository, expectedUrl, bounds);

  const previousHead = await read(
    `the commit "${sourceRoot}" is at could not be read`,
    sourceRoot,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    bounds,
  );

  const fetch = await runGit(['fetch', remote, request.baseBranch], sourceRoot, bounds);
  if (fetch.outcome !== 'exited' || fetch.code !== 0) {
    throw gitFailure(
      `fetching "${request.baseBranch}" from "${remote}" in "${sourceRoot}" failed`,
      fetch,
    );
  }
  const fetchedHead = await read(
    `the fetched head of "${request.baseBranch}" could not be read`,
    sourceRoot,
    ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
    bounds,
  );

  const present = await runGit(
    ['rev-parse', '--verify', '--quiet', `${request.mergedCommit}^{commit}`],
    sourceRoot,
    bounds,
  );
  if (present.outcome !== 'exited' || present.code !== 0) {
    throw new WorkspaceError(
      `the verified merge commit "${request.mergedCommit}" is not in "${sourceRoot}" after ` +
        `fetching "${request.baseBranch}" from "${remote}", so the next workspace cannot be shown ` +
        'to start from the completed work. Nothing was changed.',
    );
  }
  const merged = present.stdout.trim();

  const mergeInBranch = await isAncestor(
    `whether "${merged}" is in the fetched base branch could not be read`,
    sourceRoot,
    merged,
    fetchedHead,
    bounds,
  );
  if (!mergeInBranch) {
    throw new WorkspaceError(
      `the verified merge commit "${merged}" is not an ancestor of the fetched head of ` +
        `"${request.baseBranch}" (${fetchedHead}) in "${sourceRoot}". The base branch does not ` +
        'contain the merge this ticket was completed with, so the next workspace would start from ' +
        'work that does not exist. Nothing was changed.',
    );
  }

  const canFastForward = await isAncestor(
    `whether "${sourceRoot}" can be fast-forwarded could not be read`,
    sourceRoot,
    previousHead,
    merged,
    bounds,
  );
  if (!canFastForward) {
    throw new WorkspaceError(
      [
        `"${sourceRoot}" has diverged from the verified merge commit "${merged}": its HEAD`,
        `(${previousHead}) is not an ancestor of it, so fast-forwarding would lose local commits.`,
        'The harness never resets, forces, stashes, discards, or reconciles local changes. Inspect',
        'the checkout by hand, keep or move the work you want, then run the queue again.',
      ].join(' '),
    );
  }

  let moved = false;
  if (previousHead !== merged) {
    const fastForward = await runGit(
      ['merge', '--ff-only', '--no-edit', merged],
      sourceRoot,
      bounds,
    );
    if (fastForward.outcome !== 'exited' || fastForward.code !== 0) {
      throw gitFailure(
        `fast-forwarding "${sourceRoot}" to the verified merge commit "${merged}" failed`,
        fastForward,
      );
    }
    moved = true;
  }

  const head = await read(
    `the commit "${sourceRoot}" ended at could not be read`,
    sourceRoot,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    bounds,
  );
  if (head !== merged) {
    throw new WorkspaceError(
      `"${sourceRoot}" is at ${head} after the fast-forward, not at the verified merge commit ` +
        `"${merged}", so the next workspace cannot be proven ready. Nothing else was changed.`,
    );
  }
  await assertCleanCheckout(sourceRoot, request.repoPath, bounds);

  return { sourceRoot, remote, previousHead, fetchedHead, moved };
}
