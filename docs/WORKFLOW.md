# Workflow and inputs

This is a human-readable reference, **not runtime configuration**. The application reads ordinary JSON. There is no Markdown front-matter parser, custom workflow language, harness profile registry, or provider configuration parser.

**Completion exception:** the no-merge/no-Done defaults below are superseded only by the explicitly configured path in §10. The review commands themselves remain read/review-only.

## 1. Configuration

Configuration is **two files**, and each field has exactly one owner. One Nexus-wide harness configuration says how this instance runs work; one project configuration, at a connected repository's root, says what that repository is. Every command is given both: `--config` names the harness configuration, and the connected project is named by `--repo` (the commands that clone from a checkout — `run`, `source run`, `source watch`, `queue run`, `queue watch`) or by `--project` (the commands that only read that project's configuration — `check-config`, `source list`, `review scan`, `review watch`). A command runs on what the two compose.

The practical sequence for connecting one project to an already installed runtime — the single file it commits, the project-side checks it must satisfy, and the `check-config`, `source list`, `queue run` order — is [connect-a-project.md](connect-a-project.md). That guide keeps installation-wide setup with the operator and links back here rather than restating the field contracts below.

The Nexus-wide harness configuration:

```json
{
  "workDir": "../nexus-runs",
  "maxRepairs": 2,
  "taskTimeoutMinutes": 60,
  "commandTimeoutMinutes": 10,
  "agent": {
    "runtime": "codex",
    "command": ["codex", "--profile", "nexus-flash", "--model", "deepseek-flash"]
  },
  "escalation": [
    { "name": "flash", "maxRepairs": 2 },
    {
      "name": "astra",
      "agent": {
        "runtime": "codex",
        "command": ["codex", "--profile", "nexus-astra", "--model", "gpt-6-astra"]
      },
      "maxRepairs": 2
    }
  ],
  "reviewer": {
    "app": {
      "appId": 5001141,
      "installationId": 163007360,
      "privateKeyPathEnv": "NEXUS_LENS_PRIVATE_KEY_PATH",
      "login": "nexus-lens[bot]"
    },
    "reviewer": {
      "runtime": "codex",
      "command": ["codex", "--profile", "nexus-astra", "--model", "gpt-6-astra"]
    },
    "checkName": "Nexus Lens review"
  },
  "completion": {
    "lensApp": "nexus-lens[bot]",
    "lensAppId": 5001141,
    "lensCheckName": "Nexus Lens review",
    "reviewerTokenEnv": "NEXUS_LENS_TOKEN",
    "pollIntervalSeconds": 30,
    "deadlineSeconds": 1800
  },
  "recovery": {
    "agent": {
      "runtime": "codex",
      "command": ["codex", "--profile", "nexus-recovery", "--model", "gpt-6-astra", "-c", "model_reasoning_effort=high"]
    },
    "maxAttempts": 2,
    "notifications": {
      "topicArn": "arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications",
      "email": "saint282@gmail.com",
      "publisher": ["aws", "sns", "publish"]
    }
  }
}
```

One connected repository's project configuration, in that repository's root:

```json
{
  "setup": [["npm", "ci"]],
  "checks": [["npm", "run", "typecheck"], ["npm", "test"]],
  "source": {
    "type": "jira",
    "siteUrl": "https://name.atlassian.net",
    "cloudId": "9337c4da-7d33-4c1d-b03c-db207e537f88",
    "projectKey": "SAM1"
  },
  "delivery": {
    "type": "github",
    "repository": "owner/name",
    "baseBranch": "main",
    "completion": {
      "postMergeWorkflows": ["ci.yml"],
      "toDoStatus": "To Do",
      "doneStatus": "Done"
    }
  }
}
```

`setup` and `checks` are target-project commands, not the harness's own CI pipeline. Edit them for each project; the example assumes an npm project with those scripts. Do not use interactive/watch modes. Both example files are checked in as `docs/nexus.config.example.json` and `docs/nexus.project.example.json`, and a connected repository carries its real one as `nexus.project.json`.

### Ownership and precedence

The two files are **composed, not layered**:

- The harness configuration owns `workDir`, `maxRepairs`, `taskTimeoutMinutes`, `commandTimeoutMinutes`, `agent`, `escalation`, `reviewer`, `completion`, and `recovery`. It names no repository, no Jira connection, and no project command.
- The project configuration owns `setup`, `checks`, `source`, and `delivery`. It carries no launch, no limit, no output directory, and no reviewer identity.
- Every field is required or optional exactly where the tables below say. No field is defaulted from one file into the other, and **nothing is read from the single-file configuration the earlier revisions described**: a file carrying the other file's fields is refused field by field, with where each of them belongs.

What needs both sides is composed in this order, and nothing is guessed:

1. `delivery` is the project's own object, with its `repository` and `baseBranch` exactly as written.
2. `delivery.completion` exists only when the project declares it: the project supplies `postMergeWorkflows`, `toDoStatus`, and `doneStatus`; the harness configuration's `completion` policy supplies the reviewer identity (`lensApp`, `lensAppId`, `lensCheckName`), the credential variable (`reviewerTokenEnv`), and the polling bounds. A project that declares `delivery.completion` while the harness configuration declares no `completion` is refused, with both paths named.
3. `review` is composed from the harness configuration's `reviewer` and the project's `source` and `delivery.repository`: the reviewed repository is the delivered one, because a review reviews what that project delivers. When any of these three inputs is absent, no `review` path is composed. The same harness file can serve local-only, Jira-only, delivery-only, and fully connected projects. `review` and `queue` commands still refuse missing requirements before resolving credentials or claiming work; `run` and `check-config` do not require these optional integrations.
4. `reviewer` and `completion` must name the same Nexus Lens identity — the same App id, login, and check name — when both are present: otherwise the completion gate would require a check the configured reviewer never publishes.
5. `delivery.completion`'s `toDoStatus` and `doneStatus` must differ from each other and from the project's `source.reviewStatus`, because moving an item out of review has to mean something.

Missing, malformed, and mismatched configuration all fail **before anything is claimed or run**, with the file, the field, and — for a cross-file problem — both paths named. `check-config` validates and prints the composition without creating anything.

`workDir` is Nexus-wide storage policy, not the queue boundary: one harness configuration and one `workDir` can serve several connected projects. Each composed project gets its own intake lock under the shared output directory, named by a stable hash of that project's own connection identity — its Jira type, canonical site, cloud ID and project key, and its GitHub destination repository. No credential, local path, or display name takes part, and changing a project's queue tuning (issue type, label, statuses, ordering, poll interval, base branch) does not change the lock it holds. Two consumers of one connected project and `workDir` are refused; two different connected projects may consume their own queues concurrently. [spec.md](spec.md) §6 owns the behavior, and §11 the queue that relies on it.

Before hashing, the cloud UUID and GitHub owner/repository are lowercased and the Jira project key
is uppercased; the Jira site URL is already canonicalized during validation. Equivalent spellings
therefore hold the same lock without rewriting the configured values used by other callers. The
offline regressions cover same-project exclusion (including equivalent spellings) and concurrent
different-project queues. Operators must wait for this change to be integrated before relying on
that boundary; a live concurrent-project exercise remains unverified. A legacy `.intake/lock/`
blocks all project consumers, regardless of its age or owner metadata. Let the old consumer finish,
then inspect and remove its lock by hand; do not interrupt active work or mix old and new consumer
revisions under the same root, since older binaries cannot recognize the new locks.

### Fields

Four harness fields and two project fields are required; the rest are optional, each in the file that owns it. Reject unknown top-level/nested fields and invalid types rather than coercing them, and refuse a field in the other file with where it belongs. Source commands require the project's `source`; ordinary file-task commands do not construct it or require its credentials. A review requires the project's `source` and `delivery`, because it reviews through that same connection the pull request that project delivered. Without `delivery` nothing is pushed or published, whatever else the configuration says.

In the Nexus-wide harness configuration:

| Field | Meaning and validation |
| --- | --- |
| `workDir` | Nonblank output directory. Resolve relative to this file, not the target repo. One `workDir` may serve several connected projects; their queues lock per project, not per output directory. |
| `maxRepairs` | Nonnegative integer; additional coding turns after implementation. |
| `taskTimeoutMinutes` | Positive integer; total run time limit. |
| `commandTimeoutMinutes` | Positive integer; per setup/check command limit, capped by remaining task time. |
| `agent` | Optional strict object with required `runtime` and `command` fields when present. No `null` or partial objects. |
| `escalation` | Optional nonempty array of tiers: `{ "name", "agent"?, "maxRepairs"? }` with distinct names. One tier runs per attempt, in order, inside one claim: every coding cycle — a first claim, and a claim that continues a workspace a reviewer's findings, a failed required check, a delivery failure, or a failed post-merge workflow returned to the ready status — starts at the first tier in the same workspace, and a later tier runs only when the one before it exhausted its own repair allowance on an ordinary red post-agent round. A tier that names no `agent` or `maxRepairs` inherits the top-level one. Absent means a single `default` tier built from `agent` and `maxRepairs` . |
| `reviewer` | Optional strict object defined in section 9: the App installation a review is published as, the reviewer launch, and the check name. No `null`; unsupported values are errors. Absent means no project composes a review path, and no command reads a GitHub App key. |
| `completion` | Optional strict object defined in section 10: the Nexus Lens identity the completion gate requires, the environment variable holding the reviewer's own credential, and the polling interval and deadline. No `null`. Absent means a project's `delivery.completion` has nothing to compose with and is refused. |

In the connected project's configuration:

| Field | Meaning and validation |
| --- | --- |
| `setup` | Array of command argument arrays; may be empty. Run before baseline and before each post-agent check round. |
| `checks` | Nonempty array of command argument arrays; every check is required. |
| `source` | Optional strict Jira object defined in section 5. No `null`; unsupported source types are errors. |
| `delivery` | Optional strict GitHub object defined in section 8: the destination repository and base branch a passed attempt is delivered to, and — optionally — the post-merge workflows and Jira statuses one of its items completes through (section 10). No `null`; unsupported delivery types are errors. Absent means local-only delivery behavior and no review path, even when the harness configuration declares `reviewer`. |

Setup/check commands remain nonempty string arrays with a nonblank executable first. Remaining arguments are literal strings, including intentional empty strings. Never concatenate task text into commands or implicitly interpolate environment variables. Use the tested platform launcher and retain its documented restrictions.

All setup/check commands execute in the retained task working copy. Load both files once before execution. Credential values and coding-provider account setup are not JSON fields. A configuration that names a credential names the environment variable that holds it; it never contains the token, key, or path value itself.

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

A complete DeepSeek harness configuration, beside any connected project's own file, is:

```json
{
  "workDir": "../harness-runs",
  "maxRepairs": 2,
  "taskTimeoutMinutes": 60,
  "commandTimeoutMinutes": 10,
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

The execution part is not configurability: it is the adapter's own fixed suffix. Each turn runs unsandboxed (`--sandbox danger-full-access`) and unattended (`--ask-for-approval never`, so nothing waits for a prompt), because a turn must be able to stage and commit in the retained working copy and the narrower `workspace-write` policy — in its `--sandbox` spelling or its native permission-profile spelling — leaves that copy's Git metadata read-only on Windows, where `git add` fails on `.git/index.lock`. That policy is an explicit, documented choice, not a hidden fallback: the suffix is the same for every turn, and nothing widens after a failure. A turn has the same file and network reach as the harness's own configured `setup` and `checks` commands.

The one turn that is not a coding turn is the pre-delivery baseline diagnosis (§11). It stages nothing and must not change what it inspects, so it runs as `exec --sandbox workspace-write`, started in its own working directory inside the diagnosis's evidence directory, and that launch states the policy's additional writable roots as none and excludes the host's temporary roots from its writable set (the runtime's own `sandbox_workspace_write.writable_roots`, as the empty list, `sandbox_workspace_write.exclude_tmpdir_env_var`, and `.exclude_slash_tmp`): its working directory is the only place the runtime's sandbox lets it write, and the snapshot it inspects and the ticket's retained working copy are outside it however `workDir` is placed and whatever the operator's own configuration would grant instead. That launch's configuration keys do not cover everything a configured launch prefix can carry, so a prefix that names a switch granting a writable root, moving the working root, or naming a policy of its own (`--add-dir`, `--cd`/`-C`, `--worktree`, `-s`/`--sandbox`, `--dangerously-bypass-approvals-and-sandbox`) is refused before the turn starts: no runtime is launched under a grant its own overrides cannot take back, and the refusal reaches the ticket In Review with what a person must do. A diagnostic that tries to write anywhere else is refused by the sandbox rather than trusted, and the harness checks the two trees after the turn as well. No coding turn is ever started from a diagnosis, and nothing widens the diagnostic's policy.

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
npm run dev -- check-config --config nexus.config.json --project ../target-project --task examples/task.json
npm run dev -- run --repo ../target-project --config nexus.config.json --task examples/task.json
```

`check-config` reads the Nexus-wide harness configuration and the connected project's own configuration, composes them, validates JSON, normalizes defaults and documented paths, and reports useful file/field errors — including which file a misplaced field belongs to and what a cross-file mismatch needs. `--task` is optional: omit it to validate the two configuration files only, or supply it to additionally validate a four-field task file. This command creates no directories, runs no executable (including `--version`), reads no native profile/authentication file, resolves no credential values, and contacts neither Jira nor a coding provider. Valid input exits 0; invalid input, unknown options, or file-read errors exit nonzero. No arguments display help.

