/**
 * Shared test support. File tests work in temporary directories so that neither
 * the repository nor the real environment is touched.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file's location. */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

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
 * Runs one removal, retrying a refusal for a moment before it is reported.
 *
 * On Windows a removal can race a handle something else still has on the
 * directory or its files, and the refusal it reports is transient. Measured on
 * the host this was written for: neither a process whose working directory the
 * tree is nor an open file in it refuses the removal, so what a suite raises
 * itself is not what holds it (notes/windows-fixture-flakes.md). A removal that
 * is refused every time still throws, so a directory something is really holding
 * is not quietly kept.
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
      if (attempt >= attempts) {
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}
