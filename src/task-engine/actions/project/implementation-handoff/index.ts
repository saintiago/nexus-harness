import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../../adapters/git.js';
import type {
  JiraAdapter,
  JiraIssue,
  JiraIssueIdentity,
  JiraIssueQuery,
} from '../../../../adapters/jira.js';
import { messageOf, ok, type Result } from '../../../../result.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import {
  preparationStages,
  stagePlanArtifact,
  stageResultArtifact,
  type PlannedTask,
  type PreparationResult,
  type PreparationWorkspace,
} from '../../preparation/artifacts.js';
import {
  readAcceptedDocuments,
  type AcceptedDocument,
} from '../../preparation/accepted-content.js';
import { recordIdentity } from '../../preparation/evaluation-content.js';
import {
  preparationWorktree,
  readCurrentDecision,
  readPreparationWorkspace,
  readStageArtifact,
  readStagePlan,
  roundArtifactFile,
  stageRoot,
} from '../../preparation/storage.js';
import {
  applyTransition,
  publishDocument,
  readComments,
  readIssue,
  statusNameOf,
  transitionInto,
  updateIssueFields,
} from '../../source.js';
import type { HandoffBasis, HandoffTicket, ParentHandoff } from '../../select-work/artifacts.js';
import { readRecord, writeRecord } from '../../records.js';
import { retainTerminalReason } from '../../terminal-reason.js';
import {
  implementationHandoffFailureDeclaration,
  implementationHandoffResultDeclaration,
  implementationInputDeclaration,
  legacyDocumentationReviewsDirectory,
  plannedTaskIdentityLabelPrefix,
  type ImplementationInput,
} from './artifacts.js';
import { readHandoff, readSelection, writeHandoff } from '../state.js';

/**
 * HandoffImplementation is the parent-owned Architecture handoff. After an evaluated Architecture
 * result and its implementation plan, it freezes the accepted plan identity and the retained
 * preparation revision, creates one linked implementation ticket per planned task in stable
 * topological order, writes each ticket's implementation input, ranks every planned ticket ahead
 * of the remaining preparation queue with prerequisites before their dependents, admits the
 * tickets to the configured ready status and closes the original with a preparation-handoff
 * comment. Every creation, link, input, rank and admission acknowledgement is retained so an
 * interrupted or uncertain effect is reconciled without duplicates, and unexpected human status
 * changes are preserved. There is no documentation assembly, documentation-only pull request or
 * preparation publication gate; a retained preparation-only publication from the removed workflow
 * requests explicit reconciliation before any ticket effect.
 */

export type ImplementationHandoffSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The Jira project the implementation tickets belong to; reconciliation is project-scoped. */
  readonly project: string;
  /** The stable workspace root the implementation issues' own workspaces live under. */
  readonly workspaceRoot: string;
  /** The configured Jira field that retains an issue's workspace root. */
  readonly workspacePointerField: string;
  /** The configured ranked task candidate query the parent selects implementation from. */
  readonly selection: JiraIssueQuery;
  /** The separate idea candidate query, applied to the same project connection. */
  readonly ideas: JiraIssueQuery;
  /**
   * The configured idea statuses. Submitted and active ideas refine, and the approved-idea
   * admission continues preparation whenever the stage mappings exist; a Waiting for Feedback
   * item never anchors the ranking.
   */
  readonly ideaStatuses: {
    readonly submitted: string;
    readonly active: string;
    readonly approved: string;
    readonly waitingForFeedback: string;
  };
  /**
   * The configured preparation stage mappings; absent for a delivery-only project. The
   * Architecture mapping is also the status the Architecture selection left the original in: the
   * handoff may only close that retained status (or repeat an already-applied Done); any other
   * state is an unexpected human change the handoff preserves.
   */
  readonly preparation:
    | {
        readonly statuses: {
          readonly requirements: string;
          readonly uxProposal: string;
          readonly storybookRefinement: string;
          readonly architecture: string;
        };
      }
    | undefined;
  /** The configured implementation-ticket creation, linking and admission settings. */
  readonly implementation: {
    readonly issueType: string;
    readonly labels: readonly string[];
    readonly status: string;
    readonly linkType: string;
  };
  /** The configured completed status the original issue reaches after the handoff. */
  readonly doneStatus: string;
  readonly git: GitAdapter;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
};

