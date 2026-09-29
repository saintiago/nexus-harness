import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeRecord } from './records.js';

/**
 * The reason one terminal producer states for a failed or exhausted outcome, retained durably in
 * the attempt's own area. A workflow binding reads this producer-owned record when it composes the
 * terminal handoff, so a restarted worker reconstructs the identical handoff instead of relying on
 * an event that lived only in the stopped process. Each producing action owns its own record file
 * and declaration; this module owns the shared content shape and writer.
 */

/** One terminal producer's retained reason. */
export const terminalReasonSchema = z.object({
  reason: z.string().trim().min(1),
});

export type TerminalReason = z.infer<typeof terminalReasonSchema>;

/** Retain one producer's stated reason at its own record file, before the outcome is published. */
export async function retainTerminalReason(file: string, reason: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeRecord(file, { reason } satisfies TerminalReason);
}
