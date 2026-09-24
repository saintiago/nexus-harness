# Shared issue workspace

Implement the [shared issue workspace](../workspace.md) and its [idea handoff](../idea-refinement/spec.md)
across selection, preparation and recovery. Preserve the existing finite delivery artifact layout.

Acceptance criteria:

- The source workspace pointer names the issue root; idea refinement uses its refinement area
  and prepares a normal Git worktree for its agents.
- Later workflows can read retained artifacts through the handoff references without copying them.
- A fresh finite delivery attempt clears only its root-level worktree, artifacts and state;
  refinement and other workflow areas survive.
- Focused tests cover shared-root selection, artifact access and recovery preservation.
