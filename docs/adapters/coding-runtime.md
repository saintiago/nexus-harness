# Coding runtime adapter

## Responsibility

Invoke the configured coding provider and translate its protocol into output and activity.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies the provider connection or executable and its credentials.
Inputs are the prompt, model, effort, tool settings, working directory and invocation time limit.

Return the provider's final output and stream its available activity.
[AgentRuntime](../agent-runtime/architecture.md#required-interface) resolves the supplied profile, assembles prompts, interprets
invocation completion and returns output to its caller.

### Required capability

execute(request, onActivity) performs one invocation with the supplied settings, emits provider
activity and returns final output. Its output remains data, including structured text when requested
in the prompt. The consumer interprets the report schema.

Support the configured developer, reviewer and recovery profiles through the same capability.
Apply their supplied tool permissions; do not derive permissions from the role name or prompt text.

## Tool setup

Use the provider's native configuration for built-in tools, MCP servers, connectors and permissions.
Supplied tool settings identify the native configuration to select for the invocation. Operator setup
installs that configuration; launch selects it without changing personal defaults.

For the Codex provider, select an installed native profile with --profile. That profile configures
the research MCP servers, enabled tools and connector exclusions. Pass model and effort using the
provider's supported invocation settings. Deliver the complete prompt on the provider's standard
input by asking it to read instructions there (`codex exec` does so for a `-` prompt argument), so
prompt size does not depend on the operating system's per-argument limit.

The provider connects to MCP servers, exposes their tools to the model and executes tool calls.
The adapter launches and observes the invocation; it adds no tool registry, MCP client or tool-call
dispatcher. A missing selected configuration is a launch error, not a fallback to personal settings.

## Behavior

Apply the supplied settings. Unsupported settings and provider failures are errors.
Run in the supplied working directory; the Codex provider's non-interactive mode refuses one
outside a Git repository, so the caller prepares a directory it accepts. Preserve complete prompts,
output and activity without silently truncating them.

Use temporary transport files only when required by the provider. Do not persist Nexus artifacts,
select another model or add repair turns.

## Planned concurrent invocation use

Purpose, research and council roles may invoke the same provider capability concurrently. Each
execute call has its own activity callback and result. The adapter preserves the activity within
that invocation; the caller supplies the identity used for logs and live presentation. Research
profiles may use configured internet search tools. Provider output never selects council routing.
