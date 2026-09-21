/**
 * The immutable snapshot store: one directory per identified snapshot, and a
 * pointer at `current.json` that a new turn starts from.
 *
 * A snapshot is written under a name derived from its own content, into a
 * temporary directory that is renamed into place, so a reader never sees a
 * half-written snapshot and a refresh never rewrites one a running turn holds.
 * Identical content reuses the directory it already has.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import type { SourceRef, Task } from '../shared/types.js';
import type {
  HistoryBrief,
  HistoryEntry,
  HistoryMirror,
  HistoryReportSummary,
  HistorySnapshot,
  HistorySourceRead,
} from './contract.js';
import { HistoryError } from './contract.js';
import { historyCurrentPath, historyReportsDir, historySnapshotsDir } from './paths.js';

/** The machine-readable half of one snapshot. */
interface SnapshotIndex {
  readonly version: 1;
  readonly id: string;
  readonly role: 'developer' | 'reviewer';
  readonly round: number | null;
  readonly takenAt: string;
  readonly ref: SourceRef;
  readonly task: Task;
  readonly brief: HistoryBrief;
  readonly sources: readonly HistorySourceRead[];
  readonly gaps: readonly string[];
  readonly mirrors: readonly HistoryMirror[];
  readonly entries: readonly HistoryEntry[];
  readonly reports: readonly HistoryReportSummary[];
}

/** A stable encoding: object keys are sorted, so equal content hashes equal. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

/** One line of an entry file's header, with nothing that could be read as one. */
function headerValue(value: string | number | null): string {
  if (value === null) {
    return '-';
  }
  return String(value).replace(/\s+/g, ' ');
}

/** A file name fragment that cannot be read as a path. */
function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'entry';
}

/** The file one entry is written to, relative to the snapshot directory. */
function entryFileName(index: number, entry: HistoryEntry): string {
  const rank = String(index + 1).padStart(4, '0');
  return `entries/${rank}-${entry.kind}-${safeName(entry.sourceId)}.md`;
}

/** One entry's complete file: the provenance header, then the wording verbatim. */
function entryFileText(entry: HistoryEntry): string {
  return [
    '---',
    `id: ${headerValue(entry.id)}`,
    `source: ${headerValue(entry.source)}`,
    `kind: ${headerValue(entry.kind)}`,
    `role: ${headerValue(entry.role)}`,
    `author: ${headerValue(entry.author)}`,
    `created: ${headerValue(entry.createdAt)}`,
    `updated: ${headerValue(entry.updatedAt)}`,
    `round: ${headerValue(entry.round)}`,
    `commit: ${headerValue(entry.commit)}`,
    `source-id: ${headerValue(entry.sourceId)}`,
    `url: ${headerValue(entry.url)}`,
    `edited: ${entry.edited ? 'true' : 'false'}`,
    `complete: ${entry.complete ? 'true' : 'false'}`,
    `problem: ${headerValue(entry.problem)}`,
    '---',
    '',
    entry.text.replace(/\s+$/, ''),
    '',
  ].join('\n');
}

/** One index line: role, author, time, round, source id, commit, and the file. */
function indexLine(entry: HistoryEntry): string {
  return (
    `- [${entry.role}] ${entry.author} — ${entry.createdAt}` +
    `${entry.updatedAt === null ? '' : ` (edited ${entry.updatedAt})`} — ` +
    `round ${entry.round === null ? '-' : String(entry.round)} — ` +
    `${entry.id} — commit ${entry.commit ?? '-'} — ${entry.file ?? '(not written)'}` +
    (entry.complete ? '' : ` — INCOMPLETE: ${entry.problem ?? 'no reason was recorded'}`)
  );
}

