# Adapters

## Responsibility

Translate explicit operations into external protocols and return observed results.
Own authentication, provider serialization and protocol errors.

Adapters is a family of independent modules under `src/adapters/`. Each module has its own public
entry point and configured connection or host capability.

## Interface

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary).
Operations return their useful result or a fault. A failed request does not imply that a remote write
was rolled back. Decisions about repeating an operation or reusing an existing artifact belong to
the caller.

```ts
type SourceDocument = { format: 'text' | 'adf'; value: string };
type SourceComment = {
  id: string;
  author: string;
  at: string;
  body: SourceDocument;
};
```

### Jira

```ts
type JiraIdentity = { site: string; issueId: string };
type JiraTask = {
  identity: JiraIdentity;
  key: string;
  title: string;
  description: SourceDocument;
  status: string;
  labels: readonly string[];
  fields: { workspaceRef: string | null; pullRequestUrl: string | null };
  comments: readonly SourceComment[];
};

interface Jira {
  list(): Promise<Result<readonly JiraIdentity[]>>;
  read(target: JiraIdentity | { key: string }): Promise<Result<JiraTask>>;
  update(
    target: JiraIdentity,
    change: {
      title?: string;
      description?: SourceDocument;
      transitionId?: string;
      workspaceRef?: string | null;
      pullRequestUrl?: string | null;
    },
  ): Promise<Result<JiraTask>>;
  comment(target: JiraIdentity, body: SourceDocument): Promise<Result<SourceComment>>;
  create(input: { title: string; description: SourceDocument; issueType: string }):
    Promise<Result<JiraTask>>;
  rank(target: JiraIdentity, position: { before: JiraIdentity } | { after: JiraIdentity }):
    Promise<Result<void>>;
}
```

Construction binds site, project, selection query with explicit ordering, workflow mappings and
field mappings. list reads all pages in provider order. read includes all comments with complete
bodies, attribution and source order. ADF remains serialized JSON. Pagination failure returns a fault,
not a partial queue or conversation.

update applies the supplied fields/transition and returns the observed task. It does not implement
a claim lease or a read-before-write locking protocol. Eligibility and desired lifecycle changes
belong to the caller. rank changes provider rank, not priority.

### GitHub

```ts
type PullRequest = { repository: string; number: number };
type CheckObservation = {
  name: string;
  producer: string;
  revision: string;
  state: 'pending' | 'passed' | 'failed' | 'cancelled' | 'skipped';
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
  find(branch: string): Promise<Result<PullRequestState | null>>;
  read(target: PullRequest): Promise<Result<PullRequestState>>;
  ensurePullRequest(input: {
    branch: string;
    baseBranch: string;
    expectedHead: string;
    title: string;
    body: string;
  }): Promise<Result<PullRequestState>>;
  publishReview(
    target: PullRequest,
    input: { head: string; body: string; verdict: 'approve' | 'request-changes' | 'comment' },
  ): Promise<Result<{ reviewId: string; head: string }>>;
  publishCheck(input: { head: string; name: string; outcome: 'passed' | 'failed'; report: string }):
    Promise<Result<CheckObservation>>;
  requestAutoMerge(target: PullRequest, expectedHead: string): Promise<Result<void>>;
  workflows(revision: string): Promise<Result<readonly CheckObservation[]>>;
}
```

Construction binds the repository and authorized credentials. Preserve check producer and revision
so a caller can identify the required gate. Return complete conversations and relevant check results.
An ambiguous branch lookup returns a fault.

ensurePullRequest updates a matching open pull request or creates one for the supplied branch and head.
Publish reviews and checks for the explicit revision. Request auto-merge for the expected head using
the provider's supported precondition. Acceptance of that request does not mean a merge occurred.

read reports the actual merge revision. workflows reports checks for the supplied revision.
Branch protection remains authoritative; these operations do not bypass gates.

### Git

```ts
type RepositoryState = {
  path: string;
  remote: string;
  branch: string | null;
  head: string;
  dirty: boolean;
  changes: string;
};

interface Git {
  inspect(path: string): Promise<Result<RepositoryState>>;
  prepare(input: { remote: string; path: string; branch: string; baseRevision: string }):
    Promise<Result<RepositoryState>>;
  diff(path: string, base: string, head: string): Promise<Result<string>>;
  remoteRevision(path: string, branch: string): Promise<Result<string | null>>;
  fastForward(path: string, expectedHead: string, target: string): Promise<Result<RepositoryState>>;
  push(path: string, branch: string, expectedLocalHead: string): Promise<Result<{ remoteHead: string }>>;
}
```

prepare creates a checkout or returns a matching retained checkout. Existing work is preserved;
incompatible contents return a fault. changes includes tracked and untracked status.

fastForward requires the expected local head and a fast-forward that preserves local work. push uses
a normal non-forced update and reports the remote head. These operations do not automatically stash,
reset, clean or rewrite commits.

### Processes

```ts
type ProcessRequest = {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  stdin: string | null;
  timeoutMs: number | null;
};
type ProcessEvent = { stream: 'stdout' | 'stderr'; text: string };
type ProcessResult = Result<{
  exitCode: number;
  stdout: ArtifactRef;
  stderr: ArtifactRef;
}>;

interface Processes {
  run(request: ProcessRequest, observe: Observer<ProcessEvent>): Promise<ProcessResult>;
}
```

Pass executable and arguments separately. A shell command requires an explicit shell executable.
Use the supplied environment plus necessary host settings; do not inherit unrelated credentials.

Stream and retain output. Return the exit code after the command exits; nonzero is a command result,
not a launch failure. Launch errors and timeouts return faults. On timeout, end the command's owned
processes before returning. The caller decides what a command result means for its work.

### Coding runtime

```ts
type RuntimeRequest = {
  model: string;
  effort: string | null;
  cwd: string;
  prompt: string;
  toolSettings: Readonly<Record<string, unknown>>;
  timeoutMs: number | null;
};
type RuntimeEvent = { type: string; text: string };
type RuntimeResult = Result<{
  output: string;
  transcript: ArtifactRef | null;
}>;

interface CodingRuntime {
  execute(request: RuntimeRequest, observe: Observer<RuntimeEvent>): Promise<RuntimeResult>;
}
```

Construction binds a provider and executable or endpoint. Apply the supplied model, effort and tool
settings. Unsupported settings return a fault. Preserve the full prompt, output and available activity.

Prompt and settings are passed as values; serialize to files only when required by the provider.
Return final output without interpreting its business meaning. Profile substitution and extra repair
turns are not adapter behavior.

### Notifications

```ts
type NotificationRequest = { subject: string; body: string };

interface Notifications {
  publish(request: NotificationRequest): Promise<Result<{ acceptedMessageId: string }>>;
}
```

Destination and credentials are configured. The initial provider is SNS.
Success means provider acceptance, not inbox delivery. Reject oversized messages rather than silently
truncating the report.

### Required capabilities

Construction supplies HTTP transport, credential resolution and filesystem/process facilities where
needed. Git and a local coding provider use Processes for command execution. No business-component
internals are required.

## Internal design

Keep provider wire types, authentication and response translation within each module.
Return useful provider errors without exposing credential values. Preserve identifiers, revision
associations and complete paginated results.

Each operation owns its local resources and releases them on completion. Adapters do not maintain a
task ledger, decide recovery policy or add a shared transaction protocol.
