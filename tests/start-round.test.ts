/**
 * Component tests: the real StartRound plans rounds over real temporary storage and round history.
 * They cover the initial profile and reason, the repair triggers, executed-turn counting, promotion
 * at each second consecutive changes-requested review, the no-downgrade rule, planned-round reuse,
 * the exhausted outcome and the artifact root the round helpers resolve. No adapter or agent is
 * involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { devArtifact } from '../src/task-engine/actions/develop/artifacts.js';
import { reviewArtifact, type ReviewOutput } from '../src/task-engine/actions/review/artifacts.js';
import type { CurrentRound } from '../src/task-engine/actions/start-round/artifacts.js';
import {
  createStartRound,
  type DeveloperProfileAllowance,
} from '../src/task-engine/actions/start-round/index.js';
import { verificationArtifact } from '../src/task-engine/actions/verify/artifacts.js';
import type { EngineEvent } from '../src/task-engine/index.js';

const baseRevision = '1'.repeat(40);
const otherRevision = '9'.repeat(40);

/** The head revision one round produced: distinct rounds review distinct heads. */
function headOf(round: number): string {
  return String(round + 1).repeat(40);
}

let root = '';
let events: EngineEvent[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-start-round-'));
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The current round's directory as StartRound writes its artifacts into it. */
function roundHelpers(): ReturnType<typeof createArtifactHelpers> {
  return createArtifactHelpers({ root });
}

/** Read the current-round record as it is stored. */
async function readCurrentRound(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, 'state', 'current-round.json'), 'utf8'));
}

