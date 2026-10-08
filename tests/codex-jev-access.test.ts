import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jevAgentSettings } from '../src/application/jev.js';
import {
  codexHome,
  configArguments,
  startCodexAppServer,
  type CodexAppServer,
} from './support/codex-provider.js';
import { controlledJevProvider, type ControlledJevProvider } from './support/jev-provider.js';
const installed = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;
const preload = fileURLToPath(new URL('./fixtures/jev-provider-preload.mjs', import.meta.url));
let root: string;
let homes: string[] = [];
let servers: CodexAppServer[] = [];
let providers: ControlledJevProvider[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-jev-tools-'));
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
  await writeFile(path.join(root, 'camera.ts'), 'export const camera = "native-workspace-marker";');
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  await Promise.all(providers.map((p) => p.close()));
  providers = [];
  await Promise.all(homes.map((p) => rm(p, { recursive: true, force: true })));
  homes = [];
  await rm(root, { recursive: true, force: true });
});
async function open(enabled = true, fail = false) {
  const provider = await controlledJevProvider();
  providers.push(provider);
  if (fail) provider.fail(429, 'raw-provider-error');
  else
    provider.succeed({
      model: 'jev-1.13.0',
      answers: { q0: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 12, output_tokens: 2 },
    });
  const home = await codexHome(
    '[mcp_servers.jev]\ncommand = "/stale/jev"\ndisabled_tools = ["inspect_files"]\n',
  );
  homes.push(home);
  const server = await startCodexAppServer({
    codexHomeDirectory: home,
    overrides: configArguments({
      ...jevAgentSettings(enabled),
      'mcp_servers.jev.env': {
        NODE_OPTIONS: `--import=${preload}`,
        JEV_TEST_PROVIDER_ORIGIN: provider.origin,
      },
    }),
    environment: { JEV_API_KEY: 'synthetic-key' },
  });
  servers.push(server);
  const started = (await server.request('thread/start', { cwd: root })) as {
    thread: { id: string };
  };
  const threadId = started.thread.id;
  const status = (await server.request('mcpServerStatus/list', {
    serverName: 'jev',
    detail: 'full',
    threadId,
  })) as { data: { name: string; tools: Record<string, unknown>; toolsError: string | null }[] };
  return { server, provider, threadId, status: status.data.find((s) => s.name === 'jev') };
}
describe.skipIf(!installed)('native Codex JEv repository tools', () => {
  it('replaces inherited exclusions and binds inspection to the thread repository', async () => {
    const { server, provider, threadId, status } = await open();
    expect(status?.toolsError).toBeNull();
    expect(Object.keys(status?.tools ?? {}).sort()).toEqual(['inspect_files', 'search_repo']);
    const result = (await server.request('mcpServer/tool/call', {
      server: 'jev',
      threadId,
      tool: 'inspect_files',
      arguments: {
        paths: ['camera.ts'],
        questions: [{ id: 'camera', question: 'Does this implement camera acquisition?' }],
      },
    })) as { structuredContent?: unknown };
    expect(result.structuredContent).toMatchObject({
      files: [{ path: 'camera.ts', assessments: [{ score: 0.9 }] }],
    });
    expect(JSON.parse(provider.requests[0]!.body).state.code).toContain('native-workspace-marker');
    expect(JSON.stringify(result)).not.toContain('native-workspace-marker');
  }, 15000);
  it('supports native literal search without a JEv call', async () => {
    const { server, provider, threadId } = await open();
    const result = (await server.request('mcpServer/tool/call', {
      server: 'jev',
      threadId,
      tool: 'search_repo',
      arguments: { query: 'camera' },
    })) as { structuredContent?: unknown };
    expect(result.structuredContent).toMatchObject({
      method: 'literal',
      files: [{ path: 'camera.ts', score: 1 }],
    });
    expect(provider.requests).toHaveLength(0);
  }, 15000);
  it('degrades safely and retains other native capabilities', async () => {
    const { server, threadId } = await open(true, true);
    const result = await server.request('mcpServer/tool/call', {
      server: 'jev',
      threadId,
      tool: 'inspect_files',
      arguments: { paths: ['camera.ts'], questions: [{ id: 'x', question: 'Is this relevant?' }] },
    });
    expect(JSON.stringify(result)).toContain('rate_limited');
    expect(
      await server.request('command/exec', { command: ['/bin/echo', 'usable'], cwd: root }),
    ).toMatchObject({ exitCode: 0, stdout: 'usable\n' });
  }, 15000);
  it('exposes no repository tools when disabled', async () => {
    const { status } = await open(false);
    expect(Object.keys(status?.tools ?? {})).toEqual([]);
  }, 15000);
});
