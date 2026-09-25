import path from 'node:path';
import { z } from 'zod';
import type { IdeaRole } from '../../agent-runtime/index.js';
import { messageOf } from '../../result.js';
import { actionOutcomeEvent, type AgentRoleRunner, type EventPublisher } from '../index.js';
import type { ArtifactDeclaration } from './artifacts.js';
import { briefArtifact, readBriefRevision } from './brief-writer/artifacts.js';
import { describeIssues, parseDocument, readDocumentText } from './documents.js';
import {
  ideaCycleDirectory,
  ideaSubmissionArtifactFile,
  ideaSubmissionInputFile,
  listIdeaCycles,
  listIdeaSubmissions,
  readCycleArtifact,
  readSubmissionArtifact,
} from './idea-storage.js';
import { decisionArtifact } from './publish-decision/artifacts.js';
import { purposeArtifact } from './purpose-verifier/artifacts.js';
import { researchArtifact } from './researcher/artifacts.js';
import {
  councilArtifacts,
  councilReviewers,
  type CouncilReport,
  type CouncilReviewer,
} from './review-council/artifacts.js';
import type { IdeaInput } from './select-idea/artifacts.js';
import type { IdeaRoundPlan } from './start-idea-round/artifacts.js';

/**
 * The context every idea refinement role receives: the current captured idea as the authoritative
 * proposal, the prepared project worktree, the retained workspace history as readable references
 * and the connected project's root AGENTS.md when present. A council reviewer omits the other
 * reviewers' current-cycle results, so it never reads a pending verdict before submitting its own.
 */

/**
 * The one shared definition of an idea, supplied to every idea refinement role invocation ahead of
 * its role-specific context. The specification owns the wording, so no role depends on opening it
 * and no role prompt repeats the definition.
 */
export const ideaDefinitionText = [
  'Idea definition (shared by every idea refinement role):',
  'An idea describes a desirable change in software, why it matters, and the principle behind it\u2014without yet committing to implementation.',
].join('\n');

/**
 * The shared idea-stage guidance supplied to every idea refinement role invocation with the
 * definition. It keeps refinement on the idea as the author proposed it, states what the stage
 * decides and leaves exact selection, configuration and implementation to Requirements and
 * Design. An initial submission may lack parts of the definition; refinement develops them, while
 * a finished brief must still let the council decide.
 */
export const ideaStageGuidanceText = [
  'Idea stage (shared by every idea refinement role): an initial submission may lack the proposed',
  'change, why it matters or the principle behind it; that is not an intake rejection, because',
  'refinement develops those elements. A finished brief still needs enough clarity and substance',
  'for the council\u2019s idea-stage decision, and the council may object when it cannot decide.',
  'Work on the idea as the author proposed it: preserve that concept and intent rather than',
  'replacing it with a different or more generic need. The stage decides whether the idea is worth',
  'developing and its smallest useful scope. Exact selection, configuration and implementation',
  'belong to Requirements and Design; architecture documents are evidence of existing capabilities',
  'and constraints, not design decisions the idea must settle.',
].join('\n');

/**
 * The one shared communication rule supplied to every idea refinement role invocation with the
 * definition and stage guidance. Each role writes a short, plain turn for the next role, gives
 * only the observations and citations that bear on the idea-stage decision, and leaves rhetorical
 * and implementation prose out.
 */
export const ideaCommunicationText = [
  'Idea communication (shared by every idea refinement role): write short, plain, concrete',
  'sentences addressed to the next role, one point per statement. Lead with what the idea proposes,',
  'why it matters or a consequential question, and give only your strongest relevant observations',
  'and source citations. Research and cite relevant sources for substantive claims, but do not',
  'fact-check incidental wording or nitpick details that cannot change the idea-stage decision.',
  'Genuine skepticism, useful research and rejecting an unsuitable idea are welcome; rhetorical',
  'praise, self-assessments of honesty or rigor, repeated claims, abstract labels, long code or file',
  'inventories and technical detail that belongs to Requirements and Design are not. Preserve the',
  'author\u2019s idea and your role\u2019s perspective.',
].join('\n');

/** The worktree directory under a refinement area (Workspace design). */
const worktreeDirectory = 'worktree';

/** One retained cycle artifact a role can read, with the label its history line carries. */
type CycleHistoryEntry = {
  readonly label: string;
  /** The reviewer whose pending result this is, or null for shared history. */
  readonly pendingReviewer: CouncilReviewer | null;
  readonly declaration: ArtifactDeclaration;
  /** Reads the artifact; a brief revision also accepts the retained shape written before `idea`. */
  readonly read: (cycleRoot: string) => Promise<unknown | null>;
};

