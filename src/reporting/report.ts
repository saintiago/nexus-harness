/**
 * The readable final report of one run: `<runDir>/result.json`, and the
 * normalized task snapshot a source-triggered run records beside it.
 *
 * It carries the evidence in the same shape the run observed it in, points at
 * the log files rather than copying their contents, and is written once: an
 * existing report is evidence of an earlier finalization and is refused rather
 * than overwritten.
 */
import { writeFile } from 'node:fs/promises';
import { ReportError } from './errors.js';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import type {
  AgentSelection,
  AttemptEvidence,
  AttemptKind,
  CancellationEvidence,
  ChangeSummary,
  CheckRoundResult,
  RunReport,
  RunStatus,
  SourceRef,
  Task,
  TimeoutEvidence,
  WorkspaceReport,
} from '../shared/types.js';
import type { RunDirectory } from '../workspace/run-directory.js';
import type { PreparedWorkspace } from '../workspace/prepare.js';
import type { SourcePreflight } from '../workspace/preflight.js';
import { runLogPath } from './logs.js';

/** Name of the final report inside the run directory. */
const RUN_REPORT_NAME = 'result.json';

/** Name of the normalized source task a source-triggered run records. */
const SOURCE_TASK_NAME = 'source-task.json';
/**
 * The only final statuses a run has (docs/spec.md §3). Checked at run time as
 * well as in the type, because a status that arrived from somewhere untyped must
 * not become a fourth one in a report.
 */
const FINAL_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'cancelled']);

/** Why a taken report name is refused rather than reused. */
const REPORT_TAKEN = [
  'A run writes one final report, and an existing one is evidence of an earlier finalization:',
  'it is left exactly as it is.',
].join('\n');
/** What the caller asks a final report to record. */
export interface RunReportRequest {
  /** The allocated run directory: run ID, layout, and log directory. */
  readonly run: RunDirectory;
  /** The task the run was asked to complete, as a label. */
  readonly task: { readonly id: string; readonly title: string };
  /**
   * The effective agent selection: the coding runtime, and the non-secret launch
   * prefix it was started with. It is configured launch information, not proof of
   * the upstream model that served a response, and nothing here is enriched from
   * native configuration or credentials (docs/spec.md §4).
   */
  readonly agent: AgentSelection;
  /**
   * The repository the run started from and the committed base it records: the
   * commit preflight selected for a fresh run, or the continued workspace's own
   * recorded base, which stays the comparison base across attempts
   * (docs/implement-workspace-continuation.md).
   */
  readonly source: SourcePreflight;
  /**
   * The prepared working copy, or `null` when preparation failed. The run
   * directory exists either way: preparation can fail after it was created, and
   * the report then records the facts it has and says what is missing instead of
   * describing a clone that was never made.
   */
  readonly workspace: PreparedWorkspace | null;
  /** Why there is no usable working copy; `null` exactly when `workspace` is not. */
  readonly preparationProblem: string | null;
  /** Start of the run, as an ISO timestamp. */
  readonly startedAt: string;
  /** End of the run, as an ISO timestamp. */
  readonly endedAt: string;
  /** How the run ended: one of {@link RunStatus}, and nothing else. */
  readonly status: RunStatus;
  /** Why it ended that way, in one sentence. Never blank. */
  readonly reason: string;
  /** The baseline round, or `null` when no baseline round was observed. */
  readonly baseline: CheckRoundResult | null;
  /** One entry per top-level coding turn, oldest first. */
  readonly attempts: readonly AttemptEvidence[];
  /**
   * What stopped the run when its time ran out: which limit expired, in which
   * phase, and whether the harness confirmed that the execution it stopped
   * really ended. `null` for a run that ended for any other reason.
   */
  readonly timeout: TimeoutEvidence | null;
  /**
   * What stopped a run its caller cancelled: in which phase it was stopped, and
   * whether the harness confirmed that the execution it stopped really ended.
   * `null` for a run that ended for any other reason — including a run that
   * ends as `cancelled` without a stop to describe, which is why this is
   * optional rather than required of that status.
   */
  readonly cancellation?: CancellationEvidence | null;
  /**
   * What the retained working copy differs from its recorded base by, and what a
   * reader must not conclude from the status above; see {@link ChangeSummary}.
   * Required of every run: a run whose working copy could not be compared with
   * its base says so here, rather than reporting no changes.
   */
  readonly changes: ChangeSummary;
  /**
   * Where a source-triggered run took its task from, or nothing for a run that
   * was given a task file. It is recorded beside the repository the run started
   * from, so an intake receipt and the run's own artifacts can be correlated
   * after the fact (docs/architecture.md §5).
   */
  readonly sourceRef?: SourceRef | undefined;
}

