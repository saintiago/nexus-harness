# Workflow and inputs

This is a human-readable reference, **not runtime configuration**. The application reads ordinary JSON. There is no Markdown front-matter parser, custom workflow language, harness profile registry, or provider configuration parser.

**Revision: 2026-09-16 — task input sources, Jira first; service-account authentication.** Preserve optional `agent` and add independent optional `source`. Existing six-field configurations and four-field task files remain valid. [spec.md](spec.md) defines behavior; [architecture.md](architecture.md) assigns ownership; [implement-task-source-connectors.md](implement-task-source-connectors.md) implements intake. The earlier `setup-codex-task.md` remains the separate runtime setup assignment, not reissued here.

**Revision: 2026-09-19 — optional GitHub delivery.** Add independent optional `delivery`, defined in §8: with it, a passed attempt's branch is pushed and its pull request opened or updated before the result is published. Without it, nothing changes: every command and every run stays local. [spec.md](spec.md) §7 defines the behavior and [architecture.md](architecture.md) §2 the module.

**Revision: 2026-09-20 — optional review-to-completion.** Add an independent optional `completion` object inside `delivery`, defined in §9: with it, an In Review item whose delivered pull request the Nexus Lens reviewer approved on its current head is carried through native GitHub auto-merge and the configured post-merge main workflows to a verified resolution, or back to its To Do status with findings. Without it, every delivered pull request waits for a person exactly as before. [spec.md](spec.md) §8 defines the behavior.

**Revision: 2026-09-19 — optional Nexus Lens reviews.** Add independent optional `review`, defined in §9, and the `review scan` and `review watch` commands it enables: with it, the tickets the configured Jira connection reports as being in review are reviewed through one explicitly configured reviewer profile, and each verdict is published as a native GitHub review plus one app-owned check run. Without it, nothing changes: no App credential is read, GitHub is never contacted, and no reviewer turn runs. [spec.md](spec.md) §9 defines the behavior and [architecture.md](architecture.md) §2 the module.

## 1. Configuration

Keep the existing `harness.config.json` shape valid:

```json
{
  "workDir": "./.harness",
  "maxRepairs": 2,
  "taskTimeoutMinutes": 60,
  "commandTimeoutMinutes": 10,
  "setup": [["npm", "ci"]],
  "checks": [["npm", "run", "typecheck"], ["npm", "test"]]
}
```

These are target-project commands, not the harness's own CI pipeline. Edit them for each target; the example assumes an npm project with those scripts. Do not use interactive/watch modes.

### Fields

All six original fields are required. `agent`, `escalation`, `source`, `delivery`, and `review` are independently optional. Reject unknown top-level/nested fields and invalid types rather than coercing them. Source commands require `source`; ordinary file-task commands do not construct it or require its credentials. `review` requires `source`, because it reviews through that same connection and carries no connection of its own. Without `delivery` nothing is pushed or published, whatever else the configuration says.

| Field | Meaning and validation |
| --- | --- |
| `workDir` | Nonblank output directory. Resolve relative to the config file, not the target repo. |
| `maxRepairs` | Nonnegative integer; additional coding turns after implementation. |
| `taskTimeoutMinutes` | Positive integer; total run time limit. |
| `commandTimeoutMinutes` | Positive integer; per setup/check command limit, capped by remaining task time. |
| `setup` | Array of command argument arrays; may be empty. Run before baseline and before each post-agent check round. |
| `checks` | Nonempty array of command argument arrays; every check is required. |
| `agent` | Optional strict object with required `runtime` and `command` fields when present. No `null` or partial objects. |
| `escalation` | Optional nonempty array of tiers: `{ "name", "agent"?, "maxRepairs"? }` with distinct names. Attempt N of one issue runs tier N, clamped to the last, in the same workspace; a tier that names no `agent` or `maxRepairs` inherits the top-level one. Absent means a single `default` tier built from `agent` and `maxRepairs` (docs/implement-workspace-continuation.md). |
| `source` | Optional strict Jira object defined in section 5. No `null`; unsupported source types are errors. |
| `delivery` | Optional strict GitHub object defined in section 8: the destination repository and base branch a passed attempt is delivered to. No `null`; unsupported delivery types are errors. Absent means local-only. |
| `review` | Optional strict GitHub object defined in section 9: the repository, App installation, reviewer launch, and check name a review scan uses. No `null`; unsupported types are errors. Absent means no review command runs anything. |

Setup/check commands remain nonempty string arrays with a nonblank executable first. Remaining arguments are literal strings, including intentional empty strings. Never concatenate task text into commands or implicitly interpolate environment variables. Use the tested platform launcher and retain its documented restrictions.

All setup/check commands execute in the retained task working copy. Load configuration once before execution. Credential values and coding-provider account setup are not JSON fields. Source configuration names environment variables; it never contains the Jira token itself.

The harness's own Git steps are bounded too, and are not configuration: inside a run each reading runs under what is left of `taskTimeoutMinutes` when it starts, with the run's own stop request, and a reading with no deadline to spend — the source preflight, a continuation's branch check, the final comparison — runs under a fixed finite bound (docs/spec.md §3). A Git stopped at its bound is reported as that stop, with whether it was confirmed.

### Agent contract

| Field | Meaning and validation |
| --- | --- |
| `agent.runtime` | Exactly `"codex"` in this increment. Selects the actual adapter, not the upstream provider. Reject `"claude"`, `"deepseek"`, and other unsupported values. |
| `agent.command` | Nonempty string array: executable followed by literal prefix arguments. First item must be nonblank; remaining strings, including empty strings, are preserved. |

Omitting the whole `agent` field normalizes to:

```json
{
  "runtime": "codex",
  "command": ["codex"]
}
```

That uses the user's ordinary Codex defaults, whatever those are. It does not force OpenAI. The local setup assignment separately preserves the user's restored OpenAI defaults.

A complete DeepSeek configuration example is:

```json
{
  "workDir": "../harness-runs",
  "maxRepairs": 2,
  "taskTimeoutMinutes": 60,
  "commandTimeoutMinutes": 10,
  "setup": [["npm", "ci"]],
  "checks": [["npm", "run", "typecheck"], ["npm", "test"]],
  "agent": {
    "runtime": "codex",
    "command": ["codex", "--profile", "deepseek", "--model", "deepseek-flash"]
  }
}
```

Here `--profile` chooses native configuration and `--model` explicitly selects the model for the invocation. To use the profile's default model instead, omit the `--model` pair. To select Pro, change only that pair's value to `deepseek-v4-pro`. These are runtime arguments, not a model enum maintained by the harness. Native configuration examples and official references are in the setup task.

The adapter appends its existing suffix and supplies the task prompt on stdin:

```text
codex --profile deepseek --model deepseek-flash --ask-for-approval never exec --sandbox danger-full-access --json -
```

