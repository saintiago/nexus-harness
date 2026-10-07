/**
 * Focused integration tests: the shared validation-error helpers preserve a rejected report's
 * exact bytes, violated rule and attribution as readable history, keep one pending context per
 * responsible work/role/response variant, report unusable evidence explicitly, clear the context
 * only through owner validation of a saved replacement, convert a former rejection/correction
 * ledger once, and keep parallel roles and responsibilities independently attributable. The
 * KAN-76 restart regression replays a malformed retained requirements report through
 * recovery-style reconciliation, clear-and-reselect and the next permitted author round, proving
 * the pending context survives and is cleared by the producer-validated saved replacement.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ok } from '../src/result.js';
import type { AgentRoleRunner } from '../src/task-engine/index.js';
import { createStageAuthor } from '../src/task-engine/actions/preparation/stage-author/index.js';
import { createStageEvaluator } from '../src/task-engine/actions/preparation/stage-evaluator/index.js';
import {
  clearPendingValidationError,
  pendingValidationErrorFile,
  readPendingValidationError,
  readValidationErrorHistory,
  rejectReport,
  rejectUnusableRecord,
  reportFeedbackRoot,
  validationErrorContextText,
  type PendingValidationError,
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
    readonly invocationId: string | null;
    readonly reason: string;
    readonly output: string | null;
  },
): Promise<void> {
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
}

/** The pending context of one responsibility; asserts that one exists. */
async function pendingOf(areaRoot: string, scope: ReportScope): Promise<PendingValidationError> {
  const pending = await readPendingValidationError({ areaRoot, scope });
  expect(pending).not.toBeNull();
  return pending!;
}

it('retains the exact rejected output, violated rule and attribution and makes it pending', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const output = '{"status":"completed",';
  const reason = 'Development agent returned unusable output: Unexpected end of JSON input.';

  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-1',
    reason,
    output,
  });

  const [entry] = await readValidationErrorHistory(areaRoot);
  expect(entry?.record).toEqual({
    kind: 'validation-error',
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
  expect(entry!.path.startsWith(reportFeedbackRoot(areaRoot))).toBe(true);

  const pending = await pendingOf(areaRoot, scope);
  expect(pending.entries).toEqual([
    {
      invocationId: 'invocation-1',
      operation: 'Develop',
      profile: 'dev-a',
      context: 'Development round 1, task NEX-7.',
      source: null,
      output,
      reason,
      report: null,
      assignedReport: null,
      evidence: { path: entry!.path },
    },
  ]);
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

  const [entry] = await readValidationErrorHistory(areaRoot);
  const rejection = entry!.record;
  expect(rejection.assignedReport).toEqual({ path: assigned });
  expect(rejection.report).not.toBeNull();
  // The copy is byte-for-byte identical and lives outside the disposable artifacts directory.
  expect(await readFile(rejection.report!.path, 'utf8')).toBe(markdown);
  expect(path.dirname(rejection.report!.path)).toBe(
    path.join(reportFeedbackRoot(areaRoot), 'history'),
  );

  // The context names the readable rejected Markdown and its attempted path.
  const text = validationErrorContextText(await pendingOf(areaRoot, scope)).join('\n');
  expect(text).toContain(`Rejected Markdown report (exact copy): ${rejection.report!.path}`);
  expect(text).toContain(`Assigned report path as attempted: ${assigned}`);

  // A missing assigned report stays explicitly unavailable with its attempted path retained.
  await rm(assigned);
  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-2',
    reason: 'The development agent returned unusable output.',
    output: 'not json',
  });
  const missing = (await readValidationErrorHistory(areaRoot)).at(-1)!;
  expect(missing.record.report).toBeNull();
  expect(missing.record.assignedReport).toBeNull();
  expect(validationErrorContextText(await pendingOf(areaRoot, scope)).join('\n')).toContain(
    'The rejected Markdown report itself is unavailable',
  );
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
  expect(error?.message).toContain('could not be saved');
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
  const [readable] = await readValidationErrorHistory(areaRoot);
  expect(readable?.record).toMatchObject({
    kind: 'validation-error',
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
  const records = await readValidationErrorHistory(areaRoot);
  const unavailable = records.find((entry) => entry.path !== readable?.path);
  expect(unavailable?.record).toMatchObject({
    kind: 'validation-error',
    source: { path: missing },
    output: null,
    reason: expect.stringContaining('The record has no readable bytes.'),
  });
});

