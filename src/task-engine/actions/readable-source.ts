import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../../result.js';

/**
 * The readable rendering of one invocation's captured source: the issue's summary, rich-text
 * description and other meaningful fields plus the attributed conversation, shared by the role
 * contexts that present captured source. A role renders the captured values directly, without
 * another agent invocation or a generated summary, so human intent, conflicts and evidence keep
 * their meaning and attribution while administrative provider envelopes stay out of the prompt.
 * Preparation's rendering explicitly points at the retained captured source for content it cannot
 * translate; Review's directly visible sections additionally fall back to the complete original
 * captured value, so an unsupported requirement or direction body is never replaced by a pointer.
 * The exact captured `{ issue, conversation }` is retained beside the invocation's report for
 * later inspection.
 */

/** The invocation-local copy of the exact captured source values. */
export const capturedSourceFile = 'captured-source.json';

/** The retained captured-source path beside one invocation's assigned Markdown report. */
export function capturedSourcePathOf(reportPath: string): string {
  return path.join(path.dirname(reportPath), capturedSourceFile);
}

/**
 * Retain the exact `{ issue, conversation }` the context renders, beside the invocation's report.
 * The copy is written from the same captured values as the source-identity check, never from
 * rendered text or a fresh source read. An already retained copy is left unchanged.
 */
export async function retainCapturedSource(settings: {
  readonly file: string;
  readonly task: unknown;
  readonly conversation: readonly unknown[];
}): Promise<void> {
  const content = `${JSON.stringify(
    { issue: settings.task, conversation: settings.conversation },
    null,
    2,
  )}\n`;
  try {
    await mkdir(path.dirname(settings.file), { recursive: true });
    await writeFile(settings.file, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return;
    }
    throw new Error(
      `The captured source evidence at "${settings.file}" could not be retained: ` +
        `${messageOf(error)}`,
      { cause: error },
    );
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function nodeType(node: unknown): string | null {
  return isObject(node) ? textOf(node.type) : null;
}

function nodesOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The inspection instruction one unsupported or embedded node leaves in the rendering. */
function inspectionNote(description: string, sourcePath: string): string {
  return (
    `[This rendering does not display ${description}; inspect the captured source at ` +
    `"${sourcePath}" before relying on it.]`
  );
}

/**
 * How one rendering presents captured content it cannot translate into readable text. Preparation
 * names the unrendered content and requires inspecting the retained captured source; Review's
 * directly visible sections instead show the complete original captured value inline, so an
 * unsupported requirement or direction body is never replaced by a pointer.
 */
type UnsupportedContent = 'inspection-reference' | 'original-value';

/** One rendering's retained-source reference and unsupported-content policy. */
type Rendering = {
  readonly sourcePath: string;
  readonly unsupported: UnsupportedContent;
};

/** The original captured value as compact JSON, or null when it cannot be serialized. */
export function capturedValueJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : json;
  } catch {
    return null;
  }
}

/** The statement one piece of content the rendering cannot translate leaves in its place. */
function unsupportedNote(rendering: Rendering, description: string, value: unknown): string {
  if (rendering.unsupported === 'original-value') {
    const json = capturedValueJson(value);
    if (json !== null) {
      return (
        `[This rendering does not display ${description} as readable text; original captured ` +
        `value: ${json}]`
      );
    }
  }
  return inspectionNote(description, rendering.sourcePath);
}

/** Review's lossless rendering context: unsupported content falls back to its original value. */
function losslessRendering(sourcePath: string): Rendering {
  return { sourcePath, unsupported: 'original-value' };
}

/** The default rendering context: unsupported content keeps an inspection reference. */
function inspectionRendering(sourcePath: string): Rendering {
  return { sourcePath, unsupported: 'inspection-reference' };
}

/** One text node with its supported marks rendered as Markdown, or its plain text. */
function renderText(node: Readonly<Record<string, unknown>>): string {
  const text = typeof node.text === 'string' ? node.text : '';
  let rendered = text;
  for (const mark of nodesOf(node.marks)) {
    if (!isObject(mark)) {
      continue;
    }
    const attrs = isObject(mark.attrs) ? mark.attrs : {};
    switch (mark.type) {
      case 'link': {
        const href = textOf(attrs.href);
        rendered = href === null ? rendered : `[${rendered}](${href})`;
        break;
      }
      case 'code':
        rendered = `\`${rendered}\``;
        break;
      case 'strong':
        rendered = `**${rendered}**`;
        break;
      case 'em':
        rendered = `*${rendered}*`;
        break;
      case 'strike':
        rendered = `~~${rendered}~~`;
        break;
      default:
        break;
    }
  }
  return rendered;
}

