/**
 * Focused integration tests: AnalyzeExperience over real temporary storage, a controlled analyst
 * and a controlled AMEM service. They establish durable capture identity, validated output
 * persisted once, stable submission keys across retries, accepted-versus-stored receipt
 * reporting, resumption after interruption, migration of pending completion requests, evidence
 * validation and the explicit reporting of outstanding work.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent-runtime/index.js';
import { fault, ok, type Result } from '../src/result.js';
import {
  experienceAnalysisFile,
  experienceAnalysisOutputSchema,
  experienceCaptureFile,
  experienceEvidenceRoot,
  experienceIdentity,
  experienceObservationSourceKey,
  experienceRequestFile,
  experienceSubmissionFile,
  legacyCompletionOutputSchema,
  type ExperienceAnalysisOutput,
  type ExperienceCapture,
  type ExperienceHandoff,
  type ExperienceSubmission,
} from '../src/task-engine/actions/analyze-experience/artifacts.js';
import {
  createAnalyzeExperience,
  createAnalyzeExperienceAction,
  type ExperienceAnalyst,
  type ExperienceAnalystRequest,
} from '../src/task-engine/actions/analyze-experience/index.js';
import {
  outstandingReportFeedback,
  readReportFeedback,
} from '../src/task-engine/actions/report-feedback.js';
import type { EngineEvent } from '../src/task-engine/index.js';
import { controlledMemoryService, type ControlledMemoryService } from './support/memory.js';

const project = 'NEX';
const workId = 'NEX-7';
const attemptId = 'task/NEX-7';
const mergeRevision = '4'.repeat(40);
const noteId = randomUUID();
const profile = 'nexus-astra';

const temporaryDirectories: string[] = [];
const services: ControlledMemoryService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close().catch(() => undefined)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-experience-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function controlledService(): Promise<ControlledMemoryService> {
  const service = await controlledMemoryService();
  services.push(service);
  return service;
}

/** What one scripted analyst observes: the complete context and the retained workspace root. */
type Skill = (context: string, workspace: string) => Result<string> | Promise<Result<string>>;

/** Whether one analyst invocation writes its assigned Markdown report before returning. */
type ReportBehavior = 'write' | 'skip';

/** What one harness retains across passes. */
type Harness = {
  readonly directory: string;
  readonly workspace: string;
  readonly evidence: string;
  readonly identity: string;
  readonly handoff: ExperienceHandoff;
  readonly service: ControlledMemoryService;
  readonly contexts: string[];
  readonly requests: readonly ExperienceAnalystRequest[];
  readonly activity: AgentEvent[];
  readonly schema: unknown;
  process(options?: {
    readonly analyze?: Skill;
    readonly report?: ReportBehavior;
  }): Promise<readonly string[]>;
  capture(
    handoff?: ExperienceHandoff,
  ): ReturnType<ReturnType<typeof createAnalyzeExperience>['capture']>;
};

/**
 * One retained terminal handoff with its durable capture: a real workspace with one retained
 * artifact, the recording owner, a controlled AMEM service and the analysis lifecycle under test.
 */
async function harness(analyze: Skill, report: ReportBehavior = 'write'): Promise<Harness> {
  const root = await temporaryDirectory();
  const directory = path.join(root, 'executions', project, 'memory');
  const workspace = path.join(root, 'workspaces', project, workId);
  const evidence = path.join(workspace, 'artifacts', '1', 'completion.json');
  await mkdir(path.dirname(evidence), { recursive: true });
  await writeFile(evidence, `${JSON.stringify({ taskKey: workId, mergeRevision })}\n`, 'utf8');
  const handoff: ExperienceHandoff = {
    workId,
    workflow: 'project',
    attemptId,
    terminalId: 'complete-completed',
    outcome: 'completed',
    reason: null,
    workspaceRoot: workspace,
    artifacts: [{ path: evidence }],
  };

  const service = await controlledService();
  const contexts: string[] = [];
  const requests: ExperienceAnalystRequest[] = [];
  const activity: AgentEvent[] = [];
  const observed: { schema: unknown } = { schema: null };
  let skill = analyze;
  let reportBehavior: ReportBehavior = report;
  const analyst: ExperienceAnalyst = async (request) => {
    contexts.push(request.context);
    requests.push(request);
    observed.schema = request.outputSchema;
    request.onActivity({ type: 'message', text: 'inspecting retained evidence' });
    activity.push({ type: 'message', text: 'inspecting retained evidence' });
    // Every analyst invocation writes its assigned Markdown before returning; a controlled skill
    // may omit it to exercise the report rejection and feedback path.
    if (reportBehavior === 'write') {
      await writeFile(
        request.reportPath,
        'The analyst read the retained evidence and recorded its reasoning.\n',
        'utf8',
      );
    }
    const result = await skill(request.context, request.workspace.root);
    return result.ok ? ok({ output: result.value }) : fault(result.fault.message);
  };
  const owner = createAnalyzeExperience({
    directory,
    project,
    profile,
    memory: { url: service.url },
    analyze: analyst,
  });
  const identity = experienceIdentity(handoff);
  await owner.capture(handoff);

  return {
    directory,
    workspace,
    evidence,
    identity,
    handoff,
    service,
    contexts,
    requests,
    activity,
    get schema() {
      return observed.schema;
    },
    process: (options) => {
      skill = options?.analyze ?? analyze;
      reportBehavior = options?.report ?? report;
      return owner.processPending();
    },
    capture: (value) => owner.capture(value ?? handoff),
  };
}

