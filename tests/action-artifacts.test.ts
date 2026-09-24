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
  devArtifact,
  findingResponseSchema,
  type DevelopmentOutput,
  type FindingResponse,
} from '../src/task-engine/actions/develop/artifacts.js';
import {
  findingDispositionSchema,
  findingSchema,
  reviewArtifact,
  type Finding,
  type FindingDisposition,
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
  summary: 'Implemented the retry guard.',
  findingResponses: [],
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

const nonBlockingFinding: Finding = {
  id: 'NEX-1-finding-2',
  title: 'Retry log entry omits the attempt number',
  severity: 'non-blocking',
  basis: 'The design requires a log entry to identify the attempt.',
  evidence: 'The logged line names the operation only.',
  impact: 'Operators cannot match the log entries to attempts.',
  repairGuidance: 'Include the attempt number in the log entry.',
  locations: [],
};

/** One review result for the reviewed head. */
function reviewOutput(findings: Finding[], priorFindings: FindingDisposition[] = []): ReviewOutput {
  return {
    profile: 'reviewer',
    headRevision,
    verdict: findings.some((finding) => finding.severity === 'blocking')
      ? 'changesRequested'
      : 'approved',
    summary: 'Reviewed the delivered revision.',
    findings,
    priorFindings,
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
    `${JSON.stringify({ number }, null, 2)}\n`,
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
    await helpers.writeOutputArtifact(devArtifact, {
      ...developmentOutput,
      summary: 'First round implementation.',
    });
    await startRound(root, 2);
    await helpers.writeOutputArtifact(devArtifact, {
      ...developmentOutput,
      summary: 'Second round implementation.',
    });

    await expect(helpers.readInputArtifacts(devArtifact)).resolves.toEqual([
      { ...developmentOutput, summary: 'Second round implementation.' },
    ]);

    await startRound(root, 1);
    await expect(helpers.readInputArtifacts(devArtifact)).resolves.toEqual([
      { ...developmentOutput, summary: 'First round implementation.' },
    ]);
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
    await helpers.writeOutputArtifact(devArtifact, {
      ...developmentOutput,
      summary: 'First round implementation.',
    });
    await startRound(root, 2);
    const review = reviewOutput([blockingFinding]);
    await helpers.writeOutputArtifact(reviewArtifact, review);
    await startRound(root, 3);
    await helpers.writeOutputArtifact(devArtifact, {
      ...developmentOutput,
      summary: 'Third round implementation.',
    });
    await startRound(root, 4);

    await expect(helpers.readArtifactHistory(devArtifact)).resolves.toEqual([
      { number: 1, value: { ...developmentOutput, summary: 'First round implementation.' } },
      { number: 3, value: { ...developmentOutput, summary: 'Third round implementation.' } },
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

describe('findings contract', () => {
  it('carries review findings into development responses and back into the next review', async () => {
    const root = await temporaryWorkspace();
    const helpers = createArtifactHelpers({ root });
    const findings = [blockingFinding, nonBlockingFinding];

    await startRound(root, 1);
    await helpers.writeOutputArtifact(reviewArtifact, reviewOutput(findings));

    // The developer receives the actual review findings and answers every one of them.
    await startRound(root, 2);
    const [firstReview] = await helpers.readArtifactHistory(reviewArtifact);
    expect(firstReview).toEqual({ number: 1, value: reviewOutput(findings) });
    const findingResponses: FindingResponse[] = (firstReview?.value.findings ?? []).map(
      (finding) => ({
        findingId: finding.id,
        status: 'addressed',
        response: `Addressed "${finding.title}" in the retry path.`,
      }),
    );
    await helpers.writeOutputArtifact(devArtifact, { ...developmentOutput, findingResponses });

    // The next reviewer receives the same findings and the complete developer responses.
    await startRound(root, 3);
    const [development] = await helpers.readArtifactHistory(devArtifact);
    const [suppliedReview] = await helpers.readArtifactHistory(reviewArtifact);
    expect(suppliedReview?.value.findings).toEqual(findings);
    expect(development?.value.findingResponses.map((response) => response.findingId)).toEqual(
      findings.map((finding) => finding.id),
    );
    expect(
      development?.value.findingResponses.every((response) => response.response.length > 0),
    ).toBe(true);

    const priorFindings: FindingDisposition[] = findings.map((finding) => ({
      findingId: finding.id,
      disposition: 'resolved',
      reason: `Confirmed "${finding.title}" fixed in the current revision.`,
    }));
    const nextReview = reviewOutput([], priorFindings);
    await helpers.writeOutputArtifact(reviewArtifact, nextReview);
    await expect(helpers.readInputArtifacts(reviewArtifact)).resolves.toEqual([nextReview]);
  });

  it('rejects values outside the shared finding shapes', () => {
    expect(findingSchema.safeParse(blockingFinding).success).toBe(true);
    expect(findingSchema.safeParse({ ...blockingFinding, severity: 'critical' }).success).toBe(
      false,
    );
    expect(
      findingSchema.safeParse({
        id: 'NEX-1-finding-1',
        title: 'Missing basis',
        severity: 'blocking',
        evidence: 'Observed.',
        impact: 'Consequence.',
        repairGuidance: 'Fix it.',
        locations: [],
      }).success,
    ).toBe(false);
    expect(
      findingSchema.safeParse({
        ...blockingFinding,
        locations: [{ path: 'src/queue.ts', line: 0 }],
      }).success,
    ).toBe(false);

    expect(
      findingResponseSchema.safeParse({
        findingId: 'NEX-1-finding-1',
        status: 'fixed',
        response: 'Done.',
      }).success,
    ).toBe(false);
    expect(
      findingDispositionSchema.safeParse({
        findingId: 'NEX-1-finding-1',
        disposition: 'closed',
        reason: 'No longer present.',
      }).success,
    ).toBe(false);
    expect(
      findingDispositionSchema.safeParse({
        findingId: 'NEX-1-finding-1',
        disposition: 'open',
      }).success,
    ).toBe(false);
  });
});
