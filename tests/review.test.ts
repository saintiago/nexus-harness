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
import { reviewerRoleInstructions, type AgentRuntime } from '../src/agent-runtime/index.js';
import type { CheckObservation, GitHubReview } from '../src/adapters/github.js';
import type { JiraDocument } from '../src/adapters/jira.js';
import { parseNexusConfiguration } from '../src/configuration/index.js';
import { ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { deliveryArtifact } from '../src/task-engine/actions/deliver/artifacts.js';
import { devArtifact } from '../src/task-engine/actions/develop/artifacts.js';
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
import { composedRunner, runnerOf } from './support/agent-runner.js';
import { nexusConfiguration } from './support/configuration.js';
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

/** How often the text contains the part. */
function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

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
    expect(context).toContain(
      `Comparison diff ${baseRevision}..${headRevision} (orientation only;`,
    );
    expect(context).toContain('+feature');
    expect(context).toContain('Implemented the retry guard.');
    // The diff is orientation, not a scope boundary, and no previous review exists to consult.
    expect(context).toContain('task-relevant pre-existing code outside this range is in scope');
    expect(context).not.toContain('Previous review report');
    expect(context).toContain('Return exactly one JSON object with this shape');
    expect(context).not.toContain('priorFindings');
    expect(context).not.toContain('findingResponses');

    const recorded = (await readRoundArtifact(workspaceRoot, round, 'review.json')) as ReviewOutput;
    expect(recorded).toEqual({
      taskSubject: 'Implement the retry guard',
      profile: 'nexus-review',
      headRevision,
      verdict: 'approved',
      summary: 'The change matches the task and the check covers it.',
      findings: [],
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

  it('delivers the reviewer coherence obligations with the complete review context', async () => {
    const configuration = parseNexusConfiguration(nexusConfiguration(), '/etc/nexus/installation');
    const { workspaceRoot, selectionFile } = await workspace();
    await writeDeliveredRound(workspaceRoot);
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('diff --git a/feature.txt b/feature.txt\n+feature\n'),
    });
    const { github } = scriptedGitHub({
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
    const { runner, requests } = composedRunner(configuration, 'reviewer', () =>
      JSON.stringify({
        verdict: 'approved',
        summary: 'The change matches the task and the check covers it.',
        findings: [],
      }),
    );
    const review = reviewAction({ selectionFile, runner, git, github, jira });

    await expect(review()).resolves.toBe('approved');

    const prompt = requests[0]!.prompt;
    for (const obligation of [
      "Apply the project's existing design and ownership principles",
      'Inspect whether the resulting',
      'superseded rules or mechanisms',
      'confirm any shared ownership cause',
      'Accept adequate work and keep optional suggestions distinct',
      'no extra attempts or bypass of revision-bound review, merge or check gates',
    ]) {
      expect(occurrences(prompt, obligation), obligation).toBe(1);
    }
    expect(occurrences(prompt, reviewerRoleInstructions.join('\n\n'))).toBe(1);
    // The complete task, conversation and revision-bound evidence reach the provider once.
    expect(prompt).toContain('Task NEX-1:');
    expect(prompt).toContain('Implement the retry guard');
    expect(prompt).toContain('Complete task conversation');
    expect(prompt).toContain('Original request.');
    expect(prompt).toContain('Complete pull-request conversation');
    expect(prompt).toContain('Human pull-request discussion.');
    expect(prompt).toContain(
      `Reviewed revision: ${headRevision} (comparison base ${baseRevision})`,
    );
    expect(prompt).toContain('Implemented the retry guard.');
    expect(prompt).toContain('task-relevant pre-existing code outside this range is in scope');
    expect(prompt).toContain('Return exactly one JSON object with this shape');
    expect(requests[0]!.directory).toBe(path.join(workspaceRoot, 'worktree'));
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

  it('carries the preceding review and developer narrative into the repair assessment', async () => {
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
    });
    await writeDeliveredRound(workspaceRoot);
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        verdict: 'approved',
        summary: 'The retry guard is present now.',
        findings: [],
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
    // The previous review's complete report is context: its verdict, summary and finding evidence
    // reach the reviewer without an eligible-ID set, response array or disposition request.
    expect(context).toContain('Previous review report (round 1; judge whether its concerns remain');
    for (const value of [
      blockingFinding.title,
      blockingFinding.basis,
      blockingFinding.evidence,
      blockingFinding.impact,
      blockingFinding.repairGuidance,
      `"path": "${blockingFinding.locations[0]?.path ?? ''}"`,
    ]) {
      expect(context).toContain(value);
    }
    expect(context).not.toContain('Eligible prior finding IDs');
    expect(context).not.toContain('priorFindings');
    // The current development result carries the developer's narrative, not per-finding answers.
    expect(context).toContain('Implemented the retry guard.');
    expect(context).not.toContain('findingResponses');
    // The complete earlier report remains available as historical evidence.
    expect(context).toContain(path.join(workspaceRoot, 'artifacts', '1', 'review.json'));
    expect(await readRoundArtifact(workspaceRoot, round, 'review.json')).toMatchObject({
      profile: 'nexus-review',
      headRevision,
      verdict: 'approved',
      findings: [],
    });
  });

  it('names the complete retained development report of the current repair round', async () => {
    const { workspaceRoot, selectionFile, round } = await workspace({
      round: 2,
      name: 'retained-development',
    });
    await writeDeliveredRound(workspaceRoot);
    // A report produced before the contract change keeps its former response evidence; the
    // simplified typed view omits it, so the review must be able to read the complete file.
    const developmentFile = path.join(
      workspaceRoot,
      'artifacts',
      String(round),
      devArtifact.pathFromArtifactsRoot,
    );
    await writeFile(
      developmentFile,
      `${JSON.stringify(
        {
          taskKey: 'NEX-1',
          profile: 'dev-a',
          status: 'completed',
          baseRevision,
          headRevision,
          summary: 'Repaired the guard and disagreed with the earlier review.',
          findingResponses: [
            { findingId: 'NEX-1-1', status: 'disputed', response: 'The guard is unnecessary.' },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({ verdict: 'approved', summary: 'The guard is present.', findings: [] }),
    );
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('diff --git a/src/queue.ts b/src/queue.ts\n+retry\n'),
    });
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    await expect(
      reviewAction({ selectionFile, runner: runnerOf(runtime), git, github })(),
    ).resolves.toBe('approved');

    const context = requests[0]?.context ?? '';
    // The typed view carries the current fields; the named file carries the complete retained
    // report, including former response evidence the typed view omits.
    expect(context).toContain(
      `Development result (round ${String(round)}; complete retained report at ${developmentFile})`,
    );
    expect(context).toContain('Repaired the guard and disagreed with the earlier review.');
    expect(await readFile(developmentFile, 'utf8')).toContain('The guard is unnecessary.');
  });

  it.each(['malformed', 'unreadable'] as const)(
    'preserves %s development and review history under its producers',
    async (kind) => {
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

      const reason = kind === 'malformed' ? 'is not valid JSON' : 'could not be read';

      // Round one's review report is unusable: the malformed record is preserved under the
      // reviewer's responsibility instead of failing without evidence.
      const reviewFile = path.join(workspaceRoot, 'artifacts', '1', 'review.json');
      const malformedReview = '{"verdict":"changesRequested",';
      await mkdir(path.dirname(reviewFile), { recursive: true });
      if (kind === 'malformed') await writeFile(reviewFile, malformedReview, 'utf8');
      else await mkdir(reviewFile);
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
      ).rejects.toThrow(reason);
      const retainedReview = (await readReportFeedback(workspaceRoot)).find(
        (entry) => entry.record.kind === 'rejection' && entry.record.scope.role === 'reviewer',
      );
      expect(retainedReview?.record).toMatchObject({
        scope: reviewerScope,
        operation: 'review',
        source: { path: reviewFile },
        output: kind === 'malformed' ? malformedReview : null,
        reason: expect.stringContaining(reason),
      });

      // Round one's development report is unusable too: it is preserved under the developer's
      // responsibility, separately attributable from the reviewer's rejection.
      await rm(reviewFile, { recursive: true });
      await writeRoundArtifact(
        workspaceRoot,
        1,
        'review.json',
        reviewOutput({ verdict: 'approved', summary: 'The earlier revision looked right.' }),
      );
      const developmentFile = path.join(workspaceRoot, 'artifacts', '1', 'development.json');
      const malformedDevelopment = '{"status":"completed",';
      if (kind === 'malformed') await writeFile(developmentFile, malformedDevelopment, 'utf8');
      else await mkdir(developmentFile);
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
      ).rejects.toThrow(reason);
      const retainedDevelopment = (await readReportFeedback(workspaceRoot)).find(
        (entry) => entry.record.kind === 'rejection' && entry.record.scope.role === 'developer',
      );
      expect(retainedDevelopment?.record).toMatchObject({
        scope: developerScope,
        operation: 'develop',
        source: { path: developmentFile },
        output: kind === 'malformed' ? malformedDevelopment : null,
        reason: expect.stringContaining(reason),
      });

      await rm(developmentFile, { recursive: true });

      // The repaired history does not resolve either rejection; the next permitted review receives
      // both and its validated saved verdict records the corrections.
      await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
        taskKey: 'NEX-1',
        profile: 'dev-a',
        status: 'completed',
        baseRevision,
        headRevision,
        summary: 'The repaired round-one report.',
      });
      const { runtime, requests } = scriptedRuntime(() =>
        JSON.stringify({
          verdict: 'approved',
          summary: 'The change matches the task.',
          findings: [],
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
      expect(context).toContain(
        kind === 'malformed' ? malformedReview : 'The rejected output itself is unavailable',
      );
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
        output: kind === 'malformed' ? malformedDevelopment : null,
        reason: expect.stringContaining(reason),
      });
    },
  );

  it('treats resolved history as evidence and reports a recurrence as a current finding', async () => {
    const { workspaceRoot, selectionFile, round } = await workspace({
      round: 3,
      name: 'recurrence',
    });
    // Round 1 reported the defect, round 2's current findings were empty, and round 3's revision
    // brings the same defect back.
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
    });
    await writeRoundArtifact(
      workspaceRoot,
      2,
      'review.json',
      reviewOutput({
        verdict: 'approved',
        summary: 'The guard is present.',
        findings: [],
      }),
    );
    await writeDeliveredRound(workspaceRoot);
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        verdict: 'changesRequested',
        summary: 'The guard is missing again on the current revision.',
        findings: [blockingFinding],
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
    // The preceding review reported no current finding, so the recurrence is judged from the
    // current evidence with no eligible-ID set, response array or disposition request.
    expect(context).toContain('Previous review report (round 2;');
    expect(context).not.toContain('Eligible prior finding IDs');
    expect(context).not.toContain('priorFindings');
    expect(context).not.toContain('findingResponses');
    // The complete earlier reports remain available as historical evidence.
    expect(context).toContain(path.join(workspaceRoot, 'artifacts', '1', 'review.json'));
    expect(context).toContain(path.join(workspaceRoot, 'artifacts', '2', 'review.json'));
    // The recurrent defect returns as a current finding without lifecycle identity.
    expect(await readRoundArtifact(workspaceRoot, round, 'review.json')).toMatchObject({
      profile: 'nexus-review',
      headRevision,
      verdict: 'changesRequested',
      findings: [blockingFinding],
    });
  });

  it('rejects unusable or inconsistent reports as execution errors', async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly expected: RegExp;
      readonly output: string;
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
        }),
      },
      {
        label: 'a current finding carrying the removed stable ID',
        expected: /Unrecognized key/,
        output: JSON.stringify({
          verdict: 'changesRequested',
          summary: 'The guard is missing.',
          findings: [{ ...blockingFinding, id: 'NEX-1-finding-1' }],
        }),
      },
      {
        label: 'the removed prior-finding dispositions',
        expected: /Unrecognized key/,
        output: JSON.stringify({
          verdict: 'approved',
          summary: 'Looks fine.',
          findings: [],
          priorFindings: [],
        }),
      },
      {
        label: 'approval with a current blocking finding',
        expected: /approved the revision while reporting a blocking finding/,
        output: JSON.stringify({
          verdict: 'approved',
          summary: 'Looks fine.',
          findings: [blockingFinding],
        }),
      },
      {
        label: 'a changes-requested verdict without a blocking finding',
        expected: /requested changes without a current blocking finding/,
        output: JSON.stringify({
          verdict: 'changesRequested',
          summary: 'There is a problem.',
          findings: [],
        }),
      },
      {
        label: 'a missing field the response shape requires',
        expected: /does not match the response format/,
        output: JSON.stringify({
          verdict: 'approved',
          findings: [],
        }),
      },
      {
        label: 'a location that leaves out the line the strict response shape requires',
        expected: /does not match the response format/,
        output: JSON.stringify({
          verdict: 'changesRequested',
          summary: 'The guard is still missing.',
          findings: [{ ...blockingFinding, locations: [{ path: 'src/queue.ts' }] }],
        }),
      },
    ];

    for (const testCase of cases) {
      events = [];
      const name = `case-${testCase.label.replaceAll(/[^a-z]+/giu, '-')}`;
      const { workspaceRoot, selectionFile } = await workspace({ name });
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
        stat(path.join(workspaceRoot, 'artifacts', '1', 'review.json')),
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

  it('reuses a former report unchanged and rejects a retained inconsistent verdict', async () => {
    // A retained report from the earlier contract carries finding IDs and dispositions. The
    // reader accepts it as historical data, the verdict still binds publication, and the file is
    // never rewritten.
    const former = {
      profile: 'nexus-review',
      headRevision,
      verdict: 'changesRequested',
      summary: 'The retry guard is still missing.',
      findings: [
        {
          id: 'NEX-1-finding-1',
          title: blockingFinding.title,
          severity: 'blocking',
          basis: blockingFinding.basis,
          evidence: blockingFinding.evidence,
          impact: blockingFinding.impact,
          repairGuidance: blockingFinding.repairGuidance,
          locations: [{ path: 'src/queue.ts', line: 42 }],
        },
      ],
      priorFindings: [
        {
          findingId: 'NEX-1-finding-1',
          disposition: 'open',
          reason: 'The guard was still missing in the reviewed revision.',
        },
      ],
    };
    const { workspaceRoot, selectionFile } = await workspace({ name: 'former-report' });
    await writeDeliveredRound(workspaceRoot);
    await writeRoundArtifact(workspaceRoot, 1, 'review.json', former);
    const formerBytes = await readFile(
      path.join(workspaceRoot, 'artifacts', '1', 'review.json'),
      'utf8',
    );
    const { github, calls } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github,
      })(),
    ).resolves.toBe('changesRequested');
    expect(calls).toContain(`publishReview:7@${headRevision}:changesRequested`);
    expect(await readFile(path.join(workspaceRoot, 'artifacts', '1', 'review.json'), 'utf8')).toBe(
      formerBytes,
    );

    // A retained report whose verdict contradicts its blocking findings fails its declared
    // content, so the reader rejects it as an action failure rather than a verdict to publish.
    const { workspaceRoot: inconsistentRoot, selectionFile: inconsistentSelection } =
      await workspace({ name: 'inconsistent-report' });
    await writeDeliveredRound(inconsistentRoot);
    await writeRoundArtifact(inconsistentRoot, 1, 'review.json', {
      ...former,
      verdict: 'approved',
    });
    const inconsistentBytes = await readFile(
      path.join(inconsistentRoot, 'artifacts', '1', 'review.json'),
      'utf8',
    );
    await expect(
      reviewAction({
        selectionFile: inconsistentSelection,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github: scriptedGitHub({}).github,
      })(),
    ).rejects.toThrow(/approved the revision while reporting a blocking finding/);
    expect(
      await readFile(path.join(inconsistentRoot, 'artifacts', '1', 'review.json'), 'utf8'),
    ).toBe(inconsistentBytes);
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
