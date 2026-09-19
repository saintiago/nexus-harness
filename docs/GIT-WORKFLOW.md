# Git workflow

Small, boring, and the same for every task in this repository.

This describes how a **person** (or a coding agent working in this repository) changes the harness
itself. It is not about target projects. The two disciplines point in opposite directions on
purpose: a harness *run* leaves its work in the retained working copy for a person to integrate —
the local commits a coding turn makes there are part of that retained work — and the harness never
merges. A coding turn never pushes, publishes, or opens a pull request; by default the harness does
not either ([docs/spec.md](spec.md) §1, [docs/WORKFLOW.md](WORKFLOW.md) §4). The one exception is
the optional delivery step of [docs/WORKFLOW.md](WORKFLOW.md) §8: when the operator configures it,
the **harness**, not a coding turn, pushes a passed attempt's branch and opens or updates its pull
request, and stops there — the merge is still the loop below. That holds when a run's target is
this repository itself: the run works in its own retained clone, its coding turn commits locally at
most, and only the loop below — run by the operator, or by an agent using the operator's own
credentials — integrates anything. Nothing in this document is a rule about that, and nothing about
that should shape this. They are separate on purpose; an earlier iteration of this file blurred
them and produced a workflow that merged its own pull requests.

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
- **A description a reviewer can act on:** what changed, why, what you ran, and what you could not
  verify. `notes/` and `README.md` record the honest gaps; the PR should point at them rather than
  restate them.
- **No reviewer is required.** This is a one-person project: you may open a PR with nobody
  requested and merge it yourself once CI is green. The point of the PR in this repository is a
  place where CI runs and where the change and its evidence are written down, not a second pair of
  eyes.
- **No force-pushing to `main`,** and no rewriting a `main` commit that has been pushed.

## Emergency path

If you must change `main` without a branch — a broken CI workflow, a typo in a document nobody
depends on — say so in the commit message, keep it to one commit, and run `npm run validate` before
and after. This is an exception, not a second workflow.
