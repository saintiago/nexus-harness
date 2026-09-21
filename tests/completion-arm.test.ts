/**
 * Arming native auto-merge, and reconciling what GitHub did with it.
 *
 * The arm step runs before the queue publishes the final required check, and the pass that follows settles every terminal state with one fresh reading of GitHub: an admitted merge finishes post-merge verification, an open pull request stays in the bounded poll loop, and a closed, moved or unapproved result is an explicit failure with its evidence.
 */

import { describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { completionLogsDir } from '../src/sources/completion.js';
import {
  APPROVED_REVIEW,
  HEAD,
  ISSUE_ID,
  LENS_CHECK_PASSED,
  LENS_CHECK_URL,
  MERGE_COMMIT,
  ONE_PULL_REQUEST,
  OTHER_HEAD,
  PR_URL,
  REPOSITORY,
  REVIEW_URL,
  SITE,
  SOURCE,
  THIRD_HEAD,
  WORKSPACE_POINTER,
  WORKFLOW_URL,
  commentTexts,
  createFixture,
  mergedPullRequest,
  only,
  onlyArm,
  passFor,
  runPass,
  transitions,
  workflowRun,
} from './fixtures/completion.js';
import { fakeCompletionCalls } from './fixtures/local-target.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';

useFixtureLifecycle();

/**
 * The race the queue's arm step closes: a delivered pull request can become
 * clean — every required check green — before the completion phase runs. The
 * stand-in GitHub refuses to arm such a pull request exactly as production does,
 * so these tests can tell an early arm from one attempted at completion time.
 */
describe('arming native auto-merge before the final gate', () => {
  it.each(['site', 'repository'])(
    'keeps concurrent completion admissions separate across %s identities and restarts',
    async (difference) => {
      const first = await createFixture();
      const source =
        difference === 'site' ? { ...SOURCE, siteUrl: 'https://other.atlassian.net' } : SOURCE;
      const repository = difference === 'repository' ? 'owner/other' : REPOSITORY;
      const second = {
        ...(await createFixture({
          pulls: [{ ...ONE_PULL_REQUEST, repo: repository, headRefOid: OTHER_HEAD }],
        })),
        workDir: first.workDir,
        logsDir: completionLogsDir(
          first.workDir,
          { type: source.type, scope: source.siteUrl, id: ISSUE_ID },
          repository,
        ),
      };
      expect(second.logsDir).not.toBe(first.logsDir);
      expect(
        completionLogsDir(
          first.workDir,
          { type: SOURCE.type, scope: SITE, id: ISSUE_ID },
          REPOSITORY.toUpperCase(),
        ),
      ).toBe(first.logsDir);
      const results = await Promise.all([
        passFor(first).arm(AbortSignal.timeout(30_000)),
        passFor(second, { source, repository }).arm(AbortSignal.timeout(30_000)),
      ]);
      for (const result of results) expect(onlyArm(result).status).toBe('armed');
      const firstFile = path.join(first.logsDir, 'completion-armed-head.json');
      const secondFile = path.join(second.logsDir, 'completion-armed-head.json');
      const firstRecord = await readFile(firstFile, 'utf8');
      const secondRecord = await readFile(secondFile, 'utf8');
      expect(JSON.parse(firstRecord)).toMatchObject({ head: HEAD, number: 29 });
      expect(JSON.parse(secondRecord)).toMatchObject({ head: OTHER_HEAD, number: 29 });
      // Restart both consumers: each finds its own admission and verifies the
      // existing arm without rewriting it or repeating the remote mutation.
      const restarted = await Promise.all([
        passFor(first).arm(AbortSignal.timeout(30_000)),
        passFor(second, { source, repository }).arm(AbortSignal.timeout(30_000)),
      ]);
      for (const result of restarted) expect(onlyArm(result).status).toBe('armed');
      expect(await readFile(firstFile, 'utf8')).toBe(firstRecord);
      expect(await readFile(secondFile, 'utf8')).toBe(secondRecord);
      for (const fixture of [first, second]) {
        expect(
          (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
        ).toHaveLength(1);
      }
    },
  );

  it.each(['arm', 'run'] as const)(
    'refuses unidentified legacy completion evidence before %s',
    async (phase) => {
      const fixture = await createFixture({ evidenceDir: false });
      const legacy = path.join(fixture.workDir, 'completion-logs', ISSUE_ID);
      await mkdir(legacy, { recursive: true });
      const file = path.join(legacy, 'completion-armed-head.json');
      const contents = JSON.stringify({
        head: OTHER_HEAD,
        number: 29,
        waitingSince: '2020-01-01T00:00:00.000Z',
      });
      await writeFile(file, contents);
      const outcomes = await passFor(fixture)[phase](AbortSignal.timeout(30_000));
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.status).toBe('attention');
      expect(outcomes[0]?.detail).toContain(legacy);
      expect(outcomes[0]?.detail).toContain('records no source or repository identity');
      expect(await readFile(file, 'utf8')).toBe(contents);
      expect(await fakeCompletionCalls(fixture.gh)).toEqual([]);
      expect(transitions(fixture)).toEqual([]);
      expect(commentTexts(fixture)).toEqual([]);
    },
  );

  it.each([
    ['merge-uncertain', false],
    ['merge-uncertain', true],
    ['view-after-arm', false],
  ])('recovers a native merge after %s (repair: %s)', async (fail, repair) => {
    const fixture = await createFixture({ runs: [] });
    const head = repair ? OTHER_HEAD : HEAD;
    if (repair) {
      expect(onlyArm(await passFor(fixture).arm(AbortSignal.timeout(30_000))).status).toBe('armed');
      await writeFile(
        fixture.gh.pullRequestsFile,
        `${JSON.stringify({ ...ONE_PULL_REQUEST, headRefOid: head, autoMergeRequest: null })}\n`,
      );
      await writeFile(
        fixture.gh.reviewsFile,
        JSON.stringify([{ ...APPROVED_REVIEW, commitId: head }]),
      );
      await writeFile(
        fixture.gh.checksFile,
        JSON.stringify([{ ...LENS_CHECK_PASSED, headSha: head }]),
      );
    }

    const failed = onlyArm(
      await passFor(fixture, { fail, mergeOnArm: MERGE_COMMIT }).arm(AbortSignal.timeout(30_000)),
    );
    if (fail === 'merge-uncertain') {
      // The response was lost, but GitHub did merge: the fresh reconciliation
      // read settles the reviewed head as merged, so the arm step reports the
      // merge instead of asking for a person, and nothing is requested again.
      expect(failed.status, failed.detail).toBe('observed');
      expect(failed.detail).toContain('merged');
    } else {
      expect(failed.status, failed.detail).toBe('attention');
    }
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
    expect(
      JSON.parse(await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8')),
    ).toMatchObject({ head, number: 29, waitingSince: null });

    // GitHub accepted the request and merged, but neither a lost mutation
    // response nor a failed verification read acknowledged the arm locally.
    // A fresh pass must recover by number and still wait for post-merge CI.
    expect(onlyArm(await passFor(fixture).arm(AbortSignal.timeout(30_000))).status).toBe(
      'observed',
    );
    const pending = only(await runPass(fixture, { clockStepMs: 1_000 }));
    expect(pending.status, pending.detail).toBe('pending');
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
    await writeFile(fixture.gh.runsFile, `${JSON.stringify(workflowRun())}\n`);
    const done = only(await runPass(fixture, { clockStepMs: 1_000 }));
    expect(done.status, done.detail).toBe('done');
    expect(done.mergeCommit).toBe(MERGE_COMMIT);
    await runPass(fixture);
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect((await fakeCompletionCalls(fixture.gh)).filter((c) => c.op === 'merge')).toHaveLength(
      repair ? 2 : 1,
    );
  });

  it('does not request auto-merge when its admission cannot be persisted', async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.logsDir, 'completion-armed-head.json'));
    const outcome = onlyArm(await passFor(fixture).arm(AbortSignal.timeout(30_000)));
    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('record could not be written');
    expect((await fakeCompletionCalls(fixture.gh)).filter((c) => c.op === 'merge')).toHaveLength(0);
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('retries a transient read before arming instead of stopping the queue for a person', async () => {
    const fixture = await createFixture();
    // The first read of the delivered pull request is unavailable once: the arm
    // step reads it again inside its own deadline, arms exactly once, and
    // reports no person.
    await writeFile(
      path.join(fixture.gh.dir, 'fail-once.json'),
      JSON.stringify({ op: 'list', status: 503, message: 'Server Error' }),
      'utf8',
    );
    const sleepCalls = { count: 0 };

    const armed = onlyArm(
      await passFor(fixture, { clockStepMs: 1_000, sleepCalls }).arm(AbortSignal.timeout(30_000)),
    );

    expect(armed.status, armed.detail).toBe('armed');
    expect(armed.head).toBe(HEAD);
    expect(sleepCalls.count).toBeGreaterThan(0);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
  });

  it('arms while the final required check is pending, then the green gate uses that arm', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      // CI is already green; the reviewer has not published the Lens check, so
      // the pull request is not yet clean and GitHub can accept the arm.
      checks: [{ name: 'validate', state: 'SUCCESS', link: WORKFLOW_URL }],
      reviews: [],
      runs: [],
    });
    const options = {
      rejectArmWhenClean: true,
      requiredChecks: ['validate', 'Nexus Lens'],
      clockStepMs: 1_000,
    };

    const armed = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(armed.status, armed.detail).toBe('armed');
    expect(armed.head).toBe(HEAD);
    expect(armed.number).toBe(29);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
    const record = JSON.parse(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { head?: string; number?: number; waitingSince?: string | null };
    // Arming is not yet waiting for the merge: the reviewer has not run, and
    // the merge deadline must not start until completion sees a pending merge.
    expect(record).toMatchObject({ head: HEAD, number: 29, waitingSince: null });

    // The review phase now publishes the final required check. The old
    // completion ordering would arm here and be refused with "clean status";
    // this pass verifies the recorded arm instead.
    await writeFile(fixture.gh.reviewsFile, `${JSON.stringify([APPROVED_REVIEW])}\n`, 'utf8');
    await writeFile(
      fixture.gh.checksFile,
      `${JSON.stringify([
        { name: 'validate', state: 'SUCCESS', link: WORKFLOW_URL },
        LENS_CHECK_PASSED,
      ])}\n`,
      'utf8',
    );

    const pending = only(await passFor(fixture, options).run(AbortSignal.timeout(30_000)));
    expect(pending.status, pending.detail).toBe('pending');
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
    const waited = JSON.parse(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { waitingSince?: string | null };
    expect(typeof waited.waitingSince).toBe('string');

    // GitHub merges natively. A restarted pass verifies that merge and its
    // post-merge workflow and writes the one resolution comment exactly once.
    await writeFile(
      fixture.gh.pullRequestsFile,
      `${JSON.stringify(mergedPullRequest())}\n`,
      'utf8',
    );
    await writeFile(fixture.gh.runsFile, `${JSON.stringify(workflowRun())}\n`, 'utf8');
    const done = only(await passFor(fixture, options).run(AbortSignal.timeout(30_000)));
    expect(done.status, done.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);

    const restarted = only(await passFor(fixture, options).run(AbortSignal.timeout(30_000)));
    expect(restarted.status).toBe('observed');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
  });

  it("re-arms and re-records a repair's new head, without a duplicate on restart", async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      checks: [{ name: 'validate', state: 'PENDING', link: WORKFLOW_URL }],
      reviews: [],
      runs: [],
    });
    const options = {
      rejectArmWhenClean: true,
      requiredChecks: ['validate', 'Nexus Lens'],
      clockStepMs: 1_000,
    };

    const first = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(first).toMatchObject({ status: 'armed', head: HEAD, number: 29 });

    // The repair pushed a new head and GitHub no longer holds the old arm.
    await writeFile(
      fixture.gh.pullRequestsFile,
      `${JSON.stringify({ ...ONE_PULL_REQUEST, headRefOid: OTHER_HEAD, autoMergeRequest: null })}\n`,
      'utf8',
    );

    const repaired = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(repaired).toMatchObject({ status: 'armed', head: OTHER_HEAD, number: 29 });
    const record = JSON.parse(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { head?: string; number?: number };
    expect(record).toMatchObject({ head: OTHER_HEAD, number: 29 });
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(2);

    // A restart against the armed repaired head is a verified no-op.
    const restarted = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(restarted).toMatchObject({ status: 'armed', head: OTHER_HEAD, number: 29 });
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(2);

    // GitHub can keep the request enabled across another head. The new head is
    // verified and re-recorded without a second mutation.
    await writeFile(
      fixture.gh.pullRequestsFile,
      `${JSON.stringify({
        ...ONE_PULL_REQUEST,
        headRefOid: THIRD_HEAD,
        autoMergeRequest: { enabledAt: '2026-09-20T12:05:00Z' },
      })}\n`,
      'utf8',
    );
    const carried = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(carried).toMatchObject({ status: 'armed', head: THIRD_HEAD, number: 29 });
    const carriedRecord = JSON.parse(
      await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8'),
    ) as { head?: string; number?: number };
    expect(carriedRecord).toMatchObject({ head: THIRD_HEAD, number: 29 });
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(2);
  });

  it('keeps a clean pull request In Review with actionable evidence instead of assuming a merge', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      reviews: [APPROVED_REVIEW],
      checks: [{ name: 'validate', state: 'SUCCESS', link: WORKFLOW_URL }, LENS_CHECK_PASSED],
      runs: [],
    });

    const outcome = only(
      await runPass(fixture, {
        rejectArmWhenClean: true,
        requiredChecks: ['validate', 'Nexus Lens'],
        clockStepMs: 1_000,
      }),
    );

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('clean status');
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('clean status');
    expect(commentTexts(fixture)[0]).toContain(PR_URL);
    // The one attempted request was refused; nothing was merged.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
    expect(await readFile(fixture.gh.pullRequestsFile, 'utf8')).toContain('"state":"OPEN"');
  });

  it('returns an armed repair to To Do when the current-head Lens result requests changes', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      reviews: [
        { ...APPROVED_REVIEW, state: 'CHANGES_REQUESTED', body: 'Fix the ownership race.' },
      ],
      checks: [
        {
          name: 'Nexus Lens',
          state: 'FAILURE',
          conclusion: 'FAILURE',
          link: LENS_CHECK_URL,
          reviewUrl: REVIEW_URL,
        },
      ],
      runs: [],
    });
    const options = {
      rejectArmWhenClean: true,
      requiredChecks: ['validate', 'Nexus Lens'],
      clockStepMs: 1_000,
    };

    // The queue's arm step runs before the review publishes the failing check.
    const armed = onlyArm(await passFor(fixture, options).arm(AbortSignal.timeout(30_000)));
    expect(armed).toMatchObject({ status: 'armed', head: HEAD, number: 29 });

    // The completion pass reads the armed record, sees the failed Lens verdict,
    // and returns the ticket to To Do with its workspace pointer untouched.
    const outcome = only(await passFor(fixture, options).run(AbortSignal.timeout(30_000)));
    expect(outcome.status, outcome.detail).toBe('to-do');
    expect(fixture.jira.status).toBe('To Do');
    expect(fixture.jira.labels).toContain(WORKSPACE_POINTER);
    expect(transitions(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('ownership race');
    // The failed required check is what stops the native merge; the harness
    // never performs the merge itself.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
  });
});

