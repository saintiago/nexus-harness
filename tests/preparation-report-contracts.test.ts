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
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import { upstreamReferences } from '../src/task-engine/actions/preparation/context.js';
import { capturedSourcePathOf } from '../src/task-engine/actions/preparation/readable-source.js';
import {
  stageEvaluationArtifact,
  stagePlanArtifact,
  stageResultArtifact,
  type PreparationStage,
  type StageAuthorOutput,
} from '../src/task-engine/actions/preparation/artifacts.js';
import {
  readCurrentDecision,
  readStageArtifact,
} from '../src/task-engine/actions/preparation/storage.js';
import { selectionDeclaration } from '../src/task-engine/actions/select-task/artifacts.js';
import {
  outstandingReportFeedback,
  projectOfWorkspace,
  readReportFeedback,
} from '../src/task-engine/actions/report-feedback.js';
import { stageReportScope } from '../src/task-engine/actions/preparation/artifacts.js';
import { scriptedGit, repositoryState } from './support/git.js';
import { writeAssignedReport } from './support/agent-runner.js';

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
};

/** The conforming counterpart: the same skip with its citations in skip.references only. */
const conformingSkipResponse = {
  outcome: 'skip-proposed',
  documents: [],
  sourcePaths: [],
  observation: null,
  plan: [],
  skip: {
    references: ['docs/requirements.md', 'docs/testing.md'],
  },
  question: null,
  upstream: null,
};

/** One requirements stage area with KAN-76's retained rounds 1 and 2 and an open round 3. */
async function stageArea(selectedStage: PreparationStage = stage): Promise<{
  readonly selectionFile: string;
  readonly root: string;
  readonly worktree: string;
}> {
  const stage = selectedStage;
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

/**
 * One scripted author invocation that writes the assigned Markdown report, returns the supplied
 * response and records its context.
 */
function authorRunner(response: unknown, contexts: string[]): AgentRoleRunner {
  return {
    async run(request) {
      contexts.push(request.context);
      await writeAssignedReport(request.context, '# Requirements author report\n\nNarrative.\n');
      return ok({ output: JSON.stringify(response) });
    },
  };
}

/**
 * One scripted evaluator invocation that writes the assigned Markdown report, returns the supplied
 * response and records its context.
 */
function evaluatorRunner(response: unknown, contexts: string[]): AgentRoleRunner {
  return {
    async run(request) {
      contexts.push(request.context);
      await writeAssignedReport(
        request.context,
        '# Requirements evaluation report\n\nNarrative.\n',
      );
      return ok({ output: JSON.stringify(response) });
    },
  };
}

/** The prototype documents the captured HARN-96 skip relied on, inside its shared checkout. */
const prototypeDocuments = [
  'docs/agent-runtime/report-requirements.md',
  'docs/ux-ui.md',
  'package.json',
  'tests/fixtures/storybook/package.json',
  'docs/tech-stack.md',
  'docs/operator-interface.md',
];

/**
 * The captured HARN-96 prototype round 1 report, whose skip.references carried paths with
 * revision and explanatory prose. StageEvaluator resolved the whole string as a filename and
 * failed ENAMETOOLONG before the evaluator was invoked.
 */
const capturedPrototypeSkip = {
  outcome: 'skip-proposed',
  documents: [],
  sourcePaths: [],
  observation: null,
  plan: [],
  skip: {
    references: [
      'docs/agent-runtime/report-requirements.md at revision 9ec1f78519d6d7f6fa97a5ee70bfa63f1ee3332a \u2014 scope: no reporting-terminal interaction.',
      'docs/ux-ui.md at revision 9ec1f78519d6d7f6fa97a5ee70bfa63f1ee3332a \u2014 preparation applicability: internal changes do not by themselves require a UI prototype; do not invent terminal interactions.',
      'Connected checkout at revision 9ec1f78519d6d7f6fa97a5ee70bfa63f1ee3332a: root package.json declares no Storybook dependency or preview command.',
    ],
  },
  question: null,
  upstream: null,
};

/** The retained repaired report: the same skip citing the actual documents. */
const repairedPrototypeSkip = {
  ...capturedPrototypeSkip,
  skip: { references: prototypeDocuments },
};

/** One prototype stage area whose checkout holds the documents the captured skip cites. */
async function prototypeStageArea(): Promise<{
  readonly selectionFile: string;
  readonly root: string;
  readonly worktree: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-report-contracts-'));
  temporaryDirectories.push(directory);
  const issueRoot = path.join(directory, 'HARN-96');
  const root = path.join(issueRoot, 'prototype');
  const worktree = path.join(issueRoot, 'worktree');
  for (const document of prototypeDocuments) {
    const file = path.join(worktree, document);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `# ${document}\n\nEvidence ${document}.\n`);
  }
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'HARN-96',
      source: { kind: 'jira', issueId: '10995' },
      task: { id: '10995', key: 'HARN-96', fields: {} },
      conversation: [],
      workspace: { root: issueRoot },
      stage: 'prototype',
    }),
  );
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({
      stage: 'prototype',
      round: 1,
      route: 'new',
      profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
    }),
  );
  return { selectionFile, root, worktree };
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
  expect(authorContext).toContain('do not write or overwrite action-owned author.json');
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
        await writeAssignedReport(request.context, '# Requirements evaluation report\n');
        return ok({
          output: JSON.stringify({
            verdict: 'accepted-skip',
            observation: null,
            upstream: null,
          }),
        });
      },
    },
  });
  await expect(evaluator()).resolves.toBe('accepted-skip');
  const evaluatorContext = evaluatorContexts.join('\n');
  // The current author is attributed through readable references; its full record and report are
  // referenced by path rather than embedded as raw JSON.
  expect(evaluatorContext).toContain('outcome skip-proposed');
  expect(evaluatorContext).toContain(path.join(root, 'artifacts', '3', 'author.json'));
  expect(evaluatorContext).not.toContain('"outcome": "skip-proposed"');
  expect(evaluatorContext).not.toContain('Requirements author report');
  expect(evaluatorContext).toContain('Assess the exact authored revision 3');
  expect(evaluatorContext).toContain('do not write or overwrite action-owned author.json');
  const evaluation = JSON.parse(
    await readFile(path.join(root, 'artifacts', '3', 'evaluation.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(evaluation).toMatchObject({ assessedRevision: 3, verdict: 'accepted-skip' });
  expect(worktree).toContain('worktree');
});

it('permits a repair round to propose an applicability skip with no references', async () => {
  const { selectionFile, root } = await stageArea();
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({
      stage,
      round: 3,
      route: 'next',
      profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
    }),
  );
  const { git } = scriptedGit([repositoryState()]);
  const common = { selectionFile, stage, git, publish: () => undefined };
  const contexts: string[] = [];
  const correction = { ...conformingSkipResponse, skip: { references: [] } };
  await expect(
    createStageAuthor({ ...common, runner: authorRunner(correction, contexts) })({
      task: 'respond',
    }),
  ).resolves.toBe('skip-proposed');
  // The response invocation states that a repair may propose an evaluated applicability skip.
  expect(contexts.join('\n')).toContain('you may propose an applicability skip');
  await expect(
    createStageEvaluator({
      ...common,
      runner: evaluatorRunner(
        {
          verdict: 'accepted-skip',
          observation: null,
          upstream: null,
        },
        [],
      ),
    })(),
  ).resolves.toBe('accepted-skip');
  await expect(createStageResult(common)({ outcome: 'skipped' })).resolves.toBe('saved');
});