/** One history entry that reads its declared artifact as it is stored. */
function artifactEntry(
  label: string,
  pendingReviewer: CouncilReviewer | null,
  declaration: ArtifactDeclaration,
): CycleHistoryEntry {
  return {
    label,
    pendingReviewer,
    declaration,
    read: (cycleRoot) => readCycleArtifact(cycleRoot, declaration),
  };
}

/** The cycle artifacts the retained history lists, in cycle order. */
const cycleHistory: readonly CycleHistoryEntry[] = [
  artifactEntry('purpose assessment', null, purposeArtifact),
  artifactEntry('research report', null, researchArtifact),
  {
    label: 'brief revision',
    pendingReviewer: null,
    declaration: briefArtifact,
    read: readBriefRevision,
  },
  ...councilReviewers.map((reviewer) =>
    artifactEntry(`${reviewer} council result`, reviewer, councilArtifacts[reviewer]),
  ),
];

/** True when this history line is a concurrent reviewer's pending result. */
function isPending(
  entry: CycleHistoryEntry,
  plan: IdeaRoundPlan,
  options: {
    readonly reviewer: CouncilReviewer | null;
    readonly submission: number;
    readonly cycle: number;
  },
): boolean {
  return (
    entry.pendingReviewer !== null &&
    entry.pendingReviewer !== options.reviewer &&
    options.submission === plan.submission &&
    options.cycle === plan.cycle
  );
}

/**
 * The retained workspace history as readable references: every submission's captured input and
 * every cycle's artifacts, in history order. References are for selective reading; roles never
 * rewrite them and open only the artifacts that bear on their current decision.
 */
