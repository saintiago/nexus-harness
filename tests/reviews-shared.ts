/**
 * The fixtures the two halves of the review suite share.
 *
 * `tests/reviews.test.ts` decides what one review scan publishes against fakes
 * that answer from memory; `tests/reviews-cli.integration.test.ts` runs the same
 * path through the built CLI, a real retained workspace and a stand-in runtime.
 * Both start from the same ticket, pull request, patch and configuration, and
 * both read the same verdict file back, so those constructions live here rather
 * than being declared twice — or left in whichever file happened to need them
 * first, which is what made the review suite one mixed file.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../src/config/paths.js';
import type {
  OpenPullRequest,
  ReviewEvidence,
  ReviewVerdict,
  ReviewView,
} from '../src/reviews/contract.js';
import { REVIEW_VIEW_DIRECTORY } from '../src/reviews/view.js';
import type { SourceCandidate, SourceTask } from '../src/sources/contract.js';
import type { SourceRef, Task } from '../src/shared/types.js';
import { canonicalPath } from '../src/workspace/git.js';
import { sourceItemFor, workspaceStatePath } from '../src/workspace/state.js';
import type { WorkspaceState } from '../src/workspace/state.js';
import { documentedHarnessConfig, documentedProjectConfig, writeJsonFile } from './support.js';

export const SCOPE = 'https://example.atlassian.net';
export const REPOSITORY = 'example-owner/example-repo';
export const LOGIN = 'nexus-lens[bot]';
export const CHECK_NAME = 'Nexus Lens review';
export const HEAD = 'a'.repeat(40);
export const OTHER_HEAD = 'b'.repeat(40);
export const BASE = 'c'.repeat(40);
export const WORKSPACE_ID = 'run-20260919100148-e48a9ab0';
/** The one pointer label the fixtures use to name the ticket's workspace. */
export const WORKSPACE_LABEL = `harness-ws-${WORKSPACE_ID}`;
export const BRANCH = `harness/${WORKSPACE_ID}`;

export function refFor(key = 'HARN-3', id = '10003'): SourceRef {
  return {
    type: 'jira',
    scope: SCOPE,
    id,
    key,
    url: `${SCOPE}/browse/${key}`,
    updatedAt: '2026-09-19T12:00:00.000Z',
  };
}

export function taskFor(key = 'HARN-3'): Task {
  return {
    id: key,
    title: 'Add the greeting feature',
    description: 'Implement the greeting the ticket describes.',
    acceptanceCriteria: ['The greeting is implemented.', 'The tests cover it.'],
  };
}

export function candidateFor(key = 'HARN-3'): SourceCandidate {
  return { ref: refFor(key), title: taskFor(key).title };
}

export function preparedFor(
  key = 'HARN-3',
  pointers: readonly string[] = ['run-20260919100148-e48a9ab0'],
): SourceTask {
  return { ref: refFor(key), task: taskFor(key), pointers };
}

/** The ownership record intake leaves beside a retained workspace. */
export async function writeReviewLedger(
  workDir: string,
  overrides: Partial<WorkspaceState> = {},
): Promise<void> {
  const state: WorkspaceState = {
    version: 1,
    workspaceId: WORKSPACE_ID,
    sourceRoot: canonicalPath(path.dirname(workDir)),
    baseCommit: BASE,
    branch: BRANCH,
    createdAt: '2026-09-19T12:00:00.000Z',
    sourceItem: sourceItemFor(refFor()),
    attempts: [],
    ...overrides,
  };
  await mkdir(path.join(workDir, 'workspaces', WORKSPACE_ID), { recursive: true });
  await writeFile(workspaceStatePath(workDir, WORKSPACE_ID), JSON.stringify(state), 'utf8');
}

export function pullFor(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    number: 27,
    url: `https://github.com/${REPOSITORY}/pull/27`,
    title: 'HARN-3: Add the greeting feature',
    headSha: HEAD,
    headBranch: BRANCH,
    baseBranch: 'main',
    baseSha: BASE,
    draft: false,
    author: 'example-owner',
    ...overrides,
  };
}

/** The one file patch every evidence fixture carries. */
export const PATCH = [
  '@@ -0,0 +1,3 @@',
  '+export function greetAll(names) {',
  '+  return names;',
  '+}',
].join('\n');

