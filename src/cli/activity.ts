/**
 * The terminal's activity pane: what one agent invocation is doing right now, as
 * a bounded block of lines drawn under the run's own progress, and the
 * timestamped timeline those panes leave behind when they end.
 *
 * The progress — the timeline lines the CLI echoes as the run goes, then the
 * outcome block — is ordinary output, stamped with the local time it reaches the
 * viewer (`HH:mm:ss`), one stamp per logical line, so one chronological timeline
 * holds the lifecycle events and the agent panes together. On an interactive
 * terminal the activity lines are kept in a fixed pane beneath that output: it
 * is redrawn in place instead of appended, so the visible screen stops growing
 * with the turn, and it is bounded in lines, so a long run stays readable. A
 * redirected, noninteractive, too narrow, or too short terminal gets the same
 * lines as ordinary ones instead, without a single cursor sequence.
 *
 * Every agent invocation gets its own fresh pane. `beginInvocation` announces it
 * with a boundary line naming the role the phase launched — `developer` for a
 * coding or repair turn, `reviewer` for a Nexus Lens turn — and the ticket when
 * one is known, and starts an empty history: a new turn never inherits the rows
 * of the one before it. `endInvocation` finalizes the pane: it is erased where it
 * stood and its retained rows are printed as that invocation's segment of the
 * timeline, so later lifecycle events and the next pane follow them in scrollback
 * order. Only the pane of the invocation running right now is cursor-managed;
 * one display never draws two panes at once. Closing the display finalizes
 * whatever is on screen and stops drawing, so the outcome and the paths that
 * follow are printed as ordinary lines after it, and an interrupted run leaves a
 * usable terminal.
 *
 * The history is grouped by the agent's own messages: each message starts a
 * group that keeps at most the three latest work lines that followed it, and the
 * history of one pane is bounded, so the messages accumulate one below another
 * while the work between them disappears oldest-first.
 *
 * Each entry, and each ordinary line, is stamped with the local time the viewer
 * received or emitted it — `HH:mm:ss`, read once and kept for every redraw — and
 * an agent message's own line is drawn in a golden yellow, reset again inside the
 * entry, so commands, results and changed files stay in the terminal's ordinary
 * color. The stamp is the viewer's own clock and nothing more: the runtime's
 * event stream carries no timestamp, so the terminal never implies one. A
 * redirected or too small terminal carries no escape sequences at all; a
 * terminal that asked for no color keeps the pane and the stamps and carries no
 * styling sequence.
 *
 * It is presentation only. Nothing here is evidence of what a turn did: the full
 * runtime output stays in the turn's own agent log, and every decision is made
 * from the harness's own checks (docs/spec.md §2).
 */
import stringWidth from 'string-width';
import type { AgentActivity } from '../shared/types.js';
import type { CliIo } from './context.js';
import { interactiveProgress } from './progress.js';

/** How many activity lines the pane keeps and shows on a full-size terminal. */
export const ACTIVITY_PANE_LINES = 20;

/** How many work lines one agent message's group keeps visible. */
const WORK_LINES_PER_GROUP = 3;

/** The terminal lines the pane always leaves to the run's own progress. */
const RESERVED_ROWS = 4;

/** The width assumed when the terminal does not report one. */
const FALLBACK_COLUMNS = 80;

/** Below this width the pane gives up and writes ordinary lines instead. */
const MIN_COLUMNS = 20;

/**
 * The golden/yellow an agent message is drawn in: the standard ANSI yellow,
 * which every terminal that renders color at all supports, and which stays
 * readable on light and dark backgrounds alike.
 */
const MESSAGE_COLOR = '\u001b[33m';

/**
 * Back to the terminal's own default styling. Written inside every highlighted
 * entry, never once per draw, so a message's color cannot reach the text after
 * it — the next activity line, the progress, or the outcome.
 */
const COLOR_RESET = '\u001b[0m';

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
 * Which agent a pane belongs to: the phase that launched the turn, never the
 * model it was launched with. A coding or repair turn is a `developer`; a Nexus
 * Lens turn is a `reviewer`.
 */
export type ActivityRole = 'developer' | 'reviewer';

/**
 * One agent invocation, as the timeline announces it before the invocation's
 * pane opens.
 */
export interface ActivityInvocation {
  /** The phase that launched the turn: the role, named by the launcher. */
  readonly role: ActivityRole;
  /** The ticket (or standalone task) it works on, when one is known. */
  readonly ticket?: string | null;
  /** What the phase calls itself: `implementation turn`, `repair turn 2`, `review`. */
  readonly phase?: string | null;
}

