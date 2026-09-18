/**
 * Local repository and output-location preflight, run allocation, working-copy
 * preparation, and the final reading of what a working copy differs from its base
 * by. Git is invoked here and nowhere else.
 *
 * Preflight is read-only: it resolves the requested source repository, records
 * its committed `HEAD`, refuses a checkout that is not clean, and refuses an
 * output location that overlaps the source. It never resets, stashes, cleans,
 * checks out, or edits the source, and it allocates nothing, so a rejected
 * preflight leaves no run directory behind.
 *
 * {@link allocateRunDirectory} and {@link prepareWorkspace} are the steps that
 * write. A run gets a generated ID, so no directory name and no branch name is
 * derived from task text; the run directory is created exclusively and filled
 * with a separate local clone of the recorded base. A failure keeps what was
 * created for inspection, and no run directory is ever reused, resumed,
 * overwritten, or deleted. See docs/spec.md §§2, 4.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChangeCategory, ChangeKind, ChangeState, ChangedPath, RunStatus } from './types.js';

/** A source repository or output location that cannot be used for a run. */
export class WorkspaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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

/** A run directory allocated for one invocation, before any work is placed in it. */
export interface RunDirectory {
  /** The output directory this run was allocated under. */
  readonly workDir: string;
  /** Generated run ID: the run's name in logs, reports, and its branch. Never task text. */
  readonly runId: string;
  /** `<workDir>/runs/<runId>`: the evidence this attempt produces. */
  readonly runDir: string;
  /**
   * `<workDir>/workspaces/<runId>`: the clone this run creates, beside its own
   * evidence rather than inside it, so a later attempt can continue it while this
   * attempt's report stays where it was written.
   */
  readonly workspacePath: string;
  /** `<runDir>/logs`: command output and the run timeline. */
  readonly logsDir: string;
}

/** An allocated run directory whose working copy is ready for a task. */
export interface PreparedWorkspace extends RunDirectory {
  /**
   * The workspace's own id: the id of the run that created it, which is also what
   * an issue's pointer label names (docs/implement-workspace-continuation.md).
   */
  readonly workspaceId: string;
  /** Whether this run continues a workspace that already existed. */
  readonly continued: boolean;
  /** Which attempt this is for the workspace, counting this one. */
  readonly attempt: number;
  /** Real repository root the working copy was cloned from. */
  readonly sourceRoot: string;
  /** Recorded base commit: the commit the working copy is checked out at. */
  readonly baseCommit: string;
  /** Dedicated local branch created for this run. */
  readonly branch: string;
}

/** One attempt recorded against a workspace. */
export interface WorkspaceAttempt {
  readonly runId: string;
  readonly outcome: RunStatus;
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

/**
 * Run IDs are generated names. Task text is never an input to one, and a value
 * that could be read as a path, an option, or shell text is refused rather than
 * rewritten into something that merely looks safe.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Prefix of the dedicated branch created inside each working copy. */
const RUN_BRANCH_PREFIX = 'harness/';

/** Name of the remote a plain clone would keep pointing back at the source. */
const RUN_REMOTE_NAME = 'source';

/** How many generated run IDs are tried before allocation gives up. */
const MAX_RUN_ID_ATTEMPTS = 5;

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

/** One `git status --porcelain` entry: the two columns Git reported for one path. */
interface StatusEntry {
  /** Index column: what the staged content is, or `' '` when nothing is staged. */
  readonly index: string;
  /** Worktree column: what the checked-out file is, or `' '` when it matches the index. */
  readonly worktree: string;
  readonly path: string;
}

/**
 * Splits `git status --porcelain -z` output into its entries: `XY path`, each
 * field NUL-terminated. Ignored paths are dropped — they are not part of a
 * checkout's state — and a trailing empty field is skipped.
 */
function statusEntries(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const field of output.split('\0')) {
    if (field.length < 4) {
      continue; // the trailing empty field
    }
    if (field.startsWith('!!')) {
      continue; // ignored paths never make a checkout dirty
    }
    entries.push({ index: field.charAt(0), worktree: field.charAt(1), path: field.slice(3) });
  }
  return entries;
}