CLI file paths, `--repo`, and `--project` resolve from the invocation's current directory. `workDir` and a relative path-valued launch executable resolve from the *harness configuration file's* directory, the file that owns them. `run` performs the existing source/output preflight. When the harness targets itself, choose an output directory outside its source. Static validation does not prove Git state, runtime availability, authentication, or execution safety.

Keep the existing exit-code behavior and interrupt handling. Do not add per-task provider options or a public fake runtime.

### Opt-in live verification

Extend the existing verifier to accept a harness configuration path:

```sh
npm run test:live -- --config nexus.config.json
```

The file is the Nexus-wide harness configuration, read on its own: the verifier uses its `agent`, `maxRepairs`, `taskTimeoutMinutes`, and `commandTimeoutMinutes`, and nothing else. Its disposable fixture supplies the repository, output directory, task, and the fixture's own project configuration with its setup and checks; it must not execute the user's configured project commands or target a real project merely because a config was supplied. Require at least one repair allowance for the two-exercise verifier; reject `maxRepairs: 0` before making paid calls instead of increasing it silently.

Without `--config`, preserve the verifier's existing documented defaults, including the ordinary Codex launch. Custom-provider verification must explicitly select its configuration.

Do not require `CODEX_API_KEY`, an OpenAI login, or `auth.json` as universal prerequisites. The live invocation establishes whether the selected runtime's credentials and protocol actually work. Launch failure or missing authentication is a failed/unexecuted live check, never a pass. No automatic login, provider fallback, or paid retry loop.

Keep live tests outside default discovery, `npm test`, `npm run validate`, and CI.

A manual live commit check uses a disposable repository where a real turn commits its work; inspect the retained clone afterwards. It is not part of `npm test`, `npm run validate`, or CI, and it is not evidence until it has been run.

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

A red baseline stops a **fresh attempt** before any coding turn; a **continuation** may start red, because its workspace may already carry committed work the checks reject, and only its post-turn check round decides. A setup/launch/authentication/protocol error, expired timeout, cancellation, or exhausted repair allowance stops the loop and preserves work, fresh or continued. Only ordinary completed red check rounds trigger repair. Checks are rerun by the harness regardless of the agent's claims. The selected agent does not change between turns. Before every coding turn, and before the round that follows it, the checkout is returned to the branch its workspace records: a turn may have committed on a branch of its own, and what the checks judge and a delivery step publishes is the recorded branch's own revision. That return fast-forwards and checks out a clean checkout whose commit descends from the recorded branch, keeping the commit the turn made on the branch it made it on; a detached, divergent, or branchless checkout stops the run before that turn or check, naming both branches and the manual action, and nothing is reset, force-updated, or discarded. A return that would write over a local file the checkout ignores is **refused** with the paths named and the file's bytes kept, and what the checkout and the fast-forward did is read back rather than taken from their exit codes, so a Git configuration that squashed the merge cannot pass for a returned branch. A coding turn is also started only from the workspace's own committed state: a checkout that still holds uncommitted work — on the recorded branch included — stops the run before the agent, naming the branch, the paths, and the manual action, while the round that judges a turn still reads what that turn left, uncommitted work included. See the specification for reporting and safety semantics.

Before every coding turn the harness also prepares the ticket's **conversation history** — the current requirements, the Jira thread, the pull request conversation and the harness's own complete reports — and hands the turn its brief and local paths (§9, "The ticket conversation history"). A run whose task came from a file rather than a source has no such history and behaves exactly as before.

The coding prompt is role-specific and says what this turn is and is not. A passing check is not
the task's completion: the configured checks decide whether the work is judged as passing, and the
acceptance criteria decide whether the task is done, so a turn makes the behavior right rather than
the command quiet. A change to how the project is built or checked belongs to a turn only where the
task explicitly asks for one — a new test, a changed command, new tooling — and the blanket rule
against touching the project's tooling stands everywhere else. The turn verifies its change at the
integration point it affects (the callers that reach it, or the command or test that covers it) and
says how, rather than re-running the project's whole expensive test matrix, which the harness runs
itself after every turn. When the ticket's review has left findings outstanding, the same prompt
asks for one answer per finding identity — cause, affected scope, repair, verification, remaining
uncertainty — in the turn's own summary, and the harness reads those answers out of the complete
developer report it already retains (§9, "The ticket conversation history").

The delivery step is **outside the run**: the run's own report is written first, and only a `passed` attempt is delivered. A delivery failure changes neither the run's status nor its evidence, and it never starts a coding turn (§8). A red baseline never reaches it either: for a fresh source attempt the ending is diagnosed locally first (§11, "The pre-delivery baseline diagnosis"), so an attempt is delivered only after a post-agent round passed every configured setup and check and the ticket's own work is on the recorded branch.

Every working copy is given a **repository-local** Git identity (`Nexus Agent <nexus@local>`, commit signing disabled) before any check or coding turn runs, so a turn can make small local commits as it works; a turn is asked to finish with the work it wants built on committed, because the harness starts no further coding turn from a working copy that still holds uncommitted work. Those commits stay in the retained working copy: the harness itself never merges or integrates a target's changes and, without a configured delivery step, never pushes or publishes them either. A commit is not a check result, and anything a turn leaves uncommitted is kept — the round after the turn judges it, and a delivery step refuses to publish it — but it ends the run there rather than going to another agent. A continued workspace keeps the base commit its ledger recorded as the comparison base, so `changes` in the report is the whole diff against that base, committed and uncommitted parts alike. These settings are written with `git config --local`; the harness never writes global or system Git configuration.

## 5. Source configuration — Jira Cloud

The only implemented source type is `"jira"`. Exactly one source belongs to a project configuration; do not add a `sources` array or accept placeholder types. The source lives with the project that owns the checkout, its commands, and its GitHub destination, so every fetched issue is bound to an explicitly chosen target: the repository `--repo` (or `--project`) names, whose `setup` and `checks` decide its runs. Issues cannot supply paths or executable commands to the harness.

A complete project configuration for the current test queue is:

```json
{
  "setup": [["npm", "ci"]],
  "checks": [["npm", "run", "typecheck"], ["npm", "test"]],
  "source": {
    "type": "jira",
    "siteUrl": "https://malton-family.atlassian.net",
    "cloudId": "9337c4da-7d33-4c1d-b03c-db207e537f88",
    "projectKey": "SAM1",
    "label": "harness-task",
    "ordering": "priority",
    "pollIntervalSeconds": 30
  }
}
```

The `setup`/`checks` commands are this project's own, not universal: edit them for the target repository. The launches, the limits, and the `workDir` stay in the Nexus-wide harness configuration, outside this file, and `workDir` must stay outside the source checkout — especially when the harness targets its own repository.

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
| `ordering` | Optional, exactly `"priority"` (default) or `"rank"`. Which Jira field orders the ready queue: the site's own Priority field, or the board's native Rank so manual board order decides what the next fresh scan offers. Nothing else is accepted — no other value, no null, no coercion — and both modes keep the deterministic tie-breakers. |
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

With `"ordering": "rank"`, the same queue asks Jira for the board's own order instead, and for nothing else:

```jql
ORDER BY Rank ASC, created ASC, key ASC
```

Do not expose arbitrary JQL parsing/composition or a timestamp cursor in this increment. Using a different label is enough to isolate a disposable test queue. The label plus ready status is an explicit authorization to spend agent capacity in the trusted configured repository.

Jira's priority scheme resolves `priority DESC`, so the highest-priority ready issue comes first, with the oldest creation and then the issue key breaking ties. In rank mode the board's native `Rank` is the primary order across the ready issues — an issue's Priority value never outranks it — and creation time and the issue key are the deterministic tie-breakers Jira applies after it. The two orders are never combined, and Rank values are never fetched, read back, or reinterpreted locally: this connector asks for an order, it never computes one.

In both modes Jira does the sorting and the connector keeps the order of the answer across pages, whatever the issue keys would suggest. A Priority or Rank change takes effect on the next fresh scan and never reorders an active ticket, a same-ticket repair continuation, or a batch that was already discovered; the configuration is loaded and frozen once per invocation (docs/architecture.md §8), so a running command keeps the mode it started with and the next invocation's fresh scan reads the new one.

