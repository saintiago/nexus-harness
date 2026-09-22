#!/usr/bin/env node
/**
 * The one way this repository invokes its task cache.
 *
 * Turborepo does the caching itself: it hashes the inputs a task declares in
 * `turbo.json`, stores the result of a successful task, and replays that result
 * instead of running the task again. This file adds no hashing, storage,
 * invalidation or replay of its own. It says only *where* the local cache lives
 * and keeps two optional network side effects off, so `npm run validate` means
 * the same thing on every machine without touching global configuration:
 *
 * - the cache is per checkout and per platform,
 *   `.turbo/cache/<platform>-<arch>` (ignored by git). Turborepo's cache key
 *   does not include the operating system or the architecture — its documented
 *   hash inputs are the files, environment values and task/graph definition —
 *   and one checkout read from two systems (WSL reading a Windows drive, for
 *   example) must never replay the other system's result. An explicit cache
 *   directory also turns off Turborepo's automatic cache sharing between Git
 *   worktrees (docs/validation-caching.md);
 * - telemetry and the update notifier are off for this invocation. Neither
 *   changes the gate's result; both would leave the machine for reasons the
 *   operator did not ask for. An operator who already set
 *   `TURBO_TELEMETRY_DISABLED` or `DO_NOT_TRACK` keeps their own value.
 *
 * Arguments are handed to `turbo` unchanged, so `npm run validate -- --dry`
 * still asks what would run. A `--` passthrough is refused instead: Turborepo
 * appends everything after it to *every* task, which would hand command-line
 * flags meant for Vitest to `prettier` and `eslint`. Reporter flags for one
 * layer belong on that layer's own command (`npm run test:four-workers -- ` and
 * `npx vitest run --project boundary --reporter=verbose`).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const turboCli = path.join(repoRoot, 'node_modules', 'turbo', 'bin', 'turbo');

/** Where this platform's local task cache lives, relative to the checkout. */
function localCacheDir(platform = process.platform, arch = process.arch) {
  return `.turbo/cache/${platform}-${arch}`;
}

/** The arguments one `turbo` invocation gets, with this platform's cache. */
function turboArguments(argv) {
  if (argv.includes('--')) {
    throw new Error(
      'this command does not pass arguments through to the tasks: Turborepo would append them to ' +
        'every task, including `prettier` and `eslint`. Run the layer itself for its own flags ' +
        '(for example `npx vitest run --project boundary --reporter=verbose`).',
    );
  }
  const given = argv.some((arg) => arg === '--cache-dir' || arg.startsWith('--cache-dir='));
  return given ? [...argv] : [...argv, `--cache-dir=${localCacheDir()}`];
}

function main(argv) {
  if (!existsSync(turboCli)) {
    console.error(
      `turbo is not installed at ${path.relative(repoRoot, turboCli)}; run "npm ci" first.`,
    );
    return Promise.resolve(1);
  }

  let args;
  try {
    args = turboArguments(argv);
  } catch (cause) {
    console.error(`validate: ${cause instanceof Error ? cause.message : String(cause)}`);
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [turboCli, ...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        TURBO_TELEMETRY_DISABLED: process.env.TURBO_TELEMETRY_DISABLED ?? '1',
      },
    });
    child.on('error', (cause) => {
      console.error(`turbo could not be started: ${cause.message}`);
      resolve(1);
    });
    // A task that failed, or a run the operator stopped, stays a failure: the
    // gate never reports success for a run that did not complete.
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

process.exitCode = await main(process.argv.slice(2));
