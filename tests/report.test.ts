/**
 * Final report and attempt evidence tests.
 *
 * Every report here is written to a real run directory and read back from disk,
 * so the assertions are about the file a run leaves behind rather than about an
 * in-memory object. The check evidence is produced by real setup/check rounds
 * running a harmless fixture program in a temporary directory, and the agent
 * logs are written through the same helper the runner uses: no network, no
 * credentials, and nothing outside those temporary directories is touched. See
 * docs/tasks.md T05 for the report and its evidence, and T07 for the bounded
 * failure output a repair turn is given.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheckRound } from '../src/checks.js';
import {
  ReportError,
  agentLogPath,
  appendRunLog,
  openAgentLog,
  readCommandOutput,
  runLogPath,
  runReportPath,
  summarizeChanges,
  writeRunReport,
} from '../src/report.js';
import type { RunReportRequest } from '../src/report.js';
import { WorkspaceError, allocateRunDirectory, prepareWorkspace } from '../src/workspace.js';
import type { PreparedWorkspace, RunDirectory, SourcePreflight } from '../src/workspace.js';
import type {
  AttemptEvidence,
  ChangedPath,
  CheckRoundResult,
  Command,
  CommandResult,
  RunReport,
  RunStatus,
} from '../src/types.js';
import { cleanupTempDirectories, createTempDir } from './support.js';

afterEach(cleanupTempDirectories);

/** The committed base a fixture run records. */
const BASE_COMMIT = '5f2b1c4e7a9d0b3f6c8e1a2d4b5c7e9f0a1b2c3d';

const RUN_STARTED_AT = '2026-01-01T00:00:00.000Z';
const RUN_ENDED_AT = '2026-01-01T00:05:00.000Z';

/**
 * The fixture program: one line per stream and the requested exit code, so a
 * check's output is identifiable in its log file and a red round is an ordinary
 * nonzero exit.
 */
const PROGRAM_SOURCE = [
  'const [, , id, exitCode] = process.argv;',
  'process.stdout.write(`stdout of ${id}\\n`);',
  'process.stderr.write(`stderr of ${id}\\n`);',
  'process.exit(Number(exitCode));',
  '',
].join('\n');

/** What a report request needs to know about the run it describes. */
interface RunContext {
  readonly run: RunDirectory;
  readonly source: SourcePreflight;
  /** The prepared working copy, or `null` when preparation failed. */
  readonly workspace: PreparedWorkspace | null;
}

interface RunFixture extends RunContext {
  /** Temporary directory holding everything. */
  readonly parent: string;
  /** The output directory run directories are allocated under. */
  readonly workDir: string;
  /** The fixture program a configured check runs. */
  readonly program: string;
}

/** A real run directory with a working copy, and the fixture program to check it with. */
async function createFixture(): Promise<RunFixture> {
  const parent = await createTempDir();
  const program = path.join(parent, 'program.mjs');
  await writeFile(program, PROGRAM_SOURCE, 'utf8');

  const run = await allocateRunDirectory(path.join(parent, 'runs'));
  await writeFile(path.join(run.workspacePath, 'app.txt'), 'committed baseline\n', 'utf8');
  const sourceRoot = path.join(parent, 'repo');

  return {
    parent,
    workDir: path.join(parent, 'runs'),
    run,
    program,
    source: { sourceRoot, baseCommit: BASE_COMMIT },
    workspace: {
      ...run,
      workspaceId: run.runId,
      continued: false,
      attempt: 1,
      sourceRoot,
      baseCommit: BASE_COMMIT,
      branch: `harness/${run.runId}`,
    },
  };
}

/** One configured check that runs the fixture program and exits with `exitCode`. */
function check(fixture: RunFixture, id: string, exitCode = 0): Command {
  return [process.execPath, fixture.program, id, String(exitCode)];
}

/** One real setup/check round in the fixture run's working copy. */
function runRound(
  fixture: RunFixture,
  name: string,
  checks: readonly Command[],
): Promise<CheckRoundResult> {
  return runCheckRound({
    setup: [],
    checks,
    cwd: fixture.run.workspacePath,
    logsDir: fixture.run.logsDir,
    name,
    // These tests are about what a report keeps, not about the run's budget:
    // the round is given a limit it will not reach.
    commandTimeoutMs: 10 * 60_000,
    deadlineMs: Date.now() + 60 * 60_000,
    now: () => new Date(),
  });
}

/**
 * One top-level coding turn. Its agent log is really written, so the report
 * points at a file that exists and holds what the turn produced.
 */
async function recordTurn(
  fixture: RunFixture,
  parts: {
    turn: number;
    /** What the agent said about its own turn. Agent text, not evidence. */
    summary: string | null;
    /** The turn's useful output, which stays in its own file. */
    output?: string;
    /** The round the harness observed after the turn; `null` when none ran. */
    checks: CheckRoundResult | null;
  },
): Promise<AttemptEvidence> {
  const log = await openAgentLog(fixture.run.logsDir, parts.turn);
  log.write(parts.output ?? `agent turn ${String(parts.turn)} worked here\n`);
  await log.close();
  return {
    turn: parts.turn,
    kind: parts.turn === 1 ? 'implementation' : 'repair',
    agentLog: log.path,
    agentSummary: parts.summary,
    checks: parts.checks,
  };
}

