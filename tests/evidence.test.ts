import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOperatorCommand } from '../src/application/command.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-evidence-'));
  directories.push(root);
  const evidence = path.join(root, 'evidence');
  await mkdir(path.join(evidence, 'artifacts'), { recursive: true });
  await mkdir(path.join(evidence, 'worktree'));
  await writeFile(path.join(evidence, 'artifacts', 'result.json'), '{"revision":"original"}\n');
  await writeFile(path.join(evidence, 'worktree', 'source.ts'), 'source\n');
  await writeFile(path.join(root, 'outside.txt'), 'outside secret');
  await symlink(path.join(root, 'outside.txt'), path.join(evidence, 'outside-link'));
  return { root, evidence };
}

async function run(workingDirectory: string, args: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const application = vi.fn();
  const code = await runOperatorCommand({
    args: ['evidence', ...args],
    workingDirectory,
    environment: {},
    output: { write: (text) => stdout.push(text) },
    diagnostics: { write: (text) => stderr.push(text) },
    application,
  });
  expect(application).not.toHaveBeenCalled();
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('evidence CLI helpers', () => {
  it('inventories retained artifacts without reading the checkout and reports omissions', async () => {
    const { root } = await fixture();
    const result = await run(root, ['list', 'evidence']);
    expect(result.code).toBe(0);
    const inventory = JSON.parse(result.stdout);
    expect(inventory.files).toEqual([{ path: 'artifacts/result.json', bytes: 24 }]);
    expect(inventory.omitted.map((entry: { path: string }) => entry.path).sort()).toEqual([
      'outside-link',
      'worktree',
    ]);
    expect(JSON.parse(result.stderr)).toMatchObject({
      event: 'evidence-helper',
      operation: 'list',
      files: 1,
      omittedPaths: 2,
      failures: 0,
      bytesRead: 0,
      stdoutBytes: Buffer.byteLength(result.stdout),
    });
    const checkout = await run(root, ['list', 'evidence', 'worktree']);
    expect(JSON.parse(checkout.stdout).files).toEqual([{ path: 'worktree/source.ts', bytes: 7 }]);
  });

  it('returns original text and preserves successful reads alongside missing files', async () => {
    const { root, evidence } = await fixture();
    const original = await readFile(path.join(evidence, 'artifacts/result.json'), 'utf8');
    const result = await run(root, ['read', 'evidence', 'missing.md', 'artifacts/result.json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).files).toEqual([
      { path: 'missing.md', error: expect.stringContaining('ENOENT') },
      {
        path: 'artifacts/result.json',
        bytes: Buffer.byteLength(original),
        contentBytes: Buffer.byteLength(original),
        truncated: false,
        content: original,
      },
    ]);
    expect(JSON.parse(result.stderr)).toMatchObject({
      requestedPaths: 2,
      files: 1,
      failures: 1,
      sourceBytes: Buffer.byteLength(original),
      bytesRead: Buffer.byteLength(original),
      contentBytes: Buffer.byteLength(original),
    });
    expect(result.stderr).not.toContain(original.trim());
  });

  it('bounds reads, marks truncation and never returns a partial UTF-8 character', async () => {
    const { root, evidence } = await fixture();
    await writeFile(path.join(evidence, 'large.txt'), 'x'.repeat(70_000));
    const bounded = await run(root, ['read', 'evidence', 'large.txt']);
    expect(JSON.parse(bounded.stdout).files[0]).toMatchObject({
      bytes: 70_000,
      contentBytes: 65_536,
      truncated: true,
    });
    expect(JSON.parse(bounded.stderr)).toMatchObject({ bytesRead: 65_536, truncatedFiles: 1 });
    await writeFile(path.join(evidence, 'unicode.txt'), 'aéz');
    const limited = await run(root, ['read', 'evidence', 'unicode.txt', '--max-bytes', '2']);
    expect(limited.code).toBe(0);
    expect(JSON.parse(limited.stdout).files[0]).toMatchObject({
      content: 'a',
      contentBytes: 1,
      bytes: 4,
      truncated: true,
    });
    expect(JSON.parse(limited.stderr)).toMatchObject({
      bytesRead: 2,
      contentBytes: 1,
      truncatedFiles: 1,
    });
    const complete = await run(root, ['read', 'evidence', 'unicode.txt', '--max-bytes', '4']);
    expect(JSON.parse(complete.stdout).files[0]).toMatchObject({
      content: 'aéz',
      truncated: false,
    });
  });

  it('rejects traversal and escaping symlinks without exposing outside contents', async () => {
    const { root } = await fixture();
    const result = await run(root, [
      'read',
      'evidence',
      '../outside.txt',
      'outside-link',
      'artifacts/result.json',
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).files.slice(0, 2)).toEqual([
      { path: '../outside.txt', error: expect.stringContaining('outside the evidence root') },
      { path: 'outside-link', error: expect.stringContaining('outside the evidence root') },
    ]);
    expect(result.stdout + result.stderr).not.toContain('outside secret');
    expect(JSON.parse(result.stderr)).toMatchObject({ failures: 2, files: 1 });
    const listing = await run(root, ['list', 'evidence', '../']);
    expect(listing.code).toBe(1);
    expect(JSON.parse(listing.stderr)).toMatchObject({ event: 'evidence-helper', failures: 1 });
  });

  it('reports binary files and directories individually while reading the remaining file', async () => {
    const { root, evidence } = await fixture();
    await writeFile(path.join(evidence, 'binary.bin'), Buffer.from([0xff, 0xfe]));
    const result = await run(root, [
      'read',
      'evidence',
      'binary.bin',
      'artifacts',
      'artifacts/result.json',
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ failures: 2, files: 1, bytesRead: 26 });
    expect(JSON.parse(result.stdout).files[2].content).toBe('{"revision":"original"}\n');
  });

  it('rejects incomplete commands and invalid limits before accessing files', async () => {
    const { root } = await fixture();
    for (const args of [
      [],
      ['list'],
      ['read', 'evidence'],
      ['read', 'evidence', 'file', '--max-bytes', '0'],
      ['read', 'evidence', 'file', '--max-bytes', '1.5'],
      ['list', 'evidence', '--unknown'],
    ]) {
      const result = await run(root, args);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
    }
  });
});
