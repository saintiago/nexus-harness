/**
 * Rendering a supported description as readable text, and writing the plain ADF
 * comment the harness posts: the other half of the small, explicit Jira text
 * convention.
 *
 * Headings, paragraphs, lists, line breaks, code, and link destinations are
 * rendered in document order and nothing is invented. The accepted heading is
 * the convention: only `Acceptance criteria` has extraction semantics, and its
 * section must hold at least one nonblank list item.
 */
import { AdfError, CRITERIA_HEADING } from './adf.js';
import type { AdfList, AdfMark, AdfNode } from './adf.js';

/** Renders one text node's marks in a fixed order, so the output is stable. */
function markedText(node: { readonly text: string; readonly marks: readonly AdfMark[] }): string {
  let text = node.text;
  if (node.marks.some((mark) => mark.type === 'code')) {
    text = `\`${text}\``;
  }
  if (node.marks.some((mark) => mark.type === 'strong')) {
    text = `**${text}**`;
  }
  if (node.marks.some((mark) => mark.type === 'em')) {
    text = `*${text}*`;
  }
  const link = node.marks.find((mark) => mark.type === 'link');
  if (link !== undefined && link.type === 'link') {
    text = `[${text}](${link.href})`;
  }
  return text;
}

/** The inline text of a paragraph-like node: text, marks, and line breaks only. */
function inlineText(nodes: readonly AdfNode[], where: string): string {
  let text = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      text += markedText(node);
      continue;
    }
    if (node.type === 'hardBreak') {
      text += '\n';
      continue;
    }
    throw new AdfError(
      `${where} holds a "${node.type}" where only text, marks, or a line break is supported`,
    );
  }
  return text;
}

/** One marker plus its text, with any nested blocks rendered underneath it. */
function renderListItem(item: AdfNode, marker: string, depth: number, where: string): string {
  if (item.type !== 'listItem') {
    throw new AdfError(`${where} holds a "${item.type}" instead of a list item`);
  }
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  let head = '';
  let index = 0;
  const [first] = item.content;
  if (first !== undefined && (first.type === 'paragraph' || first.type === 'heading')) {
    head = inlineText(first.content, where);
    index = 1;
  }
  lines.push(`${indent}${marker} ${head}`.trimEnd());

  for (const block of item.content.slice(index)) {
    if (block.type === 'bulletList' || block.type === 'orderedList') {
      lines.push(renderList(block, depth + 1, where));
      continue;
    }
    if (block.type === 'paragraph') {
      lines.push(`${'  '.repeat(depth + 1)}${inlineText(block.content, where)}`.trimEnd());
      continue;
    }
    if (block.type === 'codeBlock') {
      lines.push(`${'  '.repeat(depth + 1)}\`\`\``);
      for (const line of block.text.split('\n')) {
        lines.push(`${'  '.repeat(depth + 1)}${line}`.trimEnd());
      }
      lines.push(`${'  '.repeat(depth + 1)}\`\`\``);
      continue;
    }
    throw new AdfError(`${where} holds a "${block.type}" inside a list item`);
  }
  return lines.join('\n');
}

/** One list: bullet or ordered, with its own marker per item. */
function renderList(list: AdfList, depth: number, where: string): string {
  return list.items
    .map((item, index) =>
      renderListItem(
        item,
        list.type === 'bulletList' ? '-' : `${String(index + 1)}.`,
        depth,
        where,
      ),
    )
    .join('\n');
}

/** Renders one block node of the supported subset as readable text. */
function renderBlock(node: AdfNode, depth: number, where: string): string {
  switch (node.type) {
    case 'heading':
      return `${'#'.repeat(node.level)} ${inlineText(node.content, where)}`;
    case 'paragraph':
      return inlineText(node.content, where);
    case 'codeBlock':
      return ['```', node.text, '```'].join('\n');
    case 'bulletList':
    case 'orderedList':
      return renderList(node, depth, where);
    default:
      throw new AdfError(`${where} holds a "${node.type}" where a block was expected`);
  }
}

/**
 * The whole description as readable text/Markdown: headings, paragraphs, lists,
 * line breaks, code, and link destinations, in document order and with nothing
 * invented. An unsupported node has already been refused by the parser.
 */
export function renderDescription(nodes: readonly AdfNode[]): string {
  const rendered: string[] = [];
  for (const node of nodes) {
    if (node.type === 'listItem' || node.type === 'text' || node.type === 'hardBreak') {
      throw new AdfError(`the description holds a top-level "${node.type}"`);
    }
    rendered.push(renderBlock(node, 0, 'the description'));
  }
  return rendered.join('\n').trim();
}

