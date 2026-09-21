/**
 * The small review-to-completion pass: one bounded scan of the In Review items
 * that carry a workspace pointer, and for each of them one deterministic
 * handling built only from live GitHub and Jira state.
 *
 * Native auto-merge is armed before the reviewer publishes the final required
 * check: the queue arms the newly delivered or updated pull request first, so
 * GitHub is never asked to arm a pull request whose status has just turned
 * clean. A local admission records only the PR/head and deadline, never its
 * outcome.
 *
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
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type {
  AutoMergeStatus,
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
import type { CompletionConfig, SourceRef } from '../shared/types.js';
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
  /**
   * The merge commit this outcome is about, when the pass concluded a pull
   * request GitHub had already merged; `null` (or absent) otherwise. The serial
   * queue loop names the base a next workspace starts from with it
   * (docs/WORKFLOW.md §11).
   */
  readonly mergeCommit?: string | null;
}

/** The pass the source command runs after a batch: one bounded scan. */
export interface CompletionPass {
  run(stop: AbortSignal): Promise<readonly CompletionOutcome[]>;
  /**
   * Ask GitHub to enable native auto-merge for the current open pull request of
   * the item this pass is scoped to, before the queue's review phase can publish
   * the final required check. Re-running this against an already armed head is
   * a verified no-op; a new head is re-armed.
   */
  arm(stop: AbortSignal): Promise<readonly ArmOutcome[]>;
}

/** What one attempt to arm native auto-merge did for one item. */
export type ArmStatus =
  /** Native auto-merge is enabled for the recorded pull request and head. */
  | 'armed'
  /** There is no open pull request to arm; completion verifies any admitted merge. */
  | 'observed'
  /** GitHub refused the request, or the evidence could not be recorded. */
  | 'attention';

/** One item's arm outcome, as the queue loop reads it. */
export interface ArmOutcome {
  readonly ref: { readonly key: string; readonly url: string };
  readonly status: ArmStatus;
  readonly detail: string;
  /** The head the verified request covers, when one is recorded. */
  readonly head?: string | null;
  /** The pull request number the verified request covers, when one is recorded. */
  readonly number?: number | null;
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
  /**
   * Pass only this ticket, when the caller named one. The serial queue loop
   * completes exactly the ticket it is carrying, so a pass can never move,
   * comment on, or arm auto-merge for another In Review item
   * (docs/WORKFLOW.md §11). Absent means every In Review item of the configured
   * queue, exactly as before.
   */
  readonly only?: SourceRef;
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
export function completionLogsDir(
  workDir: string,
  ref: Pick<SourceRef, 'type' | 'scope' | 'id'>,
  repository: string,
): string {
  const identity = createHash('sha256')
    .update(JSON.stringify([ref.type, ref.scope, ref.id, repository.toLowerCase()]), 'utf8')
    .digest('hex');
  return path.join(workDir, 'completion-logs', identity);
}

/**
 * Creates one item's completion evidence directory before the first GitHub
 * command needs it, and names the location when it cannot be created. Every
 * command this pass runs writes its stdout and stderr files under that
 * directory, and a command whose directory is missing fails before it can read
 * anything: a fresh pass, or a restart after an earlier one stopped, begins with
 * no directory at all. Nothing is armed and nothing is written in Jira when this
 * fails; the caller reports the location and stops for a person.
 */
async function ensureCompletionLogsDir(
  workDir: string,
  ref: SourceRef,
  repository: string,
): Promise<{ readonly ready: true } | { readonly ready: false; readonly problem: string }> {
  const directory = completionLogsDir(workDir, ref, repository);
  // Older records name only a site-local issue ID, with no source or repository
  // identity. Never adopt them or silently reset their restart deadline.
  const legacy = path.join(workDir, 'completion-logs', ref.id);
  try {
    await lstat(legacy);
    return {
      ready: false,
      problem:
        `legacy completion evidence at "${legacy}" records no source or repository identity; ` +
        'inspect its ownership and reconcile it by hand before moving it aside and retrying. ' +
        'No GitHub command was run, auto-merge was not armed, and Jira was not changed',
    };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // If the parent is a file, mkdir below reports the unusable evidence
    // directory consistently on Windows (ENOENT) and POSIX (ENOTDIR).
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return {
        ready: false,
        problem: `legacy completion evidence "${legacy}" could not be inspected: ${messageOf(cause)}`,
      };
    }
  }
  try {
    await mkdir(directory, { recursive: true });
    return { ready: true };
  } catch (cause) {
    return {
      ready: false,
      problem:
        `its completion evidence directory "${directory}" could not be created ` +
        `(${messageOf(cause)}); no GitHub command was run, auto-merge was not armed, and its ` +
        'Jira status was not changed',
    };
  }
}

