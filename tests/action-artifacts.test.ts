/**
 * Focused integration tests for the action artifact contract: producer declarations, the artifact
 * helpers and consumer reads over real temporary storage. No live service, agent or process is
 * involved; round state and artifact files are ordinary files written by the tests and helpers.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import {
  openingNarrativeParagraph,
  reportIdentityOf,
} from '../src/task-engine/actions/agent-reports.js';
import {
  devArtifact,
  developmentReportText,
  developmentResponseSchema,
  type DevelopmentOutput,
  type LegacyDevelopmentOutput,
} from '../src/task-engine/actions/develop/artifacts.js';
import {
  reviewArtifact,
  reviewResponseSchema,
  type ReviewOutput,
} from '../src/task-engine/actions/review/artifacts.js';
import {
  verificationArtifact,
  type VerificationOutput,
} from '../src/task-engine/actions/verify/artifacts.js';

const baseRevision = '1'.repeat(40);
const headRevision = '2'.repeat(40);

const developmentOutput: DevelopmentOutput = {
  taskKey: 'NEX-1',
  profile: 'developer',
  status: 'completed',
  baseRevision,
  headRevision,
  role: 'developer',
  report: { path: 'artifacts/1/reports/dev-1/developer.md' },
  reportIdentity: 'a'.repeat(64),
  invocationId: 'dev-1',
  readinessFailure: null,
};

/** One bound development outcome whose report association distinguishes its round's work. */
function developmentOutputOf(report: string): DevelopmentOutput {
  return { ...developmentOutput, report: { path: report } };
}

/** A retained combined development report from before the narrative/outcome separation. */
const legacyDevelopmentOutput: LegacyDevelopmentOutput = {
  taskKey: 'NEX-1',
  profile: 'developer',
  status: 'completed',
  baseRevision,
  headRevision,
  summary: 'Implemented the retry guard.',
  findingResponses: [
    { findingId: 'NEX-1-finding-1', status: 'addressed', response: 'Retried the call.' },
  ],
};

/** A retained combined review from before the narrative/outcome separation. */
const legacyReviewOutput = {
  profile: 'reviewer',
  headRevision,
  verdict: 'changesRequested',
  summary: 'The missing retry guard is a current problem.',
  findings: [
    {
      id: 'NEX-1-finding-1',
      title: 'Transient provider failures are not retried',
      severity: 'blocking',
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

const verificationOutput: VerificationOutput = {
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
};

/** One bound review outcome for the reviewed head. */
function reviewOutput(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    taskKey: 'NEX-1',
    profile: 'reviewer',
    headRevision,
    verdict: 'approved',
    role: 'reviewer',
    report: { path: 'artifacts/2/reports/rev-1/reviewer.md' },
    reportIdentity: 'b'.repeat(64),
    invocationId: 'rev-1',
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A temporary workspace, released after the test. */
async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifacts-'));
  temporaryDirectories.push(root);
  return root;
}

/** Select the current round and create its directory, as StartRound does. */
async function startRound(root: string, number: number): Promise<void> {
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'artifacts', String(number)), { recursive: true });
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    `${JSON.stringify({ number, profile: 'dev-a', reason: 'Planned.' }, null, 2)}\n`,
    'utf8',
  );
}

/** Write one artifact document by hand, for malformed and hand-crafted files. */
async function writeArtifactFile(
  root: string,
  number: number,
  name: string,
  text: string,
): Promise<void> {
  const directory = path.join(root, 'artifacts', String(number));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), text, 'utf8');
}

/** One artifact file's path within the workspace layout. */
function artifactPath(root: string, number: number, name: string): string {
  return path.join(root, 'artifacts', String(number), name);
}

