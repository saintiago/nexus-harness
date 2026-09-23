/**
 * Component tests: the real StartRound numbers rounds over real temporary storage, establishing
 * first and later rounds, retained directories, current-round validation and the artifact root the
 * round helpers resolve. No live service or agent is involved.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifactHelpers } from '../src/task-engine/actions/artifacts.js';
import { devArtifact } from '../src/task-engine/actions/develop/artifacts.js';
import { createStartRound } from '../src/task-engine/actions/start-round/index.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nexus-start-round-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Read the current-round record as it is stored. */
async function readCurrentRound(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, 'state', 'current-round.json'), 'utf8'));
}

describe('StartRound', () => {
  it('starts the first round in a workspace that has no round yet', async () => {
    const startRound = createStartRound({ workspace: { root } });

    await expect(startRound()).resolves.toBe('started');

    expect(await readCurrentRound()).toEqual({ number: 1 });
    expect((await stat(path.join(root, 'artifacts', '1'))).isDirectory()).toBe(true);
  });

  it('starts the next round and retains earlier round directories', async () => {
    const startRound = createStartRound({ workspace: { root } });
    await startRound();
    await writeFile(path.join(root, 'artifacts', '1', 'review.json'), 'history\n', 'utf8');

    await expect(startRound()).resolves.toBe('started');

    expect(await readCurrentRound()).toEqual({ number: 2 });
    expect(await readFile(path.join(root, 'artifacts', '1', 'review.json'), 'utf8')).toBe(
      'history\n',
    );
    expect((await stat(path.join(root, 'artifacts', '2'))).isDirectory()).toBe(true);
  });

  it('retains an existing next directory and its contents', async () => {
    const startRound = createStartRound({ workspace: { root } });
    await mkdir(path.join(root, 'state'), { recursive: true });
    await writeFile(
      path.join(root, 'state', 'current-round.json'),
      `${JSON.stringify({ number: 2 })}\n`,
      'utf8',
    );
    await mkdir(path.join(root, 'artifacts', '3'), { recursive: true });
    await writeFile(path.join(root, 'artifacts', '3', 'left-behind.txt'), 'kept\n', 'utf8');

    await expect(startRound()).resolves.toBe('started');

    expect(await readCurrentRound()).toEqual({ number: 3 });
    expect(await readFile(path.join(root, 'artifacts', '3', 'left-behind.txt'), 'utf8')).toBe(
      'kept\n',
    );
  });

  it('rejects a present but invalid current-round record', async () => {
    const startRound = createStartRound({ workspace: { root } });
    const recordFile = path.join(root, 'state', 'current-round.json');
    await mkdir(path.dirname(recordFile), { recursive: true });
    await writeFile(recordFile, '{ not json', 'utf8');

    await expect(startRound()).rejects.toThrow(/is not valid JSON/);
    expect(await readFile(recordFile, 'utf8')).toBe('{ not json');

    await writeFile(recordFile, JSON.stringify({ number: 0 }), 'utf8');
    await expect(startRound()).rejects.toThrow(/does not match its declared content type/);
    expect(JSON.parse(await readFile(recordFile, 'utf8'))).toEqual({ number: 0 });

    await rm(recordFile);
    await mkdir(recordFile);
    await expect(startRound()).rejects.toThrow(/could not be read/);
  });

  it('starts the round root the artifact helpers resolve', async () => {
    const startRound = createStartRound({ workspace: { root } });
    const helpers = createArtifactHelpers({ root });
    await startRound();

    await helpers.writeOutputArtifact(devArtifact, {
      taskKey: 'NEX-1',
      profile: 'developer',
      status: 'completed',
      baseRevision: '1'.repeat(40),
      headRevision: '2'.repeat(40),
      summary: 'First round.',
      findingResponses: [],
    });

    expect(
      JSON.parse(await readFile(path.join(root, 'artifacts', '1', 'development.json'), 'utf8')),
    ).toMatchObject({ taskKey: 'NEX-1' });
    await expect(helpers.readInputArtifacts(devArtifact)).resolves.toMatchObject([
      { taskKey: 'NEX-1' },
    ]);

    await startRound();
    await expect(helpers.readArtifactHistory(devArtifact)).resolves.toMatchObject([
      { number: 1, value: { taskKey: 'NEX-1' } },
    ]);
  });
});
