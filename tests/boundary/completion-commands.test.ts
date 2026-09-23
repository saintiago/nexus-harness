/**
 * The completion path's own GitHub commands, run through a real stand-in `gh`.
 *
 * The completion step reads GitHub only to decide what GitHub already did: the
 * open pull requests of a delivered branch, the current head's review and its
 * app-owned check, the required pull request checks, the merge, and the
 * post-merge workflow runs. Every read carries the separate reader credential
 * and never the operator's, the one mutation that arms native auto-merge
 * carries the operator's credential and is never replayed, and a read that
 * failed is reported with the command's own diagnostic — with local paths and
 * credential values kept out of what reaches the ticket.
 *
 * The stand-in runs through the same launcher the delivery suite uses, so the
 * invocation, the working directory, and the environment the harness hands each
 * command are exactly what production hands them.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompletionError, createGitHubCompletion } from '../../src/delivery/completion.js';
import type { CompletionRequest } from '../../src/delivery/completion.js';
import type { PullRequestSnapshot } from '../../src/delivery/completion.js';
import { DeliveryError } from '../../src/delivery/github.js';
import type { CompletionConfig, SourceRef } from '../../src/shared/types.js';
import { createTempDir } from '../support.js';
import { installStandIn, withPathPrefix } from './integration-support.js';

const SITE = 'https://example.atlassian.net';
const REPOSITORY = 'example/target';
const BRANCH = 'harness/HARN-77';
const BASE_BRANCH = 'main';
const HEAD = 'a'.repeat(40);
const PULL_URL = `https://github.com/${REPOSITORY}/pull/42`;
const REVIEW_URL = `${PULL_URL}#pullrequestreview-9001`;

const CONFIG: CompletionConfig = {
  lensApp: 'nexus-lens[bot]',
  lensAppId: 4711,
  lensCheckName: 'Nexus Lens',
  reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
  postMergeWorkflows: ['.github/workflows/ci.yml'],
  toDoStatus: 'To Do',
  doneStatus: 'Done',
  pollIntervalSeconds: 5,
  deadlineSeconds: 600,
};

const REF: SourceRef = {
  type: 'jira',
  scope: SITE,
  id: '10077',
  key: 'HARN-77',
  url: `${SITE}/browse/HARN-77`,
  updatedAt: '2026-09-22T10:00:00.000Z',
};

/** The reader credential, which no read may replace with the operator's. */
const READER_TOKEN = 'lens-reader-token-that-must-not-travel';
/** The operator credential, which only the one mutation carries. */
const OPERATOR_TOKEN = 'operator-token-that-must-not-travel';

/** One pull request as GitHub reports it, at the reviewed head. */
const PULL = {
  id: 'PR_42',
  number: 42,
  url: PULL_URL,
  state: 'OPEN',
  isDraft: false,
  headRefName: BRANCH,
  baseRefName: BASE_BRANCH,
  headRefOid: HEAD,
  mergeCommit: null,
  autoMergeRequest: null,
  mergeable: 'MERGEABLE',
  title: 'Finish the greeting',
  body: '',
};

/** The review that approves the current head, as the reviews page carries it. */
const REVIEW = {
  id: 9001,
  user: { login: CONFIG.lensApp },
  state: 'APPROVED',
  body: 'the change does what the ticket asks',
  commit_id: HEAD,
  submitted_at: '2026-09-22T11:00:00.000Z',
  html_url: REVIEW_URL,
};

/** The app-owned check run behind the approval, as the check list carries it. */
const LENS_CHECK = {
  id: 7001,
  name: CONFIG.lensCheckName,
  head_sha: HEAD,
  status: 'completed',
  conclusion: 'success',
  details_url: REVIEW_URL,
  app: { id: CONFIG.lensAppId },
};

/**
 * The stand-in `gh`: it records every invocation with the credential it was
 * given and answers the documented reads. `Answers` is one JSON body per
 * operation, and an operation left out is refused the way an unexpected
 * invocation would be.
 */
