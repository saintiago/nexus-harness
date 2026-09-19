/**
 * Reading and validating the two JSON inputs.
 *
 * Inputs are rejected rather than repaired: no value is coerced, no key is
 * ignored, no environment variable is interpolated, and no field is defaulted.
 * docs/WORKFLOW.md defines the input contract. The schema itself lives in
 * schema.ts; this module reads a file, applies it, resolves the path-valued
 * fields against the configuration file's own directory, and reports every
 * problem under the file name.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import path from 'node:path';
import { messageOf } from '../shared/errors.js';
import type { AgentSelection, EscalationTier, HarnessConfig, Task } from '../shared/types.js';
import { DEFAULT_AGENT_SELECTION, harnessConfigSchema, taskSchema } from './schema.js';

/**
 * A configuration or task input that could not be read or did not validate.
 * `problems` holds one entry per field, ready to print under the file name.
 */
export class ConfigError extends Error {
  readonly file: string;
  readonly problems: readonly string[];

  constructor(file: string, problems: readonly string[]) {
    super([file, ...problems.map((problem) => `  - ${problem}`)].join('\n'));
    this.name = 'ConfigError';
    this.file = file;
    this.problems = problems;
  }
}
/** Whether an executable names a path rather than a bare program name. */
function namesAPath(executable: string): boolean {
  return executable.includes('/') || executable.includes('\\');
}

/**
 * Applies the documented launch-path rules to one selection: a relative
 * path-valued executable resolves against the configuration file's directory,
 * once, before anything is started; an absolute path is used as supplied; a bare
 * name is left alone, for the host launcher's own `PATH` resolution. The
 * remaining arguments are opaque and are never resolved, joined, or expanded
 * (docs/WORKFLOW.md §1, "Agent launch and path rules").
 */
export function resolveAgentSelection(agent: AgentSelection, configPath: string): AgentSelection {
  const [executable = '', ...prefix] = agent.command;
  const resolved =
    namesAPath(executable) && !path.isAbsolute(executable)
      ? path.resolve(path.dirname(path.resolve(configPath)), executable)
      : executable;
  return { runtime: agent.runtime, command: [resolved, ...prefix] };
}
/** Renders `['checks', 0, 1]` as `checks[0][1]`. */
function formatPath(segments: readonly PropertyKey[]): string {
  let formatted = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
    } else if (formatted === '') {
      formatted = String(segment);
    } else {
      formatted += `.${String(segment)}`;
    }
  }
  return formatted;
}

/**
 * Turns Zod issues into `field: what is wrong` lines. Whole-document problems
 * (an unknown top-level key, a root value of the wrong type) carry no path and
 * describe themselves.
 */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = formatPath(issue.path);
    return field === '' ? issue.message : `${field}: ${issue.message}`;
  });
}
async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    throw new ConfigError(file, [`cannot be read: ${messageOf(cause)}`]);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ConfigError(file, [`is not valid JSON: ${messageOf(cause)}`]);
  }
}
/** Reads and validates a harness configuration file. */
export async function loadHarnessConfig(configPath: string): Promise<HarnessConfig> {
  const raw = await readJson(configPath);
  const result = harnessConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(configPath, describeIssues(result.error));
  }
  const { agent, escalation, source, ...rest } = result.data;
  const selection = resolveAgentSelection(agent ?? DEFAULT_AGENT_SELECTION, configPath);
  return {
    ...rest,
    // An explicit selection is used as it is written, paths resolved; a
    // selection that was omitted is the documented ordinary Codex launch.
    agent: selection,
    // A rung that names no launch of its own runs the top-level one, and one
    // that names no allowance spends the top-level one: a ladder says what
    // changes, not everything again.
    ...(escalation === undefined
      ? {}
      : {
          escalation: escalation.map((tier) => ({
            name: tier.name,
            agent: resolveAgentSelection(tier.agent ?? selection, configPath),
            maxRepairs: tier.maxRepairs ?? rest.maxRepairs,
          })),
        }),
    // A configuration without a source stays without one: a file-task command
    // must not acquire a connector, a credential, or intake state because a
    // field it never asked for was given a default (docs/WORKFLOW.md §5).
    ...(source === undefined ? {} : { source }),
  };
}

/**
 * The ladder a source run climbs, whether or not the configuration declared one:
 * a single rung built from `agent` and `maxRepairs` is the ordinary case, and a
 * declared ladder is used as written. The name of the synthesized rung is
 * `default`, which is what a comment calls it when nothing named it.
 */
export function escalationTiers(config: HarnessConfig): readonly EscalationTier[] {
  return (
    config.escalation ?? [{ name: 'default', agent: config.agent, maxRepairs: config.maxRepairs }]
  );
}

/** Reads and validates a task file. */
export async function loadTask(taskPath: string): Promise<Task> {
  const raw = await readJson(taskPath);
  const result = taskSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(taskPath, describeIssues(result.error));
  }
  return result.data;
}

/**
 * Resolves `workDir` against the directory holding the configuration file, so
 * the same config points at the same output directory whatever the process
 * working directory is. An absolute `workDir` is returned unchanged.
 */
export function resolveWorkDir(config: HarnessConfig, configPath: string): string {
  return path.resolve(path.dirname(path.resolve(configPath)), config.workDir);
}
