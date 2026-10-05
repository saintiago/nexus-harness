import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckoutIdentity, GitAdapter } from '../../../adapters/git.js';
import type {
  ProcessCommand,
  ProcessOutputObserver,
  ProcessResult,
} from '../../../adapters/processes.js';
import type { Command } from '../../../configuration/index.js';
import { fault, messageOf, ok, type Result } from '../../../result.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../index.js';
import { readRecord, readRequiredRecord, writeRecord } from '../records.js';
import { selectionDeclaration, type Selection } from '../select-task/artifacts.js';
import { retainTerminalReason } from '../terminal-reason.js';
import { roundArtifactPath } from '../artifacts.js';
import { completionArtifact, type CompletionOutput } from '../complete-task/artifacts.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import {
  implementationInputDeclaration,
  type ImplementationInput,
} from '../project/implementation-handoff/artifacts.js';
import {
  attemptDeclaration,
  attemptFile,
  preparationFailureDeclaration,
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
  type PreparedWorkspace,
} from './artifacts.js';

/**
 * PrepareWorkspace creates or reuses the selected task's workspace and prepares its repository for
 * implementation. New work obtains the repository, fast-forwards the configured main branch and
 * starts the task's development branch from that updated main under an unused name. Retained work
 * keeps its recorded repository, branch and comparison base, preserving local commits and
 * uncommitted changes for implementation to inspect. The first implementation of an Architecture
 * handoff adopts the preparation issue's recorded checkout, branch and comparison base instead of
 * cloning, and its own issue keeps the attempt, rounds and command logs. Later implementation
 * tickets start from the updated configured base and require every prerequisite's confirmed merge
 * revision to be contained in it.
 *
 * Repository conditions and completed preparation commands produce the failed outcome with a
 * preserved reason; filesystem, process launch and record failures are execution errors.
 */

/** The Processes adapter capability: run one supplied command and report its output and exit. */
export type CommandExecution = (
  command: ProcessCommand,
  onOutput: ProcessOutputObserver,
) => Promise<ProcessResult>;

export type PrepareWorkspaceSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured repository source and the main branch new task branches start from. */
  readonly repository: {
    readonly source: string;
    readonly mainBranch: string;
  };
  /** The configured preparation commands, run in order inside the worktree. */
  readonly preparation: readonly Command[];
  /** The environment preparation commands run with. */
  readonly environment: Readonly<Record<string, string>>;
  /** The configured project identity the stable implementation workspaces live under. */
  readonly project: string;
  /** The stable workspace root under which issue workspaces, and prerequisite evidence, live. */
  readonly workspaceRoot: string;
  readonly git: GitAdapter;
  readonly runCommand: CommandExecution;
  readonly publish: EventPublisher;
};

