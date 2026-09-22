/**
 * The dependency boundaries in docs/architecture.md §3 are enforced by an ESLint
 * restriction (see eslint.config.js). These tests lint isolated fixtures with
 * that same rule, so the restriction is shown to permit one import and reject
 * another rather than merely being present.
 */

import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './support.js';

const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'boundaries');

type LintResult = Awaited<ReturnType<ESLint['lintFiles']>>[number];

async function lintFixture(relativePath: string): Promise<LintResult> {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(fixtureDir, 'eslint.config.js'),
  });
  const results = await eslint.lintFiles([path.join(fixtureDir, relativePath)]);
  const [result] = results;
  if (result === undefined) {
    throw new Error(`ESLint reported no result for ${relativePath}`);
  }
  return result;
}

describe('dependency boundaries', () => {
  it('permits a helper module that imports the data contracts', async () => {
    const result = await lintFixture(path.join('allowed', 'uses-types.ts'));

    expect(result.messages).toEqual([]);
    expect(result.errorCount).toBe(0);
  });

  it('rejects a helper module that imports the CLI', async () => {
    const result = await lintFixture(path.join('forbidden', 'imports-cli.ts'));

    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('no-restricted-imports');
    expect(result.messages[0]?.message).toMatch(/must not import cli\.ts/);
  });

  it('rejects runtime I/O in the data-contract module', async () => {
    const result = await lintFixture(path.join('forbidden', 'uses-node-io.ts'));

    expect(result.errorCount).toBe(1);
    expect(result.messages[0]?.ruleId).toBe('no-restricted-imports');
    expect(result.messages[0]?.message).toMatch(/keep runtime I\/O out of it/);
  });
});