/**
 * The pane as the rest of the CLI uses it: ordinary lines go above it, activity
 * goes into it, one invocation's pane becomes a segment of the timeline when it
 * ends, and closing takes the display away again.
 */
export interface ActivityDisplay {
  /**
   * Writes one ordinary timeline line, or a block of them, above the pane. Each
   * logical line is prefixed once with the local time it reaches the viewer; a
   * line the pane's progress reader recognizes is condensed first, and the run
   * wrote a full record of it in the log either way.
   */
  line(text: string): void;
  /**
   * Writes one error line, or a block of them, on the CLI's own error stream,
   * stamped exactly as `line` stamps the ordinary ones and drawn above the pane
   * rather than through the middle of it.
   */
  error(text: string): void;
  /**
   * Records one activity line in the current invocation's pane. A message starts
   * a new group; work lines join the newest group, which keeps its latest three,
   * and the history is trimmed to the pane's bound. The line is stamped with the
   * time it arrives at, once, and that stamp is what every later redraw of it
   * carries.
   */
  activity(activity: AgentActivity): void;
  /**
   * Opens a fresh pane for one agent invocation: the boundary line naming its
   * role and ticket is written to the timeline, an invocation still open is
   * finalized first, and the new pane starts with no rows of its own.
   */
  beginInvocation(invocation: ActivityInvocation): void;
  /**
   * Ends the current invocation: its pane is erased and its retained rows are
   * written to the timeline as that invocation's segment, in order, before
   * anything that follows. Ending again, or having opened nothing, does nothing.
   */
  endInvocation(): void;
  /**
   * Finalizes an open invocation, erases the pane, and stops drawing it. Called
   * on every ending — a pass, a failure, an interrupt — so that the terminal is
   * left as usable as it was found. An entry that arrives afterwards is written
   * as one ordinary line, still with the receive time it was stamped with.
   */
  close(): void;
}

/**
 * The display for one CLI invocation: a pane on an interactive terminal, or
 * plain ordinary lines anywhere else.
 *
 * `now` is the viewer's own clock, read once for each emission the pane receives;
 * it is the time that emission is stamped with. The process clock when the caller
 * gives none, and a controlled clock in a test.
 */
