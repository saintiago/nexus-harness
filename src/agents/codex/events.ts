/**
 * Reading the runtime's JSON event stream: what one runtime process reported
 * about itself, and what a line that is not an event means.
 *
 * Event types this adapter does not know are ignored on purpose — the interface
 * is read for what the turn reported, not validated against a list that would
 * then have to keep up with the CLI — while a line that is not an event at all
 * is counted, because an interface that is not the one this adapter was written
 * for is exactly what an incomplete completion has to be reported as.
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

/** How much of a command or a message one activity line keeps. */
const MAX_ACTIVITY_CHARS = 400;
const graphemes = new Intl.Segmenter();

/** One runtime string flattened onto one line, bounded, or `null` for no text. */
function activityText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat === '') {
    return null;
  }
  if (flat.length <= MAX_ACTIVITY_CHARS) {
    return flat;
  }
  // Keep the existing size bound without splitting a cluster before the CLI
  // has a chance to fit it to terminal columns. Full text stays in the log.
  let end = 0;
  for (const { segment, index } of graphemes.segment(flat)) {
    if (index + segment.length > MAX_ACTIVITY_CHARS) {
      break;
    }
    end = index + segment.length;
  }
  return `${flat.slice(0, end)}…`;
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
        const command = activityText(record['command']);
        return command === null ? [] : [{ kind: 'command', text: command }];
      }
      if (eventType !== 'item.completed') {
        return [];
      }
      const exitCode = record['exit_code'];
      if (typeof exitCode === 'number') {
        return [{ kind: 'result', text: `exit ${String(exitCode)}` }];
      }
      const status = activityText(record['status']);
      return [{ kind: 'result', text: status ?? 'finished' }];
    }
    case 'agent_message': {
      const text = eventType === 'item.completed' ? activityText(record['text']) : null;
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
