#!/usr/bin/env node
/**
 * `npm run build` — the compiler, plus the two checks its incremental mode
 * cannot make for itself.
 *
 * TypeScript's incremental state is a record of what the last successful
 * compile emitted, and the compiler trusts it: with `.tsbuildinfo` present it
 * reports the project up to date and emits nothing even when the output
 * directory has been removed. Verified locally with the installed TypeScript
 * 6.0.3, in both `tsc --project` and `tsc --build` shapes
 * (docs/validation-caching.md, "Missing build output"). `dist/` is generated,
 * untracked output, so its absence is an ordinary event: a fresh checkout, an
 * operator clearing generated files, a task cache that was cleared or never
 * restored.
 *
 * So this script discards the incremental state when the artefact is missing —
 * a full compile then happens — and, whatever the compiler said, it refuses to
 * report a build in which the entry point `npm start` runs does not exist. The
 * compile itself, its configuration and its output are untouched: `tsc` remains
 * the only thing that produces `dist/`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The project file `npm run build` compiles. */
const project = 'tsconfig.build.json';

/** The incremental state `tsconfig.build.json` writes (see the file itself). */
const buildInfo = '.turbo/tsc/build.tsbuildinfo';

/** The artefact the build has to leave behind: what `npm start` executes. */
const entry = path.join('dist', 'cli.js');

function main() {
  const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    console.error('typescript is not installed; run "npm ci" first.');
    return 1;
  }

  const output = path.join(repoRoot, entry);
  if (!existsSync(output)) {
    rmSync(path.join(repoRoot, buildInfo), { force: true });
    console.log(
      `build: ${entry} is missing, so the incremental state was discarded and the project is compiled from scratch`,
    );
  }

  const result = spawnSync(process.execPath, [tsc, '--project', project], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    console.error(`build: the compiler could not be started: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    // The compiler already printed why. A killed compile is a failure too.
    return result.status ?? 1;
  }
  if (!existsSync(output)) {
    console.error(
      `build: the compiler reported success but ${entry} is missing. ` +
        'Run "npm run cache:clear" and build again; nothing was reported as built.',
    );
    return 1;
  }
  return 0;
}

process.exitCode = main();
