/**
 * The small review-to-completion pass: one bounded scan of the In Review items
 * that carry a workspace pointer, and for each of them one deterministic
 * handling built only from live GitHub and Jira state.
 *
 * A local admission records only the PR/head and deadline, never its outcome.
 * What happened is read back every time: the item's status and thread in Jira, and the
 * pull request in the repository GitHub owns. Comment markers are how a repeated
 * pass or a restart recognises the comment it already wrote — the thread is the
 * record, and a marker that is already there is never written again. A status
 * move is made only while the item really is still in the review status, so a
 * person's change is respected. "Pending" is simply nothing yet: the item stays
 * where it is and a later pass reads everything again.
 *
 * Only two things end an item here. A conclusive finding — the reviewer requested
 * changes, a required check failed, or a post-merge workflow ended
 * unsuccessfully — is reported with the finding and the item returns to the
 * configured To Do status, where the ordinary source consumer may take the next
 * repair attempt. A verified merge whose configured post-merge workflows all
 * succeeded is reported and moved to the configured Done status. Anything else a
 * person has to decide is either reported once as an attention note or left
 * quiet, and the item stays In Review. Nothing here starts a coding turn, and
 * nothing here merges anything.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type {
  CompletionActions,
  CompletionRequest,
  GateFinding,
  GateVerdict,
  MergeVerdict,
  PullRequestSnapshot,
  WorkflowOutcome,
} from '../delivery/completion.js';
import { DeliveryError } from '../delivery/github.js';
import { messageOf } from '../shared/errors.js';
import type { CompletionConfig } from '../shared/types.js';
import type { CompletionRun, SourceCandidate, SourceIo } from './contract.js';
import type { CompletionSource, IssueNote, ReviewItem } from './jira/completion.js';
import { noteWithMarker } from './jira/completion.js';

/** How wide one completion comment line may grow before it is truncated. */
const LINE_LIMIT = 400;

/**
 * How many polling rounds one pass waits for GitHub to finish a merge it was
 * asked for. An item stays In Review while the next pass reads GitHub again, so
 * this bounds one pass, not the merge: the configured deadline is what reports a
 * merge that never finished at all.
 */
const MERGE_WAIT_ROUNDS = 2;

/** What one In Review item ended as. */
export type CompletionStatus =
  /** Merge and post-merge CI verified: comment written, item moved to Done. */
  | 'done'
  /** A conclusive finding: comment written, item returned to To Do. */
  | 'to-do'
  /** Nothing to conclude yet; the item stays In Review. */
  | 'pending'
  /** Something only a person can decide; the item stays In Review. */
  | 'attention'
  /** Nothing needed writing, or the item left review first. */
  | 'observed';

/** One item's outcome in this pass. */
export interface CompletionOutcome {
  readonly ref: { readonly key: string; readonly url: string };
  readonly status: CompletionStatus;
  readonly detail: string;
  /** The comment this pass posted or found, when there is one. */
  readonly commentId: string | null;
}

/** The pass the source command runs after a batch: one bounded scan. */
export interface CompletionPass {
  run(stop: AbortSignal): Promise<readonly CompletionOutcome[]>;
}

/**
 * Where a completion pass finds its items and what it writes through. Every piece
 * is an ordinary function or value, so the self-tests drive the pass with a fake
 * Jira boundary and a stand-in `gh` instead of a live site and repository.
 */
export interface CompletionPassParts {
  /** The validated `delivery.completion` object. */
  readonly config: CompletionConfig;
  /** The delivery selection: where the delivered pull request lives. */
  readonly repository: string;
  readonly baseBranch: string;
  readonly source: CompletionSource;
  readonly actions: CompletionActions;
  /** `<workDir>`: the workspaces, the run logs, and this pass's own evidence. */
  readonly workDir: string;
  readonly io: SourceIo;
  readonly now: () => Date;
  readonly sleep: (ms: number, stop: AbortSignal) => Promise<void>;
}

/** One marker identifies one comment, so a repeated pass finds the same one. */
function markerFor(kind: 'findings' | 'resolution' | 'attention', identity: string): string {
  return `nexus-completion:${kind}:${identity}`;
}