/** The human-readable index a turn is pointed at first. */
function indexMarkdown(index: SnapshotIndex, dir: string, reportsDir: string): string {
  const lines = [
    `# Ticket conversation history — ${index.ref.key}`,
    '',
    `- Snapshot: ${index.id}`,
    `- Ticket: ${index.ref.key} ${index.ref.url}`,
    `- Prepared for: ${index.role} turn${index.round === null ? '' : `, round ${String(index.round)}`}`,
    `- Taken: ${index.takenAt}`,
    `- Entries: ${String(index.entries.length)}`,
    `- Complete reports: ${reportsDir}`,
    `- Snapshot directory: ${dir}`,
    '',
    'Organization: role, author, time, round, source id, and the reviewed or delivered commit',
    'where the source reports one. Every entry file carries its provenance header and the original',
    'wording below it, unchanged. An entry marked INCOMPLETE is a report this machine could not',
    'read back in full: it is marked rather than reconstructed.',
    '',
    '## Index',
    '',
  ];
  if (index.entries.length === 0) {
    lines.push('(no conversation entry was read)');
  }
  for (const entry of index.entries) {
    lines.push(indexLine(entry));
  }
  lines.push('', '## Sources read', '');
  for (const source of index.sources) {
    lines.push(
      `- ${source.source}: ${source.problem === null ? 'read in full' : `incomplete — ${source.problem}`}`,
    );
  }
  lines.push('', '## Gaps', '');
  if (index.gaps.length === 0) {
    lines.push('(none: every source named above was read, and every entry is complete)');
  }
  for (const gap of index.gaps) {
    lines.push(`- ${gap}`);
  }
  if (index.mirrors.length > 0) {
    lines.push('', '## Mirrored renderings (not duplicated)', '');
    for (const mirror of index.mirrors) {
      lines.push(
        `- ${mirror.source}:${mirror.sourceId} is the published rendering of ${mirror.ofEntryId}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The tracked half of a snapshot: what its identity is derived from. */
export interface SnapshotContent {
  readonly role: 'developer' | 'reviewer';
  readonly round: number | null;
  readonly ref: SourceRef;
  readonly task: Task;
  readonly brief: HistoryBrief;
  readonly sources: readonly HistorySourceRead[];
  readonly gaps: readonly string[];
  readonly mirrors: readonly HistoryMirror[];
  readonly entries: readonly HistoryEntry[];
  readonly reports: readonly HistoryReportSummary[];
}

/** The identity of one snapshot: the content hash, never the wall clock. */
export function snapshotIdOf(content: SnapshotContent): string {
  return createHash('sha256').update(canonical(content)).digest('hex').slice(0, 32);
}

/** What `current.json` points a new turn at. */
export interface CurrentSnapshot {
  readonly version: 1;
  readonly snapshotId: string;
  readonly dir: string;
  readonly indexPath: string;
  readonly indexJsonPath: string;
  readonly entriesPath: string;
  readonly reportsDir: string;
  readonly role: 'developer' | 'reviewer';
  readonly round: number | null;
  readonly takenAt: string;
}

/** The two files one snapshot is read through, from its directory. */
function pathsOf(
  root: string,
  id: string,
): {
  readonly dir: string;
  readonly indexPath: string;
  readonly indexJsonPath: string;
  readonly entriesPath: string;
  readonly reportsDir: string;
} {
  const dir = path.join(historySnapshotsDir(root), id);
  return {
    dir,
    indexPath: path.join(dir, 'index.md'),
    indexJsonPath: path.join(dir, 'index.json'),
    entriesPath: path.join(dir, 'entries.jsonl'),
    reportsDir: historyReportsDir(root),
  };
}

/** Writes one file inside a directory this call owns. */
async function writeOwned(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

/**
 * Writes one identified snapshot and points `current.json` at it. Content that
 * is already stored is reused rather than rewritten, so a refresh with nothing
 * new leaves the existing snapshot — and any turn reading it — untouched.
 */
export async function writeSnapshot(
  root: string,
  content: SnapshotContent,
  now: Date,
): Promise<HistorySnapshot> {
  const id = snapshotIdOf(content);
  const target = pathsOf(root, id);
  let takenAt = now.toISOString();

  const entries: HistoryEntry[] = content.entries.map((entry, index) => ({
    ...entry,
    file: entryFileName(index, entry),
  }));
  const index: SnapshotIndex = {
    version: 1,
    id,
    role: content.role,
    round: content.round,
    takenAt,
    ref: content.ref,
    task: content.task,
    brief: content.brief,
    sources: content.sources,
    gaps: content.gaps,
    mirrors: content.mirrors,
    entries,
    reports: content.reports,
  };

  const existing = await readSnapshot(root, id);
  if (existing !== null) {
    takenAt = existing.takenAt;
  } else {
    const temporary = path.join(
      historySnapshotsDir(root),
      `.tmp-${randomBytes(6).toString('hex')}`,
    );
    try {
      await mkdir(path.join(temporary, 'entries'), { recursive: true });
      for (const entry of entries) {
        await writeOwned(path.join(temporary, entry.file ?? ''), entryFileText(entry));
      }
      await writeOwned(
        path.join(temporary, 'entries.jsonl'),
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
      );
      await writeOwned(path.join(temporary, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
      await writeOwned(
        path.join(temporary, 'index.md'),
        indexMarkdown(index, target.dir, target.reportsDir),
      );
      // The current ticket requirements are part of the snapshot, whole, so an
      // agent can read them from the local history even though the prompt's own
      // ticket section is bounded for readability.
      await writeOwned(
        path.join(temporary, 'task.json'),
        `${JSON.stringify({ ref: content.ref, task: content.task }, null, 2)}\n`,
      );
      await mkdir(historySnapshotsDir(root), { recursive: true });
      await rename(temporary, target.dir);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      const raced = await readSnapshot(root, id);
      if (raced === null) {
        throw new HistoryError(
          'essential',
          `the conversation snapshot "${target.dir}" could not be written, so no turn may start ` +
            `without the local history it is promised: ${messageOf(cause)}`,
          { cause },
        );
      }
      takenAt = raced.takenAt;
    }
  }

  const current: CurrentSnapshot = {
    version: 1,
    snapshotId: id,
    ...target,
    role: content.role,
    round: content.round,
    takenAt,
  };
  try {
    const temporary = `${historyCurrentPath(root)}.${randomBytes(4).toString('hex')}.tmp`;
    await mkdir(root, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    await rename(temporary, historyCurrentPath(root));
  } catch (cause) {
    throw new HistoryError(
      'essential',
      `the conversation snapshot pointer "${historyCurrentPath(root)}" could not be written: ` +
        messageOf(cause),
      { cause },
    );
  }

  return {
    version: 1,
    id,
    role: content.role,
    round: content.round,
    takenAt,
    root,
    ...target,
    brief: content.brief,
    entries,
    reports: content.reports,
    gaps: content.gaps,
    mirrors: content.mirrors,
    sources: content.sources,
  };
}

/** One stored snapshot's metadata, or `null` when there is none. */
export async function readSnapshot(root: string, id: string): Promise<SnapshotIndex | null> {
  try {
    const text = await readFile(pathsOf(root, id).indexJsonPath, 'utf8');
    return JSON.parse(text) as SnapshotIndex;
  } catch {
    return null;
  }
}

/** The snapshot `current.json` points at, or `null` when there is none. */
export async function readCurrent(root: string): Promise<CurrentSnapshot | null> {
  try {
    const text = await readFile(historyCurrentPath(root), 'utf8');
    return JSON.parse(text) as CurrentSnapshot;
  } catch {
    return null;
  }
}

/**
 * The entries of the newest stored snapshot, so a refresh can tell an edited
 * entry from a new one. An unreadable store is reported as `null`, never as an
 * empty history.
 */
export async function readLatestEntries(
  root: string,
): Promise<{ readonly id: string; readonly entries: readonly HistoryEntry[] } | null> {
  const current = await readCurrent(root);
  if (current === null) {
    return null;
  }
  try {
    const text = await readFile(current.entriesPath, 'utf8');
    const entries: HistoryEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      entries.push(JSON.parse(line) as HistoryEntry);
    }
    return { id: current.snapshotId, entries };
  } catch {
    return null;
  }
}

/** Every snapshot id stored under one root, oldest name first. */
export async function listSnapshots(root: string): Promise<readonly string[]> {
  try {
    const names = await readdir(historySnapshotsDir(root));
    return names.filter((name) => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
}
