/**
 * Focused integration tests: StartIdeaRound plans and opens idea conversation cycles from the
 * retained submission history, records the role plan each route selects and reports the configured
 * cycle bound. Filesystem storage is real; no agent, service or process runs.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '../src/task-engine/index.js';
import { challengerArtifact } from '../src/task-engine/actions/challenger/artifacts.js';
import {
  ideaCycleDirectory,
  ideaSubmissionInputFile,
  listIdeaCycles,
  listIdeaSubmissions,
} from '../src/task-engine/actions/idea-storage.js';
import { decisionArtifact } from '../src/task-engine/actions/publish-decision/artifacts.js';
import {
  ideaRoundPlanDeclaration,
  ideaRoundPlanFile,
  type IdeaRoundPlan,
} from '../src/task-engine/actions/start-idea-round/artifacts.js';
import { createStartIdeaRound } from '../src/task-engine/actions/start-idea-round/index.js';

const profiles = {
  'idea-editor': 'nexus-editor',
  researcher: 'nexus-research',
  'project-guide': 'nexus-guide',
  challenger: 'nexus-challenger',
} as const;

const input = {
  taskKey: 'NEX-1',
  source: { kind: 'jira' as const, issueId: '10518' },
  issue: { id: '10518', key: 'NEX-1', fields: { summary: 'Add a lint gate' } },
  conversation: [],
};

/** One decision record as the publication writes it. */
function decisionDocument() {
  return {
    decision: 'approved',
    refinedIdea: 'refined-idea.json',
    revision: 1,
    editor: 'editor-response.json',
    challenger: null,
    reason: null,
    comment: 'Approved refined idea',
    source: {
      transition: { id: '21', to: 'Draft' },
      status: 'Draft',
      commentId: null,
    },
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** One refinement area with a captured input and, optionally, a retained plan and cycle results. */
async function area(options: {
  readonly plan?: IdeaRoundPlan;
  readonly challengedCycle?: number;
  readonly maxCycles?: number;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-idea-round-'));
  temporaryDirectories.push(root);
  const events: EngineEvent[] = [];
  if (options.plan !== undefined) {
    await mkdir(path.join(root, 'state'), { recursive: true });
    await writeFile(path.join(root, ideaRoundPlanFile), JSON.stringify(options.plan));
    await mkdir(path.dirname(ideaSubmissionInputFile(root, options.plan.submission)), {
      recursive: true,
    });
    await writeFile(ideaSubmissionInputFile(root, options.plan.submission), JSON.stringify(input));
  }
  if (options.challengedCycle !== undefined && options.plan !== undefined) {
    const cycleRoot = ideaCycleDirectory(root, options.plan.submission, options.challengedCycle);
    await mkdir(cycleRoot, { recursive: true });
    await writeFile(
      path.join(cycleRoot, challengerArtifact.pathFromArtifactsRoot),
      JSON.stringify({
        verdict: 'discuss',
        assessment: 'A concern remains.',
        concerns: [{ concern: 'Scope', consequence: 'Too broad', resolution: 'Narrow the idea' }],
        suggestions: [],
        refinedIdea: path.join(cycleRoot, 'refined-idea.json'),
        editorResponse: null,
        revision: options.challengedCycle,
      }),
    );
  }
  const action = createStartIdeaRound({
    workspace: { root },
    input,
    profiles,
    maxCycles: options.maxCycles ?? 3,
    publish: (event) => events.push(event),
  });
  return {
    root,
    events,
    action,
    plan: async (): Promise<IdeaRoundPlan> =>
      JSON.parse(await readFile(path.join(root, ideaRoundPlanFile), 'utf8')) as IdeaRoundPlan,
  };
}

describe('StartIdeaRound', () => {
  it('opens the first submission at cycle 1 with every idea role', async () => {
    const started = await area({});

    await expect(started.action({ route: 'new' })).resolves.toBe('opened');

    expect(await started.plan()).toEqual({ submission: 1, cycle: 1, route: 'new', profiles });
    expect(await listIdeaSubmissions(started.root)).toEqual([1]);
    expect(await listIdeaCycles(started.root, 1)).toEqual([1]);
    const retained = JSON.parse(
      await readFile(ideaSubmissionInputFile(started.root, 1), 'utf8'),
    ) as unknown;
    expect(retained).toEqual(input);
    expect(started.events.at(-1)).toMatchObject({
      source: 'start-idea-round',
      type: 'outcome',
      data: { outcome: 'opened', cycle: 1, detail: 'submission 1 · 4 roles' },
    });
  });

  it('reuses the submission the new route already opened', async () => {
    const started = await area({});
    await started.action({ route: 'new' });

    await expect(started.action({ route: 'new' })).resolves.toBe('opened');

    expect(await listIdeaSubmissions(started.root)).toEqual([1]);
  });

  it('opens the next submission once the retained one reached a decision', async () => {
    const started = await area({
      plan: { submission: 1, cycle: 1, route: 'new', profiles },
    });
    const submissionRoot = path.join(started.root, 'artifacts', 'submissions', '1');
    await mkdir(submissionRoot, { recursive: true });
    await writeFile(
      path.join(submissionRoot, decisionArtifact.pathFromArtifactsRoot),
      JSON.stringify(decisionDocument()),
    );

    await expect(started.action({ route: 'new' })).resolves.toBe('opened');

    expect(await started.plan()).toMatchObject({ submission: 2, cycle: 1, route: 'new' });
    expect(await listIdeaSubmissions(started.root)).toEqual([1, 2]);
  });

  it('opens the next cycle with every role when the Challenger discussed', async () => {
    const started = await area({
      plan: { submission: 1, cycle: 1, route: 'new', profiles },
      challengedCycle: 1,
    });

    await expect(started.action({ route: 'next' })).resolves.toBe('opened');

    expect(await started.plan()).toEqual({
      submission: 1,
      cycle: 2,
      route: 'next',
      profiles,
    });
    // Earlier cycles and their artifacts remain as history.
    expect(await listIdeaCycles(started.root, 1)).toEqual([1, 2]);
  });

  it('reuses the cycle a repeated next route opened before its Challenger reported', async () => {
    const started = await area({
      plan: { submission: 1, cycle: 2, route: 'next', profiles },
    });
    await mkdir(ideaCycleDirectory(started.root, 1, 2), { recursive: true });

    await expect(started.action({ route: 'next' })).resolves.toBe('opened');

    expect(await started.plan()).toMatchObject({ cycle: 2, route: 'next' });
    expect(await listIdeaCycles(started.root, 1)).toEqual([2]);
  });

  it('reports exhaustion instead of opening a cycle beyond the configured bound', async () => {
    const started = await area({
      plan: { submission: 1, cycle: 2, route: 'next', profiles },
      challengedCycle: 2,
      maxCycles: 2,
    });

    await expect(started.action({ route: 'next' })).resolves.toBe('exhausted');

    expect(await started.plan()).toMatchObject({ cycle: 2 });
    expect(await listIdeaCycles(started.root, 1)).toEqual([2]);
    expect(started.events.at(-1)).toMatchObject({
      source: 'start-idea-round',
      type: 'exhausted',
      data: { reason: expect.stringContaining('maximum of 2 conversation cycles') },
    });
  });

  it('rejects a next route without an opened submission and an unknown route', async () => {
    const started = await area({});

    await expect(started.action({ route: 'next' })).rejects.toThrow('No idea round plan exists');
    await expect(started.action({ route: 'later' })).rejects.toThrow('unknown route');
  });

  it('writes a plan its declaration accepts', async () => {
    const started = await area({});
    await started.action({ route: 'new' });
    const document = JSON.parse(
      await readFile(path.join(started.root, ideaRoundPlanFile), 'utf8'),
    ) as unknown;

    expect(ideaRoundPlanDeclaration.schema.safeParse(document).success).toBe(true);
  });
});
