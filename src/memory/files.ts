import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { messageOf } from '../result.js';

/**
 * Durable JSON documents for the Memory component. Every document is written to a uniquely named
 * sibling file and renamed into place, so a reader never observes a partial replacement of a
 * receipt, binding or retrieval record, and a failed write leaves the previous document intact.
 */

/** Read a JSON document; a missing file is null, unreadable or unparsable content is an error. */
export async function readJsonFile(file: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Memory could not read "${file}": ${messageOf(error)}`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Memory found invalid JSON in "${file}": ${messageOf(error)}`, {
      cause: error,
    });
  }
}

/** Replace a JSON document atomically: write a complete sibling file, then rename it. */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.partial.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw new Error(`Memory could not write "${file}": ${messageOf(error)}`, { cause: error });
  }
}
