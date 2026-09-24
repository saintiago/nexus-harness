import { readFile, writeFile } from 'node:fs/promises';
import {
  createActor,
  fromPromise,
  type AnyActorLogic,
  type AnyStateMachine,
  type Snapshot,
} from 'xstate';
import { fault, messageOf, ok } from '../result.js';
import type { EngineEvent, EventPublisher, WorkflowResult } from './index.js';

/**
 * ExecutionRunner connects an XState workflow to Nexus actions, the persisted workflow state and
 * progress reporting. XState executes the machine; this module only binds the supplied promise
 * actions, saves and restores snapshots and forwards state observations.
 */

/** A bound action: it performs its operation and returns a workflow outcome. */
export type BoundAction = () => Promise<string>;

/** Construction supplies the workflow, its bound actions, the state filepath and a publisher. */
export type ExecutionRunnerSettings = {
  readonly workflow: AnyStateMachine;
  readonly actions: Readonly<Record<string, BoundAction>>;
  readonly stateFile: string;
  readonly publish: EventPublisher;
};

/** Runs the supplied workflow from its persisted state and returns its terminal outcome. */
export type ExecutionRunner = {
  run(): Promise<WorkflowResult>;
};

/** The source of every state event this runner publishes. */
const runnerSource = 'execution-runner';

/** The state-node map of a supplied workflow, however its context and events are typed. */
type WorkflowStates = AnyStateMachine['root']['states'];

/** Read the persisted snapshot, or decide to start the workflow from its initial state. */
type LoadedState =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'restore'; readonly snapshot: Record<string, unknown> }
  | { readonly kind: 'problem'; readonly message: string };

/** True for a JSON object that can carry snapshot fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read the state file. An absent file starts a fresh workflow; a terminal snapshot is discarded so
 * the next run starts from the initial state; an active snapshot is restored. An unreadable or
 * invalid file is a problem, never permission to start over.
 */
async function loadState(stateFile: string): Promise<LoadedState> {
  let text: string;
  try {
    text = await readFile(stateFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'fresh' };
    }
    return {
      kind: 'problem',
      message: `Workflow state at "${stateFile}" could not be read: ${messageOf(error)}`,
    };
  }

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'problem',
      message: `Workflow state at "${stateFile}" is not valid JSON: ${messageOf(error)}`,
    };
  }

  if (!isRecord(snapshot) || typeof snapshot.status !== 'string') {
    return { kind: 'problem', message: `Workflow state at "${stateFile}" is not a snapshot.` };
  }
  if (snapshot.status === 'done') {
    return { kind: 'fresh' };
  }
  if (snapshot.status !== 'active') {
    return {
      kind: 'problem',
      message: `Workflow state at "${stateFile}" has unsupported status "${snapshot.status}".`,
    };
  }
  return { kind: 'restore', snapshot };
}

/** The operations the workflow definition invokes, in state definition order. */
function invokedOperations(workflow: AnyStateMachine): string[] {
  const operations: string[] = [];
  const collect = (states: WorkflowStates): void => {
    for (const state of Object.values(states)) {
      for (const invoke of state.invoke) {
        if (typeof invoke.src === 'string') {
          operations.push(invoke.src);
        }
      }
      collect(state.states);
    }
  };
  collect(workflow.root.states);
  return operations;
}

/** Register each bound action as the promise actor its workflow state invokes. */
function promiseActors(
  actions: Readonly<Record<string, BoundAction>>,
): Record<string, AnyActorLogic> {
  return Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [name, fromPromise(async () => action())]),
  );
}

/** Publish one state observation. Presentation failures do not control execution. */
function publishState(publish: EventPublisher, value: unknown): void {
  const event: EngineEvent = {
    source: runnerSource,
    type: 'state',
    data: { name: String(value) },
  };
  try {
    publish(event);
  } catch {
    // Observation is not part of execution.
  }
}

/** Create the runner over the supplied workflow, bound actions, state filepath and publisher. */
export function createExecutionRunner(settings: ExecutionRunnerSettings): ExecutionRunner {
  return {
    run: () => runWorkflow(settings),
  };
}

async function runWorkflow(settings: ExecutionRunnerSettings): Promise<WorkflowResult> {
  let workflow: AnyStateMachine;
  try {
    workflow = settings.workflow.provide({ actors: promiseActors(settings.actions) });
  } catch (error) {
    return fault(`Cannot bind the workflow to its actions: ${messageOf(error)}`);
  }

  const missing = invokedOperations(workflow).filter(
    (operation) => settings.actions[operation] === undefined,
  );
  if (missing.length > 0) {
    return fault(
      `No bound action for workflow operation${missing.length === 1 ? '' : 's'} ` +
        `${missing.map((operation) => `"${operation}"`).join(', ')}.`,
    );
  }

  const loaded = await loadState(settings.stateFile);
  if (loaded.kind === 'problem') {
    return fault(loaded.message);
  }

  const actor = createActor(
    workflow,
    loaded.kind === 'restore' ? { snapshot: loaded.snapshot as Snapshot<unknown> } : {},
  );

  // Saves are chained so they run in notification order; XState never waits for them.
  let pendingWrite: Promise<void> = Promise.resolve();
  let writeProblem: string | null = null;
  const save = (snapshot: unknown): void => {
    let json: string;
    try {
      json = JSON.stringify(snapshot);
    } catch (error) {
      writeProblem ??= `Workflow state at "${settings.stateFile}" could not be serialized: ${messageOf(error)}`;
      return;
    }
    pendingWrite = pendingWrite.then(async () => {
      try {
        await writeFile(settings.stateFile, json, 'utf8');
      } catch (error) {
        writeProblem ??= `Workflow state at "${settings.stateFile}" could not be saved: ${messageOf(error)}`;
      }
    });
  };

  let restoring = loaded.kind === 'restore';

  return new Promise<WorkflowResult>((resolve) => {
    let settled = false;
    const finish = (outcome: WorkflowResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      void (async () => {
        // The terminal snapshot and every earlier notification are saved before returning.
        await pendingWrite;
        actor.stop();
        resolve(writeProblem === null ? outcome : fault(writeProblem));
      })();
    };

    actor.subscribe({
      next: (snapshot) => {
        restoring = false;
        publishState(settings.publish, snapshot.value);
        if (snapshot.status === 'active' || snapshot.status === 'done') {
          save(actor.getPersistedSnapshot());
        }
      },
      error: (error) => {
        finish(
          fault(
            restoring
              ? `Workflow state at "${settings.stateFile}" cannot be restored: ${messageOf(error)}`
              : `Workflow execution failed: ${messageOf(error)}`,
          ),
        );
      },
      complete: () => {
        const output: unknown = actor.getSnapshot().output;
        finish(
          typeof output === 'string'
            ? ok(output)
            : fault('Workflow finished without declaring a string outcome.'),
        );
      },
    });

    actor.start();
  });
}
