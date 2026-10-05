import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../adapters/git.js';
import type { Selection } from '../select-task/artifacts.js';
import type { AssessedContent, StageAuthorOutput } from './artifacts.js';

/**
 * The observation and validation of the repository content and input identities one preparation
 * evaluation binds: the authored report, the captured source input and the exact repository paths
 * the assessment relied on. The stage actions own the decisions; these helpers observe what they
 * bind and reject content that no longer matches its evaluated revision.
 */

/** The stable identity of one saved report or captured input value. */
export function recordIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** The authored report's plan, applicability and references are also part of its revision. */
export function authoredIdentity(author: StageAuthorOutput): string {
  return recordIdentity(author);
}

/** The identity of the captured source input a stage decision was taken against. */
export function sourceInputIdentity(selection: Selection): string {
  return recordIdentity({ task: selection.task, conversation: selection.conversation });
}

/** True when the path exists as a regular file. */
async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** True when the path exists at all; a broken entry is still present. */
async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** One declared path as a checkout-relative path, or null when it lies outside the checkout. */
export function checkoutRelative(worktree: string, declared: string): string | null {
  const relative = path.relative(worktree, path.resolve(worktree, declared));
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative)
    ? null
    : relative;
}

/** The content observed before one evaluation, with the revision it was observed at. */
export type RetainedEvaluationContent = {
  readonly revision: string | null;
  readonly content: AssessedContent[];
};

/**
 * Retain the authored report's declared repository paths in one named stage-owned commit and
 * observe their exact revision and existence, or observe the retained revision of the existing
 * repository files an evaluated skip relies on. A path-scoped commit never absorbs unrelated
 * staged work. A named deletion is committed while the checkout still tracks the path; an
 * interrupted evaluation that already committed it is observed instead of re-staged, so a replay
 * neither fails on the absent path nor commits anything else.
 */
export async function retainEvaluationContent(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly author: StageAuthorOutput;
  /**
   * The checkout-relative paths a skip proposal reuses from the preceding accepted round. They
   * are observed like any other relied-on content, including a retained deletion.
   */
  readonly reused?: readonly string[];
}): Promise<RetainedEvaluationContent> {
  const { git, worktree, author } = settings;
  const declared = [...author.documents.map(({ path: value }) => value), ...author.sourcePaths];
  const paths: string[] = [];
  for (const value of declared) {
    const relative = checkoutRelative(worktree, value);
    if (relative === null) {
      throw new Error(`Declared path "${value}" lies outside the shared preparation checkout.`);
    }
    if (!paths.includes(relative)) {
      paths.push(relative);
    }
  }
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) throw new Error(inspection.fault.message);
  const head = inspection.value.headRevision;
  if (author.outcome === 'authored' && paths.length > 0) {
    // An absent declared path is a deletion. It is stageable only while the checkout tracks the
    // path; a deletion an earlier interrupted evaluation already committed is retained by
    // observation, since Git cannot stage a path absent from both the head and the checkout.
    const stageable: string[] = [];
    for (const relative of paths) {
      if (await isFile(path.join(worktree, relative))) {
        stageable.push(relative);
        continue;
      }
      if (head !== null && (await git.readFileAtRevision(worktree, head, relative)).ok) {
        stageable.push(relative);
      }
    }
    let revision = head;
    if (stageable.length > 0) {
      const saved = await git.commitPaths(
        worktree,
        stageable,
        'Retain authored preparation content for evaluation',
      );
      if (!saved.ok) throw new Error(saved.fault.message);
      revision = saved.value.headRevision;
    }
    if (revision === null) {
      throw new Error('The prepared checkout reports no revision for the authored content.');
    }
    const content: AssessedContent[] = [];
    for (const relative of paths) {
      content.push({
        path: relative,
        revision,
        exists: await isFile(path.join(worktree, relative)),
      });
    }
    return { revision, content };
  }
  const revision = head;
  const content: AssessedContent[] = [];
  if (author.outcome === 'skip-proposed') {
    for (const relative of settings.reused ?? []) {
      if (revision === null) {
        throw new Error('The prepared checkout reports no revision for the relied-on content.');
      }
      if (content.some((entry) => entry.path === relative)) continue;
      content.push({
        path: relative,
        revision,
        exists: await isFile(path.join(worktree, relative)),
      });
    }
    for (const reference of author.skip?.references ?? []) {
      const relative = checkoutRelative(worktree, reference);
      if (relative === null || content.some((entry) => entry.path === relative)) continue;
      if (!(await isFile(path.join(worktree, relative)))) continue;
      if (revision === null) {
        throw new Error('The prepared checkout reports no revision for the relied-on content.');
      }
      content.push({ path: relative, revision, exists: true });
    }
  }
  return { revision, content };
}

/** The error every stale evaluated content reports: a current decision must be obtained. */
function changed(): Error {
  return new Error(
    'Evaluated content changed or has no readable revision; a current decision is required.',
  );
}

/**
 * Reject repository content that no longer matches the evaluated revision. Comparing the file
 * content at the observed revision, rather than the checkout's current head, preserves a valid
 * decision when an unrelated commit moves HEAD and invalidates it when the assessed path changed.
 */
export async function requireEvaluationContent(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly content: readonly AssessedContent[];
}): Promise<void> {
  const { git, worktree, content } = settings;
  for (const entry of content) {
    const relative = checkoutRelative(worktree, entry.path);
    if (relative === null) {
      throw changed();
    }
    const file = path.join(worktree, relative);
    if (!entry.exists) {
      if (await exists(file)) throw changed();
      continue;
    }
    const saved = await git.readFileAtRevision(worktree, entry.revision, relative);
    if (!saved.ok) throw changed();
    let current: string;
    try {
      current = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw changed();
      throw error;
    }
    if (saved.value !== current) throw changed();
  }
}
