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
import type {
  NexusConfiguration,
  ProjectConfiguration,
  WorkflowName,
} from '../configuration/index.js';
import { messageOf } from '../result.js';
import {
  beginAgentInvocation,
  type AgentActivityPublisher,
  type AgentRoleRunner,
  type BoundAction,
  type EventPublisher,
} from '../task-engine/index.js';
import { createBriefWriter } from '../task-engine/actions/brief-writer/index.js';
import { createCompleteTask } from '../task-engine/actions/complete-task/index.js';
import { createDeliver } from '../task-engine/actions/deliver/index.js';
import { createDevelop } from '../task-engine/actions/develop/index.js';
import { createPrepareWorkspace } from '../task-engine/actions/prepare-workspace/index.js';
import { createPublishDecision } from '../task-engine/actions/publish-decision/index.js';
import { createPurposeVerifier } from '../task-engine/actions/purpose-verifier/index.js';
import { readRequiredRecord } from '../task-engine/actions/records.js';
import { createResearcher } from '../task-engine/actions/researcher/index.js';
import { createCouncilReviewer } from '../task-engine/actions/review-council/index.js';
import { createReview } from '../task-engine/actions/review/index.js';
import { createSelectIdea } from '../task-engine/actions/select-idea/index.js';
import {
  ideaSelectionDeclaration,
  type IdeaSelection,
} from '../task-engine/actions/select-idea/artifacts.js';
import {
  selectionDeclaration,
  type Selection,
} from '../task-engine/actions/select-task/artifacts.js';
import { createSelectTask } from '../task-engine/actions/select-task/index.js';
import { createStartIdeaRound } from '../task-engine/actions/start-idea-round/index.js';
import { createStartRound } from '../task-engine/actions/start-round/index.js';
import { createVerify } from '../task-engine/actions/verify/index.js';
import {
  createAgentRuntimeSettings,
  workspaceRoot,
  type ExecutionPaths,
  type ProfileRole,
} from './composition.js';

/**
 * The worker's action binding: Application assembles the implementations the workflow invokes from
 * resolved configuration and the worker's components. Workspace-scoped actions resolve the task
 * workspace of the current selection when they run, because one worker execution processes several
 * tasks and each selection retains its own workspace.
 */

/** The Processes adapter capability the actions run configured commands with. */
export type CommandExecution = (
  command: ProcessCommand,
  onOutput: ProcessOutputObserver,
) => Promise<ProcessResult>;

/** What the worker supplies the action binding: resolved settings, components and paths. */
export type ActionBindingSettings = {
  /** The workflow this binding assembles the actions for. */
  readonly workflow: WorkflowName;
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
  /** Wait before the next completion poll, supplied so tests control time instead of passing it. */
  readonly wait: (milliseconds: number) => Promise<void>;
};

/**
 * Bind the selected workflow's operations to their action implementations. Each agent-backed
 * action receives its role's agent runner, which carries the invocation's identity and its
 * attributable activity on the engine's separate activity channel.
 */
export function createActionBinding(
  settings: ActionBindingSettings,
): (
  publish: EventPublisher,
  publishActivity: AgentActivityPublisher,
) => Readonly<Record<string, BoundAction>> {
  return (publish, publishActivity) =>
    settings.workflow === 'idea-refinement'
      ? ideaRefinementActions(settings, publish, publishActivity)
      : finiteDeliveryActions(settings, publish, publishActivity);
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
        profile: request.profile,
        task: request.task ?? null,
        idea: request.idea ?? null,
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

/** The finite delivery workflow's bound operations. */
function finiteDeliveryActions(
  settings: ActionBindingSettings,
  publish: EventPublisher,
  publishActivity: AgentActivityPublisher,
): Readonly<Record<string, BoundAction>> {
  const { project, nexus, paths } = settings;
  const { selectionFile } = paths;
  // One runner per role: a profile selected for several roles carries only the invoked role's
  // constant instructions.
  const developerRunner = agentRunnerFor(settings, publish, publishActivity, 'developer');
  const reviewerRunner = agentRunnerFor(settings, publish, publishActivity, 'reviewer');

  /** An action constructed with the selection the workflow currently retains. */
  const selectedWorkspace = (create: (selection: Selection) => BoundAction): BoundAction => {
    return async () => {
      const selection = await readRequiredRecord(selectionFile, selectionDeclaration, 'Selection');
      return create(selection)();
    };
  };

  const { taskSource, repository, checks, preparation, delivery } = project;
  return {
    SelectTask: createSelectTask({
      selectionFile,
      workspaceRoot: workspaceRoot(nexus),
      project: taskSource.project,
      selection: taskSource.selection,
      statuses: taskSource.statuses,
      workspacePointerField: taskSource.fields.workspacePointer,
      jira: settings.jira,
      publish,
    }),
    PrepareWorkspace: createPrepareWorkspace({
      selectionFile,
      repository,
      preparation,
      environment: settings.commandEnvironment,
      git: settings.git,
      runCommand: settings.runCommand,
      publish,
    }),
    StartRound: selectedWorkspace((selection) =>
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
      jira: settings.jira,
      publish,
    }),
    Verify: selectedWorkspace((selection) =>
      createVerify({
        workspace: selection.workspace,
        checks,
        environment: settings.commandEnvironment,
        git: settings.git,
        runCommand: settings.runCommand,
        publish,
      }),
    ),
    Review: createReview({
      selectionFile,
      repository: delivery.repository,
      reviewCheck: delivery.reviewCheck,
      nexusLens: { appId: nexus.nexusLens.appId, login: nexus.nexusLens.login },
      reviewerProfile: nexus.executionPolicy.reviewerProfile,
      runner: reviewerRunner,
      git: settings.git,
      github: settings.github,
      jira: settings.jira,
      publish,
    }),
    Deliver: createDeliver({
      selectionFile,
      repository: delivery.repository,
      baseBranch: delivery.baseBranch,
      pullRequestField: taskSource.fields.pullRequest,
      reviewStatus: taskSource.statuses.review,
      git: settings.git,
      github: settings.github,
      jira: settings.jira,
      publish,
    }),
    CompleteTask: createCompleteTask({
      selectionFile,
      repository: delivery.repository,
      reviewCheck: delivery.reviewCheck,
      nexusLens: { appId: nexus.nexusLens.appId },
      postMergeChecks: delivery.postMergeChecks,
      completion: delivery.completion,
      doneStatus: taskSource.statuses.done,
      github: settings.github,
      jira: settings.jira,
      publish,
      wait: settings.wait,
    }),
  };
}

