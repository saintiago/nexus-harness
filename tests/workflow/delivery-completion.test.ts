/**
 * The third workflow: a passed attempt is really delivered — its branch pushed
 * and its pull request opened — and the ticket is finished only once the merge
 * GitHub made at that same revision, and the configured post-merge workflow, are
 * verified.
 *
 * The run, the working copy and the report are the harness's own; the delivery
 * pushes to a disposable bare repository through the real step and a stand-in
 * `gh`; and the completion pass is the real one, with its two service
 * boundaries controlled: the ticket's live state (a Jira stand-in) and GitHub's
 * merged state (a stand-in whose answers are built from the commit the delivery
 * really published). What no lower layer can show is that join: the revision the
 * checks passed is the revision that was pushed, and the one the merge is tied
 * to before the ticket is moved to Done.
 *
 * The archived `source-cli.integration.test.ts` and `completion-cli.test.ts`
 * proved delivery and the completion path through their whole-workflow
 * fixtures; this case is what carries their required behavior now, at the layer
 * that owns it (tests_old/REFERENCE.txt).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CompletionActions,
  CompletionRequest,
  GateVerdict,
  MergeVerdict,
  PullRequestSnapshot,
} from '../../src/delivery/completion.js';
import type { DeliveryRequest } from '../../src/delivery/github.js';
import { createGitHubDelivery } from '../../src/delivery/github.js';
import { createCompletionPass } from '../../src/sources/completion.js';
import type { CompletionSource, IssueNote, ReviewItem } from '../../src/sources/jira/completion.js';
import type { SourceCandidate } from '../../src/sources/contract.js';
import type { CompletionConfig, SourceRef } from '../../src/shared/types.js';
import {
  gitOrFail,
  installStandIn,
  useOwnedProcesses,
  withPathPrefix,
} from '../boundary/integration-support.js';
import {
  branchHead,
  createTargetProject,
  implementTurn,
  readRunReport,
  readdirEntries,
  recordingIo,
  runTicket,
} from './support.js';

useOwnedProcesses();

const SITE = 'https://example.atlassian.net';
const REF: SourceRef = {
  type: 'jira',
  scope: SITE,
  id: '10077',
  key: 'HARN-77',
  url: `${SITE}/browse/HARN-77`,
  updatedAt: '2026-03-01T10:00:00.000Z',
};
const WORKSPACE_ID = 'HARN-77';
const REPOSITORY = 'example/target';
const BASE_BRANCH = 'main';
const LOGIN = 'nexus-lens[bot]';
const CHECK_NAME = 'Nexus Lens review';
const PULL_REQUEST_URL = `https://github.com/${REPOSITORY}/pull/42`;
/** The merge GitHub reports for the reviewed head: a commit of its own. */
const MERGE_COMMIT = 'f'.repeat(40);

/**
 * A stand-in `gh` for the delivery step: it records every invocation and
 * answers the two calls a first delivery makes — no pull request is open yet,
 * and the create answers the URL the review and completion path then name.
 */
const STAND_IN_GH = [
  `import { appendFileSync } from 'node:fs';`,
  `const args = process.argv.slice(2);`,
  `appendFileSync(process.env.NEXUS_GH_RECORD, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');`,
  `const subcommand = args.slice(0, 2).join(' ');`,
  `if (subcommand === 'pr list') {`,
  `  process.stdout.write('[]');`,
  `  process.exit(0);`,
  `}`,
  `if (subcommand === 'pr create') {`,
  `  process.stdout.write('${PULL_REQUEST_URL}\\n');`,
  `  process.exit(0);`,
  `}`,
  `process.stderr.write('gh: unexpected ' + args.join(' ') + '\\n');`,
  `process.exit(2);`,
  '',
].join('\n');

/** The ticket's live state, as the completion pass reads and writes it. */
interface StandInTicket {
  readonly source: CompletionSource;
  readonly comments: readonly string[][];
  readonly moves: readonly string[];
  status(): string;
}

