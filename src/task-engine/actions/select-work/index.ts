import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { JiraAdapter, JiraIssue, JiraIssueQuery } from '../../../adapters/jira.js';
import { fault, messageOf, ok, type Result } from '../../../result.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../index.js';
import { readRecord, writeRecord } from '../records.js';
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
 * runs. Ideas and implementation/preparation work use separate configured queries, so an idea
 * cannot enter finite delivery directly; the mapped source status selects the stage. A missing
 * mapping for an observed candidate requests attention instead of silently skipping the stage.
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
  function fail(reason: string): 'failed' {
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
    if (status === settings.ideaStatuses.submitted) {
      return ok('idea');
    }
    if (preparation !== undefined) {
      if (status === preparation.requirements) {
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
   * The workspace this selection retains: the recorded workspace while it still exists, otherwise
   * the stable project/issue path. A pointer this action did not write is reported.
   */
  async function workspaceFor(issue: JiraIssue): Promise<Result<string>> {
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
    return ok((await isDirectory(recorded)) ? recorded : stableWorkspace(issue.key));
  }

  /** The parent handoff record for one issue workspace, created when it does not exist yet. */
  async function readHandoff(root: string): Promise<ParentHandoff | null> {
    const file = path.join(root, parentAreaDirectory, handoffFile);
    return readRecord(file, parentHandoffDeclaration);
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
   * the stage's active status. A missing permitted transition is reported.
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
        : stage === 'delivery'
          ? settings.statuses.inProgress
          : null;
    if (target === null || status === target) {
      // Preparation work runs in the mapped stage status itself; an interrupted claim of delivery
      // or idea work already moved the item, so the move is not repeated.
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
    const workspace = await workspaceFor(issue);
    if (!workspace.ok) {
      return fail(workspace.fault.message);
    }
    // Re-capture the issue and its complete attributed conversation, so human clarifications
    // added while the item waited for feedback govern the resumed work.
    const conversation = await readComments(jira, issue.id);
    await saveSelection({
      ...saved,
      task: issue,
      conversation,
      workspace: { root: workspace.value },
    });
    await retainHandoff(workspace.value, saved.stage);
    const problem = await claim(issue, saved.stage, workspace.value);
    if (problem !== null) {
      return fail(problem);
    }
    return selected(saved.taskKey, saved.stage);
  }

  /** Select one fresh eligible candidate from the configured ranked queues. */
  async function selectFresh(): Promise<string> {
    const ideaCandidates = await jira.searchIssues(settings.ideas);
    if (!ideaCandidates.ok) {
      throw new Error(ideaCandidates.fault.message);
    }
    const workCandidates = await jira.searchIssues(settings.selection);
    if (!workCandidates.ok) {
      throw new Error(workCandidates.fault.message);
    }
    // Both configured queues keep their own rank order; the parent walks them in step so neither
    // queue can starve the other.
    const candidates: { readonly id: string }[] = [];
    const longest = Math.max(ideaCandidates.value.length, workCandidates.value.length);
    for (let index = 0; index < longest; index += 1) {
      const idea = ideaCandidates.value[index];
      if (idea !== undefined) {
        candidates.push(idea);
      }
      const work = workCandidates.value[index];
      if (work !== undefined) {
        candidates.push(work);
      }
    }

    for (const candidate of candidates) {
      const first = await readIssue(jira, candidate.id);
      if (!isEligible(first)) {
        continue;
      }
      const firstStage = stageOf(statusNameOf(first) ?? '');
      if (!firstStage.ok) {
        return fail(firstStage.fault.message);
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
        return fail(currentStage.fault.message);
      }
      if (currentStage.value === null) {
        continue;
      }

      const workspace = await workspaceFor(current);
      if (!workspace.ok) {
        return fail(workspace.fault.message);
      }
      await saveSelection({
        taskKey: current.key,
        source: { kind: 'jira', issueId: current.id },
        task: current,
        conversation,
        workspace: { root: workspace.value },
        stage: currentStage.value,
      });
      await retainHandoff(workspace.value, currentStage.value);

      const problem = await claim(current, currentStage.value, workspace.value);
      if (problem !== null) {
        return fail(problem);
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
      return fail(stage.fault.message);
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
