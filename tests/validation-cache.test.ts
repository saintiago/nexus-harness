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
 * `tests/validation-cache-turbo.test.ts`, and the build guard it protects
 * against an incomplete `dist/` in `tests/build-guard.test.ts`; the reasoning
 * and the operator commands are in docs/validation-caching.md.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/**
 * The environment values that carry the *executing* runtime. `scripts/turbo.mjs`
 * observes what PATH resolves for `node` and `npm` — the same two a task gets —
 * and hands them to Turborepo, which hashes them like any other declared value.
 * `.nvmrc` and `packageManager` are only what should run.
 */
const RUNTIME_ENV_INPUTS = ['NEXUS_VALIDATE_NODE', 'NEXUS_VALIDATE_NPM'] as const;

/**
 * The files Turborepo hashes for every task, whatever a task declares: the
 * package manifests it reads to build the package graph, and the two global
 * dependencies `turbo.json` names. A task does not have to declare them twice.
 */
const ALWAYS_HASHED_FILES = [
  '.gitattributes',
  '.nvmrc',
  'package-lock.json',
  'package.json',
] as const;

/**
 * The repository files a cached group reads without importing them and without
 * naming them in a call the walk below can read: a path built from a constant,
 * or one of several literals a loop hands to a read helper. The walk reads what
 * it can see; these are the ones it cannot, so each group names them here
 * instead of leaving the read behind a variable name
 * (docs/validation-caching.md, "Inputs and invalidation").
 */
const READS_A_WALK_CANNOT_SEE: Readonly<Record<string, readonly string[]>> = {
  'test:policy:config': ['.gitignore', '.prettierignore', 'nexus.project.json'],
};

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
  readonly globalEnv?: readonly string[];
  readonly globalDependencies?: readonly string[];
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
  if (pattern.includes('*')) {
    // One `*` that stays inside a path segment — `tsconfig*.json` covers both
    // `tsconfig.json` and `tsconfig.build.json`. Anything wider has to be
    // taught to this check before a group that uses it counts as declared.
    const stars = pattern.split('*').length - 1;
    if (stars !== 1 || pattern.includes('**')) {
      throw new Error(`this check cannot read the declared input pattern "${pattern}"`);
    }
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    return new RegExp(`^${expression}$`, 'u').test(file);
  }
  return file === pattern;
}

