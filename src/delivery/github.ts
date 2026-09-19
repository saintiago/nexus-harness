/**
 * The one optional delivery step: pushing a passed attempt's branch to the
 * destination repository and opening or updating its pull request, with `git`
 * and the GitHub CLI `gh`.
 *
 * It is a harness/operator operation that runs after a run passed and before
 * that run's result is reported, so the issue's comment can carry the pull
 * request the attempt produced. GitHub is the record of whether a pull request
 * exists: the step lists the destination by repository, head branch, and base
 * branch, updates the one open match, creates one only when none exists, and
 * refuses a match that is closed or merged instead of editing a pull request
 * no open review would receive. There is no local delivery state and no
 * automatic replay.
 *
 * Four rules this module keeps, whatever the commands do:
 *
 * - A working copy that still holds uncommitted work is refused, not delivered:
 *   the harness never commits, stashes, or discards a coding turn's leftovers.
 * - A branch with no commit beyond its recorded base is not delivered either;
 *   there is nothing to publish, and that is said rather than guessed at.
 * - Every command is bounded and its output is kept in the run's own log
 *   directory, so a failure names the command, what it said, and where to look.
 * - Nothing here merges a pull request, forces a push, or changes an issue.
 *
 * The outward boundaries — the destination's push URL, and the environment the
 * commands inherit — are ordinary substitutable pieces, the way the Jira
 * connector's HTTP boundary is, so the self-tests can point them at a
 * disposable local repository and a stand-in `gh` instead of a live GitHub
 * account (docs/architecture.md §5).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../process/command.js';
import { messageOf } from '../shared/errors.js';
import type { CommandResult, GitHubDeliveryConfig, SourceRef } from '../shared/types.js';
import { gitInvocationEnvironment, listPaths } from '../workspace/git.js';
import { statusEntries } from '../workspace/status.js';

/** How long one delivery command may run before the harness stops it. */
export const DELIVERY_COMMAND_TIMEOUT_MS = 5 * 60_000;

/** How much of what a command said a failure message carries. */
const DIAGNOSTIC_LIMIT = 400;

/** A delivery step that could not be completed. The run it belongs to is kept. */
export class DeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeliveryError';
  }
}

/** What one passed attempt is delivered as: its own retained working copy. */
export interface DeliveryRequest {
  /** The retained working copy the attempt left, which is what gets delivered. */
  readonly workspacePath: string;
  /** The workspace's own branch, pushed as it is: never recreated, never forced. */
  readonly branch: string;
  /** The base commit the branch is compared against, to tell work from no work. */
  readonly baseCommit: string;
  /** The run's `<runDir>/logs`, where this step's command output is kept. */
  readonly logsDir: string;
  /** The run that produced the work, as its report names it. */
  readonly runId: string;
  /** The run's own report, named in a failure so the evidence is easy to find. */
  readonly reportPath: string;
  /** The task the attempt implemented, as the pull request describes it. */
  readonly task: { readonly id: string; readonly title: string };
  /** One line about the checks that decided the attempt, as the issue is told. */
  readonly checks: string;
  /** Where the attempt's task came from, when a source provided it. */
  readonly sourceRef?: SourceRef;
}

/** The pull request a passed attempt was delivered as. */
export interface DeliveredPullRequest {
  /** The pull request's browser URL: what the issue's comment links to. */
  readonly url: string;
  /** Whether this delivery created the pull request, or found and updated it. */
  readonly created: boolean;
}

/**
 * One delivery step, as the coordinator uses it. `null` means there was nothing
 * to deliver — the branch carries no commit beyond its recorded base — which is
 * an ordinary outcome, not a failure.
 */
export interface Delivery {
  deliver(request: DeliveryRequest, stop: AbortSignal): Promise<DeliveredPullRequest | null>;
}

/**
 * The pieces a caller may stand in for. Production supplies none of them: the
 * destination URL is derived from the configured repository, the environment is
 * this process's own, and the commands are the harness's ordinary bounded
 * runner.
 */
