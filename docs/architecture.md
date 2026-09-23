# Architecture

Nexus is a local-first TypeScript CLI for implementation, checks, repair, delivery and review.

## Design principles

Keep rules that can be expressed simply and reliably in ordinary code. Use AI where a decision
requires investigation or judgment and deterministic handling would become a growing collection
of special cases. Ownership, execution and verification remain reliable whichever role acts.

Separate decisions from external effects. Coordinators decide what happens next; adapters perform
Git, process and service operations. Use ordinary functions and explicit inputs. Add an abstraction
when it clarifies a real responsibility, not to prepare for hypothetical future work.

A supervisor around Nexus runs the queue as a worker and invokes a separate recovery agent after
an unexpected stop (docs/spec.md §12). Exceptional recovery policy belongs to that agent's
judgment; the ordinary loop keeps the required behavior — ownership, repair, escalation, verified
delivery and completion — and gains no branch for it. Recovery's permissions are deliberately
wider than a coding or reviewer turn's, and they are separate from both.

## Component boundaries

Task intake supplies work and context. Workspace management provides an owned working copy.
Execution coordinates developer turns and checks; review evaluates the result; delivery and
completion integrate it through the configured gates. Queue coordination carries one ticket
through these responsibilities, and supervision sits in front of it: it runs the queue as a
worker, keeps one incident record per unexpected stop, and hands recovery judgment to a separate
agent. Process execution and records support every phase.

Each component has a clear [responsibility](components.md). Keep external protocols behind
adapters. Pass observations and requested operations across boundaries rather than exposing
another component's internal state. Git owns version history; Nexus retains execution and
ownership facts. Pending work has an owner through cancellation and cleanup.

The harness configuration owns storage, limits and agent launches. The connected project's
`nexus.project.json` owns its setup/checks and integrations. Native runtime configuration owns
provider and model settings. Keep these responsibilities separate.

Coding turns leave local work. Optional delivery publishes a passed attempt; configured
completion can arm GitHub auto-merge, verify post-merge checks and transition Jira.

## Testing

Test each guarantee at the lowest level that can detect its failure:

- Decisions and orchestration: real code, supplied external responses and controlled time.
- Boundaries: real temporary files, Git repositories or processes where their behavior matters.
- Assembled workflows: a few cases proving connections or failures lower-level tests cannot prove.

Keep fixtures small. Avoid replaying the same decision matrix through every wrapper. Test the
implementation against the required behavior, not documentation against existing code.

## Tech stack

Use Node.js, TypeScript ES modules and npm. Use Zod for input validation, Vitest for behavior tests,
and ESLint and Prettier for code quality and formatting. Use Turborepo for local validation task
caching and the tools' native caches where appropriate.

Prefer existing code and native capabilities. Use a suitable maintained package for established
infrastructure rather than rebuilding its mechanics. Choose the smallest adequate solution by
maintenance, compatibility and total complexity; fewer dependencies do not automatically mean a
simpler system. Thin integration glue is usually enough.

Keep runtime-specific details in adapters. Add infrastructure only for a concrete need in the task,
not merely because it appears in the long-term vision.
