import { z } from 'zod';

/**
 * The Memory model transport: an OpenAI-compatible chat-completions client satisfying the
 * standalone package's LanguageModel contract. The host supplies the full request URL, the
 * provider model ID, the optional credential, the output bound and the timeout; no agent profile,
 * its reasoning effort or its settings take part. Generation requests no reasoning or thinking
 * mode: the request body carries no reasoning/thinking parameter, and the timeout and output bound
 * make one bounded attempt with no implicit retry. Failures reject with a diagnostic the provider
 * credential is redacted from, instead of being transformed into an empty success.
 */

/** Whether the credential can be sent unchanged as an `authorization` header. */
function isBearerHeaderValue(apiKey: string): boolean {
  try {
    const authorization = `Bearer ${apiKey}`;
    const headers = new Headers({ authorization });
    return headers.get('authorization') === authorization;
  } catch {
    return false;
  }
}

const optionsSchema = z.strictObject({
  endpoint: z
    .string()
    .min(1)
    .refine((endpoint) => URL.canParse(endpoint), 'A model endpoint must be a valid URL.')
    .refine((endpoint) => {
      const url = new URL(endpoint);
      return url.username === '' && url.password === '';
    }, 'A model endpoint must not embed credentials; supply them as the credential reference.'),
  model: z.string().min(1),
  apiKey: z
    .string()
    .min(1)
    .refine(
      isBearerHeaderValue,
      'A model credential must be a valid HTTP header value that requires no normalization.',
    )
    .optional(),
  timeoutMs: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
});

export type MemoryModelTransportSettings = z.infer<typeof optionsSchema>;

/** One model request's failure; the stage names which memory step asked for the generation. */
export class MemoryModelTransportError extends Error {
  constructor(
    readonly stage: 'construct' | 'evolve',
    reason: string,
  ) {
    super(`The ${stage} model request failed: ${reason}.`);
    this.name = 'MemoryModelTransportError';
  }
}

/** Provider diagnostics stay short and never include the configured credential. */
const maxDiagnosticLength = 300;

/** Remove every credential form an untrusted provider or fetch diagnostic can echo. */
function redactCredential(text: string, apiKey: string | undefined): string {
  if (apiKey === undefined) {
    return text;
  }
  return text
    .replaceAll(`Bearer ${apiKey}`, '[redacted]')
    .replaceAll(JSON.stringify(apiKey).slice(1, -1), '[redacted]')
    .replaceAll(apiKey, '[redacted]');
}

/** Shorten untrusted provider or fetch text after removing the configured credential. */
function diagnostic(text: string, apiKey: string | undefined): string {
  const collapsed = redactCredential(text, apiKey).replace(/\s+/g, ' ').trim();
  return collapsed.length > maxDiagnosticLength
    ? `${collapsed.slice(0, maxDiagnosticLength)}…`
    : collapsed;
}

const errorBodySchema = z.object({ error: z.object({ message: z.string() }) });

/** The provider's own error message, when its response body carries one. */
function providerFailureDetail(bodyText: string, apiKey: string | undefined): string {
  const trimmed = bodyText.trim();
  if (trimmed === '') {
    return '';
  }
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(trimmed));
    if (parsed.success) {
      return `: ${diagnostic(parsed.data.error.message, apiKey)}`;
    }
  } catch {
    // A non-JSON body is summarized as it was received.
  }
  return `: ${diagnostic(trimmed, apiKey)}`;
}

const completionSchema = z.object({
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable(),
      message: z.object({ content: z.string().nullable() }),
    }),
  ),
});

/** Remove one optional outer Markdown JSON fence wrapping the whole output. */
function unfence(output: string): string {
  const trimmed = output.trim();
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

/** How the request failed, said safely. */
function describeFetchFailure(
  cause: unknown,
  timeoutMs: number,
  apiKey: string | undefined,
): string {
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError') {
      return `the provider did not answer within ${String(timeoutMs)} ms`;
    }
    if (cause.name === 'AbortError') {
      return 'the request was cancelled';
    }
    return `the request could not reach the provider (${diagnostic(cause.message, apiKey)})`;
  }
  return 'the request could not reach the provider';
}

/** Create the host model transport over the resolved memory model settings. */
export function createMemoryModelTransport(settings: MemoryModelTransportSettings): {
  generate(request: { stage: 'construct' | 'evolve'; prompt: string }): Promise<unknown>;
} {
  const { endpoint, model, apiKey, timeoutMs, maxOutputTokens } = optionsSchema.parse(settings);
  return {
    async generate(request) {
      const abort = AbortSignal.timeout(timeoutMs);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (apiKey !== undefined) {
        headers.authorization = `Bearer ${apiKey}`;
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: request.prompt }],
            max_tokens: maxOutputTokens,
          }),
          signal: abort,
        });
      } catch (cause) {
        throw new MemoryModelTransportError(
          request.stage,
          describeFetchFailure(cause, timeoutMs, apiKey),
        );
      }

      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch {
        throw new MemoryModelTransportError(
          request.stage,
          'the provider response body could not be read',
        );
      }

      if (!response.ok) {
        throw new MemoryModelTransportError(
          request.stage,
          `the provider answered HTTP ${String(response.status)}${providerFailureDetail(
            bodyText,
            apiKey,
          )}`,
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        throw new MemoryModelTransportError(
          request.stage,
          'the provider response body is not JSON',
        );
      }
      const completion = completionSchema.safeParse(payload);
      if (!completion.success) {
        throw new MemoryModelTransportError(
          request.stage,
          'the provider response is not a chat completion',
        );
      }
      const choice = completion.data.choices[0];
      if (choice === undefined) {
        throw new MemoryModelTransportError(
          request.stage,
          'the provider response contains no completion choice',
        );
      }
      if (choice.finish_reason !== 'stop') {
        throw new MemoryModelTransportError(
          request.stage,
          `the provider stopped before finishing (finish reason ${JSON.stringify(
            choice.finish_reason === null ? null : diagnostic(choice.finish_reason, apiKey),
          )})`,
        );
      }
      if (choice.message.content === null) {
        throw new MemoryModelTransportError(
          request.stage,
          'the provider response contains no message content',
        );
      }
      try {
        return JSON.parse(unfence(choice.message.content)) as unknown;
      } catch {
        throw new MemoryModelTransportError(
          request.stage,
          'the model returned output that is not valid JSON',
        );
      }
    },
  };
}