/** Whether a group's own declarations, or Turborepo's, cover one file. */
function isDeclared(group: string, file: string): boolean {
  if ((ALWAYS_HASHED_FILES as readonly string[]).includes(file)) return true;
  return (turboTask(group).inputs ?? []).some((pattern) => matchesInput(file, pattern));
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

/** One parsed file, read once. */
const sourceCache = new Map<string, ts.SourceFile>();

function sourceOf(file: string): ts.SourceFile {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const parsed = ts.createSourceFile(
    file,
    readText(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  sourceCache.set(file, parsed);
  return parsed;
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
 * declared input. A file read through the filesystem is not an import and is
 * covered by `literalReads` and by the inventory above it.
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

/** The read helpers whose literal argument this check can follow. */
const READ_HELPERS = ['readText', 'readJson', 'readFileSync', 'readFile', 'open'] as const;

/**
 * The repository files one test file names in a read it makes itself: a
 * `path.join(repoRoot, …)` whose parts are all literals, or a read helper
 * handed a literal path. This is what the import walk cannot see — the guide a
 * case reads, the JSON example it composes, the script whose text it checks.
 *
 * A read whose path is built from a constant, or chosen from several literals
 * in a loop, is invisible here by construction: those are the ones
 * `READS_A_WALK_CANNOT_SEE` names by hand.
 */
function literalReads(file: string): readonly string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      const parts = node.arguments.map((argument) => argument.getText(sourceOf(file)));
      if (name === 'join' && parts[0] === 'repoRoot' && parts.length > 1) {
        // Only a path written entirely as literals: `path.join(repoRoot, 'docs',
        // 'connect-a-project.md')`. Parts that are not literals belong to the
        // inventory above, not to a guess made here.
        const literals = node.arguments
          .slice(1)
          .map((argument) => (ts.isStringLiteral(argument) ? argument.text : undefined));
        if (literals.every((part) => part !== undefined)) found.push(literals.join('/'));
      }
      const first = node.arguments[0];
      if ((READ_HELPERS as readonly string[]).includes(name) && first !== undefined) {
        if (ts.isStringLiteral(first)) found.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(file));
  return found;
}

/** Whether a candidate is a repository file this check can name. */
function existingFile(candidate: string): string | undefined {
  indexModules();
  const relative = candidate.split('\\').join('/').replace(/^\.\//u, '');
  if (relative === '') return undefined;
  if (moduleIndex.has(relative)) return relative;
  // A directory a case names is not a file it reads.
  return existsSync(path.join(repoRoot, relative)) &&
    statSync(path.join(repoRoot, relative)).isFile()
    ? relative
    : undefined;
}

/**
 * The process-starting calls this check knows a case could make. `exec` is not
 * among them: a regular expression's own `exec` is not a process, and a case
 * that used the child-process one has to import `node:child_process` — which is
 * the first thing this check looks for.
 */
const PROCESS_CALLS = [
  'spawn',
  'spawnSync',
  'execFile',
  'execSync',
  'execFileSync',
  'runProcess',
] as const;

/**
 * What one test file starts a real process with, if anything: an import of
 * `node:child_process`, or a call to one of the process runners above. Read
 * from the syntax rather than from the text, so that a comment or a message
 * naming a process is not mistaken for one.
 */
function startsProcess(file: string): string | undefined {
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      found === undefined &&
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes('child_process')
    ) {
      found = node.moduleSpecifier.text;
    }
    if (found === undefined && ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if ((PROCESS_CALLS as readonly string[]).includes(name)) found = `${name}()`;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(file));
  return found;
}

/** Every test file this repository has, in its two layers. */
function testFilesOnDisk(): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, 'tests'), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
    const relative = path
      .relative(repoRoot, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    // The deliberately failing cases the fixture-lifecycle proof runs under its
    // own configuration are the one exclusion both layers make.
    if (relative.startsWith('tests/fixtures/lifecycle/nested/')) continue;
    found.push(relative);
  }
  return found.sort();
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
            isDeclared(group, reached),
            `${group} declares no input matching ${reached}, which ${file} imports`,
          ).toBe(true);
        }
        // A file the case reads itself, rather than imports: `readText('turbo.json')`,
        // `path.join(repoRoot, 'docs', …)`. The import walk above cannot see it.
        for (const candidate of literalReads(file)) {
          const read = existingFile(candidate);
          if (read === undefined) continue;
          expect(
            isDeclared(group, read),
            `${group} declares no input matching ${read}, which ${file} reads`,
          ).toBe(true);
        }
      }

      // The reads no walk can follow: a path built from a constant, or one of
      // several literals a loop hands to a read helper.
      for (const read of READS_A_WALK_CANNOT_SEE[group] ?? []) {
        expect(existsSync(path.join(repoRoot, read)), `${read} does not exist`).toBe(true);
        expect(
          isDeclared(group, read),
          `${group} declares no input matching ${read}, which its cases read`,
        ).toBe(true);
      }

      // The layer's file list, project settings and worker caps live in the
      // Vitest configuration, so a change there invalidates the group too.
      expect(declared).toContain('vitest.config.ts');
    }
  });

  it('keeps a case that starts a real process out of every cached group', () => {
    // A cached group's result describes the files it declared. A case that
    // starts a real process — real Git above all, with the version, executable
    // and configuration this host happens to have — observes something the
    // declarations cannot bound, so it belongs to the layer that always
    // executes. `completion-cli.test.ts` and `report.test.ts` are the two cases
    // that made a real Git repository; HARN-49 moved them to the boundary layer.
    for (const group of POLICY_GROUPS) {
      for (const file of groupFiles(group)) {
        const started = startsProcess(file);
        expect(
          started,
          `${group} caches ${file}, which starts a real process (${String(started)})`,
        ).toBeUndefined();
      }
    }

    // And those cases are still run: every test file is in exactly one layer,
    // so moving one out of the cached groups puts it in the layer that executes
    // on every validation rather than out of the gate.
    const onDisk = testFilesOnDisk();
    const policy = [...policyFiles].sort();
    const boundary = onDisk.filter((file) => !policy.includes(file));
    expect([...policy, ...boundary].sort()).toEqual(onDisk);
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
      ...(config.globalEnv ?? []),
    ];
    for (const name of declaredNames) {
      expect(
        /TOKEN|SECRET|KEY|PASSWORD/i.test(name),
        `${name} looks like a credential and must not be a cache input`,
      ).toBe(false);
    }
  });

  it('declares the runtime that executes the tasks, not only the one that should', () => {
    // `.nvmrc` and `packageManager` are the declared runtime; neither is
    // enforced by the wrapper or by npm, so on their own they would let a
    // checkout on another Node reuse results produced by this one.
    const declared = turboConfig().globalEnv ?? [];
    for (const name of RUNTIME_ENV_INPUTS) {
      expect(declared, `turbo.json does not declare ${name}`).toContain(name);
    }

    // The wrapper observes them from PATH — the same resolution a task gets —
    // rather than reading the declaration back.
    const wrapper = readText('scripts/turbo.mjs');
    for (const name of RUNTIME_ENV_INPUTS) {
      expect(wrapper, `scripts/turbo.mjs does not supply ${name}`).toContain(name);
    }
    expect(wrapper).toContain("observedVersion('node')");
    expect(wrapper).toContain("observedVersion('npm')");
    // Nothing in the wrapper prints an environment value: the identity it
    // supplies is a version, never a token or a secret environment value.
    expect(wrapper).not.toMatch(/console\.(log|error)\([^)]*process\.env/u);
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

    // Incremental state only where it can be trusted: the check-only program
    // emits nothing, so its metadata has no output tree to disagree with. The
    // emitting program keeps none, because a state that describes a `dist/`
    // the cache restored, an operator removed or a partial deletion damaged
    // would let the compiler report an incomplete build as an up-to-date one
    // (tests/build-guard.test.ts).
    const check = readJson<{ compilerOptions: Record<string, unknown> }>(
      'tsconfig.json',
    ).compilerOptions;
    const build = readJson<{ compilerOptions: Record<string, unknown> }>(
      'tsconfig.build.json',
    ).compilerOptions;
    expect(check.incremental).toBe(true);
    expect(String(check.tsBuildInfoFile)).toMatch(/^\.turbo\//);
    expect(build.incremental).toBe(false);
    expect(build.tsBuildInfoFile).toBe(null);
    expect(build.outDir).toBe('dist');
  });

  it('routes the build through the guard that regenerates the whole artefact', () => {
    expect(packageScripts().build).toBe('node scripts/build.mjs');

    // The guard compiles into a directory it emptied, and it knows the same two
    // paths these checks rest on: the output directory the cache stores, and the
    // artefact `npm start` runs.
    const guard = readText('scripts/build.mjs');
    expect(guard).toContain("path.join('dist', 'cli.js')");
    expect(guard).toContain("path.join(directory, 'dist')");
    expect(guard).toContain('rmSync');
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
