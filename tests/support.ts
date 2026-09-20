/**
 * Shared test support. File tests work in temporary directories so that neither
 * the repository nor the real environment is touched.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import stringWidth from 'string-width';
import type { CliIo } from '../src/cli/context.js';

/** Repository root, derived from this file's location. */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * A fake interactive terminal: every write, in order, and the size it reports.
 * `io` is a CLI output that goes to it with no cursor work of its own, so a test
 * can tell the display's own sequences from anything a caller wrote.
 */
export interface FakeConsole {
  readonly chunks: string[];
  readonly io: CliIo;
}

export function fakeConsole(
  parts: {
    readonly columns?: number;
    readonly rows?: number;
    readonly color?: boolean;
  } = {},
): FakeConsole {
  const chunks: string[] = [];
  return {
    chunks,
    io: {
      out: (text) => chunks.push(`${text}\n`),
      err: (text) => chunks.push(`${text}\n`),
      terminal: {
        write: (text) => chunks.push(text),
        ...(parts.columns === undefined ? {} : { columns: parts.columns }),
        ...(parts.rows === undefined ? {} : { rows: parts.rows }),
        ...(parts.color === undefined ? {} : { color: parts.color }),
      },
    },
  };
}

/**
 * What a terminal would show after these writes, as the lines it holds: a line
 * is created by `\n` or wrapping at `columns`, `ESC[<n>A` moves up physical
 * rows, `ESC[J` erases from the cursor down, and an `ESC[<params>m` styling
 * sequence changes no cell — as on a real terminal, a highlight is not text.
 * Model newline's terminal CRLF translation and whole grapheme cell widths.
 * This only handles the sequences the pane emits; it is not a general terminal
 * emulator.
 */
/* eslint-disable no-control-regex -- the escape sequences are what this reads */
export function screenAfter(chunks: readonly string[], columns = Infinity): readonly string[] {
  const screen: string[] = [];
  let row = 0;
  let column = 0;
  const graphemes = new Intl.Segmenter();
  const tokens = /\u001b\[(\d+)A|\u001b\[J|\u001b\[[0-9;]*m|\n|[^\u001b\n]+/g;

  for (const match of chunks.join('').matchAll(tokens)) {
    const token = match[0];
    const count = match[1];
    if (count !== undefined) {
      row = Math.max(0, row - Number(count));
      continue;
    }
    if (token === '\u001b[J') {
      screen.length = row;
      continue;
    }
    if (token.startsWith('\u001b[')) {
      // Styling only: it changes nothing a screen holds.
      continue;
    }
    if (token === '\n') {
      row += 1;
      column = 0;
      continue;
    }
    for (const { segment } of graphemes.segment(token)) {
      const cells = stringWidth(segment);
      if (cells > 0 && column + cells > columns) {
        row += 1;
        column = 0;
      }
      screen[row] = (screen[row] ?? '') + segment;
      column += cells;
    }
  }
  return screen;
}
/* eslint-enable no-control-regex */

/** The configuration example from docs/WORKFLOW.md §1. */
export const documentedConfig = {
  workDir: './.harness',
  maxRepairs: 2,
  taskTimeoutMinutes: 60,
  commandTimeoutMinutes: 10,
  setup: [['npm', 'ci']],
  checks: [
    ['npm', 'run', 'typecheck'],
    ['npm', 'test'],
  ],
};

/** The task example from docs/WORKFLOW.md §2. */
export const documentedTask = {
  id: 'example-001',
  title: 'Add a greeting function',
  description: "Implement a greeting function using the target project's existing conventions.",
  acceptanceCriteria: [
    'Returns a greeting containing the supplied name.',
    'Includes tests for the documented behavior.',
  ],
};

/** A JSON document as tests build it before writing it to disk. */
export type JsonObject = Record<string, unknown>;

const temporaryDirectories: string[] = [];

/**
 * Creates a temporary directory and registers it for removal by
 * {@link cleanupTempDirectories}.
 */
export async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-harness-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** Writes `value` as JSON to `directory/name` and returns the file path. */
export async function writeJsonFile(
  directory: string,
  name: string,
  value: unknown,
): Promise<string> {
  const file = path.join(directory, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Removes every directory created by {@link createTempDir}, through
 * {@link removeWithRetry}.
 */
export async function cleanupTempDirectories(): Promise<void> {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map(async (directory) =>
      removeWithRetry(async () => rm(directory, { recursive: true, force: true })),
    ),
  );
}

/**
 * The one removal refusal this helper waits out: a tree something else is
 * still letting go of, which Windows reports as `EBUSY` (demonstrated once, in
 * the full-suite removal recorded in notes/windows-fixture-flakes.md). Nothing
 * else reaches the retry — a permission problem, a programming error, or a
 * refusal with no code is not a race this helper knows anything about.
 */
const TRANSIENT_REMOVAL_CODE = 'EBUSY';

/** Whether a failure is the refusal a removal is retried for. */
function isTransientRemovalRefusal(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === TRANSIENT_REMOVAL_CODE;
}

/**
 * Runs one removal, retrying a transient refusal for a moment before it is
 * reported.
 *
 * The tolerance is for the one refusal that was seen, not a reproduction of who
 * caused it: the attempts made while writing this did not establish what held
 * the tree, and the two Node-side shapes they tried do not exclude every
 * fixture-related holder (notes/windows-fixture-flakes.md). A refusal that is
 * not that one, and one that happens every time, still throws, so a directory
 * something is really holding is not quietly kept.
 */
export async function removeWithRetry(
  remove: () => Promise<void>,
  attempts = 5,
  pauseMs = 100,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove();
      return;
    } catch (cause) {
      if (attempt >= attempts || !isTransientRemovalRefusal(cause)) {
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}
