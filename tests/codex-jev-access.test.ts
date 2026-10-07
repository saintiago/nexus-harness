/**
 * Focused integration checks for the composed JEv access through the installed coding provider:
 * the provider's own configuration merge reports the reserved server's effective settings, and
 * its app server discovers and calls the installed `ask_jev` tool against a controlled provider
 * response, including safe failures and continuation. Model responses use loopback fixtures;
 * no login, paid call or live TypeSafe request is involved. The checks need the native provider the repository's profiles
 * document, so they run where it is installed and are skipped elsewhere, such as routine CI.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { jevAgentSettings, jevExecutablePath } from '../src/application/jev.js';
import { createAgentRuntimeSettings } from '../src/application/composition.js';
import { parseNexusConfiguration } from '../src/configuration/index.js';
import {
  codexHome,
  configArguments,
  providerMcpServers,
  startCodexAppServer,
  withNativeConfiguration,
  type CodexAppServer,
} from './support/codex-provider.js';
import { nexusConfiguration } from './support/configuration.js';
import { createCodingRuntime } from '../src/adapters/coding-runtime.js';
import { controlledCodexModel } from './support/codex-model.js';
import { controlledJevProvider, type ControlledJevProvider } from './support/jev-provider.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/jev-provider-preload.mjs', import.meta.url));
const syntheticKey = 'synthetic-jev-host-key';
const syntheticState = 'Synthetic support note: payouts have been failing for three days.';

/** The named host settings the composed reserved server forwards to the delivered package. */
const forwardedEnvironment = ['JEV_API_KEY', 'JEV_USAGE_LOG_PATH', 'JEV_USAGE_LOG_CALLER'];

/** The installation directory the composition checks resolve relative configuration paths from. */
const installationDirectory = '/etc/nexus/installation';

/**
 * Reserved-server settings a profile's own configuration supplies: an inherited environment,
 * tool exclusion, HTTP transport and stale command that Nexus's composition must replace.
 */
const inheritedJevSettings = {
  'mcp_servers.jev.command': '/inherited/nexus/node_modules/.bin/jev-mcp',
  'mcp_servers.jev.args': ['--inherited'],
  'mcp_servers.jev.enabled': true,
  'mcp_servers.jev.required': true,
  'mcp_servers.jev.enabled_tools': ['other_tool'],
  'mcp_servers.jev.disabled_tools': ['ask_jev'],
  'mcp_servers.jev.env_vars': ['JEV_MODEL'],
  'mcp_servers.jev.env': {
    JEV_MODEL: 'inherited-model',
    JEV_TIMEOUT_MS: '13',
    JEV_API_KEY: 'inherited-key',
  },
  'mcp_servers.jev.url': 'https://example.invalid/mcp',
};