it('rejects a skip proposal that carries fields its outcome does not own', async () => {
  const { selectionFile, root } = await stageArea();
  const { git } = scriptedGit([repositoryState()]);
  const common = { selectionFile, stage, git, publish: () => undefined };
  const cases: readonly { readonly report: unknown; readonly problem: string }[] = [
    {
      report: {
        ...conformingSkipResponse,
        documents: [{ path: 'docs/requirements.md' }],
      },
      problem: 'only authored work may declare changed documents',
    },
    {
      report: {
        ...conformingSkipResponse,
        plan: [
          {
            summary: 'Implement the design',
            scope: 'Carry the design into implementation.',
            completionCriteria: ['The design is implemented.'],
            prerequisites: [],
          },
        ],
      },
      problem:
        'only an authored or skip-proposed Architecture report supplies an implementation plan',
    },
    {
      report: { ...conformingSkipResponse, question: 'Which requirement governs?' },
      problem: 'only a needs-input outcome carries the author question',
    },
    {
      report: {
        ...conformingSkipResponse,
        upstream: { stage: 'idea', correction: 'Restate the idea with one outcome.' },
      },
      problem: 'only a return-upstream outcome carries the upstream request',
    },
  ];
  for (const { report, problem } of cases) {
    const author = createStageAuthor({ ...common, runner: authorRunner(report, []) });
    await expect(author({ task: 'propose' })).rejects.toThrow(problem);
  }
  // No contradictory report was silently rewritten into a saved skip.
  await expect(readFile(path.join(root, 'artifacts', '3', 'author.json'), 'utf8')).rejects.toThrow(
    /ENOENT/,
  );
});

it.each(['author', 'evaluation'] as const)(
  'retains a malformed older %s report encountered while resolving stage deletions',
  async (kind) => {
    const { selectionFile, root, worktree } = await stageArea();
    const file = path.join(root, 'artifacts', '1', `${kind}.json`);
    const original = kind === 'author' ? await readFile(file, 'utf8') : null;
    const malformed = '{"olderReport":';
    await writeFile(file, malformed);
    const { git } = scriptedGit([repositoryState()], {
      commitPaths: async () => ok({ branch: 'task/KAN-76', headRevision: '1'.repeat(40) }),
      readFileAtRevision: async (_repository, _revision, relative) =>
        ok(await readFile(path.join(worktree, relative), 'utf8')),
    });
    const common = { selectionFile, stage, git, publish: () => undefined };
    const response = {
      ...conformingSkipResponse,
      outcome: 'authored',
      skip: null,
      documents: [{ path: 'docs/requirements.md' }],
    };
    const contexts: string[] = [];
    const author = createStageAuthor({ ...common, runner: authorRunner(response, contexts) });
    await expect(author({ task: 'propose' })).rejects.toThrow(/is not valid JSON/);
    // A malformed round-1 evaluation is the most recent preceding evaluation for this new round,
    // so it is preserved under the evaluator responsibility before the author is invoked. A valid
    // round-2 author stops the earlier author traversal, so that older record is read only by
    // deletion validation after invocation.
    expect(contexts).toHaveLength(kind === 'author' ? 1 : 0);
    const role = kind === 'author' ? 'author' : 'evaluator';
    const scope = stageReportScope({
      project: projectOfWorkspace(path.dirname(root)),
      workId: 'KAN-76',
      area: root,
      stage,
      role,
    });
    expect((await readReportFeedback(root))[0]?.record).toMatchObject({
      scope,
      source: { path: file },
      output: malformed,
      operation: `stage-${role}`,
      context: expect.stringContaining('round 1'),
      reason: expect.stringContaining('is not valid JSON'),
    });
    if (original === null) await rm(file);
    else await writeFile(file, original);
    await expect(outstandingReportFeedback({ areaRoot: root, scope })).resolves.toHaveLength(1);
    await expect(author({ task: 'propose' })).resolves.toBe('authored');
    if (kind === 'author') expect(contexts[1]).toContain(malformed);
    if (kind === 'evaluation') {
      await expect(outstandingReportFeedback({ areaRoot: root, scope })).resolves.toHaveLength(1);
      const evaluatorContexts: string[] = [];
      const evaluator = createStageEvaluator({
        ...common,
        runner: evaluatorRunner(
          {
            verdict: 'accepted',
            observation: null,
            upstream: null,
          },
          evaluatorContexts,
        ),
      });
      await expect(evaluator()).resolves.toBe('accepted');
      expect(evaluatorContexts[0]).toContain(malformed);
    }
    await expect(outstandingReportFeedback({ areaRoot: root, scope })).resolves.toEqual([]);
    expect(
      (await readReportFeedback(root)).filter((entry) => entry.record.kind === 'rejection'),
    ).toHaveLength(1);
  },
);

it('retains a malformed older prototype observation under its author', async () => {
  const { selectionFile, root } = await stageArea('prototype');
  const file = path.join(root, 'artifacts', '1', 'observation.json');
  const authorFile = path.join(root, 'artifacts', '1', 'author.json');
  const retained = JSON.parse(await readFile(authorFile, 'utf8')) as Record<string, unknown>;
  await writeFile(authorFile, JSON.stringify({ ...retained, observation: { path: file } }));
  const malformed = '{"observation":';
  await writeFile(file, malformed);
  const author = createStageAuthor({
    selectionFile,
    stage: 'prototype',
    git: scriptedGit([repositoryState()]).git,
    publish: () => undefined,
    runner: authorRunner(
      {
        ...conformingSkipResponse,
        outcome: 'authored',
        skip: null,
        sourcePaths: ['docs/requirements.md'],
      },
      [],
    ),
  });
  await expect(author({ task: 'propose' })).rejects.toThrow(/is not valid JSON/);
  expect((await readReportFeedback(root))[0]?.record).toMatchObject({
    scope: { area: root, role: 'prototype-author', reportKind: 'stage-author' },
    source: { path: file },
    output: malformed,
    context: expect.stringContaining('round 1'),
  });
});

