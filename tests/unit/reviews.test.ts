/**
 * The review path's own decisions: what one reviewer verdict file may say, where
 * a finding can land in the pull request's diff, what the reviewer's prompt must
 * carry, and what one scan publishes — all decided over stand-in collaborators,
 * with no live GitHub, no reviewer process, and no repository clone.
 *
 * The scan's real GitHub client, App credentials and repository view stay the
 * boundary layer's; here they are ordinary functions a case scripts.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ChangedFile,
  OpenPullRequest,
  ReviewEvidence,
  ReviewerVerdict,
  ReviewRepository,
  ReviewScanContext,
  ReviewViewSource,
  ReviewWatchOptions,
} from '../../src/reviews/contract.js';
import type { HistoryReportSummary, HistorySnapshot } from '../../src/history/contract.js';
import { ReviewError } from '../../src/reviews/contract.js';
import { diffPosition, positionFindings } from '../../src/reviews/diff.js';
import { parseVerdict, reviewEvidenceProblem, reviewPrompt } from '../../src/reviews/reviewer.js';
import { scanReviews, watchReviews } from '../../src/reviews/scan.js';
import type { SourceCandidate, SourceTask } from '../../src/sources/contract.js';
import type { SourceRef, Task } from '../../src/shared/types.js';
import { sourceItemFor, writeWorkspaceState } from '../../src/workspace/state.js';
import { createTempDir } from '../support.js';

const REF: SourceRef = {
  type: 'jira',
  scope: 'https://example.atlassian.net',
  id: '10011',
  key: 'HARN-11',
  url: 'https://example.atlassian.net/browse/HARN-11',
  updatedAt: '2026-09-16T11:00:00.000Z',
};

const TASK: Task = {
  id: 'HARN-11',
  title: 'Add a greeting function',
  description: 'Implement the greeting the ticket describes.',
  acceptanceCriteria: ['The greeting is implemented.', 'The tests cover it.'],
};

const HEAD = 'b'.repeat(40);

const PULL_REQUEST: OpenPullRequest = {
  number: 7,
  url: 'https://github.com/owner/name/pull/7',
  title: 'HARN-11: add a greeting function',
  headSha: HEAD,
  headBranch: 'harness/HARN-11',
  baseBranch: 'main',
  baseSha: 'c'.repeat(40),
  draft: false,
  author: 'nexus-agent',
};

const FILE: ChangedFile = {
  path: 'src/greeting.ts',
  patch: [
    '@@ -1,3 +1,4 @@',
    ' export function greet() {',
    '+  return "hello";',
    '   return "hi";',
    ' }',
  ].join('\n'),
  additions: 1,
  deletions: 0,
};

describe('the reviewer verdict file', () => {
  it('accepts the two decisions with the findings each needs', () => {
    expect(
      parseVerdict(
        JSON.stringify({ verdict: 'approve', summary: 'the change is right', findings: [] }),
        'verdict.json',
      ),
    ).toEqual({ decision: 'approve', summary: 'the change is right', findings: [] });
    expect(
      parseVerdict(
        JSON.stringify({
          verdict: 'request_changes',
          summary: 'one blocking problem',
          findings: [{ path: 'src/greeting.ts', line: 2, body: 'this returns the wrong value' }],
        }),
        'verdict.json',
      ),
    ).toEqual({
      decision: 'request_changes',
      summary: 'one blocking problem',
      findings: [{ path: 'src/greeting.ts', line: 2, body: 'this returns the wrong value' }],
    });
    // A whole-change finding carries no line at all.
    expect(
      parseVerdict(
        JSON.stringify({
          verdict: 'request_changes',
          summary: 'the change misses the point',
          findings: [{ path: 'src/greeting.ts', line: null, body: 'rework it' }],
        }),
        'verdict.json',
      ),
    ).toMatchObject({ decision: 'request_changes' });
  });

  it('refuses an approval with findings and a request for changes without one', () => {
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'approve',
          summary: 'looks fine',
          findings: [{ path: 'src/greeting.ts', line: 1, body: 'a note' }],
        }),
        'verdict.json',
      ),
    ).toThrow(/an approval cannot carry blocking findings/);
    expect(() =>
      parseVerdict(
        JSON.stringify({ verdict: 'request_changes', summary: 'nope', findings: [] }),
        'verdict.json',
      ),
    ).toThrow(/asks for changes but names no finding/);
  });

  it('refuses anything it cannot read as one of the three decisions', () => {
    for (const text of [
      'not json',
      '[]',
      JSON.stringify({ verdict: 'looks-fine', summary: 'x', findings: [] }),
      JSON.stringify({ verdict: 'approve', findings: [] }),
      JSON.stringify({ verdict: 'approve', summary: 'x', findings: 'none' }),
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'x',
        findings: [{ path: 'a', line: 1.5, body: 'b' }],
      }),
    ]) {
      expect(() => parseVerdict(text, 'verdict.json'), text).toThrow(ReviewError);
    }
    // An inconclusive verdict decides nothing, and needs no findings.
    expect(
      parseVerdict(
        JSON.stringify({
          verdict: 'inconclusive',
          summary: 'CI artifacts are missing',
          findings: [],
        }),
        'verdict.json',
      ),
    ).toEqual({ decision: 'inconclusive', summary: 'CI artifacts are missing', findings: [] });
  });

  it('refuses a field past its bound instead of cutting it down', () => {
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'approve',
          summary: `x${'y'.repeat(4_000)}`,
          findings: [],
        }),
        'verdict.json',
      ),
    ).toThrow(/past the 4000 this harness accepts/);
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'request_changes',
          summary: 'ok',
          findings: [{ path: 'src/greeting.ts', line: 1, body: 'y'.repeat(2_001) }],
        }),
        'verdict.json',
      ),
    ).toThrow(/past the 2000 this harness accepts/);
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'request_changes',
          summary: 'ok',
          findings: Array.from({ length: 21 }, () => ({
            path: 'src/greeting.ts',
            line: 1,
            body: 'b',
          })),
        }),
        'verdict.json',
      ),
    ).toThrow(/too many findings/);
  });

  it('ignores unknown extra fields, so a stray key cannot make a usable verdict unusable', () => {
    expect(
      parseVerdict(
        JSON.stringify({ verdict: 'approve', summary: 'fine', findings: [], note: 'extra' }),
        'verdict.json',
      ),
    ).toEqual({ decision: 'approve', summary: 'fine', findings: [] });
  });
});

describe('the dispositions and the verification of a verdict', () => {
  it('keeps a continuation grouped under the identity the history gave it', () => {
    expect(
      parseVerdict(
        JSON.stringify({
          verdict: 'request_changes',
          summary: 'the repair did not hold',
          findings: [
            {
              path: 'src/greeting.ts',
              line: 2,
              body: 'the same argument is still ignored',
              kind: 'unresolved',
              continues: 'R2-F1',
              related: [{ path: 'src/salutation.ts', line: 4 }],
            },
          ],
          verifications: [
            { finding: 'R2-F1', state: 'unverified', evidence: 'the helper still ignores it' },
          ],
        }),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toEqual({
      decision: 'request_changes',
      summary: 'the repair did not hold',
      findings: [
        {
          path: 'src/greeting.ts',
          line: 2,
          body: 'the same argument is still ignored',
          kind: 'unresolved',
          continues: 'R2-F1',
          related: [{ path: 'src/salutation.ts', line: 4 }],
        },
      ],
      verifications: [
        { finding: 'R2-F1', state: 'unverified', evidence: 'the helper still ignores it' },
      ],
    });
  });

  it('publishes an approval only when every outstanding disposition is verified', () => {
    const approve = (state: string): string =>
      JSON.stringify({
        verdict: 'approve',
        summary: 'the repair holds',
        findings: [],
        verifications: [{ finding: 'R2-F1', state, evidence: 'read src/greeting.ts:2' }],
      });
    expect(parseVerdict(approve('verified'), 'verdict.json', ['R2-F1'])).toMatchObject({
      decision: 'approve',
      verifications: [{ finding: 'R2-F1', state: 'verified' }],
    });
    for (const state of ['unverified', 'regressed']) {
      expect(() => parseVerdict(approve(state), 'verdict.json', ['R2-F1'])).toThrow(
        /an approval cannot leave an outstanding finding unverified/,
      );
    }
    // A verdict that verifies nothing while a finding is outstanding would
    // publish the disposition unverified; it is refused instead.
    expect(() =>
      parseVerdict(
        JSON.stringify({ verdict: 'approve', summary: 'fine', findings: [] }),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toThrow(/does not verify R2-F1/);
    // One reading per identity, and none for an identity nothing raised.
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'request_changes',
          summary: 'still broken',
          findings: [{ path: 'a', line: 1, body: 'b' }],
          verifications: [
            { finding: 'R2-F1', state: 'unverified', evidence: 'e' },
            { finding: 'R2-F1', state: 'verified', evidence: 'e' },
          ],
        }),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toThrow(/verifies "R2-F1" more than once/);
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'request_changes',
          summary: 'still broken',
          findings: [{ path: 'a', line: 1, body: 'b' }],
          verifications: [{ finding: 'R9-F9', state: 'verified', evidence: 'e' }],
        }),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toThrow(/not one of the outstanding findings/);
    expect(() =>
      parseVerdict(
        JSON.stringify({
          verdict: 'approve',
          summary: 'fine',
          findings: [],
          verifications: [{ finding: 'R2-F1', state: 'verified', evidence: 'e' }],
        }),
        'verdict.json',
      ),
    ).toThrow(/no change request was outstanding/);
    // An inconclusive verdict decides nothing, so it need not state a reading
    // of the outstanding findings; it publishes neither a review nor a check.
    expect(
      parseVerdict(
        JSON.stringify({
          verdict: 'inconclusive',
          summary: 'the reviewed view could not be read',
          findings: [],
        }),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toEqual({
      decision: 'inconclusive',
      summary: 'the reviewed view could not be read',
      findings: [],
    });
  });

  it('refuses a continuation or a verification the history cannot resolve', () => {
    const request = (finding: Record<string, unknown>): string =>
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'x',
        findings: [finding],
        verifications: [{ finding: 'R2-F1', state: 'unverified', evidence: 'e' }],
      });
    // An unresolved defect has to name what it continues.
    expect(() =>
      parseVerdict(request({ path: 'a', line: 1, body: 'b', kind: 'unresolved' }), 'verdict.json', [
        'R2-F1',
      ]),
    ).toThrow(/without naming the earlier finding it continues/);
    expect(() =>
      parseVerdict(
        request({ path: 'a', line: 1, body: 'b', kind: 'unresolved', continues: 'R7-F9' }),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toThrow(/which is not one of the outstanding findings/);
    // A new finding continues nothing.
    expect(() =>
      parseVerdict(request({ path: 'a', line: 1, body: 'b', continues: 'R2-F1' }), 'verdict.json', [
        'R2-F1',
      ]),
    ).toThrow(/while being classified "new"/);
    // A classification and a grouping have to be the ones this harness reads.
    expect(() =>
      parseVerdict(
        request({ path: 'a', line: 1, body: 'b', kind: 'regression?' }),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toThrow(/instead of "new", "unresolved" or "regression"/);
    expect(() =>
      parseVerdict(
        request({ path: 'a', line: 1, body: 'b', related: 'src/other.ts' }),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toThrow(/"related" that is not a list/);
    expect(() =>
      parseVerdict(
        request({ path: 'a', line: 1, body: 'b', related: [{ path: '' }] }),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toThrow(/occurrence 1 of finding 1 "path"/);
  });

  it('raises one defect once, and never as both verified and still present', () => {
    const verdict = (findings: readonly unknown[], verifications: readonly unknown[]): string =>
      JSON.stringify({ verdict: 'request_changes', summary: 'x', findings, verifications });
    const continuation = (path: string): Record<string, unknown> => ({
      path,
      line: 1,
      body: 'the same argument is still ignored',
      kind: 'unresolved',
      continues: 'R2-F1',
    });
    const unverified = {
      finding: 'R2-F1',
      state: 'unverified',
      evidence: 'read src/greeting.ts:2',
    };

    // One defect keeps one identity: the other places it reached are grouped
    // under the finding, not raised as a second continuation of it.
    expect(() =>
      parseVerdict(
        verdict([continuation('src/greeting.ts'), continuation('src/salutation.ts')], [unverified]),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toThrow(/raises a second finding continuing "R2-F1"/);
    // A disposition cannot be published as settled and still present at once.
    expect(() =>
      parseVerdict(
        verdict([continuation('src/greeting.ts')], [{ ...unverified, state: 'verified' }]),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toThrow(/both settled and still present/);
    // The continuation and the verification are tied to the identity the
    // history named, whatever case the reviewer wrote it in.
    expect(
      parseVerdict(
        verdict(
          [{ ...continuation('src/greeting.ts'), continues: 'r2-f1' }],
          [{ ...unverified, finding: 'r2-f1' }],
        ),
        'verdict.json',
        ['R2-F1'],
      ),
    ).toMatchObject({
      findings: [{ kind: 'unresolved', continues: 'R2-F1' }],
      verifications: [{ finding: 'R2-F1', state: 'unverified' }],
    });
  });
});

describe('where a finding lands in the diff', () => {
  it('numbers positions the way the review API reads them, later hunks included', () => {
    const patch = [
      '@@ -1,4 +1,5 @@',
      ' context',
      '+added',
      ' more context',
      '-removed',
      '@@ -10,2 +11,2 @@',
      ' second hunk context',
      '+another addition',
    ].join('\n');
    // The first content line after the header is position 1.
    expect(diffPosition(patch, 2)).toBe(2);
    expect(diffPosition(patch, 3)).toBe(3);
    // A removed line shows no new-file line, and the first hunk's context after
    // it is still numbered in order.
    expect(diffPosition(patch, 11)).toBe(6);
    expect(diffPosition(patch, 12)).toBe(7);
    expect(diffPosition(patch, 99)).toBeNull();
  });

  it('positions only findings whose file GitHub reported a complete patch for', () => {
    const positioned = positionFindings(
      [
        { path: 'src/greeting.ts', line: 2, body: 'inline body' },
        { path: 'src/greeting.ts', line: 40, body: 'a line the patch does not show' },
        { path: 'src/other.ts', line: 1, body: 'a file the pull request does not change' },
        { path: 'src/greeting.ts', line: null, body: 'a whole-change finding' },
      ],
      [FILE],
    );
    expect(positioned.comments).toEqual([
      { path: 'src/greeting.ts', position: 2, body: 'inline body' },
    ]);
    expect(positioned.unpositioned.map((finding) => finding.body)).toEqual([
      'a line the patch does not show',
      'a file the pull request does not change',
      'a whole-change finding',
    ]);
  });

  it('refuses to position anything from a patch whose counts disagree with GitHub', () => {
    const incomplete: ChangedFile = { ...FILE, additions: 5 };
    const positioned = positionFindings([{ path: FILE.path, line: 2, body: 'b' }], [incomplete]);
    expect(positioned.comments).toEqual([]);
    expect(positioned.unpositioned).toHaveLength(1);
  });
});

describe('the reviewer prompt', () => {
  const evidence: ReviewEvidence = {
    ref: REF,
    task: TASK,
    pullRequest: PULL_REQUEST,
    files: [FILE],
    truncated: false,
    checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
    combinedStatus: 'success',
    fetchedAt: '2026-09-16T11:05:00.000Z',
  };

  /** One snapshot whose review left `R2-F1` outstanding. */
  function historyWithOutstandingFinding(): HistorySnapshot {
    const dir = '/work/workspaces/HARN-11.history/snapshots/snapshot-1';
    const review = {
      entryId: 'harness:reviewer-report:review-2',
      kind: 'reviewer-report' as const,
      round: 2,
      author: 'Nexus Lens',
      createdAt: '2026-09-16T10:00:00.000Z',
      sourceId: 'review-2',
      complete: true,
      problem: null,
      status: null,
      reason: null,
      head: HEAD,
      nativeReviewId: null,
      decision: 'request_changes',
      summary: 'the greeting is wrong',
      findings: [
        {
          id: 'R2-F1',
          path: 'src/greeting.ts',
          line: 2,
          body: 'the greeting ignores the argument it is given',
        },
      ],
      responses: [
        {
          finding: 'R2-F1',
          complete: true,
          problem: null,
          cause: 'the helper ignored its argument',
          scope: 'src/greeting.ts',
          repair: 'the helper returns what it was given',
          verification: 'exercised greet("hi")',
          uncertainty: 'none',
          entryId: 'harness:developer-report:run-4',
          runId: 'run-4',
          round: 4,
          createdAt: '2026-09-16T10:30:00.000Z',
        },
      ],
      pullRequest: null,
    };
    return {
      version: 1,
      id: 'snapshot-1',
      role: 'reviewer',
      round: 3,
      takenAt: '2026-09-16T11:00:00.000Z',
      root: '/work/workspaces/HARN-11.history',
      dir,
      indexPath: `${dir}/index.md`,
      indexJsonPath: `${dir}/index.json`,
      entriesPath: `${dir}/entries.jsonl`,
      reportsDir: '/work/workspaces/HARN-11.history/reports',
      brief: {
        ref: REF,
        task: TASK,
        latestDelivery: null,
        unresolved: review,
        unresolvedReviews: [review],
        responses: [],
        newHumanFeedback: [],
      },
      entries: [],
      reports: [review],
      gaps: [],
      mirrors: [],
      sources: [{ source: 'jira', problem: null }],
    };
  }

  it('names the view, the verdict file and the CI reading, and refuses no evidence', () => {
    const prompt = reviewPrompt(
      evidence,
      { path: '/evidence/repo', head: HEAD, base: PULL_REQUEST.baseSha },
      '/evidence/review-1',
    );

    expect(prompt).toContain('You are Nexus Lens');
    expect(prompt).toContain('/evidence/repo');
    expect(prompt).toContain(HEAD);
    expect(prompt).toContain(path.join('/evidence/review-1', 'verdict.json'));
    expect(prompt).toContain('CI is a separate merge requirement');
    expect(prompt).toContain('- CI: completed/success');
    expect(prompt).toContain('Review only');
    expect(reviewEvidenceProblem(evidence)).toBeNull();
  });

  it('reports a ticket too large to state compactly before any paid turn', () => {
    const tooLarge: ReviewEvidence = {
      ...evidence,
      task: { ...TASK, description: 'x'.repeat(8_001) },
    };
    expect(reviewEvidenceProblem(tooLarge)).toMatch(/exceeds the reviewer input limit/);
  });

  it('lists the outstanding identities to verify and keeps claims apart from verifications', () => {
    const prompt = reviewPrompt(
      evidence,
      { path: '/evidence/repo', head: HEAD, base: PULL_REQUEST.baseSha },
      '/evidence/review-2',
      historyWithOutstandingFinding(),
    );

    expect(prompt).toContain('## The outstanding findings and their answers');
    expect(prompt).toContain('Outstanding identities you must verify: R2-F1.');
    expect(prompt).toContain('"verifications"');
    expect(prompt).toMatch(/[Aa] claim is never a verification/);
    expect(prompt).toContain('"kind"');
    expect(prompt).toContain('"related"');
    expect(prompt).toContain('still review the whole change against the requested');
    expect(prompt).toContain('A successful check is not the change’s completion');
    // The answer itself is rendered with the finding, as a claim.
    expect(prompt).toContain('Developer response (a claim, not a verification');
    expect(prompt).toContain('the helper returns what it was given');
  });

  it('shows a verdict example that a reviewer can really write, before and after a change request', () => {
    /** The one JSON example the prompt states, parsed the way the scan reads it. */
    const exampleOf = (prompt: string): string => {
      const block = /```json\n([\s\S]*?)\n```/.exec(prompt);
      expect(block, 'the prompt states its verdict example as one JSON block').not.toBeNull();
      return block?.[1] ?? '';
    };
    const view = { path: '/evidence/repo', head: HEAD, base: PULL_REQUEST.baseSha };

    // The initial review: no change request is outstanding, so the example is
    // a request for changes with one new finding — no "continues", no
    // "verifications" — and the parser accepts it as written.
    const initialExample = exampleOf(reviewPrompt(evidence, view, '/evidence/review-1'));
    expect(initialExample).not.toContain('continues');
    expect(initialExample).not.toContain('verifications');
    const initial = parseVerdict(initialExample, 'verdict.json');
    expect(initial).toMatchObject({
      decision: 'request_changes',
      findings: [{ path: 'src/example.ts', line: 42 }],
    });
    // A finding stated as "new" continues nothing, so nothing is published
    // beside it that a later review would have to follow.
    expect(initial.findings[0]).not.toHaveProperty('continues');
    expect(initial).not.toHaveProperty('verifications');

    // The follow-up review: the example covers every outstanding identity
    // exactly once, which is what the parser requires of a real verdict.
    const followUp = historyWithOutstandingFinding();
    const second = followUp.brief.unresolvedReviews?.[0];
    expect(second).toBeDefined();
    if (second === undefined) {
      throw new Error('the fixture carries one outstanding review');
    }
    const earlier: HistoryReportSummary = {
      ...second,
      entryId: 'harness:reviewer-report:review-1',
      sourceId: 'review-1',
      round: 1,
      summary: 'the greeting ignores the argument it is given',
      findings: [
        {
          id: 'R1-F1',
          path: 'src/greeting.ts',
          line: 2,
          body: 'the greeting ignores the argument it is given',
        },
      ],
      responses: [],
    };
    const carrying: HistorySnapshot = {
      ...followUp,
      brief: {
        ...followUp.brief,
        unresolved: second,
        unresolvedReviews: [earlier, second],
      },
    };
    const followUpExample = exampleOf(reviewPrompt(evidence, view, '/evidence/review-2', carrying));
    expect(parseVerdict(followUpExample, 'verdict.json', ['R1-F1', 'R2-F1'])).toMatchObject({
      decision: 'request_changes',
      verifications: [
        { finding: 'R1-F1', state: 'unverified' },
        { finding: 'R2-F1', state: 'unverified' },
      ],
    });
  });
});

