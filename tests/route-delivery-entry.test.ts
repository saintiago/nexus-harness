/** Retained finite entry uses actual artifact reads and the real child over controlled effects. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskEngine, type BoundAction } from '../src/task-engine/index.js';
import { createRouteDeliveryEntry } from '../src/task-engine/actions/route-delivery-entry/index.js';
import { finiteDelivery } from '../workflows/finite-delivery.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function entry(options: {
  development?: 'completed' | 'failed';
  verification?: 'passed' | 'failed';
  delivery?: boolean;
  taskKey?: string;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-delivery-entry-'));
  directories.push(root);
  const selectionFile = path.join(root, 'selection.json');
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: {},
      conversation: [],
      workspace: { root },
      stage: 'delivery',
    }),
  );
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'artifacts/1'), { recursive: true });
  await writeFile(
    path.join(root, 'state/current-round.json'),
    JSON.stringify({ number: 1, profile: 'nexus-sol', reason: 'retained' }),
  );
  if (options.development)
    await writeFile(
      path.join(root, 'artifacts/1/development.json'),
      JSON.stringify({
        taskKey: options.taskKey ?? 'NEX-1',
        profile: 'nexus-sol',
        status: options.development,
        baseRevision: 'base',
        headRevision: 'head',
        summary: 'retained',
        findingResponses: [],
      }),
    );
  if (options.verification)
    await writeFile(
      path.join(root, 'artifacts/1/verification.json'),
      JSON.stringify({ headRevision: 'head', status: options.verification, checks: [] }),
    );
  if (options.delivery)
    await writeFile(
      path.join(root, 'artifacts/1/delivery.json'),
      JSON.stringify({
        repository: 'owner/repo',
        pullRequestNumber: 1,
        pullRequestUrl: 'https://example.com/pr/1',
        headRevision: 'head',
      }),
    );
  return { root, selectionFile, route: createRouteDeliveryEntry({ selectionFile }) };
}

describe('retained finite delivery entry', () => {
  it.each([
    [{}, 'round'],
    [{ development: 'failed' }, 'round'],
    [{ development: 'completed' }, 'verify'],
    [{ development: 'completed', verification: 'failed' }, 'round'],
    [{ development: 'completed', verification: 'passed' }, 'deliver'],
    [{ development: 'completed', verification: 'passed', delivery: true }, 'review'],
  ] as const)('chooses the first unfinished phase from %j', async (options, phase) => {
    const prepared = await entry(options);
    expect(await prepared.route()).toBe(phase);
  });

  it('continues an admitted review revision through publication and review without new development', async () => {
    const prepared = await entry({
      development: 'completed',
      verification: 'passed',
      delivery: true,
    });
    const calls: string[] = [];
    const outcomes: Record<string, string> = {
      PrepareWorkspace: 'prepared',
      RefreshTaskInput: 'refreshed',
      StartRound: 'started',
      Develop: 'completed',
      Verify: 'passed',
      Deliver: 'published',
      PublishDeliveryReport: 'published',
      Review: 'approved',
      PublishReviewFeedback: 'published',
      CompleteTask: 'completed',
      AnalyzeExperience: 'recorded',
    };
    const actions: Record<string, BoundAction> = Object.fromEntries(
      Object.entries(outcomes).map(([name, outcome]) => [
        name,
        async () => {
          calls.push(name);
          return outcome;
        },
      ]),
    );
    actions['RouteDeliveryEntry'] = prepared.route;
    const result = await createTaskEngine({
      workflow: finiteDelivery,
      stateFile: path.join(prepared.root, 'child.json'),
      bindActions: () => actions,
    }).run();
    expect(result).toEqual({ ok: true, value: 'completed' });
    expect(calls).toEqual([
      'PrepareWorkspace',
      'PublishDeliveryReport',
      'RefreshTaskInput',
      'Review',
      'PublishReviewFeedback',
      'CompleteTask',
      'AnalyzeExperience',
    ]);
  });

  it.each(['completed', 'failed'] as const)(
    'refuses %s evidence belonging to another task',
    async (development) => {
      const prepared = await entry({ development, taskKey: 'OTHER-1' });
      await expect(prepared.route()).rejects.toThrow('another selected task');
    },
  );
});