/** One inline node's readable text; unsupported inline content is identified explicitly. */
function renderInline(node: unknown, rendering: Rendering): string {
  const type = nodeType(node);
  if (type === null) {
    return isObject(node)
      ? unsupportedNote(rendering, 'captured content at this position', node)
      : '';
  }
  if (!isObject(node)) {
    return '';
  }
  const attrs = isObject(node.attrs) ? node.attrs : {};
  switch (type) {
    case 'text':
      return renderText(node);
    case 'hardBreak':
      return '\n';
    case 'mention':
    case 'emoji':
    case 'status':
      return (
        textOf(attrs.text) ??
        textOf(attrs.shortName) ??
        unsupportedNote(rendering, `${type} content`, node)
      );
    case 'inlineCard': {
      const url = textOf(attrs.url);
      return url ?? unsupportedNote(rendering, 'an inline card', node);
    }
    case 'date': {
      const timestamp = attrs.timestamp;
      return typeof timestamp === 'number'
        ? new Date(timestamp).toISOString()
        : unsupportedNote(rendering, 'a date', node);
    }
    default:
      return unsupportedNote(rendering, `a Jira "${type}" node`, node);
  }
}

/** The inline text of one block's content, joined without separators. */
function renderInlineChildren(
  node: Readonly<Record<string, unknown>>,
  rendering: Rendering,
): string {
  return nodesOf(node.content)
    .map((child) => renderInline(child, rendering))
    .join('');
}

/** One node's block lines; unsupported block content is identified explicitly. */
function renderBlock(node: unknown, rendering: Rendering, depth: number): string[] {
  const type = nodeType(node);
  if (!isObject(node)) {
    return [];
  }
  const indent = '  '.repeat(depth);
  const attrs = isObject(node.attrs) ? node.attrs : {};
  switch (type) {
    case 'paragraph': {
      const text = renderInlineChildren(node, rendering);
      return text === '' ? [] : text.split('\n').map((line) => `${indent}${line}`);
    }
    case 'heading': {
      const level =
        typeof attrs.level === 'number' && attrs.level >= 1 && attrs.level <= 6 ? attrs.level : 2;
      return [`${indent}${'#'.repeat(level)} ${renderInlineChildren(node, rendering)}`];
    }
    case 'codeBlock': {
      const language = textOf(attrs.language);
      const code = nodesOf(node.content)
        .map((child) => (isObject(child) && typeof child.text === 'string' ? child.text : ''))
        .join('');
      return [
        `${indent}\`\`\`${language ?? ''}`,
        ...code.split('\n').map((line) => `${indent}${line}`),
        `${indent}\`\`\``,
      ];
    }
    case 'blockquote':
      return renderChildren(node, rendering, depth).map((line) => `${indent}> ${line}`);
    case 'rule':
      return [`${indent}---`];
    case 'bulletList':
    case 'orderedList':
      return renderList(node, rendering, depth);
    case 'taskList':
      return renderTaskList(node, rendering, depth);
    case 'decisionList':
      return nodesOf(node.content).flatMap((item) =>
        isObject(item) ? [`${indent}- ${renderInlineChildren(item, rendering)}`] : [],
      );
    case 'table':
      return renderTable(node, rendering, depth);
    case 'panel':
      return renderChildren(node, rendering, depth).map((line) => `${indent}> ${line}`);
    case 'expand':
    case 'nestedExpand': {
      const title = textOf(attrs.title);
      return [
        `${indent}${title === null ? '[collapsed section]' : `[collapsed section: ${title}]`}`,
        ...renderChildren(node, rendering, depth + 1),
      ];
    }
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
    case 'mediaInline':
      return [
        `${indent}${unsupportedNote(rendering, 'embedded media (an image or attachment)', node)}`,
      ];
    case 'layout':
    case 'layoutSection':
    case 'layoutColumn':
    case 'doc':
      return renderChildren(node, rendering, depth);
    default:
      return [`${indent}${unsupportedNote(rendering, `a Jira "${type}" node`, node)}`];
  }
}