/**
 * Records the PR/head admitted for an auto-merge request before contacting
 * GitHub. This is recovery identity, not proof that the request succeeded:
 * live GitHub evidence must establish the arm or the actual reviewed merge.
 */
async function recordArmedHead(
  directory: string,
  armed: {
    readonly head: string;
    readonly number: number;
    /** When the item began waiting for GitHub's merge; `null` while none has. */
    readonly waitingSince: string | null;
  },
  now: () => Date,
): Promise<void> {
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

/** The PR/head a previous pass admitted for auto-merge, when it recorded one. */
async function readArmedHead(directory: string): Promise<{
  readonly head: string;
  readonly number: number | null;
  readonly waitingSince: string | null;
} | null> {
  const file = path.join(directory, 'completion-armed-head.json');
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
  directory: string,
  head: string,
  number: number,
  waitingSince: string | null,
  now: () => Date,
): Promise<void> {
  await recordArmedHead(
    directory,
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
  /**
   * A settled state this path may not act past: the pull request was closed
   * without a merge, it no longer carries the reviewed head, or GitHub merged a
   * result the reviewer's approval does not cover. It is never retried, never
   * read as success, and is reported to a person with its evidence.
   */
  | { readonly kind: 'unresolved'; readonly detail: string }
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

/** What one fresh reading of a pull request settled, against the expected delivery. */
type FreshReading =
  /** GitHub merged this exact pull request at the expected reviewed head. */
  | { readonly kind: 'merged'; readonly pull: PullRequestSnapshot }
  /** The pull request is still open at the expected head. */
  | { readonly kind: 'open'; readonly pull: PullRequestSnapshot }
  /** GitHub closed it without a merge: never a completion. */
  | { readonly kind: 'closed'; readonly pull: PullRequestSnapshot }
  /** It is no longer the reviewed delivery: another pull request, base, branch or head. */
  | { readonly kind: 'changed'; readonly detail: string };

/** What one attempt to arm the current pull request concluded. */
type Arming =
  | {
      readonly kind: 'armed';
      readonly head: string;
      readonly number: number;
      readonly detail: string;
    }
  /**
   * GitHub merged the reviewed head while the arm request was in flight: there
   * is no request to verify and no second request to make, and the merge is
   * what the completion path verifies next.
   */
  | {
      readonly kind: 'merged';
      readonly head: string;
      readonly number: number;
      readonly detail: string;
    }
  | {
      readonly kind: 'attention';
      readonly detail: string;
      readonly evidence: readonly string[];
    };

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
    logsDir: completionLogsDir(parts.workDir, item.ref, parts.repository),
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

  /**
   * One GitHub read the completion path repeats while GitHub's own failure is
   * transient and the item's deadline has not passed: a `5xx`, a rate limit, a
   * timeout or an answer that never arrived leaves the state indeterminate, so
   * it is read again with the configured interval as backoff. A refusal GitHub
   * meant, a malformed answer, or a read the deadline stops is thrown as it
   * came. Mutation requests are never repeated: only reads are reconciled.
   */
  const readEvidence = async <T>(
    item: ReviewItem,
    stop: AbortSignal,
    deadline: number,
    read: () => Promise<T>,
  ): Promise<T> => {
    for (;;) {
      try {
        return await read();
      } catch (cause) {
        if (
          !(cause instanceof DeliveryError) ||
          !cause.retryable ||
          stop.aborted ||
          now().getTime() >= deadline
        )
          throw cause;
        io.out(
          `${item.ref.key}: GitHub's answer was indeterminate (${oneLine(cause.message, 200)}); ` +
            'reading it again within the deadline',
        );
        await sleep(Math.min(intervalMs, Math.max(0, deadline - now().getTime())), stop);
        if (stop.aborted) throw cause;
      }
    }
  };

  /**
   * One fresh reading of one pull request, by number, against the identity this
   * pass works with. It is what settles an ambiguous answer or a request whose
   * response was lost: GitHub's own merged state at the expected reviewed head
   * is the only reading that continues the merge path, and a closed, moved or
   * replaced pull request is a settled state this path may not act past.
   */
  const readFresh = async (
    item: ReviewItem,
    request: CompletionRequest,
    expected: { readonly number: number; readonly head: string; readonly url?: string },
    stop: AbortSignal,
    deadline: number,
  ): Promise<FreshReading> => {
    const fresh = await readEvidence(item, stop, deadline, () =>
      actions.findMergedPullRequest(request, expected.number, stop),
    );
    if (
      fresh.number !== expected.number ||
      (expected.url !== undefined && fresh.url !== expected.url)
    )
      return {
        kind: 'changed',
        detail:
          `GitHub now reports ${fresh.url} where the pass read pull request ` +
          `${expected.url ?? String(expected.number)}`,
      };
    if (fresh.headRefName !== request.branch || fresh.baseRefName !== request.baseBranch)
      return {
        kind: 'changed',
        detail:
          `${fresh.url} now carries ${fresh.headRefName} into ${fresh.baseRefName}, not ` +
          `${request.branch} into ${request.baseBranch}`,
      };
    if (fresh.headRefOid !== expected.head)
      return {
        kind: 'changed',
        detail:
          `${fresh.url} now holds head ${fresh.headRefOid}, not the expected reviewed head ` +
          `${expected.head}`,
      };
    const state = fresh.state.toUpperCase();
    if (state === 'MERGED') return { kind: 'merged', pull: fresh };
    if (state === 'CLOSED') return { kind: 'closed', pull: fresh };
    return { kind: 'open', pull: fresh };
  };

  /**
   * The explicit failure one settled state leaves. Nothing here is retried and
   * nothing is read as success: the item stays In Review, nothing is armed,
   * written or moved, and the evidence names what a person has to decide on.
   */
  const settledFailure = (
    settled: Extract<FreshReading, { kind: 'closed' | 'changed' }>,
    expectedHead: string,
  ): string =>
    settled.kind === 'closed'
      ? `pull request ${settled.pull.url} is closed without a verified merge of the reviewed ` +
        `head ${expectedHead}, so this work cannot be completed; nothing was armed, written or ` +
        'moved, and this state is not retried'
      : `${settled.detail}, so it is no longer the reviewed delivery head ${expectedHead}; ` +
        'nothing was armed, written or moved, and no merge will be tied to it';

  /**
   * The explicit failure a merge leaves when the reviewer's approval does not
   * cover it: GitHub has already merged, so nothing is rolled back, and the
   * merged result is not this completion path's to mark done.
   */
  const mergeNotTied = (
    pull: PullRequestSnapshot,
    expectedHead: string,
    why: string,
    mergeCommit: string | null,
  ): string =>
    `pull request ${pull.url} is merged${mergeCommit === null ? '' : ` as ${mergeCommit}`} but ` +
    `cannot be tied to the reviewed head ${expectedHead}: ${oneLine(why, 200)}. Nothing was ` +
    'rolled back, written or moved, and Nexus does not assume this merge is the reviewed work';

  /**
   * Makes sure GitHub holds a native auto-merge request for the open pull
   * request's current head, before the reviewer's check can make the pull
   * request clean. A request already enabled for this exact pull request is
   * verified for the head GitHub holds now; a delivered repair's new head is
   * re-armed. The local admission is persisted before the request, so a lost
   * response or failed verification read cannot lose a merge's identity. A
   * restart still verifies the arm or merge from GitHub. The merge-wait start
   * is written only when completion first sees the approved head still awaiting
   * its merge, so a long review does not consume the merge deadline.
   */
  const ensureArmed = async (
    context: PullContext,
    stop: AbortSignal,
    wait: { readonly beginsHere: boolean },
  ): Promise<Arming> => {
    const { item, request, pull } = context;
    const head = pull.headRefOid;
    const previous = await readArmedHead(
      completionLogsDir(parts.workDir, item.ref, parts.repository),
    );
    if (pull.autoMergeRequest && previous?.number === pull.number && previous.head === head) {
      return {
        kind: 'armed',
        head,
        number: pull.number,
        detail: `native auto-merge is already enabled for ${pull.url} at head ${head}`,
      };
    }

    try {
      // Persist intent before the remote mutation: GitHub can accept it and
      // merge even if the response or subsequent verification read is lost.
      // A failed local write must therefore prevent the remote request.
      // The arm is not necessarily the moment the item begins waiting for a
      // merge: in the queue it is armed before the review runs, and the wait
      // starts when the completion pass first finds an approved head whose
      // merge is still pending. A later pass preserves what is recorded here.
      const inherited =
        previous?.number === pull.number && previous.head === head ? previous.waitingSince : null;
      const waitingSince =
        inherited !== null && inherited !== ''
          ? inherited
          : wait.beginsHere
            ? now().toISOString()
            : null;
      await recordArmedHead(
        request.logsDir,
        {
          head,
          number: pull.number,
          waitingSince,
        },
        now,
      );
    } catch (cause) {
      return {
        kind: 'attention',
        detail:
          `the pull request/head record could not be written for ${pull.url} at head ${head} ` +
          `(${messageOf(cause)}); auto-merge was not requested and the item stays In Review`,
        evidence: [pull.url],
      };
    }

    let status: AutoMergeStatus;
    try {
      status = await actions.enableAutoMerge(request, pull, head, stop, async () => {
        const fresh = await source.readItem({ ref: item.ref, title: item.title }, stop);
        return (
          fresh !== null && fresh.pointers.length === 1 && fresh.pointers[0] === request.workspaceId
        );
      });
    } catch (cause) {
      return {
        kind: 'attention',
        detail:
          `GitHub did not confirm auto-merge for ${pull.url} at head ${head}: ` +
          `${messageOf(cause)}; the admission is retained for verification on restart; ` +
          'the item stays In Review and no merge is assumed',
        evidence: [pull.url],
      };
    }

    if (status === 'merged')
      return {
        kind: 'merged',
        head,
        number: pull.number,
        detail:
          `GitHub merged ${pull.url} at head ${head} while native auto-merge was being requested; ` +
          'no request is re-sent and the merge itself is verified from here',
      };
    return {
      kind: 'armed',
      head,
      number: pull.number,
      detail:
        `native auto-merge ${status === 'already-enabled' ? 'already enabled' : 'enabled'} for ` +
        `${pull.url} at head ${head}; GitHub merges it only when branch protection allows`,
    };
  };

  /** The merge and post-merge reading, repeated until it concludes or the deadline passes. */
  const followMerge = async (
    context: PullContext,
    reviewedHead: string,
    stop: AbortSignal,
    waits: number,
  ): Promise<Step> => {
    const { item, request } = context;
    let pull = context.pull;
    // How long this item has been waiting for GitHub is the one thing that has
    // to survive a pass: it is recorded beside the arm, and read back here, so a
    // merge that never finishes reaches the configured deadline even though a
    // restart begins with a fresh pass.
    const waitingSince =
      (await readArmedHead(completionLogsDir(parts.workDir, item.ref, parts.repository)))
        ?.waitingSince ?? null;
    const deadline = mergeWaitDeadline(waitingSince, config.deadlineSeconds, now().getTime());
    for (let waited = 0; ; waited += 1) {
      if (stop.aborted) return { kind: 'observed', detail: 'Completion was interrupted' };
      const merge: MergeVerdict = await readEvidence(item, stop, deadline, () =>
        actions.readMerge(request, pull, reviewedHead, stop),
      );
      const approved: GateVerdict = await readEvidence(item, stop, deadline, () =>
        actions.readGate(
          request,
          merge.status === 'pending' ? pull : { ...pull, state: 'MERGED' },
          stop,
        ),
      );
      if (merge.status === 'pending' && approved.status === 'failed')
        return {
          kind: 'findings',
          pull,
          reviewedHead,
          findings: approved.findings,
          mergeCommit: null,
        };
      if (approved.status === 'attention') {
        // The verdict can be older than a merge: GitHub may have merged the
        // reviewed head between the merge read and the gate read, and such a
        // verdict would otherwise read as "not eligible for completion". One
        // fresh reading settles which of the two it is; only a merge of this
        // exact reviewed head continues the merge path.
        if (pull.state.toUpperCase() === 'MERGED')
          return {
            kind: 'unresolved',
            detail: mergeNotTied(pull, reviewedHead, approved.reason, merge.mergeCommit),
          };
        const fresh = await readFresh(
          item,
          request,
          { number: pull.number, head: reviewedHead, url: pull.url },
          stop,
          deadline,
        );
        if (fresh.kind === 'merged') {
          io.out(`${item.ref.key}: ${fresh.pull.url} merged while its evidence was read`);
          pull = fresh.pull;
          continue;
        }
        if (fresh.kind !== 'open')
          return { kind: 'unresolved', detail: settledFailure(fresh, reviewedHead) };
        return { kind: 'observed', detail: approved.reason };
      }
      if (merge.status !== 'pending' && approved.status !== 'approved')
        return {
          kind: 'unresolved',
          detail: mergeNotTied(pull, reviewedHead, approved.reason, merge.mergeCommit),
        };
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
        await rememberWaiting(request.logsDir, reviewedHead, pull.number, waitingSince, now).catch(
          (cause: unknown) => {
            io.err(
              `${item.ref.key}: how long it has been waiting could not be recorded ` +
                `(${messageOf(cause)}); the next pass reads GitHub again`,
            );
          },
        );
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
    // admitted may be merged by the time the next pass reads it, even if the
    // auto-merge response was lost — so what decides that item is
    // the merge itself and its post-merge workflows. The reviewer's approval on
    // that same head is still what says the merged commit is the reviewed work.
    const armed = await readArmedHead(completionLogsDir(parts.workDir, item.ref, parts.repository));
    const merged = pull.state.toUpperCase() === 'MERGED';
    if (pull.state.toUpperCase() !== 'OPEN' && !merged) {
      return {
        kind: 'unresolved',
        detail:
          `pull request ${pull.url} is ${pull.state}, neither open nor merged, so nothing here ` +
          'can be armed, verified or marked done',
      };
    }
    if (merged) {
      let approval: string | null;
      try {
        approval = await readEvidence(item, stop, deadline, () =>
          actions.readApprovedHead(request, pull, stop),
        );
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
        kind: 'unresolved',
        detail: mergeNotTied(
          pull,
          pull.headRefOid,
          approval === null
            ? 'GitHub records no review approving the merged head'
            : `the reviewer approved ${approval}, not the merged head`,
          pull.mergeCommit?.oid ?? null,
        ),
      };
    }

    if (pull.autoMergeRequest && armed?.head === pull.headRefOid && armed.number === pull.number) {
      return followMerge(context, armed.head, stop, MERGE_WAIT_ROUNDS);
    }

    let gate: GateVerdict;
    try {
      gate = await readEvidence(item, stop, deadline, () => actions.readGate(request, pull, stop));
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
      // The verdict can be older than a merge: GitHub may have merged the
      // reviewed pull request between the read that produced it and this
      // answer, which is exactly how the completion path used to stop on a
      // successful merge. One fresh reading settles which it is.
      const fresh = await readFresh(
        item,
        request,
        { number: pull.number, head: pull.headRefOid, url: pull.url },
        stop,
        deadline,
      );
      if (fresh.kind === 'merged') {
        io.out(
          `${item.ref.key}: ${fresh.pull.url} was merged while its evidence was read; ` +
            'verifying that merge',
        );
        return await followMerge(
          { item, request, pull: fresh.pull },
          pull.headRefOid,
          stop,
          MERGE_WAIT_ROUNDS,
        );
      }
      if (fresh.kind !== 'open')
        return { kind: 'unresolved', detail: settledFailure(fresh, pull.headRefOid) };
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
    // the head the reviewer's approval names. The queue arms that head before
    // the review runs; a completion pass that reads an unarmed approved pull
    // request (a standalone source command, or a restart without the queue's
    // arm step) still tries here, and GitHub's own refusal is reported.
    const arming = await ensureArmed(context, stop, { beginsHere: true });
    if (arming.kind === 'attention') {
      return { kind: 'attention', detail: arming.detail, evidence: arming.evidence };
    }
    io.out(`${item.ref.key}: ${arming.detail}`);
    return await followMerge(context, arming.head, stop, MERGE_WAIT_ROUNDS);
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
        status: step.kind,
        detail: step.detail,
        commentId: null,
      };
    }
    if (step.kind === 'unresolved') {
      // A settled state this path may not act past: reported for a person, with
      // no comment (nothing about it is a completion) and nothing retried.
      return { ref, status: 'attention', detail: step.detail, commentId: null };
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
      // The verify-before-write reads are reads like any other: a transient
      // GitHub failure is retried inside the item deadline instead of turning
      // into a reason to stop for a person.
      const until = now().getTime() + config.deadlineSeconds * 1000;
      const currentItem = await source.readItem({ ref, title: item.title }, stop);
      if (
        currentItem === null ||
        currentItem.pointers.length !== 1 ||
        currentItem.pointers[0] !== context.request.workspaceId
      )
        return false;
      if (step.kind === 'resolution' || (step.kind === 'findings' && step.mergeCommit !== null)) {
        const approval = await readEvidence(item, stop, until, () =>
          actions.readApprovedHead(context.request, context.pull, stop),
        );
        if (approval !== context.pull.headRefOid) return false;
        const merge = await readEvidence(item, stop, until, () =>
          actions.readMerge(context.request, context.pull, approval, stop),
        );
        if (
          merge.mergeCommit !== step.mergeCommit ||
          merge.status !== (step.kind === 'resolution' ? 'complete' : 'workflows-unsuccessful')
        )
          return false;
      } else if (step.kind === 'findings') {
        const gate = await readEvidence(item, stop, until, () =>
          actions.readGate(context.request, context.pull, stop),
        );
        if (gate.status !== 'failed') return false;
      }
      const live = await readEvidence(item, stop, until, () =>
        actions.findMergedPullRequest(context.request, context.pull.number, stop),
      );
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
    // The merge commit this outcome is about, when the step concluded one: a
    // resolution always names it, and a findings step names it when the pull
    // request GitHub already merged is what went back for repair.
    const mergeCommit = step.mergeCommit;
    const target = step.kind === 'resolution' ? config.doneStatus : config.toDoStatus;
    try {
      const moved = await source.moveTo(item.ref.id, target, stop, guard);
      if (moved === 'left-alone') {
        return {
          ref,
          status: 'observed',
          detail: `it left In Review before it could be moved to "${target}", so nothing was changed`,
          commentId: written.commentId,
          mergeCommit,
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
        mergeCommit,
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
      mergeCommit,
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

    // The directory holding this item's command output is created before the
    // first GitHub read: it is where every command this pass runs writes its
    // stdout and stderr, and a command whose log directory is absent fails
    // before it can report anything (docs/WORKFLOW.md §10).
    const evidence = await ensureCompletionLogsDir(parts.workDir, item.ref, parts.repository);
    if (!evidence.ready) {
      return { ref, status: 'attention', detail: evidence.problem, commentId: null };
    }

    // The one logical deadline this item's reads share: a transient GitHub
    // failure is retried inside it, and a stable terminal state is reported
    // from it rather than polled forever.
    const deadline = now().getTime() + config.deadlineSeconds * 1000;

    let context: PullContext | null;
    try {
      context = await readEvidence(item, stop, deadline, () => contextFor(item, workspaceId, stop));
    } catch (cause) {
      return {
        ref,
        status: 'attention',
        detail: `GitHub could not be read: ${messageOf(cause)}`,
        commentId: null,
      };
    }
    if (context === null) {
      // No open pull request matches the delivered branch. GitHub may have
      // accepted an admitted auto-merge request and merged it even if its
      // response was lost: that pull request is read by number, and only its
      // own merged state, tied to the reviewed head and the reviewer's
      // approval, lets the merge and its post-merge workflows decide this item.
      const armed = await readArmedHead(
        completionLogsDir(parts.workDir, item.ref, parts.repository),
      );
      if (armed?.number !== null && armed?.number !== undefined) {
        const request = requestFor(item, workspaceId);
        try {
          const settled = await readFresh(
            item,
            request,
            { number: armed.number, head: armed.head },
            stop,
            deadline,
          );
          if (settled.kind === 'merged') {
            const pull = settled.pull;
            const approval = await readEvidence(item, stop, deadline, () =>
              actions.readApprovedHead(request, pull, stop),
            );
            if (approval === armed.head) {
              const follow = await followMerge(
                { item, request, pull },
                armed.head,
                stop,
                MERGE_WAIT_ROUNDS,
              );
              return await recordStep(item, thread, follow, stop, { item, request, pull });
            }
            return {
              ref,
              status: 'attention',
              detail: mergeNotTied(
                pull,
                armed.head,
                approval === null
                  ? 'GitHub records no review approving the merged head'
                  : `the reviewer approved ${approval}, not the merged head`,
                pull.mergeCommit?.oid ?? null,
              ),
              commentId: null,
            };
          }
          if (settled.kind !== 'open')
            return {
              ref,
              status: 'attention',
              detail: settledFailure(settled, armed.head),
              commentId: null,
            };
        } catch (cause) {
          return {
            ref,
            status: 'attention',
            detail: `GitHub could not be read for the merge this pass admitted: ${messageOf(cause)}`,
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
      step = await decide(context, stop, deadline);
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

  /**
   * The In Review items this pass may touch. A caller that named one ticket —
   * the serial queue loop arms exactly the ticket it is carrying — reads
   * nothing about another In Review item. The ticket is matched by the
   * immutable identity of a source reference, never by its key.
   */
  const scopedCandidates = async (stop: AbortSignal): Promise<readonly SourceCandidate[]> => {
    const candidates = await source.listReview(stop);
    const only = parts.only;
    if (only === undefined) return candidates;
    return candidates.filter(
      (candidate) =>
        candidate.ref.type === only.type &&
        candidate.ref.scope === only.scope &&
        candidate.ref.id === only.id,
    );
  };

  /**
   * One item's arm step: find its open delivered pull request and verify or
   * establish native auto-merge for the head GitHub holds now. Nothing here
   * writes a comment or moves the item; a refusal is reported as attention and
   * the item stays In Review.
   */
  const armOne = async (candidate: SourceCandidate, stop: AbortSignal): Promise<ArmOutcome> => {
    const item = await source.readItem(candidate, stop);
    if (item === null) {
      return {
        ref: candidate.ref,
        status: 'observed',
        detail: 'it is no longer In Review, so nothing was armed',
      };
    }
    const { ref } = item;
    if (item.pointers.length !== 1) {
      return {
        ref,
        status: 'observed',
        detail:
          item.pointers.length === 0
            ? 'it has no workspace pointer, so this path will not arm anything for it'
            : `it carries ${String(item.pointers.length)} workspace pointers, so which workspace ` +
              'produced the work is ambiguous',
      };
    }
    const evidence = await ensureCompletionLogsDir(parts.workDir, item.ref, parts.repository);
    if (!evidence.ready) {
      return { ref, status: 'attention', detail: evidence.problem };
    }
    let context: PullContext | null;
    try {
      context = await contextFor(item, item.pointers[0] ?? '', stop);
    } catch (cause) {
      return {
        ref,
        status: 'attention',
        detail: `GitHub could not be read before native auto-merge was armed: ${messageOf(cause)}`,
      };
    }
    if (context === null) {
      return {
        ref,
        status: 'observed',
        detail:
          'no single open delivered pull request matches its recorded workspace branch, so nothing ' +
          'was armed; the completion path verifies any merge it admitted',
      };
    }
    const arming = await ensureArmed(context, stop, { beginsHere: false });
    if (arming.kind === 'attention') {
      return { ref, status: 'attention', detail: arming.detail };
    }
    if (arming.kind === 'merged') {
      // Nothing was armed and nothing needs arming: the reviewed head is
      // already merged, and the completion path verifies that merge.
      return { ref, status: 'observed', detail: arming.detail };
    }
    return {
      ref,
      status: 'armed',
      detail: arming.detail,
      head: arming.head,
      number: arming.number,
    };
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
    const evidence = await ensureCompletionLogsDir(parts.workDir, item.ref, parts.repository);
    if (!evidence.ready)
      return {
        ref: candidate.ref,
        status: 'attention',
        detail: evidence.problem,
        commentId: null,
      };
    const request = requestFor(item, item.pointers[0] ?? '');
    const admitted = await readArmedHead(
      completionLogsDir(parts.workDir, item.ref, parts.repository),
    );
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
      const scoped = await scopedCandidates(stop);
      const outcomes: CompletionOutcome[] = [];
      for (const candidate of scoped) {
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
    async arm(stop) {
      const scoped = await scopedCandidates(stop);
      const outcomes: ArmOutcome[] = [];
      for (const candidate of scoped) {
        if (stop.aborted) {
          break;
        }
        const deadline = new AbortController();
        const timer = setTimeout(
          () => deadline.abort(new Error('Auto-merge deadline expired')),
          config.deadlineSeconds * 1000,
        );
        let outcome: ArmOutcome;
        try {
          outcome = await armOne(candidate, AbortSignal.any([stop, deadline.signal]));
        } catch (cause) {
          if (!deadline.signal.aborted) throw cause;
          outcome = {
            ref: candidate.ref,
            status: 'attention',
            detail: 'the item deadline expired before native auto-merge could be armed',
          };
        } finally {
          clearTimeout(timer);
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
