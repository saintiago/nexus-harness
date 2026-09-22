import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The comparable measurement, not the gate.
 *
 * The audit's reference run (`f44a859`, 1,301 active cases, 192.50 s) put the
 * whole suite in one pool with four workers. The gate no longer does that — it
 * runs the fast policy layer and then the process-heavy boundary layer, each
 * with its own cap — so a like-for-like number has to be taken deliberately.
 * This configuration is that measurement: every test file in one pool, four
 * workers, no layer ordering, exactly the shape the reference was recorded in.
 *
 * `npm run test:four-workers` runs it. It is never part of `npm test` or
 * `npm run validate`, and no assertion depends on it.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The deliberately failing cases the fixture-lifecycle proof starts with
    // `vitest.lifecycle.config.ts` are the one exclusion the gate makes too.
    exclude: [...configDefaults.exclude, 'tests/fixtures/lifecycle/nested/**'],
    environment: 'node',
    maxWorkers: 4,
  },
});
