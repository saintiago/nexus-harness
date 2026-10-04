import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import { messageOf } from '../../../../result.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import { retainStageFailure } from '../failure.js';
import { readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import type { PreparationStage } from '../artifacts.js';
import { stageRoot, stageWorktree } from '../storage.js';

/**
 * PrepareArea provides one preparation area's project worktree: an evaluated stage area or the
 * idea refinement area. A missing checkout is cloned; an existing checkout of the configured
 * repository continues on its retained area branch. Fresh and interrupted clones resolve the
 * configured base and create the area branch from that revision, regardless of the repository's
 * default branch. Local work on another branch is preserved and reported for attention. Repository
 * conditions return the failed outcome with their reason.
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
    async function fail(reason: string): Promise<'failed'> {
      await retainStageFailure(root, reason);
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
    const branchBase = `task/${selection.taskKey}-${settings.area}`;
    if (
      inspection.value.branch === branchBase ||
      (inspection.value.branch?.startsWith(`${branchBase}-`) ?? false)
    ) {
      // Only this area's branch is retained stage work. A default-branch clone whose initialization
      // was interrupted still needs the configured base and its area branch.
      return 'prepared';
    }
    if (inspection.value.trackedChanges || inspection.value.untrackedChanges) {
      return fail(
        `The unprepared worktree at "${worktree}" has local changes; they are preserved.`,
      );
    }
    const base = await settings.git.fetchRevision(
      worktree,
      'origin',
      settings.repository.mainBranch,
    );
    if (!base.ok) {
      return fail(base.fault.message);
    }
    // Document work happens on a stage branch so the parent can publish a documentation-only pull
    // request without touching the configured main branch.
    return await createAreaBranch(base.value);
  };
}
