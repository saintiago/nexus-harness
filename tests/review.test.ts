/**
 * Component tests: the real Review evaluates a delivered revision over real temporary storage with
 * the reviewer runtime, Git, GitHub and Jira adapters controlled. The producer-owned artifact
 * declarations carry the development, verification and delivery results; no provider, network or
 * paid turn is involved.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewerRoleInstructions, type AgentRuntime } from '../src/agent-runtime/index.js';
import type { CheckObservation, GitHubReview } from '../src/adapters/github.js';
import { parseNexusConfiguration } from '../src/configuration/index.js';
import { ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { deliveryArtifact } from '../src/task-engine/actions/deliver/artifacts.js';
import {
  devArtifact,
  developmentReportScope,
} from '../src/task-engine/actions/develop/artifacts.js';
import {
  projectOfWorkspace,
  readPendingValidationError,
  readValidationErrorHistory,
  rejectReport,
} from '../src/task-engine/actions/report-feedback.js';
import { createReview } from '../src/task-engine/actions/review/index.js';
import {
  reviewReportScope,
  reviewResponseSchema,
  type ReviewOutput,
} from '../src/task-engine/actions/review/artifacts.js';
import { verificationArtifact } from '../src/task-engine/actions/verify/artifacts.js';
import type { AgentRoleRunner, EngineEvent } from '../src/task-engine/index.js';
import { composedRunner, runnerOf, writeAssignedReport } from './support/agent-runner.js';
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

/** What the controlled runtime writes to an invocation's assigned Markdown report. */
type ReportSource = string | ((request: RuntimeRequest) => string | Promise<string>) | null;

/**
 * A controlled AgentRuntime that answers every invocation from the handler and writes its assigned
 * Markdown report, as the real agent does. A null report source writes nothing.
 */
