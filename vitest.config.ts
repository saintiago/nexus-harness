import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests_old/**', 'tests/fixtures/**'],
    environment: 'node',
    maxWorkers: 4,
  },
});
