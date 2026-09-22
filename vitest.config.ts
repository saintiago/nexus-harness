/**
 * The test pyramid, as the three projects validation runs it in
 * (docs/testing.md).
 *
 * One project per layer, and one layer for every active suite: `unit` decides
 * behavior from explicit inputs and realizes no effect, `boundary` verifies a
 * real contract of this host — processes, Git, files and the service adapters'
 * protocols — and `workflow` assembles the components behind controlled agent
 * and service responses. A suite's directory, and no other property, decides
 * which layer runs it, and every suite runs in exactly one of them
 * (`tests/unit/layers.test.ts` holds that membership to account).
 *
 * `npm test` runs every project directly. The layers are also invoked one at a
 * time by the validation tasks in `turbo.json`, which is what gives a
 * deterministic layer its own cache eligibility (docs/validation-caching.md).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { test: { name: 'boundary', include: ['tests/boundary/**/*.test.ts'] } },
      { test: { name: 'workflow', include: ['tests/workflow/**/*.test.ts'] } },
    ],
    environment: 'node',
    maxWorkers: 4,
  },
});
