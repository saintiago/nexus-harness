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
import stringWidth from 'string-width';
import { itemActivities } from '../src/agents/codex/events.js';
import { createActivityDisplay } from '../src/cli/activity.js';
import { fakeConsole, screenAfter } from './support.js';

const FULL_TERMINAL = { columns: 80, rows: 24 } as const;
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

/**
 * What the pane draws for one activity entry at `columns`: the label, then as
 * much of the entry as fits while leaving the last column unused, then the
 * ellipsis that marks what was cut. The exact-fit expectations live in the
 * `WIDE_TEXT` cases; this is the model the redraw sweep below is read against.
 */
function fittedEntry(label: string, text: string, columns: number): string {
  const full = `${label}: ${text}`;
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
    const pane = createActivityDisplay(terminal.io);
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
    expect(screen[0]).toBe('run run-1: implementation turn started');
    expect(screen.slice(1)).toEqual(['run: step 38', 'run: step 39', 'run: step 40']);
    pane.close();
  });

  it('starts a new group at every agent message', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    // Work reported before the first message keeps its own group above it.
    pane.activity({ kind: 'command', text: 'early work' });
    pane.activity({ kind: 'message', text: 'I will change one file.' });
    pane.activity({ kind: 'command', text: 'npm test' });
    pane.activity({ kind: 'result', text: 'exit 1 — npm test' });
    pane.activity({ kind: 'message', text: 'The failure is in the parser.' });
    pane.activity({ kind: 'change', text: 'update src/parser.ts' });

    expect(screenAfter(terminal.chunks)).toEqual([
      'run: early work',
      'agent: I will change one file.',
      'run: npm test',
      'result: exit 1 — npm test',
      'agent: The failure is in the parser.',
      'change: update src/parser.ts',
    ]);
    pane.close();
  });

  it('keeps at most the latest three work lines under one message', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    pane.activity({ kind: 'message', text: 'working' });
    for (let index = 1; index <= 5; index += 1) {
      pane.activity({ kind: 'command', text: `step ${String(index)}` });
    }

    expect(screenAfter(terminal.chunks)).toEqual([
      'agent: working',
      'run: step 3',
      'run: step 4',
      'run: step 5',
    ]);
    pane.close();
  });

  it('drops the oldest work lines first, so the messages accumulate in order', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
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
      'agent: message 1',
      'agent: message 2',
      'agent: message 3',
      'run: work 3c',
      'agent: message 4',
      'run: work 4a',
      'run: work 4b',
      'run: work 4c',
      'agent: message 5',
      'run: work 5a',
      'run: work 5b',
      'run: work 5c',
      'agent: message 6',
      'run: work 6a',
      'run: work 6b',
      'run: work 6c',
      'agent: message 7',
      'run: work 7a',
      'run: work 7b',
      'run: work 7c',
    ]);
    pane.close();
  });

  it('scrolls the oldest message once the work lines are gone', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    for (let index = 1; index <= 21; index += 1) {
      pane.activity({ kind: 'message', text: `message ${String(index)}` });
    }

    expect(screenAfter(terminal.chunks)).toEqual(
      Array.from({ length: 20 }, (_, offset) => `agent: message ${String(offset + 2)}`),
    );
    pane.close();
  });

  it('makes room for new work rather than hiding it behind a full history of messages', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    for (let index = 1; index <= 20; index += 1) {
      pane.activity({ kind: 'message', text: `message ${String(index)}` });
    }
    pane.activity({ kind: 'command', text: 'npm test' });

    const screen = screenAfter(terminal.chunks);
    expect(screen).toHaveLength(20);
    expect(screen[0]).toBe('agent: message 2');
    expect(screen.at(-1)).toBe('run: npm test');
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
        const pane = createActivityDisplay(terminal.io);
        pane.activity({ kind: 'message', text: text.repeat(100) });
        const count = Math.floor((columns - 1 - 'agent: '.length - 1) / cells);
        const expected = `agent: ${text.repeat(count)}…`;
        expect(terminal.chunks).toEqual([`${expected}\n`]);
        expect(stringWidth(expected)).toBe(7 + count * cells + 1);
        expect(stringWidth(expected)).toBeLessThan(columns);
        expect(screenAfter(terminal.chunks, columns)).toEqual([expected]);
        pane.close();
        expect(screenAfter(terminal.chunks, columns)).toEqual([]);
      }
    },
  );

  it.each(WIDE_TEXT)(
    'keeps exactly fitting $text intact, including combining marks',
    ({ text, cells }) => {
      const terminal = fakeConsole({ columns: 40, rows: 24 });
      const pane = createActivityDisplay(terminal.io);
      const message = text.repeat(32 / cells);
      pane.activity({ kind: 'message', text: message });
      expect(terminal.chunks).toEqual([`agent: ${message}\n`]);
      expect(stringWidth(`agent: ${message}`)).toBe(39);
      pane.close();
      expect(screenAfter(terminal.chunks, 40)).toEqual([]);
    },
  );

  it('keeps wide activity on one row each across redraws, progress and cleanup', () => {
    const terminal = fakeConsole({ columns: 40, rows: 24 });
    const pane = createActivityDisplay(terminal.io);
    const progress = ['HARN-16: implementation'];
    const latest: string[] = [];
    pane.line(progress[0] ?? '');
    for (let index = 0; index < 30; index += 1) {
      const text = `${String(index)} ${WIDE_PAIR.repeat(40)}`;
      pane.activity({ kind: 'change', text });
      latest.push(fittedEntry('change', text, 40));
      if (latest.length > 3) latest.shift();
      expect(stringWidth(latest.at(-1) ?? '')).toBeLessThan(40);
      expect(screenAfter(terminal.chunks, 40)).toEqual([...progress, ...latest]);
      if (index === 14) {
        pane.line('HARN-16: repair 1');
        progress.push('HARN-16: repair 1');
        pane.around(() => terminal.chunks.push('diagnostic\n'));
        progress.push('diagnostic');
        expect(screenAfter(terminal.chunks, 40)).toEqual([...progress, ...latest]);
      }
    }
    for (const chunk of terminal.chunks) {
      if (!chunk.startsWith('\u001b')) expect(stringWidth(chunk.trimEnd())).toBeLessThan(40);
    }
    pane.close();
    pane.close();
    pane.line('cancelled; log: logs/agent.log');
    expect(screenAfter(terminal.chunks, 40)).toEqual([
      ...progress,
      'cancelled; log: logs/agent.log',
    ]);
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

  it('keeps long redirected Unicode text while sanitizing its controls', () => {
    const out: string[] = [];
    const pane = createActivityDisplay({ out: (text) => out.push(text), err: () => undefined });
    const text = '界👩🏽‍💻e\u0301'.repeat(100);
    pane.activity({ kind: 'message', text: `\u001b[31m${text}\u001b[0m\r\nend\u0007` });
    pane.close();
    expect(out).toEqual([`agent: ${text} end`]);
  });

  it('keeps the full-size bound when the terminal reports no size', () => {
    const terminal = fakeConsole();
    const pane = createActivityDisplay(terminal.io);
    for (let group = 1; group <= 8; group += 1) {
      pane.activity({ kind: 'message', text: `message ${String(group)}` });
      for (const step of ['a', 'b', 'c']) {
        pane.activity({ kind: 'command', text: `work ${String(group)}${step}` });
      }
    }

    const screen = screenAfter(terminal.chunks);
    expect(screen).toHaveLength(20);
    expect(screen[0]).toBe('agent: message 1');
    expect(screen.at(-1)).toBe('run: work 8c');
    pane.close();
  });
});