it('retains an author report corrupted during evaluation under the author responsibility', async () => {
  const { selectionFile, root, worktree } = await stageArea();
  const { git } = scriptedGit([repositoryState()], {
    readFileAtRevision: async (_repository, _revision, file) =>
      ok(await readFile(path.join(worktree, file), 'utf8')),
  });
  const common = { selectionFile, stage, git, publish: () => undefined };
  await createStageAuthor({ ...common, runner: authorRunner(conformingSkipResponse, []) })({
    task: 'propose',
  });
  const file = path.join(root, 'artifacts', '3', 'author.json');
  const malformed = '{"interrupted":';
  const evaluator = createStageEvaluator({
    ...common,
    runner: {
      async run(request) {
        await writeAssignedReport(request.context, '# Requirements evaluation report\n');
        await writeFile(file, malformed);
        return ok({
          output: JSON.stringify({
            verdict: 'accepted-skip',
            observation: null,
            upstream: null,
          }),
        });
      },
    },
  });
  await expect(evaluator()).rejects.toThrow(/is not valid JSON/);
  expect((await readReportFeedback(root))[0]?.record).toMatchObject({
    scope: { area: root, role: 'requirements-author' },
    source: { path: file },
    output: malformed,
    operation: 'stage-author',
  });
  await expect(readStageArtifact(root, 3, stageEvaluationArtifact)).resolves.toBeNull();
});

it.each(['binding', 'markdown', 'legitimate'] as const)(
  'rechecks the author after a %s change during evaluation',
  async (change) => {
    const { selectionFile, root } = await stageArea();
    const common = {
      selectionFile,
      stage,
      git: scriptedGit([repositoryState()]).git,
      publish: () => undefined,
    };
    const authorContexts: string[] = [];
    const author = createStageAuthor({
      ...common,
      runner: authorRunner(conformingSkipResponse, authorContexts),
    });
    await author({ task: 'propose' });
    const file = path.join(root, 'artifacts', '3', 'author.json');
    const original = await readFile(file, 'utf8');
    const saved = JSON.parse(original) as StageAuthorOutput;
    const markdown = await readFile(saved.report.path, 'utf8');
    const changed =
      change === 'binding'
        ? JSON.stringify({ ...saved, reportIdentity: '0'.repeat(64) })
        : change === 'legitimate'
          ? JSON.stringify({ ...saved, skip: { references: [] } })
          : original;
    const response = { verdict: 'accepted-skip', observation: null, upstream: null };
    const evaluator = createStageEvaluator({
      ...common,
      runner: {
        async run(request) {
          await writeAssignedReport(request.context, '# Evaluation\n\nThe skip is adequate.\n');
          await writeFile(file, changed);
          if (change === 'markdown') await writeFile(saved.report.path, 'Replacement report.\n');
          return ok({ output: JSON.stringify(response) });
        },
      },
    });
    await expect(evaluator()).rejects.toThrow(
      change === 'legitimate' ? /reevaluation is required/ : /does not match/,
    );
    await expect(readStageArtifact(root, 3, stageEvaluationArtifact)).resolves.toBeNull();
    const feedback = await readReportFeedback(root);
    if (change === 'legitimate') {
      expect(feedback).toEqual([]);
    } else {
      expect(feedback).toHaveLength(1);
      const rejection = feedback[0]!.record;
      expect(rejection).toMatchObject({
        kind: 'rejection',
        scope: { area: root, workId: 'KAN-76', role: 'requirements-author' },
        invocationId: saved.invocationId,
        profile: saved.profile,
        source: { path: file },
        output: changed,
        assignedReport: saved.report,
        operation: 'stage-author',
        reason: expect.stringContaining('does not match'),
      });
      if (rejection.kind !== 'rejection' || rejection.report === null) {
        throw new Error('Expected retained author Markdown.');
      }
      const rejectedMarkdown = change === 'markdown' ? 'Replacement report.\n' : markdown;
      await expect(readFile(rejection.report.path, 'utf8')).resolves.toBe(rejectedMarkdown);
      // Repairing history and reevaluating cannot retire the responsible author's obligation.
      await writeFile(file, original);
      await writeFile(saved.report.path, markdown);
      await expect(
        createStageEvaluator({ ...common, runner: evaluatorRunner(response, []) })(),
      ).resolves.toBe('accepted-skip');
      await expect(
        outstandingReportFeedback({ areaRoot: root, scope: rejection.scope }),
      ).resolves.toHaveLength(1);
      await author({ task: 'propose' });
      expect(authorContexts[1]).toContain('does not match');
      expect(authorContexts[1]).toContain(feedback[0]!.path);
      expect(authorContexts[1]).toContain(rejection.report.path);
      await expect(
        outstandingReportFeedback({ areaRoot: root, scope: rejection.scope }),
      ).resolves.toEqual([]);
      await expect(readFile(rejection.report.path, 'utf8')).resolves.toBe(rejectedMarkdown);
    }
  },
);

it('attributes an unusable upstream context report to its stage author', async () => {
  const { selectionFile, root } = await stageArea();
  const selection = selectionDeclaration.schema.parse(
    JSON.parse(await readFile(selectionFile, 'utf8')),
  );
  const file = path.join(root, 'artifacts', '3', 'author.json');
  const malformed = '{"upstream":';
  await writeFile(file, malformed);
  await writeFile(
    path.join(root, 'artifacts', '3', 'result.json'),
    JSON.stringify({
      stage,
      outcome: 'skipped',
      authoredRevision: 3,
      documents: [],
      outputs: [{ path: file }],
      evaluation: { path: path.join(root, 'artifacts', '3', 'evaluation.json') },
      reason: 'The existing requirements satisfy the stage.',
      returnStage: null,
      returnFinding: null,
    }),
  );
  await expect(upstreamReferences(selection, 'ux')).rejects.toThrow(/is not valid JSON/);
  expect((await readReportFeedback(root))[0]?.record).toMatchObject({
    scope: {
      area: root,
      workId: 'KAN-76',
      role: 'requirements-author',
      reportKind: 'stage-author',
    },
    source: { path: file },
    output: malformed,
    profile: 'nexus-sol',
    operation: 'stage-author',
    context: expect.stringContaining('requirements author round 3 for ux context'),
  });
  await expect(readReportFeedback(path.join(path.dirname(root), 'ux'))).resolves.toEqual([]);
});

