import { createServer } from 'node:http';
import { once } from 'node:events';

/**
 * A loopback-only Responses fixture drives real `codex exec` without a paid model or credentials.
 * Its first response calls the discovered JEv function when requested, then completes the turn.
 */
export async function controlledCodexModel(jevRequest: unknown | null): Promise<{
  readonly origin: string;
  readonly requests: Record<string, unknown>[];
  close(): Promise<void>;
}> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/responses') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push(body);
    const call = requests.length === 1 && jevRequest !== null;
    const item = call
      ? {
          type: 'function_call',
          id: 'fc_synthetic',
          call_id: 'call_synthetic',
          name: 'ask_jev',
          namespace:
            (body['tools'] as { type: string; name: string; tools?: { name: string }[] }[]).find(
              (tool) => tool.tools?.some((nested) => nested.name === 'ask_jev'),
            )?.name ?? 'missing_jev',
          arguments: JSON.stringify(jevRequest),
        }
      : {
          type: 'message',
          id: 'msg_synthetic',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'synthetic completed', annotations: [] }],
        };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type: string, fields: Record<string, unknown>) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit('response.created', { response: { id: `resp_${requests.length}` } });
    emit('response.output_item.added', { output_index: 0, item });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', {
      response: {
        id: `resp_${requests.length}`,
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No model fixture address');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
