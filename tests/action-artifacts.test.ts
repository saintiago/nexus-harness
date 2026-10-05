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
  developmentResponseSchema,
  type DevelopmentOutput,
} from '../src/task-engine/actions/develop/artifacts.js';
import {
  findingSchema,
  reviewArtifact,
  reviewResponseSchema,
  type Finding,
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
  title: 'Transient provider failures are not retried',
  severity: 'blocking',
  basis: 'The design requires a transient provider failure to be retried once.',
  evidence: 'The failing call returns immediately and no second attempt appears in the log.',
  impact: 'A transient failure leaves the work unfinished.',
  repairGuidance: 'Retry the provider call once before reporting the failure.',
  locations: [{ path: 'src/queue.ts', line: 42 }],
};

const nonBlockingFinding: Finding = {
  title: 'Retry log entry omits the attempt number',
  severity: 'non-blocking',
  basis: 'The design requires a log entry to identify the attempt.',
  evidence: 'The logged line names the operation only.',
  impact: 'Operators cannot match the log entries to attempts.',
  repairGuidance: 'Include the attempt number in the log entry.',
  locations: [],
};

/** One review result for the reviewed head. */
function reviewOutput(findings: Finding[]): ReviewOutput {
  return {
    profile: 'reviewer',
    headRevision,
    verdict: findings.some((finding) => finding.severity === 'blocking')
      ? 'changesRequested'
      : 'approved',
    summary: 'Reviewed the delivered revision.',
    findings,
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
  it('carries review findings into the next review input without lifecycle records', async () => {
    const root = await temporaryWorkspace();
    const helpers = createArtifactHelpers({ root });
    const findings = [blockingFinding, nonBlockingFinding];

    await startRound(root, 1);
    await helpers.writeOutputArtifact(reviewArtifact, reviewOutput(findings));

    // The developer's report is a narrative bound to the observed revisions, and the next review
    // still receives the complete earlier report as readable evidence.
    await startRound(root, 2);
    const [firstReview] = await helpers.readArtifactHistory(reviewArtifact);
    expect(firstReview).toEqual({ number: 1, value: reviewOutput(findings) });
    await helpers.writeOutputArtifact(devArtifact, {
      ...developmentOutput,
      summary: 'Addressed the missing retry guard and the log entry.',
    });

    await startRound(root, 3);
    const [development] = await helpers.readArtifactHistory(devArtifact);
    const [suppliedReview] = await helpers.readArtifactHistory(reviewArtifact);
    expect(suppliedReview?.value.findings).toEqual(findings);
    expect(development?.value).not.toHaveProperty('findingResponses');

    // A recurrence is a current finding again; a resolved problem needs no lifecycle record.
    const nextReview = reviewOutput([blockingFinding]);
    await helpers.writeOutputArtifact(reviewArtifact, nextReview);
    await expect(helpers.readInputArtifacts(reviewArtifact)).resolves.toEqual([nextReview]);
  });

  it('reads retained former reports without lifecycle validation or a rewritten identity', async () => {
    const root = await temporaryWorkspace();
    const helpers = createArtifactHelpers({ root });
    const formerReview = {
      ...reviewOutput([blockingFinding]),
      findings: [{ ...blockingFinding, id: 'NEX-1-finding-1' }],
      priorFindings: [
        {
          findingId: 'NEX-1-finding-1',
          disposition: 'open',
          reason: 'The guard was still missing in the reviewed revision.',
        },
      ],
    };
    const formerDevelopment = {
      ...developmentOutput,
      findingResponses: [
        { findingId: 'NEX-1-finding-1', status: 'addressed', response: 'Retried the call.' },
      ],
    };
    await writeArtifactFile(root, 1, 'review.json', JSON.stringify(formerReview, null, 2));
    await writeArtifactFile(
      root,
      1,
      'development.json',
      JSON.stringify(formerDevelopment, null, 2),
    );
    await startRound(root, 2);

    // The producer-owned readers accept the removed fields as historical data: the review keeps
    // its former finding identity and dispositions exactly as recorded, and the development
    // report reads by its current fields without running a lifecycle rule.
    const [review] = await helpers.readArtifactHistory(reviewArtifact);
    expect(review?.value).toEqual(formerReview);
    const [development] = await helpers.readArtifactHistory(devArtifact);
    expect(development?.value).toEqual(developmentOutput);
    expect(development?.value).not.toHaveProperty('findingResponses');
  });

  it('rejects values outside the shared finding and response shapes', () => {
    expect(findingSchema.safeParse(blockingFinding).success).toBe(true);
    expect(findingSchema.safeParse({ ...blockingFinding, severity: 'critical' }).success).toBe(
      false,
    );
    expect(
      findingSchema.safeParse({
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
    // The current contracts have no stable finding ID, response array or disposition record.
    expect(findingSchema.safeParse({ ...blockingFinding, id: 'NEX-1-finding-1' }).success).toBe(
      false,
    );
    expect(
      reviewResponseSchema.safeParse({
        verdict: 'changesRequested',
        summary: 'The guard is missing.',
        findings: [blockingFinding],
        priorFindings: [],
      }).success,
    ).toBe(false);
    expect(
      developmentResponseSchema.safeParse({
        status: 'completed',
        summary: 'Fixed it.',
        findingResponses: [],
      }).success,
    ).toBe(false);
  });
});