/** A Jira stand-in for one In Review ticket that carries a workspace pointer. */
function standInTicket(item: ReviewItem): StandInTicket {
  const candidate: SourceCandidate = { ref: item.ref, title: item.title };
  const notes: IssueNote[] = [];
  const comments: string[][] = [];
  const moves: string[] = [];
  let status = item.statusName;
  const source: CompletionSource = {
    listReview: async () => [candidate],
    readItem: async () => (status === 'In Review' ? item : null),
    listComments: async () => notes,
    leftReviewSince: async () => false,
    postComment: async (_id, paragraphs) => {
      comments.push([...paragraphs]);
      const id = String(notes.length + 1);
      notes.push({ id, createdAt: '2026-03-01T12:00:00.000Z', text: paragraphs.join('\n') });
      return id;
    },
    moveTo: async (_id, target, _stop, beforeWrite) => {
      if (beforeWrite !== undefined && !(await beforeWrite())) {
        return 'left-alone';
      }
      moves.push(target);
      status = target;
      return 'moved';
    },
  };
  return { source, comments, moves, status: () => status };
}

/** What the controlled GitHub side of the completion was asked to verify. */
interface StandInMerge {
  readonly actions: CompletionActions;
  readonly verifiedHeads: readonly string[];
  /** Every completion request the pass made, as the pass built it. */
  readonly requests: readonly CompletionRequest[];
}

/**
 * The GitHub completion boundary for a pull request GitHub has already merged
 * at `head`: every approval and check the gate reads is the current head's, and
 * the post-merge workflow succeeded for the merge commit.
 */
function standInMergedGitHub(head: string): StandInMerge {
  const verifiedHeads: string[] = [];
  const requests: CompletionRequest[] = [];
  const pull: PullRequestSnapshot = {
    number: 42,
    url: PULL_REQUEST_URL,
    state: 'MERGED',
    isDraft: false,
    headRefName: `harness/${WORKSPACE_ID}`,
    baseRefName: BASE_BRANCH,
    headRefOid: head,
    mergeCommit: { oid: MERGE_COMMIT },
  };
  const gate: GateVerdict = {
    status: 'approved',
    reason: 'the current head carries the reviewer approval and its check run',
    review: {
      id: '9001',
      author: LOGIN,
      state: 'APPROVED',
      body: 'the change does what the ticket asks',
      commitId: head,
      url: `${PULL_REQUEST_URL}#pullrequestreview-9001`,
    },
    findings: [],
  };
  const merge: MergeVerdict = {
    status: 'complete',
    reason: 'GitHub merged the reviewed head and every configured workflow succeeded',
    mergeCommit: MERGE_COMMIT,
    workflows: [{ identifier: 'ci.yml', state: 'success', run: null, conclusion: 'SUCCESS' }],
  };
  const actions: CompletionActions = {
    findPullRequest: async (request: CompletionRequest) => {
      requests.push(request);
      verifiedHeads.push(request.branch);
      return pull;
    },
    findMergedPullRequest: async () => pull,
    readGate: async () => gate,
    readApprovedHead: async () => head,
    readMerge: async (_request, _pull, reviewedHead) => {
      verifiedHeads.push(reviewedHead);
      return merge;
    },
    enableAutoMerge: async () => 'already-enabled',
  };
  return { actions, verifiedHeads, requests };
}

