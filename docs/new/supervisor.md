# Supervisor

Status: proposed component design.

## Responsibility

Own one execution's process lifecycle, its original intent and its operational recovery. Preserve
exclusive execution ownership while work runs, stops or is being recovered. Decide whether a work
invocation may start; do not decide individual implementation, review or delivery steps.

The public module is `src/supervisor/index.ts`. Its production host is the parent process of the
work process. One execution targets the project configuration filepath supplied by its caller.
Multiple projects can use separate instances and ownership namespaces.

## Interface

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary).

### Provided interface

```ts
interface Supervisor {
  execute(
    request: ExecutionRequest,
    observe: Observer<ExecutionEvent>,
    stop: AbortSignal,
  ): Promise<ExecutionResult>;
}

type ExecutionMode =
  | { kind: 'finite' }
  | { kind: 'watch' }
  | { kind: 'single-ticket'; key: string }
  | { kind: 'single-task'; file: string };

type ExecutionRequest = {
  executionId: string;
  projectConfigPath: string;
  mode: ExecutionMode;
};

type ExecutionEvent = {
  executionId: string;
  sequence: number;
  at: string;
  body:
    | { kind: 'lifecycle'; state: 'starting' | 'running' | 'recovering' | 'stopping' }
    | { kind: 'task'; key: string | null; stage: DisplayStage }
    | { kind: 'activity'; role: 'developer' | 'reviewer' | 'recovery'; text: string }
    | { kind: 'notice'; severity: 'info' | 'warning' | 'error'; message: string };
};

type DisplayStage = 'preparing' | 'implementing' | 'verifying' | 'reviewing'
                  | 'integrating' | 'waiting' | 'recovering' | 'finished';

type ExecutionResult = {
  executionId: string;
  outcome: 'completed' | 'cancelled' | 'needs-attention' | 'rejected';
  completedTasks: number;
  activeTaskKey: string | null;
  reason: string | null;
  shutdown: Shutdown;
  report: ArtifactRef | null;
};
```

Execution IDs are supplied by the caller and may not be reused for new work. A previously completed
ID returns its recorded result without executing again. An active ID or another live owner returns
`rejected`; it never creates a second worker. An incomplete record after a prior crash enters the
startup recovery rules below, rather than being treated as a fresh request.

Events describe this component's execution view. Their sequence increases within one execution.
Neither downstream phase names nor downstream private result objects become part of this API.
The result settles only after all owned invocations have ended or shutdown is explicitly unconfirmed.

`completed` means the requested work ended through its configured gates. `cancelled` requires
intentional stop and confirmed shutdown. `needs-attention` preserves unresolved failure or ownership.
`rejected` means execution was not admitted. A report may be null only when no execution was admitted
or persistence itself failed; it is never fabricated from a missing record.

### Required interfaces

