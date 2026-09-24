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
import type { BoundAction, EventPublisher } from '../../index.js';
import { readRecord, readRequiredRecord, writeRecord } from '../records.js';
import { selectionDeclaration, type Selection } from '../select-task/artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
  type PreparedWorkspace,
} from './artifacts.js';

/**
 * PrepareWorkspace creates or reuses the selected task's workspace and prepares its repository for
 * implementation. New work obtains the repository, fast-forwards the configured main branch and
 * starts the task's development branch from that updated main under an unused name. Retained work
 * keeps its recorded repository, branch and comparison base, preserving local commits and
 * uncommitted changes for implementation to inspect.
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

  /** Report a repository condition or completed command that prevents readiness. */
  function fail(reason: string): 'failed' {
    publish({ source: 'prepare-workspace', type: 'failed', data: { reason } });
    return 'failed';
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
      branch: branch.value,
      baseRevision,
    });
  }

  /** Reuse the retained worktree while it still matches its recorded identity. */
  async function reuseAttempt(
    selection: Selection,
    saved: PreparedWorkspace,
    worktree: string,
  ): Promise<Result<PreparedWorkspace>> {
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
    return ok(saved);
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

  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = selection.workspace.root;
    const worktree = path.join(root, 'worktree');
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    await mkdir(path.join(root, 'state', 'preparation'), { recursive: true });

    const recordFile = path.join(root, preparedWorkspaceFile);
    const saved = await readRecord(recordFile, preparedWorkspaceDeclaration);
    const established =
      saved === null
        ? await startAttempt(selection, worktree)
        : await reuseAttempt(selection, saved, worktree);
    if (!established.ok) {
      return fail(established.fault.message);
    }

    const problem = await runPreparation(root, worktree);
    if (problem !== null) {
      return fail(problem);
    }

    await writeRecord(recordFile, established.value);
    return 'prepared';
  };
}
