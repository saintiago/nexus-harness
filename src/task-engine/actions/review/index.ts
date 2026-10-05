import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
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
  createArtifactHelpers,
  roundArtifactPath,
  type ArtifactHistoryValue,
} from '../artifacts.js';
import { deliveryArtifact } from '../deliver/artifacts.js';
import { devArtifact, type DevelopmentOutput } from '../develop/artifacts.js';
import { describeIssues, parseDocument } from '../documents.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../prepare-workspace/artifacts.js';
import { readRequiredRecord } from '../records.js';
import {
  outstandingReportFeedback,
  projectOfWorkspace,
  recordReportCorrection,
  rejectReport,
  rejectUnusableRecord,
  reportFeedbackContextText,
  type ReportScope,
} from '../report-feedback.js';
import { selectionDeclaration } from '../select-task/artifacts.js';
import { issueSummary } from '../source.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import { verificationArtifact } from '../verify/artifacts.js';
import {
  retainedReviewProblem,
  reviewArtifact,
  reviewResponseSchema,
  toFinding,
  type ReviewOutput,
  type ReviewResponse,
  validateReviewResponse,
} from './artifacts.js';

/**
 * Review evaluates the delivered revision against the task and produces an actionable review of
 * that revision. It refreshes the task and pull-request conversations into the local records,
 * supplies the reviewer the task requirements, developer artifacts, verification evidence and
 * previous reports, and binds the returned verdict to the revision it actually observed. Only a
 * revision Review itself published as approved can authorize merge.
 *
 * Unusable agent output, worktree contradictions and adapter faults are execution errors; the
 * verdict is the action's outcome. The saved report and the remote review and check make repetition
 * finish publication instead of reviewing again.
 */

/** The review-check conclusion for one verdict; only approved produces a successful check. */
function conclusionFor(verdict: ReviewOutput['verdict']): 'success' | 'failure' {
  return verdict === 'approved' ? 'success' : 'failure';
}

