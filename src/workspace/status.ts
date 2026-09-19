/** Reading `git status --porcelain -z`: which paths of a checkout differ. */
export interface WorkingTreeState {
  readonly staged: string[];
  readonly unstaged: string[];
  readonly untracked: string[];
}

/** One `git status --porcelain` entry: the two columns Git reported for one path. */
export interface StatusEntry {
  /** Index column: what the staged content is, or `' '` when nothing is staged. */
  readonly index: string;
  /** Worktree column: what the checked-out file is, or `' '` when it matches the index. */
  readonly worktree: string;
  readonly path: string;
}

/**
 * Splits `git status --porcelain -z` output into its entries: `XY path`, each
 * field NUL-terminated. Ignored paths are dropped — they are not part of a
 * checkout's state — and a trailing empty field is skipped.
 */
export function statusEntries(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const field of output.split('\0')) {
    if (field.length < 4) {
      continue; // the trailing empty field
    }
    if (field.startsWith('!!')) {
      continue; // ignored paths never make a checkout dirty
    }
    entries.push({ index: field.charAt(0), worktree: field.charAt(1), path: field.slice(3) });
  }
  return entries;
}

/** Parses `git status --porcelain -z`: NUL-separated `XY path` entries. */
export function parseStatus(output: string): WorkingTreeState {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const entry of statusEntries(output)) {
    if (entry.index === '?' && entry.worktree === '?') {
      untracked.push(entry.path);
      continue;
    }
    if (entry.index !== ' ') {
      staged.push(entry.path);
    }
    if (entry.worktree !== ' ') {
      unstaged.push(entry.path);
    }
  }

  return { staged, unstaged, untracked };
}
