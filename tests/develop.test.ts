/**
 * Component tests: the real Develop refreshes the source, assembles the round's invocation context
 * and binds the agent's report to the observed repository revisions over real temporary storage.
 * The agent runtime, Git adapter and Jira adapter are controlled; no provider, network or paid
 * turn is involved.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { developmentRoleInstructions, type AgentRuntime } from '../src/agent-runtime/index.js';
import type { RepositoryState } from '../src/adapters/git.js';
import { parseNexusConfiguration } from '../src/configuration/index.js';
import { ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { reportIdentityOf } from '../src/task-engine/actions/agent-reports.js';
import {
  devArtifact,
  developmentResponseSchema,
  type DevelopmentOutput,
} from '../src/task-engine/actions/develop/artifacts.js';
import { createDevelop } from '../src/task-engine/actions/develop/index.js';
import {
  outstandingReportFeedback,
  projectOfWorkspace,
  readReportFeedback,
  retainSuppliedFeedback,
} from '../src/task-engine/actions/report-feedback.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { composedRunner, runnerOf, writeAssignedReport } from './support/agent-runner.js';
import { nexusConfiguration } from './support/configuration.js';
import { repositoryState, scriptedGit } from './support/git.js';
import { strictSchemaProblems } from './support/provider-schema.js';

const baseRevision = '1'.repeat(40);
const headRevision = '2'.repeat(40);
const laterRevision = '3'.repeat(40);

/** How often the text contains the part. */
function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

let root = '';
let events: EngineEvent[] = [];
let workspaceCount = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-develop-'));
  events = [];
  workspaceCount = 0;
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
  report: ReportSource = 'Implemented and committed the retry guard.',
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