/**
 * The scan context one case drives, with the ticket it is about: the reviewer
 * turn's own outcome, the view's own state after it, and the caller's stop are
 * supplied by the case, and nothing here starts a process or reads GitHub.
 */
async function scanHarness(parts: {
  readonly item?: SourceTask | null;
  readonly pointers?: readonly string[];
  readonly pullRequest?: OpenPullRequest | null;
  readonly reviews?: Awaited<ReturnType<ReviewRepository['listReviews']>>;
  readonly checks?: Awaited<ReturnType<ReviewRepository['reviewChecks']>>;
  readonly current?: OpenPullRequest | null;
  readonly verdict?: ReviewerVerdict;
  readonly turnProblem?: string;
  /** Why the view is no longer the clean snapshot it was pinned as; clean when absent. */
  readonly viewProblem?: string;
  /** Whether the caller's interrupt arrives while the reviewer turn is running. */
  readonly cancelDuringTurn?: boolean;
}) {
  const workDir = await createTempDir();
  const workspaceId = 'HARN-11';
  await mkdir(`${workDir}/workspaces/${workspaceId}`, { recursive: true });
  await writeWorkspaceState(workDir, {
    version: 1,
    workspaceId,
    sourceRoot: workDir,
    baseCommit: PULL_REQUEST.baseSha,
    branch: `harness/${workspaceId}`,
    createdAt: '2026-09-16T10:00:00.000Z',
    sourceItem: sourceItemFor(REF),
    attempts: [],
  });

  const item: SourceTask = {
    ref: REF,
    task: TASK,
    pointers: parts.pointers ?? [workspaceId],
    preferredWorkspaceId: workspaceId,
  };
  const pullRequest = parts.pullRequest === undefined ? PULL_REQUEST : parts.pullRequest;
  const published = { reviews: [] as unknown[], checks: [] as unknown[] };
  const calls = { reviewerTurns: 0, viewChecks: 0 };
  const stop = new AbortController();

  const repository: ReviewRepository = {
    findOpenPullRequest: async () => pullRequest,
    readPullRequest: async () => (parts.current === undefined ? pullRequest : parts.current),
    listReviews: async () => parts.reviews ?? [],
    reviewChecks: async () => parts.checks ?? [],
    readEvidence: async (): Promise<ReviewEvidence> => ({
      ref: REF,
      task: TASK,
      pullRequest: pullRequest ?? PULL_REQUEST,
      files: [FILE],
      truncated: false,
      checks: [],
      combinedStatus: null,
      fetchedAt: '2026-09-16T11:05:00.000Z',
    }),
    publishReview: async (request) => {
      published.reviews.push(request);
      return {
        id: 21,
        url: 'https://github.com/owner/name/pull/7#review-21',
        state: request.decision === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED',
      };
    },
    publishCheck: async (request) => {
      published.checks.push(request);
      return {
        id: 22,
        url: 'https://github.com/owner/name/runs/22',
        conclusion: request.decision === 'approve' ? 'success' : 'failure',
      };
    },
  };

  const views: ReviewViewSource = {
    prepare: async ({ dir, head, base }) => ({ path: `${dir}/repo`, head, base }),
    problem: async () => {
      calls.viewChecks += 1;
      return parts.viewProblem ?? null;
    },
  };

  const outputs: string[] = [];
  const context: ReviewScanContext = {
    queue: {
      list: async (): Promise<readonly SourceCandidate[]> => [{ ref: REF, title: TASK.title }],
      prepare: async () => (parts.item === undefined ? item : parts.item),
    },
    repository,
    reviewer: async () => {
      calls.reviewerTurns += 1;
      if (parts.cancelDuringTurn === true) {
        // The interrupt the caller sends arrives while the paid turn is running;
        // the turn still finishes and answers with its verdict.
        stop.abort(new Error('the operator stopped the review scan'));
      }
      return {
        summary: 'a summary',
        verdict: parts.verdict ?? { decision: 'approve', summary: 'fine', findings: [] },
        problem: parts.turnProblem ?? null,
        logPath: `${workDir}/reviewer.log`,
      };
    },
    views,
    workDir,
    sourceRoot: workDir,
    login: 'nexus-lens[bot]',
    checkName: 'Nexus Lens review',
    reviewerTimeoutMs: 30_000,
    io: { out: (text) => outputs.push(text), err: (text) => outputs.push(text) },
    stop: stop.signal,
    now: () => new Date('2026-09-16T11:10:00.000Z'),
    sleep: async () => undefined,
  };
  return { context, published, calls, outputs, stop };
}

