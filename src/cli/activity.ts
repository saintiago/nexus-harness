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
 * of the one before it. `endInvocation` finalizes the pane: the rows it drew
 * stay exactly where they are as that invocation's segment of the timeline, so
 * later lifecycle events and the next pane follow them in scrollback order.
 * Only the pane of the invocation running right now is cursor-managed;
 * one display never draws two panes at once. Closing the display finalizes
 * whatever is on screen and stops drawing, so the outcome and the paths that
 * follow are printed as ordinary lines after it, and an interrupted run leaves a
 * usable terminal.
 *
 * A pane owns the lines it holds and nothing else. Each of the pane's own lines
 * is written from the terminal's first column with its line cleared first, so a
 * repaint rewrites them where they stand instead of appending anything; nothing
 * outside the pane's own lines is ever erased, because the display never clears
 * to the end of the screen. The retained rows are therefore never written a
 * second time anywhere else in the timeline: they are drawn once by the pane
 * and, when the pane is finalized, simply left standing.
 *
 * The history is grouped by the agent's own messages: each message starts a
 * group that keeps at most the three latest work lines that followed it, and the
 * cursor-managed history of one pane is bounded to twenty physical rows. Message
 * text wraps by display columns, while work disappears oldest-first. Once there
 * is no older work to remove, message rows scroll into terminal history; every
 * row is written before it leaves the managed pane.
 *
 * Each entry, and each ordinary line, is stamped with the local time the viewer
 * received or emitted it — `HH:mm:ss`, read once and kept for every redraw — and
 * an agent message's own line is drawn in a golden yellow, reset again inside the
 * entry, so commands, results and changed files stay in the terminal's ordinary
 * color. The stamp is the viewer's own clock and nothing more: the runtime's
 * event stream carries no timestamp, so the terminal never implies one. A
 * redirected or too small terminal carries no escape sequences at all; a
 * terminal that asked for no color gets stamped plain output without cursor or
 * styling sequences.
 *
 * It is presentation only. Nothing here is evidence of what a turn did: the full
 * runtime output stays in the turn's own agent log, and every decision is made
 * from the harness's own checks (docs/spec.md §2).
 */
import stringWidth from 'string-width';
import type { AgentActivity } from '../shared/types.js';
import type { CliIo, CliTerminal } from './context.js';
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
 * The pane as the rest of the CLI uses it: ordinary lines follow it, activity
 * goes into it, one invocation's pane becomes a segment of the timeline when it
 * ends, and closing takes the display away again.
 */
export interface ActivityDisplay {
  /**
   * Finalizes retained activity before writing an ordinary timeline block. Each
   * logical line is prefixed once with the local time it reaches the viewer; a
   * line the pane's progress reader recognizes is condensed first, and the run
   * wrote a full record of it in the log either way.
   */
  line(text: string): void;
  /**
   * Writes one error line, or a block of them, on the CLI's own error stream,
   * stamped exactly as `line` stamps the ordinary ones, after retained activity.
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
   * Ends the current invocation, leaving its retained rows in place before
   * anything that follows. Ending again, or having opened nothing, does nothing.
   */
  endInvocation(): void;
  /**
   * Finalizes an open invocation in place and stops drawing it. Called
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
  return height === 0 || columns < MIN_COLUMNS || terminal.color === false
    ? plainDisplay(io, now)
    : paneDisplay(terminal, io.err, now);
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
  terminal: CliTerminal,
  writeError: (line: string) => void,
  now: () => Date,
): ActivityDisplay {
  const write = (text: string): void => terminal.write(text);
  let columns = terminal.columns;
  let rows = terminal.rows;
  let width = (columns ?? FALLBACK_COLUMNS) - 1;
  let height = paneHeight(rows);
  /** The rows of the invocation on screen now; empty between invocations. */
  let groups: ActivityGroup[] = [];
  /** How many pane lines are on screen directly above the cursor. */
  let drawn = 0;
  let closed = false;

