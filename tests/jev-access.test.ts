import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jevExecutablePath } from '../src/application/jev.js';
import { controlledJevProvider, type ControlledJevProvider } from './support/jev-provider.js';
import { openMcpSession } from './support/mcp-stdio.js';
const preload = fileURLToPath(new URL('./fixtures/jev-provider-preload.mjs', import.meta.url));
let root: string;
let providers: ControlledJevProvider[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-jev-tools-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    ],
    { cwd: root },
  );
  await writeFile(path.join(root, 'camera.ts'), 'export const camera = "private-source-marker";');
});
afterEach(async () => {
  await Promise.all(providers.map((p) => p.close()));
  providers = [];
  await rm(root, { recursive: true, force: true });
});
const request = {
  paths: ['camera.ts'],
  questions: [{ id: 'camera', question: 'Does this implement camera acquisition?' }],
};
const judgment = {
  model: 'jev-1.13.0',
  answers: { q0: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 128, output_tokens: 6 },
};
async function session(fail = false, logging = false) {
  const provider = await controlledJevProvider();
  providers.push(provider);
  if (fail) provider.fail(429, 'raw-provider-error');
  else provider.succeed(judgment);
  const s = await openMcpSession(jevExecutablePath(), {
    cwd: root,
    environment: {
      JEV_API_KEY: 'synthetic-key',
      JEV_TEST_PROVIDER_ORIGIN: provider.origin,
      NODE_OPTIONS: `--import=${preload}`,
      ...(logging ? { JEV_USAGE_LOG_PATH: path.join(root, 'usage.jsonl') } : {}),
    },
  });
  return { s, provider };
}
describe('installed JEv repository tools', () => {
  it('installs an executable exposing exactly the replacement catalogue', async () => {
    await access(jevExecutablePath(), constants.X_OK);
    const { s } = await session();
    try {
      expect(s.tools.map((t) => t.name)).toEqual(['search_repo', 'inspect_files']);
    } finally {
      await s.close();
    }
  });
  it('reads the invocation repository and keeps source out of results', async () => {
    const { s, provider } = await session();
    try {
      const result = await s.call('inspect_files', request);
      expect(result.structuredContent).toMatchObject({
        files: [{ path: 'camera.ts', assessments: [{ id: 'camera', score: 0.9 }] }],
      });
      expect(JSON.stringify(result)).not.toContain('private-source-marker');
      expect(JSON.parse(provider.requests[0]!.body).state.code).toContain('private-source-marker');
    } finally {
      await s.close();
    }
  });
  it('performs literal discovery without provider activity', async () => {
    const { s, provider } = await session();
    try {
      const result = await s.call('search_repo', { query: 'camera' });
      expect(result.structuredContent).toMatchObject({
        method: 'literal',
        files: [{ path: 'camera.ts', score: 1 }],
        usage: { calls: 0 },
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
  it('keeps sanitized host usage logging', async () => {
    const { s } = await session(false, true);
    try {
      await s.call('inspect_files', request);
      const log = await readFile(path.join(root, 'usage.jsonl'), 'utf8');
      expect(log).not.toContain('private-source-marker');
      expect(log).not.toContain('synthetic-key');
      expect(JSON.parse(log.trim()).usage).toEqual(judgment.usage);
    } finally {
      await s.close();
    }
  });
  it('reports safe failures and permits ordinary search afterward', async () => {
    const { s } = await session(true);
    try {
      const result = await s.call('inspect_files', request);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('rate_limited');
      expect(JSON.stringify(result)).not.toContain('raw-provider-error');
      expect((await s.call('search_repo', { query: 'camera' })).isError).toBeFalsy();
    } finally {
      await s.close();
    }
  });
});
