/**
 * The terminal's activity pane, and the runtime events it is fed from.
 *
 * The display tests drive synthetic activity — no runtime, no run, no process —
 * and read what a terminal would show, not the escape sequences themselves:
 * the writes are replayed through a small screen, so an assertion is about the
 * lines a person would see. Three things are what the tests are about: the pane
 * holds the latest lines instead of growing, redirected output carries ordinary
 * lines and not one cursor sequence, and closing the pane leaves the terminal as
 * it was found.
 *
 * The event tests are the other half: what one `item.started`/`item.completed`
 * event is read as, and what is deliberately not read as activity.
 */
import { describe, expect, it } from 'vitest';
import { itemActivities } from '../src/agents/codex/events.js';
import { createActivityDisplay } from '../src/cli/activity.js';
import { fakeConsole, screenAfter } from './support.js';

const FULL_TERMINAL = { columns: 80, rows: 24 } as const;

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

describe('the activity pane', () => {
  it('keeps the latest ten lines, and stops the screen from growing with the turn', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    pane.line('run run-1: implementation turn started');

    for (let index = 1; index <= 40; index += 1) {
      pane.activity({ kind: 'command', text: `step ${String(index)}` });
      // The screen after every line, not only the last one: a pane that grew
      // would show it here long before the run ended.
      expect(screenAfter(terminal.chunks)).toHaveLength(1 + Math.min(index, 10));
    }

    const screen = screenAfter(terminal.chunks);
    // The task and the phase stay on screen, and the pane below them holds the
    // ten newest lines, oldest first.
    expect(screen[0]).toBe('run run-1: implementation turn started');
    expect(screen.slice(1)).toEqual(
      Array.from({ length: 10 }, (_, offset) => `run: step ${String(offset + 31)}`),
    );
    pane.close();
  });

  it('labels messages, commands, results, and changed files', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    pane.activity({ kind: 'message', text: 'I will adjust the parser.' });
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.activity({ kind: 'result', text: 'exit 1' });
    pane.activity({ kind: 'change', text: 'update src/greet.ts' });

    expect(screenAfter(terminal.chunks)).toEqual([
      'agent: I will adjust the parser.',
      'run: npm test',
      'result: exit 1',
      'change: update src/greet.ts',
    ]);
    pane.close();
  });

  it('sanitizes control characters and escape sequences out of event text', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    pane.activity({
      kind: 'message',
      text: 'first\r\nsecond\u0007 \u001b[31mred\u001b[0m \u001b[2Jthird',
    });
    pane.activity({ kind: 'command', text: 'echo \u001b]0;title\u0007 hi' });

    const [message = '', command = ''] = screenAfter(terminal.chunks);
    expect(message).toBe('agent: first second red third');
    expect(command).toBe('run: echo hi');
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
    const pane = createActivityDisplay(terminal.io);
    pane.activity({ kind: 'message', text: 'x'.repeat(200) });

    const [line = ''] = screenAfter(terminal.chunks);
    expect(line).toHaveLength(39);
    expect(line.startsWith('agent: xxx')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    pane.close();
  });

  it('writes output that arrives by another route above the pane', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    pane.activity({ kind: 'command', text: 'step 1' });
    // Standing in for the CLI's own error stream, which reaches the same
    // console: it must be written above the pane, never into its middle.
    pane.around(() => {
      terminal.chunks.push('sj-1: skipped, not a usable task\n');
    });
    pane.activity({ kind: 'command', text: 'step 2' });

    // The diagnostic takes the pane's old place, directly under the progress,
    // and the pane is drawn again beneath it.
    expect(screenAfter(terminal.chunks)).toEqual([
      'sj-1: skipped, not a usable task',
      'run: step 1',
      'run: step 2',
    ]);
    pane.close();
  });

  it('erases the pane when it closes, and writes plainly afterwards', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    pane.line('run run-1: implementation turn started');
    pane.activity({ kind: 'message', text: 'working on it' });
    pane.close();

    expect(screenAfter(terminal.chunks)).toEqual(['run run-1: implementation turn started']);

    const before = terminal.chunks.length;
    pane.line('run run-1: passed');
    pane.activity({ kind: 'message', text: 'a late line' });
    expect(terminal.chunks.slice(before).join('')).toBe('run run-1: passed\nagent: a late line\n');
    expect(screenAfter(terminal.chunks.slice(before))).toEqual([
      'run run-1: passed',
      'agent: a late line',
    ]);
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
    const pane = createActivityDisplay(terminal.io);
    pane.line('baseline check-round result: passed');
    for (let index = 1; index <= 4; index += 1) {
      pane.activity({ kind: 'command', text: `step ${String(index)}` });
    }

    expect(screenAfter(terminal.chunks)).toEqual([
      'baseline check-round result: passed',
      'run: step 3',
      'run: step 4',
    ]);
    pane.close();
  });

  it('falls back to ordinary lines on a terminal too short or too narrow for one', () => {
    for (const size of [
      { columns: 80, rows: 3 },
      { columns: 10, rows: 24 },
    ]) {
      const terminal = fakeConsole(size);
      const pane = createActivityDisplay(terminal.io);
      pane.activity({ kind: 'message', text: 'plain, please' });

      // Ordinary output, none of the pane's own cursor work.
      expect(terminal.chunks.join('')).toBe('agent: plain, please\n');
      pane.close();
    }
  });

  it('writes readable ordinary lines, with no cursor sequence, when redirected', () => {
    const out: string[] = [];
    const pane = createActivityDisplay({
      out: (text) => out.push(text),
      err: (text) => out.push(text),
    });
    pane.line('run run-1: implementation turn started');
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.activity({ kind: 'message', text: 'the tests are red' });
    pane.around(() => undefined);
    pane.close();

    expect(out).toEqual([
      'run run-1: implementation turn started',
      'run: npm test',
      'agent: the tests are red',
    ]);
    expect(out.join('')).not.toContain('\u001b');
  });

  it('keeps the pane full when the terminal reports no size', () => {
    const terminal = fakeConsole();
    const pane = createActivityDisplay(terminal.io);
    for (let index = 1; index <= 12; index += 1) {
      pane.activity({ kind: 'command', text: `step ${String(index)}` });
    }

    const screen = screenAfter(terminal.chunks);
    expect(screen).toHaveLength(10);
    expect(screen[0]).toBe('run: step 3');
    expect(screen.at(-1)).toBe('run: step 12');
    pane.close();
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
    ).toEqual([{ kind: 'result', text: 'exit 2' }]);
    // No exit code: the runtime's own status word is what is reported.
    expect(
      itemActivities('item.completed', { type: 'command_execution', status: 'failed' }),
    ).toEqual([{ kind: 'result', text: 'failed' }]);
    // Neither an exit code nor a status word: it is still a finished command.
    expect(
      itemActivities('item.completed', { type: 'command_execution', command: 'npm test' }),
    ).toEqual([{ kind: 'result', text: 'finished' }]);
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
});
