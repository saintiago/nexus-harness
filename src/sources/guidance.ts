/**
 * What a continued attempt is told about the attempts before it and what the
 * item's own thread said since: oldest of the kept lines first, bounded so a
 * long conversation or a long failure cannot grow a prompt without limit.
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
): readonly string[] {
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

  const kept: string[] = [];
  let used = 0;
  for (const line of [...lines].reverse()) {
    if (kept.length >= GUIDANCE_MAX_LINES || used + line.length > GUIDANCE_MAX_CHARS) {
      break;
    }
    kept.push(line);
    used += line.length;
  }
  return kept.reverse();
}
