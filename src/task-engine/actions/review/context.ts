import type { PullRequestConversation } from '../../../adapters/github.js';
import { capturedCommentText, capturedValueJson } from '../readable-source.js';

/**
 * Review's directly visible human direction: the captured task and pull-request conversation
 * entries that are not positively identified as automation. Entries keep their complete original
 * bodies, captured order and available identity, chronology, thread and reviewed-revision
 * metadata; confirmed automated publications and the comparison diff stay in the referenced
 * evidence instead. Nothing is summarized or re-classified from prose, a profile prefix or a
 * missing value, so a possible human obligation is never hidden by an inference.
 */

/** One parent-retained publication identity an entry may be acknowledged through. */
export type PublicationIdentity = { readonly kind: string; readonly id: string };

/** One captured conversation entry's origin class. */
export type ConversationEntryOrigin = 'human' | 'uncertain' | 'automation';

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The origin of one captured Jira conversation entry. Automation is identified only through
 * captured account metadata (an app account) or a retained source-owned publication
 * acknowledgement; a captured Atlassian or customer account is human direction. Missing or
 * ambiguous metadata stays uncertain rather than being asserted either way.
 */
export function jiraEntryOrigin(
  entry: unknown,
  publications: readonly PublicationIdentity[],
): ConversationEntryOrigin {
  if (!isObject(entry)) {
    return 'uncertain';
  }
  const id = textOf(entry.id);
  if (id !== null && publications.some((publication) => publication.id === id)) {
    return 'automation';
  }
  const author = isObject(entry.author) ? entry.author : null;
  const accountType = author === null ? null : textOf(author.accountType);
  if (accountType === 'app') {
    return 'automation';
  }
  if (accountType === 'atlassian' || accountType === 'customer') {
    return 'human';
  }
  return 'uncertain';
}

/**
 * The origin of one captured pull-request conversation entry: the configured publication identity
 * and the provider's bot account metadata establish automation, the provider's user metadata
 * establishes a human account, and anything else stays uncertain.
 */
export function pullRequestEntryOrigin(
  entry: unknown,
  nexusLensLogin: string,
): ConversationEntryOrigin {
  if (!isObject(entry)) {
    return 'uncertain';
  }
  const user = isObject(entry.user) ? entry.user : null;
  const login = (user === null ? null : textOf(user.login)) ?? textOf(entry.author);
  if (login !== null && login === nexusLensLogin) {
    return 'automation';
  }
  const accountType = user === null ? null : textOf(user.type);
  if (accountType === 'Bot') {
    return 'automation';
  }
  if (accountType === 'User') {
    return 'human';
  }
  return 'uncertain';
}

/** The explicit note one entry whose origin is not positively human receives. */
const uncertainOriginNote =
  '[Origin uncertain: the captured values do not positively identify this entry as human or ' +
  'automated; treat it as possible human direction and inspect the referenced conversation.]';

/** The introduction every directly presented conversation carries once. */
const directDirectionGuidance = [
  'Direct human direction and uncertain-origin entries (every entry of the captured task and',
  'pull-request conversations that is not positively identified as automation, in captured order,',
  'with its complete original body and available identity, chronology, thread and reviewed-revision',
  'metadata):',
  'Agent assessments and Nexus publications are not human decisions and cannot override human',
  'direction. Conflicting or uncertain direction is preserved as captured instead of being',
  'resolved or summarized; confirmed automated publications are not reproduced here and remain',
  'complete in the referenced conversations. Read that complete local evidence whenever an',
  'earlier concern, conflict or obligation depends on entries this section does not reproduce.',
].join('\n');

/** One captured provider identity value as text, or null when it is not a scalar. */
function identityValue(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : null;
}

/** One pull-request entry's readable attribution line. */
function pullRequestIdentity(entry: Readonly<Record<string, unknown>>, kind: string): string {
  const id = textOf(String(entry.id ?? '')) ?? 'id not captured';
  const user = isObject(entry.user) ? entry.user : null;
  const login = (user === null ? null : textOf(user.login)) ?? textOf(entry.author);
  const accountType = user === null ? null : textOf(user.type);
  const author =
    login === null
      ? 'author not captured'
      : `${login}${accountType === null ? '' : ` [${accountType} account]`}`;
  const created = textOf(entry.created_at) ?? textOf(entry.submitted_at);
  const updated = textOf(entry.updated_at);
  const chronology =
    created === null
      ? ''
      : ` at ${created}${updated === null || updated === created ? '' : ` (edited at ${updated})`}`;
  const parts = [`${kind} ${id} — ${author}${chronology}`];
  const state = textOf(entry.state);
  if (state !== null) {
    parts.push(`state ${state}`);
  }
  // An inline review comment's target stays attached to the instruction: its captured file and
  // line, the revision it reviewed and the review it belongs to.
  const file = textOf(entry.path);
  if (file !== null) {
    const line = identityValue(entry.line) ?? identityValue(entry.original_line);
    parts.push(line === null ? `file ${file}` : `file ${file} line ${line}`);
  }
  const revision = textOf(entry.commit_id);
  if (revision !== null) {
    parts.push(`reviewed revision ${revision}`);
  }
  const originalRevision = textOf(entry.original_commit_id);
  if (originalRevision !== null && originalRevision !== revision) {
    parts.push(`original revision ${originalRevision}`);
  }
  const review = identityValue(entry.pull_request_review_id);
  if (review !== null) {
    parts.push(`review ${review}`);
  }
  const thread = entry.in_reply_to_id;
  if (typeof thread === 'number' || typeof thread === 'string') {
    parts.push(`in reply to ${String(thread)}`);
  }
  const location = textOf(entry.html_url);
  if (location !== null) {
    parts.push(location);
  }
  return parts.join(', ');
}

