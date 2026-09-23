/**
 * Component tests: the real Notifications adapter drives controlled SNS provider responses over a
 * local HTTP endpoint, establishing the request it makes, the complete subject and body it
 * transmits, its reporting of provider limits and failures and the acceptance identity it returns.
 * No live AWS access, credentials or email delivery is involved.
 */

import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createNotificationsAdapter } from '../src/adapters/notifications.js';
import type {
  NotificationAcceptance,
  NotificationSettings,
  SnsCredentials,
} from '../src/adapters/notifications.js';
import type { Result } from '../src/result.js';

const region = 'eu-west-1';
const topicArn = `arn:aws:sns:${region}:123456789012:nexus-recovery`;
const credentials: SnsCredentials = {
  accessKeyId: 'controlled-access-key',
  secretAccessKey: 'controlled-secret-key',
};

/** One controlled provider answer: a response, or a dropped connection. */
type ProviderAnswer = { readonly status: number; readonly body: string } | 'drop';

/** One request the controlled provider received. */
type ProviderRequest = {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly body: string;
};

/** The provider's answer for one accepted message. */
function accepted(messageId: string): ProviderAnswer {
  return {
    status: 200,
    body:
      '<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">' +
      `<PublishResult><MessageId>${messageId}</MessageId></PublishResult>` +
      '<ResponseMetadata><RequestId>controlled-request-1</RequestId></ResponseMetadata>' +
      '</PublishResponse>',
  };
}

/** The provider's answer for one rejected request. */
function rejected(status: number, code: string, message: string): ProviderAnswer {
  return {
    status,
    body:
      '<ErrorResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">' +
      `<Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error>` +
      '<RequestId>controlled-request-1</RequestId>' +
      '</ErrorResponse>',
  };
}

/**
 * Start a controlled provider answering the supplied answers in order and recording every
 * request. A request beyond the supplied answers is answered with a provider failure, so an
 * unexpected extra attempt is also visible in the recorded request count.
 */
async function startProvider(answers: readonly ProviderAnswer[]): Promise<{
  readonly endpoint: string;
  readonly requests: ProviderRequest[];
  stop(): Promise<void>;
}> {
  const requests: ProviderRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const answer =
        answers[requests.length - 1] ?? rejected(500, 'InternalError', 'Unscripted request');
      if (answer === 'drop') {
        request.socket.destroy();
        return;
      }
      response.writeHead(answer.status, { 'content-type': 'text/xml' });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The controlled provider did not expose an address');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

/** The settings of an adapter publishing to the controlled provider. */
function settingsOver(
  endpoint: string,
  supplied: SnsCredentials = credentials,
): NotificationSettings {
  return { connection: { region, endpoint }, credentials: supplied, destination: topicArn };
}

/** One received request's form-encoded body. */
function formOf(request: ProviderRequest | undefined): URLSearchParams {
  return new URLSearchParams(request?.body ?? '');
}

/** The message of one faulted result, failing the test when the publication was accepted. */
function faultOf(result: Result<NotificationAcceptance>): string {
  if (result.ok) {
    throw new Error('Expected the publication to fail');
  }
  return result.fault.message;
}

describe('Notifications adapter', () => {
  it('publishes the complete subject and body to the configured destination', async () => {
    const subject = 'Recovery report: queue execution needs attention';
    const body = 'Recovery stopped before the retained workspace was cleared.';
    const provider = await startProvider([accepted('message-identity-1')]);
    try {
      const adapter = createNotificationsAdapter(settingsOver(provider.endpoint));
      const result = await adapter.publish(subject, body);

      expect(result).toEqual({ ok: true, value: { messageId: 'message-identity-1' } });
      expect(provider.requests).toHaveLength(1);
      const request = provider.requests[0];
      expect(request?.method).toBe('POST');
      const form = formOf(request);
      expect(form.get('Action')).toBe('Publish');
      expect(form.get('TopicArn')).toBe(topicArn);
      expect(form.get('Subject')).toBe(subject);
      expect(form.get('Message')).toBe(body);
    } finally {
      await provider.stop();
    }
  });

  it('transmits a body beyond the provider default size limit whole', async () => {
    const body = `${'x'.repeat(300_000)}ñ${'y'.repeat(1_000)}`;
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(262_144);
    const provider = await startProvider([accepted('message-identity-2')]);
    try {
      const adapter = createNotificationsAdapter(settingsOver(provider.endpoint));
      const result = await adapter.publish('Large report', body);

      expect(result).toEqual({ ok: true, value: { messageId: 'message-identity-2' } });
      expect(formOf(provider.requests[0]).get('Message')).toBe(body);
    } finally {
      await provider.stop();
    }
  });

  it('signs one request for the configured Region, credentials and session token', async () => {
    const provider = await startProvider([accepted('message-identity-3')]);
    try {
      const adapter = createNotificationsAdapter(
        settingsOver(provider.endpoint, { ...credentials, sessionToken: 'controlled-session' }),
      );
      await adapter.publish('Subject', 'Body');

      expect(provider.requests).toHaveLength(1);
      const headers = provider.requests[0]?.headers ?? {};
      expect(headers['x-amz-security-token']).toBe('controlled-session');
      const authorization = String(headers['authorization']);
      expect(authorization).toContain(`Credential=${credentials.accessKeyId}/`);
      expect(authorization).toContain(`/${region}/sns/aws4_request`);
    } finally {
      await provider.stop();
    }
  });

  it("reports the provider's subject limit rejection without truncating the content", async () => {
    const subject = 's'.repeat(150);
    const provider = await startProvider([
      rejected(400, 'InvalidParameterValue', 'Invalid parameter: Subject'),
    ]);
    try {
      const adapter = createNotificationsAdapter(settingsOver(provider.endpoint));
      const result = await adapter.publish(subject, 'Body');

      const message = faultOf(result);
      expect(message).toContain('InvalidParameterValue');
      expect(message).toContain('HTTP 400');
      expect(message).toContain('Invalid parameter: Subject');
      expect(formOf(provider.requests[0]).get('Subject')).toBe(subject);
    } finally {
      await provider.stop();
    }
  });

  it('reports a provider failure without attempting the publication again', async () => {
    const provider = await startProvider([
      rejected(500, 'InternalError', 'Unknown'),
      accepted('message-identity-4'),
    ]);
    try {
      const adapter = createNotificationsAdapter(settingsOver(provider.endpoint));
      const result = await adapter.publish('Subject', 'Body');

      const message = faultOf(result);
      expect(message).toContain('InternalErrorException');
      expect(message).toContain('HTTP 500');
      expect(message).not.toContain(credentials.secretAccessKey);
      expect(provider.requests).toHaveLength(1);
    } finally {
      await provider.stop();
    }
  });

  it('reports an unreachable provider', async () => {
    const provider = await startProvider(['drop']);
    try {
      const adapter = createNotificationsAdapter(settingsOver(provider.endpoint));
      const result = await adapter.publish('Subject', 'Body');

      expect(faultOf(result)).toMatch(/^The SNS publication failed: \S/);
      expect(provider.requests).toHaveLength(1);
    } finally {
      await provider.stop();
    }
  });

  it('reports an acceptance without a message identity', async () => {
    const provider = await startProvider([
      {
        status: 200,
        body:
          '<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">' +
          '<PublishResult></PublishResult>' +
          '</PublishResponse>',
      },
    ]);
    try {
      const adapter = createNotificationsAdapter(settingsOver(provider.endpoint));
      const result = await adapter.publish('Subject', 'Body');

      expect(faultOf(result)).toContain('without returning a message identity');
    } finally {
      await provider.stop();
    }
  });
});