/** The reusable accepted references every implementation ticket carries in its description. */
type TicketReferences = {
  readonly sourceKey: string;
  readonly plannedTask: string;
  readonly documents: readonly AcceptedDocument[];
  readonly existing: readonly string[];
  readonly prototype: PreparationResult['prototype'];
};

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
  return `${plannedTaskIdentityLabelPrefix}${taskKey}-${String(index + 1)}`;
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
    ...references.existing,
    ...references.documents.map(
      (document) =>
        `- ${document.path} (${document.stage} revision ` + `${document.revision ?? 'unrecorded'})`,
    ),
    ...(references.prototype === null
      ? []
      : [
          `- Retained prototype: branch ${references.prototype.branch}, ` +
            `revision ${references.prototype.revision}`,
        ]),
  ].join('\n');
}

/** True when two implementation inputs describe the same ticket. */
function sameInput(left: ImplementationInput, right: ImplementationInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Create the parent-owned Architecture handoff. */
export function createImplementationHandoff(settings: ImplementationHandoffSettings): BoundAction {
  return async () => {
    const selection = await readSelection(settings.selectionFile);
    const architectureStatus = settings.preparation?.statuses.architecture ?? null;
    /**
     * The statuses the configured mappings route to a preparation stage: submitted and active
     * ideas refine, and the approved-idea admission and the four stage mappings continue
     * preparation. Waiting for Feedback and Done are never anchors, even when a mapping names
     * one of them.
     */
    const preparationStatuses = [
      ...new Set([
        settings.ideaStatuses.submitted,
        settings.ideaStatuses.active,
        ...(settings.preparation === undefined
          ? []
          : [
              settings.ideaStatuses.approved,
              settings.preparation.statuses.requirements,
              settings.preparation.statuses.uxProposal,
              settings.preparation.statuses.storybookRefinement,
              settings.preparation.statuses.architecture,
            ]),
      ]),
    ].filter(
      (status) =>
        status !== settings.ideaStatuses.waitingForFeedback && status !== settings.doneStatus,
    );
    /**
     * The union of the configured candidate queries, restricted to this project's preparation
     * statuses: the remaining preparation the handed-off implementation must precede.
     */
    const preparationQuery =
      `project = ${jqlString(settings.project)} AND ` +
      `status in (${preparationStatuses.map(jqlString).join(', ')}) AND ` +
      `((${settings.selection.query}) OR (${settings.ideas.query}))`;
    const root = selection.workspace.root;
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
    const resultFile = roundArtifactFile(
      architectureRoot,
      plan.round,
      stageResultArtifact.pathFromArtifactsRoot,
    );
    const retained = await readHandoff(root);
    const handoff: ParentHandoff = retained ?? {
      stage: 'architecture',
      upstreamReturns: 0,
      feedback: null,
      return: null,
      awaitingStages: [],
      tickets: [],
      basis: null,
      publications: [],
    };

    /** Report a condition that prevents the handoff. */
    async function failed(reason: string): Promise<'failed'> {
      await retainTerminalReason(
        path.join(root, implementationHandoffFailureDeclaration.file),
        reason,
      );
      settings.publish({ source: 'implementation-handoff', type: 'failed', data: { reason } });
      return 'failed';
    }

    // The removed preparation-only publication may already have started under this workspace. Its
    // pull request, review and check evidence is retained and must be reconciled explicitly; it is
    // never treated as a new handoff that creates implementation tickets over it.
    const retainedPublication = handoff.publications.find(
      (publication) => publication.kind === 'documentation-pr',
    );
    if (retainedPublication !== undefined) {
      return failed(
        `The retained handoff still holds the preparation-only documentation publication ` +
          `"${retainedPublication.id}" from the removed publication workflow; reconcile its pull ` +
          'request, review and check state before creating implementation tickets.',
      );
    }
    const retainedReview = await retainedDocumentationReview(root);
    if (retainedReview !== null) {
      return failed(
        `The source workspace retains the documentation review "${retainedReview}" from the ` +
          'removed preparation-only publication; reconcile its pull request, review and check ' +
          'state before creating implementation tickets.',
      );
    }

    /** Check the source before each effect and preserve human pauses on replay. */
    async function sourceProblem(): Promise<string | null> {
      const source = await readIssue(settings.jira, selection.source.issueId);
      const status = statusNameOf(source);
      if (status === architectureStatus) return null;
      if (
        status === settings.doneStatus &&
        handoff.tickets.length === tasks.length &&
        handoff.tickets.every(
          (ticket) => ticket.linked === true && ticket.admission?.completed === true,
        )
      )
        return null;
      return `Issue ${selection.taskKey} is in status "${status ?? 'unknown'}"; implementation handoff requires "${architectureStatus}" and preserves unexpected human changes.`;
    }
    const sourceState = await sourceProblem();
    if (sourceState !== null) return failed(sourceState);
    // Freeze only current stage decisions: changed authored reports, refreshed inputs, corrected
    // upstream results, unreadable revisions or pending reassessments must be resolved through
    // preparation before the handoff commits any source effect.
    if (handoff.awaitingStages.length > 0) {
      return failed(
        `Preparation is awaiting a current decision for the ` +
          `${handoff.awaitingStages.join(', ')} stage(s); reassessment must complete ` +
          'before the handoff.',
      );
    }
    for (const stage of preparationStages) {
      const stagePlan = await readStagePlan(stageRoot(root, stage));
      if (stagePlan === null) continue;
      const decision = await readCurrentDecision({
        issueRoot: root,
        stage,
        selection,
        git: settings.git,
      });
      if (decision.kind === 'current') continue;
      return failed(
        `The ${stage} stage has no current preparation decision (${decision.reason}); ` +
          'reevaluation is required before the handoff.',
      );
    }
    // Validate every dependency identity and derive a stable topological creation order. The
    // retained source identity remains the task's original plan index, including forward references.
    for (const [index, task] of tasks.entries()) {
      if (
        new Set(task.prerequisites).size !== task.prerequisites.length ||
        task.prerequisites.some(
          (prerequisite) => prerequisite >= tasks.length || prerequisite === index,
        )
      ) {
        return failed(
          `Planned task ${String(index + 1)} has duplicate, missing or self prerequisites.`,
        );
      }
    }
    const taskOrder: number[] = [];
    const remaining = new Set(tasks.map((_, index) => index));
    while (remaining.size > 0) {
      const next = [...remaining].find((index) =>
        tasks[index]?.prerequisites.every((prerequisite) => !remaining.has(prerequisite)),
      );
      if (next === undefined)
        return failed('The implementation dependency graph contains a cycle.');
      taskOrder.push(next);
      remaining.delete(next);
    }

    // Recheck the retained preparation repository's continuity before freezing the basis: the
    // first implementation continues exactly this checkout, branch and committed revision.
    const preparation = await readPreparationWorkspace(root);
    if (preparation === null) {
      return failed(
        'No retained preparation repository exists under the source workspace; the handoff has ' +
          'no checkout to continue.',
      );
    }
    const preparedHead = await preparedRevision(preparation);
    if (typeof preparedHead !== 'string') return failed(preparedHead.reason);

    const planIdentity = recordIdentity({ result: resultFile, plan: tasks });
    if (handoff.basis === null) {
      // A retained ticket mapping without a frozen basis is only adopted while every retained
      // ticket still matches the evaluated plan at its original index.
      for (const ticket of handoff.tickets) {
        const index = ticket.plannedTask;
        if (
          index === undefined ||
          index >= tasks.length ||
          tasks[index]?.summary !== ticket.summary
        ) {
          return failed(
            `The retained implementation ticket ${ticket.key} does not match planned task ` +
              `${String((index ?? 0) + 1)} of the evaluated plan; the handoff cannot reconcile ` +
              'them.',
          );
        }
      }
    } else {
      if (handoff.basis.planIdentity !== planIdentity) {
        return failed(
          'The evaluated implementation plan changed after the handoff froze its basis; ' +
            'reconcile the retained tickets instead of applying changed plan positions.',
        );
      }
      if (handoff.basis.continuationHead !== preparedHead) {
        const ancestor = await settings.git.readMergeBase(
          preparationWorktree(preparation.repositoryWorkspace.root),
          handoff.basis.continuationHead,
          preparedHead,
        );
        if (!ancestor.ok) return failed(ancestor.fault.message);
        if (ancestor.value !== handoff.basis.continuationHead) {
          return failed(
            `The frozen preparation revision ${handoff.basis.continuationHead} is no longer in ` +
              `the retained branch history; the rewritten preparation history cannot be handed ` +
              'off.',
          );
        }
      }
    }
    const basis: HandoffBasis = handoff.basis ?? {
      planIdentity,
      taskCount: tasks.length,
      continuationHead: preparedHead,
    };
    if (handoff.basis === null) {
      handoff.basis = basis;
      await writeHandoff(root, handoff);
    }

    // The accepted references every ticket names: the changed authoritative documents of the
    // shared preparation branch and the evaluated skips' optional evidence.
    const accepted = await readAcceptedDocuments(root);
    if (accepted.kind === 'invalid') {
      return failed(accepted.reason);
    }
    const prototype = await retainedPrototype();
    const existingReferences: string[] = [];
    for (const stage of preparationStages) {
      const area = stageRoot(root, stage);
      const stagePlan = await readStagePlan(area);
      if (stagePlan === null) continue;
      const stageResult = await readStageArtifact(area, stagePlan.round, stageResultArtifact);
      if (stageResult?.outcome !== 'skipped') continue;
      existingReferences.push(
        `- ${stage} evaluated skip: ${roundArtifactFile(
          area,
          stagePlan.round,
          stageResultArtifact.pathFromArtifactsRoot,
        )}; evaluation: ${stageResult.evaluation.path}`,
      );
      for (const reference of stageResult.skipReferences)
        existingReferences.push(`- ${stage} skip evidence: ${reference}`);
    }

    // Create the implementation tickets in topological order, reconciling any retained identity or
    // uncertain creation with the planned task before anything is retried, and finishing every
    // missing effect of a retained ticket.
    const ticketsByTask = new Map(
      handoff.tickets.map((ticket, index) => [ticket.plannedTask ?? index, ticket]),
    );
    const retainedTickets = (): HandoffTicket[] =>
      [...ticketsByTask.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, ticket]) => ticket);
    /** Keep the retained record's ticket mapping in step with every finished effect. */
    async function saveHandoff(): Promise<void> {
      handoff.tickets = retainedTickets();
      await writeHandoff(root, handoff);
    }
    const firstIndex = taskOrder[0] as number;
    /** Each processed ticket's resolved workspace root, so its dependents record the same one. */
    const resolvedWorkspaces = new Map<number, string>();
    /** Each processed ticket's prerequisite keys, for the final order verification. */
    const prerequisitesByTicket = new Map<string, readonly string[]>();
    for (const index of taskOrder) {
      const task = tasks[index] as PlannedTask;
      const paused = await sourceProblem();
      if (paused !== null) return failed(paused);
      const retainedTicket = ticketsByTask.get(index);
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
          ticketsByTask.set(index, ticket);
          // Retain the reconciled identity before any dependent operation.
          await saveHandoff();
        }
      }
      // Every later ticket waits for the first ticket's completion as well as its declared
      // prerequisites, because only the first branch carries the preparation commits. Both the
      // documented prerequisite keys and the workspace references the handoff resolved for them
      // are retained, so preparation reads the same tickets' completion evidence selection did.
      const prerequisiteIndices = [
        ...new Set([...task.prerequisites, ...(index === firstIndex ? [] : [firstIndex])]),
      ];
      const prerequisites = prerequisiteIndices.map((prerequisite) => {
        const prerequisiteTicket = ticketsByTask.get(prerequisite);
        const workspace = resolvedWorkspaces.get(prerequisite);
        if (prerequisiteTicket === undefined || workspace === undefined) {
          throw new Error(
            'A validated prerequisite has no retained ticket identity and workspace.',
          );
        }
        return { key: prerequisiteTicket.key, workspace: { root: workspace } };
      });
      const prerequisiteKeys = prerequisites.map((prerequisite) => prerequisite.key);
      if (ticket === undefined) {
        const created = await settings.jira.createIssue({
          issuetype: { name: settings.implementation.issueType },
          summary: task.summary,
          description: documentOf(
            ticketDescription(task, prerequisiteKeys, {
              sourceKey: selection.taskKey,
              plannedTask: `${String(index + 1)} of ${String(tasks.length)}`,
              documents: accepted.documents,
              existing: existingReferences,
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
          plannedTask: index,
          summary: task.summary,
          linked: false,
          ranked: false,
        };
        // Retain the identity before any dependent operation, so an interruption reuses it.
        ticketsByTask.set(index, ticket);
        await saveHandoff();
        // Record the creation's own initial status immediately, before admission moves it.
        const createdIssue = await readIssue(settings.jira, ticket.issueId);
        const createdStatus = statusNameOf(createdIssue);
        if (createdStatus === null) {
          return failed(`Implementation ticket ${ticket.key} has no observable initial status.`);
        }
        ticket = { ...ticket, admission: { initialStatus: createdStatus, completed: false } };
        ticketsByTask.set(index, ticket);
        await saveHandoff();
      }
      // The ticket's own workspace and its immutable implementation input. The input is retained
      // immediately after the identity, before the link and rank effects, so a ticket that creation
      // already put into the configured ready status is never selectable without its input. An
      // existing different record requests reconciliation instead of being overwritten.
      const issue = await readIssue(settings.jira, ticket.issueId);
      const ticketWorkspace = await workspaceFor(issue);
      resolvedWorkspaces.set(index, ticketWorkspace);
      const input: ImplementationInput = {
        sourceKey: selection.taskKey,
        sourceWorkspace: { root },
        architectureResult: { path: resultFile },
        planIdentity: basis.planIdentity,
        plannedTask: index,
        prerequisites,
        continuation:
          index === firstIndex
            ? { workspace: preparation, headRevision: basis.continuationHead }
            : null,
      };
      const inputFile = path.join(ticketWorkspace, implementationInputDeclaration.file);
      const existingInput = await readRecord(inputFile, implementationInputDeclaration);
      if (existingInput !== null && !sameInput(existingInput, input)) {
        return failed(
          `Implementation ticket ${ticket.key} retains a different implementation input than the ` +
            'frozen handoff describes; the retained record is reconciled instead of overwritten.',
        );
      }
      if (existingInput === null) {
        await mkdir(path.dirname(inputFile), { recursive: true });
        await writeRecord(inputFile, input);
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
        ticketsByTask.set(index, ticket);
        await saveHandoff();
      }
      // Rank every planned ticket, including the first and tasks without prerequisites: it must
      // precede the remaining preparation queue and follow its prerequisites in actual source
      // order. The observed order is re-read on every pass, so an acknowledged ticket whose rank
      // response was lost is corrected instead of trusted.
      const rankingProblem = await rankTicket(ticket, prerequisiteKeys);
      if (rankingProblem !== null) return failed(rankingProblem);
      prerequisitesByTicket.set(ticket.key, prerequisiteKeys);
      ticket = { ...ticket, ranked: true };
      ticketsByTask.set(index, ticket);
      await saveHandoff();
      // Admission is distinct from later human status changes. Replays finish only the recorded
      // initial-to-ready transition or recognize its already-applied target.
      // The issue is re-read so the transition never acts on a status observed before the
      // intervening source effects.
      const admittedIssue = await readIssue(settings.jira, ticket.issueId);
      const status = statusNameOf(admittedIssue);
      if (status !== settings.implementation.status) {
        if (ticket.admission === undefined || ticket.admission.completed) {
          return failed(
            ticket.admission === undefined
              ? `Implementation ticket ${ticket.key} is in status "${status ?? 'unknown'}" ` +
                  'without a recorded initial admission status; an unknown initial state cannot ' +
                  'authorize a transition.'
              : `Implementation ticket ${ticket.key} is in status "${status ?? 'unknown'}" after ` +
                  'its admission completed; the human status is preserved.',
          );
        }
        if (status !== ticket.admission.initialStatus) {
          return failed(
            `Implementation ticket ${ticket.key} is in status "${status ?? 'unknown'}" while ` +
              `admission recorded the initial "${ticket.admission.initialStatus}"; the human ` +
              'status is preserved.',
          );
        }
        const transition = await transitionInto(
          settings.jira,
          admittedIssue,
          settings.implementation.status,
        );
        if (transition.kind === 'blocked') return failed(transition.reason);
        await applyTransition(settings.jira, admittedIssue.id, transition.transition);
      }
      ticket = {
        ...ticket,
        admission: {
          initialStatus: ticket.admission?.initialStatus ?? settings.implementation.status,
          completed: true,
        },
      };
      ticketsByTask.set(index, ticket);
      await saveHandoff();
    }

    const tickets = retainedTickets();
    // Confirm the completed order before publishing the handoff: every planned ticket precedes
    // remaining preparation and every prerequisite precedes its dependent. A move the source did
    // not apply leaves the handoff unfinished for replay even when its rank request was accepted.
    const orderProblem = await verifyRankedOrder(tickets, prerequisitesByTicket);
    if (orderProblem !== null) return failed(orderProblem);
    // Close the original with the completed handoff and every implementation link. Only the status
    // the Architecture selection left behind (or a repeated Done) may be closed: an unexpected
    // human pause or reroute is preserved instead of overwritten.
    const source = await readIssue(settings.jira, selection.source.issueId);
    const sourceStatus = statusNameOf(source);
    const allowed = [
      ...(architectureStatus === null ? [] : [architectureStatus]),
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
    const comment = [
      'Preparation complete. Implementation tickets:',
      ...tickets.map((ticket) => `- ${ticket.key}: ${ticket.summary}`),
    ].join('\n');
    const published = await publishDocument(
      settings.jira,
      selection.source.issueId,
      await readComments(settings.jira, selection.source.issueId),
      documentOf(comment),
    );
    handoff.publications = [
      ...handoff.publications.filter((entry) => entry.kind !== 'handoff-comment'),
      { kind: 'handoff-comment', id: published.id },
    ];
    await saveHandoff();
    if (sourceStatus !== settings.doneStatus) {
      const transition = await transitionInto(settings.jira, source, settings.doneStatus);
      if (transition.kind === 'blocked') {
        return failed(transition.reason);
      }
      await applyTransition(settings.jira, source.id, transition.transition);
    }
    await saveHandoff();
    await writeRecord(path.join(root, implementationHandoffResultDeclaration.file), {
      outcome: 'handed-off',
      tickets: tickets.map((ticket) => ticket.key),
    });
    settings.publish({
      source: 'implementation-handoff',
      type: 'handed-off',
      data: {
        task: selection.taskKey,
        tickets: tickets.map((ticket) => ticket.key),
      },
    });
    return 'handed-off';

    /** The retained prototype reference the Storybook Refinement result recorded, when one exists. */
    async function retainedPrototype(): Promise<PreparationResult['prototype']> {
      const areaRoot = stageRoot(root, 'prototype');
      const stagePlan = await readStagePlan(areaRoot);
      if (stagePlan === null) {
        return null;
      }
      const stageResult = await readStageArtifact(areaRoot, stagePlan.round, stageResultArtifact);
      return stageResult?.outcome === 'accepted' || stageResult?.outcome === 'skipped'
        ? stageResult.prototype
        : null;
    }

    /** The removed preparation-only publication's retained review file, or null when none remains. */
    async function retainedDocumentationReview(issueRoot: string): Promise<string | null> {
      const directory = path.join(issueRoot, legacyDocumentationReviewsDirectory);
      let entries: readonly string[];
      try {
        entries = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw new Error(
          `The retained documentation review area "${directory}" could not be read: ` +
            `${messageOf(error)}`,
          { cause: error },
        );
      }
      const retained = [...entries].filter((entry) => entry.endsWith('.json')).sort()[0];
      return retained === undefined ? null : path.join(directory, retained);
    }

    /** The retained preparation branch's committed head, or the reason it cannot be continued. */
    async function preparedRevision(
      workspace: PreparationWorkspace,
    ): Promise<string | { readonly reason: string }> {
      const worktree = preparationWorktree(workspace.repositoryWorkspace.root);
      const inspection = await settings.git.inspectRepository(worktree);
      if (!inspection.ok) {
        return { reason: inspection.fault.message };
      }
      if (inspection.value.remoteUrl !== workspace.repository) {
        return {
          reason:
            `The preparation checkout at "${worktree}" belongs to ` +
            `"${inspection.value.remoteUrl ?? 'no remote'}", not to the retained ` +
            `"${workspace.repository}"; reconcile it instead of replacing it.`,
        };
      }
      if (inspection.value.branch !== workspace.branch) {
        return {
          reason:
            `The preparation checkout is on branch ` +
            `"${inspection.value.branch ?? 'no branch'}", not the retained ` +
            `"${workspace.branch}"; reconcile it instead of selecting another branch.`,
        };
      }
      if (inspection.value.headRevision === null) {
        return { reason: `The retained preparation branch "${workspace.branch}" has no revision.` };
      }
      return inspection.value.headRevision;
    }

    /** The implementation issue's own workspace root, recorded or stable. */
    async function workspaceFor(issue: JiraIssue): Promise<string> {
      const recorded = issue.fields[settings.workspacePointerField];
      const stable = path.join(settings.workspaceRoot, settings.project, issue.key);
      if (typeof recorded !== 'string' || recorded.trim() === '' || !path.isAbsolute(recorded)) {
        await updateIssueFields(settings.jira, issue.id, { workspacePointer: stable });
        return stable;
      }
      return recorded;
    }

    /**
     * The earliest remaining preparation ticket in observed source rank, excluding the original
     * issue being handed off, or null when the project's preparation queue is empty.
     */
    async function preparationAnchor(): Promise<Result<JiraIssueIdentity | null>> {
      const found = await settings.jira.searchIssues({
        query: preparationQuery,
        orderBy: 'Rank ASC',
      });
      if (!found.ok) return found;
      return ok(found.value.find((issue) => issue.key !== selection.taskKey) ?? null);
    }

    /**
     * Complete one ticket's queue ranking against the freshly observed source order: it must
     * follow its prerequisites and precede the earliest remaining preparation anchor. A ticket
     * that precedes a prerequisite moves immediately after its last prerequisite in actual source
     * order; otherwise a ticket that follows the anchor moves immediately before it. Moving one
     * ticket never changes the relative order of the other source issues. Returns the reason the
     * ranking cannot be established, or null once the observed order satisfies both constraints.
     */
    async function rankTicket(
      ticket: HandoffTicket,
      prerequisiteKeys: readonly string[],
    ): Promise<string | null> {
      const observed = await settings.jira.searchIssues({
        query: `project = ${jqlString(settings.project)}`,
        orderBy: 'Rank ASC',
      });
      if (!observed.ok) return observed.fault.message;
      const order = observed.value.map((issue) => issue.key);
      const position = order.indexOf(ticket.key);
      if (position < 0) {
        return `The source rank order omits implementation ticket ${ticket.key}.`;
      }
      const missing = prerequisiteKeys.filter((key) => !order.includes(key));
      if (missing.length > 0) {
        return (
          `The source rank order omits the prerequisite(s) ${missing.join(', ')} of ` +
          `implementation ticket ${ticket.key}.`
        );
      }
      const found = await preparationAnchor();
      if (!found.ok) return found.fault.message;
      const anchor = found.value;
      const anchorPosition = anchor === null ? -1 : order.indexOf(anchor.key);
      if (anchor !== null && anchorPosition < 0) {
        return `The source rank order omits the preparation anchor ${anchor.key}.`;
      }
      if (prerequisiteKeys.length > 0) {
        const last = prerequisiteKeys.reduce((left, right) =>
          order.indexOf(left) > order.indexOf(right) ? left : right,
        );
        if (position < order.indexOf(last)) {
          // Move only a premature dependent down, preserving unrelated higher-ranked work.
          const ranked = await settings.jira.rankIssue(ticket.issueId, { after: last });
          if (!ranked.ok) return ranked.fault.message;
          return null;
        }
      }
      if (anchor !== null && position > anchorPosition) {
        const ranked = await settings.jira.rankIssue(ticket.issueId, { before: anchor.key });
        if (!ranked.ok) return ranked.fault.message;
      }
      return null;
    }

    /**
     * Confirm the completed order before publishing the handoff: every planned ticket precedes
     * remaining preparation and every prerequisite precedes its dependent.
     */
    async function verifyRankedOrder(
      tickets: readonly HandoffTicket[],
      prerequisites: ReadonlyMap<string, readonly string[]>,
    ): Promise<string | null> {
      const observed = await settings.jira.searchIssues({
        query: `project = ${jqlString(settings.project)}`,
        orderBy: 'Rank ASC',
      });
      if (!observed.ok) return observed.fault.message;
      const order = observed.value.map((issue) => issue.key);
      const found = await preparationAnchor();
      if (!found.ok) return found.fault.message;
      const anchor = found.value;
      const anchorPosition = anchor === null ? -1 : order.indexOf(anchor.key);
      if (anchor !== null && anchorPosition < 0) {
        return `The source rank order omits the preparation anchor ${anchor.key}.`;
      }
      for (const ticket of tickets) {
        const position = order.indexOf(ticket.key);
        if (position < 0) {
          return `The source rank order omits implementation ticket ${ticket.key}.`;
        }
        if (anchor !== null && position > anchorPosition) {
          return (
            `Implementation ticket ${ticket.key} still follows the remaining preparation ` +
            `anchor ${anchor.key}; the handoff is not complete.`
          );
        }
        for (const key of prerequisites.get(ticket.key) ?? []) {
          const prerequisitePosition = order.indexOf(key);
          if (prerequisitePosition < 0) {
            return (
              `The source rank order omits the prerequisite ${key} of implementation ` +
              `ticket ${ticket.key}.`
            );
          }
          if (prerequisitePosition > position) {
            return (
              `Prerequisite ${key} still follows its dependent implementation ` +
              `ticket ${ticket.key}; the handoff is not complete.`
            );
          }
        }
      }
      return null;
    }

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
        `project = ${jqlString(settings.project)} AND ` +
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
      const candidate = await readIssue(settings.jira, identity.id);
      const labels = candidate.fields.labels;
      if (
        candidate.key !== identity.key ||
        candidate.fields.summary !== task.summary ||
        !Array.isArray(labels) ||
        !labels.includes(plannedTaskLabel(selection.taskKey, index)) ||
        !JSON.stringify(candidate.fields.description).includes(
          `Source: ${selection.taskKey} (planned task ${String(index + 1)} of ${String(tasks.length)}).`,
        )
      ) {
        return {
          kind: 'failed',
          reason: `Issue ${identity.key} does not match the source/planned-task identity and exact summary of task ${String(index + 1)}.`,
        };
      }
      return {
        kind: 'found',
        ticket: {
          key: identity.key,
          issueId: identity.id,
          plannedTask: index,
          summary: task.summary,
          linked: false,
          ranked: false,
        },
      };
    }
  };
}
