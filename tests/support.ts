/**
 * Shared support for the fast unit suites: temporary directories a test owns,
 * the file helpers they use, and the repository root. Nothing here starts a
 * process, a Git command, or a network call.
 *
 * A directory created by {@link createTempDir} is removed after the test that
 * created it, so a case never touches the repository or the machine's real
 * environment. The removal retries the one refusal a still-releasing Windows
 * tree produces (`EBUSY`) and reports every other failure as it was.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

/** Repository root, derived from this file's location. */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const temporaryDirectories = new Set<string>();

/** Creates a temporary directory and registers it for removal after the test. */
export async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-unit-'));
  temporaryDirectories.add(directory);
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

/** Reads one file as UTF-8 text. */
export function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

/** The one removal refusal this helper waits out: a tree still being released. */
const TRANSIENT_REMOVAL_CODE = 'EBUSY';

/**
 * Runs one removal, retrying a transient refusal for a moment before it is
 * reported. Any other refusal, and one that happens every time, is thrown as it
 * was.
 */
export async function removeWithRetry(
  remove: () => Promise<void>,
  attempts = 5,
  pauseMs = 50,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove();
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | null)?.code;
      if (attempt >= attempts || code !== TRANSIENT_REMOVAL_CODE) {
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}

/** Removes every temporary directory this suite created and has not removed. */
export async function cleanupTempDirectories(): Promise<void> {
  const removing = [...temporaryDirectories];
  temporaryDirectories.clear();
  await Promise.all(
    removing.map((directory) =>
      removeWithRetry(() => rm(directory, { recursive: true, force: true })),
    ),
  );
}

afterEach(async () => {
  await cleanupTempDirectories();
});
