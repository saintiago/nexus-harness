/**
 * Mapping one Jira issue onto the existing four-field `Task`, or refusing it as
 * a per-issue input error.
 *
 * The key, the summary, and the supported description format are the only
 * inputs; nothing is inferred, and the mapped object is validated by the same
 * task schema a task file goes through.
 */
import { taskSchema } from '../../config/schema.js';
import type { JiraSourceConfig, Task } from '../../shared/types.js';
import { SourceError } from '../contract.js';
import { parseWorkspacePointers } from '../contract.js';
import type { SourceCandidate, SourceTask } from '../contract.js';
import { AdfError, parseDescription } from './adf.js';
import { extractAcceptanceCriteria, renderDescription } from './adf-text.js';
import type { HttpClient } from './http.js';
import { isEligible, readIssue, refFor } from './issue.js';
import type { JiraIssue } from './issue.js';

/** The one message a per-issue input error carries. */
export function invalidTask(key: string, problem: string): SourceError {
  return new SourceError('invalid-task', `${key}: ${problem}`);
}

/**
 * Maps one issue onto the existing four-field `Task`, or refuses it.
 *
 * The key, the summary, and the supported description format are the only
 * inputs. Nothing is inferred, no attachment or comment is fetched, and the
 * mapped object is validated by the same task schema a task file goes through
 * (docs/WORKFLOW.md §6).
 */
export function mapTask(issue: JiraIssue): Task {
  const key = issue.key;
  const title = issue.fields.summary.trim();
  if (title === '') {
    throw invalidTask(key, 'its summary is blank, so the task would have no title');
  }
  if (issue.fields.description === undefined || issue.fields.description === null) {
    throw invalidTask(
      key,
      'it has no description, so there is no task text and no acceptance criteria',
    );
  }

  let document;
  let description: string;
  let acceptanceCriteria: readonly string[];
  try {
    document = parseDescription(issue.fields.description);
    description = renderDescription(document);
    acceptanceCriteria = extractAcceptanceCriteria(document);
  } catch (cause) {
    if (cause instanceof AdfError) {
      throw invalidTask(key, cause.message);
    }
    throw cause;
  }

  if (description === '') {
    throw invalidTask(key, 'its description is empty');
  }

  const mapped = { id: key, title, description, acceptanceCriteria };
  const validated = taskSchema.safeParse(mapped);
  if (!validated.success) {
    const problems = validated.error.issues
      .map((issue) =>
        issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
      )
      .join('; ');
    throw invalidTask(key, `its description does not map to a valid task (${problems})`);
  }
  return validated.data;
}

/**
 * Prepares one candidate as a task: the issue is re-read, eligibility is tested
 * again, and the four-field task is mapped and validated. `null` means the item
 * is no longer eligible; an item that is real but unusable is an
 * `invalid-task` error naming the issue.
 */
export async function prepareItem(
  config: JiraSourceConfig,
  http: HttpClient,
  candidate: SourceCandidate,
  stop: AbortSignal,
): Promise<SourceTask | null> {
  const issue = await readIssue(http, candidate.ref.id, stop);
  if (issue === null || !isEligible(config, issue.fields)) {
    return null;
  }
  const task = mapTask(issue);
  // The reference returned with the task carries the revision this reading
  // observed, so the claim can refuse an issue that changed again in between. The
  // pointers come from this same reading, so the continuation decision never runs
  // on a search result that has since been overtaken.
  return {
    ref: refFor(config, issue),
    task,
    pointers: parseWorkspacePointers(issue.fields.labels),
    // The ticket's canonical key names the workspace a first attempt creates,
    // so retained work is recognizable in the filesystem and in a terminal as
    // the ticket it belongs to. It is a preference: the naming layer validates
    // it and falls back to the run's own generated id, and the immutable id
    // above stays the ownership authority (docs/implement-workspace-continuation.md).
    preferredWorkspaceId: issue.key,
  } satisfies SourceTask;
}
