import path from 'node:path';
import { z } from 'zod';
import { messageOf } from '../../../result.js';
import type { ArtifactDeclaration } from '../artifacts.js';
import { describeIssues, parseDocument, readDocumentText } from '../documents.js';

/**
 * IdeaEditor's artifact contract: the editor's framing, the refined idea revisions and the
 * editor's response to the Challenger. The refined idea states, in clear parts, the idea itself,
 * why it belongs in this project, a plausible way forward given the known constraints and
 * evidence, and the material questions the next workflow must answer. Each written revision is an
 * immutable artifact of its cycle, so a later revision at its own path invalidates every earlier
 * Challenger approval. The framing states the author's proposal and the few questions that could
 * develop it; the response answers one Challenger concern with a revision, an answer, a rebuttal,
 * a focused help request or a return to the author.
 */

/** Only material questions for the next workflow; a refined idea may state none. */
const openQuestionsSchema = z.array(z.string().trim().min(1));

/** The refined idea's substance: the parts the Challenger decides on and publication presents. */
export const refinedIdeaContentSchema = z.object({
  /**
   * The author's idea as a concise statement of the proposed change, why it matters and the
   * principle behind it, without committing to implementation.
   */
  idea: z
    .string()
    .trim()
    .min(1)
    .describe('The proposed change, why it matters and the principle behind it.'),
  /** Why the idea belongs in this project. */
  projectFit: z.string().trim().min(1).describe('Why the idea belongs in this project.'),
  /**
   * A plausible way forward given the known constraints and evidence, not a design or
   * implementation plan.
   */
  feasibility: z
    .string()
    .trim()
    .min(1)
    .describe('A plausible way forward given the known constraints and evidence.'),
  openQuestions: openQuestionsSchema
    .describe('Only the material questions the next workflow must answer.')
    .optional(),
  /**
   * The cumulative account of what refinement changed across the submission's cycles, or the
   * initial summary for the first revision. Reporting metadata, not one of the idea's parts.
   */
  changeSummary: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The cumulative account of what refinement changed, not one of the idea\u2019s parts.',
    ),
});

export type RefinedIdeaContent = z.infer<typeof refinedIdeaContentSchema>;

/**
 * The editor's refined idea response: the parts with the open questions the strict provider schema
 * requires. A revision that states no open questions reports null, which the action turns back
 * into the absent field the content schema and its readers declare.
 */
export const refinedIdeaResponseSchema = refinedIdeaContentSchema.extend({
  openQuestions: openQuestionsSchema
    .nullable()
    .describe(
      'Only the material questions the next workflow must answer; null when the revision states none.',
    ),
});

/** The stored refined idea revision: its substance bound to the submission and cycle it came from. */
export const refinedIdeaSchema = refinedIdeaContentSchema.extend({
  revision: z.number().int().positive(),
  submission: z.number().int().positive(),
  cycle: z.number().int().positive(),
});

export type RefinedIdeaRevision = z.infer<typeof refinedIdeaSchema>;

/** The refined idea artifact new revisions are written to, under their own cycle directory. */
export const refinedIdeaArtifact = {
  pathFromArtifactsRoot: 'refined-idea.json',
  schema: refinedIdeaSchema,
} satisfies ArtifactDeclaration<typeof refinedIdeaSchema>;

/**
 * The framing response: the author's proposal framed for the conversation, the few questions that
 * could develop it, and the essential author decision that stops the workflow when one is missing.
 */
export const framingResponseSchema = z.object({
  framing: z
    .string()
    .trim()
    .min(1)
    .describe('The author\u2019s proposed change and the few questions that could develop it.'),
  questions: z
    .array(z.string().trim().min(1))
    .describe('The questions this refinement conversation should develop.'),
  authorDecision: z
    .object({
      question: z
        .string()
        .trim()
        .min(1)
        .describe('The essential decision only the author can make.'),
    })
    .nullable()
    .describe(
      'The essential author decision already missing from the input, or null when none is.',
    ),
});

export type FramingResponse = z.infer<typeof framingResponseSchema>;

export const framingArtifact = {
  pathFromArtifactsRoot: 'editor-framing.json',
  schema: framingResponseSchema,
} satisfies ArtifactDeclaration<typeof framingResponseSchema>;

/** What the editor did with the Challenger's concern. */
export const editorDispositions = [
  'revised',
  'answered',
  'rebutted',
  'help-requested',
  'unsuitable',
  'author-decision-needed',
] as const;

export type EditorDisposition = (typeof editorDispositions)[number];

/** The focused questions the editor asks of each contributor, or null when it asks none. */
export const editorHelpSchema = z.object({
  researcher: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe('The focused question for the Researcher, or null when it is not asked.'),
  projectGuide: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe('The focused question for the Project guide, or null when it is not asked.'),
});

export type EditorHelp = z.infer<typeof editorHelpSchema>;

/**
 * The editor's turn as it is stored: its disposition, the short plain turn for the next role, the
 * author-facing reason a return needs and the focused help it requests. A revised refined idea is
 * written to its own immutable revision artifact, never duplicated here.
 */
export const editorTurnSchema = z.object({
  disposition: z
    .enum(editorDispositions)
    .describe('What the editor did with the Challenger\u2019s concern or this edit task.'),
  response: z
    .string()
    .trim()
    .min(1)
    .describe('The short plain response addressed to the next role.'),
  reason: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe(
      'The author-facing reason an unsuitable or author-decision-needed return needs, or null for every other disposition.',
    ),
  help: editorHelpSchema
    .nullable()
    .describe(
      'The named focused questions for the contributors, or null unless the disposition is help-requested.',
    ),
});

export type EditorTurn = z.infer<typeof editorTurnSchema>;

/** The editor's response for the cycle: a revision, an answer, a rebuttal or a return. */
export const editorResponseArtifact = {
  pathFromArtifactsRoot: 'editor-response.json',
  schema: editorTurnSchema,
} satisfies ArtifactDeclaration<typeof editorTurnSchema>;

/** The editor's focused help request for the cycle, answered by the named contributors. */
export const editorHelpArtifact = {
  pathFromArtifactsRoot: 'editor-help-request.json',
  schema: editorTurnSchema,
} satisfies ArtifactDeclaration<typeof editorTurnSchema>;

/**
 * The editor's response to the Challenger's current concern as the provider returns it: the stored
 * turn plus the refined idea it revises, when it revises one.
 */
export const editorTurnResponseSchema = editorTurnSchema.extend({
  refinedIdea: refinedIdeaResponseSchema
    .nullable()
    .describe(
      'The refined idea revision this turn writes, or null unless the disposition is revised.',
    ),
});

export type EditorTurnResponse = z.infer<typeof editorTurnResponseSchema>;

/**
 * One refined idea revision as consumers read it: the parts it states and the reporting metadata.
 * A revision retained from an earlier implementation may lack the parts that were not separate
 * then, so a missing project fit or feasibility is read as absent.
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

/**
 * The artifact path earlier implementations wrote the refined idea to before it replaced their
 * brief. Reading accepts it; nothing writes it any more.
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
 * from an earlier implementation at its own path and in its own shape. Reading is the only
 * compatibility path; retained artifacts and interrupted state stay untouched.
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
