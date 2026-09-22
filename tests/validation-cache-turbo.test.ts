/**
 * The mechanism the validation cache promises, run for real.
 *
 * `tests/validation-cache.test.ts` checks what this repository declares to
 * Turborepo. These cases check that the installed tool, invoked the way the gate
 * invokes it — through `scripts/turbo.mjs` — does what those declarations
 * assume: a hit replays instead of running, a change to a declared input
 * invalidates, an undeclared file does not, a declared output comes back when it
 * is missing, a failed or interrupted task never becomes a success, and a
 * damaged cache entry cannot be replayed as one.
 *
 * Each case works in its own throwaway single-package fixture outside the
 * repository, so no case shares a mutable repository, process or workspace with
 * another, and the repository's own cache is never touched
 * (docs/validation-caching.md).
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir, repoRoot } from './support.js';
import { runProcess, useFixtureLifecycle } from './fixtures/lifecycle.js';

useFixtureLifecycle();

/** The wrapper the gate runs, from this checkout. */
const WRAPPER = path.join(repoRoot, 'scripts', 'turbo.mjs');

/** Bound for a fixture command that is meant to finish. */
const FIXTURE_BOUND_MS = 60_000;

/**
 * How long the interrupted case may take: a run stopped inside the fixture's
 * five-second task, and then a second run that completes it. Like the
 * completion cases that make more than one pass, this case states its own bound
 * instead of pretending its work fits the default five seconds.
 */
const INTERRUPTED_CASE_BOUND_MS = 30_000;

/** One fixture task's work: what it did, when it did it. */
interface FixtureRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A throwaway package with three tasks: one that records its own execution and
 * writes a declared output, one that records its execution and then waits long
 * enough to be interrupted, and one that fails.
 */
