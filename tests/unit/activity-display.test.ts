/**
 * The terminal's activity pane as presentation only: the lines one agent
 * invocation draws, what opens a pane and what it keeps, and the guarantee that
 * a runtime's own output is text — it can never move the cursor, rewrite the
 * pane, or hide what follows it.
 *
 * A runtime's event stream is untrusted text, and the pane draws with cursor
 * sequences of its own, on a terminal the runtime does not own. So every entry
 * the display receives is flattened before it is written: whole escape
 * sequences and every other control character become spaces (docs/spec.md §12).
 * These cases drive the display over a recorder and a stand-in terminal — no
 * process, no runtime, no provider — and read back the screen the pane's own
 * writes would leave.
 */
import { describe, expect, it } from 'vitest';
import { ACTIVITY_PANE_LINES, createActivityDisplay } from '../../src/cli/activity.js';
import type { CliIo, CliTerminal } from '../../src/cli/context.js';

/**
 * One controlled viewer clock, so a stamped line is comparable. It is built
 * from local components: the pane stamps the viewer's own clock, and the case
 * must not depend on the timezone the gate runs in.
 */
const CLOCK = (): Date => new Date(2026, 8, 23, 9, 30, 0);
const STAMP = '09:30:00';

/** A terminal that records what the pane really wrote to it. */
function fakeTerminal(input: {
  readonly columns?: number;
  readonly rows?: number;
  readonly color?: boolean;
}): CliTerminal & { readonly chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (text) => {
      chunks.push(text);
    },
    columns: input.columns ?? 80,
    rows: input.rows ?? 24,
    color: input.color ?? true,
  };
}

/**
 * What a terminal would show after the pane's own writes: a minimal screen for
 * the pane's cursor vocabulary — one row cleared from its first column, written
 * with a newline, and the cursor moved back up over the rows it owns. The
 * pane's message highlight is styling and not shown. Anything else it wrote —
 * a control character or an escape sequence a runtime got through — is kept as
 * the text a terminal would receive, so a case can see it.
 */
function screenRows(chunks: readonly string[]): readonly string[] {
  const rows: string[] = [];
  const text = chunks.join('');
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('\r\n', index)) {
      cursor += 1;
      index += 2;
      continue;
    }
    if (text[index] === '\r') {
      index += 1;
      continue;
    }
    // eslint-disable-next-line no-control-regex
    const up = /^\u001b\[(\d+)A/.exec(text.slice(index));
    if (up !== null) {
      cursor = Math.max(0, cursor - Number(up[1]));
      index += up[0].length;
      continue;
    }
    if (text.startsWith('\u001b[K', index)) {
      rows[cursor] = '';
      index += '\u001b[K'.length;
      continue;
    }
    if (text.startsWith('\u001b[33m', index) || text.startsWith('\u001b[0m', index)) {
      index += text.startsWith('\u001b[33m', index) ? 5 : 4;
      continue;
    }
    rows[cursor] = `${rows[cursor] ?? ''}${text[index] ?? ''}`;
    index += 1;
  }
  return rows.filter((row) => row !== undefined && row !== '');
}

describe('what the activity pane shows', () => {
  it('sanitizes control characters and escape sequences out of event text', () => {
    const terminal = fakeTerminal({ columns: 80, rows: 24 });
    const pane = createActivityDisplay(
      { out: () => undefined, err: () => undefined, terminal },
      CLOCK,
    );
    pane.activity({
      kind: 'message',
      text: 'first\r\nsecond\u0007 \u001b[31mred\u001b[0m \u001b[2Jthird',
    });
    pane.activity({ kind: 'command', text: 'echo \u001b]0;title\u0007 hi' });

    // Every sequence and control character became a space: the carriage return
    // and the clear-screen do not open a second row, the color codes are gone,
    // and the operating-system command that would rename the window is gone too.
    expect(screenRows(terminal.chunks)).toEqual([
      `${STAMP} agent: first second red third`,
      `${STAMP} run: echo hi`,
    ]);
    // Nothing a runtime wrote reached the terminal as a command of its own: a
    // drawn row carries no escape or control character at all.
    for (const row of screenRows(terminal.chunks)) {
      // eslint-disable-next-line no-control-regex
      expect(row).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(terminal.chunks.join('')).not.toContain('\u001b]');
    expect(terminal.chunks.join('')).not.toContain('\u001b[2J');
    pane.close();
  });

  it('keeps a message and only the latest work lines that followed it', () => {
    const terminal = fakeTerminal({ columns: 80, rows: 24 });
    const pane = createActivityDisplay(
      { out: () => undefined, err: () => undefined, terminal },
      CLOCK,
    );
    pane.activity({ kind: 'message', text: 'working through the steps' });
    for (const step of [1, 2, 3, 4, 5]) {
      pane.activity({ kind: 'command', text: `step ${String(step)}` });
    }

    // The message stays; the work between it and the newest entries is dropped
    // oldest first, and the pane never grows past its own bound.
    expect(screenRows(terminal.chunks)).toEqual([
      `${STAMP} agent: working through the steps`,
      `${STAMP} run: step 3`,
      `${STAMP} run: step 4`,
      `${STAMP} run: step 5`,
    ]);
    expect(screenRows(terminal.chunks).length).toBeLessThanOrEqual(ACTIVITY_PANE_LINES);
    pane.close();
  });

  it('opens a fresh pane with a boundary naming the phase’s role, and inherits no row', () => {
    const terminal = fakeTerminal({ columns: 80, rows: 24 });
    const pane = createActivityDisplay(
      { out: () => undefined, err: () => undefined, terminal },
      CLOCK,
    );
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.endInvocation();
    // The role is the phase that launched the turn, and the ticket is the one
    // the turn works on: both are named by the caller, never inferred.
    pane.beginInvocation({ role: 'reviewer', ticket: 'HARN-11', phase: 'review' });
    pane.activity({ kind: 'message', text: 'reading the diff' });

    expect(screenRows(terminal.chunks)).toEqual([
      `${STAMP} run: npm test`,
      `${STAMP} ---- reviewer: HARN-11 — review ----`,
      `${STAMP} agent: reading the diff`,
    ]);
    pane.close();
  });

  it('draws ordinary stamped lines, and no escape sequence, where it cannot hold a pane', () => {
    for (const terminal of [
      undefined,
      fakeTerminal({ columns: 80, rows: 4 }),
      fakeTerminal({ columns: 19, rows: 24 }),
      fakeTerminal({ columns: 80, rows: 24, color: false }),
    ]) {
      const out: string[] = [];
      const io: CliIo = {
        out: (text) => out.push(text),
        err: () => undefined,
        ...(terminal === undefined ? {} : { terminal }),
      };
      const display = createActivityDisplay(io, CLOCK);
      display.beginInvocation({ role: 'developer', ticket: 'HARN-11' });
      display.activity({ kind: 'message', text: '\u001b[31mchecking\u001b[0m\r\nend\u0007' });

      expect(out).toEqual([
        `${STAMP} ---- developer: HARN-11 ----`,
        `${STAMP} agent: checking end`,
      ]);
      expect(out.join('')).not.toContain('\u001b');
      display.close();
    }
  });
});