function renderChildren(
  node: Readonly<Record<string, unknown>>,
  rendering: Rendering,
  depth: number,
): string[] {
  return nodesOf(node.content).flatMap((child) => renderBlock(child, rendering, depth));
}

/** True for one node that renders as its own list, nested under a parent item. */
function isListNode(node: unknown): boolean {
  const type = nodeType(node);
  return type === 'bulletList' || type === 'orderedList' || type === 'taskList';
}

/** One ordered list's first number: its captured `order`, never a fabricated restart at one. */
function orderedStart(node: Readonly<Record<string, unknown>>): number {
  const attrs = isObject(node.attrs) ? node.attrs : {};
  return typeof attrs.order === 'number' && attrs.order >= 1 ? Math.trunc(attrs.order) : 1;
}

/**
 * One list's items with nested lists rendered under the item's own content. Every child block is
 * rendered exactly once through its actual structure, and ordered lists keep their captured start.
 */
function renderList(
  node: Readonly<Record<string, unknown>>,
  rendering: Rendering,
  depth: number,
): string[] {
  const ordered = nodeType(node) === 'orderedList';
  const start = ordered ? orderedStart(node) : 1;
  const indent = '  '.repeat(depth);
  return nodesOf(node.content).flatMap((item, index) => {
    if (!isObject(item)) {
      return [];
    }
    const marker = ordered ? `${String(start + index)}. ` : '- ';
    return renderListItem(item, marker, rendering, depth, indent);
  });
}

/** One list item's children, rendered once in captured order under its enclosing marker. */
function renderListItem(
  item: Readonly<Record<string, unknown>>,
  marker: string,
  rendering: Rendering,
  depth: number,
  indent: string,
): string[] {
  const lines: string[] = [];
  for (const child of nodesOf(item.content)) {
    if (isListNode(child)) {
      if (lines.length === 0) lines.push(`${indent}${marker.trimEnd()}`);
      lines.push(...renderBlock(child, rendering, depth + 1));
    } else {
      for (const line of renderBlock(child, rendering, 0)) {
        lines.push(
          lines.length === 0 ? `${indent}${marker}${line.trimStart()}` : `${indent}  ${line}`,
        );
      }
    }
  }
  return lines.length === 0 ? [`${indent}${marker.trimEnd()}`] : lines;
}

/** One checklist's items: task-item content is inline, with nested lists rendered under it. */
function renderTaskList(
  node: Readonly<Record<string, unknown>>,
  rendering: Rendering,
  depth: number,
): string[] {
  const indent = '  '.repeat(depth);
  return nodesOf(node.content).flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const attrs = isObject(item.attrs) ? item.attrs : {};
    const state = attrs.state === 'DONE' ? 'x' : ' ';
    const lines: string[] = [];
    let inline = '';
    const flushInline = () => {
      const text = inline
        .split('\n')
        .map((line) => line.trim())
        .join(' ');
      if (text !== '' || lines.length === 0) {
        lines.push(
          (lines.length === 0 ? `${indent}- [${state}] ${text}` : `${indent}  ${text}`).trimEnd(),
        );
      }
      inline = '';
    };
    for (const child of nodesOf(item.content)) {
      if (isListNode(child)) {
        flushInline();
        lines.push(...renderBlock(child, rendering, depth + 1));
      } else {
        inline += renderInline(child, rendering);
      }
    }
    flushInline();
    return lines;
  });
}

/** One table cell's readable single-line text; a cell's children are blocks, not inline nodes. */
function tableCellText(cell: Readonly<Record<string, unknown>>, rendering: Rendering): string {
  return renderChildren(cell, rendering, 0)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .trim();
}

