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
import type { JiraAdapter, JiraComment } from '../../../adapters/jira.js';
import type { Observation } from '../../../memory/index.js';
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
import { devArtifact, type DevelopmentOutput, type FindingResponse } from '../develop/artifacts.js';
import { describeIssues, parseDocument } from '../documents.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../prepare-workspace/artifacts.js';
import { readRequiredRecord, writeRecord } from '../records.js';
import { selectionDeclaration } from '../select-task/artifacts.js';
import { issueSummary, publishComment, readComments, readIssue } from '../source.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import { verificationArtifact } from '../verify/artifacts.js';
import {
  issueQueryMaterial,
  observationSourceKey,
  recallForInvocation,
  rememberObserved,
  retrievalQuery,
  memoryContextOf,
  type MemoryContext,
} from '../memory.js';
import {
  reviewArtifact,
  reviewResponseSchema,
  toFinding,
  type Finding,
  type ReviewOutput,
  type ReviewResponse,
} from './artifacts.js';

/**
 * Review evaluates the delivered revision against the task and produces an actionable review of
 * that revision. It refreshes the task and pull-request conversations into the local records,
 * supplies the reviewer the exact current-round prior-finding set with the matching developer
 * responses and the comparison diff, and binds the returned verdict to the revision it actually
 * observed. Only a revision Review itself published as approved can authorize merge.
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
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
  /**
   * The memory capability, project identity and evidence directory of this execution; Application
   * supplies it, and an action without one performs no recall or ingestion.
   */
  readonly memory?: MemoryContext;
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
    'Historical evidence (complete earlier-round reports saved in this workspace, separate from ' +
      'the current-round disposition input; read what bears on identity or recurrence):',
    ...ordered.flatMap(([number, lines]) => [`- Round ${number}:`, ...lines]),
  ].join('\n');
}

/**
 * The current-round disposition input: the preceding review's findings array is the exact set of
 * eligible prior findings, followed by the developer's responses to those findings. The review's
 * verdict, summary and its own dispositions stay out of this input; the saved reports remain
 * historical evidence the reviewer reads for identity and recurrence.
 */
