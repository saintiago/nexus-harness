/**
 * The shared test support, as the suites depend on it. A removal that something
 * holds for a moment — the `EBUSY` refusal one full suite was seen to raise — is
 * retried, while any other failure, and one that is refused every time, is
 * reported as it was: the tolerance must not turn a directory something really
 * holds into a removal that quietly did not happen, and must not become a
 * blanket retry for failures that were never shown to be transient
 * (notes/windows-fixture-flakes.md).
 */

import { describe, expect, it } from 'vitest';
import { removeWithRetry } from './support.js';

/** The failure one Windows removal raced: the tree was still held. */
function busyRefusal(): NodeJS.ErrnoException {
  return Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
}

/** A failure the retry knows nothing about: it must be reported on the spot. */
function permissionRefusal(): NodeJS.ErrnoException {
  return Object.assign(new Error('permission denied'), { code: 'EACCES' });
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

  it('is reported at once when it failed for another reason', async () => {
    let attempts = 0;
    const failure = permissionRefusal();
    const refused = removeWithRetry(
      async () => {
        attempts += 1;
        throw failure;
      },
      5,
      1,
    );

    await expect(refused).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});
