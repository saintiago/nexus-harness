/**
 * The final report of one run: one real file, written once, that records the run
 * that really happened.
 *
 * The report is the run's own evidence and the caller's artifact, so what is
 * proved here is its contract with the host: it is created exclusively, an
 * existing report is left exactly as it is, the agent's own words are kept
 * beside the checks rather than turned into them, a run cannot be reported as
 * passed without the completed green round that decided it, and a working copy
 * something may still be writing to is never summarized as final.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentLogPath, appendRunLog, runLogPath } from '../../src/reporting/logs.js';
import { ReportError } from '../../src/reporting/errors.js';
import { runReportPath, writeRunReport } from '../../src/reporting/report.js';
import type { RunReportRequest } from '../../src/reporting/report.js';
import type { AttemptEvidence, CheckRoundResult, CommandResult } from '../../src/shared/types.js';
import type { RunDirectory } from '../../src/workspace/run-directory.js';
import { allocateRunDirectory } from '../../src/workspace/run-directory.js';
import { createTempDir } from '../support.js';

/** One configured check that exited `0`, as a round records it. */
function passedCheck(command: readonly string[]): CommandResult {
  return {
    command: [...command],
    cwd: 'C:/runs/runs/run-1/workspaces/HARN-77',
    startedAt: '2026-09-22T10:00:00.000Z',
    endedAt: '2026-09-22T10:00:01.000Z',
    outcome: 'exited',
    exitCode: 0,
    signal: null,
    launchError: null,
    timeoutMs: 300_000,
    termination: null,
    terminationProblem: null,
    stdoutPath: 'C:/runs/runs/run-1/logs/attempt-1-check-1.stdout.log',
    stderrPath: 'C:/runs/runs/run-1/logs/attempt-1-check-1.stderr.log',
  };
}

/** A completed green round, as the checks after one coding turn recorded it. */
function passedRound(): CheckRoundResult {
  return {
    outcome: 'passed',
    setup: [],
    checks: [passedCheck(['node', 'check.mjs'])],
    problem: null,
  };
}

/** A completed red round: every check ran, and one of them did not succeed. */
function failedRound(): CheckRoundResult {
  const [ran] = passedRound().checks;
  return {
    outcome: 'failed',
    setup: [],
    checks: [{ ...(ran as CommandResult), exitCode: 1 }],
    problem: null,
  };
}

/** One run directory to write a report into, with its log directory really there. */
async function runDirectory(): Promise<RunDirectory> {
  const workDir = await createTempDir();
  const run = await allocateRunDirectory(workDir);
  await mkdir(run.logsDir, { recursive: true });
  return run;
}

/** One implementation attempt whose log really holds what the report points at. */
async function attempt(
  run: RunDirectory,
  overrides: {
    readonly summary?: string | null;
    readonly checks?: CheckRoundResult | null;
    /** A line the case wrote into the log to prove it is referenced, not copied. */
    readonly logged?: string;
  } = {},
): Promise<AttemptEvidence> {
  const agentLog = agentLogPath(run.logsDir, 1);
  await writeFile(
    agentLog,
    overrides.logged ?? '# the turn\nprogress: working in the copy\n',
    'utf8',
  );
  return {
    turn: 1,
    kind: 'implementation',
    agentLog,
    agentSummary:
      overrides.summary === undefined ? 'I implemented the greeting.' : overrides.summary,
    checks: overrides.checks === undefined ? passedRound() : overrides.checks,
  };
}

