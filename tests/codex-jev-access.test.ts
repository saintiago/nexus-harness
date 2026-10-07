/**
 * Focused integration checks for the composed JEv access through the installed coding provider:
 * the provider's own configuration merge reports the reserved server's effective settings, and
 * its app server discovers and calls the installed `ask_jev` tool against a controlled provider
 * response, including safe failures and continuation. No model turn, login, paid call or live
 * TypeSafe request is involved. The checks need the native provider the repository's profiles
 * document, so they run where it is installed and are skipped elsewhere, such as routine CI.
 */

import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { jevAgentSettings, jevExecutablePath } from '../src/application/jev.js';
import {
  codexHome,
  configArguments,
  providerMcpServers,
  startCodexAppServer,
  type CodexAppServer,
} from './support/codex-provider.js';
import { controlledJevProvider, type ControlledJevProvider } from './support/jev-provider.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/jev-provider-preload.mjs', import.meta.url));
const syntheticKey = 'synthetic-jev-host-key';
const syntheticState =
  'Synthetic stage note: the requested change has no reporting-terminal scope.';

/** Whether the documented native provider is installed for this run. */
const nativeProviderInstalled = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;

/** The judgment the controlled TypeSafe endpoint returns for the tool call. */
const syntheticJudgment = {
  model: 'jev-1.13.0',
  answers: {
    stage_applicability: {
      type: 'choice',
      choice: 'inapplicable',
      probabilities: { applicable: 0.02, inapplicable: 0.96, uncertain: 0.02 },
      confidence: 0.94,
    },
  },
  usage: { input_tokens: 128, output_tokens: 6 },
};

/** One synthetic applicability question sharing one state, as a caller would submit it. */
const syntheticRequest = {
  state: syntheticState,
  questions: {
    stage_applicability: {
      type: 'choice',
      instructions: 'Is this stage applicable to the requested outcome?',
      criteria: {
        applicable: 'The outcome needs this stage',
        inapplicable: 'The stage is outside the outcome',
        uncertain: 'The evidence cannot establish it',
      },
    },
  },
};

const providers: ControlledJevProvider[] = [];
const servers: CodexAppServer[] = [];
const homes: string[] = [];

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
});

describe.skipIf(!nativeProviderInstalled)('composed native JEv settings', () => {
  it('reports the reserved server enabled with the installed executable and key forwarding', async () => {
    const listed = await providerMcpServers(await home(), configArguments(jevAgentSettings(true)));
    const jev = listed.find((server) => server.name === 'jev');

    expect(jev).toMatchObject({
      enabled: true,
      transport: {
        type: 'stdio',
        command: jevExecutablePath(),
        args: [],
        env_vars: ['JEV_API_KEY'],
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
      transport: { command: jevExecutablePath(), env_vars: ['JEV_API_KEY'] },
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
});

describe.skipIf(!nativeProviderInstalled)('effective native provider access', () => {
  it('discovers and calls ask_jev for the synthetic judgment through the installed server', async () => {
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
    // The composed arguments name the forwarded variable; the key itself stays in the host
    // environment and never enters a provider argument.
    expect(overrides.some((argument) => argument.includes(syntheticKey))).toBe(false);
    const server = await startCodexAppServer({
      codexHomeDirectory: await home(),
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
    // Only the key is forwarded, so the packaged model/timeout defaults apply.
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
});
