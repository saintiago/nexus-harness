import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { AgentResult } from '../../../agent-runtime/index.js';
import type { GitAdapter, RepositoryState } from '../../../adapters/git.js';
import { messageOf } from '../../../result.js';
import {
  actionOutcomeEvent,
  type AgentRoleRunner,
  type BoundAction,
  type EventPublisher,
} from '../../index.js';
import {
  actionOwnedRecordsText,
  assignReportPath,
  parseAgentReport,
  readAssignedReport,
  readBoundReport,
  responseFormatText,
} from '../agent-reports.js';
import {
  createArtifactHelpers,
  roundArtifactPath,
  type ArtifactDeclaration,
  type ArtifactHistoryValue,
} from '../artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
  type PreparedWorkspace,
} from '../prepare-workspace/artifacts.js';
import { readRequiredRecord } from '../records.js';
import {
  clearPendingValidationError,
  readPendingValidationError,
  rejectReport,
  rejectUnusableRecord,
  validationErrorContextText,
  type ReportScope,
} from '../report-feedback.js';
import {
  isBoundReviewOutput,
  reviewArtifact,
  reviewReportScope,
  type RetainedReviewOutput,
} from '../review/artifacts.js';
import { selectionDeclaration } from '../select-task/artifacts.js';
import { issueSummary } from '../source.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import { verificationArtifact, type VerificationOutput } from '../verify/artifacts.js';
import {
  devArtifact,
  developmentReportScope,
  developmentResponseSchema,
  isBoundDevelopmentOutput,
  requireUsableDevelopmentOutcome,
  type DevelopmentOutput,
  type DevelopmentResponse,
  type RetainedDevelopmentOutput,
} from './artifacts.js';

/**
 * Develop implements the selected task or repairs the preceding round's findings in the retained
 * worktree. It refreshes the task and conversation from the source into the selection record,
 * assembles the round's context from the earlier-round reports and invokes the profile the current
 * round selected once. The action records the profile and observed repository revisions; the agent
 * writes its Markdown report to the assigned path and returns only status. A completed turn must
 * leave committed work on the prepared branch; otherwise the saved outcome records the observed
 * readiness failure separately from the agent's Markdown.
 *
 * Source, repository and invocation failures are execution errors. Unusable agent output, a
 * missing or unreadable assigned report and an invalid binding are rejected with their evidence
 * retained for the next responsible invocation.
 */

export type DevelopSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The developer role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly git: GitAdapter;
  readonly publish: EventPublisher;
};

/** The earlier-round values of the artifacts this action reads as history. */
type RoundHistories = {
  readonly development: readonly ArtifactHistoryValue<RetainedDevelopmentOutput>[];
  readonly verification: readonly ArtifactHistoryValue<VerificationOutput>[];
  readonly review: readonly ArtifactHistoryValue<RetainedReviewOutput>[];
};

/** The most recent value of an artifact history, or null when it has none. */
function latest<Value>(
  history: readonly ArtifactHistoryValue<Value>[],
): ArtifactHistoryValue<Value> | null {
  return history.at(-1) ?? null;
}

/**
 * Why the observed worktree does not hold the committed implementation ready for verification, or
 * null. Untracked files are the dependencies, caches and verification output the worktree is
 * expected to carry; only uncommitted tracked changes contradict the recorded revision.
 */
function readinessProblem(state: RepositoryState, prepared: PreparedWorkspace): string | null {
  if (state.headRevision === null) {
    return 'the worktree has no revision';
  }
  if (state.branch !== prepared.branch) {
    return `the worktree is on branch "${state.branch ?? 'no branch'}", not the prepared "${prepared.branch}"`;
  }
  if (state.trackedChanges) {
    return 'tracked changes are uncommitted';
  }
  return null;
}

/** Read the worktree's identity and uncommitted work; a Git failure is an execution error. */
async function inspectRepository(git: GitAdapter, worktree: string): Promise<RepositoryState> {
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) {
    throw new Error(inspection.fault.message);
  }
  return inspection.value;
}

/** One earlier round's artifact path, relative to the workspace root. */
function roundArtifact(root: string, round: number, pathFromArtifactsRoot: string): string {
  return path.join(root, 'artifacts', String(round), pathFromArtifactsRoot);
}

