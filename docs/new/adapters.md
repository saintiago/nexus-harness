# Adapters

Status: proposed component design.

## Responsibility

Translate explicit operations into external protocols and return observed facts. Own authentication,
provider serialization, process handles and protocol errors. Do not choose tasks, decide repairs,
infer completion or compensate for uncertain writes by repeating them.

Adapters is a family of independent modules under `src/adapters/`, each with its own public entry
point. There is no universal adapter object, provider registry or service. Construction binds each
module to a configured endpoint or host capability; ordinary dependency injection selects it.

## Interface

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary). All operations
below take an AbortSignal. Read operations return Result; write operations return Mutation. Inputs
are validated before dispatch. All identifiers, revisions and receipts come from observations rather
than being synthesized from display text.

```ts
type Operation = { id: string; deadline: string };
type Receipt = { operationId: string; providerId: string; evidence: ArtifactRef };
type Mutation<T> =
  | { outcome: 'confirmed'; value: T; receipt: Receipt }
  | { outcome: 'not-applied'; fault: Fault }
  | { outcome: 'uncertain'; fault: Fault };

type SourceDocument = { format: 'text' | 'adf'; value: string };
type SourceComment = {
  id: string;
  author: string;
  at: string;
  body: SourceDocument;
};
```

Confirmed means the named operation's documented effect was observed. Not-applied requires evidence
that no effect occurred; a timeout after dispatch is normally uncertain. Operation IDs correlate
intent and receipts. They are not a promise that every provider supports idempotency. Read-back can
resolve uncertainty only when it identifies this operation unambiguously. Never infer success from
a similar comment, matching title or generic HTTP success after a partial response.

### Jira

```ts
type JiraIdentity = { site: string; issueId: string };
type JiraTask = {
  identity: JiraIdentity;
  key: string;
  revision: string;
  title: string;
  description: SourceDocument;
  status: string;
  labels: readonly string[];
  fields: { workspaceRef: string | null; pullRequestUrl: string | null };
  comments: readonly SourceComment[];
};

interface Jira {
  list(stop: AbortSignal): Promise<Result<readonly JiraIdentity[]>>;
  read(target: JiraIdentity | { key: string }, stop: AbortSignal): Promise<Result<JiraTask>>;
  update(
    target: JiraIdentity,
    expectedRevision: string,
    change: {
      title?: string;
      description?: SourceDocument;
      transitionId?: string;
      workspaceRef?: string | null;
      pullRequestUrl?: string | null;
    },
    operation: Operation,
    stop: AbortSignal,
  ): Promise<Mutation<JiraTask>>;
  comment(target: JiraIdentity, body: SourceDocument, operation: Operation, stop: AbortSignal):
    Promise<Mutation<SourceComment>>;
  create(
    input: { title: string; description: SourceDocument; issueType: string },
    operation: Operation,
    stop: AbortSignal,
  ): Promise<Mutation<JiraTask>>;
  rank(
    target: JiraIdentity,
    position: { before: JiraIdentity } | { after: JiraIdentity },
    operation: Operation,
    stop: AbortSignal,
  ): Promise<Mutation<{ target: JiraIdentity; positionConfirmed: true }>>;
}
```

Configuration binds site, project, selection query with explicit ordering, workflow mappings and
field mappings. `list` reads all pages in provider order or returns a fault; a partial page sequence
is not a complete queue. `read` includes all comment pages, preserving attribution, full bodies and
source order. ADF is supplied as complete serialized JSON; unsupported content is not flattened away.
Requirements extraction and eligibility interpretation belong to the caller.

`revision` is an opaque concurrency observation. Before an update, re-read and reject a changed
revision before dispatch. Use an atomic precondition when supported; a read-before-write check alone
is not atomic compare-and-swap. Confirm the requested state after the write; conflicts or partial
multi-field effects remain explicit. This contract does not promise exclusion against an external
writer racing between read and write. Workflow transition IDs come from configured mappings validated
against the site's workflow. Ranking changes provider rank, never priority. Local execution ownership
provides single-host exclusion; a distributed claim requires a separate boundary.

### GitHub