/**
 * The race HARN-34 exposed: GitHub's auto-merge lands the reviewed head between
 * two reads of the same pull request. Every answer here is settled by one fresh
 * reading of GitHub's own state — a merge of the exact reviewed head continues
 * through post-merge verification, an open pull request stays in the bounded
 * poll loop, and a closed, moved or unapproved result is an explicit terminal
 * failure with its evidence. Nothing assumes success.
 */
describe('reconciling terminal states across an auto-merge race', () => {
  it('finishes an already-merged admission without arming or asking for a person', async () => {
    const fixture = await createFixture({ merged: true, runs: [] });

    // The merge is a fact and its post-merge workflow has not appeared yet: the
    // item waits in the bounded poll loop, and nothing is re-armed.
    const waiting = only(await runPass(fixture, { clockStepMs: 1_000 }));
    expect(waiting.status, waiting.detail).toBe('pending');
    // The merge commit GitHub reported is recorded with the wait, so a later
    // pass and the resolution name the same merged result.
    expect(waiting.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(0);

    await writeFile(fixture.gh.runsFile, `${JSON.stringify(workflowRun())}\n`, 'utf8');
    const done = only(await runPass(fixture, { clockStepMs: 1_000 }));

    expect(done.status, done.detail).toBe('done');
    expect(done.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain(MERGE_COMMIT);
    expect(transitions(fixture)).toHaveLength(1);
    // The reviewed head was merged by GitHub before the pass ran: no arm is
    // requested and no person is needed.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(0);
  });

  it('reconciles an unprocessable arm refusal when GitHub merged the reviewed head', async () => {
    const fixture = await createFixture({ pulls: [ONE_PULL_REQUEST], runs: [workflowRun()] });

    // GitHub merges the reviewed head while the auto-merge request is in
    // flight: the request comes back unprocessable, and one fresh read is what
    // says the merge it was asking for has already happened.
    const outcome = only(
      await runPass(fixture, { clockStepMs: 1_000, mergeBeforeArm: MERGE_COMMIT }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(outcome.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    // The one request was refused and nothing was re-sent; the merge, not the
    // refusal, is what the item was completed on.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
    expect(await readFile(fixture.gh.pullRequestsFile, 'utf8')).toContain('"state":"MERGED"');
  });

  it('retries a transient read that reconciles a successful auto-merge response', async () => {
    const fixture = await createFixture({ pulls: [ONE_PULL_REQUEST], runs: [workflowRun()] });
    // GitHub accepts the request and merges the reviewed head, but the one
    // reading that would verify the arm is the first read after the request:
    // a 5xx there is an answer GitHub could not give, not a lost arm.
    await writeFile(
      path.join(fixture.gh.dir, 'fail-once.json'),
      JSON.stringify({ op: 'view', afterMerge: true, status: 503, message: 'Server Error' }),
      'utf8',
    );
    const sleepCalls = { count: 0 };

    const outcome = only(
      await runPass(fixture, { clockStepMs: 1_000, sleepCalls, mergeOnArm: MERGE_COMMIT }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(outcome.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:resolution:');
    expect(commentTexts(fixture)[0]).toContain(MERGE_COMMIT);
    expect(transitions(fixture)).toHaveLength(1);
    expect(sleepCalls.count).toBeGreaterThan(0);
    // The request was made once; the merge it produced is what completed the
    // item, and neither a person nor a second request was needed.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
  });

  it('retries a transient read that reconciles an unprocessable auto-merge response', async () => {
    const fixture = await createFixture({ pulls: [ONE_PULL_REQUEST], runs: [workflowRun()] });
    // The request is refused as unprocessable because GitHub merged the
    // reviewed head in its window, and the reconciliation read that settles
    // that is itself unavailable once: it is retried, and the merge is what
    // decides the item.
    await writeFile(
      path.join(fixture.gh.dir, 'fail-once.json'),
      JSON.stringify({ op: 'view', afterMerge: true, status: 503, message: 'Server Error' }),
      'utf8',
    );
    const sleepCalls = { count: 0 };

    const outcome = only(
      await runPass(fixture, { clockStepMs: 1_000, sleepCalls, mergeBeforeArm: MERGE_COMMIT }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(outcome.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:resolution:');
    expect(commentTexts(fixture)[0]).toContain(MERGE_COMMIT);
    expect(transitions(fixture)).toHaveLength(1);
    expect(sleepCalls.count).toBeGreaterThan(0);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
  });

  it('follows a merge that lands between the merge read and the gate read (HARN-34)', async () => {
    const fixture = await createFixture({ pulls: [ONE_PULL_REQUEST], runs: [workflowRun()] });
    // The queue's arm step ran before the review: GitHub holds the native
    // request and the completion pass recorded the admission it verifies.
    await writeFile(
      fixture.gh.pullRequestsFile,
      `${JSON.stringify({
        ...ONE_PULL_REQUEST,
        autoMergeRequest: { enabledAt: '2026-09-20T20:12:40Z' },
      })}\n`,
      'utf8',
    );
    await writeFile(
      path.join(fixture.logsDir, 'completion-armed-head.json'),
      JSON.stringify({ head: HEAD, number: 29, waitingSince: null }),
    );

    // The second `pr view` — the gate read that follows the merge read that
    // still answered "open" — is where GitHub performs the merge, the way it
    // did in the incident two seconds after the approval landed.
    const outcome = only(
      await runPass(fixture, {
        clockStepMs: 1_000,
        mergeOnView: 2,
        mergeOnViewSha: MERGE_COMMIT,
      }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(outcome.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain(MERGE_COMMIT);
    expect(transitions(fixture)).toHaveLength(1);
    // The arm was already GitHub's and the merge already happened: no request
    // is sent, and no person is needed.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(0);
  });

  it('continues when GitHub merges the head before the arm is verified', async () => {
    const fixture = await createFixture({ pulls: [ONE_PULL_REQUEST], runs: [workflowRun()] });

    // GitHub accepts the request and merges the head before the pass reads the
    // pull request back to verify the arm: the third `pr view` — the
    // verification read after the request — is the merge.
    const outcome = only(
      await runPass(fixture, {
        clockStepMs: 1_000,
        mergeOnView: 3,
        mergeOnViewSha: MERGE_COMMIT,
      }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(outcome.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    // One request was made, and the merge it produced is what completed the
    // item: nothing was requested a second time.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
  });

  it('retries a transient GitHub failure within the deadline instead of stopping for a person', async () => {
    const fixture = await createFixture({ merged: true, runs: [workflowRun()] });
    // One 5xx: an answer GitHub could not give this moment, not a refusal.
    await writeFile(
      path.join(fixture.gh.dir, 'fail-once.json'),
      JSON.stringify({ op: 'runs', status: 503, message: 'Server Error' }),
      'utf8',
    );
    const sleepCalls = { count: 0 };

    const outcome = only(await runPass(fixture, { clockStepMs: 1_000, sleepCalls }));

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect(sleepCalls.count).toBeGreaterThan(0);
  });

  it('retries a transient failure of the required-check read instead of aborting the item', async () => {
    const fixture = await createFixture({
      pulls: [ONE_PULL_REQUEST],
      checks: [{ name: 'validate', state: 'SUCCESS', link: WORKFLOW_URL }, LENS_CHECK_PASSED],
      runs: [workflowRun()],
    });
    // `gh pr checks` reports a failed check through its exit code, so a 5xx
    // that wrote no check result at all has to be classified from the answer,
    // not from the exit code: one such answer is read again, not parsed.
    await writeFile(
      path.join(fixture.gh.dir, 'fail-once.json'),
      JSON.stringify({ op: 'checks', status: 503, message: 'Server Error' }),
      'utf8',
    );
    const sleepCalls = { count: 0 };

    const outcome = only(
      await runPass(fixture, { clockStepMs: 1_000, sleepCalls, mergeOnArm: MERGE_COMMIT }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect(sleepCalls.count).toBeGreaterThan(0);
    // The unreadable answer was retried exactly once and no coding finding,
    // person, or merge was invented from it.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'checks'),
    ).toHaveLength(2);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(1);
  });

  it('stops a transient GitHub failure at the deadline instead of retrying forever', async () => {
    const fixture = await createFixture({ merged: true, runs: [workflowRun()] });
    const marker = path.join(fixture.gh.dir, 'fail-once.json');
    const seed = async (): Promise<void> => {
      await writeFile(
        marker,
        JSON.stringify({ op: 'runs', status: 503, message: 'Server Error' }),
        'utf8',
      );
    };
    await seed();
    const sleepCalls = { count: 0 };

    // The merge identity is recorded before the first reading, so the fake
    // clock advances once more than it did before that record existed; the poll
    // step is what keeps this pass inside its own deadline while it retries.
    const outcome = only(await runPass(fixture, { clockStepMs: 5_000, sleepCalls, onSleep: seed }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('503');
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(sleepCalls.count).toBeGreaterThanOrEqual(1);
  });

  it('retries a read the harness stopped at its command limit without any answer', async () => {
    const fixture = await createFixture({ merged: true, runs: [workflowRun()] });
    // A stalled read: it never answers and writes nothing on either stream, so
    // the harness's own command limit is what ends it. The recorded outcome —
    // not the empty log — is what says GitHub's answer is still outstanding, so
    // the reading is repeated inside the item deadline instead of stopping the
    // item for a person while the merge and its workflow are verifiable.
    await writeFile(
      path.join(fixture.gh.dir, 'fail-once.json'),
      JSON.stringify({ op: 'runs', hang: true }),
      'utf8',
    );
    const sleepCalls = { count: 0 };

    const outcome = only(
      await runPass(fixture, { clockStepMs: 1_000, sleepCalls, commandTimeoutMs: 1_000 }),
    );

    expect(outcome.status, outcome.detail).toBe('done');
    expect(outcome.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('Done');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect(sleepCalls.count).toBeGreaterThan(0);
    // The stalled read was answered on the retry — the two reads that follow it
    // are the two write guards' own — and no coding finding, person, or merge
    // was invented from the answer that never came.
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'runs'),
    ).toHaveLength(4);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(0);
  });

  it('keeps an open pull request with unknown mergeability in the bounded poll loop', async () => {
    const fixture = await createFixture({
      pulls: [{ ...ONE_PULL_REQUEST, mergeable: 'UNKNOWN' }],
      runs: [workflowRun()],
    });
    const sleepCalls = { count: 0 };

    const outcome = only(await runPass(fixture, { clockStepMs: 20_000, sleepCalls }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('mergeability is pending');
    expect(sleepCalls.count).toBeGreaterThan(0);
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(0);
  });

  it('reports an admitted pull request closed without a merge as a terminal failure', async () => {
    const fixture = await createFixture({ pulls: [{ ...ONE_PULL_REQUEST, state: 'CLOSED' }] });
    await writeFile(
      path.join(fixture.logsDir, 'completion-armed-head.json'),
      JSON.stringify({ head: HEAD, number: 29, waitingSince: null }),
    );

    const outcome = only(await runPass(fixture));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain(PR_URL);
    expect(outcome.detail).toContain(HEAD);
    expect(outcome.detail).toContain('closed without a verified merge');
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(0);
    expect((await fakeCompletionCalls(fixture.gh)).some((call) => call.op === 'merge')).toBe(false);
  });

  it('reports a pull request closed while the merge is awaited as a terminal failure', async () => {
    const fixture = await createFixture({ pulls: [ONE_PULL_REQUEST], runs: [] });

    const outcome = only(
      await runPass(fixture, {
        clockStepMs: 1_000,
        onSleep: async () => {
          await writeFile(
            fixture.gh.pullRequestsFile,
            `${JSON.stringify({ ...ONE_PULL_REQUEST, state: 'CLOSED' })}\n`,
            'utf8',
          );
        },
      }),
    );

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain(PR_URL);
    expect(outcome.detail).toContain(HEAD);
    expect(outcome.detail).toContain('closed without a merge');
    expect(fixture.jira.status).toBe('In Review');
    expect(transitions(fixture)).toHaveLength(0);
    expect(commentTexts(fixture)).toHaveLength(0);
  });

  it.each([
    ['no review at all', []],
    ['a review approving another head', [{ ...APPROVED_REVIEW, commitId: OTHER_HEAD }]],
  ])(
    'reports a merge the reviewer did not approve (%s) as a terminal failure',
    async (_case, reviews) => {
      const fixture = await createFixture({ merged: true, reviews });

      const outcome = only(await runPass(fixture));

      expect(outcome.status, outcome.detail).toBe('attention');
      expect(outcome.detail).toContain(PR_URL);
      expect(outcome.detail).toContain(MERGE_COMMIT);
      expect(outcome.detail).toContain(HEAD);
      expect(outcome.mergeCommit).toBe(MERGE_COMMIT);
      expect(fixture.jira.status).toBe('In Review');
      expect(transitions(fixture)).toHaveLength(0);
      expect(commentTexts(fixture)).toHaveLength(0);
    },
  );

  it('resumes post-merge verification after a restart without repeating any write', async () => {
    const fixture = await createFixture({ merged: true, runs: [] });

    const first = only(await runPass(fixture, { clockStepMs: 1_000 }));
    expect(first.status, first.detail).toBe('pending');

    // The restart reads the retained admission and the same merged head, waits
    // for the post-merge workflow, and writes the one resolution exactly once.
    await writeFile(fixture.gh.runsFile, `${JSON.stringify(workflowRun())}\n`, 'utf8');
    const second = only(await runPass(fixture, { clockStepMs: 1_000 }));
    expect(second.status, second.detail).toBe('done');

    const third = await runPass(fixture);
    expect(only(third).status).toBe('observed');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(transitions(fixture)).toHaveLength(1);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(0);
    expect(
      JSON.parse(await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8')),
    ).toMatchObject({ head: HEAD, number: 29 });
  });

  it('records a merge it discovers before arming so a restart finishes the failed move', async () => {
    const fixture = await createFixture({ pulls: [ONE_PULL_REQUEST], runs: [workflowRun()] });
    fixture.jira.transitionFailure = true;

    // No admission exists yet: the pass reads an open pull request, and GitHub
    // merges the reviewed head while the gate's own read is taken. Nothing was
    // ever armed, so the merge this pass discovers is the only identity a later
    // pass can resume from once the pull request has left the open list.
    const first = only(await runPass(fixture, { clockStepMs: 1_000, mergeOnView: 1 }));

    expect(first.status, first.detail).toBe('attention');
    expect(first.detail).toContain('moving it to "Done" failed');
    expect(first.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('In Review');
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:resolution:');
    // The reconciled identity was retained before the comment was published, so
    // the restart can find the merge GitHub no longer lists as open.
    expect(
      JSON.parse(await readFile(path.join(fixture.logsDir, 'completion-armed-head.json'), 'utf8')),
    ).toMatchObject({ head: HEAD, number: 29 });

    fixture.jira.transitionFailure = false;
    const second = only(await runPass(fixture, { clockStepMs: 1_000 }));

    expect(second.status, second.detail).toBe('done');
    expect(second.mergeCommit).toBe(MERGE_COMMIT);
    expect(fixture.jira.status).toBe('Done');
    // One resolution comment and one successful move: the restart repeats no
    // review read as a mutation, writes no second comment, and arms nothing.
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(
      (await fakeCompletionCalls(fixture.gh)).filter((call) => call.op === 'merge'),
    ).toHaveLength(0);
  });

  it('does not mint a fresh deadline for the guard before the resolution comment', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun()],
      config: { deadlineSeconds: 20 },
    });
    // Almost the whole item budget is gone by the time the verify-before-write
    // reads run, and the third `pr reviews` read — the guard's own approval read
    // — is unavailable once. A pass that has spent its budget does not get a new
    // one: the read is not repeated, and nothing is written from a state it
    // could not re-verify.
    await writeFile(
      path.join(fixture.gh.dir, 'fail-once.json'),
      JSON.stringify({ op: 'reviews', occurrence: 3, status: 503, message: 'Server Error' }),
      'utf8',
    );
    const sleepCalls = { count: 0 };

    const outcome = only(await runPass(fixture, { clockStepMs: 15_000, sleepCalls }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('503');
    expect(sleepCalls.count).toBe(0);
    expect(commentTexts(fixture)).toHaveLength(0);
    expect(transitions(fixture)).toHaveLength(0);
  });

  it('does not mint a fresh deadline for the guard before the status move', async () => {
    const fixture = await createFixture({
      merged: true,
      runs: [workflowRun()],
      config: { deadlineSeconds: 20 },
    });
    // The same bound covers the second guard, which the status move takes: the
    // fourth `pr reviews` read — that guard's own approval read — is unavailable
    // once after the item budget is spent, so the move is not made and is left
    // to the next pass instead of being retried under a new full deadline.
    await writeFile(
      path.join(fixture.gh.dir, 'fail-once.json'),
      JSON.stringify({ op: 'reviews', occurrence: 4, status: 503, message: 'Server Error' }),
      'utf8',
    );
    const sleepCalls = { count: 0 };

    const outcome = only(await runPass(fixture, { clockStepMs: 15_000, sleepCalls }));

    expect(outcome.status, outcome.detail).toBe('attention');
    expect(outcome.detail).toContain('moving it to "Done" failed');
    expect(outcome.detail).toContain('503');
    expect(sleepCalls.count).toBe(0);
    expect(commentTexts(fixture)).toHaveLength(1);
    expect(commentTexts(fixture)[0]).toContain('nexus-completion:resolution:');
    expect(fixture.jira.status).toBe('In Review');
  });
});