/** A report request with every field set, except those a test is about. */
function reportRequest(
  context: RunContext,
  parts: Partial<RunReportRequest> = {},
): RunReportRequest {
  return {
    run: context.run,
    task: { id: 'example-001', title: 'Add a greeting function' },
    // An ordinary run with no configured selection: the documented default.
    agent: { runtime: 'codex', command: ['codex'] },
    source: context.source,
    workspace: context.workspace,
    preparationProblem: null,
    startedAt: RUN_STARTED_AT,
    endedAt: RUN_ENDED_AT,
    status: 'failed',
    reason: 'the baseline checks did not pass, so no coding turn was started',
    baseline: null,
    attempts: [],
    timeout: null,
    // A run whose working copy matched the base: the shape most of these tests
    // are not about. The T10 cases below hand in the summary they are about.
    changes: summarizeChanges({ baseCommit: context.source.baseCommit, paths: [] }),
    ...parts,
  };
}

/** Parses a written report: the tests read what is on disk, not what was passed in. */
async function readReport(file: string): Promise<{ text: string; report: RunReport }> {
  const text = await readFile(file, 'utf8');
  return { text, report: JSON.parse(text) as RunReport };
}

function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

/** Runs `operation` expecting a {@link ReportError}, and returns it. */
async function expectReportError(operation: () => Promise<unknown>): Promise<ReportError> {
  const cause = await operation().then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(cause instanceof ReportError)) {
    throw new Error(`expected a ReportError, received ${String(cause)}`);
  }
  return cause;
}

/**
 * A recorded invocation whose two output files hold exactly what the test wrote,
 * for the cases a real command cannot produce conveniently — a long log, or a
 * stream that stayed empty.
 */
async function recordedCommand(
  fixture: RunFixture,
  parts: { readonly label: string; readonly stdout: string; readonly stderr: string },
): Promise<CommandResult> {
  const stdoutPath = path.join(fixture.run.logsDir, `${parts.label}.stdout.log`);
  const stderrPath = path.join(fixture.run.logsDir, `${parts.label}.stderr.log`);
  await writeFile(stdoutPath, parts.stdout, 'utf8');
  await writeFile(stderrPath, parts.stderr, 'utf8');
  return {
    command: ['a-command', 'that', 'failed'],
    cwd: fixture.run.workspacePath,
    startedAt: RUN_STARTED_AT,
    endedAt: RUN_ENDED_AT,
    outcome: 'exited',
    exitCode: 1,
    signal: null,
    launchError: null,
    timeoutMs: 10 * 60_000,
    termination: null,
    terminationProblem: null,
    stdoutPath,
    stderrPath,
  };
}

/** Every log file a round wrote, in configured order. */
function roundLogs(round: CheckRoundResult): string[] {
  return [...round.setup, ...round.checks].flatMap((result) => [
    result.stdoutPath,
    result.stderrPath,
  ]);
}

/** Every log file a report points at: the timeline, the turns, and the commands. */
function referencedLogs(report: RunReport): string[] {
  const attempts = report.attempts.flatMap((attempt) => [
    attempt.agentLog,
    ...(attempt.checks === null ? [] : roundLogs(attempt.checks)),
  ]);
  const baseline = report.baseline === null ? [] : roundLogs(report.baseline);
  return [report.runLog, ...attempts, ...baseline];
}

/** Every file below `directory`, by relative path, with its contents. */
async function readTree(directory: string, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await readTree(absolute, relative));
    } else {
      files[relative] = await readFile(absolute, 'utf8');
    }
  }
  return files;
}