export function createActivityDisplay(
  io: CliIo,
  now: () => Date = () => new Date(),
): ActivityDisplay {
  const terminal = io.terminal;
  if (terminal === undefined) {
    return plainDisplay(io, now);
  }
  const height = paneHeight(terminal.rows);
  const columns = terminal.columns ?? FALLBACK_COLUMNS;
  return height === 0 || columns < MIN_COLUMNS
    ? plainDisplay(io, now)
    : paneDisplay(terminal.write, io.err, columns - 1, height, now, terminal.color !== false);
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
 *
 * `write` is the terminal's own raw writer — cursor sequences and all — so a row
 * written through it carries its own newline. `writeError` writes one complete
 * line to the CLI's error stream instead, the way every other caller of that
 * stream does: the stream appends the newline, and nothing is added here.
 */
function paneDisplay(
  write: (text: string) => void,
  writeError: (line: string) => void,
  width: number,
  height: number,
  now: () => Date,
  color: boolean,
): ActivityDisplay {
  /** The rows of the invocation on screen now; empty between invocations. */
  let groups: ActivityGroup[] = [];
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
    const lines = linesOf(groups);
    for (const text of lines) {
      write(`${text}\n`);
    }
    drawn = lines.length;
  };

  /**
   * Writes one ordinary block above the pane, each logical line stamped once
   * with the time the block reached the viewer. A line the progress reader
   * condenses away is left out; one it does not recognize is shown as written.
   */
  const ordinary = (text: string, emit: (line: string) => void, condense: boolean): void => {
    const stamp = displayTime(now());
    const lines: string[] = [];
    for (const logical of text.split('\n')) {
      const shown = condense ? interactiveProgress(logical) : logical;
      if (shown === null) {
        continue;
      }
      lines.push(stampLine(shown, stamp));
    }
    erase();
    for (const line of lines) {
      emit(line);
    }
    draw();
  };

  /** Writes one ordinary block with no pane on screen to draw under it. */
  const standalone = (text: string, emit: (line: string) => void): void => {
    const stamp = displayTime(now());
    for (const logical of text.split('\n')) {
      emit(stampLine(logical, stamp));
    }
  };

  /**
   * Ends the pane on screen: it is erased where it stood and its retained rows
   * are written to the timeline, so what it showed stays in scrollback in the
   * order it was produced and nothing it drew is dropped.
   */
  const finalize = (): void => {
    erase();
    for (const line of linesOf(groups)) {
      write(`${line}\n`);
    }
    groups = [];
  };

  /** Records one formatted activity line in its group. */
  const record = (kind: AgentActivity['kind'], text: string): void => {
    if (kind === 'message') {
      groups.push({ message: text, work: [] });
    } else {
      let group = groups.at(-1);
      if (group === undefined) {
        // Work reported before the turn's first message is still that work: it
        // keeps its own group rather than being placed under a message that
        // came later.
        group = { message: null, work: [] };
        groups.push(group);
      }
      group.work.push(text);
      if (group.work.length > WORK_LINES_PER_GROUP) {
        group.work.splice(0, group.work.length - WORK_LINES_PER_GROUP);
      }
    }
    fitHistory(groups, height);
  };

  return {
    line: (text) => {
      if (closed) {
        // The pane is gone: a later line is written as the run wrote it, with
        // nothing condensed away and the time it reached the viewer.
        standalone(text, (line) => {
          write(`${line}\n`);
        });
        return;
      }
      ordinary(
        text,
        (line) => {
          write(`${line}\n`);
        },
        true,
      );
    },
    error: (text) => {
      if (closed) {
        standalone(text, writeError);
        return;
      }
      ordinary(text, writeError, false);
    },
    activity: (activity) => {
      // The entry's receive time, read once here: a redraw later draws this very
      // line again, never a freshly stamped one.
      const text = paneLine(activity, displayTime(now()), width, color);
      if (closed) {
        write(`${text}\n`);
        return;
      }
      record(activity.kind, text);
      erase();
      draw();
    },
    beginInvocation: (invocation) => {
      // The boundary is one emission with one time: what opens a pane reads as
      // one row of the timeline, fitted to the pane's own width, because a
      // boundary that wrapped would break the cursor work this display does.
      const boundary = boundaryLine(invocation, displayTime(now()), width);
      if (closed) {
        write(`${boundary}\n`);
        return;
      }
      finalize();
      write(`${boundary}\n`);
    },
    endInvocation: () => {
      if (!closed) {
        finalize();
      }
    },
    close: () => {
      if (!closed) {
        finalize();
      }
      closed = true;
    },
  };
}

/** One agent message and the work lines that followed it. */
interface ActivityGroup {
  /** The message line that starts the group, or `null` for work seen before one. */
  readonly message: string | null;
  /** The group's retained work lines, oldest first. */
  readonly work: string[];
}

/** One row the pane draws, and where in the history it is kept. */
interface ActivityRow {
  readonly group: ActivityGroup;
  /** The index of a work line, or `null` for the group's message line. */
  readonly work: number | null;
}

/** Every line the history would draw, oldest first. */
function linesOf(groups: readonly ActivityGroup[]): readonly string[] {
  const lines: string[] = [];
  for (const group of groups) {
    if (group.message !== null) {
      lines.push(group.message);
    }
    lines.push(...group.work);
  }
  return lines;
}

/** Every row of the history with the place it is kept, oldest first. */
function rowsOf(groups: readonly ActivityGroup[]): readonly ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const group of groups) {
    if (group.message !== null) {
      rows.push({ group, work: null });
    }
    group.work.forEach((_line, index) => {
      rows.push({ group, work: index });
    });
  }
  return rows;
}

/** Removes one row, and a message-less group that no longer holds anything. */
function removeRow(groups: ActivityGroup[], row: ActivityRow): void {
  const position = groups.indexOf(row.group);
  if (position < 0) {
    return;
  }
  if (row.work === null) {
    groups.splice(position, 1);
    return;
  }
  row.group.work.splice(row.work, 1);
  if (row.group.work.length === 0 && row.group.message === null) {
    groups.splice(position, 1);
  }
}

/**
 * Drops rows until the history fits the pane it is drawn in.
 *
 * The oldest work line goes first, so earlier agent messages stay in order and
 * accumulate one below another as the work between them disappears; a message
 * is dropped only once no work line can go instead, and the history then scrolls
 * as a plain sequence of messages. The row that just arrived is never the one
 * dropped — a pane that hid the newest line would not show the work it exists to
 * show — so work arriving under a history that is already all messages takes the
 * oldest message's place.
 */
