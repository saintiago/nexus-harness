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
nexus ideas refine --project-config <file>
nexus --help
```

The process supplies arguments, working directory, environment and standard streams. The installation
supplies the Nexus configuration filepath through the `NEXUS_CONFIG` environment setting. Resolve the
project filepath against the working directory.
Reject missing arguments and unknown options. Help requires no configuration or external connections.
Launch shortcuts invoke this command; they contain no execution logic.

### Provided interface

```ts
interface Application {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  subscribe(listener: Observer<ExecutionEvent>): Unsubscribe;
}

type ExecutionRequest = {
  projectConfigPath: string;
  workflow: 'finite-delivery' | 'idea-refinement';
};
type ExecutionEvent = EngineEvent;

type ExecutionResult = {
  outcome: 'completed' | 'needs-attention';
  reason: string;
  report: ArtifactRef | null;
};

type RecoveryDecision =
  | { kind: 'resume' }
  | { kind: 'needs-attention' };

type RecoveryReport = {
  summary: string;
  decision: RecoveryDecision;
};
```

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary) and
[TaskEngine event types](task-engine/architecture.md#provided-interface).
One execute call manages one selected workflow using the absolute project filepath.
Completed means the configured workflow finished successfully; needs-attention means it could not
continue. The report points to the saved recovery report when recovery occurred.

subscribe observes subsequent events and returns an unsubscribe function. Forward worker events
unchanged. Emit lifecycle events with source application and types starting, running, recovering,
recovered and finished. The finished event carries ExecutionResult. Listener failures do not affect
execution.

Recovery invocations use the [agent invocation contract](task-engine/architecture.md#agent-activity-events)
with role recovery. Use the [RecoveryRole](agent-runtime/recovery-role.md#interface) prompt, context
and tool contract. Request RecoveryReport in the recovery context and parse the returned output.
A malformed report is a failed recovery invocation. Once the report is saved, publish a recovered
event carrying its decision and an [ArtifactRef](high-level-architecture.md#shared-interface-vocabulary)
to the saved report, before applying the decision.

### Component wiring

Load settings according to [Configuration](configuration.md). Supply each component only the settings
and capabilities its contract requires.

| Process | Construction and invocation |
| --- | --- |
| Parent | Construct recovery [AgentRuntime](agent-runtime/architecture.md#interface) and notification/process [Adapters](adapters/architecture.md#interface) |
| Parent | Construct [OperatorInterface](operator-interface.md#interface) with the combined event subscription, attributable activity subscription and terminal capabilities; start presentation before execute and stop it afterward |
| Worker | Construct adapters and AgentRuntime from their relevant settings |
| Worker | Bind action capabilities, selection storage and event publishing; construct [TaskEngine](task-engine/architecture.md#interface) with the selected workflow and workflow-state filepath |
| Worker | Subscribe to TaskEngine events before calling run; send events and the final result through the worker protocol |

Terminal capabilities come from the process's standard output. A stream that fails or closes stops
presentation rendering to it while execution continues; the boundary releases its stream listeners
once presentation has stopped and the failures of the writes it issued have arrived.

OperatorInterface receives worker and parent events through one combined subscription and attributable
agent activity through a separate live subscription.
Prepare recovery context from the original request, failure, available output, execution-state paths
and task [workspace reference](workspace.md#layout-and-reference) when known. Always run recovery in
a separate operational workspace, so it can delete a broken task workspace without deleting its own
working directory. Initialize that workspace's worktree as a Git repository before the invocation,
so the configured [coding provider](adapters/coding-runtime.md#behavior) accepts its working
directory. Include the current project configuration and recovery scope in the context. Pass
context to AgentRuntime.run with the configured recovery profile.
Use the [Notifications adapter](adapters/notifications.md#interface) to publish the recovery report.

### Worker entry point

The internal worker entry receives the absolute project filepath and selected workflow.
It uses the same installation configuration path as the parent. This is an internal launch contract,
not an additional operator mode.

Send newline-delimited JSON on stdout:

```text
{ kind: "event", event: EngineEvent }
{ kind: "agent-activity", invocationId, timestamp, activity: AgentEvent }
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
The configured workflow module default-exports its XState definition and exports
`successfulOutcomes`, the terminal outcomes that complete successfully.

Supply resolved settings as immutable values. Resolve credential references from the host;
do not print secret values or place them in agent context. Lifecycle settings and the selected
workflow's successful terminal outcomes are available before the first child starts.

## Execution and recovery

1. Start the worker with the project configuration filepath.
2. Forward progress and wait for its result and exit.
3. Finish on a successful terminal outcome and successful exit.
4. On a blocked outcome, execution fault, invalid or missing result, or failed exit, invoke recovery.
5. Save the recovery report, publish it and apply its decision.

Recovery starts only after the worker ends. Finite delivery actions execute sequentially;
idea refinement runs independent actions concurrently within XState parallel states. Application
does not join or route those actions.
An absent error description stays absent; recovery investigates from the available context.

