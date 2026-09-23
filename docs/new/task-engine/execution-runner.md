# ExecutionRunner

## Responsibility

Connect an XState workflow to Nexus actions, persistent state and progress reporting.
XState is the execution engine; ExecutionRunner is its integration with Nexus.

## Interface

Use WorkflowResult and EventPublisher from the [TaskEngine interface](architecture.md#provided-interface).
Bound functions follow the [action contract](actions/architecture.md).

```ts
interface ExecutionRunner {
  run(): Promise<WorkflowResult>;
}

type BoundAction = () => Promise<string>;
```

Construction supplies the XState workflow, action names mapped to bound functions, the state filepath
and an event publisher. Action dependencies are already bound.

run returns a promise for the workflow's terminal outcome or an execution error. Reaching a terminal
state does not imply task success: drained and blocked are both declared workflow outcomes.

## Division of responsibility

| Concern | Nexus implements | XState provides |
| --- | --- | --- |
| Action binding | Register supplied functions as promise actors under their workflow names | Resolve and invoke the registered actors |
| Execution | Start the machine and await its final result | Wait for operations, evaluate guards and follow transitions |
| Persistence | Read and write the state file; enforce save ordering | Produce persisted snapshots and restore a machine from one |
| Progress | Subscribe and forward state observations as Nexus events | Publish snapshots of the running machine |
| Completion | Return the outcome or execution error; release subscriptions | Report terminal output and machine errors |

There is no Nexus loop that manually invokes successive actions. The workflow defines sequencing;
XState executes it.

## Persistence

Save the XState persisted snapshot as JSON at the supplied filepath. If the file is absent, start
from the initial state; otherwise restore from it. Business artifacts stay outside the snapshot.

The Nexus binding must finish saving the active state before its bound operation starts, and save
terminal state before returning the outcome. XState does not perform these file writes or wait for
an asynchronous persistence subscriber; this ordering is part of the integration we implement.

On restoration, XState restarts an active invocation. A terminal snapshot returns its output without
running operations. An operation may therefore execute again after interruption; handling existing
work belongs to that operation.

A state read/write error ends execution. Keep the last saved runnable snapshot on an operation error.
Use ordinary file save/load, without a second checkpoint system or transaction protocol.

## Progress and errors

Subscribe to the XState actor and forward its state value:

```text
{ source: "execution-runner", type: "state", data: { name: <state name> } }
```

This is an observation of XState, not another state store. Action activity uses the publisher bound
to each action. Presentation failures do not control execution.

Report binding, workflow, operation and persistence errors to the caller. The runner does not choose
repairs or recovery, inspect artifacts or interpret business outcomes.