it('recovers the report reference of a damaged saved outcome for validation-error evidence', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const reportFile = path.join(areaRoot, 'artifacts', '1', 'reports', 'inv-1', 'developer.md');
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, 'Implemented the retry guard.\n', 'utf8');
  const record = path.join(areaRoot, 'artifacts', '1', 'development.json');
  // The saved outcome is damaged: its invocation identity is missing, so it must not be parsed as
  // a legacy combined report. Its readable report still reaches the rejection evidence.
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
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const readError = new Error(
    `Artifact at "${record}" does not match its declared content type: invocationId: Required`,
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
  ).rejects.toThrow('invocationId: Required');

  const [entry] = await readValidationErrorHistory(areaRoot);
  expect(entry?.record).toMatchObject({
    kind: 'validation-error',
    assignedReport: { path: reportFile },
    output: await readFile(record, 'utf8'),
    reason: expect.stringContaining('invocationId: Required'),
  });
  const rejection = entry!.record;
  expect(rejection.report).not.toBeNull();
  expect(await readFile(rejection.report!.path, 'utf8')).toBe('Implemented the retry guard.\n');
});

it('updates the pending reason on a later invalid attempt while earlier evidence stays readable', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-1',
    reason: 'First violated rule.',
    output: 'first rejected bytes',
  });
  const first = (await readValidationErrorHistory(areaRoot))[0]!.path;
  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-2',
    reason: 'Second violated rule.',
    output: 'second rejected bytes',
  });

  const pending = await pendingOf(areaRoot, scope);
  expect(pending.entries).toHaveLength(1);
  expect(pending.entries[0]).toMatchObject({
    invocationId: 'invocation-2',
    reason: 'Second violated rule.',
    output: 'second rejected bytes',
  });

  const history = await readValidationErrorHistory(areaRoot);
  expect(history.map((entry) => entry.record.reason)).toEqual([
    'First violated rule.',
    'Second violated rule.',
  ]);
  expect(history[0]!.path).toBe(first);
});

it('clears pending context only through owner validation, keeping history readable', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-1',
    reason: 'The report omitted its required basis.',
    output: 'rejected bytes',
  });
  expect(await pendingOf(areaRoot, scope)).toBeDefined();
  const file = pendingValidationErrorFile(areaRoot, scope);
  expect(await stat(file)).toBeDefined();

  // The owner validated and saved a replacement: the pending context is cleared.
  await expect(clearPendingValidationError({ areaRoot, scope })).resolves.toBe(true);
  await expect(readPendingValidationError({ areaRoot, scope })).resolves.toBeNull();
  await expect(clearPendingValidationError({ areaRoot, scope })).resolves.toBe(false);
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  // The readable history is never removed.
  expect(await readValidationErrorHistory(areaRoot)).toHaveLength(1);
});

it('treats an unreadable pending context as an explicit error, never an empty context', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const file = pendingValidationErrorFile(areaRoot, scope);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"kind":"pending-validation-error"}');
  await expect(readPendingValidationError({ areaRoot, scope })).rejects.toThrow(
    'does not match its declared content type',
  );
  await writeFile(file, 'not json');
  await expect(readPendingValidationError({ areaRoot, scope })).rejects.toThrow(
    'is not valid JSON',
  );
});

