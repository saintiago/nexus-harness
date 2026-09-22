/**
 * The two pure readings the review-to-completion path decides on: whether one
 * pull request check is a definitive failure, and which of the configured
 * post-merge workflow runs is the latest attempt and what its conclusion means.
 *
 * Nothing here runs a command or reads a credential, so the whole state matrix —
 * pending, successful, failed, cancelled, timed out, action required, stale,
 * skipped, neutral — is exercised without a GitHub account.
 */

import { describe, expect, it } from 'vitest';
import {
  checkFailed,
  checkPassed,
  checkPending,
  workflowMatches,
  workflowOutcomes,
} from '../src/delivery/gate.js';
import type { CheckSnapshot, WorkflowRunSnapshot } from '../src/delivery/gate.js';

function check(overrides: Partial<CheckSnapshot> = {}): CheckSnapshot {
  return { name: 'Nexus Lens', state: 'SUCCESS', conclusion: 'SUCCESS', link: 'x', ...overrides };
}

function run(overrides: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    databaseId: 1,
    workflowId: 17,
    workflowName: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    headSha: 'a'.repeat(40),
    url: 'https://example.test/run/1',
    ...overrides,
  };
}

describe('one pull request check', () => {
  it('reads a queued check as pending, never as a failure', () => {
    expect(checkPending(check({ state: 'PENDING', conclusion: null }))).toBe(true);
    expect(checkFailed(check({ state: 'PENDING', conclusion: null }))).toBe(false);
    expect(checkPassed(check({ state: 'PENDING', conclusion: null }))).toBe(false);
  });

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'SKIPPED', 'NEUTRAL'])(
    'reads a completed %s as a definitive failure',
    (conclusion) => {
      expect(checkFailed(check({ conclusion }))).toBe(true);
      expect(checkPassed(check({ conclusion }))).toBe(false);
      expect(checkPending(check({ conclusion }))).toBe(false);
    },
  );

  it('reads a completed success as a pass', () => {
    expect(checkPassed(check())).toBe(true);
    expect(checkFailed(check())).toBe(false);
  });
});

describe('one workflow identifier', () => {
  it('matches a numeric workflow ID exactly', () => {
    expect(workflowMatches('17', run())).toBe(true);
    expect(workflowMatches('18', run())).toBe(false);
  });

  it('matches a file name or a path under .github/workflows', () => {
    expect(workflowMatches('ci.yml', run())).toBe(true);
    expect(workflowMatches('.github/workflows/ci.yml', run())).toBe(true);
    expect(workflowMatches('release.yml', run())).toBe(false);
  });

  it('matches a file name wherever the workflow file lives', () => {
    expect(workflowMatches('ci.yml', run({ path: '.github/workflows/nightly/ci.yml' }))).toBe(true);
    // A path names where it lives: another folder is another workflow.
    expect(
      workflowMatches(
        '.github/workflows/nightly/ci.yml',
        run({ path: '.github/workflows/ci.yml' }),
      ),
    ).toBe(false);
  });
});

describe('the configured workflows on one merge commit', () => {
  it('reports a workflow that has not appeared as pending, not failed', () => {
    const [outcome] = workflowOutcomes(['ci.yml'], []);
    expect(outcome?.state).toBe('pending');
    expect(outcome?.run).toBeNull();
  });

  it('reports a queued or running latest attempt as pending', () => {
    expect(
      workflowOutcomes(['ci.yml'], [run({ status: 'queued', conclusion: null })])[0]?.state,
    ).toBe('pending');
    expect(
      workflowOutcomes(['ci.yml'], [run({ status: 'in_progress', conclusion: null })])[0]?.state,
    ).toBe('running');
  });

  it('reads only the latest attempt of one workflow', () => {
    const outcomes = workflowOutcomes(
      ['ci.yml'],
      [
        run({ databaseId: 10, conclusion: 'failure' }),
        run({ databaseId: 11, conclusion: 'success' }),
      ],
    );
    expect(outcomes[0]?.state).toBe('success');
    expect(outcomes[0]?.run?.databaseId).toBe(11);
  });

  it('reports a latest failed attempt even when an earlier one succeeded', () => {
    const outcomes = workflowOutcomes(
      ['ci.yml'],
      [
        run({ databaseId: 10, conclusion: 'success' }),
        run({ databaseId: 11, status: 'completed', conclusion: 'cancelled' }),
      ],
    );
    expect(outcomes[0]?.state).toBe('unsuccessful');
    expect(outcomes[0]?.conclusion).toBe('CANCELLED');
  });

  it('requires every configured workflow', () => {
    const outcomes = workflowOutcomes(['ci.yml', 'release.yml'], [run()]);
    expect(outcomes.map((outcome) => outcome.state)).toEqual(['success', 'pending']);
  });
});
