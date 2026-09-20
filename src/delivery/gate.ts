/**
 * The two readings the completion path decides on, kept as plain functions so
 * they can be tested without a process: whether one pull request check is a
 * definitive failure, and which of the configured post-merge workflow runs is
 * the latest attempt and what it means.
 *
 * Nothing here starts a command, reads a credential, or knows about Jira. What
 * it says is exactly what GitHub reported: a check that is still queued is not a
 * failure, and a workflow run that has not appeared is not a pass.
 */

/**
 * One pull request check as `gh pr checks --json` reports it. `state` is the
 * check's own state (`SUCCESS`, `FAILURE`, `PENDING`, …) and `conclusion` is
 * how a completed check run ended; either may be absent.
 */
export interface CheckSnapshot {
  readonly name: string;
  readonly state: string | null;
  readonly conclusion: string | null;
  readonly link: string | null;
}

/** Conclusions that are not a success, whatever the upstream state calls them. */
const UNSUCCESSFUL = new Set([
  'FAILURE',
  'ERROR',
  'FAILED',
  'CANCELLED',
  'CANCELED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STALE',
  'STARTUP_FAILURE',
  'SKIPPED',
  'NEUTRAL',
]);

/** States that mean the check has not finished. */
const UNFINISHED = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

/** One check's state and conclusion, upper-cased: `null` when neither is set. */
function outcomeOf(check: CheckSnapshot): string | null {
  const conclusion = check.conclusion?.trim().toUpperCase() ?? '';
  const state = check.state?.trim().toUpperCase() ?? '';
  return conclusion !== '' ? conclusion : state === '' ? null : state;
}

/**
 * Whether one check is an unsuccessful result: completed with any conclusion
 * other than success, or in a state that is itself an unsuccessful ending. A
 * check that is still running is not one.
 */
export function checkFailed(check: CheckSnapshot): boolean {
  const outcome = outcomeOf(check);
  if (outcome === null || UNFINISHED.has(outcome)) {
    return false;
  }
  return outcome !== 'SUCCESS' && UNSUCCESSFUL.has(outcome);
}

/** Whether one check has not finished yet. */
export function checkPending(check: CheckSnapshot): boolean {
  const outcome = outcomeOf(check);
  if (outcome === null) {
    return false;
  }
  if (UNFINISHED.has(outcome)) {
    return true;
  }
  return !UNSUCCESSFUL.has(outcome) && outcome !== 'SUCCESS';
}

/** Whether one check is a completed success. */
export function checkPassed(check: CheckSnapshot): boolean {
  return outcomeOf(check) === 'SUCCESS';
}

/** One workflow run as `gh run list --json` reports it. */
export interface WorkflowRunSnapshot {
  readonly databaseId: number;
  readonly runAttempt?: number;
  readonly headBranch?: string;
  readonly workflowId: number;
  readonly workflowName: string;
  readonly path: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headSha: string;
  readonly url: string;
}

/**
 * Whether one run is the run one configured workflow identifier names.
 *
 * An identifier is an exact numeric workflow ID, or a stable file: the file name
 * (`ci.yml`) or the path under `.github/workflows` (`.github/workflows/ci.yml`).
 * A repository can hold two files of the same name in different folders, so a
 * file name matches only when exactly one configured identifier reaches it.
 */
export function workflowMatches(identifier: string, run: WorkflowRunSnapshot): boolean {
  const wanted = identifier.trim();
  if (wanted === '') {
    return false;
  }
  if (/^[0-9]+$/.test(wanted)) {
    return String(run.workflowId) === wanted;
  }
  const path = run.path.replace(/\\/g, '/').replace(/^\.\//, '');
  const file = path.split('/').at(-1) ?? path;
  const wantedPath = wanted.replace(/\\/g, '/').replace(/^\.\//, '');
  const wantedFile = wantedPath.split('/').at(-1) ?? wantedPath;
  // A bare file name names the workflow file wherever it lives, so it matches on
  // the file name alone. A path names where it lives, so it matches the whole
  // path, or a suffix of it once the leading `.github/workflows` is left out.
  if (!wantedPath.includes('/')) {
    return file === wantedFile;
  }
  return path === wantedPath || path.endsWith(`/${wantedPath}`);
}

/** What one configured workflow's latest attempt says. */
export type WorkflowState =
  /** No run for this workflow has appeared for the merge commit yet. */
  | 'pending'
  /** The latest attempt is still queued or running. */
  | 'running'
  /** The latest attempt completed successfully. */
  | 'success'
  /** The latest attempt completed with something other than success. */
  | 'unsuccessful';

/** One configured workflow and the latest run that answers for it. */
export interface WorkflowOutcome {
  readonly identifier: string;
  readonly state: WorkflowState;
  /** The latest attempt, when one has appeared; `null` when none has. */
  readonly run: WorkflowRunSnapshot | null;
  /** What the latest attempt concluded, upper-cased; `null` when it has not. */
  readonly conclusion: string | null;
}

/** How one configured workflow's runs, oldest first, are read. */
function outcomeFor(identifier: string, runs: readonly WorkflowRunSnapshot[]): WorkflowOutcome {
  const matching = runs.filter((run) => workflowMatches(identifier, run));
  if (matching.length === 0) {
    return { identifier, state: 'pending', run: null, conclusion: null };
  }
  // The latest attempt is the highest run ID: GitHub's run list is ordered, but
  // "latest" must not depend on that.
  const latest = matching.reduce((left, right) =>
    right.databaseId > left.databaseId ||
    (right.databaseId === left.databaseId && (right.runAttempt ?? 1) > (left.runAttempt ?? 1))
      ? right
      : left,
  );
  const status = latest.status.trim().toLowerCase();
  if (status !== 'completed') {
    return {
      identifier,
      state:
        status === 'queued' || status === 'requested' || status === 'waiting'
          ? 'pending'
          : 'running',
      run: latest,
      conclusion: null,
    };
  }
  const conclusion = latest.conclusion?.trim().toUpperCase() ?? '';
  return {
    identifier,
    state:
      conclusion === 'SUCCESS'
        ? 'success'
        : UNSUCCESSFUL.has(conclusion)
          ? 'unsuccessful'
          : 'running',
    run: latest,
    conclusion: conclusion === '' ? null : conclusion,
  };
}

/**
 * Every configured workflow's latest attempt, in the configured order. Only the
 * latest run per workflow is read: an earlier failed attempt that a later one
 * superseded is not the state of the merge commit.
 */
export function workflowOutcomes(
  identifiers: readonly string[],
  runs: readonly WorkflowRunSnapshot[],
): readonly WorkflowOutcome[] {
  return identifiers.map((identifier) => outcomeFor(identifier, runs));
}