// ---------------------------------------------------------------------------
// The progress lines the pane sits under
// ---------------------------------------------------------------------------

describe('the progress lines above the pane', () => {
  it('condenses a run’s startup inventory to what a reader follows', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
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
      'HARN-8: reserved; claiming',
      'run run-20260919191843-5b7b4004 started: task "HARN-8" (Preserve Jira response-body read failures)',
      'time limit: 60 min total, 10 min per command',
      'agent: runtime codex, model deepseek-flash',
      'source task: jira HARN-8',
      'workspace prepared at E:\\projects\\nexus-jira-runs\\workspaces\\run-20260919191843-5b7b4004',
      'baseline check-round started: 1 setup command, 1 check',
      'baseline check-round result: passed',
    ]);
    pane.close();
  });

  it('condenses a continuation’s receipt and workspace lines the same way', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
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
      'HARN-8: reserved; continuing workspace ws-20260919191843-5b7b4004 (attempt 2); claiming',
      'continuing workspace ws-20260919191843-5b7b4004 (attempt 2) at ' +
        'E:\\projects\\nexus-jira-runs\\workspaces\\ws-20260919191843-5b7b4004',
      'HARN-8: another reservation already existed, so it was not attempted',
    ]);
    pane.close();
  });

  it('names the runtime alone when the launch prefix names no model', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    pane.line('agent selected: runtime codex, launch prefix ["codex"]');
    // A prefix that cannot be read as an argument array is not guessed at.
    pane.line('agent selected: runtime codex, launch prefix not-json');

    expect(screenAfter(terminal.chunks)).toEqual(['agent: runtime codex', 'agent: runtime codex']);
    pane.close();
  });

  it('leaves a line it does not recognize as it was written', () => {
    const terminal = fakeConsole(FULL_TERMINAL);
    const pane = createActivityDisplay(terminal.io);
    pane.line('implementation turn started');
    pane.line('sj-1: skipped, not a usable task');
    pane.line('post-agent check-round result: failed, 1 of 2 checks passed');

    expect(screenAfter(terminal.chunks)).toEqual([
      'implementation turn started',
      'sj-1: skipped, not a usable task',
      'post-agent check-round result: failed, 1 of 2 checks passed',
    ]);
    pane.close();
  });

  it('keeps every progress line exactly as written when the output is redirected', () => {
    const out: string[] = [];
    const pane = createActivityDisplay({ out: (text) => out.push(text), err: () => undefined });
    const lines = [
      'task deadline set for 2026-09-19T20:18:43.109Z: 3600000 ms of total task time, 600000 ms per configured command',
      'agent selected: runtime codex, launch prefix ["codex","--model","deepseek-flash"]',
      'workspace Git identity configured: user.name=Nexus Agent, user.email=nexus@local, commit.gpgsign=false',
    ];
    for (const line of lines) {
      pane.line(line);
    }
    pane.close();

    expect(out).toEqual(lines);
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
