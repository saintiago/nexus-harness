/**
 * What a continued attempt is told about the attempts before it and what the
 * item's own thread said since: the reviewed baseline finding first, then the
 * oldest of the kept lines, bounded so a long conversation or a long failure
 * cannot grow a prompt without limit.
 *
 * The finding is not read here: it arrives already established, from the
 * item's own whole comment when that comment names the evidence the retained
 * record closed as a repair, or from that record itself. A comment of the
 * thread is otherwise ordinary context — never promoted to the requirement to
 * repair the baseline because it happens to contain a marker
 * (docs/WORKFLOW.md §11).
 *
 * All of it is context for a turn: none of it becomes a command, an argument, a
 * path, or a limit.
 */
import type { WorkspaceAttempt } from '../workspace/state.js';
import type { SourceComment } from './contract.js';

/** How much context a continued attempt is given, and how much of one line. */
const GUIDANCE_MAX_LINES = 12;
const GUIDANCE_MAX_CHARS = 4000;
const GUIDANCE_LINE_CHARS = 600;
/**
 * How many lines the reviewed baseline findings may take by themselves. The
 * finding is what the attempt must address before it goes on with the ticket, so
 * it is never the context this budget drops to make room for later chatter: one
 * finding's own fields and the order they belong in fit whole — two of them
 * nearly do — and anything older than that is history the workspace's own
 * ledger still holds.
 */
const GUIDANCE_FINDING_MAX_LINES = 8;

/** One line of context, collapsed and bounded: a comment cannot grow a prompt. */
function guidanceLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= GUIDANCE_LINE_CHARS
    ? collapsed
    : `${collapsed.slice(0, GUIDANCE_LINE_CHARS - 1)}…`;
}

/**
 * What a continued attempt is told about the attempts before it and what was
 * said since: oldest of the kept lines first, bounded so a long conversation or
 * a long failure cannot grow a prompt without limit
 * (docs/implement-workspace-continuation.md). All of it is context for the turn:
 * none of it becomes a command, an argument, a path, or a limit.
 */
export function guidanceFrom(
  attempts: readonly WorkspaceAttempt[],
  comments: readonly SourceComment[],
  /**
   * The reviewed baseline finding this attempt has to address, already
   * established by the caller: the whole finding the item's own thread carries
   * when it names the evidence the retained record closed as a repair, or the
   * complete finding read back from that record. It is carried first, as its
   * own lines, and is never one of the bounded context lines
   * (docs/WORKFLOW.md §11).
   */
  reviewedFinding: readonly string[] = [],
): readonly string[] {
  const findings: string[] = reviewedFinding.slice(0, GUIDANCE_FINDING_MAX_LINES);
  const lines: string[] = [];
  attempts.forEach((attempt, index) => {
    lines.push(
      `attempt ${String(index + 1)}` +
        `${attempt.tier === undefined ? '' : ` (tier ${attempt.tier})`} ${attempt.outcome}: ` +
        guidanceLine(attempt.reason ?? 'no reason was recorded'),
    );
  });
  for (const comment of comments) {
    lines.push(
      `comment by ${comment.author} at ${comment.createdAt}: ${guidanceLine(comment.text)}`,
    );
  }

  // The finding is kept whatever else the thread holds; the rest of the context
  // is the newest that fits beside it.
  const kept: string[] = [];
  let used = findings.reduce((total, line) => total + line.length, 0);
  for (const line of [...lines].reverse()) {
    if (
      findings.length + kept.length >= GUIDANCE_MAX_LINES ||
      used + line.length > GUIDANCE_MAX_CHARS
    ) {
      break;
    }
    kept.push(line);
    used += line.length;
  }
  return [...findings, ...kept.reverse()];
}
