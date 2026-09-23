# Coding runtime adapter

## Responsibility

Invoke the configured coding provider and translate its protocol into output and activity.

## Interface

Follow the [adapter contract](architecture.md#interface).
Construction supplies the provider connection or executable and its credentials.
Inputs are the prompt, model, effort, tool settings, working directory and invocation time limit.

Return the provider's final output and stream its available activity.
[AgentRuntime](../agent-runtime.md#required-interface) selects profiles, assembles prompts, interprets
invocation completion and preserves transcripts.

### Required capability

execute(request, onActivity) performs one invocation with the supplied settings, emits provider
activity and returns final output. Its output remains data, including structured text when requested
in the prompt. The consumer interprets the report schema.

Support the configured developer, reviewer and recovery profiles through the same capability.
Apply their supplied tool permissions; do not derive permissions from the role name or prompt text.

## Behavior

Apply the supplied settings. Unsupported settings and provider failures are errors.
Preserve complete prompts, output and activity without silently truncating them.

Use temporary transport files only when required by the provider. Do not persist Nexus artifacts,
select another model or add repair turns.
