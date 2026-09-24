import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AnyStateMachine } from 'xstate';
import type { AgentEvent, AgentResult } from '../agent-runtime/index.js';
import type { ArtifactRef, Result } from '../result.js';
import { createExecutionRunner, type BoundAction } from './execution-runner.js';

/**
 * TaskEngine executes a task workflow supplied as an XState definition. ExecutionRunner is the
 * thin XState integration; the supplied bound actions own task-specific behavior.
 */

export type { BoundAction } from './execution-runner.js';

/** The workflow's terminal outcome, or the fault that explains an execution failure. */
export type WorkflowResult = Result<string>;

/** One progress event. Producers own their types and data contracts. */
export type EngineEvent = {
  readonly source: string;
  readonly type: string;
  readonly data: unknown;
};

export type EventListener = (event: EngineEvent) => void;

export type Unsubscribe = () => void;

export type EventPublisher = (event: EngineEvent) => void;

/**
 * One agent invocation's caller-assigned identity. The caller of AgentRuntime.run assigns the role
 * name, the unique invocation ID and the Unix start time, and names the invocation's own activity
 * log. See the agent activity events contract.
 */
export type AgentInvocation = {
  readonly agentName: string;
  readonly invocationId: string;
  readonly startedAtUnixMs: number;
  readonly log: ArtifactRef;
};

/** One activity entry, attributed to the invocation that reported it. */
export type AgentActivity = {
  readonly invocationId: string;
  /** The ISO timestamp when the invocation's caller received the entry. */
  readonly timestamp: string;
  readonly activity: AgentEvent;
};

/** How one invocation ended. A finished event reports the end, never task success. */
export type AgentInvocationResult =
  { readonly outcome: 'finished' } | { readonly outcome: 'failed'; readonly reason: string };

export type AgentActivityListener = (activity: AgentActivity) => void;

export type AgentActivityPublisher = (activity: AgentActivity) => void;

/** What one caller supplies to announce, attribute and finish one agent invocation. */
export type AgentInvocationSettings = {
  /** The role name of the invoked agent. */
  readonly agentName: string;
  /** The operation the invoking action performs; the boundary events' source. */
  readonly operation: string;
  /** The caller-selected profile ID. */
  readonly profile: string;
  /** The task the invocation works on, when it works on one. */
  readonly task?: string | null;
  /** The idea the invocation refines, when it refines one. */
  readonly idea?: string | null;
  /** The execution's agent activity directory the invocation's own log lives under. */
  readonly directory: string;
  readonly publish: EventPublisher;
  readonly publishActivity: AgentActivityPublisher;
};

/** One open invocation: its identity plus its activity and end boundaries. */
export type AgentInvocationHandle = {
  readonly identity: AgentInvocation;
  /** Publish one activity entry the invocation reported while it ran. */
  activity(activity: AgentEvent): void;
  /** Announce the invocation's end, including failure. */
  finish(result: AgentInvocationResult): void;
};

/**
 * Assign one agent invocation's caller-owned identity and announce its start. The activity log
 * path carries the agent name, the Unix start time and the invocation ID, so Application writes
 * that invocation's activity to its own durable file and OperatorInterface attributes live
 * activity to its own pane.
 */
export function beginAgentInvocation(settings: AgentInvocationSettings): AgentInvocationHandle {
  const startedAtUnixMs = Date.now();
  const invocationId = randomUUID();
  const identity: AgentInvocation = {
    agentName: settings.agentName,
    invocationId,
    startedAtUnixMs,
    log: {
      path: path.join(
        settings.directory,
        `${settings.agentName}-${String(startedAtUnixMs)}-${invocationId}.jsonl`,
      ),
    },
  };
  const boundary = {
    agentName: identity.agentName,
    invocationId: identity.invocationId,
    startedAtUnixMs: identity.startedAtUnixMs,
    log: identity.log,
  };
  settings.publish({
    source: settings.operation,
    type: 'agent-started',
    data: {
      ...boundary,
      operation: settings.operation,
      profile: settings.profile,
      ...(settings.task === undefined || settings.task === null ? {} : { task: settings.task }),
      ...(settings.idea === undefined || settings.idea === null ? {} : { idea: settings.idea }),
    },
  });
  let ended = false;
  return {
    identity,
    activity(activity) {
      settings.publishActivity({
        invocationId: identity.invocationId,
        timestamp: new Date().toISOString(),
        activity,
      });
    },
    finish(result) {
      if (ended) {
        return;
      }
      ended = true;
      settings.publish({
        source: settings.operation,
        type: 'agent-finished',
        data: { ...boundary, result },
      });
    },
  };
}

