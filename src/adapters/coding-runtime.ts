import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
 * model, effort, native tool settings, working directory, time limit and an optional output schema.
 * The provider's own configuration selects the tools and their permissions; this adapter adds no
 * tool registry, MCP client or filesystem policy, and it never silently falls back to the
 * operator's personal settings when the selected configuration is not installed.
 */

/** One activity entry the provider reported while the invocation ran. */
export type CodingRuntimeActivity = {
  /**
   * What the entry is: a message the agent produced, a command or tool call it started, the
   * observed result, or a file change. The consumer presents these kinds.
   */
  readonly type: 'message' | 'command' | 'result' | 'change' | 'diagnostic';
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
  /**
   * The JSON Schema the provider must use for the final response, or undefined when the caller
   * requires plain text. The provider's native structured-output capability enforces it; the
   * adapter transports the supplied schema unchanged and never substitutes prompt-only formatting.
   */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
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
 * The tool settings the Codex provider takes: the name of an installed native profile and
 * optional native configuration overrides. The CLI layers `$CODEX_HOME/<name>.config.toml` on top
 * of the base user configuration, which leaves the operator's personal defaults in place. The
 * profile configures the research MCP servers, the enabled tools, the connector exclusions and
 * the file and shell permissions the invocation runs with, so the adapter applies permissions by
 * selecting that configuration and never derives them from a role name or prompt text. Each
 * override names one native configuration path with the value the caller resolved, for example
 * `mcp_servers.<name>.command`, and reaches the provider through its own `--config` setting.
 */
const profileSetting = 'profile';
const configSetting = 'config';
const isolatedMcpSetting = 'isolatedMcpServers';
const exclusiveMcpSetting = 'exclusiveMcpServers';
const managedInvestigationSetting = 'managedInvestigation';

/** One TOML key: a bare key where the grammar allows it, a quoted key otherwise. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/** The TOML rendering of one configuration override value, or null when it cannot be expressed. */
function tomlValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const text = tomlValue(item);
      if (text === null) {
        return null;
      }
      items.push(text);
    }
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries: string[] = [];
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const text = tomlValue(nested);
      if (text === null) {
        return null;
      }
      entries.push(`${tomlKey(key)} = ${text}`);
    }
    return `{ ${entries.join(', ')} }`;
  }
  return null;
}

/** The native configuration path one override names. */
const configurationPath = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/** What the supplied tool settings select: the installed profile and its native overrides. */
type SelectedToolSettings = {
  readonly profile: string;
  /** The `--config` arguments in supply order. */
  readonly overrides: readonly string[];
  readonly isolatedServers: readonly string[];
  readonly exclusiveServers?: readonly string[];
  readonly managedInvestigation: boolean;
};

/**
 * The installed native profile and configuration overrides the supplied tool settings select, or
 * the fault explaining why they cannot. Unknown top-level settings and unexpressible override
 * values are errors: applying a setting this adapter does not know, or ignoring part of one, would
 * silently drop what the caller asked for.
 */
function selectedToolSettings(
  toolSettings: Readonly<Record<string, unknown>>,
): Result<SelectedToolSettings> {
  const unsupported = Object.keys(toolSettings).filter(
    (key) =>
      key !== profileSetting &&
      key !== configSetting &&
      key !== isolatedMcpSetting &&
      key !== exclusiveMcpSetting &&
      key !== managedInvestigationSetting,
  );
  if (unsupported.length > 0) {
    return fault(`Unsupported Codex tool setting "${unsupported.join('", "')}".`);
  }
  const profile = toolSettings[profileSetting];
  if (typeof profile !== 'string' || profile.trim() === '') {
    return fault('The Codex tool settings must name the installed profile to select.');
  }
  const configured = toolSettings[configSetting];
  const isolatedServers =
    toolSettings[isolatedMcpSetting] === undefined ? [] : toolSettings[isolatedMcpSetting];
  if (
    !Array.isArray(isolatedServers) ||
    !isolatedServers.every(
      (key: unknown) => typeof key === 'string' && /^[A-Za-z0-9_-]+$/.test(key),
    )
  ) {
    return fault(
      'The Codex tool setting "isolatedMcpServers" must be an array of native server names.',
    );
  }
  const exclusiveServers = toolSettings[exclusiveMcpSetting];
  if (
    exclusiveServers !== undefined &&
    (!Array.isArray(exclusiveServers) ||
      !exclusiveServers.every(
        (name: unknown) => typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name),
      ))
  ) {
    return fault(
      'The Codex tool setting "exclusiveMcpServers" must be an array of native server names.',
    );
  }
  const managedInvestigation = toolSettings[managedInvestigationSetting];
  if (managedInvestigation !== undefined && typeof managedInvestigation !== 'boolean')
    return fault('The Codex tool setting "managedInvestigation" must be a boolean.');
  const overrides: string[] = [];
  if (configured !== undefined) {
    if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) {
      return fault('The Codex tool setting "config" must be an object of native values.');
    }
    for (const [key, value] of Object.entries(configured as Record<string, unknown>)) {
      if (!configurationPath.test(key)) {
        return fault(`The Codex configuration override "${key}" is not a dotted path.`);
      }
      const text = tomlValue(value);
      if (text === null) {
        return fault(`The Codex configuration override "${key}" cannot be expressed as TOML.`);
      }
      overrides.push(`${key}=${text}`);
    }
  }
  return ok({
    profile,
    overrides,
    isolatedServers,
    managedInvestigation: managedInvestigation === true,
    ...(exclusiveServers === undefined ? {} : { exclusiveServers }),
  });
}