it('surfaces an unusable preceding evaluation to a new round without reusing or overwriting it', async () => {
  const { selectionFile, root } = await stageArea();
  const common = {
    selectionFile,
    stage,
    git: scriptedGit([repositoryState()]).git,
    publish: () => undefined,
  };
  await createStageAuthor({ ...common, runner: authorRunner(conformingSkipResponse, []) })({
    task: 'propose',
  });
  const file = path.join(root, 'artifacts', '2', 'evaluation.json');
  const malformed = '{"reused":';
  await writeFile(file, malformed);
  await writeFile(
    path.join(root, 'artifacts', '2', 'result.json'),
    JSON.stringify({
      stage,
      outcome: 'skipped',
      authoredRevision: 2,
      documents: [{ path: 'docs/requirements.md', revision: '1'.repeat(40) }],
      existingDocuments: [{ path: 'docs/testing.md', revision: '1'.repeat(40) }],
      outputs: [],
      evaluation: { path: file },
      reason: 'The existing requirements satisfy the stage.',
      returnStage: null,
      returnFinding: null,
    }),
  );
  // A new route label does not clear retained concerns: the most recent preceding evaluation is
  // read through its producer-owned reader, and its unusable bytes become attributable rejection
  // evidence instead of silently disappearing from the fresh round.
  const rejectedContexts: string[] = [];
  const rejected = createStageEvaluator({
    ...common,
    runner: evaluatorRunner(
      { verdict: 'accepted-skip', observation: null, upstream: null },
      rejectedContexts,
    ),
  });
  await expect(rejected()).rejects.toThrow(/is not valid JSON/);
  expect(rejectedContexts).toEqual([]);
  expect(await readFile(file, 'utf8')).toBe(malformed);
  const rejection = (await readReportFeedback(root))[0]!;
  expect(rejection.record).toMatchObject({
    kind: 'rejection',
    scope: { area: root, workId: 'KAN-76', role: 'requirements-evaluator' },
    source: { path: file },
    output: malformed,
    operation: 'stage-evaluator',
  });

  // Once the responsible producer's record is readable, the new round assesses the current
  // worktree directly: the historical completed result is not reused as an acceptance basis.
  await rm(file);
  const evaluatorContexts: string[] = [];
  const evaluator = createStageEvaluator({
    ...common,
    runner: evaluatorRunner(
      {
        verdict: 'accepted-skip',
        observation: null,
        upstream: null,
      },
      evaluatorContexts,
    ),
  });
  await expect(evaluator()).resolves.toBe('accepted-skip');
  const saved = JSON.parse(
    await readFile(path.join(root, 'artifacts', '3', 'evaluation.json'), 'utf8'),
  ) as { readonly basis: { readonly content: unknown } };
  expect(saved.basis.content).toEqual([]);
  // The accepted replacement retires the rejection while its evidence remains readable history.
  const retained = await readReportFeedback(root);
  expect(retained.map((entry) => entry.record.kind).sort()).toEqual(['correction', 'rejection']);
});

it.each([
  { stage: 'requirements' as const, plan: [] },
  { stage: 'ux' as const, plan: [] },
  {
    stage: 'architecture' as const,
    plan: [
      {
        summary: 'Add the lint gate',
        scope: 'Configure the lint gate and its check.',
        completionCriteria: ['The check runs in CI.'],
        prerequisites: [],
      },
    ],
  },
])(
  'evaluates an authored submission declaring no changed files ($stage)',
  async ({ stage, plan }) => {
    const { selectionFile, root } = await stageArea(stage);
    const common = {
      selectionFile,
      stage,
      git: scriptedGit([repositoryState()]).git,
      publish: () => undefined,
    };
    const authorContexts: string[] = [];
    const authored = {
      outcome: 'authored',
      documents: [],
      sourcePaths: [],
      observation: null,
      plan,
      skip: null,
      question: null,
      upstream: null,
    };
    await expect(
      createStageAuthor({
        ...common,
        runner: authorRunner(authored, authorContexts),
      })({ task: 'propose' }),
    ).resolves.toBe('authored');
    expect(authorContexts[0]).toContain('Unchanged adequate documents may leave both empty');

    // The evaluator still assesses the current worktree against the captured input: an empty
    // changed-document list restricts nothing, and the observed revision is stated explicitly.
    const evaluatorContexts: string[] = [];
    await expect(
      createStageEvaluator({
        ...common,
        runner: evaluatorRunner(
          {
            verdict: 'accepted',
            observation: null,
            upstream: null,
          },
          evaluatorContexts,
        ),
      })(),
    ).resolves.toBe('accepted');
    expect(evaluatorContexts[0]).toContain(
      `The repository revision this evaluation observes: ${repositoryState().headRevision}`,
    );
    expect(evaluatorContexts[0]).toContain('does not restrict your scope');

    const savedEvaluation = (await readStageArtifact(root, 3, stageEvaluationArtifact))!;
    expect(savedEvaluation.basis.repositoryRevision).toBe(repositoryState().headRevision);
    expect(savedEvaluation.basis.content).toEqual([]);
    await expect(createStageResult(common)({ outcome: 'accepted' })).resolves.toBe('saved');
    const result = (await readStageArtifact(root, 3, stageResultArtifact))!;
    expect(result).toMatchObject({
      outcome: 'accepted',
      documents: [],
      sourcePaths: [],
      skipReferences: [],
    });
    if (stage === 'architecture') {
      expect(await readStageArtifact(root, 3, stagePlanArtifact)).toEqual(plan);
    }
    await expect(
      readCurrentDecision({
        issueRoot: path.dirname(root),
        stage,
        selection: selectionDeclaration.schema.parse(
          JSON.parse(await readFile(selectionFile, 'utf8')),
        ),
        git: common.git,
      }),
    ).resolves.toMatchObject({ kind: 'current' });
  },
);

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

