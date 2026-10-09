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
nexus evidence list <root> [paths...]
nexus evidence read <root> <files...> [--max-bytes <n>]
nexus --help
```

The process supplies arguments, working directory, environment and standard streams. The installation
supplies the Nexus configuration filepath through the `NEXUS_CONFIG` environment setting. Resolve the
project filepath against the working directory.
Reject missing arguments and unknown options. Help requires no configuration or external connections.
Launch shortcuts invoke this command; they contain no execution logic.

### Evidence helpers

The evidence commands operate on local files without configuration, external connections or a
queue run. Paths resolve within the supplied root; reject traversal and symlinks that resolve
outside it. `list` recursively inventories file paths and byte sizes without reading their contents.
It reports omitted symlinks and the root's `worktree/` checkout; explicitly list `worktree` or one of
its subdirectories when repository files are needed. Revision attribution stays in the original
artifact contents rather than being inferred by the inventory.

`read` returns each selected UTF-8 file's original text, source byte size, returned content bytes and
explicit truncation flag. The default limit is 64 KiB per file; `--max-bytes` overrides it. Truncation
does not split a UTF-8 character. Report unreadable, non-text or out-of-root files individually and
continue reading the other selections. JSON results go to stdout. Exit 0 on success, 1 on file/access
failure and 2 on invalid arguments.

Each executed command emits one `evidence-helper` JSON record to stderr with timestamp, operation,
root, requested paths count, files, failures, omissions, source/read/content/stdout byte counts,
truncated files and duration in milliseconds. Logs contain no file contents. Existing agent activity
logs retain this record with invocation identity; no separate log store is introduced. Compare helper
adoption, file failures, returned volume and artifact-handling commands against the prior inline
scripts; duration and output reduction alone do not establish better analysis quality.

### Provided interface

```ts
interface Application {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  subscribe(listener: Observer<ExecutionEvent>): Unsubscribe;
  subscribeActivity(listener: Observer<AgentActivity>): Unsubscribe;
}

type ExecutionRequest = {
  projectConfigPath: string;
  workflow: 'project';
};
type ExecutionEvent = EngineEvent;

type AgentActivity = {
  invocationId: string;
  timestamp: string;
  activity: AgentEvent;
};

type ExecutionResult = {
  outcome: 'completed' | 'needs-attention';
  reason: string;
  report: ArtifactRef | null;
};

type RecoveryDecision =
  | { kind: 'resume' }
  | { kind: 'needs-attention' };