The execution part is not configurability: it is the adapter's own fixed suffix. Each turn runs unsandboxed (`--sandbox danger-full-access`) and unattended (`--ask-for-approval never`, so nothing waits for a prompt), because a turn must be able to stage and commit in the retained working copy and the narrower `workspace-write` policy — in its `--sandbox` spelling or its native permission-profile spelling — leaves that copy's Git metadata read-only on Windows, where `git add` fails on `.git/index.lock` (HARN-2, HARN-10). That policy is an explicit, documented choice, not a hidden fallback: the suffix is the same for every turn, and nothing widens after a failure. A turn has the same file and network reach as the harness's own configured `setup` and `checks` commands; README "Safety" states that plainly.

Do not put `exec`, a prompt, redirection, a shell expression, or an end-of-options `--` into the configured prefix. Do not use prefix options/wrappers that redirect the working directory, replace structured output, or override the adapter's execution/permission controls. This is a trusted launcher contract, not a general CLI policy language.

### Agent launch and path rules

- A bare executable name such as `codex` uses the existing host launcher and PATH resolution. Shell aliases/functions such as a PowerShell function are not standalone executables.
- An absolute executable path is used as supplied. A relative executable path containing a path separator resolves against the harness configuration file's directory, not the cloned target. Perform that resolution once before execution.
- Remaining arguments are opaque; the harness does not guess which are paths. Use absolute paths for wrapper scripts/config files in those arguments. Relative argument paths are interpreted by the launched program with the task workspace as its current directory.
- Do not expand `~`, `$HOME`, `%VARIABLE%`, or shell substitutions inside JSON. Preserve argument boundaries; never join the prefix and suffix into a shell command string.
- On native Windows, a `.sh` wrapper needs an explicitly named interpreter with its actual installed path. Do not rely on a bare `bash` selecting Git Bash rather than WSL. A wrapper must ultimately run Codex and preserve stdin, stdout, stderr, forwarded arguments, cwd, and lifecycle behavior. Wrappers that break those contracts are unsupported.

The same effective selection is used for implementation and every repair. A configuration/runtime failure must not fall back to another provider, model, or default launch.

## 2. Task

Keep `examples/task.json` and its four fields unchanged:

```json
{
  "id": "example-001",
  "title": "Add a greeting function",
  "description": "Implement a greeting function using the target project's existing conventions.",
  "acceptanceCriteria": [
    "Returns a greeting containing the supplied name.",
    "Includes tests for the documented behavior."
  ]
}
```

Require all four fields and reject unknown fields. Text fields must be nonblank; `acceptanceCriteria` must contain at least one nonblank string. The task ID is a label, never a filesystem path or shell argument assembled into a command.

Acceptance criteria guide implementation and human review. This version does not turn prose into trusted acceptance tests. Tasks cannot override the agent, provider, credentials, or configured checks.

## 3. CLI boundary

Retain the public commands:

```sh
npm run dev -- --help
npm run dev -- check-config --config harness.config.json --task examples/task.json
npm run dev -- run --repo ../target-project --config harness.config.json --task examples/task.json
```

`check-config` validates JSON, normalizes defaults and documented paths, and reports useful file/field errors. `--task` becomes optional: omit it to validate configuration only, or supply it to additionally validate a four-field task file. This command creates no directories, runs no executable (including `--version`), reads no native profile/authentication file, resolves no credential values, and contacts neither Jira nor a coding provider. Valid input exits 0; invalid input, unknown options, or file-read errors exit nonzero. No arguments display help.

CLI file paths and `--repo` resolve from the invocation's current directory. `workDir` and a relative path-valued agent executable resolve from the config file's directory. `run` performs the existing source/output preflight. When the harness targets itself, choose an output directory outside its source. Static validation does not prove Git state, runtime availability, authentication, or execution safety.

Keep the existing exit-code behavior and interrupt handling. Do not add per-task provider options or a public fake runtime.

### Opt-in live verification

Extend the existing verifier to accept a harness configuration path:

```sh
npm run test:live -- --config harness.config.json
```

The verifier uses the selected `agent`, `maxRepairs`, `taskTimeoutMinutes`, and `commandTimeoutMinutes`. Its disposable fixture supplies the repository, output directory, task, setup, and checks; it must not execute the user's configured project commands or target a real project merely because a config was supplied. Require at least one repair allowance for the two-exercise verifier; reject `maxRepairs: 0` before making paid calls instead of increasing it silently.

Without `--config`, preserve the verifier's existing documented defaults, including the ordinary Codex launch. Custom-provider verification must explicitly select its configuration.

Do not require `CODEX_API_KEY`, an OpenAI login, or `auth.json` as universal prerequisites. The live invocation establishes whether the selected runtime's credentials and protocol actually work. Launch failure or missing authentication is a failed/unexecuted live check, never a pass. No automatic login, provider fallback, or paid retry loop.

Keep live tests outside default discovery, `npm test`, `npm run validate`, and CI. See the setup task for offline prerequisite tests and T16 evidence.

The launch also has a by-hand commit check in README "Coding runtime": a disposable repository where a real turn commits its work, with the retained clone inspected afterwards. It is not part of `npm test`, `npm run validate`, or CI, and it is not evidence until it has been run.

## 4. Loop semantics

```text
prepare → setup → baseline checks
                     |
                    pass
                     v
               implementation
                     |
                     v
              setup → all checks ←───────┐
                        |               |
                        ├─ fail → repair┘  (while allowance remains)
                        |
                       pass
                        v
                 save local result
                        |
                        v
            deliver (§8, only when configured)
```

A red baseline stops a **fresh attempt** before any coding turn; a **continuation** may start red, because its workspace may already carry unfinished or failed work, and only its post-turn check round decides. A setup/launch/authentication/protocol error, expired timeout, cancellation, or exhausted repair allowance stops the loop and preserves work, fresh or continued. Only ordinary completed red check rounds trigger repair. Checks are rerun by the harness regardless of the agent's claims. The selected agent does not change between turns. See the specification for reporting and safety semantics.

The delivery step is **outside the run**: the run's own report is written first, and only a `passed` attempt is delivered. A delivery failure changes neither the run's status nor its evidence, and it never starts a coding turn (§8).

Every working copy is given a **repository-local** Git identity (`Nexus Agent <nexus@local>`, commit signing disabled) before any check or coding turn runs, so a turn can make small local commits as it works; it is encouraged to finish with the relevant work committed where practical. Those commits stay in the retained working copy: the harness itself never merges or integrates a target's changes and, without a configured delivery step, never pushes or publishes them either. A commit is not a check result, and anything a turn leaves uncommitted is kept. A continued workspace keeps the base commit its ledger recorded as the comparison base, so `changes` in the report is the whole diff against that base, committed and uncommitted parts alike. These settings are written with `git config --local`; the harness never writes global or system Git configuration.

## 5. Source configuration — Jira Cloud

The only implemented source type is `"jira"`. Exactly one source belongs to a config; do not add a `sources` array or accept placeholder types. The local `--repo` and the original setup/check fields bind every fetched issue to an explicitly chosen target. Issues cannot supply paths or executable commands to the harness.

A complete example for the current test queue is:

```json
{
  "workDir": "../harness-runs-jira",
  "maxRepairs": 2,
  "taskTimeoutMinutes": 60,
  "commandTimeoutMinutes": 10,
  "setup": [["npm", "ci"]],
  "checks": [["npm", "run", "typecheck"], ["npm", "test"]],
  "agent": {
    "runtime": "codex",
    "command": ["codex", "--profile", "deepseek"]
  },
  "source": {
    "type": "jira",
    "siteUrl": "https://malton-family.atlassian.net",
    "cloudId": "9337c4da-7d33-4c1d-b03c-db207e537f88",
    "projectKey": "SAM1",
    "label": "harness-task",
    "pollIntervalSeconds": 30
  }
}
```

This example selects the native profile's default model. Preserve your existing `agent.command` instead when it already selects the desired model explicitly. Edit setup/checks for the target repository; the npm scripts above are not universal. Keep `workDir` outside the source checkout, especially when the harness targets its own repository.

### Fields and defaults

| Field | Contract |
| --- | --- |
| `type` | Required, exactly `"jira"`. |
| `siteUrl` | Required HTTPS Jira Cloud origin, such as `https://name.atlassian.net`. No credentials, query, fragment, or non-root path. Normalize a trailing slash away. |
| `cloudId` | Required nonblank UUID. Jira service-account API tokens are scoped and use the Atlassian API gateway. |
| `projectKey` | Required nonblank project key. This is a mandatory queue boundary, never a global all-projects search. |
| `issueType` | Optional nonblank name, default `"Task"`. |
| `label` | Optional nonblank single Jira label without whitespace, default `"harness-task"`. |
| `readyStatus` | Optional nonblank name, default `"To Do"`. |
| `runningStatus` | Optional nonblank name, default `"In Progress"`. |
| `reviewStatus` | Optional nonblank name, default `"In Review"`. |
| `pollIntervalSeconds` | Optional integer at least 5, default 30. Delay after a completed scan/batch, not a promised event-delivery latency. |
| `tokenEnv` | Optional environment-variable name, default `"JIRA_API_TOKEN"`. The variable contains the Jira service-account API token. |

Status names must be distinct. `tokenEnv` must match `[A-Za-z_][A-Za-z0-9_]*`. Reject unknown fields, explicit nulls, whitespace-only names, and coercions. Only URL normalization/defaults are automatic; never silently choose another site or project. Static validation cannot prove remote access, workflow transitions, or issue visibility.

These are the **canonical** Jira names (`Task`, `To Do`, `In Progress`, `In Review`), not the translations a site's language may display. The queue's JQL resolves the canonical names, and the connector asks Jira to answer in one language explicitly (`Accept-Language: en`) instead of leaving the choice to its HTTP client — JavaScript's `fetch` sends `accept-language: *`, which resolves to the site's default language and can make the answer disagree with the queue that produced it. Names the operator authored (a project, a label, a custom status) are returned as authored in every language.

### Credentials and endpoint routing

Use a dedicated Atlassian **service account** with a scoped Jira API token. Resolve only `tokenEnv` for source commands; reject a missing or blank token. Send it as `Authorization: Bearer <token>`. Do not require or store a service-account email. Do not print the token, write it to configuration, or pass it to target commands/Codex. The harness is a direct Jira REST client, not a consumer of ChatGPT's Rovo login. [W1]

Service-account API tokens are scoped and must use the Atlassian API gateway. The API prefix is always:

```text
https://api.atlassian.com/ex/jira/<cloudId>
```

`cloudId` is therefore required for the Jira connector. Do not implement or fall back to `https://<site>.atlassian.net/rest/api/...` authentication. Append `/rest/api/3/...` without dropping the gateway path prefix. Browser issue links still use `siteUrl + "/browse/" + issueKey`; receipt identity still uses the canonical site URL. Never follow response-provided `self`/attachment links with authentication. [W1]

Create the service-account token with only the Jira scopes the connector needs. For this design, use the classic scopes `read:jira-work` and `write:jira-work`. The service account must separately have Jira product/project access that permits browsing the project, viewing the relevant issues, transitioning them, and adding comments. Scopes do not grant missing Jira permissions. [W1], [W3], [W4], and [W5]

### Queue expression

Build this JQL from the configured values, quoting/escaping string literals rather than interpolating arbitrary task text:

```jql
project = "SAM1"
AND issuetype = "Task"
AND labels = "harness-task"
AND status = "To Do"
ORDER BY priority DESC, created ASC, key ASC
```

Do not expose arbitrary JQL parsing/composition or a timestamp cursor in this increment. Using a different label is enough to isolate a disposable test queue. The label plus ready status is an explicit authorization to spend agent capacity in the trusted configured repository.

Jira's priority scheme resolves `priority DESC`, so the highest-priority ready issue comes first, with the oldest creation and then the issue key breaking ties. Jira does the sorting and the connector keeps the order of the answer across pages, whatever the issue keys would suggest: a priority change takes effect on the next scan and never reorders an active task or a batch that was already discovered.

## 6. Jira issue convention

Use an ordinary Task with a clear summary and a description such as:

````markdown
## Goal
Create HARNESS_SMOKE_TEST.md at the repository root.
Its entire UTF-8 content must be jira-harness-smoke-test followed by one LF newline.

## Acceptance criteria
- HARNESS_SMOKE_TEST.md exists at the repository root.
- Its bytes are exactly the required text plus one LF newline.
- No other tracked or untracked project files are changed.

## Verification
Inspect the file content and the final diff.

## Constraints
Do not modify dependencies, source code, tests, or configuration.
````

No Jira custom fields, JSON front matter, repository selectors, or command fields are needed.

### Deterministic mapping

| Existing Task field | Jira input |
| --- | --- |
| `id` | Current issue key, for example `SAM1-11`. The immutable numeric issue ID is separate source provenance. |
| `title` | Nonblank summary. |
| `description` | Full supported description rendered as readable text/Markdown, preserving sections, lists, line breaks, code, and link destinations. |
| `acceptanceCriteria` | One string per top-level list item under the recognized heading, preserving nested item's text rather than discarding it. |

Jira REST API v3 descriptions use Atlassian Document Format, not an assumed Markdown string. Support its `doc`, `heading`, `paragraph`, `text`, `hardBreak`, `bulletList`, `orderedList`, `listItem`, and `codeBlock` nodes, including basic inline emphasis/code/link marks. Do not flatten the entire document before finding sections: text inside a code block is never a section heading. [W6]

Require exactly one top-level heading node whose text, after trimming and removing an optional final colon, case-insensitively equals `Acceptance criteria`. Its section ends at the next heading of the same or higher level. Require at least one nonblank bullet/ordered-list item in that section. `Goal`, `Verification`, and `Constraints` are conventions for readability; only the criteria heading has extraction semantics. Reject ambiguous duplicate headings, empty content/items, and unlisted meaningful nodes/marks rather than guessing or dropping hidden requirements. Show an actionable issue-specific validation error.

There is no automatic fetch of attachments, comments, linked pages, or external URLs. No rich-text editor or universal ADF converter is needed. Preserve the issue description itself; publishing results never rewrites it.

The `Verification` section is **not executable configuration**. Existing configured baseline/post-agent checks still run. Do not copy shell commands out of Jira into `checks` or weaken baseline checks for a source task. A task-specific acceptance assertion can be part of separately reviewed local tooling or the final manual review.

## 7. Source CLI

The commands below are the implemented interface:

```sh
# Static validation; no credentials or network needed.
npm run dev -- check-config --config harness.jira.config.json

# Read-only preview; contacts Jira, but makes no changes or paid agent calls.
npm run dev -- source list --config harness.jira.config.json

# Fetch a finite batch and automatically run at most one new attempt.
npm run dev -- source run --repo ../target-project --config harness.jira.config.json --limit 1

# Run all currently discovered eligible, valid issues sequentially.
npm run dev -- source run --repo ../target-project --config harness.jira.config.json

# Scan immediately, then continue polling until Ctrl+C.
npm run dev -- source watch --repo ../target-project --config harness.jira.config.json
```

`source list` needs only `--config`. `source run` and `source watch` require `--repo` and `--config`; reject `--task` on source commands. `--limit` is a positive integer accepted only by `source run`, counting the attempts it starts — a first attempt or a continuation — not receipted skips, refusals, or invalid descriptions. Omitting it means the complete finite discovered batch. Watch has no lifetime task limit in this increment.

The source preview prints each issue's disposition, key, title, URL, and one detail line. The dispositions are `valid` (unattempted, and a run would create its workspace), `continuable` (the detail names the workspace ID and the attempt number a run would continue), `refused` (why it will not be acted on: a receipt with no pointer, a pointer that is not a generated workspace id, a pointer this machine cannot resolve, a pointer that names another item's, site's, or repository's workspace, a pointer whose workspace or ledger resolves out of the workspaces directory through a junction or symbolic link, a workspace whose ledger records no item identity, or more than one pointer), `invalid` (the task-description problem), and `stale` (no longer eligible when re-read). A continuation's detail carries only that workspace ID and attempt number — the receipt path and its recorded result are not repeated there; a refusal may quote the receipt's own one-line summary in its reason. An existing receipt is read before the item is mapped, and the pointer labels are judged only after the item has been re-read: the decision uses the labels that read observed, never the ones the search result that discovered the issue carried. The preview takes no `--repo`, so it cannot check the repository a workspace was cloned from; an attempt checks that before it reserves. An old attempt is not made runnable by an edited description. No directory creation, locks, remote writes, or process launches are allowed in preview.

`source run` exits 0 for an empty queue or when all new attempts pass and feedback succeeds, with only harmless stale, refused, or still-receipted skips. Invalid task descriptions, failed/cancelled runs, claim/API errors, and failed feedback give a nonzero result; a valid later issue can still run after an ordinary task failure. Fatal integration/local-state/process-cleanup errors stop the batch immediately. Print a compact count/result summary and real artifact/receipt paths, not only a generic success message.

Watch keeps running after handled task failures or invalid descriptions. It stops on fatal configuration/authentication errors, uncertain remote writes, failed feedback, or unsafe process cleanup. Read-only transient failures back off; successful discovery resets the backoff. Print changes and per-batch outcomes, not unchanged issue bodies on every empty poll. Preserve existing interrupt exit-code behavior; do not hide a fatal exit as success.

Normal file-based `run --task ...` remains independent: even with `source` in its config, it must not read Jira credential values, contact Jira, create intake state, or emit remote updates. It never delivers either: a file-task run's clone is fresh every time, so there is no stable branch for §8 to update, and the command stays local even with a `delivery` object present. The opt-in coding runtime verifier also ignores `source` and `delivery`, and must never contact or mutate Jira or GitHub.

### Result status, continuation, and manual retry

For all terminal local outcomes, publish the exact `passed`, `failed`, or `cancelled` outcome and move from running to review when still appropriate. `In Review` does not mean success. `Done` stays a human decision after inspecting and applying the retained changes. A passed attempt delivered by §8 carries its pull request URL in that comment; a passed attempt whose delivery failed carries the run's own outcome with the failure beside it, so the two never leave a finished task sitting in the running status. Nothing else about the comment changes.

While an `escalation` ladder is climbing, the issue stays in the running status: each attempt publishes its own comment ("attempt 2 of 3, tier pro"), and only the climb's last attempt — a pass, a terminal failure, or the rung that exhausted the ladder — publishes the final result and moves the issue to review. Only an exhausted ordinary red check round climbs: a setup/launch/authentication/protocol error, a cancellation, an expired limit, and a stop that was not confirmed each end the intake at the rung where they happened rather than spending a stronger launch on them. That rung's result is then published and moved to review, with two deliberate exceptions that stop intake instead: a run whose stopped executions could not be confirmed to have ended publishes nothing and leaves the issue where it is, and neither does an attempt whose workspace ledger could not be written (see the local-save paragraph below).

A delivery failure is an operator problem, not a coding one: the run's report and logs are kept as they were written, the receipt records `delivery: <what failed>`, the issue is still told the outcome the run produced with the failure beside it, and intake stops. Fix what the failure names — a leftover path, Git credentials, or `gh auth status` — and retry the publication **by hand** in the retained workspace with ordinary `git` and `gh`, checking GitHub first because a failed push or creation may already have taken effect; §8 has the recipe. Moving the issue back to the ready status is not that retry: it starts a new coding run in the same workspace. No coding turn is started to repair a publishing failure.

A required local save that fails is not rounded into a success either: if an attempt cannot be recorded in its workspace's ledger, the run's own report, logs, and working copy are kept as they were written, the receipt records `workspace ledger: <what failed>` with the failed path, and intake stops instead of starting another attempt — the next attempt's number, its tier, and its guidance all come from that ledger, so none is started against one that does not hold the attempt. Repair the ledger by hand (the ledger is validated strictly: version 1, and the identity and attempt fields this harness writes), then move the issue back to the ready status to continue the same workspace.

