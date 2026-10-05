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
import type { AgentRuntime } from '../src/agent-runtime/index.js';
import type { RepositoryState } from '../src/adapters/git.js';
import { ok } from '../src/result.js';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import {
  devArtifact,
  developmentResponseSchema,
  type DevelopmentOutput,
  type FindingResponse,
} from '../src/task-engine/actions/develop/artifacts.js';
import { createDevelop } from '../src/task-engine/actions/develop/index.js';
import {
  outstandingReportFeedback,
  projectOfWorkspace,
  readReportFeedback,
} from '../src/task-engine/actions/report-feedback.js';
import type { Finding, ReviewOutput } from '../src/task-engine/actions/review/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { runnerOf } from './support/agent-runner.js';
import { repositoryState, scriptedGit } from './support/git.js';
import { strictSchemaProblems } from './support/provider-schema.js';

const baseRevision = '1'.repeat(40);
const headRevision = '2'.repeat(40);
const laterRevision = '3'.repeat(40);

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

const taskIssue = {
  id: '1',
  key: 'NEX-1',
  fields: {
    summary: 'Implement the retry guard',
    description: { type: 'doc', content: [] },
    status: { id: '2', name: 'In Progress' },
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

const secondFinding: Finding = {
  id: 'NEX-1-finding-2',
  title: 'Retry log entry omits the attempt number',
  severity: 'non-blocking',
  basis: 'The design requires a log entry to identify the attempt.',
  evidence: 'The logged line names the operation only.',
  impact: 'Operators cannot match the log entries to attempts.',
  repairGuidance: 'Include the attempt number in the log entry.',
  locations: [],
};

const precedingReview: ReviewOutput = {
  profile: 'reviewer',
  headRevision,
  verdict: 'changesRequested',
  summary: 'The retry guard is missing.',
  findings: [blockingFinding, secondFinding],
  priorFindings: [],
};

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
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Implemented the retry guard.',
        findingResponses: [],
      }),
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
    expect(context).toContain('No review findings are supplied for this round.');
    expect(context).toContain('Earlier rounds: none.');
    expect(context).toContain(
      'Include exactly one findingResponses entry for every supplied finding ID and no others',
    );
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

    expect(await readRoundArtifact(workspaceRoot, 1, 'development.json')).toEqual({
      taskSubject: 'Implement the retry guard',
      taskKey,
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'Implemented the retry guard.',
      findingResponses: [],
    });
    // The invocation boundaries belong to the caller's agent runner, not to the action.
    expect(events).toEqual([developmentOutcome(workspaceRoot, 'completed')]);
  });

  it('records failed with the agent summary when the turn reports incomplete work', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    const { git } = scriptedGit([repositoryState(), repositoryState()]);
    const { runtime } = scriptedRuntime(() =>
      JSON.stringify({
        status: 'failed',
        summary: 'The parser change needs a decision that is missing from the task.',
        findingResponses: [],
      }),
    );
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('failed');

    expect(await readRoundArtifact(workspaceRoot, 1, 'development.json')).toMatchObject({
      status: 'failed',
      baseRevision,
      headRevision: baseRevision,
      summary: 'The parser change needs a decision that is missing from the task.',
    });
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
      const { runtime } = scriptedRuntime(() =>
        JSON.stringify({
          status: 'completed',
          summary: 'Implemented the retry guard.',
          findingResponses: [],
        }),
      );
      const develop = createDevelop({
        selectionFile,
        runner: runnerOf(runtime),
        git,
        publish: (event) => events.push(event),
      });

      await expect(develop(), label).resolves.toBe('failed');

      const artifact = (await readRoundArtifact(workspaceRoot, 1, 'development.json')) as {
        status: string;
        headRevision: string;
        summary: string;
      };
      expect(artifact, label).toMatchObject({ status: 'failed', headRevision });
      // The agent's explanation stays, and the observed readiness failure is durable.
      expect(artifact.summary, label).toContain('Implemented the retry guard.');
      expect(artifact.summary, label).toMatch(expected);
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
    const { runtime } = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Implemented the retry guard.',
        findingResponses: [],
      }),
    );
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('completed');

    expect(await readRoundArtifact(workspaceRoot, 1, 'development.json')).toEqual({
      taskSubject: 'Implement the retry guard',
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'Implemented the retry guard.',
      findingResponses: [],
    });
    expect(events).toEqual([developmentOutcome(workspaceRoot, 'completed')]);
  });

  it('carries the observed readiness failure into the next repair invocation', async () => {
    const { workspaceRoot, selectionFile } = await workspace();
    const first = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Implemented the retry guard.',
        findingResponses: [],
      }),
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

    const recorded = (await readRoundArtifact(workspaceRoot, 1, 'development.json')) as {
      summary: string;
    };
    expect(recorded.summary).toContain('Implemented the retry guard.');
    expect(recorded.summary).toContain('tracked changes are uncommitted');

    // The next round repairs; its context names the failed report, whose summary keeps the reason.
    await writeFile(
      path.join(workspaceRoot, 'state', 'current-round.json'),
      `${JSON.stringify({ number: 2, profile: 'dev-a', reason: 'The repair continues.' })}\n`,
      'utf8',
    );
    await mkdir(path.join(workspaceRoot, 'artifacts', '2'), { recursive: true });

    let priorSummary: string | null = null;
    const repair = scriptedRuntime(async (request) => {
      const match = /development result \(failed\): (.+)$/m.exec(request.context);
      const reportFile = match?.[1]?.trim();
      if (reportFile === undefined) {
        throw new Error('The context does not name the failed development report.');
      }
      const prior = JSON.parse(await readFile(reportFile, 'utf8')) as { summary: string };
      priorSummary = prior.summary;
      return JSON.stringify({
        status: 'completed',
        summary: 'Committed the retained work.',
        findingResponses: [],
      });
    });
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

    expect(priorSummary).not.toBeNull();
    expect(priorSummary).toContain('tracked changes are uncommitted');
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
      findingResponses: [],
    });
    await writeRoundArtifact(workspaceRoot, 1, 'review.json', precedingReview);
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
    const responses: FindingResponse[] = [blockingFinding, secondFinding].map((finding) => ({
      findingId: finding.id,
      status: 'addressed',
      response: `Addressed "${finding.title}".`,
    }));
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Repaired the retry guard.',
        findingResponses: responses,
      }),
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
    expect(context).toContain(
      'Findings to respond to (complete values from the review in round 1)',
    );
    expect(context).toContain(blockingFinding.id);
    expect(context).toContain(blockingFinding.repairGuidance);
    expect(context).toContain(secondFinding.evidence);
    expect(context).toContain(
      `- Round 1:\n  - development result (completed): ${path.join(workspaceRoot, 'artifacts', '1', 'development.json')}`,
    );
    expect(context).toContain('Latest recorded verification (round 1): failed.');
    expect(context).toContain(
      path.join(workspaceRoot, 'artifacts', '1', 'checks', '0', 'stdout.log'),
    );
    expect(context).toContain(path.join(workspaceRoot, 'artifacts', '1', 'review.json'));

    expect(await readRoundArtifact(workspaceRoot, 2, 'development.json')).toMatchObject({
      profile: 'dev-b',
      status: 'completed',
      headRevision: laterRevision,
      findingResponses: responses,
    });
  });

  it('rejects a report that does not answer exactly the supplied findings', async () => {
    const cases: ReadonlyArray<readonly [string, FindingResponse[]]> = [
      ['a missing response', []],
      [
        'an unknown response',
        [{ findingId: 'unknown', status: 'addressed', response: 'Addressed.' }],
      ],
      [
        'a repeated response',
        [
          { findingId: blockingFinding.id, status: 'addressed', response: 'Addressed.' },
          { findingId: blockingFinding.id, status: 'disputed', response: 'Disputed.' },
        ],
      ],
    ];

    for (const [label, responses] of cases) {
      events = [];
      const { workspaceRoot, selectionFile } = await workspace({ round: 2 });
      await writeRoundArtifact(workspaceRoot, 1, 'review.json', precedingReview);
      const { git } = scriptedGit([repositoryState({ headRevision })]);
      const { runtime } = scriptedRuntime(() =>
        JSON.stringify({
          status: 'completed',
          summary: 'Repaired.',
          findingResponses: responses,
        }),
      );
      const develop = createDevelop({
        selectionFile,
        runner: runnerOf(runtime),
        git,
        publish: (event) => events.push(event),
      });

      await expect(develop(), label).rejects.toThrow(/finding/);
      await expect(
        stat(path.join(workspaceRoot, 'artifacts', '2', 'development.json')),
      ).rejects.toThrow(/ENOENT/);
    }
  });

  it('reuses a current-round report that still describes the current work', async () => {
    const { taskKey, workspaceRoot, selectionFile } = await workspace();
    const helpers = createArtifactHelpers({ root: workspaceRoot });
    await helpers.writeOutputArtifact(devArtifact, {
      taskKey,
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'Implemented the retry guard.',
      findingResponses: [],
    });
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
  });

  it('binds its own metadata, rejects agent claims about it and rejects a wrong report shape', async () => {
    const observed = await workspace();
    const { git } = scriptedGit([repositoryState(), repositoryState({ headRevision })]);
    const { runtime } = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Implemented the retry guard.',
        findingResponses: [],
      }),
    );
    await expect(
      createDevelop({
        selectionFile: observed.selectionFile,
        runner: runnerOf(runtime),
        git,
        publish: (event) => events.push(event),
      })(),
    ).resolves.toBe('completed');

    expect(await readRoundArtifact(observed.workspaceRoot, 1, 'development.json')).toEqual({
      taskSubject: 'Implement the retry guard',
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'Implemented the retry guard.',
      findingResponses: [],
    });

    // A report claiming the metadata the action owns violates the response contract instead of
    // having those claims silently replaced by the observed values.
    const claiming = await workspace();
    const { runtime: claimingRuntime } = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Implemented the retry guard.',
        findingResponses: [],
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
      JSON.stringify({ status: 'done', summary: 'Finished.', findingResponses: [] }),
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
      findingResponses: [],
    });
    const { git } = scriptedGit([
      repositoryState({ headRevision }),
      repositoryState({ headRevision }),
    ]);
    const { runtime, requests } = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Implemented the retry guard.',
        findingResponses: [],
      }),
    );
    const develop = createDevelop({
      selectionFile,
      runner: runnerOf(runtime),
      git,
      publish: (event) => events.push(event),
    });

    await expect(develop()).resolves.toBe('completed');

    expect(requests).toHaveLength(1);
    expect(await readRoundArtifact(workspaceRoot, 1, 'development.json')).toMatchObject({
      headRevision,
      summary: 'Implemented the retry guard.',
    });
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

  it('preserves an unusable retained development report and supplies it to the repair round', async () => {
    const { taskKey, workspaceRoot, selectionFile } = await workspace({ round: 2 });
    const retainedFile = path.join(workspaceRoot, 'artifacts', '1', 'development.json');
    const malformed = '{"status":"completed",';
    await mkdir(path.dirname(retainedFile), { recursive: true });
    await writeFile(retainedFile, malformed, 'utf8');
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
    ).rejects.toThrow(/is not valid JSON/);

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
      output: malformed,
      reason: expect.stringContaining('is not valid JSON'),
    });

    // Repairing the file alone does not retire the feedback.
    await writeRoundArtifact(workspaceRoot, 1, 'development.json', {
      taskKey,
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision,
      summary: 'The repaired round-one report.',
      findingResponses: [],
    });
    await expect(
      outstandingReportFeedback({ areaRoot: workspaceRoot, scope }),
    ).resolves.toHaveLength(1);
    await expect(
      readFile(
        path.join(workspaceRoot, 'report-feedback', path.basename(retainedRejection!.path)),
        'utf8',
      ),
    ).resolves.toContain('is not valid JSON');

    // The next permitted invocation receives the retained rejection; its validated saved
    // replacement records the correction that retires it.
    const repair = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Repaired the round-one report.',
        findingResponses: [],
      }),
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
    expect(context).toContain('is not valid JSON');
    expect(context).toContain(malformed);
    expect(context).toContain(retainedFile);
    await expect(outstandingReportFeedback({ areaRoot: workspaceRoot, scope })).resolves.toEqual(
      [],
    );
    const records = await readReportFeedback(workspaceRoot);
    expect(records.filter((entry) => entry.record.kind === 'rejection')).toHaveLength(1);
    expect(records.filter((entry) => entry.record.kind === 'correction')).toHaveLength(1);
  });

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
    const retry = scriptedRuntime(() =>
      JSON.stringify({
        status: 'completed',
        summary: 'Implemented the retry guard.',
        findingResponses: [],
      }),
    );
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
});