/** One line of text, so nothing a source said can become a second line. */
function oneLine(text: string, limit = LINE_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** The branch a retained workspace's delivered work lives on. */
function branchOf(workspaceId: string): string {
  return `harness/${workspaceId}`;
}

/** Where one item's completion evidence is kept: this pass's own log directory. */
function completionLogsDir(workDir: string, issueId: string): string {
  return path.join(workDir, 'completion-logs', issueId);
}

/**
 * Records the head auto-merge was armed for, beside the item's other evidence.
 * A later pass reads it to name the merge it is waiting for, so a restart after
 * an uncertain write does not have to guess from the current head.
 */
async function recordArmedHead(
  workDir: string,
  issueId: string,
  armed: {
    readonly head: string;
    readonly number: number;
    /** When the item began waiting for GitHub's merge; `null` while none has. */
    readonly waitingSince: string | null;
  },
  now: () => Date,
): Promise<void> {
  const directory = completionLogsDir(workDir, issueId);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, 'completion-armed-head.json');
  const temporary = `${target}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({
      head: armed.head,
      number: armed.number,
      waitingSince: armed.waitingSince,
      at: now().toISOString(),
    })}\n`,
    'utf8',
  );
  await rename(temporary, target);
}

/** What a previous pass recorded when it armed auto-merge, when it recorded one. */
async function readArmedHead(
  workDir: string,
  issueId: string,
): Promise<{
  readonly head: string;
  readonly number: number | null;
  readonly waitingSince: string | null;
} | null> {
  const file = path.join(completionLogsDir(workDir, issueId), 'completion-armed-head.json');
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as {
      head?: unknown;
      number?: unknown;
      waitingSince?: unknown;
    };
    if (typeof value.head !== 'string' || !/^[0-9a-f]{7,40}$/.test(value.head)) {
      return null;
    }
    return {
      head: value.head,
      number: typeof value.number === 'number' ? value.number : null,
      waitingSince: typeof value.waitingSince === 'string' ? value.waitingSince : null,
    };
  } catch {
    return null;
  }
}

/** Records that the item is waiting for GitHub, keeping the moment it began. */
async function rememberWaiting(
  workDir: string,
  issueId: string,
  head: string,
  number: number,
  waitingSince: string | null,
  now: () => Date,
): Promise<void> {
  await recordArmedHead(
    workDir,
    issueId,
    // The moment the item began waiting is kept as it is: `now()` here would
    // push the deadline forward on every pass that reads it back.
    {
      head,
      number,
      waitingSince:
        waitingSince !== null && waitingSince !== '' ? waitingSince : now().toISOString(),
    },
    now,
  );
}

/**
 * The deadline one item's merge wait is measured against: the moment it began
 * waiting, plus the configured deadline. The beginning is what a previous pass
 * recorded, so the deadline is a property of the item, not of one pass.
 */
export function mergeWaitDeadline(
  waitingSince: string | null,
  deadlineSeconds: number,
  at: number,
): number {
  const began = waitingSince === null || waitingSince === '' ? null : Date.parse(waitingSince);
  return (began === null || Number.isNaN(began) ? at : began) + deadlineSeconds * 1000;
}

/** One comment this pass may post. */
interface NoteBody {
  readonly marker: string;
  readonly heading: string;
  readonly lines: readonly string[];
  readonly closing: string;
}

/** Renders one comment: its marker first, then what it says. */
function noteParagraphs(body: NoteBody): readonly string[] {
  return [
    `${body.heading} (${body.marker}, written by the Nexus harness)`,
    ...body.lines,
    body.closing,
  ].filter((paragraph) => paragraph.trim() !== '');
}

/** One finding as the Jira comment says it: the label, what was seen, its link. */
function findingLine(finding: GateFinding): string {
  return `- ${oneLine(finding.label, 80)}: ${oneLine(finding.detail)} ${finding.link}`;
}

/** The findings comment for a pull request that has to go back for repair. */
function findingsNote(
  key: string,
  pull: PullRequestSnapshot,
  reviewedHead: string,
  findings: readonly GateFinding[],
  mergeCommit: string | null,
): NoteBody {
  return {
    marker: markerFor('findings', mergeCommit ?? reviewedHead),
    heading: `${key}: the delivered pull request needs repair`,
    lines: [
      mergeCommit === null
        ? `Pull request ${pull.url} was not merged; it stays open and reviewable.`
        : `Pull request ${pull.url} was merged as ${mergeCommit}; the merge was not rolled back.`,
      ...findings.map(findingLine),
    ],
    closing: 'Returned to To Do for the normal repair consumer; workspace pointer preserved.',
  };
}

