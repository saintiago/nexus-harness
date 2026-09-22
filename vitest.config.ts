import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The deadline the process-heavy layer's cases get when they do not state one
 * of their own — Vitest's `testTimeout`, set on the `boundary` project below.
 *
 * Vitest's five-second default is a unit-test convention, and this layer is
 * not unit tests: every case here starts real Git, command shells or Node
 * children, and its wall time is a function of the host as much as of the
 * checkout. HARN-48's measurements and the runs recorded in
 * `notes/windows-fixture-flakes.md` show cases with three to four seconds of
 * quiet work crossing five seconds under the contention this layer is meant to
 * tolerate — and a case that times out at the default is reported as a failure
 * of the revision under test, which is what stopped the HARN-49 gate.
 *
 * Fifteen seconds is still bounded, so a case that really hangs fails. Every
 * case that already states its own bound keeps it (10 s for two passes, 15 s
 * for three calls, the 20–180 s bounds of the heavier files): only the fallback
 * for cases that state none changes, and `tests/validation-cache.test.ts` fails
 * if this project stops stating one that is above the unit default.
 */
export const BOUNDARY_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Two layers, two concurrency policies.
 *
 * `policy` is the fast layer: configuration, parsing, the terminal model,
 * reporting, the queue decisions and the history store — ordinary functions and
 * in-memory collaborators, no child process of their own. Nothing here needs
 * more than an interpreter, so it may run wide. A case that starts a real
 * process belongs to the other layer, whatever it is about: HARN-49 moved the
 * two files that made a real Git repository out of this layer
 * (`report.test.ts`, `completion-cli.test.ts`), because the gate may replay this
 * layer's results only while everything it observes is in the checkout.
 *
 * `boundary` is the process-heavy layer: real Git, real command shells, real
 * children that a fixture must stop and await. Every worker can start further
 * Git and Node processes, so this layer is capped: the audit behind HARN-48
 * recorded a 24-logical-CPU host defaulting to 23 workers and failing under
 * that contention. The cap is a policy, not a deadline: no test asserts on it.
 * The layer's default deadline is `BOUNDARY_DEFAULT_TIMEOUT_MS`, for the
 * reason recorded beside it; the cap and the deadline are scheduling and
 * reporting policy, and no case asserts on either.
 *
 * `npm run validate` runs both. `npm run test:policy` and
 * `npm run test:boundary` run one layer, for the loop an operator uses while
 * working on it. The opt-in live provider exercise stays `npm run test:live`
 * and is never part of either layer.
 *
 * The gate itself runs the layers as one Turborepo task each —
 * `turbo.json` splits the fast layer into the cache-eligible groups and keeps
 * the process-heavy layer uncached — so this file stays the one place that says
 * what each layer contains (docs/validation-caching.md).
 */
export const policyFiles = [
  'tests/activity.test.ts',
  'tests/baseline-findings.test.ts',
  'tests/boundaries.test.ts',
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
  'tests/reviews.test.ts',
  'tests/runner-policy.test.ts',
  'tests/stop.test.ts',
  'tests/support.test.ts',
  'tests/validation-cache.test.ts',
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
          testTimeout: BOUNDARY_DEFAULT_TIMEOUT_MS,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
