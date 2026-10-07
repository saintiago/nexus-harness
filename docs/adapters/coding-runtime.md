# Coding runtime adapter

## Responsibility

Invoke the configured coding provider and translate its protocol into output and activity.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies the provider connection or executable and its credentials.
Inputs are the prompt, model, effort, tool settings, working directory, invocation time limit and an
optional outputSchema containing a JSON Schema object.

Return the provider's final output and stream its available activity.
[AgentRuntime](../agent-runtime/architecture.md#required-interface) resolves the supplied profile, assembles prompts, interprets
invocation completion and returns output to its caller.

### Required capability

execute(request, onActivity) performs one invocation with the supplied settings, emits provider
activity and returns final output. When outputSchema is supplied, use the provider's native structured
output capability for the final response. Unsupported schemas or structured-output capability are
errors; do not silently fall back to prompt-only formatting. The consumer validates and interprets
the returned report. Activity remains separate from the final response.

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

Tool settings may also carry native configuration overrides: each names one dotted configuration
path and the value the caller resolved, and the adapter passes it through the provider's own config
setting. The provider, not the adapter, owns the meaning and validation of those settings.

Native tool settings may additionally name `isolatedMcpServers`, an array of server names whose
composed dotted overrides must be isolated from native-file inheritance. Before execution, list
the provider's effective MCP configuration with the same profile, overrides for unrelated settings
and working directory. This inspection starts no MCP server and emits no agent activity; catalogue
values, which may contain literal environment settings, remain in memory. Disable an inherited
entry under each named server in place, preserving its valid transport. Bind enabled composed
overrides to a fresh `nexus-<name>-<id>` server name, checked against the effective catalogue;
disabled composition creates no new server. Configuration files, authentication and unrelated
native settings stay unchanged. Inspection and execution share the invocation time limit.
Invalid isolation settings, failed inspection and invalid catalogue output are launch errors;
do not expose catalogue contents or its diagnostics in the returned fault.

For a supplied outputSchema, write it to an invocation-local temporary file and pass that file through
`codex exec --output-schema`. Keep the file available for the invocation and clean it up on success or
failure. Concurrent invocations must not share this file. Return the complete final response without
extracting fenced snippets, adding missing delimiters or inventing values.

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

## Concurrent invocation use

Researcher and Project guide may invoke the same provider capability concurrently. Each
execute call has its own activity callback and result. The adapter preserves the activity within
that invocation; the caller supplies the identity used for logs and live presentation. Research
profiles may use configured internet search tools. The adapter does not interpret workflow outcomes
or choose routes.