it('rejects the captured prototype prose citations while repaired references stay readable evidence', async () => {
  const { selectionFile, root, worktree } = await prototypeStageArea();
  const revision = '1'.repeat(40);
  const { git } = scriptedGit([repositoryState({ headRevision: revision })], {
    readFileAtRevision: async (_repository, _revision, file) =>
      ok(await readFile(path.join(worktree, file), 'utf8')),
  });
  const common = { selectionFile, stage: 'prototype', git, publish: () => undefined } as const;

  // The captured report asked the platform to resolve prose as a filesystem path. It is rejected
  // at the producer boundary with the violated rule instead of failing the evaluator's read.
  const rejected = createStageAuthor({
    ...common,
    runner: authorRunner(capturedPrototypeSkip, []),
  });
  await expect(rejected({ task: 'propose' })).rejects.toThrow(
    'The prototype author report is unusable: the skip reference is unusable: ' +
      'the reference "docs/agent-runtime/report-requirements.md at revision ' +
      '9ec1f78519d6d7f6fa97a5ee70bfa63f1ee3332a \u2014 scope: no reporting-terminal ' +
      'interaction." does not name a readable file',
  );
  await expect(readFile(path.join(root, 'artifacts', '1', 'author.json'), 'utf8')).rejects.toThrow(
    /ENOENT/,
  );

  // The captured report as it was retained for evaluation is rejected by the same rule before the
  // evaluator is invoked, instead of failing to resolve the prose as a filesystem path.
  await writeFile(
    path.join(root, 'artifacts', '1', 'author.json'),
    JSON.stringify({
      ...capturedPrototypeSkip,
      summary: 'Storybook Refinement is not applicable to HARN-96.',
      skip: {
        reason: 'The captured HARN-96 input is an internal change without a product preview.',
        references: capturedPrototypeSkip.skip.references,
      },
      stage: 'prototype',
      revision: 1,
    }),
  );
  const binding = createStageEvaluator({
    ...common,
    runner: evaluatorRunner({}, []),
  });
  await expect(binding()).rejects.toThrow(
    'The prototype skip carries unusable evidence: the reference ' +
      '"docs/agent-runtime/report-requirements.md at revision ' +
      '9ec1f78519d6d7f6fa97a5ee70bfa63f1ee3332a \u2014 scope: no reporting-terminal ' +
      'interaction." does not name a readable file',
  );
  await rm(path.join(root, 'artifacts', '1', 'author.json'));

  // The retained repaired report cites readable documents and reaches evaluation; the references
  // remain evidence and create no document binding.
  const author = createStageAuthor({
    ...common,
    runner: authorRunner(repairedPrototypeSkip, []),
  });
  await expect(author({ task: 'propose' })).resolves.toBe('skip-proposed');
  const evaluator = createStageEvaluator({
    ...common,
    runner: evaluatorRunner(
      {
        verdict: 'accepted-skip',
        observation: null,
        upstream: null,
      },
      [],
    ),
  });
  await expect(evaluator()).resolves.toBe('accepted-skip');
  const evaluation = JSON.parse(
    await readFile(path.join(root, 'artifacts', '1', 'evaluation.json'), 'utf8'),
  ) as {
    readonly basis: { readonly content: readonly unknown[]; readonly repositoryRevision: string };
  };
  expect(evaluation.basis.content).toEqual([]);
  expect(evaluation.basis.repositoryRevision).toBe(revision);
});

it('reads a section citation as evidence and keeps the completed verdict after the document changes', async () => {
  const { selectionFile, root, worktree } = await stageArea();
  const { git } = scriptedGit([repositoryState()]);
  const common = { selectionFile, stage, git, publish: () => undefined } as const;
  const author = createStageAuthor({
    ...common,
    runner: authorRunner(
      {
        ...conformingSkipResponse,
        skip: {
          references: ['docs/requirements.md#activities-and-rules'],
        },
      },
      [],
    ),
  });
  await expect(author({ task: 'propose' })).resolves.toBe('skip-proposed');
  const evaluator = createStageEvaluator({
    ...common,
    runner: evaluatorRunner(
      {
        verdict: 'accepted-skip',
        observation: null,
        upstream: null,
      },
      [],
    ),
  });
  await expect(evaluator()).resolves.toBe('accepted-skip');
  const evaluation = JSON.parse(
    await readFile(path.join(root, 'artifacts', '3', 'evaluation.json'), 'utf8'),
  ) as {
    readonly basis: { readonly content: readonly unknown[]; readonly repositoryRevision: string };
  };
  expect(evaluation.basis.content).toEqual([]);
  expect(evaluation.basis.repositoryRevision).toBe('1'.repeat(40));
  await createStageResult(common)({ outcome: 'skipped' });

  // A later change to the cited document is not a per-document binding: the completed skip stays
  // current and its decision does not depend on subsequent citation changes.
  await writeFile(path.join(worktree, 'docs', 'requirements.md'), '# Requirements\n\nChanged.\n');
  const selection = selectionDeclaration.schema.parse(
    JSON.parse(await readFile(selectionFile, 'utf8')),
  );
  await expect(
    readCurrentDecision({ issueRoot: path.dirname(root), stage, selection, git }),
  ).resolves.toMatchObject({ kind: 'current' });
});

it.each(['requirements', 'ux', 'prototype', 'architecture'] as const)(
  '%s rejects authored acceptance of a skip and keeps skip evidence without bindings',
  async (stage) => {
    const { selectionFile, root, worktree } = await stageArea(stage);
    const { git } = scriptedGit([repositoryState()], {
      readFileAtRevision: async (_repository, _revision, file) =>
        ok(await readFile(path.join(worktree, file), 'utf8')),
    });
    const common = { selectionFile, stage, git, publish: () => undefined };
    await createStageAuthor({
      ...common,
      runner: authorRunner(
        {
          ...conformingSkipResponse,
          plan:
            stage === 'architecture'
              ? [
                  {
                    summary: 'Implement the design',
                    scope: 'Carry the evaluated design into implementation.',
                    completionCriteria: ['The design is implemented.'],
                    prerequisites: [],
                  },
                ]
              : [],
        },
        [],
      ),
    })({ task: 'propose' });
    const report = {
      verdict: 'accepted',
      observation: null,
      upstream: null,
    };
    await expect(
      createStageEvaluator({ ...common, runner: evaluatorRunner(report, []) })(),
    ).rejects.toThrow('accepting a skip proposal requires an accepted-skip verdict');
    const evaluationFile = path.join(root, 'artifacts', '3', 'evaluation.json');
    await expect(readFile(evaluationFile, 'utf8')).rejects.toThrow(/ENOENT/);

    await expect(
      createStageEvaluator({
        ...common,
        runner: evaluatorRunner({ ...report, verdict: 'accepted-skip' }, []),
      })(),
    ).resolves.toBe('accepted-skip');
    const finalize = createStageResult(common);
    // A contradictory retained evaluator record must also fail before result persistence.
    const evaluation = JSON.parse(await readFile(evaluationFile, 'utf8'));
    await writeFile(evaluationFile, JSON.stringify({ ...evaluation, verdict: 'accepted' }));
    await expect(finalize({ outcome: 'accepted' })).rejects.toThrow(
      'accepting a skip proposal requires an accepted-skip verdict',
    );
    const resultFile = path.join(root, 'state', 'result.json');
    await expect(readFile(resultFile, 'utf8')).rejects.toThrow(/ENOENT/);
    await writeFile(evaluationFile, JSON.stringify(evaluation));
    await expect(finalize({ outcome: 'skipped' })).resolves.toBe('saved');
    const savedResult = await readFile(resultFile, 'utf8');
    expect(JSON.parse(savedResult)).toMatchObject({
      outcome: 'skipped',
      skipReferences: conformingSkipResponse.skip.references,
      documents: [],
      sourcePaths: [],
    });

    // Historical contradictory evaluations cannot bypass the rule at finalization or reuse.
    await writeFile(evaluationFile, JSON.stringify({ ...evaluation, verdict: 'accepted' }));
    const historicalResult = {
      ...JSON.parse(savedResult),
      outcome: 'accepted',
      existingDocuments: [],
      skipReferences: [],
    };
    await writeFile(resultFile, JSON.stringify(historicalResult));
    await writeFile(
      path.join(root, 'artifacts', '3', 'result.json'),
      JSON.stringify(historicalResult),
    );
    await expect(finalize({ outcome: 'accepted' })).rejects.toThrow(
      'accepting a skip proposal requires an accepted-skip verdict',
    );
    expect(await readFile(resultFile, 'utf8')).toBe(JSON.stringify(historicalResult));
    const selection = selectionDeclaration.schema.parse(
      JSON.parse(await readFile(selectionFile, 'utf8')),
    );
    await expect(
      readCurrentDecision({ issueRoot: path.dirname(root), stage, selection, git }),
    ).resolves.toMatchObject({
      kind: 'stale',
      reason: expect.stringContaining(
        'accepting a skip proposal requires an accepted-skip verdict',
      ),
    });
  },
);

