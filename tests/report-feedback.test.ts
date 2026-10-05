/**
 * Focused integration tests: the shared report-feedback helpers preserve a rejected report's
 * exact bytes, violated rule and attribution, derive outstanding feedback from rejections no valid
 * correction resolves, report unusable evidence explicitly, and keep parallel roles and
 * responsibilities independently attributable. The KAN-76 restart regression replays a malformed
 * retained requirements report through recovery-style reconciliation, clear-and-reselect and the
 * next permitted author round, proving the feedback survives and is retired only by the
 * producer-validated saved replacement.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ok } from '../src/result.js';
import type { AgentRoleRunner } from '../src/task-engine/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import {
  finishSuppliedCorrection,
  outstandingReportFeedback,
  readReportFeedback,
  recordReportCorrection,
  rejectReport,
  rejectUnusableRecord,
  reportFeedbackContextText,
  reportFeedbackRoot,
  retainSuppliedFeedback,
  writeReportFeedbackRecord,
  type ReportRejection,
  type ReportScope,
} from '../src/task-engine/actions/report-feedback.js';
import { repositoryState, scriptedGit } from './support/git.js';
import { writeAssignedReport } from './support/agent-runner.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix = 'nexus-report-feedback-'): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** One report responsibility over the supplied owning area. */
function scopeIn(area: string, overrides: Partial<ReportScope> = {}): ReportScope {
  return {
    project: 'NEX',
    workId: 'NEX-7',
    area,
    role: 'developer',
    reportKind: 'development',
    ...overrides,
  };
}

/** One rejected report retained under the supplied responsibility; asserts the exact reason. */
async function retainRejection(
  areaRoot: string,
  scope: ReportScope,
  settings: {
    readonly invocationId: string;
    readonly reason: string;
    readonly output: string | null;
  },
): Promise<string> {
  const error = await rejectReport({
    areaRoot,
    scope,
    invocationId: settings.invocationId,
    operation: 'Develop',
    profile: 'dev-a',
    context: 'Development round 1, task NEX-7.',
    source: null,
    output: settings.output,
    reason: settings.reason,
  }).then(
    () => null,
    (reason: Error) => reason,
  );
  expect(error?.message).toBe(settings.reason);
  const entry = (await readReportFeedback(areaRoot)).at(-1);
  expect(entry?.record.kind).toBe('rejection');
  return entry!.path;
}

it('retains the exact rejected output, violated rule and attribution', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const output = '{"status":"completed",';
  const reason = 'Development agent returned unusable output: Unexpected end of JSON input.';

  const record = await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-1',
    reason,
    output,
  });

  expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
    kind: 'rejection',
    scope,
    invocationId: 'invocation-1',
    operation: 'Develop',
    profile: 'dev-a',
    context: 'Development round 1, task NEX-7.',
    source: null,
    output,
    reason,
    report: null,
    assignedReport: null,
  });
  expect(path.dirname(record)).toBe(reportFeedbackRoot(areaRoot));
});