function fitHistory(groups: ActivityGroup[], capacity: number): void {
  for (;;) {
    const rows = rowsOf(groups);
    if (rows.length <= capacity) {
      return;
    }
    const oldestWork = rows.findIndex((row) => row.work !== null);
    const target = oldestWork >= 0 && oldestWork < rows.length - 1 ? oldestWork : 0;
    const row = rows[target];
    if (row === undefined) {
      return;
    }
    removeRow(groups, row);
  }
}

/**
 * The fallback for a terminal that cannot hold a pane: the same lines, written
 * one per line as ordinary output, without a cursor sequence anywhere. It is
 * also what a redirected stream gets, and it carries no color: the entry and the
 * invocation boundary as timestamped plain text, with nothing for a terminal to
 * interpret.
 */
function plainDisplay(io: CliIo, now: () => Date): ActivityDisplay {
  /** One block as stamped ordinary lines, whatever the stream it goes to. */
  const printed = (text: string, write: (line: string) => void): void => {
    const stamp = displayTime(now());
    for (const line of text.split('\n')) {
      write(stampLine(line, stamp));
    }
  };

  return {
    line: (text) => {
      printed(text, io.out);
    },
    error: (text) => {
      printed(text, io.err);
    },
    activity: (activity) => {
      io.out(`${displayTime(now())} ${describe(activity)}`);
    },
    beginInvocation: (invocation) => {
      io.out(boundaryLine(invocation, displayTime(now())));
    },
    endInvocation: () => undefined,
    close: () => undefined,
  };
}

/**
 * One logical line with the stamp of the emission it belongs to. An empty line
 * has nothing to stamp and stays the empty line it was: a block keeps its own
 * shape, and no row is invented for it.
 */
function stampLine(line: string, stamp: string): string {
  return line.trim() === '' ? line : `${stamp} ${line}`;
}

/**
 * The boundary that opens one invocation's pane: the role the phase launched,
 * the ticket when one is known, and what the phase calls itself. It is a row of
 * the timeline in its own right, so consecutive developer, reviewer, and
 * next-ticket panes stay distinguishable in scrollback.
 *
 * A pane too narrow for the whole row gives up its details before its identity:
 * what the phase called itself goes first, then the fences, and only a pane that
 * cannot hold the role and the ticket either is fitted like any other row. The
 * role and the ticket are what tell two consecutive panes apart, so they are the
 * last thing to go.
 */
function boundaryLine(invocation: ActivityInvocation, stamp: string, width?: number): string {
  const ticket = nonBlank(invocation.ticket);
  const phase = nonBlank(invocation.phase);
  const named = ticket === null ? invocation.role : `${invocation.role}: ${ticket}`;
  const full = `${stamp} ---- ${named}${phase === null ? '' : ` — ${phase}`} ----`;
  if (width === undefined || stringWidth(full) <= width) {
    return full;
  }
  const namedOnly = `${stamp} ---- ${named} ----`;
  return stringWidth(namedOnly) <= width ? namedOnly : truncate(`${stamp} ${named}`, width);
}

/** A value as the nonblank text it holds, or `null` when it holds none. */
function nonBlank(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** One activity entry as plain text: what it is labelled as, and its text. */
function describe(activity: AgentActivity): string {
  return `${LABELS[activity.kind]}: ${flatten(activity.text)}`;
}

/**
 * One activity entry as the pane draws it: the local time the viewer received
 * it, the label, and the flattened text, fitted to one row. The timestamp is
 * visible text, so it counts toward the fit like any other character, and a
 * message's own line — the label and its text — is drawn in the pane's message
 * color and reset again. The highlight is applied after the fit, so its escape
 * sequences never consume a display cell and never change what was cut.
 */
function paneLine(activity: AgentActivity, stamp: string, width: number, color: boolean): string {
  const head = `${stamp} `;
  const line = truncate(`${head}${describe(activity)}`, width);
  if (!color || activity.kind !== 'message') {
    return line;
  }
  // Split after the timestamp, so the stamp keeps the terminal's ordinary color
  // and only the message's own line is highlighted.
  const plain = line.slice(0, head.length);
  return `${plain}${MESSAGE_COLOR}${line.slice(plain.length)}${COLOR_RESET}`;
}

/** Two digits, as a clock field is written. */
function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The compact local time the viewer stamps a received entry with: `HH:mm:ss`,
 * read from the viewer's own clock once per entry. It is a display fact, not
 * the runtime's event time — the event stream carries none, and the pane never
 * writes a stamp that could be read as one.
 */
function displayTime(at: Date): string {
  return `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}:${twoDigits(at.getSeconds())}`;
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
