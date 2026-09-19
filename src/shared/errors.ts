/**
 * The one message helper: the text of a thrown value, for every module that has
 * to report what went wrong. It is three lines on purpose â€” a module that needs
 * more than this owns the wording itself.
 */

/** The message of a thrown value, whatever it is. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
