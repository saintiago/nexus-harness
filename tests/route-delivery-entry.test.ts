/** Retained finite entry uses actual artifact reads and the real child over controlled effects. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskEngine, type BoundAction } from '../src/task-engine/index.js';
import { createRouteDeliveryEntry } from '../src/task-engine/actions/route-delivery-entry/index.js';
import { developmentReportScope } from '../src/task-engine/actions/develop/artifacts.js';
import {
  readPendingValidationError,
  readValidationErrorHistory,
  rejectReport,
} from '../src/task-engine/actions/report-feedback.js';
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

/** Save the separated development outcome that retained entry must validate. */
async function saveBoundDevelopment(root: string, status: 'completed' | 'failed') {
  const markdown = '# Development\nRetained implementation evidence.\n';
  const reportFile = path.join(root, 'artifacts/1/developer.md');
  const file = path.join(root, 'artifacts/1/development.json');
  await writeFile(reportFile, markdown);
  const outcome = {
    taskKey: 'NEX-1',
    profile: 'nexus-sol',
    status,
    baseRevision: 'base',
    headRevision: 'head',
    role: 'developer',
    report: { path: reportFile },
    invocationId: 'dev-repair',
    readinessFailure: null,
  };
  await writeFile(file, JSON.stringify(outcome));
  return { outcome, file, reportFile, markdown };
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
      await expect(prepared.route()).rejects.toThrow('not "NEX-1"');
    },
  );
  it.each(['schema', 'foreign task', 'missing Markdown'])(
    'retains rejected development evidence at entry for %s',
    async (damage) => {
      const prepared = await entry({ development: 'completed' });
      const saved = await saveBoundDevelopment(prepared.root, 'completed');
      const damaged: Record<string, unknown> = { ...saved.outcome };
      if (damage === 'schema') delete damaged['invocationId'];
      if (damage === 'foreign task') damaged['taskKey'] = 'OTHER-1';
      await writeFile(saved.file, JSON.stringify(damaged));
      if (damage === 'missing Markdown') await rm(saved.reportFile);
      const rejectedOutput = await readFile(saved.file, 'utf8');

      await expect(prepared.route()).rejects.toThrow();
      const records = await readValidationErrorHistory(prepared.root);
      expect(records).toHaveLength(1);
      const rejection = records[0]!.record;
      expect(rejection).toMatchObject({
        kind: 'validation-error',
        scope: developmentReportScope(prepared.root, 'NEX-1'),
        operation: 'develop',
        output: rejectedOutput,
        assignedReport: { path: saved.reportFile },
      });
      if (damage === 'missing Markdown') expect(rejection.report).toBeNull();
      else {
        expect(rejection.report).not.toBeNull();
        expect(await readFile(rejection.report!.path, 'utf8')).toBe(saved.markdown);
      }
    },
  );

  it('routes past a readable development report whose wording changed', async () => {
    const prepared = await entry({ development: 'completed' });
    const saved = await saveBoundDevelopment(prepared.root, 'completed');
    await writeFile(saved.reportFile, 'Reworded after the turn, still readable.\n');

    await expect(prepared.route()).resolves.toBe('verify');
    await expect(readValidationErrorHistory(prepared.root)).resolves.toEqual([]);
  });

  it.each(['completed', 'failed'] as const)(
    'clears the pending context from the current bound %s outcome before retained routing',
    async (status) => {
      const prepared = await entry({ development: status });
      await saveBoundDevelopment(prepared.root, status);
      const scope = developmentReportScope(prepared.root, 'NEX-1');
      const reject = (invocationId: string) =>
        rejectReport({
          areaRoot: prepared.root,
          scope,
          invocationId,
          operation: 'develop',
          profile: 'nexus-sol',
          context: 'Development round 1.',
          source: null,
          output: 'invalid',
          reason: `Unusable output from ${invocationId}.`,
        });
      await expect(reject('earlier')).rejects.toThrow('Unusable output');
      await expect(reject('later')).rejects.toThrow('Unusable output');
      const before = await readPendingValidationError({ areaRoot: prepared.root, scope });
      expect(before?.entries[0]?.invocationId).toBe('later');
      const expectedPhase = status === 'completed' ? 'verify' : 'round';
      expect(await prepared.route()).toBe(expectedPhase);
      expect(await prepared.route()).toBe(expectedPhase);
      // The routed current bound outcome is the owner's validated saved replacement: it clears
      // the pending context while both rejected invocations stay readable history.
      await expect(
        readPendingValidationError({ areaRoot: prepared.root, scope }),
      ).resolves.toBeNull();
      const records = await readValidationErrorHistory(prepared.root);
      expect(records.map((entry) => entry.record.reason)).toEqual([
        'Unusable output from earlier.',
        'Unusable output from later.',
      ]);
    },
  );
});
