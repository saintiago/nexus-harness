import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../../../result.js';

/**
 * The readable rendering of one invocation's captured preparation source: the issue's summary,
 * rich-text description and other meaningful fields plus the attributed conversation. The
 * preparation action renders the captured values directly, without another agent invocation or a
 * generated summary, so human intent, conflicts and evidence keep their meaning and attribution
 * while administrative provider envelopes stay out of the prompt. The exact captured
 * `{ issue, conversation }` is retained beside the invocation's report for later inspection.
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
function renderInline(node: unknown, sourcePath: string): string {
  const type = nodeType(node);
  if (type === null) {
    return isObject(node) ? inspectionNote('captured content at this position', sourcePath) : '';
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
        inspectionNote(`${type} content`, sourcePath)
      );
    case 'inlineCard': {
      const url = textOf(attrs.url);
      return url ?? inspectionNote('an inline card', sourcePath);
    }
    case 'date': {
      const timestamp = attrs.timestamp;
      return typeof timestamp === 'number'
        ? new Date(timestamp).toISOString()
        : inspectionNote('a date', sourcePath);
    }
    default:
      return inspectionNote(`a Jira "${type}" node`, sourcePath);
  }
}

/** The inline text of one block's content, joined without separators. */
function renderInlineChildren(node: Readonly<Record<string, unknown>>, sourcePath: string): string {
  return nodesOf(node.content)
    .map((child) => renderInline(child, sourcePath))
    .join('');
}

/** One node's block lines; unsupported block content is identified explicitly. */
function renderBlock(node: unknown, sourcePath: string, depth: number): string[] {
  const type = nodeType(node);
  if (!isObject(node)) {
    return [];
  }
  const indent = '  '.repeat(depth);
  const attrs = isObject(node.attrs) ? node.attrs : {};
  switch (type) {
    case 'paragraph': {
      const text = renderInlineChildren(node, sourcePath);
      return text === '' ? [] : text.split('\n').map((line) => `${indent}${line}`);
    }
    case 'heading': {
      const level =
        typeof attrs.level === 'number' && attrs.level >= 1 && attrs.level <= 6 ? attrs.level : 2;
      return [`${indent}${'#'.repeat(level)} ${renderInlineChildren(node, sourcePath)}`];
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
      return renderChildren(node, sourcePath, depth).map((line) => `${indent}> ${line}`);
    case 'rule':
      return [`${indent}---`];
    case 'bulletList':
    case 'orderedList':
      return renderList(node, sourcePath, depth);
    case 'taskList':
      return renderTaskList(node, sourcePath, depth);
    case 'decisionList':
      return nodesOf(node.content).flatMap((item) =>
        isObject(item) ? [`${indent}- ${renderInlineChildren(item, sourcePath)}`] : [],
      );
    case 'table':
      return renderTable(node, sourcePath, depth);
    case 'panel':
      return renderChildren(node, sourcePath, depth).map((line) => `${indent}> ${line}`);
    case 'expand':
    case 'nestedExpand': {
      const title = textOf(attrs.title);
      return [
        `${indent}${title === null ? '[collapsed section]' : `[collapsed section: ${title}]`}`,
        ...renderChildren(node, sourcePath, depth + 1),
      ];
    }
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
    case 'mediaInline':
      return [`${indent}${inspectionNote('embedded media (an image or attachment)', sourcePath)}`];
    case 'layout':
    case 'layoutSection':
    case 'layoutColumn':
    case 'doc':
      return renderChildren(node, sourcePath, depth);
    default:
      return [`${indent}${inspectionNote(`a Jira "${type}" node`, sourcePath)}`];
  }
}

function renderChildren(
  node: Readonly<Record<string, unknown>>,
  sourcePath: string,
  depth: number,
): string[] {
  return nodesOf(node.content).flatMap((child) => renderBlock(child, sourcePath, depth));
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
  sourcePath: string,
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
    return renderListItem(item, marker, sourcePath, depth, indent);
  });
}

/** One list item's children, rendered once in captured order under its enclosing marker. */
function renderListItem(
  item: Readonly<Record<string, unknown>>,
  marker: string,
  sourcePath: string,
  depth: number,
  indent: string,
): string[] {
  const lines: string[] = [];
  for (const child of nodesOf(item.content)) {
    if (isListNode(child)) {
      if (lines.length === 0) lines.push(`${indent}${marker.trimEnd()}`);
      lines.push(...renderBlock(child, sourcePath, depth + 1));
    } else {
      for (const line of renderBlock(child, sourcePath, 0)) {
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
  sourcePath: string,
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
        lines.push(...renderBlock(child, sourcePath, depth + 1));
      } else {
        inline += renderInline(child, sourcePath);
      }
    }
    flushInline();
    return lines;
  });
}

/** One table cell's readable single-line text; a cell's children are blocks, not inline nodes. */
function tableCellText(cell: Readonly<Record<string, unknown>>, sourcePath: string): string {
  return renderChildren(cell, sourcePath, 0)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .trim();
}

