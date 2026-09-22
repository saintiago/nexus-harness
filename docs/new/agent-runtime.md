# AgentRuntime

Status: proposed component design.

## Responsibility

Execute one configured agent role with complete input, the role's tool permissions and a typed result.
Own profile resolution, prompt assembly, runtime invocation, activity normalization, output validation
and shutdown. Do not select tasks, decide repair counts or declare integration complete.

The public module is `src/agent-runtime/index.ts`. Role definitions are data and focused prompt/output
handlers within one module boundary, not independent orchestrators.

## Interface

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary).

### Provided interface

```ts
interface AgentRuntime {
  invoke<R extends AgentRequest>(
    request: R,
    observe: Observer<AgentEvent>,
    stop: AbortSignal,
  ): Promise<AgentResult<R>>;
}

type InvocationInput = {
  executionId: string;
  invocationId: string;
  profileId: string;
  context: ArtifactRef;
  deadline: string;
};

type DeveloperRequest = InvocationInput & {
  role: 'developer';
  workspace: { id: string; path: string };
};

type ReviewerRequest = InvocationInput & {
  role: 'reviewer';
  workspace: { id: string; path: string };
  candidate: { base: string; head: string };
};

type RecoveryRequest = InvocationInput & {
  role: 'recovery';
  incidentId: string;
};

type AgentRequest = DeveloperRequest | ReviewerRequest | RecoveryRequest;

type AgentEvent = {
  invocationId: string;
  sequence: number;
  at: string;
  kind: 'started' | 'activity' | 'stopping';
  text: string;
};

type OutputFor<R> = R extends DeveloperRequest ? DeveloperOutput
                  : R extends ReviewerRequest ? ReviewerOutput : RecoveryOutput;

type AgentResult<R extends AgentRequest> = {
  invocationId: string;
  profile: { id: string; model: string; effort: string | null } | null;
  shutdown: Shutdown;
  transcript: ArtifactRef | null;
} & (
  | { outcome: 'completed'; output: OutputFor<R>; fault: null }
  | { outcome: 'failed' | 'cancelled'; output: null; fault: Fault }
);
```

One invocation ID identifies one request, profile snapshot and transcript. A concurrent duplicate is
rejected; a finished identical request can return its retained result without another agent turn.
Reuse with different input is an input fault. An interrupted invocation is not implicitly resumed or
replayed. The caller authorizes a new invocation. An already-expired deadline launches no process.

`completed` means a valid role output was produced and owned shutdown was confirmed. It does not
establish that the agent's claims are true. `cancelled` requires an intentional signal and confirmed
shutdown. A timeout, malformed output, provider failure or unconfirmed shutdown returns failed with
the retained transcript where available. The profile is null only when resolution failed before
launch; a completed result always identifies its resolved profile. No silent model fallback or
additional repair turn occurs here.

### Role outputs

```ts
type FindingResponse = {
  findingId: string;
  disposition: 'addressed' | 'disputed' | 'unresolved';
  explanation: string;
  evidence: readonly ArtifactRef[];
};

type DeveloperOutput = {
  summary: string;
  changes: readonly { what: string; why: string }[];
  findingResponses: readonly FindingResponse[];
  verification: readonly { claim: string; evidence: readonly ArtifactRef[] }[];
  remainingIssues: readonly string[];
};

type ReviewFinding = {
  id: string;
  severity: 'blocking' | 'non-blocking';
  title: string;
  body: string;
  location: { path: string; firstLine: number; lastLine: number } | null;
  evidence: readonly ArtifactRef[];
};

type ReviewerOutput = {
  reviewed: { base: string; head: string };
  verdict: 'approve' | 'request-changes' | 'inconclusive';
  summary: string;
  findings: readonly ReviewFinding[];
  priorFindings: readonly {
    findingId: string;
    disposition: 'resolved' | 'open' | 'withdrawn';
    reason: string;
  }[];
  limitations: readonly string[];
};

type RecoveryOutput = {
  incidentId: string;
  cause: string;
  evidence: readonly ArtifactRef[];
  actions: readonly {
    description: string;
    outcome: 'confirmed' | 'failed' | 'uncertain';
    evidence: readonly ArtifactRef[];
  }[];
  tickets: readonly { key: string; reason: string }[];
  recommendation:
    | { kind: 'retry-current'; reason: string }
    | { kind: 'run-blocker'; key: string; reason: string }
    | { kind: 'reinspect'; reason: string }
    | { kind: 'operator-action'; reason: string };
  summary: string;
};
```

Every supplied unresolved finding receives a developer response and a reviewer disposition; missing
IDs make the output incomplete. Finding bodies are preserved, never shortened to fit a report field.
Approval cannot contain an open blocking finding. Request-changes requires a blocking finding or a
prior blocking finding explicitly left open. Inconclusive states what could not be established.
Reviewer revision identities must match the request. Structural validation detects these contract
violations; it does not replace investigation of the code or independently execute the claimed checks.

Recovery actions distinguish an attempted mutation from a confirmed result. A created blocker ticket
must have a confirmed source identity before it can be recommended. Recommendations do not directly
restart or replace an executing queue. Notifications are produced by the caller from the retained
report, not sent independently by a second agent-side reporting path.

