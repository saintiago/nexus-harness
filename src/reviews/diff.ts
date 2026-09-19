/**
 * The pull request's diff, as the reviewer turn reads it and as a finding is
 * positioned in it.
 *
 * A finding is positioned by the classic diff position — the 1-based index of
 * the line within the file's patch, hunk headers included — which is what the
 * native review comment API accepts. A finding whose path, line, or patch does
 * not let that position be computed is not dropped: it is reported in the
 * review's body instead, so a review never loses a reason merely because GitHub
 * did not report a usable patch for one file.
 */
import type { ChangedFile, ReviewComment, ReviewFinding } from './contract.js';

/** How much of one pull request's diff the reviewer turn is given, in characters. */
export const MAX_DIFF_CHARS = 120_000;

/** What one patch line means for the new file's line numbering. */
interface PatchLine {
  readonly position: number;
  /** The new-file line number this line is, when it is one. */
  readonly newLine: number | null;
  /** Whether the line is context or an addition: where a comment may land. */
  readonly commentable: boolean;
}

/** Walks one patch, numbering the positions the review API uses. */
function* walkPatch(patch: string): Generator<PatchLine> {
  let position = 0;
  let newLine: number | null = null;
  for (const line of patch.split('\n')) {
    position += 1;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      newLine = Number(hunk[1]);
      yield { position, newLine: null, commentable: false };
      continue;
    }
    if (newLine === null) {
      yield { position, newLine: null, commentable: false };
      continue;
    }
    if (line.startsWith('+')) {
      yield { position, newLine, commentable: true };
      newLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      yield { position, newLine, commentable: true };
      newLine += 1;
      continue;
    }
    // A removed line advances no new-file number, and "No newline at end of
    // file" lines are not lines of either file.
    yield { position, newLine: null, commentable: false };
  }
}

/**
 * The diff position of one line in the new version of a file, or `null` when
 * the patch does not show that line: the two ways a finding cannot become an
 * inline comment.
 */
export function diffPosition(patch: string, line: number): number | null {
  for (const candidate of walkPatch(patch)) {
    if (candidate.commentable && candidate.newLine === line) {
      return candidate.position;
    }
  }
  return null;
}

/** The diff the reviewer turn is given: every file's patch, bounded. */
export function renderDiff(files: readonly ChangedFile[], maxChars = MAX_DIFF_CHARS): string {
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const file of files) {
    const header = `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n`;
    const body =
      file.patch === null
        ? '(GitHub reported no textual patch for this file: it is binary, or too large for the API to include.)\n'
        : file.patch.endsWith('\n')
          ? file.patch
          : `${file.patch}\n`;
    if (used + header.length + body.length > maxChars) {
      truncated = true;
      break;
    }
    parts.push(header, body);
    used += header.length + body.length;
  }
  if (truncated) {
    parts.push(
      '(the diff was truncated by the harness; ask for the rest through your own tools.)\n',
    );
  }
  return parts.join('');
}

/** Where findings could and could not be positioned. */
export interface PositionedFindings {
  /** Findings that map to a line of the diff; each becomes one inline comment. */
  readonly comments: readonly ReviewComment[];
  /** Findings that do not, and are reported in the review's body instead. */
  readonly unpositioned: readonly ReviewFinding[];
}

/**
 * Positions every finding it can. A finding is positioned only when its path is
 * one of the pull request's changed files, it carries a line, and that line is
 * shown by the patch GitHub reported for the file.
 */
export function positionFindings(
  findings: readonly ReviewFinding[],
  files: readonly ChangedFile[],
): PositionedFindings {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const comments: ReviewComment[] = [];
  const unpositioned: ReviewFinding[] = [];

  for (const finding of findings) {
    const file = byPath.get(finding.path);
    const position =
      finding.line === null || file === undefined || file.patch === null
        ? null
        : diffPosition(file.patch, finding.line);
    if (position === null || file === undefined) {
      unpositioned.push(finding);
      continue;
    }
    comments.push({ path: finding.path, position, body: finding.body });
  }
  return { comments, unpositioned };
}
