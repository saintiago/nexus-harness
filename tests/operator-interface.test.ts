/**
 * Component tests: the real OperatorInterface presents supplied execution events on a controlled
 * terminal. A small screen model (carriage return, line feed, erase line and cursor up) records
 * what an operator would see, so assertions cover the chronological timeline, the activity pane's
 * grouping and bounds, role colors, resize behavior and the plain-stream fallback. No execution,
 * service, agent, network access or filesystem operation is involved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import stringWidth from 'string-width';
import {
  createOperatorInterface,
  type OperatorInterface,
  type TerminalCapabilities,
} from '../src/operator-interface/index.js';
import type { EngineEvent } from '../src/task-engine/index.js';

/**
 * A recording screen: enough of CR, LF, erase-line and cursor-up to read rendered output, with the
 * cursor position deciding which rows a redraw replaces. It does not simulate scrolling; rows are
 * recorded as the terminal would hold them.
 */
function createScreen(): { write(text: string): void; lines(): string[] } {
  const lines: string[] = [''];
  let row = 0;
  let column = 0;

  function ensureLine(): void {
    while (lines.length <= row) {
      lines.push('');
    }
  }

  return {
    write(text: string): void {
      let index = 0;
      while (index < text.length) {
        const escape = readEscape(text, index);
        if (escape !== null) {
          if (escape.final === 'A') {
            row = Math.max(0, row - (escape.parameter === '' ? 1 : Number(escape.parameter)));
          } else if (escape.final === 'K') {
            lines[row] = '';
          }
          index += escape.length;
          continue;
        }
        const character = text[index];
        index += 1;
        if (character === undefined) {
          break;
        }
        if (character === '\r') {
          column = 0;
          continue;
        }
        if (character === '\n') {
          // A terminal's cooked mode turns a line feed into carriage return plus line feed.
          column = 0;
          row += 1;
          ensureLine();
          continue;
        }
        const line = lines[row] ?? '';
        const padded = line.padEnd(column, ' ');
        lines[row] = `${padded.slice(0, column)}${character}${padded.slice(column + 1)}`;
        column += 1;
      }
    },
    lines: () => [...lines],
  };
}

/** One escape sequence starting at `start`: a CSI, however this presentation uses it. */
function readEscape(
  text: string,
  start: number,
): { readonly length: number; readonly parameter: string; readonly final: string } | null {
  if (text[start] !== '\u001b' || text[start + 1] !== '[') {
    return null;
  }
  let index = start + 2;
  let parameter = '';
  while (index < text.length && isParameterCharacter(text[index] ?? '')) {
    parameter += text[index];
    index += 1;
  }
  const final = text[index];
  if (final === undefined || !isFinalCharacter(final)) {
    return null;
  }
  return { length: index - start + 1, parameter, final };
}

function isParameterCharacter(character: string): boolean {
  return (character >= '0' && character <= '9') || character === ';';
}

