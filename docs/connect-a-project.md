# Connect a project to Nexus

This is the canonical project-onboarding path. It is written for an integration agent working
inside an existing project repository while an existing Nexus installation is available. By the
end, the project is connected, the connection is validated, and Nexus is started through a finite
queue run — without configuring anything inside Nexus.

The project adds **exactly one committed file**: `nexus.project.json` at the repository root.
Everything Nexus needs at runtime it creates for itself. The operator's shared harness
configuration and the Nexus installation stay as they are.

| Placeholder | Means |
| --- | --- |
| `<NEXUS_HOME>` | the existing Nexus installation: the checkout of this repository that holds the CLI (`package.json`) |
| `<SHARED_CONFIG>` | the operator's Nexus-wide harness configuration file — the one every command is given as `--config`, typically `nexus.config.json` |
| `<PROJECT_ROOT>` | this project repository's root: the directory that gains `nexus.project.json` |

Replace all three before running anything, and keep them absolute. `npm --prefix` runs the script
with `<NEXUS_HOME>` as its working directory, so a relative path would resolve there instead of
where you are standing. Quote a path that contains spaces. The commands below use `npm run dev`,
which runs the CLI from TypeScript sources through the installation's `node_modules` and needs no
build; nothing here writes inside the Nexus checkout. If the installation was never installed
(`<NEXUS_HOME>/node_modules` is missing), run `npm --prefix <NEXUS_HOME> ci` once first: that is
installation setup, not project configuration.

## What the project owns, and what it does not

`nexus.project.json` carries only the fields the project itself can answer. Copy
[nexus.project.example.json](nexus.project.example.json) and fill it in; this repository's own
[nexus.project.json](../nexus.project.json) is a real connected project's file to compare against.

| Field | The project's own answer | Contract |
| --- | --- | --- |
| `setup` | the commands that prepare a fresh clone, for example `[["npm", "ci"]]`; may be empty | [WORKFLOW.md](WORKFLOW.md) §1 |
| `checks` | the commands that decide a task; at least one, every one required | [WORKFLOW.md](WORKFLOW.md) §1 |
| `source` | its Jira queue: site, cloud ID, project key, issue type, label, statuses, ordering, credential variable name | [WORKFLOW.md](WORKFLOW.md) §5 |
| `delivery` | its GitHub destination: `repository` and `baseBranch` | [WORKFLOW.md](WORKFLOW.md) §8 |
| `delivery.completion` | what a verified completion means here: `postMergeWorkflows`, `toDoStatus`, `doneStatus` | [WORKFLOW.md](WORKFLOW.md) §10 |

Everything else belongs to the shared harness configuration and is **not** repeated in the project
file: `workDir`, `maxRepairs`, `taskTimeoutMinutes`, `commandTimeoutMinutes`, `agent`, `escalation`,
`reviewer`, and `completion`. A field written into the wrong file is refused, with both paths
named, before anything is claimed or run ([WORKFLOW.md](WORKFLOW.md) §1). The integration agent
does not edit that file, does not choose `workDir`, and does not manage Nexus runtime storage.

**No workspace or runtime folder needs to be created.** Nothing under the shared `workDir` has to
exist beforehand, and you never create it by hand. On the first run Nexus creates and owns the
retained workspace (the clone on its own `harness/<workspaceId>` branch, beside a ledger), the run
evidence (`<workDir>/runs/<runId>` with `result.json` and `logs/`), the intake receipts, the review
evidence under `<workDir>/reviews/`, and the completion evidence it needs. Do not copy those
directories between machines, and do not delete a workspace whose pull request is still awaiting
review. `check-config` prints the resolved `workDir` before anything runs, so you can see where
Nexus will write without creating it.

## Prerequisites

1. **A clean project checkout on the base branch.** `--repo` names the operator's own checkout of
   the delivery repository's base branch. It must be a normal Git checkout with at least one commit
   and no staged, unstaged, or non-ignored untracked work (`git status --porcelain` empty). Commit
   `nexus.project.json` on that branch and push it: the queue clones each workspace from what this
   checkout holds and re-reads the project's configuration there.