describe('delivery and verified completion', () => {
  it('delivers the revision the checks passed, then finishes the ticket on its verified merge', async () => {
    const project = await createTargetProject();
    const run = await runTicket({
      project,
      ref: REF,
      workspaceId: WORKSPACE_ID,
      turn: implementTurn,
    });
    const workspace = run.workspace;
    expect(workspace).not.toBeNull();
    const workspacePath = workspace?.workspacePath ?? '';
    const branch = workspace?.branch ?? '';
    const head = await branchHead(workspacePath, branch);
    expect(run.status).toBe('passed');

    // The delivery step is the real one: its `git` commands are this host's, and
    // only `gh` is a stand-in. The destination is a disposable bare repository.
    const destination = path.join(project.parent, 'target.git');
    await gitOrFail(['init', '--quiet', '--bare', destination], project.parent);
    const recordFile = path.join(project.parent, 'gh-record.jsonl');
    const gh = await installStandIn('gh', STAND_IN_GH);
    const delivery = createGitHubDelivery(
      { type: 'github', repository: REPOSITORY, baseBranch: BASE_BRANCH },
      { pushUrl: destination, env: { ...process.env, NEXUS_GH_RECORD: recordFile } },
    );
    const request: DeliveryRequest = {
      workspacePath,
      branch,
      baseCommit: workspace?.baseCommit ?? '',
      logsDir: run.run.logsDir,
      runId: run.run.runId,
      reportPath: run.reportPath,
      task: { id: REF.key, title: 'Finish the greeting' },
      checks: '1 of 1 configured checks exited 0 (round: passed)',
      sourceRef: REF,
    };
    const delivered = await withPathPrefix(gh.bin, () =>
      delivery.deliver(request, new AbortController().signal),
    );

    expect(delivered).toMatchObject({ number: 42, head, created: true });
    expect(
      (
        await gitOrFail(
          ['--git-dir', destination, 'rev-parse', `refs/heads/${branch}`],
          project.parent,
        )
      ).trim(),
    ).toBe(head);
    // The push, and only the push, is what the destination holds: the published
    // branch is the revision the checks really judged.
    expect(head).toBe(await branchHead(workspacePath, branch));
    expect((await readFile(recordFile, 'utf8')).trim().split('\n')).toHaveLength(2);

    // The completion pass is the real one, over the ticket's live state and
    // GitHub's answers for exactly that delivered head.
    const ticket = standInTicket({
      ref: REF,
      title: 'Finish the greeting',
      statusName: 'In Review',
      pointers: [WORKSPACE_ID],
    });
    const github = standInMergedGitHub(head);
    const config: CompletionConfig = {
      lensApp: LOGIN,
      lensAppId: 42,
      lensCheckName: CHECK_NAME,
      reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
      postMergeWorkflows: ['ci.yml'],
      toDoStatus: 'To Do',
      doneStatus: 'Done',
      pollIntervalSeconds: 30,
      deadlineSeconds: 1800,
    };
    const recorded = recordingIo();
    const pass = createCompletionPass({
      config,
      repository: REPOSITORY,
      baseBranch: BASE_BRANCH,
      source: ticket.source,
      actions: github.actions,
      workDir: project.workDir,
      io: recorded.io,
      now: () => new Date('2026-03-01T12:05:00.000Z'),
      sleep: async () => undefined,
    });
    const outcomes = await pass.run(new AbortController().signal);

    expect(recorded.err).toEqual([]);
    expect(github.verifiedHeads).toContain(head);
    // The completion works on the workspace the delivery published from: the
    // same clone, on the branch the delivered revision was pushed from.
    expect(github.requests[0]).toMatchObject({ workspacePath, branch });
    expect(await branchHead(github.requests[0]?.workspacePath ?? '', branch)).toBe(head);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'done', mergeCommit: MERGE_COMMIT });

    // One comment and one move: the ticket is told which merge finished it and
    // is moved to the configured Done status, once.
    expect(ticket.comments).toHaveLength(1);
    const comment = ticket.comments[0]?.join('\n') ?? '';
    expect(comment).toContain(PULL_REQUEST_URL);
    expect(comment).toContain(MERGE_COMMIT);
    expect(comment).toContain('ci.yml');
    expect(ticket.moves).toEqual(['Done']);
    expect(ticket.status()).toBe('Done');

    // The run's own evidence stands beside the completion's: the report is the
    // pass the delivery published, and the ticket's workspace still holds it.
    const { report } = await readRunReport(project.workDir);
    expect(report['status']).toBe('passed');
    expect(await branchHead(workspacePath, branch)).toBe(head);
    expect(await readdirEntries(path.join(project.workDir, 'completion-logs'))).not.toHaveLength(0);
  });
});
