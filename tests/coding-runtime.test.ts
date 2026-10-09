/**
 * Focused integration tests: the real Coding runtime adapter drives a controlled provider process
 * emitting the Codex CLI's JSON Lines events, establishing the invocation it launches, the native
 * profile it requires, the activity it streams, the output it returns and its provider and protocol
 * failures. No live Codex, credentials or paid turn is involved.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCodingRuntime,
  type CodingRuntimeActivity,
  type CodingRuntimeRequest,
  type CodingRuntimeResult,
} from '../src/adapters/coding-runtime.js';
import { createAgentRuntimeSettings } from '../src/application/composition.js';
import { parseNexusConfiguration } from '../src/configuration/index.js';
import { nexusConfiguration } from './support/configuration.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-coding-runtime-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** What a controlled provider process recorded about its own invocation. */
type RecordedInvocation = {
  readonly args: readonly string[];
  readonly directory: string;
  readonly stdin: string;
  readonly marker: string | null;
  /** The path the invocation passed through `--output-schema`, or null when it passed none. */
  readonly schemaPath: string | null;
  /** The complete text of that schema file, read before the adapter removes it. */
  readonly schema: string | null;
  readonly codexHome: string | null;
  readonly profileText: string | null;
};

/** The native profile name the test fixtures install and select. */
const profile = 'nexus-fixture';

/** The recording prelude every controlled provider runs before it reports anything. */
const recordInvocation = `
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const schemaFlag = process.argv.indexOf('--output-schema');
const schemaPath = schemaFlag === -1 ? null : (process.argv[schemaFlag + 1] ?? null);
const selectedProfile = process.argv[process.argv.indexOf('--profile') + 1];
writeFileSync(
  process.env.NEXUS_FIXTURE_RECORD,
  JSON.stringify({
    args: process.argv.slice(2),
    directory: process.cwd(),
    stdin: readFileSync(0, 'utf8'),
    marker: process.env.NEXUS_FIXTURE_MARKER ?? null,
    schemaPath,
    schema: schemaPath === null ? null : readFileSync(schemaPath, 'utf8'),
    codexHome: process.env.CODEX_HOME ?? null,
    profileText: process.env.CODEX_HOME ? readFileSync(path.join(process.env.CODEX_HOME, selectedProfile + '.config.toml'), 'utf8') : null,
  }),
);
`;

