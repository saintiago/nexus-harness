import { z } from 'zod';
import { messageOf } from '../../result.js';
import { describeIssues, parseDocument } from './documents.js';

/**
 * The shared agent-report plumbing: the response-format instruction derived from one role's
 * declared schema and its validated parse. Callers own what each report means and how an unusable
 * one is named.
 */

/** The response-format instruction for one role's declared output schema. */
export function responseFormatText(schema: z.ZodType): string {
  return [
    'Return only one JSON object, without Markdown fences and without other text, matching:',
    JSON.stringify(z.toJSONSchema(schema), null, 2),
  ].join('\n');
}

/** Parse one role's returned report against its declared response schema. */
export function parseAgentReport<Schema extends z.ZodType>(
  output: string,
  schema: Schema,
  role: string,
): z.output<Schema> {
  const parsed = parseDocument(output, schema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(`The ${role} returned unusable output: ${messageOf(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `The ${role}'s report does not match the response format: ` +
        describeIssues(parsed.error, '<report>'),
      { cause: parsed.error },
    );
  }
  return parsed.content as z.output<Schema>;
}
