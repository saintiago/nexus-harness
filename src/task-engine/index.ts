import type { AnyStateMachine } from 'xstate';
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
};

/**
 * Construction supplies the workflow, a binding that receives the engine's EventPublisher and
 * returns the workflow's bound actions, and the workflow-state filepath.
 */
export type TaskEngineSettings = {
  readonly workflow: AnyStateMachine;
  readonly stateFile: string;
  readonly bindActions: (publish: EventPublisher) => Readonly<Record<string, BoundAction>>;
};

/** Create the task engine over the supplied workflow, action binding and workflow-state filepath. */
export function createTaskEngine(settings: TaskEngineSettings): TaskEngine {
  const listeners = new Set<EventListener>();
  const publish: EventPublisher = (event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A listener failure is isolated from execution and from the other listeners.
      }
    }
  };
  const runner = createExecutionRunner({
    workflow: settings.workflow,
    actions: settings.bindActions(publish),
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
  };
}