describe('one review scan', () => {
  it('starts no reviewer turn for a head the App already reviewed and checked', async () => {
    const harness = await scanHarness({
      reviews: [
        {
          id: 21,
          login: 'nexus-lens[bot]',
          state: 'APPROVED',
          commitId: HEAD,
          url: 'https://github.com/owner/name/pull/7#review-21',
        },
      ],
      checks: [
        {
          id: 22,
          conclusion: 'success',
          url: 'https://github.com/owner/name/runs/22',
        },
      ],
    });

    const summary = await scanReviews(harness.context);

    expect(summary.outcome).toBe('completed');
    expect(summary.unchanged).toBe(1);
    expect(summary.reviewed).toBe(0);
    expect(summary.reviewerRuns).toBe(0);
    expect(harness.calls.reviewerTurns).toBe(0);
    expect(harness.published.reviews).toEqual([]);
  });

  it('reconciles a missing app-owned check from the existing native review', async () => {
    const harness = await scanHarness({
      reviews: [
        {
          id: 21,
          login: 'nexus-lens[bot]',
          state: 'CHANGES_REQUESTED',
          commitId: HEAD,
          url: 'https://github.com/owner/name/pull/7#review-21',
        },
      ],
      checks: [],
    });

    const summary = await scanReviews(harness.context);

    expect(summary.unchanged).toBe(1);
    expect(summary.reviewerRuns).toBe(0);
    expect(harness.calls.reviewerTurns).toBe(0);
    expect(harness.published.checks).toHaveLength(1);
    expect(harness.published.checks[0]).toMatchObject({
      head: HEAD,
      decision: 'request_changes',
    });
  });

  it('runs the reviewer turn for a fresh head and publishes its verdict', async () => {
    const harness = await scanHarness({
      verdict: {
        decision: 'request_changes',
        summary: 'one blocking problem',
        findings: [{ path: 'src/greeting.ts', line: 2, body: 'this returns the wrong value' }],
      },
    });

    const summary = await scanReviews(harness.context);

    expect(summary.outcome).toBe('completed');
    expect(summary.reviewed).toBe(1);
    expect(summary.changesRequested).toBe(1);
    expect(summary.reviewerRuns).toBe(1);
    expect(harness.published.reviews).toHaveLength(1);
    expect(harness.published.reviews[0]).toMatchObject({
      head: HEAD,
      decision: 'request_changes',
      comments: [{ path: 'src/greeting.ts', position: 2, body: 'this returns the wrong value' }],
    });
    expect(harness.published.checks).toHaveLength(1);
  });

  it('publishes nothing and needs a person for an inconclusive verdict', async () => {
    const harness = await scanHarness({
      verdict: { decision: 'inconclusive', summary: 'CI artifacts are missing', findings: [] },
    });

    const summary = await scanReviews(harness.context);

    expect(summary.attention).toBe(1);
    expect(summary.reviewed).toBe(0);
    expect(harness.published.reviews).toEqual([]);
    expect(harness.published.checks).toEqual([]);
    expect(harness.outputs.join('\n')).toMatch(/review inconclusive/);
  });

  it('publishes nothing when the reviewed head moved while the turn ran', async () => {
    const harness = await scanHarness({
      current: { ...PULL_REQUEST, headSha: 'd'.repeat(40) },
      verdict: { decision: 'approve', summary: 'fine', findings: [] },
    });

    const summary = await scanReviews(harness.context);

    expect(summary.attention).toBe(1);
    expect(summary.reviewerRuns).toBe(1);
    expect(harness.published.reviews).toEqual([]);
    expect(harness.outputs.join('\n')).toMatch(/moved from/);
  });

  it('reports a ticket whose pointer label cannot identify a workspace', async () => {
    const harness = await scanHarness({ pointers: [] });

    const summary = await scanReviews(harness.context);

    expect(summary.attention).toBe(1);
    expect(summary.reviewerRuns).toBe(0);
    expect(harness.outputs.join('\n')).toMatch(/no pull request can be identified/);
  });

  it('stops a scan for the ticket a caller scoped it to, and skips the others', async () => {
    const harness = await scanHarness({});
    const only: SourceRef = { ...REF, id: '10012', key: 'HARN-12' };

    const summary = await scanReviews({ ...harness.context, only });

    expect(summary.scanned).toBe(0);
    expect(harness.calls.reviewerTurns).toBe(0);
  });
});