/** True when the path is an existing directory; a missing path is not an error. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new Error(`Workspace path "${target}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

/** Create PrepareWorkspace over the configured repository, preparation commands and capabilities. */
export function createPrepareWorkspace(settings: PrepareWorkspaceSettings): BoundAction {
  const { git, publish } = settings;
  const { source, mainBranch } = settings.repository;

  /** The worktree path one repository workspace reference resolves to. */
  function worktreeOf(root: string): string {
    return path.join(root, 'worktree');
  }

  /** Report a repository condition or completed command that prevents readiness. */
  async function fail(root: string, reason: string): Promise<'failed'> {
    // The reason is retained before it is stated, so the terminal handoff reconstructs it after a
    // restart of the workflow binding.
    await retainTerminalReason(path.join(root, preparationFailureDeclaration.file), reason);
    publish({ source: 'prepare-workspace', type: 'failed', data: { reason } });
    return 'failed';
  }

  /**
   * The attempt identity this invocation works under: the retained one, or a fresh identity for a
   * new attempt. Writing it before any repository work identifies attempts that never prepare.
   */
  async function retainAttempt(root: string): Promise<void> {
    const file = path.join(root, attemptFile);
    if ((await readRecord(file, attemptDeclaration)) === null) {
      await writeRecord(file, { attemptId: randomUUID() });
    }
  }

  /** An unused task branch name, so a discarded attempt's remote branch is never adopted. */
  async function unusedBranchName(taskKey: string): Promise<Result<string>> {
    const base = `task/${taskKey}`;
    for (let suffix = 1; ; suffix += 1) {
      const branch = suffix === 1 ? base : `${base}-${suffix}`;
      const remote = await git.readRemoteBranchHead(source, branch);
      if (!remote.ok) {
        return fault(remote.fault.message);
      }
      if (remote.value === null) {
        return ok(branch);
      }
    }
  }

  /** Establish a new attempt's identity in the workspace's worktree. */
  async function startAttempt(
    selection: Selection,
    worktree: string,
  ): Promise<Result<PreparedWorkspace>> {
    const existing = await isDirectory(worktree);
    let identity: CheckoutIdentity;
    if (existing) {
      const inspection = await git.inspectRepository(worktree);
      if (!inspection.ok) {
        return fault(inspection.fault.message);
      }
      identity = inspection.value;
    } else {
      const cloned = await git.cloneRepository(source, worktree);
      if (!cloned.ok) {
        return fault(cloned.fault.message);
      }
      identity = cloned.value;
    }
    if (identity.remoteUrl !== source) {
      return fault(
        `The worktree at "${worktree}" belongs to "${identity.remoteUrl ?? 'no remote'}", ` +
          `not to "${source}".`,
      );
    }

    const branch = await unusedBranchName(selection.taskKey);
    if (!branch.ok) {
      return branch;
    }
    if (identity.branch === branch.value) {
      // A previous attempt created this branch before recording its identity. Nothing has been
      // committed to it yet, so its head is still the revision it was created from.
      if (identity.headRevision === null) {
        return fault(`The task branch "${branch.value}" has no revision.`);
      }
      return ok({
        taskKey: selection.taskKey,
        repository: source,
        repositoryWorkspace: { root: selection.workspace.root },
        branch: branch.value,
        baseRevision: identity.headRevision,
      });
    }
    if (existing && identity.branch !== mainBranch) {
      // An existing worktree this workspace did not leave on main or its task branch is not adopted.
      return fault(
        `The worktree at "${worktree}" is on branch "${identity.branch ?? 'no branch'}", ` +
          `not on "${mainBranch}" or "${branch.value}".`,
      );
    }

    let baseRevision: string;
    if (identity.branch === mainBranch) {
      const pulled = await git.pullBranch(worktree, 'origin', mainBranch);
      if (!pulled.ok) {
        return fault(pulled.fault.message);
      }
      if (pulled.value.headRevision === null) {
        return fault(`The main branch "${mainBranch}" has no revision.`);
      }
      baseRevision = pulled.value.headRevision;
    } else {
      // A new clone may check out another default branch. Check out the configured main branch at
      // its latest fetched remote revision, the state a fast-forwarded pull would produce.
      const fetched = await git.fetchRevision(worktree, 'origin', mainBranch);
      if (!fetched.ok) {
        return fault(fetched.fault.message);
      }
      const checkedOut = await git.createBranch(worktree, mainBranch, fetched.value);
      if (!checkedOut.ok) {
        return fault(checkedOut.fault.message);
      }
      baseRevision = fetched.value;
    }

    const created = await git.createBranch(worktree, branch.value, baseRevision);
    if (!created.ok) {
      return fault(created.fault.message);
    }
    return ok({
      taskKey: selection.taskKey,
      repository: source,
      repositoryWorkspace: { root: selection.workspace.root },
      branch: branch.value,
      baseRevision,
    });
  }

  /**
   * Whether the frozen preparation revision is still in the retained branch's history. A rewritten
   * or missing preparation revision cannot be continued; later implementation commits on top of it
   * keep the frozen revision an ancestor.
   */
  async function continuationProblem(
    worktree: string,
    frozenRevision: string,
    headRevision: string,
  ): Promise<string | null> {
    if (frozenRevision === headRevision) {
      return null;
    }
    const ancestor = await git.readMergeBase(worktree, frozenRevision, headRevision);
    if (!ancestor.ok) {
      return ancestor.fault.message;
    }
    if (ancestor.value !== frozenRevision) {
      return (
        `The frozen preparation revision ${frozenRevision} is no longer in the retained branch ` +
        `history (head ${headRevision}); a rewritten preparation history cannot be continued.`
      );
    }
    return null;
  }

  /**
   * Adopt the recorded preparation repository for the first implementation ticket: inspect the
   * actual checkout, confirm its repository and branch identity and validate that the frozen
   * committed preparation revision remains in its history. The checkout is never cloned, renamed,
   * pulled or reset, and the implementation issue keeps its own attempt and artifacts.
   */
  async function continuePreparation(
    selection: Selection,
    continuation: NonNullable<ImplementationInput['continuation']>,
  ): Promise<Result<PreparedWorkspace>> {
    const workspace = continuation.workspace;
    const worktree = worktreeOf(workspace.repositoryWorkspace.root);
    if (!(await isDirectory(worktree))) {
      return fault(
        `The retained preparation checkout at "${worktree}" is missing; the first implementation ` +
          'cannot continue it and never clones a replacement.',
      );
    }
    const inspection = await git.inspectRepository(worktree);
    if (!inspection.ok) {
      return fault(inspection.fault.message);
    }
    if (inspection.value.remoteUrl !== workspace.repository) {
      return fault(
        `The preparation checkout at "${worktree}" belongs to ` +
          `"${inspection.value.remoteUrl ?? 'no remote'}", not to the retained ` +
          `"${workspace.repository}"; reconcile it instead of replacing it.`,
      );
    }
    if (inspection.value.branch !== workspace.branch) {
      return fault(
        `The preparation checkout is on branch "${inspection.value.branch ?? 'no branch'}", not ` +
          `the retained "${workspace.branch}"; reconcile it instead of selecting another branch.`,
      );
    }
    if (inspection.value.headRevision === null) {
      return fault(`The retained preparation branch "${workspace.branch}" has no revision.`);
    }
    const problem = await continuationProblem(
      worktree,
      continuation.headRevision,
      inspection.value.headRevision,
    );
    if (problem !== null) {
      return fault(problem);
    }
    return ok({
      taskKey: selection.taskKey,
      repository: workspace.repository,
      repositoryWorkspace: workspace.repositoryWorkspace,
      branch: workspace.branch,
      baseRevision: workspace.baseRevision,
    });
  }

  /** Reuse the retained worktree while it still matches its recorded identity. */
  async function reuseAttempt(
    selection: Selection,
    saved: PreparedWorkspace,
    input: ImplementationInput | null,
  ): Promise<Result<PreparedWorkspace>> {
    const repositoryRoot = saved.repositoryWorkspace?.root ?? selection.workspace.root;
    const worktree = worktreeOf(repositoryRoot);
    if (saved.taskKey !== selection.taskKey) {
      return fault(`The workspace retains task "${saved.taskKey}", not "${selection.taskKey}".`);
    }
    if (saved.repository !== source) {
      // Project configuration now selects another repository; the retained worktree is not adopted.
      return fault(
        `The workspace retains repository "${saved.repository}", not the configured "${source}".`,
      );
    }
    if (!(await isDirectory(worktree))) {
      return fault(`The prepared worktree at "${worktree}" is missing.`);
    }
    const inspection = await git.inspectRepository(worktree);
    if (!inspection.ok) {
      return fault(inspection.fault.message);
    }
    if (inspection.value.remoteUrl !== saved.repository) {
      return fault(
        `The worktree at "${worktree}" belongs to ` +
          `"${inspection.value.remoteUrl ?? 'no remote'}", not to the retained ` +
          `"${saved.repository}".`,
      );
    }
    if (inspection.value.branch !== saved.branch) {
      return fault(
        `The worktree is on branch "${inspection.value.branch ?? 'no branch'}", not the ` +
          `retained "${saved.branch}".`,
      );
    }
    if (input?.continuation != null) {
      // A retained continuation keeps the donor checkout the implementation input recorded; a
      // different repository, branch or workspace reference is reconciled, never adopted.
      if (
        repositoryRoot !== input.continuation.workspace.repositoryWorkspace.root ||
        saved.repository !== input.continuation.workspace.repository ||
        saved.branch !== input.continuation.workspace.branch
      ) {
        return fault(
          'The retained prepared workspace no longer matches the ticket\u2019s recorded ' +
            'preparation continuation; reconcile it instead of adopting another checkout.',
        );
      }
      if (inspection.value.headRevision === null) {
        return fault(`The retained preparation branch "${saved.branch}" has no revision.`);
      }
      const problem = await continuationProblem(
        worktree,
        input.continuation.headRevision,
        inspection.value.headRevision,
      );
      if (problem !== null) {
        return fault(problem);
      }
    } else if (repositoryRoot !== selection.workspace.root) {
      return fault(
        `The prepared workspace records repository workspace "${repositoryRoot}" while the ` +
          `selected issue owns "${selection.workspace.root}"; reconcile the retained record.`,
      );
    }
    return ok({ ...saved, repositoryWorkspace: { root: repositoryRoot } });
  }

  /** Run the configured preparation commands in order, preserving their output. */
  async function runPreparation(root: string, worktree: string): Promise<string | null> {
    for (const [index, command] of settings.preparation.entries()) {
      const directory = path.join(root, 'state', 'preparation', String(index));
      await mkdir(directory, { recursive: true });
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      const result = await settings.runCommand(
        {
          executable: command.executable,
          args: [...command.args],
          directory: worktree,
          environment: settings.environment,
        },
        (output) => {
          (output.stream === 'stdout' ? stdout : stderr).push(output.chunk);
        },
      );
      await writeFile(path.join(directory, 'stdout.log'), Buffer.concat(stdout));
      await writeFile(path.join(directory, 'stderr.log'), Buffer.concat(stderr));
      if (!result.ok) {
        throw new Error(result.fault.message);
      }
      if (result.value.exitCode !== 0) {
        return (
          `Preparation command "${[command.executable, ...command.args].join(' ')}" failed ` +
          `with exit code ${result.value.exitCode}; its output is in "state/preparation/${index}/".`
        );
      }
    }
    return null;
  }

  /** One prerequisite's confirmed completion evidence, or null when it is not retained. */
  async function prerequisiteCompletion(key: string): Promise<CompletionOutput | null> {
    const workspace = path.join(settings.workspaceRoot, settings.project, key);
    const round = await readRecord(path.join(workspace, currentRoundFile), currentRoundDeclaration);
    if (round === null) {
      return null;
    }
    const completion = await readRecord(
      roundArtifactPath(workspace, round.number, completionArtifact.pathFromArtifactsRoot),
      { file: completionArtifact.pathFromArtifactsRoot, schema: completionArtifact.schema },
    );
    return completion !== null && completion.taskKey === key ? completion : null;
  }

  /**
   * The reason the updated base cannot start one later implementation ticket, or null when every
   * prerequisite's confirmed merge revision is contained in the comparison base. A prerequisite
   * without retained completion evidence, or a base that does not include its merge revision,
   * prevents readiness; inclusion is never manufactured through cherry-picks.
   */
  async function mergedBaseProblem(
    worktree: string,
    prepared: PreparedWorkspace,
    prerequisites: readonly string[],
  ): Promise<string | null> {
    for (const key of prerequisites) {
      const completion = await prerequisiteCompletion(key);
      if (completion === null) {
        return (
          `Prerequisite ${key} retains no confirmed merge/check completion evidence; the later ` +
          'ticket cannot start from an unverified base.'
        );
      }
      const ancestor = await git.readMergeBase(
        worktree,
        completion.mergeRevision,
        prepared.baseRevision,
      );
      if (!ancestor.ok) {
        return ancestor.fault.message;
      }
      if (ancestor.value !== completion.mergeRevision) {
        return (
          `The updated base ${prepared.baseRevision} does not contain prerequisite ${key}'s ` +
          `merged revision ${completion.mergeRevision}; start from a base with the delivered ` +
          'prerequisite work.'
        );
      }
    }
    return null;
  }

  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = selection.workspace.root;
    const worktree = worktreeOf(root);
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    await mkdir(path.join(root, 'state', 'preparation'), { recursive: true });
    await retainAttempt(root);

    // The implementation input, when this ticket was handed off from preparation, names its
    // prerequisites and (for the first planned task) the retained preparation repository to
    // continue. A malformed record is a retained-work condition, not a fresh task.
    const inputFile = path.join(root, implementationInputDeclaration.file);
    let input: ImplementationInput | null;
    try {
      input = await readRecord(inputFile, implementationInputDeclaration);
    } catch (error) {
      return await fail(
        root,
        `The implementation input at "${inputFile}" is unusable: ${messageOf(error)}.`,
      );
    }

    const recordFile = path.join(root, preparedWorkspaceFile);
    const saved = await readRecord(recordFile, preparedWorkspaceDeclaration);
    const established =
      saved === null
        ? input?.continuation != null
          ? await continuePreparation(selection, input.continuation)
          : await startAttempt(selection, worktree)
        : await reuseAttempt(selection, saved, input);
    if (!established.ok) {
      return await fail(root, established.fault.message);
    }

    if (saved === null && input !== null && input.continuation === null) {
      const problem = await mergedBaseProblem(
        worktreeOf(established.value.repositoryWorkspace?.root ?? root),
        established.value,
        input.prerequisites,
      );
      if (problem !== null) {
        return await fail(root, problem);
      }
    }

    const problem = await runPreparation(
      root,
      worktreeOf(established.value.repositoryWorkspace?.root ?? root),
    );
    if (problem !== null) {
      return await fail(root, problem);
    }

    await writeRecord(recordFile, established.value);
    // Close the ready-admission exception only after durable preparation succeeds.
    await writeRecord(settings.selectionFile, { ...selection, initialClaim: false });
    publish(
      actionOutcomeEvent('prepare-workspace', {
        task: selection.taskKey,
        round: null,
        outcome: 'prepared',
        detail: `branch ${established.value.branch}`,
        artifact: { path: recordFile },
      }),
    );
    return 'prepared';
  };
}
