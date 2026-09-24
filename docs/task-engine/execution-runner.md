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

type BoundAction = (input?: unknown) => Promise<string>;
```

Construction supplies the XState workflow, action names mapped to bound functions, the state filepath
and an event publisher. Action dependencies are already bound. A workflow state may supply a static
input to the operation it invokes — for example the correction route StartIdeaRound opens — and the
runner passes that value through unchanged; the action decides whether and how to use it. An action
that needs no input ignores the argument.

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

There is no Nexus loop that manually invokes successive actions or joins parallel operations. The workflow defines sequencing and concurrency; XState executes it.

## Persistence

Save the XState persisted snapshot as JSON at the supplied filepath. At the start of run, inspect the
saved state. If absent, start from the initial state. If terminal, discard that snapshot and start
from the initial state. Otherwise pass the snapshot to XState for restoration. Report JSON read/parse
errors and restoration errors from XState; do not inspect its internal state tree or invoked-child
records. Errors are not permission to discard saved state. Business artifacts stay outside the snapshot.

Subscribe before starting the XState actor. On each state update, capture its persisted snapshot
and save it. Serialize writes in notification order so an older save cannot overwrite a newer one.

XState proceeds without waiting for these writes. There is no persistence gate around actions.
Before returning a terminal outcome, wait for the pending writes, including the terminal snapshot,
to finish.

Started invocations also end before the terminal outcome is returned. When one parallel region
fails, a sibling invocation may still be running after XState stops the actor: wait for every
invoked operation to settle, so its activity and outcome events precede the workflow's final
result. The terminal outcome of the workflow is unchanged by the drained siblings.

On restoration, XState restarts an active invocation. A terminal result ends the current run; it is
reset only on the next run, not looped automatically. Saved state may lag execution: a crash can
cause one or more completed operations, including parallel invocations, to run again. Handling repeated execution and existing work belongs to those operations.

Report state read/write failures as execution errors, not terminal outcomes. On an operation error,
retain the last saved runnable snapshot rather than replacing it with an errored machine snapshot.
Use ordinary file save/load, without a second checkpoint system or transaction protocol.

## Progress and errors

Subscribe to the XState actor and forward its state value. Preserve structured values for
parallel states so all active regions remain observable:

```text
{ source: "execution-runner", type: "state", data: { value: <XState state value> } }
```

This is an observation of XState, not another state store. Action activity uses the publisher bound
to each action. Presentation failures do not control execution.

Report binding, workflow, operation and persistence errors to the caller. The runner does not choose
repairs or recovery, inspect artifacts or interpret business outcomes.
