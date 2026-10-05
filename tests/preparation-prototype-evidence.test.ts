/**
 * Focused integration tests: the Storybook Refinement stage's producer-owned observation contract
 * over real temporary Git repositories. Substituted agent responses stand in for the
 * browser-capable profile invocations: they establish that applicable prototype work needs
 * readable, current author and evaluator evidence, that changed content needs fresh observation
 * and that an evaluated applicability skip needs no preview. The separate host integration check
 * exercises the real prototype profiles, Playwright MCP and an isolated Storybook fixture.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  stageReportScope,
  stageResultArtifact,
} from '../src/task-engine/actions/preparation/artifacts.js';
import { createPrepareStage } from '../src/task-engine/actions/preparation/prepare-stage/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import { createStageResult } from '../src/task-engine/actions/preparation/stage-result/index.js';
import {
  authoredIdentity,
  sourceInputIdentity,
} from '../src/task-engine/actions/preparation/evaluation-content.js';
import {
  readCurrentDecision,
  readStageArtifact,
  roundArtifactDirectory,
} from '../src/task-engine/actions/preparation/storage.js';
import {
  outstandingReportFeedback,
  readReportFeedback,
} from '../src/task-engine/actions/report-feedback.js';
import { savePrototypeObservation } from './support/prototype-observation.js';
import { writeAssignedReport } from './support/agent-runner.js';

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
        await writeAssignedReport(request.context, '# Controlled prototype report\n');
        return ok({ output: JSON.stringify(report) });
      },
    },
  };
}

/** One authored prototype report naming a story the author committed and observed. */
function authoredReport(observation: string): Record<string, unknown> {
  return {
    outcome: 'authored',
    documents: [],
    sourcePaths: ['stories/journey.stories.js'],
    plan: [],
    skip: null,
    question: null,
    upstream: null,
    observation: { path: observation },
  };
}

/** One evaluator report for the current authored revision. */
function evaluationReport(verdict: string, observation: string | null): Record<string, unknown> {
  return {
    verdict,
    observation: observation === null ? null : { path: observation },
    upstream: null,
  };
}

