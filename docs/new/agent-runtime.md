# AgentRuntime

Status: proposed component design.

## Responsibility

Run a configured agent profile in a supplied workspace with additional context prepared by the caller.
Own the profile catalogue, runtime instructions, prompt assembly, provider invocation, output parsing
and shutdown. The caller selects task information and artifacts for the invocation.

## Interface

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary) and the plain
[WorkspaceRef](workspace.md#layout-and-reference) value. Workspace layout and profile configuration
are supplied at construction according to the [configuration contract](configuration.md#dependency-construction).

### Provided interface

```ts
interface AgentRuntime {
  run(
    profile: ProfileId,
    workspaceRef: WorkspaceRef,
    additionalContext: AdditionalContext,
  ): Promise<AgentResult>;
}

type ProfileId = string;

type AgentProfile = {
  id: ProfileId;
  role: 'developer' | 'reviewer' | 'recovery';
  model: string;
  effort: string | null;
  instructions: readonly string[];
  toolPolicy: ArtifactRef;
};

type AdditionalContext = {
  instructions: string;
  information: string;
  artifacts: readonly ArtifactRef[];
};

type AgentEvent = {
  invocationId: string;
  sequence: number;
  at: string;
  kind: 'started' | 'activity' | 'stopping';
  text: string;
};

type AgentResult = {
  invocationId: string;
  profile: { id: string; role: AgentProfile['role']; model: string; effort: string | null } | null;
  shutdown: Shutdown;
  transcript: ArtifactRef | null;
} & (
  | { outcome: 'completed'; output: DeveloperOutput | ReviewerOutput | RecoveryOutput; fault: null }
  | { outcome: 'failed' | 'cancelled'; output: null; fault: Fault }
);
```

The profile ID selects an entry in the runtime's configured catalogue. The profile's role selects
the corresponding output schema; a completed result contains that role's output. Unknown profiles
and unsupported settings fail before launch. Each run call is a new invocation; the runtime does
not silently reuse an earlier action's agent result or add retry turns.

AdditionalContext is supplied directly. Instructions describe the work for this invocation;
information contains the task-specific context assembled by the caller. Artifact references identify
files the agent may inspect. The runtime places those references in the prompt without opening them
to discover or assemble an invocation request. The agent can read them through its permitted tools.

The calling action owns selecting and reading input artifacts, preserving complete required findings
and interpreting the result against the candidate/task it supplied. Recovery callers similarly provide
incident context through this argument. The runtime receives the request as arguments rather than
loading it from a workspace file.

Progress observation, cancellation and configured time limits are execution controls bound when the
runtime is constructed. Each invocation observes the active execution cancellation signal and emits
AgentEvent through the bound observer. These controls do not become instructions in AdditionalContext.

Completed means the configured output shape was parsed and owned shutdown was confirmed. It does not
prove that the agent's claims are true. Cancelled requires intentional stop and confirmed shutdown.
Provider errors, timeouts, malformed output and unconfirmed shutdown return failed with available
evidence. Profile is null only if resolution failed before launch.

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

The runtime validates the profile's output shape. The caller validates task-specific meaning: that
reviewed revisions match the candidate, supplied findings received dispositions, required evidence
exists and an asserted delivery actually happened. Agent reports alone cannot establish completion.
Persist full findings and responses; report formatting must not silently truncate them.

### Required interfaces

Use [CodingRuntime.execute](adapters.md#coding-runtime) for provider communication and owned launch/
shutdown. Resolve the selected profile, combine instructions and additional context, then supply the
resulting prompt, role output schema, tool policy and working directory. Creating a provider input
file from these arguments is transport serialization, not discovery of an action request.

Authorized external tools use the [adapter contracts](adapters.md#interface). The selected profile
defines the available capabilities. Neither extra context nor provider choice expands them. The
runtime has no task sequencing or supervisor dependency.

## Instructions and profiles

Nexus configuration supplies runtime base instructions and the profile catalogue. A profile adds
role instructions, model, effort and tool settings. Prompt assembly combines:

1. Runtime base instructions.
2. The selected profile's role instructions.
3. Instructions and information supplied in AdditionalContext.
4. The workspace location and caller-supplied artifact references.

The runtime adds no task information by inspecting workspace artifacts. The caller decides what is
relevant. Check the assembled input against provider limits before launch; do not silently truncate
the supplied context. Return an explicit input failure when it cannot be supplied completely.

Profile instructions describe how that role works. Repository documentation remains the source of
product intent. The additional instructions state what the particular action needs done. Context
cannot change configured permissions, select another model or rewrite host configuration.

## Permissions

Developer profiles can inspect supplied context, modify the assigned worktree and run local checks.
Publication and task-source mutation are not developer capabilities. Reviewer profiles can inspect
the candidate and run checks with exclusive workspace access; modifying candidate source or publishing
approval is outside that role. Recovery profiles can investigate and repair authorized operational
resources, reconcile stopped work and create/rank blocker tickets.

Recovery cannot falsify evidence, bypass completion gates, force a task to Done or start a competing
queue. The caller acts on its continuation recommendation and handles notifications. Broad operational
capabilities remain confined to recovery profiles.

Resolve credentials only for authorized tools. Keep credential values out of prompts, transcripts
and general child environments. Use the configured tool/process isolation to enforce permissions;
refuse an invocation when its required isolation cannot be provided.

## Internal design and lifecycle

The implementation has four focused parts: profile resolver, prompt assembler, invocation controller
and output parser. None chooses the next task or workflow state.

```text
resolve profile → assemble supplied context → launch → collect → parse output → finish
                                                 ↘ stop → retain partial evidence → finish
```

The invocation controller creates runtime-owned transcript/output files in the configured artifact
area and returns their references. This output persistence does not make it a reader of action input
records. The caller can persist the returned role result in the artifact format its consumers expect.

A workspace reference is a plain location value. It has no prepare, read-request or execute methods.
The runtime uses the supplied layout to resolve its working directory and output locations. Preparation
and action-specific artifact handling have already been assigned to their respective owners.

The caller grants exclusive workspace use for the invocation. The runtime owns its child processes
and tool executions, retains their evidence and releases their handles after shutdown. An existing
provider session never replaces the explicit profile and additional context for a new call.

## Cancellation

Forward intentional stop and enforce configured invocation limits. Stop owned subprocesses, including
tools, within the configured shutdown grace period. Completed and cancelled results require confirmed
shutdown. Otherwise return failed with the process evidence and do not launch a replacement. Observer
failure affects reporting only.
