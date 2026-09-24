/**
 * The boundary rules declared in .dependency-cruiser.mjs, run for real against
 * sample modules under tests/fixtures/boundaries: each documented boundary has
 * an allowed import that must pass and a forbidden one that must be reported.
 * Cruising the fixtures uses the installed tool and the repository
 * configuration, so a rule that silently stopped matching fails here.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'boundaries');
const cruiserBin = path.join(
  repoRoot,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);
const configFile = path.join(repoRoot, '.dependency-cruiser.mjs');

interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string };
}

/** Cruise the fixture root with the repository configuration. */
function cruiseFixtures(): Promise<readonly Violation[]> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cruiserBin, '--config', configFile, '--output-type', 'json', '.'],
      { cwd: fixtureRoot },
      (error, stdout) => {
        if (stdout === '') {
          reject(error ?? new Error('dependency-cruiser produced no report'));
          return;
        }
        try {
          const report = JSON.parse(stdout) as {
            summary?: { violations?: readonly Violation[] };
          };
          resolve(report.summary?.violations ?? []);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

describe('component import boundaries', () => {
  it('reports exactly the fixture violations, and nothing else', async () => {
    const violations = await cruiseFixtures();
    const reported = violations
      .map((violation) => `${violation.rule.name}: ${violation.from} -> ${violation.to}`)
      .sort();

    expect(reported).toEqual(
      [
        // A review action imports another action's implementation instead of its declaration.
        'action-declarations-only-develop: src/task-engine/actions/review/index.ts -> src/task-engine/actions/develop/index.ts',
        // ExecutionRunner imports a concrete action implementation, which both rules forbid.
        'action-declarations-only-develop: src/task-engine/execution-runner.ts -> src/task-engine/actions/develop/index.ts',
        'execution-runner-independent: src/task-engine/execution-runner.ts -> src/task-engine/actions/develop/index.ts',
        // An adapter reaches into orchestration.
        'adapters-independent-of-orchestration: src/adapters/git.ts -> src/task-engine/index.ts',
        // A component public module imports AgentRuntime internals instead of its public module.
        'agent-runtime-public-interface: src/operator-interface/index.ts -> src/agent-runtime/private.ts',
        // Presentation bypasses the application public module for the internal worker entry.
        'application-public-interface: src/operator-interface/subscriptions.ts -> src/application/worker.ts',
        // ExecutionRunner imports a concrete adapter.
        'execution-runner-independent: src/task-engine/execution-runner.ts -> src/adapters/git.ts',
        // Application bypasses the operator interface public module with a type-only import.
        'operator-interface-public-interface: src/application/index.ts -> src/operator-interface/activity.ts',
        // A component bypasses the task engine's public module with a type-only import.
        'task-engine-public-interface: src/operator-interface/activity.ts -> src/task-engine/execution-runner.ts',
      ].sort(),
    );
  });
});
