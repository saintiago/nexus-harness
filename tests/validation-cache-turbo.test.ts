/**
 * The mechanism the validation cache promises, run for real.
 *
 * `tests/validation-cache.test.ts` checks what this repository declares to
 * Turborepo. These cases check that the installed tool, invoked the way the gate
 * invokes it — through `scripts/turbo.mjs` — does what those declarations
 * assume: a hit replays instead of running, a change to a declared input
 * invalidates, an undeclared file does not, a declared output comes back when it
 * is missing, a failed or interrupted task never becomes a success, a damaged
 * cache entry cannot be replayed as one, and a runtime the result did not come
 * from cannot reuse it.
 *
 * Each case works in its own throwaway single-package fixture outside the
 * repository, so no case shares a mutable repository, process or workspace with
 * another, and the repository's own cache is never touched
 * (docs/validation-caching.md).
 */

import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
 * Every case here makes several real Turborepo runs — a framework, a package
 * manager, a Node process and the task itself per invocation — so like the
 * completion cases that make more than one pass, each states its own bound
 * instead of pretending its work fits the default five seconds. A single
 * command's own bound is `FIXTURE_BOUND_MS`.
 */
const FIXTURE_CASE_BOUND_MS = 60_000;

/** The interrupted case adds a five-second task that has to finish, too. */
const INTERRUPTED_CASE_BOUND_MS = FIXTURE_CASE_BOUND_MS;

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
        // The same two values the repository declares: the runtime the wrapper
        // observed, so a task's result belongs to the runtime that produced it.
        globalEnv: ['NEXUS_VALIDATE_NODE', 'NEXUS_VALIDATE_NPM'],
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
      // What the wrapper told this task it was running on: the identity the
      // result is cached under.
      "writeFileSync('runtime.txt', `${process.env.NEXUS_VALIDATE_NODE ?? 'unset'}\\n${process.env.NEXUS_VALIDATE_NPM ?? 'unset'}\\n`);",
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

/** What one fixture invocation of the wrapper is told. */
interface FixtureRunOptions {
  readonly timeoutMs?: number;
  /** PATH for this run: what the wrapper resolves `node` and `npm` through. */
  readonly path?: string;
  /** The environment the wrapper itself is started with. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Runs one fixture task through the repository's own wrapper. */
async function turboTask(
  directory: string,
  task: string,
  options: FixtureRunOptions = {},
): Promise<FixtureRun> {
  return await runProcess(process.execPath, [WRAPPER, 'run', task], {
    cwd: directory,
    // The suite never lets a fixture reach a network service, and the wrapper
    // is what keeps telemetry off for the gate as well.
    env: {
      ...process.env,
      ...options.env,
      PATH: options.path ?? process.env.PATH,
      TURBO_TELEMETRY_DISABLED: '1',
    },
    timeoutMs: options.timeoutMs ?? FIXTURE_BOUND_MS,
  });
}

/** One directory in front of the real PATH: what a shadowed runtime needs. */
function inFrontOfPath(directory: string): string {
  return [directory, process.env.PATH ?? ''].join(path.delimiter);
}

/**
 * A directory whose own `node` reports a version of its choosing and hands
 * everything else to the real interpreter, so the gate really does run on a
 * different runtime than the one the earlier result was produced on. On Windows
 * it is a `node.cmd` (the `cmd` shell that resolves `node --version` prefers it
 * over the real `node.exe` behind it on PATH); on POSIX an executable script.
 */
async function shadowedNode(version: string): Promise<string> {
  const directory = await createTempDir();
  const real = process.execPath;
  if (process.platform === 'win32') {
    await writeFile(
      path.join(directory, 'node.cmd'),
      [
        '@echo off',
        'if "%~1"=="--version" (',
        `echo ${version}`,
        'exit /b 0',
        ')',
        `"${real}" %*`,
        '',
      ].join('\r\n'),
      'utf8',
    );
  } else {
    const script = path.join(directory, 'node');
    await writeFile(
      script,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        `  echo ${version}`,
        '  exit 0',
        'fi',
        `exec "${real}" "$@"`,
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(script, 0o755);
  }
  return directory;
}

/**
 * The version one runtime reports, resolved the way the wrapper resolves it:
 * through the shell's own PATH lookup, not by asking this process what it is.
 */
async function observedVersion(
  command: 'node' | 'npm',
  pathValue = process.env.PATH,
): Promise<string> {
  const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `${command} --version`]
      : ['-c', `${command} --version`];
  const result = await runProcess(shell, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: pathValue,
    },
    timeoutMs: FIXTURE_BOUND_MS,
  });
  expect(result.code).toBe(0);
  return result.stdout.trim();
}

