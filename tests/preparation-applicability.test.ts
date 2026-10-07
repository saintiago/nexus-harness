/**
 * Focused integration tests: preparation's JEv applicability boundary over real stage storage and
 * the real StartStageRound, StageAuthor and StageEvaluator actions, with a controlled JEv
 * capability and substituted agent responses. They prove the round marker, the documented
 * eligible-round question, the conservative thresholds, the deterministic guards, the safe
 * capability and failure fallbacks, the immutable attributable records, reuse and change
 * behavior, independent evaluation, mandatory prototype observations and the unchanged
 * preparation workflow graph. No provider or network access is involved.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JevRequest, JevResult } from '@saintiago/jev';
import { JevError } from '@saintiago/jev';
import { afterEach, expect, it } from 'vitest';
import { ok } from '../src/result.js';
import { createTaskEngine, type AgentRoleRunner } from '../src/task-engine/index.js';
import {
  applicabilityDirectory,
  applicabilityQuestion,
  type StageApplicabilityCapability,
} from '../src/task-engine/actions/preparation/applicability.js';
import type { PreparationStage } from '../src/task-engine/actions/preparation/artifacts.js';
import { createRecordStageReturn } from '../src/task-engine/actions/preparation/record-stage-return/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import { createStartStageRound } from '../src/task-engine/actions/preparation/start-stage-round/index.js';
import { readStagePlan } from '../src/task-engine/actions/preparation/storage.js';
import { readValidationErrorHistory } from '../src/task-engine/actions/report-feedback.js';
import { preparation } from '../workflows/preparation.js';
import { repositoryState, scriptedGit } from './support/git.js';
import { writeAssignedReport } from './support/agent-runner.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** One controlled provider judgment with the supplied choice, probability and confidence. */
function judgment(choice: string, probability: number, confidence: number): JevResult {
  return {
    model: 'jev-1.13.0',
    answers: {
      stage_applicability: {
        type: 'choice',
        choice,
        probabilities: {
          applicable: choice === 'applicable' ? probability : 0.01,
          inapplicable: choice === 'inapplicable' ? probability : 0.01,
          uncertain: choice === 'uncertain' ? probability : 0.01,
        },
        confidence,
      },
    },
    usage: { input_tokens: 128, output_tokens: 6 },
  };
}

/** A controlled JEv capability recording every request and answering from the supplied function. */
function capabilityOf(answer: (request: JevRequest) => JevResult | Promise<JevResult>): {
  readonly capability: StageApplicabilityCapability;
  readonly requests: JevRequest[];
} {
  const requests: JevRequest[] = [];
  return {
    requests,
    capability: {
      kind: 'available',
      client: {
        async evaluate(request) {
          requests.push(request);
          return await answer(request);
        },
      },
    },
  };
}

/** One scripted author invocation writing its assigned report and returning the response. */
function authorRunner(response: unknown, contexts: string[]): AgentRoleRunner {
  return {
    async run(request) {
      contexts.push(request.context);
      await writeAssignedReport(request.context, '# Stage author report\n\nNarrative.\n');
      return ok({ output: JSON.stringify(response) });
    },
  };
}

/** One scripted evaluator invocation writing its assigned report and returning the verdict. */
function evaluatorRunner(response: unknown, contexts: string[]): AgentRoleRunner {
  return {
    async run(request) {
      contexts.push(request.context);
      await writeAssignedReport(request.context, '# Stage evaluation report\n\nNarrative.\n');
      return ok({ output: JSON.stringify(response) });
    },
  };
}

/** One scripted role invocation answering by the round the action has open. */
function roundRunner(
  stageRoot: string,
  log: string[],
  role: 'author' | 'evaluator',
  answer: (round: number) => unknown,
): AgentRoleRunner {
  return {
    async run(request) {
      const plan = JSON.parse(
        await readFile(path.join(stageRoot, 'state', 'current-round.json'), 'utf8'),
      ) as { round: number };
      log.push(`${role}:${String(plan.round)}`);
      await writeAssignedReport(request.context, `# Controlled ${role} report\n`);
      return ok({ output: JSON.stringify(answer(plan.round)) });
    },
  };
}

/** The conforming UX skip proposal the controlled author returns. */
const skipResponse = {
  outcome: 'skip-proposed',
  documents: [],
  sourcePaths: [],
  observation: null,
  plan: [],
  skip: { references: [] },
  question: null,
  upstream: null,
};

/** One retained applicability record as the tests observe it. */
type RecordView = {
  readonly decision: string;
  readonly reason: string;
  readonly basisIdentity: string;
  readonly basis: {
    readonly route: string;
    readonly task: string;
    readonly corrections: { readonly pendingFeedback: boolean };
  };
  readonly judgment: {
    readonly kind: string;
    readonly choice?: string;
    readonly category?: string;
    readonly status?: number;
    readonly reason?: string;
  };
  readonly evidence: { readonly state: unknown };
};

