import { createAgentRuntime, type AgentRuntime } from '../agent-runtime/index.js';
import type { CodingRuntime } from '../adapters/coding-runtime.js';
import type { GitAdapter } from '../adapters/git.js';
import type { GitHubAdapter } from '../adapters/github.js';
import type { JiraAdapter } from '../adapters/jira.js';
import type {
  ProcessCommand,
  ProcessOutputObserver,
  ProcessResult,
} from '../adapters/processes.js';
import type { NexusConfiguration, ProjectConfiguration } from '../configuration/index.js';
import type { BoundAction, EventPublisher } from '../task-engine/index.js';
import { createCompleteTask } from '../task-engine/actions/complete-task/index.js';
import { createDeliver } from '../task-engine/actions/deliver/index.js';
import { createDevelop } from '../task-engine/actions/develop/index.js';
import { createPrepareWorkspace } from '../task-engine/actions/prepare-workspace/index.js';
import { readRequiredRecord } from '../task-engine/actions/records.js';
import { createReview } from '../task-engine/actions/review/index.js';
import { selectionDeclaration } from '../task-engine/actions/select-task/artifacts.js';
import { createSelectTask } from '../task-engine/actions/select-task/index.js';
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
  /** Wait before the next completion poll, supplied so tests control time instead of passing it. */
  readonly wait: (milliseconds: number) => Promise<void>;
};

/**
 * Bind every workflow operation to its action implementation. The AgentRuntime publishes its
 * activity through the engine's event publisher, so ordinary events and agent activity travel the
 * same stream; the invocation boundary events name the calling action.
 */
export function createActionBinding(
  settings: ActionBindingSettings,
): (publish: EventPublisher) => Readonly<Record<string, BoundAction>> {
  const { project, nexus, paths } = settings;
  const { selectionFile } = paths;

  return (publish) => {
    // One runtime per role: a profile selected for several roles carries only the invoked role's
    // constant instructions.
    const runtimeFor = (role: ProfileRole): AgentRuntime =>
      createAgentRuntime(
        createAgentRuntimeSettings(nexus, role, settings.codingRuntime, (activity) => {
          publish({ source: 'agent-runtime', type: 'agent-activity', data: activity });
        }),
      );
    const developerRuntime = runtimeFor('developer');
    const reviewerRuntime = runtimeFor('reviewer');

    /** An action constructed with the workspace of the selection the workflow currently retains. */
    const selectedWorkspace = (
      create: (workspace: { readonly root: string }) => BoundAction,
    ): BoundAction => {
      return async () => {
        const selection = await readRequiredRecord(
          selectionFile,
          selectionDeclaration,
          'Selection',
        );
        return create(selection.workspace)();
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
      StartRound: selectedWorkspace((workspace) =>
        createStartRound({
          workspace,
          developerLadder: nexus.executionPolicy.developerLadder,
          publish,
        }),
      ),
      Develop: createDevelop({
        selectionFile,
        runtime: developerRuntime,
        git: settings.git,
        jira: settings.jira,
        publish,
      }),
      Verify: selectedWorkspace((workspace) =>
        createVerify({
          workspace,
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
        runtime: reviewerRuntime,
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
  };
}
