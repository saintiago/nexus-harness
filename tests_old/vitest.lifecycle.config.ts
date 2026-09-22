import { defineConfig } from 'vitest/config';

/**
 * The config the fixture-lifecycle proof runs its own failing cases with
 * (`tests/fixture-lifecycle.test.ts`). Those cases must time out, fail an
 * assertion, be cancelled and fail their setup, so they cannot be part of the
 * ordinary gate: the proof starts this config, reads what each case left behind
 * — no directory, no process, no answering beacon — and reports it as one
 * ordinary test of that gate.
 */
export default defineConfig({
  test: {
    include: ['tests/fixtures/lifecycle/nested/*.test.ts'],
    environment: 'node',
    maxWorkers: 1,
    fileParallelism: false,
  },
});
