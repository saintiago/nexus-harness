import { z } from 'zod';
import type { RecordDeclaration } from '../records.js';

/**
 * SelectIdea's selection record and the captured idea input it owns. The selection record sits
 * beside the idea-refinement execution's workflow-state file, outside the issue workspace, and
 * names the refinement area and the shared issue root. The captured input contract is durable
 * history: StartIdeaRound writes its retained copy into the submission it opens, and every idea
 * role reads that copy as the current captured idea.
 */

/** The selection record's file name beside the idea-refinement workflow-state file. */
export const ideaSelectionFile = 'selection.json';

/** The retained submission input's file name under artifacts/submissions/<n>/. */
export const ideaInputFile = 'input.json';

/** The captured idea input: source identity, the issue revision and the complete conversation. */
export const ideaInputSchema = z.object({
  taskKey: z.string().min(1),
  source: z.object({ kind: z.literal('jira'), issueId: z.string().min(1) }),
  issue: z.unknown(),
  conversation: z.array(z.unknown()),
});

export type IdeaInput = z.infer<typeof ideaInputSchema>;

export const ideaInputDeclaration = {
  file: ideaInputFile,
  schema: ideaInputSchema,
} satisfies RecordDeclaration<typeof ideaInputSchema>;

/**
 * The selection document. The issue and conversation keep the source's native structures, and the
 * transitions are the ones observed at selection: the move into the active status and the moves
 * available from it for publication. A run reads the issue and its conversation once and publishes
 * from this snapshot.
 */
export const ideaSelectionSchema = z.object({
  taskKey: z.string().min(1),
  source: z.object({ kind: z.literal('jira'), issueId: z.string().min(1) }),
  issue: z.unknown(),
  conversation: z.array(z.unknown()),
  transitions: z.object({
    toActive: z.unknown(),
    fromActive: z.array(z.unknown()),
  }),
  /** Whether the item has been moved into the active status this selection claims. */
  claimed: z.boolean(),
  /** The refinement workflow area the idea actions write under. */
  workspace: z.object({ root: z.string().min(1) }),
  /** The shared issue workspace root the source pointer retains. */
  issueWorkspace: z.object({ root: z.string().min(1) }),
});

export type IdeaSelection = z.infer<typeof ideaSelectionSchema>;

export const ideaSelectionDeclaration = {
  file: ideaSelectionFile,
  schema: ideaSelectionSchema,
} satisfies RecordDeclaration<typeof ideaSelectionSchema>;
