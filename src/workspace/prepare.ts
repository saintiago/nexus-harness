/**
 * Filling an allocated run directory with a separate local clone of the recorded
 * base, on a dedicated local branch.
 *
 * Only committed content is inherited: ignored local files stay in the source
 * checkout, and the clone keeps no remote pointing back at it. Preparation is
 * bounded by the run's remaining task time and by the run's own stop request;
 * Git is owned here, so a step that is already running is left to finish rather
 * than killed mid-write. Every failure leaves the run directory in place and
 * names it, so a partial preparation can be inspected instead of reused.
 */
import { readdir } from 'node:fs/promises';
import { messageOf } from '../shared/errors.js';
import { WorkspaceError } from './errors.js';
import { firstLine, listPaths, runGit } from './git.js';
import type { SourcePreflight } from './preflight.js';
import { incompleteRunError } from './run-directory.js';
import type { RunDirectory } from './run-directory.js';
import { parseStatus } from './status.js';
import type { WorkspaceSourceItem } from './state.js';
import { writeWorkspaceState } from './state.js';

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
/** Prefix of the dedicated branch created inside each working copy. */
const RUN_BRANCH_PREFIX = 'harness/';

/** Name of the remote a plain clone would keep pointing back at the source. */
const RUN_REMOTE_NAME = 'source';
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
 *
 * `sourceItem` is the external item this workspace is being created for, when
 * the run came from a source: the identity every later pointer label is checked
 * against, so a label on another item, another site, or another repository
 * cannot continue this clone. A run with no source records `null`, and a
 * source-backed continuation refuses such a ledger
 * (docs/implement-workspace-continuation.md).
 */
export async function prepareWorkspace(
  run: RunDirectory,
  source: SourcePreflight,
  bounds: PrepareWorkspaceBounds,
  sourceItem?: WorkspaceSourceItem,
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
    sourceItem: sourceItem ?? null,
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