/** True when one observed check is the Nexus Lens publication of this report's result. */
function isPublishedCheck(
  check: CheckObservation,
  report: ReviewOutput,
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

/** True when one observed review is the Nexus Lens publication of this exact report. */
function isPublishedReview(review: GitHubReview, report: ReviewOutput, login: string): boolean {
  return (
    review.author === login &&
    review.commit_id === report.headRevision &&
    review.state === reviewEncoding[report.verdict].state &&
    review.body === report.summary
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

/** The available earlier-round results and their paths, in round order. */
function historySection(
  root: string,
  reviews: readonly ArtifactHistoryValue<ReviewOutput>[],
  developments: readonly ArtifactHistoryValue<DevelopmentOutput>[],
): string {
  const rounds = new Map<number, string[]>();
  const add = (number: number, description: string, file: string): void => {
    const lines = rounds.get(number) ?? [];
    lines.push(`  - ${description}: ${roundArtifact(root, number, file)}`);
    rounds.set(number, lines);
  };
  for (const value of developments) {
    add(
      value.number,
      `development result (${value.value.status})`,
      devArtifact.pathFromArtifactsRoot,
    );
  }
  for (const value of reviews) {
    add(
      value.number,
      `review result (${value.value.verdict})`,
      reviewArtifact.pathFromArtifactsRoot,
    );
  }
  if (rounds.size === 0) {
    return 'Historical evidence: no earlier rounds.';
  }
  const ordered = [...rounds.entries()].sort(([left], [right]) => left - right);
  return [
    'Historical evidence (complete earlier-round reports saved in this workspace; read what bears ' +
      'on earlier concerns and recurrence):',
    ...ordered.flatMap(([number, lines]) => [`- Round ${number}:`, ...lines]),
  ].join('\n');
}

/** The reviewer's report, or an error naming why its output is unusable. */
function parseResponse(output: string): ReviewResponse {
  const parsed = parseDocument(output, reviewResponseSchema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(`The reviewer returned unusable output: ${messageOf(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `The reviewer's report does not match the response format: ` +
        describeIssues(parsed.error, '<report>'),
      { cause: parsed.error },
    );
  }
  return parsed.content;
}

/** The report shape, current finding definition and verdict rules. */
const responseInstructions = `Return exactly one JSON object with this shape, and nothing else:
{"verdict":"approved"|"changesRequested","summary":"<what was reviewed, the inspected scope and why this verdict>","findings":[{"title":"<short title>","severity":"blocking"|"non-blocking","basis":"<the requirement or expected behavior that is violated>","evidence":"<the observed or reproducible failure, related occurrences inspected and material uncertainty>","impact":"<the consequence>","repairGuidance":"<the required correction>","locations":[{"path":"<file>","line":<line or null>}]}]}
findings contains the defects present in the reviewed revision, including newly discovered ones; a remaining or recurring defect is a current finding with evidence, and a resolved problem needs no lifecycle record. findings have no stable IDs, responses, statuses or dispositions. Previous reviews and developer narratives are context: judge whether earlier problems remain against the current revision. locations may be empty when there is no useful code location; a location's line refers to the reviewed revision, and states null when the location has no line.
Apply the verdict rules: approved requires sufficient evidence and no current blocking findings; changesRequested requires at least one current blocking finding with a concrete basis, evidence and impact. These are the only verdicts; when material evidence is unavailable and the assessment cannot finish, supply no verdict — do not convert missing evidence into approval, changesRequested or a fabricated blocking finding.
Do not write or overwrite the action-owned round records (development.json, verification.json, delivery.json, review.json); return the response object only, and the action binds the observed profile and reviewed head and persists this verdict.`;

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
    const scope: ReportScope = {
      project: projectOfWorkspace(root),
      workId: selection.taskKey,
      area: root,
      role: 'reviewer',
      reportKind: 'review',
    };
    const developerScope: ReportScope = {
      project: projectOfWorkspace(root),
      workId: selection.taskKey,
      area: root,
      role: 'developer',
      reportKind: 'development',
    };
    const invocationId = randomUUID();
    const attribution =
      `Review round ${String(round.number)}, profile ${settings.reviewerProfile}, ` +
      `task ${selection.taskKey}.`;
    /** One retained report read: an unusable record is preserved under its producer's scope. */
    const readReport = async <Value>(
      file: string,
      producer: {
        readonly scope: ReportScope;
        readonly operation: string;
        readonly profile: string | null;
      },
      read: () => Promise<Value>,
    ): Promise<Value> => {
      try {
        return await read();
      } catch (error) {
        return await rejectUnusableRecord({
          areaRoot: root,
          scope: producer.scope,
          invocationId,
          operation: producer.operation,
          profile: producer.profile,
          context: attribution,
          file,
          error,
        });
      }
    };
    const development = await readReport(
      roundArtifactPath(root, round.number, devArtifact.pathFromArtifactsRoot),
      { scope: developerScope, operation: 'develop', profile: null },
      async () => (await helpers.readInputArtifacts(devArtifact))[0],
    );
    const [verification, delivery] = await helpers.readInputArtifacts(
      verificationArtifact,
      deliveryArtifact,
    );
    const outstanding = await outstandingReportFeedback({ areaRoot: root, scope });
    let recorded: ReviewOutput | null;
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
        file: roundArtifactPath(root, round.number, reviewArtifact.pathFromArtifactsRoot),
        error,
      });
    }

    if (development.taskKey !== selection.taskKey) {
      throw new Error(
        `The development result is for task "${development.taskKey}", not the selected ` +
          `"${selection.taskKey}".`,
      );
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
     * Publish the report and its check for the reviewed head, then the ticket comment. The review
     * is recognized by the Nexus Lens author, the reviewed commit, the verdict and the report body;
     * the check by the Nexus Lens producer, the configured name, a completed status and the
     * verdict's conclusion. Only the missing part of the publication is written.
     */
    async function publishReport(review: ReviewOutput, conversation: PullRequestConversation) {
      const checks = await readChecks(settings.github, settings.repository, review.headRevision);
      const reviewPublished = conversation.reviews.some((candidate) =>
        isPublishedReview(candidate, review, settings.nexusLens.login),
      );
      const checkPublished = checks.some((check) =>
        isPublishedCheck(check, review, settings.reviewCheck, settings.nexusLens.appId),
      );
      if (!reviewPublished) {
        const publishedReview = await settings.github.publishReview(settings.repository, {
          pullRequestNumber: delivery.pullRequestNumber,
          revision: review.headRevision,
          verdict: review.verdict,
          body: review.summary,
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
    function report(review: ReviewOutput): void {
      settings.publish(
        actionOutcomeEvent('review', {
          task: selection.taskKey,
          round: round.number,
          outcome: review.verdict,
          detail: `profile ${review.profile}`,
          artifact: {
            path: roundArtifactPath(root, round.number, reviewArtifact.pathFromArtifactsRoot),
          },
        }),
      );
    }

    // A saved report for the delivered head is the review of this revision: finish any missing
    // publication for that exact head instead of reviewing again. A report for another revision
    // is not evidence for this one. A retained report with an inconsistent verdict is an action
    // failure, not a report to publish.
    if (recorded !== null && recorded.headRevision === reviewedHead) {
      const problem = retainedReviewProblem(recorded);
      if (problem !== null) {
        return await rejectUnusableRecord({
          areaRoot: root,
          scope,
          invocationId,
          operation: 'review',
          profile: settings.reviewerProfile,
          context: attribution,
          file: roundArtifactPath(root, round.number, reviewArtifact.pathFromArtifactsRoot),
          error: new Error(`The retained review report is unusable: ${problem}.`),
        });
      }
      const conversation = await settings.github.readConversation(
        settings.repository,
        delivery.pullRequestNumber,
      );
      if (!conversation.ok) {
        throw new Error(conversation.fault.message);
      }
      await publishReport(recorded, conversation.value);
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

    const conversation = await settings.github.readConversation(
      settings.repository,
      delivery.pullRequestNumber,
    );
    if (!conversation.ok) {
      throw new Error(conversation.fault.message);
    }
    const conversationFile = path.join(
      root,
      'artifacts',
      String(round.number),
      'pr-conversation.json',
    );
    await writeFile(conversationFile, `${JSON.stringify(conversation.value, null, 2)}\n`, 'utf8');

    const diff = await settings.git.readDiff(worktree, prepared.baseRevision, reviewedHead);
    if (!diff.ok) {
      throw new Error(diff.fault.message);
    }
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
    const priorReview = latest(reviews);

    const context = [
      `Task ${selection.taskKey}:`,
      JSON.stringify(selection.task, null, 2),
      `Complete task conversation (saved in the local selection record ${settings.selectionFile}):\n${JSON.stringify(
        selection.conversation,
        null,
        2,
      )}`,
      `Complete pull-request conversation (saved at ${conversationFile}):\n${JSON.stringify(
        conversation.value,
        null,
        2,
      )}`,
      `Reviewed revision: ${reviewedHead} (comparison base ${prepared.baseRevision})`,
      `Comparison diff ${prepared.baseRevision}..${reviewedHead} (orientation only; ` +
        `task-relevant pre-existing code outside this range is in scope):\n${diff.value}`,
      `Development result (round ${round.number}):\n${JSON.stringify(development, null, 2)}`,
      `Verification result for the reviewed revision:\n${JSON.stringify(verification, null, 2)}`,
      ...(priorReview === null
        ? []
        : [
            `Previous review report (round ${priorReview.number}; judge whether its concerns ` +
              'remain against the current revision):\n' +
              JSON.stringify(priorReview.value, null, 2),
          ]),
      ...reportFeedbackContextText(outstanding),
      historySection(root, reviews, developments),
      responseInstructions,
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
        const parsed = parseResponse(result.value.output);
        validateReviewResponse(parsed);
        return parsed;
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
          reason: messageOf(error),
          cause: error,
        });
      }
    })();

    // The implementation being reviewed must survive the turn; caches, logs and other untracked
    // verification output do not invalidate the review.
    const after = await inspectRepository(settings.git, worktree);
    if (after.headRevision !== reviewedHead) {
      throw new Error(
        `The review turn left the worktree at revision ${after.headRevision ?? 'no revision'}, ` +
          `not the reviewed ${reviewedHead}.`,
      );
    }
    if (after.trackedChanges) {
      throw new Error(
        `The review turn left tracked changes in the worktree; revision ${reviewedHead} is no ` +
          'longer the revision under review.',
      );
    }

    const review: ReviewOutput = {
      taskSubject: issueSummary(selection.task) ?? selection.taskKey,
      profile: settings.reviewerProfile,
      headRevision: reviewedHead,
      ...response,
      // The response carries every location's line, reporting null when it has none; the saved
      // Finding omits the line instead.
      findings: response.findings.map(toFinding),
    };
    await helpers.writeOutputArtifact(reviewArtifact, review);
    if (outstanding.length > 0) {
      // The owner validated and saved the usable replacement; recording its complete identity
      // retires exactly the rejections this invocation was supplied, preserving their history.
      await recordReportCorrection({
        areaRoot: root,
        scope,
        rejections: outstanding.map((entry) => ({ path: entry.path })),
        artifact: {
          path: roundArtifactPath(root, round.number, reviewArtifact.pathFromArtifactsRoot),
        },
        content: review,
        invocationId,
      });
    }
    await publishReport(review, conversation.value);
    report(review);
    return review.verdict;
  };
}