it('hands the reason, exact bytes and attribution back as rejected historical evidence', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  await retainRejection(areaRoot, scope, {
    invocationId: 'invocation-1',
    reason: 'The report omitted its required basis.',
    output: 'line one\nline two',
  });
  const text = validationErrorContextText(await pendingOf(areaRoot, scope)).join('\n');
  expect(text).toContain('rejected historical evidence');
  expect(text).toContain('Violated rule: The report omitted its required basis.');
  expect(text).toContain('invocation invocation-1');
  expect(text).toContain('  line one\n  line two');
  expect(text).toContain(
    'the current input, response rules and finding obligations remain authoritative',
  );
  expect(validationErrorContextText(null)).toEqual([]);
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

  const authorPending = await pendingOf(areaRoot, author);
  const evaluatorPending = await pendingOf(areaRoot, evaluator);
  expect(authorPending.entries[0]?.invocationId).toBe('invocation-author');
  expect(evaluatorPending.entries[0]?.invocationId).toBe('invocation-evaluator');
  // The author never receives the evaluator's rejection or bytes.
  expect(validationErrorContextText(authorPending).join('\n')).not.toContain('evaluator bytes');
  expect(pendingValidationErrorFile(areaRoot, author)).not.toBe(
    pendingValidationErrorFile(areaRoot, evaluator),
  );

  for (const foreign of [
    scopeIn(areaRoot, { workId: 'NEX-8' }),
    scopeIn(areaRoot, { project: 'OTHER' }),
    scopeIn(areaRoot, { area: path.join(areaRoot, 'other-stage') }),
    scopeIn(areaRoot, { reportKind: 'other-contract' }),
  ]) {
    await expect(readPendingValidationError({ areaRoot, scope: foreign })).resolves.toBeNull();
  }
});

