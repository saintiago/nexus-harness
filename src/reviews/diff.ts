/**
 * Where a validated finding lands in the pull request's own diff.
 *
 * A finding is positioned by the classic diff position — the 1-based index of
 * the line after the first hunk header, later hunk headers included — which is what the
 * native review comment API accepts. A finding whose path, line, or patch does
 * not let that position be computed is not dropped: it is reported in the
 * review's body instead, so a review never loses a reason merely because GitHub
 * did not report a usable patch for one file.
 */
import type { ChangedFile, ReviewComment, ReviewFinding } from './contract.js';

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
    // The first @@ header is position zero. Everything after it, including
    // subsequent hunk headers and deleted lines, advances the diff position.
    if (newLine !== null) position += 1;
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

/**
 * Whether GitHub's patch for one file can be trusted to position a finding.
 *
 * A patch the harness cannot see completely — GitHub reports none for a binary
 * or oversized file — and a patch whose line counts disagree with the change
 * counts GitHub reports beside it are both unusable as a position: the finding
 * is reported in the review body instead of being pointed at a line the patch
 * may not really show.
 */
function patchIsComplete(file: ChangedFile): boolean {
  if (file.patch === null || file.patch.trim() === '') {
    return false;
  }
  const lines = file.patch.split('\n');
  const additions = lines.filter((line) => line.startsWith('+')).length;
  const deletions = lines.filter((line) => line.startsWith('-')).length;
  return additions === file.additions && deletions === file.deletions;
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
 * one of the pull request's changed files, it carries a line, GitHub reported a
 * complete patch for the file, and that patch really shows the line.
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
      finding.line === null || file === undefined || !patchIsComplete(file)
        ? null
        : diffPosition(file.patch ?? '', finding.line);
    if (position === null || file === undefined) {
      unpositioned.push(finding);
      continue;
    }
    comments.push({ path: finding.path, position, body: finding.body });
  }
  return { comments, unpositioned };
}
