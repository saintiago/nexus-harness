/**
 * The stand-in GitHub CLI of the offline delivery suites.
 *
 * It is a real program that a real `gh` name resolves to, on the `PATH` of the
 * CLI (or the module) under test, so everything above this boundary is real:
 * the delivery step, its bounded command runner, the argument list it builds,
 * the body file it writes, and the log files it keeps. Nothing in `src/` knows
 * this file exists, and no flag reaches it.
 *
 * It speaks the three invocations the delivery step makes, and only those:
 *
 *   gh pr list --repo <owner/name> --head <branch> --base <branch> --state all
 *              --limit 20 --json url,state
 *   gh pr create --repo <owner/name> --head <branch> --base <branch>
 *                --title <title> --body-file <file>
 *   gh pr edit <url> --title <title> --body-file <file>
 *
 * Anything else is an error, so a delivery step that changed the commands it
 * runs without changing this stand-in fails loudly instead of quietly passing.
 *
 * Its own record is what it was asked to do (one JSON line per invocation in
 * `calls.jsonl`) and what "GitHub" now holds (one JSON line per pull request in
 * `pull-requests.json`, each with the native state `gh` reports; one seeded
 * before a test runs needs its own `state`). `FAKE_GH` in the environment is
 * `{ "stateDir": "...", "fail": "list" | "create" | "edit" }`: the optional
 * failure makes that one invocation end nonzero with a GitHub-shaped message,
 * which is how the suites exercise a delivery that failed part-way.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(process.env.FAKE_GH ?? '{}');
const stateDir = config.stateDir;
const callsFile = path.join(stateDir, 'calls.jsonl');
const pullRequestsFile = path.join(stateDir, 'pull-requests.json');
const failure = config.fail ?? null;

mkdirSync(stateDir, { recursive: true });

const argv = process.argv.slice(2);
const pullRequests = existsSync(pullRequestsFile)
  ? readFileSync(pullRequestsFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  : [];

/** The value of one `--option`, or `null` when it is not there. */
const optionValue = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
};

/** The body of a `--body-file`, read the way gh reads it. */
const bodyFrom = (file) => (file === null ? null : readFileSync(file, 'utf8'));

/** One JSON line in `calls.jsonl`: what was asked, and what this stand-in said. */
const record = (entry) => {
  appendFileSync(
    callsFile,
    `${JSON.stringify({ argv, cwd: process.cwd(), fail: failure, ...entry })}\n`,
    'utf8',
  );
};

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

if (argv[0] !== 'pr') {
  process.stderr.write(`fake gh: unsupported command: ${argv.join(' ')}\n`);
  process.exitCode = 2;
} else if (argv[1] === 'list') {
  const entry = {
    op: 'list',
    repo: optionValue('--repo'),
    head: optionValue('--head'),
    base: optionValue('--base'),
    url: null,
    title: null,
    body: null,
  };
  record(entry);
  if (failure === 'list') {
    fail('HTTP 401: Bad credentials (https://api.github.com/graphql)');
  } else {
    process.stdout.write(
      `${JSON.stringify(
        pullRequests.map((pull) => ({ url: pull.url, state: pull.state ?? 'OPEN' })),
      )}\n`,
    );
  }
} else if (argv[1] === 'create') {
  const repo = optionValue('--repo');
  const body = bodyFrom(optionValue('--body-file'));
  record({
    op: 'create',
    repo,
    head: optionValue('--head'),
    base: optionValue('--base'),
    url: null,
    title: optionValue('--title'),
    body,
  });
  if (failure === 'create') {
    fail('GraphQL: Resource not accessible by integration (createPullRequest)');
  } else {
    const number = pullRequests.length + 1;
    const url = `https://github.com/${String(repo)}/pull/${String(number)}`;
    pullRequests.push({
      url,
      number,
      repo,
      head: optionValue('--head'),
      base: optionValue('--base'),
      title: optionValue('--title'),
      body,
      state: 'OPEN',
    });
    writeFileSync(
      pullRequestsFile,
      pullRequests.map((pull) => `${JSON.stringify(pull)}\n`).join(''),
      'utf8',
    );
    process.stdout.write(`${url}\n`);
  }
} else if (argv[1] === 'edit') {
  const url = argv[2] ?? null;
  const body = bodyFrom(optionValue('--body-file'));
  record({
    op: 'edit',
    repo: null,
    head: null,
    base: null,
    url,
    title: optionValue('--title'),
    body,
  });
  if (failure === 'edit') {
    fail('HTTP 404: Not Found (https://api.github.com/graphql)');
  } else {
    const held = pullRequests.find((pull) => pull.url === url);
    if (held === undefined) {
      fail(`HTTP 404: Not Found (${String(url)})`);
    } else {
      held.title = optionValue('--title');
      held.body = body;
      writeFileSync(
        pullRequestsFile,
        pullRequests.map((pull) => `${JSON.stringify(pull)}\n`).join(''),
        'utf8',
      );
    }
  }
} else {
  process.stderr.write(`fake gh: unsupported pr command: ${argv.join(' ')}\n`);
  process.exitCode = 2;
}
