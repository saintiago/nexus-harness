import { mkdir } from 'node:fs/promises';
import { run } from '../adapters/processes.js';

/**
 * Prepare the operational workspace's worktree. The configured Codex provider refuses to
 * start in a working directory outside a Git repository, so the worktree is initialized as an
 * empty repository; `git init` is idempotent for a later invocation of the same
 * execution.
 */
export async function prepareOperationalWorktree(
  directory: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const diagnostics: Uint8Array[] = [];
  const result = await run(
    { executable: 'git', args: ['init', '--quiet'], directory, environment },
    (output) => {
      if (output.stream === 'stderr') {
        diagnostics.push(output.chunk);
      }
    },
  );
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  if (result.value.exitCode !== 0) {
    const detail = Buffer.concat(diagnostics).toString('utf8').trim();
    throw new Error(
      `git init exited with code ${String(result.value.exitCode)}` +
        (detail === '' ? '' : `: ${detail}`),
    );
  }
}
