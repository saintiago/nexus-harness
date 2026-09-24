/**
 * The live activity panes: one named rolling pane per active agent invocation, stacked in start
 * order below the ordinary progress timeline. Each pane holds its boundary heading and the
 * invocation's own activity; a pane is updated by its invocation ID alone, so simultaneous
 * invocations never mix rows. Within a pane, each agent message opens a group that keeps its text
 * and the latest three work entries following it, and work before the first message forms its own
 * group. When a pane fills, older work entries give way first; older message rows leave the live
 * region for terminal scrollback, so message text is never discarded.
 *
 * The stack owns one contiguous live region: the headings and visible rows of every active pane,
 * in start order. A changed pane whose row count is stable is redrawn on its own; a layout change
 * erases the region and writes it again in place, so nothing is duplicated in scrollback. Rows
 * released from a pane are written above the live region, where their timestamps keep them
 * readable; a finished invocation's rows remain there, in place, leaving the remaining panes
 * untouched in meaning and order.
 */

import type { Style } from './presentation.js';

/** One physical pane row: its text and content color. */
export type PaneRow = { readonly text: string; readonly style: Style };

/** The narrowest terminal the panes are usable on. */
export const minimumPaneColumns = 20;

/** Rows kept outside the live panes for ordinary progress. */
const reservedRows = 4;

/** The most rows one pane may occupy, its heading included. */
const maximumPaneRows = 10;

/** Work entries one message group keeps. */
const workEntriesPerGroup = 3;

/** What the panes render with: the output sink, styling and the terminal's current dimensions. */
export type PaneSettings = {
  write(text: string): void;
  paint(style: Style, text: string): string;
  size(): { readonly columns: number; readonly rows: number };
};

/** The live panes of one presentation. */
export type Panes = {
  /** Whether the terminal has room for the panes already active. */
  usable(): boolean;
  /** Whether the terminal has room for one more active pane and the reserved progress rows. */
  canOpen(): boolean;
  /** Open one invocation's pane; false when the terminal has no room for it. */
  open(invocationId: string): boolean;
  /** Whether the invocation currently owns a pane. */
  has(invocationId: string): boolean;
  /** Set the invocation's boundary row as its pane's heading. */
  heading(invocationId: string, row: PaneRow): void;
  /** Add one agent message, opening a new group. */
  message(invocationId: string, rows: readonly PaneRow[]): void;
  /** Add one work entry to the invocation's current group. */
  work(invocationId: string, row: PaneRow): void;
  /** Finish the invocation: its rows stay above the live region, the other panes keep their rows. */
  finish(invocationId: string): void;
  /** Forget the invocation's pane without writing its rows again. */
  drop(invocationId: string): void;
  /** Write one progress entry above the live panes. */
  progress(rows: readonly PaneRow[]): void;
  /** Leave the visible rows where they are and forget the live region; panes stay known. */
  suspend(): void;
  close(): void;
};

/** One active pane's grouped rows. */
type ActivePane = {
  readonly id: string;
  heading: PaneRow | null;
  rows: GroupedRow[];
  groups: number;
  currentGroup: number;
  /** The physical rows this pane's heading and visible rows occupy in the live region. */
  drawn: number;
};

type GroupedRow = PaneRow & { readonly work: boolean; readonly group: number };

/** The rows one pane may show for a terminal of the supplied size and active pane count. */
export function paneRows(size: { readonly rows: number }, activePanes: number): number {
  const available = size.rows - reservedRows;
  return Math.max(1, Math.min(maximumPaneRows, Math.floor(available / Math.max(1, activePanes))));
}

