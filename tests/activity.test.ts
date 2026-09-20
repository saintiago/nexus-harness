/**
 * The terminal's activity pane, and the runtime events it is fed from.
 *
 * The display tests drive synthetic activity — no runtime, no run, no process —
 * and read what a terminal would show, not the escape sequences themselves:
 * the writes are replayed through a small screen, so an assertion is about the
 * lines a person would see. Three things are what the tests are about: the pane
 * holds the latest lines of the invocation it belongs to instead of growing,
 * every entry carries the local time the viewer received it and a message is
 * highlighted and reset, and one timeline holds the finalized panes and the
 * ordinary lifecycle lines in the order they were produced. A redirected
 * terminal carries ordinary lines and not one escape sequence.
 *
 * The event tests are the other half: what one `item.started`/`item.completed`
 * event is read as, and what is deliberately not read as activity.
 */
import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { itemActivities } from '../src/agents/codex/events.js';
import { createActivityDisplay } from '../src/cli/activity.js';
import { fakeConsole, screenAfter } from './support.js';

const FULL_TERMINAL = { columns: 80, rows: 24 } as const;
/**
 * The clock the pane tests run on: one fixed local instant, so every entry is
 * stamped with a known `HH:mm:ss` instead of the wall clock.
 */
const CLOCK = (): Date => new Date(2026, 8, 20, 9, 41, 7);
/** What {@link CLOCK} renders as: the compact local time the pane writes. */
const STAMP = '09:41:07';
/** The pane's own highlight of an agent message: standard yellow. */
const GOLD = '\u001b[33m';
/** The reset inside a highlighted entry, so the color reaches nothing after it. */
const RESET = '\u001b[0m';
/** Two graphemes that each occupy two cells: four cells of one wide pair. */
const WIDE_PAIR = '界👩🏽‍💻';
const WIDE_TEXT = [
  { text: '界', cells: 2 },
  { text: '😀', cells: 2 },
  { text: '👩🏽‍💻', cells: 2 },
  { text: '👨‍👩‍👧‍👦', cells: 2 },
  { text: '🇪🇸', cells: 2 },
  { text: '1️⃣', cells: 2 },
  { text: 'e\u0301', cells: 1 },
] as const;

/** One entry as a screen shows it: the receive time, the label, and the text. */
function stamped(label: string, text: string): string {
  return `${STAMP} ${label}: ${text}`;
}

/** One agent message as the pane writes it: stamped, highlighted, and reset. */
function highlighted(text: string): string {
  return `${STAMP} ${GOLD}agent: ${text}${RESET}`;
}

/** One invocation boundary as the timeline writes it. */
function boundary(role: string, ticket: string, phase?: string): string {
  return `${STAMP} ---- ${role}: ${ticket}${phase === undefined ? '' : ` — ${phase}`} ----`;
}

/**
 * A clock the test owns, and how often the pane has read it: the timestamp is
 * captured once when an entry arrives, never again on a redraw.
 */
function testClock(start: Date): {
  readonly now: () => Date;
  readonly set: (at: Date) => void;
  readonly reads: () => number;
} {
  let at = start;
  let reads = 0;
  return {
    now: () => {
      reads += 1;
      return at;
    },
    set: (next) => {
      at = next;
    },
    reads: () => reads,
  };
}

/** Every line a pane drew, in order: the chunks that are not its cursor work. */
function drawnLines(chunks: readonly string[]): readonly string[] {
  return chunks
    .filter((chunk) => !chunk.startsWith('\u001b'))
    .map((chunk) => chunk.replace(/\n$/, ''));
}

/**
 * What the pane draws for one activity entry at `columns`: the label, then as
 * much of the entry as fits while leaving the last column unused, then the
 * ellipsis that marks what was cut. The timestamp is visible text and is part
 * of the fit. The exact-fit expectations live in the `WIDE_TEXT` cases; this is
 * the model the redraw sweep below is read against.
 */
