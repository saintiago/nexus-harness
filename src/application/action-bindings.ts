import path from 'node:path';
import { createAgentRuntime, type AgentResult, type IdeaRole } from '../agent-runtime/index.js';
import type { CodingRuntime } from '../adapters/coding-runtime.js';
import type { GitAdapter } from '../adapters/git.js';
import type { GitHubAdapter } from '../adapters/github.js';
import type { JiraAdapter } from '../adapters/jira.js';
import type {
  ProcessCommand,
  ProcessOutputObserver,
  ProcessResult,
} from '../adapters/processes.js';
import {
  preparationStages,
  type NexusConfiguration,
  type PreparationStage,
  type ProjectConfiguration,
} from '../configuration/index.js';
import { messageOf } from '../result.js';
import {
  beginAgentInvocation,
  type AgentActivityPublisher,
  type AgentRoleRunner,
  type BoundAction,
  type EventPublisher,
} from '../task-engine/index.js';
import {
  createAnalyzeExperience,
  createAnalyzeExperienceAction,
} from '../task-engine/actions/analyze-experience/index.js';
import { createChallenger } from '../task-engine/actions/challenger/index.js';
import { createCompleteTask } from '../task-engine/actions/complete-task/index.js';
import { createDeliver } from '../task-engine/actions/deliver/index.js';
import { createDevelop } from '../task-engine/actions/develop/index.js';
import { createIdeaEditor } from '../task-engine/actions/idea-editor/index.js';
import {
  createPrepareArea,
  type PreparationArea,
} from '../task-engine/actions/preparation/prepare-stage/index.js';
import { createRecordStageReturn } from '../task-engine/actions/preparation/record-stage-return/index.js';
import { createStageAuthor } from '../task-engine/actions/preparation/stage-author/index.js';
import { createStageEvaluator } from '../task-engine/actions/preparation/stage-evaluator/index.js';
import { createReviewPreparationPublication } from '../task-engine/actions/preparation/review-publication/index.js';
import { createStageResult } from '../task-engine/actions/preparation/stage-result/index.js';
import { createStartStageRound } from '../task-engine/actions/preparation/start-stage-round/index.js';
import { createPrepareWorkspace } from '../task-engine/actions/prepare-workspace/index.js';
import { createProjectGuide } from '../task-engine/actions/project-guide/index.js';
import { createCompleteDelivery } from '../task-engine/actions/project/complete-delivery/index.js';
import { createImplementationHandoff } from '../task-engine/actions/project/implementation-handoff/index.js';
import { createPublishPreparation } from '../task-engine/actions/project/publish-preparation/index.js';
import { createRouteSelection } from '../task-engine/actions/project/route-selection/index.js';
import { readHandoff } from '../task-engine/actions/project/state.js';
import {
  createPublishDeliveryReport,
  createPublishReviewFeedback,
  createRefreshTaskInput,
} from '../task-engine/actions/project/source-boundaries/index.js';
import {
  createPublishDecision,
  createRecordIdeaDecision,
} from '../task-engine/actions/publish-decision/index.js';
import { readRequiredRecord } from '../task-engine/actions/records.js';
import { selectionFailureDeclaration } from '../task-engine/actions/select-work/artifacts.js';
import { createResearcher } from '../task-engine/actions/researcher/index.js';
import { createRouteDeliveryEntry } from '../task-engine/actions/route-delivery-entry/index.js';
import { createReview } from '../task-engine/actions/review/index.js';
import { createSelectWork } from '../task-engine/actions/select-work/index.js';
import {
  selectionDeclaration,
  type Selection,
} from '../task-engine/actions/select-task/artifacts.js';
import { createStartIdeaRound } from '../task-engine/actions/start-idea-round/index.js';
import { createStartRound } from '../task-engine/actions/start-round/index.js';
import { createVerify } from '../task-engine/actions/verify/index.js';
import {
  createAgentRuntimeSettings,
  experienceStoreDirectory,
  workspaceRoot,
  type ExecutionPaths,
  type ProfileRole,
} from './composition.js';
import {
  finiteDeliveryHandoff,
  finiteTerminalOf,
  ideaPublicationHandoff,
  ideaPublicationTerminals,
  isPreparationTerminal,
  preparationHandoff,
  selectionFailureHandoff,
  type PreparationTerminal,
} from './analysis-handoff.js';

