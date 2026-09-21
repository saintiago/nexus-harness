/**
 * What the two source suites share: the Jira scope every fixture's refs point
 * at, the ref one issue id becomes, and the bounded poll a test waits on.
 *
 * Only these three are shared. The coordinator suite's own coordinator-level
 * fixtures stay with it, and the CLI suite's own fake Jira and CLI helpers stay
 * with that file: what the split is for is that a policy test never pays for a
 * child process and a CLI test never pays for the other file's setup.
 */

import type { SourceRef } from '../../src/shared/types.js';

/** The Jira site the source fixtures are scoped to. */
export const SCOPE = 'https://example.atlassian.net';

/** One issue id as the source ref this harness reads it as. */
export function refFor(
  id: string,
  key = `SAM1-${id}`,
  updatedAt = '2026-09-16T11:00:00.000Z',
): SourceRef {
  return {
    type: 'jira',
    scope: SCOPE,
    id,
    key,
    url: `${SCOPE}/browse/${key}`,
    updatedAt,
  };
}

/** Waits, bounded, for a condition a test is driving towards by hand. */
export async function until(
  condition: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`this test waited for ${what}, and it never happened`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