A site that refuses `Rank` (the field is unavailable, the service account may not view it, or the queue's board does not rank the issues) fails the scan with Jira's own bounded error and starts no task. There is no fallback to Priority, no guessed board order, no Jira Agile board API call, and no Rank write: fix the access or set `"ordering": "priority"`, which uses priority ordering.

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
npm run dev -- check-config --config nexus.config.json --project ../target-project

# Read-only preview; contacts Jira, but makes no changes or paid agent calls.
npm run dev -- source list --config nexus.config.json --project ../target-project

# Fetch a finite batch and automatically run at most one new attempt.
npm run dev -- source run --repo ../target-project --config nexus.config.json --limit 1

# Run all currently discovered eligible, valid issues sequentially.
npm run dev -- source run --repo ../target-project --config nexus.config.json

# Scan immediately, then continue polling until Ctrl+C.
npm run dev -- source watch --repo ../target-project --config nexus.config.json
```

`source list` takes `--config` and `--project` only: it reads the connected project's configuration without opening a working copy. `source run` and `source watch` take `--config` and `--repo`, the checkout they clone from and read that project's configuration from. Reject `--task` on every source command. `--limit` is a positive integer accepted only by `source run`, counting the attempts it starts — a first attempt or a continuation — not receipted skips, refusals, or invalid descriptions. Omitting it means the complete finite discovered batch. Watch has no lifetime task limit in this increment.

The source preview prints each issue's disposition, key, title, URL, and one detail line, in the order the configured `ordering` asked Jira for — the preview keeps Jira's answer as it arrived across pages and never re-sorts it, exactly as an attempt's batch does. The dispositions are `valid` (unattempted, and a run would create its workspace), `continuable` (the detail names the workspace ID and the attempt number a run would continue), `refused` (why it will not be acted on: a receipt with no pointer, a fresh ticket whose preferred workspace name is already held, a pointer that is not a usable workspace id, a pointer this machine cannot resolve, a pointer that names another item's, site's, or repository's workspace, a pointer whose workspace or ledger resolves out of the workspaces directory through a junction or symbolic link, a workspace whose ledger records no item identity, or more than one pointer), `invalid` (the task-description problem), and `stale` (no longer eligible when re-read). A continuation's detail carries only that workspace ID and attempt number — the receipt path and its recorded result are not repeated there; a refusal may quote the receipt's own one-line summary in its reason. An existing receipt is read before the item is mapped, and the pointer labels are judged only after the item has been re-read: the decision uses the labels that read observed, never the ones the search result that discovered the issue carried. A fresh claim also checks the name it would use for a new workspace before anything is created: a name already held is refused, never adopted or overwritten. The preview takes no `--repo`, so it cannot check the repository a workspace was cloned from; an attempt checks that before it reserves. An old attempt is not made runnable by an edited description. No directory creation, locks, remote writes, or process launches are allowed in preview. A `source list` under a refused Rank JQL prints Jira's bounded error and exits nonzero; it never lists a Priority-ordered fallback.

`source run` exits 0 for an empty queue or when all new attempts pass and feedback succeeds, with only harmless stale, refused, or still-receipted skips. Invalid task descriptions, failed/cancelled runs, claim/API errors, and failed feedback give a nonzero result; a valid later issue can still run after an ordinary task failure. Fatal integration/local-state/process-cleanup errors stop the batch immediately. Print a compact count/result summary and real artifact/receipt paths, not only a generic success message.

Watch keeps running after handled task failures or invalid descriptions. It stops on fatal configuration/authentication errors, uncertain remote writes, failed feedback, or unsafe process cleanup. Read-only transient failures back off; successful discovery resets the backoff. Print changes and per-batch outcomes, not unchanged issue bodies on every empty poll. Preserve existing interrupt exit-code behavior; do not hide a fatal exit as success.

Normal file-based `run --task ...` remains independent: even with `source` in its config, it must not read Jira credential values, contact Jira, create intake state, or emit remote updates. It never delivers either: a file-task run's clone is fresh every time, so there is no stable branch for §8 to update, and the command stays local even with a `delivery` object present. The opt-in coding runtime verifier also ignores `source` and `delivery`, and must never contact or mutate Jira or GitHub.

### Result status, continuation, and manual retry

For all terminal local outcomes, publish the exact `passed`, `failed`, or `cancelled` outcome and move from running to review when still appropriate. `In Review` does not mean success. `Done` stays a human decision after inspecting and applying the retained changes. A passed attempt delivered by §8 carries its pull request URL in that comment; a passed attempt whose delivery failed carries the run's own outcome with the failure beside it, so the two never leave a finished task sitting in the running status. Nothing else about the comment changes.

While an `escalation` ladder is climbing, the issue stays in the running status: each attempt publishes its own comment ("attempt 2 of 3, tier pro" — the rung's position in this cycle's own ladder), and only the climb's last attempt — a pass, a terminal failure, or the rung that exhausted the ladder — publishes the final result and moves the issue to review. Escalation is local to one coding cycle: every claim starts at the first tier, including a claim that continues the retained workspace an issue carries after a reviewer's findings, a failed required check, a delivery failure, or a failed post-merge workflow returned it to the ready status, and the workspace's own attempt count never selects a tier. Only an exhausted ordinary red check round climbs: a run that ended before any coding turn, a setup/launch/authentication/protocol error, a cancellation, an expired limit, and a stop that was not confirmed each end the intake at the rung where they happened rather than spending a stronger launch on them. That rung's result is then published and moved to review, with two deliberate exceptions that stop intake instead: a run whose stopped executions could not be confirmed to have ended publishes nothing and leaves the issue where it is, and neither does an attempt whose workspace ledger could not be written (see the local-save paragraph below).

A completed red baseline on a fresh workspace from a configured source is the one ending that is diagnosed before it is published: the ladder still climbs nothing from it, but the issue is not told only that its baseline failed. One local reviewer turn over the exact snapshot and the command evidence produces a finding; an actionable one returns the same issue to its ready status with one comment carrying the failing check, the evidence, the likely cause and the repair, so the next claim repairs the baseline before continuing the original task, and a diagnosis with nothing actionable moves it to the review status with the evidence and the required action and stops intake for a person. Nothing else about the ladder, the comments, or the review move changes (§11, "The pre-delivery baseline diagnosis").

A delivery failure is an operator problem, not a coding one: the run's report and logs are kept as they were written, the receipt records `delivery: <what failed>`, the issue is still told the outcome the run produced with the failure beside it, and intake stops. Fix what the failure names — a leftover path, Git credentials, or `gh auth status` — and retry the publication **by hand** in the retained workspace with ordinary `git` and `gh`, checking GitHub first because a failed push or creation may already have taken effect; §8 has the recipe. Moving the issue back to the ready status is not that retry: it starts a new coding run in the same workspace. No coding turn is started to repair a publishing failure.

A required local save that fails is not rounded into a success either: if an attempt cannot be recorded in its workspace's ledger, the run's own report, logs, and working copy are kept as they were written, the receipt records `workspace ledger: <what failed>` with the failed path, and intake stops instead of starting another attempt — the next attempt's number and its guidance come from that ledger (the tier that ran each attempt before it included), so none is started against one that does not hold the attempt. Repair the ledger by hand (the ledger is validated strictly: version 1, and the identity and attempt fields this harness writes), then move the issue back to the ready status to continue the same workspace.

A local receipt prevents a second attempt from starting by accident across polling and restart. Changing the issue does not clear that receipt: the pointer label, not the receipt, decides what happens next. Returning the issue to the ready status with a valid pointer starts another attempt in the same workspace — it does not create a fresh clone or clear the receipt. **Rework happens in the same workspace**: the run that creates a workspace writes the pointer label `harness-ws-<workspaceId>` on the issue once, before any coding turn, and an issue in the ready status whose pointer resolves on this machine is continued — same clone, same recorded base, a new run directory and report, and a baseline round that may be red. Every attempt reads the issue's own thread as context: a continuation reads what was added since the first attempt recorded for that workspace ended, a first attempt reads the whole thread, and a continuation is also told what its ledger records of the attempts before it (tier, outcome, reason). Neither the criteria nor the configured checks change. One attempt is run per configured `escalation` tier, in order, inside the same claim; every claim starts that climb at the first tier again, a later tier runs only when the one before it exhausted its own repair allowance on an ordinary red post-agent round, and only when the ladder is spent does the issue end in the review status. An attempted issue with no pointer, a pointer this machine cannot resolve, and an issue carrying two pointers are **refused**: one comment naming the reason, the issue moved to the review status, and nothing claimed and nothing run. So are a pointer that is not a usable workspace id, a fresh ticket whose preferred workspace name is already held, a pointer whose workspace or ledger resolves out of `<workDir>/workspaces` through a junction or symbolic link (the refusal names the link and says to move the workspace's real directory back onto the layout's path), a workspace whose ledger records another item, site, or repository, a workspace whose ledger records no item identity, and a workspace whose ledger is not one this harness wrote (an unsupported version, a partially written identity, or an attempt entry of the wrong shape — an end that is not a timestamp this harness writes included; the refusal names the file and the field): the comment names the reason and, for a legacy ledger, the manual repair — add the ledger's `sourceItem` (`type`, `scope`, `id`, `key`, from the workspace's first attempt report, whose `sourceRef` records them) and scan again; nothing adopts or migrates a workspace by itself. A workspace is looked for at `<workDir>/workspaces/<workspaceId>` and nowhere else: a `workDir` written before this increment is upgraded by hand, and the ledger there, not the path an older report records, says where the clone is. To deliberately start over instead — a first attempt in a new workspace — either create a new task, or stop the watcher, inspect/stop prior processes, retain prior artifacts, remove the pointer label if the issue carries one, remove only the printed receipt file for the issue, and restore the issue to its ready status. Never clear the entire `.intake` directory to fix one task. Inspect a leftover lock and stop its owner before manually removing it; a stale-looking timestamp is insufficient. [workspace continuation](spec.md#2-what-the-working-version-does) is the contract, including the upgrade steps and a note on the defects that are still separate tasks.

The workspace a first attempt creates is named for the item it came from: a Jira ticket's canonical key (`HARN-23`) when the key can name a directory, and the run's own generated id otherwise, and the pointer label above names the same string. A name something already holds — another item's workspace, a directory or ledger the harness cannot read as this item's, or this item's own workspace with no pointer label — is **refused** with guidance, never adopted, overwritten, or quietly replaced by a different name; a continued attempt keeps the name its pointer fixed, so a later key change renames nothing and rewrites no label.

A coding turn may commit on a branch of its own and leave the checkout there, so the checkout a continuation reopens is read against the branch its ledger records before the claim: a clean checkout whose commit descends from that branch is accepted, and the run fast-forwards the recorded branch to it and checks it out before its first coding turn. A checkout that still holds uncommitted work — on the recorded branch included — a detached one, a divergent one, and one that names no branch the workspace holds are **refused** before anything is claimed, with the branch names, the paths where there are any, and the manual action. Nothing is reset, force-updated, adopted, or discarded, and the commit a turn made stays on the branch it made it on. The return itself refuses to write over an ignored local file, with Git's own paths named and the file's bytes kept, and refuses a result that cannot be read back as the recorded branch at the checkout's commit and clean, so a Git configuration that squashed the fast-forward cannot pass for one that moved the branch; a claimed attempt stops at that point, before the turn or the check it was preparing.

Every API read is bounded by the item deadline; an expired read has a separate ten-second budget for its attention comment. Native APIs do not offer a transaction across GitHub and Jira: both are re-read immediately before writes, and a concurrent human edit during a request remains an external race.

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

3. Keep the Nexus-wide harness configuration in the operator's own file (`--config`), and put the project configuration with the `source` object above in the connected repository's `nexus.project.json`, committed with it. Keep `cloudId` and `siteUrl`; only the token value stays outside JSON. A launch that should give its turns the four research capabilities — GitHub for reading, the OpenAI Docs MCP server, Context7, and Tavily — selects a native Codex profile layer instead of a personal one; [nexus-agent-tools.md](nexus-agent-tools.md) is the profile files, the launch-prefix change, the optional private credentials, and the new-session smoke procedure.
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
2. A working copy left checked out at another revision than the recorded branch's own tip is refused, before anything is pushed. What the checks decided is the working copy as it is checked out, and what would be published is the recorded branch, so a branch left behind is never pushed in place of the validated revision. Nothing is switched, adopted, committed, or force-pushed for the turn; the message names both revisions, and finishing that delivery is an operator step — reconcile the recorded branch with the validated revision by hand, then push it and open or update the pull request by hand. A checkout on an ordinary local branch at the same revision is not a mismatch. The run itself returns a clean checkout to the recorded branch before the checks that judge it (§4) — refusing a return that would write over an ignored local file or that did not really move the branch — so in an ordinary run the two revisions agree; this refusal is the boundary for a checkout that could not be returned, which the run has already stopped on before any check.
3. A branch with no commit beyond the workspace's recorded base is not delivered; a passed attempt that changed nothing has nothing to publish. Its result is still reported as the ordinary passed result it is, without a pull request link.
4. Otherwise the branch is pushed to `https://github.com/<repository>.git` exactly as it is — never with force.
5. The pull request is found in that repository by head branch and base branch, whatever its state, and its native state decides what happens. Exactly one **open** match is updated; with no match at all, one is created; two or more open matches are refused as ambiguous; and a match that is `CLOSED` or `MERGED` is refused too — the harness never reopens one or edits one back into looking current, so an attempt is never reported as delivered when no open review received its work. Both a created and an updated pull request get the same title and body: the item's reference and URL, the task, the actual check summary, and the run ID. GitHub is the record — there is no local delivery state to reconcile.
6. The result comment the issue receives then carries `Pull request: <url>`.

Delivery never merges a pull request and never marks an issue `Done`. It writes the pull request body to `<runDir>/logs/delivery-pull-request-body.md` and keeps every command's output in the same logs directory (`delivery-*.stdout.log`, `delivery-*.stderr.log`), so what was published is reviewable beside the run's other evidence. Each delivery command is bounded; an over-long one is stopped like any other harness command.

Every API read is bounded by the item deadline; an expired read has a separate ten-second budget for its attention comment. Native APIs do not offer a transaction across GitHub and Jira: both are re-read immediately before writes, and a concurrent human edit during a request remains an external race.

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

## 9. Review — optional Nexus Lens reviews

Review is off unless the harness configuration asks for it. With a strict Nexus-wide `reviewer`
object, the `review scan` and `review watch` commands read the tickets the connected project's
**Jira connection** reports as being in review, find each ticket's open pull request in that
project's own `delivery.repository`, ask the explicitly configured reviewer launch for a verdict,
and publish that verdict as one native GitHub review plus one app-owned check run. Without the
object nothing changes: no command reads a GitHub App key, contacts GitHub as an App, or starts a
reviewer turn, and `run`, `source`, and `check-config` behave exactly as they did.

Review is not intake and not delivery. It never claims a ticket, never moves one, never posts a
Jira comment, never runs a coding turn, never commits, pushes, merges, or marks anything Done, and
keeps no database or registry: the native review pinned to a commit is the record that one head
was reviewed. Instead of an assembled patch, the reviewer inspects a local repository view pinned
at the reviewed head, cloned from the ticket's own retained workspace under the configured
`workDir`: the view is read-only evidence, no App credential reaches it, and the scan refuses to
publish a verdict for a view that is missing, cannot be pinned at the head, or was changed.

```json
{
  "reviewer": {
    "app": {
      "appId": 5001141,
      "installationId": 163007360,
      "privateKeyPathEnv": "NEXUS_LENS_PRIVATE_KEY_PATH",
      "login": "nexus-lens[bot]"
    },
    "reviewer": {
      "runtime": "codex",
      "command": ["codex", "--profile", "nexus-astra", "--model", "gpt-6-astra"]
    },
    "checkName": "Nexus Lens review"
  }
}
```

That object belongs to the harness configuration. Which repository is reviewed is not repeated
here, because it is decided by the project: the scan reviews the repository the ticket's own
project delivers to (its `delivery.repository`), through the Jira connection that project's
`source` describes.

### Fields

| Field | Meaning and validation |
| --- | --- |
| `app.appId` | Required positive integer: the GitHub App whose installation publishes the review and the check run, and the JWT issuer the installation token is minted for. |
| `app.installationId` | Required positive integer: that App's installation on this repository. |
| `app.privateKeyPathEnv` | Required environment-variable name. The variable holds the **path** of the App's PEM private key. The key's contents are never a configuration value, never a task field, and never logged. |
| `app.login` | Required nonblank login the installation's reviews are authored as, for example `nexus-lens[bot]`. A completed review by this login pinned to the current head is what makes a head reviewed. |
| `reviewer` | Required strict `{ "runtime", "command" }` object, exactly like `agent` in §1 and resolved by the same path rules. It is the explicit reviewer profile: a review never runs the coding tier that implemented the ticket. |
| `checkName` | Optional nonblank name, default `"Nexus Lens review"`. The app-owned check run published on the reviewed head, and the name a branch rule can require from this App. |

The Jira connection itself is not repeated here: the scan uses the project's `source.siteUrl`,
`cloudId`, `projectKey`, `issueType`, `label`, `reviewStatus`, `pollIntervalSeconds`, and
`tokenEnv`, and the reviewed repository is that project's `delivery.repository`. A harness
configuration that declares `reviewer` used with a project that declares no `source` or no
`delivery` is rejected before any credential is resolved, with both paths and the field named.

### Commands

```sh
# Static: validates the reviewer and the project it composes with. No credential, no network.
npm start -- check-config --config nexus.config.json --project ../target-project

# One finite pass over the tickets in the configured review status.
npm start -- review scan --config nexus.config.json --project ../target-project

# One pass, then poll with the source's configured interval until stopped (Ctrl+C).
npm start -- review watch --config nexus.config.json --project ../target-project

# Bound the paid reviewer turns one pass starts.
npm start -- review scan --config nexus.config.json --project ../target-project --limit 1
```

`review` takes `--config` and `--project`; it never takes `--repo`, because the pull request is
read from GitHub's own record and the reviewer's repository view comes from the ticket's own
retained workspace under the configured `workDir` — `--project` only names the root the connected
project's configuration is read from. That workspace has to be on the machine running the scan: a
ticket whose pointer names no workspace there, or whose workspace does not hold the reviewed head
and its base commit, is reported for coordinator attention instead of being reviewed. `--limit`
belongs to `review scan` alone and counts reviewer turns, not tickets: a ticket whose head was
already reviewed costs nothing. `review watch` exits `130` on Ctrl+C after the active reviewer turn
and the current ticket are finished; evidence already written is kept.

### What is eligible, and what a scan does

The queue is the configured project, issue type, and label in the `source`'s **review status**
(default `In Review`). For each eligible ticket:

1. The ticket's own local intake receipt is read when this output directory has one. A review
   approves work, so a receipt whose last recorded attempt ended `failed` or `cancelled`, or one
   that records a reservation with no finished attempt, is **reported for coordinator attention**
   and reviewed no further: a pull request that predates the failure is not the successful code a
   review would approve. A ticket this machine never attempted has no receipt and is reviewed from
   its pull request and the repository view below alone; a receipt that cannot be read is reported
   rather than ignored.
2. The ticket is re-read and mapped exactly as intake maps it, so the reviewer is given the
   ticket's own description and acceptance criteria. Its pointer labels are read from that same
   read, never from the search result.
3. A review needs one clearly identified pull request. Exactly one valid
   `harness-ws-<workspaceId>` pointer label names the workspace whose branch the delivery step
   pushed, and exactly one open pull request in that project's `delivery.repository` must have the head branch
   `harness/<workspaceId>`. No pointer, a pointer that is not a usable workspace id, two
   pointers, no open pull request, and more than one match are all **reported for coordinator
   attention**: nothing is reviewed, nothing is published, and the ticket stays where it is.
   Before looking up the pull request, the pointer is resolved through intake's read-only workspace
   validation: both the clone and ledger must stay inside the workspaces directory, and the ledger
   must match the ticket's source type, site and immutable issue ID. A renamed display key is allowed.
   The ledger's source repository must match the canonical `--project` root (`--repo`'s preflight
   root for a queue). Missing or malformed ledgers, absent source identity and mismatches require
   coordinator attention before any view or turn, including before check reconciliation. The scan
   never repairs or adopts a ledger; an operator must verify ownership from the original attempt's
   evidence before correcting it.
