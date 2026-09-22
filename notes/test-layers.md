# Test coverage map

The [architecture guide](../docs/architecture.md#testing) defines the design principles.
This page describes the current suites. `vitest.config.ts` is the executable source of truth
for project membership and scheduling; `package.json` defines the commands.

## Layers

`policy` runs first with at most eight workers. Its cases exercise decisions and data handling
without child processes of their own; some use temporary files. `boundary` runs afterward with
at most four workers and includes real Git, commands, processes and assembled workflows.

`npm test` and `npm run validate` include both projects. `npm run test:policy` and
`npm run test:boundary` select one. `npm run test:four-workers` runs the same cases in one
four-worker pool. `npm run test:live` is an explicit provider exercise, outside the normal gate.

## Coverage ownership

| Behavior                                    | Main suites                                                                  | Additional boundary coverage                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Configuration, inputs and presentation      | `config`, `completion-config`, `activity`, `report`, `cli`, `completion-cli` | `readme`, `connect-guide`, built CLI examples                                           |
| Repair allowances, escalation and deadlines | `runner-policy`                                                              | `runner`, `runner-repair`, `runner-records`: real checks, feedback and retained results |
| Intake and queue decisions                  | `source`, `jira`, `queue`, `queue-recovery`                                  | `source-cli.integration`, `queue-cli`: command wiring and source effects                |
| Complete conversation and findings          | `history`, `history-source`, `history-runner`, `baseline-findings`           | `baseline`, `baseline-queue.integration`: diagnosis and continuation                    |
| Review and completion decisions             | `reviews`, `completion-gate`, `completion-policy`, `completion-summary`      | `review-github`, `reviews-cli.integration`, `completion-github`, `completion-arm`       |
| Git and workspace preservation              | `git`, `workspace`, `workspace-branch`, `refresh`                            | `delivery`: publication against the validated workspace                                 |
| Runtime and process behavior                | `agent`, `checks`, `stop`, `lifecycle`                                       | `local-run.integration`, `cli-run.integration`, `cli.integration`: assembled execution  |
| Test resource ownership                     | `support`, `fixture-*`, `boundaries`                                         | Nested failure-hook cases and real child-tree shutdown                                  |
| Optional live exercise tooling              | `live-verifier`                                                              | Live execution remains explicitly opted in                                              |

Suite names above refer to files under `tests/` with the `.test.ts` suffix. Some current files
combine decisions and effects; this inventory is not a claim that every suite already follows
the desired architecture. A refactor should identify the owner of each preserved guarantee.

## Fixture ownership

Use `useFixtureLifecycle()` and the owned operation helpers for work that can outlive a test.
`scope.ts` tracks the active scope, `operations.ts` owns command/runner/CLI work, and
`boundary-operations.ts` owns workspace, delivery and review operations. Register ownership before
starting asynchronous work, propagate cancellation, and await settlement before removing resources.
Unconfirmed owners retain their directories for inspection rather than being reported as cleaned up.

`fixture-lifecycle.test.ts` launches cases under `vitest.lifecycle.config.ts` that deliberately
fail or time out. Those cases are excluded from ordinary discovery because their parent asserts
both the expected failures and resource cleanup. They verify runner hooks, not live providers.
