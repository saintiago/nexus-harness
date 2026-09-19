/**
 * The Jira connector: the one implemented task source, built once per source
 * command from the validated configuration and the resolved token.
 *
 * Every method is a small function of the module that owns it; this file is the
 * wiring, and nothing else. It is the only module that knows all of them.
 */
import type { JiraSourceConfig } from '../../shared/types.js';
import type { TaskSource } from '../contract.js';
import { commentsSince, completeItem, progressItem, refuseItem } from './comments.js';
import { createHttpClient } from './http.js';
import type { HttpClient, JiraSourceParts } from './http.js';
import { recordWorkspacePointer } from './labels.js';
import { listEligibleIssues } from './search.js';
import { prepareItem } from './tasks.js';
import { claimItem } from './transitions.js';

/**
 * The Jira connector, built once per source command from the validated
 * configuration and the resolved token. The token lives in this closure: it is
 * not a property of the returned object, it is not written into a reference, and
 * it is stripped from the environment of anything the run starts.
 */
export function createJiraSource(
  config: JiraSourceConfig,
  token: string,
  parts: Partial<JiraSourceParts> = {},
  http: HttpClient = createHttpClient(config, token, parts),
): TaskSource {
  return {
    listEligible: (stop) => listEligibleIssues(config, http, stop),
    prepare: (candidate, stop) => prepareItem(config, http, candidate, stop),
    claim: (item, stop) => claimItem(config, http, item, stop),
    progress: (item, outcome, stop) => progressItem(http, token, item, outcome, stop),
    complete: (item, outcome, stop) => completeItem(config, http, token, item, outcome, stop),
    recordWorkspace: (item, workspaceId, stop) =>
      recordWorkspacePointer(http, item, workspaceId, stop),
    refuse: (item, reason, stop) => refuseItem(config, http, token, item, reason, stop),
    commentsSince: (item, since, stop) => commentsSince(http, token, item, since, stop),
  };
}
