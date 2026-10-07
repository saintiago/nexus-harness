import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevClient, type JevClient } from '@saintiago/jev';
import { jevCredentialEnvironment, type NexusConfiguration } from '../configuration/index.js';

/**
 * Application's optional JEv integration: the public judgment capability it constructs from the
 * host credential and the reserved provider-native MCP server settings it composes into every
 * selectable agent role. The delivered package owns provider requests, schemas, transport and
 * errors; Nexus owns enablement, composition and the decisions made from returned judgments.
 * Construction performs no network request, so it neither contacts the provider nor gates an
 * ordinary execution on JEv availability.
 */

/** The host environment credential references resolve their values from. */
type HostEnvironment = Readonly<Record<string, string | undefined>>;

/** Why an enabled JEv integration has no usable client: no host key, or a rejected key. */
export type JevUnavailability = 'missing-credential' | 'unavailable';

/**
 * The constructed JEv capability, or the category explaining why an enabled integration is
 * unavailable. Disabled and omitted integrations construct no capability at all.
 */
export type JevCapability =
  | { readonly kind: 'available'; readonly client: JevClient }
  | { readonly kind: 'missing-credential' }
  | { readonly kind: 'unavailable' };

/** The host value of the configured JEv credential, or null when no usable value is set. */
function jevApiKey(nexus: NexusConfiguration, environment: HostEnvironment): string | null {
  const reference = nexus.jev?.credential;
  if (reference === undefined) {
    return null;
  }
  const resolution = Object.hasOwn(nexus.credentials, reference)
    ? nexus.credentials[reference]
    : undefined;
  const value = resolution === undefined ? undefined : environment[resolution.environment];
  return value === undefined || value === '' ? null : value;
}

/**
 * Create the optional JEv capability from the resolved host key with the package defaults, or
 * null when the integration is omitted or disabled. A missing host value is `missing-credential`
 * and an unusable key is `unavailable`; neither fails construction nor ordinary work.
 */
export function createJevCapability(
  nexus: NexusConfiguration,
  environment: HostEnvironment = process.env,
): JevCapability | null {
  const jev = nexus.jev;
  if (jev === undefined || !jev.enabled) {
    return null;
  }
  const apiKey = jevApiKey(nexus, environment);
  if (apiKey === null) {
    return { kind: 'missing-credential' };
  }
  try {
    return { kind: 'available', client: createJevClient({ apiKey }) };
  } catch {
    return { kind: 'unavailable' };
  }
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
 * server's composition: its installed command, the single `ask_jev` tool restriction, forwarding
 * of the host key by name only, and optional startup. When the capability is unavailable the same
 * settings are composed disabled, so an inherited server can never outlive Nexus's enablement
 * decision. The package's model and timeout defaults apply because no other value is forwarded.
 */
export function jevAgentSettings(available: boolean): Readonly<Record<string, unknown>> {
  return {
    'mcp_servers.jev.command': jevExecutablePath(),
    'mcp_servers.jev.args': [],
    'mcp_servers.jev.enabled': available,
    'mcp_servers.jev.required': false,
    'mcp_servers.jev.enabled_tools': ['ask_jev'],
    'mcp_servers.jev.env_vars': [jevCredentialEnvironment],
  };
}
