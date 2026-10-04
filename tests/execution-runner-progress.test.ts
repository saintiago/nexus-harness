/**
 * Focused integration tests: the ExecutionRunner persists an invoked child's own progress inside
 * the composed parent snapshot. A child's internal transitions are not reported to the parent's
 * subscription, so a restart must resume the child's current operation instead of replaying the
 * operations it already completed. Real XState machines run over a temporary state file; no live
 * agent, service or process is involved.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMachine } from 'xstate';
import { createTaskEngine } from '../src/task-engine/index.js';
import type { BoundAction } from '../src/task-engine/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A temporary workflow-state file. */
async function temporaryStateFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-runner-progress-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'workflow.json');
}

/** The parent the test runs: one invoked child machine decides the outcome. */
const parent = createMachine({
  id: 'progress-parent',
  initial: 'working',
  output: ({ event }) => event.output,
  states: {
    working: { invoke: { src: 'ProgressChild', onDone: 'finished' } },
    finished: { type: 'final', output: 'finished' },
  },
});

/** The child whose three sequential operations expose which checkpoint a restart restored. */
const child = createMachine({
  id: 'progress-child',
  initial: 'first',
  output: ({ event }) => event.output,
  states: {
    first: { invoke: { src: 'First', onDone: 'second' } },
    second: { invoke: { src: 'Second', onDone: 'third' } },
    third: { invoke: { src: 'Third', onDone: 'done' } },
    done: { type: 'final', output: 'child-done' },
  },
});

describe('ExecutionRunner child progress', () => {
  it('resumes the child operation the interruption reached instead of replaying earlier work', async () => {
    const stateFile = await temporaryStateFile();
    const calls: string[] = [];
    let thirdInvocations = 0;
    const actions: Readonly<Record<string, BoundAction>> = {
      First: async () => {
        calls.push('First');
        return 'first-done';
      },
      Second: async () => {
        calls.push('Second');
        return 'second-done';
      },
      Third: async () => {
        calls.push('Third');
        thirdInvocations += 1;
        // The first run fails while the child is at its third operation, leaving the composed
        // snapshot at that point. The second run must finish that operation, not the earlier two.
        if (thirdInvocations === 1) {
          throw new Error('the third operation was interrupted');
        }
        return 'third-done';
      },
    };

    const interrupted = await createTaskEngine({
      workflow: parent,
      children: { ProgressChild: child },
      stateFile,
      bindActions: () => actions,
    }).run();
    expect(interrupted.ok).toBe(false);
    expect(calls).toEqual(['First', 'Second', 'Third']);

    const resumed = await createTaskEngine({
      workflow: parent,
      children: { ProgressChild: child },
      stateFile,
      bindActions: () => actions,
    }).run();

    expect(resumed).toEqual({ ok: true, value: 'finished' });
    // The restart resumed at the interrupted operation: the two completed ones did not repeat.
    expect(calls).toEqual(['First', 'Second', 'Third', 'Third']);
  });
});
