import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { messageOf, type ArtifactRef } from '../../result.js';
import { describeIssues, parseDocument } from './documents.js';

/**
 * The shared agent-report plumbing: the assigned Markdown path and its byte-level operations, the
 * response-format instruction derived from one role's declared schema, the action-owned record
 * reservation and its validated parse. Callers own what each report means and how an unusable one
 * is named.
 */

/** One artifact reference: the readable location of a report or record. */
export const artifactRefSchema = z.strictObject({
  path: z.string().trim().min(1).describe('The artifact file path.'),
});

/** The report association one saved outcome carries: its Markdown and its invocation. */
export const reportBindingSchema = z.strictObject({
  report: artifactRefSchema.describe('The assigned Markdown report this outcome describes.'),
  reportIdentity: z.string().trim().min(1).describe("SHA-256 of the report's exact UTF-8 bytes."),
  invocationId: z.string().trim().min(1).describe('The agent invocation that produced the report.'),
});

export type ReportBinding = z.infer<typeof reportBindingSchema>;

/** The report fields each owner spreads into its saved-outcome schema. */
export const reportBindingFields = reportBindingSchema.shape;

/** One readable report file: its exact bytes, UTF-8 text and byte identity. */
export type ReportFile = {
  readonly file: string;
  readonly text: string;
  readonly identity: string;
  readonly bytes: Buffer;
};

/** The identity of one report's exact bytes. */
export function reportIdentityOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Assign one invocation's Markdown report path inside an owning artifact area and create its
 * parent directory before the invocation so the agent can write the report.
 */
export async function assignReportPath(
  areaRoot: string,
  invocationId: string,
  reportName: string,
): Promise<ArtifactRef> {
  const file = path.join(areaRoot, 'reports', invocationId, `${reportName}.md`);
  await mkdir(path.dirname(file), { recursive: true });
  return { path: file };
}

/** Read one assigned report as UTF-8 text, requiring a readable regular file. */
export async function readAssignedReport(file: string, kind = 'Report'): Promise<ReportFile> {
  let information;
  try {
    information = await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${kind} at "${file}" does not exist.`, { cause: error });
    }
    throw new Error(`${kind} at "${file}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (!information.isFile()) {
    throw new Error(`${kind} at "${file}" is not a readable regular file.`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new Error(`${kind} at "${file}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
  return { file, text: bytes.toString('utf8'), identity: reportIdentityOf(bytes), bytes };
}

/** Read the report one saved binding names and require its recorded identity. */
export async function readBoundReport(
  binding: ReportBinding,
  kind = 'Report',
): Promise<ReportFile> {
  const report = await readAssignedReport(binding.report.path, kind);
  if (report.identity !== binding.reportIdentity) {
    throw new Error(
      `${kind} at "${binding.report.path}" does not match the identity recorded for ` +
        `invocation ${binding.invocationId}.`,
    );
  }
  return report;
}

/**
 * The opening narrative paragraph of a Markdown report, or null when the report has no prose.
 * Headings, fenced and indented code, lists, tables, block quotes, thematic breaks, link
 * definitions and raw HTML are structure, not narrative; the first block of actual prose is
 * returned with its Markdown text intact.
 */
export function openingNarrativeParagraph(markdown: string): string | null {
  for (const block of markdownBlocks(markdown)) {
    const paragraph = block.trim();
    if (paragraph !== '' && isNarrativeBlock(block)) {
      return paragraph;
    }
  }
  return null;
}

/** Markdown blocks separated by blank lines or headings; fenced code stays one block. */
function markdownBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { readonly marker: string; readonly length: number } | null = null;
  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
  };
  for (const line of markdown.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      if (match !== null) {
        flush();
        fence = { marker: match[1]![0]!, length: match[1]!.length };
        current.push(line);
      } else if (line.trim() === '') {
        flush();
      } else if (/^ {0,3}#{1,6}(\s|$)/.test(line)) {
        flush();
        current.push(line);
        flush();
      } else if (current.length > 0 && /^ {0,3}(=+|-+)\s*$/.test(line)) {
        current.push(line);
        flush();
      } else {
        current.push(line);
      }
      continue;
    }
    current.push(line);
    if (
      match !== null &&
      match[1]![0] === fence.marker &&
      match[1]!.length >= fence.length &&
      match[2]!.trim() === ''
    ) {
      fence = null;
      flush();
    }
  }
  flush();
  return blocks;
}

/** True when one block holds prose rather than Markdown structure. */
function isNarrativeBlock(block: string): boolean {
  const lines = block.split('\n');
  const first = lines[0]!.trimStart();
  if (
    /^#{1,6}(\s|$)/.test(first) ||
    /^(`{3,}|~{3,})/.test(first) ||
    /^( {4}|\t)/.test(lines[0]!) ||
    /^>/.test(first) ||
    /^</.test(first) ||
    /^\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(lines[0]!) ||
    /^\s{0,3}([-*_]\s*){3,}$/.test(first) ||
    /^\s{0,3}\[[^\]]+\]:/.test(first) ||
    lines.some((line) => /^\s{0,3}\|/.test(line))
  ) {
    return false;
  }
  // A setext heading is a prose line underlined by a sequence of = or - characters.
  if (lines.length > 1 && /^\s{0,3}(=+|-+)\s*$/.test(lines.at(-1)!)) {
    return false;
  }
  return true;
}

/** The response-format instruction for one role's declared output schema. */
export function responseFormatText(schema: z.ZodType): string {
  return [
    'Return only one JSON object, without Markdown fences and without other text, matching:',
    JSON.stringify(z.toJSONSchema(schema), null, 2),
  ].join('\n');
}

/**
 * The instruction reserving the records the owning action saves: the invocation returns the
 * response object and never writes those paths itself. The caller supplies the concrete paths.
 */
export function actionOwnedRecordsText(records: readonly string[]): string {
  return [
    'Return the response object only; do not write or overwrite these action-owned records:',
    ...records.map((record) => `- ${record}`),
    'The owning action adds saved-record metadata and persists them.',
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