2. **Real, noninteractive `setup` and `checks` commands.** Run them once by hand in a clean clone of
   the committed baseline and make sure they pass there. They must run unattended on this machine:
   no prompts, no interactive or watch modes, no browser, no credentials of their own. `setup` may
   be empty; `checks` cannot, and a red baseline stops a fresh attempt before any coding turn, so a
   project that is already red cannot be connected this way.
3. **The Jira queue.** Decide the site URL (`https://<site>.atlassian.net`), the site's cloud ID,
   the project key, the issue type (`Task` by default), the label (`harness-task` by default — keep
   it distinctive), and the ready, running and review statuses (`To Do` → `In Progress` →
   `In Review` by default; they must be distinct). Then choose the intake order deliberately:
   `"ordering": "priority"` puts Jira's Priority field first (the default), while
   `"ordering": "rank"` follows the board's native Rank, so the manual board order decides. With
   `rank`, the project's issues must really be ranked on a board and the service account must be
   allowed to read Rank; there is no fallback to Priority. The label in the ready status is the
   authorization to spend agent capacity, so only label tickets this project is meant to work. The
   service account needs project access plus the classic scopes `read:jira-work` and
   `write:jira-work` ([WORKFLOW.md](WORKFLOW.md) §5).
4. **The first ticket's description.** Write it in the format of [WORKFLOW.md](WORKFLOW.md) §6
   (`examples/jira-description.md` is a ready template): the `Acceptance criteria` heading decides
   what the agent is asked to satisfy. An issue that does not fit the format is reported and
   skipped, never guessed at.
5. **The GitHub destination.** Decide the repository (`owner/name`) a passed attempt's branch is
   pushed to and the base branch its pull request targets. It must be the repository whose base
   branch holds the committed `nexus.project.json`; Nexus Lens reviews the pull request this
   project delivers, and the completion path merges it there.
6. **The merge gate and the Nexus Lens App.** The operator's own account must be able to enable
   auto-merge on the destination, and the destination's branch rule must require the checks that
   gate the merge — including the App-owned review check, named from that App the way the rule UI
   shows it. The Nexus Lens App must be installed on that repository with pull-request write,
   checks write, and read access to contents, commit statuses, and metadata
   ([WORKFLOW.md](WORKFLOW.md) §9).
7. **The post-merge workflows, and the statuses they lead to.** Name every workflow that has to
   succeed after the merge — a workflow file name (`ci.yml` or `.github/workflows/ci.yml`) or a
   numeric workflow ID — as a `push` run on the delivery repository's base branch. A name that
   never matches a run for the merge commit means the ticket never reaches Done. Also name the two
   statuses a completion outcome lands in: `toDoStatus` for definitive findings, `doneStatus` for a
   verified completion; neither may equal the other or `source.reviewStatus`
   ([WORKFLOW.md](WORKFLOW.md) §10).
8. **Credentials in the environment — names in the files, values only in the environment.** The
   shell that starts Nexus needs:
   - the Jira service-account API token in the variable `source.tokenEnv` names (default
     `JIRA_API_TOKEN`);
   - the **path** of the Nexus Lens App's private key PEM file in the variable the shared
     configuration's `reviewer.app.privateKeyPathEnv` names (the example file uses
     `NEXUS_LENS_PRIVATE_KEY_PATH`): a path the OS user running Nexus can read, never the key's
     contents;
   - the operator's own `gh`/Git login, authenticated for the destination repository
     (`gh auth status`, and `gh auth setup-git` so Git uses it). That credential pushes the branch,
     opens the pull request, and asks GitHub for auto-merge; it is never given to a coding or
     reviewer turn.

   The shared configuration also names `completion.reviewerTokenEnv` for standalone `source`
   commands; a queue run does not need a pre-minted value there, because it reads completion
   evidence with the App's installation token ([WORKFLOW.md](WORKFLOW.md) §11). Never commit a
   token, a key, a key path, or any other credential value into the project: the repository gains
   exactly `nexus.project.json`.
9. **A first queue to work with.** Have one or more Jira items that match the configured project,
   issue type, label, and ready status. To constrain a first run, use one disposable ticket and a
   label only it carries; the queue claims what the ready status and label describe, so nobody else
   should be using them.

