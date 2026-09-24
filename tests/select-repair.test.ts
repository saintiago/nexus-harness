/**
 * Component tests: the real SelectRepair applies the configured ladder to real round histories
 * over temporary storage. Failed checks and review-requested changes share the same counters, and
 * empty rounds or unexecuted selections consume no allowance. No adapter or agent is involved.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createArtifactHelpers,
  type ArtifactHelpers,
} from '../src/task-engine/actions/artifacts.js';
import {
  devArtifact,
  type DevelopmentOutput,
} from '../src/task-engine/actions/develop/artifacts.js';
import { reviewArtifact, type ReviewOutput } from '../src/task-engine/actions/review/artifacts.js';
import {
  repairArtifact,
  type RepairOutput,
} from '../src/task-engine/actions/select-repair/artifacts.js';
import {
  createSelectRepair,
  type DeveloperProfileAllowance,
} from '../src/task-engine/actions/select-repair/index.js';
import {
  verificationArtifact,
  type VerificationOutput,
} from '../src/task-engine/actions/verify/artifacts.js';

const baseRevision = '1'.repeat(40);
const headRevision = '2'.repeat(40);
const otherRevision = '3'.repeat(40);

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-select-repair-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Start the next round, starting at 1, and return helpers bound to the workspace. */
async function nextRound(): Promise<ArtifactHelpers> {
  let number = 1;
  try {
    const record = JSON.parse(
      await readFile(path.join(root, 'state', 'current-round.json'), 'utf8'),
    ) as { number: number };
    number = record.number + 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'artifacts', String(number)), { recursive: true });
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    `${JSON.stringify({ number }, null, 2)}\n`,
    'utf8',
  );
  return createArtifactHelpers({ root });
}

/** One development result for the current round. */
function development(
  profile: string,
  status: DevelopmentOutput['status'] = 'completed',
): DevelopmentOutput {
  return {
    taskKey: 'NEX-1',
    profile,
    status,
    baseRevision,
    headRevision,
    summary: status === 'completed' ? 'Implemented the task.' : 'Could not complete the task.',
    findingResponses: [],
  };
}

/** One verification result for the current revision. */
function verification(
  status: VerificationOutput['status'],
  revision = headRevision,
): VerificationOutput {
  return {
    headRevision: revision,
    status,
    checks: [
      {
        name: 'validate',
        exitCode: status === 'passed' ? 0 : 1,
        stdoutPath: 'checks/0/stdout.log',
        stderrPath: 'checks/0/stderr.log',
      },
    ],
  };
}

/** One review result requesting changes on the current revision. */
function reviewRequestingChanges(): ReviewOutput {
  return {
    profile: 'reviewer',
    headRevision,
    verdict: 'changesRequested',
    summary: 'The retry guard is missing.',
    findings: [
      {
        id: 'NEX-1-finding-1',
        title: 'Transient failures are not retried',
        severity: 'blocking',
        basis: 'The design requires a retry.',
        evidence: 'No second attempt appears.',
        impact: 'Transient failures leave work unfinished.',
        repairGuidance: 'Retry once.',
        locations: [],
      },
    ],
    priorFindings: [],
  };
}

/** Read the repair decision the action recorded for one round. */
async function readDecision(round: number): Promise<RepairOutput> {
  return JSON.parse(
    await readFile(path.join(root, 'artifacts', String(round), 'repair.json'), 'utf8'),
  ) as RepairOutput;
}

/** SelectRepair over the workspace and the supplied ladder. */
function repairOver(
  developerLadder: readonly DeveloperProfileAllowance[],
): ReturnType<typeof createSelectRepair> {
  return createSelectRepair({ workspace: { root }, developerLadder });
}

const ladder: readonly DeveloperProfileAllowance[] = [
  { profile: 'dev-a', repairAllowance: 1 },
  { profile: 'dev-b', repairAllowance: 2 },
];

const smallLadder: readonly DeveloperProfileAllowance[] = [
  { profile: 'dev-a', repairAllowance: 1 },
  { profile: 'dev-b', repairAllowance: 1 },
];