describe('a final report', () => {
  it('records a passed run with its context, its evidence, and its reasons', async () => {
    const fixture = await createFixture();
    const baseline = await runRound(fixture, 'baseline', [check(fixture, 'baseline-1')]);
    const observed = await runRound(fixture, 'attempt-1', [
      check(fixture, 'check-1'),
      check(fixture, 'check-2'),
    ]);
    const implementation = await recordTurn(fixture, {
      turn: 1,
      summary: 'Implemented the greeting and its tests.',
      checks: observed,
    });
    await appendRunLog(runLogPath(fixture.run.logsDir), 'final status: passed');

    const file = await writeRunReport(
      reportRequest(fixture, {
        status: 'passed',
        reason: 'every configured check passed after the implementation turn',
        baseline,
        attempts: [implementation],
      }),
    );

    expect(file).toBe(runReportPath(fixture.run.runDir));
    const { text, report } = await readReport(file);
    // Readable: indented JSON, one field per line, ending in a newline.
    expect(text).toContain('\n  "runId"');
    expect(text.endsWith('\n')).toBe(true);

    expect(report.runId).toBe(fixture.run.runId);
    expect(report.task).toEqual({ id: 'example-001', title: 'Add a greeting function' });
    expect(report.agent).toEqual({ runtime: 'codex', command: ['codex'] });
    expect(report.source).toEqual({ path: fixture.source.sourceRoot, baseCommit: BASE_COMMIT });
    expect(report.workspace).toEqual({
      path: fixture.run.workspacePath,
      prepared: true,
      branch: `harness/${fixture.run.runId}`,
      workspaceId: fixture.run.runId,
      continued: false,
      attempt: 1,
      problem: null,
    });
    expect(report.startedAt).toBe(RUN_STARTED_AT);
    expect(report.endedAt).toBe(RUN_ENDED_AT);
    expect(report.status).toBe('passed');
    expect(report.reason).toMatch(/every configured check passed/);
    expect(report.repairsUsed).toBe(0);
    expect(report.runLog).toBe(runLogPath(fixture.run.logsDir));

    // A round per stage, each with one observed result per configured check.
    expect(report.baseline?.outcome).toBe('passed');
    expect(report.baseline?.checks).toHaveLength(1);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.turn).toBe(1);
    expect(report.attempts[0]?.kind).toBe('implementation');
    const evidence = report.attempts[0]?.checks ?? null;
    expect(evidence?.outcome).toBe('passed');
    expect(evidence?.checks.map((result) => result.command)).toEqual([
      check(fixture, 'check-1'),
      check(fixture, 'check-2'),
    ]);
    expect(evidence?.checks.map((result) => result.exitCode)).toEqual([0, 0]);
    expect(evidence?.checks.every((result) => result.outcome === 'exited')).toBe(true);
    expect(await readText(evidence?.checks[0]?.stdoutPath ?? '')).toBe('stdout of check-1\n');
  }, 60_000);

  it('keeps every attempt, its failures, and its own logs when the repairs run out', async () => {
    const fixture = await createFixture();
    const baseline = await runRound(fixture, 'baseline', [check(fixture, 'baseline-1')]);
    const red = await runRound(fixture, 'attempt-1', [
      check(fixture, 'check-1', 3),
      check(fixture, 'check-2'),
    ]);
    const stillRed = await runRound(fixture, 'attempt-2', [
      check(fixture, 'check-1', 4),
      check(fixture, 'check-2'),
    ]);
    const implementation = await recordTurn(fixture, {
      turn: 1,
      summary: 'Implemented the change.',
      checks: red,
    });
    const repair = await recordTurn(fixture, {
      turn: 2,
      summary: 'Adjusted the change.',
      checks: stillRed,
    });
    await appendRunLog(
      runLogPath(fixture.run.logsDir),
      'check-round 1 result: 1 of 2 checks passed',
    );
    await appendRunLog(runLogPath(fixture.run.logsDir), 'repair turn 1 started');
    await appendRunLog(runLogPath(fixture.run.logsDir), 'final status: failed');

    const file = await writeRunReport(
      reportRequest(fixture, {
        status: 'failed',
        reason: 'the repair allowance was exhausted while check 1 still failed',
        baseline,
        attempts: [implementation, repair],
      }),
    );

    const { report } = await readReport(file);
    expect(report.status).toBe('failed');
    expect(report.reason).toMatch(/repair allowance/);
    expect(report.attempts.map((attempt) => attempt.turn)).toEqual([1, 2]);
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['implementation', 'repair']);
    expect(report.repairsUsed).toBe(1);

    // The earlier failure is still there after later attempts: the first round's
    // exit code and the output it produced are not replaced by the last one.
    expect(report.attempts[0]?.checks?.checks.map((result) => result.exitCode)).toEqual([3, 0]);
    expect(report.attempts[1]?.checks?.checks.map((result) => result.exitCode)).toEqual([4, 0]);
    const firstStdout = report.attempts[0]?.checks?.checks[0]?.stdoutPath ?? '';
    expect(await readText(firstStdout)).toBe('stdout of check-1\n');
    expect(firstStdout).not.toBe(report.attempts[1]?.checks?.checks[0]?.stdoutPath);

    // Every stage wrote to its own files, all of which are still there.
    const logs = referencedLogs(report);
    expect(new Set(logs).size).toBe(logs.length);
    for (const log of logs) {
      expect(existsSync(log)).toBe(true);
    }
  }, 60_000);

  it('records a cancelled run without inventing a check round for it', async () => {
    const fixture = await createFixture();
    const baseline = await runRound(fixture, 'baseline', [check(fixture, 'baseline-1')]);
    const implementation = await recordTurn(fixture, {
      turn: 1,
      summary: 'Was still working when the run was stopped.',
      checks: null,
    });

    const file = await writeRunReport(
      reportRequest(fixture, {
        status: 'cancelled',
        reason: 'the user cancelled the run during the implementation turn',
        baseline,
        attempts: [implementation],
      }),
    );

    const { report } = await readReport(file);
    expect(report.status).toBe('cancelled');
    expect(report.reason).toMatch(/cancel/i);
    expect(report.repairsUsed).toBe(0);
    // The baseline is evidence that really exists; the interrupted turn has no
    // observed round, and the report says so instead of showing a green one.
    expect(report.baseline?.outcome).toBe('passed');
    expect(report.attempts[0]?.checks).toBeNull();
  }, 60_000);

  it('points at the timeline, the agent logs, and the command logs instead of embedding them', async () => {
    const fixture = await createFixture();
    const timeline = runLogPath(fixture.run.logsDir);
    await appendRunLog(timeline, 'baseline check-round started: 1 check');
    const baseline = await runRound(fixture, 'baseline', [check(fixture, 'baseline-1')]);
    await appendRunLog(timeline, 'baseline check-round result: 1 of 1 checks passed');
    const observed = await runRound(fixture, 'attempt-1', [check(fixture, 'check-1')]);
    const transcript = `${Array.from(
      { length: 200 },
      (_, index) => `transcript line ${String(index)}: the agent worked here`,
    ).join('\n')}\n`;
    const implementation = await recordTurn(fixture, {
      turn: 1,
      output: transcript,
      summary: 'Implemented the greeting.',
      checks: observed,
    });

    const file = await writeRunReport(
      reportRequest(fixture, {
        status: 'passed',
        reason: 'every configured check passed after the implementation turn',
        baseline,
        attempts: [implementation],
      }),
    );

    const { text, report } = await readReport(file);
    const logs = referencedLogs(report);
    expect(new Set(logs).size).toBe(logs.length);
    for (const log of logs) {
      expect(existsSync(log)).toBe(true);
    }

    // The output is in the files the report names, complete and unchanged...
    expect(await readText(report.runLog)).toContain('baseline check-round started: 1 check');
    expect(await readText(report.attempts[0]?.agentLog ?? '')).toBe(transcript);
    expect(await readText(observed.checks[0]?.stderrPath ?? '')).toBe('stderr of check-1\n');
    // ...and not in the report, which stays a report: the timeline's messages,
    // the agent's transcript, and the command output are all elsewhere.
    expect(text).not.toContain('baseline check-round started');
    expect(text).not.toContain('transcript line 0:');
    expect(text).not.toContain('stdout of check-1');
    expect(text).not.toContain('stderr of check-1');
    expect(text.length).toBeLessThan(transcript.length);
    // The short agent summary is kept for review, and it is the agent's own text.
    expect(report.attempts[0]?.agentSummary).toBe('Implemented the greeting.');
  }, 60_000);
});