/** The readable reference one retained development outcome offers. */
function developmentReference(
  root: string,
  round: number,
  outcome: RetainedDevelopmentOutput,
): string {
  if (isBoundDevelopmentOutput(outcome)) {
    const readiness =
      outcome.readinessFailure === null ? '' : `, readiness failure: ${outcome.readinessFailure}`;
    return (
      `development report (${outcome.status}, profile ${outcome.profile}, ` +
      `invocation ${outcome.invocationId}${readiness}): ${outcome.report.path}`
    );
  }
  return (
    `development report (${outcome.status}, profile ${outcome.profile}; retained combined ` +
    `record): ${roundArtifact(root, round, devArtifact.pathFromArtifactsRoot)}`
  );
}

/** The readable reference one retained review outcome offers. */
function reviewReference(root: string, round: number, outcome: RetainedReviewOutput): string {
  if (isBoundReviewOutput(outcome)) {
    return (
      `review report (${outcome.verdict}, profile ${outcome.profile}, ` +
      `invocation ${outcome.invocationId}, reviewed revision ${outcome.headRevision}): ` +
      outcome.report.path
    );
  }
  return (
    `review report (${outcome.verdict}, profile ${outcome.profile}; retained combined record): ` +
    roundArtifact(root, round, reviewArtifact.pathFromArtifactsRoot)
  );
}

/** The available earlier-round reports and results, in round order. */
function historySection(root: string, histories: RoundHistories): string {
  const rounds = new Map<number, string[]>();
  const add = (number: number, line: string): void => {
    const lines = rounds.get(number) ?? [];
    lines.push(`  - ${line}`);
    rounds.set(number, lines);
  };
  for (const value of histories.development) {
    add(value.number, developmentReference(root, value.number, value.value));
  }
  for (const value of histories.verification) {
    add(
      value.number,
      `verification result (${value.value.status}): ` +
        roundArtifact(root, value.number, verificationArtifact.pathFromArtifactsRoot),
    );
  }
  for (const value of histories.review) {
    add(value.number, reviewReference(root, value.number, value.value));
  }
  if (rounds.size === 0) {
    return 'Earlier rounds: none.';
  }
  const ordered = [...rounds.entries()].sort(([left], [right]) => left - right);
  return [
    'Earlier rounds (read these for prior decisions and evidence):',
    ...ordered.flatMap(([number, lines]) => [`- Round ${number}:`, ...lines]),
  ].join('\n');
}

/** The latest recorded check results and their log paths, or null when none were recorded. */
function checkEvidence(root: string, histories: RoundHistories): string | null {
  const recorded = latest(histories.verification);
  if (recorded === null) {
    return null;
  }
  return [
    `Latest recorded verification (round ${recorded.number}): ${recorded.value.status}.`,
    ...recorded.value.checks.map(
      (check) =>
        `- check "${check.name}": exit code ${check.exitCode}, ` +
        `stdout ${roundArtifact(root, recorded.number, check.stdoutPath)}, ` +
        `stderr ${roundArtifact(root, recorded.number, check.stderrPath)}`,
    ),
  ].join('\n');
}

/**
 * The invocation instructions: the assigned Markdown path and its narrative obligations, the
 * derived status-only response contract, and the action-owned records the agent must leave to the
 * action. The action observes the profile and revisions itself.
 */
function responseInstructions(reportFile: string, artifactFile: string): string {
  return [
    `Assigned Markdown report: ${reportFile}`,
    'Write your complete report to that path before returning. It carries what changed and why, ' +
      'the verification performed and its results, corrections, disagreements, the scope checked ' +
      'and remaining problems. Begin with a brief account of what changed and why for concise ' +
      'publication. Report incomplete work or missing material context honestly.',
    responseFormatText(developmentResponseSchema),
    'status "completed" means the implementation is committed on the prepared branch and ready ' +
      'for verification; "failed" means it could not be completed. Return exactly one of those ' +
      'values and no narrative or observed identity metadata.',
    'The assigned Markdown path is the only report artifact you write.',
    actionOwnedRecordsText([artifactFile]),
  ].join('\n\n');
}

