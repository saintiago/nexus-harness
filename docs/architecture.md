# Architecture

Nexus is a local-first TypeScript CLI for implementation, checks, repair, delivery and review.

## Design principles

Keep rules that can be expressed simply and reliably in ordinary code. Use AI where a decision
requires investigation or judgment and deterministic handling would become a growing collection
of special cases. Ownership, execution and verification remain reliable whichever role acts.

Separate decisions from external effects. Coordinators decide what happens next; adapters perform
Git, process and service operations. Use ordinary functions and explicit inputs. Add an abstraction
when it clarifies a real responsibility, not to prepare for hypothetical future work.

The intended recovery direction is a supervisor around Nexus with a separate recovery agent.
This is planned work, not current functionality or a change in permissions. The spec remains
accurate about existing recovery until an implementation task replaces it.

## Responsibilities

| Area | Owns |
| --- | --- |
| `cli/`, `config/` | Inputs, configuration, component assembly and presentation |
| `runs/`, `checks/` | Implementation/check/repair order and run outcomes |
| `process/` | Starting, observing and stopping owned processes |
| `workspace/` | Git, retained workspace identity, branches and source readiness |
| `sources/`, `sources/jira/` | Intake, receipts, continuation, completion and Jira integration |
| `delivery/` | GitHub delivery and completion operations |
| `reviews/` | Review snapshots, reviewer turns, findings and App-owned publication |
| `history/`, `reporting/` | Conversation snapshots, complete reports and observed results |
| `queue/` | Serial progression through the task lifecycle |
| `agents/codex/` | Coding-runtime invocation and normalized results |

The [file inventory](module-structure.md) is a reference, not a requirement to preserve every
file. Improve boundaries within the task's scope. Git owns commit history; local records retain
execution and ownership facts. Each operation owns its pending work and resources through cleanup.

The harness configuration owns storage, limits and agent launches. The connected project's
`nexus.project.json` owns its setup/checks and integrations. Native runtime configuration owns
provider and model settings. Keep these responsibilities separate.

Coding turns leave local work. Optional delivery publishes a passed attempt; configured
completion can arm GitHub auto-merge, verify post-merge checks and transition Jira. The exact
permissions, gates and restart behavior belong in the spec, not a second implementation recipe here.

## Testing

Test each guarantee at the lowest level that can detect its failure:

- Decisions and orchestration: real code, supplied external responses and controlled time.
- Boundaries: real temporary files, Git repositories or processes where their behavior matters.
- Assembled workflows: a few cases proving connections or failures lower-level tests cannot prove.

Keep fixtures small. Avoid replaying the same decision matrix through every wrapper. Preserve
required behavioral coverage when moving tests. [The current coverage map](../notes/test-layers.md)
describes coverage ownership.

## Tech stack

Use Node.js, TypeScript ES modules and npm, with Zod, Vitest, ESLint and Prettier for their existing
roles. Actual versions live in `package.json`, `package-lock.json` and `.nvmrc`.

Prefer existing code and native capabilities. Use a suitable maintained package for established
infrastructure rather than rebuilding its mechanics. Choose the smallest adequate solution by
maintenance, compatibility and total complexity; fewer dependencies do not automatically mean a
simpler system. Thin integration glue is usually enough.

Keep runtime-specific details in adapters. Add infrastructure only for a concrete need in the task,
not merely because it appears in the long-term vision.
