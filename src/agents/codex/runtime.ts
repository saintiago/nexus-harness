/**
 * The launch prefix of the Codex runtime, the environment it is started in, and
 * the host's one supported way to stop a process tree it started.
 *
 * How the runtime is started is configuration: one executable followed by
 * literal prefix arguments, which is what lets an operator select the installed
 * Codex, a compatible wrapper, a native profile, or a model without the runner
 * knowing anything about it. The prefix is not a complete command: the adapter
 * appends its own arguments and writes the prompt to standard input.
 */
import { requestTreeStop, STOP_GRACE_MS } from '../../process/stop.js';
import type { AgentSelection } from '../../shared/types.js';

/** The runtime the harness runs when its caller names none: the installed CLI. */
export const CODEX_EXECUTABLE = 'codex';

/**
 * How the runtime is invoked, as the documented `codex exec` form: never ask a
 * human for approval, write events to standard output as JSON Lines, keep writes
 * inside the working copy, and read the prompt from standard input. The working
 * root is the directory the process is started in, so it is not named here — it
 * would be a path on a command line, and only a Windows `.cmd` shim would have
 * to refuse it.
 *
 * These are the adapter's own arguments and are not configurable: a configured
 * launch prefix is prepended to them and cannot replace them
 * (docs/WORKFLOW.md §1, "Agent contract"). A run is unattended, so an action
 * outside the turn's own permission policy has to fail the turn instead of
 * waiting for an approval nobody is there to give; nothing here bypasses the
 * policy or retries with a weaker one.
 *
 * The write the harness needs is *inside* the retained working copy, Git
 * metadata included, and the installed CLI's legacy `--sandbox workspace-write`
 * does not grant it: that policy projects the working copy as a writable root
 * with its repository metadata carved out as read-only, so a turn cannot stage
 * or commit — `git add` fails on `.git/index.lock`. A scoped permission profile
 * states the same intent without that carveout, so the adapter defines one and
 * selects it through `-c` overrides: reads stay unrestricted, writes stay
 * confined to the working copy and to the system temporary directories, and
 * everything else is refused. The profile belongs to this invocation, so no
 * operator profile or global configuration has to change.
 *
 * `--strict-config` is the adapter's own argument too, and it is what makes an
 * unsupported permission configuration a visible failure: a CLI that did not
 * know `permissions` or `default_permissions` would otherwise ignore the
 * overrides silently and run under whatever policy its own defaults select.
 * With it, an unrecognized override is refused (`unknown configuration field
 * ... in -c/--config override`) before any turn starts, so the run fails rather
 * than quietly falling back to a broader or different policy. The legacy
 * `--sandbox` flag is deliberately not used: on this CLI it is an override that
 * wins over permission profiles, which is how the read-only `.git` carveout
 * would come back.
 *
 * `--ask-for-approval never` is the CLI's global option and, on the installed
 * CLI (0.154.0), it is only accepted *before* the `exec` subcommand: the same
 * flag after `exec` is refused with `unexpected argument '--ask-for-approval'`.
 * It therefore sits at the front of the adapter's own arguments rather than
 * beside the permission overrides, and the launch prefix is still used exactly
 * as configured, with everything here appended to it.
 */
/** The name of the permission profile every turn defines and selects. */
export const PERMISSION_PROFILE_NAME = 'nexus-workspace';
/**
 * The permission profile the adapter defines, as a TOML value for the CLI's `-c`
 * configuration override: read anywhere, write only the working copy (which is
 * what the `:workspace_roots` entry names, Git metadata included) and the system
 * temporary directories. Anything else is outside the profile, and the runtime
 * refuses it rather than asking a human who is not there.
 *
 * The TOML here is written with literal strings and literal table keys (`'...'`)
 * on purpose: a basic string would put double quotes into the argument, and on
 * Windows a `codex.cmd` shim cannot be handed an argument like that at all
 * (`src/process/launch.ts` refuses it rather than altering it), which would break
 * every operator whose installed runtime is the npm `.cmd` shim.
 */
export const PERMISSION_PROFILE_OVERRIDE =
  `permissions.${PERMISSION_PROFILE_NAME}=` +
  "{description='Nexus coding turn: read everywhere, write only the retained working copy " +
  "and temporary directories',filesystem={':root'='read',':workspace_roots'='write'," +
  "':tmpdir'='write',':slash_tmp'='write'}}";
/** The override that makes {@link PERMISSION_PROFILE_OVERRIDE} the turn's policy. */
export const DEFAULT_PERMISSIONS_OVERRIDE = `default_permissions='${PERMISSION_PROFILE_NAME}'`;
/** The permission overrides, in the order the adapter passes them to the CLI. */
export const PERMISSION_PROFILE_ARGUMENTS: readonly string[] = [
  '-c',
  PERMISSION_PROFILE_OVERRIDE,
  '-c',
  DEFAULT_PERMISSIONS_OVERRIDE,
];
/**
 * The complete suffix the adapter appends to the configured launch prefix, in
 * the order the CLI receives it; why each part is there, and why the legacy
 * `--sandbox` flag is not, is the comment above.
 */
export const CODEX_EXEC_ARGUMENTS: readonly string[] = [
  '--ask-for-approval',
  'never',
  '--strict-config',
  'exec',
  ...PERMISSION_PROFILE_ARGUMENTS,
  '--json',
  '-',
];
/** The launch prefix an ordinary run uses: the installed CLI, no extra arguments. */
export const DEFAULT_CODEX_COMMAND: readonly string[] = [CODEX_EXECUTABLE];
/**
 * What this module needs from its host to run one turn: the runtime to start,
 * the environment to start it in, and the one supported way to end a process
 * tree it started.
 *
 * Every part has a working default, and a test substitutes the parts it is
 * about. That substitution is also where another runtime, or a stand-in
 * executable on the test process's `PATH`, would be put: the boundary is the
 * runtime process, not this module's internals.
 */
export interface CodexRuntime {
  /**
   * The launch prefix to start: the executable, then literal prefix arguments,
   * exactly as the configuration selected them. `codex` on its own is resolved
   * from `PATH`; a path starts that executable. A `.cmd`/`.bat` on Windows is
   * started through the command interpreter, exactly as a configured command is
   * (see `src/process/launch.ts`).
   */
  readonly command: readonly string[];
  /**
   * The environment the runtime process inherits. This is where the runtime's
   * own authentication lives; it is passed on as it is, and never copied into a
   * log, a report, or a failure message.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Asks the host to end one process tree this module started, and says what the
   * request itself did: `null` when it succeeded, otherwise why it did not.
   */
  stopTree(pid: number): Promise<string | null>;
  /**
   * How long a stop is given to take effect before it is recorded as
   * unconfirmed, in milliseconds.
   */
  readonly stopGraceMs: number;
}
/**
 * The runtime an ordinary turn uses: the installed `codex`, this process's own
 * environment, the host's process-tree stop, and the same grace a configured
 * command's stop gets.
 */
export function codexRuntime(parts: Partial<CodexRuntime> = {}): CodexRuntime {
  return {
    command: DEFAULT_CODEX_COMMAND,
    env: process.env,
    stopTree: requestTreeStop,
    stopGraceMs: STOP_GRACE_MS,
    ...parts,
  };
}

/**
 * The runtime one turn of a run uses: the selection the configuration made,
 * through the host's own launcher.
 */
export function selectedCodexRuntime(
  agent: AgentSelection,
  parts: Partial<CodexRuntime> = {},
): CodexRuntime {
  return codexRuntime({ command: agent.command, ...parts });
}