/** Parses `git status --porcelain -z`: NUL-separated `XY path` entries. */
function parseStatus(output: string): WorkingTreeState {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const entry of statusEntries(output)) {
    if (entry.index === '?' && entry.worktree === '?') {
      untracked.push(entry.path);
      continue;
    }
    if (entry.index !== ' ') {
      staged.push(entry.path);
    }
    if (entry.worktree !== ' ') {
      unstaged.push(entry.path);
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

/** A fresh run ID: a UTC timestamp plus random bits. Task text is never an input. */
function newRunId(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `run-${stamp}-${randomBytes(4).toString('hex')}`;
}

/** A generated run ID, or an explanation of what a run ID may be. */
function assertUsableRunId(runId: string): void {
  if (RUN_ID_PATTERN.test(runId)) {
    return;
  }
  throw new WorkspaceError(
    [
      `"${runId}" is not a usable run ID.`,
      'A run ID is a generated name of letters, digits, "-", and "_". Task IDs stay labels: they never',
      'name a directory, a branch, or an argument, so they cannot decide where a run writes.',
    ].join('\n'),
  );
}

/**
 * The run directory of a failure. Allocation and preparation keep whatever they
 * created: an incomplete run is never resumed, reused, overwritten, or removed
 * on its own, and the message says where the surviving directory is.
 */
function incompleteRunError(run: RunDirectory, problem: string, cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    [
      `preparing run "${run.runId}" failed: ${problem}`,
      `The incomplete run directory was kept for inspection: "${run.runDir}"`,
      'Nothing in it was overwritten or removed.',
    ].join('\n'),
    { cause },
  );
}

/** Where one attempt's evidence lives: `<workDir>/runs/<runId>`. */
export function runDirPathFor(workDir: string, runId: string): string {
  return path.join(path.resolve(workDir), 'runs', runId);
}

/** Where one workspace lives: `<workDir>/workspaces/<workspaceId>`. */
export function workspacePathFor(workDir: string, workspaceId: string): string {
  return path.join(path.resolve(workDir), 'workspaces', workspaceId);
}

/**
 * Allocates `<workDir>/runs/<runId>`, `<workDir>/workspaces/<runId>`, and
 * `<runDir>/logs`. The run ID is generated, so no part of the layout comes from
 * task text, and both directories named after it are created exclusively: an
 * existing run directory or workspace is never reused, resumed, or overwritten,
 * and a different ID is generated instead. Allocation itself clones nothing.
 *
 * The workspace sits beside the evidence rather than inside it, so a later
 * attempt can continue it once there is a reason to
 * (docs/implement-workspace-continuation.md); this run's own report and logs stay
 * where they were written either way.
 */
export async function allocateRunDirectory(
  workDir: string,
  generateRunId: () => string = newRunId,
): Promise<RunDirectory> {
  const outputDir = path.resolve(workDir);
  const runsRoot = path.join(outputDir, 'runs');
  const workspacesRoot = path.join(outputDir, 'workspaces');
  let attempted = outputDir;

  for (let attempt = 1; attempt <= MAX_RUN_ID_ATTEMPTS; attempt += 1) {
    const runId = generateRunId();
    assertUsableRunId(runId);

    const runDir = path.join(runsRoot, runId);
    const workspacePath = path.join(workspacesRoot, runId);
    const logsDir = path.join(runDir, 'logs');
    attempted = runDir;

    try {
      await mkdir(runsRoot, { recursive: true });
      await mkdir(workspacesRoot, { recursive: true });
    } catch (cause) {
      throw new WorkspaceError(
        `the output directory "${outputDir}" cannot be created: ${messageOf(cause)}`,
      );
    }

    try {
      // The workspace first: a name that is already taken leaves nothing behind.
      await mkdir(workspacePath);
      await mkdir(runDir);
    } catch (cause) {
      // The only expected failure is a name that is already taken, which is
      // another run's directory or its workspace: leave it alone and try a
      // different ID. A name taken between the two calls above leaves one empty
      // directory behind, which is never reused either.
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw new WorkspaceError(
        `the run directory "${runDir}" cannot be created: ${messageOf(cause)}`,
      );
    }

    const run: RunDirectory = { workDir: outputDir, runId, runDir, workspacePath, logsDir };
    try {
      await mkdir(logsDir);
    } catch (cause) {
      throw incompleteRunError(
        run,
        `its directory layout could not be created: ${messageOf(cause)}`,
      );
    }
    return run;
  }

  throw new WorkspaceError(
    [
      `no free run directory could be allocated under "${outputDir}": "${attempted}" already exists.`,
      `Existing run directories are never reused, resumed, or overwritten. Remove the ones you no`,
      'longer need, or choose a different workDir.',
    ].join('\n'),
  );
}

/** Refuses a working copy that already holds anything from an earlier attempt. */
async function assertWorkspaceDestinationEmpty(run: RunDirectory): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(run.workspacePath);
  } catch (cause) {
    throw new WorkspaceError(`"${run.workspacePath}" cannot be read: ${messageOf(cause)}`);
  }
  if (entries.length > 0) {
    throw new WorkspaceError(
      [
        `"${run.workspacePath}" already holds work (${listPaths(entries)}).`,
        'A run is never resumed or overwritten in place; allocate a new run directory for a new',
        'attempt. The existing directory is left as it is.',
      ].join('\n'),
    );
  }
}

