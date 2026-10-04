import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../adapters/git.js';
import { preparationStages, stageResultArtifact, type PreparationStage } from './artifacts.js';
import { readStageArtifact, readStagePlan, stageRoot, stageWorktree } from './storage.js';

/** Preparation's shared accepted-document assembly; all publication uses immutable content. */
export type AcceptedDocument = {
  /** The document's path relative to the repository root, as publication and tickets name it. */
  readonly path: string;
  /** The stage worktree file the accepted revision lives in. */
  readonly source: string;
  /** The producer's exact revision of the changed document, when it observed one. */
  readonly revision: string | null;
  /** The stage whose evaluated result accepted this revision. */
  readonly stage: PreparationStage;
};

export async function readAcceptedDocuments(
  root: string,
): Promise<
  | { readonly kind: 'documents'; readonly documents: AcceptedDocument[] }
  | { readonly kind: 'invalid'; readonly reason: string }
> {
  const byPath = new Map<string, AcceptedDocument>();
  for (const stage of preparationStages) {
    const areaRoot = stageRoot(root, stage);
    const stagePlan = await readStagePlan(areaRoot);
    if (stagePlan === null) {
      continue;
    }
    const stageResult = await readStageArtifact(areaRoot, stagePlan.round, stageResultArtifact);
    if (
      stageResult === null ||
      (stageResult.outcome !== 'accepted' && stageResult.outcome !== 'skipped')
    ) {
      continue;
    }
    const tree = stageWorktree(root, stage);
    for (const document of stageResult.documents) {
      const relative = path.relative(tree, document.path);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return {
          kind: 'invalid',
          reason:
            `The accepted ${stage} document "${document.path}" lies outside the stage ` +
            `worktree "${tree}"; the handoff cannot publish it.`,
        };
      }
      byPath.set(relative, {
        path: relative,
        source: document.path,
        revision: document.revision,
        stage,
      });
    }
  }
  return {
    kind: 'documents',
    documents: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/** Assemble and save the exact documentation revision reviewed by the Architecture child. */
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
  const worktree = stageWorktree(root, 'architecture');
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) return { kind: 'failed' as const, reason: inspection.fault.message };
  const branch = inspection.value.branch;
  if (branch === null || branch === settings.baseBranch)
    return {
      kind: 'failed' as const,
      reason:
        'Documentation publication requires a retained area branch, not the configured base branch.',
    };
  for (const document of documents) {
    if (document.revision === null)
      return {
        kind: 'failed' as const,
        reason: `Accepted document "${document.path}" has no immutable revision.`,
      };
    const content = await git.readFileAtRevision(
      stageWorktree(root, document.stage),
      document.revision,
      document.path,
    );
    if (!content.ok) return { kind: 'failed' as const, reason: content.fault.message };
    const target = path.join(worktree, document.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content.value);
  }
  const committed = await git.commitPaths(
    worktree,
    documents.map((document) => document.path),
    `Publish preparation documents for ${settings.taskKey}`,
  );
  if (!committed.ok) return { kind: 'failed' as const, reason: committed.fault.message };
  const head = committed.value.headRevision;
  if (head === null)
    return {
      kind: 'failed' as const,
      reason: 'The architecture worktree has no revision to publish.',
    };
  const base = await git.fetchRevision(worktree, 'origin', settings.baseBranch);
  if (!base.ok) return { kind: 'failed' as const, reason: base.fault.message };
  const ancestor = await git.readMergeBase(worktree, base.value, head);
  if (!ancestor.ok) return { kind: 'failed' as const, reason: ancestor.fault.message };
  const changed = await git.readChangedPaths(worktree, ancestor.value, head);
  if (!changed.ok) return { kind: 'failed' as const, reason: changed.fault.message };
  const paths = new Set(documents.map((document) => document.path));
  if (changed.value.some((file) => !paths.has(file)))
    return {
      kind: 'failed' as const,
      reason:
        'The complete publication diff contains paths outside the accepted authoritative documents.',
    };
  // Upstream-only paths do not belong to this branch. Compare its contribution with the
  // current base too, since an accepted change may already have landed independently.
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
