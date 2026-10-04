import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import {
  reviewEncoding,
  type GitHubAdapter,
  type PullRequest,
} from '../../../../adapters/github.js';
import type { JiraAdapter } from '../../../../adapters/jira.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import {
  preparationStages,
  stagePlanArtifact,
  stageResultArtifact,
  type PlannedTask,
  type PreparationResult,
  type PreparationStage,
} from '../../preparation/artifacts.js';
import {
  readStageArtifact,
  readStagePlan,
  stageRoot,
  stageWorktree,
} from '../../preparation/storage.js';
import {
  applyTransition,
  publishDocument,
  readComments,
  readIssue,
  statusNameOf,
  transitionInto,
} from '../../source.js';
import type { HandoffTicket, ParentHandoff } from '../../select-work/artifacts.js';
import { readHandoff, readSelection, writeHandoff } from '../state.js';

/**
 * HandoffImplementation is the parent-owned Architecture handoff: it assembles the accepted changed
 * authoritative documents of every preparation stage, publishes exactly that document set in a
 * documentation-only pull request, drives the repository's review/check gates and native
 * auto-merge, confirms the merged revision and its configured checks, then creates the linked
 * implementation tickets, ranks prerequisites before their dependents, retains every created
 * identity and closes the original issue with the links. A skip without changed documents creates
 * no empty pull request. An uncertain creation is reconciled against its source-side identity
 * before anything is retried, and a retained ticket finishes each missing effect before the
 * handoff treats it as handed off.
 */

export type ImplementationHandoffSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The Jira project the implementation tickets belong to; reconciliation is project-scoped. */
  readonly project: string;
  /** The delivery repository identity and base branch the documents merge into. */
  readonly repository: string;
  readonly baseBranch: string;
  /** The configured review check the repository requires for the published revision. */
  readonly reviewCheck: string;
  /** The Nexus Lens App identity that authors the review and owns the review check. */
  readonly nexusLens: { readonly appId: number; readonly login: string };
  /** The configured post-merge checks and the workflows that produce them. */
  readonly postMergeChecks: readonly { readonly name: string; readonly workflow: string }[];
  /**
   * The configured status the Architecture selection left the original in. A publication may only
   * close that retained status (or repeat an already-applied Done); any other state is an
   * unexpected human change the handoff preserves.
   */
  readonly architectureStatus: string | null;
  /** The configured implementation-ticket creation and linking settings. */
  readonly implementation: {
    readonly issueType: string;
    readonly labels: readonly string[];
    readonly status: string;
    readonly linkType: string;
  };
  /** The configured completed status the original issue reaches after the handoff. */
  readonly doneStatus: string;
  /** The configured merge/check wait bounds. */
  readonly completion: {
    readonly pollIntervalSeconds: number;
    readonly waitLimitSeconds: number;
  };
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
  readonly wait: (milliseconds: number) => Promise<void>;
};

/** One accepted authoritative document, relative to its repository and the stage that authored it. */
type AcceptedDocument = {
  /** The document's path relative to the repository root, as publication and tickets name it. */
  readonly path: string;
  /** The stage worktree file the accepted revision lives in. */
  readonly source: string;
  /** The producer's exact revision of the changed document, when it observed one. */
  readonly revision: string | null;
  /** The stage whose evaluated result accepted this revision. */
  readonly stage: PreparationStage;
};

/** The references every implementation ticket carries so a new workspace can find its inputs. */
type TicketReferences = {
  readonly sourceKey: string;
  readonly plannedTask: string;
  readonly documents: readonly AcceptedDocument[];
  readonly mergeRevision: string | null;
  readonly prototype: PreparationResult['prototype'];
};

/** The conclusions of a completed required check that satisfy a repository merge rule. */
const satisfiedConclusions: ReadonlySet<string> = new Set(['success', 'skipped', 'neutral']);

/** One Jira JQL string literal. */
function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One Jira document whose paragraphs are the supplied text's lines. */
function documentOf(text: string): Readonly<Record<string, unknown>> {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split('\n')
      .map((line) =>
        line.trim() === ''
          ? { type: 'paragraph' }
          : { type: 'paragraph', content: [{ type: 'text', text: line }] },
      ),
  };
}

/** The source-side identity label one planned task's created ticket carries for reconciliation. */
function plannedTaskLabel(taskKey: string, index: number): string {
  return `nexus-source-${taskKey}-${String(index + 1)}`;
}