function scriptedRuntime(
  handler: (request: RuntimeRequest) => string | Promise<string>,
  report: ReportSource = 'The revision under review.',
): {
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
        const output = await handler(request);
        const markdown = typeof report === 'function' ? await report(request) : report;
        if (markdown !== null) {
          await writeAssignedReport(additionalContext, markdown);
        }
        return ok({ output });
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
  options: {
    readonly round?: number;
    readonly name?: string;
    readonly task?: unknown;
    readonly conversation?: readonly unknown[];
    readonly repositoryWorkspace?: { readonly root: string };
  } = {},
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
        ...(options.repositoryWorkspace === undefined
          ? {}
          : { repositoryWorkspace: options.repositoryWorkspace }),
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
        task: options.task ?? {
          id: '1',
          key: 'NEX-1',
          fields: {
            summary: 'Implement the retry guard',
            description: { type: 'doc', content: [] },
          },
        },
        conversation: options.conversation ?? [{ id: 'c1', body: 'Original request.' }],
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
    readonly developmentReport?: string;
    readonly revision?: string;
  } = {},
): Promise<void> {
  const helpers = createArtifactHelpers({ root: workspaceRoot });
  const current = JSON.parse(
    await readFile(path.join(workspaceRoot, 'state', 'current-round.json'), 'utf8'),
  ) as { readonly number: number };
  const developmentReport = options.developmentReport ?? 'Implemented the retry guard.';
  const revision = options.revision ?? headRevision;
  const developmentFile = path.join(
    workspaceRoot,
    'artifacts',
    String(current.number),
    'reports',
    'dev-1',
    'developer.md',
  );
  await mkdir(path.dirname(developmentFile), { recursive: true });
  await writeFile(developmentFile, developmentReport, 'utf8');
  await helpers.writeOutputArtifact(devArtifact, {
    taskSubject: 'Implement the retry guard',
    taskKey: 'NEX-1',
    profile: 'dev-a',
    status: 'completed',
    baseRevision,
    headRevision: revision,
    role: 'developer',
    report: { path: developmentFile },
    invocationId: 'dev-1',
    readinessFailure: null,
  });
  await helpers.writeOutputArtifact(verificationArtifact, {
    headRevision: revision,
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
    headRevision: revision,
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

/** Read one round's saved review outcome and its bound Markdown report text. */
async function readReview(
  workspaceRoot: string,
  round: number,
): Promise<{ readonly output: ReviewOutput; readonly report: string }> {
  const output = (await readRoundArtifact(workspaceRoot, round, 'review.json')) as ReviewOutput;
  return { output, report: await readFile(output.report.path, 'utf8') };
}

/** One invocation-local evidence file's exact text, beside the saved review's report. */
async function readEvidenceText(output: ReviewOutput, name: string): Promise<string> {
  return readFile(path.join(path.dirname(output.report.path), name), 'utf8');
}

/** One invocation-local JSON evidence value, beside the saved review's report. */
async function readEvidence(output: ReviewOutput, name: string): Promise<unknown> {
  return JSON.parse(await readEvidenceText(output, name)) as unknown;
}

/** Write the issue's parent handoff with the publication identities it already observed. */
async function writePublications(
  workspaceRoot: string,
  publications: readonly { readonly kind: string; readonly id: string }[],
): Promise<void> {
  await mkdir(path.join(workspaceRoot, 'parent'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'parent', 'handoff.json'),
    `${JSON.stringify(
      {
        stage: 'delivery',
        upstreamReturns: 0,
        feedback: null,
        return: null,
        awaitingStages: [],
        tickets: [],
        basis: null,
        publications,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/**
 * Make one evidence path unwritable by placing a directory at it. The action assigns the
 * invocation's report directory before it reads the repository, so the obstruction runs from the
 * controlled Git operation that precedes retention.
 */
async function obstructEvidence(workspaceRoot: string, round: number, name: string): Promise<void> {
  const reportsRoot = path.join(workspaceRoot, 'artifacts', String(round), 'reports');
  const invocationDirectories: string[] = [];
  for (const directory of await readdir(reportsRoot)) {
    // The assigned invocation directory exists before the reviewer runs and holds no report yet.
    if ((await readdir(path.join(reportsRoot, directory))).length === 0) {
      invocationDirectories.push(directory);
    }
  }
  expect(invocationDirectories).toHaveLength(1);
  await mkdir(path.join(reportsRoot, invocationDirectories[0]!, name), { recursive: true });
}

/** One round's assigned invocation directories, excluding the development report's area. */
async function invocationDirectories(workspaceRoot: string, round: number): Promise<string[]> {
  const reportsRoot = path.join(workspaceRoot, 'artifacts', String(round), 'reports');
  return (await readdir(reportsRoot)).filter((directory) => directory !== 'dev-1').sort();
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

/** The current findings the reviewer writes into its Markdown report. */
const findingsMarkdown = [
  'Transient provider failures are not retried.',
  '',
  'Basis: the design requires a transient provider failure to be retried once.',
  'Evidence: the failing call returns immediately and no second attempt appears in the log.',
  'Impact: a transient failure leaves the work unfinished.',
  'Required correction: retry the provider call once before reporting the failure.',
  'Location: src/queue.ts:42.',
].join('\n');

/**
 * Save one round's bound review report and record, as the Review action saves them. The Markdown
 * is the exact bytes the publication and context readers consume.
 */
async function saveReview(
  workspaceRoot: string,
  round: number,
  markdown: string,
  overrides: Partial<ReviewOutput> = {},
): Promise<{ readonly output: ReviewOutput; readonly reportFile: string }> {
  const reportFile = path.join(
    workspaceRoot,
    'artifacts',
    String(round),
    'reports',
    `rev-${String(round)}`,
    'reviewer.md',
  );
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, markdown, 'utf8');
  const output: ReviewOutput = {
    taskSubject: 'Implement the retry guard',
    taskKey: 'NEX-1',
    profile: 'nexus-review',
    headRevision,
    verdict: 'approved',
    role: 'reviewer',
    report: { path: reportFile },
    invocationId: `rev-${String(round)}`,
    ...overrides,
  };
  // An earlier round's record is written into that round explicitly, as that round's producer did.
  await writeRoundArtifact(workspaceRoot, round, 'review.json', output);
  return { output, reportFile };
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

/** One review observation whose body is the exact saved report body. */
function submittedReview(body: string, overrides: Partial<GitHubReview> = {}): GitHubReview {
  return {
    id: 11,
    state: 'APPROVED',
    body,
    commit_id: headRevision,
    author: lensLogin,
    ...overrides,
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
    const reviewMarkdown = 'The change matches the task and the check covers it.';
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      reviewMarkdown,
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
    expect(context).toContain(`Complete comparison diff ${baseRevision}..${headRevision}`);
    expect(context).toContain('exact bytes as returned');
    // The diff body is referenced, never embedded.
    expect(context).not.toContain('+feature');
    expect(context).toContain('Implemented the retry guard.');
    // The diff is orientation, not a scope boundary, and no previous review exists to consult.
    expect(context).toContain('including pre-existing code outside this range, remains in scope');
    expect(context).not.toContain('Previous review report');
    expect(context).toContain('Return only one JSON object');
    expect(context).not.toContain('priorFindings');
    expect(context).not.toContain('findingResponses');

    const recorded = await readReview(workspaceRoot, round);
    expect(recorded.output).toMatchObject({
      taskSubject: 'Implement the retry guard',
      taskKey: 'NEX-1',
      profile: 'nexus-review',
      headRevision,
      verdict: 'approved',
      role: 'reviewer',
    });
    expect(recorded.output.report.path).toContain(path.join('artifacts', '1', 'reports'));
    expect(recorded.output).not.toHaveProperty('reportIdentity');
    expect(recorded.output.invocationId).toBeTruthy();
    expect(recorded.report).toBe(reviewMarkdown);
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
    // and retains the invocation-local evidence beside its assigned Markdown report.
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
    expect(await readEvidence(recorded.output, 'pr-conversation.json')).toEqual({
      comments: [{ id: 1, body: 'Human pull-request discussion.' }],
      reviews: [],
      reviewComments: [],
    });
    expect(await readEvidenceText(recorded.output, 'comparison.diff')).toBe(
      'diff --git a/feature.txt b/feature.txt\n+feature\n',
    );
    expect(await readEvidence(recorded.output, 'captured-source.json')).toEqual({
      issue: {
        id: '1',
        key: 'NEX-1',
        fields: { summary: 'Implement the retry guard', description: { type: 'doc', content: [] } },
      },
      conversation: [{ id: 'c1', body: 'Original request.' }],
    });
    expect(context).toContain(
      `complete captured conversation at ${path.join(path.dirname(recorded.output.report.path), 'captured-source.json')}`,
    );
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
    const { runner, requests } = composedRunner(configuration, 'reviewer', async (request) => {
      await writeAssignedReport(request.prompt, 'The change matches the task.');
      return JSON.stringify({ verdict: 'approved' });
    });
    const review = reviewAction({ selectionFile, runner, git, github, jira });

    await expect(review()).resolves.toBe('approved');

    const prompt = requests[0]!.prompt;
    for (const obligation of [
      "Apply the project's existing design and ownership principles",
      'Inspect whether the resulting',
      'superseded rules or mechanisms',
      'confirm any shared ownership cause',
      'Accept adequate work and keep optional suggestions distinct',
      'depth guided by the change',
      'document indexes and historical references are not mandatory reading lists',
      'no extra attempts or bypass of revision-bound review, merge or check gates',
    ]) {
      expect(occurrences(prompt, obligation), obligation).toBe(1);
    }
    expect(occurrences(prompt, reviewerRoleInstructions.join('\n\n'))).toBe(1);
    // The current requirements, the directly visible direction and the revision-bound evidence
    // reach the provider once; complete conversations are referenced instead of embedded.
    expect(prompt).toContain('Task NEX-1 — current captured requirements');
    expect(prompt).toContain('Implement the retry guard');
    expect(prompt).toContain(
      'Task conversation (Jira issue NEX-1, issue 1; complete captured conversation at',
    );
    expect(prompt).toContain('Original request.');
    expect(prompt).toContain(
      'Pull-request conversation (owner/repository pull request 7; captured comments, reviews and inline review comments in their captured order; complete captured conversation at',
    );
    expect(prompt).toContain('Human pull-request discussion.');
    expect(prompt).toContain('Origin uncertain');
    expect(prompt).toContain(
      `Reviewed revision: ${headRevision} (comparison base ${baseRevision})`,
    );
    expect(prompt).toContain('Implemented the retry guard.');
    expect(prompt).toContain('including pre-existing code outside this range, remains in scope');
    expect(prompt).toContain('Return only one JSON object');
    expect(requests[0]!.directory).toBe(path.join(workspaceRoot, 'worktree'));
  });

  it('carries the preceding review and developer narrative into the repair assessment', async () => {
    const { workspaceRoot, selectionFile, round } = await workspace({
      round: 2,
      name: 'repair',
    });
    const firstReview = await saveReview(workspaceRoot, 1, findingsMarkdown, {
      verdict: 'changesRequested',
    });
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'First implementation.',
    });
    await writeDeliveredRound(workspaceRoot);
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'The retry guard is present now.',
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
    // The previous review's complete Markdown is context: its verdict and current findings reach
    // the reviewer without an eligible-ID set, response array or disposition request.
    expect(context).toContain(
      'Previous review report (round 1, profile nexus-review, invocation rev-1, reviewed revision',
    );
    expect(context).toContain('verdict changesRequested; judge whether its concerns remain');
    expect(context).toContain(findingsMarkdown);
    expect(context).not.toContain('Eligible prior finding IDs');
    expect(context).not.toContain('priorFindings');
    // The current development result carries the developer's narrative, not per-finding answers.
    expect(context).toContain('Implemented the retry guard.');
    expect(context).not.toContain('findingResponses');
    // The complete earlier report remains available as historical evidence.
    expect(context).toContain(firstReview.reportFile);
    const recorded = await readReview(workspaceRoot, round);
    expect(recorded.output).toMatchObject({
      profile: 'nexus-review',
      headRevision,
      verdict: 'approved',
    });
    expect(recorded.report).toBe('The retry guard is present now.');
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
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'The guard is present.',
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
      `Development result (round ${String(round)}, profile dev-a, status completed; retained combined report at ${developmentFile})`,
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
      const retainedReview = (await readValidationErrorHistory(workspaceRoot)).find(
        (entry) =>
          entry.record.kind === 'validation-error' && entry.record.scope.role === 'reviewer',
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
      await saveReview(workspaceRoot, 1, 'The earlier revision looked right.');
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
      const retainedDevelopment = (await readValidationErrorHistory(workspaceRoot)).find(
        (entry) =>
          entry.record.kind === 'validation-error' && entry.record.scope.role === 'developer',
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
      const { runtime, requests } = scriptedRuntime(
        () => JSON.stringify({ verdict: 'approved' }),
        'The change matches the task.',
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
      expect(context).toContain('Pending validation error');
      expect(context).toContain(
        kind === 'malformed' ? malformedReview : 'The rejected output itself is unavailable',
      );
      expect(context).toContain(reviewFile);
      // The developer's rejection stays attributable to the developer's responsibility: this review
      // never inherits it, and its validated verdict retires only the reviewer's rejection.
      expect(context).not.toContain(malformedDevelopment);
      await expect(
        readPendingValidationError({ areaRoot: workspaceRoot, scope: reviewerScope }),
      ).resolves.toBeNull();
      // Validating the current bound development outcome as this review's input is the same
      // owner check Develop replays: it completes that responsibility's interrupted validation
      // too, while the original error stays readable history under its scope.
      await expect(
        readPendingValidationError({ areaRoot: workspaceRoot, scope: developerScope }),
      ).resolves.toBeNull();
      expect(retainedDevelopment?.record).toMatchObject({
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
    const firstReview = await saveReview(workspaceRoot, 1, findingsMarkdown, {
      verdict: 'changesRequested',
    });
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'First implementation.',
    });
    const secondReview = await saveReview(workspaceRoot, 2, 'The guard is present.');
    await writeDeliveredRound(workspaceRoot);
    const recurrenceMarkdown = 'The guard is missing again on the current revision.';
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'changesRequested' }),
      recurrenceMarkdown,
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
    // The preceding review's Markdown reported no current finding, so the recurrence is judged
    // from the current evidence with no eligible-ID set, response array or disposition request.
    expect(context).toContain('Previous review report (round 2, profile nexus-review');
    expect(context).not.toContain('Eligible prior finding IDs');
    expect(context).not.toContain('priorFindings');
    expect(context).not.toContain('findingResponses');
    // The complete earlier reports remain available as historical evidence.
    expect(context).toContain(firstReview.reportFile);
    expect(context).toContain(secondReview.reportFile);
    // The recurrent defect returns as a current finding without lifecycle identity.
    const recorded = await readReview(workspaceRoot, round);
    expect(recorded.output).toMatchObject({
      profile: 'nexus-review',
      headRevision,
      verdict: 'changesRequested',
    });
    expect(recorded.report).toBe(recurrenceMarkdown);
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
        output: JSON.stringify({ verdict: 'done' }),
      },
      {
        label: 'the removed inconclusive verdict',
        expected: /does not match the response format/,
        output: JSON.stringify({ verdict: 'inconclusive' }),
      },
      {
        label: 'a narrative summary in the outcome',
        expected: /Unrecognized key: "summary"/,
        output: JSON.stringify({ verdict: 'approved', summary: 'Looks fine.' }),
      },
      {
        label: 'a structured finding list in the outcome',
        expected: /Unrecognized key: "findings"/,
        output: JSON.stringify({ verdict: 'changesRequested', findings: [] }),
      },
      {
        label: 'the removed prior-finding dispositions',
        expected: /Unrecognized key: "priorFindings"/,
        output: JSON.stringify({ verdict: 'approved', priorFindings: [] }),
      },
      {
        label: 'a missing verdict the response shape requires',
        expected: /does not match the response format/,
        output: JSON.stringify({}),
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
      // The rejected output and the Markdown the agent wrote remain attributable evidence.
      const rejection = (await readValidationErrorHistory(workspaceRoot)).find(
        (entry) => entry.record.kind === 'validation-error',
      );
      expect(rejection?.record, testCase.label).toMatchObject({
        operation: 'review',
        output: testCase.output,
        report: expect.objectContaining({ path: expect.stringContaining('report-feedback') }),
        assignedReport: expect.objectContaining({ path: expect.stringContaining('reports') }),
      });
    }
  });

  it('rejects a valid verdict whose assigned Markdown report was never written', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ name: 'missing-report' });
    await writeDeliveredRound(workspaceRoot);
    const { runtime } = scriptedRuntime(() => JSON.stringify({ verdict: 'approved' }), null);
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok(''),
    });
    const { github, calls } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
    });
    const review = reviewAction({ selectionFile, runner: runnerOf(runtime), git, github });

    await expect(review()).rejects.toThrow(/Assigned review report at ".*" does not exist/);
    await expect(stat(path.join(workspaceRoot, 'artifacts', '1', 'review.json'))).rejects.toThrow(
      /ENOENT/,
    );
    // The verdict is not published and no review record is saved before its report is validated;
    // the rejection keeps the attempted path and records the unavailable Markdown explicitly.
    expect(calls).toEqual(['conversation:7']);
    const rejection = (await readValidationErrorHistory(workspaceRoot)).find(
      (entry) => entry.record.kind === 'validation-error',
    );
    expect(rejection?.record).toMatchObject({
      operation: 'review',
      output: JSON.stringify({ verdict: 'approved' }),
      report: null,
      assignedReport: expect.objectContaining({ path: expect.stringContaining('reports') }),
    });
  });

  it('does not reuse or publish a saved review that belongs to another task', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ name: 'foreign-review' });
    await writeDeliveredRound(workspaceRoot);
    const saved = await saveReview(workspaceRoot, 1, 'The change matches another task.', {
      taskKey: 'NEX-2',
    });
    const { github, calls } = scriptedGitHub({});

    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github,
      })(),
    ).rejects.toThrow('is for task "NEX-2", not "NEX-1"');
    // The foreign review is neither published nor reused as this task's assessment; it is
    // preserved as the reviewer's rejection evidence under this task's responsibility.
    expect(calls).toEqual([]);
    const rejection = (await readValidationErrorHistory(workspaceRoot)).find(
      (entry) => entry.record.kind === 'validation-error',
    );
    expect(rejection?.record).toMatchObject({
      scope: reviewReportScope(workspaceRoot, 'NEX-1'),
      operation: 'review',
      assignedReport: { path: saved.reportFile },
      report: expect.objectContaining({ path: expect.stringContaining('report-feedback') }),
    });
  });

  it.each([false, true])(
    'rejects unusable developer evidence before Review (saved review: %s)',
    async (replay) => {
      for (const damage of ['missing Markdown', 'foreign task', 'schema']) {
        const { workspaceRoot, selectionFile } = await workspace({ name: `${replay}-${damage}` });
        await writeDeliveredRound(workspaceRoot);
        if (replay) await saveReview(workspaceRoot, 1, 'The implementation is approved.');
        const file = path.join(workspaceRoot, 'artifacts/1/development.json');
        const outcome = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> & {
          report: { path: string };
        };
        const reportFile = outcome.report.path;
        if (damage === 'missing Markdown') await rm(reportFile);
        if (damage === 'foreign task') outcome['taskKey'] = 'NEX-2';
        if (damage === 'schema') delete outcome['invocationId'];
        await writeFile(file, JSON.stringify(outcome));
        const rejectedOutput = await readFile(file, 'utf8');
        const { github, calls } = scriptedGitHub({});
        const { git, calls: gitCalls } = scriptedGit([]);

        await expect(
          reviewAction({
            selectionFile,
            runner: runnerOf(unusedRuntime()),
            git,
            github,
          })(),
        ).rejects.toThrow();
        expect(calls).toEqual([]);
        expect(gitCalls).toEqual([]);
        const records = await readValidationErrorHistory(workspaceRoot);
        expect(records).toHaveLength(1);
        const rejection = records[0]!.record;
        expect(rejection).toMatchObject({
          kind: 'validation-error',
          scope: developmentReportScope(workspaceRoot, 'NEX-1'),
          operation: 'develop',
          output: rejectedOutput,
          assignedReport: { path: reportFile },
        });
        if (damage === 'missing Markdown') expect(rejection.report).toBeNull();
        else
          expect(await readFile(rejection.report!.path, 'utf8')).toBe(
            'Implemented the retry guard.',
          );
      }
    },
  );

  it('completes an interrupted save/clear when a repetition reuses the saved review', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ name: 'correction-replay' });
    await writeDeliveredRound(workspaceRoot);
    // A rejected invocation leaves an outstanding rejection for the reviewer responsibility.
    const { git } = scriptedGit([repositoryState({ headRevision })], { readDiff: () => ok('') });
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
    });
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(scriptedRuntime(() => 'not a JSON report').runtime),
        git,
        github,
      })(),
    ).rejects.toThrow(/unusable output/);
    const scope = reviewReportScope(workspaceRoot, 'NEX-1');
    expect(
      (await readPendingValidationError({ areaRoot: workspaceRoot, scope }))?.entries,
    ).toHaveLength(1);

    // A later invocation saved its validated review and was interrupted before clearing the
    // pending context: its current bound saved record is the replacement the replay validates.
    const markdown = 'The retry guard is present now.';
    await saveReview(workspaceRoot, 1, markdown, { invocationId: 'rev-repair' });

    events = [];
    const { github: replayHub, calls } = scriptedGitHub({
      readConversation: () =>
        ok({ comments: [], reviews: [submittedReview(markdown)], reviewComments: [] }),
      readChecks: () => ok([lensCheck()]),
    });
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github: replayHub,
      })(),
    ).resolves.toBe('approved');
    // The published review and check already match: only the replay's reads happened, no
    // invocation and no duplicate publication.
    expect(calls).toEqual(['conversation:7', `readChecks:${headRevision}`]);
    await expect(
      readPendingValidationError({ areaRoot: workspaceRoot, scope }),
    ).resolves.toBeNull();
    expect(await readValidationErrorHistory(workspaceRoot)).toHaveLength(1);
  });

  it.each(['moved head', 'tracked changes'])(
    'keeps developer context when fresh Review rejects %s',
    async (damage) => {
      const prepared = await workspace({ name: 'fresh-review-pending' });
      await writeDeliveredRound(prepared.workspaceRoot);
      const scope = developmentReportScope(prepared.workspaceRoot, 'NEX-1');
      await expect(
        rejectReport({
          areaRoot: prepared.workspaceRoot,
          scope,
          invocationId: 'rejected-dev',
          operation: 'develop',
          profile: 'dev-a',
          context: 'Development round 1.',
          source: null,
          output: 'invalid',
          reason: 'Actionable developer error.',
        }),
      ).rejects.toThrow('Actionable developer error.');
      const pending = await readPendingValidationError({ areaRoot: prepared.workspaceRoot, scope });
      await expect(
        reviewAction({
          selectionFile: prepared.selectionFile,
          runner: runnerOf(unusedRuntime()),
          git: scriptedGit([
            repositoryState({
              headRevision: damage === 'moved head' ? otherRevision : headRevision,
              trackedChanges: damage === 'tracked changes',
            }),
          ]).git,
          github: scriptedGitHub({}).github,
        })(),
      ).rejects.toThrow(damage === 'moved head' ? /not the delivered/ : /tracked changes/);
      await expect(
        readPendingValidationError({ areaRoot: prepared.workspaceRoot, scope }),
      ).resolves.toEqual(pending);
      // Publication replay retains its saved-review rules and needs no fresh worktree assessment.
      await saveReview(prepared.workspaceRoot, 1, 'Saved review.');
      await expect(
        reviewAction({
          selectionFile: prepared.selectionFile,
          runner: runnerOf(unusedRuntime()),
          git: scriptedGit([]).git,
          github: scriptedGitHub({
            readConversation: () =>
              ok({ comments: [], reviews: [submittedReview('Saved review.')], reviewComments: [] }),
            readChecks: () => ok([lensCheck()]),
          }).github,
        })(),
      ).resolves.toBe('approved');
      await expect(
        readPendingValidationError({ areaRoot: prepared.workspaceRoot, scope }),
      ).resolves.toBeNull();
    },
  );

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
    const { runtime } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'Looks fine.',
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

    events = [];
    const rewritten = await workspace({ name: 'rewritten' });
    await writeDeliveredRound(rewritten.workspaceRoot);
    const { runtime: rewrittenRuntime } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'Looks fine.',
    );
    const rewrittenGit = scriptedGit(
      [repositoryState({ headRevision }), repositoryState({ headRevision: otherRevision })],
      { readDiff: () => ok('') },
    );
    const rewrittenReview = reviewAction({
      selectionFile: rewritten.selectionFile,
      runner: runnerOf(rewrittenRuntime),
      git: rewrittenGit.git,
      github: scriptedGitHub({
        readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      }).github,
      jira: scriptedJira({ readIssue: () => ok(taskIssue), readComments: () => ok([]) }).jira,
    });
    await expect(rewrittenReview()).rejects.toThrow(/not the reviewed/);
    await expect(
      stat(path.join(rewritten.workspaceRoot, 'artifacts', '1', 'review.json')),
    ).rejects.toThrow(/ENOENT/);

    // Both post-invocation binding failures retain the exact verdict and the Markdown the agent
    // wrote as reviewer rejection evidence for the next responsible invocation.
    for (const root of [edited.workspaceRoot, rewritten.workspaceRoot]) {
      const rejection = (await readValidationErrorHistory(root)).find(
        (entry) => entry.record.kind === 'validation-error',
      );
      expect(rejection?.record).toMatchObject({
        operation: 'review',
        output: JSON.stringify({ verdict: 'approved' }),
        report: expect.objectContaining({ path: expect.stringContaining('report-feedback') }),
        assignedReport: expect.objectContaining({ path: expect.stringContaining('reports') }),
      });
    }
  });

  it('reuses the saved report for the delivered head and publishes only the missing part', async () => {
    const savedMarkdown = 'Looks fine.';

    // The Lens review and its Lens check are published: only the ticket comment is inspected.
    const finished = await workspace({ name: 'finished' });
    await writeDeliveredRound(finished.workspaceRoot);
    const { output: finishedSaved } = await saveReview(finished.workspaceRoot, 1, savedMarkdown);
    const finishedHub = scriptedGitHub({
      readConversation: () =>
        ok({ comments: [], reviews: [submittedReview(savedMarkdown)], reviewComments: [] }),
      readChecks: () => ok([lensCheck()]),
    });
    const { jira: finishedJira, calls: finishedJiraCalls } = scriptedJira({
      readComments: () => ok([]),
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
          detail: `profile ${finishedSaved.profile}`,
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
    await saveReview(unfinished.workspaceRoot, 1, savedMarkdown);
    const unfinishedHub = scriptedGitHub({
      readConversation: () =>
        ok({ comments: [], reviews: [submittedReview(savedMarkdown)], reviewComments: [] }),
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
    await saveReview(different.workspaceRoot, 1, savedMarkdown);
    const differentHub = scriptedGitHub({
      readConversation: () =>
        ok({
          comments: [],
          reviews: [submittedReview('An earlier report for the same head.')],
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

  it('reuses a retained combined report unchanged without lifecycle or consistency rules', async () => {
    // A retained report from the earlier contract carries finding IDs and dispositions. The
    // reader accepts it as historical data, its recorded verdict binds publication, and the file
    // is never rewritten.
    const former = {
      taskKey: 'NEX-1',
      profile: 'nexus-review',
      headRevision,
      verdict: 'changesRequested',
      summary: 'The retry guard is still missing.',
      findings: [
        {
          id: 'NEX-1-finding-1',
          title: 'Transient provider failures are not retried',
          severity: 'blocking',
          basis: 'The design requires a transient provider failure to be retried once.',
          evidence: 'The failing call returns immediately and no second attempt appears.',
          impact: 'A transient failure leaves the work unfinished.',
          repairGuidance: 'Retry the provider call once before reporting the failure.',
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

    // The removed consistency rule no longer governs a retained combined report: its recorded
    // verdict binds publication even when its former finding list disagrees, and the file stays
    // as recorded.
    const { workspaceRoot: approvedRoot, selectionFile: approvedSelection } = await workspace({
      name: 'former-approved',
    });
    await writeDeliveredRound(approvedRoot);
    await writeRoundArtifact(approvedRoot, 1, 'review.json', { ...former, verdict: 'approved' });
    await expect(
      reviewAction({
        selectionFile: approvedSelection,
        runner: runnerOf(unusedRuntime()),
        git: scriptedGit([]).git,
        github: scriptedGitHub({
          readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
          readChecks: () => ok([]),
          publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
          publishReviewCheck: () => ok({ id: 12 }),
        }).github,
      })(),
    ).resolves.toBe('approved');
    expect(await readRoundArtifact(approvedRoot, 1, 'review.json')).toMatchObject({
      verdict: 'approved',
    });
  });

  it('does not treat a same-name check or another author as the Nexus Lens publication', async () => {
    const savedMarkdown = 'Looks fine.';
    const otherAppCheck = lensCheck({
      id: 21,
      producer: { id: 4242, slug: 'other-app', name: 'Other App' },
    });
    const unownedCheck = lensCheck({ id: 22, producer: null });
    const incompleteLensCheck = lensCheck({ status: 'in_progress' });
    const mismatchedLensCheck = lensCheck({ id: 23, conclusion: 'failure' });
    const { workspaceRoot, selectionFile } = await workspace({ name: 'foreign-publications' });
    await writeDeliveredRound(workspaceRoot);
    await saveReview(workspaceRoot, 1, savedMarkdown);
    const { github, calls: githubCalls } = scriptedGitHub({
      readConversation: () =>
        ok({
          comments: [],
          reviews: [submittedReview(savedMarkdown, { author: 'someone-else' })],
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
    await saveReview(workspaceRoot, 1, 'The earlier revision looked right.', {
      headRevision: otherRevision,
    });
    const laterMarkdown = 'The later revision still misses a retry.';
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'changesRequested' }),
      laterMarkdown,
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
    // The current round's saved assessment of the earlier head is directly visible, complete and
    // attributed; an approval is not translated into an approval of the later head.
    const context = requests[0]?.context ?? '';
    expect(context).toContain(
      'Previous review report (round 1, profile nexus-review, invocation rev-1, reviewed revision',
    );
    expect(context).toContain('The earlier revision looked right.');
    const recorded = await readReview(workspaceRoot, 1);
    expect(recorded.output).toMatchObject({
      headRevision,
      verdict: 'changesRequested',
    });
    expect(recorded.report).toBe(laterMarkdown);
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

  it('retains invocation-local evidence and references complete conversations with attribution', async () => {
    const summaryBody = 'Nexus-published summary body that must not be embedded.';
    const handoffBody = 'Nexus handoff comment body that must not be embedded.';
    const description = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Retry one transient provider failure.' }],
        },
      ],
    };
    const task = {
      id: '1',
      key: 'NEX-1',
      fields: { summary: 'Implement the retry guard', description },
    };
    const paragraph = (text: string) => ({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const jane = { displayName: 'Jane Doe', accountId: 'acc-jane', accountType: 'atlassian' };
    const conversation = [
      {
        id: 'c2',
        author: jane,
        created: '2026-10-07T09:00:00.000+0000',
        body: paragraph('Older human scope clarification.'),
      },
      {
        id: 'c3',
        author: jane,
        created: '2026-10-07T10:00:00.000+0000',
        body: paragraph('Later conflicting human instruction.'),
      },
      { id: 'c4', body: 'Unattributed note that may be direction.' },
      {
        id: 'c9',
        author: { displayName: 'Harness', accountId: 'acc-app', accountType: 'app' },
        created: '2026-10-07T08:00:00.000+0000',
        body: paragraph(summaryBody),
      },
      {
        id: 'c5',
        author: { displayName: 'Harness', accountId: 'acc-harness', accountType: 'atlassian' },
        created: '2026-10-07T07:00:00.000+0000',
        body: paragraph(handoffBody),
      },
    ];
    const pullRequestConversation = {
      comments: [
        {
          id: 21,
          body: 'Human pull-request discussion.',
          user: { login: 'jane', type: 'User' },
          created_at: '2026-10-07T09:30:00Z',
          html_url: 'https://github.com/owner/repository/pull/7#issuecomment-21',
        },
        {
          id: 22,
          body: 'Bot status comment body that must not be embedded.',
          user: { login: 'ci-bot', type: 'Bot' },
          created_at: '2026-10-07T09:31:00Z',
        },
        { id: 23, body: 'Unattributed pull-request note.' },
      ],
      reviews: [
        {
          id: 31,
          state: 'APPROVED',
          body: 'Automated Nexus Lens review body that must not be embedded.',
          commit_id: otherRevision,
          author: lensLogin,
          user: { login: lensLogin, type: 'Bot' },
        },
      ],
      reviewComments: [
        {
          id: 41,
          body: 'Inline human review comment.',
          user: { login: 'jane', type: 'User' },
          in_reply_to_id: 21,
        },
      ],
    };
    const diff = 'diff --git a/src/queue.ts b/src/queue.ts\n+retry once\n';
    const { workspaceRoot, selectionFile, round } = await workspace({
      name: 'evidence',
      task,
      conversation,
    });
    // The parent retained the identity of its own Jira publication; that acknowledgement, not
    // the human-looking account type, marks the entry as automation.
    await writePublications(workspaceRoot, [{ kind: 'review-feedback', id: 'c5' }]);
    await writeDeliveredRound(workspaceRoot);
    // A conversation file retained by an earlier round keeps its bytes; the new reference uses
    // the invocation-local copy.
    const legacyConversation = '{"comments":[{"id":9}],"reviews":[],"reviewComments":[]}\n';
    await writeFile(
      path.join(workspaceRoot, 'artifacts', String(round), 'pr-conversation.json'),
      legacyConversation,
      'utf8',
    );
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'Approved.',
    );
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok(diff),
    });
    const { github } = scriptedGitHub({
      readConversation: () => ok(pullRequestConversation),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });

    await expect(
      reviewAction({ selectionFile, runner: runnerOf(runtime), git, github })(),
    ).resolves.toBe('approved');

    const recorded = await readReview(workspaceRoot, round);
    const directory = path.dirname(recorded.output.report.path);
    const capturedSource = path.join(directory, 'captured-source.json');
    const prConversation = path.join(directory, 'pr-conversation.json');
    const comparisonDiff = path.join(directory, 'comparison.diff');
    // The exact captured values and diff bytes are retained beside the assigned Markdown report.
    expect(await readEvidence(recorded.output, 'captured-source.json')).toEqual({
      issue: task,
      conversation,
    });
    expect(await readEvidence(recorded.output, 'pr-conversation.json')).toEqual(
      pullRequestConversation,
    );
    expect(await readEvidenceText(recorded.output, 'comparison.diff')).toBe(diff);
    expect(directory).toContain(path.join('artifacts', String(round), 'reports'));
    expect(
      await readFile(
        path.join(workspaceRoot, 'artifacts', String(round), 'pr-conversation.json'),
        'utf8',
      ),
    ).toBe(legacyConversation);

    const context = requests[0]?.context ?? '';
    // Every labeled reference is an absolute path to the invocation's complete evidence.
    expect(context).toContain(`complete captured Jira issue and conversation at ${capturedSource}`);
    expect(context).toContain(`complete captured conversation at ${capturedSource}`);
    expect(context).toContain(`complete captured conversation at ${prConversation}`);
    expect(context).toContain(`valid empty diff): ${comparisonDiff}`);
    // Human direction and uncertain-origin entries stay directly visible with attribution; the
    // older and later directions remain explicit and unresolved.
    expect(context).toContain('Older human scope clarification.');
    expect(context).toContain('Later conflicting human instruction.');
    expect(context).toContain(
      'Jane Doe <acc-jane> [atlassian account] at 2026-10-07T09:00:00.000+0000',
    );
    expect(context).toContain('Unattributed note that may be direction.');
    expect(context).toContain('Human pull-request discussion.');
    expect(context).toContain('Inline human review comment.');
    expect(context).toContain('Comment 21 — jane [User account] at 2026-10-07T09:30:00Z');
    expect(occurrences(context, 'Origin uncertain')).toBe(2);
    expect(occurrences(context, 'Confirmed automated entries omitted from this section')).toBe(2);
    // Confirmed automated bodies and the diff body never reach the assembled prompt.
    expect(context).not.toContain(summaryBody);
    expect(context).not.toContain(handoffBody);
    expect(context).not.toContain('Bot status comment body');
    expect(context).not.toContain('Automated Nexus Lens review body');
    expect(context).not.toContain('+retry once');
  });

  it('keeps unsupported requirements, direction bodies and attribution complete in the prompt', async () => {
    const requirement = 'Retry exactly once before failing the queue item.';
    const direction = 'Pause retries while the feature flag is off.';
    const note = 'The retry budget is two attempts in production.';
    const description = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Implement the retry guard.' }] },
        {
          type: 'extension',
          attrs: { extensionKey: 'com.example.requirement', extensionType: 'com.example.runtime' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: requirement }] }],
        },
      ],
    };
    const task = {
      id: '1',
      key: 'NEX-1',
      fields: { summary: 'Implement the retry guard', description },
    };
    const jane = { displayName: 'Jane Doe', accountId: 'acc-jane', accountType: 'atlassian' };
    const conversation = [
      {
        id: 'c7',
        self: 'https://example.atlassian.net/rest/api/3/issue/1/comment/c7',
        author: jane,
        created: '2026-10-07T09:00:00.000+0000',
        updated: '2026-10-07T09:30:00.000+0000',
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'extension',
              attrs: { extensionKey: 'com.example.direction' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: direction }] }],
            },
          ],
        },
      },
      {
        id: 'c8',
        author: jane,
        created: '2026-10-07T09:40:00.000+0000',
        body: { kind: 'structured-note', instruction: note },
      },
      'Retained string entry that may be direction.',
    ];
    const { workspaceRoot, selectionFile, round } = await workspace({
      name: 'lossless',
      task,
      conversation,
    });
    await writeDeliveredRound(workspaceRoot);
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'Approved.',
    );
    const { git } = scriptedGit([repositoryState({ headRevision })], { readDiff: () => ok('') });
    const { github } = scriptedGitHub({
      readConversation: () =>
        ok({
          comments: [
            {
              id: 51,
              body: 'Automated bot body that must stay out.',
              user: { login: 'ci-bot', type: 'Bot' },
            },
          ],
          reviews: [],
          reviewComments: [
            {
              id: 41,
              body: 'Please apply the fix here.',
              user: { login: 'jane', type: 'User' },
              path: 'src/queue.ts',
              line: 12,
              original_line: 9,
              created_at: '2026-10-07T10:00:00Z',
              commit_id: headRevision,
              original_commit_id: otherRevision,
              pull_request_review_id: 77,
              html_url: 'https://github.com/owner/repository/pull/7#discussion_r41',
            },
          ],
        }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });

    await expect(
      reviewAction({ selectionFile, runner: runnerOf(runtime), git, github })(),
    ).resolves.toBe('approved');

    const recorded = await readReview(workspaceRoot, round);
    const context = requests[0]?.context ?? '';
    // Unsupported rich-text nodes, structured bodies and non-object entries keep their complete
    // original values inline; no requirement or possible direction becomes only an inspection
    // pointer.
    expect(context).toContain(requirement);
    expect(context).toContain(direction);
    expect(context).toContain(note);
    expect(context).toContain('Retained string entry that may be direction.');
    // A retained entry without captured authorship stays explicitly labeled uncertain.
    expect(occurrences(context, 'Origin uncertain')).toBe(1);
    // Captured attribution survives: the comment's own source URL and its edit chronology even
    // without an updateAuthor, and the inline comment's file, line, original revision and review.
    expect(context).toContain(
      'source: https://example.atlassian.net/rest/api/3/issue/1/comment/c7',
    );
    expect(context).toContain('(edited at 2026-10-07T09:30:00.000+0000)');
    expect(context).toContain('file src/queue.ts line 12');
    expect(context).toContain(`original revision ${otherRevision}`);
    expect(context).toContain('review 77');
    // Automation filtering and the complete invocation-local evidence references still hold.
    expect(context).not.toContain('Automated bot body that must stay out.');
    expect(context).toContain(
      path.join(path.dirname(recorded.output.report.path), 'captured-source.json'),
    );
    expect(context).toContain(
      path.join(path.dirname(recorded.output.report.path), 'comparison.diff'),
    );
  });

  it('preserves unsupported text marks in requirements and human bodies at the provider boundary', async () => {
    const marked = { type: 'text', text: '3', marks: [{ type: 'subsup', attrs: { type: 'sup' } }] };
    const invalidLink = {
      type: 'text',
      text: 'the limit',
      marks: [{ type: 'link', attrs: { target: 'captured-target' } }],
    };
    // Specialized readable projections also discard unfamiliar children and nested content.
    // Review's stronger guarantee applies to the complete structured value, not just marks.
    const unfamiliar = {
      type: 'paragraph',
      content: { instruction: 'Keep nested shutdown guidance available.' },
    };
    const description = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Limit records to 10' },
            marked,
            { type: 'text', text: ' per batch; consult ' },
            invalidLink,
          ],
        },
        { type: 'codeBlock', content: [marked] },
        unfamiliar,
        'Retained rich-text child that may be direction.',
      ],
    };
    const task = { ...taskIssue, fields: { summary: 'Implement the retry guard', description } };
    const conversation = [
      {
        id: 'c-mark',
        author: { accountType: 'atlassian', displayName: 'Jane' },
        body: description,
      },
    ];
    const { workspaceRoot, selectionFile, round } = await workspace({ task, conversation });
    await writeDeliveredRound(workspaceRoot);
    const configuration = parseNexusConfiguration(nexusConfiguration(), '/etc/nexus/installation');
    const { runner, requests } = composedRunner(configuration, 'reviewer', async (request) => {
      await writeAssignedReport(request.prompt, 'The captured obligations are available.');
      return JSON.stringify({ verdict: 'approved' });
    });
    const { git } = scriptedGit([repositoryState({ headRevision })], { readDiff: () => ok('') });
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    await expect(reviewAction({ selectionFile, runner, git, github })()).resolves.toBe('approved');
    const prompt = requests[0]!.prompt;
    expect.soft(prompt).not.toContain('Limit records to 103 per batch');
    expect.soft(occurrences(prompt, JSON.stringify(marked))).toBe(4);
    expect.soft(occurrences(prompt, JSON.stringify(invalidLink))).toBe(2);
    expect(prompt).toContain(JSON.stringify(description));
    expect(prompt).toContain(JSON.stringify(unfamiliar));
    expect(prompt).toContain('Retained rich-text child that may be direction.');
    const recorded = await readReview(workspaceRoot, round);
    expect(await readEvidence(recorded.output, 'captured-source.json')).toEqual({
      issue: task,
      conversation,
    });
  });

  it('preserves unfamiliar retained object entries inline with uncertainty at the provider boundary', async () => {
    const conversation = [
      { id: 'retained-object', instruction: 'Keep retry cancellation available during shutdown.' },
      {
        id: 'retained-null-body',
        body: null,
        instruction: 'Keep the shutdown deadline.',
        source: 'retained-conversation',
      },
      {
        id: 'retained-extra-fields',
        body: 'A recognizable body does not prove the rest is administration.',
        instruction: 'Retain the cancellation control.',
      },
      {
        id: 'automated-object',
        author: { accountType: 'app' },
        instruction: 'Automated instruction stays referenced.',
      },
    ];
    const { workspaceRoot, selectionFile, round } = await workspace({ conversation });
    await writeDeliveredRound(workspaceRoot);
    const configuration = parseNexusConfiguration(nexusConfiguration(), '/etc/nexus/installation');
    const { runner, requests } = composedRunner(configuration, 'reviewer', async (request) => {
      await writeAssignedReport(request.prompt, 'The retained direction is available.');
      return JSON.stringify({ verdict: 'approved' });
    });
    const { git } = scriptedGit([repositoryState({ headRevision })], { readDiff: () => ok('') });
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    await expect(reviewAction({ selectionFile, runner, git, github })()).resolves.toBe('approved');
    const prompt = requests[0]!.prompt;
    expect.soft(prompt).toContain(JSON.stringify(conversation[0]));
    expect.soft(prompt).toContain(JSON.stringify(conversation[1]));
    expect.soft(prompt).toContain(JSON.stringify(conversation[2]));
    expect(prompt).not.toContain('Automated instruction stays referenced.');
    expect(occurrences(prompt, 'Origin uncertain')).toBe(3);
    const recorded = await readReview(workspaceRoot, round);
    const evidence = await readEvidence(recorded.output, 'captured-source.json');
    expect(evidence).toMatchObject({ conversation });
    expect(prompt).toContain(
      path.join(path.dirname(recorded.output.report.path), 'captured-source.json'),
    );
  });

  it('preserves inline comment sides and current/original ranges at the provider boundary', async () => {
    const pullRequestConversation = {
      comments: [],
      reviews: [],
      reviewComments: [
        {
          id: 41,
          body: 'Remove this obsolete branch.',
          user: { login: 'jane', type: 'User' },
          path: 'src/queue.ts',
          line: 12,
          start_line: 6,
          side: 'LEFT',
          start_side: 'LEFT',
          original_line: 20,
          original_start_line: 15,
          position: 9,
          original_position: 17,
          subject_type: 'line',
          commit_id: headRevision,
          original_commit_id: otherRevision,
          updated_at: '2026-10-07T10:30:00Z',
          pull_request_review_id: 77,
        },
        {
          id: 42,
          body: 'The earlier range still needs inspection.',
          user: { login: 'jane', type: 'User' },
          path: 'src/queue.ts',
          line: null,
          start_line: null,
          side: 'RIGHT',
          start_side: 'RIGHT',
          original_line: 28,
          original_start_line: 25,
          original_commit_id: otherRevision,
        },
      ],
    };
    const { workspaceRoot, selectionFile, round } = await workspace();
    await writeDeliveredRound(workspaceRoot);
    const configuration = parseNexusConfiguration(nexusConfiguration(), '/etc/nexus/installation');
    const { runner, requests } = composedRunner(configuration, 'reviewer', async (request) => {
      await writeAssignedReport(request.prompt, 'The captured locations are available.');
      return JSON.stringify({ verdict: 'approved' });
    });
    const { git } = scriptedGit([repositoryState({ headRevision })], { readDiff: () => ok('') });
    const { github } = scriptedGitHub({
      readConversation: () => ok(pullRequestConversation),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    await expect(reviewAction({ selectionFile, runner, git, github })()).resolves.toBe('approved');
    const prompt = requests[0]!.prompt;
    expect(prompt).toContain('file src/queue.ts line 12');
    for (const location of [
      'start_line 6',
      'side LEFT',
      'start_side LEFT',
      'original_line 20',
      'original_start_line 15',
      'position 9',
      'original_position 17',
      'subject_type line',
      'side RIGHT',
      'original_line 28',
      'original_start_line 25',
    ]) {
      expect.soft(prompt).toContain(location);
    }
    expect(prompt).toContain(`original revision ${otherRevision}`);
    expect(prompt).toContain('(edited at 2026-10-07T10:30:00Z)');
    expect(prompt).not.toContain('file src/queue.ts line 28');
    expect(prompt).toContain('review 77');
    const recorded = await readReview(workspaceRoot, round);
    expect(await readEvidence(recorded.output, 'pr-conversation.json')).toEqual(
      pullRequestConversation,
    );
    expect(prompt).toContain(
      path.join(path.dirname(recorded.output.report.path), 'pr-conversation.json'),
    );
  });

  it.each(['review', 'development'] as const)(
    'validates consumed earlier-round %s history before invoking the reviewer',
    async (damage) => {
      const { workspaceRoot, selectionFile } = await workspace({
        round: 3,
        name: `unusable-history-${damage}`,
      });
      await writeDeliveredRound(workspaceRoot);
      const savedReview = await saveReview(workspaceRoot, 1, 'The earlier revision looked right.');
      const developmentReport = path.join(
        workspaceRoot,
        'artifacts',
        '1',
        'reports',
        'dev-round-1',
        'developer.md',
      );
      await mkdir(path.dirname(developmentReport), { recursive: true });
      await writeFile(developmentReport, 'Built the first revision.', 'utf8');
      await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
        taskSubject: 'Implement the retry guard',
        taskKey: 'NEX-1',
        profile: 'dev-a',
        status: 'completed',
        baseRevision,
        headRevision,
        role: 'developer',
        report: { path: developmentReport },
        invocationId: 'dev-round-1',
        readinessFailure: null,
      });
      // Round two is the readable preceding assessment; round one is supporting history only, so
      // only the producer-owned history checks can catch its broken bound Markdown.
      await saveReview(workspaceRoot, 2, 'The guard is present.');
      const precedingDevelopment = path.join(
        workspaceRoot,
        'artifacts',
        '2',
        'reports',
        'dev-round-2',
        'developer.md',
      );
      await mkdir(path.dirname(precedingDevelopment), { recursive: true });
      await writeFile(precedingDevelopment, 'Repaired the guard.', 'utf8');
      await writeRoundArtifact(workspaceRoot, 2, 'development.json', {
        taskSubject: 'Implement the retry guard',
        taskKey: 'NEX-1',
        profile: 'dev-a',
        status: 'completed',
        baseRevision,
        headRevision,
        role: 'developer',
        report: { path: precedingDevelopment },
        invocationId: 'dev-round-2',
        readinessFailure: null,
      });
      if (damage === 'review') await rm(savedReview.reportFile);
      else await rm(developmentReport);

      const { runtime, requests } = scriptedRuntime(() => JSON.stringify({ verdict: 'approved' }));
      const { git } = scriptedGit([repositoryState({ headRevision })], { readDiff: () => ok('') });
      const { github, calls } = scriptedGitHub({
        readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      });

      await expect(
        reviewAction({ selectionFile, runner: runnerOf(runtime), git, github })(),
      ).rejects.toThrow(/does not exist|could not be read/);
      // The reviewer is never invoked and no verdict is published; the unusable history is
      // retained under the responsibility of the role that produced it.
      expect(requests).toEqual([]);
      expect(calls).toEqual(['conversation:7']);
      await expect(stat(path.join(workspaceRoot, 'artifacts', '3', 'review.json'))).rejects.toThrow(
        /ENOENT/,
      );
      const rejection = (await readValidationErrorHistory(workspaceRoot)).find(
        (entry) => entry.record.kind === 'validation-error',
      );
      expect(rejection?.record).toMatchObject(
        damage === 'review'
          ? {
              scope: reviewReportScope(workspaceRoot, 'NEX-1'),
              operation: 'review',
              assignedReport: { path: savedReview.reportFile },
            }
          : {
              scope: developmentReportScope(workspaceRoot, 'NEX-1'),
              operation: 'develop',
              assignedReport: { path: developmentReport },
            },
      );
    },
  );

  it.each(['earlier round', 'same round'] as const)(
    'rejects a preceding review of another task (%s) before invoking the reviewer',
    async (position) => {
      const { workspaceRoot, selectionFile } = await workspace({
        round: position === 'earlier round' ? 2 : 1,
        name: `foreign-preceding-${position === 'earlier round' ? 'earlier' : 'same'}`,
      });
      await writeDeliveredRound(workspaceRoot);
      const saved = await saveReview(workspaceRoot, 1, 'The change matches another task.', {
        taskKey: 'OTHER-42',
        ...(position === 'same round' ? { headRevision: otherRevision } : {}),
      });
      const { runtime, requests } = scriptedRuntime(() => JSON.stringify({ verdict: 'approved' }));
      const { git } = scriptedGit([repositoryState({ headRevision })], { readDiff: () => ok('') });
      const { github, calls } = scriptedGitHub({
        readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      });

      await expect(
        reviewAction({ selectionFile, runner: runnerOf(runtime), git, github })(),
      ).rejects.toThrow('is for task "OTHER-42", not "NEX-1"');
      expect(requests).toEqual([]);
      expect(calls).toEqual(['conversation:7']);
      const rejection = (await readValidationErrorHistory(workspaceRoot)).find(
        (entry) => entry.record.kind === 'validation-error',
      );
      expect(rejection?.record).toMatchObject({
        scope: reviewReportScope(workspaceRoot, 'NEX-1'),
        operation: 'review',
        assignedReport: { path: saved.reportFile },
      });
    },
  );

  it('keeps an earlier invocation snapshot readable after the selection source is refreshed', async () => {
    const refreshedConversation = [
      {
        id: 'r1',
        author: { displayName: 'Jane Doe', accountId: 'acc-jane', accountType: 'atlassian' },
        created: '2026-10-07T12:00:00.000+0000',
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Refreshed human clarification.' }],
            },
          ],
        },
      },
    ];
    const { workspaceRoot, selectionFile, round } = await workspace({ name: 'refresh' });
    await writeDeliveredRound(workspaceRoot);
    const first = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'First assessment.',
    );
    const { git: firstGit } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('first diff\n'),
    });
    const hub = () => ({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(first.runtime),
        git: firstGit,
        github: scriptedGitHub(hub()).github,
      })(),
    ).resolves.toBe('approved');
    const firstReview = await readReview(workspaceRoot, round);

    // The parent-owned boundary refreshes the mutable selection record after the assessment.
    const selection = JSON.parse(await readFile(selectionFile, 'utf8')) as Record<string, unknown>;
    await writeFile(
      selectionFile,
      `${JSON.stringify({ ...selection, conversation: refreshedConversation }, null, 2)}\n`,
      'utf8',
    );
    // The delivered revision advances within the round, so a fresh assessment is required.
    await writeDeliveredRound(workspaceRoot, { revision: otherRevision });
    const second = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'Second assessment.',
    );
    const { git: secondGit } = scriptedGit([repositoryState({ headRevision: otherRevision })], {
      readDiff: () => ok('second diff\n'),
    });
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(second.runtime),
        git: secondGit,
        github: scriptedGitHub(hub()).github,
      })(),
    ).resolves.toBe('approved');
    const secondReview = await readReview(workspaceRoot, round);

    // The earlier snapshot survives the refresh unchanged; the new invocation has its own paths.
    expect(path.dirname(secondReview.output.report.path)).not.toBe(
      path.dirname(firstReview.output.report.path),
    );
    expect(await readEvidence(firstReview.output, 'captured-source.json')).toEqual({
      issue: {
        id: '1',
        key: 'NEX-1',
        fields: { summary: 'Implement the retry guard', description: { type: 'doc', content: [] } },
      },
      conversation: [{ id: 'c1', body: 'Original request.' }],
    });
    expect(await readEvidence(secondReview.output, 'captured-source.json')).toEqual({
      issue: {
        id: '1',
        key: 'NEX-1',
        fields: { summary: 'Implement the retry guard', description: { type: 'doc', content: [] } },
      },
      conversation: refreshedConversation,
    });
    expect(await readEvidenceText(secondReview.output, 'comparison.diff')).toBe('second diff\n');
    const context = second.requests[0]?.context ?? '';
    expect(context).toContain('Refreshed human clarification.');
    expect(context).not.toContain('Original request.');
    expect(context).toContain(
      path.join(path.dirname(secondReview.output.report.path), 'captured-source.json'),
    );
    // The current round's preceding assessment is included in full for the changed head.
    expect(context).toContain('Previous review report (round 1, profile nexus-review');
    expect(context).toContain('First assessment.');
  });

  it('gives a retained fresh continuation its own evidence after an unusable attempt', async () => {
    const { workspaceRoot, selectionFile, round } = await workspace({ name: 'continuation' });
    await writeDeliveredRound(workspaceRoot);
    const hub = () => ({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok('diff --git a/feature.txt b/feature.txt\n+feature\n'),
    });

    // An unusable response leaves no saved outcome; its evidence stays readable.
    const unusable = scriptedRuntime(() => 'not a JSON report', 'Attempted assessment.');
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(unusable.runtime),
        git,
        github: scriptedGitHub(hub()).github,
      })(),
    ).rejects.toThrow(/unusable output/);
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', String(round), 'review.json')),
    ).rejects.toThrow(/ENOENT/);
    const attempts = await invocationDirectories(workspaceRoot, round);
    expect(attempts).toHaveLength(1);
    expect(
      await readFile(
        path.join(
          workspaceRoot,
          'artifacts',
          String(round),
          'reports',
          attempts[0]!,
          'captured-source.json',
        ),
        'utf8',
      ),
    ).toContain('Original request.');

    // The retained continuation assesses afresh, retains its own evidence and saves its outcome.
    const continuation = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'Continuation assessment.',
    );
    await expect(
      reviewAction({
        selectionFile,
        runner: runnerOf(continuation.runtime),
        git,
        github: scriptedGitHub(hub()).github,
      })(),
    ).resolves.toBe('approved');
    const recorded = await readReview(workspaceRoot, round);
    expect(recorded.report).toBe('Continuation assessment.');
    expect(await invocationDirectories(workspaceRoot, round)).toHaveLength(2);
    expect(await readEvidenceText(recorded.output, 'comparison.diff')).toBe(
      'diff --git a/feature.txt b/feature.txt\n+feature\n',
    );
    expect(continuation.requests[0]?.context).toContain(
      path.join(path.dirname(recorded.output.report.path), 'captured-source.json'),
    );
  });

  it.each([
    { label: 'empty', diff: '' },
    {
      label: 'large',
      diff:
        'diff --git a/big.txt b/big.txt\n' +
        Array.from({ length: 4000 }, (_, index) => `+line ${String(index)}\n`).join(''),
    },
  ])('stores the complete $label comparison diff without embedding it', async ({ diff }) => {
    const { workspaceRoot, selectionFile, round } = await workspace({ name: 'diff' });
    await writeDeliveredRound(workspaceRoot);
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'Approved.',
    );
    const { git } = scriptedGit([repositoryState({ headRevision })], {
      readDiff: () => ok(diff),
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

    const recorded = await readReview(workspaceRoot, round);
    const file = path.join(path.dirname(recorded.output.report.path), 'comparison.diff');
    expect(await readEvidenceText(recorded.output, 'comparison.diff')).toBe(diff);
    expect((await stat(file)).size).toBe(Buffer.byteLength(diff));
    const context = requests[0]?.context ?? '';
    expect(context).toContain(`valid empty diff): ${file}`);
    expect(context).not.toContain('diff --git');
    expect(context.length).toBeLessThan(diff.length + 20000);
  });

  it.each(['captured-source.json', 'comparison.diff'] as const)(
    'fails the fresh assessment when the %s evidence cannot be stored',
    async (name) => {
      const { workspaceRoot, selectionFile, round } = await workspace({
        name: `storage-${name}`,
      });
      await writeDeliveredRound(workspaceRoot);
      const { git } = scriptedGit([repositoryState({ headRevision })], {
        readDiff: async () => {
          await obstructEvidence(workspaceRoot, round, name);
          return ok('diff --git a/feature.txt b/feature.txt\n+feature\n');
        },
      });
      const { github } = scriptedGitHub({
        readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      });

      // Retention happens before the reviewer runs; the failure is an ordinary execution error
      // and no review outcome is saved.
      await expect(
        reviewAction({ selectionFile, runner: runnerOf(unusedRuntime()), git, github })(),
      ).rejects.toThrow(/could not be (retained|read)/);
      await expect(
        stat(path.join(workspaceRoot, 'artifacts', String(round), 'review.json')),
      ).rejects.toThrow(/ENOENT/);
    },
  );

  it('references evidence readable from a reviewer workspace beside another issue area', async () => {
    const repositoryArea = path.join(root, 'other-issue');
    await mkdir(path.join(repositoryArea, 'worktree'), { recursive: true });
    const { workspaceRoot, selectionFile, round } = await workspace({
      name: 'separate-area',
      repositoryWorkspace: { root: repositoryArea },
    });
    await writeDeliveredRound(workspaceRoot);
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ verdict: 'approved' }),
      'Approved.',
    );
    const { git } = scriptedGit([repositoryState({ headRevision })], { readDiff: () => ok('') });
    const { github } = scriptedGitHub({
      readConversation: () => ok({ comments: [], reviews: [], reviewComments: [] }),
      readChecks: () => ok([]),
      publishReview: () => ok({ id: 11, url: `https://github.com/${repository}/reviews/11` }),
      publishReviewCheck: () => ok({ id: 12 }),
    });

    await expect(
      reviewAction({ selectionFile, runner: runnerOf(runtime), git, github })(),
    ).resolves.toBe('approved');

    const recorded = await readReview(workspaceRoot, round);
    const context = requests[0]?.context ?? '';
    // The reviewer works in the recorded repository workspace; the evidence lives in the
    // reviewing issue's artifact area and is referenced by absolute path.
    expect(requests[0]?.workspaceRoot).toBe(repositoryArea);
    for (const name of ['captured-source.json', 'pr-conversation.json', 'comparison.diff']) {
      const file = path.join(path.dirname(recorded.output.report.path), name);
      expect(path.isAbsolute(file)).toBe(true);
      expect(file.startsWith(`${workspaceRoot}${path.sep}`)).toBe(true);
      expect(context).toContain(file);
      await expect(readFile(file)).resolves.toBeDefined();
    }
    expect(context).toContain(
      `Reviewed revision: ${headRevision} (comparison base ${baseRevision})`,
    );
  });
});
