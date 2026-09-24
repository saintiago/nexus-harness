import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitAdapter } from '../../../adapters/git.js';
import type {
  JiraAdapter,
  JiraIssue,
  JiraIssueQuery,
  JiraTransition,
} from '../../../adapters/jira.js';
import { fault, messageOf, ok, type Result } from '../../../result.js';
import { actionOutcomeEvent, type BoundAction, type EventPublisher } from '../../index.js';
import { listIdeaSubmissions, submissionDecided } from '../idea-storage.js';
import { readRecord, writeRecord } from '../records.js';
import { capturedTransition, readComments, readIssue, statusNameOf } from '../source.js';
import { ideaSelectionDeclaration, type IdeaSelection } from './artifacts.js';

/**
 * SelectIdea selects one eligible submitted idea and retains its identity, its complete captured
 * source input and its shared issue workspace. It reads the issue and its conversation once, saves
 * that input, moves the item into the configured active status and prepares the refinement area's
 * Git worktree before any agent runs. The same path handles a first submission and a resubmission
 * after human feedback: both enter from the configured submitted status.
 *
 * Source access failures are execution errors. A condition that prevents selection is a failed
 * outcome whose reason is published for recovery.
 */

export type SelectIdeaSettings = {
  /** The absolute selection-file path beside the idea-refinement workflow-state file. */
  readonly selectionFile: string;
  /** The absolute root under which issue workspaces live. */
  readonly workspaceRoot: string;
  /** The configured project identity; workspace paths distinguish projects as well as issues. */
  readonly project: string;
  /** The configured idea candidate query and source rank ordering. */
  readonly selection: JiraIssueQuery;
  /** The configured statuses an idea enters from and is claimed into. */
  readonly statuses: {
    readonly submitted: string;
    readonly active: string;
  };
  /** The configured Jira field that retains an issue's shared workspace root. */
  readonly workspacePointerField: string;
  /** The configured repository source the refinement worktree is prepared from. */
  readonly repository: {
    readonly source: string;
    readonly mainBranch: string;
  };
  readonly jira: JiraAdapter;
  readonly git: GitAdapter;
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

/** True for an issue satisfying the required details and the configured submitted status. */
function isSubmitted(issue: JiraIssue, submittedStatus: string): boolean {
  return (
    text(issue.fields.summary) !== null &&
    hasDescription(issue.fields) &&
    statusNameOf(issue) === submittedStatus
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

/** Create SelectIdea over the configured source, workspace root and refinement repository. */
export function createSelectIdea(settings: SelectIdeaSettings): BoundAction {
  const { jira, publish } = settings;

  /** Report a condition that prevents selection. */
  function fail(reason: string): 'failed' {
    publish({ source: 'select-idea', type: 'failed', data: { reason } });
    return 'failed';
  }

  /** Report the selected outcome referencing the saved selection record. */
  function selected(taskKey: string): 'selected' {
    publish(
      actionOutcomeEvent('select-idea', {
        task: taskKey,
        round: null,
        outcome: 'selected',
        detail: null,
        artifact: { path: settings.selectionFile },
      }),
    );
    return 'selected';
  }

  /** The stable shared issue workspace path under the configured root. */
  function stableIssueWorkspace(taskKey: string): string {
    return path.join(settings.workspaceRoot, settings.project, taskKey);
  }

  /**
   * The shared issue workspace this selection retains: the recorded pointer while it still exists,
   * otherwise the stable project/issue path. The refinement area is its child.
   */
  async function issueWorkspaceFor(issue: JiraIssue): Promise<Result<string>> {
    const recorded = issue.fields[settings.workspacePointerField];
    if (recorded === undefined || recorded === null || recorded === '') {
      return ok(stableIssueWorkspace(issue.key));
    }
    if (typeof recorded !== 'string' || !path.isAbsolute(recorded)) {
      return fault(
        `Idea ${issue.key} records an unexpected workspace pointer in ` +
          `"${settings.workspacePointerField}"; selection does not overwrite it.`,
      );
    }
    return ok((await isDirectory(recorded)) ? recorded : stableIssueWorkspace(issue.key));
  }

  /** Point the issue at its shared workspace root, updating the source field when it differs. */
  async function retainWorkspace(issue: JiraIssue, issueRoot: string): Promise<void> {
    if (issue.fields[settings.workspacePointerField] === issueRoot) {
      return;
    }
    const updated = await jira.updateFields(issue.id, { workspacePointer: issueRoot });
    if (!updated.ok) {
      throw new Error(updated.fault.message);
    }
  }

  /** Save the selection before any source claim is attempted. */
  async function saveSelection(selection: IdeaSelection): Promise<void> {
    await mkdir(path.dirname(settings.selectionFile), { recursive: true });
    await writeRecord(settings.selectionFile, selection);
  }

  /** The permitted transition moving one issue into the named status, or why none is. */
  async function transitionInto(issue: JiraIssue, status: string): Promise<Result<JiraTransition>> {
    const transitions = await jira.readTransitions(issue.id);
    if (!transitions.ok) {
      throw new Error(transitions.fault.message);
    }
    const transition = transitions.value.find((candidate) => candidate.to.name === status);
    if (transition === undefined) {
      return fault(
        `No permitted Jira transition moves ${issue.key} from ` +
          `${statusNameOf(issue) ?? 'its current status'} to "${status}".`,
      );
    }
    return ok(transition);
  }

  /**
   * Claim the captured item: move it into the active status and record the transitions available
   * from it, so publication uses the selection snapshot instead of reading the issue again. The
   * supplied status is what the caller observed; an item already in the active status was moved by
   * an interrupted attempt of this selection, so the move is not repeated.
   */
  async function claim(selection: IdeaSelection, status: string): Promise<Result<IdeaSelection>> {
    const toActive = capturedTransition(selection.transitions.toActive);
    if (toActive === null) {
      return fault(
        `The selection for ${selection.taskKey} records no move into the active status.`,
      );
    }
    if (status !== settings.statuses.active) {
      if (status !== settings.statuses.submitted) {
        return fault(
          `Idea ${selection.taskKey} is in status "${status}"; this selection cannot claim it.`,
        );
      }
      const applied = await jira.transitionIssue(selection.source.issueId, toActive.id);
      if (!applied.ok) {
        throw new Error(applied.fault.message);
      }
    }
    const available = await jira.readTransitions(selection.source.issueId);
    if (!available.ok) {
      throw new Error(available.fault.message);
    }
    return ok({
      ...selection,
      transitions: { toActive, fromActive: [...available.value] },
      claimed: true,
    });
  }

  /**
   * Prepare the refinement area's project worktree. An existing checkout of the configured
   * repository is refreshed on its clean main branch; a missing one is cloned. Repository
   * conditions return the reason readiness failed instead of throwing.
   */
  async function prepareWorktree(refinementRoot: string): Promise<string | null> {
    const { source, mainBranch } = settings.repository;
    const worktree = path.join(refinementRoot, 'worktree');
    await mkdir(refinementRoot, { recursive: true });
    if (!(await isDirectory(worktree))) {
      const cloned = await settings.git.cloneRepository(source, worktree);
      if (!cloned.ok) {
        return cloned.fault.message;
      }
      return cloned.value.remoteUrl === source
        ? null
        : `The prepared worktree belongs to "${cloned.value.remoteUrl ?? 'no remote'}", not to "${source}".`;
    }
    const inspection = await settings.git.inspectRepository(worktree);
    if (!inspection.ok) {
      return inspection.fault.message;
    }
    if (inspection.value.remoteUrl !== source) {
      return (
        `The worktree at "${worktree}" belongs to ` +
        `"${inspection.value.remoteUrl ?? 'no remote'}", not to "${source}".`
      );
    }
    if (inspection.value.branch !== mainBranch || inspection.value.trackedChanges) {
      // A checkout Nexus did not leave clean on the configured main branch is not updated.
      return null;
    }
    const pulled = await settings.git.pullBranch(worktree, 'origin', mainBranch);
    return pulled.ok ? null : pulled.fault.message;
  }

  /** Finish a retained selection: complete an unfinished claim and prepare the worktree. */
  async function continueSelection(saved: IdeaSelection): Promise<string> {
    let selection = saved;
    if (!selection.claimed) {
      // The claim was not recorded, so read the item's actual status and workspace pointer before
      // completing it. The pointer update is part of the claim: an interrupted attempt that failed
      // it is completed here instead of leaving the shared issue root unrecorded.
      const issue = await readIssue(jira, selection.source.issueId);
      await retainWorkspace(issue, selection.issueWorkspace.root);
      const claimed = await claim(selection, statusNameOf(issue) ?? '');
      if (!claimed.ok) {
        return fail(claimed.fault.message);
      }
      selection = claimed.value;
      await saveSelection(selection);
    }
    const problem = await prepareWorktree(selection.workspace.root);
    if (problem !== null) {
      return fail(problem);
    }
    return selected(selection.taskKey);
  }

  /** Capture one fresh submitted idea from the current source order. */
  async function selectFresh(): Promise<string> {
    const candidates = await jira.searchIssues(settings.selection);
    if (!candidates.ok) {
      throw new Error(candidates.fault.message);
    }

    for (const candidate of candidates.value) {
      const issue = await readIssue(jira, candidate.id);
      if (!isSubmitted(issue, settings.statuses.submitted)) {
        continue;
      }
      const conversation = await readComments(jira, candidate.id);
      const toActive = await transitionInto(issue, settings.statuses.active);
      if (!toActive.ok) {
        return fail(toActive.fault.message);
      }
      const issueRoot = await issueWorkspaceFor(issue);
      if (!issueRoot.ok) {
        return fail(issueRoot.fault.message);
      }
      // The shared issue root and its refinement area exist before the claim is recorded.
      const refinementRoot = path.join(issueRoot.value, 'refinement');
      await mkdir(refinementRoot, { recursive: true });

      const captured: IdeaSelection = {
        taskKey: issue.key,
        source: { kind: 'jira', issueId: issue.id },
        issue,
        conversation,
        transitions: { toActive: toActive.value, fromActive: [] },
        claimed: false,
        // The submission this selection opens is the next retained number, so an earlier
        // submission's decision never finishes this selection.
        retainedSubmissions: (await listIdeaSubmissions(refinementRoot)).at(-1) ?? 0,
        workspace: { root: refinementRoot },
        issueWorkspace: { root: issueRoot.value },
      };
      await saveSelection(captured);
      await retainWorkspace(issue, issueRoot.value);

      const claimed = await claim(captured, settings.statuses.submitted);
      if (!claimed.ok) {
        return fail(claimed.fault.message);
      }
      await saveSelection(claimed.value);
      const problem = await prepareWorktree(refinementRoot);
      if (problem !== null) {
        return fail(problem);
      }
      return selected(claimed.value.taskKey);
    }
    return 'empty';
  }

  /**
   * True when this retained selection's own submission already reached a decision. The
   * refinement area may hold earlier submissions the item decided before this entry; only a
   * submission opened after this selection captured the item finishes it.
   */
  async function selectionDecided(selection: IdeaSelection): Promise<boolean> {
    const latest = (await listIdeaSubmissions(selection.workspace.root)).at(-1);
    return (
      latest !== undefined &&
      latest > selection.retainedSubmissions &&
      (await submissionDecided(selection.workspace.root, latest))
    );
  }

  return async () => {
    const saved = await readRecord(settings.selectionFile, ideaSelectionDeclaration);
    if (saved !== null && !(await selectionDecided(saved))) {
      // Unfinished work of this execution: its captured input stays authoritative and the item is
      // not read or claimed again. A selection whose own submission already decided is finished,
      // so the next entry selects from the source again.
      return continueSelection(saved);
    }
    return selectFresh();
  };
}
