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
gh pr create --fill --base main
# wait for CI
gh pr merge --squash --delete-branch

git switch main
git pull
```

## What a pull request needs

- **Green CI.** The `ci.yml` workflow runs `npm ci` and `npm run validate`; a red gate means the PR
  is not ready. Do not disable checks, weaken assertions, or hide files from validation to get a
  green run.
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

## Optional automation

With the GitHub CLI authenticated (`gh auth status`), the steps above are two commands and can be
scripted:

```sh
gh pr create --fill --base main            # opens the PR, no reviewer requested
gh pr merge --squash --delete-branch --auto   # merges when the required checks pass
```

`--auto` works when branch protection requires the CI check to pass, so the merge happens on its
own once CI is green. GitHub Actions can go one step further and open the PR for you when a
`task/**` branch is pushed (for example with the `peter-evans/create-pull-request` action). Two
caveats: a pull request opened with the default `GITHUB_TOKEN` does not trigger other
`pull_request` workflows, so use a separate token if CI must run on the PR, and auto-merge still
requires the check to be required by branch protection — otherwise there is nothing to wait for.
