import path from 'node:path';
import { z } from 'zod';
import { deepFreeze, readDocument, resolveExecutable, validate } from './document.js';

/** Required paths and identifiers are nonempty. */
const identifier = z.string().trim().min(1);

/**
 * A command is an executable and its argument array, passed to the process separately. A command
 * that needs shell interpretation names the shell as its executable, for example
 * `{ "executable": "bash", "args": ["-c", "npm ci"] }`.
 */
const commandSchema = z.strictObject({
  executable: identifier,
  args: z.array(z.string()),
});

/** A remote Git source states a URL scheme or scp-like `user@host:path` syntax. */
const remoteSource = /^(?:[a-z][a-z0-9+.-]*:|[^@/\s]+@[^:/\s]+:)/i;

const projectConfigurationSchema = z.strictObject({
  repository: z.strictObject({
    source: identifier,
    mainBranch: identifier,
  }),
  preparation: z.array(commandSchema),
  checks: z.array(
    z.strictObject({
      // A check passes when its command completes successfully.
      name: identifier,
      command: commandSchema,
    }),
  ),
  taskSource: z.strictObject({
    kind: z.literal('jira'),
    // The API base is used verbatim, so a cloud connection's gateway prefix is preserved.
    apiBase: identifier,
    project: identifier,
    credential: identifier,
    selection: z.strictObject({
      query: identifier,
      orderBy: identifier,
    }),
    fields: z.strictObject({
      workspacePointer: identifier,
      pullRequest: identifier,
    }),
    statuses: z.strictObject({
      ready: identifier,
      inProgress: identifier,
      review: identifier,
      done: identifier,
    }),
    // The idea refinement selection and status mappings are separate from the delivery queue's,
    // so submitted ideas never enter the To Do queue.
    ideas: z.strictObject({
      selection: z.strictObject({
        query: identifier,
        orderBy: identifier,
      }),
      statuses: z.strictObject({
        submitted: identifier,
        active: identifier,
        approved: identifier,
        waitingForFeedback: identifier,
      }),
    }),
  }),
  delivery: z.strictObject({
    repository: identifier,
    baseBranch: identifier,
    reviewCheck: identifier,
    postMergeChecks: z.array(
      z.strictObject({
        name: identifier,
        workflow: identifier,
      }),
    ),
    completion: z.strictObject({
      // Durations state their unit in the setting name and are nonnegative.
      pollIntervalSeconds: z.number().nonnegative(),
      waitLimitSeconds: z.number().nonnegative(),
    }),
  }),
});

export type Command = z.infer<typeof commandSchema>;
export type ProjectConfiguration = z.infer<typeof projectConfigurationSchema>;

/** Resolve a command's path-valued executable, leaving its opaque argument text unchanged. */
function resolveCommand(command: Command, directory: string): Command {
  return { ...command, executable: resolveExecutable(command.executable, directory) };
}

/** Validate and resolve project configuration from a parsed JSON value. */
export function parseProjectConfiguration(
  value: unknown,
  configDirectory: string,
): ProjectConfiguration {
  const configuration = validate(projectConfigurationSchema, value, 'project configuration');
  return resolveProjectConfiguration(configuration, path.resolve(configDirectory));
}

/** Read, validate and resolve a project configuration file. */
export async function loadProjectConfiguration(filePath: string): Promise<ProjectConfiguration> {
  const absolute = path.resolve(filePath);
  const value = await readDocument(absolute, 'project');
  const configuration = validate(
    projectConfigurationSchema,
    value,
    `project configuration ${absolute}`,
  );
  return resolveProjectConfiguration(configuration, path.dirname(absolute));
}

/** Resolve path-valued settings against the directory of their owning configuration file. */
function resolveProjectConfiguration(
  configuration: ProjectConfiguration,
  directory: string,
): ProjectConfiguration {
  const source = configuration.repository.source;
  return deepFreeze({
    ...configuration,
    repository: {
      ...configuration.repository,
      source:
        path.isAbsolute(source) || remoteSource.test(source)
          ? source
          : path.resolve(directory, source),
    },
    preparation: configuration.preparation.map((command) => resolveCommand(command, directory)),
    checks: configuration.checks.map((check) => ({
      ...check,
      command: resolveCommand(check.command, directory),
    })),
  });
}
