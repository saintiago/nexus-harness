import { stat } from 'node:fs/promises';
import path from 'node:path';
import { preparationStages, type PreparationStage } from './artifacts.js';
import { preparationWorktree, readStagePlan, readStageTerminal, stageRoot } from './storage.js';

/**
 * The retained preparation branch's accepted content: the authoritative documents every accepted
 * or skipped stage retained and the stage-owned source paths that stay available for
 * implementation reuse. All of it lives in the one shared checkout and branch; the parent handoff
 * reads the accepted references from here and never assembles or publishes a second copy.
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
