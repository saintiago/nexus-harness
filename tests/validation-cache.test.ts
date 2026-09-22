/**
 * The declarations the validation gate's cache rests on.
 *
 * Turborepo does the caching; what this repository owns is what it *tells*
 * Turborepo: which tasks may be cached, what each one reads, and what must never
 * be reused. These cases read those declarations back — from `turbo.json`,
 * `package.json`, the tool configurations and the small scripts the gate runs —
 * and fail when a new file, task or tool setting would slip outside them. The
 * behaviour behind them (a hit replays, a changed input misses, a damaged entry
 * falls back to work) is exercised against the installed Turborepo in
 * `tests/validation-cache-turbo.test.ts`; the reasoning and the operator
 * commands are in docs/validation-caching.md.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './support.js';
import { policyFiles } from '../vitest.config.js';

/** Every check the gate runs, in the order `npm run validate` names them. */
const GATE_TASKS = [
  'format:check',
  'lint',
  'typecheck',
  'build',
  'test:policy:display',
  'test:policy:config',
  'test:policy:loop',
  'test:policy:intake',
  'test:policy:history',
  'test:boundary',
] as const;

/** The one gate task that must always execute. */
const FRESH_TASK = 'test:boundary';

/** The cache-eligible test groups, in the order the gate names them. */
const POLICY_GROUPS = GATE_TASKS.filter((task) => task.startsWith('test:policy:'));

/** The environment values every cache-eligible test task declares as input. */
const TEST_ENV_INPUTS = [
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'VITEST_*',
] as const;

/** What one `turbo.json` task declares about itself. */
interface TurboTask {
  readonly cache?: boolean;
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly env?: readonly string[];
}

/** The parts of `turbo.json` this contract rests on. */
interface TurboConfig {
  readonly cacheDir?: string;
  readonly remoteCache?: { readonly enabled?: boolean };
  readonly tasks: Record<string, TurboTask>;
}

const textCache = new Map<string, string>();

function readText(file: string): string {
  const cached = textCache.get(file);
  if (cached !== undefined) return cached;
  const text = readFileSync(path.join(repoRoot, file), 'utf8');
  textCache.set(file, text);
  return text;
}

function readJson<T>(file: string): T {
  return JSON.parse(readText(file)) as T;
}

function turboConfig(): TurboConfig {
  return readJson<TurboConfig>('turbo.json');
}

function turboTask(task: string): TurboTask {
  const declared = turboConfig().tasks[task];
  expect(declared, `turbo.json declares no "${task}" task`).toBeDefined();
  return declared ?? {};
}

function packageScripts(): Record<string, string> {
  return readJson<{ scripts: Record<string, string> }>('package.json').scripts;
}

/** The `npm run validate` command line, as its arguments. */
function validateArguments(): readonly string[] {
  const script = packageScripts().validate ?? '';
  const [runner, command, ...tasks] = script.split(' ');
  expect(runner).toBe('node');
  expect(command).toBe('scripts/turbo.mjs');
  expect(tasks[0]).toBe('run');
  return tasks.slice(1);
}

/** The test files one group's own npm script filters the policy layer to. */
function groupFiles(task: string): readonly string[] {
  const script = packageScripts()[task] ?? '';
  const filter = 'vitest run --project policy ';
  expect(script.startsWith(filter), `${task} is not a policy-layer Vitest run`).toBe(true);
  return script
    .slice(filter.length)
    .split(' ')
    .filter((part) => part !== '');
}

/** Whether one declared input pattern covers one repository-relative path. */
function matchesInput(file: string, pattern: string): boolean {
  if (pattern === '$TURBO_DEFAULT$') return true;
  if (pattern.startsWith('!')) return false;
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  if (pattern.startsWith('**/*.')) return file.endsWith(pattern.slice(4));
  if (pattern.includes('*')) {
    // Never silently pass: a pattern this check cannot read has to be taught to
    // it before the group that uses it counts as declared.
    throw new Error(`this check cannot read the declared input pattern "${pattern}"`);
  }
  return file === pattern;
}

/** Every module this check may resolve, indexed once. */
const moduleIndex = new Set<string>();

/** What one module imports, and what one test file reaches, each read once. */
const importCache = new Map<string, readonly string[]>();
const walkCache = new Map<string, readonly string[]>();

/**
 * Every file an import could resolve to, listed once. The candidate list below
 * would otherwise be a stat per extension per import, which is slow enough to
 * matter on a mounted drive — and this check runs beside the tests it describes.
 */
