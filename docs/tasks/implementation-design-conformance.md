# Reconcile implementation with design

Remove the blanket rejection of untracked files from Develop and the restriction preventing a profile from being shared across roles. Keep role-specific instructions correct when a profile is reused. Keep completion requiring all matching check runs to succeed. Align test scopes and execution order with [Testing](../testing.md). Follow [Develop](../task-engine/actions/develop.md), [CompleteTask](../task-engine/actions/complete-task.md) and [Configuration](../configuration.md). Report other unsupported behavior instead of inventing requirements.

Remove custom XState snapshot inspection and the corruption-specific tests that require it. Keep ordinary JSON loading and XState restoration/error handling; do not replace the inspection with another validator.
