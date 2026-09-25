import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';
import { councilReportSchema, councilVerdicts } from '../review-council/artifacts.js';

/**
 * PublishDecision's artifacts: the decision record of one council cycle and the handoff an
 * approved idea leaves for later workflows. The decision records the route XState took, the
 * strongest verdict and the complete council feedback, together with the source update evidence.
 * The handoff carries references, never copies, so a later workflow reads the retained history
 * from the shared issue workspace.
 */

/** The publication routes the idea workflow supplies. */
export const ideaDecisions = ['approved', 'returned-to-author', 'unable-to-converge'] as const;

export type IdeaDecision = (typeof ideaDecisions)[number];

/** The decision record stored in the cycle directory. */
export const decisionSchema = z.object({
  decision: z.enum(ideaDecisions),
  strongestVerdict: z.enum(councilVerdicts),
  /**
   * The refined idea revision the decision applies to, and the artifact that holds it. The field
   * keeps its earlier name so decisions saved before the rename stay readable.
   */
  brief: z.string().trim().min(1),
  revision: z.number().int().positive(),
  /** Every reviewer's complete result, including the feedback that did not determine the route. */
  feedback: z.array(councilReportSchema),
  /** The human-facing Jira comment text, or null when the route posted none. */
  comment: z.string().nullable(),
  /** What the source update changed: the applied transition and published comment identity. */
  source: z.object({
    transition: z.object({
      id: z.string().min(1),
      to: z.string().min(1),
    }),
    status: z.string().min(1),
    commentId: z.string().nullable(),
  }),
});

export type IdeaDecisionRecord = z.infer<typeof decisionSchema>;

export const decisionArtifact = {
  pathFromArtifactsRoot: 'decision.json',
  schema: decisionSchema,
} satisfies ArtifactDeclaration<typeof decisionSchema>;

/** The approved handoff's fixed location within the refinement area. */
export const ideaHandoffFile = 'artifacts/handoff.json';

/** The handoff a Requirements and Design workflow reads after an approval. */
export const handoffSchema = z.object({
  issue: z.object({ id: z.string().min(1), key: z.string().min(1) }),
  /** The shared issue workspace root later workflows read retained artifacts from. */
  issueWorkspace: z.string().trim().min(1),
  capturedInput: z.string().trim().min(1),
  /** The approved refined idea artifact this handoff publishes. */
  brief: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
  research: z.string().trim().min(1),
  council: z.object({
    purpose: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    simplicity: z.string().trim().min(1),
  }),
  decision: z.string().trim().min(1),
});

export type IdeaHandoff = z.infer<typeof handoffSchema>;
