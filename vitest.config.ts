import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Real Git/Node fixtures multiply worker concurrency. See HARN-48 and the audit.
    maxWorkers: 4,
  },
});
