import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentResult, AgentRuntime } from '../../../agent-runtime/index.js';
import type { GitAdapter, RepositoryState } from '../../../adapters/git.js';
import {
  reviewEncoding,
  type CheckObservation,
  type GitHubAdapter,
  type GitHubReview,
  type PullRequestConversation,
} from '../../../adapters/github.js';
import type { JiraAdapter, JiraComment } from '../../../adapters/jira.js';
import { messageOf } from '../../../result.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../index.js';
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
import { readRequiredRecord, writeRecord } from '../records.js';
import { selectionDeclaration } from '../select-task/artifacts.js';
import { publishComment, readComments, readIssue } from '../source.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import { verificationArtifact } from '../verify/artifacts.js';
import {
  reviewArtifact,
  reviewResponseSchema,
  type Finding,
  type ReviewOutput,
  type ReviewResponse,
} from './artifacts.js';

/**
 * Review evaluates the delivered revision against the task and produces an actionable review of
 * that revision. It refreshes the task and pull-request conversations into the local records,
 * supplies the reviewer complete prior findings, developer responses and the comparison diff, and
 * binds the returned verdict to the revision it actually observed. Only a revision Review itself
 * published as approved can authorize merge.
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
  readonly runtime: AgentRuntime;
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  readonly jira: JiraAdapter;
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
    return 'Earlier rounds: none.';
  }
  const ordered = [...rounds.entries()].sort(([left], [right]) => left - right);
  return [
    'Earlier rounds (read these for prior decisions and evidence):',
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

/**
 * Require a report consistent with the shared findings contract: unique current findings, one
 * disposition per supplied prior finding, open findings present in the current list, resolved and
 * withdrawn findings absent from it, and a verdict supported by the current blocking findings.
 */
function validateResponse(response: ReviewResponse, priorFindings: readonly Finding[]): void {
  const current = new Set<string>();
  for (const finding of response.findings) {
    if (current.has(finding.id)) {
      throw new Error(`The reviewer reported finding "${finding.id}" more than once.`);
    }
    current.add(finding.id);
  }

  const supplied = new Set(priorFindings.map((finding) => finding.id));
  const answered = new Set<string>();
  for (const disposition of response.priorFindings) {
    if (!supplied.has(disposition.findingId)) {
      throw new Error(`The reviewer disposed of unknown prior finding "${disposition.findingId}".`);
    }
    if (answered.has(disposition.findingId)) {
      throw new Error(
        `The reviewer disposed of prior finding "${disposition.findingId}" more than once.`,
      );
    }
    answered.add(disposition.findingId);
    const present = current.has(disposition.findingId);
    if (disposition.disposition === 'open' && !present) {
      throw new Error(
        `The reviewer left prior finding "${disposition.findingId}" open without reporting it ` +
          'in findings.',
      );
    }
    if (disposition.disposition !== 'open' && present) {
      throw new Error(
        `The reviewer reported prior finding "${disposition.findingId}" as ` +
          `"${disposition.disposition}" while it is still in findings.`,
      );
    }
  }
  const missing = priorFindings
    .filter((finding) => !answered.has(finding.id))
    .map((finding) => finding.id);
  if (missing.length > 0) {
    throw new Error(
      `The reviewer did not dispose of prior finding${missing.length === 1 ? '' : 's'} ` +
        `${missing.map((id) => `"${id}"`).join(', ')}.`,
    );
  }

  const blocking = response.findings.filter((finding) => finding.severity === 'blocking');
  if (response.verdict === 'approved' && blocking.length > 0) {
    throw new Error(
      `The reviewer approved the revision while reporting blocking finding` +
        `${blocking.length === 1 ? '' : 's'} ${blocking.map((finding) => `"${finding.id}"`).join(', ')}.`,
    );
  }
  if (response.verdict === 'changesRequested' && blocking.length === 0) {
    throw new Error('The reviewer requested changes without a current blocking finding.');
  }
}

/** The ticket comment: the profile, the verdict, what was missed and what to improve. */
function reviewComment(review: ReviewOutput): string {
  return [
    `profile: ${review.profile}`,
    `Review verdict: ${review.verdict}.`,
    review.summary,
    ...review.findings.map((finding) => `- ${finding.title}: ${finding.repairGuidance}`),
  ].join('\n');
}

/** The report shape, finding definitions and identity, disposition and verdict rules. */
const responseInstructions = `Return exactly one JSON object with this shape, and nothing else:
{"verdict":"approved"|"changesRequested"|"inconclusive","summary":"<what was reviewed, the inspected scope and why this verdict>","findings":[{"id":"<task-stable finding ID>","title":"<short title>","severity":"blocking"|"non-blocking","basis":"<the requirement or expected behavior that is violated>","evidence":"<the observed or reproducible failure, related occurrences inspected and material uncertainty>","impact":"<the consequence>","repairGuidance":"<the required correction>","locations":[{"path":"<file>","line":<line>}]}],"priorFindings":[{"findingId":"<supplied prior finding ID>","disposition":"resolved"|"open"|"withdrawn","reason":"<the current implementation and developer response that support the disposition>"}]}
Finding IDs are unique within the task and stable across rounds: reuse an ID for an existing defect, including additional occurrences of the same cause, and give a genuinely different defect a new ID. findings contains every finding still present in the reviewed revision, including retained open findings and newly discovered ones, and no resolved or withdrawn finding. Include exactly one priorFindings entry for every supplied prior finding ID and no others; use an empty array when none were supplied. An open disposition requires the finding in findings. locations may be empty when there is no useful code location, and lines refer to the reviewed revision.
Apply the verdict rules: approved requires sufficient evidence and no current blocking findings; changesRequested requires at least one current blocking finding with a concrete basis, evidence and impact; inconclusive means material evidence is unavailable, and the summary explains what is missing.`;