4. A head whose current commit already carries a completed review by `app.login` whose
   `commit_id` is that head — state `APPROVED` or `CHANGES_REQUESTED` — is not reviewed again, and
   no reviewer turn is started. A later commit is a new head and is reviewed again; a stale
   verdict can never approve it. If such a review exists but the app-owned `checkName` check run
   for that head does not, the scan publishes the check from the latest review's own state and
   starts no turn. It also updates the newest app-owned check in place if its conclusion
   contradicts that verdict, so an older success cannot mask a later request for changes. Native
   review/check lists that hit their bounds are refused. The ticket and head are revalidated before
   reconciliation: the check is a projection of the native review, never a second decision.
5. Otherwise the scan reads what GitHub reports about the change — the changed file list with
   each file's patch, the head's check runs, and its combined commit status — and prepares the
   **repository view** the reviewer inspects. The view is cloned from the ticket's own retained
   workspace (`<workDir>/workspaces/<workspaceId>`, the one the pointer label names), detached
   from it so it keeps no remote, and pinned at exactly the reviewed head; the change's base
   commit must be in it. The clone carries committed content only and no credential of any kind:
   the App private key and the installation token stay with the scan. A changed-file list that
   reaches the bounded pagination limit (three full pages of 100 files) is treated as incomplete:
   no reviewer turn starts and no review or check is published, and the coordinator must arrange
   a complete review or split the pull request into smaller changes. A missing patch (a binary or
   oversized file), a patch whose addition/deletion counts disagree with GitHub's own counts, or
   a repository change too large to render are *not* refusals: the reviewer reads the change from
   the view, and a finding the patch cannot position is reported in the review body. A ticket
   description exceeding 8,000 characters is refused before a reviewer turn, and so is a view
   that cannot be prepared: no retained workspace on this machine, a head or base commit it does
   not hold, a clone that fails, or a view that is not clean.
6. The `reviewer` launch runs as **one bounded turn** in the parent evidence directory at
   `<workDir>/reviews/<reviewId>/`, with the same adapter, non-interactive launch and task
   timeout a run gets, and the supported Git repository-check bypass. It inspects the pinned
   `repo/` checkout through explicit paths or `git -C repo`, keeping the reviewed tree outside
   automatic instruction discovery. The verdict is written outside the view, at the absolute
   path supplied in the prompt in the evidence directory. The repository's applicable `AGENTS.md`
   files remain available to read as review evidence; they cannot authorize fixes or publication. The prompt carries the ticket, the pull
   request's identity and head/base commits, the CI evidence, the view's location, and the
   verdict contract — never the patch, and never the repository's `AGENTS.md` contents, which the
   reviewer reads from the view like any other file. It is instructed to review only: it must not
   change the view (including ignored files; no edits, commits, checkouts, fetches, or pushes),
   implement fixes, commit, push, merge, or edit the ticket or the pull request, and it must write one `verdict.json` (a
   `verdict` of `approve`, `request_changes`, or `inconclusive`, a summary, a findings array, and a
   verifications array). Findings are blocking; approval requires an empty findings array and
   sufficient evidence. The verdict also states how each finding stands against the earlier
   rounds — `new`, `unresolved` (an earlier finding whose claimed repair did not hold) or
   `regression` (one this revision reintroduced), the first two of those naming the earlier
   identity in `continues` — and groups the other confirmed occurrences of one defect under
   `related` instead of reporting one finding per example. When the snapshot carried outstanding
   findings, the verdict states one verification per finding identity — `verified`, `unverified`
   or `regressed`, with the evidence the reviewer itself read — and a verdict that verifies none
   of them, names something else, or approves while leaving a disposition unverified is refused
   as inconclusive: a developer's claim is never published as a verified fix, and an approval
   clears a change request only when the reviewer verified its disposition itself. An
   `inconclusive` verdict is the one result that decides nothing and states no reading of the
   outstanding findings. The
   reviewer must select `inconclusive` when material code/test context or tools are unavailable,
   explaining what the coordinator needs to provide in its summary. A turn that fails, is
   stopped, or writes no usable verdict is also **inconclusive**: nothing is published for it, and
   no coding repair is started. The prompt says what a successful check does not mean: the change
   is judged against the ticket at the integration point it affects, the project's whole test
   matrix is not re-run to stand in for that judgment, and a build or test change the ticket
   explicitly asks for is part of the change — checked for what it does and for what it must not
   weaken.
7. Before anything is published, the view is re-checked: it must still be at the reviewed head
   with no changed path, or an edit, a new file, a commit, or a moved head publishes nothing. The
   pull request is then re-read and must still be open at that same head, and the ticket is
   re-read and must still be in the configured review status. A head that moved, a closed pull
   request, a ticket that left review, and a view the turn changed publish nothing: the result is
   stale, and a later scan reviews the new head.
8. The verdict becomes one native review — `APPROVE` for an approved verdict, `REQUEST_CHANGES`
   otherwise — pinned to the reviewed commit with `commit_id` and carrying the ticket reference
   and URL, the summary, and any finding the diff could not position, together with the
   dispositions this review verified when the snapshot carried outstanding findings (each named by
   the identity of the finding it answers and stated as `verified`, `unverified` or `regressed`).
   Findings whose file and line the pull request's own patch shows are published as native inline
   comments.
   `REQUEST_CHANGES` requires at least one finding; an approval is published only when the
   reviewer completed with a usable verdict.
9. One app-owned check run named `checkName` is then published on the same head: conclusion
   `success` only for an approved verdict, `failure` for a requested change. If the review is
   published but the check is not, that is reported; a later scan reads the completed review and
   publishes the missing check or updates a contradictory one. A partial publication is reported
   honestly: the native review may already exist even when its check write failed.

Every outcome is printed and appended to `<workDir>/reviews/review.log`, and every reviewer turn
keeps its evidence beside its verdict: `input.md` (what the reviewer was given), `reviewer.log`
(its own output), `verdict.json`, `review.json` (the outcome, the review and check URLs, the view
it inspected, and any problem), and the repository view itself (`repo/`), kept for inspection.
A ticket the scan could not review is left in the review status with no review, no
check, and no approval; the coordinator decides what happens next. A missing credential, an
unavailable tool, an API failure, and incomplete evidence are reported exactly as such, never as
an approval and never as a reason to start a coding turn.

CI status stays a separate merge requirement: a review verdict does not depend on CI being green,
and an approved check run does not mean CI passed.

### The ticket conversation history

Before every developer turn and every reviewer turn, the harness prepares one identified snapshot of
what the ticket and its work say, and hands the turn its local paths. Both roles receive the same
organization and the same layout, beside the retained workspace the ticket's pointer names:

```text
<workDir>/workspaces/<workspaceId>.history/
  current.json                  # points at the newest prepared snapshot
  consumed-developer.json       # last snapshot consumed by a developer turn
  consumed-reviewer.json        # last snapshot consumed by a reviewer turn
  reports/                      # complete developer and reviewer reports, saved before publication
  snapshots/<snapshot-id>/
    index.md                    # concise index: role, author, time, round, source id, commit
    index.json                  # the same index, machine-readable
    entries.jsonl               # one JSON object per entry, with its file
    entries/                    # one file per entry: provenance header, then the wording verbatim
    task.json                   # the ticket's current requirements, whole
```