Recovery stays within the current project. It investigates, fixes project execution problems,
reconciles retained work and may create or rank a blocker in that project's configured task source.
It reconciles saved workflow state when needed before requesting resumption. Its report explains
the cause, actions taken and remaining problems.

Cross-project repair and changes to the Nexus installation are outside this capability. If continuing
requires either, return needs-attention with the diagnosis; do not create a ticket in another project,
launch a repair there or update the running Nexus installation.

A resume decision restarts the worker with the same project configuration and the state reconciled
by recovery.

For finite delivery, when a blocker must run first, recovery ranks it first and returns the interrupted ticket to To Do
immediately after it. Recovery discards the broken task workspace, clears its source pointer and
active selection, and resets queue execution to initial selection. The normal workflow processes the
blocker, then starts the interrupted task anew from updated main. Cleanup of the discarded attempt
follows the RecoveryRole contract. Application has no special blocker execution mode or return target.

Each recovery invocation consumes the configured allowance for this execution. Worker restarts and
queue reordering do not reset it. Exhaustion, failed recovery or a needs-attention decision ends execution
with needs-attention.

Apply the decision without independently classifying the repair, requiring proof of changed state or
judging progress past an earlier failure. Recovery owns that judgment. Task selection, workflow
transitions and verification/completion gates remain worker responsibilities; recovery reports do not
replace them.

## State and reports

Application supplies a stable execution directory for each workflow and configured project.
Finite delivery uses:

```text
<storage root>/executions/<project>/
├── workflow.json
├── selection.json
├── logs/
└── recovery/
```

Idea refinement uses a separate `<storage root>/executions/<project>/idea-refinement/` directory
with its own workflow.json, selection.json, logs/ and recovery/. Its selected source item and
business artifacts live in the refinement workspace.

The runner owns workflow.json; the selection action owns selection.json. These records are outside task
workspaces. Application retains its request, recovery count and reports under recovery/, alongside
the separate operational workspace. Task workspaces live under
`<storage root>/workspaces/<project>/<task>/`. Project identity distinguishes execution directories.

At worker startup the runner resets terminal workflow state before execution, as specified in
[ExecutionRunner](task-engine/execution-runner.md#persistence). This does not erase an active selection or workspace; recovery explicitly reconciles those
when a fresh restart is needed.
Recovery allowance persists across worker restarts. The task source owns queue order.

Publish the saved recovery report. Notification failure is reported separately and does not repeat
recovery. Provider acceptance confirms submission, not inbox delivery.

## Process completion

The parent exits with:

- 0 for help or completed execution.
- 1 for execution requiring attention, initialization failure or an unexpected execution error.
- 2 for invalid command input.

Print command and parent initialization errors to stderr. Once presentation starts, stop it when
execution ends, including failure.

## Execution log

Persist workflow and invocation activity independently of terminal presentation. Each execute call
creates a JSONL file at `<execution directory>/logs/<execution id>/events.jsonl`. Worker restarts
and recovery within that execution use the same file; a new execution uses a new directory.

Each main-log line is `{ "timestamp": <ISO timestamp>, "event": <ExecutionEvent> }`.
Timestamp events when received and preserve their order and complete payloads, including
invocation lifecycle and action-outcome artifact references. The main log contains no agent
messages, commands or tool results. Do not add configuration or credential values to events.

The caller assigns each agent invocation a role name, unique invocation ID and Unix start time.
Its start and finish events carry those values and an ArtifactRef to its own activity file under
`<execution directory>/logs/<execution id>/agents/<agent name>-<unix ms>-<invocation id>.jsonl`.
The worker sends activity packets with invocation identity, allowing simultaneous agents to
interleave safely. Application timestamps and writes the complete activity to the matching file,
then forwards it to OperatorInterface's live activity input. Open the file before the first
packet, drain it before the finish event and keep logging after terminal presentation closes.
The same contract applies to one or several agents and to recovery.

Application owns logger subscriptions and file lifecycle. Open the main log before publishing
starting, drain pending writes before recovery reads logs, and close logs after finished on every
exit path. Include relevant log filepaths in recovery context. Logging uses ordinary file
subscribers, without a logging framework, rotation policy or additional workflow state.

A log write failure is reported to stderr once; execution continues. Do not invoke recovery solely
for a logging failure. Initialization errors before a log can be opened remain stderr diagnostics.

## Idea refinement composition

The [idea refinement workflow](idea-refinement/spec.md) is selected explicitly for a connected
project. Application loads its XState definition and binds project-scoped actions; it does not
provide a separate idea router. Source selection and updates use the project's Jira task-source
adapter. An idea moved to the waiting-for-feedback state is a successful terminal workflow outcome,
not an execution fault requiring recovery. A provider or agent failure remains an execution fault.

Recovery receives the selected workflow, source item, snapshot and relevant log paths. It
diagnoses execution failures without conflating them with council rejection.
