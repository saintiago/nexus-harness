# Nexus agent tools — GitHub, OpenAI Docs, Context7, and web search

**What this is.** The native Codex configuration that gives the coding turns a Jira-driven run
starts — Nexus turns — four research capabilities: the existing GitHub connector for reading, the
OpenAI Docs MCP server, Context7, and Tavily for web search and page extraction. Two Codex profile
files carry them, and the Nexus launch prefixes select those profiles with `--profile`.

**What this is not.** It is not harness behaviour and not an access-control layer in this
repository. The harness launches exactly the prefix the configuration names and records that
prefix in the report ([WORKFLOW.md](WORKFLOW.md) §1); it never reads, writes, or validates these
files, stores no credential for them, and the checks that decide a run are unchanged. Nothing here
changes an ordinary Codex turn either: every profile is a layer over the operator's own settings,
and a turn that does not name one sees none of it. Jira stays with the harness and the coordinator
— a coding turn gets no Jira tool and no Jira credential, because a source run strips the token's
environment variable from every child process it starts ([WORKFLOW.md](WORKFLOW.md) §5) — and
publication stays with the harness's own optional delivery step ([WORKFLOW.md](WORKFLOW.md) §8),
never a tool an agent may call.

## 1. What a Nexus turn gets, and what it does not

| Capability | Provided by | Endpoint | Credential |
| --- | --- | --- | --- |
| GitHub, for reading | the operator's existing `github@openai-curated-remote` connector app | the connection already in place | none added; the account the connector is already connected with |
| OpenAI developer documentation | the hosted Docs MCP server [D1] | `https://developers.openai.com/mcp` | none |
| Library documentation | Context7 [C1] | `https://mcp.context7.com/mcp` | none; a `CONTEXT7_API_KEY` raises the limits |
| Web search and page extraction | Tavily MCP [T1] | `https://mcp.tavily.com/mcp/` with `X-Tavily-Access-Mode: keyless` | none; a `TAVILY_API_KEY` raises the limits |

No credential is required for that default set: the Docs server is public, Context7 answers
anonymous requests, and the Tavily entry selects the provider's supported keyless access mode with
the header above. The two API keys are optional, private upgrades to each service's own rate limits
(§3), and their absence cannot fail a Nexus turn.

GitHub is kept, not duplicated: the connector the operator already has stays enabled and is pointed
at reading. The profile blocks the tools the connector itself flags destructive or open-world —
on the 0.154.0 connector installed here that is exactly its write surface, because every read tool
advertises `readOnlyHint: true` with neither other hint, and every other tool advertises one of the
two blocked hints. That is a tool selection made through supported native settings, not a sandbox:
it depends on the connector's own hints, and a turn is still instructed not to push or publish.
Publishing a passed attempt remains the harness's own delivery step.

Everything else stays out of a Nexus turn. Gmail, Google Drive, Google Calendar, Slack, and any
connection made later are kept out through three supported native settings [R1], none of them new
machinery:

- every connector app is off by default for the profile, and only GitHub is enabled explicitly, by
  the connector id its installed plugin declares;
- the bundled MCP servers of the two personal-service plugins that have one — Gmail and Google
  Drive — are turned off, which is a different surface from the app connector;
- the services are kept out of the "available plugins" list a new turn is offered as well.

The operator's personal turns are untouched and keep every connection; the profile files are read
only when a launch names them.

## 2. The mechanism: one native profile layer per tier

A Codex profile is a file next to `config.toml` — `<Codex home>/<name>.config.toml` — layered over
the base user configuration and selected with `--profile <name>` [P1]; the installed 0.154.0 CLI
describes the option as "Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config".
A profile changes nothing globally, adds no second installation, and needs no harness change: the
launch prefix the configuration already carries is the whole selection.

One caveat, verified on 0.154.0 and worth a guard rather than a hope: **a profile file that is not
there is silently ignored.** `codex --profile <a name with no file>` runs with the base user
configuration and exits 0, so a launch pointed at a missing profile would quietly fall back to the
personal defaults — the personal model and the personal connectors included. Install the two files
first, and treat §4 step 1 as the check for it: with the profile missing, the three servers do not
appear.

