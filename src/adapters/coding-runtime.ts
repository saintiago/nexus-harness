import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fault, messageOf, ok, type Result } from '../result.js';
import { run } from './processes.js';
import type { ProcessOutput } from './processes.js';

/**
 * The Coding runtime adapter invokes the configured coding provider and translates its protocol
 * into final output and activity.
 *
 * The provider is the Codex CLI's non-interactive form: `codex exec` with JSON Lines events on
 * standard output. Construction supplies the installed executable and the environment the provider
 * runs in — host settings and the provider's credentials. One invocation supplies the prompt,
 * model, effort, native tool settings, working directory and time limit. The provider's own
 * configuration selects the tools and their permissions; this adapter adds no tool registry, MCP
 * client or filesystem policy, and it never silently falls back to the operator's personal
 * settings when the selected configuration is not installed.
 */

/** One activity entry the provider reported while the invocation ran. */
export type CodingRuntimeActivity = {
  /**
   * What the entry is: a message the agent produced, a command or tool call it started, the
   * observed result, or a file change. The consumer presents these kinds.
   */
  readonly type: 'message' | 'command' | 'result' | 'change';
  /**
   * The provider's own text for the entry, complete and unsanitized. The consumer owns wrapping
   * messages and fitting work summaries to its display.
   */
  readonly text: string;
};

/** Receives one activity entry per provider event, in arrival order. */
export type CodingRuntimeActivityObserver = (activity: CodingRuntimeActivity) => void;

/** One invocation's settings. */
export type CodingRuntimeRequest = {
  /** The complete prompt, passed through unchanged. */
  readonly prompt: string;
  /** The model the provider runs. */
  readonly model: string;
  /** The reasoning effort, or null to use the selected configuration's own setting. */
  readonly effort: string | null;
  /** The provider's native tool configuration to select for this invocation. */
  readonly toolSettings: Readonly<Record<string, unknown>>;
  /** The working directory the invocation runs in. */
  readonly directory: string;
  /** The invocation's time limit in milliseconds. */
  readonly timeLimitMs: number;
};

/** The provider's final output. */
export type CodingRuntimeResult = Result<{ readonly output: string }>;

/** The coding provider capability: one invocation with the supplied settings. */
export type CodingRuntime = {
  execute(
    request: CodingRuntimeRequest,
    onActivity: CodingRuntimeActivityObserver,
  ): Promise<CodingRuntimeResult>;
};

/** Construction settings: the provider's installed executable and the environment it runs in. */
export type CodingRuntimeSettings = {
  readonly executable: string;
  /** Host settings and provider credentials for the provider process, and nothing unrelated. */
  readonly environment: Readonly<Record<string, string>>;
};

/**
 * The one tool setting the Codex provider takes: the name of an installed native profile. The CLI
 * layers `$CODEX_HOME/<name>.config.toml` on top of the base user configuration, which leaves the
 * operator's personal defaults in place. The profile configures the research MCP servers, the
 * enabled tools, the connector exclusions and the file and shell permissions the invocation runs
 * with, so the adapter applies permissions by selecting that configuration and never derives them
 * from a role name or prompt text.
 */
const profileSetting = 'profile';

/**
 * The installed native profile the supplied tool settings select, or the fault explaining why the
 * settings cannot select one. Unknown settings are errors: applying a setting this adapter does not
 * know would silently ignore what the caller asked for.
 */
function selectedProfile(toolSettings: Readonly<Record<string, unknown>>): Result<string> {
  const unsupported = Object.keys(toolSettings).filter((key) => key !== profileSetting);
  if (unsupported.length > 0) {
    return fault(`Unsupported Codex tool setting "${unsupported.join('", "')}".`);
  }
  const profile = toolSettings[profileSetting];
  if (typeof profile !== 'string' || profile.trim() === '') {
    return fault('The Codex tool settings must name the installed profile to select.');
  }
  return ok(profile);
}

/**
 * The installed profile file the CLI layers for the selected profile, or null when the supplied
 * environment does not locate the Codex home. The CLI resolves the file as
 * `$CODEX_HOME/<name>.config.toml`, with `$HOME/.codex` as the default Codex home
 * (docs/agent-runtime/profiles.md).
 */
function profileConfigurationPath(
  profile: string,
  environment: Readonly<Record<string, string>>,
): string | null {
  const codexHome = environment['CODEX_HOME'] ?? '';
  if (codexHome !== '') {
    return path.join(codexHome, `${profile}.config.toml`);
  }
  const home = environment['HOME'] ?? '';
  if (home === '') {
    return null;
  }
  return path.join(home, '.codex', `${profile}.config.toml`);
}

/**
 * Why the selected profile is not installed, or null when its configuration file is present. The
 * CLI ignores a missing profile file and runs with the base user configuration instead, so the
 * adapter states the launch error the design requires before starting anything.
 */
async function profileInstallationProblem(configurationPath: string): Promise<string | null> {
  try {
    await stat(configurationPath);
    return null;
  } catch (error) {
    return `${configurationPath} is unavailable (${messageOf(error)})`;
  }
}

