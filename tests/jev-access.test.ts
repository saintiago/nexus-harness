/**
 * Focused integration checks for the delivered, pinned JEv dependency: the committed package
 * installs its public root export and its `jev-mcp` executable, the constructed capability returns
 * the package's structured judgment from a controlled provider response, and the installed stdio
 * server discovers and calls the same judgment. The provider response is supplied, so no live
 * TypeSafe call, credential or sibling checkout is involved.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JevError, createJevClient, type JevRequest } from '@saintiago/jev';
import {
  createJevCapability,
  jevExecutablePath,
  type JevCapability,
} from '../src/application/jev.js';
import { parseNexusConfiguration } from '../src/configuration/index.js';
import { nexusConfiguration } from './support/configuration.js';
import { controlledJevProvider, type ControlledJevProvider } from './support/jev-provider.js';
import { openMcpSession } from './support/mcp-stdio.js';

const installationDirectory = '/srv/nexus/installation';
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/jev-provider-preload.mjs', import.meta.url));
const syntheticKey = 'synthetic-jev-host-key';
const syntheticState =
  'Synthetic stage note: the requested change has no reporting-terminal scope.';

/** The provider judgment the controlled TypeSafe endpoint returns. */
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
const syntheticRequest: JevRequest = {
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

async function provider(): Promise<ControlledJevProvider> {
  const controlled = await controlledJevProvider();
  providers.push(controlled);
  return controlled;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(providers.splice(0).map((controlled) => controlled.close()));
});

/** The parsed configuration with the JEv integration enabled and its host credential referenced. */
function enabledConfiguration() {
  const configured = nexusConfiguration();
  configured.jev = { enabled: true, credential: 'jevApiKey' };
  return parseNexusConfiguration(configured, installationDirectory);
}

/** The constructed capability, failing the check when the integration is unexpectedly absent. */
function capabilityOf(environment: Readonly<Record<string, string | undefined>>): JevCapability {
  const capability = createJevCapability(enabledConfiguration(), environment);
  if (capability === null) {
    throw new Error('the JEv capability is absent although the integration is enabled');
  }
  return capability;
}

/** Route the package's fixed provider endpoint to the controlled origin for this process. */
function routeFetchTo(origin: string): void {
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const destination = new URL(
      typeof input === 'string' || input instanceof URL
        ? String(input)
        : (input as { readonly url: string }).url,
    );
    if (
      destination.origin !== 'https://api.typesafe.ai' ||
      destination.pathname !== '/v1/systemone'
    ) {
      throw new Error(`unexpected fetch destination ${destination.href}`);
    }
    return nativeFetch(new URL(destination.pathname, origin), init);
  });
}

describe('delivered JEv dependency', () => {
  it('installs the public root export and the executable inside this installation', async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(repositoryRoot, 'node_modules', '@saintiago', 'jev', 'package.json'),
        'utf8',
      ),
    ) as { readonly name: string; readonly version: string; readonly bin: Record<string, string> };

    expect(manifest.name).toBe('@saintiago/jev');
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.bin['jev-mcp']).toBe('./dist/mcp.js');
    expect(typeof createJevClient).toBe('function');
    expect(new JevError('unavailable').code).toBe('unavailable');

    const executable = jevExecutablePath();
    expect(path.isAbsolute(executable)).toBe(true);
    expect(executable.startsWith(repositoryRoot)).toBe(true);
    await expect(access(executable, constants.X_OK)).resolves.toBeUndefined();
  });

  it('returns the provider judgment through the constructed capability', async () => {
    const controlled = await provider();
    controlled.succeed(syntheticJudgment);
    routeFetchTo(controlled.origin);

    const capability = capabilityOf({ JEV_API_KEY: syntheticKey });
    if (capability.kind !== 'available') {
      throw new Error(`the enabled integration reported ${capability.kind}`);
    }
    const result = await capability.client.evaluate(syntheticRequest);

    expect(result).toEqual(syntheticJudgment);
    expect(controlled.requests).toHaveLength(1);
    expect(controlled.requests[0]!.method).toBe('POST');
    expect(controlled.requests[0]!.path).toBe('/v1/systemone');
    expect(controlled.requests[0]!.authorization).toBe(`Bearer ${syntheticKey}`);
    expect(JSON.parse(controlled.requests[0]!.body)).toMatchObject({
      model: 'jev-1.13.0',
      state: syntheticState,
      questions: { stage_applicability: { type: 'choice' } },
    });
  });

  it('reports a controlled provider failure as a safe package error', async () => {
    const controlled = await provider();
    controlled.fail(429, '{"error":"rate limited"}');
    routeFetchTo(controlled.origin);

    const capability = capabilityOf({ JEV_API_KEY: syntheticKey });
    if (capability.kind !== 'available') {
      throw new Error(`the enabled integration reported ${capability.kind}`);
    }
    const failure = await capability.client
      .evaluate(syntheticRequest)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JevError);
    const error = failure as JevError;
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.message).not.toContain(syntheticKey);
    expect(error.message).not.toContain(syntheticState);
    expect(error.message).not.toContain('rate limited');
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