| Port | Provider contract | Values exchanged |
| --- | --- | --- |
| Work | [TaskEngine.run and inspect](task-engine.md#provided-interface) | EngineRequest, EngineEvent, EngineResult, EngineInspection |
| Recovery invocation | [AgentRuntime.run](agent-runtime.md#provided-interface) | Recovery profile ID, WorkspaceRef, AdditionalContext and RecoveryOutput in AgentResult |
| Notification | [Notifications.publish](adapters.md#notifications) | NotificationRequest and publication receipt |

These are constructor-injected dependencies. The work port's parent-side process bridge owns
transport and process handles; this component decides when it is invoked and cancelled. The bridge
must return observed shutdown, not trust a child's claim that cleanup succeeded.

The [worker startup contract](high-level-architecture.md#configuration-and-startup) accepts
projectConfigPath as an absolute filepath. Retain it as execution intent and pass it on each launch.

For recovery, use the [workspace data contract](workspace.md#layout-and-reference) and construct
AdditionalContext from the incident and available evidence. Pass the reference and context directly
to AgentRuntime.run. If the task workspace is unavailable, supply a separate operational workspace
reference for recovery.

Map finite mode to queue selection with return-on-empty, watch to queue selection with wait-on-empty,
single-ticket to the exact named selection, and single-task to the supplied file.
A recovery continuation is passed back through the work port as an opaque exported artifact. Do
not inspect private checkpoint fields or manufacture a phase to skip a gate.

Map downstream progress into DisplayStage and role activity here. The work port's finer phase model
is not exposed to the execution-view consumer. Missing progress does not imply a hung process.
After abnormal termination, obtain the last durable public evidence through `inspect`. Aggregate
verified completions from results and inspection by source and stable task identity, so lost or
repeated progress events cannot lose or double-count completed tasks.

### Construction settings

Construction requires bound ports and lifecycle, storage, recovery and notification settings conforming
to [Nexus configuration](configuration.md#nexus-configuration). These inputs are available before the
first child launch. Credentials remain references in settings and execution records.

Retain the original project configuration filepath, mode and target across child restarts. Preserve
the recovery allowance and continuation reference when launching a replacement child.

## Internal lifecycle

```text
admission → running → finished
                 ↘ incident → recovering → running
                                          ↘ attention
any active state → stopping → cancelled or attention
```

Admission validates input and acquires the project execution lease before starting a child. Lease
identity includes canonical source/project/repository identity, not just a display key. It spans
work invocations and recovery, so there is no unowned gap in which another supervisor may enter.

A normal completed work result ends finite or single-target execution. Ordinary coding repairs and
review iterations do not create incidents. An unexpected child exit, invalid result, or blocked work
result opens one incident with whatever evidence is available, including an explicit absence of a
terminal report. Exit code zero without a valid result is not completion.

Before invoking recovery, stop and verify the previous writer. When termination cannot be confirmed,
retain ownership and return attention. A recovery invocation with write permissions must not run
beside a potentially live writer. A bounded inability to establish shutdown is itself useful evidence.

Persist incident intent before invoking recovery. The recovery report can recommend:

- Retry the current work after an operational repair.
- Run one identified blocker, then return to the interrupted work.
- Re-inspect the original scope because recovery believes it is complete.
- Stop for an operator decision.

The recommendation never proves completion. Re-inspection goes through the work port's normal
verification. A blocker plan records the next target and the original return intent, runs that target,
then restores the original intent. If the blocker itself fails, recovery can revise the next target
under the same incident allowance. Preserve the original continuation; do not build a dependency
graph or require the lifecycle controller to infer task dependencies.

Each recovery invocation consumes the incident allowance. Do not restart an unchanged failure
merely because recovery returned successfully: require recorded corrective actions or new evidence
supporting a safe retry. The incident remains open through retries and blocker work until the original
interrupted work progresses past the failure or its scope is verified complete. Restarting a child
does not reset the allowance. Exhaustion returns attention. A recovery invocation failure does not
start another recursive recovery agent.

## Cancellation and restart

Persist intentional stop as soon as it is received. Stop the active invocation and wait for bounded
shutdown. Confirmed shutdown returns cancelled; unconfirmed shutdown returns attention with the
stop intent retained. Neither outcome automatically restarts.

Owner records contain process identity including creation identity, execution ID and a random owner
token. Age alone cannot release a lease. On startup, a live owner rejects admission; a proven-dead
owner with unfinished execution produces an incident. An inconclusive identity check stops for
attention. Local ownership provides no cross-machine coordination.

A stale intentional-stop record remains stopped. A fresh operator request can authorize a new
execution after the previous shutdown is established; it does not erase retained evidence.

## Records and notifications

Own execution records, invocation identities, cancellation intent, incident records, recovery
allowance, pending blocker/return intent and notification receipts. Use exclusive creation and
atomic file replacement under the configured storage root. Do not create another task ledger.

Export an immutable incident bundle containing intent, last public work result/progress, public
continuation and evidence references, process identity and the observed failure. Do not infer a
successful operation from an agent's narrative or read private downstream records as a shortcut.

Persist each recovery report before notification. Publish a concise incident summary through the
configured notification port. A confirmed receipt records service acceptance, not inbox delivery.
A failed or uncertain publication is recorded separately; it does not replay recovery, undo its
actions or cause blind duplicate notification. Final results disclose this reporting limitation.
