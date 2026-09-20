/**
 * What every CLI command shares: the exit codes, the two output functions, the
 * host's interrupt signals behind an interface, and the invocation context the
 * command modules are handed.
 *
 * Presentation and process questions only: no command logic, no file reading,
 * and no run.
 */
import type { GitHubDeliveryParts } from '../delivery/github.js';
import type { GitHubCompletionParts } from '../delivery/completion.js';
import type { RunnerDependencies } from '../runs/contracts.js';
import type { SourceRefreshParts } from '../workspace/refresh.js';

/** The run passed, or the CLI printed what it was asked for. */
export const EXIT_OK = 0;
/**
 * The run failed, or the CLI could not get as far as a result: an input file
 * that could not be read or validated, a source or output path preflight
 * refused, or a report that could not be written.
 */
export const EXIT_INPUT_ERROR = 1;
/** The command line itself is wrong: an unknown command or option, a missing value. */
export const EXIT_USAGE = 2;
/**
 * The run was stopped by the user's interrupt. `130` is the conventional shell
 * code for a process ended by `SIGINT`, and the run is finalized — its report
 * written — before the CLI exits with it.
 */
export const EXIT_CANCELLED = 130;
/** Where the CLI writes. Tests pass a recorder instead of the console. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /**
   * The interactive terminal this output goes to, when it is one. Only the real
   * console context installs it: a caller that hands the CLI its own output
   * functions is treated as redirected output, and the CLI then writes ordinary
   * lines only, with no cursor sequences.
   */
  readonly terminal?: CliTerminal;
}

/**
 * An interactive terminal the CLI draws its activity pane on.
 *
 * `write` is the terminal of the CLI's own standard output, cursor sequences and
 * all; `columns` and `rows` are what it reports, and are absent when it does not
 * report a size. Nothing else is needed: the pane is redrawn in place with
 * ordinary cursor moves, and a terminal that reports no size still gets the full
 * pane.
 */
export interface CliTerminal {
  write(text: string): void;
  readonly columns?: number;
  readonly rows?: number;
  /**
   * Whether the pane may color what it draws; absent means it may. A terminal
   * whose host asked for no color reports `false`, and the pane then draws the
   * same lines — timestamps and all — with every color escape sequence left out.
   */
  readonly color?: boolean;
}

/**
 * How a `run` hears that the user wants it stopped, and how it lets go again.
 *
 * It is the host's own interrupt signals behind an interface, so an interrupt
 * can be delivered in a test without a real signal, and so the two things that
 * matter about it are checkable: that a `run` installs a way to be stopped, and
 * that nothing is left installed once it has ended.
 */
export interface InterruptSignals {
  /**
   * Asks to be told when the user interrupts, and returns the function that
   * releases the request again. A caller releases it when the run is over: an
   * invocation installs nothing that outlives it.
   */
  onInterrupt(handler: () => void): () => void;
}

export interface CliContext {
  /** Directory that relative file arguments resolve from. */
  cwd: string;
  io: CliIo;
  /**
   * The host's interrupt signals; the process's own when a caller gives none.
   */
  signals?: InterruptSignals;
  /**
   * The loop's collaborators, when a caller needs to stand in for one. Merged
   * over the real ones, so a partial set keeps every other collaborator real.
   * A test stands in for the coding turn, because it is the only one that talks
   * to a runtime.
   */
  dependencies?: Partial<RunnerDependencies>;
  /**
   * The HTTP boundary a source command asks Jira through. The process's own
   * `fetch` when a caller gives none: nothing in production substitutes it. A
   * test hands a fake so a preview, a finite run, and a watch cycle can be
   * exercised end to end through the CLI without a live Jira site.
   */
  fetch?: typeof fetch;
  /**
   * The delivery step's own outward boundaries, when a caller needs to stand in
   * for one of them: the destination's push URL, or the environment `git` and
   * `gh` are started with. The configured repository's HTTPS URL and the
   * process's own environment when a caller gives none: nothing in production
   * substitutes them.
   */
  deliveryParts?: GitHubDeliveryParts;
  /**
   * The review-to-completion step's own outward boundaries, when a caller needs
   * to stand in for one of them: the GitHub CLI to run, or the environment its
   * commands inherit. `gh` from `PATH` and the process's own environment when a
   * caller gives none: nothing in production substitutes them.
   */
  completionParts?: GitHubCompletionParts;
  /**
   * The source-readiness step's own outward boundary, when a caller needs to
   * stand in for it: the URL the delivery repository is fetched from. The
   * configured repository's HTTPS URL when a caller gives none, so nothing in
   * production substitutes it.
   */
  refreshParts?: SourceRefreshParts;
}
