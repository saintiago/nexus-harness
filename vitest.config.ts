import { defineConfig } from 'vitest/config';

/**
 * The test scopes of the testing architecture, run from the narrowest to the broadest. Component
 * tests exercise real Nexus logic through its public interface with external effects supplied and
 * run without network access, real processes or filesystem operations. Focused integration tests
 * exercise one connection — real storage, processes, local services or a protocol adapter with
 * supplied provider responses. System tests run the assembled application. `npm test` runs the
 * scopes in that order; an unlisted test file joins the integration scope.
 */
const componentTests = [
  'tests/agent-runtime.test.ts',
  'tests/application-command.test.ts',
  'tests/configuration-composition.test.ts',
  'tests/configuration.test.ts',
  'tests/operator-interface.test.ts',
];

const systemTests = ['tests/finite-execution-journeys.test.ts'];

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        test: {
          name: 'component',
          include: componentTests,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/**/*.test.ts'],
          exclude: [...componentTests, ...systemTests],
        },
      },
      {
        test: {
          name: 'system',
          include: systemTests,
        },
      },
    ],
  },
});