/** The comment posted when the merge and its post-merge workflows are verified. */
function resolutionNote(
  item: ReviewItem,
  pull: PullRequestSnapshot,
  mergeCommit: string,
  workflows: readonly WorkflowOutcome[],
  reviewBody: string,
  reviewUrl: string,
): NoteBody {
  const summary = reviewBody.startsWith('Nexus Lens review')
    ? (reviewBody.split(/\r?\n\r?\n/)[1] ?? reviewBody)
    : reviewBody;
  const excerpt = summary.replace(/\s+/g, ' ').trim().split(' ').slice(0, 40).join(' ');
  const links = [
    pull.url,
    reviewUrl,
    ...workflows
      .map((outcome) => outcome.run?.url)
      .filter((url): url is string => url !== undefined),
  ].filter((link) => link !== '');
  return {
    marker: markerFor('resolution', mergeCommit),
    heading: `${item.ref.key}: resolved`,
    lines: [],
    closing:
      `Merged ${oneLine(pull.title || item.title, 120)
        .split(' ')
        .slice(0, 12)
        .join(' ')}. Review summary: ${excerpt}${summary.split(/\s+/).length > 40 ? '…' : ''} ` +
      `Verified Nexus Lens approval and all ${String(workflows.length)} configured post-merge ${pull.baseRefName} workflows succeeded (${workflows
        .slice(0, 3)
        .map((w) => w.identifier)
        .join(
          ', ',
        )}). Verification covers configured CI; scope and limitations follow the linked review. ${links.slice(0, 5).join(' | ')}`,
  };
}

/** The one comment posted when only a person can decide what happens next. */
function attentionNote(
  key: string,
  identity: string,
  reason: string,
  evidence: readonly string[],
): NoteBody {
  return {
    marker: markerFor('attention', identity),
    heading: `${key}: the completion path needs a person`,
    lines: [
      `It stopped because ${oneLine(reason)}`,
      ...evidence.filter((line) => line !== '').map((line) => `- ${oneLine(line)}`),
    ],
    closing:
      'The item stays In Review. Nothing here merged anything — the harness never merges a pull ' +
      'request itself and starts no coding turn — so a person decides what happens next.',
  };
}

/** What one pull request's live evidence says this item should do now. */
type Step =
  | { readonly kind: 'pending'; readonly detail: string }
  | { readonly kind: 'observed'; readonly detail: string }
  | { readonly kind: 'attention'; readonly detail: string; readonly evidence: readonly string[] }
  | {
      readonly kind: 'findings';
      readonly pull: PullRequestSnapshot;
      readonly reviewedHead: string;
      readonly findings: readonly GateFinding[];
      readonly mergeCommit: string | null;
    }
  | {
      readonly kind: 'resolution';
      readonly reviewBody: string;
      readonly reviewUrl: string;
      readonly pull: PullRequestSnapshot;
      readonly mergeCommit: string;
      readonly workflows: readonly WorkflowOutcome[];
    };

/** The live reading of one item's pull request. */
interface PullContext {
  readonly item: ReviewItem;
  readonly request: CompletionRequest;
  readonly pull: PullRequestSnapshot;
}

/**
 * One review-to-completion pass. It is built once per source command and reused
 * for every batch, so its clock and its sleeps are the invocation's own.
 */
