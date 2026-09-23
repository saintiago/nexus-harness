/**
 * The supervised recoveries one ticket's history has to carry.
 *
 * When the supervisor's parent sees a queue stop unexpectedly, the recovery
 * agent investigates and repairs it, and the incident that records all of that
 * is the only account of what happened between two deliveries of a ticket. A
 * developer or reviewer turn that never sees it works from a history with a
 * hole in it, so every incident record under the supervisor's own root is read
 * back here — whole, with every attempt and its evidence paths — and handed to
 * the snapshot as an entry of its own.
 *
 * Nothing here writes, repairs or publishes: the records are read where the
 * supervisor kept them, and an incident that cannot be read is reported as a
 * gap rather than filled in (docs/WORKFLOW.md §12, docs/spec.md §12).
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { incidentFilePath, readIncident } from '../supervisor/incident.js';
import type { IncidentRecord } from '../supervisor/incident.js';
import { incidentHistoryText } from '../supervisor/report.js';
import { messageOf } from '../shared/errors.js';
import type { HistoryEntry } from './contract.js';

/** The author every recovery entry is attributed to. */
export const RECOVERY_AUTHOR = 'Nexus recovery';

/** One incident's own window: when its recovery work began and last changed. */
export interface RecoveryWindow {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** What reading one ticket's supervised recoveries produced. */
export interface RecoveryHistory {
  readonly entries: readonly HistoryEntry[];
  /** One window per incident, for recognizing the account's own comments. */
  readonly windows: readonly RecoveryWindow[];
  /** Why the read is incomplete; empty when every record was read whole. */
  readonly problems: readonly string[];
}

/** One incident record and the file it was read from. */
interface StoredIncident {
  readonly record: IncidentRecord;
  readonly file: string;
}

/** Every incident record under one supervisor root, whatever its namespace. */
async function readStoredIncidents(supervisorRootDir: string): Promise<{
  readonly incidents: readonly StoredIncident[];
  readonly problems: readonly string[];
}> {
  const incidents: StoredIncident[] = [];
  const problems: string[] = [];
  let namespaces: readonly string[];
  try {
    namespaces = await readdir(supervisorRootDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { incidents: [], problems: [] };
    }
    return {
      incidents: [],
      problems: [
        `the supervisor's own state under "${supervisorRootDir}" could not be listed, so any ` +
          `recovery of this ticket is not represented here: ${messageOf(cause)}`,
      ],
    };
  }
  for (const namespace of [...namespaces].sort()) {
    const root = path.join(supervisorRootDir, namespace);
    let ids: readonly string[];
    try {
      ids = await readdir(path.join(root, 'incidents'));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      problems.push(
        `the incidents of the supervision under "${root}" could not be listed: ${messageOf(cause)}`,
      );
      continue;
    }
    for (const id of [...ids].sort()) {
      const file = incidentFilePath(root, id);
      try {
        const record = await readIncident(file);
        if (record !== null) {
          incidents.push({ record, file });
        }
      } catch (cause) {
        problems.push(
          `the recovery incident record "${file}" could not be read, so what it investigated is ` +
            `not represented in this snapshot: ${messageOf(cause)}`,
        );
      }
    }
  }
  return { incidents, problems };
}

/** One incident as the entry the history keeps, whole. */
function entryOfIncident(stored: StoredIncident): HistoryEntry {
  const { record, file } = stored;
  return {
    id: `harness:recovery-report:${record.id}`,
    source: 'harness',
    kind: 'recovery-report',
    role: 'harness',
    author: RECOVERY_AUTHOR,
    createdAt: record.createdAt,
    updatedAt: null,
    round: null,
    commit: null,
    state: record.conclusion?.outcome ?? record.stage,
    url: record.ticket?.url ?? null,
    sourceId: record.id,
    text: `Record: ${file}\n\n${incidentHistoryText(record)}`,
    edited: false,
    complete: true,
    problem: null,
    file: null,
  };
}

/**
 * Every supervised recovery of one ticket, as the entries its history carries.
 *
 * An incident belongs to the ticket it was scoped to, or — when an unscoped
 * worker stopped — to the ticket its own recovery named after investigating.
 * An incident that names neither cannot be attributed to this ticket's thread
 * and is left to its own record and its email summary.
 */
export async function readRecoveryHistory(request: {
  readonly workDir: string;
  readonly ticketKey: string;
}): Promise<RecoveryHistory> {
  const root = path.join(request.workDir, '.supervisor');
  const { incidents, problems } = await readStoredIncidents(root);
  const mine = incidents.filter(
    (stored) =>
      stored.record.ticket?.key === request.ticketKey ||
      (stored.record.ticket === null && stored.record.scope === request.ticketKey),
  );
  // The newest version of one incident wins: an interrupted invocation may have
  // left a second copy of a record that was read half-written.
  const byId = new Map<string, StoredIncident>();
  for (const stored of mine) {
    byId.set(stored.record.id, stored);
  }
  const kept = [...byId.values()].toSorted((a, b) =>
    a.record.createdAt.localeCompare(b.record.createdAt),
  );
  return {
    entries: kept.map(entryOfIncident),
    windows: kept.map((stored) => ({
      id: stored.record.id,
      from: stored.record.createdAt,
      to: stored.record.updatedAt,
    })),
    problems,
  };
}

/**
 * Whether one moment falls inside the window an incident's recovery covered:
 * the service account's own comments written then are that incident's.
 */
export function insideRecoveryWindow(windows: readonly RecoveryWindow[], at: string): boolean {
  const instant = Date.parse(at);
  if (Number.isNaN(instant)) {
    return false;
  }
  return windows.some((window) => {
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      return false;
    }
    return instant >= from && instant <= to;
  });
}
