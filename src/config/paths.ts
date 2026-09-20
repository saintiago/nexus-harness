/**
 * The two file names the configuration contract is made of, in one place so the
 * loader, the schemas' diagnostics, and the CLI spell them the same way.
 *
 * One Nexus-wide harness configuration says how this instance runs work; one
 * project configuration, in each connected repository's own root, says what that
 * repository is (docs/WORKFLOW.md §1).
 */
import path from 'node:path';

/** The Nexus-wide harness configuration, handed to every command as `--config`. */
export const HARNESS_CONFIG_FILE_NAME = 'nexus.config.json';

/** The project configuration a connected repository carries at its root. */
export const PROJECT_CONFIG_FILE_NAME = 'nexus.project.json';

/** Where one connected project's configuration lives: `<root>/nexus.project.json`. */
export function projectConfigFile(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_CONFIG_FILE_NAME);
}
