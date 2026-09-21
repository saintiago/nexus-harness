/** Offline gh boundary: actual pr view/checks and REST/GraphQL response shapes.
 * Only enablePullRequestAutoMerge receives the operator token. Read commands
 * receive the separate reader token; no command launches a reviewer or agent.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
const pullFor = (repo, selector, pulls = jsonLines('pull-requests.json')) => {
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

/**
 * A transient failure seeded for exactly one invocation. The test writes
 * `<stateDir>/fail-once.json`; the first matching operation consumes it and
 * answers the way a 5xx from GitHub would, so the completion path's retry can
 * be told from its classification of a settled refusal. With
 * `afterMerge: true`, only a read that follows a recorded auto-merge request
 * matches — that is the reading a mutation's answer is reconciled with.
 * `occurrence: n` matches only the *n*-th invocation of that operation, which
 * is how a read taken by one of the completion path's two write guards is
 * named; with `hang: true` the invocation instead stalls with no output at
 * all, so only the harness's own command limit can end it.
 */
const failOnce = (operation) => {
  const marker = path.join(stateDir, 'fail-once.json');
  if (!existsSync(marker)) return null;
  const spec = JSON.parse(readFileSync(marker, 'utf8'));
  if (spec.op !== undefined && spec.op !== operation) return null;
  if (spec.afterMerge === true && !jsonLines('calls.jsonl').some((call) => call.op === 'merge'))
    return null;
  // This invocation is already recorded, so the n-th one is the call whose own
  // count equals the number the test named.
  if (
    typeof spec.occurrence === 'number' &&
    jsonLines('calls.jsonl').filter((call) => call.op === operation).length !== spec.occurrence
  )
    return null;
  unlinkSync(marker);
  return spec;
};

/** How many `pr view` reads this stand-in has answered, kept across processes. */
const viewCount = () => {
  const file = path.join(stateDir, 'view-count.json');
  const seen = existsSync(file) ? Number(JSON.parse(readFileSync(file, 'utf8')).count ?? 0) : 0;
  const next = seen + 1;
  writeFileSync(file, `${JSON.stringify({ count: next })}\n`, 'utf8');
  return next;
};

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
const injected = failOnce(operation);
if (injected) {
  if (injected.hang === true) {
    // A read that never answers: it writes nothing on either stream and stays
    // alive until the harness stops it at its own command limit.
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  fail(
    `HTTP ${String(injected.status ?? 503)}: ` +
      `${String(injected.message ?? 'GitHub is temporarily unavailable')} (${operation})`,
  );
} else if (
  failure === operation ||
  (failure === 'checks' && operation === 'lens') ||
  (failure === 'view-after-arm' &&
    operation === 'view' &&
    jsonLines('pull-requests.json').some((pull) => pull.autoMergeRequest))
) {
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
  // One parse of the state file, so a merge this read performs and the record
  // it writes back are the same object.
  const pulls = jsonLines('pull-requests.json');
  const p = pullFor(optionValue('--repo'), argv[2], pulls);
  if (!p) fail('HTTP 404');
  else {
    // A merge GitHub makes between two reads of the same pull request: the
    // answer to the named read is the merged record, exactly as a fresh read
    // after the merge would report it.
    const seen = viewCount();
    if (typeof config.mergeOnView === 'number' && seen === config.mergeOnView) {
      p.state = 'MERGED';
      p.mergeCommit = { oid: config.mergeOnViewSha ?? 'c'.repeat(40) };
      writeFileSync(
        path.join(stateDir, 'pull-requests.json'),
        `${pulls.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      );
    }
    reply(enrich(p));
  }
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
      const checks = jsonDocument('pr-checks.json', []);
      const requiredNames = Array.isArray(config.requiredChecks) ? config.requiredChecks : null;
      const clean =
        requiredNames !== null
          ? requiredNames.length > 0 &&
            requiredNames.every((name) =>
              checks.some((check) => check.name === name && check.state === 'SUCCESS'),
            )
          : checks.some((check) => check.required !== false) &&
            checks
              .filter((check) => check.required !== false)
              .every((check) => check.state === 'SUCCESS');
      if (typeof config.mergeBeforeArm === 'string') {
        // GitHub merges the reviewed pull request while the auto-merge request
        // is in flight: the request is no longer acceptable, and the merge it
        // was asking for has already happened.
        p.state = 'MERGED';
        p.mergeCommit = { oid: config.mergeBeforeArm };
        writeFileSync(
          path.join(stateDir, 'pull-requests.json'),
          `${pulls.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
        );
        fail('HTTP 422: Pull request is already merged (enablePullRequestAutoMerge)');
      } else if (config.rejectArmWhenClean === true && clean) {
        // GitHub refuses to arm a pull request whose required checks are
        // already green: there is nothing left for auto-merge to wait for.
        fail('HTTP 422: Pull request is in clean status (enablePullRequestAutoMerge)');
      } else {
        p.autoMergeRequest = { enabledAt: '2026-09-20T12:00:00Z' };
        if (typeof config.mergeOnArm === 'string') {
          // GitHub performs the merge itself once auto-merge is armed: a test
          // that wants the merge to land straight away seeds the merge commit
          // that the configured post-merge workflows ran for.
          p.state = 'MERGED';
          p.mergeCommit = { oid: config.mergeOnArm };
        }
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
  }
} else fail(`Unsupported gh invocation: ${argv.join(' ')}`);
