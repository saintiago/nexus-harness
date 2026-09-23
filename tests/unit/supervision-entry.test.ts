/**
 * The supervisor's own bootstrap, as this checkout holds it.
 *
 * A supervised queue has to keep starting while the harness it supervises does
 * not: a broken queue module, a configuration the worker cannot read, an
 * installation that will not load. That only holds if the supervisor's entry
 * point loads the supervisor and nothing else, so this case reads the real
 * import graph of that entry — every relative import, followed to the leaves —
 * and fails the moment it reaches an ordinary command (docs/WORKFLOW.md §12).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../support.js';

/** The supervisor's own process entry, relative to the repository root. */
const ENTRY = 'src/cli/supervise.ts';

/** Every module that must never be reachable from the supervisor's entry. */
const ORDINARY_COMMANDS = [
  'src/cli.ts',
  'src/cli/check-config.ts',
  'src/cli/queue-command.ts',
  'src/cli/review-command.ts',
  'src/cli/run-command.ts',
  'src/cli/source-command.ts',
  'src/runs/runner.ts',
];

/** A `.js`-suffixed relative specifier, as this project's sources write them. */
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/** The source file a relative specifier names, or `null` when it names none. */
function resolveImport(from: string, specifier: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (!base.startsWith('src/')) {
    return null;
  }
  return base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : base;
}

/** Every relative import reachable from one module, depth first. */
async function importGraph(entry: string): Promise<readonly string[]> {
  const seen = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const text = await readFile(path.join(repoRoot, file), 'utf8');
    const specifiers = [...text.matchAll(RELATIVE_IMPORT)].map((match) => match[1] ?? '');
    for (const specifier of specifiers) {
      const target = resolveImport(file, specifier);
      if (target !== null) {
        await visit(target);
      }
    }
  };
  await visit(entry);
  return [...seen].sort();
}

describe('the supervisor’s own entry point', () => {
  it('loads no ordinary command, so a broken Nexus can still be repaired', async () => {
    const graph = await importGraph(ENTRY);
    // It does load the supervisor itself, the configuration reader and the
    // display: everything the parent needs and nothing the worker needs.
    expect(graph).toContain(ENTRY);
    expect(graph).toContain('src/supervisor/supervise.ts');
    expect(graph).toContain('src/supervisor/recovery.ts');
    expect(graph).toContain('src/config/load.ts');
    for (const command of ORDINARY_COMMANDS) {
      expect(graph, `${command} is reachable from the supervisor's own entry`).not.toContain(
        command,
      );
    }
  });

  it('is a process entry of its own, and the CLI dispatches the same command through it', async () => {
    const entry = await readFile(path.join(repoRoot, ENTRY), 'utf8');
    // Started as a process, this file runs the supervised commands itself.
    expect(entry).toContain('isEntryPoint()');
    expect(entry).toContain('superviseCli(process.argv.slice(2)');
    // And the ordinary CLI dispatches `supervise` here rather than keeping a
    // second implementation that would have to be kept in step.
    const cli = await readFile(path.join(repoRoot, 'src/cli.ts'), 'utf8');
    expect(cli).toContain("from './cli/supervise.js'");
    expect(cli).not.toContain('supervise-command');
  });

  it('starts the ordinary CLI beside itself as the worker, not itself', async () => {
    const entry = await readFile(path.join(repoRoot, ENTRY), 'utf8');
    // `dist/cli/supervise.js` starts `dist/cli.js`; a supervisor started
    // through the ordinary CLI keeps running that very file.
    expect(entry).toContain("path.basename(resolved, extension) === 'cli'");
    expect(entry).toContain('`cli${extension}`');
  });
});