The prompt carries the current brief (the ticket's title, description and acceptance criteria), the
latest delivery, every complete unresolved review finding with the discussion that answered it, and
the human feedback this role's last consumed snapshot did not hold. It also carries the ticket's
**recovery context** (see §12): every supervised recovery incident of this ticket whole — the stop,
each attempt with its cause and the work it preserved, the conclusion and what resumes — together
with the comments the same service account made while handling it: the concise report an incident
published is recognized by the comment identity that incident recorded, and the account's other
comments by its configured author name and the window the incident covered. The records themselves
are read from the supervisor's own state under `<workDir>/.supervisor`. Both roles receive it, independently of either cursor, as
context like any other entry: it is never an approval, a verification, or a finished state. The two role cursors advance
only after a turn returns usable output; preparation and the other role never consume feedback.
An absent legacy cursor replays feedback, and a restart reads the cursor from disk. Requirements
are re-read before each turn, including repairs, and every task section uses that reading. Invalid
or unreadable current requirements stop the turn. Developer turns with a prepared snapshot do not
also receive the ordinary comment and prior-attempt excerpts collected at intake: those can be
stale after an edit or repeat feedback already consumed. Only the separately validated baseline
repair requirement is carried forward beside the snapshot, including on every repair. Without a
prepared history, legacy guidance is unchanged. The full conversation remains in the
snapshot for the turn to read and search with its ordinary tools (`rg <text> <index or entries
directory>`), so no Jira or GitHub call of its own is needed or wanted. Findings and human feedback
are rendered whole: the history section is bounded only by dropping whole entries from the inline
block. Responses and new feedback each have a 60,000-character inline budget, selecting newest
whole entries first. Overflow points to the complete `brief.responses` or `brief.newHumanFeedback`
array — recovery context uses the same budget and the same `brief.recovery` — in that snapshot's
`index.json` and requires the turn to read it
before acting or report an input gap. If a source could not be read, a page bound was
reached while following pagination, or a complete report is missing, the prompt opens with the gaps
it knows about, so a turn is never told the history is complete when it is not; a snapshot that
cannot be written at all stops the turn before it starts.

Outstanding findings are reconciled across retained and native reviews, independently by reviewer,
finding by finding as well as round by round. A later published approval from that reviewer at the
current head clears their request; another reviewer's approval, an old-head approval, a comment-only
review or an inconclusive verdict cannot clear it. A round that requests changes adds the findings
it raises and clears nothing: a new change request never silently resolves an earlier defect. A
round's own verifications settle exactly the identities they name — `verified` clears that one
finding, `unverified` and `regressed` leave it outstanding for the next round to answer and verify —
and that reviewer's latest change request stands as a round of its own, so a native review that
states no finding of its own is still an outstanding request. Published findings without a retained
report remain visible with an explicit provenance gap. Responses include older comments edited after
the review.

Every finding keeps the identity it is rendered with: the round that raised it and its position
there, `R3-F2`, derived from the retained report rather than stored twice — so the brief, a
developer's answer and a later reviewer's verification all name the same finding the same way, and
the identity is reproduced rather than re-derived when a snapshot is rebuilt or a run restarts. A
finding a later review raises again is not a new identity: it is classified `unresolved` or
`regression`, names the identity it continues, and keeps it for as long as it is outstanding, while
the review's own occurrence — its own round and position — is recorded and rendered beside it, so
the latest wording of the defect is not lost. Two reviews this harness kept no round number for are
named apart by a bounded digest of the identity that scopes them, so two baseline diagnoses of one
project cannot share one finding identity.
The brief renders each outstanding finding whole, with that identity and how the round classified
it, and under the finding the answer a developer turn gave it: the newest developer report recorded
after the review is the claim the reviewer is shown, named with the run and the round it came from,
and an earlier answer stays readable in the report it was recorded in. The newest attempt stands,
whatever it holds: a report that is missing, or one that comes back incomplete, keeps its answers
incomplete with that provenance attached, and an older complete claim is never read as the current
attempt's response. The harness reads
those answers out of the developer's own summary — one `### Finding <identity>` section per
finding, with `Cause`, `Affected scope`, `Repair`, `Verification` and `Remaining uncertainty` each
stated, and a wrapped value indented under the line that names it. A finding with no such section, and
a section that leaves a field out, is recorded as an incomplete response: the brief says so where
the answer would be, and the answer is never presented as complete remediation, whatever the
surrounding discussion reads. A turn that answers one finding never stands in for another, and the
identities the prompt lists are the ones the developer is held to. Complete exchanges survive
further turns and restarts because both halves are retained: the answers are read back out of the
complete developer reports, and the verifications out of the complete reviewer reports, every time
a snapshot is prepared. One answer field longer than the brief's own rendering bound is cut for the
prompt only, with the complete developer report the answer was read from named where the cut is —
the retained report is unchanged, and it is what both roles can read in full.

What one review verified about the dispositions before it is recorded with that review and rendered
under its round: `verified`, `unverified` or `regressed`, with the reviewer's own evidence. A
developer's answer is a claim and a verification is a fact, and the two are rendered and recorded
as such; a later review that finds the defect still present raises its own finding classified
`unresolved` or `regression` and naming the identity it continues, so one defect is followed across
rounds instead of being re-raised as an unconnected new finding. Confirmed related occurrences of
one defect are grouped under the finding that names the cause rather than repeated as examples.

Native GitHub reviews have no edit timestamp. Synchronization compares their bodies against the
recorded publication hash and marks changed renderings as edited, including when the prior snapshot
held only a mirror. A legacy publication without a saved hash uses an earlier unchanged mirror as
its comparison when available. That status survives subsequent refreshes and restarts, so both roles continue
to receive the correction as a response alongside outstanding findings after consuming an earlier
snapshot. When an edit has no timestamp, its original submission time cannot establish whether it
predates an outstanding round. Such corrections remain responses even when a newer review from the
same reviewer supplies the outstanding findings. This conservative rule applies to human reviews too;
it does not invent an edit time or change which review round is outstanding.

Every entry keeps its source's own identity (a Jira comment id, a GitHub review or comment id, a run
or review id), its author, time, round and the reviewed or delivered commit where that applies, and
its original wording. A read that reports an edited comment updates that entry in the next snapshot;
it never adds a second one. A snapshot is named by the hash of its own content, so a refresh with
nothing new reuses it and a refresh with something new writes a new directory: the snapshot a running
turn holds is never rewritten. A concise Jira result comment or native GitHub review carries a
`nexus-history:` marker naming the complete report it renders, and the acknowledged comment id or
native review id is recorded with the report when the publication succeeds; when synchronization
reads that rendering back it checks it against that recorded publication identity and, if the text
is still the text that was published, records a mirror of the local report instead of a duplicate
conversation entry. A comment that merely quotes a marker, a rendering that was edited after
publication, and an unauthenticated rendering whose publication was never recorded all stay
attributed entries: wording alone never removes a message. A rendering published before the harness
recorded publication identities is recognized only from a configured harness author and the
harness's own rendering shape — its run
result line, the marker naming the same run, and its artifacts and repairs lines — which a comment
that quotes a marker does not match. The inline findings of a native review published by the App are
the retained report's own findings, mapped by the review's identity; a reply to one stays a reply.

The normal completion pass records its acknowledged Jira findings comment with the exact local
reviewer's native review identity and head. Its review excerpt becomes a mirror; its distinct
completion context stays a harness entry, even when Jira's service account name differs from the
GitHub App login. Both role prompts include that context among responses after an outstanding
review, including distinct check failures and the repair disposition. It stays actionable after
consumption and restart while the review is outstanding; whole-entry overflow requires reading
`brief.responses` locally, just as for other responses. The report digest retains the published
text and hash. The snapshot's
`mirrors[].originalEntry` in `index.json` retains the whole rendering and source provenance, and
`index.md` points to it. Later edits remain complete separate entries. A pre-existing comment or
an uncertain write found only by a marker does not acquire publication provenance from that marker;
without a recorded acknowledgement it remains attributed remote evidence. A provenance write
failure is reported as attention before the status move.

Review order, earliest outstanding review, latest delivery and response selection compare parsed
timestamp instants, including Jira numeric timezone offsets. Stored timestamps keep their original
spelling. Invalid or unavailable timestamps are named as gaps, with possible responses included
conservatively rather than silently dropped after a feedback cursor advances.

Complete developer messages pass through the runtime adapter without truncation and are saved
under `reports/` after every turn, so repairs see earlier turns
from their own run. The final run enriches that same entry before the result comment is published.
After a restart or early coordinator return, preparation reconciles any `in-progress` digest with
the finished attempt in the workspace ledger and its `result.json`. The new snapshot includes the
final outcome, reason and check results while keeping the original turn wording. If final evidence
cannot be recovered, the retained report remains readable and is marked incomplete with the path
and reason. Recovery changes neither prior snapshots nor the saved digest and invents no publication
or delivered commit; an attempt not yet recorded as finished remains in progress.
Reviewer verdicts are saved before publication checks, including inconclusive and stale verdicts; each developer report records the
commit its delivery verified, so successive rounds to the same pull request each keep their own
revision. Reports recorded before this increment are rebuilt from the run's own `result.json` and
from the reviewer's retained verdict beside its review record under `<workDir>/reviews/`; a record
that cannot be read back as that conversation — invalid JSON, no list of coding turns — is marked
incomplete and names what is missing. A legacy adapter truncation suffix also marks the report
incomplete, even if its shortened message has a Markdown copy; raw logs do not make it complete.
A report whose file is really gone is marked missing, with
the path that was looked for; the workspace stays usable either way. Nothing in the history is a
command, a configuration value, or a permission: it is attributed external text for the turn to
weigh.

Baseline reviewer outcomes are included from `baseline/<project>/<evidenceId>/outcome.json`, using
the existing validated evidence record to match the ticket and retained workspace. An accepted
repair appears as an outstanding diagnostic request; rejected outcomes remain attributed reports
and never lend their unaccepted finding file to a prompt. An unavailable legacy outcome is a named
gap. The report records the evidence identity and reviewed base commit; its round is unknown and
its time is labeled as the outcome file modification time because legacy outcomes have no turn
timestamp. Baseline comments are deduplicated only with their recorded acknowledged Jira identity
and matching text hash; unauthenticated legacy renderings remain visible.

If saving a developer report fails during cancellation or timeout, both failures remain in the
result. Unconfirmed termination still prevents a final workspace inspection and automatic reuse;
a report-write failure cannot convert it into a clean stop.

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

Every API read is bounded by the item deadline; an expired read has a separate ten-second budget for its attention comment. Native APIs do not offer a transaction across GitHub and Jira: both are re-read immediately before writes, and a concurrent human edit during a request remains an external race.

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
and `reviewer.app.privateKeyPathEnv` from the reviewer process environment. The operator's own
environment and unrelated runtime settings are preserved. This avoids passing the token or the
App key's location to the reviewer; it does not sandbox a process running as the same OS user.

One review scan or watch per repository is the supported arrangement. There is no local lock or
cross-machine coordination; native review metadata deduplicates successive scans, not concurrent
reviewers. GitHub cannot atomically compare the current head and submit a review; `commit_id` and
the check's head SHA pin every publication to the reviewed commit even if the head moves after
the final read. Operators must verify the corrected path with a live App review and gate check;
offline tests do not establish native approval eligibility, auto-merge, or useful review quality.
The reviewer's repository view also ties a scan to the machine that ran the ticket: the ticket's
retained workspace has to be under the configured `workDir`, holding the reviewed head and its
base commit. Do not delete or move a workspace whose pull request is still awaiting review — a
scan that cannot pin one reports the ticket for coordinator attention instead of reviewing it.

## 10. Review-to-completion — optional, across both files

Completion is off unless a project's `delivery` carries `completion` **and** the harness configuration carries the `completion` policy that names the reviewer. With both, the harness carries an In Review item's delivered pull request the rest of the way — once the Nexus Lens reviewer has approved it — and marks the item Done only after GitHub really merged that reviewed head and every configured post-merge workflow on the base branch succeeded. Without them, nothing about §8 changes: the pull request waits for a person.

The two halves are one object once composed, and each half stays in the file that owns it. The project's own `delivery.completion` names its CI and its workflow statuses:

```json
{
  "delivery": {
    "type": "github",
    "repository": "owner/name",
    "baseBranch": "main",
    "completion": {
      "postMergeWorkflows": ["ci.yml"],
      "toDoStatus": "To Do",
      "doneStatus": "Done"
    }
  }
}
```

The Nexus-wide harness configuration names the reviewer the gate requires:

```json
{
  "completion": {
    "lensApp": "nexus-lens[bot]",
    "lensAppId": 5001141,
    "lensCheckName": "Nexus Lens review",
    "reviewerTokenEnv": "NEXUS_LENS_TOKEN",
    "pollIntervalSeconds": 30,
    "deadlineSeconds": 1800
  }
}
```

| Field | Contract |
| --- | --- |
| `completion.lensApp` | Required in the harness configuration. The login GitHub attributes the pull request review to. A review from anyone else is not that reviewer's verdict. |
| `completion.lensAppId` | Required there. Positive GitHub App ID. The latest Lens check must be owned by this App, match the reviewed head, and link to the native review. |
| `completion.lensCheckName` | Required there. The app-owned check the approval has to be backed by on the same head, for example `"Nexus Lens"`. It must be the `checkName` of the configured `reviewer` when both are present. |
| `completion.reviewerTokenEnv` | Required there. Environment-variable name holding the **reviewer's own** credential, for example `"NEXUS_LENS_TOKEN"`. It is deliberately not the operator's Git/`gh` credential: the reviewer's token reads the reviewer's verdict and never enables auto-merge, and the operator's credential never reaches the reviewer. The value is never a configuration field. |
| `delivery.completion.postMergeWorkflows` | Required in the project configuration. A nonempty array whose entries are stable workflow files (`"ci.yml"` or `".github/workflows/ci.yml"`) or numeric workflow IDs. An empty or missing list is refused: it is not evidence that CI passed. |
| `delivery.completion.toDoStatus` | Required there. The status a definitively failed outcome returns the item to. It must differ from the project's `source.reviewStatus` and from `doneStatus`. |
| `delivery.completion.doneStatus` | Required there. The status a verified completion moves the item to. Reached only after the merge and every configured post-merge workflow succeeded. |
| `completion.pollIntervalSeconds` | Optional integer at least 5, default 30. Delay between two reads of GitHub's merge and workflow state. |
| `completion.deadlineSeconds` | Optional integer at least 5, default 1800. How long one item may stay pending in one pass before an attention comment is posted and the item is left In Review. |

### What the completion path does

After a `source run` batch, and after each `source watch` scan, one bounded pass reads the configured queue's In Review items. For each one it re-reads the item, takes the single workspace pointer it carries, and looks up the one **open** pull request for that workspace's branch, the configured repository, and the configured base branch. A pass never claims an item, never changes what the batch itself did, and never starts a coding turn.

In the serial queue, arming comes first and is its own bounded step: immediately after a coding attempt delivers or updates the pull request, and before the Nexus Lens review publishes the final required check, the queue arms that exact pull request and head. GitHub refuses to enable auto-merge for a pull request whose required checks are already clean, so arming while the reviewer's check is still pending is what keeps the native merge available. The queue records the pull request and head, verifies the recorded arm instead of sending a second request on a restart, and re-arms a repair's new head before that head is reviewed. A refused arm stops the queue with the refusal as actionable evidence and leaves the item In Review; it is never read as a merge.

