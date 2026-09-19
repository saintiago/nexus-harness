/**
 * Git invocation for the workspace modules: one command with literal arguments,
 * never through a shell, and the small path helpers built on it.
 *
 * Inherited Git variables are dropped so that a `GIT_DIR`, `GIT_WORK_TREE`, or
 * `GIT_INDEX_FILE` in the caller's environment cannot redirect an inspection at
 * a different repository, and optional locks are off so that merely reading the
 * source never rewrites its index. Git is invoked nowhere else.
 *
 * Every Git invocation is bounded and stoppable, through the same process
 * runner the configured commands use (`process/invocation.ts`): a run's phases
 * give it what is left of the task time and the run's own stop request, and a
 * reading that happens outside a run — a source preflight, a workspace
 * verification before a continuation, the final reading of what a run left
 * behind — gives it {@link GIT_COMMAND_TIMEOUT_MS} and the caller's stop
 * request when there is one. A stalled Git therefore ends at its applicable
 * bound rather than holding the harness, and the result says which bound it was
 * and whether the tree it started was confirmed stopped.
 */
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import type { CommandOutcome, TerminationOutcome } from '../shared/types.js';
import { runInvocation } from '../process/invocation.js';
import { WorkspaceError } from './errors.js';

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
 * The finite bound one Git invocation runs under when no run deadline covers
 * it: a source preflight, a workspace verification before a continuation, or
 * the run's final reading of what its working copy differs from its base by.
 * A run's own phases pass what is left of its task time instead; this bound is
 * for the readings that happen without one, so a stalled Git can never hold the
 * harness indefinitely. It is the same five minutes the delivery step gives its
 * own Git and `gh` commands.
 */
export const GIT_COMMAND_TIMEOUT_MS = 5 * 60_000;

/** How one Git invocation is bounded: a limit, and the run's stop request when there is one. */
export interface GitRunBounds {
  /** The limit, in milliseconds; omitted means {@link GIT_COMMAND_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * Asked to stop the invocation, and everything it started, when the run is
   * stopped by its caller. A request that has already arrived stops the
   * invocation from starting at all.
   */
  readonly stop?: AbortSignal;
}

/** The stop one Git invocation recorded, for a caller that has to report it. */
export interface GitStop {
  readonly termination: TerminationOutcome;
  /** What could not be confirmed about that stop; `null` when it was confirmed. */
  readonly problem: string | null;
}

/** What one Git invocation did, beside the output it wrote. */
export interface GitResult {
  /**
   * Git's exit code, or `-1` when it ended without one. A Git that was stopped
   * is never a success: its outcome says what the stop was, and a code that is
   * not `0` keeps it out of the success range on hosts that report one.
   */
  readonly code: number;
  /** Everything the invocation wrote to standard output. */
  readonly stdout: string;
  /** Everything the invocation wrote to standard error. */
  readonly stderr: string;
  /** How the invocation ended; never `failed-to-launch`, which rejects instead. */
  readonly outcome: Exclude<CommandOutcome, 'failed-to-launch'>;
  /** Terminating signal of an invocation that was killed; `null` otherwise. */
  readonly signal: string | null;
  /** Whether a stop the harness made was confirmed; `null` when none was made. */
  readonly termination: TerminationOutcome | null;
  /** What could not be confirmed about a stop; `null` when there was none. */
  readonly terminationProblem: string | null;
  /** The limit this invocation ran under, in milliseconds. */
  readonly timeoutMs: number;
}

/** The first nonblank line of Git's error output, for a one-line explanation. */
export function firstLine(text: string): string {
  const [line = ''] = text.trim().split('\n');
  return line.trim() === '' ? 'no diagnostic output' : line.trim();
}

/**
 * The environment a Git invocation runs with: inherited Git variables dropped,
 * and optional locks off so a read never rewrites the index. The delivery step
 * starts its own Git commands over this same base, so neither the harness's own
 * inspection nor a delivery command can be redirected at another repository.
 */
export function gitInvocationEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of INHERITED_GIT_VARIABLES) {
    delete environment[name];
  }
  return environment;
}

/**
 * Runs one Git command with literal arguments, bounded by `bounds`. Git is never
 * invoked via a shell, and a Git that cannot be started at all is a rejection
 * naming what to install, exactly as it was before this was bounded.
 */
