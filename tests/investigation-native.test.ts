import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createAgentRuntimeSettings } from '../src/application/composition.js';
import { createAgentRuntime } from '../src/agent-runtime/index.js';
import { createCodingRuntime } from '../src/adapters/coding-runtime.js';
import { nexusConfiguration } from './support/configuration.js';

const installed = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;
type Input = {
  type?: string;
  output?: unknown;
  tools?: { name?: string; tools?: { name?: string }[] }[];
};
type Request = {
  input: Input[];
  tools?: { name?: string; type?: string; tools?: { name?: string }[] }[];
};
describe.skipIf(!installed)('effective native investigation restrictions', () => {
  it.each(['healthy', 'failed'] as const)(
    '%s',
    async (scenario) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-managed-native-'));
      const home = path.join(root, 'home');
      const worktree = path.join(root, 'worktree');
      const requests: Request[] = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        if (!body) {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
          return;
        }
        requests.push(JSON.parse(body) as Request);
        const message = {
          id: 'msg_probe',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'Source investigation complete.', annotations: [] },
          ],
        };
        const item = message;
        const response = {
          id: 'resp_probe',
          object: 'response',
          status: 'completed',
          model: 'gpt-6-astra',
          output: [item],
          usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
        };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
          {
            type: 'response.created',
            response: { ...response, status: 'in_progress', output: [] },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...message, status: 'in_progress', content: [] },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'msg_probe',
            output_index: 0,
            content_index: 0,
            delta: message.content[0]!.text,
          },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ])
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await mkdir(home);
        await mkdir(worktree);
        execFileSync('git', ['init', '-q'], { cwd: worktree });
        await writeFile(path.join(worktree, 'camera.ts'), 'PRIVATE_SOURCE_MARKER');
        const port = (server.address() as { port: number }).port;
        await writeFile(
          path.join(home, 'config.toml'),
          `model_provider = "probe"\n[mcp_servers.other]\ncommand = "/missing/other"\nenabled = true\n[model_providers.probe]\nname = "Probe"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
        );
        await writeFile(
          path.join(home, 'nexus-astra.config.toml'),
          'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n',
        );
        const environment = {
          PATH: process.env.PATH!,
          HOME: home,
          CODEX_HOME: home,
          JEV_API_KEY: 'synthetic-key',
          ...(scenario === 'failed' ? { JEV_RETRIEVAL_LOG_PATH: ' ' } : {}),
        };
        const config = nexusConfiguration();
        config.jev = { enabled: true, credential: 'jevApiKey' };
        const settings = createAgentRuntimeSettings(
          config,
          'developer',
          createCodingRuntime({ executable: 'codex', environment }),
          environment,
        );
        const result = await createAgentRuntime(settings).run(
          'nexus-astra',
          { root },
          'Answer using repository evidence.',
          () => {},
          undefined,
          'investigation',
        );
        expect(result).toMatchObject({
          ok: false,
          fault: { message: expect.stringContaining('cannot enforce disabled collaboration') },
        });
        expect(requests).toHaveLength(0);
        // Separately exercise native required MCP startup without claiming the
        // unsupported managed capability. This control never accesses collaboration.
        if (scenario === 'failed' || scenario === 'healthy') {
          for (const profile of settings.investigation!.profiles)
            delete (profile.toolSettings as Record<string, unknown>)['managedInvestigation'];
          const control = await createAgentRuntime(settings).run(
            'nexus-astra',
            { root },
            'Answer.',
            () => {},
            undefined,
            'investigation',
          );
          if (scenario === 'failed') {
            expect(control.ok).toBe(false);
            expect(requests).toHaveLength(0);
          } else {
            expect(control.ok).toBe(true);
            expect(requests).toHaveLength(1);
          }
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    15000,
  );
});