/** One workspace ready for a development round, with its selection record. */
async function workspace(
  options: {
    readonly round?: number;
    readonly taskKey?: string;
    readonly profile?: string;
  } = {},
): Promise<{
  readonly taskKey: string;
  readonly workspaceRoot: string;
  readonly round: number;
  readonly selectionFile: string;
}> {
  const taskKey = options.taskKey ?? 'NEX-1';
  const round = options.round ?? 1;
  const profile = options.profile ?? 'dev-a';
  workspaceCount += 1;
  const workspaceRoot = path.join(root, `workspace-${workspaceCount}`);
  await mkdir(path.join(workspaceRoot, 'state'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'artifacts', String(round)), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'worktree'), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, 'state', 'current-round.json'),
    `${JSON.stringify({ number: round, profile, reason: `Round ${round} uses "${profile}".` })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceRoot, 'state', 'prepared-workspace.json'),
    `${JSON.stringify(
      {
        taskKey,
        repository: '/origin/repository.git',
        branch: `task/${taskKey}`,
        baseRevision,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const selectionFile = path.join(root, 'executions', `selection-${workspaceCount}.json`);
  await mkdir(path.dirname(selectionFile), { recursive: true });
  await writeFile(
    selectionFile,
    `${JSON.stringify(
      {
        taskKey,
        source: { kind: 'jira', issueId: '1' },
        task: taskIssue,
        conversation: [{ id: 'c1', body: 'Original request.' }],
        workspace: { root: workspaceRoot },
        stage: 'delivery',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { taskKey, workspaceRoot, round, selectionFile };
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

/** Read one round's saved development outcome and its bound Markdown report text. */
async function readDevelopment(
  workspaceRoot: string,
  round: number,
): Promise<{ readonly output: DevelopmentOutput; readonly report: string }> {
  const output = (await readRoundArtifact(
    workspaceRoot,
    round,
    'development.json',
  )) as DevelopmentOutput;
  return { output, report: await readFile(output.report.path, 'utf8') };
}

const taskIssue = {
  id: '1',
  key: 'NEX-1',
  fields: {
    summary: 'Implement the retry guard',
    description: { type: 'doc', content: [] },
    status: { id: '2', name: 'In Progress' },
  },
};

/** The preceding review's Markdown: the current findings the repair invocation must address. */
const reviewMarkdown = [
  'The retry guard is still missing for transient provider failures.',
  '',
  'Evidence: the failing call returns immediately and no second attempt appears in the log.',
  '',
  'Required correction: retry the provider call once before reporting the failure, and include ' +
    'the attempt number in the log entry.',
].join('\n');

/** Write one round's bound review report and record, as the Review action saves them. */
async function writeBoundReview(
  workspaceRoot: string,
  round: number,
  revision: string,
  markdown: string,
): Promise<string> {
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
  await writeRoundArtifact(workspaceRoot, round, 'review.json', {
    taskKey: 'NEX-1',
    profile: 'reviewer',
    headRevision: revision,
    verdict: 'changesRequested',
    role: 'reviewer',
    report: { path: reportFile },
    reportIdentity: reportIdentityOf(Buffer.from(markdown, 'utf8')),
    invocationId: `rev-${String(round)}`,
  });
  return reportFile;
}

/** The outcome event Develop publishes for a workspace's saved round-one report. */
function developmentOutcome(
  workspaceRoot: string,
  status: DevelopmentOutput['status'],
  profile = 'dev-a',
): EngineEvent {
  return {
    source: 'develop',
    type: 'outcome',
    data: {
      task: 'NEX-1',
      round: 1,
      outcome: status,
      detail: `profile ${profile}`,
      artifact: {
        path: path.join(workspaceRoot, 'artifacts', '1', 'development.json'),
      },
    },
  };
}

describe('Develop', () => {
  it('implements the task and records the observed profile and revisions', async () => {
    const { taskKey, workspaceRoot, selectionFile } = await workspace();
    const { git } = scriptedGit([repositoryState(), repositoryState({ headRevision })]);
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ status: 'completed' }),
      'Implemented the retry guard.',
    );
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('completed');

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.profile).toBe('dev-a');
    expect(request?.workspaceRoot).toBe(workspaceRoot);
    // The action asks the provider for its own DevelopmentResponse shape, derived from the
    // schema that will validate the returned report, in the provider's strict structured-output
    // subset.
    expect(request?.outputSchema).toEqual(z.toJSONSchema(developmentResponseSchema));
    expect(strictSchemaProblems(request?.outputSchema)).toEqual([]);
    const context = request?.context ?? '';
    // The parent-owned boundary refreshed the saved task and conversation before this round.
    expect(context).toContain('Implement the retry guard');
    expect(context).toContain(`Prepared branch: task/${taskKey} (comparison base ${baseRevision})`);
    expect(context).toContain(
      `Local selection record (refreshed task and complete conversation): ${selectionFile}`,
    );
    expect(context).toContain('No previous review report is retained for this round.');
    expect(context).toContain('Earlier rounds: none.');
    // The invocation instructions assign the Markdown report and reserve the action-owned record.
    expect(context).toContain('Assigned Markdown report: ');
    expect(context).toContain('Write your complete report to that path');
    expect(context).toContain('development.json');
    expect(context).not.toContain('findingResponses');
    // The action leaves the parent-owned selection record unchanged.
    expect(JSON.parse(await readFile(selectionFile, 'utf8'))).toEqual({
      taskKey,
      source: { kind: 'jira', issueId: '1' },
      task: taskIssue,
      conversation: [{ id: 'c1', body: 'Original request.' }],
      workspace: { root: workspaceRoot },
      stage: 'delivery',
    });
    // No extra persistent record is introduced for the conversation.
    expect((await readdir(path.join(workspaceRoot, 'state'))).sort()).toEqual([
      'current-round.json',
      'prepared-workspace.json',
    ]);

    const { output, report } = await readDevelopment(workspaceRoot, 1);
    expect(output).toMatchObject({
      taskSubject: 'Implement the retry guard',
      taskKey,
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      role: 'developer',
      readinessFailure: null,
    });
    expect(output.report.path).toContain(path.join('artifacts', '1', 'reports'));
    expect(output.report.path).not.toContain(path.join('worktree', ''));
    expect(output.reportIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(output.invocationId).toBeTruthy();
    expect(report).toBe('Implemented the retry guard.');
    expect(context).toContain(`Assigned Markdown report: ${output.report.path}`);
    // The invocation boundaries belong to the caller's agent runner, not to the action.
    expect(events).toEqual([developmentOutcome(workspaceRoot, 'completed')]);
  });

  it('records failed with the agent Markdown when the turn reports incomplete work', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    const { git } = scriptedGit([repositoryState(), repositoryState()]);
    const { runtime } = scriptedRuntime(
      () => JSON.stringify({ status: 'failed' }),
      'The parser change needs a decision that is missing from the task.',
    );
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('failed');

    const { output, report } = await readDevelopment(workspaceRoot, 1);
    expect(output).toMatchObject({
      status: 'failed',
      baseRevision,
      headRevision: baseRevision,
      readinessFailure: null,
    });
    expect(report).toBe('The parser change needs a decision that is missing from the task.');
    expect(events).toEqual([
      {
        source: 'develop',
        type: 'failed',
        data: { reason: expect.stringContaining('reported incomplete work') },
      },
      developmentOutcome(workspaceRoot, 'failed'),
    ]);
  });

  it('records failed when a completed turn leaves uncommitted or misplaced work', async () => {
    const cases: ReadonlyArray<readonly [string, RepositoryState, RegExp]> = [
      ['tracked changes', repositoryState({ headRevision, trackedChanges: true }), /uncommitted/],
      ['another branch', repositoryState({ headRevision, branch: 'feature' }), /"feature"/],
    ];

    for (const [label, observation, expected] of cases) {
      events = [];
      const { workspaceRoot, selectionFile } = await workspace();
      const { git } = scriptedGit([repositoryState(), observation]);
      const { runtime } = scriptedRuntime(
        () => JSON.stringify({ status: 'completed' }),
        'Implemented the retry guard.',
      );
      const develop = createDevelop({
        selectionFile,
        runner: runnerOf(runtime),
        git,
        publish: (event) => events.push(event),
      });

      await expect(develop(), label).resolves.toBe('failed');

      const { output, report } = await readDevelopment(workspaceRoot, 1);
      expect(output, label).toMatchObject({ status: 'failed', headRevision });
      // The agent's Markdown stays unchanged, and the observed readiness failure is durable.
      expect(report, label).toContain('Implemented the retry guard.');
      expect(output.readinessFailure, label).toMatch(expected);
      expect(events.at(-2), label).toEqual({
        source: 'develop',
        type: 'failed',
        data: { reason: expect.stringMatching(expected) },
      });
      expect(events.at(-1), label).toEqual(developmentOutcome(workspaceRoot, 'failed'));
    }
  });

  it('accepts the untracked dependencies and verification output a completed turn leaves', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    // Installing dependencies or running focused checks leaves untracked files; they do not make
    // the committed revision unreviewable.
    const { git } = scriptedGit([
      repositoryState(),
      repositoryState({ headRevision, untrackedChanges: true }),
    ]);
    const { runtime } = scriptedRuntime(
      () => JSON.stringify({ status: 'completed' }),
      'Implemented the retry guard.',
    );
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('completed');

    const { output, report } = await readDevelopment(workspaceRoot, 1);
    expect(output).toMatchObject({
      taskSubject: 'Implement the retry guard',
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      role: 'developer',
      readinessFailure: null,
    });
    expect(report).toBe('Implemented the retry guard.');
    expect(events).toEqual([developmentOutcome(workspaceRoot, 'completed')]);
  });

  it('carries the observed readiness failure into the next repair invocation', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    const first = scriptedRuntime(
      () => JSON.stringify({ status: 'completed' }),
      'Implemented the retry guard.',
    );
    const { git: firstGit } = scriptedGit([
      repositoryState(),
      repositoryState({ headRevision, trackedChanges: true }),
    ]);
    await expect(
      createDevelop({
        selectionFile,
        runner: runnerOf(first.runtime),
        git: firstGit,
        publish: (event) => events.push(event),
      })(),
    ).resolves.toBe('failed');

    const recorded = await readDevelopment(workspaceRoot, 1);
    expect(recorded.report).toContain('Implemented the retry guard.');
    expect(recorded.output.readinessFailure).toContain('tracked changes are uncommitted');

    // The next round repairs; its context names the failed report, whose summary keeps the reason.
    await writeFile(
      path.join(workspaceRoot, 'state', 'current-round.json'),
      `${JSON.stringify({ number: 2, profile: 'dev-a', reason: 'The repair continues.' })}\n`,
      'utf8',
    );
    await mkdir(path.join(workspaceRoot, 'artifacts', '2'), { recursive: true });

    let priorReport: string | null = null;
    let priorReadiness: string | null = null;
    const repair = scriptedRuntime(async (request) => {
      const match = /development report \(failed[^)]*\): (.+)$/m.exec(request.context);
      const reportFile = match?.[1]?.trim();
      if (reportFile === undefined) {
        throw new Error('The context does not name the failed development report.');
      }
      priorReport = await readFile(reportFile, 'utf8');
      priorReadiness = /readiness failure: ([^)]*)\)/.exec(request.context)?.[1] ?? null;
      return JSON.stringify({ status: 'completed' });
    }, 'Committed the retained work.');
    const { git: repairGit } = scriptedGit([
      repositoryState({ trackedChanges: true }),
      repositoryState({ headRevision }),
    ]);
    await expect(
      createDevelop({
        selectionFile,
        runner: runnerOf(repair.runtime),
        git: repairGit,
        publish: (event) => events.push(event),
      })(),
    ).resolves.toBe('completed');

    expect(priorReport).toBe('Implemented the retry guard.');
    expect(priorReadiness).toContain('tracked changes are uncommitted');
  });

  it("repairs the preceding review's findings with the round plan's profile", async () => {
    const { workspaceRoot, selectionFile } = await workspace({ round: 2, profile: 'dev-b' });
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'First implementation.',
    });
    const reviewReportFile = await writeBoundReview(workspaceRoot, 1, headRevision, reviewMarkdown);
    await writeRoundArtifact(workspaceRoot, 1, 'verification.json', {
      headRevision,
      status: 'failed',
      checks: [
        {
          name: 'validate',
          exitCode: 1,
          stdoutPath: 'checks/0/stdout.log',
          stderrPath: 'checks/0/stderr.log',
        },
      ],
    });
    const { git } = scriptedGit([
      repositoryState({ headRevision }),
      repositoryState({ headRevision: laterRevision }),
    ]);
    const repairMarkdown =
      'Repaired the retry guard and the attempt log. The previous review was right about both.';
    const { runtime, requests } = scriptedRuntime(
      () => JSON.stringify({ status: 'completed' }),
      repairMarkdown,
    );
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('completed');

    expect(requests[0]?.profile).toBe('dev-b');
    const context = requests[0]?.context ?? '';
    // The complete preceding review report is repair context: its findings reach the developer
    // without an eligible-ID set, response array or per-finding obligation.
    expect(context).toContain(
      'Most recent review report (round 1, profile reviewer, invocation rev-1, reviewed revision',
    );
    expect(context).toContain('verdict changesRequested; repair context');
    expect(context).toContain(reviewMarkdown);
    expect(context).not.toContain('Eligible prior finding IDs');
    expect(context).toContain(
      `- Round 1:\n  - development report (completed, profile dev-a; retained combined record): ${path.join(workspaceRoot, 'artifacts', '1', 'development.json')}`,
    );
    expect(context).toContain('Latest recorded verification (round 1): failed.');
    expect(context).toContain(
      path.join(workspaceRoot, 'artifacts', '1', 'checks', '0', 'stdout.log'),
    );
    expect(context).toContain(reviewReportFile);

    const repaired = await readDevelopment(workspaceRoot, 2);
    expect(repaired.output).toMatchObject({
      profile: 'dev-b',
      status: 'completed',
      headRevision: laterRevision,
    });
    expect(repaired.report).toBe(repairMarkdown);
  });

  it('delivers the developer coherence obligations on every ladder profile and a repair', async () => {
    const configuration = parseNexusConfiguration(nexusConfiguration(), '/etc/nexus/installation');
    const ladder = configuration.executionPolicy.developerLadder;
    // The configured ladder must actually escalate for this check to mean anything.
    expect(ladder.length).toBeGreaterThan(1);
    const obligations = [
      "Apply the project's existing design and ownership principles",
      'Reconcile affected existing intent',
      'Remove superseded rules and mechanisms together with dependent validation',
      'confirmed shared ownership cause',
      'Complete this reconciliation before review',
      'preserve task scope and the existing gates',
    ];

    for (const entry of ladder) {
      const { taskKey, workspaceRoot, selectionFile } = await workspace({
        profile: entry.profile,
      });
      const { git } = scriptedGit([repositoryState(), repositoryState({ headRevision })]);
      const { runner, requests } = composedRunner(configuration, 'developer', async (request) => {
        await writeAssignedReport(request.prompt, 'Implemented the retry guard.');
        return JSON.stringify({ status: 'completed' });
      });
      const develop = createDevelop({
        selectionFile,
        runner,
        git,
        publish: (event) => events.push(event),
      });

      await expect(develop()).resolves.toBe('completed');

      const prompt = requests[0]!.prompt;
      for (const obligation of obligations) {
        expect(occurrences(prompt, obligation), `${entry.profile}: ${obligation}`).toBe(1);
      }
      expect(
        occurrences(prompt, developmentRoleInstructions.join('\n\n')),
        `${entry.profile} role constant`,
      ).toBe(1);
      for (const instruction of developmentRoleInstructions) {
        expect(prompt, `${entry.profile} role identity`).toContain(instruction);
      }
      // The complete task input reaches the provider alongside the role.
      expect(prompt).toContain(`Task ${taskKey}`);
      expect(prompt).toContain('Implement the retry guard');
      expect(prompt).toContain(
        `Prepared branch: task/${taskKey} (comparison base ${baseRevision})`,
      );
      expect(prompt).toContain('No previous review report is retained for this round.');
      expect(prompt).toContain(
        `Local selection record (refreshed task and complete conversation): ${selectionFile}`,
      );
      expect(requests[0]!.directory).toBe(path.join(workspaceRoot, 'worktree'));
    }

    // A repair invocation keeps the same obligations with the complete finding handoff.
    const { workspaceRoot, selectionFile } = await workspace({
      round: 2,
      profile: ladder[1]!.profile,
    });
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskKey: 'NEX-1',
      profile: ladder[0]!.profile,
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'First implementation.',
    });
    await writeBoundReview(workspaceRoot, 1, headRevision, reviewMarkdown);
    await writeRoundArtifact(workspaceRoot, 1, 'verification.json', {
      headRevision,
      status: 'failed',
      checks: [
        {
          name: 'validate',
          exitCode: 1,
          stdoutPath: 'checks/0/stdout.log',
          stderrPath: 'checks/0/stderr.log',
        },
      ],
    });
    const { git } = scriptedGit([
      repositoryState({ headRevision }),
      repositoryState({ headRevision: laterRevision }),
    ]);
    const { runner, requests } = composedRunner(configuration, 'developer', async (request) => {
      await writeAssignedReport(request.prompt, 'Repaired the retry guard.');
      return JSON.stringify({ status: 'completed' });
    });
    const develop = createDevelop({
      selectionFile,
      runner,
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('completed');

    const prompt = requests[0]!.prompt;
    for (const obligation of obligations) {
      expect(occurrences(prompt, obligation), `repair: ${obligation}`).toBe(1);
    }
    expect(prompt).toContain('Most recent review report (round 1, profile reviewer');
    expect(prompt).toContain(reviewMarkdown);
    expect(prompt).toContain('Latest recorded verification (round 1): failed.');
  });

  it('rejects a report carrying the removed finding-response field without writing it', async () => {
    const { workspaceRoot, selectionFile } = await workspace({ round: 2 });
    await writeBoundReview(workspaceRoot, 1, headRevision, reviewMarkdown);
    const { git } = scriptedGit([repositoryState({ headRevision })]);
    const { runtime } = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Repaired.',
        findingResponses: [
          { findingId: 'NEX-1-finding-1', status: 'addressed', response: 'Addressed.' },
        ],
      }),
    );
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    // New responses are strict: the removed lifecycle field is unusable output, not a report to
    // save or an answered finding set.
    await expect(develop()).rejects.toThrow(/does not match the response format/);
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '2', 'development.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('reuses a current-round report that still describes the current work', async () => {
    const { taskKey, workspaceRoot, selectionFile } = await workspace();
    // A report retained by the earlier contract still describes this work: its former
    // finding-response array is preserved as history and the report is reused unchanged.
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskSubject: 'Implement the retry guard',
      taskKey,
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'Implemented the retry guard.',
      findingResponses: [{ findingId: 'NEX-1-finding-1', status: 'addressed', response: 'Done.' }],
    });
    const retainedBytes = await readFile(
      path.join(workspaceRoot, 'artifacts', '1', 'development.json'),
      'utf8',
    );
    const { git } = scriptedGit([repositoryState({ headRevision })]);
    const { runtime, requests } = scriptedRuntime(() => {
      throw new Error('The agent must not be invoked again.');
    });
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('completed');

    expect(requests).toEqual([]);
    // The reused report stays the saved output the outcome event references.
    expect(events).toEqual([developmentOutcome(workspaceRoot, 'completed')]);
    // Reading the retained report never rewrites its complete recorded history.
    expect(
      await readFile(path.join(workspaceRoot, 'artifacts', '1', 'development.json'), 'utf8'),
    ).toBe(retainedBytes);
  });

  it('reuses a readable bound report and rejects a binding whose Markdown is missing', async () => {
    const { taskKey, workspaceRoot, selectionFile } = await workspace();
    const helpers = createArtifactHelpers({ root: workspaceRoot });
    const markdown = 'Implemented the retry guard and committed it.';
    const reportFile = path.join(
      workspaceRoot,
      'artifacts',
      '1',
      'reports',
      'dev-1',
      'developer.md',
    );
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, markdown, 'utf8');
    const saved: DevelopmentOutput = {
      taskSubject: 'Implement the retry guard',
      taskKey,
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      role: 'developer',
      report: { path: reportFile },
      reportIdentity: reportIdentityOf(Buffer.from(markdown, 'utf8')),
      invocationId: 'dev-1',
      readinessFailure: null,
    };
    await helpers.writeOutputArtifact(devArtifact, saved);
    const replay = scriptedRuntime(() => {
      throw new Error('The agent must not be invoked again.');
    });
    await expect(
      createDevelop({
        selectionFile,
        runner: runnerOf(replay.runtime),
        git: scriptedGit([repositoryState({ headRevision })]).git,
        publish: (event) => events.push(event),
      })(),
    ).resolves.toBe('completed');
    expect(replay.requests).toEqual([]);
    expect(events).toEqual([developmentOutcome(workspaceRoot, 'completed')]);

    // The bound Markdown must stay readable: a missing report is unusable output rather than a
    // reused outcome, and its rejection names the attempted path without a copy to retain.
    await rm(reportFile);
    await expect(
      createDevelop({
        selectionFile,
        runner: runnerOf(scriptedRuntime(() => 'unused').runtime),
        git: scriptedGit([repositoryState({ headRevision })]).git,
        publish: (event) => events.push(event),
      })(),
    ).rejects.toThrow(/does not exist/);
    const rejection = (await readReportFeedback(workspaceRoot)).find(
      (entry) => entry.record.kind === 'rejection',
    );
    expect(rejection?.record).toMatchObject({
      scope: {
        project: projectOfWorkspace(workspaceRoot),
        workId: taskKey,
        area: workspaceRoot,
        role: 'developer',
        reportKind: 'development',
      },
      operation: 'develop',
      assignedReport: { path: reportFile },
      report: null,
    });
  });

  it('binds its own metadata, rejects agent claims about it and rejects a wrong report shape', async () => {
    const observed = await workspace();
    const { git } = scriptedGit([repositoryState(), repositoryState({ headRevision })]);
    const { runtime } = scriptedRuntime(
      () => JSON.stringify({ status: 'completed' }),
      'Implemented the retry guard.',
    );
    await expect(
      createDevelop({
        selectionFile: observed.selectionFile,
        runner: runnerOf(runtime),
        git,
        publish: (event) => events.push(event),
      })(),
    ).resolves.toBe('completed');

    const observedOutput = await readDevelopment(observed.workspaceRoot, 1);
    expect(observedOutput.output).toMatchObject({
      taskSubject: 'Implement the retry guard',
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      role: 'developer',
      readinessFailure: null,
    });
    expect(observedOutput.report).toBe('Implemented the retry guard.');

    // A report claiming the metadata the action owns violates the response contract instead of
    // having those claims silently replaced by the observed values.
    const claiming = await workspace();
    const { runtime: claimingRuntime } = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Implemented the retry guard.',
        profile: 'claimed-profile',
        baseRevision: laterRevision,
        headRevision: laterRevision,
      }),
    );
    await expect(
      createDevelop({
        selectionFile: claiming.selectionFile,
        runner: runnerOf(claimingRuntime),
        git,
        publish: (event) => events.push(event),
      })(),
    ).rejects.toThrow(/"profile", "baseRevision", "headRevision"/);
    await expect(
      stat(path.join(claiming.workspaceRoot, 'artifacts', '1', 'development.json')),
    ).rejects.toThrow(/ENOENT/);

    const wrong = await workspace();
    const { runtime: wrongRuntime } = scriptedRuntime(() =>
      JSON.stringify({ status: 'done', summary: 'Finished.' }),
    );
    await expect(
      createDevelop({
        selectionFile: wrong.selectionFile,
        runner: runnerOf(wrongRuntime),
        git,
        publish: (event) => events.push(event),
      })(),
    ).rejects.toThrow(/does not match the response format/);
  });

  it('invokes the agent again when the current-round report describes another revision', async () => {
    const { taskKey, workspaceRoot, selectionFile } = await workspace();
    const helpers = createArtifactHelpers({ root: workspaceRoot });
    await helpers.writeOutputArtifact(devArtifact, {
      taskKey,
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision: laterRevision,
      summary: 'Report for another revision.',
    });
    const { git } = scriptedGit([
      repositoryState({ headRevision }),
      repositoryState({ headRevision }),
    ]);
    const { runtime, requests } = scriptedRuntime(() => JSON.stringify({ status: 'completed' }));
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('completed');

    expect(requests).toHaveLength(1);
    const { output, report } = await readDevelopment(workspaceRoot, 1);
    expect(output).toMatchObject({ headRevision, status: 'completed' });
    expect(report).toBe('Implemented and committed the retry guard.');
  });

  it('treats unusable agent output as an execution error', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    const { git } = scriptedGit([repositoryState(), repositoryState()]);
    const { runtime, requests } = scriptedRuntime(() => 'not a JSON report');
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).rejects.toThrow(/unusable output/);
    // The requested structured-output schema never replaces the action's own validation.
    expect(requests[0]?.outputSchema).toEqual(z.toJSONSchema(developmentResponseSchema));
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '1', 'development.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('rejects a valid outcome whose assigned Markdown report was never written', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    const { git } = scriptedGit([repositoryState(), repositoryState({ headRevision })]);
    const { runtime } = scriptedRuntime(() => JSON.stringify({ status: 'completed' }), null);
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).rejects.toThrow(/Assigned development report at ".*" does not exist/);
    await expect(
      stat(path.join(workspaceRoot, 'artifacts', '1', 'development.json')),
    ).rejects.toThrow(/ENOENT/);
    // The valid control value cannot save an outcome without its readable report; the rejection
    // keeps the attempted path and records the unavailable Markdown explicitly.
    const rejection = (await readReportFeedback(workspaceRoot)).find(
      (entry) => entry.record.kind === 'rejection',
    );
    expect(rejection?.record).toMatchObject({
      operation: 'develop',
      output: JSON.stringify({ status: 'completed' }),
      report: null,
      assignedReport: expect.objectContaining({ path: expect.stringContaining('reports') }),
    });
  });

  it.each(['malformed', 'unreadable'] as const)(
    'preserves %s development history and supplies it to the repair round',
    async (kind) => {
      const { taskKey, workspaceRoot, selectionFile } = await workspace({ round: 2 });
      const retainedFile = path.join(workspaceRoot, 'artifacts', '1', 'development.json');
      const malformed = '{"status":"completed",';
      await mkdir(path.dirname(retainedFile), { recursive: true });
      const reason = kind === 'malformed' ? 'is not valid JSON' : 'could not be read';
      const output = kind === 'malformed' ? malformed : null;
      if (kind === 'malformed') await writeFile(retainedFile, malformed, 'utf8');
      else await mkdir(retainedFile);
      const scope = {
        project: projectOfWorkspace(workspaceRoot),
        workId: taskKey,
        area: workspaceRoot,
        role: 'developer',
        reportKind: 'development',
      };
      const unused = scriptedRuntime(() => {
        throw new Error('The invocation must not run while the retained report is unusable.');
      });
      await expect(
        createDevelop({
          selectionFile,
          runner: runnerOf(unused.runtime),
          git: scriptedGit([]).git,
          publish: (event) => events.push(event),
        })(),
      ).rejects.toThrow(reason);

      // The malformed retained report is preserved with its bytes, path and validation reason under
      // the developer's report responsibility.
      expect(unused.requests).toHaveLength(0);
      const retainedRejection = (await readReportFeedback(workspaceRoot)).find(
        (entry) => entry.record.kind === 'rejection',
      );
      expect(retainedRejection?.record).toMatchObject({
        scope,
        operation: 'develop',
        source: { path: retainedFile },
        output,
        reason: expect.stringContaining(reason),
      });

      await rm(retainedFile, { recursive: true });

      // Repairing the file alone does not retire the feedback.
      await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
        taskKey,
        profile: 'dev-a',
        status: 'completed',
        baseRevision,
        headRevision,
        summary: 'The repaired round-one report.',
      });
      await expect(
        outstandingReportFeedback({ areaRoot: workspaceRoot, scope }),
      ).resolves.toHaveLength(1);
      await expect(
        readFile(
          path.join(workspaceRoot, 'report-feedback', path.basename(retainedRejection!.path)),
          'utf8',
        ),
      ).resolves.toContain(reason);

      // The next permitted invocation receives the retained rejection; its validated saved
      // replacement records the correction that retires it.
      const repair = scriptedRuntime(
        () => JSON.stringify({ status: 'completed' }),
        'Repaired the round-one report.',
      );
      await expect(
        createDevelop({
          selectionFile,
          runner: runnerOf(repair.runtime),
          git: scriptedGit([repositoryState(), repositoryState({ headRevision })]).git,
          publish: (event) => events.push(event),
        })(),
      ).resolves.toBe('completed');
      const context = repair.requests[0]?.context ?? '';
      expect(context).toContain('Outstanding report rejection');
      expect(context).toContain(reason);
      expect(context).toContain(output ?? 'The rejected output itself is unavailable');
      expect(context).toContain(retainedFile);
      await expect(outstandingReportFeedback({ areaRoot: workspaceRoot, scope })).resolves.toEqual(
        [],
      );
      const records = await readReportFeedback(workspaceRoot);
      expect(records.filter((entry) => entry.record.kind === 'rejection')).toHaveLength(1);
      expect(records.filter((entry) => entry.record.kind === 'correction')).toHaveLength(1);
    },
  );

  it('routes rejection feedback to the selected issue root when the repository is borrowed', async () => {
    const { taskKey, workspaceRoot, selectionFile } = await workspace();
    // The prepared identity continues another issue's checkout; the selected issue keeps the
    // rounds, and the report feedback belongs to it rather than to the donor.
    const donorRoot = path.join(root, 'donor-issue');
    await mkdir(path.join(donorRoot, 'worktree'), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, 'state', 'prepared-workspace.json'),
      `${JSON.stringify(
        {
          taskKey,
          repository: '/donor/repository.git',
          repositoryWorkspace: { root: donorRoot },
          branch: `task/${taskKey}`,
          baseRevision,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const rejected = createDevelop({
      selectionFile,
      runner: runnerOf(scriptedRuntime(() => 'not a JSON report').runtime),
      git: scriptedGit([repositoryState()]).git,
      publish: (event) => events.push(event),
    });
    await expect(rejected()).rejects.toThrow(/unusable output/);

    const scope = {
      project: path.basename(root),
      workId: taskKey,
      area: workspaceRoot,
      role: 'developer',
      reportKind: 'development',
    };
    const rejection = (await readReportFeedback(workspaceRoot)).find(
      (entry) => entry.record.kind === 'rejection',
    );
    expect(rejection?.record).toMatchObject({
      scope,
      operation: 'develop',
      output: 'not a JSON report',
      reason: expect.stringContaining('unusable output'),
    });
    await expect(stat(path.join(donorRoot, 'report-feedback'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Mere reuse of a retained artifact never records a correction: the rejection stays
    // outstanding until a producer-validated saved replacement resolves it.
    await writeFile(
      path.join(workspaceRoot, 'artifacts', '1', 'development.json'),
      JSON.stringify({
        taskSubject: 'Implement the retry guard',
        taskKey,
        profile: 'dev-a',
        status: 'completed',
        baseRevision,
        headRevision,
        summary: 'Retained report.',
        findingResponses: [],
      }),
    );
    const replay = scriptedRuntime(() => {
      throw new Error('the retained report must be reused without an invocation');
    });
    const reused = createDevelop({
      selectionFile,
      runner: runnerOf(replay.runtime),
      git: scriptedGit([repositoryState({ headRevision })]).git,
      publish: (event) => events.push(event),
    });
    await expect(reused()).resolves.toBe('completed');
    expect(replay.requests).toHaveLength(0);
    await expect(
      outstandingReportFeedback({ areaRoot: workspaceRoot, scope }),
    ).resolves.toHaveLength(1);

    // The next permitted invocation receives the rejection; its validated saved replacement
    // records the correction that retires it.
    await rm(path.join(workspaceRoot, 'artifacts', '1', 'development.json'));
    const retry = scriptedRuntime(() => JSON.stringify({ status: 'completed' }));
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(retry.runtime),
      git: scriptedGit([repositoryState(), repositoryState({ headRevision })]).git,
      publish: (event) => events.push(event),
    });
    await expect(develop()).resolves.toBe('completed');
    expect(retry.requests[0]?.context).toContain('Violated rule:');
    expect(retry.requests[0]?.context).toContain('not a JSON report');
    await expect(outstandingReportFeedback({ areaRoot: workspaceRoot, scope })).resolves.toEqual(
      [],
    );
  });

  it('finishes the correction its saved outcome owes when a repetition reuses it', async () => {
    const { taskKey, workspaceRoot, selectionFile } = await workspace();
    // A rejected invocation leaves an outstanding rejection for the developer responsibility.
    await expect(
      createDevelop({
        selectionFile,
        runner: runnerOf(scriptedRuntime(() => 'not a JSON report').runtime),
        git: scriptedGit([repositoryState()]).git,
        publish: (event) => events.push(event),
      })(),
    ).rejects.toThrow(/unusable output/);
    const scope = {
      project: projectOfWorkspace(workspaceRoot),
      workId: taskKey,
      area: workspaceRoot,
      role: 'developer',
      reportKind: 'development',
    };
    const rejections = await outstandingReportFeedback({ areaRoot: workspaceRoot, scope });
    expect(rejections).toHaveLength(1);

    // A later invocation saved its validated replacement and was interrupted before recording the
    // correction: the saved outcome names its invocation and the supplied evidence names the
    // rejection it answered.
    const markdown = 'Repaired the retry guard.';
    const reportFile = path.join(
      workspaceRoot,
      'artifacts',
      '1',
      'reports',
      'repair-1',
      'developer.md',
    );
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, markdown, 'utf8');
    const saved: DevelopmentOutput = {
      taskSubject: 'Implement the retry guard',
      taskKey,
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      role: 'developer',
      report: { path: reportFile },
      reportIdentity: reportIdentityOf(Buffer.from(markdown, 'utf8')),
      invocationId: 'repair-1',
      readinessFailure: null,
    };
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', saved);
    await retainSuppliedFeedback({
      areaRoot: workspaceRoot,
      invocationId: 'repair-1',
      rejections: rejections.map((entry) => ({ path: entry.path })),
    });

    const unused = scriptedRuntime(() => {
      throw new Error('The saved outcome must be reused without another invocation.');
    });
    await expect(
      createDevelop({
        selectionFile,
        runner: runnerOf(unused.runtime),
        git: scriptedGit([repositoryState({ headRevision })]).git,
        publish: (event) => events.push(event),
      })(),
    ).resolves.toBe('completed');
    expect(unused.requests).toHaveLength(0);
    await expect(outstandingReportFeedback({ areaRoot: workspaceRoot, scope })).resolves.toEqual(
      [],
    );
    const records = await readReportFeedback(workspaceRoot);
    expect(records.filter((entry) => entry.record.kind === 'rejection')).toHaveLength(1);
    expect(records.filter((entry) => entry.record.kind === 'correction')).toHaveLength(1);
  });
});