const STAND_IN_GH = [
  `import { appendFileSync } from 'node:fs';`,
  `const args = process.argv.slice(2);`,
  `appendFileSync(process.env.NEXUS_GH_RECORD, JSON.stringify({`,
  `  args,`,
  `  cwd: process.cwd(),`,
  `  token: process.env.GH_TOKEN ?? null,`,
  `}) + '\\n');`,
  `const answers = JSON.parse(process.env.NEXUS_GH_ANSWERS);`,
  `const subcommand = args.slice(0, 2).join(' ');`,
  `const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';`,
  `let answer;`,
  `if (subcommand === 'pr list') answer = answers['pr list'];`,
  `else if (subcommand === 'pr view') answer = answers['pr view'];`,
  `else if (subcommand === 'pr checks') answer = answers['pr checks'];`,
  `else if (args[0] === 'api' && args[1] === 'graphql') answer = answers['api graphql'];`,
  `else if (args[0] === 'api' && endpoint.includes('/reviews')) answer = answers['api reviews'];`,
  `else if (args[0] === 'api' && endpoint.includes('check-runs')) answer = answers['api checks'];`,
  `else if (args[0] === 'api' && endpoint.includes('actions/workflows'))`,
  `  answer = answers['api runs'];`,
  `if (answer === undefined) {`,
  `  process.stderr.write('gh: unexpected ' + args.join(' ') + '\\n');`,
  `  process.exit(2);`,
  `}`,
  `if (answer.stderr !== undefined) {`,
  `  process.stderr.write(answer.stderr);`,
  `  process.exit(answer.exitCode ?? 1);`,
  `}`,
  `process.stdout.write(JSON.stringify(answer));`,
  `process.exit(answer.exitCode ?? 0);`,
  '',
].join('\n');

/** Everything one case's completion step works with. */
interface CompletionFixture {
  readonly request: CompletionRequest;
  readonly record: string;
}

async function completionFixture(): Promise<CompletionFixture> {
  const root = await createTempDir();
  const workspacePath = path.join(root, 'workspace');
  const logsDir = path.join(root, 'logs');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  return {
    request: {
      ref: REF,
      workspaceId: 'HARN-77',
      repository: REPOSITORY,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      workspacePath,
      logsDir,
    },
    record: path.join(root, 'gh.jsonl'),
  };
}

