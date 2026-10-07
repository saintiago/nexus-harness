import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * A minimal MCP stdio client for the JEv integration checks: it launches an installed executable,
 * performs the protocol handshake, lists the advertised tools and calls one, so the checks exercise
 * the delivered server rather than a substitute. It speaks the same JSON-RPC framing MCP hosts use
 * and adds no MCP implementation to Nexus.
 */

/** One tool the server advertised. */
export type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
};

/** One tool call result as the server returned it. */
export type McpCallResult = {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
};

export type McpSession = {
  readonly tools: readonly McpTool[];
  call(name: string, args: unknown): Promise<McpCallResult>;
  stderr(): string;
  close(): Promise<void>;
};

type JsonRpcMessage = {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

/** Launch the executable and complete the MCP handshake over its standard streams. */
export async function openMcpSession(
  executable: string,
  options: { readonly environment?: Readonly<Record<string, string>>; readonly timeoutMs?: number },
): Promise<McpSession> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const child: ChildProcessWithoutNullStreams = spawn(executable, [], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...options.environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  let exited = false;
  const pending = new Map<
    number,
    {
      readonly resolve: (message: JsonRpcMessage) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
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
      const message = JSON.parse(line) as JsonRpcMessage;
      const waiting = message.id === undefined ? undefined : pending.get(message.id);
      if (waiting !== undefined) {
        pending.delete(message.id as number);
        clearTimeout(waiting.timer);
        waiting.resolve(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<{ readonly code: number | null }>((resolve) => {
    child.on('exit', (code) => {
      exited = true;
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(
          new Error(
            `The MCP server exited with code ${String(code)}: ${stderr.trim() || 'no diagnostics'}`,
          ),
        );
      }
      pending.clear();
      resolve({ code });
    });
  });

  const request = (method: string, params: unknown): Promise<JsonRpcMessage> =>
    new Promise<JsonRpcMessage>((resolve, reject) => {
      if (exited) {
        reject(
          new Error(`The MCP server exited before ${method}: ${stderr.trim() || 'no diagnostics'}`),
        );
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The MCP server did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const notify = (method: string): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  };

  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nexus-jev-check', version: '0.1.0' },
  });
  if (initialized.error !== undefined) {
    throw new Error(`The MCP server rejected initialization: ${initialized.error.message}`);
  }
  notify('notifications/initialized');
  const listed = await request('tools/list', {});
  if (listed.error !== undefined) {
    throw new Error(`The MCP server rejected tools/list: ${listed.error.message}`);
  }
  const tools = (listed.result as { readonly tools?: readonly McpTool[] }).tools ?? [];

  return {
    tools,
    async call(name, args) {
      const answer = await request('tools/call', { name, arguments: args });
      if (answer.error !== undefined) {
        throw new Error(
          `The MCP server rejected tools/call (${String(answer.error.code)}): ${answer.error.message}`,
        );
      }
      return answer.result as McpCallResult;
    },
    stderr: () => stderr,
    async close() {
      if (!exited) {
        child.kill('SIGTERM');
        await exit;
      }
    },
  };
}
