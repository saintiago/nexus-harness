/**
 * Where one attempt's evidence lives, and the clone it works in:
 * `<workDir>/runs/<runId>` and `<workDir>/workspaces/<runId>`.
 *
 * A run gets a generated ID, so no directory name and no branch name is derived
 * from task text; the run directory is created exclusively, and an existing run
 * directory or workspace is never reused, resumed, or overwritten. A failure
 * keeps what was created for inspection, and allocation itself clones nothing.
 */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import { WorkspaceError } from './errors.js';

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
/**
 * Run IDs are generated names. Task text is never an input to one, and a value
 * that could be read as a path, an option, or shell text is refused rather than
 * rewritten into something that merely looks safe.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** How many generated run IDs are tried before allocation gives up. */
const MAX_RUN_ID_ATTEMPTS = 5;
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
export function incompleteRunError(
  run: RunDirectory,
  problem: string,
  cause?: unknown,
): WorkspaceError {
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