export async function retainedHistoryText(
  root: string,
  plan: IdeaRoundPlan,
  options: { readonly reviewer: CouncilReviewer | null },
): Promise<string> {
  const submissions = await listIdeaSubmissions(root);
  if (submissions.length === 0) {
    return 'Retained workspace history: none yet.';
  }
  const lines = [
    'Retained workspace history (the author\u2019s earlier submissions, briefs, purpose and',
    'research reports and council feedback). Read it selectively: open only the artifacts that',
    'bear on your current decision, and use the latest brief\u2019s cumulative changeSummary to',
    'understand what refinement has already changed:',
  ];
  for (const submission of submissions) {
    lines.push(`- Submission ${String(submission)}:`);
    lines.push(`  - captured idea input: ${ideaSubmissionInputFile(root, submission)}`);
    for (const cycle of await listIdeaCycles(root, submission)) {
      const cycleRoot = ideaCycleDirectory(root, submission, cycle);
      for (const entry of cycleHistory) {
        if (isPending(entry, plan, { reviewer: options.reviewer, submission, cycle })) {
          continue;
        }
        if ((await entry.read(cycleRoot)) !== null) {
          lines.push(
            `  - cycle ${String(cycle)} ${entry.label}: ${path.join(
              cycleRoot,
              entry.declaration.pathFromArtifactsRoot,
            )}`,
          );
        }
      }
    }
    // The decision is a submission-level artifact, not a cycle-level one.
    if ((await readSubmissionArtifact(root, submission, decisionArtifact)) !== null) {
      lines.push(
        `  - decision record: ${ideaSubmissionArtifactFile(root, submission, decisionArtifact)}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * The current captured idea as invocation context. The captured input is authoritative for what
 * the author now proposes; the worktree is where the connected project is read.
 */
export function capturedIdeaText(root: string, plan: IdeaRoundPlan, input: IdeaInput): string {
  return [
    `Current captured idea: ${input.taskKey}`,
    'The captured input below is authoritative for what the author now proposes; earlier',
    'submissions, briefs and council feedback are history, not the current proposal.',
    JSON.stringify({ issue: input.issue, conversation: input.conversation }, null, 2),
    `Captured input artifact: ${ideaSubmissionInputFile(root, plan.submission)}`,
    `Connected project worktree: ${path.join(root, worktreeDirectory)}`,
  ].join('\n');
}

/**
 * The shared instruction every idea role receives with the connected project's guidance: follow
 * the applicable AGENTS.md instructions, and treat the architecture and project documents that
 * file links as evidence for the current idea rather than as instructions for the role.
 */
export const projectGuidanceInstruction = [
  'Follow its applicable instructions. Treat the architecture and project documents it links as',
  'evidence to consult only when relevant to the current idea; do not open every link by default.',
  'Architecture specifications document how the project is designed and behaves and are never role',
  'instructions.',
].join('\n');

/** The connected project's root AGENTS.md content, or null when the project has none. */
export async function projectGuidanceText(root: string): Promise<string | null> {
  const file = path.join(root, worktreeDirectory, 'AGENTS.md');
  const text = await readDocumentText(file, 'Project AGENTS.md');
  if (text === null || text.trim() === '') {
    return null;
  }
  return [
    `The connected project's root AGENTS.md (${file}):`,
    projectGuidanceInstruction,
    text,
  ].join('\n');
}

/** The response-format instruction for one role's declared output schema. */
export function responseFormatText(schema: z.ZodType): string {
  return [
    'Return only one JSON object, without Markdown fences and without other text, matching:',
    JSON.stringify(z.toJSONSchema(schema), null, 2),
  ].join('\n');
}

/** Parse one role's returned report against its declared response schema. */
export function parseAgentReport<Schema extends z.ZodType>(
  output: string,
  schema: Schema,
  role: string,
): z.output<Schema> {
  const parsed = parseDocument(output, schema);
  if (parsed.kind === 'invalid-json') {
    throw new Error(`The ${role} returned unusable output: ${messageOf(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  if (parsed.kind === 'invalid-content') {
    throw new Error(
      `The ${role}'s report does not match the response format: ` +
        describeIssues(parsed.error, '<report>'),
      { cause: parsed.error },
    );
  }
  return parsed.content as z.output<Schema>;
}

/** What one idea role invocation needs: its plan, context and declared response schema. */
export type IdeaInvocationSettings<Schema extends z.ZodType> = {
  /** The refinement area the invocation's context refers to. */
  readonly root: string;
  /** The current round plan, which selects the role's profile. */
  readonly plan: IdeaRoundPlan;
  /** The idea role this invocation carries. */
  readonly role: IdeaRole;
  /** The operation name the invocation boundary carries. */
  readonly operation: string;
  /** The idea the invocation works on. */
  readonly taskKey: string;
  /** The caller-prepared context: role instructions, captured idea, history and sources. */
  readonly context: string;
  readonly schema: Schema;
  /** The role's agent runner: it assigns the invocation's identity and transports its activity. */
  readonly runner: AgentRoleRunner;
};

/**
 * Run one idea role through AgentRuntime with the profile the round plan selected, then parse its
 * declared report. The runner assigns the invocation's identity and announces its boundaries, so
 * concurrent roles stay attributable; a provider failure is an execution error.
 */
export async function invokeIdeaRole<Schema extends z.ZodType>(
  settings: IdeaInvocationSettings<Schema>,
): Promise<z.output<Schema>> {
  const profile = settings.plan.profiles[settings.role];
  if (profile === undefined) {
    throw new Error(
      `The idea round plan (submission ${String(settings.plan.submission)}, cycle ` +
        `${String(settings.plan.cycle)}) selects no "${settings.role}" profile.`,
    );
  }
  const result = await settings.runner.run({
    operation: settings.operation,
    profile,
    workspace: { root: settings.root },
    context: [
      ideaDefinitionText,
      ideaStageGuidanceText,
      ideaCommunicationText,
      settings.context,
    ].join('\n\n'),
    idea: settings.taskKey,
  });
  if (!result.ok) {
    throw new Error(result.fault.message);
  }
  return parseAgentReport(result.value.output, settings.schema, `"${settings.role}" agent`);
}

/** Publish one idea action's saved artifact as its outcome event. */
export function publishIdeaOutcome(settings: {
  readonly publish: EventPublisher;
  readonly source: string;
  readonly taskKey: string;
  readonly cycle: number;
  readonly outcome: string;
  readonly detail: string | null;
  readonly artifact: string;
}): void {
  settings.publish(
    actionOutcomeEvent(settings.source, {
      task: settings.taskKey,
      round: null,
      cycle: settings.cycle,
      outcome: settings.outcome,
      detail: settings.detail,
      artifact: { path: settings.artifact },
    }),
  );
}

/** The council results of one cycle, in reviewer order; a missing result is an error. */
export async function cycleCouncilReports(
  root: string,
  plan: IdeaRoundPlan,
): Promise<CouncilReport[]> {
  const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
  const reports: CouncilReport[] = [];
  for (const reviewer of councilReviewers) {
    const report = await readCycleArtifact(cycleRoot, councilArtifacts[reviewer]);
    if (report === null) {
      throw new Error(
        `No ${reviewer} council result exists for submission ${String(plan.submission)} ` +
          `cycle ${String(plan.cycle)}.`,
      );
    }
    reports.push(report);
  }
  return reports;
}