1. **The reviewer gate.** It requires a completed `APPROVE` review by `lensApp` on the pull request's **current head**, and a successful `lensCheckName` check on that same head. The head is re-read immediately before every mutation. A current-head `REQUEST_CHANGES` decision, with its associated failed Lens check, is a finding: one concise comment naming the review link or the failed check, and the item returns to `toDoStatus` with its workspace pointer preserved, so the ordinary source consumer can take the next repair attempt in the same workspace.
2. **Arming.** With the operator's own `gh` credential the harness calls the GraphQL `enablePullRequestAutoMerge` mutation with `mergeMethod: SQUASH`. That is a per-pull-request request to enable **native** auto-merge, not a merge: GitHub enforces branch protection and every required check and performs the merge itself. The completion pass verifies the queue's recorded request for the approved current head and only re-arms when GitHub no longer holds one; a standalone source command or a restart without the queue's arm step tries the same request here. GitHub refuses the mutation as unprocessable when the pull request is no longer armable, which is what a merge landing in the request's own window looks like; one fresh read of the pull request then settles it — the reviewed head merged is a merge and continues to step 3, still open with the request enabled is an arm, and anything else is the refusal GitHub gave. A conflict, a branch-protection refusal, a clean-status refusal, or an authentication/permission failure is reported as an operator problem and the item stays In Review — those are not established coding findings.
3. **The merge.** The harness waits, bounded by `pollIntervalSeconds` and `deadlineSeconds`, until GitHub reports that exact pull request merged, with the approved head as its source, the configured base branch, and a merge commit SHA. An armed request, pending pull request checks, a closed pull request, or an absent branch is not a merge. Reads are reconciled rather than trusted across the race: GitHub can merge the reviewed head between the merge read and the gate read, so a verdict that would otherwise read as "not eligible for completion" is settled by one fresh read before it is classified. A reading that never approves the current head, a closed and unmerged pull request, a head that moved away from the reviewed one, and a merge that cannot be tied to the reviewer's approval of that head are terminal states: the item stays In Review for a person, with the pull request, the heads, and any merge commit named as evidence, and none of them is retried or assumed successful. A definitive failed required pull request check is a finding (one comment naming the check and linking its evidence, then back to `toDoStatus`); a mergeability or infrastructure problem stays In Review.
4. **Post-merge CI.** Every configured workflow must have a run for event `push`, on the configured base branch, for that exact merge commit SHA, and the **latest attempt** must be `completed`/`success`. A run that has not appeared, or is queued or in progress, is pending and waits. A failed, cancelled, timed-out, action-required, stale, skipped, or neutral latest result is a definitive unsuccessful outcome: one comment naming each unsuccessful workflow, its conclusion, and its links, and the item returns to `toDoStatus`. The merge is never rolled back. If the deadline expires with work still pending, the harness posts one attention comment and leaves the item In Review — no failure conclusion was observed.
5. **Completion.** Only after the verified merge and every configured post-merge workflow succeeded does the harness post one evidence-based resolution comment of at most 120 words — what changed or what the investigation concluded, the successful post-merge main workflow, any material limitation, and the pull request and workflow links — and then move the item to `doneStatus` through native transition discovery.

### Recovery, and what is not merged

Every command a pass runs writes its output under `<workDir>/completion-logs/<identity-hash>`, and the pass creates that directory before its first GitHub read: a fresh pass, or a restart after an earlier one stopped, begins with no directory at all, and a command whose log directory is missing fails before it can report anything. A directory that cannot be created stops the item for attention with the location named — nothing is armed and nothing is written in Jira.

A read GitHub could not answer this moment — a server-side failure, a rate limit, or a timeout — is read again with `pollIntervalSeconds` as backoff, bounded by the item's own `deadlineSeconds`; a refusal GitHub meant, a malformed answer, and the deadline itself are not retried. That includes every reading taken around a mutation: the fresh eligibility read before the request, the read that reconciles whatever the request answered, and the required-check read, whose command reports a red or pending check through its exit code — a `gh pr checks` run that wrote no check result is an unanswerable read and not a failed check. An auto-merge mutation is never replayed, whatever the failure looked like: a lost response is settled by reading the pull request, not by sending the request again.

A read the harness itself stopped at its command limit is one of those unanswerable reads: it is
recorded as `timed-out`, a stalled command may leave no diagnostic line at all, and its own outcome —
never the empty log — is what classifies it, so it is repeated inside the item deadline instead of
stopping the item for a person, while a read the run's own stop ended is not retried. The reads that
guard the resolution comment and the status move are bounded by the item deadline the pass already
holds, so neither write mints a fresh budget after that deadline has passed. A merge the pass
discovers without ever having requested auto-merge — GitHub can merge the reviewed head while the
gate is read, or between the eligibility read and the request — is recorded as the same PR/head
admission before the pass verifies it or writes anything for the item, so a resolution comment whose
status move failed is resumed by the next pass instead of leaving the item unresolvable; a record of
that exact PR/head already there keeps the wait start it carries, and a merge whose identity cannot be
recorded is reported for a person rather than concluded.

Completion evidence and auto-merge admissions use a hash of the source type, canonical site,
immutable item ID, and lowercase GitHub owner/repository. Equal Jira IDs from different sites or
destinations cannot share logs, temporary files, admissions, or restart deadlines. A legacy
`completion-logs/<issueId>` path has no trustworthy connection identity and stops the item for
manual reconciliation before any GitHub command or Jira write. It is never adopted, overwritten,
or silently treated as a fresh admission; inspect its ownership and preserve active recovery
state before moving that old directory aside.

The local admission file is persisted before requesting auto-merge and identifies only the PR/head and, once the merge wait begins, its start — never an outcome. A failed local write prevents the remote request. The admission survives a lost mutation response or failed verification read, including for a repair's new head, so a restart can find a native merge by PR number after it leaves the open list. A restart verifies the armed head against GitHub before it treats the request as present, and re-arms when GitHub no longer holds one. Merged PRs without that admission are not backfilled. Jira changelog entries distinguish a human reopening from a transition retry. GitHub's merged state and the configured post-merge runs are authoritative, and the item's own Jira thread is the record of what was already written. A comment carries a marker, so a repeated pass or a restart finds the comment it already wrote instead of writing a second one; a status move is made only while the item is really still in review. After a restart, a merge confirmed but with post-merge CI absent, pending, or unsuccessful keeps waiting or reports attention without a duplicate comment; if the comment exists but the status move did not arrive, only the transition is retried after re-reading Jira. An item that a person moved out of In Review is not touched. A comment or transition failure never starts an agent: returning an item to `toDoStatus` merely makes the normal source consumer eligible to take the next repair attempt.

Nothing in this path merges, force-pushes, reruns a workflow, or bypasses protection. The harness never gives the reviewer the operator credential, never lets the reviewer's token arm anything, and never treats an approval, an armed request, or a green run on another commit as evidence of this merge.

Every API read is bounded by the item deadline; an expired read has a separate ten-second budget for its attention comment. Native APIs do not offer a transaction across GitHub and Jira: both are re-read immediately before writes, and a concurrent human edit during a request remains an external race.

### Operator setup

1. `gh` must be authenticated as the **operator** account that may enable auto-merge on the destination repository (the same account §8 already uses), and branch protection must require the checks you mean to gate on.
2. Put the **Nexus Lens reviewer's** own credential in the environment variable `completion.reviewerTokenEnv` names. It must be a different credential from the operator's: the reviewer/reader token only reads GitHub evidence, and the operator's is what asks GitHub for auto-merge. Neither is written to the configuration, a report, or a log.
3. Name at least one post-merge workflow that really runs for `push` on the base branch, for example `"ci.yml"` for this repository's own gate.
4. `check-config` prints the effective `delivery` and completion lines before anything runs; the composed completion object is validated with them.

## 11. Serial queue — `queue run` and `queue watch`

The two queue commands are a foreground control loop over the paths above: they take one eligible
ticket at a time, run it, deliver it, arm native auto-merge for the delivered head before the review
publishes the final required check, review it with Nexus Lens, complete it through GitHub's own
merge and the configured post-merge workflows, prepare the checkout for the next workspace, and take
one more ticket. [spec.md](spec.md) §11 defines the behavior; this section defines the commands and
the configuration they need.

```sh
npm run dev -- queue run   --repo ../target-project --config nexus.config.json
npm run dev -- queue watch --repo ../target-project --config nexus.config.json
```

| Option | Contract |
| --- | --- |
| `--config` | Required. The Nexus-wide harness configuration, resolved from the current directory. |
| `--repo` | Required. The operator's own checkout of the delivery repository's base branch. The queue clones each workspace from it, reads the project's own configuration from its root, and fast-forwards it between tickets. |

Nothing else is accepted: `--task` belongs to `run`, and `--limit` to `source run` and
`review scan`, so a queue command refuses them as the unknown options they are for it. Both
commands are opt-in; `check-config` validates the objects they need without approving any of them
for use.

For the end-to-end onboarding sequence a project follows before these commands — the project-side preparation, the committed `nexus.project.json`, and the validated `check-config` → `source list` → `queue run` order against a prepared installation — see [connect-a-project.md](connect-a-project.md).

### What the configuration must carry

Three objects are required for these two commands — two from the project's own file and one from the
harness configuration — and each is validated by the loader exactly as its own command validates it:

- the project's `source`: the Jira queue. Its `readyStatus` is the queue the loop takes from, its
  `reviewStatus` the status a finished attempt lands in, `runningStatus` the status a claim moves it
  to, and `pollIntervalSeconds` the idle wait watch mode uses.
- the harness configuration's `reviewer`: the Nexus Lens path. Its `app` login and id and its
  `checkName` must agree with the composed `completion`, which the loader already enforces: the
  queue reviews the pull request it delivered, with the reviewer whose check the completion gate
  requires.
- the project's `delivery` with `delivery.completion`: the destination repository and base branch,
  and that project's post-merge workflows and statuses (§10). The queue stops on a ticket that
  reaches `doneStatus`, and repairs — in the same workspace — a ticket that returns to `toDoStatus`.
  Without this object a queue command is refused rather than run: a ticket nothing can complete is a
  ticket the loop would have to skip.

A composed configuration with no `source`, no reviewer, or a `delivery` without `completion` is
refused with what is missing — and which file it belongs to — before any credential is resolved.

For its whole invocation, including idle watch waits, a queue holds the connected project's intake
lock under `workDir` — not a lock on the output directory. A second `queue run`/`queue watch` for
the same project and `workDir` is refused with the lock's owner diagnostic, while a queue for a
different connected project starts normally under the same `workDir` and harness configuration.
That concurrency boundary is verified offline — a second consumer of one project and `workDir` is
refused, and a different connected project runs under the same storage root — and no live
concurrent exercise of two real project queues has been run. [spec.md](spec.md) §6 and §11 own the
behavior.

### Credentials

The queue resolves the Jira token named by the project's `source.tokenEnv` and the App key path
named by the harness configuration's `reviewer.app.privateKeyPathEnv`. Its completion reader
obtains a current installation token from the existing App client before each GitHub evidence read;
that client refreshes tokens near expiry.
Token requests retain the Lens permissions listed in §9, including during renewal; they do not
request additional Actions access. The configured public repository's post-merge workflows are
read with that token; inaccessible workflow evidence stops the queue for attention. Queue
mode does not use a static token from the harness configuration's `completion.reviewerTokenEnv`;
that setting remains part of the shared Nexus-wide completion policy, and standalone source
commands still use it as §10 describes.
The operator's Git/`gh` credential alone arms auto-merge. Coding turns, checks, and operator commands
inherit neither the Jira token, App key path, nor the configured reviewer-token variable; reviewer
turns also exclude operator GitHub tokens. No credential is written to reports or logs.

Before claiming fresh work, the queue discovers authoritative In Progress and In Review work.
Unresolved In Progress ownership or multiple In Review items stop it for attention. A single
In Review item resumes its scoped review/completion phases; a merged PR must pass the existing
admission and native GitHub checks. Retained To Do repairs take precedence over unrelated new
work. A Done item is never rerun.

### The pre-delivery baseline diagnosis

A fresh workspace whose baseline is red — every `setup` command exited `0`, the check round
completed, and at least one configured check exited nonzero — is diagnosed before any developer
turn. The diagnosis exists exactly when the composed configuration provides the reviewer — the
harness file's `reviewer`, with the project's own `source` and `delivery` — and a project without it
keeps the older behaviour: the failed attempt is published and the item waits In Review. It runs the
harness configuration's `reviewer.reviewer` selection (never a coding tier) for one turn in its own
evidence directory under `<workDir>/baseline/<project>/<evidence>/` — `<project>` is the connected
project's own namespace, the same one its intake lock is named by, so one `workDir` can serve
several projects — bounded by the harness configuration's
`taskTimeoutMinutes` and by the intake's own stop request, with:

- the ticket: its key, link, title, description, and acceptance criteria, as the reviewer's context;
- the configured commands: every setup command that succeeded, and every check with the result it
  exited with;
- the bounded stdout/stderr each failing check wrote (the same bounded reading a repair turn is
  given), with the log file paths beside it;
- the ticket's conversation history (§9, "The ticket conversation history"), prepared as the
  identified local snapshot a developer and a review turn receive; a snapshot that cannot be
  prepared starts no diagnostic turn and leaves the item In Review with the paths named;
- a read-only clone of the retained workspace (`repo/` in the evidence directory), pinned at the
  commit the baseline ran against, which the reviewer may inspect with ordinary read tools. The
  snapshot has to be established before the turn: a working copy whose recorded base commit has
  moved, or whose tracked files a configured command changed, is refused as incomplete evidence
  rather than diagnosed through a clone of a tree the failing check never ran against.

The recorded evidence has to be readable before the turn is started. A log file that is missing or
cannot be read now is incomplete evidence, not a check that said nothing: the item stays In Review
with the paths named, and no reviewer is launched to reason from a rendering that would pass for a
silent command. A log the command really wrote and really left empty stays readable evidence — the
two are kept apart — and this comes before any recorded finding, so evidence that is incomplete now
is never published from. A refusal reached here still carries the stop the evidence's own record
holds: an earlier invocation whose reviewer runtime was not seen to end reaches its caller as the
unconfirmed stop it is, instead of being rounded down to a confirmed one, and a record that cannot
be read at all fails closed by name for the same reason.

