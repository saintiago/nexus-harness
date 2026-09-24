/**
 * Event interpretation for presentation. The event stream is the TaskEngine's public event
 * contract, carrying the Application's lifecycle events and the agent activity events; this module
 * reads source, type and data to decide what an operator sees. Unknown events become plain
 * diagnostic lines built from their source and type, so internal identifiers and configuration
 * inventory never reach the live view.
 */

import type { EngineEvent } from '../task-engine/index.js';
import { sanitize } from './text.js';

/** A content color from the OperatorInterface design: the terminal default, or one of its colors. */
export type Style = 'default' | 'white' | 'grey' | 'blue' | 'yellow';

/** The agent roles the activity contract names. */
export type AgentRole = 'developer' | 'reviewer' | 'recovery';

/** The activity kinds the agent activity contract names. */
type ActivityKind = 'message' | 'command' | 'result' | 'change';

/** One supplied event, as the presentation renders it. */
export type Interpretation =
  | {
      readonly kind: 'boundary';
      readonly role: AgentRole;
      readonly operation: string;
      readonly profile: string | null;
      readonly task: string | null;
    }
  | { readonly kind: 'activity'; readonly activity: ActivityKind; readonly text: string }
  | { readonly kind: 'end' }
  | {
      readonly kind: 'progress';
      readonly label: string;
      readonly text: string;
      readonly style: Style;
    };

const applicationSource = 'application';

/** The agent role a value names, or null when it names no role. */
function agentRole(value: string | null): AgentRole | null {
  switch (value) {
    case 'developer':
    case 'reviewer':
    case 'recovery':
      return value;
    default:
      return null;
  }
}

/** The activity kind a value names, or null when it names no kind. */
function activityKind(value: string | null): ActivityKind | null {
  switch (value) {
    case 'message':
    case 'command':
    case 'result':
    case 'change':
      return value;
    default:
      return null;
  }
}

/** The color the design assigns to a role's messages and invocation heading. */
export function roleStyle(role: AgentRole | null): Style {
  switch (role) {
    case 'developer':
      return 'yellow';
    case 'reviewer':
      return 'blue';
    case 'recovery':
      return 'default';
    default:
      return 'default';
  }
}

/** The heading text naming the invocation's operation, task and profile. */
export function boundaryText(boundary: Extract<Interpretation, { kind: 'boundary' }>): string {
  const parts = [boundary.operation];
  if (boundary.task !== null) {
    parts.push(`task ${boundary.task}`);
  }
  if (boundary.profile !== null) {
    parts.push(`profile ${boundary.profile}`);
  }
  return parts.join(' · ');
}

/** One supplied event's data field, when the data carries it as nonempty text. */
function textField(data: unknown, key: string): string | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const value = (data as Record<string, unknown>)[key];
  if (typeof value !== 'string') {
    return null;
  }
  const text = sanitize(value).trim();
  return text === '' ? null : text;
}

/** One supplied event's data field, keeping empty text that is still a present value. */
function activityField(data: unknown, key: string): string | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? sanitize(value) : null;
}

/** The detail a progress event adds to its source and type, when it reports one. */
function progressText(type: string, data: unknown): string {
  const name = textField(data, 'name');
  if (type === 'state' && name !== null) {
    return `state ${name}`;
  }
  const outcome = textField(data, 'outcome');
  const reason = textField(data, 'reason');
  if (type === 'finished' && outcome !== null) {
    return reason === null ? `finished ${outcome}` : `finished ${outcome}: ${reason}`;
  }
  if (reason !== null) {
    return `${type}: ${reason}`;
  }
  if (typeof data === 'string' && sanitize(data).trim() !== '') {
    return `${type}: ${sanitize(data)}`;
  }
  return type;
}

/** Interpret one supplied event for presentation. */
export function interpret(event: EngineEvent): Interpretation {
  const label = sanitize(event.source);
  const type = sanitize(event.type);
  if (type === 'agent-started') {
    const role = agentRole(textField(event.data, 'role'));
    const operation = textField(event.data, 'operation');
    if (role !== null && operation !== null) {
      return {
        kind: 'boundary',
        role,
        operation,
        profile: textField(event.data, 'profile'),
        task: textField(event.data, 'task'),
      };
    }
  } else if (type === 'agent-activity') {
    const activity = activityKind(textField(event.data, 'type'));
    const text = activityField(event.data, 'text');
    if (activity !== null && text !== null) {
      return { kind: 'activity', activity, text };
    }
  } else if (type === 'agent-finished') {
    return { kind: 'end' };
  }
  return {
    kind: 'progress',
    label,
    text: progressText(type, event.data),
    style: label === applicationSource ? 'default' : 'white',
  };
}