it('copies available rejected Markdown byte-for-byte and retains the attempted path', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const assigned = path.join(areaRoot, 'artifacts', '1', 'reports', 'invocation-1', 'developer.md');
  await mkdir(path.dirname(assigned), { recursive: true });
  const markdown = '# Report\r\n\r\nThe outcome explains the incomplete work.\r\n';
  await writeFile(assigned, markdown);

  const reason = 'The development agent returned an extra outcome field.';
  await expect(
    rejectReport({
      areaRoot,
      scope,
      invocationId: 'invocation-1',
      operation: 'Develop',
      profile: 'dev-a',
      context: 'Development round 1, task NEX-7.',
      source: null,
      output: '{"status":"completed","summary":"extra"}',
      reason,
      assignedReport: { path: assigned },
    }),
  ).rejects.toThrow(reason);

  const [entry] = await readReportFeedback(areaRoot);
  expect(entry?.record.kind).toBe('rejection');
  const rejection = entry!.record as ReportRejection;
  expect(rejection.assignedReport).toEqual({ path: assigned });
  expect(rejection.report).not.toBeNull();
  // The copy is byte-for-byte identical and lives outside the disposable artifacts directory.
  expect(await readFile(rejection.report!.path, 'utf8')).toBe(markdown);
  expect(path.dirname(rejection.report!.path)).toBe(reportFeedbackRoot(areaRoot));

  // The context names the readable rejected Markdown and its attempted path.
  const text = reportFeedbackContextText(await outstandingReportFeedback({ areaRoot, scope })).join(
    '\n',
  );
  expect(text).toContain(`Rejected Markdown report (exact copy): ${rejection.report!.path}`);
  expect(text).toContain(`Assigned report path as attempted: ${assigned}`);

  // A missing assigned report stays explicitly unavailable with its attempted path retained.
  await rm(assigned);
  await expect(
    rejectReport({
      areaRoot,
      scope,
      invocationId: 'invocation-2',
      operation: 'Develop',
      profile: 'dev-a',
      context: 'Development round 1, task NEX-7.',
      source: null,
      output: 'not json',
      reason: 'The development agent returned unusable output.',
      assignedReport: { path: assigned },
    }),
  ).rejects.toThrow('unusable output');
  const records = await readReportFeedback(areaRoot);
  const missing = records.at(-1)!.record as ReportRejection;
  expect(missing.report).toBeNull();
  expect(missing.assignedReport).toEqual({ path: assigned });
  expect(
    reportFeedbackContextText([{ record: missing, path: records.at(-1)!.path }]).join('\n'),
  ).toContain('The rejected Markdown report itself is unavailable');
});

it('reports the original rejection when its evidence cannot be persisted', async () => {
  const areaRoot = await temporaryDirectory();
  // A file where the feedback directory belongs makes the evidence write fail.
  await writeFile(path.join(areaRoot, 'report-feedback'), 'not a directory\n');
  const error = await rejectReport({
    areaRoot,
    scope: scopeIn(areaRoot),
    invocationId: 'invocation-1',
    operation: 'Develop',
    profile: 'dev-a',
    context: 'Development round 1, task NEX-7.',
    source: null,
    output: 'unusable bytes',
    reason: 'The specific violated rule.',
  }).then(
    () => null,
    (reason: Error) => reason,
  );
  expect(error?.message).toContain('The specific violated rule.');
  expect(error?.message).toContain('The rejection evidence could not be saved:');
});

it('preserves an unusable retained record and states when its bytes are unavailable', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot, { role: 'reviewer', reportKind: 'review' });
  const retained = path.join(areaRoot, 'artifacts', '1', 'review.json');
  await mkdir(path.dirname(retained), { recursive: true });
  await writeFile(retained, '{"verdict":"approve"}');
  const readError = new Error(
    `Record at "${retained}" does not match its declared content type: findings: Required`,
  );

  await expect(
    rejectUnusableRecord({
      areaRoot,
      scope,
      invocationId: 'invocation-1',
      operation: 'review',
      profile: 'reviewer',
      context: 'Review round 1, task NEX-7.',
      file: retained,
      error: readError,
    }),
  ).rejects.toThrow('does not match its declared content type');
  const [readable] = await readReportFeedback(areaRoot);
  expect(readable?.record).toMatchObject({
    kind: 'rejection',
    operation: 'review',
    source: { path: retained },
    output: '{"verdict":"approve"}',
    reason: `Record at "${retained}" does not match its declared content type: findings: Required`,
  });

  const missing = path.join(areaRoot, 'artifacts', '2', 'review.json');
  await expect(
    rejectUnusableRecord({
      areaRoot,
      scope,
      invocationId: 'invocation-1',
      operation: 'review',
      profile: 'reviewer',
      context: 'Review round 1, task NEX-7.',
      file: missing,
      error: new Error(`Record at "${missing}" is not valid JSON: Unexpected token.`),
    }),
  ).rejects.toThrow('The record has no readable bytes');
  const records = await readReportFeedback(areaRoot);
  const unavailable = records.find((entry) => entry.path !== readable?.path);
  expect(unavailable?.record).toMatchObject({
    kind: 'rejection',
    source: { path: missing },
    output: null,
    reason: expect.stringContaining('The record has no readable bytes.'),
  });
});