The turn receives no coding instruction and changes nothing: it runs as `exec --sandbox
workspace-write` with its own working directory (`turn/`) as the only writable root — the launch
states that policy's additional writable roots as none and takes the host's temporary roots out of
it, so neither the clone nor the retained working copy is writable there even when `workDir` sits
beneath one or the operator's own configuration grants a root over it. Those keys are not the only
place a configured launch prefix can widen a launch, so a prefix that carries a switch of its own is
refused before the turn starts rather than run under it: `--add-dir` (whose directories are made
writable beside the primary workspace and are not taken back by stating that the additional
writable roots are empty), `--cd`/`-C` (which moves the working root, the one directory this launch
lets the turn write in), and `--worktree`, `-s`/`--sandbox` and
`--dangerously-bypass-approvals-and-sandbox` (a working root or policy of the prefix's own). No
reviewer runtime is started for such a prefix — nothing receives the grant — and the refusal is
recorded like any other turn that produced nothing usable, so the item stays In Review with the
reason and what a person must do. For a launch that does run, the only file it can write is its
`finding.json` in `turn/`, and the harness checks after the turn that the clone is still
the clean snapshot it was given and that the retained working copy is exactly what it was before the
turn. That turn's own environment also declares the snapshot a repository git may read (git's
`safe.directory`, through the `GIT_CONFIG_*` variables): the runtime's sandbox runs the reviewer's
commands under an identity that does not own the files on Windows, and git refuses such a repository
as "dubious ownership" before reading anything, which would leave the reviewer unable to use the
read tools this turn is built around. `finding.json` is exactly one of two shapes — a
repository-local repair, or why none may be made:

```json
{
  "outcome": "repair",
  "failingCheck": "the failing command, exactly as configured",
  "evidence": "what the recorded output or the snapshot shows",
  "likelyCause": "the most likely cause, named concretely",
  "repairGuidance": "what the next coding turn should change in the working copy"
}
```

```json
{
  "outcome": "inconclusive",
  "reason": "why no repository-local repair can be named from this evidence",
  "requiredAction": "what a person must supply, do, or decide before another attempt"
}
```

Every field shown is required, nonblank, and bounded, and that bound is enforced rather than trimmed
to: a field longer than it makes the finding unusable, because what follows the bound can be the
change the repair has to make, and what the turn wrote is kept nowhere else. Anything else — a
missing field, an oversized one, invalid
JSON, no file at all, a turn that failed or was stopped, or a clone the turn changed — is a
diagnosis with no usable finding, and is handled like an inconclusive one. The finding file alone
decides nothing: what the turn produced is recorded as `outcome.json` beside the evidence, before
anything is published — either the validated finding or the problem that rejected the turn — and a
restart reads that record. A reviewer turn whose own process tree could not be confirmed stopped is
never settled: its problem and the unconfirmed stop are recorded, the item stays In Review with the
evidence and what a person must do, and the intake keeps its lock for inspection instead of
declaring an evidence directory safe while a runtime may still be writing to it.

An actionable finding becomes exactly one concise comment on the issue, naming the marker
`nexus-baseline:repair:<evidence>`, the failing check, the evidence, the likely cause and the repair
guidance, and the issue returns to `readyStatus` with its workspace pointer untouched. That comment
is a rendering of the finding, not the width a finding has: each of its lines is bounded, so the
record on the ticket stays concise. The queue then continues that same ticket before any unrelated
ready work: the next claim reopens the same
workspace, is told the finding as guidance, repairs the baseline, and continues the
original task. That guidance carries each field of the finding whole on its own line, at the width
the reviewer's finding was validated at (up to 2,000 characters per field, `finding.json` above) —
the four things the developer has to act on are never collapsed into one bounded paragraph, and no
part of a field is cut to the width a comment line happens to have — and it is in the
brief of every rung of the climb that claim may take, not only its first. The finding has that
budget of its own and is never charged against the bounds the rest of the guidance is kept to, so a
long finding cannot spend the room the newest thing the ticket says — the review feedback a later
repair turn has to act on — is read from. The finding also carries
the order it belongs in, as a line of its own: the baseline is repaired before the original task
continues, and the coding prompt renders the finding as a requirement of the attempt rather than as
context it may weigh. The finding reaches that
claim from the item's own thread, and when the thread cannot supply it — a read that failed, a
comment that no longer says the whole finding, or a comment that names some other evidence — from
the evidence this harness kept beside the workspace. The retained evidence is what says a finding
is required, which evidence it belongs to, and what it says, and a comment is that finding only as
its whole self: the `nexus-baseline:repair:<evidence>` marker with that exact identity, all four
fields nonblank, and every one of those fields equal to the finding that record holds. The marker
names the evidence, never the text — anyone who can edit the issue can keep the marker and change a
field — so a partial quotation, an edited comment, a marker without an identity, or a complete
comment about other evidence is ordinary thread context: it is never promoted to what the attempt
has to repair first, and the complete recorded finding is handed over instead. A required finding
that neither source can supply — the retained record cannot be read back, so there is nothing to
hold the thread's comment against — starts no developer: the claimed ticket is told why on its own
thread and taken out of the running status with its workspace pointer preserved, under the same
short best-effort deadline an interrupted run's own result gets, so it is never left in the running
status with nothing looking for it and a person decides what happens next. An inconclusive,
environmental, or unsafe finding posts one comment carrying
`nexus-baseline:attention:<evidence>`, the reason and the required action, moves the issue to
`reviewStatus`, and stops the queue for a person. Nothing is posted to GitHub, and no coding turn
is started from a diagnosis. `<evidence>` is a hash of the immutable item, the snapshot commit, and
the configured commands with the results they produced: a diagnosis that sees the same evidence again
reuses the comment it already wrote — no second reviewer turn, no second comment — and makes only
the step that had not happened yet. What it acts on is kept locally as well: `<workDir>/
baseline/<project>/<evidence>/evidence.json` records the item, the task, the workspace, the round,
and the connected project that wrote it, before
the reviewer turn runs, and the outcome the turn produced is recorded beside it as `outcome.json`
once the turn has ended: the validated finding, or the problem that rejected the turn. That record
is what the marker is held against, and what a later claim of the same item is answered from: a
finding a failed or stopped turn left in its own file is never published as if the turn had
completed, and a diagnosis that finds the recorded outcome replays it instead of spending a second
reviewer turn — the item returns to its ready status, and the evidence is closed as a repair, only
while the outcome beside it holds the actionable finding the marker names, so an edited marker on a
rejected turn can never return the ticket for a repair its own turn never produced. The finding a
continuation is handed is the actionable finding recorded there, never the turn's own finding file.
An evidence directory this harness kept whose own `evidence.json` is gone is not "nothing pending":
nothing about it can be read back or closed, it may be the very record that returned a workspace for
repair, and so the intake stops for a person, naming the directory, instead of passing over it or
claiming on it as an ordinary continuation. The project is part of the path, so two projects sharing
one `workDir` never read, finish, or publish each other's evidence — a record that names another
project is refused by name — and starting one project's intake never comments on, transitions, or
closes another project's issue.

An item a previous invocation left in the running status is not the ordinary loop's to finish: that
is an interrupted episode, and the exceptional recovery of one belongs to the supervised queue's
recovery agent, which investigates the cause, preserves the work, reconciles the ticket and the
workspace and resumes what is appropriate (§12). The ordinary `source` and `queue` commands gain no
branch for it: an item a person has moved is left exactly where that person left it, a retained
record nothing can be read from is left alone rather than guessed at, and a queue never comments on,
moves, or closes an item it did not itself take.

A stop that arrives while the reviewer turn is running is not a window where the claimed ticket is
abandoned: the turn’s interruption is what this evidence’s one comment records, and the item is
moved to `reviewStatus` with it. That one comment and one move run under their own short
best-effort deadline rather than the aborted stop they were given — the same bound an interrupted
run’s own result gets — so the ticket is not left there while the diagnosis can still say so, and an
unconfirmed reviewer shutdown keeps the intake lock exactly as it does anywhere else. A stop the
caller asked for *before* the turn began writes no diagnosis: when the invocation had already
recorded its evidence, a later claim of the same item is answered from that record instead of a
second reviewer turn; and when the stop reached the diagnosis before anything was published at all,
the ticket the attempt claimed is told on its own thread and taken out of the running status under
the same short best-effort deadline. If even that cannot happen — the invocation is killed where it
stands — the item stays in the running status with its retained evidence, and the supervised
queue’s recovery agent is what reconciles it (§12).

### Exits

| Exit | Meaning |
| --- | --- |
| `0` | `queue run` drained the queue: a fresh scan found no eligible ticket. |
| `1` | The queue stopped for a person, or input, credential, or checkout validation failed. The reason names the ticket and what to fix. |
| `2` | Usage error: unknown subcommand or option, or a missing `--config`/`--repo`. |
| `130` | The user interrupted the wait or the active phase; cleanup finished and no next ticket was started. |

`queue watch` never exits `0` on its own: while the queue is healthy and empty it stays one visible
foreground process, printing an idle status and the wait before each fresh scan.

### One ticket, by identity

`queue run --ticket <key>` narrows the finite run to one ticket: the run reads that ticket's own
status, follows it by identity, and claims, reviews, completes and reports on nothing else. A
ticket in review resumes only its scoped lifecycle, a ready ticket with a workspace pointer
continues that workspace, and a ready ticket without one is the claim. A scoped run whose ticket is
in none of the configured statuses carries nothing and exits `0` like an empty queue; a scoped
ticket still in the running status is refused by name, exactly as an unscoped scan refuses one.

## 12. Supervision — `supervise run`, `supervise watch`, `supervise ticket`

The supervisor is a small parent around the queue of §11. It runs that queue as a worker — the same
CLI, the same two files, its own activity display untouched — and, when the worker stops
unexpectedly, it invokes a separate recovery agent whose judgment investigates the cause,
preserves the work it finds, repairs the situation, reconciles the ticket and the workspace, and
says what resumes. The ordinary loop gains no branch for this: every exceptional recovery decision
is the agent's, and the supervisor's own work is bounded and deterministic
([spec.md](spec.md) §12).

### Commands

```text
supervise run    --repo <checkout> --config <harness.json>   # finite: like queue run
supervise watch  --repo <checkout> --config <harness.json>   # like queue watch
supervise ticket <KEY> --repo <checkout> --config <harness.json>
```

`supervise ticket` runs the worker as `queue run --ticket <KEY>`; `supervise run` and `supervise
watch` run `queue run` and `queue watch`. The three commands refuse a configuration that does not
compose a queue, and one that carries no `recovery` policy or no `recovery.notifications`: an
incident that could be recovered but not reported is not a supervised run.

The parent has an entry point of its own, so it can still start when the harness it supervises
cannot: `<installation>/dist/cli/supervise.js` takes exactly the arguments above (`supervise run …`
started through `dist/cli.js` dispatches to the same command). That entry loads the supervisor, the
harness configuration it is started with, and the display — and none of the ordinary commands — so
a broken queue or run module is a stop for the recovery agent to repair rather than a reason the
parent never starts. The worker it starts is the ordinary CLI beside it (`dist/cli.js`).

A connected project's configuration is read as far as it can be. A readable one that composes no
queue is refused before anything claims, exactly as before; one that cannot be read at all does not
stop the supervision, because that is a state the recovery agent exists to repair: the supervisor
starts, names the problem, and supervises a worker that will stop on it.

### Fields

`recovery` is a Nexus-wide harness field; a project configuration that carries one is refused with
where it belongs. It is optional as a whole — `run`, `source`, `review` and `queue` are unaffected
— and required by the three supervised commands.

