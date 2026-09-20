/** Offline gh boundary: actual pr view/checks and REST/GraphQL response shapes.
 * Only enablePullRequestAutoMerge receives the operator token. Read commands
 * receive the separate reader token; no command launches a reviewer or agent.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const wrongToken = (operation) =>
  expectedToken !== null &&
  (operation === 'merge' ? credential() !== expectedToken : credential() === expectedToken);

const denied = (operation) =>
  fail(
    `HTTP 403: Resource not accessible (${String(operation)}) — this invocation used the ` +
      `${operation === 'reviews' ? 'operator' : 'reviewer'} credential`,
  );

const enrich = (p) => ({
  id: `PR_${p.number}`,
  mergeable: 'MERGEABLE',
  title: 'Added fixture ownership checks',
  body: '',
  autoMergeRequest: null,
  ...p,
});
const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let operation;
if (argv[0] === 'pr') operation = argv[1];
else if (argv[0] === 'api' && argv[1] === 'graphql') operation = 'merge';
else if (argv[0] === 'api') {
  const endpoint = argv.find((a) => a.startsWith('repos/')) ?? '';
  operation = endpoint.endsWith('/comments')
    ? 'findings'
    : endpoint.endsWith('/reviews')
      ? 'reviews'
      : endpoint.endsWith('/check-runs')
        ? 'lens'
        : endpoint.endsWith('/runs')
          ? 'runs'
          : null;
}
record({ op: operation, auto: operation === 'merge', squash: operation === 'merge' });
if (failure === operation || (failure === 'checks' && operation === 'lens')) {
  fail('HTTP 403: GitHub refused the operation');
} else if (wrongToken(operation)) {
  denied(operation);
} else if (operation === 'list') {
  const list = jsonLines('pull-requests.json').filter(
    (p) =>
      p.repo === optionValue('--repo') &&
      p.headRefName === optionValue('--head') &&
      p.baseRefName === optionValue('--base') &&
      p.state === 'OPEN',
  );
  reply(list.map(enrich));
} else if (operation === 'view') {
  const p = pullFor(optionValue('--repo'), argv[2]);
  if (!p) fail('HTTP 404');
  else reply(enrich(p));
} else if (operation === 'reviews') {
  reply(
    jsonDocument('pr-reviews.json', []).map((r) => ({
      id: r.id,
      user: r.author,
      state: r.state,
      body: r.body,
      commit_id: r.commitId,
      html_url: r.url,
      submitted_at: r.submittedAt ?? '2026-09-20T10:00:00Z',
    })),
  );
} else if (operation === 'findings') {
  reply(jsonDocument('pr-reviews.json', []).flatMap((r) => r.inlineComments ?? []));
} else if (operation === 'lens') {
  const lens = jsonDocument('pr-checks.json', [])
    .filter((c) => c.name === 'Nexus Lens')
    .map((c, i) => ({
      id: c.id ?? 9001 + i,
      name: c.name,
      head_sha: c.headSha ?? 'a'.repeat(40),
      app: { id: c.appId ?? 123 },
      status: c.state === 'PENDING' ? 'in_progress' : 'completed',
      conclusion: c.conclusion?.toLowerCase() ?? null,
      details_url:
        c.reviewUrl ?? 'https://github.com/saintiago/nexus-harness/pull/29#pullrequestreview-555',
      html_url: c.link,
    }));
  reply({ total_count: lens.length, check_runs: lens });
} else if (operation === 'checks') {
  if (!argv.includes('--required') || optionValue('--json') !== 'name,state,link')
    fail('unsupported check arguments');
  else {
    const required = jsonDocument('pr-checks.json', [])
      .filter((c) => c.required !== false)
      .map((c) => ({ name: c.name, state: c.state, link: c.link }));
    reply(required);
    process.exitCode = required.some((c) => c.state === 'FAILURE')
      ? 1
      : required.some((c) => c.state === 'PENDING')
        ? 8
        : 0;
  }
} else if (operation === 'runs') {
  // Return all seeded records, even incorrect event/base/SHA. Production must verify every dimension itself.
  const runs = jsonLines('workflow-runs.json').map((r) => ({
    id: r.databaseId,
    workflow_id: r.workflowId,
    run_attempt: r.runAttempt ?? 1,
    name: r.name,
    path: r.path,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    head_sha: r.headSha,
    head_branch: r.headBranch,
    html_url: r.url,
  }));
  reply({ total_count: runs.length, workflow_runs: runs });
} else if (operation === 'merge') {
  const query = argv.find((a) => a.startsWith('query=')) ?? '';
  if (
    !query.includes('enablePullRequestAutoMerge') ||
    !query.includes('mergeMethod:SQUASH') ||
    query.includes('mergePullRequest(')
  )
    fail('direct merge forbidden');
  else {
    const node = (argv.find((a) => a.startsWith('pull=')) ?? '').slice(5);
    const pulls = jsonLines('pull-requests.json');
    const p = pulls.find((p) => `PR_${p.number}` === node);
    if (!p) fail('unknown PR node');
    else {
      p.autoMergeRequest = { enabledAt: '2026-09-20T12:00:00Z' };
      writeFileSync(
        path.join(stateDir, 'pull-requests.json'),
        pulls.map((p) => JSON.stringify(p)).join('\n') + '\n',
      );
      if (failure === 'merge-uncertain') {
        fail('HTTP 503: response lost after arming');
      } else
        reply({
          data: {
            enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: p.autoMergeRequest } },
          },
        });
    }
  }
} else fail(`Unsupported gh invocation: ${argv.join(' ')}`);
