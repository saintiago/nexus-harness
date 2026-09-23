# ExecutionRunner

Status: proposed component design.

## Responsibility

Execute a supplied XState workflow with bound operations. Own the running machine, its saved state
and execution result. XState selects transitions; the runner connects execution, persistence and events.

## Interface

Use WorkflowResult and EventPublisher from the [TaskEngine interface](architecture.md#provided-interface).
Operations follow the [action contract](actions/architecture.md).

```ts
interface ExecutionRunner {
  run(): Promise<WorkflowResult>;
}

type BoundAction = () => Promise<string>;
```

Construction supplies:

| Input | Contract |
| --- | --- |
| Workflow | XState machine definition with one invoked operation per active state |
| Actions | Action names mapped to bound functions returning named outcomes |
| State filepath | Absolute path to the workflow-state file |
| Event publisher | Receives execution progress |

Action names match the workflow's invoke sources. Dependencies are already bound; the runner does not
load configuration or provide workspace, artifact or agent inputs to an action.

run executes one workflow at a time. It returns the declared terminal output as a successful result,
or a fault when execution fails. A terminal output such as blocked remains a workflow result; its
business meaning belongs to the caller.

Publish state progress using the shared event shape:

```text
{ source: "execution-runner", type: "state", data: { name: <state name> } }
```

Actions receive their event publisher separately at construction. The runner does not intercept or
interpret their activity. Observer failures do not change execution.

## XState binding

Bind each operation as a promise actor using fromPromise and machine.provide. Await its returned
promise, then let the workflow's onDone transitions select the next state from the named outcome.

Do not use XState fire-and-forget actions for asynchronous operations. The workflow is sequential:
one operation finishes before another begins. Business work belongs in the bound functions;
transition guards only select outcomes.

XState owns state selection, transition evaluation and invocation lifecycle. The runner does not
reimplement these or interpret a second workflow language.

## Persistence and resumption

Store the XState persisted snapshot as JSON at the supplied filepath. Use getPersistedSnapshot()
for saved state and createActor(machine, { snapshot }) for restoration. Persist control state only;
business inputs and outputs remain outside the machine.

Before a bound operation begins, finish saving the snapshot for its active state. This is part of
dispatch: the operation waits for the save. A background save triggered by a progress subscription
does not satisfy this ordering. Save terminal state before returning the final result.

On startup:

1. Bind the supplied operations to the workflow.
2. Read the saved snapshot, or use the initial state when the file is absent.
3. Restore or create the machine and run it with the save-before-dispatch rule.
4. Return after terminal state is saved, or after an execution fault.

An active restored invocation starts its operation anew. A restored terminal snapshot returns its
saved output without running operations. An unreadable or incompatible snapshot is a fault, not a
request to start over.

If execution stops after an operation finishes but before the next state is saved, that operation
can run again. Repetition and existing external effects are the operation's responsibility. Save/load
uses ordinary files; it provides no transaction across control state, artifacts and external systems.

## Failures and lifetime

A missing operation binding, invalid transition outcome, rejected operation or state read/write error
ends run with a fault. Preserve the last saved runnable state on operation failure. Do not dispatch
another operation after a failed save or report completion before terminal persistence succeeds.

Release the machine and subscriptions when run ends. Retry, repair, escalation and recovery are not
runner decisions. The runner does not read artifact contents, select rounds, preserve conversations,
add cancellation APIs or coordinate multiple workspace writers.