/**
 * Native tables merge recursively across user, profile and project layers. Give each composed
 * server a fresh invocation name instead of merging it with an inherited transport/environment.
 * Inspect the provider's effective catalogue without starting servers, then disable any inherited
 * entry under the reserved name in place. Its valid transport remains intact. Catalogue data,
 * including literal environment values, stays in memory and is never emitted as agent activity.
 */
async function isolateMcpServers(
  selected: SelectedToolSettings,
  settings: CodingRuntimeSettings,
  request: CodingRuntimeRequest,
): Promise<Result<SelectedToolSettings>> {
  const inheritedOverrides = selected.overrides.filter(
    (override) =>
      !selected.isolatedServers.some(
        (name) =>
          override.startsWith(`mcp_servers.${name}=`) ||
          override.startsWith(`mcp_servers.${name}.`),
      ),
  );
  const catalogue: Buffer[] = [];
  const inspected = await run(
    {
      executable: settings.executable,
      args: [
        '--profile',
        selected.profile,
        'mcp',
        'list',
        '--json',
        ...inheritedOverrides.flatMap((override) => ['-c', override]),
      ],
      directory: request.directory,
      environment: settings.environment,
      timeLimitMs: request.timeLimitMs,
    },
    (chunk) => {
      if (chunk.stream === 'stdout') catalogue.push(Buffer.from(chunk.chunk));
    },
  );
  if (!inspected.ok || inspected.value.exitCode !== 0) {
    return fault('The Codex provider could not inspect inherited MCP settings.');
  }
  let names: Set<string>;
  try {
    const servers: unknown = JSON.parse(Buffer.concat(catalogue).toString('utf8'));
    if (!Array.isArray(servers) || !servers.every((server) => typeof server?.name === 'string'))
      throw new Error('Invalid catalogue');
    names = new Set(servers.map((server) => server.name as string));
  } catch {
    return fault('The Codex provider returned an invalid MCP catalogue.');
  }
  const overrides = [...inheritedOverrides];
  if (selected.exclusiveServers !== undefined) {
    for (const name of names) {
      if (!selected.exclusiveServers.includes(name))
        overrides.push(`mcp_servers.${tomlKey(name)}.enabled=false`);
    }
  }
  for (const name of new Set(selected.isolatedServers)) {
    const reserved = `mcp_servers.${name}`;
    if (names.has(name)) overrides.push(`${reserved}.enabled=false`);
    if (selected.exclusiveServers !== undefined && !selected.exclusiveServers.includes(name))
      continue;
    // Disabled composition needs only to disable an existing entry. It creates no empty server
    // whose missing transport could itself invalidate otherwise ordinary work.
    if (selected.overrides.includes(`${reserved}.enabled=false`)) continue;
    let isolated: string;
    do {
      isolated = `nexus-${name}-${randomUUID()}`;
    } while (names.has(isolated));
    const owned = selected.overrides.filter(
      (override) => override.startsWith(`${reserved}=`) || override.startsWith(`${reserved}.`),
    );
    overrides.push(
      ...owned.map((override) => `mcp_servers.${isolated}${override.slice(reserved.length)}`),
    );
  }
  return ok({ ...selected, overrides });
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
 * One invocation's output-schema transport file: the invocation-local directory holding it and the
 * file the provider reads the schema from.
 */
type OutputSchemaFile = {
  readonly directory: string;
  readonly file: string;
};

/**
 * Write the supplied JSON Schema to its own invocation-local temporary file, outside the
 * invocation's working directory so the agent's repository never holds it. Each invocation gets a
 * fresh directory, so concurrent invocations never share a schema file.
 */
async function writeOutputSchema(
  schema: Readonly<Record<string, unknown>>,
): Promise<OutputSchemaFile> {
  // Serialize before creating the directory, so a schema the adapter cannot represent leaves no
  // temporary file behind.
  const text = `${JSON.stringify(schema, null, 2)}\n`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-codex-output-schema-'));
  try {
    const file = path.join(directory, 'schema.json');
    await writeFile(file, text, 'utf8');
    return { directory, file };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The complete argument vector one Codex invocation runs with. The prompt argument is `-`, which
 * the provider reads as "take the instructions from standard input"; the adapter then delivers the
 * complete prompt on that stream, clear of the operating system's per-argument size limit. A
 * supplied output schema is passed as the provider's own structured-output setting.
 */
function invocationArguments(
  selected: SelectedToolSettings,
  request: CodingRuntimeRequest,
  outputSchemaFile: OutputSchemaFile | null,
): readonly string[] {
  return [
    'exec',
    '--json',
    '--profile',
    selected.profile,
    '--model',
    request.model,
    ...(request.effort === null ? [] : ['-c', `model_reasoning_effort="${request.effort}"`]),
    ...selected.overrides.flatMap((override) => ['-c', override]),
    ...(outputSchemaFile === null ? [] : ['--output-schema', outputSchemaFile.file]),
    '-',
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
 * Create the coding runtime over the supplied executable and environment. Native MCP isolation
 * first inspects effective configuration without starting servers. Then the invocation starts one
 * execution process, streams its activity and resolves with final output or a fault.
 */
export function createCodingRuntime(settings: CodingRuntimeSettings): CodingRuntime {
  return {
    async execute(request, onActivity) {
      const selected = selectedToolSettings(request.toolSettings);
      if (!selected.ok) {
        return selected;
      }
      // The installed native provider exposes working collaboration tools despite
      // features.multi_agent=false. Until this adapter has an enforced provider
      // mechanism, it must not represent an instruction as a disabled capability.
      if (selected.value.managedInvestigation)
        return fault(
          'Managed investigation is unavailable: the native Codex adapter cannot enforce disabled collaboration tools.',
        );
      const configurationPath = profileConfigurationPath(
        selected.value.profile,
        settings.environment,
      );
      if (configurationPath === null) {
        return fault(
          `Cannot verify the selected Codex profile "${selected.value.profile}": the provider environment ` +
            'sets neither CODEX_HOME nor HOME.',
        );
      }
      const installationProblem = await profileInstallationProblem(configurationPath);
      if (installationProblem !== null) {
        return fault(
          `The selected Codex profile "${selected.value.profile}" is not installed: ${installationProblem}`,
        );
      }

      let outputSchemaFile: OutputSchemaFile | null = null;
      if (request.outputSchema !== undefined) {
        try {
          outputSchemaFile = await writeOutputSchema(request.outputSchema);
        } catch (error) {
          return fault(
            `The supplied output schema could not be prepared for the invocation: ` +
              messageOf(error),
          );
        }
      }

      try {
        const startedAt = Date.now();
        let invocationSettings = selected.value;
        if (
          selected.value.isolatedServers.length > 0 ||
          selected.value.exclusiveServers !== undefined
        ) {
          const isolated = await isolateMcpServers(selected.value, settings, request);
          if (!isolated.ok) return isolated;
          invocationSettings = isolated.value;
        }
        const timeLimitMs = request.timeLimitMs - (Date.now() - startedAt);
        if (timeLimitMs <= 0)
          return fault(
            'The Codex invocation exceeded its time limit while inspecting MCP settings.',
          );
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
            const usage = event['usage'];
            if (typeof usage === 'object' && usage !== null) {
              const supplied = usage as Record<string, unknown>;
              const safe = Object.fromEntries(
                ['input_tokens', 'cached_input_tokens', 'output_tokens'].flatMap((key) => {
                  const value = supplied[key];
                  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
                    ? [[key, value]]
                    : [];
                }),
              );
              if (Object.keys(safe).length)
                emit({ type: 'diagnostic', text: `Agent token usage: ${JSON.stringify(safe)}` });
            }
            turnCompleted = true;
            return;
          }
          if (type === 'turn.failed') {
            turnFailure = failureText(event) ?? 'no failure message';
            return;
          }
          if (type === 'error') {
            // The provider retries some stream errors and completes the turn afterwards, so an
            // error event is a diagnostic until the stream reports the turn's terminal state.
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

        // The provider's events arrive in arbitrary chunk boundaries, so decoding is incremental
        // and only newline-terminated lines are read; the trailing line is read once the process
        // ends.
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
            args: invocationArguments(invocationSettings, request, outputSchemaFile),
            directory: request.directory,
            environment: settings.environment,
            timeLimitMs,
            input: request.prompt,
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
      } finally {
        if (outputSchemaFile !== null) {
          // The schema file lives only for its own invocation. Cleanup is best-effort so a
          // temporary file the host refuses to remove cannot replace the invocation's result.
          await rm(outputSchemaFile.directory, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      }
    },
  };
}
