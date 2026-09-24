/**
 * OperatorInterface presents execution events on the terminal: one chronological timeline, one
 * named rolling pane per active agent invocation, role colors and a plain-stream fallback. It
 * observes the combined event subscription and the separate attributable activity subscription for
 * presentation only, keeps display state in memory and reads no artifacts. Application owns
 * commands, execution startup, recovery and process exit.
 *
 * See docs/operator-interface.md for the contract this module implements.
 */

import type { AgentActivity, EngineEvent, Unsubscribe } from '../task-engine/index.js';
import { createPanes, type PaneRow, type Panes } from './pane.js';
import {
  boundaryText,
  interpret,
  interpretActivity,
  roleStyle,
  type ActivityInterpretation,
  type AgentRole,
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

/**
 * Construction: the combined execution-event subscription, the attributable activity subscription
 * and the terminal to render to.
 */
export type OperatorInterfaceSettings = {
  readonly subscribe: (listener: (event: EngineEvent) => void) => Unsubscribe;
  readonly subscribeActivity: (listener: (activity: AgentActivity) => void) => Unsubscribe;
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

/** One active invocation: the role that styles its rows and the heading that names its pane. */
type ActiveInvocation = {
  readonly role: AgentRole;
  /** The invocation's boundary line, without the current terminal's width applied. */
  readonly heading: string;
};

/** Create the presentation over the supplied subscriptions and terminal capabilities. */
export function createOperatorInterface(settings: OperatorInterfaceSettings): OperatorInterface {
  const { terminal } = settings;
  let started = false;
  let closed = false;
  let styledOutput = false;
  let unsubscribe: Unsubscribe | null = null;
  let unsubscribeActivity: Unsubscribe | null = null;
  let stack: Panes | null = null;
  /** The terminal dimensions the live region was drawn at, or null while nothing is live. */
  let drawnSize: TerminalSize | null = null;
  const invocations = new Map<string, ActiveInvocation>();

  function write(text: string): void {
    if (closed) {
      return;
    }
    try {
      terminal.write(text);
    } catch {
      // The output stream closed; presentation stops rendering to it.
      closed = true;
      stack?.close();
      stack = null;
      drawnSize = null;
    }
  }

  /** The live panes, created on first use. */
  function panes(): Panes {
    stack ??= createPanes({ write, paint: painted, size: () => terminal.size() });
    return stack;
  }

  /** Whether the terminal can carry the live panes right now. */
  function panesUsable(): boolean {
    return terminal.interactive && terminal.color && !closed && panes().usable();
  }

  /** One row's color; plain output never carries styling. */
  function painted(style: Style, text: string): string {
    if (style === 'default' || !terminal.interactive || !terminal.color || closed) {
      return text;
    }
    styledOutput = true;
    return `${styleCodes[style]}${text}${resetStyle}`;
  }

  /**
   * Keep the live region consistent with the terminal: a resize reflows the physical rows, and a
   * terminal without room has none. Either ends the live region without cursor movement; the rows
   * already written stay in scrollback and later activity starts fresh below them.
   */
  function prepareRegion(): void {
    if (drawnSize === null) {
      return;
    }
    const size = terminal.size();
    if (
      size.columns !== drawnSize.columns ||
      size.rows !== drawnSize.rows ||
      !terminal.interactive ||
      !terminal.color
    ) {
      panes().suspend();
      drawnSize = null;
    }
  }

  /** One timeline entry's rows: the first carries the timestamp and label, later rows align. */
  function entryRows(label: string, text: string, style: Style): PaneRow[] {
    const prefix = `${receiptTime()} ${label}`;
    const indent = ' '.repeat(prefix.length + 1);
    return text.split('\n').map((line, index) => ({
      text:
        index === 0
          ? line === ''
            ? prefix
            : `${prefix} ${line}`
          : line === ''
            ? ''
            : `${indent}${line}`,
      style,
    }));
  }

  /** Write one timeline entry above the live panes, or directly when no pane is live. */
  function writeEntry(label: string, text: string, style: Style): void {
    const rows = entryRows(label, text, style);
    if (panesUsable()) {
      panes().progress(rows);
      drawnSize = terminal.size();
      return;
    }
    write(`${rows.map((row) => row.text).join('\n')}\n`);
  }

  /** One message's pane rows: the first carries the timestamp and label, later rows align. */
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

  /** The pane heading row at the terminal's current width. */
  function headingRow(invocation: ActiveInvocation): PaneRow {
    return {
      text: truncate(invocation.heading, terminal.size().columns),
      style: roleStyle(invocation.role),
    };
  }

  /** The invocation's live pane, opened again below scrollback when it has none. */
  function ensurePane(invocationId: string, heading: PaneRow): boolean {
    if (!panes().has(invocationId)) {
      if (!panes().open(invocationId)) {
        return false;
      }
    }
    // A pane suspended by a resize or a plain fallback gets its heading again at this width.
    panes().heading(invocationId, heading);
    return true;
  }

  /** Present one attributable activity entry in its invocation's pane or as a plain line. */
  function presentActivity(activity: ActivityInterpretation): void {
    prepareRegion();
    const known = invocations.get(activity.invocationId);
    const style: Style = activity.activity === 'message' ? roleStyle(known?.role ?? null) : 'grey';
    if (
      known !== undefined &&
      panesUsable() &&
      ensurePane(activity.invocationId, headingRow(known))
    ) {
      const time = receiptTime();
      if (activity.activity === 'message') {
        panes().message(activity.invocationId, messageRows(time, activity.text, style));
      } else {
        panes().work(activity.invocationId, workRow(time, activity.activity, activity.text));
      }
      drawnSize = terminal.size();
      return;
    }
    // Plain lines stay attributable: the agent name identifies the invocation's stream.
    const label = known === undefined ? activity.activity : `${known.role} ${activity.activity}`;
    writeEntry(label, activity.text, style);
  }

  function present(event: EngineEvent): void {
    if (!started || closed) {
      return;
    }
    prepareRegion();
    const interpretation = interpret(event);
    switch (interpretation.kind) {
      case 'boundary': {
        const invocation = {
          role: interpretation.role,
          heading: `${receiptTime()} ${interpretation.role} ${boundaryText(interpretation)}`,
        };
        const heading = headingRow(invocation);
        invocations.set(interpretation.invocationId, invocation);
        if (panesUsable() && ensurePane(interpretation.invocationId, heading)) {
          drawnSize = terminal.size();
          return;
        }
        writeEntry(
          interpretation.role,
          boundaryText(interpretation),
          roleStyle(interpretation.role),
        );
        return;
      }
      case 'end': {
        const id = interpretation.invocationId;
        invocations.delete(id);
        if (!panes().has(id)) {
          return;
        }
        if (panesUsable()) {
          panes().finish(id);
          drawnSize = terminal.size();
        } else {
          panes().drop(id);
        }
        return;
      }
      case 'progress':
        writeEntry(interpretation.label, interpretation.text, interpretation.style);
        return;
    }
  }

  /** Present one received activity packet for its invocation's pane. */
  function presentPacket(packet: AgentActivity): void {
    if (!started || closed) {
      return;
    }
    const activity = interpretActivity(packet);
    if (activity !== null) {
      presentActivity(activity);
    }
  }

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      unsubscribe = settings.subscribe(present);
      unsubscribeActivity = settings.subscribeActivity(presentPacket);
    },
    stop(): void {
      if (!started) {
        return;
      }
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeActivity?.();
      unsubscribeActivity = null;
      stack?.suspend();
      drawnSize = null;
      invocations.clear();
      if (styledOutput) {
        styledOutput = false;
        write(resetStyle);
      }
    },
  };
}
