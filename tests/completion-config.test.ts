/**
 * The review-to-completion configuration, which the two files share: the
 * Nexus-wide harness configuration names the reviewer that gates the work, and
 * the connected project names the workflows and the statuses its own items move
 * between.
 *
 * The point of every rejection here is the same: a configuration that does not
 * name the reviewer, the check, the two statuses, and at least one expected
 * post-merge workflow cannot be read as evidence that CI passed, so the harness
 * refuses it instead of completing something nobody described.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfiguration } from '../src/config/load.js';
import { HARNESS_CONFIG_FILE_NAME, PROJECT_CONFIG_FILE_NAME } from '../src/config/paths.js';
import { COMPLETION_DEFAULTS } from '../src/config/schema.js';
import type { HarnessConfig } from '../src/shared/types.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedHarnessConfig,
  documentedProjectConfig,
  writeJsonFile,
  type JsonObject,
} from './support.js';

afterEach(cleanupTempDirectories);

const SOURCE = {
  type: 'jira',
  siteUrl: 'https://example.atlassian.net',
  cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
  projectKey: 'HARN',
  tokenEnv: 'JIRA_API_TOKEN',
};

/** The Nexus-wide reviewer identity and the harness's own polling bounds. */
const POLICY = {
  lensApp: 'nexus-lens',
  lensAppId: 123,
  lensCheckName: 'Nexus Lens',
  reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
};

/** One project's completion outcomes: its own workflows and its own statuses. */
const COMPLETION = {
  postMergeWorkflows: ['ci.yml'],
  toDoStatus: 'To Do',
  doneStatus: 'Done',
};

function harnessWith(overrides: JsonObject = {}): JsonObject {
  return { ...documentedHarnessConfig, completion: POLICY, ...overrides };
}

function projectWith(delivery: unknown = {}, source: unknown = SOURCE): JsonObject {
  return {
    ...documentedProjectConfig,
    ...(source === null ? {} : { source: source as JsonObject }),
    delivery: {
      type: 'github',
      repository: 'owner/name',
      baseBranch: 'main',
      ...(delivery as JsonObject),
    },
  };
}

async function load(
  delivery: unknown = {},
  source: unknown = SOURCE,
  harness: JsonObject = {},
): Promise<HarnessConfig> {
  const directory = await createTempDir();
  const harnessPath = await writeJsonFile(
    directory,
    HARNESS_CONFIG_FILE_NAME,
    harnessWith(harness),
  );
  const projectPath = await writeJsonFile(
    directory,
    PROJECT_CONFIG_FILE_NAME,
    projectWith(delivery, source),
  );
  return (await loadConfiguration(harnessPath, projectPath)).config;
}

async function rejection(
  delivery: unknown = {},
  source: unknown = SOURCE,
  harness: JsonObject = {},
): Promise<ConfigError> {
  const cause = await load(delivery, source, harness).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(cause instanceof ConfigError)) {
    throw new Error(`expected a ConfigError, received ${String(cause)}`);
  }
  return cause;
}

describe('delivery without completion', () => {
  it('loads exactly as before, with no completion object', async () => {
    const config = await load({}, null);
    expect(config.delivery).toEqual({
      type: 'github',
      repository: 'owner/name',
      baseBranch: 'main',
    });
    expect(config.delivery?.completion).toBeUndefined();
  });

  it('rejects a project completion object that carries an empty completion list', async () => {
    const error = await rejection({ completion: { ...COMPLETION, postMergeWorkflows: [] } });
    expect(error.message).toMatch(
      /postMergeWorkflows must name at least one expected post-merge workflow/,
    );
  });

  it('rejects a completion object with no postMergeWorkflows at all', async () => {
    const rest: Record<string, unknown> = { ...COMPLETION };
    delete rest['postMergeWorkflows'];
    const error = await rejection({ completion: rest });
    expect(error.message).toMatch(/postMergeWorkflows/);
  });
});