function isFinalCharacter(character: string): boolean {
  return (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z');
}

type HarnessOptions = {
  readonly interactive?: boolean;
  readonly color?: boolean;
  readonly columns?: number;
  readonly rows?: number;
};

/** A presentation over a controlled subscription, terminal size and recording output sink. */
function createHarness(options: HarnessOptions = {}) {
  let columns = options.columns ?? 80;
  let rows = options.rows ?? 24;
  let failing = false;
  const screen = createScreen();
  const writes: string[] = [];
  const listeners = new Set<(event: EngineEvent) => void>();
  let subscriptions = 0;
  let unsubscriptions = 0;

  const terminal: TerminalCapabilities = {
    interactive: options.interactive ?? true,
    color: options.color ?? true,
    size: () => ({ columns, rows }),
    write: (text) => {
      if (failing) {
        throw new Error('output stream closed');
      }
      writes.push(text);
      screen.write(text);
    },
  };

  const operatorInterface: OperatorInterface = createOperatorInterface({
    subscribe: (listener) => {
      subscriptions += 1;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscriptions += 1;
      };
    },
    terminal,
  });

  return {
    operatorInterface,
    writes,
    emit(event: EngineEvent): void {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    subscriptions: (): number => subscriptions,
    unsubscriptions: (): number => unsubscriptions,
    listeners: (): number => listeners.size,
    resize: (nextColumns: number, nextRows: number = rows): void => {
      columns = nextColumns;
      rows = nextRows;
    },
    failWrites: (): void => {
      failing = true;
    },
    /** Every recorded row, including the blank rows the pane leaves behind its live region. */
    lines: (): string[] => screen.lines(),
    /** The recorded rows an operator reads, top to bottom. */
    rows: (): string[] => screen.lines().filter((line) => line !== ''),
  };
}

/** Freeze the clock on a known second of a local date, so receipt timestamps are predictable. */
function at(second: number): void {
  vi.setSystemTime(new Date(2026, 0, 2, 3, 4, second));
}

/** The cursor-up distances among recorded writes; redrawing the pane in place writes them. */
function cursorUps(writes: readonly string[]): number[] {
  return writes
    .filter((write) => write.startsWith('\u001b[') && write.endsWith('A'))
    .map((write) => Number(write.slice(2, -1)));
}

/** The boundary event a development action publishes for one invocation. */
function developerTurn(task = 'NEX-7'): EngineEvent {
  return {
    source: 'develop',
    type: 'agent-started',
    data: { role: 'developer', operation: 'Develop', profile: 'nexus-flash', task },
  };
}

/** The boundary event an idea refinement action publishes for one invocation. */
function ideaTurn(
  role: 'purpose-verifier' | 'purpose-council',
  operation: string,
  idea = 'NEX-1',
): EngineEvent {
  return {
    source: operation.toLowerCase(),
    type: 'agent-started',
    data: { role, operation, profile: 'nexus-astra', idea },
  };
}

/** One agent message as the invocation's caller forwards it. */
function message(text: string, source = 'develop'): EngineEvent {
  return { source, type: 'agent-activity', data: { type: 'message', text } };
}

/** One work entry as the invocation's caller forwards it. */
function work(
  kind: 'command' | 'result' | 'change',
  text: string,
  source = 'develop',
): EngineEvent {
  return { source, type: 'agent-activity', data: { type: kind, text } };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OperatorInterface progress presentation', () => {
  it('names the idea on an invocation boundary and colors its role', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    at(5);
    harness.emit(ideaTurn('purpose-verifier', 'PurposeVerifier'));
    at(6);
    harness.emit(ideaTurn('purpose-council', 'PurposeCouncil'));
    at(7);
    harness.emit({ source: 'purpose-council', type: 'agent-finished', data: null });

    expect(harness.rows()).toEqual([
      '03:04:05 purpose-verifier PurposeVerifier · idea NEX-1 · profile nexus-astra',
      '03:04:06 purpose-council PurposeCouncil · idea NEX-1 · profile nexus-astra',
    ]);
    const raw = harness.writes.join('');
    // Purpose, research, the brief writer and the developer share yellow; council roles are blue.
    expect(raw).toContain('\u001b[33m03:04:05');
    expect(raw).toContain('\u001b[34m03:04:06');
  });

  it('renders one chronological timeline with the receipt time of each entry', () => {
    const harness = createHarness();
    harness.operatorInterface.start();

    at(5);
    harness.emit({ source: 'application', type: 'starting', data: null });
    at(6);
    harness.emit({ source: 'execution-runner', type: 'state', data: { value: 'select' } });
    at(7);
    harness.emit({ source: 'develop', type: 'failed', data: { reason: 'the checks failed' } });
    at(8);
    harness.emit({
      source: 'mystery-source',
      type: 'mystery-type',
      data: { launchArguments: ['--state', '/tmp/state.json'] },
    });
    at(9);
    harness.emit({
      source: 'application',
      type: 'finished',
      data: { outcome: 'needs-attention', reason: 'recovery allowance exhausted' },
    });

    expect(harness.rows()).toEqual([
      '03:04:05 application starting',
      '03:04:06 execution-runner state select',
      '03:04:07 develop failed: the checks failed',
      '03:04:08 mystery-source mystery-type',
      '03:04:09 application finished needs-attention: recovery allowance exhausted',
    ]);
    expect(harness.writes.join('')).not.toContain('/tmp/state.json');
  });

  it('colors TaskEngine progress white and application lifecycle lines with the terminal default', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    at(5);
    harness.emit({ source: 'application', type: 'starting', data: null });
    at(6);
    harness.emit({ source: 'execution-runner', type: 'state', data: { value: 'develop' } });

    const raw = harness.writes.join('');
    expect(raw).not.toContain('\u001b[37m03:04:05');
    expect(raw).toContain('\u001b[37m03:04:06 execution-runner state develop\u001b[0m');
  });

  it('renders action outcomes as milestones without artifact paths', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    at(5);
    harness.emit({
      source: 'deliver',
      type: 'outcome',
      data: {
        task: 'NEX-1',
        round: 2,
        outcome: 'published',
        detail: 'PR #7',
        artifact: { path: '/srv/nexus/workspaces/NEX/NEX-1/artifacts/2/delivery.json' },
      },
    });
    at(6);
    harness.emit({
      source: 'verify',
      type: 'outcome',
      data: {
        task: 'NEX-1',
        round: 2,
        outcome: 'passed',
        detail: '2 checks',
        artifact: { path: '/srv/nexus/workspaces/NEX/NEX-1/artifacts/2/verification.json' },
      },
    });
    at(7);
    harness.emit({
      source: 'select-task',
      type: 'outcome',
      data: {
        task: 'NEX-1',
        round: null,
        outcome: 'selected',
        detail: null,
        artifact: { path: '/srv/nexus/executions/NEX/selection.json' },
      },
    });
    at(8);
    harness.emit({
      source: 'application',
      type: 'recovered',
      data: { decision: 'resume', report: { path: '/srv/nexus/recovery/1.json' } },
    });

    expect(harness.rows()).toEqual([
      '03:04:05 deliver task NEX-1 · round 2 · published · PR #7',
      '03:04:06 verify task NEX-1 · round 2 · passed · 2 checks',
      '03:04:07 select-task task NEX-1 · selected',
      '03:04:08 application recovered resume · report saved',
    ]);
    // The structured events keep their references; the live view never shows a path.
    expect(harness.writes.join('')).not.toContain('/srv/nexus');
    expect(harness.writes.join('')).not.toContain('artifact');
  });
});