it('reads a former rejection without Markdown references as retained evidence', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  // The shape written before report separation carried no report or assignedReport fields; the
  // bytes stay untouched and both references read as explicitly unavailable.
  const former = {
    kind: 'rejection',
    scope,
    invocationId: 'invocation-1',
    operation: 'Develop',
    profile: 'dev-a',
    context: 'Development round 1, task NEX-7.',
    source: null,
    output: '{"status":"completed",',
    reason: 'Development agent returned unusable output: Unexpected end of JSON input.',
  };
  await mkdir(reportFeedbackRoot(areaRoot), { recursive: true });
  const file = path.join(reportFeedbackRoot(areaRoot), '000000001-legacy.json');
  await writeFile(file, `${JSON.stringify(former, null, 2)}\n`, 'utf8');

  const [readable] = await readReportFeedback(areaRoot);
  expect(readable?.record).toEqual({ ...former, report: null, assignedReport: null });
  const outstanding = await outstandingReportFeedback({ areaRoot, scope });
  expect(outstanding).toHaveLength(1);
  expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(former, null, 2)}\n`);
});

it('recovers the report reference of a damaged saved outcome for rejection evidence', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const reportFile = path.join(areaRoot, 'artifacts', '1', 'reports', 'inv-1', 'developer.md');
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, 'Implemented the retry guard.\n', 'utf8');
  const record = path.join(areaRoot, 'artifacts', '1', 'development.json');
  // The saved outcome is damaged: its reportIdentity is missing, so it must not be parsed as a
  // legacy combined report. Its readable report still reaches the rejection evidence.
  await writeFile(
    record,
    `${JSON.stringify(
      {
        taskKey: 'NEX-7',
        profile: 'dev-a',
        status: 'completed',
        baseRevision: 'a'.repeat(40),
        headRevision: 'b'.repeat(40),
        role: 'developer',
        report: { path: reportFile },
        invocationId: 'inv-1',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const readError = new Error(
    `Artifact at "${record}" does not match its declared content type: reportIdentity: Required`,
  );

  await expect(
    rejectUnusableRecord({
      areaRoot,
      scope,
      invocationId: 'inv-2',
      operation: 'develop',
      profile: 'dev-a',
      context: 'Development round 2, task NEX-7.',
      file: record,
      error: readError,
    }),
  ).rejects.toThrow('reportIdentity: Required');

  const [entry] = await readReportFeedback(areaRoot);
  expect(entry?.record).toMatchObject({
    kind: 'rejection',
    assignedReport: { path: reportFile },
    output: await readFile(record, 'utf8'),
    reason: expect.stringContaining('reportIdentity: Required'),
  });
  const rejection = entry?.record as ReportRejection;
  expect(rejection.report).not.toBeNull();
  expect(await readFile(rejection.report!.path, 'utf8')).toBe('Implemented the retry guard.\n');
});

it('finishes only the supplied rejections a saved replacement answers', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const artifact = path.join(areaRoot, 'artifacts', '2', 'development.json');
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, '{"status":"completed"}', 'utf8');
  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-1',
    reason: 'First violated rule.',
    output: 'first rejected bytes',
  });
  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-2',
    reason: 'Second violated rule.',
    output: 'second rejected bytes',
  });
  const retained = await readReportFeedback(areaRoot);
  const first = retained.find(
    (entry) => entry.record.kind === 'rejection' && entry.record.reason === 'First violated rule.',
  )!.path;
  const second = retained.find(
    (entry) => entry.record.kind === 'rejection' && entry.record.reason === 'Second violated rule.',
  )!.path;
  // The invocation was supplied only the first rejection; the second was created later.
  await retainSuppliedFeedback({
    areaRoot,
    invocationId: 'invocation-9',
    rejections: [{ path: first }],
  });

  await expect(
    finishSuppliedCorrection({
      areaRoot,
      scope,
      invocationId: 'invocation-9',
      artifact: { path: artifact },
      content: { status: 'completed' },
    }),
  ).resolves.toBe(true);
  const outstanding = await outstandingReportFeedback({ areaRoot, scope });
  expect(outstanding.map((entry) => entry.path)).toEqual([second]);
  // Replaying the same saved replacement does not name a rejection created later or record a
  // duplicate correction.
  await expect(
    finishSuppliedCorrection({
      areaRoot,
      scope,
      invocationId: 'invocation-9',
      artifact: { path: artifact },
      content: { status: 'completed' },
    }),
  ).resolves.toBe(false);
  expect(
    (await readReportFeedback(areaRoot)).filter((entry) => entry.record.kind === 'correction'),
  ).toHaveLength(1);
});