export interface GitHubDeliveryParts {
  /** Where the branch is pushed. Defaults to the destination's HTTPS URL. */
  readonly pushUrl?: string;
  /** What the delivery commands inherit. Defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
}

/** One pull request as `gh pr list --json url,state` reports it. */
interface PullRequestMatch {
  readonly url: string;
  /** GitHub's own state for it: `OPEN`, `CLOSED`, or `MERGED`. */
  readonly state: string;
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
async function commandDiagnostic(result: CommandResult): Promise<string> {
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
 * What a delivery command inherits: the caller's environment with the harness's
 * own Git hygiene applied, and with every interactive prompt disabled — a
 * missing credential has to fail the step with a message instead of waiting for
 * a terminal nobody is watching.
 */
function deliveryEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...gitInvocationEnvironment(base),
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
  };
}

/** One line of text, so task text cannot become a second line or an option. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The pull request's title: the task, named by its own id. */
function pullRequestTitle(request: DeliveryRequest): string {
  return oneLine(`${request.task.id}: ${request.task.title}`);
}

/**
 * The pull request's body: where the attempt came from, what decided it, and
 * which run produced it. It carries the item's own reference so the pull request
 * is traceable from the repository side too, and no transcript and no path that
 * only exists on the machine that ran the harness.
 */
function pullRequestBody(request: DeliveryRequest): string {
  const ref = request.sourceRef;
  return [
    ref === undefined
      ? `Delivered by the Nexus harness for ${oneLine(request.task.id)}.`
      : `Delivered by the Nexus harness for ${oneLine(ref.key)}: ${ref.url}`,
    '',
    `Task: ${oneLine(request.task.id)} - ${oneLine(request.task.title)}`,
    `Checks: ${oneLine(request.checks)}`,
    `Harness run: ${oneLine(request.runId)}`,
    '',
    'The passed attempt was delivered from its retained working copy; this pull request is not a',
    'merge, and the harness does not mark the issue Done.',
    '',
  ].join('\n');
}

/** The pull request a `gh pr create` invocation reported, or `null`. */
function pullRequestUrl(output: string): string | null {
  const match = /https?:\/\/\S+\/pull\/\d+/.exec(output);
  return match === null ? null : match[0];
}

/** What `gh pr list --json url,state` answered, or a failure naming what it said. */
function parsePullRequestList(output: string): readonly PullRequestMatch[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (cause) {
    throw new DeliveryError(
      `gh pr list did not answer with JSON (${messageOf(cause)}): ${JSON.stringify(
        output.trim().slice(0, DIAGNOSTIC_LIMIT),
      )}.`,
    );
  }
  if (!Array.isArray(value)) {
    throw new DeliveryError('gh pr list did not answer with a list of pull requests.');
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new DeliveryError('gh pr list answered with an entry that is not a pull request.');
    }
    const { url, state } = entry as { url?: unknown; state?: unknown };
    if (typeof url !== 'string') {
      throw new DeliveryError(
        'gh pr list answered with an entry that carries no pull request URL.',
      );
    }
    if (typeof state !== 'string') {
      throw new DeliveryError(
        `gh pr list answered with a pull request that carries no native state, so this harness ` +
          `cannot tell whether ${url} is still open.`,
      );
    }
    return { url, state };
  });
}

/**
 * The GitHub delivery step, built once per source command from the validated
 * configuration. It names no credential: `git` and `gh` authenticate with the
 * operator's own environment, exactly as they would in a terminal.
 */