  /**
   * Draws the pane where it stands, rewriting its own lines in place.
   *
   * The cursor returns to the pane's first line, every line of the pane's
   * region — the lines it holds now and the lines it held before and no longer
   * does — is cleared from the first column, the lines it still holds are written
   * there, and the cursor is left on the line below the pane's own rows. Only
   * those lines are touched: the display never clears to the end of the screen,
   * so a repaint can never take a line the pane does not own, and a line the
   * pane drew is never written anywhere but in the pane's own region.
   */
  const paint = (): void => {
    const lines = linesOf(groups);
    const region = Math.max(drawn, lines.length);
    if (drawn > 0) {
      write(`\u001b[${String(drawn)}A`);
    }
    for (let index = 0; index < region; index += 1) {
      // Every line the pane rewrites is cleared first, because the row it lands
      // on may be one it drew before: a shorter line must not leave a tail.
      write('\r\u001b[K');
      const text = lines[index];
      if (text === undefined) {
        write('\r\n');
        continue;
      }
      write(`${text}\r\n`);
    }
    // A pane that no longer holds every line of its region leaves the cursor
    // below the cleared lines: bring it back to the line under the pane itself.
    const surplus = region - lines.length;
    if (surplus > 0) {
      write(`\u001b[${String(surplus)}A`);
    }
    // Write every message row before releasing the prefix into terminal history.
    // Only the tail remains cursor-managed; future paints cannot replay or erase
    // the rows above it, even when one message is taller than the whole screen.
    const overflow = Math.max(0, lines.length - height);
    releaseHistory(groups, overflow);
    drawn = lines.length - overflow;
  };

  /**
   * Writes one ordinary block after retained activity, each logical line stamped once
   * with the time the block reached the viewer. A line the progress reader
   * condenses away is left out; one it does not recognize is shown as written.
   */
  const ordinary = (text: string, emit: (line: string) => void, condense: boolean): void => {
    const stamp = displayTime(now());
    const lines: string[] = [];
    for (const logical of text.split(/\r?\n/)) {
      const shown = condense ? interactiveProgress(logical) : logical;
      if (shown === null) {
        continue;
      }
      lines.push(stampLine(shown, stamp));
    }
    if (lines.length === 0) {
      return;
    }
    // Lifecycle output may arrive during a turn (for example on interrupt).
    // Freeze what preceded it; redrawing those rows below it would reverse
    // emission order. Subsequent activity resumes below this block, with only
    // that new segment cursor-managed until the invocation ends.
    finalize();
    for (const line of lines) {
      emit(line);
    }
  };

  /** Writes one ordinary block with no pane on screen to draw under it. */
  const standalone = (text: string, emit: (line: string) => void): void => {
    const stamp = displayTime(now());
    for (const logical of text.split(/\r?\n/)) {
      emit(stampLine(logical, stamp));
    }
  };

  /**
   * Ends the pane on screen. The rows it drew are already this invocation's
   * segment of the timeline and stay exactly where they were written; nothing is
   * erased and no retained row is written a second time. Only the pane's own
   * bookkeeping is let go, so the rows that follow — the next boundary, a
   * lifecycle block, another segment of the same invocation — start below them,
   * and later repaints can reach nothing above their own region.
   */
  const finalize = (): void => {
    groups = [];
    drawn = 0;
  };

  // Even a shrink followed by an expansion between writes can have pushed old
  // rows into scrollback. Forget their positions on the resize itself as well.
  const stopResize = terminal.onResize?.(finalize);

  // A resize can reflow old rows or move them into scrollback. Their physical
  // positions are no longer known, so leave them standing instead of trying to
  // erase or replay them. Only new activity belongs to the next pane segment.
  const refreshSize = (): void => {
    const nextColumns = terminal.columns;
    const nextRows = terminal.rows;
    if (nextColumns !== columns || nextRows !== rows) {
      finalize();
      columns = nextColumns;
      rows = nextRows;
      width = (columns ?? FALLBACK_COLUMNS) - 1;
      height = paneHeight(rows);
    }
  };

  /** Records one logical entry, whose message may occupy several physical rows. */
  const record = (kind: AgentActivity['kind'], lines: string[]): void => {
    if (kind === 'message') {
      groups.push({ message: lines, work: [] });
    } else {
      let group = groups.at(-1);
      if (group === undefined) {
        // Work reported before the turn's first message is still that work: it
        // keeps its own group rather than being placed under a message that
        // came later.
        group = { message: [], work: [] };
        groups.push(group);
      }
      group.work.push(...lines);
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
          write(`${line}\r\n`);
        });
        return;
      }
      ordinary(
        text,
        (line) => {
          write(`${line}\r\n`);
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
      refreshSize();
      if (height === 0 || width < MIN_COLUMNS - 1) {
        write(`${displayTime(now())} ${describe(activity)}\r\n`);
        return;
      }
      // The entry's receive time, read once here: a redraw later draws this very
      // line again, never a freshly stamped one.
      const lines = paneLines(activity, displayTime(now()), width);
      if (closed) {
        for (const line of lines) write(`${line}\r\n`);
        return;
      }
      record(activity.kind, lines);
      paint();
    },
    beginInvocation: (invocation) => {
      refreshSize();
      // The boundary is one emission with one time: what opens a pane reads as
      // logical line of the timeline. It may wrap above the activity rows:
      // only those rows are counted or erased by the cursor-managed pane.
      const boundary = boundaryLine(invocation, displayTime(now()), width);
      if (closed) {
        write(`${boundary}\r\n`);
        return;
      }
      finalize();
      write(`${boundary}\r\n`);
    },
    endInvocation: () => {
      if (!closed) {
        finalize();
      }
    },
    close: () => {
      if (!closed) {
        finalize();
        stopResize?.();
      }
      closed = true;
    },
  };
}