describe('SelectRepair', () => {
  it('selects the initial profile for the first failed check of the initial implementation', async () => {
    const helpers = await nextRound();
    await helpers.writeOutputArtifact(devArtifact, development('dev-a'));
    await helpers.writeOutputArtifact(verificationArtifact, verification('failed'));

    await expect(repairOver(ladder)()).resolves.toBe('selected');

    expect(await readDecision(1)).toEqual({
      decision: 'selected',
      profile: 'dev-a',
      repairsUsed: 0,
      reason: expect.stringContaining('continues with profile "dev-a"'),
    });
  });

  it('escalates to the next profile once the current allowance is used', async () => {
    const first = await nextRound();
    await first.writeOutputArtifact(devArtifact, development('dev-a'));
    await first.writeOutputArtifact(verificationArtifact, verification('failed'));
    await expect(repairOver(ladder)()).resolves.toBe('selected');

    const second = await nextRound();
    await second.writeOutputArtifact(devArtifact, development('dev-a'));
    await second.writeOutputArtifact(verificationArtifact, verification('failed'));

    await expect(repairOver(ladder)()).resolves.toBe('selected');

    // One repair turn ran in round 2; "dev-a" allows one.
    expect(await readDecision(2)).toEqual({
      decision: 'selected',
      profile: 'dev-b',
      repairsUsed: 1,
      reason: expect.stringContaining('escalates to profile "dev-b"'),
    });
  });

  it('escalates through the ladder and then exhausts the configured policy', async () => {
    const first = await nextRound();
    await first.writeOutputArtifact(devArtifact, development('dev-a'));
    await first.writeOutputArtifact(verificationArtifact, verification('failed'));

    const second = await nextRound();
    await second.writeOutputArtifact(devArtifact, development('dev-a'));
    await second.writeOutputArtifact(verificationArtifact, verification('failed'));

    const third = await nextRound();
    await third.writeOutputArtifact(devArtifact, development('dev-b'));
    await third.writeOutputArtifact(verificationArtifact, verification('failed'));

    await expect(repairOver(smallLadder)()).resolves.toBe('exhausted');

    // The initial implementation and two repair turns leave no profile with an allowance.
    expect(await readDecision(3)).toEqual({
      decision: 'exhausted',
      profile: null,
      repairsUsed: 2,
      reason: expect.stringMatching(
        /exhausted after 2 repairs.*"dev-a" allows 1.*"dev-b" allows 1/,
      ),
    });
  });

  it('uses one counter for failed checks and review-requested changes', async () => {
    // The first round's checks passed; the review requested changes.
    const first = await nextRound();
    await first.writeOutputArtifact(devArtifact, development('dev-a'));
    await first.writeOutputArtifact(verificationArtifact, verification('passed'));
    await first.writeOutputArtifact(reviewArtifact, reviewRequestingChanges());
    await expect(repairOver(smallLadder)()).resolves.toBe('selected');
    expect(await readDecision(1)).toMatchObject({ profile: 'dev-a', repairsUsed: 0 });

    // The repair round failed verification; the shared counter escalates instead of resetting.
    const second = await nextRound();
    await second.writeOutputArtifact(devArtifact, development('dev-a'));
    await second.writeOutputArtifact(verificationArtifact, verification('failed'));

    await expect(repairOver(smallLadder)()).resolves.toBe('selected');
    expect(await readDecision(2)).toMatchObject({ profile: 'dev-b', repairsUsed: 1 });
  });

  it('treats a failed development report as a repair trigger', async () => {
    const helpers = await nextRound();
    await helpers.writeOutputArtifact(devArtifact, development('dev-a', 'failed'));

    await expect(repairOver(ladder)()).resolves.toBe('selected');

    expect(await readDecision(1)).toMatchObject({ decision: 'selected', profile: 'dev-a' });
  });

  it('does not convert another revision, an inconclusive review or approval into a repair', async () => {
    const cases: ReadonlyArray<readonly [string, (helpers: ArtifactHelpers) => Promise<void>]> = [
      [
        'a verification result for another revision',
        async (helpers) => {
          await helpers.writeOutputArtifact(devArtifact, development('dev-a'));
          await helpers.writeOutputArtifact(
            verificationArtifact,
            verification('failed', otherRevision),
          );
        },
      ],
      [
        'an inconclusive review',
        async (helpers) => {
          await helpers.writeOutputArtifact(devArtifact, development('dev-a'));
          await helpers.writeOutputArtifact(verificationArtifact, verification('passed'));
          await helpers.writeOutputArtifact(reviewArtifact, {
            ...reviewRequestingChanges(),
            verdict: 'inconclusive',
            findings: [],
          });
        },
      ],
      [
        'an approved review',
        async (helpers) => {
          await helpers.writeOutputArtifact(devArtifact, development('dev-a'));
          await helpers.writeOutputArtifact(verificationArtifact, verification('passed'));
          await helpers.writeOutputArtifact(reviewArtifact, {
            ...reviewRequestingChanges(),
            verdict: 'approved',
            findings: [],
          });
        },
      ],
    ];

    for (const [label, arrange] of cases) {
      await rm(root, { recursive: true, force: true });
      root = await mkdtemp(path.join(os.tmpdir(), 'nexus-select-repair-'));
      const helpers = await nextRound();
      await arrange(helpers);

      await expect(repairOver(ladder)(), label).rejects.toThrow(/No repair trigger/);
    }
  });

  it('counts development reports only, ignoring empty rounds and unexecuted selections', async () => {
    const first = await nextRound();
    await first.writeOutputArtifact(devArtifact, development('dev-a'));
    await first.writeOutputArtifact(verificationArtifact, verification('failed'));

    // Round 2 selected a repair and was interrupted before any development report.
    const second = await nextRound();
    await second.writeOutputArtifact(repairArtifact, {
      decision: 'selected',
      profile: 'dev-a',
      repairsUsed: 0,
      reason: 'Selected.',
    });

    // The repair ran in round 3; only its report counts as an executed turn.
    const third = await nextRound();
    await third.writeOutputArtifact(devArtifact, development('dev-a'));
    await third.writeOutputArtifact(verificationArtifact, verification('failed'));

    await expect(repairOver(smallLadder)()).resolves.toBe('selected');

    expect(await readDecision(3)).toMatchObject({
      decision: 'selected',
      profile: 'dev-b',
      repairsUsed: 1,
    });
  });

  it('produces the same decision when unchanged reports are evaluated again', async () => {
    const helpers = await nextRound();
    await helpers.writeOutputArtifact(devArtifact, development('dev-a'));
    await helpers.writeOutputArtifact(verificationArtifact, verification('failed'));
    const repair = repairOver(ladder);

    await expect(repair()).resolves.toBe('selected');
    const first = await readDecision(1);
    await expect(repair()).resolves.toBe('selected');

    expect(await readDecision(1)).toEqual(first);
    expect(first.repairsUsed).toBe(0);
  });
});