describe('artifact helpers over a workspace', () => {
  it("writes a producer's artifact into the current round and reads it back", async () => {
    const root = await temporaryWorkspace();
    await startRound(root, 2);
    const helpers = createArtifactHelpers({ root });

    await helpers.writeOutputArtifact(devArtifact, developmentOutput);

    const stored = await readFile(artifactPath(root, 2, 'development.json'), 'utf8');
    expect(JSON.parse(stored)).toEqual(developmentOutput);
    await expect(helpers.readInputArtifacts(devArtifact)).resolves.toEqual([developmentOutput]);
  });

  it('reads several declared inputs in argument order', async () => {
    const root = await temporaryWorkspace();
    await startRound(root, 1);
    const helpers = createArtifactHelpers({ root });
    await helpers.writeOutputArtifact(devArtifact, developmentOutput);
    await helpers.writeOutputArtifact(verificationArtifact, verificationOutput);

    const [verification, development] = await helpers.readInputArtifacts(
      verificationArtifact,
      devArtifact,
    );

    expect(verification).toEqual(verificationOutput);
    expect(development).toEqual(developmentOutput);
  });

  it('resolves the current round on every call instead of caching it', async () => {
    const root = await temporaryWorkspace();
    const helpers = createArtifactHelpers({ root });

    await startRound(root, 1);
    const firstRound = developmentOutputOf('artifacts/1/reports/dev-1/developer.md');
    await helpers.writeOutputArtifact(devArtifact, firstRound);
    await startRound(root, 2);
    const secondRound = developmentOutputOf('artifacts/2/reports/dev-2/developer.md');
    await helpers.writeOutputArtifact(devArtifact, secondRound);

    await expect(helpers.readInputArtifacts(devArtifact)).resolves.toEqual([secondRound]);

    await startRound(root, 1);
    await expect(helpers.readInputArtifacts(devArtifact)).resolves.toEqual([firstRound]);
  });

  it('fails a current-round read instead of falling back to an earlier round', async () => {
    const root = await temporaryWorkspace();
    await startRound(root, 1);
    const helpers = createArtifactHelpers({ root });
    await helpers.writeOutputArtifact(devArtifact, developmentOutput);
    await startRound(root, 2);

    await expect(helpers.readInputArtifacts(devArtifact)).rejects.toThrow(
      `Required artifact at "${artifactPath(root, 2, 'development.json')}" does not exist.`,
    );
  });

  it('fails the operation when the current-round record is missing or invalid', async () => {
    const root = await temporaryWorkspace();
    const helpers = createArtifactHelpers({ root });

    await expect(helpers.readInputArtifacts(devArtifact)).rejects.toThrow(/does not exist/);

    await mkdir(path.join(root, 'state'), { recursive: true });
    await writeFile(path.join(root, 'state', 'current-round.json'), '{ not json', 'utf8');
    await expect(helpers.writeOutputArtifact(devArtifact, developmentOutput)).rejects.toThrow(
      /is not valid JSON/,
    );

    await writeFile(
      path.join(root, 'state', 'current-round.json'),
      JSON.stringify({ number: 0 }),
      'utf8',
    );
    await expect(helpers.readArtifactHistory(devArtifact)).rejects.toThrow(
      /is not a current-round record/,
    );
  });

  it('fails a read when the stored document does not match the declared content type', async () => {
    const root = await temporaryWorkspace();
    await startRound(root, 1);
    const helpers = createArtifactHelpers({ root });

    await writeArtifactFile(root, 1, 'development.json', '{ not json');
    await expect(helpers.readInputArtifacts(devArtifact)).rejects.toThrow(/is not valid JSON/);

    await writeArtifactFile(
      root,
      1,
      'development.json',
      JSON.stringify({ ...developmentOutput, status: 'done' }),
    );
    await expect(helpers.readInputArtifacts(devArtifact)).rejects.toThrow(
      /does not match its declared content type/,
    );
  });

  it('returns earlier rounds in order, skipping rounds that produced nothing', async () => {
    const root = await temporaryWorkspace();
    const helpers = createArtifactHelpers({ root });

    await startRound(root, 1);
    const firstRound = developmentOutputOf('artifacts/1/reports/dev-1/developer.md');
    await helpers.writeOutputArtifact(devArtifact, firstRound);
    await startRound(root, 2);
    const review = reviewOutput({ verdict: 'changesRequested' });
    await helpers.writeOutputArtifact(reviewArtifact, review);
    await startRound(root, 3);
    const thirdRound = developmentOutputOf('artifacts/3/reports/dev-3/developer.md');
    await helpers.writeOutputArtifact(devArtifact, thirdRound);
    await startRound(root, 4);

    await expect(helpers.readArtifactHistory(devArtifact)).resolves.toEqual([
      { number: 1, value: firstRound },
      { number: 3, value: thirdRound },
    ]);
    await expect(helpers.readArtifactHistory(reviewArtifact)).resolves.toEqual([
      { number: 2, value: review },
    ]);
  });

  it('leaves the current round and never-produced artifacts out of history', async () => {
    const root = await temporaryWorkspace();
    await startRound(root, 1);
    const helpers = createArtifactHelpers({ root });
    await helpers.writeOutputArtifact(devArtifact, developmentOutput);

    await expect(helpers.readArtifactHistory(devArtifact)).resolves.toEqual([]);
    await expect(helpers.readArtifactHistory(verificationArtifact)).resolves.toEqual([]);
  });

  it('reads an absent optional artifact as null and a present one as its content', async () => {
    const root = await temporaryWorkspace();
    await startRound(root, 1);
    const helpers = createArtifactHelpers({ root });

    await expect(
      helpers.readOptionalInputArtifacts(verificationArtifact, devArtifact),
    ).resolves.toEqual([null, null]);

    await helpers.writeOutputArtifact(devArtifact, developmentOutput);
    await expect(
      helpers.readOptionalInputArtifacts(verificationArtifact, devArtifact),
    ).resolves.toEqual([null, developmentOutput]);

    // The optional read resolves the current round on every call, like the required read.
    await startRound(root, 2);
    await expect(helpers.readOptionalInputArtifacts(devArtifact)).resolves.toEqual([null]);
  });

  it('fails an optional read when an existing artifact is unreadable', async () => {
    const root = await temporaryWorkspace();
    await startRound(root, 1);
    const helpers = createArtifactHelpers({ root });

    await writeArtifactFile(root, 1, 'verification.json', '{ not json');
    await expect(helpers.readOptionalInputArtifacts(verificationArtifact)).rejects.toThrow(
      /is not valid JSON/,
    );

    await writeArtifactFile(
      root,
      1,
      'verification.json',
      JSON.stringify({ headRevision, status: 'unknown', checks: [] }),
    );
    await expect(helpers.readOptionalInputArtifacts(verificationArtifact)).rejects.toThrow(
      /does not match its declared content type/,
    );
  });

  it('fails history when an earlier round holds an unreadable artifact', async () => {
    const root = await temporaryWorkspace();
    await startRound(root, 1);
    await writeArtifactFile(root, 1, 'development.json', JSON.stringify({ taskKey: 'NEX-1' }));
    await startRound(root, 2);
    const helpers = createArtifactHelpers({ root });

    await expect(helpers.readArtifactHistory(devArtifact)).rejects.toThrow(
      /does not match its declared content type/,
    );

    await writeArtifactFile(root, 1, 'development.json', '{ not json');
    await expect(helpers.readArtifactHistory(devArtifact)).rejects.toThrow(/is not valid JSON/);
  });
});

