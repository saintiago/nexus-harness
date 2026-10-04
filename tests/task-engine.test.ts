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
import { createMachine } from 'xstate';
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

type ActionStub = (input?: unknown) => Promise<string>;

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
 * The finite child's actions with one completing pass by default; other outcomes are only
 * reachable through an override. Calls are recorded per supplied binding.
 */
function suppliedActions(overrides: Readonly<Record<string, ActionStub>> = {}): {
  readonly actions: Record<string, ActionStub>;
  readonly calls: string[];
  readonly inputs: { readonly action: string; readonly input: unknown }[];
} {
  const calls: string[] = [];
  const inputs: { readonly action: string; readonly input: unknown }[] = [];
  const outcomes: Record<string, string> = {
    PrepareWorkspace: 'prepared',
    RefreshTaskInput: 'refreshed',
    StartRound: 'started',
    Develop: 'completed',
    Verify: 'passed',
    Deliver: 'published',
    PublishDeliveryReport: 'published',
    PublishReviewFeedback: 'published',
    Review: 'approved',
    CompleteTask: 'completed',
    AnalyzeExperience: 'recorded',
  };
  const actions: Record<string, ActionStub> = {};
  for (const [name, outcome] of Object.entries(outcomes)) {
    const override = overrides[name];
    actions[name] = async (input?: unknown) => {
      calls.push(name);
      inputs.push({ action: name, input });
      return override === undefined ? outcome : override(input);
    };
  }
  return { actions, calls, inputs };
}

/** The observed state values, in publication order. */
function observedStates(events: readonly EngineEvent[]): unknown[] {
  return events.map((event) => (event.data as { readonly value: unknown }).value);
}

