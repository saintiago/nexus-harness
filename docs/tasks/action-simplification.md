# Simplify action implementation

Simplify repeated record reading, artifact validation and source-update plumbing in the actions, following the [action design](../task-engine/actions/architecture.md) and [simplicity principles](../../AGENTS.md#simplicity). Preserve behavior and public contracts. Remove comments that merely restate code. Share only genuinely repeated mechanics; keep action decisions within their owning action.