/** The report request a case starts from, and the run directory it names. */
async function reportRequest(
  overrides: Partial<RunReportRequest> = {},
  directory?: RunDirectory,
): Promise<{ readonly run: RunDirectory; readonly request: RunReportRequest }> {
  const run = directory ?? (await runDirectory());
  const baseCommit = 'a'.repeat(40);
  return {
    run,
    request: {
      run,
      task: { id: 'HARN-77', title: 'Finish the greeting' },
      agent: { runtime: 'codex', command: ['codex', '--profile', 'native'] },
      source: { sourceRoot: 'C:/repos/target', baseCommit },
      workspace: {
        ...run,
        continued: false,
        attempt: 1,
        sourceRoot: 'C:/repos/target',
        baseCommit,
        branch: 'harness/HARN-77',
      },
      preparationProblem: null,
      startedAt: '2026-09-22T10:00:00.000Z',
      endedAt: '2026-09-22T10:01:00.000Z',
      status: 'passed',
      reason: 'the configured checks passed after the implementation turn',
      baseline: null,
      attempts: [await attempt(run)],
      timeout: null,
      changes: {
        baseCommit,
        inspected: true,
        problem: null,
        paths: [{ path: 'greet.ts', kind: 'added', states: ['committed'], categories: [] }],
        highlighted: [],
        warnings: {
          checks:
            'a passed run means every configured post-agent check exited 0 for the retained ' +
            'working copy, and nothing more than that.',
          highlighted: null,
        },
      },
      ...overrides,
    },
  };
}

