import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { JiraAdapter, JiraIssue, JiraIssueQuery } from '../../../adapters/jira.js';
import { fault, messageOf, ok, type Result } from '../../../result.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../index.js';
import { completionArtifact, type CompletionOutput } from '../complete-task/artifacts.js';
import {
  preparedWorkspaceDeclaration,
  preparedWorkspaceFile,
} from '../prepare-workspace/artifacts.js';
import { currentRoundDeclaration, currentRoundFile } from '../start-round/artifacts.js';
import { readUsableDevelopmentOutcome } from '../develop/artifacts.js';
import { deliveryArtifact } from '../deliver/artifacts.js';
import { verificationArtifact } from '../verify/artifacts.js';
import { roundArtifactPath } from '../artifacts.js';
import { readRecord, writeRecord } from '../records.js';
import {
  implementationInputDeclaration,
  type ImplementationInput,
  type ImplementationPrerequisite,
} from '../project/implementation-handoff/artifacts.js';
import { handoffInputDisposition, handoffSourceKey } from '../project/state.js';
import {
  applyTransition,
  readComments,
  readIssue,
  statusNameOf,
  transitionInto,
  updateIssueFields,
} from '../source.js';
import {
  parentAreaDirectory,
  handoffFile,
  parentHandoffDeclaration,
  initialHandoff,
  selectionFailureDeclaration,
  type ParentHandoff,
} from './artifacts.js';
import {
  selectionDeclaration,
  type Selection,
  type WorkflowStage,
} from '../select-task/artifacts.js';

/**
 * SelectWork selects one eligible project issue in configured source rank order, retains its
 * complete source input, its stage and its stable issue workspace, and claims it before any child
 * runs. The parent reads one combined sequence over the separate configured idea and delivery
 * queries, so Jira's whole rank order decides which candidate runs first and an idea cannot enter
 * finite delivery directly; the mapped source status selects the stage. A missing mapping for an
 * observed candidate requests attention instead of silently skipping the stage.
 *
 * Source access failures are execution errors. An observed condition that prevents selection is a
 * failed outcome whose reason is published for recovery.
 */

export type SelectWorkSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The absolute root under which issue workspaces live. */
  readonly workspaceRoot: string;
  /** The configured project identity; workspace paths distinguish projects as well as issues. */
  readonly project: string;
  /** The configured ranked queue covering mapped implementation and preparation stages. */
  readonly selection: JiraIssueQuery;
  /** The separate idea candidate query, applied to the same project connection. */
  readonly ideas: JiraIssueQuery;
  /** The configured implementation statuses the parent claims through. */
  readonly statuses: {
    readonly ready: string;
    readonly inProgress: string;
    readonly review: string;
    readonly done: string;
  };
  /** The configured preparation stage mappings; absent for a delivery-only project. */
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
  /** The configured idea statuses the parent claims and excludes. */
  readonly ideaStatuses: {
    readonly submitted: string;
    readonly active: string;
    readonly approved: string;
    readonly waitingForFeedback: string;
  };
  /** The configured Jira field that retains an issue's workspace root. */
  readonly workspacePointerField: string;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
};

/** A nonempty text field, or null for any other value. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** One Jira JQL string literal. */
function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** True when the issue carries a description in its native source format. */
function hasDescription(fields: Readonly<Record<string, unknown>>): boolean {
  const description = fields.description;
  if (description === undefined || description === null) {
    return false;
  }
  return typeof description !== 'string' || description.trim() !== '';
}

/** True when the issue satisfies the required details for any stage. */
function isEligible(issue: JiraIssue): boolean {
  return text(issue.fields.summary) !== null && hasDescription(issue.fields);
}

