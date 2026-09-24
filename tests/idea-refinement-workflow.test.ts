/**
 * Focused integration tests: TaskEngine and ExecutionRunner run the real XState idea refinement
 * workflow with supplied action stubs over temporary state files. No live agent, service or
 * process is involved; the tests establish the two parallel joins, the verdict precedence, the
 * routes StartIdeaRound receives, the configured cycle bound and terminal outcomes.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskEngine, type EngineEvent } from '../src/task-engine/index.js';
import { ideaRefinement } from '../workflows/idea-refinement.js';
import type { CouncilVerdict } from '../src/task-engine/actions/review-council/artifacts.js';

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

/** The idea workflow's actions with one start-round route script supplied by the test. */
function suppliedActions(options: {
  readonly verdicts: readonly CouncilVerdict[];
  readonly startRound?: (input: unknown) => string;
  readonly publish?: (input: unknown) => string;
}): {
  readonly actions: Record<string, ActionStub>;
  readonly calls: string[];
  readonly routes: unknown[];
} {
  const calls: string[] = [];
  const routes: unknown[] = [];
  let councils = 0;
  // Each action's default outcome; a test overrides the routes it wants to steer.
  const outcomes: Record<string, string> = {
    SelectIdea: 'selected',
    StartIdeaRound: 'opened',
    PurposeVerifier: 'reported',
    Researcher: 'reported',
    BriefWriter: 'written',
    PurposeCouncil: 'approve',
    EvidenceCouncil: 'approve',
    SimplicityCouncil: 'approve',
    PublishDecision: 'approved',
  };
  const record =
    (name: string): ActionStub =>
    async (input?: unknown) => {
      calls.push(name);
      if (name === 'StartIdeaRound') {
        routes.push(input);
        return options.startRound === undefined ? 'opened' : options.startRound(input);
      }
      if (name === 'PurposeCouncil' || name === 'EvidenceCouncil' || name === 'SimplicityCouncil') {
        return options.verdicts[councils++] ?? 'approve';
      }
      if (name === 'PublishDecision') {
        const decision = (input as { readonly decision?: string } | undefined)?.decision;
        const terminal = decision === 'approved' ? 'approved' : 'waiting-for-feedback';
        return options.publish === undefined ? terminal : options.publish(input);
      }
      return outcomes[name] ?? 'reported';
    };
  const actions: Record<string, ActionStub> = {};
  for (const name of Object.keys(outcomes)) {
    actions[name] = record(name);
  }
  return { actions, calls, routes };
}

