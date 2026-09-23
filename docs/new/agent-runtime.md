# AgentRuntime

## Responsibility

Run a configured agent profile in a supplied workspace with additional context prepared by the caller.
Own profile selection, prompt assembly, agent invocation and collection of output.

## Interface

Use the [shared value types](high-level-architecture.md#shared-interface-vocabulary) and
[WorkspaceRef](workspace.md#layout-and-reference). Construction supplies base instructions, profiles,
provider/tool settings, invocation limits and an activity observer from
[Nexus configuration](configuration.md#nexus-configuration).

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
  model: string;
  effort: string | null;
  instructions: readonly string[];
  toolSettings: Readonly<Record<string, unknown>>;
};

type AdditionalContext = {
  instructions: string;
  information: string;
  artifacts: readonly ArtifactRef[];
};

type AgentEvent = { type: string; text: string };

type AgentResult = Result<{
  output: string;
  transcript: ArtifactRef | null;
}>;
```

The profile ID selects an entry in the configured catalogue. Tool settings are the selected provider's
configuration values. Unknown profiles or unsupported settings return a fault. Each call starts one
invocation with the supplied context.

AdditionalContext carries invocation instructions, information assembled by the caller and references
to files the agent may inspect. The runtime includes those references in the prompt; it does not read
workspace files to discover or construct the request.

Success means the invocation finished and returned output. The caller defines the required output
format, parses it and evaluates its claims. The runtime has no developer, reviewer or recovery output
schemas. It does not declare a task complete.

Activity is emitted through the observer bound at construction. Observer failures do not affect the
invocation. Invocation failures and timeouts return a fault.

### Required interface

Use the [coding runtime adapter](adapters.md#coding-runtime) for provider communication. Supply the resolved
model, effort, tool settings, assembled prompt, configured time limit and working directory. The working
directory is worktree/ within the supplied workspace root.

Prompt and settings are values. Receive the provider's output and activity as data/streams and preserve
the transcript here. The adapter may use temporary files when its transport requires them; it does not
choose Nexus artifact locations or return saved transcript artifacts.

## Instructions and profiles

Prompt assembly combines:

1. Runtime base instructions.
2. Selected profile instructions.
3. Instructions and information from AdditionalContext.
4. Workspace location and caller-supplied artifact references.

Preserve the supplied context completely. If provider limits prevent this, return an input failure
instead of silently truncating it.

Profiles define model, effort and available tools. Invocation instructions do not change these
settings. Resolve credentials for configured tools and keep their values out of prompts and reports.

## Invocation

Resolve the profile, assemble the prompt, invoke the provider, collect output and return the result.
Keep the assembled prompt and transcript in the artifact directory for inspection, using separate
files for each invocation.

Wait for the invocation to finish before returning success. The runtime adds no repair turns,
automatic profile escalation or reuse of an earlier result.