## Connect, validate, start

Three commands, in order, each with a different reach. Run them from anywhere; every path in
`<…>` is absolute.

### 1. Validate the composition — static, claims nothing

```powershell
npm --prefix <NEXUS_HOME> run dev -- check-config --config <SHARED_CONFIG> --project <PROJECT_ROOT>
```

`check-config` composes the shared file and the project file and prints what it read: the resolved
`workDir`, the limits, the reviewer and completion policy, then the project's `setup` and `checks`
counts, its Jira queue, the configured ordering and delivery destination, and the review lines they
compose. It creates nothing, runs no configured command, contacts no provider, and resolves no
credential. Exit `0` means the two files are valid and compose; exit `1` names the file, the field,
and — for a cross-file problem — both paths. It proves nothing about Git state, runtime
availability, or authentication.

Read the printed `workDir` line. It must be outside `<PROJECT_ROOT>`; if it is inside the project,
stop and ask the operator to fix the shared file rather than editing it here.

### 2. Preview the queue — read-only, claims nothing

```powershell
npm --prefix <NEXUS_HOME> run dev -- source list --config <SHARED_CONFIG> --project <PROJECT_ROOT>
```

This command contacts Jira with the credential `source.tokenEnv` names and prints every eligible
issue with its disposition (`valid`, `continuable`, `refused`, `invalid`, or `stale`), key, title,
URL, and a detail line, in the configured order. It claims nothing, starts no run and no coding
turn, and creates no directory. Exit `0` with `source list: 0 eligible issue(s)` is a valid answer:
the connection works and the queue is empty. A `refused` or `invalid` disposition names what to fix
before a run would take the ticket ([WORKFLOW.md](WORKFLOW.md) §7).

### 3. Start a finite queue run — claims and executes eligible work

```powershell
npm --prefix <NEXUS_HOME> run dev -- queue run --repo <PROJECT_ROOT> --config <SHARED_CONFIG>
```

This is the command that works: it can claim eligible Jira items, start coding turns, push
branches, open pull requests, publish Nexus Lens reviews, arm auto-merge, merge, and move Jira
items. `queue run` is finite — it exits `0` when a fresh scan finds no eligible ticket — and exits
`1` when it needs a person, keeping the evidence it gathered ([WORKFLOW.md](WORKFLOW.md) §11). Leave
it in the foreground: Ctrl+C (Ctrl+Break on Windows) stops it after the active phase, starts no
next ticket, and keeps everything it wrote.

If you want to watch one ticket through the coding loop and delivery before handing the queue a
whole set, `source run --repo <PROJECT_ROOT> --config <SHARED_CONFIG> --limit 1` claims at most one
ticket and also runs the configured completion pass, so it needs the value of
`completion.reviewerTokenEnv` as well; it does not run the Nexus Lens review. The queue is the path
that does the whole lifecycle.

## What happens after Nexus starts

From here Nexus is autonomous, one ticket at a time, and needs no further setup:

1. A fresh scan takes at most one eligible ticket and creates the retained workspace itself — the
   clone, its `harness/<workspaceId>` branch, the repository-local Git identity, the receipt before
   the claim, and the `harness-ws-<workspaceId>` pointer label on the issue.
2. The baseline round runs `setup` and every `check`; a red baseline stops a fresh attempt before
   any coding turn. A green baseline starts the implementation turn, and a completed red round
   starts repair turns within the shared ladder instead of giving up.
3. A passed attempt is delivered: its branch is pushed and its pull request opened or updated with
   the operator's own Git/`gh` credential.
4. Native auto-merge is armed for that exact head before Nexus Lens reviews it, and the review
   publishes the native verdict plus the App-owned check.
5. Completion verifies the recorded arm, waits for GitHub's own merge, requires every configured
   post-merge workflow to succeed on the merge commit, and comments on the ticket before moving it
   to `doneStatus`. Findings move it back to `toDoStatus` and the queue repairs it in the same
   retained workspace before touching unrelated work.
6. Source readiness fetches the base branch, proves the checkout is clean and on the right remote,
   and fast-forwards it to the verified merge commit. Then the next fresh scan runs.