A local receipt prevents a second attempt from starting by accident across polling and restart. Changing the issue does not clear that receipt: the pointer label, not the receipt, decides what happens next. Returning the issue to the ready status with a valid pointer starts another attempt in the same workspace — it does not create a fresh clone or clear the receipt. **Rework happens in the same workspace**: the run that creates a workspace writes the pointer label `harness-ws-<workspaceId>` on the issue once, before any coding turn, and an issue in the ready status whose pointer resolves on this machine is continued — same clone, same recorded base, a new run directory and report, and a baseline round that may be red. Every attempt reads the issue's own thread as context: a continuation reads what was added since the last attempt ended, a first attempt reads the whole thread, and a continuation is also told what its ledger records of the attempts before it (tier, outcome, reason). Neither the criteria nor the configured checks change. One attempt is run per configured `escalation` tier, in order, inside the same claim; a failed attempt climbs to the next tier, and only when the ladder is spent does the issue end in the review status. An attempted issue with no pointer, a pointer this machine cannot resolve, and an issue carrying two pointers are **refused**: one comment naming the reason, the issue moved to the review status, and nothing claimed and nothing run. So are a pointer that is not a generated workspace id, a pointer whose workspace or ledger resolves out of `<workDir>/workspaces` through a junction or symbolic link (the refusal names the link and says to move the workspace's real directory back onto the layout's path), a workspace whose ledger records another item, site, or repository, a workspace whose ledger records no item identity, and a workspace whose ledger is not one this harness wrote (an unsupported version, a partially written identity, or an attempt entry of the wrong shape — an end that is not a timestamp this harness writes included; the refusal names the file and the field): the comment names the reason and, for a legacy ledger, the manual repair — add the ledger's `sourceItem` (`type`, `scope`, `id`, `key`, from the workspace's first attempt report, whose `sourceRef` records them) and scan again; nothing adopts or migrates a workspace by itself. A workspace is looked for at `<workDir>/workspaces/<workspaceId>` and nowhere else: a `workDir` written before this increment is upgraded by hand, and the ledger there, not the path an older report records, says where the clone is. To deliberately start over instead — a first attempt in a new workspace — either create a new task, or stop the watcher, inspect/stop prior processes, retain prior artifacts, remove the pointer label if the issue carries one, remove only the printed receipt file for the issue, and restore the issue to its ready status. Never clear the entire `.intake` directory to fix one task. Inspect a leftover lock and stop its owner before manually removing it; a stale-looking timestamp is insufficient. [docs/implement-workspace-continuation.md](implement-workspace-continuation.md) is the contract, including the upgrade steps and a note on the defects that are still separate tasks.

### Operator setup

1. In Atlassian Administration, create/select a service account and grant it Jira app access. Add it to the queue project/space with a role that can browse work items, transition them, and add comments. Then create an **API token** credential, choose Jira scopes `read:jira-work` and `write:jira-work`, pick an expiry, and copy the token when shown. Service-account tokens cannot be recovered later. [W1]
2. Store the token in the environment variable named by `tokenEnv` (default `JIRA_API_TOKEN`). For the current PowerShell session without putting the token literal in command history:

```powershell
$secure = Read-Host "Jira service-account API token" -AsSecureString
$env:JIRA_API_TOKEN = [System.Net.NetworkCredential]::new("", $secure).Password
Remove-Variable secure
```

To persist it as a **Windows user environment variable** for future terminals:

```powershell
$secure = Read-Host "Jira service-account API token" -AsSecureString
$token = [System.Net.NetworkCredential]::new("", $secure).Password
[Environment]::SetEnvironmentVariable("JIRA_API_TOKEN", $token, "User")
$env:JIRA_API_TOKEN = $token
Remove-Variable secure, token
```

This persists the value for future terminals and also sets it in the current PowerShell process. The value is persistent but not an encrypted secret vault; processes running as the same user may be able to read it. [W7]

3. Copy your current config to `harness.jira.config.json`, preserve its effective agent and project commands, and add the `source` object above. Keep `cloudId` and `siteUrl`; only the token value stays outside JSON. A launch that should give its turns the four research capabilities — GitHub for reading, the OpenAI Docs MCP server, Context7, and Tavily — selects a native Codex profile layer instead of a personal one; [nexus-agent-tools.md](nexus-agent-tools.md) is the profile files, the launch-prefix change, the optional private credentials, and the new-session smoke procedure.
4. Run static validation, then `source list`. Inspect the queue before the first `source run --limit 1`. Start watch only after that run and Jira feedback have been checked.
5. Keep the watch process running to receive further work. This increment does not install a service or configure machine startup.

The connector must remove `tokenEnv` from child environments used for Codex/setup/checks. Do not mutate global `process.env`. This is secret-hygiene, not an OS-level sandbox.

On this site's current test issue, `SAM1-11`, Rovo readback on 2026-09-16 confirmed `To Do`, labels `harness-task`/`harness-test`, a supported acceptance-criteria section, and available transitions targeting `In Progress` and `In Review`. This is an observation about that issue, not a guarantee for other workflows or the new API token. No issue was modified while preparing these docs.

The earlier smoke task's shell substitution does not prove the exact trailing newline. For supervised review, check exact bytes with Node, separately from the baseline check configuration:

```sh
node -e "const fs = require('node:fs'); const actual = fs.readFileSync('HARNESS_SMOKE_TEST.md'); const expected = Buffer.from('jira-harness-smoke-test\n', 'utf8'); if (!actual.equals(expected)) process.exit(1);"
```

Run this in the resulting retained workspace and also inspect its complete tracked/untracked diff. Do not add an assertion requiring a not-yet-created file to baseline checks, and do not count a receipt, agent summary, or generic test pass alone as proof of smoke-task completion.

## 8. Delivery — optional GitHub pull requests

Delivery is off unless the configuration asks for it: a source run then ends with its retained working copy and its local report, and nothing leaves the machine. To have a **passed** attempt delivered, add one strict optional object:

```json
{
  "delivery": {
    "type": "github",
    "repository": "owner/name",
    "baseBranch": "main"
  }
}
```

| Field | Contract |
| --- | --- |
| `type` | Required, exactly `"github"`. Git pushes the branch; `gh` finds, creates, or updates the pull request. Another type is rejected rather than accepted as a placeholder. |
| `repository` | Required destination on github.com as `owner/name`. No host, URL, or path: the branch is pushed to `https://github.com/<repository>.git`. |
| `baseBranch` | Required branch a delivered pull request targets, for example `main`. Nonblank, without whitespace, and not starting with `-`, so it stays one literal argument. |

It applies to a source command's attempts, and to nothing else. A `run --task` invocation creates a fresh clone and branch every time, so it has no stable branch to deliver and stays local even when the field is present; `source list` never delivers because it never runs anything. The rest of the configuration — repository, setup, checks, agent — is unchanged: delivery decides only where a passed attempt's own branch goes.

### What a delivery does

The step runs after an attempt passed, in that attempt's retained workspace, and before the attempt's result is published:

1. A working copy that still holds uncommitted work — staged, unstaged, or untracked — is refused, before anything is pushed. Nothing is committed, stashed, or discarded for the turn: the message names the paths, and finishing that delivery is an operator step — commit or remove them in the retained workspace, then push the branch and open or update the pull request by hand.
2. A branch with no commit beyond the workspace's recorded base is not delivered; a passed attempt that changed nothing has nothing to publish. Its result is still reported as the ordinary passed result it is, without a pull request link.
3. Otherwise the branch is pushed to `https://github.com/<repository>.git` exactly as it is — never with force.
4. The pull request is found in that repository by head branch and base branch, whatever its state, and its native state decides what happens. Exactly one **open** match is updated; with no match at all, one is created; two or more open matches are refused as ambiguous; and a match that is `CLOSED` or `MERGED` is refused too — the harness never reopens one or edits one back into looking current, so an attempt is never reported as delivered when no open review received its work. Both a created and an updated pull request get the same title and body: the item's reference and URL, the task, the actual check summary, and the run ID. GitHub is the record — there is no local delivery state to reconcile.
5. The result comment the issue receives then carries `Pull request: <url>`.

Delivery never merges a pull request and never marks an issue `Done`. It writes the pull request body to `<runDir>/logs/delivery-pull-request-body.md` and keeps every command's output in the same logs directory (`delivery-*.stdout.log`, `delivery-*.stderr.log`), so what was published is reviewable beside the run's other evidence. Each delivery command is bounded; an over-long one is stopped like any other harness command.

### Operator setup

1. `gh` must be on `PATH` and authenticated as an account that may write to the destination repository: `gh auth status` reports both. Git has to be able to use those credentials; `gh auth setup-git` configures the credential helper for github.com. The harness stores no GitHub credential, runs no login flow, and never writes global Git configuration.
2. Set `repository` and `baseBranch` in the configuration. `check-config` prints the effective `delivery` selection before anything runs.
3. A run that failed or was cancelled is never delivered, and a configuration without `delivery` keeps today's local-only behavior.

The delivery commands inherit the same environment a coding turn does, which is the operator's own without the Jira credential variable; they run with the operator's own account and privileges.

### When delivery fails

A delivery failure is a publishing failure, not a coding one. The run keeps its own evidence — `result.json`, the logs, and the check results are not rewritten, and the run is not repeated — and the issue is still told the outcome the run produced, with the delivery failure beside it, and moved to review when Jira is reachable; if Jira itself fails, the report, logs, and receipt stay exactly as they were written. The receipt records `delivery: <what failed>`, intake stops for a human, and the terminal message names the cause and where the command output is.

Retrying the publication is an operator step with ordinary `git` and `gh` and the artifacts the run already wrote — there is no delivery command to replay, no retry service, and no coding turn:

1. Check the destination **before** retrying anything: a push, or a pull request creation or edit, that reported a failure may already have taken effect. `gh pr list --repo <repository> --head <branch> --base <baseBranch> --state all`, or the repository's own page, answers that.
2. An open pull request that is already there does not by itself prove this attempt was delivered: a failed push leaves it pointing at an older commit, and a failed edit leaves its title and body stale. Compare the retained branch's tip with the pull request's head — `git rev-parse refs/heads/<branch>` reads the retained branch, and the pull request page or `gh pr view <url> --json headRefOid` names the head it really has — and check its title and body against what this run wrote. Push the branch when the head is stale, and update the title or body with `gh pr edit` when either is stale, before declaring publication complete.
3. If no open pull request matches, push the retained workspace's branch by hand and open one with `gh pr create --repo <repository> --head <branch> --base <baseBranch> --title "<task id: title>" --body-file <runDir>/logs/delivery-pull-request-body.md`. That body file is written only after the status, count, push, and list commands have all succeeded, so an early failure can leave it absent: use it when it is there, and when it is not, write a short body by hand from the task that ran, its Jira reference and URL, the run ID, and the result and check evidence the run already wrote. Never state a result the run did not produce.
4. A `CLOSED` or `MERGED` match is not edited: reopen it by hand if the review should continue, or open a new pull request from the same branch.

Returning the issue to the ready status is **code rework**, not a delivery retry: it starts a new coding run in the same workspace. A later attempt's delivery still finds the open pull request and updates it instead of creating a second.

## 9. Review-to-completion — optional, inside `delivery`

Completion is off unless `delivery` carries it. With it, the harness carries an In Review item's delivered pull request the rest of the way — once the Nexus Lens reviewer has approved it — and marks the item Done only after GitHub really merged that reviewed head and every configured post-merge workflow on the base branch succeeded. Without it, nothing about §8 changes: the pull request waits for a person.

```json
{
  "delivery": {
    "type": "github",
    "repository": "owner/name",
    "baseBranch": "main",
    "completion": {
      "lensApp": "nexus-lens",
      "lensCheckName": "Nexus Lens",
      "reviewerTokenEnv": "NEXUS_LENS_TOKEN",
      "postMergeWorkflows": ["ci.yml"],
      "toDoStatus": "To Do",
      "doneStatus": "Done"

## 9. Review — optional Nexus Lens reviews

Review is off unless the configuration asks for it. With a strict `review` object, the
`review scan` and `review watch` commands read the tickets the **same Jira connection** the
`source` object describes reports as being in review, find each ticket's open pull request in one
operator-configured repository, ask an explicitly configured reviewer launch for a verdict, and
publish that verdict as one native GitHub review plus one app-owned check run. Without the object
nothing changes: no command reads a GitHub App key, contacts GitHub as an App, or starts a
reviewer turn, and `run`, `source`, and `check-config` behave exactly as they did.

Review is not intake and not delivery. It never claims a ticket, never moves one, never posts a
Jira comment, never runs a coding turn, never commits, pushes, merges, or marks anything Done, and
keeps no database or registry: the native review pinned to a commit is the record that one head
was reviewed.

```json
{
  "review": {
    "type": "github",
    "repository": "saintiago/nexus-harness",
    "app": {
      "appId": 5001141,
      "installationId": 163007360,
      "privateKeyPathEnv": "NEXUS_LENS_PRIVATE_KEY_PATH",
      "login": "nexus-lens[bot]"
    },
    "reviewer": {
      "runtime": "codex",
      "command": ["codex", "--profile", "nexus-astra", "--model", "gpt-6-astra"]
    }
  }
}
```

| Field | Contract |
| --- | --- |
| `lensApp` | Required. The login GitHub attributes the pull request review to. A review from anyone else is not that reviewer's verdict. |
| `lensReviewContext` | Optional nonblank review context, default `"nexus-lens"`. The gate needs a completed review of this reviewer's on the current head; an approval of another commit is not one. |
| `lensCheckName` | Required. The app-owned check the approval has to be backed by on the same head, for example `"Nexus Lens"`. |
| `reviewerTokenEnv` | Required environment-variable name holding the **reviewer's own** credential, for example `"NEXUS_LENS_TOKEN"`. It is deliberately not the operator's Git/`gh` credential: the reviewer's token reads the reviewer's verdict and never enables auto-merge, and the operator's credential never reaches the reviewer. The value is never a configuration field. |
| `postMergeWorkflows` | Required nonempty array. Each entry is a stable workflow file (`"ci.yml"` or `".github/workflows/ci.yml"`) or a numeric workflow ID. An empty or missing list is refused: it is not evidence that CI passed. |
| `toDoStatus` | Required status a definitively failed outcome returns the item to (default intent `"To Do"`). It must differ from the review status and from `doneStatus`. |
| `doneStatus` | Required status a verified completion moves the item to (default intent `"Done"`). Reached only after the merge and every configured post-merge workflow succeeded. |
| `pollIntervalSeconds` | Optional integer at least 5, default 30. Delay between two reads of GitHub's merge and workflow state. |
| `deadlineSeconds` | Optional integer at least 5, default 1800. How long one item may stay pending in one pass before an attention comment is posted and the item is left In Review. |

### What the completion path does

After a `source run` batch, and after each `source watch` scan, one bounded pass reads the configured queue's In Review items. For each one it re-reads the item, takes the single workspace pointer it carries, and looks up the one **open** pull request for that workspace's branch, the configured repository, and the configured base branch. A pass never claims an item, never changes what the batch itself did, and never starts a coding turn.

1. **The reviewer gate.** It requires a completed `APPROVE` review by `lensApp` on the pull request's **current head**, and a successful `lensCheckName` check on that same head. The head is re-read immediately before every mutation. A current-head `REQUEST_CHANGES` decision, or a failed configured Lens check on that head, is a finding: one concise comment naming the review link or the failed check, and the item returns to `toDoStatus` with its workspace pointer preserved, so the ordinary source consumer can take the next repair attempt in the same workspace.
2. **Arming.** With the operator's own `gh` credential the harness runs `gh pr merge <url> --auto --squash`. That is a per-pull-request request to enable **native** auto-merge, not a merge: GitHub enforces branch protection and every required check and performs the merge itself. A conflict, a branch-protection refusal, or an authentication/permission failure is reported as an operator problem and the item stays In Review — those are not established coding findings.
3. **The merge.** The harness waits, bounded by `pollIntervalSeconds` and `deadlineSeconds`, until GitHub reports that exact pull request merged, with the approved head as its source, the configured base branch, and a merge commit SHA. An armed request, pending pull request checks, a closed pull request, or an absent branch is not a merge. A definitive failed required pull request check is a finding (one comment naming the check and linking its evidence, then back to `toDoStatus`); a mergeability or infrastructure problem stays In Review.
4. **Post-merge CI.** Every configured workflow must have a run for event `push`, on the configured base branch, for that exact merge commit SHA, and the **latest attempt** must be `completed`/`success`. A run that has not appeared, or is queued or in progress, is pending and waits. A failed, cancelled, timed-out, action-required, stale, skipped, or neutral latest result is a definitive unsuccessful outcome: one comment naming each unsuccessful workflow, its conclusion, and its links, and the item returns to `toDoStatus`. The merge is never rolled back. If the deadline expires with work still pending, the harness posts one attention comment and leaves the item In Review — no failure conclusion was observed.
5. **Completion.** Only after the verified merge and every configured post-merge workflow succeeded does the harness post one evidence-based resolution comment of at most 120 words — what changed or what the investigation concluded, the successful post-merge main workflow, any material limitation, and the pull request and workflow links — and then move the item to `doneStatus` through native transition discovery.

### Recovery, and what is not merged

There is no completion state to reconcile: GitHub's merged state and the configured post-merge runs are authoritative, and the item's own Jira thread is the record of what was already written. A comment carries a marker, so a repeated pass or a restart finds the comment it already wrote instead of writing a second one; a status move is made only while the item is really still in review. After a restart, a merge confirmed but with post-merge CI absent, pending, or unsuccessful keeps waiting or reports attention without a duplicate comment; if the comment exists but the status move did not arrive, only the transition is retried after re-reading Jira. An item that a person moved out of In Review is not touched. A comment or transition failure never starts an agent: returning an item to `toDoStatus` merely makes the normal source consumer eligible to take the next repair attempt.

Nothing in this path merges, force-pushes, reruns a workflow, or bypasses protection. The harness never gives the reviewer the operator credential, never lets the reviewer's token arm anything, and never treats an approval, an armed request, or a green run on another commit as evidence of this merge.

### Operator setup

1. `gh` must be authenticated as the **operator** account that may enable auto-merge on the destination repository (the same account §8 already uses), and branch protection must require the checks you mean to gate on.
2. Put the **Nexus Lens reviewer's** own credential in the environment variable `reviewerTokenEnv` names. It must be a different credential from the operator's: the reviewer's token only reads the reviewer's verdict, and the operator's is what asks GitHub for auto-merge. Neither is written to the configuration, a report, or a log.
3. Name at least one post-merge workflow that really runs for `push` on the base branch, for example `"ci.yml"` for this repository's own gate.
4. `check-config` prints the effective `delivery` line before anything runs; the completion object is validated with it.

### Fields

| Field | Meaning and validation |
| --- | --- |
| `type` | Required, exactly `"github"`. Another type is rejected rather than accepted as a placeholder. |
| `repository` | Required destination on github.com as `owner/name`. No host, URL, or path. This is the repository whose pull requests are reviewed; it is independent of `delivery.repository`. |
| `app.appId` | Required positive integer: the GitHub App whose installation publishes the review and the check run, and the JWT issuer the installation token is minted for. |
| `app.installationId` | Required positive integer: that App's installation on this repository. |
| `app.privateKeyPathEnv` | Required environment-variable name. The variable holds the **path** of the App's PEM private key. The key's contents are never a configuration value, never a task field, and never logged. |
| `app.login` | Required nonblank login the installation's reviews are authored as, for example `nexus-lens[bot]`. A completed review by this login pinned to the current head is what makes a head reviewed. |
| `reviewer` | Required strict `{ "runtime", "command" }` object, exactly like `agent` in §1 and resolved by the same path rules. It is the explicit reviewer profile: a review never runs the coding tier that implemented the ticket. |
| `checkName` | Optional nonblank name, default `"Nexus Lens review"`. The app-owned check run published on the reviewed head, and the name a branch rule can require from this App. |

The Jira connection itself is not repeated here: the scan uses `source.siteUrl`, `cloudId`,
`projectKey`, `issueType`, `label`, `reviewStatus`, `pollIntervalSeconds`, and `tokenEnv`. A
configuration with `review` and no `source` is rejected.

### Commands

```sh
# Static: validates the review object too. No credential, no network.
npm start -- check-config --config harness.jira.config.json

# One finite pass over the tickets in the configured review status.
npm start -- review scan --config harness.jira.config.json

# One pass, then poll with the source's configured interval until stopped (Ctrl+C).
npm start -- review watch --config harness.jira.config.json

# Bound the paid reviewer turns one pass starts.
npm start -- review scan --config harness.jira.config.json --limit 1
```

`review` takes `--config`; it never takes `--repo`, because a review works from GitHub's own record
of the pull request and never needs a local clone. `--limit` belongs to
`review scan` alone and counts reviewer turns, not tickets: a ticket whose head was already
reviewed costs nothing. `review watch` exits `130` on Ctrl+C after the active reviewer turn and
the current ticket are finished; evidence already written is kept.

### What is eligible, and what a scan does

The queue is the configured project, issue type, and label in the `source`'s **review status**
(default `In Review`). For each eligible ticket:

1. The ticket's own local intake receipt is read when this output directory has one. A review
   approves work, so a receipt whose last recorded attempt ended `failed` or `cancelled`, or one
   that records a reservation with no finished attempt, is **reported for coordinator attention**
   and reviewed no further: a pull request that predates the failure is not the successful code a
   review would approve. A ticket this machine never attempted has no receipt and is reviewed from
   its pull request alone; a receipt that cannot be read is reported rather than ignored.
2. The ticket is re-read and mapped exactly as intake maps it, so the reviewer is given the
   ticket's own description and acceptance criteria. Its pointer labels are read from that same
   read, never from the search result.
3. A review needs one clearly identified pull request. Exactly one valid
   `harness-ws-<workspaceId>` pointer label names the workspace whose branch the delivery step
   pushed, and exactly one open pull request in `repository` must have the head branch
   `harness/<workspaceId>`. No pointer, a pointer that is not a generated workspace id, two
   pointers, no open pull request, and more than one match are all **reported for coordinator
   attention**: nothing is reviewed, nothing is published, and the ticket stays where it is.
4. A head whose current commit already carries a completed review by `app.login` whose
   `commit_id` is that head — state `APPROVED` or `CHANGES_REQUESTED` — is not reviewed again, and
   no reviewer turn is started. A later commit is a new head and is reviewed again; a stale
   verdict can never approve it. If such a review exists but the app-owned `checkName` check run
   for that head does not, the scan publishes the check from the latest review's own state and
   starts no turn. It also updates the newest app-owned check in place if its conclusion
   contradicts that verdict, so an older success cannot mask a later request for changes. Native
   review/check lists that hit their bounds are refused. The ticket and head are revalidated before
   reconciliation: the check is a projection of the native review, never a second decision.
5. Otherwise the scan reads the evidence the reviewer is given: the pull request's changed files
   and their patches, root and ancestor-directory `AGENTS.md` files at the reviewed head, the
   head's check runs, and its combined commit status. A changed-file list that reaches the
   bounded pagination limit (three full pages of 100 files) is treated as incomplete: no
   reviewer turn starts and no review or check is published. The coordinator must arrange a
   complete review or split the pull request into smaller changes. Missing patches (including
   binary files), patches whose addition/deletion counts disagree with GitHub, a diff exceeding
   120,000 characters, instructions exceeding 30,000 characters or 100 content paths, and a ticket
   description exceeding 8,000 characters are also refused before a reviewer turn. Unreadable
   instruction content is an evidence failure, not evidence that no instructions exist.
6. The `reviewer` launch runs as **one bounded turn** in its own evidence directory under
   `<workDir>/reviews/<reviewId>/`, with the same adapter, the same non-interactive launch, and
   the same task timeout a run gets. Review turns add `codex exec --skip-git-repo-check` because
   the evidence directory is not a Git repository; coding turns keep the repository check.
   It is instructed to review only: it must not change files,
   implement fixes, commit, push, merge, or edit the ticket or the pull request, and it must write
   one `verdict.json` (a `verdict` of `approve`, `request_changes`, or `inconclusive`, a summary,
   and a findings array). Findings are blocking; approval requires an empty findings array and
   sufficient evidence. The reviewer must select `inconclusive` when material code/test context
   or tools are unavailable, explaining what the coordinator needs to provide in its summary.
   A turn that fails, is stopped, or writes no usable verdict is also **inconclusive**: nothing is
   published for it, and no coding repair is started.
7. Before anything is published, the pull request is re-read and must still be open at the
   reviewed head, and the ticket is re-read and must still be in the configured review status. A
   head that moved, a closed pull request, or a ticket that left review publishes nothing: the
   result is stale, and a later scan reviews the new head.
8. The verdict becomes one native review — `APPROVE` for an approved verdict, `REQUEST_CHANGES`
   otherwise — pinned to the reviewed commit with `commit_id` and carrying the ticket reference
   and URL, the summary, and any finding the diff could not position. Findings whose file and line
   the pull request's own patch shows are published as native inline comments.
   `REQUEST_CHANGES` requires at least one finding; an approval is published only when the
   reviewer completed with a usable verdict.
9. One app-owned check run named `checkName` is then published on the same head: conclusion
   `success` only for an approved verdict, `failure` for a requested change. If the review is
   published but the check is not, that is reported; a later scan reads the completed review and
   publishes the missing check or updates a contradictory one. A partial publication is reported
   honestly: the native review may already exist even when its check write failed.

Every outcome is printed and appended to `<workDir>/reviews/review.log`, and every reviewer turn
keeps its evidence beside its verdict: `input.md` (what the reviewer was given), `reviewer.log`
(its own output), `verdict.json`, and `review.json` (the outcome, the review and check URLs, and
any problem). A ticket the scan could not review is left in the review status with no review, no
check, and no approval; the coordinator decides what happens next. A missing credential, an
unavailable tool, an API failure, and incomplete evidence are reported exactly as such, never as
an approval and never as a reason to start a coding turn.

CI status stays a separate merge requirement: a review verdict does not depend on CI being green,
and an approved check run does not mean CI passed.

### The merge signal, and what stays outside

The branch rule for the destination should require **both** the configured CI check and the
app-owned `checkName` check **from this App**. A generic "one approving review" rule does not
identify the App and is not the signal this increment provides: GitHub's rules can require a check
run by app, and the app-owned check published on the reviewed head is what makes Lens's approval
specifically enforceable. An `APPROVE` review is still published, because it is the human-readable
record of the decision.

Enabling auto-merge, verifying the merge outcome, marking an issue `Done` only after confirmed
integration, and returning code changes, CI failures, and conflicts to the ready status are the
coordinator's decisions and are **outside this increment**. A pending CI run, or an infrastructure
or authentication failure, stays in review for diagnosis rather than triggering code repair.

### Operator setup

1. Create the GitHub App (the installation this repository uses is `nexus-lens`, app id
   `5001141`), grant it **pull requests: write**, **checks: write**, and read access to contents,
   commit statuses, and metadata, and install it on the destination repository (installation
   `163007360` under `saintiago`). Generate a private key and save the PEM somewhere only this
   machine's operator account can read.
2. Store the **path** of that PEM in the environment variable the configuration names — for this
   installation, `NEXUS_LENS_PRIVATE_KEY_PATH` — and never in the JSON:

```powershell
[Environment]::SetEnvironmentVariable("NEXUS_LENS_PRIVATE_KEY_PATH", "C:\keys\nexus-lens.pem", "User")
$env:NEXUS_LENS_PRIVATE_KEY_PATH = "C:\keys\nexus-lens.pem"
```

3. Keep the reviewer profile explicit. For this installation that is the Astra profile — the
   native `nexus-astra` layer with `gpt-6-astra` at high reasoning effort — selected by the
   `reviewer.command` prefix above. The harness never writes or reads that profile
   ([nexus-agent-tools.md](nexus-agent-tools.md)).
4. Add the destination's branch rule: require the CI check and the `checkName` check from the App,
   exactly as the merge-signal section describes.
5. `check-config --config ...` is static and resolves no credential; then run
   `review scan --limit 1` and inspect the review it publishes, the check run, and the evidence
   under `<workDir>/reviews/` before letting `review watch` run unattended.
6. Keep the identities separate: reviews and their checks are published by the **App
   installation**, while `delivery` still uses the operator's own `git` and `gh` login. Nothing
   here changes the operator's personal GitHub session. Installation tokens request only the
   configured repository and the permissions listed above; they are cached only in process.

The parent resolves both credentials before starting a reviewer, then removes `source.tokenEnv`
and `review.app.privateKeyPathEnv` from the reviewer process environment. The operator's own
environment and unrelated runtime settings are preserved. This avoids passing the token or the
App key's location to the reviewer; it does not sandbox a process running as the same OS user.

One review scan or watch per repository is the supported arrangement. There is no local lock or
cross-machine coordination; native review metadata deduplicates successive scans, not concurrent
reviewers. GitHub cannot atomically compare the current head and submit a review; `commit_id` and
the check's head SHA pin every publication to the reviewed commit even if the head moves after
the final read. Operators must verify the corrected path with a live App review and gate check;
offline tests do not establish native approval eligibility, auto-merge, or useful review quality.

## External references

The supplied docs define the retained coding harness. The references below support only the new Jira API/authentication details, verified 2026-09-16.

[W1]: https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/
[W2]: https://support.atlassian.com/atlassian-cloud/kb/401-unauthorized-error-when-service-account-accesses-jira-or-confluence-api/
[W3]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
[W4]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
[W5]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
[W6]: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/

[W7]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables
