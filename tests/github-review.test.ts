/**
 * The GitHub review adapter, against real HTTP answers from a stand-in service
 * on this host's loopback.
 *
 * The adapter is the boundary that holds the App's private key: what leaves this
 * machine is a short-lived RS256 installation assertion signed with that key, and
 * then the installation token GitHub issues for it. This suite proves that with a
 * real key pair: the stand-in service verifies the assertion's signature with the
 * public half, and every later read carries the issued token and the API version
 * the connector asks for. A refused answer is classified for the scan, and never
 * repeats the key or the token.
 */
import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubReviewConfig } from '../src/shared/types.js';
import { ReviewError } from '../src/reviews/contract.js';
import { GITHUB_API_VERSION, createGitHubReviewClient } from '../src/reviews/github.js';
import { startLocalService } from './integration-support.js';
import type { LocalService, ReceivedRequest } from './integration-support.js';

/** The App this case's service account stands in for. */
const CONFIG: GitHubReviewConfig = {
  type: 'github',
  repository: 'example/target',
  app: {
    appId: 42,
    installationId: 7,
    privateKeyPathEnv: 'NEXUS_REVIEW_KEY',
    login: 'nexus-lens[bot]',
  },
  reviewer: { runtime: 'codex', command: ['codex'] },
  checkName: 'Nexus Lens',
};

/** The moment the case's clock starts at, and the token it is answered with. */
const START = new Date('2026-03-01T00:00:00.000Z');
const INSTALLATION_TOKEN = 'ghs-installation-token-that-must-not-leak';
/** When the issued installation token stops being usable. */
const EXPIRES_AT = new Date(START.getTime() + 3_600_000).toISOString();

/** An RSA key pair this case makes for itself: no machine key is ever used. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** The services a case started, closed when the case ends. */
const started: LocalService[] = [];

afterEach(async () => {
  const services = started.splice(0);
  await Promise.all(services.map((service) => service.close()));
});

/** Starts one stand-in service and one client that reaches it. */
async function reviewing(
  answer: (
    request: ReceivedRequest,
    index: number,
  ) => {
    readonly status: number;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
  options: { readonly clock?: { readonly at: Date } } = {},
): Promise<{
  readonly service: LocalService;
  readonly client: ReturnType<typeof createGitHubReviewClient>;
  readonly clock: { at: Date };
}> {
  const service = await startLocalService(answer);
  started.push(service);
  const clock = options.clock ?? { at: new Date(START) };
  return {
    service,
    clock,
    client: createGitHubReviewClient(CONFIG, privateKey, {
      apiBaseUrl: service.origin,
      now: () => new Date(clock.at),
    }),
  };
}

/** The error a call that was expected to fail rejected with. */
async function failureOf(work: () => Promise<unknown>): Promise<ReviewError> {
  try {
    await work();
  } catch (cause) {
    if (!(cause instanceof ReviewError)) {
      throw new Error(`the call failed with something else: ${String(cause)}`, { cause });
    }
    return cause;
  }
  throw new Error('the call was expected to fail, and it did not');
}

/** True when `jwt` is an RS256 assertion this case's key pair signed. */
function signedByThisApp(jwt: string, appId: number, at: Date): boolean {
  const [header, payload, signature] = jwt.split('.');
  if (header === undefined || payload === undefined || signature === undefined) {
    return false;
  }
  const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const iss = (claims as { iss?: unknown }).iss;
  const exp = (claims as { exp?: unknown }).exp;
  if (iss !== appId || typeof exp !== 'number') {
    return false;
  }
  if (exp < Math.floor(at.getTime() / 1000)) {
    return false;
  }
  return verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
}

describe('the App’s way in', () => {
  it('signs in with an assertion this case’s key really signed, then reads with the issued token', async () => {
    const { client, service, clock } = await reviewing((request) =>
      request.url.endsWith('/access_tokens')
        ? {
            status: 201,
            body: JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: EXPIRES_AT }),
          }
        : { status: 404, body: '{"message":"Not Found"}' },
    );

    const pull = await client.readPullRequest(7, new AbortController().signal);

    expect(pull).toBeNull();
    expect(service.requests).toHaveLength(2);
    const [signIn, read] = service.requests;
    // The App's assertion goes to the installation endpoint, and it is a real
    // signature: the private key itself never leaves this machine.
    expect(signIn?.method).toBe('POST');
    expect(signIn?.url).toBe('/app/installations/7/access_tokens');
    const assertion = String(signIn?.headers.authorization ?? '').replace(/^Bearer /, '');
    expect(signedByThisApp(assertion, CONFIG.app.appId, clock.at)).toBe(true);
    expect(signIn?.body).toContain('"pull_requests":"write"');

    // The read carries the token GitHub issued, and the API version the
    // connector asks for.
    expect(read?.method).toBe('GET');
    expect(read?.url).toBe('/repos/example/target/pulls/7');
    expect(read?.headers.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(read?.headers['x-github-api-version']).toBe(GITHUB_API_VERSION);
    expect(read?.headers.accept).toBe('application/vnd.github+json');
  }, 60_000);

  it('reuses one installation token while it is valid, and renews it when it is close to expiring', async () => {
    let issued = 0;
    const { client, service, clock } = await reviewing(() => {
      issued += 1;
      return {
        status: 201,
        body: JSON.stringify({
          token: `${INSTALLATION_TOKEN}-${String(issued)}`,
          expires_at: EXPIRES_AT,
        }),
      };
    });
    const signal = new AbortController().signal;

    const first = await client.installationToken(signal);
    const second = await client.installationToken(signal);
    expect(first).toBe(`${INSTALLATION_TOKEN}-1`);
    expect(second).toBe(first);
    expect(service.requests).toHaveLength(1);

    // An hour later the token is expiring, so a fresh one is asked for.
    clock.at = new Date(clock.at.getTime() + 3_600_000);
    const third = await client.installationToken(signal);

    expect(third).toBe(`${INSTALLATION_TOKEN}-2`);
    expect(service.requests).toHaveLength(2);
  }, 60_000);
});

