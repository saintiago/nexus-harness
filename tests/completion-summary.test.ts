/**
 * What one completion pass reports as its summary.
 *
 * The coordinator and the CLI read this summary: the pass own account of what each item ended as, and the problem it reports when discovery itself failed.
 */

import { describe, expect, it } from 'vitest';
import { createCompletionRun } from '../src/sources/completion.js';
import { ISSUE_KEY, createFixture, passFor } from './fixtures/completion.js';
import { useFixtureLifecycle } from './fixtures/lifecycle.js';

useFixtureLifecycle();

describe('the completion summary', () => {
  it('counts what each item ended as and prints it', async () => {
    const fixture = await createFixture({ merged: true });
    const lines: string[] = [];
    const run = createCompletionRun(passFor(fixture), {
      out: (text) => lines.push(text),
      err: (text) => lines.push(text),
    });

    const summary = await run.run(AbortSignal.timeout(30_000));

    expect(summary).toEqual({ done: 1, toDo: 0, attention: 0, observed: 0, problem: null });
    expect(lines.join('\n')).toContain(`${ISSUE_KEY}: completed`);
  });

  it('reports a discovery failure as a problem without throwing', async () => {
    const fixture = await createFixture({});
    fixture.jira.readFailure = true;
    const run = createCompletionRun(passFor(fixture), {
      out: () => undefined,
      err: () => undefined,
    });

    const summary = await run.run(AbortSignal.timeout(30_000));

    expect(summary.problem).toContain('HTTP 503');
    expect(summary.done).toBe(0);
  });
});
