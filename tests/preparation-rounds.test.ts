/**
 * Focused integration tests: the real StartStageRound plans cumulative, laddered preparation
 * rounds over temporary state. A completed stage visit never resets to round 1, the prototype
 * author escalates without downgrading, and replaying an unfinished opening reuses its round.
 * No live service or provider is involved.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordStageReturn } from '../src/task-engine/actions/preparation/record-stage-return/index.js';
import { createStartStageRound } from '../src/task-engine/actions/preparation/start-stage-round/index.js';
import type { PreparationResult } from '../src/task-engine/actions/preparation/artifacts.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import { scriptedGit } from './support/git.js';
import {
  readStageTerminal,
  readStagePlan,
} from '../src/task-engine/actions/preparation/storage.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** One selection file and stage root over a temporary issue workspace. */
async function stageArea(
  stage: 'requirements' | 'ux' | 'prototype' | 'architecture',
): Promise<{ readonly selectionFile: string; readonly root: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-rounds-'));
  temporaryDirectories.push(directory);
  const root = path.join(directory, 'NEX-1');
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: { id: '1', key: 'NEX-1', fields: {} },
      conversation: [],
      workspace: { root },
      stage,
    }),
  );
  return { selectionFile, root: path.join(root, stage) };
}

/** A completed stage result for one round, as StageResult saves it. */
async function completeRound(root: string, round: number, stage: string): Promise<void> {
  const artifacts = path.join(root, 'artifacts', String(round));
  await mkdir(artifacts, { recursive: true });
  const result: PreparationResult = {
    stage: stage as PreparationResult['stage'],
    outcome: 'accepted',
    authoredRevision: round,
    documents: [],
    existingDocuments: [],
    sourcePaths: [],
    skipReferences: [],
    outputs: [],
    evaluation: { path: path.join(artifacts, 'evaluation.json') },
    reason: 'The stage criteria are met.',
    returnStage: null,
    returnFinding: null,
    prototype: null,
    prototypeObservations: [],
  };
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result));
}

/** The author's report for one round, as StageAuthor saves it before the evaluation. */
async function authorRound(
  root: string,
  round: number,
  stage: string,
  revision: number,
): Promise<void> {
  const artifacts = path.join(root, 'artifacts', String(round));
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    path.join(artifacts, 'author.json'),
    JSON.stringify({
      stage,
      revision,
      outcome: 'authored',
      summary: 'The revision addresses the current findings.',
      documents: [],
      sourcePaths: [],
      plan:
        stage === 'architecture'
          ? [
              {
                summary: 'Implement the accepted design',
                scope: 'Carry the accepted design into implementation.',
                completionCriteria: ['The accepted design is implemented.'],
                prerequisites: [],
              },
            ]
          : [],
      skip: null,
      question: null,
      upstream: null,
      observation: null,
    }),
  );
}

/** The round plan StartStageRound retained. */
async function planOf(root: string) {
  const plan = await readStagePlan(root);
  if (plan === null) {
    throw new Error('the stage round plan was not retained');
  }
  return plan;
}

