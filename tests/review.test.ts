/**
 * Component tests: the real Review evaluates a delivered revision over real temporary storage with
 * the reviewer runtime, Git, GitHub and Jira adapters controlled. The producer-owned artifact
 * declarations carry the development, verification and delivery results; no provider, network or
 * paid turn is involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../src/agent-runtime/index.js';
import type { CheckObservation, GitHubReview } from '../src/adapters/github.js';
import type { JiraDocument } from '../src/adapters/jira.js';
import { ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { deliveryArtifact } from '../src/task-engine/actions/deliver/artifacts.js';
import { devArtifact, type FindingResponse } from '../src/task-engine/actions/develop/artifacts.js';
import {
  outstandingReportFeedback,
  projectOfWorkspace,
  readReportFeedback,
} from '../src/task-engine/actions/report-feedback.js';
import { createReview } from '../src/task-engine/actions/review/index.js';
import {
  reviewArtifact,
  reviewResponseSchema,
  type Finding,
  type ReviewOutput,
} from '../src/task-engine/actions/review/artifacts.js';
import { verificationArtifact } from '../src/task-engine/actions/verify/artifacts.js';
import type { AgentRoleRunner, EngineEvent } from '../src/task-engine/index.js';
import { runnerOf } from './support/agent-runner.js';
import { repositoryState, scriptedGit } from './support/git.js';
import { scriptedGitHub } from './support/github.js';
import { scriptedJira } from './support/jira.js';
import { strictSchemaProblems } from './support/provider-schema.js';

const baseRevision = '1'.repeat(40);
const headRevision = '2'.repeat(40);
const otherRevision = '3'.repeat(40);
const repository = 'owner/repository';
const reviewCheck = 'Nexus Lens review';
const lensAppId = 5001141;
const lensLogin = 'nexus-lens[bot]';

let root = '';
let events: EngineEvent[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-review-'));
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One request the controlled runtime received. */
type RuntimeRequest = {
  readonly profile: string;
  readonly workspaceRoot: string;
  readonly context: string;
  readonly outputSchema: Readonly<Record<string, unknown>> | undefined;
};

/** A controlled AgentRuntime that answers every invocation from the handler. */
function scriptedRuntime(handler: (request: RuntimeRequest) => string | Promise<string>): {
  readonly runtime: AgentRuntime;
  readonly requests: RuntimeRequest[];
} {
  const requests: RuntimeRequest[] = [];
  return {
    requests,
    runtime: {
      async run(profile, workspaceRef, additionalContext, _onActivity, outputSchema) {
        const request = {
          profile,
          workspaceRoot: workspaceRef.root,
          context: additionalContext,
          outputSchema,
        };
        requests.push(request);
        return ok({ output: await handler(request) });
      },
    },
  };
}

/** A runtime that fails the test when it is invoked. */
function unusedRuntime(): AgentRuntime {
  return {
    async run() {
      throw new Error('The reviewer must not be invoked again.');
    },
  };
}

/** One workspace with its prepared identity, current round and selection record. */
async function workspace(
  options: { readonly round?: number; readonly name?: string } = {},
): Promise<{
  readonly workspaceRoot: string;
  readonly selectionFile: string;
  readonly round: number;
}> {
  const round = options.round ?? 1;
  const workspaceRoot = path.join(root, options.name ?? 'workspace');
  await mkdir(path.join(workspaceRoot, 'state'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'artifacts', String(round)), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'worktree'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'state', 'current-round.json'),
    `${JSON.stringify({ number: round, profile: 'dev-a', reason: 'Planned.' })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceRoot, 'state', 'prepared-workspace.json'),
    `${JSON.stringify(
      {
        taskKey: 'NEX-1',
        repository: '/origin/repository.git',
        branch: 'task/NEX-1',
        baseRevision,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const selectionFile = path.join(
    root,
    'executions',
    `${options.name ?? 'workspace'}-selection.json`,
  );
  await mkdir(path.dirname(selectionFile), { recursive: true });
  await writeFile(
    selectionFile,
    `${JSON.stringify(
      {
        taskKey: 'NEX-1',
        source: { kind: 'jira', issueId: '1' },
        task: {
          id: '1',
          key: 'NEX-1',
          fields: {
            summary: 'Implement the retry guard',
            description: { type: 'doc', content: [] },
          },
        },
        conversation: [{ id: 'c1', body: 'Original request.' }],
        workspace: { root: workspaceRoot },
        stage: 'delivery',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { workspaceRoot, selectionFile, round };
}

/** Write the current round's development, verification and delivery results. */
async function writeDeliveredRound(
  workspaceRoot: string,
  options: {
    readonly findingResponses?: FindingResponse[];
    readonly pullRequestNumber?: number;
  } = {},
): Promise<void> {
  const helpers = createArtifactHelpers({ root: workspaceRoot });
  await helpers.writeOutputArtifact(devArtifact, {
    taskKey: 'NEX-1',
    profile: 'dev-a',
    status: 'completed',
    baseRevision,
    headRevision,
    summary: 'Implemented the retry guard.',
    findingResponses: options.findingResponses ?? [],
  });
  await helpers.writeOutputArtifact(verificationArtifact, {
    headRevision,
    status: 'passed',
    checks: [
      {
        name: 'validate',
        exitCode: 0,
        stdoutPath: 'checks/0/stdout.log',
        stderrPath: 'checks/0/stderr.log',
      },
    ],
  });
  await helpers.writeOutputArtifact(deliveryArtifact, {
    repository,
    pullRequestNumber: options.pullRequestNumber ?? 7,
    pullRequestUrl: `https://github.com/${repository}/pull/${options.pullRequestNumber ?? 7}`,
    headRevision,
  });
}

/** Write one artifact document into an earlier round, as that round's producer did. */
async function writeRoundArtifact(
  workspaceRoot: string,
  round: number,
  name: string,
  content: unknown,
): Promise<void> {
  const directory = path.join(workspaceRoot, 'artifacts', String(round));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

/** Read one round artifact document. */
async function readRoundArtifact(
  workspaceRoot: string,
  round: number,
  name: string,
): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(workspaceRoot, 'artifacts', String(round), name), 'utf8'),
  ) as unknown;
}

