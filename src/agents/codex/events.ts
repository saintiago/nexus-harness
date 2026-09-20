/**
 * Reading the runtime's JSON event stream: what one runtime process reported
 * about itself, and what a line that is not an event means.
 *
 * Event types this adapter does not know are ignored on purpose — the interface
 * is read for what the turn reported, not validated against a list that would
 * then have to keep up with the CLI — while a line that is not an event at all
 * is counted, because an interface that is not the one this adapter was written
 * for is exactly what an incomplete completion has to be reported as.
 *
 * The activity lines it reads are a copy for the terminal, never a replacement
 * for the stream: the turn's own log keeps every event, nothing here decides an
 * outcome, and what a command was asked to run is taken from the launch wrapper
 * the runtime reported it through rather than guessed at.
 */
import type { AgentActivity, TerminationOutcome } from '../../shared/types.js';

/** What one runtime process reported about itself, as this adapter reads it. */
export interface RuntimeReport {
  /** The last complete agent message: the runtime's own account of the turn. */
  summary: string | null;
  /** The session the runtime opened, for the turn's log. Never resumed here. */
  sessionId: string | null;
  /** Whether the runtime reported that the turn completed. */
  completed: boolean;
  /** What the runtime reported as a failure, if it reported one. */
  failure: string | null;
  /** How many output lines were not JSON events, and the first of them. */
  unreadable: number;
  firstUnreadable: string | null;
}

/** What one runtime process did, before it is read as a turn or as a failure. */
export interface RuntimeOutcome {
  readonly launchError: string | null;
  /** Whether the run's stop request is why the runtime was stopped. */
  readonly stopped: boolean;
  readonly termination: TerminationOutcome | null;
  readonly terminationProblem: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly report: RuntimeReport;
  /** The beginning of what the runtime wrote to standard error, for a reason. */
  readonly stderrHead: string;
}
/** A parsed JSON object with a `type`, or `null` for anything else on the stream. */
export function parseEvent(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return typeof record['type'] === 'string' ? record : null;
}

/** The text of a completed agent message, or `null` when the item is another kind. */
export function agentMessage(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  if (record['type'] !== 'agent_message') {
    return null;
  }
  const text = record['text'];
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

/** What a failure event says, where the documented failures carry their message. */
export function failureText(event: Record<string, unknown>): string | null {
  const error = event['error'];
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.trim() !== '') {
      return message;
    }
  }
  const message = event['message'];
  return typeof message === 'string' && message.trim() !== '' ? message : null;
}

/** How much of a command one activity line keeps. Messages are unabridged. */
const MAX_ACTIVITY_CHARS = 400;

/**
 * How much of a command a completion line repeats to say which operation it
 * belongs to, and how much of that command's own output it quotes. Both are
 * smaller than the activity bound, so a long command cannot crowd its outcome
 * and its excerpt out of the line.
 */
const RESULT_OPERATION_CHARS = 160;
const RESULT_EXCERPT_CHARS = 160;

const graphemes = new Intl.Segmenter();

/** One runtime string flattened onto one line and bounded, or `null` for no text. */
function activityText(value: unknown, max: number = MAX_ACTIVITY_CHARS): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat === '') {
    return null;
  }
  if (flat.length <= max) {
    return flat;
  }
  // Keep the existing size bound without splitting a cluster before the CLI
  // has a chance to fit it to terminal columns. Full text stays in the log.
  let end = 0;
  for (const { segment, index } of graphemes.segment(flat)) {
    if (index + segment.length > max) {
      break;
    }
    end = index + segment.length;
  }
  return `${flat.slice(0, end)}…`;
}

/** One token of a command line: its raw text and the offset just after it. */
interface CommandToken {
  readonly text: string;
  readonly end: number;
}

/** Whether one character separates tokens. */
function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

/**
 * Splits a command line into its shell tokens. Only the boundaries matter here —
 * whitespace outside quotes, and the quote characters themselves — so the
 * scanner keeps every character exactly as it was reported and never interprets
 * an escape, a substitution, or a variable.
 */
function commandTokens(command: string): readonly CommandToken[] {
  const tokens: CommandToken[] = [];
  let index = 0;
  while (index < command.length) {
    while (isSpace(command[index])) {
      index += 1;
    }
    if (index >= command.length) {
      break;
    }
    const start = index;
    let quote = '';
    while (index < command.length) {
      const character = command[index] ?? '';
      if (quote === '') {
        if (character === '"' || character === "'") {
          quote = character;
          index += 1;
          continue;
        }
        if (isSpace(character)) {
          break;
        }
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = '';
      }
      index += 1;
    }
    tokens.push({ text: command.slice(start, index), end: index });
  }
  return tokens;
}

/** The program a token names: no surrounding quotes, no directory, lower case. */
function programName(token: string): string {
  let text = token;
  for (const quote of ['"', "'"]) {
    if (text.length > 1 && text.startsWith(quote) && text.endsWith(quote)) {
      text = text.slice(1, -1);
      break;
    }
  }
  const parts = text.split(/[\\/]/);
  return (parts.at(-1) ?? text).toLowerCase();
}

/** How the launcher families this adapter recognizes pass the command through. */
type ShellFamily = 'powershell' | 'cmd' | 'posix';

const SHELL_FAMILIES: ReadonlyMap<string, ShellFamily> = new Map<string, ShellFamily>([
  ['pwsh', 'powershell'],
  ['pwsh.exe', 'powershell'],
  ['powershell', 'powershell'],
  ['powershell.exe', 'powershell'],
  ['cmd', 'cmd'],
  ['cmd.exe', 'cmd'],
  ['sh', 'posix'],
  ['bash', 'posix'],
  ['dash', 'posix'],
  ['zsh', 'posix'],
  ['ksh', 'posix'],
]);

