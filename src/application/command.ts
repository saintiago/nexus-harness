import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowName } from '../configuration/index.js';
import { createOperatorInterface } from '../operator-interface/index.js';
import { messageOf } from '../result.js';
import { createApplication, type Application, type ApplicationSettings } from './index.js';
import { installationConfigSetting } from './installation.js';
import { terminalCapabilities, type TerminalOutput } from './terminal.js';
import { createWorkerLaunch } from './worker-launch.js';
import { parseEvidenceCommand, runEvidenceCommand, type EvidenceCommand } from './evidence.js';

/**
 * The operator command: run the project queue, inspect local evidence or print help. Connect
 * terminal presentation to the Application's combined event subscription for queue execution and
 * map the outcome to the process exit code. Launch shortcuts contain no execution logic.
 * Presentation starts before execution and stops when execution ends, including failure.
 */

/** The parsed operator command. */
export type OperatorCommand =
  | { readonly kind: 'help' }
  | EvidenceCommand
  | { readonly kind: 'run'; readonly workflow: WorkflowName; readonly projectConfigPath: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/** The documented command forms; help requires no configuration or external connections. */
export const operatorUsage = `Usage:
  nexus queue run --project-config <file>
  nexus evidence list <root> [paths...]
  nexus evidence read <root> <files...> [--max-bytes <n>]
  nexus --help

Runs one execution of the project parent for the project the configuration file describes. The
parent selects one issue at a time and invokes the child appropriate to its stage. The installation
names its Nexus configuration filepath through the ${installationConfigSetting} environment setting.
Evidence commands inspect local artifacts without configuration; reads default to 64 KiB per file.
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
  if (command === 'evidence') {
    try {
      return parseEvidenceCommand(rest);
    } catch (error) {
      return invalid(messageOf(error));
    }
  }
  const selected = command === 'queue' ? { workflow: 'project' as const, subcommand: 'run' } : null;
  if (selected === null) {
    return invalid(`Unknown command "${command}"; use "queue run", "evidence" or "--help".`);
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
 * Return 0 for success, 1 for execution/access failure, or 2 for invalid command input.
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
  if (command.kind === 'evidence') {
    return runEvidenceCommand({ ...settings, command });
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
    subscribeActivity: (listener) => application.subscribeActivity(listener),
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