/** The current-round disposition input section of one review context. */
function dispositionInputSection(context: string): string {
  const start = context.indexOf('Current-round prior findings to dispose of');
  if (start < 0) {
    return '';
  }
  const end = context.indexOf('\n\nDeveloper responses to those findings', start);
  return context.slice(start, end < 0 ? context.length : end);
}

const taskIssue = {
  id: '1',
  key: 'NEX-1',
  fields: {
    summary: 'Implement the retry guard',
    description: { type: 'doc', content: [] },
    status: { id: '2', name: 'In Review' },
  },
};

const blockingFinding: Finding = {
  id: 'NEX-1-finding-1',
  title: 'Transient provider failures are not retried',
  severity: 'blocking',
  basis: 'The design requires a transient provider failure to be retried once.',
  evidence: 'The failing call returns immediately and no second attempt appears in the log.',
  impact: 'A transient failure leaves the work unfinished.',
  repairGuidance: 'Retry the provider call once before reporting the failure.',
  locations: [{ path: 'src/queue.ts', line: 42 }],
};

/** One review result for the reviewed head. */
function reviewOutput(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    profile: 'reviewer',
    headRevision,
    verdict: 'approved',
    summary: 'The change matches the task.',
    findings: [],
    priorFindings: [],
    ...overrides,
  };
}

/** One check observation for the reviewed head; the default is the completed Nexus Lens result. */
function lensCheck(overrides: Partial<CheckObservation> = {}): CheckObservation {
  return {
    id: 12,
    revision: headRevision,
    name: reviewCheck,
    producer: { id: lensAppId, slug: 'nexus-lens', name: 'Nexus Lens' },
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

/** One review observation; the default is the Nexus Lens approval of the report. */
function submittedReview(
  report: ReviewOutput,
  overrides: Partial<GitHubReview> = {},
): GitHubReview {
  return {
    id: 11,
    state: 'APPROVED',
    body: report.summary,
    commit_id: report.headRevision,
    author: lensLogin,
    ...overrides,
  };
}

/** The ticket comment document Review publishes for one review result. */
function expectedComment(review: ReviewOutput): JiraDocument {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: [
              `profile: ${review.profile}`,
              `Review verdict: ${review.verdict}.`,
              review.summary,
              ...review.findings.map((finding) => `- ${finding.title}: ${finding.repairGuidance}`),
            ].join('\n'),
          },
        ],
      },
    ],
  };
}

/** The action under test, bound to the controlled runtime and source. */
function reviewAction(options: {
  readonly selectionFile: string;
  readonly runner: AgentRoleRunner;
  readonly git: ReturnType<typeof scriptedGit>['git'];
  readonly github: ReturnType<typeof scriptedGitHub>['github'];
  readonly jira?: ReturnType<typeof scriptedJira>['jira'];
}): ReturnType<typeof createReview> {
  return createReview({
    selectionFile: options.selectionFile,
    repository,
    reviewCheck,
    nexusLens: { appId: lensAppId, login: lensLogin },
    reviewerProfile: 'nexus-review',
    runner: options.runner,
    git: options.git,
    github: options.github,
    publish: (event) => events.push(event),
  });
}