/** The implementation ticket description one planned task produces, with its reusable references. */
function ticketDescription(
  task: PlannedTask,
  prerequisites: readonly string[],
  references: TicketReferences,
): string {
  return [
    task.summary,
    '',
    `Source: ${references.sourceKey} (planned task ${references.plannedTask}).`,
    '',
    `Scope: ${task.scope}`,
    '',
    'Completion criteria:',
    ...task.completionCriteria.map((criterion) => `- ${criterion}`),
    ...(prerequisites.length === 0 ? [] : ['', `Prerequisites: ${prerequisites.join(', ')}`]),
    '',
    'Preparation references:',
    ...(references.documents.length === 0
      ? [
          '- Accepted existing authoritative documents satisfy the design; the evaluated result ' +
            'and its references are retained with the source issue.',
        ]
      : references.documents.map(
          (document) =>
            `- ${document.path} (${document.stage} revision ` +
            `${document.revision ?? 'unrecorded'})`,
        )),
    ...(references.mergeRevision === null
      ? []
      : [`- Documentation merge revision: ${references.mergeRevision}`]),
    ...(references.prototype === null
      ? []
      : [
          `- Retained prototype: branch ${references.prototype.branch}, ` +
            `revision ${references.prototype.revision}`,
        ]),
  ].join('\n');
}

/** One observation of the documentation pull request's merge state. */
type MergeObservation =
  | {
      readonly kind: 'merged';
      readonly mergeRevision: string;
      readonly pullRequest: PullRequest;
    }
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly reason: string };