function renderTable(
  node: Readonly<Record<string, unknown>>,
  rendering: Rendering,
  depth: number,
): string[] {
  const indent = '  '.repeat(depth);
  const rows = nodesOf(node.content).filter(isObject);
  const lines = rows.map((row) => {
    const cells = nodesOf(row.content).filter(isObject);
    const values = cells.map((cell) => tableCellText(cell, rendering));
    return `${indent}| ${values.join(' | ')} |`;
  });
  const header = rows[0];
  if (
    header !== undefined &&
    nodesOf(header.content).some((cell) => nodeType(cell) === 'tableHeader')
  ) {
    const cells = nodesOf(header.content).filter(isObject);
    lines.splice(1, 0, `${indent}| ${cells.map(() => '---').join(' | ')} |`);
  }
  return lines;
}

/**
 * The document's complete readable rendering, or null when the value is not a rich-text doc the
 * renderer preserves with its captured structure.
 */
function renderDocument(value: unknown, rendering: Rendering): string | null {
  if (!isObject(value) || value.type !== 'doc') {
    return null;
  }
  if (value.content !== undefined && !Array.isArray(value.content)) {
    return null;
  }
  return renderChildren(value, rendering, 0).join('\n');
}

/**
 * The issue fields that carry only provider administration: bookkeeping, people, avatars, status,
 * workflow and tracking. They never enter the readable context; other captured fields are rendered
 * or explicitly identified instead of being silently dropped.
 */
const administrativeIssueFields: ReadonlySet<string> = new Set([
  'id',
  'key',
  'self',
  'expand',
  'issuerestriction',
  'statuscategorychangedate',
  'statusCategory',
  'issuetype',
  'project',
  'components',
  'fixVersions',
  'versions',
  'resolution',
  'resolutiondate',
  'security',
  'priority',
  'watches',
  'votes',
  'creator',
  'reporter',
  'assignee',
  'lastViewed',
  'created',
  'updated',
  'duedate',
  'progress',
  'aggregateprogress',
  'timespent',
  'timeestimate',
  'timeoriginalestimate',
  'aggregatetimespent',
  'aggregatetimeestimate',
  'aggregatetimeoriginalestimate',
  'timetracking',
  'worklog',
  'workratio',
  'status',
]);

