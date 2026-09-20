/**
 * The stand-in GitHub CLI of the review-to-completion suites.
 *
 * Like tests/fixtures/fake-gh.mjs it is a real program a real `gh` name resolves
 * to, so everything above this boundary is real: the completion step, its
 * bounded command runner, the argument lists it builds, and the command logs it
 * keeps. Nothing in `src/` knows this file exists.
 *
 * It speaks the invocations the completion path makes, and only those:
 *
 *   gh pr list --repo <owner/name> --head <branch> --base <branch> --state open
 *              --limit 20 --json number,url,state,isDraft,headRefName,baseRefName,
 *              headRefOid,mergeCommit
 *   gh pr view <number|url> --repo <owner/name> --json <the same fields>
 *   gh pr reviews <url> --repo <owner/name> --json id,author,state,body,commitId,url
 *   gh pr checks <url> --repo <owner/name> --json name,state,conclusion,link
 *   gh pr merge <url> --repo <owner/name> --auto --squash
 *   gh run list --repo <owner/name> --commit <sha> --event push --branch <branch>
 *              --limit 100 --json databaseId,workflowId,name,path,event,status,
 *              conclusion,headSha,url
 *
 * Anything else is an error, so a completion path that changed its commands
 * without changing this stand-in fails loudly instead of quietly passing.
 *
 * `FAKE_GH` in the environment is
 * `{ "stateDir": "...", "token": "the operator credential", "fail": "<op>" }`.
 * `token` is what this stand-in expects to see in `GH_TOKEN` for every command
 * except `pr reviews`, which is the one invocation the reviewer's own credential
 * makes; a command reaching it with the wrong credential exits 1, so a swapped
 * credential is a failing test rather than a silent pass. `fail` makes one
 * invocation (`list`, `view`, `reviews`, `checks`, `merge`, `runs`) end nonzero
 * with a GitHub-shaped message.
 *
 * "GitHub" is held in three JSON files under the state directory:
 * `pull-requests.json` (one pull request per line),
 * `pr-reviews.json`, `pr-checks.json`, and `workflow-runs.json`. Each call is
 * recorded, one JSON line per invocation, in `calls.jsonl` with the credential
 * it was made with.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(process.env.FAKE_GH ?? '{}');
const stateDir = config.stateDir;
const callsFile = path.join(stateDir, 'calls.jsonl');
const failure = config.fail ?? null;
const expectedToken = config.token ?? null;

mkdirSync(stateDir, { recursive: true });

const argv = process.argv.slice(2);

/** The value of one `--option`, or `null` when it is not there. */
const optionValue = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
};

