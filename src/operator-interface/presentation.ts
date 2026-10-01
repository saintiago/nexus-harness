/**
 * Event interpretation for presentation. The event stream is the TaskEngine's public event
 * contract, carrying the Application's lifecycle events and each agent invocation's boundaries;
 * attributable activity arrives on Application's separate activity subscription. This module reads
 * source, type and data to decide what an operator sees. Unknown events become plain diagnostic
 * lines built from their source and type, so internal identifiers and configuration inventory
 * never reach the live view.
 */

import { actionOutcomeType, type AgentActivity, type EngineEvent } from '../task-engine/index.js';
import { ideaRoles, type IdeaRole } from '../agent-runtime/index.js';
import { sanitize } from './text.js';

/** A content color from the OperatorInterface design: the terminal default, or one of its colors. */
export type Style = 'default' | 'white' | 'grey' | 'blue' | 'yellow';

/** The agent roles the activity contract names. */
export type AgentRole = 'developer' | 'reviewer' | 'recovery' | IdeaRole;

/** The activity kinds the agent activity contract names. */
type ActivityKind = 'message' | 'command' | 'result' | 'change' | 'diagnostic';

/** One supplied event, as the presentation renders it. */
export type Interpretation =
  | {
      readonly kind: 'boundary';
      /** The invocation the boundary opened; panes and activity match on this identity. */
      readonly invocationId: string;
      readonly role: AgentRole;
      readonly operation: string;
      readonly profile: string | null;
      readonly task: string | null;
      readonly idea: string | null;
      /** The task's or idea's source Summary shown beside its key, when the caller supplied one. */
      readonly summary: string | null;
    }
  | { readonly kind: 'end'; readonly invocationId: string }
  | {
      readonly kind: 'progress';
      readonly label: string;
      readonly text: string;
      readonly style: Style;
    };

/** One activity entry, interpreted for the pane its invocation owns. */
export type ActivityInterpretation = {
  readonly invocationId: string;
  readonly activity: ActivityKind;
  readonly text: string;
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
      return ideaRoles.find((role) => role === value) ?? null;
  }
}

/** The activity kind a value names, or null when it names no kind. */
function activityKind(value: string | null): ActivityKind | null {
  switch (value) {
    case 'message':
    case 'command':
    case 'result':
    case 'change':
    case 'diagnostic':
      return value;
    default:
      return null;
  }
}

/** The color the design assigns to a role's messages and invocation heading. */
export function roleStyle(role: AgentRole | null): Style {
  switch (role) {
    case 'developer':
    case 'idea-editor':
    case 'researcher':
    case 'project-guide':
      return 'yellow';
    case 'reviewer':
    case 'challenger':
      return 'blue';
    case 'recovery':
      return 'default';
    default:
      return 'default';
  }
}

/**
 * One named source ticket: its key with the Summary the operator sees alongside it, when the
 * invocation's caller supplied one.
 */
function ticketText(kind: 'task' | 'idea', key: string, summary: string | null): string {
  return summary === null ? `${kind} ${key}` : `${kind} ${key} "${summary}"`;
}

/** The heading text naming the invocation's operation, task or idea and profile. */
export function boundaryText(boundary: Extract<Interpretation, { kind: 'boundary' }>): string {
  const parts = [boundary.operation];
  if (boundary.task !== null) {
    parts.push(ticketText('task', boundary.task, boundary.summary));
  }
  if (boundary.idea !== null) {
    parts.push(ticketText('idea', boundary.idea, boundary.summary));
  }
  if (boundary.profile !== null) {
    parts.push(`profile ${boundary.profile}`);
  }
  return parts.join(' · ');
}

/**
 * The state names one state observation carries, flattened for a single line. A sequential state
 * names one node; a parallel state names every active region, so the operator sees them all.
 */
function stateText(value: unknown): string | null {
  if (typeof value === 'string') {
    return sanitize(value);
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const parts = Object.entries(value).flatMap(([key, nested]) => {
    const text = stateText(nested);
    return text === null ? [] : [`${key}.${text}`];
  });
  return parts.length === 0 ? null : parts.join(', ');
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

/** One supplied event's data field, when the data carries it as a positive whole number. */
function countField(data: unknown, key: string): number | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** True when the data carries the named saved-artifact reference, whose path is never shown. */
function hasArtifactRef(data: unknown, key: string): boolean {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const value = (data as Record<string, unknown>)[key];
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const artifactPath = (value as Record<string, unknown>)['path'];
  return typeof artifactPath === 'string' && artifactPath !== '';
}

/**
 * The milestone line an action outcome event renders as: task, round or council cycle when the
 * action names one, the returned outcome and the producer's short detail. The artifact path is
 * never rendered.
 */
function outcomeMilestone(data: unknown): string | null {
  const task = textField(data, 'task');
  const outcome = textField(data, 'outcome');
  if (task === null || outcome === null) {
    return null;
  }
  const parts = [`task ${task}`];
  const round = countField(data, 'round');
  if (round !== null) {
    parts.push(`round ${String(round)}`);
  }
  const cycle = countField(data, 'cycle');
  if (cycle !== null) {
    parts.push(`cycle ${String(cycle)}`);
  }
  parts.push(outcome);
  const detail = textField(data, 'detail');
  if (detail !== null) {
    parts.push(detail);
  }
  return parts.join(' · ');
}

/** The milestone line a saved recovery report renders as; its path stays out of the terminal. */
function recoveredMilestone(data: unknown): string | null {
  const decision = textField(data, 'decision');
  if (decision === null || !hasArtifactRef(data, 'report')) {
    return null;
  }
  return `recovered ${decision} · report saved`;
}

/** The detail a progress event adds to its source and type, when it reports one. */
function progressText(type: string, data: unknown): string {
  if (type === 'state') {
    const value =
      typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>)['value']
        : undefined;
    const name = stateText(value);
    if (name !== null) {
      return `state ${name}`;
    }
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
    const role = agentRole(textField(event.data, 'agentName'));
    const operation = textField(event.data, 'operation');
    const invocationId = textField(event.data, 'invocationId');
    if (role !== null && operation !== null && invocationId !== null) {
      return {
        kind: 'boundary',
        invocationId,
        role,
        operation,
        profile: textField(event.data, 'profile'),
        task: textField(event.data, 'task'),
        idea: textField(event.data, 'idea'),
        summary: textField(event.data, 'summary'),
      };
    }
  } else if (type === 'agent-finished') {
    const invocationId = textField(event.data, 'invocationId');
    if (invocationId !== null) {
      return { kind: 'end', invocationId };
    }
  } else if (type === actionOutcomeType) {
    const text = outcomeMilestone(event.data);
    if (text !== null) {
      return { kind: 'progress', label, text, style: 'white' };
    }
  } else if (type === 'recovered') {
    const text = recoveredMilestone(event.data);
    if (text !== null) {
      return { kind: 'progress', label, text, style: 'default' };
    }
  }
  return {
    kind: 'progress',
    label,
    text: progressText(type, event.data),
    style: label === applicationSource ? 'default' : 'white',
  };
}

/** Interpret one attributable activity entry for its pane; null when it names no activity kind. */
export function interpretActivity(activity: AgentActivity): ActivityInterpretation | null {
  const kind = activityKind(activity.activity.type);
  if (kind === null) {
    return null;
  }
  return {
    invocationId: activity.invocationId,
    activity: kind,
    text: sanitize(activity.activity.text),
  };
}