/**
 * The source must still be at the commit preflight recorded. A repository that
 * moved on is not silently adopted, and not silently ignored either: the run
 * was approved against a base that no longer exists.
 */
async function assertSourceAtRecordedBase(source: SourcePreflight): Promise<void> {
  const head = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], source.sourceRoot);
  const current = head.stdout.trim();
  if (head.code !== 0) {
    throw new WorkspaceError(
      `the current HEAD of "${source.sourceRoot}" cannot be read: ${firstLine(head.stderr)}`,
    );
  }
  if (current !== source.baseCommit) {
    throw new WorkspaceError(
      [
        `"${source.sourceRoot}" has moved since preflight: it is at ${current}, not at the recorded`,
        `base ${source.baseCommit}.`,
        'A run is never rebased onto a commit it did not record; rerun to record the new base.',
      ].join('\n'),
    );
  }
}

/**
 * Clones the committed objects without materializing the source's current HEAD:
 * the recorded base is checked out explicitly afterwards. `--no-hardlinks`
 * keeps the clone a fully separate copy, which also works when the run
 * directory is on a different volume than the source. The remote is removed so
 * that the working copy is a snapshot: it cannot fetch from or push into the
 * source repository.
 */
async function cloneCommittedObjects(run: RunDirectory, source: SourcePreflight): Promise<void> {
  const cloned = await runGit(
    [
      'clone',
      '--quiet',
      '--no-checkout',
      '--no-hardlinks',
      '--origin',
      RUN_REMOTE_NAME,
      '--',
      source.sourceRoot,
      run.workspacePath,
    ],
    run.runDir,
  );
  if (cloned.code !== 0) {
    throw new WorkspaceError(
      `"${source.sourceRoot}" could not be cloned: ${firstLine(cloned.stderr)}`,
    );
  }

  const detached = await runGit(['remote', 'remove', RUN_REMOTE_NAME], run.workspacePath);
  if (detached.code !== 0) {
    throw new WorkspaceError(
      `the clone could not be detached from "${source.sourceRoot}": ${firstLine(detached.stderr)}`,
    );
  }
}

/** Creates the run's own local branch at the recorded base. */
async function createRunBranch(
  run: RunDirectory,
  branch: string,
  baseCommit: string,
): Promise<void> {
  // The commit is a validated SHA, so it needs no `--`: a `--` here would make
  // it a path instead.
  const checkedOut = await runGit(
    ['checkout', '--quiet', '-b', branch, baseCommit],
    run.workspacePath,
  );
  if (checkedOut.code !== 0) {
    throw new WorkspaceError(
      `the branch "${branch}" could not be created at ${baseCommit}: ${firstLine(checkedOut.stderr)}`,
    );
  }
}