describe('TaskEngine over the finite workflow', () => {
  /** Run one finite execution with the supplied outcomes and report its handoff invocations. */
  async function runWith(overrides: Readonly<Record<string, ActionStub>>): Promise<{
    readonly result: Awaited<ReturnType<ReturnType<typeof createTaskEngine>['run']>>;
    readonly calls: string[];
    readonly handoffs: unknown[];
  }> {
    const stateFile = await temporaryStateFile();
    const { actions, calls, inputs } = suppliedActions(overrides);
    const result = await createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    }).run();
    return {
      result,
      calls,
      handoffs: inputs.filter((entry) => entry.action === 'AnalyzeExperience').map((e) => e.input),
    };
  }

  it('analyzes every terminal handoff of selected work and preserves its destination', async () => {
    const completion = await runWith({});
    expect(completion.result).toEqual({ ok: true, value: 'completed' });
    expect(completion.handoffs).toEqual([{ terminal: 'complete-completed' }]);

    const prepare = await runWith({ PrepareWorkspace: async () => 'failed' });
    expect(prepare.result).toEqual({ ok: true, value: 'blocked' });
    expect(prepare.calls).toEqual(['PrepareWorkspace', 'AnalyzeExperience']);
    expect(prepare.handoffs).toEqual([{ terminal: 'prepare-failed' }]);

    const exhausted = await runWith({ StartRound: async () => 'exhausted' });
    expect(exhausted.result).toEqual({ ok: true, value: 'blocked' });
    expect(exhausted.handoffs).toEqual([{ terminal: 'start-round-exhausted' }]);

    const delivery = await runWith({ Deliver: async () => 'failed' });
    expect(delivery.result).toEqual({ ok: true, value: 'blocked' });
    expect(delivery.handoffs).toEqual([{ terminal: 'deliver-failed' }]);

    const inconclusive = await runWith({ Review: async () => 'inconclusive' });
    expect(inconclusive.result).toEqual({ ok: true, value: 'blocked' });
    expect(inconclusive.handoffs).toEqual([{ terminal: 'review-inconclusive' }]);

    const failedCompletion = await runWith({ CompleteTask: async () => 'failed' });
    expect(failedCompletion.result).toEqual({ ok: true, value: 'blocked' });
    expect(failedCompletion.handoffs).toEqual([{ terminal: 'complete-failed' }]);
  });

  it('returns the completion evidence once and never analyzes intermediate work', async () => {
    const { result, calls, handoffs } = await runWith({});

    expect(result).toEqual({ ok: true, value: 'completed' });
    expect(handoffs).toEqual([{ terminal: 'complete-completed' }]);
    expect(calls.filter((call) => call === 'AnalyzeExperience')).toHaveLength(1);
    // The parent owns queue continuation; the child never selects or drains.
    expect(calls).not.toContain('SelectTask');
  });

  it('never analyzes retry rounds, repair loops or a skipped analysis outcome', async () => {
    let verifications = 0;
    const repair = await runWith({
      Verify: async () => (verifications++ === 0 ? 'failed' : 'passed'),
      AnalyzeExperience: async () => 'skipped',
    });

    // The intermediate repair round produced no handoff; the final completion did, and the
    // skipped capture still reached the original destination.
    expect(repair.result).toEqual({ ok: true, value: 'completed' });
    expect(repair.calls.filter((call) => call === 'StartRound')).toHaveLength(2);
    expect(repair.handoffs).toEqual([{ terminal: 'complete-completed' }]);
    expect(repair.calls.filter((call) => call === 'AnalyzeExperience')).toHaveLength(1);

    let reviews = 0;
    const changesRequested = await runWith({
      Review: async () => (reviews++ === 0 ? 'changesRequested' : 'approved'),
      AnalyzeExperience: async () => 'unavailable',
    });
    expect(changesRequested.result).toEqual({ ok: true, value: 'completed' });
    expect(changesRequested.calls.filter((call) => call === 'StartRound')).toHaveLength(2);
    expect(changesRequested.handoffs).toEqual([{ terminal: 'complete-completed' }]);
  });

  it('returns the declared terminal outcome and persists the terminal snapshot', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions();
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'completed' });
    expect(await persistedState(stateFile)).toMatchObject({
      status: 'done',
      value: 'completed',
      output: 'completed',
    });
  });

  it('returns blocked as a workflow result, not an execution fault', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions({ PrepareWorkspace: async () => 'failed' });
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
      Verify: async () => 'failed',
      StartRound: async () => (rounds++ === 0 ? 'started' : 'exhausted'),
    });
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'blocked' });
    // The failed check routes through the parent-owned refresh boundary before the next round.
    expect(calls).toEqual([
      'PrepareWorkspace',
      'RefreshTaskInput',
      'StartRound',
      'Develop',
      'Verify',
      'RefreshTaskInput',
      'StartRound',
      'AnalyzeExperience',
    ]);
  });

  it('loops through a requested repair to a completed outcome', async () => {
    const stateFile = await temporaryStateFile();
    let reviews = 0;
    const { actions, calls } = suppliedActions({
      Review: async () => (reviews++ === 0 ? 'changesRequested' : 'approved'),
    });
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'completed' });
    expect(calls).toEqual([
      'PrepareWorkspace',
      'RefreshTaskInput',
      'StartRound',
      'Develop',
      'Verify',
      'Deliver',
      'PublishDeliveryReport',
      'RefreshTaskInput',
      'Review',
      'PublishReviewFeedback',
      'RefreshTaskInput',
      'StartRound',
      'Develop',
      'Verify',
      'Deliver',
      'PublishDeliveryReport',
      'RefreshTaskInput',
      'Review',
      'PublishReviewFeedback',
      'CompleteTask',
      'AnalyzeExperience',
    ]);
  });

  it('resumes an active execution without repeating completed actions', async () => {
    const stateFile = await temporaryStateFile();
    const first = suppliedActions({
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

    expect(secondRun).toEqual({ ok: true, value: 'completed' });
    // The restored active invocation restarted, and completed actions did not run again.
    expect(second.calls).toEqual(['CompleteTask', 'AnalyzeExperience']);
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
    ).resolves.toEqual({ ok: true, value: 'completed' });

    expect(first.calls).toContain('PrepareWorkspace');
    expect(second.calls).toContain('PrepareWorkspace');
  });

  it('reports an unexpected action outcome as a fault and keeps the runnable snapshot', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions({ Develop: async () => 'unexpected' });
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => actions,
    });

    const result = await engine.run();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toMatch(/Unexpected action outcome: unexpected/);
    expect(await persistedState(stateFile)).toMatchObject({ status: 'active', value: 'develop' });
  });

  it('reports a workflow operation that has no bound action', async () => {
    const stateFile = await temporaryStateFile();
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: () => ({ PrepareWorkspace: async () => 'prepared' }),
    });

    const result = await engine.run();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toMatch(
      /No bound operation or child for workflow operations "RefreshTaskInput".*"AnalyzeExperience"/,
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
  /** A parallel workflow whose regions finish independently, like the idea refinement groups. */
  const parallelProbe = createMachine({
    id: 'parallel-probe',
    initial: 'work',
    output: ({ event }) => event.output,
    states: {
      work: {
        type: 'parallel',
        states: {
          left: {
            initial: 'run',
            states: {
              run: { invoke: { src: 'Left', onDone: 'done' } },
              done: { type: 'final' },
            },
          },
          right: {
            initial: 'run',
            states: {
              run: { invoke: { src: 'Right', onDone: 'done' } },
              done: { type: 'final' },
            },
          },
        },
        onDone: 'finished',
      },
      finished: { type: 'final', output: 'finished' },
    },
  });

  it('waits for a started parallel invocation before reporting the workflow fault', async () => {
    const stateFile = await temporaryStateFile();
    const observed: EngineEvent[] = [];
    let releaseRight: () => void = () => undefined;
    const rightPending = new Promise<void>((resolve) => {
      releaseRight = resolve;
    });
    const engine = createTaskEngine({
      workflow: parallelProbe,
      stateFile,
      bindActions: (publish) => ({
        Left: async () => {
          publish({ source: 'Left', type: 'agent-finished', data: null });
          throw new Error('the left invocation failed');
        },
        Right: async () => {
          await rightPending;
          publish({ source: 'Right', type: 'agent-finished', data: null });
          return 'finished';
        },
      }),
    });
    engine.subscribe((event) => observed.push(event));

    let settled = false;
    const run = engine.run().then((result) => {
      settled = true;
      return result;
    });
    // The failing region's actor ends the workflow while the sibling invocation is still running.
    await vi.waitFor(() => {
      expect(observed.some((event) => event.source === 'Left')).toBe(true);
    });
    expect(settled).toBe(false);

    releaseRight();
    const result = await run;

    // The original fault is reported after the sibling has ended, and its events precede the result.
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toContain('the left invocation failed');
    expect(observed.filter((event) => event.source !== 'execution-runner')).toEqual([
      { source: 'Left', type: 'agent-finished', data: null },
      { source: 'Right', type: 'agent-finished', data: null },
    ]);
  });

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

    expect(observedStates(events)[0]).toBe('prepare');
    expect(observedStates(events).at(-1)).toBe('completed');

    unsubscribe();
    const count = events.length;
    await engine.run();
    expect(events).toHaveLength(count);
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

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'completed' });
    expect(observedStates(events)[0]).toBe('prepare');
    expect(observedStates(events).at(-1)).toBe('completed');
  });

  it('delivers action activity unchanged alongside runner state and isolates observers', async () => {
    const stateFile = await temporaryStateFile();
    const activity: EngineEvent = {
      source: 'Develop',
      type: 'agent-activity',
      data: { type: 'result', text: 'implemented the task' },
    };
    const engine = createTaskEngine({
      workflow: finiteDelivery,
      stateFile,
      bindActions: (publish) => {
        const { actions } = suppliedActions({
          Develop: async () => {
            publish(activity);
            return 'completed';
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

    await expect(engine.run()).resolves.toEqual({ ok: true, value: 'completed' });
    expect(observed).toContain(activity);
    expect(observed[observed.indexOf(activity)]).toBe(activity);
    expect((observed.at(-1)?.data as { readonly value: unknown }).value).toBe('completed');
    // The producer's event travels unchanged, not copied or rewritten by TaskEngine.
    expect(observed).toContain(activity);
    expect(observed[observed.indexOf(activity)]).toBe(activity);
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
      expect(observed.at(-1)).toBe('completed');
    });
    await new Promise((resolve) => setImmediate(resolve));
    // The held first save still blocks the terminal save, which is queued behind it.
    expect(stateWrites.started).toHaveLength(1);

    release();
    await expect(run).resolves.toEqual({ ok: true, value: 'completed' });
    expect(
      stateWrites.started.map((json) => (JSON.parse(json) as { value: unknown }).value).at(-1),
    ).toBe('completed');
    expect(await persistedState(stateFile)).toMatchObject({ status: 'done', value: 'completed' });
  });
});

describe('ExecutionRunner composed child persistence', () => {
  /** A child whose two invoked operations run in sequence and report one terminal output. */
  const stepChild = createMachine({
    id: 'step-child',
    initial: 'first',
    output: ({ event }) => event.output,
    states: {
      first: { invoke: { src: 'FirstStep', onDone: 'second' } },
      second: { invoke: { src: 'SecondStep', onDone: 'finished' } },
      finished: { type: 'final', output: 'child-done' },
    },
  });

  const stepParent = createMachine({
    id: 'step-parent',
    initial: 'run',
    output: ({ event }) => event.output,
    states: {
      run: { invoke: { src: 'StepChild', onDone: 'finished' } },
      finished: { type: 'final', output: 'parent-done' },
    },
  });

  it('persists child progress and resumes without repeating completed operations', async () => {
    const stateFile = await temporaryStateFile();
    const calls: string[] = [];
    const engine = (failSecond: boolean) =>
      createTaskEngine({
        workflow: stepParent,
        children: { StepChild: stepChild },
        stateFile,
        bindActions: () => ({
          FirstStep: async () => {
            calls.push('FirstStep');
            return 'first';
          },
          SecondStep: async () => {
            calls.push('SecondStep');
            if (failSecond) {
              throw new Error('the second step was interrupted');
            }
            return 'second';
          },
        }),
      });

    const interrupted = await engine(true).run();
    expect(interrupted.ok).toBe(false);
    // The composed snapshot named the child's second operation, not the first.
    expect(await persistedState(stateFile)).toMatchObject({
      children: {
        '0.step-parent.run': {
          snapshot: expect.objectContaining({ value: 'second' }) as unknown,
        },
      },
    });

    await expect(engine(false).run()).resolves.toEqual({ ok: true, value: 'parent-done' });
    // Restoring continued the child's current operation instead of replaying the completed one.
    expect(calls).toEqual(['FirstStep', 'SecondStep', 'SecondStep']);
  });
});