describe('StartStageRound', () => {
  it('continues rounds across a completed stage visit instead of resetting to round 1', async () => {
    const { selectionFile, root } = await stageArea('ux');
    const round = createStartStageRound({
      selectionFile,
      stage: 'ux',
      profiles: { authors: ['nexus-sol'], evaluator: 'nexus-sol' },
      maxRounds: 3,
      publish: () => undefined,
    });

    await expect(round({ stage: 'ux', route: 'new' })).resolves.toBe('opened');
    await completeRound(root, 1, 'ux');

    // A later visit of the same stage (for example after an upstream return) continues the
    // cumulative rounds rather than overwriting round 1.
    await expect(round({ stage: 'ux', route: 'new' })).resolves.toBe('opened');
    expect(await planOf(root)).toMatchObject({ stage: 'ux', round: 2, route: 'new' });
  });

  it('reuses an unfinished opening so a replay continues the round it opened', async () => {
    const { selectionFile, root } = await stageArea('ux');
    const round = createStartStageRound({
      selectionFile,
      stage: 'ux',
      profiles: { authors: ['nexus-sol'], evaluator: 'nexus-sol' },
      maxRounds: 3,
      publish: () => undefined,
    });

    await round({ stage: 'ux', route: 'new' });
    await round({ stage: 'ux', route: 'new' });

    expect(await planOf(root)).toMatchObject({ round: 1, route: 'new' });
  });

  it('opens a retained pending reassessment across a restart without resetting the allowance', async () => {
    const { selectionFile, root } = await stageArea('ux');
    const round = createStartStageRound({
      selectionFile,
      stage: 'ux',
      profiles: { authors: ['nexus-sol'], evaluator: 'nexus-sol' },
      maxRounds: 2,
      publish: () => undefined,
    });
    await expect(round({ stage: 'ux', route: 'new' })).resolves.toBe('opened');
    await completeRound(root, 1, 'ux');
    // A restart re-reads the parent's retained correction: the stage's decision awaits a current
    // decision, so the new visit opens as a reassessment rather than a fresh proposal.
    const issueRoot = path.dirname(root);
    await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
    await writeFile(
      path.join(issueRoot, 'parent', 'handoff.json'),
      JSON.stringify({
        stage: 'ux',
        upstreamReturns: 1,
        feedback: null,
        return: null,
        awaitingStages: ['ux'],
        tickets: [],
        publications: [],
      }),
    );

    await expect(round({ stage: 'ux', route: 'new' })).resolves.toBe('opened');
    expect(await planOf(root)).toMatchObject({ round: 2, route: 'reassess' });
    await completeRound(root, 2, 'ux');
    // Consumed rounds stay consumed: the restarted visit cannot exceed the configured allowance.
    await expect(round({ stage: 'ux', route: 'new' })).resolves.toBe('exhausted');
  });

  it('escalates the prototype author along its ladder and never downgrades', async () => {
    const { selectionFile, root } = await stageArea('prototype');
    const round = createStartStageRound({
      selectionFile,
      stage: 'prototype',
      profiles: { authors: ['nexus-flash', 'nexus-sol'], evaluator: 'nexus-sol' },
      maxRounds: 3,
      publish: () => undefined,
    });

    await round({ stage: 'prototype', route: 'new' });
    expect((await planOf(root)).profiles.author).toBe('nexus-flash');

    // The evaluator requested changes: the repair round promotes to the next profile, and the
    // following re-entry keeps the strongest profile instead of downgrading.
    await authorRound(root, 1, 'prototype', 1);
    await round({ stage: 'prototype', route: 'next' });
    expect((await planOf(root)).profiles.author).toBe('nexus-sol');
    await completeRound(root, 2, 'prototype');
    await round({ stage: 'prototype', route: 'new' });
    expect(await planOf(root)).toMatchObject({ round: 3, route: 'new' });
    expect((await planOf(root)).profiles.author).toBe('nexus-sol');
  });

  it.each(['requirements', 'ux', 'prototype', 'architecture'] as const)(
    'preserves completed %s history when the planner and result writer exhaust on re-entry',
    async (stage) => {
      const { selectionFile, root } = await stageArea(stage);
      const round = createStartStageRound({
        selectionFile,
        stage,
        profiles: { authors: ['a'], evaluator: 'e' },
        maxRounds: 1,
        publish: () => undefined,
      });
      await round({ route: 'new' });
      await completeRound(root, 1, stage);
      const resultFile = path.join(root, 'artifacts/1/result.json');
      const accepted = await readFile(resultFile, 'utf8');
      await expect(round({ route: 'new' })).resolves.toBe('exhausted');
      const result = createStageResult({
        selectionFile,
        stage,
        git: scriptedGit([]).git,
        publish: () => undefined,
      });
      await expect(result({ outcome: 'exhausted' })).resolves.toBe('saved');
      expect(await readFile(resultFile, 'utf8')).toBe(accepted);
      expect(await readStageTerminal(root)).toMatchObject({
        outcome: 'exhausted',
        reason: expect.stringContaining('maximum of 1'),
      });
      await result({ outcome: 'exhausted' });
      expect(await readFile(resultFile, 'utf8')).toBe(accepted);
    },
  );

  it('reports the configured round allowance as exhausted across stage visits', async () => {
    const { selectionFile, root } = await stageArea('requirements');
    const round = createStartStageRound({
      selectionFile,
      stage: 'requirements',
      profiles: { authors: ['nexus-sol'], evaluator: 'nexus-sol' },
      maxRounds: 2,
      publish: () => undefined,
    });

    await round({ stage: 'requirements', route: 'new' });
    await completeRound(root, 1, 'requirements');
    await round({ stage: 'requirements', route: 'new' });
    await completeRound(root, 2, 'requirements');

    await expect(round({ stage: 'requirements', route: 'new' })).resolves.toBe('exhausted');
  });
});

describe('RecordStageReturn', () => {
  /** The stage area with one opened round, as StartStageRound leaves it. */
  async function openedRound(
    stage: 'requirements' | 'ux',
    number: number,
  ): Promise<{
    readonly selectionFile: string;
    readonly root: string;
  }> {
    const area = await stageArea(stage);
    await mkdir(path.join(area.root, 'state'), { recursive: true });
    await writeFile(
      path.join(area.root, 'state', 'current-round.json'),
      JSON.stringify({
        stage,
        round: number,
        route: number === 1 ? 'new' : 'next',
        profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
      }),
    );
    return area;
  }

  it('counts one replayed return once and keeps the cumulative allowance', async () => {
    const first = await openedRound('ux', 1);
    const record = createRecordStageReturn({
      selectionFile: first.selectionFile,
      stage: 'ux',
      maxUpstreamReturns: 2,
      publish: () => undefined,
    });

    await expect(record({ stage: 'ux' })).resolves.toBe('return');
    // The interrupted return is replayed against the same round: it consumes no further allowance.
    await expect(record({ stage: 'ux' })).resolves.toBe('return');
    await expect(
      readFile(path.join(first.root, 'state', 'returns.json'), 'utf8'),
    ).resolves.toContain('"count": 1');

    // A later round states a second return, which consumes the second allowance.
    await writeFile(
      path.join(first.root, 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'ux',
        round: 2,
        route: 'next',
        profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
      }),
    );
    await expect(record({ stage: 'ux' })).resolves.toBe('return');

    // A third return would exceed the configured allowance and requests attention instead.
    await writeFile(
      path.join(first.root, 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'ux',
        round: 3,
        route: 'next',
        profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
      }),
    );
    await expect(record({ stage: 'ux' })).resolves.toBe('exhausted');
  });
});