/**
 * The complete argument vector one Codex invocation runs with. The prompt is one argument after
 * `--`, so its text is passed through unchanged even when it begins with an option; the provider
 * reads instructions from the argument and, with no piped standard input, appends nothing to them.
 */
function invocationArguments(profile: string, request: CodingRuntimeRequest): readonly string[] {
  return [
    'exec',
    '--json',
    '--profile',
    profile,
    '--model',
    request.model,
    ...(request.effort === null ? [] : ['-c', `model_reasoning_effort="${request.effort}"`]),
    '--',
    request.prompt,
  ];
}

/** One parsed provider event: an object whose type names the event. */
type ProviderEvent = Record<string, unknown>;

/** A value read as a plain object record, or null for any other value. */
function recordOf(value: unknown): ProviderEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as ProviderEvent;
}

/** Nonempty text, or null for another value or blank text. */
function nonemptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The accumulated text of one completed agent message item, or null for another item. */
function agentMessageText(item: unknown): string | null {
  const record = recordOf(item);
  if (record === null || record['type'] !== 'agent_message') {
    return null;
  }
  return nonemptyText(record['text']);
}

/**
 * What one completed command reports: the outcome it was observed with, the operation it belongs
 * to, and the complete output that operation printed. The exit code is repeated, never read as
 * success or failure, and the output is the provider's own text, passed through whole.
 */
function commandResultText(item: ProviderEvent): string {
  const exitCode = item['exit_code'];
  const outcome =
    typeof exitCode === 'number'
      ? `exit ${String(exitCode)}`
      : (nonemptyText(item['status']) ?? 'finished');
  const operation = nonemptyText(item['command']);
  const printed = nonemptyText(item['aggregated_output']);
  return [outcome, operation, printed].filter((part): part is string => part !== null).join(' — ');
}

/** The complete JSON text of a provider payload, or null when the provider supplied none. */
function payloadText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const text = JSON.stringify(value);
  return text === undefined ? null : text;
}

/** The MCP tool an `mcp_tool_call` item names, or null when the item names none. */
function mcpCallText(item: ProviderEvent): string | null {
  const server = nonemptyText(item['server']);
  const tool = nonemptyText(item['tool']);
  if (server === null || tool === null) {
    return null;
  }
  return `mcp ${server}/${tool}`;
}

/** The web search a `web_search` item reports, named by its query. */
function webSearchText(item: ProviderEvent): string | null {
  const query = nonemptyText(item['query']);
  return query === null ? null : `web search: ${query}`;
}

/**
 * What one completed tool call reports: the outcome it was observed with, the call it belongs to
 * and the failure or result payload the provider returned. The payload is the provider's own data,
 * passed through whole.
 */
function toolResultText(item: ProviderEvent, call: string): string {
  const outcome = nonemptyText(item['status']) ?? 'completed';
  const error = recordOf(item['error']);
  const failure = error === null ? null : nonemptyText(error['message']);
  const payload = payloadText(item['result']) ?? payloadText(item['results']);
  return [outcome, call, failure, payload]
    .filter((part): part is string => part !== null)
    .join(' — ');
}

/** One file change entry of a `file_change` item, or null for an entry without a path. */
function changeActivity(change: unknown): CodingRuntimeActivity | null {
  const record = recordOf(change);
  const path = record === null ? null : nonemptyText(record['path']);
  if (path === null) {
    return null;
  }
  const kind = record === null ? null : nonemptyText(record['kind']);
  return { type: 'change', text: kind === null ? path : `${kind} ${path}` };
}

/**
 * The activity one provider item reports at the given lifecycle event, or an empty list when it
 * carries no entry for the operator stream. A command and a provider tool call are announced when
 * they start and reported with their observed outcome when they complete; a message and a file
 * change are read once complete. Provider items outside these carry no activity; the adapter reads
 * the interface for what it reports rather than validating it against a list that would have to
 * keep up with the CLI.
 */
function itemActivities(eventType: string, item: unknown): readonly CodingRuntimeActivity[] {
  const record = recordOf(item);
  if (record === null) {
    return [];
  }
  switch (record['type']) {
    case 'command_execution': {
      if (eventType === 'item.started') {
        const command = nonemptyText(record['command']);
        return command === null ? [] : [{ type: 'command', text: command }];
      }
      if (eventType !== 'item.completed') {
        return [];
      }
      return [{ type: 'result', text: commandResultText(record) }];
    }
    case 'mcp_tool_call': {
      const call = mcpCallText(record);
      if (call === null) {
        return [];
      }
      if (eventType === 'item.started') {
        const argumentsText = payloadText(record['arguments']);
        return [
          { type: 'command', text: argumentsText === null ? call : `${call} ${argumentsText}` },
        ];
      }
      if (eventType !== 'item.completed') {
        return [];
      }
      return [{ type: 'result', text: toolResultText(record, call) }];
    }
    case 'web_search': {
      const search = webSearchText(record);
      if (search === null) {
        return [];
      }
      if (eventType === 'item.started') {
        return [{ type: 'command', text: search }];
      }
      if (eventType !== 'item.completed') {
        return [];
      }
      return [{ type: 'result', text: toolResultText(record, search) }];
    }
    case 'agent_message': {
      if (eventType !== 'item.completed') {
        return [];
      }
      const text = agentMessageText(record);
      return text === null ? [] : [{ type: 'message', text }];
    }
    case 'file_change': {
      if (eventType !== 'item.completed' || !Array.isArray(record['changes'])) {
        return [];
      }
      return record['changes']
        .map((change) => changeActivity(change))
        .filter((activity): activity is CodingRuntimeActivity => activity !== null);
    }
    default:
      return [];
  }
}

