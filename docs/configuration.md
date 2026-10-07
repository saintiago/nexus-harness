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
profiles or recovery/escalation policies. Source mappings name eligible Jira stages/queries for the
parent; preparation mappings are optional for delivery-only projects. When configured, map
Requirements, UX Proposal, Storybook Refinement and Architecture in addition to idea, feedback and
implementation states. Task-source workflow mappings refer to external issue
statuses and transitions; they do not define the harness's executable workflow.

The project uses its Jira task-source connection for both finite delivery and idea refinement.
Their eligibility queries and stage mappings are distinct inputs to the parent selector, so
ideas cannot enter finite delivery directly.
The Jira connection is the API base used verbatim, so a cloud connection's gateway prefix
such as `https://api.atlassian.com/ex/jira/<cloudId>` is preserved; the credential reference names the operator's API token.

## Nexus configuration

The Nexus configuration is a JSON file at the installation's configured path. That path is independent
of the target project's directory. Relative paths are relative to the Nexus configuration directory.

| Settings | Definition |
| --- | --- |
| Workflow | Parent project definition and invoked child definition paths |
| Storage | Root for queue execution state, recovery and shared issue workspaces |
| Agent runtime | Base instructions, profile catalogue, provider connections and tool configuration |
| Execution policy | Invocation limits, developer ladder and repair allowances, reviewer selection and maximum recovery attempts per supervised execution |
| Idea refinement | Four role profile references and the maximum conversation cycles per selection |
| Memory | Optional enablement, service URL, MCP access and experience-analysis profile |
| JEv | Optional judgment integration, native MCP access and host credential reference |
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
The project parent invokes idea refinement for selected idea-stage work. Parent source operations
own publication; the child receives captured input and returns its decision.

## Memory settings

Nexus owns optional `memory` settings; omission or `enabled: false` makes AnalyzeExperience skip
without analysis or provider effects. A disabled integration may retain valid but unused service,
MCP and profile settings. When enabled, require the shared service URL, AMEM MCP entry point and
configured experience-analysis profile. The action's analyst receives search only; save is disabled because the action validates and
submits its output. Other enabled agent profiles retain explicit AMEM search/save tools.

AMEM owns collection, encoder, model and durable ingestion settings. Nexus does not configure direct
Qdrant access, encoder caches, memory-generation credentials or writer locks. Invalid settings fail
configuration; service unavailability degrades only learning. Disabled configurations remain valid.

## JEv settings

JEv integration is optional and Nexus-owned. An installation without JEv configuration remains
valid. Omitted or disabled integration supplies no JEv tools or applicability requests and retains
the existing full preparation path. Enabled integration supports both native agent access and the
preparation API use described in [project workflow](project-workflow.md#jev-assisted-applicability).
The optional `jev` section has `enabled: boolean` and `credential: string`, a reference into
`credentials`. `credential` is required when enabled and optional when disabled. If present it
must identify an existing credential entry whose environment name is `JEV_API_KEY`. Unknown
fields or references are configuration errors; an absent host value is capability unavailability,
not invalid configuration. Disabled integration may retain a valid unused credential reference.
There are no Nexus settings for endpoint, model, confidence threshold, retry or MCP command.

```json
{
  "jev": { "enabled": true, "credential": "jev" },
  "credentials": { "jev": { "environment": "JEV_API_KEY" } }
}
```

This fragment extends the installation's existing settings. Set `enabled: false` or omit `jev`
to disable the integration. Dependency consumption follows [tech stack](tech-stack.md#jev-dependency);
Linux native launch follows [profiles](agent-runtime/profiles.md#jev-access).

Resolve `JEV_API_KEY` from the execution host for API use and native MCP launch; configuration
contains only its reference, never its value. The package owns provider endpoint, schemas and
transport. Missing credentials or an unavailable JEv capability cannot prevent ordinary Nexus work:
use the documented [applicability fallback](project-workflow.md#jev-assisted-applicability) and
[agent continuation](agent-runtime/architecture.md#optional-jev-judgments). Preserve existing
configuration validation and resolved-setting immutability. Resolve the key only in in-memory
construction of the API client and in the provider process environment. Native MCP forwards its
host environment name, never a literal `env` value in tool settings. Keep the host key available
in workers, recovery and experience-analysis providers while preserving their existing credential
exclusions. With no key, omit the JEv server and usage guidance and supply preparation's
`missing-credential` fallback capability; do not fail general component construction.

Use package defaults (`jev-1.13.0`, 10000 ms) for automatic applicability requests. Native launch
also uses these defaults by forwarding only `JEV_API_KEY`, without inheriting `JEV_MODEL` or
`JEV_TIMEOUT_MS`. This gives API and MCP one supported configuration. Provider-native JEv startup
is optional; an unavailable server must not abort an otherwise usable agent invocation. Disabled
composition explicitly disables the reserved `jev` MCP server even when base/profile settings
would otherwise enable it; enabled composition owns that server's settings, replacing any that a
profile's own native configuration supplies under the reserved name. Other native settings retain
their current ownership.

Acceptance examples: an existing configuration with no JEv settings loads and runs without JEv
effects; disabling a configured integration restores that same behavior. With host credentials and
JEv enabled, API and native MCP access work without placing the secret in saved configuration or
artifacts. With the credential missing, ordinary preparation and agent work remain possible.

## Project workflow settings

The [project workflow](project-workflow.md) owns parent/child routing and role responsibilities.
Nexus configures parent/child definition paths, stage author/evaluator profiles, positive stage-round
and upstream-return allowances, and the existing finite developer ladder. Validate referenced
profiles and workflows. Project settings own eligibility, status mappings and implementation issue
creation/link/label settings. No artifact-path override or workflow graph belongs in project settings.
Reuse existing source workspace/PR fields; preparation needs no additional Jira custom field.

KAN maps ready delivery work to Implementation. HARN maps ready delivery work to To Do. The parent
selects mapped preparation and implementation work in one ranked queue. Waiting for Feedback and
Done are not automatically selected. Persist feedback return destinations in the issue source
handoff record. Role assignments and the Flash/Sol/Astra models follow the workflow's Profiles section.