/** The JSON Lines text of the supplied protocol events, without a trailing newline. */
function protocol(events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

/** Render text as a JavaScript string literal for a fixture script. */
function literal(text: string): string {
  return JSON.stringify(text);
}

/** Install a controlled provider and the native profile file the adapter requires. */
async function providerFixture(
  source: string,
  options: {
    readonly install?: boolean;
    readonly inheritedServers?: readonly string[];
    readonly mcpList?: {
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
    };
  } = {},
): Promise<{
  readonly executable: string;
  readonly environment: Record<string, string>;
  invocation(): Promise<RecordedInvocation | null>;
}> {
  const directory = await temporaryDirectory();
  const executable = path.join(directory, 'codex-fixture');
  await writeFile(
    executable,
    `#!${process.execPath}\nif (process.argv.includes('mcp') && process.argv.includes('list')) { process.stdout.write(${JSON.stringify(options.mcpList?.stdout ?? JSON.stringify((options.inheritedServers ?? []).map((name) => ({ name }))))}); process.stderr.write(${JSON.stringify(options.mcpList?.stderr ?? '')}); process.exit(${String(options.mcpList?.exitCode ?? 0)}); }\n${source}\n`,
  );
  await chmod(executable, 0o755);
  const codexHome = path.join(directory, 'codex-home');
  await mkdir(codexHome);
  if (options.install !== false) {
    await writeFile(path.join(codexHome, `${profile}.config.toml`), '# installed native profile\n');
  }
  const recordPath = path.join(directory, 'invocation.json');
  return {
    executable,
    environment: {
      CODEX_HOME: codexHome,
      NEXUS_FIXTURE_RECORD: recordPath,
      NEXUS_FIXTURE_MARKER: 'marker-value',
    },
    async invocation() {
      try {
        return JSON.parse(await readFile(recordPath, 'utf8')) as RecordedInvocation;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
  };
}

/** Run one invocation of the real adapter over the supplied fixture and request. */
async function execute(
  fixture: { readonly executable: string; readonly environment: Record<string, string> },
  request: Partial<CodingRuntimeRequest> = {},
): Promise<{
  readonly result: CodingRuntimeResult;
  readonly activities: CodingRuntimeActivity[];
}> {
  const activities: CodingRuntimeActivity[] = [];
  const runtime = createCodingRuntime({
    executable: fixture.executable,
    environment: fixture.environment,
  });
  const result = await runtime.execute(
    {
      prompt: 'Complete the supplied task.',
      model: 'deepseek-flash',
      effort: 'max',
      toolSettings: { profile },
      directory: await temporaryDirectory(),
      timeLimitMs: 30_000,
      ...request,
    },
    (activity) => activities.push(activity),
  );
  return { result, activities };
}

describe('Coding runtime adapter', () => {
  it('invokes the selected profile and returns complete output and activity', async () => {
    const events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'npm test',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'Tests 3 passed\nDone\n',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'file_change',
          changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts' }],
        },
      },
      { type: 'item.completed', item: { id: 'item_3', type: 'reasoning', text: 'thinking' } },
      {
        type: 'item.completed',
        item: { id: 'item_4', type: 'agent_message', text: '{"status":"completed"}\n' },
      },
      { type: 'turn.completed', usage: { input_tokens: 10 } },
    ];
    const fixture = await providerFixture(
      `${recordInvocation}\nprocess.stdout.write(${literal(`${protocol(events)}\n`)});\n`,
    );
    const prompt = 'Complete the supplied task.\n\nReturn only JSON.';
    const directory = await temporaryDirectory();

    const { result, activities } = await execute(fixture, { prompt, directory });

    expect(result).toEqual({ ok: true, value: { output: '{"status":"completed"}\n' } });
    expect(activities).toEqual([
      { type: 'command', text: 'npm test' },
      { type: 'result', text: 'exit 0 — npm test — Tests 3 passed\nDone\n' },
      { type: 'change', text: 'update src/a.ts' },
      { type: 'change', text: 'src/b.ts' },
      { type: 'message', text: '{"status":"completed"}\n' },
      { type: 'diagnostic', text: 'Agent token usage: {"input_tokens":10}' },
    ]);
    const invocation = await fixture.invocation();
    expect(invocation?.args).toEqual([
      'exec',
      '--json',
      '--profile',
      profile,
      '--model',
      'deepseek-flash',
      '-c',
      'model_reasoning_effort="max"',
      '-',
    ]);
    expect(invocation?.stdin).toBe(prompt);
    expect(invocation?.directory).toBe(directory);
    expect(invocation?.marker).toBe('marker-value');
  });

  it("passes a supplied output schema through the provider's native setting and removes its file", async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        {
          type: 'item.completed',
          item: { id: 'item_1', type: 'agent_message', text: '{"status":"completed"}' },
        },
        { type: 'turn.completed' },
      ])}\n`,
    )});
`);
    const outputSchema = {
      type: 'object',
      properties: { status: { type: 'string', enum: ['completed', 'failed'] } },
      required: ['status'],
      additionalProperties: false,
    };

    const { result, activities } = await execute(fixture, { outputSchema });

    expect(result).toEqual({ ok: true, value: { output: '{"status":"completed"}' } });
    expect(activities).toEqual([{ type: 'message', text: '{"status":"completed"}' }]);
    const invocation = await fixture.invocation();
    const schemaPath = invocation?.schemaPath ?? '';
    expect(path.isAbsolute(schemaPath)).toBe(true);
    expect(invocation?.args).toEqual([
      'exec',
      '--json',
      '--profile',
      profile,
      '--model',
      'deepseek-flash',
      '-c',
      'model_reasoning_effort="max"',
      '--output-schema',
      schemaPath,
      '-',
    ]);
    // The provider read exactly the caller-supplied JSON Schema, unchanged.
    expect(invocation?.schema).toBe(`${JSON.stringify(outputSchema, null, 2)}\n`);
    // The invocation-local file and its directory are gone once the invocation settles.
    await expect(stat(schemaPath)).rejects.toThrow(/ENOENT/);
    await expect(stat(path.dirname(schemaPath))).rejects.toThrow(/ENOENT/);
  });

  it('gives each concurrent invocation its own schema file and removes both', async () => {
    const first = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed' },
      ])}\n`,
    )});
`);
    const second = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed' },
      ])}\n`,
    )});
`);
    const firstSchema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    };
    const secondSchema = {
      type: 'object',
      properties: { decision: { type: 'string' } },
      required: ['decision'],
    };

    const [firstRun, secondRun] = await Promise.all([
      execute(first, { outputSchema: firstSchema }),
      execute(second, { outputSchema: secondSchema }),
    ]);

    expect(firstRun.result.ok).toBe(true);
    expect(secondRun.result.ok).toBe(true);
    const firstInvocation = await first.invocation();
    const secondInvocation = await second.invocation();
    expect(firstInvocation?.schemaPath).not.toBeNull();
    expect(secondInvocation?.schemaPath).not.toBeNull();
    expect(firstInvocation?.schemaPath).not.toBe(secondInvocation?.schemaPath);
    expect(firstInvocation?.schema).toBe(`${JSON.stringify(firstSchema, null, 2)}\n`);
    expect(secondInvocation?.schema).toBe(`${JSON.stringify(secondSchema, null, 2)}\n`);
    for (const schemaPath of [firstInvocation?.schemaPath, secondInvocation?.schemaPath]) {
      await expect(stat(schemaPath ?? '')).rejects.toThrow(/ENOENT/);
    }
  });

  it('removes the schema file when the invocation fails', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([{ type: 'thread.started', thread_id: 'thread-1' }])}\n`,
    )});
process.exitCode = 1;
`);
    const outputSchema = { type: 'object', properties: { summary: { type: 'string' } } };

    const { result } = await execute(fixture, { outputSchema });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('exited with code 1') },
    });
    const invocation = await fixture.invocation();
    await expect(stat(invocation?.schemaPath ?? '')).rejects.toThrow(/ENOENT/);
    await expect(stat(path.dirname(invocation?.schemaPath ?? ''))).rejects.toThrow(/ENOENT/);
  });

  it('reports a fault for a schema it cannot prepare without starting the provider', async () => {
    const fixture = await providerFixture(`${recordInvocation}\n`);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const { result, activities } = await execute(fixture, { outputSchema: circular });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('output schema could not be prepared') },
    });
    expect(activities).toEqual([]);
    expect(await fixture.invocation()).toBeNull();
  });

  it('represents MCP tool calls and web searches as command and result activity', async () => {
    const events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'mcp_tool_call',
          server: 'tavily',
          tool: 'tavily_search',
          arguments: { query: 'codex exec events' },
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'mcp_tool_call',
          server: 'tavily',
          tool: 'tavily_search',
          arguments: { query: 'codex exec events' },
          status: 'completed',
          result: {
            content: [{ type: 'text', text: 'first line\nsecond line' }],
            structured_content: { results: [1, 2] },
          },
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'mcp_tool_call',
          server: 'context7',
          tool: 'resolve-library-id',
          arguments: null,
          status: 'failed',
          error: { message: 'server unavailable' },
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'item_3',
          type: 'web_search',
          query: 'codex exec jsonl',
          action: { type: 'search' },
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'web_search',
          query: 'codex exec jsonl',
          action: { type: 'search' },
          results: [{ title: 'Events', url: 'https://example.test/events' }],
        },
      },
      { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 10 } },
    ];
    const fixture = await providerFixture(
      `${recordInvocation}\nprocess.stdout.write(${literal(`${protocol(events)}\n`)});\n`,
    );

    const { result, activities } = await execute(fixture);

    expect(result).toEqual({ ok: true, value: { output: 'done' } });
    expect(activities).toEqual([
      { type: 'command', text: 'mcp tavily/tavily_search {"query":"codex exec events"}' },
      {
        type: 'result',
        text:
          'completed — mcp tavily/tavily_search — ' +
          '{"content":[{"type":"text","text":"first line\\nsecond line"}],' +
          '"structured_content":{"results":[1,2]}}',
      },
      { type: 'result', text: 'failed — mcp context7/resolve-library-id — server unavailable' },
      { type: 'command', text: 'web search: codex exec jsonl' },
      {
        type: 'result',
        text:
          'completed — web search: codex exec jsonl — ' +
          '[{"title":"Events","url":"https://example.test/events"}]',
      },
      { type: 'message', text: 'done' },
      { type: 'diagnostic', text: 'Agent token usage: {"input_tokens":10}' },
    ]);
  });

  it('omits the effort override when the supplied effort is null', async () => {
    const fixture = await providerFixture(
      `${recordInvocation}\nprocess.stdout.write(${literal(
        `${protocol([
          { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
          { type: 'turn.completed' },
        ])}\n`,
      )});\n`,
    );

    const { result } = await execute(fixture, { effort: null, model: 'gpt-6-astra' });

    expect(result).toEqual({ ok: true, value: { output: 'done' } });
    const invocation = await fixture.invocation();
    expect(invocation?.args).toEqual([
      'exec',
      '--json',
      '--profile',
      profile,
      '--model',
      'gpt-6-astra',
      '-',
    ]);
    expect(invocation?.stdin).toBe('Complete the supplied task.');
  });

  it('passes a large Unicode prompt through standard input instead of an argument', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed' },
      ])}\n`,
    )});
`);
    const unit = 'Revisión completa — diff ✓ 你好\n';
    const prompt = unit.repeat(Math.ceil(150_000 / unit.length) + 1);

    const { result, activities } = await execute(fixture, { prompt });

    expect(prompt.length).toBeGreaterThan(150_000);
    expect(result).toEqual({ ok: true, value: { output: 'done' } });
    expect(activities).toEqual([{ type: 'message', text: 'done' }]);
    const invocation = await fixture.invocation();
    expect(invocation?.args).toEqual([
      'exec',
      '--json',
      '--profile',
      profile,
      '--model',
      'deepseek-flash',
      '-c',
      'model_reasoning_effort="max"',
      '-',
    ]);
    expect(invocation?.stdin).toBe(prompt);
  });

  it('reports a launch error for a profile that is not installed without starting it', async () => {
    const fixture = await providerFixture(
      `${recordInvocation}\nprocess.stdout.write(${literal(
        `${protocol([
          { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
        ])}\n`,
      )});\n`,
      { install: false },
    );

    const { result, activities } = await execute(fixture);

    expect(result).toMatchObject({
      ok: false,
      fault: {
        message: expect.stringContaining(
          `The selected Codex profile "${profile}" is not installed`,
        ),
      },
    });
    expect(activities).toEqual([]);
    expect(await fixture.invocation()).toBeNull();
  });

  it('reports a fault for tool settings that do not name a profile', async () => {
    const fixture = await providerFixture(`${recordInvocation}\nprocess.stdout.write('');\n`, {
      install: false,
    });

    const { result } = await execute(fixture, { toolSettings: {} });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('must name the installed profile') },
    });
    expect(await fixture.invocation()).toBeNull();
  });

  it('resolves the installed profile from the Codex home under HOME', async () => {
    const home = await temporaryDirectory();
    await mkdir(path.join(home, '.codex'), { recursive: true });
    await writeFile(
      path.join(home, '.codex', `${profile}.config.toml`),
      '# installed native profile\n',
    );
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed' },
      ])}\n`,
    )});
`);
    const environment = {
      HOME: home,
      NEXUS_FIXTURE_RECORD: fixture.environment['NEXUS_FIXTURE_RECORD'] ?? '',
      NEXUS_FIXTURE_MARKER: 'marker-value',
    };

    const { result } = await execute({ executable: fixture.executable, environment });

    expect(result).toEqual({ ok: true, value: { output: 'done' } });
    expect(await fixture.invocation()).not.toBeNull();
  });

  it('reports a fault when the environment locates no Codex home', async () => {
    const fixture = await providerFixture(`${recordInvocation}\n`, { install: false });

    const { result } = await execute({
      executable: fixture.executable,
      environment: {
        NEXUS_FIXTURE_RECORD: fixture.environment['NEXUS_FIXTURE_RECORD'] ?? '',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('CODEX_HOME nor HOME') },
    });
    expect(await fixture.invocation()).toBeNull();
  });

  it('reports a fault for an unsupported tool setting', async () => {
    const fixture = await providerFixture(`${recordInvocation}\nprocess.stdout.write('');\n`, {
      install: false,
    });

    const { result } = await execute(fixture, {
      toolSettings: { profile, sandbox: 'danger-full-access' },
    });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('Unsupported Codex tool setting "sandbox"') },
    });
    expect(await fixture.invocation()).toBeNull();
  });

  it('passes native configuration overrides through the provider config setting', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: { input_tokens: 3 } },
      ])}\n`,
    )});
`);

    const { result } = await execute(fixture, {
      toolSettings: {
        profile,
        config: {
          'mcp_servers.amem.command': 'npm',
          'mcp_servers.amem.args': ['run', '--silent', 'mcp'],
          'mcp_servers.amem.env': { AMEM_MCP_SERVICE_URL: 'http://127.0.0.1:4748' },
          'mcp_servers.amem.enabled': true,
        },
      },
    });

    expect(result).toEqual({ ok: true, value: { output: 'done' } });
    const invocation = await fixture.invocation();
    expect(invocation?.args).toEqual([
      'exec',
      '--json',
      '--profile',
      profile,
      '--model',
      'deepseek-flash',
      '-c',
      'model_reasoning_effort="max"',
      '-c',
      'mcp_servers.amem.command="npm"',
      '-c',
      'mcp_servers.amem.args=["run", "--silent", "mcp"]',
      '-c',
      'mcp_servers.amem.env={ AMEM_MCP_SERVICE_URL = "http://127.0.0.1:4748" }',
      '-c',
      'mcp_servers.amem.enabled=true',
      '-',
    ]);
  });

  it('isolates composed MCP settings without changing native host files or resources', async () => {
    const fixture = await providerFixture(
      `${recordInvocation}
process.stdout.write(${literal(
        protocol([
          { type: 'item.completed', item: { type: 'agent_message', text: 'completed' } },
          { type: 'turn.completed' },
        ]),
      )});`,
      { inheritedServers: ['jev'] },
    );
    const codexHome = fixture.environment['CODEX_HOME']!;
    const original =
      'model = "kept-model"\n[mcp_servers.jev]\nurl = "https://example.invalid/mcp"\n';
    await writeFile(path.join(codexHome, `${profile}.config.toml`), original);
    const { result } = await execute(fixture, {
      toolSettings: {
        profile,
        isolatedMcpServers: ['jev'],
        config: { 'mcp_servers.jev.command': 'jev-mcp', 'mcp_servers.jev.enabled': true },
      },
    });
    expect(result).toEqual({ ok: true, value: { output: 'completed' } });
    const invocation = (await fixture.invocation())!;
    expect(invocation.codexHome).toBe(codexHome);
    expect(invocation.profileText).toBe(original);
    expect(invocation.args).toContain('mcp_servers.jev.enabled=false');
    expect(invocation.args).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^mcp_servers\.nexus-jev-[a-f0-9-]+\.command="jev-mcp"$/),
        expect.stringMatching(/^mcp_servers\.nexus-jev-[a-f0-9-]+\.enabled=true$/),
      ]),
    );
    expect(invocation.args).not.toContain('mcp_servers.jev.command="jev-mcp"');
    expect(await readFile(path.join(codexHome, `${profile}.config.toml`), 'utf8')).toBe(original);
  });

  it.each([null, 'jev', ['mcp servers.jev']])(
    'rejects malformed MCP isolation settings: %j',
    async (isolatedMcpServers) => {
      const fixture = await providerFixture(recordInvocation);
      const invalid = await execute(fixture, { toolSettings: { profile, isolatedMcpServers } });
      expect(invalid.result).toMatchObject({
        ok: false,
        fault: { message: expect.stringContaining('isolatedMcpServers') },
      });
      expect(await fixture.invocation()).toBeNull();
    },
  );

  it.each([0, 1])(
    'keeps failed or invalid native inspection data out of faults and activity: exit %i',
    async (exitCode) => {
      const sensitive = 'synthetic-sensitive-catalogue-value';
      const fixture = await providerFixture(recordInvocation, {
        mcpList: { stdout: sensitive, stderr: sensitive, exitCode },
      });
      const { result, activities } = await execute(fixture, {
        toolSettings: { profile, isolatedMcpServers: ['jev'] },
      });
      expect(result).toMatchObject({
        ok: false,
        fault: { message: expect.stringContaining('Codex provider') },
      });
      expect(JSON.stringify(result)).not.toContain(sensitive);
      expect(activities).toEqual([]);
      expect(await fixture.invocation()).toBeNull();
    },
  );

  it('rejects a malformed profile configuration that Nexus composition preserved', async () => {
    const configured = nexusConfiguration();
    configured.agentRuntime.profiles[0]!.toolSettings = {
      profile: 'nexus-flash',
      config: ['invalid-native-setting'],
    };
    const settings = createAgentRuntimeSettings(
      parseNexusConfiguration(configured, '/etc/nexus/installation'),
      'developer',
      // The composed settings are what this check supplies; the capability is never invoked.
      { execute: () => Promise.resolve({ ok: false, fault: { message: 'unused' } }) },
      {},
    );
    const toolSettings = settings.profiles.find(
      (candidate) => candidate.id === 'nexus-flash',
    )!.toolSettings;
    const fixture = await providerFixture(`${recordInvocation}\n`, { install: false });

    const { result } = await execute(fixture, { toolSettings });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('must be an object of native values') },
    });
    expect(await fixture.invocation()).toBeNull();
  });

  it('reports a fault for an override that is not a dotted path or holds an unsupported value', async () => {
    const fixture = await providerFixture(`${recordInvocation}\nprocess.stdout.write('');\n`, {
      install: false,
    });

    const pathFault = await execute(fixture, {
      toolSettings: { profile, config: { 'mcp servers.amem': 'npm' } },
    });
    expect(pathFault.result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('is not a dotted path') },
    });

    const valueFault = await execute(fixture, {
      toolSettings: { profile, config: { 'mcp_servers.amem.enabled': null } },
    });
    expect(valueFault.result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('cannot be expressed as TOML') },
    });
    expect(await fixture.invocation()).toBeNull();
  });

  it("returns the provider's failure message when the invocation fails", async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'error', message: 'Missing environment variable: `DEEPSEEK_API_KEY`.' },
        {
          type: 'turn.failed',
          error: { message: 'Missing environment variable: `DEEPSEEK_API_KEY`.' },
        },
      ])}\n`,
    )});
process.exitCode = 1;
`);

    const { result, activities } = await execute(fixture);

    expect(result).toMatchObject({
      ok: false,
      fault: {
        message: expect.stringMatching(
          /exited with code 1: Missing environment variable: `DEEPSEEK_API_KEY`\./,
        ),
      },
    });
    expect(activities).toEqual([]);
  });

  it('reports a fault when the provider reports a failed turn on a zero exit code', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'partial' } },
        { type: 'turn.failed', error: { message: 'stream retries exhausted' } },
      ])}\n`,
    )});
process.exitCode = 0;
`);

    const { result } = await execute(fixture);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('failed turn: stream retries exhausted') },
    });
  });

  it('reports a fault when the event stream ends without completing the turn', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'error', message: 'stream disconnected before completion' },
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'partial' } },
      ])}\n`,
    )});
process.exitCode = 0;
`);

    const { result } = await execute(fixture);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('without completing a turn') },
    });
  });

  it('returns output when a transient error precedes a completed turn', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'error', message: 'stream disconnected before completion' },
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: { input_tokens: 10 } },
      ])}\n`,
    )});
process.exitCode = 0;
`);

    const { result } = await execute(fixture);

    expect(result).toEqual({ ok: true, value: { output: 'done' } });
  });

  it('reports a launch failure excluding the supplied environment values', async () => {
    const directory = await temporaryDirectory();
    const fixture = await providerFixture(`${recordInvocation}\n`);

    const { result } = await execute({
      executable: path.join(directory, 'missing-codex'),
      environment: fixture.environment,
    });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('missing-codex') },
    });
    expect(JSON.stringify(result)).not.toContain('marker-value');
  });

  it('reports a fault for output that is not a provider event', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write('Reading additional input from stdin...\\n');
`);

    const { result } = await execute(fixture);

    expect(result).toMatchObject({
      ok: false,
      fault: {
        message: expect.stringContaining(
          'not a JSON event: Reading additional input from stdin...',
        ),
      },
    });
  });

  it('reports a fault when the invocation ends without a final message', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([{ type: 'thread.started', thread_id: 'thread-1' }, { type: 'turn.completed' }])}\n`,
    )});
