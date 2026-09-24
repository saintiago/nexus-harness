import type {
  JiraAdapter,
  JiraComment,
  JiraDocument,
  JiraFieldUpdates,
  JiraIssue,
  JiraTransition,
} from '../../adapters/jira.js';
import type { Result } from '../../result.js';

/**
 * The current task source's read and update mechanics, shared by the actions that refresh or
 * advance a task. Adapter failures are execution errors; what a source state means to the workflow
 * stays with the calling action.
 */

/** The value of one successful source operation; a fault is the execution error actions report. */
async function requireSuccess<Value>(
  operation: Result<Value> | Promise<Result<Value>>,
): Promise<Value> {
  const result = await operation;
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  return result.value;
}

/** Read one issue; a source access failure is an execution error. */
export async function readIssue(jira: JiraAdapter, issueId: string): Promise<JiraIssue> {
  return requireSuccess(jira.readIssue(issueId));
}

/** Read one issue's complete conversation; a source access failure is an execution error. */
export async function readComments(jira: JiraAdapter, issueId: string): Promise<JiraComment[]> {
  return [...(await requireSuccess(jira.readComments(issueId)))];
}

/**
 * Narrow one captured Jira transition value. A captured selection stores provider values as they
 * were read; applying the move later needs the transition's identity and destination.
 */
export function capturedTransition(value: unknown): JiraTransition | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { readonly id?: unknown; readonly to?: unknown };
  const to = candidate.to as { readonly name?: unknown } | undefined;
  if (typeof candidate.id !== 'string' || typeof to?.name !== 'string') {
    return null;
  }
  return value as JiraTransition;
}

/** The issue's current status name, or null when the field cannot be read. */
export function statusNameOf(issue: JiraIssue): string | null {
  const status = issue.fields.status;
  if (typeof status !== 'object' || status === null) {
    return null;
  }
  const name = (status as { readonly name?: unknown }).name;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/** Update one issue's configured fields; a source failure is an execution error. */
export async function updateIssueFields(
  jira: JiraAdapter,
  issueId: string,
  fields: JiraFieldUpdates,
): Promise<void> {
  await requireSuccess(jira.updateFields(issueId, fields));
}

/** A permitted transition into a status, or the reason none is permitted. */
type TransitionIntoStatus =
  | { readonly kind: 'permitted'; readonly transition: JiraTransition }
  | { readonly kind: 'blocked'; readonly reason: string };

/** Find the permitted transition moving one issue into the named status. */
export async function transitionInto(
  jira: JiraAdapter,
  issue: JiraIssue,
  status: string,
): Promise<TransitionIntoStatus> {
  const transitions = await requireSuccess(jira.readTransitions(issue.id));
  const transition = transitions.find((candidate) => candidate.to.name === status);
  if (transition === undefined) {
    return {
      kind: 'blocked',
      reason:
        `No permitted Jira transition moves ${issue.key} from ` +
        `${statusNameOf(issue) ?? 'its current status'} to "${status}".`,
    };
  }
  return { kind: 'permitted', transition };
}

/** Move one issue through the permitted transition; a source failure is an execution error. */
export async function applyTransition(
  jira: JiraAdapter,
  issueId: string,
  transition: JiraTransition,
): Promise<void> {
  await requireSuccess(jira.transitionIssue(issueId, transition.id));
}

/**
 * Publish one Nexus document as a comment unless the issue already carries the same comment. The
 * existing or created comment is returned, so a caller can record the identity it published.
 */
export async function publishDocument(
  jira: JiraAdapter,
  issueId: string,
  comments: readonly JiraComment[],
  document: JiraDocument,
): Promise<JiraComment> {
  const published = JSON.stringify(document);
  const existing = comments.find((comment) => JSON.stringify(comment.body) === published);
  if (existing !== undefined) {
    return existing;
  }
  return await requireSuccess(jira.addComment(issueId, document));
}

/** Publish one Nexus comment to the ticket unless the issue already carries the same comment. */
export async function publishComment(
  jira: JiraAdapter,
  issueId: string,
  comments: readonly JiraComment[],
  text: string,
): Promise<void> {
  const document: JiraDocument = {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
  await publishDocument(jira, issueId, comments, document);
}
