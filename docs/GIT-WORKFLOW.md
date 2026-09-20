# Git workflow

Small, boring, and the same for every task in this repository.

This describes how a **person** (or a coding agent working in this repository, authenticated as the
person) changes the harness itself. It is not about target projects. The two disciplines are
separate on purpose.

A harness *run* leaves its work in the retained working copy: the local commits a coding turn makes
there are part of that retained work, and a coding turn never pushes, publishes, merges, opens a
pull request, or changes Jira status. By default the harness does not push or publish anything
either ([docs/spec.md](spec.md) §1, [docs/WORKFLOW.md](WORKFLOW.md) §4). Two independently
optional, explicitly configured steps change what the harness's own deterministic integration path
does, never what a coding turn does. With `delivery`, the harness pushes a passed attempt's branch
and opens or updates its pull request ([docs/spec.md](spec.md) §7,
[docs/WORKFLOW.md](WORKFLOW.md) §8). With review-to-completion, it arms native GitHub auto-merge,
verifies the configured post-merge workflows on the merge commit, and transitions the Jira item
([docs/spec.md](spec.md) §10, [docs/WORKFLOW.md](WORKFLOW.md) §10). GitHub performs any merge under
branch protection; the harness never merges the pull request itself, force-pushes, bypasses
protection, or reruns a workflow. A configuration that enables neither step leaves the work in the
retained workspace, as before.

That holds when a run's target is this repository itself: the run works in its own retained clone,
its coding turn commits locally at most, and whatever the configured integration path does is
governed by the sections above, not by the loop below. The loop below is still how changes to this
repository's `main` are landed: one `task/<name>` branch, a pull request, green checks, and a merge
made by the operator, or by an agent using the operator's own credentials. Nothing in this document
configures or governs a harness run, and nothing about a run shapes this loop. They are separate on
purpose; an earlier iteration of this file blurred them and produced a workflow that merged its own
pull requests.

## The rule

- `main` is the integration branch. It should always be in a state where `npm run validate` passes.
- **Never commit directly to `main`.** One task, one branch, merged through a pull request.
- Branch names are short and task-shaped: `task/<name>`, for example `task/jira-task-source`.
- Delete the branch after it is merged. `main` only moves forward by merging a branch.
- **No workflow writes.** `.github/workflows/ci.yml` is the gate and holds `contents: read`: it
  never pushes, never opens a pull request, never approves one, and never merges one. It is the only
  workflow in the repository.

Why the last rule is not a style preference: a pull request opened with a workflow's own token gets
a `pull_request` run that GitHub holds for a *person's* approval, and a merge made with that token
starts no further workflows. Neither problem exists when a person-shaped identity does the work, so
the merge belongs to the operator's own account — the person, or an agent authenticated as them.

## The loop

```sh
git switch main
git pull                     # start from the current main
git switch -c task/short-name

# ... work, in as many commits as the task needs ...
npm run validate             # format, lint, typecheck, build, tests — the gate CI runs

git push -u origin task/short-name
gh pr create --fill --base main
gh pr checks --watch         # the pull request's own run is the gate
gh pr merge --squash --delete-branch

git switch main
git pull
```

An agent working on a task runs exactly these commands, the merge included, when the task asks it to
land the change. `gh` is authenticated as the operator, so the pull request, its CI runs, and the
merge all belong to the operator's identity. Nothing in the repository merges anything.

A conflict between the branch and `main` — the branch was cut before an earlier task merged, and
both touched the same lines — is resolved on the branch, by whoever owns the change, and the checks
run again on the result. There is no automation here to rebase or to guess.

## What a pull request needs

- **Green CI.** `.github/workflows/ci.yml` runs `npm ci` and `npm run validate` on `ubuntu-latest`,
  once on the pull request and once more on the push of the merged commit to `main`. A red gate
  means the PR is not ready. Do not disable
  checks, weaken assertions, or hide files from validation to get a green run.
- **The app-owned review check.** This repository's `main` is configured to require the
  `Nexus Lens review` check from the `nexus-lens` GitHub App (app id `5001141`) beside the
  `validate` check, with no required approving-review count. The check is published only by that
  App installation, and only on a reviewed head: the optional `review scan` path publishes it for
  an `In Review` ticket whose work has a clearly identified open pull request
  ([WORKFLOW.md](WORKFLOW.md) §9), and the coordinator publishes it through the same installation
  for a branch no ticket points at. A workflow token never publishes it — that identity is the
  whole point of the rule — and the rule is not disabled or bypassed to merge a pull request.
- **A description a reviewer can act on:** what changed, why, what you ran, and what you could not
  verify. `notes/` and `README.md` record the honest gaps; the PR should point at them rather than
  restate them.
- **No human reviewer is required.** This is a one-person project: you may open a PR with nobody
  requested and merge it yourself once both checks are green. The point of the PR in this
  repository is a place where the checks run and where the change and its evidence are written
  down, not a second pair of eyes — the App-owned check records a review verdict, it does not
  replace a person's judgment.
- **No force-pushing to `main`,** and no rewriting a `main` commit that has been pushed.

## Emergency path

If you must change `main` without a branch — a broken CI workflow, a typo in a document nobody
depends on — say so in the commit message, keep it to one commit, and run `npm run validate` before
and after. This is an exception, not a second workflow.
