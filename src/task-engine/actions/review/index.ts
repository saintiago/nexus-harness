import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { AgentResult } from '../../../agent-runtime/index.js';
import type { GitAdapter, RepositoryState } from '../../../adapters/git.js';
import {
  reviewEncoding,
  type CheckObservation,
  type GitHubAdapter,
  type GitHubReview,
  type PullRequestConversation,
} from '../../../adapters/github.js';
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
  type ArtifactHistoryValue,
} from '../artifacts.js';
import { deliveryArtifact } from '../deliver/artifacts.js';
import {
  devArtifact,
  developmentReportScope,
  isBoundDevelopmentOutput,
  readUsableDevelopmentOutcome,
  type RetainedDevelopmentOutput,
} from '../develop/artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../prepare-workspace/artifacts.js';
import { capturedIssueText } from '../readable-source.js';
import { readRecord, readRequiredRecord } from '../records.js';
import {
  clearPendingValidationError,
  readPendingValidationError,
  rejectReport,
  rejectUnusableRecord,
  validationErrorContextText,
  type ReportScope,
} from '../report-feedback.js';
import { selectionDeclaration } from '../select-task/artifacts.js';
import {
  handoffFile,
  parentAreaDirectory,
  parentHandoffDeclaration,
  type ParentHandoff,
} from '../select-work/artifacts.js';
import { issueSummary } from '../source.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import { verificationArtifact } from '../verify/artifacts.js';
import { humanDirectionSection, type PublicationIdentity } from './context.js';
import { retainReviewEvidence } from './evidence.js';
import {
  isBoundReviewOutput,
  requireUsableReviewOutcome,
  reviewArtifact,
  reviewReportScope,
  reviewResponseSchema,
  type RetainedReviewOutput,
  type ReviewOutput,
  type ReviewResponse,
} from './artifacts.js';

/**
 * Review evaluates the delivered revision against the task and produces an actionable Markdown
 * review of that revision. It refreshes the task and pull-request conversations into the local
 * records, supplies the reviewer the task requirements, the developer's Markdown report,
 * verification evidence and previous review reports, and binds the returned verdict to the
 * revision it actually observed and the report it wrote. Only a revision Review itself published
 * as approved can authorize merge.
 *
 * Unusable agent output, a missing or unreadable assigned report, worktree contradictions and
 * adapter faults are execution errors with their evidence retained; the verdict is the action's
 * outcome. The saved report and the remote review and check make repetition finish publication
 * instead of reviewing again.
 */

/** The review-check conclusion for one verdict; only approved produces a successful check. */
function conclusionFor(verdict: ReviewOutput['verdict']): 'success' | 'failure' {
  return verdict === 'approved' ? 'success' : 'failure';
}

/** True when one observed check is the Nexus Lens publication of this report's result. */
function isPublishedCheck(
  check: CheckObservation,
  report: RetainedReviewOutput,
  name: string,
  appId: number,
): boolean {
  return (
    check.revision === report.headRevision &&
    check.name === name &&
    check.producer?.id === appId &&
    check.status === 'completed' &&
    check.conclusion === conclusionFor(report.verdict)
  );
}

/** True when one observed review published this exact report body for the reviewed head. */
function isPublishedReview(
  review: GitHubReview,
  report: RetainedReviewOutput,
  body: string,
  login: string,
): boolean {
  return (
    review.author === login &&
    review.commit_id === report.headRevision &&
    review.state === reviewEncoding[report.verdict].state &&
    review.body === body
  );
}

export type ReviewSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured GitHub repository the pull request belongs to. */
  readonly repository: string;
  /** The configured review check the repository requires for the reviewed revision. */
  readonly reviewCheck: string;
  /**
   * The configured Nexus Lens App identity: `login` authors its published reviews and `appId` is
   * the identity the provider reports for its check runs.
   */
  readonly nexusLens: { readonly appId: number; readonly login: string };
  /** The configured reviewer profile. */
  readonly reviewerProfile: string;
  /** The reviewer role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  readonly publish: EventPublisher;
};

/** Read the worktree's identity and uncommitted work; a Git failure is an execution error. */
async function inspectRepository(git: GitAdapter, worktree: string): Promise<RepositoryState> {
  const inspection = await git.inspectRepository(worktree);
  if (!inspection.ok) {
    throw new Error(inspection.fault.message);
  }
  return inspection.value;
}

