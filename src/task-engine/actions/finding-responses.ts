import type { FindingResponse } from './develop/artifacts.js';
import type { Finding } from './review/artifacts.js';

/**
 * The shared identity rule of the findings contract: a responding role returns exactly one
 * response for each supplied finding and none for any other ID. Roles that own additional
 * disposition or verdict rules state them where they apply.
 */

/** Require one response per supplied finding, and none for an ID outside the supplied set. */
export function requireFindingResponses(
  responses: readonly FindingResponse[],
  findings: readonly Finding[],
  subject: string,
): void {
  const supplied = new Set(findings.map((finding) => finding.id));
  const answered = new Set<string>();
  for (const response of responses) {
    if (!supplied.has(response.findingId)) {
      throw new Error(`The ${subject} responded to unknown finding "${response.findingId}".`);
    }
    if (answered.has(response.findingId)) {
      throw new Error(
        `The ${subject} responded more than once to finding "${response.findingId}".`,
      );
    }
    answered.add(response.findingId);
  }
  const missing = findings.map((finding) => finding.id).filter((id) => !answered.has(id));
  if (missing.length > 0) {
    throw new Error(
      `The ${subject} did not respond to finding${missing.length === 1 ? '' : 's'} ` +
        `${missing.map((id) => `"${id}"`).join(', ')}.`,
    );
  }
}
