import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter, RepositoryState } from '../../../adapters/git.js';
import type {
  ProcessCommand,
  ProcessOutputObserver,
  ProcessResult,
} from '../../../adapters/processes.js';
import type { Command } from '../../../configuration/index.js';
import type { Observation } from '../../../memory/index.js';
import { messageOf } from '../../../result.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../index.js';
import { createArtifactHelpers, roundArtifactPath } from '../artifacts.js';
import { devArtifact } from '../develop/artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../prepare-workspace/artifacts.js';
import { readRequiredRecord } from '../records.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import {
  observationSourceKey,
  rememberObserved,
  memoryContextOf,
  type MemoryContext,
} from '../memory.js';
import { verificationArtifact, type VerificationOutput } from './artifacts.js';

/**
 * Verify executes the configured checks against the current implementation and preserves their
 * results. It requires the worktree to hold the revision the development result describes with no
 * tracked changes, runs every configured check in order, saves each command's output under the
 * round's checks/ directory and records the exit codes. Tracked changes left by the checks cannot
 * produce passed; a check that changed the revision produces no verdict.
 *
 * A worktree that does not hold the reported revision, pre-existing tracked changes and a command
 * that cannot launch or complete are execution errors, not failed assertions.
 */

/** The Processes adapter capability: run one supplied command and report its output and exit. */
export type CommandExecution = (
  command: ProcessCommand,
  onOutput: ProcessOutputObserver,
) => Promise<ProcessResult>;

export type VerifySettings = {
  /** The workspace reference the current selection retains. */
  readonly workspace: { readonly root: string };
  /** The configured checks, run in order with their index selecting the log directory. */
  readonly checks: readonly { readonly name: string; readonly command: Command }[];
  /** The environment the checks run with. */
  readonly environment: Readonly<Record<string, string>>;
  readonly git: GitAdapter;
  readonly runCommand: CommandExecution;
  readonly publish: EventPublisher;
  /**
   * The memory capability, project identity and evidence directory of this execution; Application
   * supplies it, and an action without one performs no recall or ingestion.
   */
  readonly memory?: MemoryContext;
};

/** One recorded check result, from the artifact's shape. */
type CheckResult = VerificationOutput['checks'][number];

/** The characters of each end of one failed check's combined output the observation retains. */
const diagnosticExcerptChars = 2000;

/**
 * The bounded diagnostic excerpt of one failed check: the first and last characters of the
 * combined standard output and standard error, without overlap, with the omitted length marked.
 * Clipping is a record of the log, never a claim that a cause has been established.
 */
function diagnosticExcerpt(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter((text) => text !== '').join('\n');
  if (combined.length <= diagnosticExcerptChars * 2) {
    return combined;
  }
  const omitted = combined.length - diagnosticExcerptChars * 2;
  return [
    combined.slice(0, diagnosticExcerptChars),
    `\n[omitted ${String(omitted)} characters]\n`,
    combined.slice(combined.length - diagnosticExcerptChars),
  ].join('');
}

/**
 * The deterministic observations one failed verification yields: one note per failed check with
 * its command identity, exit result, bounded diagnostic excerpt and its log references. Successful
 * checks supply provenance and operational evidence, not standalone experience notes.
 */
async function verificationObservations(settings: {
  readonly root: string;
  readonly memory: MemoryContext;
  readonly taskKey: string;
  readonly round: number;
  readonly output: VerificationOutput;
  readonly checks: VerifySettings['checks'];
}): Promise<Observation[]> {
  const artifact = roundArtifactPath(
    settings.root,
    settings.round,
    verificationArtifact.pathFromArtifactsRoot,
  );
  const envelope =
    `Task ${settings.taskKey} — project ${settings.memory.project}, role verification, round ` +
    `${String(settings.round)}, outcome ${settings.output.status}, revision ` +
    `${settings.output.headRevision}.`;
  const observations: Observation[] = [];
  for (const [index, check] of settings.output.checks.entries()) {
    if (check.exitCode === 0) {
      continue;
    }
    const command = settings.checks[index];
    const stdoutFile = path.join(
      settings.root,
      'artifacts',
      String(settings.round),
      check.stdoutPath,
    );
    const stderrFile = path.join(
      settings.root,
      'artifacts',
      String(settings.round),
      check.stderrPath,
    );
    const read = async (file: string): Promise<string> => {
      try {
        return await readFile(file, 'utf8');
      } catch (error) {
        throw new Error(`The check log at "${file}" could not be read: ${messageOf(error)}`, {
          cause: error,
        });
      }
    };
    const excerpt = diagnosticExcerpt(await read(stdoutFile), await read(stderrFile));
    const content = [
      envelope,
      `Check "${check.name}" failed with exit code ${String(check.exitCode)}.`,
      `Command: ${command?.command.executable ?? check.name} ${
        command?.command.args.join(' ') ?? ''
      }`,
      'Diagnostics (first and last characters of combined stdout and stderr, omissions marked):',
      excerpt,
      `stdout log: ${stdoutFile}`,
      `stderr log: ${stderrFile}`,
    ].join('\n');
    const selector = `check:${String(index)}`;
    observations.push({
      sourceKey: observationSourceKey({
        artifact,
        selector,
        material: { artifact: settings.output, content },
      }),
      content,
      provenance: {
        project: settings.memory.project,
        issue: settings.taskKey,
        workflow: settings.memory.workflow,
        role: 'verification',
        artifact,
        element: selector,
        round: settings.round,
        revision: settings.output.headRevision,
        references: [stdoutFile, stderrFile],
      },
    });
  }
  return observations;
}

