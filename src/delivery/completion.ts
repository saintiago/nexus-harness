/** Native GitHub evidence and the single permitted mutation: enable squash auto-merge. */
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { runCommand } from '../process/command.js';
import type { CompletionConfig, SourceRef } from '../shared/types.js';
import { gitInvocationEnvironment } from '../workspace/git.js';
import { DeliveryError } from './github.js';
import { checkFailed, checkPending, workflowOutcomes } from './gate.js';
import type { CheckSnapshot, WorkflowRunSnapshot, WorkflowOutcome } from './gate.js';

export type { WorkflowOutcome } from './gate.js';

/** How long one `gh` command may run before the harness stops it. */
export const COMPLETION_COMMAND_TIMEOUT_MS = 5 * 60_000;

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
  readonly nodeId?: string;
  readonly autoMergeRequest?: { readonly enabledAt: string } | null;
  readonly mergeable?: string;
  readonly title?: string;
  readonly body?: string;
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
  readonly nodeId?: string;
  readonly autoMergeRequest?: { readonly enabledAt: string } | null;
  readonly mergeable?: string;
  readonly title?: string;
  readonly body?: string;
  readonly mergeCommit: string | null;
  /** Every configured workflow and its latest attempt. */
  readonly workflows: readonly WorkflowOutcome[];
}

/**
 * What enabling native auto-merge did. `merged` is the race this path has to
 * survive: GitHub merged the reviewed head while the request was in flight, so
 * there is nothing left to arm and the merge itself is what gets verified.
 */
export type AutoMergeStatus = 'enabled' | 'already-enabled' | 'merged';

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
   * head immediately before the request and again after it. The caller arms as
   * soon as the delivered pull request exists, before the final required check
   * can turn green, because GitHub refuses to arm a pull request whose status is
   * already clean. An unprocessable or no-longer-eligible answer — GitHub merged
   * the pull request while the request was in flight — is settled by one fresh
   * reconciliation read before it is classified: the merged reviewed head is
   * reported as `merged`, and anything else throws {@link DeliveryError}. A
   * conflict, branch protection, or a missing permission is an operator
   * problem, never a coding finding.
   */
  enableAutoMerge(
    request: CompletionRequest,
    pull: PullRequestSnapshot,
    head: string,
    stop: AbortSignal,
    beforeWrite?: () => Promise<boolean>,
  ): Promise<AutoMergeStatus>;
}

