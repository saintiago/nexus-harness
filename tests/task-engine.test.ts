/**
 * Focused integration tests: TaskEngine and ExecutionRunner run the real XState finite workflow
 * with supplied action stubs over temporary state files. No live agent, service or process is
 * involved. The state-file write is intercepted to hold a save while proving that saves stay
 * serialized and to substitute a failing external write; every other filesystem call is real.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskEngine, type EngineEvent } from '../src/task-engine/index.js';
import { finiteDelivery } from '../workflows/finite-delivery.js';

/** The controllable part of the write interception. */
const stateWrites = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  failing: false,
  started: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof actual.writeFile = async (file, data, options) => {
    if (stateWrites.failing && typeof data === 'string') {
      throw new Error('disk full');
    }
    if (stateWrites.hold !== null && typeof data === 'string') {
      stateWrites.started.push(data);
      await stateWrites.hold;
    }
    await actual.writeFile(file, data, options);
  };
  return { ...actual, writeFile };
});

type ActionStub = () => Promise<string>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  stateWrites.hold = null;
  stateWrites.failing = false;
  stateWrites.started.length = 0;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStateFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-task-engine-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'workflow.json');
}

/** Read the persisted snapshot for assertions. */
async function persistedState(stateFile: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>;
}

/**
 * The finite workflow's actions with one drained pass by default: selection finds nothing, so the
 * other outcomes are only reachable through an override. Calls are recorded per supplied binding.
 */
function suppliedActions(overrides: Readonly<Record<string, ActionStub>> = {}): {
  readonly actions: Record<string, ActionStub>;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const outcomes: Record<string, string> = {
    SelectTask: 'empty',
    PrepareWorkspace: 'prepared',
    StartRound: 'started',
    Develop: 'completed',
    Verify: 'passed',
    Deliver: 'published',
    Review: 'approved',
    CompleteTask: 'completed',
  };
  const actions: Record<string, ActionStub> = {};
  for (const [name, outcome] of Object.entries(outcomes)) {
    const override = overrides[name];
    actions[name] = async () => {
      calls.push(name);
      return override === undefined ? outcome : override();
    };
  }
  return { actions, calls };
}

/** The observed state values, in publication order. */
function observedStates(events: readonly EngineEvent[]): unknown[] {
  return events.map((event) => (event.data as { readonly value: unknown }).value);
}

describe('TaskEngine over the finite workflow', () => {
  it('returns the declared terminal outcome and persists the terminal snapshot', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions();
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'drained' });
    expect(await persistedState(stateFile)).toMatchObject({
      status: 'done',
      value: 'finished',
      output: 'drained',
    });
  });

  it('returns blocked as a workflow result, not an execution fault', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions({ SelectTask: async () => 'failed' });
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'blocked' });
  });

  it('follows the declared transitions through a repair round', async () => {
    const stateFile = await temporaryStateFile();
    let rounds = 0;
    const { actions, calls } = suppliedActions({
      SelectTask: async () => 'selected',
      Verify: async () => 'failed',
      StartRound: async () => (rounds++ === 0 ? 'started' : 'exhausted'),
    });
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'blocked' });
    expect(calls).toEqual([
      'SelectTask',
      'PrepareWorkspace',
      'StartRound',
      'Develop',
      'Verify',
      'StartRound',
    ]);
  });

  it('loops through a requested repair to a drained outcome', async () => {
    const stateFile = await temporaryStateFile();
    let selections = 0;
    let reviews = 0;
    const { actions, calls } = suppliedActions({
      SelectTask: async () => (selections++ === 0 ? 'selected' : 'empty'),
      Review: async () => (reviews++ === 0 ? 'changesRequested' : 'approved'),
    });
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'drained' });
    expect(calls).toEqual([
      'SelectTask',
      'PrepareWorkspace',
      'StartRound',
      'Develop',
      'Verify',
      'Deliver',
      'Review',
      'StartRound',
      'Develop',
      'Verify',
      'Deliver',
      'Review',
      'CompleteTask',
      'SelectTask',
    ]);
  });

  it('resumes an active execution without repeating completed actions', async () => {
    const stateFile = await temporaryStateFile();
    const first = suppliedActions({
      SelectTask: async () => 'selected',
      CompleteTask: async () => {
        throw new Error('completion service unavailable');
      },
    });
    const firstRun = await createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => first.actions,
    }).run();

    expect(firstRun.ok).toBe(false);
    expect(firstRun.ok ? '' : firstRun.fault.message).toContain('completion service unavailable');
    // The runnable snapshot is retained instead of the errored machine snapshot.
    expect(await persistedState(stateFile)).toMatchObject({ status: 'active', value: 'complete' });

    const second = suppliedActions({ CompleteTask: async () => 'completed' });
    const secondRun = await createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => second.actions,
    }).run();

    expect(secondRun).toEqual({ ok: true, value: 'drained' });
    // The restored active invocation restarted, and completed actions did not run again.
    expect(second.calls).toEqual(['CompleteTask', 'SelectTask']);
  });

  it('starts from the initial state when the saved run is terminal', async () => {
    const stateFile = await temporaryStateFile();
    const first = suppliedActions();
    await createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => first.actions,
    }).run();

    const second = suppliedActions();
    await expect(
      createTaskEngine({
        workflow: finiteDelivery,
        stateFile,
        bindActions: () => second.actions,
      }).run(),
    ).resolves.toEqual({ ok: true, value: 'drained' });

    expect(first.calls).toEqual(['SelectTask']);
    expect(second.calls).toEqual(['SelectTask']);
  });

  it('reports an unexpected action outcome as a fault and keeps the runnable snapshot', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions({ SelectTask: async () => 'unexpected' });
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    const result = await engine.run();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toMatch(/Unexpected action outcome: unexpected/);
    expect(await persistedState(stateFile)).toMatchObject({ status: 'active', value: 'select' });
  });

  it('reports a workflow operation that has no bound action', async () => {
    const stateFile = await temporaryStateFile();
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => ({ SelectTask: async () => 'empty' }),
    });

    const result = await engine.run();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toMatch(
      /No bound action for workflow operations "PrepareWorkspace".*"CompleteTask"/,
    );
  });

  it('rejects invalid saved state instead of starting over', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions();
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    await writeFile(stateFile, 'not json', 'utf8');
    const malformed = await engine.run();
    expect(malformed.ok).toBe(false);
    expect(malformed.ok ? '' : malformed.fault.message).toMatch(/is not valid JSON/);

    await writeFile(
      stateFile,
      JSON.stringify({ status: 'active', value: 'absent', context: {}, children: {} }),
      'utf8',
    );
    const absent = await engine.run();
    expect(absent.ok).toBe(false);
    expect(absent.ok ? '' : absent.fault.message).toMatch(/cannot be restored/);
    expect(absent.ok ? '' : absent.fault.message).toContain('absent');
  });

  it('reports an unreadable state file as a fault', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions();
    // A directory cannot be read as state, and must not be treated as a fresh run.
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile: path.dirname(stateFile),
      bindActions: () => actions,
    });

    const result = await engine.run();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toMatch(/could not be read/);
  });

  it('reports a state save failure as a fault, not a terminal outcome', async () => {
    const stateFile = await temporaryStateFile();
    stateWrites.failing = true;
    const { actions } = suppliedActions();
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    const result = await engine.run();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toMatch(/could not be saved: disk full/);
  });
});

