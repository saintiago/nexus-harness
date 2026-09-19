/**
 * Local repository and output-location preflight, and the facts it records.
 *
 * Preflight is read-only: it resolves the requested source repository, records
 * its committed `HEAD`, refuses a checkout that is not clean, and refuses an
 * output location that overlaps the source. It never resets, stashes, cleans,
 * checks out, or edits the source, and it allocates nothing, so a rejected
 * preflight leaves no run directory behind.
 */
import path from 'node:path';
import { WorkspaceError } from './errors.js';
import {
  assertExistingDirectory,
  canonicalPath,
  firstLine,
  isSameOrInside,
  listPaths,
  runGit,
} from './git.js';
import { parseStatus } from './status.js';

/** What the caller asks preflight to check. */
export interface PreflightRequest {
  /** Source repository, already resolved from the invocation directory. */
  readonly repoPath: string;
  /** Output directory for run directories, resolved from the configuration file. */
  readonly workDir: string;
}

/** The facts that preparing a working copy needs, and nothing more. */
export interface SourcePreflight {
  /** Real repository root: symlinks, junctions, and short names resolved. */
  readonly sourceRoot: string;
  /** Committed `HEAD` of the source, the base every run starts from. */
  readonly baseCommit: string;
}
/** Resolves the requested path to the real root of the repository containing it. */
async function findSourceRoot(requested: string): Promise<string> {
  const resolved = path.resolve(requested);
  assertExistingDirectory(resolved);

  const bare = await runGit(['rev-parse', '--is-bare-repository'], resolved);
  if (bare.code !== 0) {
    throw new WorkspaceError(
      `"${resolved}" is not inside a Git repository (${firstLine(bare.stderr)}).\n` +
        'Preflight needs a local repository with a committed baseline.',
    );
  }
  if (bare.stdout.trim() === 'true') {
    throw new WorkspaceError(
      `"${resolved}" is a bare repository: there is no working checkout to clone from.\n` +
        'Point the source at a normal checkout of the repository.',
    );
  }

  const top = await runGit(['rev-parse', '--show-toplevel'], resolved);
  if (top.code !== 0 || top.stdout.trim() === '') {
    throw new WorkspaceError(
      `could not find the repository root of "${resolved}": ${firstLine(top.stderr)}`,
    );
  }
  return canonicalPath(top.stdout.trim());
}

/** The committed `HEAD`, rejected when the repository has no commits yet. */
async function readBaseCommit(sourceRoot: string, requested: string): Promise<string> {
  const head = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], sourceRoot);
  const commit = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new WorkspaceError(
      `"${requested}" has no committed HEAD (${firstLine(head.stderr)}).\n` +
        'An empty repository has no baseline to clone: commit one first.',
    );
  }
  return commit;
}
/** Refuses staged, unstaged, or non-ignored untracked work. Read-only. */
async function assertCleanCheckout(sourceRoot: string, requested: string): Promise<void> {
  const status = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=no', '--no-renames'],
    sourceRoot,
  );
  if (status.code !== 0) {
    throw new WorkspaceError(
      `could not read the working tree state of "${sourceRoot}": ${firstLine(status.stderr)}`,
    );
  }

  const state = parseStatus(status.stdout);
  const kinds: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [state.staged, 'staged change', 'staged changes'],
    [state.unstaged, 'unstaged change', 'unstaged changes'],
    [state.untracked, 'untracked file that is not ignored', 'untracked files that are not ignored'],
  ];

  const problems = kinds
    .filter(([paths]) => paths.length > 0)
    .map(
      ([paths, singular, plural]) =>
        `${paths.length} ${paths.length === 1 ? singular : plural}: ${listPaths(paths)}`,
    );
  if (problems.length === 0) {
    return;
  }

  throw new WorkspaceError(
    [
      `"${requested}" is not a clean checkout, so uncommitted work could be silently omitted:`,
      ...problems.map((problem) => `  - ${problem}`),
      'Commit, discard, or ignore these paths. Preflight never resets, stashes, cleans, or edits',
      'the source.',
    ].join('\n'),
  );
}

/** Refuses an output location equal to, inside, or containing the source. */
function assertSafeOutputLocation(sourceRoot: string, requestedWorkDir: string): void {
  const workDir = canonicalPath(requestedWorkDir);
  const requested = path.resolve(requestedWorkDir);
  const origin = workDir === requested ? '' : ` (resolved from "${requested}")`;

  if (isSameOrInside(sourceRoot, workDir)) {
    throw new WorkspaceError(
      [
        `the output directory "${workDir}"${origin} is the source repository or lies inside it.`,
        `A run would clone "${sourceRoot}" into a directory it also writes to.`,
        'Choose a workDir outside the source repository (docs/WORKFLOW.md §3).',
      ].join('\n'),
    );
  }

  if (isSameOrInside(workDir, sourceRoot)) {
    throw new WorkspaceError(
      [
        `the source repository "${sourceRoot}" lies inside the output directory "${workDir}"${origin}.`,
        'Choose a workDir that does not contain the source checkout.',
      ].join('\n'),
    );
  }
}

/**
 * Validates a source repository and an output directory without allocating a
 * run. Returns the normalized source root and the committed base, or throws a
 * {@link WorkspaceError} explaining what the caller must fix.
 */
export async function preflightSource(request: PreflightRequest): Promise<SourcePreflight> {
  const sourceRoot = await findSourceRoot(request.repoPath);
  const baseCommit = await readBaseCommit(sourceRoot, request.repoPath);
  await assertCleanCheckout(sourceRoot, request.repoPath);
  assertSafeOutputLocation(sourceRoot, request.workDir);
  return { sourceRoot, baseCommit };
}