/** Read the worktree's identity and uncommitted work; a Git failure is an execution error. */
async function inspectRepository(git: GitAdapter, worktree: string): Promise<RepositoryState> {
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) {
    throw new Error(inspection.fault.message);
  }
  return inspection.value;
}

/** Create Verify over the workspace, configured checks and command capability. */
export function createVerify(settings: VerifySettings): BoundAction {
  const memory = memoryContextOf(settings.memory);

  const root = settings.workspace.root;
  const worktree = path.join(root, 'worktree');

  /**
   * Run one configured check in the worktree, preserve its output under the round's
   * checks/<index>/ directory and return its result.
   */
  async function runCheck(
    round: number,
    index: number,
    check: VerifySettings['checks'][number],
  ): Promise<CheckResult> {
    const directory = path.join(root, 'artifacts', String(round), 'checks', String(index));
    await mkdir(directory, { recursive: true });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const result = await settings.runCommand(
      {
        executable: check.command.executable,
        args: [...check.command.args],
        directory: worktree,
        environment: settings.environment,
      },
      (output) => {
        (output.stream === 'stdout' ? stdout : stderr).push(output.chunk);
      },
    );
    await writeFile(path.join(directory, 'stdout.log'), Buffer.concat(stdout));
    await writeFile(path.join(directory, 'stderr.log'), Buffer.concat(stderr));
    if (!result.ok) {
      throw new Error(result.fault.message);
    }
    return {
      name: check.name,
      exitCode: result.value.exitCode,
      stdoutPath: `checks/${index}/stdout.log`,
      stderrPath: `checks/${index}/stderr.log`,
    };
  }

  return async () => {
    const helpers = createArtifactHelpers({ root });
    const [development] = await helpers.readInputArtifacts(devArtifact);

    const preparedFile = path.join(root, preparedWorkspaceFile);
    const prepared = await readRequiredRecord(
      preparedFile,
      preparedWorkspaceDeclaration,
      'Prepared workspace',
    );
    if (prepared.taskKey !== development.taskKey) {
      throw new Error(
        `The development result is for task "${development.taskKey}", not the prepared ` +
          `"${prepared.taskKey}".`,
      );
    }

    const recordFile = path.join(root, currentRoundFile);
    const round = await readRequiredRecord(recordFile, currentRoundDeclaration, 'Current round');

    // Checks run only against the work the development result describes: another revision or
    // already uncommitted tracked work is an operational inconsistency, not a failed assertion.
    const before = await inspectRepository(settings.git, worktree);
    if (before.headRevision !== development.headRevision) {
      throw new Error(
        `The worktree at "${worktree}" is at revision ${before.headRevision ?? 'no revision'}, ` +
          `not the development result's ${development.headRevision}; no check runs against ` +
          `another revision.`,
      );
    }
    if (before.trackedChanges) {
      throw new Error(
        `The worktree at "${worktree}" holds tracked changes that are not part of the development ` +
          `result's revision ${development.headRevision}; the configured checks were not run.`,
      );
    }

    const checks: CheckResult[] = [];
    for (const [index, check] of settings.checks.entries()) {
      checks.push(await runCheck(round.number, index, check));
    }

    // A check that changed the revision invalidates its results: the captured logs remain, but no
    // verdict describes the revision the development result recorded.
    const after = await inspectRepository(settings.git, worktree);
    if (after.headRevision !== development.headRevision) {
      throw new Error(
        `Verification left the worktree at revision ${after.headRevision ?? 'no revision'}, ` +
          `not ${development.headRevision}; the check logs are preserved and no verdict is ` +
          `recorded.`,
      );
    }

    const problems: string[] = [];
    const failed = checks.filter((check) => check.exitCode !== 0);
    if (failed.length > 0) {
      problems.push(
        `checks failed: ${failed.map((check) => `"${check.name}" exited ${check.exitCode}`).join(', ')}`,
      );
    }
    if (after.trackedChanges) {
      problems.push('verification left tracked changes in the worktree');
    }

    const output: VerificationOutput = {
      headRevision: development.headRevision,
      status: problems.length === 0 ? 'passed' : 'failed',
      checks,
    };
    if (output.status === 'failed') {
      settings.publish({ source: 'verify', type: 'failed', data: { reason: problems.join('; ') } });
    }
    await helpers.writeOutputArtifact(verificationArtifact, output);
    try {
      const observations = await verificationObservations({
        root,
        memory,
        taskKey: development.taskKey,
        round: round.number,
        output,
        checks: settings.checks,
      });
      for (const observation of observations) {
        await rememberObserved(
          { memory: memory.memory, publish: settings.publish, source: 'verify' },
          observation,
        );
      }
    } catch (error) {
      // A failed check log that cannot be read is reported; it does not turn verification into an
      // execution error and does not change the recorded verdict.
      settings.publish({
        source: 'verify',
        type: 'memory',
        data: { outcome: 'remember-failed', detail: messageOf(error) },
      });
    }
    settings.publish(
      actionOutcomeEvent('verify', {
        task: development.taskKey,
        round: round.number,
        outcome: output.status,
        detail: `${String(checks.length)} check${checks.length === 1 ? '' : 's'}`,
        artifact: {
          path: roundArtifactPath(root, round.number, verificationArtifact.pathFromArtifactsRoot),
        },
      }),
    );
    return output.status;
  };
}
