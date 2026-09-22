#!/usr/bin/env node
/**
 * `npm run build` — the compiler, plus the two things the emitting program
 * cannot do for itself.
 *
 * 1. The emitting program keeps no incremental state. TypeScript's incremental
 *    mode trusts its own record of the last successful compile: with
 *    `.tsbuildinfo` present, deleting an emitted module — or the whole `dist/` —
 *    and running the compiler again reports the project up to date and emits
 *    nothing, exit 0. Verified locally with the installed TypeScript 6.0.3 in
 *    both `tsc --project` and `tsc --build` shapes. Generated output being
 *    removed is ordinary here: a fresh checkout, an operator clearing generated
 *    files, or a task cache that was cleared or never restored. A stored state
 *    that describes a tree it no longer matches would turn that into a build
 *    that reports success while `dist/` is incomplete.
 *
 *    `tsconfig.build.json` therefore compiles without incremental state, and
 *    the check-only program keeps it (`tsconfig.json`,
 *    `.turbo/tsc/typecheck.tsbuildinfo`): that program emits nothing, so it has
 *    no output tree to disagree with, and it is the one whose second run is
 *    worth the state (docs/validation-caching.md, "The build").
 *
 * 2. So this script regenerates the output instead of resuming it: `dist/` is
 *    removed, the current sources are compiled in full, and the run is only
 *    reported as a build when the artefact `npm start` executes exists
 *    afterwards — whatever the compiler said. The compile itself, its
 *    configuration and its output are untouched: `tsc` remains the only thing
 *    that produces `dist/`.
 *
 * `node scripts/build.mjs [project-directory]` compiles the named directory
 * (default: this checkout). The test that proves the guard works
 * (`tests/build-guard.test.ts`) runs it against a throwaway project, so the
 * compiler is always this checkout's installed TypeScript and the artefact is
 * always that project's `dist/cli.js`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The project file the build compiles, in the directory being built. */
const project = 'tsconfig.build.json';

/** The artefact the build has to leave behind: what `npm start` executes. */
const entry = path.join('dist', 'cli.js');

function main() {
  const directory = path.resolve(process.argv[2] ?? repoRoot);
  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    console.error('typescript is not installed; run "npm ci" first.');
    return 1;
  }
  if (!existsSync(path.join(directory, project))) {
    console.error(`build: ${directory} has no ${project} to compile.`);
    return 1;
  }

  // A build describes the sources it was given, in full: nothing it produced
  // last time is kept, so a module whose source is gone cannot survive in the
  // artefact and a module that was removed is emitted again.
  try {
    rmSync(path.join(directory, 'dist'), { recursive: true, force: true });
  } catch (cause) {
    console.error(
      `build: ${path.join(directory, 'dist')} could not be removed ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). ` +
        'Stop whatever is holding it, then run the build again.',
    );
    return 1;
  }

  const result = spawnSync(process.execPath, [tsc, '--project', project], {
    cwd: directory,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    console.error(`build: the compiler could not be started: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    // The compiler already printed why. A killed compile is a failure too, and
    // a failed build leaves no artefact rather than a mixture of two revisions.
    return result.status ?? 1;
  }
  if (!existsSync(path.join(directory, entry))) {
    console.error(
      `build: the compiler reported success but ${entry} is missing. ` +
        'Nothing was reported as built: check the project\'s "noEmit", "outDir" and ' +
        '"include" settings, then build again.',
    );
    return 1;
  }
  return 0;
}

process.exitCode = main();
