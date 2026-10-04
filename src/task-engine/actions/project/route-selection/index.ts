import { readRequiredRecord } from '../../records.js';
import { selectionDeclaration } from '../../select-task/artifacts.js';
import type { BoundAction } from '../../../index.js';

/**
 * RouteSelection reads the parent's saved selection and reports the stage whose child should run.
 * The stage is captured with the selection and updated by the parent's own publications, so an
 * interrupted parent restores its active child instead of re-deciding the route from Jira.
 */

export type RouteSelectionSettings = {
  /** The absolute selection-file path beside the queue's workflow-state file. */
  readonly selectionFile: string;
};

/** Create RouteSelection over the retained selection record. */
export function createRouteSelection(settings: RouteSelectionSettings): BoundAction {
  return async () => {
    const selection = await readRequiredRecord(
      settings.selectionFile,
      selectionDeclaration,
      'Selection',
    );
    return selection.stage;
  };
}
