/**
 * Local repository and output-location preflight, run allocation, and
 * working-copy preparation.
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
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

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
  /** Generated run ID: the run's name in logs, reports, and its branch. Never task text. */
  readonly runId: string;
  /** `<workDir>/<runId>`: everything this run produces. */
  readonly runDir: string;
  /** `<runDir>/workspace`: the clone the task is implemented in. */
  readonly workspacePath: string;
  /** `<runDir>/logs`: command output and the run timeline. */
  readonly logsDir: string;
}

/** An allocated run directory whose working copy is ready for a task. */
export interface PreparedWorkspace extends RunDirectory {
  /** Real repository root the working copy was cloned from. */
  readonly sourceRoot: string;
  /** Recorded base commit: the commit the working copy is checked out at. */
  readonly baseCommit: string;
  /** Dedicated local branch created for this run. */
  readonly branch: string;
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

/**
 * Allocates `<workDir>/<runId>`, `<runDir>/workspace`, and `<runDir>/logs`. The
 * run ID is generated, so no part of the layout comes from task text, and the
 * run directory is created exclusively: an existing one is never reused or
 * overwritten, a different ID is generated instead. Allocation itself clones
 * nothing.
 */
export async function allocateRunDirectory(
  workDir: string,
  generateRunId: () => string = newRunId,
): Promise<RunDirectory> {
  const outputDir = path.resolve(workDir);
  let attempted = outputDir;

  for (let attempt = 1; attempt <= MAX_RUN_ID_ATTEMPTS; attempt += 1) {
    const runId = generateRunId();
    assertUsableRunId(runId);

    const runDir = path.join(outputDir, runId);
    const workspacePath = path.join(runDir, 'workspace');
    const logsDir = path.join(runDir, 'logs');
    attempted = runDir;

    try {
      await mkdir(outputDir, { recursive: true });
    } catch (cause) {
      throw new WorkspaceError(
        `the output directory "${outputDir}" cannot be created: ${messageOf(cause)}`,
      );
    }

    try {
      await mkdir(runDir);
    } catch (cause) {
      // The only expected failure is a name that is already taken, which is
      // another run's directory: leave it alone and try a different ID.
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw new WorkspaceError(
        `the run directory "${runDir}" cannot be created: ${messageOf(cause)}`,
      );
    }

    const run: RunDirectory = { runId, runDir, workspacePath, logsDir };
    try {
      await mkdir(workspacePath);
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

/** How the run's task deadline bounds preparation. */
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
}

/**
 * Fills an allocated run directory with a separate local clone of the recorded
 * base, on a dedicated local branch. Only committed content is inherited:
 * ignored local files stay in the source checkout, and the clone keeps no remote
 * pointing back at it. Every failure leaves the run directory in place and
 * names it, so a partial preparation can be inspected instead of reused.
 *
 * Preparation is bounded by the run's remaining task time: the deadline is read
 * again before each step, and a step is not started once it has passed. Git is
 * owned here, so a step that is already running is left to finish rather than
 * killed mid-write — a Git process stopped while it holds a lock can damage the
 * checkout it is writing. The bounded cost of that is one Git command's run time
 * after the deadline, which the run's later phases and its report both see.
 */
export async function prepareWorkspace(
  run: RunDirectory,
  source: SourcePreflight,
  bounds: PrepareWorkspaceBounds,
): Promise<PreparedWorkspace> {
  const branch = `${RUN_BRANCH_PREFIX}${run.runId}`;

  /** Why preparation stopped, when the run's own deadline had passed. */
  const assertTimeLeft = (step: string): void => {
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
    assertTimeLeft('the destination check');
    await assertWorkspaceDestinationEmpty(run);
    assertTimeLeft('reading the source repository');
    await assertSourceAtRecordedBase(source);
    assertTimeLeft('cloning the committed objects');
    await cloneCommittedObjects(run, source);
    assertTimeLeft('creating the run branch');
    await createRunBranch(run, branch, source.baseCommit);
    assertTimeLeft('verifying the working copy');
    await assertRecordedWorkspace(run, source, branch);
  } catch (cause) {
    throw incompleteRunError(run, messageOf(cause), cause);
  }

  return { ...run, sourceRoot: source.sourceRoot, baseCommit: source.baseCommit, branch };
}
