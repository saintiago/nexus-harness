# Implement complete prompt transport

Pass complete agent prompts through standard input instead of a process argument, so large review diffs and conversations can be delivered without hitting the Linux per-argument size limit. Follow the [coding runtime](../adapters/coding-runtime.md) and [Processes](../adapters/processes.md) contracts.