function renderTable(
  node: Readonly<Record<string, unknown>>,
  sourcePath: string,
  depth: number,
): string[] {
  const indent = '  '.repeat(depth);
  const rows = nodesOf(node.content).filter(isObject);
  const lines = rows.map((row) => {
    const cells = nodesOf(row.content).filter(isObject);
    const values = cells.map((cell) => tableCellText(cell, sourcePath));
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

/** The document's complete readable rendering, or null when the value is not a rich-text doc. */
function renderDocument(value: unknown, sourcePath: string): string | null {
  if (!isObject(value) || value.type !== 'doc') {
    return null;
  }
  return renderChildren(value, sourcePath, 0).join('\n');
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
function renderValue(value: unknown, sourcePath: string, indent: string): string[] {
  const document = renderDocument(value, sourcePath);
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
    return value.flatMap((entry) => renderValue(entry, sourcePath, indent));
  }
  return [`${indent}${inspectionNote('one structured captured value', sourcePath)}`];
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
  sourcePath: string,
): string[] {
  return [
    `- ${name}:`,
    ...entries.map((entry) => {
      const text = isObject(entry) ? textOfEntry(entry) : null;
      return text === null
        ? `  ${inspectionNote(`one captured ${name} entry`, sourcePath)}`
        : `  - ${text}`;
    }),
  ];
}

/** One non-description captured field's readable lines. */
function renderField(name: string, value: unknown, sourcePath: string): string[] {
  if (name === 'attachment') {
    // Attachments are captured evidence rather than provider administration: identify them
    // explicitly and point at the retained source instead of silently dropping their content.
    return [
      '- attachment:',
      `  ${inspectionNote('the captured attachments (files or other non-text evidence)', sourcePath)}`,
    ];
  }
  if (name === 'parent') {
    return relationshipLines(
      'parent',
      [value],
      (entry) => relatedIssueText(entry, null),
      sourcePath,
    );
  }
  if (name === 'subtasks') {
    return relationshipLines(
      'subtasks',
      Array.isArray(value) ? value : [value],
      (entry) => relatedIssueText(entry, null),
      sourcePath,
    );
  }
  if (name === 'issuelinks') {
    return relationshipLines(
      'issuelinks',
      Array.isArray(value) ? value : [value],
      issueLinkText,
      sourcePath,
    );
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [`- ${name}: ${String(value)}`];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    const joined = value.join(', ');
    return joined.trim() === '' ? [] : [`- ${name}: ${joined}`];
  }
  const rendered = renderValue(value, sourcePath, '  ');
  return [`- ${name}:`, ...rendered];
}

/** The issue's summary, description and other meaningful captured fields as readable lines. */
function renderIssue(issue: unknown, sourcePath: string): string[] {
  if (!isObject(issue)) {
    return [inspectionNote('the captured issue value', sourcePath)];
  }
  const fields = isObject(issue.fields) ? issue.fields : null;
  const lines: string[] = [];
  const summary = fields === null ? null : textOf(fields.summary);
  lines.push(`Summary: ${summary ?? '[no summary captured]'}`);
  if (fields === null) {
    lines.push(inspectionNote('the captured issue fields', sourcePath));
    return lines;
  }
  if (hasContent(fields.description)) {
    lines.push('Description:');
    lines.push(...renderValue(fields.description, sourcePath, '  '));
  } else if (fields.description !== undefined && fields.description !== null) {
    lines.push('Description:');
    lines.push(`  ${inspectionNote('the captured description', sourcePath)}`);
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
      lines.push(...renderField(name, value, sourcePath));
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
  const attribution =
    name === null
      ? 'author not captured (origin uncertain)'
      : `${name}${accountId === null ? '' : ` <${accountId}>`}` +
        `${accountType === null ? '' : ` [${accountType} account]`}`;
  return `Comment ${id} — ${attribution}${created === null ? '' : ` at ${created}`}`;
}

/** One comment's readable attribution, acknowledgement mark and body. */
function renderComment(
  comment: unknown,
  position: number,
  publications: readonly { readonly kind: string; readonly id: string }[],
  sourcePath: string,
): string[] {
  if (!isObject(comment)) {
    return [
      `${String(position)}. ${inspectionNote('one captured conversation entry', sourcePath)}`,
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
  if (updated !== null && updated !== created && updateAuthor !== null) {
    const editor = textOf(updateAuthor.displayName) ?? textOf(updateAuthor.name);
    lines.push(`   (edited${editor === null ? '' : ` by ${editor}`} at ${updated})`);
  }
  if (hasContent(comment.body)) {
    lines.push(...renderValue(comment.body, sourcePath, '   '));
  } else {
    lines.push(`   ${inspectionNote('this comment body', sourcePath)}`);
  }
  return lines;
}

/** The complete readable rendering of one captured `{ issue, conversation }` source. */
export function capturedSourceText(settings: {
  readonly sourcePath: string;
  readonly task: unknown;
  readonly conversation: readonly unknown[];
  readonly publications: readonly { readonly kind: string; readonly id: string }[];
}): string {
  const lines = [
    ...renderIssue(settings.task, settings.sourcePath),
    '',
    settings.conversation.length === 0
      ? 'Conversation: none captured.'
      : 'Conversation (captured order, attributed):',
  ];
  settings.conversation.forEach((comment, index) => {
    lines.push(...renderComment(comment, index + 1, settings.publications, settings.sourcePath));
  });
  return lines.join('\n');
}
