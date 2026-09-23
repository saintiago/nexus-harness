/**
 * Focused integration tests: the real Coding runtime adapter drives a controlled provider process
 * emitting the Codex CLI's JSON Lines events, establishing the invocation it launches, the native
 * profile it requires, the activity it streams, the output it returns and its provider and protocol
 * failures. No live Codex, credentials or paid turn is involved.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCodingRuntime,
  type CodingRuntimeActivity,
  type CodingRuntimeRequest,
  type CodingRuntimeResult,
} from '../src/adapters/coding-runtime.js';

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
  readonly marker: string | null;
};

/** The native profile name the test fixtures install and select. */
const profile = 'nexus-fixture';

/** The recording prelude every controlled provider runs before it reports anything. */
const recordInvocation = `
import { writeFileSync } from 'node:fs';
writeFileSync(
  process.env.NEXUS_FIXTURE_RECORD,
  JSON.stringify({
    args: process.argv.slice(2),
    directory: process.cwd(),
    marker: process.env.NEXUS_FIXTURE_MARKER ?? null,
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
  options: { readonly install?: boolean } = {},
): Promise<{
  readonly executable: string;
  readonly environment: Record<string, string>;
  invocation(): Promise<RecordedInvocation | null>;
}> {
  const directory = await temporaryDirectory();
  const executable = path.join(directory, 'codex-fixture');
  await writeFile(executable, `#!${process.execPath}\n${source}\n`);
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
      '--',
      prompt,
    ]);
    expect(invocation?.directory).toBe(directory);
    expect(invocation?.marker).toBe('marker-value');
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
    expect((await fixture.invocation())?.args).toEqual([
      'exec',
      '--json',
      '--profile',
      profile,
      '--model',
      'gpt-6-astra',
      '--',
      'Complete the supplied task.',
    ]);
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

    const { result } = await execute(fixture, { timeLimitMs: 300 });

    expect(result).toMatchObject({
      ok: false,
      fault: { message: expect.stringMatching(/time limit/) },
    });
    expect(await fixture.invocation()).not.toBeNull();
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
});
