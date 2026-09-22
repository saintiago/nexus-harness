/**
 * The run loop's own decisions, exercised with in-memory collaborators: one
 * {@link runTask} composed of stand-in functions that record what they were
 * asked, a clock a test moves by hand, and no Git, process, or network call.
 *
 * Everything a case asserts on — which turn the loop asked for next, what that
 * turn was told, what the report would have recorded, and which limit ended the
 * run — is the loop's own decision. Real Git, real commands and the real report
 * files stay the boundary layer's (`docs/testing.md`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckRoundRequest } from '../src/checks/round.js';
import { agentLogPath } from '../src/reporting/logs.js';
import type { RunReportRequest } from '../src/reporting/report.js';
import type {
  AgentTurnRequest,
  AgentTurnResult,
  RunTaskRequest,
  RunnerDependencies,
} from '../src/runs/contracts.js';
import { runTask } from '../src/runs/runner.js';
import type {
  ChangedPath,
  CheckRoundResult,
  CommandOutcome,
  CommandResult,
  HarnessConfig,
  Task,
  TerminationOutcome,
} from '../src/shared/types.js';
import type { ContinuedWorkspace } from '../src/workspace/reopen.js';
import type { WorkspaceAttempt } from '../src/workspace/state.js';
import { createTempDir } from './support.js';

/** The moment every in-memory run starts at. */
export const CLOCK_START = new Date('2026-03-01T00:00:00.000Z');

/** A clock the test moves by hand, so a deadline is decided without waiting. */
export interface TestClock {
  readonly now: () => Date;
  advance(ms: number): void;
}

export function testClock(): TestClock {
  let offset = 0;
  return {
    now: () => new Date(CLOCK_START.getTime() + offset),
    advance: (ms): void => {
      offset += ms;
    },
  };
}

/** A configured limit, in the unit the configuration names it in. */
export function minutes(count: number): number {
  return count * 60_000;
}

/** The task every in-memory run is asked to complete. */
export const TASK: Task = {
  id: 'example-001',
  title: 'Add a greeting function',
  description: 'Implement the greeting the ticket describes.',
  acceptanceCriteria: ['The greeting is implemented.', 'The tests cover it.'],
};

/** One stand-in command's result, as a configured round reports it. */
export interface StandInCommand {
  readonly label: string;
  readonly outcome?: CommandOutcome;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly launchError?: string | null;
  readonly timeoutMs?: number;
  readonly termination?: TerminationOutcome | null;
  readonly terminationProblem?: string | null;
}

/**
 * One command's result with the output files it points at really written, so a
 * red round's failures are read back the way a repair turn is handed them.
 */
export async function standInCommand(
  where: { readonly cwd: string; readonly logsDir: string },
  parts: StandInCommand,
): Promise<CommandResult> {
  const stdoutPath = path.join(where.logsDir, `${parts.label}.stdout.log`);
  const stderrPath = path.join(where.logsDir, `${parts.label}.stderr.log`);
  await mkdir(where.logsDir, { recursive: true });
  await writeFile(stdoutPath, `${parts.label} wrote this\n`, 'utf8');
  await writeFile(stderrPath, '', 'utf8');
  const outcome = parts.outcome ?? 'exited';
  return {
    command: ['a-stand-in-command', parts.label],
    cwd: where.cwd,
    startedAt: CLOCK_START.toISOString(),
    endedAt: CLOCK_START.toISOString(),
    outcome,
    exitCode: parts.exitCode ?? (outcome === 'exited' ? 0 : null),
    signal: parts.signal ?? null,
    launchError: parts.launchError ?? null,
    timeoutMs: parts.timeoutMs ?? minutes(10),
    termination: parts.termination ?? null,
    terminationProblem: parts.terminationProblem ?? null,
    stdoutPath,
    stderrPath,
  };
}

/** A round that ran every configured check and passed. */
export function passedRound(): CheckRoundResult {
  return { outcome: 'passed', setup: [], checks: [], problem: null };
}

/** A completed red round: one check that exited nonzero, which is repair feedback. */
export function redRound(failed: CommandResult): CheckRoundResult {
  return { outcome: 'failed', setup: [], checks: [failed], problem: null };
}

/** A round that stopped early: an execution error, never a red round. */
export function executionErrorRound(
  stopped: CommandResult,
  parts: { readonly as: 'setup' | 'check'; readonly problem: string },
): CheckRoundResult {
  return {
    outcome: 'execution-error',
    setup: parts.as === 'setup' ? [stopped] : [],
    checks: parts.as === 'check' ? [stopped] : [],
    problem: parts.problem,
  };
}

/** What one in-memory run is composed of, and what it recorded. */
export interface MemoryRun {
  readonly workDir: string;
  readonly repoPath: string;
  readonly task: Task;
  readonly config: HarnessConfig;
  /** The request the loop is handed, with whatever the case added to it. */
  readonly request: RunTaskRequest;
  readonly clock: TestClock;
  readonly deps: RunnerDependencies;
  /** Every round the loop asked for, in the order it asked. */
  readonly rounds: { readonly requests: CheckRoundRequest[] };
  /** Every coding turn the loop asked for, in the order it asked. */
  readonly turns: { readonly requests: AgentTurnRequest[] };
  /** Every timeline line the loop appended. */
  readonly timeline: string[];
  /** Every report the loop would have written. */
  readonly reports: RunReportRequest[];
  /** Every workspace attempt the loop recorded. */
  readonly ledger: WorkspaceAttempt[];
  /** Every file the final workspace inspection was asked about. */
  readonly inspected: string[];
}