function indexModules(): void {
  if (moduleIndex.size > 0) return;
  for (const root of ['src', 'tests']) {
    for (const found of readdirSync(path.join(repoRoot, root), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!found.isFile()) continue;
      const relative = path
        .relative(repoRoot, path.join(found.parentPath, found.name))
        .split(path.sep)
        .join('/');
      moduleIndex.add(relative);
    }
  }
  for (const found of readdirSync(repoRoot, { withFileTypes: true })) {
    if (found.isFile()) moduleIndex.add(found.name);
  }
}

/**
 * The relative specifiers one module imports, read with the compiler's own
 * pre-processor so that an `import` line inside a fixture's generated source
 * text is not mistaken for a module this repository reads.
 */
function relativeImports(file: string): readonly string[] {
  const cached = importCache.get(file);
  if (cached !== undefined) return cached;
  const specifiers = ts
    .preProcessFile(readText(file), true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter((specifier) => specifier.startsWith('.'));
  importCache.set(file, specifiers);
  return specifiers;
}

function resolveLocalModule(fromFile: string, specifier: string): string {
  indexModules();
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  const withoutExtension = base.endsWith('.js') ? base.slice(0, -3) : base;
  for (const candidate of [
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}.mjs`,
    `${withoutExtension}.js`,
    `${base}.ts`,
    `${base}.mjs`,
    `${base}/index.ts`,
    base,
  ]) {
    if (moduleIndex.has(candidate)) return candidate;
  }
  throw new Error(`${fromFile} imports "${specifier}", which this check cannot resolve`);
}

/**
 * Every repository file one test file reaches through relative imports.
 *
 * Scope: relative specifiers, which is how every local module here is imported.
 * A relative import this walk cannot resolve fails the check rather than being
 * ignored — a file the walk cannot follow must not silently fall outside every
 * declared input.
 */
function localDependencies(entry: string): readonly string[] {
  const cached = walkCache.get(entry);
  if (cached !== undefined) return cached;
  const reached = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() ?? '';
    if (file === '' || reached.has(file)) continue;
    reached.add(file);
    for (const specifier of relativeImports(file)) {
      pending.push(resolveLocalModule(file, specifier));
    }
  }
  const walked = [...reached].sort();
  walkCache.set(entry, walked);
  return walked;
}

describe('the validation task cache contract', () => {
  it('runs every gate check as one task, and keeps the boundary layer fresh', () => {
    expect(validateArguments()).toEqual([...GATE_TASKS]);

    const config = turboConfig();
    for (const task of GATE_TASKS) {
      expect(config.tasks[task], `turbo.json declares no "${task}" task`).toBeDefined();
      expect(packageScripts()[task], `package.json has no "${task}" script`).toBeDefined();
    }

    // Exactly one check is ineligible, and it is the process-heavy layer: real
    // Git, real command trees, real children and the fixture lifecycle proof.
    // Everything else may be replayed only from a successful result.
    const uncached = GATE_TASKS.filter((task) => turboTask(task).cache === false);
    expect(uncached).toEqual([FRESH_TASK]);

    // The boundary layer runs after every fast group, and after the build its
    // fixtures spawn the built CLI from.
    const boundary = turboTask(FRESH_TASK);
    for (const dependency of ['build', ...POLICY_GROUPS]) {
      expect(boundary.dependsOn ?? [], `${FRESH_TASK} does not wait for ${dependency}`).toContain(
        dependency,
      );
    }

    // The layer commands execute directly, with no cache in the way, so "run
    // this layer now" keeps meaning that.
    for (const task of ['test', 'test:policy', 'test:boundary']) {
      expect(packageScripts()[task]).toContain('vitest run');
      expect(packageScripts()[task]).not.toContain('turbo');
    }
  });

  it('names the files each cache-eligible test group reads', () => {
    for (const group of POLICY_GROUPS) {
      const declared = turboTask(group).inputs ?? [];
      expect(declared.length, `${group} declares no inputs`).toBeGreaterThan(0);
      // A group is cached per file set: it has to name its own files rather
      // than fall back to "every file in the checkout".
      expect(declared, `${group} falls back to the whole checkout`).not.toContain(
        '$TURBO_DEFAULT$',
      );

      for (const file of groupFiles(group)) {
        for (const reached of localDependencies(file)) {
          expect(
            declared.some((pattern) => matchesInput(reached, pattern)),
            `${group} declares no input matching ${reached}, which ${file} reads`,
          ).toBe(true);
        }
      }

      // The layer's file list, project settings and worker caps live in the
      // Vitest configuration, so a change there invalidates the group too.
      expect(declared).toContain('vitest.config.ts');
    }
  });

  it('splits the policy layer into groups that cover it exactly once', () => {
    const declared = POLICY_GROUPS.flatMap((group) => [...groupFiles(group)]);
    const duplicates = declared.filter((file, index) => declared.indexOf(file) !== index);
    expect(duplicates).toEqual([]);
    expect([...declared].sort()).toEqual([...policyFiles].sort());
  });

  it('declares the environment the cached test groups depend on, and no secret', () => {
    for (const group of POLICY_GROUPS) {
      expect(turboTask(group).env).toEqual([...TEST_ENV_INPUTS]);
    }

    const config = turboConfig();
    const declaredNames = [
      ...Object.values(config.tasks).flatMap((task) => [...(task.env ?? [])]),
      ...(readJson<{ globalEnv?: readonly string[] }>('turbo.json').globalEnv ?? []),
    ];
    for (const name of declaredNames) {
      expect(
        /TOKEN|SECRET|KEY|PASSWORD/i.test(name),
        `${name} looks like a credential and must not be a cache input`,
      ).toBe(false);
    }
  });

  it('keeps the caches local, ignored and invisible to the checks themselves', () => {
    const config = turboConfig();

    // No remote cache, no shared result: what a validation reuses was produced
    // by this checkout on this platform.
    expect(config.remoteCache?.enabled).toBe(false);
    expect(config.cacheDir?.startsWith('.turbo/')).toBe(true);

    // Everything the cache writes lives under one ignored directory: a fresh
    // checkout, `npm ci`, or `git clean` may remove it, and that costs time
    // rather than correctness.
    for (const ignoreFile of ['.gitignore', '.prettierignore']) {
      expect(readText(ignoreFile), `${ignoreFile} does not ignore .turbo/`).toContain('.turbo/');
    }
    expect(readText('eslint.config.js')).toContain("'.turbo/**'");
    expect(packageScripts().lint).toContain('--cache-location .turbo/');
    expect(packageScripts().lint).toContain('--cache-strategy content');

    // Separate incremental metadata for the two programs: `tsconfig.json`
    // checks sources and tests without emitting, `tsconfig.build.json` emits
    // `dist/`. Sharing one file would let one program's state describe the
    // other's files.
    const check = readJson<{ compilerOptions: Record<string, unknown> }>(
      'tsconfig.json',
    ).compilerOptions;
    const build = readJson<{ compilerOptions: Record<string, unknown> }>(
      'tsconfig.build.json',
    ).compilerOptions;
    expect(check.incremental).toBe(true);
    expect(String(check.tsBuildInfoFile)).toMatch(/^\.turbo\//);
    expect(String(build.tsBuildInfoFile)).toMatch(/^\.turbo\//);
    expect(build.tsBuildInfoFile).not.toBe(check.tsBuildInfoFile);
  });

  it('routes the build through the guard that regenerates a missing artefact', () => {
    expect(packageScripts().build).toBe('node scripts/build.mjs');

    // The guard has to know the same two paths these checks rest on: the
    // incremental state the build writes, and the artefact `npm start` runs.
    const guard = readText('scripts/build.mjs');
    const build = readJson<{ compilerOptions: Record<string, unknown> }>(
      'tsconfig.build.json',
    ).compilerOptions;
    expect(guard).toContain(String(build.tsBuildInfoFile));
    expect(guard).toContain("'dist'");
    expect(guard).toContain("'cli.js'");
    expect(readText('package.json')).toContain('node dist/cli.js');
  });

  it('keeps the native lint cache sound for the rules it caches', () => {
    // ESLint's own cache answers per file, keyed by the file's content and the
    // resolved configuration (which includes the ESLint and Node versions). A
    // rule whose verdict depends on *another* file would break that assumption,
    // so the configuration this repository caches must stay free of type-aware
    // and project-wide rules. Adding one has to be a deliberate decision about
    // this cache (docs/validation-caching.md, "Lint").
    const config = readText('eslint.config.js');
    for (const marker of ['projectService', 'recommendedTypeChecked', 'project:']) {
      expect(config, `eslint.config.js enables ${marker}`).not.toContain(marker);
    }
  });
});