it.each(['changed', 'deleted', 'replaced by a directory'])(
  'keeps the completed skip decision when a cited document is %s',
  async (mutation) => {
    const { selectionFile, root, worktree } = await stageArea();
    const { git } = scriptedGit([repositoryState()]);
    const common = { selectionFile, stage, git, publish: () => undefined };
    await createStageAuthor({
      ...common,
      runner: authorRunner(
        {
          ...conformingSkipResponse,
          skip: {
            references: ['docs/requirements.md#activities-and-rules'],
          },
        },
        [],
      ),
    })({ task: 'propose' });
    await createStageEvaluator({
      ...common,
      runner: evaluatorRunner(
        {
          verdict: 'accepted-skip',
          observation: null,
          upstream: null,
        },
        [],
      ),
    })();
    await createStageResult(common)({ outcome: 'skipped' });
    const issueRoot = path.dirname(root);
    const selection = selectionDeclaration.schema.parse(
      JSON.parse(await readFile(selectionFile, 'utf8')),
    );
    const decision = () => readCurrentDecision({ issueRoot, stage, selection, git });
    await expect(decision()).resolves.toMatchObject({ kind: 'current' });

    const citedFile = path.join(worktree, 'docs/requirements.md');
    if (mutation === 'changed') {
      await writeFile(citedFile, '# Requirements\n\nChanged.\n');
    } else {
      await rm(citedFile);
      if (mutation === 'replaced by a directory') await mkdir(citedFile);
    }
    // The completed verdict depends on the report association and captured input, not on the
    // later state of a cited document; the recorded result and evidence stay readable.
    await expect(decision()).resolves.toMatchObject({ kind: 'current' });
    await expect(createStageResult(common)({ outcome: 'skipped' })).resolves.toBe('saved');

    // A legacy completed evaluation without a repository observation or per-document binding
    // continues to be readable and replayable.
    const evaluation = (await readStageArtifact(root, 3, stageEvaluationArtifact))!;
    const evaluationFile = path.join(root, 'artifacts', '3', 'evaluation.json');
    await writeFile(
      evaluationFile,
      JSON.stringify({
        ...evaluation,
        basis: { ...evaluation.basis, repositoryRevision: undefined, content: [] },
      }),
    );
    const resultFile = path.join(root, 'artifacts', '3', 'result.json');
    const historicalResult = {
      ...JSON.parse(await readFile(resultFile, 'utf8')),
      existingDocuments: [],
    };
    await writeFile(resultFile, JSON.stringify(historicalResult));
    await writeFile(path.join(root, 'state', 'result.json'), JSON.stringify(historicalResult));
    await expect(decision()).resolves.toMatchObject({ kind: 'current' });
    await expect(createStageResult(common)({ outcome: 'skipped' })).resolves.toBe('saved');
  },
);

/** The rich captured issue the readable-rendering check inspects: structure, administration and
 * an unsupported meaningful node. */
const readableIssue = {
  id: '11045',
  key: 'HARN-115',
  self: 'https://api.test/issue/11045',
  fields: {
    summary: 'Refine the journey',
    description: {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope' }] },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Support newcomers with clear defaults.',
              marks: [{ type: 'strong' }],
            },
            { type: 'hardBreak' },
            { type: 'text', text: 'Keep the existing keyboard shortcuts.' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Excluded: enterprise SSO.' }],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Acceptance: a newcomer completes onboarding unaided.' },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'bash' },
          content: [{ type: 'text', text: 'nexus run' }],
        },
        { type: 'mediaSingle', content: [] },
        { type: 'futureBlock' },
      ],
    },
    labels: ['harness-task', 'nexus-source-HARN-115-1'],
    customfield_10015: 'A meaningful custom field.',
    statuscategorychangedate: '2026-10-06T18:48:21.527+0200',
    timespent: null,
    workratio: -1,
    avatarUrls: { '48x48': 'https://example.test/avatar.png' },
    attachment: [{ id: 'a1', filename: 'journey.png', mimeType: 'image/png' }],
  },
};

/** The captured conversation: human direction, a conflicting human statement and a Nexus
 * publication acknowledgement retained by the parent handoff. */
const readableConversation = [
  {
    id: 'c1',
    author: { displayName: 'Aleksei Rysaev', accountId: 'acct-human', accountType: 'atlassian' },
    created: '2026-10-06T18:00:00.000+0200',
    body: {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Do not add site search.' }] },
      ],
    },
  },
  {
    id: 'c2',
    author: { displayName: 'Aleksei Rysaev', accountId: 'acct-human', accountType: 'atlassian' },
    created: '2026-10-06T18:05:00.000+0200',
    body: {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Site search is required.' }] },
      ],
    },
  },
  {
    id: 'c3',
    author: { displayName: 'Harness', accountId: 'acct-bot', accountType: 'app' },
    created: '2026-10-06T18:10:00.000+0200',
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Prepared the task.' }] }],
    },
  },
];