/**
 * The invocation identity an agent boundary event carries, or null when its data does not carry
 * one. Application uses this to open the invocation's activity log before its first packet.
 */
export function agentInvocationOf(event: EngineEvent): AgentInvocation | null {
  if (event.type !== 'agent-started' && event.type !== 'agent-finished') {
    return null;
  }
  if (typeof event.data !== 'object' || event.data === null) {
    return null;
  }
  const data = event.data as Record<string, unknown>;
  const log = data['log'];
  const logPath =
    typeof log === 'object' && log !== null ? (log as Record<string, unknown>)['path'] : undefined;
  const agentName = data['agentName'];
  const invocationId = data['invocationId'];
  const startedAtUnixMs = data['startedAtUnixMs'];
  if (
    typeof agentName !== 'string' ||
    agentName === '' ||
    typeof invocationId !== 'string' ||
    invocationId === '' ||
    typeof startedAtUnixMs !== 'number' ||
    !Number.isInteger(startedAtUnixMs) ||
    typeof logPath !== 'string' ||
    logPath === ''
  ) {
    return null;
  }
  return { agentName, invocationId, startedAtUnixMs, log: { path: logPath } };
}

/** One action's request to run its agent role: the operation, profile, workspace and context. */
export type AgentRoleRequest = {
  /** The operation the action performs; the invocation boundary events' source. */
  readonly operation: string;
  /** The profile the action selected for this invocation. */
  readonly profile: string;
  readonly workspace: { readonly root: string };
  readonly context: string;
  /** The task the invocation works on, when it works on one. */
  readonly task?: string | null;
  /** The idea the invocation refines, when it refines one. */
  readonly idea?: string | null;
};

/**
 * The agent capability one action uses. The runner knows its role; it assigns each invocation's
 * identity, announces the invocation boundaries and transports the invocation's attributable
 * activity, so several concurrent invocations stay individually attributable. The action supplies
 * only the operation, the profile it selected and the invocation context.
 */
export type AgentRoleRunner = {
  run(request: AgentRoleRequest): Promise<AgentResult>;
};

/**
 * One action's saved output and the workflow outcome it returned. The artifact reference names the
 * file the action saved for that outcome, or the earlier saved file it reused.
 */
export type ActionOutcome = {
  readonly task: string;
  /** The round whose record or directory holds the output; null before a round exists. */
  readonly round: number | null;
  /** The council cycle whose directory holds an idea refinement output, when one applies. */
  readonly cycle?: number | null;
  /** The action's returned workflow outcome. */
  readonly outcome: string;
  /** One short producer-owned phrase naming the useful fact to show, or null when none applies. */
  readonly detail: string | null;
  readonly artifact: ArtifactRef;
};

/** The type every action outcome event carries. */
export const actionOutcomeType = 'outcome';

/** Build the outcome event one action publishes with its own source after saving its output. */
export function actionOutcomeEvent(source: string, outcome: ActionOutcome): EngineEvent {
  return { source, type: actionOutcomeType, data: outcome };
}

export type TaskEngine = {
  run(): Promise<WorkflowResult>;
  subscribe(listener: EventListener): Unsubscribe;
  /** Observe attributable agent activity while the workflow runs. */
  subscribeActivity(listener: AgentActivityListener): Unsubscribe;
};

/**
 * Construction supplies the workflow, a binding that receives the engine's EventPublisher and
 * AgentActivityPublisher and returns the workflow's bound actions, and the workflow-state filepath.
 */
export type TaskEngineSettings = {
  readonly workflow: AnyStateMachine;
  readonly stateFile: string;
  readonly bindActions: (
    publish: EventPublisher,
    publishActivity: AgentActivityPublisher,
  ) => Readonly<Record<string, BoundAction>>;
};

/** Create the task engine over the supplied workflow, action binding and workflow-state filepath. */
export function createTaskEngine(settings: TaskEngineSettings): TaskEngine {
  const listeners = new Set<EventListener>();
  const activityListeners = new Set<AgentActivityListener>();
  const publish: EventPublisher = (event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A listener failure is isolated from execution and from the other listeners.
      }
    }
  };
  const publishActivity: AgentActivityPublisher = (activity) => {
    for (const listener of [...activityListeners]) {
      try {
        listener(activity);
      } catch {
        // A listener failure is isolated from execution and from the other listeners.
      }
    }
  };
  const runner = createExecutionRunner({
    workflow: settings.workflow,
    actions: settings.bindActions(publish, publishActivity),
    stateFile: settings.stateFile,
    publish,
  });

  return {
    run: () => runner.run(),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeActivity(listener) {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },
  };
}
