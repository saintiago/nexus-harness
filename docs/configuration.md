# Configuration

Project configuration defines the target project. Nexus configuration defines harness operation.
Each setting has one owner.

## Project configuration

The project configuration is a JSON file in the target project's root directory. Its filepath is
explicit; its filename is unrestricted. Relative paths are relative to that file's directory.

| Settings | Definition |
| --- | --- |
| Repository | Source location; new delivery task branches start from updated main; idea refinement agents read a project snapshot |
| Preparation | Commands required to prepare the repository for work |
| CI/checks | Named commands and criteria used to verify repository changes |
| Task source | Jira connection, project identity, separate delivery and idea queries, and field/status mappings |
| Delivery and completion | Target repository/branch, required checks, post-merge requirements and completion polling/wait limits |
| Credential references | Names of the credentials required by project integrations, resolved through the Nexus Credentials settings |

Project configuration contains no harness workflow definitions, workspace layout overrides, agent
profiles or recovery/escalation policies. Task-source workflow mappings refer to external issue
statuses and transitions; they do not define the harness's executable workflow.

The project uses its Jira task-source connection for both finite delivery and idea refinement.
Their selection queries and status mappings are separate so ideas do not enter the To Do queue.
The Jira connection is the API base used verbatim, so a cloud connection's gateway prefix
such as `https://api.atlassian.com/ex/jira/<cloudId>` is preserved; the credential reference names the operator's API token.

## Nexus configuration

The Nexus configuration is a JSON file at the installation's configured path. That path is independent
of the target project's directory. Relative paths are relative to the Nexus configuration directory.

| Settings | Definition |
| --- | --- |
| Workflow | Definition paths for the explicitly selected finite delivery or idea refinement workflow |
| Storage | Root for queue execution state, recovery and task workspaces |
| Agent runtime | Base instructions, profile catalogue, provider connections and tool configuration |
| Execution policy | Invocation limits, developer ladder and repair allowances, reviewer selection and maximum recovery attempts per supervised execution |
| Notifications | Destination, provider connection and host credential references |
| Credentials | Reference names and the host environment settings that supply their values |
| Nexus Lens | GitHub App identity and installation credential references for review publication |

The storage root is configurable. [Application](application.md#state-and-reports) defines execution
and task-workspace locations. The [workspace layout](workspace.md#layout-and-reference) is fixed
and has no configuration overrides.

Notifications name the destination topic, the SNS Region that owns it and the host credential
references that supply the access key, secret key and optional session token.

Profiles conform to [AgentProfile](agent-runtime/architecture.md#provided-interface). Profile IDs are unique.
The initial recovery profile is nexus-recovery, with model gpt-6-astra and high reasoning effort.
Workflow, developer ladder and reviewer profile references identify entries in the same Nexus
configuration.

The developer ladder lists profiles in increasing capability order. Its first entry supplies the
initial round; each entry's repairAllowance is the number of executed repair turns allowed with that
profile. [StartRound](task-engine/actions/start-round.md#round-planning) owns repair triggers,
counting, promotion at each second consecutive changesRequested review, the no-downgrade rule and
exhaustion. The reviewer profile is configured separately and selected by
[Review](task-engine/actions/review.md#interface), not by StartRound.

The target repository's merge rules require the configured Nexus Lens review check from that App,
alongside its required CI checks. Project delivery settings identify that required check.

## Value constraints

Command definitions contain an executable and an argument array. A shell command requires an explicit
shell executable. Credential references contain identifiers, not secret values: each identifies an
entry in the Nexus Credentials settings, which names the host environment setting that supplies its
value.

Required paths and identifiers are nonempty. The developer ladder contains at least one profile.
Duration values state their unit and are nonnegative. Recovery allowances are positive integers.
Workflow definitions, profile references and configured provider settings must be valid for the
selected workflow.

Project and Nexus configuration have disjoint ownership. They are not merged through generic override
precedence. A setting supplied under the wrong owner is invalid.

An execution's resolved settings are immutable values. Reloading creates a new settings value; it
does not mutate an existing one. Configuration data contains no action instances, runtime process
handles, artifact contents or saved workflow state.

A profile may be selected for more than one role. Profile reuse does not combine role instructions;
each invocation receives the instructions of its selected role.

## Idea refinement settings

For the [idea refinement workflow](idea-refinement/spec.md), the connected project supplies
an eligible idea query and source mappings for submitted, active, approved and
waiting-for-feedback items. The Purpose Verifier discovers project purpose documents through
the connected repository and infers direction from code and commits when needed; no configured
purpose references are required. HARN's Jira mappings are `Idea`, `Idea Refinement`, `Draft` and
`Waiting for Feedback`, respectively.
These are project facts, not Nexus role policy. Nexus supplies the idea refinement workflow
definition, six profile references and maximum council cycles. Use the existing profile catalogue
and storage root. Artifact paths belong to the workflow, not project configuration.
The operator command selects the workflow explicitly.