/**
 * Checks what the working copy actually contains before a task is allowed to use
 * it. A checkout can exit successfully while failing to write the files it is
 * supposed to write (an incomplete source object store does that), so the base,
 * the branch, and the checked-out contents are all verified rather than
 * assumed.
 */
async function assertRecordedWorkspace(
  run: RunDirectory,
  source: SourcePreflight,
  branch: string,
): Promise<void> {
  const head = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], run.workspacePath);
  const commit = head.stdout.trim();
  if (head.code !== 0 || commit !== source.baseCommit) {
    throw new WorkspaceError(
      `the working copy is at ${commit === '' ? 'no commit' : commit}, not at the recorded base ${source.baseCommit}`,
    );
  }

  const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], run.workspacePath);
  const current = symbolic.stdout.trim();
  if (symbolic.code !== 0 || current !== branch) {
    throw new WorkspaceError(
      `the working copy is on ${current === '' ? 'no branch' : `"${current}"`}, not on its dedicated branch "${branch}"`,
    );
  }

  const status = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=no', '--no-renames'],
    run.workspacePath,
  );
  if (status.code !== 0) {
    throw new WorkspaceError(
      `the state of "${run.workspacePath}" cannot be read: ${firstLine(status.stderr)}`,
    );
  }

  const state = parseStatus(status.stdout);
  const differing = [...state.staged, ...state.unstaged, ...state.untracked];
  if (differing.length > 0) {
    throw new WorkspaceError(
      [
        `the working copy does not reproduce the recorded base ${source.baseCommit}:`,
        `  - ${differing.length} ${differing.length === 1 ? 'path differs' : 'paths differ'}: ${listPaths(differing)}`,
      ].join('\n'),
    );
  }
}

/** How the run's task deadline and stop request bound preparation. */
export interface PrepareWorkspaceBounds {
  /**
   * The run's task deadline, in epoch milliseconds: established once, before
   * preparation, and carried through every phase afterwards. Preparation spends
   * that one budget; it is never given a limit of its own.
   */
  readonly deadlineMs: number;
  /**
   * The clock the deadline was taken from, and the one the remaining task time
   * is read with — the same clock the run itself uses.
   */
  readonly now: () => Date;
  /**
   * The run's own stop request, when it has one: the caller's request is read
   * between preparation steps exactly as the deadline is, and no further step is
   * started once it has arrived. A step already running is left to finish, for
   * the reason below, and omitted bounds mean nothing can stop preparation
   * early but the deadline.
   */
  readonly stop?: AbortSignal;
}

/**
 * Fills an allocated run directory with a separate local clone of the recorded
 * base, on a dedicated local branch. Only committed content is inherited:
 * ignored local files stay in the source checkout, and the clone keeps no remote
 * pointing back at it. Every failure leaves the run directory in place and
 * names it, so a partial preparation can be inspected instead of reused.
 *
 * Preparation is bounded by the run's remaining task time, and by the run's own
 * stop request when it has one: both are read again before each step, and a step
 * is not started once either has arrived. Git is owned here, so a step that is
 * already running is left to finish rather than killed mid-write — a Git process
 * stopped while it holds a lock can damage the checkout it is writing. The
 * bounded cost of that is one Git command's run time after the deadline or the
 * stop request, which the run's later phases and its report both see.
 */