/**
 * The verdicts one scan refuses even though the reviewer turn produced one: a
 * view the turn left changed, and a turn that failed or was interrupted before
 * it answered. Each is a ticket needing a person, and each publishes neither a
 * native review nor a check — an approval is never posted from evidence the scan
 * cannot stand behind (docs/spec.md §9).
 */
describe('a verdict one scan will not publish', () => {
  it('publishes nothing when the reviewer changed its repository view', async () => {
    const harness = await scanHarness({
      viewProblem: 'the repository view carries 1 changed path(s): "notes.txt"',
    });

    const summary = await scanReviews(harness.context);

    expect(summary).toMatchObject({ attention: 1, reviewed: 0, reviewerRuns: 1 });
    // The view is re-checked after the turn, and what its own check found is
    // what the operator is shown.
    expect(harness.calls.viewChecks).toBe(1);
    expect(harness.outputs.join('\n')).toContain('repository view for');
    expect(harness.outputs.join('\n')).toContain('notes.txt');
    expect(harness.published.reviews).toEqual([]);
    expect(harness.published.checks).toEqual([]);
  });

  it('refuses a completed approval a failed turn returned', async () => {
    const harness = await scanHarness({
      verdict: { decision: 'approve', summary: 'the change is right', findings: [] },
      turnProblem: 'the reviewer runtime was interrupted',
    });

    const summary = await scanReviews(harness.context);

    expect(summary).toMatchObject({ attention: 1, reviewed: 0, reviewerRuns: 1 });
    expect(harness.outputs.join('\n')).toContain('the reviewer runtime was interrupted');
    expect(harness.published.reviews).toEqual([]);
    expect(harness.published.checks).toEqual([]);
  });

  it('publishes nothing when the caller cancelled the scan during the reviewer turn', async () => {
    const harness = await scanHarness({
      cancelDuringTurn: true,
      verdict: { decision: 'approve', summary: 'the change is right', findings: [] },
    });

    const summary = await scanReviews(harness.context);

    expect(harness.stop.signal.aborted).toBe(true);
    expect(summary).toMatchObject({ attention: 1, reviewed: 0, reviewerRuns: 1 });
    expect(summary.items.map((item) => item.disposition)).toEqual(['attention']);
    expect(harness.published.reviews).toEqual([]);
    expect(harness.published.checks).toEqual([]);
  });
});

