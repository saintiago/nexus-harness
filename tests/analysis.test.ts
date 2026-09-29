/**
 * Focused integration tests: Application's completion-experience analysis over real temporary
 * storage, a controlled analysis agent and a controlled AMEM service. They establish durable
 * request identity, validated output persisted once, stable submission keys across retries,
 * accepted-versus-stored receipt reporting, resumption after interruption and the explicit
 * reporting of outstanding work.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analysisObservationSourceKey,
  completionAnalysisDirectory,
  completionAnalysisIdentity,
  createCompletionAnalysis,
  createCompletionAnalysisRequestPublisher,
  type AnalysisAgent,
  type AnalysisSubmission,
  type CompletionAnalysisRequest,
  type CompletionAnalysisOutput,
} from '../src/application/analysis.js';
import type { AgentEvent } from '../src/agent-runtime/index.js';
import { createMemoryServiceClient, type Memory } from '../src/memory/index.js';
import { fault, ok, type Result } from '../src/result.js';
import { controlledMemoryService, type ControlledMemoryService } from './support/memory.js';

const project = 'NEX';
const taskKey = 'NEX-7';
const completionRevision = '4'.repeat(40);
const noteId = randomUUID();

const temporaryDirectories: string[] = [];
const services: ControlledMemoryService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-analysis-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function controlledService(): Promise<ControlledMemoryService> {
  const service = await controlledMemoryService();
  services.push(service);
  return service;
}

/** What one analysis harness retains across passes. */
type Harness = {
  readonly directory: string;
  readonly workspace: string;
  readonly request: CompletionAnalysisRequest;
  readonly identity: string;
  readonly service: ControlledMemoryService;
  readonly memory: Memory;
  readonly contexts: string[];
  readonly activity: AgentEvent[];
  process(options?: { readonly analyze?: Skill }): Promise<readonly string[]>;
};

/** What one scripted analyst observes: the complete context and the retained workspace root. */
type Skill = (context: string, workspace: string) => Result<string> | Promise<Result<string>>;

/**
 * One retained completion with its durable request: a real workspace with one retained artifact,
 * the published request, a controlled AMEM service and the analysis lifecycle under test.
 */
async function harness(analyze: Skill): Promise<Harness> {
  const root = await temporaryDirectory();
  const directory = completionAnalysisDirectory(path.join(root, 'executions', project));
  const workspace = path.join(root, 'workspaces', project, taskKey);
  const evidence = path.join(workspace, 'artifacts', '1', 'completion.json');
  await mkdir(path.dirname(evidence), { recursive: true });
  await writeFile(evidence, `${JSON.stringify({ taskKey, completionRevision })}\n`, 'utf8');
  const publisher = createCompletionAnalysisRequestPublisher({ directory, project });
  await publisher({ taskKey, completionRevision, workspaceRoot: workspace });
  const requestFile = path.join(
    directory,
    'requests',
    `${completionAnalysisIdentity(taskKey, completionRevision)}.json`,
  );
  const request = JSON.parse(await readFile(requestFile, 'utf8')) as CompletionAnalysisRequest;

  const service = await controlledService();
  const memory = createMemoryServiceClient({ url: service.url });
  const contexts: string[] = [];
  const activity: AgentEvent[] = [];
  const process = (agent: Skill) => {
    const scripted: AnalysisAgent = async (invocation) => {
      const result = await agent(invocation.context, invocation.workspace.root);
      return result.ok ? ok({ output: result.value }) : fault(result.fault.message);
    };
    return createCompletionAnalysis({
      directory,
      project,
      profile: 'nexus-astra',
      memory,
      analyze: async (invocation) => {
        contexts.push(invocation.context);
        invocation.onActivity({ type: 'message', text: 'inspecting retained evidence' });
        activity.push({ type: 'message', text: 'inspecting retained evidence' });
        return scripted(invocation);
      },
    }).processPending();
  };

  return {
    directory,
    workspace,
    request,
    identity: completionAnalysisIdentity(taskKey, completionRevision),
    service,
    memory,
    contexts,
    activity,
    process: (options) => process(options?.analyze ?? analyze),
  };
}

/** One well-formed analyst response with one observation citing the retained artifact. */
function observation(
  workspace: string,
  content = 'The retry guard must preserve its source key.',
): string {
  return JSON.stringify({
    observations: [
      {
        content,
        evidence: [
          {
            path: path.join(workspace, 'artifacts', '1', 'completion.json'),
            revision: completionRevision,
            detail: 'The completion evidence of the merged revision.',
          },
        ],
        relatedMemories: [],
      },
    ],
  });
}

