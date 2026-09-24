import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowName } from '../configuration/index.js';
import { createOperatorInterface } from '../operator-interface/index.js';
import { messageOf } from '../result.js';
import { createApplication, type Application, type ApplicationSettings } from './index.js';
import { installationConfigSetting } from './installation.js';
import { terminalCapabilities, type TerminalOutput } from './terminal.js';
import { createWorkerLaunch } from './worker-launch.js';

/**
 * The operator command: parse `nexus queue run --project-config <file>`,
 * `nexus ideas refine --project-config <file>` and `nexus --help`, connect terminal presentation to
 * the Application's combined event subscription, run one execution and map its outcome to the
 * process exit code. Launch shortcuts invoke this command; they contain no execution logic.
 * Presentation starts before execution and stops when execution ends, including failure.
 */

/** The parsed operator command. */
export type OperatorCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'run'; readonly workflow: WorkflowName; readonly projectConfigPath: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/** The documented command forms; help requires no configuration or external connections. */
export const operatorUsage = `Usage:
  nexus queue run --project-config <file>
  nexus ideas refine --project-config <file>
  nexus --help

Runs one execution of the selected workflow for the project the configuration file describes: the
finite delivery queue, or one idea refinement pass. The installation names its Nexus configuration
filepath through the ${installationConfigSetting} environment setting.
`;

/** Reject one input as invalid, naming what the command did not accept. */
function invalid(reason: string): OperatorCommand {
  return { kind: 'invalid', reason };
}

/** Parse the supplied process arguments into the operator command they name. */
export function parseOperatorCommand(args: readonly string[]): OperatorCommand {
  const [command, ...rest] = args;
  if (command === undefined) {
    return invalid('A command is required.');
  }
  if (command === '--help') {
    return rest.length === 0 ? { kind: 'help' } : invalid(`Unknown option "${rest[0]}".`);
  }
  const selected =
    command === 'queue'
      ? { workflow: 'finite-delivery' as const, subcommand: 'run' }
      : command === 'ideas'
        ? { workflow: 'idea-refinement' as const, subcommand: 'refine' }
        : null;
  if (selected === null) {
    return invalid(
      `Unknown command "${command}"; the documented commands are "queue run" and "ideas refine".`,
    );
  }
  const [subcommand, ...options] = rest;
  if (subcommand !== selected.subcommand) {
    return invalid(
      subcommand === undefined
        ? `The ${command} command requires its "${selected.subcommand}" subcommand.`
        : `Unknown ${command} command "${subcommand}"; the only ${command} command is ` +
            `"${selected.subcommand}".`,
    );
  }

  let projectConfigPath: string | null = null;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option !== '--project-config') {
      return invalid(`Unknown option "${option ?? ''}".`);
    }
    const value = options[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return invalid('--project-config requires a project configuration filepath.');
    }
    if (projectConfigPath !== null) {
      return invalid('--project-config is supplied more than once.');
    }
    projectConfigPath = value;
    index += 1;
  }
  return projectConfigPath === null
    ? invalid(`The ${command} ${selected.subcommand} command requires --project-config <file>.`)
    : { kind: 'run', workflow: selected.workflow, projectConfigPath };
}

/** What the runnable operator command receives from the process. */
export type OperatorCommandSettings = {
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The output the presentation writes to. */
  readonly output: TerminalOutput;
  /** Where command and initialization errors are printed. */
  readonly diagnostics: { write(text: string): unknown };
  /** Constructs the Application the command runs; tests supply controlled execution. */
  readonly application?: (settings: ApplicationSettings) => Application;
};

/**
 * Run the operator command and return its process exit code: 0 for help or completed execution,
 * 1 for execution requiring attention or initialization failure, 2 for invalid command input.
 */
export async function runOperatorCommand(settings: OperatorCommandSettings): Promise<number> {
  const command = parseOperatorCommand(settings.args);
  if (command.kind === 'help') {
    settings.output.write(operatorUsage);
    return 0;
  }
  if (command.kind === 'invalid') {
    settings.diagnostics.write(`${command.reason}\n\n${operatorUsage}`);
    return 2;
  }
  const projectConfigPath = path.resolve(settings.workingDirectory, command.projectConfigPath);

  const configuredPath = settings.environment[installationConfigSetting];
  if (configuredPath === undefined || configuredPath.trim() === '') {
    settings.diagnostics.write(
      `The ${installationConfigSetting} environment setting must name the Nexus installation ` +
        'configuration file.\n',
    );
    return 1;
  }
  const application = (settings.application ?? createApplication)({
    installationConfigPath: path.resolve(settings.workingDirectory, configuredPath),
    environment: settings.environment,
    diagnostics: settings.diagnostics,
    launchWorker: createWorkerLaunch({
      executable: process.execPath,
      entry: fileURLToPath(new URL('./worker.js', import.meta.url)),
    }),
  });

  const terminal = terminalCapabilities(settings.output, settings.environment);
  const presentation = createOperatorInterface({
    subscribe: (listener) => application.subscribe(listener),
    terminal,
  });
  presentation.start();
  try {
    const result = await application.execute({ projectConfigPath, workflow: command.workflow });
    return result.outcome === 'completed' ? 0 : 1;
  } catch (error) {
    settings.diagnostics.write(`Nexus stopped: ${messageOf(error)}\n`);
    return 1;
  } finally {
    presentation.stop();
    terminal.stop();
  }
}