it('keeps delivery feedback outside the disposable state and artifacts directories', async () => {
  const issueRoot = await temporaryDirectory();
  const scope = scopeIn(issueRoot, { role: 'reviewer', reportKind: 'review' });
  await retainRejection(issueRoot, scope, {
    invocationId: 'invocation-1',
    reason: 'The review report is unusable.',
    output: 'review bytes',
  });
  // Delivery cleanup discards state/ and artifacts/; the issue-root evidence survives.
  await mkdir(path.join(issueRoot, 'state'), { recursive: true });
  await mkdir(path.join(issueRoot, 'artifacts', '1'), { recursive: true });
  await rm(path.join(issueRoot, 'state'), { recursive: true, force: true });
  await rm(path.join(issueRoot, 'artifacts'), { recursive: true, force: true });
  await expect(pendingOf(issueRoot, scope)).toBeDefined();
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

it('converts a former rejection/correction ledger into pending context and readable history', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const other = scopeIn(areaRoot, { role: 'reviewer', reportKind: 'review' });
  const resolvedFile = path.join(reportFeedbackRoot(areaRoot), '000000001-resolved.json');
  const unresolvedFile = path.join(reportFeedbackRoot(areaRoot), '000000002-unresolved.json');
  const foreignFile = path.join(reportFeedbackRoot(areaRoot), '000000003-foreign.json');
  const correctionFile = path.join(reportFeedbackRoot(areaRoot), '000000004-correction.json');
  const suppliedFile = path.join(reportFeedbackRoot(areaRoot), 'supplied', 'invocation-1.json');
  const rejection = {
    kind: 'rejection',
    scope,
    invocationId: 'invocation-1',
    operation: 'Develop',
    profile: 'dev-a',
    context: 'Development round 1, task NEX-7.',
    source: null,
    output: 'resolved bytes',
    reason: 'The first rule was violated.',
    report: null,
    assignedReport: null,
  };
  await mkdir(path.dirname(suppliedFile), { recursive: true });
  await writeFile(resolvedFile, `${JSON.stringify(rejection, null, 2)}\n`);
  await writeFile(
    unresolvedFile,
    `${JSON.stringify(
      {
        ...rejection,
        invocationId: null,
        output: 'unresolved bytes',
        reason: 'The second rule was violated.',
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    foreignFile,
    `${JSON.stringify({ ...rejection, scope: other, reason: 'A foreign rule was violated.' })}\n`,
  );
  // A former rejection with no Markdown references stays readable history as well.
  await writeFile(
    correctionFile,
    `${JSON.stringify({
      kind: 'correction',
      scope,
      rejections: [{ path: resolvedFile }],
      artifact: { path: path.join(areaRoot, 'artifacts', '1', 'development.json') },
      artifactIdentity: 'former-identity',
      invocationId: 'invocation-1',
    })}\n`,
  );
  await writeFile(
    suppliedFile,
    `${JSON.stringify({ invocationId: 'invocation-1', rejections: [] })}\n`,
  );

  const pending = await pendingOf(areaRoot, scope);
  expect(pending.entries).toHaveLength(1);
  expect(pending.entries[0]).toMatchObject({
    invocationId: null,
    reason: 'The second rule was violated.',
    output: 'unresolved bytes',
    evidence: {
      path: path.join(reportFeedbackRoot(areaRoot), 'history', '000000002-unresolved.json'),
    },
  });
  // The foreign responsibility keeps its own converted context.
  expect((await pendingOf(areaRoot, other)).entries[0]?.reason).toBe(
    'A foreign rule was violated.',
  );
  // The resolved diagnostic is not reopened and stays readable history with the ledger bytes.
  const history = await readValidationErrorHistory(areaRoot);
  expect(history.map((entry) => entry.record.reason).sort()).toEqual([
    'A foreign rule was violated.',
    'The first rule was violated.',
    'The second rule was violated.',
  ]);
  const converted = await readFile(
    path.join(reportFeedbackRoot(areaRoot), 'history', '000000001-resolved.json'),
    'utf8',
  );
  expect(converted).toBe(`${JSON.stringify(rejection, null, 2)}\n`);
  // The former active ledger and supplied-feedback state moved out of the active location, so a
  // later clear cannot reimport them.
  for (const file of [resolvedFile, unresolvedFile, foreignFile, correctionFile, suppliedFile]) {
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  // A retried conversion over the converted area changes nothing.
  await clearPendingValidationError({ areaRoot, scope });
  await expect(
    readPendingValidationError({ areaRoot, scope: { ...scope, workId: 'NEX-7' } }),
  ).resolves.toBeNull();
  await expect(readValidationErrorHistory(areaRoot)).resolves.toHaveLength(3);
});

it('treats an unusable former ledger record as an explicit error, never an empty context', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  await mkdir(reportFeedbackRoot(areaRoot), { recursive: true });
  await writeFile(path.join(reportFeedbackRoot(areaRoot), 'broken.json'), '{"kind":"rejection"}');
  await expect(readPendingValidationError({ areaRoot, scope })).rejects.toThrow(
    'does not match its declared content type',
  );
  await writeFile(path.join(reportFeedbackRoot(areaRoot), 'broken.json'), 'not json');
  await expect(readPendingValidationError({ areaRoot, scope })).rejects.toThrow(
    'is not valid JSON',
  );
});

it('resumes KAN-76-style retained work with the pending context supplied to the author', async () => {
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

  // The former ledger retained the malformed record's bytes, the violated rule and the
  // attribution as an unattributed rejection of the author's report before this upgrade.
  await mkdir(reportFeedbackRoot(root), { recursive: true });
  await writeFile(
    path.join(reportFeedbackRoot(root), '000000001-kan76.json'),
    `${JSON.stringify(
      {
        kind: 'rejection',
        scope,
        invocationId: null,
        operation: 'stage-author',
        profile: null,
        context:
          'Recovered KAN-76 retained requirements round 2, reconciled before the next round.',
        source: { path: malformedFile },
        output: malformedBytes,
        reason:
          `Record at "${malformedFile}" does not match its declared content type: ` +
          'stage: Invalid input; revision: Invalid input.',
        report: null,
        assignedReport: null,
      },
      null,
      2,
    )}\n`,
  );
  // The explicit repair returns the producer-owned metadata; the diagnostic stays actionable.
  await writeFile(
    malformedFile,
    JSON.stringify({ stage, revision: 2, ...capturedMalformedAuthor }),
  );
  await expect(pendingOf(root, scope)).resolves.toBeDefined();

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

  // The producer-validated saved replacement clears the pending context; the history stays.
  expect(
    JSON.parse(await readFile(path.join(root, 'artifacts', '3', 'author.json'), 'utf8')),
  ).toMatchObject({
    stage,
    revision: 3,
    outcome: 'skip-proposed',
  });
  await expect(readPendingValidationError({ areaRoot: root, scope })).resolves.toBeNull();
  await expect(readValidationErrorHistory(root)).resolves.toHaveLength(1);

  // A later rejection is its own pending context while the earlier history stays readable.
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
  const pending = await pendingOf(root, scope);
  expect(pending.entries).toHaveLength(1);
  expect(pending.entries[0]?.reason).toContain('returned unusable output');
  expect(pending.entries[0]?.output).toBe('{"outcome":"skip-proposed"');
  await expect(readValidationErrorHistory(root)).resolves.toHaveLength(2);
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
  const pending = await pendingOf(root, scope);
  expect(pending.scope).toEqual(scope);
  expect(pending.entries[0]).toMatchObject({
    operation: 'stage-evaluator',
    source: { path: evaluationFile },
    output: '{"assessedRevision":2,"verdict":"accepted"}',
  });

  // The evaluator's next invocation fails on the same evidence. Neither consumer invocation
  // produced this unattributed historical record; the latest diagnosis is the pending context.
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
  const retained = await pendingOf(root, scope);
  expect(retained.entries).toHaveLength(1);
  expect(retained.entries[0]?.invocationId).toBeNull();
  await expect(readValidationErrorHistory(root)).resolves.toHaveLength(2);
});

it('keeps a rejection actionable when another responsibility’s correction references it', async () => {
  const areaRoot = await temporaryDirectory();
  const developer = scopeIn(areaRoot);
  const reviewer = scopeIn(areaRoot, { role: 'reviewer', reportKind: 'review' });
  const rejectionFile = path.join(reportFeedbackRoot(areaRoot), '000000001-rejection.json');
  await mkdir(reportFeedbackRoot(areaRoot), { recursive: true });
  await writeFile(
    rejectionFile,
    `${JSON.stringify({
      kind: 'rejection',
      scope: developer,
      invocationId: 'invocation-1',
      operation: 'Develop',
      profile: 'dev-a',
      context: 'Development round 1, task NEX-7.',
      source: null,
      output: 'rejected bytes',
      reason: 'The developer rule was violated.',
    })}\n`,
  );
  // The correction belongs to the reviewer's responsibility; a former correction resolved only
  // the rejections of its own scope, so the developer's diagnostic stays actionable.
  await writeFile(
    path.join(reportFeedbackRoot(areaRoot), '000000002-correction.json'),
    `${JSON.stringify({
      kind: 'correction',
      scope: reviewer,
      rejections: [{ path: rejectionFile }],
      artifact: { path: path.join(areaRoot, 'artifacts', '1', 'review.json') },
      artifactIdentity: 'former-identity',
      invocationId: 'invocation-2',
    })}\n`,
  );

  const pending = await pendingOf(areaRoot, developer);
  expect(pending.entries).toHaveLength(1);
  expect(pending.entries[0]).toMatchObject({
    output: 'rejected bytes',
    reason: 'The developer rule was violated.',
  });
  await expect(readPendingValidationError({ areaRoot, scope: reviewer })).resolves.toBeNull();
  expect((await readValidationErrorHistory(areaRoot)).map((entry) => entry.record.reason)).toEqual([
    'The developer rule was violated.',
  ]);
});

it('retires resolved rejections before their corrections so an interruption cannot reopen them', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  const correctionFile = path.join(reportFeedbackRoot(areaRoot), 'a-correction.json');
  const rejectionFile = path.join(reportFeedbackRoot(areaRoot), 'z-rejection.json');
  await mkdir(reportFeedbackRoot(areaRoot), { recursive: true });
  await writeFile(
    rejectionFile,
    `${JSON.stringify({
      kind: 'rejection',
      scope,
      invocationId: 'invocation-1',
      operation: 'Develop',
      profile: 'dev-a',
      context: 'Development round 1, task NEX-7.',
      source: null,
      output: 'resolved bytes',
      reason: 'The resolved rule was violated.',
    })}\n`,
  );
  await writeFile(
    correctionFile,
    `${JSON.stringify({
      kind: 'correction',
      scope,
      rejections: [{ path: rejectionFile }],
      artifact: { path: path.join(areaRoot, 'artifacts', '1', 'development.json') },
      artifactIdentity: 'former-identity',
      invocationId: 'invocation-1',
    })}\n`,
  );

  // The rejection's retirement is interrupted: its history target cannot be created while the
  // resolution evidence is still in the active location, so a retry still reads both records.
  await mkdir(path.join(reportFeedbackRoot(areaRoot), 'history', 'z-rejection.json'), {
    recursive: true,
  });
  await expect(readPendingValidationError({ areaRoot, scope })).rejects.toThrow(
    /could not be moved into readable history/,
  );
  await expect(stat(rejectionFile)).resolves.toBeDefined();
  await expect(stat(correctionFile)).resolves.toBeDefined();

  // With the interruption cleared, the retirement resolves the diagnostic instead of reopening
  // it: the rejection is retired first, while the correction that resolves it is still active.
  await rm(path.join(reportFeedbackRoot(areaRoot), 'history', 'z-rejection.json'), {
    recursive: true,
    force: true,
  });
  await expect(readPendingValidationError({ areaRoot, scope })).resolves.toBeNull();
  const history = await readValidationErrorHistory(areaRoot);
  expect(history).toHaveLength(1);
  expect(history[0]?.record.reason).toBe('The resolved rule was violated.');
  await expect(
    stat(path.join(reportFeedbackRoot(areaRoot), 'history', 'legacy', 'a-correction.json')),
  ).resolves.toBeDefined();
});

it('recovers a new error whose readable record write was interrupted after its pending context', async () => {
  const areaRoot = await temporaryDirectory();
  const scope = scopeIn(areaRoot);
  // The readable history area is obstructed: the pending context lands, its record cannot.
  await mkdir(reportFeedbackRoot(areaRoot), { recursive: true });
  await writeFile(path.join(reportFeedbackRoot(areaRoot), 'history'), 'not a directory');
  const failure = await rejectReport({
    areaRoot,
    scope,
    invocationId: 'invocation-1',
    operation: 'Develop',
    profile: 'dev-a',
    context: 'Development round 1, task NEX-7.',
    source: null,
    output: 'rejected bytes',
    reason: 'The rule was violated.',
  }).then(
    () => null,
    (error: Error) => error,
  );
  expect(failure?.message).toContain('The rule was violated.');
  expect(failure?.message).toContain('its pending context is retained');

  // The interrupted retention still reaches the next responsible invocation with the whole
  // diagnosis and the record path it promises.
  const pending = await pendingOf(areaRoot, scope);
  expect(pending.entries).toHaveLength(1);
  expect(pending.entries[0]).toMatchObject({
    output: 'rejected bytes',
    reason: 'The rule was violated.',
  });
  expect(path.dirname(pending.entries[0]!.evidence.path)).toBe(
    path.join(reportFeedbackRoot(areaRoot), 'history'),
  );

  // Once the obstruction clears, the owner-validated clear completes the readable record the
  // context promised instead of discarding it.
  await rm(path.join(reportFeedbackRoot(areaRoot), 'history'), { force: true });
  await clearPendingValidationError({ areaRoot, scope });
  const history = await readValidationErrorHistory(areaRoot);
  expect(history).toHaveLength(1);
  expect(history[0]?.path).toBe(pending.entries[0]!.evidence.path);
  expect(history[0]?.record).toMatchObject({
    output: 'rejected bytes',
    reason: 'The rule was violated.',
  });
});
