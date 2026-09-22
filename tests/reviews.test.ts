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
} from '../src/reviews/contract.js';
import { ReviewError } from '../src/reviews/contract.js';
import { diffPosition, positionFindings } from '../src/reviews/diff.js';
import { parseVerdict, reviewEvidenceProblem, reviewPrompt } from '../src/reviews/reviewer.js';
import { scanReviews } from '../src/reviews/scan.js';
import type { SourceCandidate, SourceTask } from '../src/sources/contract.js';
import type { SourceRef, Task } from '../src/shared/types.js';
import { sourceItemFor, writeWorkspaceState } from '../src/workspace/state.js';
import { createTempDir } from './support.js';

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
});

/** The scan context one case drives, with the ticket it is about. */
async function scanHarness(parts: {
  readonly item?: SourceTask | null;
  readonly pointers?: readonly string[];
  readonly pullRequest?: OpenPullRequest | null;
  readonly reviews?: Awaited<ReturnType<ReviewRepository['listReviews']>>;
  readonly checks?: Awaited<ReturnType<ReviewRepository['reviewChecks']>>;
  readonly current?: OpenPullRequest | null;
  readonly verdict?: ReviewerVerdict;
  readonly turnProblem?: string;
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
  const calls = { reviewerTurns: 0 };

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
    problem: async () => null,
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
    stop: new AbortController().signal,
    now: () => new Date('2026-09-16T11:10:00.000Z'),
    sleep: async () => undefined,
  };
  return { context, published, calls, outputs };
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
