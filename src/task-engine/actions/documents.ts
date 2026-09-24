import { readFile, writeFile } from 'node:fs/promises';
import type { z } from 'zod';
import { messageOf } from '../../result.js';

/**
 * The JSON-document plumbing shared by records, round artifacts and agent reports. Callers own
 * what each document means and how an unusable one is named.
 */

/** One document's content validated against its schema, or why it could not be used. */
type ParsedDocument<Schema extends z.ZodType> =
  | { readonly kind: 'content'; readonly content: z.output<Schema> }
  | { readonly kind: 'invalid-json'; readonly error: unknown }
  | { readonly kind: 'invalid-content'; readonly error: z.ZodError };

/**
 * Read one document file as text, or null when it does not exist. `kind` names the document in
 * error messages, such as "Record" or "Artifact".
 */
export async function readDocumentText(filePath: string, kind: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`${kind} at "${filePath}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

/** Parse one JSON document and validate it against the schema declaring its content. */
export function parseDocument<Schema extends z.ZodType>(
  text: string,
  schema: Schema,
): ParsedDocument<Schema> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return { kind: 'invalid-json', error };
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { kind: 'invalid-content', error: parsed.error };
  }
  return { kind: 'content', content: parsed.data };
}

/** One schema mismatch's issues as a `location: message` list; `rootLabel` names the document. */
export function describeIssues(error: z.ZodError, rootLabel: string): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join('.') : rootLabel;
      return `${location}: ${issue.message}`;
    })
    .join('; ');
}

/** Write one document as formatted JSON, named by `kind` in error messages. */
export async function writeDocument(
  filePath: string,
  content: unknown,
  kind: string,
): Promise<void> {
  try {
    await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new Error(`${kind} at "${filePath}" could not be written: ${messageOf(error)}`, {
      cause: error,
    });
  }
}
