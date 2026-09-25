import path from 'node:path';
import { z } from 'zod';
import { messageOf } from '../../../result.js';
import type { ArtifactDeclaration } from '../artifacts.js';
import { describeIssues, parseDocument, readDocumentText } from '../documents.js';

/**
 * BriefWriter's artifact contract: the immutable refined idea revision one council cycle reviews.
 * A refined idea states, in clear parts, the idea itself, why it belongs in this project, a
 * plausible path given the known constraints and evidence, and the material questions the next
 * workflow must answer. Each cycle writes exactly one revision, so the revision number is the
 * council cycle that produced it; a later cycle writes a new revision at its own path, which
 * invalidates every earlier approval.
 */

/** The refined idea's substance: the parts the council decides on and publication presents. */
export const refinedIdeaContentSchema = z.object({
  /**
   * The author's idea as a concise statement of the proposed change, why it matters and the
   * principle behind it, without committing to implementation.
   */
  idea: z.string().trim().min(1),
  /** Why the idea belongs in this project. */
  projectFit: z.string().trim().min(1),
  /**
   * A plausible path given the known constraints and evidence, not a design or implementation
   * plan.
   */
  feasibility: z.string().trim().min(1),
  /** Only material questions for the next workflow; a refined idea may state none. */
  openQuestions: z.array(z.string().trim().min(1)).optional(),
  /**
   * The cumulative account of what refinement changed across the submission's cycles, or the
   * initial summary for revision 1. Reporting metadata, not one of the idea's parts. The
   * revision's cycle number is the council cycles used.
   */
  changeSummary: z.string().trim().min(1),
});

export type RefinedIdeaContent = z.infer<typeof refinedIdeaContentSchema>;

/** The stored refined idea revision: its substance bound to the submission and cycle it came from. */
export const refinedIdeaSchema = refinedIdeaContentSchema.extend({
  revision: z.number().int().positive(),
  submission: z.number().int().positive(),
  cycle: z.number().int().positive(),
});

/**
 * One refined idea revision as consumers read it: the parts it states and the reporting metadata.
 * A revision retained from an earlier shape may lack the parts that were not separate then.
 */
export type RefinedIdea = {
  readonly idea: string;
  readonly projectFit: string | null;
  readonly feasibility: string | null;
  readonly openQuestions: readonly string[];
  readonly changeSummary: string;
  readonly revision: number;
  readonly submission: number;
  readonly cycle: number;
};

/** One read revision and the file it was read from. */
export type RefinedIdeaRead = {
  readonly path: string;
  readonly value: RefinedIdea;
};

/** The refined idea artifact new revisions are written to. */
export const refinedIdeaArtifact = {
  pathFromArtifactsRoot: 'refined-idea.json',
  schema: refinedIdeaSchema,
} satisfies ArtifactDeclaration<typeof refinedIdeaSchema>;

/**
 * The artifact path the writer used before the refined idea replaced the brief. Reading accepts
 * it; nothing writes it any more.
 */
export const retainedBriefArtifactPath = 'brief.json';

/**
 * The retained brief shape that already stated one `idea` field. Reading presents its idea and
 * smallest scope as the refined idea's parts; it carried no separate project fit.
 */
const previousBriefSchema = z.object({
  idea: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  changeSummary: z.string().trim().min(1),
  revision: z.number().int().positive(),
  submission: z.number().int().positive(),
  cycle: z.number().int().positive(),
});

/**
 * The retained brief shape written before `idea` replaced `problem`, `value` and `projectFit`.
 * Reading presents the problem and value as the idea and keeps project fit and scope as the
 * refined idea's own parts.
 */
const legacyBriefSchema = z.object({
  problem: z.string().trim().min(1),
  value: z.string().trim().min(1),
  projectFit: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  changeSummary: z.string().trim().min(1),
  revision: z.number().int().positive(),
  submission: z.number().int().positive(),
  cycle: z.number().int().positive(),
});

/**
 * Read one stored revision in any shape it was written in: the refined idea, or a brief retained
 * from before it at its own path and in its own shape. Reading is the only compatibility path;
 * retained artifacts and interrupted state stay untouched.
 */
export async function readRefinedIdeaRevision(cycleRoot: string): Promise<RefinedIdeaRead | null> {
  const file = path.join(cycleRoot, refinedIdeaArtifact.pathFromArtifactsRoot);
  const text = await readDocumentText(file, 'Artifact');
  if (text !== null) {
    const content = parseStored(file, text, refinedIdeaSchema);
    return {
      path: file,
      value: {
        idea: content.idea,
        projectFit: content.projectFit,
        feasibility: content.feasibility,
        openQuestions: content.openQuestions ?? [],
        changeSummary: content.changeSummary,
        revision: content.revision,
        submission: content.submission,
        cycle: content.cycle,
      },
    };
  }

  const retainedFile = path.join(cycleRoot, retainedBriefArtifactPath);
  const retained = await readDocumentText(retainedFile, 'Artifact');
  if (retained === null) {
    return null;
  }
  const previous = parseDocument(retained, previousBriefSchema);
  if (previous.kind === 'invalid-json') {
    throw new Error(
      `Artifact at "${retainedFile}" is not valid JSON: ${messageOf(previous.error)}`,
      { cause: previous.error },
    );
  }
  if (previous.kind === 'content') {
    return {
      path: retainedFile,
      value: {
        idea: previous.content.idea,
        projectFit: null,
        feasibility: previous.content.scope,
        openQuestions: [],
        changeSummary: previous.content.changeSummary,
        revision: previous.content.revision,
        submission: previous.content.submission,
        cycle: previous.content.cycle,
      },
    };
  }
  const legacy = parseDocument(retained, legacyBriefSchema);
  if (legacy.kind === 'invalid-json') {
    throw new Error(`Artifact at "${retainedFile}" is not valid JSON: ${messageOf(legacy.error)}`, {
      cause: legacy.error,
    });
  }
  if (legacy.kind === 'content') {
    const { problem, value, projectFit, scope, ...sections } = legacy.content;
    return {
      path: retainedFile,
      value: {
        ...sections,
        idea: [problem, value].join(' '),
        projectFit,
        feasibility: scope,
        openQuestions: [],
      },
    };
  }
  throw new Error(
    `Artifact at "${retainedFile}" is neither a refined idea revision nor a retained brief ` +
      `revision: ${describeIssues(previous.error, '<artifact>')}`,
    { cause: previous.error },
  );
}

/** Parse one stored refined idea revision, naming the file when it does not match. */
function parseStored<Schema extends z.ZodType>(
  file: string,
  text: string,
  schema: Schema,
): z.output<Schema> {
  const parsed = parseDocument(text, schema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(`Artifact at "${file}" is not valid JSON: ${messageOf(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `Artifact at "${file}" does not match its declared content type: ` +
        describeIssues(parsed.error, '<artifact>'),
      { cause: parsed.error },
    );
  }
  return parsed.content as z.output<Schema>;
}
