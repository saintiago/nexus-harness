# Adapters

## Responsibility

Perform explicitly requested external operations. Own authentication, protocol translation and
provider-specific errors. Return observed results.

Each adapter is an independent module under src/adapters/. There is no shared adapter service.

## Interface

Use the [shared result and event types](high-level-architecture.md#shared-interface-vocabulary).
Construction supplies the connection, credentials or host capability needed by that adapter.

Actions decide what to do. Adapters perform the requested external operation. Consumers decide what
to preserve as artifacts.

Define each concrete adapter's typed operations from its consumers' requirements. An operation specifies
its inputs, returned data and errors. Do not build an API catalogue in advance of those requirements.

Provider-specific data stays provider-specific. Keep the information consumers need, including document
structure, identities and revisions. Introduce a common representation only when a consumer needs one.

### Jira

Perform requested issue reads, field changes, transitions, comments and ranking operations.
Task reads and conversation retrieval are separate requests. Preserve full requested comment bodies,
attribution and ordering.

Field and workflow mappings translate the requested operation to the configured Jira project.
Eligibility, claiming decisions and desired task status belong to actions. Do not implement a task
lifecycle inside the adapter.

### GitHub

Perform explicit pull-request, review, check and workflow operations. Read pull-request metadata,
conversations and checks independently when requested.

Preserve revision and check-producer identity. Report actual merge state; acceptance of an auto-merge
request is not a completed merge. Apply supported provider preconditions when requested.

Deliver decides whether to find, create or update a pull request. The adapter does not make that
decision through an ensurePullRequest operation.

### Git

Perform requested repository reads and Git operations. Return repository state, command results or
diff data as required by the caller.

PrepareWorkspace decides whether to create or reuse a checkout and how to handle existing work.
The adapter does not bundle those decisions into a prepare operation. Perform the requested operation
without adding resets, cleanup or history rewriting.

### Processes

Run the supplied executable and argument array in the supplied directory and environment.
Stream stdout and stderr to the consumer and return the exit code. Persisting those streams is the
consumer's responsibility.

Nonzero exit is a command result. Launch failures and timeouts are execution errors. Apply a supplied
time limit and end owned processes on timeout. Process handling does not determine whether a task
passed its checks.

### Coding runtime

Invoke the configured provider with the supplied prompt, model, effort and tool settings.
Return its output and stream its activity. Unsupported settings and provider failures are errors.

[AgentRuntime](agent-runtime.md#required-interface) selects profiles, assembles prompts, interprets
invocation completion and preserves transcripts. The adapter translates the provider protocol;
it does not select another model, add repair turns or persist Nexus artifacts.

### Notifications

Send the supplied subject and body to the configured destination. Return the provider's publication
result. The initial provider is SNS.

Provider acceptance is not confirmation of inbox delivery. Report provider limits and failures
without silently truncating content.

## Implementation rules

- Use existing provider libraries and process facilities where they meet the required contract.
- Keep authentication and protocol details within the adapter; exclude secrets from returned diagnostics.
- A collection read must return the complete requested collection or an error. Do not fetch unrelated
  collections merely because they are available.
- A failed request does not prove that a remote write had no effect. The caller decides whether to
  retry or inspect the external state.
- Return data or streams. Temporary files required by a provider's transport belong to that adapter;
  Nexus artifact storage belongs to the consumer.
- Release resources owned by the operation when it finishes.