describe('prototype observation evidence', () => {
  it.each(['malformed JSON', 'unreadable file', 'stale content', 'missing reference'])(
    'routes retained author observation failures to the author after repair: %s',
    async (failure) => {
      const { root, worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
      await mkdir(path.join(worktree, 'stories'), { recursive: true });
      const previous = await commitFile(worktree, 'stories/journey.stories.js', 'old story\n');
      const revision = await commitFile(worktree, 'stories/journey.stories.js', 'new story\n');
      const content = [{ path: 'stories/journey.stories.js', revision }];
      const authorObservation = await savePrototypeObservation({
        roundDirectory,
        role: 'author',
        content,
      });
      const evaluatorObservation = await savePrototypeObservation({
        roundDirectory,
        role: 'evaluator',
        content,
      });
      // Relative declarations must retain the resolved observation file, not a cwd-relative path.
      const authorReport = authoredReport(path.relative(roundDirectory, authorObservation));
      await createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(authorReport).runner,
      })({ task: 'propose' });
      const stageRoot = path.join(root, 'prototype');
      const authorFile = path.join(roundDirectory, 'author.json');
      const originalAuthor = await readFile(authorFile, 'utf8');
      const originalObservation = await readFile(authorObservation, 'utf8');
      let source = authorObservation;
      let output: string | null;
      let reason: string;
      if (failure === 'unreadable file') {
        await rm(authorObservation);
        await mkdir(authorObservation);
        output = null;
        reason = 'could not be read';
      } else if (failure === 'missing reference') {
        source = authorFile;
        output = JSON.stringify({ ...JSON.parse(originalAuthor), observation: null });
        reason = 'author report carries no observation';
        await writeFile(source, output);
      } else {
        output =
          failure === 'malformed JSON'
            ? '{broken author observation\n'
            : JSON.stringify({
                ...JSON.parse(originalObservation),
                content: [{ path: 'stories/journey.stories.js', revision: previous, exists: true }],
              });
        reason =
          failure === 'malformed JSON' ? 'not valid JSON' : 'differs from the evaluated revision';
        await writeFile(source, output);
      }
      const evaluation = runnerOf(evaluationReport('accepted', evaluatorObservation));
      const evaluate = createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: evaluation.runner,
      });
      await expect(evaluate()).rejects.toThrow(reason);
      await expect(readStageArtifact(stageRoot, 1, stageEvaluationArtifact)).resolves.toBeNull();
      const authorScope = stageReportScope({
        project: path.basename(path.dirname(root)),
        workId: 'NEX-1',
        area: stageRoot,
        stage: 'prototype',
        role: 'author',
      });
      const feedback = await readReportFeedback(stageRoot);
      expect(feedback).toHaveLength(1);
      expect(feedback[0]?.record).toMatchObject({
        kind: 'rejection',
        scope: authorScope,
        invocationId: (JSON.parse(originalAuthor) as { invocationId: string }).invocationId,
        operation: 'stage-author',
        profile: 'nexus-flash',
        source: { path: source },
        output,
        reason: expect.stringContaining(reason),
      });

      // Historical repair and a valid evaluator save cannot resolve another producer's rejection.
      await rm(authorObservation, { recursive: true, force: true });
      await writeFile(authorObservation, originalObservation);
      await writeFile(authorFile, originalAuthor);
      await expect(evaluate()).resolves.toBe('accepted');
      expect(evaluation.contexts.at(-1)).not.toContain(
        'Outstanding report rejections of this report responsibility',
      );
      await expect(
        outstandingReportFeedback({ areaRoot: stageRoot, scope: authorScope }),
      ).resolves.toHaveLength(1);

      // The next author round receives the retained diagnosis and retires it only on validated save.
      const nextDirectory = roundArtifactDirectory(stageRoot, 2);
      const nextObservation = await savePrototypeObservation({
        roundDirectory: nextDirectory,
        role: 'author',
        content,
      });
      await writeFile(
        path.join(stageRoot, 'state', 'current-round.json'),
        JSON.stringify({
          stage: 'prototype',
          round: 2,
          route: 'reassess',
          profiles: { author: 'nexus-flash', evaluator: 'nexus-sol' },
        }),
      );
      const correction = runnerOf(authoredReport(nextObservation));
      await expect(
        createStageAuthor({
          selectionFile,
          stage: 'prototype',
          git,
          publish: () => undefined,
          runner: correction.runner,
        })({ task: 'propose' }),
      ).resolves.toBe('authored');
      expect(correction.contexts[0]).toContain(reason);
      expect(correction.contexts[0]).toContain(source);
      if (output !== null) expect(correction.contexts[0]).toContain(output);
      await expect(
        outstandingReportFeedback({ areaRoot: stageRoot, scope: authorScope }),
      ).resolves.toEqual([]);
      expect(
        (await readReportFeedback(stageRoot)).filter((entry) => entry.record.kind === 'rejection'),
      ).toEqual(feedback);
    },
  );

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
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { references: ['readme.md'] },
        question: null,
        upstream: null,
        observation: { path: record },
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
          documents: [{ path: 'readme.md' }],
          sourcePaths: [],
          plan: [],
          skip: null,
          question: null,
          upstream: null,
          observation: { path: record },
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
    const staleReport = evaluationReport('accepted', stale);
    await expect(
      createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(staleReport).runner,
      })(),
    ).rejects.toThrow(/differs from the evaluated revision/);

    // The semantic violation retains the evaluator's exact response and reason for its next
    // permitted invocation; the earlier missing-observation rejection stays outstanding too.
    const evaluatorScope = stageReportScope({
      project: path.basename(path.dirname(root)),
      workId: 'NEX-1',
      area: stageRoot,
      stage: 'prototype',
      role: 'evaluator',
    });
    const staleRejection = (
      await outstandingReportFeedback({ areaRoot: stageRoot, scope: evaluatorScope })
    ).find((entry) => entry.record.reason.includes('differs from the evaluated revision'));
    expect(staleRejection?.record).toMatchObject({
      scope: evaluatorScope,
      operation: 'stage-evaluator',
      output: JSON.stringify(staleReport),
      source: null,
      reason: expect.stringContaining('differs from the evaluated revision'),
    });
    await expect(
      outstandingReportFeedback({ areaRoot: stageRoot, scope: evaluatorScope }),
    ).resolves.toHaveLength(2);

    const acceptedContexts: string[] = [];
    await expect(
      createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: {
          async run(request) {
            acceptedContexts.push(request.context);
            await writeAssignedReport(request.context, '# Accepted evaluator report\n');
            return ok({
              output: JSON.stringify(evaluationReport('accepted', evaluatorObservation)),
            });
          },
        },
      })(),
    ).resolves.toBe('accepted');
    // The next permitted evaluator invocation received the rejected bytes and violated rule, and
    // its validated saved replacement recorded the corrections that retired the feedback.
    const acceptedContext = acceptedContexts.join('\n');
    expect(acceptedContext).toContain(
      'Outstanding report rejections of this report responsibility',
    );
    expect(acceptedContext).toContain('differs from the evaluated revision');
    expect(acceptedContext).toContain('Rejected output (exact returned bytes):');
    expect(acceptedContext).toContain(stale);
    await expect(
      outstandingReportFeedback({ areaRoot: stageRoot, scope: evaluatorScope }),
    ).resolves.toEqual([]);
    expect(
      (await readReportFeedback(stageRoot)).filter((entry) => entry.record.kind === 'rejection'),
    ).toHaveLength(2);
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
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { references: ['docs/ux.md'] },
        question: null,
        upstream: null,
        observation: null,
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

    // An evaluated applicability skip carries no observation, even when one was performed.
    await expect(
      createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(
          evaluationReport(
            'accepted-skip',
            path.join(root, 'prototype', 'artifacts', '1', 'observations', 'evaluator.json'),
          ),
        ).runner,
      })(),
    ).rejects.toThrow(/an evaluated applicability skip carries no observation/);

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
      documents: [{ path: 'readme.md' }],
      sourcePaths: [],
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      observation: null,
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

  it('retains a prototype deletion committed during the invocation through author replay', async () => {
    const { worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    await commitFile(worktree, 'stories/journey.stories.js', 'export const j = 0;\n');
    let record = '';
    let deletion = '';
    const runner: AgentRoleRunner = {
      async run(request) {
        await writeAssignedReport(request.context, '# Removed the adapted story\n');
        await rm(path.join(worktree, 'stories', 'journey.stories.js'));
        await gitCommand(['add', 'stories/journey.stories.js'], worktree);
        await gitCommand(['commit', '--quiet', '--message', 'remove the adapted story'], worktree);
        deletion = await headOf(worktree);
        record = await savePrototypeObservation({
          roundDirectory,
          role: 'author',
          content: [{ path: 'stories/journey.stories.js', revision: deletion, exists: false }],
        });
        return ok({ output: JSON.stringify(authoredReport(record)) });
      },
    };
    await expect(
      createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner,
      })({ task: 'propose' }),
    ).resolves.toBe('authored');
    const author = (report: unknown) =>
      createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(report).runner,
      })({ task: 'propose' });

    // The validated author record retains stage ownership even before evaluation is saved.
    await expect(author(authoredReport(record))).resolves.toBe('authored');
    // Ownership does not require the old screenshot to survive when a repair replaces it with
    // fresh evidence for the same deletion.
    await rm(path.join(roundDirectory, 'observations', 'author-journey.png'));
    record = await savePrototypeObservation({
      roundDirectory,
      role: 'author',
      name: 'replay',
      content: [{ path: 'stories/journey.stories.js', revision: deletion, exists: false }],
    });
    await expect(author(authoredReport(record))).resolves.toBe('authored');
    const evaluatorObservation = await savePrototypeObservation({
      roundDirectory,
      role: 'evaluator',
      content: [{ path: 'stories/journey.stories.js', revision: deletion, exists: false }],
    });
    await createStageEvaluator({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(evaluationReport('accepted', evaluatorObservation)).runner,
    })();
    await createStageResult({ selectionFile, stage: 'prototype', git, publish: () => undefined })({
      outcome: 'accepted',
    });
    // Evaluation history retains ownership too, including after an unrelated commit.
    await commitFile(worktree, 'notes.md', 'later work\n');
    await expect(author(authoredReport(record))).resolves.toBe('authored');

    const untracked = await savePrototypeObservation({
      roundDirectory,
      role: 'author',
      name: 'untracked',
      content: [{ path: 'stories/never-committed.js', revision: deletion, exists: false }],
    });
    await expect(
      author({ ...authoredReport(untracked), sourcePaths: ['stories/never-committed.js'] }),
    ).rejects.toThrow(/was not tracked before revision/);
  });

  it('accepts a document the author deleted and committed during the invocation', async () => {
    const { worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'docs'), { recursive: true });
    await commitFile(worktree, 'docs/ux.md', '# UX\n');
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
    // The real author commits the inspected deletion before it returns its report; the checkout's
    // post-invocation head no longer tracks the path the pre-invocation revision still tracked.
    const runner: AgentRoleRunner = {
      async run(request) {
        await writeAssignedReport(request.context, '# Removed the stale UX note\n');
        await rm(path.join(worktree, 'docs', 'ux.md'));
        await gitCommand(['add', 'docs/ux.md'], worktree);
        await gitCommand(['commit', '--quiet', '--message', 'remove the stale UX note'], worktree);
        return ok({
          output: JSON.stringify({
            outcome: 'authored',
            documents: [{ path: 'docs/ux.md' }],
            sourcePaths: [],
            plan: [],
            skip: null,
            question: null,
            upstream: null,
            observation: null,
          }),
        });
      },
    };
    await expect(
      createStageAuthor({
        selectionFile,
        stage: 'requirements',
        git,
        publish: () => undefined,
        runner,
      })({ task: 'propose' }),
    ).resolves.toBe('authored');
    await createStageEvaluator({
      selectionFile,
      stage: 'requirements',
      git,
      publish: () => undefined,
      runner: runnerOf(evaluationReport('accepted', null)).runner,
    })();
    await createStageResult({
      selectionFile,
      stage: 'requirements',
      git,
      publish: () => undefined,
    })({ outcome: 'accepted' });
    const deletion = await headOf(worktree);
    await commitFile(worktree, 'notes.md', 'unrelated later work\n');
    const observation = await savePrototypeObservation({
      roundDirectory,
      role: 'author',
      content: [{ path: 'docs/ux.md', revision: deletion, exists: false }],
    });
    // An ancestral deletion commit establishes absence, but does not transfer Requirements'
    // ownership to a fresh prototype author. Both document and source declarations reject it.
    for (const declaration of [
      { documents: [{ path: 'docs/ux.md' }], sourcePaths: [] },
      { documents: [], sourcePaths: ['docs/ux.md'] },
    ]) {
      await expect(
        createStageAuthor({
          selectionFile,
          stage: 'prototype',
          git,
          publish: () => undefined,
          runner: runnerOf({ ...authoredReport(observation), ...declaration }).runner,
        })({ task: 'propose' }),
      ).rejects.toThrow(/was not tracked before this edit/);
    }
  });

  it('keeps the evaluator observation on a defect report and an upstream return', async () => {
    const { root, worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    await commitFile(worktree, 'stories/journey.stories.js', 'export const j = 0;\n');
    const previous = await headOf(worktree);
    const revision = await commitFile(
      worktree,
      'stories/journey.stories.js',
      'export const j = 1;\n',
    );
    await createStageAuthor({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(
        authoredReport(
          await savePrototypeObservation({
            roundDirectory,
            role: 'author',
            content: [{ path: 'stories/journey.stories.js', revision }],
          }),
        ),
      ).runner,
    })({ task: 'propose' });
    const evaluatorObservation = await savePrototypeObservation({
      roundDirectory,
      role: 'evaluator',
      content: [{ path: 'stories/journey.stories.js', revision }],
    });
    const evaluator = (report: Record<string, unknown>) =>
      createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(report).runner,
      })();
    // A defect report with its own observed evidence resolves and retains the reference.
    await expect(
      evaluator({
        verdict: 'changes-requested',
        observation: { path: evaluatorObservation },
        upstream: null,
      }),
    ).resolves.toBe('changes-requested');
    const stageRoot = path.join(root, 'prototype');
    await expect(readStageArtifact(stageRoot, 1, stageEvaluationArtifact)).resolves.toMatchObject({
      verdict: 'changes-requested',
      observation: { path: evaluatorObservation },
    });

    // A retained defect observation must still bind the assessed revision.
    const stale = await savePrototypeObservation({
      roundDirectory,
      role: 'evaluator',
      name: 'stale-defect',
      content: [{ path: 'stories/journey.stories.js', revision: previous }],
    });
    await expect(
      evaluator({
        verdict: 'changes-requested',
        observation: { path: stale },
        upstream: null,
      }),
    ).rejects.toThrow(/differs from the evaluated revision/);

    // An upstream return that performed a preview keeps the observed evidence too.
    await expect(
      evaluator({
        verdict: 'return-upstream',
        observation: { path: evaluatorObservation },
        upstream: {
          stage: 'requirements',
          correction: 'Capture the running state in the acceptance examples.',
        },
      }),
    ).resolves.toBe('return-upstream');
  });

  it('validates retained observations when finalizing acceptance and current decisions', async () => {
    // Finalizing acceptance refuses a record that disappeared after the evaluation.
    const first = await prototypeWorkspace();
    await mkdir(path.join(first.worktree, 'stories'), { recursive: true });
    const firstRevision = await commitFile(
      first.worktree,
      'stories/journey.stories.js',
      'export const j = 1;\n',
    );
    const firstAuthor = await savePrototypeObservation({
      roundDirectory: first.roundDirectory,
      role: 'author',
      content: [{ path: 'stories/journey.stories.js', revision: firstRevision }],
    });
    await createStageAuthor({
      selectionFile: first.selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(authoredReport(firstAuthor)).runner,
    })({ task: 'propose' });
    await createStageEvaluator({
      selectionFile: first.selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(
        evaluationReport(
          'accepted',
          await savePrototypeObservation({
            roundDirectory: first.roundDirectory,
            role: 'evaluator',
            content: [{ path: 'stories/journey.stories.js', revision: firstRevision }],
          }),
        ),
      ).runner,
    })();
    await rm(firstAuthor);
    await expect(
      createStageResult({
        selectionFile: first.selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
      })({ outcome: 'accepted' }),
    ).rejects.toThrow(/retained author prototype observation is unusable/);

    // A downstream current decision goes stale when the retained records are gone.
    const second = await prototypeWorkspace();
    await mkdir(path.join(second.worktree, 'stories'), { recursive: true });
    const secondRevision = await commitFile(
      second.worktree,
      'stories/journey.stories.js',
      'export const j = 1;\n',
    );
    await createStageAuthor({
      selectionFile: second.selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(
        authoredReport(
          await savePrototypeObservation({
            roundDirectory: second.roundDirectory,
            role: 'author',
            content: [{ path: 'stories/journey.stories.js', revision: secondRevision }],
          }),
        ),
      ).runner,
    })({ task: 'propose' });
    const secondEvaluator = await savePrototypeObservation({
      roundDirectory: second.roundDirectory,
      role: 'evaluator',
      content: [{ path: 'stories/journey.stories.js', revision: secondRevision }],
    });
    await createStageEvaluator({
      selectionFile: second.selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(evaluationReport('accepted', secondEvaluator)).runner,
    })();
    await createStageResult({
      selectionFile: second.selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
    })({ outcome: 'accepted' });
    const selection = JSON.parse(await readFile(second.selectionFile, 'utf8'));
    await expect(
      readCurrentDecision({
        issueRoot: second.root,
        stage: 'prototype',
        selection,
        git,
      }),
    ).resolves.toMatchObject({ kind: 'current' });
    await rm(secondEvaluator);
    await expect(
      readCurrentDecision({
        issueRoot: second.root,
        stage: 'prototype',
        selection,
        git,
      }),
    ).resolves.toMatchObject({
      kind: 'stale',
      reason: expect.stringContaining('retained evaluator prototype observation is unusable'),
    });
  });

  it.each(['missing-record', 'empty', 'omitted'])(
    'refuses a retained applicable prototype with %s observation evidence',
    async (mode) => {
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
      const evaluatorObservation = await savePrototypeObservation({
        roundDirectory,
        role: 'evaluator',
        content: [{ path: 'stories/journey.stories.js', revision }],
      });
      await createStageEvaluator({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(evaluationReport('accepted', evaluatorObservation)).runner,
      })();
      await createStageResult({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
      })({ outcome: 'accepted' });

      // A former reuse skip retained the applicable prototype bundle, possibly with empty or
      // omitted observation references; the retained record must still prove both roles' current
      // evidence before it can authorize the route.
      const stageRoot = path.join(root, 'prototype');
      const accepted = JSON.parse(
        await readFile(path.join(stageRoot, 'artifacts', '1', 'result.json'), 'utf8'),
      ) as Record<string, unknown>;
      const selection = JSON.parse(await readFile(selectionFile, 'utf8'));
      const legacyAuthor = {
        stage: 'prototype',
        revision: 2,
        outcome: 'skip-proposed',
        summary: 'The accepted prototype still matches the corrected input.',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: {
          reason: 'The accepted prototype still matches the corrected input.',
          references: [],
        },
        question: null,
        upstream: null,
        observation: null,
      };
      await mkdir(path.join(stageRoot, 'artifacts', '2'), { recursive: true });
      const legacyAuthorFile = path.join(stageRoot, 'artifacts', '2', 'author.json');
      await writeFile(legacyAuthorFile, JSON.stringify(legacyAuthor));
      const storedAuthor = await readStageArtifact(stageRoot, 2, stageAuthorArtifact);
      if (storedAuthor === null) throw new Error('the retained author record is unreadable');
      await writeFile(
        path.join(stageRoot, 'artifacts', '2', 'evaluation.json'),
        JSON.stringify({
          basis: {
            author: { path: legacyAuthorFile },
            authorIdentity: authoredIdentity(storedAuthor),
            sourceIdentity: sourceInputIdentity(selection as never),
            upstream: [],
            content: [{ path: 'stories/journey.stories.js', revision, exists: true }],
          },
          assessedRevision: 2,
          verdict: 'accepted-skip',
          reason: 'The accepted prototype still matches the corrected input.',
          observation: null,
          findings: [],
          upstream: null,
        }),
      );
      await writeFile(
        path.join(stageRoot, 'state', 'current-round.json'),
        JSON.stringify({
          stage: 'prototype',
          round: 2,
          route: 'reassess',
          profiles: { author: 'nexus-flash', evaluator: 'nexus-sol' },
        }),
      );
      // The former reuse skip kept the preceding acceptance's prototype bundle, so the record
      // still has to prove both roles' evidence before it can authorize the route.
      const legacyResult = {
        stage: 'prototype',
        outcome: 'skipped',
        authoredRevision: 2,
        documents: [],
        sourcePaths: accepted.sourcePaths,
        skipReferences: [],
        outputs: [],
        evaluation: { path: path.join(stageRoot, 'artifacts', '2', 'evaluation.json') },
        reason: 'The accepted prototype still matches the corrected input.',
        returnStage: null,
        returnFinding: null,
        prototype: accepted.prototype,
        prototypeObservations: accepted.prototypeObservations,
      } as Record<string, unknown>;
      if (mode === 'empty') legacyResult.prototypeObservations = [];
      if (mode === 'omitted') delete legacyResult.prototypeObservations;
      if (mode === 'missing-record') await rm(evaluatorObservation);
      const problem =
        mode === 'missing-record'
          ? /retained evaluator prototype observation is unusable/
          : /missing one role.s saved observation record/;
      const resultFile = path.join(stageRoot, 'artifacts', '2', 'result.json');
      await writeFile(resultFile, JSON.stringify(legacyResult));
      await writeFile(path.join(stageRoot, 'state', 'result.json'), JSON.stringify(legacyResult));
      await expect(
        readCurrentDecision({ issueRoot: root, stage: 'prototype', selection, git }),
      ).resolves.toMatchObject({ kind: 'stale', reason: expect.stringMatching(problem) });
      const finalize = createStageResult({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
      });
      await expect(finalize({ outcome: 'skipped' })).rejects.toThrow(problem);
    },
  );

  it('retains no prototype bundle for a new applicability skip', async () => {
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
    const evaluatorObservation = await savePrototypeObservation({
      roundDirectory,
      role: 'evaluator',
      content: [{ path: 'stories/journey.stories.js', revision }],
    });
    await createStageEvaluator({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf(evaluationReport('accepted', evaluatorObservation)).runner,
    })();
    await createStageResult({ selectionFile, stage: 'prototype', git, publish: () => undefined })({
      outcome: 'accepted',
    });

    // A reassessment may later propose that the stage is irrelevant: the evaluated skip is
    // evidence-only and never selects the earlier prototype bundle.
    const stageRoot = path.join(root, 'prototype');
    await mkdir(path.join(stageRoot, 'artifacts', '2'), { recursive: true });
    await writeFile(
      path.join(stageRoot, 'state', 'current-round.json'),
      JSON.stringify({
        stage: 'prototype',
        round: 2,
        route: 'reassess',
        profiles: { author: 'nexus-flash', evaluator: 'nexus-sol' },
      }),
    );
    await createStageAuthor({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf({
        outcome: 'skip-proposed',
        documents: [],
        sourcePaths: [],
        plan: [],
        skip: { references: [] },
        question: null,
        upstream: null,
        observation: null,
      }).runner,
    })({ task: 'propose' });
    await createStageEvaluator({
      selectionFile,
      stage: 'prototype',
      git,
      publish: () => undefined,
      runner: runnerOf({
        verdict: 'accepted-skip',
        observation: null,
        upstream: null,
      }).runner,
    })();
    await createStageResult({ selectionFile, stage: 'prototype', git, publish: () => undefined })({
      outcome: 'skipped',
    });
    await expect(readStageArtifact(stageRoot, 2, stageResultArtifact)).resolves.toMatchObject({
      outcome: 'skipped',
      documents: [],
      sourcePaths: [],
      skipReferences: [],
      prototype: null,
      prototypeObservations: [],
    });
    // Removing the earlier evidence cannot break the completed non-applicable skip.
    await rm(roundDirectory, { recursive: true, force: true });
    await expect(
      readCurrentDecision({
        issueRoot: root,
        stage: 'prototype',
        selection: JSON.parse(await readFile(selectionFile, 'utf8')),
        git,
      }),
    ).resolves.toMatchObject({ kind: 'current' });
  });

  it('rejects truncated or corrupt screenshots instead of trusting their signature', async () => {
    const { worktree, selectionFile, roundDirectory } = await prototypeWorkspace();
    await mkdir(path.join(worktree, 'stories'), { recursive: true });
    const revision = await commitFile(
      worktree,
      'stories/journey.stories.js',
      'export const j = 1;\n',
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const observations = path.join(roundDirectory, 'observations');
    await mkdir(observations, { recursive: true });
    const recordFor = async (name: string, bytes: Buffer): Promise<string> => {
      const screenshot = path.join(observations, `${name}.png`);
      await writeFile(screenshot, bytes);
      const record = path.join(observations, `${name}.json`);
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
              screenshots: [{ path: screenshot }],
              visualConclusion: 'It looked right.',
            },
          ],
        }),
      );
      return record;
    };
    const author = (report: unknown) =>
      createStageAuthor({
        selectionFile,
        stage: 'prototype',
        git,
        publish: () => undefined,
        runner: runnerOf(report).runner,
      })({ task: 'propose' });

    // The eight-byte signature and a file cut mid-stream carry no openable image.
    await expect(
      author(authoredReport(await recordFor('signature-only', png.subarray(0, 8)))),
    ).rejects.toThrow(/is not readable rendered image evidence: its image data is not decodable/);
    await expect(
      author(authoredReport(await recordFor('truncated', png.subarray(0, 60)))),
    ).rejects.toThrow(/is not readable rendered image evidence: its image data is not decodable/);

    // Corrupt image data that still parses as chunks is not decodable.
    const corrupt = Buffer.from(png);
    corrupt[45] = corrupt[45] === undefined ? 0 : corrupt[45] ^ 0x5a;
    await expect(author(authoredReport(await recordFor('corrupt', corrupt)))).rejects.toThrow(
      /its image data is not decodable/,
    );

    // The complete one-pixel screenshot stays usable evidence.
    await expect(author(authoredReport(await recordFor('valid', png)))).resolves.toBe('authored');
  });
});