/** One agent message and the work lines that followed it. */
interface ActivityGroup {
  /** Retained physical rows of one message, empty for work seen before one. */
  readonly message: string[];
  /** The group's retained work lines, oldest first. */
  readonly work: string[];
}

/** Every line the history would draw, oldest first. */
function linesOf(groups: readonly ActivityGroup[]): readonly string[] {
  return groups.flatMap((group) => group.message.concat(group.work));
}

/**
 * Drops older work until the history fits, or only messages and newest work remain.
 *
 * The oldest work line goes first, so earlier agent messages stay in order and
 * accumulate one below another as the work between them disappears; a message
 * is released into scrollback only after painting, never discarded here. The
 * row that just arrived is never dropped: work arriving under a history that is
 * already all messages releases the oldest message row instead.
 */
function fitHistory(groups: ActivityGroup[], capacity: number): void {
  let excess =
    groups.reduce((sum, group) => sum + group.message.length + group.work.length, 0) - capacity;
  for (const group of groups) {
    if (excess <= 0) break;
    const removable = group.work.length - (group === groups.at(-1) ? 1 : 0);
    const count = Math.min(excess, Math.max(0, removable));
    group.work.splice(0, count);
    excess -= count;
  }
  // Only a leading work-only group can have become empty.
  if (groups[0]?.message.length === 0 && groups[0].work.length === 0) {
    groups.shift();
  }
}

/** Forget already painted prefix rows without moving or rewriting them. */
function releaseHistory(groups: ActivityGroup[], count: number): void {
  while (count > 0) {
    const group = groups[0];
    if (group === undefined) return;
    const messages = Math.min(count, group.message.length);
    group.message.splice(0, messages);
    count -= messages;
    const work = Math.min(count, group.work.length);
    group.work.splice(0, work);
    count -= work;
    if (group.message.length === 0 && group.work.length === 0) groups.shift();
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
    for (const line of text.split(/\r?\n/)) {
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
 * One logical line with the stamp of the emission it belongs to, including an
 * empty or whitespace-only line. The text after the prefix stays unchanged.
 */
function stampLine(line: string, stamp: string): string {
  return `${stamp} ${line}`;
}

/**
 * The boundary that opens one invocation's pane: the role the phase launched,
 * the ticket when one is known, and what the phase calls itself. It is a row of
 * the timeline in its own right, so consecutive developer, reviewer, and
 * next-ticket panes stay distinguishable in scrollback.
 *
 * A pane too narrow for the whole row gives up its details before its identity:
 * what the phase called itself goes first, then the fences. The role and ticket
 * are never truncated: if necessary this ordinary timeline line wraps above the
 * pane. Cursor movement counts only activity rows below it, so later redraws
 * cannot erase any part of the boundary.
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
  return stringWidth(namedOnly) <= width ? namedOnly : `${stamp} ${named}`;
}

/** A boundary field as safe nonblank terminal text, or `null` when empty. */
function nonBlank(value: string | null | undefined): string | null {
  const trimmed = flatten(value ?? '');
  return trimmed === '' ? null : trimmed;
}

/** One activity entry as plain text: what it is labelled as, and its text. */
function describe(activity: AgentActivity): string {
  return `${LABELS[activity.kind]}: ${flatten(activity.text)}`;
}

/**
 * One activity entry as the pane draws it: the local time the viewer received
 * it, the label, and safe text. Work summaries stay bounded to one row; messages
 * wrap without truncation. Only the first row has a timestamp and label. Each
 * message row resets its own highlight so it cannot color the next work entry.
 */
function paneLines(activity: AgentActivity, stamp: string, width: number): string[] {
  const head = `${stamp} `;
  const text = `${head}${describe(activity)}`;
  if (activity.kind !== 'message') {
    return [truncate(text, width)];
  }
  return wrap(text, width).map((line, index) => {
    const plain = index === 0 ? head : '';
    return `${plain}${MESSAGE_COLOR}${line.slice(plain.length)}${COLOR_RESET}`;
  });
}

/** Wrap by display cells without splitting or dropping a grapheme (or a space). */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  let cells = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = stringWidth(segment);
    if (cells + size > width && line !== '') {
      lines.push(line);
      line = '';
      cells = 0;
    }
    line += segment;
    cells += size;
  }
  lines.push(line);
  return lines;
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