describe('OperatorInterface activity pane', () => {
  it('opens a developer pane that keeps the latest three work entries after each message', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(message('Implementing the parser change'));
    at(7);
    harness.emit(work('command', 'rg --files src'));
    at(8);
    harness.emit(work('result', '12 files'));
    at(9);
    harness.emit(work('change', 'src/parser.ts'));
    at(10);
    harness.emit(work('command', 'npm test'));

    expect(harness.rows()).toEqual([
      '03:04:05 developer Develop · task NEX-7 · profile nexus-flash',
      '03:04:06 message Implementing the parser change',
      '03:04:08 result 12 files',
      '03:04:09 change src/parser.ts',
      '03:04:10 command npm test',
    ]);
    const raw = harness.writes.join('');
    expect(raw).toContain('\u001b[33m03:04:05 developer Develop');
    expect(raw).toContain('\u001b[33m03:04:06 message Implementing the parser change\u001b[0m');
    expect(raw).toContain('\u001b[90m03:04:10 command npm test\u001b[0m');
  });

  it('fits a work entry to one physical row, ending it with an ellipsis when cut', () => {
    const harness = createHarness({ columns: 60 });
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(
      work('command', 'rg --files-with-matches --glob "*.ts" --max-count 5 src tests workflows'),
    );

    const rows = harness.rows();
    const entry = rows.at(-1) ?? '';
    expect(entry.startsWith('03:04:06 command ')).toBe(true);
    expect(entry.endsWith('…')).toBe(true);
    expect(stringWidth(entry)).toBeLessThanOrEqual(60);
    expect(rows.filter((line) => line.startsWith('03:04:06 command '))).toHaveLength(1);
    expect(rows.at(-2)).toBe('03:04:05 developer Develop · task NEX-7 · profile nexus-flash');

    at(7);
    harness.emit(work('result', '12 matches\nin 3 files'));
    expect(harness.rows().at(-1)).toBe('03:04:07 result 12 matches in 3 files');

    at(8);
    harness.emit(work('change', '日本語ファイル名'.repeat(6)));
    const wide = harness.rows().at(-1) ?? '';
    expect(wide.endsWith('…')).toBe(true);
    expect(stringWidth(wide)).toBeLessThanOrEqual(60);
  });

  it('groups work that arrives before the first message on its own', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(work('command', 'rg --files src'));
    at(7);
    harness.emit(work('result', '12 files'));
    at(8);
    harness.emit(work('change', 'src/parser.ts'));
    at(9);
    harness.emit(work('command', 'npm test'));
    at(10);
    harness.emit(message('Now implementing the change'));

    expect(harness.rows()).toEqual([
      '03:04:05 developer Develop · task NEX-7 · profile nexus-flash',
      '03:04:07 result 12 files',
      '03:04:08 change src/parser.ts',
      '03:04:09 command npm test',
      '03:04:10 message Now implementing the change',
    ]);
  });

  it('wraps message text to display columns without cutting characters', () => {
    const harness = createHarness({ columns: 30 });
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    const text = '日本語の説明をここに書きます👩‍👩‍👧 with e\u0301 and more text';
    at(6);
    harness.emit(message(text));

    const rows = harness.rows().slice(1);
    expect(rows.length).toBeGreaterThan(1);
    const prefix = '03:04:06 message ';
    expect(rows[0]?.startsWith(prefix)).toBe(true);
    for (const row of rows) {
      expect(stringWidth(row)).toBeLessThanOrEqual(30);
    }
    const rendered = rows.map((row) => row.slice(prefix.length)).join('');
    expect(rendered).toBe(text);
    const renderedWidth = rows.reduce(
      (width, row) => width + stringWidth(row.slice(prefix.length)),
      0,
    );
    expect(renderedWidth).toBe(stringWidth(text));
  });

  it.each([
    { label: 'a ten-row terminal', rows: 10, bound: 6 },
    { label: 'a thirty-row terminal', rows: 30, bound: 20 },
  ])('bounds the pane to $bound rows on $label', ({ rows, bound }) => {
    const harness = createHarness({ columns: 60, rows });
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    for (let index = 1; index <= bound + 4; index += 1) {
      at(5 + index);
      harness.emit(message(`message row ${index}`));
    }
    const before = harness.rows();
    at(bound + 10);
    harness.emit(message(`message row ${bound + 5}`));
    const after = harness.rows();

    // The pane never redraws more than its bound, and it fills to that bound.
    const cursorMoves = cursorUps(harness.writes);
    expect(cursorMoves.length).toBeGreaterThan(0);
    expect(Math.max(...cursorMoves)).toBe(bound);
    expect(cursorMoves.every((move) => move <= bound)).toBe(true);

    // Older rows leave the live region instead of being redrawn or discarded.
    const changed = after
      .map((row, index) => (row === before[index] ? -1 : index))
      .filter((index) => index !== -1);
    expect(changed).toContain(after.length - 1);
    expect(after.length - (changed[0] ?? 0)).toBeLessThanOrEqual(bound + 1);

    // Every message row survives exactly once, in arrival order.
    const arrivals = after
      .map((row) => /message row (\d+)$/.exec(row)?.[1])
      .filter((number) => number !== undefined)
      .map(Number);
    expect(arrivals).toEqual(Array.from({ length: bound + 5 }, (_value, index) => index + 1));
  });

  it('drops an overflowing work row instead of committing message rows to scrollback', () => {
    const harness = createHarness({ columns: 60, rows: 10 });
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    for (let index = 1; index <= 6; index += 1) {
      at(5 + index);
      harness.emit(message(`message row ${index}`));
    }
    expect(harness.rows()).toHaveLength(7);

    at(12);
    harness.emit(work('command', 'npm test -- --run'));

    // The only work row gives way, so every full-pane message row stays where it is.
    const rows = harness.rows();
    expect(rows).toHaveLength(7);
    expect(rows.some((row) => row.endsWith('npm test -- --run'))).toBe(false);
    const arrivals = rows.slice(1).map((row) => /message row (\d+)$/.exec(row)?.[1]);
    expect(arrivals).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('removes the oldest work rows anywhere before committing any message row', () => {
    const harness = createHarness({ columns: 60, rows: 10 });
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(message('first message'));
    at(7);
    harness.emit(work('command', 'rg --files src'));
    at(8);
    harness.emit(work('result', '12 files'));
    at(9);
    harness.emit(work('change', 'src/parser.ts'));
    at(10);
    harness.emit(work('command', 'npm test'));
    at(11);
    harness.emit(message('second message'));
    at(12);
    harness.emit(message('third message'));
    at(13);
    harness.emit(work('result', 'checks passed'));

    // The overflowing work row nearest the start gives way, keeping every message row.
    expect(harness.rows()).toEqual([
      '03:04:05 developer Develop · task NEX-7 · profile nexus-flash',
      '03:04:06 message first message',
      '03:04:09 change src/parser.ts',
      '03:04:10 command npm test',
      '03:04:11 message second message',
      '03:04:12 message third message',
      '03:04:13 result checks passed',
    ]);
  });

  it('finalizes the pane for ordinary progress and continues below it in arrival order', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(message('Starting the change'));
    at(7);
    harness.emit({ source: 'execution-runner', type: 'state', data: { value: 'verify' } });
    at(8);
    harness.emit(message('Continuing after verification'));

    expect(harness.rows()).toEqual([
      '03:04:05 developer Develop · task NEX-7 · profile nexus-flash',
      '03:04:06 message Starting the change',
      '03:04:07 execution-runner state verify',
      '03:04:08 message Continuing after verification',
    ]);
  });

  it('leaves a finished turn in place and opens the next invocation below it', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(message('Implementing the parser change'));
    const finished = harness.rows();
    at(7);
    harness.emit({ source: 'develop', type: 'agent-finished', data: null });
    expect(harness.rows()).toEqual(finished);

    at(8);
    harness.emit({
      // The Application forwards the invocation's activity; the role comes from the event data.
      source: 'application',
      type: 'agent-started',
      data: { role: 'reviewer', operation: 'Review', profile: 'nexus-astra', task: 'NEX-7' },
    });
    at(9);
    harness.emit(message('The change looks correct', 'application'));
    at(10);
    harness.emit(work('command', 'git diff main...HEAD', 'application'));

    expect(harness.rows()).toEqual([
      '03:04:05 developer Develop · task NEX-7 · profile nexus-flash',
      '03:04:06 message Implementing the parser change',
      '03:04:08 reviewer Review · task NEX-7 · profile nexus-astra',
      '03:04:09 message The change looks correct',
      '03:04:10 command git diff main...HEAD',
    ]);
    const raw = harness.writes.join('');
    expect(raw).toContain('\u001b[34m03:04:08 reviewer Review');
    expect(raw).toContain('\u001b[34m03:04:09 message The change looks correct\u001b[0m');
    expect(raw).toContain('\u001b[90m03:04:10 command git diff main...HEAD\u001b[0m');
  });

  it('uses the terminal default for recovery and grey for its tool activity', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    at(5);
    harness.emit({
      source: 'application',
      type: 'agent-started',
      data: { role: 'recovery', operation: 'Recover', profile: 'nexus-recovery' },
    });
    at(6);
    harness.emit(message('Investigating the interrupted execution', 'application'));
    at(7);
    harness.emit(work('command', 'git status', 'application'));

    expect(harness.rows()).toEqual([
      '03:04:05 recovery Recover · profile nexus-recovery',
      '03:04:06 message Investigating the interrupted execution',
      '03:04:07 command git status',
    ]);
    const raw = harness.writes.join('');
    expect(raw).not.toContain('\u001b[33m03:04:05');
    expect(raw).not.toContain('\u001b[34m03:04:05');
    expect(raw).toContain('\u001b[90m03:04:07 command git status\u001b[0m');
  });
});