/**
 * The worker's action binding: Application assembles every operation the project parent and its
 * invoked children use from resolved configuration and the worker's components. Workspace-scoped
 * operations resolve the selected issue's workspace when they run; one worker execution processes
 * several issues and each selection retains its own workspace.
 */

/** The Processes adapter capability the actions run configured commands with. */
export type CommandExecution = (
  command: ProcessCommand,
  onOutput: ProcessOutputObserver,
) => Promise<ProcessResult>;

/** What the worker supplies the action binding: resolved settings, components and paths. */
export type ActionBindingSettings = {
  readonly project: ProjectConfiguration;
  readonly nexus: NexusConfiguration;
  readonly paths: ExecutionPaths;
  readonly jira: JiraAdapter;
  readonly github: GitHubAdapter;
  readonly git: GitAdapter;
  readonly codingRuntime: CodingRuntime;
  readonly runCommand: CommandExecution;
  /** The environment configured commands and agents run with. */
  readonly commandEnvironment: Readonly<Record<string, string>>;
  /** The execution's agent activity directory: every invocation's own log lives under it. */
  readonly activityDirectory: string;
  /** Wait before the next poll or confirmation read, supplied so tests control time. */
  readonly wait: (milliseconds: number) => Promise<void>;
};

/**
 * Bind the project parent's operations and its children's operations to their implementations.
 * Each agent-backed action receives its role's runner, which carries the invocation's identity and
 * its attributable activity on the engine's separate activity channel.
 */