/** One well-formed analyst response with one observation citing an explicit evidence file. */
function observationAt(
  file: string,
  content = 'The retry guard must preserve its source key.',
): string {
  return JSON.stringify({
    observations: [
      {
        content,
        evidence: [
          {
            path: file,
            revision: mergeRevision,
            detail: 'The completion evidence of the merged revision.',
          },
        ],
        relatedMemories: [],
      },
    ],
  });
}

/** One well-formed analyst response with one observation citing the work area's evidence. */
function observation(
  workspace: string,
  content = 'The retry guard must preserve its source key.',
): string {
  return observationAt(path.join(workspace, 'artifacts', '1', 'completion.json'), content);
}

/** The submission record one observation was retained under. */
async function submissionOf(harnessValue: Harness, identity = '1'): Promise<ExperienceSubmission> {
  return JSON.parse(
    await readFile(
      experienceSubmissionFile(harnessValue.directory, harnessValue.identity, identity),
      'utf8',
    ),
  ) as ExperienceSubmission;
}

/** The persisted analysis of one harness. */
async function analysisOf(harnessValue: Harness): Promise<ExperienceAnalysisOutput> {
  return JSON.parse(
    await readFile(
      path.join(harnessValue.directory, 'analyses', `${harnessValue.identity}.json`),
      'utf8',
    ),
  ) as ExperienceAnalysisOutput;
}

/** The retained evidence directory of one harness's request. */
function evidenceRootOf(harnessValue: Harness): string {
  return experienceEvidenceRoot(harnessValue.directory, harnessValue.identity);
}

/** The retained copy of one harness's selected evidence file. */
function retainedEvidenceOf(harnessValue: Harness): string {
  return path.join(evidenceRootOf(harnessValue), 'artifacts', '1', 'completion.json');
}

