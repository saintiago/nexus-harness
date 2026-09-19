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
export const CRITERIA_HEADING = 'acceptance criteria';

/** How deep a supported document may nest before it is refused as pathological. */
const MAX_DEPTH = 12;

/** How many nodes one description may carry before it is refused as pathological. */
const MAX_NODES = 5_000;

/** A supported inline mark, already validated. */
export type AdfMark =
  | { readonly type: 'strong' }
  | { readonly type: 'em' }
  | { readonly type: 'code' }
  | { readonly type: 'link'; readonly href: string };

/** A supported node, parsed from the wire format into something renderable. */
export type AdfNode =
  | { readonly type: 'heading'; readonly level: number; readonly content: readonly AdfNode[] }
  | { readonly type: 'paragraph'; readonly content: readonly AdfNode[] }
  | { readonly type: 'text'; readonly text: string; readonly marks: readonly AdfMark[] }
  | { readonly type: 'hardBreak' }
  | { readonly type: 'codeBlock'; readonly text: string }
  | { readonly type: 'bulletList'; readonly items: readonly AdfNode[] }
  | { readonly type: 'orderedList'; readonly items: readonly AdfNode[] }
  | { readonly type: 'listItem'; readonly content: readonly AdfNode[] };

/** A bullet or ordered list: the two node types that carry list items. */
export type AdfList = AdfNode & { readonly type: 'bulletList' | 'orderedList' };

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
