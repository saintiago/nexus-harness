import { mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../result.js';
import type { AgentActivity, AgentInvocation } from '../task-engine/index.js';
import type { DiagnosticSink } from './execution-log.js';

/**
 * Application's per-invocation activity log: every announced agent invocation gets its own JSONL
 * file under the execution's agents directory, holding complete timestamped activity, independent
 * of the main event log and of terminal presentation. Writes are queued in receipt order, so a
 * finish event, which the worker sends after the invocation's last packet, closes the file only
 * after that packet is written. Its first failure is one diagnostic line; execution continues.
 * See docs/application.md#execution-log.
 */

/** The per-invocation activity log of one execute call. */
export type ActivityLog = {
  /** Announce one invocation: its own file opens before the first activity packet is written. */
  start(identity: AgentInvocation): void;
  /** Append one received activity entry to the file of the invocation that reported it. */
  record(activity: AgentActivity): void;
  /** End one invocation: after its recorded activity, its file is closed. */
  finish(identity: AgentInvocation): void;
  /** Resolve once every announcement, entry and end received so far has been applied. */
  drain(): Promise<void>;
  /** Drain and release every file; later activity is not recorded. */
  close(): Promise<void>;
};

/** One announced invocation's file. */
type Entry = {
  readonly file: string;
  handle: FileHandle | null;
};

/**
 * Create the activity log over the execution's agents directory and the diagnostics its failures
 * are reported to. The directory is created when the first invocation is announced; a failure is
 * reported and the next announcement retries.
 */
export function createActivityLog(settings: {
  readonly directory: string;
  readonly diagnostics: DiagnosticSink;
}): ActivityLog {
  const entries = new Map<string, Entry>();
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
      settings.diagnostics.write(
        `Nexus could not write the agent activity log: ${messageOf(error)}\n`,
      );
    } catch {
      // A failed report leaves nothing further to say.
    }
  };

  /** Queue one write step behind every step received before it. */
  const chain = (work: () => Promise<void>): void => {
    tail = tail.then(work).catch(report);
  };

  /** The open file of one announced invocation, opening it on first use. */
  const openFile = async (entry: Entry): Promise<FileHandle> => {
    if (entry.handle === null) {
      await mkdir(path.dirname(entry.file), { recursive: true });
      entry.handle = await open(entry.file, 'a');
    }
    return entry.handle;
  };

  return {
    start(identity) {
      if (closed || entries.has(identity.invocationId)) {
        return;
      }
      const entry: Entry = { file: identity.log.path, handle: null };
      entries.set(identity.invocationId, entry);
      // The file is open before the invocation's first activity packet is written.
      chain(async () => {
        await openFile(entry);
      });
    },
    record(activity) {
      if (closed) {
        return;
      }
      const entry = entries.get(activity.invocationId);
      if (entry === undefined) {
        report(
          new Error(
            `no invocation "${activity.invocationId}" was announced; its activity has no log file`,
          ),
        );
        return;
      }
      let line: string;
      try {
        // Timestamp on receipt, so the saved timestamp does not depend on write timing.
        line = `${JSON.stringify({ timestamp: activity.timestamp, activity: activity.activity })}\n`;
      } catch (error) {
        report(error);
        return;
      }
      chain(async () => {
        const opened = await openFile(entry);
        // writeFile writes the complete line; write can stop at a partial write.
        await opened.writeFile(line);
      });
    },
    finish(identity) {
      const entry = entries.get(identity.invocationId);
      if (entry === undefined) {
        return;
      }
      entries.delete(identity.invocationId);
      chain(async () => {
        const opened = entry.handle;
        entry.handle = null;
        if (opened !== null) {
          await opened.close();
        }
      });
    },
    async drain() {
      await tail;
    },
    async close() {
      closed = true;
      await tail;
      const opened = [...entries.values()].flatMap((entry) =>
        entry.handle === null ? [] : [entry.handle],
      );
      entries.clear();
      for (const handle of opened) {
        try {
          await handle.close();
        } catch (error) {
          report(error);
        }
      }
    },
  };
}