/** The submission record one observation was retained under. */
async function submissionOf(harnessValue: Harness, identity = '1'): Promise<AnalysisSubmission> {
  return JSON.parse(
    await readFile(
      path.join(harnessValue.directory, 'submissions', harnessValue.identity, `${identity}.json`),
      'utf8',
    ),
  ) as AnalysisSubmission;
}

describe('completion-analysis requests', () => {
  it('records one durable request per task and final revision and reuses its identity', async () => {
    const root = await temporaryDirectory();
    const directory = completionAnalysisDirectory(path.join(root, 'executions', project));
    const publish = createCompletionAnalysisRequestPublisher({ directory, project });
    const workspace = path.join(root, 'workspaces', project, taskKey);

    await publish({ taskKey, completionRevision, workspaceRoot: workspace });
    const identity = completionAnalysisIdentity(taskKey, completionRevision);
    const file = path.join(directory, 'requests', `${identity}.json`);
    const first = JSON.parse(await readFile(file, 'utf8')) as CompletionAnalysisRequest;

    // Repeated completion keeps the recorded identity and its evidence.
    await publish({ taskKey, completionRevision, workspaceRoot: workspace });
    const second = JSON.parse(await readFile(file, 'utf8')) as CompletionAnalysisRequest;

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      taskKey,
      project,
      completionRevision,
      workspaceRoot: workspace,
    });
    expect(new Date(first.requestedAt).toISOString()).toBe(first.requestedAt);
  });
});

