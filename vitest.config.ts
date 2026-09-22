import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Two layers, two concurrency policies.
 *
 * `policy` is the fast layer: configuration, parsing, the terminal model,
 * reporting, the queue decisions and the history store — ordinary functions and
 * in-memory collaborators, no child process of their own. Nothing here needs
 * more than an interpreter, so it may run wide.
 *
 * `boundary` is the process-heavy layer: real Git, real command shells, real
 * children that a fixture must stop and await. Every worker can start further
 * Git and Node processes, so this layer is capped: the audit behind HARN-48
 * recorded a 24-logical-CPU host defaulting to 23 workers and failing under
 * that contention. The cap is a policy, not a deadline: no test asserts on it.
 *
 * `npm run validate` runs both. `npm run test:policy` and
 * `npm run test:boundary` run one layer, for the loop an operator uses while
 * working on it. The opt-in live provider exercise stays `npm run test:live`
 * and is never part of either layer.
 */
const policyFiles = [
  'tests/activity.test.ts',
  'tests/baseline-findings.test.ts',
  'tests/boundaries.test.ts',
  'tests/completion-cli.test.ts',
  'tests/completion-config.test.ts',
  'tests/completion-gate.test.ts',
  'tests/completion-policy.test.ts',
  'tests/config.test.ts',
  'tests/connect-guide.test.ts',
  'tests/history-source.test.ts',
  'tests/history-runner.test.ts',
  'tests/history.test.ts',
  'tests/jira.test.ts',
  'tests/queue-recovery.test.ts',
  'tests/queue.test.ts',
  'tests/report.test.ts',
  'tests/reviews.test.ts',
  'tests/runner-policy.test.ts',
  'tests/stop.test.ts',
  'tests/support.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'policy',
          include: policyFiles,
          environment: 'node',
          maxWorkers: 8,
          // The fast layer runs first, alone: its pool must not overlap the
          // process-heavy layer's, which is the whole point of the cap below.
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'boundary',
          include: ['tests/**/*.test.ts'],
          // The cases the fixture-lifecycle proof must see fail, time out and be
          // cancelled run under `vitest.lifecycle.config.ts`, started and
          // verified by `tests/fixture-lifecycle.test.ts`.
          exclude: [
            ...configDefaults.exclude,
            'tests/fixtures/lifecycle/nested/**',
            ...policyFiles,
          ],
          environment: 'node',
          maxWorkers: 4,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
