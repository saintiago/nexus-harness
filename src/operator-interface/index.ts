/**
 * OperatorInterface presents execution events on the terminal: one chronological timeline, a
 * compact pane for the current agent invocation, role colors and a plain-stream fallback. It
 * observes the supplied event subscription for presentation only, keeps display state in memory
 * and reads no artifacts. Application owns commands, execution startup, recovery and process exit.
 *
 * See docs/operator-interface.md for the contract this module implements.
 */

import type { EngineEvent, Unsubscribe } from '../task-engine/index.js';
import {
  createPaneSegment,
  minimumPaneColumns,
  paneHeight,
  type PaneRow,
  type PaneSegment,
} from './pane.js';
import {
  boundaryText,
  interpret,
  roleStyle,
  type AgentRole,
  type Interpretation,
  type Style,
} from './presentation.js';
import { truncate, wrap } from './text.js';

/** The terminal's current display dimensions. */
export type TerminalSize = { readonly columns: number; readonly rows: number };

/**
 * The terminal output capabilities construction supplies: whether output is an interactive
 * terminal, whether it accepts color styling, its current dimensions and its output sink. Output
 * that is not an interactive, color-capable terminal of sufficient size receives plain lines.
 */
export type TerminalCapabilities = {
  readonly interactive: boolean;
  readonly color: boolean;
  size(): TerminalSize;
  write(text: string): void;
};

/** Construction: the combined execution-event subscription and the terminal to render to. */
export type OperatorInterfaceSettings = {
  readonly subscribe: (listener: (event: EngineEvent) => void) => Unsubscribe;
  readonly terminal: TerminalCapabilities;
};

export interface OperatorInterface {
  start(): void;
  stop(): void;
}

const styleCodes: Record<Exclude<Style, 'default'>, string> = {
  white: '\u001b[37m',
  grey: '\u001b[90m',
  blue: '\u001b[34m',
  yellow: '\u001b[33m',
};
const resetStyle = '\u001b[0m';

/** An entry's local receipt time, formatted HH:mm:ss and kept for the entry's later redraws. */
function receiptTime(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** Create the presentation over the supplied event subscription and terminal capabilities. */
export function createOperatorInterface(settings: OperatorInterfaceSettings): OperatorInterface {
  const { terminal } = settings;
  let started = false;
  let closed = false;
  let styledOutput = false;
  let unsubscribe: Unsubscribe | null = null;
  let activeRole: AgentRole | null = null;
  let segment: PaneSegment | null = null;
  let segmentSize: TerminalSize | null = null;

  function write(text: string): void {
    if (closed) {
      return;
    }
    try {
      terminal.write(text);
    } catch {
      // The output stream closed; presentation stops rendering to it.
      closed = true;
      closeSegment();
    }
  }

  function usablePane(): boolean {
    if (!terminal.interactive || !terminal.color || closed) {
      return false;
    }
    const size = terminal.size();
    return size.columns >= minimumPaneColumns && paneHeight(size) >= 1;
  }

  function styled(style: Style, text: string): string {
    if (!usablePane() || style === 'default') {
      return text;
    }
    styledOutput = true;
    return `${styleCodes[style]}${text}${resetStyle}`;
  }

  /** Write one timeline entry below the pane, timestamped on receipt. */
  function writeEntry(label: string, text: string, style: Style): void {
    const prefix = `${receiptTime()} ${label}`;
    const indent = ' '.repeat(prefix.length + 1);
    const lines = text.split('\n').map((line, index) => {
      if (index === 0) {
        return line === '' ? prefix : `${prefix} ${line}`;
      }
      return line === '' ? '' : `${indent}${line}`;
    });
    write(`${lines.map((line) => styled(style, line)).join('\n')}\n`);
  }

  /** One message's pane rows: the first carries the timestamp and label, later rows align under it. */
  function messageRows(time: string, text: string, style: Style): PaneRow[] {
    const prefix = `${time} message `;
    const indent = ' '.repeat(prefix.length);
    const width = terminal.size().columns - prefix.length;
    return wrap(text, width).map((line, index) => ({
      text: `${index === 0 ? prefix : indent}${line}`,
      style,
    }));
  }

  /** One work entry's pane row: a single row fitted to the terminal with an ellipsis when cut. */
  function workRow(time: string, label: string, text: string): PaneRow {
    const prefix = `${time} ${label} `;
    const width = terminal.size().columns - prefix.length;
    return { text: `${prefix}${truncate(text.replaceAll('\n', ' '), width)}`, style: 'grey' };
  }

  function closeSegment(): void {
    segment?.close();
    segment = null;
    segmentSize = null;
  }

  /** The active segment was started at dimensions the terminal no longer has. */
  function segmentSizeChanged(): boolean {
    if (segment === null || segmentSize === null) {
      return false;
    }
    const size = terminal.size();
    return size.columns !== segmentSize.columns || size.rows !== segmentSize.rows;
  }

  /** The segment for the current invocation, opened at the terminal's current dimensions. */
  function activeSegment(): PaneSegment {
    if (segment === null) {
      segmentSize = terminal.size();
      segment = createPaneSegment({ write, paint: styled, size: () => terminal.size() });
    }
    return segment;
  }

  function presentActivity(activity: Extract<Interpretation, { kind: 'activity' }>): void {
    const style: Style = activity.activity === 'message' ? roleStyle(activeRole) : 'grey';
    if (activeRole !== null && usablePane()) {
      const active = activeSegment();
      const time = receiptTime();
      if (activity.activity === 'message') {
        active.message(messageRows(time, activity.text, style));
      } else {
        active.work(workRow(time, activity.activity, activity.text));
      }
      active.render();
      return;
    }
    writeEntry(activity.activity, activity.text, style);
  }

  function present(event: EngineEvent): void {
    if (!started || closed) {
      return;
    }
    // A resized terminal reflows the pane's physical rows, so the old segment ends here without
    // cursor movement and the next activity opens a fresh segment at the new dimensions.
    if (segmentSizeChanged()) {
      closeSegment();
    }
    const interpretation = interpret(event);
    switch (interpretation.kind) {
      case 'boundary':
        closeSegment();
        activeRole = interpretation.role;
        writeEntry(
          interpretation.role,
          boundaryText(interpretation),
          roleStyle(interpretation.role),
        );
        return;
      case 'activity':
        presentActivity(interpretation);
        return;
      case 'end':
        closeSegment();
        activeRole = null;
        return;
      case 'progress':
        closeSegment();
        writeEntry(interpretation.label, interpretation.text, interpretation.style);
        return;
    }
  }

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      unsubscribe = settings.subscribe(present);
    },
    stop(): void {
      if (!started) {
        return;
      }
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      closeSegment();
      activeRole = null;
      if (styledOutput) {
        styledOutput = false;
        write(resetStyle);
      }
    },
  };
}