`queue run` stops when no eligible ticket remains. `queue watch` is the same loop as one visible
foreground process that waits for the next ticket; it starts no agent while it is idle.

**Concurrency.** One consumer may run for this project, while other connected projects use their
own `nexus.project.json` and their own Jira scope under the same shared configuration and
`workDir`. The intake lock is per connected project, not per output directory: a second
`queue run`/`queue watch` for the same project and `workDir` is refused with the lock owner's
diagnostic, and a queue for a different connected project starts normally. Do not work around that
refusal by deleting a lock; resolve the other consumer first ([WORKFLOW.md](WORKFLOW.md) §1,
[spec.md](spec.md) §6).

## Troubleshooting

| Symptom | Cause, and what to do |
| --- | --- |
| Exit `1`: `the environment variable <name> is missing or blank. Put the Jira service-account API token in it…` | The variable `source.tokenEnv` names is not set in the shell that runs Nexus. Set it there (never in the project, never in a config file). `check-config` does not catch this: it resolves no credentials. |
| Exit `1`: `the environment variable <name> is missing or blank. Put the path of the GitHub App's private key PEM file in it…` | The shared configuration's `reviewer.app.privateKeyPathEnv` is not set (or is blank). Set the **path** in the shell that runs Nexus, and make sure the file is readable by that user. The key's contents never belong in any file this repository commits. |
| `source list: 0 eligible issue(s)`, or `queue run: no eligible ticket` | Nothing matches the configured queue: project key, issue type, label, and ready status. Check the spelling of each, that the ticket is in the right project and status, and — for `invalid` entries — that its description has the `Acceptance criteria` section. `queue run` exiting `0` here is a drained queue, not a failure. |
| Jira refuses the search because Rank is unavailable | `"ordering": "rank"` requires the project's issues to be ranked on a board and the service account to be allowed to read Rank. Fix the board or the access, or switch to `"ordering": "priority"`; the harness never falls back to Priority by itself. |
| Delivery or review refused (`gh auth status`, no commit to publish, a dirty or wrongly checked-out workspace, no open pull request) | Delivery needs the operator's authenticated `gh`/Git account with write access to the destination repository and base branch, and a retained workspace that is clean, on its recorded branch, and holds a commit beyond its base. Review needs the Nexus Lens App installed on that repository, the key path readable, and exactly one open pull request for the ticket's branch. Uncommitted work is refused, never committed for you. |
| Completion keeps waiting, or reports an unsuccessful post-merge workflow | The names in `delivery.completion.postMergeWorkflows` must match workflows that really run for `push` on `delivery.baseBranch` on this repository — the exact file name or numeric ID. Check the repository's Actions tab for a run on the merge commit. A definitive failure returns the ticket to `toDoStatus`; a run that never appears leaves it In Review. |
| `queue run` refuses before it starts: the shared file has no `reviewer` object, or the project's `delivery` has no `completion` | The queue needs the whole path — the project's `source` and `delivery.completion`, and the shared configuration's `reviewer`. `check-config` alone does not require them, so it can be green while a queue command is refused. Ask the operator for the missing installation-level objects, and add only `delivery.completion` in the project file; never copy the reviewer into it. |
| `check-config` refuses a field and names the other file | Field ownership: `workDir`, the limits, `agent`/`escalation`, `reviewer`, and `completion` belong to the shared configuration; `setup`, `checks`, `source`, and `delivery` belong to `nexus.project.json`. Move the field to the file that owns it; do not duplicate it or work around the refusal. |

## Where the details live

- The field-by-field contract, ownership, and precedence: [WORKFLOW.md](WORKFLOW.md) §1, with the
  Jira fields in §5, delivery in §8, completion in §10, and the queue commands in §11.
- Behaviour and limits: [spec.md](spec.md) §6 (intake), §7 (delivery), §10 (completion), and §11
  (the serial queue).
- Ready-to-copy inputs: [nexus.config.example.json](nexus.config.example.json) for the operator's
  shared file, [nexus.project.example.json](nexus.project.example.json) for this project's file,
  and [examples/jira-description.md](../examples/jira-description.md) for the issue format.
- The operating document for the person running the installation:
  [README.md](../README.md).
