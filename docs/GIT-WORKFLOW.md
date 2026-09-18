# Git workflow

Small, boring, and the same for every task in this repository.

This describes how a **person** (or a coding agent working in this repository) changes the harness
itself. It is not about target projects: a harness run never commits, pushes, or merges anything in
the repository it works on.

## The rule

- `main` is the integration branch. It should always be in a state where `npm run validate` passes.
- **Never commit directly to `main`.** One task, one branch, merged through a pull request.
- Branch names are short and task-shaped: `task/<name>`, for example `task/jira-task-source`.
- Delete the branch after it is merged. `main` only moves forward by merging a branch.

## The loop

```sh
git switch main
git pull                     # start from the current main
git switch -c task/short-name

# ... work, in as many commits as the task needs ...
npm run validate             # format, lint, typecheck, build, tests — the gate CI runs

git push -u origin task/short-name
# The workflow takes over here: it opens the pull request, runs the same gate on
# ubuntu-latest, and merges the pull request when the gate passed. A red gate stops
# it before the merge, leaving the branch pushed and `main` untouched.

git switch main
git pull                     # once the merge has happened
```

The same steps by hand, for a branch the workflow did not finish:

```sh
gh pr create --fill --base main           # only if no pull request is open yet
gh pr merge --squash --delete-branch      # only once the gate is green
```

## What a pull request needs

- **Green CI.** Two workflows run `npm ci` and `npm run validate`: `ci.yml` on a push outside
  `task/**`, and `auto-pr.yml` on a push to a `task/**` branch, as the gate in front of its own
  merge. A red gate means the PR is not ready. Do not disable checks, weaken assertions, or hide
  files from validation to get a green run.
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

## The task-branch workflow

`.github/workflows/auto-pr.yml` runs on every push to a `task/**` branch and does the loop above
without a person: it opens the pull request into `main` if none is open, runs `npm ci` and
`npm run validate` on `ubuntu-latest`, and merges with `--squash --delete-branch` only when the
gate passed. A red gate ends the run before the merge step, so the branch stays pushed, the pull
request stays open, and `main` is untouched.

It runs the gate itself instead of using `gh pr merge --auto`, because auto-merge waits for a check
that branch protection has made *required*, and branch protection cannot be enabled here: GitHub
refuses it for this repository with `403 Upgrade to GitHub Pro or make this repository public`. With
no required check there is nothing for `--auto` to wait for, so the workflow validates and merges
in the same run.

When the pull request conflicts with `main` — a branch cut before an earlier task merged, which is
what happens when the same files are touched twice — the workflow rebases the branch onto `main`,
pushes it, and stops there: that push starts the next run, which validates the rebased commit and
merges *that* one. A rebase that conflicts is left to a person, and the run says so. Nothing is
merged that a run did not validate.

It is the only workflow a task branch runs, and that is deliberate. `ci.yml` used to run on pull
requests as well, but a pull request opened by this workflow is opened with the workflow's own
token: GitHub creates that `pull_request` run *held for a maintainer's approval*, the merge then
deletes the branch moments later, and the run expires unapproved — a failed run that validated
nothing (observed on every merged pull request on 2026-09-18, and it is the "required approval"
banner on run `35399153282`). The `pull_request` trigger was removed on 2026-09-19. A same-repo pull
request's head commit is validated by the `ci.yml` push run when the branch is not a `task/**`
branch, and by this workflow's own job when it is; pull requests from forks are not a workflow this
repository uses, and would need their own arrangement.

What it does not do, and must not be read as doing:

- **It does not re-verify `main` after the merge.** A merge made with the workflow's
  `GITHUB_TOKEN` does not trigger other workflows, so `ci.yml` does not run on the merged commit.
  `main` is green because the branch head that was squashed into it passed the gate, not because
  the merged result was tested again.
- **It is not a review.** No reviewer is requested and none is required. The pull request is the
  place where the change and its evidence are written down.
- **It needs a repository setting.** GitHub Actions may create pull requests only while *Allow
  GitHub Actions to create and approve pull requests* is enabled for the repository; it is enabled
  on this one. Without it the step that opens the pull request fails, and nothing is merged.

Two consequences for how a task is pushed:

- Anything pushed as `task/<name>` is merged as soon as it is green. A change that should be read
  before it lands belongs on a branch named something else, with the pull request opened by hand.
- A task branch is validated once, by the workflow that merges it, and the check a reader sees on
  the pull request is that job. It cannot be made a *required* check, so the workflow performs it
  itself and merges only after it passed.
- A push whose commits are all already in `main` — the branch was recreated after a merge landed the
  same work — opens no pull request and merges nothing, and is not a failure: there is nothing left
  to do.