/** The pieces a caller may stand in for; production supplies none of them. */
export interface GitHubCompletionParts {
  /** The GitHub CLI to run. Defaults to `gh` from `PATH`. */
  readonly command?: string;
  /** What the operator's own commands inherit. Defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DeliveryError('Malformed GitHub object');
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new DeliveryError('Incomplete GitHub list');
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value === '')
    throw new DeliveryError('Missing GitHub evidence field');
  return value;
}
function pullFrom(value: unknown): PullRequestSnapshot {
  const p = object(value);
  if (typeof p['number'] !== 'number') throw new DeliveryError('Missing PR number');
  return {
    number: p['number'],
    url: string(p['url']),
    state: string(p['state']),
    isDraft: p['isDraft'] !== false,
    headRefName: string(p['headRefName']),
    baseRefName: string(p['baseRefName']),
    headRefOid: string(p['headRefOid']),
    nodeId: string(p['id']),
    mergeable: string(p['mergeable']),
    title: typeof p['title'] === 'string' ? p['title'] : '',
    body: typeof p['body'] === 'string' ? p['body'] : '',
    autoMergeRequest:
      p['autoMergeRequest'] == null
        ? null
        : { enabledAt: string(object(p['autoMergeRequest'])['enabledAt']) },
    mergeCommit: p['mergeCommit'] == null ? null : { oid: string(object(p['mergeCommit'])['oid']) },
  };
}
const PULL_FIELDS =
  'id,number,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeCommit,autoMergeRequest,mergeable,title,body';

/**
 * Whether what a failed read wrote is an indeterminate answer rather than a
 * refusal GitHub meant: a server-side failure, a rate limit, a timeout, or a
 * connection that never completed. Only these are retried, and only inside the
 * item's deadline; a `403`, a `404`, an unprocessable `422` or a malformed
 * answer from GitHub is a settled reading.
 */
function transientReadFailure(diagnostic: string): boolean {
  return (
    /\bHTTP (?:408|425|429|5\d\d)\b/.test(diagnostic) ||
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/i.test(diagnostic) ||
    /\b(?:rate limit|abuse detection|secondary rate limit)\b/i.test(diagnostic) ||
    /\b(?:timed? ?out|timeout)\b/i.test(diagnostic) ||
    /\b(?:server error|internal server error|bad gateway|service unavailable|gateway time-?out|network error|connection reset|connection refused|socket hang up)\b/i.test(
      diagnostic,
    )
  );
}

export function createGitHubCompletion(
  config: CompletionConfig,
  reviewerToken: string | ((stop: AbortSignal) => Promise<string>),
  parts: GitHubCompletionParts = {},
): CompletionActions {
  if (typeof reviewerToken === 'string' && reviewerToken.trim() === '')
    throw new DeliveryError('Missing separate reviewer/reader credential');
  if (config.postMergeWorkflows.length === 0)
    throw new DeliveryError('At least one expected post-merge workflow is required');
  const operatorEnvironment: NodeJS.ProcessEnv = {
    ...gitInvocationEnvironment(parts.env ?? process.env),
    GH_PROMPT_DISABLED: '1',
    GH_HOST: 'github.com',
  };
  const readerEnvironment: NodeJS.ProcessEnv = { ...operatorEnvironment };
  for (const key of Object.keys(readerEnvironment)) {
    if (
      [
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'GH_ENTERPRISE_TOKEN',
        'GITHUB_ENTERPRISE_TOKEN',
        config.reviewerTokenEnv.toUpperCase(),
      ].includes(key.toUpperCase())
    )
      delete readerEnvironment[key];
  }
  for (const key of Object.keys(operatorEnvironment)) {
    if (key.toUpperCase() === config.reviewerTokenEnv.toUpperCase())
      delete operatorEnvironment[key];
  }
  const credentialValues = [
    ...Object.entries(operatorEnvironment),
    ...Object.entries(readerEnvironment),
  ]
    .filter(([key]) =>
      /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key),
    )
    .map(([, value]) => value ?? '')
    .filter((value) => value !== '');
  if (
    Object.entries(operatorEnvironment).some(
      ([key, value]) =>
        /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key) &&
        value === reviewerToken,
    )
  )
    throw new DeliveryError('Reviewer and operator credentials must be different');
  let sequence = 0;
  const tag = randomBytes(4).toString('hex');
  /**
   * What a failed command said, as one bounded line. The command log is the
   * evidence an operator reads; the message that reaches the item keeps the
   * reason — GitHub's own "Pull request is in clean status" included — without
   * the workspace path or any credential value this process handed the command.
   */
  const failureDiagnostic = async (
    result: { readonly stderrPath: string; readonly stdoutPath: string },
    request: CompletionRequest,
    commandSecrets: readonly string[],
  ): Promise<string> => {
    for (const file of [result.stderrPath, result.stdoutPath]) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const line = text
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .at(-1);
      if (line === undefined || line === '') continue;
      let safe = line.split(request.workspacePath).join('<workspace>');
      for (const credential of [...credentialValues, ...commandSecrets])
        safe = safe.split(credential).join('[redacted]');
      return safe.length <= 300 ? safe : `${safe.slice(0, 300)}…`;
    }
    return 'it wrote no diagnostic output';
  };
  const execute = async (
    request: CompletionRequest,
    args: string[],
    stop: AbortSignal,
    mutation = false,
    checks = false,
  ): Promise<unknown> => {
    let environment = operatorEnvironment;
    let commandToken: string | null = null;
    if (!mutation) {
      const token = typeof reviewerToken === 'string' ? reviewerToken : await reviewerToken(stop);
      if (token.trim() === '')
        throw new DeliveryError('Missing separate reviewer/reader credential');
      if (
        Object.entries(operatorEnvironment).some(
          ([key, value]) =>
            /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key) &&
            value === token,
        )
      )
        throw new DeliveryError('Reviewer and operator credentials must be different');
      environment = { ...readerEnvironment, GH_TOKEN: token };
      commandToken = token;
    }
    const result = await runCommand({
      command: [parts.command ?? 'gh', ...args],
      cwd: request.workspacePath,
      logsDir: request.logsDir,
      label: `completion-${tag}-${String(++sequence)}`,
      timeoutMs: COMPLETION_COMMAND_TIMEOUT_MS,
      stop,
      env: environment,
    });
    if (
      result.outcome !== 'exited' ||
      !(result.exitCode === 0 || (checks && (result.exitCode === 1 || result.exitCode === 8)))
    ) {
      // Command logs retain the diagnostic; never copy credentials or local paths to Jira.
      const diagnostic = await failureDiagnostic(
        result,
        request,
        commandToken === null ? [] : [commandToken],
      );
      throw new DeliveryError(
        `GitHub ${mutation ? 'auto-merge request' : 'evidence read'} failed ` +
          `(${result.outcome}, ${String(result.exitCode)}): ${diagnostic}; operator attention required`,
        // A mutation is never replayed, whatever the failure looked like; only
        // an evidence read GitHub could not answer this moment may be read again.
        { retryable: !mutation && transientReadFailure(diagnostic) },
      );
    }
    const value: unknown = JSON.parse(await readFile(result.stdoutPath, 'utf8'));
    if (typeof value === 'object' && value !== null && 'errors' in value)
      throw new DeliveryError('GitHub refused the API request');
    return value;
  };
  const api = (r: CompletionRequest, endpoint: string, stop: AbortSignal): Promise<unknown> => {
    const [route, query] = endpoint.split('?');
    return execute(
      r,
      [
        'api',
        '--method',
        'GET',
        `repos/${r.repository}/${route ?? ''}`,
        ...Array.from(new URLSearchParams(query), ([key, value]) => [
          '-f',
          `${key}=${value}`,
        ]).flat(),
      ],
      stop,
    );
  };
  const pages = async (
    r: CompletionRequest,
    endpoint: string,
    stop: AbortSignal,
  ): Promise<unknown[]> => {
    const result: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const entries = array(
        await api(
          r,
          `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${String(page)}`,
          stop,
        ),
      );
      result.push(...entries);
      if (entries.length < 100) return result;
    }
    throw new DeliveryError('GitHub evidence list exceeded the bounded page limit');
  };
  const readPull = async (
    r: CompletionRequest,
    n: number,
    stop: AbortSignal,
  ): Promise<PullRequestSnapshot> =>
    pullFrom(
      await execute(
        r,
        ['pr', 'view', String(n), '--repo', r.repository, '--json', PULL_FIELDS],
        stop,
      ),
    );
  const identity = (
    r: CompletionRequest,
    p: PullRequestSnapshot,
    expected: PullRequestSnapshot,
  ): void => {
    if (p.number !== expected.number || p.url !== expected.url)
      throw new DeliveryError(
        `GitHub now reports ${p.url} where ${expected.url} was the delivered pull request`,
      );
    if (p.headRefName !== r.branch || p.baseRefName !== r.baseBranch)
      throw new DeliveryError(
        `pull request ${p.url} now carries ${p.headRefName} into ${p.baseRefName}, not ` +
          `${r.branch} into ${r.baseBranch}`,
      );
    if (p.headRefOid !== expected.headRefOid)
      throw new DeliveryError(
        `pull request ${p.url} now holds head ${p.headRefOid}, not the reviewed head ` +
          `${expected.headRefOid}, so a merge cannot be tied to the reviewed work`,
      );
  };
  const gate = async (
    r: CompletionRequest,
    p: PullRequestSnapshot,
    stop: AbortSignal,
    merged = false,
  ): Promise<GateVerdict> => {
    const current = await readPull(r, p.number, stop);
    identity(r, current, p);
    const result = (
      status: GateStatus,
      reason: string,
      review: ReviewSnapshot | null = null,
      findings: GateFinding[] = [],
    ): GateVerdict => ({ status, reason, review, findings });
    if (current.state !== (merged ? 'MERGED' : 'OPEN') || current.isDraft)
      return result(
        'attention',
        `Pull request ${current.url} is ${current.state}${current.isDraft ? ' (draft)' : ''}, ` +
          'not eligible for completion',
      );
    const reviews = (await pages(r, `pulls/${String(p.number)}/reviews`, stop))
      .map(object)
      .filter(
        (v) =>
          object(v['user'])['login'] === config.lensApp &&
          v['commit_id'] === p.headRefOid &&
          typeof v['submitted_at'] === 'string' &&
          ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(String(v['state'])),
      )
      .sort((a, b) => Number(b['id']) - Number(a['id']));
    const latest = reviews[0];
    if (!latest || latest['state'] === 'DISMISSED')
      return result('attention', 'No completed current-head Nexus Lens decision');
    const review: ReviewSnapshot = {
      id: String(latest['id']),
      author: config.lensApp,
      state: string(latest['state']),
      body: String(latest['body'] ?? ''),
      commitId: string(latest['commit_id']),
      url: string(latest['html_url']),
    };
    const answer = object(
      await api(
        r,
        `commits/${p.headRefOid}/check-runs?check_name=${encodeURIComponent(config.lensCheckName)}&filter=latest&per_page=100`,
        stop,
      ),
    );
    const checks = array(answer['check_runs']).map(object);
    if (typeof answer['total_count'] !== 'number' || answer['total_count'] > checks.length)
      throw new DeliveryError('Incomplete Lens check list');
    const lens = checks
      .filter(
        (c) =>
          c['name'] === config.lensCheckName &&
          c['head_sha'] === p.headRefOid &&
          object(c['app'])['id'] === config.lensAppId,
      )
      .sort((a, b) => Number(b['id']) - Number(a['id']))[0];
    if (review.state === 'CHANGES_REQUESTED') {
      if (lens && lens['conclusion'] === 'failure' && lens['details_url'] !== review.url)
        return result('attention', 'Lens check relationship to review is unclear');
      const inline = (
        await pages(r, `pulls/${String(p.number)}/reviews/${review.id}/comments`, stop)
      ).map(object);
      const actionable = inline
        .slice(0, 3)
        .map(
          (c) =>
            `${String(c['path'] ?? '')}: ${String(c['body'] ?? '')
              .replace(/\s+/g, ' ')
              .slice(0, 180)}`,
        )
        .join('; ');
      return result('failed', 'Nexus Lens requested changes', review, [
        {
          label: 'Nexus Lens review',
          detail: [review.body.replace(/\s+/g, ' ').slice(0, 250), actionable]
            .filter(Boolean)
            .join(' '),
          link: review.url,
        },
      ]);
    }
    if (
      !lens ||
      lens['status'] !== 'completed' ||
      lens['conclusion'] !== 'success' ||
      lens['details_url'] !== review.url
    )
      return result('attention', 'Approval lacks its successful app-owned Lens check');
    if (!merged) {
      const required = array(
        await execute(
          r,
          [
            'pr',
            'checks',
            p.url,
            '--repo',
            r.repository,
            '--required',
            '--json',
            'name,state,link',
          ],
          stop,
          false,
          true,
        ),
      ).map((v) => {
        const c = object(v);
        return {
          name: string(c['name']),
          state: string(c['state']),
          conclusion: null,
          link: string(c['link']),
        } satisfies CheckSnapshot;
      });
      if (required.some((c) => c.name === config.lensCheckName && checkFailed(c)))
        return result('attention', 'Required Lens check disagrees with its app-owned approval');
      const failed = required.filter((c) => c.name !== config.lensCheckName && checkFailed(c));
      if (failed.length)
        return result(
          'failed',
          'Required pull request checks failed',
          review,
          failed.map((c) => ({
            label: c.name,
            detail: `Required check concluded ${c.state ?? 'unknown'}`,
            link: c.link ?? p.url,
          })),
        );
      if (current.mergeable === 'CONFLICTING')
        return result('attention', 'Pull request has merge conflicts');
      if (current.mergeable !== 'MERGEABLE')
        return result('pending', 'Pull request mergeability is pending', review);
      if (required.some(checkPending))
        return result(
          'approved',
          'Nexus Lens approved; native auto-merge must wait for pending required PR checks',
          review,
        );
    }
    return result(
      'approved',
      'Nexus Lens approved the current head with its app-owned check',
      review,
    );
  };
  const readMerge = async (
    r: CompletionRequest,
    p: PullRequestSnapshot,
    head: string,
    stop: AbortSignal,
  ): Promise<MergeVerdict> => {
    const current = await readPull(r, p.number, stop);
    identity(r, current, { ...p, headRefOid: head });
    if (current.state === 'CLOSED')
      throw new DeliveryError(
        `pull request ${current.url} is closed without a merge of the reviewed head ${head}, so ` +
          'no completion is possible',
      );
    if (current.state !== 'MERGED' || !current.mergeCommit?.oid)
      return {
        status: 'pending',
        reason: 'GitHub has not confirmed the merge',
        mergeCommit: null,
        workflows: [],
      };
    const mergeCommit = current.mergeCommit.oid;
    const runs: WorkflowRunSnapshot[] = [];
    for (const identifier of config.postMergeWorkflows) {
      // Each workflow has its own bounded listing: unrelated runs cannot hide an expected workflow.
      const file = identifier.replace(/^\.github\/workflows\//, '');
      const answer = object(
        await api(
          r,
          `actions/workflows/${encodeURIComponent(file)}/runs?event=push&branch=${encodeURIComponent(r.baseBranch)}&head_sha=${mergeCommit}&per_page=100`,
          stop,
        ),
      );
      const entries = array(answer['workflow_runs']);
      if (typeof answer['total_count'] !== 'number' || answer['total_count'] > entries.length)
        throw new DeliveryError('Incomplete workflow run list');
      for (const entry of entries) {
        const v = object(entry);
        if (
          v['head_sha'] !== mergeCommit ||
          v['head_branch'] !== r.baseBranch ||
          v['event'] !== 'push'
        )
          continue;
        if (
          typeof v['id'] !== 'number' ||
          typeof v['workflow_id'] !== 'number' ||
          typeof v['run_attempt'] !== 'number'
        )
          throw new DeliveryError('Missing workflow run identity or attempt');
        runs.push({
          databaseId: v['id'],
          workflowId: v['workflow_id'],
          runAttempt: v['run_attempt'],
          workflowName: String(v['name']),
          path: string(v['path']),
          event: 'push',
          headBranch: r.baseBranch,
          status: string(v['status']),
          conclusion: typeof v['conclusion'] === 'string' ? v['conclusion'] : null,
          headSha: mergeCommit,
          url: string(v['html_url']),
        });
      }
    }
    const workflows = workflowOutcomes(config.postMergeWorkflows, runs);
    const failed = workflows.some((w) => w.state === 'unsuccessful');
    const complete = workflows.length > 0 && workflows.every((w) => w.state === 'success');
    return {
      status: failed ? 'workflows-unsuccessful' : complete ? 'complete' : 'workflows-pending',
      reason: failed
        ? 'Post-merge workflows concluded unsuccessfully'
        : complete
          ? 'Verified merge and successful post-merge workflows'
          : workflows
              .filter((w) => w.state !== 'success')
              .map((w) => `${w.identifier}: ${w.run === null ? 'no run yet' : w.state}`)
              .join('; '),
      mergeCommit,
      workflows,
    };
  };
  return {
    async findPullRequest(r, stop) {
      const entries = array(
        await execute(
          r,
          [
            'pr',
            'list',
            '--repo',
            r.repository,
            '--head',
            r.branch,
            '--base',
            r.baseBranch,
            '--state',
            'open',
            '--limit',
            '100',
            '--json',
            PULL_FIELDS,
          ],
          stop,
        ),
      ).map(pullFrom);
      if (entries.length > 1) throw new DeliveryError('Ambiguous delivered pull request');
      const p = entries[0];
      if (p) {
        identity(r, p, p);
        if (p.state !== 'OPEN') throw new DeliveryError('Expected an open PR');
      }
      return p ?? null;
    },
    findMergedPullRequest: (r, n, stop) => readPull(r, n, stop),
    readGate: (r, p, stop) => gate(r, p, stop, p.state === 'MERGED'),
    async readApprovedHead(r, p, stop) {
      const verdict = await gate(r, p, stop, true);
      return verdict.status === 'approved' ? (verdict.review?.commitId ?? null) : null;
    },
    readMerge,
    async enableAutoMerge(r, p, head, stop, beforeWrite) {
      const current = await readPull(r, p.number, stop);
      identity(r, current, { ...p, headRefOid: head });
      // A pull request GitHub merged between the read and the request needs no
      // arm: the completion path verifies that merge by its own evidence.
      if (current.state === 'MERGED') return 'merged';
      if (current.state !== 'OPEN')
        throw new DeliveryError(
          `pull request ${current.url} is ${current.state}, so GitHub was not asked to arm ` +
            'auto-merge',
        );
      if (current.isDraft)
        throw new DeliveryError(
          'Pull request is a draft, so GitHub was not asked to arm auto-merge',
        );
      if (current.mergeable === 'CONFLICTING')
        throw new DeliveryError(
          'Pull request has merge conflicts, so GitHub was not asked to arm auto-merge',
        );
      if (beforeWrite && !(await beforeWrite()))
        throw new DeliveryError('Ticket left In Review before arming');
      if (current.autoMergeRequest) return 'already-enabled';
      /**
       * One fresh reading of the pull request while an answer about the request
       * is unsettled, and what it settles: only the exact reviewed head counts
       * — merged is the merge the request was asking for, and still open with a
       * request recorded is the arm. Anything else leaves the refusal or the
       * lost answer as it was.
       */
      const readBack = async (): Promise<PullRequestSnapshot | null> =>
        await readPull(r, p.number, stop).catch(() => null);
      const settledBy = (fresh: PullRequestSnapshot | null): AutoMergeStatus | null => {
        if (
          fresh === null ||
          fresh.number !== p.number ||
          fresh.headRefOid !== head ||
          fresh.headRefName !== r.branch ||
          fresh.baseRefName !== r.baseBranch
        )
          return null;
        if (fresh.state === 'MERGED') return 'merged';
        if (fresh.state === 'OPEN' && fresh.autoMergeRequest) return 'already-enabled';
        return null;
      };
      let response: unknown;
      try {
        response = await execute(
          r,
          [
            'api',
            'graphql',
            '-f',
            'query=mutation($pull:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$pull,mergeMethod:SQUASH}){pullRequest{autoMergeRequest{enabledAt}}}}',
            '-f',
            `pull=${current.nodeId ?? ''}`,
          ],
          stop,
          true,
        );
      } catch (cause) {
        // GitHub refuses the request as unprocessable when the pull request is
        // no longer armable — the merge it was asking for can land between the
        // eligibility read and this request. One fresh reconciliation read
        // settles what the refusal means before it is classified, and only the
        // exact reviewed head that GitHub really merged counts as the merge.
        const fresh = await readBack();
        const settled = settledBy(fresh);
        if (settled !== null) return settled;
        if (fresh !== null && fresh.headRefOid !== head)
          throw new DeliveryError(
            `pull request ${fresh.url} now holds head ${fresh.headRefOid}, not the reviewed head ` +
              `${head}, so GitHub was not asked to arm auto-merge for it`,
          );
        if (fresh !== null && fresh.state === 'CLOSED')
          throw new DeliveryError(
            `pull request ${fresh.url} is closed without a merge, so GitHub was not asked to ` +
              'arm auto-merge for it',
          );
        throw cause;
      }
      const answer = object(response);
      const armed = object(
        object(object(answer['data'])['enablePullRequestAutoMerge'])['pullRequest'],
      )['autoMergeRequest'];
      if (!armed) {
        // An answer that does not carry the request is ambiguous too: one fresh
        // read settles whether the request landed or the pull request merged.
        const settled = settledBy(await readBack());
        if (settled !== null) return settled;
        throw new DeliveryError(
          `GitHub did not acknowledge auto-merge for ${p.url} at head ${head}, and a fresh ` +
            'read holds no request for that head; it may still be unarmed',
        );
      }
      // Read the pull request back: the request is only recorded for the exact
      // head GitHub still holds, and a native merge that landed in the window is
      // a success rather than a lost request.
      const verified = await readPull(r, p.number, stop);
      identity(r, verified, { ...p, headRefOid: head });
      if (verified.state === 'MERGED') return 'merged';
      if (verified.state !== 'OPEN' || !verified.autoMergeRequest)
        throw new DeliveryError(
          `GitHub did not keep auto-merge enabled for ${verified.url} at head ${head}; it may ` +
            'still be unarmed',
        );
      return 'enabled';
    },
  };
}

export class CompletionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CompletionError';
  }
}
