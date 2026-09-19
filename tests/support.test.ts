/**
 * The shared test support, as the suites depend on it. A removal that something
 * holds for a moment is retried, and one that is refused every time is still
 * reported: the tolerance must not turn a directory something really holds into
 * a removal that quietly did not happen (notes/windows-fixture-flakes.md).
 */

import { describe, expect, it } from 'vitest';
import { removeWithRetry } from './support.js';

/** The failure one Windows removal raced: the tree was still held. */
function busyRefusal(): NodeJS.ErrnoException {
  return Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
}

describe('a removal something still holds for a moment', () => {
  it('is retried until that holder has let go of it', async () => {
    let attempts = 0;
    await removeWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw busyRefusal();
        }
      },
      5,
      1,
    );

    expect(attempts).toBe(3);
  });

  it('is reported when it is refused every time', async () => {
    let attempts = 0;
    const refused = removeWithRetry(
      async () => {
        attempts += 1;
        throw busyRefusal();
      },
      3,
      1,
    );

    await expect(refused).rejects.toThrow('resource busy or locked');
    expect(attempts).toBe(3);
  });
});
