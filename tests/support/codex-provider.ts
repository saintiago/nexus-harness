import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodingRuntime } from '../../src/adapters/coding-runtime.js';

/** Exercise native discovery/calls while the real adapter's isolated native settings are selected. */
export async function withNativeConfiguration<T>(
  home: string,
  toolSettings: Readonly<Record<string, unknown>>,
  inspect: (selected: {
    readonly profile: string;
    readonly overrides: readonly string[];
  }) => Promise<T>,
  directory = home,
): Promise<T> {
  const executable = path.join(home, 'configuration-fixture.mjs');
  const release = path.join(home, 'configuration-fixture.done');
  await writeFile(
    executable,
    `#!${process.execPath}
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('mcp')) {
  const listed = spawnSync('codex', process.argv.slice(2), { env: process.env, encoding: 'utf8' });
  process.stdout.write(listed.stdout ?? ''); process.stderr.write(listed.stderr ?? ''); process.exit(listed.status ?? 1);
}
readFileSync(0);
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(process.argv.slice(2))}})+'\\n');
while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');
`,
  );
  await chmod(executable, 0o755);
  let announce!: (args: readonly string[]) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<readonly string[]>((resolve, fail) => {
    announce = resolve;
    reject = fail;
  });
  const execution = createCodingRuntime({
    executable,
    environment: { CODEX_HOME: home, PATH: process.env['PATH']!, HOME: process.env['HOME']! },
  }).execute(
    {
      prompt: 'Configuration check.',
      model: 'unused',
      effort: null,
      toolSettings,
      directory,
      timeLimitMs: 30_000,
    },
    (activity) => {
      if (activity.type === 'message') announce(JSON.parse(activity.text) as readonly string[]);
    },
  );
  void execution.then((result) => {
    if (!result.ok) reject(new Error(result.fault.message));
  });
  try {
    const args = await ready;
    const profile = args[args.indexOf('--profile') + 1]!;
    const overrides = args.flatMap((arg, index) => (arg === '-c' ? [args[index + 1]!] : []));
    return await inspect({ profile, overrides });
  } finally {
    await writeFile(release, 'release');
    await execution;
    await Promise.all([rm(executable, { force: true }), rm(release, { force: true })]);
  }
}

/**
 * The installed native coding provider for the JEv access checks. These helpers start the real
 * `codex` process with the composed `--config` overrides and the controlled `CODEX_HOME`, so the
 * checks observe the provider's own MCP discovery, tool calls and configuration merging rather
 * than a template entry. No model turn, login or paid call is involved.
 */

/** Render one composed native setting as the `--config` value the provider parses as TOML. */
function tomlValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => tomlValue(item)).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, nested]) => `${key} = ${tomlValue(nested)}`,
    );
    return `{ ${entries.join(', ')} }`;
  }
  throw new Error(`The native setting cannot be expressed as TOML: ${String(value)}`);
}

/** The `--config` argument values of one composed native settings object. */
export function configArguments(config: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.entries(config).map(([key, value]) => `${key}=${tomlValue(value)}`);
}

/** A temporary provider home with a controlled base configuration. */
export async function codexHome(baseConfiguration = ''): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-home-'));
  await writeFile(path.join(directory, 'config.toml'), baseConfiguration, 'utf8');
  return directory;
}

/** One MCP server as the provider reports it through `codex mcp list --json`. */
export type ProviderMcpServer = {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: {
    readonly type: string;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>> | null;
    readonly env_vars?: readonly string[];
  };
};

/** The servers the provider resolves from the controlled home and the composed overrides. */
export async function providerMcpServers(
  codexHomeDirectory: string,
  overrides: readonly string[],
  profile?: string,
  directory?: string,
): Promise<readonly ProviderMcpServer[]> {
  const child = spawn(
    'codex',
    [
      ...(profile === undefined ? [] : ['--profile', profile]),
      'mcp',
      'list',
      '--json',
      ...configFlags(overrides),
    ],
    {
      env: { ...process.env, CODEX_HOME: codexHomeDirectory },
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) =>
    child.on('exit', (exitCode) => resolve(exitCode)),
  );
  if (code !== 0) {
    throw new Error(`codex mcp list exited with code ${String(code)}: ${stderr.trim()}`);
  }
  return JSON.parse(stdout) as readonly ProviderMcpServer[];
}

/** The `-c <value>` arguments of the composed native overrides. */
function configFlags(overrides: readonly string[]): readonly string[] {
  return overrides.flatMap((override) => ['-c', override]);
}

export type CodexAppServer = {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
  stderr(): string;
};

/**
 * Start the installed app server over stdio with the supplied composed overrides and environment.
 * The helper speaks the provider's own JSON-RPC framing and answers server-initiated requests with
 * an empty result, so no interactive approval is required.
 */
export async function startCodexAppServer(options: {
  readonly codexHomeDirectory: string;
  readonly overrides: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}): Promise<CodexAppServer> {
  const child = spawn('codex', ['app-server', ...configFlags(options.overrides)], {
    env: {
      ...process.env,
      CODEX_HOME: options.codexHomeDirectory,
      ...options.environment,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf('\n');
    while (end !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf('\n');
      if (line === '') {
        continue;
      }
      const message = JSON.parse(line) as {
        readonly id?: number;
        readonly method?: string;
        readonly params?: unknown;
        readonly result?: unknown;
        readonly error?: unknown;
      };
      if (message.method !== undefined) {
        if (message.id !== undefined) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
        }
        continue;
      }
      const waiting = message.id === undefined ? undefined : pending.get(message.id);
      if (waiting !== undefined) {
        pending.delete(message.id as number);
        waiting(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  const request = (method: string, params?: unknown): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The app server did not answer ${method}: ${stderr.trim()}`));
      }, 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error !== undefined) {
          reject(new Error(`The app server rejected ${method}: ${JSON.stringify(message.error)}`));
          return;
        }
        resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const exit = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await request('initialize', { clientInfo: { name: 'nexus-jev-check', version: '0.1.0' } });

  return {
    request,
    stderr: () => stderr,
    async close() {
      child.kill('SIGTERM');
      await exit;
    },
  };
}
