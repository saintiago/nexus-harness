/**
 * Focused integration tests: TaskEngine and ExecutionRunner run the real XState idea refinement
 * workflow with supplied action stubs over temporary state files. No live agent, service or
 * process is involved; the tests establish the parallel join, the editor/Challenger routing, the
 * focused help pass, the routes StartIdeaRound receives, the configured cycle bound and the
 * terminal outcomes.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskEngine, type EngineEvent } from '../src/task-engine/index.js';
import { ideaRefinement } from '../workflows/idea-refinement.js';

type ActionStub = (input?: unknown) => Promise<string>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStateFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-idea-engine-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'workflow.json');
}

/** The idea workflow's actions with the scripted outcomes a test wants to steer. */
function suppliedActions(options: {
  /** One Challenger verdict per assessment, in order; the default is approval. */
  readonly verdicts?: readonly string[];
  /** The outcome of one editor task, when a test changes it. */
  readonly editor?: (task: string, turn: number) => string;
  /** The outcome of one StartIdeaRound route call. */
  readonly startRound?: (input: unknown) => string;
  /** The outcome of one PublishDecision route call. */
  readonly publish?: (input: unknown) => string;
  /** The outcome of one AnalyzeExperience handoff. */
  readonly analyze?: () => string;
}): {
  readonly actions: Record<string, ActionStub>;
  readonly calls: string[];
  readonly routes: unknown[];
  readonly decisions: unknown[];
  readonly handoffs: unknown[];
} {
  const calls: string[] = [];
  const routes: unknown[] = [];
  const decisions: unknown[] = [];
  const handoffs: unknown[] = [];
  let assessments = 0;
  let editorTurns = 0;
  const outcomes: Record<string, string> = {
    SelectIdea: 'selected',
    StartIdeaRound: 'opened',
    IdeaEditor: 'framed',
    Researcher: 'contributed',
    ProjectGuide: 'contributed',
    Challenger: 'approve',
    PublishDecision: 'approved',
    AnalyzeExperience: 'recorded',
  };
  const record =
    (name: string): ActionStub =>
    async (input?: unknown) => {
      calls.push(name);
      if (name === 'AnalyzeExperience') {
        handoffs.push(input);
        return options.analyze === undefined ? 'recorded' : options.analyze();
      }
      if (name === 'StartIdeaRound') {
        routes.push(input);
        return options.startRound === undefined ? 'opened' : options.startRound(input);
      }
      if (name === 'IdeaEditor') {
        const task = (input as { readonly task?: string } | undefined)?.task ?? 'frame';
        editorTurns += 1;
        return options.editor === undefined
          ? defaultEditor(task)
          : options.editor(task, editorTurns);
      }
      if (name === 'Challenger') {
        return options.verdicts?.[assessments++] ?? 'approve';
      }
      if (name === 'PublishDecision') {
        decisions.push(input);
        const decision = (input as { readonly decision?: string } | undefined)?.decision;
        const terminal = decision === 'approved' ? 'approved' : 'waiting-for-feedback';
        return options.publish === undefined ? terminal : options.publish(input);
      }
      return outcomes[name] ?? 'contributed';
    };
  const actions: Record<string, ActionStub> = {};
  for (const name of Object.keys(outcomes)) {
    actions[name] = record(name);
  }
  return { actions, calls, routes, decisions, handoffs };
}

/** The editor's default outcome for one task. */
function defaultEditor(task: string): string {
  switch (task) {
    case 'frame':
      return 'framed';
    case 'edit':
      return 'written';
    default:
      return 'responded';
  }
}

/** Run the real idea workflow over the supplied action stubs. */
async function run(
  options: Parameters<typeof suppliedActions>[0] & { readonly selectIdea?: string },
  stateFile?: string,
): Promise<{
  readonly result: Awaited<ReturnType<ReturnType<typeof createTaskEngine>['run']>>;
  readonly calls: string[];
  readonly routes: unknown[];
  readonly decisions: unknown[];
  readonly handoffs: unknown[];
  readonly events: readonly EngineEvent[];
}> {
  const file = stateFile ?? (await temporaryStateFile());
  const { actions, calls, routes, decisions, handoffs } = suppliedActions(options);
  if (options.selectIdea !== undefined) {
    actions['SelectIdea'] = async () => {
      calls.push('SelectIdea');
      return options.selectIdea ?? 'selected';
    };
  }
  const events: EngineEvent[] = [];
  const engine = createTaskEngine({
    workflow: ideaRefinement,
    stateFile: file,
    bindActions: () => actions,
  });
  engine.subscribe((event) => events.push(event));
  const result = await engine.run();
  return { result, calls, routes, decisions, handoffs, events };
}

