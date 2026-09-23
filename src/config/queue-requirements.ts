/**
 * What a configuration has to carry for a queue to be one.
 *
 * A queue completes a ticket through a chain of three configured pieces — the
 * Jira source it takes work from, the delivery destination it opens a pull
 * request against, and the completion policy that ends the item — so a
 * configuration that cannot complete one is refused before any credential is
 * resolved. The loader already refuses a completion policy whose App, login, or
 * check disagrees with the configured reviewer; what is left is that all three
 * objects are there, because other commands treat them as optional.
 *
 * It lives here, and not beside a command, so that the supervisor can ask the
 * same question without loading the queue's own module — the parent has to be
 * able to run while the queue it supervises cannot.
 */
import type { HarnessConfig } from '../shared/types.js';

export function queueConfigurationProblem(
  config: HarnessConfig,
  harnessPath: string,
  projectPath: string,
): string | null {
  if (config.source === undefined) {
    return (
      `${projectPath} has no "source" object, so there is no queue to take tickets from ` +
      '(docs/WORKFLOW.md section 5).'
    );
  }
  if (config.delivery === undefined) {
    return (
      `${projectPath} has no "delivery" object, so a passed attempt would stay local and no pull ` +
      'request could be completed. A queue command needs one; docs/WORKFLOW.md section 8 defines it.'
    );
  }
  if (config.review === undefined) {
    return (
      `${harnessPath} has no "reviewer" object, so a ticket could never be reviewed before it is ` +
      'completed. A queue command needs the Nexus-wide reviewer integration; docs/WORKFLOW.md ' +
      'section 9 defines it.'
    );
  }
  const delivery = config.delivery;
  if (delivery.completion === undefined) {
    return (
      `${projectPath} configures "delivery" without "delivery.completion", so nothing would ever ` +
      'mark a ticket Done. A queue command needs that object; docs/WORKFLOW.md section 10 defines ' +
      'it.'
    );
  }
  return null;
}
