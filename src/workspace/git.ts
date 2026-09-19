/**
 * Git invocation for the workspace modules: one command with literal arguments,
 * never through a shell, and the small path helpers built on it.
 *
 * Inherited Git variables are dropped so that a `GIT_DIR`, `GIT_WORK_TREE`, or
 * `GIT_INDEX_FILE` in the caller's environment cannot redirect an inspection at
 * a different repository, and optional locks are off so that merely reading the
 * source never rewrites its index. Git is invoked nowhere else.
 */
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
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
interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The first nonblank line of Git's error output, for a one-line explanation. */
export function firstLine(text: string): string {
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
export function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
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
export async function configureWorkspaceIdentity(workspacePath: string): Promise<void> {
  for (const [key, value] of WORKSPACE_IDENTITY) {
    const result = await runGit(['config', '--local', key, value], workspacePath);
    if (result.code !== 0) {
      throw new WorkspaceError(
        `the working copy's local Git setting "${key}" could not be set in ` +
          `"${workspacePath}": ${firstLine(result.stderr)}`,
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