/** Write the current-round record by hand, for reuse and invalid-record cases. */
async function writeCurrentRound(record: unknown): Promise<void> {
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(
    path.join(root, 'state', 'current-round.json'),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

/** One round's development report, written as Develop writes it. */
async function writeDevelopment(
  round: number,
  profile: string,
  status: 'completed' | 'failed' = 'completed',
  revision = headOf(round),
): Promise<void> {
  await writeRoundArtifact(round, devArtifact.pathFromArtifactsRoot, {
    taskKey: 'NEX-1',
    profile,
    status,
    baseRevision,
    headRevision: revision,
    summary: status === 'completed' ? 'Implemented the task.' : 'Could not complete the task.',
    findingResponses: [],
  });
}

/** One round's verification result for one revision. */
async function writeVerification(
  round: number,
  status: 'passed' | 'failed',
  revision = headOf(round),
): Promise<void> {
  await writeRoundArtifact(round, verificationArtifact.pathFromArtifactsRoot, {
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
  });
}

/** One round's review result with the supplied verdict. */
async function writeReview(
  round: number,
  verdict: ReviewOutput['verdict'],
  revision = headOf(round),
): Promise<void> {
  await writeRoundArtifact(round, reviewArtifact.pathFromArtifactsRoot, {
    profile: 'reviewer',
    headRevision: revision,
    verdict,
    summary: `The reviewer decided "${verdict}".`,
    findings: [],
    priorFindings: [],
  });
}

/** Write one artifact document into a round, as that round's producer did. */
async function writeRoundArtifact(round: number, name: string, content: unknown): Promise<void> {
  const directory = path.join(root, 'artifacts', String(round));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

/** StartRound over the workspace and the supplied developer ladder. */
function startRoundOver(
  developerLadder: readonly DeveloperProfileAllowance[],
): ReturnType<typeof createStartRound> {
  return createStartRound({
    workspace: { root },
    developerLadder,
    publish: (event) => events.push(event),
  });
}

const ladder: readonly DeveloperProfileAllowance[] = [
  { profile: 'dev-a', repairAllowance: 1 },
  { profile: 'dev-b', repairAllowance: 2 },
];

const evenLadder: readonly DeveloperProfileAllowance[] = [
  { profile: 'dev-a', repairAllowance: 2 },
  { profile: 'dev-b', repairAllowance: 2 },
];

const smallLadder: readonly DeveloperProfileAllowance[] = [
  { profile: 'dev-a', repairAllowance: 1 },
  { profile: 'dev-b', repairAllowance: 1 },
];

describe('StartRound', () => {
  it('plans round 1 with the first configured profile and its reason', async () => {
    const startRound = startRoundOver(ladder);

    await expect(startRound()).resolves.toBe('started');

    expect(await readCurrentRound()).toEqual({
      number: 1,
      profile: 'dev-a',
      reason: expect.stringContaining('initial implementation uses the first profile "dev-a"'),
    });
    expect((await stat(path.join(root, 'artifacts', '1'))).isDirectory()).toBe(true);
    // A new round is ordinary progress, not a declared failure: nothing is published.
    expect(events).toEqual([]);
  });

  it('starts the round root the artifact helpers resolve', async () => {
    const startRound = startRoundOver(ladder);
    const helpers = roundHelpers();
    await startRound();

    await helpers.writeOutputArtifact(devArtifact, {
      taskKey: 'NEX-1',
      profile: 'dev-a',
      status: 'completed',
      baseRevision,
      headRevision: headOf(1),
      summary: 'First round.',
      findingResponses: [],
    });
    await expect(helpers.readInputArtifacts(devArtifact)).resolves.toMatchObject([
      { taskKey: 'NEX-1' },
    ]);

    await writeVerification(1, 'failed');
    await expect(startRound()).resolves.toBe('started');

    expect(await readCurrentRound()).toMatchObject({ number: 2, profile: 'dev-a' });
    await expect(helpers.readArtifactHistory(devArtifact)).resolves.toMatchObject([
      { number: 1, value: { taskKey: 'NEX-1' } },
    ]);
  });

  it('reuses an unrun planned round without advancing or evaluating the policy', async () => {
    await writeCurrentRound({
      number: 3,
      profile: 'dev-b',
      reason: 'The recorded plan is reused.',
    });

    // Another ladder would select differently; a planned round that never ran development reuses
    // its recorded number, profile and reason.
    const startRound = startRoundOver([{ profile: 'dev-c', repairAllowance: 5 }]);
    await expect(startRound()).resolves.toBe('started');

    expect(await readCurrentRound()).toEqual({
      number: 3,
      profile: 'dev-b',
      reason: 'The recorded plan is reused.',
    });
    expect((await stat(path.join(root, 'artifacts', '3'))).isDirectory()).toBe(true);
    await expect(stat(path.join(root, 'artifacts', '4'))).rejects.toThrow(/ENOENT/);

    // Repeating the action after the plan was saved but before development ran is still a reuse.
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toMatchObject({ number: 3, profile: 'dev-b' });
  });

  it('retains an existing next directory and its contents when it opens the round', async () => {
    await writeCurrentRound({ number: 2, profile: 'dev-a', reason: 'Planned.' });
    await writeDevelopment(2, 'dev-a');
    await writeVerification(2, 'failed');
    await mkdir(path.join(root, 'artifacts', '3'), { recursive: true });
    await writeFile(path.join(root, 'artifacts', '3', 'left-behind.txt'), 'kept\n', 'utf8');

    await expect(startRoundOver(ladder)()).resolves.toBe('started');

    expect(await readCurrentRound()).toMatchObject({ number: 3, profile: 'dev-b' });
    expect(await readFile(path.join(root, 'artifacts', '3', 'left-behind.txt'), 'utf8')).toBe(
      'kept\n',
    );
  });

  it('fails a later invocation without a same-revision repair trigger', async () => {
    const cases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
      [
        'a completed development result without a verification or review result',
        async () => {
          await writeDevelopment(1, 'dev-a');
        },
      ],
      [
        'a failed verification for another revision',
        async () => {
          await writeDevelopment(1, 'dev-a');
          await writeVerification(1, 'failed', otherRevision);
        },
      ],
      [
        'an inconclusive review',
        async () => {
          await writeDevelopment(1, 'dev-a');
          await writeVerification(1, 'passed');
          await writeReview(1, 'inconclusive');
        },
      ],
      [
        'an approved review',
        async () => {
          await writeDevelopment(1, 'dev-a');
          await writeVerification(1, 'passed');
          await writeReview(1, 'approved');
        },
      ],
    ];

    for (const [label, arrange] of cases) {
      await rm(root, { recursive: true, force: true });
      root = await mkdtemp(path.join(os.tmpdir(), 'nexus-start-round-'));
      events = [];
      await writeCurrentRound({ number: 1, profile: 'dev-a', reason: 'Planned.' });
      await arrange();
      const before = await readCurrentRound();

      await expect(startRoundOver(ladder)(), label).rejects.toThrow(/No repair trigger/);
      expect(await readCurrentRound(), label).toEqual(before);
      await expect(stat(path.join(root, 'artifacts', '2')), label).rejects.toThrow(/ENOENT/);
    }
  });

  it('rejects a present but invalid current-round record', async () => {
    const startRound = startRoundOver(ladder);
    const recordFile = path.join(root, 'state', 'current-round.json');
    await mkdir(path.dirname(recordFile), { recursive: true });
    await writeFile(recordFile, '{ not json', 'utf8');

    await expect(startRound()).rejects.toThrow(/is not valid JSON/);
    expect(await readFile(recordFile, 'utf8')).toBe('{ not json');

    await writeFile(
      recordFile,
      JSON.stringify({ number: 0, profile: 'dev-a', reason: 'x' }),
      'utf8',
    );
    await expect(startRound()).rejects.toThrow(/does not match its declared content type/);

    // A record without the selected profile and its reason is not a round plan.
    await writeFile(recordFile, JSON.stringify({ number: 1 }), 'utf8');
    await expect(startRound()).rejects.toThrow(/does not match its declared content type/);
    expect(JSON.parse(await readFile(recordFile, 'utf8'))).toEqual({ number: 1 });

    await rm(recordFile);
    await mkdir(recordFile);
    await expect(startRound()).rejects.toThrow(/could not be read/);
  });

  it('continues a profile while its allowance remains and advances when it is used up', async () => {
    const startRound = startRoundOver(smallLadder);
    await startRound();
    await writeDevelopment(1, 'dev-a');
    await writeVerification(1, 'failed');

    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 2,
      profile: 'dev-a',
      reason: expect.stringContaining('continues with the initial profile "dev-a"'),
    });

    // One executed repair turn used "dev-a"'s only allowance; the ladder advances to "dev-b".
    await writeDevelopment(2, 'dev-a');
    await writeVerification(2, 'failed');
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 3,
      profile: 'dev-b',
      reason: expect.stringContaining(
        'Profile "dev-a" has no repair allowance remaining; the repair advances to profile "dev-b"',
      ),
    });
  });

  it('promotes one ladder entry at each second consecutive changes-requested review', async () => {
    const startRound = startRoundOver(evenLadder);
    await startRound();

    // The first rejection consumes nothing from "dev-a" and does not promote: the streak is odd.
    await writeDevelopment(1, 'dev-a');
    await writeVerification(1, 'passed');
    await writeReview(1, 'changesRequested');
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toMatchObject({ number: 2, profile: 'dev-a' });

    // The second distinct consecutive rejection promotes although "dev-a" allows two turns.
    await writeDevelopment(2, 'dev-a');
    await writeVerification(2, 'passed');
    await writeReview(2, 'changesRequested');
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 3,
      profile: 'dev-b',
      reason: expect.stringContaining('changes-requested streak reached 2'),
    });
  });

  it('promotes again at the fourth consecutive rejection', async () => {
    const startRound = startRoundOver([
      { profile: 'dev-a', repairAllowance: 5 },
      { profile: 'dev-b', repairAllowance: 5 },
      { profile: 'dev-c', repairAllowance: 3 },
    ]);
    await startRound();

    // The first two rejections promote from "dev-a" to "dev-b" at the second one.
    for (const round of [1, 2]) {
      await writeDevelopment(round, 'dev-a');
      await writeVerification(round, 'passed');
      await writeReview(round, 'changesRequested');
      await startRound();
    }
    expect(await readCurrentRound()).toMatchObject({ number: 3, profile: 'dev-b' });

    // The third rejection leaves "dev-b" in place; the fourth promotes it to "dev-c".
    await writeDevelopment(3, 'dev-b');
    await writeVerification(3, 'passed');
    await writeReview(3, 'changesRequested');
    await startRound();
    expect(await readCurrentRound()).toMatchObject({ number: 4, profile: 'dev-b' });
    await writeDevelopment(4, 'dev-b');
    await writeVerification(4, 'passed');
    await writeReview(4, 'changesRequested');
    await startRound();
    expect(await readCurrentRound()).toEqual({
      number: 5,
      profile: 'dev-c',
      reason: expect.stringContaining('changes-requested streak reached 4'),
    });
  });

  it('never promotes on a failed development report or a failed check', async () => {
    // "dev-b" allows three turns, so the streak stays observable after the failures do not promote.
    const startRound = startRoundOver([
      { profile: 'dev-a', repairAllowance: 2 },
      { profile: 'dev-b', repairAllowance: 3 },
    ]);
    await startRound();
    await writeDevelopment(1, 'dev-a');
    await writeVerification(1, 'passed');
    await writeReview(1, 'changesRequested');
    await startRound();
    await writeDevelopment(2, 'dev-a');
    await writeVerification(2, 'passed');
    await writeReview(2, 'changesRequested');
    await startRound();
    expect(await readCurrentRound()).toMatchObject({ number: 3, profile: 'dev-b' });

    // The streak is two, but a failed check is not a rejection: "dev-b" continues.
    await writeDevelopment(3, 'dev-b');
    await writeVerification(3, 'failed');
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 4,
      profile: 'dev-b',
      reason: expect.stringContaining('continues with profile "dev-b"'),
    });

    // A failed development report behaves the same way.
    await writeDevelopment(4, 'dev-b', 'failed');
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 5,
      profile: 'dev-b',
      reason: expect.stringContaining('continues with profile "dev-b"'),
    });
  });

  it('never selects a weaker profile than one already used for a repair', async () => {
    const startRound = startRoundOver(evenLadder);
    await startRound();
    await writeDevelopment(1, 'dev-a');
    await writeVerification(1, 'passed');
    await writeReview(1, 'changesRequested');
    await startRound();
    await writeDevelopment(2, 'dev-a');
    await writeVerification(2, 'passed');
    await writeReview(2, 'changesRequested');

    // The promotion skips "dev-a"'s remaining allowance; the skipped allowance is not spent later.
    await startRound();
    await writeDevelopment(3, 'dev-b');
    await writeVerification(3, 'failed');
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 4,
      profile: 'dev-b',
      reason: expect.stringContaining('continues with profile "dev-b"'),
    });
  });

  it('counts each reviewed head once so a repeated review is not a new rejection', async () => {
    const startRound = startRoundOver(evenLadder);
    await startRound();
    await writeDevelopment(1, 'dev-a');
    await writeVerification(1, 'passed');
    await writeReview(1, 'changesRequested');
    await startRound();

    // Round 2 repaired nothing, so its review republishes the head already rejected in round 1:
    // the streak stays at one and does not promote.
    await writeDevelopment(2, 'dev-a', 'completed', headOf(1));
    await writeVerification(2, 'passed', headOf(1));
    await writeReview(2, 'changesRequested', headOf(1));
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 3,
      profile: 'dev-a',
      reason: expect.stringContaining('continues with profile "dev-a"'),
    });
  });

  it('resets the changes-requested streak on an approval', async () => {
    const startRound = startRoundOver([
      { profile: 'dev-a', repairAllowance: 3 },
      { profile: 'dev-b', repairAllowance: 2 },
    ]);
    await startRound();
    await writeDevelopment(1, 'dev-a');
    await writeVerification(1, 'passed');
    await writeReview(1, 'changesRequested');
    await startRound();

    // An approval resets the streak; the failed check is the repair trigger.
    await writeDevelopment(2, 'dev-a');
    await writeVerification(2, 'failed');
    await writeReview(2, 'approved');
    await startRound();
    expect(await readCurrentRound()).toMatchObject({ number: 3, profile: 'dev-a' });

    // The next rejection is the first of a new streak, so it does not promote.
    await writeDevelopment(3, 'dev-a');
    await writeVerification(3, 'passed');
    await writeReview(3, 'changesRequested');
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 4,
      profile: 'dev-a',
      reason: expect.stringContaining('continues with profile "dev-a"'),
    });
  });

  it('counts executed repair turns from development reports only', async () => {
    const startRound = startRoundOver(smallLadder);
    await startRound();
    await writeDevelopment(1, 'dev-a');
    await writeVerification(1, 'failed');
    await startRound();

    // Round 2 was planned and interrupted before development ran: it consumes no allowance.
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toMatchObject({ number: 2, profile: 'dev-a' });

    // The repair report of round 2 is the executed turn that uses "dev-a"'s allowance.
    await writeDevelopment(2, 'dev-a', 'failed');
    await expect(startRound()).resolves.toBe('started');
    expect(await readCurrentRound()).toEqual({
      number: 3,
      profile: 'dev-b',
      reason: expect.stringContaining('advances to profile "dev-b"'),
    });
  });

  it('exhausts the policy after the strongest allowance is used and publishes its reason', async () => {
    const startRound = startRoundOver(smallLadder);
    await startRound();
    await writeDevelopment(1, 'dev-a');
    await writeVerification(1, 'failed');
    await startRound();
    await writeDevelopment(2, 'dev-a');
    await writeVerification(2, 'failed');
    await startRound();
    expect(await readCurrentRound()).toMatchObject({ number: 3, profile: 'dev-b' });
    const before = await readCurrentRound();
    await writeDevelopment(3, 'dev-b');
    await writeVerification(3, 'failed');

    await expect(startRound()).resolves.toBe('exhausted');

    // No round is opened, the pointer is unchanged and the reason travels through the publisher.
    expect(await readCurrentRound()).toEqual(before);
    await expect(stat(path.join(root, 'artifacts', '4'))).rejects.toThrow(/ENOENT/);
    expect(events).toEqual([
      {
        source: 'start-round',
        type: 'exhausted',
        data: {
          reason: expect.stringMatching(
            /No profile at or above the current position.*after 2 executed repair turns.*"dev-a" allows 1, "dev-b" allows 1/,
          ),
        },
      },
    ]);
  });

  it('produces the same plan when the saved plan is evaluated again', async () => {
    const startRound = startRoundOver(ladder);
    await startRound();
    await writeDevelopment(1, 'dev-a');
    await writeVerification(1, 'failed');

    await expect(startRound()).resolves.toBe('started');
    const planned = (await readCurrentRound()) as CurrentRound;
    await expect(startRound()).resolves.toBe('started');

    // The repeated invocation reuses the unrun plan instead of selecting another profile.
    expect(await readCurrentRound()).toEqual(planned);
    expect(planned.profile).toBe('dev-a');
  });
});