The two tiers use different models and providers, and a profile cannot include another profile, so
the Nexus scope is two files:

- [examples/nexus-flash.config.toml](../examples/nexus-flash.config.toml) mirrors the DeepSeek
  Flash profile — `model`, `model_provider`, `model_reasoning_effort`, `web_search`,
  `model_catalog_json`, and the `[model_providers.deepseek]` table — and adds the research-tool
  block.
- [examples/nexus-astra.config.toml](../examples/nexus-astra.config.toml) mirrors the Astra
  profile and adds the same block.

Both files set `web_search = "disabled"`, so the one search service is Tavily in both tiers and the
provider's own web search cannot be switched to `live` by the full-access sandbox the adapter
selects. Both also set `mcp_optional_startup_grace_ms = 0`: a Nexus turn is a single
non-interactive invocation, so its first — and only — tool catalog waits for each MCP server
instead of racing the 1 s default grace [M1].

The model lines are repeated from `deepseek.config.toml` and `astra.config.toml`; a profile cannot
include another profile, and the personal profiles stay byte-for-byte as they are, so keep the two
files in step when a tier's model selection changes. Nothing in the harness notices a drift.

## 3. Operator setup (once)

1. **Install the two profiles** into the Codex home that runs the harness:

```powershell
$codexHome = Join-Path $env:USERPROFILE '.codex'
Copy-Item examples\nexus-flash.config.toml (Join-Path $codexHome 'nexus-flash.config.toml')
Copy-Item examples\nexus-astra.config.toml (Join-Path $codexHome 'nexus-astra.config.toml')
```

