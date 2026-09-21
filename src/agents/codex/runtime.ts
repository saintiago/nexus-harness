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
 * human for approval, write events to standard output as JSON Lines, run the
 * model-generated commands unsandboxed, and read the prompt from standard
 * input. The working root is the directory the process is started in, so it is
 * not named here — it would be a path on a command line, and only a Windows
 * `.cmd` shim would have to refuse it.
 *
 * These are the adapter's own arguments and are not configurable: a configured
 * launch prefix is prepended to them and cannot replace them
 * (docs/WORKFLOW.md §1, "Agent contract"). The launch is fixed for every turn
 * of a run: no retry, no fallback, and no widening after a failed turn.
 *
 * `danger-full-access` is an explicit, documented choice, not a hidden one: a
 * turn has to be able to stage and commit inside the retained working copy, and
 * no narrower policy this CLI and platform pair was shown to grant it. The
 * `workspace-write` policy — in its legacy `--sandbox` spelling and in its
 * native `permissions`/`default_permissions` spelling — projects that copy with
 * its Git metadata carved out read-only, so `git add` fails on
 * `.git/index.lock` (HARN-2; reproduced by hand with the installed CLI,
 * HARN-10). A turn therefore runs with the same unrestricted file and network
 * access the harness's own configured `setup` and `checks` commands already
 * have; README "Safety" states what that means, and no scoped variant is
 * attempted.
 *
 * `--ask-for-approval never` is the CLI's global option and, on the installed
 * CLI (0.154.0), it is only accepted *before* the `exec` subcommand: the same
 * flag after `exec` is refused with `unexpected argument '--ask-for-approval'`.
 * It therefore sits at the front of the adapter's own arguments rather than
 * beside the policy, and the launch prefix is still used exactly as configured,
 * with everything here appended to it. A run is unattended: the policy is
 * `never`, so nothing waits for an approval nobody is there to give.
 */
/**
 * The filesystem policy one turn runs under. A coding turn stages commits in the
 * retained working copy, so it needs the unsandboxed policy above. A turn that
 * must not change what it is looking at — the pre-delivery baseline diagnostic —
 * runs under `workspace-write` instead: it reads anywhere, and the runtime's own
 * sandbox refuses every write outside the turn's own working root — the host's
 * temporary roots are excluded from that policy, not granted by it
 * (docs/spec.md §11). The policy is a property of the turn, never of the failure
 * that follows it: nothing widens a launch, and a coding turn is never started
 * from a diagnostic.
 */
export type CodexSandboxPolicy = 'danger-full-access' | 'workspace-write';

/**
 * What one `workspace-write` launch adds to its policy: the host's temporary
 * roots are taken out of the writable set, so the writable roots are exactly the
 * turn's own working directory. The runtime's `workspace-write` policy otherwise
 * also permits writes under the host's temporary directory, and `workDir` is an
 * arbitrary path: with a `workDir` beneath a temporary root, the retained
 * working copy and the snapshot a diagnosis inspects would both sit inside a
 * writable root, and starting the turn in `turn/` would not make either of them
 * read-only. The keys are the runtime's own configuration for that policy
 * (`sandbox_workspace_write.exclude_tmpdir_env_var` and
 * `sandbox_workspace_write.exclude_slash_tmp`), passed as `-c` overrides beside
 * the policy they narrow; the subcommand accepts them, and a runtime that
 * refuses one refuses the launch instead of widening it.
 */
const WORKSPACE_WRITE_EXCLUSIONS: readonly string[] = [
  '-c',
  'sandbox_workspace_write.exclude_tmpdir_env_var=true',
  '-c',
  'sandbox_workspace_write.exclude_slash_tmp=true',
];

/**
 * The complete suffix the adapter appends to the configured launch prefix for
 * one filesystem policy, in the order the CLI receives it; why each part is
 * there is the comment above.
 */
export function codexExecArguments(policy: CodexSandboxPolicy): readonly string[] {
  return [
    '--ask-for-approval',
    'never',
    'exec',
    '--sandbox',
    policy,
    ...(policy === 'workspace-write' ? WORKSPACE_WRITE_EXCLUSIONS : []),
    '--json',
    '-',
  ];
}

/** The suffix every coding turn of a run uses: the unsandboxed policy. */
export const CODEX_EXEC_ARGUMENTS: readonly string[] = codexExecArguments('danger-full-access');
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