/** True when the path is an existing directory; a missing path is not an error. */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new Error(`Workspace path "${target}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

/** Create SelectWork over the configured sources, workspace root and selection-file location. */
export function createSelectWork(settings: SelectWorkSettings): BoundAction {
  const { jira, publish } = settings;

  /** Report an issue condition that prevents selection. */
  async function fail(
    reason: string,
    issue: JiraIssue,
    selection: Selection | null = null,
  ): Promise<'failed'> {
    const failure = {
      taskKey: issue.key,
      source: { kind: 'jira' as const, issueId: issue.id },
      reason,
      selection,
    };
    await mkdir(path.dirname(settings.selectionFile), { recursive: true });
    await writeRecord(
      path.join(path.dirname(settings.selectionFile), selectionFailureDeclaration.file),
      failure,
    );
    if (selection !== null && (await isDirectory(selection.workspace.root))) {
      await mkdir(path.join(selection.workspace.root, parentAreaDirectory), { recursive: true });
      await writeRecord(
        path.join(selection.workspace.root, parentAreaDirectory, selectionFailureDeclaration.file),
        failure,
      );
    }
    publish({ source: 'select-work', type: 'failed', data: { reason } });
    return 'failed';
  }

  /** Report the selected outcome referencing the saved selection record. */
  function selected(taskKey: string, stage: WorkflowStage): 'selected' {
    publish(
      actionOutcomeEvent('select-work', {
        task: taskKey,
        round: null,
        outcome: 'selected',
        detail: stage,
        artifact: { path: settings.selectionFile },
      }),
    );
    return 'selected';
  }

  /** The stable project/issue workspace path under the configured root. */
  function stableWorkspace(taskKey: string): string {
    return path.join(settings.workspaceRoot, settings.project, taskKey);
  }

  /**
   * The stage one issue's current status maps to, the reason the status cannot enter any stage, or
   * null when the status belongs to an item the parent never selects again.
   */
  function stageOf(status: string): Result<WorkflowStage | null> {
    const preparation = settings.preparation?.statuses;
    // A submitted idea starts refinement; an active idea is the retained refinement the parent
    // continues, so both route to the idea child.
    if (status === settings.ideaStatuses.submitted || status === settings.ideaStatuses.active) {
      return ok('idea');
    }
    if (preparation !== undefined) {
      // Draft (the configured idea-approval status) is the admission boundary: an approved idea
      // enters Requirements, which keeps the distinct Draft and Requirements mappings working.
      if (status === settings.ideaStatuses.approved || status === preparation.requirements) {
        return ok('requirements');
      }
      if (status === preparation.uxProposal) {
        return ok('ux');
      }
      if (status === preparation.storybookRefinement) {
        return ok('prototype');
      }
      if (status === preparation.architecture) {
        return ok('architecture');
      }
    }
    if (
      status === settings.statuses.ready ||
      status === settings.statuses.inProgress ||
      status === settings.statuses.review
    ) {
      return ok('delivery');
    }
    if (
      status === settings.statuses.done ||
      status === settings.ideaStatuses.waitingForFeedback ||
      (preparation === undefined && status === settings.ideaStatuses.approved)
    ) {
      // Completed, waiting and (for a delivery-only project) approved-but-undeliverable work is
      // not selected automatically.
      return ok(null);
    }
    return fault(
      `Issue status "${status}" has no configured project stage mapping; selection does not skip ` +
        'an unmapped stage. Configure the mapping or remove the issue from the eligible query.',
    );
  }

  /**
   * The reason an active implementation status cannot be admitted, or null when its retained work
   * exists. Prepared work establishes an In Progress continuation; In Review additionally needs
   * published delivery and matching verification. Only a saved ready selection can finish an
   * interrupted initial In Progress claim without prepared work.
   */
  async function activeDeliveryProblem(
    issue: JiraIssue,
    saved?: Selection,
  ): Promise<string | null> {
    const status = statusNameOf(issue) ?? 'unknown';
    const recorded = issue.fields[settings.workspacePointerField];
    if (typeof recorded !== 'string' || recorded.trim() === '' || !path.isAbsolute(recorded)) {
      return (
        `Issue ${issue.key} is in the active status "${status}" without a retained workspace ` +
        'pointer; Nexus does not start a new delivery attempt for active work.'
      );
    }
    if (!(await isDirectory(recorded))) {
      return (
        `Issue ${issue.key} is in the active status "${status}" while its retained workspace ` +
        `"${recorded}" no longer exists; Nexus does not start a new delivery attempt for active ` +
        'work.'
      );
    }
    const prepared = await readRecord(
      path.join(recorded, preparedWorkspaceFile),
      preparedWorkspaceDeclaration,
    );
    if (prepared === null || prepared.taskKey !== issue.key) {
      // The saved ready selection proves an interrupted initial claim. This exception never admits
      // In Review and never treats an attempt UUID as delivery/review evidence.
      if (
        prepared === null &&
        status === settings.statuses.inProgress &&
        saved?.stage === 'delivery' &&
        (saved.initialClaim ?? statusNameOf(saved.task as JiraIssue) === settings.statuses.ready) &&
        saved.workspace.root === recorded
      ) {
        return null;
      }
      return `Issue ${issue.key} is in the active status "${status}" without a retained prepared finite-delivery workspace.`;
    }
    if (status === settings.statuses.review) {
      const round = await readRecord(
        path.join(recorded, currentRoundFile),
        currentRoundDeclaration,
      );
      const delivery =
        round === null
          ? null
          : await readRecord(
              roundArtifactPath(recorded, round.number, deliveryArtifact.pathFromArtifactsRoot),
              { file: deliveryArtifact.pathFromArtifactsRoot, schema: deliveryArtifact.schema },
            );
      const verified =
        round === null
          ? null
          : await readRecord(
              roundArtifactPath(recorded, round.number, verificationArtifact.pathFromArtifactsRoot),
              {
                file: verificationArtifact.pathFromArtifactsRoot,
                schema: verificationArtifact.schema,
              },
            );
      const development =
        round === null
          ? null
          : await readUsableDevelopmentOutcome({
              areaRoot: recorded,
              taskKey: issue.key,
              round: round.number,
              context: `Selecting retained In Review delivery for task ${issue.key}.`,
            });
      if (
        development?.status !== 'completed' ||
        development.taskKey !== issue.key ||
        delivery === null ||
        development.headRevision !== delivery.headRevision ||
        verified?.status !== 'passed' ||
        verified.headRevision !== delivery.headRevision
      ) {
        return `Issue ${issue.key} is In Review without retained delivery and matching successful verification evidence.`;
      }
      // Admission checks saved evidence only. Leave developer context for the consuming owner,
      // whose applicable checks establish readiness for fresh review or saved-review replay.
    }
    return null;
  }

  /**
   * The issue workspace: retain an existing pointer, or use the stable project/issue path.
   * Source handoff lookup keeps even a missing recorded root so unavailable evidence cannot be
   * replaced by a different handoff. Invalid pointers request reconciliation.
   */
  async function workspaceFor(issue: JiraIssue, retainMissing = false): Promise<Result<string>> {
    const recorded = issue.fields[settings.workspacePointerField];
    if (recorded === undefined || recorded === null || recorded === '') {
      return ok(stableWorkspace(issue.key));
    }
    if (typeof recorded !== 'string' || !path.isAbsolute(recorded)) {
      return fault(
        `Issue ${issue.key} records an unexpected workspace pointer in ` +
          `"${settings.workspacePointerField}"; selection does not overwrite it.`,
      );
    }
    return ok(
      retainMissing || (await isDirectory(recorded)) ? recorded : stableWorkspace(issue.key),
    );
  }

  /** A cleared pointer does not discard retained evidence; divergent pointers require reconciliation. */
  function workspacePointerProblem(issue: JiraIssue, root: string): string | null {
    const pointer = issue.fields[settings.workspacePointerField];
    if (pointer === undefined || pointer === null || pointer === '') {
      return null;
    }
    return typeof pointer !== 'string' ||
      !path.isAbsolute(pointer) ||
      path.resolve(pointer) !== path.resolve(root)
      ? `Issue ${issue.key} records a workspace pointer conflicting with its retained workspace "${root}"; reconcile the references before admission.`
      : null;
  }

  /** The parent handoff record for one issue workspace, created when it does not exist yet. */
  async function readHandoff(root: string): Promise<ParentHandoff | null> {
    const file = path.join(root, parentAreaDirectory, handoffFile);
    return readRecord(file, parentHandoffDeclaration);
  }

  /** One prerequisite's retained completion evidence, or null when it is absent or mismatched. */
  async function prerequisiteCompletion(
    prerequisite: ImplementationPrerequisite,
  ): Promise<CompletionOutput | null> {
    const root = prerequisite.workspace.root;
    const round = await readRecord(path.join(root, currentRoundFile), currentRoundDeclaration);
    if (round === null) {
      return null;
    }
    const completion = await readRecord(
      roundArtifactPath(root, round.number, completionArtifact.pathFromArtifactsRoot),
      { file: completionArtifact.pathFromArtifactsRoot, schema: completionArtifact.schema },
    );
    return completion !== null && completion.taskKey === prerequisite.key ? completion : null;
  }

  /**
   * Why one handoff ticket's parent-side effects are not durable yet, or null when they are
   * finished or the record cannot attribute them. The source handoff owns the ticket's link, rank
   * and admission acknowledgements; an interrupted handoff reconciles them before implementation
   * starts. A record that does not name the ticket (legacy or externally created) leaves the
   * retained input authoritative.
   */
  async function handoffAdmissionProblem(
    input: ImplementationInput,
    key: string,
  ): Promise<{ readonly kind: 'defer' | 'attention'; readonly reason: string } | null> {
    const file = path.join(input.sourceWorkspace.root, parentAreaDirectory, handoffFile);
    let source: ParentHandoff | null;
    try {
      source = await readRecord(file, parentHandoffDeclaration);
    } catch (error) {
      return {
        kind: 'attention',
        reason:
          `Issue ${key} traces its handoff to an unreadable source handoff record at "${file}": ` +
          `${messageOf(error)}.`,
      };
    }
    const ticket = source?.tickets.find((entry) => entry.key === key);
    if (ticket === undefined) {
      return null;
    }
    if (
      ticket.linked !== true ||
      ticket.admission?.completed !== true ||
      (input.prerequisites.length > 0 && ticket.ranked !== true)
    ) {
      return {
        kind: 'defer',
        reason:
          `Issue ${key} retains its implementation input while its recorded handoff effects are ` +
          'not finished; the handoff reconciles its link, rank and admission before implementation ' +
          'is admitted.',
      };
    }
    return null;
  }

  /**
   * Admit one implementation issue or explain why it cannot be claimed yet. A linked implementation
   * issue waits for every prerequisite's source completion and retained merge/check evidence;
   * source Done alone is insufficient. A dependent with unfinished prerequisite work is deferred
   * while a malformed input or an unknown prerequisite identity requests attention. A ticket
   * carrying the handoff's source identity without its retained input is deferred until the handoff
   * retains it, and one whose recorded handoff effects are unfinished is deferred as well; neither
   * is ever treated as an ordinary task.
   */
  async function implementationAdmission(
    issue: JiraIssue,
    root: string,
    retainedSourceWorkspace?: Selection['handoffSourceWorkspace'],
  ): Promise<
    | { readonly kind: 'admitted'; readonly handoffSourceWorkspace?: { readonly root: string } }
    | { readonly kind: 'defer' | 'attention'; readonly reason: string }
  > {
    const inputFile = path.join(root, implementationInputDeclaration.file);
    let input: ImplementationInput | null;
    try {
      input = await readRecord(inputFile, implementationInputDeclaration);
    } catch (error) {
      return {
        kind: 'attention',
        reason:
          `Issue ${issue.key} retains an unreadable implementation input at "${inputFile}": ` +
          `${messageOf(error)}.`,
      };
    }
    if (input === null) {
      // A ticket created by the Architecture handoff is known by its source-side identity label
      // and the source handoff record that owns its effects. Until the handoff retains its input
      // it is not ordinary delivery work: claiming it would lose the preparation continuation or
      // bypass prerequisite admission. Only a record without the current contract's frozen basis
      // and with finished link/admission effects establishes an earlier-contract exception.
      const sourceKey = handoffSourceKey(issue.fields.labels);
      if (sourceKey === null) {
        return { kind: 'admitted' };
      }
      const found = await jira.searchIssues({
        query: `key in (${jqlString(sourceKey)})`,
        orderBy: 'Rank ASC',
      });
      if (!found.ok) {
        throw new Error(found.fault.message);
      }
      const identity = found.value.find((entry) => entry.key === sourceKey);
      if (identity === undefined) {
        return {
          kind: 'attention',
          reason: `The handoff source ${sourceKey} of issue ${issue.key} was not found; reconcile its retained workspace.`,
        };
      }
      const source = await readIssue(jira, identity.id);
      const sourceWorkspace =
        retainedSourceWorkspace === undefined
          ? await workspaceFor(source, true)
          : ok(retainedSourceWorkspace.root);
      if (retainedSourceWorkspace !== undefined) {
        const conflict = workspacePointerProblem(source, retainedSourceWorkspace.root);
        if (conflict !== null) {
          return { kind: 'attention', reason: conflict };
        }
      }
      if (!sourceWorkspace.ok) {
        return { kind: 'attention', reason: sourceWorkspace.fault.message };
      }
      const disposition = await handoffInputDisposition({
        sourceWorkspace: { root: sourceWorkspace.value },
        labels: issue.fields.labels,
        ticketKey: issue.key,
      });
      if (disposition.kind === 'ordinary' || disposition.kind === 'legacy') {
        return { kind: 'admitted', handoffSourceWorkspace: { root: sourceWorkspace.value } };
      }
      return disposition.kind === 'incomplete'
        ? {
            kind: 'defer',
            reason:
              `Issue ${issue.key} carries the implementation handoff's source identity but the ` +
              'handoff has not retained its implementation input yet; the handoff completes its ' +
              'effects before implementation is admitted.',
          }
        : {
            kind: 'attention',
            reason:
              `Issue ${issue.key} carries the implementation handoff's source identity but ` +
              `retains no implementation input, and ${disposition.reason}; reconcile the retained ` +
              'handoff before selection.',
          };
    }
    const handoff = await handoffAdmissionProblem(input, issue.key);
    if (handoff !== null) {
      return handoff;
    }
    const prerequisiteKeys = input.prerequisites.map((prerequisite) => prerequisite.key);
    if (prerequisiteKeys.length === 0) {
      return { kind: 'admitted' };
    }
    const found = await jira.searchIssues({
      query: `key in (${prerequisiteKeys.map((key) => jqlString(key)).join(', ')})`,
      orderBy: 'Rank ASC',
    });
    if (!found.ok) {
      throw new Error(found.fault.message);
    }
    const identities = new Map(found.value.map((identity) => [identity.key, identity]));
    for (const recorded of input.prerequisites) {
      const key = recorded.key;
      const identity = identities.get(key);
      if (identity === undefined) {
        return {
          kind: 'attention',
          reason:
            `Prerequisite ${key} of issue ${issue.key} was not found in the project; the ` +
            'retained implementation input cannot be satisfied.',
        };
      }
      const prerequisite = await readIssue(jira, identity.id);
      const conflict = workspacePointerProblem(prerequisite, recorded.workspace.root);
      if (conflict !== null) {
        return { kind: 'attention', reason: conflict };
      }
      if (statusNameOf(prerequisite) !== settings.statuses.done) {
        return {
          kind: 'defer',
          reason:
            `Prerequisite ${key} of issue ${issue.key} is not Done; implementation is deferred ` +
            'until the prerequisite completes with its merge/check evidence.',
        };
      }
      if ((await prerequisiteCompletion(recorded)) === null) {
        return {
          kind: 'defer',
          reason:
            `Prerequisite ${key} of issue ${issue.key} retains no confirmed merge/check ` +
            'completion evidence; implementation is deferred.',
        };
      }
    }
    return { kind: 'admitted' };
  }

  /** Retain the parent handoff record for a fresh selection; a retained one is kept. */
  async function retainHandoff(root: string, stage: WorkflowStage): Promise<void> {
    const existing = await readHandoff(root);
    if (existing !== null) {
      return;
    }
    const directory = path.join(root, parentAreaDirectory);
    await mkdir(directory, { recursive: true });
    await writeRecord(
      path.join(directory, handoffFile),
      initialHandoff(stage) satisfies ParentHandoff,
    );
  }

  /** Point the issue at its retained workspace, updating the source field when it differs. */
  async function retainWorkspace(issue: JiraIssue, root: string): Promise<void> {
    if (issue.fields[settings.workspacePointerField] === root) {
      return;
    }
    await updateIssueFields(jira, issue.id, { workspacePointer: root });
  }

  /**
   * Claim the issue after its selection was saved: retain the workspace reference and move it into
   * the stage's active status. An active status the issue already holds is a continuation, not a
   * claim: In Progress and In Review stay where they are, so resumed review work is not moved
   * backwards. A missing permitted transition is reported.
   */
  async function claim(
    issue: JiraIssue,
    stage: WorkflowStage,
    root: string,
  ): Promise<string | null> {
    await retainWorkspace(issue, root);
    const status = statusNameOf(issue);
    const target =
      stage === 'idea'
        ? settings.ideaStatuses.active
        : stage === 'delivery' && status === settings.statuses.ready
          ? settings.statuses.inProgress
          : stage === 'requirements' && status === settings.ideaStatuses.approved
            ? (settings.preparation?.statuses.requirements ?? null)
            : null;
    if (target === null || status === target) {
      // Already-active work keeps its stage status; Draft admission moves to Requirements.
      return null;
    }
    const transition = await transitionInto(jira, issue, target);
    if (transition.kind === 'blocked') {
      return transition.reason;
    }
    await applyTransition(jira, issue.id, transition.transition);
    return null;
  }

  /** Save the selection before any source claim is attempted. */
  async function saveSelection(selection: Selection): Promise<void> {
    await mkdir(path.dirname(settings.selectionFile), { recursive: true });
    await writeRecord(settings.selectionFile, selection);
  }

  /** Continue the retained issue, finishing an unfinished claim or its workspace reference. */
  async function continueSelection(saved: Selection, issue: JiraIssue): Promise<string> {
    if (saved.stage === 'delivery' && statusNameOf(issue) !== settings.statuses.ready) {
      const problem = await activeDeliveryProblem(issue, saved);
      if (problem !== null) {
        return fail(problem, issue, saved);
      }
    }
    const workspace = await workspaceFor(issue);
    if (!workspace.ok) {
      return fail(workspace.fault.message, issue, saved);
    }
    let handoffSourceWorkspace: Selection['handoffSourceWorkspace'];
    if (saved.stage === 'delivery') {
      // Retained implementation work keeps waiting for its recorded prerequisites; a fresh claim
      // never starts a dependent whose prerequisite has not completed.
      const prerequisite = await implementationAdmission(
        issue,
        workspace.value,
        saved.handoffSourceWorkspace,
      );
      if (prerequisite.kind !== 'admitted') {
        return fail(prerequisite.reason, issue, saved);
      }
      handoffSourceWorkspace = prerequisite.handoffSourceWorkspace;
    }
    // Re-capture the issue and its complete attributed conversation, so human clarifications
    // added while the item waited for feedback govern the resumed work.
    const conversation = await readComments(jira, issue.id);
    const prepared = await readRecord(
      path.join(workspace.value, preparedWorkspaceFile),
      preparedWorkspaceDeclaration,
    );
    await saveSelection({
      ...saved,
      handoffSourceWorkspace,
      initialClaim:
        saved.stage === 'delivery' &&
        prepared === null &&
        (statusNameOf(issue) === settings.statuses.ready ||
          (saved.initialClaim ??
            statusNameOf(saved.task as JiraIssue) === settings.statuses.ready)),
      task: issue,
      conversation,
      workspace: { root: workspace.value },
    });
    await retainHandoff(workspace.value, saved.stage);
    const problem = await claim(issue, saved.stage, workspace.value);
    if (problem !== null) {
      return fail(problem, issue, saved);
    }
    return selected(saved.taskKey, saved.stage);
  }

  /** Select one fresh eligible candidate from the combined configured ranked queue. */
  async function selectFresh(): Promise<string> {
    // One combined source-ranked sequence: Jira ranks the union of both configured eligibility
    // queries, so the first eligible candidate is the first in the source's whole rank order and a
    // lower-ranked idea cannot take precedence over higher-ranked implementation work.
    const orderBy = settings.selection.orderBy;
    if (settings.ideas.orderBy !== orderBy) {
      throw new Error(
        'The configured idea and delivery queries must share one source order to form the ' +
          `single ranked queue the parent selects from; they order by "${settings.ideas.orderBy}" ` +
          `and "${orderBy}".`,
      );
    }
    const candidates = await jira.searchIssues({
      query: `(${settings.selection.query}) OR (${settings.ideas.query})`,
      orderBy,
    });
    if (!candidates.ok) {
      throw new Error(candidates.fault.message);
    }

    for (const candidate of candidates.value) {
      const first = await readIssue(jira, candidate.id);
      if (!isEligible(first)) {
        continue;
      }
      const firstStage = stageOf(statusNameOf(first) ?? '');
      if (!firstStage.ok) {
        return fail(firstStage.fault.message, first);
      }
      if (firstStage.value === null) {
        continue;
      }

      const conversation = await readComments(jira, candidate.id);
      // Re-read the issue before claiming so an intervening human change is preserved.
      const current = await readIssue(jira, candidate.id);
      if (!isEligible(current)) {
        continue;
      }
      const currentStage = stageOf(statusNameOf(current) ?? '');
      if (!currentStage.ok) {
        return fail(currentStage.fault.message, current);
      }
      if (currentStage.value === null) {
        continue;
      }
      if (currentStage.value === 'delivery' && statusNameOf(current) !== settings.statuses.ready) {
        // An active implementation status continues retained work; it never admits a fresh
        // delivery attempt.
        const problem = await activeDeliveryProblem(current);
        if (problem !== null) {
          return fail(problem, current);
        }
      }

      const workspace = await workspaceFor(current);
      if (!workspace.ok) {
        return fail(workspace.fault.message, current);
      }
      let handoffSourceWorkspace: Selection['handoffSourceWorkspace'];
      if (currentStage.value === 'delivery') {
        const prerequisite = await implementationAdmission(current, workspace.value);
        if (prerequisite.kind !== 'admitted') {
          if (prerequisite.kind === 'defer' && statusNameOf(current) === settings.statuses.ready) {
            // A dependent whose prerequisite has not completed is deferred; the ranked queue
            // keeps inspecting eligible work and the prerequisite itself is selected first.
            continue;
          }
          return fail(prerequisite.reason, current);
        }
        handoffSourceWorkspace = prerequisite.handoffSourceWorkspace;
      }
      const nextSelection: Selection = {
        taskKey: current.key,
        handoffSourceWorkspace,
        source: { kind: 'jira', issueId: current.id },
        task: current,
        conversation,
        workspace: { root: workspace.value },
        stage: currentStage.value,
        initialClaim:
          currentStage.value === 'delivery' && statusNameOf(current) === settings.statuses.ready,
      };
      await saveSelection(nextSelection);
      await retainHandoff(workspace.value, currentStage.value);

      const problem = await claim(current, currentStage.value, workspace.value);
      if (problem !== null) {
        return fail(problem, current, nextSelection);
      }
      return selected(current.key, currentStage.value);
    }
    return 'empty';
  }

  return async () => {
    const saved = await readRecord(settings.selectionFile, selectionDeclaration);
    if (saved === null) {
      return selectFresh();
    }

    const issue = await readIssue(jira, saved.source.issueId);
    const stage = stageOf(statusNameOf(issue) ?? '');
    if (!stage.ok) {
      return fail(stage.fault.message, issue, saved);
    }
    if (stage.value === null) {
      // The retained issue reached a state the parent does not continue; selection starts over.
      return selectFresh();
    }
    if (stage.value !== saved.stage) {
      // The parent's own publication advanced the issue to a later stage (or a human moved it).
      // That selection is finished; the issue competes again as a fresh candidate of its stage.
      return selectFresh();
    }
    return continueSelection(saved, issue);
  };
}