describe('TaskEngine events', () => {
  it('publishes state observations to subscribers until they unsubscribe', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions();
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });
    const events: EngineEvent[] = [];

    const unsubscribe = engine.subscribe((event) => events.push(event));
    await engine.run();

    expect(events).toEqual([
      { source: 'execution-runner', type: 'state', data: { value: 'select' } },
      { source: 'execution-runner', type: 'state', data: { value: 'finished' } },
    ]);

    unsubscribe();
    await engine.run();
    expect(events).toHaveLength(2);
  });

  it('isolates listener failures from execution and other listeners', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions();
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });
    const events: EngineEvent[] = [];

    engine.subscribe(() => {
      throw new Error('listener failed');
    });
    engine.subscribe((event) => events.push(event));

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'drained' });
    expect(observedStates(events)).toEqual(['select', 'finished']);
  });

  it('delivers action activity unchanged alongside runner state and isolates observers', async () => {
    const stateFile = await temporaryStateFile();
    const activity: EngineEvent = {
      source: 'SelectTask',
      type: 'agent-activity',
      data: { type: 'result', text: 'no eligible task' },
    };
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: (publish) => {
        const { actions } = suppliedActions({
          SelectTask: async () => {
            publish(activity);
            return 'empty';
          },
        });
        return actions;
      },
    });
    const observed: EngineEvent[] = [];
    engine.subscribe(() => {
      throw new Error('observer failed');
    });
    engine.subscribe((event) => observed.push(event));

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'drained' });
    expect(observed).toEqual([
      activity,
      { source: 'execution-runner', type: 'state', data: { value: 'select' } },
      { source: 'execution-runner', type: 'state', data: { value: 'finished' } },
    ]);
    // The producer's event travels unchanged, not copied or rewritten by TaskEngine.
    expect(observed[0]).toBe(activity);
  });
});

describe('ExecutionRunner persistence order', () => {
  it('serializes state saves in notification order', async () => {
    const stateFile = await temporaryStateFile();
    let release: () => void = () => undefined;
    stateWrites.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { actions } = suppliedActions();
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });
    const observed: unknown[] = [];
    engine.subscribe((event) => observed.push((event.data as { readonly value: unknown }).value));

    const run = engine.run();
    await vi.waitFor(() => {
      expect(observed).toEqual(['select', 'finished']);
    });
    await new Promise((resolve) => setImmediate(resolve));
    // The held first save still blocks the terminal save, which is queued behind it.
    expect(stateWrites.started).toHaveLength(1);

    release();
    await expect(run).resolves.toEqual({ ok: true, value: 'drained' });
    expect(
      stateWrites.started.map((json) => (JSON.parse(json) as { value: unknown }).value),
    ).toEqual(['select', 'finished']);
    expect(await persistedState(stateFile)).toMatchObject({ status: 'done', value: 'finished' });
  });
});