describe('OperatorInterface terminal handling', () => {
  it('removes embedded terminal control sequences and control characters from event text', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(
      message('plain\u001b[31mred\u001b[0m\u001b[2J\u0007\u001b]0;title\u0007done\r\nnext\ttab'),
    );

    expect(harness.rows().slice(1)).toEqual([
      '03:04:06 message plainreddone',
      `${' '.repeat('03:04:06 message '.length)}next tab`,
    ]);
    const raw = harness.writes.join('');
    expect(raw).not.toContain('\u001b[2J');
    expect(raw).not.toContain('\u0007');
  });

  it('leaves rendered rows in place and applies new dimensions to later activity', () => {
    const harness = createHarness({ columns: 60 });
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(message('first '.repeat(12).trim()));
    const before = harness.rows();
    harness.resize(30, 24);
    at(7);
    harness.emit(message('second '.repeat(8).trim()));
    const after = harness.rows();

    expect(after.slice(0, before.length)).toEqual(before);
    const later = after.slice(before.length);
    expect(later.length).toBeGreaterThan(1);
    for (const row of later) {
      expect(stringWidth(row)).toBeLessThanOrEqual(30);
    }
  });

  it('falls back to plain lines when a resize makes the terminal too narrow for the pane', () => {
    const harness = createHarness({ columns: 60 });
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(message('kept in the pane'));
    harness.resize(10, 24);
    const writesBefore = harness.writes.length;
    at(7);
    harness.emit(message('after the resize'));

    expect(harness.writes.slice(writesBefore).join('')).not.toContain('\u001b');
    expect(harness.rows()).toEqual([
      '03:04:05 developer Develop · task NEX-7 · profile nexus-flash',
      '03:04:06 message kept in the pane',
      '03:04:07 message after the resize',
    ]);
  });

  it('finalizes the pane without cursor movement on resize and wraps later activity to each width', () => {
    const harness = createHarness({ columns: 60 });
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(message('first '.repeat(12).trim()));
    const before = harness.rows();

    harness.resize(30, 24);
    const shrinkStart = harness.writes.length;
    at(7);
    harness.emit(message('second '.repeat(8).trim()));
    const shrunk = harness.rows();
    const shrinkWrites = harness.writes.slice(shrinkStart).join('');

    // The old rows are neither redrawn nor erased: the pane moved no cursor over them.
    expect(shrunk.slice(0, before.length)).toEqual(before);
    expect(cursorUps(harness.writes.slice(shrinkStart))).toEqual([]);
    expect(shrinkWrites).not.toContain('first');
    const wrappedAt30 = shrunk.slice(before.length);
    expect(wrappedAt30.length).toBeGreaterThan(1);
    for (const row of wrappedAt30) {
      expect(stringWidth(row)).toBeLessThanOrEqual(30);
    }
    expect(wrappedAt30.map((row) => row.slice('03:04:07 message '.length)).join('')).toBe(
      'second '.repeat(8).trim(),
    );

    harness.resize(80, 24);
    const expandStart = harness.writes.length;
    at(8);
    harness.emit(message('third '.repeat(14).trim()));
    const expanded = harness.rows();
    const expandWrites = harness.writes.slice(expandStart).join('');

    expect(expanded.slice(0, shrunk.length)).toEqual(shrunk);
    expect(cursorUps(harness.writes.slice(expandStart))).toEqual([]);
    expect(expandWrites).not.toContain('second');
    const wrappedAt80 = expanded.slice(shrunk.length);
    for (const row of wrappedAt80) {
      expect(stringWidth(row)).toBeLessThanOrEqual(80);
    }
    expect(Math.max(...wrappedAt80.map((row) => stringWidth(row)))).toBeGreaterThan(30);
    expect(wrappedAt80.map((row) => row.slice('03:04:08 message '.length)).join('')).toBe(
      'third '.repeat(14).trim(),
    );
  });

  it.each([
    { name: 'a width below the pane minimum', columns: 10, rows: 24 },
    { name: 'no room below the pane', columns: 60, rows: 4 },
  ])(
    'keeps plain output below the finalized pane for $name and reopens below it',
    ({ columns, rows }) => {
      const harness = createHarness({ columns: 60, rows: 24 });
      harness.operatorInterface.start();
      at(5);
      harness.emit(developerTurn());
      at(6);
      harness.emit(message('kept in the pane'));
      const before = harness.rows();

      harness.resize(columns, rows);
      const fallbackStart = harness.writes.length;
      at(7);
      harness.emit(message('printed while plain'));
      expect(harness.writes.slice(fallbackStart).join('')).not.toContain('\u001b');
      const plain = harness.rows();
      expect(plain.slice(0, before.length)).toEqual(before);

      harness.resize(60, 24);
      const expandStart = harness.writes.length;
      at(8);
      harness.emit(message('pane again '.repeat(10).trim()));
      const after = harness.rows();
      const expandWrites = harness.writes.slice(expandStart).join('');

      // The plain line and the old pane rows stay untouched; the new segment draws below them.
      expect(after.slice(0, plain.length)).toEqual(plain);
      expect(cursorUps(harness.writes.slice(expandStart))).toEqual([]);
      expect(expandWrites).not.toContain('kept in the pane');
      expect(expandWrites).not.toContain('printed while plain');
      const later = after.slice(plain.length);
      expect(later.length).toBeGreaterThan(1);
      for (const row of later) {
        expect(stringWidth(row)).toBeLessThanOrEqual(60);
      }
    },
  );

  it.each([
    { name: 'redirected output', interactive: false, color: false, columns: 100, rows: 30 },
    { name: 'a terminal without color', interactive: true, color: false, columns: 100, rows: 30 },
    { name: 'a narrow terminal', interactive: true, color: true, columns: 19, rows: 30 },
    {
      name: 'a terminal without room below',
      interactive: true,
      color: true,
      columns: 100,
      rows: 4,
    },
  ])('prints a plain timestamped stream for $name', ({ interactive, color, columns, rows }) => {
    const harness = createHarness({ interactive, color, columns, rows });
    harness.operatorInterface.start();
    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(message('Implementing the parser change'));
    at(7);
    harness.emit(work('command', 'npm test -- --run'));
    at(8);
    harness.emit({
      source: 'verify',
      type: 'outcome',
      data: {
        task: 'NEX-7',
        round: 1,
        outcome: 'passed',
        detail: '1 check',
        artifact: { path: '/srv/nexus/artifacts/1/verification.json' },
      },
    });

    expect(harness.writes.join('')).not.toContain('\u001b');
    expect(harness.rows()).toEqual([
      '03:04:05 developer Develop · task NEX-7 · profile nexus-flash',
      '03:04:06 message Implementing the parser change',
      '03:04:07 command npm test -- --run',
      '03:04:08 verify task NEX-7 · round 1 · passed · 1 check',
    ]);
  });
});