export async function prepareWorkspace(
  run: RunDirectory,
  source: SourcePreflight,
  bounds: PrepareWorkspaceBounds,
): Promise<PreparedWorkspace> {
  const branch = `${RUN_BRANCH_PREFIX}${run.runId}`;

  /**
   * Why preparation stopped, when it was stopped before it could start a step.
   * The run's own stop request is read first: a caller who stopped the run is
   * told that, rather than told about a deadline in the same window.
   */
  const assertMayStart = (step: string): void => {
    if (bounds.stop?.aborted === true) {
      throw new WorkspaceError(
        [
          `the run was stopped by its caller before ${step}, so preparation stopped there.`,
          'What preparation had already written is kept in the run directory, but it is not a usable ' +
            'working copy and must not be reused.',
        ].join('\n'),
      );
    }
    const overdue = bounds.now().getTime() - bounds.deadlineMs;
    if (overdue <= 0) {
      return;
    }
    throw new WorkspaceError(
      [
        `the run's task deadline passed ${String(overdue)} ms before ${step}, so preparation stopped there.`,
        'What preparation had already written is kept in the run directory, but it is not a usable ' +
          'working copy and must not be reused.',
      ].join('\n'),
    );
  };

  try {
    assertMayStart('the destination check');
    await assertWorkspaceDestinationEmpty(run);
    assertMayStart('reading the source repository');
    await assertSourceAtRecordedBase(source);
    assertMayStart('cloning the committed objects');
    await cloneCommittedObjects(run, source);
    assertMayStart('creating the run branch');
    await createRunBranch(run, branch, source.baseCommit);
    assertMayStart('verifying the working copy');
    await assertRecordedWorkspace(run, source, branch);
  } catch (cause) {
    throw incompleteRunError(run, messageOf(cause), cause);
  }

  // The ledger is written before anything can run in the workspace, so a
  // workspace always has one from the moment it exists: a later attempt resolves
  // it through this file, and a run that dies before its report leaves a
  // workspace that can be continued rather than an orphaned directory.
  await writeWorkspaceState(run.workDir, {
    version: 1,
    workspaceId: run.runId,
    sourceRoot: source.sourceRoot,
    baseCommit: source.baseCommit,
    branch,
    createdAt: new Date().toISOString(),
    attempts: [],
  });

  return {
    ...run,
    workspaceId: run.runId,
    continued: false,
    attempt: 1,
    sourceRoot: source.sourceRoot,
    baseCommit: source.baseCommit,
    branch,
  };
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
async function writeWorkspaceState(workDir: string, state: WorkspaceState): Promise<void> {
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

/**
 * # What a working copy differs from its recorded base by
 *
 * The last thing a run needs from Git: after the coding turns have stopped, a
 * listing of everything they left in the working copy. It is a reading, not a
 * judgement — the harness lists what changed and flags the paths whose change
 * could alter what the checks that decided the run actually did; it does not
 * decide whether a change is correct, and it makes no claim to be tamper-proof
 * (docs/spec.md §5).
 *
 * ## The categories
 *
 * Three categories, read from a path's own names and nothing else — not the
 * file's contents, not what the change does to it:
 *
 * - `tests`: a path with a test directory segment (`test`, `tests`, `__tests__`,
 *   `spec`, `specs`) anywhere in it, or a file name with a `test`/`spec` word in
 *   it (`app.test.ts`, `app_test.go`, `test_helpers.py`, `spec.js`).
 * - `tooling`: a dependency manifest or lockfile (`package.json`, `yarn.lock`,
 *   …), a build or CI definition (`Makefile`, `Dockerfile`, `Jenkinsfile`,
 *   `.github/`, `.circleci/`, …), or an ignore/control file (`.gitignore`,
 *   `.npmrc`, `.dockerignore`, …).
 * - `configuration`: a settings file (`*.config.*`, `tsconfig*.json`, `.env*`,
 *   `*.ini`/`*.toml`/`*.cfg`, `.editorconfig`) or a path inside a `config`,
 *   `configs`, or `conf` directory.
 *
 * The rules are deliberately generous and fixed: flagging an ordinary file costs
 * a reviewer a glance, while missing a weakened test costs the run its meaning,
 * and a category set the target repository could configure would be one more
 * thing the run's own working copy decides. They are not a language-aware
 * analysis: a file is in a category because of what it is called, and a change
 * the harness did not flag is not a change it cleared.
 *
 * ## Both readings, always
 *
 * `git diff <base> HEAD` covers what the coding turns committed, and
 * `git status` covers what they left in the working tree — staged, unstaged, and
 * untracked. Neither alone is enough: a run whose turns committed their work as
 * they went would look empty to `git diff HEAD`, and a run whose turns left
 * everything uncommitted would look empty to a commit comparison. Ignored files
 * are left out of both, because they are not what a run delivers.
 *
 * Reading is all this does. It never adds, removes, or edits a path in the
 * working copy, and it never writes Git's index: `GIT_OPTIONAL_LOCKS` stays off,
 * so the index refresh that `git status` would otherwise perform is skipped.
 */

/** Directory names whose contents are tests, wherever they appear in a path. */
const TEST_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
]);