function dispositionInput(
  priorRound: number | null,
  findings: readonly Finding[],
  responses: readonly FindingResponse[],
): string {
  const eligible =
    findings.length === 0 ? 'none' : findings.map((finding) => `"${finding.id}"`).join(', ');
  return [
    priorRound === null
      ? 'Current-round prior findings to dispose of: none; no review precedes this round.'
      : 'Current-round prior findings to dispose of (complete Finding values: the findings ' +
        `array of the round ${String(priorRound)} review):` +
        `\n${JSON.stringify(findings, null, 2)}`,
    `Eligible prior finding IDs: ${eligible}. Return exactly one priorFindings disposition for ` +
      'each eligible ID and none for any other; an empty eligible set requires an empty ' +
      'priorFindings array.',
    'Developer responses to those findings (complete values from the current development ' +
      `result):\n${JSON.stringify(responses, null, 2)}`,
  ].join('\n\n');
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

/**
 * The deterministic observations one saved review yields: its overall verdict and summary, one
 * note per new finding, and one per prior-finding disposition carrying the finding it disposes of
 * and the matching developer response. A finding and the disposition of an earlier finding stay
 * distinct observations.
 */
function reviewObservations(settings: {
  readonly root: string;
  readonly memory: MemoryContext;
  readonly taskKey: string;
  readonly subject: string;
  readonly round: number;
  readonly review: ReviewOutput;
  readonly priorFindings: readonly Finding[];
  readonly responses: readonly FindingResponse[];
  /** The earlier review artifact the prior findings came from, when one was read. */
  readonly priorReviewArtifact: string | null;
  /** The development artifact the developer responses came from. */
  readonly developmentArtifact: string;
}): Observation[] {
  const artifact = roundArtifactPath(
    settings.root,
    settings.round,
    reviewArtifact.pathFromArtifactsRoot,
  );
  const envelope =
    `Task ${settings.taskKey} "${settings.subject}" — project ${settings.memory.project}, role ` +
    `reviewer, round ${String(settings.round)}, verdict ${settings.review.verdict}, revision ` +
    `${settings.review.headRevision}.`;
  const observation = (selector: string, content: string): Observation => {
    const text = `${envelope}\n${content}`;
    return {
      sourceKey: observationSourceKey({
        artifact,
        selector,
        material: { artifact: settings.review, content: text },
      }),
      content: text,
      provenance: {
        project: settings.memory.project,
        issue: settings.taskKey,
        workflow: settings.memory.workflow,
        role: 'reviewer',
        artifact,
        element: selector,
        round: settings.round,
        revision: settings.review.headRevision,
        ...(selector.startsWith('disposition:')
          ? {
              references: [
                ...(settings.priorReviewArtifact === null ? [] : [settings.priorReviewArtifact]),
                settings.developmentArtifact,
              ],
            }
          : {}),
      },
    };
  };
  return [
    observation(
      'verdict',
      `Review verdict: ${settings.review.verdict}.\n${settings.review.summary}`,
    ),
    ...settings.review.findings.map((finding) =>
      observation(
        `finding:${finding.id}`,
        `Review finding "${finding.id}" (${finding.severity}): ${finding.title}\n` +
          JSON.stringify(finding, null, 2),
      ),
    ),
    ...settings.review.priorFindings.map((disposition) => {
      const finding = settings.priorFindings.find(
        (candidate) => candidate.id === disposition.findingId,
      );
      const response = settings.responses.find(
        (candidate) => candidate.findingId === disposition.findingId,
      );
      return observation(
        `disposition:${disposition.findingId}`,
        `Prior finding "${disposition.findingId}" disposition: ${disposition.disposition}. ` +
          `${disposition.reason}\nOriginal finding: ` +
          (finding === undefined ? 'not supplied' : JSON.stringify(finding, null, 2)) +
          `\nDeveloper response: ` +
          (response === undefined ? 'not supplied' : JSON.stringify(response, null, 2)),
      );
    }),
  ];
}

/** The report shape, finding definitions and identity, disposition and verdict rules. */
const responseInstructions = `Return exactly one JSON object with this shape, and nothing else:
{"verdict":"approved"|"changesRequested"|"inconclusive","summary":"<what was reviewed, the inspected scope and why this verdict>","findings":[{"id":"<task-stable finding ID>","title":"<short title>","severity":"blocking"|"non-blocking","basis":"<the requirement or expected behavior that is violated>","evidence":"<the observed or reproducible failure, related occurrences inspected and material uncertainty>","impact":"<the consequence>","repairGuidance":"<the required correction>","locations":[{"path":"<file>","line":<line or null>}]}],"priorFindings":[{"findingId":"<eligible prior finding ID>","disposition":"resolved"|"open"|"withdrawn","reason":"<the current implementation and developer response that support the disposition>"}]}
Finding IDs are unique within the task and stable across rounds: reuse an ID for an existing defect, including additional occurrences of the same cause, and give a genuinely different defect a new ID. findings contains every finding still present in the reviewed revision, including retained open findings and newly discovered ones, and no resolved or withdrawn finding. Include exactly one priorFindings entry for every eligible prior finding ID and none for any other ID; an empty eligible set requires an empty priorFindings array. Earlier reports are historical evidence for identity and recurrence, not additional disposition requests: a defect shown to recur may return in findings under its stable ID without a disposition outside the eligible set. An open disposition requires the finding in findings. locations may be empty when there is no useful code location; a location's line refers to the reviewed revision, and states null when the location has no line.
Apply the verdict rules: approved requires sufficient evidence and no current blocking findings; changesRequested requires at least one current blocking finding with a concrete basis, evidence and impact; inconclusive means material evidence is unavailable, and the summary explains what is missing.`;

/** Create Review over the selected workspace, reviewer runtime, publication and adapters. */
export function createReview(settings: ReviewSettings): BoundAction {
  const memory = memoryContextOf(settings.memory);

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

    /** Observe one saved review report, whether it was just produced or reused. */
    async function observe(
      review: ReviewOutput,
      priorFindings: readonly Finding[],
      responses: readonly FindingResponse[],
      priorReviewArtifact: string | null,
    ): Promise<void> {
      const observations = reviewObservations({
        root,
        memory,
        taskKey: selection.taskKey,
        subject: issueSummary(selection.task) ?? selection.taskKey,
        round: round.number,
        review,
        priorFindings,
        responses,
        priorReviewArtifact,
        developmentArtifact: roundArtifactPath(
          root,
          round.number,
          devArtifact.pathFromArtifactsRoot,
        ),
      });
      for (const observation of observations) {
        await rememberObserved(
          { memory: memory.memory, publish: settings.publish, source: 'review' },
          observation,
        );
      }
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
      // Reuse re-observes the same source keys; an accepted report becomes a note even when the
      // first attempt's ingestion did not complete.
      const reusedPrior = latest(await helpers.readArtifactHistory(reviewArtifact));
      await observe(
        recorded,
        reusedPrior?.value.findings ?? [],
        development.findingResponses,
        reusedPrior === null
          ? null
          : roundArtifactPath(root, reusedPrior.number, reviewArtifact.pathFromArtifactsRoot),
      );
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

    const scope = {
      project: memory.project,
      workflow: memory.workflow,
      role: 'reviewer',
    };
    const unresolved = priorFindings
      .map((finding) => ({
        finding,
        response:
          development.findingResponses.find((candidate) => candidate.findingId === finding.id) ??
          null,
      }))
      .filter((entry) => entry.response === null || entry.response.status !== 'addressed');
    const recall = await recallForInvocation({
      memory: memory.memory,
      evidenceDirectory: memory.evidenceDirectory,
      publish: settings.publish,
      source: 'review',
      scope,
      query: retrievalQuery(scope, [
        ...issueQueryMaterial(issue),
        `development summary: ${development.summary}`,
        ...(unresolved.length === 0 ? [] : [`unresolved findings: ${JSON.stringify(unresolved)}`]),
      ]),
    });
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
      dispositionInput(priorReview?.number ?? null, priorFindings, development.findingResponses),
      historySection(root, reviews, developments),
      ...(recall.block === null ? [] : [recall.block]),
      responseInstructions,
    ].join('\n\n');

    const result: AgentResult = await settings.runner.run({
      operation: 'Review',
      profile: settings.reviewerProfile,
      workspace: { root },
      context,
      outputSchema: z.toJSONSchema(reviewResponseSchema),
      invocationId: recall.invocationId,
      task: selection.taskKey,
      summary: issueSummary(issue),
    });
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
      // The response carries every location's line, reporting null when it has none; the saved
      // Finding omits the line instead.
      findings: response.findings.map(toFinding),
    };
    await helpers.writeOutputArtifact(reviewArtifact, review);
    await observe(
      review,
      priorFindings,
      development.findingResponses,
      priorReview === null
        ? null
        : roundArtifactPath(root, priorReview.number, reviewArtifact.pathFromArtifactsRoot),
    );
    await publishReport(review, conversation.value, comments);
    report(review);
    return review.verdict;
  };
}