/** Refuses a request that would describe a run other than the one that happened. */
function assertReportable(request: RunReportRequest): void {
  if (!FINAL_STATUSES.has(request.status)) {
    throw new ReportError(
      `"${String(request.status)}" is not a final run status: a run ends as "passed", "failed", or ` +
        '"cancelled", and nothing else (docs/spec.md §3).',
    );
  }

  if (request.reason.trim() === '') {
    throw new ReportError(
      'a report needs a reason: say in one sentence why the run ended the way it did.',
    );
  }

  if (request.agent.runtime !== 'codex') {
    throw new ReportError(
      `"${String(request.agent.runtime)}" is not an implemented coding runtime: a report names the ` +
        'adapter the harness really ran, and the Codex CLI is the only one it has.',
    );
  }
  if (request.agent.command.length === 0 || (request.agent.command[0] ?? '').trim() === '') {
    throw new ReportError(
      'the agent launch prefix needs an executable as its first item: the report names what the ' +
        'harness launched, and a prefix with no executable names nothing.',
    );
  }

  const hasWorkspace = request.workspace !== null;
  const hasProblem = request.preparationProblem !== null;
  if (hasWorkspace === hasProblem) {
    throw new ReportError(
      hasWorkspace
        ? 'a prepared working copy and a preparation problem cannot both be recorded: the report ' +
            'would describe a working copy that also failed to be prepared.'
        : 'a report without a prepared working copy has to say why one is missing. Preparation can ' +
            'fail after the run directory exists, and the directory alone is not a working copy.',
    );
  }

  for (const [index, attempt] of request.attempts.entries()) {
    const turn = index + 1;
    const kind: AttemptKind = turn === 1 ? 'implementation' : 'repair';
    if (attempt.turn !== turn || attempt.kind !== kind) {
      throw new ReportError(
        `coding turn ${String(turn)} is not recorded as such: attempts are recorded in order, and ` +
          `turn ${String(turn)} is ${turn === 1 ? 'the implementation' : 'a repair'} (received ` +
          `turn ${String(attempt.turn)}, kind "${attempt.kind}").`,
      );
    }
    if (attempt.agentLog.trim() === '') {
      throw new ReportError(
        `coding turn ${String(turn)} has no agent log: every turn keeps its useful output in its ` +
          'own file, and the report points at it rather than copying it in.',
      );
    }
  }

  if (request.timeout !== null) {
    const { timeout } = request;
    if (request.status !== 'failed') {
      throw new ReportError(
        `a timeout is reported as "failed", not as "${request.status}": an expired limit is not a red ` +
          'check round to repair, and it is certainly not a pass (docs/spec.md §3).',
      );
    }
    const unconfirmed = timeout.termination !== 'confirmed';
    if (unconfirmed === (timeout.problem === null)) {
      throw new ReportError(
        unconfirmed
          ? 'a timeout whose termination is unconfirmed has to say what could not be confirmed: the ' +
              "limitation belongs in the report rather than in a reader's assumptions about what is " +
              'still running.'
          : 'a timeout with a confirmed termination has nothing left to explain, so it cannot also ' +
              'carry a problem: the report would describe a stop that both did and did not happen.',
      );
    }
  }

  const cancellation = request.cancellation ?? null;
  if (cancellation !== null) {
    if (request.status !== 'cancelled') {
      throw new ReportError(
        `a run that its caller stopped is reported as "cancelled", not as "${request.status}": a ` +
          'stop that came from outside the run is not a red check round to repair, and it is ' +
          'certainly not a pass (docs/spec.md §3).',
      );
    }
    const unconfirmed = cancellation.termination !== 'confirmed';
    if (unconfirmed === (cancellation.problem === null)) {
      throw new ReportError(
        unconfirmed
          ? 'a cancellation whose termination is unconfirmed has to say what could not be confirmed: ' +
              'the limitation belongs in the report rather than in an assumption that the working ' +
              'copy it was writing to is safe to reuse.'
          : 'a cancellation with a confirmed termination has nothing left to explain, so it cannot ' +
              'also carry a problem: the report would describe a stop that both did and did not ' +
              'happen.',
      );
    }
  }

  const { changes } = request;
  if (changes.inspected && changes.problem !== null) {
    throw new ReportError(
      'a change summary that was inspected has nothing left to explain, so it cannot also carry a ' +
        'problem: the report would describe a working copy that both was and was not compared with ' +
        'its base.',
    );
  }
  if (!changes.inspected && changes.problem === null) {
    throw new ReportError(
      'a change summary that was not inspected has to say why: a run whose working copy could not be ' +
        'compared with its recorded base must never read as one that left no changes.',
    );
  }
  if (!changes.inspected && (changes.paths.length > 0 || changes.highlighted.length > 0)) {
    throw new ReportError(
      'a change summary that was not inspected cannot list changed paths: nothing was read, so a list ' +
        'of paths would describe a comparison that never happened.',
    );
  }
  if (changes.baseCommit !== request.source.baseCommit) {
    throw new ReportError(
      `the change summary is recorded against ${changes.baseCommit}, not against the base this run ` +
        `recorded (${request.source.baseCommit}): every path in it is a difference from the recorded ` +
        'base, and a summary against another commit describes another run.',
    );
  }

  const stoppedUnconfirmed =
    request.timeout?.termination === 'unconfirmed' ||
    request.cancellation?.termination === 'unconfirmed';
  if (stoppedUnconfirmed && changes.inspected) {
    throw new ReportError(
      'the run ended without confirming that everything it had started had stopped, so its working ' +
        'copy cannot be summarized as final: something may still be writing to it, and the report has ' +
        'to record why the summary is unavailable instead.',
    );
  }

  const last = request.attempts.at(-1) ?? null;
  if (request.status === 'passed' && last?.checks?.outcome !== 'passed') {
    throw new ReportError(
      [
        'a report cannot say the run passed: the checks observed after the last coding turn are not',
        'a completed green round. `passed` means every configured post-agent check exited',
        'successfully for the retained working copy (docs/spec.md §3). What the agent said about its',
        'own turn is not a check result.',
      ].join('\n'),
    );
  }
}

