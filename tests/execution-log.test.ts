/**
 * Focused component test: the real execution log over a temporary file whose file handle lets a
 * write complete with only part of its data — the platform behavior the saved lines must survive.
 * Every other filesystem call is real.
 */

import { mkdtemp, readFile, rm, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionLog } from '../src/application/execution-log.js';

/** The most characters one intercepted write lets reach the file. */
const partialWriteChunk = 4096;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (file, flags) => {
    const handle = await actual.open(file, flags);
    return {
      async write(data: string | Uint8Array) {
        const result =
          typeof data === 'string'
            ? await handle.write(data.slice(0, partialWriteChunk))
            : await handle.write(data.subarray(0, partialWriteChunk));
        return { bytesWritten: result.bytesWritten, buffer: data };
      },
      writeFile: (data: string | Uint8Array) => handle.writeFile(data),
      close: () => handle.close(),
    } as unknown as FileHandle;
  };
  return { ...actual, open };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Execution log', () => {
  it('persists a large event as one complete line when a write completes partially', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-execution-log-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'logs', 'events.jsonl');
    const diagnostics: string[] = [];
    const log = await createExecutionLog({
      file,
      diagnostics: { write: (text) => diagnostics.push(text) },
    });

    const activity = { type: 'message', text: 'event payload '.repeat(64 * 1024) };
    log.record({ source: 'agent-runtime', type: 'agent-activity', data: activity });
    await log.close();

    // A partial write would leave the line truncated and unparseable.
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { readonly event: { readonly data: unknown } };
    expect(entry.event.data).toEqual(activity);
    expect(diagnostics).toEqual([]);
  });
});
