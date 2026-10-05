import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * Review's artifact contract: the findings still present in the reviewed revision, the disposition
 * of every finding supplied from earlier rounds, and the verdict they support.
 */

/**
 * One affected location's fields: its file, and its line in the reviewed revision when the
 * location has one.
 */
const findingLocationFields = {
  path: z.string().describe('The affected file in the reviewed revision.'),
  line: z.number().int().positive().describe('The one-based line in the reviewed revision.'),
};

/** One location in a saved Finding: a location without a line leaves the field out. */
const findingLocationSchema = z.strictObject({
  ...findingLocationFields,
  line: findingLocationFields.line.optional(),
});

/**
 * One location as the agent reports it. The provider's strict structured-output schema requires
 * every property, so a location without a line reports null; the action turns that null back into
 * an absent line before saving the Finding.
 */
const reportedLocationSchema = z.strictObject({
  ...findingLocationFields,
  line: findingLocationFields.line
    .nullable()
    .describe('The reviewed revision\u2019s line, or null when the location has no line.'),
});

/** One defect finding, identified by a task-stable ID. */
export const findingSchema = z.strictObject({
  id: z.string().describe('The task-stable finding ID; reuse it for the same defect.'),
  title: z.string().describe('A short title for the defect.'),
  severity: z
    .enum(['blocking', 'non-blocking'])
    .describe('Whether the finding prevents acceptance.'),
  basis: z.string().describe('The requirement or expected behavior that is violated.'),
  evidence: z
    .string()
    .describe(
      'The observed or reproducible failure, related occurrences inspected and material uncertainty.',
    ),
  impact: z.string().describe('The consequence of the defect.'),
  repairGuidance: z.string().describe('The required correction.'),
  locations: z.array(findingLocationSchema).describe('The affected locations; may be empty.'),
});

export type Finding = z.infer<typeof findingSchema>;

/** The reviewer's disposition of one finding supplied from an earlier round. */
export const findingDispositionSchema = z.strictObject({
  findingId: z.string().describe('The eligible prior finding ID this disposition answers.'),
  disposition: z
    .enum(['resolved', 'open', 'withdrawn'])
    .describe('The finding\u2019s state in the current revision.'),
  reason: z
    .string()
    .describe('The implementation evidence and developer response that support the disposition.'),
});

export type FindingDisposition = z.infer<typeof findingDispositionSchema>;

/** The review result for one reviewed revision. */
export const reviewOutputSchema = z.object({
  /** Task subject captured for this report; older reports may omit it. */
  taskSubject: z.string().optional(),
  profile: z.string().describe('The reviewer profile that produced this verdict.'),
  headRevision: z.string().describe('The exact revision this verdict reviews.'),
  verdict: z
    .enum(['approved', 'changesRequested'])
    .describe(
      'Approved requires sufficient evidence and no current blocking finding; changesRequested requires at least one.',
    ),
  summary: z
    .string()
    .describe('What was reviewed, the inspected scope and why this verdict is supported.'),
  findings: z
    .array(findingSchema)
    .describe(
      'Every finding still present in the reviewed revision, including retained open findings.',
    ),
  priorFindings: z
    .array(findingDispositionSchema)
    .describe('One disposition for every eligible prior finding ID and none for any other ID.'),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/**
 * The persisted Finding for one finding the agent reported: the response's explicit null line is
 * the Finding contract's absent line.
 */
export function toFinding(reported: ReportedFinding): Finding {
  return {
    ...reported,
    locations: reported.locations.map(({ path, line }) =>
      line === null ? { path } : { path, line },
    ),
  };
}

/** One current finding as the agent reports it: a location without a line reports null. */
export const reportedFindingSchema = findingSchema.extend({
  locations: z
    .array(reportedLocationSchema)
    .describe('The affected locations; may be empty. A location without a line reports null.'),
});

export type ReportedFinding = z.infer<typeof reportedFindingSchema>;

/**
 * The agent's response fields: the same review fields with locations the strict provider schema
 * accepts. The action binds them to the configured profile and the observed reviewed head before
 * writing its output.
 */
export const reviewResponseSchema = z.strictObject({
  ...reviewOutputSchema.pick({ verdict: true, summary: true, priorFindings: true }).shape,
  findings: z
    .array(reportedFindingSchema)
    .describe(
      'Every finding still present in the reviewed revision, including retained open findings.',
    ),
});

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

export const reviewArtifact = {
  pathFromArtifactsRoot: 'review.json',
  schema: reviewOutputSchema,
} satisfies ArtifactDeclaration<typeof reviewOutputSchema>;

/** Validate a revision assessment against the shared findings and verdict contract. */
export function validateReviewResponse(
  response: ReviewResponse,
  priorFindings: readonly Finding[],
): void {
  const current = new Set<string>();
  for (const finding of response.findings) {
    if (current.has(finding.id)) {
      throw new Error(`The reviewer reported finding "${finding.id}" more than once.`);
    }
    current.add(finding.id);
  }

  const supplied = new Set(priorFindings.map((finding) => finding.id));
  const answered = new Set<string>();
  for (const disposition of response.priorFindings) {
    if (!supplied.has(disposition.findingId)) {
      throw new Error(`The reviewer disposed of unknown prior finding "${disposition.findingId}".`);
    }
    if (answered.has(disposition.findingId)) {
      throw new Error(
        `The reviewer disposed of prior finding "${disposition.findingId}" more than once.`,
      );
    }
    answered.add(disposition.findingId);
    const present = current.has(disposition.findingId);
    if (disposition.disposition === 'open' && !present) {
      throw new Error(
        `The reviewer left prior finding "${disposition.findingId}" open without reporting it ` +
          'in findings.',
      );
    }
    if (disposition.disposition !== 'open' && present) {
      throw new Error(
        `The reviewer reported prior finding "${disposition.findingId}" as ` +
          `"${disposition.disposition}" while it is still in findings.`,
      );
    }
  }
  const missing = priorFindings
    .filter((finding) => !answered.has(finding.id))
    .map((finding) => finding.id);
  if (missing.length > 0) {
    throw new Error(
      `The reviewer did not dispose of prior finding${missing.length === 1 ? '' : 's'} ` +
        `${missing.map((id) => `"${id}"`).join(', ')}.`,
    );
  }

  const blocking = response.findings.filter((finding) => finding.severity === 'blocking');
  if (response.verdict === 'approved' && blocking.length > 0) {
    throw new Error(
      `The reviewer approved the revision while reporting blocking finding` +
        `${blocking.length === 1 ? '' : 's'} ${blocking.map((finding) => `"${finding.id}"`).join(', ')}.`,
    );
  }
  if (response.verdict === 'changesRequested' && blocking.length === 0) {
    throw new Error('The reviewer requested changes without a current blocking finding.');
  }
}
