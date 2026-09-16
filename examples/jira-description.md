# Example Jira description

This is the description format a Jira issue must use for a `source` command to take it. Jira stores
it as Atlassian Document Format, not as Markdown: the editor below is what the harness reads, and
this file is the readable rendering of it. `docs/WORKFLOW.md` §6 is the contract.

Only the `Acceptance criteria` heading has extraction semantics — it becomes
`Task.acceptanceCriteria`, one entry per top-level list item, and the rest of the description is
context for the coding turn and for your review. `Goal`, `Verification`, and `Constraints` are a
convention for human readers: they are kept in the task description and are never turned into
commands, checks, or configuration.

```markdown
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
```

What such an issue becomes, once fetched:

```json
{
  "id": "SAM1-11",
  "title": "Create the harness smoke-test marker",
  "description": "## Goal\nCreate HARNESS_SMOKE_TEST.md at the repository root.\n…",
  "acceptanceCriteria": [
    "HARNESS_SMOKE_TEST.md exists at the repository root.",
    "Its bytes are exactly the required text plus one LF newline.",
    "No other tracked or untracked project files are changed."
  ]
}
```

The `Verification` section is for people and for the coding turn. It does **not** become a check:
the harness still runs the `checks` from its own configuration, and `passed` keeps its existing
meaning — the configured checks exited `0` for the retained working copy.