/** Create Develop over the configured selection, profiles, developer runtime and adapters. */
export function createDevelop(settings: DevelopSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = selection.workspace.root;
    const helpers = createArtifactHelpers({ root });

    const preparedFile = path.join(root, preparedWorkspaceFile);
    const prepared = await readRequiredRecord(
      preparedFile,
      preparedWorkspaceDeclaration,
      'Prepared workspace',
    );
    // Repository operations and the agent working directory resolve the recorded repository
    // workspace once; the first implementation continues the preparation checkout while its own
    // issue keeps the rounds and artifacts.
    const repositoryWorkspace = prepared.repositoryWorkspace ?? selection.workspace;
    const worktree = path.join(repositoryWorkspace.root, 'worktree');

    const round = await readRequiredRecord(
      path.join(root, currentRoundFile),
      currentRoundDeclaration,
      'Current round',
    );
    const profile = round.profile;
    const scope: ReportScope = developmentReportScope(root, selection.taskKey);
    const reviewerScope: ReportScope = reviewReportScope(root, selection.taskKey);
    const invocationId = randomUUID();
    const attribution = `Development round ${String(round.number)}, profile ${profile}, task ${selection.taskKey}.`;
    const artifactFile = roundArtifactPath(root, round.number, devArtifact.pathFromArtifactsRoot);
    const assignedReport = await assignReportPath(
      path.join(root, 'artifacts', String(round.number)),
      invocationId,
      'developer',
    );
    /**
     * One retained report's earlier rounds. An unusable retained report is preserved under its
     * producer's responsibility before this invocation fails, so a later repair of the file
     * cannot drop the correction obligation.
     */
    const readHistory = <Declaration extends ArtifactDeclaration>(
      declaration: Declaration,
      producer: {
        readonly scope: ReportScope;
        readonly operation: string;
        readonly profile: string | null;
      },
    ) =>
      helpers.readArtifactHistory(declaration, (file, error) =>
        rejectUnusableRecord({
          areaRoot: root,
          scope: producer.scope,
          invocationId,
          operation: producer.operation,
          profile: producer.profile,
          context: `${attribution} Reading retained ${producer.operation} history.`,
          file,
          error,
        }),
      );
    const histories: RoundHistories = {
      development: await readHistory(devArtifact, { scope, operation: 'develop', profile }),
      verification: await helpers.readArtifactHistory(verificationArtifact),
      review: await readHistory(reviewArtifact, {
        scope: reviewerScope,
        operation: 'review',
        profile: null,
      }),
    };
    const pending = await readPendingValidationError({ areaRoot: root, scope });
    let existing: RetainedDevelopmentOutput | null;
    try {
      existing = (await helpers.readOptionalInputArtifacts(devArtifact))[0];
    } catch (error) {
      return await rejectUnusableRecord({
        areaRoot: root,
        scope,
        invocationId,
        operation: 'develop',
        profile,
        context: attribution,
        file: artifactFile,
        error,
      });
    }
    const latestReview = latest(histories.review);

    /** Report the outcome referencing the current round's saved development report. */
    function report(status: DevelopmentOutput['status']): void {
      settings.publish(
        actionOutcomeEvent('develop', {
          task: selection.taskKey,
          round: round.number,
          outcome: status,
          detail: `profile ${profile}`,
          artifact: { path: artifactFile },
        }),
      );
    }

    /**
     * The latest review report as repair context: its Markdown text for a current outcome, or the
     * retained combined record. An unreadable bound report is preserved as the reviewer's
     * rejection evidence before this invocation fails.
     */
    async function latestReviewSection(
      value: ArtifactHistoryValue<RetainedReviewOutput>,
    ): Promise<string> {
      const review = value.value;
      const file = roundArtifact(root, value.number, reviewArtifact.pathFromArtifactsRoot);
      if (!isBoundReviewOutput(review)) {
        return (
          `Most recent review report (round ${String(value.number)}, profile ${review.profile}, ` +
          `verdict ${review.verdict}; retained combined report at ${file}; repair context, ` +
          'judged by the next review against the current revision):\n' +
          JSON.stringify(review, null, 2)
        );
      }
      let text: string;
      try {
        text = (await readBoundReport(review, 'Review report')).text;
      } catch (error) {
        return await rejectUnusableRecord({
          areaRoot: root,
          scope: reviewerScope,
          invocationId,
          operation: 'review',
          profile: review.profile,
          context: `${attribution} Reading the retained review report.`,
          file,
          assignedReport: review.report,
          error,
        });
      }
      return (
        `Most recent review report (round ${String(value.number)}, profile ${review.profile}, ` +
        `invocation ${review.invocationId}, reviewed revision ${review.headRevision}, verdict ` +
        `${review.verdict}; repair context, judged by the next review against the current ` +
        `revision):\n${text}`
      );
    }

    // A repetition reuses a current-round report only while it still describes this task, profile,
    // comparison base and committed revision and carries its readable Markdown. Otherwise another
    // invocation is needed.
    const before = await inspectRepository(settings.git, worktree);
    if (
      existing !== null &&
      existing.taskKey === selection.taskKey &&
      existing.profile === profile &&
      existing.baseRevision === prepared.baseRevision &&
      existing.headRevision === before.headRevision &&
      (existing.status === 'failed' || readinessProblem(before, prepared) === null)
    ) {
      if (isBoundDevelopmentOutput(existing)) {
        await requireUsableDevelopmentOutcome({
          areaRoot: root,
          taskKey: selection.taskKey,
          file: artifactFile,
          outcome: existing,
          invocationId,
          context: attribution,
        });
        // The owner validated the current round's saved replacement; finish an interrupted
        // save/clear replay without another invocation.
        await clearPendingValidationError({ areaRoot: root, scope });
      }
      report(existing.status);
      return existing.status;
    }

    const evidence = checkEvidence(root, histories);
    const context = [
      `Task ${selection.taskKey}`,
      // The parent-owned input boundary refreshed the selection before this invocation; the saved
      // task and complete attributed conversation are the authoritative source input.
      JSON.stringify(selection.task, null, 2),
      `Prepared branch: ${prepared.branch} (comparison base ${prepared.baseRevision})`,
      `Local selection record (refreshed task and complete conversation): ${settings.selectionFile}`,
      ...(latestReview === null
        ? ['No previous review report is retained for this round.']
        : [await latestReviewSection(latestReview)]),
      ...validationErrorContextText(pending),
      historySection(root, histories),
      ...(evidence === null ? [] : [evidence]),
      responseInstructions(assignedReport.path, artifactFile),
    ].join('\n\n');

    const result: AgentResult = await settings.runner.run({
      operation: 'Develop',
      invocationId,
      profile,
      workspace: repositoryWorkspace,
      context,
      outputSchema: z.toJSONSchema(developmentResponseSchema),
      task: selection.taskKey,
      summary: issueSummary(selection.task),
    });
    if (!result.ok) {
      throw new Error(result.fault.message);
    }

    const response = await (async (): Promise<DevelopmentResponse> => {
      try {
        return parseAgentReport(
          result.value.output,
          developmentResponseSchema,
          'development agent',
        );
      } catch (error) {
        return await rejectReport({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'develop',
          profile,
          context: attribution,
          source: null,
          output: result.value.output,
          assignedReport,
          reason: messageOf(error),
          cause: error,
        });
      }
    })();

    await (async () => {
      try {
        await readAssignedReport(assignedReport.path, 'Assigned development report');
      } catch (error) {
        return await rejectReport({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'develop',
          profile,
          context: attribution,
          source: null,
          output: result.value.output,
          assignedReport,
          reason: messageOf(error),
          cause: error,
        });
      }
    })();

    const after = await inspectRepository(settings.git, worktree);
    if (after.headRevision === null) {
      // The turn's parsed outcome and readable Markdown stay rejected evidence: the observed
      // worktree cannot bind them to a revision, and no outcome is saved.
      return await rejectReport({
        areaRoot: root,
        scope,
        invocationId,
        operation: 'develop',
        profile,
        context: attribution,
        source: null,
        output: result.value.output,
        assignedReport,
        reason:
          `The development turn left the worktree at "${worktree}" without a revision; no ` +
          'saved outcome can bind the report to the implementation.',
      });
    }
    const problem = readinessProblem(after, prepared);
    const readinessFailure = response.status === 'completed' ? problem : null;
    const status: DevelopmentOutput['status'] =
      response.status === 'completed' && problem !== null ? 'failed' : response.status;
    if (status === 'failed') {
      settings.publish({
        source: 'develop',
        type: 'failed',
        data: {
          reason:
            readinessFailure === null
              ? `The development turn reported incomplete work; the report is at ${assignedReport.path}.`
              : `The development turn reported completed work, but ${readinessFailure}.`,
        },
      });
    }

    const output: DevelopmentOutput = {
      taskSubject: issueSummary(selection.task) ?? selection.taskKey,
      taskKey: selection.taskKey,
      profile,
      status,
      baseRevision: prepared.baseRevision,
      headRevision: after.headRevision,
      role: 'developer',
      report: assignedReport,
      invocationId,
      readinessFailure,
    };
    await helpers.writeOutputArtifact(devArtifact, output);
    // The owner validated and saved the usable replacement, whatever its business status; its
    // pending validation-error context is cleared while the readable history stays.
    await clearPendingValidationError({ areaRoot: root, scope });
    report(status);
    return status;
  };
}