describe('retained report contracts', () => {
  it('keeps a current bound record and a retained combined record readable as recorded', async () => {
    const root = await temporaryWorkspace();
    const helpers = createArtifactHelpers({ root });
    await writeArtifactFile(root, 1, 'review.json', JSON.stringify(legacyReviewOutput, null, 2));
    await writeArtifactFile(
      root,
      1,
      'development.json',
      JSON.stringify(legacyDevelopmentOutput, null, 2),
    );
    await startRound(root, 2);
    const review = reviewOutput({ verdict: 'changesRequested' });
    await helpers.writeOutputArtifact(reviewArtifact, review);
    await startRound(root, 3);

    // The producer-owned readers accept the removed fields as historical data without running a
    // lifecycle rule; a current record keeps its binding exactly as saved.
    await expect(helpers.readArtifactHistory(reviewArtifact)).resolves.toEqual([
      { number: 1, value: legacyReviewOutput },
      { number: 2, value: review },
    ]);
    const [readDevelopment] = await helpers.readArtifactHistory(devArtifact);
    expect(readDevelopment?.value).toEqual(legacyDevelopmentOutput);
  });

  it('rejects a damaged binding instead of falling back to the legacy shape', async () => {
    const root = await temporaryWorkspace();
    const helpers = createArtifactHelpers({ root });
    // The record carries binding fields but omits the recorded identity. Both the current and the
    // legacy schema must reject it: a damaged new record never reads as a retained combined one.
    await writeArtifactFile(
      root,
      1,
      'review.json',
      JSON.stringify({
        profile: 'reviewer',
        headRevision,
        verdict: 'approved',
        role: 'reviewer',
        report: { path: 'artifacts/1/reports/rev-1/reviewer.md' },
        invocationId: 'rev-1',
      }),
    );
    await startRound(root, 2);
    await expect(helpers.readArtifactHistory(reviewArtifact)).rejects.toThrow(
      /does not match its declared content type/,
    );
  });

  it('derives minimal response contracts that reject narrative and finding fields', () => {
    expect(developmentResponseSchema.safeParse({ status: 'completed' }).success).toBe(true);
    expect(
      developmentResponseSchema.safeParse({ status: 'completed', summary: 'Fixed it.' }).success,
    ).toBe(false);
    expect(
      developmentResponseSchema.safeParse({ status: 'completed', findingResponses: [] }).success,
    ).toBe(false);
    expect(reviewResponseSchema.safeParse({ verdict: 'approved' }).success).toBe(true);
    expect(
      reviewResponseSchema.safeParse({
        verdict: 'changesRequested',
        summary: 'The guard is missing.',
      }).success,
    ).toBe(false);
    expect(
      reviewResponseSchema.safeParse({ verdict: 'changesRequested', findings: [] }).success,
    ).toBe(false);
  });

  it('reads a bound report by its recorded bytes and rejects a changed report', async () => {
    const root = await temporaryWorkspace();
    const reportFile = path.join(root, 'artifacts', '1', 'reports', 'dev-1', 'developer.md');
    await mkdir(path.dirname(reportFile), { recursive: true });
    const markdown = '# Implementation\n\nRetried the transient provider call once.\n';
    await writeFile(reportFile, markdown, 'utf8');
    const bound: DevelopmentOutput = {
      ...developmentOutput,
      report: { path: reportFile },
      reportIdentity: reportIdentityOf(Buffer.from(markdown, 'utf8')),
    };

    await expect(developmentReportText(bound)).resolves.toBe(markdown);
    await expect(developmentReportText(legacyDevelopmentOutput)).resolves.toBe(
      legacyDevelopmentOutput.summary,
    );

    await writeFile(reportFile, `${markdown}Edited after the fact.\n`, 'utf8');
    await expect(developmentReportText(bound)).rejects.toThrow(/does not match the identity/);
  });

  it('selects the opening narrative paragraph, not headings, code or list structure', () => {
    expect(openingNarrativeParagraph('# Review\n\nThe retry guard works.\n\n- detail\n')).toBe(
      'The retry guard works.',
    );
    expect(
      openingNarrativeParagraph(
        '```json\n{ "status": "completed",\n\n  "extra": true }\n```\n\nThen prose.\n',
      ),
    ).toBe('Then prose.');
    expect(openingNarrativeParagraph('```json\n{ "status": "completed" }\n```\n')).toBeNull();
    expect(openingNarrativeParagraph('# Only a heading\n')).toBeNull();
    expect(openingNarrativeParagraph('- only\n- a list\n')).toBeNull();
    expect(openingNarrativeParagraph('Title\n=====\n')).toBeNull();
    expect(openingNarrativeParagraph('    const result = true;\n')).toBeNull();
    expect(openingNarrativeParagraph('\tconst result = true;\n')).toBeNull();
    expect(openingNarrativeParagraph('    code\n\nThe explanation.')).toBe('The explanation.');
    expect(openingNarrativeParagraph('# Review\nThe retry guard works.')).toBe(
      'The retry guard works.',
    );
    expect(openingNarrativeParagraph('Title\n=====\nThe retry guard works.')).toBe(
      'The retry guard works.',
    );
    expect(openingNarrativeParagraph('First paragraph.\n## Heading\nSecond paragraph.')).toBe(
      'First paragraph.',
    );
    expect(openingNarrativeParagraph('   ')).toBeNull();
  });
});
