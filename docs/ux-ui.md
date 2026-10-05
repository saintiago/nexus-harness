# Nexus UX and UI

Nexus's only product UI is the reporting terminal. It displays execution progress, agent activity,
outcomes and diagnostics. Its design belongs to [OperatorInterface](operator-interface.md).
Jira, GitHub and other connected services have their own interfaces; they are integrations, not
additional Nexus UI.

## Preparation applicability

If a task is not explicitly about changing the reporting terminal, propose and evaluate a skip
for prototyping. Internal workflow, architecture, configuration or integration changes do not by
themselves require a UI prototype. New task statuses or handoffs do not imply a terminal redesign.

UX work follows the same scope: retain the existing reporting design unless the task explicitly
changes it. Do not invent terminal interactions or mock external-service navigation to make UX
or prototyping applicable.

For an explicit reporting-terminal change, assess the affected feedback, readability and terminal
behavior. Any prototype serves those specific design questions; verify actual terminal behavior
in a terminal.

Implementing or testing Nexus's prototype/browser-verification capability is separate from
prototyping Nexus itself. That capability can require an isolated browser test fixture without
making the preparation prototype stage applicable to an internal Nexus change.
