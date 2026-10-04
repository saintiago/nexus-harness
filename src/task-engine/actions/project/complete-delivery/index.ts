import type { JiraAdapter } from '../../../../adapters/jira.js';
import type { BoundAction, EventPublisher } from '../../../index.js';
import { readIssue, statusNameOf, transitionInto, applyTransition } from '../../source.js';
import { readSelection } from '../state.js';

/**
 * CompleteDelivery is the parent-owned completion of one finite-delivery child: after the child
 * returned its confirmed merge/check evidence, the parent moves the ticket to the configured Done
 * status. Only the review status the parent's own publication left behind (or a repeated Done) may
 * be closed: an unexpected human pause or reroute is preserved instead of overwritten. The child's
 * evidence is already saved; a missing permitted transition is a failed publication the parent
 * reports for attention.
 */

export type CompleteDeliverySettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
  /** The configured Jira status the completed task holds. */
  readonly doneStatus: string;
  /** The configured review status delivery publication left the task in. */
  readonly reviewStatus: string;
  readonly jira: JiraAdapter;
  readonly publish: EventPublisher;
};

/** Create the parent-owned delivery completion. */
export function createCompleteDelivery(settings: CompleteDeliverySettings): BoundAction {
  return async () => {
    const selection = await readSelection(settings.selectionFile);

    /** Report a source condition that prevents completion. */
    function failed(reason: string): 'failed' {
      settings.publish({ source: 'complete-delivery', type: 'failed', data: { reason } });
      return 'failed';
    }

    const issue = await readIssue(settings.jira, selection.source.issueId);
    const status = statusNameOf(issue);
    if (status === settings.doneStatus) {
      // A repeated completion reuses the already-applied status.
      return 'completed';
    }
    if (status !== settings.reviewStatus) {
      return failed(
        `Issue ${selection.taskKey} is in status "${status ?? 'unknown'}" while completion ` +
          `expected the retained review status "${settings.reviewStatus}"; an unexpected human ` +
          'change is preserved instead of overwritten.',
      );
    }
    const transition = await transitionInto(settings.jira, issue, settings.doneStatus);
    if (transition.kind === 'blocked') {
      return failed(transition.reason);
    }
    await applyTransition(settings.jira, issue.id, transition.transition);
    settings.publish({
      source: 'complete-delivery',
      type: 'completed',
      data: { task: selection.taskKey, status: settings.doneStatus },
    });
    return 'completed';
  };
}
