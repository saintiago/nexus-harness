import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../adapters/git.js';
import type { PreparationStage, StageAuthorOutput } from './artifacts.js';

/** The exact repository content the evaluator sees, retained before its invocation. */
export async function retainEvaluationContent(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly stage: PreparationStage;
  readonly author: StageAuthorOutput;
}): Promise<string | null> {
  const { git, worktree, stage, author } = settings;
  if (author.outcome === 'authored') {
    const paths = stage === 'prototype' ? ['.'] : author.documents.map(({ path }) => path);
    for (const file of paths) {
      const relative = path.relative(worktree, path.resolve(worktree, file));
      if (path.isAbsolute(relative) || relative.startsWith('..'))
        throw new Error(`Authored document "${file}" lies outside its worktree.`);
    }
    if (paths.length > 0) {
      const saved = await git.commitPaths(
        worktree,
        paths,
        'Retain authored content for evaluation',
      );
      if (!saved.ok) throw new Error(saved.fault.message);
      return saved.value.headRevision;
    }
  }
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) throw new Error(inspection.fault.message);
  return inspection.value.headRevision;
}

/** Reject edits made during or after assessment; a numeric round is not content identity. */
export async function requireEvaluationContent(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly stage: PreparationStage;
  readonly author: StageAuthorOutput;
  readonly revision: string | null;
  /** The paths observed before evaluation, including existing-document skip inputs. */
  readonly paths?: readonly string[];
}): Promise<string[]> {
  const { git, worktree, stage, author, revision } = settings;
  const changed = () =>
    new Error('Evaluated content changed or has no immutable revision; reevaluation is required.');
  if (stage === 'prototype') {
    const inspection = await git.inspectRepository(worktree);
    if (!inspection.ok) throw new Error(inspection.fault.message);
    if (
      revision === null ||
      inspection.value.headRevision !== revision ||
      inspection.value.trackedChanges ||
      inspection.value.untrackedChanges
    )
      throw changed();
  }
  if (settings.paths !== undefined && author.outcome === 'skip-proposed') {
    for (const reference of author.skip?.references ?? []) {
      const file = path.resolve(worktree, reference);
      const relative = path.relative(worktree, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      try {
        if ((await stat(file)).isFile() && !settings.paths.includes(relative)) throw changed();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
  }
  const verified: string[] = [];
  const files =
    settings.paths ??
    (author.outcome === 'skip-proposed'
      ? (author.skip?.references ?? [])
      : author.documents.map(({ path }) => path));
  for (const reference of files) {
    const file = path.resolve(worktree, reference);
    const relative = path.relative(worktree, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (settings.paths === undefined && author.outcome === 'skip-proposed') {
      try {
        if (!(await stat(file)).isFile()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    if (revision === null) throw changed();
    const saved = await git.readFileAtRevision(worktree, revision, relative);
    if (!saved.ok) throw new Error(saved.fault.message);
    let current: string;
    try {
      current = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw changed();
      throw error;
    }
    if (saved.value !== current) throw changed();
    verified.push(relative);
  }
  return verified;
}

/** The authored report's plan, applicability and references are also part of its revision. */
export function authoredIdentity(author: StageAuthorOutput): string {
  return createHash('sha256').update(JSON.stringify(author)).digest('hex');
}
