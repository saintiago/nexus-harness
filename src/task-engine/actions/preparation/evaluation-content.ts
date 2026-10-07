import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../adapters/git.js';
import { recordIdentity } from '../report-feedback.js';
import type { Selection } from '../select-task/artifacts.js';
import type { RetainedStageAuthorOutput } from './artifacts.js';

/**
 * The observation and validation of the input identities and committed authored work one
 * preparation evaluation binds: the authored report, the captured source input and the exact
 * repository revision the declared work was committed at. The stage actions own the decisions;
 * these helpers commit only declared work and reject a checkout whose declared paths no longer
 * hold the committed bytes.
 */

export { recordIdentity };

/** The authored report's plan, applicability and references are also part of its revision. */
export function authoredIdentity(author: RetainedStageAuthorOutput): string {
  return recordIdentity(author);
}

/** The identity of the captured source input a stage decision was taken against. */
export function sourceInputIdentity(selection: Selection): string {
  return recordIdentity({ task: selection.task, conversation: selection.conversation });
}

/** Failure modes that mean the path names no readable regular file. */
const unreadableCodes = new Set(['ENOENT', 'ENAMETOOLONG', 'ENOTDIR', 'ELOOP']);

/** True when the path exists as a regular file; a path the filesystem cannot resolve is not one. */
async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    if (unreadableCodes.has((error as NodeJS.ErrnoException).code ?? '')) {
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
    if (unreadableCodes.has((error as NodeJS.ErrnoException).code ?? '')) {
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

/**
 * One skip reference resolved to what it cites: a document in the shared checkout whose exact
 * current content the assessment reads, an existing retained file outside the checkout kept as
 * attributed evidence, or why the reference is unusable. Explanatory prose is not a reference; it
 * belongs in the skip's reason or summary. A reference is evidence only: it creates no document
 * binding, selects no historical approval and authorizes nothing.
 */
export type SkipReferenceResolution =
  | {
      readonly kind: 'document';
      /** The canonical checkout-relative path of the cited document. */
      readonly relative: string;
      /** The section anchor the citation named, or null when it cites the whole document. */
      readonly anchor: string | null;
    }
  | { readonly kind: 'evidence'; readonly path: string }
  | {
      /** A checkout location that does not name a readable file; a report cannot cite one. */
      readonly kind: 'absence';
      readonly relative: string;
    }
  | { readonly kind: 'unsupported'; readonly problem: string };

/**
 * Resolve one optional skip reference to the readable evidence it cites, consistently for author
 * validation and evaluation. A citation is a checkout path, optionally with a #section anchor,
 * naming a readable document inside the shared checkout, or an existing readable file the stage
 * retains elsewhere. Anything else - prose, an unreadable path or a location outside the
 * workspace - is unsupported with a concrete reason instead of a filesystem fault.
 */
export async function resolveSkipReference(settings: {
  readonly worktree: string;
  readonly reference: string;
}): Promise<SkipReferenceResolution> {
  const { worktree, reference } = settings;
  const separator = reference.indexOf('#');
  const named = (separator === -1 ? reference : reference.slice(0, separator)).trim();
  const anchor = separator === -1 ? null : reference.slice(separator + 1).trim();
  if (named === '') {
    return {
      kind: 'unsupported',
      problem: `"${reference}" names no repository document or retained file`,
    };
  }
  if (path.resolve(worktree, named) === path.resolve(worktree)) {
    return {
      kind: 'unsupported',
      problem: `"${reference}" names the shared checkout instead of a readable file`,
    };
  }
  const relative = checkoutRelative(worktree, named);
  if (relative !== null) {
    if (!(await isFile(path.join(worktree, relative)))) {
      return { kind: 'absence', relative };
    }
    return { kind: 'document', relative, anchor: anchor === '' ? null : anchor };
  }
  if (await isFile(path.resolve(worktree, named))) {
    return { kind: 'evidence', path: path.resolve(worktree, named) };
  }
  return {
    kind: 'unsupported',
    problem:
      `"${reference}" is neither a readable file in the shared preparation checkout nor an ` +
      'existing retained file',
  };
}

/** The citation rule the instructions and every diagnostic share. */
export const skipReferenceRule =
  'a skip reference names a readable file in the shared preparation checkout (a path or a ' +
  'path#section citation) or an existing retained file; explanations belong in the skip reason';

/** The actionable reason one skip reference cannot be used, for author rejection and diagnosis. */
export function skipReferenceProblem(resolution: SkipReferenceResolution): string | null {
  if (resolution.kind === 'absence') {
    return `the reference "${resolution.relative}" does not name a readable file; ${skipReferenceRule}`;
  }
  if (resolution.kind === 'unsupported') {
    return `${resolution.problem}; ${skipReferenceRule}`;
  }
  return null;
}

/** The revision one evaluation observes after committing the authored work it assesses. */
export type CommittedAuthoredWork = {
  readonly revision: string;
};

/**
 * Commit the author's declared stage work in one named path-scoped commit, observe the exact
 * repository revision the evaluation runs against and require optional skip references to name
 * readable evidence. A path-scoped commit never absorbs unrelated staged work. A named deletion is
 * committed while the checkout still tracks the path; an interrupted evaluation that already
 * committed it is observed instead of re-staged, so a replay neither fails on the absent path nor
 * commits anything else. The action records no per-file content: the committed revision and the
 * declared paths are the whole commit-integrity basis.
 */
export async function commitAuthoredWork(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly author: RetainedStageAuthorOutput;
}): Promise<CommittedAuthoredWork> {
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
  if (head === null) {
    throw new Error('The prepared checkout reports no revision to evaluate.');
  }
  let revision = head;
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
      if ((await git.readFileAtRevision(worktree, head, relative)).ok) {
        stageable.push(relative);
      }
    }
    if (stageable.length > 0) {
      const saved = await git.commitPaths(
        worktree,
        stageable,
        'Retain authored preparation content for evaluation',
      );
      if (!saved.ok) throw new Error(saved.fault.message);
      if (saved.value.headRevision === null) {
        throw new Error('The prepared checkout reports no revision for the authored content.');
      }
      revision = saved.value.headRevision;
    }
  }
  if (author.outcome === 'skip-proposed') {
    // Supplied references are readable evidence the evaluator may use; an unreadable reference is
    // invalid and an empty list is valid. They create no binding.
    for (const reference of author.skip?.references ?? []) {
      const resolution = await resolveSkipReference({ worktree, reference });
      const problem = skipReferenceProblem(resolution);
      if (problem !== null) {
        throw new Error(`The ${author.stage} skip carries unusable evidence: ${problem}.`);
      }
    }
  }
  return { revision };
}

