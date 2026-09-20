/**
 * The pre-delivery baseline diagnosis: the one bounded reviewer turn a
 * completed red baseline on a fresh workspace enters before any coding turn.
 *
 * ```text
 * completed red baseline -> one reviewer turn over the snapshot
 *                              |                     |
 *                    actionable finding      nothing actionable
 *                              |                     |
 *              one comment + return to ready   one comment + stay in review
 *                              |
 *            the next claim continues the same workspace
 * ```
 *
 * The ticket is claimed, its workspace is created, and the baseline checks fail
 * before a developer starts. That is not a failed attempt to publish and wait
 * on: the reviewer inspects the exact source snapshot and the evidence the
 * configured commands wrote, and says either what the next coding turn should
 * repair or why no repair may be made. An actionable finding is recorded in
 * Jira as one comment and the item returns to the status it was claimed from,
 * with its workspace pointer preserved — nothing else about an attempt happens,
 * and no separate ticket, label, or manual ranking step is invented. Everything
 * else leaves the item In Review with the evidence and what a person must do.
 *
 * Nothing here is published anywhere but Jira, and nothing here is evidence of
 * a review: there is no pull request yet, so no GitHub review, Lens approval, or
 * check is fabricated for one.
 *
 * The marker inside the comment is what a restart reads: the same evidence
 * identity — the same immutable item, snapshot, commands, and results — is never
 * diagnosed twice, no second reviewer turn is paid for, and the run resumes by
 * making the status move it had not yet made.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import type { CheckRoundResult, CommandResult, SourceRef } from '../shared/types.js';
import type {
  BaselineDiagnosis,
  BaselineDiagnosisOutcome,
  BaselineFinding,
  BaselineRecord,
  BaselineReview,
  BaselineReviewResult,
  SourceIo,
  SourceNote,
  SourceTask,
} from './contract.js';

/** The prefix of the marker one diagnosis comment carries, in the Jira thread. */
export const BASELINE_MARKER_PREFIX = 'nexus-baseline:';

/** How wide one comment line may grow before it is truncated. */
const LINE_LIMIT = 600;

/** The marker naming one actionable finding for one evidence identity. */
function repairMarker(evidenceId: string): string {
  return `${BASELINE_MARKER_PREFIX}repair:${evidenceId}`;
}

/** The marker naming one non-actionable diagnosis for one evidence identity. */
function attentionMarker(evidenceId: string): string {
  return `${BASELINE_MARKER_PREFIX}attention:${evidenceId}`;
}

/**
 * The identity of one baseline observation: the immutable item, the snapshot the
 * baseline ran against, and the configured commands with the results they
 * produced. Same item, same snapshot, same results — the same evidence, which a
 * restart recognises and never diagnoses twice. A changed snapshot, a changed
 * command, or a different result is new evidence and is diagnosed again.
 */
export function baselineEvidenceId(
  ref: SourceRef,
  baseCommit: string,
  round: CheckRoundResult,
): string {
  const invocation = (result: CommandResult): readonly unknown[] => [
    result.command,
    result.outcome,
    result.exitCode,
    result.signal,
    result.launchError,
  ];
  return createHash('sha256')
    .update(
      JSON.stringify([
        ref.type,
        ref.scope,
        ref.id,
        baseCommit,
        round.setup.map(invocation),
        round.checks.map(invocation),
      ]),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32);
}

