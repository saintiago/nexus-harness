/**
 * The pre-delivery diagnosis's one reviewer turn, as the real module runs it: a
 * local clone of the ticket's retained workspace pinned at the snapshot the red
 * baseline ran against, one stand-in runtime program over that snapshot, and the
 * record of what the turn produced.
 *
 * What the record is for is what these cases prove: a turn that wrote a valid
 * finding and *then* failed is recorded as a rejection, never published from the
 * finding file it left behind, and a restart reuses that recorded rejection
 * instead of paying for a second turn; a turn that wrote a finding and left no
 * recorded outcome is refused by name; and a completed turn's finding is
 * recorded once and reused unchanged. The runtime is a small Node program
 * installed as `codex` for the case, so a real process crosses the boundary and
 * no live provider, credential, or network service is involved
 * (docs/WORKFLOW.md §11).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BaselineFinding } from '../../src/sources/contract.js';
import {
  BASELINE_FINDING_FILE,
  BASELINE_OUTCOME_FILE,
  BASELINE_REVIEWER_LOG,
  BASELINE_TURN_DIRECTORY,
  createBaselineReviewer,
  readBaselineOutcome,
} from '../../src/reviews/baseline.js';
import type { BaselineReviewRequest } from '../../src/sources/contract.js';
import type { CheckRoundResult, CommandResult, SourceRef, Task } from '../../src/shared/types.js';
import {
  createRepository,
  gitOrFail,
  installStandIn,
  useIsolatedGitEnvironment,
} from './integration-support.js';

useIsolatedGitEnvironment();

const SITE = 'https://example.atlassian.net';
const REF: SourceRef = {
  type: 'jira',
  scope: SITE,
  id: '10011',
  key: 'HARN-11',
  url: `${SITE}/browse/HARN-11`,
  updatedAt: '2026-09-23T10:00:00.000Z',
};
const TASK: Task = {
  id: 'HARN-11',
  title: 'Add a greeting function',
  description: 'Implement the greeting the ticket describes.',
  acceptanceCriteria: ['The greeting is implemented.'],
};

/** The one actionable finding a stand-in turn writes down. */
const REPAIR_FINDING: BaselineFinding = {
  outcome: 'repair',
  failingCheck: '["node", "check.mjs"]',
  evidence: 'check.mjs exits 1 because result.txt is missing',
  likelyCause: 'the baseline commit never added the file the check reads',
  repairGuidance: 'add result.txt with the finished work before the check runs',
};

/**
 * The stand-in reviewer runtime: it records that it started, writes the finding
 * file the turn is asked for, consumes the prompt on standard input, and then
 * answers exactly one ending — a reported completion, or nothing at all, which
 * the adapter reads as a turn that exited without completing.
 */
function reviewerProgram(input: {
  readonly ledger: string;
  readonly ending: 'completed' | 'exited';
}): string {
  const lines = [
    `import { appendFileSync, writeFileSync } from 'node:fs';`,
    `appendFileSync(${JSON.stringify(input.ledger)}, 'turn\\n');`,
    `writeFileSync(${JSON.stringify(BASELINE_FINDING_FILE)}, ${JSON.stringify(
      JSON.stringify(REPAIR_FINDING),
    )});`,
    `let prompt = '';`,
    `process.stdin.setEncoding('utf8');`,
    `process.stdin.on('data', (chunk) => { prompt += chunk; });`,
    `process.stdin.on('end', () => {`,
    ...(input.ending === 'completed'
      ? [
          `  process.stdout.write(${JSON.stringify(
            JSON.stringify({
              type: 'item.completed',
              item: { type: 'agent_message', text: 'the diagnosis is written' },
            }),
          )} + '\\n');`,
          `  process.stdout.write(${JSON.stringify(
            JSON.stringify({ type: 'turn.completed' }),
          )} + '\\n');`,
        ]
      : []),
    `});`,
    ``,
  ];
  return lines.join('\n');
}

