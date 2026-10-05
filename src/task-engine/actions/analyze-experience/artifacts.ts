import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { observationSchema, receiptStatuses } from '../../../memory/index.js';

/**
 * AnalyzeExperience's data contracts: the terminal handoff a workflow binding supplies, the
 * durable request and capture evidence recorded outside every workflow attempt, the analyst's
 * response and the persisted analysis, submission and attempt records. Identities are opaque
 * work/workflow/attempt/terminal values rather than task-source statuses; revisions belong in the
 * cited evidence, so a failed attempt or a returned idea needs no merge revision.
 */

/** One producer-owned evidence file the binding selected for the terminal handoff. */
export const experienceArtifactRefSchema = z.strictObject({
  path: z.string().trim().min(1),
});

/**
 * One terminal handoff: the work item, workflow, attempt and terminal identities, the outcome the
 * workflow preserves, the reason the workflow recorded and the retained evidence it selected.
 */
export const experienceHandoffSchema = z.strictObject({
  workId: z.string().trim().min(1),
  workflow: z.string().trim().min(1),
  attemptId: z.string().trim().min(1),
  terminalId: z.string().trim().min(1),
  outcome: z.string().trim().min(1),
  reason: z.string().trim().min(1).nullable(),
  workspaceRoot: z.string().trim().min(1),
  artifacts: z.array(experienceArtifactRefSchema),
});

export type ExperienceHandoff = z.infer<typeof experienceHandoffSchema>;

/** The legacy completion-analysis request this store still reads while pending work migrates. */
export const legacyCompletionRequestSchema = z.strictObject({
  taskKey: z.string().trim().min(1),
  project: z.string().trim().min(1),
  completionRevision: z.string().trim().min(1),
  workspaceRoot: z.string().trim().min(1),
  requestedAt: z.iso.datetime({ offset: true }),
});

export type LegacyCompletionRequest = z.infer<typeof legacyCompletionRequestSchema>;

/** One durable experience request: the complete immutable handoff and its capture time. */
export const experienceRequestSchema = z.strictObject({
  identity: z.string().trim().min(1),
  project: z.string().trim().min(1),
  handoff: experienceHandoffSchema,
  /**
   * The directory holding this request's retained copy of the handoff's evidence, or null for a
   * request recorded before retention. The copy keeps the evidence readable after recovery
   * discards or replaces the workflow attempt that produced it.
   */
  evidenceRoot: z.string().trim().min(1).nullable().default(null),
  /**
   * The earlier completion investigation this request migrated from, when it predates the shared
   * action. Its task and revision keep the migrated request's provenance intact.
   */
  migrated: z
    .strictObject({
      taskKey: z.string().trim().min(1),
      completionRevision: z.string().trim().min(1),
    })
    .nullable(),
  requestedAt: z.iso.datetime({ offset: true }),
});

export type ExperienceRequest = z.infer<typeof experienceRequestSchema>;

/** The capture outcomes the action returns and preserves as handoff evidence. */
export const experienceCaptureOutcomes = ['recorded', 'skipped', 'unavailable'] as const;

export type ExperienceCaptureOutcome = (typeof experienceCaptureOutcomes)[number];

/** One capture's durable evidence: the request reference and the capture outcome. */
export const experienceCaptureSchema = z.strictObject({
  identity: z.string().trim().min(1),
  project: z.string().trim().min(1),
  handoff: experienceHandoffSchema,
  outcome: z.enum(experienceCaptureOutcomes),
  /** Why a capture was skipped or unavailable, or null when it was recorded. */
  detail: z.string().trim().min(1).nullable(),
  capturedAt: z.iso.datetime({ offset: true }),
});

export type ExperienceCapture = z.infer<typeof experienceCaptureSchema>;

/**
 * One supporting evidence citation: the retained file, the revision it establishes and what it
 * shows. The full reports stay on disk; the citation binds the observation to its evidence.
 */
export const experienceEvidenceSchema = z.strictObject({
  path: z.string().trim().min(1).describe('The retained evidence file the observation cites.'),
  revision: z.string().trim().min(1).describe('The revision or capture that establishes it.'),
  detail: z.string().trim().min(1).describe('What this evidence shows.'),
});

/** One existing memory note the observation was compared with. */
export const experienceMemoryComparisonSchema = z.strictObject({
  noteId: z.string().trim().min(1).describe('The existing memory note\u2019s ID.'),
  relationship: z
    .enum(['correction', 'extension'])
    .describe('Whether the observation corrects or extends the earlier note.'),
  explanation: z.string().trim().min(1).describe('How the new evidence changes the earlier note.'),
});

/**
 * The analyst's response: zero or more candidate observations, each with the retained evidence
 * that establishes it and the existing memory notes it corrects or extends. Every property is
 * required, so the derived JSON Schema meets the provider's structured-output contract.
 */
export const experienceAnalysisResponseSchema = z.strictObject({
  observations: z
    .array(
      z.strictObject({
        content: z
          .string()
          .describe(
            'One independent, concise reusable lesson: the cause, constraint or corrective mechanism with its applicability and uncertainty.',
          ),
        evidence: z
          .array(experienceEvidenceSchema)
          .describe('The retained artifacts and revisions that establish the observation.'),
        relatedMemories: z
          .array(experienceMemoryComparisonSchema)
          .describe('The existing memory notes the observation corrects or extends; may be empty.'),
      }),
    )
    .describe('Zero or more independent observations; an empty array is a valid answer.'),
});

