import { z } from 'zod';
import type { ArtifactDeclaration } from '../artifacts.js';

/**
 * PublishDecision's artifacts: the decision record of one conversation and the handoff an
 * approved idea leaves for later workflows. The decision records the route XState took, the exact
 * refined idea revision and editor turn it observed, the human-facing reason a return states and
 * the source update evidence, including the Challenger result the decision rests on. The handoff
 * carries references, never copies, so a later workflow reads the retained history from the
 * shared issue workspace.
 */

/** The publication routes the idea workflow supplies, one per documented outcome. */
export const ideaDecisions = [
  'approved',
  'unsuitable',
  'author-decision-needed',
  'attempts-exhausted',
] as const;

export type IdeaDecision = (typeof ideaDecisions)[number];

/** The decision record stored in the submission directory. */
export const decisionSchema = z.object({
  decision: z.enum(ideaDecisions),
  /** The refined idea revision presented, and the artifact that holds it, when one exists. */
  refinedIdea: z.string().trim().min(1).nullable(),
  revision: z.number().int().positive().nullable(),
  /** The editor artifact the decision observes: the cycle's response, or its framing. */
  editor: z.string().trim().min(1),
  /** The Challenger result the approved or exhausted decision rests on, when one exists. */
  challenger: z.string().trim().min(1).nullable(),
  /** The human-facing reason a return states, or null for an approval. */
  reason: z.string().trim().min(1).nullable(),
  /** The human-facing Jira comment text. */
  comment: z.string().min(1),
  /**
   * What the source update changed: the applied transition and published comment identity. The
   * child records the decision with null; the parent-owned publication fills it in after the
   * source write, so a repeated publication reuses the retained identities.
   */
  source: z
    .object({
      transition: z.object({
        id: z.string().min(1),
        to: z.string().min(1),
      }),
      status: z.string().min(1),
      commentId: z.string().nullable(),
    })
    .nullable(),
});

export type IdeaDecisionRecord = z.infer<typeof decisionSchema>;

export const decisionArtifact = {
  pathFromArtifactsRoot: 'decision.json',
  schema: decisionSchema,
} satisfies ArtifactDeclaration<typeof decisionSchema>;

/** The approved handoff's fixed location within the refinement area. */
export const ideaHandoffFile = 'artifacts/handoff.json';

/**
 * The handoff a Requirements and Design workflow reads after an approval: the shared issue
 * workspace, the captured author input, the approved revision and references to the framing,
 * editor responses, contributions, Challenger results and decision it rests on.
 */
export const handoffSchema = z.object({
  issue: z.object({ id: z.string().min(1), key: z.string().min(1) }),
  /** The shared issue workspace root later workflows read retained artifacts from. */
  issueWorkspace: z.string().trim().min(1),
  capturedInput: z.string().trim().min(1),
  framing: z.string().trim().min(1).nullable(),
  refinedIdea: z.string().trim().min(1),
  editorResponses: z.array(z.string().trim().min(1)),
  contributions: z.array(z.string().trim().min(1)),
  challengerResults: z.array(z.string().trim().min(1)),
  decision: z.string().trim().min(1),
});

export type IdeaHandoff = z.infer<typeof handoffSchema>;
