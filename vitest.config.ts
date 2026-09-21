import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The cases the fixture-lifecycle proof must see fail, time out and be
    // cancelled run under `vitest.lifecycle.config.ts`, started by
    // `tests/fixture-lifecycle.test.ts` and verified there.
    exclude: [...configDefaults.exclude, 'tests/fixtures/lifecycle/nested/**'],
    environment: 'node',
    // Real Git/Node fixtures multiply worker concurrency. See HARN-48 and the audit.
    maxWorkers: 4,
  },
});
