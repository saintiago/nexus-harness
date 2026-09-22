/**
 * The build guard, run for real against a throwaway project.
 *
 * `scripts/build.mjs` regenerates `dist/` instead of resuming it, because
 * TypeScript's incremental emit trusts its own record: with `.tsbuildinfo`
 * present it reports a project whose output was partly or wholly removed as up
 * to date and emits nothing, exit 0. Generated output being removed is ordinary
 * here — a fresh checkout, an operator clearing generated files, a task cache
 * that was cleared or never restored — and a task cache restores the output
 * tree it stored, not the state that was beside it.
 *
 * These cases compile a two-module project with this checkout's own installed
 * TypeScript, through the same entry point `npm run build` uses, and check what
 * the guard leaves behind: every module of the current sources, no module of an
 * earlier revision, nothing half-built reported as a build, and no incremental
 * state at all in the emitting project. `tests/validation-cache.test.ts` reads
 * the declarations these cases rest on.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempDir, repoRoot } from './support.js';
import { runProcess, useFixtureLifecycle } from './fixtures/lifecycle.js';

useFixtureLifecycle();

/** The guard `npm run build` runs. */
const GUARD = path.join(repoRoot, 'scripts', 'build.mjs');

/**
 * One build is a real compiler run over a real project: a few seconds each, and
 * the cases here make two or three. Like the other multi-pass boundary cases,
 * each states its own bound instead of pretending one round is enough.
 */
const BUILD_CASE_BOUND_MS = 60_000;

/** The project's own emitting configuration, extending the repository's. */
async function writeProjectConfig(directory: string, extra: object = {}): Promise<void> {
  const base = path
    .relative(directory, path.join(repoRoot, 'tsconfig.build.json'))
    .split(path.sep)
    .join('/');
  await writeFile(
    path.join(directory, 'tsconfig.build.json'),
    JSON.stringify(
      {
        // The repository's emitting settings, so what these cases prove is what
        // `npm run build` runs: no incremental state, `dist/` as the output.
        extends: base,
        compilerOptions: { rootDir: 'src', outDir: 'dist', types: [], ...extra },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
    'utf8',
  );
}

/** A tiny emitting project: an entry point and two modules it imports. */
async function createProject(value = 'one'): Promise<string> {
  const directory = await createTempDir();
  await mkdir(path.join(directory, 'src'), { recursive: true });
  // The repository's emitting settings compile ESM (`module: nodenext` with
  // `verbatimModuleSyntax`), so the fixture has to be a module the same way.
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'build-guard-fixture', private: true, type: 'module' }, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(directory, 'src', 'cli.ts'),
    "import { value } from './value.js';\nimport { extra } from './extra.js';\nexport const report = `${value}:${String(extra)}`;\n",
    'utf8',
  );
  await writeFile(
    path.join(directory, 'src', 'value.ts'),
    `export const value = '${value}';\n`,
    'utf8',
  );
  await writeFile(path.join(directory, 'src', 'extra.ts'), 'export const extra = 1;\n', 'utf8');
  await writeProjectConfig(directory);
  return directory;
}

/** Runs the guard on one project, the way `npm run build` does. */
async function build(directory: string): Promise<Awaited<ReturnType<typeof runProcess>>> {
  return await runProcess(process.execPath, [GUARD, directory], {
    cwd: directory,
    timeoutMs: BUILD_CASE_BOUND_MS,
  });
}

/** Whether one emitted file exists, and what it contains. */
async function emitted(directory: string, file: string): Promise<string | undefined> {
  const absolute = path.join(directory, 'dist', file);
  return existsSync(absolute) ? await readFile(absolute, 'utf8') : undefined;
}

/** Every incremental-state file the project left anywhere under itself. */
async function buildInfoFiles(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) {
      found.push(path.relative(directory, path.join(entry.parentPath, entry.name)));
    }
  }
  return found.sort();
}

describe('the build guard', () => {
  it(
    'emits every module, and regenerates one that was removed',
    async () => {
      const project = await createProject();

      const first = await build(project);
      expect(first.code).toBe(0);
      expect(await emitted(project, 'cli.js')).toBeDefined();
      expect(await emitted(project, 'value.js')).toContain("'one'");
      expect(await emitted(project, 'extra.js')).toBeDefined();

      // A module removed from a complete build: the compiler alone would report
      // the project up to date and leave it missing, so the guard has to be the
      // one that brings it back.
      await rm(path.join(project, 'dist', 'value.js'), { force: true });
      const second = await build(project);
      expect(second.code).toBe(0);
      expect(await emitted(project, 'value.js')).toContain("'one'");
    },
    BUILD_CASE_BOUND_MS,
  );

  it(
    'leaves behind the current sources only, and no incremental state',
    async () => {
      const project = await createProject();
      expect((await build(project)).code).toBe(0);
      expect(await emitted(project, 'extra.js')).toBeDefined();

      // The module and the import that reached it are gone: an emit that
      // resumed an earlier state would leave `dist/extra.js` behind.
      await writeFile(
        path.join(project, 'src', 'cli.ts'),
        "import { value } from './value.js';\nexport const report = value;\n",
        'utf8',
      );
      await rm(path.join(project, 'src', 'extra.ts'), { force: true });
      expect((await build(project)).code).toBe(0);
      expect(await emitted(project, 'extra.js')).toBeUndefined();
      expect(await emitted(project, 'cli.js')).toContain('value');

      // And the emitting program kept no record of that earlier revision: the
      // state that would let it skip a tree it no longer matches.
      expect(await buildInfoFiles(project)).toEqual([]);
    },
    BUILD_CASE_BOUND_MS,
  );

  it(
    'rebuilds a behaviour change, and rebuilds the earlier revision again',
    async () => {
      const project = await createProject('one');
      expect((await build(project)).code).toBe(0);
      expect(await emitted(project, 'value.js')).toContain("'one'");

      await writeFile(
        path.join(project, 'src', 'value.ts'),
        "export const value = 'two';\n",
        'utf8',
      );
      expect((await build(project)).code).toBe(0);
      expect(await emitted(project, 'value.js')).toContain("'two'");

      // Back to the first revision: its output comes back too, rather than the
      // JavaScript of the revision in between.
      await writeFile(
        path.join(project, 'src', 'value.ts'),
        "export const value = 'one';\n",
        'utf8',
      );
      expect((await build(project)).code).toBe(0);
      expect(await emitted(project, 'value.js')).toContain("'one'");
      expect(await emitted(project, 'value.js')).not.toContain("'two'");
    },
    BUILD_CASE_BOUND_MS,
  );

  it(
    'fails when the compiler reports success without producing the artefact',
    async () => {
      const project = await createProject();
      // A project that type-checks and emits nothing: exit 0 from the compiler,
      // no `dist/cli.js` for `npm start` to run.
      await writeProjectConfig(project, { noEmit: true });

      const result = await build(project);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('reported success');
      expect(result.stderr).toContain('cli.js');
      expect(existsSync(path.join(project, 'dist', 'cli.js'))).toBe(false);
    },
    BUILD_CASE_BOUND_MS,
  );

  it(
    'never reports a compile that failed as a build',
    async () => {
      const project = await createProject();
      await writeFile(
        path.join(project, 'src', 'value.ts'),
        "export const value: number = 'not a number';\n",
        'utf8',
      );

      const result = await build(project);
      expect(result.code).not.toBe(0);
      // The compiler's own diagnostic, not a message invented here.
      expect(result.stdout).toContain('not assignable');
    },
    BUILD_CASE_BOUND_MS,
  );
});
