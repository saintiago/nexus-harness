/**
 * Focused integration tests: the real preparation author/evaluator actions carry the preceding
 * revision and reports into a repair round, enforce the minimal outcome and report-binding
 * contract, bind every acceptance to its complete basis and open a pending reassessment as such.
 * Temporary stage areas hold real records beside one shared checkout; the agent runner is a
 * controlled report source. No live provider or source service is involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok } from '../src/result.js';
import { scriptedGit, repositoryState } from './support/git.js';
import type { AgentRoleRunner, BoundAction } from '../src/task-engine/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import { createStartStageRound } from '../src/task-engine/actions/preparation/start-stage-round/index.js';
import { reportIdentityOf } from '../src/task-engine/actions/agent-reports.js';
import {
  authoredIdentity,
  sourceInputIdentity,
} from '../src/task-engine/actions/preparation/evaluation-content.js';
import {
  preparationWorktree,
  readCurrentDecision,
  readStagePlan,
  readStageArtifact,
  stageRoot,
} from '../src/task-engine/actions/preparation/storage.js';
import { stageReturnSchema } from '../src/task-engine/actions/select-work/artifacts.js';
import { ideaParentInputSchema } from '../src/task-engine/actions/select-idea/artifacts.js';
import {
  preparationResultSchema,
  stageEvaluationArtifact,
  type StageAuthorOutput,
  type StageEvaluationOutput,
  stageAuthorArtifact,
} from '../src/task-engine/actions/preparation/artifacts.js';
import { readReportFeedback } from '../src/task-engine/actions/report-feedback.js';
import { writeAssignedReport } from './support/agent-runner.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const finding = {
  title: 'The journey contradicts the requirement',
  severity: 'blocking',
  basis: 'The accepted requirement is contradicted by the proposed journey.',
  evidence: 'docs/ux.md describes a navigation path the requirement forbids.',
  impact: 'Users cannot complete the journey the requirement states.',
  repairGuidance: 'Revise the journey to follow the requirement.',
  locations: [{ path: 'docs/ux.md', line: 2 }],
};

/** One stage area with a completed first round: an authored revision and its evaluation. */
async function stageWithEvaluation(
  options: {
    readonly stage?: 'ux' | 'architecture';
    readonly verdict?: 'changes-requested' | 'return-upstream';
  } = {},
): Promise<{
  readonly selectionFile: string;
  readonly issueRoot: string;
  readonly root: string;
  readonly selection: Record<string, unknown>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-preparation-handoff-'));
  temporaryDirectories.push(directory);
  const issueRoot = path.join(directory, 'NEX-1');
  const stage = options.stage ?? 'ux';
  const document = stage === 'architecture' ? 'docs/architecture.md' : 'docs/ux.md';
  const root = path.join(issueRoot, stage);
  const selectionFile = path.join(directory, 'selection.json');
  const selection = {
    taskKey: 'NEX-1',
    source: { kind: 'jira', issueId: '1' },
    task: { id: '1', key: 'NEX-1', fields: { summary: 'Refine the journey' } },
    conversation: [],
    workspace: { root: issueRoot },
    stage,
  };
  await writeFile(selectionFile, JSON.stringify(selection));
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'artifacts', '1'), { recursive: true });
  await mkdir(path.join(preparationWorktree(issueRoot), 'docs'), { recursive: true });
  await writeFile(
    path.join(preparationWorktree(issueRoot), document),
    stage === 'architecture' ? '# Architecture\n' : '# UX\n',
  );
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({
      stage,
      round: 1,
      route: 'new',
      profiles: {
        author: 'nexus-sol',
        evaluator: stage === 'architecture' ? 'nexus-astra' : 'nexus-sol',
      },
    }),
  );
  const author = {
    stage,
    revision: 1,
    outcome: 'authored',
    summary: 'The first journey proposal.',
    documents: [{ path: document, description: 'The proposed work.' }],
    sourcePaths: [],
    plan: [],
    skip: null,
    question: null,
    upstream: null,
    observation: null,
  };
  await writeFile(path.join(root, 'artifacts', '1', 'author.json'), JSON.stringify(author));
  await writeFile(
    path.join(root, 'artifacts', '1', 'evaluation.json'),
    JSON.stringify({
      basis: {
        author: { path: path.join(root, 'artifacts', '1', 'author.json') },
        authorIdentity: authoredIdentity(stageAuthorArtifact.schema.parse(author)),
        sourceIdentity: sourceInputIdentity(selection as never),
        upstream: [],
        content: [{ path: document, revision: '1'.repeat(40), exists: true }],
      },
      assessedRevision: 1,
      verdict: options.verdict ?? 'changes-requested',
      reason: 'The journey contradicts the requirement.',
      observation: null,
      findings: [finding],
      upstream:
        options.verdict === 'return-upstream'
          ? {
              stage: 'requirements',
              problem: 'The acceptance example contradicts the requirement.',
              consequence: 'The stage cannot express one consistent design.',
              correction: 'Correct the acceptance example.',
            }
          : null,
    }),
  );
  return { selectionFile, issueRoot, root, selection };
}

/** The Markdown narrative every controlled report writes to its assigned path. */
const controlledMarkdown = '# Controlled report\n\nThe controlled narrative.\n';

/**
 * A controlled runner returning the supplied reports in order, writing each invocation's assigned
 * Markdown report and recording every context and workspace root.
 */
function runnerOf(reports: readonly unknown[]): {
  readonly runner: AgentRoleRunner;
  readonly contexts: string[];
  readonly roots: string[];
} {
  const contexts: string[] = [];
  const roots: string[] = [];
  const queued = [...reports];
  return {
    contexts,
    roots,
    runner: {
      async run(request) {
        contexts.push(request.context);
        roots.push(request.workspace.root);
        const report = queued.shift();
        if (report === undefined) {
          throw new Error('No controlled report remains for this invocation.');
        }
        await writeAssignedReport(request.context, controlledMarkdown);
        return ok({ output: JSON.stringify(report) });
      },
    },
  };
}

/** Read one saved artifact of a stage round. */
async function artifact(root: string, round: number, file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, 'artifacts', String(round), file), 'utf8'));
}

