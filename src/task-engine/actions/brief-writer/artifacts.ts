import path from 'node:path';
import { z } from 'zod';
import { messageOf } from '../../../result.js';
import type { ArtifactDeclaration } from '../artifacts.js';
import { describeIssues, parseDocument, readDocumentText } from '../documents.js';

/**
 * BriefWriter's artifact contract: the immutable brief revision one council cycle reviews. Each
 * cycle writes exactly one revision, so the revision number is the council cycle that produced it;
 * a later cycle writes a new revision at its own path, which invalidates every earlier approval.
 */

/** The supporting sections every brief revision carries, whatever shape its idea statement has. */
const briefSectionsSchema = z.object({
  evidence: z.array(z.string().trim().min(1)),
  alternatives: z.array(z.string().trim().min(1)),
  scope: z.string().trim().min(1),
  assumptions: z.array(z.string().trim().min(1)),
  /**
   * The cumulative account of what refinement changed across the submission's cycles, or the
   * initial summary for revision 1. The brief's cycle number is the council cycles used.
   */
  changeSummary: z.string().trim().min(1),
});

/** The brief's substance: the smallest coherent case the council decides on. */
export const briefContentSchema = briefSectionsSchema.extend({
  /**
   * The author's idea as one coherent proposal: the proposed change, why it matters and the
   * principle behind it, rather than separate problem, value and project-fit essays or a more
   * generic restatement. Concrete requirements and design stay deferred.
   */
  idea: z.string().trim().min(1),
});

export type BriefContent = z.infer<typeof briefContentSchema>;

/** The stored brief revision: its substance bound to the submission and cycle that produced it. */
export const briefSchema = briefContentSchema.extend({
  revision: z.number().int().positive(),
  submission: z.number().int().positive(),
  cycle: z.number().int().positive(),
});

export type Brief = z.infer<typeof briefSchema>;

/**
 * The brief shape written before `idea` replaced `problem`, `value` and `projectFit`. Retained
 * artifacts keep that shape; reading presents the three fields as the one idea they already
 * express. Nothing rewrites them, and no new brief uses this shape.
 */
export const legacyBriefSchema = briefSectionsSchema.extend({
  problem: z.string().trim().min(1),
  value: z.string().trim().min(1),
  projectFit: z.string().trim().min(1),
  revision: z.number().int().positive(),
  submission: z.number().int().positive(),
  cycle: z.number().int().positive(),
});

export const briefArtifact = {
  pathFromArtifactsRoot: 'brief.json',
  schema: briefSchema,
} satisfies ArtifactDeclaration<typeof briefSchema>;

/**
 * Read one stored brief revision in either shape: current briefs state `idea`, and briefs retained
 * from before the field state `problem`, `value` and `projectFit`, read as one idea. Reading is the
 * only compatibility path; retained artifacts and interrupted state stay untouched.
 */
export async function readBriefRevision(cycleRoot: string): Promise<Brief | null> {
  const file = path.join(cycleRoot, briefArtifact.pathFromArtifactsRoot);
  const text = await readDocumentText(file, 'Artifact');
  if (text === null) {
    return null;
  }
  const current = parseDocument(text, briefSchema);
  if (current.kind === 'content') {
    return current.content;
  }
  const legacy = parseDocument(text, legacyBriefSchema);
  if (legacy.kind === 'content') {
    const { problem, value, projectFit, ...sections } = legacy.content;
    return { ...sections, idea: [problem, value, projectFit].join(' ') };
  }
  if (current.kind === 'invalid-json') {
    throw new Error(`Artifact at "${file}" is not valid JSON: ${messageOf(current.error)}`, {
      cause: current.error,
    });
  }
  throw new Error(
    `Artifact at "${file}" does not match its declared content type: ` +
      describeIssues(current.error, '<artifact>'),
    { cause: current.error },
  );
}
