/**
 * The layer contract of the test pyramid: which active suites exist, and which
 * layer of validation runs each of them.
 *
 * `vitest.config.ts` selects suites by the directory they live in, so a suite
 * written outside every layer would validate nothing at all, and a layer with
 * no suite would quietly stop being part of the gate. This case reads the real
 * configuration and the real tree and fails when either happens
 * (docs/testing.md, docs/validation-caching.md).
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';
import { repoRoot } from '../support.js';

/** The three layers the pyramid documents, and the only ones it has. */
const LAYERS = ['unit', 'boundary', 'workflow'] as const;

/** One layer's project, as `vitest.config.ts` declares it. */
interface LayerProject {
  readonly name: string;
  readonly include: readonly string[];
}

/**
 * The inline projects the real configuration declares. A configuration that
 * names a project some other way (a project file, a bare string) fails the
 * shape this case reads rather than being passed over.
 */
function layerProjects(): readonly LayerProject[] {
  const projects = config.test?.projects ?? [];
  const named = projects.filter(
    (entry): entry is Exclude<typeof entry, string> => typeof entry !== 'string',
  );
  expect(named).toHaveLength(projects.length);
  return named.map((entry, index) => {
    const project = (entry as { test?: { name?: unknown; include?: unknown } }).test;
    expect(project, `project ${String(index)} declares no test options`).toBeDefined();
    expect(typeof project?.name).toBe('string');
    expect(Array.isArray(project?.include)).toBe(true);
    return {
      name: String(project?.name),
      include: (project?.include ?? []) as readonly string[],
    };
  });
}

/** Every active suite under `tests/`, relative to the repository root. */
async function activeSuites(): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(repoRoot, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.name.endsWith('.test.ts')) {
        found.push(child);
      }
    }
  };
  await walk('tests');
  return found;
}

describe('the layers of the test pyramid', () => {
  it('selects each layer from its own directory', () => {
    const projects = layerProjects();
    expect(projects.map((project) => project.name).sort()).toEqual([...LAYERS].sort());
    for (const project of projects) {
      expect(project.include, `${project.name} does not select its own directory`).toEqual([
        `tests/${project.name}/**/*.test.ts`,
      ]);
    }
  });

  it('places every active suite in exactly one layer, none of them empty', async () => {
    const suites = await activeSuites();
    expect(suites.length).toBeGreaterThan(0);

    for (const layer of LAYERS) {
      expect(
        suites.filter((suite) => suite.startsWith(`tests/${layer}/`)),
        `the ${layer} layer holds no suite`,
      ).not.toHaveLength(0);
    }

    const unplaced = suites.filter(
      (suite) => !LAYERS.some((layer) => suite.startsWith(`tests/${layer}/`)),
    );
    expect(unplaced, 'every suite is run by exactly one layer').toEqual([]);
  });
});