it('retires only the rejections a valid matching correction names', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const reporter = scopeIn(areaRoot, { role: 'reviewer', reportKind: 'review' });
  const artifact = path.join(areaRoot, 'artifacts', '1', 'development.json');
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, '{"status":"completed"}');

  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-1',
    reason: 'First violated rule.',
    output: 'first rejected bytes',
  });
  const first = (await readReportFeedback(areaRoot))[0]!.path;
  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-2',
    reason: 'Second violated rule.',
    output: 'second rejected bytes',
  });

  // Repairing the retained artifact is not a resolution: both rejections stay outstanding.
  await writeFile(artifact, '{"status":"completed","repair":true}');
  expect(await outstandingReportFeedback({ areaRoot, scope })).toHaveLength(2);

  // A correction of another responsibility cannot retire this one.
  await writeReportFeedbackRecord(areaRoot, {
    kind: 'correction',
    scope: reporter,
    rejections: [{ path: first }],
    artifact: { path: artifact },
    artifactIdentity: 'foreign-identity',
    invocationId: 'invocation-3',
  });
  expect(await outstandingReportFeedback({ areaRoot, scope })).toHaveLength(2);

  // A valid matching correction naming the exact record retires that rejection only.
  await recordReportCorrection({
    areaRoot,
    scope,
    rejections: [{ path: first }],
    artifact: { path: artifact },
    content: { status: 'completed', repair: true },
    invocationId: 'invocation-4',
  });
  const outstanding = await outstandingReportFeedback({ areaRoot, scope });
  expect(outstanding).toHaveLength(1);
  expect(outstanding[0]?.path).not.toBe(first);

  // The rejection history stays attributable; a correction cannot name foreign or missing records.
  expect(
    (await readReportFeedback(areaRoot)).filter((entry) => entry.record.kind === 'rejection'),
  ).toHaveLength(2);
  await expect(
    recordReportCorrection({
      areaRoot,
      scope: reporter,
      rejections: [{ path: outstanding[0]!.path }],
      artifact: { path: artifact },
      content: { status: 'completed' },
      invocationId: 'invocation-5',
    }),
  ).rejects.toThrow('belongs to another report responsibility');
  await expect(
    recordReportCorrection({
      areaRoot,
      scope,
      rejections: [{ path: path.join(reportFeedbackRoot(areaRoot), 'missing.json') }],
      artifact: { path: artifact },
      content: { status: 'completed' },
      invocationId: 'invocation-5',
    }),
  ).rejects.toThrow('names no retained rejection record');
});

it('treats an unusable feedback record as an explicit error, never an empty feedback set', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  await mkdir(reportFeedbackRoot(areaRoot), { recursive: true });
  await writeFile(path.join(reportFeedbackRoot(areaRoot), 'broken.json'), '{"kind":"rejection"}');
  await expect(outstandingReportFeedback({ areaRoot, scope })).rejects.toThrow(
    'does not match its declared content type',
  );
  await writeFile(path.join(reportFeedbackRoot(areaRoot), 'broken.json'), 'not json');
  await expect(outstandingReportFeedback({ areaRoot, scope })).rejects.toThrow('is not valid JSON');
});

it('hands the reason, exact bytes and attribution back as rejected historical evidence', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-1',
    reason: 'The report omitted its required basis.',
    output: 'line one\nline two',
  });
  const entries = await outstandingReportFeedback({ areaRoot, scope });
  const text = reportFeedbackContextText(entries).join('\n');
  expect(text).toContain('rejected historical evidence');
  expect(text).toContain('Violated rule: The report omitted its required basis.');
  expect(text).toContain('invocation invocation-1');
  expect(text).toContain('  line one\n  line two');
  expect(text).toContain(
    'the current input, response rules and finding obligations remain authoritative',
  );
  expect(reportFeedbackContextText([])).toEqual([]);
});

