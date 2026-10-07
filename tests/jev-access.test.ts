/**
 * Focused integration checks for the delivered, pinned JEv dependency: the committed package
 * installs its `jev-mcp` executable, the installed stdio server discovers and calls the judgment
 * against a controlled provider response, and its host-enabled usage logging appends one local
 * JSONL record per evaluation without changing ordinary results. Provider responses are supplied,
 * so no live TypeSafe call, credential or sibling checkout is involved.
 */

import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { JevRequest } from '@saintiago/jev';
import { jevExecutablePath } from '../src/application/jev.js';
import { controlledJevProvider, type ControlledJevProvider } from './support/jev-provider.js';
import { openMcpSession } from './support/mcp-stdio.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/jev-provider-preload.mjs', import.meta.url));
const syntheticKey = 'synthetic-jev-host-key';
const syntheticState = 'Synthetic support note: payouts have been failing for three days.';

/** The provider judgment the controlled TypeSafe endpoint returns. */
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

/** One synthetic judgment request sharing one state, as an agent would submit it. */
const syntheticRequest: JevRequest = {
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
const temporaryDirectories: string[] = [];

async function provider(): Promise<ControlledJevProvider> {
  const controlled = await controlledJevProvider();
  providers.push(controlled);
  return controlled;
}

/** One empty temporary directory for host-selected usage-log destinations. */
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-jev-usage-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((controlled) => controlled.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('delivered JEv dependency', () => {
  it('installs the jev-mcp executable inside this installation', async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'node_modules', '@saintiago', 'jev', 'package.json'),
        'utf8',
      ),
    ) as { readonly name: string; readonly version: string; readonly bin: Record<string, string> };

    expect(manifest.name).toBe('@saintiago/jev');
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.bin['jev-mcp']).toBe('./dist/mcp.js');

    const executable = jevExecutablePath();
    expect(path.isAbsolute(executable)).toBe(true);
    expect(executable.startsWith(repositoryRoot)).toBe(true);
    await expect(access(executable, constants.X_OK)).resolves.toBeUndefined();
  });
});

describe('installed jev-mcp executable', () => {
  it('discovers ask_jev and returns the structured judgment over stdio', async () => {
    const controlled = await provider();
    controlled.succeed(syntheticJudgment);

    const session = await openMcpSession(jevExecutablePath(), {
      environment: {
        JEV_API_KEY: syntheticKey,
        JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
        NODE_OPTIONS: `--import=${preload}`,
      },
    });
    try {
      expect(session.tools.map((tool) => tool.name)).toEqual(['ask_jev']);
      expect(session.tools[0]!.description).toContain('TypeSafe JEv');

      const result = await session.call('ask_jev', syntheticRequest);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(syntheticJudgment);
      const text = result.content.map((part) => part.text ?? '').join('\n');
      expect(JSON.parse(text)).toEqual(syntheticJudgment);
    } finally {
      await session.close();
    }
  });

  it('appends one usage record per evaluation when the host enables logging', async () => {
    const controlled = await provider();
    controlled.succeed(syntheticJudgment);
    const logPath = path.join(await temporaryDirectory(), 'usage.jsonl');

    const session = await openMcpSession(jevExecutablePath(), {
      environment: {
        JEV_API_KEY: syntheticKey,
        JEV_USAGE_LOG_PATH: logPath,
        JEV_USAGE_LOG_CALLER: 'nexus-check',
        JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
        NODE_OPTIONS: `--import=${preload}`,
      },
    });
    try {
      const result = await session.call('ask_jev', syntheticRequest);
      expect(result.isError).toBeFalsy();

      const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(record).toMatchObject({
        model: 'jev-1.13.0',
        caller: 'nexus-check',
        questions: { reply_choice: { type: 'choice' } },
        answers: syntheticJudgment.answers,
        usage: syntheticJudgment.usage,
      });
      expect(record['timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record['durationMs']).toBeGreaterThanOrEqual(0);
      // Supplied evidence and the host key never enter the log.
      expect(JSON.stringify(record)).not.toContain(syntheticState);
      expect(JSON.stringify(record)).not.toContain(syntheticKey);
    } finally {
      await session.close();
    }
  });

  it('records a failure category without answers when logging is enabled', async () => {
    const controlled = await provider();
    controlled.fail(429, '{"error":"rate limited"}');
    const logPath = path.join(await temporaryDirectory(), 'usage.jsonl');

    const session = await openMcpSession(jevExecutablePath(), {
      environment: {
        JEV_API_KEY: syntheticKey,
        JEV_USAGE_LOG_PATH: logPath,
        JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
        NODE_OPTIONS: `--import=${preload}`,
      },
    });
    try {
      const result = await session.call('ask_jev', syntheticRequest);
      expect(result.isError).toBe(true);

      const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(record).toMatchObject({
        model: 'jev-1.13.0',
        errorCode: 'rate_limited',
        questions: { reply_choice: { type: 'choice' } },
      });
      expect(record['answers']).toBeUndefined();
      expect(record['caller']).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('writes no usage file when the host sets no logging path', async () => {
    const controlled = await provider();
    controlled.succeed(syntheticJudgment);
    const directory = await temporaryDirectory();

    const session = await openMcpSession(jevExecutablePath(), {
      environment: {
        JEV_API_KEY: syntheticKey,
        JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
        NODE_OPTIONS: `--import=${preload}`,
      },
    });
    try {
      const result = await session.call('ask_jev', syntheticRequest);
      expect(result.isError).toBeFalsy();
      await expect(readdir(directory)).resolves.toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('keeps a successful evaluation when the log destination is unwritable', async () => {
    const controlled = await provider();
    controlled.succeed(syntheticJudgment);
    const destination = path.join(await temporaryDirectory(), 'missing', 'usage.jsonl');

    const session = await openMcpSession(jevExecutablePath(), {
      environment: {
        JEV_API_KEY: syntheticKey,
        JEV_USAGE_LOG_PATH: destination,
        JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
        NODE_OPTIONS: `--import=${preload}`,
      },
    });
    try {
      const result = await session.call('ask_jev', syntheticRequest);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(syntheticJudgment);
    } finally {
      await session.close();
    }
  });

  it('reports a provider failure as a safe tool error without exposing the key', async () => {
    const controlled = await provider();
    controlled.fail(429, '{"error":"rate limited"}');

    const session = await openMcpSession(jevExecutablePath(), {
      environment: {
        JEV_API_KEY: syntheticKey,
        JEV_TEST_PROVIDER_ORIGIN: controlled.origin,
        NODE_OPTIONS: `--import=${preload}`,
      },
    });
    try {
      const result = await session.call('ask_jev', syntheticRequest);

      expect(result.isError).toBe(true);
      const text = result.content.map((part) => part.text ?? '').join('\n');
      expect(text).toContain('rate_limited');
      expect(text).not.toContain(syntheticKey);
      expect(text).not.toContain(syntheticState);
      expect(text).not.toContain('rate limited');
      expect(session.stderr()).not.toContain(syntheticKey);
    } finally {
      await session.close();
    }
  });

  it('fails startup clearly when the host key is missing', async () => {
    const failure = await openMcpSession(jevExecutablePath(), { environment: {} }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('JEV_API_KEY is required');
  });
});