### Input artifacts

`context` is a JSON manifest matching ContextManifest. Its role and identities must match the request.
The original intent and process observations supplied for recovery are exported evidence interpreted
by the role, not another component's private schema imported into this component.

```ts
type HistoryEntry = {
  id: string;
  author: string;
  role: 'human' | 'developer' | 'reviewer' | 'recovery' | 'system';
  at: string;
  content: ArtifactRef;
};
type ContextManifest = {
  version: 1;
  history: readonly HistoryEntry[];
  historyGaps: readonly string[];
  evidence: readonly ArtifactRef[];
} & (
  | {
      role: 'developer' | 'reviewer';
      task: {
        source: string;
        id: string;
        key: string | null;
        title: string;
        description: string;
        acceptanceCriteria: readonly string[];
      };
      unresolvedFindings: readonly ReviewFinding[];
      workspaceObservation: ArtifactRef;
      instructions: readonly string[];
    }
  | {
      role: 'recovery';
      incidentId: string;
      originalIntent: ArtifactRef;
      fault: Fault | null;
      processObservations: readonly ArtifactRef[];
      continuation: ArtifactRef | null;
    }
);
```

History is ordered by the producer's recorded conversation order; timestamps alone do not resolve
ties. No prior conversation is an empty history, whereas missing expected material is described in
historyGaps. A missing fault or continuation is explicit absence, not a reason to invent one.

Required task requirements and unresolved finding bodies are included completely in the prompt.
The full indexed history remains readable through immutable artifacts during the invocation. Material
limits are checked before launch; return an input fault when required content cannot fit. Do not
silently summarize or truncate it. Historical text and tool results are evidence, not authority to
change role permissions or host configuration.

### Required interfaces

Use [CodingRuntime.execute](adapters.md#coding-runtime) for provider protocol, process ownership and
raw output. Supply a resolved model, effort, prompt, output schema, deadline, working directory and
tool policy. Translate RuntimeEvent into AgentEvent and validate the returned output as the requested
role. The returned shutdown evidence is part of the public result; process exit alone is insufficient.

Authorized external tools use the [adapter contracts](adapters.md#interface). The role definition
selects capabilities; the coding provider cannot grant more by choosing a different profile. Recovery
uses exported component interfaces and operational tools, not writes into other components' private
ledgers. This is the complete cross-component boundary; role handlers do not import task or execution
orchestration modules.

## Profiles and permissions

A profile supplies model, reasoning effort and provider settings. A role supplies its instructions,
output contract and capabilities. Bind and validate them before invocation; reject a profile that
the configured provider cannot execute. Store the resolved nonsecret snapshot with the result.

Developer may inspect context, modify the assigned repository and run local checks. It leaves local
work and meaningful commits; publication and task-source mutation are not developer capabilities.
Reviewer may inspect the assigned candidate and run checks in that workspace when exclusive access
has been supplied. Generated check artifacts are allowed; changing candidate source, publishing
approval or altering task state is not. A changed reviewed revision invalidates the result.

Recovery may investigate and repair authorized operational resources, modify a stopped workspace,
reconcile source state, create/rank a blocker ticket and prepare a verified continuation recommendation.
It may not bypass completion gates, falsify check evidence, force a task to Done, edit private ownership
records or start another queue process. The configured resource scope includes the connected project
and required host tools; broad permissions remain exclusive to this role. The initial recovery
profile is selected by its caller; this component does not hard-code a recovery model.

Resolve credential references only for authorized external tools. Do not put credential values in
prompts, transcripts or general child environments. Enforce capabilities with available tool/process
isolation; a prompt instruction alone is not a sandbox. Refuse a role when the host cannot provide
its required isolation, rather than claiming restrictions that are not enforced.

## Internal design and lifecycle

Four units own the work: profile resolver, role prompt builder, invocation controller and output
validator. Role prompts state purpose, permitted actions and required output. Repository documentation
supplies the product's intent; task text supplies the change. Avoid duplicating repository rules in
each role prompt.

```text
validate input/profile → assemble complete context → launch → collect → validate output → finish
                                                        ↘ stop → retain partial evidence → finish
```

The controller owns one invocation directory, resolved profile, prompt manifest, activity stream,
raw transcript and parsed result. Finish immutable artifacts before exporting them. Record faults
without losing a partial transcript. Raw output remains available when parsing fails; it is not
turned into a guessed success. The validator does not ask the agent to repair its own output through
an uncounted extra turn.

Only one writer is allowed for a supplied workspace. The caller grants exclusive use for the
invocation; this component cannot acquire permission by noticing that a directory exists. Release
its owned handles after shutdown and return any uncertainty to the caller. Retained agent sessions
are provider details, never a substitute for the supplied context or an implicit task continuation.

## Cancellation

Forward an intentional stop promptly and enforce the request deadline. Stop owned subprocesses,
including tools, within the configured shutdown grace period. Await shutdown before returning a
completed or cancelled result. On unconfirmed shutdown, retain process evidence and return failed;
do not launch another agent. Observer failure affects reporting only and cannot create an agent retry.
