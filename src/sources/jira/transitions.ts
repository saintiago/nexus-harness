/**
 * Claiming an issue: the transition discovery, the selection of the unique
 * transition whose target status is the configured one, and the request that
 * posts it.
 *
 * A transition is chosen by the status it reaches, never by a hard-coded
 * transition ID, and one that needs fields this connector cannot supply is a
 * limitation to report rather than something to guess around.
 */
import type { JiraSourceConfig } from '../../shared/types.js';
import { SourceError } from '../contract.js';
import type { SourceTask } from '../contract.js';
import type { HttpClient } from './http.js';
import { isEligible, malformed, readIssue, sameName } from './issue.js';
import { isRecord, nested, stringField } from './json.js';

/** One transition the workflow offers from the issue's current status. */
interface JiraTransition {
  readonly id: string;
  readonly name: string;
  readonly target: string;
  /** True when the workflow would require fields this connector cannot supply. */
  readonly needsFields: boolean;
}

export async function readTransitions(
  http: HttpClient,
  id: string,
  stop: AbortSignal,
): Promise<readonly JiraTransition[]> {
  const raw = await http.request({
    method: 'GET',
    path: `/rest/api/3/issue/${encodeURIComponent(id)}/transitions?expand=transitions.fields`,
    signal: stop,
  });
  if (!isRecord(raw) || !Array.isArray(raw['transitions'])) {
    throw malformed(`the transitions of issue ${id}`, 'no transitions array');
  }
  return raw['transitions'].map((value) => {
    if (!isRecord(value)) {
      throw malformed(`the transitions of issue ${id}`, 'a transition is not an object');
    }
    const transitionId = stringField(value, 'id');
    const name = stringField(value, 'name');
    const to = nested(value, 'to');
    const target = to === null ? null : stringField(to, 'name');
    if (transitionId === null || name === null || target === null) {
      throw malformed(`the transitions of issue ${id}`, 'a transition has no id, name, or target');
    }
    const fields = value['fields'];
    const needsFields =
      isRecord(fields) &&
      Object.values(fields).some((field) => isRecord(field) && field['required'] === true);
    return { id: transitionId, name, target, needsFields };
  });
}

/**
 * The unique transition whose *target status* is `target`, selected by status
 * name rather than by a transition ID, which belongs to a workflow and not to a
 * status. A missing, ambiguous, or required-field transition is a limitation to
 * report, not something to guess around (docs/architecture.md §9).
 */
export function selectTransition(
  transitions: readonly JiraTransition[],
  target: string,
  what: string,
): JiraTransition {
  const matches = transitions.filter((transition) => sameName(transition.target, target));
  if (matches.length === 0) {
    const available = transitions.map((transition) => `"${transition.target}"`).join(', ');
    throw new SourceError(
      'fatal',
      `${what}: the workflow offers no transition to the status "${target}"` +
        (transitions.length === 0 ? '' : `. Available targets: ${available}`),
    );
  }
  if (matches.length > 1) {
    throw new SourceError(
      'fatal',
      `${what}: ${String(matches.length)} transitions lead to the status "${target}", so which one ` +
        'to use is ambiguous',
    );
  }
  const [match] = matches;
  if (match === undefined) {
    throw new SourceError('fatal', `${what}: no transition to the status "${target}" was found`);
  }
  if (match.needsFields) {
    throw new SourceError(
      'fatal',
      `${what}: the transition "${match.name}" to the status "${target}" requires fields this ` +
        'harness cannot supply, so the workflow has to be changed or the issue moved by hand',
    );
  }
  return match;
}

export async function postTransition(
  http: HttpClient,
  id: string,
  transitionId: string,
  stop: AbortSignal,
): Promise<void> {
  await http.request({
    method: 'POST',
    path: `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
    body: { transition: { id: transitionId } },
    signal: stop,
    mutation: true,
  });
}

/**
 * Claims one prepared item: the eligibility and the captured revision are
 * rechecked, and only then is the transition to the running status requested.
 * `false` means no mutation request was sent, so the coordinator may release the
 * receipt it just created; once a request was sent, an error throws and the
 * receipt is retained.
 */
export async function claimItem(
  config: JiraSourceConfig,
  http: HttpClient,
  item: SourceTask,
  stop: AbortSignal,
): Promise<boolean> {
  const issue = await readIssue(http, item.ref.id, stop);
  if (issue === null || !isEligible(config, issue.fields)) {
    return false;
  }
  if (issue.fields.updated !== item.ref.updatedAt) {
    return false;
  }
  const what = `${item.ref.key}: claiming it`;
  const chosen = selectTransition(
    await readTransitions(http, item.ref.id, stop),
    config.runningStatus,
    what,
  );
  await postTransition(http, item.ref.id, chosen.id, stop);
  return true;
}
