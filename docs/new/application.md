# Application

## Responsibility

Own command handling, configuration loading, component construction and process exit.
Provide the parent and worker entry points. Use ordinary construction functions, without a service
registry or dependency-injection framework.

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

### Component wiring

Load settings according to [Configuration](configuration.md). Construct components through their
documented interfaces and supply only the settings and capabilities each needs.

| Process | Construction and invocation |
| --- | --- |
| Parent | Construct recovery AgentRuntime and notification/process adapters; supply them and lifecycle settings to [Supervisor](supervisor.md#interface) |
| Parent | Construct [OperatorInterface](operator-interface.md#interface) with the Supervisor event subscription and terminal capabilities |
| Parent | Start presentation, call Supervisor.execute with the absolute project filepath, then stop presentation when execution ends |
| Worker | Construct [Adapters](adapters/architecture.md#interface) and [AgentRuntime](agent-runtime/architecture.md#interface) from their relevant settings |
| Worker | Bind action capabilities, selection storage and event publishing; construct [TaskEngine](task-engine/architecture.md#interface) with the selected workflow and workflow-state filepath |
| Worker | Subscribe to TaskEngine events before calling run; send events and its final result through the worker protocol |

Supervisor owns child launch, restart and recovery decisions. Application provides the worker entry
point and connects its transport. OperatorInterface receives forwarded worker events through Supervisor
once; Application does not add another subscription to display those same events.

### Worker entry point

The internal worker entry receives the absolute project filepath and an optional recovery target from
Supervisor. It uses the same installation configuration path as the parent. This is an internal launch
contract, not an additional operator mode.

Send newline-delimited JSON on stdout:

```text
{ kind: "event", event: EngineEvent }
{ kind: "result", result: WorkflowResult }
```

Use the [TaskEngine event and result types](task-engine/architecture.md#provided-interface).
Reserve stderr for diagnostics. Forward events unchanged. Send the final result before exiting.
A returned workflow outcome exits with 0; an execution fault or worker initialization failure exits
with 1. Supervisor interprets the workflow outcome and process result; a zero exit alone does not
declare successful task completion.

## Configuration loading

The parent reads the installation configuration before constructing its dependencies. Each worker
launch reads project and installation configuration and loads the selected workflow.
Resolve relative paths against their owning configuration file. Validate required values and
references before constructing their consumers.

Supply resolved settings as immutable values. Resolve credential references from the host;
do not print secret values or place them in agent context.
Do not inspect task artifacts, decide which ticket runs next or reinterpret saved workflow state.

## Process completion

The parent exits with:

- 0 for help or completed execution.
- 1 for execution requiring attention, initialization failure or an unexpected execution error.
- 2 for invalid command input.

Print command and initialization errors to stderr. Once presentation starts, stop it when execution
ends, including failure. Application adds no retry loop, recovery policy or persistent state.