/** Create the parent-owned Architecture handoff. */
export function createImplementationHandoff(settings: ImplementationHandoffSettings): BoundAction {
  return async () => {
    const selection = await readSelection(settings.selectionFile);
    const root = selection.workspace.root;
    const worktree = stageWorktree(root, 'architecture');
    const architectureRoot = stageRoot(root, 'architecture');
    const plan = await readStagePlan(architectureRoot);
    if (plan === null) {
      throw new Error(`No architecture round plan exists under "${architectureRoot}" to hand off.`);
    }
    const result = await readStageArtifact(architectureRoot, plan.round, stageResultArtifact);
    if (result === null) {
      throw new Error(`No architecture result exists under "${architectureRoot}" to hand off.`);
    }
    if (result.outcome !== 'accepted' && result.outcome !== 'skipped') {
      throw new Error(
        `The architecture result is "${result.outcome}"; only an accepted or skipped result hands ` +
          'off.',
      );
    }
    const tasks = (await readStageArtifact(architectureRoot, plan.round, stagePlanArtifact)) ?? [];
    if (tasks.length === 0) {
      throw new Error('The architecture result carries no implementation plan to hand off.');
    }
    const retained = await readHandoff(root);
    const handoff: ParentHandoff = retained ?? {
      stage: 'architecture',
      upstreamReturns: 0,
      feedback: null,
      return: null,
      tickets: [],
      publications: [],
    };

    /** Report a condition that prevents the handoff. */
    async function failed(reason: string): Promise<'failed'> {
      settings.publish({ source: 'implementation-handoff', type: 'failed', data: { reason } });
      return 'failed';
    }

    /**
     * The accepted changed authoritative documents of every preparation stage, reconciled by
     * repository path: when a later stage accepted a change to a path an earlier stage also
     * changed, the later accepted revision is the one in force. Only the evaluated document set is
     * assembled; the implementation plan, prototype code and any unrelated worktree change stay
     * out of the publication.
     */
    async function acceptedDocuments(): Promise<
      | { readonly kind: 'documents'; readonly documents: AcceptedDocument[] }
      | { readonly kind: 'invalid'; readonly reason: string }
    > {
      const byPath = new Map<string, AcceptedDocument>();
      for (const stage of preparationStages) {
        const areaRoot = stageRoot(root, stage);
        const stagePlan = await readStagePlan(areaRoot);
        if (stagePlan === null) {
          continue;
        }
        const stageResult = await readStageArtifact(areaRoot, stagePlan.round, stageResultArtifact);
        if (stageResult === null || stageResult.outcome !== 'accepted') {
          continue;
        }
        const tree = stageWorktree(root, stage);
        for (const document of stageResult.documents) {
          const relative = path.relative(tree, document.path);
          if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
            return {
              kind: 'invalid',
              reason:
                `The accepted ${stage} document "${document.path}" lies outside the stage ` +
                `worktree "${tree}"; the handoff cannot publish it.`,
            };
          }
          byPath.set(relative, {
            path: relative,
            source: document.path,
            revision: document.revision,
            stage,
          });
        }
      }
      return {
        kind: 'documents',
        documents: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
      };
    }

    /** The retained prototype reference the Storybook Refinement result recorded, when one exists. */
    async function retainedPrototype(): Promise<PreparationResult['prototype']> {
      const areaRoot = stageRoot(root, 'prototype');
      const stagePlan = await readStagePlan(areaRoot);
      if (stagePlan === null) {
        return null;
      }
      const stageResult = await readStageArtifact(areaRoot, stagePlan.round, stageResultArtifact);
      return stageResult?.prototype ?? null;
    }

    const accepted = await acceptedDocuments();
    if (accepted.kind === 'invalid') {
      return failed(accepted.reason);
    }
    // Publish the changed authoritative documents as a documentation-only pull request. A stage
    // that concluded existing documents suffice names no changed document and creates no empty PR.
    let mergeRevision: string | null = null;
    if (accepted.documents.length > 0) {
      const publication = await publishDocuments(accepted.documents);
      if (publication.kind === 'failed') {
        return failed(publication.reason);
      }
      mergeRevision = publication.mergeRevision;
    }
    const prototype = await retainedPrototype();

    // Create the implementation tickets in plan order, reconciling any retained identity or
    // uncertain creation with the planned task before anything is retried, and finishing every
    // missing effect of a retained ticket.
    const tickets: HandoffTicket[] = [...handoff.tickets];
    for (const [index, task] of tasks.entries()) {
      const retainedTicket = tickets[index];
      if (retainedTicket !== undefined && retainedTicket.summary !== task.summary) {
        return failed(
          `The retained implementation ticket ${retainedTicket.key} is ` +
            `"${retainedTicket.summary}" while planned task ${String(index + 1)} is ` +
            `"${task.summary}"; the handoff cannot reconcile them.`,
        );
      }
      let ticket = retainedTicket;
      if (ticket === undefined) {
        // An interrupted create may have succeeded without its response reaching Nexus. Its
        // source-side identity is searched before another create request is sent.
        const reconciled = await reconcilePlannedTask(task, index);
        if (reconciled.kind === 'failed') {
          return failed(reconciled.reason);
        }
        if (reconciled.kind === 'found') {
          ticket = reconciled.ticket;
          tickets[index] = ticket;
          // Retain the reconciled identity before any dependent operation.
          await writeHandoff(root, { ...handoff, tickets, publications: handoff.publications });
        }
      }
      const prerequisites = task.prerequisites.flatMap((prerequisite) => {
        const prerequisiteTicket = tickets[prerequisite];
        return prerequisiteTicket === undefined ? [] : [prerequisiteTicket.key];
      });
      if (ticket === undefined) {
        const created = await settings.jira.createIssue({
          issuetype: { name: settings.implementation.issueType },
          summary: task.summary,
          description: documentOf(
            ticketDescription(task, prerequisites, {
              sourceKey: selection.taskKey,
              plannedTask: `${String(index + 1)} of ${String(tasks.length)}`,
              documents: accepted.documents,
              mergeRevision,
              prototype,
            }),
          ),
          labels: [...settings.implementation.labels, plannedTaskLabel(selection.taskKey, index)],
        });
        if (!created.ok) {
          return failed(created.fault.message);
        }
        ticket = {
          key: created.value.key,
          issueId: created.value.id,
          summary: task.summary,
          linked: false,
          ranked: false,
        };
        // Retain the identity before any dependent operation, so an interruption reuses it.
        tickets[index] = ticket;
        await writeHandoff(root, { ...handoff, tickets, publications: handoff.publications });
      }

      if (ticket.linked !== true) {
        const linked = await settings.jira.linkIssues(
          ticket.issueId,
          selection.source.issueId,
          settings.implementation.linkType,
        );
        if (!linked.ok) {
          return failed(linked.fault.message);
        }
        ticket = { ...ticket, linked: true };
        tickets[index] = ticket;
        await writeHandoff(root, { ...handoff, tickets, publications: handoff.publications });
      }
      if (prerequisites.length > 0 && ticket.ranked !== true) {
        const ranked = await settings.jira.rankIssue(ticket.issueId, {
          after: prerequisites.at(-1) as string,
        });
        if (!ranked.ok) {
          return failed(ranked.fault.message);
        }
        ticket = { ...ticket, ranked: true };
        tickets[index] = ticket;
        await writeHandoff(root, { ...handoff, tickets, publications: handoff.publications });
      }
      // The created ticket competes in the configured ready queue; an already-ready ticket is a
      // repeated effect and is not moved again.
      const issue = await readIssue(settings.jira, ticket.issueId);
      if (statusNameOf(issue) !== settings.implementation.status) {
        const transition = await transitionInto(
          settings.jira,
          issue,
          settings.implementation.status,
        );
        if (transition.kind === 'blocked') {
          return failed(transition.reason);
        }
        await applyTransition(settings.jira, issue.id, transition.transition);
      }
    }

    // Close the original with the completed handoff and every implementation link. Only the status
    // the Architecture selection left behind (or a repeated Done) may be closed: an unexpected
    // human pause or reroute is preserved instead of overwritten.
    const source = await readIssue(settings.jira, selection.source.issueId);
    const sourceStatus = statusNameOf(source);
    const allowed = [
      ...(settings.architectureStatus === null ? [] : [settings.architectureStatus]),
      settings.doneStatus,
    ];
    if (
      sourceStatus !== settings.doneStatus &&
      (sourceStatus === null || !allowed.includes(sourceStatus))
    ) {
      return failed(
        `Issue ${selection.taskKey} is in status "${sourceStatus ?? 'unknown'}" while the ` +
          `implementation handoff expected one of ` +
          `${allowed.map((value) => `"${value}"`).join(', ')}; an unexpected human change is ` +
          'preserved instead of closed.',
      );
    }
    const linkList = tickets.map((ticket) => `${ticket.key}: ${ticket.summary}`).join('\n');
    const comment = [
      'Preparation complete. Implementation tickets:',
      ...tickets.map((ticket) => `- ${ticket.key}: ${ticket.summary}`),
      ...(handoff.publications.some((publication) => publication.kind === 'documentation-pr')
        ? [
            '',
            `Documentation PR: ${
              handoff.publications.find((publication) => publication.kind === 'documentation-pr')
                ?.id ?? ''
            }`,
          ]
        : []),
    ].join('\n');
    await publishDocument(
      settings.jira,
      selection.source.issueId,
      await readComments(settings.jira, selection.source.issueId),
      documentOf(comment),
    );
    if (sourceStatus !== settings.doneStatus) {
      const transition = await transitionInto(settings.jira, source, settings.doneStatus);
      if (transition.kind === 'blocked') {
        return failed(transition.reason);
      }
      await applyTransition(settings.jira, source.id, transition.transition);
    }
    await writeHandoff(root, { ...handoff, tickets, publications: handoff.publications });
    settings.publish({
      source: 'implementation-handoff',
      type: 'handed-off',
      data: {
        task: selection.taskKey,
        tickets: tickets.map((ticket) => ticket.key),
        links: linkList,
      },
    });
    return 'handed-off';

    /** One uncertain creation's reconciliation against the planned task's source-side identity. */
    async function reconcilePlannedTask(
      task: PlannedTask,
      index: number,
    ): Promise<
      | { readonly kind: 'found'; readonly ticket: HandoffTicket }
      | { readonly kind: 'none' }
      | { readonly kind: 'failed'; readonly reason: string }
    > {
      const query =
        `project = ${settings.project} AND summary = ${jqlString(task.summary)} AND ` +
        `labels = ${jqlString(plannedTaskLabel(selection.taskKey, index))}`;
      const found = await settings.jira.searchIssues({ query, orderBy: 'Rank ASC' });
      if (!found.ok) {
        throw new Error(found.fault.message);
      }
      if (found.value.length > 1) {
        return {
          kind: 'failed',
          reason:
            `${String(found.value.length)} issues match planned task ${String(index + 1)} ` +
            `"${task.summary}"; the handoff cannot choose the retained creation.`,
        };
      }
      const identity = found.value[0];
      if (identity === undefined) {
        return { kind: 'none' };
      }
      return {
        kind: 'found',
        ticket: {
          key: identity.key,
          issueId: identity.id,
          summary: task.summary,
          linked: false,
          ranked: false,
        },
      };
    }

    /**
     * Publish the accepted documents: assemble them into the architecture worktree, commit exactly
     * the named paths, push the area branch, reuse or open the documentation-only pull request and
     * confirm its merge with the configured checks.
     */
    async function publishDocuments(
      documents: readonly AcceptedDocument[],
    ): Promise<
      | { readonly kind: 'merged'; readonly mergeRevision: string }
      | { readonly kind: 'failed'; readonly reason: string }
    > {
      const inspection = await settings.git.inspectRepository(worktree);
      if (!inspection.ok) {
        return { kind: 'failed', reason: inspection.fault.message };
      }
      const branch = inspection.value.branch;
      if (branch === null) {
        return { kind: 'failed', reason: 'The architecture worktree has no branch to publish.' };
      }
      if (branch === settings.baseBranch) {
        return {
          kind: 'failed',
          reason:
            `The architecture worktree is on the configured base branch "${settings.baseBranch}"; ` +
            'preparation documents are never published from the base branch.',
        };
      }
      // Assemble the accepted revisions in the publication worktree: each later stage's accepted
      // revision of a path supersedes the earlier one, and each document keeps its repository
      // path. Unrelated worktree changes stay where they are.
      for (const document of documents) {
        const target = path.join(worktree, document.path);
        if (target === document.source) {
          continue;
        }
        await mkdir(path.dirname(target), { recursive: true });
        try {
          await copyFile(document.source, target);
        } catch (error) {
          return {
            kind: 'failed',
            reason:
              `The accepted ${document.stage} document "${document.path}" could not be assembled ` +
              `for publication: ${error instanceof Error ? error.message : String(error)}.`,
          };
        }
      }
      // Only the accepted document paths are staged, so the publication commits no unrelated work.
      const committed = await settings.git.commitPaths(
        worktree,
        documents.map((document) => document.path),
        `Publish preparation documents for ${selection.taskKey}`,
      );
      if (!committed.ok) {
        return { kind: 'failed', reason: committed.fault.message };
      }
      const head = committed.value.headRevision;
      if (head === null) {
        return { kind: 'failed', reason: 'The architecture worktree has no revision to publish.' };
      }
      const pushed = await settings.git.pushBranch(worktree, branch, head);
      if (!pushed.ok) {
        return { kind: 'failed', reason: pushed.fault.message };
      }
      const pullRequest = await ensurePullRequest(documents, branch, head);
      if (pullRequest.kind === 'failed') {
        return pullRequest;
      }
      handoff.publications = [
        ...handoff.publications.filter((publication) => publication.kind !== 'documentation-pr'),
        { kind: 'documentation-pr', id: pullRequest.url },
      ];
      await writeHandoff(root, handoff);
      return { kind: 'merged', mergeRevision: pullRequest.mergeRevision };
    }

    /**
     * Reuse or open the documentation pull request for the pushed revision, publish the missing
     * review and review check the repository's merge rules require for that exact revision, request
     * native auto-merge for it and confirm its merge and configured checks.
     */
    async function ensurePullRequest(
      documents: readonly AcceptedDocument[],
      branch: string,
      head: string,
    ): Promise<
      | { readonly kind: 'merged'; readonly url: string; readonly mergeRevision: string }
      | { readonly kind: 'failed'; readonly reason: string }
    > {
      const found = await settings.github.findPullRequests(settings.repository, {
        branch,
        baseBranch: settings.baseBranch,
      });
      if (!found.ok) {
        return { kind: 'failed', reason: found.fault.message };
      }
      let pullRequestNumber = found.value[0]?.number ?? null;
      if (pullRequestNumber !== null) {
        const observed = await settings.github.readPullRequest(
          settings.repository,
          pullRequestNumber,
        );
        if (!observed.ok) {
          return { kind: 'failed', reason: observed.fault.message };
        }
        if (observed.value.state === 'closed' && !observed.value.merged) {
          return {
            kind: 'failed',
            reason:
              `The documentation pull request #${String(pullRequestNumber)} was closed without ` +
              'merging; the retained human decision is preserved.',
          };
        }
        if (observed.value.merged && observed.value.headRevision !== head) {
          // The branch carries accepted work the merged publication did not contain; a new
          // documentation pull request is the next publication of that work.
          pullRequestNumber = null;
        }
      }
      if (pullRequestNumber === null) {
        const created = await settings.github.createPullRequest(settings.repository, {
          baseBranch: settings.baseBranch,
          headBranch: branch,
          title: `${selection.taskKey}: preparation documents`,
          body: [
            `Accepted authoritative documents for ${selection.taskKey}.`,
            '',
            ...documents.map((document) => `- ${document.path} (${document.stage})`),
          ].join('\n'),
        });
        if (!created.ok) {
          return { kind: 'failed', reason: created.fault.message };
        }
        pullRequestNumber = created.value.number;
      }
      const prepared = await drivePublication(pullRequestNumber, head, documents);
      if (prepared.kind === 'failed') {
        return prepared;
      }
      return {
        kind: 'merged',
        url: prepared.pullRequest.url,
        mergeRevision: prepared.mergeRevision,
      };
    }

    /**
     * Drive one documentation pull request to merge for the published revision: publish the
     * missing Nexus Lens review and review check, request native auto-merge when it is not enabled,
     * then wait for the merge and its required pre-merge and post-merge checks.
     */
    async function drivePublication(
      pullRequestNumber: number,
      head: string,
      documents: readonly AcceptedDocument[],
    ): Promise<
      | {
          readonly kind: 'merged';
          readonly pullRequest: PullRequest;
          readonly mergeRevision: string;
        }
      | { readonly kind: 'failed'; readonly reason: string }
    > {
      const body =
        `Accepted preparation documents for ${selection.taskKey}: ` +
        `${documents.map((document) => document.path).join(', ')}.`;
      const conversation = await settings.github.readConversation(
        settings.repository,
        pullRequestNumber,
      );
      if (!conversation.ok) {
        return { kind: 'failed', reason: conversation.fault.message };
      }
      const reviewPublished = conversation.value.reviews.some(
        (review) =>
          review.author === settings.nexusLens.login &&
          review.commit_id === head &&
          review.state === reviewEncoding.approved.state,
      );
      if (!reviewPublished) {
        const published = await settings.github.publishReview(settings.repository, {
          pullRequestNumber,
          revision: head,
          verdict: 'approved',
          body,
        });
        if (!published.ok) {
          return { kind: 'failed', reason: published.fault.message };
        }
      }
      const checks = await settings.github.readChecks(settings.repository, head);
      if (!checks.ok) {
        return { kind: 'failed', reason: checks.fault.message };
      }
      const checkPublished = checks.value.some(
        (check) =>
          check.revision === head &&
          check.name === settings.reviewCheck &&
          check.producer?.id === settings.nexusLens.appId &&
          check.status === 'completed' &&
          check.conclusion === 'success',
      );
      if (!checkPublished) {
        const published = await settings.github.publishReviewCheck(settings.repository, {
          revision: head,
          name: settings.reviewCheck,
          result: 'success',
        });
        if (!published.ok) {
          return { kind: 'failed', reason: published.fault.message };
        }
      }
      const deadline = Date.now() + settings.completion.waitLimitSeconds * 1000;
      const initial = await settings.github.readPullRequest(settings.repository, pullRequestNumber);
      if (!initial.ok) {
        return { kind: 'failed', reason: initial.fault.message };
      }
      if (!initial.value.merged && !initial.value.autoMergeEnabled) {
        const requested = await settings.github.requestAutoMerge(
          settings.repository,
          pullRequestNumber,
          head,
        );
        if (!requested.ok) {
          return { kind: 'failed', reason: requested.fault.message };
        }
      }
      for (;;) {
        const observed = await observeMerged(pullRequestNumber, head);
        if (observed.kind === 'failed') {
          return observed;
        }
        if (observed.kind === 'merged') {
          const postMerge = await waitForPostMergeChecks(observed.mergeRevision, deadline);
          if (postMerge.kind === 'failed') {
            return postMerge;
          }
          return {
            kind: 'merged',
            pullRequest: observed.pullRequest,
            mergeRevision: observed.mergeRevision,
          };
        }
        if (Date.now() >= deadline) {
          return {
            kind: 'failed',
            reason:
              `The documentation pull request #${String(pullRequestNumber)} did not merge with ` +
              `passing checks within ${String(settings.completion.waitLimitSeconds)} seconds.`,
          };
        }
        await settings.wait(Math.max(1, settings.completion.pollIntervalSeconds) * 1000);
      }
    }

    /**
     * Observe the published revision's merge. The provider must report the exact published head and
     * its required pre-merge checks at that revision; a merged pull request whose evidence belongs
     * to another revision cannot confirm the publication.
     */
    async function observeMerged(
      pullRequestNumber: number,
      head: string,
    ): Promise<MergeObservation> {
      const observed = await settings.github.readPullRequest(
        settings.repository,
        pullRequestNumber,
      );
      if (!observed.ok) {
        return { kind: 'failed', reason: observed.fault.message };
      }
      if (observed.value.state === 'closed' && !observed.value.merged) {
        return {
          kind: 'failed',
          reason: `The documentation pull request #${String(pullRequestNumber)} closed without merging.`,
        };
      }
      if (!observed.value.merged) {
        return { kind: 'pending' };
      }
      if (observed.value.headRevision !== head) {
        return {
          kind: 'failed',
          reason:
            `The documentation pull request #${String(pullRequestNumber)} merged revision ` +
            `${observed.value.headRevision} instead of the published ${head}; the merge evidence ` +
            'belongs to another publication.',
        };
      }
      const required = await settings.github.readRequiredChecks(
        settings.repository,
        pullRequestNumber,
      );
      if (!required.ok) {
        return { kind: 'failed', reason: required.fault.message };
      }
      if (required.value.revision !== head) {
        return {
          kind: 'failed',
          reason:
            `The required checks were observed for revision ${required.value.revision} instead of ` +
            `the published ${head}; the merge evidence belongs to another publication.`,
        };
      }
      const failures: string[] = [];
      let pending = 0;
      for (const check of required.value.checks) {
        if (check.status !== 'completed' || check.conclusion === null) {
          pending += 1;
          continue;
        }
        if (!satisfiedConclusions.has(check.conclusion)) {
          failures.push(
            `required check "${check.name}" concluded "${check.conclusion}"` +
              (check.evidenceUrl === null ? '' : ` (evidence: ${check.evidenceUrl})`),
          );
        }
      }
      if (failures.length > 0) {
        return {
          kind: 'failed',
          reason:
            `The documentation pull request #${String(pullRequestNumber)} merged with failed ` +
            `required checks for revision ${head}: ${failures.join('; ')}.`,
        };
      }
      if (observed.value.mergeRevision === null) {
        return {
          kind: 'failed',
          reason: `The documentation pull request #${String(pullRequestNumber)} reports no merge revision.`,
        };
      }
      if (pending > 0) {
        // Required checks that have not reported yet keep the configured wait; the merge is not
        // confirmed until they pass for the published revision.
        return { kind: 'pending' };
      }
      return {
        kind: 'merged',
        mergeRevision: observed.value.mergeRevision,
        pullRequest: observed.value,
      };
    }

    /** Observe every configured post-merge check for the merge revision within one deadline. */
    async function waitForPostMergeChecks(
      mergeRevision: string,
      deadline: number,
    ): Promise<{ readonly kind: 'passed' } | { readonly kind: 'failed'; readonly reason: string }> {
      for (;;) {
        const runs = await settings.github.readWorkflowRuns(
          settings.repository,
          mergeRevision,
          settings.postMergeChecks.map((check) => check.workflow),
        );
        if (!runs.ok) {
          return { kind: 'failed', reason: runs.fault.message };
        }
        const problems: string[] = [];
        const pending: string[] = [];
        for (const check of settings.postMergeChecks) {
          const matching = runs.value.filter(
            (run) =>
              run.revision === mergeRevision &&
              (run.name === check.workflow || run.path === check.workflow),
          );
          if (matching.length === 0) {
            pending.push(`"${check.name}" has no run for revision ${mergeRevision}`);
            continue;
          }
          const incomplete = matching.find(
            (run) => run.status !== 'completed' || run.conclusion === null,
          );
          if (incomplete !== undefined) {
            pending.push(`"${check.name}" is "${incomplete.status ?? 'pending'}"`);
            continue;
          }
          const unsuccessful = matching.find((run) => run.conclusion !== 'success');
          if (unsuccessful !== undefined) {
            problems.push(
              `post-merge check "${check.name}" concluded "${unsuccessful.conclusion}" for ` +
                `revision ${mergeRevision}`,
            );
          }
        }
        if (problems.length > 0) {
          return { kind: 'failed', reason: `${problems.join('; ')}.` };
        }
        if (pending.length === 0) {
          return { kind: 'passed' };
        }
        if (Date.now() >= deadline) {
          return {
            kind: 'failed',
            reason:
              `${pending.join('; ')} past the configured completion wait of ` +
              `${String(settings.completion.waitLimitSeconds)} seconds.`,
          };
        }
        await settings.wait(Math.max(1, settings.completion.pollIntervalSeconds) * 1000);
      }
    }
  };
}