/** Every retained applicability record of one round, sorted by file name. */
async function applicabilityRecords(
  root: string,
  round = 1,
): Promise<{ readonly path: string; readonly record: RecordView }[]> {
  const directory = applicabilityDirectory(root, round);
  const files = (await readdir(directory)).sort();
  return await Promise.all(
    files.map(async (file) => ({
      path: path.join(directory, file),
      record: JSON.parse(await readFile(path.join(directory, file), 'utf8')) as RecordView,
    })),
  );
}

/** The single retained applicability record of one round. */
async function onlyRecord(
  root: string,
  round = 1,
): Promise<{ readonly path: string; readonly record: RecordView }> {
  const records = await applicabilityRecords(root, round);
  expect(records).toHaveLength(1);
  return records[0]!;
}

type Area = {
  readonly issueRoot: string;
  readonly root: string;
  readonly worktree: string;
  readonly selectionFile: string;
  readonly directory: string;
  readonly git: ReturnType<typeof scriptedGit>['git'];
  readonly publish: () => undefined;
  readonly start: (input: { readonly stage: PreparationStage; readonly route: string }) => unknown;
};

/** A retained earlier authored revision, as a completed first round leaves it. */
async function seedAuthoredRevision(root: string, stage: PreparationStage): Promise<void> {
  await mkdir(path.join(root, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(root, 'artifacts', '1', 'author.json'),
    JSON.stringify({
      stage,
      revision: 1,
      outcome: 'authored',
      summary: 'The first revision.',
      documents: [],
      sourcePaths: [],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      observation: null,
    }),
  );
}

/** One prepared issue workspace with the requested stage round open. */
async function stageArea(
  options: {
    readonly stage?: PreparationStage;
    readonly policy?: 'jev-v1' | null;
    readonly route?: 'new' | 'next' | 'reassess';
    readonly trackedChanges?: boolean;
    readonly capturedScope?: boolean;
  } = {},
): Promise<Area> {
  const stage = options.stage ?? 'ux';
  const route = options.route ?? 'new';
  const capturedScope = options.capturedScope ?? true;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-applicability-'));
  temporaryDirectories.push(directory);
  const issueRoot = path.join(directory, 'NEX-1');
  const worktree = path.join(issueRoot, 'worktree');
  await mkdir(path.join(worktree, 'docs'), { recursive: true });
  await writeFile(path.join(worktree, 'AGENTS.md'), '# Repository instructions\n');
  await writeFile(path.join(worktree, 'docs', 'ux.md'), '# UX\n\nCurrent journey.\n');
  await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
  await writeFile(
    path.join(issueRoot, 'parent', 'prepared-repository.json'),
    JSON.stringify({
      repository: 'saintiago/nexus',
      repositoryWorkspace: { root: worktree },
      branch: 'task/NEX-1',
      baseRevision: 'b'.repeat(40),
    }),
  );
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: capturedScope
        ? { id: '1', key: 'NEX-1', fields: { summary: 'Refresh the delivery report' } }
        : {},
      conversation: capturedScope
        ? [{ author: 'human', text: 'Keep the existing terminal design.' }]
        : [],
      workspace: { root: issueRoot },
      stage,
    }),
  );
  const root = path.join(issueRoot, stage);
  const observations = [repositoryState({ trackedChanges: options.trackedChanges ?? false })];
  const { git } = scriptedGit(observations, {
    readChangedPaths: () => ok(['docs/ux.md']),
    commitPaths: () => {
      observations[0] = repositoryState({ headRevision: 'c'.repeat(40) });
      return ok({ branch: 'task/NEX-1', headRevision: 'c'.repeat(40) });
    },
    readFileAtRevision: async (repository, _revision, file) =>
      ok(await readFile(path.join(repository, file), 'utf8')),
  });
  const publish = () => undefined;
  const start = createStartStageRound({
    selectionFile,
    stage,
    profiles: { authors: ['author-a'], evaluator: 'evaluator-a' },
    maxRounds: 3,
    applicabilityPolicy: options.policy === undefined ? 'jev-v1' : options.policy,
    publish,
  });
  if (route === 'reassess') {
    // The parent retained that an upstream correction requires this stage's current decision.
    await writeFile(
      path.join(issueRoot, 'parent', 'handoff.json'),
      JSON.stringify({
        stage,
        upstreamReturns: 0,
        feedback: null,
        return: null,
        awaitingStages: [stage],
        tickets: [],
        basis: null,
        publications: [],
      }),
    );
  }
  await start({ stage, route: 'new' });
  if (route === 'next') {
    await seedAuthoredRevision(root, stage);
    await start({ stage, route: 'next' });
  }
  return { issueRoot, root, worktree, selectionFile, directory, git, publish, start };
}