/** One requirements stage area whose captured source carries readable structure and conflict. */
async function readableStageArea(): Promise<{
  readonly selectionFile: string;
  readonly root: string;
  readonly issueRoot: string;
  readonly worktree: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-readable-source-'));
  temporaryDirectories.push(directory);
  const issueRoot = path.join(directory, 'HARN-115');
  const root = path.join(issueRoot, stage);
  const worktree = path.join(issueRoot, 'worktree');
  await mkdir(path.join(worktree, 'docs'), { recursive: true });
  await writeFile(path.join(worktree, 'docs', 'requirements.md'), '# Requirements\n');
  await writeFile(path.join(worktree, 'docs', 'testing.md'), '# Testing\n');
  await writeFile(
    path.join(worktree, 'AGENTS.md'),
    '# Repository instructions\n\nSENTINEL-AGENTS-BODY\n',
  );
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'HARN-115',
      source: { kind: 'jira', issueId: '11045' },
      task: readableIssue,
      conversation: readableConversation,
      workspace: { root: issueRoot },
      stage,
    }),
  );
  await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
  await writeFile(
    path.join(issueRoot, 'parent', 'handoff.json'),
    JSON.stringify({
      stage,
      upstreamReturns: 0,
      feedback: null,
      return: null,
      awaitingStages: [],
      tickets: [],
      publications: [{ kind: 'comment', id: 'c3' }],
    }),
  );
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({
      stage,
      round: 1,
      route: 'new',
      profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
    }),
  );
  return { selectionFile, root, issueRoot, worktree };
}

it('renders captured source readably, retains its exact evidence and embeds no AGENTS.md body', async () => {
  const { selectionFile, root, worktree } = await readableStageArea();
  const contexts: string[] = [];
  const author = createStageAuthor({
    selectionFile,
    stage,
    git: scriptedGit([repositoryState()]).git,
    publish: () => undefined,
    runner: authorRunner(conformingSkipResponse, contexts),
  });
  await expect(author({ task: 'propose' })).resolves.toBe('skip-proposed');
  const context = contexts[0]!;

  // Expressed scope, exclusions, acceptance conditions and structure survive as readable text.
  expect(context).toContain('Summary: Refine the journey');
  expect(context).toContain('## Scope');
  expect(context).toContain('**Support newcomers with clear defaults.**');
  expect(context).toContain('- Excluded: enterprise SSO.');
  expect(context).toContain('- Acceptance: a newcomer completes onboarding unaided.');
  expect(context).toContain('```bash');
  expect(context).toContain('nexus run');
  expect(context).toContain('- customfield_10015: A meaningful custom field.');

  // Attribution, chronology, the Nexus publication mark and the still-unresolved human conflict.
  expect(context).toContain(
    'Comment c1 — Aleksei Rysaev <acct-human> [atlassian account] at 2026-10-06T18:00:00.000+0200',
  );
  expect(context).toContain('Comment c3 — Harness <acct-bot> [app account]');
  expect(context).toContain(
    '[Nexus publication acknowledgement "comment" — a Nexus-authored message, not human ' +
      'direction or an agent assessment.]',
  );
  expect(context.indexOf('Do not add site search.')).toBeLessThan(
    context.indexOf('Site search is required.'),
  );

  // Administrative provider data stays out of the prompt and is only listed as omitted.
  expect(context).not.toContain('"avatarUrls"');
  expect(context).not.toContain('"workratio"');
  expect(context).not.toContain('"statuscategorychangedate"');
  expect(context).not.toContain('"self":');
  expect(context).toContain('Administrative issue fields omitted from this rendering:');
  // Attachments are captured evidence: they receive an explicit inspection reference to the
  // retained source instead of being dropped as administration.
  expect(context).toContain('- attachment:');
  expect(context).toContain('the captured attachments (files or other non-text evidence)');

  // Unsupported meaningful content is identified with its source location, never silently dropped.
  const reportPath = /Assigned Markdown report: (.+)/.exec(context)![1]!;
  const capturedSource = capturedSourcePathOf(reportPath);
  expect(context).toContain('This rendering does not display a Jira "futureBlock" node');
  expect(context).toContain('embedded media (an image or attachment)');
  expect(context).toContain(`inspect the captured source at "${capturedSource}"`);

  // The exact captured values are retained beside the invocation's report.
  expect(context).toContain(`The exact captured source is retained at ${capturedSource}`);
  expect(JSON.parse(await readFile(capturedSource, 'utf8'))).toEqual({
    issue: readableIssue,
    conversation: readableConversation,
  });

  // Repository guidance is referenced by path, never embedded, and the repository file is intact.
  expect(context).toContain(
    `read the connected project's root instruction file at "${path.join(worktree, 'AGENTS.md')}"`,
  );
  expect(context).not.toContain('SENTINEL-AGENTS-BODY');
  expect(await readFile(path.join(worktree, 'AGENTS.md'), 'utf8')).toContain(
    'SENTINEL-AGENTS-BODY',
  );

  // Reselection for the next invocation leaves the earlier retained evidence accessible and intact.
  const refreshedIssue = {
    ...readableIssue,
    fields: { ...readableIssue.fields, summary: 'Refreshed scope' },
  };
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'HARN-115',
      source: { kind: 'jira', issueId: '11045' },
      task: refreshedIssue,
      conversation: [],
      workspace: { root: path.dirname(root) },
      stage,
    }),
  );
  await expect(author({ task: 'propose' })).resolves.toBe('skip-proposed');
  const refreshed = contexts[1]!;
  expect(refreshed).toContain('Summary: Refreshed scope');
  const refreshedSource = capturedSourcePathOf(
    /Assigned Markdown report: (.+)/.exec(refreshed)![1]!,
  );
  expect(refreshedSource).not.toBe(capturedSource);
  expect(JSON.parse(await readFile(refreshedSource, 'utf8'))).toEqual({
    issue: refreshedIssue,
    conversation: [],
  });
  expect(JSON.parse(await readFile(capturedSource, 'utf8'))).toEqual({
    issue: readableIssue,
    conversation: readableConversation,
  });
});