export function createActionBinding(
  settings: ActionBindingSettings,
): (
  publish: EventPublisher,
  publishActivity: AgentActivityPublisher,
) => Readonly<Record<string, BoundAction>> {
  return (publish, publishActivity) => {
    const { project, nexus, paths } = settings;
    const { taskSource } = project;
    const { selectionFile } = paths;

    /** The parent's retained selection, resolved when an action runs. */
    const selected = async (): Promise<Selection> =>
      readRequiredRecord(selectionFile, selectionDeclaration, 'Selection');

    /** An action constructed with the retained selection when it is invoked. */
    const withSelection = (create: (selection: Selection) => BoundAction): BoundAction => {
      return async (input?: unknown) => create(await selected())(input);
    };

    // One runner per role: a profile selected for several roles carries only the invoked role's
    // constant instructions.
    const developerRunner = agentRunnerFor(settings, publish, publishActivity, 'developer');
    const reviewerRunner = agentRunnerFor(settings, publish, publishActivity, 'reviewer');
    const editorRunner = agentRunnerFor(settings, publish, publishActivity, 'idea-editor');
    const researcherRunner = agentRunnerFor(settings, publish, publishActivity, 'researcher');
    const projectGuideRunner = agentRunnerFor(settings, publish, publishActivity, 'project-guide');
    const challengerRunner = agentRunnerFor(settings, publish, publishActivity, 'challenger');

    // The four evaluated preparation stages each carry their own author and evaluator roles.
    const stageAuthors = Object.fromEntries(
      preparationStages.map((stage) => [
        stage,
        agentRunnerFor(settings, publish, publishActivity, stageAuthorRole(stage)),
      ]),
    ) as Record<PreparationStage, AgentRoleRunner>;
    const stageEvaluators = Object.fromEntries(
      preparationStages.map((stage) => [
        stage,
        agentRunnerFor(settings, publish, publishActivity, stageEvaluatorRole(stage)),
      ]),
    ) as Record<PreparationStage, AgentRoleRunner>;

    /** The operation's stage input, or an execution error naming the unknown value. */
    function stageOfInput(input: unknown): PreparationStage {
      const stage =
        typeof input === 'object' && input !== null
          ? (input as { readonly stage?: unknown }).stage
          : undefined;
      const found = preparationStages.find((candidate) => candidate === stage);
      if (found === undefined) {
        throw new Error(
          `The preparation workflow supplied the unknown stage ${JSON.stringify(stage)}.`,
        );
      }
      return found;
    }

    /** Dispatch one stage operation to the area action of the stage the workflow supplied. */
    const forStage = (actions: Readonly<Record<PreparationStage, BoundAction>>): BoundAction => {
      return async (input?: unknown) => actions[stageOfInput(input)](input);
    };

    const prepareAreas: Readonly<Record<PreparationArea, BoundAction>> = {
      requirements: createPrepareArea({
        selectionFile,
        area: 'requirements',
        repository: project.repository,
        git: settings.git,
        publish,
      }),
      ux: createPrepareArea({
        selectionFile,
        area: 'ux',
        repository: project.repository,
        git: settings.git,
        publish,
      }),
      prototype: createPrepareArea({
        selectionFile,
        area: 'prototype',
        repository: project.repository,
        git: settings.git,
        publish,
      }),
      architecture: createPrepareArea({
        selectionFile,
        area: 'architecture',
        repository: project.repository,
        git: settings.git,
        publish,
      }),
      refinement: createPrepareArea({
        selectionFile,
        area: 'refinement',
        repository: project.repository,
        git: settings.git,
        publish,
      }),
    };

    const stageRounds = Object.fromEntries(
      preparationStages.map((stage) => {
        const profiles = nexus.preparation.profiles[stage];
        return [
          stage,
          createStartStageRound({
            selectionFile,
            stage,
            profiles: {
              // The prototype stage configures an ordered author ladder; the others one author.
              authors: 'authors' in profiles ? profiles.authors : [profiles.author],
              evaluator: profiles.evaluator,
            },
            maxRounds: nexus.preparation.maxRounds,
            publish,
          }),
        ];
      }),
    ) as Record<PreparationStage, BoundAction>;

    const stageAuthorActions = Object.fromEntries(
      preparationStages.map((stage) => [
        stage,
        createStageAuthor({ selectionFile, stage, runner: stageAuthors[stage], publish }),
      ]),
    ) as Record<PreparationStage, BoundAction>;

    const stageEvaluatorActions = Object.fromEntries(
      preparationStages.map((stage) => [
        stage,
        createStageEvaluator({
          selectionFile,
          stage,
          runner: stageEvaluators[stage],
          git: settings.git,
          publish,
        }),
      ]),
    ) as Record<PreparationStage, BoundAction>;

    const stageReturnActions = Object.fromEntries(
      preparationStages.map((stage) => [
        stage,
        createRecordStageReturn({
          selectionFile,
          stage,
          maxUpstreamReturns: nexus.preparation.maxUpstreamReturns,
          publish,
        }),
      ]),
    ) as Record<PreparationStage, BoundAction>;

    const stageResultActions = Object.fromEntries(
      preparationStages.map((stage) => [
        stage,
        createStageResult({ selectionFile, stage, git: settings.git, publish }),
      ]),
    ) as Record<PreparationStage, BoundAction>;

    // The worker records terminal handoffs; Application supervises the action's analysis, memory
    // calls and submission, so this instance never contacts the service or a provider.
    const analyzeExperience = createAnalyzeExperienceAction({
      owner: createAnalyzeExperience(experienceCaptureSettings(nexus, paths, taskSource.project)),
      publish,
    });

    /**
     * AnalyzeExperience's binding: resolve the selected issue and the producer-owned evidence of
     * the terminal handoff the workflow state supplied, then record it once. Idea terminals record
     * the parent's publication; finite terminals record the child's completion evidence.
     */
    const experienceAction: BoundAction = async (input?: unknown) => {
      if (!analysisEnabled(nexus)) {
        return 'skipped';
      }
      const terminal =
        typeof input === 'object' && input !== null
          ? (input as { readonly terminal?: unknown }).terminal
          : undefined;
      try {
        if (terminal === 'selection-failed') {
          const failureFile = path.join(
            path.dirname(selectionFile),
            selectionFailureDeclaration.file,
          );
          const failure = await readRequiredRecord(
            failureFile,
            selectionFailureDeclaration,
            'Selection failure',
          );
          return await analyzeExperience(await selectionFailureHandoff({ failure, failureFile }));
        }
        const selection = await selected();
        if (
          typeof terminal === 'string' &&
          ideaPublicationTerminals.some((candidate) => candidate === terminal)
        ) {
          const handoff = await ideaPublicationHandoff({
            selection,
            terminal: terminal as (typeof ideaPublicationTerminals)[number],
          });
          return await analyzeExperience(handoff);
        }
        if (isPreparationTerminal(terminal)) {
          // The published stage is supplied with the terminal: an advance has already moved the
          // retained selection to its destination, so its stage no longer names the evidence.
          const publishedStage =
            preparationStages.find(
              (candidate) =>
                candidate ===
                (typeof input === 'object' && input !== null
                  ? (input as { readonly stage?: unknown }).stage
                  : undefined),
            ) ?? preparationStages.find((candidate) => candidate === selection.stage);
          if (publishedStage === undefined) {
            throw new Error(
              `The "${terminal}" preparation terminal names no preparation stage; its evidence ` +
                'cannot be selected.',
            );
          }
          return await analyzeExperience(
            await preparationHandoff({
              selection,
              terminal: terminal as PreparationTerminal,
              stage: publishedStage,
            }),
          );
        }
        return await analyzeExperience(
          await finiteDeliveryHandoff({ selection, terminal: finiteTerminalOf(input) }),
        );
      } catch (error) {
        return captureUnavailable(publish, terminal, error);
      }
    };

    const implementation = taskSource.implementation;
    const handoffAction: BoundAction = async () => {
      if (implementation === undefined) {
        throw new Error(
          'The Architecture handoff requires the project implementation-ticket settings.',
        );
      }
      return createImplementationHandoff({
        selectionFile,
        project: taskSource.project,
        repository: project.delivery.repository,
        baseBranch: project.delivery.baseBranch,
        reviewCheck: project.delivery.reviewCheck,
        nexusLens: { appId: nexus.nexusLens.appId, login: nexus.nexusLens.login },
        postMergeChecks: project.delivery.postMergeChecks,
        architectureStatus: taskSource.preparation?.statuses.architecture ?? null,
        implementation: {
          issueType: implementation.issueType,
          labels: implementation.labels,
          status: implementation.status,
          linkType: implementation.linkType,
        },
        doneStatus: taskSource.statuses.done,
        completion: project.delivery.completion,
        git: settings.git,
        github: settings.github,
        jira: settings.jira,
        publish,
        wait: settings.wait,
      })();
    };

    return {
      // ---- parent-owned source operations ----
      SelectWork: createSelectWork({
        selectionFile,
        workspaceRoot: workspaceRoot(nexus),
        project: taskSource.project,
        selection: taskSource.selection,
        ideas: taskSource.ideas.selection,
        statuses: taskSource.statuses,
        preparation: taskSource.preparation,
        ideaStatuses: taskSource.ideas.statuses,
        workspacePointerField: taskSource.fields.workspacePointer,
        jira: settings.jira,
        publish,
      }),
      RouteSelection: createRouteSelection({ selectionFile }),
      PublishIdeaResult: withSelection((selection) =>
        createPublishDecision({
          selection,
          refinementRoot: path.join(selection.workspace.root, 'refinement'),
          expected: [taskSource.ideas.statuses.active],
          statuses: {
            approved: taskSource.ideas.statuses.approved,
            waitingForFeedback: taskSource.ideas.statuses.waitingForFeedback,
          },
          jira: settings.jira,
          publish,
        }),
      ),
      PublishPreparationResult: createPublishPreparation({
        selectionFile,
        statuses: taskSource.preparation?.statuses,
        waitingForFeedback: taskSource.ideas.statuses.waitingForFeedback,
        ideaActive: taskSource.ideas.statuses.active,
        jira: settings.jira,
        publish,
      }),
      HandoffImplementation: handoffAction,
      CompleteDelivery: createCompleteDelivery({
        selectionFile,
        doneStatus: taskSource.statuses.done,
        reviewStatus: taskSource.statuses.review,
        jira: settings.jira,
        publish,
      }),
      // ---- parent-owned finite-delivery boundary actors ----
      RefreshTaskInput: createRefreshTaskInput({
        selectionFile,
        jira: settings.jira,
        publish,
      }),
      PublishDeliveryReport: createPublishDeliveryReport({
        selectionFile,
        pullRequestField: taskSource.fields.pullRequest,
        inProgressStatus: taskSource.statuses.inProgress,
        reviewStatus: taskSource.statuses.review,
        jira: settings.jira,
        publish,
      }),
      PublishReviewFeedback: createPublishReviewFeedback({
        selectionFile,
        jira: settings.jira,
        publish,
      }),
      // ---- idea refinement child ----
      PrepareIdeaWorkspace: prepareAreas.refinement,
      StartIdeaRound: async (input?: unknown) => {
        const selection = await selected();
        // The parent's retained correction reaches the refinement: a specific question the item
        // waited on, or a later stage's concrete return under the idea destination.
        const handoff = await readHandoff(selection.workspace.root);
        return createStartIdeaRound({
          workspace: { root: path.join(selection.workspace.root, 'refinement') },
          input: {
            taskKey: selection.taskKey,
            source: selection.source,
            issue: selection.task,
            conversation: [...selection.conversation],
            parentInput: {
              question: handoff?.feedback?.stage === 'idea' ? handoff.feedback.question : null,
              returnFinding:
                handoff?.return?.to === 'idea'
                  ? {
                      from: handoff.return.from,
                      problem: handoff.return.problem,
                      consequence: handoff.return.consequence,
                      correction: handoff.return.correction,
                    }
                  : null,
            },
          },
          profiles: ideaProfiles(nexus),
          maxCycles: nexus.ideaRefinement.maxCycles,
          publish,
        })(input);
      },
      IdeaEditor: withSelection((selection) =>
        createIdeaEditor({
          workspace: { root: path.join(selection.workspace.root, 'refinement') },
          runner: editorRunner,
          publish,
        }),
      ),
      Researcher: withSelection((selection) =>
        createResearcher({
          workspace: { root: path.join(selection.workspace.root, 'refinement') },
          runner: researcherRunner,
          publish,
        }),
      ),
      ProjectGuide: withSelection((selection) =>
        createProjectGuide({
          workspace: { root: path.join(selection.workspace.root, 'refinement') },
          runner: projectGuideRunner,
          publish,
        }),
      ),
      Challenger: withSelection((selection) =>
        createChallenger({
          workspace: { root: path.join(selection.workspace.root, 'refinement') },
          runner: challengerRunner,
          publish,
        }),
      ),
      RecordIdeaDecision: createRecordIdeaDecision({
        selectionFile,
        submittedStatus: taskSource.ideas.statuses.submitted,
        publish,
      }),
      // ---- evaluated preparation child ----
      PrepareStage: forStage(
        Object.fromEntries(
          preparationStages.map((stage) => [stage, prepareAreas[stage]]),
        ) as Record<PreparationStage, BoundAction>,
      ),
      StartStageRound: forStage(stageRounds),
      StageAuthor: forStage(stageAuthorActions),
      StageEvaluator: forStage(stageEvaluatorActions),
      RecordStageReturn: forStage(stageReturnActions),
      ReviewPreparationPublication: createReviewPreparationPublication({
        selectionFile,
        baseBranch: project.delivery.baseBranch,
        reviewerProfile: nexus.executionPolicy.reviewerProfile,
        reviewer: reviewerRunner,
        git: settings.git,
        publish,
      }),
      StageResult: forStage(stageResultActions),
      // ---- finite delivery child ----
      RouteDeliveryEntry: createRouteDeliveryEntry({ selectionFile }),
      PrepareWorkspace: createPrepareWorkspace({
        selectionFile,
        repository: project.repository,
        preparation: project.preparation,
        environment: settings.commandEnvironment,
        git: settings.git,
        runCommand: settings.runCommand,
        publish,
      }),
      StartRound: withSelection((selection) =>
        createStartRound({
          taskKey: selection.taskKey,
          workspace: selection.workspace,
          developerLadder: nexus.executionPolicy.developerLadder,
          publish,
        }),
      ),
      Develop: createDevelop({
        selectionFile,
        runner: developerRunner,
        git: settings.git,
        publish,
      }),
      Verify: withSelection((selection) =>
        createVerify({
          workspace: selection.workspace,
          checks: project.checks,
          environment: settings.commandEnvironment,
          git: settings.git,
          runCommand: settings.runCommand,
          publish,
        }),
      ),
      Review: createReview({
        selectionFile,
        repository: project.delivery.repository,
        reviewCheck: project.delivery.reviewCheck,
        nexusLens: { appId: nexus.nexusLens.appId, login: nexus.nexusLens.login },
        reviewerProfile: nexus.executionPolicy.reviewerProfile,
        runner: reviewerRunner,
        git: settings.git,
        github: settings.github,
        publish,
      }),
      Deliver: createDeliver({
        selectionFile,
        repository: project.delivery.repository,
        baseBranch: project.delivery.baseBranch,
        git: settings.git,
        github: settings.github,
        publish,
        wait: settings.wait,
      }),
      CompleteTask: createCompleteTask({
        selectionFile,
        repository: project.delivery.repository,
        reviewCheck: project.delivery.reviewCheck,
        nexusLens: { appId: nexus.nexusLens.appId },
        postMergeChecks: project.delivery.postMergeChecks,
        completion: project.delivery.completion,
        github: settings.github,
        publish,
        wait: settings.wait,
      }),
      // ---- shared terminal handoff ----
      AnalyzeExperience: experienceAction,
    };
  };
}

