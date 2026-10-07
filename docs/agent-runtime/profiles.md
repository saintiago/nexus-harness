# Native Codex profiles

Repository templates:

- [nexus-flash](../../profiles/codex/nexus-flash.config.toml): DeepSeek Flash, maximum effort.
- [nexus-sol](../../profiles/codex/nexus-sol.config.toml): GPT-6.1 Sol, high effort.
- [nexus-astra](../../profiles/codex/nexus-astra.config.toml): Astra, high effort.
- [nexus-recovery](../../profiles/codex/nexus-recovery.config.toml): Astra, high effort, selected for recovery.

All configure OpenAI Docs, Context7 and Tavily. They disable connector apps by default,
explicitly disable the existing GitHub connector, and exclude personal-service plugins.
They also select non-interactive approval and the shell, filesystem and network access the roles'
work needs: dependency installation, builds, tests, commits and recovery operations. No
profile imposes read-only reviewer access, and selecting a profile leaves the operator's
interactive defaults unchanged. Role instructions are supplied separately.

## Install on Linux

From the repository root, copy the templates into the Codex home used by Nexus:

```sh
nexus_codex_home="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$nexus_codex_home"
cp profiles/codex/nexus-*.config.toml "$nexus_codex_home/"
```

Select with `codex --profile nexus-flash`, `codex --profile nexus-sol`,
`codex --profile nexus-astra` or `codex --profile nexus-recovery`. Recovery's project-management
tools use authenticated shell commands as defined in [RecoveryRole](recovery-role.md#tools).
The installed CLI must support named profile files alongside its base configuration.
Saving a template in the repository does not install or activate it.

Keep OpenAI authentication and `DEEPSEEK_API_KEY` on the host. Optional research-service keys use
the commented environment-variable settings. If the provider requires a custom model catalogue,
set its Linux path through `model_catalog_json` in the installed configuration; no host-specific
catalogue path is included in the templates.

## Effective tools

Profiles layer over the base Codex configuration. They do not replace it or exclude arbitrary
inherited MCP servers and plugins. Before use, inspect the selected profile's effective tool
catalogue and disable inherited tools outside shell, files, the three research services, enabled
memory/JEv tools and the browser/image capabilities below where needed.
Repeat that check when changing the base configuration. Explicit per-app settings can override
the default app exclusion. Nexus adds the AMEM memory MCP server to memory-enabled invocations
through the provider's native settings ([Memory integration](../memory/integration.md#agent-use));
the templates do not install it, and an invocation without memory carries no memory tools.

Verify connectivity to each research service and provider authentication on the execution host.
Keep credentials and machine-specific settings out of the repository.

Preparation and delivery assignments follow the [project workflow](../project-workflow.md#profiles).
Both prototype roles require browser and image-inspection tools. Jira credentials and source
publication tools are not supplied to stage roles.

## JEv access

Use the delivered JEv package's `jev-mcp` executable through provider-native MCP settings when
[JEv is enabled](../configuration.md#jev-settings). The server inherits `JEV_API_KEY` and, when the
host sets them, the optional `JEV_USAGE_LOG_PATH` and `JEV_USAGE_LOG_CALLER` settings from the
execution host. Keep credential values out of repository configuration, prompts, command arguments,
reports and other artifacts. Install the [pinned runtime dependency](../tech-stack.md#jev-dependency)
with Nexus's normal `npm ci`; a separate global package install is unnecessary. Nexus composition
resolves the installed bin from its own installation rather than PATH or the target worktree.
The effective native settings are equivalent to:

```toml
[mcp_servers.nexus-jev-INVOCATION_ID]
command = "/absolute/nexus-installation/node_modules/.bin/jev-mcp"
args = []
enabled = true
required = false
enabled_tools = ["ask_jev"]
disabled_tools = []
env_vars = ["JEV_API_KEY", "JEV_USAGE_LOG_PATH", "JEV_USAGE_LOG_CALLER"]
```

The absolute command is installation-specific and generated at composition, not committed to
profile templates. `INVOCATION_ID` is a fresh generated identifier; `ask_jev` remains the tool name.
Codex merges native tables recursively, so replacing individual fields under a fixed server name
cannot clear an inherited transport or literal environment. The coding adapter first lists the
effective MCP configuration with the selected profile and invocation directory, without starting
servers. It disables any inherited `jev` entry in place and supplies the composed settings under a
fresh native name, checked against that catalogue. This covers base, profile and trusted project
layers without rewriting any configuration file or changing the Codex home, authentication or
unrelated tools. Composition removes Nexus override settings under the reserved `jev` name,
including nested values under `mcp_servers`, before supplying its owned settings. Native provider configuration
forwards the named host settings without writing their values to a configuration file or command
argument. Use the shared defaults described in [configuration](../configuration.md#jev-settings);
ensure inherited model/timeout variables are excluded from the server environment. A host logging
path enables the delivered package's local JSONL usage records; Nexus selects no destination and
adds no setting of its own. Omitted/disabled integration, or missing host credentials, disables
inherited `jev` entries, creates no new JEv server and supplies no JEv guidance. An optional startup
failure leaves the provider session usable with its other tools.

Verify effective `ask_jev` access and a synthetic request for the role/profile combinations in
[AgentRuntime](architecture.md#optional-jev-judgments), including preparation evaluators, recovery
and experience analysis. Check composition with existing tools, rather than treating a template
entry as evidence of working access. Host-enabled usage logging is verified through the effective
settings and an evaluation the delivered server records. Disabled access and unavailable-tool
continuation must also be demonstrated. Nexus adds no MCP client or shared HTTP service for this
integration.

## Prototype browser and image setup

Use Playwright MCP for real browser interaction and screenshot image responses. Install a pinned
`@playwright/mcp` release and its matching Chromium browser on the WSL execution host; make its
`playwright-mcp` executable available on PATH. Record the tested package/browser versions in the
installation evidence. Native tool settings select this stdio server for both prototype roles:

```toml
[mcp_servers.playwright]
command = "playwright-mcp"
args = ["--headless", "--browser", "chromium"]
```

The `--browser chromium` selection uses the Playwright-managed Chromium build; the server's default
Chrome channel requires a separately installed system Chrome.
The setup must expose navigation, interaction, browser diagnostics and rendered screenshots as
images the selected model can inspect. Shell/preview permissions allow starting the project's
Storybook server. Use separate browser sessions for author and evaluator, and release preview/browser
processes after the observation. Keep project-specific start commands in supplied prototype context,
not profile settings. No Nexus browser adapter or tool dispatcher is needed; native MCP transport
remains provider-owned.

Verify the effective tool catalogue and image delivery using each assigned prototype profile,
including the author ladder's entries. Successful installation or a screenshot filename is not
evidence that the model received and inspected the image. An unsupported model/image path or broken
server is an execution setup failure, not a usability verdict or applicability skip.

An isolated, test-consumed Storybook fixture validates this capability for internal Nexus changes.
Exercise a small journey with a state change, inspect screenshots/layout and retain each role's
observation with Nexus-observed report/revision attribution, without file inventories or per-file
revision claims. The fixture does not add product UI or external-service
navigation. See [preparation observations](../task-engine/actions/preparation-stage.md#prototype-observations)
for the evidence contract.