describe('agent text and observed checks', () => {
  it('keeps a claim of success out of the check evidence', async () => {
    const fixture = await createFixture();
    const observed = await runRound(fixture, 'attempt-1', [check(fixture, 'check-1', 1)]);
    const claim = 'All checks passed. The tests are green and the task is done.';
    const implementation = await recordTurn(fixture, {
      turn: 1,
      summary: claim,
      checks: observed,
    });

    const file = await writeRunReport(
      reportRequest(fixture, {
        status: 'failed',
        reason: 'check 1 exited 1 after the implementation turn',
        attempts: [implementation],
      }),
    );

    const { text, report } = await readReport(file);
    // The observed round decides: a claim on its own leaves the run failed.
    expect(report.status).toBe('failed');
    expect(report.attempts[0]?.checks?.outcome).toBe('failed');
    expect(report.attempts[0]?.checks?.checks.map((result) => result.exitCode)).toEqual([1]);
    // The claim is kept as agent text, apart from the evidence, and it appears
    // in no check result and in no reason the harness wrote.
    expect(report.attempts[0]?.agentSummary).toBe(claim);
    expect(text).toContain(claim);
    expect(JSON.stringify(report.attempts[0]?.checks)).not.toContain(claim);
    expect(JSON.stringify(report.baseline)).not.toContain(claim);
    expect(report.reason).not.toContain(claim);
  }, 60_000);

  it('refuses to record a pass that the checks did not observe', async () => {
    const fixture = await createFixture();
    const observed = await runRound(fixture, 'attempt-1', [check(fixture, 'check-1', 2)]);
    const implementation = await recordTurn(fixture, {
      turn: 1,
      summary: 'Tests pass now.',
      checks: observed,
    });
    const file = runReportPath(fixture.run.runDir);

    // A red final round is not a pass...
    const red = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          status: 'passed',
          reason: 'the agent said the tests pass',
          attempts: [implementation],
        }),
      ),
    );
    expect(red.message).toMatch(/cannot say the run passed/);

    // ...and neither is no round at all.
    const missing = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          status: 'passed',
          reason: 'the agent said the tests pass',
          attempts: [{ ...implementation, checks: null }],
        }),
      ),
    );
    expect(missing.message).toMatch(/cannot say the run passed/);

    // No report was written, so there is no location to announce as one.
    expect(existsSync(file)).toBe(false);
  }, 60_000);
});

describe('the failure output a repair turn is given', () => {
  it('reads back what one invocation wrote, with the file each stream came from', async () => {
    const fixture = await createFixture();
    const round = await runRound(fixture, 'attempt-1', [check(fixture, 'check-1', 1)]);
    const failed = round.checks[0];
    if (failed === undefined) {
      throw new Error('the fixture round recorded no check result');
    }

    const output = await readCommandOutput(failed);

    expect(output).toContain(`stdout (${failed.stdoutPath}):`);
    expect(output).toContain('stdout of check-1');
    expect(output).toContain(`stderr (${failed.stderrPath}):`);
    expect(output).toContain('stderr of check-1');
    // Reading is not a copy of the evidence into the report: the files are still
    // exactly what the command wrote.
    expect(await readText(failed.stdoutPath)).toBe('stdout of check-1\n');
    expect(await readText(failed.stderrPath)).toBe('stderr of check-1\n');
  }, 60_000);

  it('bounds a long output to its end and says earlier output was left out', async () => {
    const fixture = await createFixture();
    const head = 'THE-BEGINNING-OF-A-LONG-LOG\n';
    const tail = 'THE-LAST-LINE\n';
    const result = await recordedCommand(fixture, {
      label: 'long',
      stdout: head + 'x'.repeat(50_000) + `\n${tail}`,
      stderr: '',
    });

    const output = await readCommandOutput(result);

    // The end is what a repair turn needs: a command reports the failure after
    // the work that led to it.
    expect(output).toContain(tail);
    expect(output).toContain('earlier output omitted');
    expect(output).not.toContain(head);
    // ...and it stays small: bounded, not the whole file.
    expect(output.length).toBeLessThan(10_000);
    // The output file itself is untouched by the reading.
    expect((await readText(result.stdoutPath)).length).toBeGreaterThan(50_000);
  }, 60_000);

  it('records a stream that wrote nothing as writing nothing', async () => {
    const fixture = await createFixture();
    const result = await recordedCommand(fixture, { label: 'silent', stdout: '', stderr: '' });

    const output = await readCommandOutput(result);

    expect(output).toContain(`stdout (${result.stdoutPath}):`);
    expect(output).toContain('(no output was written)');
  }, 60_000);
});