/**
 * One review watch whose scans, waits and stop the case controls: each scan is
 * the case's own answer, and the idle wait is where a case ends the watch. No
 * GitHub read, reviewer turn or repository view is reached.
 */
async function watchHarness(parts: {
  readonly list: (scan: number) => Promise<readonly SourceCandidate[]>;
  readonly sleep: (ms: number, stop: AbortSignal) => Promise<void>;
  readonly pollIntervalMs: number;
}) {
  const workDir = await createTempDir();
  let scans = 0;
  const errors: string[] = [];
  const context: ReviewWatchOptions = {
    queue: {
      list: async () => {
        scans += 1;
        return await parts.list(scans);
      },
      prepare: async () => null,
    },
    repository: {
      findOpenPullRequest: async () => null,
      readPullRequest: async () => null,
      listReviews: async () => [],
      reviewChecks: async () => [],
      readEvidence: async () => {
        throw new Error('no pull request was identified, so no evidence is read');
      },
      publishReview: async () => {
        throw new Error('nothing is published by a watch case');
      },
      publishCheck: async () => {
        throw new Error('nothing is published by a watch case');
      },
    },
    reviewer: async () => {
      throw new Error('no reviewer turn is started by a watch case');
    },
    views: {
      prepare: async () => {
        throw new Error('no repository view is pinned by a watch case');
      },
      problem: async () => null,
    },
    workDir,
    sourceRoot: null,
    login: 'nexus-lens[bot]',
    checkName: 'Nexus Lens review',
    reviewerTimeoutMs: 60_000,
    io: { out: () => undefined, err: (text) => errors.push(text) },
    stop: new AbortController().signal,
    now: () => new Date('2026-09-16T11:10:00.000Z'),
    sleep: async (ms, stop) => {
      await parts.sleep(ms, stop);
    },
    pollIntervalMs: parts.pollIntervalMs,
  };
  return { context, errors, scans: () => scans };
}

