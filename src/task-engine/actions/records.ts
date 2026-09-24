import type { z } from 'zod';
import { messageOf } from '../../result.js';
import { describeIssues, parseDocument, readDocumentText, writeDocument } from './documents.js';

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
  const text = await readDocumentText(filePath, 'Record');
  if (text === null) {
    return null;
  }

  const parsed = parseDocument(text, declaration.schema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(`Record at "${filePath}" is not valid JSON: ${messageOf(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `Record at "${filePath}" does not match its declared content type: ` +
        describeIssues(parsed.error, '<record>'),
      { cause: parsed.error },
    );
  }
  // safeParse erases the generic schema's output type.
  return parsed.content as RecordContent<Declaration>;
}

/** Read a declared record that must exist; a missing record is an execution error. */
export async function readRequiredRecord<Declaration extends RecordDeclaration>(
  filePath: string,
  declaration: Declaration,
  kind: string,
): Promise<RecordContent<Declaration>> {
  const content = await readRecord(filePath, declaration);
  if (content === null) {
    throw new Error(`${kind} at "${filePath}" does not exist.`);
  }
  return content;
}

/** Write a record as formatted JSON. */
export async function writeRecord<Content>(filePath: string, content: Content): Promise<void> {
  await writeDocument(filePath, content, 'Record');
}
