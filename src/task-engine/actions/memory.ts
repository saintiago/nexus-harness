import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  canonicalJson,
  disabledMemory,
  type Memory,
  type Observation,
  type RecallResult,
  type RecallScope,
  type RememberResult,
} from '../../memory/index.js';
import { messageOf } from '../../result.js';
import type { EventPublisher } from '../index.js';

/**
 * The integration mapping shared by the actions that call memory: the deterministic query text,
 * the source identity digest and the bounded handling of memory results. Each action owns the
 * extraction from its own artifacts; these helpers only spell the pieces every mapping shares.
 * Memory results never change the business outcome an action returns.
 */

/** The memory capability and execution identity one action's invocations share. */
export type MemoryContext = {
  /** The process's memory capability; disabled and unavailable memories report their state. */
  readonly memory: Memory;
  /** The execution's memory evidence directory: one retrieval record per invocation. */
  readonly evidenceDirectory: string;
  /** The connected project's identity, used as retrieval scope and provenance. */
  readonly project: string;
  /** The executing workflow's name, used as retrieval scope and provenance. */
  readonly workflow: string;
};

/**
 * The inert context an action without a supplied capability uses: memory is disabled, so the
 * action neither recalls nor ingests. Application always supplies the configured context.
 */
export const noMemoryContext: MemoryContext = {
  memory: disabledMemory(),
  evidenceDirectory: '',
  project: '',
  workflow: '',
};

/** The action's memory context, or the inert one when the caller supplied none. */
export function memoryContextOf(context: MemoryContext | undefined): MemoryContext {
  return context ?? noMemoryContext;
}

/** The readable text of one captured value: a string, or a document's text nodes. */
export function readableText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() === '' ? null : value;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const texts: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const element of node) {
        visit(element);
      }
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    for (const [key, nested] of Object.entries(node)) {
      if (key === 'text' && typeof nested === 'string') {
        texts.push(nested);
      } else {
        visit(nested);
      }
    }
  };
  visit(value);
  const text = texts.join(' ').trim();
  return text === '' ? null : text;
}

/** One captured issue's summary and description as deterministic query material. */
export function issueQueryMaterial(issue: unknown): string[] {
  const fields =
    typeof issue === 'object' && issue !== null
      ? (issue as { readonly fields?: unknown }).fields
      : undefined;
  const record =
    typeof fields === 'object' && fields !== null
      ? (fields as Readonly<Record<string, unknown>>)
      : {};
  const summary = readableText(record['summary']);
  const description = readableText(record['description']);
  return [
    ...(summary === null ? [] : [`task summary: ${summary}`]),
    ...(description === null ? [] : [`task description: ${description}`]),
  ];
}

/**
 * The compact first line of every observation: the subject, project, role and the iteration and
 * outcome needed to interpret the statement that follows.
 */
export function observationEnvelope(settings: {
  readonly subjectKind: 'Task' | 'Idea';
  readonly key: string;
  readonly subject: string | null;
  readonly project: string;
  readonly role: string;
  readonly outcome: string;
  /** The round, submission, cycle and revision the statement is bound to. */
  readonly iteration: readonly string[];
}): string {
  return [
    `${settings.subjectKind} ${settings.key}` +
      (settings.subject === null ? '' : ` "${settings.subject}"`),
    `project ${settings.project}`,
    `role ${settings.role}`,
    ...settings.iteration,
    `outcome ${settings.outcome}`,
  ].join(', ');
}

/**
 * The captured idea's issue fields and latest human input, as deterministic query material. The
 * current proposal is the authoritative input; the complete conversation stays in the direct
 * hand-off context instead of the query.
 */
export function capturedIdeaQueryMaterial(input: {
  readonly issue: unknown;
  readonly conversation: readonly unknown[];
}): string[] {
  const latest = input.conversation.at(-1);
  const latestText =
    typeof latest === 'object' && latest !== null
      ? readableText((latest as { readonly body?: unknown }).body)
      : readableText(latest);
  return [
    ...issueQueryMaterial(input.issue),
    ...(latestText === null ? [] : [`latest captured input: ${latestText}`]),
  ];
}

