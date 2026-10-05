/**
 * Focused integration tests: the captured KAN-76 requirements rejection replays through the real
 * StageAuthor, a conforming skip reaches evaluation while the invalid counterpart stays rejected,
 * the saved author record carries the action-added stage and revision metadata, a malformed
 * retained record is diagnosed with its readable bytes preserved, and the invocation states the
 * authoring and ownership rules before the agent responds. No live provider is involved.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ok } from '../src/result.js';
import type { AgentRoleRunner } from '../src/task-engine/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import { scriptedGit, repositoryState } from './support/git.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const stage = 'requirements' as const;

/** The captured KAN-76 round-3 response: a skip proposal that declared reading references as
 * stage-owned source paths, replayed from its retained recovery evidence. */
const capturedRejectedResponse = {
  outcome: 'skip-proposed',
  summary:
    'Existing requirements at revision d2fe63172d8dbdba28114194d3f658720d4bde19 satisfy this ' +
    'stage. No edits or material product decisions are needed; documentation references resolve.',
  documents: [],
  sourcePaths: [
    'docs/requirements.md',
    'docs/requirements/README.md',
    'docs/requirements/requirements-framework.md',
    'docs/testing.md',
    'docs/ci-cd.md',
    'docs/tech-stack.md',
    'docs/architecture.md',
    'infra/README.md',
  ],
  observation: null,
  plan: [],
  skip: {
    reason:
      'The current delivery requirements define affected developers/Nexus agents and release ' +
      'operators, their journey, activities, rules and observable acceptance examples. They ' +
      'cover component ownership, public boundaries, external final assembly, complete-task-diff ' +
      'validation, affected consumers and repository tests, shared GitHub selection, preserved ' +
      'deployment behavior and exclusions. No material product decision remains unsettled; ' +
      'technical mechanisms belong to Architecture. This proposal does not claim implementation ' +
      'completion.',
    references: [
      'docs/requirements.md#purpose-categories-and-journey',
      'docs/requirements.md#activities-and-rules',
      'docs/requirements.md#observable-acceptance-examples',
      'docs/requirements.md#boundaries-and-unsettled-decisions',
      'docs/testing.md#ci-validation-selection',
      'docs/ci-cd.md#workflow-composition',
      'docs/tech-stack.md#reproducible-workspace',
    ],
  },
  question: null,
  upstream: null,
  findingResponses: [],
};

/** The conforming counterpart: the same skip with its citations in skip.references only. */
const conformingSkipResponse = {
  outcome: 'skip-proposed',
  summary:
    'The retained requirements documents already cover the captured outcome; no edits or ' +
    'product decisions are needed.',
  documents: [],
  sourcePaths: [],
  observation: null,
  plan: [],
  skip: {
    reason:
      'The existing requirements documents already cover the captured outcome: affected ' +
      'categories, journey, activities, rules and observable acceptance examples.',
    references: ['docs/requirements.md', 'docs/testing.md'],
  },
  question: null,
  upstream: null,
  findingResponses: [],
};

/** One requirements stage area with KAN-76's retained rounds 1 and 2 and an open round 3. */
async function stageArea(): Promise<{
  readonly selectionFile: string;
  readonly root: string;
  readonly worktree: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-report-contracts-'));
  temporaryDirectories.push(directory);
  const issueRoot = path.join(directory, 'KAN-76');
  const root = path.join(issueRoot, stage);
  const worktree = path.join(issueRoot, 'worktree');
  await mkdir(path.join(worktree, 'docs'), { recursive: true });
  await writeFile(
    path.join(worktree, 'docs', 'requirements.md'),
    '# Requirements\n\nThe component delivery contract.\n',
  );
  await writeFile(
    path.join(worktree, 'docs', 'testing.md'),
    '# Testing\n\nCI validation selection.\n',
  );
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'KAN-76',
      source: { kind: 'jira', issueId: '10994' },
      task: { id: '10994', key: 'KAN-76', fields: {} },
      conversation: [],
      workspace: { root: issueRoot },
      stage,
    }),
  );
  // The retained round 1 authored revision and the recovered round 2 skip proposal.
  await mkdir(path.join(root, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(root, 'artifacts', '1', 'author.json'),
    JSON.stringify({
      stage,
      revision: 1,
      outcome: 'authored',
      summary: 'Defined the affected categories, journey, activities and rules.',
      documents: [
        { path: 'docs/requirements.md', description: 'Defines the delivery requirements.' },
        { path: 'docs/testing.md', description: 'Aligns test ownership.' },
      ],
      sourcePaths: [],
      observation: null,
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      findingResponses: [],
    }),
  );
  await mkdir(path.join(root, 'artifacts', '2'), { recursive: true });
  await writeFile(
    path.join(root, 'artifacts', '2', 'author.json'),
    JSON.stringify({
      stage,
      revision: 2,
      outcome: 'skip-proposed',
      summary: 'The retained requirements already satisfy the stage.',
      documents: [],
      sourcePaths: [],
      observation: null,
      plan: [],
      skip: {
        reason: 'The exact current worktree documents already cover the captured outcome.',
        references: ['docs/requirements.md', 'docs/testing.md'],
      },
      question: null,
      upstream: null,
      findingResponses: [],
    }),
  );
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({
      stage,
      round: 3,
      route: 'new',
      profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
    }),
  );
  // StartStageRound opens the round's artifact directory before the author is invoked.
  await mkdir(path.join(root, 'artifacts', '3'), { recursive: true });
  return { selectionFile, root, worktree };
}

