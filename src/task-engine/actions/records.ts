import { readFile, writeFile } from 'node:fs/promises';
import type { z } from 'zod';
import { messageOf } from '../../result.js';

/**
 * Pre-round records live outside the round artifact roots: the queue's selection record beside the
 * workflow-state file, and each workspace's prepared-workspace and current-round records. Every
 * producer owns its declaration; these helpers read and write the declared JSON without knowing
 * what a record means.
 */

/** One producer-owned record declaration: its fixed file name and its content schema. */
export type RecordDeclaration<Schema extends z.ZodType = z.ZodType> = {
  readonly file: string;
  readonly schema: Schema;
};

/** The declared content of one record declaration. */
export type RecordContent<Declaration extends RecordDeclaration> = z.output<Declaration['schema']>;

/** Read a declared record, or null when the file does not exist yet. Invalid content is an error. */
export async function readRecord<Declaration extends RecordDeclaration>(
  filePath: string,
  declaration: Declaration,
): Promise<RecordContent<Declaration> | null> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Record at "${filePath}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Record at "${filePath}" is not valid JSON: ${messageOf(error)}`, {
      cause: error,
    });
  }

  const content = declaration.schema.safeParse(value);
  if (!content.success) {
    const issues = content.error.issues
      .map((issue) => {
        const location = issue.path.length > 0 ? issue.path.join('.') : '<record>';
        return `${location}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Record at "${filePath}" does not match its declared content type: ${issues}`, {
      cause: content.error,
    });
  }
  // safeParse erases the generic schema's output type.
  return content.data as RecordContent<Declaration>;
}

/** Write a record as formatted JSON. */
export async function writeRecord<Content>(filePath: string, content: Content): Promise<void> {
  try {
    await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new Error(`Record at "${filePath}" could not be written: ${messageOf(error)}`, {
      cause: error,
    });
  }
}
