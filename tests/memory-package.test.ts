/**
 * Package composition coverage: the pinned standalone agentic-memory build the integration
 * consumes. The dependency is a checked-in, revision-built tarball, so a fresh Linux checkout
 * installs the package and its declarations without a sibling repository or prototype, and the
 * installed copy exposes the public exports Memory composes.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const tarball = path.join(repositoryRoot, 'vendor', 'agentic-memory-0.0.0-39340feb.tgz');

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('pinned memory package', () => {
  it('declares the revision-built tarball as the dependency and pins its integrity', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { readonly dependencies?: Record<string, string> };
    const declared = packageJson.dependencies?.['agentic-memory'];
    expect(declared).toBe('file:vendor/agentic-memory-0.0.0-39340feb.tgz');

    const lock = JSON.parse(
      await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
    ) as {
      readonly packages?: Record<
        string,
        { readonly resolved?: string; readonly integrity?: string }
      >;
    };
    const locked = lock.packages?.['node_modules/agentic-memory'];
    expect(locked?.resolved).toBe(declared);
    expect(locked?.integrity).toMatch(/^sha512-/);

    // The vendored build matches what the lockfile records, so the pinned revision is what runs.
    const tarballBytes = await readFile(tarball);
    const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;
    expect(integrity).toBe(locked?.integrity);
  });

  it(
    'installs into a fresh consumer without a sibling repository and imports its public API',
    { timeout: 300_000 },
    async () => {
      const consumer = await mkdtemp(path.join(os.tmpdir(), 'nexus-memory-consumer-'));
      temporaryDirectories.push(consumer);
      // A fresh checkout has no npm cache, so the consumer resolves the pinned tarball and the
      // dependencies it declares from the registry. The isolated, initially empty cache directory
      // proves the check does not depend on this host's accidental cache state; `--ignore-scripts`
      // keeps the native post-install downloads out of this assertion, which covers installation
      // and the package's public exports.
      const cache = await mkdtemp(path.join(os.tmpdir(), 'nexus-memory-cache-'));
      temporaryDirectories.push(cache);
      await writeFile(
        path.join(consumer, 'package.json'),
        `${JSON.stringify({ name: 'consumer', private: true, version: '1.0.0', type: 'module' })}\n`,
        'utf8',
      );
      await run(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, tarball],
        {
          cwd: consumer,
          env: { ...process.env, npm_config_cache: cache },
          timeout: 240_000,
        },
      );
      const check = await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import('agentic-memory').then((memory) => {" +
            'const exports = ["AgenticMemory","MemoryError","defaultPrompts","openReferenceEmbedder",' +
            '"openQdrantNoteStore","embeddingText","jsonValueSchema","noteSchema","embeddedNoteSchema"];' +
            'const missing = exports.filter((name) => memory[name] === undefined);' +
            'if (missing.length > 0) { throw new Error(`missing exports: ${missing.join(",")}`); }' +
            "process.stdout.write('ok');" +
            '});',
        ],
        { cwd: consumer, timeout: 60_000 },
      );
      expect(check.stdout.trim()).toBe('ok');
    },
  );
});