/** One scripted author invocation that returns the supplied response and records its context. */
function authorRunner(response: unknown, contexts: string[]): AgentRoleRunner {
  return {
    async run(request) {
      contexts.push(request.context);
      return ok({ output: JSON.stringify(response) });
    },
  };
}

it('rejects the captured KAN-76 skip while a conforming skip reaches evaluation', async () => {
  const { selectionFile, root, worktree } = await stageArea();
  const { git } = scriptedGit([repositoryState()], {
    // The evaluator confirms the relied-on skip references still match the assessed revision.
    readFileAtRevision: async (_repository, _revision, file) =>
      ok(await readFile(path.join(worktree, file), 'utf8')),
  });
  const common = { selectionFile, stage, git, publish: () => undefined };

  const contexts: string[] = [];
  const author = createStageAuthor({
    ...common,
    runner: authorRunner(capturedRejectedResponse, contexts),
  });
  await expect(author({ task: 'propose' })).rejects.toThrow(
    'The requirements author report is unusable: only authored work may declare stage-owned ' +
      'source paths.',
  );
  await expect(readFile(path.join(root, 'artifacts', '3', 'author.json'), 'utf8')).rejects.toThrow(
    /ENOENT/,
  );

  // The invocation stated the ownership and outcome rules before the agent responded, including
  // the rule the captured report violated.
  const authorContext = contexts.join('\n');
  expect(authorContext).toContain('empty documents and sourcePaths');
  expect(authorContext).toContain('skip.references');
  expect(authorContext).toContain('files that were merely read');
  expect(authorContext).toContain('do not write or overwrite the action-owned stage records');
  expect(authorContext).toContain('Only the Architecture stage supplies plan entries');

  const conforming = createStageAuthor({
    ...common,
    runner: authorRunner(conformingSkipResponse, []),
  });
  await expect(conforming({ task: 'propose' })).resolves.toBe('skip-proposed');
  const savedAuthor = JSON.parse(
    await readFile(path.join(root, 'artifacts', '3', 'author.json'), 'utf8'),
  ) as Record<string, unknown>;
  // The action added the stage and authored revision the agent response omitted.
  expect(savedAuthor).toMatchObject({ stage, revision: 3, outcome: 'skip-proposed' });

  const evaluatorContexts: string[] = [];
  const evaluator = createStageEvaluator({
    ...common,
    runner: {
      async run(request) {
        evaluatorContexts.push(request.context);
        return ok({
          output: JSON.stringify({
            assessedRevision: 3,
            verdict: 'accepted-skip',
            reason: 'The existing requirements documents satisfy the stage.',
            observation: null,
            findings: [],
            priorFindings: [],
            upstream: null,
          }),
        });
      },
    },
  });
  await expect(evaluator()).resolves.toBe('accepted-skip');
  const evaluatorContext = evaluatorContexts.join('\n');
  expect(evaluatorContext).toContain('"outcome": "skip-proposed"');
  expect(evaluatorContext).toContain('Assess the exact authored revision 3');
  expect(evaluatorContext).toContain('do not write or overwrite the action-owned stage records');
  const evaluation = JSON.parse(
    await readFile(path.join(root, 'artifacts', '3', 'evaluation.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(evaluation).toMatchObject({ assessedRevision: 3, verdict: 'accepted-skip' });
  expect(worktree).toContain('worktree');
});

it('diagnoses a malformed retained author record without normalizing or overwriting it', async () => {
  const { selectionFile, root } = await stageArea();
  // The captured KAN-76 round-1 failure: an agent response written directly into the
  // action-owned record, missing the stage and revision metadata.
  const malformed = {
    outcome: 'authored',
    summary: 'Defined the delivery categories and journey from the captured owner request.',
    documents: [{ path: 'docs/requirements.md', description: 'Defines the requirements.' }],
    sourcePaths: ['docs/requirements.md', 'docs/testing.md'],
    observation: null,
    plan: [],
    skip: null,
    question: null,
    upstream: null,
    findingResponses: [],
  };
  const record = path.join(root, 'artifacts', '2', 'author.json');
  await writeFile(record, JSON.stringify(malformed));
  const { git } = scriptedGit([repositoryState()]);
  const author = createStageAuthor({
    selectionFile,
    stage,
    git,
    publish: () => undefined,
    runner: authorRunner(conformingSkipResponse, []),
  });
  const error = await author({ task: 'propose' }).then(
    () => null,
    (reason: Error) => reason,
  );
  expect(error?.message).toContain(record);
  expect(error?.message).toContain('does not match its declared content type');
  expect(error?.message).toContain('stage');
  expect(error?.message).toContain('revision');
  // The rejected bytes stay readable evidence; the action did not normalize or replace them.
  expect(JSON.parse(await readFile(record, 'utf8'))).toEqual(malformed);
});
