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
import { selectionDeclaration, type Selection } from './artifacts.js';

/**
 * SelectTask selects one eligible task in configured source rank order and retains its identity,
 * complete source input and workspace reference for the workflow. It saves the selection before
 * claiming the task, finishes an incomplete claim or continues the retained unfinished task before
 * selecting unrelated work, and reuses retained work only while its workspace still exists.
 *
 * Source access failures are execution errors. An observed task condition that prevents selection
 * is a failed outcome whose reason is published for recovery.
 */

export type SelectTaskSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The absolute root under which task workspaces live. */
  readonly workspaceRoot: string;
  /** The configured project identity; workspace paths distinguish projects as well as tasks. */
  readonly project: string;
  /** The configured candidate query and source rank ordering. */
  readonly selection: JiraIssueQuery;
  /** The configured source statuses selection reads and claims through. */
  readonly statuses: {
    readonly ready: string;
    readonly inProgress: string;
    readonly review: string;
    readonly done: string;
  };
  /** The configured Jira field that retains a task's workspace root. */
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

/** True for an issue satisfying the required details and the configured eligibility condition. */
function isEligible(issue: JiraIssue, readyStatus: string): boolean {
  return (
    text(issue.fields.summary) !== null &&
    hasDescription(issue.fields) &&
    statusNameOf(issue) === readyStatus
  );
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

/** Create SelectTask over the configured source, workspace root and selection-file location. */
export function createSelectTask(settings: SelectTaskSettings): BoundAction {
  const { jira, publish } = settings;

  /** Report a task condition that prevents selection. */
  function fail(reason: string): 'failed' {
    publish({ source: 'select-task', type: 'failed', data: { reason } });
    return 'failed';
  }

  /** Report the selected outcome referencing the saved selection record. */
  function selected(taskKey: string): 'selected' {
    publish(
      actionOutcomeEvent('select-task', {
        task: taskKey,
        round: null,
        outcome: 'selected',
        detail: null,
        artifact: { path: settings.selectionFile },
      }),
    );
    return 'selected';
  }

  /** The stable project/task workspace path under the configured root. */
  function stableWorkspace(taskKey: string): string {
    return path.join(settings.workspaceRoot, settings.project, taskKey);
  }

  /**
   * The workspace this selection retains: the recorded workspace while it still exists, otherwise
   * the stable project/task path. A pointer this action did not write is reported.
   */
  async function workspaceFor(issue: JiraIssue): Promise<Result<string>> {
    const recorded = issue.fields[settings.workspacePointerField];
    if (recorded === undefined || recorded === null || recorded === '') {
      return ok(stableWorkspace(issue.key));
    }
    if (typeof recorded !== 'string' || !path.isAbsolute(recorded)) {
      return fault(
        `Task ${issue.key} records an unexpected workspace pointer in ` +
          `"${settings.workspacePointerField}"; selection does not overwrite it.`,
      );
    }
    return ok((await isDirectory(recorded)) ? recorded : stableWorkspace(issue.key));
  }

  /** Point the task at its retained workspace, updating the source field when it differs. */
  async function retainWorkspace(issue: JiraIssue, workspaceRoot: string): Promise<void> {
    if (issue.fields[settings.workspacePointerField] === workspaceRoot) {
      return;
    }
    await updateIssueFields(jira, issue.id, { workspacePointer: workspaceRoot });
  }

  /**
   * Claim the task after its selection was saved: retain the workspace reference and move the task
   * into the configured in-progress status. A missing permitted transition is reported.
   */
  async function claim(issue: JiraIssue, workspaceRoot: string): Promise<string | null> {
    await retainWorkspace(issue, workspaceRoot);
    const transition = await transitionInto(jira, issue, settings.statuses.inProgress);
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

  /** Continue the retained task, finishing an unfinished claim or its workspace reference. */
  async function continueSelection(
    saved: Selection,
    issue: JiraIssue,
    status: string,
  ): Promise<string> {
    const workspace = await workspaceFor(issue);
    if (!workspace.ok) {
      return fail(workspace.fault.message);
    }
    if (workspace.value !== saved.workspace.root) {
      await saveSelection({ ...saved, workspace: { root: workspace.value } });
    }
    if (status === settings.statuses.ready) {
      const problem = await claim(issue, workspace.value);
      if (problem !== null) {
        return fail(problem);
      }
    } else {
      await retainWorkspace(issue, workspace.value);
    }
    return selected(saved.taskKey);
  }

  /** Select one fresh eligible candidate from the current source order. */
  async function selectFresh(): Promise<string> {
    const candidates = await jira.searchIssues(settings.selection);
    if (!candidates.ok) {
      throw new Error(candidates.fault.message);
    }

    for (const candidate of candidates.value) {
      const first = await readIssue(jira, candidate.id);
      if (!isEligible(first, settings.statuses.ready)) {
        continue;
      }

      const conversation = await readComments(jira, candidate.id);
      // Re-read the issue before claiming so an intervening human change is preserved.
      const current = await readIssue(jira, candidate.id);
      if (!isEligible(current, settings.statuses.ready)) {
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
      });

      const problem = await claim(current, workspace.value);
      if (problem !== null) {
        return fail(problem);
      }
      return selected(current.key);
    }
    return 'empty';
  }

  return async () => {
    const saved = await readRecord(settings.selectionFile, selectionDeclaration);
    if (saved === null) {
      return selectFresh();
    }

    const issue = await readIssue(jira, saved.source.issueId);
    const status = statusNameOf(issue);
    if (status === settings.statuses.done) {
      // The retained task is complete; its workspace remains as history and selection starts over.
      return selectFresh();
    }
    if (status === null) {
      return fail(`Task ${saved.taskKey} has no readable status; selection is not overwritten.`);
    }
    if (
      status !== settings.statuses.ready &&
      status !== settings.statuses.inProgress &&
      status !== settings.statuses.review
    ) {
      return fail(`Task ${saved.taskKey} is in status "${status}"; selection is not overwritten.`);
    }
    return continueSelection(saved, issue, status);
  };
}
