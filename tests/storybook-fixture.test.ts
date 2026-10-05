/**
 * The isolated Storybook fixture the browser/image capability check consumes: it is test
 * infrastructure with no Nexus product UI. These tests exercise the journey its story renders and
 * assert the preview contract the prototype roles and the host integration check rely on.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createJourney, journeyStates } from './fixtures/storybook/stories/journey.js';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'storybook',
);

describe('isolated Storybook fixture', () => {
  it('advances the rendered journey through its states', () => {
    const journey = createJourney();
    expect(journey.status()).toBe('idle');
    expect(journey.next()).toBe('running');
    expect(journey.next()).toBe('complete');
    // The journey settles on its last state instead of inventing another one.
    expect(journey.next()).toBe('complete');
    expect(journeyStates).toEqual(['idle', 'running', 'complete']);
  });

  it('declares a preview command and a story that changes state on interaction', async () => {
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'package.json'), 'utf8')) as {
      readonly scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.['storybook']).toContain('storybook dev');
    expect(manifest.scripts?.['storybook']).toContain('--port 6100');
    const config = await readFile(path.join(fixtureRoot, '.storybook', 'main.js'), 'utf8');
    expect(config).toContain('@storybook/html-vite');
    expect(config).toContain('stories');
    const story = await readFile(path.join(fixtureRoot, 'stories', 'journey.stories.js'), 'utf8');
    expect(story).toContain("from './journey.js'");
    expect(story).toContain('data-status');
    expect(story).toContain('addEventListener');
    expect(story).toContain('journey.next()');
  });

  it('stays isolated test infrastructure without Nexus product imports', async () => {
    for (const file of ['stories/journey.js', 'stories/journey.stories.js', '.storybook/main.js']) {
      const source = await readFile(path.join(fixtureRoot, file), 'utf8');
      expect(source).not.toMatch(/from ['"][^'"]*src\//);
    }
  });
});