/** One line of text, so a finding cannot grow a comment without limit. */
function oneLine(text: string, limit = LINE_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** The one marker on the thread that belongs to this evidence, and what it is. */
function markerFor(
  notes: readonly SourceNote[],
  evidenceId: string,
): { readonly kind: 'repair' | 'attention'; readonly note: SourceNote } | null {
  for (const note of notes) {
    for (const kind of ['repair', 'attention'] as const) {
      if (note.text.includes(`${BASELINE_MARKER_PREFIX}${kind}:${evidenceId}`)) {
        return { kind, note };
      }
    }
  }
  return null;
}

/**
 * The one comment a diagnosis posts. It names the failing check, the evidence,
 * the likely cause and the repair for an actionable finding — or why nothing is
 * actionable and what a person must do — and it carries the marker a restart
 * reads. It carries no transcript, no diff, and no credential.
 */
function diagnosisParagraphs(parts: {
  readonly key: string;
  readonly finding: BaselineFinding;
  readonly marker: string;
  readonly readyStatus: string;
  readonly reviewStatus: string;
}): readonly string[] {
  const { key, finding, marker, readyStatus, reviewStatus } = parts;
  if (finding.outcome === 'repair') {
    return [
      `${key}: the configured baseline checks failed before any coding turn, and the diagnosis is ` +
        `actionable (${marker}, written by the Nexus harness).`,
      `Failing check: ${oneLine(finding.failingCheck)}`,
      `Evidence: ${oneLine(finding.evidence)}`,
      `Likely cause: ${oneLine(finding.likelyCause)}`,
      `Repair guidance: ${oneLine(finding.repairGuidance)}`,
      `Returned to "${readyStatus}" with its workspace pointer preserved: the next claim continues ` +
        'the same retained workspace, repairs the baseline before anything else, and then carries ' +
        'on with the original task. The configured checks still decide the attempt, and nothing is ' +
        'delivered or reviewed until a post-agent round passes every one of them.',
    ];
  }
  return [
    `${key}: the configured baseline checks failed before any coding turn, and no repair is ` +
      `actionable (${marker}, written by the Nexus harness).`,
    `Why no repair: ${oneLine(finding.reason)}`,
    `Required action: ${oneLine(finding.requiredAction)}`,
    `It stays in "${reviewStatus}" for a person. No coding turn is started from this diagnosis, ` +
      'the harness does not guess at a repair, and nothing is delivered or reviewed.',
  ];
}

/** What one pre-delivery diagnosis is built from, all ordinary pieces. */
export interface BaselineDiagnosisParts {
  /** The one bounded local reviewer turn the diagnosis runs. */
  readonly reviewer: BaselineReview;
  /** The item's own thread and status, as the diagnosis reads and writes them. */
  readonly record: BaselineRecord;
  /** The status an actionable finding returns the item to: where work is claimed from. */
  readonly readyStatus: string;
  /** The status a non-actionable diagnosis leaves the item in. */
  readonly reviewStatus: string;
  /** `<workDir>`: where the diagnosis's own evidence directories are kept. */
  readonly workDir: string;
  readonly io: SourceIo;
}

/**
 * The one pre-delivery diagnosis. It is built once per source command and reused
 * for every red baseline that command observes.
 */
export function createBaselineDiagnosis(parts: BaselineDiagnosisParts): BaselineDiagnosis {
  const { reviewer, record, readyStatus, reviewStatus, workDir, io } = parts;

  /**
   * One outcome for a step that did not finish: a stop the caller asked for is
   * reported as the cancellation it is, and everything else is the attention
   * result whose evidence a person needs.
   */
  const unfinished = (
    stop: AbortSignal,
    detail: string,
    commentId: string | null,
  ): BaselineDiagnosisOutcome =>
    stop.aborted ? { kind: 'cancelled', detail } : { kind: 'attention', detail, commentId };

  /** One status move, reported as the step it is rather than as a refusal. */
  const move = async (
    item: SourceTask,
    target: string,
    stop: AbortSignal,
  ): Promise<{ readonly moved: boolean } | { readonly problem: string }> => {
    try {
      const outcome = await record.moveFromRunning(item.ref.id, target, stop);
      return { moved: outcome === 'moved' };
    } catch (cause) {
      return { problem: messageOf(cause) };
    }
  };

  return {
    async diagnose(request): Promise<BaselineDiagnosisOutcome> {
      const { item, workspace, baseline, stop } = request;
      const key = item.ref.key;
      const evidenceId = baselineEvidenceId(item.ref, workspace.baseCommit, baseline);
      const dir = path.join(workDir, 'baseline', evidenceId);

      if (stop.aborted) {
        return {
          kind: 'cancelled',
          detail: `${key}: the intake was stopped before its red baseline could be diagnosed`,
        };
      }

      let notes: readonly SourceNote[];
      try {
        notes = await record.listComments(item.ref.id, stop);
      } catch (cause) {
        return unfinished(
          stop,
          `${key}: its thread could not be read, so its red baseline was not diagnosed and the ` +
            `item was not moved: ${messageOf(cause)}`,
          null,
        );
      }

      // The thread is the deduplication record: evidence that already carries a
      // finding is never diagnosed again, and a run that stopped between the
      // comment and the status move resumes by making that one move.
      const existing = markerFor(notes, evidenceId);
      if (existing !== null) {
        const target = existing.kind === 'repair' ? readyStatus : reviewStatus;
        const moved = await move(item, target, stop);
        if ('problem' in moved) {
          return unfinished(
            stop,
            `${key}: its baseline finding is already on the issue (comment ` +
              `${existing.note.id}), but moving it to "${target}" failed: ${moved.problem}`,
            existing.note.id,
          );
        }
        const detail =
          `${key}: this exact baseline evidence was already diagnosed (comment ` +
          `${existing.note.id}); no second reviewer turn was started and no second comment was ` +
          `written` +
          (moved.moved
            ? `, and the item was moved to "${target}"`
            : `, and the item had already left its running status`);
        io.out(detail);
        return {
          kind: existing.kind === 'repair' ? 'repair' : 'attention',
          detail,
          commentId: existing.note.id,
        };
      }

      io.out(
        `${key}: a completed red baseline before any coding turn; one reviewer turn is diagnosing ` +
          `the snapshot at ${workspace.baseCommit} (evidence under ${dir})`,
      );
      let reviewed: BaselineReviewResult;
      try {
        reviewed = await reviewer({
          dir,
          item,
          workspace: { path: workspace.workspacePath, baseCommit: workspace.baseCommit },
          baseline,
          stop,
        });
      } catch (cause) {
        reviewed = {
          summary: null,
          finding: null,
          problem: messageOf(cause),
          logPath: path.join(dir, 'reviewer.log'),
        };
      }

      // A turn that failed, was stopped, wrote nothing usable, or left its view
      // changed has no finding: the diagnosis records that instead of guessing
      // at a repair, and the item stays In Review for a person.
      const finding: BaselineFinding = reviewed.finding ?? {
        outcome: 'inconclusive',
        reason: `the baseline diagnostic produced no usable finding: ${
          reviewed.problem ?? 'no reason was recorded'
        }`,
        requiredAction:
          'Check the configured reviewer launch, its credentials, and the evidence under ' +
          `"${dir}", then move the item back to "${readyStatus}" to continue it, or repair the ` +
          'baseline by hand.',
      };

      const marker =
        finding.outcome === 'repair' ? repairMarker(evidenceId) : attentionMarker(evidenceId);
      const paragraphs = diagnosisParagraphs({
        key,
        finding,
        marker,
        readyStatus,
        reviewStatus,
      });

      let commentId: string;
      try {
        commentId = await record.postComment(item.ref.id, paragraphs, stop);
      } catch (cause) {
        return unfinished(
          stop,
          `${key}: the diagnosis could not be confirmed on the issue, so nothing was moved and ` +
            `the red baseline still needs a person: ${messageOf(cause)}`,
          null,
        );
      }

      const target = finding.outcome === 'repair' ? readyStatus : reviewStatus;
      const moved = await move(item, target, stop);
      if ('problem' in moved) {
        return unfinished(
          stop,
          `${key}: the diagnosis is on the issue (comment ${commentId}) but moving it to ` +
            `"${target}" failed: ${moved.problem}`,
          commentId,
        );
      }

      const where = moved.moved
        ? `the item was moved to "${target}"`
        : `the item had already left its running status, so it was left where it is`;
      if (finding.outcome === 'repair') {
        const detail =
          `${key}: the red baseline is diagnosed and actionable (comment ${commentId}); ${where} ` +
          'with its workspace pointer preserved, ready for the next claim to repair the baseline ' +
          'and continue the original task';
        io.out(detail);
        return { kind: 'repair', detail, commentId };
      }
      const detail =
        `${key}: the red baseline is not actionable (comment ${commentId}); ${where} with the ` +
        'evidence and the required action, so a person decides what happens next';
      io.err(detail);
      return { kind: 'attention', detail, commentId };
    },
  };
}