describe('completion analysis', () => {
  it('persists the validated output once and submits every observation under a stable key', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    retained.service.results = [];

    const problems = await retained.process();

    // Durable acceptance is reported as outstanding until the receipt is stored.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('observation 1 of task NEX-7 is outstanding');
    expect(retained.service.requests[0]?.method).toBe('POST');
    expect(retained.service.requests[0]?.path).toBe('/v1/observations');
    expect(retained.service.requests[1]?.method).toBe('GET');
    expect(retained.service.requests[1]?.path.startsWith('/v1/receipts/')).toBe(true);
    const submitted = retained.service.requests[0]?.body as {
      readonly sourceKey: string;
      readonly content: string;
      readonly provenance: Record<string, unknown>;
    };
    expect(submitted.sourceKey).toBe(
      analysisObservationSourceKey(taskKey, completionRevision, '1'),
    );
    expect(submitted.content).toBe('The retry guard must preserve its source key.');
    expect(submitted.provenance).toMatchObject({
      project,
      task: taskKey,
      completionRevision,
      observation: '1',
      analysisProfile: 'nexus-astra',
    });

    // The accepted output and the attempt evidence are retained with the request.
    const output = JSON.parse(
      await readFile(
        path.join(retained.directory, 'analyses', `${retained.identity}.json`),
        'utf8',
      ),
    ) as CompletionAnalysisOutput;
    expect(output.observations).toHaveLength(1);
    expect(output.observations[0]).toMatchObject({
      identity: '1',
      content: 'The retry guard must preserve its source key.',
    });
    const attempts = await readFile(
      path.join(retained.directory, 'analyses', `${retained.identity}.attempts.jsonl`),
      'utf8',
    );
    expect(attempts).toContain('"outcome":"accepted"');
    expect(
      await readFile(
        path.join(retained.directory, 'analyses', `${retained.identity}.activity.jsonl`),
        'utf8',
      ),
    ).toContain('inspecting retained evidence');

    // Once the service stores the note, the receipt settles the submission without a new analysis.
    retained.service.store(submitted.sourceKey);
    const contexts = retained.contexts.length;
    await expect(retained.process()).resolves.toEqual([]);
    expect(retained.contexts).toHaveLength(contexts);
    await expect(submissionOf(retained)).resolves.toMatchObject({
      status: 'stored',
      receiptStatus: 'stored',
      noteId: expect.any(String),
    });
  });

  it('retries a lost acknowledgement with the identical key and payload and reuses the output', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    let first = true;
    retained.service.intercept('/v1/observations', () => {
      if (!first) {
        return null;
      }
      first = false;
      return 'accept-then-close';
    });

    const lost = await retained.process();

    expect(lost[0]).toContain('the submission of observation 1 of task NEX-7 is outstanding');
    expect(retained.service.observations.size).toBe(1);

    // The resumable pass resubmits the identical payload under the same key and does not re-analyze.
    const contexts = retained.contexts.length;
    const resumed = await retained.process();
    const submissions = retained.service.requests.filter(
      (request) => request.path === '/v1/observations',
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[1]?.body).toEqual(submissions[0]?.body);
    expect(retained.contexts).toHaveLength(contexts);
    expect(resumed).toHaveLength(1);
    await expect(submissionOf(retained)).resolves.toMatchObject({
      status: 'accepted',
      attempts: 2,
    });
  });

  it('accepts zero observations without contacting the service', async () => {
    const retained = await harness(() => ok(JSON.stringify({ observations: [] })));

    await expect(retained.process()).resolves.toEqual([]);

    expect(retained.service.requests).toEqual([]);
    const output = JSON.parse(
      await readFile(
        path.join(retained.directory, 'analyses', `${retained.identity}.json`),
        'utf8',
      ),
    ) as CompletionAnalysisOutput;
    expect(output.observations).toEqual([]);
  });

  it('reports unusable output, submits nothing and re-analyzes on the next pass', async () => {
    const retained = await harness(() =>
      ok(
        JSON.stringify({
          observations: [
            {
              content: 'An unsupported lesson.',
              evidence: [
                { path: '/etc/passwd', revision: completionRevision, detail: 'Outside the task.' },
              ],
              relatedMemories: [],
            },
          ],
        }),
      ),
    );

    const problems = await retained.process();

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the completion analysis of task NEX-7');
    expect(problems[0]).toContain('is not a retained artifact of the completed task');
    expect(retained.service.requests).toEqual([]);

    // Nothing was accepted, so the request stays outstanding and the next pass produces output.
    await expect(
      retained.process({ analyze: (_context, workspace) => ok(observation(workspace)) }),
    ).resolves.toHaveLength(1);
    expect(retained.service.requests.filter((r) => r.path === '/v1/observations')).toHaveLength(1);
    await expect(submissionOf(retained)).resolves.toMatchObject({ status: 'accepted' });
  });

  it('keeps an explicit correction and its compared note in the submitted provenance', async () => {
    const retained = await harness((_context, workspace) =>
      ok(
        JSON.stringify({
          observations: [
            {
              content: 'The earlier guidance on retries is corrected: the key must not change.',
              evidence: [
                {
                  path: path.join(workspace, 'artifacts', '1', 'completion.json'),
                  revision: completionRevision,
                  detail: 'The completion evidence.',
                },
              ],
              relatedMemories: [
                {
                  noteId,
                  relationship: 'correction',
                  explanation: 'The earlier note assumed the key could be regenerated.',
                },
              ],
            },
          ],
        }),
      ),
    );

    await retained.process();

    expect(retained.service.requests[0]?.body).toMatchObject({
      provenance: {
        relatedMemories: [
          {
            noteId,
            relationship: 'correction',
            explanation: 'The earlier note assumed the key could be regenerated.',
          },
        ],
      },
    });
    // The analyst received the retained evidence and the bounded read scope.
    expect(retained.contexts[0]).toContain(retained.workspace);
    expect(retained.contexts[0]).toContain('Do not read credentials');
  });

  it('reports a terminal refusal once without resubmitting it', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    retained.service.intercept('/v1/observations', () => ({
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'The source key is already accepted with a different observation.',
          retryable: false,
        },
      },
    }));

    const problems = await retained.process();

    expect(problems).toEqual([
      'the submission of observation 1 of task NEX-7 failed: The source key is already accepted ' +
        'with a different observation.',
    ]);
    await expect(submissionOf(retained)).resolves.toMatchObject({ status: 'failed' });
    await retained.process();
    expect(retained.service.requests.filter((r) => r.path === '/v1/observations')).toHaveLength(1);
  });

  it('resumes an interrupted request from its retained output after a restart', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    // The first process is interrupted before the service is reachable at all.
    await retained.memory.close();
    const interrupted = await retained.process();
    expect(interrupted[0]).toContain('is outstanding');

    // A fresh process over the same store reuses the accepted output and submits it.
    const service = retained.service;
    const restarted = createCompletionAnalysis({
      directory: retained.directory,
      project,
      profile: 'nexus-astra',
      memory: createMemoryServiceClient({ url: service.url }),
      analyze: () => Promise.reject(new Error('The persisted output must be reused.')),
    });

    const problems = await restarted.processPending();

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the submission of observation 1 of task NEX-7 is outstanding');
    expect(service.observations.size).toBe(1);
  });
});
