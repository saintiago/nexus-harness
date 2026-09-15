/**
 * Reading and validating the two JSON inputs.
 *
 * Inputs are rejected rather than repaired: no value is coerced, no key is
 * ignored, no environment variable is interpolated, and no field is defaulted.
 * docs/WORKFLOW.md defines the input contract.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HarnessConfig, Task } from './types.js';

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

/** A string that is present and contains something other than whitespace. */
function nonBlankString(field: string): z.ZodString {
  return z.string().refine((value) => value.trim().length > 0, {
    error: `${field} must not be blank`,
  });
}

/** A bounded integer. Fractional, non-finite and non-numeric values are rejected. */
function boundedInteger(field: string, minimum: number, requirement: string): z.ZodNumber {
  return z
    .int({ error: `${field} must be an integer` })
    .min(minimum, { error: `${field} must be ${requirement}` });
}

/**
 * An executable plus literal arguments. The list is never empty and the first
 * item is the executable, so a blank entry cannot become a shell call.
 */
const commandSchema = z
  .array(z.string(), { error: 'must be an array of string arguments' })
  .min(1, { error: 'must not be empty; the first item is the executable' })
  .refine((command) => command.length === 0 || (command[0] ?? '').trim().length > 0, {
    error: 'the first item must be a nonblank executable',
    path: [0],
  });

export const harnessConfigSchema = z.strictObject({
  workDir: nonBlankString('workDir'),
  maxRepairs: boundedInteger('maxRepairs', 0, 'a nonnegative integer'),
  taskTimeoutMinutes: boundedInteger('taskTimeoutMinutes', 1, 'a positive integer'),
  commandTimeoutMinutes: boundedInteger('commandTimeoutMinutes', 1, 'a positive integer'),
  setup: z.array(commandSchema, { error: 'must be an array of command arrays' }),
  checks: z
    .array(commandSchema, { error: 'must be an array of command arrays' })
    .min(1, { error: 'must contain at least one command' }),
});

export const taskSchema = z.strictObject({
  id: nonBlankString('id'),
  title: nonBlankString('title'),
  description: nonBlankString('description'),
  acceptanceCriteria: z
    .array(nonBlankString('acceptanceCriteria item'), {
      error: 'must be an array of nonblank strings',
    })
    .min(1, { error: 'must contain at least one acceptance criterion' }),
});

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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Reads and validates a harness configuration file. */
export async function loadHarnessConfig(configPath: string): Promise<HarnessConfig> {
  const raw = await readJson(configPath);
  const result = harnessConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(configPath, describeIssues(result.error));
  }
  return result.data;
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