/** The launcher one stand-in really is on this host. */
function launcherPath(standIn: { readonly bin: string }): string {
  return path.join(standIn.bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
}

/** One completed red baseline, with the output its failing check wrote on disk. */
async function redBaseline(parent: string): Promise<CheckRoundResult> {
  const logs = path.join(parent, 'logs');
  await mkdir(logs, { recursive: true });
  const stdoutPath = path.join(logs, 'check.stdout.log');
  const stderrPath = path.join(logs, 'check.stderr.log');
  await writeFile(stdoutPath, 'cannot read result.txt\n', 'utf8');
  await writeFile(stderrPath, '', 'utf8');
  const result: CommandResult = {
    command: ['node', 'check.mjs'],
    cwd: path.join(parent, 'repo'),
    startedAt: '2026-09-23T10:00:00.000Z',
    endedAt: '2026-09-23T10:00:05.000Z',
    outcome: 'exited',
    exitCode: 1,
    signal: null,
    launchError: null,
    timeoutMs: 600_000,
    termination: null,
    terminationProblem: null,
    stdoutPath,
    stderrPath,
  };
  return { outcome: 'failed', setup: [], checks: [result], problem: null };
}

/** One case's fixture: a real repository, evidence directory and reviewer turn. */
async function reviewerFixture(parts: {
  readonly ending: 'completed' | 'exited';
  readonly withRuntime: boolean;
}) {
  const fixture = await createRepository();
  const dir = path.join(fixture.parent, 'baseline', 'evidence');
  const ledger = path.join(fixture.parent, 'turns.log');
  const baseline = await redBaseline(fixture.parent);
  const baseCommit = (
    await gitOrFail(['rev-parse', '--verify', 'HEAD^{commit}'], fixture.repo)
  ).trim();
  const standIn = parts.withRuntime
    ? await installStandIn('codex', reviewerProgram({ ledger, ending: parts.ending }))
    : null;
  const reviewer = createBaselineReviewer({
    selection: {
      runtime: 'codex',
      command: [standIn === null ? 'codex' : launcherPath(standIn)],
    },
    environment: process.env,
  });
  const request: BaselineReviewRequest = {
    dir,
    item: { ref: REF, task: TASK },
    workspace: { path: fixture.repo, baseCommit },
    baseline,
    stop: new AbortController().signal,
  };
  /** How many times the stand-in runtime really started, read from its ledger. */
  const turns = async (): Promise<number> => {
    const text = await readFile(ledger, 'utf8').catch(() => '');
    return text.split('\n').filter((line) => line.trim() !== '').length;
  };
  return { fixture, dir, request, reviewer, turns };
}

describe('what one baseline reviewer turn records', () => {
  it('records a rejection for a finding the failing turn wrote, and reuses it on a restart', async () => {
    const { dir, request, reviewer, turns } = await reviewerFixture({
      ending: 'exited',
      withRuntime: true,
    });

    const first = await reviewer(request);

    // The turn wrote a valid finding and then failed: only the turn's own
    // ending says which of the two happened, so nothing is published from the
    // file it left behind.
    expect(first.finding).toBeNull();
    expect(first.problem).toContain('did not complete');
    expect(existsSync(path.join(dir, BASELINE_TURN_DIRECTORY, BASELINE_FINDING_FILE))).toBe(true);
    expect(await readBaselineOutcome(dir)).toMatchObject({ state: 'rejected' });
    expect(await turns()).toBe(1);

    // The restart a failed publication runs: the same evidence, the recorded
    // rejection reused, and no second turn.
    const second = await reviewer(request);

    expect(second.finding).toBeNull();
    expect(second.problem).toContain('no second reviewer turn');
    expect(await turns()).toBe(1);
  });

  it('refuses a finding an interrupted turn left without a recorded outcome', async () => {
    const { dir, request, reviewer, turns } = await reviewerFixture({
      ending: 'completed',
      withRuntime: true,
    });
    // What an invocation killed between the turn's own write and the record of
    // its outcome leaves: the finding, and nothing saying the turn completed.
    await mkdir(path.join(dir, BASELINE_TURN_DIRECTORY), { recursive: true });
    await writeFile(
      path.join(dir, BASELINE_TURN_DIRECTORY, BASELINE_FINDING_FILE),
      JSON.stringify(REPAIR_FINDING),
      'utf8',
    );

    const outcome = await reviewer(request);

    expect(outcome.finding).toBeNull();
    expect(outcome.problem).toContain('left no recorded outcome');
    expect(outcome.problem).toContain('no second reviewer turn');
    expect(await readBaselineOutcome(dir)).toBeNull();
    // The runtime that would have answered the restart was never started.
    expect(await turns()).toBe(0);
    expect(existsSync(path.join(dir, BASELINE_REVIEWER_LOG))).toBe(false);
  });

  it('records a completed turn’s finding once and reuses it without a second turn', async () => {
    const { dir, request, reviewer, turns } = await reviewerFixture({
      ending: 'completed',
      withRuntime: true,
    });

    const first = await reviewer(request);

    expect(first.finding).toEqual(REPAIR_FINDING);
    expect(first.problem).toBeNull();
    expect(await readBaselineOutcome(dir)).toEqual({ state: 'finding', finding: REPAIR_FINDING });
    expect(await turns()).toBe(1);

    const second = await reviewer(request);

    // The recorded finding is reused unchanged, and no second runtime runs.
    expect(second.finding).toEqual(REPAIR_FINDING);
    expect(second.problem).toBeNull();
    expect(await turns()).toBe(1);
  });
});

describe('the evidence one diagnosis keeps', () => {
  it('refuses incomplete evidence before a turn, and carries a stop it never saw end', async () => {
    const { dir, request, reviewer, turns } = await reviewerFixture({
      ending: 'completed',
      withRuntime: true,
    });
    // What a previous invocation recorded for this evidence: a reviewer turn
    // whose own process tree was never seen to end. Its log files are gone now,
    // so this invocation refuses before it would re-read that record — and the
    // recorded stop still has to travel, because that runtime may still be
    // writing to the evidence directory.
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, BASELINE_OUTCOME_FILE),
      `${JSON.stringify({
        version: 1,
        state: 'rejected',
        problem: 'the reviewer turn was stopped before it produced a finding',
        shutdown: {
          termination: 'unconfirmed',
          problem: 'the host could not reach the process tree',
        },
      })}\n`,
      'utf8',
    );
    const gone = {
      ...request,
      baseline: {
        ...request.baseline,
        checks: request.baseline.checks.map((check) => ({
          ...check,
          stdoutPath: path.join(dir, 'gone.stdout.log'),
          stderrPath: path.join(dir, 'gone.stderr.log'),
        })),
      },
    };

    const outcome = await reviewer(gone);

    // The missing evidence is refused by name, no runtime is started for it,
    // and the recorded stop is carried out rather than rounded down.
    expect(outcome.finding).toBeNull();
    expect(outcome.problem).toContain('incomplete evidence');
    expect(outcome.problem).toContain('gone.stdout.log');
    expect(outcome.shutdown).toEqual({
      termination: 'unconfirmed',
      problem: 'the host could not reach the process tree',
    });
    expect(await turns()).toBe(0);
  });

  it('starts no runtime and records nothing for a turn the caller already stopped', async () => {
    const { dir, request, reviewer, turns } = await reviewerFixture({
      ending: 'completed',
      withRuntime: true,
    });
    const stopped = new AbortController();
    stopped.abort(new Error('the operator interrupted the intake'));

    const outcome = await reviewer({ ...request, stop: stopped.signal });

    expect(outcome.finding).toBeNull();
    expect(outcome.problem).not.toBeNull();
    // The stopped intake started no runtime and recorded no outcome: a later
    // invocation resumes the same evidence without a half-written record to
    // read past.
    expect(await turns()).toBe(0);
    expect(await readBaselineOutcome(dir)).toBeNull();
  });
});