/** The error every stale evaluated content reports: a current decision must be obtained. */
function changed(): Error {
  return new Error(
    'Evaluated content changed or has no readable revision; a current decision is required.',
  );
}

/**
 * Reject declared stage work that no longer matches the evaluated revision: the documents and
 * stage-owned sources the author declared must still be the committed bytes the evaluator
 * assessed. Expected existence comes from the evaluated revision, not the current checkout: a file
 * the evaluator assessed as present and that was later deleted needs a current decision, while a
 * deletion the evaluator assessed as absent stays valid until the path is recreated. An
 * uncommitted edit after the observation needs a current decision, while a submission that
 * declares no changed work has nothing to check. This transient commit-integrity check creates no
 * persisted file binding, never reads browser evidence and never limits assessment scope.
 */
export async function requireDeclaredWork(settings: {
  readonly git: GitAdapter;
  readonly worktree: string;
  readonly author: RetainedStageAuthorOutput;
  readonly revision: string;
}): Promise<void> {
  const { git, worktree, author } = settings;
  if (author.outcome !== 'authored') {
    return;
  }
  const checked = new Set<string>();
  for (const value of [...author.documents.map(({ path: file }) => file), ...author.sourcePaths]) {
    const relative = checkoutRelative(worktree, value);
    if (relative === null) {
      throw new Error(
        `Declared path "${value}" lies outside the shared preparation checkout; a current ` +
          'decision is required.',
      );
    }
    if (checked.has(relative)) continue;
    checked.add(relative);
    const file = path.join(worktree, relative);
    const evaluated = await git.readFileAtRevision(worktree, settings.revision, relative);
    if (!evaluated.ok) {
      if (await exists(file)) throw changed();
      continue;
    }
    let current: string;
    try {
      current = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw changed();
      throw error;
    }
    if (evaluated.value !== current) throw changed();
  }
}
