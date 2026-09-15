/**
 * Local repository and output-location preflight.
 *
 * Everything in this module is read-only. It resolves the requested source
 * repository, records its committed `HEAD`, refuses a checkout that is not
 * clean, and refuses an output location that overlaps the source. It never
 * resets, stashes, cleans, checks out, or edits the source, and it allocates
 * nothing, so a rejected preflight leaves no run directory behind. Preparing a
 * working copy from the returned base is a later step. See docs/spec.md §§2, 5.
 */

import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** A source repository or output location that cannot be used for a run. */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

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

/**
 * Inherited Git variables are dropped so that a `GIT_DIR`, `GIT_WORK_TREE`, or
 * `GIT_INDEX_FILE` in the caller's environment cannot redirect an inspection at
 * a different repository. Optional locks are off so that merely reading the
 * source never rewrites its index.
 */
const INHERITED_GIT_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];

/** How many offending paths a rejection message lists before counting the rest. */
const MAX_LISTED_PATHS = 3;

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The first nonblank line of Git's error output, for a one-line explanation. */
function firstLine(text: string): string {
  const [line = ''] = text.trim().split('\n');
  return line.trim() === '' ? 'no diagnostic output' : line.trim();
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of INHERITED_GIT_VARIABLES) {
    delete environment[name];
  }
  return environment;
}

/** Runs one Git command with literal arguments. Git is never invoked via a shell. */
function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      env: gitEnvironment(),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (cause) => {
      reject(
        new WorkspaceError(
          `could not run "git": ${messageOf(cause)}. Install Git and make it available on PATH.`,
        ),
      );
    });
    // A signalled Git is a failure; -1 keeps it out of the success range.
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Resolves a path to its canonical form, following symlinks and junctions. The
 * trailing segments may not exist yet (a run directory under an existing
 * `workDir`): the closest existing ancestor is resolved and the remaining names
 * are appended, so an aliased parent cannot hide an overlap.
 */
function canonicalPath(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];

  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) {
        throw new WorkspaceError(`could not resolve "${target}": ${messageOf(cause)}`);
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `child` is `parent` itself or lies inside it. `path.relative` is
 * separator- and case-aware for the host platform, so `repo` and `repo-other`
 * are not mistaken for each other, while a resolved alias still is.
 */
function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '') {
    return true;
  }
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** `"a.txt", "b.txt" and 1 more` */
function listPaths(paths: readonly string[]): string {
  const shown = paths
    .slice(0, MAX_LISTED_PATHS)
    .map((file) => `"${file}"`)
    .join(', ');
  const remaining = paths.length - MAX_LISTED_PATHS;
  return remaining > 0 ? `${shown} and ${remaining} more` : shown;
}

function assertExistingDirectory(target: string): void {
  let stats;
  try {
    stats = statSync(target);
  } catch (cause) {
    throw new WorkspaceError(`"${target}" cannot be read: ${messageOf(cause)}`);
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceError(
      `"${target}" is not a directory. Point the source at a repository checkout.`,
    );
  }
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

interface WorkingTreeState {
  readonly staged: string[];
  readonly unstaged: string[];
  readonly untracked: string[];
}

/** Parses `git status --porcelain -z`: NUL-separated `XY path` entries. */
function parseStatus(output: string): WorkingTreeState {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const entry of output.split('\0')) {
    if (entry.length < 4) {
      continue; // the trailing empty field
    }
    if (entry.startsWith('!!')) {
      continue; // ignored paths never make a checkout dirty
    }
    const file = entry.slice(3);
    if (entry.startsWith('??')) {
      untracked.push(file);
      continue;
    }
    if (entry.charAt(0) !== ' ') {
      staged.push(file);
    }
    if (entry.charAt(1) !== ' ') {
      unstaged.push(file);
    }
  }

  return { staged, unstaged, untracked };
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
