/**
 * Focused integration tests: the real preparation author/evaluator actions carry the preceding
 * revision and findings into a repair round, enforce the shared findings contract, bind every
 * acceptance to its complete basis and open a pending reassessment as such. Temporary stage areas
 * hold real records beside one shared checkout; the agent runner is a controlled report source.
 * No live provider or source service is involved.
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
import { createStartStageRound } from '../src/task-engine/actions/preparation/start-stage-round/index.js';
import {
  authoredIdentity,
  sourceInputIdentity,
} from '../src/task-engine/actions/preparation/evaluation-content.js';
import { preparationWorktree } from '../src/task-engine/actions/preparation/storage.js';
import type { Finding } from '../src/task-engine/actions/review/artifacts.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const finding: Finding = {
  id: 'F1',
  title: 'The journey contradicts the requirement',
  severity: 'blocking',
  basis: 'The accepted requirement is contradicted by the proposed journey.',
  evidence: 'docs/ux.md describes a navigation path the requirement forbids.',
  impact: 'Users cannot complete the journey the requirement states.',
  repairGuidance: 'Revise the journey to follow the requirement.',
  locations: [{ path: 'docs/ux.md', line: 2 }],
};

/** One stage area with a completed first round: an authored revision and its evaluation. */
async function stageWithEvaluation(): Promise<{
  readonly selectionFile: string;
  readonly issueRoot: string;
  readonly root: string;
  readonly selection: Record<string, unknown>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-preparation-handoff-'));
  temporaryDirectories.push(directory);
  const issueRoot = path.join(directory, 'NEX-1');
  const root = path.join(issueRoot, 'ux');
  const selectionFile = path.join(directory, 'selection.json');
  const selection = {
    taskKey: 'NEX-1',
    source: { kind: 'jira', issueId: '1' },
    task: { id: '1', key: 'NEX-1', fields: { summary: 'Refine the journey' } },
    conversation: [],
    workspace: { root: issueRoot },
    stage: 'ux',
  };
  await writeFile(selectionFile, JSON.stringify(selection));
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'artifacts', '1'), { recursive: true });
  await mkdir(path.join(preparationWorktree(issueRoot), 'docs'), { recursive: true });
  await writeFile(path.join(preparationWorktree(issueRoot), 'docs', 'ux.md'), '# UX\n');
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({
      stage: 'ux',
      round: 1,
      route: 'new',
      profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
    }),
  );
  const author = {
    stage: 'ux',
    revision: 1,
    outcome: 'authored',
    summary: 'The first journey proposal.',
    documents: [{ path: 'docs/ux.md', description: 'The proposed journey.' }],
    sourcePaths: [],
    plan: [],
    skip: null,
    question: null,
    upstream: null,
    findingResponses: [],
  };
  await writeFile(path.join(root, 'artifacts', '1', 'author.json'), JSON.stringify(author));
  await writeFile(
    path.join(root, 'artifacts', '1', 'evaluation.json'),
    JSON.stringify({
      basis: {
        author: { path: path.join(root, 'artifacts', '1', 'author.json') },
        authorIdentity: authoredIdentity(author as never),
        sourceIdentity: sourceInputIdentity(selection as never),
        upstream: [],
        content: [{ path: 'docs/ux.md', revision: '1'.repeat(40), exists: true }],
      },
      assessedRevision: 1,
      verdict: 'changes-requested',
      reason: 'The journey contradicts the requirement.',
      findings: [finding],
      priorFindings: [],
      upstream: null,
    }),
  );
  return { selectionFile, issueRoot, root, selection };
}