export function createGitHubDelivery(
  config: GitHubDeliveryConfig,
  parts: GitHubDeliveryParts = {},
): Delivery {
  const { repository, baseBranch } = config;
  const pushUrl = parts.pushUrl ?? `https://github.com/${repository}.git`;
  const environment = deliveryEnvironment(parts.env ?? process.env);

  /** One bounded delivery command in the retained workspace, with its output kept. */
  const execute = async (
    request: DeliveryRequest,
    label: string,
    what: string,
    command: readonly string[],
    stop: AbortSignal,
    hint: string,
  ): Promise<CommandResult> => {
    const result = await runCommand({
      command: [...command],
      cwd: request.workspacePath,
      logsDir: request.logsDir,
      label,
      timeoutMs: DELIVERY_COMMAND_TIMEOUT_MS,
      stop,
      env: environment,
    });
    if (result.outcome === 'exited' && result.exitCode === 0) {
      return result;
    }

    if (result.outcome === 'failed-to-launch') {
      throw new DeliveryError(
        `${what} could not be started: ${result.launchError ?? 'no reason was recorded'}. ${hint}`,
      );
    }
    if (result.outcome === 'stopped' || result.outcome === 'timed-out') {
      // The harness ended this command, not the destination: the delivery may
      // have got part-way, and only GitHub can say how far.
      throw new DeliveryError(
        `${what} ${result.outcome === 'stopped' ? 'was stopped' : 'ran past its limit'}, so how ` +
          'far the delivery got is unknown. Check the destination repository before retrying; a ' +
          'later attempt pushes the same branch and finds an existing pull request instead of ' +
          'creating a second one.',
      );
    }
    const diagnostic = await commandDiagnostic(result);
    throw new DeliveryError(
      `${what} failed (${result.outcome}` +
        `${result.exitCode === null ? '' : `, exit code ${String(result.exitCode)}`}): ` +
        `${diagnostic} (its output is in ${result.stderrPath} and ${result.stdoutPath}). ${hint}`,
    );
  };

  /** What one successful invocation wrote to standard output. */
  const stdoutOf = async (result: CommandResult): Promise<string> => {
    try {
      return await readFile(result.stdoutPath, 'utf8');
    } catch (cause) {
      throw new DeliveryError(
        `the output of a delivery command could not be read from ${result.stdoutPath}: ` +
          `${messageOf(cause)}.`,
      );
    }
  };

  return {
    async deliver(
      request: DeliveryRequest,
      stop: AbortSignal,
    ): Promise<DeliveredPullRequest | null> {
      // How an operator finishes this delivery by hand: checking the destination
      // first matters because a push or a pull request creation that reported a
      // failure may still have taken effect, and nothing here ever replays the
      // coding turn that produced the work (docs/WORKFLOW.md §8).
      const gitHint =
        `Check that this machine can reach ${repository} and that its Git credentials are set ` +
        'up. A failed push may already have updated the branch, so check the destination before ' +
        `pushing by hand from the retained workspace ("git ls-remote ${pushUrl} ` +
        `refs/heads/${request.branch}", or ${repository} on GitHub). The harness never ` +
        'force-pushes, and it never starts a coding turn to repair a delivery failure.';
      const ghHint =
        'Check the GitHub CLI with "gh auth status". Before retrying by hand, look the pull ' +
        `request up on GitHub ("gh pr list --repo ${repository} --head ${request.branch} --base ` +
        `${baseBranch} --state all", or the repository's own page): a failed create may already ` +
        'have opened it. The harness never starts a coding turn to repair a delivery failure.';

      // What the run left behind is checked again here, against the checkout
      // itself: a working copy that is still dirty is refused, and nothing of it
      // is pushed or committed on its behalf.
      const status = await execute(
        request,
        'delivery-git-status',
        'git status',
        [
          'git',
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignored=no',
          '--no-renames',
        ],
        stop,
        gitHint,
      );
      const leftovers = statusEntries(await stdoutOf(status)).map((entry) => entry.path);
      if (leftovers.length > 0) {
        throw new DeliveryError(
          `${listPaths(leftovers)} still hold uncommitted changes in ${request.workspacePath}, so ` +
            'this attempt pushed nothing and created or updated no pull request. Commit those ' +
            'paths in the retained workspace, or remove them, and then push the branch and open ' +
            'or update the pull request by hand with git and gh (docs/WORKFLOW.md §8); the ' +
            "harness never commits or discards a coding turn's leftovers itself, and it starts " +
            'no coding turn to repair a delivery failure.',
        );
      }

      // A passed attempt that committed nothing has nothing to deliver. That is
      // an ordinary outcome and is reported as such, not as a failure.
      const counted = await execute(
        request,
        'delivery-git-commits',
        'git rev-list --count',
        ['git', 'rev-list', '--count', `${request.baseCommit}..refs/heads/${request.branch}`],
        stop,
        gitHint,
      );
      const commits = Number.parseInt((await stdoutOf(counted)).trim(), 10);
      if (!Number.isSafeInteger(commits) || commits < 0) {
        throw new DeliveryError(
          `git rev-list answered with something that is not a commit count: ` +
            `${JSON.stringify((await stdoutOf(counted)).trim().slice(0, DIAGNOSTIC_LIMIT))}.`,
        );
      }
      if (commits === 0) {
        return null;
      }

      await execute(
        request,
        'delivery-git-push',
        'git push',
        [
          'git',
          'push',
          '--quiet',
          '--',
          pushUrl,
          `refs/heads/${request.branch}:refs/heads/${request.branch}`,
        ],
        stop,
        gitHint,
      );

      const listed = await execute(
        request,
        'delivery-gh-pr-list',
        'gh pr list',
        [
          'gh',
          'pr',
          'list',
          '--repo',
          repository,
          '--head',
          request.branch,
          '--base',
          baseBranch,
          '--state',
          'all',
          '--limit',
          '20',
          '--json',
          'url,state',
        ],
        stop,
        ghHint,
      );
      const matches = parsePullRequestList(await stdoutOf(listed));
      const open = matches.filter((match) => match.state.toUpperCase() === 'OPEN');
      if (open.length > 1) {
        throw new DeliveryError(
          `${String(open.length)} open pull requests already match ${repository} head ` +
            `${request.branch} base ${baseBranch}, so the harness will not guess which one is ` +
            "this attempt's delivery. Resolve them by hand and deliver again.",
        );
      }

      // What is published is written down first: the same body goes to a new
      // pull request and to one that is updated, and the file stays beside the
      // run's other evidence — where an operator opening the pull request by
      // hand can take it from.
      const bodyFile = path.join(request.logsDir, 'delivery-pull-request-body.md');
      try {
        await writeFile(bodyFile, pullRequestBody(request), 'utf8');
      } catch (cause) {
        throw new DeliveryError(
          `the pull request body could not be written to ${bodyFile}: ${messageOf(cause)}.`,
        );
      }

      const [found] = open;
      if (found !== undefined) {
        await execute(
          request,
          'delivery-gh-pr-edit',
          'gh pr edit',
          [
            'gh',
            'pr',
            'edit',
            found.url,
            '--title',
            pullRequestTitle(request),
            '--body-file',
            bodyFile,
          ],
          stop,
          ghHint,
        );
        return { url: found.url, created: false };
      }

      // A match that is no longer open receives no edit: editing it would report
      // a delivery that no open review received. The branch is already pushed.
      if (matches.length > 0) {
        const described = matches.map((match) => `${match.url} (${match.state})`).join(', ');
        throw new DeliveryError(
          `the pull request found for ${repository} head ${request.branch} base ${baseBranch} ` +
            `is not open (${described}), so this attempt has no open review to receive it. The ` +
            'branch was pushed; the harness never reopens a closed or merged pull request and ' +
            'never edits one back into looking current. Either reopen it by hand if the review ' +
            `should continue, or open a new pull request from this branch yourself, using the ` +
            `title and the body this step wrote to ${bodyFile}.`,
        );
      }

      const created = await execute(
        request,
        'delivery-gh-pr-create',
        'gh pr create',
        [
          'gh',
          'pr',
          'create',
          '--repo',
          repository,
          '--head',
          request.branch,
          '--base',
          baseBranch,
          '--title',
          pullRequestTitle(request),
          '--body-file',
          bodyFile,
        ],
        stop,
        ghHint,
      );
      const url = pullRequestUrl(await stdoutOf(created));
      if (url === null) {
        throw new DeliveryError(
          'gh pr create did not report a pull request URL, so this harness cannot say what was ' +
            'created: it may already have opened one. Check the destination repository on GitHub ' +
            'before opening a pull request by hand — when an open pull request for this head and ' +
            'base is already there, the attempt is delivered, and this step updates it rather ' +
            'than creating a second one.',
        );
      }
      return { url, created: true };
    },
  };
}
