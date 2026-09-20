/**
 * The `delivery.completion` configuration: what turns the review-to-completion
 * path on, and what must be there before it may be on at all.
 *
 * The point of every rejection here is the same: a configuration that does not
 * name the reviewer, the check, the two statuses, and at least one expected
 * post-merge workflow cannot be read as evidence that CI passed, so the harness
 * refuses it instead of completing something nobody described.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadHarnessConfig } from '../src/config/load.js';
import { COMPLETION_DEFAULTS } from '../src/config/schema.js';
import type { HarnessConfig } from '../src/shared/types.js';
import {
  cleanupTempDirectories,
  createTempDir,
  documentedConfig,
  writeJsonFile,
} from './support.js';
import type { JsonObject } from './support.js';

afterEach(cleanupTempDirectories);

const SOURCE = {
  type: 'jira',
  siteUrl: 'https://example.atlassian.net',
  cloudId: '9337c4da-7d33-4c1d-b03c-db207e537f88',
  projectKey: 'HARN',
  tokenEnv: 'JIRA_API_TOKEN',
};

const COMPLETION = {
  lensApp: 'nexus-lens',
  lensCheckName: 'Nexus Lens',
  reviewerTokenEnv: 'NEXUS_LENS_TOKEN',
  postMergeWorkflows: ['ci.yml'],
  toDoStatus: 'To Do',
  doneStatus: 'Done',
};

function configWith(delivery: unknown, source: unknown = SOURCE): JsonObject {
  return {
    ...documentedConfig,
    ...(source === null ? {} : { source: source as JsonObject }),
    delivery: {
      type: 'github',
      repository: 'owner/name',
      baseBranch: 'main',
      ...(delivery as JsonObject),
    },
  };
}

async function load(value: unknown): Promise<HarnessConfig> {
  const directory = await createTempDir();
  return loadHarnessConfig(await writeJsonFile(directory, 'harness.config.json', value));
}

async function rejection(value: unknown): Promise<ConfigError> {
  const cause = await load(value).then(
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
    const config = await load(configWith({}, null));
    expect(config.delivery).toEqual({
      type: 'github',
      repository: 'owner/name',
      baseBranch: 'main',
    });
    expect(config.delivery?.completion).toBeUndefined();
  });

  it('rejects a delivery object that carries an empty completion list', async () => {
    const error = await rejection(
      configWith({ completion: { ...COMPLETION, postMergeWorkflows: [] } }),
    );
    expect(error.message).toMatch(
      /postMergeWorkflows must name at least one expected post-merge workflow/,
    );
  });

  it('rejects a completion object with no postMergeWorkflows at all', async () => {
    const rest: Record<string, unknown> = { ...COMPLETION };
    delete rest['postMergeWorkflows'];
    const error = await rejection(configWith({ completion: rest }));
    expect(error.message).toMatch(/postMergeWorkflows/);
  });
});

describe('delivery with completion', () => {
  it('loads the documented defaults and keeps the named workflow', async () => {
    const config = await load(configWith({ completion: COMPLETION }));
    const completion = config.delivery?.completion;
    expect(completion).toEqual({
      ...COMPLETION,
      lensReviewContext: COMPLETION_DEFAULTS.lensReviewContext,
      pollIntervalSeconds: COMPLETION_DEFAULTS.pollIntervalSeconds,
      deadlineSeconds: COMPLETION_DEFAULTS.deadlineSeconds,
    });
  });

  it('names the reviewer credential as its own environment variable, never a value', async () => {
    const config = await load(configWith({ completion: COMPLETION }));
    expect(config.delivery?.completion?.reviewerTokenEnv).toBe('NEXUS_LENS_TOKEN');
    expect(JSON.stringify(config)).not.toContain('token-value');
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
    ['a blank lensApp', { lensApp: '' }, /lensApp must not be blank/],
    [
      'a blank workflow entry',
      { postMergeWorkflows: [' '] },
      /postMergeWorkflows entries must be a workflow file name/,
    ],
    ['an unknown field', { doneStatus: 'Done', unexpected: true }, /unexpected/],
  ])('rejects %s', async (_, override, problem) => {
    const error = await rejection(configWith({ completion: { ...COMPLETION, ...override } }));
    expect(error.message).toMatch(problem);
  });

  it.each([
    ['the To Do status is the review status', { toDoStatus: 'In Review' }],
    ['the Done status is the review status', { doneStatus: 'In Review' }],
    ['both outcomes are the same status', { toDoStatus: 'Done' }],
  ])('rejects a completion object where %s', async (_, override) => {
    const error = await rejection(configWith({ completion: { ...COMPLETION, ...override } }));
    expect(error.message).toMatch(/toDoStatus|doneStatus/);
  });

  it('accepts a completion object with no source configured', async () => {
    // Without a source the statuses cannot be compared, and the object is only
    // usable by a source command anyway; validation still accepts it.
    const config = await load(configWith({ completion: COMPLETION }, null));
    expect(config.delivery?.completion?.doneStatus).toBe('Done');
  });

  it('accepts a workflow identifier given as a numeric ID', async () => {
    const config = await load(
      configWith({
        completion: { ...COMPLETION, postMergeWorkflows: ['17', '.github/workflows/ci.yml'] },
      }),
    );
    expect(config.delivery?.completion?.postMergeWorkflows).toEqual([
      '17',
      '.github/workflows/ci.yml',
    ]);
  });
});
