import path from 'node:path';
import type { Observation } from '../../../memory/index.js';
import type { AgentRoleRunner, BoundAction, EventPublisher } from '../../index.js';
import {
  capturedIdeaText,
  invokeIdeaRole,
  projectGuidanceText,
  publishIdeaOutcome,
  responseFormatText,
  retainedHistoryText,
} from '../idea-context.js';
import {
  ideaCycleDirectory,
  readCycleArtifact,
  readIdeaInput,
  readIdeaPlan,
  writeCycleArtifact,
} from '../idea-storage.js';
import { editorHelpArtifact, framingArtifact } from '../idea-editor/artifacts.js';
import {
  capturedIdeaQueryMaterial,
  observationEnvelope,
  observationSourceKey,
  rememberObserved,
  retrievalQuery,
  memoryContextOf,
  type MemoryContext,
} from '../memory.js';
import { issueSummary } from '../source.js';
import {
  researchArtifact,
  researchFollowUpArtifact,
  researchResponseSchema,
  type ResearchContribution,
} from './artifacts.js';

/**
 * Researcher runs the research role. The cycle's initial enrichment works from the captured idea,
 * the retained history, the prepared project worktree and its configured web tools; a focused
 * follow-up answers the specific question the editor asked, without repeating the investigation.
 * The contribution is short, its findings and sources stay in the artifact, and a follow-up to
 * the other contributor's question is not requested of this role.
 */

export type ResearcherSettings = {
  /** The refinement area the cycle's artifacts live in. */
  readonly workspace: { readonly root: string };
  /** The research role's agent runner, which owns the invocation's identity and activity. */
  readonly runner: AgentRoleRunner;
  readonly publish: EventPublisher;
  /**
   * The memory capability, project identity and evidence directory of this execution; Application
   * supplies it, and an action without one performs no recall or ingestion.
   */
  readonly memory?: MemoryContext;
};

/** The contribution phase the workflow supplied with the invocation. */
type ResearchPhase = 'initial' | 'focused';

/**
 * The deterministic observation one saved research contribution yields: its short contribution,
 * the source facts, the idea-level options, the external sources with their access dates and the
 * focused question it answers. Detailed research stays in the saved artifact the note references.
 */
function researchObservation(settings: {
  readonly memory: MemoryContext;
  readonly taskKey: string;
  readonly subject: string | null;
  readonly submission: number;
  readonly cycle: number;
  readonly file: string;
  readonly contribution: ResearchContribution;
}): Observation {
  const selector = 'contribution';
  const content = [
    observationEnvelope({
      subjectKind: 'Idea',
      key: settings.taskKey,
      subject: settings.subject,
      project: settings.memory.project,
      role: 'researcher',
      outcome: 'contributed',
      iteration: [
        `submission ${String(settings.submission)}`,
        `cycle ${String(settings.cycle)}`,
        ...(settings.contribution.question === null ? [] : ['focused follow-up contribution']),
      ],
    }),
    `Contribution: ${settings.contribution.contribution}`,
    `Source facts: ${JSON.stringify(settings.contribution.findings)}`,
    `Idea-level options: ${JSON.stringify(settings.contribution.options)}`,
    `Sources: ${JSON.stringify(settings.contribution.sources)}`,
    ...(settings.contribution.question === null
      ? []
      : [`Focused question answered: ${settings.contribution.question}`]),
    `Detailed research remains in the saved contribution: ${settings.file}`,
  ].join('\n');
  return {
    sourceKey: observationSourceKey({
      artifact: settings.file,
      selector,
      material: { artifact: settings.contribution, content },
    }),
    content,
    provenance: {
      project: settings.memory.project,
      issue: settings.taskKey,
      workflow: settings.memory.workflow,
      role: 'researcher',
      artifact: settings.file,
      element: selector,
      submission: settings.submission,
      cycle: settings.cycle,
    },
  };
}

/** The phase the workflow supplied with the invocation. */
function phaseOf(input: unknown): ResearchPhase {
  const phase =
    typeof input === 'object' && input !== null
      ? (input as { readonly phase?: unknown }).phase
      : undefined;
  if (phase === 'initial' || phase === 'focused') {
    return phase;
  }
  throw new Error(
    `The idea workflow supplied Researcher the unknown phase ${JSON.stringify(phase)}.`,
  );
}