function fittedEntry(label: string, text: string, columns: number): string {
  const full = stamped(label, text);
  if (stringWidth(full) <= columns - 1) {
    return full;
  }
  let fitted = '';
  let cells = 0;
  for (const { segment } of new Intl.Segmenter().segment(full)) {
    const size = stringWidth(segment);
    if (cells + size > columns - 2) {
      break;
    }
    fitted += segment;
    cells += size;
  }
  return `${fitted}…`;
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

describe('the activity pane', () => {
  it('stops the screen from growing with the turn, and keeps the newest work', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.line('run run-1: implementation turn started');

    for (let index = 1; index <= 40; index += 1) {
      pane.activity({ kind: 'command', text: `step ${String(index)}` });
      // The screen after every line, not only the last one: a pane that grew
      // would show it here long before the run ended.
      expect(screenAfter(terminal.chunks).length).toBeLessThanOrEqual(1 + 20);
    }

    const screen = screenAfter(terminal.chunks);
    // The task and the phase stay on screen, and the pane below them holds the
    // newest work lines, oldest first — one message-less group holds three.
    expect(screen[0]).toBe(`${STAMP} run run-1: implementation turn started`);
    expect(screen.slice(1)).toEqual([
      stamped('run', 'step 38'),
      stamped('run', 'step 39'),
      stamped('run', 'step 40'),
    ]);
    pane.close();
  });

  it('starts a new group at every agent message', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    // Work reported before the first message keeps its own group above it.
    pane.activity({ kind: 'command', text: 'early work' });
    pane.activity({ kind: 'message', text: 'I will change one file.' });
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.activity({ kind: 'result', text: 'exit 1 — npm test' });
    pane.activity({ kind: 'message', text: 'The failure is in the parser.' });
    pane.activity({ kind: 'change', text: 'update src/parser.ts' });

    expect(screenAfter(terminal.chunks)).toEqual([
      stamped('run', 'early work'),
      stamped('agent', 'I will change one file.'),
      stamped('run', 'npm test'),
      stamped('result', 'exit 1 — npm test'),
      stamped('agent', 'The failure is in the parser.'),
      stamped('change', 'update src/parser.ts'),
    ]);
    pane.close();
  });

  it('keeps at most the latest three work lines under one message', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.activity({ kind: 'message', text: 'working' });
    for (let index = 1; index <= 5; index += 1) {
      pane.activity({ kind: 'command', text: `step ${String(index)}` });
    }

    expect(screenAfter(terminal.chunks)).toEqual([
      stamped('agent', 'working'),
      stamped('run', 'step 3'),
      stamped('run', 'step 4'),
      stamped('run', 'step 5'),
    ]);
    pane.close();
  });

  it('drops the oldest work lines first, so the messages accumulate in order', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    for (let group = 1; group <= 7; group += 1) {
      pane.activity({ kind: 'message', text: `message ${String(group)}` });
      for (const step of ['a', 'b', 'c']) {
        pane.activity({ kind: 'command', text: `work ${String(group)}${step}` });
      }
      expect(screenAfter(terminal.chunks).length).toBeLessThanOrEqual(20);
    }

    // Twenty lines exactly: every message is still there, and what the earlier
    // ones no longer carry is the work that followed them.
    expect(screenAfter(terminal.chunks)).toEqual([
      stamped('agent', 'message 1'),
      stamped('agent', 'message 2'),
      stamped('agent', 'message 3'),
      stamped('run', 'work 3c'),
      stamped('agent', 'message 4'),
      stamped('run', 'work 4a'),
      stamped('run', 'work 4b'),
      stamped('run', 'work 4c'),
      stamped('agent', 'message 5'),
      stamped('run', 'work 5a'),
      stamped('run', 'work 5b'),
      stamped('run', 'work 5c'),
      stamped('agent', 'message 6'),
      stamped('run', 'work 6a'),
      stamped('run', 'work 6b'),
      stamped('run', 'work 6c'),
      stamped('agent', 'message 7'),
      stamped('run', 'work 7a'),
      stamped('run', 'work 7b'),
      stamped('run', 'work 7c'),
    ]);
    pane.close();
  });

  it('scrolls the oldest message once the work lines are gone', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    for (let index = 1; index <= 21; index += 1) {
      pane.activity({ kind: 'message', text: `message ${String(index)}` });
    }

    expect(screenAfter(terminal.chunks)).toEqual(
      Array.from({ length: 20 }, (_, offset) => stamped('agent', `message ${String(offset + 2)}`)),
    );
    pane.close();
  });

  it('makes room for new work rather than hiding it behind a full history of messages', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    for (let index = 1; index <= 20; index += 1) {
      pane.activity({ kind: 'message', text: `message ${String(index)}` });
    }
    pane.activity({ kind: 'command', text: 'npm test' });

    const screen = screenAfter(terminal.chunks);
    expect(screen).toHaveLength(20);
    expect(screen[0]).toBe(stamped('agent', 'message 2'));
    expect(screen.at(-1)).toBe(stamped('run', 'npm test'));
    pane.close();
  });

  it('labels messages, commands, results, and changed files', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.activity({ kind: 'message', text: 'I will adjust the parser.' });
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.activity({ kind: 'result', text: 'exit 1' });
    pane.activity({ kind: 'change', text: 'update src/greet.ts' });

    expect(screenAfter(terminal.chunks)).toEqual([
      stamped('agent', 'I will adjust the parser.'),
      stamped('run', 'npm test'),
      stamped('result', 'exit 1'),
      stamped('change', 'update src/greet.ts'),
    ]);
    pane.close();
  });

  it('sanitizes control characters and escape sequences out of event text', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.activity({
      kind: 'message',
      text: 'first\r\nsecond\u0007 \u001b[31mred\u001b[0m \u001b[2Jthird',
    });
    pane.activity({ kind: 'command', text: 'echo \u001b]0;title\u0007 hi' });

    const [message = '', command = ''] = screenAfter(terminal.chunks);
    expect(message).toBe(stamped('agent', 'first second red third'));
    expect(command).toBe(stamped('run', 'echo hi'));
    // Nothing a runtime wrote moved the cursor: what the pane itself drew is
    // the only cursor work in the stream.
    for (const line of [message, command]) {
      // The control range is exactly what a sanitized line must not hold.
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    pane.close();
  });

  it('fits a line to the terminal width, marking what it cut', () => {
    const terminal = fakeConsole({ columns: 40, rows: 24 });
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.activity({ kind: 'message', text: 'x'.repeat(200) });

    const [line = ''] = screenAfter(terminal.chunks);
    expect(line).toHaveLength(39);
    expect(line.startsWith(`${STAMP} agent: xxx`)).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    pane.close();
  });

  it('models physical wrapping, including the reviewed CJK overflow', () => {
    // The old 39-code-unit output occupies 70 cells. A newline-only screen
    // would incorrectly say that moving up one row and erasing cleans it up.
    const oldLine = `agent: ${'界'.repeat(31)}…`;
    expect(stringWidth(oldLine)).toBe(70);
    expect(screenAfter([`${oldLine}\n`], 40)).toEqual([
      `agent: ${'界'.repeat(16)}`,
      `${'界'.repeat(15)}…`,
    ]);
    expect(screenAfter([`${oldLine}\n`, '\u001b[1A\u001b[J'], 40)).toEqual([
      `agent: ${'界'.repeat(16)}`,
    ]);
  });

  it.each(WIDE_TEXT)(
    'fits complete $text graphemes by cells at pane boundaries',
    ({ text, cells }) => {
      // Known fixture widths and exact expected prefixes keep this assertion
      // independent of merely asking the production width library for a bound.
      expect(stringWidth(text)).toBe(cells);
      for (const columns of [20, 40, 80]) {
        const terminal = fakeConsole({ columns, rows: 24 });
        const pane = createActivityDisplay(terminal.io, CLOCK);
        pane.activity({ kind: 'message', text: text.repeat(100) });
        // The stamp and the label are visible text: 09:41:07 and "agent: ",
        // 16 cells of them, are what the rest of the text has to fit behind.
        const head = `${STAMP} agent: `;
        const count = Math.floor((columns - 1 - head.length - 1) / cells);
        const expected = `${head}${text.repeat(count)}…`;
        expect(terminal.chunks).toEqual([`${highlighted(text.repeat(count) + '…')}\n`]);
        expect(stringWidth(expected)).toBe(head.length + count * cells + 1);
        expect(stringWidth(expected)).toBeLessThan(columns);
        expect(screenAfter(terminal.chunks, columns)).toEqual([expected]);
        pane.close();
        // Closing finalizes the pane: the fitted row stays in the timeline
        // exactly once, and nothing is drawn below it any more.
        expect(screenAfter(terminal.chunks, columns)).toEqual([expected]);
      }
    },
  );

  it.each(WIDE_TEXT)(
    'keeps exactly fitting $text intact, including combining marks',
    ({ text, cells }) => {
      // A terminal sized so that the stamp, the label, and the whole repetition
      // reach the pane's last usable cell exactly: nothing may be cut, and the
      // highlight's own escape sequences may not push it over.
      const repeated = Math.floor(32 / cells);
      const columns = `${STAMP} agent: `.length + repeated * cells + 1;
      const terminal = fakeConsole({ columns, rows: 24 });
      const pane = createActivityDisplay(terminal.io, CLOCK);
      const message = text.repeat(repeated);
      pane.activity({ kind: 'message', text: message });
      expect(terminal.chunks).toEqual([`${highlighted(message)}\n`]);
      expect(stringWidth(highlighted(message))).toBe(columns - 1);
      pane.close();
      expect(screenAfter(terminal.chunks, columns)).toEqual([`${STAMP} agent: ${message}`]);
    },
  );

  it('keeps wide activity on one row each across redraws, progress and cleanup', () => {
    const terminal = fakeConsole({ columns: 40, rows: 24 });
    const pane = createActivityDisplay(terminal.io, CLOCK);
    // Every ordinary line carries the emission time too, and the one that
    // reaches the terminal by the error route is written above the pane
    // rather than through the middle of it.
    const progress = [`${STAMP} HARN-16: implementation`];
    const latest: string[] = [];
    pane.line('HARN-16: implementation');
    for (let index = 0; index < 30; index += 1) {
      const text = `${String(index)} ${WIDE_PAIR.repeat(40)}`;
      pane.activity({ kind: 'change', text });
      latest.push(fittedEntry('change', text, 40));
      if (latest.length > 3) latest.shift();
      expect(stringWidth(latest.at(-1) ?? '')).toBeLessThan(40);
      expect(screenAfter(terminal.chunks, 40)).toEqual([...progress, ...latest]);
      if (index === 14) {
        pane.line('HARN-16: repair 1');
        progress.push(`${STAMP} HARN-16: repair 1`);
        pane.error('diagnostic');
        progress.push(`${STAMP} diagnostic`);
        expect(screenAfter(terminal.chunks, 40)).toEqual([...progress, ...latest]);
      }
    }
    for (const chunk of terminal.chunks) {
      if (!chunk.startsWith('\u001b')) expect(stringWidth(chunk.trimEnd())).toBeLessThan(40);
    }
    pane.close();
    pane.close();
    pane.line('cancelled; log: logs/agent.log');
    // The closed display leaves the last pane's rows where they were drawn and
    // writes what follows them, in order, without another cursor move.
    expect(screenAfter(terminal.chunks, 40)).toEqual([
      ...progress,
      ...latest,
      `${STAMP} cancelled; log: logs/agent.log`,
    ]);
  });

  it('writes an error block above the pane, stamped line by line', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.activity({ kind: 'command', text: 'step 1' });
    // The CLI's own error stream reaches the same console: a block written
    // there is stamped like every other line and is drawn above the pane,
    // never into the middle of it.
    pane.error('sj-1: skipped, not a usable task\nand one more line');
    pane.activity({ kind: 'command', text: 'step 2' });

    // The diagnostic takes the pane's old place, directly under the progress,
    // and the pane is drawn again beneath it.
    expect(screenAfter(terminal.chunks)).toEqual([
      `${STAMP} sj-1: skipped, not a usable task`,
      `${STAMP} and one more line`,
      stamped('run', 'step 1'),
      stamped('run', 'step 2'),
    ]);
    pane.close();
  });

  it('finalizes the pane when it closes, and writes later entries without cursor work', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.line('run run-1: implementation turn started');
    pane.activity({ kind: 'message', text: 'working on it' });
    pane.close();

    // What the pane showed is the last segment of the timeline: the cursor work
    // is gone, and the rows stay where a reader can still find them.
    expect(screenAfter(terminal.chunks)).toEqual([
      `${STAMP} run run-1: implementation turn started`,
      stamped('agent', 'working on it'),
    ]);

    const before = terminal.chunks.length;
    pane.line('run run-1: passed');
    pane.activity({ kind: 'message', text: 'a late line' });
    // A line that arrives after the close is still the viewer's own: the time
    // it arrived at, the label, and a message's highlight — no cursor work.
    expect(terminal.chunks.slice(before).join('')).toBe(
      `${STAMP} run run-1: passed\n${highlighted('a late line')}\n`,
    );
    expect(screenAfter(terminal.chunks.slice(before))).toEqual([
      `${STAMP} run run-1: passed`,
      stamped('agent', 'a late line'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The receive time and the message highlight
// ---------------------------------------------------------------------------

describe('the pane’s timestamps and message highlight', () => {
  it('stamps each entry with the compact local time it was received at', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const clock = testClock(new Date(2026, 8, 20, 9, 41, 7));
    const pane = createActivityDisplay(terminal.io, clock.now);
    pane.activity({ kind: 'command', text: 'npm test' });
    clock.set(new Date(2026, 8, 20, 23, 5, 9));
    pane.activity({ kind: 'message', text: 'the tests are red' });

    // Local hours, minutes and seconds, two digits each: a compact clock, not
    // an ISO timestamp and not the runtime's own event time.
    expect(screenAfter(terminal.chunks)).toEqual([
      '09:41:07 run: npm test',
      '23:05:09 agent: the tests are red',
    ]);
    pane.close();
  });

  it('reads its clock once per entry, and keeps that entry’s time across redraws', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const clock = testClock(new Date(2026, 8, 20, 9, 41, 7));
    const pane = createActivityDisplay(terminal.io, clock.now);
    pane.activity({ kind: 'message', text: 'first' });
    clock.set(new Date(2026, 8, 20, 9, 41, 8));
    pane.activity({ kind: 'command', text: 'npm test' });
    expect(clock.reads()).toBe(2);

    // A later progress line redraws the whole history: the first entry keeps
    // the time it arrived at, although the clock has moved on by then, and the
    // progress line itself carries the one time it was emitted at.
    clock.set(new Date(2026, 8, 20, 10, 0, 0));
    pane.line('phase changed');
    expect(screenAfter(terminal.chunks)).toEqual([
      '10:00:00 phase changed',
      '09:41:07 agent: first',
      '09:41:08 run: npm test',
    ]);
    // Three reads: one per activity entry, and one for the progress emission.
    expect(clock.reads()).toBe(3);
    pane.close();
  });

  it('highlights an agent message and resets it, and colors nothing else', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.activity({ kind: 'message', text: 'I will change one file.' });
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.activity({ kind: 'result', text: 'exit 1' });
    pane.activity({ kind: 'change', text: 'update src/a.ts' });

    // Every redraw the pane wrote, oldest first. The message is drawn in the
    // pane's color and reset inside its own line, wherever it appears in the
    // history; a command, a result, and a changed file carry no styling.
    const lines = drawnLines(terminal.chunks);
    expect(lines.at(-4)).toBe(highlighted('I will change one file.'));
    expect(lines.slice(-3)).toEqual([
      stamped('run', 'npm test'),
      stamped('result', 'exit 1'),
      stamped('change', 'update src/a.ts'),
    ]);
    for (const line of lines) {
      expect(line.includes(GOLD)).toBe(line.includes('agent: '));
      if (!line.includes('agent: ')) {
        expect(line).not.toContain('\u001b');
      }
    }
    pane.close();
  });

  it.each([
    { columns: 40, fitted: 22 },
    { columns: 20, fitted: 2 },
  ])(
    'fits the timestamp into a $columns-column pane, where the escapes take no cell',
    ({ columns, fitted }) => {
      const terminal = fakeConsole({ columns, rows: 24 });
      const pane = createActivityDisplay(terminal.io, CLOCK);
      pane.activity({ kind: 'message', text: 'x'.repeat(200) });

      const visible = `${STAMP} ${GOLD}agent: ${'x'.repeat(fitted)}…${RESET}`;
      expect(terminal.chunks).toEqual([`${visible}\n`]);
      // The stamp is part of what had to fit, and the color sequences around
      // the message are not: the line occupies exactly the pane's width.
      expect(screenAfter(terminal.chunks, columns)).toEqual([
        `${STAMP} agent: ${'x'.repeat(fitted)}…`,
      ]);
      expect(stringWidth(visible)).toBe(columns - 1);
      pane.close();
    },
  );

  it('draws the same lines with no escape sequence when the terminal wants no color', () => {
    const terminal = fakeConsole({ ...FULL_TERMINAL, color: false });
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.activity({ kind: 'message', text: 'plain, please' });
    pane.activity({ kind: 'command', text: 'npm test' });

    expect(screenAfter(terminal.chunks)).toEqual([
      stamped('agent', 'plain, please'),
      stamped('run', 'npm test'),
    ]);
    // Still the pane — it redraws in place — but nothing in it needs a reset.
    expect(terminal.chunks.some((chunk) => chunk.startsWith('\u001b'))).toBe(true);
    for (const chunk of drawnLines(terminal.chunks)) {
      // eslint-disable-next-line no-control-regex
      expect(chunk).not.toMatch(/\u001b\[[0-9;]*m/);
    }
    pane.close();
  });
});

// ---------------------------------------------------------------------------
// Terminals that do not get a pane
// ---------------------------------------------------------------------------

describe('a terminal that cannot hold a pane', () => {
  it('uses a shorter pane on a short terminal', () => {
    // Rows minus the space the progress keeps: six rows leave two activity
    // lines, and those two are the newest.
    const terminal = fakeConsole({ columns: 80, rows: 6 });
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.line('baseline check-round result: passed');
    for (let index = 1; index <= 4; index += 1) {
      pane.activity({ kind: 'command', text: `step ${String(index)}` });
    }

    expect(screenAfter(terminal.chunks)).toEqual([
      `${STAMP} baseline check-round result: passed`,
      stamped('run', 'step 3'),
      stamped('run', 'step 4'),
    ]);
    pane.close();
  });

  it('falls back to ordinary lines on a terminal too short or too narrow for one', () => {
    for (const size of [
      { columns: 80, rows: 3 },
      { columns: 10, rows: 24 },
    ]) {
      const terminal = fakeConsole(size);
      const pane = createActivityDisplay(terminal.io, CLOCK);
      pane.activity({ kind: 'message', text: 'plain, please' });

      // Ordinary output, none of the pane's own cursor work.
      expect(terminal.chunks.join('')).toBe(`${STAMP} agent: plain, please\n`);
      pane.close();
    }
  });

  it('writes readable ordinary lines, with no cursor sequence, when redirected', () => {
    const out: string[] = [];
    const pane = createActivityDisplay(
      {
        out: (text) => out.push(text),
        err: (text) => out.push(text),
      },
      CLOCK,
    );
    pane.line('run run-1: implementation turn started');
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.activity({ kind: 'message', text: 'the tests are red' });
    pane.error('the run needs a person');
    pane.beginInvocation({ role: 'developer', ticket: 'HARN-1', phase: 'implementation turn 1' });
    pane.close();

    expect(out).toEqual([
      `${STAMP} run run-1: implementation turn started`,
      stamped('run', 'npm test'),
      stamped('agent', 'the tests are red'),
      `${STAMP} the run needs a person`,
      `${STAMP} ---- developer: HARN-1 — implementation turn 1 ----`,
    ]);
    expect(out.join('')).not.toContain('\u001b');
  });

  it('keeps long redirected Unicode text while sanitizing its controls', () => {
    const out: string[] = [];
    const pane = createActivityDisplay(
      { out: (text) => out.push(text), err: () => undefined },
      CLOCK,
    );
    const text = '界👩🏽‍💻e\u0301'.repeat(100);
    pane.activity({ kind: 'message', text: `\u001b[31m${text}\u001b[0m\r\nend\u0007` });
    pane.close();
    expect(out).toEqual([`${STAMP} agent: ${text} end`]);
  });

  it.each([
    { name: 'redirected', size: undefined },
    { name: 'too short', size: { columns: 80, rows: 3 } },
    { name: 'too narrow', size: { columns: 10, rows: 24 } },
  ])('stamps every $name entry once, including after close', ({ size }) => {
    const terminal = fakeConsole(size);
    const clock = testClock(new Date(2026, 8, 20, 23, 59, 59));
    const io = size === undefined ? { out: terminal.io.out, err: terminal.io.err } : terminal.io;
    const pane = createActivityDisplay(io, clock.now);
    expect(clock.reads()).toBe(0);
    pane.activity({ kind: 'message', text: '\u001b[31mchecking\u001b[0m' });
    clock.set(new Date(2026, 8, 21, 0, 0, 0));
    pane.activity({ kind: 'command', text: 'npm test' });
    clock.set(new Date(2026, 8, 21, 0, 0, 1));
    pane.activity({ kind: 'result', text: 'exit 0' });
    // One emission, one read: a block of two lines carries the same stamp on
    // each of its logical lines, and the line that goes to the error stream is
    // stamped exactly as the ordinary ones are.
    pane.line('phase changed\nand the next phase');
    pane.error('diagnostic');
    pane.close();
    expect(clock.reads()).toBe(5);
    clock.set(new Date(2026, 8, 21, 0, 0, 2));
    pane.activity({ kind: 'change', text: 'update src/a.ts' });
    expect(clock.reads()).toBe(6);
    expect(terminal.chunks.join('')).toBe(
      '23:59:59 agent: checking\n' +
        '00:00:00 run: npm test\n' +
        '00:00:01 result: exit 0\n' +
        '00:00:01 phase changed\n' +
        '00:00:01 and the next phase\n' +
        '00:00:01 diagnostic\n' +
        '00:00:02 change: update src/a.ts\n',
    );
    expect(terminal.chunks.join('')).not.toContain('\u001b');
  });

  it('keeps the full-size bound when the terminal reports no size', () => {
    const terminal = fakeConsole();
    const pane = createActivityDisplay(terminal.io, CLOCK);
    for (let group = 1; group <= 8; group += 1) {
      pane.activity({ kind: 'message', text: `message ${String(group)}` });
      for (const step of ['a', 'b', 'c']) {
        pane.activity({ kind: 'command', text: `work ${String(group)}${step}` });
      }
    }

    const screen = screenAfter(terminal.chunks);
    expect(screen).toHaveLength(20);
    expect(screen[0]).toBe(stamped('agent', 'message 1'));
    expect(screen.at(-1)).toBe(stamped('run', 'work 8c'));
    pane.close();
  });
});

// ---------------------------------------------------------------------------
// One timeline: the invocation panes, their boundaries, and what lies between
// ---------------------------------------------------------------------------

describe('the invocation timeline', () => {
  it('keeps developer, reviewer, and next developer panes separate and in order', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);

    pane.beginInvocation({ role: 'developer', ticket: 'HARN-1', phase: 'implementation turn 1' });
    pane.activity({ kind: 'message', text: 'the first ticket needs a parser' });
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.activity({ kind: 'message', text: 'one file is wrong' });
    pane.activity({ kind: 'command', text: 'npm run validate' });
    pane.endInvocation();
    pane.line('HARN-1: implementation turn 1 result: completed');
    pane.line('HARN-1: post-agent check-round result: passed');

    pane.beginInvocation({ role: 'reviewer', ticket: 'HARN-1', phase: 'review' });
    pane.activity({ kind: 'message', text: 'Nexus Lens is reading the diff' });
    pane.activity({ kind: 'change', text: 'review: no file changed' });
    pane.endInvocation();
    pane.line('HARN-1: Nexus Lens approved it');

    pane.beginInvocation({ role: 'developer', ticket: 'HARN-2', phase: 'implementation turn 1' });
    pane.activity({ kind: 'message', text: 'the next ticket starts fresh' });
    pane.endInvocation();
    pane.close();

    // One timeline, in the order it was produced: each invocation's boundary,
    // then its retained rows, then the lifecycle lines that followed it, and
    // then the next invocation — never a row of one pane under another.
    expect(screenAfter(terminal.chunks)).toEqual([
      boundary('developer', 'HARN-1', 'implementation turn 1'),
      stamped('agent', 'the first ticket needs a parser'),
      stamped('run', 'npm test'),
      stamped('agent', 'one file is wrong'),
      stamped('run', 'npm run validate'),
      `${STAMP} HARN-1: implementation turn 1 result: completed`,
      `${STAMP} HARN-1: post-agent check-round result: passed`,
      boundary('reviewer', 'HARN-1', 'review'),
      stamped('agent', 'Nexus Lens is reading the diff'),
      stamped('change', 'review: no file changed'),
      `${STAMP} HARN-1: Nexus Lens approved it`,
      boundary('developer', 'HARN-2', 'implementation turn 1'),
      stamped('agent', 'the next ticket starts fresh'),
    ]);

    // Each boundary is its own row of the stream, written once, and only agent
    // messages carry the highlight.
    const raw = terminal.chunks.join('');
    for (const role of ['developer', 'reviewer']) {
      expect(raw.split(`---- ${role}:`).length - 1).toBe(role === 'developer' ? 2 : 1);
    }
    expect(raw).toContain(`${STAMP} ${GOLD}agent: the next ticket starts fresh${RESET}`);
  });

  it('bounds each invocation at twenty rows and opens the next one empty', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);

    pane.beginInvocation({ role: 'developer', ticket: 'HARN-1', phase: 'implementation turn 1' });
    for (let index = 1; index <= 25; index += 1) {
      pane.activity({ kind: 'message', text: `developer message ${String(index)}` });
      // The boundary plus a pane bounded at twenty rows: the screen never grows
      // past the invocation's own pane while it is the one being managed.
      expect(screenAfter(terminal.chunks).length).toBeLessThanOrEqual(21);
    }
    pane.endInvocation();

    // What the pane left in the timeline is its last twenty rows, in order.
    const first = screenAfter(terminal.chunks);
    expect(first).toEqual([
      boundary('developer', 'HARN-1', 'implementation turn 1'),
      ...Array.from({ length: 20 }, (_, offset) =>
        stamped('agent', `developer message ${String(offset + 6)}`),
      ),
    ]);

    pane.beginInvocation({ role: 'reviewer', ticket: 'HARN-1', phase: 'review' });
    pane.activity({ kind: 'message', text: 'the review pane holds its own row' });
    // The next pane inherits nothing: the rows above it are the finalized
    // segment of the invocation before it, and the pane holds one row.
    expect(screenAfter(terminal.chunks)).toEqual([
      ...first,
      boundary('reviewer', 'HARN-1', 'review'),
      stamped('agent', 'the review pane holds its own row'),
    ]);
    pane.endInvocation();
    pane.close();
  });

  it.each([
    { name: 'redirected', size: undefined },
    { name: 'too narrow', size: { columns: 10, rows: 24 } },
    { name: 'too short', size: { columns: 80, rows: 3 } },
  ])('keeps the boundaries, the stamps and no escape sequence on a $name terminal', ({ size }) => {
    const terminal = fakeConsole(size);
    const io = size === undefined ? { out: terminal.io.out, err: terminal.io.err } : terminal.io;
    const pane = createActivityDisplay(io, CLOCK);

    pane.beginInvocation({ role: 'developer', ticket: 'HARN-1', phase: 'implementation turn 1' });
    pane.activity({ kind: 'message', text: 'implementing' });
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.endInvocation();
    pane.error('HARN-1: the coding attempt ended failed and needs a person');
    pane.beginInvocation({ role: 'reviewer', ticket: 'HARN-1', phase: 'review' });
    pane.activity({ kind: 'message', text: 'reviewing' });
    pane.endInvocation();
    pane.close();

    expect(terminal.chunks.join('')).toBe(
      [
        boundary('developer', 'HARN-1', 'implementation turn 1'),
        stamped('agent', 'implementing'),
        stamped('run', 'npm test'),
        `${STAMP} HARN-1: the coding attempt ended failed and needs a person`,
        boundary('reviewer', 'HARN-1', 'review'),
        stamped('agent', 'reviewing'),
      ].join('\n') + '\n',
    );
    expect(terminal.chunks.join('')).not.toContain('\u001b');
  });

  it('keeps the boundaries and the stamps, and no styling, when no color was asked for', () => {
    const terminal = fakeConsole({ ...FULL_TERMINAL, color: false });
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.beginInvocation({ role: 'reviewer', ticket: 'HARN-3', phase: 'review' });
    pane.activity({ kind: 'message', text: 'reading the diff' });
    pane.endInvocation();
    pane.line('HARN-3: Nexus Lens approved it');
    pane.close();

    // The pane still redraws in place, and every row it draws says when it
    // arrived; what is gone is the styling (HARN-18).
    const raw = terminal.chunks.join('');
    expect(raw).toContain('\u001b[');
    // eslint-disable-next-line no-control-regex
    expect(raw).not.toMatch(/\u001b\[[0-9;]*m/);
    expect(screenAfter(terminal.chunks)).toEqual([
      boundary('reviewer', 'HARN-3', 'review'),
      stamped('agent', 'reading the diff'),
      `${STAMP} HARN-3: Nexus Lens approved it`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The progress lines the pane sits under
// ---------------------------------------------------------------------------

describe('the progress lines above the pane', () => {
  it('condenses a run’s startup inventory to what a reader follows', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    // The exact lines the source coordinator and the runner write, in order.
    const lines = [
      'HARN-8: reserved (E:\\projects\\nexus-jira-runs\\.intake\\receipts\\4008ea048f55a8edacd91d163b73d9f79772881e8bc40b590a47b977b3346c3a.json); claiming 10117',
      'run run-20260919191843-5b7b4004 started: task "HARN-8" (Preserve Jira response-body read failures)',
      'task deadline set for 2026-09-19T20:18:43.109Z: 3600000 ms of total task time, 600000 ms per configured command',
      'agent selected: runtime codex, launch prefix ["C:/Users/User/.codex/packages/standalone/current/bin/codex.exe","--profile","nexus-flash","--model","deepseek-flash"]',
      'source task: jira HARN-8 https://malton-family.atlassian.net/browse/HARN-8 (immutable id 10117, revision 2026-09-19T19:55:47.688+0200)',
      'workspace prepared at E:\\projects\\nexus-jira-runs\\workspaces\\run-20260919191843-5b7b4004 on branch harness/run-20260919191843-5b7b4004 at df5769de5f5678896f85b0abe72111b98105d0f9',
      'workspace Git identity configured: user.name=Nexus Agent, user.email=nexus@local, commit.gpgsign=false',
      'baseline check-round started: 1 setup command, 1 check',
      'baseline check-round result: passed',
    ];
    for (const line of lines) {
      pane.line(line);
    }

    expect(screenAfter(terminal.chunks)).toEqual([
      `${STAMP} HARN-8: reserved; claiming`,
      `${STAMP} run run-20260919191843-5b7b4004 started: task "HARN-8" (Preserve Jira response-body read failures)`,
      `${STAMP} time limit: 60 min total, 10 min per command`,
      `${STAMP} agent: runtime codex, model deepseek-flash`,
      `${STAMP} source task: jira HARN-8`,
      `${STAMP} workspace prepared at E:\\projects\\nexus-jira-runs\\workspaces\\run-20260919191843-5b7b4004`,
      `${STAMP} baseline check-round started: 1 setup command, 1 check`,
      `${STAMP} baseline check-round result: passed`,
    ]);
    pane.close();
  });

  it('condenses a continuation’s receipt and workspace lines the same way', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.line(
      'HARN-8: reserved (E:\\projects\\nexus-jira-runs\\.intake\\receipts\\4008ea04.json); ' +
        'continuing workspace ws-20260919191843-5b7b4004 (attempt 2); claiming 10117',
    );
    pane.line(
      'continuing workspace ws-20260919191843-5b7b4004 (attempt 2) at ' +
        'E:\\projects\\nexus-jira-runs\\workspaces\\ws-20260919191843-5b7b4004 on branch ' +
        'harness/ws-20260919191843-5b7b4004 at df5769de5f5678896f85b0abe72111b98105d0f9',
    );
    pane.line(
      'HARN-8: another reservation already existed, so it was not attempted ' +
        '(E:\\projects\\nexus-jira-runs\\.intake\\receipts\\4008ea04.json)',
    );

    expect(screenAfter(terminal.chunks)).toEqual([
      `${STAMP} HARN-8: reserved; continuing workspace ws-20260919191843-5b7b4004 (attempt 2); claiming`,
      `${STAMP} continuing workspace ws-20260919191843-5b7b4004 (attempt 2) at ` +
        'E:\\projects\\nexus-jira-runs\\workspaces\\ws-20260919191843-5b7b4004',
      `${STAMP} HARN-8: another reservation already existed, so it was not attempted`,
    ]);
    pane.close();
  });

  it('names the runtime alone when the launch prefix names no model', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.line('agent selected: runtime codex, launch prefix ["codex"]');
    // A prefix that cannot be read as an argument array is not guessed at.
    pane.line('agent selected: runtime codex, launch prefix not-json');

    expect(screenAfter(terminal.chunks)).toEqual([
      `${STAMP} agent: runtime codex`,
      `${STAMP} agent: runtime codex`,
    ]);
    pane.close();
  });

  it('leaves a line it does not recognize as it was written', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io, CLOCK);
    pane.line('implementation turn started');
    pane.line('sj-1: skipped, not a usable task');
    pane.line('post-agent check-round result: failed, 1 of 2 checks passed');

    expect(screenAfter(terminal.chunks)).toEqual([
      `${STAMP} implementation turn started`,
      `${STAMP} sj-1: skipped, not a usable task`,
      `${STAMP} post-agent check-round result: failed, 1 of 2 checks passed`,
    ]);
    pane.close();
  });

  it('stamps every progress line once and leaves it as written when the output is redirected', () => {
    const out: string[] = [];
    const pane = createActivityDisplay(
      { out: (text) => out.push(text), err: () => undefined },
      CLOCK,
    );
    const lines = [
      'task deadline set for 2026-09-19T20:18:43.109Z: 3600000 ms of total task time, 600000 ms per configured command',
      'agent selected: runtime codex, launch prefix ["codex","--model","deepseek-flash"]',
      'workspace Git identity configured: user.name=Nexus Agent, user.email=nexus@local, commit.gpgsign=false',
    ];
    for (const line of lines) {
      pane.line(line);
    }
    pane.close();

    // Nothing is condensed away here — the redirected stream is the only record
    // a reader has — and every line carries the time it reached it.
    expect(out).toEqual(lines.map((line) => `${STAMP} ${line}`));
  });
});

