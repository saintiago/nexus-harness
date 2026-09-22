# Connect a project to Nexus

This guide is for an integration agent working in one project repository. It assumes an already
installed Nexus runtime that is prepared and operated outside the project. The installation
supplies its own shared configuration, credentials and delivery/review setup; none of that is
project configuration, and none of it is covered by this guide.

By the end, the repository has one committed file, `nexus.project.json`, and the connection has
been validated and exercised with `check-config`, `source list` and a finite `queue run`.

| Placeholder | Means |
| --- | --- |
| `<NEXUS_HOME>` | the existing Nexus installation checkout that holds the CLI (`package.json`) |
| `<NEXUS_CONFIG>` | the Nexus-wide configuration path supplied by that installation; use it, do not edit it |
| `<PROJECT_ROOT>` | this project repository's root: the directory that gains `nexus.project.json` |

Use absolute paths, and quote any path that contains spaces. `npm --prefix` runs the CLI through
the installation's own dependencies, so the installation must already be prepared. If a command
reports that the installation is incomplete, stop and hand the exact error back to the Nexus
operator: that is a Nexus environment/setup error, not part of connecting the project.

## What the project owns

The project adds **exactly one committed file**: `nexus.project.json` at the repository root. Copy
[nexus.project.example.json](nexus.project.example.json) and fill it in. This repository's own
[nexus.project.json](../nexus.project.json) is a real connected project's file to compare against.

| Field | The project's own answer | Contract |
| --- | --- | --- |
| `setup` | the commands that prepare a fresh clone, for example `[["npm", "ci"]]`; may be empty | [WORKFLOW.md](WORKFLOW.md) §1 |
| `checks` | the commands that decide a task; at least one, and every one is required | [WORKFLOW.md](WORKFLOW.md) §1 |
| `source` | its Jira queue: site, cloud ID, project key, issue type, label, statuses and ordering | [WORKFLOW.md](WORKFLOW.md) §5 |
| `delivery` | its GitHub destination: repository and base branch | [WORKFLOW.md](WORKFLOW.md) §8 |
| `delivery.completion` | what a verified completion means here: post-merge workflows, and the statuses a completion or a finding lands in | [WORKFLOW.md](WORKFLOW.md) §10 |

Everything else belongs to the installed Nexus environment. The project file carries no
installation policy or credentials, and the integration agent does not edit the Nexus-wide
configuration, create installation resources, or manage the installation's secrets. A field
written into the wrong file is refused, with both paths named, before anything is claimed or run
([WORKFLOW.md](WORKFLOW.md) §1).

## Prepare the project

These are the project-side choices and checks. Installation-wide setup is already done by the
Nexus operator.

1. **A committed `nexus.project.json` on the delivery base branch.** `--repo` names the operator's
   checkout of the delivery repository's base branch. It must be a normal Git checkout with at
   least one commit and no staged, unstaged or non-ignored untracked work
   (`git status --porcelain` empty). Commit the file on that branch and push it: queue workspaces
   clone from what that checkout holds and read the project's configuration there.

2. **Real, noninteractive `setup` and `checks` commands.** Run them once in a clean clone of the
   committed baseline and make sure they pass there. They must run unattended: no prompts, no
   interactive or watch modes, and no browser. `setup` may be empty; `checks` must contain at
   least one command. A `setup` or check command that rewrites a tracked file, or leaves a commit
   behind, is refused as incomplete evidence rather than treated as a successful baseline.

3. **The Jira queue.** Decide the site URL, the site's cloud ID, the project key, the issue type
   (`Task` by default), the label (`harness-task` by default, but keep it distinctive), and the
   ready, running and review statuses (`To Do` → `In Progress` → `In Review` by default; they must
   be distinct). Then choose the intake order deliberately: `"ordering": "priority"` follows
   Jira's Priority field (the default), while `"ordering": "rank"` follows the board's native
   Rank; rank has no fallback to Priority. The label in the ready status is the authorization to
   spend agent capacity, so only label tickets this project is meant to work.

4. **The first ticket's description.** Write it in the format of [WORKFLOW.md](WORKFLOW.md) §6
   ([examples/jira-description.md](../examples/jira-description.md) is a ready template): the
   `Acceptance criteria` heading decides what the agent is asked to satisfy. An issue that does
   not fit the format is reported and skipped, never guessed at.

5. **The GitHub destination and merge gate.** Decide the repository (`owner/name`) a passed
   attempt's branch is pushed to and the base branch its pull request targets. It must be the
   repository whose base branch holds the committed `nexus.project.json`. The destination's branch
   protection must already require the installation's configured review result and permit the
   configured auto-merge path; name every post-merge workflow that has to succeed on the base
   branch. The current queue path requires a public repository with publicly readable post-merge
   workflow evidence. If the destination or its gate is not prepared, stop and report it to the
   Nexus operator rather than changing repository visibility, the branch rule, or the shared
   configuration.

6. **A first queue to work with.** Have one or more Jira items that match the configured project,
   issue type, label and ready status. For a first run, use one disposable ticket with a label
   only it carries. The queue claims what the ready status and label describe, so nobody else
   should be using them.

## Connect, validate, start

Three commands, in order, each with a different reach. Run them from anywhere; every path in
`<…>` is absolute.

### 1. Validate the composition — static, claims nothing