describe('OperatorInterface lifecycle', () => {
  it('subscribes once, stops rendering after stop and restores styling', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    harness.operatorInterface.start();
    expect(harness.subscriptions()).toBe(1);
    expect(harness.listeners()).toBe(1);

    at(5);
    harness.emit(developerTurn());
    at(6);
    harness.emit(message('Implementing the parser change'));
    const visible = harness.rows();
    expect(visible).toHaveLength(2);

    harness.operatorInterface.stop();
    expect(harness.unsubscriptions()).toBe(1);
    expect(harness.listeners()).toBe(0);
    expect(harness.rows()).toEqual(visible);
    expect(harness.writes.join('')).toContain('\u001b[0m');

    at(7);
    harness.emit(message('after stop'));
    expect(harness.rows()).toEqual(visible);
    harness.operatorInterface.stop();
    expect(harness.unsubscriptions()).toBe(1);
  });

  it('stops rendering to an output stream that closes', () => {
    const harness = createHarness();
    harness.operatorInterface.start();
    harness.failWrites();

    expect(() => {
      at(5);
      harness.emit(developerTurn());
      at(6);
      harness.emit(message('Implementing the parser change'));
      harness.operatorInterface.stop();
    }).not.toThrow();
    expect(harness.writes).toEqual([]);
  });
});