describe('the agent log of a coding turn', () => {
  it('gives every turn its own file and never overwrites an earlier one', async () => {
    const fixture = await createFixture();
    const implementation = await recordTurn(fixture, {
      turn: 1,
      output: 'implementation output\n',
      summary: 'Implemented the greeting.',
      checks: null,
    });
    const repair = await recordTurn(fixture, {
      turn: 2,
      output: 'repair output\n',
      summary: 'Adjusted the greeting.',
      checks: null,
    });

    expect(implementation.agentLog).toBe(agentLogPath(fixture.run.logsDir, 1));
    expect(repair.agentLog).toBe(agentLogPath(fixture.run.logsDir, 2));
    expect(path.basename(implementation.agentLog)).toBe('agent-implementation.log');
    expect(path.basename(repair.agentLog)).toBe('agent-repair-1.log');

    const file = await writeRunReport(
      reportRequest(fixture, {
        reason: 'the implementation turn ended before any check ran',
        attempts: [implementation, repair],
      }),
    );

    const { report } = await readReport(file);
    expect(report.attempts.map((attempt) => attempt.agentLog)).toEqual([
      implementation.agentLog,
      repair.agentLog,
    ]);
    expect(report.repairsUsed).toBe(1);
    // Both turns' output survived, each in its own file.
    expect(await readText(implementation.agentLog)).toBe('implementation output\n');
    expect(await readText(repair.agentLog)).toBe('repair output\n');

    // A turn cannot reuse an earlier turn's file: that is refused, and what is
    // already there is left alone.
    await expectReportError(() => openAgentLog(fixture.run.logsDir, 1));
    expect(await readText(implementation.agentLog)).toBe('implementation output\n');
  }, 60_000);

  it('refuses a turn number that could name something else', async () => {
    const fixture = await createFixture();
    const before = (await readdir(fixture.run.logsDir)).sort();

    for (const turn of [0, -1, 1.5, Number.NaN]) {
      await expectReportError(() => openAgentLog(fixture.run.logsDir, turn));
    }

    expect((await readdir(fixture.run.logsDir)).sort()).toEqual(before);
  });
});

