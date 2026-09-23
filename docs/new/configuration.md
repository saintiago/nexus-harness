# Configuration

Project configuration defines the target project. Nexus configuration defines harness operation.
Each setting has one owner.

## Project configuration

The project configuration is a JSON file in the target project's root directory. Its filepath is
explicit; its filename is unrestricted. Relative paths are relative to that file's directory.

| Settings | Definition |
| --- | --- |
| Repository | Source location and base branch |
| Preparation | Commands required to prepare the repository for work |
| CI/checks | Named commands and criteria used to verify repository changes |
| Task source | Project identity, source selection and source field/workflow mappings |
| Delivery and completion | Target repository/branch, required checks and post-merge requirements |
| Credential references | Names of the credentials required by project integrations |

Project configuration contains no harness workflow definitions, workspace layout overrides, agent
profiles or recovery/escalation policies. Task-source workflow mappings refer to external issue
statuses and transitions; they do not define the harness's executable workflow.

## Nexus configuration

The Nexus configuration is a JSON file at the installation's configured path. That path is independent
of the target project's directory. Relative paths are relative to the Nexus configuration directory.

| Settings | Definition |
| --- | --- |
| Workflows | Workflow definition paths and the definition selected for each execution mode |
| Workspace | Storage root |
| Agent runtime | Base instructions, profile catalogue, provider connections and tool configuration |
| Execution policy | Invocation limits, repair/escalation policies and maximum recovery attempts per supervised execution |
| Notifications | Destination and provider configuration |
| Credentials | Host credential-resolution settings |

The workspace storage root is configurable. The [workspace layout](workspace.md#layout-and-reference)
is fixed and has no configuration overrides.

Profiles conform to [AgentProfile](agent-runtime.md#provided-interface). Profile IDs are unique.
The initial recovery profile is nexus-recovery, with model gpt-6-astra and high reasoning effort.
Workflow and escalation profile references identify entries in the same Nexus configuration.

## Value constraints

Command definitions contain an executable and an argument array. A shell command requires an explicit
shell executable. Credential references contain identifiers, not secret values.

Required paths and identifiers are nonempty. Duration values state their unit and are nonnegative.
Recovery allowances are positive integers. Workflow definitions, profile references and configured
provider settings must be valid for the selected mode.

Project and Nexus configuration have disjoint ownership. They are not merged through generic override
precedence. A setting supplied under the wrong owner is invalid.

An execution's resolved settings are immutable values. Reloading creates a new settings value; it
does not mutate an existing one. Configuration data contains no action instances, runtime process
handles, artifact contents or saved workflow state.
