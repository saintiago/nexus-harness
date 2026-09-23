/**
 * The real console, and the one question about it that belongs to no command in
 * particular: whether a pane drawn on it may use color.
 *
 * This module is deliberately free of every other module's logic. The CLI entry
 * and the supervisor's own entry both build their context here, so both draw
 * the same display and honor the same `NO_COLOR` convention without either one
 * having to load the other's commands.
 */
import type { CliContext, CliTerminal } from './context.js';

/** The real console, reading the current working directory at call time. */
export function consoleContext(): CliContext {
  return {
    cwd: process.cwd(),
    io: {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
      terminal: consoleTerminal(),
    },
  };
}

/**
 * The process's own standard output as the pane needs it, when it is really an
 * interactive terminal. A redirected stream — piped to a file, a test's own
 * recorder, a process that reads it — is not one: it gets ordinary lines, and
 * never a cursor sequence.
 */
export function consoleTerminal(): CliTerminal | undefined {
  if (process.stdout.isTTY !== true) {
    return undefined;
  }
  return {
    write: (text) => process.stdout.write(text),
    get columns() {
      return process.stdout.columns;
    },
    get rows() {
      return process.stdout.rows;
    },
    onResize: (handler) => {
      process.stdout.on('resize', handler);
      return () => {
        process.stdout.off('resize', handler);
      };
    },
    color: colorAllowed(process.env),
  };
}

/**
 * Whether the pane may color the terminal. The `NO_COLOR` convention — set to
 * anything but the empty string — asks for none: the timeline uses plain output
 * without cursor or color sequences.
 */
export function colorAllowed(environment: NodeJS.ProcessEnv): boolean {
  const requested = environment['NO_COLOR'];
  return requested === undefined || requested === '';
}