it('keeps parallel roles, work items and report kinds independently attributable', async () => {
  const areaRoot = await temporaryDirectory();
  const author = scopeIn(areaRoot, { role: 'requirements-author', reportKind: 'stage-author' });
  const evaluator = scopeIn(areaRoot, {
    role: 'requirements-evaluator',
    reportKind: 'stage-evaluation',
  });
  await retainRejection(areaRoot, author, {
    invocationId: 'invocation-author',
    reason: 'The author report is unusable.',
    output: 'author bytes',
  });
  await retainRejection(areaRoot, evaluator, {
    invocationId: 'invocation-evaluator',
    reason: 'The evaluator report is unusable.',
    output: 'evaluator bytes',
  });

  const authorFeedback = await outstandingReportFeedback({ areaRoot, scope: author });
  const evaluatorFeedback = await outstandingReportFeedback({ areaRoot, scope: evaluator });
  expect(authorFeedback).toHaveLength(1);
  expect(authorFeedback[0]?.record.invocationId).toBe('invocation-author');
  expect(evaluatorFeedback).toHaveLength(1);
  expect(evaluatorFeedback[0]?.record.invocationId).toBe('invocation-evaluator');
  // The author never receives the evaluator's rejection or bytes.
  expect(reportFeedbackContextText(authorFeedback).join('\n')).not.toContain('evaluator bytes');

  for (const foreign of [
    scopeIn(areaRoot, { workId: 'NEX-8' }),
    scopeIn(areaRoot, { project: 'OTHER' }),
    scopeIn(areaRoot, { area: path.join(areaRoot, 'other-stage') }),
    scopeIn(areaRoot, { reportKind: 'other-contract' }),
  ]) {
    await expect(outstandingReportFeedback({ areaRoot, scope: foreign })).resolves.toEqual([]);
  }
});

it('keeps delivery feedback outside the disposable state and artifacts directories', async () => {
  const issueRoot = await temporaryDirectory();
  const scope = scopeIn(issueRoot, { role: 'reviewer', reportKind: 'review' });
  const record = await retainRejection(issueRoot, scope, {
    invocationId: 'invocation-1',
    reason: 'The review report is unusable.',
    output: 'review bytes',
  });
  // Delivery cleanup discards state/ and artifacts/; the issue-root evidence survives.
  await mkdir(path.join(issueRoot, 'state'), { recursive: true });
  await mkdir(path.join(issueRoot, 'artifacts', '1'), { recursive: true });
  await rm(path.join(issueRoot, 'state'), { recursive: true, force: true });
  await rm(path.join(issueRoot, 'artifacts'), { recursive: true, force: true });
  await expect(outstandingReportFeedback({ areaRoot: issueRoot, scope })).resolves.toHaveLength(1);
  expect(record.startsWith(reportFeedbackRoot(issueRoot))).toBe(true);
});

const stage = 'requirements' as const;

/**
 * The captured KAN-76 round-2 response as the old failure retained it: an agent response written
 * straight into the action-owned record, missing the stage and revision metadata the action adds.
 */
const capturedMalformedAuthor = {
  outcome: 'skip-proposed',
  summary: 'The retained requirements already satisfy the stage.',
  documents: [],
  sourcePaths: [],
  observation: null,
  plan: [],
  skip: {
    reason: 'The exact current worktree documents already cover the captured outcome.',
    references: ['docs/requirements.md'],
  },
  question: null,
  upstream: null,
  findingResponses: [],
};

/** The conforming skip the next permitted KAN-76 author round returns. */
const conformingSkip = {
  outcome: 'skip-proposed',
  documents: [],
  sourcePaths: [],
  observation: null,
  plan: [],
  skip: { references: ['docs/requirements.md'] },
  question: null,
  upstream: null,
};