/** The agent role profile name one stage author uses. */
function stageAuthorRole(stage: PreparationStage): ProfileRole {
  switch (stage) {
    case 'requirements':
      return 'requirements-author';
    case 'ux':
      return 'ux-author';
    case 'prototype':
      return 'prototype-author';
    case 'architecture':
      return 'architecture-author';
  }
}

/** The agent role profile name one stage evaluator uses. */
function stageEvaluatorRole(stage: PreparationStage): ProfileRole {
  switch (stage) {
    case 'requirements':
      return 'requirements-evaluator';
    case 'ux':
      return 'ux-evaluator';
    case 'prototype':
      return 'prototype-evaluator';
    case 'architecture':
      return 'architecture-evaluator';
  }
}

/**
 * One role's agent runner: the shared caller boundary of AgentRuntime. A profile selected for
 * several roles carries only the invoked role's constant instructions. The runner assigns each
 * invocation's identity, announces its boundaries on the engine's event stream, transports its
 * activity on the engine's activity channel and runs the selected profile.
 */
function agentRunnerFor(
  settings: ActionBindingSettings,
  publish: EventPublisher,
  publishActivity: AgentActivityPublisher,
  role: ProfileRole,
): AgentRoleRunner {
  const runtime = createAgentRuntime(
    createAgentRuntimeSettings(settings.nexus, role, settings.codingRuntime),
  );
  return {
    async run(request): Promise<AgentResult> {
      const invocation = beginAgentInvocation({
        agentName: role,
        operation: request.operation,
        ...(request.invocationId === undefined ? {} : { invocationId: request.invocationId }),
        profile: request.profile,
        task: request.task ?? null,
        idea: request.idea ?? null,
        summary: request.summary ?? null,
        directory: settings.activityDirectory,
        publish,
        publishActivity,
      });
      let result: AgentResult;
      try {
        result = await runtime.run(
          request.profile,
          request.workspace,
          request.context,
          (activity) => invocation.activity(activity),
          request.outputSchema,
        );
      } catch (error) {
        invocation.finish({ outcome: 'failed', reason: messageOf(error) });
        throw error;
      }
      invocation.finish(
        result.ok ? { outcome: 'finished' } : { outcome: 'failed', reason: result.fault.message },
      );
      return result;
    },
  };
}