async function createCacheFixture(): Promise<string> {
  const directory = await createTempDir();
  const write = async (name: string, contents: string): Promise<void> => {
    await writeFile(path.join(directory, name), contents, 'utf8');
  };

  await mkdir(path.join(directory, 'src'), { recursive: true });
  await write(
    'package.json',
    JSON.stringify(
      {
        name: 'validation-cache-fixture',
        version: '1.0.0',
        private: true,
        packageManager: 'npm@11.11.0',
        scripts: {
          work: 'node work.mjs',
          slow: 'node slow.mjs',
          fail: 'node fail.mjs',
        },
      },
      null,
      2,
    ),
  );
  await write(
    'package-lock.json',
    JSON.stringify(
      {
        name: 'validation-cache-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'validation-cache-fixture', version: '1.0.0' } },
      },
      null,
      2,
    ),
  );
  // Only what each task declares is an input: `src/**` and the task's own
  // entry point. Nothing here reads `runs.txt` or `out/`, so the record of
  // execution cannot itself invalidate the result being examined.
  await write(
    'turbo.json',
    JSON.stringify(
      {
        $schema: 'https://turborepo.dev/schema.json',
        tasks: {
          work: { inputs: ['src/**', 'work.mjs'], outputs: ['out/**'] },
          slow: { inputs: ['src/**', 'slow.mjs'], outputs: ['out/**'] },
          fail: { inputs: ['fail.mjs'] },
        },
      },
      null,
      2,
    ),
  );
  await write(path.join('src', 'input.txt'), 'one\n');
  await write(
    'work.mjs',
    [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
      "appendFileSync('runs.txt', 'work\\n');",
      "mkdirSync('out', { recursive: true });",
      "writeFileSync('out/result.txt', 'result\\n');",
      '',
    ].join('\n'),
  );
  await write(
    'slow.mjs',
    [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
      "appendFileSync('runs.txt', 'slow\\n');",
      "mkdirSync('out', { recursive: true });",
      "writeFileSync('out/slow.txt', 'slow\\n');",
      'await new Promise((resolve) => setTimeout(resolve, 5_000));',
      '',
    ].join('\n'),
  );
  await write(
    'fail.mjs',
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync('fails.txt', 'fail\\n');",
      "console.error('fixture task failed');",
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  return directory;
}

/** Runs one fixture task through the repository's own wrapper. */
async function turboTask(
  directory: string,
  task: string,
  timeoutMs = FIXTURE_BOUND_MS,
): Promise<FixtureRun> {
  return await runProcess(process.execPath, [WRAPPER, 'run', task], {
    cwd: directory,
    // The suite never lets a fixture reach a network service, and the wrapper
    // is what keeps telemetry off for the gate as well.
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
    timeoutMs,
  });
}

/** How many times a fixture task has recorded its own execution. */
async function executions(directory: string, marker = 'runs.txt'): Promise<number> {
  const file = path.join(directory, marker);
  if (!existsSync(file)) return 0;
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').length;
}

/** Every file the local cache holds for one fixture. */
async function cacheEntries(directory: string): Promise<readonly string[]> {
  const root = path.join(directory, '.turbo', 'cache');
  const found: string[] = [];
  for (const platform of await readdir(root, { withFileTypes: true })) {
    const platformRoot = path.join(root, platform.name);
    if (!platform.isDirectory()) continue;
    for (const entry of await readdir(platformRoot)) {
      found.push(path.join(platformRoot, entry));
    }
  }
  return found;
}

describe('the local task cache', () => {
  it('replays a task instead of running it again, out of a cache of this platform', async () => {
    const fixture = await createCacheFixture();

    const first = await turboTask(fixture, 'work');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('cache miss, executing');
    expect(await executions(fixture)).toBe(1);

    const second = await turboTask(fixture, 'work');
    expect(second.code).toBe(0);
    // The result is reused, and the task is not claimed to have run: the log
    // line says what happened, and the marker file proves what did not.
    expect(second.stdout).toContain('cache hit, replaying logs');
    expect(await executions(fixture)).toBe(1);
    expect(existsSync(path.join(fixture, 'out', 'result.txt'))).toBe(true);

    // The wrapper keeps every platform's cache apart, so a checkout read from
    // two systems never replays the other system's result.
    const platformCache = path.join(
      fixture,
      '.turbo',
      'cache',
      `${process.platform}-${process.arch}`,
    );
    expect(existsSync(platformCache)).toBe(true);
    expect(await cacheEntries(fixture)).not.toEqual([]);
  });

  it('invalidates on a declared input, and not on a file the task never reads', async () => {
    const fixture = await createCacheFixture();
    await turboTask(fixture, 'work');
    await turboTask(fixture, 'work');
    expect(await executions(fixture)).toBe(1);

    // A declared input: the next run has to execute the task again.
    await writeFile(path.join(fixture, 'src', 'input.txt'), 'two\n', 'utf8');
    const afterEdit = await turboTask(fixture, 'work');
    expect(afterEdit.stdout).toContain('cache miss, executing');
    expect(await executions(fixture)).toBe(2);

    // An unrelated file, which no task declares: the result still stands.
    await writeFile(path.join(fixture, 'notes.md'), 'unrelated\n', 'utf8');
    const afterUnrelatedEdit = await turboTask(fixture, 'work');
    expect(afterUnrelatedEdit.stdout).toContain('cache hit, replaying logs');
    expect(await executions(fixture)).toBe(2);

    // A new file that *is* covered by a declared glob counts like an edit.
    await writeFile(path.join(fixture, 'src', 'added.txt'), 'added\n', 'utf8');
    const afterAddedFile = await turboTask(fixture, 'work');
    expect(afterAddedFile.stdout).toContain('cache miss, executing');
    expect(await executions(fixture)).toBe(3);
  });

  it('restores a declared output that was removed, without running the task', async () => {
    const fixture = await createCacheFixture();
    await turboTask(fixture, 'work');
    await rm(path.join(fixture, 'out'), { recursive: true, force: true });
    expect(existsSync(path.join(fixture, 'out', 'result.txt'))).toBe(false);

    const restored = await turboTask(fixture, 'work');
    expect(restored.code).toBe(0);
    expect(restored.stdout).toContain('cache hit, replaying logs');
    expect(await executions(fixture)).toBe(1);
    expect(existsSync(path.join(fixture, 'out', 'result.txt'))).toBe(true);
  });

  it('never stores a failed task as a success', async () => {
    const fixture = await createCacheFixture();

    const first = await turboTask(fixture, 'fail');
    expect(first.code).not.toBe(0);

    const second = await turboTask(fixture, 'fail');
    expect(second.code).not.toBe(0);
    // Executed again rather than replayed from a stored failure.
    expect(second.stdout).toContain('cache miss, executing');
    expect(await executions(fixture, 'fails.txt')).toBe(2);
  });

  it(
    'never replays work that was interrupted before it finished',
    async () => {
      const fixture = await createCacheFixture();

      // Stopped inside its own work: the task cannot have been recorded, and the
      // next run with the same inputs has to do the work rather than replay it.
      await expect(turboTask(fixture, 'slow', 2_000)).rejects.toThrow(/did not end within its/u);
      const beforeRestart = await executions(fixture);

      const second = await turboTask(fixture, 'slow');
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('cache miss, executing');
      // Exactly one more execution: the restarted run did the work itself, even
      // though the interrupted run had the same inputs.
      expect(await executions(fixture)).toBe(beforeRestart + 1);
      expect(existsSync(path.join(fixture, 'out', 'slow.txt'))).toBe(true);
    },
    INTERRUPTED_CASE_BOUND_MS,
  );

  it('falls back to executing when the cached artefact is damaged', async () => {
    const fixture = await createCacheFixture();
    await turboTask(fixture, 'work');
    expect(await executions(fixture)).toBe(1);

    // Damage every stored artefact and remove what the hit would restore: a
    // result that cannot be restored must not be reported as one.
    for (const entry of await cacheEntries(fixture)) {
      if (entry.endsWith('.tar.zst')) await writeFile(entry, 'not a stored result', 'utf8');
    }
    await rm(path.join(fixture, 'out'), { recursive: true, force: true });

    const damaged = await turboTask(fixture, 'work');
    expect(damaged.code).toBe(0);
    expect(damaged.stdout).toContain('cache miss, executing');
    expect(await executions(fixture)).toBe(2);
    expect(existsSync(path.join(fixture, 'out', 'result.txt'))).toBe(true);
  });

  it('reports what it reused, and what it executed, for one whole run', async () => {
    const fixture = await createCacheFixture();
    await turboTask(fixture, 'work');
    await appendFile(path.join(fixture, 'src', 'input.txt'), 'more\n', 'utf8');

    const mixed = await turboTask(fixture, 'work');
    expect(mixed.code).toBe(0);
    // The summary distinguishes the two outcomes: an operator reading a gate
    // log can see which tasks executed and which were replayed.
    expect(mixed.stdout).toMatch(/Tasks:\s+1 successful, 1 total/u);
    expect(mixed.stdout).toMatch(/Cached:\s+0 cached, 1 total/u);
  });
});