it('references current work and supporting history instead of embedding their report bodies', async () => {
  const { selectionFile, root } = await stageArea();
  const common = {
    selectionFile,
    stage,
    git: scriptedGit([repositoryState()]).git,
    publish: () => undefined,
  };

  // Round 3 authors a skip and an accepted evaluation binds it, establishing readable history.
  await expect(
    createStageAuthor({ ...common, runner: authorRunner(conformingSkipResponse, []) })({
      task: 'propose',
    }),
  ).resolves.toBe('skip-proposed');
  const evaluatorContexts: string[] = [];
  await expect(
    createStageEvaluator({
      ...common,
      runner: evaluatorRunner(
        { verdict: 'accepted-skip', observation: null, upstream: null },
        evaluatorContexts,
      ),
    })(),
  ).resolves.toBe('accepted-skip');
  const authorRecord = path.join(root, 'artifacts', '3', 'author.json');
  const savedAuthor = JSON.parse(await readFile(authorRecord, 'utf8')) as {
    readonly report: { readonly path: string };
  };
  const savedEvaluation = JSON.parse(
    await readFile(path.join(root, 'artifacts', '3', 'evaluation.json'), 'utf8'),
  ) as { readonly report: { readonly path: string } };

  // The evaluator attributes the current author through its record and report, not its body.
  expect(evaluatorContexts[0]).toContain(authorRecord);
  expect(evaluatorContexts[0]).toContain(savedAuthor.report.path);
  expect(evaluatorContexts[0]).not.toContain('Requirements author report');

  // A completed stage exposes its result, authored revision, report and history as attributed
  // upstream references for later stages, never as embedded bodies.
  await expect(createStageResult(common)({ outcome: 'skipped' })).resolves.toBe('saved');
  const upstream = await upstreamReferences(
    selectionDeclaration.schema.parse(JSON.parse(await readFile(selectionFile, 'utf8'))),
    'ux',
  );
  expect(upstream).toHaveLength(1);
  expect(upstream[0]!.stage).toBe('requirements');
  const upstreamLines = upstream[0]!.lines.join('\n');
  expect(upstreamLines).toContain('requirements stage result (skipped):');
  expect(upstreamLines).toContain(
    `requirements retained authored revision 3: ${authorRecord}; report: ${savedAuthor.report.path}`,
  );
  expect(upstreamLines).toContain(`requirements stage history: ${root}`);

  // The response round reads the accepted evaluation as supporting history and the current
  // authored revision through attributed references only.
  await mkdir(path.join(root, 'artifacts', '4'), { recursive: true });
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({
      stage,
      round: 4,
      route: 'next',
      profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
    }),
  );
  const responseContexts: string[] = [];
  await expect(
    createStageAuthor({
      ...common,
      runner: authorRunner(conformingSkipResponse, responseContexts),
    })({
      task: 'respond',
    }),
  ).resolves.toBe('skip-proposed');
  const responseContext = responseContexts[0]!;
  expect(responseContext).toContain('The previous evaluation of this work is accepted-skip');
  expect(responseContext).toContain(savedEvaluation.report.path);
  expect(responseContext).toContain(
    'Read it as supporting history; it left no pending correction.',
  );
  expect(responseContext).toContain('The current authored revision is 3');
  expect(responseContext).toContain(authorRecord);
  expect(responseContext).toContain(savedAuthor.report.path);
  expect(responseContext).not.toContain('Requirements author report');
  expect(responseContext).not.toContain('Requirements evaluation report');
  expect(responseContext).toContain(
    `Stage history: retained rounds, reports and further evidence under ${root}`,
  );
});

it('supplies a retained human question and captured answer directly to an author-only continuation', async () => {
  const { selectionFile, root } = await stageArea();
  const issueRoot = path.dirname(root);
  await mkdir(path.join(issueRoot, 'parent'), { recursive: true });
  await writeFile(
    path.join(issueRoot, 'parent', 'handoff.json'),
    JSON.stringify({
      stage,
      upstreamReturns: 0,
      feedback: {
        stage,
        question: 'Which requirement governs the excluded SSO scope?',
      },
      return: null,
      awaitingStages: [],
      tickets: [],
      publications: [],
    }),
  );
  const contexts: string[] = [];
  const author = createStageAuthor({
    selectionFile,
    stage,
    git: scriptedGit([repositoryState()]).git,
    publish: () => undefined,
    runner: authorRunner(conformingSkipResponse, contexts),
  });
  await expect(author({ task: 'propose' })).resolves.toBe('skip-proposed');
  const context = contexts[0]!;
  expect(context).toContain(
    'Retained human question for this stage: Which requirement governs the excluded SSO scope?',
  );
  expect(context).toContain(
    'treat the captured clarification as governing intent when it resolves the question',
  );
  expect(context).toContain(
    'Active corrections (address these directly; history does not replace them):',
  );
  expect(context).not.toContain('Eligible prior finding IDs');
});

it('keeps a bound changes-requested evaluation directly available as active corrections', async () => {
  const { selectionFile, root } = await stageArea();
  const common = {
    selectionFile,
    stage,
    git: scriptedGit([repositoryState()]).git,
    publish: () => undefined,
  };
  await expect(
    createStageAuthor({ ...common, runner: authorRunner(conformingSkipResponse, []) })({
      task: 'propose',
    }),
  ).resolves.toBe('skip-proposed');

  // The evaluator's complete narrative carries the problem, the required correction and an
  // explicitly nonblocking suggestion.
  const activeMarkdown =
    '# Requirements evaluation report\n\n' +
    'Problem: the exclusion contradicts the captured scope.\n' +
    'Required correction: restore enterprise SSO to the scope.\n' +
    'Optional suggestion (nonblocking): clarify the onboarding example.\n';
  let evaluationReport = '';
  const evaluator = createStageEvaluator({
    ...common,
    runner: {
      async run(request) {
        evaluationReport = /Assigned Markdown report: (.+)/.exec(request.context)![1]!;
        await writeAssignedReport(request.context, activeMarkdown);
        return ok({
          output: JSON.stringify({
            verdict: 'changes-requested',
            observation: null,
            upstream: null,
          }),
        });
      },
    },
  });
  await expect(evaluator()).resolves.toBe('changes-requested');

  // The response round receives the original complete assessment as active concerns, without a
  // machine finding set or an inferred resolution.
  await mkdir(path.join(root, 'artifacts', '4'), { recursive: true });
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({
      stage,
      round: 4,
      route: 'next',
      profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
    }),
  );
  const responseContexts: string[] = [];
  await expect(
    createStageAuthor({
      ...common,
      runner: authorRunner(conformingSkipResponse, responseContexts),
    })({
      task: 'respond',
    }),
  ).resolves.toBe('skip-proposed');
  const responseContext = responseContexts[0]!;
  expect(responseContext).toContain('The previous evaluation of this work is changes-requested');
  expect(responseContext).toContain(`its assigned Markdown report: ${evaluationReport}`);
  expect(responseContext).toContain(
    'The complete validated evaluation Markdown (active concerns: problem, consequence, ' +
      'required correction, optional suggestions and uncertainty):',
  );
  expect(responseContext).toContain('Problem: the exclusion contradicts the captured scope.');
  expect(responseContext).toContain('Required correction: restore enterprise SSO to the scope.');
  expect(responseContext).toContain(
    'Optional suggestion (nonblocking): clarify the onboarding example.',
  );
  expect(responseContext).not.toContain('Eligible prior finding IDs');

  // The current evaluation of that response also keeps the unresolved concerns directly available.
  const evaluatorContexts: string[] = [];
  await expect(
    createStageEvaluator({
      ...common,
      runner: evaluatorRunner(
        { verdict: 'accepted-skip', observation: null, upstream: null },
        evaluatorContexts,
      ),
    })(),
  ).resolves.toBe('accepted-skip');
  expect(evaluatorContexts[0]).toContain(
    'Required correction: restore enterprise SSO to the scope.',
  );
});
