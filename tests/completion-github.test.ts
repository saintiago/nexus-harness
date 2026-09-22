/**
 * The review-to-completion path through the real GitHub boundary.
 *
 * Every pass here runs the real completion step, the real bounded command runner and the stand-in `gh` on disk, with the real Jira completion reader and writer against a fake HTTP boundary. What this file owns is the command boundary: the reader credential and its separation from the operator token, the evidence directory, the exact `gh` invocations, and the decision matrix over their answers.
 */

import { describe, expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SourceError } from '../src/sources/contract.js';
import {
  APPROVED_REVIEW,
  HEAD,
  JIRA_TOKEN,
  LENS_CHECK_PASSED,
  LENS_CHECK_URL,
  MERGE_COMMIT,
  ONE_PULL_REQUEST,
  OPERATOR_TOKEN,
  OTHER_HEAD,
  PR_URL,
  REVIEWER_TOKEN,
  REVIEW_URL,
  WORKSPACE_POINTER,
  WORKFLOW_URL,
  commentTexts,
  createFixture,
  mergedPullRequest,
  only,
  passFor,
  runPass,
  transitions,
  workflowRun,
} from './fixtures/completion.js';
import { fakeCompletionCalls } from './fixtures/local-target.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';

useFixtureLifecycle();

describe('review-to-completion', () => {
  it('refreshes the reader credential for later evidence reads without changing the operator identity', async () => {
    const fixture = await createFixture({ merged: true });
    let readings = 0;
    const outcome = only(
      await runPass(fixture, {
        reader: async () => `installation-token-${String(++readings)}`,
      }),
    );
    expect(outcome.status, outcome.detail).toBe('done');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.map((call) => call.credential)).toEqual(
      calls.map((_, index) => `installation-token-${String(index + 1)}`),
    );
  });

  it('stops before GitHub commands or Jira writes when reader refresh fails', async () => {
    const fixture = await createFixture({ merged: true });
    const outcome = only(
      await runPass(fixture, {
        reader: async () => {
          throw new Error('App installation refresh denied');
        },
      }),
    );
    expect(outcome.status).toBe('attention');
    expect(outcome.detail).toContain('App installation refresh denied');
    expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
    expect(commentTexts(fixture)).toEqual([]);
    expect(transitions(fixture)).toEqual([]);
  });

  it('refuses a refreshed reader token that equals the operator credential', async () => {
    const fixture = await createFixture({ merged: true });
    const outcome = only(await runPass(fixture, { reader: async () => OPERATOR_TOKEN }));
    expect(outcome.status).toBe('attention');
    expect(outcome.detail).toContain('credentials must be different');
    expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
    expect(transitions(fixture)).toEqual([]);
  });

  it('finishes an approved pull request after its merge and main workflow succeeded', async () => {
    const fixture = await createFixture({ merged: true, runs: [workflowRun()] });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    const comment = commentTexts(fixture)[0] ?? '';
    expect(comment).toContain('nexus-completion:resolution:');
    expect(comment).toContain(MERGE_COMMIT);
    expect(comment).toContain(PR_URL);
    expect(comment).toContain(WORKFLOW_URL);
    // The resolution comment is one short, evidence-based note: at most 120
    // words, which is what the task asks the issue's thread to receive.
    expect(comment.split(/\s+/).filter((word) => word !== '').length).toBeLessThanOrEqual(120);

    const calls = await fakeCompletionCalls(fixture.gh);
    // A pull request that is already merged proves its reviewed head from the
    // approval alone: there is no open pull request left to gate, and the merge
    // and its workflows are what is read.
    expect(calls.some((call) => call.op === 'reviews')).toBe(true);
    expect(calls.some((call) => call.op === 'lens')).toBe(true);
    expect(calls.some((call) => call.op === 'runs')).toBe(true);
    expect(calls.every((call) => call.credential === REVIEWER_TOKEN)).toBe(true);
  });

  // This integration-style case launches several fake `gh` subprocesses. It
  // completes in about three seconds alone but can exceed Vitest's five-second
  // default while the full suite runs in parallel, so retain a bounded timeout
  // without weakening the assertions or the suite-wide guard.
  it('arms native auto-merge with the operator credential and waits for GitHub to merge', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      runs: [],
      config: { deadlineSeconds: 10 },
    });
    // The merge happens with the second reading of the pull request; the
    // workflow run appears only on the third poll, which is the delay this path
    // has to tolerate.
    let views = 0;
    let runPolls = 0;
    const originalRuns = fixture.gh.runsFile;
    await writeFile(originalRuns, '', 'utf8');

    const outcome = only(
      await runPass(fixture, {
        clockStepMs: 1_000,
        reader: async () => REVIEWER_TOKEN,
        onSleep: async () => {
          views += 1;
          if (views === 1) {
            await writeFile(
              fixture.gh.pullRequestsFile,
              `${JSON.stringify(mergedPullRequest())}\n`,
              'utf8',
            );
          }
          runPolls += 1;
          if (runPolls === 2) {
            await writeFile(fixture.gh.runsFile, `${JSON.stringify(workflowRun())}\n`, 'utf8');
          }
        },
      }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    const calls = await fakeCompletionCalls(fixture.gh);
    const merge = calls.find((call) => call.op === 'merge');
    expect(merge?.credential).toBe(OPERATOR_TOKEN);
    expect(
      calls
        .filter((call) => call.op !== 'merge')
        .every((call) => call.credential === REVIEWER_TOKEN),
    ).toBe(true);
    expect(merge?.auto).toBe(true);
    expect(merge?.squash).toBe(true);
    expect(merge?.argv.join(' ')).toContain('enablePullRequestAutoMerge');
    expect(merge?.argv.join(' ')).not.toContain('mergePullRequest(');
    // No direct merge: the completion path only ever asks GitHub to arm it.
    expect(calls.some((call) => call.argv.includes('--admin'))).toBe(false);
    expect(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ).toContain(HEAD);
  }, 15_000);

  it('creates the per-issue evidence directory before its first GitHub command', async () => {
    // The production start: nothing has created `completion-logs` yet, and the
    // first GitHub read is what has to write its output there.
    const fixture = await createFixture({ evidenceDir: false });

    const outcome = only(
      await runPass(fixture, {
        clockStepMs: 1_000,
        onSleep: async () => {
          await writeFile(
            fixture.gh.pullRequestsFile,
            `${JSON.stringify(mergedPullRequest())}\n`,
            'utf8',
          );
        },
      }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    // The directory the pass needed did not exist when it started, and every
    // command it ran wrote its own output into the one it created.
    const entries = await readdir(fixture.logsDir);
    const outputs = entries.filter((name) => name.endsWith('.stdout.log'));
    expect(outputs.length).toBeGreaterThan(0);
    const written = (
      await Promise.all(outputs.map((name) => readFile(path.join(fixture.logsDir, name), 'utf8')))
    ).join('\n');
    expect(written).toContain('"number":29');
    expect(entries).toContain('completion-armed-head.json');
  });

  it('stops for a person and names the location when its evidence directory cannot be created', async () => {
    const fixture = await createFixture({ evidenceDir: false });
    // A file where the per-issue directory belongs: creating the evidence
    // directory fails the way a path or permission problem would, before any
    // GitHub command has a log directory to write into.
    await writeFile(path.join(fixture.workDir, 'completion-logs'), 'not a directory\n', 'utf8');

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain(fixture.logsDir);
    expect(outcome.detail).toContain('could not be created');
    expect(outcome.detail).toContain('auto-merge was not armed');
    for (const credential of [OPERATOR_TOKEN, REVIEWER_TOKEN, JIRA_TOKEN])
      expect(outcome.detail).not.toContain(credential);
    // Nothing was read from GitHub, nothing was armed, and Jira was not touched.
    expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
    expect(commentTexts(fixture)).toEqual([]);
    expect(transitions(fixture)).toEqual([]);
    expect(fixture.jira.status).toBe('In Review');
  });

  it('bounds pending required pull request checks with an attention comment', async () => {
    const fixture = await createFixture({
      checks: [
        LENS_CHECK_PASSED,
        { name: 'validate', state: 'PENDING', conclusion: null, link: LENS_CHECK_URL },
      ],
    });

    const outcome = only(await runPass(fixture, { clockStepMs: 20_000 }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.filter((call) => call.op === 'merge')).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:attention:');
    expect(commentTexts(fixture)[0]).toContain('deadline');
  });

  it('returns a request-changes decision to the To Do status with the review link', async () => {
    const fixture = await createFixture({
      reviews: [
        {
          ...APPROVED_REVIEW,
          state: 'CHANGES_REQUESTED',
          body: 'The fixture ownership check is inverted; fix it and add a regression test.',
        },
      ],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain(REVIEW_URL);
    expect(commentTexts(fixture)[0]).toContain('fixture ownership check is inverted');
    // The workspace pointer is never removed: the repair continues there.
    expect(fixture.jira.labels).toContain(WORKSPACE_POINTER);
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('treats a failed Lens check associated with request changes as a finding', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, state: 'CHANGES_REQUESTED' }],
      checks: [
        { name: 'Nexus Lens', state: 'FAILURE', conclusion: 'FAILURE', link: LENS_CHECK_URL },
      ],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(commentTexts(fixture)[0]).toContain('Nexus Lens');
    expect(commentTexts(fixture)[0]).toContain(REVIEW_URL);
  });

  it('treats a failed required pull request check as a finding naming the check', async () => {
    const fixture = await createFixture({
      checks: [
        LENS_CHECK_PASSED,
        {
          name: 'validate',
          state: 'FAILURE',
          conclusion: 'FAILURE',
          link: 'https://github.com/saintiago/nexus-harness/actions/runs/7001',
        },
      ],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('validate');
    expect(commentTexts(fixture)[0]).toContain('actions/runs/7001');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('stays In Review with no comment when a stale head is the only approval', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, commitId: OTHER_HEAD }],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('observed');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('stays In Review when the approval has no app-owned Lens check behind it', async () => {
    const fixture = await createFixture({ checks: [] });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('observed');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it('never arms a pull request whose reviews are missing or unclear', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, state: 'COMMENTED' }],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('observed');
    expect(fixture.jira.status).toBe('In Review');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('stays In Review when the delivered pull request is closed rather than open', async () => {
    const fixture = await createFixture({ pulls: [{ ...ONE_PULL_REQUEST, state: 'CLOSED' }] });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('observed');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it('stays In Review when two open pull requests make the delivery ambiguous', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST, { ...ONE_PULL_REQUEST, number: 30, url: `${PR_URL}x` }],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });

  it('reports a branch-protection refusal and stays In Review', async () => {
    const fixture = await createFixture({});

    const outcome = only(await runPass(fixture, { fail: 'merge' }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:attention:');
    expect(commentTexts(fixture)[0]).toContain('operator attention');
  });

  it('reports an authentication failure and stays In Review', async () => {
    const fixture = await createFixture({});

    const outcome = only(await runPass(fixture, { fail: 'list' }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    // The list is what failed, so there is no pull request to point at yet: the
    // pass reports the failure and writes nothing.
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(outcome.detail).toContain('operator attention');
  });

  it('returns a post-merge workflow failure to To Do with its conclusion and link', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun({ status: 'completed', conclusion: 'failure', databaseId: 5001 })],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    const comment = commentTexts(fixture)[0] ?? '';
    expect(comment).toContain('ci.yml');
    expect(comment).toContain('FAILURE');
    expect(comment).toContain(WORKFLOW_URL);
    expect(comment).toContain(MERGE_COMMIT);
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['timed_out', 'TIMED_OUT'],
    ['action_required', 'ACTION_REQUIRED'],
    ['stale', 'STALE'],
    ['skipped', 'SKIPPED'],
    ['neutral', 'NEUTRAL'],
  ])('treats a latest workflow attempt of %s as unsuccessful', async (_, conclusion) => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun({ status: 'completed', conclusion })],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(commentTexts(fixture)[0]).toContain(String(conclusion).toUpperCase());
  });

  it('reads only the latest attempt of each configured workflow', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [
        workflowRun({ databaseId: 5001, status: 'completed', conclusion: 'failure' }),
        workflowRun({ databaseId: 5002, status: 'completed', conclusion: 'success' }),
      ],
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
  });

  it('requires every configured workflow, not just one', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun()],
      config: { postMergeWorkflows: ['ci.yml', 'release.yml'] },
    });

    const outcome = only(await runPass(fixture, { clockStepMs: 20_000 }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)[0]).toContain('deadline');
    expect(commentTexts(fixture)[0]).toContain('release.yml');
  });

  it('matches a workflow by its numeric ID as well as its file', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun()],
      config: { postMergeWorkflows: ['17'] },
    });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
  });

  it('ignores a run for another event or branch when it looks like the workflow', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun({ event: 'pull_request' }), workflowRun({ headBranch: 'release' })],
    });

    const outcome = only(await runPass(fixture, { clockStepMs: 20_000 }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)[0]).toContain('no run yet');
  });

  it('writes one findings comment and one move when the pass is repeated', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, state: 'CHANGES_REQUESTED' }],
    });

    const first = only(await runPass(fixture));
    expect(first.status).toBe('to-do');
    // A person moved it back for repair: the second pass finds it no longer In
    // Review and touches nothing.
    fixture.jira.status = 'In Review';
    const second = only(await runPass(fixture));

    expect(second.status).toBe('observed');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
  });

  it('resumes a resolution comment whose Done move never arrived', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.transitionFailure = true;

    // The merge and its workflow succeed, the comment lands, and the move does
    // not: the item is still In Review with the resolution comment on it.
    const first = only(await runPass(fixture));
    expect(first.status).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(1);

    fixture.jira.transitionFailure = false;
    const second = only(await runPass(fixture));

    expect(second.status).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.filter((call) => call.op === 'merge')).toHaveLength(0);
  });

  it('does not duplicate the resolution comment when the move failed first', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.transitionFailure = true;

    // The merge and its workflow are verified, the resolution comment lands, and
    // the move does not: the item is still In Review with that comment on it.
    const first = only(await runPass(fixture));

    expect(first.status).toBe('attention');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:resolution:');

    fixture.jira.transitionFailure = false;
    const second = only(await runPass(fixture));

    expect(second.status).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
  });

  it('follows a merge GitHub makes after auto-merge was armed', async () => {
    const fixture = await createFixture({ pulls: [ONE_PULL_REQUEST] });

    const first = only(await runPass(fixture, { clockStepMs: 1_000 }));
    expect(first.status).toBe('pending');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);

    // GitHub merges the armed pull request while nothing is polling.
    await writeFile(
      fixture.gh.pullRequestsFile,
      `${JSON.stringify(mergedPullRequest())}\n`,
      'utf8',
    );
    const calls = await fakeCompletionCalls(fixture.gh);
    expect(calls.filter((call) => call.op === 'merge')).toHaveLength(1);

    const second = only(await runPass(fixture));

    expect(second.status).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:resolution:');
  });

  it('stops without mutation when a person moved the ticket out of In Review', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.status = 'In Progress';

    const outcomes = await passFor(fixture).run(AbortSignal.timeout(30_000));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('observed');
    expect(outcomes[0]?.detail).toContain('no longer In Review');
    expect(fixture.jira.status).toBe('In Progress');
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it('reports a Jira read failure without moving anything', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.readFailure = true;

    await expect(passFor(fixture).run(AbortSignal.timeout(30_000))).rejects.toBeInstanceOf(
      SourceError,
    );
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it('does not write a second comment when the first write was uncertain', async () => {
    const fixture = await createFixture({
      reviews: [{ ...APPROVED_REVIEW, state: 'CHANGES_REQUESTED' }],
    });
    // The comment lands, but the answer is lost: the client cannot acknowledge it.
    fixture.jira.commentFailure = true;
    const failing = only(await runPass(fixture));
    expect(failing.status).toBe('attention');
    expect(commentTexts(fixture)).toHaveLength(0);

    // On the next pass the write succeeds and the item moves exactly once.
    fixture.jira.commentFailure = false;
    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
  });

  it.each([
    { appId: 999 },
    { headSha: OTHER_HEAD },
    { reviewUrl: `${PR_URL}#another-review` },
    { state: 'FAILURE', conclusion: 'FAILURE' },
  ])('refuses an unowned, stale, unrelated or contradictory Lens check: %j', async (override) => {
    const fixture = await createFixture({ checks: [{ ...LENS_CHECK_PASSED, ...override }] });
    const result = only(await runPass(fixture));
    expect(result.status).toBe('observed');
    expect(fixture.jira.comments).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
    expect((await fakeCompletionCalls(fixture.gh)).some((c) => c.op === 'merge')).toBe(false);
  });

  it('uses the latest review decision even when an older approval is present', async () => {
    const fixture = await createFixture({
      reviews: [
        APPROVED_REVIEW,
        {
          ...APPROVED_REVIEW,
          id: 556,
          state: 'CHANGES_REQUESTED',
          body: 'Fix the ownership race.',
        },
      ],
    });
    expect(only(await runPass(fixture)).status).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('ownership race');
  });

  it('does not arm twice across restart or an uncertain auto-merge response', async () => {
    const fixture = await createFixture();
    await runPass(fixture, { fail: 'merge-uncertain', clockStepMs: 1000 });
    await runPass(fixture, { clockStepMs: 1000 });
    expect((await fakeCompletionCalls(fixture.gh)).filter((c) => c.op === 'merge')).toHaveLength(1);
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('returns a failed required check observed after arming to To Do', async () => {
    const fixture = await createFixture();
    const result = only(
      await runPass(fixture, {
        clockStepMs: 1000,
        onSleep: async () => {
          await writeFile(
            fixture.gh.checksFile,
            JSON.stringify([
              LENS_CHECK_PASSED,
              { name: 'validate', state: 'FAILURE', link: WORKFLOW_URL },
            ]),
          );
        },
      }),
    );
    expect(result.status, result.detail).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('validate');
    expect(fixture.jira.labels).toContain(WORKSPACE_POINTER);
  });

  it('does not return an optional failed check for repair', async () => {
    const fixture = await createFixture({
      checks: [
        LENS_CHECK_PASSED,
        { name: 'optional', state: 'FAILURE', link: WORKFLOW_URL, required: false },
      ],
    });
    expect(only(await runPass(fixture, { clockStepMs: 1000 })).status).toBe('pending');
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('reports conflicts without established coding findings or auto-merge', async () => {
    const fixture = await createFixture({
      pulls: [{ ...ONE_PULL_REQUEST, mergeable: 'CONFLICTING' }],
    });
    expect(only(await runPass(fixture)).status).toBe('observed');
    expect(transitions(fixture)).toHaveLength(0);
    expect((await fakeCompletionCalls(fixture.gh)).some((c) => c.op === 'merge')).toBe(false);
  });

  it('stops when the PR head moves during polling', async () => {
    const fixture = await createFixture();
    const result = only(
      await runPass(fixture, {
        clockStepMs: 1000,
        onSleep: async () => {
          await writeFile(
            fixture.gh.pullRequestsFile,
            JSON.stringify({ ...ONE_PULL_REQUEST, headRefOid: OTHER_HEAD }) + '\n',
          );
        },
      }),
    );
    expect(result.status).toBe('attention');
    // The failure names the pull request and both heads: this is the evidence
    // a person needs to see that the reviewed head is no longer GitHub's, and
    // nothing may tie a merge to the work it replaced.
    expect(result.detail).toContain(PR_URL);
    expect(result.detail).toContain(OTHER_HEAD);
    expect(result.detail).toContain(HEAD);
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it.each(['base', 'head', 'missing-merge', 'wrong-sha'])(
    'does not resolve mismatched merge evidence: %s',
    async (dimension) => {
      const fixture = await createFixture({ merged: true });
      if (dimension === 'wrong-sha')
        await writeFile(
          fixture.gh.runsFile,
          JSON.stringify(workflowRun({ headSha: OTHER_HEAD })) + '\n',
        );
      else
        await writeFile(
          fixture.gh.pullRequestsFile,
          JSON.stringify(
            mergedPullRequest(
              dimension === 'base'
                ? { baseRefName: 'release' }
                : dimension === 'head'
                  ? { headRefOid: OTHER_HEAD }
                  : { mergeCommit: null },
            ),
          ) + '\n',
        );
      await runPass(fixture, { clockStepMs: 20000 });
      expect(fixture.jira.status).toBe('In Review');
      expect(transitions(fixture)).toHaveLength(0);
      expect(commentTexts(fixture).some((c) => c.includes('nexus-completion:resolution'))).toBe(
        false,
      );
    },
  );

  it.each(['queued', 'in_progress'])(
    'waits for a post-merge workflow %s without fabricating failure',
    async (status) => {
      const fixture = await createFixture({
        merged: true,
        runs: [workflowRun({ status, conclusion: null })],
      });
      expect(only(await runPass(fixture, { clockStepMs: 1000 })).status).toBe('pending');
      expect(commentTexts(fixture)).toHaveLength(0);
      expect(transitions(fixture)).toHaveLength(0);
    },
  );

  it('selects the latest attempt of the same run ID', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [
        workflowRun({ runAttempt: 2, conclusion: 'failure' }),
        workflowRun({ runAttempt: 1, conclusion: 'success' }),
      ],
    });
    expect(only(await runPass(fixture)).status).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('FAILURE');
  });

  it('names every unsuccessful configured workflow in one concise comment', async () => {
    const fixture = await createFixture({
      merged: true,
      config: { postMergeWorkflows: ['ci.yml', 'release.yml'] },
      runs: [
        workflowRun({ conclusion: 'failure' }),
        workflowRun({
          databaseId: 4243,
          workflowId: 18,
          path: '.github/workflows/release.yml',
          conclusion: 'cancelled',
        }),
      ],
    });
    expect(only(await runPass(fixture)).status).toBe('to-do');
    const comments = commentTexts(fixture);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('ci.yml');
    expect(comments[0]).toContain('release.yml');
    expect(comments[0]).toContain('CANCELLED');
    expect(comments[0]?.split(/\s+/).length).toBeLessThan(120);
  });

  it('requires workflow health again even when an old resolution comment exists', async () => {
    const fixture = await createFixture({ merged: true });
    fixture.jira.transitionFailure = true;
    await runPass(fixture);
    fixture.jira.transitionFailure = false;
    await writeFile(
      fixture.gh.runsFile,
      JSON.stringify(workflowRun({ runAttempt: 2, status: 'queued', conclusion: null })) + '\n',
    );
    const before = transitions(fixture).length;
    expect(only(await runPass(fixture, { clockStepMs: 1000 })).status).toBe('pending');
    expect(transitions(fixture)).toHaveLength(before);
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(1);
  });

  it('does not backfill a historical merged PR without an admission', async () => {
    const fixture = await createFixture({ pulls: [mergedPullRequest()] });
    expect(only(await runPass(fixture)).status).toBe('observed');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('respects a human reopening the same resolved merge', async () => {
    const fixture = await createFixture({ merged: true });
    expect(only(await runPass(fixture)).status).toBe('done');
    fixture.jira.status = 'In Review';
    expect(only(await runPass(fixture)).status).toBe('observed');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
  });

  it('can resolve a reopened ticket only for a later different merged result', async () => {
    const fixture = await createFixture({ merged: true });
    await runPass(fixture);
    fixture.jira.status = 'In Review';
    await writeFile(
      fixture.gh.pullRequestsFile,
      JSON.stringify(mergedPullRequest({ mergeCommit: { oid: 'd'.repeat(40) } })) + '\n',
    );
    await writeFile(
      fixture.gh.runsFile,
      JSON.stringify(workflowRun({ headSha: 'd'.repeat(40) })) + '\n',
    );
    expect(only(await runPass(fixture)).status).toBe('done');
    expect(commentTexts(fixture)).toHaveLength(2);
  });

  it('recovers a comment accepted by Jira whose response was lost', async () => {
    const fixture = await createFixture({ merged: true });
    const original = fixture.jira.fetch;
    fixture.jira.transitionFailure = true;
    fixture.jira.fetch = (async (input, init) => {
      const result = await original(input, init);
      return init?.method === 'POST' && String(input).endsWith('/comment')
        ? new Response('{}', { status: 200 })
        : result;
    }) as typeof fetch;
    expect(only(await runPass(fixture)).status).toBe('attention');
    fixture.jira.fetch = original;
    fixture.jira.transitionFailure = false;
    expect(only(await runPass(fixture)).status).toBe('done');
    expect(commentTexts(fixture)).toHaveLength(1);
  });

  it('does not repeat a transition that Jira accepted with a lost response', async () => {
    const fixture = await createFixture({ merged: true });
    const original = fixture.jira.fetch;
    fixture.jira.fetch = (async (input, init) => {
      const result = await original(input, init);
      return init?.method === 'POST' && String(input).endsWith('/transitions')
        ? new Response('{}', { status: 503 })
        : result;
    }) as typeof fetch;
    await runPass(fixture);
    fixture.jira.fetch = original;
    await runPass(fixture);
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
  });

  it.each(['comment', 'transition'])('respects a human status change before %s', async (stage) => {
    const fixture = await createFixture({ merged: true });
    const original = fixture.jira.fetch;
    fixture.jira.fetch = (async (input, init) => {
      const result = await original(input, init);
      if (
        (stage === 'comment' && String(input).includes('/comment?')) ||
        (stage === 'transition' && init?.method === 'POST' && String(input).endsWith('/comment'))
      )
        fixture.jira.status = 'In Progress';
      return result;
    }) as typeof fetch;
    await runPass(fixture);
    expect(fixture.jira.status).toBe('In Progress');
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(stage === 'comment' ? 0 : 1);
  });

  it('includes actionable inline Lens findings in the repair comment', async () => {
    const fixture = await createFixture({
      reviews: [
        {
          ...APPROVED_REVIEW,
          state: 'CHANGES_REQUESTED',
          body: 'See inline findings.',
          inlineComments: [
            {
              path: 'src/ownership.ts',
              body: 'Reverse the ownership comparison before releasing the lock.',
            },
          ],
        },
      ],
    });
    expect(only(await runPass(fixture)).status).toBe('to-do');
    expect(commentTexts(fixture)[0]).toContain('Reverse the ownership comparison');
  });

  it('does not treat a completed workflow without a conclusion as failure', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun({ conclusion: null })],
    });
    expect(only(await runPass(fixture, { clockStepMs: 1000 })).status).toBe('pending');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('never duplicates a comment when Jira returns an incomplete comment listing', async () => {
    const fixture = await createFixture({ merged: true });
    const original = fixture.jira.fetch;
    fixture.jira.fetch = (async (input, init) =>
      String(input).includes('/comment?')
        ? new Response(JSON.stringify({ comments: [], total: 1000 }), { status: 200 })
        : original(input, init)) as typeof fetch;
    await runPass(fixture);
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('runs only GitHub commands: no coding runtime is installed or started', async () => {
    const fixture = await createFixture({ merged: true });

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('done');
    const calls = await fakeCompletionCalls(fixture.gh);
    // Every command the completion path ran was the stand-in `gh`, which records
    // only the `gh` invocations it speaks; nothing here started a runtime.
    expect(calls.every((call) => ['pr', 'api'].includes(call.argv[0] ?? ''))).toBe(true);
    expect(calls.some((call) => call.op === 'merge')).toBe(false);
  });
});