/** Whether the configured memory integration records and analyzes terminal handoffs at all. */
function analysisEnabled(nexus: NexusConfiguration): boolean {
  const memory = nexus.memory;
  return memory !== undefined && memory.enabled;
}

/**
 * Report one capture that could not even resolve its handoff. The workflow preserves the terminal
 * outcome it reached; the failure is reported on the event stream because it saved no capture
 * evidence to reference.
 */
function captureUnavailable(
  publish: EventPublisher,
  terminal: unknown,
  error: unknown,
): 'unavailable' {
  try {
    publish({
      source: 'analyze-experience',
      type: 'unavailable',
      data: { terminal, reason: messageOf(error) },
    });
  } catch {
    // Reporting is not part of the terminal outcome.
  }
  return 'unavailable';
}

/**
 * AnalyzeExperience's worker-side settings: the terminal handoffs are recorded in the project's
 * durable store, while the analysis, memory calls and submission stay with the instance
 * Application supervises. Disabled memory records nothing.
 */
function experienceCaptureSettings(
  nexus: NexusConfiguration,
  paths: ExecutionPaths,
  project: string,
): Parameters<typeof createAnalyzeExperience>[0] {
  const memory = nexus.memory !== undefined && nexus.memory.enabled ? nexus.memory : null;
  return {
    directory: experienceStoreDirectory(paths),
    project,
    profile: memory === null ? null : memory.analysisProfile,
    memory: memory === null ? null : { url: memory.serviceUrl },
    analyze: null,
  };
}

/** The configured profile of each idea refinement role. */
function ideaProfiles(nexus: NexusConfiguration): Readonly<Record<IdeaRole, string>> {
  const { editor, researcher, projectGuide, challenger } = nexus.ideaRefinement.profiles;
  return {
    'idea-editor': editor,
    researcher,
    'project-guide': projectGuide,
    challenger,
  };
}
