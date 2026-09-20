/**
 * Where one attempt's evidence lives, and the clone it works in:
 * `<workDir>/runs/<runId>` and `<workDir>/workspaces/<workspaceId>`.
 *
 * A run gets a generated ID, so no directory name and no branch name is derived
 * from task text. The name of the workspace a run creates may instead be the
 * name its caller prefers — the canonical key of the item the run came from, for
 * example `HARN-23` — and such a name is validated here the way a pointer label
 * is: letters, digits, "-", and "_" only, never a path. A caller with no
 * preference keeps the generated name it always had. Everything is created
 * exclusively: an existing run directory or workspace is never reused, resumed,
 * or overwritten, and a preferred name something else already holds is refused
 * rather than replaced by another name. A failure keeps what was created for
 * inspection, and allocation itself clones nothing.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import { WorkspaceError } from './errors.js';
import type { WorkspaceStepStop } from './errors.js';
import { canonicalPath, isSameOrInside } from './git.js';

/** A run directory allocated for one invocation, before any work is placed in it. */
export interface RunDirectory {
  /** The output directory this run was allocated under. */
  readonly workDir: string;
  /** Generated run ID: the run's name in logs, reports, and its own evidence. Never task text. */
  readonly runId: string;
  /** `<workDir>/runs/<runId>`: the evidence this attempt produces. */
  readonly runDir: string;
  /**
   * The workspace's own id: the name of the directory the clone lives in, and
   * what an issue's pointer label names. A run that creates a workspace uses the
   * name its caller preferred (a Jira ticket key, for example `HARN-23`), or its
   * own generated id when the caller had none; a run that continues a workspace
   * uses the id an existing pointer already names.
   */
  readonly workspaceId: string;
  /**
   * `<workDir>/workspaces/<workspaceId>`: the clone this run works in, beside its
   * own evidence rather than inside it, so a later attempt can continue it while
   * this attempt's report stays where it was written. A run that creates the
   * workspace created this directory; a run that continues one only names it.
   */
  readonly workspacePath: string;
  /** `<runDir>/logs`: command output and the run timeline. */
  readonly logsDir: string;
}
/**
 * Where the workspace of one run comes from: a run either creates the workspace
 * its attempt works in, or it continues one that already exists.
 */
export type WorkspacePlacement =
  | {
      readonly kind: 'create';
      /**
       * The name the caller prefers for the workspace directory, when it has one:
       * the canonical key of the item this run came from, for example `HARN-23`.
       * It is a preference and never a path — a name that cannot name a workspace
       * is not used, and the run's own generated id names the workspace instead —
       * but a usable name that something already holds is refused, and the run
       * never silently gets a different one.
       */
      readonly preferredWorkspaceId?: string;
    }
  | {
      /**
       * This run continues a workspace that already exists: the caller resolved
       * and verified it (`reopenWorkspace`, `src/workspace/reopen.ts`), and
       * allocation names it and creates nothing for it.
       */
      readonly kind: 'reopen';
      readonly workspaceId: string;
    };
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
 * on its own, and the message says where the surviving directory is. A step the
 * harness itself stopped carries its stop — at the run's deadline, or because
 * the run's caller stopped it — so the caller that reports why the run ended can
 * say whether that stop was confirmed.
 */
export function incompleteRunError(
  run: RunDirectory,
  problem: string,
  cause?: unknown,
  stop: WorkspaceStepStop | null = null,
): WorkspaceError {
  return new WorkspaceError(
    [
      `preparing run "${run.runId}" failed: ${problem}`,
      `The incomplete run directory was kept for inspection: "${run.runDir}"`,
      'Nothing in it was overwritten or removed.',
    ].join('\n'),
    { cause, stop },
  );
}

/** Where one attempt's evidence lives: `<workDir>/runs/<runId>`. */
export function runDirPathFor(workDir: string, runId: string): string {
  return path.join(path.resolve(workDir), 'runs', runId);
}

/** `<workDir>/workspaces`: where every workspace and its ledger lives. */
function workspacesRootFor(workDir: string): string {
  return path.join(path.resolve(workDir), 'workspaces');
}

/**
 * Why a workspace id cannot be resolved, or `null` when it can. A workspace id
 * is the id of the run that created the workspace, or the human-readable name
 * that run preferred for it (a Jira ticket key), so it always has the shape of a
 * generated run id. The id reaches the harness through an issue's pointer label,
 * so anything that could be read as a path, an option, or shell text is refused
 * by name instead of being resolved into a location.
 */