/** Create the live panes over the supplied output capability and terminal dimensions. */
export function createPanes(settings: PaneSettings): Panes {
  const panes: ActivePane[] = [];
  /** Rows released from panes, written above the live region on the next redraw. */
  let released: PaneRow[] = [];
  /** The physical rows the live region currently occupies. */
  let drawn = 0;

  /** The pane of one invocation, or null when it has none. */
  function paneOf(invocationId: string): ActivePane | null {
    return panes.find((pane) => pane.id === invocationId) ?? null;
  }

  /**
   * The pane's visible rows, and the message rows that leave the live region for scrollback: older
   * work entries give way first, then the oldest message rows.
   */
  function windowOf(pane: ActivePane): { visible: PaneRow[]; leaving: PaneRow[] } {
    // The heading is always visible; the content window uses the pane's remaining rows.
    const height = Math.max(1, paneRows(settings.size(), panes.length) - 1);
    while (pane.rows.length > height) {
      const droppable = pane.rows.findIndex((row) => row.work);
      if (droppable === -1) {
        break;
      }
      pane.rows.splice(droppable, 1);
    }
    const windowStart = Math.max(0, pane.rows.length - height);
    const leaving = pane.rows.splice(0, windowStart);
    return { visible: pane.rows, leaving };
  }

  /** The live region's rows, and each pane's own rows in the same order. */
  function liveRows(): { rows: PaneRow[]; ofPane: PaneRow[][] } {
    const rows: PaneRow[] = [];
    const ofPane: PaneRow[][] = [];
    for (const pane of panes) {
      const { visible, leaving } = windowOf(pane);
      released.push(...leaving);
      const paneRows: PaneRow[] = [];
      if (pane.heading !== null) {
        rows.push(pane.heading);
        paneRows.push(pane.heading);
      }
      rows.push(...visible);
      paneRows.push(...visible);
      ofPane.push(paneRows);
    }
    return { rows, ofPane };
  }

  /** Every pane's physical row count for its current heading and visible rows. */
  function countsOf(): number[] {
    return panes.map((pane) => (pane.heading === null ? 0 : 1) + pane.rows.length);
  }

  /** The physical rows the live region occupies right now. */
  function physicalRows(): number {
    return panes.reduce((rows, pane) => rows + pane.drawn, 0);
  }

  /** Write one pane's rows in place, moving over the panes below it and back. */
  function redrawPane(
    index: number,
    ofPane: readonly PaneRow[][],
    counts: readonly number[],
  ): void {
    const below = counts.slice(index + 1).reduce((total, count) => total + count, 0);
    settings.write(`\u001b[${String(below + (counts[index] ?? 0))}A`);
    for (const row of ofPane[index] ?? []) {
      settings.write(`\r\u001b[2K${settings.paint(row.style, row.text)}\r\n`);
    }
    if (below > 0) {
      settings.write(`\u001b[${String(below)}B`);
    }
    recordCounts(counts);
  }

  /** Remember the physical row count each pane occupies after a redraw. */
  function recordCounts(counts: readonly number[]): void {
    for (const [position, pane] of panes.entries()) {
      pane.drawn = counts[position] ?? 0;
    }
  }

  /** Write the released rows, then the supplied prefix rows, then the live panes, in place. */
  function draw(prefix: readonly PaneRow[] = [], changed: string | null = null): void {
    const { rows: live, ofPane } = liveRows();
    const counts = countsOf();
    const index = changed === null ? -1 : panes.findIndex((pane) => pane.id === changed);
    // A changed pane whose row count did not change and that released nothing redraws on its own,
    // so no other pane's rows are touched; any layout change redraws the whole live region.
    if (
      drawn > 0 &&
      released.length === 0 &&
      prefix.length === 0 &&
      index !== -1 &&
      counts.every((count, position) => count === (panes[position]?.drawn ?? 0))
    ) {
      redrawPane(index, ofPane, counts);
      return;
    }
    const settled = released;
    released = [];
    if (drawn > 0) {
      settings.write(`\u001b[${drawn}A`);
      for (let row = 0; row < drawn; row += 1) {
        settings.write('\r\u001b[2K\n');
      }
      settings.write(`\u001b[${drawn}A`);
    }
    for (const row of [...settled, ...prefix, ...live]) {
      settings.write(`\r\u001b[2K${settings.paint(row.style, row.text)}\r\n`);
    }
    // Only the pane rows stay live; everything written before them is scrollback.
    drawn = live.length;
    recordCounts(counts);
  }

  /** Drop the recorded live region without touching the rows already on screen. */
  function forgetLiveRegion(): void {
    for (const pane of panes) {
      // The pane keeps its identity but is drawn again, with a fresh heading, on its next activity.
      pane.heading = null;
      pane.rows = [];
      pane.groups = 0;
      pane.currentGroup = -1;
      pane.drawn = 0;
    }
    released = [];
    drawn = 0;
  }

  /** Whether the terminal has room for one more active pane and the reserved progress rows. */
  function canOpenPane(): boolean {
    if (settings.size().columns < minimumPaneColumns) {
      return false;
    }
    // A pane is named by its heading and shows at least one activity row.
    return paneRows(settings.size(), panes.length + 1) >= 2;
  }

  return {
    usable(): boolean {
      if (settings.size().columns < minimumPaneColumns) {
        return false;
      }
      return paneRows(settings.size(), Math.max(1, panes.length)) >= 2;
    },
    canOpen(): boolean {
      return canOpenPane();
    },
    open(invocationId) {
      if (paneOf(invocationId) !== null) {
        return true;
      }
      if (!canOpenPane()) {
        return false;
      }
      panes.push({
        id: invocationId,
        heading: null,
        rows: [],
        groups: 0,
        currentGroup: -1,
        drawn: 0,
      });
      return true;
    },
    has(invocationId) {
      return paneOf(invocationId) !== null;
    },
    heading(invocationId, row) {
      const pane = paneOf(invocationId);
      if (pane === null) {
        return;
      }
      const named = pane.heading !== null;
      pane.heading = row;
      if (!named) {
        draw();
      }
    },
    message(invocationId, rows) {
      const pane = paneOf(invocationId);
      if (pane === null) {
        return;
      }
      pane.currentGroup = pane.groups;
      pane.groups += 1;
      for (const row of rows) {
        pane.rows.push({ ...row, work: false, group: pane.currentGroup });
      }
      draw([], invocationId);
    },
    work(invocationId, row) {
      const pane = paneOf(invocationId);
      if (pane === null) {
        return;
      }
      if (pane.currentGroup < 0) {
        pane.currentGroup = pane.groups;
        pane.groups += 1;
      }
      pane.rows.push({ ...row, work: true, group: pane.currentGroup });
      keepLatestWork(pane);
      draw([], invocationId);
    },
    finish(invocationId) {
      const index = panes.findIndex((pane) => pane.id === invocationId);
      if (index === -1) {
        return;
      }
      // The finished invocation's rows and those of the panes started before it stay exactly where
      // they are, becoming scrollback; the panes started after it keep their live region below.
      // Their windows are written again, with their headings, when they next report activity.
      panes.splice(0, index + 1);
      drawn = physicalRows();
    },
    drop(invocationId) {
      const index = panes.findIndex((pane) => pane.id === invocationId);
      if (index === -1) {
        return;
      }
      panes.splice(index, 1);
    },
    progress(rows) {
      draw(rows);
    },
    suspend() {
      forgetLiveRegion();
    },
    close() {
      panes.length = 0;
      released = [];
      drawn = 0;
    },
  };
}

/** Keep only the latest work entries of the pane's current group. */
function keepLatestWork(pane: ActivePane): void {
  const groupWork = pane.rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row.work && entry.row.group === pane.currentGroup);
  if (groupWork.length <= workEntriesPerGroup) {
    return;
  }
  const oldest = groupWork[0];
  if (oldest !== undefined) {
    pane.rows.splice(oldest.index, 1);
  }
}
