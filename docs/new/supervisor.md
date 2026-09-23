# Supervisor

## Responsibility

Run a work process, retain the execution request and coordinate recovery when work fails.
Apply the recovery decision and enforce the configured recovery allowance.

The public module is `src/supervisor/index.ts`. Its production host is the parent of the work process.

## Interface

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary).

### Provided interface

```ts
interface Supervisor {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  subscribe(listener: Observer<ExecutionEvent>): Unsubscribe;
}

type ExecutionRequest = {
  projectConfigPath: string;
};

type ExecutionEvent = EngineEvent;

type ExecutionResult = {
  outcome: 'completed' | 'needs-attention';
  reason: string;
  report: ArtifactRef | null;
};

type RecoveryDecision =
  | { kind: 'resume' }
  | { kind: 'run-blocker'; key: string }
  | { kind: 'needs-attention' };

type RecoveryReport = {
  summary: string;
  decision: RecoveryDecision;
};
```

One execute call supervises one execution. The request contains the absolute project configuration
filepath. Completed means the configured workflow finished successfully;
needs-attention means execution could not continue. The report identifies the saved recovery report
when recovery occurred.

EngineEvent and Unsubscribe are imported from [TaskEngine's event contract](task-engine/architecture.md#provided-interface).
Forward producer events unchanged and emit lifecycle events with source supervisor and types starting,
running, recovering and finished. Observation does not control execution.
subscribe observes subsequent events and returns an unsubscribe function. Listener failures do not
affect execution. The finished event carries the ExecutionResult, including the reason when attention
is needed. Recovery invocations emit the same
[agent activity events](task-engine/architecture.md#agent-activity-events), with role recovery.

RecoveryReport is the output required at this component's recovery boundary. The invocation context
requests this format; this component parses it. A malformed report is a failed recovery invocation.

### Required interfaces

| Port | Provider contract | Values exchanged |
| --- | --- | --- |
| Work | [TaskEngine.run and subscribe](task-engine/architecture.md#provided-interface) | WorkflowResult and EngineEvent |
| Recovery | [AgentRuntime.run](agent-runtime/architecture.md#provided-interface) | Recovery profile, WorkspaceRef, context text and agent output |
| Notification | [Notifications adapter](adapters/notifications.md#interface) | Subject, report body and publication result |

The [worker startup contract](high-level-architecture.md#configuration-and-startup) accepts the
project filepath and any recovery target. Pass these on each launch. The worker binds its dependencies,
subscribes to events and calls run. Resume uses retained workflow state and action storage.

Prepare recovery context from the original request, failure, available output and
[workspace reference](workspace.md#layout-and-reference). An absent error description stays absent;
recovery investigates from the available context. If the task workspace is unavailable, supply an
operational workspace. Pass context directly to AgentRuntime.run with the configured recovery profile.

Recovery may investigate, fix operational problems, reconcile retained work and create or rank a
necessary blocker through its configured tools. It reconciles saved workflow state when needed before
requesting resumption. Its decision requests resumption, one blocker before resumption, or operator
attention. The report explains the cause, actions taken and remaining problems.
A recovery report does not replace task verification or completion gates.

Construction supplies work/recovery/notification capabilities and lifecycle settings from
[Nexus configuration](configuration.md#nexus-configuration), available before the first child starts.
Successful terminal outcomes are supplied with the selected workflow.

## Execution and recovery

1. Start the work process with the requested scope.
2. Forward progress while it runs and wait for its result and exit.
3. Finish on a successful terminal result and successful exit.
4. On a blocked result, execution error, missing result or failed exit, invoke recovery.
5. Save the recovery report, publish it and apply its decision.

Work and recovery run sequentially. Each invocation finishes before the next starts.
The current design has one supervised execution per workspace; cross-process admission and locking
are outside this design.

A resume decision starts work with its retained state. A run-blocker decision retains the original
request, runs the named ticket in its own workspace and then resumes the original request. If that
work fails, its failure goes through the same recovery path.

Each recovery invocation consumes one of the configured maximum attempts for this supervised
execution. Child restarts and blocker work do not reset the count. Exhaustion, failed recovery or a
needs-attention decision ends execution with needs-attention.

Apply the decision without independently classifying the repair, requiring proof of changed state
or judging progress past an earlier failure. Recovery owns that judgment.

## State and reports

Retain the original request, current target, return target when running a blocker, recovery count
and recovery reports. Save these as ordinary files under the configured storage root.

Send the saved recovery report through the configured notification capability. Publication failure
is reported separately and does not repeat recovery. Provider acceptance confirms submission of the
notification, not inbox delivery.