export function createCompletionPass(parts: CompletionPassParts): CompletionPass {
  const { config, source, actions, io, now, sleep } = parts;
  const intervalMs = config.pollIntervalSeconds * 1000;

  /** One item's live pull request, or `null` when exactly one open one is not there. */
  /** Where one item's completion reads and writes happen. */
  const requestFor = (item: ReviewItem, workspaceId: string): CompletionRequest => ({
    ref: item.ref,
    workspaceId,
    repository: parts.repository,
    branch: branchOf(workspaceId),
    baseBranch: parts.baseBranch,
    workspacePath: path.join(parts.workDir, 'workspaces', workspaceId),
    logsDir: completionLogsDir(parts.workDir, item.ref.id),
  });

  const contextFor = async (
    item: ReviewItem,
    workspaceId: string,
    stop: AbortSignal,
  ): Promise<PullContext | null> => {
    const request = requestFor(item, workspaceId);
    const pull = await actions.findPullRequest(request, stop);
    return pull === null ? null : { item, request, pull };
  };

  /** The merge and post-merge reading, repeated until it concludes or the deadline passes. */
  const followMerge = async (
    context: PullContext,
    reviewedHead: string,
    stop: AbortSignal,
    waits: number,
  ): Promise<Step> => {
    const { item, request, pull } = context;
    // How long this item has been waiting for GitHub is the one thing that has
    // to survive a pass: it is recorded beside the arm, and read back here, so a
    // merge that never finishes reaches the configured deadline even though a
    // restart begins with a fresh pass.
    const waitingSince = (await readArmedHead(parts.workDir, item.ref.id))?.waitingSince ?? null;
    const deadline = mergeWaitDeadline(waitingSince, config.deadlineSeconds, now().getTime());
    for (let waited = 0; ; waited += 1) {
      if (stop.aborted) return { kind: 'observed', detail: 'Completion was interrupted' };
      const merge: MergeVerdict = await actions.readMerge(request, pull, reviewedHead, stop);
      const approved = await actions.readGate(
        request,
        merge.status === 'pending' ? pull : { ...pull, state: 'MERGED' },
        stop,
      );
      if (merge.status === 'pending' && approved.status === 'failed')
        return {
          kind: 'findings',
          pull,
          reviewedHead,
          findings: approved.findings,
          mergeCommit: null,
        };
      if (
        approved.status === 'attention' ||
        (merge.status !== 'pending' && approved.status !== 'approved')
      )
        return { kind: 'observed', detail: approved.reason };
      if (merge.status === 'complete' && merge.mergeCommit !== null && approved.review !== null) {
        io.out(`${item.ref.key}: ${merge.reason}`);
        return {
          kind: 'resolution',
          reviewBody: approved.review.body,
          reviewUrl: approved.review.url,
          pull,
          mergeCommit: merge.mergeCommit,
          workflows: merge.workflows,
        };
      }
      if (merge.status === 'workflows-unsuccessful') {
        io.out(`${item.ref.key}: ${merge.reason}`);
        return {
          kind: 'findings',
          pull,
          reviewedHead,
          findings: merge.workflows
            .filter((outcome) => outcome.state === 'unsuccessful')
            .map((outcome) => ({
              label: outcome.identifier,
              detail:
                `the post-merge workflow concluded ${outcome.conclusion ?? 'without a conclusion'}` +
                (merge.mergeCommit === null ? '' : ` on merge commit ${merge.mergeCommit}`),
              link: outcome.run?.url ?? pull.url,
            })),
          mergeCommit: merge.mergeCommit,
        };
      }
      io.out(`${item.ref.key}: ${merge.reason}; waiting`);
      const current = await source.readItem({ ref: item.ref, title: item.title }, stop);
      if (current === null) {
        return { kind: 'observed', detail: 'it left In Review while GitHub was still working' };
      }
      // A merge this harness armed may take longer than one pass should hold the
      // intake. Waiting a bounded number of rounds and leaving the item in
      // review is the ordinary answer: the next pass reads GitHub again. The
      // item's own deadline is what turns a still-pending merge into a note for
      // a person.
      if (now().getTime() >= deadline) {
        return {
          kind: 'attention',
          detail:
            'the merge or its configured post-merge workflows were still pending when this ' +
            `item's deadline expired (${merge.reason})`,
          evidence: [pull.url],
        };
      }
      if (waited >= waits) {
        await rememberWaiting(
          parts.workDir,
          item.ref.id,
          reviewedHead,
          pull.number,
          waitingSince,
          now,
        ).catch((cause: unknown) => {
          io.err(
            `${item.ref.key}: how long it has been waiting could not be recorded ` +
              `(${messageOf(cause)}); the next pass reads GitHub again`,
          );
        });
        return { kind: 'pending', detail: merge.reason };
      }
      await sleep(Math.min(intervalMs, Math.max(0, deadline - now().getTime())), stop);
    }
  };

  /** The live step one item is at: the gate first, then the merge and post-merge CI. */
  const decide = async (
    context: PullContext,
    stop: AbortSignal,
    deadline: number,
  ): Promise<Step> => {
    const { item, request, pull } = context;

    // GitHub's own merged state comes first. A pull request this path already
    // armed may be merged by the time the next pass reads it — and a restart
    // finds it merged without any local record — so what decides that item is
    // the merge itself and its post-merge workflows. The reviewer's approval on
    // that same head is still what says the merged commit is the reviewed work.
    const armed = await readArmedHead(parts.workDir, item.ref.id);
    const merged = pull.state.toUpperCase() === 'MERGED';
    if (pull.state.toUpperCase() !== 'OPEN' && !merged) {
      return { kind: 'observed', detail: `pull request ${pull.url} is ${pull.state}, not open` };
    }
    if (merged) {
      let approval: string | null;
      try {
        approval = await actions.readApprovedHead(request, pull, stop);
      } catch (cause) {
        if (cause instanceof DeliveryError) {
          return {
            kind: 'attention',
            detail: `GitHub could not report the reviewer's approval of the merged pull request: ${cause.message}`,
            evidence: [pull.url],
          };
        }
        throw cause;
      }
      if (approval === pull.headRefOid) {
        return await followMerge(context, pull.headRefOid, stop, MERGE_WAIT_ROUNDS);
      }
      return {
        kind: 'observed',
        detail:
          approval === null
            ? `pull request ${pull.url} is merged, but GitHub records no review approving ` +
              `the merged head ${pull.headRefOid}`
            : `pull request ${pull.url} merged head ${pull.headRefOid}, but the reviewer approved ` +
              `${approval}, so the merge is not the reviewed work`,
      };
    }

    if (pull.autoMergeRequest && armed?.head === pull.headRefOid && armed.number === pull.number) {
      return followMerge(context, armed.head, stop, MERGE_WAIT_ROUNDS);
    }

    let gate: GateVerdict;
    try {
      gate = await actions.readGate(request, pull, stop);
    } catch (cause) {
      if (cause instanceof DeliveryError) {
        return {
          kind: 'attention',
          detail: `GitHub could not report the pull request's evidence: ${cause.message}`,
          evidence: [pull.url],
        };
      }
      throw cause;
    }

    if (gate.status === 'attention') {
      return { kind: 'observed', detail: gate.reason };
    }
    if (gate.status === 'pending') {
      if (now().getTime() >= deadline) {
        return {
          kind: 'attention',
          detail:
            "its pull request's checks were still pending when this item's deadline expired " +
            `(${gate.reason})`,
          evidence: [pull.url],
        };
      }
      io.out(`${item.ref.key}: ${gate.reason}; waiting`);
      await sleep(Math.min(intervalMs, Math.max(0, deadline - now().getTime())), stop);
      return await decide(context, stop, deadline);
    }
    if (gate.status === 'failed') {
      return {
        kind: 'findings',
        pull,
        reviewedHead: gate.review?.commitId ?? pull.headRefOid,
        findings: gate.findings,
        mergeCommit: null,
      };
    }

    // The merge this path is responsible for is the one GitHub would make from
    // the head the reviewer's approval names, which is also the head a previous
    // pass recorded when it armed auto-merge.
    const reviewedHead = gate.review?.commitId ?? armed?.head ?? pull.headRefOid;
    // The item is read once more before the one GitHub write this path makes: a
    // person who moved it while the polls were running is respected.
    const current = await source.readItem({ ref: item.ref, title: item.title }, stop);
    if (current === null) {
      return {
        kind: 'observed',
        detail: 'it left In Review before GitHub was asked to arm anything',
      };
    }
    await recordArmedHead(
      parts.workDir,
      item.ref.id,
      // The arm is also the moment this item began waiting for GitHub: the
      // deadline is measured from here, and a later pass keeps this value. An
      // earlier pass's value is kept as it is, so re-arming an already-armed
      // pull request never moves the item's own deadline.
      {
        head: reviewedHead,
        number: pull.number,
        waitingSince:
          armed?.head === reviewedHead && armed.number === pull.number
            ? (armed.waitingSince ?? now().toISOString())
            : now().toISOString(),
      },
      now,
    );
    try {
      await actions.enableAutoMerge(request, pull, reviewedHead, stop, async () => {
        const fresh = await source.readItem({ ref: item.ref, title: item.title }, stop);
        return (
          fresh !== null && fresh.pointers.length === 1 && fresh.pointers[0] === request.workspaceId
        );
      });
    } catch (cause) {
      return {
        kind: 'attention',
        detail:
          `GitHub did not enable auto-merge (${messageOf(cause)}); the item stays In Review and ` +
          'nothing is assumed about the merge',
        evidence: [pull.url],
      };
    }
    io.out(
      `${item.ref.key}: auto-merge enabled for ${pull.url} at approved head ${reviewedHead}; ` +
        'GitHub merges it once its branch protection allows it',
    );
    return await followMerge(context, reviewedHead, stop, MERGE_WAIT_ROUNDS);
  };

  /** Posts one comment unless the thread already carries its marker. */
  const writeComment = async (
    item: ReviewItem,
    body: NoteBody,
    notes: readonly IssueNote[],
    stop: AbortSignal,
  ): Promise<{ readonly commentId: string | null; readonly existed: boolean }> => {
    const existing = noteWithMarker(notes, body.marker);
    if (existing !== null) {
      return { commentId: existing.id, existed: true };
    }
    try {
      const commentId = await source.postComment(item.ref.id, noteParagraphs(body), stop);
      return { commentId, existed: false };
    } catch (cause) {
      // An uncertain write is settled by reading the thread again: a comment that
      // arrived is found by its marker, and one that did not is reported.
      const again = await source
        .listComments(item.ref.id, stop)
        .catch(() => null as readonly IssueNote[] | null);
      const found = again === null ? null : noteWithMarker(again, body.marker);
      if (found !== null) {
        return { commentId: found.id, existed: true };
      }
      throw cause;
    }
  };

  /**
   * Writes the one comment a step calls for — unless the thread already holds
   * it — and makes the status move that follows. This is the only place a
   * completion comment or move happens, for a live step and for the merge a
   * restart found by number alike.
   */
  const recordStep = async (
    item: ReviewItem,
    _notes: readonly IssueNote[],
    step: Step,
    stop: AbortSignal,
    context: PullContext,
  ): Promise<CompletionOutcome> => {
    const { ref } = item;
    if (step.kind === 'observed' || step.kind === 'pending') {
      return {
        ref,
        status: step.kind === 'pending' ? 'pending' : 'observed',
        detail: step.detail,
        commentId: null,
      };
    }
    const body =
      step.kind === 'resolution'
        ? resolutionNote(
            item,
            step.pull,
            step.mergeCommit,
            step.workflows,
            step.reviewBody,
            step.reviewUrl,
          )
        : step.kind === 'findings'
          ? findingsNote(ref.key, step.pull, step.reviewedHead, step.findings, step.mergeCommit)
          : attentionNote(ref.key, step.evidence[0] ?? ref.url, step.detail, step.evidence);

    const guard = async (): Promise<boolean> => {
      if (stop.aborted) return false;
      const currentItem = await source.readItem({ ref, title: item.title }, stop);
      if (
        currentItem === null ||
        currentItem.pointers.length !== 1 ||
        currentItem.pointers[0] !== context.request.workspaceId
      )
        return false;
      if (step.kind === 'resolution' || (step.kind === 'findings' && step.mergeCommit !== null)) {
        const approval = await actions.readApprovedHead(context.request, context.pull, stop);
        if (approval !== context.pull.headRefOid) return false;
        const merge = await actions.readMerge(context.request, context.pull, approval, stop);
        if (
          merge.mergeCommit !== step.mergeCommit ||
          merge.status !== (step.kind === 'resolution' ? 'complete' : 'workflows-unsuccessful')
        )
          return false;
      } else if (step.kind === 'findings') {
        if ((await actions.readGate(context.request, context.pull, stop)).status !== 'failed')
          return false;
      }
      const live = await actions.findMergedPullRequest(context.request, context.pull.number, stop);
      return (
        live.number === context.pull.number &&
        live.headRefOid === context.pull.headRefOid &&
        live.baseRefName === context.request.baseBranch &&
        live.headRefName === context.request.branch
      );
    };
    const freshNotes = await source.listComments(ref.id, stop);
    const existing = noteWithMarker(freshNotes, body.marker);
    if (existing !== null && (await source.leftReviewSince(ref.id, existing.createdAt, stop)))
      return {
        ref,
        status: 'observed',
        detail: 'Ticket was reopened after this outcome; a different resolution is required',
        commentId: existing.id,
      };
    if (!(await guard()))
      return {
        ref,
        status: 'observed',
        detail: 'Ticket, head or completion evidence changed; nothing written',
        commentId: null,
      };
    let written: { readonly commentId: string | null; readonly existed: boolean };
    try {
      written = await writeComment(item, body, freshNotes, stop);
    } catch (cause) {
      return {
        ref,
        status: 'attention',
        detail: `the comment could not be confirmed on the issue, so nothing was moved: ${messageOf(cause)}`,
        commentId: null,
      };
    }
    if (!written.existed) {
      io.out(`${ref.key}: comment ${written.commentId ?? 'posted'} published (${step.kind})`);
    }

    if (step.kind === 'attention') {
      // The note is the whole outcome: the item stays In Review for a person.
      return { ref, status: 'attention', detail: step.detail, commentId: written.commentId };
    }
    const target = step.kind === 'resolution' ? config.doneStatus : config.toDoStatus;
    try {
      const moved = await source.moveTo(item.ref.id, target, stop, guard);
      if (moved === 'left-alone') {
        return {
          ref,
          status: 'observed',
          detail: `it left In Review before it could be moved to "${target}", so nothing was changed`,
          commentId: written.commentId,
        };
      }
    } catch (cause) {
      return {
        ref,
        status: 'attention',
        detail:
          `the comment is on the issue but moving it to "${target}" failed: ${messageOf(cause)}; ` +
          'the comment will not be written twice and the move is retried on the next pass',
        commentId: written.commentId,
      };
    }
    return {
      ref,
      status: step.kind === 'resolution' ? 'done' : 'to-do',
      detail:
        step.kind === 'resolution'
          ? `verified merge ${step.mergeCommit} and every configured post-merge workflow; moved to "${target}"`
          : `findings published and moved back to "${target}" with the workspace pointer preserved`,
      commentId: written.commentId,
    };
  };

  /** One item: read it, decide, and make at most the moves the reading allows. */
  const handle = async (
    candidate: SourceCandidate,
    stop: AbortSignal,
  ): Promise<CompletionOutcome> => {
    const item = await source.readItem(candidate, stop);
    if (item === null) {
      return {
        ref: candidate.ref,
        status: 'observed',
        detail: 'it is no longer In Review, so nothing was touched',
        commentId: null,
      };
    }
    const { ref } = item;
    if (item.pointers.length !== 1) {
      return {
        ref,
        status: 'observed',
        detail:
          item.pointers.length === 0
            ? 'it has no workspace pointer, so this path will not act on it'
            : `it carries ${String(item.pointers.length)} workspace pointers, so which workspace produced the work is ambiguous`,
        commentId: null,
      };
    }
    const workspaceId = item.pointers[0] ?? '';

    // Refuse an unreadable thread before considering mutations. A comment is
    // deduplication evidence only; the live GitHub gates are always read again.
    let notes: readonly IssueNote[];
    try {
      notes = await source.listComments(item.ref.id, stop);
    } catch (cause) {
      return {
        ref,
        status: 'observed',
        detail: `its thread could not be read, so nothing was written: ${messageOf(cause)}`,
        commentId: null,
      };
    }
    const thread = notes;

    let context: PullContext | null;
    try {
      context = await contextFor(item, workspaceId, stop);
    } catch (cause) {
      return {
        ref,
        status: 'attention',
        detail: `GitHub could not be read: ${messageOf(cause)}`,
        commentId: null,
      };
    }
    if (context === null) {
      // No open pull request matches the delivered branch. When a previous pass
      // armed auto-merge, GitHub may have merged it and taken it out of that
      // list: that pull request is read by number, and only the merge and its
      // post-merge workflows decide this item from here.
      const armed = await readArmedHead(parts.workDir, item.ref.id);
      if (armed?.number !== null && armed?.number !== undefined) {
        const request = requestFor(item, workspaceId);
        try {
          const merged = await actions.findMergedPullRequest(request, armed.number, stop);
          if (
            merged.state.toUpperCase() === 'MERGED' &&
            merged.headRefOid === armed.head &&
            merged.headRefName === request.branch &&
            merged.baseRefName === request.baseBranch &&
            (await actions.readApprovedHead(request, merged, stop)) === armed.head
          ) {
            const follow = await followMerge(
              { item, request, pull: merged },
              armed.head,
              stop,
              MERGE_WAIT_ROUNDS,
            );
            return await recordStep(item, thread, follow, stop, { item, request, pull: merged });
          }
        } catch (cause) {
          return {
            ref,
            status: 'attention',
            detail: `GitHub could not be read for the merge this pass armed: ${messageOf(cause)}`,
            commentId: null,
          };
        }
      }
      return {
        ref,
        status: 'observed',
        detail:
          'no single open delivered pull request matches its recorded workspace branch, so nothing ' +
          'was armed and nothing was marked',
        commentId: null,
      };
    }

    let step: Step;
    try {
      step = await decide(context, stop, now().getTime() + config.deadlineSeconds * 1000);
    } catch (cause) {
      if (cause instanceof DeliveryError) {
        return {
          ref,
          status: 'attention',
          detail: `GitHub could not be read: ${cause.message}`,
          commentId: null,
        };
      }
      throw cause;
    }
    try {
      return await recordStep(item, thread, step, stop, context);
    } catch (cause) {
      return {
        ref,
        status: 'attention',
        detail: `Completion evidence changed or could not be read: ${messageOf(cause)}`,
        commentId: null,
      };
    }
  };

  // The logical polling deadline survives passes; this wall-clock bound also stops a
  // hung GitHub/Jira read. A separate short feedback budget can report that expiry.
  const reportDeadline = async (
    candidate: SourceCandidate,
    stop: AbortSignal,
  ): Promise<CompletionOutcome> => {
    const item = await source.readItem(candidate, stop);
    if (item === null || item.pointers.length !== 1)
      return {
        ref: candidate.ref,
        status: 'observed',
        detail: 'Ticket left In Review',
        commentId: null,
      };
    const request = requestFor(item, item.pointers[0] ?? '');
    const admitted = await readArmedHead(parts.workDir, item.ref.id);
    const pull =
      admitted?.number == null
        ? await actions.findPullRequest(request, stop)
        : await actions.findMergedPullRequest(request, admitted.number, stop);
    if (pull === null)
      return {
        ref: candidate.ref,
        status: 'attention',
        detail: 'Completion deadline expired without identifiable PR evidence',
        commentId: null,
      };
    return recordStep(
      item,
      [],
      {
        kind: 'attention',
        detail: 'the bounded completion deadline expired without a verified outcome',
        evidence: [pull.url],
      },
      stop,
      { item, request, pull },
    );
  };

  return {
    async run(stop) {
      const candidates = await source.listReview(stop);
      const outcomes: CompletionOutcome[] = [];
      for (const candidate of candidates) {
        if (stop.aborted) {
          break;
        }
        const deadline = new AbortController();
        const timer = setTimeout(
          () => deadline.abort(new Error('Completion deadline expired')),
          config.deadlineSeconds * 1000,
        );
        let outcome: CompletionOutcome;
        try {
          outcome = await handle(candidate, AbortSignal.any([stop, deadline.signal]));
        } catch (cause) {
          if (!deadline.signal.aborted) throw cause;
          outcome = {
            ref: candidate.ref,
            status: 'attention',
            detail: 'Completion deadline expired',
            commentId: null,
          };
        } finally {
          clearTimeout(timer);
        }
        if (deadline.signal.aborted && !stop.aborted) {
          outcome = await reportDeadline(
            candidate,
            AbortSignal.any([stop, AbortSignal.timeout(10_000)]),
          ).catch(() => ({
            ref: candidate.ref,
            status: 'attention' as const,
            detail: 'Completion deadline expired; attention comment could not be confirmed',
            commentId: null,
          }));
        }
        outcomes.push(outcome);
      }
      return outcomes;
    },
  };
}