describe('experience capture', () => {
  it('records one durable request per handoff, reuses its identity and preserves its evidence', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'memory');
    const workspace = path.join(root, 'workspaces', project, workId);
    const evidence = path.join(workspace, 'artifacts', '1', 'completion.json');
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(evidence, '{}\n', 'utf8');
    const handoff: ExperienceHandoff = {
      workId,
      workflow: 'project',
      attemptId,
      terminalId: 'complete-completed',
      outcome: 'completed',
      reason: null,
      workspaceRoot: workspace,
      artifacts: [{ path: evidence }],
    };
    const service = await controlledService();
    const owner = createAnalyzeExperience({
      directory,
      project,
      profile,
      memory: { url: service.url },
      analyze: null,
    });

    const first = await owner.capture(handoff);
    const identity = experienceIdentity(handoff);
    const requestFile = experienceRequestFile(directory, identity);
    const recorded = JSON.parse(await readFile(requestFile, 'utf8')) as Record<string, unknown>;

    // Repeated execution of the same terminal handoff reuses the recorded request.
    const second = await owner.capture(handoff);
    expect(second.outcome).toBe('recorded');
    expect(await readFile(requestFile, 'utf8')).toBe(JSON.stringify(recorded, null, 2) + '\n');
    expect(first.evidence?.path).toBe(experienceCaptureFile(directory, identity));
    const capture = JSON.parse(await readFile(first.evidence!.path, 'utf8')) as ExperienceCapture;
    expect(capture).toMatchObject({ identity, project, outcome: 'recorded', detail: null });
    expect(recorded).toMatchObject({
      identity,
      project,
      handoff,
      migrated: null,
    });
  });

  it('reports explicitly when the same identity records a different handoff', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'memory');
    const workspace = path.join(root, 'workspaces', project, workId);
    const evidence = path.join(workspace, 'artifacts', '1', 'completion.json');
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(evidence, '{}\n', 'utf8');
    const service = await controlledService();
    const owner = createAnalyzeExperience({
      directory,
      project,
      profile,
      memory: { url: service.url },
      analyze: null,
    });
    const handoff: ExperienceHandoff = {
      workId,
      workflow: 'project',
      attemptId,
      terminalId: 'complete-completed',
      outcome: 'completed',
      reason: null,
      workspaceRoot: workspace,
      artifacts: [{ path: evidence }],
    };
    await owner.capture(handoff);

    const conflict = await owner.capture({ ...handoff, outcome: 'failed' });

    // A memory problem never faults the workflow: the conflict is reported without a submission.
    expect(conflict.outcome).toBe('unavailable');
    expect(conflict.detail).toContain('records a different handoff');
    expect(conflict.evidence).not.toBeNull();
  });

  it('skips disabled memory without writing anything, and skips a handoff with nothing to analyze', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'memory');
    const workspace = path.join(root, 'workspaces', project, workId);
    const handoff: ExperienceHandoff = {
      workId,
      workflow: 'project',
      attemptId,
      terminalId: 'complete-completed',
      outcome: 'completed',
      reason: null,
      workspaceRoot: workspace,
      artifacts: [],
    };
    const disabled = createAnalyzeExperience({
      directory,
      project,
      profile: null,
      memory: null,
      analyze: null,
    });

    await expect(disabled.capture(handoff)).resolves.toEqual({
      outcome: 'skipped',
      evidence: null,
      detail: 'the memory integration is disabled',
    });
    await expect(disabled.processPending()).resolves.toEqual([]);
    await expect(stat(path.join(directory))).rejects.toMatchObject({ code: 'ENOENT' });

    // Enabled memory records the skip decision when the handoff retained no evidence or reason.
    const service = await controlledService();
    const enabled = createAnalyzeExperience({
      directory,
      project,
      profile,
      memory: { url: service.url },
      analyze: null,
    });
    const skipped = await enabled.capture(handoff);
    expect(skipped.outcome).toBe('skipped');
    expect(skipped.evidence).not.toBeNull();
    expect(service.requests).toEqual([]);
    await expect(
      stat(experienceRequestFile(directory, experienceIdentity(handoff))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports unusable retained evidence as an unavailable capture', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'memory');
    const workspace = path.join(root, 'workspaces', project, workId);
    await mkdir(path.join(workspace, 'artifacts', '1'), { recursive: true });
    const outside = path.join(await temporaryDirectory(), 'outside.json');
    await writeFile(outside, '{}\n', 'utf8');
    await symlink(outside, path.join(workspace, 'artifacts', '1', 'escaped.json'));
    const service = await controlledService();
    const owner = createAnalyzeExperience({
      directory,
      project,
      profile,
      memory: { url: service.url },
      analyze: null,
    });

    const captured = await owner.capture({
      workId,
      workflow: 'project',
      attemptId,
      terminalId: 'deliver-failed',
      outcome: 'failed',
      reason: 'The worktree is not on the prepared branch.',
      workspaceRoot: workspace,
      artifacts: [{ path: path.join(workspace, 'artifacts', '1', 'escaped.json') }],
    });

    expect(captured.outcome).toBe('unavailable');
    expect(captured.detail).toContain('resolves outside the work item workspace');
    expect(captured.evidence).not.toBeNull();
    const evidence = JSON.parse(
      await readFile(captured.evidence!.path, 'utf8'),
    ) as ExperienceCapture;
    expect(evidence.outcome).toBe('unavailable');
    expect(evidence.detail).toContain('resolves outside the work item workspace');
  });

  it('binds the capture outcome to an action outcome event and publishes none when nothing was saved', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'memory');
    const workspace = path.join(root, 'workspaces', project, workId);
    const service = await controlledService();
    const owner = createAnalyzeExperience({
      directory,
      project,
      profile,
      memory: { url: service.url },
      analyze: null,
    });
    const events: EngineEvent[] = [];
    const action = createAnalyzeExperienceAction({
      owner,
      publish: (event) => events.push(event),
    });
    const handoff: ExperienceHandoff = {
      workId,
      workflow: 'project',
      attemptId,
      terminalId: 'prepare-failed',
      outcome: 'failed',
      reason: 'The preparation command failed with exit code 1.',
      workspaceRoot: workspace,
      artifacts: [],
    };

    await expect(action(handoff)).resolves.toBe('recorded');
    expect(events).toEqual([
      {
        source: 'analyze-experience',
        type: 'outcome',
        data: {
          task: workId,
          round: null,
          outcome: 'recorded',
          detail: `NEX-7 project/task/NEX-7/prepare-failed ("failed")`,
          artifact: { path: experienceCaptureFile(directory, experienceIdentity(handoff)) },
        },
      },
    ]);

    // A disabled capture saves no evidence, so it publishes no outcome event.
    const disabled = createAnalyzeExperienceAction({
      owner: createAnalyzeExperience({
        directory: path.join(root, 'disabled'),
        project,
        profile: null,
        memory: null,
        analyze: null,
      }),
      publish: (event) => events.push(event),
    });
    await expect(disabled(handoff)).resolves.toBe('skipped');
    expect(events).toHaveLength(1);
  });
});

