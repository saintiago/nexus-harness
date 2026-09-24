/**
 * The installation's launch configuration. The installed launch shortcut sets this environment
 * setting to the Nexus configuration filepath; the operator command and the internal worker entry
 * both read the same value.
 */

/** The environment setting that names the Nexus configuration file. */
export const installationConfigSetting = 'NEXUS_CONFIG';
