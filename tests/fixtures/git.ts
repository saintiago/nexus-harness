/**
 * The private Git environment every fixture's own commits are made in: the
 * developer's hooks, signing, ignore rules and identity must not change what a
 * test observes, and a machine's own Git configuration must not decide whether
 * a fixture commits.
 *
 * The identity is the only part a suite chooses; the rest of the environment is
 * the same one every suite used to build by hand.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempDir } from '../support.js';

/** Who a fixture's own commits are made as. */
export interface FixtureIdentity {
  readonly name: string;
  readonly email: string;
}

/** One private Git environment, in a temporary directory of its own. */
export async function gitFixtureEnvironment(
  identity: FixtureIdentity = { name: 'Harness Test', email: 'harness@example.test' },
): Promise<NodeJS.ProcessEnv> {
  const directory = await createTempDir();
  const emptyConfig = path.join(directory, 'empty.gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}