describe('experience analysis', () => {
  it('persists the validated output once and submits every observation under a stable key', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    retained.service.results = [];

    const problems = await retained.process();

    // Durable acceptance is reported as outstanding until the receipt is stored.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('observation 1 of NEX-7 is outstanding');
    expect(retained.service.requests[0]?.method).toBe('POST');
    expect(retained.service.requests[0]?.path).toBe('/v1/observations');
    expect(retained.service.requests[1]?.method).toBe('GET');
    expect(retained.service.requests[1]?.path.startsWith('/v1/receipts/')).toBe(true);
    const submitted = retained.service.requests[0]?.body as {
      readonly sourceKey: string;
      readonly content: string;
      readonly provenance: Record<string, unknown>;
    };
    expect(submitted.sourceKey).toBe(experienceObservationSourceKey(retained.identity, '1'));
    expect(submitted.content).toBe('The retry guard must preserve its source key.');
    expect(submitted.provenance).toMatchObject({
      project,
      work: workId,
      workflow: 'project',
      attempt: attemptId,
      terminal: 'complete-completed',
      outcome: 'completed',
      observation: '1',
      analysisProfile: profile,
    });

    // The accepted output and the attempt evidence are retained with the request.
    const output = await analysisOf(retained);
    expect(output).toMatchObject({
      workId,
      project,
      workflow: 'project',
      attemptId,
      terminalId: 'complete-completed',
      profile,
    });
    expect(experienceAnalysisOutputSchema.safeParse(output).success).toBe(true);
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
    // The analyst received the retained evidence, the response schema and the bounded read scope.
    expect(retained.contexts[0]).toContain(retained.workspace);
    expect(retained.contexts[0]).toContain('memory_search');
    expect(retained.contexts[0]).toContain('Do not read credentials');
    expect(retained.contexts[0]).toContain('applicability and its uncertainty');
    expect(retained.schema).toMatchObject({ type: 'object' });

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

    expect(lost[0]).toContain('the submission of observation 1 of NEX-7 is outstanding');
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

  it('preserves the recorded payload and key when the configured profile changes', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    // The first process cannot submit, so the observation stays unsent.
    retained.service.close();
    await expect(retained.process()).resolves.toHaveLength(1);
    const recorded = await submissionOf(retained);
    expect(recorded.status).toBe('pending');
    expect(recorded.observation.provenance).toMatchObject({ analysisProfile: profile });

    // A fresh process with a different configured profile resubmits the persisted payload.
    const service = await controlledService();
    const restarted = createAnalyzeExperience({
      directory: retained.directory,
      project,
      profile: 'nexus-other',
      memory: { url: service.url },
      analyze: () => Promise.reject(new Error('The persisted output must be reused.')),
    });

    const problems = await restarted.processPending();

    const submitted = service.requests.filter((request) => request.path === '/v1/observations');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.body).toEqual(recorded.observation);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the submission of observation 1 of NEX-7 is outstanding');
    await expect(submissionOf(retained)).resolves.toMatchObject({ status: 'accepted' });
  });

  it('accepts zero observations without contacting the service', async () => {
    const retained = await harness(() => ok(JSON.stringify({ observations: [] })));

    await expect(retained.process()).resolves.toEqual([]);

    expect(retained.service.requests).toEqual([]);
    expect((await analysisOf(retained)).observations).toEqual([]);
  });

  it('writes the assigned Markdown for an analysis that finds no lesson', async () => {
    const retained = await harness(() => ok(JSON.stringify({ observations: [] })));

    await expect(retained.process()).resolves.toEqual([]);

    const output = await analysisOf(retained);
    expect(output).toMatchObject({ role: 'experience-analyst', workId, profile, observations: [] });
    // Every invocation writes its report, including one that found no reusable lesson, and the
    // saved analysis binds the exact bytes.
    expect(output.report.path).toBe(
      path.join(
        evidenceRootOf(retained),
        'reports',
        retained.requests[0]!.invocationId!,
        'experience-analysis.md',
      ),
    );
    expect(await readFile(output.report.path, 'utf8')).toBe(
      'The analyst read the retained evidence and recorded its reasoning.\n',
    );
    expect(output.reportIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(output.invocationId).toBe(retained.requests[0]!.invocationId);
    expect(experienceAnalysisOutputSchema.safeParse(output).success).toBe(true);
  });

  it('reports unusable output, submits nothing and re-analyzes on the next pass', async () => {
    const retained = await harness(() =>
      ok(
        JSON.stringify({
          observations: [
            {
              content: 'An unsupported lesson.',
              evidence: [
                { path: '/etc/passwd', revision: mergeRevision, detail: 'Outside the work item.' },
              ],
              relatedMemories: [],
            },
          ],
        }),
      ),
    );

    const problems = await retained.process();

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the experience analysis of NEX-7');
    expect(problems[0]).toContain('is not a retained artifact of the work item');
    expect(retained.service.requests).toEqual([]);

    // Nothing was accepted, so the request stays outstanding and the next pass produces output.
    await expect(
      retained.process({ analyze: (_context, workspace) => ok(observation(workspace)) }),
    ).resolves.toHaveLength(1);
    expect(retained.service.requests.filter((r) => r.path === '/v1/observations')).toHaveLength(1);
    await expect(submissionOf(retained)).resolves.toMatchObject({ status: 'accepted' });
  });

  it('rejects an observation whose cited evidence was never retained', async () => {
    const retained = await harness((_context, workspace) =>
      ok(
        JSON.stringify({
          observations: [
            {
              content: 'A lesson citing a completion artifact that does not exist.',
              evidence: [
                {
                  path: path.join(workspace, 'artifacts', '1', 'missing-completion.json'),
                  revision: mergeRevision,
                  detail: 'A completion artifact that was never retained.',
                },
              ],
              relatedMemories: [],
            },
          ],
        }),
      ),
    );

    const problems = await retained.process();

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not exist as a retained file of the work item');
    expect(retained.service.requests).toEqual([]);
    await expect(
      stat(path.join(retained.directory, 'analyses', `${retained.identity}.json`)),
    ).rejects.toThrow();
    await expect(
      stat(experienceRequestFile(retained.directory, retained.identity)),
    ).resolves.toBeDefined();

    // The request stays outstanding, so a later pass with real evidence still submits.
    await expect(
      retained.process({ analyze: (_context, workspace) => ok(observation(workspace)) }),
    ).resolves.toHaveLength(1);
    await expect(submissionOf(retained)).resolves.toMatchObject({ status: 'accepted' });
  });

  it('rejects evidence that is not a file and evidence that escapes the retained root', async () => {
    const directoryCase = await harness(() => ok('{"observations":[]}'));
    const directoryProblems = await directoryCase.process({
      analyze: () =>
        ok(
          JSON.stringify({
            observations: [
              {
                content: 'A lesson citing the retained evidence directory.',
                evidence: [
                  {
                    path: path.join(evidenceRootOf(directoryCase), 'artifacts'),
                    revision: mergeRevision,
                    detail: 'A directory, not a retained report.',
                  },
                ],
                relatedMemories: [],
              },
            ],
          }),
        ),
    });
    expect(directoryProblems[0]).toContain('is not a file of the work item');
    expect(directoryCase.service.requests).toEqual([]);

    const outside = path.join(await temporaryDirectory(), 'outside.json');
    await writeFile(outside, '{"outside":true}\n');
    const symlinkCase = await harness(() => ok('{"observations":[]}'));
    // The retained copy itself is replaced by a link that leaves the retained evidence root.
    const retainedCopy = retainedEvidenceOf(symlinkCase);
    const escaped = path.join(path.dirname(retainedCopy), 'escaped.json');
    await symlink(outside, escaped);
    await rm(retainedCopy);

    const symlinkProblems = await symlinkCase.process({
      analyze: () =>
        ok(
          JSON.stringify({
            observations: [
              {
                content: 'A lesson citing a file outside the retained evidence root.',
                evidence: [
                  {
                    path: escaped,
                    revision: mergeRevision,
                    detail: 'A symlink to a file outside the retained evidence root.',
                  },
                ],
                relatedMemories: [],
              },
            ],
          }),
        ),
    });
    expect(symlinkProblems[0]).toContain('resolves outside the work item workspace');
    expect(symlinkCase.service.requests).toEqual([]);
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
                  revision: mergeRevision,
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
      'the submission of observation 1 of NEX-7 failed: The source key is already accepted ' +
        'with a different observation.',
    ]);
    await expect(submissionOf(retained)).resolves.toMatchObject({ status: 'failed' });
    await retained.process();
    expect(retained.service.requests.filter((r) => r.path === '/v1/observations')).toHaveLength(1);
  });

  it('keeps polling a blocked receipt and reports it separately from failure', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    const sourceKey = experienceObservationSourceKey(retained.identity, '1');
    await retained.process();

    // The service blocks the queued ingestion until an operator reconciles the configuration.
    retained.service.block(sourceKey, 'The embedding provider is not configured.');
    const blocked = await retained.process();

    expect(blocked).toEqual([
      'the submission of observation 1 of NEX-7 is blocked in the memory service: ' +
        'The embedding provider is not configured.',
    ]);
    await expect(submissionOf(retained)).resolves.toMatchObject({
      status: 'accepted',
      receiptStatus: 'blocked',
    });

    // The reconciled service stores the note; a restarted process settles the submission.
    retained.service.store(sourceKey);
    const restarted = createAnalyzeExperience({
      directory: retained.directory,
      project,
      profile,
      memory: { url: retained.service.url },
      analyze: () => Promise.reject(new Error('The persisted output must be reused.')),
    });

    await expect(restarted.processPending()).resolves.toEqual([]);
    await expect(submissionOf(retained)).resolves.toMatchObject({
      status: 'stored',
      receiptStatus: 'stored',
    });
    expect(retained.service.requests.filter((r) => r.path === '/v1/observations')).toHaveLength(1);
  });

  it('resumes an interrupted request from its retained output after a restart', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    // The first process is interrupted before the service is reachable at all.
    retained.service.close();
    const interrupted = await retained.process();
    expect(interrupted[0]).toContain('is outstanding');

    // A fresh process over the same store reuses the accepted output and submits it.
    const service = await controlledService();
    const restarted = createAnalyzeExperience({
      directory: retained.directory,
      project,
      profile,
      memory: { url: service.url },
      analyze: () => Promise.reject(new Error('The persisted output must be reused.')),
    });

    const problems = await restarted.processPending();

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the submission of observation 1 of NEX-7 is outstanding');
    expect(service.observations.size).toBe(1);
  });

  it('keeps an unresolved request analyzable after the attempt is discarded and replaced', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    // A temporary analyst outage leaves the request outstanding while recovery discards the attempt.
    const unresolved = await retained.process({
      analyze: () => fault('The analysis provider is unavailable.'),
    });
    expect(unresolved[0]).toContain('is outstanding');
    await rm(retained.workspace, { recursive: true, force: true });
    // A fresh attempt writes different content at the original evidence path.
    await mkdir(path.dirname(retained.evidence), { recursive: true });
    await writeFile(retained.evidence, '{"replacement":true}\n', 'utf8');

    // The analyst cites the file's recorded location, whose content a fresh attempt replaced.
    const settled = await retained.process({
      analyze: () => ok(observationAt(retained.evidence)),
    });

    expect(settled).toHaveLength(1);
    expect(settled[0]).toContain('the submission of observation 1 of NEX-7 is outstanding');
    expect(retained.service.observations.size).toBe(1);
    // The observation was validated against the retained copy, not the replacement artifact.
    expect(await readFile(retainedEvidenceOf(retained), 'utf8')).toContain(mergeRevision);
    const output = await analysisOf(retained);
    expect(output.observations[0]?.evidence[0]?.path).toBe(retained.evidence);
  });

  it('analyzes a handoff that never prepared a repository in a valid work area of its own', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'executions', project, 'memory');
    const workspace = path.join(root, 'workspaces', project, workId);
    await mkdir(workspace, { recursive: true });
    const handoff: ExperienceHandoff = {
      workId,
      workflow: 'project',
      attemptId,
      terminalId: 'prepare-failed',
      outcome: 'failed',
      reason: 'The repository condition prevents preparation.',
      workspaceRoot: workspace,
      artifacts: [],
    };
    const service = await controlledService();
    let analysisRoot: string | null = null;
    const owner = createAnalyzeExperience({
      directory,
      project,
      profile,
      memory: { url: service.url },
      analyze: async (request) => {
        analysisRoot = request.workspace.root;
        // The invocation's working directory exists even though the handoff has no worktree.
        expect((await stat(path.join(request.workspace.root, 'worktree'))).isDirectory()).toBe(
          true,
        );
        await writeFile(request.reportPath, 'The failed handoff held no reusable lesson.', 'utf8');
        return ok({ output: JSON.stringify({ observations: [] }) });
      },
    });
    await owner.capture(handoff);

    const problems = await owner.processPending();

    expect(problems).toEqual([]);
    expect(analysisRoot).not.toBe(workspace);
    // Analysis never mutates the work item workspace it read the failure from.
    await expect(stat(path.join(workspace, 'worktree'))).rejects.toMatchObject({ code: 'ENOENT' });
    const analysis = JSON.parse(
      await readFile(experienceAnalysisFile(directory, experienceIdentity(handoff)), 'utf8'),
    ) as ExperienceAnalysisOutput;
    expect(analysis.observations).toEqual([]);
  });

  it.each(['experience', 'legacy'] as const)(
    'retains pending %s evidence before recovery replaces the workspace',
    async (format) => {
      const root = await temporaryDirectory();
      const directory = path.join(root, 'memory');
      const workspace = path.join(root, 'workspaces', project, workId);
      const evidence = path.join(workspace, 'artifacts', '1', 'completion.json');
      await mkdir(path.dirname(evidence), { recursive: true });
      await writeFile(evidence, JSON.stringify({ revision: mergeRevision }), 'utf8');
      const handoff: ExperienceHandoff = {
        workId,
        workflow: 'project',
        attemptId,
        terminalId: 'complete-completed',
        outcome: 'completed',
        reason: null,
        workspaceRoot: workspace,
        artifacts: [{ path: evidence }],
      };
      const identity =
        format === 'experience' ? experienceIdentity(handoff) : 'NEX-7-0123456789abcdef';
      // The earlier store recorded the handoff before requests retained a copy of their evidence.
      await mkdir(path.join(directory, 'requests'), { recursive: true });
      await writeFile(
        path.join(directory, 'requests', `${identity}.json`),
        `${JSON.stringify(
          format === 'experience'
            ? {
                identity,
                project,
                handoff,
                migrated: null,
                requestedAt: '2026-09-29T10:00:00.000Z',
              }
            : {
                taskKey: workId,
                project,
                completionRevision: mergeRevision,
                workspaceRoot: workspace,
                requestedAt: '2026-09-29T10:00:00.000Z',
              },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const service = await controlledService();
      const unavailable = createAnalyzeExperience({
        directory,
        project,
        profile,
        memory: { url: service.url },
        analyze: () => Promise.resolve(fault('The analyst is unavailable.')),
      });
      expect(await unavailable.processPending()).toEqual([
        expect.stringContaining('The analyst is unavailable.'),
      ]);
      await rm(workspace, { recursive: true });
      await mkdir(path.dirname(evidence), { recursive: true });
      await writeFile(evidence, '{"replacement":true}');

      const workspaces: string[] = [];
      const owner = createAnalyzeExperience({
        directory,
        project,
        profile,
        memory: { url: service.url },
        analyze: async (request) => {
          workspaces.push(request.workspace.root);
          const retained = path.join(request.workspace.root, 'artifacts', '1', 'completion.json');
          expect(await readFile(retained, 'utf8')).toContain(mergeRevision);
          expect(request.context).toContain('only these retained files are its evidence');
          await writeFile(
            request.reportPath,
            'The migration evidence still supports a lesson.',
            'utf8',
          );
          // Citations of original locations resolve against the retained copy.
          return ok({ output: observationAt(evidence) });
        },
      });

      const problems = await owner.processPending();

      // A new owner reuses the migrated request and its independent evidence.
      expect(workspaces).toHaveLength(1);
      expect((await stat(path.join(workspaces[0]!, 'worktree'))).isDirectory()).toBe(true);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('the submission of observation 1 of NEX-7 is outstanding');
      expect(service.observations.size).toBe(1);
      expect(
        JSON.parse(await readFile(experienceRequestFile(directory, identity), 'utf8')),
      ).toMatchObject({
        identity,
        requestedAt: '2026-09-29T10:00:00.000Z',
        evidenceRoot: workspaces[0],
      });
    },
  );

  it('settles a pending completion request recorded by the earlier store', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'memory');
    const workspace = path.join(root, 'workspaces', project, workId);
    const evidence = path.join(workspace, 'artifacts', '1', 'completion.json');
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(evidence, '{}\n', 'utf8');
    const identity = 'NEX-7-0123456789abcdef';
    await mkdir(path.join(directory, 'requests'), { recursive: true });
    await writeFile(
      path.join(directory, 'requests', `${identity}.json`),
      `${JSON.stringify(
        {
          taskKey: workId,
          project,
          completionRevision: mergeRevision,
          workspaceRoot: workspace,
          requestedAt: '2026-09-29T10:00:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await mkdir(path.join(directory, 'analyses'), { recursive: true });
    await writeFile(
      path.join(directory, 'analyses', `${identity}.json`),
      `${JSON.stringify(
        legacyCompletionOutputSchema.parse({
          taskKey: workId,
          project,
          completionRevision: mergeRevision,
          profile,
          analyzedAt: '2026-09-29T10:00:01.000Z',
          observations: [
            {
              identity: '1',
              content: 'The completion analysis already accepted this lesson.',
              evidence: [
                { path: evidence, revision: mergeRevision, detail: 'The retained evidence.' },
              ],
              relatedMemories: [],
            },
          ],
        }),
        null,
        2,
      )}\n`,
      'utf8',
    );
    const service = await controlledService();
    const owner = createAnalyzeExperience({
      directory,
      project,
      profile,
      memory: { url: service.url },
      analyze: () => Promise.reject(new Error('The migrated output must be reused.')),
    });

    // An accepted analysis needs no original files; migration must not block its submission.
    await rm(workspace, { recursive: true });
    const problems = await owner.processPending();

    // The pending submission is retained under the migrated identity and submitted once.
    const submitted = service.requests.filter((request) => request.path === '/v1/observations');
    expect(submitted).toHaveLength(1);
    expect((submitted[0]?.body as { readonly sourceKey: string }).sourceKey).toBe(
      experienceObservationSourceKey(identity, '1'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the submission of observation 1 of NEX-7 is outstanding');
    const submission = JSON.parse(
      await readFile(experienceSubmissionFile(directory, identity, '1'), 'utf8'),
    ) as ExperienceSubmission;
    expect(submission.observation.provenance).toMatchObject({
      migratedFrom: { task: workId, completionRevision: mergeRevision },
    });
  });

  it('reuses a retained handoff analysis that predates the report binding without reinvoking', async () => {
    const retained = await harness((_context, workspace) => ok(observation(workspace)));
    await expect(retained.process()).resolves.toHaveLength(1);
    const saved = await analysisOf(retained);
    // The former handoff-shaped output states the same accepted observations without a Markdown
    // binding; it stays readable and submittable without a new report requirement.
    await writeFile(
      experienceAnalysisFile(retained.directory, retained.identity),
      `${JSON.stringify(
        {
          workId: saved.workId,
          project: saved.project,
          workflow: saved.workflow,
          attemptId: saved.attemptId,
          terminalId: saved.terminalId,
          profile: saved.profile,
          analyzedAt: saved.analyzedAt,
          observations: saved.observations,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const invocations = retained.requests.length;
    const problems = await retained.process({
      analyze: () => Promise.reject(new Error('The retained analysis must be reused.')),
    });

    expect(retained.requests).toHaveLength(invocations);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the submission of observation 1 of NEX-7 is outstanding');
  });

  it.each(['retained', 'experience', 'legacy'] as const)(
    'preserves an unusable saved analysis for a %s request through the next permitted attempt',
    async (format) => {
      const first = await harness(() => ok('{}'));
      if (format !== 'retained') {
        const file = experienceRequestFile(first.directory, first.identity);
        const request = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        delete request.evidenceRoot;
        await writeFile(
          file,
          JSON.stringify(
            format === 'experience'
              ? request
              : {
                  taskKey: workId,
                  project,
                  completionRevision: mergeRevision,
                  workspaceRoot: first.workspace,
                  requestedAt: request.requestedAt,
                },
          ),
        );
        await rm(evidenceRootOf(first), { recursive: true, force: true });
      }
      const malformed = '{"observations":[';
      const savedAnalysis = experienceAnalysisFile(first.directory, first.identity);
      await mkdir(path.dirname(savedAnalysis), { recursive: true });
      await writeFile(savedAnalysis, malformed, 'utf8');

      // The saved analysis is unusable: the read fails with explicit evidence and no invocation.
      const problems = await first.process();
      expect(problems.join('\n')).toContain('is not valid JSON');
      expect(problems.join('\n')).not.toContain('has not retained its evidence');
      expect(first.contexts).toHaveLength(0);
      const scope = {
        project,
        workId,
        area: evidenceRootOf(first),
        role: 'experience-analyst',
        reportKind: 'experience-analysis',
      };
      const rejection = (await readReportFeedback(evidenceRootOf(first))).find(
        (entry) => entry.record.kind === 'rejection',
      );
      expect(rejection?.record).toMatchObject({
        scope,
        operation: 'analyze-experience',
        source: { path: savedAnalysis },
        output: malformed,
        reason: expect.stringContaining('is not valid JSON'),
      });

      // Replacing the unusable record does not resolve the feedback by itself; the next permitted
      // attempt receives it and its validated saved analysis records the correction.
      await rm(savedAnalysis);
      await first.process({ analyze: (_context, workspace) => ok(observation(workspace)) });
      expect(first.contexts).toHaveLength(1);
      const context = first.contexts[0] ?? '';
      expect(context).toContain('Outstanding report rejection');
      expect(context).toContain(malformed);
      expect(context).toContain('is not valid JSON');
      await expect(
        outstandingReportFeedback({ areaRoot: evidenceRootOf(first), scope }),
      ).resolves.toEqual([]);
      await expect(analysisOf(first)).resolves.toMatchObject({
        workId,
        project,
        attemptId: format === 'legacy' ? `completion-${mergeRevision}` : attemptId,
      });
      expect(
        (await readReportFeedback(evidenceRootOf(first))).filter(
          (entry) => entry.record.kind === 'rejection',
        ),
      ).toHaveLength(1);
    },
  );

  it('retains a rejected analysis and supplies it to the next permitted attempt', async () => {
    const scope = {
      project,
      workId,
      role: 'experience-analyst',
      reportKind: 'experience-analysis',
    };
    const rejectedOutput = JSON.stringify({
      observations: [{ content: 'A fact without evidence.', evidence: [], relatedMemories: [] }],
    });

    // The schema-valid response violates the evidence rule; it is not accepted and its exact
    // bytes and reason are retained under the analysis report responsibility.
    const first = await harness(() => ok(rejectedOutput));
    const problems = await first.process();
    expect(problems.join('\n')).toContain('observation 1 has no supporting evidence');
    const rejection = (await readReportFeedback(evidenceRootOf(first))).find(
      (entry) => entry.record.kind === 'rejection',
    );
    expect(rejection?.record).toMatchObject({
      scope: { ...scope, area: evidenceRootOf(first) },
      operation: 'analyze-experience',
      profile,
      output: rejectedOutput,
      reason: 'observation 1 has no supporting evidence',
    });
    // The existing attempt policy stays authoritative: the attempt failed, no analysis was saved.
    expect(
      await readFile(
        path.join(first.directory, 'analyses', `${first.identity}.attempts.jsonl`),
        'utf8',
      ),
    ).toContain('"outcome":"failed"');
    await expect(
      stat(path.join(first.directory, 'analyses', `${first.identity}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // The next permitted attempt receives the rejected bytes and reason; the validated saved
    // replacement records the correction under the same responsibility.
    const contexts = first.contexts.length;
    await first.process({ analyze: (_context, workspace) => ok(observation(workspace)) });
    const context = first.contexts.at(-1) ?? '';
    expect(first.contexts.length).toBeGreaterThan(contexts);
    expect(context).toContain('Violated rule: observation 1 has no supporting evidence');
    expect(context).toContain('A fact without evidence.');
    expect(await analysisOf(first)).toMatchObject({ workId, project, attemptId });
    await expect(
      outstandingReportFeedback({
        areaRoot: evidenceRootOf(first),
        scope: { ...scope, area: evidenceRootOf(first) },
      }),
    ).resolves.toEqual([]);
  });

  it('retains a missing assigned Markdown and supplies it to the next permitted attempt', async () => {
    const first = await harness(
      (_context, workspace) => ok(observation(workspace)),
      // The invocation returns valid observations but never writes its assigned Markdown.
      'skip',
    );

    const problems = await first.process();
    expect(problems.join('\n')).toContain('Experience analysis report');
    expect(problems.join('\n')).toContain('does not exist');
    const scope = {
      project,
      workId,
      area: evidenceRootOf(first),
      role: 'experience-analyst',
      reportKind: 'experience-analysis',
    };
    const rejection = (await readReportFeedback(evidenceRootOf(first))).find(
      (entry) => entry.record.kind === 'rejection',
    );
    expect(rejection?.record).toMatchObject({
      scope,
      operation: 'analyze-experience',
      profile,
      source: null,
      assignedReport: {
        path: path.join(
          evidenceRootOf(first),
          'reports',
          first.requests[0]!.invocationId!,
          'experience-analysis.md',
        ),
      },
      reason: expect.stringContaining('does not exist'),
    });
    await expect(
      stat(path.join(first.directory, 'analyses', `${first.identity}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // The next permitted attempt receives the rejected bytes and reason, writes its Markdown and
    // records the correction, so repairing the file alone never cleared the obligation.
    await expect(
      first.process({
        analyze: (_context, workspace) => ok(observation(workspace)),
        report: 'write',
      }),
    ).resolves.toHaveLength(1);
    const context = first.contexts.at(-1) ?? '';
    expect(context).toContain('Outstanding report rejection');
    expect(context).toContain('Violated rule:');
    expect(context).toContain('does not exist');
    await expect(
      outstandingReportFeedback({ areaRoot: evidenceRootOf(first), scope }),
    ).resolves.toEqual([]);
    await expect(analysisOf(first)).resolves.toMatchObject({ workId, project, attemptId });
  });
});