describe('a run whose preparation failed', () => {
  /** A private Git environment: the developer's hooks, signing, and identity must not interfere. */
  let gitEnvironment: NodeJS.ProcessEnv | undefined;
  async function privateGitEnvironment(): Promise<NodeJS.ProcessEnv> {
    if (gitEnvironment === undefined) {
      const directory = await createTempDir();
      const emptyConfig = path.join(directory, 'empty.gitconfig');
      await writeFile(emptyConfig, '', 'utf8');
      gitEnvironment = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_AUTHOR_NAME: 'Harness Test',
        GIT_AUTHOR_EMAIL: 'harness@example.test',
        GIT_COMMITTER_NAME: 'Harness Test',
        GIT_COMMITTER_EMAIL: 'harness@example.test',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      };
    }
    return gitEnvironment;
  }

  /** Runs `git` with literal arguments and fails the test when it does not succeed. */
  async function gitOrFail(args: readonly string[], cwd: string): Promise<string> {
    const environment = await privateGitEnvironment();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('git', [...args], { cwd, env: environment, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      },
    );
    if (result.code !== 0) {
      throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  it('records the known facts without pretending a working copy was created', async () => {
    const parent = await createTempDir();
    const repo = path.join(parent, 'repo');
    await mkdir(repo);
    await gitOrFail(['init', '--quiet', '--initial-branch=main'], repo);
    await writeFile(path.join(repo, 'README.md'), 'baseline\n', 'utf8');
    await gitOrFail(['add', '--all'], repo);
    await gitOrFail(['commit', '--quiet', '--message', 'baseline'], repo);
    const baseCommit = (await gitOrFail(['rev-parse', 'HEAD'], repo)).trim();

    const run = await allocateRunDirectory(path.join(parent, 'runs'));
    // A file left in the working copy by an earlier attempt: preparation refuses
    // the destination, which is what a failed preparation leaves behind.
    const retained = path.join(run.workspacePath, 'partial.txt');
    await writeFile(retained, 'kept for inspection\n', 'utf8');

    const failure = await prepareWorkspace(
      run,
      { sourceRoot: repo, baseCommit },
      {
        deadlineMs: Date.now() + 10 * 60_000,
        now: () => new Date(),
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceError);
    const problem = (failure as WorkspaceError).message;

    const file = await writeRunReport(
      reportRequest(
        { run, source: { sourceRoot: repo, baseCommit }, workspace: null },
        {
          preparationProblem: problem,
          status: 'failed',
          reason: 'preparing the working copy failed before any check ran',
        },
      ),
    );

    const { text, report } = await readReport(file);
    expect(report.workspace.path).toBe(run.workspacePath);
    expect(report.workspace.prepared).toBe(false);
    expect(report.workspace.branch).toBeNull();
    expect(report.workspace.problem).toBe(problem);
    expect(report.status).toBe('failed');
    expect(report.reason).toMatch(/preparing the working copy failed/);
    expect(report.baseline).toBeNull();
    expect(report.attempts).toEqual([]);
    expect(report.repairsUsed).toBe(0);
    expect(report.source).toEqual({ path: repo, baseCommit });

    // Nothing in the report claims a clone: there is no branch, no run branch
    // name, and no working copy, and the retained directory is as it was left.
    expect(text).not.toContain('harness/');
    expect(existsSync(path.join(run.workspacePath, '.git'))).toBe(false);
    expect(await readdir(run.workspacePath)).toEqual(['partial.txt']);
    expect(await readText(retained)).toBe('kept for inspection\n');
  }, 60_000);

  it('refuses a request that has neither a working copy nor a reason for its absence', async () => {
    const fixture = await createFixture();

    const failure = await expectReportError(() =>
      writeRunReport(
        reportRequest(
          { run: fixture.run, source: fixture.source, workspace: null },
          { preparationProblem: null },
        ),
      ),
    );

    expect(failure.message).toMatch(/has to say why one is missing/);
    expect(existsSync(runReportPath(fixture.run.runDir))).toBe(false);
  });
});

describe('what writing a report leaves alone', () => {
  it("keeps the working copy and another run's artifacts as they are", async () => {
    const fixture = await createFixture();
    const other = await allocateRunDirectory(fixture.workDir);
    await writeFile(path.join(other.workspacePath, 'other.txt'), 'another run\n', 'utf8');
    await writeFile(path.join(other.runDir, 'result.json'), '{"runId":"an earlier run"}\n', 'utf8');

    const baseline = await runRound(fixture, 'baseline', [check(fixture, 'baseline-1', 2)]);
    const workspaceBefore = await readTree(fixture.run.workspacePath);
    const otherBefore = await readTree(other.runDir);

    const file = await writeRunReport(
      reportRequest(fixture, { baseline, attempts: [], reason: 'the baseline checks failed' }),
    );

    // The report is the only thing added, and nothing was removed or rewritten.
    expect(file).toBe(runReportPath(fixture.run.runDir));
    expect(await readTree(fixture.run.workspacePath)).toEqual(workspaceBefore);
    expect(await readTree(other.runDir)).toEqual(otherBefore);
    expect((await readdir(fixture.run.runDir)).sort()).toEqual(['logs', 'result.json']);
    expect(await readText(path.join(other.runDir, 'result.json'))).toBe(
      '{"runId":"an earlier run"}\n',
    );
  }, 60_000);
});

describe('a report that cannot be written', () => {
  it('surfaces the failure and announces no report location', async () => {
    const fixture = await createFixture();
    // A directory that cannot be written to because it is a file, not a
    // directory: the run directory itself is unusable.
    const blocked = path.join(fixture.parent, 'not-a-directory');
    await writeFile(blocked, 'a file, not a run directory\n', 'utf8');
    const run = { ...fixture.run, runDir: blocked };

    const failure = await expectReportError(() =>
      writeRunReport(
        reportRequest(
          { run, source: fixture.source, workspace: null },
          { preparationProblem: 'the working copy was never prepared' },
        ),
      ),
    );

    // The failure names the file the caller asked for, and nothing was created.
    expect(failure.message).toContain(path.join(blocked, 'result.json'));
    expect(existsSync(path.join(blocked, 'result.json'))).toBe(false);
    expect(await readText(blocked)).toBe('a file, not a run directory\n');
    // The real run directory is untouched: no half-written report was left in it.
    expect((await readdir(fixture.run.runDir)).sort()).toEqual(['logs']);
  }, 60_000);

  it('refuses to overwrite a report that is already there', async () => {
    const fixture = await createFixture();
    const file = runReportPath(fixture.run.runDir);
    await writeFile(file, '{"runId":"an earlier report"}\n', 'utf8');

    const failure = await expectReportError(() => writeRunReport(reportRequest(fixture)));

    expect(failure.message).toMatch(/already exists/);
    expect(await readText(file)).toBe('{"runId":"an earlier report"}\n');
  }, 60_000);

  it('refuses a request whose evidence does not describe a run', async () => {
    const fixture = await createFixture();
    const implementation = await recordTurn(fixture, {
      turn: 1,
      summary: 'Implemented the greeting.',
      checks: null,
    });

    // Statuses are the three the spec defines, and nothing else becomes a fourth
    // one: a value that did not come through the type is refused rather than
    // written into the report.
    const inventedStatus = JSON.parse('"ok"') as RunStatus;
    const invented = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          status: inventedStatus,
          reason: 'the agent said the task was done',
          attempts: [implementation],
        }),
      ),
    );
    expect(invented.message).toMatch(/is not a final run status/);

    // Reasons are readable sentences, and the turns are recorded in order.
    const silent = await expectReportError(() =>
      writeRunReport(reportRequest(fixture, { reason: '   ' })),
    );
    expect(silent.message).toMatch(/needs a reason/);

    const reordered = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          reason: 'the repair turn was recorded first',
          attempts: [{ ...implementation, turn: 2, kind: 'repair' }],
        }),
      ),
    );
    expect(reordered.message).toMatch(/coding turn 1 is not recorded as such/);

    const anonymous = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          reason: 'the implementation turn kept no agent log',
          attempts: [{ ...implementation, agentLog: '  ' }],
        }),
      ),
    );
    expect(anonymous.message).toMatch(/has no agent log/);

    expect(existsSync(runReportPath(fixture.run.runDir))).toBe(false);
  }, 60_000);
});