/** Create Researcher over the refinement area it contributes to. */
export function createResearcher(settings: ResearcherSettings): BoundAction {
  const memory = memoryContextOf(settings.memory);

  /** Observe one saved contribution; the same source key makes a reuse a no-op. */
  async function observe(contribution: {
    readonly plan: { readonly submission: number; readonly cycle: number };
    readonly input: Awaited<ReturnType<typeof readIdeaInput>>;
    readonly file: string;
    readonly value: ResearchContribution;
  }): Promise<void> {
    await rememberObserved(
      { memory: memory.memory, publish: settings.publish, source: 'researcher' },
      researchObservation({
        memory,
        taskKey: contribution.input.taskKey,
        subject: issueSummary(contribution.input.issue),
        submission: contribution.plan.submission,
        cycle: contribution.plan.cycle,
        file: contribution.file,
        contribution: contribution.value,
      }),
    );
  }

  /** Publish a saved contribution and return its workflow outcome. */
  function contributed(
    taskKey: string,
    cycle: number,
    sources: number,
    artifact: string,
  ): 'contributed' {
    publishIdeaOutcome({
      publish: settings.publish,
      source: 'researcher',
      taskKey,
      cycle,
      outcome: 'contributed',
      detail: `${String(sources)} source${sources === 1 ? '' : 's'}`,
      artifact,
    });
    return 'contributed';
  }

  return async (input?: unknown) => {
    const phase = phaseOf(input);
    const root = settings.workspace.root;
    const plan = await readIdeaPlan(root);
    const cycleRoot = ideaCycleDirectory(root, plan.submission, plan.cycle);
    const artifact = phase === 'initial' ? researchArtifact : researchFollowUpArtifact;
    const inputRecord = await readIdeaInput(root, plan.submission);
    const file = path.join(cycleRoot, artifact.pathFromArtifactsRoot);

    let question: string | null = null;
    if (phase === 'focused') {
      const help = await readCycleArtifact(cycleRoot, editorHelpArtifact);
      if (help === null || help.disposition !== 'help-requested') {
        throw new Error(
          `A focused research contribution answers an editor help request; submission ` +
            `${String(plan.submission)} cycle ${String(plan.cycle)} has none.`,
        );
      }
      question = help.help?.researcher ?? null;
      if (question === null) {
        // The editor asked the Project guide only; this role contributes nothing.
        return 'not-requested';
      }
    }

    const existing = await readCycleArtifact(cycleRoot, artifact);
    if (existing !== null) {
      await observe({ plan, input: inputRecord, file, value: existing });
      return contributed(inputRecord.taskKey, plan.cycle, existing.sources.length, file);
    }

    const guidance = await projectGuidanceText(root);
    const framing = await readCycleArtifact(cycleRoot, framingArtifact);
    const scope = {
      project: memory.project,
      workflow: memory.workflow,
      role: 'researcher',
    };
    const context = [
      question === null
        ? 'Enrich the stated idea\u2019s proposed change, why it matters and the principle behind ' +
          'it with sourced knowledge, examples and conceptual possibilities that give it substance.'
        : `Answer this focused question from the editor, without repeating the investigation:\n` +
          question,
      await capturedIdeaText(root, plan, inputRecord),
      // The Project guide contributes concurrently; its pending contribution is not this role's.
      await retainedHistoryText(root, plan, { omitCurrentCycleOf: 'project-guide' }),
      'Use the prepared worktree, project knowledge, existing work and your configured web tools.',
      'Keep suggestions and options at idea level: strengthen the author\u2019s proposal without',
      'replacing it with another idea, and produce no implementation plan or draft configuration.',
      'Give links and access dates for external sources and keep source facts distinct from your',
      'own suggestions. Do not scrutinize or reject the idea and do not select an architecture.',
      'Give the editor a short contribution with the most useful discoveries; keep the detail in',
      'this report.',
      ...(guidance === null ? [] : [guidance]),
      responseFormatText(researchResponseSchema),
    ].join('\n\n');

    const response = await invokeIdeaRole({
      root,
      plan,
      role: 'researcher',
      operation: 'Researcher',
      input: inputRecord,
      context,
      schema: researchResponseSchema,
      runner: settings.runner,
      memory,
      publish: settings.publish,
      memoryQuery: retrievalQuery(scope, [
        ...capturedIdeaQueryMaterial(inputRecord),
        ...(framing === null ? [] : [`framing: ${JSON.stringify(framing)}`]),
        ...(question === null ? [] : [`assigned focused question: ${question}`]),
      ]),
    });
    const stored: ResearchContribution = {
      ...response,
      role: 'researcher',
      question,
    };
    await writeCycleArtifact(cycleRoot, artifact, stored);
    await observe({ plan, input: inputRecord, file, value: stored });
    return contributed(inputRecord.taskKey, plan.cycle, response.sources.length, file);
  };
}
