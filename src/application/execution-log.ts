import { randomUUID } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../result.js';
import type { ExecutionEvent } from './index.js';

/**
 * Application's execution log: the combined execution event stream appended to one JSONL file,
 * independent of terminal presentation. It is an ordinary subscriber that timestamps each event
 * when received, preserves receipt order and complete payloads, and isolates its failures from
 * execution: its first failure is one diagnostic line.
 * See docs/application.md#execution-log.
 */

/** Where Application reports diagnostics that do not affect execution. */
export type DiagnosticSink = { write(text: string): unknown };

/**
 * The log directory one execute call uses: its own directory under the execution directory's logs
 * directory. Worker restarts and recovery of that execution share the directory; a new execution
 * gets a new one. It holds the main event log and one activity log per agent invocation.
 */
export function executionLogDirectory(executionDirectory: string): string {
  return path.join(executionDirectory, 'logs', randomUUID());
}

/** The main event log of one execution's log directory. */
export function executionLogFile(logDirectory: string): string {
  return path.join(logDirectory, 'events.jsonl');
}

/** The execution log's lifecycle: record received events, drain pending writes and close. */
export type ExecutionLog = {
  /** Timestamp and append one received event after every event recorded earlier. */
  record(event: ExecutionEvent): void;
  /** Resolve once every event recorded so far has been written. */
  drain(): Promise<void>;
  /** Drain and release the file; later events are not recorded. */
  close(): Promise<void>;
};

/**
 * Open the execution log over its file and the diagnostics its failures are reported to. The file
 * is open when this resolves, so the caller publishes its first event into an established log; a
 * failure to open is reported and the next event retries.
 */
export async function createExecutionLog(settings: {
  readonly file: string;
  readonly diagnostics: DiagnosticSink;
}): Promise<ExecutionLog> {
  const { file, diagnostics } = settings;
  let handle: FileHandle | null = null;
  let tail: Promise<void> = Promise.resolve();
  let reported = false;
  let closed = false;

  /** Report the first failure once; later failures stay silent. */
  const report = (error: unknown): void => {
    if (reported) {
      return;
    }
    reported = true;
    try {
      diagnostics.write(`Nexus could not write the execution log: ${messageOf(error)}\n`);
    } catch {
      // A failed report leaves nothing further to say.
    }
  };

  /** The open file, opening it on first use. */
  const openFile = async (): Promise<FileHandle> => {
    if (handle === null) {
      await mkdir(path.dirname(file), { recursive: true });
      handle = await open(file, 'a');
    }
    return handle;
  };

  try {
    await openFile();
  } catch (error) {
    report(error);
  }

  return {
    record(event) {
      if (closed) {
        return;
      }
      // Timestamp on receipt, so the saved timestamp does not depend on write timing.
      const timestamp = new Date().toISOString();
      let line: string;
      try {
        line = `${JSON.stringify({ timestamp, event })}\n`;
      } catch (error) {
        report(error);
        return;
      }
      tail = tail
        .then(async () => {
          const opened = await openFile();
          // writeFile writes the complete line; write can stop at a partial write.
          await opened.writeFile(line);
        })
        .catch(report);
    },
    async drain() {
      await tail;
    },
    async close() {
      closed = true;
      await tail;
      const opened = handle;
      handle = null;
      if (opened !== null) {
        try {
          await opened.close();
        } catch (error) {
          report(error);
        }
      }
    },
  };
}
