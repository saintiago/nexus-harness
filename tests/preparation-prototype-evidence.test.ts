/**
 * Focused integration tests: the Storybook Refinement stage's producer-owned observation contract
 * over real temporary Git repositories. Substituted agent responses stand in for the
 * browser-capable profile invocations: they establish that applicable prototype work needs
 * readable, current author and evaluator evidence, that changed content needs fresh observation
 * and that an evaluated applicability skip needs no preview. The separate host integration check
 * exercises the real prototype profiles, Playwright MCP and an isolated Storybook fixture.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitAdapter } from '../src/adapters/git.js';
import { run, type ProcessOutput } from '../src/adapters/processes.js';
import { ok } from '../src/result.js';
import type { AgentRoleRunner } from '../src/task-engine/index.js';
import {
  stageAuthorArtifact,
  stageEvaluationArtifact,
  stageResultArtifact,
} from '../src/task-engine/actions/preparation/artifacts.js';
import { createPrepareStage } from '../src/task-engine/actions/preparation/prepare-stage/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import {
  readStageArtifact,
  roundArtifactDirectory,
} from '../src/task-engine/actions/preparation/storage.js';
import { savePrototypeObservation } from './support/prototype-observation.js';

const environment = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Nexus Tests',
  GIT_AUTHOR_EMAIL: 'nexus@example.com',
  GIT_COMMITTER_NAME: 'Nexus Tests',
  GIT_COMMITTER_EMAIL: 'nexus@example.com',
};

const git = createGitAdapter((args, directory, onOutput) =>
  run({ executable: 'git', args, directory, environment }, onOutput),
);

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-prototype-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Decode one stream's chunks as text. */
function text(outputs: readonly ProcessOutput[], stream: ProcessOutput['stream']): string {
  const chunks = outputs.filter((output) => output.stream === stream).map((output) => output.chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Run one git command as test setup and return its stdout. */
async function gitCommand(args: readonly string[], directory: string): Promise<string> {
  const outputs: ProcessOutput[] = [];
  const result = await run({ executable: 'git', args, directory, environment }, (output) => {
    outputs.push(output);
  });
  if (!result.ok || result.value.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${text(outputs, 'stderr')}`);
  }
  return text(outputs, 'stdout');
}

/** The commit a repository's HEAD points to. */
async function headOf(repository: string): Promise<string> {
  return (await gitCommand(['rev-parse', 'HEAD'], repository)).trim();
}

/** A bare origin with one initial commit on main. */
async function repositoryWithOrigin(): Promise<{ readonly origin: string }> {
  const root = await temporaryDirectory();
  const origin = path.join(root, 'origin.git');
  const source = path.join(root, 'source');
  await gitCommand(['init', '--quiet', '--bare', '--initial-branch=main', origin], root);
  await gitCommand(['init', '--quiet', '--initial-branch=main', source], root);
  await writeFile(path.join(source, 'readme.md'), 'initial\n');
  await gitCommand(['add', 'readme.md'], source);
  await gitCommand(['commit', '--quiet', '--message', 'initial'], source);
  await gitCommand(['remote', 'add', 'origin', origin], source);
  await gitCommand(['push', '--quiet', 'origin', 'main'], source);
  return { origin };
}

/** Commit a file in the shared preparation checkout and return the new revision. */
async function commitFile(worktree: string, name: string, content: string): Promise<string> {
  await writeFile(path.join(worktree, name), content);
  await gitCommand(['add', name], worktree);
  await gitCommand(['commit', '--quiet', '--message', `add ${name}`], worktree);
  return headOf(worktree);
}

/** One prepared prototype issue workspace over a temporary repository. */
async function prototypeWorkspace(): Promise<{
  readonly root: string;
  readonly worktree: string;
  readonly selectionFile: string;
  readonly roundDirectory: string;
}> {
  const { origin } = await repositoryWithOrigin();
  const directory = await temporaryDirectory();
  const root = path.join(directory, 'NEX-1');
  const selectionFile = path.join(directory, 'selection.json');
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: {},
      conversation: [],
      workspace: { root },
      stage: 'prototype',
    }),
  );
  const prepare = createPrepareStage({
    selectionFile,
    repository: { source: origin, mainBranch: 'main' },
    git,
    publish: () => undefined,
  });
  await expect(prepare({ stage: 'prototype' })).resolves.toBe('prepared');
  const stageRoot = path.join(root, 'prototype');
  const roundDirectory = roundArtifactDirectory(stageRoot, 1);
  await mkdir(path.join(stageRoot, 'state'), { recursive: true });
  await mkdir(roundDirectory, { recursive: true });
  await writeFile(
    path.join(stageRoot, 'state', 'current-round.json'),
    JSON.stringify({
      stage: 'prototype',
      round: 1,
      route: 'new',
      profiles: { author: 'nexus-flash', evaluator: 'nexus-sol' },
    }),
  );
  return { root, worktree: path.join(root, 'worktree'), selectionFile, roundDirectory };
}

/** A runner answering one report and capturing every context it was given. */
function runnerOf(report: unknown): {
  readonly runner: AgentRoleRunner;
  readonly contexts: string[];
} {
  const contexts: string[] = [];
  return {
    contexts,
    runner: {
      run: async (request) => {
        contexts.push(request.context);
        return ok({ output: JSON.stringify(report) });
      },
    },
  };
}

/** One authored prototype report naming a story the author committed and observed. */
function authoredReport(observation: string): Record<string, unknown> {
  return {
    outcome: 'authored',
    summary: 'The prototype journey.',
    documents: [],
    sourcePaths: ['stories/journey.stories.js'],
    plan: [],
    skip: null,
    question: null,
    upstream: null,
    observation: { path: observation },
    findingResponses: [],
  };
}

/** One evaluator report for the current authored revision. */
function evaluationReport(verdict: string, observation: string | null): Record<string, unknown> {
  return {
    assessedRevision: 1,
    verdict,
    reason: 'Assessed the exact retained prototype.',
    observation: observation === null ? null : { path: observation },
    findings: [],
    priorFindings: [],
    upstream: null,
  };
}

describe('prototype observation evidence', () => {
  it('requires the author to bind a committed observation for applicable prototype work', async () => {
    const { root, worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    await writeFile(path.join(worktree, 'stories', 'journey.stories.js'), 'export const j = 1;\n');
    const baseRevision = await headOf(worktree);
    // The record names a revision that does not yet hold the story the author is submitting.
    const staleRecord = await savePrototypeObservation({
      roundDirectory,
      role: 'author',
      content: [{ path: 'stories/journey.stories.js', revision: baseRevision, exists: true }],
    });
    const author = (report: unknown) =>
      createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(report).runner,
      })({ task: 'propose' });
    await expect(author(authoredReport(staleRecord))).rejects.toThrow(
      /does not retain "stories\/journey\.stories\.js"; commit the inspected content/,
    );

    // A committed story with a fresh record that names that commit is usable author work.
    const revision = await commitFile(
      worktree,
      'stories/journey.stories.js',
      'export const j = 1;\n',
    );
    const record = await savePrototypeObservation({
      roundDirectory,
      role: 'author',
      content: [{ path: 'stories/journey.stories.js', revision }],
    });
    const { runner } = runnerOf(authoredReport(record));
    await expect(
      createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner,
      })({ task: 'propose' }),
    ).resolves.toBe('authored');
    const saved = await readStageArtifact(path.join(root, 'prototype'), 1, stageAuthorArtifact);
    expect(saved).toMatchObject({
      outcome: 'authored',
      sourcePaths: ['stories/journey.stories.js'],
      observation: { path: record },
    });
  });

  it('requires an observation for applicable work and rejects evidence on other stages', async () => {
    const { worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    const revision = await commitFile(
      worktree,
      'stories/journey.stories.js',
      'export const j = 1;\n',
    );
    const record = await savePrototypeObservation({
      roundDirectory,
      role: 'author',
      content: [{ path: 'stories/journey.stories.js', revision }],
    });
    const prototypeAuthor = (report: unknown) =>
      createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(report).runner,
      })({ task: 'propose' });

    await expect(prototypeAuthor({ ...authoredReport(record), observation: null })).rejects.toThrow(
      /needs the author.s saved browser observation/,
    );
    await expect(
      prototypeAuthor({
        outcome: 'skip-proposed',
        summary: 'No useful prototype work applies.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { reason: 'No useful prototype work applies.', references: ['readme.md'] },
        question: null,
        upstream: null,
        observation: { path: record },
        findingResponses: [],
      }),
    ).rejects.toThrow(/only authored prototype work carries an observation/);

    // A requirements author that claims an observation is not usable.
    const requirementsRoot = path.join(path.dirname(selectionFile), 'NEX-1', 'requirements');
    await mkdir(path.join(requirementsRoot, 'state'), { recursive: true });
    await writeFile(
      path.join(requirementsRoot, 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'requirements',
        round: 1,
        route: 'new',
        profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
      }),
    );
    await expect(
      createStageAuthor({
        selectionFile,
        stage: 'requirements',
        git,
        publish: () => undefined,
        runner: runnerOf({
          outcome: 'authored',
          summary: 'The requirements.',
          documents: [{ path: 'readme.md', description: 'the requirements' }],
          sourcePaths: [],
          plan: [],
          skip: null,
          question: null,
          upstream: null,
          observation: { path: record },
          findingResponses: [],
        }).runner,
      })({ task: 'propose' }),
    ).rejects.toThrow(/only the Storybook Refinement stage retains a prototype observation/);
  });

  it('rejects a record whose screenshots are not readable rendered images', async () => {
    const { worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    const revision = await commitFile(
      worktree,
      'stories/journey.stories.js',
      'export const j = 1;\n',
    );
    const notAnImage = path.join(roundDirectory, 'observations', 'author-journey.png');
    await mkdir(path.dirname(notAnImage), { recursive: true });
    await writeFile(notAnImage, 'not an image\n');
    const record = path.join(roundDirectory, 'observations', 'author.json');
    await writeFile(
      record,
      JSON.stringify({
        role: 'author',
        content: [{ path: 'stories/journey.stories.js', revision, exists: true }],
        preview: { command: 'npm run storybook', url: 'http://localhost:6100' },
        journeys: [
          {
            example: 'The journey',
            state: 'the changed state',
            actions: ['opened the story'],
            observed: 'It changed.',
            screenshots: [{ path: notAnImage }],
            visualConclusion: 'It looked right.',
          },
        ],
      }),
    );
    await expect(
      createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(authoredReport(record)).runner,
      })({ task: 'propose' }),
    ).rejects.toThrow(/is not readable rendered image evidence/);
  });

  it('accepts applicable prototype work only with both roles evidence and retains the references', async () => {
    const { root, worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    // The story changed after this earlier revision; evidence bound to it is stale.
    await commitFile(worktree, 'stories/journey.stories.js', 'export const j = 0;\n');
    const previous = await headOf(worktree);
    const revision = await commitFile(
      worktree,
      'stories/journey.stories.js',
      'export const j = 1;\n',
    );
    const authorObservation = await savePrototypeObservation({
      roundDirectory,
      role: 'author',
      content: [{ path: 'stories/journey.stories.js', revision }],
    });
    const evaluatorObservation = await savePrototypeObservation({
      roundDirectory,
      role: 'evaluator',
      content: [{ path: 'stories/journey.stories.js', revision }],
    });
    await createStageAuthor({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(authoredReport(authorObservation)).runner,
    })({ task: 'propose' });
    const stageRoot = path.join(root, 'prototype');

    // Acceptance without the evaluator's own browser evidence is unusable.
    await expect(
      createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(evaluationReport('accepted', null)).runner,
      })(),
    ).rejects.toThrow(/needs the evaluator.s own saved browser observation/);

    // Stale evidence: the record names a revision whose story content differs from the assessment.
    const stale = await savePrototypeObservation({
      roundDirectory,
      role: 'evaluator',
      name: 'stale-evaluator',
      content: [{ path: 'stories/journey.stories.js', revision: previous }],
    });
    await expect(
      createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(evaluationReport('accepted', stale)).runner,
      })(),
    ).rejects.toThrow(/differs from the evaluated revision/);

    await expect(
      createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(evaluationReport('accepted', evaluatorObservation)).runner,
      })(),
    ).resolves.toBe('accepted');
    await expect(readStageArtifact(stageRoot, 1, stageEvaluationArtifact)).resolves.toMatchObject({
      verdict: 'accepted',
      observation: { path: evaluatorObservation },
    });

    await createStageResult({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
    })({ outcome: 'accepted' });
    const result = await readStageArtifact(stageRoot, 1, stageResultArtifact);
    expect(result).toMatchObject({
      outcome: 'accepted',
      prototype: { branch: 'task/NEX-1', revision },
      prototypeObservations: [
        { role: 'author', path: authorObservation },
        { role: 'evaluator', path: evaluatorObservation },
      ],
      sourcePaths: ['stories/journey.stories.js'],
    });
  });

  it('accepts an evaluated applicability skip without preview evidence', async () => {
    const { root, selectionFile, worktree } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'docs'), { recursive: true });
    await commitFile(worktree, 'docs/ux.md', '# UX\n');
    await createStageAuthor({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf({
        outcome: 'skip-proposed',
        summary: 'No useful prototype work applies.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { reason: 'No useful prototype work applies.', references: ['docs/ux.md'] },
        question: null,
        upstream: null,
        observation: null,
        findingResponses: [],
      }).runner,
    })({ task: 'propose' });
    await expect(
      createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(evaluationReport('accepted-skip', null)).runner,
      })(),
    ).resolves.toBe('accepted-skip');
    const stageRoot = path.join(root, 'prototype');
    await createStageResult({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
    })({ outcome: 'skipped' });
    await expect(readStageArtifact(stageRoot, 1, stageResultArtifact)).resolves.toMatchObject({
      outcome: 'skipped',
      prototype: null,
      prototypeObservations: [],
    });
  });

  it('requires fresh evidence after the prototype content changes', async () => {
    const { root, worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    const revision = await commitFile(
      worktree,
      'stories/journey.stories.js',
      'export const j = 1;\n',
    );
    const authorObservation = await savePrototypeObservation({
      roundDirectory,
      role: 'author',
      content: [{ path: 'stories/journey.stories.js', revision }],
    });
    await createStageAuthor({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(authoredReport(authorObservation)).runner,
    })({ task: 'propose' });
    await createStageEvaluator({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(
        evaluationReport(
          'accepted',
          await savePrototypeObservation({
            roundDirectory,
            role: 'evaluator',
            content: [{ path: 'stories/journey.stories.js', revision }],
          }),
        ),
      ).runner,
    })();
    await createStageResult({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
    })({ outcome: 'accepted' });

    // A response round changes the story but reuses the earlier observation: the stale reference
    // cannot authorize the changed content.
    const changed = await commitFile(
      worktree,
      'stories/journey.stories.js',
      'export const j = 2;\n',
    );
    const stageRoot = path.join(root, 'prototype');
    await mkdir(path.join(stageRoot, 'artifacts', '2'), { recursive: true });
    await writeFile(
      path.join(stageRoot, 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'prototype',
        round: 2,
        route: 'next',
        profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
      }),
    );
    const respond = (report: unknown) =>
      createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(report).runner,
      })({ task: 'respond' });
    const roundTwo = roundArtifactDirectory(stageRoot, 2);
    // A record saved for this round that still names the earlier revision is stale evidence.
    const staleInRoundTwo = await savePrototypeObservation({
      roundDirectory: roundTwo,
      role: 'author',
      content: [{ path: 'stories/journey.stories.js', revision }],
    });
    await expect(respond(authoredReport(staleInRoundTwo))).rejects.toThrow(
      /differs from the content being submitted/,
    );
    const fresh = await savePrototypeObservation({
      roundDirectory: roundTwo,
      role: 'author',
      content: [{ path: 'stories/journey.stories.js', revision: changed }],
    });
    await expect(respond(authoredReport(fresh))).resolves.toBe('authored');
  });

  it('supplies the observation contract and round artifact area to the prototype roles only', async () => {
    const { selectionFile, worktree, roundDirectory } = await prototypeWorkspace();
    const captured = runnerOf(authoredReport(path.join(roundDirectory, 'missing.json')));
    await expect(
      createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: captured.runner,
      })({ task: 'propose' }),
    ).rejects.toThrow(/does not exist/);
    expect(captured.contexts[0]).toContain('Prototype observation contract');
    expect(captured.contexts[0]).toContain(roundDirectory);
    expect(captured.contexts[0]).toContain('Commit the stage-owned prototype paths');

    await commitFile(worktree, 'readme.md', 'initial\nrequirements\n');
    const requirementsRoot = path.join(path.dirname(selectionFile), 'NEX-1', 'requirements');
    await mkdir(path.join(requirementsRoot, 'state'), { recursive: true });
    await mkdir(path.join(requirementsRoot, 'artifacts', '1'), { recursive: true });
    await writeFile(
      path.join(requirementsRoot, 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'requirements',
        round: 1,
        route: 'new',
        profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
      }),
    );
    const requirements = runnerOf({
      outcome: 'authored',
      summary: 'The requirements.',
      documents: [{ path: 'readme.md', description: 'the requirements' }],
      sourcePaths: [],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      observation: null,
      findingResponses: [],
    });
    await expect(
      createStageAuthor({
        selectionFile,
        stage: 'requirements',
        git,
        publish: () => undefined,
        runner: requirements.runner,
      })({ task: 'propose' }),
    ).resolves.toBe('authored');
    expect(requirements.contexts[0]).not.toContain('Prototype observation contract');
  });
});