/** Create Review over the selected workspace, reviewer runtime, publication and adapters. */
export function createReview(settings: ReviewSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    const root = selection.workspace.root;
    const worktree = path.join(root, 'worktree');
    const preparedFile = path.join(root, preparedWorkspaceFile);
    const prepared = await readRequiredRecord(
      preparedFile,
      preparedWorkspaceDeclaration,
      'Prepared workspace',
    );
    if (prepared.taskKey !== selection.taskKey) {
      throw new Error(
        `The prepared workspace is for task "${prepared.taskKey}", not the selected ` +
          `"${selection.taskKey}".`,
      );
    }

    const helpers = createArtifactHelpers({ root });
    const [development, verification, delivery] = await helpers.readInputArtifacts(
      devArtifact,
      verificationArtifact,
      deliveryArtifact,
    );
    const [recorded] = await helpers.readOptionalInputArtifacts(reviewArtifact);
    const issueId = selection.source.issueId;
    const roundFile = path.join(root, currentRoundFile);
    const round = await readRequiredRecord(roundFile, currentRoundDeclaration, 'Current round');

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
    async function publishReport(
      review: ReviewOutput,
      conversation: PullRequestConversation,
      comments: readonly JiraComment[],
    ) {
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
      await publishComment(settings.jira, issueId, comments, reviewComment(review));
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
    // is not evidence for this one.
    if (recorded !== null && recorded.headRevision === reviewedHead) {
      const comments = await readComments(settings.jira, issueId);
      const conversation = await settings.github.readConversation(
        settings.repository,
        delivery.pullRequestNumber,
      );
      if (!conversation.ok) {
        throw new Error(conversation.fault.message);
      }
      await publishReport(recorded, conversation.value, comments);
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

    const issue = await readIssue(settings.jira, issueId);
    const comments = await readComments(settings.jira, issueId);
    // The selection owns the task and conversation; refresh them in place, preserving the selected
    // identity and the retained workspace reference.
    await writeRecord(settings.selectionFile, {
      ...selection,
      task: issue,
      conversation: comments,
    });

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
    const reviews = await helpers.readArtifactHistory(reviewArtifact);
    const developments = await helpers.readArtifactHistory(devArtifact);
    const priorReview = latest(reviews);
    const priorFindings = priorReview?.value.findings ?? [];

    const context = [
      `Task ${selection.taskKey} (Jira issue ${issue.id}):`,
      JSON.stringify(issue, null, 2),
      `Complete task conversation (saved in the local selection record ${settings.selectionFile}):\n${JSON.stringify(
        comments,
        null,
        2,
      )}`,
      `Complete pull-request conversation (saved at ${conversationFile}):\n${JSON.stringify(
        conversation.value,
        null,
        2,
      )}`,
      `Reviewed revision: ${reviewedHead} (comparison base ${prepared.baseRevision})`,
      `Comparison diff ${prepared.baseRevision}..${reviewedHead}:\n${diff.value}`,
      `Development result (round ${round.number}):\n${JSON.stringify(development, null, 2)}`,
      `Verification result for the reviewed revision:\n${JSON.stringify(verification, null, 2)}`,
      priorReview === null
        ? 'No prior findings are supplied for this round.'
        : `Prior findings to evaluate (complete values from the review in round ${
            priorReview.number
          }):\n${JSON.stringify(priorReview.value, null, 2)}`,
      `Developer responses to those findings (complete values from the current development result):\n${JSON.stringify(
        development.findingResponses,
        null,
        2,
      )}`,
      historySection(root, reviews, developments),
      responseInstructions,
    ].join('\n\n');

    settings.publish({
      source: 'review',
      type: 'agent-started',
      data: {
        role: 'reviewer',
        operation: 'Review',
        profile: settings.reviewerProfile,
        task: selection.taskKey,
      },
    });
    let result: AgentResult;
    try {
      result = await settings.runtime.run(settings.reviewerProfile, { root }, context);
    } finally {
      settings.publish({ source: 'review', type: 'agent-finished', data: null });
    }
    if (!result.ok) {
      throw new Error(result.fault.message);
    }

    const response = parseResponse(result.value.output);
    validateResponse(response, priorFindings);

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
      profile: settings.reviewerProfile,
      headRevision: reviewedHead,
      ...response,
    };
    await helpers.writeOutputArtifact(reviewArtifact, review);
    await publishReport(review, conversation.value, comments);
    report(review);
    return review.verdict;
  };
}