/** True when a captured field value carries something worth rendering. */
function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  if (Array.isArray(value)) {
    return value.some(hasContent);
  }
  if (isObject(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

/** One captured value's readable lines; unsupported structures stay explicit. */
function renderValue(value: unknown, rendering: Rendering, indent: string): string[] {
  const document = renderDocument(value, rendering);
  if (document !== null) {
    return document.split('\n').map((line) => `${indent}${line}`);
  }
  if (typeof value === 'string') {
    return value.split('\n').map((line) => `${indent}${line}`);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [`${indent}${String(value)}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => renderValue(entry, rendering, indent));
  }
  return [`${indent}${unsupportedNote(rendering, 'one structured captured value', value)}`];
}

/** One related issue's readable identity: link relation, key, summary, captured type and status. */
function relatedIssueText(
  issue: Readonly<Record<string, unknown>>,
  relation: string | null,
): string | null {
  const fields = isObject(issue.fields) ? issue.fields : null;
  const key = textOf(issue.key) ?? textOf(issue.id);
  const summary = fields === null ? null : textOf(fields.summary);
  if (key === null && summary === null) {
    return null;
  }
  const type = fields !== null && isObject(fields.issuetype) ? textOf(fields.issuetype.name) : null;
  const status = fields !== null && isObject(fields.status) ? textOf(fields.status.name) : null;
  const details = [type, status === null ? null : `status ${status}`].filter(
    (detail): detail is string => detail !== null,
  );
  return (
    `${relation === null ? '' : `${relation} `}${key ?? '[no key captured]'}` +
    `${summary === null ? '' : ` "${summary}"`}` +
    `${details.length === 0 ? '' : ` (${details.join(', ')})`}`
  );
}

/** One issue link's readable relation, resolved against the captured issue this context renders. */
function issueLinkText(link: Readonly<Record<string, unknown>>): string | null {
  const type = isObject(link.type) ? link.type : null;
  const outward = isObject(link.outwardIssue) ? link.outwardIssue : null;
  const inward = isObject(link.inwardIssue) ? link.inwardIssue : null;
  const issue = outward ?? inward;
  if (issue === null) {
    return null;
  }
  const relation =
    type === null
      ? null
      : (textOf(outward !== null ? type.outward : type.inward) ?? textOf(type.name));
  return relatedIssueText(issue, relation);
}

/**
 * One relationship field's readable lines. A parent, subtask or issue link is meaningful evidence:
 * its identity, relation and summary stay readable, and an entry the renderer cannot interpret is
 * explicitly identified for inspection instead of disappearing into the administrative note.
 */
function relationshipLines(
  name: string,
  entries: readonly unknown[],
  textOfEntry: (entry: Readonly<Record<string, unknown>>) => string | null,
  rendering: Rendering,
): string[] {
  return [
    `- ${name}:`,
    ...entries.map((entry) => {
      const text = isObject(entry) ? textOfEntry(entry) : null;
      return text === null
        ? `  ${unsupportedNote(rendering, `one captured ${name} entry`, entry)}`
        : `  - ${text}`;
    }),
  ];
}

/** One non-description captured field's readable lines. */
function renderField(name: string, value: unknown, rendering: Rendering): string[] {
  if (name === 'attachment') {
    // Attachments are captured evidence rather than provider administration: identify them
    // explicitly and point at the retained source instead of silently dropping their content.
    return [
      '- attachment:',
      `  ${unsupportedNote(
        rendering,
        'the captured attachments (files or other non-text evidence)',
        value,
      )}`,
    ];
  }
  if (name === 'parent') {
    return relationshipLines(
      'parent',
      [value],
      (entry) => relatedIssueText(entry, null),
      rendering,
    );
  }
  if (name === 'subtasks') {
    return relationshipLines(
      'subtasks',
      Array.isArray(value) ? value : [value],
      (entry) => relatedIssueText(entry, null),
      rendering,
    );
  }
  if (name === 'issuelinks') {
    return relationshipLines(
      'issuelinks',
      Array.isArray(value) ? value : [value],
      issueLinkText,
      rendering,
    );
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [`- ${name}: ${String(value)}`];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    const joined = value.join(', ');
    return joined.trim() === '' ? [] : [`- ${name}: ${joined}`];
  }
  const rendered = renderValue(value, rendering, '  ');
  return [`- ${name}:`, ...rendered];
}

/** The issue's summary, description and other meaningful captured fields as readable lines. */
function renderIssue(issue: unknown, rendering: Rendering): string[] {
  if (!isObject(issue)) {
    return [unsupportedNote(rendering, 'the captured issue value', issue)];
  }
  const fields = isObject(issue.fields) ? issue.fields : null;
  const lines: string[] = [];
  const summary = fields === null ? null : textOf(fields.summary);
  lines.push(`Summary: ${summary ?? '[no summary captured]'}`);
  if (fields === null) {
    lines.push(unsupportedNote(rendering, 'the captured issue fields', issue));
    return lines;
  }
  if (hasContent(fields.description)) {
    lines.push('Description:');
    lines.push(...renderValue(fields.description, rendering, '  '));
  } else if (fields.description !== undefined && fields.description !== null) {
    lines.push('Description:');
    lines.push(`  ${unsupportedNote(rendering, 'the captured description', fields.description)}`);
  }
  const other = Object.entries(fields).filter(
    ([name, value]) => name !== 'summary' && name !== 'description' && hasContent(value),
  );
  const meaningful = other.filter(([name]) => !administrativeIssueFields.has(name));
  const omitted = other
    .filter(([name]) => administrativeIssueFields.has(name))
    .map(([name]) => name);
  if (meaningful.length > 0) {
    lines.push('Other captured issue fields:');
    for (const [name, value] of meaningful) {
      lines.push(...renderField(name, value, rendering));
    }
  }
  if (omitted.length > 0) {
    lines.push(`Administrative issue fields omitted from this rendering: ${omitted.join(', ')}.`);
  }
  return lines;
}

/** One comment's attributed identity: the captured author, source identity and chronology. */
function commentIdentity(comment: Readonly<Record<string, unknown>>): string {
  const id = textOf(comment.id) ?? 'unknown id';
  const author = isObject(comment.author) ? comment.author : null;
  const name =
    (author === null ? null : (textOf(author.displayName) ?? textOf(author.name))) ?? null;
  const accountId = author === null ? null : textOf(author.accountId);
  const accountType = author === null ? null : textOf(author.accountType);
  const created = textOf(comment.created);
  const source = textOf(comment.self);
  const attribution =
    name === null
      ? 'author not captured (origin uncertain)'
      : `${name}${accountId === null ? '' : ` <${accountId}>`}` +
        `${accountType === null ? '' : ` [${accountType} account]`}`;
  const identity = `Comment ${id} — ${attribution}${created === null ? '' : ` at ${created}`}`;
  return source === null ? identity : `${identity} (source: ${source})`;
}

/** One comment's readable attribution, acknowledgement mark, notes and body. */
function renderComment(
  comment: unknown,
  position: number,
  publications: readonly { readonly kind: string; readonly id: string }[],
  rendering: Rendering,
  notes: readonly string[] = [],
): string[] {
  if (!isObject(comment)) {
    return [
      `${String(position)}. ${unsupportedNote(
        rendering,
        'one captured conversation entry',
        comment,
      )}`,
      ...notes.map((note) => `   ${note}`),
    ];
  }
  const id = textOf(comment.id);
  const publication = id === null ? undefined : publications.find((entry) => entry.id === id);
  const lines = [`${String(position)}. ${commentIdentity(comment)}`];
  if (publication !== undefined) {
    lines.push(
      `   [Nexus publication acknowledgement "${publication.kind}" — a Nexus-authored message, ` +
        'not human direction or an agent assessment.]',
    );
  }
  const updateAuthor = isObject(comment.updateAuthor) ? comment.updateAuthor : null;
  const updated = textOf(comment.updated);
  const created = textOf(comment.created);
  if (updated !== null && updated !== created) {
    const editor =
      updateAuthor === null
        ? null
        : (textOf(updateAuthor.displayName) ?? textOf(updateAuthor.name));
    lines.push(`   (edited${editor === null ? '' : ` by ${editor}`} at ${updated})`);
  }
  lines.push(...notes.map((note) => `   ${note}`));
  if (hasContent(comment.body)) {
    lines.push(...renderValue(comment.body, rendering, '   '));
  } else if (comment.body === undefined || comment.body === null || comment.body === '') {
    lines.push(`   ${inspectionNote('this comment body', rendering.sourcePath)}`);
  } else {
    lines.push(`   ${unsupportedNote(rendering, 'this comment body', comment.body)}`);
  }
  return lines;
}

/**
 * One captured issue's readable requirements rendering for Review: requirements stay directly
 * visible, and content the readable conversion cannot preserve falls back to its complete
 * original captured value instead of an inspection pointer.
 */
export function capturedIssueText(issue: unknown, sourcePath: string): string {
  return renderIssue(issue, losslessRendering(sourcePath)).join('\n');
}

/**
 * One captured Jira conversation entry's readable attribution and complete body for Review: the
 * captured source location and chronology stay attributed, and content the readable conversion
 * cannot preserve falls back to its complete original captured value. Notes are provenance
 * statements the presenting context adds after the entry's identity, such as an uncertain-origin
 * label; they never replace or summarize the captured body.
 */
export function capturedCommentText(settings: {
  readonly comment: unknown;
  readonly position: number;
  readonly sourcePath: string;
  readonly publications: readonly { readonly kind: string; readonly id: string }[];
  readonly notes?: readonly string[];
}): string {
  return renderComment(
    settings.comment,
    settings.position,
    settings.publications,
    losslessRendering(settings.sourcePath),
    settings.notes ?? [],
  ).join('\n');
}

/** The complete readable rendering of one captured `{ issue, conversation }` source. */
export function capturedSourceText(settings: {
  readonly sourcePath: string;
  readonly task: unknown;
  readonly conversation: readonly unknown[];
  readonly publications: readonly { readonly kind: string; readonly id: string }[];
}): string {
  const lines = [
    ...renderIssue(settings.task, inspectionRendering(settings.sourcePath)),
    '',
    settings.conversation.length === 0
      ? 'Conversation: none captured.'
      : 'Conversation (captured order, attributed):',
  ];
  settings.conversation.forEach((comment, index) => {
    lines.push(
      ...renderComment(
        comment,
        index + 1,
        settings.publications,
        inspectionRendering(settings.sourcePath),
      ),
    );
  });
  return lines.join('\n');
}