/** The parallel state values one run observed, in publication order. */
function parallelStates(events: readonly EngineEvent[]): string[] {
  return events
    .filter((event) => event.source === 'execution-runner' && event.type === 'state')
    .flatMap((event) => {
      const value = (event.data as { readonly value: unknown }).value;
      return typeof value === 'string' ? [] : [JSON.stringify(value)];
    });
}

describe('idea refinement workflow', () => {
  it('joins the contributions before the editor, and the revision before the Challenger', async () => {
    const { result, calls, events } = await run({});

    expect(result).toEqual({ ok: true, value: 'approved' });
    expect(calls).toEqual([
      'SelectIdea',
      'StartIdeaRound',
      'IdeaEditor',
      'Researcher',
      'ProjectGuide',
      'IdeaEditor',
      'Challenger',
      'PublishDecision',
      'AnalyzeExperience',
    ]);
    // Both parallel groups stay observable while their regions run.
    expect(parallelStates(events)).toEqual(
      expect.arrayContaining([
        JSON.stringify({
          gatherContributions: { research: 'contributing', guidance: 'contributing' },
        }),
      ]),
    );
  });

  it('opens a new submission at cycle 1 with the new route', async () => {
    const { routes } = await run({});
    expect(routes).toEqual([{ route: 'new' }]);
  });

  it('analyzes every terminal publication and preserves its destination', async () => {
    const approved = await run({});
    expect(approved.result).toEqual({ ok: true, value: 'approved' });
    expect(approved.handoffs).toEqual([{ terminal: 'publish-approved' }]);

    const unsuitable = await run({
      editor: (task) => (task === 'edit' ? 'unsuitable' : defaultEditor(task)),
    });
    expect(unsuitable.result).toEqual({ ok: true, value: 'waiting-for-feedback' });
    expect(unsuitable.handoffs).toEqual([{ terminal: 'publish-unsuitable' }]);

    const authorDecision = await run({
      editor: (task) => (task === 'frame' ? 'author-decision-needed' : defaultEditor(task)),
    });
    expect(authorDecision.result).toEqual({ ok: true, value: 'waiting-for-feedback' });
    expect(authorDecision.handoffs).toEqual([{ terminal: 'publish-author-decision' }]);

    const exhausted = await run({
      verdicts: ['discuss'],
      startRound: (input) =>
        (input as { readonly route?: string }).route === 'next' ? 'exhausted' : 'opened',
    });
    expect(exhausted.result).toEqual({ ok: true, value: 'waiting-for-feedback' });
    expect(exhausted.handoffs).toEqual([{ terminal: 'publish-attempts-exhausted' }]);

    // A skipped or unavailable capture still reaches the publication destination.
    const skipped = await run({ analyze: () => 'skipped' });
    expect(skipped.result).toEqual({ ok: true, value: 'approved' });
    const unavailable = await run({ analyze: () => 'unavailable' });
    expect(unavailable.result).toEqual({ ok: true, value: 'approved' });
  });

  it('analyzes a blocked selected submission and never an intermediate or empty exchange', async () => {
    const blocked = await run({
      startRound: () => 'exhausted',
    });
    expect(blocked.result).toEqual({ ok: true, value: 'blocked' });
    expect(blocked.handoffs).toEqual([{ terminal: 'start-submission-exhausted' }]);

    // Discussion cycles, focused help and empty or failed selection stay intermediate work.
    const cycles = await run({ verdicts: ['discuss', 'approve'] });
    expect(cycles.result).toEqual({ ok: true, value: 'approved' });
    expect(cycles.handoffs).toEqual([{ terminal: 'publish-approved' }]);

    await expect(run({ selectIdea: 'empty' })).resolves.toMatchObject({
      result: { ok: true, value: 'drained' },
      handoffs: [],
    });
    await expect(run({ selectIdea: 'failed' })).resolves.toMatchObject({
      result: { ok: true, value: 'blocked' },
      handoffs: [],
    });
  });

  it('runs the Researcher and the Project guide concurrently', async () => {
    /** A gate both contributions must reach before either continues. */
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actions: Record<string, ActionStub> = {
      SelectIdea: async () => 'selected',
      StartIdeaRound: async () => 'opened',
      IdeaEditor: async (input) =>
        (input as { readonly task?: string } | undefined)?.task === 'frame' ? 'framed' : 'written',
      Researcher: async () => {
        arrived += 1;
        if (arrived === 2) {
          release();
        }
        await Promise.race([
          bothStarted,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('the contributions did not overlap')), 1000),
          ),
        ]);
        return 'contributed';
      },
      ProjectGuide: async () => {
        arrived += 1;
        if (arrived === 2) {
          release();
        }
        await Promise.race([
          bothStarted,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('the contributions did not overlap')), 1000),
          ),
        ]);
        return 'contributed';
      },
      Challenger: async () => 'approve',
      PublishDecision: async () => 'approved',
      AnalyzeExperience: async () => 'recorded',
    };
    const stateFile = await temporaryStateFile();

    await expect(
      createTaskEngine({ workflow: ideaRefinement, stateFile, bindActions: () => actions }).run(),
    ).resolves.toEqual({ ok: true, value: 'approved' });
  });

  it('answers a discussion in the next cycle and approves the revision it accepts', async () => {
    const { result, calls, routes, decisions } = await run({ verdicts: ['discuss', 'approve'] });

    expect(result).toEqual({ ok: true, value: 'approved' });
    expect(routes).toEqual([{ route: 'new' }, { route: 'next' }]);
    expect(calls.filter((name) => name === 'IdeaEditor')).toHaveLength(3);
    expect(calls.filter((name) => name === 'Challenger')).toHaveLength(2);
    expect(calls.filter((name) => name === 'Researcher')).toHaveLength(1);
    expect(decisions.at(-1)).toEqual({ decision: 'approved' });
  });

  it('gathers only the focused contributions the editor requests, inside the same cycle', async () => {
    let editorTurns = 0;
    const focusedRequests: string[] = [];
    const routes: unknown[] = [];
    const actions: Record<string, ActionStub> = {
      SelectIdea: async () => 'selected',
      StartIdeaRound: async (input) => {
        routes.push(input);
        return 'opened';
      },
      IdeaEditor: async (input) => {
        const task = (input as { readonly task?: string } | undefined)?.task ?? 'frame';
        editorTurns += 1;
        if (task === 'frame') return 'framed';
        if (task === 'edit') return 'written';
        if (task === 'respond' && editorTurns === 3) return 'help-requested';
        return 'responded';
      },
      Researcher: async (input) => {
        const phase = (input as { readonly phase?: string } | undefined)?.phase;
        focusedRequests.push(`researcher:${phase ?? 'unknown'}`);
        return phase === 'focused' ? 'not-requested' : 'contributed';
      },
      ProjectGuide: async (input) => {
        const phase = (input as { readonly phase?: string } | undefined)?.phase;
        focusedRequests.push(`project-guide:${phase ?? 'unknown'}`);
        return 'contributed';
      },
      Challenger: async () => (assessments++ === 0 ? 'discuss' : 'approve'),
      PublishDecision: async () => 'approved',
      AnalyzeExperience: async () => 'recorded',
    };
    let assessments = 0;
    const stateFile = await temporaryStateFile();

    await expect(
      createTaskEngine({ workflow: ideaRefinement, stateFile, bindActions: () => actions }).run(),
    ).resolves.toEqual({ ok: true, value: 'approved' });

    // The focused pass stays inside the cycle that requested it: the discussion opened cycle 2 and
    // no further cycle was opened for the help.
    expect(focusedRequests).toContain('researcher:focused');
    expect(focusedRequests).toContain('project-guide:focused');
    expect(routes).toEqual([{ route: 'new' }, { route: 'next' }]);
  });

  it('returns an unsuitable idea the editor identified', async () => {
    const { result, decisions, routes } = await run({
      editor: (task) => (task === 'edit' ? 'unsuitable' : defaultEditor(task)),
    });

    expect(result).toEqual({ ok: true, value: 'waiting-for-feedback' });
    expect(routes).toEqual([{ route: 'new' }]);
    expect(decisions.at(-1)).toEqual({ decision: 'unsuitable' });
  });

  it('returns an essential author decision the editor asked for while framing', async () => {
    const { result, decisions, calls } = await run({
      editor: (task) => (task === 'frame' ? 'author-decision-needed' : defaultEditor(task)),
    });

    expect(result).toEqual({ ok: true, value: 'waiting-for-feedback' });
    expect(decisions.at(-1)).toEqual({ decision: 'author-decision-needed' });
    // The conversation stops before any contribution is gathered.
    expect(calls).not.toContain('Researcher');
  });

  it('returns the idea when the configured cycle bound is reached', async () => {
    let opens = 0;
    const { result, routes, decisions } = await run({
      verdicts: ['discuss', 'discuss'],
      startRound: () => (opens++ === 0 ? 'opened' : 'exhausted'),
      publish: (input) =>
        (input as { readonly decision: string }).decision === 'attempts-exhausted'
          ? 'waiting-for-feedback'
          : 'approved',
    });

    expect(result).toEqual({ ok: true, value: 'waiting-for-feedback' });
    expect(routes).toEqual([{ route: 'new' }, { route: 'next' }]);
    expect(decisions.at(-1)).toEqual({ decision: 'attempts-exhausted' });
  });

  it('drains when no idea is eligible and blocks when selection fails', async () => {
    await expect(run({ selectIdea: 'empty' })).resolves.toMatchObject({
      result: { ok: true, value: 'drained' },
    });
    await expect(run({ selectIdea: 'failed' })).resolves.toMatchObject({
      result: { ok: true, value: 'blocked' },
    });
  });

  it('resumes an interrupted execution without repeating completed actions', async () => {
    const stateFile = await temporaryStateFile();
    const first = suppliedActions({
      publish: () => {
        throw new Error('publication service unavailable');
      },
    });
    const firstRun = await createTaskEngine({
      workflow: ideaRefinement,
      stateFile,
      bindActions: () => first.actions,
    }).run();
    expect(firstRun.ok).toBe(false);
    expect(
      JSON.parse(await readFile(stateFile, 'utf8')) as { readonly status: string },
    ).toMatchObject({ status: 'active' });

    const second = suppliedActions({});
    const secondRun = await createTaskEngine({
      workflow: ideaRefinement,
      stateFile,
      bindActions: () => second.actions,
    }).run();

    expect(secondRun).toEqual({ ok: true, value: 'approved' });
    // The restored invocation restarted; the completed actions did not run again.
    expect(second.calls).toEqual(['PublishDecision', 'AnalyzeExperience']);
  });

  it('reports an unexpected action outcome as an execution fault', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions({});
    actions['Challenger'] = async () => 'unexpected';
    const result = await createTaskEngine({
      workflow: ideaRefinement,
      stateFile,
      bindActions: () => actions,
    }).run();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toContain('Unexpected action outcome');
  });

  it('ends a failed parallel region only after the started sibling invocation has ended', async () => {
    const stateFile = await temporaryStateFile();
    const observed: EngineEvent[] = [];
    let releaseResearcher: () => void = () => undefined;
    const researcherPending = new Promise<void>((resolve) => {
      releaseResearcher = resolve;
    });
    const defaults: Record<string, ActionStub> = {
      SelectIdea: async () => 'selected',
      StartIdeaRound: async () => 'opened',
      IdeaEditor: async (input) =>
        (input as { readonly task?: string } | undefined)?.task === 'frame' ? 'framed' : 'written',
      Challenger: async () => 'approve',
      PublishDecision: async () => 'approved',
      AnalyzeExperience: async () => 'recorded',
    };
    const engine = createTaskEngine({
      workflow: ideaRefinement,
      stateFile,
      bindActions: (publish) => ({
        ...defaults,
        ProjectGuide: async () => {
          publish({ source: 'ProjectGuide', type: 'agent-finished', data: null });
          throw new Error('the Project guide invocation failed');
        },
        Researcher: async () => {
          await researcherPending;
          publish({ source: 'Researcher', type: 'agent-finished', data: null });
          return 'contributed';
        },
      }),
    });
    engine.subscribe((event) => observed.push(event));

    let settled = false;
    const run = engine.run().then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => {
      expect(observed.some((event) => event.source === 'ProjectGuide')).toBe(true);
    });
    // The failed region ended the workflow, but the pending sibling is still running.
    expect(settled).toBe(false);

    releaseResearcher();
    const result = await run;

    // The original fault survives, and the sibling's end precedes the workflow's final result.
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toContain('the Project guide invocation failed');
    expect(observed.filter((event) => event.source !== 'execution-runner')).toEqual([
      { source: 'ProjectGuide', type: 'agent-finished', data: null },
      { source: 'Researcher', type: 'agent-finished', data: null },
    ]);
  });
});