```powershell
npm --prefix <NEXUS_HOME> run dev -- check-config --config <NEXUS_CONFIG> --project <PROJECT_ROOT>
```

`check-config` composes the installation's Nexus-wide configuration with the project file and
prints what it read. It creates nothing, runs no configured command, contacts no provider, and
resolves no credential. Exit `0` means the two files are valid and compose; exit `1` names the
file, the field and — for a cross-file problem — both paths.

If the refusal names a project field, correct `nexus.project.json`. If it names a missing or
invalid installation prerequisite, stop and report the exact message to the Nexus operator; do
not edit the shared configuration or create installation resources here.

### 2. Preview the queue — read-only, claims nothing

```powershell
npm --prefix <NEXUS_HOME> run dev -- source list --config <NEXUS_CONFIG> --project <PROJECT_ROOT>
```

This command contacts Jira through the installed environment's configured access and prints every
eligible issue with its disposition (`valid`, `continuable`, `refused`, `invalid` or `stale`), key,
title, URL and a detail line, in the configured order. It claims nothing, starts no run and no
coding turn, and creates no directory. Exit `0` with `source list: 0 eligible issue(s)` is a valid
answer: the connection works and the queue is empty. A `refused` or `invalid` disposition names
what to fix before a run would take the ticket ([WORKFLOW.md](WORKFLOW.md) §7).

If Jira refuses the connection because the installed environment is missing access or setup, stop
and report the exact error to the Nexus operator. That is a Nexus environment/setup error; do not
create or edit credentials to work around it.

### 3. Start a finite queue run — claims and executes eligible work

```powershell
npm --prefix <NEXUS_HOME> run dev -- queue run --repo <PROJECT_ROOT> --config <NEXUS_CONFIG>
```

This is the command that works: it can claim eligible Jira items and run them through the
installation's configured coding, check, delivery, review and completion path. `queue run` is
finite — it exits `0` when a fresh scan finds no eligible ticket — and exits `1` when it needs a
person, keeping the evidence it gathered ([WORKFLOW.md](WORKFLOW.md) §11). Leave it in the
foreground: Ctrl+C (Ctrl+Break on Windows) stops it after the active phase, starts no next ticket
and keeps everything it wrote.

If the run does not start because the installation is incomplete, report the exact launch error to
the Nexus operator. Do not create the missing credentials, runtime folders or shared
configuration, and do not try to supply them from the project.

## What happens after Nexus starts

Nexus works the queue one ticket at a time and needs no further project-side setup:

1. A fresh scan takes at most one eligible ticket and runs the project's `setup` and every check.
   A green baseline starts the coding turn; a red one is diagnosed by the installed runtime
   before the ticket is handed on.
2. The installed runtime carries the ticket through coding, delivery, review and completion,
   including the configured post-merge workflow check.
3. The next scan takes the next eligible ticket, and the loop continues until none remains.

`queue run` stops when no eligible ticket remains. `queue watch` is the same loop as one visible
foreground process that waits for the next ticket; it starts no agent while it is idle.

## If setup is incomplete

Any missing installation prerequisite discovered by these commands is a **Nexus environment/setup
error**. Stop, keep the exact command and error text, and hand it back to the Nexus operator. Do
not create credentials, runtime folders or shared configuration, and do not change the project's
committed file to work around an installation problem.

| Symptom | What to do |
| --- | --- |
| `check-config` refuses a field and names the other file | Correct only the project-owned field in `nexus.project.json`; ask the Nexus operator to correct the shared file. |
| `source list` cannot authenticate or reach Jira | Report the exact error. The Jira access is installation setup; do not create or edit credentials. |
| `source list: 0 eligible issue(s)` or `queue run: no eligible ticket` | Nothing matches the configured project, issue type, label and ready status. Correct the project's `source` object, or confirm the ticket is in the right status and its description has the required section. |
| Jira refuses the search because Rank is unavailable | With `"ordering": "rank"`, the project's issues must be ranked on a board. If the installed Jira access cannot read Rank, report the exact error to the Nexus operator; do not change access or permissions. If this project should order by Priority instead, change only the project-owned `ordering` field to `"priority"`. |
| `queue run` refuses before it starts because an installation-side object is missing | Report the exact refusal to the Nexus operator. Add only fields the project owns; never copy installation policy into `nexus.project.json`. |
| Delivery, review or completion cannot start | The destination, gate or installed review/delivery path is not fully prepared. Report the exact error; do not change branch protection, repository visibility or the shared configuration to bypass it. |
| Completion cannot read post-merge workflow evidence | The current path requires a public repository with publicly readable workflow evidence. Report the unsupported destination to the Nexus operator instead of changing visibility. |

## Where the details live

- Field ownership and precedence: [WORKFLOW.md](WORKFLOW.md) §1, with the Jira fields in §5,
  delivery in §8, completion in §10 and the queue commands in §11.
- Behaviour and limits: [spec.md](spec.md) §6 (intake), §7 (delivery), §10 (completion) and §11
  (the serial queue).
- Ready-to-copy inputs: [nexus.project.example.json](nexus.project.example.json) for the
  project-owned file and [examples/jira-description.md](../examples/jira-description.md) for the
  issue format. This repository's own [nexus.project.json](../nexus.project.json) is a worked
  example.
- Installation and operator setup: [Operations](operations.md). That document is maintainer
  material for the person running the installation, including the installation-wide contract;
  its setup sections are not project connection steps.