// ---------------------------------------------------------------------------
// What the runtime's stream is read as
// ---------------------------------------------------------------------------

describe('reading activity from the runtime event stream', () => {
  it('announces a command when it starts and reports its result when it ends', () => {
    expect(
      itemActivities('item.started', { type: 'command_execution', command: 'npm test' }),
    ).toEqual([{ kind: 'command', text: 'npm test' }]);
    expect(
      itemActivities('item.completed', {
        type: 'command_execution',
        command: 'npm test',
        exit_code: 2,
      }),
    ).toEqual([{ kind: 'result', text: 'exit 2 — npm test' }]);
    // No exit code: the runtime's own status word is what is reported.
    expect(
      itemActivities('item.completed', { type: 'command_execution', status: 'failed' }),
    ).toEqual([{ kind: 'result', text: 'failed' }]);
    // Neither an exit code nor a status word: it is still a finished command.
    expect(
      itemActivities('item.completed', { type: 'command_execution', command: 'npm test' }),
    ).toEqual([{ kind: 'result', text: 'finished — npm test' }]);
  });

  it('reports what the command said, when it said anything', () => {
    expect(
      itemActivities('item.completed', {
        type: 'command_execution',
        command: 'npm test',
        exit_code: 1,
        aggregated_output: 'FAIL src/a.test.ts\n  expected 1 to be 2\n\nTests  1 failed\n',
      }),
    ).toEqual([
      {
        kind: 'result',
        // The last nonblank line: where a summary or an error usually is.
        text: 'exit 1 — npm test — Tests 1 failed',
      },
    ]);
    // A successful command with output says what it observed, too.
    expect(
      itemActivities('item.completed', {
        type: 'command_execution',
        command: 'git status --short',
        exit_code: 0,
        aggregated_output: ' M src/greet.ts\n',
      }),
    ).toEqual([{ kind: 'result', text: 'exit 0 — git status --short — M src/greet.ts' }]);
    // Missing, empty, or unreadable output is not an excerpt.
    for (const output of [undefined, '', '   \n\n', 7]) {
      expect(
        itemActivities('item.completed', {
          type: 'command_execution',
          command: 'npm test',
          exit_code: 0,
          aggregated_output: output,
        }),
      ).toEqual([{ kind: 'result', text: 'exit 0 — npm test' }]);
    }
  });

  it('shows the payload of a PowerShell launcher instead of its own path', () => {
    const launcher =
      '"C:\\Users\\User\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies' +
      '\\native\\powershell\\pwsh.exe"';
    const payload = `'npm run validate'`;
    expect(
      itemActivities('item.started', {
        type: 'command_execution',
        command: `${launcher} -Command ${payload}`,
      }),
    ).toEqual([{ kind: 'command', text: payload }]);
    // The same launcher on a completion: the operation is named by its payload,
    // and the exit code and the excerpt are still there beside it.
    expect(
      itemActivities('item.completed', {
        type: 'command_execution',
        command: `${launcher} -NoProfile -Command ${payload}`,
        exit_code: 2,
        aggregated_output: 'src/a.ts(3,1): error TS2322: Type mismatch\n',
      }),
    ).toEqual([
      {
        kind: 'result',
        text: "exit 2 — 'npm run validate' — src/a.ts(3,1): error TS2322: Type mismatch",
      },
    ]);
  });

  it('shows the payload of the other launchers it recognizes, quoting and all', () => {
    const cases = [
      ['pwsh -NoProfile -c "npm test"', '"npm test"'],
      ['pwsh.exe -Command "git commit -m \'x\'"', '"git commit -m \'x\'"'],
      ['cmd.exe /d /s /c "npm test"', '"npm test"'],
      ['/bin/zsh -lc "git status --short"', '"git status --short"'],
      ['bash -ec "npm run validate"', '"npm run validate"'],
      ['bash -l -e -c "npm test"', '"npm test"'],
      ['PowerShell.exe -NoLogo -NonInteractive -NoProfile -Command "npm test"', '"npm test"'],
      ['cmd.exe /D /S /C "npm test"', '"npm test"'],
    ] as const;
    for (const [command, payload] of cases) {
      expect(itemActivities('item.started', { type: 'command_execution', command })).toEqual([
        { kind: 'command', text: payload },
      ]);
    }
  });

  it('shows the payload before bounding it, so a long path cannot hide the operation', () => {
    const launcher = `"C:\\Users\\User\\.cache\\${'codex-runtimes\\'.repeat(12)}pwsh.exe"`;
    const payload = `npm run validate -- --filter ${'x'.repeat(500)}`;
    const [command] = itemActivities('item.started', {
      type: 'command_execution',
      command: `${launcher} -Command '${payload}'`,
    });
    expect(command?.kind).toBe('command');
    expect(command?.text.startsWith("'npm run validate -- --filter")).toBe(true);
    expect(command?.text).not.toContain('pwsh.exe');
    expect(command?.text.length).toBeLessThanOrEqual(401);
    expect(command?.text.endsWith('…')).toBe(true);
  });

  it.each([
    'pwsh -NoProfile -File build.ps1 -Command smoke',
    'powershell.exe -File "build script.ps1" -c smoke',
    'pwsh -f build.ps1 -Command smoke',
    'pwsh build.ps1 -Command smoke',
    'pwsh -NoProfile build.ps1 -c smoke',
    'bash build.sh -c smoke',
    'bash -e "build script.sh" -lc smoke',
    'sh -- build.sh -c smoke',
    'cmd.exe /d build.cmd /c smoke',
    'cmd.exe /k build.cmd /c smoke',
    'pwsh -ExecutionPolicy Bypass -Command smoke',
    'pwsh -Unknown -Command smoke',
    'bash -o -c smoke',
    'bash --rcfile -c smoke',
    'bash -oc smoke',
    'bash -C smoke',
    'bash -ic smoke',
    'cmd.exe /unknown /c smoke',
  ])('retains the original command for an uncertain launch shape: %s', (command) => {
    expect(itemActivities('item.started', { type: 'command_execution', command })).toEqual([
      { kind: 'command', text: command },
    ]);
    expect(
      itemActivities('item.completed', {
        type: 'command_execution',
        command,
        exit_code: 0,
        aggregated_output: 'smoke finished\n',
      }),
    ).toEqual([{ kind: 'result', text: `exit 0 — ${command} — smoke finished` }]);
  });

  it('bounds script-argument fallbacks without extracting their command-like flags', () => {
    const command = `pwsh -File build.ps1 -Command ${'x'.repeat(500)}`;
    expect(itemActivities('item.started', { type: 'command_execution', command })).toEqual([
      { kind: 'command', text: `${command.slice(0, 400)}…` },
    ]);
    expect(
      itemActivities('item.completed', { type: 'command_execution', command, exit_code: 1 }),
    ).toEqual([{ kind: 'result', text: `exit 1 — ${command.slice(0, 160)}…` }]);
  });

  it('falls back to the command line it was given for a shape it does not know', () => {
    // A program that is not one of the recognized launchers, even when a flag
    // looks like one: the line is shown as it was reported.
    const unknown = 'nerdctl.exe run --rm -v "C:\\a b\\tools" --command test image';
    expect(itemActivities('item.started', { type: 'command_execution', command: unknown })).toEqual(
      [{ kind: 'command', text: unknown }],
    );
    // A recognized launcher whose flag is missing is not read as a wrapper.
    const noFlag = '"C:\\tools\\pwsh.exe" -NoProfile -File build.ps1';
    expect(itemActivities('item.started', { type: 'command_execution', command: noFlag })).toEqual([
      { kind: 'command', text: noFlag },
    ]);
    // And an unknown line longer than the activity bound is bounded, not shown
    // in full.
    const long = `node -e "${'x'.repeat(500)}"`;
    const [bounded] = itemActivities('item.started', {
      type: 'command_execution',
      command: long,
    });
    expect(bounded?.text).toBe(`${long.slice(0, 400)}…`);
  });

  it('reads a message only once, when the item is complete', () => {
    expect(itemActivities('item.started', { type: 'agent_message', text: 'hi' })).toEqual([]);
    expect(itemActivities('item.completed', { type: 'agent_message', text: 'hi\n there' })).toEqual(
      [{ kind: 'message', text: 'hi there' }],
    );
  });

  it('reads every changed file of a completed file-change item', () => {
    expect(
      itemActivities('item.completed', {
        type: 'file_change',
        changes: [
          { path: 'src/a.ts', kind: 'update' },
          { path: 'src/b.ts', kind: 'add' },
          { path: 'src/c.ts' },
        ],
      }),
    ).toEqual([
      { kind: 'change', text: 'update src/a.ts' },
      { kind: 'change', text: 'add src/b.ts' },
      { kind: 'change', text: 'src/c.ts' },
    ]);
  });

  it('reads nothing from items that are not activity', () => {
    expect(itemActivities('item.completed', { type: 'reasoning', text: 'thinking' })).toEqual([]);
    expect(itemActivities('item.completed', { type: 'todo_list', items: [] })).toEqual([]);
    expect(
      itemActivities('item.started', { type: 'file_change', changes: [{ path: 'a.ts' }] }),
    ).toEqual([]);
    expect(itemActivities('item.completed', { type: 'agent_message' })).toEqual([]);
    expect(itemActivities('item.completed', 'not an item')).toEqual([]);
    expect(itemActivities('item.completed', null)).toEqual([]);
  });

  it('bounds a long command or message to one line', () => {
    const [command] = itemActivities('item.started', {
      type: 'command_execution',
      command: `line one\n${'x'.repeat(500)}`,
    });
    expect(command?.kind).toBe('command');
    expect(command?.text.startsWith('line one xxx')).toBe(true);
    expect(command?.text.length).toBeLessThanOrEqual(401);
    expect(command?.text).not.toContain('\n');
  });

  it.each(WIDE_TEXT)('does not split $text at the event summary size limit', ({ text }) => {
    const [activity] = itemActivities('item.completed', {
      type: 'agent_message',
      text: `${'x'.repeat(399)}${text}tail`,
    });
    expect(activity?.text).toBe(`${'x'.repeat(399)}${text.length === 1 ? text : ''}…`);
  });
});