/** Test-ish file names: `app.test.ts`, `app_test.go`, `test_helpers.py`, `spec.js`. */
const TEST_FILE_PATTERN = /(^|[._-])(test|tests|spec|specs)([._-]|$)/i;

/** Files that decide how a project is built, run, ignored, or shipped. */
const TOOLING_FILE_NAMES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lockb',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Dockerfile',
  'Jenkinsfile',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.dockerignore',
  '.prettierignore',
  '.eslintignore',
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
]);

/** Directories that hold build or CI definitions rather than the project itself. */
const TOOLING_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.github',
  '.circleci',
  '.gitlab',
  '.devcontainer',
]);

/** Configuration file names that carry their setting in the name. */
const CONFIGURATION_FILE_NAMES: ReadonlySet<string> = new Set(['.editorconfig']);

/** `vite.config.ts`, `tsconfig.build.json`, `.env.local`, `setup.cfg`, `Cargo.toml`. */
const CONFIGURATION_NAME_PATTERN =
  /(^|\.)config\.[^./]+$|^tsconfig(\..+)?\.json$|^jsconfig(\..+)?\.json$|^\.env(\..+)?$|\.(ini|toml|cfg)$/i;

/** Directories that hold configuration rather than source. */
const CONFIGURATION_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['config', 'configs', 'conf']);

/** The order a path's states are recorded in, whatever order Git reported them. */
const CHANGE_STATE_ORDER: readonly ChangeState[] = ['committed', 'staged', 'unstaged', 'untracked'];

/**
 * Which kind a path is recorded as when Git reported more than one for it: a
 * path that disappeared is the fact a reviewer must not miss, a path that
 * appeared is the next, and anything else is a change to something that was
 * already there. The rarest readings — a path staged as added and then deleted
 * from the working tree, say — are resolved towards the more alarming kind,
 * because a summary that overstates is corrected by a glance at the diff, while
 * one that understates is not.
 */
const CHANGE_KIND_ORDER: readonly ChangeKind[] = ['deleted', 'added', 'modified'];

/**
 * What one status letter means for a path. `A` and `D` are the two Git states
 * with a kind of their own; everything else — a modification, a type change, an
 * unmerged path, and any letter this harness does not know — is a modification,
 * which is the least specific claim and never hides the path.
 */
function kindOfStatus(letter: string): ChangeKind {
  if (letter === 'A') {
    return 'added';
  }
  return letter === 'D' ? 'deleted' : 'modified';
}

/** One path as one reading reported it, before the readings are combined. */
interface ObservedChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly state: ChangeState;
}

/**
 * Parses `git diff --name-status -z`: one status field and one path field, each
 * NUL-terminated. Renames are turned off when the command runs, so a change is
 * always one field and one path.
 */
function parseNameStatus(output: string): ObservedChange[] {
  const fields = output.split('\0');
  const changes: ObservedChange[] = [];

  for (let position = 0; position + 1 < fields.length; position += 2) {
    const status = fields[position] ?? '';
    const file = fields[position + 1] ?? '';
    if (status === '' || file === '') {
      continue;
    }
    changes.push({ path: file, kind: kindOfStatus(status.charAt(0)), state: 'committed' });
  }

  return changes;
}