describe('what a refused answer is classified as', () => {
  it('is an authentication failure for a read, and never repeats the token it holds', async () => {
    const { client } = await reviewing((request) =>
      request.url.endsWith('/access_tokens')
        ? {
            status: 201,
            body: JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: EXPIRES_AT }),
          }
        : {
            status: 401,
            body: `Authorization: Bearer ${INSTALLATION_TOKEN}\n${INSTALLATION_TOKEN} is not accepted`,
          },
    );

    const error = await failureOf(() => client.readPullRequest(7, new AbortController().signal));

    expect(error.kind).toBe('auth');
    expect(error.message).toContain('answered HTTP 401');
    expect(error.message).toContain('check the App ID, the installation ID, the private key');
    expect(error.message).not.toContain(INSTALLATION_TOKEN);
    expect(error.message).toContain('[redacted]');
  }, 60_000);

  it('never repeats the assertion it signed, even when the answer echoes it', async () => {
    const { client } = await reviewing((request) => ({
      status: 403,
      body: `refused the request from ${String(request.headers.authorization ?? '')}`,
    }));

    const error = await failureOf(() => client.installationToken(new AbortController().signal));

    expect(error.kind).toBe('auth');
    expect(error.message).toContain('Bearer [redacted]');
    expect(error.message).not.toContain('eyJ');
  }, 60_000);

  it('refuses a redirect instead of following the App’s token to another host', async () => {
    const { client, service } = await reviewing(() => ({
      status: 302,
      headers: { Location: 'http://127.0.0.1:1/elsewhere' },
    }));

    const error = await failureOf(() => client.installationToken(new AbortController().signal));

    expect(error.kind).toBe('api');
    expect(error.message).toContain('did not complete');
    // The redirect was refused, not followed: nothing was sent anywhere else.
    expect(service.requests).toHaveLength(1);
  }, 60_000);

  it('reports a stopped read as a stop, not as a statement about the repository', async () => {
    const { client, service } = await reviewing(() => ({ status: 200, body: '[]' }));
    const controller = new AbortController();
    controller.abort();

    const error = await failureOf(() => client.readPullRequest(7, controller.signal));

    expect(error.kind).toBe('fatal');
    expect(error.message).toContain('was stopped by the caller before it answered');
    expect(service.requests).toHaveLength(0);
  }, 60_000);
});
