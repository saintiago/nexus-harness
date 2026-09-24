import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { messageOf } from '../../result.js';
import { readRecord, writeRecord, type RecordContent, type RecordDeclaration } from './records.js';

/**
 * The small filesystem functions the round planners share: reading a planner's own current-plan
 * record, creating the next numbered directory, listing retained numbered history and persisting a
 * plan. They choose no roles, count no repairs, judge no feedback and decide no workflow routes;
 * StartDevRound owns finite delivery's policy and StartIdeaRound owns the idea-cycle policy.
 */

/** Read a planner's current plan through its own declaration; null before the first plan exists. */
export async function readCurrentPlan<Declaration extends RecordDeclaration>(
  filePath: string,
  declaration: Declaration,
): Promise<RecordContent<Declaration> | null> {
  return readRecord(filePath, declaration);
}

/** Persist a planner's plan record, creating the directory that holds it. */
export async function saveCurrentPlan(filePath: string, plan: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeRecord(filePath, plan);
}

/** Create the numbered history directory under a root and return its path. */
export async function ensureRoundDirectory(root: string, number: number): Promise<string> {
  const directory = path.join(root, String(number));
  await mkdir(directory, { recursive: true });
  return directory;
}

/** The positive whole-number directory names under a history root, in ascending order. */
export async function listNumberedHistory(root: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(`History at "${root}" could not be read: ${messageOf(error)}`, {
      cause: error,
    });
  }
  return entries
    .filter((entry) => /^[1-9][0-9]*$/u.test(entry))
    .map(Number)
    .sort((left, right) => left - right);
}