/** One pull-request entry's readable attribution, optional uncertain note and complete body. */
function pullRequestEntryText(settings: {
  readonly entry: unknown;
  readonly kind: string;
  readonly position: number;
  readonly origin: ConversationEntryOrigin;
  readonly sourcePath: string;
}): string {
  const { entry } = settings;
  if (!isObject(entry)) {
    const original = capturedValueJson(entry);
    const lines = [
      original === null
        ? `${String(settings.position)}. [This rendering does not display one captured ` +
          `pull-request entry; inspect the captured conversation at "${settings.sourcePath}" ` +
          'before relying on it.]'
        : `${String(settings.position)}. [This rendering does not display one captured ` +
          `pull-request entry as readable text; original captured value: ${original}]`,
    ];
    if (settings.origin === 'uncertain') {
      lines.push(`   ${uncertainOriginNote}`);
    }
    return lines.join('\n');
  }
  const lines = [`${String(settings.position)}. ${pullRequestIdentity(entry, settings.kind)}`];
  if (settings.origin === 'uncertain') {
    lines.push(`   ${uncertainOriginNote}`);
  }
  const body = typeof entry.body === 'string' ? entry.body : null;
  if (body !== null && body.trim() !== '') {
    lines.push(...body.split('\n').map((line) => (line === '' ? '' : `   ${line}`)));
  } else if (body === '') {
    lines.push('   (this entry has an empty body)');
  } else if (entry.body === undefined || entry.body === null) {
    lines.push(
      `   [This rendering does not display this entry's body; inspect the captured conversation ` +
        `at "${settings.sourcePath}" before relying on it.]`,
    );
  } else {
    const original = capturedValueJson(entry.body);
    lines.push(
      original === null
        ? `   [This rendering does not display this entry's body; inspect the captured ` +
            `conversation at "${settings.sourcePath}" before relying on it.]`
        : `   [This rendering does not display this entry's body as readable text; original ` +
            `captured value: ${original}]`,
    );
  }
  return lines.join('\n');
}

/** The visible entries of one conversation, in captured order, and its automated ones. */
function partitionByOrigin<Entry>(
  entries: readonly Entry[],
  originOf: (entry: Entry) => ConversationEntryOrigin,
): { readonly visible: readonly Entry[]; readonly automated: number } {
  const visible: Entry[] = [];
  let automated = 0;
  for (const entry of entries) {
    if (originOf(entry) === 'automation') {
      automated += 1;
    } else {
      visible.push(entry);
    }
  }
  return { visible, automated };
}

/** The statement one conversation makes about entries omitted as confirmed automation. */
function automatedStatement(count: number): string[] {
  return count === 0
    ? []
    : [
        `Confirmed automated entries omitted from this section (not human direction; complete ` +
          `captured values remain in the reference): ${String(count)}.`,
      ];
}

/**
 * The directly visible human-direction section, built conservatively from both captured
 * conversations with their complete evidence references.
 */
export function humanDirectionSection(settings: {
  readonly taskKey: string;
  readonly issueId: string;
  readonly taskConversation: readonly unknown[];
  readonly capturedSourcePath: string;
  readonly publications: readonly PublicationIdentity[];
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestConversation: PullRequestConversation;
  readonly prConversationPath: string;
  readonly nexusLensLogin: string;
}): string {
  const task = partitionByOrigin(settings.taskConversation, (entry) =>
    jiraEntryOrigin(entry, settings.publications),
  );
  const taskLines =
    task.visible.length === 0
      ? ['No captured task-conversation entry requires direct presentation.']
      : task.visible.map((entry, index) =>
          capturedCommentText({
            comment: entry,
            position: index + 1,
            sourcePath: settings.capturedSourcePath,
            publications: settings.publications,
            notes:
              jiraEntryOrigin(entry, settings.publications) === 'uncertain'
                ? [uncertainOriginNote]
                : [],
          }),
        );

  const pullRequestEntries: readonly { readonly kind: string; readonly entry: unknown }[] = [
    ...settings.pullRequestConversation.comments.map((entry) => ({
      kind: 'Comment',
      entry,
    })),
    ...settings.pullRequestConversation.reviews.map((entry) => ({ kind: 'Review', entry })),
    ...settings.pullRequestConversation.reviewComments.map((entry) => ({
      kind: 'Inline review comment',
      entry,
    })),
  ];
  const pullRequest = partitionByOrigin(pullRequestEntries, (candidate) =>
    pullRequestEntryOrigin(candidate.entry, settings.nexusLensLogin),
  );
  const pullRequestLines =
    pullRequest.visible.length === 0
      ? ['No captured pull-request-conversation entry requires direct presentation.']
      : pullRequest.visible.map((candidate, index) =>
          pullRequestEntryText({
            entry: candidate.entry,
            kind: candidate.kind,
            position: index + 1,
            origin: pullRequestEntryOrigin(candidate.entry, settings.nexusLensLogin),
            sourcePath: settings.prConversationPath,
          }),
        );

  return [
    directDirectionGuidance,
    `Task conversation (Jira issue ${settings.taskKey}, issue ${settings.issueId}; complete ` +
      `captured conversation at ${settings.capturedSourcePath}):`,
    ...taskLines,
    ...automatedStatement(task.automated),
    `Pull-request conversation (${settings.repository} pull request ` +
      `${String(settings.pullRequestNumber)}; captured comments, reviews and inline review ` +
      `comments in their captured order; complete captured conversation at ` +
      `${settings.prConversationPath}):`,
    ...pullRequestLines,
    ...automatedStatement(pullRequest.automated),
  ].join('\n');
}
