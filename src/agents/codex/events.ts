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
import type { TerminationOutcome } from '../../shared/types.js';

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