`);

    const { result } = await execute(fixture);

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringContaining('without returning a final agent message') },
    });
  });

  it('reads activity and output split across chunks and without a final newline', async () => {
    const message = 'Tarea añadida ✓';
    const events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: message } },
      { type: 'turn.completed' },
    ];
    const stream = protocol(events);
    const cut = Buffer.byteLength(stream.slice(0, stream.indexOf('añ')), 'utf8') + 1;
    const fixture = await providerFixture(`${recordInvocation}
const stream = Buffer.from(${literal(stream)}, 'utf8');
process.stdout.write(stream.subarray(0, ${String(cut)}));
setTimeout(() => process.stdout.write(stream.subarray(${String(cut)})), 50);
`);

    const { result, activities } = await execute(fixture);

    expect(result).toEqual({ ok: true, value: { output: message } });
    expect(activities).toEqual([{ type: 'message', text: message }]);
  });

  it('applies the invocation time limit', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(`${protocol([{ type: 'thread.started', thread_id: 'thread-1' }])}\n`)});
setInterval(() => {}, 1000);
`);

    const { result } = await execute(fixture, {
      timeLimitMs: 300,
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
    });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/time limit/) },
    });
    const invocation = await fixture.invocation();
    expect(invocation).not.toBeNull();
    // A timed-out invocation still releases its schema file.
    await expect(stat(invocation?.schemaPath ?? '')).rejects.toThrow(/ENOENT/);
  });

  it('returns the provider result when the activity observer fails', async () => {
    const fixture = await providerFixture(`${recordInvocation}
process.stdout.write(${literal(
      `${protocol([
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed' },
      ])}\n`,
    )});
`);
    const runtime = createCodingRuntime({
      executable: fixture.executable,
      environment: fixture.environment,
    });

    const result = await runtime.execute(
      {
        prompt: 'Complete the supplied task.',
        model: 'deepseek-flash',
        effort: null,
        toolSettings: { profile },
        directory: await temporaryDirectory(),
        timeLimitMs: 30_000,
      },
      () => {
        throw new Error('observer failure');
      },
    );

    expect(result).toEqual({ ok: true, value: { output: 'done' } });
  });
  it('records only validated token usage fields from completed turns', async () => {
    const fixture = await providerFixture(
      `process.stdout.write(${literal(
        protocol([
          { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 21,
              cached_input_tokens: 10,
              output_tokens: 3,
              source: 'SECRET',
              bad: -1,
            },
          },
        ]),
      )});`,
    );
    const { activities } = await execute(fixture);
    expect(activities).toContainEqual({
      type: 'diagnostic',
      text: 'Agent token usage: {"input_tokens":21,"cached_input_tokens":10,"output_tokens":3}',
    });
    expect(JSON.stringify(activities)).not.toContain('SECRET');
  });
});