export async function runGit(
  args: readonly string[],
  cwd: string,
  bounds: GitRunBounds = {},
): Promise<GitResult> {
  let stdout = '';
  let stderr = '';
  const timeoutMs = Math.max(1, Math.floor(bounds.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS));
  const result = await runInvocation({
    command: ['git', ...args],
    cwd,
    timeoutMs,
    env: gitInvocationEnvironment(),
    ...(bounds.stop === undefined ? {} : { stop: bounds.stop }),
    onStdout: (chunk: string) => {
      stdout += chunk;
    },
    onStderr: (chunk: string) => {
      stderr += chunk;
    },
  });

  if (result.outcome === 'failed-to-launch') {
    throw new WorkspaceError(
      `could not run "git": ${result.launchError ?? 'no launch error was recorded'}. ` +
        'Install Git and make it available on PATH.',
    );
  }

  return {
    // A Git killed or stopped before it exited is a failure; -1 keeps it out of
    // the success range, exactly as the code before this change did.
    code: result.exitCode ?? -1,
    stdout,
    stderr,
    outcome: result.outcome,
    signal: result.signal,
    termination: result.termination,
    terminationProblem: result.terminationProblem,
    timeoutMs: result.timeoutMs,
  };
}

/**
 * What one Git step that did not exit `0` has to say for the record: Git's own
 * first error line for an ordinary failure, and — when the harness had to stop
 * the invocation — the bound it was stopped at and whether that stop was
 * confirmed. A stop is never reported as Git's own error, and an unconfirmed
 * stop is never rounded down to a clean one.
 */
export function gitProblem(result: GitResult): string {
  if (result.outcome === 'timed-out') {
    return (
      `it did not finish within the ${String(result.timeoutMs)} ms it was given and was stopped` +
      stopDetail(result)
    );
  }
  if (result.outcome === 'stopped') {
    return `it was stopped because the run was stopped by its caller` + stopDetail(result);
  }
  if (result.outcome === 'signalled') {
    return `it was killed by ${result.signal ?? 'a signal'}`;
  }
  return firstLine(result.stderr);
}

/** What to add about a stop: confirmed, or what could not be confirmed about it. */
function stopDetail(result: GitResult): string {
  if (result.termination === 'confirmed') {
    return ', and everything it started was stopped';
  }
  return (
    ', and that stop could not be confirmed: ' +
    (result.terminationProblem ?? 'no reason was recorded')
  );
}

/** The stop a Git invocation recorded, when the harness stopped it; `null` otherwise. */
export function gitStopOf(result: GitResult): GitStop | null {
  if (result.outcome !== 'timed-out' && result.outcome !== 'stopped') {
    return null;
  }
  return {
    termination: result.termination ?? 'unconfirmed',
    problem: result.terminationProblem,
  };
}

/**
 * The failure of one Git step: what was being done, and why it did not finish,
 * with the stop attached when the harness stopped it — so a caller that reports
 * why a run ended can carry an unconfirmed stop instead of rounding it down.
 */
export function gitFailure(describe: string, result: GitResult): WorkspaceError {
  return new WorkspaceError(`${describe}: ${gitProblem(result)}`, { stop: gitStopOf(result) });
}

/**
 * The identity a target working copy commits with: repository-local settings
 * only, so a coding turn can make ordinary local commits without an ambient Git
 * identity and without any global or system Git setting being written. Commit
 * signing is turned off explicitly: a workspace commit must not depend on a
 * signing key the machine may not have, and a configured signer must not stop
 * the turn.
 */
export const WORKSPACE_IDENTITY: readonly (readonly [string, string])[] = [
  ['user.name', 'Nexus Agent'],
  ['user.email', 'nexus@local'],
  ['commit.gpgsign', 'false'],
];

/**
 * Configures the identity a working copy commits with, before any check or
 * coding turn runs in it. The settings are written with `--local`, into that
 * clone's own `.git/config`; the caller's Git configuration is never touched. A
 * setting that cannot be written is a {@link WorkspaceError} naming the working
 * copy and the setting, so an attempt never runs a coding turn with an unknown
 * commit identity.
 */
export async function configureWorkspaceIdentity(
  workspacePath: string,
  bounds: GitRunBounds = {},
): Promise<void> {
  for (const [key, value] of WORKSPACE_IDENTITY) {
    const result = await runGit(['config', '--local', key, value], workspacePath, bounds);
    if (result.code !== 0) {
      throw gitFailure(
        `the working copy's local Git setting "${key}" could not be set in "${workspacePath}"`,
        result,
      );
    }
  }
}

/**
 * Resolves a path to its canonical form, following symlinks and junctions. The
 * trailing segments may not exist yet (a run directory under an existing
 * `workDir`): the closest existing ancestor is resolved and the remaining names
 * are appended, so an aliased parent cannot hide an overlap.
 */
export function canonicalPath(target: string): string {
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
export function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '') {
    return true;
  }
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** `"a.txt", "b.txt" and 1 more` */
export function listPaths(paths: readonly string[]): string {
  const shown = paths
    .slice(0, MAX_LISTED_PATHS)
    .map((file) => `"${file}"`)
    .join(', ');
  const remaining = paths.length - MAX_LISTED_PATHS;
  return remaining > 0 ? `${shown} and ${remaining} more` : shown;
}

export function assertExistingDirectory(target: string): void {
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
