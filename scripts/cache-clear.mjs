#!/usr/bin/env node
/**
 * `npm run cache:clear` — removes this checkout's local validation caches.
 *
 * The caches are disposable by construction: Turborepo stores successful task
 * results, ESLint its content cache, and TypeScript its incremental metadata
 * under `.turbo/`, which git ignores and nothing else reads. Removing them can
 * only make the next validation execute more, never less, and `npm run
 * validate:fresh` uses this to guarantee a run with no reused result. It is
 * also the documented repair for a cache an operator suspects: stale, corrupt,
 * interrupted, or produced by a run they do not trust.
 *
 * The removal is confined to the checkout the script ships with. Nothing
 * outside it — a global Turborepo configuration, another checkout, or the npm
 * download cache — is touched.
 */

import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cacheRoot = path.join(repoRoot, '.turbo');

if (path.dirname(cacheRoot) !== repoRoot) {
  // Unreachable while the path above is a literal, and the reason to keep it
  // that way: this command removes a directory tree.
  console.error(`refusing to clear ${cacheRoot}: it is not inside ${repoRoot}`);
  process.exitCode = 1;
} else if (!existsSync(cacheRoot)) {
  console.log(`no local validation cache to clear (${path.relative(repoRoot, cacheRoot)})`);
} else {
  rmSync(cacheRoot, { recursive: true, force: true });
  console.log(
    `cleared ${path.relative(repoRoot, cacheRoot)}: task results, the ESLint cache and the incremental metadata are gone`,
  );
}