/** The working copy as the report records it, prepared or not. */
function workspaceReport(request: RunReportRequest): WorkspaceReport {
  const { workspace } = request;
  if (workspace === null) {
    return {
      path: request.run.workspacePath,
      prepared: false,
      branch: null,
      workspaceId: null,
      continued: false,
      attempt: null,
      problem: request.preparationProblem,
    };
  }
  return {
    path: workspace.workspacePath,
    prepared: true,
    branch: workspace.branch,
    workspaceId: workspace.workspaceId,
    continued: workspace.continued,
    attempt: workspace.attempt,
    problem: null,
  };
}

/** The final report of a run: `<runDir>/result.json`. */
export function runReportPath(runDir: string): string {
  return path.join(runDir, RUN_REPORT_NAME);
}

/** The normalized source task of a source-triggered run: `<runDir>/source-task.json`. */
export function sourceTaskPath(runDir: string): string {
  return path.join(runDir, SOURCE_TASK_NAME);
}

/**
 * Records the normalized task and the source reference of a source-triggered
 * run, before any configured command executes: what was taken from the source,
 * written down once and never rewritten from a later reading (docs/spec.md §6).
 *
 * It is created exclusively, like every other artifact here, so a run directory
 * that already holds one is evidence of an earlier run and is refused rather
 * than overwritten. It holds task text and provenance only: no credential, no
 * remote response, and no transcript.
 */
export async function writeSourceTaskSnapshot(
  run: RunDirectory,
  task: Task,
  sourceRef: SourceRef,
): Promise<string> {
  const file = sourceTaskPath(run.runDir);
  const snapshot = { task, source: sourceRef };
  try {
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, {
      flag: 'wx',
      encoding: 'utf8',
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ReportError(
        `"${file}" already exists, so this run cannot record which task it took from the source.`,
        { cause },
      );
    }
    throw new ReportError(`the source task "${file}" could not be written: ${messageOf(cause)}`, {
      cause,
    });
  }
  return file;
}

/**
 * Writes the final report of one run and returns the file it wrote, so a caller
 * never has to guess where the report is. A report is written once: an existing
 * `result.json` is refused rather than overwritten, because it is evidence of an
 * earlier finalization.
 *
 * Everything that goes wrong here is a {@link ReportError} naming the file, and
 * nothing is returned for a report that was not written: a caller cannot
 * announce a report location that does not exist. Where the report is printed is
 * the caller's business.
 */
export async function writeRunReport(request: RunReportRequest): Promise<string> {
  const report = buildReport(request);
  const file = runReportPath(request.run.runDir);

  try {
    // `wx`: the file is created by this call, so a report that is already there
    // — evidence of an earlier finalization — is never overwritten.
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ReportError([`"${file}" already exists.`, REPORT_TAKEN].join('\n'), { cause });
    }
    throw new ReportError(`the report "${file}" could not be written: ${messageOf(cause)}`, {
      cause,
    });
  }

  return file;
}

/** The report of one run, validated and ready to serialize. */
function buildReport(request: RunReportRequest): RunReport {
  assertReportable(request);
  return {
    runId: request.run.runId,
    task: { id: request.task.id, title: request.task.title },
    agent: { runtime: request.agent.runtime, command: [...request.agent.command] },
    source: { path: request.source.sourceRoot, baseCommit: request.source.baseCommit },
    ...(request.sourceRef === undefined ? {} : { sourceRef: request.sourceRef }),
    workspace: workspaceReport(request),
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    status: request.status,
    reason: request.reason,
    repairsUsed: request.attempts.filter((attempt) => attempt.kind === 'repair').length,
    baseline: request.baseline,
    attempts: request.attempts,
    timeout: request.timeout,
    cancellation: request.cancellation ?? null,
    changes: request.changes,
    runLog: runLogPath(request.run.logsDir),
  };
}
