/**
 * The small, explicit Jira text convention: reading a Jira description into the
 * existing `Task` fields, and writing a plain result comment.
 *
 * Jira REST API v3 describes an issue with Atlassian Document Format, not with
 * a Markdown string. This module understands exactly the nodes the documented
 * task convention uses (docs/WORKFLOW.md §6) and refuses everything else: a
 * description that could hide a requirement in a node this reader does not
 * understand is a per-issue input error, never something to flatten and hope
 * about. There is no LLM extraction here and no general rich-text converter.
 *
 * Two things are deliberately narrow:
 *
 * - Sections are found in the document structure, never in flattened text: the
 *   contents of a code block are text, and a `## Acceptance criteria` line
 *   inside one is not a heading.
 * - Only the `Acceptance criteria` heading has extraction semantics. `Goal`,
 *   `Verification`, and `Constraints` are conventions for a human reader; they
 *   are rendered into the description like any other section and are never
 *   turned into configuration, commands, or criteria.
 */

/** A description this reader cannot map without guessing. */
export class AdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdfError';
  }
}

/** The heading whose section becomes `Task.acceptanceCriteria`. */
const CRITERIA_HEADING = 'acceptance criteria';

/** How deep a supported document may nest before it is refused as pathological. */
const MAX_DEPTH = 12;

/** How many nodes one description may carry before it is refused as pathological. */
const MAX_NODES = 5_000;

/** A supported inline mark, already validated. */
type AdfMark =
  | { readonly type: 'strong' }
  | { readonly type: 'em' }
  | { readonly type: 'code' }
  | { readonly type: 'link'; readonly href: string };

/** A supported node, parsed from the wire format into something renderable. */
type AdfNode =
  | { readonly type: 'heading'; readonly level: number; readonly content: readonly AdfNode[] }
  | { readonly type: 'paragraph'; readonly content: readonly AdfNode[] }
  | { readonly type: 'text'; readonly text: string; readonly marks: readonly AdfMark[] }
  | { readonly type: 'hardBreak' }
  | { readonly type: 'codeBlock'; readonly text: string }
  | { readonly type: 'bulletList'; readonly items: readonly AdfNode[] }
  | { readonly type: 'orderedList'; readonly items: readonly AdfNode[] }
  | { readonly type: 'listItem'; readonly content: readonly AdfNode[] };

/** A bullet or ordered list: the two node types that carry list items. */
type AdfList = AdfNode & { readonly type: 'bulletList' | 'orderedList' };

/** The supported node types, for an error message that says what is allowed. */
const SUPPORTED_NODES = [
  'doc',
  'heading',
  'paragraph',
  'text',
  'hardBreak',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
];

/** The supported marks. An unknown mark is refused rather than dropped. */
const SUPPORTED_MARKS = ['strong', 'em', 'code', 'link'];

interface ParseState {
  nodes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childrenOf(value: unknown, where: string): readonly unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AdfError(`${where} must hold its content as a list of nodes`);
  }
  return value;
}

function parseMarks(value: unknown, where: string): readonly AdfMark[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AdfError(`${where} must list its marks as an array`);
  }
  return value.map((mark) => {
    if (!isRecord(mark) || typeof mark['type'] !== 'string') {
      throw new AdfError(`${where} carries a mark without a type`);
    }
    const type = mark['type'];
    if (type === 'strong' || type === 'em' || type === 'code') {
      return { type };
    }
    if (type === 'link') {
      const attrs = mark['attrs'];
      const href = isRecord(attrs) ? attrs['href'] : undefined;
      if (typeof href !== 'string' || href.trim() === '') {
        throw new AdfError(`${where} carries a link mark with no destination`);
      }
      return { type: 'link', href: href.trim() };
    }
    throw new AdfError(
      `${where} uses the unsupported mark "${type}". This harness reads only ${SUPPORTED_MARKS.join(
        ', ',
      )} marks; a mark it does not understand could hide a requirement.`,
    );
  });
}

/**
 * Parses one node of the supported subset. Everything outside the subset is an
 * {@link AdfError} naming the node, so a description that this reader cannot
 * map is a per-issue input error rather than a silently shortened task.
 */
function parseNode(value: unknown, where: string, depth: number, state: ParseState): AdfNode {
  if (depth > MAX_DEPTH) {
    throw new AdfError(`${where} nests deeper than this reader supports (${String(MAX_DEPTH)})`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw new AdfError(`the description holds more than ${String(MAX_NODES)} nodes`);
  }
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    throw new AdfError(`${where} is not an Atlassian document node`);
  }

  const type = value['type'];
  const here = `${where} (${type})`;
  switch (type) {
    case 'text': {
      const text = value['text'];
      if (typeof text !== 'string') {
        throw new AdfError(`${here} carries no text`);
      }
      return { type: 'text', text, marks: parseMarks(value['marks'], here) };
    }
    case 'hardBreak':
      return { type: 'hardBreak' };
    case 'heading': {
      const attrs = value['attrs'];
      const level = isRecord(attrs) ? attrs['level'] : undefined;
      if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) {
        throw new AdfError(`${here} has no heading level between 1 and 6`);
      }
      return {
        type: 'heading',
        level,
        content: parseChildren(value, here, depth, state),
      };
    }
    case 'paragraph':
      return { type: 'paragraph', content: parseChildren(value, here, depth, state) };
    case 'listItem':
      return { type: 'listItem', content: parseChildren(value, here, depth, state) };
    case 'codeBlock': {
      const text = codeBlockText(value, here, depth, state);
      return { type: 'codeBlock', text };
    }
    case 'bulletList':
    case 'orderedList': {
      const items = parseChildren(value, here, depth, state).map((child) => {
        if (child.type !== 'listItem') {
          throw new AdfError(`${here} holds a "${child.type}" instead of a list item`);
        }
        return child;
      });
      return { type, items };
    }
    default:
      throw new AdfError(
        `${here} is not a node this harness reads. Supported nodes are ` +
          `${SUPPORTED_NODES.join(', ')}; unsupported content is refused rather than dropped ` +
          'because it could carry a requirement.',
      );
  }
}

function parseChildren(
  value: Record<string, unknown>,
  where: string,
  depth: number,
  state: ParseState,
): readonly AdfNode[] {
  return childrenOf(value['content'], where).map((child) =>
    parseNode(child, where, depth + 1, state),
  );
}

/** The plain text of a code block. Its content is text, never structure. */
function codeBlockText(
  value: Record<string, unknown>,
  where: string,
  depth: number,
  state: ParseState,
): string {
  const children = parseChildren(value, where, depth, state);
  let text = '';
  for (const child of children) {
    if (child.type === 'text') {
      text += child.text;
      continue;
    }
    if (child.type === 'hardBreak') {
      text += '\n';
      continue;
    }
    throw new AdfError(`${where} holds a "${child.type}"; a code block holds text only`);
  }
  return text;
}

/** Parses a description document. The caller decides what an empty one means. */
export function parseDescription(value: unknown): readonly AdfNode[] {
  if (!isRecord(value) || value['type'] !== 'doc') {
    throw new AdfError('the description is not an Atlassian document (no "doc" node)');
  }
  const state: ParseState = { nodes: 0 };
  const nodes = childrenOf(value['content'], 'the description').map((child) =>
    parseNode(child, 'the description', 1, state),
  );
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'listItem' || node.type === 'hardBreak') {
      throw new AdfError(`the description holds a top-level "${node.type}", which is not a block`);
    }
  }
  return nodes;
}

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
