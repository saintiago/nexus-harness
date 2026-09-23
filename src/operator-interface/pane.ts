/**
 * The active invocation's pane: one live view of the current turn, bounded to twenty rows and
 * redrawn in place. Each agent message opens a group that keeps its text and the latest three work
 * entries after it; work before the first message forms its own group. When the pane fills, older
 * work entries anywhere in the pane are dropped first, and rows that still do not fit leave the
 * live region for terminal scrollback, so message text is never discarded. Closing the pane leaves
 * its rows where they are, without erasing them or writing a second copy.
 */

import type { Style } from './presentation.js';

/** One physical pane row: its text and content color. */
export type PaneRow = { readonly text: string; readonly style: Style };

/** The live view of one invocation segment. */
export type PaneSegment = {
  message(rows: readonly PaneRow[]): void;
  work(row: PaneRow): void;
  render(): void;
  close(): void;
};

/** What the pane renders with: the output sink, styling and the terminal's current dimensions. */
export type PaneSettings = {
  write(text: string): void;
  paint(style: Style, text: string): string;
  size(): { readonly columns: number; readonly rows: number };
};

/** The narrowest terminal the pane is usable on. */
export const minimumPaneColumns = 20;

/** Rows kept below the pane for ordinary progress. */
const reservedRows = 4;

/** The pane's row bound. */
const maximumPaneRows = 20;

/** Work entries one message group keeps. */
const workEntriesPerGroup = 3;

/** The pane's height for a terminal of the supplied size; below one row the pane is unusable. */
export function paneHeight(size: { readonly rows: number }): number {
  return Math.min(maximumPaneRows, size.rows - reservedRows);
}

type GroupedRow = PaneRow & { readonly work: boolean; readonly group: number };

/** Create one pane segment for the current invocation. */
export function createPaneSegment(settings: PaneSettings): PaneSegment {
  let rows: GroupedRow[] = [];
  let groups = 0;
  let currentGroup = -1;
  let drawn = 0;

  function keepLatestWork(): void {
    const groupWork = rows
      .map((row, index) => ({ row, index }))
      .filter((entry) => entry.row.work && entry.row.group === currentGroup);
    if (groupWork.length <= workEntriesPerGroup) {
      return;
    }
    const oldest = groupWork[0];
    if (oldest === undefined) {
      return;
    }
    rows.splice(oldest.index, 1);
  }

  return {
    message(messageRows: readonly PaneRow[]): void {
      currentGroup = groups;
      groups += 1;
      for (const row of messageRows) {
        rows.push({ ...row, work: false, group: currentGroup });
      }
    },
    work(row: PaneRow): void {
      if (currentGroup < 0) {
        currentGroup = groups;
        groups += 1;
      }
      rows.push({ ...row, work: true, group: currentGroup });
      keepLatestWork();
    },
    render(): void {
      const height = Math.max(1, paneHeight(settings.size()));
      // Older work entries anywhere in the pane give way before message rows do.
      while (rows.length > height) {
        const droppable = rows.findIndex((row) => row.work);
        if (droppable === -1) {
          break;
        }
        rows.splice(droppable, 1);
      }
      const windowStart = Math.max(0, rows.length - height);
      const committing = rows.slice(0, windowStart);
      const live = rows.slice(windowStart);
      if (drawn > 0) {
        settings.write(`\u001b[${drawn}A`);
        for (let row = 0; row < drawn; row += 1) {
          settings.write('\r\u001b[2K\n');
        }
        settings.write(`\u001b[${drawn}A`);
      }
      for (const row of committing) {
        settings.write(`\r\u001b[2K${settings.paint(row.style, row.text)}\r\n`);
      }
      for (const row of live) {
        settings.write(`\r\u001b[2K${settings.paint(row.style, row.text)}\r\n`);
      }
      // Rows written above the live region are terminal scrollback; the pane keeps only its own view.
      rows = live;
      drawn = live.length;
    },
    close(): void {
      rows = [];
      groups = 0;
      currentGroup = -1;
      drawn = 0;
    },
  };
}