/** Read the checks observed for one revision; a provider failure is an execution error. */
async function readChecks(
  github: GitHubAdapter,
  repository: string,
  revision: string,
): Promise<readonly CheckObservation[]> {
  const result = await github.readChecks(repository, revision);
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  return result.value;
}

/**
 * The parent-retained publication identities that acknowledge Nexus-written Jira comments, or an
 * empty list when no readable handoff retains any. The identities only exclude confirmed
 * publications from the directly visible section; without them an entry stays visible as
 * uncertain direction, so an absent or unreadable record never hides a possible obligation.
 */
async function readPublicationIdentities(root: string): Promise<readonly PublicationIdentity[]> {
  const file = path.join(root, parentAreaDirectory, handoffFile);
  let handoff: ParentHandoff | null;
  try {
    handoff = await readRecord(file, parentHandoffDeclaration);
  } catch {
    return [];
  }
  return handoff?.publications ?? [];
}

/** The most recent value of an artifact history, or null when it has none. */
function latest<Value>(
  history: readonly ArtifactHistoryValue<Value>[],
): ArtifactHistoryValue<Value> | null {
  return history.at(-1) ?? null;
}

/** One earlier round's artifact path, relative to the workspace root. */
function roundArtifact(root: string, round: number, pathFromArtifactsRoot: string): string {
  return path.join(root, 'artifacts', String(round), pathFromArtifactsRoot);
}

/** The readable reference one retained development report offers. */
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

/** The readable reference one retained review report offers. */
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
function historySection(
  root: string,
  reviews: readonly ArtifactHistoryValue<RetainedReviewOutput>[],
  developments: readonly ArtifactHistoryValue<RetainedDevelopmentOutput>[],
): string {
  const rounds = new Map<number, string[]>();
  const add = (number: number, line: string): void => {
    const lines = rounds.get(number) ?? [];
    lines.push(`  - ${line}`);
    rounds.set(number, lines);
  };
  for (const value of developments) {
    add(value.number, developmentReference(root, value.number, value.value));
  }
  for (const value of reviews) {
    add(value.number, reviewReference(root, value.number, value.value));
  }
  if (rounds.size === 0) {
    return 'Historical evidence: no earlier rounds.';
  }
  const ordered = [...rounds.entries()].sort(([left], [right]) => left - right);
  return [
    'Historical evidence (readable earlier-round reports saved in this workspace; read what bears ' +
      'on earlier concerns and recurrence):',
    ...ordered.flatMap(([number, lines]) => [`- Round ${number}:`, ...lines]),
  ].join('\n');
}

/**
 * The invocation instructions: the assigned Markdown path and its narrative obligations, the
 * derived verdict-only response contract, and the action-owned records the agent must leave to the
 * action.
 */
function responseInstructions(reportFile: string, artifactFile: string): string {
  return [
    `Assigned Markdown report: ${reportFile}`,
    'Write the complete assessment to that path before returning: the inspected scope, current ' +
      'findings with their evidence, consequence and required correction, optional suggestions, ' +
      'and why the verdict is supported. Begin with a brief account of the verdict and necessary ' +
      'corrections for concise publication.',
    responseFormatText(reviewResponseSchema),
    'verdict "approved" requires sufficient evidence and no current blocking finding; ' +
      '"changesRequested" requires at least one current blocking finding with concrete basis, ' +
      'evidence and impact. These are the only verdicts; when material evidence is unavailable ' +
      'and the assessment cannot finish, supply no verdict.',
    'The assigned Markdown path is the only report artifact you write.',
    actionOwnedRecordsText([artifactFile]),
  ].join('\n\n');
}

