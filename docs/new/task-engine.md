# TaskEngine

Status: proposed component design.

## Responsibility

Carry selected work through its normal lifecycle: intake, workspace preparation, development,
checks, review and configured completion. Own task ordering, ordinary repairs, escalation between
configured role profiles, task evidence and retained conversation. Process one task at a time.

The public module is `src/task-engine/index.ts`. One instance is bound to a connected project and
validated, immutable settings. Its internal units are ordinary modules in the same process.

## Interface

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary).

### Provided interface

```ts
interface TaskEngine {
  run(
    request: EngineRequest,
    observe: Observer<EngineEvent>,
    stop: AbortSignal,
  ): Promise<EngineResult>;
  inspect(invocationId: string): Promise<Result<EngineInspection>>;
}

type EngineRequest = {
  executionId: string;
  invocationId: string;
  selection:
    | { kind: 'queue'; whenEmpty: 'return' | 'wait' }
    | { kind: 'ticket'; key: string }
    | { kind: 'file'; path: string };
  continuation: ArtifactRef | null;
};

type TaskIdentity = { source: string; id: string; key: string | null };

type EnginePhase = 'selecting' | 'preparing' | 'baseline' | 'developing'
                 | 'checking' | 'reviewing' | 'delivering' | 'completing' | 'idle';

type EngineEvent = {
  invocationId: string;
  sequence: number;
  at: string;
  body:
    | { kind: 'phase'; task: TaskIdentity | null; phase: EnginePhase }
    | { kind: 'activity'; role: 'developer' | 'reviewer'; text: string }
    | { kind: 'verified'; completion: VerifiedTask }
    | { kind: 'evidence'; inspection: EngineInspection };
};

type VerifiedTask = {
  task: TaskIdentity;
  revision: string;
  completion: 'local' | 'integrated';
  evidence: ArtifactRef;
};

type EngineResult = {
  invocationId: string;
  outcome: 'drained' | 'target-completed' | 'blocked' | 'cancelled';
  activeTask: TaskIdentity | null;
  verified: readonly VerifiedTask[];
  fault: Fault | null;
  shutdown: Shutdown;
  continuation: ArtifactRef | null;
  report: ArtifactRef | null;
};

type EngineInspection = {
  invocationId: string;
  state: 'unknown' | 'active' | 'terminal' | 'interrupted';
  activeTask: TaskIdentity | null;
  verified: readonly VerifiedTask[];
  continuation: ArtifactRef | null;
  report: ArtifactRef | null;
  evidence: readonly ArtifactRef[];
};
```

`run` admits at most one invocation per instance and one writer per task/workspace. An invocation
ID cannot describe different input. A completed invocation returns its recorded result without
repeating effects. An existing active or interrupted invocation is not silently replayed; continuation
uses a new ID and an exported continuation. Invalid input returns blocked with an input fault and
no new task effects.

`drained` is valid only for queue selection after a successful fresh empty read. Watch waits on an
empty read and exits through cancellation or a fault. `target-completed` is valid only for the exact
selected ticket or local file. A missing, invalid or ineligible target is blocked unless its completion
can be verified through the configured completion gates. It is never equivalent to an empty queue.

`verified` contains this invocation's confirmed completions, with source identity preserved. It
is also retained durably as each completion is established. Callers aggregate by source and stable
task ID, not by display key or event count. `local` means the configured local checks passed; it
does not imply publication or a source transition. `integrated` requires every configured integration
gate. A blocked outcome has a fault; a cancelled outcome requires confirmed shutdown. Unconfirmed
shutdown is blocked. A report is null only before admission or after a persistence failure.

`inspect` is a read-only public export available in the parent-side provider even when a work
process died. It reads only this component's records, makes no task mutations and launches no work.
It exports the last durable evidence and continuation, including when there is no final report.
Interrupted means process death was established; otherwise an unfinished record remains active.
Absent records return unknown with empty evidence, never invented success. Corrupt records return
a fault. Inspection is a snapshot, not permission to write or proof that every descendant stopped.

A continuation is opaque to callers. It identifies the connected project, original scope,
interrupted task, workspace and evidence. Validate these identities before use. Resume that task
before selecting fresh queue work. A caller temporarily running a different target supplies no
continuation for that invocation and retains the original continuation for return.

### Required interfaces

