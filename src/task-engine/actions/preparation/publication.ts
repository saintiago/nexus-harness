import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../adapters/git.js';
import { preparationStages, type PreparationStage } from './artifacts.js';
import { preparationWorktree, readStagePlan, readStageTerminal, stageRoot } from './storage.js';

/**
 * The retained preparation branch's accepted content: the authoritative documents every accepted
 * or skipped stage retained and the stage-owned source paths that stay available for
 * implementation reuse. All of it lives in the one shared checkout and branch; there is no
 * cross-stage copying.
 */

export type AcceptedDocument = {
  /** The document's path relative to the repository root, as consumers and tickets name it. */
  readonly path: string;
  /** The checkout file the accepted revision lives in. */
  readonly source: string;
  /** The producer's exact revision of the changed document. */
  readonly revision: string | null;
  /** False when the accepted change deletes the path. */
  readonly exists: boolean;
  /** The stage whose evaluated result accepted this revision. */
  readonly stage: PreparationStage;
};

/** The accepted content of every stage that reached a current accepted or skipped decision. */
export async function readAcceptedDocuments(root: string): Promise<
  | {
      readonly kind: 'documents';
      readonly documents: AcceptedDocument[];
      readonly retained: string[];
    }
  | { readonly kind: 'invalid'; readonly reason: string }
> {
  const worktree = preparationWorktree(root);
  const byPath = new Map<string, AcceptedDocument>();
  const retained = new Set<string>();
  for (const stage of preparationStages) {
    const areaRoot = stageRoot(root, stage);
    const stagePlan = await readStagePlan(areaRoot);
    if (stagePlan === null) {
      continue;
    }
    const stageResult = await readStageTerminal(areaRoot);
    if (
      stageResult === null ||
      (stageResult.outcome !== 'accepted' && stageResult.outcome !== 'skipped')
    ) {
      continue;
    }
    for (const value of stageResult.sourcePaths) {
      retained.add(value);
    }
    for (const document of stageResult.documents) {
      const relative = path.relative(worktree, document.path);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return {
          kind: 'invalid',
          reason:
            `The accepted ${stage} document "${document.path}" lies outside the shared ` +
            `preparation checkout "${worktree}"; the handoff cannot use it.`,
        };
      }
      byPath.set(relative, {
        path: relative,
        source: document.path,
        revision: document.revision,
        // A declared document that no file backs is the retained deletion of that path.
        exists: await fileExists(path.join(worktree, relative)),
        stage,
      });
    }
  }
  return {
    kind: 'documents',
    documents: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    retained: [...retained].sort((left, right) => left.localeCompare(right)),
  };
}

/** True when the path currently names a regular file. */
async function fileExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** True when the checkout's current content still equals the accepted revision. */
async function acceptedContentMatches(
  git: GitAdapter,
  worktree: string,
  document: AcceptedDocument,
): Promise<boolean> {
  if (!document.exists) {
    return !(await fileExists(path.join(worktree, document.path)));
  }
  if (document.revision === null) return false;
  const saved = await git.readFileAtRevision(worktree, document.revision, document.path);
  if (!saved.ok) return false;
  try {
    return (await readFile(path.join(worktree, document.path), 'utf8')) === saved.value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Observe the retained preparation branch's contribution against the configured base: the exact
 * accepted documents and stage-owned source paths the branch adds. The accepted content is
 * already committed on that branch, so this verifies the contribution rather than assembling a
 * second copy, and no unrelated path may be published.
 */
export async function prepareDocumentationPublication(settings: {
  readonly root: string;
  readonly baseBranch: string;
  readonly taskKey: string;
  readonly git: GitAdapter;
}) {
  const { root, git } = settings;
  const accepted = await readAcceptedDocuments(root);
  if (accepted.kind === 'invalid') return { kind: 'failed' as const, reason: accepted.reason };
  const documents = accepted.documents;
  if (documents.length === 0) return { kind: 'unchanged' as const };
  const worktree = preparationWorktree(root);
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) return { kind: 'failed' as const, reason: inspection.fault.message };
  const branch = inspection.value.branch;
  const head = inspection.value.headRevision;
  if (branch === null || branch === settings.baseBranch || head === null)
    return {
      kind: 'failed' as const,
      reason:
        'Preparation publication requires a retained preparation branch with a committed head, ' +
        'not the configured base branch.',
    };
  for (const document of documents) {
    if (!(await acceptedContentMatches(git, worktree, document))) {
      return {
        kind: 'failed' as const,
        reason:
          `The accepted document "${document.path}" no longer matches its accepted revision; a ` +
          'current decision is required before publication.',
      };
    }
  }
  const base = await git.fetchRevision(worktree, 'origin', settings.baseBranch);
  if (!base.ok) return { kind: 'failed' as const, reason: base.fault.message };
  const ancestor = await git.readMergeBase(worktree, base.value, head);
  if (!ancestor.ok) return { kind: 'failed' as const, reason: ancestor.fault.message };
  const changed = await git.readChangedPaths(worktree, ancestor.value, head);
  if (!changed.ok) return { kind: 'failed' as const, reason: changed.fault.message };
  const allowed = new Set([...documents.map((document) => document.path), ...accepted.retained]);
  if (changed.value.some((file) => !allowed.has(file)))
    return {
      kind: 'failed' as const,
      reason:
        'The preparation branch contains paths outside the accepted documents and declared ' +
        'stage-owned source paths.',
    };
  // Upstream-only paths do not belong to this branch. Compare its contribution with the current
  // base too, since an accepted change may already have landed independently.
  const current = await git.readChangedPaths(worktree, base.value, head);
  if (!current.ok) return { kind: 'failed' as const, reason: current.fault.message };
  if (!changed.value.some((file) => current.value.includes(file)))
    return {
      kind: 'unchanged' as const,
      documents,
      head,
      branch,
      worktree,
      baseRevision: ancestor.value,
    };
  return {
    kind: 'prepared' as const,
    documents,
    head,
    branch,
    worktree,
    baseRevision: ancestor.value,
  };
}