/** Run the real idea workflow over the supplied action stubs. */
async function run(
  options: Parameters<typeof suppliedActions>[0] & { readonly selectIdea?: string },
  stateFile?: string,
): Promise<{
  readonly result: Awaited<ReturnType<ReturnType<typeof createTaskEngine>['run']>>;
  readonly calls: string[];
  readonly routes: unknown[];
  readonly events: readonly EngineEvent[];
}> {
  const file = stateFile ?? (await temporaryStateFile());
  const { actions, calls, routes } = suppliedActions(options);
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
  return { result, calls, routes, events };
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
  it('ends a failed parallel region only after the started sibling invocation has ended', async () => {
    const stateFile = await temporaryStateFile();
    const observed: EngineEvent[] = [];
    let releaseResearcher: () => void = () => undefined;
    const researcherPending = new Promise<void>((resolve) => {
      releaseResearcher = resolve;
    });
    const defaults: Record<string, () => Promise<string>> = {
      SelectIdea: async () => 'selected',
      StartIdeaRound: async () => 'opened',
      BriefWriter: async () => 'written',
      PurposeCouncil: async () => 'approve',
      EvidenceCouncil: async () => 'approve',
      SimplicityCouncil: async () => 'approve',
      PublishDecision: async () => 'approved',
    };
    const engine = createTaskEngine({
      workflow: ideaRefinement,
      stateFile,
      bindActions: (publish) => ({
        ...defaults,
        PurposeVerifier: async () => {
          publish({ source: 'PurposeVerifier', type: 'agent-finished', data: null });
          throw new Error('the purpose verifier invocation failed');
        },
        Researcher: async () => {
          await researcherPending;
          publish({ source: 'Researcher', type: 'agent-finished', data: null });
          return 'reported';
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
      expect(observed.some((event) => event.source === 'PurposeVerifier')).toBe(true);
    });
    // The failed region ended the workflow, but the pending sibling is still running.
    expect(settled).toBe(false);

    releaseResearcher();
    const result = await run;

    // The original fault survives, and the sibling's end precedes the workflow's final result.
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toContain(
      'the purpose verifier invocation failed',
    );
    expect(observed.filter((event) => event.source !== 'execution-runner')).toEqual([
      { source: 'PurposeVerifier', type: 'agent-finished', data: null },
      { source: 'Researcher', type: 'agent-finished', data: null },
    ]);
  });

  it('joins purpose and research before the writer, and the council before routing', async () => {
    const { result, calls, events } = await run({ verdicts: ['approve', 'approve', 'approve'] });

    expect(result).toEqual({ ok: true, value: 'approved' });
    expect(calls).toEqual([
      'SelectIdea',
      'StartIdeaRound',
      'PurposeVerifier',
      'Researcher',
      'BriefWriter',
      'PurposeCouncil',
      'EvidenceCouncil',
      'SimplicityCouncil',
      'PublishDecision',
    ]);
    // Both groups stay observable while their regions run.
    expect(parallelStates(events)).toEqual(
      expect.arrayContaining([
        JSON.stringify({ assessAndResearch: { purpose: 'assess', research: 'research' } }),
        JSON.stringify({
          reviewCouncil: { purpose: 'review', evidence: 'review', simplicity: 'review' },
        }),
      ]),
    );
  });

  it('opens a new submission at cycle 1 with the new route', async () => {
    const { routes } = await run({ verdicts: ['approve', 'approve', 'approve'] });
    expect(routes).toEqual([{ route: 'new' }]);
  });

  it('runs purpose and research concurrently, and the three reviewers concurrently', async () => {
    /** A gate one group's invocations must all reach before any of them continues. */
    const barrier = (size: number) => {
      let arrived = 0;
      let release: () => void = () => undefined;
      const open = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        async arrive(): Promise<void> {
          arrived += 1;
          if (arrived >= size) {
            release();
          }
          await Promise.race([
            open,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('the invocations did not overlap')), 1000),
            ),
          ]);
        },
      };
    };
    const assessment = barrier(2);
    const council = barrier(3);
    const actions: Record<string, ActionStub> = {
      SelectIdea: async () => 'selected',
      StartIdeaRound: async () => 'opened',
      PurposeVerifier: async () => {
        await assessment.arrive();
        return 'reported';
      },
      Researcher: async () => {
        await assessment.arrive();
        return 'reported';
      },
      BriefWriter: async () => 'written',
      PurposeCouncil: async () => {
        await council.arrive();
        return 'approve';
      },
      EvidenceCouncil: async () => {
        await council.arrive();
        return 'approve';
      },
      SimplicityCouncil: async () => {
        await council.arrive();
        return 'approve';
      },
      PublishDecision: async () => 'approved',
    };
    const stateFile = await temporaryStateFile();

    await expect(
      createTaskEngine({
        workflow: ideaRefinement,
        stateFile,
        bindActions: () => actions,
      }).run(),
    ).resolves.toEqual({ ok: true, value: 'approved' });
  });

  it('routes minor corrections back through the writer and council only', async () => {
    const { result, calls, routes } = await run({
      verdicts: ['approve', 'minor_corrections', 'approve'],
    });

    expect(result).toEqual({ ok: true, value: 'approved' });
    expect(routes).toEqual([{ route: 'new' }, { route: 'minor' }]);
    expect(calls.filter((name) => name === 'PurposeVerifier')).toHaveLength(1);
    expect(calls.filter((name) => name === 'Researcher')).toHaveLength(1);
    expect(calls.filter((name) => name === 'BriefWriter')).toHaveLength(2);
  });

  it('routes major rework back through purpose, research, writer and council', async () => {
    const { result, calls, routes } = await run({
      verdicts: ['major_rework', 'approve', 'approve', 'approve', 'approve', 'approve'],
    });

    expect(result).toEqual({ ok: true, value: 'approved' });
    expect(routes).toEqual([{ route: 'new' }, { route: 'major' }]);
    expect(calls.filter((name) => name === 'PurposeVerifier')).toHaveLength(2);
    expect(calls.filter((name) => name === 'Researcher')).toHaveLength(2);
  });

  it('applies the verdict precedence: an unworkable idea returns even beside major rework', async () => {
    const { result, calls, routes } = await run({
      verdicts: ['idea_not_working', 'major_rework', 'minor_corrections'],
      publish: (input) =>
        (input as { readonly decision: string }).decision === 'returned-to-author'
          ? 'waiting-for-feedback'
          : 'approved',
    });

    expect(result).toEqual({ ok: true, value: 'waiting-for-feedback' });
    expect(routes).toEqual([{ route: 'new' }]);
    expect(calls.at(-1)).toBe('PublishDecision');
  });

  it('returns the idea to its author when the configured cycle bound is reached', async () => {
    let opens = 0;
    const { result, routes } = await run({
      verdicts: ['minor_corrections', 'minor_corrections', 'minor_corrections'],
      startRound: () => (opens++ === 0 ? 'opened' : 'exhausted'),
      publish: (input) =>
        (input as { readonly decision: string }).decision === 'unable-to-converge'
          ? 'waiting-for-feedback'
          : 'approved',
    });

    expect(result).toEqual({ ok: true, value: 'waiting-for-feedback' });
    expect(routes).toEqual([{ route: 'new' }, { route: 'minor' }]);
  });

  it('drains when no idea is eligible and blocks when selection fails', async () => {
    await expect(run({ verdicts: [], selectIdea: 'empty' })).resolves.toMatchObject({
      result: { ok: true, value: 'drained' },
    });
    await expect(run({ verdicts: [], selectIdea: 'failed' })).resolves.toMatchObject({
      result: { ok: true, value: 'blocked' },
    });
  });

  it('resumes an interrupted execution without repeating completed actions', async () => {
    const stateFile = await temporaryStateFile();
    const first = suppliedActions({
      verdicts: ['approve', 'approve', 'approve'],
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

    const second = suppliedActions({
      verdicts: ['approve', 'approve', 'approve'],
      publish: () => 'approved',
    });
    const secondRun = await createTaskEngine({
      workflow: ideaRefinement,
      stateFile,
      bindActions: () => second.actions,
    }).run();

    expect(secondRun).toEqual({ ok: true, value: 'approved' });
    // The restored invocation restarted; the completed actions did not run again.
    expect(second.calls).toEqual(['PublishDecision']);
  });

  it('reports an unexpected council outcome as an execution fault', async () => {
    const stateFile = await temporaryStateFile();
    const { actions } = suppliedActions({ verdicts: ['approve', 'approve', 'approve'] });
    actions['EvidenceCouncil'] = async () => 'unexpected';
    const result = await createTaskEngine({
      workflow: ideaRefinement,
      stateFile,
      bindActions: () => actions,
    }).run();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.fault.message).toContain('Unexpected action outcome');
  });
});