| Port | Provider contract | Use |
| --- | --- | --- |
| Role invocation | [AgentRuntime.invoke](agent-runtime.md#provided-interface) | DeveloperRequest, ReviewerRequest and their role results |
| Task source | [Jira](adapters.md#jira) | Read source documents and ordering; conditionally update task state, fields and reports |
| Repository | [Git](adapters.md#git) | Observe and prepare revisions/workspaces; publish an observed branch |
| Delivery | [GitHub](adapters.md#github) | Publish and observe pull requests, review, checks and integration |
| Commands | [Processes](adapters.md#processes) | Run configured setup/check commands with owned shutdown and captured evidence |

Dependencies are injected at construction. Local task files are an owned input format, not a Jira
emulation. Source documents are normalized into the owned Task record below. Public role requests
are built from that record and exported context; returned role outputs are recorded, then checked
against observed repository and delivery evidence. A report claiming success cannot substitute for
any required adapter observation. No presentation or supervisor dependency is required.

## Internal composition

QueueCoordinator owns sequencing. The other units each own one part of the task lifecycle and
return facts or decisions to that coordinator; they do not call one another's private helpers.

| Unit | Owns | Result supplied to the coordinator |
| --- | --- | --- |
| TaskIntake | Source interpretation, eligibility, stable identity, rank and exclusive claim | Validated Task and claim, empty selection, or intake failure |
| WorkspaceManager | Task-to-workspace identity, base revision, writer ownership and retained changes | Prepared Workspace or preparation failure |
| ExecutionRunner | Baseline, developer turns, configured checks and repair allowance | Verified revision and check evidence, or exhausted/blocked execution |
| ReviewCoordinator | Review input, findings, finding dispositions and review escalation | Approval for a revision, requested repair, or inconclusive review |
| DeliveryAndCompletion | Publication intent, receipts and exact-revision completion gates | Verified completion or unresolved delivery |
| ConversationHistory | Attributed, ordered conversation and complete context exports | Immutable role input and retained role output |

The owned Task record contains stable identity, title, description, acceptance criteria and the
source revision used for admission. Requirements come from this record; execution policy comes
from configuration. Workspace contains task identity, canonical directory, branch, observed base
and writer ownership. Neither record carries credentials or executable instructions for the host.

## Lifecycle and decisions

```text
select → claim → prepare → baseline → develop → check → publish → review → complete
                                      ↑         │                 │
                                      └─ repair ┘                 │
                                      └──── review repair ────────┘
```

Publication and external review/completion are conditional on configured capabilities. A local
execution can finish after successful checks. An execution with review enabled must obtain a review
of the exact candidate revision. When review is attached to a pull request, publication precedes
that review. Configuration validation rejects impossible combinations before claiming work.

Intake reads the configured ordering without reserving the whole queue. Validate requirements and
eligibility, acquire a local claim, then request the source transition against the observed revision.
Re-read a conflict instead of overwriting an observed human change. The source port defines the
strength of its concurrency guard; a local claim does not make remote writes atomic. A source error is a failure,
not an empty selection. Local ownership cannot provide cross-machine exclusion; that deployment
requires an external claim mechanism with the same exclusivity guarantee.

Preparation verifies workspace identity and prior ownership. Preserve committed and uncommitted
work. Dirty work alone is not grounds to refuse continuation: include its status and provenance
in the developer's context. Do not automatically reset, stash or create a checkpoint commit.
Uncertain ownership or an incompatible workspace is blocked before a writer starts.

Run configured preparation and baseline checks before development. A pre-existing baseline failure
is distinct from a candidate regression. Record it and return blocked for operational recovery;
do not spend ordinary implementation repairs on an unrelated environment failure. Requirements
that explicitly ask to repair that baseline can make it part of the task, with the evidence retained.

Failed candidate checks enter the configured repair allowance. Requested review changes enter
review repair. Both keep complete findings and prior responses in context. Explicit configuration
sets per-profile repair allowance, review rejection allowance and the ordered escalation profiles.
Exhaustion advances to the next configured profile; exhaustion of the last profile returns blocked.
Counters belong to the task and survive process restarts; a new invocation does not reset them.
Inconclusive review returns blocked with its limitation; it is neither approval nor a substantive
rejection and cannot create an unbounded review retry loop.

Checks execute against an identified workspace revision and working-tree state. Approval identifies
the exact reviewed head and base. A change invalidates evidence affected by that change; never
reuse approval for another revision. Before integration, observe required check/review results
and current pull-request identity. Completion requires observed merge, configured post-merge
workflows for that merge revision, then the permitted source transition. Retain receipts between
these steps so an interrupted transition cannot cause duplicate publication or an inferred merge.

After each completion, select again. Do not continue to unrelated tasks after an unresolved ownership,
delivery or execution failure. Deadlines and check commands are configuration, not task prose; an
internal repair does not silently extend the configured deadline.

## Conversation and records

Keep a task ledger, workspace identity, repair counters, check evidence, review findings and
external-effect receipts. Each unit owns its record format; the coordinator records transitions
only after required facts exist. Use atomic local writes and stable task identity. Record mutation
intent before an external write and its receipt afterwards. An unknown outcome remains unknown
until an authoritative observation resolves it.

Conversation is append-only, attributed and ordered. Preserve full task requirements, human comments,
developer reports, reviewer findings and recovery reports admitted from the source. Retain original
finding bodies and stable finding IDs across revisions; a summary is not the finding. Refresh source
conversation before each role invocation and export an immutable snapshot plus an ordered artifact
index for the complete history. Track what was supplied to each role independently.

Current requirements and unresolved findings must be complete in the active input. Older history may
be accessed through indexed artifacts rather than repeated inline. An input limit must never silently
truncate either. If complete required material cannot be supplied, return an explicit context failure.
Neither role needs to reread Jira to reconstruct a conversation already captured here.

Export EngineInspection after durable transitions. Its artifacts are the public recovery boundary;
private ledger files are not an integration API. A continuation re-observes mutable workspace/source/
delivery state before deciding the next step. It does not trust a stored phase as permission to skip
a gate or overwrite a newer human decision.

## Cancellation

Stop selecting new work immediately. Cancel the active role or command, wait for owned shutdown,
persist available evidence and preserve the workspace. A remote operation interrupted after dispatch
has an uncertain outcome until observed; cancellation cannot erase its effect. Release a claim only
when its writers have stopped and its source disposition is known. Return blocked when either cannot
be established. No exceptional recovery agent is launched inside this component.