describe('delivery with completion', () => {
  it('loads the harness polling defaults and keeps the project workflow', async () => {
    const config = await load({ completion: COMPLETION });
    expect(config.delivery?.completion).toEqual({
      lensApp: POLICY.lensApp,
      lensAppId: POLICY.lensAppId,
      lensCheckName: POLICY.lensCheckName,
      reviewerTokenEnv: POLICY.reviewerTokenEnv,
      ...COMPLETION,
      pollIntervalSeconds: COMPLETION_DEFAULTS.pollIntervalSeconds,
      deadlineSeconds: COMPLETION_DEFAULTS.deadlineSeconds,
    });
  });

  it('names the reviewer credential as its own environment variable, never a value', async () => {
    const config = await load({ completion: COMPLETION });
    expect(config.delivery?.completion?.reviewerTokenEnv).toBe('NEXUS_LENS_TOKEN');
    expect(JSON.stringify(config)).not.toContain('token-value');
  });

  it('takes the harness polling bounds when they are declared', async () => {
    const config = await load({ completion: COMPLETION }, SOURCE, {
      completion: { ...POLICY, pollIntervalSeconds: 5, deadlineSeconds: 60 },
    });
    expect(config.delivery?.completion?.pollIntervalSeconds).toBe(5);
    expect(config.delivery?.completion?.deadlineSeconds).toBe(60);
  });

  it.each([
    [
      'a blank reviewerTokenEnv',
      { reviewerTokenEnv: ' ' },
      /reviewerTokenEnv must be an environment-variable name/,
    ],
    [
      'a reviewerTokenEnv that is not a name',
      { reviewerTokenEnv: 'not-a-name!' },
      /reviewerTokenEnv must be an environment-variable name/,
    ],
    ['a blank lensCheckName', { lensCheckName: ' ' }, /lensCheckName must not be blank/],
    ['an operator credential variable', { reviewerTokenEnv: 'GH_TOKEN' }, /separate/],
    ['a zero App ID', { lensAppId: 0 }, /positive integer/],
    ['a blank lensApp', { lensApp: '' }, /lensApp must not be blank/],
    [
      'a zero poll interval',
      { pollIntervalSeconds: 0 },
      /pollIntervalSeconds must be an integer of at least 5/,
    ],
  ])('rejects %s in the harness configuration', async (_, override, problem) => {
    const error = await rejection({ completion: COMPLETION }, SOURCE, {
      completion: { ...POLICY, ...override },
    });
    expect(error.message).toMatch(/completion/);
    expect(error.message).toMatch(problem);
  });

  it.each([
    ['a workflow display name', { postMergeWorkflows: ['CI'] }, /workflow file/],
    [
      'a blank workflow entry',
      { postMergeWorkflows: [' '] },
      /postMergeWorkflows entries must be a workflow file name/,
    ],
    ['a blank toDoStatus', { toDoStatus: ' ' }, /toDoStatus must not be blank/],
    ['an unknown field', { unexpected: true }, /unexpected/],
  ])('rejects %s in the project configuration', async (_, override, problem) => {
    const error = await rejection({ completion: { ...COMPLETION, ...override } });
    expect(error.message).toMatch(problem);
  });

  it.each([
    ['the To Do status is the review status', { toDoStatus: 'In Review' }],
    ['the Done status is the review status', { doneStatus: 'In Review' }],
    ['both outcomes are the same status', { toDoStatus: 'Done' }],
  ])('rejects a completion object where %s', async (_, override) => {
    const error = await rejection({ completion: { ...COMPLETION, ...override } });
    expect(error.message).toMatch(/toDoStatus|doneStatus/);
  });

  it('accepts a completion object with no source configured', async () => {
    // Without a source the statuses cannot be compared, and the object is only
    // usable by a source command anyway; validation still accepts it.
    const config = await load({ completion: COMPLETION }, null);
    expect(config.delivery?.completion?.doneStatus).toBe('Done');
  });

  it('accepts a workflow identifier given as a numeric ID', async () => {
    const config = await load({
      completion: { ...COMPLETION, postMergeWorkflows: ['17', '.github/workflows/ci.yml'] },
    });
    expect(config.delivery?.completion?.postMergeWorkflows).toEqual([
      '17',
      '.github/workflows/ci.yml',
    ]);
  });
});