/** Whether one token is this family's own way of naming the command to run. */
function isCommandFlag(family: ShellFamily, token: string): boolean {
  const flag = token.toLowerCase();
  if (family === 'powershell') {
    return flag === '-command' || flag === '-c';
  }
  if (family === 'cmd') {
    return flag === '/c';
  }
  // Recognize only these familiar, case-sensitive POSIX flag clusters.
  // Other letters can select a different mode or consume an option argument.
  return /^-[le]*c$/.test(token);
}

/** Known options that neither consume an argument nor select another input mode. */
function isLauncherOption(family: ShellFamily, token: string): boolean {
  if (family === 'powershell') {
    return ['-noprofile', '-nologo', '-noninteractive'].includes(token.toLowerCase());
  }
  if (family === 'cmd') {
    return ['/d', '/s'].includes(token.toLowerCase());
  }
  return /^-[le]+$/.test(token);
}

/**
 * The command a recognized shell launcher was asked to run, or `null` for a
 * shape this adapter does not recognize.
 *
 * Only the reported line is read, and the payload is the rest of it exactly as
 * it was written — quotes and all — so what a reader sees is what ran, never a
 * re-spelling of it. Nothing is executed, and nothing in the payload is
 * interpreted. A launcher this does not recognize, one whose flag is missing,
 * and one with an empty payload all return `null` and are shown as reported.
 * Before the command flag, only known argument-free launcher options may be
 * skipped. A script operand, file mode, or unfamiliar option ends recognition:
 * a later command-like flag may belong to that script or option instead.
 */
function unwrapCommand(command: string): string | null {
  const tokens = commandTokens(command);
  const program = tokens[0];
  if (program === undefined) {
    return null;
  }
  const family = SHELL_FAMILIES.get(programName(program.text));
  if (family === undefined) {
    return null;
  }
  for (const token of tokens.slice(1)) {
    if (isCommandFlag(family, token.text)) {
      const payload = command.slice(token.end).trim();
      return payload === '' ? null : payload;
    }
    if (!isLauncherOption(family, token.text)) {
      return null;
    }
  }
  return null;
}

/**
 * The operation a command line performs: the payload of a recognized launcher,
 * or the whole line when its shape is not one this adapter knows.
 */
function operationText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return activityText(unwrapCommand(value) ?? value, max);
}

/**
 * The last thing a command's own output said, bounded, or `null` for no output.
 * The last nonblank line is where a summary or an error usually is; nothing is
 * read out of it, so an excerpt can never turn into a claim about the work.
 */
function outputExcerpt(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const lines = value.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = activityText(lines[index], RESULT_EXCERPT_CHARS);
    if (line !== null) {
      return line;
    }
  }
  return null;
}

/**
 * What one completed command reports: the outcome it was observed with, the
 * operation it belongs to, and the last thing that operation's own output said
 * when it said anything. The exit code is repeated, not read as success or
 * failure, and an excerpt is the runtime's own words.
 */
function resultText(item: Record<string, unknown>): string {
  const exitCode = item['exit_code'];
  const outcome =
    typeof exitCode === 'number'
      ? `exit ${String(exitCode)}`
      : (activityText(item['status']) ?? 'finished');
  const operation = operationText(item['command'], RESULT_OPERATION_CHARS);
  const excerpt = outputExcerpt(item['aggregated_output']);
  return [outcome, operation, excerpt].filter((part): part is string => part !== null).join(' — ');
}

/** One entry of a `file_change` item's `changes` array, as an activity line. */
function changeActivity(change: unknown): AgentActivity | null {
  if (typeof change !== 'object' || change === null) {
    return null;
  }
  const record = change as Record<string, unknown>;
  const path = activityText(record['path']);
  if (path === null) {
    return null;
  }
  const kind = activityText(record['kind']);
  return { kind: 'change', text: kind === null ? path : `${kind} ${path}` };
}

/**
 * What one `item.started` or `item.completed` event says the turn is doing, as
 * activity lines for the terminal, or an empty list when it says nothing this
 * display knows how to show.
 *
 * The two event kinds carry the same item at different moments, so what is read
 * depends on both: a command is announced when it starts and its result reported
 * when it ends, while a message and a file change are only read once complete.
 * Everything else — reasoning, plans, event types this adapter does not know —
 * is deliberately not an activity line.
 */
export function itemActivities(eventType: string, item: unknown): readonly AgentActivity[] {
  if (typeof item !== 'object' || item === null) {
    return [];
  }
  const record = item as Record<string, unknown>;
  switch (record['type']) {
    case 'command_execution': {
      if (eventType === 'item.started') {
        const command = operationText(record['command'], MAX_ACTIVITY_CHARS);
        return command === null ? [] : [{ kind: 'command', text: command }];
      }
      if (eventType !== 'item.completed') {
        return [];
      }
      return [{ kind: 'result', text: resultText(record) }];
    }
    case 'agent_message': {
      const text = eventType === 'item.completed' ? activityText(record['text'], Infinity) : null;
      return text === null ? [] : [{ kind: 'message', text }];
    }
    case 'file_change': {
      if (eventType !== 'item.completed' || !Array.isArray(record['changes'])) {
        return [];
      }
      return record['changes']
        .map((change) => changeActivity(change))
        .filter((activity): activity is AgentActivity => activity !== null);
    }
    default:
      return [];
  }
}