```ts
type PullRequest = { repository: string; number: number };
type CheckObservation = {
  name: string;
  producer: string;
  revision: string;
  state: 'pending' | 'passed' | 'failed' | 'cancelled' | 'skipped';
  evidence: ArtifactRef;
};
type PullRequestState = {
  identity: PullRequest;
  url: string;
  head: string;
  base: string;
  state: 'open' | 'closed' | 'merged';
  mergeRevision: string | null;
  checks: readonly CheckObservation[];
  conversation: readonly SourceComment[];
};

interface GitHub {
  find(branch: string, stop: AbortSignal): Promise<Result<PullRequestState | null>>;
  read(target: PullRequest, stop: AbortSignal): Promise<Result<PullRequestState>>;
  ensurePullRequest(
    input: { branch: string; baseBranch: string; expectedHead: string; title: string; body: string },
    operation: Operation,
    stop: AbortSignal,
  ): Promise<Mutation<PullRequestState>>;
  publishReview(
    target: PullRequest,
    input: { head: string; body: string; verdict: 'approve' | 'request-changes' | 'comment' },
    operation: Operation,
    stop: AbortSignal,
  ): Promise<Mutation<{ reviewId: string; head: string }>>;
  publishCheck(
    input: { head: string; name: string; outcome: 'passed' | 'failed'; report: string },
    operation: Operation,
    stop: AbortSignal,
  ): Promise<Mutation<CheckObservation>>;
  requestAutoMerge(target: PullRequest, expectedHead: string, operation: Operation, stop: AbortSignal):
    Promise<Mutation<{ enabledFor: string }>>;
  workflows(revision: string, stop: AbortSignal): Promise<Result<readonly CheckObservation[]>>;
}
```

Bind repository and authorized credential identity at construction. Preserve check producer and
revision identity so callers can distinguish a trusted gate from a similarly named check. Return
all relevant observations, including skipped/cancelled checks and complete conversation. Pagination
failure is a read fault. An ambiguous branch-to-PR lookup is a conflict, not the first match.

Publish review and checks for an explicit head. Request auto-merge conditionally for that head using
provider support; confirmation means it was enabled, not that a merge happened. The configured
branch rules remain authoritative at merge time. `read` observes actual merge and its revision;
`workflows` observes executions for the specified revision. No direct merge or gate-bypass method
is exposed. A provider race or partial write retains uncertainty for the caller to resolve.

### Git

```ts
type RepositoryState = {
  path: string;
  remote: string;
  branch: string | null;
  head: string;
  dirty: boolean;
  changes: ArtifactRef;
};
interface Git {
  inspect(path: string, stop: AbortSignal): Promise<Result<RepositoryState>>;
  prepare(
    input: { remote: string; path: string; branch: string; baseRevision: string },
    operation: Operation,
    stop: AbortSignal,
  ): Promise<Mutation<RepositoryState>>;
  diff(path: string, base: string, head: string, stop: AbortSignal): Promise<Result<ArtifactRef>>;
  remoteRevision(path: string, branch: string, stop: AbortSignal): Promise<Result<string | null>>;
  fastForward(path: string, expectedHead: string, target: string, operation: Operation, stop: AbortSignal):
    Promise<Mutation<RepositoryState>>;
  push(path: string, branch: string, expectedLocalHead: string, operation: Operation, stop: AbortSignal):
    Promise<Mutation<{ remoteHead: string }>>;
}
```

`prepare` creates a new checkout or observes a matching retained checkout. It never silently rewinds
an existing branch to the supplied base. Mismatched identity or incompatible existing contents is
a conflict. `changes` records tracked and untracked status without omitting preserved work.
`fastForward` requires the observed local head, ancestry and no overwritten local work. `push` uses
a normal non-forced update and confirms the remote head. No automatic stash, reset, clean, commit,
force-push or rebase is part of these operations. Agent-authored commits remain explicit local work.

### Processes

