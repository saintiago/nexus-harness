import type { ChangeCategory, ChangeKind, ChangeState, ChangedPath } from '../shared/types.js';
import { gitFailure, runGit } from './git.js';
import type { GitRunBounds } from './git.js';
import type { PreparedWorkspace } from './prepare.js';
import { statusEntries } from './status.js';

/**
 * # What a working copy differs from its recorded base by
 *
 * The last thing a run needs from Git: after the coding turns have stopped, a
 * listing of everything they left in the working copy. It is a reading, not a
 * judgement — the harness lists what changed and flags the paths whose change
 * could alter what the checks that decided the run actually did; it does not
 * decide whether a change is correct, and it makes no claim to be tamper-proof
 * (docs/spec.md §5).
 *
 * ## The categories
 *
 * Three categories, read from a path's own names and nothing else — not the
 * file's contents, not what the change does to it:
 *
 * - `tests`: a path with a test directory segment (`test`, `tests`, `__tests__`,
 *   `spec`, `specs`) anywhere in it, or a file name with a `test`/`spec` word in
 *   it (`app.test.ts`, `app_test.go`, `test_helpers.py`, `spec.js`).
 * - `tooling`: a dependency manifest or lockfile (`package.json`, `yarn.lock`,
 *   …), a build or CI definition (`Makefile`, `Dockerfile`, `Jenkinsfile`,
 *   `.github/`, `.circleci/`, …), or an ignore/control file (`.gitignore`,
 *   `.npmrc`, `.dockerignore`, …).
 * - `configuration`: a settings file (`*.config.*`, `tsconfig*.json`, `.env*`,
 *   `*.ini`/`*.toml`/`*.cfg`, `.editorconfig`) or a path inside a `config`,
 *   `configs`, or `conf` directory.
 *
 * The rules are deliberately generous and fixed: flagging an ordinary file costs
 * a reviewer a glance, while missing a weakened test costs the run its meaning,
 * and a category set the target repository could configure would be one more
 * thing the run's own working copy decides. They are not a language-aware
 * analysis: a file is in a category because of what it is called, and a change
 * the harness did not flag is not a change it cleared.
 *
 * ## Both readings, always
 *
 * `git diff <base> HEAD` covers what the coding turns committed, and
 * `git status` covers what they left in the working tree — staged, unstaged, and
 * untracked. Neither alone is enough: a run whose turns committed their work as
 * they went would look empty to `git diff HEAD`, and a run whose turns left
 * everything uncommitted would look empty to a commit comparison. Ignored files
 * are left out of both, because they are not what a run delivers.
 *
 * Reading is all this does. It never adds, removes, or edits a path in the
 * working copy, and it never writes Git's index: `GIT_OPTIONAL_LOCKS` stays off,
 * so the index refresh that `git status` would otherwise perform is skipped.
 */

/** Directory names whose contents are tests, wherever they appear in a path. */
const TEST_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
]);

/** Test-ish file names: `app.test.ts`, `app_test.go`, `test_helpers.py`, `spec.js`. */
const TEST_FILE_PATTERN = /(^|[._-])(test|tests|spec|specs)([._-]|$)/i;

/** Files that decide how a project is built, run, ignored, or shipped. */
const TOOLING_FILE_NAMES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lockb',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Dockerfile',
  'Jenkinsfile',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.dockerignore',
  '.prettierignore',
  '.eslintignore',
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
]);

/** Directories that hold build or CI definitions rather than the project itself. */
const TOOLING_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.github',
  '.circleci',
  '.gitlab',
  '.devcontainer',
]);

/** Configuration file names that carry their setting in the name. */
const CONFIGURATION_FILE_NAMES: ReadonlySet<string> = new Set(['.editorconfig']);

/** `vite.config.ts`, `tsconfig.build.json`, `.env.local`, `setup.cfg`, `Cargo.toml`. */
const CONFIGURATION_NAME_PATTERN =
  /(^|\.)config\.[^./]+$|^tsconfig(\..+)?\.json$|^jsconfig(\..+)?\.json$|^\.env(\..+)?$|\.(ini|toml|cfg)$/i;

/** Directories that hold configuration rather than source. */
const CONFIGURATION_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['config', 'configs', 'conf']);

/** The order a path's states are recorded in, whatever order Git reported them. */
const CHANGE_STATE_ORDER: readonly ChangeState[] = ['committed', 'staged', 'unstaged', 'untracked'];

/**
 * Which kind a path is recorded as when Git reported more than one for it: a
 * path that disappeared is the fact a reviewer must not miss, a path that
 * appeared is the next, and anything else is a change to something that was
 * already there. The rarest readings — a path staged as added and then deleted
 * from the working tree, say — are resolved towards the more alarming kind,
 * because a summary that overstates is corrected by a glance at the diff, while
 * one that understates is not.
 */
const CHANGE_KIND_ORDER: readonly ChangeKind[] = ['deleted', 'added', 'modified'];

/**
 * What one status letter means for a path. `A` and `D` are the two Git states
 * with a kind of their own; everything else — a modification, a type change, an
 * unmerged path, and any letter this harness does not know — is a modification,
 * which is the least specific claim and never hides the path.
 */