export function evidenceFor(pullRequest: OpenPullRequest = pullFor()): ReviewEvidence {
  return {
    ref: refFor(),
    task: taskFor(),
    pullRequest,
    files: [
      { path: 'src/greet-all.mjs', patch: PATCH, additions: 3, deletions: 0 },
      { path: 'src/greet.mjs', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 },
    ],
    truncated: false,
    checks: [{ name: 'validate', status: 'completed', conclusion: 'success' }],
    combinedStatus: 'success',
    fetchedAt: '2026-09-19T12:00:00.000Z',
  };
}

/** The repository view one review of the fixtures inspects. */
export function viewFor(dir = '/evidence/review-20260919120000-12345678'): ReviewView {
  return { path: path.join(dir, REVIEW_VIEW_DIRECTORY), head: HEAD, base: BASE };
}

export const APPROVE: ReviewVerdict = {
  decision: 'approve',
  summary: 'The change implements the ticket and its tests.',
  findings: [],
};

export const REQUEST_CHANGES: ReviewVerdict = {
  decision: 'request_changes',
  summary: 'The feature is incomplete.',
  findings: [
    { path: 'src/greet-all.mjs', line: 1, body: 'The exported function ignores the names.' },
    { path: 'src/other.mjs', line: 2, body: 'This file was not part of the change.' },
  ],
};

/** A verdict as the reviewer's file carries it: `verdict` is its own word. */
export function verdictFile(verdict: ReviewVerdict): string {
  return JSON.stringify({
    verdict: verdict.decision,
    summary: verdict.summary,
    findings: verdict.findings,
  });
}

export async function reviewDirectories(workDir: string): Promise<string[]> {
  const root = path.join(workDir, 'reviews');
  if (!existsSync(root)) {
    return [];
  }
  return (await readdir(root)).filter((name) => name.startsWith('review-'));
}

/** The Nexus-wide reviewer integration of the fixture, before any override. */
export function fixtureReviewer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: {
      appId: 5001141,
      installationId: 163007360,
      privateKeyPathEnv: 'NEXUS_LENS_KEY_PATH',
      login: LOGIN,
    },
    reviewer: { runtime: 'codex', command: ['codex', '--profile', 'nexus-astra'] },
    ...overrides,
  };
}

/** The Nexus-wide harness configuration of the fixture, before any override. */
export function harnessConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...documentedHarnessConfig,
    agent: { runtime: 'codex', command: ['codex'] },
    reviewer: fixtureReviewer(overrides['reviewer'] as Record<string, unknown> | undefined),
    ...(overrides['extra'] as Record<string, unknown> | undefined),
  };
}

/** The connected project's own configuration of the fixture, before any override. */
export function projectConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    setup: [],
    checks: documentedProjectConfig.checks,
    source: {
      type: 'jira',
      siteUrl: SCOPE,
      cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
      projectKey: 'SAM1',
      tokenEnv: 'JIRA_API_TOKEN',
    },
    delivery: { type: 'github', repository: REPOSITORY, baseBranch: 'main' },
    ...(overrides['extra'] as Record<string, unknown> | undefined),
  };
}

/**
 * Writes the two configuration files the fixture is made of and returns their
 * paths: the Nexus-wide harness configuration, and the connected project's own
 * configuration in the directory a command reads it from.
 */
export async function writeFixtureConfig(
  directory: string,
  harnessOverrides: Record<string, unknown> = {},
  project: Record<string, unknown> = projectConfig(),
): Promise<{ harnessPath: string; projectPath: string }> {
  return {
    harnessPath: await writeJsonFile(
      directory,
      HARNESS_CONFIG_FILE_NAME,
      harnessConfig(harnessOverrides),
    ),
    projectPath: await writeJsonFile(directory, PROJECT_CONFIG_FILE_NAME, project),
  };
}

export const REVIEWED_SOURCE = ['export function greetAll(names) {', '  return names;', '}', ''].join(
  '\n',
);
/** The one file the fixture's pull request changes. */
export const REVIEWED_FILE = 'src/greet-all.mjs';

/** One file the reviewed head really carries, beyond the fixture's own. */
export interface ReviewedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Creates the retained workspace the ticket's pointer names, as the coding run
 * and its delivery step would have left it: a clone on the branch
 * `harness/<workspaceId>`, whose head the pull request's head names and whose
 * history holds the change's base commit. Returns the two commits so the fake
 * world can report them.
 */
