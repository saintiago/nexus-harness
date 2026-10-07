/**
 * Focused integration tests: PrepareStage's preparation-owned stage attempt identity. The action
 * runs over temporary issue workspaces with a controlled Git adapter, so a check reads the declared
 * record directly and establishes when the identity is retained, reused or replaced.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryState } from '../src/adapters/git.js';
import { ok } from '../src/result.js';
import type { PreparationStage } from '../src/configuration/index.js';
import { preparationAttemptDeclaration } from '../src/task-engine/actions/preparation/artifacts.js';
import { createPrepareStage } from '../src/task-engine/actions/preparation/prepare-stage/index.js';
import { stageRoot } from '../src/task-engine/actions/preparation/storage.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { repositoryState, scriptedGit, type GitOperations } from './support/git.js';

const repository = '/origin/repository.git';
const taskKey = 'NEX-1';
const branch = 'task/NEX-1';
const baseRevision = '1'.repeat(40);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-attempt-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** One JSON document written under its directory. */
async function writeJson(file: string, content: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

/** The retained attempt identity of one stage area, or null when no record exists. */
async function retainedAttempt(root: string, stage: PreparationStage): Promise<unknown> {
  try {
    return JSON.parse(
      await readFile(path.join(stageRoot(root, stage), preparationAttemptDeclaration.file), 'utf8'),
    ) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** The reasons one PrepareStage run published as failed. */
function failedReasons(events: readonly EngineEvent[]): string[] {
  return events
    .filter((event) => event.type === 'failed')
    .map((event) => String((event.data as { readonly reason?: unknown }).reason));
}

/** One issue workspace with the retained shared checkout and repository record. */
async function retainedWorkspace(): Promise<{
  readonly root: string;
  readonly selectionFile: string;
}> {
  const directory = await temporaryDirectory();
  const root = path.join(directory, taskKey);
  const selectionFile = path.join(directory, 'selection.json');
  await writeJson(selectionFile, {
    taskKey,
    source: { kind: 'jira', issueId: '1' },
    task: {},
    conversation: [],
    workspace: { root },
    stage: 'requirements',
  });
  await mkdir(path.join(root, 'worktree'), { recursive: true });
  await writeJson(path.join(root, 'parent', 'prepared-repository.json'), {
    repository,
    repositoryWorkspace: { root },
    branch,
    baseRevision,
  });
  return { root, selectionFile };
}

/** PrepareStage over the supplied observations, publishing into the events list. */
function prepareStage(settings: {
  readonly selectionFile: string;
  readonly observations: readonly (RepositoryState | Error)[];
  readonly events: EngineEvent[];
  readonly operations?: GitOperations;
}) {
  const { git } = scriptedGit(settings.observations, settings.operations ?? {});
  return createPrepareStage({
    selectionFile: settings.selectionFile,
    repository: { source: repository, mainBranch: 'main' },
    git,
    publish: (event) => settings.events.push(event),
  });
}

describe('preparation attempt identity', () => {
  it('retains a unique identity before fallible repository work, so a failed entry still names its attempt', async () => {
    const { root, selectionFile } = await retainedWorkspace();
    const events: EngineEvent[] = [];
    const prepare = prepareStage({
      selectionFile,
      observations: [new Error('the repository cannot be inspected')],
      events,
    });

    await expect(prepare({ stage: 'requirements' })).resolves.toBe('failed');

    const attempt = (await retainedAttempt(root, 'requirements')) as { attemptId?: unknown };
    expect(typeof attempt.attemptId).toBe('string');
    expect(String(attempt.attemptId).length).toBeGreaterThan(0);
    expect(failedReasons(events)).toHaveLength(1);
  });

  it('retains the identity before it clones the shared checkout', async () => {
    const directory = await temporaryDirectory();
    const root = path.join(directory, taskKey);
    const selectionFile = path.join(directory, 'selection.json');
    await writeJson(selectionFile, {
      taskKey,
      source: { kind: 'jira', issueId: '1' },
      task: {},
      conversation: [],
      workspace: { root },
      stage: 'requirements',
    });
    const events: EngineEvent[] = [];
    const prepare = prepareStage({
      selectionFile,
      observations: [repositoryState({ remoteUrl: repository, branch: 'main' })],
      events,
      operations: {
        cloneRepository: async () => {
          // The attempt identity is already retained before the first fallible repository step.
          expect(await retainedAttempt(root, 'requirements')).toMatchObject({
            attemptId: expect.any(String),
          });
          return ok({ branch: 'main', headRevision: baseRevision, remoteUrl: repository });
        },
        fetchRevision: () => ok(baseRevision),
        createBranch: (_repository, branch, startRevision) =>
          ok({ branch, headRevision: startRevision }),
        readRemoteBranchHead: () => ok(null),
      },
    });

    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');
  });

  it('reuses the retained identity across reentry and worker restarts', async () => {
    const { root, selectionFile } = await retainedWorkspace();
    const events: EngineEvent[] = [];
    const prepare = prepareStage({
      selectionFile,
      observations: [new Error('the repository cannot be inspected'), repositoryState()],
      events,
    });

    await expect(prepare({ stage: 'requirements' })).resolves.toBe('failed');
    const first = await retainedAttempt(root, 'requirements');
    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');

    expect(await retainedAttempt(root, 'requirements')).toEqual(first);
  });

  it('keeps a pre-upgrade current attempt without retrofitting an identity', async () => {
    const { root, selectionFile } = await retainedWorkspace();
    await writeJson(path.join(stageRoot(root, 'requirements'), 'state', 'current-round.json'), {
      stage: 'requirements',
      round: 2,
      route: 'next',
      profiles: { author: 'a', evaluator: 'e' },
    });
    const events: EngineEvent[] = [];
    const prepare = prepareStage({ selectionFile, observations: [repositoryState()], events });

    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');

    expect(await retainedAttempt(root, 'requirements')).toBeNull();
  });

  it('treats historical round directories alone as a replaced attempt', async () => {
    const { root, selectionFile } = await retainedWorkspace();
    await writeJson(path.join(stageRoot(root, 'ux'), 'artifacts', '2', 'result.json'), {
      stage: 'ux',
      outcome: 'accepted',
    });
    const events: EngineEvent[] = [];
    const prepare = prepareStage({ selectionFile, observations: [repositoryState()], events });

    await expect(prepare({ stage: 'ux' })).resolves.toBe('prepared');

    const attempt = (await retainedAttempt(root, 'ux')) as { attemptId?: unknown };
    expect(typeof attempt.attemptId).toBe('string');
  });

  it('fails on an unreadable retained identity instead of minting a replacement', async () => {
    const { root, selectionFile } = await retainedWorkspace();
    const attemptFile = path.join(
      stageRoot(root, 'requirements'),
      preparationAttemptDeclaration.file,
    );
    await mkdir(path.dirname(attemptFile), { recursive: true });
    await writeFile(attemptFile, '{"attemptId":\n', 'utf8');
    const events: EngineEvent[] = [];
    const prepare = prepareStage({ selectionFile, observations: [repositoryState()], events });

    await expect(prepare({ stage: 'requirements' })).resolves.toBe('failed');

    expect(await readFile(attemptFile, 'utf8')).toBe('{"attemptId":\n');
    expect(failedReasons(events).join('\n')).toContain('attempt identity is unreadable');
  });

  it('gives a replaced attempt a distinct identity without touching retained history', async () => {
    const { root, selectionFile } = await retainedWorkspace();
    const stage = stageRoot(root, 'requirements');
    await writeJson(path.join(stage, 'artifacts', '2', 'result.json'), {
      stage: 'requirements',
      outcome: 'accepted',
    });
    const events: EngineEvent[] = [];
    const prepare = prepareStage({
      selectionFile,
      observations: [repositoryState(), repositoryState()],
      events,
    });

    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');
    const first = (await retainedAttempt(root, 'requirements')) as { attemptId: string };
    await writeJson(path.join(stage, 'state', 'current-round.json'), {
      stage: 'requirements',
      round: 2,
      route: 'new',
      profiles: { author: 'a', evaluator: 'e' },
    });

    // A deliberate fresh restart replaces the stage attempt's working state; the completed round
    // history and the shared checkout stay.
    await rm(path.join(stage, 'state'), { recursive: true, force: true });
    await expect(prepare({ stage: 'requirements' })).resolves.toBe('prepared');

    const second = (await retainedAttempt(root, 'requirements')) as { attemptId: string };
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(await readFile(path.join(stage, 'artifacts', '2', 'result.json'), 'utf8')).toBe(
      '{\n  "stage": "requirements",\n  "outcome": "accepted"\n}\n',
    );
  });
});