type RecoveryResponse = { decision: RecoveryDecision };
type RecoveryReport = RecoveryResponse & ReportBinding & {
  project: string;
  workId: string | null;
  role: 'recovery';
  profile: string;
  request: ExecutionRequest;
  recoveryAttempt: number;
};
```

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary) and
[TaskEngine event types](task-engine/architecture.md#provided-interface).
One execute call manages the project parent using the absolute project filepath. The queue command
invokes that parent; stage children are not separate OS workers or operator modes. Application
binds the configured children and operations through ordinary construction. The
[project workflow](project-workflow.md) owns stage/source responsibilities.
Completed means the configured workflow finished successfully; needs-attention means it could not
continue. The report points to the saved recovery report when recovery occurred.

subscribe observes subsequent events and returns an unsubscribe function. Forward worker events
unchanged. Emit lifecycle events with source application and types starting, running, recovering,
recovered and finished. The finished event carries ExecutionResult. subscribeActivity observes
attributable agent activity, both the worker's and recovery's, while it happens. Listener failures
do not affect execution.

Recovery invocations use the [agent invocation
contract](task-engine/architecture.md#agent-activity-events) with role recovery. Use the
[RecoveryRole](agent-runtime/recovery-role.md#interface) prompt, context and tool contract. Request
RecoveryResponse and assign a Markdown report path in the recovery context. Parse only the decision,
validate the assigned readable Markdown, and save RecoveryReport with Application's observed
identity/profile and the [report
binding](task-engine/actions/architecture.md#markdown-reports-and-machine-outcomes). An invalid
outcome or unusable Markdown is a failed recovery invocation. Once the report is saved, publish a
recovered event carrying its decision and an
[ArtifactRef](high-level-architecture.md#shared-interface-vocabulary) to the saved report, before
applying the decision.

### Component wiring

Load settings according to [Configuration](configuration.md). Supply each component only the settings
and capabilities its contract requires.

| Process | Construction and invocation |
| --- | --- |
| Parent | Construct recovery [AgentRuntime](agent-runtime/architecture.md#interface) and notification/process [Adapters](adapters/architecture.md#interface) |
| Parent | Construct [OperatorInterface](operator-interface.md#interface) with the combined event subscription, the attributable activity subscription and terminal capabilities; start presentation before execute and stop it afterward |
| Worker | Construct adapters and AgentRuntime from their relevant settings |
| Worker | Bind action capabilities, selection storage and event publishing; construct [TaskEngine](task-engine/architecture.md#interface) with the selected workflow and workflow-state filepath |
| Worker | Subscribe to TaskEngine events before calling run; send events and the final result through the worker protocol |

Terminal capabilities come from the process's standard output. A stream that fails or closes stops
presentation rendering to it while execution continues; the boundary releases its stream listeners
once presentation has stopped and the failures of the writes it issued have arrived.

OperatorInterface receives worker and parent events through one combined subscription and
attributable agent activity through a separate live subscription. Prepare recovery context from the
original request, failure, available output, execution-state paths and task [workspace
reference](workspace.md#layout-and-reference) when known. Always run recovery in a separate
operational workspace, so it can discard a broken finite delivery attempt without deleting its own
working directory. Initialize that workspace's worktree as a Git repository before the invocation,
so the configured [coding provider](adapters/coding-runtime.md#behavior) accepts its working
directory. Include the current project configuration and recovery scope in the context. Pass context
to AgentRuntime.run with the configured recovery profile. Use the [Notifications
adapter](adapters/notifications.md#interface) to publish the associated Markdown recovery report,
with its observed identity and decision. Never send outcome JSON as the narrative or infer a
recovery decision from Markdown.

Use the TaskEngine-owned [validation-error context](task-engine/actions/architecture.md#rejection-evidence-and-continuation)
helpers for readable failure evidence. Supply relevant errors and original report references to
recovery, including when selection is later cleared. Do not supply a correction-record protocol.
Application owns evidence for its recovery reports; action owners retain their own report feedback. The runtime
interface and worker control protocol remain unchanged.

### Worker entry point

The internal worker entry receives the absolute project filepath, the selected workflow and the
execution's log directory, which names where each invocation's own activity log is written.
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

Preserve report rejection evidence before reconciliation or cleanup. Repairing an old report does
not by itself resolve the next invocation's feedback: retained continuation loads it from its owning
area after reselection. Existing failures without this evidence require explicit reconciliation
from available rejected output and diagnosis; unknown output or invocation identity stays unknown.
Recovery report failures retain output and reason under the stable project recovery area, and a later
permitted recovery invocation receives that feedback. A malformed recovery response still stops
the execution for attention; evidence retention grants no additional invocation.

For finite delivery, when a blocker must run first, recovery ranks it first and returns the interrupted ticket to the configured implementation-ready status
immediately after it. Recovery discards disposable finite delivery work and preserves preparation
repositories and immutable handoffs, following the continuation rules in
[PrepareWorkspace](task-engine/actions/prepare-workspace.md#behavior). It clears the active source pointer and
selection, then resets queue execution to initial selection. The normal workflow processes the
blocker, then starts an ordinary interrupted task anew from updated base. A first implementation
continues the recorded preparation repository; incompatible continuation needs attention.
Cleanup follows the RecoveryRole contract. Application has no special blocker execution mode or return target.

Each recovery invocation consumes the configured allowance for this execution. Worker restarts and
queue reordering do not reset it. Exhaustion, failed recovery or a needs-attention decision ends execution
with needs-attention.

Apply the decision without independently classifying the repair, requiring proof of changed state or
judging progress past an earlier failure. Recovery owns that judgment. Task selection, workflow
transitions and verification/completion gates remain worker responsibilities; recovery reports do not
replace them.

## State and reports

Application supplies one stable project execution directory for the composed parent and children:

```text
<storage root>/executions/<project>/
├── workflow.json
├── selection.json
├── logs/
├── recovery/
└── memory/
```

`memory/` exists once memory is enabled and retains the project's recorded terminal handoffs,
extracted observations, submissions and outcomes beside the queue execution state. The store is
outside every task workspace and disposable workflow attempt, so pending and interrupted analysis
survives process exit.

Child stage artifacts live in their areas within the shared issue workspace. All children use the
parent execution snapshot, selection, logging and recovery directories. Retained legacy standalone
queue snapshots must be explicitly reconciled before the first project-parent run; do not attempt to
restore an incompatible snapshot or discard unfinished delivery evidence silently.

The runner owns workflow.json; the selection action owns selection.json. These records are outside task
workspaces. Application retains its request, recovery count and reports under recovery/, alongside
the separate operational workspace. Issue workspaces live under
`<storage root>/workspaces/<project>/<issue>/`. Project identity distinguishes execution directories.

At worker startup the runner resets terminal workflow state before execution, as specified in
[ExecutionRunner](task-engine/execution-runner.md#persistence). This does not erase an active selection or workspace; recovery explicitly reconciles those
when a fresh restart is needed.
Recovery allowance persists across worker restarts. The task source owns queue order.

Retain per-invocation Markdown reports and their saved outcomes in the recovery area. Producer-owned
readers preserve former summary/decision reports as readable history under the shared compatibility
rules. A usable legacy recovery decision is subject to the existing recovery allowance and request
association; historical output does not authorize a different execution. Publish the saved recovery
Markdown and use its readable explanation for a needs-attention result. Notification failure is
reported separately and does not repeat recovery. Provider acceptance confirms submission, not inbox
delivery.

## Installation activation

Prepare the installed build from the merged revision whose required checks passed. Keep the
currently running installation intact while any execution uses it; wait for active work to finish
or reach a normal retained stop before switching the configured launch target. Preserve project
configuration, checkouts, checkpoints, feedback and consumed allowances. Verify the resolved launch
target corresponds to the checked revision before restarting; a build in a checkout alone is not
activation evidence. Retained legacy failures are explicitly reconciled using their available
diagnosis and output before continuation through the normal workflow gates.

Run Nexus in WSL in a separate visible terminal attached to that session, with
`TERM=xterm-256color` and `COLORTERM=truecolor`.

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
interleave safely. Application writes each received entry with its timestamp to the matching file,
then forwards it to OperatorInterface's live activity input. Each activity file line is
`{ "timestamp": <ISO timestamp>, "activity": <AgentEvent> }`. Open the file before the first
packet, drain it before recovery reads the logs and keep logging after terminal presentation
closes. The same contract applies to one or several agents and to recovery.

Application owns logger subscriptions and file lifecycle. Open the main log before publishing
starting, drain pending writes before recovery reads logs, and close logs after finished on every
exit path. Include relevant log filepaths in recovery context. Logging uses ordinary file
subscribers, without a logging framework, rotation policy or additional workflow state.

A log write failure is reported to stderr once; execution continues. Do not invoke recovery solely
for a logging failure. Initialization errors before a log can be opened remain stderr diagnostics.

## Idea refinement composition

The project parent invokes the [idea refinement child](idea-refinement/spec.md) for selected idea
stages. Application loads its XState definition and binds project-scoped actions; it does not
provide a second workflow router. Source selection and updates use the project's Jira task-source
adapter. Selection reuses the issue workspace's refinement area when present, and StartIdeaRound creates
a plan for each conversation cycle. An idea moved to the waiting-for-feedback state is a successful
terminal workflow outcome, not an execution fault requiring recovery. A provider or agent failure
remains an execution fault.

Recovery receives the selected workflow, source item, snapshot and relevant log paths. It
diagnoses execution failures without conflating them with idea decisions or cycle exhaustion.

## Memory composition

Bind [AnalyzeExperience](task-engine/actions/analyze-experience.md) into every workflow's terminal
handoff paths under [Memory integration](memory/integration.md). Application supervises and resumes
the action-owned durable background capability across worker exit, queue drain and restart. It does
not construct a memory client, process observations independently or automatically ingest/recall memory in other roles. It retains explicit agent MCP configuration
through the coding provider settings. Memory calls and analysis logic belong exclusively to the action. Settling pending work
reports diagnostics without changing business results. Operational-error handoffs retain the
original fault and wait for active agents to settle before invoking the action and then recovery.
Application records one only for an execution fault of the attempt the invocation's own events
established, and never for a declared blocked outcome or a failed selection, whose terminal handoff
the workflow already routed or skipped.

Preparation handoff binding imports the preparation-owned attempt and round declarations. For a
new-format stage, derive the opaque handoff `attemptId` from the retained unique attempt value,
stage and round (or an explicit no-round value). Use an unambiguous encoding of this tuple, not a
new UUID at capture time. Normal preparation terminals, publication/handoff failures and preparation
operational-error capture use this same derivation. Keep the existing workflow and terminal names;
stage/round distinguishes handoffs within an attempt, and the unique value distinguishes fresh
attempts. Retries reconstruct the same tuple from retained state. A missing pre-upgrade identity
uses the former binding's stage/round or no-round value for that retained legacy attempt, including
its existing operational-error workflow naming. An invalid identity is unavailable capture, never
an invitation to silently create another request. Selection-failure capture keeps its existing
ownership contract and does not fabricate a preparation attempt.

### Successful preparation evidence binding

The project parent routes successful stage publication, evaluated skips and upstream corrections
directly to the next destination. Its successful analysis boundary is the completed implementation
handoff. Failure and attention bindings retain their current stage evidence, reasons and destinations.

For the final success, derive the existing preparation handoff identity from Architecture's retained
attempt and round declarations, keeping the legacy fallback. First ask AnalyzeExperience's
[recorded capture replay](task-engine/actions/analyze-experience.md#recorded-capture-replay)
capability to reuse that identity. Any non-null replay result ends capture normally; only a missing
request selects new evidence. This prevents an upgrade from rebuilding an older final request with
a conflicting expanded artifact list. No binding reads the action's private store.

For a new final request, use the preparation issue root as `workspaceRoot`. Select regular files in
`parent/` and each preparation stage's `state/`, all retained numbered `artifacts/<round>/` trees
and retained `report-feedback/`. Stage areas and round enumeration use preparation-owned contracts;
missing areas contribute nothing. Enumerate in stable stage, numeric-round and path order, selecting
each path once. Do not filter by the latest plan, accepted outcome or latest authored revision:
cumulative rounds retain rejected revisions, evaluated skips, corrections and reevaluations. Source
snapshots and attributed conversation travel with their retained round/parent inputs. Preserve the
original records and paths so stage, round, revision and source attribution remain readable.

Expand this selection with the associated Markdown from producer report declarations, including
reports referenced outside their round tree. Required missing or unreadable selected evidence uses
the existing unavailable outcome. Checkouts, delivery histories and the separate idea-refinement
area are not preparation evidence trees; referenced reports still follow the normal evidence-scope
rules. No history is synthesized from the mutable checkout or reread from Jira. The action copies
the selected evidence into its own durable area before recording a new request. Final success uses
the existing `preparation` workflow, `preparation-handoff` terminal and `handed-off` outcome; broader
evidence does not create a new attempt identity or change failure evidence selection.
