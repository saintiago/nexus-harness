/**
 * Terminal text handling for presentation. Event text is data, not terminal instructions, so
 * escape sequences and other control characters are removed before rendering. Display width comes
 * from the Unicode width tables in `string-width`, and wrapping and truncation advance by grapheme
 * cluster so a character is never cut in half.
 */

import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

/** Control characters that never belong in presented text; the line break is the exception. */
function isControlCode(codePoint: number): boolean {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Remove embedded terminal control sequences, keeping line structure and ordinary text. */
export function sanitize(text: string): string {
  let plain = '';
  for (const character of stripAnsi(text)) {
    if (character === '\n') {
      plain += character;
    } else if (character === '\t') {
      plain += ' ';
    } else if (!isControlCode(character.codePointAt(0) ?? 0)) {
      plain += character;
    }
  }
  return plain;
}

/** The text's display width in terminal columns. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

/** The grapheme clusters of one line, as the units wrapping and truncation may not split. */
function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (entry) => entry.segment);
}

/** Wrap text into rows of at most `width` display columns, never cutting a character. */
export function wrap(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    let row = '';
    let used = 0;
    for (const cluster of graphemes(line)) {
      const clusterWidth = displayWidth(cluster);
      if (used > 0 && used + clusterWidth > limit) {
        rows.push(row);
        row = '';
        used = 0;
      }
      row += cluster;
      used += clusterWidth;
    }
    rows.push(row);
  }
  return rows;
}

/** Fit text to one row of at most `width` display columns, with an ellipsis when it is cut. */
export function truncate(text: string, width: number): string {
  const limit = Math.max(0, width);
  if (displayWidth(text) <= limit) {
    return text;
  }
  if (limit <= 1) {
    return limit === 0 ? '' : '…';
  }
  let row = '';
  let used = 0;
  for (const cluster of graphemes(text)) {
    const clusterWidth = displayWidth(cluster);
    if (used + clusterWidth > limit - 1) {
      break;
    }
    row += cluster;
    used += clusterWidth;
  }
  return `${row}…`;
}