export function workspaceIdProblem(workspaceId: string): string | null {
  if (RUN_ID_PATTERN.test(workspaceId)) {
    return null;
  }
  return (
    `"${workspaceId}" is not a usable workspace id: a workspace id is a generated run name, or ` +
    'the key of the item its work came from, in letters, digits, "-", and "_" only, and a pointer ' +
    'label is never read as a path'
  );
}

/**
 * Where one workspace lives: `<workDir>/workspaces/<workspaceId>`. The id is
 * validated first, and the resolved path is then checked to lie inside the
 * workspaces root, so a pointer label can never name a clone — or a ledger —
 * somewhere else on the machine. The check is made on the path's canonical
 * location, with junctions and symbolic links followed: a generated name whose
 * directory is an alias out of the workspaces root is refused, not opened.
 */
export function workspacePathFor(workDir: string, workspaceId: string): string {
  const problem = workspaceIdProblem(workspaceId);
  if (problem !== null) {
    throw new WorkspaceError(problem);
  }
  const root = workspacesRootFor(workDir);
  const resolved = path.join(root, workspaceId);
  const outside = outsideWorkspacesProblem(workDir, resolved);
  if (outside !== null) {
    throw new WorkspaceError(outside);
  }
  return resolved;
}

/**
 * Why `candidate` is not a location this harness will use for a workspace, or
 * `null` when it is. Both `candidate` and `<workDir>/workspaces` are resolved
 * through the filesystem before they are compared, so junctions and symbolic
 * links are followed: a name that lies inside the workspaces root only lexically
 * is not enough, and a `workDir` that is itself reached through an alias is not
 * mistaken for an escape. A path that does not exist yet is judged by where it
 * would be created: its closest existing ancestor is what is resolved. A refusal
 * says which location the name really reaches, because a pointer label is never
 * read as a path and never followed out of the workspaces directory.
 */
export function outsideWorkspacesProblem(workDir: string, candidate: string): string | null {
  const root = workspacesRootFor(workDir);
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = canonicalPath(root);
    canonicalCandidate = canonicalPath(candidate);
  } catch (cause) {
    return `"${candidate}" cannot be resolved: ${messageOf(cause)}`;
  }
  if (isSameOrInside(canonicalRoot, canonicalCandidate)) {
    return null;
  }
  return (
    `"${candidate}" resolves to "${canonicalCandidate}", outside the workspaces directory ` +
    `"${canonicalRoot}", because a junction or symbolic link leads out of it`
  );
}

/**
 * Creates the two directories the layout keeps under the output directory.
 * A failure here is about the output location itself, so it says so.
 */
async function createLayoutRoots(
  outputDir: string,
  runsRoot: string,
  workspacesRoot: string,
): Promise<void> {
  try {
    await mkdir(runsRoot, { recursive: true });
    await mkdir(workspacesRoot, { recursive: true });
  } catch (cause) {
    throw new WorkspaceError(
      `the output directory "${outputDir}" cannot be created: ${messageOf(cause)}`,
    );
  }
}

/**
 * Allocates one run's evidence: `<runsRoot>/<runId>` and its `logs`, under a
 * freshly generated id, and never reusing a name another run already holds.
 *
 * `workspace` is the workspace the run works in, and `null` when the run is the
 * one that names it: then the workspace a fresh attempt creates is named after
 * the run itself, and this call creates that directory too, first, so a name
 * that is already taken leaves nothing behind. A workspace whose name its caller
 * fixed — a ticket key, or a clone an attempt continues — is only named here:
 * the clone exists already, and allocation creates nothing for it.
 */
