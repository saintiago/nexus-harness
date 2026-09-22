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
 * - the runtime that will execute the tasks is observed and handed to
 *   Turborepo as a declared input. Turborepo hashes the files and the declared
 *   environment values a task has, not the Node or npm that runs it, and
 *   `.nvmrc` and `packageManager` state what *should* run rather than what
 *   does. So this file asks PATH — the same resolution a task gets — which
 *   `node` and `npm` will run, passes `NEXUS_VALIDATE_NODE` and
 *   `NEXUS_VALIDATE_NPM`, and `turbo.json` declares both in `globalEnv`. A
 *   different runtime under the same checkout is therefore a different hash,
 *   and a runtime that cannot be observed fails the gate instead of producing
 *   results nothing describes.
 *
 * Arguments are handed to `turbo` unchanged, so `npm run validate -- --dry`
 * still asks what would run. A `--` passthrough is refused instead: Turborepo
 * appends everything after it to *every* task, which would hand command-line
 * flags meant for Vitest to `prettier` and `eslint`. Reporter flags for one
 * layer belong on that layer's own command
 * (`npm run test:boundary -- --reporter=verbose`, or
 * `npx vitest run --project workflow --reporter=verbose`).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const turboCli = path.join(repoRoot, 'node_modules', 'turbo', 'bin', 'turbo');

/** What PATH resolves for one runtime, as the version it reports. */
function observedVersion(command) {
  const result = spawnSync(`${command} --version`, { shell: true, encoding: 'utf8' });
  const version = (result.stdout ?? '').trim();
  if (result.error !== undefined || result.status !== 0 || version === '') {
    const problem =
      result.error?.message ??
      `it exited with ${String(result.status)}: ${(result.stderr ?? '').trim()}`;
    throw new Error(
      `"${command} --version" could not be read (${problem}). The gate caches results, so ` +
        'the Node and npm that will execute its tasks have to be observed first: put both ' +
        'on PATH and run the gate again.',
    );
  }
  return version;
}

/** The runtime inputs one Turborepo invocation is given. */
function runtimeInputs() {
  return {
    NEXUS_VALIDATE_NODE: observedVersion('node'),
    NEXUS_VALIDATE_NPM: observedVersion('npm'),
  };
}

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
  let runtime;
  try {
    args = turboArguments(argv);
    runtime = runtimeInputs();
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
        ...runtime,
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