/** The runtime the last fixture run told its task it was running on. */
async function recordedRuntime(directory: string): Promise<readonly [string, string]> {
  const recorded = (await readFile(path.join(directory, 'runtime.txt'), 'utf8')).split('\n');
  return [recorded[0] ?? '', recorded[1] ?? ''];
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
  it(
    'replays a task instead of running it again, out of a cache of this platform',
    async () => {
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
    },
    FIXTURE_CASE_BOUND_MS,
  );

  it(
    'invalidates on a declared input, and not on a file the task never reads',
    async () => {
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
    },
    FIXTURE_CASE_BOUND_MS,
  );

  it(
    'restores a declared output that was removed, without running the task',
    async () => {
      const fixture = await createCacheFixture();
      await turboTask(fixture, 'work');
      await rm(path.join(fixture, 'out'), { recursive: true, force: true });
      expect(existsSync(path.join(fixture, 'out', 'result.txt'))).toBe(false);

      const restored = await turboTask(fixture, 'work');
      expect(restored.code).toBe(0);
      expect(restored.stdout).toContain('cache hit, replaying logs');
      expect(await executions(fixture)).toBe(1);
      expect(existsSync(path.join(fixture, 'out', 'result.txt'))).toBe(true);
    },
    FIXTURE_CASE_BOUND_MS,
  );

  it(
    'never stores a failed task as a success',
    async () => {
      const fixture = await createCacheFixture();

      const first = await turboTask(fixture, 'fail');
      expect(first.code).not.toBe(0);

      const second = await turboTask(fixture, 'fail');
      expect(second.code).not.toBe(0);
      // Executed again rather than replayed from a stored failure.
      expect(second.stdout).toContain('cache miss, executing');
      expect(await executions(fixture, 'fails.txt')).toBe(2);
    },
    FIXTURE_CASE_BOUND_MS,
  );

  it(
    'never replays work that was interrupted before it finished',
    async () => {
      const fixture = await createCacheFixture();

      // Stopped inside its own work: the task cannot have been recorded, and the
      // next run with the same inputs has to do the work rather than replay it.
      await expect(turboTask(fixture, 'slow', { timeoutMs: 2_000 })).rejects.toThrow(
        /did not end within its/u,
      );
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

  it(
    'falls back to executing when the cached artefact is damaged',
    async () => {
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
    },
    FIXTURE_CASE_BOUND_MS,
  );

  it(
    'reports what it reused, and what it executed, for one whole run',
    async () => {
      const fixture = await createCacheFixture();
      await turboTask(fixture, 'work');
      await appendFile(path.join(fixture, 'src', 'input.txt'), 'more\n', 'utf8');

      const mixed = await turboTask(fixture, 'work');
      expect(mixed.code).toBe(0);
      // The summary distinguishes the two outcomes: an operator reading a gate
      // log can see which tasks executed and which were replayed.
      expect(mixed.stdout).toMatch(/Tasks:\s+1 successful, 1 total/u);
      expect(mixed.stdout).toMatch(/Cached:\s+0 cached, 1 total/u);
    },
    FIXTURE_CASE_BOUND_MS,
  );

  it(
    'refuses arguments that Turborepo would append to every task',
    async () => {
      const fixture = await createCacheFixture();

      // `turbo run <tasks> -- <args>` hands the arguments to *every* task, so
      // reporter flags meant for Vitest would reach Prettier and ESLint. The
      // refusal names what to run instead.
      const refused = await runProcess(
        process.execPath,
        [WRAPPER, 'run', 'work', '--', '--reporter=verbose'],
        {
          cwd: fixture,
          env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
          timeoutMs: FIXTURE_BOUND_MS,
        },
      );
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('does not pass arguments through');
      expect(await executions(fixture)).toBe(0);
    },
    FIXTURE_CASE_BOUND_MS,
  );

  it(
    'hands the task the runtime it observed, and cannot reuse a result from another one',
    async () => {
      const fixture = await createCacheFixture();

      const first = await turboTask(fixture, 'work');
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('cache miss, executing');
      // The identity the wrapper passed is the runtime PATH resolves — the same
      // one the task itself runs on — not what `.nvmrc` or `packageManager`
      // declare. Both are read back through their own PATH lookup here.
      expect(await recordedRuntime(fixture)).toEqual([
        await observedVersion('node'),
        await observedVersion('npm'),
      ]);

      // Unchanged, the result stands and the task is not executed again.
      const second = await turboTask(fixture, 'work');
      expect(second.stdout).toContain('cache hit, replaying logs');
      expect(await executions(fixture)).toBe(1);

      // The same checkout on another runtime: the gate observes it, and the
      // earlier result — produced by the other Node — is not reused.
      const shadow = await shadowedNode('v0.0.0-shadow');
      const shadowed = await turboTask(fixture, 'work', { path: inFrontOfPath(shadow) });
      expect(shadowed.stdout).toContain('cache miss, executing');
      expect(await executions(fixture)).toBe(2);
      expect(await recordedRuntime(fixture)).toEqual([
        await observedVersion('node', inFrontOfPath(shadow)),
        await observedVersion('npm', inFrontOfPath(shadow)),
      ]);

      // And back on the first runtime, the result it produced is still there.
      const restored = await turboTask(fixture, 'work');
      expect(restored.stdout).toContain('cache hit, replaying logs');
      expect(await executions(fixture)).toBe(2);
    },
    FIXTURE_CASE_BOUND_MS,
  );

  it(
    'invalidates on a change to the package manifest, and on one to the lockfile',
    async () => {
      const fixture = await createCacheFixture();
      await turboTask(fixture, 'work');
      await turboTask(fixture, 'work');
      expect(await executions(fixture)).toBe(1);

      // A manifest change the task itself does not read: Turborepo hashes the
      // package graph, so installing or re-declaring anything is a new result.
      const manifestPath = path.join(fixture, 'package.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        version: string;
      };
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, version: '1.0.1' }, null, 2),
        'utf8',
      );
      const afterManifest = await turboTask(fixture, 'work');
      expect(afterManifest.stdout).toContain('cache miss, executing');
      expect(await executions(fixture)).toBe(2);

      // The same for the lockfile `npm ci` rewrites.
      const lockPath = path.join(fixture, 'package-lock.json');
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
        packages: Record<string, { version?: string }>;
      };
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            ...lock,
            packages: { ...lock.packages, '': { ...lock.packages[''], version: '1.0.1' } },
          },
          null,
          2,
        ),
        'utf8',
      );
      const afterLock = await turboTask(fixture, 'work');
      expect(afterLock.stdout).toContain('cache miss, executing');
      expect(await executions(fixture)).toBe(3);
    },
    FIXTURE_CASE_BOUND_MS,
  );

  it(
    'stops rather than reuse a result when the executing runtime cannot be observed',
    async () => {
      const fixture = await createCacheFixture();
      await turboTask(fixture, 'work');
      expect(await executions(fixture)).toBe(1);

      // A PATH where `node` cannot be resolved at all: the gate cannot say which
      // runtime a result would belong to, so it refuses to produce one.
      const empty = await createTempDir();
      const refused = await turboTask(fixture, 'work', { path: empty });
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('could not be read');
      expect(await executions(fixture)).toBe(1);
    },
    FIXTURE_CASE_BOUND_MS,
  );
});