2. **Credentials are optional, and only for a service you have a key for.** Nothing the profiles
   activate needs one: the Docs server is public, Context7 answers anonymous requests, and
   Tavily's keyless access mode is the default. A key is an upgrade to that service's own rate
   limits — Tavily's free key (<https://tavily.com>) or a Context7 key
   (<https://context7.com/dashboard>) — and it belongs in the environment the harness itself is
   started in: never in a file in this repository, and never in a launch argument, because the
   launch prefix is recorded in `result.json` and `logs/run.log`. For the current PowerShell
   session and for future terminals:

```powershell
$secure = Read-Host "Tavily API key" -AsSecureString
$key = [System.Net.NetworkCredential]::new("", $secure).Password
[Environment]::SetEnvironmentVariable("TAVILY_API_KEY", $key, "User")
$env:TAVILY_API_KEY = $key
Remove-Variable secure, key
```

   Repeat with `CONTEXT7_API_KEY` for a Context7 key. Then uncomment the matching line in *both*
   installed profile files, which carry the authenticated form ready to enable:

```toml
[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"
bearer_token_env_var = "CONTEXT7_API_KEY"
```

```toml
[mcp_servers.tavily]
url = "https://mcp.tavily.com/mcp/"
http_headers = { "X-Tavily-Access-Mode" = "keyless" }
bearer_token_env_var = "TAVILY_API_KEY"
```

   A valid Tavily key takes precedence over the keyless header [T2], so that header stays as it
   is; with no key set, the uncommented default keeps working. This persists the value for future
   terminals and sets it in the current process; like the Jira token in [WORKFLOW.md](WORKFLOW.md)
   §7 it is a user environment variable, not an encrypted vault — processes running as the same
   user may be able to read it. Existing runs are unaffected; new runs inherit the variable
   because the harness passes its own environment to the runtime.

3. **Point each Nexus launch prefix at its profile.** Only the profile name changes: the
   executable, the model flag, and the adapter's own non-interactive arguments are unchanged, and
   the existing model and permission selections stay as they are. In the Nexus configuration —
   the top-level `agent`, and each `escalation` rung that names its own launch. The two pieces are
   shown below, not a complete configuration file; the rest of the configuration is unchanged:

```json
{
  "agent": {
    "runtime": "codex",
    "command": [
      "C:/Users/User/.codex/packages/standalone/current/bin/codex.exe",
      "--profile",
      "nexus-flash",
      "--model",
      "deepseek-flash"
    ]
  },
  "escalation": [
    {
      "name": "flash",
      "agent": {
        "runtime": "codex",
        "command": [
          "C:/Users/User/.codex/packages/standalone/current/bin/codex.exe",
          "--profile",
          "nexus-flash",
          "--model",
          "deepseek-flash"
        ]
      },
      "maxRepairs": 2
    },
    {
      "name": "astra",
      "agent": {
        "runtime": "codex",
        "command": [
          "C:/Users/User/.codex/packages/standalone/current/bin/codex.exe",
          "--profile",
          "nexus-astra",
          "--model",
          "gpt-6-astra"
        ]
      },
      "maxRepairs": 2
    }
  ]
}
```

   The ladder shape is [WORKFLOW.md](WORKFLOW.md) §1's; tier names, repair allowances, and whether
   a ladder is used at all stay the operator's decisions. The checked-in
   [nexus.config.example.json](nexus.config.example.json) already selects `--profile nexus-flash`;
   the Nexus-wide configuration a coordinator actually runs is the operator's own `nexus.config.json`
   outside this checkout, and it is that step's real target.

4. **Validate statically.** `npm run dev -- check-config --config <the Nexus configuration> --project <a connected project>` reads
   no credential, contacts nothing, and rejects a malformed launch prefix. It does not look at
   native Codex files, so it cannot prove that the profile exists — Codex will ignore a missing
   one — and step 5 is therefore not optional.

5. **Run the smoke below once per tier** before the next real queue run. Nothing here is applied by
   this repository: the files, the environment variables, and the launch prefixes are the
   operator's.

## 4. New-session smoke procedure

Short, and run once per tier; it is not a model-by-tool matrix.

1. **Configuration, without a session** (read-only, no credential):

```powershell
codex --profile nexus-flash mcp list
codex --profile nexus-flash mcp get tavily --json
codex --profile nexus-astra mcp list
codex --profile nexus-astra mcp get tavily --json
```

   Each must list `openaiDeveloperDocs` (`https://developers.openai.com/mcp`), `context7`
   (`https://mcp.context7.com/mcp`), and `tavily` (`https://mcp.tavily.com/mcp/`) beside the
   servers the Codex home already had, and `mcp list` must show **no** bearer token env var on any
   of them. The two `mcp get tavily --json` calls are what show the `"X-Tavily-Access-Mode":
   "keyless"` header, which `mcp list` does not print. Optionally, `codex --profile nexus-flash
   debug prompt-input "hello"` prints the prompt a new turn would receive: Gmail, Google Drive,
   Google Calendar, and Slack must not appear in it.

2. **One new session per tier.** Start `codex --profile nexus-flash` (and later
   `codex --profile nexus-astra`) — the same interactive CLI a person would use; `/mcp` shows the
   connected servers and their tools.

3. **One lookup per capability, in that session:**

   - GitHub: read something real — for example, "list the open pull requests in
     `saintiago/nexus-harness` and tell me which one is newest".
   - OpenAI Docs: "look up how `codex exec` reads its prompt in the OpenAI developer docs and
     quote the source".
   - Context7: "use Context7 for the current API of a library I know, and name the library id it
     resolved".
   - Tavily: "search the web for today's date in Europe/Madrid and extract one page that says it"
     — the keyless default answers this, and a rate-limit message is the one thing to look for.

   Record one line per capability: the tool that ran, and whether it returned or what it said.

4. **Absence of the personal connectors, in the same session.** Ask the turn for its model-visible
   tool list, or ask it to use a Gmail tool: no `gmail.*`, `google-drive.*`, `google-calendar.*`,
   or `slack.*` tool may exist. "The tool does not exist" is the expected answer.

5. **Repeat steps 2–4 once with the Astra profile.** One session per tier is the whole check:
   Astra uses the OpenAI account the CLI is already logged in with, Flash uses
   `DEEPSEEK_API_KEY`, and neither tier needs a research credential: both read `TAVILY_API_KEY`
   and `CONTEXT7_API_KEY` only when the operator set them.

A green configuration check is not evidence that a live tool call works. An unset
`TAVILY_API_KEY` or `CONTEXT7_API_KEY` is not a setup blocker: the smoke runs on the anonymous
Context7 and keyless Tavily defaults, and only the services' rate limits change when a key is
added.

## 5. What was verified when this document was written, and what was not

Verified on 2026-09-19 with the CLI this machine runs (`codex-cli 0.154.0`), without touching the
operator's Codex home:

- the two example profiles parse as Codex configuration and, layered in a temporary Codex home,
  `codex --profile nexus-flash mcp list` and `codex --profile nexus-astra mcp list` print exactly
  the three servers above with their expected URLs and **no** bearer-token environment variable;
- the corrected defaults were re-checked the same way: `codex --profile nexus-flash mcp get
  context7 --json` and `codex --profile nexus-flash mcp get tavily --json` (and the same pair for
  `nexus-astra`) report `bearer_token_env_var: null` for Context7 and the `X-Tavily-Access-Mode:
  keyless` header on Tavily, so a missing key cannot fail either server's startup;
- a profile name with no file is silently ignored on this CLI version — `codex --profile
  definitely-not-there mcp list` printed only the base servers and exited 0 — which is why the
  smoke procedure checks the servers rather than the launch's exit code;
- `codex mcp list` and `codex mcp get` read a profile layer on this CLI version, which is what the
  smoke's step 1 rests on;
- the suggestion deny-list works: `codex debug prompt-input` with the equivalent `-c` overrides
  dropped Gmail and Google Drive from the turn's "available but not installed" list while GitHub
  and Google Calendar stayed, and the same command with a plugin *allow* list changed nothing
  (which is why the profile uses the deny list);
- the connector ids and tool hints come from the installed plugins' `.app.json`/`.mcp.json` files
  and the Codex host's own cached connector tool schema on this machine: GitHub
  `connector_76869538009648d5b282a4bb21c3d157`, Gmail
  `connector_2128aebfecb84f64a069897515042a44`, Google Drive
  `connector_5f3c8c41a1e54ad7a76272c89e2554fa`.

Not verified, and reported as such rather than assumed:

- this repository neither installs the profiles nor changes a launch prefix: §3 is the operator's
  step, deliberately outside this working copy, and nothing in the harness reads these files;
- no live session has run from this checkout: no MCP server has been connected, the anonymous
  Context7 and keyless Tavily paths and the optional keyed ones have not been exercised here, no
  GitHub read has been made through the profile, and the absence of the personal connectors in a
  real session is not proven — that is what the smoke procedure is for;
- the one live smoke reported so far, a bounded read-only Flash session the coordinator ran on
  2026-09-19 against the profiles' earlier revision, confirmed the GitHub read and the OpenAI Docs
  lookup, exposed no callable Gmail, Google Drive, or Slack tools, and had Context7 and Tavily fail
  only because that revision required the two credentials above — the failure these defaults
  remove. The corrected defaults have not been smoke-tested yet, and the next smoke is their
  evidence;
- the optional Tavily keyed form relies on the provider's statement that its remote MCP accepts the
  API key in the `Authorization` header and that a valid key takes precedence over the keyless
  header [T2]. If a smoke run ever shows it refused, the provider's local server reads the same
  variable: `command = "npx"`, `args = ["-y", "tavily-mcp@0.1.3"]`,
  `env_vars = ["TAVILY_API_KEY"]`;
- the profiles were written against this machine's plugin marketplace ids
  (`gmail@openai-curated-remote` and so on). `codex plugin list` prints the exact ids; if a future
  marketplace renames one, mirror the two `[plugins."…".mcp_servers.…]` tables and the
  `tool_suggest` entries.

## References

The configuration uses the documented Codex profile, MCP, app, and suggestion settings; the
capability endpoints and their keyless or anonymous defaults are the providers' own documentation.

[P1]: https://learn.chatgpt.com/docs/config-file/config-advanced#profiles
[M1]: https://learn.chatgpt.com/docs/extend/mcp
[R1]: https://learn.chatgpt.com/docs/config-file/config-reference
[D1]: https://developers.openai.com/learn/docs-mcp
[C1]: https://context7.com/docs/overview
[T1]: https://docs.tavily.com/documentation/mcp
[T2]: https://docs.tavily.com/documentation/keyless
