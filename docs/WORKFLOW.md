# Workflow and inputs

This is a human-readable reference, **not runtime configuration**. The application reads ordinary JSON. There is no Markdown front-matter parser, custom workflow language, profile registry, or compatibility migration from the previous design.

## 1. Configuration

The scaffold must create `harness.config.json` at the repository root with this example:

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

These are **target-project commands**, not the harness's own CI pipeline. Users edit them for each project; the example assumes an npm project with the named scripts. They must not use interactive/watch modes.

All six fields are required; reject unknown fields and invalid types rather than coercing them:

| Field | Meaning and validation |
| --- | --- |
| `workDir` | Nonblank output directory. Resolve relative to the configuration file, not the target repo. |
| `maxRepairs` | Nonnegative integer; additional coding turns after implementation. |
| `taskTimeoutMinutes` | Positive integer; total run time limit. |
| `commandTimeoutMinutes` | Positive integer; per setup/check command limit, capped by remaining task time. |
| `setup` | Array of command argument arrays; may be empty. Run before baseline and before each post-agent check round. |
| `checks` | Nonempty array of command argument arrays; all checks are required. |

A command is a nonempty string array whose first item is a nonblank executable. Subsequent arguments are literal strings, including empty strings when intentional. Do not concatenate task text into commands or implicitly interpolate environment variables. Use a platform-appropriate launcher that preserves arguments; document unsupported platforms instead of assuming Unix shell behavior.

All commands execute in the task working copy. Load configuration once before execution. Credentials and model account setup are not JSON fields.

## 2. Task

Create `examples/task.json` with this example:

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

Require all four fields and reject unknown fields. Text fields must be nonblank strings; `acceptanceCriteria` must contain at least one nonblank string. The task ID is a label, never a filesystem path or shell argument assembled into a command.

Acceptance criteria guide implementation and human review. This version does not automatically turn prose into trusted acceptance tests.

## 3. CLI boundary

**Implemented by the scaffold:**

```sh
npm run dev -- --help
npm run dev -- check-config --config harness.config.json --task examples/task.json
```

`check-config` reads and validates both JSON files, resolves `workDir`, and prints useful errors with file/field context. It creates no directories, runs no commands, calls no agent, and needs no provider credentials. Valid input exits 0; invalid input, unknown options, or file-read errors exit nonzero. No arguments display help.

**Implemented later, not during scaffolding:**

```sh
npm run dev -- run --repo ../target-project --config harness.config.json --task examples/task.json
```

CLI file paths and `--repo` resolve from the invocation's current directory; `workDir` resolves from the config file's directory. The future `run` command checks that the source is a suitable local Git repository and that source/output paths do not overlap unsafely. When targeting the harness repository itself, select a `workDir` outside that source repository. Static `check-config` does not claim to verify Git, installed commands, authentication, or execution safety.

The scaffold should reject `run` clearly as not implemented, not pretend to execute it.

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
```

A red baseline, setup/launch error, expired timeout, cancellation, or exhausted repair allowance stops the loop and preserves work. Checks are rerun by the harness, regardless of what the agent says. See [spec.md](spec.md) for report and safety semantics.