/** One file of JSON lines, as this stand-in reads its own state back. */
const jsonLines = (name) =>
  existsSync(path.join(stateDir, name))
    ? readFileSync(path.join(stateDir, name), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
    : [];

/** One file holding a single JSON document. */
const jsonDocument = (name, fallback) =>
  existsSync(path.join(stateDir, name))
    ? JSON.parse(readFileSync(path.join(stateDir, name), 'utf8'))
    : fallback;

/** What this invocation was made with: the credential is the point of the record. */
const credential = () => process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;

const record = (entry) => {
  appendFileSync(
    callsFile,
    `${JSON.stringify({ argv, credential: credential(), fail: failure, ...entry })}\n`,
    'utf8',
  );
};

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

/** The pull request one `--repo` and `<number|url>` name, or `undefined`. */
const pullFor = (repo, selector) => {
  const pulls = jsonLines('pull-requests.json');
  return pulls.find(
    (pull) =>
      (selector === null || String(pull.number) === String(selector) || pull.url === selector) &&
      (repo === null || pull.repo === repo),
  );
};

/**
 * The credential rule: every invocation except the reviewer's own `pr reviews`
 * read must carry the operator credential, and that one must carry the other.
 */
const wrongToken = (operation) => {
  if (expectedToken === null) {
    return false;
  }
  const used = credential();
  return operation === 'reviews' ? used === expectedToken : used !== expectedToken;
};

const denied = (operation) =>
  fail(
    `HTTP 403: Resource not accessible (${String(operation)}) — this invocation used the ` +
      `${operation === 'reviews' ? 'operator' : 'reviewer'} credential`,
  );

const op = argv[0] === 'pr' ? argv[1] : argv[0] === 'run' ? 'run' : argv[1];
if (argv[0] === 'pr' && argv[1] === 'list') {
  record({ op: 'list', repo: optionValue('--repo'), head: optionValue('--head'), url: null });
  if (failure === 'list') {
    fail('HTTP 401: Bad credentials (https://api.github.com/graphql)');
  } else if (wrongToken('list')) {
    denied('list');
  } else {
    const repo = optionValue('--repo');
    const head = optionValue('--head');
    const base = optionValue('--base');
    const state = (optionValue('--state') ?? 'open').toUpperCase();
    const matching = jsonLines('pull-requests.json').filter(
      (pull) =>
        pull.repo === repo &&
        pull.headRefName === head &&
        pull.baseRefName === base &&
        // `gh pr list --state open` answers with the open ones, plus the fixture
        // entry that carries `delivered: true` — the pull request this harness
        // delivered for that branch. GitHub removes a merged one from the open
        // list, so a test that seeds the merge keeps the delivered entry in the
        // answer while `gh pr view` reports the state GitHub has now.
        (state === 'OPEN'
          ? (pull.state ?? 'OPEN').toUpperCase() === 'OPEN' || pull.delivered === true
          : (pull.state ?? 'OPEN').toUpperCase() === state),
    );
    process.stdout.write(
      `${JSON.stringify(
        matching.map((pull) => ({
          number: pull.number,
          url: pull.url,
          // The delivered pull request is what this list answered with; a
          // fixture that has GitHub merge it in the meantime still carries the
          // merged state, and `gh pr view` then reports that merge.
          state: pull.state ?? 'OPEN',
          isDraft: pull.isDraft ?? false,
          headRefName: pull.headRefName,
          baseRefName: pull.baseRefName,
          headRefOid: pull.headRefOid,
          mergeCommit: pull.mergeCommit ?? null,
        })),
      )}\n`,
    );
  }
} else if (argv[0] === 'pr' && argv[1] === 'view') {
  const pull = pullFor(optionValue('--repo'), argv[2] ?? null);
  record({
    op: 'view',
    repo: optionValue('--repo'),
    url: pull?.url ?? argv[2] ?? null,
    state: pull?.state ?? null,
    headRefOid: pull?.headRefOid ?? null,
  });
  if (failure === 'view') {
    fail('HTTP 404: Not Found (https://api.github.com/graphql)');
  } else if (wrongToken('view')) {
    denied('view');
  } else if (pull === undefined) {
    fail(`HTTP 404: Not Found (${String(argv[2] ?? '')})`);
  } else {
    process.stdout.write(`${JSON.stringify(pull)}\n`);
  }
} else if (argv[0] === 'pr' && argv[1] === 'reviews') {
  record({ op: 'reviews', repo: optionValue('--repo'), url: argv[2] ?? null });
  if (failure === 'reviews') {
    fail('HTTP 500: Internal Server Error (https://api.github.com/graphql)');
  } else if (wrongToken('reviews')) {
    denied('reviews');
  } else {
    process.stdout.write(`${JSON.stringify(jsonDocument('pr-reviews.json', []))}\n`);
  }
} else if (argv[0] === 'pr' && argv[1] === 'checks') {
  record({ op: 'checks', repo: optionValue('--repo'), url: argv[2] ?? null });
  if (failure === 'checks') {
    fail('HTTP 500: Internal Server Error (https://api.github.com/graphql)');
  } else if (wrongToken('checks')) {
    denied('checks');
  } else {
    process.stdout.write(`${JSON.stringify(jsonDocument('pr-checks.json', []))}\n`);
  }
} else if (argv[0] === 'pr' && argv[1] === 'merge') {
  const pull = pullFor(optionValue('--repo'), argv[2] ?? null);
  record({
    op: 'merge',
    repo: optionValue('--repo'),
    url: pull?.url ?? argv[2] ?? null,
    auto: argv.includes('--auto'),
    squash: argv.includes('--squash'),
  });
  if (failure === 'merge') {
    fail('GraphQL: Pull request is not mergeable (enablePullRequestAutoMerge)');
  } else if (wrongToken('merge')) {
    denied('merge');
  } else if (pull === undefined) {
    fail(`HTTP 404: Not Found (${String(argv[2] ?? '')})`);
  } else if (!argv.includes('--auto') || !argv.includes('--squash')) {
    fail('HTTP 422: auto-merge was not requested as a squash merge');
  } else {
    process.stdout.write(`auto-merge enabled for ${pull.url}\n`);
  }
} else if (argv[0] === 'run' && argv[1] === 'list') {
  record({
    op: 'runs',
    repo: optionValue('--repo'),
    commit: optionValue('--commit'),
    event: optionValue('--event'),
    branch: optionValue('--branch'),
  });
  if (failure === 'runs') {
    fail('HTTP 500: Internal Server Error (https://api.github.com/graphql)');
  } else if (wrongToken('runs')) {
    denied('runs');
  } else {
    const commit = optionValue('--commit');
    const event = optionValue('--event');
    const branch = optionValue('--branch');
    const matching = jsonLines('workflow-runs.json').filter(
      (run) =>
        run.headSha === commit &&
        (run.event ?? 'push') === event &&
        (run.headBranch ?? branch) === branch,
    );
    process.stdout.write(`${JSON.stringify(matching)}\n`);
  }
} else {
  process.stderr.write(`fake gh: unsupported command (${String(op)}): ${argv.join(' ')}\n`);
  process.exitCode = 2;
}