/** A heading's text, flattened and without an optional trailing colon. */
function headingText(node: AdfNode, where: string): string {
  if (node.type !== 'heading') {
    throw new AdfError(`${where} is not a heading`);
  }
  return inlineText(node.content, where).replace(/\s+/g, ' ').trim().replace(/:$/, '').trim();
}

/**
 * One criterion per top-level list item under the accepted heading, with a
 * nested item's text kept rather than dropped (docs/WORKFLOW.md §6).
 */
function criterionText(item: AdfNode, where: string): string {
  if (item.type !== 'listItem') {
    throw new AdfError(`${where} holds a "${item.type}" instead of a list item`);
  }
  const parts: string[] = [];
  const collect = (node: AdfNode): void => {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        parts.push(inlineText(node.content, where));
        return;
      case 'codeBlock':
        parts.push(node.text);
        return;
      case 'bulletList':
      case 'orderedList':
        for (const nested of node.items) {
          collect(nested);
        }
        return;
      case 'listItem':
        // A nested item reached through its list: its text belongs to the
        // criterion it sits under, rather than being dropped.
        for (const block of node.content) {
          collect(block);
        }
        return;
      default:
        throw new AdfError(`${where} holds a "${node.type}" inside a criterion`);
    }
  };
  for (const block of item.content) {
    collect(block);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The acceptance criteria of a description.
 *
 * Exactly one top-level heading must read `Acceptance criteria` (an optional
 * trailing colon is allowed, and the comparison is case-insensitive). The
 * heading's section runs until the next heading of the same or higher level, and
 * must hold at least one nonblank bullet or ordered list item. Anything
 * ambiguous, empty, or missing is refused rather than inferred.
 */
export function extractAcceptanceCriteria(nodes: readonly AdfNode[]): readonly string[] {
  const headings = nodes
    .map((node, index) => ({ node, index }))
    .filter((entry) => entry.node.type === 'heading')
    .filter(
      (entry) => headingText(entry.node, 'the description').toLowerCase() === CRITERIA_HEADING,
    );

  if (headings.length === 0) {
    throw new AdfError(
      'the description has no "Acceptance criteria" heading, so this task has no acceptance ' +
        'criteria to implement against',
    );
  }
  if (headings.length > 1) {
    throw new AdfError(
      `the description has ${String(headings.length)} "Acceptance criteria" headings; which one ` +
        'lists the criteria is ambiguous',
    );
  }

  const [match] = headings;
  if (match === undefined) {
    throw new AdfError('the description has no "Acceptance criteria" heading');
  }
  if (match.node.type !== 'heading') {
    throw new AdfError('the "Acceptance criteria" heading is not a heading');
  }
  const level = match.node.level;

  const section: AdfNode[] = [];
  for (const node of nodes.slice(match.index + 1)) {
    if (node.type === 'heading' && node.level <= level) {
      break;
    }
    section.push(node);
  }

  const lists = section.filter(
    (node): node is AdfList => node.type === 'bulletList' || node.type === 'orderedList',
  );
  if (lists.length === 0) {
    throw new AdfError(
      'the "Acceptance criteria" section holds no bullet or ordered list, so it lists no criteria',
    );
  }

  const criteria: string[] = [];
  for (const list of lists) {
    for (const item of list.items) {
      const text = criterionText(item, 'the "Acceptance criteria" section');
      if (text === '') {
        throw new AdfError(
          'the "Acceptance criteria" section holds an empty list item, which states no criterion',
        );
      }
      criteria.push(text);
    }
  }
  return criteria;
}

/** An empty paragraph, which is what ADF uses for a blank line of a comment. */
interface AdfParagraph {
  readonly type: 'paragraph';
}

interface AdfTextNode {
  readonly type: 'text';
  readonly text: string;
}

interface AdfParagraphWithText {
  readonly type: 'paragraph';
  readonly content: readonly AdfTextNode[];
}

interface AdfDocument {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: readonly (AdfParagraph | AdfParagraphWithText)[];
}

/**
 * A comment body: ordinary paragraphs of text and nothing else, because that is
 * all a result comment needs (docs/WORKFLOW.md §5). An empty string becomes an
 * empty paragraph, so a compact comment keeps its shape.
 */
export function buildCommentDocument(paragraphs: readonly string[]): AdfDocument {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((paragraph) =>
      paragraph === ''
        ? { type: 'paragraph' as const }
        : {
            type: 'paragraph' as const,
            content: [{ type: 'text' as const, text: paragraph }],
          },
    ),
  };
}
