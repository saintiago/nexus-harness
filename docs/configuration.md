# Configuration

Project configuration defines the target project. Nexus configuration defines harness operation.
Each setting has one owner.

## Project configuration

The project configuration is a JSON file in the target project's root directory. Its filepath is
explicit; its filename is unrestricted. Relative paths are relative to that file's directory.

| Settings | Definition |
| --- | --- |
| Repository | Source location; new delivery task branches start from updated main; idea refinement uses a Git worktree from the same source |
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
| Storage | Root for queue execution state, recovery and shared issue workspaces |
| Agent runtime | Base instructions, profile catalogue, provider connections and tool configuration |
| Execution policy | Invocation limits, developer ladder and repair allowances, reviewer selection and maximum recovery attempts per supervised execution |
| Idea refinement | Four role profile references and the maximum conversation cycles per selection |
| Memory | Optional enablement, store identity, Qdrant, embedding and model settings, retrieval and lock limits |
| Notifications | Destination, provider connection and host credential references |
| Credentials | Reference names and the host environment settings that supply their values |
| Nexus Lens | GitHub App identity and installation credential references for review publication |

The storage root is configurable. [Application](application.md#state-and-reports) defines execution
and issue-workspace locations. The [workspace layout](workspace.md#layout-and-reference) is fixed
and has no configuration overrides.

Notifications name the destination topic, the SNS Region that owns it and the host credential
references that supply the access key, secret key and optional session token.

Profiles conform to [AgentProfile](agent-runtime/architecture.md#provided-interface). Profile IDs are unique.
The initial recovery profile is nexus-recovery, with model gpt-6-astra and high reasoning effort.
Workflow, developer ladder and reviewer profile references identify entries in the same Nexus
configuration.

The developer ladder lists profiles in increasing capability order. Its first entry supplies the
initial round; each entry's repairAllowance is the number of executed repair turns allowed with that
profile. [StartDevRound](task-engine/actions/start-dev-round.md#round-planning) owns repair triggers,
counting, promotion at each second consecutive changesRequested review, the no-downgrade rule and
exhaustion. The reviewer profile is configured separately and selected by
[Review](task-engine/actions/review.md#interface), not by StartDevRound.

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
waiting-for-feedback items. The Project guide discovers project purpose documents through
the connected repository and infers direction from code and commits when needed; no configured
purpose references are required. HARN's Jira mappings are `Idea`, `Idea Refinement`, `Draft` and
`Waiting for Feedback`, respectively.
These are project facts, not Nexus role policy. Nexus supplies the idea refinement workflow
definition, profile references for Idea editor, Researcher, Project guide and Challenger, and a
maximum cycle count. The specification defines [how cycles are counted](idea-refinement/spec.md#conversation-and-cycles).
StartIdeaRound records the role profiles for each cycle. Use the existing profile catalogue
and storage root. Artifact paths belong to the workflow, not project configuration.
The operator command selects the workflow explicitly.

## Memory settings

Nexus owns the optional `memory` settings; omission or `enabled: false` disables the integration.
When enabled, require a nonempty `storeId`, Qdrant URL and collection, explicit embedding cache path
and download permission, model endpoint and ID, and any provider credential references. Resolve
secrets through the existing Credentials settings. Use the standalone package's pinned reference
encoder and default prompts; model generation has thinking disabled. Host transport must support
that provider setting explicitly rather than assuming a profile's effort value controls it.

Use `neighbors: 5`, `searchLimit: 5`, `linkedLimit: 5`, `contextMaxChars: 12000`,
`lockWaitMs: 5000`, `providerTimeoutMs: 120000` and `modelMaxOutputTokens: 6000` as defaults.
Counts and context/output bounds are positive integers; linkedLimit and lockWaitMs may be zero.
Timeout is a positive integer in milliseconds. The context bound includes the framing and source
labels, as defined by [Memory](memory/architecture.md#retrieval).

A storeId names the receipt/coordination directory, not a project. Several local project runs may
share it. Every writer of the same Qdrant endpoint/collection must use the same storeId and storage
root; reusing a storeId for a different endpoint/collection is invalid. Persist and check that binding
before writing. Collection aliases or access from other hosts require operator coordination; local
locking is not distributed locking. Provider initialization failure degrades memory availability,
while structurally invalid settings are configuration errors. Existing configurations remain valid.
