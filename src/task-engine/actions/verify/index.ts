import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter, RepositoryState } from '../../../adapters/git.js';
import type {
  ProcessCommand,
  ProcessOutputObserver,
  ProcessResult,
} from '../../../adapters/processes.js';
import type { Command } from '../../../configuration/index.js';
import type { BoundAction, EventPublisher } from '../../index.js';
import { createArtifactHelpers } from '../artifacts.js';
import { devArtifact } from '../develop/artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../prepare-workspace/artifacts.js';
import { readRequiredRecord } from '../records.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
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
};

/** One recorded check result, from the artifact's shape. */
type CheckResult = VerificationOutput['checks'][number];

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
    return output.status;
  };
}