```ts
type ProcessRequest = {
  invocationId: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  stdin: ArtifactRef | null;
  deadline: string;
  shutdownGraceMs: number;
};
type ProcessEvent = { stream: 'stdout' | 'stderr'; text: string };
type ProcessResult = {
  termination: 'exited' | 'cancelled' | 'timed-out' | 'launch-failed' | 'lost';
  exitCode: number | null;
  fault: Fault | null;
  shutdown: Shutdown;
  stdout: ArtifactRef | null;
  stderr: ArtifactRef | null;
};
interface Processes {
  run(request: ProcessRequest, observe: Observer<ProcessEvent>, stop: AbortSignal):
    Promise<ProcessResult>;
}
```

Arguments are an array, never an implicitly concatenated shell command. An explicitly configured
shell is an executable choice. Pass only the supplied environment plus documented host necessities;
never inherit unrelated credentials. Environment values are not included in exported reports.
Output is streamed and retained without unbounded in-memory accumulation. Exit zero is an observed
process outcome; the caller decides what that proves.

Own the process and its descendants through the host's process-group or job facilities. A shutdown
deadline bounds graceful stop followed by forced termination of owned processes. A child exit with
live descendants is not confirmed shutdown. PID alone does not establish ownership; retain creation
identity and group/job evidence. Hosts unable to contain the configured process report that limitation
before launch. Intentional cancellation and timeout remain different termination reasons.

### Coding runtime

```ts
type RuntimeRequest = {
  invocationId: string;
  model: string;
  effort: string | null;
  cwd: string;
  prompt: ArtifactRef;
  outputSchema: ArtifactRef;
  toolPolicy: ArtifactRef;
  deadline: string;
};
type RuntimeEvent = { kind: 'activity' | 'diagnostic'; text: string };
type RuntimeResult = {
  output: ArtifactRef | null;
  transcript: ArtifactRef | null;
  fault: Fault | null;
  shutdown: Shutdown;
};
interface CodingRuntime {
  execute(request: RuntimeRequest, observe: Observer<RuntimeEvent>, stop: AbortSignal):
    Promise<RuntimeResult>;
}
```

Configuration binds one coding provider and its executable/endpoint. Validate model, effort and tool
policy support before launch. Preserve complete prompts, structured final output and available
activity; translate provider protocol events without inventing a role verdict. The output file holds
the provider's final JSON candidate; role-schema validation belongs to the caller. Extra provider
turns, silent profile substitution and autonomous retry are not adapter behavior.

The local implementation requires the Processes contract above for owned launch and cancellation.
Tool policy is a validated, versioned declaration of allowed tools and resource roots, interpreted
by this provider binding. It contains credential references, never values. Failure to enforce the
requested policy is a configuration fault. Cancellation of a remote provider must explicitly establish
whether owned tool work stopped; losing a connection does not establish shutdown.

### Notifications

```ts
type NotificationRequest = { subject: string; body: string };
interface Notifications {
  publish(request: NotificationRequest, operation: Operation, stop: AbortSignal):
    Promise<Mutation<{ acceptedMessageId: string }>>;
}
```

The destination and credentials are configuration, not agent-supplied recipient fields. Confirmation
records provider acceptance; it does not claim inbox delivery. Provider size limits produce a validation
fault before dispatch, not silent report truncation. The initial provider is SNS; additional providers
can implement this same small contract when needed.

### Required capabilities

Construction supplies HTTP transport, credential resolution, clock and local filesystem/process
facilities to the adapters that need them. Git uses Processes for explicit Git commands. Coding runtime
uses Processes for a local executable. Other ports do not depend on one another. No business-component
dependency or access to a caller's private records is required.

## Internal design

Each module has an input validator, protocol translator and response normalizer. Keep provider wire
types inside that module. Configured field mappings and credentials belong to the connection, not
global mutable state. Reuse the process or transport boundary without introducing a generic workflow
framework across adapters.

Retain only operation evidence, provider receipts and owned process/output resources. A receipt
does not become a task ledger or a queue decision. Bounded retry of safe reads may respect provider
backoff within the original deadline. Retry a mutation only with an actual provider idempotency
guarantee for the same operation; otherwise return uncertainty. Cancellation during dispatch follows
the same rule.

Validate all returned identities, page completeness and revision associations before returning them.
Scrub credential values from diagnostics and exported evidence. Preserve useful provider error codes
and request IDs. Cleanup is scoped to resources this operation owns; never kill a process or remove
a directory merely because its name resembles a previous invocation.