/** The query one invocation searches: role and project identity plus the current material. */
export function retrievalQuery(scope: RecallScope, material: readonly (string | null)[]): string {
  return [
    `role: ${scope.role}`,
    `project: ${scope.project}`,
    `workflow: ${scope.workflow}`,
    ...material.filter((part): part is string => part !== null && part.trim() !== ''),
  ].join('\n');
}

/**
 * The stable source key of one observation: the canonical artifact path, the observation selector
 * and a digest covering the validated artifact material and the extracted content. Identical
 * content at the same source and selector is one observation; changed content is another.
 */
export function observationSourceKey(settings: {
  readonly artifact: string;
  readonly selector: string;
  readonly material: unknown;
}): string {
  const digest = createHash('sha256')
    .update(canonicalJson(settings.material), 'utf8')
    .digest('hex');
  return `${settings.artifact}#${settings.selector}#sha256:${digest}`;
}

/** The retrieval one invocation ran: the identity its evidence and activity are named by. */
export type InvocationRecall = {
  readonly invocationId: string;
  /** The supplemental block to place in the invocation's context, or null when there is none. */
  readonly block: string | null;
};

/**
 * Run one invocation's recall and report its outcome. A missing capability, an empty result and an
 * unavailable provider all continue the invocation without supplemental context.
 */
export async function recallForInvocation(settings: {
  readonly memory: Memory;
  /** The execution's memory evidence directory; the evidence file is named after the invocation. */
  readonly evidenceDirectory: string;
  readonly publish: EventPublisher;
  readonly source: string;
  readonly scope: RecallScope;
  readonly query: string;
}): Promise<InvocationRecall> {
  const invocationId = randomUUID();
  const evidenceFile = path.join(settings.evidenceDirectory, `${invocationId}.json`);
  let result: RecallResult;
  try {
    result = await settings.memory.recall({
      invocationId,
      query: settings.query,
      evidenceFile,
      scope: settings.scope,
    });
  } catch (error) {
    // Memory reports its own failures; a thrown value still must not change the business action.
    result = { kind: 'unavailable', reason: messageOf(error) };
  }
  if (result.kind === 'unavailable') {
    publishMemory(settings.publish, settings.source, {
      outcome: 'recall-unavailable',
      detail: result.reason,
    });
  }
  return {
    invocationId,
    block: result.kind === 'context' ? result.context : null,
  };
}

/** Observe one validated hand-off; memory failures are reported and never thrown to the action. */
export async function rememberObserved(
  settings: {
    readonly memory: Memory;
    readonly publish: EventPublisher;
    readonly source: string;
  },
  observation: Observation,
): Promise<void> {
  let result: RememberResult;
  try {
    result = await settings.memory.remember(observation);
  } catch (error) {
    publishMemory(settings.publish, settings.source, {
      outcome: 'remember-failed',
      detail: messageOf(error),
      sourceKey: observation.sourceKey,
    });
    return;
  }
  switch (result.kind) {
    case 'disabled':
      return;
    case 'stored':
    case 'already-recorded':
      publishMemory(settings.publish, settings.source, {
        outcome: result.kind,
        detail: `note ${result.noteId}`,
        sourceKey: observation.sourceKey,
      });
      return;
    case 'deferred':
    case 'uncertain':
    case 'failed':
      publishMemory(settings.publish, settings.source, {
        outcome: result.kind,
        detail: result.reason,
        sourceKey: observation.sourceKey,
        receipt: result.receipt,
      });
  }
}

/** Report one memory outcome through the execution's normal diagnostics. */
export function publishMemory(
  publish: EventPublisher,
  source: string,
  data: Readonly<Record<string, unknown>>,
): void {
  publish({ source, type: 'memory', data });
}
