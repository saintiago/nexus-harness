import type { AnyStateMachine } from 'xstate';
import type { Result } from '../result.js';
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
