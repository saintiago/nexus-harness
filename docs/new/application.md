# Application

## Responsibility

Manage a Nexus execution: command handling, configuration loading, component construction, worker
lifecycle, recovery and process exit. Provide the parent and worker entry points.
Use ordinary construction functions without a service registry or dependency-injection framework.

The public module is `src/application/index.ts`.

## Interface

### Operator command

```text
nexus queue run --project-config <file>
nexus --help
```

The process supplies arguments, working directory, environment and standard streams. The installation
supplies the Nexus configuration filepath. Resolve the project filepath against the working directory.
Reject missing arguments and unknown options. Help requires no configuration or external connections.
Launch shortcuts invoke this command; they contain no execution logic.

### Provided interface

```ts
interface Application {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  subscribe(listener: Observer<ExecutionEvent>): Unsubscribe;
}

type ExecutionRequest = { projectConfigPath: string };
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

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary) and
[TaskEngine event types](task-engine/architecture.md#provided-interface).
One execute call manages one execution using the absolute project filepath.
Completed means the configured workflow finished successfully; needs-attention means it could not
continue. The report points to the saved recovery report when recovery occurred.

subscribe observes subsequent events and returns an unsubscribe function. Forward worker events
unchanged. Emit lifecycle events with source application and types starting, running, recovering and
finished. The finished event carries ExecutionResult. Listener failures do not affect execution.

Recovery invocations emit the [agent activity events](task-engine/architecture.md#agent-activity-events)
with role recovery. Request RecoveryReport in the recovery context and parse the returned output.
A malformed report is a failed recovery invocation.

### Component wiring

Load settings according to [Configuration](configuration.md). Supply each component only the settings
and capabilities its contract requires.

| Process | Construction and invocation |
| --- | --- |
| Parent | Construct recovery [AgentRuntime](agent-runtime/architecture.md#interface) and notification/process [Adapters](adapters/architecture.md#interface) |
| Parent | Construct [OperatorInterface](operator-interface.md#interface) with the Application event subscription and terminal capabilities; start presentation before execute and stop it afterward |
| Worker | Construct adapters and AgentRuntime from their relevant settings |
| Worker | Bind action capabilities, selection storage and event publishing; construct [TaskEngine](task-engine/architecture.md#interface) with the selected workflow and workflow-state filepath |
| Worker | Subscribe to TaskEngine events before calling run; send events and the final result through the worker protocol |

OperatorInterface receives worker and parent events through one combined subscription.
Prepare recovery context from the original request, failure, available output and
[workspace reference](workspace.md#layout-and-reference). If the task workspace is unavailable,
supply an operational workspace. Include the current project configuration and recovery scope in the
context. Pass context to AgentRuntime.run with the configured recovery profile.
Use the [Notifications adapter](adapters/notifications.md#interface) to publish the recovery report.

### Worker entry point

The internal worker entry receives the absolute project filepath and an optional recovery target.
It uses the same installation configuration path as the parent. This is an internal launch contract,
not an additional operator mode.

Send newline-delimited JSON on stdout:

```text
{ kind: "event", event: EngineEvent }
{ kind: "result", result: WorkflowResult }
```

Use the [TaskEngine event and result types](task-engine/architecture.md#provided-interface).
Reserve stderr for diagnostics. Forward events unchanged. Send the final result before exiting.
A returned workflow outcome exits with 0; an execution fault or worker initialization failure exits
with 1. The parent evaluates both the outcome and process exit; zero exit alone is not completion.

## Configuration loading

The parent reads installation configuration before constructing its dependencies. Each worker launch
reads project and installation configuration and loads the selected workflow. Resolve relative paths
against their owning configuration file. Validate required values and references before use.

Supply resolved settings as immutable values. Resolve credential references from the host;
do not print secret values or place them in agent context. Lifecycle settings and the selected
workflow's successful terminal outcomes are available before the first child starts.

## Execution and recovery

1. Start the worker with the requested scope.
2. Forward progress and wait for its result and exit.
3. Finish on a successful terminal outcome and successful exit.
4. On a blocked outcome, execution fault, invalid or missing result, or failed exit, invoke recovery.
5. Save the recovery report, publish it and apply its decision.

Work and recovery run sequentially. Each invocation finishes before the next starts.
An absent error description stays absent; recovery investigates from the available context.

Recovery stays within the current project. It investigates, fixes project execution problems,
reconciles retained work and may create or rank a blocker in that project's configured task source.
It reconciles saved workflow state when needed before requesting resumption. Its report explains
the cause, actions taken and remaining problems.

Cross-project repair and changes to the Nexus installation are outside this capability. If continuing
requires either, return needs-attention with the diagnosis; do not create a ticket in another project,
launch a repair there or update the running Nexus installation.

A resume decision starts work with retained state. A run-blocker decision retains the original request,
runs the named ticket in its own workspace using the same project configuration, then resumes the
original request. The blocker key belongs to the current project's task source. Failure in that work
uses the same recovery path.

Each recovery invocation consumes the configured allowance for this execution. Worker restarts and
blocker work do not reset it. Exhaustion, failed recovery or a needs-attention decision ends execution
with needs-attention.

Apply the decision without independently classifying the repair, requiring proof of changed state or
judging progress past an earlier failure. Recovery owns that judgment. Task selection, workflow
transitions and verification/completion gates remain worker responsibilities; recovery reports do not
replace them.

## State and reports

Retain the original request, current target, return target when running a blocker, recovery count and
recovery reports as ordinary files under the configured storage root.

Publish the saved recovery report. Notification failure is reported separately and does not repeat
recovery. Provider acceptance confirms submission, not inbox delivery.

## Process completion

The parent exits with:

- 0 for help or completed execution.
- 1 for execution requiring attention, initialization failure or an unexpected execution error.
- 2 for invalid command input.

Print command and parent initialization errors to stderr. Once presentation starts, stop it when
execution ends, including failure.