/** Create Review over the selected workspace, reviewer runtime, publication and adapters. */
export function createReview(settings: ReviewSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = selection.workspace.root;
    const preparedFile = path.join(root, preparedWorkspaceFile);
    const prepared = await readRequiredRecord(
      preparedFile,
      preparedWorkspaceDeclaration,
      'Prepared workspace',
    );
    // Repository inspection and the reviewer working directory resolve the recorded repository
    // workspace; the first implementation reviews the preparation checkout's branch.
    const repositoryWorkspace = prepared.repositoryWorkspace ?? selection.workspace;
    const worktree = path.join(repositoryWorkspace.root, 'worktree');
    if (prepared.taskKey !== selection.taskKey) {
      throw new Error(
        `The prepared workspace is for task "${prepared.taskKey}", not the selected ` +
          `"${selection.taskKey}".`,
      );
    }

    const helpers = createArtifactHelpers({ root });
    const roundFile = path.join(root, currentRoundFile);
    const round = await readRequiredRecord(roundFile, currentRoundDeclaration, 'Current round');
    const scope: ReportScope = reviewReportScope(root, selection.taskKey);
    const developerScope: ReportScope = developmentReportScope(root, selection.taskKey);
    const invocationId = randomUUID();
    const attribution =
      `Review round ${String(round.number)}, profile ${settings.reviewerProfile}, ` +
      `task ${selection.taskKey}.`;
    const artifactFile = roundArtifactPath(
      root,
      round.number,
      reviewArtifact.pathFromArtifactsRoot,
    );
    const assignedReport = await assignReportPath(
      path.join(root, 'artifacts', String(round.number)),
      invocationId,
      'reviewer',
    );
    const developmentInput = await readUsableDevelopmentOutcome({
      areaRoot: root,
      taskKey: selection.taskKey,
      round: round.number,
      context: attribution,
    });
    if (developmentInput === null) {
      throw new Error('Review requires the current round development result.');
    }
    const development = developmentInput;
    const [verification, delivery] = await helpers.readInputArtifacts(
      verificationArtifact,
      deliveryArtifact,
    );
    const pending = await readPendingValidationError({ areaRoot: root, scope });
    let recorded: RetainedReviewOutput | null;
    try {
      recorded = (await helpers.readOptionalInputArtifacts(reviewArtifact))[0];
    } catch (error) {
      return await rejectUnusableRecord({
        areaRoot: root,
        scope,
        invocationId,
        operation: 'review',
        profile: settings.reviewerProfile,
        context: attribution,
        file: artifactFile,
        error,
      });
    }

    // The delivered head, development result, verification result and retained worktree must
    // describe the same revision before anything is reviewed.
    const reviewedHead = delivery.headRevision;
    if (development.headRevision !== reviewedHead || verification.headRevision !== reviewedHead) {
      throw new Error(
        `The delivered revision ${reviewedHead} does not match the development result's ` +
          `${development.headRevision} and the verification result's ` +
          `${verification.headRevision}.`,
      );
    }

    /**
     * The readable review body of one saved outcome: the bound Markdown or the former combined
     * summary. An unreadable bound report is preserved as the reviewer's rejection evidence.
     */
    async function reviewText(outcome: RetainedReviewOutput): Promise<string> {
      if (!isBoundReviewOutput(outcome)) {
        return outcome.summary;
      }
      try {
        return (await readBoundReport(outcome, 'Review report')).text;
      } catch (error) {
        return await rejectUnusableRecord({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'review',
          profile: outcome.profile,
          context: attribution,
          file: artifactFile,
          assignedReport: outcome.report,
          error,
        });
      }
    }

    /**
     * The development report the reviewer assesses: the developer's Markdown text, or the retained
     * combined record. An unreadable bound report is preserved as the developer's rejection
     * evidence.
     */
    async function developmentSection(): Promise<string> {
      const file = roundArtifactPath(root, round.number, devArtifact.pathFromArtifactsRoot);
      if (!isBoundDevelopmentOutput(development)) {
        return (
          `Development result (round ${String(round.number)}, profile ${development.profile}, ` +
          `status ${development.status}; retained combined report at ${file}):\n` +
          JSON.stringify(development, null, 2)
        );
      }
      let text: string;
      try {
        text = (await readBoundReport(development, 'Development report')).text;
      } catch (error) {
        return await rejectUnusableRecord({
          areaRoot: root,
          scope: developerScope,
          invocationId,
          operation: 'develop',
          profile: development.profile,
          context: `${attribution} Reading the development report under review.`,
          file,
          assignedReport: development.report,
          error,
        });
      }
      return (
        `Development report (round ${String(round.number)}, profile ${development.profile}, ` +
        `invocation ${development.invocationId}, status ${development.status}, head revision ` +
        `${development.headRevision}):\n${text}`
      );
    }

    /**
     * Publish the report and its check for the reviewed head, then the ticket comment. The review
     * is recognized by the Nexus Lens author, the reviewed commit, the verdict and the exact
     * retained report body; the check by the Nexus Lens producer, the configured name, a completed
     * status and the verdict's conclusion. Only the missing part of the publication is written.
     */
    async function publishReport(
      review: RetainedReviewOutput,
      body: string,
      conversation: PullRequestConversation,
    ) {
      const checks = await readChecks(settings.github, settings.repository, review.headRevision);
      const reviewPublished = conversation.reviews.some((candidate) =>
        isPublishedReview(candidate, review, body, settings.nexusLens.login),
      );
      const checkPublished = checks.some((check) =>
        isPublishedCheck(check, review, settings.reviewCheck, settings.nexusLens.appId),
      );
      if (!reviewPublished) {
        const publishedReview = await settings.github.publishReview(settings.repository, {
          pullRequestNumber: delivery.pullRequestNumber,
          revision: review.headRevision,
          verdict: review.verdict,
          body,
        });
        if (!publishedReview.ok) {
          throw new Error(publishedReview.fault.message);
        }
      }
      if (!checkPublished) {
        const publishedCheck = await settings.github.publishReviewCheck(settings.repository, {
          revision: review.headRevision,
          name: settings.reviewCheck,
          result: conclusionFor(review.verdict),
        });
        if (!publishedCheck.ok) {
          throw new Error(publishedCheck.fault.message);
        }
      }
      // Ticket feedback is published by the parent-owned boundary actor, not this child.
    }

    /** Report the outcome referencing the current round's saved review report. */
    function report(review: RetainedReviewOutput): void {
      settings.publish(
        actionOutcomeEvent('review', {
          task: selection.taskKey,
          round: round.number,
          outcome: review.verdict,
          detail: `profile ${review.profile}`,
          artifact: { path: artifactFile },
        }),
      );
    }

    // A saved report for the delivered head is the review of this revision: finish any missing
    // publication for that exact head instead of reviewing again. A report for another revision
    // is not evidence for this one. A retained combined review stays readable under its original
    // protections.
    if (recorded !== null && recorded.headRevision === reviewedHead) {
      await requireUsableReviewOutcome({
        areaRoot: root,
        taskKey: selection.taskKey,
        file: artifactFile,
        outcome: recorded,
        invocationId,
        context: attribution,
      });
      // Publication replay uses the saved assessment for this delivered and verified head; it
      // does not assess the current worktree again.
      await clearPendingValidationError({ areaRoot: root, scope: developerScope });
      // The saved review for the delivered head is this revision's validated replacement — current
      // bound or retained combined; an interrupted save/clear replay completes here without
      // another invocation.
      await clearPendingValidationError({ areaRoot: root, scope });
      const body = await reviewText(recorded);
      const conversation = await settings.github.readConversation(
        settings.repository,
        delivery.pullRequestNumber,
      );
      if (!conversation.ok) {
        throw new Error(conversation.fault.message);
      }
      await publishReport(recorded, body, conversation.value);
      report(recorded);
      return recorded.verdict;
    }

    const before = await inspectRepository(settings.git, worktree);
    if (before.headRevision !== reviewedHead) {
      throw new Error(
        `The worktree at "${worktree}" is at revision ${before.headRevision ?? 'no revision'}, ` +
          `not the delivered ${reviewedHead}.`,
      );
    }
    if (before.trackedChanges) {
      throw new Error(
        `The worktree holds tracked changes that are not part of the delivered revision ` +
          `${reviewedHead}.`,
      );
    }

    // Fresh assessment additionally requires the delivered worktree with no tracked changes.
    // Keep developer context pending until those checks establish the usable saved replacement.
    await clearPendingValidationError({ areaRoot: root, scope: developerScope });

    const conversation = await settings.github.readConversation(
      settings.repository,
      delivery.pullRequestNumber,
    );
    if (!conversation.ok) {
      throw new Error(conversation.fault.message);
    }

    const diff = await settings.git.readDiff(worktree, prepared.baseRevision, reviewedHead);
    if (!diff.ok) {
      throw new Error(diff.fault.message);
    }
    // The invocation's evidence is retained and readable before the reviewer sees its references:
    // the captured source, pull-request conversation and exact comparison diff bytes. Storage
    // failures are execution errors; a partial or empty substitute is never assembled.
    const evidence = await retainReviewEvidence({
      reportFile: assignedReport.path,
      task: selection.task,
      conversation: selection.conversation,
      pullRequestConversation: conversation.value,
      diff: diff.value,
    });
    const publications = await readPublicationIdentities(root);
    const reviews = await helpers.readArtifactHistory(reviewArtifact, (file, error) =>
      rejectUnusableRecord({
        areaRoot: root,
        scope,
        invocationId,
        operation: 'review',
        profile: settings.reviewerProfile,
        context: `${attribution} Reading retained review history.`,
        file,
        error,
      }),
    );
    const developments = await helpers.readArtifactHistory(devArtifact, (file, error) =>
      rejectUnusableRecord({
        areaRoot: root,
        scope: developerScope,
        invocationId,
        operation: 'develop',
        profile: null,
        context: `${attribution} Reading retained development history.`,
        file,
        error,
      }),
    );
    // A fresh assessment at a different head consults the current round's own saved assessment
    // when one exists; otherwise the latest earlier-round review is the preceding assessment.
    // Approval does not retire it: the reviewer judges recurrence against the current revision.
    const priorReview: ArtifactHistoryValue<RetainedReviewOutput> | null =
      recorded === null ? latest(reviews) : { number: round.number, value: recorded };

    /** The previous review report as context: its Markdown text or retained combined record. */
    async function priorReviewSection(
      value: ArtifactHistoryValue<RetainedReviewOutput>,
    ): Promise<string> {
      const review = value.value;
      const file = roundArtifact(root, value.number, reviewArtifact.pathFromArtifactsRoot);
      if (!isBoundReviewOutput(review)) {
        return (
          `Previous review report (round ${String(value.number)}, profile ${review.profile}, ` +
          `verdict ${review.verdict}; retained combined record at ${file}; judge whether its ` +
          'concerns remain against the current revision):\n' +
          JSON.stringify(review, null, 2)
        );
      }
      let text: string;
      try {
        text = (await readBoundReport(review, 'Previous review report')).text;
      } catch (error) {
        return await rejectUnusableRecord({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'review',
          profile: review.profile,
          context: `${attribution} Reading the previous review report.`,
          file,
          assignedReport: review.report,
          error,
        });
      }
      return (
        `Previous review report (round ${String(value.number)}, profile ${review.profile}, ` +
        `invocation ${review.invocationId}, reviewed revision ${review.headRevision}, verdict ` +
        `${review.verdict}; judge whether its concerns remain against the current revision):\n` +
        text
      );
    }

    const context = [
      `Task ${selection.taskKey} — current captured requirements (complete captured Jira issue ` +
        `and conversation at ${evidence.capturedSource}):\n` +
        capturedIssueText(selection.task, evidence.capturedSource),
      humanDirectionSection({
        taskKey: selection.taskKey,
        issueId: selection.source.issueId,
        taskConversation: selection.conversation,
        capturedSourcePath: evidence.capturedSource,
        publications,
        repository: settings.repository,
        pullRequestNumber: delivery.pullRequestNumber,
        pullRequestConversation: conversation.value,
        prConversationPath: evidence.prConversation,
        nexusLensLogin: settings.nexusLens.login,
      }),
      `Reviewed revision: ${reviewedHead} (comparison base ${prepared.baseRevision})`,
      `Complete comparison diff ${prepared.baseRevision}..${reviewedHead}, exact bytes as ` +
        'returned (orienting evidence only; it does not bound the review — all code relevant to ' +
        'task correctness, including pre-existing code outside this range, remains in scope; ' +
        `stored untruncated, including a valid empty diff): ${evidence.comparisonDiff}`,
      await developmentSection(),
      `Verification result for the reviewed revision:\n${JSON.stringify(verification, null, 2)}`,
      ...(priorReview === null ? [] : [await priorReviewSection(priorReview)]),
      ...validationErrorContextText(pending),
      historySection(root, reviews, developments),
      responseInstructions(assignedReport.path, artifactFile),
    ].join('\n\n');

    const result: AgentResult = await settings.runner.run({
      operation: 'Review',
      invocationId,
      profile: settings.reviewerProfile,
      workspace: repositoryWorkspace,
      context,
      outputSchema: z.toJSONSchema(reviewResponseSchema),
      task: selection.taskKey,
      summary: issueSummary(selection.task),
    });
    if (!result.ok) {
      throw new Error(result.fault.message);
    }

    const response = await (async (): Promise<ReviewResponse> => {
      try {
        return parseAgentReport(result.value.output, reviewResponseSchema, 'reviewer');
      } catch (error) {
        return await rejectReport({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'review',
          profile: settings.reviewerProfile,
          context: attribution,
          source: null,
          output: result.value.output,
          assignedReport,
          reason: messageOf(error),
          cause: error,
        });
      }
    })();

    const reportFile = await (async () => {
      try {
        return await readAssignedReport(assignedReport.path, 'Assigned review report');
      } catch (error) {
        return await rejectReport({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'review',
          profile: settings.reviewerProfile,
          context: attribution,
          source: null,
          output: result.value.output,
          assignedReport,
          reason: messageOf(error),
          cause: error,
        });
      }
    })();

    // The implementation being reviewed must survive the turn; caches, logs and other untracked
    // verification output do not invalidate the review.
    const after = await inspectRepository(settings.git, worktree);
    if (after.headRevision !== reviewedHead) {
      // The parsed verdict and its readable Markdown are rejected evidence: the observed worktree
      // no longer binds them to the reviewed revision, and no review outcome is saved.
      return await rejectReport({
        areaRoot: root,
        scope,
        invocationId,
        operation: 'review',
        profile: settings.reviewerProfile,
        context: attribution,
        source: null,
        output: result.value.output,
        assignedReport,
        reason:
          `The review turn left the worktree at revision ` +
          `${after.headRevision ?? 'no revision'}, not the reviewed ${reviewedHead}; no review ` +
          'outcome can bind the report to that revision.',
      });
    }
    if (after.trackedChanges) {
      return await rejectReport({
        areaRoot: root,
        scope,
        invocationId,
        operation: 'review',
        profile: settings.reviewerProfile,
        context: attribution,
        source: null,
        output: result.value.output,
        assignedReport,
        reason:
          `The review turn left tracked changes in the worktree; revision ${reviewedHead} is ` +
          'no longer the revision under review, and no review outcome is saved.',
      });
    }

    const review: ReviewOutput = {
      taskSubject: issueSummary(selection.task) ?? selection.taskKey,
      taskKey: selection.taskKey,
      profile: settings.reviewerProfile,
      headRevision: reviewedHead,
      verdict: response.verdict,
      role: 'reviewer',
      report: assignedReport,
      invocationId,
    };
    await helpers.writeOutputArtifact(reviewArtifact, review);
    // The owner validated and saved the usable replacement, whatever its verdict; its pending
    // validation-error context is cleared while the readable history stays.
    await clearPendingValidationError({ areaRoot: root, scope });
    await publishReport(review, reportFile.text, conversation.value);
    report(review);
    return review.verdict;
  };
}