/**
 * One completion pass over the source's own In Review queue, with everything it
 * decided printed and counted. A failure here never becomes a coding failure:
 * the pass reports what it could not read and the intake keeps its own outcome.
 */
export function createCompletionRun(pass: CompletionPass, io: SourceIo): CompletionRun {
  return {
    async run(stop) {
      let outcomes: readonly CompletionOutcome[];
      try {
        outcomes = await pass.run(stop);
      } catch (cause) {
        return { done: 0, toDo: 0, attention: 0, observed: 0, problem: messageOf(cause) };
      }
      let done = 0;
      let toDo = 0;
      let attention = 0;
      let observed = 0;
      for (const outcome of outcomes) {
        const at = `${outcome.ref.key}: `;
        switch (outcome.status) {
          case 'done':
            done += 1;
            io.out(`${at}completed: ${outcome.detail}`);
            break;
          case 'to-do':
            toDo += 1;
            io.out(`${at}returned for repair: ${outcome.detail}`);
            break;
          case 'attention':
            attention += 1;
            io.err(`${at}needs a person: ${outcome.detail}`);
            break;
          default:
            observed += 1;
            io.out(`${at}left In Review: ${outcome.detail}`);
            break;
        }
      }
      return { done, toDo, attention, observed, problem: null };
    },
  };
}