/** One KAN-76-style retained requirements area whose round 2 record is the old malformed report. */
async function retainedKan76Area(): Promise<{
  readonly selectionFile: string;
  readonly root: string;
  readonly worktree: string;
}> {
  const directory = await temporaryDirectory('nexus-kan76-restart-');
  const issueRoot = path.join(directory, 'HARN', 'KAN-76');
  const root = path.join(issueRoot, stage);
  const worktree = path.join(issueRoot, 'worktree');
  await mkdir(path.join(worktree, 'docs'), { recursive: true });
  await writeFile(
    path.join(worktree, 'docs', 'requirements.md'),
    '# Requirements\n\nThe captured outcome and its rules.\n',
  );
  await mkdir(path.join(root, 'artifacts', '1'), { recursive: true });
  await writeFile(
    path.join(root, 'artifacts', '1', 'author.json'),
    JSON.stringify({
      stage,
      revision: 1,
      outcome: 'authored',
      summary: 'Defined the captured outcome.',
      documents: [{ path: 'docs/requirements.md', description: 'Defines the outcome.' }],
      sourcePaths: [],
      observation: null,
      plan: [],
      skip: null,
      question: null,
      upstream: null,
      findingResponses: [],
    }),
  );
  await mkdir(path.join(root, 'artifacts', '2'), { recursive: true });
  await writeFile(
    path.join(root, 'artifacts', '2', 'author.json'),
    JSON.stringify(capturedMalformedAuthor),
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
  await mkdir(path.join(root, 'artifacts', '3'), { recursive: true });
  const selectionFile = path.join(directory, 'selection.json');
  const selection = {
    taskKey: 'KAN-76',
    source: { kind: 'jira', issueId: '10994' },
    task: { id: '10994', key: 'KAN-76', fields: {} },
    conversation: [],
    workspace: { root: issueRoot },
    stage,
  };
  await writeFile(selectionFile, JSON.stringify(selection));
  return { selectionFile, root, worktree };
}

/** One scripted author invocation returning the supplied response and recording its context. */
function authorRunner(response: unknown, contexts: string[]): AgentRoleRunner {
  return {
    async run(request) {
      contexts.push(request.context);
      await writeAssignedReport(request.context, '# Controlled requirements author report\n');
      return ok({ output: JSON.stringify(response) });
    },
  };
}

it('resumes KAN-76-style retained work with the correction feedback supplied to the author', async () => {
  const { selectionFile, root, worktree } = await retainedKan76Area();
  const scope: ReportScope = {
    project: 'HARN',
    workId: 'KAN-76',
    area: root,
    role: 'requirements-author',
    reportKind: 'stage-author',
  };
  const malformedFile = path.join(root, 'artifacts', '2', 'author.json');
  const malformedBytes = await readFile(malformedFile, 'utf8');

  // Recovery's reconciliation: before repairing the retained record, preserve its readable bytes,
  // the violated rule and the attribution as an unattributed rejection of the author's report.
  await writeReportFeedbackRecord(root, {
    kind: 'rejection',
    scope,
    invocationId: null,
    operation: 'stage-author',
    profile: null,
    context: 'Recovered KAN-76 retained requirements round 2, reconciled before the next round.',
    source: { path: malformedFile },
    output: malformedBytes,
    reason:
      `Record at "${malformedFile}" does not match its declared content type: ` +
      'stage: Invalid input; revision: Invalid input.',
    report: null,
    assignedReport: null,
  });
  // The explicit repair returns the producer-owned metadata, without erasing the rejection history.
  await writeFile(
    malformedFile,
    JSON.stringify({ stage, revision: 2, ...capturedMalformedAuthor }),
  );
  // Historical repair alone does not resolve the feedback.
  expect(await outstandingReportFeedback({ areaRoot: root, scope })).toHaveLength(1);

  // Recovery cleared the selection; selection reselects the retained work before the next round.
  await rm(selectionFile);
  await writeFile(
    selectionFile,
    JSON.stringify({
      taskKey: 'KAN-76',
      source: { kind: 'jira', issueId: '10994' },
      task: { id: '10994', key: 'KAN-76', fields: {} },
      conversation: [],
      workspace: { root: path.dirname(root) },
      stage,
    }),
  );

  const contexts: string[] = [];
  const author = createStageAuthor({
    selectionFile,
    stage,
    git: scriptedGit([repositoryState()]).git,
    publish: () => undefined,
    runner: authorRunner(conformingSkip, contexts),
  });
  await expect(author({ task: 'propose' })).resolves.toBe('skip-proposed');

  // The next permitted round received the reason, the exact rejected bytes and the attribution.
  const context = contexts.join('\n');
  expect(context).toContain('Violated rule:');
  expect(context).toContain('does not match its declared content type');
  expect(context).toContain('Recovered KAN-76 retained requirements round 2');
  expect(context).toContain('Rejected output (exact returned bytes):');
  expect(context).toContain('The retained requirements already satisfy the stage.');
  expect(context).toContain('rejected historical evidence');

  // The producer-validated saved replacement records the correction; the history stays readable.
  expect(
    JSON.parse(await readFile(path.join(root, 'artifacts', '3', 'author.json'), 'utf8')),
  ).toMatchObject({
    stage,
    revision: 3,
    outcome: 'skip-proposed',
  });
  await expect(outstandingReportFeedback({ areaRoot: root, scope })).resolves.toEqual([]);
  const records = await readReportFeedback(root);
  expect(records.filter((entry) => entry.record.kind === 'rejection')).toHaveLength(1);
  expect(records.filter((entry) => entry.record.kind === 'correction')).toHaveLength(1);

  // A later rejection remains outstanding on its own while the corrected history stays retired.
  const malformed: string[] = [];
  const later = createStageAuthor({
    selectionFile,
    stage,
    git: scriptedGit([repositoryState()]).git,
    publish: () => undefined,
    runner: {
      async run(request) {
        malformed.push(request.context);
        return ok({ output: '{"outcome":"skip-proposed"' });
      },
    },
  });
  await expect(later({ task: 'propose' })).rejects.toThrow('returned unusable output');
  const outstanding = await outstandingReportFeedback({ areaRoot: root, scope });
  expect(outstanding).toHaveLength(1);
  expect(outstanding[0]?.record.reason).toContain('returned unusable output');
  expect(outstanding[0]?.record.output).toBe('{"outcome":"skip-proposed"');
  expect(worktree).toContain('worktree');
});

it('preserves an unusable retained evaluation under the evaluator responsibility', async () => {
  const { selectionFile, root } = await retainedKan76Area();
  // The history is repaired as before; the retained round-2 evaluation is the unusable record.
  await writeFile(
    path.join(root, 'artifacts', '2', 'author.json'),
    JSON.stringify({ stage, revision: 2, ...capturedMalformedAuthor }),
  );
  const evaluationFile = path.join(root, 'artifacts', '2', 'evaluation.json');
  await writeFile(evaluationFile, '{"assessedRevision":2,"verdict":"accepted"}');
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    JSON.stringify({
      stage,
      round: 3,
      route: 'next',
      profiles: { author: 'nexus-sol', evaluator: 'nexus-sol' },
    }),
  );
  const scope: ReportScope = {
    project: 'HARN',
    workId: 'KAN-76',
    area: root,
    role: 'requirements-evaluator',
    reportKind: 'stage-evaluation',
  };
  const git = () => scriptedGit([repositoryState()]).git;

  // The author's round cannot rely on an unreadable evaluation: it fails and preserves the record
  // under the evaluator's responsibility, not its own.
  const author = createStageAuthor({
    selectionFile,
    stage,
    git: git(),
    publish: () => undefined,
    runner: authorRunner(conformingSkip, []),
  });
  await expect(author({ task: 'propose' })).rejects.toThrow(
    'does not match its declared content type',
  );
  const outstanding = await outstandingReportFeedback({ areaRoot: root, scope });
  expect(outstanding).toHaveLength(1);
  expect(outstanding[0]?.record).toMatchObject({
    scope,
    operation: 'stage-evaluator',
    source: { path: evaluationFile },
    output: '{"assessedRevision":2,"verdict":"accepted"}',
  });

  // The evaluator's own next invocation fails on the same explicit evidence and retains its own
  // attributable read of the record.
  await writeFile(
    path.join(root, 'artifacts', '3', 'author.json'),
    JSON.stringify({ stage, revision: 3, ...capturedMalformedAuthor }),
  );
  const evaluator = createStageEvaluator({
    selectionFile,
    stage,
    git: git(),
    publish: () => undefined,
    runner: authorRunner({}, []),
  });
  await expect(evaluator()).rejects.toThrow('does not match its declared content type');
  const retained = await outstandingReportFeedback({ areaRoot: root, scope });
  expect(retained).toHaveLength(2);
  expect(new Set(retained.map((entry) => entry.record.invocationId)).size).toBe(2);
});
