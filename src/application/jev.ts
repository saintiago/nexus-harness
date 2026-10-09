import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevCredentialEnvironment, type NexusConfiguration } from '../configuration/index.js';

/**
 * Application's optional JEv integration: the reserved provider-native MCP server settings it
 * composes into every selectable agent role. The delivered package owns provider requests,
 * schemas, transport, errors and optional local usage logging; Nexus owns enablement, composition
 * and the decisions made from returned judgments. Composing settings performs no network request,
 * so it neither contacts the provider nor gates an ordinary execution on JEv availability.
 */

/** The host environment credential references resolve their values from. */
type HostEnvironment = Readonly<Record<string, string | undefined>>;

/** The provider-native configuration path of the reserved JEv MCP server. */
const reservedJevName = 'jev';
const reservedJevServer = `mcp_servers.${reservedJevName}`;

/**
 * Whether one native configuration path names the reserved JEv server or a setting under it.
 * Composition replaces configured settings under this reserved name before the coding adapter
 * isolates the composed server from inherited native files.
 */
function isReservedJevSetting(key: string): boolean {
  return key === reservedJevServer || key.startsWith(`${reservedJevServer}.`);
}

/** The reserved name the coding adapter isolates from inherited native server settings. */
export const jevIsolatedServers = [reservedJevName] as const;

/** Remove the reserved server from flat overrides and ancestor-object overrides alike. */
export function withoutInheritedJevSettings(
  configured: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(configured)
      .filter(([key]) => !isReservedJevSetting(key))
      .map(([key, value]) => {
        if (
          key !== 'mcp_servers' ||
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value)
        ) {
          return [key, value];
        }
        return [
          key,
          Object.fromEntries(
            Object.entries(value).filter(([server]) => server !== reservedJevName),
          ),
        ];
      }),
  );
}

/**
 * The host environment settings the composed native server forwards to the delivered package:
 * the provider key and the package's opt-in local usage logging. The provider supplies an MCP
 * child only the variables named here, so excluded inherited settings such as `JEV_MODEL` and
 * `JEV_TIMEOUT_MS` cannot replace the package's own model and timeout defaults. The optional
 * caller label accompanies a configured log path; without one logging stays disabled.
 */
export const jevForwardedEnvironment = [
  jevCredentialEnvironment,
  'JEV_USAGE_LOG_PATH',
  'JEV_USAGE_LOG_CALLER',
  'JEV_RETRIEVAL_LOG_PATH',
] as const;

/** Whether the enabled integration's configured credential has a usable host value. */
function hasHostCredential(nexus: NexusConfiguration, environment: HostEnvironment): boolean {
  const reference = nexus.jev?.credential;
  if (reference === undefined) {
    return false;
  }
  const resolution = Object.hasOwn(nexus.credentials, reference)
    ? nexus.credentials[reference]
    : undefined;
  const value = resolution === undefined ? undefined : environment[resolution.environment];
  return value !== undefined && value !== '';
}

/**
 * Whether one invocation composes available repository tools access: the configured integration is
 * enabled and its credential names a usable host value. Omitted, disabled and credential-less
 * integrations compose the reserved server disabled and supply no usage guidance. The host value
 * is checked for presence only and never enters Nexus settings, prompts or artifacts.
 */
export function jevAccessAvailable(
  nexus: NexusConfiguration,
  environment: HostEnvironment = process.env,
): boolean {
  return nexus.jev !== undefined && nexus.jev.enabled && hasHostCredential(nexus, environment);
}

/**
 * The absolute path of the installed `jev-mcp` executable: this Nexus installation's own delivered
 * dependency, resolved from the installed package rather than PATH or the selected project's
 * working directory. The package's public entry and its stdio MCP executable are delivered
 * together, so the bin resolves from the resolved entry.
 */
export function jevExecutablePath(): string {
  const entry = fileURLToPath(import.meta.resolve('@saintiago/jev'));
  return path.join(path.dirname(entry), 'mcp.js');
}

/**
 * The reserved `jev` MCP server's provider-native settings for one invocation. Nexus owns this
 * server's composition: its installed command, the retrieve_evidence and expand_evidence tools with no inherited
 * exclusions, forwarding of the named host settings only, and optional startup. Unavailable access
 * composes the settings disabled. The coding adapter disables inherited `jev` entries and binds
 * available settings to a fresh invocation name. The package's model, timeout and logging defaults
 * apply because no other value is forwarded or inherited by that fresh server.
 */
export function jevAgentSettings(available: boolean): Readonly<Record<string, unknown>> {
  return {
    [`${reservedJevServer}.command`]: jevExecutablePath(),
    [`${reservedJevServer}.args`]: [],
    [`${reservedJevServer}.enabled`]: available,
    [`${reservedJevServer}.required`]: false,
    [`${reservedJevServer}.default_tools_approval_mode`]: 'approve',
    [`${reservedJevServer}.enabled_tools`]: ['retrieve_evidence', 'expand_evidence'],
    [`${reservedJevServer}.disabled_tools`]: [],
    [`${reservedJevServer}.env_vars`]: [...jevForwardedEnvironment],
  };
}