/** The composed tool settings of the developer ladder's first profile. */
function composedToolSettings(
  configure: (configuration: ReturnType<typeof nexusConfiguration>) => void,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, unknown>> {
  const configured = nexusConfiguration();
  configure(configured);
  const settings = createAgentRuntimeSettings(
    parseNexusConfiguration(configured, installationDirectory),
    'developer',
    // The composed settings are what this check supplies; the capability is never invoked.
    { execute: () => Promise.resolve({ ok: false, fault: { message: 'unused' } }) },
    environment,
  );
  return settings.profiles.find((profile) => profile.id === 'nexus-flash')!.toolSettings;
}

/** Whether the documented native provider is installed for this run. */
const nativeProviderInstalled = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;

/** The judgment the controlled TypeSafe endpoint returns for the tool call. */
const syntheticJudgment = {
  model: 'jev-1.13.0',
  answers: {
    reply_choice: {
      type: 'choice',
      choice: 'revise',
      probabilities: { keep: 0.04, revise: 0.94, uncertain: 0.02 },
      confidence: 0.92,
    },
  },
  usage: { input_tokens: 128, output_tokens: 6 },
};

/** One synthetic applicability question sharing one state, as a caller would submit it. */
const syntheticRequest = {
  state: syntheticState,
  questions: {
    reply_choice: {
      type: 'choice',
      instructions: 'Should the draft reply be kept or revised?',
      criteria: {
        keep: 'Send the draft as written',
        revise: 'Revise the draft before sending',
        uncertain: 'The evidence cannot establish it',
      },
    },
  },
};

const providers: ControlledJevProvider[] = [];
const servers: CodexAppServer[] = [];
const homes: string[] = [];
const directories: string[] = [];

async function provider(): Promise<ControlledJevProvider> {
  const controlled = await controlledJevProvider();
  providers.push(controlled);
  return controlled;
}

async function home(baseConfiguration = ''): Promise<string> {
  const directory = await codexHome(baseConfiguration);
  homes.push(directory);
  return directory;
}

/** The app server session's thread and its single reserved server's status. */
async function reservedServerStatus(server: CodexAppServer): Promise<{
  readonly threadId: string;
  readonly tools: Readonly<Record<string, unknown>>;
  readonly toolsError: string | null;
}> {
  const started = (await server.request('thread/start', { cwd: repositoryRoot })) as {
    readonly thread: { readonly id: string };
  };
  const threadId = started.thread.id;
  const listed = (await server.request('mcpServerStatus/list', {
    serverName: 'jev',
    detail: 'full',
    threadId,
  })) as {
    readonly data: readonly {
      readonly name: string;
      readonly tools: Readonly<Record<string, unknown>>;
      readonly toolsError: string | null;
    }[];
  };
  const jev = listed.data.find((candidate) => candidate.name === 'jev');
  if (jev === undefined) {
    throw new Error('the provider reported no reserved jev server');
  }
  return { threadId, tools: jev.tools, toolsError: jev.toolsError };
}

/** The text of one provider tool call result. */
function resultText(result: unknown): string {
  const content = (result as { readonly content?: readonly { readonly text?: string }[] }).content;
  return (content ?? []).map((part) => part.text ?? '').join('\n');
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(providers.splice(0).map((controlled) => controlled.close()));
  await Promise.all(
    homes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(!nativeProviderInstalled)('composed native JEv settings', () => {
  it.each(['base', 'profile', 'project', 'ancestor-override'] as const)(
    'replaces %s inheritance through the coding adapter for enabled calls and disabled startup',
    async (source) => {
      const conflictingHttp =
        '[mcp_servers.jev]\nurl = "https://example.invalid/mcp"\nenabled = true\n';
      const conflictingStdio = `[mcp_servers.jev]\ncommand = "/inherited/jev-mcp"\nrequired = true\ndisabled_tools = ["ask_jev"]\n[mcp_servers.jev.env]\nJEV_API_KEY = "inherited-key"\nJEV_MODEL = "inherited-model"\nJEV_TIMEOUT_MS = "13"\n`;
      // An unrelated server and personal setting must retain their native ownership.
      const unrelated =
        'model = "kept-model"\n[mcp_servers.other]\nurl = "https://example.invalid/other"\nenabled = false\n';
      for (const availability of ['enabled', 'omitted', 'disabled', 'missing-key'] as const) {
        const conflict = availability === 'enabled' ? conflictingStdio : conflictingHttp;
        const directory = await home(unrelated + (source === 'base' ? conflict : ''));
        let worktree = repositoryRoot;
        if (source === 'project') {
          worktree = path.join(directory, 'project');
          await mkdir(path.join(worktree, '.codex'), { recursive: true });
          expect(spawnSync('git', ['init', '-q', worktree]).status).toBe(0);
          await writeFile(path.join(worktree, '.codex', 'config.toml'), conflict);
          await writeFile(
            path.join(directory, 'config.toml'),
            `${unrelated}\n[projects.${JSON.stringify(worktree)}]\ntrust_level = "trusted"\n`,
          );
        }
        const profileText = source === 'profile' ? conflict : '# installed profile\n';
        await writeFile(path.join(directory, 'nexus-flash.config.toml'), profileText);
        const baseText = await readFile(path.join(directory, 'config.toml'), 'utf8');
        const enabled = availability === 'enabled';
        const tools = composedToolSettings(
          (configured) => {
            if (availability !== 'omitted')
              configured.jev = { enabled: availability !== 'disabled', credential: 'jevApiKey' };
            if (source === 'ancestor-override')
              configured.agentRuntime.profiles[0]!.toolSettings = {
                profile: 'nexus-flash',
                config: {
                  mcp_servers: {
                    jev: {
                      url: 'https://example.invalid/mcp',
                      enabled: true,
                      env: { JEV_API_KEY: 'inherited-key', JEV_MODEL: 'inherited-model' },
                    },
                    kept: { url: 'https://example.invalid/kept', enabled: false },
                  },
                },
              };
          },
          availability === 'missing-key' ? {} : { JEV_API_KEY: syntheticKey },
        );

        await withNativeConfiguration(
          directory,
          tools,
          async (selected) => {
            expect(selected.overrides.join('\n')).not.toContain(syntheticKey);
            expect(selected.overrides.join('\n')).not.toContain('inherited-key');
            const listed = await providerMcpServers(
              directory,
              selected.overrides,
              selected.profile,
              worktree,
            );
            if (enabled)
              expect(listed.find((server) => server.name.startsWith('nexus-jev-'))).toMatchObject({
                enabled,
                transport: {
                  type: 'stdio',
                  command: jevExecutablePath(),
                  env_vars: forwardedEnvironment,
                },
              });
            expect(listed.find((server) => server.name === 'jev')?.enabled ?? false).toBe(false);
            if (enabled) {
              expect(
                listed.find((server) => server.name.startsWith('nexus-jev-'))?.transport.env ??
                  null,
              ).toBeNull();
            } else {
              expect(listed.some((server) => server.name.startsWith('nexus-jev-'))).toBe(false);
            }
            expect(listed.find((server) => server.name === 'other')).toMatchObject({
              enabled: false,
              transport: { url: 'https://example.invalid/other' },
            });
            if (source === 'ancestor-override')
              expect(listed.find((server) => server.name === 'kept')?.enabled).toBe(false);
            const controlled = await provider();
            controlled.succeed(syntheticJudgment);
            const model = await controlledCodexModel(enabled ? syntheticRequest : null);
            try {
              const result = await createCodingRuntime({
                executable: 'codex',
                environment: {
                  PATH: process.env['PATH']!,
                  HOME: process.env['HOME']!,
                  CODEX_HOME: directory,
                  JEV_API_KEY: syntheticKey,
                  JEV_MODEL: 'not-the-default',
                  JEV_TIMEOUT_MS: '13',
                },
              }).execute(
                {
                  prompt: 'Run the synthetic check.',
                  model: 'synthetic-model',
                  effort: null,
                  toolSettings: {
                    ...tools,
                    profile: selected.profile,
                    config: {
                      ...(tools['config'] as Record<string, unknown>),
                      model_provider: 'fixture',
                      'model_providers.fixture': {
                        name: 'Synthetic local model',
                        base_url: model.origin,
                        wire_api: 'responses',
                        requires_openai_auth: false,
                      },
                      'features.code_mode': false,
                      'features.tool_search': false,
                      'mcp_servers.jev.env': {
                        NODE_OPTIONS: `--import=${preload}`,
                        JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
                      },
                    },
                  },
                  directory: worktree,
                  timeLimitMs: 15_000,
                },
                () => undefined,
              );
              expect(result).toEqual({ ok: true, value: { output: 'synthetic completed' } });
              if (enabled) {
                expect(JSON.stringify(model.requests[0]?.['tools'])).toContain('ask_jev');
                expect(model.requests).toHaveLength(2);
                const outputs = (model.requests[1]?.['input'] as { type: string }[]).filter(
                  (item) => item.type === 'function_call_output',
                );
                expect(JSON.stringify(outputs)).toContain('0.94');
                expect(JSON.stringify(outputs)).toContain('jev-1.13.0');
                expect(controlled.requests[0]?.authorization).toBe(`Bearer ${syntheticKey}`);
                expect(JSON.parse(controlled.requests[0]!.body).model).toBe('jev-1.13.0');
              } else {
                expect(JSON.stringify(model.requests[0]?.['tools'])).not.toContain('ask_jev');
                expect(controlled.requests).toHaveLength(0);
              }
            } finally {
              await model.close();
            }
          },
          worktree,
        );
        expect(await readFile(path.join(directory, 'nexus-flash.config.toml'), 'utf8')).toBe(
          profileText,
        );
        expect(await readFile(path.join(directory, 'config.toml'), 'utf8')).toBe(baseText);
        if (source === 'project')
          expect(await readFile(path.join(worktree, '.codex', 'config.toml'), 'utf8')).toBe(
            conflict,
          );
      }
    },
    30_000,
  );
  it('reports the reserved server enabled with the installed executable and key forwarding', async () => {
    const listed = await providerMcpServers(await home(), configArguments(jevAgentSettings(true)));
    const jev = listed.find((server) => server.name === 'jev');

    expect(jev).toMatchObject({
      enabled: true,
      transport: {
        type: 'stdio',
        command: jevExecutablePath(),
        args: [],
        env_vars: forwardedEnvironment,
      },
    });
    // The effective settings forward the host variable by name; no literal value is configured.
    expect(jev?.transport.env ?? null).toBeNull();
  });

  it('disables the reserved server over enabling base settings and owns its enabled settings', async () => {
    const enabledBase = [
      '[mcp_servers.jev]',
      `command = ${JSON.stringify(jevExecutablePath())}`,
      'enabled = true',
      'env_vars = ["JEV_MODEL"]',
      '',
    ].join('\n');
    const disabled = await providerMcpServers(
      await home(enabledBase),
      configArguments(jevAgentSettings(false)),
    );
    const inherited = disabled.find((server) => server.name === 'jev');
    expect(inherited).toMatchObject({
      enabled: false,
      transport: { command: jevExecutablePath(), env_vars: forwardedEnvironment },
    });

    const disabledBase = [
      '[mcp_servers.jev]',
      'command = "/old/nexus/node_modules/.bin/jev-mcp"',
      'enabled = false',
      '',
    ].join('\n');
    const enabled = await providerMcpServers(
      await home(disabledBase),
      configArguments(jevAgentSettings(true)),
    );
    expect(enabled.find((server) => server.name === 'jev')).toMatchObject({
      enabled: true,
      transport: { command: jevExecutablePath() },
    });
  });

  it('owns the reserved server over conflicting settings a selected profile supplies', async () => {
    const conflict = {
      profile: 'nexus-flash',
      config: { ...inheritedJevSettings },
    };
    const composed = composedToolSettings(
      (configured) => {
        configured.jev = { enabled: true, credential: 'jevApiKey' };
        configured.agentRuntime.profiles[0]!.toolSettings = conflict;
      },
      {
        JEV_API_KEY: syntheticKey,
        JEV_MODEL: 'not-the-default',
        JEV_TIMEOUT_MS: '13',
      },
    );
    const config = composed['config'] as Readonly<Record<string, unknown>>;

    // The effective provider configuration carries only the composed reserved-server settings:
    // no inherited literal environment, HTTP transport or tool exclusion survives.
    const listed = await providerMcpServers(await home(), configArguments(config));
    const jev = listed.find((server) => server.name === 'jev');
    expect(jev).toMatchObject({
      enabled: true,
      transport: {
        type: 'stdio',
        command: jevExecutablePath(),
        args: [],
        env_vars: forwardedEnvironment,
      },
    });
    expect(jev?.transport.env ?? null).toBeNull();

    const controlled = await provider();
    controlled.succeed(syntheticJudgment);
    const server = await startCodexAppServer({
      codexHomeDirectory: await home(),
      overrides: configArguments({
        ...config,
        // Test-supplied literals route the delivered server to the controlled provider.
        'mcp_servers.jev.env': {
          NODE_OPTIONS: `--import=${preload}`,
          JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
        },
      }),
      environment: {
        JEV_API_KEY: syntheticKey,
        JEV_MODEL: 'not-the-default',
        JEV_TIMEOUT_MS: '13',
      },
    });
    servers.push(server);

    const status = await reservedServerStatus(server);
    expect(status.toolsError).toBeNull();
    expect(Object.keys(status.tools)).toEqual(['ask_jev']);
    const result = await server.request('mcpServer/tool/call', {
      server: 'jev',
      threadId: status.threadId,
      tool: 'ask_jev',
      arguments: syntheticRequest,
    });
    expect((result as { readonly structuredContent?: unknown }).structuredContent).toEqual(
      syntheticJudgment,
    );
    // The host key is the only credential the server applied and the package defaults applied:
    // the inherited literal key and model never reached the provider.
    expect(controlled.requests).toHaveLength(1);
    expect(controlled.requests[0]!.authorization).toBe(`Bearer ${syntheticKey}`);
    expect(JSON.parse(controlled.requests[0]!.body)).toMatchObject({
      model: 'jev-1.13.0',
      state: syntheticState,
    });
    expect(server.stderr()).not.toContain('inherited-key');
    expect(server.stderr()).not.toContain('inherited-model');
  });

  it('disables the reserved server over conflicting profile settings without breaking startup', async () => {
    const composed = composedToolSettings(
      (configured) => {
        configured.agentRuntime.profiles[0]!.toolSettings = {
          profile: 'nexus-flash',
          config: { ...inheritedJevSettings },
        };
      },
      { JEV_API_KEY: syntheticKey },
    );
    const config = composed['config'] as Readonly<Record<string, unknown>>;

    expect(config['mcp_servers.jev.url']).toBeUndefined();
    expect(config['mcp_servers.jev.enabled']).toBe(false);
    const listed = await providerMcpServers(await home(), configArguments(config));
    expect(listed.find((server) => server.name === 'jev')).toMatchObject({
      enabled: false,
      transport: { type: 'stdio', command: jevExecutablePath(), args: [] },
    });

    const server = await startCodexAppServer({
      codexHomeDirectory: await home(),
      overrides: configArguments(config),
      environment: { JEV_API_KEY: syntheticKey },
    });
    servers.push(server);

    const started = (await server.request('thread/start', { cwd: repositoryRoot })) as {
      readonly thread: { readonly id: string };
    };
    const status = (await server.request('mcpServerStatus/list', {
      serverName: 'jev',
      detail: 'full',
      threadId: started.thread.id,
    })) as {
      readonly data: readonly {
        readonly name: string;
        readonly tools: Readonly<Record<string, unknown>>;
      }[];
    };
    expect(Object.keys(status.data.find((entry) => entry.name === 'jev')?.tools ?? {})).toEqual([]);

    const executed = await server.request('command/exec', {
      command: ['/bin/echo', 'without-jev'],
      cwd: repositoryRoot,
    });
    expect(executed).toMatchObject({ exitCode: 0, stdout: 'without-jev\n' });
  });
});

describe.skipIf(!nativeProviderInstalled)('effective native provider access', () => {
  it('discovers and calls ask_jev over a base configuration that excludes the tool', async () => {
    const controlled = await provider();
    controlled.succeed(syntheticJudgment);
    const overrides = configArguments({
      ...jevAgentSettings(true),
      // Test-supplied literals route the delivered server to the controlled provider.
      'mcp_servers.jev.env': {
        NODE_OPTIONS: `--import=${preload}`,
        JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
      },
    });
    // The base configuration excludes the tool and points at a stale installation; the composed
    // settings own the reserved server, so the effective catalogue still exposes ask_jev.
    const excludingBase = [
      '[mcp_servers.jev]',
      'command = "/old/nexus/node_modules/.bin/jev-mcp"',
      'enabled = true',
      'disabled_tools = ["ask_jev"]',
      '',
    ].join('\n');
    // The composed arguments name the forwarded variables; their values stay in the host
    // environment and never enter a provider argument.
    expect(overrides.some((argument) => argument.includes(syntheticKey))).toBe(false);
    const server = await startCodexAppServer({
      codexHomeDirectory: await home(excludingBase),
      overrides,
      // The host model/timeout values must not reach the server's environment.
      environment: {
        JEV_API_KEY: syntheticKey,
        JEV_MODEL: 'not-the-default',
        JEV_TIMEOUT_MS: '13',
      },
    });
    servers.push(server);

    const status = await reservedServerStatus(server);
    expect(status.toolsError).toBeNull();
    expect(Object.keys(status.tools)).toEqual(['ask_jev']);

    const result = await server.request('mcpServer/tool/call', {
      server: 'jev',
      threadId: status.threadId,
      tool: 'ask_jev',
      arguments: syntheticRequest,
    });

    expect((result as { readonly structuredContent?: unknown }).structuredContent).toEqual(
      syntheticJudgment,
    );
    expect(JSON.parse(resultText(result))).toEqual(syntheticJudgment);
    expect(controlled.requests).toHaveLength(1);
    expect(controlled.requests[0]!.path).toBe('/v1/systemone');
    expect(controlled.requests[0]!.authorization).toBe(`Bearer ${syntheticKey}`);
    // Only the named host settings are forwarded, so the packaged model/timeout defaults apply.
    expect(JSON.parse(controlled.requests[0]!.body)).toMatchObject({
      model: 'jev-1.13.0',
      state: syntheticState,
    });
    expect(server.stderr()).not.toContain(syntheticKey);

    // The same session runs another capability without calling JEv.
    const executed = await server.request('command/exec', {
      command: ['/bin/echo', 'without-jev'],
      cwd: repositoryRoot,
    });
    expect(executed).toMatchObject({ exitCode: 0, stdout: 'without-jev\n' });
  });

  it('reports a safe ask_jev failure and keeps the provider session usable', async () => {
    const controlled = await provider();
    controlled.fail(429, '{"error":"rate limited"}');
    const server = await startCodexAppServer({
      codexHomeDirectory: await home(),
      overrides: configArguments({
        ...jevAgentSettings(true),
        'mcp_servers.jev.env': {
          NODE_OPTIONS: `--import=${preload}`,
          JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
        },
      }),
      environment: { JEV_API_KEY: syntheticKey },
    });
    servers.push(server);

    const status = await reservedServerStatus(server);
    const result = await server.request('mcpServer/tool/call', {
      server: 'jev',
      threadId: status.threadId,
      tool: 'ask_jev',
      arguments: syntheticRequest,
    });

    expect((result as { readonly isError?: boolean }).isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain('rate_limited');
    expect(text).not.toContain(syntheticKey);
    expect(text).not.toContain(syntheticState);
    expect(text).not.toContain('rate limited');
    expect(server.stderr()).not.toContain(syntheticKey);

    // The same session still runs the provider's own capabilities.
    const executed = await server.request('command/exec', {
      command: ['/bin/echo', 'session-usable'],
      cwd: repositoryRoot,
    });
    expect(executed).toMatchObject({ exitCode: 0, stdout: 'session-usable\n' });
  });

  it('exposes no ask_jev when the composed settings disable the reserved server', async () => {
    const enabledBase = [
      '[mcp_servers.jev]',
      `command = ${JSON.stringify(jevExecutablePath())}`,
      'enabled = true',
      '',
    ].join('\n');
    const server = await startCodexAppServer({
      codexHomeDirectory: await home(enabledBase),
      overrides: configArguments(jevAgentSettings(false)),
      environment: { JEV_API_KEY: syntheticKey },
    });
    servers.push(server);

    const started = (await server.request('thread/start', { cwd: repositoryRoot })) as {
      readonly thread: { readonly id: string };
    };
    const listed = (await server.request('mcpServerStatus/list', {
      serverName: 'jev',
      detail: 'full',
      threadId: started.thread.id,
    })) as {
      readonly data: readonly {
        readonly name: string;
        readonly tools: Readonly<Record<string, unknown>>;
      }[];
    };
    const jev = listed.data.find((candidate) => candidate.name === 'jev');
    expect(Object.keys(jev?.tools ?? {})).toEqual([]);

    const executed = await server.request('command/exec', {
      command: ['/bin/echo', 'session-usable'],
      cwd: repositoryRoot,
    });
    expect(executed).toMatchObject({ exitCode: 0, stdout: 'session-usable\n' });
  });

  it('leaves other provider capabilities usable when the reserved server cannot start', async () => {
    const server = await startCodexAppServer({
      codexHomeDirectory: await home(),
      overrides: configArguments({
        ...jevAgentSettings(true),
        'mcp_servers.jev.command': '/nonexistent/nexus/jev-mcp',
      }),
      environment: { JEV_API_KEY: syntheticKey },
    });
    servers.push(server);

    const status = await reservedServerStatus(server);
    expect(status.toolsError).toMatch(/startup failed/i);
    expect(Object.keys(status.tools)).toEqual([]);

    const executed = await server.request('command/exec', {
      command: ['/bin/echo', 'session-usable'],
      cwd: repositoryRoot,
    });
    expect(executed).toMatchObject({ exitCode: 0, stdout: 'session-usable\n' });
  });

  it('forwards the host logging settings and appends delivered usage records', async () => {
    const controlled = await provider();
    controlled.succeed(syntheticJudgment);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-jev-native-usage-'));
    directories.push(directory);
    const logPath = path.join(directory, 'usage.jsonl');

    const server = await startCodexAppServer({
      codexHomeDirectory: await home(),
      overrides: configArguments({
        ...jevAgentSettings(true),
        'mcp_servers.jev.env': {
          NODE_OPTIONS: `--import=${preload}`,
          JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
        },
      }),
      // The host enables logging; the composed settings forward these variables by name only.
      environment: {
        JEV_API_KEY: syntheticKey,
        JEV_USAGE_LOG_PATH: logPath,
        JEV_USAGE_LOG_CALLER: 'nexus-native-check',
      },
    });
    servers.push(server);

    const status = await reservedServerStatus(server);
    expect(status.toolsError).toBeNull();
    expect(Object.keys(status.tools)).toEqual(['ask_jev']);
    const result = await server.request('mcpServer/tool/call', {
      server: 'jev',
      threadId: status.threadId,
      tool: 'ask_jev',
      arguments: syntheticRequest,
    });
    expect((result as { readonly structuredContent?: unknown }).structuredContent).toEqual(
      syntheticJudgment,
    );

    const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      model: 'jev-1.13.0',
      caller: 'nexus-native-check',
      answers: syntheticJudgment.answers,
      usage: syntheticJudgment.usage,
    });
    expect(record['durationMs']).toBeGreaterThanOrEqual(0);
    // The forwarding carries only named host settings: the log never contains the state or key.
    expect(JSON.stringify(record)).not.toContain(syntheticState);
    expect(JSON.stringify(record)).not.toContain(syntheticKey);
  });
});
