/**
 * The marker a published rendering carries so synchronization can tell it from
 * a new conversational entry.
 *
 * A complete developer or reviewer report is saved locally before anything is
 * published, and the concise Jira comment or GitHub review that renders it is
 * the same text coming back on the next read. The marker names the complete
 * report the rendering belongs to; when synchronization reads the rendering and
 * the local report is present, the rendering is recorded as a mirror of it and
 * does not become a second conversation entry.
 *
 * The marker is plain text in the published rendering — one short line naming a
 * local record — and carries no path, credential, or command.
 */
/** The one prefix both renderings carry. */
export const HISTORY_MARKER_PREFIX = 'nexus-history:';

/** The marker naming one complete developer report. */
export function developerHistoryMarker(runId: string): string {
  return `${HISTORY_MARKER_PREFIX} developer ${runId}`;
}

/** The marker naming one complete reviewer report. */
export function reviewerHistoryMarker(reviewId: string): string {
  return `${HISTORY_MARKER_PREFIX} reviewer ${reviewId}`;
}

/** One recognized marker: what it names, and whether it was found at all. */
export interface HistoryMarker {
  readonly kind: 'developer' | 'reviewer';
  readonly id: string;
}

const MARKER_PATTERN = /nexus-history:\s*(developer|reviewer)\s+([A-Za-z0-9][A-Za-z0-9_-]{0,127})/;

/**
 * The first marker one piece of external text carries, or `null`. A rendering
 * that carries a marker for a report this machine does not hold is still an
 * ordinary entry: the marker only prevents a duplicate of a local record.
 */
export function historyMarkerOf(text: string): HistoryMarker | null {
  const match = MARKER_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const kind = match[1];
  const id = match[2];
  if ((kind !== 'developer' && kind !== 'reviewer') || id === undefined) {
    return null;
  }
  return { kind, id };
}