describe('the review watch', () => {
  it('waits out the poll interval, and a stop during the wait starts no further scan', async () => {
    const stop = new AbortController();
    const waits: number[] = [];
    const harness = await watchHarness({
      list: async () => [],
      pollIntervalMs: 5_000,
      sleep: async (ms, signal) => {
        waits.push(ms);
        expect(signal.aborted).toBe(false);
        // The interrupt arrives while the watch is idle: the wait is where the
        // loop notices it, and the scan that would follow is never started.
        stop.abort(new Error('stop watching'));
      },
    });

    const summary = await watchReviews({
      ...harness.context,
      stop: stop.signal,
    });

    expect(harness.scans()).toBe(1);
    expect(waits).toEqual([5_000]);
    expect(summary.outcome).toBe('cancelled');
  });

  it('never shortens a server-directed wait, doubles its own backoff, and resets on success', async () => {
    const stop = new AbortController();
    const waits: number[] = [];
    const harness = await watchHarness({
      list: async (scan) => {
        if (scan === 1) {
          throw new ReviewError('api', 'the search answered HTTP 429', {
            retryAfterMs: 120_000,
          });
        }
        if (scan === 2) {
          throw new ReviewError('api', 'the search answered nothing usable');
        }
        return [];
      },
      pollIntervalMs: 5_000,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 3) {
          stop.abort(new Error('stop watching'));
        }
      },
    });

    const summary = await watchReviews({ ...harness.context, stop: stop.signal });

    // The first wait is the server's own minimum, never the shorter poll
    // interval; the second is the watch's doubled backoff; the successful scan
    // resets the backoff to the poll interval.
    expect(harness.scans()).toBe(3);
    expect(waits).toEqual([120_000, 10_000, 5_000]);
    expect(harness.errors.join('\n')).toContain('will try again in 120s');
    expect(summary.outcome).toBe('cancelled');
  });
});
