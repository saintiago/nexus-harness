import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A controlled TypeSafe provider for the JEv integration checks. The delivered package sends its
 * request to its fixed endpoint; the test routes that request here (a supplied fetch in-process or
 * the preload fixture in a child process) and this server records it and answers with the supplied
 * judgment or failure.
 */

/** One provider request the controlled server received. */
export type JevProviderRequest = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
};

export type ControlledJevProvider = {
  /** The origin the fixed endpoint is routed to. */
  readonly origin: string;
  readonly requests: JevProviderRequest[];
  /** Answer every subsequent request with a successful provider judgment. */
  succeed(body: unknown): void;
  /** Answer every subsequent request with an unsuccessful provider response. */
  fail(status: number, body: string): void;
  close(): Promise<void>;
};

async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Start one controlled provider on a loopback port with the supplied initial answer. */
export async function controlledJevProvider(): Promise<ControlledJevProvider> {
  const requests: JevProviderRequest[] = [];
  let answer: { readonly status: number; readonly body: string } = { status: 200, body: '{}' };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body: await bodyText(request),
      });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(answer.body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    succeed(body) {
      answer = { status: 200, body: JSON.stringify(body) };
    },
    fail(status, body) {
      answer = { status, body };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
