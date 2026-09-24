import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCodingRuntime } from '../adapters/coding-runtime.js';
import { createGitAdapter } from '../adapters/git.js';
import { createGitHubAdapter } from '../adapters/github.js';
import { createJiraAdapter } from '../adapters/jira.js';
import { run } from '../adapters/processes.js';
import {
  loadNexusConfiguration,
  loadProjectConfiguration,
  resolveCredential,
} from '../configuration/index.js';
import { messageOf } from '../result.js';
import { createTaskEngine } from '../task-engine/index.js';
import { createActionBinding } from './action-bindings.js';
import { createJiraSettings, executionPaths, toolEnvironment } from './composition.js';
import { installationConfigSetting } from './installation.js';
import { createWorkerProtocol, type OutputSink } from './protocol.js';
import { loadWorkflow } from './workflow.js';

/**
 * The internal worker entry: one work invocation of the configured workflow. It loads project and
 * installation configuration and the selected workflow, constructs the adapters, AgentRuntime and
 * TaskEngine, forwards TaskEngine events unchanged through the worker protocol and reports the
 * final workflow result. This is an internal launch contract, not an additional operator mode.
 */

/** What the parent launch supplies the worker entry. */
export type WorkerSettings = {
  /** The absolute project configuration filepath. */
  readonly projectConfigPath: string;
  readonly installationConfigPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly stdout: OutputSink;
  readonly stderr: OutputSink;
};

/** Report a worker failure to the parent's diagnostics stream. */
function reportFailure(settings: WorkerSettings, phase: string, error: unknown): 1 {
  settings.stderr.write(`Nexus worker ${phase} failed: ${messageOf(error)}\n`);
  return 1;
}

/** Run one work invocation of the configured workflow and return the worker's exit code. */
export async function runWorker(settings: WorkerSettings): Promise<number> {
  let engine: ReturnType<typeof createTaskEngine>;
  try {
    const nexus = await loadNexusConfiguration(settings.installationConfigPath);
    const project = await loadProjectConfiguration(settings.projectConfigPath);
    const workflow = await loadWorkflow(nexus.workflow.path);
    const paths = executionPaths(nexus, project);
    await mkdir(paths.directory, { recursive: true });

    // Commands, Git, the operator's gh CLI and the coding provider run without the credential
    // settings only the adapters resolve; provider credentials stay for the provider itself.
    const environment = toolEnvironment(project, nexus, settings.environment);
    const git = createGitAdapter((args, directory, onOutput) =>
      run({ executable: 'git', args, directory, environment }, onOutput),
    );
    const github = createGitHubAdapter({
      gh: (args, onOutput) =>
        run({ executable: 'gh', args, directory: process.cwd(), environment }, onOutput),
      nexusLens: {
        appId: nexus.nexusLens.appId,
        installationId: nexus.nexusLens.installationId,
        privateKey: resolveCredential(nexus, nexus.nexusLens.privateKey, settings.environment),
      },
    });
    const jira = createJiraAdapter(createJiraSettings(project, nexus, settings.environment));

    engine = createTaskEngine({
      workflow: workflow.machine,
      stateFile: paths.workflowStateFile,
      bindActions: createActionBinding({
        project,
        nexus,
        paths,
        jira,
        github,
        git,
        codingRuntime: createCodingRuntime({
          executable: nexus.agentRuntime.provider.executable,
          environment,
        }),
        runCommand: run,
        commandEnvironment: environment,
        wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      }),
    });
  } catch (error) {
    return reportFailure(settings, 'initialization', error);
  }

  const protocol = createWorkerProtocol(settings.stdout, settings.stderr);
  try {
    // Events are observed before run starts, so no progress or activity is lost.
    engine.subscribe((event) => {
      protocol.event(event);
    });
    const result = await engine.run();
    protocol.result(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    return reportFailure(settings, 'execution', error);
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  const projectConfigPath = process.argv[2];
  const installationConfigPath = process.env[installationConfigSetting];
  if (projectConfigPath === undefined || !path.isAbsolute(projectConfigPath)) {
    process.stderr.write(
      'The Nexus worker requires the absolute project configuration filepath as its argument.\n',
    );
    process.exitCode = 1;
  } else if (installationConfigPath === undefined || installationConfigPath.trim() === '') {
    process.stderr.write(
      `The Nexus worker requires the ${installationConfigSetting} environment setting.\n`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = await runWorker({
      projectConfigPath,
      installationConfigPath: path.resolve(installationConfigPath),
      environment: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
    });
  }
}
