import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Render a thrown value as a message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validate a parsed configuration document, naming its owner in the failure. */
export function validate<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
  source: string,
): Output {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const location = issue.path.length > 0 ? issue.path.join('.') : '<document>';
        return `${location}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Invalid ${source}: ${issues}`);
  }
  return result.data;
}

/** Read and JSON-parse a configuration document. */
export async function readDocument(filePath: string, kind: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${kind} configuration ${filePath}: ${messageOf(error)}`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${kind} configuration ${filePath} is not valid JSON: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

/** Freeze a resolved settings value, including nested objects and arrays. */
export function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Resolve a path-valued executable against the directory of its owning configuration file. A bare
 * command name stays a PATH lookup and an absolute path is already resolved.
 */
export function resolveExecutable(executable: string, directory: string): string {
  return executable.includes('/') && !path.isAbsolute(executable)
    ? path.resolve(directory, executable)
    : executable;
}
