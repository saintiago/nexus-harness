import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import { messageOf } from '../../../../result.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import { retainStageFailure } from '../failure.js';
import { readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import { preparationStages, type PreparationWorkspace } from '../artifacts.js';
import {
  preparationWorktree,
  readPreparationWorkspace,
  stageRoot,
  writePreparationWorkspace,
} from '../storage.js';

/**
 * PrepareStage creates or reuses the preparation issue's one shared checkout and branch. Every
 * stage author and evaluator edits that checkout; the stage areas keep only artifacts. A retained
 * repository record is validated against the actual checkout, and a missing, divergent or
 * legacy per-stage layout requests attention with its identity instead of silently cloning,
 * resetting or selecting another branch. Idea refinement keeps its separate repository.
 */

export type PrepareStageSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured repository source and the base branch preparation starts from. */
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

/** A legacy per-stage checkout that a new shared preparation must not silently supersede. */
async function legacyCheckout(issueRoot: string): Promise<string | null> {
  for (const stage of preparationStages) {
    const legacy = path.join(stageRoot(issueRoot, stage), 'worktree');
    if (await isDirectory(legacy)) {
      return legacy;
    }
  }
  return null;
}

/** Create PrepareStage over the configured repository: one shared preparation checkout. */
export function createPrepareStage(settings: PrepareStageSettings): BoundAction {
  return async (input?: unknown) => {
    const stage =
      typeof input === 'object' && input !== null
        ? preparationStages.find(
            (candidate) => candidate === (input as { readonly stage?: unknown }).stage,
          )
        : undefined;
    if (stage === undefined) {
      throw new Error(
        `The preparation workflow supplied PrepareStage the unknown stage ` +
          `${JSON.stringify(typeof input === 'object' && input !== null ? (input as { stage?: unknown }).stage : undefined)}.`,
      );
    }
    const invokedStage = stage;
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const issueRoot = selection.workspace.root;

    /** Report a repository condition that prevents readiness. */
    async function fail(reason: string): Promise<'failed'> {
      await retainStageFailure(stageRoot(issueRoot, invokedStage), reason);
      settings.publish({ source: 'prepare-stage', type: 'failed', data: { reason } });
      return 'failed';
    }

    const retained = await readPreparationWorkspace(issueRoot);
    if (retained !== null) {
      // The retained record is authoritative: validate the actual checkout against it instead of
      // adopting another repository, branch or checkout.
      if (retained.repository !== settings.repository.source) {
        return await fail(
          `The preparation workspace retains repository "${retained.repository}", not the ` +
            `configured "${settings.repository.source}"; reconciliation is required.`,
        );
      }
      const worktree = preparationWorktree(retained.repositoryWorkspace.root);
      if (!(await isDirectory(worktree))) {
        return await fail(
          `The retained preparation checkout "${worktree}" is missing; its committed work is ` +
            'preserved and reconciliation is required instead of cloning a replacement.',
        );
      }
      const inspection = await settings.git.inspectRepository(worktree);
      if (!inspection.ok) {
        return await fail(inspection.fault.message);
      }
      if (inspection.value.remoteUrl !== retained.repository) {
        return await fail(
          `The preparation checkout at "${worktree}" belongs to ` +
            `"${inspection.value.remoteUrl ?? 'no remote'}", not to "${retained.repository}"; ` +
            'reconciliation is required.',
        );
      }
      if (inspection.value.branch !== retained.branch) {
        return await fail(
          `The preparation checkout is on branch "${inspection.value.branch ?? 'no branch'}", ` +
            `not the retained preparation branch "${retained.branch}"; its history is preserved ` +
            'and reconciliation is required.',
        );
      }
      return 'prepared';
    }

    const worktree = preparationWorktree(issueRoot);
    const legacy = await legacyCheckout(issueRoot);
    if (legacy !== null) {
      return await fail(
        `The workspace retains the legacy per-stage checkout "${legacy}"; explicit ` +
          'reconciliation is required before preparation uses one shared checkout, and no ' +
          'retained revision is discarded.',
      );
    }
    if (!(await isDirectory(worktree))) {
      const cloned = await settings.git.cloneRepository(settings.repository.source, worktree);
      if (!cloned.ok) {
        return await fail(cloned.fault.message);
      }
    }
    const inspection = await settings.git.inspectRepository(worktree);
    if (!inspection.ok) {
      return await fail(inspection.fault.message);
    }
    if (inspection.value.remoteUrl !== settings.repository.source) {
      return await fail(
        `The checkout at "${worktree}" belongs to ` +
          `"${inspection.value.remoteUrl ?? 'no remote'}", not to ` +
          `"${settings.repository.source}"; its work is preserved and reconciliation is required.`,
      );
    }
    // An unused preparation branch name: a discarded attempt's remote branch is never adopted.
    const branchBase = `task/${selection.taskKey}`;
    let branch: string;
    for (let suffix = 1; ; suffix += 1) {
      branch = suffix === 1 ? branchBase : `${branchBase}-${String(suffix)}`;
      const existing = await settings.git.readRemoteBranchHead(settings.repository.source, branch);
      if (!existing.ok) {
        return await fail(existing.fault.message);
      }
      if (existing.value === null) {
        break;
      }
    }
    const workspace: PreparationWorkspace = {
      repository: settings.repository.source,
      repositoryWorkspace: { root: issueRoot },
      branch,
      baseRevision: '',
    };
    if (inspection.value.branch === branch) {
      // An interrupted preparation already created the branch before recording its identity; its
      // head is still the base revision it was created from.
      if (inspection.value.headRevision === null) {
        return await fail(`The preparation branch "${branch}" has no revision.`);
      }
      await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
      await writePreparationWorkspace(issueRoot, {
        ...workspace,
        baseRevision: inspection.value.headRevision,
      });
      return 'prepared';
    }
    if (inspection.value.trackedChanges || inspection.value.untrackedChanges) {
      return await fail(
        `The checkout at "${worktree}" carries local work that preparation does not adopt; it ` +
          'is preserved and reconciliation is required.',
      );
    }
    const base = await settings.git.fetchRevision(
      worktree,
      'origin',
      settings.repository.mainBranch,
    );
    if (!base.ok) {
      return await fail(base.fault.message);
    }
    if (inspection.value.branch !== settings.repository.mainBranch) {
      const checkedOut = await settings.git.createBranch(
        worktree,
        settings.repository.mainBranch,
        base.value,
      );
      if (!checkedOut.ok) {
        return await fail(checkedOut.fault.message);
      }
    }
    const created = await settings.git.createBranch(worktree, branch, base.value);
    if (!created.ok) {
      return await fail(created.fault.message);
    }
    await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
    await writePreparationWorkspace(issueRoot, { ...workspace, baseRevision: base.value });
    return 'prepared';
  };
}

/**
 * Create PrepareIdeaWorkspace over the refinement area: idea refinement keeps its separate
 * repository and branch, never the preparation checkout.
 */
export function createPrepareRefinement(settings: PrepareStageSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = path.join(selection.workspace.root, 'refinement');
    const worktree = path.join(root, 'worktree');

    /** Report a repository condition that prevents readiness. */
    async function fail(reason: string): Promise<'failed'> {
      await retainStageFailure(root, reason);
      settings.publish({ source: 'prepare-idea-workspace', type: 'failed', data: { reason } });
      return 'failed';
    }

    await mkdir(root, { recursive: true });
    if (!(await isDirectory(worktree))) {
      const cloned = await settings.git.cloneRepository(settings.repository.source, worktree);
      if (!cloned.ok) {
        return await fail(cloned.fault.message);
      }
    }
    const inspection = await settings.git.inspectRepository(worktree);
    if (!inspection.ok) {
      return await fail(inspection.fault.message);
    }
    if (inspection.value.remoteUrl !== settings.repository.source) {
      return await fail(
        `The worktree at "${worktree}" belongs to ` +
          `"${inspection.value.remoteUrl ?? 'no remote'}", not to "${settings.repository.source}".`,
      );
    }
    const branchBase = `task/${selection.taskKey}-refinement`;
    if (
      inspection.value.branch === branchBase ||
      (inspection.value.branch?.startsWith(`${branchBase}-`) ?? false)
    ) {
      return 'prepared';
    }
    if (inspection.value.trackedChanges || inspection.value.untrackedChanges) {
      return await fail(
        `The unprepared refinement worktree at "${worktree}" has local changes; they are preserved.`,
      );
    }
    const base = await settings.git.fetchRevision(
      worktree,
      'origin',
      settings.repository.mainBranch,
    );
    if (!base.ok) {
      return await fail(base.fault.message);
    }
    for (let suffix = 1; ; suffix += 1) {
      const branch = suffix === 1 ? branchBase : `${branchBase}-${String(suffix)}`;
      const existing = await settings.git.readRemoteBranchHead(settings.repository.source, branch);
      if (!existing.ok) {
        return await fail(existing.fault.message);
      }
      if (existing.value !== null) {
        continue;
      }
      const created = await settings.git.createBranch(worktree, branch, base.value);
      return created.ok ? 'prepared' : await fail(created.fault.message);
    }
  };
}

export { type PreparationWorkspace };