it('marks newly opened rounds and never retrofits an already opened round', async () => {
  const enabled = await stageArea();
  expect((await readStagePlan(enabled.root))?.applicabilityPolicy).toBe('jev-v1');
  const disabled = await stageArea({ policy: null });
  expect((await readStagePlan(disabled.root))?.applicabilityPolicy).toBeUndefined();
});

it('asks one documented question for an eligible new UX round and gives both roles its advice', async () => {
  const area = await stageArea();
  const provider = capabilityOf(() => judgment('inapplicable', 0.96, 0.94));
  const contexts: string[] = [];
  await expect(
    createStageAuthor({
      selectionFile: area.selectionFile,
      stage: 'ux',
      git: area.git,
      runner: authorRunner(skipResponse, contexts),
      jev: provider.capability,
      publish: area.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');

  // The documented question reaches the provider with the stage's own evidence, without secrets.
  expect(provider.requests).toHaveLength(1);
  const request = provider.requests[0]!;
  expect(request.questions.stage_applicability).toMatchObject({
    type: 'choice',
    instructions: applicabilityQuestion.instructions,
    criteria: applicabilityQuestion.criteria,
  });
  const state = request.state as Record<string, unknown>;
  expect(state['stage']).toMatchObject({ name: 'ux' });
  expect(state['task']).toMatchObject({ key: 'NEX-1' });
  expect(state['conversation']).toEqual([
    { author: 'human', text: 'Keep the existing terminal design.' },
  ]);
  expect(state['changedPaths']).toEqual(['docs/ux.md']);
  expect(state['repository']).toMatchObject({
    repository: 'saintiago/nexus',
    baseRevision: 'b'.repeat(40),
  });
  expect(JSON.stringify(request)).not.toMatch(/api[-_]?key/i);

  // The advice is retained before the author outcome references it.
  const retained = await onlyRecord(area.root);
  expect(retained.record.decision).toBe('consider-skip');
  expect(retained.record.judgment).toMatchObject({ kind: 'answered', choice: 'inapplicable' });
  expect(retained.record.evidence.state).not.toBeNull();
  const savedAuthor = JSON.parse(
    await readFile(path.join(area.root, 'artifacts', '1', 'author.json'), 'utf8'),
  ) as { applicability: { path: string } };
  expect(savedAuthor.applicability.path).toBe(retained.path);

  // Both roles receive the readable record reference and its advisory status.
  expect(contexts.join('\n')).toContain('JEv applicability advice');
  expect(contexts.join('\n')).toContain(retained.path);
  const evaluatorContexts: string[] = [];
  await expect(
    createStageEvaluator({
      selectionFile: area.selectionFile,
      stage: 'ux',
      git: area.git,
      runner: evaluatorRunner(
        { verdict: 'accepted-skip', observation: null, upstream: null },
        evaluatorContexts,
      ),
      publish: area.publish,
    })(),
  ).resolves.toBe('accepted-skip');
  expect(evaluatorContexts.join('\n')).toContain('JEv applicability advice');
  expect(evaluatorContexts.join('\n')).toContain(retained.path);
});

it('keeps the full path when either advisory threshold is not met', async () => {
  const lowProbability = await stageArea();
  const probability = capabilityOf(() => judgment('inapplicable', 0.89, 0.99));
  await expect(
    createStageAuthor({
      selectionFile: lowProbability.selectionFile,
      stage: 'ux',
      git: lowProbability.git,
      runner: authorRunner(skipResponse, []),
      jev: probability.capability,
      publish: lowProbability.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  const belowProbability = await onlyRecord(lowProbability.root);
  expect(belowProbability.record.decision).toBe('full-path');
  expect(belowProbability.record.reason).toContain(
    'below the advisory probability or confidence threshold',
  );

  const lowConfidence = await stageArea();
  const confidence = capabilityOf(() => judgment('inapplicable', 0.99, 0.89));
  await expect(
    createStageAuthor({
      selectionFile: lowConfidence.selectionFile,
      stage: 'ux',
      git: lowConfidence.git,
      runner: authorRunner(skipResponse, []),
      jev: confidence.capability,
      publish: lowConfidence.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect((await onlyRecord(lowConfidence.root)).record.decision).toBe('full-path');

  // The exact cutoff is supported; both thresholds must be met together.
  const exact = capabilityOf(() => judgment('inapplicable', 0.9, 0.9));
  const boundary = await stageArea();
  await expect(
    createStageAuthor({
      selectionFile: boundary.selectionFile,
      stage: 'ux',
      git: boundary.git,
      runner: authorRunner(skipResponse, []),
      jev: exact.capability,
      publish: boundary.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect((await onlyRecord(boundary.root)).record.decision).toBe('consider-skip');

  // Uncertainty and an applicable judgment never support considering a skip.
  const uncertain = capabilityOf(() => judgment('uncertain', 0.99, 0.99));
  const uncertainArea = await stageArea();
  await expect(
    createStageAuthor({
      selectionFile: uncertainArea.selectionFile,
      stage: 'ux',
      git: uncertainArea.git,
      runner: authorRunner(skipResponse, []),
      jev: uncertain.capability,
      publish: uncertainArea.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect(uncertain.requests).toHaveLength(1);
  const uncertainRecord = await onlyRecord(uncertainArea.root);
  expect(uncertainRecord.record.decision).toBe('full-path');
  expect(uncertainRecord.record.reason).toContain('uncertain');

  const applicable = capabilityOf(() => judgment('applicable', 0.99, 0.99));
  const applicableArea = await stageArea();
  await expect(
    createStageAuthor({
      selectionFile: applicableArea.selectionFile,
      stage: 'ux',
      git: applicableArea.git,
      runner: authorRunner(skipResponse, []),
      jev: applicable.capability,
      publish: applicableArea.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  const applicableRecord = await onlyRecord(applicableArea.root);
  expect(applicableRecord.record.decision).toBe('full-path');
  expect(applicableRecord.record.reason).toContain('judged this stage applicable');
});

it('retains deterministic full-path advice without asking for guarded stages and rounds', async () => {
  // Requirements always assesses requirements.
  const requirements = await stageArea({ stage: 'requirements' });
  const requirementsProvider = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  await expect(
    createStageAuthor({
      selectionFile: requirements.selectionFile,
      stage: 'requirements',
      git: requirements.git,
      runner: authorRunner(skipResponse, []),
      jev: requirementsProvider.capability,
      publish: requirements.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect(requirementsProvider.requests).toHaveLength(0);
  const requirementsRecord = await onlyRecord(requirements.root);
  expect(requirementsRecord.record.decision).toBe('full-path');
  expect(requirementsRecord.record.judgment).toMatchObject({ kind: 'not-requested' });
  expect(requirementsRecord.record.reason).toContain('Requirements always assesses requirements');

  // Architecture never asks, and its evaluated implementation plan stays mandatory.
  const architecture = await stageArea({ stage: 'architecture' });
  const architectureProvider = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  await expect(
    createStageAuthor({
      selectionFile: architecture.selectionFile,
      stage: 'architecture',
      git: architecture.git,
      runner: authorRunner(skipResponse, []),
      jev: architectureProvider.capability,
      publish: architecture.publish,
    })({ task: 'propose' }),
  ).rejects.toThrow(/nonempty implementation plan/);
  expect(architectureProvider.requests).toHaveLength(0);
  const architectureRecord = await onlyRecord(architecture.root);
  expect(architectureRecord.record.reason).toContain(
    'Architecture always submits its evaluated implementation plan',
  );

  // A repair round answers findings and never asks again.
  const repair = await stageArea({ route: 'next' });
  const repairProvider = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  expect(await readStagePlan(repair.root)).toMatchObject({ round: 2, route: 'next' });
  await expect(
    createStageAuthor({
      selectionFile: repair.selectionFile,
      stage: 'ux',
      git: repair.git,
      runner: authorRunner(skipResponse, []),
      jev: repairProvider.capability,
      publish: repair.publish,
    })({ task: 'respond' }),
  ).resolves.toBe('skip-proposed');
  expect(repairProvider.requests).toHaveLength(0);
  const repairRecord = await onlyRecord(repair.root, 2);
  expect(repairRecord.record.decision).toBe('full-path');
  expect(repairRecord.record.reason).toContain('this round repairs or reassesses earlier work');

  // A pending reassessment keeps the full path too.
  const reassess = await stageArea({ route: 'reassess' });
  const reassessProvider = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  expect((await readStagePlan(reassess.root))?.route).toBe('reassess');
  await expect(
    createStageAuthor({
      selectionFile: reassess.selectionFile,
      stage: 'ux',
      git: reassess.git,
      runner: authorRunner(skipResponse, []),
      jev: reassessProvider.capability,
      publish: reassess.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect(reassessProvider.requests).toHaveLength(0);
  expect((await onlyRecord(reassess.root)).record.reason).toContain(
    'this round repairs or reassesses earlier work',
  );

  // A pending correction keeps the full path without another provider request.
  const pending = await stageArea();
  const pendingProvider = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  const pendingAuthor = (response: unknown) =>
    createStageAuthor({
      selectionFile: pending.selectionFile,
      stage: 'ux',
      git: pending.git,
      runner: authorRunner(response, []),
      jev: pendingProvider.capability,
      publish: pending.publish,
    });
  await expect(
    pendingAuthor({
      ...skipResponse,
      documents: [{ path: 'docs/ux.md' }],
    })({ task: 'propose' }),
  ).rejects.toThrow(/only authored work may declare changed documents/);
  expect(pendingProvider.requests).toHaveLength(1);
  await expect(pendingAuthor(skipResponse)({ task: 'propose' })).resolves.toBe('skip-proposed');
  expect(pendingProvider.requests).toHaveLength(1);
  const correction = (await applicabilityRecords(pending.root)).find(
    (entry) => entry.record.basis.corrections.pendingFeedback,
  );
  expect(correction?.record.decision).toBe('full-path');
  expect(correction?.record.reason).toContain('pending correction');

  // Uncommitted tracked work keeps its work for the author and records why no advice was asked.
  const dirty = await stageArea({ trackedChanges: true });
  const dirtyProvider = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  await expect(
    createStageAuthor({
      selectionFile: dirty.selectionFile,
      stage: 'ux',
      git: dirty.git,
      runner: authorRunner(skipResponse, []),
      jev: dirtyProvider.capability,
      publish: dirty.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect(dirtyProvider.requests).toHaveLength(0);
  expect((await onlyRecord(dirty.root)).record.reason).toContain('uncommitted tracked changes');
});

it('falls back safely for missing credentials, an unavailable capability and rounds opened without the integration', async () => {
  const missing = await stageArea();
  await expect(
    createStageAuthor({
      selectionFile: missing.selectionFile,
      stage: 'ux',
      git: missing.git,
      runner: authorRunner(skipResponse, []),
      jev: { kind: 'missing-credential' },
      publish: missing.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  const missingRecord = await onlyRecord(missing.root);
  expect(missingRecord.record.decision).toBe('full-path');
  expect(missingRecord.record.judgment).toMatchObject({ kind: 'not-requested' });
  expect(missingRecord.record.judgment.reason).toContain('credential has no value');
  // Restoring the credential does not replace the retained fallback for unchanged inputs.
  const restored = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  await expect(
    createStageAuthor({
      selectionFile: missing.selectionFile,
      stage: 'ux',
      git: missing.git,
      runner: authorRunner(skipResponse, []),
      jev: restored.capability,
      publish: missing.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect(restored.requests).toHaveLength(0);
  expect((await onlyRecord(missing.root)).path).toBe(missingRecord.path);

  const unavailable = await stageArea();
  const unusedProvider = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  await expect(
    createStageAuthor({
      selectionFile: unavailable.selectionFile,
      stage: 'ux',
      git: unavailable.git,
      runner: authorRunner(skipResponse, []),
      jev: { kind: 'unavailable' },
      publish: unavailable.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect(unusedProvider.requests).toHaveLength(0);
  expect((await onlyRecord(unavailable.root)).record.judgment.reason).toContain(
    'capability is unavailable',
  );

  // No captured scope evidence retains the insufficient-evidence fallback without a request.
  const scopes = await stageArea({ capturedScope: false });
  const scopeProvider = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  await expect(
    createStageAuthor({
      selectionFile: scopes.selectionFile,
      stage: 'ux',
      git: scopes.git,
      runner: authorRunner(skipResponse, []),
      jev: scopeProvider.capability,
      publish: scopes.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect(scopeProvider.requests).toHaveLength(0);
  const scopeRecord = await onlyRecord(scopes.root);
  expect(scopeRecord.record.judgment).toMatchObject({ kind: 'not-requested' });
  expect(scopeRecord.record.judgment.reason).toContain('no scope evidence');

  // A round opened before the integration is never retrofitted: no request, record or advice.
  const existing = await stageArea({ policy: null });
  const existingProvider = capabilityOf(() => judgment('inapplicable', 0.99, 0.99));
  const existingContexts: string[] = [];
  await expect(
    createStageAuthor({
      selectionFile: existing.selectionFile,
      stage: 'ux',
      git: existing.git,
      runner: authorRunner(skipResponse, existingContexts),
      jev: existingProvider.capability,
      publish: existing.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect(existingProvider.requests).toHaveLength(0);
  expect(existingContexts.join('\n')).not.toContain('JEv applicability advice');
  await expect(readdir(applicabilityDirectory(existing.root, 1))).rejects.toThrow(/ENOENT/);
  // The outcome without integration metadata still evaluates, without fabricated evidence.
  const savedAuthor = JSON.parse(
    await readFile(path.join(existing.root, 'artifacts', '1', 'author.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(savedAuthor['applicability']).toBeUndefined();
  const evaluatorContexts: string[] = [];
  await expect(
    createStageEvaluator({
      selectionFile: existing.selectionFile,
      stage: 'ux',
      git: existing.git,
      runner: evaluatorRunner(
        { verdict: 'accepted-skip', observation: null, upstream: null },
        evaluatorContexts,
      ),
      publish: existing.publish,
    })(),
  ).resolves.toBe('accepted-skip');
  expect(evaluatorContexts.join('\n')).not.toContain('JEv applicability advice');
});

it('retains only safe failure categories and never provider messages or bodies', async () => {
  const cases: readonly {
    readonly name: string;
    readonly fail: () => never;
    readonly category: string;
    readonly status?: number;
  }[] = [
    {
      name: 'authentication',
      fail: () => {
        throw new JevError('authentication', 401);
      },
      category: 'authentication',
      status: 401,
    },
    {
      name: 'rate limited',
      fail: () => {
        throw new JevError('rate_limited', 429);
      },
      category: 'rate_limited',
      status: 429,
    },
    {
      name: 'timeout',
      fail: () => {
        throw new JevError('timeout');
      },
      category: 'timeout',
    },
    {
      name: 'invalid response',
      fail: () => {
        throw new JevError('invalid_response', 200);
      },
      category: 'invalid_response',
      status: 200,
    },
    {
      name: 'cancellation',
      fail: () => {
        throw new JevError('cancelled');
      },
      category: 'cancelled',
    },
    {
      name: 'unknown failure',
      fail: () => {
        throw new Error('raw provider body: secret-token-value');
      },
      category: 'unavailable',
    },
  ];
  for (const failure of cases) {
    const area = await stageArea();
    const provider = capabilityOf(() => failure.fail());
    await expect(
      createStageAuthor({
        selectionFile: area.selectionFile,
        stage: 'ux',
        git: area.git,
        runner: authorRunner(skipResponse, []),
        jev: provider.capability,
        publish: area.publish,
      })({ task: 'propose' }),
    ).resolves.toBe('skip-proposed');
    const retained = await onlyRecord(area.root);
    expect(retained.record.decision).toBe('full-path');
    expect(retained.record.reason).toContain(`failed with a ${failure.category} category`);
    expect(retained.record.judgment).toMatchObject({ kind: 'failed', category: failure.category });
    if (failure.status === undefined) {
      expect(retained.record.judgment.status).toBeUndefined();
    } else {
      expect(retained.record.judgment.status).toBe(failure.status);
    }
    const bytes = await readFile(retained.path, 'utf8');
    expect(bytes).not.toContain('secret-token-value');
    expect(bytes).not.toContain('raw provider body');
  }
});

it('reuses the retained record for the same basis without another provider call', async () => {
  const area = await stageArea();
  const provider = capabilityOf(() => judgment('inapplicable', 0.96, 0.94));
  const run = () =>
    createStageAuthor({
      selectionFile: area.selectionFile,
      stage: 'ux',
      git: area.git,
      runner: authorRunner(skipResponse, []),
      jev: provider.capability,
      publish: area.publish,
    })({ task: 'propose' });
  await expect(run()).resolves.toBe('skip-proposed');
  const first = await onlyRecord(area.root);
  await expect(run()).resolves.toBe('skip-proposed');
  expect(provider.requests).toHaveLength(1);
  const reused = await onlyRecord(area.root);
  expect(reused.path).toBe(first.path);
  expect(reused.record.basisIdentity).toBe(first.record.basisIdentity);
});

it('preserves historical records and reassesses a changed captured input', async () => {
  const area = await stageArea();
  const provider = capabilityOf(() => judgment('inapplicable', 0.96, 0.94));
  const run = (runner: AgentRoleRunner) =>
    createStageAuthor({
      selectionFile: area.selectionFile,
      stage: 'ux',
      git: area.git,
      runner,
      jev: provider.capability,
      publish: area.publish,
    })({ task: 'propose' });
  // An interrupted author invocation retains its advice without an author outcome.
  await expect(
    run({
      async run() {
        throw new Error('The author invocation was interrupted.');
      },
    }),
  ).rejects.toThrow('interrupted');
  const first = await onlyRecord(area.root);

  // A changed captured input uses a new basis, preserves the historical record and reassesses.
  const selection = JSON.parse(await readFile(area.selectionFile, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(
    area.selectionFile,
    JSON.stringify({
      ...selection,
      conversation: [
        ...(selection['conversation'] as unknown[]),
        { author: 'human', text: 'Also update the report layout.' },
      ],
    }),
  );
  await expect(run(authorRunner(skipResponse, []))).resolves.toBe('skip-proposed');
  expect(provider.requests).toHaveLength(2);
  const records = await applicabilityRecords(area.root);
  expect(records).toHaveLength(2);
  expect(records.map((entry) => entry.path)).toContain(first.path);
  expect(records.map((entry) => entry.record.basisIdentity)).toContain(first.record.basisIdentity);
});

it('does not apply a judgment whose basis changed while the provider call ran', async () => {
  const area = await stageArea();
  const provider = capabilityOf(async () => {
    const selection = JSON.parse(await readFile(area.selectionFile, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      area.selectionFile,
      JSON.stringify({ ...selection, conversation: [{ author: 'human', text: 'Changed scope.' }] }),
    );
    return judgment('inapplicable', 0.99, 0.99);
  });
  await expect(
    createStageAuthor({
      selectionFile: area.selectionFile,
      stage: 'ux',
      git: area.git,
      runner: authorRunner(skipResponse, []),
      jev: provider.capability,
      publish: area.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  const retained = await onlyRecord(area.root);
  expect(retained.record.decision).toBe('full-path');
  expect(retained.record.reason).toContain('changed while the judgment was being obtained');
  expect(retained.record.judgment).toMatchObject({ kind: 'answered', choice: 'inapplicable' });
});

it('reuses the retained record after an interruption and never mints a replacement', async () => {
  const area = await stageArea();
  const provider = capabilityOf(() => judgment('inapplicable', 0.96, 0.94));
  const interrupted = createStageAuthor({
    selectionFile: area.selectionFile,
    stage: 'ux',
    git: area.git,
    runner: {
      async run() {
        throw new Error('The author invocation was interrupted.');
      },
    },
    jev: provider.capability,
    publish: area.publish,
  });
  await expect(interrupted({ task: 'propose' })).rejects.toThrow('interrupted');
  const retained = await onlyRecord(area.root);
  expect(provider.requests).toHaveLength(1);

  await expect(
    createStageAuthor({
      selectionFile: area.selectionFile,
      stage: 'ux',
      git: area.git,
      runner: authorRunner(skipResponse, []),
      jev: provider.capability,
      publish: area.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect(provider.requests).toHaveLength(1);
  const savedAuthor = JSON.parse(
    await readFile(path.join(area.root, 'artifacts', '1', 'author.json'), 'utf8'),
  ) as { applicability: { path: string } };
  expect(savedAuthor.applicability.path).toBe(retained.path);

  // A corrupt declared record is preserved as the owner's rejection evidence; no judgment is minted.
  await writeFile(retained.path, 'not json');
  await expect(
    createStageAuthor({
      selectionFile: area.selectionFile,
      stage: 'ux',
      git: area.git,
      runner: authorRunner(skipResponse, []),
      jev: provider.capability,
      publish: area.publish,
    })({ task: 'propose' }),
  ).rejects.toThrow(/is not valid JSON/);
  expect(provider.requests).toHaveLength(1);
  const history = await readValidationErrorHistory(area.root);
  expect(history[0]?.record).toMatchObject({
    source: { path: retained.path },
    operation: 'stage-author',
    profile: 'author-a',
  });
});

it('keeps independent evaluation and mandatory prototype observations around an advised skip', async () => {
  const advised = await stageArea({ stage: 'prototype' });
  const provider = capabilityOf(() => judgment('inapplicable', 0.96, 0.94));
  await expect(
    createStageAuthor({
      selectionFile: advised.selectionFile,
      stage: 'prototype',
      git: advised.git,
      runner: authorRunner(skipResponse, []),
      jev: provider.capability,
      publish: advised.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  expect((await onlyRecord(advised.root)).record.decision).toBe('consider-skip');
  // An evaluated skip carries no observation, and only the evaluator's acceptance ends the stage.
  await expect(
    createStageEvaluator({
      selectionFile: advised.selectionFile,
      stage: 'prototype',
      git: advised.git,
      runner: evaluatorRunner({ verdict: 'accepted-skip', observation: null, upstream: null }, []),
      publish: advised.publish,
    })(),
  ).resolves.toBe('accepted-skip');

  // An evaluated skip is the only way this round ends without work: the evaluator rejects this
  // one and the normal repair round follows with no second provider request.
  const rejected = await stageArea({ stage: 'prototype' });
  const rejectedProvider = capabilityOf(() => judgment('inapplicable', 0.96, 0.94));
  await expect(
    createStageAuthor({
      selectionFile: rejected.selectionFile,
      stage: 'prototype',
      git: rejected.git,
      runner: authorRunner(skipResponse, []),
      jev: rejectedProvider.capability,
      publish: rejected.publish,
    })({ task: 'propose' }),
  ).resolves.toBe('skip-proposed');
  await expect(
    createStageEvaluator({
      selectionFile: rejected.selectionFile,
      stage: 'prototype',
      git: rejected.git,
      runner: evaluatorRunner(
        { verdict: 'changes-requested', observation: null, upstream: null },
        [],
      ),
      publish: rejected.publish,
    })(),
  ).resolves.toBe('changes-requested');
  await rejected.start({ stage: 'prototype', route: 'next' });
  await expect(
    createStageAuthor({
      selectionFile: rejected.selectionFile,
      stage: 'prototype',
      git: rejected.git,
      runner: authorRunner(
        {
          outcome: 'authored',
          documents: [],
          sourcePaths: [],
          observation: null,
          plan: [],
          skip: null,
          question: null,
          upstream: null,
        },
        [],
      ),
      jev: rejectedProvider.capability,
      publish: rejected.publish,
    })({ task: 'respond' }),
  ).rejects.toThrow(/applicable prototype work needs the author/);
  expect(rejectedProvider.requests).toHaveLength(1);
  expect((await onlyRecord(rejected.root, 2)).record.judgment).toMatchObject({
    kind: 'not-requested',
  });
});

it('keeps the workflow graph: an advised skip advances only through evaluation', async () => {
  // The author's advice-backed skip alone cannot end the stage: the evaluator's rejection opens
  // the normal repair round, and only its later acceptance advances the workflow.
  const rejected = await stageArea();
  const rejectedProvider = capabilityOf(() => judgment('inapplicable', 0.96, 0.94));
  const rejectedRounds: string[] = [];
  const rejectedRun = createTaskEngine({
    workflow: preparation,
    input: { stage: 'ux' },
    stateFile: path.join(rejected.directory, 'workflow.json'),
    bindActions: (publish) => {
      const common = { selectionFile: rejected.selectionFile, stage: 'ux' as const, publish };
      return {
        PrepareStage: async () => 'prepared',
        StartStageRound: createStartStageRound({
          ...common,
          profiles: { authors: ['author-a'], evaluator: 'evaluator-a' },
          maxRounds: 3,
          applicabilityPolicy: 'jev-v1',
        }),
        StageAuthor: createStageAuthor({
          ...common,
          git: rejected.git,
          jev: rejectedProvider.capability,
          runner: roundRunner(rejected.root, rejectedRounds, 'author', (round) =>
            round === 1
              ? skipResponse
              : {
                  ...skipResponse,
                  outcome: 'authored',
                  documents: [{ path: 'docs/ux.md' }],
                  skip: null,
                },
          ),
        }),
        StageEvaluator: createStageEvaluator({
          ...common,
          git: rejected.git,
          runner: roundRunner(rejected.root, rejectedRounds, 'evaluator', (round) =>
            round === 1
              ? { verdict: 'changes-requested', observation: null, upstream: null }
              : { verdict: 'accepted', observation: null, upstream: null },
          ),
        }),
        StageResult: createStageResult({ ...common, git: rejected.git }),
        RecordStageReturn: createRecordStageReturn({ ...common, maxUpstreamReturns: 1 }),
      };
    },
  });
  await expect(rejectedRun.run()).resolves.toEqual({ ok: true, value: 'accepted' });
  expect(rejectedRounds).toEqual(['author:1', 'evaluator:1', 'author:2', 'evaluator:2']);
  expect(rejectedProvider.requests).toHaveLength(1);
  const repair = await onlyRecord(rejected.root, 2);
  expect(repair.record.decision).toBe('full-path');
  expect(repair.record.judgment).toMatchObject({ kind: 'not-requested' });

  // An independently accepted skip is a successful stage terminal, as before.
  const skipped = await stageArea();
  const skippedProvider = capabilityOf(() => judgment('inapplicable', 0.96, 0.94));
  const skippedRun = createTaskEngine({
    workflow: preparation,
    input: { stage: 'ux' },
    stateFile: path.join(skipped.directory, 'workflow.json'),
    bindActions: (publish) => {
      const common = { selectionFile: skipped.selectionFile, stage: 'ux' as const, publish };
      return {
        PrepareStage: async () => 'prepared',
        StartStageRound: createStartStageRound({
          ...common,
          profiles: { authors: ['author-a'], evaluator: 'evaluator-a' },
          maxRounds: 3,
          applicabilityPolicy: 'jev-v1',
        }),
        StageAuthor: createStageAuthor({
          ...common,
          git: skipped.git,
          jev: skippedProvider.capability,
          runner: roundRunner(skipped.root, [], 'author', () => skipResponse),
        }),
        StageEvaluator: createStageEvaluator({
          ...common,
          git: skipped.git,
          runner: roundRunner(skipped.root, [], 'evaluator', () => ({
            verdict: 'accepted-skip',
            observation: null,
            upstream: null,
          })),
        }),
        StageResult: createStageResult({ ...common, git: skipped.git }),
        RecordStageReturn: createRecordStageReturn({ ...common, maxUpstreamReturns: 1 }),
      };
    },
  });
  await expect(skippedRun.run()).resolves.toEqual({ ok: true, value: 'skipped' });
  expect(skippedProvider.requests).toHaveLength(1);
  expect((await onlyRecord(skipped.root)).record.decision).toBe('consider-skip');
});
