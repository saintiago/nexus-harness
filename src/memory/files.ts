import { mkdir, open, link, readFile, rename, rm } from 'node:fs/promises';
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

/** Write one complete JSON document to a uniquely named sibling and return that filepath. */
async function writePartialJsonFile(file: string, value: unknown): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.partial.${process.pid}.${randomUUID()}`;
  try {
    const handle = await open(partial, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw new Error(`Memory could not write "${file}": ${messageOf(error)}`, { cause: error });
  }
  return partial;
}

/** Replace a JSON document atomically: write a complete sibling file, then rename it. */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  const partial = await writePartialJsonFile(file, value);
  try {
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw new Error(`Memory could not write "${file}": ${messageOf(error)}`, { cause: error });
  }
}

/**
 * Create a JSON document only when it does not exist yet, and report whether this call created
 * it. The complete document appears under its final name in one link, so a concurrent reader
 * never observes a partial file and concurrent creators cannot both believe they won.
 */
export async function createJsonFileExclusive(file: string, value: unknown): Promise<boolean> {
  const partial = await writePartialJsonFile(file, value);
  try {
    await link(partial, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw new Error(`Memory could not create "${file}": ${messageOf(error)}`, { cause: error });
  } finally {
    await rm(partial, { force: true }).catch(() => undefined);
  }
}
