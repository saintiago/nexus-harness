import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { Result } from '../result.js';

/**
 * The Notifications adapter publishes an explicitly supplied notification through the configured
 * provider and returns the provider's publication result. It owns the provider connection,
 * credentials, protocol details and provider error reporting. The initial provider is Amazon SNS.
 * The caller owns the report content, persistence and decisions about further notification
 * attempts; provider acceptance is not confirmation of inbox delivery.
 *
 * Each publish call makes one provider request with the complete subject and body. The provider
 * validates its own limits, including the subject length and the topic's maximum message size, and
 * a rejection is reported as a fault carrying the provider's own error.
 */

/** Render a thrown value as a message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ok<Value>(value: Value): Result<Value> {
  return { ok: true, value };
}

function fault(message: string): Result<never> {
  return { ok: false, fault: { message } };
}

/** The SNS provider connection: the AWS Region that owns the destination topic. */
export type SnsConnection = {
  readonly region: string;
  /**
   * Overrides the provider endpoint, for a private or otherwise controlled endpoint. Unset uses
   * the provider's endpoint for the Region.
   */
  readonly endpoint?: string;
};

/** The host-resolved AWS credentials SNS requests are signed with. */
export type SnsCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The session token, for temporary credentials. */
  readonly sessionToken?: string;
};

/** Construction settings: the provider connection, credentials and destination. */
export type NotificationSettings = {
  readonly connection: SnsConnection;
  readonly credentials: SnsCredentials;
  /** The SNS topic ARN the notification is published to. */
  readonly destination: string;
};

/**
 * The provider's publication result: the identity it assigned to the message it accepted.
 * Acceptance is not confirmation of inbox delivery.
 */
export type NotificationAcceptance = {
  readonly messageId: string;
};

/** The Notifications adapter's operations. */
export type NotificationsAdapter = {
  publish(subject: string, body: string): Promise<Result<NotificationAcceptance>>;
};

/** The response metadata the SDK attaches to a provider error. */
type ProviderResponseMetadata = {
  readonly httpStatusCode?: number;
};

/**
 * The failure detail for one attempted publication: the provider's status and error code for a
 * provider response, or the transport, configuration or signing failure otherwise. Credentials
 * and message content never appear in the detail.
 */
function providerFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = messageOf(error);
  const status = (error as { readonly $metadata?: ProviderResponseMetadata } | null)?.$metadata
    ?.httpStatusCode;
  if (status === undefined) {
    return `The SNS publication failed: ${message}`;
  }
  const detail = message === '' || message === name ? '' : `: ${message}`;
  return `The SNS publication failed: ${name} (HTTP ${status})${detail}`;
}

/**
 * Create the Notifications adapter over the supplied provider connection, credentials and
 * destination. Each call publishes one message and releases the provider client it used.
 */
export function createNotificationsAdapter(settings: NotificationSettings): NotificationsAdapter {
  return {
    async publish(subject, body) {
      const client = new SNSClient({
        region: settings.connection.region,
        ...(settings.connection.endpoint === undefined
          ? {}
          : { endpoint: settings.connection.endpoint }),
        credentials: settings.credentials,
        // One request per publish call: a failed request does not prove that the provider stored
        // no message, so the caller decides whether to attempt the publication again.
        maxAttempts: 1,
      });
      try {
        const response = await client.send(
          new PublishCommand({
            TopicArn: settings.destination,
            Subject: subject,
            Message: body,
          }),
        );
        if (response.MessageId === undefined) {
          return fault(
            'The SNS provider accepted the publication without returning a message identity',
          );
        }
        return ok({ messageId: response.MessageId });
      } catch (error) {
        return fault(providerFailure(error));
      } finally {
        client.destroy();
      }
    },
  };
}