/** A controlled runner returning the supplied reports in order and recording every context. */
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
  it('supplies the preceding revision and findings to the author response', async () => {
    const { selectionFile, issueRoot, root } = await stageWithEvaluation();
    await openNextRound(selectionFile, root);
    const { runner, contexts, roots } = runnerOf([
      {
        outcome: 'authored',
        summary: 'The journey now follows the requirement.',
        documents: [{ path: 'docs/ux.md', description: 'The revised journey.' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        findingResponses: [
          { findingId: 'F1', status: 'addressed', response: 'Removed the forbidden path.' },
        ],
      },
    ]);
    const author: BoundAction = createStageAuthor({
      selectionFile,
      stage: 'ux',
      runner,
      git: scriptedGit([]).git,
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
    expect(contexts[0]).toContain('Eligible prior finding IDs: "F1"');
    await expect(artifact(root, 2, 'author.json')).resolves.toMatchObject({
      revision: 2,
      findingResponses: [{ findingId: 'F1', status: 'addressed' }],
    });
  });

  it('rejects an author response that drops a prior finding', async () => {
    const { selectionFile, root } = await stageWithEvaluation();
    await openNextRound(selectionFile, root);
    const { runner } = runnerOf([
      {
        outcome: 'authored',
        summary: 'The journey now follows the requirement.',
        documents: [{ path: 'docs/ux.md', description: 'The revised journey.' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        findingResponses: [],
      },
    ]);
    const author = createStageAuthor({
      selectionFile,
      stage: 'ux',
      runner,
      git: scriptedGit([]).git,
      publish: () => undefined,
    });

    await expect(author({ stage: 'ux', task: 'respond' })).rejects.toThrow(
      /did not respond to finding "F1"/,
    );
  });

  it('requires the evaluator to dispose of the inherited finding and reject blocked acceptance', async () => {
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
        findingResponses: [
          { findingId: 'F1', status: 'addressed', response: 'Removed the forbidden path.' },
        ],
      }),
    );
    const { runner, contexts, roots } = runnerOf([
      {
        assessedRevision: 2,
        verdict: 'accepted',
        reason: 'Nothing further is needed.',
        findings: [finding],
        priorFindings: [{ findingId: 'F1', disposition: 'open', reason: 'It is still present.' }],
        upstream: null,
      },
      {
        assessedRevision: 2,
        verdict: 'accepted',
        reason: 'Nothing further is needed.',
        findings: [],
        priorFindings: [],
        upstream: null,
      },
      {
        assessedRevision: 2,
        verdict: 'accepted',
        reason: 'Nothing further is needed.',
        findings: [],
        priorFindings: [
          { findingId: 'F1', disposition: 'resolved', reason: 'The path was removed.' },
        ],
        upstream: null,
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

    // An acceptance that keeps the blocking finding open is unusable output.
    await expect(evaluator({ stage: 'ux' })).rejects.toThrow(
      /accepts the revision while reporting/,
    );
    // A report that drops the inherited finding's disposition is unusable output.
    await expect(evaluator({ stage: 'ux' })).rejects.toThrow(
      /does not dispose of prior finding "F1"/,
    );
    // A complete report resolves the finding and records its disposition.
    await expect(evaluator({ stage: 'ux' })).resolves.toBe('accepted');
    // Every evaluator invocation receives the preparation issue root, not its checkout.
    expect(roots).toEqual([issueRoot, issueRoot, issueRoot]);
    expect((await stat(path.join(roots[0]!, 'worktree'))).isDirectory()).toBe(true);
    expect(contexts[1]).toContain('Eligible prior finding IDs: "F1"');
    await expect(artifact(root, 2, 'evaluation.json')).resolves.toMatchObject({
      priorFindings: [{ findingId: 'F1', disposition: 'resolved' }],
      basis: {
        authorIdentity: expect.any(String),
        content: [{ path: 'docs/ux.md', revision: '2'.repeat(40), exists: true }],
      },
    });
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
        summary: 'The journey supports the acceptance example.',
        documents: [{ path: 'docs/ux.md', description: 'The revised journey.' }],
        sourcePaths: [],
        plan: [],
        skip: null,
        question: null,
        upstream: null,
        findingResponses: [],
      },
    ]);
    const author = createStageAuthor({
      selectionFile,
      stage: 'ux',
      runner,
      git: scriptedGit([]).git,
      publish: () => undefined,
    });

    await expect(author({ stage: 'ux', task: 'propose' })).resolves.toBe('authored');

    expect(contexts[0]).toContain('Retained upstream return from the architecture stage');
    expect(contexts[0]).toContain('Propose a navigation path that supports the example.');
    // The approved idea handoff is an upstream reference, and the retained revision continues.
    expect(contexts[0]).toContain(path.join(issueRoot, 'refinement', 'artifacts', 'handoff.json'));
    await expect(artifact(root, 3, 'author.json')).resolves.toMatchObject({ revision: 2 });
  });

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
        summary: 'The retained work still suffices.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { reason: 'Retained work still suffices.', references: ['docs/ux.md'] },
        question: null,
        upstream: null,
        findingResponses: [],
      },
    ]);
    const author = createStageAuthor({
      selectionFile,
      stage: 'ux',
      runner,
      git: scriptedGit([]).git,
      publish: () => undefined,
    });
    await expect(author({ stage: 'ux', task: 'propose' })).resolves.toBe('skip-proposed');
    expect(contexts[0]).toContain('pending reassessment');
    expect(contexts[0]).toContain('The current authored revision is 1');
  });
});