/** Runs one completion action with the stand-in `gh` first on `PATH`. */
async function withCompletion<T>(
  fixture: CompletionFixture,
  answers: Record<string, unknown>,
  work: (actions: ReturnType<typeof createGitHubCompletion>) => Promise<T>,
): Promise<T> {
  const standIn = await installStandIn('gh', STAND_IN_GH);
  const saved = {
    answers: process.env.NEXUS_GH_ANSWERS,
    record: process.env.NEXUS_GH_RECORD,
    operator: process.env.GH_TOKEN,
  };
  process.env.NEXUS_GH_ANSWERS = JSON.stringify(answers);
  process.env.NEXUS_GH_RECORD = fixture.record;
  process.env.GH_TOKEN = OPERATOR_TOKEN;
  try {
    return await withPathPrefix(
      standIn.bin,
      async () => await work(createGitHubCompletion(CONFIG, READER_TOKEN)),
    );
  } finally {
    for (const [name, value] of [
      ['NEXUS_GH_ANSWERS', saved.answers],
      ['NEXUS_GH_RECORD', saved.record],
      ['GH_TOKEN', saved.operator],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** Every stand-in `gh` invocation one case made, in order. */
async function invocations(
  fixture: CompletionFixture,
): Promise<
  readonly { readonly args: readonly string[]; readonly cwd: string; readonly token: string }[]
> {
  const text = await readFile(fixture.record, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly args: readonly string[];
          readonly cwd: string;
          readonly token: string;
        },
    );
}

/** The one error a completion action that was expected to fail rejected with. */
async function completionFailure(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (cause) {
    if (cause instanceof DeliveryError || cause instanceof CompletionError) {
      return cause;
    }
    throw new Error(`the completion failed with something else: ${String(cause)}`, { cause });
  }
  throw new Error('the completion was expected to fail, and it did not');
}

describe('the completion path’s GitHub commands', () => {
  it('reads the current head’s approval with the reader credential, and never the operator’s', async () => {
    const fixture = await completionFixture();

    const verdict = await withCompletion(
      fixture,
      {
        'pr list': [PULL],
        'pr view': PULL,
        'api reviews': [REVIEW],
        'api checks': { total_count: 1, check_runs: [LENS_CHECK] },
        'pr checks': [],
      },
      async (actions) => {
        const pull = await actions.findPullRequest(fixture.request, new AbortController().signal);
        if (pull === null) throw new Error('the delivered pull request was not found');
        return await actions.readGate(fixture.request, pull, new AbortController().signal);
      },
    );

    // The gate is the reviewer's decision on this exact head, with its own
    // app-owned check behind it.
    expect(verdict.status).toBe('approved');
    expect(verdict.review?.commitId).toBe(HEAD);
    expect(verdict.review?.url).toBe(REVIEW_URL);

    const calls = await invocations(fixture);
    const asRequested = calls.map((call) => {
      const endpoint = call.args.find((argument) => argument.startsWith('repos/'));
      return endpoint === undefined ? call.args.slice(0, 2).join(' ') : endpoint.split('?')[0];
    });
    expect(asRequested).toEqual([
      'pr list',
      'pr view',
      `repos/${REPOSITORY}/pulls/42/reviews`,
      `repos/${REPOSITORY}/commits/${HEAD}/check-runs`,
      'pr checks',
    ]);
    // Every read carried the reader credential, and none carried the operator's.
    for (const call of calls) {
      expect(call.token).toBe(READER_TOKEN);
      expect(call.token).not.toBe(OPERATOR_TOKEN);
      expect(call.cwd).toBe(fixture.request.workspacePath);
    }
  }, 60_000);

  it('arms native auto-merge with the operator credential, and only that mutation does', async () => {
    const fixture = await completionFixture();
    const pull: PullRequestSnapshot = {
      number: PULL.number,
      url: PULL.url,
      state: PULL.state,
      isDraft: PULL.isDraft,
      headRefName: PULL.headRefName,
      baseRefName: PULL.baseRefName,
      headRefOid: PULL.headRefOid,
      nodeId: PULL.id,
      mergeable: PULL.mergeable,
      title: PULL.title,
      body: PULL.body,
      autoMergeRequest: null,
      mergeCommit: null,
    };

    const status = await withCompletion(
      fixture,
      {
        'api graphql': {
          data: {
            enablePullRequestAutoMerge: {
              pullRequest: { autoMergeRequest: { enabledAt: '2026-09-22T11:30:00.000Z' } },
            },
          },
        },
      },
      async (actions) =>
        await actions.enableAutoMerge(fixture.request, pull, HEAD, new AbortController().signal),
    );

    expect(status).toBe('enabled');
    const calls = await invocations(fixture);
    expect(calls).toHaveLength(1);
    // The mutation is the operator's, and it names the pull request by node id.
    expect(calls[0]?.token).toBe(OPERATOR_TOKEN);
    expect(calls[0]?.args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(calls[0]?.args.join(' ')).toContain(`pull=${PULL.id}`);
  }, 60_000);

  it('repeats what GitHub said about a failed read, without the credential or the local path', async () => {
    const fixture = await completionFixture();
    const diagnostic =
      `HTTP 403: Resource not accessible by integration (${READER_TOKEN}) at ` +
      `${path.join('C:', 'workspace')} `;

    const failure = await completionFailure(() =>
      withCompletion(
        fixture,
        { 'pr list': { stderr: `${diagnostic}\n`, exitCode: 1 } },
        async (actions) =>
          await actions.findPullRequest(fixture.request, new AbortController().signal),
      ),
    );

    // The command's own last line is kept — GitHub's refusal is the useful part
    // — while a credential value and the retained working copy's path are not.
    expect(failure.message).toContain('HTTP 403');
    expect(failure.message).toContain('[redacted]');
    expect(failure.message).not.toContain(READER_TOKEN);
    expect(failure.message).toContain('operator attention required');
  }, 60_000);

  it('refuses a read that exited successfully but carried no readable evidence', async () => {
    const fixture = await completionFixture();

    // The stand-in exits `0` writing nothing at all: an empty answer is not an
    // evidence list, so the read is refused rather than read as "no pull
    // request is open".
    const failure = await completionFailure(() =>
      withCompletion(
        fixture,
        { 'pr list': { stderr: '', exitCode: 0 } },
        async (actions) =>
          await actions.findPullRequest(fixture.request, new AbortController().signal),
      ),
    );

    expect(failure.message).toContain('no readable evidence');
  }, 60_000);
});