export type ExperienceAnalysisResponse = z.infer<typeof experienceAnalysisResponseSchema>;

/**
 * The persisted, validated analysis output. Nexus records it once, then reuses it for every
 * submission retry instead of generating new observations after an interruption. The observation
 * identity is stable within this record and names its submission.
 */
export const experienceAnalysisOutputSchema = z.strictObject({
  workId: z.string().trim().min(1),
  project: z.string().trim().min(1),
  workflow: z.string().trim().min(1),
  attemptId: z.string().trim().min(1),
  terminalId: z.string().trim().min(1),
  profile: z.string().trim().min(1),
  analyzedAt: z.iso.datetime({ offset: true }),
  observations: z.array(
    z.strictObject({
      identity: z.string().trim().min(1),
      content: z.string().trim().min(1),
      evidence: z.array(experienceEvidenceSchema).min(1),
      relatedMemories: z.array(experienceMemoryComparisonSchema),
    }),
  ),
});

export type ExperienceAnalysisOutput = z.infer<typeof experienceAnalysisOutputSchema>;

/** The completion-analysis output shape this store still reads while pending work migrates. */
export const legacyCompletionOutputSchema = z.strictObject({
  taskKey: z.string().trim().min(1),
  project: z.string().trim().min(1),
  completionRevision: z.string().trim().min(1),
  profile: z.string().trim().min(1),
  analyzedAt: z.iso.datetime({ offset: true }),
  observations: z.array(
    z.strictObject({
      identity: z.string().trim().min(1),
      content: z.string().trim().min(1),
      evidence: z.array(experienceEvidenceSchema).min(1),
      relatedMemories: z.array(experienceMemoryComparisonSchema),
    }),
  ),
});

export type LegacyCompletionOutput = z.infer<typeof legacyCompletionOutputSchema>;

/** The submission states; stored and failed are terminal. A blocked receipt stays accepted. */
export const experienceSubmissionStatuses = ['pending', 'accepted', 'stored', 'failed'] as const;

/**
 * One observation's durable submission: the exact payload and source key first chosen, the
 * service's receipt when it accepted the payload, and the current receipt state. The record is
 * rewritten after every attempt, so an interrupted process resumes with the identical payload.
 */
export const experienceSubmissionSchema = z.strictObject({
  sourceKey: z.string().min(1),
  observation: observationSchema,
  status: z.enum(experienceSubmissionStatuses),
  attempts: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }),
  receiptId: z.uuid().nullable(),
  receiptStatus: z.enum(receiptStatuses).nullable(),
  noteId: z.uuid().nullable(),
  problem: z.string().min(1).nullable(),
  retryable: z.boolean().nullable(),
});

export type ExperienceSubmission = z.infer<typeof experienceSubmissionSchema>;

/** One analysis attempt's outcome, appended to the request's retained evidence. */
export const experienceAttemptSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  profile: z.string().min(1),
  outcome: z.enum(['accepted', 'failed']),
  reason: z.string().min(1).nullable(),
  observations: z.number().int().nonnegative().nullable(),
});

export const experienceAttemptsFileSuffix = '.attempts.jsonl';
export const experienceActivityFileSuffix = '.activity.jsonl';

/**
 * The durable identity of one terminal handoff: derived from the work, workflow, attempt and
 * terminal identities, so a repeated handoff reuses its recorded request while a new attempt or
 * idea submission carries a new identity. A revision never names a request.
 */
export function experienceIdentity(handoff: ExperienceHandoff): string {
  const digest = createHash('sha256')
    .update(
      [handoff.workId, handoff.workflow, handoff.attemptId, handoff.terminalId].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 16);
  const readable = `${handoff.workId}-${handoff.terminalId}`
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .slice(0, 64);
  return `${readable}-${digest}`;
}

/** The recorded request of one experience identity. */
export function experienceRequestFile(directory: string, identity: string): string {
  return path.join(directory, 'requests', `${identity}.json`);
}

/**
 * The retained evidence directory of one experience identity: the durable copy of the terminal
 * handoff's evidence, outside the attempt that produced it, and the analyst's own work area. Every
 * selected evidence file is mirrored at its path relative to the work item's workspace root.
 */
export function experienceEvidenceRoot(directory: string, identity: string): string {
  return path.join(directory, 'evidence', identity);
}

/** The capture evidence of one experience identity. */
export function experienceCaptureFile(directory: string, identity: string): string {
  return path.join(directory, 'captures', `${identity}.json`);
}

/** The persisted analysis output of one experience identity. */
export function experienceAnalysisFile(directory: string, identity: string): string {
  return path.join(directory, 'analyses', `${identity}.json`);
}

/** The record of one observation's submission of one experience identity. */
export function experienceSubmissionFile(
  directory: string,
  identity: string,
  observation: string,
): string {
  return path.join(directory, 'submissions', identity, `${observation}.json`);
}

/** The stable source key one persisted observation is submitted under, across every retry. */
export function experienceObservationSourceKey(
  identity: string,
  observationIdentity: string,
): string {
  return `nexus/experience/${identity}/${observationIdentity}`;
}