export interface MemoryRunParts {
  readonly rounds: (asked: CheckRoundRequest) => Promise<CheckRoundResult> | CheckRoundResult;
  readonly turns: (asked: AgentTurnRequest) => Promise<AgentTurnResult> | AgentTurnResult;
  readonly config?: Partial<HarnessConfig>;
  readonly clock?: TestClock;
  readonly continuedWorkspace?: ContinuedWorkspace;
  readonly sourceRef?: RunTaskRequest['sourceRef'];
  readonly history?: RunTaskRequest['history'];
  readonly guidance?: readonly string[];
  readonly tierName?: string;
  readonly stop?: AbortSignal;
  readonly prepareWorkspace?: RunnerDependencies['prepareWorkspace'];
  readonly inspectWorkspaceChanges?: RunnerDependencies['inspectWorkspaceChanges'];
  readonly writeRunReport?: RunnerDependencies['writeRunReport'];
}

/**
 * One run whose collaborators are all stand-ins: the working copy is a real
 * temporary directory (so a run directory can be allocated and a source task
 * snapshot written), and nothing in it is ever executed.
 */
export async function memoryRun(parts: MemoryRunParts): Promise<MemoryRun> {
  const workDir = await createTempDir();
  const repoPath = path.join(workDir, 'source');
  await mkdir(repoPath, { recursive: true });
  const clock = parts.clock ?? testClock();
  const config: HarnessConfig = {
    workDir,
    maxRepairs: 2,
    taskTimeoutMinutes: 60,
    commandTimeoutMinutes: 10,
    setup: [['a-stand-in-command', 'setup-1']],
    checks: [['a-stand-in-command', 'check-1']],
    agent: { runtime: 'codex', command: ['codex'] },
    ...parts.config,
  };
  const rounds: CheckRoundRequest[] = [];
  const turns: AgentTurnRequest[] = [];
  const timeline: string[] = [];
  const reports: RunReportRequest[] = [];
  const ledger: WorkspaceAttempt[] = [];
  const inspected: string[] = [];

  const deps: RunnerDependencies = {
    preflight: async () => ({ sourceRoot: repoPath, baseCommit: BASE_COMMIT }),
    allocateRunDirectory: async (where, placement) => {
      const runId = 'run-20260301000000-00000000';
      const workspaceId =
        placement !== undefined && placement.kind === 'reopen'
          ? placement.workspaceId
          : (placement?.preferredWorkspaceId ?? 'example-001');
      const runDir = path.join(where, 'runs', runId);
      const logsDir = path.join(runDir, 'logs');
      await mkdir(logsDir, { recursive: true });
      return {
        workDir: where,
        runId,
        runDir,
        workspaceId,
        workspacePath: path.join(where, 'workspaces', workspaceId),
        logsDir,
      };
    },
    prepareWorkspace: async (run, source) => {
      if (parts.prepareWorkspace !== undefined) {
        return await parts.prepareWorkspace(run, source, {
          deadlineMs: Number.POSITIVE_INFINITY,
          now: clock.now,
        });
      }
      await mkdir(run.workspacePath, { recursive: true });
      return {
        ...run,
        continued: false,
        attempt: 1,
        sourceRoot: source.sourceRoot,
        baseCommit: source.baseCommit,
        branch: `harness/${run.workspaceId}`,
      };
    },
    configureWorkspaceIdentity: async () => undefined,
    returnToRecordedBranch: async () => ({ changed: false }),
    runCheckRound: async (asked) => {
      rounds.push(asked);
      return await parts.rounds(asked);
    },
    runAgentTurn: async (asked) => {
      turns.push(asked);
      return await parts.turns(asked);
    },
    openAgentLog: async (logsDir, turn) => ({
      path: agentLogPath(logsDir, turn),
      write: () => undefined,
      close: async () => undefined,
    }),
    appendRunLog: async (_runLog, message) => {
      timeline.push(message);
    },
    writeRunReport:
      parts.writeRunReport ??
      (async (request) => {
        reports.push(request);
        return path.join(request.run.runDir, 'result.json');
      }),
    recordWorkspaceAttempt: async (_workDir, _workspaceId, attempt) => {
      ledger.push(attempt);
    },
    inspectWorkspaceChanges:
      parts.inspectWorkspaceChanges ??
      (async (workspace): Promise<readonly ChangedPath[]> => {
        inspected.push(workspace.workspacePath);
        return [];
      }),
    now: clock.now,
  };

  const request: RunTaskRequest = {
    task: TASK,
    config,
    repoPath,
    workDir,
    ...(parts.stop === undefined ? {} : { stop: parts.stop }),
    ...(parts.sourceRef === undefined ? {} : { sourceRef: parts.sourceRef }),
    ...(parts.continuedWorkspace === undefined
      ? {}
      : { continuedWorkspace: parts.continuedWorkspace }),
    ...(parts.guidance === undefined ? {} : { guidance: parts.guidance }),
    ...(parts.history === undefined ? {} : { history: parts.history }),
    ...(parts.tierName === undefined ? {} : { tierName: parts.tierName }),
  };

  return {
    workDir,
    repoPath,
    task: TASK,
    config,
    request,
    clock,
    deps,
    rounds: { requests: rounds },
    turns: { requests: turns },
    timeline,
    reports,
    ledger,
    inspected,
  };
}

/** The committed base every in-memory workspace records. */
export const BASE_COMMIT = 'a'.repeat(40);

/** Runs one in-memory run to its end. */
export function runMemoryTask(run: MemoryRun, request?: RunTaskRequest) {
  return runTask(request ?? run.request, run.deps);
}