function kindOfStatus(letter: string): ChangeKind {
  if (letter === 'A') {
    return 'added';
  }
  return letter === 'D' ? 'deleted' : 'modified';
}

/** One path as one reading reported it, before the readings are combined. */
interface ObservedChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly state: ChangeState;
}

/**
 * Parses `git diff --name-status -z`: one status field and one path field, each
 * NUL-terminated. Renames are turned off when the command runs, so a change is
 * always one field and one path.
 */
function parseNameStatus(output: string): ObservedChange[] {
  const fields = output.split('\0');
  const changes: ObservedChange[] = [];

  for (let position = 0; position + 1 < fields.length; position += 2) {
    const status = fields[position] ?? '';
    const file = fields[position + 1] ?? '';
    if (status === '' || file === '') {
      continue;
    }
    changes.push({ path: file, kind: kindOfStatus(status.charAt(0)), state: 'committed' });
  }

  return changes;
}

/** Parses `git status --porcelain -z` into what each entry says about its path. */
function parseStatusChanges(output: string): ObservedChange[] {
  const changes: ObservedChange[] = [];

  for (const entry of statusEntries(output)) {
    if (entry.index === '?' && entry.worktree === '?') {
      // A file Git does not track at all: it is not in the base, and it is there now.
      changes.push({ path: entry.path, kind: 'added', state: 'untracked' });
      continue;
    }
    if (entry.index !== ' ') {
      changes.push({ path: entry.path, kind: kindOfStatus(entry.index), state: 'staged' });
    }
    if (entry.worktree !== ' ') {
      changes.push({ path: entry.path, kind: kindOfStatus(entry.worktree), state: 'unstaged' });
    }
  }

  return changes;
}

/**
 * Combines the readings of the same path into one entry, or leaves it alone when
 * only one reading saw it. Paths come back in path order, so two runs of the same
 * working copy produce the same list on any host.
 */
function combineChanges(observed: readonly ObservedChange[]): readonly ChangedPath[] {
  const combined = new Map<string, { kind: ChangeKind; states: ChangeState[] }>();

  for (const change of observed) {
    const held = combined.get(change.path);
    if (held === undefined) {
      combined.set(change.path, { kind: change.kind, states: [change.state] });
      continue;
    }
    if (CHANGE_KIND_ORDER.indexOf(change.kind) < CHANGE_KIND_ORDER.indexOf(held.kind)) {
      held.kind = change.kind;
    }
    if (!held.states.includes(change.state)) {
      held.states.push(change.state);
    }
  }

  return [...combined.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([file, held]) => ({
      path: file,
      kind: held.kind,
      states: CHANGE_STATE_ORDER.filter((state) => held.states.includes(state)),
      categories: categoriesOf(file),
    }));
}

/**
 * The categories a changed path belongs to; see the section doc above for the
 * rules. A path can be in more than one, and an ordinary source file is in none.
 */
function categoriesOf(file: string): readonly ChangeCategory[] {
  const segments = file.split('/');
  const name = segments.at(-1) ?? file;
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  const categories: ChangeCategory[] = [];

  if (
    directories.some((segment) => TEST_DIRECTORY_NAMES.has(segment)) ||
    TEST_FILE_PATTERN.test(name)
  ) {
    categories.push('tests');
  }

  if (
    TOOLING_FILE_NAMES.has(name) ||
    /\.lock$/i.test(name) ||
    directories.some((segment) => TOOLING_DIRECTORY_NAMES.has(segment))
  ) {
    categories.push('tooling');
  }

  if (
    CONFIGURATION_FILE_NAMES.has(name) ||
    CONFIGURATION_NAME_PATTERN.test(name) ||
    directories.some((segment) => CONFIGURATION_DIRECTORY_NAMES.has(segment))
  ) {
    categories.push('configuration');
  }

  return categories;
}

/**
 * Every path the retained working copy differs from its recorded base by, and
 * how it differs. See the section doc above for what is read and what is not.
 *
 * A reading that fails is a {@link WorkspaceError} naming the working copy and
 * what Git said: a caller has to be able to tell a comparison that found nothing
 * from one that could not be made, and must never report the second as the
 * first. Both readings are bounded like every other Git invocation, so a
 * stalled Git ends at the bound and is reported as the stop it was — the run
 * that asked for this final reading records a diagnostic and finishes its
 * report either way.
 */
export async function inspectWorkspaceChanges(
  workspace: PreparedWorkspace,
  bounds: GitRunBounds = {},
): Promise<readonly ChangedPath[]> {
  const committed = await runGit(
    ['diff', '--name-status', '-z', '--no-renames', workspace.baseCommit, 'HEAD'],
    workspace.workspacePath,
    bounds,
  );
  if (committed.code !== 0) {
    throw gitFailure(
      `"${workspace.workspacePath}" could not be compared with its recorded base ${workspace.baseCommit}`,
      committed,
    );
  }

  const status = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no', '--no-renames'],
    workspace.workspacePath,
    bounds,
  );
  if (status.code !== 0) {
    throw gitFailure(`the state of "${workspace.workspacePath}" could not be read`, status);
  }

  return combineChanges([
    ...parseNameStatus(committed.stdout),
    ...parseStatusChanges(status.stdout),
  ]);
}