/** The report one write produced, read back as the JSON it is. */
async function writtenReport(request: RunReportRequest): Promise<Record<string, unknown>> {
  const file = await writeRunReport(request);
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

/** The error one report that was expected to be refused rejected with. */
async function failureOf(work: () => Promise<unknown>): Promise<ReportError> {
  try {
    await work();
  } catch (cause) {
    if (!(cause instanceof ReportError)) {
      throw new Error(`the report failed with something else: ${String(cause)}`, { cause });
    }
    return cause;
  }
  throw new Error('the report was expected to be refused, and it was not');
}

describe('the final report of one run', () => {
  it('records the run, and points at its evidence instead of copying it', async () => {
    const { run } = await reportRequest();
    const logged = 'progress: working in the retained copy';
    const { request } = await reportRequest(
      {
        attempts: [
          await attempt(run, { summary: 'I implemented the greeting.', logged: `${logged}\n` }),
        ],
      },
      run,
    );

    const report = await writtenReport(request);

    expect(report['runId']).toBe(run.runId);
    expect(report['task']).toEqual({ id: 'HARN-77', title: 'Finish the greeting' });
    expect(report['agent']).toEqual({
      runtime: 'codex',
      command: ['codex', '--profile', 'native'],
    });
    expect(report['source']).toEqual({ path: 'C:/repos/target', baseCommit: 'a'.repeat(40) });
    expect(report['status']).toBe('passed');
    expect(report['reason']).toBe('the configured checks passed after the implementation turn');
    expect(report['repairsUsed']).toBe(0);
    expect(report['runLog']).toBe(runLogPath(run.logsDir));
    const attempts = report['attempts'] as readonly AttemptEvidence[];
    expect(attempts[0]?.agentLog).toBe(agentLogPath(run.logsDir, 1));
    expect(attempts[0]?.agentSummary).toBe('I implemented the greeting.');
    // The log is referenced, never embedded: what the turn wrote stays in its
    // own file.
    expect(JSON.stringify(report)).not.toContain(logged);
  }, 45_000);

  it('refuses to record a pass the checks did not observe', async () => {
    const { run } = await reportRequest();
    const { request } = await reportRequest(
      { attempts: [await attempt(run, { checks: failedRound() })] },
      run,
    );

    const error = await failureOf(() => writeRunReport(request));

    expect(error.message).toContain('a report cannot say the run passed');
    expect(error.message).toContain('is not a check result');
  }, 45_000);

  it('keeps the agent’s own claim of success out of the check evidence', async () => {
    const { run } = await reportRequest();
    const { request } = await reportRequest(
      {
        status: 'failed',
        reason: 'the checks after the implementation turn did not pass',
        attempts: [
          await attempt(run, {
            summary: 'All checks passed; the work is complete.',
            checks: failedRound(),
          }),
        ],
      },
      run,
    );

    const report = await writtenReport(request);

    // The agent's words are kept as the turn's summary, and the round is what
    // the report records as the evidence: the run is failed because that is
    // what the harness observed.
    expect(report['status']).toBe('failed');
    const attempts = report['attempts'] as readonly AttemptEvidence[];
    expect(attempts[0]?.agentSummary).toBe('All checks passed; the work is complete.');
    expect(attempts[0]?.checks?.outcome).toBe('failed');
  }, 45_000);

  it('refuses to summarize a working copy something may still be writing to', async () => {
    const cancellation = {
      phase: 'the implementation turn',
      elapsedMs: 30_000,
      termination: 'unconfirmed' as const,
      problem: 'the process tree could not be confirmed stopped',
    };
    const { run } = await reportRequest();
    const { request } = await reportRequest(
      {
        status: 'cancelled',
        reason: 'the run was stopped by its caller',
        attempts: [],
        cancellation,
      },
      run,
    );

    const error = await failureOf(() => writeRunReport(request));

    expect(error.message).toContain('cannot be summarized as final');
    expect(error.message).toContain('may still be writing to it');

    // The same run, saying why the summary is unavailable, is recorded as it
    // really ended — with the limitation in it.
    const honest = {
      ...request,
      changes: {
        baseCommit: request.source.baseCommit,
        inspected: false,
        problem: 'the working copy could not be compared: its stop was not confirmed',
        paths: [],
        highlighted: [],
        warnings: {
          checks: 'the run was stopped before its checks could decide anything.',
          highlighted: null,
        },
      },
    };
    const report = await writtenReport(honest);

    expect(report['status']).toBe('cancelled');
    expect(report['cancellation']).toEqual(cancellation);
    expect((report['changes'] as { readonly inspected: boolean }).inspected).toBe(false);
  }, 45_000);

  it('writes one report, and leaves an existing one exactly as it was', async () => {
    const { request } = await reportRequest();
    const file = await writeRunReport(request);
    const first = await readFile(file, 'utf8');

    const error = await failureOf(() => writeRunReport(request));

    expect(file).toBe(runReportPath(request.run.runDir));
    expect(error.message).toContain('already exists');
    expect(error.message).toContain('left exactly as it is');
    expect(await readFile(file, 'utf8')).toBe(first);
  }, 45_000);

  it('refuses a request whose evidence does not describe one run', async () => {
    const { run } = await reportRequest();
    const outOfOrder = { ...(await attempt(run)), turn: 2, kind: 'repair' } as AttemptEvidence;
    const { request } = await reportRequest({ attempts: [outOfOrder] }, run);

    const error = await failureOf(() => writeRunReport(request));

    expect(error.message).toContain('attempts are recorded in order');

    const { request: missingReason } = await reportRequest({ reason: '   ' }, run);
    expect((await failureOf(() => writeRunReport(missingReason))).message).toContain(
      'a report needs a reason',
    );
    expect(path.isAbsolute(runReportPath(run.runDir))).toBe(true);
  }, 45_000);
});

describe('the run timeline beside the report', () => {
  it('appends one timestamped line per state change, and refuses anything else', async () => {
    const run = await runDirectory();
    const runLog = runLogPath(run.logsDir);

    await appendRunLog(runLog, 'prepared the working copy');
    await appendRunLog(runLog, 'the checks passed');

    const lines = (await readFile(runLog, 'utf8')).split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      // Each line is stamped, so a reader can order what happened without the
      // report embedding the events themselves.
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    }
    expect(lines[0]?.endsWith(' prepared the working copy')).toBe(true);
    expect(lines[1]?.endsWith(' the checks passed')).toBe(true);

    // One line per state change: a message with a line break, or a blank one, is
    // refused and nothing is appended for it.
    await expect(appendRunLog(runLog, 'two\nlines')).rejects.toThrow(
      /not a usable timeline message/,
    );
    await expect(appendRunLog(runLog, '   ')).rejects.toThrow(/not a usable timeline message/);
    expect((await readFile(runLog, 'utf8')).split('\n').filter((line) => line !== '')).toHaveLength(
      2,
    );
  }, 45_000);
});