describe('Review', () => {
  it('reviews the delivered revision and publishes the verdict for exactly that head', async () => {
    const { workspaceRoot, selectionFile, round } = await workspace();
    await writeDeliveredRound(workspaceRoot);
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        verdict: 'approved',
        summary: 'The change matches the task and the check covers it.',
        findings: [],
        priorFindings: [],
      }),
    );
    const { git, calls: gitCalls } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('diff --git a/feature.txt b/feature.txt\n+feature\n'),
    });
    const { github, calls: githubCalls } = scriptedGitHub({
      readConversation: () =>
        ok({
          comments: [{ id: 1, body: 'Human pull-request discussion.' }],
          reviews: [],
          reviewComments: [],
        }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    const { jira } = scriptedJira({
      readIssue: () => ok(taskIssue),
      readComments: () =>
        ok([
          { id: 'c1', body: 'Original request.' },
          { id: 'c2', body: 'Human clarification.' },
        ]),
      addComment: (_issueId, body) => ok({ id: 'c9', body }),
    });
    const review = reviewAction({ selectionFile, runner: runnerOf(runtime), git, github, jira });

    await expect(review()).resolves.toBe('approved');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.profile).toBe('nexus-review');
    expect(requests[0]?.workspaceRoot).toBe(workspaceRoot);
    // The action asks the provider for its own ReviewResponse shape, derived from the schema that
    // will validate the returned report, and the provider's strict structured-output requirements
    // hold for what it is given.
    expect(requests[0]?.outputSchema).toEqual(z.toJSONSchema(reviewResponseSchema));
    expect(strictSchemaProblems(requests[0]?.outputSchema)).toEqual([]);
    const context = requests[0]?.context ?? '';
    expect(context).toContain('Implement the retry guard');
    expect(context).toContain('Human pull-request discussion.');
    expect(context).toContain(
      `Reviewed revision: ${headRevision} (comparison base ${baseRevision})`,
    );
    expect(context).toContain(`Comparison diff ${baseRevision}..${headRevision}:`);
    expect(context).toContain('+feature');
    expect(context).toContain('Implemented the retry guard.');
    // No review precedes the first round: the disposition input states the empty eligible set and
    // the current development result carries no responses.
    expect(context).toContain(
      'Current-round prior findings to dispose of: none; no review precedes this round.',
    );
    expect(context).toContain('Eligible prior finding IDs: none.');
    expect(context).toContain(
      'Developer responses to those findings (complete values from the current development ' +
        'result):\n[]',
    );
    expect(context).toContain('Return exactly one JSON object with this shape');
    expect(context).toContain('priorFindings');

    const recorded = (await readRoundArtifact(workspaceRoot, round, 'review.json')) as ReviewOutput;
    expect(recorded).toEqual({
      taskSubject: 'Implement the retry guard',
      profile: 'nexus-review',
      headRevision,
      verdict: 'approved',
      summary: 'The change matches the task and the check covers it.',
      findings: [],
      priorFindings: [],
    });
    expect(gitCalls).toEqual([
      path.join(workspaceRoot, 'worktree'),
      `diff:${baseRevision}..${headRevision}`,
      path.join(workspaceRoot, 'worktree'),
    ]);
    expect(githubCalls).toEqual([
      'conversation:7',
      `readChecks:${headRevision}`,
      `publishReview:7@${headRevision}:approved`,
      `publishCheck:${headRevision}:${reviewCheck}:success`,
    ]);
    // The parent-owned boundary refreshed the selection; the action leaves the retained record
    // and saves the complete pull-request conversation in the round's local artifacts.
    expect(JSON.parse(await readFile(selectionFile, 'utf8'))).toEqual({
      taskKey: 'NEX-1',
      source: { kind: 'jira', issueId: '1' },
      task: {
        id: '1',
        key: 'NEX-1',
        fields: { summary: 'Implement the retry guard', description: { type: 'doc', content: [] } },
      },
      conversation: [{ id: 'c1', body: 'Original request.' }],
      workspace: { root: workspaceRoot },
      stage: 'delivery',
    });
    expect(await readRoundArtifact(workspaceRoot, round, 'pr-conversation.json')).toEqual({
      comments: [{ id: 1, body: 'Human pull-request discussion.' }],
      reviews: [],
      reviewComments: [],
    });
    // The saved report is what the outcome event references; the invocation boundaries belong to
    // the caller's agent runner, not to the action.
    expect(events).toEqual([
      {
        source: 'review',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round,
          outcome: 'approved',
          detail: 'profile nexus-review',
          artifact: { path: path.join(workspaceRoot, 'artifacts', String(round), 'review.json') },
        },
      },
    ]);
  });

  it('saves a reported location whose strict-shape null line means the location has no line', async () => {
    const { workspaceRoot, selectionFile, round } = await workspace({ name: 'no-line' });
    await writeDeliveredRound(workspaceRoot);
    const { runtime } = scriptedRuntime(() =>
      JSON.stringify({
        verdict: 'changesRequested',
        summary: 'The unguarded behavior reaches production.',
        findings: [
          {
            ...blockingFinding,
            locations: [{ path: 'feature.txt', line: null }],
          },
        ],
        priorFindings: [],
      }),
    );
    const { git } = scriptedGit([repositoryState({ headRevision })], { readDiff: () => ok('') });
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 13, url: `https://github.com/${repository}/reviews/13` }),
      publishReviewCheck: () => ok({ id: 14 }),
    });
    const { jira } = scriptedJira({
      readIssue: () => ok(taskIssue),
      readComments: () => ok([]),
      addComment: (_issueId, body) => ok({ id: 'c9', body }),
    });
    const review = reviewAction({ selectionFile, runner: runnerOf(runtime), git, github, jira });

    await expect(review()).resolves.toBe('changesRequested');

    // The provider schema requires the line; the Finding contract stores the location without it.
    const recorded = (await readRoundArtifact(workspaceRoot, round, 'review.json')) as ReviewOutput;
    expect(recorded.findings).toEqual([
      { ...blockingFinding, locations: [{ path: 'feature.txt' }] },
    ]);
  });

  it('evaluates the preceding findings against the complete developer responses', async () => {
    const { workspaceRoot, selectionFile, round } = await workspace({
      round: 2,
      name: 'repair',
    });
    await writeRoundArtifact(
      workspaceRoot,
      1,
      'review.json',
      reviewOutput({
        verdict: 'changesRequested',
        summary: 'The retry guard is missing.',
        findings: [blockingFinding],
      }),
    );
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'First implementation.',
      findingResponses: [],
    });
    await writeDeliveredRound(workspaceRoot, {
      findingResponses: [
        {
          findingId: blockingFinding.id,
          status: 'addressed',
          response: 'Added the retry with a regression test.',
        },
      ],
    });
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        verdict: 'approved',
        summary: 'The retry guard is present now.',
        findings: [],
        priorFindings: [
          {
            findingId: blockingFinding.id,
            disposition: 'resolved',
            reason: 'The retry and its regression test are present in the reviewed revision.',
          },
        ],
      }),
    );
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('diff --git a/src/queue.ts b/src/queue.ts\n+retry\n'),
    });
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: 'https://github.com/owner/repository/reviews/11' }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    const { jira } = scriptedJira({
      readIssue: () => ok(taskIssue),
      readComments: () => ok([]),
      addComment: (_issueId, body) => ok({ id: 'c9', body }),
    });
    const review = reviewAction({ selectionFile, runner: runnerOf(runtime), git, github, jira });

    await expect(review()).resolves.toBe('approved');

    const context = requests[0]?.context ?? '';
    const input = dispositionInputSection(context);
    // The disposition input is the preceding review's findings array alone, with the exact
    // eligible IDs; the review's verdict, summary and own dispositions stay out of it.
    expect(input).toContain('complete Finding values: the findings array of the round 1 review');
    expect(context).toContain(`Eligible prior finding IDs: "${blockingFinding.id}".`);
    for (const value of [
      blockingFinding.id,
      blockingFinding.title,
      blockingFinding.basis,
      blockingFinding.evidence,
      blockingFinding.impact,
      blockingFinding.repairGuidance,
      `"path": "${blockingFinding.locations[0]?.path ?? ''}"`,
    ]) {
      expect(input).toContain(value);
    }
    expect(input).not.toContain('"verdict"');
    expect(input).not.toContain('"priorFindings"');
    // The matching developer responses accompany that set.
    expect(context).toContain('Developer responses to those findings');
    expect(context).toContain('Added the retry with a regression test.');
    // The complete earlier report remains available as historical evidence.
    expect(context).toContain(path.join(workspaceRoot, 'artifacts', '1', 'review.json'));
    expect(await readRoundArtifact(workspaceRoot, round, 'review.json')).toMatchObject({
      profile: 'nexus-review',
      headRevision,
      verdict: 'approved',
      priorFindings: [
        {
          findingId: blockingFinding.id,
          disposition: 'resolved',
          reason: 'The retry and its regression test are present in the reviewed revision.',
        },
      ],
    });
  });

  it('preserves unusable retained development and review history under its producers', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ round: 2, name: 'retained' });
    await writeDeliveredRound(workspaceRoot);
    const scopeOf = (role: 'developer' | 'reviewer', reportKind: string) => ({
      project: projectOfWorkspace(workspaceRoot),
      workId: 'NEX-1',
      area: workspaceRoot,
      role,
      reportKind,
    });
    const reviewerScope = scopeOf('reviewer', 'review');
    const developerScope = scopeOf('developer', 'development');
    const unreachable = () => {
      throw new Error('The reviewer must not run while the retained history is unusable.');
    };
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });

    // Round one's review report is unusable: the malformed record is preserved under the
    // reviewer's responsibility instead of failing without evidence.
    const reviewFile = path.join(workspaceRoot, 'artifacts', '1', 'review.json');
    const malformedReview = '{"verdict":"changesRequested",';
    await mkdir(path.dirname(reviewFile), { recursive: true });
    await writeFile(reviewFile, malformedReview, 'utf8');
    const { git: reviewGit } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('diff --git a/feature.txt b/feature.txt\n+feature\n'),
    });
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf({ run: unreachable }),
        git: reviewGit,
        github,
      })(),
    ).rejects.toThrow(/is not valid JSON/);
    const retainedReview = (await readReportFeedback(workspaceRoot)).find(
      (entry) => entry.record.kind === 'rejection' && entry.record.scope.role === 'reviewer',
    );
    expect(retainedReview?.record).toMatchObject({
      scope: reviewerScope,
      operation: 'review',
      source: { path: reviewFile },
      output: malformedReview,
      reason: expect.stringContaining('is not valid JSON'),
    });

    // Round one's development report is unusable too: it is preserved under the developer's
    // responsibility, separately attributable from the reviewer's rejection.
    await writeRoundArtifact(
      workspaceRoot,
      1,
      'review.json',
      reviewOutput({ verdict: 'approved', summary: 'The earlier revision looked right.' }),
    );
    const developmentFile = path.join(workspaceRoot, 'artifacts', '1', 'development.json');
    const malformedDevelopment = '{"status":"completed",';
    await writeFile(developmentFile, malformedDevelopment, 'utf8');
    const { git: developmentGit } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('diff --git a/feature.txt b/feature.txt\n+feature\n'),
    });
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf({ run: unreachable }),
        git: developmentGit,
        github,
      })(),
    ).rejects.toThrow(/is not valid JSON/);
    const retainedDevelopment = (await readReportFeedback(workspaceRoot)).find(
      (entry) => entry.record.kind === 'rejection' && entry.record.scope.role === 'developer',
    );
    expect(retainedDevelopment?.record).toMatchObject({
      scope: developerScope,
      operation: 'develop',
      source: { path: developmentFile },
      output: malformedDevelopment,
      reason: expect.stringContaining('is not valid JSON'),
    });

    // The repaired history does not resolve either rejection; the next permitted review receives
    // both and its validated saved verdict records the corrections.
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'The repaired round-one report.',
      findingResponses: [],
    });
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        verdict: 'approved',
        summary: 'The change matches the task.',
        findings: [],
        priorFindings: [],
      }),
    );
    const { git: completedGit } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('diff --git a/feature.txt b/feature.txt\n+feature\n'),
    });
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(runtime),
        git: completedGit,
        github,
      })(),
    ).resolves.toBe('approved');
    const context = requests[0]?.context ?? '';
    expect(context).toContain('Outstanding report rejection');
    expect(context).toContain(malformedReview);
    expect(context).toContain(reviewFile);
    // The developer's rejection stays attributable to the developer's responsibility: this review
    // never inherits it, and its validated verdict retires only the reviewer's rejection.
    expect(context).not.toContain(malformedDevelopment);
    await expect(
      outstandingReportFeedback({ areaRoot: workspaceRoot, scope: reviewerScope }),
    ).resolves.toEqual([]);
    const developerOutstanding = await outstandingReportFeedback({
      areaRoot: workspaceRoot,
      scope: developerScope,
    });
    expect(developerOutstanding).toHaveLength(1);
    expect(developerOutstanding[0]?.record).toMatchObject({
      source: { path: developmentFile },
      output: malformedDevelopment,
      reason: expect.stringContaining('is not valid JSON'),
    });
  });

  it('treats resolved history as evidence and accepts a recurrence under the stable finding ID', async () => {
    const { workspaceRoot, selectionFile, round } = await workspace({
      round: 3,
      name: 'recurrence',
    });
    // Round 1 reported the defect, round 2 resolved it, and round 3's revision brings it back.
    await writeRoundArtifact(
      workspaceRoot,
      1,
      'review.json',
      reviewOutput({
        verdict: 'changesRequested',
        summary: 'The guard is missing.',
        findings: [blockingFinding],
      }),
    );
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'First implementation.',
      findingResponses: [],
    });
    await writeRoundArtifact(
      workspaceRoot,
      2,
      'review.json',
      reviewOutput({
        verdict: 'approved',
        summary: 'The guard is present.',
        findings: [],
        priorFindings: [
          {
            findingId: blockingFinding.id,
            disposition: 'resolved',
            reason: 'The guard and its regression test are present in the reviewed revision.',
          },
        ],
      }),
    );
    await writeDeliveredRound(workspaceRoot);
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        verdict: 'changesRequested',
        summary: 'The guard is missing again on the current revision.',
        findings: [blockingFinding],
        priorFindings: [],
      }),
    );
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('diff --git a/src/queue.ts b/src/queue.ts\n-guard\n'),
    });
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    const { jira } = scriptedJira({
      readIssue: () => ok(taskIssue),
      readComments: () => ok([]),
      addComment: (_issueId, body) => ok({ id: 'c9', body }),
    });
    const review = reviewAction({ selectionFile, runner: runnerOf(runtime), git, github, jira });

    await expect(review()).resolves.toBe('changesRequested');

    const context = requests[0]?.context ?? '';
    // The preceding review's findings array is empty, so no disposition is requested even though
    // the resolved finding still appears in the retained history.
    expect(context).toContain(
      'Current-round prior findings to dispose of (complete Finding values: the findings array of ' +
        'the round 2 review):\n[]',
    );
    expect(context).toContain('Eligible prior finding IDs: none.');
    expect(dispositionInputSection(context)).not.toContain(blockingFinding.id);
    // The complete earlier reports remain available as historical evidence.
    expect(context).toContain(path.join(workspaceRoot, 'artifacts', '1', 'review.json'));
    expect(context).toContain(path.join(workspaceRoot, 'artifacts', '2', 'review.json'));
    // The recurrent defect returns under its stable ID without an out-of-set disposition.
    expect(await readRoundArtifact(workspaceRoot, round, 'review.json')).toMatchObject({
      profile: 'nexus-review',
      headRevision,
      verdict: 'changesRequested',
      findings: [blockingFinding],
      priorFindings: [],
    });
  });

  it('rejects unusable or inconsistent reports as execution errors', async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly expected: RegExp;
      readonly output: string;
      /**
       * 'open': the preceding review's findings still carry the blocking finding. 'resolved': an
       * earlier review resolved it, so the preceding review's findings array is empty.
       */
      readonly history?: 'open' | 'resolved';
    }> = [
      {
        label: 'output that is not JSON',
        expected: /unusable output/,
        output: 'not a JSON report',
      },
      {
        label: 'a report outside the response format',
        expected: /does not match the response format/,
        output: JSON.stringify({ verdict: 'done', summary: 'Finished.' }),
      },
      {
        label: 'the removed inconclusive verdict',
        expected: /does not match the response format/,
        output: JSON.stringify({
          verdict: 'inconclusive',
          summary: 'The available evidence could not settle the assessment.',
          findings: [],
          priorFindings: [],
        }),
      },
      {
        label: 'approval with a current blocking finding',
        expected: /approved the revision while reporting blocking finding/,
        output: JSON.stringify({
          verdict: 'approved',
          summary: 'Looks fine.',
          findings: [blockingFinding],
          priorFindings: [],
        }),
      },
      {
        label: 'a changes-requested verdict without a blocking finding',
        expected: /requested changes without a current blocking finding/,
        output: JSON.stringify({
          verdict: 'changesRequested',
          summary: 'There is a problem.',
          findings: [],
          priorFindings: [],
        }),
      },
      {
        label: 'a missing prior disposition',
        expected: /did not dispose of prior finding/,
        output: JSON.stringify({
          verdict: 'approved',
          summary: 'Looks fine.',
          findings: [],
          priorFindings: [],
        }),
        history: 'open',
      },
      {
        label: 'an unknown prior finding',
        expected: /unknown prior finding/,
        output: JSON.stringify({
          verdict: 'approved',
          summary: 'Looks fine.',
          findings: [],
          priorFindings: [{ findingId: 'other', disposition: 'resolved', reason: 'Fixed.' }],
        }),
      },
      {
        label: 'an open disposition without the current finding',
        expected: /open without reporting it/,
        output: JSON.stringify({
          verdict: 'approved',
          summary: 'Looks fine.',
          findings: [],
          priorFindings: [
            { findingId: blockingFinding.id, disposition: 'open', reason: 'Still present.' },
          ],
        }),
        history: 'open',
      },
      {
        label: 'a resolved finding still in the current findings',
        expected: /still in findings/,
        output: JSON.stringify({
          verdict: 'changesRequested',
          summary: 'Still present.',
          findings: [blockingFinding],
          priorFindings: [
            { findingId: blockingFinding.id, disposition: 'resolved', reason: 'Supposedly fixed.' },
          ],
        }),
        history: 'open',
      },
      {
        label: 'a duplicate prior disposition',
        expected: /more than once/,
        output: JSON.stringify({
          verdict: 'approved',
          summary: 'Looks fine.',
          findings: [],
          priorFindings: [
            { findingId: blockingFinding.id, disposition: 'resolved', reason: 'Fixed.' },
            { findingId: blockingFinding.id, disposition: 'open', reason: 'Still present.' },
          ],
        }),
        history: 'open',
      },
      {
        label: 'the same current finding reported twice',
        expected: /more than once/,
        output: JSON.stringify({
          verdict: 'changesRequested',
          summary: 'Both occurrences are present.',
          findings: [blockingFinding, blockingFinding],
          priorFindings: [],
        }),
      },
      {
        label: 'a disposition for a finding resolved in an earlier round',
        expected: /unknown prior finding/,
        output: JSON.stringify({
          verdict: 'approved',
          summary: 'Looks fine.',
          findings: [],
          priorFindings: [
            {
              findingId: blockingFinding.id,
              disposition: 'resolved',
              reason: 'The guard is present in the reviewed revision.',
            },
          ],
        }),
        history: 'resolved',
      },
      {
        label: 'a location that leaves out the line the strict response shape requires',
        expected: /does not match the response format/,
        output: JSON.stringify({
          verdict: 'changesRequested',
          summary: 'The guard is still missing.',
          findings: [{ ...blockingFinding, locations: [{ path: 'src/queue.ts' }] }],
          priorFindings: [],
        }),
      },
    ];

    for (const testCase of cases) {
      events = [];
      const round = testCase.history === 'open' ? 2 : testCase.history === 'resolved' ? 3 : 1;
      const name = `case-${round}-${testCase.label.replaceAll(/[^a-z]+/giu, '-')}`;
      const { workspaceRoot, selectionFile } = await workspace({ round, name });
      if (testCase.history !== undefined) {
        await writeRoundArtifact(
          workspaceRoot,
          1,
          'review.json',
          reviewOutput({
            verdict: 'changesRequested',
            findings: [blockingFinding],
          }),
        );
      }
      if (testCase.history === 'resolved') {
        await writeRoundArtifact(
          workspaceRoot,
          2,
          'review.json',
          reviewOutput({
            verdict: 'approved',
            findings: [],
            priorFindings: [
              {
                findingId: blockingFinding.id,
                disposition: 'resolved',
                reason: 'The guard is present in the reviewed revision.',
              },
            ],
          }),
        );
      }
      await writeDeliveredRound(workspaceRoot);
      const { runtime, requests } = scriptedRuntime(() => testCase.output);
      const { git } = scriptedGit([repositoryState({ headRevision })], {
        readDiff: () => ok(''),
      });
      const { github } = scriptedGitHub({
        readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      });
      const { jira } = scriptedJira({
        readIssue: () => ok(taskIssue),
        readComments: () => ok([]),
      });
      const review = reviewAction({ selectionFile, runner: runnerOf(runtime), git, github, jira });

      await expect(review(), testCase.label).rejects.toThrow(testCase.expected);
      // The requested structured-output schema never replaces the action's own validation.
      expect(requests[0]?.outputSchema, testCase.label).toEqual(
        z.toJSONSchema(reviewResponseSchema),
      );
      await expect(
        stat(path.join(workspaceRoot, 'artifacts', String(round), 'review.json')),
        testCase.label,
      ).rejects.toThrow(/ENOENT/);
    }
  });

  it('does not review a worktree or a turn that changed the delivered revision', async () => {
    const moved = await workspace({ name: 'moved' });
    await writeDeliveredRound(moved.workspaceRoot);
    const movedGit = scriptedGit([repositoryState({ headRevision: otherRevision })]);
    const movedReview = reviewAction({
      selectionFile: moved.selectionFile,
      runner: runnerOf(unusedRuntime()),
      git: movedGit.git,
      github: scriptedGitHub({}).github,
      jira: scriptedJira({}).jira,
    });
    await expect(movedReview()).rejects.toThrow(/not the delivered/);

    events = [];
    const edited = await workspace({ name: 'edited' });
    await writeDeliveredRound(edited.workspaceRoot);
    const { runtime } = scriptedRuntime(() =>
      JSON.stringify({
        verdict: 'approved',
        summary: 'Looks fine.',
        findings: [],
        priorFindings: [],
      }),
    );
    const editedGit = scriptedGit(
      [repositoryState({ headRevision }), repositoryState({ headRevision, trackedChanges: true })],
      { readDiff: () => ok('') },
    );
    const editedReview = reviewAction({
      selectionFile: edited.selectionFile,
      runner: runnerOf(runtime),
      git: editedGit.git,
      github: scriptedGitHub({
        readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      }).github,
      jira: scriptedJira({ readIssue: () => ok(taskIssue), readComments: () => ok([]) }).jira,
    });
    await expect(editedReview()).rejects.toThrow(/tracked changes/);
    await expect(
      stat(path.join(edited.workspaceRoot, 'artifacts', '1', 'review.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('reuses the saved report for the delivered head and publishes only the missing part', async () => {
    const saved = reviewOutput({ verdict: 'approved', summary: 'Looks fine.' });

    // The Lens review and its Lens check are published: only the ticket comment is inspected.
    const finished = await workspace({ name: 'finished' });
    await writeDeliveredRound(finished.workspaceRoot);
    const finishedHelpers = createArtifactHelpers({ root: finished.workspaceRoot });
    await finishedHelpers.writeOutputArtifact(reviewArtifact, saved);
    const finishedHub = scriptedGitHub({
      readConversation: () =>
        ok({ comments: [], reviews: [submittedReview(saved)], reviewComments: [] }),
      readChecks: () => ok([lensCheck()]),
    });
    const { jira: finishedJira, calls: finishedJiraCalls } = scriptedJira({
      readComments: () => ok([{ id: 'c1', body: expectedComment(saved) }]),
    });
    await expect(
      reviewAction({
        selectionFile: finished.selectionFile,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github: finishedHub.github,
        jira: finishedJira,
      })(),
    ).resolves.toBe('approved');
    expect(finishedHub.calls).toEqual(['conversation:7', `readChecks:${headRevision}`]);
    expect(finishedJiraCalls).toEqual([]);
    // The reused report is the saved output the outcome event references.
    expect(events).toEqual([
      {
        source: 'review',
        type: 'outcome',
        data: {
          task: 'NEX-1',
          round: 1,
          outcome: 'approved',
          detail: `profile ${saved.profile}`,
          artifact: {
            path: path.join(finished.workspaceRoot, 'artifacts', '1', 'review.json'),
          },
        },
      },
    ]);

    // The review was published but its check failed: repeating finishes the check alone.
    events = [];
    const unfinished = await workspace({ name: 'unfinished' });
    await writeDeliveredRound(unfinished.workspaceRoot);
    const unfinishedHelpers = createArtifactHelpers({ root: unfinished.workspaceRoot });
    await unfinishedHelpers.writeOutputArtifact(reviewArtifact, saved);
    const unfinishedHub = scriptedGitHub({
      readConversation: () =>
        ok({ comments: [], reviews: [submittedReview(saved)], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    const unfinishedJira = scriptedJira({
      readComments: () => ok([]),
      addComment: (_issueId, body) => ok({ id: 'c9', body }),
    });
    await expect(
      reviewAction({
        selectionFile: unfinished.selectionFile,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github: unfinishedHub.github,
        jira: unfinishedJira.jira,
      })(),
    ).resolves.toBe('approved');
    expect(unfinishedHub.calls).toEqual([
      'conversation:7',
      `readChecks:${headRevision}`,
      `publishCheck:${headRevision}:${reviewCheck}:success`,
    ]);
    expect(unfinishedJira.calls).toEqual([]);

    // An earlier report for the same head and conclusion published the Lens check and a different
    // review: the saved report's review is published and the matching check is left alone.
    events = [];
    const different = await workspace({ name: 'different' });
    await writeDeliveredRound(different.workspaceRoot);
    const differentHelpers = createArtifactHelpers({ root: different.workspaceRoot });
    await differentHelpers.writeOutputArtifact(reviewArtifact, saved);
    const differentHub = scriptedGitHub({
      readConversation: () =>
        ok({
          comments: [],
          reviews: [submittedReview(saved, { body: 'An earlier report for the same head.' })],
          reviewComments: [],
        }),
      readChecks: () => ok([lensCheck()]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
    });
    const differentJira = scriptedJira({
      readComments: () => ok([]),
      addComment: (_issueId, body) => ok({ id: 'c9', body }),
    });
    await expect(
      reviewAction({
        selectionFile: different.selectionFile,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github: differentHub.github,
        jira: differentJira.jira,
      })(),
    ).resolves.toBe('approved');
    expect(differentHub.calls).toEqual([
      'conversation:7',
      `readChecks:${headRevision}`,
      `publishReview:7@${headRevision}:approved`,
    ]);
    expect(differentJira.calls).toEqual([]);
  });

  it('does not treat a same-name check or another author as the Nexus Lens publication', async () => {
    const saved = reviewOutput({ verdict: 'approved', summary: 'Looks fine.' });
    const otherAppCheck = lensCheck({
      id: 21,
      producer: { id: 4242, slug: 'other-app', name: 'Other App' },
    });
    const unownedCheck = lensCheck({ id: 22, producer: null });
    const incompleteLensCheck = lensCheck({ status: 'in_progress' });
    const mismatchedLensCheck = lensCheck({ id: 23, conclusion: 'failure' });
    const { workspaceRoot, selectionFile } = await workspace({ name: 'foreign-publications' });
    await writeDeliveredRound(workspaceRoot);
    const helpers = createArtifactHelpers({ root: workspaceRoot });
    await helpers.writeOutputArtifact(reviewArtifact, saved);
    const { github, calls: githubCalls } = scriptedGitHub({
      readConversation: () =>
        ok({
          comments: [],
          reviews: [submittedReview(saved, { author: 'someone-else' })],
          reviewComments: [],
        }),
      readChecks: () => ok([otherAppCheck, unownedCheck, incompleteLensCheck, mismatchedLensCheck]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    scriptedJira({
      readComments: () => ok([]),
      addComment: (_issueId, body) => ok({ id: 'c9', body }),
    });

    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github,
      })(),
    ).resolves.toBe('approved');

    // A same-name success from another App, an unowned success, a Lens check without a completed
    // status and a completed Lens check for another conclusion are not this report's check; an
    // approval by another author is not its review.
    expect(githubCalls).toEqual([
      'conversation:7',
      `readChecks:${headRevision}`,
      `publishReview:7@${headRevision}:approved`,
      `publishCheck:${headRevision}:${reviewCheck}:success`,
    ]);
  });

  it('never applies a recorded approval to a later delivered head', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ name: 'later' });
    await writeDeliveredRound(workspaceRoot);
    const helpers = createArtifactHelpers({ root: workspaceRoot });
    await helpers.writeOutputArtifact(
      reviewArtifact,
      reviewOutput({ headRevision: otherRevision, verdict: 'approved' }),
    );
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        verdict: 'changesRequested',
        summary: 'The later revision still misses a retry.',
        findings: [blockingFinding],
        priorFindings: [],
      }),
    );
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok(''),
    });
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: 'https://github.com/owner/repository/reviews/11' }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    const { jira } = scriptedJira({
      readIssue: () => ok(taskIssue),
      readComments: () => ok([]),
      addComment: (_issueId, body) => ok({ id: 'c9', body }),
    });

    await expect(
      reviewAction({ selectionFile, runner: runnerOf(runtime), git, github, jira })(),
    ).resolves.toBe('changesRequested');

    expect(requests).toHaveLength(1);
    expect(await readRoundArtifact(workspaceRoot, 1, 'review.json')).toMatchObject({
      headRevision,
      verdict: 'changesRequested',
    });
  });

  it('fails a saved report carrying the removed inconclusive verdict without translating it', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ name: 'removed-verdict' });
    await writeDeliveredRound(workspaceRoot);
    // A report from the removed verdict is not an absent report, an approval or a revision to
    // re-review: its read fails validation and the action faults.
    await writeRoundArtifact(workspaceRoot, 1, 'review.json', {
      profile: 'reviewer',
      headRevision,
      verdict: 'inconclusive',
      summary: 'The provider behaviour cannot be reproduced from the available evidence.',
      findings: [],
      priorFindings: [],
    });

    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github: scriptedGitHub({}).github,
      })(),
    ).rejects.toThrow(/does not match its declared content type/);
    // The saved report is preserved as written; no translation rewrote its verdict.
    expect(await readRoundArtifact(workspaceRoot, 1, 'review.json')).toMatchObject({
      verdict: 'inconclusive',
      headRevision,
    });
  });
});