/** Parses `git status --porcelain -z` into what each entry says about its path. */
function parseStatusChanges(output: string): ObservedChange[] {
  const changes: ObservedChange[] = [];

  for (const entry of statusEntries(output)) {
    if (entry.index === '?' && entry.worktree === '?') {
      // A file Git does not track at all: it is not in the base, and it is there now.
      changes.push({ path: entry.path, kind: 'added', state: 'untracked' });
      continue;
    }
    if (entry.index !== ' ') {
      changes.push({ path: entry.path, kind: kindOfStatus(entry.index), state: 'staged' });
    }
    if (entry.worktree !== ' ') {
      changes.push({ path: entry.path, kind: kindOfStatus(entry.worktree), state: 'unstaged' });
    }
  }

  return changes;
}

/**
 * Combines the readings of the same path into one entry, or leaves it alone when
 * only one reading saw it. Paths come back in path order, so two runs of the same
 * working copy produce the same list on any host.
 */
function combineChanges(observed: readonly ObservedChange[]): readonly ChangedPath[] {
  const combined = new Map<string, { kind: ChangeKind; states: ChangeState[] }>();

  for (const change of observed) {
    const held = combined.get(change.path);
    if (held === undefined) {
      combined.set(change.path, { kind: change.kind, states: [change.state] });
      continue;
    }
    if (CHANGE_KIND_ORDER.indexOf(change.kind) < CHANGE_KIND_ORDER.indexOf(held.kind)) {
      held.kind = change.kind;
    }
    if (!held.states.includes(change.state)) {
      held.states.push(change.state);
    }
  }

  return [...combined.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([file, held]) => ({
      path: file,
      kind: held.kind,
      states: CHANGE_STATE_ORDER.filter((state) => held.states.includes(state)),
      categories: categoriesOf(file),
    }));
}

/**
 * The categories a changed path belongs to; see the section doc above for the
 * rules. A path can be in more than one, and an ordinary source file is in none.
 */
function categoriesOf(file: string): readonly ChangeCategory[] {
  const segments = file.split('/');
  const name = segments.at(-1) ?? file;
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  const categories: ChangeCategory[] = [];

  if (
    directories.some((segment) => TEST_DIRECTORY_NAMES.has(segment)) ||
    TEST_FILE_PATTERN.test(name)
  ) {
    categories.push('tests');
  }

  if (
    TOOLING_FILE_NAMES.has(name) ||
    /\.lock$/i.test(name) ||
    directories.some((segment) => TOOLING_DIRECTORY_NAMES.has(segment))
  ) {
    categories.push('tooling');
  }

  if (
    CONFIGURATION_FILE_NAMES.has(name) ||
    CONFIGURATION_NAME_PATTERN.test(name) ||
    directories.some((segment) => CONFIGURATION_DIRECTORY_NAMES.has(segment))
  ) {
    categories.push('configuration');
  }

  return categories;
}

/**
 * Every path the retained working copy differs from its recorded base by, and
 * how it differs. See the section doc above for what is read and what is not.
 *
 * A reading that fails is a {@link WorkspaceError} naming the working copy and
 * what Git said: a caller has to be able to tell a comparison that found nothing
 * from one that could not be made, and must never report the second as the first.
 */
export async function inspectWorkspaceChanges(
  workspace: PreparedWorkspace,
): Promise<readonly ChangedPath[]> {
  const committed = await runGit(
    ['diff', '--name-status', '-z', '--no-renames', workspace.baseCommit, 'HEAD'],
    workspace.workspacePath,
  );
  if (committed.code !== 0) {
    throw new WorkspaceError(
      `"${workspace.workspacePath}" could not be compared with its recorded base ${workspace.baseCommit}: ${firstLine(committed.stderr)}`,
    );
  }

  const status = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no', '--no-renames'],
    workspace.workspacePath,
  );
  if (status.code !== 0) {
    throw new WorkspaceError(
      `the state of "${workspace.workspacePath}" could not be read: ${firstLine(status.stderr)}`,
    );
  }

  return combineChanges([
    ...parseNameStatus(committed.stdout),
    ...parseStatusChanges(status.stdout),
  ]);
}
