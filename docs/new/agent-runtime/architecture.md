# AgentRuntime

## Responsibility

Run a configured agent profile in a supplied workspace with additional context prepared by the caller.
Resolve the caller-selected profile, assemble the prompt, invoke the agent and return its output.

## Interface

Use the [shared value types](../high-level-architecture.md#shared-interface-vocabulary) and
[WorkspaceRef](../workspace.md#layout-and-reference). Construction supplies base instructions, profiles,
provider/tool settings, invocation limits and an activity observer from
[Nexus configuration](../configuration.md#nexus-configuration).

Developer and reviewer profiles include their respective
[DevelopmentRole](development-role.md#constant-prompt) or [ReviewerRole](reviewer-role.md#constant-prompt)
instructions once per invocation. Each role has one complete constant prompt.

### Provided interface

```ts
interface AgentRuntime {
  run(
    profile: ProfileId,
    workspaceRef: WorkspaceRef,
    additionalContext: string,
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

type AgentEvent = { type: string; text: string };

type AgentResult = Result<{
  output: string;
}>;
```

The caller selects the profile ID; the runtime looks it up in the configured catalogue. Tool settings
identify the provider's installed native tool configuration. Unknown profiles or unsupported settings
return a fault. Each call starts one
invocation with the supplied context.

additionalContext is caller-prepared text containing the invocation instructions, information and any
file paths the agent needs. Include it in the prompt as supplied; do not read workspace files to
discover or construct the request.

Success means the invocation finished and returned output. The caller defines the required output
format, parses it and evaluates its claims. The runtime has no developer, reviewer or recovery output
schemas. It does not declare a task complete.

Activity is emitted through the observer bound at construction. Observer failures do not affect the
invocation. Invocation failures and timeouts return a fault.

### Required interface

Use the [coding runtime adapter](../adapters/coding-runtime.md#interface) for provider communication. Supply the resolved
model, effort, tool settings, assembled prompt, configured time limit and working directory. The working
directory is worktree/ within the supplied workspace root.

Prompt and settings are values. Receive the provider's output and activity as data/streams.
The adapter may use temporary files when its transport requires them; it does not choose Nexus
artifact locations.

## Instructions and profiles

Prompt assembly combines:

1. Runtime base instructions.
2. Selected profile instructions.
3. Caller-supplied context.
4. Workspace location.

Preserve the supplied context completely. If provider limits prevent this, return an input failure
instead of silently truncating it.

Profiles define model, effort and available tools. Invocation instructions do not change these
settings. Resolve credentials for configured tools and keep their values out of prompts and reports.

Developer and reviewer profiles expose the same tools:

- Shell execution and file reading, creation and editing.
- Tavily web search and page extraction.
- Context7 library documentation.
- OpenAI documentation MCP.

Disable personal connectors and unrelated integrations, including the GitHub connector, for both
profiles. Harness publication remains outside the agent tool set. Use the provider's native settings
to configure these tools; do not impose a read-only filesystem policy on the reviewer. Its commands
must be able to install dependencies, build and run tests, including their file writes.

## Invocation

Resolve the profile, assemble the prompt, invoke the provider, collect output and return the result.
AgentRuntime has no persistent storage. It streams activity and returns output to the caller.

Wait for the invocation to finish before returning success. The runtime adds no repair turns,
automatic profile escalation or reuse of an earlier result.
