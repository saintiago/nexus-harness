# Native Codex profiles

Repository templates:

- [nexus-flash](../../profiles/codex/nexus-flash.config.toml): DeepSeek Flash, maximum effort.
- [nexus-astra](../../profiles/codex/nexus-astra.config.toml): Astra, high effort.
- [nexus-recovery](../../profiles/codex/nexus-recovery.config.toml): Astra, high effort, selected for recovery.

All configure OpenAI Docs, Context7 and Tavily. They disable connector apps by default,
explicitly disable the existing GitHub connector, and exclude personal-service plugins.
Shell and file permissions come from the runtime invocation; neither profile imposes read-only
reviewer access. Role instructions are supplied separately.

## Install on Linux

From the repository root, copy the templates into the Codex home used by Nexus:

```sh
nexus_codex_home="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$nexus_codex_home"
cp profiles/codex/nexus-*.config.toml "$nexus_codex_home/"
```

Select with `codex --profile nexus-flash`, `codex --profile nexus-astra` or
`codex --profile nexus-recovery`. Recovery's project-management tools use authenticated shell
commands as defined in [RecoveryRole](recovery-role.md#tools).
The installed CLI must support named profile files alongside its base configuration.
Saving a template in the repository does not install or activate it.

Keep OpenAI authentication and `DEEPSEEK_API_KEY` on the host. Optional research-service keys use
the commented environment-variable settings. If the provider requires a custom model catalogue,
set its Linux path through `model_catalog_json` in the installed configuration; no host-specific
catalogue path is included in the templates.

## Effective tools

Profiles layer over the base Codex configuration. They do not replace it or exclude arbitrary
inherited MCP servers and plugins. Before use, inspect the selected profile's effective tool
catalogue and disable inherited tools outside shell, files and the three research services.
Repeat that check when changing the base configuration. Explicit per-app settings can override
the default app exclusion.

Verify connectivity to each research service and provider authentication on the execution host.
Keep credentials and machine-specific settings out of the repository.