/** The configured profile of each idea refinement role. */
function ideaProfiles(nexus: NexusConfiguration): Readonly<Record<IdeaRole, string>> {
  const {
    purposeVerifier,
    researcher,
    briefWriter,
    purposeCouncil,
    evidenceCouncil,
    simplicityCouncil,
  } = nexus.ideaRefinement.profiles;
  return {
    'purpose-verifier': purposeVerifier,
    researcher,
    'brief-writer': briefWriter,
    'purpose-council': purposeCouncil,
    'evidence-council': evidenceCouncil,
    'simplicity-council': simplicityCouncil,
  };
}

/**
 * The idea refinement workflow's bound operations. Every workspace-scoped operation resolves the
 * retained idea selection when it runs, so one worker run keeps working on the same captured issue.
 */
function ideaRefinementActions(
  settings: ActionBindingSettings,
  publish: EventPublisher,
  publishActivity: AgentActivityPublisher,
): Readonly<Record<string, BoundAction>> {
  const { project, nexus, paths } = settings;
  const { selectionFile } = paths;
  const { taskSource } = project;

  /** The idea selection the workflow currently retains. */
  const selectedIdea = async (): Promise<IdeaSelection> =>
    readRequiredRecord(selectionFile, ideaSelectionDeclaration, 'Selection');

  /** An action constructed with the retained idea selection when it is invoked. */
  const withSelection = (create: (selection: IdeaSelection) => BoundAction): BoundAction => {
    return async (input?: unknown) => create(await selectedIdea())(input);
  };

  /** An idea role action bound to the refinement area of the retained selection. */
  const forSelection = (create: (workspace: { readonly root: string }) => BoundAction) =>
    withSelection((selection) => create(selection.workspace));

  return {
    SelectIdea: createSelectIdea({
      selectionFile,
      workspaceRoot: workspaceRoot(nexus),
      project: taskSource.project,
      selection: taskSource.ideas.selection,
      statuses: {
        submitted: taskSource.ideas.statuses.submitted,
        active: taskSource.ideas.statuses.active,
      },
      workspacePointerField: taskSource.fields.workspacePointer,
      repository: project.repository,
      git: settings.git,
      jira: settings.jira,
      publish,
    }),
    StartIdeaRound: withSelection((selection) =>
      createStartIdeaRound({
        workspace: selection.workspace,
        input: {
          taskKey: selection.taskKey,
          source: selection.source,
          issue: selection.issue,
          conversation: selection.conversation,
        },
        profiles: ideaProfiles(nexus),
        maxCycles: nexus.ideaRefinement.maxCouncilCycles,
        publish,
      }),
    ),
    PurposeVerifier: forSelection((workspace) =>
      createPurposeVerifier({
        workspace,
        runner: agentRunnerFor(settings, publish, publishActivity, 'purpose-verifier'),
        publish,
      }),
    ),
    Researcher: forSelection((workspace) =>
      createResearcher({
        workspace,
        runner: agentRunnerFor(settings, publish, publishActivity, 'researcher'),
        publish,
      }),
    ),
    BriefWriter: forSelection((workspace) =>
      createBriefWriter({
        workspace,
        runner: agentRunnerFor(settings, publish, publishActivity, 'brief-writer'),
        publish,
      }),
    ),
    PurposeCouncil: forSelection((workspace) =>
      createCouncilReviewer({
        reviewer: 'purpose',
        workspace,
        runner: agentRunnerFor(settings, publish, publishActivity, 'purpose-council'),
        publish,
      }),
    ),
    EvidenceCouncil: forSelection((workspace) =>
      createCouncilReviewer({
        reviewer: 'evidence',
        workspace,
        runner: agentRunnerFor(settings, publish, publishActivity, 'evidence-council'),
        publish,
      }),
    ),
    SimplicityCouncil: forSelection((workspace) =>
      createCouncilReviewer({
        reviewer: 'simplicity',
        workspace,
        runner: agentRunnerFor(settings, publish, publishActivity, 'simplicity-council'),
        publish,
      }),
    ),
    PublishDecision: withSelection((selection) =>
      createPublishDecision({
        selection,
        statuses: {
          submitted: taskSource.ideas.statuses.submitted,
          approved: taskSource.ideas.statuses.approved,
          waitingForFeedback: taskSource.ideas.statuses.waitingForFeedback,
        },
        jira: settings.jira,
        publish,
      }),
    ),
  };
}
