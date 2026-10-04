import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import { messageOf } from '../../../../result.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import { readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import type { PreparationStage } from '../artifacts.js';
import { stageRoot, stageWorktree } from '../storage.js';

/**
 * PrepareArea provides one preparation area's project worktree: an evaluated stage area or the
 * idea refinement area. A missing checkout is cloned; an existing checkout of the configured
 * repository is refreshed on its clean main branch, while a retained branch or uncommitted work is
 * kept for the roles to inspect. A clean main checkout continues on an area branch so the parent
 * can publish document work without touching main. Repository conditions return the failed outcome
 * with their reason.
 */

/** The area one preparation worktree belongs to. */
export type PreparationArea = PreparationStage | 'refinement';

export type PrepareAreaSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  readonly area: PreparationArea;
  /** The configured repository source the stage worktree is prepared from. */
  readonly repository: {
    readonly source: string;
    readonly mainBranch: string;
  };
  readonly git: GitAdapter;
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

/** Create PrepareStage over the configured repository and stages area. */
export function createPrepareArea(settings: PrepareAreaSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root =
      settings.area === 'refinement'
        ? path.join(selection.workspace.root, 'refinement')
        : stageRoot(selection.workspace.root, settings.area);
    const worktree =
      settings.area === 'refinement'
        ? path.join(selection.workspace.root, 'refinement', 'worktree')
        : stageWorktree(selection.workspace.root, settings.area);

    /** Report a repository condition that prevents readiness. */
    function fail(reason: string): 'failed' {
      settings.publish({ source: 'prepare-stage', type: 'failed', data: { reason } });
      return 'failed';
    }

    /**
     * Create the area branch from one exact base revision, skipping branch names the configured
     * repository already publishes. The remote-head probe uses the configured source: the Nexus
     * process directory is not necessarily a checkout of this repository, so a bare remote name
     * would probe the wrong origin.
     */
    async function createAreaBranch(baseRevision: string): Promise<string> {
      const branchBase = `task/${selection.taskKey}-${settings.area}`;
      for (let suffix = 1; ; suffix += 1) {
        const branch = suffix === 1 ? branchBase : `${branchBase}-${suffix}`;
        const existing = await settings.git.readRemoteBranchHead(
          settings.repository.source,
          branch,
        );
        if (!existing.ok) {
          return fail(existing.fault.message);
        }
        if (existing.value !== null) {
          continue;
        }
        const created = await settings.git.createBranch(worktree, branch, baseRevision);
        return created.ok ? 'prepared' : fail(created.fault.message);
      }
    }

    await mkdir(root, { recursive: true });
    if (!(await isDirectory(worktree))) {
      const cloned = await settings.git.cloneRepository(settings.repository.source, worktree);
      if (!cloned.ok) {
        return fail(cloned.fault.message);
      }
      if (cloned.value.remoteUrl !== settings.repository.source) {
        return fail(
          `The prepared worktree belongs to "${cloned.value.remoteUrl ?? 'no remote'}", not to ` +
            `"${settings.repository.source}".`,
        );
      }
      if (cloned.value.branch !== settings.repository.mainBranch) {
        return fail(
          `The cloned worktree at "${worktree}" is on branch ` +
            `"${cloned.value.branch ?? 'no branch'}", not the configured base ` +
            `"${settings.repository.mainBranch}".`,
        );
      }
      if (cloned.value.headRevision === null) {
        return fail(`The cloned worktree at "${worktree}" has no revision to branch from.`);
      }
      // A fresh clone is the configured base already; the area branch is created on it exactly as
      // on a refreshed checkout, so preparation never publishes from the base branch.
      return await createAreaBranch(cloned.value.headRevision);
    }

    const inspection = await settings.git.inspectRepository(worktree);
    if (!inspection.ok) {
      return fail(inspection.fault.message);
    }
    if (inspection.value.remoteUrl !== settings.repository.source) {
      return fail(
        `The worktree at "${worktree}" belongs to ` +
          `"${inspection.value.remoteUrl ?? 'no remote'}", not to "${settings.repository.source}".`,
      );
    }
    if (
      inspection.value.branch !== settings.repository.mainBranch ||
      inspection.value.trackedChanges ||
      inspection.value.untrackedChanges
    ) {
      // The stage roles' retained work is kept as it is; only a clean main checkout is refreshed.
      return 'prepared';
    }
    const pulled = await settings.git.pullBranch(
      worktree,
      'origin',
      settings.repository.mainBranch,
    );
    if (!pulled.ok) {
      return fail(pulled.fault.message);
    }
    if (pulled.value.headRevision === null) {
      return fail(`The stage worktree at "${worktree}" has no revision after refreshing main.`);
    }
    // Document work happens on a stage branch so the parent can publish a documentation-only pull
    // request without touching the configured main branch.
    return await createAreaBranch(pulled.value.headRevision);
  };
}