async function allocateRunEvidence(
  outputDir: string,
  runsRoot: string,
  workspacesRoot: string,
  workspace: { readonly workspaceId: string; readonly workspacePath: string } | null,
  generateRunId: () => string,
): Promise<RunDirectory> {
  let attempted = outputDir;

  for (let attempt = 1; attempt <= MAX_RUN_ID_ATTEMPTS; attempt += 1) {
    const runId = generateRunId();
    assertUsableRunId(runId);

    const workspaceId = workspace?.workspaceId ?? runId;
    const workspacePath = workspace?.workspacePath ?? path.join(workspacesRoot, workspaceId);
    const runDir = path.join(runsRoot, runId);
    const logsDir = path.join(runDir, 'logs');
    attempted = runDir;

    await createLayoutRoots(outputDir, runsRoot, workspacesRoot);

    try {
      // The workspace first, when this run creates one: a name that is already
      // taken leaves nothing behind. A run whose workspace name is fixed creates
      // none for it — the clone is already there.
      if (workspace === null) {
        await mkdir(workspacePath);
      }
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

    const run: RunDirectory = {
      workDir: outputDir,
      runId,
      runDir,
      workspaceId,
      workspacePath,
      logsDir,
    };
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

/**
 * Allocates one attempt's evidence — `<workDir>/runs/<runId>` and its `logs` —
 * and the workspace the attempt works in: `<workDir>/workspaces/<workspaceId>`
 * for a run that creates one, and nothing at all for a run that continues one.
 *
 * A run with no preference is named by its own generated id, exactly as it
 * always was; a run whose caller preferred a name — the canonical key of the
 * item, for example `HARN-23` — creates that directory exclusively, under
 * exactly that name. A name something already holds is refused, never replaced
 * by another name: the harness never overwrites or adopts a workspace, whoever
 * it belongs to. Allocation itself clones nothing.
 *
 * The workspace sits beside the evidence rather than inside it, so a later
 * attempt can continue it once there is a reason to
 * (docs/implement-workspace-continuation.md); this run's own report and logs stay
 * where they were written either way.
 */
export async function allocateRunDirectory(
  workDir: string,
  placement: WorkspacePlacement = { kind: 'create' },
  generateRunId: () => string = newRunId,
): Promise<RunDirectory> {
  const outputDir = path.resolve(workDir);
  const runsRoot = path.join(outputDir, 'runs');
  const workspacesRoot = path.join(outputDir, 'workspaces');

  // A run that continues a workspace creates nothing for it: the clone exists,
  // resolved and verified by the caller, and only this run's evidence is new.
  if (placement.kind === 'reopen') {
    return await allocateRunEvidence(
      outputDir,
      runsRoot,
      workspacesRoot,
      {
        workspaceId: placement.workspaceId,
        workspacePath: workspacePathFor(workDir, placement.workspaceId),
      },
      generateRunId,
    );
  }

  /**
   * The name the caller preferred, when it has a usable one. A preference that
   * cannot name a workspace is not a name and not a path: the run's own
   * generated id names the workspace instead, exactly as it does for a caller
   * that preferred nothing.
   */
  const preferred =
    placement.preferredWorkspaceId !== undefined &&
    workspaceIdProblem(placement.preferredWorkspaceId) === null
      ? placement.preferredWorkspaceId
      : null;
  if (preferred === null) {
    return await allocateRunEvidence(outputDir, runsRoot, workspacesRoot, null, generateRunId);
  }

  // The name is the caller's, so it is created once, before the run's own
  // evidence, and refused — never replaced by a different name — when something
  // already holds it. A conflict leaves nothing of this run behind.
  const workspacePath = path.join(workspacesRoot, preferred);
  await createLayoutRoots(outputDir, runsRoot, workspacesRoot);
  if (await nameIsHeld(workspacePath)) {
    throw preferredNameTakenError(workspacePath);
  }
  try {
    await mkdir(workspacePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      // Taken between the check above and this call: refused all the same.
      throw preferredNameTakenError(workspacePath);
    }
    throw new WorkspaceError(
      `the workspace directory "${workspacePath}" cannot be created: ${messageOf(cause)}`,
    );
  }
  return await allocateRunEvidence(
    outputDir,
    runsRoot,
    workspacesRoot,
    { workspaceId: preferred, workspacePath },
    generateRunId,
  );
}

/** Whether anything — a directory, a file, or a link — exists at one path. */
async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether something already holds a workspace name. Both the directory and the
 * ledger beside it count: the ledger is written beside the clone, and neither is
 * ever overwritten, so a name a run may create has to be free of both.
 */
async function nameIsHeld(workspacePath: string): Promise<boolean> {
  return (await exists(workspacePath)) || (await exists(`${workspacePath}.json`));
}

/**
 * Why a run cannot use the workspace name its caller preferred: something
 * already holds it, and nothing here overwrites or adopts a workspace or quietly
 * renames the run's own.
 */
function preferredNameTakenError(workspacePath: string): WorkspaceError {
  const name = path.basename(workspacePath);
  return new WorkspaceError(
    [
      `this run would name the workspace it creates "${name}", and that name is already held: ` +
        `"${workspacePath}" or the ledger beside it ("${workspacePath}.json") exists.`,
      'The harness never overwrites or adopts an existing workspace, whoever it belongs to, and a ' +
        'name its caller preferred is never quietly replaced by a different one.',
      'Continue that workspace through the pointer label naming it if it holds this work, or move ' +
        'it aside; then run again.',
    ].join('\n'),
  );
}
