/**
 * What a failed stop repeats from the host utility it ran. `taskkill /T` names
 * every child it ended on standard output before it can report a failure on
 * standard error, so the reason a stop failed has to survive a long success
 * prefix in front of it — and the record has to be bounded while it is collected,
 * not after.
 *
 * The case is driven through the collector itself: no system process is started
 * to produce it, so the regression is deterministic on any host
 * (notes/windows-fixture-flakes.md).
 */

import { describe, expect, it } from 'vitest';
import { collectHostUtilityWords } from '../src/process/stop.js';

/** One success line of the kind `taskkill /T` prints per child it has ended. */
function terminatedLine(pid: number): string {
  return `SUCCESS: The process with PID ${String(pid)} (child process of PID 1) has been terminated.\n`;
}

describe('what a failed stop repeats of what its utility said', () => {
  it('keeps a late failure on standard error after a long success prefix', () => {
    const words = collectHostUtilityWords();
    for (let pid = 1000; pid < 1010; pid += 1) {
      words.noteStdout(terminatedLine(pid));
    }
    words.noteStderr(
      'ERROR: The process with PID 4321 could not be terminated.\n' +
        'Reason: This is critical system process. Taskkill cannot end this process.\n',
    );

    const detail = words.failureDetail();

    // The whole reason survives, even though the success text in front of it is
    // several times the bound: the two streams do not share one budget.
    expect(detail).toBe(
      ': ERROR: The process with PID 4321 could not be terminated. Reason: This is critical' +
        ' system process. Taskkill cannot end this process.',
    );
  });

  it('falls back to standard output when standard error is empty', () => {
    const words = collectHostUtilityWords();
    words.noteStdout('ERROR: The process "1234" not found.\n');

    expect(words.failureDetail()).toBe(': ERROR: The process "1234" not found.');
  });

  it('keeps only the bound of what one stream says, and says it was cut', () => {
    const words = collectHostUtilityWords();
    words.noteStdout('x'.repeat(1_000_000));

    expect(words.failureDetail()).toBe(`: ${'x'.repeat(200)} [truncated]`);
  });

  it('repeats nothing when the utility said nothing', () => {
    expect(collectHostUtilityWords().failureDetail()).toBe('');
  });
});