/** One changed path as an inspection reports it, for the cases below. */
function changedPath(
  file: string,
  kind: ChangedPath['kind'],
  states: ChangedPath['states'],
  categories: ChangedPath['categories'] = [],
): ChangedPath {
  return { path: file, kind, states, categories };
}

/** Why a run whose stop could not be confirmed has no final summary to show. */
const UNCONFIRMED_PROBLEM = 'the invocation was still running 5000 ms after it was stopped';

describe('what a report says about the changes a run left', () => {
  it('keeps the complete list, flags the paths that need review, and states its limits', async () => {
    const fixture = await createFixture();
    const observed = await runRound(fixture, 'attempt-1', [check(fixture, 'check-1')]);
    const implementation = await recordTurn(fixture, {
      turn: 1,
      summary: 'Implemented the greeting.',
      checks: observed,
    });
    const paths = [
      changedPath('README.md', 'modified', ['committed', 'unstaged']),
      changedPath('app.ts', 'modified', ['unstaged']),
      changedPath('package.json', 'modified', ['unstaged'], ['tooling']),
      changedPath('tests/app.test.ts', 'deleted', ['unstaged'], ['tests']),
      changedPath('untracked.txt', 'added', ['untracked']),
    ];

    const file = await writeRunReport(
      reportRequest(fixture, {
        status: 'passed',
        reason: 'every configured check passed after the implementation turn',
        attempts: [implementation],
        changes: summarizeChanges({ baseCommit: BASE_COMMIT, paths }),
      }),
    );

    const { report } = await readReport(file);
    // The complete list is in the report, flagged or not: a reviewer reads every
    // changed path, and the flags only say where to start.
    expect(report.changes.paths).toEqual(paths);
    expect(report.changes.baseCommit).toBe(BASE_COMMIT);
    expect(report.changes.inspected).toBe(true);
    expect(report.changes.problem).toBeNull();
    // The flagged subset is exactly the paths that touch tests, tooling, or
    // configuration — including a deleted test file.
    expect(report.changes.highlighted.map((entry) => entry.path)).toEqual([
      'package.json',
      'tests/app.test.ts',
    ]);

    // What `passed` means, and what it does not: the configured checks exiting
    // successfully, not the acceptance criteria and not a safe-to-ship verdict.
    expect(report.changes.warnings.checks).toContain(
      '`passed` means the configured post-agent checks exited successfully for the retained working copy',
    );
    expect(report.changes.warnings.checks).toMatch(
      /does not prove that every acceptance criterion is met/,
    );
    expect(report.changes.warnings.checks).toMatch(/does not mean the change is safe to ship/);
    // The flagged paths are pointed at, not judged, and nothing is claimed to be
    // tamper-proof.
    expect(report.changes.warnings.highlighted).toMatch(/tests, tooling, or configuration/);
    expect(report.changes.warnings.highlighted).toMatch(/does not enforce tamper-proof tests/);
  }, 60_000);

  it('tells a working copy that matched its base apart from one that could not be read', async () => {
    const fixture = await createFixture();
    const clean = summarizeChanges({ baseCommit: BASE_COMMIT, paths: [] });
    const unreadable = summarizeChanges({
      baseCommit: BASE_COMMIT,
      problem:
        'the working copy could not be compared with its recorded base: it is not a repository',
    });

    // A run that really left nothing behind: inspected, no paths, no reason.
    expect(clean.inspected).toBe(true);
    expect(clean.problem).toBeNull();
    expect(clean.paths).toEqual([]);
    // Nothing changed, so nothing needs review.
    expect(clean.warnings.highlighted).toBeNull();

    // A run whose summary could not be taken: the same empty list, and a reader
    // is told why rather than left to read it as a working copy that matched.
    expect(unreadable.inspected).toBe(false);
    expect(unreadable.problem).toMatch(/could not be compared/);
    expect(unreadable.paths).toEqual([]);
    expect(unreadable.warnings.highlighted).toBeNull();
    // What the run's status proves does not depend on the comparison.
    expect(unreadable.warnings.checks).toBe(clean.warnings.checks);

    const file = await writeRunReport(
      reportRequest(fixture, {
        status: 'failed',
        reason: 'the checks after the implementation turn could not be executed',
        changes: unreadable,
      }),
    );

    const { text, report } = await readReport(file);
    expect(report.changes).toEqual(unreadable);
    expect(text).toContain('could not be compared with its recorded base');
  }, 60_000);

  it('refuses a summary that would describe a comparison that did not happen', async () => {
    const fixture = await createFixture();
    const file = runReportPath(fixture.run.runDir);
    const paths = [changedPath('app.ts', 'modified', ['unstaged'])];
    const unreadable = summarizeChanges({
      baseCommit: BASE_COMMIT,
      problem: 'the comparison failed',
    });

    // A comparison that was not made cannot carry a list of what it found...
    const listed = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, { changes: { ...unreadable, paths, highlighted: paths } }),
      ),
    );
    expect(listed.message).toMatch(/cannot list changed paths/);

    // ...it cannot claim to have been made and explain why it was not...
    const bothWays = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          changes: { ...summarizeChanges({ baseCommit: BASE_COMMIT, paths }), problem: 'failed' },
        }),
      ),
    );
    expect(bothWays.message).toMatch(/nothing left to explain/);

    // ...and it has to say why, rather than leaving a reader to guess.
    const silent = await expectReportError(() =>
      writeRunReport(reportRequest(fixture, { changes: { ...unreadable, problem: null } })),
    );
    expect(silent.message).toMatch(/has to say why/);

    // Paths are differences from the run's recorded base, so a summary against
    // another commit describes another run.
    const elsewhere = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          changes: {
            ...summarizeChanges({ baseCommit: BASE_COMMIT, paths }),
            baseCommit: 'a'.repeat(40),
          },
        }),
      ),
    );
    expect(elsewhere.message).toMatch(/not against the base this run recorded/);

    expect(existsSync(file)).toBe(false);
  }, 60_000);

  it('refuses to summarize a working copy whose shutdown was not confirmed', async () => {
    const fixture = await createFixture();
    const paths = [changedPath('app.ts', 'modified', ['unstaged'])];

    // Something the harness could not stop may still be writing to the working
    // copy, so its contents are not a final record of anything.
    const timedOut = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          status: 'failed',
          reason: 'a configured command was stopped at its limit during the checks',
          timeout: {
            limit: 'command',
            phase: 'the checks after the implementation turn',
            limitMs: 600_000,
            elapsedMs: 1_000,
            termination: 'unconfirmed',
            problem: UNCONFIRMED_PROBLEM,
          },
          changes: summarizeChanges({ baseCommit: BASE_COMMIT, paths }),
        }),
      ),
    );
    expect(timedOut.message).toMatch(/cannot be summarized as final/);

    const stopped = {
      phase: 'the implementation turn',
      elapsedMs: 1_000,
      termination: 'unconfirmed' as const,
      problem: UNCONFIRMED_PROBLEM,
    };
    const cancelled = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          status: 'cancelled',
          reason: 'the user cancelled the run during the implementation turn',
          cancellation: stopped,
          changes: summarizeChanges({ baseCommit: BASE_COMMIT, paths: [] }),
        }),
      ),
    );
    expect(cancelled.message).toMatch(/cannot be summarized as final/);

    // The same run, saying why the summary is missing, is accepted — and the
    // report keeps the limitation rather than a list it cannot stand behind.
    const file = await writeRunReport(
      reportRequest(fixture, {
        status: 'cancelled',
        reason: 'the user cancelled the run during the implementation turn',
        cancellation: stopped,
        changes: summarizeChanges({
          baseCommit: BASE_COMMIT,
          problem: `the run ended without confirming that everything it had started had stopped (${UNCONFIRMED_PROBLEM}), so the working copy may still be written to`,
        }),
      }),
    );

    const { report } = await readReport(file);
    expect(report.status).toBe('cancelled');
    expect(report.cancellation).toEqual(stopped);
    expect(report.changes.inspected).toBe(false);
    expect(report.changes.problem).toContain('may still be written to');
    expect(report.changes.paths).toEqual([]);
  }, 60_000);

  it('records the selected launch prefix, and refuses a report that names nothing to launch', async () => {
    const fixture = await createFixture();
    const selection = ['codex', '--profile', 'deepseek', '--model', 'deepseek-flash'];

    const file = await writeRunReport(
      reportRequest(fixture, { agent: { runtime: 'codex', command: selection } }),
    );
    const { report } = await readReport(file);
    // What the harness launched, exactly as it was configured: a profile name is
    // not an observed model identity, and no report claims one.
    expect(report.agent).toEqual({ runtime: 'codex', command: selection });

    const unsupportedRuntime = await expectReportError(() =>
      writeRunReport(
        reportRequest(fixture, {
          agent: { runtime: 'claude' as unknown as 'codex', command: ['claude'] },
        }),
      ),
    );
    expect(unsupportedRuntime.message).toMatch(/not an implemented coding runtime/);

    for (const command of [[], ['  ', '--profile', 'deepseek']]) {
      const refused = await expectReportError(() =>
        writeRunReport(reportRequest(fixture, { agent: { runtime: 'codex', command } })),
      );
      expect(refused.message).toMatch(/needs an executable as its first item/);
    }
  }, 60_000);
});