/** What one failure event says, where the provider's failures carry their message. */
function failureText(event: ProviderEvent): string | null {
  const error = recordOf(event['error']);
  const nested = error === null ? null : nonemptyText(error['message']);
  return nested ?? nonemptyText(event['message']);
}

/**
 * Create the coding runtime over the supplied executable and environment. Each invocation starts
 * one provider process, streams its activity and resolves with the final output or a fault.
 */
export function createCodingRuntime(settings: CodingRuntimeSettings): CodingRuntime {
  return {
    async execute(request, onActivity) {
      const profile = selectedProfile(request.toolSettings);
      if (!profile.ok) {
        return profile;
      }
      const configurationPath = profileConfigurationPath(profile.value, settings.environment);
      if (configurationPath === null) {
        return fault(
          `Cannot verify the selected Codex profile "${profile.value}": the provider environment ` +
            'sets neither CODEX_HOME nor HOME.',
        );
      }
      const installationProblem = await profileInstallationProblem(configurationPath);
      if (installationProblem !== null) {
        return fault(
          `The selected Codex profile "${profile.value}" is not installed: ${installationProblem}`,
        );
      }

      const emit = (activity: CodingRuntimeActivity): void => {
        try {
          onActivity(activity);
        } catch {
          // Observer failures do not affect the invocation or its result.
        }
      };

      let pending = '';
      let output: string | null = null;
      let turnCompleted = false;
      let turnFailure: string | null = null;
      let streamError: string | null = null;
      let protocolProblem: string | null = null;
      const stderr: Uint8Array[] = [];

      const readEvent = (event: ProviderEvent): void => {
        const type = event['type'];
        if (type === 'item.started' || type === 'item.completed') {
          for (const activity of itemActivities(type, event['item'])) {
            emit(activity);
          }
          if (type === 'item.completed') {
            output = agentMessageText(event['item']) ?? output;
          }
          return;
        }
        if (type === 'turn.completed') {
          turnCompleted = true;
          return;
        }
        if (type === 'turn.failed') {
          turnFailure = failureText(event) ?? 'no failure message';
          return;
        }
        if (type === 'error') {
          // The provider retries some stream errors and completes the turn afterwards, so an error
          // event is a diagnostic until the stream reports the turn's terminal state.
          streamError = failureText(event) ?? streamError;
        }
      };

      const readLine = (line: string): void => {
        if (protocolProblem !== null) {
          return;
        }
        const text = line.trim();
        if (text === '') {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          protocolProblem = `The provider wrote a line that is not a JSON event: ${text}`;
          return;
        }
        const event = recordOf(parsed);
        if (event === null || typeof event['type'] !== 'string') {
          protocolProblem = `The provider wrote a line that is not a JSON event: ${text}`;
          return;
        }
        readEvent(event);
      };

      // The provider's events arrive in arbitrary chunk boundaries, so decoding is incremental and
      // only newline-terminated lines are read; the trailing line is read once the process ends.
      const decoder = new TextDecoder();
      const feed = (text: string): void => {
        pending += text;
        let end = pending.indexOf('\n');
        while (end !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          readLine(line);
          end = pending.indexOf('\n');
        }
      };

      const result = await run(
        {
          executable: settings.executable,
          args: invocationArguments(profile.value, request),
          directory: request.directory,
          environment: settings.environment,
          timeLimitMs: request.timeLimitMs,
        },
        (chunk: ProcessOutput) => {
          if (chunk.stream === 'stdout') {
            feed(decoder.decode(chunk.chunk, { stream: true }));
          } else {
            stderr.push(chunk.chunk);
          }
        },
      );
      if (!result.ok) {
        return result;
      }
      feed(decoder.decode());
      if (pending !== '') {
        readLine(pending);
      }
      if (protocolProblem !== null) {
        return fault(protocolProblem);
      }
      if (result.value.exitCode !== 0) {
        const diagnostics = Buffer.concat(stderr).toString('utf8').trim();
        const diagnosis =
          turnFailure ?? streamError ?? (diagnostics === '' ? 'no diagnostics' : diagnostics);
        return fault(
          `The Codex provider exited with code ${String(result.value.exitCode)}: ${diagnosis}`,
        );
      }
      if (turnFailure !== null) {
        return fault(`The Codex provider reported a failed turn: ${turnFailure}`);
      }
      if (!turnCompleted) {
        return fault('The Codex provider finished without completing a turn.');
      }
      if (output === null) {
        return fault('The Codex provider finished without returning a final agent message.');
      }
      return ok({ output });
    },
  };
}
