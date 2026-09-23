# Configuration

Status: proposed configuration and startup design.

Project configuration describes the target project. Nexus configuration describes how Nexus operates.
Both are configuration data; loading, validation and dependency construction belong to application startup.

## Ownership

| Project configuration | Nexus configuration |
| --- | --- |
| Repository source and base branch | Executable workflow definitions and mode-to-workflow selection |
| Preparation and CI/check commands | Workspace layout and storage root |
| Project task-source settings | Agent profiles, runtime instructions, tools and provider connections |
| Project delivery and completion requirements | Recovery/escalation policies and execution limits |
| References to required project credentials | Host credential resolution and notification configuration |

Project configuration does not select workflow files, redefine workspace layout or override Nexus
profiles and policies. There is no generic merge of the two objects: startup takes each setting from
its owner and supplies it to the appropriate consumer. Credential values are resolved on the host
and are never copied into task context or persisted configuration reports.

## File locations

The project configuration file lives in the target project's root. The operator supplies its filepath
when starting Supervisor. The filename is not an identity or discovery rule; the explicit path is
authoritative. Resolve it to an absolute path before starting a child process.

Nexus reads its own configuration from the installation's configured location. The same location
is available to Supervisor and to the Nexus worker. It is not discovered from the target project's
working directory, and a task's working copy cannot substitute another Nexus configuration.

Relative project paths are resolved against the project configuration directory. Relative Nexus paths,
including workflow and instruction files, are resolved against the Nexus configuration directory.
Repository commands execute in the prepared worktree, not in the original source checkout.

## Startup and restart

```text
Supervisor(projectConfigPath)
    → starts Nexus worker(projectConfigPath)
        → reads project configuration
        → reads Nexus configuration
        → validates the settings and selected workflow
        → constructs actions and components with their relevant settings
        → runs TaskEngine
```

The Nexus worker is the child application entry point, not an additional business component. It
constructs the components; TaskEngine and its runner do not locate or load configuration files.

Supervisor reads its own lifecycle, recovery and notification settings from Nexus configuration
before launching the worker. It retains projectConfigPath and forwards that same absolute path on
restart. Recovery can therefore run when worker configuration or construction fails. Invalid
supervisor configuration is reported directly because recovery itself cannot be configured reliably.

Each worker startup loads configuration; constructed dependencies retain their settings for that
invocation. A restart can pick up an intentional configuration correction. The persisted workflow
definition continues to govern an existing checkpoint; changing that definition requires an explicit
decision rather than silently assigning new meaning to the saved state.

## Dependency construction

| Consumer | Supplied settings |
| --- | --- |
| ExecutionRunner | Selected workflow, bound actions and checkpoint location |
| PrepareWorkspace | Project repository settings, Nexus workspace layout and concrete workspace reference |
| Verify | Project CI/check commands and current workspace reference |
| AgentRuntime | Nexus profiles, base instructions, runtime/tool settings and workspace layout |
| Agent-backed actions | Selected profile, AgentRuntime capability and current workspace reference |
| Source/delivery actions | Relevant project integration settings and configured adapter capabilities |
| Supervisor | Nexus lifecycle/recovery settings and the project configuration filepath |

Components and actions receive the settings they actually use, not both entire configuration objects.
Actions prepare additional agent context from their task and artifacts. AgentRuntime combines that
context with its configured instructions when run(profile, workspaceRef, additionalContext) is called.

Validate required values, paths, profile references and command definitions before starting task actions.
The configuration loader and construction code are ordinary startup code, not a configuration service
or another orchestration layer.