async function openNextRound(selectionFile: string, root: string): Promise<void> {
  const round = createStartStageRound({
    selectionFile,
    stage: 'ux',
    profiles: { authors: ['nexus-sol'], evaluator: 'nexus-sol' },
    maxRounds: 3,
    publish: () => undefined,
  });
  await expect(round({ stage: 'ux', route: 'next' })).resolves.toBe('opened');
  expect(
    JSON.parse(await readFile(path.join(root, 'state', 'current-round.json'), 'utf8')),
  ).toMatchObject({ round: 2 });
}

describe('preparation repair rounds', () => {
  it('supplies the preceding revision and evaluation to the author repair', async () => {
    const { selectionFile, issueRoot, root } = await stageWithEvaluation();
    await openNextRound(selectionFile, root);
    const { runner, contexts, roots } = runnerOf([
      {
        outcome: 'authored',
        documents: [{ path: 'docs/ux.md' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
      },
    ]);
    const author: BoundAction = createStageAuthor({
      selectionFile,
      stage: 'ux',
      runner,
      git: scriptedGit([repositoryState()]).git,
      publish: () => undefined,
    });

    await expect(author({ stage: 'ux', task: 'respond' })).resolves.toBe('authored');

    // The invocation's workspace is the preparation issue root; AgentRuntime resolves its one
    // shared checkout at the worktree/ child.
    expect(roots[0]).toBe(issueRoot);
    expect((await stat(path.join(roots[0]!, 'worktree'))).isDirectory()).toBe(true);
    // The response round reads the preceding revision and evaluation from history.
    expect(contexts[0]).toContain('The journey contradicts the requirement');
    expect(contexts[0]).toContain('The current authored revision is 1');
    expect(contexts[0]).toContain('evaluation (retained combined report; context for corrections');
    expect(contexts[0]).toContain(finding.evidence);
    expect(contexts[0]).not.toContain('Eligible prior finding IDs');
    const saved = (await artifact(root, 2, 'author.json')) as Record<string, unknown>;
    expect(saved).toMatchObject({
      revision: 2,
      outcome: 'authored',
      documents: [{ path: 'docs/ux.md' }],
    });
    // The action binds the observed identity to the invocation's assigned Markdown report.
    expect(saved).toMatchObject({
      profile: 'nexus-sol',
      role: 'author',
      report: { path: expect.stringContaining('author.md') },
      reportIdentity: expect.any(String),
    });
    expect(saved).not.toHaveProperty('findingResponses');
    expect(saved).not.toHaveProperty('summary');
  });

  it('rejects a current author response that carries the removed finding-response field', async () => {
    const { selectionFile, root } = await stageWithEvaluation();
    await openNextRound(selectionFile, root);
    const { runner } = runnerOf([
      {
        outcome: 'authored',
        documents: [{ path: 'docs/ux.md' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
        findingResponses: [
          { findingId: 'F1', status: 'addressed', response: 'Removed the forbidden path.' },
        ],
      },
    ]);
    const author = createStageAuthor({
      selectionFile,
      stage: 'ux',
      runner,
      git: scriptedGit([repositoryState()]).git,
      publish: () => undefined,
    });

    await expect(author({ stage: 'ux', task: 'respond' })).rejects.toThrow(
      /does not match the response format/,
    );
    await expect(artifact(root, 2, 'author.json')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('judges the previous evaluation against the current revision without disposition records', async () => {
    const { selectionFile, issueRoot, root } = await stageWithEvaluation();
    await openNextRound(selectionFile, root);
    await writeFile(
      path.join(root, 'artifacts', '2', 'author.json'),
      JSON.stringify({
        stage: 'ux',
        revision: 2,
        outcome: 'authored',
        summary: 'The journey now follows the requirement.',
        documents: [{ path: 'docs/ux.md', description: 'The revised journey.' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
      }),
    );
    const { runner, contexts, roots } = runnerOf([
      {
        verdict: 'changes-requested',
        observation: null,
        upstream: { stage: 'requirements', correction: 'Correct the acceptance example.' },
      },
      {
        verdict: 'return-upstream',
        observation: null,
        upstream: null,
      },
      {
        verdict: 'return-upstream',
        observation: null,
        upstream: { stage: 'requirements', correction: 'Correct the acceptance example.' },
      },
    ]);
    const evaluator = createStageEvaluator({
      git: scriptedGit([repositoryState()], {
        commitPaths: () => ok({ branch: 'task/NEX-1', headRevision: '2'.repeat(40) }),
        readFileAtRevision: () => ok('# UX\n'),
      }).git,
      selectionFile,
      stage: 'ux',
      runner,
      publish: () => undefined,
    });

    // The minimal verdict contract pairs an upstream request only with a return.
    await expect(evaluator({ stage: 'ux' })).rejects.toThrow(
      /only a return-upstream verdict carries the upstream request/,
    );
    await expect(evaluator({ stage: 'ux' })).rejects.toThrow(
      /needs the earlier stage and the concrete correction/,
    );
    // The evaluator judges the earlier concern against the current revision and returns upstream.
    await expect(evaluator({ stage: 'ux' })).resolves.toBe('return-upstream');
    // Every evaluator invocation receives the preparation issue root, not its checkout.
    expect(roots).toEqual([issueRoot, issueRoot, issueRoot]);
    expect((await stat(path.join(roots[0]!, 'worktree'))).isDirectory()).toBe(true);
    // Every invocation reads the previous evaluation as context; no IDs or dispositions are asked
    // for or recorded, and the current verdict is not parsed from that history.
    expect(contexts[2]).toContain('evaluation (retained combined report; context for corrections');
    expect(contexts[2]).toContain(finding.evidence);
    expect(contexts[2]).not.toContain('Eligible prior finding IDs');
    const saved = (await artifact(root, 2, 'evaluation.json')) as Record<string, unknown>;
    expect(saved).toMatchObject({
      verdict: 'return-upstream',
      assessedRevision: 2,
      upstream: { stage: 'requirements', correction: 'Correct the acceptance example.' },
      report: { path: expect.stringContaining('evaluator.md') },
      basis: {
        authorIdentity: expect.any(String),
        repositoryRevision: '2'.repeat(40),
        content: [],
      },
    });
    expect(saved).not.toHaveProperty('findings');
    expect(saved).not.toHaveProperty('priorFindings');
  });

  it('supplies the parent correction and the approved idea handoff to the stage context', async () => {
    const { selectionFile, issueRoot, root } = await stageWithEvaluation();
    await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
    await writeFile(
      path.join(issueRoot, 'parent', 'handoff.json'),
      JSON.stringify({
        stage: 'ux',
        upstreamReturns: 1,
        feedback: null,
        return: {
          from: 'architecture',
          to: 'ux',
          problem: 'The proposed navigation cannot support the acceptance example.',
          consequence: 'The architecture cannot expose the required journey.',
          correction: 'Propose a navigation path that supports the example.',
        },
        awaitingStages: [],
        tickets: [],
        publications: [],
      }),
    );
    await mkdir(path.join(issueRoot, 'refinement', 'artifacts'), { recursive: true });
    await writeFile(
      path.join(issueRoot, 'refinement', 'artifacts', 'handoff.json'),
      JSON.stringify({
        issue: { id: '1', key: 'NEX-1' },
        issueWorkspace: issueRoot,
        capturedInput: 'input.json',
        framing: null,
        refinedIdea: 'idea.json',
        editorResponses: [],
        contributions: [],
        challengerResults: [],
        decision: 'decision.json',
      }),
    );
    // A fresh stage visit opens a new round whose input is the retained correction.
    await writeFile(
      path.join(root, 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'ux',
        round: 3,
        route: 'new',
        profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
      }),
    );
    await mkdir(path.join(root, 'artifacts', '3'), { recursive: true });
    const { runner, contexts } = runnerOf([
      {
        outcome: 'authored',
        documents: [{ path: 'docs/ux.md' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
      },
    ]);
    const author = createStageAuthor({
      selectionFile,
      stage: 'ux',
      runner,
      git: scriptedGit([repositoryState()]).git,
      publish: () => undefined,
    });

    await expect(author({ stage: 'ux', task: 'propose' })).resolves.toBe('authored');

    expect(contexts[0]).toContain('Retained upstream return from the architecture stage');
    expect(contexts[0]).toContain('Propose a navigation path that supports the example.');
    // The approved idea handoff is an upstream reference, and the retained revision continues.
    expect(contexts[0]).toContain(path.join(issueRoot, 'refinement', 'artifacts', 'handoff.json'));
    // A fresh stage visit inherits no earlier evaluation: only re-entry supplies one.
    expect(contexts[0]).not.toContain('The previous evaluation of this work');
    expect(contexts[0]).not.toContain('evaluation (retained combined report');
    await expect(artifact(root, 3, 'author.json')).resolves.toMatchObject({ revision: 2 });
  });

  it('carries its earlier return into the reassessment context without a finding ledger', async () => {
    const { selectionFile, issueRoot, root } = await stageWithEvaluation({
      stage: 'architecture',
      verdict: 'return-upstream',
    });
    // The parent retained that an upstream correction requires this stage's current decision.
    await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
    await writeFile(
      path.join(issueRoot, 'parent', 'handoff.json'),
      JSON.stringify({
        stage: 'architecture',
        upstreamReturns: 1,
        feedback: null,
        return: {
          from: 'architecture',
          to: 'requirements',
          problem: 'The acceptance example contradicts the requirement.',
          consequence: 'The stage cannot express one consistent design.',
          correction: 'Correct the acceptance example.',
        },
        awaitingStages: ['architecture'],
        tickets: [],
        publications: [],
      }),
    );
    const round = createStartStageRound({
      selectionFile,
      stage: 'architecture',
      profiles: { authors: ['nexus-sol'], evaluator: 'nexus-astra' },
      maxRounds: 3,
      publish: () => undefined,
    });
    await expect(round({ stage: 'architecture', route: 'new' })).resolves.toBe('opened');
    expect(
      JSON.parse(await readFile(path.join(root, 'state', 'current-round.json'), 'utf8')),
    ).toMatchObject({ round: 2, route: 'reassess' });

    // The author proposes the retained design with a narrative account; no per-finding response
    // is required.
    const { runner: proposing, contexts: authorContexts } = runnerOf([
      {
        outcome: 'skip-proposed',
        documents: [],
        sourcePaths: [],
        plan: [
          {
            summary: 'Implement the retained design',
            scope: 'Carry the retained design into implementation.',
            completionCriteria: ['The retained design is implemented.'],
            prerequisites: [],
          },
        ],
        skip: { references: ['docs/architecture.md'] },
        question: null,
        upstream: null,
        observation: null,
      },
    ]);
    const author = createStageAuthor({
      selectionFile,
      stage: 'architecture',
      runner: proposing,
      git: scriptedGit([repositoryState()]).git,
      publish: () => undefined,
    });
    await expect(author({ stage: 'architecture', task: 'propose' })).resolves.toBe('skip-proposed');
    expect(authorContexts[0]).toContain(
      'evaluation (retained combined report; context for corrections',
    );
    expect(authorContexts[0]).toContain(finding.evidence);
    expect(authorContexts[0]).not.toContain('Eligible prior finding IDs');

    // The evaluator judges the earlier concern against the reassessed revision and reports only
    // current findings.
    const { runner, contexts } = runnerOf([
      {
        verdict: 'accepted-skip',
        observation: null,
        upstream: null,
      },
    ]);
    const evaluator = createStageEvaluator({
      selectionFile,
      stage: 'architecture',
      runner,
      publish: () => undefined,
      git: scriptedGit([repositoryState()], {
        readFileAtRevision: async (repository, _revision, file) =>
          ok(await readFile(path.join(repository, file), 'utf8')),
      }).git,
    });
    await expect(evaluator({ stage: 'architecture' })).resolves.toBe('accepted-skip');
    expect(contexts[0]).toContain('evaluation (retained combined report; context for corrections');
    expect(contexts[0]).toContain(finding.evidence);
    expect(contexts[0]).not.toContain('Eligible prior finding IDs');
    const saved = (await artifact(root, 2, 'evaluation.json')) as Record<string, unknown>;
    expect(saved).toMatchObject({ verdict: 'accepted-skip', assessedRevision: 2 });
    expect(saved).not.toHaveProperty('findings');
    expect(saved).not.toHaveProperty('priorFindings');
  });

  it('rejects an Architecture skip that omits the plan its handoff requires', async () => {
    const { selectionFile } = await stageWithEvaluation({ stage: 'architecture' });
    const { runner } = runnerOf([
      {
        outcome: 'skip-proposed',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { references: ['docs/architecture.md'] },
        question: null,
        upstream: null,
        observation: null,
      },
    ]);
    const author = createStageAuthor({
      selectionFile,
      stage: 'architecture',
      runner,
      git: scriptedGit([repositoryState()]).git,
      publish: () => undefined,
    });
    await expect(author({ stage: 'architecture', task: 'propose' })).rejects.toThrow(
      /nonempty implementation plan/,
    );
  });

  it('refuses to finalize a retained Architecture skip whose report carries no plan', async () => {
    const { selectionFile, root } = await stageWithEvaluation({ stage: 'architecture' });
    // A retained record written before the plan rule can still reach StageResult, so the result
    // operation refuses it instead of saving a result the handoff cannot consume.
    const retained = {
      stage: 'architecture',
      revision: 1,
      outcome: 'skip-proposed',
      summary: 'The retained design still holds.',
      documents: [],
      sourcePaths: [],
      plan: [],
      skip: { reason: 'The retained design still holds.', references: ['docs/architecture.md'] },
      question: null,
      upstream: null,
      observation: null,
      findingResponses: [],
    };
    await writeFile(path.join(root, 'artifacts', '1', 'author.json'), JSON.stringify(retained));
    const evaluation = JSON.parse(
      await readFile(path.join(root, 'artifacts', '1', 'evaluation.json'), 'utf8'),
    ) as Record<string, unknown>;
    const basis = evaluation['basis'] as Record<string, unknown>;
    await writeFile(
      path.join(root, 'artifacts', '1', 'evaluation.json'),
      JSON.stringify({
        ...evaluation,
        basis: {
          ...basis,
          authorIdentity: authoredIdentity(stageAuthorArtifact.schema.parse(retained)),
          repositoryRevision: '1'.repeat(40),
        },
        verdict: 'accepted-skip',
        reason: 'The existing design still holds.',
        findings: [],
      }),
    );
    const { git } = scriptedGit([repositoryState()], {
      readFileAtRevision: async (repository, _revision, file) =>
        ok(await readFile(path.join(repository, file), 'utf8')),
    });
    const finalize = createStageResult({
      selectionFile,
      stage: 'architecture',
      git,
      publish: () => undefined,
    });
    await expect(finalize({ outcome: 'skipped' })).rejects.toThrow(/nonempty implementation plan/);
  });

  it('keeps a retained combined evaluation readable without judging its former finding list', async () => {
    const { selectionFile, issueRoot, root, selection } = await stageWithEvaluation();
    const evaluationFile = path.join(root, 'artifacts', '1', 'evaluation.json');
    const evaluation = JSON.parse(await readFile(evaluationFile, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      evaluationFile,
      JSON.stringify({ ...evaluation, verdict: 'accepted', reason: 'The journey is adequate.' }),
    );
    const { git } = scriptedGit([repositoryState()], {
      readFileAtRevision: async (_repository, _revision, file) =>
        ok(await readFile(path.join(preparationWorktree(issueRoot), file), 'utf8')),
    });

    // The former blocking finding stays history: the accepted verdict is not matched against a
    // removed finding list. A fresh finalization still needs the action-observed repository
    // revision the legacy record never saved, so the stage reassesses instead.
    const finalize = createStageResult({
      selectionFile,
      stage: 'ux',
      git,
      publish: () => undefined,
    });
    await expect(finalize({ outcome: 'accepted' })).rejects.toThrow(
      /carries no repository observation/,
    );
    await expect(artifact(root, 1, 'result.json')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, 'state', 'result.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // A retained result that already recorded the acceptance keeps that completed decision
    // readable for consumers: report association and captured intent govern, not historical
    // file revisions or former findings.
    await writeFile(
      path.join(root, 'artifacts', '1', 'result.json'),
      JSON.stringify({
        stage: 'ux',
        outcome: 'accepted',
        authoredRevision: 1,
        documents: [],
        sourcePaths: [],
        skipReferences: [],
        outputs: [{ path: path.join(root, 'artifacts', '1', 'evaluation.json') }],
        evaluation: { path: path.join(root, 'artifacts', '1', 'evaluation.json') },
        reason: 'The journey is adequate.',
        returnStage: null,
        returnFinding: null,
        prototype: null,
        prototypeObservations: [],
      }),
    );
    await expect(
      readCurrentDecision({ issueRoot, stage: 'ux', selection: selection as never, git }),
    ).resolves.toMatchObject({ kind: 'current' });
  });

  it.each(['return-upstream', 'needs-input'] as const)(
    'keeps the previous evaluation readable through an author-only $exit',
    async (exit) => {
      const { selectionFile, issueRoot, root, selection } = await stageWithEvaluation();
      const common = { selectionFile, stage: 'ux' as const, publish: () => undefined };
      const { git } = scriptedGit([repositoryState()], {
        readFileAtRevision: async (repository, _revision, file) =>
          ok(await readFile(path.join(repository, file), 'utf8')),
      });
      const open = () =>
        createStartStageRound({
          ...common,
          profiles: { authors: ['a'], evaluator: 'e' },
          maxRounds: 5,
        });
      const exiting = {
        outcome: exit,
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: exit === 'needs-input' ? 'Which acceptance example governs?' : null,
        upstream:
          exit === 'return-upstream'
            ? {
                stage: 'requirements',
                correction: 'Clarify the governing example.',
              }
            : null,
        observation: null,
      };
      await expect(open()({ route: 'next' })).resolves.toBe('opened');
      await expect(
        createStageAuthor({ ...common, git, runner: runnerOf([exiting]).runner })({
          task: 'respond',
        }),
      ).resolves.toBe(exit);
      const resultOutcome = exit === 'needs-input' ? 'needsInput' : 'returnUpstream';
      await createStageResult({ ...common, git })({ outcome: resultOutcome });
      await expect(artifact(root, 2, 'evaluation.json')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readCurrentDecision({ issueRoot, stage: 'ux', selection: selection as never, git }),
      ).resolves.toMatchObject({ kind: 'missing' });
      await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
      await writeFile(
        path.join(issueRoot, 'parent/handoff.json'),
        JSON.stringify({
          stage: 'ux',
          upstreamReturns: 1,
          feedback: null,
          return: null,
          awaitingStages: [],
          tickets: [],
          publications: [],
        }),
      );
      // Recreate the actions from disk as on a restart; retain the latest author and older evidence.
      await expect(open()({ route: 'new' })).resolves.toBe('opened');
      expect(await readStagePlan(root)).toMatchObject({ round: 3, route: 'reassess' });
      const proposal = {
        outcome: 'skip-proposed',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { references: ['docs/ux.md'] },
        question: null,
        upstream: null,
        observation: null,
      };
      const authorReports = runnerOf([proposal]);
      const author = createStageAuthor({ ...common, git, runner: authorReports.runner });
      await expect(author({ task: 'propose' })).resolves.toBe('skip-proposed');
      expect(authorReports.contexts[0]).toContain('The current authored revision is 2');
      expect(authorReports.contexts[0]).toContain(
        'evaluation (retained combined report; context for corrections',
      );
      expect(authorReports.contexts[0]).toContain(finding.evidence);
      expect(authorReports.contexts[0]).not.toContain('Eligible prior finding IDs');
      const assessment = {
        verdict: 'accepted-skip',
        observation: null,
        upstream: null,
      };
      const evaluatorReports = runnerOf([assessment]);
      const evaluate = createStageEvaluator({ ...common, git, runner: evaluatorReports.runner });
      await expect(evaluate()).resolves.toBe('accepted-skip');
      expect(evaluatorReports.contexts[0]).toContain(finding.evidence);
      expect(evaluatorReports.contexts[0]).toContain(
        'evaluation (retained combined report; context for corrections',
      );
      expect(evaluatorReports.contexts[0]).not.toContain('Eligible prior finding IDs');
      await expect(artifact(root, 3, 'evaluation.json')).resolves.toMatchObject({
        verdict: 'accepted-skip',
        assessedRevision: 3,
      });
      await createStageResult({ ...common, git })({ outcome: 'skipped' });

      // A later author-only exit introduces no current finding; the following reassessment reads
      // the most recent evaluation rather than an older finding ledger.
      await open()({ route: 'new' });
      await createStageAuthor({
        ...common,
        git,
        runner: runnerOf([exiting]).runner,
      })({ task: 'propose' });
      await createStageResult({ ...common, git })({ outcome: resultOutcome });
      await expect(
        readCurrentDecision({ issueRoot, stage: 'ux', selection: selection as never, git }),
      ).resolves.toMatchObject({ kind: 'missing' });
      await open()({ route: 'new' });
      const plan = await readStagePlan(root);
      expect(plan).toMatchObject({ round: 5, route: 'reassess' });
      const finalReports = runnerOf([proposal, assessment]);
      await createStageAuthor({ ...common, git, runner: finalReports.runner })({ task: 'propose' });
      await createStageEvaluator({ ...common, git, runner: finalReports.runner })();
      await createStageResult({ ...common, git })({ outcome: 'skipped' });
      // A new applicability skip is evidence-only: it retains its reason and optional references
      // without inventing documents or bindings from the preceding acceptance.
      await expect(artifact(root, 5, 'result.json')).resolves.toMatchObject({
        outcome: 'skipped',
        documents: [],
        sourcePaths: [],
        skipReferences: ['docs/ux.md'],
        prototype: null,
      });
      expect(finalReports.contexts[0]).toContain('The previous evaluation of this work');
      expect(finalReports.contexts[0]).not.toContain(finding.title);
      expect(finalReports.contexts[1]).toContain('The previous evaluation of this work');
    },
  );

  it('opens a pending reassessment as such and carries the retained decision into context', async () => {
    const { selectionFile, issueRoot, root } = await stageWithEvaluation();
    // The parent retained that an upstream correction invalidated this stage's decision.
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
    const round = createStartStageRound({
      selectionFile,
      stage: 'ux',
      profiles: { authors: ['nexus-sol'], evaluator: 'nexus-sol' },
      maxRounds: 3,
      publish: () => undefined,
    });
    await expect(round({ stage: 'ux', route: 'new' })).resolves.toBe('opened');
    expect(
      JSON.parse(await readFile(path.join(root, 'state', 'current-round.json'), 'utf8')),
    ).toMatchObject({ round: 2, route: 'reassess' });

    const { runner, contexts } = runnerOf([
      {
        outcome: 'skip-proposed',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { references: ['docs/ux.md'] },
        question: null,
        upstream: null,
        observation: null,
      },
    ]);
    const author = createStageAuthor({
      selectionFile,
      stage: 'ux',
      runner,
      git: scriptedGit([repositoryState()]).git,
      publish: () => undefined,
    });
    await expect(author({ stage: 'ux', task: 'propose' })).resolves.toBe('skip-proposed');
    expect(contexts[0]).toContain('pending reassessment');
    expect(contexts[0]).toContain('The current authored revision is 1');
    // The reassessed stage reads its earlier evaluation as context, without a finding-ID set or a
    // per-finding response record.
    expect(contexts[0]).toContain('evaluation (retained combined report; context for corrections');
    expect(contexts[0]).toContain(finding.evidence);
    expect(contexts[0]).not.toContain('Eligible prior finding IDs');
  });

  it('carries the returning report and correction through a bound upstream return', async () => {
    const { selectionFile, root } = await stageWithEvaluation();
    await openNextRound(selectionFile, root);
    const { runner } = runnerOf([
      {
        outcome: 'authored',
        documents: [{ path: 'docs/ux.md' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
      },
      {
        verdict: 'return-upstream',
        observation: null,
        upstream: { stage: 'requirements', correction: 'Correct the acceptance example.' },
      },
    ]);
    const git = scriptedGit([repositoryState()], {
      commitPaths: () => ok({ branch: 'task/NEX-1', headRevision: '2'.repeat(40) }),
      readFileAtRevision: async (repository, _revision, file) =>
        ok(await readFile(path.join(repository, file), 'utf8')),
    }).git;
    await createStageAuthor({ selectionFile, stage: 'ux', runner, git, publish: () => undefined })({
      task: 'respond',
    });
    await createStageEvaluator({
      selectionFile,
      stage: 'ux',
      runner,
      git,
      publish: () => undefined,
    })();
    const finalize = createStageResult({
      selectionFile,
      stage: 'ux',
      git,
      publish: () => undefined,
    });
    await expect(finalize({ outcome: 'returnUpstream' })).resolves.toBe('saved');
    const saved = (await artifact(root, 2, 'result.json')) as {
      readonly returnFinding: Record<string, unknown>;
    };
    expect(saved.returnFinding).toMatchObject({
      stage: 'requirements',
      correction: 'Correct the acceptance example.',
      role: 'evaluator',
      // The return keeps the producer's saved binding: its Markdown path and recorded identity.
      report: {
        report: { path: expect.stringContaining('evaluator.md') },
        reportIdentity: expect.any(String),
        invocationId: expect.any(String),
      },
    });
    // A current return explains its problem and consequence in the returning Markdown report.
    expect(saved.returnFinding).not.toHaveProperty('problem');
    expect(saved.returnFinding).not.toHaveProperty('consequence');
  });

  it('keeps a retained combined return problem and consequence as history', async () => {
    const { selectionFile, root } = await stageWithEvaluation({ verdict: 'return-upstream' });
    const { git } = scriptedGit([repositoryState()], {
      readFileAtRevision: async (repository, _revision, file) =>
        ok(await readFile(path.join(repository, file), 'utf8')),
    });
    const finalize = createStageResult({
      selectionFile,
      stage: 'ux',
      git,
      publish: () => undefined,
    });
    await expect(finalize({ outcome: 'returnUpstream' })).resolves.toBe('saved');
    await expect(artifact(root, 1, 'result.json')).resolves.toMatchObject({
      outcome: 'returnUpstream',
      returnStage: 'requirements',
      returnFinding: {
        stage: 'requirements',
        correction: 'Correct the acceptance example.',
        report: null,
        problem: 'The acceptance example contradicts the requirement.',
        consequence: 'The stage cannot express one consistent design.',
      },
    });
  });

  it('refuses to finalize or replay a return whose saved report no longer matches its binding', async () => {
    const { selectionFile, issueRoot, root } = await stageWithEvaluation();
    await openNextRound(selectionFile, root);
    const { runner } = runnerOf([
      {
        outcome: 'authored',
        documents: [{ path: 'docs/ux.md' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        observation: null,
      },
      {
        verdict: 'return-upstream',
        observation: null,
        upstream: { stage: 'requirements', correction: 'Correct the acceptance example.' },
      },
    ]);
    const git = scriptedGit([repositoryState()], {
      commitPaths: () => ok({ branch: 'task/NEX-1', headRevision: '2'.repeat(40) }),
      readFileAtRevision: async (repository, _revision, file) =>
        ok(await readFile(path.join(repository, file), 'utf8')),
    }).git;
    await createStageAuthor({ selectionFile, stage: 'ux', runner, git, publish: () => undefined })({
      task: 'respond',
    });
    await createStageEvaluator({
      selectionFile,
      stage: 'ux',
      runner,
      git,
      publish: () => undefined,
    })();
    const evaluation = (await artifact(root, 2, 'evaluation.json')) as {
      readonly report: { readonly path: string };
    };
    const finalize = createStageResult({
      selectionFile,
      stage: 'ux',
      git,
      publish: () => undefined,
    });

    // The evaluator's assigned Markdown is replaced after its binding was saved: the return cannot
    // leave the stage without the assessment its saved identity names.
    await writeFile(evaluation.report.path, '# Replaced assessment\n\nDifferent bytes.\n');
    await expect(finalize({ outcome: 'returnUpstream' })).rejects.toThrow(
      /does not match the identity recorded/,
    );
    await expect(artifact(root, 2, 'result.json')).rejects.toMatchObject({ code: 'ENOENT' });
    const firstFeedback = await readReportFeedback(root);
    expect(firstFeedback).toHaveLength(1);
    expect(firstFeedback[0]?.record).toMatchObject({
      kind: 'rejection',
      scope: { role: 'ux-evaluator', reportKind: 'stage-evaluation' },
      assignedReport: { path: evaluation.report.path },
    });

    // A completed return replays only while its returning report stays readable with its recorded
    // identity; deleting it after finalization is the same unusable evidence, not a silent skip.
    await writeFile(evaluation.report.path, controlledMarkdown);
    await expect(finalize({ outcome: 'returnUpstream' })).resolves.toBe('saved');
    await rm(evaluation.report.path, { force: true });
    await expect(finalize({ outcome: 'returnUpstream' })).rejects.toThrow(/does not exist/);
    await expect(artifact(root, 2, 'result.json')).resolves.toMatchObject({
      outcome: 'returnUpstream',
      returnFinding: { report: { reportIdentity: expect.any(String) } },
    });
    await expect(readReportFeedback(root)).resolves.toHaveLength(2);

    // The destination context reads the same producer-owned binding: a replaced report is
    // preserved as the returning role's rejection evidence instead of being embedded.
    await writeFile(evaluation.report.path, '# Replacement\n\nSubstituted evidence.\n');
    await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
    const saved = (await artifact(root, 2, 'result.json')) as {
      readonly returnFinding: unknown;
    };
    await writeFile(
      path.join(issueRoot, 'parent', 'handoff.json'),
      JSON.stringify({
        stage: 'requirements',
        upstreamReturns: 1,
        feedback: null,
        return: {
          from: 'ux',
          to: 'requirements',
          role: 'evaluator',
          report: (saved.returnFinding as { readonly report: unknown }).report,
          correction: 'Correct the acceptance example.',
        },
        awaitingStages: [],
        tickets: [],
        publications: [],
      }),
    );
    const destination = createStageAuthor({
      selectionFile,
      stage: 'requirements',
      runner: runnerOf([]).runner,
      git: scriptedGit([repositoryState()]).git,
      publish: () => undefined,
    });
    await mkdir(path.join(stageRoot(issueRoot, 'requirements'), 'state'), { recursive: true });
    await mkdir(path.join(stageRoot(issueRoot, 'requirements'), 'artifacts', '1'), {
      recursive: true,
    });
    await writeFile(
      path.join(stageRoot(issueRoot, 'requirements'), 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'requirements',
        round: 1,
        route: 'new',
        profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
      }),
    );
    await expect(destination({ stage: 'requirements', task: 'propose' })).rejects.toThrow(
      /does not match the identity recorded/,
    );
    const destinationFeedback = await readReportFeedback(root);
    expect(destinationFeedback).toHaveLength(3);
    expect(destinationFeedback.at(-1)?.record).toMatchObject({
      kind: 'rejection',
      scope: { role: 'ux-evaluator', reportKind: 'stage-evaluation' },
    });
  });

  it('refuses a retained evaluation whose verdict carries a contradictory upstream request', async () => {
    const { issueRoot, root, selection } = await stageWithEvaluation();
    const { git } = scriptedGit([repositoryState()], {
      readFileAtRevision: async (_repository, _revision, file) =>
        ok(await readFile(path.join(preparationWorktree(issueRoot), file), 'utf8')),
    });
    const evaluationFile = path.join(root, 'artifacts', '1', 'evaluation.json');
    await writeFile(
      path.join(root, 'artifacts', '1', 'result.json'),
      JSON.stringify({
        stage: 'ux',
        outcome: 'accepted',
        authoredRevision: 1,
        documents: [],
        sourcePaths: [],
        skipReferences: [],
        outputs: [{ path: evaluationFile }],
        evaluation: { path: evaluationFile },
        reason: null,
        returnStage: null,
        returnFinding: null,
        prototype: null,
        prototypeObservations: [],
      }),
    );
    const legacy = JSON.parse(await readFile(evaluationFile, 'utf8')) as Record<string, unknown>;
    // A saved current evaluation keeps the functional verdict/upstream pairing: an accepted
    // decision cannot also request an upstream correction. Removed finding rules stay removed.
    const reportPath = path.join(root, 'artifacts', '1', 'reports', 'inv-1', 'evaluator.md');
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, controlledMarkdown, 'utf8');
    const current = {
      basis: legacy['basis'],
      assessedRevision: 1,
      verdict: 'accepted',
      observation: null,
      upstream: null,
      stage: 'ux',
      taskKey: 'NEX-1',
      profile: 'nexus-sol',
      role: 'evaluator',
      report: { path: reportPath },
      reportIdentity: reportIdentityOf(Buffer.from(controlledMarkdown, 'utf8')),
      invocationId: 'inv-1',
    };
    await writeFile(evaluationFile, JSON.stringify(current));
    await expect(
      readCurrentDecision({ issueRoot, stage: 'ux', selection: selection as never, git }),
    ).resolves.toMatchObject({ kind: 'current' });
    await writeFile(
      evaluationFile,
      JSON.stringify({
        ...current,
        upstream: {
          stage: 'requirements',
          correction: 'Correct the acceptance example.',
        },
      }),
    );
    await expect(
      readCurrentDecision({ issueRoot, stage: 'ux', selection: selection as never, git }),
    ).resolves.toMatchObject({
      kind: 'stale',
      reason: expect.stringContaining('only a return-upstream verdict carries the upstream'),
    });

    // The pairing rule governs retained combined records too, not only current bound responses.
    await writeFile(
      evaluationFile,
      JSON.stringify({
        ...legacy,
        verdict: 'accepted',
        upstream: {
          stage: 'requirements',
          problem: 'The acceptance example contradicts the requirement.',
          consequence: 'The stage cannot express one consistent design.',
          correction: 'Correct the acceptance example.',
        },
      }),
    );
    await expect(
      readCurrentDecision({ issueRoot, stage: 'ux', selection: selection as never, git }),
    ).resolves.toMatchObject({
      kind: 'stale',
      reason: expect.stringContaining('only a return-upstream verdict carries the upstream'),
    });
    // An accepted side without a contradictory request still reads as the current decision.
    await writeFile(evaluationFile, JSON.stringify({ ...legacy, verdict: 'accepted' }));
    await expect(
      readCurrentDecision({ issueRoot, stage: 'ux', selection: selection as never, git }),
    ).resolves.toMatchObject({ kind: 'current' });
  });
});

/** A new bound round produced through the real author/evaluator actions. */
async function boundRound(
  outcome: 'authored' | 'needs-input' = 'authored',
  verdict: 'accepted' | 'return-upstream' = 'accepted',
) {
  const fixture = await stageWithEvaluation();
  await openNextRound(fixture.selectionFile, fixture.root);
  const { runner, contexts } = runnerOf([
    {
      outcome,
      documents: [],
      sourcePaths: [],
      plan: [],
      skip: null,
      question: outcome === 'needs-input' ? 'Which acceptance example governs?' : null,
      upstream: null,
      observation: null,
    },
    {
      verdict,
      observation: null,
      upstream:
        verdict === 'return-upstream'
          ? { stage: 'requirements', correction: 'Correct the acceptance example.' }
          : null,
    },
  ]);
  const git = scriptedGit([repositoryState()]).git;
  const settings = {
    selectionFile: fixture.selectionFile,
    stage: 'ux' as const,
    runner,
    git,
    publish: () => undefined,
  };
  await createStageAuthor(settings)({ task: 'respond' });
  if (outcome === 'authored') await createStageEvaluator(settings)();
  const author = (await artifact(fixture.root, 2, 'author.json')) as StageAuthorOutput;
  const evaluation =
    outcome === 'authored'
      ? ((await artifact(fixture.root, 2, 'evaluation.json')) as StageEvaluationOutput)
      : null;
  return { ...fixture, git, author, evaluation, contexts, finalize: createStageResult(settings) };
}

describe('preparation retained outcome usability', () => {
  it('rejects damaged current returns across result, parent handoff and idea input readers', async () => {
    const { root, evaluation, finalize } = await boundRound('authored', 'return-upstream');
    await expect(finalize({ outcome: 'returnUpstream' })).resolves.toBe('saved');
    const result = (await artifact(root, 2, 'result.json')) as Record<string, unknown>;
    const finding = result['returnFinding'] as Record<string, unknown>;
    const binding = finding['report'] as Record<string, unknown>;
    await rm(evaluation!.report.path);
    const damaged = [
      { ...finding, report: undefined },
      { ...finding, role: undefined },
      { ...finding, role: undefined, report: undefined },
      ...['report', 'reportIdentity', 'invocationId'].map((field) => ({
        ...finding,
        report: { ...binding, [field]: undefined },
      })),
    ];
    for (const returned of damaged) {
      const brokenResult = { ...result, returnFinding: returned };
      expect(preparationResultSchema.safeParse(brokenResult).success).toBe(false);
      expect(
        stageReturnSchema.safeParse({ ...returned, from: 'ux', to: 'requirements' }).success,
      ).toBe(false);
      expect(
        ideaParentInputSchema.safeParse({
          question: null,
          returnFinding: { ...returned, from: 'ux' },
        }).success,
      ).toBe(false);
      await writeFile(path.join(root, 'artifacts/2/result.json'), JSON.stringify(brokenResult));
      await expect(finalize({ outcome: 'returnUpstream' })).rejects.toThrow();
    }
    expect(preparationResultSchema.safeParse({ ...result, returnFinding: null }).success).toBe(
      false,
    );
    expect(preparationResultSchema.safeParse({ ...result, returnStage: 'idea' }).success).toBe(
      false,
    );
    // Historical and action-generated returns need the original problem and consequence.
    for (const returned of [
      {
        stage: 'requirements',
        correction: 'Correct the example.',
        problem: 'The example contradicts the requirement.',
        consequence: 'The journey cannot be consistent.',
      },
      {
        stage: 'requirements',
        role: null,
        report: null,
        correction: 'Reassess the work.',
        problem: 'The retained decision is stale.',
        consequence: 'The route cannot advance.',
      },
    ]) {
      expect(
        preparationResultSchema.safeParse({ ...result, returnFinding: returned }).success,
      ).toBe(true);
      expect(
        stageReturnSchema.safeParse({ ...returned, from: 'ux', to: 'requirements' }).success,
      ).toBe(true);
      expect(
        ideaParentInputSchema.safeParse({
          question: null,
          returnFinding: { ...returned, from: 'ux' },
        }).success,
      ).toBe(true);
    }
  });

  it.each(['current', 'legacy'] as const)(
    'rejects contradictory %s evaluations before upstream finalization or context use',
    async (kind) => {
      const fixture =
        kind === 'current'
          ? await boundRound('authored', 'return-upstream')
          : await stageWithEvaluation({ verdict: 'return-upstream' });
      const round = kind === 'current' ? 2 : 1;
      const evaluation = (await artifact(fixture.root, round, 'evaluation.json')) as Record<
        string,
        unknown
      >;
      const file = path.join(fixture.root, 'artifacts', String(round), 'evaluation.json');
      const finalize = createStageResult({
        selectionFile: fixture.selectionFile,
        stage: 'ux',
        git: scriptedGit([repositoryState()]).git,
        publish: () => undefined,
      });
      for (const changed of [
        { ...evaluation, verdict: 'changes-requested' },
        { ...evaluation, upstream: null },
      ]) {
        await writeFile(file, JSON.stringify(changed));
        await expect(
          readStageArtifact(fixture.root, round, stageEvaluationArtifact),
        ).rejects.toThrow(/upstream/);
        await expect(finalize({ outcome: 'returnUpstream' })).rejects.toThrow(/upstream/);
        await expect(artifact(fixture.root, round, 'result.json')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    },
  );

  it.each(['missing', 'directory', 'changed'] as const)(
    'retains author rejection for a %s needs-input report at finalization and replay',
    async (damage) => {
      const { root, author, finalize } = await boundRound('needs-input');
      const corrupt = async () => {
        await rm(author.report.path, { recursive: true, force: true });
        if (damage === 'directory') await mkdir(author.report.path);
        if (damage === 'changed') await writeFile(author.report.path, 'Replacement report.');
      };
      await corrupt();
      await expect(finalize({ outcome: 'needsInput' })).rejects.toThrow(/report/);
      await expect(artifact(root, 2, 'result.json')).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(author.report.path, { recursive: true, force: true });
      await writeFile(author.report.path, controlledMarkdown);
      await expect(finalize({ outcome: 'needsInput' })).resolves.toBe('saved');
      const original = await readFile(path.join(root, 'artifacts/2/result.json'), 'utf8');
      await corrupt();
      await expect(finalize({ outcome: 'needsInput' })).rejects.toThrow(/report/);
      expect(await readFile(path.join(root, 'artifacts/2/result.json'), 'utf8')).toBe(original);
      const feedback = await readReportFeedback(root);
      expect(feedback).toHaveLength(2);
      for (const entry of feedback)
        expect(entry.record).toMatchObject({
          kind: 'rejection',
          invocationId: author.invocationId,
          profile: author.profile,
          scope: { role: 'ux-author', reportKind: 'stage-author' },
          source: { path: path.join(root, 'artifacts/2/author.json') },
          assignedReport: author.report,
        });
    },
  );

  it.each(['author', 'evaluator'] as const)(
    'retains %s report rejection at acceptance, downstream read and completed replay',
    async (role) => {
      const { issueRoot, root, selection, git, author, evaluation, finalize } = await boundRound();
      const producer = role === 'author' ? author : evaluation!;
      await rm(producer.report.path);
      await expect(finalize({ outcome: 'accepted' })).rejects.toThrow(/does not exist/);
      await expect(artifact(root, 2, 'result.json')).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(producer.report.path, controlledMarkdown);
      await expect(finalize({ outcome: 'accepted' })).resolves.toBe('saved');
      await writeFile(producer.report.path, 'Replacement bytes.');
      await expect(
        readCurrentDecision({ issueRoot, stage: 'ux', selection: selection as never, git }),
      ).resolves.toMatchObject({
        kind: 'stale',
        reason: expect.stringContaining('does not match'),
      });
      await expect(finalize({ outcome: 'accepted' })).rejects.toThrow(/does not match/);
      const feedback = await readReportFeedback(root);
      expect(feedback).toHaveLength(3);
      for (const entry of feedback)
        expect(entry.record).toMatchObject({
          kind: 'rejection',
          invocationId: producer.invocationId,
          profile: producer.profile,
          scope: {
            role: `ux-${role}`,
            reportKind: role === 'author' ? 'stage-author' : 'stage-evaluation',
          },
          source: {
            path: path.join(
              root,
              'artifacts/2',
              role === 'author' ? 'author.json' : 'evaluation.json',
            ),
          },
          assignedReport: producer.report,
        });
    },
  );
});