| Field | What it is |
| --- | --- |
| `recovery.agent` | The recovery turn's launch prefix, resolved like `agent` (§1). Default: `codex --profile nexus-recovery --model gpt-6-astra -c model_reasoning_effort=high`, the tier [nexus-agent-tools.md](nexus-agent-tools.md) installs. |
| `recovery.maxAttempts` | How many recovery turns one incident may spend. A positive integer, default `2`. |
| `recovery.notifications` | Where the incident summary is emailed: `topicArn` (an SNS topic ARN), `email` (the address the topic's own subscription delivers to), and an optional `publisher` command, default `["aws", "sns", "publish"]`. The harness appends `--topic-arn`, `--subject` and `--message`; the publisher's own output — the log files of the attempt that wrote `pending` down — is read for the acknowledged `MessageId`, and for that attempt alone. |

```json
"recovery": {
  "agent": {
    "runtime": "codex",
    "command": ["codex", "--profile", "nexus-recovery", "--model", "gpt-6-astra", "-c", "model_reasoning_effort=high"]
  },
  "maxAttempts": 2,
  "notifications": {
    "topicArn": "arn:aws:sns:eu-north-1:698643713254:nexus-recovery-notifications",
    "email": "saint282@gmail.com",
    "publisher": ["aws", "sns", "publish"]
  }
}
```

The configured `taskTimeoutMinutes` is the bound of one recovery turn as well; the supervised
commands change no timeout.

### What the supervisor keeps, and what a restart reads

```text
<workDir>/.supervisor/<supervision-id>/     # a hash of the checkout and the harness configuration
  holders/holder-000001-<token>.json        # one claim per invocation: the rank it published under
                                            #   plus its own token, then pid, intent, checkout
  current.json                              # the incident being carried, the worker's pid, and the
                                            #   work its launch was started for
  incidents/<incident-id>/
  incident.json                           # stops, origin, attempts, pending attempt, resume plan,
                                          # conclusion, resumption, report ids and states
    attempt-1/input.md, recovery.log, outcome.json
    recovery-notification.stdout.log, recovery-notification.stderr.log
```

`<supervision-id>` names the supervision itself: one connected checkout and one harness
configuration, never the project's own queue identity. The state has to stay readable while a
broken project configuration is exactly what is being repaired, so it cannot be keyed by that
configuration; the connected project's own lock namespace of §1 is what the activation check reads
instead (and, until its configuration can be read, there is no lock to read).

The claims are the lock, and a claim is the rank it was published under together with the
invocation's own token: a start reads the highest rank any claim carries and creates the next one
exclusively, so two simultaneous starts cannot hold one claim, and a claim published from the
directory as it stands always outranks every claim already there. The token is what makes the
name a name: it is the invocation's own, so no contender ever writes a name another contender
wrote, and clearing a stale claim can only ever remove the record the clearing invocation read
back — never a claim published under that rank afterwards, which carries a name of its own. Two
claims that carry one rank — two starts reading a single directory state — are ordered by those
names, so every contender orders the same two claims alike. The rank is read again before every
publication, and a claim that was published
below one already there — the rank it named was cleared away in between, so a claim published
meanwhile outranks it — is withdrawn and published again above what is really there: a delayed
contender never publishes below a claim that has already decided. The
lowest live claim owns the queue, and every other invocation refuses by name. A claim whose
process is gone cannot own anything: it is ignored while the ownership is decided and cleared away
by the invocation that wins, which is what makes a restart continue the incident instead of starting
a second worker. Nothing renames, replaces, or removes a claim a live holder may own — no contender
ever touches another's record — so a contender cannot lose a race it has already won, and a crash
between publishing a claim and deciding leaves the next start a queue it can take safely: an
invocation whose own claim was cleared away before it decided publishes again above the state it
then reads rather than owning a queue with nothing of its own in it. A
recorded worker PID — or a recovery turn's own runtime PID — that is still alive refuses a
supervisor that would put a second one beside it. Activating the
supervisor beside a raw `queue` consumer that is really running is refused with the intake lock and
its owner named — stop that consumer first. A lock is never broken automatically, here included.

Every worker is launched through a handshake, because spawning a process and writing down which
process it is are two steps and a supervisor can die between them. The launch's own token is written
down first — in the pointer, with no PID yet — the child is started with that token in its
environment, and the child does nothing at all until the same record names its PID; a registration
that fails stops the child where it waits, and the supervision stops for a person rather than letting
work run under a launch nothing recorded. A restart that finds a launch naming no process refuses it
by name: the worker it started is gated on exactly that record, so it began no work and gives up by
itself, and nothing here starts a second worker beside a process it cannot name.

The launch is kept until there is something durable to clear it. The invocation that watched its
worker end writes that ending down in the same record — the exit code or signal, whether the operator
asked for the stop, and whether the queue left new run evidence behind — before anything else, and
the launch and its PID stay in it until the incident that ending owes, or the queue's own
resumption, makes them superfluous. A crash between the ending and the incident therefore leaves a
restart the ending itself, never a pointer that names nothing and no record: erasing that evidence is
exactly how an interruption would go unrecovered.

### What a restart reconciles

The records above are the state; the pointer file only says which worker is running right now.
Before a restarted supervisor starts anything, it reads every incident record back and:

- **reconciles an attempt that was left in flight.** An attempt is written down — with its turn's
  directory and the PID of the runtime it started — before that turn is launched, so a restart
  never launches the same attempt twice: a turn whose runtime is still running is refused, and one
  whose runtime is gone is adopted whole from the `outcome.json` it left, or recorded as an
  interrupted attempt that produced no judgment. Either way it counts toward `maxAttempts`.
- **refuses an attempt whose runtime was never recorded.** Nothing is handed to a recovery runtime
  — the prompt it would act on — before its PID is written down; an attempt that names no process is
  therefore one whose turn never began, and a restart refuses it by name for a person to reconcile
  instead of rounding it into an attempt that produced nothing.
- **holds for a runtime that may still be repairing the workspace.** A turn whose stop could not be
  confirmed, and one whose shutdown no invocation ever recorded — the supervisor itself stopped
  inside the turn — keep the incident's ownership of the runtime's tree: the attempt stays in
  flight, its recorded PID stays the incident's, and nothing else — no second attempt, no worker —
  starts beside a process nobody has accounted for. The hold is named when it happens, and what it
  is made of is recorded: the tree's own root, and what could not be confirmed, or that nothing
  recorded it. A later invocation reconciles it only on evidence that the tree the turn's runtime
  led has ended — a missing root PID is not that evidence, because a tool the turn started can
  outlive the runtime a failed tree stop left behind — and where this host cannot answer that
  question at all (a Windows root that is already gone, chiefly), the incident waits for a person
  who has checked the host and records an acknowledgement newer than the hold, or — for a shutdown
  nothing recorded — newer than the attempt's own start.
- **finishes a report that is unfinished.** Every concluded incident whose comment or email summary
  is still outstanding is published again, wherever it sits, however many times the pointer has
  moved since: a failed publication is never lost, and never repeats the recovery that succeeded.
  The Jira connection a comment is written through is read from the connected project's
  configuration at that moment, so a report owed after a repair goes into the thread the repaired
  configuration names.
- **reconciles a launch nothing saw end.** The pointer names the worker that is running right now,
  and it carries the work that worker was started for. A restart that finds such a worker gone,
  with no incident recording how it ended, does not read that as "no worker is running". An ending
  the invocation that watched it wrote down before it could clear the launch is decided on exactly
  as that invocation would have decided: a settled worker finished its work and the operator's own
  stop recovers nothing, so both leave the queue to its records, while every other ending — a crash
  with no report at all included — is the incident that invocation was about to open, opened here
  and reported like any other. An ending nobody recorded is an unexpected stop too: the supervisor
  itself stopped while its worker ran, and an incident is opened and investigated before fresh work
  starts. Nothing is excused by a plan: a launch that was carrying out a step an incident still owes
  is investigated like any other, because that plan records the interruption the step began from,
  never what happened during it, and the step is carried out again only after its own interruption
  is reconciled.
- **carries out the work the conclusions still owe.** A `repaired` conclusion owes the interrupted
  work; a `blocked` conclusion owes the blocker first, as its own scoped `queue run --ticket <KEY>`
  worker whatever intent the incident began with, and then the interrupted work. The resumption is
  recorded when the interrupted work really starts again, and never before. The plan advances on the
  blocker's own ticket, read back through the connected project's Jira connection: a worker that
  settles proves nothing — a scoped run reports a completed run with nothing completed when its
  ticket is in none of the statuses the queue carries — so only the configured done status resumes
  the interrupted work, and a blocker that ended somewhere else, or one whose status could not be
  read, asks a person instead.
- **keeps an unresolved request for human help stopped.** A `help` conclusion is not answered by a
  restart: the incident keeps the queue stopped until a person does what it asks and acknowledges it
  in the record (`"acknowledgement": { "at": …, "note": … }`), so a restart neither starts a fresh
  worker nor silently resets the bound the incident already spent. An acknowledgement answers the
  thing it is newer than and nothing else, so one a person made for an earlier hold — the
  process-tree reconciliation, chiefly — never resolves a request the incident concluded after it.

### What an incident records, and what it publishes

One incident is one stopped episode. It keeps the stop evidence (the exit code or signal, the
failure's identity, and the incident whose resumed work the stopped worker was carrying out), one
entry per recovery attempt with the agent's own `outcome.json` behind it, the attempt that is in
flight while it is in flight, the conclusion (`repaired`, `blocked`, or a request for human help),
the ticket the recovery identified, the work the conclusion still owes, the moment the queue
really resumed, and the publication identities of its report — the one describing the conclusion it
holds, with any publication an earlier conclusion had kept beside it.

The report is written into the ticket's own thread by the same service account that wrote the
ticket — so both the next developer turn and the next reviewer turn read it in the shared history
of §9, as a complete incident record beside that account's own comments — and one summary of each
conclusion it reports is published through the configured topic. An unscoped `run`/`watch` stop has no ticket of its own, so
the recovery turn names the item it investigated in its judgment (`"ticket": { "key": … }`) and the
report goes into that thread; a wrong ticket is worse than none, so a judgment that names one this
harness cannot address produces no judgment at all.

A report describes one conclusion, and its own first line says which. An incident concludes once,
but a conclusion can change: a blocker the recovery ranked first, whose own worker settled without
its ticket ever reaching the status that resumes the interrupted work, ends in a request for a person
instead. The conclusion the incident holds then is published on its own — a comment under its own
identity in the thread, and a summary of its own through the topic, whose text carries what the
incident concluded and the actionable detail it asks for — while what the earlier conclusion
published is kept as what it was and shown in the incident's history. Nothing is published twice:
the state names the conclusion it describes, so a publication that describes another conclusion is
never taken for this one's and this one's is never taken for the earlier one's.

A restart finishes what an interrupted invocation left, and never publishes anything twice. The
comment is looked for in the ticket's thread by its own identity before another is posted, and the
email summary is recorded as `pending` **before** the publisher runs, together with the label of
that attempt's own log files: a restart that finds
`pending` reads that attempt's own output — the acknowledgement the CLI printed there is the
evidence — and adopts it when it is there. An acknowledgement found under another attempt's label
belongs to another publication — an earlier conclusion's summary, when the incident concluded
again — and is never read as this one's delivery: the request a person has to act on would then be
marked sent without anything of it having left the machine. When the named attempt acknowledged
nothing, the summary is recorded as `interrupted` and a
person checks the topic, because a second email for one incident is worse than an unconfirmed one.
Only a publication that really failed is retried, and retrying a publication never repeats the
recovery that came before it. What "really failed" means is read from the publisher's own output and
its ending together: a publisher that prints the identity the topic gave it and *then* times out, is
signalled, or fails to have its log closed has still published the summary, and that identity is
adopted whether or not the process reported success. Only a publisher that could not be started at
all proves nothing was sent; one that ran and acknowledged nothing is recorded as `interrupted` and
left to a person, exactly like one an earlier invocation left in flight, whatever exit code it wore
— a transport failure after the topic accepted the request and one that was never made look the same
from here, and a second email is worse than an unconfirmed one. A publication problem is recorded on
the incident and named to the operator; it never turns a successful recovery into a failed one.

### When a failure is the same failure

An exit code is conventional: `queue run` exits `1` for a stopped ticket, a broken configuration,
and an unrelated failure alike, and an unscoped worker could be failing on any ticket at all. So
the one repetition the supervisor does not investigate is read from evidence, not from the ending:
the previous incident concluded `repaired` or `blocked`, the work that stopped again is exactly the
work that recovery resumed — a ticket the supervisor can name — the worker left no new run evidence
behind, and the ending is the same one. Only then does the supervisor conclude that another attempt
would spend the same work for the same result, publish the incident, and ask for a person.

What counts as run evidence is a run the queue really finished — a run directory holding the run's
own report — and never the bare appearance of a directory: a worker that creates its run directory
and then dies on the same operational problem leaves one behind on every pass, and reading that as
progress would make an unchanged failure look like work forever.

A repetition is also read from what two recoveries investigated: where the queue really ran something
in between (a run that reached its own report), where the two attempts judged the work to belong to
the same ticket, and where this attempt's `cause` is the cause the earlier recovery reported
repaired, another attempt would spend the same work for the same result, and the incident ends in
the same actionable request for a person.

Everything else is investigated, including a repeated unscoped failure. What bounds that case is
the same evidence over a chain: each incident records whether the worker it resumed left any run
evidence behind, so a queue that stops `maxAttempts` times in a row without doing anything at all —
every one of those stops already investigated by a recovery turn — ends in an actionable request
for human help instead of another attempt.

These bounds belong to the stop, not to the invocation that happened to watch it: an invocation
that stopped between writing its worker's ending down and recording the incident leaves that ending
in the pointer, and the restart that adopts it decides it through the same evidence — the same
repetition test, the same chain of barren stops, and the same actionable request for a person when
either bound is reached. A crash there cannot turn one escalation into an endless series of
recovery turns.

### Exits

| Exit | Meaning |
| --- | --- |
| `0` | The worker settled, or a watch-mode worker ended cleanly. |
| `1` | An incident needs a person — an unrecoverable judgment, an exhausted bound, a failure returned unchanged after a repair, or a queue that stopped repeatedly without doing any work at all — or an input, configuration, or publication error stopped the supervision. The incident record names what to fix. |
| `2` | Usage error: unknown intent or option, a missing `--config`/`--repo`, or `supervise ticket` without a key. |
| `130` | The operator interrupted the supervision. The worker was stopped, the evidence was kept, and nothing was recovered. |

## External references

These references describe the external Jira API and authentication contracts.

[W1]: https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/
[W2]: https://support.atlassian.com/atlassian-cloud/kb/401-unauthorized-error-when-service-account-accesses-jira-or-confluence-api/
[W3]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
[W4]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
[W5]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
[W6]: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/

[W7]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables
