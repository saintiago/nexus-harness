/**
 * The optional review-to-completion path: from a reviewed pull request the Nexus
 * Lens reviewer approved, through native GitHub auto-merge, to the configured
 * post-merge workflows on the merge commit.
 *
 * Five rules keep it the small, deterministic step it is meant to be:
 *
 * - The reviewer credential is its own environment variable and is used only to
 *   read the reviewer's verdict. The operator's `gh`/Git credential is what asks
 *   GitHub to enable auto-merge, so the reviewer can never widen its own gate.
 * - Nothing here merges a pull request. `gh pr merge --auto --squash` asks GitHub
 *   to merge once branch protection and every required check allow it; GitHub
 *   performs the merge, and only GitHub's own merged state is trusted.
 * - The reviewed head is re-read immediately before every mutation, and GitHub's
 *   report of the merge must still name that head. A pull request whose head
 *   moved is not the reviewed work.
 * - Every merge and post-merge reading is a fresh read of GitHub. An armed
 *   auto-merge request, a pending check, or a workflow that has not appeared yet
 *   proves nothing, and "not yet" is never reported as a failure.
 * - A conclusion is a fact: a post-merge workflow that ended unsuccessful is
 *   reported as that, with its own conclusion, and the merge is never rolled
 *   back to make the result look different.
 *
 * The `gh` command is the outward boundary, exactly as in `github.ts`: tests
 * point it at a stand-in program, and nothing else about this module changes.
 */
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { runCommand } from '../process/command.js';
import { messageOf } from '../shared/errors.js';
import type { CompletionConfig, SourceRef } from '../shared/types.js';
import { gitInvocationEnvironment } from '../workspace/git.js';
import { DeliveryError } from './github.js';
import type { CheckSnapshot, WorkflowRunSnapshot, WorkflowOutcome } from './gate.js';
import {
  checkFailed,
  checkPassed,
  checkPending,
  workflowMatches,
  workflowOutcomes,
} from './gate.js';

export type { WorkflowOutcome } from './gate.js';

/** How long one `gh` command may run before the harness stops it. */
export const COMPLETION_COMMAND_TIMEOUT_MS = 5 * 60_000;

/** How much of what a command said a failure message carries. */
const DIAGNOSTIC_LIMIT = 400;

/** One pull request request as the completion path found it. */
export interface CompletionRequest {
  readonly ref: SourceRef;
  readonly workspaceId: string;
  /** Where the delivered branch lives on GitHub, from the delivery selection. */
  readonly repository: string;
  readonly branch: string;
  readonly baseBranch: string;
  /** The retained working copy, which is the working directory of every command. */
  readonly workspacePath: string;
  /** The run's `<runDir>/logs`, where this step's command output is kept. */
  readonly logsDir: string;
}

/** One pull request as GitHub reports it now. */
export interface PullRequestSnapshot {
  readonly number: number;
  readonly url: string;
  /** GitHub's native state: `OPEN`, `CLOSED`, or `MERGED`. */
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly mergeCommit: { readonly oid: string } | null;
}

/** One pull request review as GitHub reports it. */
export interface ReviewSnapshot {
  readonly id: string;
  readonly author: string;
  readonly state: string;
  /** The review's own text, as the reviewer wrote it. */
  readonly body: string;
  /** The commit the review was submitted against; `null` when GitHub reports none. */
  readonly commitId: string | null;
  readonly url: string;
}

/** What one reading of the gate found. */
export type GateStatus =
  /** Every artifact is the current head's and the reviewer approved it. */
  | 'approved'
  /** Everything is the current head's, but a required artifact is still running. */
  | 'pending'
  /** The current head's evidence is conclusive: the work is not approved. */
  | 'failed'
  /** Inconclusive: a human has to look, and nothing may be armed or marked. */
  | 'attention';

/** One conclusive finding, as the Jira comment names it. */
export interface GateFinding {
  /** A short label: the check's name, or the reviewer's decision. */
  readonly label: string;
  /** One bounded line about what was observed. */
  readonly detail: string;
  /** Where the finding can be read on GitHub. */
  readonly link: string;
}

/** The gate's reading of one pull request. */
export interface GateVerdict {
  readonly status: GateStatus;
  /** Why, in one bounded line: what the Jira comment and the terminal say. */
  readonly reason: string;
  /** The approval that let the path proceed, when it did. */
  readonly review: ReviewSnapshot | null;
  /** The findings that took the ticket back to its To Do status. */
  readonly findings: readonly GateFinding[];
}

/** What one post-merge reading found. */
export type MergeStatus =
  /** GitHub has not reported the pull request merged yet. */
  | 'pending'
  /** The pull request merged, but the configured post-merge workflows have not. */
  | 'workflows-pending'
  /** The merge is confirmed and every configured workflow succeeded. */
  | 'complete'
  /** The merge is confirmed and at least one workflow ended unsuccessfully. */
  | 'workflows-unsuccessful';

/** The post-merge reading of one pull request. */
export interface MergeVerdict {
  readonly status: MergeStatus;
  /** Why, in one bounded line. */
  readonly reason: string;
  /** The confirmed merge commit, when GitHub reported one. */
  readonly mergeCommit: string | null;
  /** Every configured workflow and its latest attempt. */
  readonly workflows: readonly WorkflowOutcome[];
}

/** What enabling native auto-merge did. */
export type AutoMergeStatus = 'enabled' | 'already-enabled';

/** The GitHub boundary the completion path acts through. */
export interface CompletionActions {
  /**
   * The one open pull request for this exact repository, head, and base.
   * `null` when none is open. A closed, merged, or ambiguous answer is refused:
   * the caller must not guess which pull request was delivered.
   */
  findPullRequest(
    request: CompletionRequest,
    stop: AbortSignal,
  ): Promise<PullRequestSnapshot | null>;
  /**
   * One pull request by its number, whatever its state. This is how a pass that
   * already armed auto-merge finds the merge after GitHub has taken the pull
   * request out of the open list.
   */
  findMergedPullRequest(
    request: CompletionRequest,
    number: number,
    stop: AbortSignal,
  ): Promise<PullRequestSnapshot>;
  /**
   * What the current-head review and check evidence says, for the pull request
   * this request names. The head is re-read inside this call, so the verdict is
   * about the commit GitHub holds now.
   */
  readGate(
    request: CompletionRequest,
    pull: PullRequestSnapshot,
    stop: AbortSignal,
  ): Promise<GateVerdict>;
  /**
   * The commit the Nexus Lens reviewer approved, read with the reviewer's own
   * credential, or `null` when the thread holds no completed approval. This is
   * what names the reviewed work of a pull request GitHub has already merged,
   * where a review of anything but the merged head means the merge is not the
   * merge this path may conclude.
   */
  readApprovedHead(
    request: CompletionRequest,
    pull: PullRequestSnapshot,
    stop: AbortSignal,
  ): Promise<string | null>;
  /** GitHub's merged state and the configured post-merge workflow runs. */
  readMerge(
    request: CompletionRequest,
    pull: PullRequestSnapshot,
    reviewedHead: string,
    stop: AbortSignal,
  ): Promise<MergeVerdict>;
  /**
   * Ask GitHub to enable native auto-merge for this pull request, re-reading the
   * head immediately before the request. Throws {@link DeliveryError} when
   * GitHub refuses it — a conflict, branch protection, or a missing permission
   * is an operator problem, never a coding finding.
   */
  enableAutoMerge(
    request: CompletionRequest,
    pull: PullRequestSnapshot,
    reviewedHead: string,
    stop: AbortSignal,
  ): Promise<AutoMergeStatus>;
}

/** The pieces a caller may stand in for; production supplies none of them. */
export interface GitHubCompletionParts {
  /** The GitHub CLI to run. Defaults to `gh` from `PATH`. */
  readonly command?: string;
  /** What the operator's own commands inherit. Defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
}

/** One JSON object `gh` answered with, or a refusal naming what it said. */
function parseObject(output: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (cause) {
    throw new DeliveryError(
      `${what} did not answer with JSON (${messageOf(cause)}): ` +
        `${JSON.stringify(output.trim().slice(0, DIAGNOSTIC_LIMIT))}.`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryError(`${what} did not answer with a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** One JSON array `gh` answered with, or a refusal naming what it said. */
function parseArray(output: string, what: string): readonly unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (cause) {
    throw new DeliveryError(
      `${what} did not answer with JSON (${messageOf(cause)}): ` +
        `${JSON.stringify(output.trim().slice(0, DIAGNOSTIC_LIMIT))}.`,
    );
  }
  if (!Array.isArray(value)) {
    throw new DeliveryError(`${what} did not answer with a JSON array.`);
  }
  return value;
}

function textField(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === 'string' ? value : null;
}

function booleanField(source: Record<string, unknown>, field: string): boolean {
  return source[field] === true;
}

/** One field the completion path cannot decide without. */
function required(cause: DeliveryError | null): never {
  throw cause ?? new DeliveryError('a required field of a GitHub answer was missing.');
}

/** The pull request one `gh pr view --json` answer describes, or a refusal. */
function pullFrom(value: Record<string, unknown>, where: string): PullRequestSnapshot {
  const number = value['number'];
  const url = textField(value, 'url');
  const state = textField(value, 'state');
  const headRefName = textField(value, 'headRefName');
  const baseRefName = textField(value, 'baseRefName');
  const headRefOid = textField(value, 'headRefOid');
  if (
    typeof number !== 'number' ||
    url === null ||
    state === null ||
    headRefName === null ||
    baseRefName === null ||
    headRefOid === null
  ) {
    required(
      new DeliveryError(
        `${where} did not carry the pull request number, URL, state, head, or base, so this ` +
          'harness cannot tell which pull request it is.',
      ),
    );
  }
  const merge = value['mergeCommit'];
  const mergeCommit =
    typeof merge === 'object' && merge !== null && !Array.isArray(merge)
      ? (() => {
          const oid = textField(merge as Record<string, unknown>, 'oid');
          return oid === null ? null : { oid };
        })()
      : null;
  return {
    number,
    url,
    state,
    isDraft: booleanField(value, 'isDraft'),
    headRefName,
    baseRefName,
    headRefOid,
    mergeCommit,
  };
}

/** One review one `gh pr reviews --json` entry describes, or `null` for an entry that is not one. */
function reviewFrom(value: unknown, where: string): ReviewSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = entry['id'];
  const author = entry['author'];
  const state = textField(entry, 'state');
  const commitId = textField(entry, 'commitId');
  const url = textField(entry, 'url');
  if (id === null || author === null || state === null || url === null) {
    return null;
  }
  const authorObject =
    typeof author === 'object' && author !== null && !Array.isArray(author)
      ? (author as Record<string, unknown>)
      : null;
  const login = authorObject === null ? null : textField(authorObject, 'login');
  if (login === null) {
    throw new DeliveryError(`${where} carried a review with no author login.`);
  }
  const idText = typeof id === 'number' ? String(id) : typeof id === 'string' ? id : null;
  if (idText === null) {
    return null;
  }
  return {
    id: idText,
    author: login,
    state,
    body: textField(entry, 'body') ?? '',
    commitId,
    url,
  };
}

/** One check one `gh pr checks --json` entry describes. */
function checkFrom(value: unknown, where: string): CheckSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryError(`${where} carried a check that is not an object.`);
  }
  const entry = value as Record<string, unknown>;
  const name = textField(entry, 'name');
  if (name === null) {
    throw new DeliveryError(`${where} carried a check with no name.`);
  }
  return {
    name,
    state: textField(entry, 'state'),
    conclusion: textField(entry, 'conclusion'),
    link: textField(entry, 'link'),
  };
}

/** One workflow run one `gh run list --json` entry describes. */
function runFrom(value: unknown, where: string): WorkflowRunSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryError(`${where} carried a workflow run that is not an object.`);
  }
  const entry = value as Record<string, unknown>;
  const databaseId = entry['databaseId'];
  const workflowId = entry['workflowId'];
  const headSha = textField(entry, 'headSha');
  const status = textField(entry, 'status');
  const url = textField(entry, 'url');
  const path = textField(entry, 'path');
  const event = textField(entry, 'event');
  if (
    typeof databaseId !== 'number' ||
    typeof workflowId !== 'number' ||
    headSha === null ||
    status === null ||
    url === null ||
    path === null ||
    event === null
  ) {
    throw new DeliveryError(
      `${where} carried a workflow run that does not name its ID, workflow, commit, event, ` +
        'state, or URL.',
    );
  }
  return {
    databaseId,
    workflowId,
    workflowName: textField(entry, 'name') ?? path,
    path,
    event,
    status,
    conclusion: textField(entry, 'conclusion'),
    headSha,
    url,
  };
}

/** The last nonblank line of what a command wrote, for a one-line failure. */
function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return (lines.at(-1) ?? '').slice(0, DIAGNOSTIC_LIMIT);
}

/** The most a command's own output says about why it failed. */
async function commandDiagnostic(result: Awaited<ReturnType<typeof runCommand>>): Promise<string> {
  for (const file of [result.stderrPath, result.stdoutPath]) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const line = lastLine(text);
    if (line !== '') {
      return line;
    }
  }
  return 'it wrote no diagnostic output';
}

/**
 * The GitHub completion path, built once per source command from the validated
 * configuration and the two credentials it names. The operator credential is the
 * environment's own (`gh`/Git authentication); the reviewer credential is a
 * separate token that is presented only to the one read of the reviewer's
 * verdict, and never to a command that writes anything on GitHub.
 */
export function createGitHubCompletion(
  config: CompletionConfig,
  reviewerToken: string,
  parts: GitHubCompletionParts = {},
): CompletionActions {
  const command = parts.command ?? 'gh';
  /**
   * Every command of one invocation gets its own label. A repeated read — the
   * next poll of a pending check, a merge that is still pending — is the same
   * command run again, and its evidence must not overwrite the reading before
   * it: the log files of earlier commands are kept as they are. The per-run tag
   * keeps a later invocation's labels distinct from an earlier one's, and every
   * attempt inside it is numbered from one.
   */
  const runTag = randomBytes(3).toString('hex');
  let invocation = 0;
  const operatorEnvironment = baseEnvironment(parts.env ?? process.env);
  /**
   * What the reviewer's own read inherits: the same environment with the
   * operator's GitHub credentials removed and the reviewer's token added. The
   * reviewer is never handed the operator credential, and the operator's
   * commands are never handed the reviewer's.
   */
  const reviewerEnvironment = (): NodeJS.ProcessEnv => {
    const clean: NodeJS.ProcessEnv = { ...operatorEnvironment };
    delete clean['GH_TOKEN'];
    delete clean['GITHUB_TOKEN'];
    delete clean['GH_ENTERPRISE_TOKEN'];
    clean['GH_TOKEN'] = reviewerToken;
    return clean;
  };

  /** One bounded `gh` invocation in the retained workspace, with its output kept. */
  const execute = async (
    request: CompletionRequest,
    label: string,
    what: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    stop: AbortSignal,
  ): Promise<string> => {
    invocation += 1;
    const result = await runCommand({
      command: [command, ...args],
      cwd: request.workspacePath,
      logsDir: request.logsDir,
      label: `${label}-${runTag}-${String(invocation)}`,
      timeoutMs: COMPLETION_COMMAND_TIMEOUT_MS,
      stop,
      env,
    });
    if (result.outcome === 'exited' && result.exitCode === 0) {
      try {
        return await readFile(result.stdoutPath, 'utf8');
      } catch (cause) {
        throw new DeliveryError(
          `the output of ${what} could not be read from ${result.stdoutPath}: ` +
            `${messageOf(cause)}.`,
        );
      }
    }
    if (result.outcome === 'failed-to-launch') {
      throw new DeliveryError(
        `${what} could not be started: ${result.launchError ?? 'no reason was recorded'}.`,
      );
    }
    if (result.outcome === 'stopped' || result.outcome === 'timed-out') {
      throw new DeliveryError(
        `${what} ${result.outcome === 'stopped' ? 'was stopped' : 'ran past its limit'}, so how ` +
          'far it got is unknown; check GitHub before retrying.',
      );
    }
    throw new DeliveryError(
      `${what} failed (${result.outcome}` +
        `${result.exitCode === null ? '' : `, exit code ${String(result.exitCode)}`}): ` +
        `${await commandDiagnostic(result)} (its output is in ${result.stderrPath} and ` +
        `${result.stdoutPath}).`,
    );
  };

  const findOpen = async (
    request: CompletionRequest,
    stop: AbortSignal,
  ): Promise<PullRequestSnapshot | null> => {
    const output = await execute(
      request,
      'completion-gh-pr-list',
      'gh pr list',
      [
        'pr',
        'list',
        '--repo',
        request.repository,
        '--head',
        request.branch,
        '--base',
        request.baseBranch,
        '--state',
        'open',
        '--limit',
        '20',
        '--json',
        'number,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeCommit',
      ],
      operatorEnvironment,
      stop,
    );
    const entries = parseArray(output, 'gh pr list').map((entry, index) =>
      pullFrom(
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : required(new DeliveryError('gh pr list carried an entry that is not a pull request.')),
        `gh pr list entry ${String(index)}`,
      ),
    );
    if (entries.length === 0) {
      return null;
    }
    if (entries.length > 1) {
      throw new DeliveryError(
        `${String(entries.length)} open pull requests match ${request.repository} head ` +
          `${request.branch} base ${request.baseBranch}, so which one was delivered is ` +
          'ambiguous and nothing was armed.',
      );
    }
    return entries[0] ?? null;
  };

  const readPull = async (
    request: CompletionRequest,
    number: number,
    stop: AbortSignal,
  ): Promise<PullRequestSnapshot> => {
    const output = await execute(
      request,
      'completion-gh-pr-view',
      'gh pr view',
      [
        'pr',
        'view',
        String(number),
        '--repo',
        request.repository,
        '--json',
        'number,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeCommit',
      ],
      operatorEnvironment,
      stop,
    );
    return pullFrom(parseObject(output, 'gh pr view'), 'gh pr view');
  };

  const readGate = async (
    request: CompletionRequest,
    pull: PullRequestSnapshot,
    stop: AbortSignal,
  ): Promise<GateVerdict> => {
    // The head is re-read here, at the moment the verdict is formed: the caller
    // re-reads it again immediately before asking GitHub to change anything.
    const current = await readPull(request, pull.number, stop);
    if (current.state.toUpperCase() !== 'OPEN') {
      return {
        status: 'attention',
        reason: `pull request ${current.url} is ${current.state}, not open`,
        review: null,
        findings: [],
      };
    }

    const reviewsOutput = await execute(
      request,
      'completion-gh-pr-reviews',
      'gh pr reviews',
      [
        'pr',
        'reviews',
        current.url,
        '--repo',
        request.repository,
        '--json',
        'id,author,state,body,commitId,url',
      ],
      reviewerEnvironment(),
      stop,
    );
    const reviews = parseArray(reviewsOutput, 'gh pr reviews')
      .map((entry) => reviewFrom(entry, 'gh pr reviews'))
      .filter((review): review is ReviewSnapshot => review !== null);

    const contextReviews = reviews.filter(
      (review) =>
        review.state.toUpperCase() === 'APPROVED' ||
        review.state.toUpperCase() === 'CHANGES_REQUESTED',
    );
    const byReviewer = contextReviews.filter(
      (review) => review.author.toLowerCase() === config.lensApp.toLowerCase(),
    );
    const approvals = byReviewer.filter(
      (review) =>
        review.state.toUpperCase() === 'APPROVED' && review.commitId === current.headRefOid,
    );
    const rejections = byReviewer.filter(
      (review) =>
        review.state.toUpperCase() === 'CHANGES_REQUESTED' &&
        review.commitId === current.headRefOid,
    );

    const checksOutput = await execute(
      request,
      'completion-gh-pr-checks',
      'gh pr checks',
      [
        'pr',
        'checks',
        current.url,
        '--repo',
        request.repository,
        '--json',
        'name,state,conclusion,link',
      ],
      operatorEnvironment,
      stop,
    );
    const checks = parseArray(checksOutput, 'gh pr checks').map((entry) =>
      checkFrom(entry, 'gh pr checks'),
    );
    const lensChecks = checks.filter((check) => check.name === config.lensCheckName);
    const failedChecks = checks.filter(checkFailed);

    if (approvals.length === 0) {
      if (rejections.length > 0) {
        const [decision] = rejections;
        return {
          status: 'failed',
          reason: `the reviewer requested changes on the current head ${current.headRefOid}`,
          review: decision ?? null,
          findings:
            decision === undefined
              ? []
              : [
                  {
                    label: `Nexus Lens review`,
                    detail: reviewSummary(decision),
                    link: decision.url,
                  },
                ],
        };
      }
      if (failedChecks.length > 0) {
        return {
          status: 'failed',
          reason:
            `${String(failedChecks.length)} pull request check(s) failed on the current head ` +
            current.headRefOid,
          review: null,
          findings: failedChecks.map((check) => ({
            label: check.name,
            detail: `the check ${check.name} is ${checkOutcomeText(check)}`,
            link: check.link ?? current.url,
          })),
        };
      }
      if (lensChecks.some(checkPending) || checks.some(checkPending)) {
        return {
          status: 'pending',
          reason: `pull request checks on the current head ${current.headRefOid} are still running`,
          review: null,
          findings: [],
        };
      }
      const [anyReview] = byReviewer;
      if (anyReview !== undefined && anyReview.commitId !== current.headRefOid) {
        return {
          status: 'attention',
          reason:
            `the reviewer's latest decision is on commit ${anyReview.commitId ?? 'unknown'}, not ` +
            `the current head ${current.headRefOid}, and its relationship to the current head is unclear`,
          review: null,
          findings: [],
        };
      }
      return {
        status: 'attention',
        reason:
          `there is no completed ${config.lensApp} APPROVE review on the current head ` +
          `${current.headRefOid} (context "${config.lensReviewContext}")`,
        review: null,
        findings: [],
      };
    }

    if (failedChecks.length > 0) {
      return {
        status: 'failed',
        reason:
          `${String(failedChecks.length)} pull request check(s) failed on the current head ` +
          current.headRefOid,
        review: null,
        findings: failedChecks.map((check) => ({
          label: check.name,
          detail: `the check ${check.name} is ${checkOutcomeText(check)}`,
          link: check.link ?? current.url,
        })),
      };
    }
    if (checks.some(checkPending)) {
      return {
        status: 'pending',
        reason: `pull request checks on the current head ${current.headRefOid} are still running`,
        review: null,
        findings: [],
      };
    }
    if (lensChecks.length === 0) {
      return {
        status: 'attention',
        reason:
          `the current head ${current.headRefOid} has an approval but no ${config.lensCheckName} ` +
          'check, so the approval is not backed by the app-owned check',
        review: null,
        findings: [],
      };
    }
    if (!lensChecks.every(checkPassed)) {
      return {
        status: 'attention',
        reason:
          `the ${config.lensCheckName} check on ${current.headRefOid} did not report success, and ` +
          'its relationship to the review decision is unclear',
        review: null,
        findings: [],
      };
    }
    const [approval] = approvals;
    return {
      status: 'approved',
      reason: `the reviewer approved ${current.headRefOid} and its ${config.lensCheckName} check succeeded`,
      review: approval ?? null,
      findings: [],
    };
  };

  /** The reviewer's approval of one pull request, read with the reviewer's own token. */
  const readApprovedHead = async (
    request: CompletionRequest,
    pull: PullRequestSnapshot,
    stop: AbortSignal,
  ): Promise<string | null> => {
    const output = await execute(
      request,
      'completion-gh-pr-reviews',
      'gh pr reviews',
      [
        'pr',
        'reviews',
        pull.url,
        '--repo',
        request.repository,
        '--json',
        'id,author,state,body,commitId,url',
      ],
      reviewerEnvironment(),
      stop,
    );
    const approvals = parseArray(output, 'gh pr reviews')
      .map((entry) => reviewFrom(entry, 'gh pr reviews'))
      .filter(
        (review): review is ReviewSnapshot =>
          review !== null &&
          review.author.toLowerCase() === config.lensApp.toLowerCase() &&
          review.state.toUpperCase() === 'APPROVED',
      );
    return approvals[0]?.commitId ?? null;
  };

  const readMerge = async (
    request: CompletionRequest,
    pull: PullRequestSnapshot,
    reviewedHead: string,
    stop: AbortSignal,
  ): Promise<MergeVerdict> => {
    const current = await readPull(request, pull.number, stop);
    if (current.state.toUpperCase() !== 'MERGED') {
      return {
        status: 'pending',
        reason: `pull request ${current.url} is ${current.state}, not merged`,
        mergeCommit: null,
        workflows: [],
      };
    }
    if (current.headRefOid !== reviewedHead) {
      return {
        status: 'pending',
        reason:
          `pull request ${current.url} reports head ${current.headRefOid}, not the reviewed head ` +
          `${reviewedHead}, so this harness will not call it the reviewed merge`,
        mergeCommit: null,
        workflows: [],
      };
    }
    if (current.baseRefName !== request.baseBranch) {
      return {
        status: 'pending',
        reason:
          `pull request ${current.url} targets ${current.baseRefName}, not the configured base ` +
          request.baseBranch,
        mergeCommit: null,
        workflows: [],
      };
    }
    const mergeCommit = current.mergeCommit?.oid ?? null;
    if (mergeCommit === null) {
      return {
        status: 'pending',
        reason: `GitHub reports ${current.url} merged but names no merge commit`,
        mergeCommit: null,
        workflows: [],
      };
    }

    const runsOutput = await execute(
      request,
      'completion-gh-run-list',
      'gh run list',
      [
        'run',
        'list',
        '--repo',
        request.repository,
        '--commit',
        mergeCommit,
        '--event',
        'push',
        '--branch',
        request.baseBranch,
        '--limit',
        '100',
        '--json',
        'databaseId,workflowId,name,path,event,status,conclusion,headSha,url',
      ],
      operatorEnvironment,
      stop,
    );
    const runs = parseArray(runsOutput, 'gh run list')
      .map((entry) => runFrom(entry, 'gh run list'))
      // The command asks GitHub for this commit, event, and branch; the answer is
      // checked again here so nothing but the exact merge commit can be read.
      .filter(
        (run) =>
          run.headSha === mergeCommit &&
          run.event.toLowerCase() === 'push' &&
          workflowIdentified(config.postMergeWorkflows, run),
      );
    const outcomes = workflowOutcomes(config.postMergeWorkflows, runs);
    const unsuccessful = outcomes.filter((outcome) => outcome.state === 'unsuccessful');
    if (unsuccessful.length > 0) {
      return {
        status: 'workflows-unsuccessful',
        reason: unsuccessful
          .map(
            (outcome) =>
              `${outcome.identifier} concluded ${outcome.conclusion ?? 'without a conclusion'}`,
          )
          .join('; '),
        mergeCommit,
        workflows: outcomes,
      };
    }
    if (outcomes.some((outcome) => outcome.state !== 'success')) {
      return {
        status: 'workflows-pending',
        reason: outcomes
          .filter((outcome) => outcome.state !== 'success')
          .map((outcome) =>
            outcome.state === 'pending'
              ? `${outcome.identifier} has no run yet`
              : `${outcome.identifier} is still running`,
          )
          .join('; '),
        mergeCommit,
        workflows: outcomes,
      };
    }
    return {
      status: 'complete',
      reason: `merge ${mergeCommit} and every configured post-merge workflow succeeded`,
      mergeCommit,
      workflows: outcomes,
    };
  };

  return {
    findPullRequest: (request, stop) => findOpen(request, stop),
    findMergedPullRequest: (request, number, stop) => readPull(request, number, stop),
    readGate: (request, pull, stop) => readGate(request, pull, stop),
    readApprovedHead: (request, pull, stop) => readApprovedHead(request, pull, stop),
    readMerge: (request, pull, reviewedHead, stop) => readMerge(request, pull, reviewedHead, stop),
    enableAutoMerge: async (request, pull, reviewedHead, stop) => {
      const current = await readPull(request, pull.number, stop);
      if (current.state.toUpperCase() !== 'OPEN') {
        throw new DeliveryError(
          `pull request ${current.url} is ${current.state}, not open, so auto-merge was not armed.`,
        );
      }
      if (current.headRefOid !== reviewedHead) {
        throw new DeliveryError(
          `pull request ${current.url} moved from the reviewed head ${reviewedHead} to ` +
            `${current.headRefOid}, so auto-merge was not armed; a human has to look at the new ` +
            'commit.',
        );
      }
      if (current.baseRefName !== request.baseBranch) {
        throw new DeliveryError(
          `pull request ${current.url} targets ${current.baseRefName}, not the configured base ` +
            request.baseBranch,
        );
      }
      await execute(
        request,
        'completion-gh-pr-merge-auto',
        'gh pr merge --auto',
        ['pr', 'merge', current.url, '--repo', request.repository, '--auto', '--squash'],
        operatorEnvironment,
        stop,
      );
      return 'enabled';
    },
  };
}

/** Whether one run answers for any configured workflow identifier. */
function workflowIdentified(identifiers: readonly string[], run: WorkflowRunSnapshot): boolean {
  return identifiers.some((identifier) => workflowMatches(identifier, run));
}

/** What one failed check's own state and conclusion say. */
function checkOutcomeText(check: CheckSnapshot): string {
  const conclusion = check.conclusion?.trim().toUpperCase() ?? '';
  const text = conclusion === '' ? (check.state?.trim().toUpperCase() ?? '') : conclusion;
  return text.toLowerCase().replaceAll('_', ' ');
}

/** The actionable text one review decision carries, bounded to a few lines. */
function reviewSummary(review: ReviewSnapshot): string {
  const text = review.body.replace(/\s+/g, ' ').trim();
  if (text === '') {
    return `the reviewer requested changes on ${review.commitId ?? 'the current commit'} with no comment`;
  }
  return text.length <= 500 ? text : `${text.slice(0, 500)}…`;
}

/**
 * What happens when a reported status move never arrived. Both are operator
 * problems: the merge is never rolled back, and no coding turn is started.
 */
export class CompletionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CompletionError';
  }
}

/** The environment a delivery/completion command inherits: no prompts, no pagers. */
function baseEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...gitInvocationEnvironment(base),
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
  };
}
