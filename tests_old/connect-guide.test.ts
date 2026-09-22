/**
 * The canonical project-onboarding guide, checked against the things it tells
 * an integration agent to use.
 *
 * The guide is the entry point for connecting a project, so a command line that
 * no longer parses, an option a command does not accept, or a link that points
 * nowhere would send that agent in the wrong direction. This suite reads the
 * guide itself — no copy of it lives here — and resolves its links against the
 * checked-in files and its commands against the real option tables. It also
 * holds the guide to its audience: installation-owned setup stays with the
 * operator and is not turned into project-onboarding steps.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECK_CONFIG_OPTIONS,
  parseOptions,
  QUEUE_RUN_OPTIONS,
  SOURCE_LIST_OPTIONS,
  SOURCE_RUN_OPTIONS,
} from '../src/cli/options.js';
import { repoRoot } from './support.js';

const GUIDE = path.join(repoRoot, 'docs', 'connect-a-project.md');

/** The guide, read once: every test below reads the same document. */
const guide = readFileSync(GUIDE, 'utf8');

/**
 * Installation internals the project guide must not teach. Naming any of these
 * here would give a project agent ownership of setup that belongs to the Nexus
 * installation.
 */
const INSTALLATION_INTERNALS = [
  'NEXUS_LENS_PRIVATE_KEY_PATH',
  'NEXUS_LENS_TOKEN',
  'private key',
  'private-key',
  'PEM',
  'App installation',
  'workDir',
  'privateKeyPathEnv',
  'reviewerTokenEnv',
  'JIRA_API_TOKEN',
  'tokenEnv',
] as const;

/** The bodies of every fenced code block in `text`. */
function fencedBlocks(text: string): readonly string[] {
  return [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? '');
}

/** The anchors this document's own headings resolve to. */
function headingAnchors(text: string): ReadonlySet<string> {
  return new Set(
    text
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#{1,6} /, '')
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, '')
          .trim()
          .replace(/ +/g, '-'),
      ),
  );
}

describe('the project-onboarding guide', () => {
  it('links only to files and headings that exist', () => {
    const links = [...guide.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? '');
    expect(links.length).toBeGreaterThan(5);

    const anchors = headingAnchors(guide);
    for (const link of links) {
      if (link.startsWith('#')) {
        expect(anchors, `connect-a-project.md has no heading for ${link}`).toContain(link.slice(1));
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
        continue; // An external URL: nothing local to check.
      }
      const [file = ''] = link.split('#');
      const target = path.join(repoRoot, 'docs', file);
      expect(existsSync(target), `connect-a-project.md links to a missing ${file}`).toBe(true);
    }
  });

  it('keeps installation-owned credentials and storage out of the project path', () => {
    for (const internal of INSTALLATION_INTERNALS) {
      expect(
        guide,
        `connect-a-project.md exposes installation internal "${internal}"`,
      ).not.toContain(internal);
    }

    const prose = guide.replace(/\s+/g, ' ');
    expect(prose).toContain('already installed Nexus runtime');
    expect(prose).toContain('Nexus environment/setup error');
  });

  it('names only commands and options the CLI accepts, in the documented order', () => {
    const commands = fencedBlocks(guide)
      .flatMap((block) => block.split('\n'))
      .map((line) => /^npm --prefix (\S+) run dev -- (.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);

    expect(commands.length).toBeGreaterThanOrEqual(3);

    const tables = {
      'check-config': { table: CHECK_CONFIG_OPTIONS, required: ['--config', '--project'] },
      'source list': { table: SOURCE_LIST_OPTIONS, required: ['--config', '--project'] },
      'source run': { table: SOURCE_RUN_OPTIONS, required: ['--config', '--repo'] },
      'queue run': { table: QUEUE_RUN_OPTIONS, required: ['--config', '--repo'] },
    } as const;

    const seen: string[] = [];
    for (const match of commands) {
      const args = (match[2] ?? '').trim().split(/\s+/);
      const [first = '', second = ''] = args;
      const name = first === 'check-config' || first === 'run' ? first : `${first} ${second}`;
      const entry = tables[name as keyof typeof tables];
      expect(entry, `the guide names an unknown command "${name}"`).toBeDefined();
      if (entry === undefined) {
        continue;
      }
      const options = args.slice(name.split(' ').length);
      const parsed = parseOptions(options, entry.table);
      expect(
        parsed.ok,
        `"${name}" in the guide does not parse: ${parsed.ok ? '' : parsed.message}`,
      ).toBe(true);
      if (!parsed.ok) {
        continue;
      }
      for (const required of entry.required) {
        expect(options, `"${name}" in the guide omits ${required}`).toContain(required);
      }
      seen.push(name);
    }

    // The onboarding order the guide promises: validate, preview, then run.
    expect(seen.slice(0, 3)).toEqual(['check-config', 'source list', 'queue run']);
  });

  it('hands Rank access failures back to the Nexus operator', () => {
    const row = guide
      .split('\n')
      .find((line) => line.startsWith('| Jira refuses the search because Rank is unavailable |'));
    expect(row, 'the guide has no Rank troubleshooting row').toBeDefined();

    const advice = (row ?? '').toLowerCase();
    expect(advice).toContain('nexus operator');
    expect(advice).not.toMatch(/fix (the )?(board|access)/);
    expect(advice).toContain('"ordering"');
  });
});
