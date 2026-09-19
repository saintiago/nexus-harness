/**
 * The terminal's activity pane: what the coding runtime is doing right now, as a
 * bounded block of lines drawn under the run's own progress.
 *
 * The progress — the timeline lines the CLI echoes as the run goes, then the
 * outcome block — is ordinary output. On an interactive terminal the latest
 * activity lines are kept in a fixed pane beneath it: a new line scrolls the
 * oldest out, and the pane is redrawn in place instead of appended, so the
 * visible screen stops growing with the turn. A redirected, too narrow, or too
 * short terminal gets the same lines as ordinary ones instead, without a single
 * cursor sequence. Closing the pane erases it and stops drawing, so the outcome
 * and the paths that follow are printed exactly as they were before the pane
 * existed, and an interrupted run leaves a usable terminal.
 *
 * It is presentation only. Nothing here is evidence of what a turn did: the full
 * runtime output stays in the turn's own agent log, and every decision is made
 * from the harness's own checks (docs/spec.md §2).
 */
import stringWidth from 'string-width';
import type { AgentActivity } from '../shared/types.js';
import type { CliIo } from './context.js';

/** How many activity lines the pane keeps and shows on a full-size terminal. */
export const ACTIVITY_PANE_LINES = 10;

/** The terminal lines the pane always leaves to the run's own progress. */
const RESERVED_ROWS = 4;

/** The width assumed when the terminal does not report one. */
const FALLBACK_COLUMNS = 80;

/** Below this width the pane gives up and writes ordinary lines instead. */
const MIN_COLUMNS = 20;

/**
 * One complete ANSI escape sequence: the escape, any parameter and intermediate
 * bytes, and the final byte. It is named here because a runtime's own output is
 * untrusted text, and a cursor sequence inside it would otherwise move the very
 * cursor this pane is drawing with.
 */
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * An operating-system command sequence: `ESC ] … BEL`, or its `ESC \` ending.
 * It sets terminal state — a window title, above all — and never belongs in a
 * line of activity.
 */
// eslint-disable-next-line no-control-regex
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;

/** What is left of the control range once whole escape sequences are gone. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** How the pane labels what one activity line is about. */
const LABELS: Record<AgentActivity['kind'], string> = {
  message: 'agent',
  command: 'run',
  result: 'result',
  change: 'change',
};

/**
 * The pane as the rest of the CLI uses it: ordinary lines go above it, activity
 * goes into it, and one call takes it away again.
 */
export interface ActivityDisplay {
  /** Writes one ordinary line (or block of text) above the pane. */
  line(text: string): void;
  /**
   * Runs `write` with the pane out of the way and puts it back afterwards. Used
   * for output that reaches the terminal by another route — the CLI's own error
   * stream, above all — so that it is written above the pane rather than into
   * the middle of it.
   */
  around(write: () => void): void;
  /** Records one activity line; the oldest is dropped once the pane is full. */
  activity(activity: AgentActivity): void;
  /**
   * Erases the pane and stops drawing it. Called on every ending — a pass, a
   * failure, an interrupt — so that the terminal is left as usable as it was
   * found. Output that arrives afterwards is written plainly.
   */
  close(): void;
}

/**
 * The display for one CLI invocation: a pane on an interactive terminal, or
 * plain ordinary lines anywhere else.
 */
export function createActivityDisplay(io: CliIo): ActivityDisplay {
  const terminal = io.terminal;
  if (terminal === undefined) {
    return plainDisplay(io.out);
  }
  const height = paneHeight(terminal.rows);
  const columns = terminal.columns ?? FALLBACK_COLUMNS;
  return height === 0 || columns < MIN_COLUMNS
    ? plainDisplay(io.out)
    : paneDisplay(terminal.write, columns - 1, height);
}

/**
 * How many activity lines fit on a terminal that reports `rows` lines, or zero
 * when it is too short to keep a pane that leaves the progress room — a caller
 * that gets zero falls back to ordinary lines.
 */
function paneHeight(rows: number | undefined): number {
  if (rows === undefined || rows <= 0) {
    return ACTIVITY_PANE_LINES;
  }
  return Math.min(ACTIVITY_PANE_LINES, Math.max(0, rows - RESERVED_ROWS));
}

/**
 * The interactive pane: it remembers the latest lines, and keeps the cursor on
 * the line below them, where ordinary output goes.
 */
function paneDisplay(
  write: (text: string) => void,
  width: number,
  height: number,
): ActivityDisplay {
  const lines: string[] = [];
  /** How many pane lines are on screen directly above the cursor. */
  let drawn = 0;
  let closed = false;

  /** Moves to the pane's first line and clears it and everything below. */
  const erase = (): void => {
    if (drawn > 0) {
      write(`\u001b[${String(drawn)}A\u001b[J`);
      drawn = 0;
    }
  };

  /** Draws the pane from the cursor's line, leaving the cursor below it. */
  const draw = (): void => {
    for (const text of lines) {
      write(`${text}\n`);
    }
    drawn = lines.length;
  };

  return {
    line: (text) => {
      if (closed) {
        write(`${text}\n`);
        return;
      }
      erase();
      write(`${text}\n`);
      draw();
    },
    around: (action) => {
      if (closed) {
        action();
        return;
      }
      erase();
      action();
      draw();
    },
    activity: (activity) => {
      const text = formatActivity(activity, width);
      if (closed) {
        write(`${text}\n`);
        return;
      }
      lines.push(text);
      if (lines.length > height) {
        lines.splice(0, lines.length - height);
      }
      erase();
      draw();
    },
    close: () => {
      erase();
      closed = true;
    },
  };
}

/**
 * The fallback for a terminal that cannot hold a pane: the same lines, written
 * one per line as ordinary output, without a cursor sequence anywhere.
 */
function plainDisplay(out: (text: string) => void): ActivityDisplay {
  return {
    line: (text) => {
      out(text);
    },
    around: (action) => {
      action();
    },
    activity: (activity) => {
      out(formatActivity(activity, null));
    },
    close: () => undefined,
  };
}

/**
 * One activity line as a display line: labelled with what it is, flattened onto
 * one line, and — when a width is given — cut to fit the pane.
 */
function formatActivity(activity: AgentActivity, width: number | null): string {
  const text = `${LABELS[activity.kind]}: ${flatten(activity.text)}`;
  return width === null ? text : truncate(text, width);
}

/**
 * Event text as one line safe to write to a terminal: whole escape sequences and
 * every other control character — a carriage return, a bell, a backspace —
 * become spaces, so text a runtime reported can never move the cursor, rewrite
 * the pane, or hide what follows it.
 */
function flatten(text: string): string {
  return text
    .replace(ANSI_SEQUENCE, ' ')
    .replace(OSC_SEQUENCE, ' ')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const graphemes = new Intl.Segmenter();

/**
 * Fit terminal cells, leaving grapheme clusters (CJK, combining marks, emoji)
 * intact. The caller leaves the last terminal column unused to avoid autowrap.
 * Use the usual narrow ambiguous-character convention, as string-width does.
 */
function truncate(text: string, width: number): string {
  if (stringWidth(text) <= width) {
    return text;
  }
  let fitted = '';
  let cells = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = stringWidth(segment);
    if (cells + size > width - 1) {
      break;
    }
    fitted += segment;
    cells += size;
  }
  return `${fitted}…`;
}
