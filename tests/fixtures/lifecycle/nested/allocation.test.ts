/** Exercise late mkdtemp completion across actual Vitest hooks and tests. */
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createTempDir, tempDirectories } from '../../../support.js';
import { ownFixtureOperation, useFixtureLifecycle } from '../../lifecycle.js';
import { waitFor } from '../../local-target.js';

const delayed = vi.hoisted(() => ({ allocation: undefined as Promise<void> | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    mkdtemp: async (prefix: string) => {
      await delayed.allocation;
      return await fs.mkdtemp(prefix);
    },
  };
});
useFixtureLifecycle();

let releaseAllocation!: () => void;
let releaseSetup!: () => void;
let setup: Promise<void>;
let refused = false;
let directory: string;
let newerDirectory: string;

it('times out with its directory allocation pending beyond disposal', async () => {
  delayed.allocation = new Promise<void>((resolve) => {
    releaseAllocation = resolve;
  });
  const finishSetup = new Promise<void>((resolve) => {
    releaseSetup = resolve;
  });
  setup = ownFixtureOperation('late allocation setup', async () => {
    try {
      await createTempDir();
    } catch (cause) {
      refused = cause instanceof Error && cause.message.includes('allocation was refused');
    }
    await finishSetup;
  });
  // Allocation is released only by the next test, after this timeout and the
  // full bounded disposal have returned. No sleep approximates that ordering.
  await setup;
}, 100);

it('releases the previous allocation while its setup still owns work', async () => {
  releaseAllocation();
  await waitFor(async () => refused, 'the late allocation to be refused');
  const [allocated] = tempDirectories();
  expect(allocated).toBeDefined();
  directory = allocated!;
  expect(existsSync(directory)).toBe(true);
  newerDirectory = await createTempDir();
});

it('keeps the old allocation through another test cleanup, then settles its owner', async () => {
  expect(existsSync(directory)).toBe(true);
  expect(existsSync(newerDirectory)).toBe(false);
  await appendFile(
    process.env['NEXUS_LIFECYCLE_REPORT'] ?? '',
    `${JSON.stringify({
      case: 'late-allocation',
      directory,
      pid: null,
      token: null,
      grandchild: null,
      outcome: 'refused; directory survived the next test; newer directory removed',
    })}\n`,
  );
  releaseSetup();
  await setup;
});

it('removes the late directory only after its original owner settles', () => {
  expect(existsSync(directory)).toBe(false);
});
